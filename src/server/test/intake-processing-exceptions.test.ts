import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, createIntakePlan, workflowMutation } from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { createPagedPackagePlan, readPackagePlanScope } from '../intake-package-plan.ts';
import { nextPendingPagedPackageUnit } from '../intake-package-batch.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { clearPackageSourceSession } from '../intake-package-session.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { prepareCollectionWorkflowReadiness } from '../intake-workflow-readiness.ts';
import { readVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import {
  setCollectionProcessingException,
  clearCollectionProcessingExceptions,
  clearCollectionProcessingException,
} from '../intake-processing-exceptions.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareRetainedPlanAccess, readRetainedPlanScope } from '../intake-retained-plan.ts';
import { decisionIndexCount } from '../intake-reading-state.ts';

function fixture(t: test.TestContext) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-exceptions-')),
    profileId = 'fictional';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearPackageSourceSession(db);
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, root, profileId };
}
test('native reading exceptions select sparse state atomically, replay, and clear without changing extraction coverage', async (t) => {
  const { db, root, profileId } = fixture(t);
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional.zip',
    bytes: zipFixture([
      { name: 'a.txt', data: 'Fictional A' },
      { name: 'b.txt', data: 'Fictional B' },
    ]),
  });
  const planned = await createPagedPackagePlan(db, root, profileId, source.id, {
    version: source.version,
    operationId: 'plan',
  });
  const options = { mappingVersion: planned.plan.pins.mappingVersion };
  await prepareCollectionWorkflowReadiness(db, root, profileId, source.id, options);
  const initial = readPackagePlanScope(db, root, profileId, source.id)!,
    member = initial.inventory.member(0)!,
    unitId = initial.unit(member.memberId)!.id;
  const counters = { ...intakeWorkCounters(db).warm };
  const input = {
    version: planned.version,
    operationId: 'stall',
    unitId,
    exception: { reason: 'processing_stalled' as const, at: '2026-10-03T00:00:00Z' },
  };
  await setCollectionProcessingException(db, root, profileId, source.id, input);
  clearIntakeStateCache(db);
  const selected = readPackagePlanScope(db, root, profileId, source.id)!;
  assert.equal(selected.unitById(unitId)!.processingException?.reason, 'processing_stalled');
  assert.equal(selected.accountedKind(unitId), null);
  assert.notEqual(nextPendingPagedPackageUnit(db, root, profileId, source.id)?.id, unitId);
  assert.equal(
    readVerifiedWorkflowSummary(db, { id: source.id }, options).counts?.pendingWorkCount,
    2,
  );
  const version = intakeSourceVersion(db, source.id).version;
  await setCollectionProcessingException(db, root, profileId, source.id, {
    ...input,
    exception: { ...input.exception, at: '2026-10-04T00:00:00Z' },
  });
  assert.equal(intakeSourceVersion(db, source.id).version, version);
  await assert.rejects(
    clearCollectionProcessingExceptions(db, root, profileId, source.id, {
      version,
      operationId: 'clear',
      onCheckpoint() {
        throw Error('fictional cancellation');
      },
    }),
    /fictional cancellation/,
  );
  assert.ok(
    readPackagePlanScope(db, root, profileId, source.id)!.unitById(unitId)!.processingException,
  );
  await clearCollectionProcessingExceptions(db, root, profileId, source.id, {
    version,
    operationId: 'clear',
  });
  clearIntakeStateCache(db);
  assert.equal(
    readPackagePlanScope(db, root, profileId, source.id)!.unitById(unitId)!.processingException,
    undefined,
  );
  assert.equal(nextPendingPagedPackageUnit(db, root, profileId, source.id)?.id, unitId);
  assert.equal(intakeSourceVersion(db, source.id).version, version + 1);
  assert.equal(
    readVerifiedWorkflowSummary(db, { id: source.id }, options).counts?.pendingWorkCount,
    2,
  );
  for (const name of ['materializationReads', 'sourceDTOHydrations', 'envelopeHydrations'] as const)
    assert.equal(intakeWorkCounters(db).warm[name], counters[name]);
});

test('scoped processing retry preserves another stalled unit and exact replay through cache loss', async (t) => {
  const { db, root, profileId } = fixture(t);
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-scoped-retry.zip',
    bytes: zipFixture([
      { name: 'a.txt', data: 'Fictional A' },
      { name: 'b.txt', data: 'Fictional B' },
    ]),
  });
  const planned = await createPagedPackagePlan(db, root, profileId, source.id, {
    version: source.version,
    operationId: 'scoped-plan',
  });
  await prepareCollectionWorkflowReadiness(db, root, profileId, source.id, {
    mappingVersion: planned.plan.pins.mappingVersion,
  });
  const initial = readPackagePlanScope(db, root, profileId, source.id)!,
    unitIds = [0, 1].map(
      (ordinal) => initial.unit(initial.inventory.member(ordinal)!.memberId)!.id,
    );
  for (const unitId of unitIds)
    await setCollectionProcessingException(db, root, profileId, source.id, {
      version: intakeSourceVersion(db, source.id).version,
      operationId: 'stall:' + unitId,
      unitId,
      exception: { reason: 'processing_stalled', at: '2026-10-04T00:00:00Z' },
    });
  const version = intakeSourceVersion(db, source.id).version,
    retry = { version, operationId: 'scoped-retry', unitId: unitIds[0]! };
  await assert.rejects(
    clearCollectionProcessingException(db, root, profileId, source.id, {
      ...retry,
      onCheckpoint() {
        throw Error('fictional scoped cancellation');
      },
    }),
    /fictional scoped cancellation/,
  );
  assert.equal(intakeSourceVersion(db, source.id).version, version);
  for (const unitId of unitIds)
    assert.ok(
      readPackagePlanScope(db, root, profileId, source.id)!.unitById(unitId)!.processingException,
    );
  await clearCollectionProcessingException(db, root, profileId, source.id, retry);
  clearIntakeStateCache(db);
  const selected = readPackagePlanScope(db, root, profileId, source.id)!;
  assert.equal(selected.unitById(unitIds[0]!)!.processingException, undefined);
  assert.equal(selected.unitById(unitIds[1]!)!.processingException?.reason, 'processing_stalled');
  for (const unitId of unitIds) assert.equal(selected.accountedKind(unitId), null);
  assert.equal(nextPendingPagedPackageUnit(db, root, profileId, source.id)?.id, unitIds[0]);
  await clearCollectionProcessingException(db, root, profileId, source.id, retry);
  assert.equal(intakeSourceVersion(db, source.id).version, version + 1);
  await assert.rejects(
    clearCollectionProcessingException(db, root, profileId, source.id, {
      ...retry,
      unitId: unitIds[1]!,
    }),
    { code: 'OPERATION_CONFLICT' },
  );
  assert.ok(
    readPackagePlanScope(db, root, profileId, source.id)!.unitById(unitIds[1]!)!
      .processingException,
  );
});

// Host-only preparation and atomic retry of 65 retained plans, then cache-loss
// verification of every unit; the exact plan count and one-version oracle remain below.
test(
  'explicit retry clears more than 64 active retained plans through one selected catalog and one version',
  { timeout: 300_000 },
  async (t) => {
    const { db, root, profileId } = fixture(t);
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional.txt',
      bytes: Buffer.from('Fictional retained source.'),
    });
    const planned = await createIntakePlan(db, root, profileId, source.id, {
      version: source.version,
    });
    workflowMutation(
      db,
      root,
      profileId,
      source.id,
      { version: planned.version, operationId: 'many-plans' },
      (workflow) => {
        const plan = workflow.plans[0]!;
        workflow.plans = Array.from({ length: 65 }, (_, i) => ({
          ...structuredClone(plan),
          id: 'plan-' + i,
          units: [
            {
              id: 'unit-' + i,
              kind: 'text',
              locator: 'Fictional source',
              status: 'pending',
              attempts: [],
              processingException: { reason: 'processing_stalled', at: '2026-10-03T00:00:00Z' },
            },
          ],
        }));
      },
    );
    await buildIntakeCollectionEnvelope(db, { id: source.id });
    await prepareRetainedPlanAccess(db, profileId, source.id);
    const version = intakeSourceVersion(db, source.id).version;
    await clearCollectionProcessingExceptions(db, root, profileId, source.id, {
      version,
      operationId: 'retry-all',
    });
    clearIntakeStateCache(db);
    const view = openIntakeCollectionEnvelope(db, { id: source.id }),
      flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!;
    const collections = selectedEnvelopeStore(db, { id: source.id }).collections;
    assert.equal(view.childCount(flow, 'plans'), 65);
    for (let i = 0; i < 65; i++) {
      const scope = readRetainedPlanScope(db, profileId, source.id, { planId: 'plan-' + i })!;
      assert.equal(scope.unitById('unit-' + i)!.processingException, false);
      assert.equal(decisionIndexCount(collections, scope.decisionIndex('readingSkipped')), 0);
    }
    assert.equal(intakeSourceVersion(db, source.id).version, version + 1);
  },
);
