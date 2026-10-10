import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashIntakeJsonScalar, hashIntakeJsonScalarSteps } from '../intake-json-scalar.ts';
const digest = (value: unknown, leading: string[] = []) =>
  createHash('sha256')
    .update(JSON.stringify([...leading, value]))
    .digest('hex');
function* pieces(text: string, width: number) {
  for (let at = 0; at < text.length; at += width) yield text.slice(at, at + width);
}
test('decoded string observations preserve escaped units and surrogate boundaries without changing canonical hashes', () => {
  const encoded = '"\\ud83c\\udf3f\\n\\ud800fictional\\udc00"';
  for (const width of [1, 3, 32]) {
    const units: string[] = [];
    const result = hashIntakeJsonScalar(pieces(encoded, width), [], (unit) => units.push(unit));
    assert.equal(units.join(''), JSON.parse(encoded));
    assert.equal(result.hash, digest(JSON.parse(encoded)));
  }
  let observed = false;
  hashIntakeJsonScalar(['42'], [], () => {
    observed = true;
  });
  assert.equal(observed, false);
});
test('streamed scalar canonical hashes preserve escapes, lone surrogates, huge strings and every chunk boundary', () => {
  for (const text of [
    '"🌿🦊"',
    '"\\ud83c\\udf3f"',
    '"\\ud800x\\udc00"',
    '"a\\n\\b\\f\\r\\t\\/\\\\\\\"z"',
    JSON.stringify('fictional🌿'.repeat(10000)),
    'true',
    'false',
    'null',
  ])
    for (const width of [1, 3, 1024])
      assert.deepEqual(
        hashIntakeJsonScalar(pieces(text, width), ['version']).hash,
        digest(JSON.parse(text), ['version']),
      );
});
test('streamed numeric hashes match JSON parse at finite extremes, midpoints and long cancelled exponents', () => {
  const values = [
    '0',
    '-0',
    '0.1',
    '1e99999',
    '-1e99999',
    '1e-99999',
    '1.7976931348623157e308',
    '1.7976931348623158e308',
    '1.7976931348623159e308',
    '2.2250738585072012e-308',
    '4.9406564584124654e-324',
    '2.4703282292062327e-324',
    '0.' + '0'.repeat(5000) + '1e5001',
    '1' + '0'.repeat(5000) + 'e-5000',
    '1.' + '0'.repeat(5000) + '1',
  ];
  const half = (5n ** 1075n).toString();
  values.push(
    '0.' + '0'.repeat(1075 - half.length) + half,
    '0.' + '0'.repeat(1075 - half.length) + half + '0'.repeat(1500) + '1',
  );
  for (const value of values)
    assert.equal(
      hashIntakeJsonScalar(pieces(value, 17)).hash,
      digest(JSON.parse(value)),
      value.slice(0, 60),
    );
});
test('invalid scalar grammar refuses instead of hashing a prefix', () => {
  for (const text of ['{}', '[]', '01', '1.', '1e', '"bad\\q"', '"unterminated', 'truefalse'])
    assert.throws(() => hashIntakeJsonScalar(pieces(text, 2)), /scalar/);
});

test('scalar hash work counts exact canonical bytes including nullable identity prefixes', () => {
  for (const token of ['"\\ud83c\\udf3f\\ud800"', 'null', '-0', '1e100', '"fictional\\nlocator"']) {
    const leading = ['proposal', null] as const,
      result = hashIntakeJsonScalar(pieces(token, 1), leading);
    assert.equal(result.bytes, Buffer.byteLength(JSON.stringify([...leading, JSON.parse(token)])));
  }
});

test('large scalar hashing batches native updates in fixed-size pieces without changing work boundaries', (t) => {
  const value = 'fictional-\ud83d\ude80-\ud800-\\"\n'.repeat(20000),
    raw = JSON.stringify(value),
    expected = digest(value),
    prototype = Object.getPrototypeOf(createHash('sha256')),
    update = prototype.update;
  let calls = 0,
    largest = 0,
    observed = 0,
    yields = 0;
  t.mock.method(prototype, 'update', function (this: unknown, piece: string, ...args: unknown[]) {
    calls++;
    largest = Math.max(largest, Buffer.byteLength(piece));
    return Reflect.apply(update, this, [piece, ...args]);
  });
  const work = hashIntakeJsonScalarSteps(pieces(raw, 4096), [], () => observed++);
  for (;;) {
    const next = work.next();
    if (next.done) {
      assert.equal(next.value.hash, expected);
      assert.equal(next.value.bytes, Buffer.byteLength(JSON.stringify([value])));
      assert.ok(calls <= Math.ceil(next.value.bytes / 4000) + 2);
      break;
    }
    yields++;
  }
  assert.equal(observed, value.length);
  assert.ok(yields >= Math.floor(raw.length / 8192));
  assert.ok(calls > 1);
  assert.ok(largest <= 4096);
});

test('abandoning buffered scalar work closes its source without consuming the suffix', () => {
  let closed = false,
    reads = 0;
  function* source() {
    try {
      yield '"';
      for (let n = 0; n < 100; n++) {
        reads++;
        yield 'x'.repeat(4096);
      }
      yield '"';
    } finally {
      closed = true;
    }
  }
  const work = hashIntakeJsonScalarSteps(source());
  assert.equal(work.next().done, false);
  const before = reads;
  work.return(undefined as never);
  assert.equal(closed, true);
  assert.equal(reads, before);
  assert.ok(reads < 100);
});
