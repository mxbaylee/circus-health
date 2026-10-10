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
import {
  prepareOwnershipIdentitySnapshots,
  type OwnershipIdentityIssues,
} from '../ownership-identity-snapshots.ts';
import { createOwnershipSourceSnapshotPreparation } from '../ownership-source-snapshots.ts';
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

const reference = (value: OwnershipIdentityIssues) => {
  assert.ok(!Array.isArray(value), 'prior or nonempty issues retain snapshot authority');
  return value;
};

test('fresh empty issue evidence publishes no snapshot without skipping record review', async (t) => {
  const db = await fixture(t);
  for (const count of [1, 8]) {
    let reviewed = 0;
    const before = intakeWorkCounters(db).warm.reportSnapshotCheckpointBatches;
    const acceptedBefore = db.prepare('SELECT * FROM __record_state WHERE singleton=1').get();
    const transactionsBefore = db.prepare('SELECT count(*) n FROM __record_transactions').get()!.n;
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
    assert.equal(batches, 0);
    assert.deepEqual(
      db.prepare('SELECT * FROM __record_state WHERE singleton=1').get(),
      acceptedBefore,
    );
    assert.equal(
      db.prepare('SELECT count(*) n FROM __record_transactions').get()!.n,
      transactionsBefore,
    );
    assert.equal(reviewed, count);
    for (let index = 0; index < count; index++)
      assert.deepEqual(plan.forSource('first', `record-${index}`), []);
    assert.deepEqual(plan.forReport(), []);
    const returnedReport = plan.forReport(),
      returnedSource = plan.forSource('first', 'record-0');
    assert.ok(Array.isArray(returnedReport));
    assert.ok(Array.isArray(returnedSource));
    returnedReport.push('fictional-unissued-report-issue');
    returnedSource.push('fictional-unissued-source-issue');
    assert.deepEqual(plan.forReport(), []);
    assert.deepEqual(plan.forSource('first', 'record-0'), []);
    plan.assertCurrent();
    db.prepare('UPDATE ownership_identity_snapshots SET value=? WHERE intake=? AND record=?').run(
      JSON.stringify(['fictional-forged-inline-issue']),
      'first',
      'record-0',
    );
    assert.throws(() => plan.forSource('first', 'record-0'), /Invalid inline/);
    assert.throws(() => plan.assertCurrent(), /Invalid inline/);
    t.diagnostic(JSON.stringify({ count, batches, reviewed }));
  }
});

test('inline empty evidence retains source guards and excludes prior authority and nonempty issues', async (t) => {
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
  assert.deepEqual(fresh, []);
  assert.equal(reference(plan.forSource('first', 'prior')).snapshot.count, 0);
  assert.equal(reference(plan.forSource('first', 'question')).snapshot.count, 1);
  assert.deepEqual(plan.forSource('second', 'other'), []);
  plan.assertCurrent();
  db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('f'.repeat(64), 'second');
  assert.throws(() => plan.assertCurrent());
});

test('inline empty evidence refuses changed source authority between reviewed records', async (t) => {
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

test('prior empty report issue authority still publishes an authenticated snapshot', async (t) => {
  const db = await fixture(t);
  transaction(db, () =>
    appendOwnershipDecision(db, 'fictional-prior-report', 'Report ownership default', {
      groupId: 'fictional-report',
      identityIssues: [],
    }),
  );
  const before = intakeWorkCounters(db).warm.reportSnapshotCheckpointBatches;
  const plan = await prepareOwnershipIdentitySnapshots(db, db, {
    sources: [{ intakeId: 'first', recordId: 'fresh', reportMember: true }],
    record(_intake, id) {
      return record(id);
    },
    factory(id) {
      return createOwnershipSourceSnapshotPreparation(db, { id });
    },
    report: { intakeId: 'first', groupId: 'fictional-report' },
  });
  assert.deepEqual(plan.forSource('first', 'fresh'), []);
  assert.equal(reference(plan.forReport()).snapshot.count, 0);
  assert.ok(intakeWorkCounters(db).warm.reportSnapshotCheckpointBatches > before);
  plan.assertCurrent();
});
