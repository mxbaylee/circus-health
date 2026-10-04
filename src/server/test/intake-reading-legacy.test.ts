import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase, clinicalReviewRevision } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, createIntakePlan, workflowMutation } from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareCollectionWorkflowReadiness } from '../intake-workflow-readiness.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { prepareRetainedPlanAccess } from '../intake-retained-plan.ts';
import { importLegacyReadingCheckpoint } from '../intake-reading-legacy.ts';
import {
  conversionReadDescriptor,
  conversionWindowKey,
  conversionScopeKey,
  type ConversionCheckpoint,
} from '../intake-continuation.ts';
import {
  openCollectionConversion,
  createCollectionCheckpoint,
  recordCollectionConversionRead,
  collectionConversionResumeContext,
  assertCollectionConversionCoverage,
  readCollectionConversionSessionTotals,
  prepareLegacyCollectionReadingTargets,
} from '../intake-continuation-collection.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { createPagedDirectPlan } from '../intake-direct-plan.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';

test('legacy checkpoint import retains exact hashes, pending order and PDF evidence across interruption and cache loss', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-legacy-reading-')),
    profileId = 'fictional';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    bytes: Buffer.from('Independently fictional source.'),
  });
  const planned = await createIntakePlan(db, root, profileId, source.id, {
    version: source.version,
  });
  const changed = workflowMutation(
    db,
    root,
    profileId,
    source.id,
    { version: planned.version, operationId: 'fixture-reading' },
    (workflow) => {
      workflow.plans[0]!.id = 'fictional-retained-plan';
      workflow.plans[0]!.units = [
        { id: 'a', kind: 'text', locator: 'A', start: 0, end: 5, status: 'pending', attempts: [] },
        { id: 'b', kind: 'text', locator: 'B', start: 0, end: 10, status: 'pending', attempts: [] },
        {
          id: 'pdf',
          kind: 'pdf',
          locator: 'PDF',
          pages: [3, 7, 3],
          status: 'pending',
          attempts: [],
        },
        { id: 'image', kind: 'image', locator: 'Image', status: 'pending', attempts: [] },
      ];
    },
  );
  const options = { mappingVersion: planned.workflow!.plans[0]!.pins.mappingVersion },
    planId = changed.workflow!.plans[0]!.id;
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  await prepareCollectionWorkflowReadiness(db, root, profileId, source.id, options);
  const window = (args: Record<string, unknown>) =>
    conversionReadDescriptor('health_intake_read', args);
  const oldRead = window({ id: source.id, page: 3 });
  const checkpoint: ConversionCheckpoint = {
    intakeId: source.id,
    profileId,
    sourceHash: source.sha256,
    version: changed.version,
    seen: [conversionWindowKey(oldRead)],
    readScopes: [conversionScopeKey([source.id, null, 3])],
    jsonRoots: [conversionScopeKey([source.id, null, null])],
    pending: [
      window({ id: 'unmatched' }),
      window({ id: source.id, offset: 0 }),
      window({ id: source.id, offset: 6 }),
      window({ id: source.id, page: 7 }),
    ],
    completedUnits: ['a', 'b', 'pdf', 'image'],
    accountedUnits: ['a', 'b', 'pdf', 'image'],
    suppliedJSON: [window({ id: source.id, jsonPointer: '/supplied' })],
    lastWindow: oldRead,
    turns: 3,
    pagesProcessed: 1,
  };
  const revision = clinicalReviewRevision(db),
    before = { ...intakeWorkCounters(db).warm };
  await assert.rejects(
    importLegacyReadingCheckpoint(db, root, profileId, source.id, 'old-session', checkpoint, {
      onCheckpoint() {
        throw Error('Interrupted import');
      },
    }),
    /Interrupted import/,
  );
  assert.equal(
    readCollectionConversionSessionTotals(db, profileId, source.id, 'old-session').seen,
    0,
  );
  assert.deepEqual(
    await importLegacyReadingCheckpoint(db, root, profileId, source.id, 'old-session', checkpoint),
    { imported: true },
  );
  const scopeFor = (unitId: string, sessionId = 'old-session') =>
    openCollectionConversion(db, root, profileId, source.id, { sessionId, unitId })!;
  const resume = (unitId: string) => {
    const scope = scopeFor(unitId);
    return collectionConversionResumeContext(scope, createCollectionCheckpoint(scope), options);
  };
  assert.deepEqual(resume('a').pendingWindows.items, checkpoint.pending.slice(0, 2));
  assert.equal(resume('a').reading.accountedUnits, 0, 'completion labels are not coverage');
  assert.deepEqual(resume('b').pendingWindows.items, checkpoint.pending.slice(0, 3));
  assert.equal(resume('image').importedCheckpoint?.state, 'pending_unmatched');
  assert.deepEqual(resume('a').currentWindow, checkpoint.lastWindow);
  assert.throws(
    () =>
      assertCollectionConversionCoverage([scopeFor('image')], {
        planId,
        coverage: [{ unitId: 'image', kind: 'extracted', notes: 'Fictional' }],
      }),
    { code: 'CONVERSION_COVERAGE_PENDING' },
  );
  assert.deepEqual(readCollectionConversionSessionTotals(db, profileId, source.id, 'old-session'), {
    ...readCollectionConversionSessionTotals(db, profileId, source.id, 'old-session'),
    seen: 1,
    distinct: 1,
    pending: 4,
  });
  const b = scopeFor('b'),
    native = createCollectionCheckpoint(b),
    result = (offset: number) => ({ original: { text: 'Fictional', offset, nextOffset: null } });
  await assert.rejects(
    recordCollectionConversionRead(
      b,
      native,
      'health_intake_read',
      { id: source.id, offset: 6 },
      result(6),
      {
        onCheckpoint() {
          throw Error('Interrupted acknowledgment');
        },
      },
    ),
    /Interrupted acknowledgment/,
  );
  assert.equal(resume('b').pendingWindows.total, 3);
  await recordCollectionConversionRead(
    b,
    native,
    'health_intake_read',
    { id: source.id, offset: 6 },
    result(6),
  );
  assert.equal(
    resume('b').pendingWindows.total,
    2,
    'existing imported zero window is not enqueued twice',
  );
  assert.equal(
    readCollectionConversionSessionTotals(db, profileId, source.id, 'old-session').pending,
    3,
  );
  await recordCollectionConversionRead(
    b,
    native,
    'health_intake_read',
    { id: source.id, offset: 0 },
    result(0),
  );
  assert.equal(
    resume('a').pendingWindows.total,
    1,
    'one acknowledged shared window removes every exact target',
  );
  assert.equal(resume('b').pendingWindows.total, 1);
  const pdf = scopeFor('pdf'),
    pdfCheckpoint = createCollectionCheckpoint(pdf);
  assert.throws(
    () =>
      assertCollectionConversionCoverage([pdf], {
        planId,
        coverage: [{ unitId: 'pdf', kind: 'extracted', notes: 'Fictional' }],
      }),
    { code: 'CONVERSION_COVERAGE_PENDING' },
  );
  await recordCollectionConversionRead(
    pdf,
    pdfCheckpoint,
    'health_intake_read',
    { id: source.id, page: 7 },
    { original: { text: 'Fictional page', page: 7, offset: 0, nextOffset: null, nextPage: 8 } },
  );
  assert.equal(
    resume('pdf').pendingWindows.total,
    1,
    'prior page three evidence is retained and not enqueued again',
  );
  assert.doesNotThrow(() =>
    assertCollectionConversionCoverage([pdf], {
      planId,
      coverage: [{ unitId: 'pdf', kind: 'extracted', notes: 'Fictional' }],
    }),
  );
  // A supplied old JSON subtree is recognized without inventing literal reads.
  assert.equal(
    await recordCollectionConversionRead(
      b,
      native,
      'health_intake_read',
      { id: source.id, jsonPointer: '/supplied/child' },
      {
        original: { literal: 'Fictional' },
        structure: {
          jsonPointer: '/supplied/child',
          jsonOffset: 0,
          literalComplete: true,
          nextOffset: null,
          nextJSONOffset: null,
        },
      },
    ),
    false,
  );
  const totals = readCollectionConversionSessionTotals(db, profileId, source.id, 'old-session');
  clearIntakeStateCache(db);
  await prepareRetainedPlanAccess(db, profileId, source.id);
  assert.deepEqual(
    await importLegacyReadingCheckpoint(db, root, profileId, source.id, 'old-session', checkpoint, {
      onCheckpoint() {
        throw Error('Reimported old checkpoint');
      },
    }),
    { imported: false },
  );
  assert.deepEqual(
    readCollectionConversionSessionTotals(db, profileId, source.id, 'old-session'),
    totals,
  );
  assert.deepEqual(resume('b').pendingWindows.items, checkpoint.pending.slice(0, 1));
  assert.equal(clinicalReviewRevision(db), revision);
  assert.equal(intakeWorkCounters(db).warm.materializationReads, before.materializationReads);

  await importLegacyReadingCheckpoint(db, root, profileId, source.id, 'unit-read', {
    ...checkpoint,
    pending: checkpoint.pending.slice(1, 3),
  });
  const unitA = scopeFor('a', 'unit-read'),
    unitB = scopeFor('b', 'unit-read');
  await recordCollectionConversionRead(
    unitA,
    createCollectionCheckpoint(unitA),
    'health_intake_plan',
    { id: source.id, action: 'read_unit', unitId: 'a' },
    result(0),
  );
  assert.equal(
    collectionConversionResumeContext(unitA, createCollectionCheckpoint(unitA), options)
      .pendingWindows.total,
    0,
  );
  assert.equal(
    collectionConversionResumeContext(unitB, createCollectionCheckpoint(unitB), options)
      .pendingWindows.total,
    2,
    'an exact unit read does not suppress another overlapping unit',
  );

  await importLegacyReadingCheckpoint(db, root, profileId, source.id, 'json-read', {
    ...checkpoint,
    pending: [
      window({ id: source.id, jsonPointer: '/parent/a' }),
      window({ id: source.id, jsonPointer: '/parent/b' }),
    ],
  });
  const json = scopeFor('b', 'json-read'),
    jsonCheckpoint = createCollectionCheckpoint(json);
  await recordCollectionConversionRead(
    json,
    jsonCheckpoint,
    'health_intake_read',
    { id: source.id, jsonPointer: '/parent' },
    {
      original: { literal: 'Fictional' },
      structure: {
        jsonPointer: '/parent',
        jsonOffset: 0,
        literalComplete: true,
        nextOffset: null,
        nextJSONOffset: null,
      },
    },
  );
  assert.equal(
    collectionConversionResumeContext(json, jsonCheckpoint, options).pendingWindows.total,
    0,
    'a complete literal ancestor acknowledges its exact retained descendants',
  );
  assert.equal(
    readCollectionConversionSessionTotals(db, profileId, source.id, 'json-read').pending,
    0,
  );

  const writes: number[] = [];
  for (const size of [16, 256]) {
    const sessionId = 'history-' + size;
    await importLegacyReadingCheckpoint(db, root, profileId, source.id, sessionId, {
      ...checkpoint,
      pending: [checkpoint.pending[1]!],
      seen: Array.from({ length: size }, (_, i) =>
        createHash('sha256')
          .update('fictional-read-' + i)
          .digest('hex'),
      ),
    });
    const scope = scopeFor('b', sessionId),
      value = createCollectionCheckpoint(scope),
      counters = intakeWorkCounters(db).warm;
    await recordCollectionConversionRead(
      scope,
      value,
      'health_intake_read',
      { id: source.id, offset: 0 },
      result(0),
    );
    writes.push(
      intakeWorkCounters(db).warm.collectionWrittenBytes - counters.collectionWrittenBytes,
    );
  }
  assert.ok(writes.every((bytes) => bytes > 0));
  assert.ok(
    writes[1]! < writes[0]! * 3,
    'one acknowledgment grows with tree depth rather than copying sixteen times the retained hash history',
  );

  const replacement = await createPagedDirectPlan(db, root, profileId, source.id, {
    version: intakeSourceVersion(db, source.id).version,
    replacePlanId: planId,
    operationId: 'replace-reading-plan',
  });
  assert.ok('plan' in replacement);
  await prepareCollectionWorkflowReadiness(db, root, profileId, source.id, options);
  const replaced = openCollectionConversion(db, root, profileId, source.id, {
      sessionId: 'unit-read',
    })!,
    replacementCheckpoint = createCollectionCheckpoint(replaced);
  assert.throws(() => collectionConversionResumeContext(replaced, replacementCheckpoint, options), {
    code: 'CONVERSION_CHANGED',
  });
  const oldTotals = readCollectionConversionSessionTotals(db, profileId, source.id, 'unit-read');
  await assert.rejects(
    prepareLegacyCollectionReadingTargets(replaced, {
      onCheckpoint() {
        throw Error('Interrupted reindex');
      },
    }),
    /Interrupted reindex/,
  );
  assert.throws(() => collectionConversionResumeContext(replaced, replacementCheckpoint, options), {
    code: 'CONVERSION_CHANGED',
  });
  assert.deepEqual(await prepareLegacyCollectionReadingTargets(replaced), { changed: true });
  assert.deepEqual(
    collectionConversionResumeContext(replaced, replacementCheckpoint, options).pendingWindows
      .items,
    checkpoint.pending.slice(1, 3),
  );
  assert.equal(
    readCollectionConversionSessionTotals(db, profileId, source.id, 'unit-read').seen,
    oldTotals.seen,
  );
  assert.equal(
    readCollectionConversionSessionTotals(db, profileId, source.id, 'unit-read').pending,
    oldTotals.pending,
  );
  assert.deepEqual(
    await prepareLegacyCollectionReadingTargets(replaced, {
      onCheckpoint() {
        throw Error('Reindexed unchanged plan');
      },
    }),
    { changed: false },
  );
  await recordCollectionConversionRead(
    replaced,
    replacementCheckpoint,
    'health_intake_read',
    { id: source.id, offset: 6 },
    result(6),
  );
  assert.equal(
    collectionConversionResumeContext(replaced, replacementCheckpoint, options).pendingWindows
      .total,
    1,
  );
});
