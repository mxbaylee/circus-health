import { useId, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
import { formatDate } from '../data/format';
import type { ComparisonChart, ChartDatum } from '../data/comparisons';
import { recordsAtPoint } from '../data/comparisons';
import './charts.css';

export type { ChartPoint } from '../../shared/charts.ts';
export type ChartDomain = [number, number];
const lineColor = (index: number) => `var(--series-${index % 12})`;
const dashPattern = (index: number) => ['', '7 3', '2 3', '9 3 2 3'][Math.floor(index / 3) % 4];

export function TrendChart({
  chart,
  selectedId,
  onSelect,
}: {
  chart: ComparisonChart;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const descriptionId = useId();
  const [active, setActive] = useState<{ seriesId: string; pointId: string } | null>(null);
  const inspected = active ? recordsAtPoint(chart, active.seriesId, active.pointId) : [];
  if (!chart.domain || !chart.rows.length)
    return (
      <p className="empty-chart" role="status">
        No exact numeric results with a known day in this date range. Recorded values are available
        below.
      </p>
    );
  const longRange = chart.domain[1] - chart.domain[0] > 86400000 * 730;
  const manyAxes = chart.axes.length > 2;
  const span = chart.domain[1] - chart.domain[0];
  const dateLabel = (value: number) =>
    new Intl.DateTimeFormat('en-US', {
      ...(longRange
        ? { year: 'numeric' as const }
        : span < 86400000
          ? { hour: 'numeric' as const, minute: '2-digit' as const }
          : { month: 'short' as const, day: 'numeric' as const, year: '2-digit' as const }),
      timeZone: 'UTC',
    }).format(new Date(value));
  // Recharts may derive repeated ticks from the per-series data arrays. Publish
  // explicit unique axis ticks without changing a recorded time or value.
  const labels = new Set<string>();
  const ticks = Array.from({ length: 6 }, (_, index) =>
    Math.round(chart.domain![0] + (span * index) / 5),
  ).filter((value) => {
    const label = dateLabel(value);
    if (labels.has(label)) return false;
    labels.add(label);
    return true;
  });
  return (
    <figure
      className="trend-chart shared-trend-chart"
      aria-label="Recorded measurement history"
      aria-describedby={descriptionId}
    >
      <ul className="chart-legend" aria-label="Chart series">
        {chart.series.map((series) => (
          <li key={series.id}>
            <svg width="30" height="14" aria-hidden="true">
              <line
                x1="0"
                x2="30"
                y1="7"
                y2="7"
                stroke={lineColor(series.colorIndex)}
                strokeWidth="2"
                strokeDasharray={dashPattern(series.colorIndex)}
              />
              <circle cx="15" cy="7" r="3" fill={lineColor(series.colorIndex)} />
            </svg>
            <span>
              <strong>{series.name}</strong>{' '}
              <span>
                {series.unit || 'Unit not recorded'} · Scale{' '}
                {chart.axes.find((axis) => axis.id === series.axisId)?.label}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {chart.axes.length > 1 && (
        <p className="helper-text chart-scale-note">
          Different units use separate labeled scales; matching heights do not mean equal values.
        </p>
      )}
      {manyAxes && <p className="helper-text">Scroll horizontally to see every scale.</p>}
      <div
        className="chart-scroll"
        tabIndex={manyAxes ? 0 : undefined}
        role={manyAxes ? 'region' : undefined}
        aria-label={
          manyAxes ? 'Measurement chart; scroll horizontally for all value scales' : undefined
        }
      >
        <div
          className="chart-canvas"
          aria-hidden="true"
          style={manyAxes ? { minWidth: 330 + chart.axes.length * 74 } : undefined}
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart
              data={chart.rows}
              margin={{ top: 20, right: 12, bottom: 12, left: 0 }}
              accessibilityLayer={false}
            >
              <CartesianGrid
                yAxisId={chart.axes[0].id}
                stroke="var(--chart-grid)"
                strokeDasharray="3 4"
                vertical={false}
              />
              <XAxis
                type="number"
                dataKey="time"
                scale="time"
                domain={chart.domain}
                allowDataOverflow
                ticks={ticks}
                tickFormatter={dateLabel}
                tick={{ fill: 'var(--muted)', fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: 'var(--border)' }}
                minTickGap={30}
                dy={9}
              />
              {chart.axes.map((axis, index) => (
                <YAxis
                  key={axis.id}
                  yAxisId={axis.id}
                  domain={axis.domain}
                  allowDataOverflow
                  orientation={index % 2 ? 'right' : 'left'}
                  tick={{ fill: 'var(--muted)', fontSize: 11 }}
                  tickFormatter={(value) =>
                    new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 }).format(value)
                  }
                  tickLine={false}
                  axisLine={{ stroke: 'var(--border)' }}
                  width={74}
                  tickCount={5}
                  label={{
                    value: `${axis.label} · ${axis.unit || 'Unknown unit'}`,
                    angle: -90,
                    position: index % 2 ? 'insideRight' : 'insideLeft',
                    style: { fill: 'var(--muted)', fontSize: 11 },
                  }}
                />
              ))}
              {chart.series.map((series) => (
                <Line
                  key={series.id}
                  data={series.data}
                  dataKey="value"
                  xAxisId={0}
                  yAxisId={series.axisId}
                  name={series.name}
                  unit={series.unit}
                  type="linear"
                  connectNulls={false}
                  stroke={lineColor(series.colorIndex)}
                  strokeWidth={2}
                  strokeDasharray={dashPattern(series.colorIndex)}
                  isAnimationActive={false}
                  activeDot={false}
                  dot={(props) => {
                    const point = props.payload as ChartDatum;
                    if (point.value === null || props.cx == null || props.cy == null)
                      return <g key={point.id} />;
                    const selected = point.id === selectedId;
                    const inspect = () => setActive({ seriesId: series.id, pointId: point.id });
                    return (
                      <g
                        key={point.id}
                        onMouseEnter={inspect}
                        onClick={() => {
                          inspect();
                          if (recordsAtPoint(chart, series.id, point.id).length === 1)
                            onSelect(point.id);
                        }}
                        style={{ cursor: 'pointer' }}
                      >
                        <title>{`${series.name} · ${formatDate(point.date)} · ${point.display ?? point.value}${point.provider ? ` · ${point.provider}` : ''}`}</title>
                        <circle cx={props.cx} cy={props.cy} r={10} fill="transparent" />
                        <circle
                          cx={props.cx}
                          cy={props.cy}
                          r={selected ? 6 : 4}
                          fill={lineColor(series.colorIndex)}
                          stroke={selected ? 'var(--ink)' : 'var(--surface)'}
                          strokeWidth={selected ? 2.5 : 2}
                        />
                      </g>
                    );
                  }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <figcaption id={descriptionId} className="chart-caption">
        Dots are recorded values; connecting lines are visual guides. Gaps and original results
        remain listed below.
      </figcaption>
      {inspected.length > 0 ? (
        <div className="chart-point-details">
          <p>
            {formatDate(inspected[0].point.date)}
            {inspected.length > 1
              ? ` · ${inspected.length} records share this point. Choose a result:`
              : ' · Recorded result'}
          </p>
          {inspected.map(({ series, point }) => (
            <button
              className="chart-point-result"
              key={`${series.id}:${point.id}`}
              onClick={() => onSelect(point.id)}
            >
              <span>
                <strong>{series.name}</strong>
                <span>{point.provider || 'Provider not recorded'}</span>
              </span>
              <span>
                {point.display ?? `${point.value} ${series.unit}`} <span aria-hidden="true">↗</span>
                <span className="sr-only"> Open result</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="helper-text chart-point-hint">
          Select a dot to open its result. Recorded values also lists overlapping results.
        </p>
      )}
    </figure>
  );
}
