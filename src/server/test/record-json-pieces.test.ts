import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecordJsonPiecesSteps, type RecordJsonPieceWork } from '../record-json-pieces.ts';
import type { IntakeJsonCanonicalWork } from '../intake-json-canonical.ts';

function* pieces(raw: string, width = 31) {
  for (let offset = 0; offset < raw.length; offset += width)
    yield raw.slice(offset, offset + width);
}
function parsed(raw: string) {
  const steps = parseRecordJsonPiecesSteps(pieces(raw));
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

test('piece decoding matches JSON.parse duplicate-last property order escapes and binary64 values', () => {
  for (const raw of [
    '{"10":10,"2":2,"__proto__":{"fictional":true},"escaped\\u006bey":"\\ud800x\\udc00","same":0,"same":1,"array":[{},null,true,false,[-0,1e400,-1e400]]}',
    '-0',
    '0',
    'false',
    'null',
    '"\\ud83d\\ude00\\ud800\\udc00\\udfff"',
    '{"number":' + '9'.repeat(1300) + ',"tiny":1e-' + '9'.repeat(1300) + '}',
    '{"large":0.' + '0'.repeat(1200) + '1e1200,"rounded":9007199254740993,"literal":1.000}',
  ]) {
    const value = parsed(raw),
      expected = JSON.parse(raw);
    assert.deepEqual(value, expected);
    assert.equal(JSON.stringify(value), JSON.stringify(expected));
    if (value && typeof value === 'object')
      assert.equal(Object.getPrototypeOf(value), Object.prototype);
  }
});

test('giant retained string uses fixed decode windows and cancellation publishes no partial record', () => {
  const original = 'fictional-'.repeat(54000) + '\ud800\udc00\udfff',
    raw = JSON.stringify({
      contents: { details_json: JSON.stringify({ originalName: original }) },
    });
  let work: Readonly<RecordJsonPieceWork> | undefined,
    parserWork: Readonly<IntakeJsonCanonicalWork> | undefined,
    yields = 0;
  const steps = parseRecordJsonPiecesSteps(pieces(raw), {
    onWork(value) {
      work = value;
    },
    onParserWork(value) {
      parserWork = value;
    },
  });
  for (;;) {
    const next = steps.next();
    if (next.done) {
      assert.deepEqual(next.value, JSON.parse(raw));
      break;
    }
    yields++;
  }
  assert.ok(yields > 66);
  assert.equal(work!.maxScalarWindowCodeUnits, 4096);
  assert.equal(parserWork!.maxBufferBytes, 8192);
  assert.ok(work!.maxDecodedScalarCodeUnits > 480 * 1024, 'required final SQL scalar is explicit');
  let current = true,
    finalized = false;
  const canceled = parseRecordJsonPiecesSteps(
    (function* () {
      try {
        yield* pieces(raw);
      } finally {
        finalized = true;
      }
    })(),
    {
      assertRunning() {
        if (!current) throw Error('fictional owner expired');
      },
    },
  );
  assert.equal(canceled.next().done, false);
  current = false;
  assert.throws(() => canceled.next(), /fictional owner expired/);
  assert.equal(finalized, true);
  assert.throws(() => parsed('{"truncated":"unterminated'), /Invalid JSON canonical input/);
});
