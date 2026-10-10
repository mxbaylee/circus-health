import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalLiteral } from '../intake-format.ts';
import {
  structuredEvidencedIdentity,
  collectEvidencedIdentity,
} from '../intake-identity-policy.ts';

test('structured identity scans every hint with scalar unique-name and ambiguity state', () => {
  for (const last of [undefined, 'Fictional Iris Meadow', 'Fictional Cedar Vale']) {
    let visited = 0;
    const issues = function* () {
      for (let n = 0; n < 1000; n++) {
        visited++;
        yield {
          selfSuggestion: {
            fullName: n === 999 ? last || 'Fictional Iris Meadow' : 'Fictional Iris Meadow',
          },
        };
      }
    };
    const result = structuredEvidencedIdentity(issues());
    assert.equal(visited, 1000);
    assert.deepEqual(
      result,
      last === 'Fictional Cedar Vale' ? {} : { fullName: 'Fictional Iris Meadow' },
    );
    visited = 0;
    const old = collectEvidencedIdentity(issues()).evidence;
    assert.equal(visited, 1000);
    const hash = (value: unknown) =>
      createHash('sha256').update(canonicalLiteral(value)).digest('hex');
    assert.equal(hash(result), hash(old));
  }
  assert.deepEqual(structuredEvidencedIdentity([]), {});
  let distinctVisited = 0;
  const distinct = function* () {
    for (let n = 0; n < 1000; n++) {
      distinctVisited++;
      const suffix = [Math.floor(n / 676), Math.floor(n / 26) % 26, n % 26]
        .map((value) => String.fromCharCode(65 + value))
        .join('');
      yield { selfSuggestion: { fullName: 'Fictional Iris ' + suffix } };
    }
  };
  assert.deepEqual(structuredEvidencedIdentity(distinct()), {});
  assert.equal(distinctVisited, 1000);
  const spellings = [
    { selfSuggestion: { fullName: 'Fictional Iris Meadow' } },
    { selfSuggestion: { fullName: 'Fictional Iris Meadow', birthDate: '1981-01-01' } },
    { selfSuggestion: { fullName: 'Fictional Cedar Vale' } },
  ];
  assert.deepEqual(
    structuredEvidencedIdentity(spellings.slice(0, 2)),
    collectEvidencedIdentity(spellings.slice(0, 2)).evidence,
  );
  assert.deepEqual(
    structuredEvidencedIdentity(spellings),
    collectEvidencedIdentity(spellings).evidence,
  );
});
