import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intakeLogRowsForAdvance } from './helpers/intake-collection-log-evidence.ts';

test('independent append budget counts every carry boundary without AVL allowances', () => {
  const rows = Array.from({ length: 8 }, (_, count) =>
    intakeLogRowsForAdvance(
      { format: 'health-intake-state-v5', storageSequence: count, count },
      count + 1,
    ),
  );
  assert.deepEqual(rows, [2, 3, 2, 4, 2, 3, 2, 5]);
  for (const count of [1, 2, 7, 64, 128, 257]) {
    const popcount = count.toString(2).split('1').length - 1;
    assert.equal(
      intakeLogRowsForAdvance(
        { format: 'health-intake-state-v5', storageSequence: 0, count: 0 },
        count,
      ),
      3 * count - popcount,
    );
  }
});

test('V4 anchor adds exactly one immutable row regardless of retained legacy sequence', () => {
  for (const storageSequence of [1, 20, 10000]) {
    assert.equal(
      intakeLogRowsForAdvance(
        { format: 'health-intake-state-v4', storageSequence },
        storageSequence,
      ),
      0,
    );
    assert.equal(
      intakeLogRowsForAdvance(
        { format: 'health-intake-state-v4', storageSequence },
        storageSequence + 8,
      ),
      1 + 3 * 8 - 1,
    );
  }
  assert.throws(() =>
    intakeLogRowsForAdvance({ format: 'health-intake-state-v5', storageSequence: 2, count: 2 }, 1),
  );
});

test('multi-event V5 advance counts carries independently of the V4 sequence offset', () => {
  const popcount = (value: number) => value.toString(2).split('1').length - 1;
  for (const count of [3, 5, 7, 31, 128])
    for (const added of [1, 2, 6, 33]) {
      const expected = 3 * added + popcount(count) - popcount(count + added);
      for (const baseSequence of [0, 400, 10000]) {
        const storageSequence = baseSequence + count;
        assert.equal(
          intakeLogRowsForAdvance(
            { format: 'health-intake-state-v5', storageSequence, count },
            storageSequence + added,
          ),
          expected,
        );
      }
    }
});
