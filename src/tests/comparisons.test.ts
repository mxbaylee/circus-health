import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Observation, Trend } from '../shared/api.ts';
import { comparisonChart, recordsAtPoint, reviewedEventCount } from '../app/data/comparisons.ts';
import { chartPoint } from '../app/data/clinical.ts';

const result = (
  id: string,
  date: string | null,
  value: number | null,
  unit: string | null = 'mg/dL',
  extra: Partial<Observation> = {},
): Observation => ({
  id,
  testTypeId: 'test',
  label: 'Fictional measurement',
  date,
  datePrecision: 'day',
  valueText: value === null ? 'Not detected' : String(value),
  value,
  comparator: null,
  unit,
  reference: {},
  status: 'final',
  providerId: 'fictional-provider',
  provider: 'Fictional Clinic',
  sourceRecordId: `source:${id}`,
  reportId: null,
  extra: {},
  ...extra,
});
const trend = (id: string, points: Observation[]): Trend => ({
  test: {
    id,
    label: id,
    category: 'Fictional test',
    unit: points[0]?.unit ?? null,
    aliases: [],
    codes: [],
    context: null,
    count: points.length,
    numericCount: points.filter((point) => point.value !== null).length,
    firstDate: null,
    lastDate: null,
  },
  points,
  complete: true,
  unplottableCount: points.filter((point) => !chartPoint(point)).length,
});

test('reviewed preferences change chart visibility while show-both, uncertainty and filtered counterparts preserve literal alternatives', () => {
  const left = result('left', '2026-02-10', 12),
    right = result('right', '2026-02-10', 14);
  for (const point of [left, right])
    point.relationship = {
      display: {
        visibleByDefault: point.id === 'right',
        preferredRecordId: 'right',
        countGroupId: 'reviewed:pair',
        oneReviewedEvent: true,
        requiresReview: false,
      },
      hasProviderAmendment: false,
      relatedRecordIds: [point.id === 'left' ? 'right' : 'left'],
      truncated: false,
    };
  const points = [left, right];
  assert.deepEqual(
    comparisonChart([trend('a', points)]).series[0]!.points.map((point) => point.id),
    ['right'],
  );
  assert.equal(reviewedEventCount(points), 1);
  assert.deepEqual(
    points.map((point) => point.valueText),
    ['12', '14'],
    'original assertions remain unchanged',
  );
  assert.deepEqual(
    comparisonChart([trend('a', [left])]).series[0]!.points.map((point) => point.id),
    ['left'],
    'a provider filter excluding the preferred assertion does not hide its counterpart',
  );
  left.relationship!.display.visibleByDefault = true;
  right.relationship!.display.preferredRecordId = null;
  left.relationship!.display.preferredRecordId = null;
  assert.equal(comparisonChart([trend('a', points)]).series[0]!.points.length, 2);
  assert.equal(
    reviewedEventCount(points),
    1,
    'show both still represents one explicitly reviewed event',
  );
  for (const point of points) point.relationship!.display.requiresReview = true;
  assert.equal(comparisonChart([trend('a', points)]).series[0]!.points.length, 2);
  assert.equal(reviewedEventCount(points), 2, 'stale or uncertain grouping cannot claim one event');
});

test('one shared timeline sorts real dates while leaving absent comparison cells absent', () => {
  const chart = comparisonChart([
    trend('a', [result('a-late', '2026-03-20', 3), result('a-first', '2026-01-02', 1)]),
    trend('b', [result('b-only', '2026-02-10', 2)]),
  ]);
  assert.deepEqual(
    chart.series[0].points.map((point) => point.id),
    ['a-first', 'a-late'],
  );
  assert.equal(chart.rows.length, 3);
  assert.ok(chart.rows[0].time < chart.rows[1].time && chart.rows[1].time < chart.rows[2].time);
  assert.deepEqual(Object.keys(chart.rows[1].points), [chart.series[1].id]);
  assert.equal(chart.rows[1].points[chart.series[0].id], undefined);
  assert.deepEqual(
    chart.series[0].data.map((point) => point.value),
    [1, 3],
  );
});

test('only identical known units share scales; missing units stay specific to each measurement', () => {
  const chart = comparisonChart([
    trend('a', [result('a', '2026-01-01', 100)]),
    trend('b', [result('b', '2026-01-01', 50)]),
    trend('c', [result('c', '2026-01-01', 2.5, 'mmol/L')]),
    trend('d', [result('d', '2026-01-01', 70, 'kg')]),
    trend('e', [result('e', '2026-01-01', 70, null)]),
    trend('f', [result('f', '2026-01-01', 70, null)]),
  ]);
  assert.equal(chart.axes.length, 5);
  assert.equal(chart.series[0].axisId, chart.series[1].axisId);
  assert.notEqual(chart.series[0].axisId, chart.series[2].axisId);
  assert.notEqual(chart.series[4].axisId, chart.series[5].axisId);
  assert.equal(chart.series[2].points[0].value, 2.5);
  assert.equal(chart.series[3].points[0].display, '70 kg');
});

test('qualitative, bounded, uncertain and invalid dates never acquire plotted numeric values', () => {
  const omitted = [
    result('null', '2026-01-01', null),
    result('text', '2026-01-01', 0, 'mg/dL', { valueText: 'Not detected' }),
    result('bound', '2026-01-01', 5, 'mg/dL', { comparator: '<', valueText: '<5' }),
    result('range', '2026-01-01', 5, 'mg/dL', { valueText: '5–10' }),
    result('titer', '2026-01-01', 1, null, { valueText: '1:10' }),
    result('no-date', null, 4),
    result('month', '2026-01', 4, 'mg/dL', { datePrecision: 'month' }),
    result('imputed-day', '2026-01-01', 4, 'mg/dL', { datePrecision: 'month' }),
    result('unknown-precision', '2026-01-01', 4, 'mg/dL', { datePrecision: 'unknown' }),
    result('invalid-day', '2026-02-31', 4),
    result('nonfinite', '2026-01-01', Number.NaN),
    result('error', '2026-01-01', 4, 'mg/dL', { status: 'entered-in-error' }),
  ];
  omitted.forEach((point) => assert.equal(chartPoint(point), null, point.id));
  const chart = comparisonChart([trend('a', omitted)]);
  assert.deepEqual(chart.series, []);
  assert.deepEqual(chart.rows, []);
  assert.equal(chart.domain, null);
  assert.equal(chartPoint(result('zero', '2026-01-01', 0))?.value, 0);
  assert.equal(
    chartPoint(
      result('exact', '2026-01-01', 5, 'mg/dL', { comparator: '=', valueText: '5.00 mg/dL' }),
    )?.display,
    '5.00 mg/dL',
  );
});

test('lines break at known qualitative results and unit changes without replacing them with zero', () => {
  const chart = comparisonChart([
    trend('a', [
      result('one', '2026-01-01', 1),
      result('text', '2026-02-01', null),
      result('three', '2026-03-01', 3),
      result('four', '2026-04-01', 4, 'mmol/L'),
      result('five', '2026-05-01', 5),
    ]),
  ]);
  assert.equal(chart.series.length, 2);
  assert.deepEqual(
    chart.series[0].data.map((point) => point.value),
    [1, null, 3, null, 5],
  );
  assert.deepEqual(
    chart.series[0].points.map((point) => point.id),
    ['one', 'three', 'five'],
  );
  assert.equal(chart.rows.length, 4);
});

test('same-time duplicates retain every source identity and have no invented vertical sequence', () => {
  const chart = comparisonChart([
    trend('a', [
      result('second', '2026-02-01', 5),
      result('first', '2026-02-01', 5),
      result('different', '2026-02-01', 9),
    ]),
    trend('b', [result('other-unit', '2026-02-01', 5, 'kg')]),
  ]);
  const line = chart.series[0];
  assert.equal(chart.rows.length, 1);
  assert.equal(chart.rows[0].points[line.id].length, 3);
  assert.deepEqual(
    line.data.map((point) => point.value),
    [null, 9, null, null, 5, null, null, 5, null],
  );
  assert.deepEqual(
    recordsAtPoint(chart, line.id, 'first').map((record) => record.point.id),
    ['first', 'second'],
  );
  assert.deepEqual(
    recordsAtPoint(chart, line.id, 'different').map((record) => record.point.id),
    ['different'],
  );
  assert.deepEqual(recordsAtPoint(chart, line.id, 'missing'), []);
  assert.equal(recordsAtPoint(chart, chart.series[1].id, 'other-unit')[0].point.id, 'other-unit');
});

test('disjoint histories, overlapping ranges without shared dates, and empty series stay distinct', () => {
  const early = trend('early', [
    result('early-a', '2025-01-01', 1),
    result('early-b', '2025-02-01', 2),
  ]);
  const late = trend('late', [result('late-a', '2026-01-01', 3)]);
  assert.equal(comparisonChart([early, late]).overlap, 'disjoint');
  const between = trend('between', [result('middle', '2025-01-15', 3)]);
  assert.equal(comparisonChart([early, between]).overlap, 'overlap');
  assert.equal(comparisonChart([early, between]).sharedDates, 0);
  assert.equal(comparisonChart([early, trend('empty', [])]).overlap, 'insufficient');
});

test('date filters include complete boundary days and preserve exact numeric spelling', () => {
  const source = result('late', '2026-04-18T23:45:00Z', 5, 'mg/dL', {
    datePrecision: 'source-encoded instant; clock precision unverified',
    valueText: '5.000 mg/dL',
  });
  const chart = comparisonChart([trend('test', [source])], '2026-04-18', '2026-04-18');
  assert.equal(chart.domain?.[0], Date.parse('2026-04-18T00:00:00Z'));
  assert.equal(chart.domain?.[1], Date.parse('2026-04-18T23:59:59.999Z'));
  assert.equal(chart.series[0].points[0].display, '5.000 mg/dL');
  assert.equal(chart.series[0].points[0].date, source.date);
  assert.equal(source.valueText, '5.000 mg/dL');
});
