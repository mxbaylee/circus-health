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
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
  writeIntakeFixtureEnvelope,
} from './helpers/intake-authority-fixture.ts';
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-lookup-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional-profile');
  const authority = memoryRecordAuthority(db);
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
  const write = (id: string, raw: string) => writeIntakeFixtureEnvelope(db, id, JSON.parse(raw));
  const insert = (id: string, n: number, kind = 'intake_original') => {
    if (kind === 'intake_original') return registerRawIntakeFixture(db, id, body(n));
    transaction(db, () =>
      db
        .prepare(
          'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
        )
        .run(id, id + '.txt', 'a'.repeat(64), 0, kind, body(n)),
    );
  };
  return { db, body, insert, write, authority };
}
test('raw writes, reordered contributions, kind and ID changes preserve scoped lookup ordering', (t) => {
  const { db, body, insert, write } = fixture(t);
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
    write('first', body(12));
    assert.equal(maximumReportDiscoveryOrder(db), 12);
    db.prepare('UPDATE source_files SET id=? WHERE id=?').run('renamed', 'other');
    assert.equal(maximumReportDiscoveryOrder(db), 12);
    assert.equal(
      (retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker,
      12,
    );
  });
  transaction(db, () => db.prepare('DELETE FROM source_files WHERE id=?').run('second'));
  assert.equal(maximumReportDiscoveryOrder(db), 12);
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 12 }, { marker: 100 }]);
});
test('rollback restores allocation and freshness even when first build occurs inside transaction', (t) => {
  const { db, body, insert, write } = fixture(t);
  insert('first', 2);
  assert.throws(
    () =>
      transaction(db, () => {
        assert.equal(maximumReportDiscoveryOrder(db), 2);
        write('first', body(77));
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
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '__record_intake_lookup_*'",
    )
    .all();
  for (const row of names) db.exec(`DROP TABLE "${String(row.name)}"`);
  transaction(db, () => db.prepare('UPDATE source_files SET path=?').run('fictional-rebound.txt'));
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
  transaction(db, () =>
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run('{', 'invalid'),
  );
  db.exec('PRAGMA ignore_check_constraints=OFF');
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 4 }]);
  assert.throws(
    () =>
      transaction(db, () => {
        db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
          JSON.stringify({ intake: { workflow: { reportGroups: { bad: true } } } }),
          'first',
        );
        maximumReportDiscoveryOrder(db);
      }),
    /authority|unsupported|missing/i,
  );
  assert.equal(maximumReportDiscoveryOrder(db), 4);
});

test('cold stale projection reconciled inside rollback remains cold afterward', (t) => {
  const { db, body, insert, write } = fixture(t);
  insert('first', 2);
  maximumReportDiscoveryOrder(db);
  // Simulate a later connection writing while lookup tracking is absent.
  db.exec('DROP TRIGGER temp.__intake_lookup_update');
  write('first', body(44));
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
    writeIntakeFixtureEnvelope(db, 'first', {
      intake: { workflow: { reportAcceptances: values, identityConfirmations: values } },
    });
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

test('actual connection close and reopen reads selected intake head rather than stale lookup contribution', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-lookup-reopen-')),
    path = join(root, 'cache.sqlite');
  let db = openDatabase(path, 'fictional-profile');
  const authority = memoryRecordAuthority(db);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  registerRawIntakeFixture(
    db,
    'one',
    JSON.stringify({ intake: { workflow: { reportGroups: [{ discoveryOrder: 5 }] } } }),
  );
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  db.close();
  db = openDatabase(path, 'fictional-profile');
  authority.attach(db);
  writeIntakeFixtureEnvelope(db, 'one', {
    intake: { workflow: { reportGroups: [{ discoveryOrder: 88 }] } },
  });
  assert.equal(maximumReportDiscoveryOrder(db), 88);
  assert.equal(intakeLookupCounters(db).builds, 1);
});

test('source ID rebinding refuses cross-source authority and rollback retains shared payload bytes', (t) => {
  const { db, insert } = fixture(t);
  insert('a', 3);
  maximumReportDiscoveryOrder(db);
  const original = db.prepare('SELECT * FROM __record_intake_lookup_payloads ORDER BY hash').all();
  assert.throws(
    () =>
      transaction(db, () => {
        db.prepare('UPDATE source_files SET id=? WHERE id=?').run('z', 'a');
        maximumReportDiscoveryOrder(db);
      }),
    /authority|missing|source|intake/i,
  );
  assert.equal(maximumReportDiscoveryOrder(db), 3);
  assert.deepEqual(
    db.prepare('SELECT * FROM __record_intake_lookup_payloads ORDER BY hash').all(),
    original,
  );
});

test('selected head corruption refuses warm and cold lookups without erasing retained receipts', (t) => {
  const { db, insert, authority } = fixture(t);
  insert('a', 1);
  insert('z', 2);
  maximumReportDiscoveryOrder(db);
  const keys = db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:head' ORDER BY key")
    .all();
  assert.equal(keys.length, 2);
  const selected = keys[1]!;
  for (const clear of [false, true]) {
    assert.throws(
      () =>
        transaction(db, () => {
          db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(
            '{"format":"fictional-unsupported"}',
            selected.key!,
          );
          if (clear) clearIntakeLookupCache(db);
          maximumReportDiscoveryOrder(db);
        }),
      /intake|authority|schema|format/i,
    );
    assert.deepEqual(retainedReportAcceptance(db, 'same'), {
      receipt: { operationId: 'same' },
      marker: 1,
    });
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM __record_intake_lookup_acceptances').get()!.n,
      2,
    );
  }
  assert.ok(authority.objects.has('head'));
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

test('raw SQL-first duplicate members, scalar identities and integer discovery conversion remain exact', (t) => {
  const { db } = fixture(t);
  registerRawIntakeFixture(
    db,
    'raw',
    `{"intake":{"workflow":{
    "reportGroups":[{"discoveryOrder":"009fictional","discoveryOrder":700},null,{}],
    "reportAcceptances":[{"receipt":{"operationId":"raw-first","operationId":"raw-last"},"marker":"first"},{"receipt":{"operationId":null}}],
    "identityConfirmations":[null,1,true,false,"fictional scalar","17",{"marker":"kept"}]
  }},"intake":{"workflow":{"reportGroups":[{"discoveryOrder":999}]}}}`,
  );
  assert.equal(maximumReportDiscoveryOrder(db), 9);
  assert.deepEqual(retainedReportAcceptance(db, 'raw-first'), {
    receipt: { operationId: 'raw-last' },
    marker: 'first',
  });
  assert.equal(retainedReportAcceptance(db, 'raw-last'), null);
  assert.deepEqual(intakeIdentityConfirmations(db), [null, 1, 1, 0, null, 17, { marker: 'kept' }]);
});

test('identity cycles, missing links, extra rows and missing payloads refuse warm and repair cold', (t) => {
  const { db, insert, write } = fixture(t);
  insert('first', 1);
  const identities = [{ marker: 1 }, { marker: 2 }, { marker: 1 }];
  write('first', JSON.stringify({ intake: { workflow: { identityConfirmations: identities } } }));
  assert.deepEqual(intakeIdentityConfirmations(db), identities);
  for (const corrupt of [
    'UPDATE __record_intake_lookup_identities SET next=id',
    'UPDATE __record_intake_lookup_identities SET next=999 WHERE next IS NOT NULL',
    'INSERT INTO __record_intake_lookup_identities SELECT source_id,999,NULL,hash FROM __record_intake_lookup_identities LIMIT 1',
    'DELETE FROM __record_intake_lookup_payloads',
  ]) {
    db.exec(corrupt);
    assert.throws(() => intakeIdentityConfirmations(db), /identity occurrence chain/);
    clearIntakeLookupCache(db);
    assert.deepEqual(intakeIdentityConfirmations(db), identities);
  }
});

test('deleting and reinserting a source updates cross-source acceptance and identity order', (t) => {
  const { db, insert } = fixture(t);
  insert('a', 1);
  insert('b', 2);
  assert.deepEqual(retainedReportAcceptance(db, 'same'), {
    receipt: { operationId: 'same' },
    marker: 1,
  });
  transaction(db, () => db.prepare('DELETE FROM source_files WHERE id=?').run('a'));
  insert('c', 3);
  assert.deepEqual(retainedReportAcceptance(db, 'same'), {
    receipt: { operationId: 'same' },
    marker: 2,
  });
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 2 }, { marker: 3 }]);
});

test('rolled-back payload memo is discarded before reconstruction and retry', (t) => {
  const { db, body, insert, write } = fixture(t);
  insert('first', 1);
  maximumReportDiscoveryOrder(db);
  const retainedRows = db
    .prepare('SELECT * FROM __record_intake_lookup_payloads ORDER BY hash')
    .all();
  const payloadBytes = (marker: number) =>
    Buffer.byteLength(JSON.stringify({ receipt: { operationId: 'same' }, marker })) +
    Buffer.byteLength(JSON.stringify({ marker }));
  const before = { ...intakeLookupCounters(db) };
  assert.throws(
    () =>
      transaction(db, () => {
        write('first', body(77));
        assert.equal(maximumReportDiscoveryOrder(db), 77);
        throw Error('fictional payload rollback');
      }),
    /fictional payload rollback/,
  );
  const failed = { ...intakeLookupCounters(db) };
  assert.equal(failed.hashedPayloadBytes - before.hashedPayloadBytes, payloadBytes(77));
  assert.deepEqual(
    db.prepare('SELECT * FROM __record_intake_lookup_payloads ORDER BY hash').all(),
    retainedRows,
  );
  assert.equal(maximumReportDiscoveryOrder(db), 1);
  const restored = { ...intakeLookupCounters(db) };
  assert.equal(
    restored.hashedPayloadBytes - failed.hashedPayloadBytes,
    payloadBytes(1),
    'cold restoration revalidates committed payloads',
  );
  write('first', body(77));
  assert.equal(maximumReportDiscoveryOrder(db), 77);
  const retried = { ...intakeLookupCounters(db) };
  assert.equal(
    retried.hashedPayloadBytes - restored.hashedPayloadBytes,
    payloadBytes(77),
    'an aborted new payload must be hashed again on retry',
  );
});
