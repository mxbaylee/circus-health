import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import {
  maximumReportDiscoveryOrder,
  retainedReportAcceptance,
  intakeIdentityConfirmations,
} from '../intake-state-access.ts';
import { clearIntakeLookupCache, intakeLookupCounters } from '../intake-lookup-projection.ts';
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-lookup-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional-profile');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const body = (n: number) =>
    JSON.stringify({
      intake: {
        workflow: {
          reportGroups: [{ discoveryOrder: n }],
          reportAcceptances: [{ receipt: { operationId: 'same' }, marker: n }],
          identityConfirmations: [{ marker: n }],
        },
      },
    });
  const insert = (id: string, n: number, kind = 'intake_original') =>
    db
      .prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      )
      .run(id, id + '.txt', 'a'.repeat(64), 0, kind, body(n));
  return { db, body, insert };
}
test('raw writes, reordered contributions, kind and ID changes preserve scoped lookup ordering', (t) => {
  const { db, body, insert } = fixture(t);
  insert('first', 3);
  insert('second', 9);
  insert('other', 100, 'derived');
  assert.equal(maximumReportDiscoveryOrder(db), 9);
  assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 3);
  assert.deepEqual(intakeIdentityConfirmations(db), [
    { marker: 3 },
    { marker: 9 },
    { marker: 100 },
  ]);
  transaction(db, () => {
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(body(12), 'first');
    assert.equal(maximumReportDiscoveryOrder(db), 12);
    db.prepare('UPDATE source_files SET id=?,kind=? WHERE id=?').run('renamed', 'derived', 'first');
    assert.equal(maximumReportDiscoveryOrder(db), 9);
    assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 9);
  });
  db.prepare('DELETE FROM source_files WHERE id=?').run('second');
  assert.equal(maximumReportDiscoveryOrder(db), 0);
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 12 }, { marker: 100 }]);
});
test('rollback restores allocation and freshness even when first build occurs inside transaction', (t) => {
  const { db, body, insert } = fixture(t);
  insert('first', 2);
  assert.throws(
    () =>
      transaction(db, () => {
        assert.equal(maximumReportDiscoveryOrder(db), 2);
        db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(body(77), 'first');
        assert.equal(maximumReportDiscoveryOrder(db), 77);
        throw Error('fictional rollback');
      }),
    /fictional rollback/,
  );
  assert.equal(maximumReportDiscoveryOrder(db), 2);
  assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 2);
});
test('schema/index loss and cold payload corruption rebuild without persistent triggers or authority changes', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 5);
  maximumReportDiscoveryOrder(db);
  const original = db.prepare('SELECT details_json FROM source_files').get()!.details_json;
  db.exec(
    'DROP INDEX __record_intake_lookup_discovery; DROP INDEX __record_intake_lookup_operation',
  );
  const reads = intakeLookupCounters(db).authorityReads;
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  assert.equal(intakeLookupCounters(db).authorityReads, reads);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name IN ('__record_intake_lookup_discovery','__record_intake_lookup_operation')",
      )
      .get()!.n,
    2,
  );
  db.exec("UPDATE __record_intake_lookup_payloads SET payload='{}'");
  clearIntakeLookupCache(db);
  assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 5);
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '__record_*'")
    .all();
  for (const row of names) db.exec(`DROP TABLE "${String(row.name)}"`);
  db.prepare('UPDATE source_files SET path=?').run('fictional-rebound.txt');
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  assert.equal(db.prepare('SELECT details_json FROM source_files').get()!.details_json, original);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE '%intake_lookup%'",
      )
      .get()!.n,
    0,
  );
});
test('invalid non-original JSON is skipped while malformed original contribution state remains unavailable', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 4);
  insert('invalid', 90, 'derived');
  db.exec('PRAGMA ignore_check_constraints=ON');
  db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run('{', 'invalid');
  db.exec('PRAGMA ignore_check_constraints=OFF');
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 4 }]);
  db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
    JSON.stringify({ intake: { workflow: { reportGroups: { bad: true } } } }),
    'first',
  );
  assert.throws(() => maximumReportDiscoveryOrder(db), /malformed contribution array/);
  db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
    JSON.stringify({ intake: {} }),
    'first',
  );
  assert.equal(maximumReportDiscoveryOrder(db), 0);
});

test('cold stale projection reconciled inside rollback remains cold afterward', (t) => {
  const { db, body, insert } = fixture(t);
  insert('first', 2);
  maximumReportDiscoveryOrder(db);
  // Simulate a later connection writing while lookup tracking is absent.
  db.exec('DROP TRIGGER temp.__intake_lookup_update');
  db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(body(44), 'first');
  clearIntakeLookupCache(db);
  assert.throws(
    () =>
      transaction(db, () => {
        assert.equal(maximumReportDiscoveryOrder(db), 44);
        throw Error('rollback cold lookup');
      }),
    /rollback cold lookup/,
  );
  assert.equal(maximumReportDiscoveryOrder(db), 44);
  assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 44);
});

test('early insert, reorder, duplicate and removal update references without rewriting retained payload bytes', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 1);
  maximumReportDiscoveryOrder(db);
  const original = db.prepare('SELECT * FROM __record_intake_lookup_payloads ORDER BY hash').all();
  db.exec(
    'CREATE TEMP TABLE payload_updates(n); CREATE TEMP TRIGGER count_payload_updates AFTER UPDATE ON main.__record_intake_lookup_payloads BEGIN INSERT INTO payload_updates VALUES(1); END;',
  );
  const a = { receipt: { operationId: 'same' }, marker: 1 },
    b = { receipt: { operationId: 'same' }, marker: 2 };
  const write = (values: unknown[]) =>
    db.prepare('UPDATE source_files SET details_json=?').run(
      JSON.stringify({
        intake: { workflow: { reportAcceptances: values, identityConfirmations: values } },
      }),
    );
  write([b, a, a]);
  assert.deepEqual(retainedReportAcceptance(db, 'same'), b);
  write([a, b, a]);
  assert.deepEqual(retainedReportAcceptance(db, 'same'), a);
  write([a, a]);
  assert.deepEqual(intakeIdentityConfirmations(db), [a, a]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payload_updates').get()!.n, 0);
  for (const row of original.filter((row) => String(row.payload).includes('receipt')))
    assert.deepEqual(
      db.prepare('SELECT * FROM __record_intake_lookup_payloads WHERE hash=?').get(row.hash!),
      row,
    );
  db.exec("UPDATE __record_intake_lookup_acceptances SET operation_id='wrong'");
  clearIntakeLookupCache(db);
  assert.deepEqual(retainedReportAcceptance(db, 'same'), a);
  assert.equal(retainedReportAcceptance(db, 'wrong'), null);
});

test('actual connection close and reopen reconciles changes made without lookup tracking', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-lookup-reopen-')),
    path = join(root, 'cache.sqlite');
  let db = openDatabase(path, 'fictional-profile');
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(
    'one',
    'one.txt',
    'a'.repeat(64),
    0,
    'intake_original',
    JSON.stringify({ intake: { workflow: { reportGroups: [{ discoveryOrder: 5 }] } } }),
  );
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  db.close();
  db = openDatabase(path, 'fictional-profile');
  db.prepare('UPDATE source_files SET details_json=?').run(
    JSON.stringify({ intake: { workflow: { reportGroups: [{ discoveryOrder: 88 }] } } }),
  );
  assert.equal(maximumReportDiscoveryOrder(db), 88);
  assert.equal(intakeLookupCounters(db).builds, 1);
});

test('source rename preserves shared payload bytes through whole-dirty-set reconciliation', (t) => {
  const { db, insert } = fixture(t);
  insert('a', 3);
  maximumReportDiscoveryOrder(db);
  db.exec(
    "CREATE TEMP TABLE payload_changes(kind); CREATE TEMP TRIGGER count_payload_insert AFTER INSERT ON main.__record_intake_lookup_payloads BEGIN INSERT INTO payload_changes VALUES('insert'); END; CREATE TEMP TRIGGER count_payload_delete AFTER DELETE ON main.__record_intake_lookup_payloads BEGIN INSERT INTO payload_changes VALUES('delete'); END;",
  );
  transaction(db, () => {
    db.prepare('UPDATE source_files SET id=? WHERE id=?').run('z', 'a');
    assert.equal(maximumReportDiscoveryOrder(db), 3);
  });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payload_changes').get()!.n, 0);
  assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 3);
});

test('partial dirty batch failure stays coherent across close/reopen without orphan payloads', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-lookup-partial-')),
    path = join(root, 'cache.sqlite');
  let db = openDatabase(path, 'fictional-profile');
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const insert = (id: string, n: number) =>
    db
      .prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      )
      .run(
        id,
        id + '.txt',
        'a'.repeat(64),
        0,
        'intake_original',
        JSON.stringify({
          intake: {
            workflow: { reportAcceptances: [{ receipt: { operationId: id }, marker: n }] },
          },
        }),
      );
  insert('a', 1);
  insert('z', 2);
  maximumReportDiscoveryOrder(db);
  db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
    JSON.stringify({ intake: { workflow: {} } }),
    'a',
  );
  db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
    JSON.stringify({ intake: { workflow: null } }),
    'z',
  );
  assert.throws(() => maximumReportDiscoveryOrder(db), /malformed workflow/);
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM __record_intake_lookup_acceptances').get()!.n,
    2,
    'failed derived batch rolls back earlier contribution changes',
  );
  db.close();
  db = openDatabase(path, 'fictional-profile');
  db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
    JSON.stringify({ intake: { workflow: {} } }),
    'z',
  );
  maximumReportDiscoveryOrder(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM __record_intake_lookup_payloads').get()!.n, 0);
});
test('wrong projection affinity or singleton binding rebuilds from unchanged source evidence', (t) => {
  const { db, insert } = fixture(t);
  insert('one', 19);
  maximumReportDiscoveryOrder(db);
  const original = db.prepare('SELECT details_json FROM source_files').get()!.details_json;
  db.exec(
    'DROP TABLE __record_intake_lookup_groups; CREATE TABLE __record_intake_lookup_groups(source_id TEXT NOT NULL,ordinal INTEGER NOT NULL,discovery_order TEXT,PRIMARY KEY(source_id,ordinal));',
  );
  assert.equal(maximumReportDiscoveryOrder(db), 19);
  assert.equal(
    db.prepare('PRAGMA table_info(__record_intake_lookup_groups)').all()[2]!.type,
    'INTEGER',
  );
  db.exec(
    'PRAGMA ignore_check_constraints=ON; UPDATE __record_intake_lookup_state SET singleton=2; PRAGMA ignore_check_constraints=OFF',
  );
  clearIntakeLookupCache(db);
  assert.equal(maximumReportDiscoveryOrder(db), 19);
  assert.equal(
    db.prepare('SELECT singleton FROM __record_intake_lookup_state').get()!.singleton,
    1,
  );
  assert.equal(db.prepare('SELECT details_json FROM source_files').get()!.details_json, original);
});
