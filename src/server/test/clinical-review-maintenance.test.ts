import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync, constants } from 'node:sqlite';
import {
  execClinicalReviewMaintenance as exec,
  prepareClinicalReviewMaintenance as prepare,
  reviewPreparationMethodStamp,
  reviewPreparationStamp,
  runClinicalReviewMaintenance as run,
} from '../clinical-review-maintenance.ts';
import {
  managedDatabaseMethodSerial,
  observeManagedDatabaseAuthorization,
  openDatabase,
} from '../database.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';

function fixture(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    "CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE source_files(id TEXT PRIMARY KEY); INSERT INTO app_meta VALUES('owner','fictional'),('second','fictional')",
  );
  t.after(() => {
    if (db.isOpen) db.close();
  });
  return db;
}
const create = (db: DatabaseSync) =>
  exec(
    db,
    'attention',
    'CREATE TEMP TABLE source_attention_counts_v1(source_id TEXT PRIMARY KEY,sections INTEGER NOT NULL)',
  );

test('only exact successful maintenance authorizer transitions preserve method authority', (t) => {
  const db = openDatabase(':memory:', 'fictional-maintenance-method');
  t.after(() => db.close());
  const before = reviewPreparationMethodStamp(db);
  assert.ok(before !== undefined);
  const serial = managedDatabaseMethodSerial(db)!;
  create(db);
  assert.equal(managedDatabaseMethodSerial(db), serial + 2n);
  assert.equal(reviewPreparationMethodStamp(db), before);
  run(db, 'attention', "INSERT INTO source_attention_counts_v1 VALUES('a',1)");
  assert.equal(reviewPreparationMethodStamp(db), before);
  assert.throws(() => run(db, 'attention', "INSERT INTO source_attention_counts_v1 VALUES('a',2)"));
  const failed = reviewPreparationMethodStamp(db);
  assert.notEqual(failed, before);
  db.setAuthorizer(null);
  assert.notEqual(reviewPreparationMethodStamp(db), failed);
  const publicPolicy = reviewPreparationMethodStamp(db);
  db.function('fictional_method_change', () => 1);
  assert.notEqual(reviewPreparationMethodStamp(db), publicPolicy);
});

test('extra method transition inside a maintenance statement receives no credit', (t) => {
  const db = openDatabase(':memory:', 'fictional-maintenance-extra');
  t.after(() => db.close());
  create(db);
  const before = reviewPreparationMethodStamp(db);
  let nested = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    () => {},
    () => {
      if (nested) return;
      nested = true;
      db.setAuthorizer(null);
    },
  );
  assert.ok(stop);
  try {
    assert.throws(
      () => run(db, 'attention', "INSERT INTO source_attention_counts_v1 VALUES('a',1)"),
      /changed method authority/,
    );
    assert.notEqual(reviewPreparationMethodStamp(db), before);
  } finally {
    stop();
  }
});

test('certified cold and warm TEMP SQL preserves preparation authority and raw cache invalidation', (t) => {
  const db = fixture(t),
    authority = reviewPreparationStamp(db),
    raw = reviewReadStamp(db);
  create(db);
  const insert = prepare(db, 'attention', 'INSERT INTO source_attention_counts_v1 VALUES(?,?)');
  insert.run('a', 'one');
  run(
    db,
    'attention',
    'UPDATE source_attention_counts_v1 SET sections=? WHERE source_id=?',
    'two',
    'a',
  );
  exec(
    db,
    'attention',
    'CREATE TEMP TRIGGER source_attention_meta_insert AFTER INSERT ON main.app_meta BEGIN INSERT INTO source_attention_counts_v1 VALUES(new.key,new.value); END',
  );
  assert.equal(reviewPreparationStamp(db), authority);
  assert.notEqual(reviewReadStamp(db), raw);
  exec(db, 'attention', 'DROP TRIGGER temp.source_attention_meta_insert');
  exec(db, 'attention', 'DROP TABLE temp.source_attention_counts_v1');
  assert.equal(reviewPreparationStamp(db), authority);
});

test('nested owned DDL from an authorization observer receives no maintenance credit', (t) => {
  const db = openDatabase(':memory:', 'fictional-maintenance-nested-ddl');
  t.after(() => db.close());
  const before = reviewPreparationStamp(db),
    methods = reviewPreparationMethodStamp(db);
  let entered = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action) => {
      if (entered || action !== constants.SQLITE_CREATE_TEMP_TABLE) return;
      entered = true;
      db.exec(
        'CREATE TEMP TABLE source_attention_dirty_v1(source_id TEXT PRIMARY KEY); DROP TABLE source_attention_dirty_v1',
      );
    },
    () => {},
  );
  assert.ok(stop);
  try {
    assert.throws(() => create(db));
    assert.equal(entered, true);
    assert.equal(reviewPreparationStamp(db), before, 'nested DDL is denied before a schema write');
    assert.notEqual(reviewPreparationMethodStamp(db), methods);
  } finally {
    stop();
  }
});

for (const target of ['main', 'temp', 'schema'] as const)
  for (const phase of [1, 2])
    test(`policy callback ${target} changes at transition ${phase} receive no maintenance credit`, (t) => {
      const db = openDatabase(':memory:', 'fictional-maintenance-callback');
      t.after(() => db.close());
      create(db);
      db.exec('CREATE TEMP TABLE fictional_unrelated(value INTEGER)');
      const before = reviewPreparationStamp(db),
        methods = reviewPreparationMethodStamp(db);
      let transitions = 0;
      const stop = observeManagedDatabaseAuthorization(
        db,
        () => {},
        () => {
          if (++transitions !== phase) return;
          if (target === 'main') {
            db.prepare(
              "UPDATE app_meta SET value='fictional-other' WHERE key='owner_profile_id'",
            ).run();
            db.prepare(
              "UPDATE app_meta SET value='fictional-maintenance-callback' WHERE key='owner_profile_id'",
            ).run();
          } else if (target === 'temp') {
            db.exec('INSERT INTO fictional_unrelated VALUES(1); DELETE FROM fictional_unrelated');
          } else {
            db.exec(
              'CREATE TEMP TABLE fictional_callback(value INTEGER); DROP TABLE fictional_callback',
            );
          }
        },
      );
      assert.ok(stop);
      try {
        assert.throws(() =>
          run(db, 'attention', "INSERT INTO source_attention_counts_v1 VALUES('a',1)"),
        );
        assert.notEqual(reviewPreparationStamp(db), before);
        assert.notEqual(reviewPreparationMethodStamp(db), methods);
      } finally {
        stop();
      }
    });

test('real writes and rollbacks before, between and after neutral SQL remain visible', (t) => {
  const db = fixture(t);
  create(db);
  const foreign = db.prepare("UPDATE app_meta SET value=value WHERE key='owner'");
  const rollback = () => {
    db.exec('BEGIN');
    foreign.run();
    db.exec('ROLLBACK');
  };
  const before = reviewPreparationStamp(db);
  rollback();
  run(db, 'attention', 'INSERT INTO source_attention_counts_v1 VALUES(?,?)', 'a', 'one');
  assert.notEqual(reviewPreparationStamp(db), before);
  const between = reviewPreparationStamp(db);
  run(db, 'attention', 'UPDATE source_attention_counts_v1 SET sections=?', 'two');
  rollback();
  run(db, 'attention', 'UPDATE source_attention_counts_v1 SET sections=?', 'three');
  assert.notEqual(reviewPreparationStamp(db), between);
  const after = reviewPreparationStamp(db);
  run(db, 'attention', 'UPDATE source_attention_counts_v1 SET sections=?', 'four');
  rollback();
  assert.notEqual(reviewPreparationStamp(db), after);
});

test('foreign trigger effects, functions and catalog statements cannot receive neutral credit', (t) => {
  const db = fixture(t);
  create(db);
  db.exec('CREATE TEMP TABLE unrelated_proof(value TEXT)');
  for (const body of [
    "UPDATE app_meta SET value='changed'; SELECT RAISE(ABORT,'stop');",
    "INSERT INTO unrelated_proof VALUES('changed');",
  ]) {
    db.exec(
      `CREATE TEMP TRIGGER foreign_trigger AFTER INSERT ON source_attention_counts_v1 BEGIN ${body} END`,
    );
    const stamp = reviewPreparationStamp(db);
    assert.throws(
      () =>
        run(db, 'attention', 'INSERT INTO source_attention_counts_v1 VALUES(?,?)', 'a', 'value'),
      /authoriz|Uncertified/,
    );
    assert.equal(reviewPreparationStamp(db), stamp);
    assert.equal(db.prepare('SELECT count(*) n FROM source_attention_counts_v1').get()!.n, 0);
    db.exec('DROP TRIGGER foreign_trigger');
  }
  let called = false;
  db.function('foreign_function', () => {
    called = true;
    return 'value';
  });
  assert.throws(
    () =>
      run(db, 'attention', "INSERT INTO source_attention_counts_v1 VALUES('a',foreign_function())"),
    /authoriz/,
  );
  assert.equal(called, false);
  assert.throws(() => exec(db, 'attention', 'UPDATE sqlite_temp_master SET sql=sql'));
  assert.throws(
    () =>
      exec(
        db,
        'attention',
        "CREATE TEMP TABLE source_attention_state_v1(v); INSERT INTO app_meta VALUES('foreign','value')",
      ),
    /one SQL statement/,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM app_meta WHERE key='foreign'").get()!.n, 0);
  // The authorizer must be restored even after compilation or validation fails.
  db.prepare("UPDATE app_meta SET value='still writable' WHERE key='owner'").run();
});

test('partial failed SQL and transaction-bound writes never mint neutral credit', (t) => {
  const db = fixture(t);
  create(db);
  run(db, 'attention', 'INSERT INTO source_attention_counts_v1 VALUES(?,?)', 'duplicate', 'one');
  const before = reviewPreparationStamp(db);
  assert.throws(() =>
    run(
      db,
      'attention',
      "INSERT OR FAIL INTO source_attention_counts_v1 VALUES('first','value'),('duplicate','value')",
    ),
  );
  assert.equal(
    db.prepare("SELECT sections FROM source_attention_counts_v1 WHERE source_id='first'").get()!
      .sections,
    'value',
  );
  assert.notEqual(reviewPreparationStamp(db), before);
  const beforeTransaction = reviewPreparationStamp(db);
  db.exec('BEGIN');
  run(db, 'attention', "UPDATE source_attention_counts_v1 SET sections='transaction'");
  assert.equal(reviewPreparationStamp(db), undefined);
  db.exec('ROLLBACK');
  assert.notEqual(reviewPreparationStamp(db), beforeTransaction);
});

test('suspended iterators and existing prepared statements survive scoped authorization', (t) => {
  const db = fixture(t);
  create(db);
  const read = db.prepare('SELECT key FROM app_meta ORDER BY key'),
    iterator = read.iterate();
  assert.equal(iterator.next().value!.key, 'owner');
  run(db, 'attention', 'INSERT INTO source_attention_counts_v1 VALUES(?,?)', 'a', 'value');
  assert.equal(iterator.next().value!.key, 'second');
  assert.equal(iterator.next().done, true);
  assert.equal(read.all().length, 2);
});

test('schema-embedded functions cannot launder precompiled main writes', (t) => {
  const db = fixture(t);
  create(db);
  let calls = 0;
  const foreign = db.prepare("UPDATE app_meta SET value='changed' WHERE key='owner'");
  db.function('foreign_schema_function', { deterministic: true }, (value) => {
    calls++;
    foreign.run();
    return value;
  });
  db.exec(
    'CREATE INDEX temp.foreign_index ON source_attention_counts_v1(foreign_schema_function(sections))',
  );
  assert.throws(
    () => run(db, 'attention', "INSERT INTO source_attention_counts_v1 VALUES('a',1)"),
    /Uncertified clinical cache schema/,
  );
  assert.equal(calls, 0);
  db.exec('DROP INDEX temp.foreign_index');
  for (const columns of [
    'source_id TEXT PRIMARY KEY,sections INTEGER NOT NULL CHECK(foreign_schema_function(sections))',
    'source_id TEXT PRIMARY KEY,sections INTEGER NOT NULL DEFAULT(foreign_schema_function(1))',
    'source_id TEXT PRIMARY KEY,sections INTEGER GENERATED ALWAYS AS (foreign_schema_function(source_id)) STORED',
  ]) {
    db.exec('DROP TABLE temp.source_attention_counts_v1');
    db.exec('CREATE TEMP TABLE source_attention_counts_v1(' + columns + ')');
    assert.throws(
      () => run(db, 'attention', "INSERT INTO source_attention_counts_v1(source_id) VALUES('a')"),
      /Uncertified clinical cache schema/,
    );
    assert.equal(calls, 0);
  }
  assert.equal(
    db.prepare("SELECT value FROM app_meta WHERE key='owner'").get()!.value,
    'fictional',
  );
});
