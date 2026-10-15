import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { tmpdir } from 'node:os';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { openDatabase, transaction, managedDatabaseMethodEpoch } from '../database.ts';
import { prepareCollectionQueueRead } from '../intake-queue-native.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';

for (const change of ['cancel', 'source ABA', 'TEMP ABA', 'policy'] as const)
  test(`queue source binding cooperates and refuses ${change} at its first host turn`, async (t) => {
    const profileId = 'fictional-queue-binding';
    const db = openDatabase(':memory:', profileId);
    t.after(() => db.close());
    memoryRecordAuthority(db);
    transaction(db, () => {
      for (let index = 0; index < 130; index++)
        registerRawIntakeFixture(
          db,
          `fictional-${String(index).padStart(3, '0')}`,
          JSON.stringify({ intake: { version: 0, originalName: 'fictional.txt' } }),
        );
    });
    if (change === 'TEMP ABA') db.exec('CREATE TEMP TABLE fictional_drift(value)');
    const originalPrepare = DatabaseSync.prototype.prepare;
    const originalIterate = StatementSync.prototype.iterate;
    const counted = new WeakSet<StatementSync>();
    let rows = 0;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = originalPrepare.call(this, sql);
      if (this === db && sql.startsWith('SELECT f.id,f.sha256 FROM source_files f'))
        counted.add(statement);
      return statement;
    };
    StatementSync.prototype.iterate = function* (...args) {
      for (const row of Reflect.apply(originalIterate, this, args)) {
        if (counted.has(this)) rows++;
        yield row;
      }
      return undefined;
    };
    t.after(() => {
      DatabaseSync.prototype.prepare = originalPrepare;
      StatementSync.prototype.iterate = originalIterate;
    });
    let canceled = false;
    const changed = new Promise<void>((resolve) =>
      setImmediate(() => {
        if (change === 'cancel') canceled = true;
        if (change === 'source ABA') {
          db.prepare(
            "UPDATE source_files SET path=path||'.changed' WHERE id='fictional-000'",
          ).run();
          db.prepare(
            "UPDATE source_files SET path='fictional-000.txt' WHERE id='fictional-000'",
          ).run();
        }
        if (change === 'TEMP ABA')
          db.exec('INSERT INTO fictional_drift VALUES(1); DELETE FROM fictional_drift;');
        if (change === 'policy') db.setAuthorizer(null);
        resolve();
      }),
    );
    const preparation = prepareCollectionQueueRead(db, tmpdir(), profileId, {
      assertRunning() {
        if (canceled) throw Error('fictional cancellation');
      },
    });
    await assert.rejects(
      preparation,
      change === 'cancel' ? /fictional cancellation/ : /Refresh this report queue/,
    );
    await changed;
    assert.equal(rows, 64, 'the complete 130-source scan stops at its first bounded checkpoint');
  });

test('managed method epochs revoke failed registrations and refuse replaced wrappers', (t) => {
  const db = openDatabase(':memory:', 'fictional-method-epoch');
  t.after(() => db.close());
  const before = managedDatabaseMethodEpoch(db);
  assert.ok(before);
  assert.throws(() => db.function('TOTAL_CHANGES', () => 0), /built-in/);
  const failed = managedDatabaseMethodEpoch(db);
  assert.ok(failed);
  assert.notEqual(failed, before);
  db.setAuthorizer(null);
  assert.notEqual(managedDatabaseMethodEpoch(db), failed);
  const setter = db.function;
  db.function = function () {};
  assert.equal(managedDatabaseMethodEpoch(db), undefined);
  db.function = setter;
});

test('queue preparation refuses a preexisting uppercase authority shadow', async (t) => {
  const db = openDatabase(':memory:', 'fictional-queue-shadow');
  t.after(() => db.close());
  memoryRecordAuthority(db);
  db.exec('CREATE TEMP TABLE SOURCE_FILES AS SELECT * FROM main.source_files');
  await assert.rejects(
    prepareCollectionQueueRead(db, tmpdir(), 'fictional-queue-shadow'),
    /Refresh this report queue/,
  );
});
