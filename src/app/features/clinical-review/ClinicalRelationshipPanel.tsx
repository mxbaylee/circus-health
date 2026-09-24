import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Search } from 'lucide-react';
import type { LinkTarget } from '../../../shared/api';
import type {
  ClinicalRelationshipApplyInput,
  ClinicalRelationshipApplyResult,
  ClinicalRelationshipPreview,
  ClinicalRelationshipProjection,
  ClinicalRelationshipRequest,
  ClinicalRelationshipSide,
  ClinicalRelationshipView,
} from '../../../shared/clinical-relationships';
import type { ClinicalReviewKind } from '../../../shared/clinical-review';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import { api, useResource } from '../../data/api';
import { NoteDialog } from '../notes/NoteDialog';
import { ClinicalRelationshipDialog } from './ClinicalRelationshipDialog';
import './clinical-relationship-dialog.css';

type RelationshipPair = { left: ClinicalRelationshipSide; right: ClinicalRelationshipSide };
type SelectedPair = RelationshipPair & { initialAction: ClinicalRelationshipRequest['action'] };

const statusText: Record<ClinicalRelationshipView['status'], string> = {
  current: 'Current reviewed decision',
  stale: 'Needs review because a record or original changed',
  conflict: 'Needs review because another relationship conflicts',
  undecided: 'Marked as needing review',
  withdrawn: 'Withdrawn',
};

const kindLabel: Record<ClinicalReviewKind, string> = {
  observation: 'measurement',
  medication: 'medication',
  procedure: 'procedure',
  document: 'provider document',
};

function relationshipText(view: ClinicalRelationshipView) {
  const { request, reviewed } = view;
  if (request.action === 'provider_amendment') {
    if (request.mode === 'withdraw') return 'Provider amendment decision withdrawn';
    const from = request.direction === 'left_to_right' ? reviewed.left.title : reviewed.right.title;
    const to = request.direction === 'left_to_right' ? reviewed.right.title : reviewed.left.title;
    return `${to} reviewed as the provider’s amendment to ${from}`;
  }
  if (request.mode === 'prefer_left')
    return `One reviewed event; show ${reviewed.left.title} by default`;
  if (request.mode === 'prefer_right')
    return `One reviewed event; show ${reviewed.right.title} by default`;
  if (request.mode === 'show_both') return 'One reviewed event; show both records';
  if (request.mode === 'undecided') return 'Display relationship needs review';
  return 'Display choice withdrawn';
}

function currentLink(navigation: ClinicalRelationshipView['leftNavigation'], fallback: string) {
  return navigation ? (
    <Link to={navigation.appUrl}>{fallback}</Link>
  ) : (
    <span>{fallback} is no longer available</span>
  );
}

function ClinicalRecordPicker({
  open,
  onOpenChange,
  kind,
  recordId,
  busy,
  error,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: ClinicalReviewKind;
  recordId: string;
  busy: boolean;
  error: string;
  onChoose: (target: LinkTarget) => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search), 180);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!open) {
      setSearch('');
      setQuery('');
    }
  }, [open]);
  const targets = useResource<LinkTarget[]>(
    open
      ? `/link-targets?q=${encodeURIComponent(query)}&limit=50&type=${encodeURIComponent(kind)}`
      : null,
  );
  const available = (targets.data || []).filter(
    (target) => target.targetType === kind && target.targetId !== recordId,
  );

  return (
    <NoteDialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={`Choose another ${kindLabel[kind]}`}
      description="Choose one accepted record. The current versions and retained originals will load before review."
      className="clinical-relationship-picker"
    >
      <label className="clinical-relationship-search">
        <Search size={17} aria-hidden="true" />
        <input
          autoFocus
          aria-label={`Search accepted ${kindLabel[kind]} records`}
          placeholder={`Search ${kindLabel[kind]}s…`}
          value={search}
          disabled={busy}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {targets.loading && <LoadingIndicator label="Searching accepted records…" layout="panel" />}
      {targets.error && (
        <p role="alert">
          {targets.error.message}{' '}
          <button type="button" className="text-link" onClick={targets.reload}>
            Try again
          </button>
        </p>
      )}
      {!targets.loading && !targets.error && !available.length && (
        <p>No other matching accepted records.</p>
      )}
      <div className="clinical-relationship-picker-results">
        {available.map((target) => (
          <button
            type="button"
            className="clinical-relationship-picker-row"
            key={`${target.targetType}:${target.targetId}`}
            disabled={busy}
            onClick={() => onChoose(target)}
          >
            <Link2 size={18} aria-hidden="true" />
            <span>
              <strong>{target.title}</strong>
              <small>
                {target.subtitle || `Accepted ${kindLabel[kind]}`}
                {target.archived ? ' · Inactive' : ''}
              </small>
            </span>
          </button>
        ))}
      </div>
    </NoteDialog>
  );
}

export function ClinicalRelationshipPanel({
  kind,
  recordId,
  onApplied,
}: {
  kind: ClinicalReviewKind;
  recordId: string;
  onApplied: (result: ClinicalRelationshipApplyResult) => void | Promise<void>;
}) {
  const resource = useResource<ClinicalRelationshipProjection>(
    `/clinical-relationships?kind=${encodeURIComponent(kind)}&recordId=${encodeURIComponent(recordId)}`,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedPair, setSelectedPair] = useState<SelectedPair | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState('');

  useEffect(() => {
    setPickerOpen(false);
    setSelectedPair(null);
    setPairBusy(false);
    setPairError('');
  }, [kind, recordId]);

  const previewRelationship = (request: ClinicalRelationshipRequest) =>
    api<ClinicalRelationshipPreview>('/clinical-relationships/preview', {
      method: 'POST',
      body: JSON.stringify(request),
    }).then(({ data }) => data);
  const applyRelationship = (request: ClinicalRelationshipApplyInput) =>
    api<ClinicalRelationshipApplyResult>('/clinical-relationships/apply', {
      method: 'POST',
      body: JSON.stringify(request),
    }).then(({ data }) => data);
  const loadPair = async (
    left: { kind: ClinicalReviewKind; recordId: string },
    right: { kind: ClinicalReviewKind; recordId: string },
    initialAction: ClinicalRelationshipRequest['action'] = 'display_preference',
  ) => {
    if (pairBusy) return;
    setPairBusy(true);
    setPairError('');
    try {
      const query = new URLSearchParams({
        leftKind: left.kind,
        leftRecordId: left.recordId,
        rightKind: right.kind,
        rightRecordId: right.recordId,
      });
      const { data } = await api<RelationshipPair>(`/clinical-relationships/pair?${query}`);
      setSelectedPair({ ...data, initialAction });
      setPickerOpen(false);
    } catch (cause) {
      setPairError(
        cause instanceof Error ? cause.message : 'The current record pair could not load.',
      );
    } finally {
      setPairBusy(false);
    }
  };
  const projection =
    resource.data &&
    resource.data.display &&
    typeof resource.data.display.requiresReview === 'boolean' &&
    Array.isArray(resource.data.relationships) &&
    Array.isArray(resource.data.legacyPairs)
      ? resource.data
      : null;
  const invalidProjection = resource.data !== null && !projection;

  return (
    <section className="clinical-relationship-panel" aria-label="Record relationships">
      <div className="section-heading">
        <h3>Record relationships</h3>
        <button type="button" className="text-link" onClick={() => setPickerOpen(true)}>
          Review another accepted record
        </button>
      </div>
      {pairError && !pickerOpen && <p role="alert">{pairError}</p>}
      {resource.loading ? (
        <LoadingIndicator label="Loading reviewed relationships…" layout="panel" />
      ) : resource.error || invalidProjection ? (
        <p role="alert">
          Reviewed relationships could not load.{' '}
          <button type="button" className="text-link" onClick={resource.reload}>
            Retry
          </button>
        </p>
      ) : projection ? (
        <>
          {projection.display.requiresReview && (
            <p className="clinical-relationship-warning">
              A record relationship needs review. Both records remain visible and count separately.
            </p>
          )}
          {!projection.relationships.length && !projection.legacyPairs.length ? (
            <p className="helper-text">No reviewed relationship decisions for this record.</p>
          ) : (
            <div className="clinical-relationship-decisions">
              {projection.relationships.map((view) => (
                <article key={view.decisionId}>
                  <div>
                    <strong>{relationshipText(view)}</strong>
                    <span className="soft-badge">{statusText[view.status]}</span>
                  </div>
                  <p>{view.request.reason}</p>
                  <p className="helper-text">
                    Reviewed snapshot from {new Date(view.at).toLocaleString()}.
                  </p>
                  <p className="clinical-relationship-links">
                    {currentLink(view.leftNavigation, view.reviewed.left.title)}
                    {currentLink(view.rightNavigation, view.reviewed.right.title)}
                  </p>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={pairBusy}
                    onClick={() =>
                      void loadPair(view.request.left, view.request.right, view.request.action)
                    }
                  >
                    {pairBusy
                      ? 'Loading current records…'
                      : view.request.action === 'provider_amendment'
                        ? 'Review amendment decision'
                        : 'Review display decision'}
                  </button>
                </article>
              ))}
              {projection.legacyPairs.map((legacy) => (
                <article key={legacy.decisionId}>
                  <div>
                    <strong>
                      Earlier relationship choice: {legacy.outcome.replaceAll('_', ' ')}
                    </strong>
                    <span className="soft-badge">
                      {legacy.status === 'unresolved' ? 'Needs review' : 'Historical context'}
                    </span>
                  </div>
                  <p>{legacy.reason}</p>
                  <p className="helper-text">
                    This earlier choice is not a provider amendment or current display decision.
                  </p>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={pairBusy}
                    onClick={() =>
                      void loadPair(
                        projection.record,
                        { kind: projection.record.kind, recordId: legacy.otherRecordId },
                        'display_preference',
                      )
                    }
                  >
                    {pairBusy ? 'Loading current records…' : 'Review this pair'}
                  </button>
                </article>
              ))}
            </div>
          )}
          {projection.truncated && (
            <p className="clinical-relationship-warning">
              Relationship history is incomplete here. Both records remain visible until the full
              relationship can be reviewed.
            </p>
          )}
        </>
      ) : null}

      <ClinicalRecordPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        kind={kind}
        recordId={recordId}
        busy={pairBusy}
        error={pairError}
        onChoose={(target) =>
          void loadPair(
            { kind, recordId },
            { kind, recordId: target.targetId },
            'display_preference',
          )
        }
      />
      {selectedPair && (
        <ClinicalRelationshipDialog
          open
          onOpenChange={(open) => !open && setSelectedPair(null)}
          onBack={() => {
            setSelectedPair(null);
            setPickerOpen(true);
          }}
          left={selectedPair.left}
          right={selectedPair.right}
          previewRelationship={previewRelationship}
          applyRelationship={applyRelationship}
          initialAction={selectedPair.initialAction}
          onApplied={async (result) => {
            resource.reload();
            await onApplied(result);
          }}
        />
      )}
    </section>
  );
}
