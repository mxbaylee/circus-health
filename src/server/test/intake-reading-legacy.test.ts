import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase, clinicalReviewRevision } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, createIntakePlan, workflowMutation } from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareCollectionWorkflowReadiness } from '../intake-workflow-readiness.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { prepareRetainedPlanAccess, readRetainedPlanScope } from '../intake-retained-plan.ts';
import {
  importLegacyReadingCheckpoint,
  prepareLegacyReadingUpdate,
  openLegacyReadingSession,
  legacyReadingUnitKey,
} from '../intake-reading-legacy.ts';
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
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';

for (const pendingRankCases of [false, true])
  test(
    pendingRankCases
      ? 'opted-in pending page rank keeps hook barriers and exact spill checkpoints'
      : 'legacy page flags and final tails use bounded real checkpoints without changing target plans',
    async (t) => {
      fictionalModel(t);
      const root = mkdtempSync(join(tmpdir(), 'fictional-legacy-reading-checkpoints-')),
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
        bytes: Buffer.from('Independently fictional checkpoint targets.'),
      });
      const planned = await createIntakePlan(db, root, profileId, source.id, {
        version: source.version,
      });
      const changed = workflowMutation(
        db,
        root,
        profileId,
        source.id,
        {
          version: planned.version,
          operationId: 'fictional-overlapping-page-targets',
        },
        (workflow) => {
          workflow.plans[0]!.units = Array.from({ length: 34 }, (_, ordinal) => ({
            id: 'fictional-pdf-' + ordinal,
            kind: 'pdf',
            locator: 'Fictional overlapping page target ' + ordinal,
            pages: ordinal === 0 ? [1, 2] : [1],
            status: 'pending',
            attempts: [],
          }));
        },
      );
      await buildIntakeCollectionEnvelope(db, { id: source.id });
      await prepareRetainedPlanAccess(db, profileId, source.id);
      const selected = readRetainedPlanScope(db, profileId, source.id)!,
        planAddress = selected.reader.address(selected.record),
        basis = intakeSourceVersion(db, source.id),
        collections = selectedEnvelopeStore(db, { id: source.id }).collections,
        sequence = () => collections.binding(collections.openView())!.storageSequence,
        window = (page: number) =>
          conversionReadDescriptor('health_intake_read', { id: source.id, page }),
        scopeKey = (page: number) => conversionScopeKey([source.id, null, page]);
      const context = (sessionId: string, ordinal = 0) => ({
        db,
        intakeId: source.id,
        sourceHash: source.sha256,
        sessionId,
        unitKey: legacyReadingUnitKey(planAddress, 'fictional-pdf-' + ordinal),
        assertCurrent() {
          assert.equal(intakeSourceVersion(db, source.id).logicalBinding, basis.logicalBinding);
        },
      });
      const importEmpty = (sessionId: string) =>
        importLegacyReadingCheckpoint(db, root, profileId, source.id, sessionId, {
          intakeId: source.id,
          profileId,
          sourceHash: source.sha256,
          version: changed.version,
          seen: [],
          readScopes: [],
          jsonRoots: [],
          pending: [],
          completedUnits: [],
          accountedUnits: [],
          lastWindow: null,
          turns: 0,
          pagesProcessed: 0,
        });
      type LegacyUpdate = NonNullable<Awaited<ReturnType<typeof prepareLegacyReadingUpdate>>>;
      const publish = (value: Awaited<ReturnType<LegacyUpdate['finishPending']>>) => {
        const operationId = randomUUID();
        collections.commitMaintenance(
          collections.prepare(collections.openView(), {
            operationId,
            requestDigest: createHash('sha256').update(operationId).digest('hex'),
            domainVersion: basis.rawVersion,
            changes: [...(value.pending ?? []), value.change],
          }),
        );
      };
      for (const [withHook, deferInitialAdoption, deferPageRankWrites] of (pendingRankCases
        ? [
            [false, true, true],
            [true, true, true],
          ]
        : [
            [false, false, false],
            [true, false, false],
            [false, true, false],
            [true, true, false],
          ]) as readonly (readonly [boolean, boolean, boolean])[]) {
        const deferred = deferInitialAdoption && !withHook;
        const pendingRank = deferred && deferPageRankWrites;
        const sessionId =
          (withHook ? 'fictional-checkpoint-hooks' : 'fictional-checkpoint-tail') +
          (deferInitialAdoption ? '-opted-in' : '') +
          (deferPageRankWrites ? '-pending-rank' : '');
        await importEmpty(sessionId);
        const ctx = context(sessionId);
        let hooks = 0;
        const beforePreparation = sequence();
        const update = (await prepareLegacyReadingUpdate(ctx, {
          deferInitialAdoption,
          deferPageRankWrites,
          ...(withHook
            ? {
                onCheckpoint: () => {
                  hooks++;
                },
              }
            : {}),
        }))!;
        assert.equal(
          sequence() - beforePreparation,
          deferred ? 0 : 1,
          'only the explicit no-hook native opt-in defers its initial private adoption',
        );
        assert.equal(
          update.readPageRank(2),
          0,
          'inherited rank is available before the first flush',
        );
        await update.markSeen(window(2));
        const beforePage = sequence();
        await update.markRead(scopeKey(2));
        assert.equal(
          sequence() - beforePage,
          withHook ? 2 : pendingRank ? 0 : 1,
          'only the explicit no-hook rank overlay avoids its rank-visibility checkpoint',
        );
        assert.equal(hooks, withHook ? 2 : 0);
        assert.equal(update.readPageRank(1), 0);
        assert.equal(update.readPageRank(2), 1);
        assert.equal(
          openLegacyReadingSession(ctx)!.readPages(),
          0,
          'the prepared flags are not selected reading evidence',
        );
        await update.markLast(window(2));
        const beforeFinish = sequence(),
          final = await update.finishPending({ seen: 1, distinct: 1, pending: 0 }, 63);
        if (deferred) {
          assert.throws(
            () => update.has('seen', conversionWindowKey(window(2))),
            /already finished/,
          );
          assert.throws(() => update.readPageRank(2), /already finished/);
          await assert.rejects(update.markSeen(window(1)), /already finished/);
          await assert.rejects(update.markLast(window(1)), /already finished/);
          await assert.rejects(update.markRead(scopeKey(1)), /already finished/);
          await assert.rejects(
            update.removeWindow(conversionWindowKey(window(1))),
            /already finished/,
          );
          await assert.rejects(update.readUnit(), /already finished/);
          await assert.rejects(update.supply(window(1)), /already finished/);
          await assert.rejects(update.markJSON('fictional'), /already finished/);
          await assert.rejects(update.sourceRoute('fictional', 'fictional'), /already finished/);
          await assert.rejects(
            update.finishPending({ seen: 1, distinct: 1, pending: 0 }, 63),
            /already finished/,
          );
          update.assertCurrent();
        }
        assert.equal(sequence() - beforeFinish, withHook ? 1 : 0);
        publish(final);
        assert.equal(
          sequence() - beforeFinish,
          withHook ? 2 : 1,
          'only a no-hook final tail joins its selected adoption',
        );
        clearIntakeStateCache(db);
        const retained = openLegacyReadingSession(ctx)!;
        assert.equal(retained.readPages(), 1);
        assert.equal(retained.readPageRank(2), 1);
        assert.equal(retained.lastWindowKey(), conversionWindowKey(window(2)));
        assert.equal(retained.has('seen', conversionWindowKey(window(2))), true);
        assert.equal(
          readCollectionConversionSessionTotals(db, profileId, source.id, sessionId).seen,
          1,
        );
        const overflow = (await prepareLegacyReadingUpdate(ctx, {
          deferInitialAdoption,
          deferPageRankWrites,
          ...(withHook ? { onCheckpoint: () => {} } : {}),
        }))!;
        assert.equal(overflow.readPageRank(2), 1, 'a new opted-in updater reads inherited flags');
        await overflow.markSeen(window(1));
        const beforeOverflow = sequence();
        await overflow.markRead(scopeKey(1));
        assert.equal(
          sequence() - beforeOverflow,
          withHook ? 3 : pendingRank ? 1 : 2,
          '34 targets keep the automatic 64-change spill; only opted-in tails remain pending',
        );
        assert.equal(overflow.readPageRank(1), 1);
        assert.equal(
          overflow.readPageRank(2),
          2,
          'a spilled adopted namespace and its remaining flags share the exact rank',
        );
        const duplicateBefore = sequence();
        await overflow.markRead(scopeKey(1));
        assert.equal(
          sequence(),
          duplicateBefore,
          'a repeated page does not rewrite flags or increment any target',
        );
        await overflow.markLast(window(1));
        const beforeFallback = sequence(),
          fallback = await overflow.finishPending({ seen: 2, distinct: 2, pending: 0 }, 0);
        assert.equal(fallback.pending, undefined);
        assert.equal(
          sequence() - beforeFallback,
          1,
          'a final tail over budget keeps its original flush',
        );
        publish(fallback);
        assert.equal(sequence() - beforeFallback, 2);
        clearIntakeStateCache(db);
        for (let ordinal = 0; ordinal < 34; ordinal++) {
          const member = openLegacyReadingSession(context(sessionId, ordinal))!;
          assert.equal(member.readPages(), ordinal === 0 ? 2 : 1);
          assert.equal(member.readPageRank(1), 1);
        }
        assert.equal(
          readCollectionConversionSessionTotals(db, profileId, source.id, sessionId).distinct,
          2,
        );
      }
      if (pendingRankCases) return;
      await importEmpty('fictional-adopt-only');
      const adoptOnlyContext = context('fictional-adopt-only'),
        beforeAdoptOnly = sequence(),
        adoptOnly = (await prepareLegacyReadingUpdate(adoptOnlyContext, {
          deferInitialAdoption: true,
        }))!;
      assert.equal(sequence(), beforeAdoptOnly);
      await adoptOnly.readUnit();
      assert.equal(
        sequence() - beforeAdoptOnly,
        1,
        'a scan barrier publishes an otherwise empty adoption seed',
      );
      const adoptOnlyFinal = await adoptOnly.finishPending(
        { seen: 0, distinct: 0, pending: 0 },
        63,
      );
      publish(adoptOnlyFinal);
      clearIntakeStateCache(db);
      assert.equal(openLegacyReadingSession(adoptOnlyContext)!.readPages(), 0);
      await importEmpty('fictional-opted-in-cancellation');
      let revoked = false;
      const revokedContext = context('fictional-opted-in-cancellation'),
        optedIn = (await prepareLegacyReadingUpdate(revokedContext, {
          deferInitialAdoption: true,
          assertRunning() {
            if (revoked) throw Error('Fictional opted-in cancellation');
          },
        }))!,
        beforeRevocation = sequence();
      await optedIn.markSeen(window(2));
      revoked = true;
      await assert.rejects(
        optedIn.finishPending({ seen: 1, distinct: 1, pending: 0 }, 63),
        /opted-in cancellation/,
      );
      revoked = false;
      assert.throws(() => optedIn.readPageRank(2), /revoked/);
      await assert.rejects(optedIn.markLast(window(2)), /revoked/);
      assert.equal(sequence(), beforeRevocation);
      assert.equal(openLegacyReadingSession(revokedContext)!.readPages(), 0);
      const callbackSession = 'fictional-opted-in-removal';
      await importLegacyReadingCheckpoint(db, root, profileId, source.id, callbackSession, {
        intakeId: source.id,
        profileId,
        sourceHash: source.sha256,
        version: changed.version,
        seen: [],
        readScopes: [],
        jsonRoots: [],
        pending: [window(2)],
        completedUnits: [],
        accountedUnits: [],
        lastWindow: null,
        turns: 0,
        pagesProcessed: 0,
      });
      const callbackContext = context(callbackSession),
        callbackUpdate = (await prepareLegacyReadingUpdate(callbackContext, {
          deferInitialAdoption: true,
          onPendingRemoved() {
            throw Error('Fictional removal callback stopped');
          },
        }))!,
        beforeCallback = sequence();
      await assert.rejects(
        callbackUpdate.removeWindow(conversionWindowKey(window(2))),
        /removal callback stopped/,
      );
      await assert.rejects(callbackUpdate.readUnit(), /revoked/);
      assert.equal(sequence(), beforeCallback);
      assert.equal(openLegacyReadingSession(callbackContext)!.pending(), 1);
      await importEmpty('fictional-cancelled-page');
      const cancelledContext = context('fictional-cancelled-page'),
        cancelled = (await prepareLegacyReadingUpdate(cancelledContext, {
          onCheckpoint() {
            throw Error('Fictional legacy checkpoint stopped');
          },
        }))!;
      await assert.rejects(cancelled.markRead(scopeKey(2)), /checkpoint stopped/);
      clearIntakeStateCache(db);
      assert.equal(openLegacyReadingSession(cancelledContext)!.readPages(), 0);
      assert.equal(
        readCollectionConversionSessionTotals(db, profileId, source.id, 'fictional-cancelled-page')
          .seen,
        0,
      );
      await importEmpty('fictional-original-finish');
      const originalContext = context('fictional-original-finish'),
        original = (await prepareLegacyReadingUpdate(originalContext))!;
      await original.markSeen(window(2));
      await original.markRead(scopeKey(2));
      await original.markLast(window(2));
      const beforeOriginal = sequence(),
        originalChange = await original.finish({ seen: 1, distinct: 1, pending: 0 });
      assert.equal(sequence() - beforeOriginal, 1, 'the original finish API always flushes');
      publish({ pending: undefined, change: originalChange });
      assert.equal(sequence() - beforeOriginal, 2);
      clearIntakeStateCache(db);
      assert.equal(openLegacyReadingSession(originalContext)!.readPages(), 1);
      assert.equal(
        readCollectionConversionSessionTotals(db, profileId, source.id, 'fictional-original-finish')
          .seen,
        1,
      );
      await importEmpty('fictional-cancelled-final-tail');
      let stopped = false;
      const tailContext = context('fictional-cancelled-final-tail'),
        tail = (await prepareLegacyReadingUpdate(tailContext, {
          assertRunning() {
            if (stopped) throw Error('Fictional legacy final tail stopped');
          },
        }))!;
      await tail.markSeen(window(2));
      await tail.markRead(scopeKey(2));
      await tail.markLast(window(2));
      const beforeCancelledTail = sequence();
      stopped = true;
      await assert.rejects(
        tail.finishPending({ seen: 1, distinct: 1, pending: 0 }, 63),
        /tail stopped/,
      );
      assert.equal(
        sequence(),
        beforeCancelledTail,
        'cancelled final-tail admission publishes nothing',
      );
      clearIntakeStateCache(db);
      assert.equal(openLegacyReadingSession(tailContext)!.readPages(), 0);
      assert.equal(
        readCollectionConversionSessionTotals(
          db,
          profileId,
          source.id,
          'fictional-cancelled-final-tail',
        ).seen,
        0,
      );
    },
  );

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
