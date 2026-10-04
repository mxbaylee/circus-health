import test from 'node:test';
import assert from 'node:assert/strict';
import { intakeFeedTextMatcher } from '../intake-feed-match.ts';
test('bounded feed matcher preserves whole-string lowercase search across Unicode and every boundary', () => {
  const strings = [
    'Fictional AΣ. 𝒜🩺İ clinic',
    'AΣ\u0345B AΣ\u0345. \u0345Σ',
    'AΣ' + '\u0345'.repeat(200_000) + '.',
  ];
  for (const text of strings)
    for (const query of [
      'aς',
      'aσ',
      'σ\u0345b',
      'ς\u0345.',
      '🩺i̇',
      'fictional',
      'clinic',
      'not present',
    ])
      for (const size of [1, 3, 4096]) {
        const matcher = intakeFeedTextMatcher(query);
        for (let at = 0; at < text.length; at += size) matcher.push(text.slice(at, at + size));
        assert.equal(
          matcher.finish(),
          text.toLowerCase().includes(query.toLowerCase()),
          JSON.stringify([text.slice(0, 25), query, size]),
        );
      }
});
