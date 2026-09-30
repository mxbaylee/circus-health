import { useSourceAttentionRevision } from './useSourceAttentionRevision';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ImportSourceSelection } from './import-source-selection';
import type { Intake } from '../../../shared/intake';
import type {
  IntakeSourceText,
  SourceTextRevision,
  SourceTextReviewRequest,
} from '../../../shared/intake-source-text';
import { api, useResource } from '../../data/api';
import { useProfile } from '../../data/profile';
import { registerProfileTransitionEditor } from '../../data/profile-transition';
import { SourcePreview } from '../../components/SourceDialog';
import { intakeOriginal, ReviewNavigationGuard } from '../intake/ReviewWorkspace';
import { SourceTextReview } from '../intake/SourceTextReview';
import { ImportManualSourceRecord } from './ImportManualSourceRecord';
import type { ManualSourceRecordResult } from '../../../shared/intake-manual-source-record';

const unresolved = (status: string) => ['open', 'later', 'unreadable'].includes(status);
const pageText = (revision: SourceTextRevision, page: number) =>
  revision.spans
    .filter((s) => s.region.page === page)
    .map((s) => s.text)
    .join('\n');
/** Approval is transcription trust only. It never saves or regenerates clinical records. */
export function SourceAttentionReview({
  intake,
  onChanged,
  onPendingChange,
  onManualCreated,
  onRemainingChange,
  onRead,
  readingBlocked,
}: {
  onRead?: () => Promise<void>;
  readingBlocked?: string;
  intake: Intake;
  onRemainingChange?: (count: number) => void;
  onChanged: () => void;
  onPendingChange?: (pending: boolean) => void;
  onManualCreated?: (result: ManualSourceRecordResult) => void;
}) {
  const profile = useProfile();
  const registerSelection = useContext(ImportSourceSelection);
  const paused = useRef(false);
  const path = `/intakes/${encodeURIComponent(intake.id)}/source-text`;
  const resource = useResource<IntakeSourceText>(path);
  const scope = JSON.stringify([profile?.id, intake.id]);
  const source = useSourceAttentionRevision(
    scope,
    resource.data,
    typeof resource.meta?.revision === 'number' ? resource.meta.revision : undefined,
  );
  const data = source.data;
  useEffect(() => resource.reload(), [scope, intake.version]);
  const revision = data?.revision;
  const [selected, setSelected] = useState<number[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [baseline, setBaseline] = useState<{ id: string; text: string } | null>(null);
  const [reason, setReason] = useState('Corrected source transcription during import');
  const [busy, setBusy] = useState(false);
  const [manualPending, setManualPending] = useState(false);
  const [advancedPending, setAdvancedPending] = useState(false);
  const extraPending = manualPending || advancedPending;
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const lock = useRef(false);
  const dirty = !!baseline && open !== null && draft !== baseline.text;
  const sourceConflict = !!baseline && !!revision && baseline.id !== revision.id && dirty;
  useEffect(() => {
    lock.current = false;
    setBusy(false);
    setManualPending(false);
    setAdvancedPending(false);
    setAdvanced(false);
    setOpen(null);
    setBaseline(null);
    setDraft('');
    setSelected([]);
    setError('');
    setNotice('');
  }, [scope]);
  useEffect(() => {
    if (!revision || open === null || dirty || busy) return;
    const text = pageText(revision, open);
    setDraft(text);
    setBaseline({ id: revision.id, text });
  }, [revision?.id, open, busy]);
  const pending = busy || dirty || extraPending;
  const state = useRef({ pending, busy });
  state.current = { pending, busy };
  useEffect(
    () =>
      registerProfileTransitionEditor({
        profileId: profile?.id,
        pending: () => state.current.pending,
        checkReady: (choice) => {
          if (state.current.busy || (choice === 'save' && state.current.pending))
            throw new Error('Save or discard the source review before leaving this profile.');
        },
        save: async () => {
          throw new Error('Choose Update or Approve in source review first.');
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
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (state.current.pending) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const pendingListener = useRef(onPendingChange);
  pendingListener.current = onPendingChange;
  useEffect(() => {
    pendingListener.current?.(pending);
  }, [pending]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pendingListener.current?.(false);
    };
  }, []);
  const pages =
    revision?.pages.filter(
      (p) =>
        p.page === open ||
        revision.issues.some((i) => i.region.page === p.page && unresolved(i.status)),
    ) || [];
  const remainingCount =
    revision?.pages.filter((p) =>
      revision.issues.some((i) => i.region.page === p.page && unresolved(i.status)),
    ).length || 0;
  useEffect(() => {
    if (revision) onRemainingChange?.(remainingCount);
  }, [revision, remainingCount, onRemainingChange]);
  // Missing extraction and truly unreadable material cannot be approved into legibility.
  const eligible = (page: number) =>
    !!revision &&
    revision.pages.some(
      (p) => p.page === page && ['extracted', 'partial'].includes(p.disposition),
    ) &&
    revision.spans.some((s) => s.region.page === page && s.text.trim()) &&
    !revision.issues.some(
      (i) =>
        i.region.page === page &&
        unresolved(i.status) &&
        (['unreadable', 'unsupported'].includes(i.kind) ||
          i.status === 'unreadable' ||
          /^p\d+-pending$/.test(i.id)),
    );
  const approvable = pages.filter((p) => eligible(p.page)).map((p) => p.page);
  const selectedPages = selected.filter((page) => approvable.includes(page));
  const selectionActions = useRef({ approvable, selectedPages, pending, save });
  selectionActions.current = { approvable, selectedPages, pending, save };
  const selectionKey = JSON.stringify([approvable, selectedPages, pending]);
  useLayoutEffect(() => {
    registerSelection?.(intake.id, {
      count: approvable.length,
      selected: selectedPages.length,
      pending,
      select: (all) => {
        if (!selectionActions.current.pending)
          setSelected(all ? selectionActions.current.approvable : []);
      },
      approve: () =>
        selectionActions.current.save(selectionActions.current.selectedPages, 'confirm'),
    });
  }, [registerSelection, intake.id, selectionKey]);
  useEffect(() => () => registerSelection?.(intake.id, null), [registerSelection, intake.id]);
  function toggle(page: number) {
    if (pending) return;
    setOpen(open === page ? null : page);
    if (revision) {
      const text = pageText(revision, page);
      setDraft(text);
      setBaseline({ id: revision.id, text });
    }
    setAdvanced(false);
    setError('');
  }
  async function save(pagesToSave: number[], action: 'confirm' | 'correct'): Promise<boolean> {
    if (
      !revision ||
      !alive.current ||
      paused.current ||
      lock.current ||
      extraPending ||
      sourceConflict ||
      (action === 'confirm' && dirty)
    )
      return false;
    if (action === 'correct' && (!draft.trim() || !reason.trim())) return false;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const requestedScope = scope;
    let current = revision;
    let completed = 0;
    try {
      for (const page of pagesToSave) {
        if (!alive.current || !source.current(requestedScope)) break;
        const request: SourceTextReviewRequest = {
          operationId: crypto.randomUUID(),
          expectedRevisionId: current.id,
          sourceHash: current.sourceHash,
          action,
          scope: { page },
          ...(action === 'correct'
            ? {
                reason: reason.trim(),
                spans: [
                  {
                    id: crypto.randomUUID(),
                    text: draft,
                    region: { page },
                    provenance: 'human' as const,
                  },
                ],
              }
            : {}),
        };
        const result = await api<IntakeSourceText>(path, {
          method: 'POST',
          body: JSON.stringify(request),
        });
        if (!result.data.revision)
          throw new Error('The saved source revision is unavailable. Reload before continuing.');
        current = result.data.revision;
        completed++;
        if (!alive.current) break;
        if (
          !source.accept(
            result.data,
            typeof result.meta?.revision === 'number' ? result.meta.revision : undefined,
            requestedScope,
          )
        ) {
          throw new Error(
            'A newer source revision arrived during save. Compare it before continuing.',
          );
        }
        setSelected((items) => items.filter((item) => item !== page));
        if (action === 'confirm') setOpen((value) => (value === page ? null : value));
        else {
          const text = pageText(current, page);
          setDraft(text);
          setBaseline({ id: current.id, text });
        }
      }
      if (alive.current && source.current(requestedScope))
        setNotice(
          action === 'confirm'
            ? `${completed} ${completed === 1 ? 'section approved' : 'sections approved'}.`
            : 'Text updated. Approve the section when it looks correct.',
        );
      return completed === pagesToSave.length;
    } catch (cause) {
      if (alive.current && source.current(requestedScope))
        setError(
          `${completed ? `${completed} sections saved. ` : ''}${cause instanceof Error ? cause.message : 'Could not save source review.'} Remaining sections were not approved.`,
        );
      return false;
    } finally {
      if (alive.current && source.current(requestedScope)) {
        lock.current = false;
        setBusy(false);
        onChanged();
      }
    }
  }
  return (
    <section className="source-attention" aria-label={`Text review for ${intake.filename}`}>
      <ReviewNavigationGuard anyLocationChange pending={() => pending} flush={async () => false} />
      {resource.loading && !data && <p role="status">Loading source sections…</p>}
      {resource.error && <p role="alert">{resource.error.message}</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button
            className="text-link"
            disabled={pending}
            onClick={() => {
              source.clear();
              setSelected([]);
              resource.reload();
              setError('');
            }}
          >
            Reload sections
          </button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {revision && (
        <>
          <h4>
            {remainingCount} {remainingCount === 1 ? 'section' : 'sections'} not reviewed
          </h4>
          {!registerSelection && (
            <div className="import-bulk-bar">
              <label className="import-check-label">
                <input
                  type="checkbox"
                  aria-label="Select all approvable sections"
                  disabled={pending || !approvable.length}
                  checked={approvable.length > 0 && approvable.every((p) => selected.includes(p))}
                  ref={(input) => {
                    if (input)
                      input.indeterminate =
                        selected.length > 0 && selected.length < approvable.length;
                  }}
                  onChange={(e) => setSelected(e.target.checked ? approvable : [])}
                />{' '}
                {selected.length ? `${selected.length} selected` : 'Select all shown'}
              </label>
              {selected.length > 0 && (
                <button
                  className="button primary"
                  disabled={pending || !selected.length}
                  onClick={() => void save(selected, 'confirm')}
                >
                  Approve selected{selected.length ? ` (${selected.length})` : ''}
                </button>
              )}
            </div>
          )}
          <p className="helper-text">
            Trust the extracted text, or review it against the original. Approval only clears text
            checks; it does not save clinical records.
          </p>
          {!remainingCount && <p>No source sections awaiting review.</p>}
          <ul className="import-source-issue-list">
            {pages.map(({ page }) => {
              const text = pageText(revision, page);
              const canApprove = eligible(page);
              return (
                <li key={page}>
                  <div className="source-attention-row">
                    <input
                      type="checkbox"
                      aria-label={`Select page ${page}`}
                      disabled={pending || !canApprove}
                      checked={selected.includes(page)}
                      onChange={(e) =>
                        setSelected((items) =>
                          e.target.checked ? [...items, page] : items.filter((p) => p !== page),
                        )
                      }
                    />
                    <div>
                      <strong>Page {page} · Source text</strong>
                      <p className="source-attention-excerpt">
                        {text || 'No readable text extracted.'}
                      </p>
                      {!canApprove && (
                        <small>This section needs closer review before approval.</small>
                      )}
                    </div>
                    <button className="text-link" disabled={pending} onClick={() => toggle(page)}>
                      {open === page ? 'Close review' : 'Review'}
                    </button>
                    <button
                      className="button primary"
                      disabled={pending || !canApprove}
                      onClick={() => void save([page], 'confirm')}
                    >
                      Approve section
                    </button>
                  </div>
                  {open === page && (
                    <div className="source-attention-editor">
                      <div className="source-review-columns">
                        <AttentionOriginal intake={intake} page={page} revisionId={revision.id} />
                        <div className="import-correction-form source-attention-form">
                          <label>
                            Extracted text
                            <textarea
                              aria-label={`Extracted text on page ${page}`}
                              aria-describedby={
                                sourceConflict ? 'source-revision-conflict' : undefined
                              }
                              rows={12}
                              value={draft}
                              disabled={busy || extraPending}
                              onChange={(e) => setDraft(e.target.value)}
                            />
                          </label>
                          {sourceConflict && (
                            <div role="alert" id="source-revision-conflict">
                              <p>
                                Source text changed. Your draft is retained. Compare the current
                                text before saving.
                              </p>
                              <pre aria-label="Current source text">{text}</pre>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setBaseline({ id: revision.id, text })}
                              >
                                Keep my draft against this revision
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  setDraft(text);
                                  setBaseline({ id: revision.id, text });
                                }}
                              >
                                Use current text
                              </button>
                            </div>
                          )}
                          {dirty && (
                            <label>
                              Correction reason
                              <input
                                value={reason}
                                disabled={busy}
                                onChange={(e) => setReason(e.target.value)}
                              />
                            </label>
                          )}
                          <div className="source-review-toolbar">
                            <button
                              className="button primary"
                              disabled={
                                !dirty ||
                                sourceConflict ||
                                busy ||
                                extraPending ||
                                !draft.trim() ||
                                !reason.trim()
                              }
                              onClick={() => void save([page], 'correct')}
                            >
                              Update
                            </button>
                            <button
                              className="text-link"
                              disabled={busy || extraPending}
                              onClick={() => {
                                setDraft(text);
                                setOpen(null);
                              }}
                            >
                              {' '}
                              {dirty ? 'Discard changes and close' : 'Close review'}
                            </button>
                          </div>
                          <details
                            onToggle={(e) => {
                              if (manualPending) e.currentTarget.open = true;
                            }}
                          >
                            <summary>Add a missing clinical record</summary>
                            <fieldset disabled={dirty || busy || advanced}>
                              <ImportManualSourceRecord
                                intakeId={intake.id}
                                page={page}
                                onPendingChange={setManualPending}
                                onCreated={(result) => {
                                  onChanged();
                                  onManualCreated?.(result);
                                }}
                              />
                            </fieldset>
                          </details>
                          <details
                            onToggle={(e) => {
                              if (advancedPending) e.currentTarget.open = true;
                              setAdvanced(e.currentTarget.open);
                            }}
                          >
                            <summary>Unreadable text or other source actions</summary>
                            {dirty && <p>Save or discard your text changes first.</p>}
                            {onRead && (
                              <button
                                className="button secondary"
                                disabled={pending || !!readingBlocked}
                                onClick={async () => {
                                  try {
                                    await onRead();
                                  } catch (cause) {
                                    setError(
                                      cause instanceof Error
                                        ? cause.message
                                        : 'Could not start reading.',
                                    );
                                  }
                                }}
                              >
                                Reprocess corrected source
                              </button>
                            )}
                            {readingBlocked && <p className="helper-text">{readingBlocked}</p>}
                            {advanced && !dirty && !busy && (
                              <SourceTextReview
                                intakeId={intake.id}
                                embedded
                                initialPage={page}
                                pageNavigationBlocked={dirty || busy}
                                onPendingChange={setAdvancedPending}
                                onChanged={() => {
                                  source.clear();
                                  setOpen(null);
                                  setAdvanced(false);
                                  setSelected([]);
                                  resource.reload();
                                  onChanged();
                                }}
                              />
                            )}
                          </details>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {data?.status === 'unavailable' && (
        <SourceTextReview
          intakeId={intake.id}
          onPendingChange={onPendingChange}
          onChanged={() => {
            resource.reload();
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function AttentionOriginal({
  intake,
  page,
  revisionId,
}: {
  intake: Intake;
  page: number;
  revisionId: string;
}) {
  const literal = intake.mimeType !== 'application/pdf' && !intake.mimeType?.startsWith('image/');
  const preview = useResource<{ text?: string }>(
    literal
      ? '/intakes/' +
          encodeURIComponent(intake.id) +
          '/source-preview?page=' +
          page +
          '&revisionId=' +
          encodeURIComponent(revisionId)
      : null,
  );
  return (
    <div>
      <SourcePreview file={intakeOriginal(intake)} initialPage={page} />
      {literal && preview.loading && <p role="status">Loading original section…</p>}
      {literal && preview.error && (
        <p role="alert">Original preview unavailable. Open the original file to compare.</p>
      )}
      {literal && preview.data?.text !== undefined && (
        <pre className="source-review-literal" aria-label={'Original section ' + page}>
          {preview.data.text}
        </pre>
      )}
    </div>
  );
}
