import test from 'node:test';
import assert from 'node:assert/strict';
import type { Observation } from '../shared/api.ts';
import { deriveMeasurement, type MeasurementInput } from '../shared/measurement.ts';
import { MEASUREMENT_RULE_VERSION } from '../shared/measurement-units.ts';
import {
  transformTrendMeasurements,
  measurementChartDetails,
  type MeasurementChartObservation,
  type MeasurementChartTrend,
} from '../app/data/measurementChart.ts';
import { comparisonChart } from '../app/data/comparisons.ts';
function point(
  id: string,
  valueText = '1.20',
  unit = 'mg/dL',
  target = 'mg/L',
  comparator: string | null = null,
): MeasurementChartObservation {
  const reference = {
    profileId: 'fictional-chart',
    kind: 'observation' as const,
    recordId: id,
    sourceRecordId: 'source:' + id,
    identity: 'identity:' + id,
    version: 'v1',
    stateHash: 'state:' + id,
    evidenceHash: 'evidence:' + id,
  };
  const input: MeasurementInput = {
    reference,
    source: { valueText, unit, comparator },
    binding: {
      decisionId: 'semantic:' + id,
      reference,
      rulesVersion: MEASUREMENT_RULE_VERSION,
      subject: 'self',
      semantics: {
        quantity: 'fictional:analyte',
        dimension: unit === 'kg' || unit === '[lb_av]' ? 'mass' : 'mass_concentration',
        region: 'not_applicable',
        specimen: 'fictional:serum',
        method: 'fictional:method',
        meaning: 'measured_quantity',
      },
      precision: null,
    },
  };
  return {
    id,
    testTypeId: 'fictional-test',
    label: 'Fictional measurement',
    date: '2026-02-10',
    datePrecision: 'day',
    valueText,
    value: Number(valueText.replace(/^[<>=~≈≤≥]+/, '')),
    comparator,
    unit,
    reference: {
      text: 'Age-specific fictional range: see original',
      low: '0.2',
      high: '1.8',
      unit,
    },
    status: 'final',
    providerId: 'fictional',
    provider: 'Fictional Clinic',
    sourceRecordId: 'source:' + id,
    reportId: null,
    extra: {},
    measurement: deriveMeasurement(input, target, 3),
  };
}
const trend = (points: MeasurementChartObservation[]): MeasurementChartTrend => ({
  test: {
    id: 'fictional-test',
    label: 'Fictional measurement',
    category: 'Fictional test',
    unit: points[0]?.unit || null,
    aliases: [],
    codes: [],
    context: null,
    count: points.length,
    numericCount: points.length,
    firstDate: null,
    lastDate: null,
  },
  points,
  complete: true,
  unplottableCount: 0,
});

test('converted plotting copies keep all exact same-day source assertions and original ranges outside converted axes', () => {
  const input = [trend([point('first'), point('second', '12.0', 'mg/L')])],
    before = structuredClone(input);
  const view = transformTrendMeasurements(input);
  assert.deepEqual(input, before);
  assert.deepEqual(
    view[0]!.points.map((p) => p.value),
    [12, 12],
  );
  assert.deepEqual(
    view[0]!.points.map((p) => p.unit),
    ['mg/L', 'mg/L'],
  );
  assert.ok(view[0]!.points.every((p) => p.reference === null));
  const info = measurementChartDetails(view[0]!.points[0]!);
  assert.equal(info.originalDisplay, '1.20 mg/dL');
  assert.deepEqual(info.original.reference, before[0]!.points[0]!.reference);
  assert.equal(info.referenceLabel, 'Reference range (original, not converted)');
  const chart = comparisonChart(view);
  assert.equal(chart.series[0]!.points.length, 2);
  assert.equal(chart.rows[0]!.points[chart.series[0]!.id]!.length, 2);
  assert.deepEqual(transformTrendMeasurements(view), view);
});

test('chart details display an exact inline unit once without changing the retained source', () => {
  const value = point('inline', '<= +1.20 mg/dL', 'mg/dL', 'mg/L', '<=');
  value.value = 1.2;
  const before = structuredClone(value);
  const info = measurementChartDetails(value);
  assert.equal(info.originalDisplay, '<= +1.20 mg/dL');
  assert.equal(info.original.valueText, '<= +1.20 mg/dL');
  assert.equal(info.original.unit, 'mg/dL');
  assert.deepEqual(value, before);
});

test('bounded and approximate roles never acquire chart points even when a source numeric value exists', () => {
  const bounds = [
    point('a', '<1.20'),
    point('b', '1.20', 'mg/dL', 'mg/L', '<'),
    point('c', '~1.20'),
    point('d', '1.20', 'mg/dL', 'mg/L', '~'),
  ];
  assert.ok(bounds.every((p) => p.value !== null));
  const view = transformTrendMeasurements([trend(bounds)]);
  assert.ok(view[0]!.points.every((p) => p.value === null));
  assert.equal(view[0]!.unplottableCount, 4);
  assert.equal(comparisonChart(view).series.length, 0);
  assert.deepEqual(
    view[0]!.points.map((p) => measurementChartDetails(p).status),
    ['bound', 'bound', 'approximate', 'approximate'],
  );
  assert.equal(measurementChartDetails(view[0]!.points[0]!).convertedDisplay, '< 12 mg/L');
});

test('unsupported and stale conversions retain original numeric data and independent original units with explicit notes', () => {
  const unsupported = point('unsupported');
  unsupported.measurement!.status = 'unsupported_unit';
  unsupported.measurement!.conversion = null;
  const stale = point('stale', '0.01', 'mg/L');
  stale.measurement!.status = 'stale_semantics';
  stale.measurement!.conversion = null;
  const view = transformTrendMeasurements([trend([unsupported, stale])]);
  assert.deepEqual(
    view[0]!.points.map((p) => p.unit),
    ['mg/dL', 'mg/L'],
  );
  assert.deepEqual(
    view[0]!.points.map((p) => p.value),
    [1.2, 0.01],
  );
  assert.ok(view[0]!.points.every((p) => measurementChartDetails(p).status === 'not_converted'));
  assert.equal(comparisonChart(view).axes.length, 2);
});

test('mismatched source/ref/comparator projections cannot silently replace original values', () => {
  for (const field of ['id', 'sourceRecordId', 'unit', 'valueText', 'comparator'] as const) {
    const value = point(field),
      expected: Partial<Observation> = {
        id: 'other',
        sourceRecordId: 'other-source',
        unit: 'g/L',
        valueText: '2.00',
        comparator: '>',
      };
    Object.assign(value, { [field]: expected[field] });
    const copy = transformTrendMeasurements([trend([value])])[0]!.points[0]!;
    assert.equal(measurementChartDetails(copy).status, 'not_converted');
    assert.equal(copy.value, value.value);
    assert.equal(copy.unit, value.unit);
  }
});

test('rational-to-number is drawing-only, keeps repeated-decimal labels and does not merge near-equal exact values', () => {
  const lb = point('lb', '1', 'kg', '[lb_av]');
  const view = transformTrendMeasurements([trend([lb])]);
  assert.equal(view[0]!.points[0]!.value, 100000000 / 45359237);
  const info = measurementChartDetails(view[0]!.points[0]!);
  assert.equal(info.convertedDisplay, '2.205 [lb_av]');
  assert.match(info.conversionLabel!, /rounded for display/);
  assert.match(info.conversionLabel!, /Original: 1 kg/);
  assert.deepEqual(info.exactConvertedValue, lb.measurement!.conversion!.value);
  const near = [
    point('near-a', '9007199254740992', 'kg', 'kg'),
    point('near-b', '9007199254740993', 'kg', 'kg'),
  ];
  const copy = transformTrendMeasurements([trend(near)]);
  assert.equal(copy[0]!.points[0]!.value, copy[0]!.points[1]!.value);
  assert.equal(comparisonChart(copy).series[0]!.points.length, 2);
  assert.notDeepEqual(
    near[0]!.measurement!.conversion!.value,
    near[1]!.measurement!.conversion!.value,
  );
});

test('unsafe drawing overflow/underflow never becomes a fabricated zero or infinity and missing dates remain unplottable', () => {
  const overflow = point('overflow'),
    underflow = point('underflow'),
    partial = point('partial');
  overflow.measurement!.conversion!.value = { numerator: '1' + '0'.repeat(400), denominator: '1' };
  underflow.measurement!.conversion!.value = { numerator: '1', denominator: '1' + '0'.repeat(400) };
  partial.date = '2026-02';
  partial.datePrecision = 'month';
  const view = transformTrendMeasurements([trend([overflow, underflow, partial])]);
  assert.equal(view[0]!.points[0]!.value, null);
  assert.equal(view[0]!.points[1]!.value, null);
  assert.equal(measurementChartDetails(view[0]!.points[0]!).status, 'drawing_unavailable');
  assert.equal(view[0]!.unplottableCount, 3);
  assert.equal(comparisonChart(view).series.length, 0);
});

test('unrequested plots stay original and the bounded adapter rejects rather than truncates over 256 selected results', () => {
  const value = point('original');
  delete value.measurement;
  const copy = transformTrendMeasurements([trend([value])])[0]!.points[0]!;
  assert.equal(copy.value, value.value);
  assert.equal(copy.unit, value.unit);
  assert.equal(measurementChartDetails(copy).status, 'not_requested');
  assert.deepEqual(copy.reference, value.reference);
  assert.throws(
    () => transformTrendMeasurements([trend(Array.from({ length: 257 }, () => value))]),
    RangeError,
  );
});
