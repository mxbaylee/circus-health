import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction, clinicalReviewRevision } from '../database.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import {
  createOwnershipSourceSnapshotPreparation,
  readOwnershipSourceSnapshot,
} from '../ownership-source-snapshots.ts';

test('ownership split snapshots fork changed membership, compose same-custodian rows and refuse racing catalogs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-ownership-snapshot-')),
    db = openDatabase(join(root, 'cache.sqlite'), 'fictional'),
    authority = memoryRecordAuthority(db),
    source = { id: 'fictional-original' };
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  registerRawIntakeFixture(db, source.id, JSON.stringify({ intake: { version: 1 } }));
  await buildIntakeCollectionEnvelope(db, source);
  const sourceRecordIds = Array.from(
    { length: 128 },
    (_, i) => 'fictional-' + String(i).padStart(4, '0'),
  );
  const publish = async (builder: ReturnType<typeof createOwnershipSourceSnapshotPreparation>) => {
    const prepared = await builder.finish();
    try {
      transaction(db, () => prepared.apply());
    } finally {
      prepared.dispose();
    }
  };
  const initial = createOwnershipSourceSnapshotPreparation(db, source),
    first = await initial.prepareSplit({
      sourceRecordIds: () => sourceRecordIds,
      movingSourceRecordIds: () => [sourceRecordIds[0]!],
    });
  const version = intakeSourceVersion(db, source.id).version;
  await publish(initial);
  assert.equal(intakeSourceVersion(db, source.id).version, version);
  assert.deepEqual(readOwnershipSourceSnapshot(db, first.moving).sourceRecordIds, [
    sourceRecordIds[0],
  ]);
  const oldObjects = new Set(authority.objects.keys()),
    clinical = clinicalReviewRevision(db),
    next = createOwnershipSourceSnapshotPreparation(db, source),
    currentIds = [...sourceRecordIds.slice(2), 'fictional-new'],
    second = await next.prepareSplit({
      previous: first.remaining,
      sourceRecordIds: () => currentIds,
      movingSourceRecordIds: () => [sourceRecordIds[2]!, 'fictional-new'],
    }),
    other = await next.prepareSplit({
      sourceRecordIds: () => ['other-a', 'other-b'],
      movingSourceRecordIds: () => ['other-a'],
    });
  await publish(next);
  assert.equal(clinicalReviewRevision(db), clinical + 1);
  assert.equal(intakeSourceVersion(db, source.id).version, version);
  const addedBytes = [...authority.objects]
    .filter(([id]) => !oldObjects.has(id))
    .reduce((sum, [, bytes]) => sum + bytes.length, 0);
  assert.ok(addedBytes < 2 * 1024 * 1024);
  clearIntakeStateCache(db);
  const exact: string[] = [];
  let after: string | undefined;
  do {
    const page = readOwnershipSourceSnapshot(db, second.remaining, { after, limit: 7 });
    exact.push(...page.sourceRecordIds);
    if (page.complete) break;
    after = page.after!;
  } while (true);
  assert.deepEqual(exact, sourceRecordIds.slice(3));
  assert.deepEqual(readOwnershipSourceSnapshot(db, second.moving).sourceRecordIds, [
    sourceRecordIds[2],
    'fictional-new',
  ]);
  assert.deepEqual(readOwnershipSourceSnapshot(db, other.remaining).sourceRecordIds, ['other-b']);
  assert.equal(readOwnershipSourceSnapshot(db, first.remaining).count, 127);
  assert.throws(() =>
    readOwnershipSourceSnapshot(db, { ...first.remaining, digest: '0'.repeat(64) }),
  );
  const raceA = createOwnershipSourceSnapshotPreparation(db, source),
    raceB = createOwnershipSourceSnapshotPreparation(db, source);
  await raceA.prepareSplit({ sourceRecordIds: () => ['a'], movingSourceRecordIds: () => [] });
  await raceB.prepareSplit({ sourceRecordIds: () => ['b'], movingSourceRecordIds: () => [] });
  const preparedA = await raceA.finish(),
    preparedB = await raceB.finish();
  try {
    transaction(db, () => preparedA.apply());
    assert.throws(
      () => transaction(db, () => preparedB.apply()),
      /Stale report snapshot|evidence changed/,
    );
  } finally {
    preparedA.dispose();
    preparedB.dispose();
  }
});

test('reviewed identity issue snapshots retain exact membership through changed sets and cache loss', async (t) => {
  const { prepareOwnershipIdentityIssueSnapshot, ownershipIdentityIssueIncluded } =
    await import('../ownership-identity-snapshots.ts');
  const root = mkdtempSync(join(tmpdir(), 'fictional-identity-issue-snapshot-')),
    db = openDatabase(join(root, 'cache.sqlite'), 'fictional'),
    source = { id: 'fictional-identity-original' };
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  registerRawIntakeFixture(db, source.id, JSON.stringify({ intake: { version: 1 } }));
  await buildIntakeCollectionEnvelope(db, source);
  const values = Array.from({ length: 180 }, (_, index) => index.toString(16).padStart(64, '0'));
  const publish = async (factory: ReturnType<typeof createOwnershipSourceSnapshotPreparation>) => {
    const stage = await factory.finish();
    try {
      transaction(db, () => stage.apply());
    } finally {
      stage.dispose();
    }
  };
  const firstFactory = createOwnershipSourceSnapshotPreparation(db, source),
    first = await prepareOwnershipIdentityIssueSnapshot(firstFactory, () => values);
  assert.throws(() => ownershipIdentityIssueIncluded(db, first, values[0]!));
  await publish(firstFactory);
  assert.equal(ownershipIdentityIssueIncluded(db, first, values.at(-1)!), true);
  assert.equal(ownershipIdentityIssueIncluded(db, first, 'f'.repeat(64)), false);
  const nextFactory = createOwnershipSourceSnapshotPreparation(db, source),
    next = await prepareOwnershipIdentityIssueSnapshot(
      nextFactory,
      () => [...values.slice(1), 'f'.repeat(64)],
      first,
    );
  await publish(nextFactory);
  clearIntakeStateCache(db);
  assert.equal(ownershipIdentityIssueIncluded(db, next, values[0]!), false);
  assert.equal(ownershipIdentityIssueIncluded(db, next, values.at(-1)!), true);
  assert.equal(ownershipIdentityIssueIncluded(db, next, 'f'.repeat(64)), true);
  assert.equal(ownershipIdentityIssueIncluded(db, first, values[0]!), true);
  assert.throws(() =>
    ownershipIdentityIssueIncluded(
      db,
      { ...next, snapshot: { ...next.snapshot, digest: '0'.repeat(64) } },
      values[1]!,
    ),
  );
});
