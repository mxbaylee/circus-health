import { useEffect, useId, useRef, useState } from 'react';
import type {
  IntakeSourceText,
  SourceTextRelation,
  SourceTextReviewAction,
  SourceTextReviewRequest,
  SourceTextRevision,
  SourceTextSpan,
} from '../../../shared/intake-source-text';
import { api, ApiError, apiUrl, useResource } from '../../data/api';
import { useProfile } from '../../data/profile';
import { registerProfileTransitionEditor } from '../../data/profile-transition';
import { ReviewNavigationGuard } from './ReviewWorkspace';
import './source-text-review.css';

interface SourceReviewProps {
  intakeId: string;
  onChanged?: () => void;
  onPendingChange?: (pending: boolean) => void;
  guardNavigation?: boolean;
  /** Render directly under the selected issue rather than another disclosure button. */
  embedded?: boolean;
  initialPage?: number;
  initialIssueId?: string;
  onPageChange?: (page: number) => void;
  pageNavigationBlocked?: boolean;
}

/** Collapsed until requested; original review is independent of clinical proposal acceptance. */
export function SourceTextReview({
  intakeId,
  onChanged,
  onPendingChange,
  guardNavigation = true,
  embedded = false,
  initialPage,
  initialIssueId,
  onPageChange,
  pageNavigationBlocked,
}: SourceReviewProps) {
  const profile = useProfile();
  const [open, setOpen] = useState(false);
  return (
    <section className="source-text-review">
      {!embedded && (
        <button
          type="button"
          className="button secondary"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          Review source text
        </button>
      )}
      {(open || embedded) && (
        <SourceTextLoader
          key={`${profile?.id}:${intakeId}`}
          intakeId={intakeId}
          onChanged={onChanged}
          onPendingChange={onPendingChange}
          guardNavigation={guardNavigation}
          initialPage={initialPage}
          initialIssueId={initialIssueId}
          onPageChange={onPageChange}
          pageNavigationBlocked={pageNavigationBlocked}
        />
      )}
    </section>
  );
}
function SourceTextLoader({
  intakeId,
  onChanged,
  onPendingChange,
  guardNavigation,
  initialPage,
  initialIssueId,
  onPageChange,
  pageNavigationBlocked,
}: SourceReviewProps) {
  const path = `/intakes/${encodeURIComponent(intakeId)}/source-text`;
  const resource = useResource<IntakeSourceText>(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewCurrentPage, setReviewCurrentPage] = useState(false);
  const [extractionNotice, setExtractionNotice] = useState('');
  const operation = useRef(crypto.randomUUID());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function extract() {
    if (busy) return;
    onPendingChange?.(true);
    setBusy(true);
    setError('');
    try {
      const result = await api<IntakeSourceText>(
        `/intakes/${encodeURIComponent(intakeId)}/source-extract`,
        {
          method: 'POST',
          body: JSON.stringify({ operationId: operation.current, expectedRevisionId: null }),
        },
      );
      if (alive.current) {
        if (result.data.extractionOperation?.status === 'interrupted') {
          setExtractionNotice(
            'That extraction step was interrupted. Saved pages are kept; continuing starts a new bounded step.',
          );
          if (result.data.extractionOperation.requiresNewOperation)
            operation.current = crypto.randomUUID();
        }
        resource.reload();
      }
    } catch (cause) {
      if (alive.current && cause instanceof ApiError && cause.status === 409) resource.reload();
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Extraction could not finish. The original is retained.',
        );
    } finally {
      if (alive.current) {
        setBusy(false);
        onPendingChange?.(false);
      }
    }
  }
  return (
    <div>
      <h3>Source text review</h3>
      <p>
        Review the original and its transcription. This does not accept clinical records. An empty
        question list does not establish complete or accurate text.
      </p>
      {extractionNotice && <p role="status">{extractionNotice}</p>}
      {resource.loading && <p role="status">Loading retained source text…</p>}
      {resource.error && (
        <div role="alert">
          {resource.error.message}{' '}
          <button type="button" className="text-link" onClick={resource.reload}>
            Retry source text
          </button>
        </div>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button className="text-link" disabled={busy} onClick={resource.reload}>
            Check saved extraction
          </button>
        </div>
      )}
      {resource.data?.status === 'unavailable' && (
        <div>
          <p>
            Text has not been extracted yet. Your original is saved. Extract it locally to compare
            the wording and correct any missing or uncertain text.
          </p>
          <button className="button secondary" disabled={busy} onClick={() => void extract()}>
            {busy ? 'Extracting source text…' : 'Extract source text locally'}
          </button>
        </div>
      )}
      {resource.data?.status === 'available' &&
      initialIssueId &&
      !reviewCurrentPage &&
      !resource.data.revision.issues.some(
        (issue) => issue.id === initialIssueId && issue.region.page === initialPage,
      ) ? (
        <div role="alert">
          <p>
            The selected issue changed in the saved source revision. Review the current page before
            choosing a new disposition.
          </p>
          <button
            type="button"
            className="button secondary"
            onClick={() => setReviewCurrentPage(true)}
          >
            Review current page instead
          </button>
        </div>
      ) : (
        resource.data?.status === 'available' && (
          <SourceTextEditor
            initial={resource.data}
            path={path}
            onChanged={onChanged}
            onPendingChange={onPendingChange}
            guardNavigation={guardNavigation}
            initialPage={initialPage}
            initialIssueId={reviewCurrentPage ? undefined : initialIssueId}
            onPageChange={onPageChange}
            pageNavigationBlocked={pageNavigationBlocked}
          />
        )
      )}
    </div>
  );
}
const pageSpans = (revision: SourceTextRevision, page: number) =>
  revision.spans.filter((span) => span.region.page === page);
const readable = (value: string) => value.replaceAll('-', ' ');

function SourceTextEditor({
  initial,
  path,
  onChanged,
  onPendingChange,
  guardNavigation,
  initialPage,
  initialIssueId,
  onPageChange,
  pageNavigationBlocked,
}: {
  initialPage?: number;
  initialIssueId?: string;
  onPageChange?: (page: number) => void;
  pageNavigationBlocked?: boolean;
  onPendingChange?: (pending: boolean) => void;
  guardNavigation?: boolean;
  initial: Extract<IntakeSourceText, { status: 'available' }>;
  path: string;
  onChanged?: () => void;
}) {
  const profile = useProfile();
  const [current, setCurrent] = useState(initial);
  const [page, setPage] = useState(
    initial.revision.pages.some((item) => item.page === initialPage)
      ? initialPage!
      : initial.revision.pages[0]?.page || 1,
  );
  const [spans, setSpans] = useState(() => pageSpans(initial.revision, page));
  const [relations, setRelations] = useState(initial.revision.relations);
  const [reason, setReason] = useState('');
  const [clarification, setClarification] = useState('');
  const [issueId, setIssueId] = useState(
    initial.revision.issues.find(
      (issue) => issue.id === initialIssueId && issue.region.page === page,
    )?.id || '',
  );
  const [resolveIssueIds, setResolveIssueIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<SourceTextReviewRequest | null>(null);
  const [pendingExtraction, setPendingExtraction] = useState<{
    operationId: string;
    expectedRevisionId: string;
  } | null>(null);
  const [latest, setLatest] = useState<Extract<IntakeSourceText, { status: 'available' }> | null>(
    null,
  );
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const previewContainer = useRef<HTMLDivElement>(null);
  const [previewWidth, setPreviewWidth] = useState(0);
  const [dimensions, setDimensions] = useState({ width: 600, height: 800 });
  const id = useId();
  const alive = useRef(true);
  const paused = useRef(false);
  const { revision, summary } = current;
  useEffect(() => {
    onPageChange?.(page);
  }, [page, onPageChange]);
  const selectedIssue = revision.issues.find(
    (issue) => issue.id === issueId && issue.region.page === page,
  );
  const changed =
    JSON.stringify(spans) !== JSON.stringify(pageSpans(revision, page)) ||
    JSON.stringify(relations) !== JSON.stringify(revision.relations);
  const dirty =
    changed ||
    !!reason ||
    !!clarification ||
    !!pending ||
    !!pendingExtraction ||
    !!resolveIssueIds.length;
  const preview = useResource<{ dataUrl?: string; width?: number; height?: number; text?: string }>(
    `/intakes/${encodeURIComponent(revision.intakeId)}/source-preview?page=${page}&revisionId=${encodeURIComponent(revision.id)}`,
  );
  useEffect(() => {
    const container = previewContainer.current;
    if (!container) return;
    const update = () => setPreviewWidth(container.clientWidth);
    update();
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((item) => item.target === container);
      setPreviewWidth(entry?.contentRect.width ?? container.clientWidth);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [preview.data?.dataUrl]);
  const disabled = busy || !!pending || !!pendingExtraction || conflict;
  const pendingListener = useRef(onPendingChange);
  pendingListener.current = onPendingChange;
  useEffect(() => {
    pendingListener.current?.(dirty || busy);
  }, [dirty, busy]);
  useEffect(
    () => () => {
      pendingListener.current?.(false);
    },
    [],
  );
  const stateRef = useRef({ dirty, busy, conflict });
  stateRef.current = { dirty, busy, conflict };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (stateRef.current.dirty || stateRef.current.busy) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  useEffect(
    () =>
      registerProfileTransitionEditor({
        profileId: profile?.id,
        pending: () => stateRef.current.dirty || stateRef.current.busy,
        checkReady: (choice) => {
          if (stateRef.current.busy || (choice === 'save' && stateRef.current.dirty))
            throw new Error('Save or resolve the source text review before leaving this profile.');
        },
        save: async () => {
          throw new Error('Choose a source review action before leaving.');
        },
        pause: () => {
          paused.current = true;
          return () => {
            paused.current = false;
          };
        },
      }),
    [profile?.id],
  );
  function adopt(next: Extract<IntakeSourceText, { status: 'available' }>) {
    setCurrent(next);
    setSpans(pageSpans(next.revision, page));
    setRelations(next.revision.relations);
    setReason('');
    setClarification('');
    setIssueId('');
    setResolveIssueIds([]);
    setPending(null);
    setPendingExtraction(null);
    setConflict(false);
    setLatest(null);
  }
  async function save(action: SourceTextReviewAction, retry?: SourceTextReviewRequest) {
    if (busy || paused.current) return;
    if (!retry && (pending || conflict)) return;
    if (!retry && action !== 'clarification' && clarification.trim()) {
      setError('Save your separate clarification first so it is not lost.');
      return;
    }
    if (!retry && action !== 'correct' && changed) {
      setError('Save the transcription changes first, then choose this action.');
      return;
    }
    if (['not-text', 'unreadable', 'later'].includes(action) && !reason.trim()) {
      setError('Give a reason for this source disposition.');
      return;
    }
    if (action === 'clarification' && !clarification.trim()) {
      setError('Enter the information supplied from memory or another source.');
      return;
    }
    const request: SourceTextReviewRequest = retry || {
      operationId: crypto.randomUUID(),
      expectedRevisionId: revision.id,
      sourceHash: revision.sourceHash,
      action,
      scope:
        action === 'correct' || action === 'confirm' ? { page } : selectedIssue?.region || { page },
      ...(reason.trim() ? { reason: reason.trim() } : {}),
      ...(action === 'correct' ? { spans, relations } : {}),
      ...(action === 'confirm' && resolveIssueIds.length ? { resolveIssueIds } : {}),
      ...(action === 'clarification' ? { clarification: clarification.trim() } : {}),
    };
    setPending(request);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<Extract<IntakeSourceText, { status: 'available' }>>(path, {
        method: 'POST',
        body: JSON.stringify(request),
      });
      if (!alive.current) return;
      adopt(result.data);
      setNotice(
        action === 'later'
          ? 'Saved for later. This scope remains unfinished.'
          : action === 'clarification'
            ? 'Clarification saved separately from extracted text.'
            : action === 'correct'
              ? 'Correction saved. Other source questions remain until you explicitly inspect this page. Accepted clinical record versions are unchanged.'
              : 'Source review saved. Accepted clinical record versions are unchanged.',
      );
      onChanged?.();
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(true);
        setPending(null);
        setError(
          'This source revision changed. Your draft is still here. Load the latest revision and compare before applying any changes.',
        );
      } else {
        if (cause instanceof ApiError && [400, 413, 422].includes(cause.status)) setPending(null);
        setError(
          cause instanceof Error
            ? cause.message
            : 'The save could not be confirmed. Retry the same operation.',
        );
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function continueExtraction() {
    if (busy || paused.current || (dirty && !pendingExtraction)) return;
    const request = pendingExtraction || {
      operationId: crypto.randomUUID(),
      expectedRevisionId: revision.id,
    };
    setPendingExtraction(request);
    setBusy(true);
    setError('');
    try {
      const result = await api<Extract<IntakeSourceText, { status: 'available' }>>(
        '/intakes/' + encodeURIComponent(revision.intakeId) + '/source-extract',
        { method: 'POST', body: JSON.stringify(request) },
      );
      if (alive.current) {
        adopt(result.data);
        setNotice(
          result.data.extractionOperation?.status === 'interrupted'
            ? 'That extraction step was interrupted. Saved pages are kept; continuing starts a new bounded step.'
            : 'Local extraction progress saved. Remaining pages and exceptions stay visible.',
        );
        onChanged?.();
      }
    } catch (cause) {
      if (alive.current) {
        if (cause instanceof ApiError && cause.status === 409) {
          setPendingExtraction(null);
          setConflict(true);
        }
        setError(
          cause instanceof Error ? cause.message : 'Extraction result could not be confirmed.',
        );
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function checkLatest() {
    if (busy || paused.current) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<IntakeSourceText>(path);
      if (alive.current && result.data.status === 'available') {
        if (dirty || conflict) {
          setLatest(result.data);
          if (result.data.revision.id !== revision.id) setConflict(true);
        } else {
          adopt(result.data);
          setNotice('Latest saved source revision loaded.');
        }
      }
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : 'Could not load latest revision.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function selectPage(next: number) {
    if (dirty || busy || pageNavigationBlocked) {
      setError('Save or discard your current draft before changing pages.');
      return;
    }
    setPage(next);
    setSpans(pageSpans(revision, next));
    setIssueId('');
    setResolveIssueIds([]);
    setRotation(0);
    setNotice('');
  }
  function updateSpan(index: number, text: string) {
    setSpans((items) =>
      items.map((item, i) => (i === index ? { ...item, text, provenance: 'human' } : item)),
    );
  }
  const allSpans = [...revision.spans.filter((span) => span.region.page !== page), ...spans];
  const visibleRelations = relations.filter((relation) =>
    spans.some((span) => span.id === relation.from || span.id === relation.to),
  );
  const quarter = rotation % 180 !== 0;
  const naturalWidth = preview.data?.width || dimensions.width;
  const naturalHeight = preview.data?.height || dimensions.height;
  const scale =
    zoom === 'fit'
      ? previewWidth > 0
        ? Math.min(1, previewWidth / (quarter ? naturalHeight : naturalWidth))
        : 1
      : zoom;
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return (
    <>
      {guardNavigation && (
        <ReviewNavigationGuard
          anyLocationChange
          pending={() => stateRef.current.dirty || stateRef.current.busy}
          flush={async () => false}
        />
      )}
      {initialPage !== undefined &&
        !initial.revision.pages.some((item) => item.page === initialPage) && (
          <p role="status">
            Referenced page {initialPage} is unavailable in this saved text revision. Showing page{' '}
            {page} as original context.
          </p>
        )}
      <p role="status">
        {summary.inspectedPages} of {summary.pages} pages inspected · {summary.unresolved}{' '}
        unresolved questions · {summary.exceptions} exceptions. Inspection records your review; it
        does not guarantee accuracy.
      </p>
      <button className="button secondary" disabled={busy} onClick={() => void checkLatest()}>
        Load latest saved revision
      </button>
      {revision.issues.some(
        (issue) => /^p\d+-pending$/.test(issue.id) && issue.status === 'open',
      ) && (
        <div className="intake-notice">
          <p>
            Some pages are waiting for local extraction. Continue in bounded steps; existing
            corrections are kept.
          </p>
          <button
            className="button secondary"
            disabled={busy || (dirty && !pendingExtraction)}
            onClick={() => void continueExtraction()}
          >
            {pendingExtraction ? 'Retry identical extraction step' : 'Extract next pages locally'}
          </button>
        </div>
      )}
      <div className="source-review-toolbar">
        <label>
          Page or section{' '}
          <select
            value={page}
            disabled={busy || pageNavigationBlocked}
            onChange={(event) => selectPage(Number(event.target.value))}
          >
            {revision.pages.map((item) => (
              <option key={item.page} value={item.page}>
                {item.page} · {readable(item.disposition)}
                {item.inspected ? ' · inspected' : ''}
              </option>
            ))}
          </select>
        </label>
        <a
          className="text-link"
          href={apiUrl(`/sources/${encodeURIComponent(revision.intakeId)}/content`)}
          target="_blank"
          rel="noreferrer"
        >
          Open full original
        </a>
      </div>
      <SourceTextSearch path={path} revisionId={revision.id} onPage={selectPage} />
      <div className="source-review-columns">
        <section aria-label="Original source page">
          <div className="source-review-toolbar">
            <button
              type="button"
              className="button secondary"
              onClick={() => setRotation((value) => (value + 90) % 360)}
            >
              Rotate source clockwise
            </button>
            <label>
              Source zoom{' '}
              <select
                value={zoom}
                onChange={(event) =>
                  setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))
                }
              >
                <option value="fit">Fit to width</option>
                {[0.5, 0.75, 1, 1.5, 2].map((value) => (
                  <option key={value} value={value}>
                    {value * 100}%
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="helper-text">
            Rotation and zoom change the view only. Every part of this page can be corrected.
          </p>
          {preview.loading && <p role="status">Loading original page…</p>}
          {preview.error && (
            <p role="alert">
              Page preview unavailable. Open the full original to inspect it.{' '}
              <button className="text-link" onClick={preview.reload}>
                Retry page preview
              </button>
            </p>
          )}
          {preview.data?.text !== undefined && (
            <pre
              className="source-review-literal"
              tabIndex={0}
              aria-label={`Literal original section ${page}`}
            >
              {preview.data.text}
            </pre>
          )}
          {preview.data?.dataUrl && (
            <div
              ref={previewContainer}
              className="source-review-scroll"
              tabIndex={0}
              aria-label="Scrollable original page"
            >
              <div
                style={{
                  position: 'relative',
                  width: quarter ? height : width,
                  height: quarter ? width : height,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    width,
                    height,
                    left: '50%',
                    top: '50%',
                    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                  }}
                >
                  <img
                    src={preview.data.dataUrl}
                    alt={`Original page ${page}`}
                    style={{ width: '100%', height: '100%' }}
                    onLoad={(event) =>
                      setDimensions({
                        width: event.currentTarget.naturalWidth,
                        height: event.currentTarget.naturalHeight,
                      })
                    }
                  />
                  {revision.issues
                    .filter((issue) => issue.region.page === page && issue.region.box)
                    .map((issue) => (
                      <span
                        key={issue.id}
                        className="source-review-highlight"
                        style={{
                          left: `${issue.region.box![0] * 100}%`,
                          top: `${issue.region.box![1] * 100}%`,
                          width: `${issue.region.box![2] * 100}%`,
                          height: `${issue.region.box![3] * 100}%`,
                        }}
                        title={issue.detail}
                      />
                    ))}
                </div>
              </div>
            </div>
          )}
        </section>
        <section aria-label="Editable source transcript">
          <h4>Page {page} transcription</h4>
          <p>
            Correct any passage, add missing text or remove invented text. Keep administrative and
            repeated wording. Draft interpretations may need rereading after a correction; accepted
            versions remain intact. Saving a correction does not confirm the rest of this page.
          </p>
          {!spans.length && (
            <p>No wording retained for this page. This does not mean it is blank.</p>
          )}
          <div className="source-review-passages" role="group" aria-label="Editable passages">
            {spans.map((span, index) => (
              <div className="source-review-span" key={span.id}>
                <label htmlFor={`${id}-${span.id}`}>
                  Passage {index + 1} · {span.provenance}
                </label>
                <textarea
                  id={`${id}-${span.id}`}
                  value={span.text}
                  disabled={disabled}
                  onChange={(event) => updateSpan(index, event.target.value)}
                  rows={span.text.includes('\n') ? 6 : 2}
                />
                {span.alternatives?.map((alternative, i) => (
                  <p className="helper-text" key={i}>
                    Alternative ({alternative.adapter}): {alternative.text}
                  </p>
                ))}
                <button
                  type="button"
                  className="text-link"
                  disabled={disabled}
                  onClick={() => {
                    setSpans((items) => items.filter((item) => item.id !== span.id));
                    setRelations((items) =>
                      items.filter((item) => item.from !== span.id && item.to !== span.id),
                    );
                  }}
                >
                  Remove passage {index + 1}
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={disabled}
            onClick={() =>
              setSpans((items) => [
                ...items,
                {
                  id: `human-${crypto.randomUUID()}`,
                  text: '',
                  region: { page },
                  provenance: 'human',
                },
              ])
            }
          >
            Add missing text
          </button>
          <details>
            <summary>Reading order and table relationships</summary>
            <p className="helper-text">
              Connect passages on this or another page. Removing a passage also removes its draft
              connections.
            </p>
            {visibleRelations.map((relation) => (
              <div key={relation.id} className="source-review-relation">
                <span>
                  {relation.kind}: {allSpans.find((span) => span.id === relation.from)?.text} →{' '}
                  {allSpans.find((span) => span.id === relation.to)?.text}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  className="text-link"
                  onClick={() =>
                    setRelations((items) => items.filter((item) => item.id !== relation.id))
                  }
                >
                  Remove relationship
                </button>
              </div>
            ))}
            <RelationEditor
              spans={allSpans}
              disabled={disabled}
              onAdd={(relation) => setRelations((items) => [...items, relation])}
            />
          </details>
          <div className="source-review-toolbar">
            <button
              className="button primary"
              disabled={disabled || !changed}
              onClick={() => void save('correct')}
            >
              Save transcription correction
            </button>
            <button
              className="button secondary"
              disabled={disabled || changed}
              onClick={() => void save('confirm')}
            >
              I inspected this whole page
            </button>
          </div>
        </section>
      </div>
      <section aria-label="Source questions and dispositions">
        <h4>Questions on this page</h4>
        <p>
          Signals prioritize review; unflagged content may still be wrong. To resolve an unreadable
          area you have transcribed, save the wording first, select that question, then confirm
          inspection of the whole page. Unselected unreadable exceptions stay visible.
        </p>
        {revision.issues
          .filter((issue) => issue.region.page === page)
          .map((issue) => (
            <div className="intake-issue" key={issue.id}>
              <strong>
                {readable(issue.kind)} · {readable(issue.status)}
              </strong>
              <p>{issue.detail}</p>
              {(issue.kind === 'unreadable' || issue.status === 'unreadable') &&
                issue.kind !== 'unsupported' &&
                issue.status !== 'confirmed' &&
                issue.status !== 'corrected' && (
                  <label>
                    <input
                      type="checkbox"
                      checked={resolveIssueIds.includes(issue.id)}
                      disabled={
                        disabled ||
                        changed ||
                        !spans.some((span) => {
                          if (span.provenance !== 'human' || !span.text.trim()) return false;
                          const a = span.region.box;
                          const b = issue.region.box;
                          return (
                            !a ||
                            !b ||
                            (a[0] < b[0] + b[2] &&
                              b[0] < a[0] + a[2] &&
                              a[1] < b[1] + b[3] &&
                              b[1] < a[1] + a[3])
                          );
                        })
                      }
                      onChange={(event) =>
                        setResolveIssueIds((ids) =>
                          event.target.checked
                            ? [...ids, issue.id]
                            : ids.filter((value) => value !== issue.id),
                        )
                      }
                    />
                    Resolve with my saved transcription: {issue.detail}
                  </label>
                )}
            </div>
          ))}
        <label>
          Disposition applies to{' '}
          <select
            disabled={disabled}
            value={issueId}
            onChange={(event) => setIssueId(event.target.value)}
          >
            <option value="">Entire page {page}</option>
            {revision.issues
              .filter((issue) => issue.region.page === page)
              .map((issue) => (
                <option key={issue.id} value={issue.id}>
                  {issue.detail}
                </option>
              ))}
          </select>
        </label>
        <label>
          Reason or source context{' '}
          <textarea
            value={reason}
            disabled={disabled}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <p className="helper-text">
          “Not text” identifies a mark or nontext region. It cannot exclude readable wording because
          it seems unimportant.
        </p>
        <div className="source-review-toolbar">
          {(['not-text', 'unreadable', 'later'] as const).map((action) => (
            <button
              type="button"
              className="button secondary"
              key={action}
              disabled={disabled || changed}
              onClick={() => void save(action)}
            >
              {action === 'not-text'
                ? 'Not text'
                : action === 'unreadable'
                  ? 'Keep unreadable exception'
                  : 'Review later'}
            </button>
          ))}
        </div>
        <label>
          Clarification from memory or another source{' '}
          <textarea
            value={clarification}
            disabled={disabled}
            onChange={(event) => setClarification(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || changed || !clarification.trim()}
          onClick={() => void save('clarification')}
        >
          Save separate clarification
        </button>
      </section>
      <SourceTextHistory path={path} parentRevisionId={revision.parentRevisionId} />
      {revision.review && (
        <p className="helper-text">
          Latest source action: {readable(revision.review.action)} · {revision.review.at}
          {revision.review.clarification
            ? ` · External clarification: ${revision.review.clarification}`
            : ''}
        </p>
      )}
      {busy && <p role="status">Saving or checking source review…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {pending && !busy && (
        <button className="button secondary" onClick={() => void save(pending.action, pending)}>
          Retry identical source save
        </button>
      )}
      {latest && (
        <section className="intake-notice">
          <h4>Latest saved page {page}</h4>
          <pre>
            {pageSpans(latest.revision, page)
              .map((span) => span.text)
              .join('\n')}
          </pre>
          <p>Your draft remains above. Keeping the saved version discards this local draft.</p>
          <button className="button secondary" disabled={busy} onClick={() => adopt(latest)}>
            Keep latest saved version
          </button>
        </section>
      )}
      {dirty && !busy && !pending && !pendingExtraction && !conflict && (
        <button
          className="text-link"
          onClick={() => {
            adopt(current);
            setError('');
          }}
        >
          Discard unsaved source draft
        </button>
      )}
    </>
  );
}
function RelationEditor({
  spans,
  disabled,
  onAdd,
}: {
  spans: SourceTextSpan[];
  disabled: boolean;
  onAdd: (relation: SourceTextRelation) => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<SourceTextRelation['kind']>('precedes');
  const choices = spans.map((span) => (
    <option key={span.id} value={span.id}>
      Page {span.region.page}: {span.text.slice(0, 100) || '(empty passage)'}
    </option>
  ));
  return (
    <div className="source-review-toolbar">
      <label>
        First passage{' '}
        <select value={from} disabled={disabled} onChange={(event) => setFrom(event.target.value)}>
          <option value="">Choose</option>
          {choices}
        </select>
      </label>
      <label>
        Relationship{' '}
        <select
          value={kind}
          disabled={disabled}
          onChange={(event) => setKind(event.target.value as SourceTextRelation['kind'])}
        >
          {(['precedes', 'same-row', 'same-column', 'header-for'] as const).map((value) => (
            <option key={value} value={value}>
              {readable(value)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Second passage{' '}
        <select value={to} disabled={disabled} onChange={(event) => setTo(event.target.value)}>
          <option value="">Choose</option>
          {choices}
        </select>
      </label>
      <button
        className="button secondary"
        type="button"
        disabled={
          disabled ||
          !from ||
          !to ||
          from === to ||
          ![from, to].every((id) => spans.some((span) => span.id === id))
        }
        onClick={() => {
          onAdd({ id: `relation-${crypto.randomUUID()}`, from, to, kind, provenance: 'human' });
          setFrom('');
          setTo('');
        }}
      >
        Add relationship
      </button>
    </div>
  );
}

function SourceTextHistory({
  path,
  parentRevisionId,
}: {
  path: string;
  parentRevisionId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [revisionId, setRevisionId] = useState(parentRevisionId);
  const history = useResource<IntakeSourceText>(
    open && revisionId ? `${path}?revisionId=${encodeURIComponent(revisionId)}` : null,
  );
  useEffect(() => {
    setRevisionId(parentRevisionId);
  }, [parentRevisionId]);
  return (
    <section>
      <button
        type="button"
        className="text-link"
        disabled={!parentRevisionId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Source text revision history
      </button>
      {open && (
        <div>
          {history.loading && <p role="status">Loading retained revision…</p>}
          {history.error && <p role="alert">{history.error.message}</p>}
          {history.data?.status === 'available' && (
            <>
              <p>Historical revision · {history.data.revision.createdAt} · Read only</p>
              {history.data.revision.review && (
                <p>
                  {readable(history.data.revision.review.action)}:{' '}
                  {history.data.revision.review.reason ||
                    history.data.revision.review.clarification ||
                    'Source review recorded'}
                </p>
              )}
              {history.data.revision.spans.map((span) => (
                <p key={span.id}>
                  Page {span.region.page}: {span.text}
                </p>
              ))}
              <button
                className="button secondary"
                type="button"
                disabled={!history.data.revision.parentRevisionId}
                onClick={() => {
                  if (history.data?.status === 'available')
                    setRevisionId(history.data.revision.parentRevisionId);
                }}
              >
                Older source revision
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function SourceTextSearch({
  path,
  revisionId,
  onPage,
}: {
  path: string;
  revisionId: string;
  onPage: (page: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [cursor, setCursor] = useState({ offset: 0, character: 0 });
  const results = useResource<{
    matches: {
      spanId: string;
      page: number;
      character: number;
      text: string;
      provenance: string;
    }[];
    nextOffset: number | null;
    nextCharacter: number;
  }>(
    submitted
      ? path.replace(/source-text$/, 'source-search') +
          '?' +
          new URLSearchParams({
            query: submitted,
            revisionId,
            offset: String(cursor.offset),
            character: String(cursor.character),
          })
      : null,
  );
  useEffect(() => {
    setCursor({ offset: 0, character: 0 });
  }, [revisionId]);
  return (
    <section aria-label="Find retained text">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query);
          setCursor({ offset: 0, character: 0 });
        }}
      >
        <label>
          Find retained text
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="submit" className="button secondary" disabled={!query.trim()}>
          Find in source text
        </button>
      </form>
      <p className="helper-text">
        Exact, case-sensitive wording within retained passages in this revision. Missing matches do
        not prove absence from the original.
      </p>
      {results.loading && <p role="status">Finding retained passages…</p>}
      {results.error && <p role="alert">{results.error.message}</p>}
      {results.data && (
        <>
          <ul>
            {results.data.matches.map((match) => (
              <li key={match.spanId + ':' + match.character}>
                <button className="text-link" type="button" onClick={() => onPage(match.page)}>
                  Page {match.page} · {match.provenance}: {match.text}
                </button>
              </li>
            ))}
          </ul>
          {!results.data.matches.length && <p>No retained text matches on this search page.</p>}
          {results.data.nextOffset !== null && (
            <button
              type="button"
              className="button secondary"
              disabled={results.loading}
              onClick={() =>
                setCursor({
                  offset: results.data!.nextOffset!,
                  character: results.data!.nextCharacter,
                })
              }
            >
              Next text matches
            </button>
          )}
        </>
      )}
    </section>
  );
}
