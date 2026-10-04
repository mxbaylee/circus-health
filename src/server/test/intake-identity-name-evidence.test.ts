import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectSelectedEvidencedIdentity } from '../intake-identity-name-evidence.ts';
import { collectEvidencedIdentity } from '../intake-identity-policy.ts';
import { canonicalReviewValueChunks } from '../intake-review-question-state.ts';
import { selectionAuthority } from '../intake-selection-authority.ts';

const name = (n: number) =>
  'Fictional X' +
  String.fromCharCode(65 + Math.floor(n / 676)) +
  String.fromCharCode(97 + (Math.floor(n / 26) % 26)) +
  String.fromCharCode(97 + (n % 26)) +
  ' Meadow';
const canonical = (value: unknown) => [...canonicalReviewValueChunks(value)].join('');

test('native absent-subject identity preserves complete ordered conflict evidence with bounded presentation', () => {
  let visits = 0;
  let last = 'Fictional Final Reading';
  function* claims() {
    for (let n = 0; n < 1000; n++) {
      visits++;
      yield { selfSuggestion: { fullName: n === 999 ? last : name(n) } };
      if (n % 10 === 0) yield { selfSuggestion: { fullName: name(n).toUpperCase() } };
    }
  }
  const legacy = collectEvidencedIdentity(claims());
  visits = 0;
  const selected = collectSelectedEvidencedIdentity(claims);
  assert.equal(visits, 1000, 'one complete input traversal builds the bounded presentation');
  assert.deepEqual(selected.evidence, legacy.evidence);
  assert.equal(selected.conflicts.length, 1);
  const conflict = selected.conflicts[0]!;
  assert.ok(Buffer.byteLength(JSON.stringify(selected)) < 1024);
  assert.equal(conflict.evidencedValueReference?.names, 1000);
  assert.equal(
    conflict.evidencedValueReference?.bytes,
    Buffer.byteLength(legacy.conflicts[0]!.evidencedValue),
  );
  assert.equal(
    conflict.evidencedValueReference?.sha256,
    createHash('sha256').update(JSON.stringify(legacy.conflicts[0]!.evidencedValue)).digest('hex'),
  );
  assert.equal(canonical(selected), canonical(legacy));
  const token = selectionAuthority(selected);
  assert.equal(token, selectionAuthority(legacy));
  last = 'Fictional Changed Reading';
  const changed = collectSelectedEvidencedIdentity(claims);
  assert.equal(changed.conflicts[0]!.evidencedValueReference?.names, 1000);
  assert.notEqual(selectionAuthority(changed), token, 'the late same-count claim is committed');
});

test('small, unique, missing and printed-boundary evidence keeps existing identity policy', () => {
  const variants = [
    [],
    ['Fictional Fern'],
    ['Fictional Fern', 'FICTIONAL FERN'],
    ['Fictional Fern', 'Fictional Willow', 'Fictional Iris'],
  ];
  for (const values of variants) {
    const claims = () => values.map((fullName) => ({ selfSuggestion: { fullName } }));
    for (const boundary of [undefined, null, '', 'Patient: Fictional Fern']) {
      const expected = collectEvidencedIdentity(claims(), boundary);
      assert.deepEqual(collectSelectedEvidencedIdentity(claims, boundary), expected);
    }
  }
});
