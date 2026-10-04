import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, revision, observeDatabaseClose } from '../database.ts';
import { recordDurabilityStatus, attachRecordDurability } from '../record-versions.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';

const revisionSql = "SELECT value FROM app_meta WHERE key='revision'";
const statusSql = 'SELECT * FROM __record_state WHERE singleton=1';
const nativeRevision = (db: DatabaseSync) => db.prepare(revisionSql).get()?.value;

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-prepared-read-authority-'));
  const file = join(root, 'current.sqlite');
  const db = openDatabase(file, 'fictional-prepared-read');
  const authority = memoryRecordAuthority(db);
  const opened = [db];
  t.after(() => {
    for (const connection of opened) if (connection.isOpen) connection.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file, db, authority, opened };
}

function observedQueries(db: DatabaseSync) {
  const prepared = new Map<string, number>(),
    executed = new Map<string, number>();
  const original = db.prepare;
  db.prepare = function (sql) {
    const statement = original.call(this, sql);
    if (sql === revisionSql || sql === statusSql) {
      prepared.set(sql, (prepared.get(sql) ?? 0) + 1);
      const get = statement.get;
      statement.get = (...args: unknown[]) => {
        executed.set(sql, (executed.get(sql) ?? 0) + 1);
        return Reflect.apply(get, statement, args) as ReturnType<typeof get>;
      };
    }
    return statement;
  };
  return {
    prepared,
    executed,
    restore: () => {
      db.prepare = original;
    },
  };
}
function outcome(fn: () => unknown) {
  try {
    return { value: fn() };
  } catch (error) {
    assert.ok(error instanceof Error);
    return {
      error: {
        name: error.name,
        message: error.message,
        code: (error as Error & { code?: string }).code,
      },
    };
  }
}
test('unchanged accepted status retains every SQL execution and physical HEAD read', (t) => {
  const f = fixture(t);
  // Deliberately use a fresh connection so observation includes cache admission.
  const db = new DatabaseSync(f.file);
  f.opened.push(db);
  const observed = observedQueries(db);
  attachRecordDurability(db, { profileId: f.authority.profileId, storage: f.authority.storage });
  const expected = recordDurabilityStatus(db);
  observed.prepared.clear();
  observed.executed.clear();
  const work = createRecordVersionWorkCounters();
  withRecordVersionWork(work, () => {
    for (let n = 0; n < 25; n++) assert.deepEqual(recordDurabilityStatus(db), expected);
  });
  assert.equal(observed.executed.get(statusSql), 25);
  assert.equal(observed.executed.get(revisionSql), 50);
  assert.equal(work.operation.headReadCalls, 25);
  assert.equal(observed.prepared.get(statusSql) ?? 0, 0);
  assert.equal(observed.prepared.get(revisionSql) ?? 0, 0);
  observed.restore();
});

test('TEMP revision view can reenter the same public reader during .get', (t) => {
  const f = fixture(t),
    expected = revision(f.db);
  let inside = false,
    nested: number | undefined,
    entries = 0;
  f.db.function('fictional_nested_revision', () => {
    entries++;
    if (!inside) {
      inside = true;
      try {
        nested = revision(f.db);
      } finally {
        inside = false;
      }
    }
    return expected;
  });
  f.db.exec(
    "CREATE TEMP VIEW app_meta AS SELECT key, CASE WHEN key='revision' THEN fictional_nested_revision() ELSE value END AS value FROM main.app_meta",
  );
  assert.equal(revision(f.db), expected);
  assert.equal(nested, expected);
  assert.ok(entries >= 2, 'the nested call actually executes the shadow view');
  assert.equal(Number(nativeRevision(f.db)), expected);
  f.db.exec('DROP VIEW temp.app_meta');
  assert.equal(revision(f.db), expected);
});

test('TEMP status view can reenter status during the cached row .get', (t) => {
  const f = fixture(t),
    expected = recordDurabilityStatus(f.db);
  let inside = false,
    nested: ReturnType<typeof recordDurabilityStatus> | undefined,
    entries = 0;
  f.db.function('fictional_nested_status', (head) => {
    entries++;
    if (!inside) {
      inside = true;
      try {
        nested = recordDurabilityStatus(f.db);
      } finally {
        inside = false;
      }
    }
    return head;
  });
  f.db.exec(
    'CREATE TEMP VIEW __record_state AS SELECT singleton,profile_id,projection,schema_version,sequence,fictional_nested_status(head_json) AS head_json FROM main.__record_state',
  );
  assert.deepEqual(recordDurabilityStatus(f.db), expected);
  assert.deepEqual(nested, expected);
  assert.ok(entries >= 2);
  assert.equal(recordDurabilityStatus(f.db)!.dirty, false);
  f.db.exec('DROP VIEW temp.__record_state');
  assert.deepEqual(recordDurabilityStatus(f.db), expected);
});

test('both revision observations remain distinct when the first SQL observation mutates metadata', (t) => {
  const f = fixture(t),
    initial = revision(f.db);
  f.db.exec(
    "CREATE TEMP TABLE fictional_revisions(value TEXT); INSERT INTO fictional_revisions VALUES('" +
      initial +
      "')",
  );
  let armed = true;
  f.db.function('fictional_next_revision', () => {
    const row = f.db.prepare('SELECT value FROM temp.fictional_revisions').get()!;
    if (armed) {
      armed = false;
      f.db.prepare('UPDATE temp.fictional_revisions SET value=?').run(String(initial + 1));
    }
    return row.value;
  });
  f.db.exec(
    "CREATE TEMP VIEW app_meta AS SELECT key, CASE WHEN key='revision' THEN fictional_next_revision() ELSE value END AS value FROM main.app_meta",
  );
  const status = recordDurabilityStatus(f.db)!;
  assert.equal(status.revision, initial);
  assert.equal(status.persistedRevision, initial + 1);
});

test('prepared readers rebind main and TEMP schema and retain native SQL errors', (t) => {
  const f = fixture(t),
    expected = revision(f.db);
  const status = recordDurabilityStatus(f.db);
  const revisionError = () =>
    assert.deepEqual(
      outcome(() => revision(f.db)),
      outcome(() => f.db.prepare(revisionSql).get()),
    );
  const statusError = () =>
    assert.deepEqual(
      outcome(() => recordDurabilityStatus(f.db)),
      outcome(() => f.db.prepare(statusSql).get()),
    );
  f.db.exec('CREATE TEMP VIEW app_meta AS SELECT key FROM main.app_meta');
  revisionError();
  f.db.exec('DROP VIEW temp.app_meta');
  assert.equal(revision(f.db), expected);
  f.db.exec('CREATE TEMP VIEW __record_state AS SELECT missing_column FROM main.__record_state');
  statusError();
  f.db.exec('DROP VIEW temp.__record_state');
  assert.deepEqual(recordDurabilityStatus(f.db), status);
  f.db.exec('ALTER TABLE main.app_meta RENAME TO fictional_app_meta');
  revisionError();
  f.db.exec(
    "CREATE TABLE main.app_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO main.app_meta VALUES('revision','901')",
  );
  assert.equal(revision(f.db), 901);
  assert.equal(Number(nativeRevision(f.db)), 901);
  f.db.exec('DROP TABLE main.app_meta; ALTER TABLE main.fictional_app_meta RENAME TO app_meta');
  assert.equal(revision(f.db), expected);
  f.db.exec('ALTER TABLE main.__record_state RENAME TO fictional_record_state');
  statusError();
  f.db.exec(
    'CREATE TABLE main.__record_state(singleton INTEGER PRIMARY KEY); INSERT INTO main.__record_state VALUES(1)',
  );
  assert.throws(() => recordDurabilityStatus(f.db), SyntaxError);
  f.db.exec(
    'DROP TABLE main.__record_state; ALTER TABLE main.fictional_record_state RENAME TO __record_state',
  );
  assert.deepEqual(recordDurabilityStatus(f.db), status);
});

test('failed native preparation does not poison later schema repair', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => {
    if (db.isOpen) db.close();
  });
  assert.deepEqual(
    outcome(() => revision(db)),
    outcome(() => db.prepare(revisionSql).get()),
  );
  db.exec(
    "CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO app_meta VALUES('revision','73')",
  );
  assert.equal(revision(db), 73);
});

test('actual close and reopen retain native errors and use a fresh connection', (t) => {
  const f = fixture(t),
    expectedRevision = revision(f.db),
    expectedStatus = recordDurabilityStatus(f.db);
  f.db.close();
  assert.deepEqual(
    outcome(() => revision(f.db)),
    outcome(() => f.db.prepare(revisionSql).get()),
  );
  assert.deepEqual(
    outcome(() => recordDurabilityStatus(f.db)),
    outcome(() => f.db.prepare(statusSql).get()),
  );
  f.db.open();
  f.authority.attach(f.db);
  assert.equal(revision(f.db), expectedRevision);
  assert.deepEqual(recordDurabilityStatus(f.db), expectedStatus);
  const next = new DatabaseSync(f.file);
  f.opened.push(next);
  f.authority.attach(next);
  assert.deepEqual(recordDurabilityStatus(next), expectedStatus);
});

test('simulated failed underlying close preserves observers and warm statements', (t) => {
  const f = fixture(t),
    db = new DatabaseSync(f.file);
  f.opened.push(db);
  // The controlled method is installed before ANY observer on this fresh connection.
  const nativeClose = db.close,
    sentinel = new Error('Fictional simulated close failure');
  let fail = true,
    notifications = 0;
  db.close = function () {
    if (fail) throw sentinel;
    return nativeClose.call(this);
  };
  observeDatabaseClose(db, () => {
    notifications++;
  });
  const observed = observedQueries(db);
  try {
    f.authority.attach(db);
    const expectedRevision = revision(db),
      expectedStatus = recordDurabilityStatus(db);
    const beforeFailure = Object.fromEntries(observed.prepared);
    assert.throws(
      () => db.close(),
      (error) => error === sentinel,
    );
    assert.equal(db.isOpen, true);
    assert.equal(notifications, 0);
    assert.equal(revision(db), expectedRevision);
    assert.deepEqual(recordDurabilityStatus(db), expectedStatus);
    assert.deepEqual(Object.fromEntries(observed.prepared), beforeFailure);
    fail = false;
    const beforeClose = new Map(observed.prepared);
    db.close();
    assert.equal(db.isOpen, false);
    assert.equal(notifications, 1);
    db.open();
    f.authority.attach(db);
    assert.equal(revision(db), expectedRevision);
    assert.deepEqual(recordDurabilityStatus(db), expectedStatus);
    for (const sql of [revisionSql, statusSql])
      assert.ok((observed.prepared.get(sql) ?? 0) > (beforeClose.get(sql) ?? 0));
    assert.equal(notifications, 1);
  } finally {
    fail = false;
    observed.restore();
  }
});

test('local, rolled-back and peer writes stay visible to prepared metadata readers', (t) => {
  const f = fixture(t),
    initial = revision(f.db);
  f.db.exec("BEGIN; UPDATE app_meta SET value='31' WHERE key='revision'");
  assert.equal(revision(f.db), 31);
  assert.equal(recordDurabilityStatus(f.db)!.revision, 31);
  f.db.exec('ROLLBACK');
  assert.equal(revision(f.db), initial);
  const peer = new DatabaseSync(f.file);
  f.opened.push(peer);
  peer.prepare("UPDATE app_meta SET value='32' WHERE key='revision'").run();
  assert.equal(revision(f.db), 32);
  const status = recordDurabilityStatus(f.db)!;
  assert.equal(status.revision, 32);
  assert.equal(status.persistedRevision, 32);
});

test('reattachment reads the current storage rather than a statement-admission backend', (t) => {
  const f = fixture(t),
    original = f.authority.storage;
  let currentHeads = 0;
  const replacement = {
    ...original,
    read(name: string) {
      if (name === 'head') currentHeads++;
      return original.read(name);
    },
  };
  attachRecordDurability(f.db, { profileId: f.authority.profileId, storage: replacement });
  currentHeads = 0;
  recordDurabilityStatus(f.db);
  assert.equal(currentHeads, 1);
});

test('physical accepted head and callback-side mutations remain observed', (t) => {
  const f = fixture(t),
    head = Buffer.from(f.authority.objects.get('head')!);
  assert.equal(recordDurabilityStatus(f.db)!.dirty, false);
  f.authority.objects.delete('head');
  assert.equal(recordDurabilityStatus(f.db)!.dirty, true);
  f.authority.objects.set('head', Buffer.from('{}'));
  assert.throws(() => recordDurabilityStatus(f.db), /invalid head/);
  f.authority.objects.set('head', head);
  const originalRead = f.authority.storage.read;
  let armed = true;
  f.authority.storage.read = (name) => {
    if (name === 'head' && armed) {
      armed = false;
      f.db.prepare("UPDATE app_meta SET value='47' WHERE key='revision'").run();
    }
    return originalRead(name);
  };
  const status = recordDurabilityStatus(f.db)!;
  assert.equal(status.revision, 47);
  assert.equal(status.persistedRevision, 47);
});

test('actual Symbol.dispose releases statements before same-object reopen', (t) => {
  const f = fixture(t),
    db = new DatabaseSync(f.file);
  f.opened.push(db);
  let notifications = 0;
  observeDatabaseClose(db, () => {
    notifications++;
  });
  const observed = observedQueries(db);
  f.authority.attach(db);
  const expectedRevision = revision(db),
    expectedStatus = recordDurabilityStatus(db);
  const beforeDispose = new Map(observed.prepared);
  db[Symbol.dispose]();
  assert.equal(db.isOpen, false);
  assert.equal(notifications, 1);
  db.open();
  f.authority.attach(db);
  assert.equal(revision(db), expectedRevision);
  assert.deepEqual(recordDurabilityStatus(db), expectedStatus);
  for (const sql of [revisionSql, statusSql])
    assert.ok((observed.prepared.get(sql) ?? 0) > (beforeDispose.get(sql) ?? 0));
  assert.equal(notifications, 1);
  observed.restore();
});
