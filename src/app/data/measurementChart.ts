import type { Observation, Trend } from '../../shared/api.ts';
import type { DerivedMeasurement } from '../../shared/measurement.ts';
import type { ExactRational } from '../../shared/exact-decimal.ts';
import { MEASUREMENT_RULE_VERSION } from '../../shared/measurement-units.ts';
import { formatMeasurementValue } from '../../shared/measurement-value.ts';
import { chartPoint } from './clinical.ts';

export interface MeasurementChartDetails {
  status:
    | 'converted'
    | 'not_requested'
    | 'not_converted'
    | 'bound'
    | 'approximate'
    | 'drawing_unavailable';
  reason: string;
  original: Pick<
    Observation,
    'id' | 'sourceRecordId' | 'valueText' | 'value' | 'comparator' | 'unit' | 'reference'
  >;
  originalDisplay: string;
  convertedDisplay: string | null;
  conversionLabel: string | null;
  referenceLabel: 'Reference range (original, not converted)';
  exactConvertedValue: ExactRational | null;
}
export type MeasurementChartObservation = Observation & {
  measurement?: DerivedMeasurement;
  measurementChart?: MeasurementChartDetails;
};
export type MeasurementChartTrend = Omit<Trend, 'points'> & {
  points: MeasurementChartObservation[];
};
const compact = (text: string) => text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const qualifier = (value: string | null | undefined) =>
  value?.trim().replace('≤', '<=').replace('≥', '>=').replace('≈', '~') || '=';
function originalDisplay(point: Observation) {
  const prefix = /^(<=|>=|<|>|≤|≥|=|~|≈)/.exec(point.valueText.trim())?.[1];
  const comparator =
    point.comparator && !prefix && point.comparator !== '=' ? point.comparator + ' ' : '';
  return comparator + formatMeasurementValue(point.valueText, point.unit);
}
/** Only for pixel placement. Never feed this approximation back to comparison or clinical decisions. */
function drawingNumber(value: ExactRational): number | null {
  if (!/^-?\d{1,1024}$/.test(value.numerator) || !/^\d{1,1024}$/.test(value.denominator))
    return null;
  const numerator = Number(value.numerator),
    denominator = Number(value.denominator);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) && !(result === 0 && BigInt(value.numerator) !== 0n)
    ? result
    : null;
}
function details(point: MeasurementChartObservation): MeasurementChartDetails {
  const original = {
    id: point.id,
    sourceRecordId: point.sourceRecordId,
    valueText: point.valueText,
    value: point.value,
    comparator: point.comparator,
    unit: point.unit,
    reference: structuredClone(point.reference),
  };
  const result: MeasurementChartDetails = {
    status: 'not_requested',
    reason: 'Original units; no conversion requested.',
    original,
    originalDisplay: originalDisplay(point),
    convertedDisplay: null,
    conversionLabel: null,
    referenceLabel: 'Reference range (original, not converted)',
    exactConvertedValue: null,
  };
  const measurement = point.measurement;
  if (!measurement) return result;
  if (
    measurement.rulesVersion !== MEASUREMENT_RULE_VERSION ||
    measurement.reference.kind !== 'observation' ||
    measurement.reference.recordId !== point.id ||
    measurement.reference.sourceRecordId !== point.sourceRecordId ||
    measurement.source.valueText !== point.valueText ||
    measurement.source.unit !== point.unit ||
    qualifier(measurement.source.comparator) !== qualifier(point.comparator)
  )
    return {
      ...result,
      status: 'not_converted',
      reason: 'The conversion does not match this exact original result; original units retained.',
    };
  if (measurement.status !== 'converted' || !measurement.conversion)
    return {
      ...result,
      status: 'not_converted',
      reason: `Not converted (${measurement.status.replaceAll('_', ' ')}); original units retained.`,
    };
  const conversion = measurement.conversion;
  if (
    conversion.valueRole === 'bound' ||
    (conversion.comparator !== '=' && conversion.comparator !== '~')
  )
    return {
      ...result,
      status: 'bound',
      reason: 'A converted bound remains a threshold, not an observed chart point.',
      exactConvertedValue: conversion.value,
      convertedDisplay: `${conversion.comparator} ${conversion.exactDecimal ?? `${conversion.value.numerator}/${conversion.value.denominator}`} ${conversion.to}`,
    };
  if (conversion.valueRole === 'approximation' || conversion.comparator === '~')
    return {
      ...result,
      status: 'approximate',
      reason:
        'An approximate source value is excluded from point plotting; no uncertainty interval is inferred.',
      exactConvertedValue: conversion.value,
      convertedDisplay: `~ ${conversion.exactDecimal ?? `${conversion.value.numerator}/${conversion.value.denominator}`} ${conversion.to}`,
    };
  if (conversion.valueRole !== 'point' || drawingNumber(conversion.value) === null)
    return {
      ...result,
      status: 'drawing_unavailable',
      reason: 'The exact converted value cannot be represented safely for drawing.',
      exactConvertedValue: conversion.value,
    };
  return {
    ...result,
    status: 'converted',
    reason: 'Exact unit conversion; only chart positioning uses a numeric approximation.',
    convertedDisplay: `${compact(conversion.display.value)} ${conversion.to}`,
    exactConvertedValue: structuredClone(conversion.value),
    conversionLabel: `Converted from ${conversion.from} to ${conversion.to}${conversion.display.applied ? `; rounded for display to ${conversion.display.decimalPlaces} decimal places` : ''}. Original: ${result.originalDisplay}`,
  };
}
/** For tooltips/detail panels; the original reference range is always available and explicitly unconverted. */
export function measurementChartDetails(
  point: MeasurementChartObservation,
): MeasurementChartDetails {
  return structuredClone(point.measurementChart || details(point));
}
/** A bounded plotting view. Input assertions, units and reference ranges remain untouched. */
export function transformTrendMeasurements(
  trends: MeasurementChartTrend[],
): MeasurementChartTrend[] {
  const count = trends.reduce((sum, trend) => sum + trend.points.length, 0);
  if (count > 256)
    throw new RangeError(
      'Choose at most 256 results for a converted chart; no results were truncated.',
    );
  return trends.map((trend) => {
    const points = trend.points.map((point) => {
      // Repeated adapter application retains the original source rather than converting a plotting copy again.
      const original = point.measurementChart
        ? { ...point, ...point.measurementChart.original, measurementChart: undefined }
        : point;
      const metadata = details(original),
        copy: MeasurementChartObservation = {
          ...structuredClone(original),
          measurementChart: metadata,
        };
      if (metadata.status === 'converted') {
        const conversion = original.measurement!.conversion!;
        copy.value = drawingNumber(conversion.value);
        copy.valueText = conversion.display.value;
        copy.unit = conversion.to;
        copy.comparator = '=';
        // An original-unit range cannot be used as a band on this converted axis.
        copy.reference = null;
      } else if (['bound', 'approximate', 'drawing_unavailable'].includes(metadata.status))
        copy.value = null;
      return copy;
    });
    return {
      ...structuredClone(trend),
      points,
      unplottableCount: points.filter((point) => !chartPoint(point)).length,
    };
  });
}
