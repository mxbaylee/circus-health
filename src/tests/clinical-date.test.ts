import test from 'node:test';
import assert from 'node:assert/strict';
import { clinicalDatePrecision } from '../shared/clinical-date.ts';
test('clinical date validation preserves precision and rejects malformed calendar dates', () => {
  for (const [value, precision] of [
    ['', 'unknown'],
    ['2026', 'year'],
    ['2026-09', 'month'],
    ['2026-09-21', 'day'],
    ['2026-09-21T08:30:00Z', 'datetime'],
  ] as const)
    assert.equal(clinicalDatePrecision(value), precision);
  for (const value of ['garbage', '2026-13', '2026-02-30', '2026-09-31', '2026-09-21Tgarbage'])
    assert.equal(clinicalDatePrecision(value), null);
});
