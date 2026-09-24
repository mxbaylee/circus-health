import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chartPoint, resultValue, resultUnit, unitGroups } from '../app/data/clinical.ts';
import { dateNumber, formatDate } from '../app/data/format.ts';
import { api, apiUrl } from '../app/data/api.ts';
import { selectProfile } from '../app/data/profile.ts';
import type { Observation } from '../shared/api.ts';

const observation: Observation = {
  id: 'source-result',
  testTypeId: 'test',
  label: 'A measurement',
  date: '2026-04-18',
  datePrecision: 'day',
  valueText: '5.00',
  value: 5,
  comparator: null,
  unit: 'mg/dL',
  reference: {},
  status: 'final',
  providerId: 'provider',
  provider: 'Original provider',
  sourceRecordId: 'source',
  reportId: null,
  extra: {},
};

test('partial, missing and text results remain unplottable rather than turning into invented values', () => {
  assert.equal(chartPoint({ ...observation, value: null, valueText: 'Not detected' }), null);
  assert.equal(chartPoint({ ...observation, date: '2026-04', datePrecision: 'month' }), null);
  assert.equal(chartPoint({ ...observation, date: null }), null);
  assert.equal(chartPoint({ ...observation, status: 'entered-in-error' }), null);
  assert.equal(chartPoint({ ...observation, value: Number.NaN }), null);
  assert.equal(chartPoint({ ...observation, value: 0, valueText: '0' })?.value, 0);
  assert.equal(formatDate('2026'), '2026');
  assert.equal(formatDate('2026-04'), 'April 2026');
  assert.equal(dateNumber('2026-04'), null);
});

test('bounds are retained verbatim and never plotted as exact values', () => {
  assert.equal(resultValue({ ...observation, valueText: '<5', comparator: '<' }), '<5');
  assert.equal(resultValue({ ...observation, comparator: '<' }), '<5.00');
  assert.equal(chartPoint({ ...observation, comparator: '<' }), null);
  assert.equal(chartPoint({ ...observation, comparator: '=' })?.display, '5.00 mg/dL');
});

test('mixed units keep independent scales and original numeric precision text', () => {
  const groups = unitGroups([
    observation,
    { ...observation, id: 'second', unit: 'mmol/L', valueText: '0.1293', value: 0.1293 },
  ]);
  assert.deepEqual(
    groups.map((group) => group.unit),
    ['mg/dL', 'mmol/L'],
  );
  assert.equal(groups[0].points[0].display, '5.00 mg/dL');
  assert.equal(groups[1].points[0].value, 0.1293);
});

test('profile URLs are explicit and stale profile mutations cannot retarget the active database', () => {
  selectProfile({ id: 'cedar', name: 'Fictional Cedar', placebo: false });
  const captured = apiUrl('/notes');
  assert.equal(captured, '/api/profiles/cedar/notes');
  selectProfile({ id: 'cookie-dough', name: 'Cookie Dough', placebo: true });
  assert.equal(apiUrl('/tests'), '/api/profiles/cookie-dough/tests');
  assert.throws(() => apiUrl(captured), /different profile/);
  assert.equal(apiUrl('/profiles'), '/api/profiles');
});

test('switching profiles aborts an in-flight request', async () => {
  const originalFetch = globalThis.fetch;
  selectProfile({ id: 'cedar', name: 'Fictional Cedar', placebo: false });
  let observedSignal!: AbortSignal;
  globalThis.fetch = ((_url: unknown, options: RequestInit) =>
    new Promise((_resolve, reject) => {
      observedSignal = options.signal as AbortSignal;
      observedSignal.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')),
      );
    })) as typeof fetch;
  try {
    const pending = api('/overview');
    selectProfile({ id: 'cookie-dough', name: 'Cookie Dough', placebo: true });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(observedSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('already present source units are not duplicated in result cards or chart tooltips', () => {
  const embedded = { ...observation, valueText: '5.00 mg/dL' };
  assert.equal(resultValue(embedded), '5.00 mg/dL');
  assert.equal(resultUnit(embedded), '');
  assert.equal(chartPoint(embedded)?.display, '5.00 mg/dL');
  const attached = { ...observation, valueText: '5mg/dL' };
  assert.equal(resultUnit(attached), '');
  assert.equal(chartPoint(attached)?.display, '5mg/dL');
  assert.equal(resultUnit({ ...observation, unit: '%', valueText: '5%' }), '');
  assert.equal(resultUnit({ ...observation, valueText: '2–3 mg/dL' }), '');
  assert.equal(chartPoint({ ...observation, valueText: '2–3 mg/dL' }), null);
  assert.equal(resultUnit({ ...observation, unit: 'm', valueText: 'Normal' }), 'm');
  assert.equal(resultUnit({ ...observation, valueText: '5.00 mg/dL (recorded)' }), 'mg/dL');
  assert.equal(chartPoint({ ...observation, valueText: '5.00 mg/dL (recorded)' }), null);
  assert.equal(resultUnit({ ...observation, valueText: '5.00 MG/DL' }), 'mg/dL');
  assert.equal(resultUnit({ ...observation, unit: 'mmol/L', valueText: '5 mg/dL' }), 'mmol/L');
  const longLiteral = `${'Fictional retained interpretation '.repeat(12)}mg/dL`;
  assert.ok(longLiteral.length > 256);
  assert.equal(resultUnit({ ...observation, valueText: longLiteral }), '');
  for (const [valueText, unit] of [
    ['1e', 'e'],
    ['1e+', 'e+'],
    ['1e-', 'e-'],
  ]) {
    assert.equal(resultUnit({ ...observation, valueText, unit }), unit);
    assert.equal(chartPoint({ ...observation, valueText, unit }), null);
  }
});

test('a late response is discarded even when the transport ignores cancellation', async () => {
  const originalFetch = globalThis.fetch;
  selectProfile({ id: 'cedar', name: 'Fictional Cedar', placebo: false });
  let deliver: ((response: Response) => void) | undefined;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      deliver = resolve;
    })) as typeof fetch;
  try {
    const pending = api('/overview');
    selectProfile({ id: 'cookie-dough', name: 'Cookie Dough', placebo: true });
    // Subscriber cancellation is immediate, even if the transport ignores its signal.
    await assert.rejects(pending, { name: 'AbortError' });
    deliver!(
      new Response(JSON.stringify({ data: { privateRecord: 'must not be delivered' }, meta: {} }), {
        status: 200,
      }),
    );
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invalid or imprecise calendar text is retained rather than silently normalized', () => {
  assert.equal(dateNumber('2026-02-31'), null);
  assert.equal(formatDate('2026-02-31'), '2026-02-31');
  assert.equal(formatDate('spring 2026'), 'spring 2026');
  assert.equal(formatDate('March 2026'), 'March 2026');
  assert.notEqual(dateNumber('2024-02-29'), null);
  assert.equal(chartPoint({ ...observation, valueText: '<5 mg/dL', comparator: null }), null);
});
