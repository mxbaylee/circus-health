import type { Observation } from '../../shared/api.ts';
import type { ChartPoint } from '../../shared/charts.ts';
import {
  exactUnitMeasurementValue,
  measurementValueDisplay,
} from '../../shared/measurement-value.ts';
import { dateNumber } from './format.ts';

export function resultValue(result: Observation): string {
  const comparator =
    result.comparator &&
    result.comparator !== '=' &&
    !result.valueText.trim().startsWith(result.comparator)
      ? result.comparator
      : '';
  return `${comparator}${result.valueText || (result.value === null ? 'Not recorded' : String(result.value))}`;
}

export function resultUnit(result: Observation): string {
  return measurementValueDisplay(result.valueText, result.unit).appendedUnit || '';
}

export function chartDate(result: Observation): number | null {
  return /\b(year|month|unknown|approximate|season)\b/i.test(result.datePrecision)
    ? null
    : dateNumber(result.date);
}

export function chartPoint(result: Observation): ChartPoint | null {
  const exact = exactUnitMeasurementValue(result.valueText, result.unit);
  const text = exact?.numberText.trim() || '';
  if (
    result.value === null ||
    !Number.isFinite(result.value) ||
    !exact ||
    (result.comparator && result.comparator !== '=') ||
    /^[<>≤≥~≈]/.test(text) ||
    chartDate(result) === null ||
    result.status === 'entered-in-error'
  )
    return null;
  return {
    id: result.id,
    date: result.date!,
    value: result.value,
    display: [resultValue(result), resultUnit(result)].filter(Boolean).join(' '),
    provider: result.provider ?? undefined,
  };
}

export function unitGroups(points: Observation[]) {
  const groups = new Map<string, ChartPoint[]>();
  for (const result of points) {
    const point = chartPoint(result);
    if (!point) continue;
    const unit = result.unit ?? '';
    groups.set(unit, [...(groups.get(unit) ?? []), point]);
  }
  return [...groups].map(([unit, points]) => ({ unit, points }));
}
