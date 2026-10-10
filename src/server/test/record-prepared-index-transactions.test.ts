import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync, StatementSync, constants } from 'node:sqlite';
import { createRecordPreparedIndex, recordPreparedIndexBoundTo } from '../record-prepared-index.ts';

const SQL = 'SELECT ?,?,?';
function fixture(t: test.TestContext, assertRunning?: () => void) {
  let scratch: DatabaseSync | undefined;
  const exec = DatabaseSync.prototype.exec,
    probe = t.mock.method(
      DatabaseSync.prototype,
      'exec',
      function (this: DatabaseSync, sql: string) {
        const result = Reflect.apply(exec, this, [sql]);
        if (sql.startsWith('CREATE TABLE entries(')) scratch = this;
        return result;
      },
    ),
    db = new DatabaseSync(':memory:');
  try {
    const index = createRecordPreparedIndex(db, { assertRunning });
    assert.ok(scratch);
    t.after(() => {
      index.close();
      if (db.isOpen) db.close();
    });
    return { db, index, scratch };
  } catch (error) {
    db.close();
    throw error;
  } finally {
    probe.mock.restore();
  }
}

test('private index batches every actual DML run in one build transaction and commits once before seal', async (t) => {
  const prepare = DatabaseSync.prototype.prepare,
    run = StatementSync.prototype.run,
    exec = DatabaseSync.prototype.exec,
    statements = new WeakMap<StatementSync, { db: DatabaseSync; sql: string }>(),
    db = new DatabaseSync(':memory:');
  let writes = 0,
    autocommitWrites = 0,
    begins = 0,
    commits = 0,
    scratch: DatabaseSync | undefined;
  const prepareProbe = t.mock.method(
      DatabaseSync.prototype,
      'prepare',
      function (this: DatabaseSync, sql: string) {
        const statement = Reflect.apply(prepare, this, [sql]) as StatementSync;
        statements.set(statement, { db: this, sql });
        return statement;
      },
    ),
    runProbe = t.mock.method(
      StatementSync.prototype,
      'run',
      function (this: StatementSync, ...args: Parameters<typeof run>) {
        const owner = statements.get(this);
        if (owner && owner.db === scratch && /^INSERT\b/.test(owner.sql)) {
          writes++;
          if (!owner.db.isTransaction) autocommitWrites++;
        }
        return Reflect.apply(run, this, args);
      },
    ),
    execProbe = t.mock.method(
      DatabaseSync.prototype,
      'exec',
      function (this: DatabaseSync, sql: string) {
        const result = Reflect.apply(exec, this, [sql]);
        if (sql.startsWith('CREATE TABLE entries(')) scratch = this;
        if (this === scratch && sql === 'BEGIN') begins++;
        if (this === scratch && sql === 'COMMIT') commits++;
        return result;
      },
    );
  try {
    // A fresh module instance captures the probes before its native methods.
    // This isolated helper count is not a cross-module publication capability test.
    const module = (await import(
      new URL(`../record-prepared-index.ts?transaction-count=${randomUUID()}`, import.meta.url).href
    )) as typeof import('../record-prepared-index.ts');
    const index = module.createRecordPreparedIndex(db);
    try {
      assert.ok(scratch);
      assert.equal(scratch.isTransaction, true);
      for (let id = 0; id < 3; id++) {
        await index.append(SQL, [id, 'fictional', null], 0);
        assert.equal(scratch.isTransaction, true);
        assert.equal(db.isTransaction, false);
      }
      assert.equal(writes, 12);
      assert.equal(autocommitWrites, 0);
      assert.equal(begins, 1);
      assert.equal(commits, 0);
      await index.seal();
      assert.equal(scratch.isTransaction, false);
      assert.equal(db.isTransaction, false);
      assert.equal(commits, 1);
      assert.deepEqual(
        [...index.inspect()].map((row) => row.args),
        [
          [0, 'fictional', null],
          [1, 'fictional', null],
          [2, 'fictional', null],
        ],
      );
      await assert.rejects(index.seal(), /changed, escaped or expired/);
      assert.equal(commits, 1);
      const path = scratch.location()!;
      index.close();
      assert.equal(scratch.isOpen, false);
      assert.equal(existsSync(path), false);
    } finally {
      index.close();
    }
  } finally {
    execProbe.mock.restore();
    runProbe.mock.restore();
    prepareProbe.mock.restore();
    db.close();
  }
});

test('empty private build commits before immutable seal and does not begin a target transaction', async (t) => {
  const { db, index, scratch } = fixture(t);
  assert.equal(scratch.isTransaction, true);
  await index.seal();
  assert.equal(scratch.isTransaction, false);
  assert.equal(db.isTransaction, false);
  assert.deepEqual([...index.inspect()], []);
  await assert.rejects(index.append(SQL, [1, 'fictional', null], 0), /changed, escaped or expired/);
});

for (const command of ['COMMIT', 'ROLLBACK'] as const)
  for (const stage of ['append', 'seal'] as const)
    test(`private build refuses callback ${command} during ${stage} and disposes scratch`, async (t) => {
      let disturb = false,
        selected: DatabaseSync | undefined;
      const { db, index, scratch } = fixture(t, () => {
        if (disturb) {
          disturb = false;
          selected!.exec(command);
        }
      });
      selected = scratch;
      await index.append(SQL, [1, 'fictional', null], 0);
      const path = scratch.location()!;
      disturb = true;
      await assert.rejects(
        stage === 'append' ? index.append(SQL, [2, 'fictional', null], 0) : index.seal(),
        /changed, escaped or expired/,
      );
      assert.equal(recordPreparedIndexBoundTo(db, index), false);
      assert.equal(scratch.isOpen, false);
      assert.equal(existsSync(path), false);
      assert.equal(db.isOpen, true);
      assert.equal(db.isTransaction, false);
    });

test('original cancellation before private commit disposes the unfinished build', async (t) => {
  const abort = new AbortController(),
    { db, index, scratch } = fixture(t, () => abort.signal.throwIfAborted());
  await index.append(SQL, [1, 'fictional', null], 0);
  abort.abort(new DOMException('Fictional cancellation', 'AbortError'));
  await assert.rejects(index.seal(), { name: 'AbortError' });
  assert.equal(recordPreparedIndexBoundTo(db, index), false);
  assert.equal(scratch.isOpen, false);
  assert.equal(db.isTransaction, false);
});

test('private commit still obeys actual SQLite authorizer refusal and closes the build', async (t) => {
  const { db, index, scratch } = fixture(t);
  await index.append(SQL, [1, 'fictional', null], 0);
  let refused = 0;
  scratch.setAuthorizer((action, command) => {
    if (action === constants.SQLITE_TRANSACTION && command === 'COMMIT') {
      refused++;
      return constants.SQLITE_DENY;
    }
    return constants.SQLITE_OK;
  });
  await assert.rejects(index.seal());
  assert.equal(refused, 1);
  assert.equal(scratch.isOpen, false);
  assert.equal(recordPreparedIndexBoundTo(db, index), false);
  assert.equal(db.isTransaction, false);
});

test('private BEGIN refusal disposes constructor scratch without changing the target connection', (t) => {
  const db = new DatabaseSync(':memory:'),
    exec = DatabaseSync.prototype.exec;
  let scratch: DatabaseSync | undefined,
    path: string | undefined,
    refused = 0;
  const probe = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      const result = Reflect.apply(exec, this, [sql]);
      if (sql.startsWith('CREATE TABLE entries(')) {
        scratch = this;
        path = this.location()!;
        this.setAuthorizer((action, command) => {
          if (action === constants.SQLITE_TRANSACTION && command === 'BEGIN') {
            refused++;
            return constants.SQLITE_DENY;
          }
          return constants.SQLITE_OK;
        });
      }
      return result;
    },
  );
  try {
    assert.throws(() => createRecordPreparedIndex(db));
    assert.equal(refused, 1);
    assert.ok(scratch && path);
    assert.equal(scratch.isOpen, false);
    assert.equal(existsSync(path), false);
    assert.equal(db.isOpen, true);
    assert.equal(db.isTransaction, false);
  } finally {
    probe.mock.restore();
    db.close();
  }
});
