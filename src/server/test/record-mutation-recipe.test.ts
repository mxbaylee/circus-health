import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync, constants } from 'node:sqlite';
import { createRecordMutationRecipe, recordMutationStatement } from '../record-mutation-recipe.ts';

test('mutation recipe preserves ordered native operations and trigger effects without rerunning decisions', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE selected(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY,value TEXT); CREATE TRIGGER selection_events AFTER INSERT ON selected BEGIN INSERT INTO events(value) VALUES(new.value); END;',
  );
  const recipe = createRecordMutationRecipe(db);
  t.after(() => recipe.close());
  let decisions = 0;
  db.exec('BEGIN');
  const result = recipe.capture(() => {
    decisions++;
    recordMutationStatement(db, 'INSERT INTO selected VALUES(?,?)').run('fictional', 'first');
    recordMutationStatement(db, 'UPDATE selected SET value=? WHERE id=?').run(
      'second',
      'fictional',
    );
    recordMutationStatement(db, 'INSERT INTO selected VALUES(?,?)').run('other', 'third');
    return { selected: 'fictional' };
  });
  db.exec('ROLLBACK');
  assert.deepEqual(result, { selected: 'fictional' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM selected').get()!.n, 0);
  const statements = new Map([...recipe.sql()].map((sql) => [sql, db.prepare(sql)]));
  db.exec('BEGIN');
  recipe.replay((sql) => statements.get(sql)!);
  db.exec('COMMIT');
  assert.equal(decisions, 1);
  assert.deepEqual(
    db
      .prepare('SELECT id,value FROM selected ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 'fictional', value: 'second' },
      { id: 'other', value: 'third' },
    ],
  );
  assert.deepEqual(
    db
      .prepare('SELECT value FROM events ORDER BY id')
      .all()
      .map((row) => row.value),
    ['first', 'third'],
  );
  db.exec('BEGIN');
  assert.throws(() => recipe.replay((sql) => statements.get(sql)!), /already consumed/);
  db.exec('ROLLBACK');
});

test('mutation recipe copies blobs and preserves positional scalar binding types', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE selected(id INTEGER PRIMARY KEY,large INTEGER,text TEXT,binary BLOB,empty TEXT,real REAL)',
  );
  const recipe = createRecordMutationRecipe(db);
  t.after(() => recipe.close());
  const bytes = Buffer.from([0, 1, 255]);
  db.exec('BEGIN');
  recipe.capture(() => {
    recordMutationStatement(db, 'INSERT INTO selected VALUES(?,?,?,?,?,?)').run(
      1,
      9007199254740993n,
      'fictional "quote" \\ slash',
      bytes,
      null,
      -0,
    );
  });
  const query = db.prepare('SELECT * FROM selected');
  query.setReadBigInts(true);
  const expected = query.get();
  db.exec('ROLLBACK');
  bytes.fill(4);
  const statements = new Map([...recipe.sql()].map((sql) => [sql, db.prepare(sql)]));
  db.exec('BEGIN');
  recipe.replay((sql) => statements.get(sql)!);
  assert.deepEqual(query.get(), expected);
  db.exec('ROLLBACK');
});

test('mutation recipe refuses reentrant enrollment from a native scalar callback', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE selected(id INTEGER PRIMARY KEY,value INTEGER)');
  const recipe = createRecordMutationRecipe(db);
  t.after(() => recipe.close());
  let callback = false;
  db.function('fictional_nested', () => {
    callback = true;
    recordMutationStatement(db, 'INSERT INTO selected VALUES(?,?)').run(2, 2);
    return 1;
  });
  db.exec('BEGIN');
  assert.throws(
    () =>
      recipe.capture(() =>
        recordMutationStatement(db, 'INSERT INTO selected VALUES(1,fictional_nested())').run(),
      ),
    /recipe changed/,
  );
  db.exec('ROLLBACK');
  assert.equal(callback, true);
  assert.throws(() => [...recipe.sql()], /recipe changed/);
});

test('mutation recipe detects an unrecorded callback write when replay no longer produces it', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE selected(id INTEGER PRIMARY KEY,value INTEGER); CREATE TEMP TABLE foreign_row(value INTEGER)',
  );
  const recipe = createRecordMutationRecipe(db);
  t.after(() => recipe.close());
  let inject = true;
  db.function('fictional_effect', () => {
    if (inject) db.exec('INSERT INTO foreign_row VALUES(1)');
    return 1;
  });
  db.exec('BEGIN');
  recipe.capture(() =>
    recordMutationStatement(db, 'INSERT INTO selected VALUES(1,fictional_effect())').run(),
  );
  db.exec('ROLLBACK');
  inject = false;
  const statements = new Map([...recipe.sql()].map((sql) => [sql, db.prepare(sql)]));
  db.exec('BEGIN');
  assert.throws(() => recipe.replay((sql) => statements.get(sql)!), /recipe changed/);
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) AS n FROM selected').get()!.n, 0);
});

test('mutation recipe expires captured facades and refuses deferred capture results', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE selected(value TEXT)');
  const recipe = createRecordMutationRecipe(db);
  t.after(() => recipe.close());
  let escaped: ReturnType<typeof db.prepare> | undefined;
  db.exec('BEGIN');
  recipe.capture(() => {
    escaped = recordMutationStatement(db, 'INSERT INTO selected VALUES(?)');
    escaped.run('fictional');
  });
  db.exec('ROLLBACK');
  assert.throws(() => escaped!.run('late'), /recipe changed/);
  const deferred = createRecordMutationRecipe(db);
  t.after(() => deferred.close());
  db.exec('BEGIN');
  assert.throws(() => deferred.capture(() => Promise.resolve()), /recipe changed/);
  db.exec('ROLLBACK');
});

test('closing an unrelated recipe cannot remove the active capture owner', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE selected(id INTEGER PRIMARY KEY,value TEXT)');
  const recipe = createRecordMutationRecipe(db),
    unrelated = createRecordMutationRecipe(db);
  t.after(() => recipe.close());
  t.after(() => unrelated.close());
  db.exec('BEGIN');
  recipe.capture(() => {
    recordMutationStatement(db, 'INSERT INTO selected VALUES(?,?)').run(1, 'before');
    unrelated.close();
    assert.throws(() => recipe.close(), /recipe changed/);
    recordMutationStatement(db, 'INSERT INTO selected VALUES(?,?)').run(2, 'after');
  });
  db.exec('ROLLBACK');
  assert.equal([...recipe.sql()].length, 2);
  db.exec('BEGIN');
  recipe.replay((sql) => db.prepare(sql));
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT count(*) AS n FROM selected').get()!.n, 2);
});

test('mutation recipe rejects nested enrollment during native policy compilation', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE selected(id INTEGER PRIMARY KEY,value TEXT)');
  const recipe = createRecordMutationRecipe(db);
  t.after(() => recipe.close());
  let fired = false;
  db.setAuthorizer((action, name) => {
    if (action === constants.SQLITE_INSERT && name === 'selected') {
      fired = true;
      assert.throws(
        () => recordMutationStatement(db, "INSERT INTO selected VALUES(2,'nested')"),
        /recipe changed/,
      );
      return constants.SQLITE_DENY;
    }
    return constants.SQLITE_OK;
  });
  db.exec('BEGIN');
  assert.throws(
    () =>
      recipe.capture(() =>
        recordMutationStatement(db, "INSERT INTO selected VALUES(1,'outer')").run(),
      ),
    /not authorized/,
  );
  db.exec('ROLLBACK');
  assert.equal(fired, true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM selected').get()!.n, 0);
  assert.throws(() => [...recipe.sql()], /recipe changed/);
});

test('a leading UPDATE does not pin an unconsumed last_insert_rowid across rollback', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE selected(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO selected VALUES(99,'seed')",
  );
  const recipe = createRecordMutationRecipe(db);
  t.after(() => recipe.close());
  db.exec('BEGIN');
  let inserted: number | bigint | undefined;
  recipe.capture(() => {
    assert.equal(
      recordMutationStatement(db, 'UPDATE selected SET value=? WHERE id=?', 'changes').run(
        'updated',
        99,
      ).changes,
      1,
    );
    inserted = recordMutationStatement(db, 'INSERT INTO selected(value) VALUES(?)', 'rowid').run(
      'new',
    ).lastInsertRowid;
    recordMutationStatement(db, 'UPDATE selected SET value=? WHERE id=?').run('final', 99);
  });
  db.exec('ROLLBACK');
  assert.equal(inserted, 100);
  assert.equal(db.prepare('SELECT last_insert_rowid() AS n').get()!.n, 100);
  const statements = new Map([...recipe.sql()].map((sql) => [sql, db.prepare(sql)]));
  db.exec('BEGIN');
  recipe.replay((sql) => statements.get(sql)!);
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT value FROM selected WHERE id=99').get()!.value, 'final');
});

test('an undeclared native result read invalidates capture even when its exception is caught', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE selected(id INTEGER PRIMARY KEY,value TEXT)');
  const recipe = createRecordMutationRecipe(db);
  t.after(() => recipe.close());
  db.exec('BEGIN');
  assert.throws(
    () =>
      recipe.capture(() => {
        const result = recordMutationStatement(
          db,
          "INSERT INTO selected VALUES(1,'fictional')",
        ).run();
        assert.throws(() => result.lastInsertRowid, /recipe changed/);
      }),
    /recipe changed/,
  );
  db.exec('ROLLBACK');
  assert.throws(() => [...recipe.sql()], /recipe changed/);
});

test('mutation recipe refuses unrecorded SQL effects from genuine native compilation', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE selected(id INTEGER PRIMARY KEY,value TEXT); CREATE TEMP TABLE foreign_work(value TEXT)',
  );
  const recipe = createRecordMutationRecipe(db);
  t.after(() => recipe.close());
  let fired = false;
  db.setAuthorizer((action, name) => {
    if (!fired && action === constants.SQLITE_INSERT && name === 'selected') {
      fired = true;
      db.prepare("INSERT INTO foreign_work VALUES('unowned')").run();
    }
    return constants.SQLITE_OK;
  });
  db.exec('BEGIN');
  assert.throws(
    () =>
      recipe.capture(() => {
        recordMutationStatement(db, "INSERT INTO selected VALUES(1,'fictional')").run();
      }),
    /recipe changed/,
  );
  db.exec('ROLLBACK');
  assert.equal(fired, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM selected').get()!.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM foreign_work').get()!.n, 0);
  assert.throws(() => [...recipe.sql()], /recipe changed/);
});

test('replay refuses different native SQL before any selected row changes', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE selected(id INTEGER PRIMARY KEY,value TEXT)');
  const recipe = createRecordMutationRecipe(db);
  t.after(() => recipe.close());
  db.exec('BEGIN');
  recipe.capture(() => {
    recordMutationStatement(db, 'INSERT INTO selected(id,value) VALUES(?,?)').run(1, 'fictional');
  });
  db.exec('ROLLBACK');
  const different = db.prepare('INSERT INTO selected(id,value) VALUES(?,upper(?))');
  db.exec('BEGIN');
  assert.throws(() => recipe.replay(() => different), /recipe changed/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM selected').get()!.n, 0);
  assert.throws(() => recipe.replay((sql) => db.prepare(sql)), /already consumed/);
  db.exec('ROLLBACK');
});

test('replay uses native run without reading an overridden method', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE selected(value TEXT)');
  const recipe = createRecordMutationRecipe(db);
  t.after(() => recipe.close());
  db.exec('BEGIN');
  recipe.capture(() => {
    recordMutationStatement(db, 'INSERT INTO selected VALUES(?)').run('fictional');
  });
  db.exec('ROLLBACK');
  const statement = db.prepare([...recipe.sql()][0]!);
  let getterCalls = 0;
  Object.defineProperty(statement, 'run', {
    get() {
      getterCalls++;
      throw Error('overridden run must not be read');
    },
  });
  db.exec('BEGIN');
  recipe.replay(() => statement);
  assert.equal(getterCalls, 0);
  assert.equal(db.prepare('SELECT value FROM selected').get()!.value, 'fictional');
  db.exec('ROLLBACK');
});

test('replay rejects a spoofed statement without invoking its accessors', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE selected(value TEXT)');
  const recipe = createRecordMutationRecipe(db);
  t.after(() => recipe.close());
  db.exec('BEGIN');
  recipe.capture(() => {
    recordMutationStatement(db, 'INSERT INTO selected VALUES(?)').run('fictional');
  });
  db.exec('ROLLBACK');
  let getterCalls = 0;
  const spoof = {
    get sourceSQL() {
      getterCalls++;
      return 'INSERT INTO selected VALUES(?)';
    },
    get run() {
      getterCalls++;
      throw Error('spoofed run must not be read');
    },
  } as unknown as ReturnType<typeof db.prepare>;
  db.exec('BEGIN');
  assert.throws(() => recipe.replay(() => spoof));
  assert.equal(getterCalls, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM selected').get()!.n, 0);
  db.exec('ROLLBACK');
});
