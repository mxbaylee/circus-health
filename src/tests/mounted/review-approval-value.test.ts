import { expect, it } from 'vitest';
import { sameReviewValue } from '../../app/features/intake/review-draft-pair-scope';

it('compares nested reviewed values across object serialization order without changing arrays or literals', () => {
  const shown = {
    mapping: { kind: 'observation', valueText: '<003.40', date: '2025-11' },
    comparisons: [
      {
        otherRecordId: 'fictional-first',
        scope: { incoming: { identity: 'fictional-incoming', version: '1' }, token: 'first' },
        reason: 'Reviewed fictional originals',
      },
      { otherRecordId: 'fictional-second', reason: 'Different fictional date' },
    ],
  };
  const selected = {
    comparisons: [
      {
        reason: 'Reviewed fictional originals',
        scope: { token: 'first', incoming: { version: '1', identity: 'fictional-incoming' } },
        otherRecordId: 'fictional-first',
      },
      { reason: 'Different fictional date', otherRecordId: 'fictional-second' },
    ],
    mapping: { date: '2025-11', valueText: '<003.40', kind: 'observation' },
  };
  expect(sameReviewValue(shown, selected)).toBe(true);
  expect(
    sameReviewValue(shown, { ...selected, comparisons: [...selected.comparisons].reverse() }),
  ).toBe(false);
  expect(
    sameReviewValue(shown, { ...selected, mapping: { ...selected.mapping, valueText: '3.40' } }),
  ).toBe(false);
  expect(sameReviewValue({ valueText: '003' }, { valueText: 3 })).toBe(false);
  expect(sameReviewValue({ optional: null }, {})).toBe(false);
});
