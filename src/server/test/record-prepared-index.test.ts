import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import fs, { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { openDatabase } from '../database.ts';
import { createRecordPreparedIndex, recordPreparedIndexBoundTo } from '../record-prepared-index.ts';
import {
  prepareTerminalStatements,
  withTerminalStatements,
  terminalExecution,
  replayTerminalPreparedRecordIndex,
} from '../database-terminal-statements.ts';

function fixture(
  t: test.TestContext,
  options: Parameters<typeof createRecordPreparedIndex>[1] = {},
) {
  const db = openDatabase(':memory:', 'fictional-prepared-index');
  db.exec('CREATE TABLE values_test(id INTEGER PRIMARY KEY,value,extra)');
  const index = createRecordPreparedIndex(db, options);
  t.after(() => {
    index.close();
    db.close();
  });
  return { db, index };
}
function execution(
  db: DatabaseSync,
  index: ReturnType<typeof createRecordPreparedIndex>,
  sql = [...new Set(index.sql())],
) {
  const prepared = prepareTerminalStatements(db, {
    statements: sql.map((sql) => ({ sql })),
    executions: ['BEGIN', 'COMMIT'],
  });
  return () =>
    withTerminalStatements(db, prepared, () => {
      terminalExecution(db, 'BEGIN');
      replayTerminalPreparedRecordIndex(db, index);
      terminalExecution(db, 'COMMIT');
    });
}

test('prepared index retains typed values through its exact native database issuer once', async (t) => {
  const { db, index } = fixture(t),
    blob = Buffer.from([1, 2, 255]);
  const first = index.append(
    'INSERT INTO values_test VALUES(?,?,?)',
    [1, 'fictional\ud83d\ude80', blob],
    1,
  );
  blob.fill(0);
  await first;
  await index.append('INSERT INTO values_test VALUES(?,?,?)', [2, 9007199254740993n, null], 1);
  await index.appendCheck(
    'SELECT 1 FROM values_test WHERE id=? AND value IS ?',
    [1, 'fictional\ud83d\ude80'],
    true,
  );
  await index.appendCheck('SELECT 1 FROM values_test WHERE id=?', [3], false);
  await index.seal();
  assert.equal(recordPreparedIndexBoundTo(db, index), true);
  assert.equal(recordPreparedIndexBoundTo(db, {}), false);
  assert.equal('replay' in index, false, 'transport exposes no caller-supplied execution callback');
  const inspected = [...index.inspect()];
  assert.equal(inspected.length, 4);
  (inspected[0]!.args[2] as Uint8Array).fill(0);
  assert.deepEqual([...index.inspect()][0]!.args[2], new Uint8Array([1, 2, 255]));
  const run = execution(db, index);
  run();
  assert.throws(run);
  assert.throws(() => [...index.inspect()]);
  assert.deepEqual(
    db.prepare('SELECT extra FROM values_test WHERE id=1').get()!.extra,
    new Uint8Array([1, 2, 255]),
  );
  const query = db.prepare('SELECT value FROM values_test WHERE id=2');
  query.setReadBigInts(true);
  assert.equal(query.get()!.value, 9007199254740993n);
});

test('large prepared index scalar seals cooperatively and binds without terminal JSON or dynamic scratch methods', async (t) => {
  let terminal = false;
  const { db, index } = fixture(t, {
      assertRunning() {
        assert.equal(terminal, false, 'caller checks finish before terminal publication');
      },
    }),
    value = 'fictional-'.repeat(140000);
  let complete = false,
    turns = 0;
  const saving = (async () => {
    await index.append('INSERT INTO values_test VALUES(?,?,?)', [1, value, null], 1);
    await index.seal();
  })().finally(() => {
    complete = true;
  });
  while (!complete) {
    await setImmediate();
    turns++;
  }
  await saving;
  assert.ok(turns > 2);
  const run = execution(db, index);
  terminal = true;
  t.mock.method(JSON, 'parse', () => {
    throw Error('terminal parse');
  });
  t.mock.method(StatementSync.prototype, 'get', () => {
    throw Error('dynamic get');
  });
  t.mock.method(StatementSync.prototype, 'all', () => {
    throw Error('dynamic all');
  });
  t.mock.method(StatementSync.prototype, 'run', () => {
    throw Error('dynamic run');
  });
  run();
  t.mock.restoreAll();
  assert.equal(db.prepare('SELECT value FROM values_test').get()!.value, value);
});

test('small prepared arguments share bounded staging checkpoints without repeating owner checks per scalar', async (t) => {
  const stage = async (args: string[]) => {
    let checks = 0;
    const { db, index } = fixture(t, {
      assertRunning() {
        checks++;
      },
    });
    const sql = 'SELECT 1 WHERE ' + args.map(() => '? IS NOT NULL').join(' AND ');
    await index.appendCheck(sql, args, true);
    const stagedChecks = checks;
    await index.seal();
    assert.deepEqual([...index.inspect()][0]!.args, args);
    execution(db, index)();
    return stagedChecks;
  };
  const single = await stage(['x'.repeat(32)]),
    many = await stage(Array<string>(32).fill('x'));
  assert.ok(single > 0);
  assert.ok(many <= single + 8, `small argument staging checks: ${many}, single: ${single}`);
});

test('sealed row decoding checks physical scratch at row boundaries, not per small argument', async (t) => {
  const inspect = async (args: string[]) => {
    const { db, index } = fixture(t);
    await index.appendCheck(
      'SELECT 1 WHERE ' + args.map(() => '? IS NOT NULL').join(' AND '),
      args,
      true,
    );
    await index.seal();
    let checks = 0;
    const nativeStat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
      checks++;
      return Reflect.apply(nativeStat, fs, args);
    });
    syncBuiltinESMExports();
    try {
      assert.deepEqual([...index.inspect()][0]!.args, args);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    execution(db, index)();
    return checks;
  };
  const single = await inspect(['x'.repeat(32)]);
  const many = await inspect(Array<string>(32).fill('x'));
  assert.ok(single > 0, 'the physical witness is checked');
  assert.equal(many, single, 'one synchronous row retains a fixed number of physical checks');
});

for (const mode of ['inspect', 'consume'] as const)
  test(`prepared index refuses scratch replacement between ${mode} rows`, async (t) => {
    const { db } = fixture(t);
    let scratch: DatabaseSync | undefined;
    const original = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      const result = Reflect.apply(original, this, [sql]);
      if (sql.startsWith('CREATE TABLE entries(')) scratch = this;
      return result;
    });
    const index = createRecordPreparedIndex(db);
    t.mock.restoreAll();
    t.after(() => index.close());
    await index.append('INSERT INTO values_test VALUES(?,?,?)', [1, 'first', null], 1);
    await index.append('INSERT INTO values_test VALUES(?,?,?)', [2, 'second', null], 1);
    await index.seal();
    assert.ok(scratch);
    if (mode === 'consume') db.exec('BEGIN');
    try {
      const rows = index[mode]();
      assert.equal(rows.next().done, false);
      const path = scratch.location()!;
      writeFileSync(path + '.replacement', readFileSync(path));
      renameSync(path + '.replacement', path);
      assert.throws(() => rows.next(), /Prepared record index changed, escaped or expired/);
    } finally {
      if (db.isTransaction) db.exec('ROLLBACK');
    }
  });

for (const mode of ['unprepared-sql', 'foreign-db', 'changed-count', 'failed-predicate'] as const)
  test(`prepared index refuses ${mode}`, async (t) => {
    const { db, index } = fixture(t);
    if (mode === 'failed-predicate')
      await index.appendCheck('SELECT 1 FROM values_test WHERE id=?', [1], true);
    else
      await index.append(
        'INSERT INTO values_test VALUES(?,?,?)',
        [1, 'fictional', null],
        mode === 'changed-count' ? 2 : 1,
      );
    await index.seal();
    const target = mode === 'foreign-db' ? fixture(t).db : db;
    const run = execution(
      target,
      index,
      mode === 'unprepared-sql'
        ? ["INSERT INTO values_test VALUES(1,'different',NULL)"]
        : undefined,
    );
    assert.throws(run);
    assert.equal(db.prepare('SELECT count(*) AS n FROM values_test').get()!.n, 0);
    assert.equal(target.prepare('SELECT count(*) AS n FROM values_test').get()!.n, 0);
  });

for (const mode of ['sql-edit', 'same-byte-write', 'same-byte-replacement'] as const)
  test(`sealed prepared index refuses scratch ${mode}`, async (t) => {
    const { db } = fixture(t);
    let scratch: DatabaseSync | undefined;
    const original = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      const result = Reflect.apply(original, this, [sql]);
      if (sql.startsWith('CREATE TABLE entries(')) scratch = this;
      return result;
    });
    const index = createRecordPreparedIndex(db);
    t.mock.restoreAll();
    t.after(() => index.close());
    await index.append('INSERT INTO values_test VALUES(?,?,?)', [1, 'fictional', null], 1);
    await index.seal();
    assert.ok(scratch);
    const run = execution(db, index),
      path = scratch.location()!;
    if (mode === 'sql-edit')
      scratch
        .prepare('UPDATE argument_parts SET value=? WHERE ordinal=1')
        .run(Buffer.from('forged'));
    else {
      const bytes = readFileSync(path);
      if (mode === 'same-byte-write') writeFileSync(path, bytes);
      else {
        writeFileSync(path + '.replacement', bytes);
        renameSync(path + '.replacement', path);
      }
    }
    assert.throws(run);
    assert.equal(db.prepare('SELECT count(*) AS n FROM values_test').get()!.n, 0);
  });

test('prepared index refuses unsealed consumption and use after close', async (t) => {
  const { db, index } = fixture(t);
  await index.append('INSERT INTO values_test VALUES(?,?,?)', [1, 'fictional', null], 1);
  db.exec('BEGIN');
  assert.throws(() => [...index.consume()]);
  db.exec('ROLLBACK');
  await index.seal();
  index.close();
  assert.equal(recordPreparedIndexBoundTo(db, index), false);
  assert.throws(() => [...index.sql()]);
});

test('prepared index refuses string normalization by SQLite rather than changing the signed input', async (t) => {
  const { index } = fixture(t);
  await assert.rejects(
    index.append('INSERT INTO values_test VALUES(?,?,?)', [1, 'fictional\ud800', null], 1),
  );
});

test('prepared index cancellation closes the changed-scope transport at a bounded hash checkpoint', async (t) => {
  let checkpoints = 0;
  const { db, index } = fixture(t, {
    assertRunning() {
      if (++checkpoints === 4) throw new DOMException('Fictional cancellation', 'AbortError');
    },
  });
  await assert.rejects(
    index.append(
      'INSERT INTO values_test VALUES(?,?,?)',
      [1, 'fictional-'.repeat(140000), null],
      1,
    ),
    { name: 'AbortError' },
  );
  assert.equal(checkpoints, 4);
  assert.equal(recordPreparedIndexBoundTo(db, index), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM values_test').get()!.n, 0);
});
