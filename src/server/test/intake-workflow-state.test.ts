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
  openSelectedAcceptedDestinations,
} from '../intake-workflow-state.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

async function fixture(t: test.TestContext) {
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
            versions: Array.from({ length: 65 }, (_, i) => ({
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
            candidateVersionId: 'v64',
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
