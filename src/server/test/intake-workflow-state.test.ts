import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, clinicalReviewRevision } from '../database.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  buildVerifiedWorkflowSummary,
  readVerifiedWorkflowSummary,
  readVerifiedWorkflowReadingFacts,
  openSelectedAcceptedDestinations,
} from '../intake-workflow-state.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { writeIntakeSourcePin } from '../intake-source-pin.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeCollectionProposal } from '../intake-collection-proposals.ts';
import { validateJSONL } from '../intake-format.ts';
import { prepareWorkflowReadingDerived } from '../intake-workflow-reading-derived.ts';

async function fixture(t: test.TestContext, versionCount = 65) {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-workflow-state-'));
  const db = openDatabase(join(directory, 'cache.sqlite'), 'fictional');
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const source = { id: 'fictional-intake', kind: 'intake_original', sha256: 'd'.repeat(64) };
  const accepted = (entityId: string, groupId?: string) => ({
    recordId: 'record',
    entityId,
    ...(groupId === undefined ? {} : { identityAttribution: { groupId } }),
  });
  const body = {
    intake: {
      version: 5,
      originalName: 'fictional.zip',
      acceptedProposalId: 'proposal',
      imported: {
        clinical: {
          records: [
            accepted('current-other', 'other'),
            accepted('current-group', 'group'),
            accepted('current-open'),
          ],
        },
      },
      importHistory: [
        {
          acceptedProposalId: 'proposal',
          clinical: { records: [accepted('old-open'), accepted('old-second')] },
        },
        {
          acceptedProposalId: 'proposal',
          clinical: { records: [accepted('history-match', 'fallback')] },
        },
        {
          acceptedProposalId: 'history-only',
          clinical: { records: [accepted('history-first'), accepted('history-second')] },
        },
      ],
      packageFailures: { failed: { status: 'pending' } },
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: [
          {
            id: 'candidate',
            envelopeId: 'envelope',
            sourceSystem: null,
            sourceRecordId: null,
            versions: Array.from({ length: versionCount }, (_, i) => ({
              id: 'v' + i,
              status: 'pending',
              createdAt: '2026-01-01',
              occurrences: [],
            })),
          },
        ],
        reviewDrafts: [
          {
            id: 'draft',
            candidateId: 'candidate',
            candidateVersionId: 'v' + (versionCount - 1),
            mapping: {},
            disposition: 'review_later',
            resolutions: [],
          },
        ],
        questions: [],
        decisions: [],
        plans: [
          {
            id: 'same-plan',
            status: 'active',
            units: [
              {
                id: 'same-unit',
                attempts: [],
                coverage: { unitId: 'same-unit', kind: 'context', notes: 'Retained evidence' },
              },
              {
                id: 'same-unit',
                attempts: ['batch'],
                coverage: { unitId: 'same-unit', kind: 'context', notes: 'Retained evidence' },
              },
            ],
            batches: [
              {
                id: 'batch',
                coverage: [{ unitId: 'same-unit', kind: 'context', notes: 'Retained evidence' }],
              },
            ],
          },
          {
            id: 'same-plan',
            status: 'active',
            units: [
              {
                id: 'same-unit',
                attempts: ['batch'],
                coverage: { unitId: 'same-unit', kind: 'context', notes: 'Retained evidence' },
              },
            ],
            batches: [],
          },
        ],
      },
    },
  };
  const initial = prepareInitialIntakeEnvelope(body);
  const storage = createIntakeStateStorage(db, {
    profileId: 'fictional',
    intakeId: source.id,
    sourceHash: source.sha256,
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(source.id, 'fictional.zip', source.sha256, 0, source.kind, initial.detailsJson);
    storage.stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(db, source);
  const options = { mappingVersion: 'mapping-v1', isSourceContextVersion: () => false };
  const auxiliary = () => {
    const operationId = randomUUID();
    storage.collections.commitMaintenance(
      storage.collections.prepare(storage.collections.openView(), {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: 5,
        changes: [
          {
            area: 'builds',
            collection: 'fictional.progress',
            op: 'put',
            key: operationId,
            value: 'checkpoint',
          },
        ],
      }),
    );
  };
  return { db, source, options, auxiliary };
}

test('selected summary is exact only after complete bounded maintenance and survives auxiliary churn/cache loss', async (t) => {
  const f = await fixture(t);
  const revision = clinicalReviewRevision(f.db);
  assert.equal(readVerifiedWorkflowSummary(f.db, f.source, f.options).state, 'pending');
  let checkpoints = 0;
  await assert.rejects(
    buildVerifiedWorkflowSummary(f.db, f.source, {
      ...f.options,
      onCheckpoint() {
        if (++checkpoints === 2) throw Error('fictional stop');
      },
    }),
    /fictional stop/,
  );
  clearIntakeStateCache(f.db);
  assert.equal(readVerifiedWorkflowSummary(f.db, f.source, f.options).state, 'pending');
  const built = await buildVerifiedWorkflowSummary(f.db, f.source, f.options);
  assert.deepEqual(built.counts, {
    needsReview: true,
    pendingCount: 1,
    unansweredCount: 0,
    pendingWorkCount: 2,
    reviewLaterCount: 1,
  });
  assert.equal(clinicalReviewRevision(f.db), revision);
  f.auxiliary();
  clearIntakeStateCache(f.db);
  const before = intakeWorkCounters(f.db).warm.materializationReads;
  assert.deepEqual(readVerifiedWorkflowSummary(f.db, f.source, f.options).counts, built.counts);
  assert.equal(intakeWorkCounters(f.db).warm.materializationReads, before);
  assert.equal(
    (
      await buildVerifiedWorkflowSummary(f.db, f.source, {
        ...f.options,
        isSourceContextVersion() {
          throw Error('warm read scanned candidates');
        },
      })
    ).reused,
    true,
  );
  assert.equal(
    readVerifiedWorkflowSummary(f.db, f.source, { mappingVersion: 'mapping-v2' }).state,
    'pending',
  );
});

test('literal reading totals survive source and mapping changes while classified counts require preparation', async (t) => {
  const f = await fixture(t, 3);
  assert.equal(readVerifiedWorkflowReadingFacts(f.db, f.source, f.options).state, 'pending');
  await buildVerifiedWorkflowSummary(f.db, f.source, f.options);
  const exact = readVerifiedWorkflowReadingFacts(f.db, f.source, f.options);
  assert.deepEqual(exact, {
    state: 'exact',
    candidateCount: 1,
    candidateVersionCount: 3,
    substantiveVersions: 3,
    proposalsProduced: 1,
  });
  transaction(f.db, () =>
    writeIntakeSourcePin(f.db, f.source.id, {
      revisionId: 'fictional-new-source-revision',
      dependencyToken: 'fictional-new-dependency',
      requiresInterpretation: true,
      version: 1,
    }),
  );
  const changedMapping = { mappingVersion: 'mapping-v2' };
  assert.equal(readVerifiedWorkflowSummary(f.db, f.source, f.options).state, 'pending');
  assert.equal(readVerifiedWorkflowSummary(f.db, f.source, changedMapping).state, 'pending');
  assert.deepEqual(readVerifiedWorkflowReadingFacts(f.db, f.source, changedMapping), exact);
  clearIntakeStateCache(f.db);
  assert.deepEqual(readVerifiedWorkflowReadingFacts(f.db, f.source, changedMapping), exact);

  const { collections } = selectedEnvelopeStore(f.db, f.source);
  const operationId = randomUUID();
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 5,
      changes: [
        {
          area: 'builds',
          collection: 'workflow.dependencies',
          op: 'put',
          key: 'complete',
          value: 'fictional-stale-logical-binding',
        },
      ],
    }),
  );
  assert.equal(readVerifiedWorkflowReadingFacts(f.db, f.source, changedMapping).state, 'pending');
});

test('native proposal literal totals advance independently of classification and preserve exact retry/cancellation scope', async (t) => {
  const f = await fixture(t, 3);
  await buildVerifiedWorkflowSummary(f.db, f.source, f.options);
  transaction(f.db, () =>
    writeIntakeSourcePin(f.db, f.source.id, {
      revisionId: 'fictional-changed-source',
      dependencyToken: 'fictional-changed-dependency',
      requiresInterpretation: true,
      version: 1,
    }),
  );
  const facts = () =>
    readVerifiedWorkflowReadingFacts(f.db, f.source, { mappingVersion: 'mapping-v2' });
  const initial = facts();
  const entry = (id: string) => ({
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { literal: 'Fictional result 4.6 mg' },
    provenance: {
      capturedVia: 'Fictional fixture',
      sourceSystem: null,
      sourceRecordId: id,
      evidenceClass: 'transcription',
      locator: 'page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'observation',
      subject: 'unknown',
      testLabel: 'Fictional result',
      valueText: '4.6',
      unit: 'mg',
      date: '2026-01-01',
    },
  });
  let discovery = 0;
  const prepare = async (
    suffix: string,
    options: {
      omit?: boolean;
      omitBatch?: boolean;
      tamper?: boolean;
      cancel?: boolean;
      newRecord?: boolean;
      revision?: string;
    } = {},
  ) => {
    const reader = openIntakeCollectionEnvelope(f.db, f.source),
      workflow = reader.child(reader.child(reader.root(), 'intake')!, 'workflow')!,
      plan = reader.childAt(workflow, 'plans', 1)!,
      planAddress = reader.address(plan),
      operationId = randomUUID(),
      batchId = 'fictional-reading-batch-' + suffix,
      proposalId = 'fictional-reading-proposal-' + suffix,
      parsed = validateJSONL(
        Buffer.from(
          JSON.stringify(entry(options.newRecord ? 'fictional-new-record' : 'fictional-record')),
        ),
      );
    assert.ok(parsed.valid && parsed.entries, JSON.stringify(parsed.issues));
    return prepareIntakeCollectionProposal(f.db, f.source, {
      reader,
      file: f.source,
      proposalId,
      proposalHeader: { id: proposalId, fileId: proposalId },
      entries: parsed.entries,
      sourceTextRevisionId: options.revision,
      batchId,
      readingBatch: { planAddress, operationId: batchId },
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: reader.logical.domainVersion + 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      reportEvidence: {
        packageEvidence: false,
        hasMember: () => false,
        contextLookup: { contexts: () => [] },
      },
      nextDiscoveryOrder: () => ++discovery,
      compose: {
        *changes(staged) {
          yield {
            op: 'append',
            record: staged.resolve(planAddress),
            field: 'batches',
            jsonText: JSON.stringify({ id: batchId, coverage: [] }),
          };
        },
        additionalLogicalChanges: [],
      },
      async prepareDerived(derived) {
        if (options.tamper)
          derived.affected.candidateChanges[0]!.candidateVersionId = 'fictional-forged-version';
        const result = await prepareWorkflowReadingDerived(f.db, f.source, {
          ...derived,
          affected: options.omit ? { ...derived.affected, candidateChanges: [] } : derived.affected,
          packageBatch: options.omitBatch ? undefined : { planAddress, operationId: batchId },
          onCheckpoint: options.cancel
            ? () => {
                throw Error('fictional literal cancellation');
              }
            : undefined,
        });
        assert.deepEqual(
          facts(),
          suffix === 'first' ? initial : selectedFacts,
          'preparation must not publish its prospective counters',
        );
        return result;
      },
    });
  };
  let selectedFacts = initial;
  const first = await prepare('first');
  assert.ok(first.prepared);
  transaction(f.db, () => selectedEnvelopeStore(f.db, f.source).collections.stage(first.prepared!));
  selectedFacts = facts();
  assert.deepEqual(selectedFacts, {
    state: 'exact',
    candidateCount: 2,
    candidateVersionCount: 4,
    substantiveVersions: 4,
    proposalsProduced: 2,
  });
  assert.equal(
    readVerifiedWorkflowSummary(f.db, f.source, f.options).state,
    'pending',
    'literal proof must not retag classified workflow facts',
  );
  const second = await prepare('same-content');
  assert.ok(second.prepared);
  transaction(f.db, () =>
    selectedEnvelopeStore(f.db, f.source).collections.stage(second.prepared!),
  );
  selectedFacts = facts();
  assert.deepEqual(selectedFacts, {
    state: 'exact',
    candidateCount: 2,
    candidateVersionCount: 4,
    substantiveVersions: 4,
    proposalsProduced: 3,
  });
  const newRevision = await prepare('new-revision', { revision: 'fictional-new-reading-revision' });
  assert.ok(newRevision.prepared);
  transaction(f.db, () =>
    selectedEnvelopeStore(f.db, f.source).collections.stage(newRevision.prepared!),
  );
  selectedFacts = facts();
  assert.deepEqual(
    selectedFacts,
    {
      state: 'exact',
      candidateCount: 2,
      candidateVersionCount: 5,
      substantiveVersions: 4,
      proposalsProduced: 4,
    },
    'same literal content under a new source revision adds a version without double-counting substantive content',
  );
  await assert.rejects(
    prepare('incomplete', { newRecord: true, omit: true }),
    /immutable native proposal compiler effects/,
  );
  await assert.rejects(
    prepare('missing-existing-version', { revision: 'fictional-omitted-version', omit: true }),
    /immutable native proposal compiler effects/,
  );
  await assert.rejects(
    prepare('missing-batch', { omitBatch: true }),
    /immutable native proposal compiler effects/,
  );
  await assert.rejects(prepare('mutable-descriptor', { tamper: true }), TypeError);
  await assert.rejects(
    prepare('cancelled', { newRecord: true, cancel: true }),
    /fictional literal cancellation/,
  );
  assert.deepEqual(facts(), selectedFacts);
  clearIntakeStateCache(f.db);
  assert.deepEqual(
    facts(),
    selectedFacts,
    'the selected literal proof survives disposable cache loss',
  );
  const { collections } = selectedEnvelopeStore(f.db, f.source),
    operationId = randomUUID();
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: openIntakeCollectionEnvelope(f.db, f.source).logical.domainVersion,
      changes: [
        {
          area: 'builds',
          collection: 'workflow.reading',
          op: 'put',
          key: 'complete',
          value: 'fictional-stale-generation',
        },
      ],
    }),
  );
  assert.equal(facts().state, 'pending', 'a stale literal map never guesses an empty count');
  await buildVerifiedWorkflowSummary(f.db, f.source, f.options);
  assert.deepEqual(
    facts(),
    selectedFacts,
    'explicit cold preparation reconstructs the same literal totals',
  );
});

test('selected accepted destinations retain current/history/record order and exact or unscoped group fallback', async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => openSelectedAcceptedDestinations(f.db, f.source).select('proposal', 'group', 'record'),
    /incomplete|stale/,
  );
  await buildVerifiedWorkflowSummary(f.db, f.source, f.options);
  clearIntakeStateCache(f.db);
  const { view, select } = openSelectedAcceptedDestinations(f.db, f.source);
  const destination = (proposal: string, group: string) => {
    const record = select(proposal, group, 'record');
    return record && view.field(record, 'entityId', { bytes: 4096 });
  };
  assert.deepEqual(destination('proposal', 'group'), { kind: 'value', value: 'current-group' });
  assert.deepEqual(destination('proposal', 'other'), { kind: 'value', value: 'current-other' });
  assert.deepEqual(destination('proposal', 'fallback'), { kind: 'value', value: 'current-open' });
  assert.deepEqual(destination('history-only', 'group'), { kind: 'value', value: 'history-first' });
  assert.equal(select('missing', 'group', 'record'), undefined);
});
