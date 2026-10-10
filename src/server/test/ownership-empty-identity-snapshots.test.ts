import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { IntakeReviewRecord } from '../../shared/intake.ts';
import { openDatabase, transaction } from '../database.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { appendOwnershipDecision } from '../ownership-journal.ts';
import { prepareOwnershipIdentitySnapshots } from '../ownership-identity-snapshots.ts';
import {
  createOwnershipSourceSnapshotPreparation,
  readOwnershipSourceSnapshot,
} from '../ownership-source-snapshots.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-empty-ownership-')),
    db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const id of ['first', 'second']) {
    registerRawIntakeFixture(db, id, JSON.stringify({ intake: { version: 1 } }));
    await buildIntakeCollectionEnvelope(db, { id });
  }
  return db;
}
const record = (id: string, nonempty = false) =>
  ({
    id,
    issues: nonempty
      ? [
          {
            id: 'question',
            kind: 'identity',
            prompt: 'Fictional identity question',
            textAnchor: 'Fictional name',
          },
        ]
      : [],
  }) as IntakeReviewRecord;

test('fresh empty issue snapshots share one source-bound publication without skipping record review', async (t) => {
  const db = await fixture(t);
  let baseline: number | undefined;
  for (const count of [1, 8]) {
    let reviewed = 0;
    const before = intakeWorkCounters(db).warm.reportSnapshotCheckpointBatches;
    const plan = await prepareOwnershipIdentitySnapshots(db, db, {
      sources: Array.from({ length: count }, (_, index) => ({
        intakeId: 'first',
        recordId: `record-${index}`,
        reportMember: true,
      })),
      record(_intake, id) {
        reviewed++;
        return record(id);
      },
      factory(id) {
        return createOwnershipSourceSnapshotPreparation(db, { id });
      },
      report: { intakeId: 'first', groupId: 'fictional-report' },
    });
    const batches = intakeWorkCounters(db).warm.reportSnapshotCheckpointBatches - before;
    assert.ok(batches > 0);
    baseline ??= batches;
    assert.equal(batches, baseline);
    assert.equal(reviewed, count);
    const first = plan.forSource('first', 'record-0');
    for (let index = 0; index < count; index++)
      assert.deepEqual(plan.forSource('first', `record-${index}`), first);
    assert.deepEqual(plan.forReport(), first);
    assert.deepEqual(readOwnershipSourceSnapshot(db, first.snapshot).sourceRecordIds, []);
    plan.assertCurrent();
    t.diagnostic(JSON.stringify({ count, batches, reviewed }));
  }
});

test('empty reuse remains source scoped and excludes prior authority and nonempty issues', async (t) => {
  const db = await fixture(t);
  transaction(db, () =>
    appendOwnershipDecision(db, 'fictional-prior', 'Record ownership source', {
      identity: 'prior-record',
      identityIssues: [],
    }),
  );
  const sources = [
    { intakeId: 'first', recordId: 'fresh' },
    { intakeId: 'first', recordId: 'prior', identity: 'prior-record' },
    { intakeId: 'first', recordId: 'question' },
    { intakeId: 'second', recordId: 'other' },
  ];
  const plan = await prepareOwnershipIdentitySnapshots(db, db, {
    sources,
    record(_intake, id) {
      return record(id, id === 'question');
    },
    factory(id) {
      return createOwnershipSourceSnapshotPreparation(db, { id });
    },
  });
  const fresh = plan.forSource('first', 'fresh');
  assert.notEqual(plan.forSource('first', 'prior').snapshot.snapshotId, fresh.snapshot.snapshotId);
  assert.equal(plan.forSource('first', 'question').snapshot.count, 1);
  assert.equal(plan.forSource('second', 'other').snapshot.source.intakeId, 'second');
  assert.notEqual(plan.forSource('second', 'other').snapshot.snapshotId, fresh.snapshot.snapshotId);
  plan.assertCurrent();
});

test('empty reuse refuses changed source authority between reviewed records', async (t) => {
  const db = await fixture(t);
  let visited = 0;
  await assert.rejects(
    prepareOwnershipIdentitySnapshots(db, db, {
      sources: [
        { intakeId: 'first', recordId: 'one' },
        { intakeId: 'first', recordId: 'two' },
      ],
      record(_intake, id) {
        if (++visited === 2)
          db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('f'.repeat(64), 'first');
        return record(id);
      },
      factory(id) {
        return createOwnershipSourceSnapshotPreparation(db, { id });
      },
    }),
  );
  assert.equal(visited, 2);
});
