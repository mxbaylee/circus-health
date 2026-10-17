import assert from 'node:assert/strict';
import type { IntakeCollectionHeadV4 } from '../../intake-state-evidence.ts';
import type { Head as IntakeLogHead } from '../../intake-state-log.ts';
type CountedHead =
  | Pick<IntakeCollectionHeadV4, 'format' | 'storageSequence'>
  | Pick<IntakeLogHead, 'format' | 'storageSequence' | 'count'>;

/** Independent carry arithmetic for test write bounds. Each event adds one
 * receipt/transition leaf, one peak and one merge per trailing set bit. */
export function intakeLogRowsForAdvance(before: CountedHead, afterSequence: number) {
  assert.ok(Number.isSafeInteger(afterSequence) && afterSequence >= before.storageSequence);
  let count = before.format === 'health-intake-state-v5' ? before.count : 0;
  let rows =
    before.format === 'health-intake-state-v4' && afterSequence > before.storageSequence ? 1 : 0;
  for (let sequence = before.storageSequence; sequence < afterSequence; sequence++, count++) {
    rows += 2;
    for (let carry = count; carry % 2 === 1; carry = Math.floor(carry / 2)) rows++;
  }
  return rows;
}
