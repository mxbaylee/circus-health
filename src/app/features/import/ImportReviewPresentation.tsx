import type { IntakeIdentityAnswers } from '../../../shared/intake-identity';
import type { IntakeIdentityReview } from '../../../shared/intake-identity';
import {
  ImportPersonChoice,
  ImportBirthDateReview,
  ImportPrintedName,
  printedNameReady,
  personSelectionReady,
  type ImportPersonSelection,
} from './ImportPersonChoice';
import type { IntakeBatchReadingState } from '../../../shared/intake-batch';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Ellipsis,
  FileSearch,
  FlaskConical,
  Glasses,
  HeartPulse,
  Link2,
  List,
  NotebookPen,
  Pill,
  Search,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { ImportSourceSelection, useSourceSelection } from './import-source-selection';
import type {
  IntakeAcceptedRecord,
  IntakeReportAcceptanceBlock,
  IntakeDraftRepairField,
  IntakeDraftRepairSelection,
  IntakeReportSourceCoverage,
  IntakeReportSourceReview,
} from '../../../shared/intake';
import { measurementValueDisplay } from '../../../shared/measurement-value';
import { ImportReadingActivity } from './ImportReadingActivity';
import { ImportIdentityWarnings } from './ImportIdentityWarnings';
import {
  SavedPersonDestinationLink,
  SavedRecordDestinationLink,
  type SavedPersonDestination,
} from './SavedRecordDestinations';
import './import-review.css';

export type ImportReviewStatus = 'review' | 'later' | 'excluded' | 'saved';
export type ImportReviewKind =
  'Test results' | 'Prescriptions' | 'Vision' | 'Procedures' | 'Documents' | 'People';

export interface ImportReviewRecord {
  approval?: IntakeReportAcceptanceBlock;
  id: string;
  reportId: string;
  kind: ImportReviewKind;
  label: string;
  originalLabel: string;
  value: string;
  unit?: string;
  date?: string;
  status: ImportReviewStatus;
  eligible: boolean;
  /** Honest current blocker for an otherwise actionable review row. */
  saveBlockReason?: string;
  /** Ownership blockers use the report control, never a clinical value editor. */
  saveBlockReview?: 'identity';
  manuallyEdited?: boolean;
  relatedMatch?: { value: string; source: string; date: string };
  /** Similar literal/date in the same original; does not establish a duplicate. */
  possibleOverlap?: boolean;
  originalUrl?: string;
  detailUrl?: string;
  savedDestination?: IntakeAcceptedRecord;
  savedPersonDestination?: SavedPersonDestination;
  draftRepair?: {
    intakeId: string;
    proposalId: string | null;
    recordId: string;
    candidateVersionId: string;
    fields: Partial<Record<IntakeDraftRepairField, string>>;
  };
}

export interface ImportReviewReport {
  sourceIntakeId?: string;
  filename?: string;
  id: string;
  source: string;
  sourceSuggested?: boolean;
  sourceLabelAvailable?: boolean;
  sourceNeedsLabel?: boolean;
  sourceEvidence?: { label: string; contentUrl?: string };
  sourceConfirmed: boolean;
  sourceCoverage?: IntakeReportSourceCoverage;
  reportType: string;
  date: string;
  subject: {
    label: string;
    evidence: 'named' | 'missing';
    confirmed: boolean;
    nameOnlyMatch?: boolean;
    birthDate?: string;
    birthDateReview?: NonNullable<IntakeIdentityReview['scope']>['birthDateReview'];
    selfBirthDateConflict?: boolean;
    defaultPerson?: 'self' | 'new';
    identityStatus?:
      | 'evidenced_match'
      | 'prior_confirmation'
      | 'confirmation_required'
      | 'missing_warning'
      | 'conflict';
    identityMessage?: string;
    warnings?: IntakeIdentityReview['warnings'];
    blocking?: boolean;
    offeredSelfFields?: { fullName?: string; birthDate?: string };
    selfDisplayName?: string;
    selfNames?: string[];
    people?: IntakeIdentityReview['people'];
    peopleTruncated?: boolean;
    assignedPerson?: IntakeIdentityReview['assignedPerson'];
    printedName?: string;
    printedNameRequired?: boolean;
    evidenceText?: string;
    questions?: { prompt: string; textAnchor?: string }[];
    targetCount?: number;
    scopeReady?: boolean;
    scopeError?: string;
    conflicts?: {
      field: 'fullName' | 'birthDate';
      selfValue: string | null;
      evidencedValue: string | null;
      reason: 'self_mismatch' | 'evidence_disagreement';
    }[];
    reviewUrl?: string;
    hidden?: boolean;
  };
}

export interface ImportReviewModel {
  contextKey?: string;
  /** No settled feed for the requested filters yet; absence is not an empty result. */
  loading?: boolean;
  confirmedSavedIds?: string[];
  reports: ImportReviewReport[];
  records: ImportReviewRecord[];
  counts?: Record<ImportReviewStatus, number>;
  kindCounts?: Partial<Record<ImportReviewKind | 'All', number>>;
  filters?: {
    view: ImportReviewStatus;
    kind: ImportReviewKind | 'All';
    query: string;
    editedOnly: boolean;
  };
  hasMore?: boolean;
  loadingMore?: boolean;
  searchAppliedByModel?: boolean;
  operationStatus?: string;
  activity?: {
    activeFiles: number;
    label: string;
    detail: string;
    detailIsImportant?: boolean;
    paused?: boolean;
    uploading?: boolean;
    controlsBusy?: boolean;
    resumeLabel?: string;
    progress?: {
      /** Calendar time for this batch, including provider and queue waits. */
      elapsedStartedAt?: string | null;
      elapsedEndedAt?: string | null;
      accounted: number;
      total: number;
      readyRecords: number;
      readWindows: number;
      activeMs: number;
      sliceStartedAt: string | null;
      lastProgressAt: string | null;
      pageTiming?: IntakeBatchReadingState['pageTiming'];
    };
  };
}

export interface ImportReviewActions {
  busy?: boolean;
  onFiles?: (files: File[]) => void | Promise<void>;
  onSave?: (
    recordIds: string[],
    approvals?: IntakeReportAcceptanceBlock[],
  ) => void | boolean | { savedIds: string[] } | Promise<void | boolean | { savedIds: string[] }>;
  onLater?: (recordIds: string[]) => void | Promise<void>;
  onExclude?: (recordIds: string[]) => void | Promise<void>;
  onResume?: (recordIds: string[]) => void | Promise<void>;
  onUseSource?: (
    reportId: string,
    source: string,
    review?: IntakeReportSourceReview,
  ) => void | string | null | Promise<void | string | null>;
  onReviewSource?: (reportId: string) => Promise<IntakeReportSourceReview>;
  onConfirmIdentity?: (
    reportId: string,
    fields: { fullName?: string; birthDate?: string },
    personSelection?: ImportPersonSelection,
    printedName?: string,
    identityAnswers?: IntakeIdentityAnswers,
  ) => void | Promise<void>;
  onEdit?: (recordId: string, value: string, unit: string) => void | Promise<void>;
  onResolveMatch?: (recordId: string) => void | Promise<void>;
  onCorrectDrafts?: (
    selection: IntakeDraftRepairSelection,
    field: IntakeDraftRepairField,
    after: string,
  ) => Promise<string | null>;
  onAskDraftRepair?: (selection: IntakeDraftRepairSelection, request: string) => void;
  onFiltersChange?: (filters: NonNullable<ImportReviewModel['filters']>) => void;
  onLoadMore?: () => void | Promise<void>;
  onResumeReading?: () => void | Promise<void>;
  onStopReading?: () => void | Promise<void>;
}

type SheetState =
  | { type: 'original'; recordId: string }
  | { type: 'identity'; reportId: string }
  | { type: 'source'; reportId: string }
  | { type: 'edit'; recordId: string }
  | { type: 'compare'; recordId: string }
  | { type: 'correct'; recordIds: string[] }
  | null;

const kindIcons: Record<ImportReviewKind | 'All', typeof List> = {
  All: List,
  'Test results': FlaskConical,
  Prescriptions: Pill,
  Vision: Glasses,
  Procedures: HeartPulse,
  Documents: NotebookPen,
  People: UsersRound,
};

const statusLabels: Record<ImportReviewStatus, string> = {
  review: 'To review',
  later: 'Review later',
  excluded: 'Excluded',
  saved: 'Saved',
};

const saveBlockDescriptionId = (recordId: string) =>
  `import-save-block-${recordId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

function ImportMeasurementValue({
  value,
  unit,
  compactUnit = false,
}: {
  value: string;
  unit?: string;
  compactUnit?: boolean;
}) {
  const display = measurementValueDisplay(value, unit);
  return (
    <>
      {display.valueText}
      {display.appendedUnit && (
        <> {compactUnit ? <small>{display.appendedUnit}</small> : display.appendedUnit}</>
      )}
    </>
  );
}

export function ImportReviewPresentation({
  model,
  actions = {},
  renderRecordReview,
  beforeReviewChange,
  renderReportSourceReview,
  renderSourceAttention,
  requestedRecordId,
  preserveSourceReview = false,
}: {
  renderRecordReview?: (record: ImportReviewRecord, close: () => void) => ReactNode;
  beforeReviewChange?: () => Promise<boolean>;
  renderReportSourceReview?: (report: ImportReviewReport) => ReactNode;
  renderSourceAttention?: (onCount: (count: number) => void) => ReactNode;
  requestedRecordId?: string;
  preserveSourceReview?: boolean;
  model?: ImportReviewModel;
  actions?: ImportReviewActions;
}) {
  const [reports, setReports] = useState(model?.reports || []);
  const [records, setRecords] = useState(model?.records || []);
  const presentedContext = useRef(model?.contextKey);
  const [view, setView] = useState<ImportReviewStatus>('review');
  const [kind, setKind] = useState<ImportReviewKind | 'All'>('All');
  const [query, setQuery] = useState('');
  const [sourceAttention, setSourceAttention] = useState(false);
  const [attentionCount, setAttentionCount] = useState<number | null>(null);
  const sourceSelection = useSourceSelection();
  const [approvingSections, setApprovingSections] = useState(false);
  const [editedOnly, setEditedOnly] = useState(false);
  const selectedSnapshots = useRef(new Map<string, ImportReviewRecord>());
  const [selected, setSelected] = useState(() => new Set<string>());
  const [sheet, setSheet] = useState<SheetState>(null);
  const sheetReturnFocus = useRef<HTMLElement | null>(null);
  const lastIdentitySheet = useRef<{ reportId: string; confirmed: boolean } | null>(null);
  const dragDepth = useRef(0);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [notice, setNotice] = useState('');
  const [expandedRecord, setExpandedRecord] = useState<string | null>(null);
  const pinnedReview = useRef<{
    record: ImportReviewRecord;
    report: ImportReviewReport;
    contextKey?: string;
  } | null>(null);
  const confirmedSaved = useRef(new Set<string>());
  const reviewChangeGeneration = useRef(0);
  async function openRecordReview(record: ImportReviewRecord) {
    const generation = ++reviewChangeGeneration.current;
    if (beforeReviewChange && !(await beforeReviewChange())) return;
    if (generation !== reviewChangeGeneration.current) return;
    const report = reports.find((item) => item.id === record.reportId);
    if (report) pinnedReview.current = { record, report, contextKey: model?.contextKey };
    setExpandedRecord((current) => (current === record.id ? null : record.id));
  }
  useEffect(() => {
    if (!model) return;
    const contextChanged = presentedContext.current !== model.contextKey;
    presentedContext.current = model.contextKey;
    if (contextChanged) {
      confirmedSaved.current.clear();
      selectedSnapshots.current.clear();
      setSourceAttention(false);
    }
    if (preserveSourceReview && !contextChanged) return;
    for (const id of model.confirmedSavedIds || []) confirmedSaved.current.add(id);
    setSelected((current) => new Set([...current].filter((id) => !confirmedSaved.current.has(id))));
    // A background feed refresh must not unmount a draft whose version was
    // superseded. Its existing editor keeps the conflict/acceptance checks.
    const pinned = pinnedReview.current;
    const retain =
      pinned && pinned.contextKey === model.contextKey && expandedRecord === pinned.record.id;
    const currentRecords = model.records.map((record) =>
      confirmedSaved.current.has(record.id) ? { ...record, status: 'saved' as const } : record,
    );
    setReports(
      retain
        ? model.reports.some((item) => item.id === pinned.report.id)
          ? model.reports.map((item) => (item.id === pinned.report.id ? pinned.report : item))
          : [...model.reports, pinned.report]
        : model.reports,
    );
    setRecords(
      retain
        ? currentRecords.some((item) => item.id === pinned.record.id)
          ? currentRecords.map((item) => (item.id === pinned.record.id ? pinned.record : item))
          : [...currentRecords, pinned.record]
        : currentRecords,
    );
    if (model.filters) {
      setView(model.filters.view);
      setKind(model.filters.kind);
      setQuery(model.filters.query);
      setEditedOnly(model.filters.editedOnly);
    }
  }, [model, expandedRecord, preserveSourceReview]);
  useEffect(() => {
    if (model?.contextKey) {
      setSelected(new Set());
      setSheet(null);
      setExpandedRecord(null);
    }
  }, [model?.contextKey]);
  useEffect(() => {
    if (requestedRecordId) {
      setSourceAttention(false);
      const record = model?.records.find((item) => item.id === requestedRecordId);
      const report = model?.reports.find((item) => item.id === record?.reportId);
      if (record && report) {
        pinnedReview.current = { record, report, contextKey: model?.contextKey };
        setView(record.status);
        if (model?.filters && model.filters.view !== record.status)
          actions.onFiltersChange?.({ ...model.filters, view: record.status });
      }
      setExpandedRecord(requestedRecordId);
    }
  }, [requestedRecordId]);
  useEffect(() => {
    if (sheet && document.activeElement instanceof HTMLElement)
      sheetReturnFocus.current = document.activeElement;
  }, [sheet]);
  useEffect(() => {
    if (sheet?.type !== 'identity') {
      lastIdentitySheet.current = null;
      return;
    }
    const current = (model?.reports || reports).find((report) => report.id === sheet.reportId);
    const previous = lastIdentitySheet.current;
    if (
      !current ||
      (previous?.reportId === current.id &&
        !previous.confirmed &&
        current.subject.confirmed &&
        !Object.keys(current.subject.offeredSelfFields || {}).length)
    )
      setSheet(null);
    lastIdentitySheet.current = current
      ? { reportId: current.id, confirmed: current.subject.confirmed }
      : null;
  }, [model, reports, sheet]);

  async function changeFilters(patch: Partial<NonNullable<ImportReviewModel['filters']>>) {
    if (approvingSections) return;
    const generation = ++reviewChangeGeneration.current;
    if (beforeReviewChange && !(await beforeReviewChange())) return;
    if (generation !== reviewChangeGeneration.current) return;
    const next = { view, kind, query, editedOnly, ...patch };
    setExpandedRecord(null);
    setSourceAttention(false);
    setView(next.view);
    setKind(next.kind);
    setQuery(next.query);
    setEditedOnly(next.editedOnly);
    setSelected(new Set());
    sourceSelection.files.forEach((file) => file.select(false));
    actions.onFiltersChange?.(next);
  }

  const localCounts = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(statusLabels) as ImportReviewStatus[]).map((status) => [
          status,
          records.filter((record) => record.status === status).length,
        ]),
      ) as Record<ImportReviewStatus, number>,
    [records],
  );
  const counts = model?.counts || localCounts;
  const scoped = useMemo(
    () =>
      records.filter(
        (record) =>
          record.status === view &&
          (!editedOnly || kind === 'People' || record.manuallyEdited) &&
          (model?.searchAppliedByModel ||
            `${record.label} ${record.value} ${reports.find((report) => report.id === record.reportId)?.source}`
              .toLowerCase()
              .includes(query.toLowerCase())),
      ),
    [editedOnly, kind, model?.searchAppliedByModel, query, records, reports, view],
  );
  const kinds = useMemo(
    () =>
      [
        'All',
        ...([
          'Test results',
          'Prescriptions',
          'Vision',
          'Procedures',
          'Documents',
          'People',
        ] as ImportReviewKind[]),
      ] as const,
    [],
  );
  const visible = scoped.filter((record) => kind === 'All' || record.kind === kind);
  const activeKindCount =
    kind === 'All'
      ? null
      : (model?.kindCounts?.[kind] ?? scoped.filter((record) => record.kind === kind).length);
  useEffect(() => {
    if (preserveSourceReview || model?.loading || approvingSections) return;
    // The model and local tab can differ during a server-filtered request.
    if (model?.filters && model.filters.kind !== kind) return;
    if (
      (sourceAttention && attentionCount === 0) ||
      (!sourceAttention && kind !== 'All' && activeKindCount === 0)
    )
      void changeFilters({ kind: 'All' });
  }, [
    sourceAttention,
    attentionCount,
    kind,
    activeKindCount,
    preserveSourceReview,
    model?.loading,
    model?.filters,
    approvingSections,
  ]);
  const sourceCount = view === 'review' ? attentionCount || 0 : 0;
  const selectableRecords = sourceAttention ? [] : visible;
  const shownSourceFiles =
    view === 'review' && (sourceAttention || kind === 'All') ? sourceSelection.files : [];
  const selectableSections = shownSourceFiles.reduce((sum, file) => sum + file.count, 0);
  const selectedSections = shownSourceFiles.reduce((sum, file) => sum + file.selected, 0);
  const sectionPending = approvingSections || shownSourceFiles.some((file) => file.pending);
  const visibleSelected = selectableRecords.filter((record) => selected.has(record.id));
  const selectedCount = visibleSelected.length + selectedSections;
  const selectableCount = selectableRecords.length + selectableSections;
  async function approveSelectedSections() {
    if (sectionPending || actions.busy) return;
    setApprovingSections(true);
    try {
      for (const file of shownSourceFiles) {
        if (file.selected && !(await file.approve())) break;
      }
    } finally {
      setApprovingSections(false);
    }
  }
  const readySelected = visibleSelected.filter((record) => record.eligible);
  const readyClinical = readySelected.filter((record) => record.kind !== 'People');
  const readyPeople = readySelected.filter((record) => record.kind === 'People');
  const correctableSelected = visibleSelected.filter((record) => record.draftRepair);
  const canCorrectSelection =
    correctableSelected.length === visibleSelected.length &&
    correctableSelected.length > 0 &&
    new Set(correctableSelected.map((record) => record.reportId)).size === 1;

  async function move(ids: string[], status: ImportReviewStatus) {
    if (beforeReviewChange && !(await beforeReviewChange())) return;
    const action =
      status === 'saved'
        ? actions.onSave
        : status === 'later'
          ? actions.onLater
          : status === 'excluded'
            ? actions.onExclude
            : actions.onResume;
    if (model && action) {
      const context = model.contextKey;
      const approvals = ids.flatMap((id) =>
        selectedSnapshots.current.get(id)?.approval
          ? [selectedSnapshots.current.get(id)!.approval!]
          : [],
      );
      const succeeded =
        status === 'saved'
          ? await (approvals.length ? actions.onSave?.(ids, approvals) : actions.onSave?.(ids))
          : await action(ids);
      const savedIds =
        succeeded && typeof succeeded === 'object'
          ? succeeded.savedIds
          : succeeded === true
            ? ids
            : [];
      if (status === 'saved' && savedIds.length && presentedContext.current === context) {
        for (const id of savedIds) confirmedSaved.current.add(id);
        if (
          pinnedReview.current &&
          savedIds.includes(pinnedReview.current.record.id) &&
          (!beforeReviewChange || (await beforeReviewChange()))
        ) {
          pinnedReview.current = null;
          setExpandedRecord(null);
        }
        setRecords((current) =>
          current.map((record) => (savedIds.includes(record.id) ? { ...record, status } : record)),
        );
        setSelected((current) => new Set([...current].filter((id) => !savedIds.includes(id))));
      }
      return;
    }
    setRecords((current) =>
      current.map((record) => (ids.includes(record.id) ? { ...record, status } : record)),
    );
    setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        const record = records.find((record) => record.id === id);
        if (record) selectedSnapshots.current.set(id, record);
      }
      return next;
    });
  }

  function confirmReportIdentity(
    reportId: string,
    fields: { fullName?: string; birthDate?: string } = {},
    personSelection?: ImportPersonSelection,
    printedName?: string,
    identityAnswers?: IntakeIdentityAnswers,
  ) {
    const report = reports.find((item) => item.id === reportId);
    if (!report || actions.busy) return;
    if (!personSelectionReady(personSelection)) return;
    if (model && actions.onConfirmIdentity) {
      setSheet(null);
      if (identityAnswers)
        void actions.onConfirmIdentity(
          reportId,
          fields,
          personSelection,
          printedName,
          identityAnswers,
        );
      else if (printedName)
        void actions.onConfirmIdentity(reportId, fields, personSelection, printedName);
      else if (personSelection) void actions.onConfirmIdentity(reportId, fields, personSelection);
      else void actions.onConfirmIdentity(reportId, fields);
      return;
    }
    setReports((current) =>
      current.map((report) =>
        report.id === reportId
          ? { ...report, subject: { ...report.subject, confirmed: true } }
          : report,
      ),
    );
    setRecords((current) =>
      current.map((record) =>
        record.reportId === reportId && !record.relatedMatch
          ? { ...record, eligible: true }
          : record,
      ),
    );
    setSheet(null);
    setNotice(
      Object.keys(fields).length
        ? 'Identity and the selected blank Self details were confirmed in one action.'
        : 'Identity confirmed. Your profile name was not changed.',
    );
  }

  function hasDraggedFiles(dataTransfer: DataTransfer) {
    return Array.from(dataTransfer.types).includes('Files');
  }

  function submitFiles(files: File[]) {
    if (files.length) void actions.onFiles?.(files);
  }

  return (
    <div className="import-review-page">
      <header className="import-review-heading">
        <div>
          <p className="eyebrow">IMPORT</p>
          <h1>Review reports</h1>
          <p>Check the values. Save what looks right.</p>
        </div>
      </header>

      <section
        className={`import-upload-card${fileDragActive ? ' is-dragging' : ''}`}
        aria-label="Upload reports"
        onDragEnter={(event) => {
          if (!hasDraggedFiles(event.dataTransfer)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setFileDragActive(true);
        }}
        onDragOver={(event) => {
          if (!hasDraggedFiles(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setFileDragActive(true);
        }}
        onDragLeave={(event) => {
          if (!fileDragActive) return;
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setFileDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setFileDragActive(false);
          submitFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <label className={`import-dropzone${fileDragActive ? ' is-dragging' : ''}`}>
          <input
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.zip,.jsonl"
            onChange={(event) => {
              const files = [...(event.target.files || [])];
              submitFiles(files);
              event.target.value = '';
            }}
          />
          <FileSearch aria-hidden="true" />
          <span>
            <strong>Drop reports here</strong>
            <small>PDF, photos, ZIP or JSONL · up to 128 MB per file</small>
          </span>
          <span className="button secondary">Browse files</span>
        </label>
        <ImportReadingActivity
          activity={model?.activity}
          onStop={actions.onStopReading}
          onResume={actions.onResumeReading}
        />
        <p className="import-upload-note">
          Files upload immediately. Originals stay in your archive.
        </p>
      </section>

      <section aria-labelledby="import-review-title">
        <div className="import-queue-heading">
          <h2 id="import-review-title">
            {sourceAttention ? (
              <>
                Needs attention <span>{attentionCount || 0}</span>
              </>
            ) : (
              <>
                {statusLabels[view]} <span>{counts[view] + sourceCount}</span>
              </>
            )}
          </h2>
          <label>
            <span className="sr-only">Review status</span>
            <select
              value={view}
              disabled={sourceAttention}
              onChange={(event) => {
                void changeFilters({ view: event.target.value as ImportReviewStatus });
              }}
            >
              {(Object.keys(statusLabels) as ImportReviewStatus[]).map((status) => (
                <option value={status} key={status}>
                  {statusLabels[status]} (
                  {counts[status] + (status === 'review' ? attentionCount || 0 : 0)})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="import-kind-tabs" role="tablist" aria-label="Record kinds">
          {kinds
            .filter((item) => {
              if (item === 'All') return true;
              if (model?.loading && item === kind) return true;
              const count =
                model?.kindCounts?.[item] ?? scoped.filter((record) => record.kind === item).length;
              return count > 0;
            })
            .map((item) => {
              const Icon = kindIcons[item];
              const count =
                item === 'All'
                  ? scoped.length
                  : scoped.filter((record) => record.kind === item).length;
              return (
                <button
                  type="button"
                  role="tab"
                  disabled={approvingSections}
                  aria-selected={!sourceAttention && kind === item}
                  onClick={() => {
                    void changeFilters({ kind: item });
                  }}
                  key={item}
                >
                  <Icon size={15} />
                  {item}
                  <span>
                    {model?.loading
                      ? '…'
                      : (model?.kindCounts?.[item] ?? count) + (item === 'All' ? sourceCount : 0)}
                  </span>
                </button>
              );
            })}
          {renderSourceAttention && view === 'review' && (attentionCount ?? 0) > 0 && (
            <button
              type="button"
              role="tab"
              disabled={approvingSections}
              aria-selected={sourceAttention}
              onClick={() =>
                void (async () => {
                  if (beforeReviewChange && !(await beforeReviewChange())) return;
                  setExpandedRecord(null);
                  setSelected(new Set());
                  sourceSelection.files.forEach((file) => file.select(false));
                  setSourceAttention(true);
                })()
              }
            >
              <FileSearch size={15} />
              Needs attention <span>{attentionCount}</span>
            </button>
          )}
        </div>
        {!sourceAttention && (
          <>
            {visible.some((record) => record.kind === 'Documents') && (
              <p className="import-upload-note">
                Find saved documents in <a href="#/sources">Sources</a>. Clinician notes may also
                appear in Historical notes. Unsupported items stay with the original.
              </p>
            )}
            <div className="import-filters">
              <label className="import-search">
                <Search size={16} />
                <span className="sr-only">Search records</span>
                <input
                  value={query}
                  onChange={(event) => {
                    void changeFilters({ query: event.target.value });
                  }}
                  type="search"
                  placeholder="Search records…"
                />
              </label>
              <label className="import-check-label">
                <input
                  type="checkbox"
                  checked={editedOnly}
                  onChange={(event) => {
                    void changeFilters({ editedOnly: event.target.checked });
                  }}
                />
                Manually edited
              </label>
            </div>
            {notice && (
              <div className="import-notice" role="status">
                <span>{notice}</span>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => setNotice('')}
                >
                  <X size={16} />
                </button>
              </div>
            )}
          </>
        )}
        {(view === 'review' || view === 'later') && selectableCount > 0 && (
          <div className="import-bulk-bar">
            <label className="import-check-label">
              <input
                type="checkbox"
                disabled={sectionPending || actions.busy}
                checked={selectedCount === selectableCount}
                ref={(input) => {
                  if (input)
                    input.indeterminate = selectedCount > 0 && selectedCount < selectableCount;
                }}
                onChange={() => {
                  const all = selectedCount !== selectableCount;
                  shownSourceFiles.forEach((file) => file.select(all));
                  if (all)
                    for (const record of selectableRecords)
                      if (!selected.has(record.id))
                        selectedSnapshots.current.set(record.id, record);
                  setSelected(
                    !all
                      ? new Set(
                          [...selected].filter(
                            (id) => !selectableRecords.some((record) => record.id === id),
                          ),
                        )
                      : new Set([...selected, ...selectableRecords.map((record) => record.id)]),
                  );
                }}
              />
              {selectedCount ? `${selectedCount} selected` : 'Select all shown'}
            </label>
            {selectedSections > 0 && (
              <button
                className="button primary"
                type="button"
                disabled={sectionPending || actions.busy}
                onClick={() => void approveSelectedSections()}
              >
                Approve {selectedSections} text {selectedSections === 1 ? 'section' : 'sections'}
              </button>
            )}
            {visibleSelected.length > 0 && (
              <>
                <span className="import-bulk-hint">
                  {visibleSelected.length - readySelected.length > 0
                    ? `${visibleSelected.length - readySelected.length} need review`
                    : 'Ready to save'}
                </span>
                {canCorrectSelection && (
                  <button
                    className="button secondary"
                    type="button"
                    disabled={actions.busy}
                    onClick={() =>
                      setSheet({
                        type: 'correct',
                        recordIds: correctableSelected.map((record) => record.id),
                      })
                    }
                  >
                    Correct selected fields
                  </button>
                )}
                <button
                  className="button secondary"
                  type="button"
                  onClick={() =>
                    move(
                      visibleSelected.map((record) => record.id),
                      view === 'later' ? 'review' : 'later',
                    )
                  }
                >
                  {view === 'later' ? 'Return to review' : 'Later'} {visibleSelected.length}
                </button>
                {model ? (
                  <>
                    {readyClinical.length > 0 && (
                      <button
                        className="button primary"
                        type="button"
                        disabled={actions.busy}
                        onClick={() =>
                          move(
                            readyClinical.map((record) => record.id),
                            'saved',
                          )
                        }
                      >
                        Save {readyClinical.length} records
                      </button>
                    )}
                    {readyPeople.length > 0 && (
                      <button
                        className="button primary"
                        type="button"
                        disabled={actions.busy}
                        onClick={() =>
                          move(
                            readyPeople.map((record) => record.id),
                            'saved',
                          )
                        }
                      >
                        Add {readyPeople.length} {readyPeople.length === 1 ? 'person' : 'people'}
                      </button>
                    )}
                    {readySelected.length === 0 && (
                      <button className="button primary" type="button" disabled>
                        Confirm & save 0 ready
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    className="button primary"
                    type="button"
                    disabled={readySelected.length === 0 || actions.busy}
                    onClick={() =>
                      move(
                        readySelected.map((record) => record.id),
                        'saved',
                      )
                    }
                  >
                    Confirm & save {readySelected.length}
                    {readySelected.length !== visibleSelected.length ? ' ready' : ''}
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {!sourceAttention && (
          <>
            <div className="import-report-list">
              {[...new Set(visible.map((record) => record.reportId))].map((reportId) => {
                const report = reports.find((item) => item.id === reportId)!;
                const reportRecords = visible.filter((record) => record.reportId === reportId);
                const showIdentity =
                  !report.subject.hidden &&
                  reportRecords.some((record) => record.kind !== 'People');
                return (
                  <section
                    className="import-report"
                    key={report.id}
                    aria-label={`${report.source} ${report.reportType}`}
                  >
                    <header className="import-report-header">
                      <div className="import-report-title">
                        <span>
                          New Import Source{report.filename ? `: ${report.filename}` : ''}
                        </span>
                        <strong>{report.reportType}</strong>
                        <time>{report.date}</time>
                      </div>
                      <div className="import-report-context">
                        {report.sourceLabelAvailable || report.sourceSuggested ? (
                          <button
                            className="import-source-control"
                            type="button"
                            disabled={actions.busy}
                            aria-label={
                              report.sourceSuggested
                                ? `Change source: ${report.source}`
                                : report.sourceNeedsLabel
                                  ? 'Add source'
                                  : `Change source for ${report.reportType}`
                            }
                            onClick={() => setSheet({ type: 'source', reportId: report.id })}
                          >
                            <span className="import-source">{report.source}</span>
                            <span className="import-source-action">
                              {report.sourceNeedsLabel ? 'Add source' : 'Change'}
                            </span>
                          </button>
                        ) : (
                          <span className="import-source">{report.source}</span>
                        )}

                        {showIdentity && (
                          <button
                            className="import-source-control import-report-person"
                            type="button"
                            disabled={actions.busy}
                            aria-label={`${report.subject.confirmed && !report.subject.nameOnlyMatch ? 'Change' : 'Review'} person for ${report.reportType}`}
                            onClick={() => setSheet({ type: 'identity', reportId: report.id })}
                          >
                            <UserRound size={14} aria-hidden="true" />
                            <span className="import-source">
                              {report.subject.printedName || report.subject.label}
                              {report.subject.confirmed &&
                              (!report.subject.assignedPerson ||
                                report.subject.assignedPerson.personId === 'patient')
                                ? report.subject.nameOnlyMatch
                                  ? ' (you?)'
                                  : ' (you)'
                                : report.subject.defaultPerson === 'new' &&
                                    !report.subject.confirmed
                                  ? ' (new)'
                                  : report.subject.nameOnlyMatch
                                    ? ' (?)'
                                    : ''}
                            </span>
                            <span className="import-source-action">
                              {report.subject.confirmed && !report.subject.nameOnlyMatch
                                ? 'Change'
                                : 'Review'}
                            </span>
                          </button>
                        )}
                        {showIdentity && (
                          <ImportIdentityWarnings
                            warnings={report.subject.warnings}
                            onReviewPerson={() =>
                              setSheet({ type: 'identity', reportId: report.id })
                            }
                            reviewLabel={
                              report.subject.confirmed && !report.subject.nameOnlyMatch
                                ? 'Change person'
                                : 'Review person'
                            }
                          />
                        )}
                      </div>
                    </header>
                    {renderReportSourceReview &&
                      !reports.some(
                        (previous) =>
                          previous.id !== report.id &&
                          previous.sourceIntakeId === report.sourceIntakeId &&
                          reports.indexOf(previous) < reports.indexOf(report) &&
                          visible.some((row) => row.reportId === previous.id),
                      ) &&
                      renderReportSourceReview(report)}
                    {reportRecords.map((record) => (
                      <article className="import-record" key={record.id}>
                        <div className="import-record-row">
                          {view === 'review' || view === 'later' ? (
                            <input
                              type="checkbox"
                              checked={selected.has(record.id)}
                              onChange={() => toggle(record.id)}
                              aria-label={`Select ${record.label}`}
                            />
                          ) : (
                            <span />
                          )}
                          <div className="import-record-name">
                            <strong>
                              {record.label}
                              {record.manuallyEdited && <span>Edited</span>}
                            </strong>
                            <button
                              className="text-link"
                              type="button"
                              onClick={() => setSheet({ type: 'original', recordId: record.id })}
                            >
                              Original <ArrowUpRight size={12} />
                            </button>
                            {record.date && (
                              <small className="import-record-date">{record.date}</small>
                            )}
                          </div>
                          <div
                            className={`import-record-value${record.value.length > 18 ? ' is-text' : ''}`}
                          >
                            <ImportMeasurementValue
                              value={record.value}
                              unit={record.unit}
                              compactUnit
                            />
                          </div>
                          <div className="import-record-actions">
                            {renderRecordReview && record.kind !== 'People' && (
                              <button
                                className="text-link"
                                type="button"
                                aria-expanded={expandedRecord === record.id}
                                aria-controls={`record-review-${encodeURIComponent(record.id)}`}
                                onClick={() => void openRecordReview(record)}
                              >
                                {expandedRecord === record.id ? 'Close review' : 'Review'}
                              </button>
                            )}
                            {(view === 'review' || view === 'later') && (
                              <>
                                <button
                                  className="text-link"
                                  type="button"
                                  onClick={() =>
                                    move([record.id], view === 'later' ? 'review' : 'later')
                                  }
                                >
                                  {view === 'later' ? 'Return to review' : 'Later'}
                                </button>
                                <button
                                  className="button primary"
                                  type="button"
                                  disabled={!record.eligible || actions.busy}
                                  aria-describedby={
                                    !record.eligible && record.saveBlockReason
                                      ? saveBlockDescriptionId(record.id)
                                      : undefined
                                  }
                                  onClick={() => move([record.id], 'saved')}
                                >
                                  <Check size={15} /> Confirm & save
                                </button>
                              </>
                            )}
                            {view === 'excluded' && (
                              <button
                                className="button secondary"
                                type="button"
                                onClick={() => move([record.id], 'review')}
                              >
                                Restore
                              </button>
                            )}
                            {view === 'saved' && (
                              <span className="import-saved">
                                <Check size={15} /> Saved
                              </span>
                            )}
                            <button
                              className="icon-button"
                              type="button"
                              aria-label={`More actions for ${record.label}`}
                              onClick={() => {
                                if (renderRecordReview && record.kind !== 'People')
                                  void openRecordReview(record);
                                else setSheet({ type: 'edit', recordId: record.id });
                              }}
                            >
                              <Ellipsis size={18} />
                            </button>
                          </div>
                        </div>
                        {!record.eligible &&
                          record.saveBlockReason &&
                          (view === 'review' || view === 'later') && (
                            <div
                              className="import-match import-save-blocker"
                              id={saveBlockDescriptionId(record.id)}
                            >
                              <span>
                                <FileSearch size={15} /> {record.saveBlockReason}
                              </span>
                              {(record.saveBlockReview === 'identity' || record.detailUrl) && (
                                <button
                                  className="text-link"
                                  type="button"
                                  onClick={() =>
                                    record.saveBlockReview === 'identity'
                                      ? setSheet({ type: 'identity', reportId: report.id })
                                      : void openRecordReview(record)
                                  }
                                >
                                  {record.saveBlockReview === 'identity'
                                    ? 'Review person'
                                    : 'Open review'}{' '}
                                  <ArrowRight size={14} />
                                </button>
                              )}
                            </div>
                          )}
                        {record.relatedMatch && view !== 'saved' && (
                          <div className="import-match">
                            <span>
                              <Link2 size={15} /> Possible match:{' '}
                              <strong>{record.relatedMatch.value}</strong> from{' '}
                              {record.relatedMatch.source}
                            </span>
                            <button
                              className="text-link"
                              type="button"
                              onClick={() => setSheet({ type: 'compare', recordId: record.id })}
                            >
                              Compare <ArrowRight size={14} />
                            </button>
                          </div>
                        )}
                        {!record.relatedMatch &&
                          record.possibleOverlap &&
                          record.detailUrl &&
                          (view === 'review' || view === 'later') && (
                            <div className="import-match">
                              <span>
                                <Link2 size={15} /> A saved result has this value and date in the
                                same file. Matching numbers alone do not mean it is the same
                                measurement. Compare the test name, date, and body region before
                                excluding it.
                              </span>
                              <a className="text-link" href={`#${record.detailUrl}`}>
                                Check possible overlap <ArrowRight size={14} />
                              </a>
                            </div>
                          )}
                        {view === 'saved' && record.savedDestination && (
                          <div className="import-record-destination">
                            <SavedRecordDestinationLink record={record.savedDestination} />
                          </div>
                        )}
                        {view === 'saved' && record.savedPersonDestination && (
                          <div className="import-record-destination">
                            <SavedPersonDestinationLink
                              destination={record.savedPersonDestination}
                            />
                          </div>
                        )}
                        {expandedRecord === record.id && renderRecordReview && (
                          <div
                            className="import-record-accordion"
                            id={`record-review-${encodeURIComponent(record.id)}`}
                          >
                            {renderRecordReview(record, () => setExpandedRecord(null))}
                          </div>
                        )}
                      </article>
                    ))}
                  </section>
                );
              })}
              {visible.length === 0 && !(kind === 'All' && sourceCount > 0) && (
                <div className="import-empty">
                  {model?.loading ? 'Loading records…' : 'No records match this view.'}
                </div>
              )}
            </div>
            {(model?.activity?.activeFiles || model?.activity?.paused) && (
              <p className="import-feed-note">
                Showing records found so far. More may appear while Moxie reads.
              </p>
            )}
            {model?.hasMore && (
              <div className="import-load-more">
                <button
                  className="button secondary"
                  type="button"
                  disabled={model.loadingMore}
                  onClick={() => void actions.onLoadMore?.()}
                >
                  {model.loadingMore ? 'Loading…' : 'Load more records'}
                </button>
              </div>
            )}
            {model?.operationStatus && (
              <p className="import-feed-note" role="status">
                {model.operationStatus}
              </p>
            )}
          </>
        )}
        {renderSourceAttention && (
          <div hidden={!(view === 'review' && (sourceAttention || kind === 'All'))}>
            <ImportSourceSelection.Provider value={sourceSelection.register}>
              {renderSourceAttention(setAttentionCount)}
            </ImportSourceSelection.Provider>
          </div>
        )}
      </section>
      <ImportSheet
        key={sheet ? JSON.stringify(sheet) : 'closed'}
        sheet={sheet}
        reports={reports}
        records={records}
        returnFocus={sheetReturnFocus}
        busy={!!actions.busy}
        reviewSource={actions.onReviewSource}
        close={() => setSheet(null)}
        confirmIdentity={(reportId, fields, personSelection, printedName, identityAnswers) => {
          confirmReportIdentity(reportId, fields, personSelection, printedName, identityAnswers);
        }}
        changeSource={async (reportId, source, review) => {
          if (model && actions.onUseSource) {
            return (await actions.onUseSource(reportId, source, review)) || null;
          }
          setReports((current) =>
            current.map((report) =>
              report.id === reportId
                ? { ...report, source, sourceConfirmed: true, sourceSuggested: false }
                : report,
            ),
          );
          setRecords((current) =>
            current.map((record) =>
              record.reportId === reportId && !record.relatedMatch
                ? { ...record, eligible: true }
                : record,
            ),
          );
          setSheet(null);
          setNotice(`Source changed to “${source}”. Nothing has been saved yet.`);
          return null;
        }}
        edit={(recordId, value, unit) => {
          if (model && actions.onEdit) {
            setSheet(null);
            void actions.onEdit(recordId, value, unit);
            return;
          }
          setRecords((current) =>
            current.map((record) =>
              record.id === recordId ? { ...record, value, unit, manuallyEdited: true } : record,
            ),
          );
          setSheet(null);
          setNotice('Manual edit ready. The extracted value and original remain in history.');
        }}
        exclude={(recordId) => {
          if (model && actions.onExclude) {
            setSheet(null);
            void actions.onExclude([recordId]);
            return;
          }
          move([recordId], 'excluded');
          setSheet(null);
        }}
        resolveMatch={(recordId) => {
          if (model && actions.onResolveMatch) {
            setSheet(null);
            void actions.onResolveMatch(recordId);
            return;
          }
          setRecords((current) =>
            current.map((record) =>
              record.id === recordId
                ? { ...record, relatedMatch: undefined, eligible: true }
                : record,
            ),
          );
          setSheet(null);
          setNotice('Relationship choice ready. Both originals remain available.');
        }}
        correctDrafts={actions.onCorrectDrafts}
        askDraftRepair={actions.onAskDraftRepair}
      />
    </div>
  );
}

const repairFieldLabels: Record<IntakeDraftRepairField, string> = {
  date: 'Date',
  method: 'Method',
  observationCategory: 'Test classification',
};

function repairSelection(records: ImportReviewRecord[]): IntakeDraftRepairSelection {
  const first = records[0].draftRepair!;
  return {
    format: 'intake-draft-repair-selection-v1',
    intakeId: first.intakeId,
    groupId: records[0].reportId,
    rows: records.map((record) => ({
      proposalId: record.draftRepair!.proposalId,
      recordId: record.draftRepair!.recordId,
      candidateVersionId: record.draftRepair!.candidateVersionId,
      fields: Object.keys(record.draftRepair!.fields) as IntakeDraftRepairField[],
    })),
  };
}

function DraftCorrectionForm({
  records,
  busy,
  close,
  correct,
  ask,
}: {
  records: ImportReviewRecord[];
  busy: boolean;
  close: () => void;
  correct?: ImportReviewActions['onCorrectDrafts'];
  ask?: ImportReviewActions['onAskDraftRepair'];
}) {
  const commonFields = (['date', 'method', 'observationCategory'] as const).filter((field) =>
    records.every((record) => record.draftRepair?.fields[field] !== undefined),
  );
  const [field, setField] = useState<IntakeDraftRepairField>(commonFields[0] || 'date');
  const [after, setAfter] = useState('');
  const [request, setRequest] = useState('');
  const [previewed, setPreviewed] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const selection = repairSelection(records);
  return (
    <>
      <Dialog.Description>
        Change one supported field across these exact pending drafts, or ask Moxie for a bounded
        source-linked proposal. Nothing is accepted by either action.
      </Dialog.Description>
      <div className="import-sheet-card">
        {records.map((record) => (
          <span key={record.id}>
            <strong>{record.label}</strong>
            {record.originalUrl && (
              <>
                {' '}
                ·{' '}
                <a href={record.originalUrl} target="_blank" rel="noreferrer">
                  Open source <ArrowUpRight size={12} />
                </a>
              </>
            )}
          </span>
        ))}
      </div>
      {commonFields.length ? (
        <>
          <label>
            Field
            <select
              value={field}
              onChange={(event) => {
                setField(event.target.value as IntakeDraftRepairField);
                setPreviewed(false);
              }}
            >
              {commonFields.map((item) => (
                <option key={item} value={item}>
                  {repairFieldLabels[item]}
                </option>
              ))}
            </select>
          </label>
          <div className="import-sheet-card" aria-label="Current selected draft values">
            {records.map((record) => (
              <span key={record.id}>
                {record.label}: {record.draftRepair?.fields[field] || 'Not supplied'}
              </span>
            ))}
          </div>
          <label>
            New {repairFieldLabels[field].toLowerCase()}
            <input
              value={after}
              placeholder={field === 'date' ? 'YYYY-MM-DD' : ''}
              onChange={(event) => {
                setAfter(event.target.value);
                setPreviewed(false);
              }}
            />
          </label>
          {previewed && (
            <div className="import-sheet-card" aria-label="Draft correction preview">
              {records.map((record) => (
                <span key={record.id}>
                  {record.label}: {record.draftRepair?.fields[field] || 'Not supplied'} → {after}
                </span>
              ))}
              <span>The retained source and save state stay unchanged.</span>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="import-sheet-actions">
            <button className="button secondary" type="button" onClick={close}>
              Cancel
            </button>
            {!previewed ? (
              <button
                className="button primary"
                type="button"
                disabled={!after.trim() || busy}
                onClick={() => setPreviewed(true)}
              >
                Preview changes
              </button>
            ) : (
              <button
                className="button primary"
                type="button"
                disabled={submitting || busy}
                onClick={async () => {
                  if (!correct) return;
                  setSubmitting(true);
                  setError('');
                  try {
                    const problem = await correct(selection, field, after);
                    if (problem) setError(problem);
                    else close();
                  } catch (cause) {
                    setError(
                      cause instanceof Error ? cause.message : 'The drafts were not changed.',
                    );
                  } finally {
                    setSubmitting(false);
                  }
                }}
              >
                Apply to {records.length} {records.length === 1 ? 'draft' : 'drafts'}
              </button>
            )}
          </div>
        </>
      ) : (
        <p role="alert">
          These selected drafts do not share an editable date, method, or category.
        </p>
      )}
      {ask && (
        <div className="import-sheet-ai">
          <label>
            Ask Moxie to check these source sections
            <textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              placeholder="Describe the date, method, or category correction you want reviewed"
            />
          </label>
          <button
            className="button secondary"
            type="button"
            disabled={!request.trim() || busy}
            onClick={() => {
              ask(selection, request.trim());
              close();
            }}
          >
            Ask for a source-linked preview
          </button>
          <p className="import-sheet-note">
            Moxie can propose only these selected fields. If it cannot answer, these drafts remain
            editable here. Use full review for a missing row or procedure; this focused repair does
            not create records.
          </p>
        </div>
      )}
    </>
  );
}

function ImportSheet({
  sheet: initialSheet,
  reports,
  records,
  returnFocus,
  busy,
  reviewSource,
  close,
  confirmIdentity,
  changeSource,
  edit,
  exclude,
  resolveMatch,
  correctDrafts,
  askDraftRepair,
}: {
  sheet: SheetState;
  reports: ImportReviewReport[];
  records: ImportReviewRecord[];
  returnFocus: RefObject<HTMLElement | null>;
  busy: boolean;
  reviewSource?: (reportId: string) => Promise<IntakeReportSourceReview>;
  close: () => void;
  confirmIdentity: (
    reportId: string,
    fields: { fullName?: string; birthDate?: string },
    personSelection?: ImportPersonSelection,
    printedName?: string,
    identityAnswers?: IntakeIdentityAnswers,
  ) => void;
  changeSource: (
    reportId: string,
    source: string,
    review?: IntakeReportSourceReview,
  ) => Promise<string | null>;
  edit: (recordId: string, value: string, unit: string) => void;
  exclude: (recordId: string) => void;
  resolveMatch: (recordId: string) => void;
  correctDrafts?: ImportReviewActions['onCorrectDrafts'];
  askDraftRepair?: ImportReviewActions['onAskDraftRepair'];
}) {
  const [metadataTab, setMetadataTab] = useState<'identity' | 'source'>(
    initialSheet?.type === 'source' ? 'source' : 'identity',
  );
  const sheet =
    initialSheet && (initialSheet.type === 'source' || initialSheet.type === 'identity')
      ? { ...initialSheet, type: metadataTab }
      : initialSheet;
  const record =
    sheet && 'recordId' in sheet ? records.find((item) => item.id === sheet.recordId) : undefined;
  const report =
    sheet && 'reportId' in sheet
      ? reports.find((item) => item.id === sheet.reportId)
      : record
        ? reports.find((item) => item.id === record.reportId)
        : undefined;
  const correctionRecords =
    sheet?.type === 'correct'
      ? sheet.recordIds.flatMap((id) => {
          const candidate = records.find((item) => item.id === id);
          return candidate?.draftRepair ? [candidate] : [];
        })
      : [];
  const [personSelection, setPersonSelection] = useState<ImportPersonSelection>(() =>
    report?.subject.assignedPerson && report.subject.assignedPerson.personId !== 'patient'
      ? {
          noteId: report.subject.assignedPerson.noteId,
          expectedVersion: report.subject.assignedPerson.version,
        }
      : report?.subject.defaultPerson === 'new'
        ? { newPerson: { fullName: report.subject.printedName || '' } }
        : undefined,
  );
  const [selectedPrintedName, setSelectedPrintedName] = useState('');
  const [reviewedBirthDate, setReviewedBirthDate] = useState<string | null>(
    report?.subject.birthDateReview?.suggested || null,
  );
  const needsPrintedName = !!report?.subject.printedNameRequired;
  const offeredSelfFields: { fullName?: string; birthDate?: string } = report?.subject
    .offeredSelfFields?.birthDate
    ? { birthDate: report.subject.offeredSelfFields.birthDate }
    : {};
  const offeredFullName = offeredSelfFields.fullName;
  const offeredBirthDate = offeredSelfFields.birthDate;
  const selfFieldSelectionScope = report ? `${report.id}:${sheet?.type || ''}` : null;
  const [selectedSelfFields, setSelectedSelfFields] = useState<Set<'fullName' | 'birthDate'>>(
    () => new Set(Object.keys(offeredSelfFields) as ('fullName' | 'birthDate')[]),
  );
  const previousSelfFieldOffers = useRef<{
    scope: string | null;
    fullName?: string;
    birthDate?: string;
  }>({ scope: null });
  useEffect(() => {
    if (!selfFieldSelectionScope) {
      previousSelfFieldOffers.current = { scope: null };
      return;
    }
    const previous = previousSelfFieldOffers.current;
    setSelectedSelfFields((current) => {
      const next = new Set<'fullName' | 'birthDate'>();
      if (
        offeredFullName &&
        (previous.scope !== selfFieldSelectionScope ||
          previous.fullName !== offeredFullName ||
          current.has('fullName'))
      )
        next.add('fullName');
      if (
        offeredBirthDate &&
        (previous.scope !== selfFieldSelectionScope ||
          previous.birthDate !== offeredBirthDate ||
          current.has('birthDate'))
      )
        next.add('birthDate');
      return next;
    });
    previousSelfFieldOffers.current = {
      scope: selfFieldSelectionScope,
      fullName: offeredFullName,
      birthDate: offeredBirthDate,
    };
  }, [offeredBirthDate, offeredFullName, selfFieldSelectionScope]);
  const [value, setValue] = useState(record?.value || '');
  const [unit, setUnit] = useState(record?.unit || '');
  const [source, setSource] = useState(report?.sourceNeedsLabel ? '' : report?.source || '');
  const [sourceError, setSourceError] = useState('');
  const [sourceReviewError, setSourceReviewError] = useState('');
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceReview, setSourceReview] = useState<IntakeReportSourceReview | null>(null);
  const [sourceReviewLoading, setSourceReviewLoading] = useState(false);
  const sourceReviewGeneration = useRef(0);
  const sourceSheetGeneration = useRef(0);
  const reviewSourceAction = useRef(reviewSource);
  reviewSourceAction.current = reviewSource;
  const loadSourceReview = async (preserveActionError = false) => {
    const action = reviewSourceAction.current;
    if (sheet?.type !== 'source' || !report || !action) return;
    const generation = ++sourceReviewGeneration.current;
    setSourceReview(null);
    if (!preserveActionError) setSourceError('');
    setSourceReviewError('');
    setSourceReviewLoading(true);
    try {
      const review = await action(report.id);
      if (generation === sourceReviewGeneration.current) setSourceReview(review);
    } catch (cause) {
      if (generation === sourceReviewGeneration.current)
        setSourceReviewError(
          cause instanceof Error ? cause.message : 'The affected source records could not load.',
        );
    } finally {
      if (generation === sourceReviewGeneration.current) setSourceReviewLoading(false);
    }
  };
  useEffect(() => {
    void loadSourceReview();
    return () => {
      sourceReviewGeneration.current += 1;
      sourceSheetGeneration.current += 1;
    };
  }, [report?.id, sheet?.type]);
  return (
    <Dialog.Root
      open={Boolean(sheet)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="import-sheet-overlay" />
        <Dialog.Content
          className="import-sheet"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <div className="import-sheet-header">
            <Dialog.Title>
              {sheet?.type === 'original'
                ? 'Original report'
                : sheet?.type === 'identity'
                  ? 'Who is this report for?'
                  : sheet?.type === 'source'
                    ? report?.sourceNeedsLabel
                      ? 'Add source'
                      : 'Change source'
                    : sheet?.type === 'compare'
                      ? 'Review a possible match'
                      : sheet?.type === 'correct'
                        ? 'Correct selected drafts'
                        : sheet?.type === 'edit' && record?.detailUrl
                          ? 'Review record'
                          : 'Manually edit record'}
            </Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Close">
              <X size={18} />
            </Dialog.Close>
          </div>
          {(sheet?.type === 'identity' || sheet?.type === 'source') && report && (
            <nav className="import-context-tabs" aria-label="Report details">
              <button
                type="button"
                aria-pressed={sheet.type === 'source'}
                disabled={
                  busy || sourceBusy || !(report.sourceLabelAvailable || report.sourceSuggested)
                }
                onClick={() => setMetadataTab('source')}
              >
                Source
              </button>
              <button
                type="button"
                aria-pressed={sheet.type === 'identity'}
                disabled={busy || sourceBusy}
                onClick={() => setMetadataTab('identity')}
              >
                Person
              </button>
            </nav>
          )}
          {sheet?.type === 'original' && record && report && (
            <>
              <Dialog.Description>
                The retained original remains the evidence for this result.
              </Dialog.Description>
              {record.originalUrl ? (
                <a
                  className="button secondary import-open-original"
                  href={record.originalUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open retained original <ArrowUpRight size={15} />
                </a>
              ) : (
                <div className="import-original-paper">
                  <span>FICTIONAL ORIGINAL · PAGE 1</span>
                  <h3>{report.source}</h3>
                  <p>
                    {report.reportType} · {report.date}
                    <br />
                    Patient: {report.subject.evidence === 'named' ? 'Rowan Ellis' : 'not printed'}
                  </p>
                  <dl>
                    <dt>{record.originalLabel}</dt>
                    <dd>
                      <ImportMeasurementValue value={record.value} unit={record.unit} />
                    </dd>
                  </dl>
                </div>
              )}
              <p className="import-sheet-note">Manual changes never alter this original.</p>
            </>
          )}
          {sheet?.type === 'correct' && correctionRecords.length > 0 && (
            <DraftCorrectionForm
              records={correctionRecords}
              busy={busy}
              close={close}
              correct={correctDrafts}
              ask={askDraftRepair}
            />
          )}
          {sheet?.type === 'identity' && report && (
            <>
              <Dialog.Description>
                {report.subject.identityStatus === 'conflict' && report.subject.scopeReady === false
                  ? 'Processing could not establish a consistent report identity. Editing a result cannot resolve this issue, and these records cannot be approved yet.'
                  : report.subject.confirmed
                    ? 'Review who this report belongs to. Accepted records keep their existing attribution.'
                    : 'Choose yourself or another person for the records in this report. Clinical results remain in review.'}
              </Dialog.Description>
              <div className="import-sheet-card import-context-card">
                <strong>
                  {report.subject.identityStatus === 'missing_warning'
                    ? 'Identity is not printed clearly in this report.'
                    : report.subject.identityStatus === 'conflict'
                      ? report.subject.scopeReady === false
                        ? 'Report identity could not be established.'
                        : 'Choose who this report belongs to.'
                      : 'Report subject'}
                </strong>
                <span>
                  {report.subject.evidenceText
                    ? `The report identifies “${report.subject.evidenceText}”.`
                    : 'Check the retained report before confirming identity.'}
                </span>
                {report.subject.identityMessage &&
                  !report.subject.questions?.some(
                    (question) => question.prompt === report.subject.identityMessage,
                  ) && <span>{report.subject.identityMessage}</span>}
                <ImportIdentityWarnings warnings={report.subject.warnings} />
                {report.subject.scopeError && <span role="alert">{report.subject.scopeError}</span>}
                {report.subject.conflicts?.map((conflict) => (
                  <span key={`${conflict.field}:${conflict.evidencedValue}`}>
                    {conflict.field === 'fullName' ? 'Full name' : 'Date of birth'}: Self has{' '}
                    {conflict.selfValue || 'no value'}; report evidence has{' '}
                    {conflict.evidencedValue || 'different retained claims'}.
                  </span>
                ))}
                {report.subject.scopeReady === false &&
                  !report.subject.scopeError &&
                  !report.subject.identityStatus && (
                    <span>Checking retained identity evidence…</span>
                  )}
                {!report.subject.confirmed && report.subject.targetCount !== undefined && (
                  <span>
                    This applies to {report.subject.targetCount}{' '}
                    {report.subject.targetCount === 1 ? 'record' : 'records'} in this report.
                  </span>
                )}
                {report.subject.questions?.map((question) => (
                  <span key={`${question.prompt}:${question.textAnchor || ''}`}>
                    <span>{question.prompt}</span>
                    {question.textAnchor && <q>{question.textAnchor}</q>}
                  </span>
                ))}
              </div>
              {needsPrintedName && (
                <ImportPrintedName
                  value={selectedPrintedName}
                  subjectText={report.subject.evidenceText || ''}
                  onChange={setSelectedPrintedName}
                  disabled={busy}
                />
              )}
              {report.subject.birthDateReview && (
                <ImportBirthDateReview
                  review={report.subject.birthDateReview}
                  value={reviewedBirthDate}
                  onChange={setReviewedBirthDate}
                  disabled={busy}
                />
              )}
              <ImportPersonChoice
                selfNames={report.subject.selfNames}
                selfDisabled={report.subject.selfBirthDateConflict}
                birthDate={reviewedBirthDate || report.subject.birthDate}
                people={report.subject.people}
                peopleTruncated={report.subject.peopleTruncated}
                assignedPerson={report.subject.assignedPerson}
                printedName={report.subject.printedName || selectedPrintedName}
                selection={personSelection}
                onChange={setPersonSelection}
                disabled={busy || report.subject.scopeReady === false}
              />
              {report.subject.reviewUrl && (
                <a className="text-link" href={`#${report.subject.reviewUrl}`}>
                  Review retained report evidence <ArrowRight size={15} aria-hidden="true" />
                </a>
              )}
              {!personSelection && !!Object.keys(offeredSelfFields).length && (
                <fieldset className="import-fill-name">
                  <legend>Fill selected blank Self details in this same action</legend>
                  <p className="import-sheet-note">
                    These exact values came from retained report evidence. Existing Self fields are
                    never overwritten.
                  </p>
                  {(['fullName', 'birthDate'] as const).flatMap((field) => {
                    const value = offeredSelfFields[field];
                    if (!value) return [];
                    return [
                      <label className="import-check-label" key={field}>
                        <input
                          type="checkbox"
                          checked={selectedSelfFields.has(field)}
                          onChange={(event) =>
                            setSelectedSelfFields((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(field);
                              else next.delete(field);
                              return next;
                            })
                          }
                        />
                        {field === 'fullName' ? 'Full name' : 'Date of birth'}:{' '}
                        <strong>{value}</strong>
                      </label>,
                    ];
                  })}
                  <small>
                    Self display name stays “
                    {report.subject.selfDisplayName || report.subject.label}”.
                  </small>
                </fieldset>
              )}
              <div className="import-sheet-actions">
                <button className="button secondary" type="button" onClick={close}>
                  Cancel
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={
                    busy ||
                    report.subject.scopeReady === false ||
                    reviewedBirthDate === '' ||
                    report.subject.identityStatus === 'missing_warning' ||
                    (!personSelection && !!report.subject.selfBirthDateConflict) ||
                    !personSelectionReady(personSelection, report.subject.selfNames) ||
                    (needsPrintedName &&
                      !printedNameReady(selectedPrintedName, report.subject.evidenceText || ''))
                  }
                  onClick={() => {
                    if (
                      report.subject.confirmed &&
                      !report.subject.nameOnlyMatch &&
                      !needsPrintedName &&
                      (!personSelection
                        ? !report.subject.assignedPerson ||
                          report.subject.assignedPerson.personId === 'patient'
                        : 'noteId' in personSelection &&
                          personSelection.noteId === report.subject.assignedPerson?.noteId) &&
                      (!offeredBirthDate || !selectedSelfFields.has('birthDate'))
                    ) {
                      close();
                      return;
                    }
                    confirmIdentity(
                      report.id,
                      personSelection
                        ? {}
                        : Object.fromEntries(
                            [...selectedSelfFields].flatMap((field) => {
                              const value = offeredSelfFields[field];
                              return value ? [[field, value]] : [];
                            }),
                          ),
                      personSelection,
                      needsPrintedName ? selectedPrintedName.trim() : undefined,
                      report.subject.birthDateReview ? { birthDate: reviewedBirthDate } : undefined,
                    );
                  }}
                >
                  {report.subject.confirmed &&
                  !report.subject.nameOnlyMatch &&
                  !needsPrintedName &&
                  (!personSelection
                    ? !report.subject.assignedPerson ||
                      report.subject.assignedPerson.personId === 'patient'
                    : 'noteId' in personSelection &&
                      personSelection.noteId === report.subject.assignedPerson?.noteId) &&
                  (!offeredBirthDate || !selectedSelfFields.has('birthDate'))
                    ? 'Done'
                    : personSelection
                      ? 'Confirm person'
                      : report.subject.confirmed
                        ? 'Save changes'
                        : 'This is me'}
                </button>
              </div>
            </>
          )}
          {sheet?.type === 'source' && report && (
            <>
              <Dialog.Description>
                Use this label for the report and eligible results you save. Original issuer and
                upload history stay unchanged.
              </Dialog.Description>
              {report.sourceEvidence?.contentUrl && (
                <a
                  className="button secondary import-open-original"
                  href={report.sourceEvidence.contentUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Review {report.sourceEvidence.label} <ArrowUpRight size={12} />
                </a>
              )}
              <label>
                Source
                <input
                  value={source}
                  placeholder="Clinic, lab, or archive name"
                  onChange={(event) => setSource(event.target.value)}
                />
              </label>
              <p className="import-sheet-note">
                This source is used when you save records. Change it here if needed.
              </p>
              {report.sourceCoverage && (
                <p className="import-sheet-note">
                  Current {report.sourceCoverage.current.covered}/
                  {report.sourceCoverage.current.total} source-labeled · Saved{' '}
                  {report.sourceCoverage.saved.covered}/{report.sourceCoverage.saved.total}
                </p>
              )}
              {sourceReviewLoading && (
                <p className="import-sheet-note">Loading affected records…</p>
              )}
              {sourceReview && (
                <div className="import-sheet-card import-context-card">
                  <strong>
                    {sourceReview.targets.length}{' '}
                    {sourceReview.targets.length === 1 ? 'record' : 'records'} will use “
                    {source.trim() || 'this source'}”
                  </strong>
                  <span>
                    {sourceReview.coverage.covered} already have a reviewed source;{' '}
                    {sourceReview.coverage.uncovered} do not.
                  </span>
                  {!!sourceReview.sourceEvidence.length && (
                    <span>Retained source evidence: {sourceReview.sourceEvidence.join(', ')}.</span>
                  )}
                  {sourceReview.warning && <span role="alert">{sourceReview.warning}</span>}
                  {source.trim() &&
                    sourceReview.sourceEvidence.some((value) => value !== source.trim()) && (
                      <span role="alert">
                        “{source.trim()}” differs from retained source evidence. Check the original
                        before confirming this one label.
                      </span>
                    )}
                  <ul>
                    {sourceReview.targets.map((target) => (
                      <li key={target.id}>
                        {target.title}
                        {target.date ? ` · ${target.date}` : ''} · {target.occurrence.locator}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {sourceError && <p role="alert">{sourceError}</p>}
              {sourceReviewError && <p role="alert">{sourceReviewError}</p>}
              <div className="import-sheet-actions">
                <button className="button secondary" type="button" onClick={close}>
                  Cancel
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={
                    sourceBusy ||
                    sourceReviewLoading ||
                    (!sourceReview && !!reviewSource
                      ? !(sourceError || sourceReviewError)
                      : !source.trim())
                  }
                  onClick={() => {
                    if (!sourceReview && reviewSource && (sourceError || sourceReviewError)) {
                      void loadSourceReview(true);
                      return;
                    }
                    const submittedGeneration = sourceSheetGeneration.current;
                    setSourceBusy(true);
                    setSourceError('');
                    setSourceReviewError('');
                    void changeSource(report.id, source.trim(), sourceReview || undefined)
                      .then(async (message) => {
                        if (submittedGeneration !== sourceSheetGeneration.current) return;
                        if (!message) {
                          close();
                          return;
                        }
                        setSourceError(message);
                        await loadSourceReview(true);
                      })
                      .catch(async (cause) => {
                        if (submittedGeneration !== sourceSheetGeneration.current) return;
                        setSourceError(
                          cause instanceof Error
                            ? cause.message
                            : 'The source label could not be applied.',
                        );
                        await loadSourceReview(true);
                      })
                      .finally(() => {
                        if (submittedGeneration === sourceSheetGeneration.current)
                          setSourceBusy(false);
                      });
                  }}
                >
                  {sourceBusy
                    ? 'Using source…'
                    : !sourceReview && reviewSource && (sourceError || sourceReviewError)
                      ? 'Retry affected records'
                      : sourceReview
                        ? `Use ${source.trim()} for ${sourceReview.targets.length} ${
                            sourceReview.targets.length === 1 ? 'record' : 'records'
                          }`
                        : 'Use source'}
                </button>
              </div>
            </>
          )}
          {sheet?.type === 'edit' && record && (
            <>
              <Dialog.Description>
                The extracted value and original stay in history.
              </Dialog.Description>
              {record.detailUrl ? (
                <>
                  <div className="import-sheet-card">
                    <strong>{record.label}</strong>
                    <span>
                      <ImportMeasurementValue value={record.value} unit={record.unit} />
                    </span>
                  </div>
                  <p className="import-sheet-note">
                    Open the full retained draft to edit clinical fields, answer questions, or
                    review related records with their evidence.
                  </p>
                  <div className="import-sheet-actions">
                    <button
                      className="text-link import-danger"
                      type="button"
                      onClick={() => exclude(record.id)}
                    >
                      Exclude from results
                    </button>
                    <a className="button primary" href={`#${record.detailUrl}`}>
                      Open full review <ArrowRight size={15} />
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <label>
                    Value
                    <input value={value} onChange={(event) => setValue(event.target.value)} />
                  </label>
                  <label>
                    Unit
                    <input value={unit} onChange={(event) => setUnit(event.target.value)} />
                  </label>
                  <label>
                    Reason <span>Optional</span>
                    <input placeholder="Corrected a transcribed digit" />
                  </label>
                  <div className="import-sheet-actions">
                    <button className="button secondary" type="button" onClick={close}>
                      Cancel
                    </button>
                    <button
                      className="button primary"
                      type="button"
                      onClick={() => edit(record.id, value, unit)}
                    >
                      Use changes
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          {sheet?.type === 'compare' && record?.relatedMatch && (
            <>
              <Dialog.Description>
                These values share a date. Check both sources before choosing their relationship.
              </Dialog.Description>
              <div className="import-compare">
                <div>
                  <span>NEW · {report?.source}</span>
                  <strong>
                    <ImportMeasurementValue value={record.value} unit={record.unit} />
                  </strong>
                  <small>{report?.date}</small>
                </div>
                <div>
                  <span>ALREADY SAVED · {record.relatedMatch.source}</span>
                  <strong>{record.relatedMatch.value}</strong>
                  <small>{record.relatedMatch.date}</small>
                </div>
              </div>
              {record.detailUrl ? (
                <div className="import-sheet-actions">
                  <a className="button primary" href={`#${record.detailUrl}`}>
                    Review relationship and evidence <ArrowRight size={15} />
                  </a>
                </div>
              ) : (
                <>
                  <button
                    className="import-choice"
                    type="button"
                    onClick={() => resolveMatch(record.id)}
                  >
                    <strong>Keep as separate measurements</strong>
                    <small>Keep both values and original evidence.</small>
                  </button>
                  <button
                    className="import-choice"
                    type="button"
                    onClick={() => resolveMatch(record.id)}
                  >
                    <strong>They describe the same measurement</strong>
                    <small>Choose a display preference; retain both sources.</small>
                  </button>
                </>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
