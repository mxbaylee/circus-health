import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePhaseResult } from './qualify-oauth-refresh.ts';

test('OAuth phase parser accepts only matching, internally consistent evidence', () => {
  assert.deepEqual(
    parsePhaseResult(
      'refresh',
      JSON.stringify({ status: 'refreshed', refreshObserved: true, persistenceObserved: true }),
    ),
    { status: 'refreshed', refreshObserved: true, persistenceObserved: true },
  );
  assert.throws(() =>
    parsePhaseResult(
      'reuse',
      JSON.stringify({ status: 'refreshed', refreshObserved: true, persistenceObserved: true }),
    ),
  );
  assert.throws(() =>
    parsePhaseResult(
      'refresh',
      JSON.stringify({ status: 'refreshed', refreshObserved: false, persistenceObserved: true }),
    ),
  );
  assert.throws(() =>
    parsePhaseResult('probe', 'provider log with fictional-secret\n{"status":"ready_expired"}'),
  );
});
