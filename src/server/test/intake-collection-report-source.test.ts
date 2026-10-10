import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  IntakeReportGroup,
  IntakeReportGroupMember,
  IntakeReportSourceConfirmation,
  IntakeWorkflow,
} from '../../shared/intake.ts';
import { canonicalLiteral } from '../intake-format.ts';
import {
  extendIntakeReportSourceConfirmations,
  intakeReportSourceScope,
  intakeReportSourceReference,
  intakeReportSourceForMember,
} from '../intake-report-source.ts';
import {
  reportSourceExtensionEvents,
  type ReportSourceMemberHeader,
  type ReportSourceMemberSnapshot,
  type ReportSourceExtensionInput,
  type ReportSourceExtensionEvent,
} from '../intake-collection-report-source.ts';
const identity = (member: { candidateId: string; candidateVersionId: string }) =>
  canonicalLiteral([member.candidateId, member.candidateVersionId]);
const occurrence = (recordId: string) => ({
  proposalId: 'fictional-proposal',
  recordId,
  batchId: 'fictional-batch',
  locator: 'fictional page 1',
});
const occurrenceKey = (value: IntakeReportGroupMember['occurrences'][number]) =>
  canonicalLiteral([value.proposalId, value.recordId, value.batchId, value.locator]);
function snapshot(
  rows: IntakeReportGroupMember[],
  stats = { canonicalReads: 0, maxPage: 0 },
): ReportSourceMemberSnapshot {
  const header = (member: IntakeReportGroupMember, ordinal: number): ReportSourceMemberHeader => ({
    key: identity(member),
    ordinal,
    candidateId: member.candidateId,
    candidateVersionId: member.candidateVersionId,
    occurrenceCount: member.occurrences.length,
    sectionPresent: !!member.section,
  });
  return {
    member(candidateId, candidateVersionId) {
      const ordinal = rows.findIndex(
        (item) =>
          item.candidateId === candidateId && item.candidateVersionId === candidateVersionId,
      );
      return ordinal < 0 ? undefined : header(rows[ordinal]!, ordinal);
    },
    members({ after, items }) {
      const start = after ? Number(after) : 0,
        selected = rows.slice(start, start + Math.min(2, items));
      stats.maxPage = Math.max(stats.maxPage, selected.length);
      return {
        members: selected.map((row, index) => header(row, start + index)),
        complete: start + selected.length >= rows.length,
        after: start + selected.length >= rows.length ? null : String(start + selected.length),
      };
    },
    occurrences(member, { after, items }) {
      const all = rows[member.ordinal]!.occurrences,
        start = after ? Number(after) : 0,
        selected = all.slice(start, start + Math.min(2, items));
      return {
        occurrences: selected,
        complete: start + selected.length >= all.length,
        after: start + selected.length >= all.length ? null : String(start + selected.length),
      };
    },
    hasOccurrence(member, selected) {
      return rows[member.ordinal]!.occurrences.some(
        (item) => occurrenceKey(item) === occurrenceKey(selected),
      );
    },
    *canonicalMember(member) {
      stats.canonicalReads++;
      const text = canonicalLiteral(rows[member.ordinal]);
      for (let index = 0; index < text.length; index += 17) yield text.slice(index, index + 17);
    },
  };
}
function fixture(basis: IntakeReportSourceConfirmation['basis'] = 'manual_report_label') {
  const member = (id: string, records: string[]): IntakeReportGroupMember => ({
    candidateId: id,
    candidateVersionId: id + '-v1',
    occurrences: records.map(occurrence),
  });
  const prior = [member('old', ['old-authorized']), member('excluded', ['old-excluded'])];
  const current = [
    ...structuredClone(prior),
    member('new', ['new-one', 'new-two']),
    member('accepted', ['accepted-one']),
    member('stale', ['stale-one']),
  ];
  current[1]!.occurrences.push(occurrence('new-excluded'));
  const version = {
    id: 'version-new',
    createdAt: '2026-01-02',
    title: 'Fictional report',
    contributionId: 'new-contribution',
    members: current,
  };
  const group: IntakeReportGroup = {
    id: 'group',
    basis: 'report_anchor',
    sourceFileId: 'fictional-original',
    sourceHash: 'a'.repeat(64),
    sourceSystem: 'fictional-clinic',
    memberId: null,
    report: {
      key: 'fictional-report',
      title: 'Fictional report',
      anchor: { locator: 'report heading', text: 'Fictional report' },
      subject: null,
    },
    versions: [{ ...version, id: 'version-old', members: prior }, version],
  };
  const sourceRef = intakeReportSourceReference(group, group.versions[0]!);
  const confirmation: IntakeReportSourceConfirmation = {
    basis,
    operationId: 'confirmation',
    groupId: group.id,
    groupVersionId: 'version-old',
    contextId: 'version-old',
    source: 'Fictional reviewed source',
    sourceProviderId: 'fictional-provider',
    members: [{ candidateId: 'old', candidateVersionId: 'old-v1' }],
    ...(intakeReportSourceScope(group, group.versions[0]!, basis)
      ? { scope: intakeReportSourceScope(group, group.versions[0]!, basis)! }
      : {}),
    at: '2026-01-01',
    coverageEntries: [
      {
        id: 'authority-a',
        candidateId: 'old',
        candidateVersionId: 'old-v1',
        occurrence: occurrence('old-authorized'),
        sourceRef,
      },
    ],
  };
  const workflow = {
    format: 'health-intake-workflow-v1',
    reportSourceConfirmations: [confirmation],
    candidates: current.map((item) => ({
      id: item.candidateId,
      envelopeId: item.candidateId,
      sourceSystem: null,
      sourceRecordId: null,
      versions: [
        {
          id: item.candidateId === 'stale' ? 'other-version' : item.candidateVersionId,
          status: 'pending',
          createdAt: '2026-01-01',
        },
      ],
    })),
    decisions: [{ action: 'accept', candidateId: 'accepted', candidateVersionId: 'accepted-v1' }],
  } as unknown as IntakeWorkflow;
  const contributed = current.slice(1),
    stats = { canonicalReads: 0, maxPage: 0 };
  const input: ReportSourceExtensionInput = {
    group,
    version,
    current: snapshot(current, stats),
    prior: snapshot(prior),
    confirmation: {
      header: confirmation,
      hasExtension: (id) => !!confirmation.extensions?.some((item) => item.groupVersionId === id),
      hasMember: (member) =>
        confirmation.members.some((item) => identity(item) === identity(member)),
      hasOccurrence: (member, selected) =>
        !!confirmation.coverageEntries?.some(
          (entry) =>
            identity(entry) === identity(member) &&
            occurrenceKey(entry.occurrence) === occurrenceKey(selected),
        ),
      authorityEntry: (scope) =>
        confirmation.coverageEntries
          ?.filter(
            (entry) => canonicalLiteral(entry.sourceRef.extensionScope) === canonicalLiteral(scope),
          )
          .map((entry) => entry.id)
          .sort()[0],
    },
    contributed: (member) => contributed.some((item) => identity(item) === identity(member)),
    pendingUnaccepted: (member) =>
      member.candidateId !== 'accepted' && member.candidateId !== 'stale',
    assertCurrent() {},
  };
  return { input, workflow, group, version, contributed, stats };
}
for (const basis of ['manual_report_label', 'explicit_current_members'] as const)
  test(
    'streamed ' + basis + ' extension preserves exact legacy members, occurrence authority and IDs',
    () => {
      const f = fixture(basis),
        events = [...reportSourceExtensionEvents(f.input)],
        complete = events.find((event) => event.kind === 'complete');
      assert.ok(complete && complete.kind === 'complete');
      const members = events.flatMap((event) =>
        event.kind === 'member'
          ? [
              {
                candidateId: event.member.candidateId,
                candidateVersionId: event.member.candidateVersionId,
              },
            ]
          : [],
      );
      const entries = events.flatMap((event) => (event.kind === 'coverage' ? [event.entry] : []));
      extendIntakeReportSourceConfirmations(f.workflow, f.group, f.version, f.contributed);
      const expected = f.workflow.reportSourceConfirmations![0]!.extensions![0]!;
      assert.deepEqual(
        { ...complete.header, members, ...(entries.length ? { coverageEntries: entries } : {}) },
        expected,
      );
      assert.equal(complete.memberCount, members.length);
      assert.equal(complete.coverageEntryCount, entries.length);
      assert.ok(f.stats.maxPage <= 2);
      if (basis === 'explicit_current_members') {
        assert.ok(entries.some((entry) => entry.occurrence.recordId === 'new-excluded'));
        assert.ok(!entries.some((entry) => entry.occurrence.recordId === 'old-excluded'));
        assert.equal(f.stats.canonicalReads, 4); // each contributed member hashed once even with several occurrences
      }
    },
  );
test('changed scope, replay and missing explicit authority never add coverage', () => {
  for (const kind of ['changed', 'replayed', 'missing'] as const) {
    const f = fixture('explicit_current_members');
    if (kind === 'changed') f.input.group = { ...f.group, sourceHash: 'b'.repeat(64) };
    if (kind === 'replayed') f.input.confirmation.hasExtension = () => true;
    if (kind === 'missing') f.input.confirmation.authorityEntry = () => undefined;
    assert.deepEqual([...reportSourceExtensionEvents(f.input)], []);
  }
});
test('cancellation interrupts selected traversal before a completion descriptor exists', () => {
  const f = fixture();
  let reads = 0;
  f.input.assertCurrent = () => {
    if (++reads === 5) throw Error('cancelled');
  };
  const events: ReportSourceExtensionEvent[] = [];
  assert.throws(() => {
    for (const event of reportSourceExtensionEvents(f.input)) events.push(event);
  }, /cancelled/);
  assert.ok(!events.some((event) => event.kind === 'complete'));
});

test('ten thousand retained members stream through one page without reading occurrence payloads', () => {
  const f = fixture(),
    total = 10001;
  let pages = 0,
    peak = 0,
    seen = 0,
    completion = 0;
  f.input.confirmation.hasMember = () => true;
  f.input.current = {
    member() {
      throw Error('unexpected point lookup');
    },
    members({ after, items }) {
      pages++;
      const start = after ? Number(after) : 0,
        count = Math.min(items, total - start);
      peak = Math.max(peak, count);
      return {
        members: Array.from({ length: count }, (_, offset) => ({
          key: String(start + offset),
          ordinal: start + offset,
          candidateId: 'candidate' + (start + offset),
          candidateVersionId: 'version' + (start + offset),
          occurrenceCount: 50000,
          sectionPresent: true,
        })),
        complete: start + count === total,
        after: start + count === total ? null : String(start + count),
      };
    },
    occurrences() {
      throw Error('manual confirmation must not hydrate occurrences');
    },
    hasOccurrence() {
      throw Error('manual confirmation must not hydrate occurrences');
    },
    *canonicalMember() {
      throw Error('manual confirmation must not hydrate members');
    },
  };
  for (const event of reportSourceExtensionEvents(f.input)) {
    if (event.kind === 'member') seen++;
    if (event.kind === 'complete') {
      completion++;
      assert.equal(event.memberCount, total);
      assert.equal(event.coverageEntryCount, 0);
    }
  }
  assert.equal(seen, total);
  assert.equal(completion, 1);
  assert.equal(pages, Math.ceil(total / 64));
  assert.equal(peak, 64);
});

test('nonmatching source members yield a work checkpoint before draining the collection', () => {
  const f = fixture();
  f.input.current = snapshot(
    Array.from({ length: 65 }, (_, index) => ({
      candidateId: 'fictional-unmatched-' + index,
      candidateVersionId: 'fictional-version-' + index,
      occurrences: [],
    })),
  );
  let inspected = 0,
    cancelled = false;
  f.input.confirmation.hasMember = () => {
    inspected++;
    return false;
  };
  f.input.contributed = () => false;
  f.input.assertCurrent = () => {
    if (cancelled) throw Error('fictional cancellation');
  };
  const events = reportSourceExtensionEvents(f.input);
  assert.deepEqual(events.next(), { value: { kind: 'checkpoint' }, done: false });
  assert.ok(inspected > 0 && inspected <= 64);
  cancelled = true;
  assert.throws(() => events.next(), /fictional cancellation/);
  assert.ok(inspected < 65);
});

test('already covered source occurrences yield without emitting duplicate coverage', () => {
  const f = fixture('explicit_current_members');
  f.input.current = snapshot([
    {
      candidateId: 'fictional-covered',
      candidateVersionId: 'fictional-covered-version',
      occurrences: Array.from({ length: 65 }, (_, index) => occurrence('fictional-' + index)),
    },
  ]);
  f.input.confirmation.hasMember = () => true;
  f.input.contributed = () => true;
  let inspected = 0;
  f.input.confirmation.hasOccurrence = () => {
    inspected++;
    return true;
  };
  const events = reportSourceExtensionEvents(f.input);
  assert.equal(events.next().value!.kind, 'member');
  assert.deepEqual(events.next(), { value: { kind: 'checkpoint' }, done: false });
  assert.ok(inspected > 0 && inspected <= 64);
  const remaining = [...events];
  assert.equal(inspected, 65);
  assert.ok(
    !remaining.some((event) => event.kind === 'coverage' || event.kind === 'coverage-reference'),
  );
  const complete = remaining.at(-1)!;
  assert.equal(complete.kind, 'complete');
  if (complete.kind === 'complete') assert.equal(complete.coverageEntryCount, 0);
});

test('unknown occurrence fields stay in exact hashes but do not enlarge the authorized occurrence identity', () => {
  const f = fixture('explicit_current_members');
  Object.assign(f.version.members[1]!.occurrences[0]!, {
    retainedUnknown: 'fictional extra evidence',
  });
  const entries = [...reportSourceExtensionEvents(f.input)].flatMap((event) =>
    event.kind === 'coverage' ? [event.entry] : [],
  );
  extendIntakeReportSourceConfirmations(f.workflow, f.group, f.version, f.contributed);
  assert.deepEqual(
    entries,
    f.workflow.reportSourceConfirmations![0]!.extensions![0]!.coverageEntries,
  );
  assert.ok(!entries.some((entry) => entry.occurrence.recordId === 'old-excluded'));
});

// Actual owned-tree integration: this fixture materializes only its small oracle.
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  iterateIntakeEnvelopeText,
} from '../intake-collection-envelope.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import {
  createReportMemberSnapshot,
  openReportMemberSnapshot,
} from '../intake-report-member-state.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { prepareNativeReportSourceExtensions } from '../intake-report-source-state.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { schemaKey } from '../intake-envelope-schema.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  resolveNativeReportSource,
  resolveNativeReportSourceWork,
  selectNativeReportSourceLocator,
} from '../intake-report-source-resolution.ts';
import type { IntakeReportGroupVersionV2 } from '../../shared/intake-report-version.ts';

for (const basis of ['manual_report_label', 'explicit_current_members'] as const)
  test(
    'owned native ' +
      basis +
      ' extension selects atomic catalog and preserves legacy receipt grammar',
    // Cold codec/index publication, three receipt scopes, giant canonical evidence and warm replay share this fixture.
    // Manual source coverage adds 96 retained extensions, complete legacy/native parity and replay; its larger guard covers that complete fixture work.
    { timeout: basis === 'manual_report_label' ? 180_000 : 60_000 },
    async (t) => {
      const f = fixture(basis);
      if (basis === 'explicit_current_members') {
        f.group.versions[0]!.members[0]!.occurrences[0]!.locator = '🌿'.repeat(40000);
        f.workflow.reportSourceConfirmations![0]!.coverageEntries![0]!.occurrence.locator =
          '🌿'.repeat(40000);
        f.version.members[0]!.occurrences[0]!.locator = '🌿'.repeat(40000);
        f.version.members[2]!.occurrences[0]!.locator = '🌼'.repeat(45000);
        const secondOld = {
          ...f.group.versions[0]!.members[0]!.occurrences[0]!,
          locator: 'a second fictional spot',
          batchId: 'second-fictional-batch',
        };
        f.group.versions[0]!.members[0]!.occurrences.push(secondOld);
        f.version.members[0]!.occurrences.push(secondOld);
        f.workflow.reportSourceConfirmations![0]!.coverageEntries!.push({
          ...f.workflow.reportSourceConfirmations![0]!.coverageEntries![0]!,
          id: 'authority-z',
          occurrence: secondOld,
        });
      }
      if (basis === 'explicit_current_members') {
        f.group.report!.anchor!.text = '🌺'.repeat(40000);
        Object.assign(f.group.report!.anchor!, { unknown: { retained: '🌿'.repeat(20000) } });
        Object.assign(f.group.report!, { subject: { unknown: '🌼'.repeat(40000) } });
        for (const entry of f.workflow.reportSourceConfirmations![0]!.coverageEntries!)
          entry.sourceRef = intakeReportSourceReference(f.group, f.group.versions[0]!);
      } else Object.assign(f.group.report!, { irrelevantUnknown: '🌿'.repeat(40000) });
      if (basis === 'manual_report_label')
        f.workflow.reportSourceConfirmations![0]!.extensions = [
          Object.assign(
            {
              id: 'legacy-extension',
              groupVersionId: 'version-old',
              contextId: 'legacy-context',
              members: [
                {
                  candidateId: f.version.members[2]!.candidateId,
                  candidateVersionId: f.version.members[2]!.candidateVersionId,
                },
              ],
              at: '2025-01-01',
            },
            { format: 'unrecognized-evidence-format:' + 'x'.repeat(70000) },
          ),
          {
            id: 'legacy-empty-latest',
            groupVersionId: 'version-old',
            contextId: 'ignored-latest',
            members: [],
            at: '2025-01-02',
          },
        ];
      if (basis === 'manual_report_label')
        f.workflow.reportSourceConfirmations![0]!.extensions!.push(
          ...Array.from({ length: 96 }, (_, index) => ({
            id: 'retained-nonmatching-' + index,
            groupVersionId: 'version-old',
            contextId: 'unmatched-' + index,
            members: [],
            at: '2025-01-03',
          })),
        );
      const root = mkdtempSync(join(tmpdir(), 'fictional-source-extensions-')),
        identity = {
          profileId: 'fictional',
          intakeId: 'fictional-source',
          sourceHash: 'c'.repeat(64),
        },
        db = openDatabase(join(root, 'cache.sqlite'), identity.profileId);
      memoryRecordAuthority(db);
      t.after(() => {
        clearIntakeStateCache(db);
        db.close();
        rmSync(root, { recursive: true, force: true });
      });
      const incompatible = structuredClone(
        f.workflow.reportSourceConfirmations![0]!,
      ) as IntakeReportSourceConfirmation & { scope?: Record<string, unknown> };
      incompatible.operationId = 'incompatible-scope';
      if (basis === 'manual_report_label')
        incompatible.scope = {
          ...incompatible.scope,
          unknown: 'retained scope field',
        } as typeof incompatible.scope;
      else
        for (const entry of incompatible.coverageEntries!)
          Object.assign(entry.sourceRef.extensionScope!, { unknown: 'retained scope field' });
      const unrelated = {
        ...structuredClone(f.workflow.reportSourceConfirmations![0]!),
        operationId: 'other-group',
        groupId: 'other-group',
      };
      const initial = prepareInitialIntakeEnvelope({
        intake: {
          version: 1,
          originalName: 'fictional.pdf',
          workflow: {
            ...f.workflow,
            reportSourceConfirmations: [
              f.workflow.reportSourceConfirmations![0],
              incompatible,
              unrelated,
            ],
            questions: [],
            plans: [],
            reportGroups: [{ ...f.group, versions: [f.group.versions[0]] }],
          },
        },
      });
      transaction(db, () => {
        db.prepare(
          'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
        ).run(
          identity.intakeId,
          'fictional.pdf',
          identity.sourceHash,
          0,
          'intake_original',
          initial.detailsJson,
        );
        createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
      });
      const source = { id: identity.intakeId, sha256: identity.sourceHash };
      await buildIntakeCollectionEnvelope(db, source);
      await buildVerifiedWorkflowSummary(db, source, {
        mappingVersion: 'fictional',
        isSourceContextVersion: () => false,
      });
      assert.throws(
        () =>
          resolveNativeReportSource(db, source, {
            candidateId: 'old',
            candidateVersionId: 'old-v1',
            references: () => [{ groupId: f.group.id, groupVersionId: 'version-old' }],
          }),
        /pending/,
      );
      const catalog = createReportSnapshotCatalog(db, source);
      const make = async (name: string, rows: IntakeReportGroupMember[]) => {
        const writer = await createReportMemberSnapshot(catalog, name);
        for (const row of rows) {
          let member = await writer.include(row);
          for (const occurrence of row.occurrences)
            member = await writer.occurrence(member, occurrence);
        }
        return writer.finish();
      };
      const prior = await make('prior', f.group.versions[0]!.members),
        current = await make('current', f.version.members),
        version: IntakeReportGroupVersionV2 = {
          ...f.version,
          format: 'health-intake-report-group-version-v2',
          members: current,
        };
      const reader = openIntakeCollectionEnvelope(db, source),
        operationId = randomUUID(),
        beforeHash = intakeWorkCounters(db).warm.hashedBytes;
      const prepared = await prepareIntakeEnvelopeMutation(db, source, {
        reader,
        operationId,
        requestDigest: schemaKey(operationId),
        domainVersion: 2,
        additionalLogicalChanges: () => catalog.finalChanges(),
        changes: async function* (view) {
          const intake = view.child(view.root(), 'intake')!,
            workflow = view.child(intake, 'workflow')!,
            group = view.find('reportGroup', workflow, f.group.id)!;
          yield {
            op: 'append',
            record: group,
            field: 'versions',
            jsonText: JSON.stringify(version),
          };
          yield* prepareNativeReportSourceExtensions({
            db,
            source,
            view,
            workflow,
            group,
            version,
            current: openReportMemberSnapshot(catalog, current),
            prior: openReportMemberSnapshot(catalog, prior),
            contributed: new Set(
              f.contributed.map((m) => schemaKey(m.candidateId, m.candidateVersionId)),
            ),
            catalog,
            assertCurrent: catalog.assertCurrent,
          });
        },
      });
      assert.ok(prepared.prepared);
      assert.ok(
        intakeWorkCounters(db).warm.hashedBytes - beforeHash >
          (basis === 'explicit_current_members' ? 180000 : 100),
      );
      assert.equal(createReportSnapshotCatalog(db, source).open('current'), undefined);
      transaction(db, () =>
        createIntakeStateStorage(db, identity).collections.stage(prepared.prepared!),
      );
      const retained = JSON.parse([...iterateIntakeEnvelopeText(db, source)].join('')),
        extension = retained.intake.workflow.reportSourceConfirmations[0].extensions.at(-1),
        selected = createReportSnapshotCatalog(db, source),
        scope = selected.open(extension.members.snapshotId)!;
      assert.deepEqual(
        retained.intake.workflow.reportSourceConfirmations[1].extensions,
        incompatible.extensions,
      );
      assert.deepEqual(
        retained.intake.workflow.reportSourceConfirmations[2].extensions,
        unrelated.extensions,
      );
      const members = scope
        .reference('members')!
        .range({ items: 64, bytes: 128 * 1024 })
        .items.filter((item) => item.key.startsWith('m:'))
        .map((item) => JSON.parse(item.value as string));
      const entries = scope
        .reference('coverage')!
        .range({ items: 64, bytes: 128 * 1024 })
        .items.filter((item) => item.key.startsWith('e:'))
        .map((item) => JSON.parse([...scope.reference('coverage')!.chunks(item.key)].join('')));
      extendIntakeReportSourceConfirmations(f.workflow, f.group, f.version, f.contributed);
      const { format: _, ...header } = extension;
      delete header.members;
      delete header.coverageEntries;
      assert.deepEqual(
        { ...header, members, ...(entries.length ? { coverageEntries: entries } : {}) },
        f.workflow.reportSourceConfirmations![0]!.extensions!.at(-1)!,
      );
      const resolverCanonicalWork = intakeWorkCounters(db).warm.jsonCanonicalInputCodeUnits;
      const confirmations = [f.workflow.reportSourceConfirmations![0]!, incompatible, unrelated];
      const references = [
        { groupId: f.group.id, groupVersionId: 'version-old' },
        { groupId: f.group.id, groupVersionId: f.version.id },
      ];
      for (const member of f.version.members)
        for (const qualifier of [
          undefined,
          ...member.occurrences,
          ...member.occurrences.map(({ proposalId, recordId, batchId }) => ({
            proposalId,
            recordId,
            batchId,
          })),
          ...member.occurrences.map(({ proposalId, recordId, locator }) => ({
            proposalId,
            recordId,
            locator,
          })),
          {
            proposalId: member.occurrences[0]!.proposalId,
            recordId: member.occurrences[0]!.recordId,
          },
        ]) {
          const expected = intakeReportSourceForMember(
            confirmations,
            references,
            member,
            qualifier,
          );
          const actual = resolveNativeReportSource(db, source, {
            candidateId: member.candidateId,
            candidateVersionId: member.candidateVersionId,
            references: () => references,
            occurrence: qualifier,
          });
          if (!expected) {
            assert.equal(actual, null);
            continue;
          }
          assert.ok(actual);
          assert.equal(actual.confirmation.operationId, expected.confirmation.operationId);
          assert.equal(actual.confirmation.source, expected.confirmation.source);
          assert.deepEqual(actual.coverage, {
            groupVersionId: expected.coverage.groupVersionId,
            contextId: expected.coverage.contextId,
            ...(expected.coverage.extensionId
              ? { extensionId: expected.coverage.extensionId }
              : {}),
            ...(expected.coverage.coverageEntryId
              ? { coverageEntryId: expected.coverage.coverageEntryId }
              : {}),
          });
          assert.equal(
            actual.confirmationHash,
            createHash('sha256').update(canonicalLiteral(expected.confirmation)).digest('hex'),
          );
        }
      if (basis === 'manual_report_label') {
        const member = f.version.members[2]!,
          refs = [{ groupId: f.group.id, groupVersionId: 'version-old' }];
        const expected = intakeReportSourceForMember(confirmations, refs, member)!;
        const actual = resolveNativeReportSource(db, source, {
          candidateId: member.candidateId,
          candidateVersionId: member.candidateVersionId,
          references: () => refs,
        })!;
        assert.equal(expected.coverage.contextId, 'legacy-context');
        assert.equal(actual.coverage.contextId, expected.coverage.contextId);
        assert.equal(actual.confirmation.operationId, expected.confirmation.operationId);
        const { runClinicalReviewWork } = await import('../clinical-review-work.ts');
        const { reviewReadStamp } = await import('../intake-clinical-review-read-cache.ts');
        const { readdirSync } = await import('node:fs');
        const scratch = () =>
          readdirSync(tmpdir())
            .filter((name) => name.startsWith('circus-source-scope-'))
            .sort();
        const initialScratch = scratch();
        const work = () =>
          resolveNativeReportSourceWork(db, source, {
            candidateId: member.candidateId,
            candidateVersionId: member.candidateVersionId,
            references: function* () {
              for (let index = 0; index < 96; index++)
                yield { groupId: 'unrelated-' + index, groupVersionId: 'unrelated' };
              yield* refs;
            },
          });
        const capture = () => {
          const stamp = reviewReadStamp(db);
          return () => assert.equal(reviewReadStamp(db), stamp, 'exact resolver SQL proof');
        };
        let turns = 0,
          done = false;
        const pulse = () => {
          if (!done) {
            turns++;
            setImmediate(pulse);
          }
        };
        setImmediate(pulse);
        try {
          assert.deepEqual(await runClinicalReviewWork(work(), { capture }), actual);
        } finally {
          done = true;
        }
        assert.ok(
          turns > 6,
          'reference and nonmatching extension history expose real cooperative turns',
        );
        assert.deepEqual(scratch(), initialScratch);
        const controller = new AbortController();
        setImmediate(() => controller.abort());
        await assert.rejects(
          runClinicalReviewWork(work(), { capture, signal: controller.signal }),
          { name: 'AbortError' },
        );
        assert.deepEqual(
          scratch(),
          initialScratch,
          'cancelled resolver closes its reference spool',
        );
        setImmediate(() => {
          db.exec('BEGIN');
          db.prepare("UPDATE app_meta SET value=value WHERE key='owner_profile_id'").run();
          db.exec('ROLLBACK');
        });
        await assert.rejects(
          runClinicalReviewWork(work(), { capture }),
          /exact resolver SQL proof/,
        );
        assert.deepEqual(scratch(), initialScratch, 'refused resolver closes its reference spool');
        t.diagnostic(
          JSON.stringify({
            explicitReferenceCount: 97,
            nonmatchingExtensions: 97,
            cooperativeTurns: turns,
          }),
        );
      }
      assert.equal(
        resolveNativeReportSource(db, source, {
          candidateId: 'absent',
          candidateVersionId: 'absent',
          references: () => references,
        }),
        null,
      );
      assert.ok(intakeWorkCounters(db).warm.jsonCanonicalScratchReadBytes > 0);
      assert.equal(intakeWorkCounters(db).warm.jsonCanonicalInputCodeUnits, resolverCanonicalWork);
      const selectedView = openIntakeCollectionEnvelope(db, source),
        selectedWorkflow = selectedView.child(
          selectedView.child(selectedView.root(), 'intake')!,
          'workflow',
        )!,
        selectedGroup = selectedView.find('reportGroup', selectedWorkflow, f.group.id)!,
        selectedVersion = selectedView.childAt(selectedGroup, 'versions', 0)!,
        selectedMember = selectedView.childAt(selectedVersion, 'members', 0)!,
        selectedOccurrence = selectedView.childAt(selectedMember, 'occurrences', 0)!;
      const locator = selectNativeReportSourceLocator(
          db,
          source,
          selectedView.address(selectedOccurrence),
        ),
        firstMember = f.group.versions[0]!.members[0]!,
        request = {
          candidateId: firstMember.candidateId,
          candidateVersionId: firstMember.candidateVersionId,
          references: () => references,
          occurrence: { ...firstMember.occurrences[0]!, locator },
        };
      assert.deepEqual(
        resolveNativeReportSource(db, source, request),
        resolveNativeReportSource(db, source, {
          ...request,
          occurrence: firstMember.occurrences[0],
        }),
      );
      assert.throws(
        () =>
          resolveNativeReportSource(db, source, {
            ...request,
            occurrence: { ...request.occurrence, locator: { ...locator } },
          }),
        /stale|foreign/,
      );

      // A repeat selects the same state without rescanning original confirmations or duplicating extensions.
      const repeatCatalog = createReportSnapshotCatalog(db, source),
        again = randomUUID();
      const repeat = await prepareIntakeEnvelopeMutation(db, source, {
        reader: openIntakeCollectionEnvelope(db, source),
        operationId: again,
        requestDigest: schemaKey(again),
        domainVersion: 3,
        additionalLogicalChanges: () => repeatCatalog.finalChanges(),
        changes: async function* (view) {
          const workflow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
            group = view.find('reportGroup', workflow, f.group.id)!;
          yield* prepareNativeReportSourceExtensions({
            db,
            source,
            view,
            workflow,
            group,
            version,
            current: openReportMemberSnapshot(repeatCatalog, current),
            prior: openReportMemberSnapshot(repeatCatalog, prior),
            contributed: new Set(),
            catalog: repeatCatalog,
            assertCurrent: repeatCatalog.assertCurrent,
          });
        },
      });
      transaction(db, () =>
        createIntakeStateStorage(db, identity).collections.stage(repeat.prepared!),
      );
      const after = JSON.parse([...iterateIntakeEnvelopeText(db, source)].join(''));
      assert.equal(
        after.intake.workflow.reportSourceConfirmations[0].extensions.length,
        f.workflow.reportSourceConfirmations![0]!.extensions!.length,
      );
      assert.throws(() => resolveNativeReportSource(db, source, request), /stale|foreign/);
    },
  );

test('prior occurrence authority includes every retained duplicate member', () => {
  const f = fixture('explicit_current_members'),
    hidden = occurrence('older-in-second-duplicate');
  f.group.versions[0]!.members.push({
    candidateId: 'excluded',
    candidateVersionId: 'excluded-v1',
    occurrences: [hidden],
  });
  f.version.members[1]!.occurrences.push(hidden);
  const events = [...reportSourceExtensionEvents(f.input)],
    entries = events.flatMap((event) => (event.kind === 'coverage' ? [event.entry] : []));
  extendIntakeReportSourceConfirmations(f.workflow, f.group, f.version, f.contributed);
  assert.deepEqual(
    entries,
    f.workflow.reportSourceConfirmations![0]!.extensions![0]!.coverageEntries,
  );
  assert.ok(!entries.some((entry) => entry.occurrence.recordId === hidden.recordId));
});
