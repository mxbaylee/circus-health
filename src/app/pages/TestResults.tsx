import { OwnershipSelectionControl } from '../features/clinical-review/OwnershipSelectionControl';
import {
  RecordCorrectionBadges,
  RecordCorrectionHistory,
} from '../components/RecordCorrectionHistory';
import {
  ClinicalRedirect,
  isReclassifiedRecord,
  currentClinicalRecord,
} from '../components/ClinicalRedirect';
import type { ReclassifiedRecord } from '../../shared/api';
import { CollectionTabs, CollectionToolbar } from '../components/CollectionLayout';
import { DetailHeader, EntryActions } from '../components/DetailHeader';
import { ArchiveControl } from '../components/ArchiveControl';
import {
  CollectionFilters,
  dateRangeFilter,
  selectFilter,
  visibilityFilter,
} from '../components/CollectionFilters';
import { useAssistantSelection } from '../features/assistant/pageContext';
import { RelatedNotes } from '../components/RelatedNotes';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronRight,
  ChartNoAxesCombined,
  Eye,
  FlaskConical,
  History,
} from 'lucide-react';
import type { Observation, Provider, TestType } from '../../shared/api';
import { SourceDialog } from '../components/SourceDialog';
import { MeasurementCharts, ComparePicker } from '../components/MeasurementCharts';
import { Pagination, ResourceState } from '../components/ResourceState';
import { queryString, useResource } from '../data/api';
import { resultValue, resultUnit } from '../data/clinical';
import { formatDate } from '../data/format';
import { AttachmentPanel } from '../features/notes/AttachmentPanel';
import { resetTestComparisons } from './test-navigation';
import { VisionHistory } from '../components/VisionHistory';
import { RecordCorrectionAction } from '../features/clinical-review/RecordCorrectionAction';
import { observationCorrectionTarget } from '../features/clinical-review/recordCorrectionTargets';
import { ClinicalRelationshipPanel } from '../features/clinical-review/ClinicalRelationshipPanel';
import { MeasurementReviewPanel } from '../features/clinical-review/MeasurementReviewPanel';
import { clinicalReferenceText } from '../components/clinicalReference';
import '../clinical.css';

const PAGE_SIZE = 40;
export function TestResults() {
  const [params, setParams] = useSearchParams();
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const byTest = params.get('view') === 'by-test';
  const vision = params.get('view') === 'vision';
  const query = params.get('q') ?? '';
  const providerId = params.get('provider') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const mobileDetail = params.get('detail') === '1';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const sort = params.get('sort') ?? 'newest';
  const update = (values: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values))
      value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace });
  };
  const personId = params.get('personId') || 'patient';
  const filters = {
    personId,
    ...(vision && params.get('document') ? { documentId: params.get('document')! } : {}),
    visibility: params.get('visibility') || 'visible',
    q: query,
    providerId,
    from,
    to,
    limit: PAGE_SIZE,
    offset,
    sort,
  };
  const providers = useResource<Provider[]>('/providers');
  const history = useResource<Observation[]>(
    !byTest && !vision ? `/tests?${queryString(filters)}` : null,
  );
  const types = useResource<TestType[]>(byTest ? `/test-types?${queryString(filters)}` : null);
  const selectedTypeId = byTest ? (params.get('type') ?? types.data?.[0]?.id) : undefined;
  const latest = useResource<Observation[]>(
    byTest && selectedTypeId
      ? `/tests?${queryString({ personId, visibility: 'all', testTypeId: selectedTypeId, providerId, from, to, limit: 1, sort: 'newest' })}`
      : null,
  );
  const selectedResultId = byTest
    ? latest.data?.[0]?.id
    : vision
      ? undefined
      : (params.get('result') ?? history.data?.[0]?.id);
  const detail = useResource<Observation | ReclassifiedRecord>(
    selectedResultId ? `/tests/${encodeURIComponent(selectedResultId)}` : null,
  );
  const currentDetail = currentClinicalRecord(detail.data);
  useEffect(() => {
    if (currentDetail?.personId && currentDetail.personId !== personId && params.get('result')) {
      const next = new URLSearchParams(params);
      next.set('personId', currentDetail.personId);
      next.delete('compare');
      next.delete('offset');
      setParams(next, { replace: true });
    }
  }, [currentDetail?.personId, personId, params, setParams]);
  const primaryId = byTest ? selectedTypeId : currentDetail?.testTypeId;
  useAssistantSelection(
    byTest && selectedTypeId
      ? { collection: 'test_types', id: selectedTypeId }
      : selectedResultId
        ? { collection: 'results', id: selectedResultId }
        : undefined,
    byTest ? types.data?.find((type) => type.id === selectedTypeId)?.label : currentDetail?.label,
  );
  const previousPrimary = useRef<string | undefined>(undefined);
  // Do not render/request stale comparisons while the URL cleanup is pending.
  const resetComparisons = resetTestComparisons(previousPrimary.current, primaryId, params);
  const comparisons = resetComparisons
    ? []
    : [
        ...new Set((params.get('compare') ?? '').split(',').filter((id) => id && id !== primaryId)),
      ].slice(0, 11);
  const ids = primaryId ? [primaryId, ...comparisons] : [];
  useEffect(() => {
    if (!primaryId) return;
    const next = resetTestComparisons(previousPrimary.current, primaryId, params);
    previousPrimary.current = primaryId;
    if (next) setParams(next, { replace: true });
  }, [primaryId, params, setParams]);
  const filterUpdate = (values: Record<string, string | null>, replace = false) =>
    update({ ...values, offset: null, detail: null, result: null, type: null }, replace);
  const openResult = (id: string) => update({ result: id, detail: '1', view: null });
  const openType = (id: string) => update({ type: id, view: 'by-test', detail: '1', offset: null });
  const setComparisons = (next: string[]) => update({ compare: next.join(',') || null });
  useEffect(() => {
    if (mobileDetail && window.matchMedia('(max-width: 760px)').matches)
      detailHeading.current?.focus();
  }, [mobileDetail, selectedResultId, detail.data]);
  const changeTab = (toTypes: boolean) =>
    update({ view: toTypes ? 'by-test' : null, offset: null, detail: null, document: null });
  const tabKeys = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const tabs = ['history-tab', 'types-tab', 'vision-tab'];
      const current = vision ? 2 : byTest ? 1 : 0;
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? 2
            : (current + (event.key === 'ArrowLeft' ? 2 : 1)) % 3;
      update({
        view: next === 2 ? 'vision' : next === 1 ? 'by-test' : null,
        offset: null,
        detail: null,
      });
      document.getElementById(tabs[next])?.focus();
    }
  };
  return (
    <div
      className={`page tests-page ${mobileDetail && (selectedResultId || selectedTypeId) ? 'show-mobile-detail' : ''}`}
    >
      <div className="tests-header">
        <div className="page-heading">
          <div>
            <p className="eyebrow">YOUR RECORDS</p>
            <h1>Test results</h1>
          </div>
        </div>
        <CollectionTabs role="tablist" label="Browse test results">
          <button
            role="tab"
            id="history-tab"
            aria-selected={!byTest && !vision}
            aria-controls="results-panel"
            tabIndex={byTest || vision ? -1 : 0}
            className={!byTest && !vision ? 'selected' : ''}
            onClick={() => changeTab(false)}
            onKeyDown={tabKeys}
          >
            <History size={17} aria-hidden="true" />
            History
          </button>
          <button
            role="tab"
            id="types-tab"
            aria-selected={byTest}
            aria-controls="results-panel"
            tabIndex={byTest ? 0 : -1}
            className={byTest ? 'selected' : ''}
            onClick={() => changeTab(true)}
            onKeyDown={tabKeys}
          >
            <FlaskConical size={17} aria-hidden="true" />
            By test
          </button>
          <button
            role="tab"
            id="vision-tab"
            aria-selected={vision}
            aria-controls="results-panel"
            tabIndex={vision ? 0 : -1}
            className={vision ? 'selected' : ''}
            onClick={() => update({ view: 'vision', offset: null, detail: null, document: null })}
            onKeyDown={tabKeys}
          >
            <Eye size={17} aria-hidden="true" />
            Vision
          </button>
        </CollectionTabs>
        <CollectionToolbar>
          <CollectionFilters
            search={query}
            onSearch={(q) => filterUpdate({ q }, true)}
            searchLabel="results"
            definitions={[
              visibilityFilter(params.get('visibility') || 'visible'),
              selectFilter({
                key: 'provider',
                label: 'Provider',
                value: providerId,
                options: (providers.data || []).map((provider) => ({
                  value: provider.id,
                  label: provider.name,
                })),
              }),
              dateRangeFilter(from, to),
            ]}
            onApply={(key, value) => {
              if (key === 'date') {
                const [from, to] = value.split('|');
                filterUpdate({ from, to });
              } else filterUpdate({ [key]: value });
            }}
          />
        </CollectionToolbar>
        {providers.error && (
          <p role="alert" className="helper-text">
            Provider filters are unavailable.{' '}
            <button className="text-link" onClick={providers.reload}>
              Retry
            </button>
          </p>
        )}
        {!byTest && !vision && (
          <OwnershipSelectionControl
            records={(history.data || []).map((r) => ({
              kind: 'observation',
              recordId: r.id,
              title: r.label + ' · ' + formatDate(r.date),
            }))}
            onApplied={() => {
              history.reload();
              window.location.reload();
            }}
          />
        )}
        <p className="coverage-caption">
          {vision ? 'Reviewed optical prescriptions only.' : 'Structured results only.'} Additional
          information may remain in <Link to="/sources">Sources</Link>.
        </p>
      </div>
      {vision ? (
        <VisionHistory
          filters={filters}
          onOffset={(offset) => update({ offset: String(offset) })}
        />
      ) : (
        <div
          id="results-panel"
          role="tabpanel"
          aria-labelledby={byTest ? 'types-tab' : 'history-tab'}
          className="results-workspace"
        >
          <section
            className="panel results-list"
            aria-label={byTest ? 'Test types' : 'Result history'}
          >
            <div className="list-top">
              <span>{byTest ? 'Measurements' : 'Result history'}</span>
              {!byTest && (
                <label>
                  <span className="sr-only">Result order</span>
                  <select
                    className="sort-select"
                    value={sort}
                    onChange={(event) => update({ sort: event.target.value, offset: null })}
                  >
                    <option value="newest">Newest first</option>
                    <option value="oldest">Oldest first</option>
                  </select>
                </label>
              )}
            </div>
            {byTest ? (
              <ResourceState resource={types} empty="No test types match these filters.">
                {(rows) => (
                  <>
                    {rows.map((test) => (
                      <button
                        key={test.id}
                        className={`result-row type-row ${selectedTypeId === test.id ? 'is-selected' : ''}`}
                        aria-pressed={selectedTypeId === test.id}
                        onClick={() => openType(test.id)}
                      >
                        <span className="row-copy">
                          <strong>{test.label}</strong>
                          {test.archived && <span className="soft-badge">Inactive</span>}
                          <span>
                            {test.category} · {test.count} results
                          </span>
                          <span className="type-date">
                            {test.unit ?? 'Unit not recorded'} · Latest {formatDate(test.lastDate)}
                          </span>
                          {test.context && <span className="type-date">{test.context}</span>}
                        </span>
                        <ChevronRight size={18} />
                      </button>
                    ))}
                    <Pagination
                      offset={offset}
                      limit={PAGE_SIZE}
                      total={typeof types.meta?.total === 'number' ? types.meta.total : undefined}
                      count={rows.length}
                      onChange={(offset) => update({ offset: String(offset) })}
                    />
                  </>
                )}
              </ResourceState>
            ) : (
              <ResourceState
                resource={history}
                empty="No structured test results match these filters. Optical prescriptions are listed on the Vision tab."
              >
                {(rows) => (
                  <>
                    {rows.map((result) => (
                      <button
                        key={result.id}
                        className={`result-row ${selectedResultId === result.id ? 'is-selected' : ''}`}
                        aria-pressed={selectedResultId === result.id}
                        onClick={() => openResult(result.id)}
                      >
                        <span className="row-copy">
                          <span className="result-name-and-badges">
                            <strong>{result.label}</strong>
                            {result.archived && <span className="soft-badge">Inactive</span>}
                            <RecordCorrectionBadges extra={result.extra} />
                          </span>
                          <span>{formatDate(result.date)}</span>
                          <span className="type-date">
                            {result.provider ?? 'Provider not recorded'}
                          </span>
                        </span>
                        <span className="row-number result-text-value">
                          {resultValue(result)}
                          <small>{resultUnit(result)}</small>
                        </span>
                        <ChevronRight size={18} />
                      </button>
                    ))}
                    <Pagination
                      offset={offset}
                      limit={PAGE_SIZE}
                      total={
                        typeof history.meta?.total === 'number' ? history.meta.total : undefined
                      }
                      count={rows.length}
                      onChange={(offset) => update({ offset: String(offset) })}
                    />
                  </>
                )}
              </ResourceState>
            )}
          </section>
          <section
            className={`panel result-detail ${!selectedResultId && !selectedTypeId ? 'empty-detail' : ''}`}
            aria-label="Selected result"
          >
            <button
              className="mobile-back text-link"
              onClick={() => {
                update({ detail: null });
                requestAnimationFrame(() =>
                  document.getElementById(byTest ? 'types-tab' : 'history-tab')?.focus(),
                );
              }}
            >
              <ArrowLeft size={19} />
              Test results
            </button>
            {selectedResultId ? (
              <ResourceState resource={detail}>
                {(result) =>
                  isReclassifiedRecord(result) ? (
                    <ClinicalRedirect record={result} />
                  ) : (
                    <>
                      <DetailHeader
                        eyebrow={byTest ? 'LATEST RESULT · OVER TIME' : 'RESULT DETAILS'}
                        title={result.label}
                        headingRef={detailHeading}
                        badges={
                          <>
                            <RecordCorrectionBadges extra={result.extra} />
                            {(byTest
                              ? types.data?.find((type) => type.id === result.testTypeId)?.archived
                              : result.archived) && <span className="soft-badge">Inactive</span>}
                          </>
                        }
                        metadata={
                          <>
                            <span>{formatDate(result.date)}</span>
                            <span>{result.provider ?? 'Provider not recorded'}</span>
                          </>
                        }
                        actions={
                          <EntryActions>
                            {!byTest && (
                              <RecordCorrectionAction
                                target={observationCorrectionTarget(result)}
                                onApplied={() => {
                                  setMeasurementRevision((value) => value + 1);
                                  detail.reload();
                                  history.reload();
                                  types.reload();
                                  latest.reload();
                                }}
                              />
                            )}
                            <ArchiveControl
                              showHistory
                              key={byTest ? result.testTypeId : result.id}
                              targetType={byTest ? 'test_type' : 'observation'}
                              targetId={byTest ? result.testTypeId : result.id}
                              onChanged={() => {
                                update(
                                  byTest ? { type: result.testTypeId } : { result: result.id },
                                  true,
                                );
                                detail.reload();
                                history.reload();
                                types.reload();
                              }}
                            />
                          </EntryActions>
                        }
                      />
                      <div className="detail-value-row">
                        <div>
                          <span className="display-value result-text-value">
                            {resultValue(result)} <small>{resultUnit(result)}</small>
                          </span>
                        </div>
                        <div className="result-actions">
                          {!byTest && (
                            <button
                              className="button primary"
                              onClick={() => openType(result.testTypeId)}
                            >
                              <ChartNoAxesCombined size={19} />
                              Chart this
                            </button>
                          )}
                          <SourceDialog result={result} />
                        </div>
                      </div>
                      <MeasurementReviewPanel
                        kind="observation"
                        recordId={result.id}
                        title={result.label}
                        referenceText={clinicalReferenceText(result.reference)}
                        onApplied={() => {
                          setMeasurementRevision((value) => value + 1);
                          detail.reload();
                          history.reload();
                          types.reload();
                          latest.reload();
                        }}
                      />
                      <dl className="result-metadata">
                        <div>
                          <dt>Recorded date</dt>
                          <dd>
                            {result.date ?? 'Unknown'}{' '}
                            <span className="muted">({result.datePrecision})</span>
                          </dd>
                        </div>
                        <div>
                          <dt>Source status</dt>
                          <dd>{result.status ?? 'Not recorded'}</dd>
                        </div>
                        {clinicalReferenceText(result.reference) ? (
                          <div>
                            <dt>Reference range</dt>
                            <dd>
                              <pre className="inline-raw">
                                {clinicalReferenceText(result.reference)}
                              </pre>
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                      <RecordCorrectionHistory extra={result.extra} open />
                      <div className="detail-chart">
                        <div className="section-heading">
                          <h3>Over time</h3>
                          <span className="helper-text">Includes inactive results</span>
                          <ComparePicker
                            personId={result.personId || personId}
                            selected={ids}
                            onAdd={(id) => setComparisons([...comparisons, id])}
                          />
                        </div>
                        <DateRange from={from} to={to} onChange={(values) => update(values)} />
                        <MeasurementCharts
                          {...{
                            revision: `${String(detail.meta?.revision ?? 'unknown')}:${measurementRevision}`,
                          }}
                          personId={result.personId || personId}
                          ids={ids}
                          from={from}
                          to={to}
                          providerId={providerId}
                          selectedId={result.id}
                          onSelect={openResult}
                          onRemove={(id) =>
                            setComparisons(comparisons.filter((item) => item !== id))
                          }
                        />
                      </div>
                      <details className="retained-details">
                        <summary>Additional retained fields</summary>
                        <pre className="raw-content">{JSON.stringify(result.extra, null, 2)}</pre>
                      </details>
                      {!byTest && (
                        <ClinicalRelationshipPanel
                          kind="observation"
                          recordId={result.id}
                          onApplied={() => {
                            setMeasurementRevision((value) => value + 1);
                            detail.reload();
                            history.reload();
                            types.reload();
                            latest.reload();
                          }}
                        />
                      )}
                      {!!result.evidence?.length && (
                        <div className="evidence-links">
                          <h3>Supporting representations</h3>
                          {result.evidence.map((evidence) => (
                            <div key={evidence.id}>
                              <span>{evidence.role}</span>
                              <SourceDialog
                                sourceRecordId={evidence.sourceRecordId}
                                label="Open evidence"
                              />
                              <pre className="inline-raw">{JSON.stringify(evidence.locator)}</pre>
                            </div>
                          ))}
                        </div>
                      )}
                      <AttachmentPanel ownerType="observation" ownerId={result.id} readOnly />
                      <RelatedNotes
                        targetType="observation"
                        targetId={result.id}
                        title="Notes on this result"
                      />
                      <RelatedNotes
                        targetType="test_type"
                        targetId={result.testTypeId}
                        title="Notes on this measurement"
                      />
                      <div className="detail-note">
                        <FlaskConical size={16} />
                        <span>
                          Database revision {String(detail.meta?.revision ?? 'unknown')} · Original
                          source remains canonical
                        </span>
                      </div>
                    </>
                  )
                }
              </ResourceState>
            ) : selectedTypeId ? (
              <ResourceState
                resource={latest}
                empty="No observations for this measurement in the selected date range."
              >
                {() => null}
              </ResourceState>
            ) : (
              <>
                <FlaskConical size={30} />
                <p>Select a result to see its details and source.</p>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export function DateRange({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (values: Record<string, string | null>) => void;
}) {
  const invalid = !!from && !!to && from > to;
  return (
    <div className="date-range">
      <label>
        From
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(event) => onChange({ from: event.target.value || null })}
        />
      </label>
      <label>
        To
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(event) => onChange({ to: event.target.value || null })}
        />
      </label>
      {(from || to) && (
        <button className="text-link" onClick={() => onChange({ from: null, to: null })}>
          All time
        </button>
      )}
      {invalid && <p role="alert">The start date must be before the end date.</p>}
    </div>
  );
}
