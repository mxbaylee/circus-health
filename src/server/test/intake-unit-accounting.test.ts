import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPendingReadingUnit } from '../intake-unit-accounting.ts';
import type { IntakeExtractionPlan } from '../../shared/intake.ts';

test('coordinator and assistant select an unreceipted unit even when its display status says completed', () => {
  // An unreceipted status/coverage update cannot reset the stall streak by
  // making the coordinator and assistant choose different source units.
  const plan = {
    batches: [],
    units: [
      {
        id: 'fictional-first',
        locator: 'Page 1',
        status: 'completed',
        coverage: { unitId: 'fictional-first', kind: 'context', notes: 'Fictional context' },
      },
      { id: 'fictional-second', locator: 'Page 2', status: 'pending' },
    ],
  } as unknown as IntakeExtractionPlan;
  assert.equal(nextPendingReadingUnit(plan)?.id, 'fictional-first');
});
