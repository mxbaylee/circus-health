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
  const firstFactory = createOwnershipSourceSnapshotPreparation(db, source),
    first = await prepareOwnershipIdentityIssueSnapshot(firstFactory, () => values);
  assert.equal(ownershipIdentityIssueIncluded(db, first, values[0]!), true);
  assert.equal(ownershipIdentityIssueIncluded(db, first, values.at(-1)!), true);
  assert.equal(ownershipIdentityIssueIncluded(db, first, 'f'.repeat(64)), false);
  const nextFactory = createOwnershipSourceSnapshotPreparation(db, source),
    next = await prepareOwnershipIdentityIssueSnapshot(
      nextFactory,
      () => [...values.slice(1), 'f'.repeat(64)],
      first,
    );

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

test('prepared ownership issue evidence stays inert and report defaults include only exact report occurrences', async (t) => {
  const { prepareOwnershipIdentitySnapshots } = await import('../ownership-identity-snapshots.ts');
  const { ownershipIdentityIssues } = await import('../record-ownership-authority.ts');
  const { clinicalReviewRevision } = await import('../database.ts');
  const { selectedEnvelopeStore } = await import('../intake-collection-envelope.ts');
  const root = mkdtempSync(join(tmpdir(), 'fictional-report-identity-union-')),
    db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const id of ['selected-original', 'other-original']) {
    registerRawIntakeFixture(db, id, JSON.stringify({ intake: { version: 1 } }));
    await buildIntakeCollectionEnvelope(db, { id });
  }
  const selected = {
    id: 'selected-record',
    issues: [
      {
        id: 'one',
        kind: 'identity',
        prompt: 'Selected report question',
        textAnchor: 'Selected report anchor',
      },
    ],
  } as import('../../shared/intake.ts').IntakeReviewRecord;
  const other = {
    id: 'other-record',
    issues: [
      {
        id: 'two',
        kind: 'identity',
        prompt: 'Other original question',
        textAnchor: 'Other original anchor',
      },
    ],
  } as import('../../shared/intake.ts').IntakeReviewRecord;
  const revision = clinicalReviewRevision(db),
    logical = selectedEnvelopeStore(db, { id: 'selected-original' }).collections.binding(
      selectedEnvelopeStore(db, { id: 'selected-original' }).collections.openView(),
    )!.logical;
  const plan = await prepareOwnershipIdentitySnapshots(db, db, {
    sources: [
      { intakeId: 'selected-original', recordId: selected.id },
      { intakeId: 'other-original', recordId: other.id },
      { intakeId: 'selected-original', recordId: selected.id, reportMember: true },
    ],
    record(_id, recordId) {
      return recordId === selected.id ? selected : other;
    },
    factory(id) {
      return createOwnershipSourceSnapshotPreparation(db, { id });
    },
    report: { intakeId: 'selected-original', groupId: 'selected-group' },
  });
  plan.assertCurrent();
  assert.deepEqual(readOwnershipSourceSnapshot(db, plan.forReport().snapshot).sourceRecordIds, [
    ...ownershipIdentityIssues(selected),
  ]);
  assert.deepEqual(
    readOwnershipSourceSnapshot(db, plan.forSource('other-original', other.id).snapshot)
      .sourceRecordIds,
    [...ownershipIdentityIssues(other)],
  );
  assert.equal(clinicalReviewRevision(db), revision);
  const current = selectedEnvelopeStore(db, { id: 'selected-original' });
  assert.deepEqual(current.collections.binding(current.collections.openView())!.logical, logical);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM manual_batches WHERE title IN ('Report ownership default','Record ownership source')",
      )
      .get()!.n,
    0,
  );
  clearIntakeStateCache(db);
  plan.assertCurrent();
  // The immutable bytes alone do not authorize a receipt after catalog churn.
  const removed = selectedEnvelopeStore(db, { id: 'selected-original' }),
    view = removed.collections.openView(),
    operationId = '11af5185-3fbf-41c4-886c-1bf82fbb707c';
  const prepared = removed.collections.prepare(view, {
    operationId,
    requestDigest: 'a'.repeat(64),
    domainVersion: removed.collections.binding(view)!.logical.domainVersion,
    changes: [
      {
        area: 'builds',
        collection: 'ownership.snapshots',
        op: 'delete',
        key: plan.forReport().snapshot.snapshotId,
      },
    ],
  });
  try {
    removed.collections.commitMaintenance(prepared);
  } finally {
    removed.collections.disposePreparation(prepared);
  }
  assert.equal(clinicalReviewRevision(db), revision);
  assert.throws(() => plan.assertCurrent(), /retained authority/);
  // A physical-source change also invalidates its own exact snapshot.
  db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('f'.repeat(64), 'other-original');
  assert.throws(() =>
    readOwnershipSourceSnapshot(db, plan.forSource('other-original', other.id).snapshot),
  );
});

test('cancellation across originals leaves only inert prepared ownership evidence', async (t) => {
  const { prepareOwnershipIdentitySnapshots } = await import('../ownership-identity-snapshots.ts');
  const { selectedEnvelopeStore } = await import('../intake-collection-envelope.ts');
  const root = mkdtempSync(join(tmpdir(), 'fictional-canceled-ownership-')),
    db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const id of ['first-original', 'second-original']) {
    registerRawIntakeFixture(db, id, JSON.stringify({ intake: { version: 1 } }));
    await buildIntakeCollectionEnvelope(db, { id });
  }
  const revision = clinicalReviewRevision(db),
    first = selectedEnvelopeStore(db, { id: 'first-original' }),
    logical = first.collections.binding(first.collections.openView())!.logical;
  let factories = 0;
  await assert.rejects(
    prepareOwnershipIdentitySnapshots(db, db, {
      sources: [
        { intakeId: 'first-original', recordId: 'first' },
        { intakeId: 'second-original', recordId: 'second' },
      ],
      record(_id, id) {
        return { id, issues: [] } as unknown as import('../../shared/intake.ts').IntakeReviewRecord;
      },
      factory(id) {
        factories++;
        return createOwnershipSourceSnapshotPreparation(
          db,
          { id },
          {
            assertRunning() {
              if (factories === 2) throw Error('Fictional canceled preparation');
            },
          },
        );
      },
    }),
    /Fictional canceled preparation/,
  );
  assert.equal(clinicalReviewRevision(db), revision);
  const current = selectedEnvelopeStore(db, { id: 'first-original' });
  assert.deepEqual(current.collections.binding(current.collections.openView())!.logical, logical);
  const retained = JSON.parse(
    String(
      db
        .prepare('SELECT value FROM ownership_identity_snapshots WHERE intake=?')
        .get('first-original')!.value,
    ),
  );
  assert.equal(readOwnershipSourceSnapshot(db, retained.snapshot).count, 0);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM manual_batches WHERE title IN ('Record ownership source','Report ownership default')",
      )
      .get()!.n,
    0,
  );
});
