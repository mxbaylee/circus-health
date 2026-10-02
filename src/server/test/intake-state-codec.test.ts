import assert from 'node:assert/strict';
import test from 'node:test';
import { chatDecodeBudget, ChatDecodeLimitError } from '../chat-journal-codec.ts';
import {
  applyIntakeChanges,
  intakeChanges,
  normalizeIntakeJson,
  serializeIntakeJson,
  type IntakeChange,
} from '../intake-state-codec.ts';

function roundTrip(before: unknown, after: unknown) {
  const initial = normalizeIntakeJson(before);
  const target = normalizeIntakeJson(after);
  const beforeBytes = serializeIntakeJson(initial);
  const changes = intakeChanges(initial, target);
  assert.equal(
    serializeIntakeJson(initial),
    beforeBytes,
    'Generating evidence must not mutate input',
  );
  const actual = applyIntakeChanges(normalizeIntakeJson(initial), changes);
  assert.equal(serializeIntakeJson(actual), serializeIntakeJson(target));
  return changes;
}

test('both one-key move directions produce one bounded operation with equal values', () => {
  assert.deepEqual(roundTrip({ a: 1, b: 1, c: 1 }, { b: 1, c: 1, a: 1 }), [
    { op: 'move-key', path: [], key: 'a', before: null },
  ]);
  assert.deepEqual(roundTrip({ a: 1, b: 1, c: 1 }, { c: 1, a: 1, b: 1 }), [
    { op: 'move-key', path: [], key: 'c', before: 'a' },
  ]);
  const payload = 'Independently fictional unchanged value.'.repeat(1000);
  const changes = roundTrip(
    { a: payload, b: payload, c: payload },
    { c: payload, a: payload, b: payload },
  );
  assert.equal(
    JSON.stringify(changes),
    JSON.stringify(roundTrip({ a: '', b: '', c: '' }, { c: '', a: '', b: '' })),
  );
});

test('value changes precede order evidence, including middle insertion and delete/reinsert', () => {
  const inserted = roundTrip({ a: 1, c: 3 }, { a: 1, b: 2, c: 3 });
  assert.deepEqual(inserted, [
    { op: 'set', path: ['b'], value: 2 },
    { op: 'move-key', path: [], key: 'b', before: 'c' },
  ]);
  const changed = roundTrip({ a: 'old', b: 'same', c: 3 }, { c: 4, a: 'new', b: 'same' });
  assert.equal(changed.at(-1)?.op, 'move-key');
  assert.ok(changed.slice(0, -1).every((entry) => entry.op !== 'move-key'));
  const removed = applyIntakeChanges(
    normalizeIntakeJson({ a: 1, b: 1, c: 1 }),
    intakeChanges(normalizeIntakeJson({ a: 1, b: 1, c: 1 }), normalizeIntakeJson({ a: 1, c: 1 })),
  );
  const reinserted = applyIntakeChanges(
    removed,
    intakeChanges(removed, normalizeIntakeJson({ a: 1, c: 1, b: 1 })),
  );
  assert.equal(serializeIntakeJson(reinserted), '{"a":1,"c":1,"b":1}');
});

test('nested and array-contained objects preserve exact order while integer-index keys use JS ordering', () => {
  const changes = roundTrip(
    {
      nested: { a: 1, b: 2 },
      array: [{ a: 1, b: 2 }, null],
      indexed: { '2': 2, '1': 1, '01': 1, '4294967295': 2, '-0': 3 },
    },
    {
      nested: { b: 2, a: 1 },
      array: [
        { b: 2, a: 1 },
        { z: 1, y: 2 },
      ],
      indexed: { '1': 1, '2': 2, '-0': 3, '01': 1, '4294967295': 2 },
    },
  );
  assert.ok(changes.some((entry) => entry.op === 'move-key' && entry.path.join('/') === 'array/0'));
  assert.ok(changes.some((entry) => entry.op === 'move-key' && entry.path.join('/') === 'nested'));
  assert.ok(changes.every((entry) => entry.op !== 'move-key' || !['1', '2'].includes(entry.key)));
  assert.deepEqual(roundTrip({ '2': 2, '1': 1 }, { '1': 1, '2': 2 }), []);
});

test('normalization declares undefined/null and Unicode/escape serialization without raw whitespace preservation', () => {
  const input = {
    omitted: undefined,
    nil: null,
    array: [undefined, , -0],
    text: '\"\\\n😀\ud800',
    nested: Object.assign(Object.create(null), { z: true, a: false }),
  };
  const normalized = normalizeIntakeJson(input);
  assert.equal(serializeIntakeJson(normalized), JSON.stringify(input));
  assert.equal(Object.hasOwn(normalized, 'omitted'), false);
  assert.deepEqual(normalized.array, [null, null, -0]);
  roundTrip(input, {
    text: '😀\udc00\\\n',
    nil: null,
    array: [undefined, null],
    nested: { a: false, z: true },
  });
  assert.equal(
    serializeIntakeJson(normalizeIntakeJson(JSON.parse(' { "b" : 1, "a" : 2 } '))),
    '{"b":1,"a":2}',
  );
  assert.equal(
    serializeIntakeJson(
      applyIntakeChanges(undefined, [{ op: 'set', path: [], value: normalized }]),
    ),
    serializeIntakeJson(normalized),
  );
});

test('move application is shallow and retains child references', () => {
  const state = normalizeIntakeJson({ a: { large: ['fictional'] }, b: { retained: true } });
  const a = state.a;
  const b = state.b;
  const actual = applyIntakeChanges(state, [{ op: 'move-key', path: [], key: 'a', before: null }]);
  assert.equal(actual, state);
  assert.equal(actual.a, a);
  assert.equal(actual.b, b);
  assert.deepEqual(Object.keys(actual), ['b', 'a']);
});

test('normalization rejects enumerable accessors and cycles without invoking getters', () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      reads++;
      return 'unexpected';
    },
  });
  assert.throws(() => normalizeIntakeJson({ nested: accessor }), /Invalid intake delta/);
  const array = Object.defineProperty([], '0', {
    enumerable: true,
    get() {
      reads++;
      return 'unexpected';
    },
  });
  assert.throws(() => normalizeIntakeJson({ array }), /Invalid intake delta/);
  assert.equal(reads, 0);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => normalizeIntakeJson(cyclic), /Invalid intake delta/);
});

test('invalid roots, prototypes, values and move schemas/paths/anchors fail explicitly', () => {
  for (const value of [
    undefined,
    null,
    [],
    true,
    1,
    'text',
    new Date(),
    Object.create({ inherited: true }),
    { x: Infinity },
    { x: NaN },
    { x: 1n },
    { x: () => 1 },
    JSON.parse('{"__proto__":1}'),
  ])
    assert.throws(() => normalizeIntakeJson(value));
  for (const change of [
    { op: 'move-key', path: [], key: 'a' },
    { op: 'move-key', path: [], key: 'a', before: null, extra: true },
    { op: 'move-key', path: [], key: 'a', before: 'a' },
    { op: 'move-key', path: [], key: 'a', before: 'missing' },
    { op: 'move-key', path: [], key: 'missing', before: null },
    { op: 'move-key', path: [], key: '1', before: null },
    { op: 'move-key', path: [], key: 'a', before: '1' },
    { op: 'move-key', path: ['values'], key: '0', before: null },
    { op: 'move-key', path: ['values', '01'], key: 'a', before: null },
    { op: 'move-key', path: ['values', '2'], key: 'a', before: null },
    { op: 'move-key', path: ['missing'], key: 'a', before: null },
    { op: 'move-key', path: ['constructor'], key: 'a', before: null },
    { op: 'move-key', path: [0], key: 'a', before: null },
    { op: 'move-key', path: [], key: 'prototype', before: null },
    { op: 'move-key', path: [], key: 'a', before: undefined },
    { op: 'move-key', path: Array(65).fill('a'), key: 'a', before: null },
  ])
    assert.throws(
      () =>
        applyIntakeChanges(normalizeIntakeJson({ a: 1, b: 2, '1': 1, values: [{ a: 1, b: 2 }] }), [
          change,
        ]),
      /Invalid intake delta/,
    );
  assert.throws(() => applyIntakeChanges(undefined, []));
  assert.throws(() => applyIntakeChanges(undefined, [{ op: 'set', path: [], value: [] }]));
  assert.throws(() => applyIntakeChanges({}, [{ op: 'set', path: [], value: {} }]));
});

test('shared decode budget charges move, path and all enumerated object members cumulatively', () => {
  const state = normalizeIntakeJson({ nested: { a: 1, b: 2, '1': 3 } });
  const change: IntakeChange = { op: 'move-key', path: ['nested'], key: 'a', before: null };
  const budget = { ...chatDecodeBudget(), operations: 5 };
  applyIntakeChanges(state, [change], budget);
  assert.equal(budget.operations, 0);
  assert.throws(() => applyIntakeChanges(state, [change], budget), ChatDecodeLimitError);
  const insufficient = { ...chatDecodeBudget(), operations: 4 };
  const fresh = normalizeIntakeJson({ nested: { a: 1, b: 2, '1': 3 } });
  const before = serializeIntakeJson(fresh);
  assert.throws(() => applyIntakeChanges(fresh, [change], insufficient), ChatDecodeLimitError);
  assert.equal(serializeIntakeJson(fresh), before);
  assert.throws(
    () => normalizeIntakeJson({ a: 1 }, { ...chatDecodeBudget(), nodes: 1 }),
    ChatDecodeLimitError,
  );
});

test('all small permutations use an LIS-minimal number of moves', () => {
  const keys = ['a', 'b', 'c', 'd'];
  function permutations(values: string[]): string[][] {
    if (!values.length) return [[]];
    return values.flatMap((value, index) =>
      permutations(values.filter((_, i) => i !== index)).map((rest) => [value, ...rest]),
    );
  }
  for (const target of permutations(keys)) {
    const changes = roundTrip(
      Object.fromEntries(keys.map((key) => [key, 1])),
      Object.fromEntries(target.map((key) => [key, 1])),
    );
    let longest = 0;
    for (let mask = 0; mask < 16; mask++) {
      const indices = target
        .filter((_, index) => mask & (1 << index))
        .map((key) => keys.indexOf(key));
      if (indices.every((value, index) => !index || value > indices[index - 1]!))
        longest = Math.max(longest, indices.length);
    }
    assert.equal(changes.length, keys.length - longest);
  }
});
