import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSelectionChunks } from '../intake-selection-canonical.ts';

test('selection filtering retains exact output and every input-boundary yield', () => {
  let reads = 0,
    closes = 0;
  const chunks = [
    '',
    '{"answer":"Fi',
    'ctional 🌿","selectionReviewToken":',
    '"old",',
    '"value":12.00}',
    '',
  ];
  const input = {
    [Symbol.iterator]() {
      const iterator = chunks[Symbol.iterator]();
      return {
        next() {
          reads++;
          return iterator.next();
        },
        return() {
          closes++;
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  const output: string[] = [],
    readsAtYield: number[] = [];
  for (const chunk of canonicalSelectionChunks(input)) {
    output.push(chunk);
    readsAtYield.push(reads);
  }
  assert.deepEqual(output, [
    '',
    '',
    '{',
    '"answer"',
    ':',
    '',
    '"Fictional 🌿"',
    '',
    '',
    ',',
    '"value"',
    ':',
    '12.00',
    '}',
    '',
    '',
  ]);
  assert.deepEqual(readsAtYield, [1, 2, 2, 2, 2, 3, 3, 4, 5, 5, 5, 5, 5, 5, 6, 7]);
  assert.equal(reads, chunks.length + 1);
  assert.equal(closes, 1);
});

test('selection scalar and key buffers retain complete Unicode at their size boundaries', () => {
  const prefix = 'x'.repeat(8190);
  assert.deepEqual(
    [...canonicalSelectionChunks(['"' + prefix + '\uD83C', '\uDF3Fend"'])],
    ['', '', '"' + prefix + '🌿', 'end"', ''],
  );
  const key = 'k'.repeat(511);
  assert.deepEqual(
    [...canonicalSelectionChunks(['{"' + key + '\uD83C', '\uDF3F":null}'])],
    ['', '{', '', '"' + key + '🌿', '"', ':', 'null', '}', ''],
  );
});

test('selection closes its provider on cancellation at refill and emitted-output boundaries', () => {
  for (const steps of [1, 2, 3, 5]) {
    let closes = 0,
      reads = 0;
    const source = (function* () {
      try {
        reads++;
        yield '{"answer":"fictional';
        reads++;
        yield ' answer","value":12.00}';
        reads++;
      } finally {
        closes++;
      }
    })();
    const output = canonicalSelectionChunks(source);
    for (let n = 0; n < steps; n++) assert.equal(output.next().done, false);
    const before = reads;
    output.return(undefined);
    assert.equal(closes, 1);
    assert.equal(reads, before);
    assert.equal(output.next().done, true);
  }
});

test('selection closes failed providers once and preserves cleanup-error precedence', () => {
  for (const cleanupThrows of [false, true]) {
    let reads = 0,
      closes = 0;
    const readFailure = Error('Fictional provider read failure');
    const closeFailure = Error('Fictional provider cleanup failure');
    const input = {
      [Symbol.iterator]() {
        return {
          next() {
            reads++;
            if (reads === 1) return { done: false as const, value: '{"answer":"fictional' };
            throw readFailure;
          },
          return() {
            closes++;
            if (cleanupThrows) throw closeFailure;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const output = canonicalSelectionChunks(input);
    assert.throws(
      () => [...output],
      (error) => error === (cleanupThrows ? closeFailure : readFailure),
    );
    assert.equal(reads, 2);
    assert.equal(closes, 1);
    assert.equal(output.next().done, true);
  }
});

test('selection propagates provider cleanup failure when cancelled during a refill yield', () => {
  let reads = 0,
    closes = 0;
  const closeFailure = Error('Fictional provider cancellation cleanup failure');
  const input = {
    [Symbol.iterator]() {
      return {
        next() {
          reads++;
          return { done: false as const, value: '"fictional"' };
        },
        return(): IteratorResult<string> {
          closes++;
          throw closeFailure;
        },
      };
    },
  };
  const output = canonicalSelectionChunks(input);
  assert.deepEqual(output.next(), { done: false, value: '' });
  assert.throws(
    () => output.return(undefined),
    (error) => error === closeFailure,
  );
  assert.equal(reads, 1);
  assert.equal(closes, 1);
  assert.equal(output.next().done, true);
});

test('selection refuses incomplete structures, trailing evidence and excessive retained depth', () => {
  for (const text of [
    '',
    '{',
    '[',
    '"unfinished',
    '{"answer"?0}',
    '{"answer":}',
    '[0:1,',
    'null{}',
    '['.repeat(130) + 'null' + ']'.repeat(130),
  ]) {
    let closes = 0;
    const source = (function* () {
      try {
        for (let n = 0; n < text.length; n++) yield text[n];
      } finally {
        closes++;
      }
    })();
    assert.throws(
      () => [...canonicalSelectionChunks(source)],
      /canonical selected|retained depth/i,
    );
    assert.equal(closes, 1);
  }
});
