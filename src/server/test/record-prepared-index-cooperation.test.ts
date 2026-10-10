import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database.ts';
import { createRecordPreparedIndex, recordPreparedIndexBoundTo } from '../record-prepared-index.ts';
import {
  prepareTerminalStatements,
  withTerminalStatements,
  terminalExecution,
  replayTerminalPreparedRecordIndex,
} from '../database-terminal-statements.ts';

function fixture(t: test.TestContext, assertRunning?: () => void) {
  const db = openDatabase(':memory:', 'fictional-signing-cooperation');
  db.exec('CREATE TABLE values_test(id INTEGER PRIMARY KEY,value,extra)');
  const index = createRecordPreparedIndex(db, { assertRunning });
  t.after(() => {
    index.close();
    if (db.isOpen) db.close();
  });
  return { db, index };
}
const SQL = 'INSERT INTO values_test VALUES(?,?,?)';
const ROWS = 64;
async function appendTiny(index: ReturnType<typeof createRecordPreparedIndex>) {
  for (let id = 0; id < ROWS; id++) await index.append(SQL, [id, 'fictional', null], 1);
}

test('prepared index seal shares one bounded piece budget across tiny rows', async (t) => {
  let checks = 0;
  const { db, index } = fixture(t, () => checks++);
  await appendTiny(index);
  checks = 0;
  await index.seal();
  // Each row signs one header, SQL, three type frames and two scalar values.
  assert.equal(checks, 4 + 2 * ((ROWS * 7) / 64));
  const rows = [...index.inspect()];
  assert.equal(rows.length, ROWS);
  for (let id = 0; id < ROWS; id++)
    assert.deepEqual(rows[id], {
      sql: SQL,
      args: [id, 'fictional', null],
      mode: 'run',
      expected: 1,
    });
  const prepared = prepareTerminalStatements(db, {
    statements: [{ sql: SQL }],
    executions: ['BEGIN', 'COMMIT'],
  });
  const run = () =>
    withTerminalStatements(db, prepared, () => {
      terminalExecution(db, 'BEGIN');
      replayTerminalPreparedRecordIndex(db, index);
      terminalExecution(db, 'COMMIT');
    });
  run();
  assert.equal(db.prepare('SELECT count(*) AS n FROM values_test').get()!.n, ROWS);
  assert.throws(run, /Foreign, expired or unprepared terminal database statement/);
  db.exec('BEGIN');
  try {
    assert.throws(() => [...index.consume()], /changed, escaped or expired/);
  } finally {
    db.exec('ROLLBACK');
  }
  assert.throws(() => [...index.inspect()], /changed, escaped or expired/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM values_test').get()!.n, ROWS);
});

test('coalesced signing preserves the original exact HMAC framing for all scalar types and split surrogate pairs', async (t) => {
  let scratch: DatabaseSync | undefined,
    key: Buffer | undefined,
    checks = 0;
  const exec = DatabaseSync.prototype.exec,
    hmac = crypto.createHmac,
    execProbe = t.mock.method(
      DatabaseSync.prototype,
      'exec',
      function (this: DatabaseSync, sql: string) {
        const result = Reflect.apply(exec, this, [sql]);
        if (sql.startsWith('CREATE TABLE entries(')) scratch = this;
        return result;
      },
    ),
    hmacProbe = t.mock.method(crypto, 'createHmac', (...args: Parameters<typeof hmac>) => {
      if (Buffer.isBuffer(args[1])) key = Buffer.from(args[1]);
      return Reflect.apply(hmac, crypto, args);
    });
  syncBuiltinESMExports();
  try {
    const { index } = fixture(t, () => checks++),
      sql = 'SELECT ?,?,?,?,?,?,?',
      text = 'x'.repeat(8191) + '\ud83d\ude80' + 'y'.repeat(25000),
      blob = Buffer.from([0, 128, 255]);
    await index.append(sql, [1, -0, 9007199254740993n, null, '', text, blob], 0);
    hmacProbe.mock.restore();
    execProbe.mock.restore();
    syncBuiltinESMExports();
    assert.ok(key && scratch);
    const expected = hmac('sha256', key);
    expected.update(JSON.stringify([0, 'run', 0, 7, sql.length]));
    expected.update(sql, 'utf16le');
    for (const [kind, value] of [
      ['number', '1'],
      ['number', '-0'],
      ['bigint', '9007199254740993'],
      ['null', null],
      ['string', ''],
      ['string', text],
      ['blob', blob],
    ] as const) {
      expected.update(JSON.stringify([kind, value?.length ?? null]));
      if (typeof value === 'string') expected.update(value, 'utf16le');
      else if (value !== null) expected.update(value);
    }
    assert.equal(
      scratch.prepare('SELECT signature FROM entries WHERE position=0').get()!.signature,
      expected.digest('hex'),
    );
    checks = 0;
    await index.seal();
    assert.ok(checks > 8, 'large UTF-16 content still crosses guarded cooperative byte bounds');
    const inspected = [...index.inspect()][0]!;
    assert.equal(inspected.args[5], text);
    assert.ok(Object.is(inspected.args[1], -0));
    assert.equal(inspected.args[2], 9007199254740993n);
    assert.deepEqual(inspected.args[6], new Uint8Array(blob));
  } finally {
    hmacProbe.mock.restore();
    execProbe.mock.restore();
    syncBuiltinESMExports();
    key?.fill(0);
  }
});

for (const fault of ['cancellation', 'scratch-mutation', 'owner-close'] as const)
  test(`coalesced seal refuses ${fault} across an actual yield and closes transport`, async (t) => {
    const abort = new AbortController();
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
      );
    const { db, index } = fixture(t, () => abort.signal.throwIfAborted());
    probe.mock.restore();
    await appendTiny(index);
    const sealing = index.seal();
    assert.ok(scratch);
    if (fault === 'cancellation')
      abort.abort(new DOMException('Fictional cancellation', 'AbortError'));
    else if (fault === 'scratch-mutation')
      scratch
        .prepare('UPDATE arguments SET value=? WHERE position=? AND ordinal=1')
        .run('forged', ROWS - 1);
    else db.close();
    await assert.rejects(
      sealing,
      fault === 'cancellation' ? { name: 'AbortError' } : /changed, escaped or expired/,
    );
    assert.equal(recordPreparedIndexBoundTo(db, index), false);
    assert.equal(scratch.isOpen, false);
    assert.throws(() => [...index.inspect()], /changed, escaped or expired/);
    if (db.isOpen) assert.equal(db.prepare('SELECT count(*) AS n FROM values_test').get()!.n, 0);
  });

test('coalesced seal refuses reentry without changing the pending legitimate seal', async (t) => {
  const { index } = fixture(t);
  await appendTiny(index);
  const sealing = index.seal();
  await assert.rejects(index.append(SQL, [1000, 'forged', null], 1), /changed, escaped or expired/);
  await assert.rejects(index.seal(), /changed, escaped or expired/);
  await sealing;
  assert.equal([...index.inspect()].length, ROWS);
});
