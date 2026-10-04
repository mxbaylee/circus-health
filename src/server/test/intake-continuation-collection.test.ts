import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, clinicalReviewRevision } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  uploadIntake,
  createIntakePlan,
  workflowMutation,
  retainIntakeChildren,
} from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { createPagedPackagePlan, readPackagePlanScope } from '../intake-package-plan.ts';
import { readIntakePackageMemberPaged } from '../intake-package.ts';
import {
  openCollectionConversion,
  createCollectionCheckpoint,
  recordCollectionConversionRead,
  collectionConversionResumeContext,
  assertCollectionConversionCoverage,
  readCollectionConversionWindow,
  deferCollectionConversionRead,
  acknowledgeCollectionConversionRead,
  readCollectionConversionSessionTotals,
  prepareManualCollectionDescendantRead,
} from '../intake-continuation-collection.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import { importLegacyReadingCheckpoint } from '../intake-reading-legacy.ts';
import { conversionReadDetails } from '../intake-continuation.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { clearPackageSourceSession } from '../intake-package-session.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { prepareCollectionWorkflowReadiness } from '../intake-workflow-readiness.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareRetainedPlanAccess } from '../intake-retained-plan.ts';
import { readCollectionModelContext } from '../intake-model-collection.ts';
import { prepareCollectionModelContext } from '../intake-model-collection.ts';
import { createPagedDirectPlan, readDirectPlanScope } from '../intake-direct-plan.ts';
import { prepareExtractionBatchScope } from '../intake-extraction-batch-scope.ts';
import {
  setCollectionProcessingException,
  clearCollectionProcessingExceptions,
} from '../intake-processing-exceptions.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';

test('concurrent reading publications merge exact session evidence and queued cancellation leaves no receipt', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-concurrent-reading-')),
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
    bytes: Buffer.from('Fictional reading source. '.repeat(600)),
  });
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  const planned = await createPagedDirectPlan(db, root, profileId, source.id, {
    version: source.version,
    operationId: 'concurrent-reading-plan',
  });
  const direct = readDirectPlanScope(db, profileId, source.id)!;
  assert.ok(direct.unitCount >= 2);
  const sessionId = 'concurrent';
  await importLegacyReadingCheckpoint(db, root, profileId, source.id, sessionId, {
    intakeId: source.id,
    profileId,
    sourceHash: source.sha256,
    version: planned.version,
    seen: [],
    readScopes: [],
    jsonRoots: [],
    pending: [],
    completedUnits: [],
    accountedUnits: [],
    turns: 0,
    pagesProcessed: 0,
    lastWindow: null,
  });
  const scopes = [0, 1].map((ordinal) =>
    openCollectionConversion(db, root, profileId, source.id, {
      sessionId,
      unitId: direct.unitAt(ordinal)!.id,
    })!,
  );
  const checkpoints = scopes.map(createCollectionCheckpoint);
  const args = (index: number, offset = index * 12000) => ({
    id: source.id,
    unitId: scopes[index]!.unitId,
    offset,
  });
  const result = (offset: number) => ({
    original: { literal: 'Fictional window.', offset, nextOffset: null },
  });
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  let held = false;
  const first = recordCollectionConversionRead(
    scopes[0]!,
    checkpoints[0]!,
    'health_intake_read',
    args(0),
    result(0),
    {
      async onCheckpoint() {
        if (held) return;
        held = true;
        entered.resolve();
        await resume.promise;
      },
    },
  );
  await entered.promise;
  let stopped = false;
  const cancelled = recordCollectionConversionRead(
    scopes[1]!,
    checkpoints[1]!,
    'health_intake_read',
    args(1),
    result(12000),
    {
      assertRunning() {
        if (stopped) throw Error('Queued reader stopped');
      },
    },
  );
  const cancelledProof = assert.rejects(cancelled, /Queued reader stopped/);
  stopped = true;
  resume.resolve();
  assert.equal(await first, true);
  await cancelledProof;
  const totals = () => readCollectionConversionSessionTotals(db, profileId, source.id, sessionId);
  assert.equal(totals().seen, 1);
  assert.equal(totals().distinct, 1);
  assert.equal(totals().pending, 0);
  assert.deepEqual(
    await Promise.all(
      scopes.map((scope, index) =>
        recordCollectionConversionRead(
          scope,
          checkpoints[index]!,
          'health_intake_read',
          args(index),
          result(index * 12000),
        ),
      ),
    ),
    [false, true],
    'a rejected queued operation releases the session and distinct unit contributions merge',
  );
  assert.equal(totals().seen, 2);
  assert.equal(totals().distinct, 2);
  const deferred = await deferCollectionConversionRead(
    scopes[0]!,
    checkpoints[0]!,
    'health_intake_read',
    args(0, 1),
    result(1),
  );
  assert.ok(deferred);
  assert.equal(totals().seen, 2);
  assert.deepEqual(
    await Promise.all([
      acknowledgeCollectionConversionRead(scopes[0]!, checkpoints[0]!, deferred.key),
      acknowledgeCollectionConversionRead(scopes[0]!, checkpoints[0]!, deferred.key),
    ]),
    [true, false],
  );
  assert.equal(totals().seen, 3);
  assert.equal(totals().distinct, 3);
  clearIntakeStateCache(db);
  assert.equal(totals().seen, 3, 'quiescent evidence survives cache disposal');
  assert.equal(totals().distinct, 3);
});

test('manual descendant reads require exact ancestry, original bytes and session without manufacturing parent coverage', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-descendant-reading-')),
    profileId = 'fictional';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const parent = uploadIntake(db, root, profileId, {
    filename: 'fictional.png',
    bytes: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIYkAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  const child = retainIntakeChildren(db, root, profileId, parent.id, [
    {
      filename: 'fictional-child.txt',
      locator: 'fictional retained child',
      bytes: Buffer.from('Independently fictional child source'),
      derivative: false,
    },
  ])[0]!;
  const unrelated = uploadIntake(db, root, profileId, {
    filename: 'fictional-unrelated.txt',
    bytes: Buffer.from('Separate fictional delivery'),
  });
  await buildIntakeCollectionEnvelope(db, { id: parent.id });
  await createPagedDirectPlan(db, root, profileId, parent.id, {
    version: intakeSourceVersion(db, parent.id).version,
    operationId: 'manual-descendant-plan',
  });
  const scope = openCollectionConversion(db, root, profileId, parent.id, { sessionId: 'manual' })!,
    checkpoint = createCollectionCheckpoint(scope),
    args = { id: child.id },
    result = {
      original: { literal: 'Independently fictional child source', offset: 0, nextOffset: null },
    };
  const totals = () => readCollectionConversionSessionTotals(db, profileId, parent.id, 'manual');
  await assert.rejects(
    prepareManualCollectionDescendantRead(scope, unrelated.id),
    /does not belong/,
  );
  const capability = await prepareManualCollectionDescendantRead(scope, child.id);
  const other = openCollectionConversion(db, root, profileId, parent.id, {
    sessionId: 'another-session',
  })!;
  await assert.rejects(
    recordCollectionConversionRead(
      other,
      createCollectionCheckpoint(other),
      'health_intake_read',
      args,
      result,
      {
        descendantRead: capability,
      },
    ),
    /Foreign manual descendant/,
  );
  await assert.rejects(
    recordCollectionConversionRead(
      scope,
      checkpoint,
      'health_intake_read',
      { ...args, unitId: 'unrelated-unit' },
      result,
      {
        descendantRead: capability,
      },
    ),
    /different occurrence/,
  );
  const original = JSON.parse(readIntakeEnvelopeText(db, { id: child.id })!);
  const reparent = () =>
    writeIntakeFixtureEnvelope(db, child.id, {
      ...original,
      intake: { ...original.intake, parentSourceFileId: unrelated.id },
    });
  reparent();
  await assert.rejects(
    recordCollectionConversionRead(scope, checkpoint, 'health_intake_read', args, result, {
      descendantRead: capability,
    }),
    /does not belong/,
  );
  writeIntakeFixtureEnvelope(db, child.id, original);
  let changed = false;
  await assert.rejects(
    recordCollectionConversionRead(scope, checkpoint, 'health_intake_read', args, result, {
      descendantRead: capability,
      onCheckpoint() {
        if (!changed) {
          changed = true;
          reparent();
        }
      },
    }),
    /does not belong/,
  );
  assert.equal(changed, true);
  writeIntakeFixtureEnvelope(db, child.id, original);
  let stopped = false;
  await assert.rejects(
    recordCollectionConversionRead(scope, checkpoint, 'health_intake_read', args, result, {
      descendantRead: capability,
      assertRunning() {
        if (stopped) throw Error('Manual descendant stopped');
      },
      onCheckpoint() {
        stopped = true;
      },
    }),
    /Manual descendant stopped/,
  );
  assert.equal(totals().seen, 0);
  const deferred = await deferCollectionConversionRead(
    scope,
    checkpoint,
    'health_intake_read',
    args,
    result,
    {
      descendantRead: capability,
    },
  );
  assert.ok(deferred);
  assert.equal(totals().seen, 0, 'a source route is not acknowledged reading');
  clearIntakeStateCache(db);
  const reopened = openCollectionConversion(db, root, profileId, parent.id, {
    sessionId: 'manual',
  })!;
  assert.equal(await acknowledgeCollectionConversionRead(reopened, checkpoint, deferred.key), true);
  assert.equal(totals().seen, 1);
  assert.equal(totals().distinct, 1);
  assert.throws(
    () =>
      assertCollectionConversionCoverage([reopened], {
        planId: reopened.planId,
        coverage: [{ unitId: reopened.unitId, kind: 'extracted', notes: 'Fictional child only' }],
      }),
    { code: 'CONVERSION_COVERAGE_PENDING' },
  );
  reparent();
  await assert.rejects(
    recordCollectionConversionRead(reopened, checkpoint, 'health_intake_read', args, result),
    /does not belong/,
  );
  assert.equal(totals().seen, 1);
  writeIntakeFixtureEnvelope(db, child.id, original);
  const { updateIntakeMetadataRead } = await import('../intake.ts');
  const beforeDomainChange = intakeSourceVersion(db, parent.id);
  await updateIntakeMetadataRead(db, root, profileId, parent.id, {
    version: beforeDomainChange.version,
    operationId: 'fictional-parent-domain-change',
    metadata: { careArea: 'Fictional changed care area' },
  });
  assert.notEqual(
    intakeSourceVersion(db, parent.id).logicalBinding,
    beforeDomainChange.logicalBinding,
  );
  const changedScope = openCollectionConversion(db, root, profileId, parent.id, {
      sessionId: 'manual',
    })!,
    changedCheckpoint = createCollectionCheckpoint(changedScope);
  await assert.rejects(
    recordCollectionConversionRead(
      changedScope,
      changedCheckpoint,
      'health_intake_read',
      args,
      result,
      {
        descendantRead: capability,
      },
    ),
    /Foreign manual descendant/,
  );
  const changedCapability = await prepareManualCollectionDescendantRead(changedScope, child.id);
  // Corrupt this disposable projection only after the publication/recovery
  // oracles. Original evidence cannot be changed through an accepted write.
  db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('f'.repeat(64), child.id);
  await assert.rejects(
    recordCollectionConversionRead(
      changedScope,
      changedCheckpoint,
      'health_intake_read',
      args,
      result,
      {
        descendantRead: changedCapability,
      },
    ),
    /source|authority|hash/i,
  );
});

test('direct recipe plans provide exact workflow counts, model units and durable reading scope without expanded units', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-direct-reading-')),
    profileId = 'fictional';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Independently fictional source. '.repeat(1100)),
  });
  await buildIntakeCollectionEnvelope(db, { id: intake.id });
  const result = await createPagedDirectPlan(db, root, profileId, intake.id, {
    version: intake.version,
    operationId: 'direct-reading',
  });
  assert.ok('plan' in result);
  const options = { mappingVersion: result.plan.pins.mappingVersion };
  const ready = await prepareCollectionWorkflowReadiness(db, root, profileId, intake.id, options);
  assert.equal(ready.state, 'ready');
  if (ready.state !== 'ready') throw Error('Direct readiness failed');
  const direct = readDirectPlanScope(db, profileId, intake.id)!;
  assert.equal(ready.counts.pendingWorkCount, direct.unitCount);
  const model = await prepareCollectionModelContext(
    db,
    root,
    profileId,
    intake.id,
    { format: 'health-intake-model-context-request-v2', section: 'units', freshStart: true },
    options,
  );
  assert.equal(model.logicalTotal, direct.unitCount);
  const values = model.items as Array<{
    value: { id: string; format: string };
    valueFragments: Record<string, { cursor: string }>;
  }>;
  assert.equal(values[0]!.value.id, direct.unitAt(0)!.id);
  assert.equal(values[0]!.value.format, 'health-intake-direct-unit-reference-v1');
  const fragment = (start: string) => {
    let cursor: string | null = start,
      text = '';
    while (cursor) {
      const page = readCollectionModelContext(
        db,
        root,
        profileId,
        intake.id,
        {
          format: 'health-intake-model-context-request-v2',
          section: 'units',
          cursor,
          version: direct.version,
          mappingVersion: options.mappingVersion,
        },
        options,
      );
      text += page.jsonText;
      cursor = page.nextCursor as string | null;
    }
    return JSON.parse(text);
  };
  assert.equal(fragment(values[0]!.valueFragments.unit!.cursor).id, direct.unitAt(0)!.id);
  assert.deepEqual(
    fragment(values[0]!.valueFragments.sourceIndex!.cursor),
    JSON.parse([...direct.sourceIndexChunks()].join('')),
  );
  const before = { ...intakeWorkCounters(db).warm };
  const scope = openCollectionConversion(db, root, profileId, intake.id, {
    sessionId: 'direct-session',
  })!;
  assert.equal(scope.unitId, direct.unitAt(0)!.id);
  const checkpoint = createCollectionCheckpoint(scope);
  await recordCollectionConversionRead(
    scope,
    checkpoint,
    'health_intake_read',
    { id: intake.id },
    { original: { literal: 'Fictional text.', offset: 0, nextOffset: null } },
  );
  clearIntakeStateCache(db);
  const resumedScope = openCollectionConversion(db, root, profileId, intake.id, {
    sessionId: 'direct-session',
  })!;
  const resumed = collectionConversionResumeContext(resumedScope, checkpoint, options);
  assert.ok(resumed.unit && 'format' in resumed.unit);
  assert.equal(resumed.unit.format, 'health-intake-direct-unit-reference-v1');
  assert.equal(resumed.pendingWindows.total, 0);
  assertCollectionConversionCoverage([resumedScope], {
    planId: direct.planId,
    coverage: [{ unitId: scope.unitId, kind: 'extracted', notes: 'Fictional retained reading.' }],
  });
  const batch = await prepareExtractionBatchScope(db, root, profileId, intake.id, direct.planId);
  assert.equal(batch.format, 'direct');
  assert.equal(batch.unitById(scope.unitId)!.id, scope.unitId);
  const secondUnitId = direct.unitAt(1)!.id;
  await setCollectionProcessingException(db, root, profileId, intake.id, {
    version: intakeSourceVersion(db, intake.id).version,
    operationId: 'direct-stall',
    unitId: scope.unitId,
    exception: { reason: 'processing_stalled', at: '2026-10-03T00:00:00Z' },
  });
  assert.equal(
    readDirectPlanScope(db, profileId, intake.id)!.unitById(scope.unitId)!.processingException
      ?.reason,
    'processing_stalled',
  );
  const next = openCollectionConversion(db, root, profileId, intake.id, {
    sessionId: 'direct-session',
  })!;
  assert.equal(next.unitId, secondUnitId);
  await clearCollectionProcessingExceptions(db, root, profileId, intake.id, {
    version: intakeSourceVersion(db, intake.id).version,
    operationId: 'direct-retry',
  });
  assert.equal(
    openCollectionConversion(db, root, profileId, intake.id, { sessionId: 'direct-session' })!
      .unitId,
    scope.unitId,
  );
  for (const name of ['sourceDTOHydrations', 'envelopeHydrations'] as const)
    assert.equal(intakeWorkCounters(db).warm[name], before[name]);
});

test('native reading ledgers retain exact unit/window progress with atomic interruption and bounded resume', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-reading-ledger-')),
    profileId = 'fictional';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearPackageSourceSession(db);
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.zip',
    newProviderName: 'Fictional clinic',
    bytes: zipFixture([
      { name: 'first.txt', data: 'Fictional source window. '.repeat(2) },
      { name: 'second.json', data: '{"fictional":true}' },
    ]),
  });
  const planned = await createPagedPackagePlan(db, root, profileId, intake.id, {
    version: intake.version,
    operationId: 'reading-plan',
  });
  const options = { mappingVersion: planned.plan.pins.mappingVersion };
  const prepared = await prepareCollectionWorkflowReadiness(
    db,
    root,
    profileId,
    intake.id,
    options,
  );
  assert.equal(prepared.state, 'ready');
  if (prepared.state !== 'ready') throw Error('Fixture readiness failed');
  assert.equal(prepared.counts.pendingWorkCount, 2);
  const repeated = await prepareCollectionWorkflowReadiness(db, root, profileId, intake.id, {
    ...options,
    onCheckpoint() {
      throw Error('Warm readiness scanned');
    },
  });
  assert.equal(repeated.state, 'ready');
  if (repeated.state === 'ready') assert.equal(repeated.reused, true);
  let plan = readPackagePlanScope(db, root, profileId, intake.id)!;
  const first = plan.inventory.member(0)!;
  const args = { id: intake.id, action: 'read_member', memberId: first.memberId };
  const result = await readIntakePackageMemberPaged({ db, root, profileId, ...args, limit: 20 });
  const detail = conversionReadDetails('health_intake_package', args, result)!;
  assert.ok(detail.readable);
  assert.ok(typeof detail.original.nextOffset === 'number');
  let scope = openCollectionConversion(db, root, profileId, intake.id, { sessionId: 'session' })!;
  const checkpoint = createCollectionCheckpoint(scope);
  const revision = clinicalReviewRevision(db),
    counters = { ...intakeWorkCounters(db).warm };
  const deferred = await deferCollectionConversionRead(
    scope,
    checkpoint,
    'health_intake_package',
    args,
    result,
  );
  assert.ok(deferred);
  assert.equal(
    collectionConversionResumeContext(scope, checkpoint, options).reading.distinctReads,
    0,
  );
  assert.equal(
    collectionConversionResumeContext(scope, checkpoint, options).reading.pendingReadWindows,
    1,
  );
  clearIntakeStateCache(db);
  scope = openCollectionConversion(db, root, profileId, intake.id, {
    sessionId: 'session',
    unitId: scope.unitId,
  })!;
  assert.equal(await acknowledgeCollectionConversionRead(scope, checkpoint, deferred.key), true);
  assert.equal(await acknowledgeCollectionConversionRead(scope, checkpoint, deferred.key), false);
  let resume = collectionConversionResumeContext(scope, checkpoint, options);
  assert.equal(resume.reading.pendingReadWindows, 1);
  assert.equal(resume.reading.distinctReads, 1);
  assert.equal(resume.reading.readWindows, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(resume)) < 40000);
  assert.throws(
    () =>
      assertCollectionConversionCoverage([scope], {
        planId: scope.planId,
        coverage: [{ unitId: scope.unitId, kind: 'extracted', notes: 'Fictional' }],
      }),
    { code: 'CONVERSION_COVERAGE_PENDING' },
  );
  assert.equal(
    await recordCollectionConversionRead(scope, checkpoint, 'health_intake_package', args, result),
    false,
  );
  const tailArgs = { ...args, offset: detail.original.nextOffset! };
  const tail = await readIntakePackageMemberPaged({
    db,
    root,
    profileId,
    ...tailArgs,
    limit: 50,
  });
  scope = openCollectionConversion(db, root, profileId, intake.id, {
    sessionId: 'session',
    unitId: scope.unitId,
  })!;
  await recordCollectionConversionRead(scope, checkpoint, 'health_intake_package', tailArgs, tail);
  clearIntakeStateCache(db);
  scope = openCollectionConversion(db, root, profileId, intake.id, {
    sessionId: 'session',
    unitId: scope.unitId,
  })!;
  resume = collectionConversionResumeContext(scope, checkpoint, options);
  assert.equal(resume.reading.pendingReadWindows, 0);
  assert.equal(resume.reading.distinctReads, 2);
  assert.equal(resume.reading.remainingUnits, 2); // Reads do not manufacture accounting receipts.
  assert.doesNotThrow(() =>
    assertCollectionConversionCoverage([scope], {
      planId: scope.planId,
      coverage: [{ unitId: scope.unitId, kind: 'extracted', notes: 'Fictional' }],
    }),
  );
  assert.equal(clinicalReviewRevision(db), revision);
  for (const key of ['sourceDTOHydrations', 'envelopeHydrations', 'materializationReads'] as const)
    assert.equal(intakeWorkCounters(db).warm[key], counters[key]);
  plan = readPackagePlanScope(db, root, profileId, intake.id)!;
  const second = plan.inventory.member(1)!,
    secondUnit = plan.unit(second.memberId)!;
  const other = openCollectionConversion(db, root, profileId, intake.id, {
    sessionId: 'session',
    unitId: secondUnit.id,
  })!;
  const otherCheckpoint = createCollectionCheckpoint(other),
    otherArgs = { ...args, memberId: second.memberId };
  const giantPointer = '/' + '例'.repeat(1100);
  const structure = {
    original: { text: '' },
    structure: {
      jsonPointer: '',
      jsonOffset: 0,
      literalComplete: false,
      nextOffset: null,
      nextJSONOffset: null,
      children: [
        { jsonPointer: giantPointer, type: 'object', literalComplete: false, nextOffset: 4 },
        ...Array.from({ length: 16 }, (_, i) => ({ jsonPointer: '/child' + i, type: 'object' })),
      ],
    },
  };
  await assert.rejects(
    recordCollectionConversionRead(
      other,
      otherCheckpoint,
      'health_intake_package',
      otherArgs,
      structure,
      {
        onCheckpoint() {
          throw Error('Interrupted reading receipt');
        },
      },
    ),
    /Interrupted reading receipt/,
  );
  assert.equal(
    collectionConversionResumeContext(other, otherCheckpoint, options).reading.pendingReadWindows,
    0,
  );
  await recordCollectionConversionRead(
    other,
    otherCheckpoint,
    'health_intake_package',
    otherArgs,
    structure,
  );
  const pending = collectionConversionResumeContext(other, otherCheckpoint, options);
  assert.equal(pending.pendingWindows.total, 17);
  assert.equal(pending.pendingWindows.items.length, 12);
  assert.equal(pending.pendingWindows.complete, false);
  const reference = pending.pendingWindows.items[0]!;
  assert.ok('format' in reference);
  assert.equal(readCollectionConversionWindow(other, reference.key).args.jsonPointer, giantPointer);
  await recordCollectionConversionRead(other, otherCheckpoint, 'health_intake_package', otherArgs, {
    original: { literal: 'fictional' },
    structure: {
      jsonPointer: '',
      jsonOffset: 0,
      literalComplete: true,
      nextOffset: null,
      nextJSONOffset: null,
    },
  });
  assert.equal(
    collectionConversionResumeContext(other, otherCheckpoint, options).pendingWindows.total,
    0,
  );
  assert.equal(
    await recordCollectionConversionRead(
      other,
      otherCheckpoint,
      'health_intake_package',
      { ...otherArgs, jsonPointer: '/child0' },
      {
        original: { literal: 'already supplied' },
        structure: {
          jsonPointer: '/child0',
          jsonOffset: 0,
          literalComplete: true,
          nextOffset: null,
          nextJSONOffset: null,
        },
      },
    ),
    false,
  );
});

test('retained direct PDF units read exact unique page scope and expose addressed metadata without hydrating history', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-retained-reading-')),
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
    bytes: Buffer.from('Fictional retained source.'),
  });
  const planned = await createIntakePlan(db, root, profileId, source.id, {
    version: source.version,
  });
  const planId = planned.workflow!.plans[0]!.id;
  workflowMutation(
    db,
    root,
    profileId,
    source.id,
    { version: planned.version, operationId: 'fictional-page-scope' },
    (workflow) => {
      workflow.plans[0]!.units = [
        {
          id: 'page-unit',
          kind: 'pdf',
          locator: 'Fictional selected pages',
          pages: [3, 7, 3],
          status: 'pending',
          attempts: [],
        },
        {
          id: 'other-unit',
          kind: 'image',
          locator: 'Fictional other unit',
          status: 'pending',
          attempts: [],
        },
      ];
    },
  );
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  await prepareRetainedPlanAccess(db, profileId, source.id);
  let scope = openCollectionConversion(db, root, profileId, source.id, { sessionId: 'retained' })!;
  const checkpoint = createCollectionCheckpoint(scope),
    options = { mappingVersion: planned.workflow!.plans[0]!.pins.mappingVersion };
  assert.equal(scope.unitId, 'page-unit');
  const counters = { ...intakeWorkCounters(db).warm };
  const result = (page: number) => ({
    original: {
      kind: 'pdf',
      page,
      pages: 20,
      text: 'Fictional page',
      offset: 0,
      nextOffset: null,
      nextPage: page + 1,
      assets: [],
    },
  });
  await assert.rejects(
    recordCollectionConversionRead(
      scope,
      checkpoint,
      'health_intake_read',
      { id: source.id, page: 1 },
      result(1),
    ),
    /does not belong/,
  );
  await recordCollectionConversionRead(
    scope,
    checkpoint,
    'health_intake_read',
    { id: source.id, page: 3 },
    result(3),
  );
  let resume = collectionConversionResumeContext(scope, checkpoint, options);
  assert.equal(resume.reading.totalUnits, 2);
  assert.equal(resume.pendingWindows.total, 1);
  assert.equal(
    'args' in resume.pendingWindows.items[0]! && resume.pendingWindows.items[0].args.page,
    7,
  );
  assert.throws(
    () =>
      assertCollectionConversionCoverage([scope], {
        planId,
        coverage: [{ unitId: scope.unitId, kind: 'extracted', notes: 'Fictional' }],
      }),
    { code: 'CONVERSION_COVERAGE_PENDING' },
  );
  clearIntakeStateCache(db);
  scope = openCollectionConversion(db, root, profileId, source.id, {
    sessionId: 'retained',
    unitId: 'page-unit',
  })!;
  await recordCollectionConversionRead(
    scope,
    checkpoint,
    'health_intake_read',
    { id: source.id, page: 7 },
    result(7),
  );
  resume = collectionConversionResumeContext(scope, checkpoint, options);
  assert.equal(resume.pendingWindows.total, 0);
  assert.equal(resume.reading.distinctReads, 2);
  assertCollectionConversionCoverage([scope], {
    planId,
    coverage: [{ unitId: scope.unitId, kind: 'extracted', notes: 'Fictional' }],
  });
  assert.ok(resume.unit && 'record' in resume.unit);
  if (resume.unit && 'record' in resume.unit) {
    const metadata = readCollectionModelContext(
      db,
      root,
      profileId,
      source.id,
      {
        format: 'health-intake-model-context-request-v2',
        section: 'units',
        cursor: resume.unit.record!.cursor,
        version: scope.version,
        mappingVersion: options.mappingVersion,
      },
      options,
    );
    assert.equal(metadata.scope, 'record');
  }
  assert.equal(
    openCollectionConversion(db, root, profileId, source.id, {
      sessionId: 'retained',
      unitId: 'other-unit',
    })?.unitId,
    'other-unit',
  );
  for (const name of ['materializationReads', 'sourceDTOHydrations', 'envelopeHydrations'] as const)
    assert.equal(intakeWorkCounters(db).warm[name], counters[name]);
});
