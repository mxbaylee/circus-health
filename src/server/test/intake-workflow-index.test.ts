import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from '../intake-collection-envelope.ts';
import { collectionWorkflowCountReader } from '../intake-workflow-collection-reader.ts';
import {
  workflowIndexContributions,
  workflowUnitIndexContributions,
} from '../intake-workflow-index.ts';
import { workflowCounts } from '../intake-workflow-reader.ts';

/** Semantic fixture only; storage/authentication qualifications use the real envelope adapter. */
function fixture(body: Record<string, unknown>) {
  const objects = new WeakMap<IntakeEnvelopeRecord, Record<string, unknown>>();
  const handles = new WeakMap<object, IntakeEnvelopeRecord>();
  const indexes = new Map<string, IntakeEnvelopeRecord>();
  const recordIds = new WeakMap<IntakeEnvelopeRecord, string>();
  const recordsById = new Map<string, IntakeEnvelopeRecord>();
  const kinds: Record<string, string> = {
    candidates: 'candidate',
    versions: 'version',
    reviewDrafts: 'draft',
    resolutions: 'resolution',
    decisions: 'decision',
    plans: 'plan',
    units: 'unit',
    batches: 'batch',
    coverage: 'coverage',
    identityConfirmations: 'identityReceipt',
    targets: 'target',
    assignmentTargets: 'target',
  };
  let complete = false,
    pages = 0,
    maxPage = 0;
  const record = (kind: string, input: unknown): IntakeEnvelopeRecord => {
    const value =
      input !== null && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : { value: input };
    const retained = handles.get(value);
    if (retained) return retained;
    const handle = { kind } as IntakeEnvelopeRecord;
    objects.set(handle, value);
    handles.set(value, handle);
    const id = String(recordsById.size);
    recordIds.set(handle, id);
    recordsById.set(id, handle);
    return handle;
  };
  const object = (record: IntakeEnvelopeRecord) => {
    const value = objects.get(record);
    if (!value) throw Error('foreign record');
    return value;
  };
  const page = (items: IntakeEnvelopeRecord[], options: { after?: string; items: number }) => {
    pages++;
    const start = Number(options.after || 0),
      result = items.slice(start, start + options.items);
    maxPage = Math.max(maxPage, result.length);
    const end = start + result.length;
    return {
      records: result,
      total: items.length,
      complete: end === items.length,
      after: end === items.length ? null : String(end),
    };
  };
  const reader: IntakeCollectionEnvelopeReader = {
    logical: { root: null, domainVersion: 1 },
    root: () => record('root', body),
    info(record) {
      const value = object(record);
      return {
        shape: Array.isArray(value) ? 'array' : record.kind === 'scalar' ? 'scalar' : 'object',
        count: record.kind === 'scalar' ? 0 : Object.keys(value).length,
      };
    },
    address: (record) => recordIds.get(record)!,
    resolve: (id) => recordsById.get(id)!,
    subtree() {
      throw Error('Count fixture must not change occurrence scope');
    },
    child(parent, field) {
      const value = object(parent)[field];
      return value && typeof value === 'object' ? record(field, value) : undefined;
    },
    childAt(parent, field, ordinal) {
      const value = (object(parent)[field] as unknown[] | undefined)?.[ordinal];
      return value === undefined ? undefined : record(kinds[field] || 'scalar', value);
    },
    has: (parent, field) => Object.hasOwn(object(parent), field),
    field(parent, field) {
      const value = object(parent)[field];
      if (value === undefined) return { kind: 'missing' };
      if (value !== null && typeof value === 'object') return { kind: 'fragmented', bytes: 999999 };
      return { kind: 'value', value };
    },
    fields(parent, options) {
      const entries = Object.entries(object(parent));
      const start = Number(options.after || 0),
        end = Math.min(entries.length, start + options.items);
      return {
        fields: entries.slice(start, end).map(([name, value]) => ({
          name,
          kind:
            value !== null && typeof value === 'object' ? ('record' as const) : ('cell' as const),
        })),
        total: entries.length,
        complete: end === entries.length,
        after: end === entries.length ? null : String(end),
      };
    },
    children(parent, field, options) {
      const value = object(parent)[field] as unknown[] | undefined;
      return page(
        (value || []).map((item) => record(kinds[field] || 'scalar', item)),
        options,
      );
    },
    propertyRecords(parent, options) {
      return page(
        Object.values(object(parent)).map((value) => record('packageFailure', value)),
        options,
      );
    },
    childCount(parent, field) {
      return (object(parent)[field] as unknown[] | undefined)?.length || 0;
    },
    contains(parent, field, value) {
      return ((object(parent)[field] || []) as unknown[]).includes(value);
    },
    find(kind, parent, id) {
      for (const [field, value] of Object.entries(object(parent))) {
        if (kinds[field] !== kind || !Array.isArray(value)) continue;
        const match = value.find((item: Record<string, unknown>) => item.id === id);
        if (match) return record(kind, match);
      }
      return undefined;
    },
    lookup(index, key) {
      if (!complete) throw Error('workflow semantic indexes are incomplete');
      return indexes.get(JSON.stringify([index, key]));
    },
    *fieldChunks() {
      throw Error('Count reader must not materialize opaque fields');
    },
    *recordChunks() {
      throw Error('Count reader must not materialize records');
    },
    fieldFragment() {
      throw Error('Count reader must not read fragments');
    },
  };
  return {
    reader,
    indexes,
    stats: () => ({ pages, maxPage }),
    build() {
      for (const contribution of workflowIndexContributions(reader)) {
        if ('checkpoint' in contribution) continue;
        const key = JSON.stringify([contribution.index, contribution.key]);
        if (contribution.target) indexes.set(key, contribution.target);
        else indexes.delete(key);
      }
      complete = true;
      for (const contribution of workflowUnitIndexContributions(reader, reader.lookup)) {
        if ('checkpoint' in contribution) continue;
        const key = JSON.stringify([contribution.index, contribution.key]);
        if (contribution.target) indexes.set(key, contribution.target);
        else indexes.delete(key);
      }
    },
  };
}

test('manual operation lookup retains the first exact proposal occurrence', () => {
  const selected = fixture({
    intake: {
      version: 1,
      proposals: [
        { id: 'first', manualSourceRecord: { operationId: 'operation-a' } },
        { id: 'unrelated' },
        { id: 'later', manualSourceRecord: { operationId: 'operation-a' } },
        { id: 'other', manualSourceRecord: { operationId: 'operation-b' } },
      ],
      workflow: { candidates: [], plans: [], reviewDrafts: [], decisions: [] },
    },
  });
  const field = selected.reader.field;
  selected.reader.field = (record, name, options) => {
    if (name === 'manualSourceRecord') {
      const receipt = selected.reader.child(record, name);
      if (receipt) {
        const operation = field(receipt, 'operationId', options);
        if (operation.kind === 'value')
          return { kind: 'value', value: { operationId: operation.value } };
      }
    }
    return field(record, name, options);
  };
  selected.build();
  const result = selected.reader.lookup('manual-source-operation-first', ['operation-a']);
  assert.ok(result);
  assert.deepEqual(selected.reader.field(result, 'id'), { kind: 'value', value: 'first' });
  assert.equal(selected.reader.lookup('manual-source-operation-first', ['missing']), undefined);
});

test('schema count reader uses bounded record pages, complete indexes and exact unit receipts', () => {
  const versions = Array.from({ length: 130 }, (_, index) => ({
    id: `v${index}`,
    status: 'pending',
    createdAt: '2026-01-01',
    occurrences: [],
  }));
  const coverage = { unitId: 'unit', kind: 'context', notes: 'Retained exact disposition' };
  const f = fixture({
    intake: {
      workflow: {
        candidates: [
          {
            id: 'candidate',
            envelopeId: 'envelope',
            sourceSystem: null,
            sourceRecordId: null,
            versions,
          },
        ],
        questions: [],
        reviewDrafts: [
          {
            id: 'draft',
            candidateId: 'candidate',
            candidateVersionId: 'v129',
            mapping: {},
            disposition: 'review_later',
            resolutions: [],
          },
        ],
        decisions: [],
        plans: [
          {
            id: 'plan',
            status: 'active',
            units: [{ id: 'unit', attempts: ['batch'], coverage }],
            batches: [{ id: 'batch', coverage: [coverage] }],
          },
        ],
      },
    },
  });
  const reader = collectionWorkflowCountReader(f.reader, { isSourceContextVersion: () => false });
  assert.throws(() => workflowCounts(reader), /indexes are incomplete/);
  f.build();
  assert.deepEqual(workflowCounts(reader), {
    needsReview: true,
    pendingCount: 1,
    unansweredCount: 0,
    pendingWorkCount: 0,
    reviewLaterCount: 1,
  });
  assert.equal(f.stats().maxPage, 64);
});

test('empty assignmentTargets and issueIds override fallback targets when deriving exact identity indexes', () => {
  const target = { candidateId: 'candidate', candidateVersionId: 'version', issueId: 'issue' };
  const receipt = (operationId: string, scope: object) => ({
    operationId,
    outcome: 'this_is_person',
    assignedPerson: { personId: 'fictional-person' },
    scope,
  });
  const f = fixture({
    intake: {
      workflow: {
        candidates: [],
        questions: [],
        plans: [],
        decisions: [],
        identityConfirmations: [
          receipt('empty-targets', { targets: [target], assignmentTargets: [] }),
          receipt('empty-issues', { targets: [{ ...target, issueIds: [] }] }),
          receipt('null-fallback', {
            targets: [{ ...target, issueIds: null }],
            assignmentTargets: null,
          }),
          receipt('exact', { targets: [target] }),
        ],
      },
    },
  });
  f.build();
  const reader = collectionWorkflowCountReader(f.reader, { isSourceContextVersion: () => false });
  assert.equal(reader.hasPersonAssignment('empty-targets', 'candidate', 'version', 'issue'), false);
  assert.equal(reader.hasPersonAssignment('empty-issues', 'candidate', 'version', 'issue'), false);
  assert.equal(reader.hasPersonAssignment('exact', 'candidate', 'version', 'issue'), true);
  assert.equal(reader.hasPersonAssignment('null-fallback', 'candidate', 'version', 'issue'), true);
});

test('coverage without exact attempt receipt stays pending and pending failures remain visible', () => {
  const coverage = { unitId: 'unit', kind: 'context', notes: 'Exact notes' };
  const f = fixture({
    intake: {
      packageFailures: { member: { status: 'pending' } },
      workflow: {
        candidates: [],
        questions: [],
        decisions: [],
        plans: [
          {
            id: 'plan',
            status: 'active',
            units: [{ id: 'unit', attempts: ['different-batch'], coverage }],
            batches: [{ id: 'batch', coverage: [coverage] }],
          },
        ],
      },
    },
  });
  f.build();
  const counts = workflowCounts(
    collectionWorkflowCountReader(f.reader, { isSourceContextVersion: () => false }),
  );
  assert.equal(counts.pendingWorkCount, 1);
  assert.equal(counts.needsReview, true);
});

test('implicit unit providers certify the entire declared scope and cannot report a page as complete', () => {
  const f = fixture({
    intake: {
      workflow: {
        plans: [
          { id: 'plan', status: 'active', format: 'health-intake-package-plan-v2', unitCount: 3 },
        ],
      },
    },
  });
  f.build();
  const reader = (count: number) =>
    collectionWorkflowCountReader(f.reader, {
      isSourceContextVersion: () => false,
      *implicitUnits() {
        for (let i = 0; i < count; i++)
          yield { planId: 'plan', unitId: 'unit-' + i, pending: i !== 0 };
      },
    });
  assert.equal(workflowCounts(reader(3)).pendingWorkCount, 2);
  assert.throws(() => workflowCounts(reader(2)), /Incomplete implicit/);
  assert.throws(() => workflowCounts(reader(4)), /Conflicting implicit/);
});

test('retained duplicate public plan and unit IDs never share another occurrence attempt proof', () => {
  const coverage = { unitId: 'same-unit', kind: 'context', notes: 'Exact retained note' };
  const f = fixture({
    intake: {
      workflow: {
        plans: [
          {
            id: 'same-plan',
            status: 'active',
            units: [
              { id: 'same-unit', coverage, attempts: [] },
              { id: 'same-unit', coverage, attempts: ['batch'] },
            ],
            batches: [{ id: 'batch', coverage: [coverage] }],
          },
          {
            id: 'same-plan',
            status: 'active',
            units: [{ id: 'same-unit', coverage, attempts: ['batch'] }],
            batches: [],
          },
        ],
      },
    },
  });
  f.build();
  assert.equal(
    workflowCounts(collectionWorkflowCountReader(f.reader, { isSourceContextVersion: () => false }))
      .pendingWorkCount,
    2,
  );
});
