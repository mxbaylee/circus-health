import type { Trend, Observation } from '../../shared/api';
import type { ChartPoint } from '../components/TrendChart';
import { chartDate, chartPoint } from './clinical.ts';
import { dateNumber } from './format.ts';

export type TimedChartPoint = ChartPoint & { time: number };
export type ChartDatum = TimedChartPoint | { id: string; time: number; value: null };
export type ComparisonSeries = {
  id: string;
  testTypeId: string;
  name: string;
  unit: string;
  axisId: string;
  colorIndex: number;
  data: ChartDatum[];
  points: TimedChartPoint[];
};
export type ComparisonAxis = { id: string; label: string; unit: string; domain: [number, number] };
export type MergedChartRow = { time: number; points: Record<string, TimedChartPoint[]> };
export type ComparisonChart = {
  series: ComparisonSeries[];
  axes: ComparisonAxis[];
  rows: MergedChartRow[];
  domain: [number, number] | null;
  sharedDates: number;
  overlap: 'single' | 'overlap' | 'disjoint' | 'insufficient';
};

/** A preferred assertion replaces only a counterpart present in this filtered view. */
export function visibleTrendPoints(
  points: Observation[],
  availableIds = new Set(points.map((point) => point.id)),
) {
  return points.filter((point) => {
    const display = point.relationship?.display;
    return (
      !display ||
      display.visibleByDefault ||
      display.requiresReview ||
      !display.preferredRecordId ||
      !availableIds.has(display.preferredRecordId)
    );
  });
}
export function reviewedEventCount(points: Observation[]): number {
  return new Set(
    points.map((point) =>
      point.relationship?.display.oneReviewedEvent && !point.relationship.display.requiresReview
        ? point.relationship.display.countGroupId
        : `record:${point.id}`,
    ),
  ).size;
}

/** Join only recorded dates. Each cell retains every source result, including duplicates. */
export function mergeSeries(series: ComparisonSeries[]): MergedChartRow[] {
  const rows = new Map<number, MergedChartRow>();
  for (const line of series)
    for (const point of line.points) {
      const row = rows.get(point.time) ?? { time: point.time, points: {} };
      (row.points[line.id] ??= []).push(point);
      rows.set(point.time, row);
    }
  return [...rows.values()].sort((a, b) => a.time - b.time);
}

export function comparisonChart(trends: Trend[], from?: string, to?: string): ComparisonChart {
  const series: ComparisonSeries[] = [];
  const availableIds = new Set(trends.flatMap((trend) => trend.points.map((point) => point.id)));
  const axisKeys = new Map<string, string>();
  for (const trend of trends) {
    const dated = visibleTrendPoints(trend.points, availableIds)
      .flatMap((result) => {
        const time = chartDate(result);
        return time === null ? [] : [{ result, time, point: chartPoint(result) }];
      })
      .sort((a, b) => a.time - b.time || a.result.id.localeCompare(b.result.id));
    const units = [
      ...new Set(dated.filter((item) => item.point).map((item) => item.result.unit ?? '')),
    ];
    for (const unit of units) {
      // Missing units never assert compatibility between different measurements.
      const axisKey = unit ? `unit:${unit}` : `unknown:${trend.test.id}`;
      if (!axisKeys.has(axisKey))
        axisKeys.set(axisKey, `axis-${String(axisKeys.size).padStart(2, '0')}`);
      const points = dated.flatMap((item) =>
        item.point && (item.result.unit ?? '') === unit ? [{ ...item.point, time: item.time }] : [],
      );
      const counts = new Map<number, number>();
      points.forEach((point) => counts.set(point.time, (counts.get(point.time) ?? 0) + 1));
      const data: ChartDatum[] = dated.flatMap((item) => {
        const gap = { id: `gap:${item.result.id}`, time: item.time, value: null };
        if (!item.point || (item.result.unit ?? '') !== unit) return [gap];
        const point = { ...item.point, time: item.time };
        // Same-time results have no known sequence. Keep every marker without a
        // fabricated vertical connection or arbitrarily choosing a result.
        return counts.get(item.time)! > 1
          ? [gap, point, { ...gap, id: `${gap.id}:after` }]
          : [point];
      });
      series.push({
        id: JSON.stringify([trend.test.id, unit]),
        testTypeId: trend.test.id,
        name: trend.test.label,
        unit,
        axisId: axisKeys.get(axisKey)!,
        colorIndex: series.length,
        data,
        points,
      });
    }
  }
  const axes: ComparisonAxis[] = [...axisKeys.values()].map((id, index) => {
    const lines = series.filter((line) => line.axisId === id);
    const values = lines.flatMap((line) => line.points.map((point) => point.value));
    const low = Math.min(...values),
      high = Math.max(...values);
    const padding = low === high ? Math.max(Math.abs(low) * 0.05, 1) : (high - low) * 0.08;
    return {
      id,
      label: String.fromCharCode(65 + index),
      unit: lines[0].unit,
      domain: [low - padding, high + padding],
    };
  });
  const rows = mergeSeries(series);
  const fromTime = from ? dateNumber(from) : null;
  const toTime = to ? dateNumber(to) : null;
  // Date-only filters include the whole day, including source timestamps later
  // than noon. These are viewport boundaries, never generated measurements.
  const start =
    (fromTime !== null ? fromTime - (/^\d{4}-\d{2}-\d{2}$/.test(from!) ? 43200000 : 0) : null) ??
    rows[0]?.time;
  const end =
    (toTime !== null ? toTime + (/^\d{4}-\d{2}-\d{2}$/.test(to!) ? 43200000 - 1 : 0) : null) ??
    rows.at(-1)?.time;
  const domain: [number, number] | null =
    start === undefined || end === undefined
      ? null
      : start === end
        ? [start - 86400000, end + 86400000]
        : [start, end];
  const ranges = trends.flatMap((trend) => {
    const times = series
      .filter((line) => line.testTypeId === trend.test.id)
      .flatMap((line) => line.points.map((point) => point.time));
    return times.length ? [{ first: Math.min(...times), last: Math.max(...times) }] : [];
  });
  const days = trends.map(
    (trend) =>
      new Set(
        series
          .filter((line) => line.testTypeId === trend.test.id)
          .flatMap((line) => line.points.map((point) => point.date.slice(0, 10))),
      ),
  );
  const sharedDates =
    days.length > 1
      ? [...days[0]].filter((day) => days.every((dates) => dates.has(day))).length
      : 0;
  const overlap =
    trends.length < 2
      ? 'single'
      : ranges.length < trends.length
        ? 'insufficient'
        : Math.max(...ranges.map((range) => range.first)) >
            Math.min(...ranges.map((range) => range.last))
          ? 'disjoint'
          : 'overlap';
  return { series, axes, rows, domain, sharedDates, overlap };
}

/** A coincident marker can stand for several original records; offer each identity. */
export function recordsAtPoint(chart: ComparisonChart, seriesId: string, pointId: string) {
  const series = chart.series.find((line) => line.id === seriesId);
  const point = series?.points.find((candidate) => candidate.id === pointId);
  if (!series || !point) return [];
  return chart.series.flatMap((line) =>
    line.axisId === series.axisId
      ? line.points
          .filter((candidate) => candidate.time === point.time && candidate.value === point.value)
          .map((candidate) => ({ series: line, point: candidate }))
      : [],
  );
}
