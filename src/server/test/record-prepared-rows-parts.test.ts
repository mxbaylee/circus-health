import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { createRecordPreparedRows } from '../record-prepared-rows.ts';

function fixture(t: test.TestContext) {
  let scratch: DatabaseSync | undefined;
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    const result = Reflect.apply(exec, this, [sql]);
    if (sql.startsWith('CREATE TABLE rows(')) scratch = this;
    return result;
  });
  const rows = createRecordPreparedRows();
  t.mock.restoreAll();
  t.after(() => rows.close());
  assert.ok(scratch);
  return { rows, scratch };
}

test('prepared rows return signed UTF-8 pieces through bounded native point reads', (t) => {
  const { rows, scratch } = fixture(t);
  const raw = JSON.stringify({
    id: 'fictional',
    value: 'a'.repeat(4095) + '\ud83d\ude80' + 'v'.repeat(1024 * 1024),
  });
  rows.append(raw);
  rows.append('{"id":"second-fictional"}');
  rows.seal();
  const stats = scratch
    .prepare('SELECT count(*) AS n,max(length(value)) AS max_bytes FROM row_parts')
    .get()!;
  assert.ok((stats.n as number) > 64);
  assert.ok((stats.max_bytes as number) <= 16384);
  t.mock.method(StatementSync.prototype, 'all', () => {
    throw Error('whole native row');
  });
  t.mock.method(StatementSync.prototype, 'iterate', () => {
    throw Error('mutable native iterator');
  });
  const result: string[] = [];
  for (const pieces of rows.pieceRows()) result.push([...pieces].join(''));
  assert.deepEqual(result, [raw, '{"id":"second-fictional"}']);
  assert.equal(rows.work().readBytes, Buffer.byteLength(result.join('')));
  assert.equal(rows.work().readParts, stats.n);
  assert.ok(rows.work().maxPartBytes <= 16384);
  assert.deepEqual([...rows.values()], result);
});

test('prepared rows refuse changed SQL pieces and poison the transport', (t) => {
  const { rows, scratch } = fixture(t);
  rows.append('{"id":"fictional"}');
  rows.seal();
  scratch
    .prepare('UPDATE row_parts SET value=? WHERE position=0 AND part=0')
    .run(Buffer.from('forged'));
  assert.throws(() => [...rows.values()]);
  assert.throws(() => [...rows.pieceRows()]);
});

test('prepared rows poison an abandoned inner stream and reject malformed text', (t) => {
  const { rows } = fixture(t);
  rows.append('{"id":"fictional","text":"' + 'x'.repeat(20000) + '"}');
  rows.seal();
  const outer = rows.pieceRows(),
    inner = outer.next().value!;
  assert.equal(inner[Symbol.iterator]().next().done, false);
  inner[Symbol.iterator]().return?.();
  assert.throws(() => outer.next());
  assert.throws(() => [...rows.values()]);

  const invalid = createRecordPreparedRows();
  t.after(() => invalid.close());
  assert.throws(() => invalid.append('fictional\ud800'));
  assert.throws(() => invalid.seal());
});
