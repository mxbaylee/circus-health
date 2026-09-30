import { clinicalPersonQuery } from '../../shared/person-scope';
import { RecordCorrectionBadges, RecordCorrectionHistory } from './RecordCorrectionHistory';
import { useEffect, useRef, useState } from 'react';
import { Search, X, Plus } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { TestType, Trend } from '../../shared/api';
import { queryString, useResource } from '../data/api';
import { formatDate, resultLink } from '../data/format';
import { chartPoint, resultValue, resultUnit } from '../data/clinical';
import { comparisonChart, reviewedEventCount, visibleTrendPoints } from '../data/comparisons';
import { measurementChartDetails, transformTrendMeasurements } from '../data/measurementChart';
import { supportedMeasurementUnits } from '../../shared/measurement-units';
import { ContextHelp } from './ContextHelp';
import { TrendChart } from './TrendChart';
import { Pagination, ResourceState } from './ResourceState';
import { clinicalReferenceText } from './clinicalReference';

export function ComparePicker({
  selected,
  personId,
  onAdd,
}: {
  selected: string[];
  personId?: string;
  onAdd: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const resource = useResource<TestType[]>(
    open ? `/test-types?${queryString({ q: query, limit: 30, offset, personId })}` : null,
  );
  return (
    <div className="compare-picker">
      <button
        className="button secondary"
        aria-expanded={open}
        aria-controls="comparison-options"
        onClick={() => setOpen(!open)}
      >
        <Plus size={17} />
        Compare
      </button>
      {open && (
        <div id="comparison-options" className="comparison-options">
          <div className="section-heading">
            <h3>Add a measurement</h3>
            <button
              className="icon-button"
              aria-label="Close measurement selector"
              onClick={() => setOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
          <label className="search-field">
            <Search size={18} />
            <input
              autoFocus
              aria-label="Search measurement names and aliases"
              placeholder="Search names or aliases"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
            />
          </label>
          <p className="helper-text">
            Choose any quantitative measurement. Comparing does not imply a relationship.
          </p>
          <ResourceState resource={resource} empty="No matching measurements.">
            {(types) => (
              <>
                <ul className="compare-results">
                  {types.map((test) => (
                    <li key={test.id}>
                      <button
                        disabled={
                          selected.includes(test.id) || !test.numericCount || selected.length >= 12
                        }
                        onClick={() => {
                          onAdd(test.id);
                          setOpen(false);
                        }}
                      >
                        <strong>{test.label}</strong>
                        <span>
                          {test.category} · {test.unit ?? 'Unit not recorded'}
                        </span>
                        <span>
                          {formatDate(test.firstDate)} — {formatDate(test.lastDate)} ·{' '}
                          {test.numericCount} numeric
                        </span>
                        {test.context && <span>{test.context}</span>}
                        {!test.numericCount && <em>No exact numeric values to plot</em>}
                        {selected.includes(test.id) && <em>Already selected</em>}
                      </button>
                    </li>
                  ))}
                </ul>
                <Pagination
                  offset={offset}
                  limit={30}
                  count={types.length}
                  total={typeof resource.meta?.total === 'number' ? resource.meta.total : undefined}
                  onChange={setOffset}
                />
              </>
            )}
          </ResourceState>
          {selected.length >= 12 && <p>Up to 12 measurements can be compared at once.</p>}
        </div>
      )}
    </div>
  );
}

export function MeasurementCharts({
  ids,
  from,
  to,
  providerId,
  personId,
  selectedId,
  onSelect,
  onRemove,
  revision,
}: {
  ids: string[];
  from?: string;
  to?: string;
  providerId?: string;
  personId?: string;
  selectedId?: string;
  onSelect?: (id: string) => void;
  onRemove?: (id: string) => void;
  revision?: string | number;
}) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const unit = params.get('compareUnit') || '';
  const resource = useResource<Trend[]>(
    ids.length
      ? `/trends?${queryString({ ids: ids.join(','), from, to, providerId, personId, unit })}`
      : null,
  );
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current !== revision) resource.reload();
    previousRevision.current = revision;
  }, [revision, resource.reload]);
  const ownedResultLink = (id: string) => resultLink(id) + clinicalPersonQuery(personId);
  const selectResult = onSelect ?? ((id: string) => navigate(ownedResultLink(id)));
  return (
    <>
      <div className="section-heading">
        <label>
          Display units
          <select
            aria-label="Chart display units"
            value={unit}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.target.value) next.set('compareUnit', event.target.value);
              else next.delete('compareUnit');
              setParams(next);
            }}
          >
            <option value="">Original units</option>
            {supportedMeasurementUnits().map((option) => (
              <option key={option.code} value={option.code}>
                {option.code === '[lb_av]'
                  ? 'Pounds (avoirdupois)'
                  : option.code === '[oz_av]'
                    ? 'Ounces (avoirdupois)'
                    : option.code}
              </option>
            ))}
          </select>
        </label>
        <ContextHelp label="About display units">
          <p>
            Conversions require reviewed measurement settings on each result. Original values and
            ranges stay unchanged. Incompatible or unreviewed results keep their original units.
          </p>
          <p>
            Converted charts support up to 256 results. Narrow the date range for larger histories,
            or choose Original units to see the full history.
          </p>
        </ContextHelp>
      </div>
      <ResourceState resource={resource} empty="Select a measurement to view its history.">
        {(trends) => {
          const plottedTrends = unit ? transformTrendMeasurements(trends) : trends;
          const chart = comparisonChart(plottedTrends, from, to);
          const availableIds = new Set(
            trends.flatMap((trend) => trend.points.map((point) => point.id)),
          );
          return (
            <div className="measurement-charts">
              <TrendChart chart={chart} selectedId={selectedId} onSelect={selectResult} />
              {chart.overlap === 'disjoint' && (
                <p className="comparison-context" role="status">
                  These measurement histories do not overlap in time. No paired values are inferred.
                </p>
              )}
              {chart.overlap === 'insufficient' && (
                <p className="comparison-context" role="status">
                  At least one selected measurement has no plottable results in these filters. Its
                  recorded results are retained below.
                </p>
              )}
              {chart.overlap === 'overlap' && (
                <p className="comparison-context">
                  {chart.sharedDates
                    ? `${chart.sharedDates} recorded calendar date${chart.sharedDates === 1 ? '' : 's'} appear in every selected measurement.`
                    : 'The date ranges overlap, but there are no shared recorded calendar dates across all selected measurements.'}{' '}
                  No values are paired or estimated between dates. A comparison does not establish a
                  correlation.
                </p>
              )}
              {trends.map((trend, index) => {
                const plotted = plottedTrends[index]!;
                const visibleIds = new Set(
                  visibleTrendPoints(plotted.points, availableIds).map((point) => point.id),
                );
                const omitted = plotted.points.filter(
                  (point) => !chartPoint(point) || !visibleIds.has(point.id),
                );
                const eventCount = reviewedEventCount(trend.points);
                const hasReview = trend.points.some((point) => point.relationship);
                return (
                  <section className="measurement-series" key={trend.test.id}>
                    <div className="section-heading">
                      <h3>{trend.test.label}</h3>
                      {index > 0 && onRemove && (
                        <button
                          className="icon-button"
                          aria-label={`Remove ${trend.test.label} comparison`}
                          onClick={() => onRemove(trend.test.id)}
                        >
                          <X size={18} />
                        </button>
                      )}
                    </div>
                    <p className="helper-text">
                      {trend.points.length} recorded results ·{' '}
                      {trend.points.length - omitted.length} plotted
                      {eventCount !== trend.points.length &&
                        ` · ${eventCount} reviewed event${eventCount === 1 ? '' : 's'}`}
                      {trend.complete ? ' · Full series for these filters' : ' · Incomplete series'}
                    </p>
                    {trend.test.context && <p className="helper-text">{trend.test.context}</p>}
                    {hasReview && (
                      <p className="helper-text">
                        Reviewed display choices affect this chart only when the preferred result is
                        in these filters. Every original value remains below. Open a result to
                        review its relationships and earlier decisions.
                      </p>
                    )}
                    {!!omitted.length && (
                      <details className="unplotted-results">
                        <summary>
                          {omitted.length} result{omitted.length === 1 ? '' : 's'} not plotted
                        </summary>
                        <p className="helper-text">
                          Text, bounds such as &lt;5, missing or imprecise dates, and
                          entered-in-error results remain here without becoming exact measurements.
                          {hasReview &&
                            ' An alternative to a reviewed preferred result may also be left off this chart.'}
                        </p>
                        {omitted.map((point) => (
                          <Link
                            className="unplotted-row"
                            key={point.id}
                            to={ownedResultLink(point.id)}
                          >
                            <span>{formatDate(point.date)}</span>
                            <strong>{measurementChartDetails(point).originalDisplay}</strong>
                            <span>
                              {point.datePrecision} · {point.provider ?? 'Provider not recorded'}
                            </span>
                          </Link>
                        ))}
                      </details>
                    )}
                    <details className="unplotted-results">
                      <summary>Recorded values ({trend.points.length})</summary>
                      {trend.points.length ? (
                        trend.points.map((point) => (
                          <div key={point.id}>
                            <Link className="unplotted-row" to={resultLink(point.id)}>
                              <span>
                                {formatDate(point.date)}
                                <small>{point.datePrecision}</small>
                              </span>
                              <strong>
                                {resultValue(point)} {resultUnit(point)}
                              </strong>
                              <span>{point.provider ?? 'Provider not recorded'}</span>
                              <span>{point.status ?? 'Status not recorded'}</span>
                              {unit && (
                                <span>
                                  {measurementChartDetails(point).convertedDisplay && (
                                    <strong>
                                      {measurementChartDetails(point).convertedDisplay}
                                    </strong>
                                  )}
                                  {measurementChartDetails(point).conversionLabel ||
                                    measurementChartDetails(point).reason}
                                  {clinicalReferenceText(point.reference) && (
                                    <small>
                                      Reference range (original, not converted):{' '}
                                      {clinicalReferenceText(point.reference)}
                                    </small>
                                  )}
                                </span>
                              )}
                              {point.relationship && (
                                <span>
                                  {point.relationship.display.requiresReview
                                    ? 'Relationship needs review'
                                    : point.relationship.hasProviderAmendment
                                      ? 'Reviewed provider amendment'
                                      : point.relationship.display.oneReviewedEvent
                                        ? 'Shares one reviewed event'
                                        : 'Relationship history'}
                                </span>
                              )}
                              <RecordCorrectionBadges extra={point.extra} />
                            </Link>
                            <RecordCorrectionHistory extra={point.extra} />
                          </div>
                        ))
                      ) : (
                        <p className="helper-text">
                          No results for this measurement under the selected filters.
                        </p>
                      )}
                    </details>
                  </section>
                );
              })}
            </div>
          );
        }}
      </ResourceState>
    </>
  );
}
