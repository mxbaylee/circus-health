import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, constants } from 'node:sqlite';
import {
  installManagedDatabaseAuthorization,
  installManagedDatabaseFunctionRegistration,
  withoutManagedDatabaseCallbacks,
  prepareManagedDatabaseCallbackBarrier,
  managedDatabaseMethodEpoch,
  transaction,
} from '../database.ts';
import {
  ensureIntakeFrontierObserver,
  expectIntakeFrontierMetaWrite,
  finishIntakeFrontierMetaWrite,
  intakeFrontierTerminalEvent,
  prepareIntakeFrontierCaptureClear,
  clearIntakeFrontierRecordCapture,
  type IntakeFrontierCaptureClear,
} from '../intake-lookup-frontier-observer.ts';
import {
  intakeProjectionTerminalEvent,
  ensureIntakeProjectionWitness,
  ownedIntakeProjectionWrite,
} from '../intake-lookup-projection-witness.ts';

test('terminal capture cleanup consumes two exact native slots without authorization replay', () => {
  const db = new DatabaseSync(':memory:'),
    foreign = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE source_files(id TEXT PRIMARY KEY,kind TEXT);
      CREATE TABLE source_records(id TEXT PRIMARY KEY,source_file_id TEXT);
      CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE __record_state(singleton INTEGER PRIMARY KEY,head_json TEXT);
      CREATE TEMP TABLE __record_changed(entity TEXT,record_id TEXT);
      INSERT INTO app_meta VALUES('revision','0'),('clinical_review_revision','0');
      INSERT INTO __record_state VALUES(1,'fictional-head');
      INSERT INTO __record_changed VALUES('source_files','["fictional"]'),('app_meta','["foreign"]')`);
    installManagedDatabaseFunctionRegistration(db);
    installManagedDatabaseAuthorization(db);
    ensureIntakeFrontierObserver(db);
    prepareManagedDatabaseCallbackBarrier(db);
    const cleanup = prepareIntakeFrontierCaptureClear(db);
    assert.throws(() => clearIntakeFrontierRecordCapture(db, cleanup), /expired/);
    assert.throws(() => clearIntakeFrontierRecordCapture(foreign, cleanup), /Foreign/);
    transaction(db, () => {
      assert.throws(
        () => clearIntakeFrontierRecordCapture(db, Object.freeze({}) as IntakeFrontierCaptureClear),
        /Foreign/,
      );
      assert.equal(
        withoutManagedDatabaseCallbacks(db, () => clearIntakeFrontierRecordCapture(db, cleanup)),
        2,
      );
      assert.throws(() => clearIntakeFrontierRecordCapture(db), /Ordinary cleanup/);
      assert.equal(
        withoutManagedDatabaseCallbacks(db, () => clearIntakeFrontierRecordCapture(db, cleanup)),
        0,
      );
      assert.throws(() => clearIntakeFrontierRecordCapture(db, cleanup), /replayed/);
    });
    assert.throws(
      () => transaction(db, () => clearIntakeFrontierRecordCapture(db, cleanup)),
      /replayed/,
    );
  } finally {
    db.close();
    foreign.close();
  }
});

test('nested policy capture SQL cannot spend the owner compilation slot', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE source_files(id TEXT PRIMARY KEY,kind TEXT);
      CREATE TABLE source_records(id TEXT PRIMARY KEY,source_file_id TEXT);
      CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE __record_state(singleton INTEGER PRIMARY KEY,head_json TEXT);
      CREATE TEMP TABLE __record_changed(entity TEXT,record_id TEXT);
      INSERT INTO app_meta VALUES('revision','0'),('clinical_review_revision','0');
      INSERT INTO __record_state VALUES(1,'fictional-head')`);
    installManagedDatabaseFunctionRegistration(db);
    installManagedDatabaseAuthorization(db);
    ensureIntakeFrontierObserver(db);
    prepareManagedDatabaseCallbackBarrier(db);
    let nested = false;
    db.setAuthorizer((action, name, _detail, database) => {
      if (
        action === constants.SQLITE_DELETE &&
        name === '__record_changed' &&
        database === 'temp' &&
        !nested
      ) {
        nested = true;
        db.prepare('DELETE FROM temp.__record_changed').run();
      }
      return constants.SQLITE_OK;
    });
    // Policy replacement already revokes the old observer. Re-establish only
    // its ordinary issuer before testing a nested mutation during compilation.
    ensureIntakeFrontierObserver(db);
    assert.throws(() => prepareIntakeFrontierCaptureClear(db), /changed its original owner/);
    assert.equal(nested, true);
  } finally {
    db.close();
  }
});

test('terminal capture compilation cannot use foreign public prepare statements', () => {
  const db = new DatabaseSync(':memory:'),
    foreign = new DatabaseSync(':memory:');
  try {
    for (const connection of [db, foreign])
      connection.exec(`CREATE TABLE source_files(id TEXT PRIMARY KEY,kind TEXT);
        CREATE TABLE source_records(id TEXT PRIMARY KEY,source_file_id TEXT);
        CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE __record_state(singleton INTEGER PRIMARY KEY,head_json TEXT);
        CREATE TEMP TABLE __record_changed(entity TEXT,record_id TEXT);
        INSERT INTO app_meta VALUES('revision','0'),('clinical_review_revision','0');
        INSERT INTO __record_state VALUES(1,'fictional-head');
        INSERT INTO __record_changed VALUES('source_files','["fictional"]')`);
    installManagedDatabaseFunctionRegistration(db);
    installManagedDatabaseAuthorization(db);
    ensureIntakeFrontierObserver(db);
    prepareManagedDatabaseCallbackBarrier(db);
    db.setAuthorizer((action, table) =>
      action === constants.SQLITE_DELETE && table === '__record_changed'
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    ensureIntakeFrontierObserver(db);
    let foreignPreparations = 0;
    db.prepare = (sql) => {
      foreignPreparations++;
      return foreign.prepare(sql);
    };
    assert.throws(() => prepareIntakeFrontierCaptureClear(db), /authoriz/);
    assert.equal(foreignPreparations, 0);
    assert.equal(foreign.prepare('SELECT count(*) AS n FROM __record_changed').get()!.n, 1);
  } finally {
    db.close();
    foreign.close();
  }
});

test('projection event exemption belongs to the original private issuer, not its SQLite name', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE source_files(id TEXT); CREATE TABLE app_meta(key TEXT,value TEXT)');
    for (const name of ['state', 'sources', 'groups', 'acceptances', 'identities', 'payloads'])
      db.exec(
        `CREATE TABLE __record_intake_lookup_${name}(source_id TEXT,singleton INTEGER,ordinal INTEGER,operation_id TEXT,id INTEGER,hash TEXT)`,
      );
    installManagedDatabaseFunctionRegistration(db);
    installManagedDatabaseAuthorization(db);
    ensureIntakeProjectionWitness(db);
    prepareManagedDatabaseCallbackBarrier(db);
    const write = db.prepare('INSERT INTO __record_intake_lookup_sources(source_id) VALUES(?)');
    assert.equal(
      ownedIntakeProjectionWrite(
        db,
        { table: 'sources', operations: ['insert'], key: 'fictional' },
        () => withoutManagedDatabaseCallbacks(db, () => write.run('fictional')),
      ).changes,
      1,
    );
    const sql = String(
        db
          .prepare(
            "SELECT sql FROM sqlite_temp_schema WHERE name LIKE '__intake_projection_sources_insert_%'",
          )
          .get()!.sql,
      ),
      name = /SELECT ([a-z0-9_]+)\(/.exec(sql)![1]!;
    let calls = 0;
    const replacement = (_table: unknown, _operation: unknown, _key: unknown, _subkey: unknown) => {
      calls++;
      return null;
    };
    db.function(name, replacement);
    assert.equal(intakeProjectionTerminalEvent(db, replacement), false);
    const forged = db.prepare(`SELECT ${name}(NULL,NULL,NULL,NULL)`);
    assert.throws(() => withoutManagedDatabaseCallbacks(db, () => forged.get()));
    assert.equal(calls, 0);
  } finally {
    db.close();
  }
});

test('terminal barrier admits only issuer-owned bounded bookkeeping events, never a matching name', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE source_files(id TEXT PRIMARY KEY,kind TEXT);
      CREATE TABLE source_records(id TEXT PRIMARY KEY,source_file_id TEXT);
      CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE __record_state(singleton INTEGER PRIMARY KEY,head_json TEXT);
      INSERT INTO app_meta VALUES('selected/head','before');
      INSERT INTO __record_state VALUES(1,'fictional-head')`);
    installManagedDatabaseFunctionRegistration(db);
    installManagedDatabaseAuthorization(db);
    ensureIntakeFrontierObserver(db);
    prepareManagedDatabaseCallbackBarrier(db);
    const write = db.prepare('UPDATE app_meta SET value=? WHERE key=?');
    const expected = expectIntakeFrontierMetaWrite(db, 'selected/head', ['update']);
    const changes = withoutManagedDatabaseCallbacks(
      db,
      () => write.run('after', 'selected/head').changes,
    );
    finishIntakeFrontierMetaWrite(db, expected, changes === 1);
    assert.equal(expected?.seen, 1, 'the real event consumed its exact owned ticket');
    let calls = 0;
    const forged = () => {
      calls++;
      return 1;
    };
    assert.equal(intakeFrontierTerminalEvent(db, forged), false);
    assert.equal(intakeProjectionTerminalEvent(db, forged), false);
    db.function('__intake_frontier_event_fictional', forged);
    const read = db.prepare('SELECT __intake_frontier_event_fictional()');
    assert.throws(() => withoutManagedDatabaseCallbacks(db, () => read.get()));
    assert.equal(calls, 0);
  } finally {
    db.close();
  }
});

test('terminal barrier preserves compiled policy decisions and refuses reprepare before callbacks', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installManagedDatabaseFunctionRegistration(db);
    installManagedDatabaseAuthorization(db);
    prepareManagedDatabaseCallbackBarrier(db);
    let authorized = 0;
    db.setAuthorizer(() => {
      authorized++;
      return constants.SQLITE_OK;
    });
    const read = db.prepare('SELECT 17 AS value');
    const before = authorized;
    assert.equal(
      withoutManagedDatabaseCallbacks(db, () => read.get()!.value),
      17,
    );
    assert.equal(authorized, before);
    db.setAuthorizer(() => {
      authorized++;
      return constants.SQLITE_OK;
    });
    const changed = authorized;
    assert.throws(() => withoutManagedDatabaseCallbacks(db, () => read.get()));
    assert.equal(authorized, changed, 'the unexpected policy callback never runs');
    assert.equal(read.get()!.value, 17, 'a failed seal does not leave a connection-wide barrier');
  } finally {
    db.close();
  }
});

test('terminal barrier refuses prepared custom scalar execution without changing ordinary semantics', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installManagedDatabaseFunctionRegistration(db);
    installManagedDatabaseAuthorization(db);
    prepareManagedDatabaseCallbackBarrier(db);
    let calls = 0;
    db.function('fictional_scalar', { deterministic: true }, (value) => {
      calls++;
      return value;
    });
    const read = db.prepare('SELECT fictional_scalar(?) AS value');
    assert.throws(() => withoutManagedDatabaseCallbacks(db, () => read.get(23)));
    assert.equal(calls, 0);
    assert.equal(read.get(23)!.value, 23);
    assert.equal(calls, 1);
    const builtin = db.prepare('SELECT abs(?) AS value');
    assert.equal(
      withoutManagedDatabaseCallbacks(db, () => builtin.get(-23)!.value),
      23,
    );
  } finally {
    db.close();
  }
});

test('terminal barrier rejects deferred work and retains nested lifetime', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installManagedDatabaseFunctionRegistration(db);
    installManagedDatabaseAuthorization(db);
    prepareManagedDatabaseCallbackBarrier(db);
    assert.throws(
      () => withoutManagedDatabaseCallbacks(db, () => Promise.resolve(1)),
      /synchronous/,
    );
    assert.throws(
      () =>
        withoutManagedDatabaseCallbacks(db, function* () {
          yield 1;
        }),
      /synchronous/,
    );
    withoutManagedDatabaseCallbacks(db, () => {
      withoutManagedDatabaseCallbacks(db, () => true);
      assert.throws(() => db.prepare('SELECT 1'));
    });
    assert.equal(db.prepare('SELECT 1 AS n').get()!.n, 1);
  } finally {
    db.close();
  }
});

test('preexisting unwrapped custom scalars cannot enter a terminal phase', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.function('fictional_early_scalar', () => 1);
    installManagedDatabaseFunctionRegistration(db);
    installManagedDatabaseAuthorization(db);
    const read = db.prepare('SELECT fictional_early_scalar()');
    assert.throws(() => withoutManagedDatabaseCallbacks(db, () => read.get()), /managed scalar/);
  } finally {
    db.close();
  }
});

test('registering another arity cannot rehabilitate an unwrapped scalar overload', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let oldCalls = 0;
    db.function('fictional_overload', (a, b) => {
      oldCalls++;
      return Number(a) + Number(b);
    });
    installManagedDatabaseFunctionRegistration(db);
    installManagedDatabaseAuthorization(db);
    db.function('fictional_overload', (a) => a);
    const old = db.prepare('SELECT fictional_overload(1,2)');
    assert.throws(() => prepareManagedDatabaseCallbackBarrier(db), /managed scalar/);
    assert.throws(() => withoutManagedDatabaseCallbacks(db, () => old.get()), /managed scalar/);
    assert.equal(oldCalls, 0);
  } finally {
    db.close();
  }
});

test('managed scalar wrappers retain inferred arity and explicit varargs', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installManagedDatabaseFunctionRegistration(db);
    installManagedDatabaseAuthorization(db);
    db.function('fictional_pair', (a, b) => Number(a) + Number(b));
    db.function('fictional_many', { varargs: true }, (...args) => args.length);
    assert.equal(db.prepare('SELECT fictional_pair(2,3) AS n').get()!.n, 5);
    assert.equal(db.prepare('SELECT fictional_many(1,2,3,4) AS n').get()!.n, 4);
  } finally {
    db.close();
  }
});

test('terminal barrier does not bypass denied policy or schema invalidation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installManagedDatabaseFunctionRegistration(db);
    installManagedDatabaseAuthorization(db);
    prepareManagedDatabaseCallbackBarrier(db);
    db.exec('CREATE TABLE fictional_data(n INTEGER); INSERT INTO fictional_data VALUES(3)');
    let calls = 0;
    db.setAuthorizer(() => {
      calls++;
      return constants.SQLITE_OK;
    });
    const read = db.prepare('SELECT n FROM fictional_data');
    db.exec('CREATE TABLE fictional_other(n INTEGER)');
    const before = calls;
    assert.throws(() => withoutManagedDatabaseCallbacks(db, () => read.get()));
    assert.equal(calls, before);
    db.setAuthorizer(() => constants.SQLITE_DENY);
    assert.throws(() => db.prepare('SELECT n FROM fictional_data'));
    assert.throws(() => withoutManagedDatabaseCallbacks(db, () => read.get()));
  } finally {
    db.close();
  }
});

test('aggregate callbacks retain ordinary semantics but never enter a terminal seal', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installManagedDatabaseFunctionRegistration(db);
    installManagedDatabaseAuthorization(db);
    prepareManagedDatabaseCallbackBarrier(db);
    const original = managedDatabaseMethodEpoch(db);
    let starts = 0,
      steps = 0,
      results = 0;
    db.aggregate('fictional_total', {
      start() {
        starts++;
        return 0;
      },
      step(accumulator, value) {
        steps++;
        return Number(accumulator) + Number(value);
      },
      result(value) {
        results++;
        return value;
      },
    });
    assert.notEqual(managedDatabaseMethodEpoch(db), original);
    const read = db.prepare(
      'SELECT fictional_total(n) AS n FROM (SELECT 2 AS n UNION ALL SELECT 3)',
    );
    assert.throws(() => withoutManagedDatabaseCallbacks(db, () => read.get()));
    assert.deepEqual([starts, steps, results], [0, 0, 0]);
    assert.equal(read.get()!.n, 5);
    assert.deepEqual([starts, steps, results], [1, 2, 1]);
    const beforeDenied = managedDatabaseMethodEpoch(db);
    assert.throws(() => db.aggregate('sum', { start: 0, step: (a) => a }), /built-in/);
    assert.notEqual(managedDatabaseMethodEpoch(db), beforeDenied);
  } finally {
    db.close();
  }
});
