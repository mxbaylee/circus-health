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

test('array insertion, deletion and rotation retain values with scalar position evidence', () => {
  const large = 'Independently fictional retained array payload Ω. '.repeat(3000);
  const a = { id: 'a', large },
    b = { id: 'b', large },
    c = { id: 'c', large };
  for (const [before, after] of [
    [
      [a, b, c],
      [{ id: 'new' }, a, b, c],
    ],
    [
      [a, b, c],
      [a, c],
    ],
    [
      [a, b, c],
      [b, c, a],
    ],
    [
      [a, b, c],
      [c, b, a],
    ],
    [
      [a, a, b, a],
      [a, b, a],
    ],
    [
      [a, a, b, a],
      [b, a, a, a],
    ],
  ]) {
    const changes = roundTrip({ values: before }, { values: after });
    assert.ok(JSON.stringify(changes).length < 600);
    assert.ok(!JSON.stringify(changes).includes(large));
  }
  assert.deepEqual(roundTrip({ values: [a, b, c] }, { values: [b, c, a] }), [
    { op: 'array-move', path: ['values'], from: 0, to: 2 },
  ]);
  const state = normalizeIntakeJson({ values: [a, b] });
  const retained = (state.values as unknown[])[0];
  const actual = applyIntakeChanges(state, [
    { op: 'array-move', path: ['values'], from: 0, to: 1 },
  ]);
  assert.equal((actual.values as unknown[])[1], retained);
  assert.equal(roundTrip({ values: Array(2000).fill(null) }, { values: [] }).length, 1);
  assert.equal(roundTrip({ values: [] }, { values: Array(2000).fill(null) }).length, 1);
});

test('array changed-object anchors retain large members across simultaneous edits and moves', () => {
  const a = { id: 'a', payload: 'A'.repeat(100_000), version: 0 };
  const b = { id: 'b', payload: 'B'.repeat(100_000), version: 0 };
  const changes = roundTrip(
    { values: [a, b] },
    {
      values: [
        { ...b, version: 1 },
        { ...a, version: 1 },
      ],
    },
  );
  assert.ok(JSON.stringify(changes).length < 400);
  const nested = roundTrip(
    {
      values: [
        { nested: { payload: a.payload, version: 0 } },
        { nested: { payload: b.payload, version: 0 } },
      ],
    },
    {
      values: [
        { nested: { payload: b.payload, version: 1 } },
        { nested: { payload: a.payload, version: 1 } },
      ],
    },
  );
  assert.ok(JSON.stringify(nested).length < 400);
  for (const length of [1000, 100_000]) {
    const editedStrings = roundTrip(
      { values: ['A'.repeat(length), 'B'.repeat(length)] },
      { values: ['B'.repeat(length - 1) + 'b', 'A'.repeat(length - 1) + 'a'] },
    );
    assert.ok(JSON.stringify(editedStrings).length < 400);
    const allLeavesEdited = roundTrip(
      {
        values: [
          { text: 'A'.repeat(length), revision: 0 },
          { text: 'B'.repeat(length), revision: 0 },
        ],
      },
      {
        values: [
          { text: 'B'.repeat(length - 1) + 'b', revision: 1 },
          { text: 'A'.repeat(length - 1) + 'a', revision: 1 },
        ],
      },
    );
    assert.ok(JSON.stringify(allLeavesEdited).length < 600);
  }
  const unique = Array.from({ length: 8000 }, (_, index) => String.fromCharCode(1000 + index)).join(
    '',
  );
  const reverse = unique.split('').reverse().join('');
  const shiftedStrings = roundTrip(
    { values: [unique, reverse] },
    { values: ['!' + reverse.slice(0, -1), '?' + unique.slice(0, -1)] },
  );
  assert.ok(JSON.stringify(shiftedStrings).length < 600);
  const mixed = roundTrip(
    { values: [a, b, { id: 'c', payload: 'C'.repeat(100_000), version: 0 }] },
    {
      values: [
        { id: 'new' },
        { id: 'c', payload: 'C'.repeat(100_000), version: 1 },
        a,
        { ...b, version: 1 },
      ],
    },
  );
  assert.ok(JSON.stringify(mixed).length < 900);
});

test('long string distant edits, decoy anchors and UTF-16 boundaries omit retained middles', () => {
  const middle = Array.from(
    { length: 20_000 },
    (_, index) => `fiction-${index.toString(36).padStart(4, '0')}:`,
  ).join('');
  for (const shift of [0, 1, 31, 32, 33]) {
    const before = 'A'.repeat(32) + middle + 'B'.repeat(32);
    const after = 'B'.repeat(32) + 'x'.repeat(shift) + middle + 'C'.repeat(32);
    const changes = roundTrip({ text: before }, { text: after });
    const emitted = changes.reduce(
      (total, change) => total + (change.op === 'splice' ? change.text.length : 0),
      0,
    );
    assert.ok(emitted < 256, `shift ${shift} emitted ${emitted} UTF-16 units`);
  }
  const repeated = '😀\ud800Z\udc00'.repeat(40_000);
  for (const offset of [1, 31, 32, 33]) {
    const before = repeated;
    const after =
      repeated.slice(0, offset) + '\udc00new😀' + repeated.slice(offset, -offset) + '\ud800tail';
    const changes = roundTrip({ text: before }, { text: after });
    assert.ok(JSON.stringify(changes).length < 2000);
  }
  const genuine = roundTrip({ text: 'old' }, { text: 'genuinely changed '.repeat(20_000) });
  assert.ok(JSON.stringify(genuine).length > 300_000);
});

test('array delta schemas and cumulative work/depth limits refuse invalid evidence', () => {
  const state = () => normalizeIntakeJson({ values: [{ a: 1 }, { b: 2 }] });
  for (const change of [
    { op: 'array-move', path: ['values'], from: -1, to: 0 },
    { op: 'array-move', path: ['values'], from: 0, to: 2 },
    { op: 'array-move', path: ['values'], from: 0, to: 0 },
    { op: 'array-move', path: ['values'], from: 0, to: 1, extra: true },
    { op: 'array-move', path: ['values', '01'], from: 0, to: 1 },
    { op: 'array-move', path: [], from: 0, to: 1 },
    { op: 'array-splice', path: ['values'], offset: 0, remove: 3, values: [] },
    { op: 'array-splice', path: ['values'], offset: 0.5, remove: 1, values: [] },
    { op: 'array-splice', path: ['values'], offset: 0, remove: 0, values: [] },
    { op: 'array-splice', path: ['values'], offset: 0, remove: 1, values: 'bad' },
    { op: 'array-splice', path: ['values'], offset: 0, remove: 1, values: [], extra: true },
  ])
    assert.throws(() => applyIntakeChanges(state(), [change]), /Invalid intake delta/);
  const change: IntakeChange = { op: 'array-move', path: ['values'], from: 0, to: 1 };
  const budget = { ...chatDecodeBudget(), operations: 6 };
  applyIntakeChanges(state(), [change], budget);
  assert.equal(budget.operations, 0);
  assert.throws(() => applyIntakeChanges(state(), [change], budget), ChatDecodeLimitError);
  const fresh = state(),
    serialized = serializeIntakeJson(fresh);
  assert.throws(
    () =>
      applyIntakeChanges(
        fresh,
        [
          {
            op: 'array-splice',
            path: ['values'],
            offset: 0,
            remove: 1,
            values: [{ nested: { a: 1 } }],
          },
        ],
        { ...chatDecodeBudget(), nodes: 2 },
      ),
    ChatDecodeLimitError,
  );
  assert.equal(serializeIntakeJson(fresh), serialized);
  const deepPath = Array(64).fill('nested');
  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let i = 0; i < 63; i++) {
    const next = {};
    cursor.nested = next;
    cursor = next;
  }
  cursor.nested = [];
  assert.throws(
    () =>
      applyIntakeChanges(normalizeIntakeJson(deep), [
        { op: 'array-splice', path: deepPath, offset: 0, remove: 0, values: [1] },
      ]),
    /Invalid conversation delta/,
  );
});

test('distant edits in periodic strings retain whole growing cycles rather than choosing shifted duplicate anchors', () => {
  for (const size of [100, 1000, 10_000]) {
    const period = Array.from({ length: size }, (_, index) =>
      String.fromCharCode(1000 + index),
    ).join('');
    const before = period.repeat(126);
    let after = before;
    const edits: Array<[number, number, string]> = [
      [0.03, 4, 'x'],
      [0.31, 2, 'yz'],
      [0.48, 6, 'abc'],
      [0.78, 1, 'defgh'],
    ];
    for (const [fraction, remove, text] of edits) {
      const offset = Math.floor(after.length * fraction);
      after = after.slice(0, offset) + text + after.slice(offset + remove);
    }
    const changes = roundTrip({ text: before }, { text: after });
    assert.equal(changes.length, 4);
    assert.equal(
      changes.reduce(
        (total, change) => total + (change.op === 'splice' ? change.text.length : 0),
        0,
      ),
      11,
    );
  }
});

test('four distant replacements above the quick alignment distance preserve repeated growing middles', () => {
  for (const size of [1000, 10_000]) {
    const period = Array.from({ length: size }, (_, index) =>
      String.fromCharCode(1000 + index),
    ).join('');
    const before = period.repeat(126);
    let after = before;
    for (const [fraction, text] of [
      [0.03, 'x'],
      [0.31, 'y'],
      [0.48, 'z'],
      [0.78, 'w'],
    ] as const) {
      const offset = Math.floor(after.length * fraction);
      after = after.slice(0, offset) + text.repeat(100) + after.slice(offset + 100);
    }
    const changes = roundTrip({ text: before }, { text: after });
    assert.equal(changes.length, 4);
    assert.equal(
      changes.reduce((sum, change) => sum + (change.op === 'splice' ? change.text.length : 0), 0),
      400,
    );
  }
});

test('genuinely large reordered-alphabet changes remain valid, while unresolved matching exhausts explicit work bounds', () => {
  const text = Array.from({ length: 8201 }, (_, index) => String.fromCharCode(1000 + index)).join(
    '',
  );
  const changes = roundTrip({ text }, { text: text.split('').reverse().join('') });
  assert.ok(JSON.stringify(changes).length > 8000);
  assert.throws(
    () =>
      intakeChanges(
        { text: 'A'.repeat(3000) + 'B'.repeat(3000) },
        { text: 'B'.repeat(3000) + 'A'.repeat(3000) },
      ),
    ChatDecodeLimitError,
  );
});
