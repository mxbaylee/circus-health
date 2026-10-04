import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  collectionIntakeSummary,
  collectionIntakePackageFailures,
  collectionIntakeUnitDetail,
  collectionIntakeAcceptedDestinations,
  collectionIntakeFilenameFragment,
} from '../intake-summary.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { isRetainOnlyIntake } from '../../shared/intake-source-policy.ts';
import { intakeFilenameDisplay } from '../../shared/intake-summary.ts';
function fixture(t: test.TestContext, input: Record<string, unknown> | string) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-envelope-schema-')),
    identity = {
      profileId: 'fictional-schema',
      intakeId: 'fictional-intake',
      sourceHash: 'c'.repeat(64),
    },
    db = openDatabase(join(root, 'cache.sqlite'), identity.profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const initial = prepareInitialIntakeEnvelope(input);
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      'fictional.zip',
      identity.sourceHash,
      0,
      'intake_original',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  return {
    db,
    identity,
    source: { id: identity.intakeId, kind: 'intake_original', sha256: identity.sourceHash },
  };
}

const durability = { pending: false, mutationRevision: 0, persistedRevision: 0, error: null };

test('giant original names keep bounded summaries, exact pinned fragments and checked suffix eligibility', async (t) => {
  const data = input(0);
  const filename = 'fictional-' + '🌿"\\'.repeat(10000) + '.mp3';
  data.intake.originalName = filename;
  const { db, source } = fixture(t, data);
  await buildIntakeCollectionEnvelope(db, source);
  const before = intakeWorkCounters(db);
  const summary = collectionIntakeSummary(db, source, { durability });
  assert.equal(summary.filename, undefined);
  assert.equal(summary.filenameTruncated, true);
  assert.ok(summary.filenameReference);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 20000);
  assert.ok(intakeFilenameDisplay(summary).endsWith('(shortened)'));
  assert.equal(isRetainOnlyIntake(summary), true);
  const pieces: string[] = [];
  let cursor: string | undefined;
  do {
    const page = collectionIntakeFilenameFragment(db, source, {
      reference: summary.filenameReference!,
      cursor,
      limit: 32768,
    });
    assert.equal(page.encoding, 'json-string');
    assert.ok(Buffer.byteLength(page.text) <= 32768);
    pieces.push(page.text);
    cursor = page.nextCursor ?? undefined;
    if (page.complete) assert.equal(cursor, undefined);
  } while (cursor);
  assert.equal(JSON.parse(pieces.join('')), filename);
  assert.throws(
    () =>
      collectionIntakeFilenameFragment(db, source, {
        reference: { ...summary.filenameReference!, scalarHash: '0'.repeat(64) },
      }),
    { code: 'INTAKE_FILENAME_CHANGED' },
  );
  assert.throws(
    () =>
      collectionIntakeFilenameFragment(db, source, {
        reference: {
          ...summary.filenameReference!,
          pins: { ...summary.pins, version: summary.version + 1 },
        },
      }),
    { code: 'INTAKE_FILENAME_CHANGED' },
  );
  const after = intakeWorkCounters(db);
  assert.equal(after.warm.materializationReads - before.warm.materializationReads, 0);
  assert.equal(after.warm.envelopeHydrations - before.warm.envelopeHydrations, 0);
});
function input(count = 51) {
  return {
    intake: {
      version: 3,
      originalName: 'fictional.zip',
      createdAt: '2026-01-02T00:00:00Z',
      state: 'ready',
      metadata: {
        source: 'Fictional Clinic',
        careArea: null,
        documentType: null,
        topics: ['Fictional'],
      },
      proposals: [],
      importHistory: [],
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: Array.from({ length: count }, (_, i) => ({
          id: 'candidate' + i,
          versions: [],
        })),
        questions: [],
        plans: [],
        reportGroups: [],
      },
      packageFailures: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          'failure' + i,
          {
            sourceFileId: 'fictional-intake',
            sourceHash: 'c'.repeat(64),
            operationKey: 'operation' + i,
            originalFilename: 'fictional.zip',
            contentUrl: '/api/sources/fictional-intake/content',
            reasonCode: 'fictional',
            detail: 'Could not inspect fictional member ' + i,
            status: 'pending',
            scope: 'incomplete',
            retryAction: 'read_member',
            memberId: 'member' + i,
          },
        ]),
      ),
    },
  };
}
test('native intake summary exposes exact collection counts and pending review without fabricated workflow arrays', async (t) => {
  const { db, source } = fixture(t, input());
  await buildIntakeCollectionEnvelope(db, source);
  const before = intakeWorkCounters(db).warm.materializationReads;
  const result = collectionIntakeSummary(db, source, { durability });
  assert.equal(result.format, 'health-intake-summary-v2');
  assert.deepEqual(result.review, { state: 'pending', counts: null });
  assert.deepEqual(result.activePlan, { state: 'exact', plan: null });
  assert.equal(result.collections.candidates.total, 51);
  assert.equal(result.collections.packageFailures.total, 51);
  assert.equal(result.provider, 'Fictional Clinic');
  assert.equal(result.metadataState, 'complete');
  for (const field of [
    'workflow',
    'proposals',
    'importHistory',
    'imported',
    'validation',
    'pendingCount',
    'needsReview',
  ])
    assert.equal(Object.hasOwn(result, field), false, field);
  assert.equal(intakeWorkCounters(db).warm.materializationReads, before);
});
test('processing issue pages retain exact targets and refuse foreign or changed source cursors', async (t) => {
  const { db, source } = fixture(t, input());
  await buildIntakeCollectionEnvelope(db, source);
  let cursor;
  const keys = [];
  do {
    const page = collectionIntakePackageFailures(db, source, { cursor, limit: 7 });
    assert.equal(page.total, 51);
    assert.ok(page.entries.length <= 7);
    for (const item of page.entries) {
      keys.push(item.key);
      assert.equal(item.failure.memberId, 'member' + item.key.slice(7));
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(keys.length, 51);
  assert.equal(new Set(keys).size, 51);
  const page = collectionIntakePackageFailures(db, source, { limit: 1 });
  const changed = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString());
  changed.pins.version++;
  assert.throws(
    () =>
      collectionIntakePackageFailures(db, source, {
        cursor: Buffer.from(JSON.stringify(changed)).toString('base64url'),
      }),
    /changed/,
  );
  changed.intakeId = 'foreign';
  assert.throws(
    () =>
      collectionIntakePackageFailures(db, source, {
        cursor: Buffer.from(JSON.stringify(changed)).toString('base64url'),
      }),
    /invalid/,
  );
  assert.throws(() => collectionIntakePackageFailures(db, source, { limit: 101 }), /between/);
});
test('large labels remain explicitly unloaded rather than represented as absent', async (t) => {
  const data = input(0);
  data.intake.metadata.topics = ['fictional'.repeat(3000)];
  const { db, source } = fixture(t, data);
  await buildIntakeCollectionEnvelope(db, source);
  const result = collectionIntakeSummary(db, source, { durability });
  assert.equal(result.metadataState, 'unloaded');
  assert.equal(result.metadata, undefined);
  assert.equal(result.provider, 'Fictional Clinic');
});

test('raw duplicate processing issue keys count and page only the selected last value', async (t) => {
  const data = input(1),
    original = JSON.stringify(data),
    failure = data.intake.packageFailures.failure0!;
  const raw = original.replace(
    '"packageFailures":{',
    '"packageFailures":{"failure0":' +
      JSON.stringify({ ...failure, detail: 'superseded duplicate' }) +
      ',',
  );
  const { db, source } = fixture(t, raw);
  await buildIntakeCollectionEnvelope(db, source);
  const summary = collectionIntakeSummary(db, source, { durability });
  const page = collectionIntakePackageFailures(db, source);
  assert.equal(summary.collections.packageFailures.total, 1);
  assert.equal(page.total, 1);
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0]!.failure.detail, failure.detail);
});

test('retained unit notes read the exact selected plan and reject stale source versions', async (t) => {
  const data: Record<string, unknown> = {
    ...input(0),
    intake: {
      ...input(0).intake,
      workflow: {
        plans: [
          {
            id: 'retained-plan',
            units: [
              {
                id: 'selected-unit',
                pages: [2],
                attempts: Array.from({ length: 50 }, (_, i) => 'attempt' + i),
                coverage: {
                  unitId: 'selected-unit',
                  kind: 'context',
                  notes: 'Fictional complete retained note',
                },
              },
            ],
          },
        ],
      },
    },
  };
  const { db, source } = fixture(t, data);
  await buildIntakeCollectionEnvelope(db, source);
  const result = collectionIntakeUnitDetail(db, source, {
    planId: 'retained-plan',
    unitId: 'selected-unit',
    version: 3,
  });
  assert.deepEqual(result.unit, {
    id: 'selected-unit',
    pages: [2],
    coverage: {
      unitId: 'selected-unit',
      kind: 'context',
      notes: 'Fictional complete retained note',
    },
  });
  assert.equal(Object.hasOwn(result.unit, 'attempts'), false);
  assert.throws(
    () =>
      collectionIntakeUnitDetail(db, source, {
        planId: 'retained-plan',
        unitId: 'selected-unit',
        version: 2,
      }),
    /changed/,
  );
});

test('selected saved destinations and exact review counts require a checked complete index', async (t) => {
  const saved = (entityId: string) => ({
    recordId: 'record-one',
    entityId,
    kind: 'document',
    title: 'Fictional report',
    optical: false,
    outcome: 'added',
  });
  const data = {
    ...input(0),
    intake: {
      ...input(0).intake,
      acceptedProposalId: 'selected-proposal',
      imported: { clinical: { records: [saved('current-first'), saved('current-second')] } },
      importHistory: [
        { acceptedProposalId: 'selected-proposal', clinical: { records: [saved('historical')] } },
      ],
    },
  };
  const { db, source } = fixture(t, data);
  await buildIntakeCollectionEnvelope(db, source);
  const request = {
    groupId: 'group-one',
    proposalId: 'selected-proposal',
    recordIds: ['record-one', 'missing'],
  };
  assert.throws(
    () => collectionIntakeAcceptedDestinations(db, source, request),
    /incomplete|stale|index/,
  );
  const options = { mappingVersion: 'fictional-mapping', isSourceContextVersion: () => false };
  assert.equal(
    collectionIntakeSummary(db, source, { durability, ...options }).review.state,
    'pending',
  );
  await buildVerifiedWorkflowSummary(db, source, options);
  const result = collectionIntakeAcceptedDestinations(db, source, request);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]!.entityId, 'current-first');
  assert.equal(result.version, 3);
  const summary = collectionIntakeSummary(db, source, { durability, ...options });
  assert.equal(summary.review.state, 'exact');
  assert.equal(summary.review.counts?.needsReview, false);
  assert.throws(
    () =>
      collectionIntakeAcceptedDestinations(db, source, {
        ...request,
        recordIds: Array(101).fill('record-one'),
      }),
    /100/,
  );
});

test('selected legacy active plan is a checked header, with no unit or batch arrays', async (t) => {
  const data = {
    ...input(0),
    intake: {
      ...input(0).intake,
      workflow: {
        ...input(0).intake.workflow,
        plans: [
          {
            id: 'active-plan',
            createdAt: '2026-01-02T00:00:00Z',
            status: 'active',
            pins: {
              sourceHash: 'c'.repeat(64),
              backend: 'host',
              model: null,
              reasoningEffort: null,
              instructionVersion: 'fictional-instructions',
              mappingVersion: 'fictional-mapping',
            },
            units: [],
            batches: [],
          },
        ],
      },
    },
  };
  const { db, source } = fixture(t, data);
  await buildIntakeCollectionEnvelope(db, source);
  assert.equal(collectionIntakeSummary(db, source, { durability }).activePlan.state, 'pending');
  await buildVerifiedWorkflowSummary(db, source, {
    mappingVersion: 'fictional-mapping',
    isSourceContextVersion: () => false,
  });
  const selected = collectionIntakeSummary(db, source, { durability }).activePlan;
  assert.equal(selected.state, 'exact');
  assert.equal(selected.plan?.id, 'active-plan');
  assert.equal(selected.plan?.unitCount, 0);
  assert.equal(Object.hasOwn(selected.plan!, 'units'), false);
});
