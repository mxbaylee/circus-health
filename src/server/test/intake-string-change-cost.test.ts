import test from 'node:test';
import assert from 'node:assert/strict';
import { intakeStringChanges } from '../intake-string-changes.ts';
import {
  applyIntakeChanges,
  intakeChanges,
  normalizeIntakeJson,
  serializeIntakeJson,
} from '../intake-state-codec.ts';
import type { ChatChange } from '../chat-journal-codec.ts';

const bytes = (changes: ChatChange[]) => Buffer.byteLength(JSON.stringify(changes));
function apply(before: string, changes: ChatChange[]): string {
  const state = applyIntakeChanges(normalizeIntakeJson({ value: before }), changes);
  return state.value as string;
}
function splice(offset: number, remove: number, text: string, path = ['value']): ChatChange {
  return { op: 'splice', path, offset, remove, text };
}

test('short changed tokens use fewer exact encoded bytes and path-bearing operations', (t) => {
  const before = '0123456789abcdef'.repeat(4),
    after = 'fedcba9876543210'.repeat(4);
  const changes = intakeStringChanges(before, after, ['value']);
  assert.equal(apply(before, changes), after);
  assert.equal(changes.length, 1);
  assert.ok(bytes(changes) <= bytes([splice(0, before.length, after)]));
  t.diagnostic(JSON.stringify({ operations: changes.length, encodedBytes: bytes(changes) }));
});

test('coalescing compares exact UTF-8 JSON cost including repeated escaped paths', () => {
  const path = ['value'];
  for (const middle of [
    'ordinary',
    String.fromCodePoint(0x1f680),
    '\u0000'.repeat(32),
    '\ud800'.repeat(32),
  ]) {
    const before = 'a' + middle + 'b',
      after = 'x' + middle + 'y';
    const original = [splice(before.length - 1, 1, 'y', path), splice(0, 1, 'x', path)];
    const changes = intakeStringChanges(before, after, path);
    assert.equal(apply(before, changes), after);
    assert.ok(bytes(changes) <= bytes(original));
    if (Buffer.byteLength(JSON.stringify(middle)) > 100) assert.equal(changes.length, 2);
    else assert.equal(changes.length, 1);
  }
  const escapedPath = ['fictional\u0000' + '\\"'.repeat(50)];
  const before = 'a' + '\u0000'.repeat(32) + 'b',
    after = 'x' + '\u0000'.repeat(32) + 'y';
  const changes = intakeStringChanges(before, after, escapedPath);
  assert.equal(changes.length, 1);
  assert.ok(
    bytes(changes) < bytes([splice(33, 1, 'y', escapedPath), splice(0, 1, 'x', escapedPath)]),
  );
});

test('distant edits omit a growing unchanged middle and cap every removed-operation bridge', () => {
  for (const size of [33, 1000, 100_000]) {
    const middle = 'm'.repeat(size),
      before = 'a' + middle + 'b',
      after = 'x' + middle + 'y';
    const changes = intakeStringChanges(before, after, ['value']);
    assert.equal(apply(before, changes), after);
    assert.equal(changes.length, 2);
    assert.equal(
      changes.reduce(
        (total, change) => total + (change.op === 'splice' ? change.text.length : 0),
        0,
      ),
      2,
    );
  }
  for (const gap of [0, 1, 31, 32, 33]) {
    const before = 'a' + 'm'.repeat(gap) + 'b',
      after = 'x' + 'm'.repeat(gap) + 'y';
    const changes = intakeStringChanges(before, after, ['value']);
    assert.equal(apply(before, changes), after);
    assert.equal(changes.length, gap <= 32 ? 1 : 2);
  }
});

test('fixed replacement admission preserves large changed content without growing merge work', () => {
  const before = 'a' + 'm'.repeat(10) + 'b',
    after = 'x'.repeat(250) + 'm'.repeat(10) + 'y';
  const changes = intakeStringChanges(before, after, ['value']);
  assert.equal(apply(before, changes), after);
  assert.equal(changes.length, 2);
  assert.equal(
    changes.reduce((total, change) => total + (change.op === 'splice' ? change.text.length : 0), 0),
    251,
  );
});

test('chained exact merges bound each bridge rather than their total retained units', () => {
  const before = 'a' + 'm'.repeat(20) + 'b' + 'n'.repeat(20) + 'c';
  const after = 'x' + 'm'.repeat(20) + 'y' + 'n'.repeat(20) + 'z';
  const changes = intakeStringChanges(before, after, ['value']);
  assert.equal(changes.length, 1);
  assert.equal(apply(before, changes), after);
});

test('optional merged replacement accepts exactly 256 units but retains 257 as two edits', () => {
  const before = 'a' + 'm'.repeat(10) + 'b';
  for (const units of [256, 257]) {
    const after = 'x'.repeat(units - 11) + 'm'.repeat(10) + 'y';
    const changes = intakeStringChanges(before, after, ['value']);
    assert.equal(changes.length, units === 256 ? 1 : 2);
    assert.equal(apply(before, changes), after);
  }
});

test('an exact equal-byte encoding does not coalesce', () => {
  let found = false;
  for (let gap = 1; gap <= 32 && !found; gap++) {
    for (let padding = 0; padding < 100 && !found; padding++) {
      const path = ['value' + 'p'.repeat(padding)];
      const middle = '\u0000'.repeat(gap);
      const original = [splice(gap + 1, 1, 'y', path), splice(0, 1, 'x', path)];
      const merged = [splice(0, gap + 2, 'x' + middle + 'y', path)];
      if (bytes(original) !== bytes(merged)) continue;
      assert.deepEqual(intakeStringChanges('a' + middle + 'b', 'x' + middle + 'y', path), original);
      found = true;
    }
  }
  assert.equal(found, true, 'fixture must exercise an exact byte tie');
});

test('bounded string coalescing preserves UTF-16 replay for deterministic edit combinations', () => {
  let seed = 0x231;
  const random = (size: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % size;
  };
  const alphabet = [
    'a',
    'b',
    'c',
    '\u0000',
    '\n',
    '"',
    '\\',
    '\ud800',
    '\udc00',
    String.fromCodePoint(0x1f680),
  ];
  for (let trial = 0; trial < 400; trial++) {
    const before = Array.from(
      { length: random(140) },
      () => alphabet[random(alphabet.length)]!,
    ).join('');
    let after = before;
    for (let edit = 0; edit < 5; edit++) {
      const at = random(after.length + 1),
        remove = Math.min(random(5), after.length - at);
      const text = Array.from({ length: random(5) }, () => alphabet[random(alphabet.length)]!).join(
        '',
      );
      after = after.slice(0, at) + text + after.slice(at + remove);
    }
    const changes = intakeStringChanges(before, after, ['value']);
    assert.equal(apply(before, changes), after, `trial ${trial}`);
    const encoded = intakeChanges(
      normalizeIntakeJson({ value: before }),
      normalizeIntakeJson({ value: after }),
    );
    assert.equal(
      serializeIntakeJson(applyIntakeChanges(normalizeIntakeJson({ value: before }), encoded)),
      JSON.stringify({ value: after }),
    );
    assert.equal(intakeStringChanges(before, before, ['value']).length, 0);
  }
});
