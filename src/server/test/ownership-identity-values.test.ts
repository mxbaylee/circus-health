import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ownershipSortedValues,
  ownershipDistinctValues,
  ownershipHoldMessage,
  bindOwnershipHoldMessage,
  selectedOwnershipBlockers,
} from '../ownership-identity-values.ts';
import { canonicalReviewValueChunks } from '../intake-review-question-state.ts';
import { canonicalLiteral } from '../intake-format.ts';
import { selectionAuthority } from '../intake-selection-authority.ts';

test('ownership identity sequences retain complete sort and first-occurrence uniqueness', () => {
  const values = Array.from(
    { length: 310 },
    (_, index) => 'fictional-' + String(index % 173).padStart(4, '0'),
  ).reverse();
  assert.deepEqual([...ownershipSortedValues(() => values)], [...values].sort());
  assert.deepEqual([...ownershipDistinctValues(() => values)], [...new Set(values)]);
  assert.equal(
    ownershipSortedValues(() => values).some((value) => value === 'fictional-0000'),
    true,
  );
  assert.deepEqual([...ownershipSortedValues(() => values)], [...values].sort());
});
test('oversized ownership hold retains exact complete legacy message commitments', () => {
  const values = Array.from(
    { length: 180 },
    (_, index) => 'Fictional identity question ' + index + ': ' + 'x'.repeat(500),
  );
  const legacy = {
    blocking: true,
    message: values.join(' '),
    evidencedIdentity: { fullName: 'Fictional Juniper' },
    selectionReviewToken: 'ignored',
  };
  const selected = { ...legacy, ...ownershipHoldMessage(() => values, 1024) };
  assert.ok(selected.ownershipBlockers);
  assert.equal(selected.ownershipBlockers.count, 180);
  assert.ok(selected.message.length < 100);
  bindOwnershipHoldMessage(selected, () => values);
  assert.deepEqual([...selectedOwnershipBlockers(selected.ownershipBlockers)], values);
  assert.equal([...canonicalReviewValueChunks(selected)].join(''), canonicalLiteral(legacy));
  assert.equal(
    selectionAuthority({ identityReview: selected }),
    selectionAuthority({ identityReview: legacy }),
  );
});
