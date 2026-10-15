import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  prepareRecordPriorFields,
  recordFieldDigest,
  recordStringFieldDigest,
} from '../record-prior-fields.ts';

function expected(raw: string) {
  const found = new Map<string, string>();
  const visit = (path: string, value: unknown) => {
    found.set(path, JSON.stringify(value));
    if (value && typeof value === 'object' && !Array.isArray(value))
      for (const key of Object.keys(value))
        visit(path + '.' + key, (value as Record<string, unknown>)[key]);
  };
  for (const [key, value] of Object.entries(JSON.parse(raw))) {
    visit(key, value);
    if (key.endsWith('_json') && typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          for (const child of Object.keys(parsed)) visit(key + '.' + child, parsed[child]);
      } catch {
        /* literal retained */
      }
    }
  }
  return found;
}

test('cooperative prior fields preserve stringify order, duplicate-last, numeric, arrays and dotted-path collisions', async () => {
  const raw =
    '{"details_json":"{\\"a\\":1,\\"a\\":2,\\"a.b\\":null,\\"a\\":{\\"b\\":3},\\"2\\":-0,\\"1\\":1e400,\\"list\\":[{\\"x\\":4}],\\"escaped\\":\\"\\\\ud800\\"}","details_json.a.b":7,"invalid_json":"no json","array_json":"[1,2]","numeric":1.000,"null":null,"missing":false,"missing":true,"escaped\\u006bey":{"z":0}}';
  const before = expected(raw),
    prepared = await prepareRecordPriorFields([raw], () => {});
  try {
    assert.deepEqual([...prepared.fields()], [...before.keys()]);
    for (const [field, value] of before)
      assert.deepEqual(prepared.get(field), recordFieldDigest(value), field);
    assert.equal(prepared.get('absent'), undefined);
    assert.notDeepEqual(prepared.get('null'), prepared.get('absent'));
  } finally {
    prepared.close();
  }
});

test('prior field count and giant scalar preparation yield and discard canceled scratch', async () => {
  const raw = JSON.stringify({
    details_json: JSON.stringify({
      name: 'x'.repeat(480 * 1024),
      ...Object.fromEntries(Array.from({ length: 130 }, (_, i) => [String(i), i])),
    }),
  });
  let turns = 0,
    active = true;
  const observe = async () => {
    while (active) {
      await setImmediate();
      turns++;
    }
  };
  const observer = observe();
  const prepared = await prepareRecordPriorFields([raw], () => {});
  try {
    assert.ok(turns > 66);
    assert.equal([...prepared.fields()].length, 132);
  } finally {
    prepared.close();
    active = false;
    await observer;
  }
  let guards = 0;
  await assert.rejects(
    prepareRecordPriorFields([raw], () => {
      if (++guards === 80) throw Error('fictional cancellation');
    }),
    /fictional cancellation/,
  );
});

test('string field comparison matches exact stringify bytes across surrogate windows and cancellation', async () => {
  for (const value of [
    '',
    '"\\\n\r\t\u0000',
    'x'.repeat(4095) + '\ud83d\ude00' + '\ud800' + 'y'.repeat(4095) + '\udc00',
    '\u2028\u2029' + 'fictional-'.repeat(8000),
  ]) {
    let checks = 0;
    assert.deepEqual(
      await recordStringFieldDigest(value, () => checks++),
      recordFieldDigest(JSON.stringify(value)),
    );
    assert.ok(checks >= 2);
  }
  let turns = 0;
  await assert.rejects(
    recordStringFieldDigest('fictional-'.repeat(8000), () => {
      if (++turns === 5) throw Error('fictional comparison cancelled');
    }),
    /comparison cancelled/,
  );
  assert.equal(turns, 5);
});

test('prior field scratch refuses SQL changes and forged point results without adopting a new baseline', async () => {
  for (const mode of ['write', 'result'] as const) {
    const original = DatabaseSync.prototype.prepare;
    let captured: DatabaseSync | undefined;
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      const statement = original.call(this, sql);
      if (sql === 'SELECT hash,bytes,signature FROM fields WHERE path=?') {
        captured = this;
        if (mode === 'result') {
          const get = statement.get;
          Object.defineProperty(statement, 'get', {
            value(...args: unknown[]) {
              const row = Reflect.apply(get, statement, args);
              return row && { ...row, hash: '0'.repeat(64) };
            },
          });
        }
      }
      return statement;
    };
    let prepared: Awaited<ReturnType<typeof prepareRecordPriorFields>>;
    try {
      prepared = await prepareRecordPriorFields(['{"fictional":"retained"}'], () => {});
    } finally {
      DatabaseSync.prototype.prepare = original;
    }
    try {
      assert.ok(captured);
      if (mode === 'write')
        captured.prepare('UPDATE fields SET hash=? WHERE path=?').run('0'.repeat(64), 'fictional');
      assert.throws(() => prepared.get('fictional'), /prior field comparison changed/);
      if (mode === 'write') assert.throws(() => [...prepared.fields()], /comparison changed/);
    } finally {
      prepared.close();
    }
  }
});
