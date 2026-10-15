import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { openDatabase } from '../database.ts';
import { createRecordPreparedIndex } from '../record-prepared-index.ts';

test('prepared index stages bounded exact argument parts and seals without all()', async (t) => {
  const db = openDatabase(':memory:', 'fictional-prepared-parts');
  db.exec('CREATE TABLE fictional_values(id INTEGER PRIMARY KEY,value BLOB,extra TEXT)');
  let scratch: DatabaseSync | undefined;
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    const result = Reflect.apply(exec, this, [sql]);
    if (sql.startsWith('CREATE TABLE entries(')) scratch = this;
    return result;
  });
  const index = createRecordPreparedIndex(db);
  t.mock.restoreAll();
  t.after(() => {
    index.close();
    db.close();
  });
  assert.ok(scratch);

  const blob = Buffer.alloc(1024 * 1024 + 13, 0x9a);
  const text = 'a'.repeat(8191) + '\ud83d\ude80' + 'fictional\ud800\udc00'.repeat(32000);
  const saving = index.append('INSERT INTO fictional_values VALUES(?,?,?)', [1, blob, text], 1);
  blob.fill(0);
  await saving;

  const partStats = scratch
    .prepare('SELECT count(*) AS count,max(length(value)) AS max_bytes FROM argument_parts')
    .get()!;
  assert.ok((partStats.count as number) > 64);
  assert.ok((partStats.max_bytes as number) <= 16384);
  assert.equal(
    scratch.prepare('SELECT count(*) AS n FROM arguments WHERE kind=?').get('blob')!.n,
    1,
  );
  t.mock.method(StatementSync.prototype, 'all', () => {
    throw Error('unbounded argument read');
  });
  t.mock.method(StatementSync.prototype, 'iterate', () => {
    throw Error('mutable iterator transport');
  });
  await index.seal();
  const first = [...index.inspect()][0]!;
  assert.equal(first.args[2], text);
  assert.deepEqual(first.args[1], new Uint8Array(1024 * 1024 + 13).fill(0x9a));
  (first.args[1] as Uint8Array).fill(0);
  assert.equal(([...index.inspect()][0]!.args[1] as Uint8Array)[0], 0x9a);
});
