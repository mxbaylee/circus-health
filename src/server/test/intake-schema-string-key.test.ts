import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaKey, schemaStringKey } from '../intake-envelope-schema.ts';

test('cooperative string keys preserve exact JSON hashes at Unicode and escape boundaries', async () => {
  const samples = [
    '',
    'fictional locator',
    '\\"\b\f\n\r\t\u0000\u001f',
    '\ud800',
    '\udfff',
    '\ud800\ud800\udfff\udfff',
    'x'.repeat(4095) + '\ud83d\ude80' + 'tail',
    'x'.repeat(4095) + '\ud800' + 'tail',
    'x'.repeat(4096) + '\udfff' + 'tail',
    '\u2028\u2029\uffff',
  ];
  for (const sample of samples) assert.equal(await schemaStringKey(sample), schemaKey(sample));
});

test('giant string keys serialize bounded pieces and yield between them', async (t) => {
  const value = 'fictional-\ud83d\ude80-\\"\n'.repeat(80000);
  const expected = schemaKey(value);
  const stringify = JSON.stringify;
  let calls = 0,
    largest = 0,
    ticks = 0;
  t.mock.method(JSON, 'stringify', (value: unknown) => {
    assert.equal(typeof value, 'string');
    largest = Math.max(largest, (value as string).length);
    calls++;
    return stringify(value);
  });
  const pending = schemaStringKey(value);
  const tick = setImmediate(() => ticks++);
  t.after(() => clearImmediate(tick));
  assert.equal(await pending, expected);
  assert.ok(largest <= 4096);
  assert.ok(calls >= Math.ceil(value.length / 4096));
  assert.ok(calls <= Math.ceil(value.length / 4095));
  assert.equal(ticks, 1);
});

test('cooperative string keys reject revocation at the next bounded work boundary', async () => {
  const reason = new Error('fictional owner revoked');
  let active = true,
    checks = 0;
  const tick = setImmediate(() => {
    active = false;
  });
  try {
    await assert.rejects(
      schemaStringKey('x'.repeat(1024 * 1024), () => {
        checks++;
        if (!active) throw reason;
      }),
      (error) => error === reason,
    );
    assert.equal(checks, 2);
  } finally {
    clearImmediate(tick);
  }
});
