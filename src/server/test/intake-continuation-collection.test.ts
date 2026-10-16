import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as scheduleImmediate, clearImmediate } from 'node:timers';
import {
  openDatabase,
  clinicalReviewRevision,
  observeTransactionOutcome,
  transaction,
} from '../database.ts';
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
import {
  importLegacyReadingCheckpoint,
  legacyReadingSessionName,
  prepareLegacyReadingUpdate,
} from '../intake-reading-legacy.ts';
import { conversionReadDetails, conversionScopeKey } from '../intake-continuation.ts';
import { schemaOrdinal } from '../intake-envelope-schema.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { clearPackageSourceSession } from '../intake-package-session.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { prepareCollectionWorkflowReadiness } from '../intake-workflow-readiness.ts';
import {
  buildIntakeCollectionEnvelope,
  createEnvelopeBuildWriter,
} from '../intake-envelope-build.ts';
import { prepareRetainedPlanAccess, readRetainedPlanScope } from '../intake-retained-plan.ts';
import { readCollectionModelContext } from '../intake-model-collection.ts';
import { prepareCollectionModelContext } from '../intake-model-collection.ts';
import { createPagedDirectPlan, readDirectPlanScope } from '../intake-direct-plan.ts';
import { prepareExtractionBatchScope } from '../intake-extraction-batch-scope.ts';
import {
  setCollectionProcessingException,
  clearCollectionProcessingExceptions,
} from '../intake-processing-exceptions.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { writeIntakeSourcePin } from '../intake-source-pin.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { createIntakeTree } from '../intake-state-tree.ts';

async function retainedImportedPDFRankFixture(t: import('node:test').TestContext) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-pdf-rank-boundary-')),
    profileId = 'fictional',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    bytes: Buffer.from('Independently fictional inherited PDF rank evidence.'),
  });
  const plan = await createIntakePlan(db, root, profileId, source.id, {
    version: source.version,
  });
  workflowMutation(
    db,
    root,
    profileId,
    source.id,
    { version: plan.version, operationId: 'fictional-rank-plan' },
    (workflow) => {
      workflow.plans[0]!.units = [
        {
          id: 'fictional-rank-pdf',
          kind: 'pdf',
          pages: [3, 5, 7],
          locator: 'Fictional exact pages',
          status: 'pending',
          attempts: [],
        },
      ];
    },
  );
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  await prepareRetainedPlanAccess(db, profileId, source.id);
  const sessionId = 'fictional-inherited-rank',
    unitId = 'fictional-rank-pdf',
    result = (page: number) => ({
      original: {
        kind: 'pdf',
        page,
        pages: 7,
        text: 'Fictional page',
        offset: 0,
        nextOffset: null,
        assets: [],
      },
    }),
    firstWindow = { tool: 'health_intake_read', args: { id: source.id, page: 3 } };
  await importLegacyReadingCheckpoint(db, root, profileId, source.id, sessionId, {
    intakeId: source.id,
    profileId,
    sourceHash: source.sha256,
    version: intakeSourceVersion(db, source.id).version,
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
  clearIntakeStateCache(db);
  const scope = openCollectionConversion(db, root, profileId, source.id, { sessionId, unitId })!,
    checkpoint = createCollectionCheckpoint(scope),
    collections = selectedEnvelopeStore(db, { id: source.id }).collections,
    ledger = 'reading.' + scope.ledgerId,
    legacyName = legacyReadingSessionName(sessionId, source.id, source.sha256),
    sequence = () => collections.binding(collections.openView())!.storageSequence;
  await recordCollectionConversionRead(
    scope,
    checkpoint,
    firstWindow.tool,
    firstWindow.args,
    result(3),
  );
  const pageRead = collections
    .range(collections.openView(), 'builds', legacyName, {
      after: 'legacy.pageRead:',
      items: 32,
      bytes: 32768,
    })
    .items.find((item) => item.key.startsWith('legacy.pageRead:'))!;
  assert.ok(pageRead);
  assert.equal(pageRead.value, '1');
  const pageCount =
    'legacy.pages:' + pageRead.key.slice('legacy.pageRead:'.length, pageRead.key.lastIndexOf(':'));
  assert.equal(collections.get(collections.openView(), 'builds', legacyName, pageCount), '1');
  // Construct an accepted mixed representation without rebinding a session:
  // move one genuinely acknowledged page flag to the native index, retaining
  // the same exact coverage and all original reading-state/session counters.
  const operationId = randomUUID();
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: intakeSourceVersion(db, source.id).rawVersion,
      changes: [
        {
          area: 'builds',
          collection: ledger,
          op: 'put',
          key: 'page:' + schemaOrdinal(0),
          value: '1',
        },
        { area: 'builds', collection: legacyName, op: 'delete', key: pageRead.key },
        { area: 'builds', collection: legacyName, op: 'put', key: pageCount, value: '0' },
      ],
    }),
  );
  return {
    db,
    root,
    profileId,
    source,
    sessionId,
    unitId,
    scope,
    checkpoint,
    collections,
    ledger,
    legacyName,
    sequence,
    result,
    options: { mappingVersion: plan.workflow!.plans[0]!.pins.mappingVersion },
  };
}

test('imported PDF rank retains inherited native flags without a native pre-rank publication', async (t) => {
  const f = await retainedImportedPDFRankFixture(t),
    args = { id: f.source.id, page: 7 },
    receipt = await deferCollectionConversionRead(
      f.scope,
      f.checkpoint,
      'health_intake_read',
      args,
      f.result(7),
    );
  assert.ok(receipt);
  const before = f.sequence();
  assert.equal(await acknowledgeCollectionConversionRead(f.scope, f.checkpoint, receipt.key), true);
  assert.equal(
    f.sequence() - before,
    1,
    'pending legacy flags and final selection share one publication; native rank reads inherited flags',
  );
  const pending = () => collectionConversionResumeContext(f.scope, f.checkpoint, f.options);
  assert.equal(pending().pendingWindows.total, 1);
  const firstPending = pending().pendingWindows.items[0]!;
  assert.equal('args' in firstPending && firstPending.args.page, 5);
  clearIntakeStateCache(f.db);
  f.scope = openCollectionConversion(f.db, f.root, f.profileId, f.source.id, {
    sessionId: f.sessionId,
    unitId: f.unitId,
  })!;
  assert.equal(pending().reading.distinctReads, 2);
  await recordCollectionConversionRead(
    f.scope,
    f.checkpoint,
    'health_intake_read',
    args,
    f.result(7),
  );
  assert.equal(pending().reading.distinctReads, 2, 'a duplicate legacy page is not counted twice');
  const duplicatePending = pending().pendingWindows.items[0]!;
  assert.equal('args' in duplicatePending && duplicatePending.args.page, 5);
  await recordCollectionConversionRead(
    f.scope,
    f.checkpoint,
    'health_intake_read',
    { id: f.source.id, page: 5 },
    f.result(5),
  );
  clearIntakeStateCache(f.db);
  f.scope = openCollectionConversion(f.db, f.root, f.profileId, f.source.id, {
    sessionId: f.sessionId,
    unitId: f.unitId,
  })!;
  assert.equal(pending().pendingWindows.total, 0);
  assert.equal(pending().reading.distinctReads, 3);
  assertCollectionConversionCoverage([f.scope], {
    planId: f.scope.planId,
    coverage: [
      { unitId: f.unitId, kind: 'extracted', notes: 'Fictional exact three-page coverage' },
    ],
  });
});

for (const boundary of ['page-flags', 'native-rank'] as const)
  for (const fault of ['selected-root', 'legacy-root', 'source-pin', 'cancellation'] as const)
    test(`imported PDF rank refuses ${fault} drift at its ${boundary} no-publication yield`, async (t) => {
      const f = await retainedImportedPDFRankFixture(t),
        receipt = await deferCollectionConversionRead(
          f.scope,
          f.checkpoint,
          'health_intake_read',
          { id: f.source.id, page: 7 },
          f.result(7),
        );
      assert.ok(receipt);
      const rootHash = (name: string) =>
          f.collections.collection(f.collections.openView(), 'builds', name)!.root!.hash,
        oldNative = rootHash(f.ledger),
        oldLegacy = rootHash(f.legacyName),
        oldState = f.collections.get(f.collections.openView(), 'builds', f.ledger, 'state'),
        oldReceipt = f.collections.get(
          f.collections.openView(),
          'builds',
          f.ledger,
          'deferred:' + receipt.key,
        ),
        oldTotals = readCollectionConversionSessionTotals(
          f.db,
          f.profileId,
          f.source.id,
          f.sessionId,
        ),
        version = intakeSourceVersion(f.db, f.source.id).rawVersion,
        prefix = intakeNamespace(selectedEnvelopeStore(f.db, { id: f.source.id }).identity);
      const builds = () => {
        const tree = createIntakeTree(
          selectedEnvelopeStore(f.db, { id: f.source.id }).identity,
          (hash) =>
            f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(prefix + 'node:' + hash)
              ?.value,
          new Map(),
        );
        return [...tree.entries(f.collections.binding(f.collections.openView())!.builds)].map(
          (item) => item.key,
        );
      };
      const oldBuilds = new Set(builds()),
        nativePublished = () =>
          builds().some((name) => !oldBuilds.has(name) && name.startsWith('reading.build.'));
      let firstTimer: NodeJS.Immediate | undefined,
        secondTimer: NodeJS.Immediate | undefined,
        firstYield = false,
        preRankChecked = false,
        injected = false,
        stopped = false,
        publications = 0,
        mutationError: unknown,
        actorRoot: string | undefined;
      const inject = () => {
        try {
          if (boundary === 'native-rank')
            assert.ok(preRankChecked, 'the entry proof ran after the page-flags yield');
          assert.equal(publications, 0);
          assert.equal(
            nativePublished(),
            false,
            'the cooperative yield has published no native candidate',
          );
          assert.equal(
            builds().some((name) => !oldBuilds.has(name) && name.startsWith('reading.legacy.')),
            false,
          );
          assert.equal(rootHash(f.ledger), oldNative);
          assert.equal(rootHash(f.legacyName), oldLegacy);
          injected = true;
          if (fault === 'cancellation') {
            stopped = true;
            return;
          }
          if (fault === 'source-pin') {
            const pin = intakeSourceVersion(f.db, f.source.id).sourcePin;
            transaction(f.db, () =>
              writeIntakeSourcePin(f.db, f.source.id, {
                revisionId: pin?.revisionId ?? null,
                dependencyToken: 'fictional rank-yield source dependency',
                requiresInterpretation: pin?.requiresInterpretation ?? false,
                version: (pin?.version ?? 0) + 1,
              }),
            );
            return;
          }
          const operationId = randomUUID(),
            name = fault === 'legacy-root' ? f.legacyName : f.ledger;
          f.collections.commitMaintenance(
            f.collections.prepare(f.collections.openView(), {
              operationId,
              requestDigest: createHash('sha256').update(operationId).digest('hex'),
              domainVersion: version,
              changes: [
                {
                  area: 'builds',
                  collection: name,
                  op: 'put',
                  key: 'fictional.rank-yield-drift',
                  value: 'Fictional independent drift.',
                },
              ],
            }),
          );
          actorRoot = rootHash(name);
        } catch (error) {
          mutationError = error;
        }
      };
      const dispose = observeTransactionOutcome(f.db, (outcome) => {
        if (outcome.succeeded && outcome.intakeMaintenance) publications++;
      });
      t.after(() => {
        dispose();
        if (firstTimer) clearImmediate(firstTimer);
        if (secondTimer) clearImmediate(secondTimer);
      });
      await assert.rejects(
        acknowledgeCollectionConversionRead(f.scope, f.checkpoint, receipt.key, {
          assertRunning() {
            if (stopped) throw Error('Fictional rank-yield cancellation');
            if (!firstTimer) {
              // No earlier operation in this small window needs a checkpoint.
              // The first Immediate accompanies markRead's explicit yield; the
              // nested one accompanies the separate native pre-rank yield.
              firstTimer = scheduleImmediate(() => {
                firstYield = true;
                if (boundary === 'page-flags') inject();
                else secondTimer = scheduleImmediate(inject);
              });
            }
            if (firstYield && publications === 0) preRankChecked = true;
          },
        }),
        fault === 'selected-root'
          ? /Reading ledger changed during preparation/
          : fault === 'legacy-root'
            ? /Imported reading session changed during acknowledgment/
            : fault === 'source-pin'
              ? { code: 'CONVERSION_CHANGED' }
              : /Fictional rank-yield cancellation/,
      );
      dispose();
      assert.equal(mutationError, undefined);
      assert.ok(injected, 'the fault happened at the requested no-publication yield');
      assert.equal(
        publications,
        actorRoot ? 1 : 0,
        'no native candidate or final selection was published after drift',
      );
      assert.equal(rootHash(f.ledger), fault === 'selected-root' ? actorRoot : oldNative);
      assert.equal(rootHash(f.legacyName), fault === 'legacy-root' ? actorRoot : oldLegacy);
      assert.equal(
        f.collections.get(f.collections.openView(), 'builds', f.ledger, 'state'),
        oldState,
      );
      assert.equal(
        f.collections.get(f.collections.openView(), 'builds', f.ledger, 'deferred:' + receipt.key),
        oldReceipt,
      );
      const totals = readCollectionConversionSessionTotals(
        f.db,
        f.profileId,
        f.source.id,
        f.sessionId,
      );
      if (fault === 'legacy-root') {
        const { binding: beforeBinding, ...beforeCounts } = oldTotals,
          { binding: afterBinding, ...afterCounts } = totals;
        assert.deepEqual(afterCounts, beforeCounts);
        assert.notEqual(afterBinding, beforeBinding);
      } else assert.deepEqual(totals, oldTotals);
      assert.throws(
        () =>
          assertCollectionConversionCoverage([f.scope], {
            planId: f.scope.planId,
            coverage: [
              { unitId: f.unitId, kind: 'extracted', notes: 'Fictional withheld rank coverage' },
            ],
          }),
        { code: fault === 'source-pin' ? 'CONVERSION_CHANGED' : 'CONVERSION_COVERAGE_PENDING' },
      );
    });

test('ordinary pending key metadata is detached, superseding, revisioned and bounded through adoption', async (t) => {
  const f = await retainedImportedPDFRankFixture(t),
    version = intakeSourceVersion(f.db, f.source.id).rawVersion,
    build = 'fictional.pending-keys.' + randomUUID(),
    writer = createEnvelopeBuildWriter(f.db, { id: f.source.id }, build, version, {
      adoptFrom: f.legacyName,
    }),
    prefix = 'fictional.page:',
    initial = writer.pendingKeyChanges(prefix)!;
  assert.equal(initial.collection, f.legacyName);
  assert.deepEqual(initial.changes, []);
  await writer.put(prefix + '0', 'first');
  await writer.put(prefix + '0', 'second');
  await writer.remove(prefix + '0');
  await writer.put(prefix + '1', 'last');
  await writer.put('fictional.other-page:0', 'unrelated');
  const pending = writer.pendingKeyChanges(prefix)!;
  assert.deepEqual(pending.changes, [
    { key: prefix + '0', op: 'delete' },
    { key: prefix + '1', op: 'put' },
  ]);
  pending.changes[0]!.op = 'put';
  pending.changes.push({ key: prefix + 'forged', op: 'put' });
  assert.equal(writer.pendingKeyChanges(prefix)!.changes[0]!.op, 'delete');
  assert.equal(writer.pendingKeyChanges(prefix)!.changes.length, 2);
  assert.ok(pending.revision > initial.revision);
  await writer.flush();
  assert.equal(writer.pendingKeyChanges(prefix)!.collection, build);
  assert.deepEqual(writer.pendingKeyChanges(prefix)!.changes, []);
  await writer.put(prefix + '0', 'same');
  const beforeABA = writer.pendingKeyChanges(prefix)!;
  await writer.flush();
  await writer.put(prefix + '0', 'same');
  const afterABA = writer.pendingKeyChanges(prefix)!;
  assert.deepEqual(afterABA.changes, beforeABA.changes);
  assert.equal(afterABA.collection, beforeABA.collection);
  assert.ok(afterABA.revision > beforeABA.revision, 'equal keys cannot hide a committed window');
  assert.throws(() => writer.pendingKeyChanges(0 as never), /prefix/);
  assert.ok(writer.takePendingChanges(64));
  assert.throws(() => writer.pendingKeyChanges(prefix), /already transferred/);

  const spillBuild = 'fictional.pending-spill.' + randomUUID(),
    spill = createEnvelopeBuildWriter(f.db, { id: f.source.id }, spillBuild, version, {
      adoptFrom: f.legacyName,
    });
  for (let n = 0; n < 62; n++) await spill.put(prefix + schemaOrdinal(n), '1');
  const beforeSpill = spill.pendingKeyChanges(prefix)!;
  assert.equal(beforeSpill.changes.length, 62);
  assert.equal(beforeSpill.collection, f.legacyName);
  const sequence = f.sequence();
  await spill.put(prefix + schemaOrdinal(62), '1');
  assert.equal(f.sequence() - sequence, 1, 'adoption plus 63 puts spills at exactly 64');
  const afterSpill = spill.pendingKeyChanges(prefix)!;
  assert.equal(afterSpill.collection, spillBuild);
  assert.deepEqual(afterSpill.changes, []);
  assert.ok(afterSpill.revision > beforeSpill.revision);
  const hooked = createEnvelopeBuildWriter(
    f.db,
    { id: f.source.id },
    'fictional.pending-hook.' + randomUUID(),
    version,
    { onCheckpoint() {} },
  );
  assert.equal(hooked.pendingKeyChanges(prefix), undefined);
});

test('pending imported rank counts only new same-unit flags and refuses a closing callback mutation', async (t) => {
  const f = await retainedImportedPDFRankFixture(t),
    unit = f.collections
      .range(f.collections.openView(), 'builds', f.legacyName, {
        after: 'legacy.unit:',
        items: 32,
        bytes: 32768,
      })
      .items.find((item) => item.key.startsWith('legacy.unit:'))!,
    unitKey = unit.key.slice('legacy.unit:'.length),
    prefix = 'legacy.pageRead:' + unitKey + ':',
    basis = intakeSourceVersion(f.db, f.source.id),
    operationId = randomUUID();
  assert.ok(unit);
  // Persist one flag without its read-scope guard to exercise an overwrite.
  // Other units and adjacent prefixes must never contribute to this rank.
  f.collections.commitMaintenance(
    f.collections.prepare(f.collections.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: basis.rawVersion,
      changes: [
        prefix + schemaOrdinal(0),
        'legacy.pageRead:other:' + schemaOrdinal(0),
        'legacy.pageRead:' + unitKey + '-other:' + schemaOrdinal(0),
      ].map((key) => ({
        area: 'builds' as const,
        collection: f.legacyName,
        op: 'put' as const,
        key,
        value: '1',
      })),
    }),
  );
  const context = {
      db: f.db,
      intakeId: f.source.id,
      sourceHash: f.source.sha256,
      sessionId: f.sessionId,
      unitKey,
      assertCurrent() {
        assert.equal(intakeSourceVersion(f.db, f.source.id).logicalBinding, basis.logicalBinding);
      },
    },
    update = (await prepareLegacyReadingUpdate(context, {
      deferInitialAdoption: true,
      deferPageRankWrites: true,
    }))!,
    before = f.sequence();
  assert.deepEqual([0, 1, 2, 3].map(update.readPageRank), [0, 1, 1, 1]);
  await update.markRead(conversionScopeKey([f.source.id, null, 3]));
  assert.deepEqual(
    [0, 1, 2, 3].map(update.readPageRank),
    [0, 1, 1, 1],
    'overwriting an existing persisted page flag adds no rank',
  );
  await update.markRead(conversionScopeKey([f.source.id, null, 5]));
  assert.deepEqual(
    [0, 1, 2, 3].map(update.readPageRank),
    [0, 1, 2, 2],
    'only pending flags strictly below the same-unit ordinal bound count',
  );
  await update.markRead(conversionScopeKey([f.source.id, null, 5]));
  assert.deepEqual([0, 1, 2, 3].map(update.readPageRank), [0, 1, 2, 2]);
  assert.equal(f.sequence(), before, 'rank visibility does not publish the private window');

  let armed = false,
    checks = 0,
    mutation: Promise<void> | undefined;
  const reentrant = (await prepareLegacyReadingUpdate(context, {
    deferInitialAdoption: true,
    deferPageRankWrites: true,
    assertRunning() {
      if (armed && ++checks === 2) {
        armed = false;
        mutation = reentrant.markSeen({
          tool: 'health_intake_read',
          args: { id: f.source.id, page: 7 },
        });
      }
    },
  }))!;
  armed = true;
  assert.throws(() => reentrant.readPageRank(3), /page rank window changed/);
  assert.equal(checks, 2, 'the mutation occurred in the closing current callback');
  await mutation;
  assert.ok(mutation);
  assert.throws(() => reentrant.readPageRank(3), /revoked/);
  assert.equal(f.sequence(), before);
});

test('a bounded final reading window selects in one checkpoint and hook barriers remain separate', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-final-reading-window-')),
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
    bytes: Buffer.from('Independently fictional final-window reading evidence.'),
  });
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  await createPagedDirectPlan(db, root, profileId, source.id, {
    version: source.version,
    operationId: 'final-reading-window-plan',
  });
  const direct = readDirectPlanScope(db, profileId, source.id)!,
    unitId = direct.unitAt(0)!.id,
    collections = selectedEnvelopeStore(db, { id: source.id }).collections,
    sequence = () => collections.binding(collections.openView())!.storageSequence,
    args = { id: source.id, unitId },
    result = { original: { literal: 'Fictional evidence.', offset: 0, nextOffset: null } };
  for (const withHook of [false, true]) {
    const sessionId = withHook ? 'fictional-hook-barrier' : 'fictional-final-window',
      scope = openCollectionConversion(db, root, profileId, source.id, { sessionId, unitId })!,
      checkpoint = createCollectionCheckpoint(scope);
    let hooks = 0;
    const before = sequence();
    assert.equal(
      await recordCollectionConversionRead(scope, checkpoint, 'health_intake_read', args, result, {
        ...(withHook
          ? {
              onCheckpoint: () => {
                hooks++;
              },
            }
          : {}),
      }),
      true,
    );
    assert.equal(
      sequence() - before,
      withHook ? 2 : 1,
      'only the no-hook bounded path merges final writes with selected ledger adoption',
    );
    assert.equal(hooks, withHook ? 1 : 0);
    clearIntakeStateCache(db);
    const reopened = openCollectionConversion(db, root, profileId, source.id, {
        sessionId,
        unitId,
      })!,
      resume = collectionConversionResumeContext(reopened, createCollectionCheckpoint(reopened), {
        mappingVersion: direct.plan.pins.mappingVersion,
      });
    assert.equal(resume.reading.distinctReads, 1);
    assert.equal(resume.pendingWindows.total, 0);
    const totals = readCollectionConversionSessionTotals(db, profileId, source.id, sessionId);
    assert.equal(totals.sourceHash, source.sha256);
    assert.equal(totals.sessionId, sessionId);
    assert.deepEqual(
      { seen: totals.seen, distinct: totals.distinct, pending: totals.pending },
      {
        seen: 1,
        distinct: 1,
        pending: 0,
      },
    );
    const repeatedBefore = sequence();
    assert.equal(
      await recordCollectionConversionRead(
        reopened,
        createCollectionCheckpoint(reopened),
        'health_intake_read',
        args,
        result,
      ),
      false,
    );
    assert.equal(
      sequence() - repeatedBefore,
      1,
      'the no-hook retained fork shares the bounded final selection publication',
    );
    assert.equal(
      readCollectionConversionSessionTotals(db, profileId, source.id, sessionId).distinct,
      1,
    );
    if (!withHook) {
      const deferredArgs = { ...args, offset: 1 },
        deferredResult = {
          original: { literal: 'Fictional later evidence.', offset: 1, nextOffset: null },
        },
        beforeDefer = sequence(),
        receipt = await deferCollectionConversionRead(
          reopened,
          createCollectionCheckpoint(reopened),
          'health_intake_read',
          deferredArgs,
          deferredResult,
        );
      assert.ok(receipt);
      assert.equal(sequence() - beforeDefer, 1, 'retained defer publishes its fork and tail once');
      const selectedRoot = collections.collection(
          collections.openView(),
          'builds',
          'reading.' + reopened.ledgerId,
        )!.root!.hash,
        duplicateBefore = sequence();
      assert.deepEqual(
        await deferCollectionConversionRead(
          reopened,
          createCollectionCheckpoint(reopened),
          'health_intake_read',
          deferredArgs,
          deferredResult,
        ),
        receipt,
      );
      assert.equal(sequence(), duplicateBefore, 'an already deferred window publishes nothing');
      assert.equal(
        collections.collection(collections.openView(), 'builds', 'reading.' + reopened.ledgerId)!
          .root!.hash,
        selectedRoot,
        'duplicate defer leaves the exact selected tree unchanged',
      );
      const beforeAck = sequence();
      assert.equal(
        await acknowledgeCollectionConversionRead(
          reopened,
          createCollectionCheckpoint(reopened),
          receipt.key,
        ),
        true,
      );
      assert.equal(sequence() - beforeAck, 1, 'retained acknowledgement selects its fork once');
      clearIntakeStateCache(db);
      const checked = openCollectionConversion(db, root, profileId, source.id, {
          sessionId,
          unitId,
        })!,
        checkedResume = collectionConversionResumeContext(
          checked,
          createCollectionCheckpoint(checked),
          { mappingVersion: direct.plan.pins.mappingVersion },
        );
      assert.equal(checkedResume.reading.distinctReads, 2);
      assert.equal(checkedResume.pendingWindows.total, 0);
      const totals = readCollectionConversionSessionTotals(db, profileId, source.id, sessionId);
      assert.deepEqual(
        { seen: totals.seen, distinct: totals.distinct, pending: totals.pending },
        { seen: 2, distinct: 2, pending: 0 },
      );
    }
  }
  for (const withHook of [false, true]) {
    const sessionId = withHook
      ? 'fictional-imported-hook-barrier'
      : 'fictional-imported-final-window';
    await importLegacyReadingCheckpoint(db, root, profileId, source.id, sessionId, {
      intakeId: source.id,
      profileId,
      sourceHash: source.sha256,
      version: direct.version,
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
    const scope = openCollectionConversion(db, root, profileId, source.id, { sessionId, unitId })!,
      before = sequence();
    let hooks = 0;
    assert.equal(
      await recordCollectionConversionRead(
        scope,
        createCollectionCheckpoint(scope),
        'health_intake_read',
        args,
        result,
        {
          ...(withHook
            ? {
                onCheckpoint: () => {
                  hooks++;
                },
              }
            : {}),
        },
      ),
      true,
    );
    assert.equal(
      sequence() - before,
      withHook ? 5 : 1,
      'no-hook read flags and both final ledger tails share the selected transaction',
    );
    assert.equal(hooks, withHook ? 3 : 0);
    clearIntakeStateCache(db);
    const reopened = openCollectionConversion(db, root, profileId, source.id, {
        sessionId,
        unitId,
      })!,
      resume = collectionConversionResumeContext(reopened, createCollectionCheckpoint(reopened), {
        mappingVersion: direct.plan.pins.mappingVersion,
      });
    assert.equal(resume.reading.distinctReads, 1);
    assert.equal(resume.pendingWindows.total, 0);
    assert.equal(
      readCollectionConversionSessionTotals(db, profileId, source.id, sessionId).seen,
      1,
    );
    const repeatedBefore = sequence();
    assert.equal(
      await recordCollectionConversionRead(
        reopened,
        createCollectionCheckpoint(reopened),
        'health_intake_read',
        args,
        result,
      ),
      false,
    );
    assert.equal(
      sequence() - repeatedBefore,
      1,
      'the opted-in imported and native forks share the bounded final window',
    );
    assert.equal(
      readCollectionConversionSessionTotals(db, profileId, source.id, sessionId).distinct,
      1,
    );
    if (!withHook) {
      for (const depth of [44, 45, 49]) {
        const wideArgs = { ...args, jsonPointer: '/fictional'.repeat(depth) },
          wideResult = {
            original: {
              literal: 'Fictional combined-tail evidence.',
              offset: 0,
              nextOffset: null,
            },
          },
          beforeDefer = sequence(),
          receipt = await deferCollectionConversionRead(
            reopened,
            createCollectionCheckpoint(reopened),
            'health_intake_read',
            wideArgs,
            wideResult,
          );
        assert.ok(receipt);
        assert.equal(
          sequence() - beforeDefer,
          1,
          'both opted-in forks share bounded native defer final selection',
        );
        const beforeAck = sequence();
        assert.equal(
          await acknowledgeCollectionConversionRead(
            reopened,
            createCollectionCheckpoint(reopened),
            receipt.key,
          ),
          true,
        );
        assert.equal(
          sequence() - beforeAck,
          2,
          'combined native seed and legacy tail overflow retains bounded flush fallback',
        );
        clearIntakeStateCache(db);
        const totals = readCollectionConversionSessionTotals(db, profileId, source.id, sessionId);
        assert.equal(totals.distinct, 2 + [44, 45, 49].indexOf(depth));
        assert.equal(totals.seen, totals.distinct);
        assert.equal(totals.pending, 0);
        assert.deepEqual(readCollectionConversionWindow(reopened, receipt.key), {
          tool: 'health_intake_read',
          args: wideArgs,
        });
      }
    }
  }
  const version = intakeSourceVersion(db, source.id).rawVersion;
  for (const count of [62, 63, 64]) {
    const build = 'fictional.final-window.' + count,
      target = 'fictional.selected-window.' + count,
      writer = createEnvelopeBuildWriter(db, { id: source.id }, build, version),
      before = sequence();
    for (let ordinal = 0; ordinal < count; ordinal++)
      await writer.put('key:' + ordinal, 'fictional:' + ordinal);
    assert.equal(
      sequence() - before,
      count === 64 ? 1 : 0,
      'automatic 64-change flush is unchanged',
    );
    assert.throws(() => writer.takePendingChanges(65), /budget/);
    const tail = writer.takePendingChanges(62);
    assert.equal(tail === undefined, count === 63, 'only the pending overflow falls back');
    if (tail === undefined) {
      assert.equal(
        writer.peek('key:62'),
        'fictional:62',
        'a refused transfer retains its entire window',
      );
      await writer.flush();
    }
    const operationId = randomUUID();
    collections.commitMaintenance(
      collections.prepare(collections.openView(), {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: version,
        changes: [
          ...(tail ?? []),
          {
            area: 'builds',
            collection: target,
            op: 'adoptCollection',
            fromArea: 'builds',
            fromCollection: build,
          },
          {
            area: 'builds',
            collection: 'fictional.final-window-counts',
            op: 'put',
            key: target,
            value: String(count),
          },
        ],
      }),
    );
    assert.equal(sequence() - before, count === 62 ? 1 : 2);
    clearIntakeStateCache(db);
    for (let ordinal = 0; ordinal < count; ordinal++)
      assert.equal(
        collections.get(collections.openView(), 'builds', target, 'key:' + ordinal),
        'fictional:' + ordinal,
      );
    assert.equal(
      collections.get(collections.openView(), 'builds', 'fictional.final-window-counts', target),
      String(count),
    );
  }
  const base = 'fictional.adoption-base',
    baseOperation = randomUUID();
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId: baseOperation,
      requestDigest: createHash('sha256').update(baseOperation).digest('hex'),
      domainVersion: version,
      changes: ['inherited', 'overwritten', 'deleted'].map((key) => ({
        area: 'builds',
        collection: base,
        op: 'put',
        key,
        value: 'fictional original ' + key,
      })),
    }),
  );
  for (const count of [61, 62, 63]) {
    const build = 'fictional.adopting-window.' + count,
      target = 'fictional.adopted-selection.' + count,
      writer = createEnvelopeBuildWriter(db, { id: source.id }, build, version, {
        adoptFrom: base,
      }),
      before = sequence();
    assert.equal(writer.readCollection(), base);
    assert.equal(writer.peek('inherited'), 'fictional original inherited');
    await writer.put('overwritten', 'fictional replacement');
    await writer.remove('deleted');
    for (let ordinal = 0; ordinal < count - 2; ordinal++)
      await writer.put('key:' + ordinal, 'fictional:' + ordinal);
    assert.equal(sequence() - before, count === 63 ? 1 : 0);
    assert.equal(writer.readCollection(), count === 63 ? build : base);
    assert.equal(writer.peek('overwritten'), 'fictional replacement');
    assert.equal(writer.peek('deleted'), undefined);
    const tail = writer.takePendingChanges(62);
    assert.equal(tail === undefined, count === 62, 'the adoption occupies one of 64 slots');
    if (tail === undefined) {
      assert.equal(writer.readCollection(), base, 'a refused handoff retains source fallback');
      await writer.flush();
      assert.equal(writer.readCollection(), build);
    } else {
      assert.equal(tail.length, count === 61 ? 62 : 0);
      if (count === 61) assert.equal(tail[0]!.op, 'adoptCollection');
      assert.throws(() => writer.peek('inherited'), /already transferred/);
      assert.throws(() => writer.readCollection(), /already transferred/);
      await assert.rejects(writer.put('late', 'fictional late value'), /already transferred/);
      await assert.rejects(writer.remove('late'), /already transferred/);
      await assert.rejects(writer.flush(), /already transferred/);
      await assert.rejects(writer.cell('late', 'fictional late value'), /already transferred/);
      let consumed = false;
      await assert.rejects(
        writer.cellPieces('late', {
          *[Symbol.iterator]() {
            consumed = true;
            yield 'fictional late piece';
          },
        }),
        /already transferred/,
      );
      assert.equal(consumed, false, 'handoff refuses before invoking an exposed producer');
    }
    const operationId = randomUUID();
    collections.commitMaintenance(
      collections.prepare(collections.openView(), {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: version,
        changes: [
          ...(tail ?? []),
          {
            area: 'builds',
            collection: target,
            op: 'adoptCollection',
            fromArea: 'builds',
            fromCollection: build,
          },
          {
            area: 'builds',
            collection: 'fictional.adoption-counts',
            op: 'put',
            key: target,
            value: String(count),
          },
        ],
      }),
    );
    assert.equal(sequence() - before, count === 61 ? 1 : 2);
    clearIntakeStateCache(db);
    assert.equal(
      collections.get(collections.openView(), 'builds', target, 'inherited'),
      'fictional original inherited',
    );
    assert.equal(collections.get(collections.openView(), 'builds', target, 'deleted'), undefined);
    assert.equal(
      collections.get(collections.openView(), 'builds', target, 'overwritten'),
      'fictional replacement',
    );
    for (let ordinal = 0; ordinal < count - 2; ordinal++)
      assert.equal(
        collections.get(collections.openView(), 'builds', target, 'key:' + ordinal),
        'fictional:' + ordinal,
      );
    assert.equal(
      collections.get(collections.openView(), 'builds', base, 'overwritten'),
      'fictional original overwritten',
      'the inherited base is never mutated by its fork',
    );
  }
  let adoptingStopped = false;
  const cancelledAdoption = createEnvelopeBuildWriter(
    db,
    { id: source.id },
    'fictional.cancelled-adoption',
    version,
    {
      adoptFrom: base,
      assertRunning() {
        if (adoptingStopped) throw Error('Fictional adopting window stopped');
      },
    },
  );
  await cancelledAdoption.put('pending', 'fictional pending');
  const beforeCancelledAdoption = sequence();
  adoptingStopped = true;
  await assert.rejects(cancelledAdoption.flush(), /adopting window stopped/);
  assert.throws(() => cancelledAdoption.takePendingChanges(64), /adopting window stopped/);
  assert.equal(sequence(), beforeCancelledAdoption);
  assert.equal(cancelledAdoption.readCollection(), base);
  assert.equal(cancelledAdoption.peek('pending'), 'fictional pending');
  adoptingStopped = false;
  await cancelledAdoption.flush();
  assert.equal(cancelledAdoption.readCollection(), 'fictional.cancelled-adoption');
  assert.equal(sequence() - beforeCancelledAdoption, 1);
  const blobWriter = createEnvelopeBuildWriter(
      db,
      { id: source.id },
      'fictional.adopting-blob',
      version,
      { adoptFrom: base },
    ),
    blobText = 'Fictional bounded blob. '.repeat(3000);
  await blobWriter.cell('large', blobText);
  assert.equal(blobWriter.readCollection(), 'fictional.adopting-blob');
  assert.equal(blobWriter.peek('inherited'), 'fictional original inherited');
  const blobValue = collections.get(
    collections.openView(),
    'builds',
    'fictional.adopting-blob',
    'large',
  );
  assert.ok(blobValue && typeof blobValue !== 'string');
  let after: string | undefined,
    restored = '';
  for (;;) {
    const page = collections.readBytes(blobValue, { after, items: 16, bytes: 16384 });
    restored += Buffer.concat(page.chunks).toString('utf8');
    if (page.complete) break;
    after = page.after!;
  }
  assert.equal(restored, blobText);
  assert.throws(
    () =>
      createEnvelopeBuildWriter(db, { id: source.id }, 'fictional.invalid-adoption', version, {
        adoptFrom: base,
        onCheckpoint() {},
      }),
    /ordinary build writer/,
  );
  let stopped = false,
    appendDuringAdmission = false;
  const guarded: ReturnType<typeof createEnvelopeBuildWriter> = createEnvelopeBuildWriter(
    db,
    { id: source.id },
    'fictional.guarded-tail',
    version,
    {
      assertRunning() {
        if (stopped) throw Error('Fictional final window stopped');
        if (appendDuringAdmission) {
          appendDuringAdmission = false;
          void guarded.put('late', 'fictional late value');
        }
      },
    },
  );
  await guarded.put('first', 'fictional first value');
  const guardedBefore = sequence();
  stopped = true;
  assert.throws(() => guarded.takePendingChanges(64), /final window stopped/);
  assert.equal(guarded.peek('first'), 'fictional first value');
  assert.equal(sequence(), guardedBefore, 'cancelled admission publishes nothing');
  stopped = false;
  appendDuringAdmission = true;
  assert.equal(
    guarded.takePendingChanges(1),
    undefined,
    'budget is checked after caller admission',
  );
  assert.equal(guarded.peek('first'), 'fictional first value');
  assert.equal(guarded.peek('late'), 'fictional late value');
  await guarded.flush();
  assert.equal(sequence() - guardedBefore, 1);
});

for (const imported of [false, true])
  for (const flushBoundary of imported ? (['native', 'legacy'] as const) : (['native'] as const))
    for (const fault of imported
      ? (['selected-root', 'legacy-root', 'source-pin', 'cancellation'] as const)
      : (['selected-root', 'source-pin', 'cancellation'] as const))
      test(`a retained ${imported ? 'imported ' : ''}deferred fork refuses ${fault} drift at its first bounded ${flushBoundary} flush`, async (t) => {
        fictionalModel(t);
        const root = mkdtempSync(join(tmpdir(), 'fictional-adoption-drift-')),
          profileId = 'fictional',
          db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
        attachPersonalDurability(db, { root, profileId });
        t.after(() => {
          clearIntakeStateCache(db);
          db.close();
          rmSync(root, { recursive: true, force: true });
        });
        const source = uploadIntake(db, root, profileId, {
          filename: 'fictional.txt',
          bytes: Buffer.from('Independently fictional first-flush evidence.'),
        });
        if (flushBoundary === 'legacy') {
          const planned = await createIntakePlan(db, root, profileId, source.id, {
            version: source.version,
          });
          workflowMutation(
            db,
            root,
            profileId,
            source.id,
            {
              version: planned.version,
              operationId: 'fictional-legacy-flush-plan',
            },
            (workflow) => {
              // Distinct overlapping targets force a real automatic64 spill,
              // independent of the intentionally removed ending-page flush.
              workflow.plans[0]!.units = Array.from({ length: 34 }, (_, ordinal) => ({
                id: ordinal === 0 ? 'fictional-first-flush-pdf' : 'fictional-overlap-' + ordinal,
                kind: 'pdf',
                pages: ordinal === 0 ? [1, 2] : [2],
                locator: 'Fictional page scope',
                status: 'pending',
                attempts: [],
              }));
            },
          );
          await buildIntakeCollectionEnvelope(db, { id: source.id });
          await prepareRetainedPlanAccess(db, profileId, source.id);
        } else {
          await buildIntakeCollectionEnvelope(db, { id: source.id });
          await createPagedDirectPlan(db, root, profileId, source.id, {
            version: source.version,
            operationId: 'fictional-first-flush-plan',
          });
        }
        const unitId =
          flushBoundary === 'legacy'
            ? readRetainedPlanScope(db, profileId, source.id)!.unitById(
                'fictional-first-flush-pdf',
              )!.id
            : readDirectPlanScope(db, profileId, source.id)!.unitAt(0)!.id;
        const sessionId = 'fictional-first-flush';
        if (imported)
          await importLegacyReadingCheckpoint(db, root, profileId, source.id, sessionId, {
            intakeId: source.id,
            profileId,
            sourceHash: source.sha256,
            version: intakeSourceVersion(db, source.id).version,
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
        const scope = openCollectionConversion(db, root, profileId, source.id, {
            sessionId,
            unitId,
          })!,
          checkpoint = createCollectionCheckpoint(scope),
          collections = selectedEnvelopeStore(db, { id: source.id }).collections,
          ledger = 'reading.' + scope.ledgerId,
          version = intakeSourceVersion(db, source.id).rawVersion,
          args =
            flushBoundary === 'legacy'
              ? { id: source.id, page: 2 }
              : { id: source.id, unitId, offset: 1, jsonPointer: '/fictional'.repeat(52) },
          result = {
            original: {
              literal: 'Fictional later literal.',
              offset: flushBoundary === 'legacy' ? 0 : 1,
              nextOffset: null,
              ...(flushBoundary === 'legacy' ? { page: 2 } : {}),
            },
          };
        await recordCollectionConversionRead(
          scope,
          checkpoint,
          'health_intake_read',
          flushBoundary === 'legacy' ? { id: source.id, page: 1 } : { id: source.id, unitId },
          {
            original: {
              literal: 'Fictional first literal.',
              offset: 0,
              nextOffset: null,
              ...(flushBoundary === 'legacy' ? { page: 1 } : {}),
            },
          },
        );
        const receipt = await deferCollectionConversionRead(
          scope,
          checkpoint,
          'health_intake_read',
          args,
          result,
        );
        assert.ok(receipt);
        const beforeRoot = collections.collection(collections.openView(), 'builds', ledger)!.root!
            .hash,
          beforeState = collections.get(collections.openView(), 'builds', ledger, 'state'),
          beforeReceipt = collections.get(
            collections.openView(),
            'builds',
            ledger,
            'deferred:' + receipt.key,
          ),
          beforeTotals = readCollectionConversionSessionTotals(db, profileId, source.id, sessionId),
          legacyName = legacyReadingSessionName(sessionId, source.id, source.sha256),
          legacyRoot = collections.collection(collections.openView(), 'builds', legacyName)?.root
            ?.hash,
          prefix = intakeNamespace(selectedEnvelopeStore(db, { id: source.id }).identity);
        const nativeBuilds = () => {
          const tree = createIntakeTree(
            selectedEnvelopeStore(db, { id: source.id }).identity,
            (hash) =>
              db.prepare('SELECT value FROM app_meta WHERE key=?').get(prefix + 'node:' + hash)
                ?.value,
            new Map(),
          );
          return [...tree.entries(collections.binding(collections.openView())!.builds)]
            .filter((item) =>
              item.key.startsWith(
                flushBoundary === 'legacy' ? 'reading.legacy.' : 'reading.build.',
              ),
            )
            .map((item) => item.key);
        };
        const oldBuilds = new Set(nativeBuilds());
        let stopped = false,
          publications = 0,
          mutatedRoot: string | undefined,
          mutationError: unknown,
          nativeFlush: string | undefined;
        const dispose = observeTransactionOutcome(db, (outcome) => {
          if (!outcome.succeeded || !outcome.intakeMaintenance) return;
          publications++;
          if (nativeFlush) return;
          const build = nativeBuilds().find((name) => !oldBuilds.has(name));
          if (!build) return;
          assert.equal(
            collections.get(
              collections.openView(),
              'builds',
              build,
              (flushBoundary === 'legacy' ? 'legacy.seen:' : 'seen:') + receipt.key,
            ),
            '1',
          );
          assert.notEqual(
            collections.collection(collections.openView(), 'builds', build)!.root!.hash,
            flushBoundary === 'legacy' ? legacyRoot : beforeRoot,
          );
          nativeFlush = build;
          queueMicrotask(() => {
            try {
              if (fault === 'cancellation') {
                stopped = true;
                mutatedRoot = beforeRoot;
                return;
              }
              if (fault === 'source-pin') {
                const pin = intakeSourceVersion(db, source.id).sourcePin;
                transaction(db, () =>
                  writeIntakeSourcePin(db, source.id, {
                    revisionId: pin?.revisionId ?? null,
                    dependencyToken: 'fictional independently revised source dependency',
                    requiresInterpretation: pin?.requiresInterpretation ?? false,
                    version: (pin?.version ?? 0) + 1,
                  }),
                );
                mutatedRoot = beforeRoot;
                return;
              }
              const operationId = randomUUID();
              collections.commitMaintenance(
                collections.prepare(collections.openView(), {
                  operationId,
                  requestDigest: createHash('sha256').update(operationId).digest('hex'),
                  domainVersion: version,
                  changes: [
                    {
                      area: 'builds',
                      collection: fault === 'legacy-root' ? legacyName : ledger,
                      op: 'put',
                      key: 'fictional.external-drift',
                      value: 'Fictional independently published change.',
                    },
                  ],
                }),
              );
              mutatedRoot = collections.collection(
                collections.openView(),
                'builds',
                fault === 'legacy-root' ? legacyName : ledger,
              )!.root!.hash;
            } catch (error) {
              mutationError = error;
            }
          });
        });
        t.after(dispose);
        await assert.rejects(
          acknowledgeCollectionConversionRead(scope, checkpoint, receipt.key, {
            assertRunning() {
              if (stopped) throw Error('Fictional first-flush cancellation');
            },
          }),
          fault === 'selected-root'
            ? /Reading ledger changed during preparation/
            : fault === 'legacy-root'
              ? /Imported reading session changed during acknowledgment/
              : fault === 'source-pin'
                ? { code: 'CONVERSION_CHANGED' }
                : /Fictional first-flush cancellation/,
        );
        dispose();
        assert.equal(mutationError, undefined);
        assert.ok(
          nativeFlush,
          'the acknowledgement, not the earlier eager legacy fork, published a native window',
        );
        assert.ok(mutatedRoot, 'the first real private flush yielded to the concurrent mutation');
        assert.equal(
          publications,
          1 + (fault === 'selected-root' || fault === 'legacy-root' ? 1 : 0),
          'no final reading selection publishes after the first-flush fault',
        );
        assert.equal(
          collections.collection(collections.openView(), 'builds', ledger)!.root!.hash,
          fault === 'legacy-root' ? beforeRoot : mutatedRoot,
          'refusal never selects the partially built candidate over the changed owner',
        );
        assert.equal(
          collections.get(collections.openView(), 'builds', ledger, 'state'),
          beforeState,
        );
        assert.equal(
          collections.get(collections.openView(), 'builds', ledger, 'deferred:' + receipt.key),
          beforeReceipt,
        );
        if (imported)
          assert.equal(
            collections.collection(collections.openView(), 'builds', legacyName)!.root!.hash,
            fault === 'legacy-root' ? mutatedRoot : legacyRoot,
          );
        const afterTotals = readCollectionConversionSessionTotals(
          db,
          profileId,
          source.id,
          sessionId,
        );
        if (fault === 'legacy-root') {
          const { binding: beforeBinding, ...beforeCounts } = beforeTotals,
            { binding: afterBinding, ...afterCounts } = afterTotals;
          assert.deepEqual(afterCounts, beforeCounts);
          assert.notEqual(
            afterBinding,
            beforeBinding,
            'the independent selected session mutation changes its binding, not its counts',
          );
        } else assert.deepEqual(afterTotals, beforeTotals);
        assert.throws(
          () =>
            assertCollectionConversionCoverage([scope], {
              planId: scope.planId,
              coverage: [{ unitId, kind: 'extracted', notes: 'Fictional withheld coverage' }],
            }),
          { code: fault === 'source-pin' ? 'CONVERSION_CHANGED' : 'CONVERSION_COVERAGE_PENDING' },
        );
      });

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
  const overflowSession = 'fictional-overflow-descendant',
    overflowScope = openCollectionConversion(db, root, profileId, parent.id, {
      sessionId: overflowSession,
    })!,
    overflowCapability = await prepareManualCollectionDescendantRead(overflowScope, child.id),
    collections = selectedEnvelopeStore(db, { id: parent.id }).collections,
    sequence = () => collections.binding(collections.openView())!.storageSequence,
    beforeOverflow = sequence(),
    mutated = Promise.withResolvers<void>();
  let mutationSequence: number | undefined;
  // 49 pointer segments produce 63 pending changes including state; three
  // selection changes overflow that final window without an earlier 64-flush.
  setImmediate(() => {
    try {
      mutationSequence = sequence();
      reparent();
      mutated.resolve();
    } catch (error) {
      mutated.reject(error);
    }
  });
  await assert.rejects(
    recordCollectionConversionRead(
      overflowScope,
      createCollectionCheckpoint(overflowScope),
      'health_intake_read',
      { id: child.id, offset: 1, jsonPointer: '/fictional'.repeat(49) },
      { original: { literal: 'Fictional descendant suffix.', offset: 1, nextOffset: null } },
      { descendantRead: overflowCapability },
    ),
    /does not belong|changed|source|evidence/i,
  );
  await mutated.promise;
  assert.equal(
    mutationSequence! - beforeOverflow,
    1,
    'mutation occurs after the real final overflow checkpoint',
  );
  assert.equal(
    readCollectionConversionSessionTotals(db, profileId, parent.id, overflowSession).seen,
    0,
    'the flushed private tail never becomes a selected descendant receipt',
  );
  writeIntakeFixtureEnvelope(db, child.id, original);
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
  let pageCheckpoints = 0;
  await recordCollectionConversionRead(
    scope,
    checkpoint,
    'health_intake_read',
    { id: source.id, page: 3 },
    result(3),
    {
      onCheckpoint: () => {
        pageCheckpoints++;
      },
    },
  );
  assert.equal(pageCheckpoints, 1, 'page rank does not require an intermediate publication');
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
  const reverse = openCollectionConversion(db, root, profileId, source.id, {
      sessionId: 'fictional-reverse-pages',
      unitId: 'page-unit',
    })!,
    reverseCheckpoint = createCollectionCheckpoint(reverse);
  for (const page of [7, 7, 3]) {
    await recordCollectionConversionRead(
      reverse,
      reverseCheckpoint,
      'health_intake_read',
      { id: source.id, page },
      result(page),
    );
    const pending = collectionConversionResumeContext(reverse, reverseCheckpoint, options);
    assert.equal(pending.pendingWindows.total, page === 3 ? 0 : 1);
    if (page === 7)
      assert.equal(
        'args' in pending.pendingWindows.items[0]! && pending.pendingWindows.items[0].args.page,
        3,
      );
    assert.equal(pending.reading.distinctReads, page === 3 ? 2 : 1);
  }
  const wide = openCollectionConversion(db, root, profileId, source.id, {
      sessionId: 'fictional-full-page-window',
      unitId: 'page-unit',
    })!,
    wideCheckpoint = createCollectionCheckpoint(wide),
    wideArgs = { id: source.id, page: 7, jsonPointer: '/fictional'.repeat(52) };
  await deferCollectionConversionRead(
    wide,
    wideCheckpoint,
    'health_intake_read',
    wideArgs,
    result(7),
  );
  let wideCheckpoints = 0;
  await recordCollectionConversionRead(
    wide,
    wideCheckpoint,
    'health_intake_read',
    wideArgs,
    result(7),
    {
      onCheckpoint: () => {
        wideCheckpoints++;
      },
    },
  );
  assert.equal(
    wideCheckpoints,
    2,
    'the pending index removals fill a writer window before finishing',
  );
  const widePending = collectionConversionResumeContext(wide, wideCheckpoint, options);
  assert.equal(
    widePending.pendingWindows.total,
    1,
    'a committed current page is not counted twice',
  );
  assert.equal(
    'args' in widePending.pendingWindows.items[0]! && widePending.pendingWindows.items[0].args.page,
    3,
  );
  for (const imported of [false, true]) {
    const sessionId = imported
      ? 'fictional-imported-adopting-full-page-window'
      : 'fictional-adopting-full-page-window';
    if (imported)
      await importLegacyReadingCheckpoint(db, root, profileId, source.id, sessionId, {
        intakeId: source.id,
        profileId,
        sourceHash: source.sha256,
        version: intakeSourceVersion(db, source.id).version,
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
    const adoptingWide = openCollectionConversion(db, root, profileId, source.id, {
        sessionId,
        unitId: 'page-unit',
      })!,
      adoptingWideCheckpoint = createCollectionCheckpoint(adoptingWide);
    await deferCollectionConversionRead(
      adoptingWide,
      adoptingWideCheckpoint,
      'health_intake_read',
      wideArgs,
      result(7),
    );
    const beforeAdoptingWide = selectedEnvelopeStore(db, { id: source.id }).collections.binding(
      selectedEnvelopeStore(db, { id: source.id }).collections.openView(),
    )!.storageSequence;
    await recordCollectionConversionRead(
      adoptingWide,
      adoptingWideCheckpoint,
      'health_intake_read',
      wideArgs,
      result(7),
    );
    const afterAdoptingWide = selectedEnvelopeStore(db, { id: source.id }).collections.binding(
      selectedEnvelopeStore(db, { id: source.id }).collections.openView(),
    )!.storageSequence;
    assert.ok(
      afterAdoptingWide - beforeAdoptingWide >= 2,
      'the adopting no-hook path crosses a real full-window flush before final selection',
    );
    const adoptingPending = collectionConversionResumeContext(
      adoptingWide,
      adoptingWideCheckpoint,
      options,
    );
    assert.equal(adoptingPending.pendingWindows.total, 1);
    assert.equal(
      'args' in adoptingPending.pendingWindows.items[0]! &&
        adoptingPending.pendingWindows.items[0].args.page,
      3,
    );
    assert.equal(adoptingPending.reading.distinctReads, 1, 'a flushed page is never counted twice');
    await recordCollectionConversionRead(
      adoptingWide,
      adoptingWideCheckpoint,
      'health_intake_read',
      { ...wideArgs, page: 3 },
      result(3),
    );
    assert.equal(
      collectionConversionResumeContext(adoptingWide, adoptingWideCheckpoint, options)
        .pendingWindows.total,
      0,
    );
    assertCollectionConversionCoverage([adoptingWide], {
      planId,
      coverage: [
        { unitId: adoptingWide.unitId, kind: 'extracted', notes: 'Fictional exact pages' },
      ],
    });
  }
  const interrupted = openCollectionConversion(db, root, profileId, source.id, {
      sessionId: 'fictional-interrupted-page',
      unitId: 'page-unit',
    })!,
    interruptedCheckpoint = createCollectionCheckpoint(interrupted);
  let stopped = false;
  await assert.rejects(
    recordCollectionConversionRead(
      interrupted,
      interruptedCheckpoint,
      'health_intake_read',
      { id: source.id, page: 3 },
      result(3),
      {
        assertRunning() {
          if (stopped) throw Error('Fictional page read stopped');
        },
        onCheckpoint() {
          stopped = true;
        },
      },
    ),
    /Fictional page read stopped/,
  );
  assert.ok(stopped);
  assert.equal(
    collectionConversionResumeContext(interrupted, interruptedCheckpoint, options).reading
      .distinctReads,
    0,
  );
  assert.throws(
    () =>
      assertCollectionConversionCoverage([interrupted], {
        planId,
        coverage: [{ unitId: interrupted.unitId, kind: 'extracted', notes: 'Fictional' }],
      }),
    { code: 'CONVERSION_COVERAGE_PENDING' },
  );
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
