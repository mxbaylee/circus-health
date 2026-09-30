import { OwnershipSelectionControl } from '../features/clinical-review/OwnershipSelectionControl';
import {
  ClinicalRedirect,
  isReclassifiedRecord,
  currentClinicalRecord,
} from '../components/ClinicalRedirect';
import type { ReclassifiedRecord } from '../../shared/api';
import { CollectionToolbar } from '../components/CollectionLayout';
import { notifySuccess } from '../components/Toasts';
import { DetailHeader, EntryActions } from '../components/DetailHeader';
import { ArchiveControl } from '../components/ArchiveControl';
import { CollectionFilters, selectFilter, visibilityFilter } from '../components/CollectionFilters';
import { NoteDialog } from '../features/notes/NoteDialog';
import { useAssistantSelection } from '../features/assistant/pageContext';
import { RelatedNotes } from '../components/RelatedNotes';
import { LoadingIndicator } from '../components/LoadingIndicator';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { currentProfile } from '../data/profile';
import { ChevronRight, ArrowLeft, History } from 'lucide-react';
import type { Medication, Procedure, ProcedureCategory } from '../../shared/api';
import { api, apiUrl, ApiError, useResource, queryString } from '../data/api';
import { formatDate } from '../data/format';
import { Pagination, ResourceState } from '../components/ResourceState';
import { SourceDialog } from '../components/SourceDialog';
import { AttachmentPanel } from '../features/notes/AttachmentPanel';
import { RecordCorrectionAction } from '../features/clinical-review/RecordCorrectionAction';
import {
  medicationCorrectionTarget,
  procedureCorrectionTarget,
} from '../features/clinical-review/recordCorrectionTargets';
import { ClinicalRelationshipPanel } from '../features/clinical-review/ClinicalRelationshipPanel';
import { MeasurementReviewPanel } from '../features/clinical-review/MeasurementReviewPanel';
import '../clinical.css';
import '../components/medication-state.css';

// The category is supplied by the reviewed API classification, never inferred
// here from procedure names or from the organization that holds the source.
type ClinicalRecord = Medication | Procedure;
const categoryLabels: Record<ProcedureCategory, string> = {
  surgery: 'Surgery',
  clinical_procedure: 'Clinical procedure',
  imaging: 'Imaging',
  laboratory: 'Laboratory service',
  pathology: 'Pathology',
  unspecified: 'Unspecified source entry',
};
const procedureEventKindLabels = {
  order: 'Order',
  performed: 'Performed event',
  historical_mention: 'Historical mention',
  unknown: 'Event type unknown',
} as const;
type ProcedureEventKind = keyof typeof procedureEventKindLabels;
const objectRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const procedureEventKind = (extra: Record<string, unknown>): ProcedureEventKind => {
  const imported = objectRecord(extra.import);
  const acceptedMapping = objectRecord(imported?.acceptedMapping);
  const value = acceptedMapping?.eventKind;
  return typeof value === 'string' && value in procedureEventKindLabels
    ? (value as ProcedureEventKind)
    : 'unknown';
};
const procedureViews = {
  clinical: {
    label: 'Procedures & surgery',
    description:
      'Surgery, imaging and other procedure records. Lab and pathology entries are available separately.',
  },
  tests: {
    label: 'Lab & pathology entries',
    description:
      'Source entries for laboratory and pathology services. These entries are not numeric test results.',
  },
  all: {
    label: 'All source entries',
    description: 'All source procedure entries, including laboratory and pathology services.',
  },
};
const medicationViews = {
  current: {
    label: 'Active',
    description:
      'Your personal current medication list. Provider orders do not confirm current use.',
  },
  archived: {
    label: 'Inactive',
    description:
      'Prescriptions that are off in your personal list. Provider orders do not confirm current use.',
  },
  all: {
    label: 'All',
    description:
      'Every retained prescription, with your personal selection and its original source information.',
  },
};
const currentStatusLabels: Record<Medication['currentStatus'], string> = {
  current: 'Active',
  not_current: 'Inactive',
  unknown: 'Inactive',
};
const medicationStateLabel = (record: Medication) =>
  record.archived ? 'Inactive' : currentStatusLabels[record.currentStatus];

export function Medications() {
  return <ClinicalRecords kind="medications" />;
}
export function Procedures() {
  return <ClinicalRecords kind="procedures" />;
}

function ClinicalRecords({ kind }: { kind: 'medications' | 'procedures' }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigationState =
    location.state && typeof location.state === 'object' ? location.state : {};
  const activation = kind === 'medications' && params.get('activation') === '1';
  const q = params.get('q') ?? '';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const requestedCategory = params.get('category');
  const category =
    requestedCategory === 'tests' || requestedCategory === 'all' ? requestedCategory : 'clinical';
  const requestedStatus = params.get('status');
  const status =
    requestedStatus === 'archived' ||
    requestedStatus === 'inactive' ||
    requestedStatus === 'unreviewed' ||
    requestedStatus === 'unknown'
      ? 'archived'
      : requestedStatus === 'all'
        ? 'all'
        : 'current';
  const list = useResource<ClinicalRecord[]>(
    `/${kind}?${queryString({ personId: params.get('personId') || 'patient', q, visibility: kind === 'procedures' ? params.get('visibility') || 'visible' : undefined, limit: 40, offset, category: kind === 'procedures' ? category : undefined, status: kind === 'medications' ? status : undefined })}`,
  );
  // A source/evidence deep link remains available even outside the list's filter.
  const id = params.get('id') ?? list.data?.[0]?.id;
  const detail = useResource<ClinicalRecord | ReclassifiedRecord>(
    id ? `/${kind}/${encodeURIComponent(id)}` : null,
  );
  const currentDetail = currentClinicalRecord(detail.data);
  useEffect(() => {
    if (
      currentDetail?.personId &&
      currentDetail.personId !== (params.get('personId') || 'patient') &&
      params.get('id')
    ) {
      const next = new URLSearchParams(params);
      next.set('personId', currentDetail.personId);
      next.delete('offset');
      setParams(next, { replace: true });
    }
  }, [currentDetail?.personId, params, setParams]);
  useAssistantSelection(id ? { collection: kind, id } : undefined, currentDetail?.label);
  const change = (changes: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes))
      value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace, state: activation ? navigationState : undefined });
  };
  function startActivation() {
    if (activation) return;
    const next = new URLSearchParams(params);
    next.set('status', 'inactive');
    next.set('activation', '1');
    for (const key of ['q', 'offset', 'id']) next.delete(key);
    setParams(next, {
      state: {
        ...navigationState,
        prescriptionActivationReturn: {
          profileId: currentProfile()?.id,
          search: params.toString(),
        },
      },
    });
  }
  function finishActivation() {
    const { prescriptionActivationReturn: previous, ...state } = navigationState;
    // The snapshot belongs to this history entry and profile. Never restore a
    // former profile's filters when the keyed page reopens at the same URL.
    if (
      previous?.profileId &&
      previous.profileId === currentProfile()?.id &&
      typeof previous.search === 'string'
    ) {
      setParams(new URLSearchParams(previous.search), { replace: true, state });
      return;
    }
    // Imports and direct activation links have no prior list. Return to the
    // normal Active default, retaining explicit search and record selection.
    const next = new URLSearchParams(params);
    next.delete('activation');
    next.delete('status');
    setParams(next, { replace: true, state });
  }
  const empty =
    kind === 'procedures'
      ? `No entries match ${procedureViews[category].label.toLowerCase()} and this search. Other entries may be available in a different view or in Sources.`
      : `No medication records match ${medicationViews[status].label.toLowerCase()} and this search. Choose All to review other source records.`;
  function statusSaved(record: Medication, message: string) {
    notifySuccess(message);
    // Pin the selection before refreshing the filtered list: marking a current
    // record not current must not replace its detail with a different record.
    change({ id: record.id }, true);
    list.reload();
    detail.reload();
  }

  return (
    <div className={`page clinical-page ${params.get('id') ? 'clinical-mobile-detail' : ''}`}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR RECORDS</p>
          <h1>{kind === 'medications' ? 'Prescriptions' : 'Procedures'}</h1>
          <p className="page-subtitle">
            {kind === 'medications'
              ? medicationViews[status].description
              : procedureViews[category].description}
          </p>
        </div>
        {kind === 'medications' && (
          <button className="button secondary" onClick={startActivation}>
            Activate prescriptions
          </button>
        )}
      </div>
      <CollectionToolbar>
        <CollectionFilters
          search={q}
          onSearch={(q) => change({ q, offset: null, id: null }, true)}
          searchLabel={kind === 'medications' ? 'prescriptions' : 'procedures'}
          definitions={
            kind === 'medications'
              ? [
                  visibilityFilter(status, {
                    key: 'status',
                    activeValue: 'current',
                    inactiveValue: 'archived',
                  }),
                ]
              : [
                  visibilityFilter(params.get('visibility') || 'visible'),
                  selectFilter({
                    key: 'category',
                    label: 'Category',
                    value: category,
                    initial: 'clinical',
                    clear: 'all',
                    options: Object.entries(procedureViews).map(([value, view]) => ({
                      value,
                      label: view.label,
                    })),
                  }),
                ]
          }
          onApply={(key, value) =>
            change({
              [key]: value,
              ...(kind === 'medications' ? { visibility: null } : {}),
              offset: null,
              id: null,
            })
          }
        />
      </CollectionToolbar>
      {kind === 'medications' && params.get('activation') === '1' && (
        <section
          className="panel medication-activation"
          aria-label="Activate imported prescriptions"
        >
          <h2>Activate prescriptions you still take</h2>
          <p>
            Imported prescriptions start Inactive. Turn on the ones you still take below; each
            change saves to your personal medication list. Provider status remains separate.
          </p>
          <div className="medication-activation-actions">
            <button className="button primary" onClick={finishActivation}>
              Done
            </button>
            <button className="button secondary" onClick={finishActivation}>
              Skip for now
            </button>
          </div>
        </section>
      )}
      <OwnershipSelectionControl
        records={(list.data || []).map((r) => ({
          kind: kind === 'medications' ? 'medication' : 'procedure',
          recordId: r.id,
          title: r.label,
        }))}
        onApplied={() => {
          list.reload();
          detail.reload();
        }}
      />
      <div className="clinical-workspace">
        <section className="panel clinical-list">
          <ResourceState resource={list} empty={empty}>
            {(rows) => (
              <>
                {rows.map((record) => (
                  <button
                    className={`result-row ${id === record.id ? 'is-selected' : ''}`}
                    key={record.id}
                    onClick={() => change({ id: record.id })}
                  >
                    <span className="row-copy">
                      <strong>{record.label}</strong>
                      {!('kind' in record) && record.archived && (
                        <span className="soft-badge">Inactive</span>
                      )}
                      <span>
                        {'kind' in record
                          ? `${record.kind.replaceAll('_', ' ')} · ${medicationStateLabel(record)}`
                          : `${categoryLabels[record.category ?? 'unspecified']} · ${formatDate(record.date)}`}
                      </span>
                      {'kind' in record && (
                        <>
                          <span>Recorded date: {formatDate(record.sourceRecordedDate)}</span>
                          {record.doseText && <span>Source dose: {record.doseText}</span>}
                        </>
                      )}
                      <span>Source: {record.provider ?? 'Provider not recorded'}</span>
                    </span>
                    <ChevronRight size={18} />
                  </button>
                ))}
                <Pagination
                  offset={offset}
                  limit={40}
                  total={typeof list.meta?.total === 'number' ? list.meta.total : undefined}
                  count={rows.length}
                  onChange={(offset) => change({ offset: String(offset), id: null })}
                />
              </>
            )}
          </ResourceState>
        </section>
        <section className="panel clinical-detail">
          <button className="mobile-back text-link" onClick={() => change({ id: null })}>
            <ArrowLeft size={18} />
            Back to list
          </button>
          <ResourceState resource={detail} empty="Select a record to inspect its details.">
            {(record) =>
              isReclassifiedRecord(record) ? (
                <ClinicalRedirect record={record} />
              ) : (
                <ClinicalRecordDetail
                  key={record.id}
                  record={record}
                  activation={kind === 'medications' && params.get('activation') === '1'}
                  onStatusSaved={statusSaved}
                  onVisibilityChanged={() => {
                    change({ id: record.id }, true);
                    list.reload();
                    detail.reload();
                  }}
                  onCorrected={() => {
                    change({ id: record.id }, true);
                    list.reload();
                    detail.reload();
                  }}
                />
              )
            }
          </ResourceState>
        </section>
      </div>
    </div>
  );
}

export function ClinicalRecordDetail({
  record,
  onStatusSaved,
  onVisibilityChanged,
  onCorrected = () => {},
  activation = false,
}: {
  record: ClinicalRecord;
  onStatusSaved: (record: Medication, message: string) => void;
  onVisibilityChanged?: () => void;
  onCorrected?: () => void;
  activation?: boolean;
}) {
  const medication = 'kind' in record;
  const extra =
    record.extra !== null && typeof record.extra === 'object' && !Array.isArray(record.extra)
      ? (record.extra as Record<string, unknown>)
      : {};
  const presentationNote =
    typeof extra.presentationNote === 'string' ? extra.presentationNote : null;
  const evidenceBasis = typeof extra.evidenceBasis === 'string' ? extra.evidenceBasis : null;
  const originalLabel = typeof extra.originalLabel === 'string' ? extra.originalLabel : null;
  const reportedAsOf =
    medication &&
    record.kind === 'reported_use' &&
    typeof extra.asOf === 'string' &&
    extra.asOf.trim()
      ? extra.asOf
      : null;
  const testEntry =
    !medication && (record.category === 'laboratory' || record.category === 'pathology');
  const eventKind = medication ? null : procedureEventKind(extra);
  const eventKindLabel = eventKind ? procedureEventKindLabels[eventKind] : null;

  return (
    <>
      <DetailHeader
        eyebrow={medication ? 'PRESCRIPTION' : 'PROCEDURE'}
        title={record.label}
        badges={
          <>
            {medication ? (
              <span className="soft-badge">{medicationStateLabel(record)}</span>
            ) : (
              <>
                <span className="soft-badge">
                  {categoryLabels[record.category ?? 'unspecified']}
                </span>
                <span className="soft-badge">{eventKindLabel}</span>
                {record.archived && <span className="soft-badge">Inactive</span>}
              </>
            )}
          </>
        }
        metadata={
          <>
            <span>
              {medication ? 'Recorded' : 'Date'}{' '}
              {formatDate(medication ? record.sourceRecordedDate : record.date)}
            </span>
            <span>Source: {record.provider ?? 'Provider not recorded'}</span>
          </>
        }
        actions={
          medication && activation ? undefined : (
            <EntryActions>
              <RecordCorrectionAction
                target={
                  medication
                    ? medicationCorrectionTarget(record)
                    : procedureCorrectionTarget(record)
                }
                onApplied={onCorrected}
              />
              {medication ? (
                <MedicationStatusEditor record={record} onSaved={onStatusSaved} />
              ) : (
                <ArchiveControl
                  showHistory
                  targetType="procedure"
                  targetId={record.id}
                  onChanged={onVisibilityChanged}
                />
              )}
            </EntryActions>
          )
        }
      />
      {medication && activation && (
        <MedicationStatusEditor record={record} onSaved={onStatusSaved} />
      )}
      {testEntry && (
        <p className="procedure-category-notice">
          This is a lab or pathology source entry, not a numeric test result.{' '}
          <Link className="text-link" to="/tests">
            Open test results
          </Link>
        </p>
      )}
      <dl className="source-fields">
        <div>
          <dt>Source provider</dt>
          <dd>{record.provider ?? 'Not recorded'}</dd>
        </div>
        <div>
          <dt>{medication ? 'Source status' : 'Procedure status'}</dt>
          <dd>{record.status ?? 'Not recorded'}</dd>
        </div>
        {medication ? (
          <>
            <div>
              <dt>Record kind</dt>
              <dd>{record.kind.replaceAll('_', ' ')}</dd>
            </div>
            <div>
              <dt>Recorded date</dt>
              <dd>
                <time dateTime={record.sourceRecordedDate ?? undefined}>
                  {formatDate(record.sourceRecordedDate)}
                </time>
                {record.sourceRecordedDate?.includes('T') && (
                  <span className="medication-source-timestamp">{record.sourceRecordedDate}</span>
                )}
              </dd>
            </div>
            {reportedAsOf && (
              <div>
                <dt>Reported as of</dt>
                <dd>{formatDate(reportedAsOf)}</dd>
              </div>
            )}
            <div>
              <dt>Source dose</dt>
              <dd>{record.doseText ?? 'Not recorded'}</dd>
            </div>
            <div>
              <dt>Source route</dt>
              <dd>{record.route ?? 'Not recorded'}</dd>
            </div>
            <div>
              <dt>Source frequency</dt>
              <dd>{record.frequency ?? 'Not recorded'}</dd>
            </div>
            <div>
              <dt>Source start date</dt>
              <dd>{formatDate(record.startAt)}</dd>
            </div>
            <div>
              <dt>Source end date</dt>
              <dd>{formatDate(record.endAt)}</dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt>Record kind</dt>
              <dd>{eventKindLabel}</dd>
            </div>
            <div>
              <dt>Category</dt>
              <dd>{categoryLabels[record.category ?? 'unspecified']}</dd>
            </div>
            <div>
              <dt>Recorded date</dt>
              <dd>
                <time dateTime={record.date ?? undefined}>{formatDate(record.date)}</time>
                {record.date?.includes('T') && (
                  <span className="procedure-source-timestamp">{record.date}</span>
                )}
              </dd>
            </div>
            {originalLabel && originalLabel !== record.label && (
              <div>
                <dt>Original source label</dt>
                <dd>{originalLabel}</dd>
              </div>
            )}
          </>
        )}
      </dl>
      <p className="helper-text">
        {medication
          ? 'The fields above describe the retained source record. Its recorded date is separate from a medication start or end date. Your personal current-use status does not change the prescription or its source details.'
          : 'The source provider is the provider attributed in the record. It does not by itself establish where the procedure was performed.'}
      </p>
      {!medication && (presentationNote || evidenceBasis) && (
        <section className="procedure-context" aria-label="Record context">
          {presentationNote && <p>{presentationNote}</p>}
          {evidenceBasis && (
            <div>
              <h3>Evidence basis</h3>
              <p>{evidenceBasis}</p>
            </div>
          )}
        </section>
      )}
      <SourceDialog sourceRecordId={record.sourceRecordId} />
      {!medication && (
        <MeasurementReviewPanel
          kind="procedure"
          recordId={record.id}
          title={record.label}
          onApplied={() => onCorrected()}
        />
      )}
      {!activation && (
        <ClinicalRelationshipPanel
          kind={medication ? 'medication' : 'procedure'}
          recordId={record.id}
          onApplied={() => onCorrected()}
        />
      )}
      {!!record.evidence?.length && (
        <section className="evidence-links" aria-label="Supporting sources">
          <h3>Supporting sources</h3>
          {record.evidence.map((evidence) => (
            <div key={evidence.id}>
              <span>{evidence.role.replaceAll('_', ' ')}</span>
              <SourceDialog sourceRecordId={evidence.sourceRecordId} label="Open evidence" />
              <pre className="inline-raw">{JSON.stringify(evidence.locator, null, 2)}</pre>
            </div>
          ))}
        </section>
      )}
      <details className="retained-details">
        <summary>Additional retained fields</summary>
        <pre className="raw-content">{JSON.stringify(record.extra, null, 2)}</pre>
      </details>
      <AttachmentPanel
        ownerType={medication ? 'medication' : 'procedure'}
        ownerId={record.id}
        readOnly
      />
      <RelatedNotes targetType={medication ? 'medication' : 'procedure'} targetId={record.id} />
    </>
  );
}

export function MedicationStatusEditor({
  record,
  onSaved,
}: {
  record: Medication;
  onSaved: (record: Medication, message: string) => void;
}) {
  const [saved, setSaved] = useState(record);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const endpoint = apiUrl(`/medications/${encodeURIComponent(record.id)}`);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort();
    setSaved(record);
    setBusy(false);
    setConflict(false);
    setError('');
    return () => {
      request.current?.abort();
    };
  }, [record, endpoint]);

  async function save(current: boolean | 'unknown') {
    if (busy || conflict) return;
    const status = current === 'unknown' ? 'unknown' : current ? 'current' : 'not_current';
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await api<Medication>(`${endpoint}/current-status`, {
        method: 'PATCH',
        signal: controller.signal,
        body: JSON.stringify({
          status,
          version: saved.currentStatusVersion,
          visibilityVersion: saved.visibilityVersion,
        }),
      });
      if (controller.signal.aborted) return;
      setSaved(response.data);
      onSaved(
        response.data,
        status === 'unknown'
          ? 'Reviewed: current use remains unknown.'
          : `Prescription saved: ${medicationStateLabel(response.data)}.`,
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      const versionConflict = cause instanceof ApiError && cause.code === 'VERSION_CONFLICT';
      setConflict(versionConflict);
      setError(
        versionConflict
          ? 'This prescription’s current or archive status changed elsewhere. Reload the saved status before choosing again.'
          : cause instanceof Error
            ? cause.message
            : 'The personal status could not be saved.',
      );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function reload() {
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await api<Medication>(endpoint, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setSaved(response.data);
      setConflict(false);
      onSaved(response.data, 'Loaded the latest saved personal status.');
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'The saved status could not be loaded.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const history: { status: string; recordedAt: string | null; actor: string }[] = [];
  let assertion = saved.currentStatusAssertion;
  let historyStatus: string = saved.currentStatus,
    recordedAt = saved.currentStatusUpdatedAt;
  while (assertion && typeof assertion === 'object' && !Array.isArray(assertion)) {
    const entry = assertion as Record<string, unknown>;
    history.push({
      status: historyStatus,
      recordedAt,
      actor: typeof entry.actor === 'string' ? entry.actor : 'Not recorded',
    });
    historyStatus = typeof entry.previousStatus === 'string' ? entry.previousStatus : 'unknown';
    recordedAt = typeof entry.previousUpdatedAt === 'string' ? entry.previousUpdatedAt : null;
    assertion = entry.previousAssertion;
  }
  return (
    <section className="medication-current-status" aria-label="Personal current medication status">
      <div className="medication-status-controls">
        <label className="medication-current-switch">
          {saved.currentStatus === 'current' && !saved.archived ? 'Active' : 'Inactive'}
          <input
            type="checkbox"
            role="switch"
            aria-label="Active"
            checked={saved.currentStatus === 'current' && !saved.archived}
            disabled={busy || conflict}
            onChange={(event) => void save(event.target.checked)}
          />
        </label>
        {busy && <LoadingIndicator label="Saving…" layout="control" />}
        <button
          className="entry-history-action medication-status-help"
          aria-label="Current use history and details"
          aria-haspopup="dialog"
          onClick={() => setDetailsOpen(true)}
        >
          <History size={16} aria-hidden="true" />
          History
        </button>
      </div>
      {error && (
        <p className="medication-status-error" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <button className="button secondary" disabled={busy} onClick={() => void reload()}>
          Reload saved status
        </button>
      )}
      <NoteDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        title="Current use history"
        description="Personal selections about this record. These do not change the provider’s prescription or indicate clinician discontinuation."
      >
        {history.length ? (
          <ol className="medication-status-history">
            {history.map((entry, index) => (
              <li key={index}>
                <strong>
                  {currentStatusLabels[entry.status as Medication['currentStatus']] || entry.status}
                </strong>
                <span>
                  {entry.recordedAt
                    ? new Date(entry.recordedAt).toLocaleString()
                    : 'Time not recorded'}{' '}
                  · By: {entry.actor}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p>No personal current-use assertion has been saved.</p>
        )}
        {!!saved.archiveHistory?.length && (
          <section aria-label="Archive history">
            <h3>Archive history</h3>
            <ol className="medication-status-history">
              {saved.archiveHistory.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.archived ? 'Archived' : 'Restored'}</strong>
                  <span>
                    {new Date(entry.createdAt).toLocaleString()} · By: {entry.actor}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
        <Link
          className="text-link"
          to={`/notes?${queryString({ new: 1, kind: 'note', targetType: 'medication', targetId: saved.id })}`}
        >
          Add a linked note with rationale or attachments
        </Link>
        {saved.currentStatusAssertion != null && (
          <details>
            <summary>Retained assertion details</summary>
            <pre className="raw-content">
              {typeof saved.currentStatusAssertion === 'string'
                ? saved.currentStatusAssertion
                : JSON.stringify(saved.currentStatusAssertion, null, 2)}
            </pre>
          </details>
        )}
      </NoteDialog>
    </section>
  );
}
