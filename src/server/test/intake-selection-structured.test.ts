import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { selectionAuthority, selectionAuthorityWork } from '../intake-selection-authority.ts';
import {
  canonicalReviewValueChunks,
  registerReviewCanonicalValue,
} from '../intake-review-question-state.ts';
import { canonicalSelectionChunks } from '../intake-selection-canonical.ts';

function previous(value: unknown): string {
  const hash = createHash('sha256');
  for (const chunk of canonicalSelectionChunks(canonicalReviewValueChunks(value)))
    hash.update(chunk);
  return hash.digest('hex');
}

test('structured selection matches the complete previous recipe across nested values', () => {
  const scalars = [
    undefined,
    null,
    true,
    false,
    -0,
    1.25,
    JSON.rawJSON('12.00'),
    JSON.rawJSON('9007199254740993'),
    '',
    'Fictional \\"\n\uD800',
    'x'.repeat(8191) + '\uD83C\uDF3F',
  ];
  for (const value of scalars) {
    for (const format of [
      'intake-pair-scope-v2',
      'ordinary',
      undefined,
      JSON.rawJSON('"intake-pair-scope-v2"'),
    ]) {
      const pair = { token: value, intakeVersion: 3, requestRevision: 4, format, kept: value };
      const input = {
        record: { comparisons: [pair, , value], draftScopeStatus: { nested: pair } },
        ['k'.repeat(8191) + '\uD83C\uDF3F']: value,
        comparisonPage: [pair],
        selectionReviewToken: 'ignored',
        retained: pair,
      };
      assert.equal(selectionAuthority(input), previous(input));
    }
  }
});

test('opaque format providers and nested retained providers keep their complete recipes', () => {
  for (const encoded of ['"intake-pair-scope-v2"', '"\\u0069ntake-pair-scope-v2"']) {
    const format = {};
    registerReviewCanonicalValue(format, function* () {
      for (const character of encoded) yield character;
    });
    const value = { nested: { format, token: 'temporary', kept: 'fictional' } };
    assert.equal(selectionAuthority(value), previous(value));
  }
  const retained = {};
  registerReviewCanonicalValue(retained, () => ['{"kept":12.00,"selectionReviewToken":"old"}']);
  assert.equal(selectionAuthority({ retained }), previous({ retained }));
  const raw = JSON.rawJSON('"intake-pair-scope-v2"');
  let visits = 0;
  registerReviewCanonicalValue(raw, function* () {
    visits++;
    yield '"ordinary"';
  });
  const value = { format: raw, token: 'retained' };
  const expected = previous(value);
  visits = 0;
  assert.equal(selectionAuthority(value), expected);
  assert.equal(visits, 1);
});

test('ordinary structured selection avoids reparsing serialized field names', () => {
  const value = {
    record: {
      nested: Array.from({ length: 100 }, (_, n) => ({
        value: n,
        selectionReviewToken: 'temporary',
        retained: 'fictional',
      })),
    },
  };
  const parse = JSON.parse;
  let calls = 0;
  JSON.parse = new Proxy(parse, {
    apply(target, receiver, args) {
      calls++;
      return Reflect.apply(target, receiver, args);
    },
  });
  try {
    const expected = previous(value);
    assert.ok(calls > 300);
    calls = 0;
    assert.equal(selectionAuthority(value), expected);
    assert.equal(calls, 0);
  } finally {
    JSON.parse = parse;
  }
});

test('excluded structured fields still visit retained evidence and propagate refusal', () => {
  for (const key of [
    'comparisonPage',
    'selectionReviewToken',
    'draftScopeStatus',
    'comparisonDrafts',
  ]) {
    let visits = 0,
      closes = 0;
    const retained = {};
    registerReviewCanonicalValue(retained, function* () {
      try {
        visits++;
        yield '{"value":';
        throw Error('Fictional changed retained source');
      } finally {
        closes++;
      }
    });
    assert.throws(() => selectionAuthority({ [key]: retained }), /changed retained source/);
    assert.equal(visits, 1);
    assert.equal(closes, 1);
  }
});

test('nested streamed selection shares the surrounding depth limit', () => {
  const wrap = (value: unknown, count: number): unknown => {
    for (let n = 0; n < count; n++) value = { value };
    return value;
  };
  for (const innerDepth of [0, 1, 64]) {
    const retained = {};
    registerReviewCanonicalValue(retained, () =>
      canonicalReviewValueChunks(wrap(null, innerDepth)),
    );
    const valid = wrap(retained, 128 - innerDepth);
    assert.equal(selectionAuthority(valid), previous(valid));
    assert.throws(() => selectionAuthority(wrap(valid, 1)), /retained depth/);
    assert.throws(() => previous(wrap(valid, 1)), /retained depth/);
  }
});

test('cancelling nested opaque selection closes its provider without additional reads', () => {
  let reads = 0,
    closes = 0;
  const retained = {};
  registerReviewCanonicalValue(retained, function* () {
    try {
      reads++;
      yield '{"value":"fictional"';
      reads++;
      yield '}';
    } finally {
      closes++;
    }
  });
  const work = selectionAuthorityWork({ retained });
  while (reads === 0) assert.equal(work.next().done, false);
  work.return('');
  assert.equal(reads, 1);
  assert.equal(closes, 1);
  assert.equal(work.next().done, true);
});

test('terminal depth preserves legacy holes and format discriminator handling', () => {
  for (const terminal of [
    [],
    [undefined],
    [undefined, undefined],
    new Array(3),
    { format: 'intake-pair-scope-v2' },
    { format: 'ordinary' },
    { value: undefined },
  ]) {
    let value: unknown = terminal;
    for (let n = 0; n < 128; n++) value = { value };
    let expected: string;
    try {
      expected = previous(value);
    } catch {
      assert.throws(() => selectionAuthority(value), /retained depth/);
      continue;
    }
    assert.equal(selectionAuthority(value), expected);
  }
});
