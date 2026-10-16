import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSourceDetailsLikeMatcher } from '../source-details-like.ts';

test('streaming LIKE equals SQLite across Unicode, NUL, wildcard and UTF-16 chunk boundaries', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const oracle = db.prepare('SELECT ? LIKE ? result');
    const texts = [
      '',
      'a',
      'ABc',
      'ΩωÄä',
      'a😀b',
      'KkſsßSSéÉe\u0301\ufffe\uffff\u{10ffff}',
      'x\ud800y',
      'x\udc00y',
      'a\0tail',
      'a%b_c\\d',
      'abababac',
      'a'.repeat(63) + 'b',
    ];
    const patterns = [
      '',
      '%',
      '_',
      '__',
      '%a%',
      '%A%',
      '%Ω%',
      '%ω%',
      '%Ä%',
      '%ä%',
      '%😀%',
      '%K%',
      '%k%',
      '%ſ%',
      '%s%',
      '%ß%',
      '%SS%',
      '%é%',
      '%É%',
      '%\uffff%',
      '%\u{10ffff}%',
      '%\ud800%',
      '%\udc00%',
      '%a\0ignored%',
      'a%b_c\\d',
      'a%%b%',
      '%a_b%',
      '%a%a%c',
      '_'.repeat(64),
      '%' + 'a'.repeat(63) + 'b',
    ];
    for (const text of texts)
      for (const pattern of patterns) {
        const expected = !!oracle.get(text, pattern)!.result;
        for (let split = 0; split <= text.length; split++) {
          const matcher = createSourceDetailsLikeMatcher(pattern);
          matcher.write(text.slice(0, split));
          matcher.write('');
          matcher.write(text.slice(split));
          assert.equal(matcher.finish(), expected, JSON.stringify({ text, pattern, split }));
        }
      }
    // Deterministic generated adversarial corpus is evaluated by SQLite itself.
    let seed = 937;
    const alphabet = ['a', 'A', 'b', '%', '_', 'Ω', 'ω', '😀', '\0', '\ud800'];
    const random = () => (seed = (seed * 16807) % 2147483647);
    for (let example = 0; example < 1200; example++) {
      const text = Array.from(
        { length: random() % 50 },
        () => alphabet[random() % alphabet.length],
      ).join('');
      const pattern = Array.from(
        { length: random() % 20 },
        () => alphabet[random() % alphabet.length],
      ).join('');
      const matcher = createSourceDetailsLikeMatcher(pattern);
      for (let index = 0; index < text.length; index += 3)
        matcher.write(text.slice(index, index + 3));
      assert.equal(
        matcher.finish(),
        !!oracle.get(text, pattern)!.result,
        JSON.stringify({ text, pattern }),
      );
    }
  } finally {
    db.close();
  }
});

test('pattern refusal equals SQLite byte budget and source traversal retains no corpus text', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const pattern of ['a'.repeat(50_001), 'Ω'.repeat(25_001), '%\0' + 'a'.repeat(50_000)]) {
      assert.throws(() => db.prepare('SELECT ? LIKE ?').get('a', pattern), /too complex/);
      assert.throws(() => createSourceDetailsLikeMatcher(pattern), /too complex/);
    }
    const matcher = createSourceDetailsLikeMatcher('%a_b%');
    const retained = matcher.retainedBytes;
    for (let chunk = 0; chunk < 100_000; chunk++) matcher.write('fictional text '.repeat(20));
    matcher.write('a😀b');
    assert.equal(matcher.finish(), true);
    assert.equal(matcher.retainedBytes, retained);
    assert.ok(retained < 100);
    const permitted = '%'.repeat(50_000);
    assert.equal(
      createSourceDetailsLikeMatcher(permitted).finish(),
      !!db.prepare('SELECT ? LIKE ? result').get('', permitted)!.result,
    );
  } finally {
    db.close();
  }
});
