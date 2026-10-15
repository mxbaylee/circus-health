import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, clinicalReviewRevision, HttpError } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, intakeTransaction } from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { createPagedPackagePlan, readPackagePlanScope } from '../intake-package-plan.ts';
import {
  preparePagedPackageBatch,
  nextPendingPagedPackageUnit,
  type PagedPackageBatchInput,
} from '../intake-package-batch.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { clearPackageSourceSession } from '../intake-package-session.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  setCollectionProcessingException,
  clearCollectionProcessingExceptions,
} from '../intake-processing-exceptions.ts';
import { decisionIndexCount } from '../intake-reading-state.ts';

async function fixture(t: test.TestContext, count = 92) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-package-batch-')),
    profileId = 'cookie-dough',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearPackageSourceSession(db);
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.zip',
    newProviderName: 'Fictional collection',
    bytes: zipFixture(
      Array.from({ length: count }, (_, ordinal) => ({
        name: `fictional-${ordinal}.txt`,
        data: 'fictional',
      })),
    ),
  });
  const plan = await createPagedPackagePlan(db, root, profileId, intake.id, {
    version: intake.version,
    operationId: 'create-fictional-plan',
  });
  return { db, root, profileId, id: intake.id, plan };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function input(
  f: Fixture,
  ordinals: number[],
  kind: 'inspected' | 'extracted' | 'context' | 'unreadable' = 'context',
): PagedPackageBatchInput {
  const scope = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!,
    operationId = randomUUID();
  return {
    version: scope.version,
    planId: scope.planId,
    operationId,
    fingerprint: createHash('sha256').update(operationId).digest('hex'),
    proposalId: 'proposal:' + createHash('sha256').update(operationId).digest('hex'),
    createdAt: '2026-10-03T00:00:00.000Z',
    coverage: ordinals.map((ordinal) => ({
      unitId: scope.unit(scope.inventory.member(ordinal)!.memberId)!.id,
      kind,
      notes: 'Fictional scoped observation',
    })),
  };
}
/** Exercise the prepared participant with an addressed proposal header in one
 * transaction. Full clinical proposal integration has its own host tests. */
async function publish(f: Fixture, request: PagedPackageBatchInput, fail = false) {
  const participant = await preparePagedPackageBatch(f.db, f.root, f.profileId, f.id, request);
  assert.equal(participant.replayed, false);
  if (participant.replayed) throw Error('Unexpected replay in publication fixture');
  const file = f.db
      .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
      .get(f.id)!,
    view = openIntakeCollectionEnvelope(f.db, file as never),
    operationId = randomUUID();
  const prepared = await prepareIntakeEnvelopeMutation(f.db, file as never, {
    reader: view,
    operationId,
    requestDigest: request.fingerprint,
    domainVersion: participant.domainVersion + 1,
    assertRunning: participant.assertCurrent,
    additionalLogicalChanges: participant.compose.additionalLogicalChanges,
    changes: function* (staged) {
      const intake = staged.child(staged.root(), 'intake')!;
      yield {
        op: 'append' as const,
        record: intake,
        field: 'proposals',
        jsonText: JSON.stringify({
          id: request.proposalId,
          summary: 'Fictional integration participant',
        }),
      };
      yield* participant.compose.changes(staged);
    },
  });
  intakeTransaction(
    f.db,
    () => {
      participant.assertCurrent();
      selectedEnvelopeStore(f.db, file as never).collections.stage(prepared.prepared!);
      if (fail) throw Error('fictional final transaction failure');
    },
    { operationId, fingerprint: request.fingerprint },
  );
}

test('batch coverage preserves selected exception catalogs and disjoint reading accounting on terminal and reopened units', async (t) => {
  const f = await fixture(t, 2),
    initial = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!;
  const unitId = initial.unit(initial.inventory.member(0)!.memberId)!.id;
  await setCollectionProcessingException(f.db, f.root, f.profileId, f.id, {
    version: initial.version,
    operationId: 'stall-catalog',
    unitId,
    exception: { reason: 'processing_stalled', at: '2026-10-03T00:00:00Z' },
  });
  const count = (kind: 'readingSkipped' | 'accounted') => {
    const scope = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!;
    return decisionIndexCount(
      selectedEnvelopeStore(f.db, { id: f.id }).collections,
      scope.decisionIndex(kind),
    );
  };
  assert.equal(count('readingSkipped'), 1);
  await publish(f, input(f, [0], 'context'));
  clearIntakeStateCache(f.db);
  assert.equal(count('readingSkipped'), 0);
  assert.equal(count('accounted'), 1);
  assert.ok(
    readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.unitById(unitId)!.processingException,
  );
  await publish(f, input(f, [0], 'inspected'));
  assert.equal(count('readingSkipped'), 1);
  assert.equal(count('accounted'), 0);
  await clearCollectionProcessingExceptions(f.db, f.root, f.profileId, f.id, {
    version: intakeSourceVersion(f.db, f.id).version,
    operationId: 'retry-catalog',
  });
  assert.equal(count('readingSkipped'), 0);
  assert.equal(nextPendingPagedPackageUnit(f.db, f.root, f.profileId, f.id)!.id, unitId);
});

test('batch progress publishes atomically, counts exact attempts, replays and reopens inspected units', async (t) => {
  const f = await fixture(t),
    request = input(
      f,
      Array.from({ length: 50 }, (_, n) => n),
    ),
    version = intakeSourceVersion(f.db, f.id),
    revision = clinicalReviewRevision(f.db);
  const abandoned = await preparePagedPackageBatch(f.db, f.root, f.profileId, f.id, request);
  assert.equal(abandoned.replayed, false);
  assert.deepEqual(intakeSourceVersion(f.db, f.id), version);
  assert.equal(clinicalReviewRevision(f.db), revision);
  assert.equal(
    nextPendingPagedPackageUnit(f.db, f.root, f.profileId, f.id)!.id,
    request.coverage[0]!.unitId,
  );
  await assert.rejects(publish(f, request, true), /fictional final transaction failure/);
  assert.deepEqual(intakeSourceVersion(f.db, f.id), version);
  assert.equal(
    readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.unitById(request.coverage[0]!.unitId)!
      .attemptCount,
    0,
  );
  await publish(f, request);
  clearIntakeStateCache(f.db);
  const before = intakeWorkCounters(f.db),
    scope = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!;
  assert.equal(
    nextPendingPagedPackageUnit(f.db, f.root, f.profileId, f.id)!.id,
    scope.unit(scope.inventory.member(50)!.memberId)!.id,
  );
  assert.equal(scope.unitById(request.coverage[49]!.unitId)!.attemptCount, 1);
  assert.equal(scope.accountedKind(request.coverage[49]!.unitId), 'context');
  const replay = await preparePagedPackageBatch(f.db, f.root, f.profileId, f.id, request);
  assert.equal(replay.replayed, true);
  const after = intakeWorkCounters(f.db);
  assert.equal(after.warm.collectionNodesWritten, before.warm.collectionNodesWritten);
  assert.equal(after.warm.envelopeHydrations, before.warm.envelopeHydrations);
  await publish(f, input(f, [3], 'inspected'));
  const current = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!;
  assert.equal(
    nextPendingPagedPackageUnit(f.db, f.root, f.profileId, f.id)!.id,
    current.unit(current.inventory.member(3)!.memberId)!.id,
  );
  assert.equal(current.unit(current.inventory.member(3)!.memberId)!.attemptCount, 2);
  assert.equal(current.accountedKind(request.coverage[3]!.unitId), null);
  await assert.rejects(
    preparePagedPackageBatch(f.db, f.root, f.profileId, f.id, {
      ...request,
      fingerprint: 'a'.repeat(64),
    }),
    (error: unknown) => error instanceof HttpError && error.code === 'OPERATION_CONFLICT',
  );
});

test('cancellation and invalid coverage cannot select partial checkpoints', async (t) => {
  const f = await fixture(t, 6),
    request = input(f, [0, 1]),
    version = intakeSourceVersion(f.db, f.id);
  const cancellation = Error('fictional cancellation');
  await assert.rejects(
    preparePagedPackageBatch(f.db, f.root, f.profileId, f.id, {
      ...request,
      onCheckpoint() {
        throw cancellation;
      },
    }),
    (error: unknown) => error === cancellation,
  );
  assert.deepEqual(intakeSourceVersion(f.db, f.id), version);
  assert.equal(
    nextPendingPagedPackageUnit(f.db, f.root, f.profileId, f.id)!.id,
    request.coverage[0]!.unitId,
  );
  const before = intakeWorkCounters(f.db);
  for (const coverage of [
    [],
    [request.coverage[0]!, request.coverage[0]!],
    [{ ...request.coverage[0]!, unitId: 'unit:' + 'f'.repeat(64) }],
  ])
    await assert.rejects(
      preparePagedPackageBatch(f.db, f.root, f.profileId, f.id, { ...request, coverage }),
      (error: unknown) => error instanceof HttpError && error.code === 'BATCH_COVERAGE',
    );
  assert.equal(
    intakeWorkCounters(f.db).warm.collectionNodesWritten,
    before.warm.collectionNodesWritten,
  );
  await publish(f, input(f, [0, 1, 2, 3, 4, 5], 'unreadable'));
  assert.equal(nextPendingPagedPackageUnit(f.db, f.root, f.profileId, f.id), undefined);
});
