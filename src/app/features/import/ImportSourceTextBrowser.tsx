import { useCallback, useEffect, useRef, useState } from 'react';
import type { Intake } from '../../../shared/intake';
import type { ManualSourceRecordResult } from '../../../shared/intake-manual-source-record';
import type { SourceTextIssueList } from '../../../shared/intake-source-text';
import { isRetainOnlyIntake } from '../../../shared/intake-source-policy';
import { api, apiUrl, useResource } from '../../data/api';
import { useProfile } from '../../data/profile';
import { SourceTextReview } from '../intake/SourceTextReview';
import { ImportManualSourceRecord } from './ImportManualSourceRecord';
import { SourceReaderObservations } from './SourceReaderObservations';
import './import-source-issues.css';
import { ImportSourceAttentionQueue } from './ImportSourceAttentionQueue';

export interface SourceBrowserProps {
  onChanged: () => void;
  attentionRows?: boolean;
  onAttentionCount?: (count: number) => void;
  attentionRefreshKey?: unknown;
  onPendingChange?: (pending: boolean) => void;
  intakeId?: string;
  onRead?: (rootIntakeId: string) => Promise<void>;
  readingBlocked?: string;
  onManualCreated?: (result: ManualSourceRecordResult) => void;
  onAddRecord?: (source: { intakeId: string; page: number }) => void;
}

/** Original inventory is visible independently of whether any clinical record was proposed. */
export function ImportSourceTextBrowser(props: SourceBrowserProps) {
  const profile = useProfile();
  if (props.attentionRows) return <ImportSourceAttentionQueue key={profile?.id} {...props} />;
  return (
    <ImportedSourceSections key={`${profile?.id}:${props.intakeId || 'inventory'}`} {...props} />
  );
}

function ImportedSourceSections({
  onChanged,
  onRead,
  readingBlocked,
  onAddRecord,
  onManualCreated,
  intakeId,
  onPendingChange,
}: SourceBrowserProps) {
  const profile = useProfile();
  const alive = useRef(true);
  const readingLock = useRef(false);
  const [reading, setReading] = useState(false);
  const [readingNotice, setReadingNotice] = useState('');
  const [readingError, setReadingError] = useState('');
  const [offset, setOffset] = useState(0);
  const [members, setMembers] = useState(false);
  const [selected, setSelected] = useState<Intake | null>(null);
  const [pendingSources, setPendingSources] = useState<Set<string>>(() => new Set());
  const pending = pendingSources.size > 0;
  const setSourcePending = useCallback((id: string, value: boolean) => {
    setPendingSources((current) => {
      if (current.has(id) === value) return current;
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const [notice, setNotice] = useState('');
  const pendingListener = useRef(onPendingChange);
  pendingListener.current = onPendingChange;
  useEffect(() => {
    pendingListener.current?.(pending || reading);
  }, [pending, reading]);
  useEffect(
    () => () => {
      pendingListener.current?.(false);
    },
    [],
  );
  const resource = useResource<Intake[] | Intake>(
    intakeId
      ? `/intakes/${encodeURIComponent(intakeId)}`
      : `/intakes?rootOnly=${!members}&limit=30&offset=${offset}`,
  );
  const sources = resource.data
    ? Array.isArray(resource.data)
      ? resource.data
      : [resource.data]
    : [];
  const retainOnly = !!selected && isRetainOnlyIntake(selected);
  const guards = useRef({ pending, readingBlocked });
  guards.current = { pending, readingBlocked };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function readSource(source = selected) {
    if (
      !source ||
      isRetainOnlyIntake(source) ||
      !profile ||
      !onRead ||
      pending ||
      readingBlocked ||
      readingLock.current
    )
      return;
    readingLock.current = true;
    setReading(true);
    setReadingError('');
    setReadingNotice('');
    try {
      // Re-read ownership rather than trusting a possibly stale list entry. Package children
      // belong to their original delivery and must not start a second, competing job.
      let id = source.id;
      const seen = new Set<string>();
      let root: Intake;
      while (true) {
        if (seen.has(id) || seen.size >= 100)
          throw new Error(
            'The source package ancestry could not be resolved. Refresh imported files.',
          );
        seen.add(id);
        const result = await api<Intake>(
          '/api/profiles/' + encodeURIComponent(profile.id) + '/intakes/' + encodeURIComponent(id),
        );
        if (!alive.current) return;
        if (guards.current.pending || guards.current.readingBlocked)
          throw new Error(
            guards.current.readingBlocked ||
              'Save or discard your source review draft before starting clinical reading.',
          );
        if (result.data.id !== id)
          throw new Error('The source package response did not match this file.');
        root = result.data;
        if (!root.parentSourceFileId) break;
        id = root.parentSourceFileId;
      }
      await onRead(root.id);
      if (alive.current) {
        setReadingNotice(
          'Clinical reading queued for ' +
            root.filename +
            '. Review the resulting proposals before saving records.',
        );
        onChanged();
      }
    } catch (cause) {
      if (alive.current)
        setReadingError(
          cause instanceof Error
            ? cause.message
            : 'Clinical reading could not start. Your saved original and corrections are retained.',
        );
    } finally {
      readingLock.current = false;
      if (alive.current) setReading(false);
    }
  }
  const change = (next: Intake | null) => {
    if (readingLock.current) return;
    if (pending) {
      setNotice('Save or discard the current source review draft before opening another file.');
      return;
    }
    setSelected(next);
    setNotice('');
    setReadingNotice('');
    setReadingError('');
  };
  if (
    !intakeId &&
    !resource.loading &&
    !resource.error &&
    resource.data &&
    sources.length === 0 &&
    resource.meta?.complete !== false
  )
    return null;
  return (
    <section
      className={`import-source-sections${intakeId ? ' is-embedded' : ''}`}
      aria-label="Imported originals and source issues"
    >
      {!intakeId && (
        <div className="source-review-toolbar">
          <h2>Source areas to review</h2>
          <label>
            <input
              type="checkbox"
              checked={members}
              disabled={pending || reading}
              onChange={(event) => {
                setMembers(event.target.checked);
                setOffset(0);
                change(null);
              }}
            />{' '}
            Include package members
          </label>
          <button
            className="text-link"
            type="button"
            disabled={pending || reading}
            onClick={resource.reload}
          >
            Refresh imported files
          </button>
        </div>
      )}
      {!intakeId && (
        <p className="helper-text">
          Review possible omissions or unclear readings, including files with no proposed records.
          Add a missing record from the relevant section. Source inspection never approves clinical
          records; no flags does not guarantee that nothing was missed.
        </p>
      )}
      {resource.loading && <p role="status">Loading imported sources…</p>}
      {resource.error && <p role="alert">{resource.error.message}</p>}
      {sources.length === 0 && !resource.loading && !intakeId && (
        <p>No imported originals on this page.</p>
      )}
      {notice && <p role="alert">{notice}</p>}
      {sources.map((intake) => (
        <SourceReportSection
          key={intake.id}
          intake={intake}
          compact={!!intakeId}
          expanded={selected?.id === intake.id}
          pending={pending}
          reading={reading}
          onToggle={() => change(selected?.id === intake.id ? null : intake)}
          onPendingChange={setSourcePending}
          onChanged={onChanged}
          onAddRecord={onAddRecord}
          onManualCreated={onManualCreated}
        >
          {onRead && (
            <div className="intake-notice">
              <p>
                After saving source corrections, start a fresh clinical reading. Package members are
                read with their original delivery. Accepted records stay unchanged until you review
                new proposals.
              </p>
              <button
                type="button"
                className="button secondary"
                disabled={retainOnly || pending || reading || !!readingBlocked}
                onClick={() => void readSource()}
              >
                {reading ? 'Starting clinical reading…' : 'Read source for clinical review'}
              </button>
              {(retainOnly || pending || readingBlocked) && (
                <p className="helper-text">
                  {retainOnly
                    ? 'This format is kept as an original only. Clinical reading is unavailable; select a readable report instead.'
                    : pending
                      ? 'Save or discard your source review draft before starting clinical reading.'
                      : readingBlocked}
                </p>
              )}
              {readingNotice && <p role="status">{readingNotice}</p>}
              {readingError && <p role="alert">{readingError}</p>}
            </div>
          )}
        </SourceReportSection>
      ))}
      {!intakeId && (
        <div className="source-review-toolbar">
          <button
            className="button secondary"
            type="button"
            disabled={resource.loading || offset === 0 || pending || reading}
            onClick={() => {
              change(null);
              setOffset((value) => Math.max(0, value - 30));
            }}
          >
            Previous source files
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={resource.loading || resource.meta?.complete !== false || pending || reading}
            onClick={() => {
              change(null);
              setOffset((value) => value + 30);
            }}
          >
            More source files
          </button>
        </div>
      )}
    </section>
  );
}

type Issue = SourceTextIssueList['issues'][number];
function issueState(issue: Issue): string {
  if (issue.status === 'later') return 'Review later';
  if (issue.status === 'unreadable') return 'Unreadable';
  return issue.category === 'processing-failure'
    ? 'Processing needs attention'
    : issue.category === 'not-inspected'
      ? 'Not fully inspected'
      : 'Needs verification';
}

function SourceReportSection({
  intake,
  compact,
  expanded,
  pending,
  reading,
  onToggle,
  onPendingChange,
  onChanged,
  onAddRecord,
  onManualCreated,
  children,
}: {
  intake: Intake;
  compact?: boolean;
  expanded: boolean;
  pending: boolean;
  reading: boolean;
  onToggle: () => void;
  onPendingChange: (intakeId: string, pending: boolean) => void;
  onChanged: () => void;
  onAddRecord?: SourceBrowserProps['onAddRecord'];
  onManualCreated?: SourceBrowserProps['onManualCreated'];
  children: React.ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const [pin, setPin] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    page: number;
    issueId?: string;
    readerId?: string;
  } | null>(null);
  const [editorPage, setEditorPage] = useState(1);
  const [textPending, setTextPending] = useState(false);
  const [manualPending, setManualPending] = useState(false);
  useEffect(() => {
    onPendingChange(intake.id, textPending || manualPending);
  }, [intake.id, textPending, manualPending, onPendingChange]);
  useEffect(() => () => onPendingChange(intake.id, false), [intake.id, onPendingChange]);
  const [notice, setNotice] = useState('');
  const resource = useResource<SourceTextIssueList>(
    `/intakes/${encodeURIComponent(intake.id)}/source-issues?offset=${offset}&limit=50${offset && pin ? `&revisionId=${encodeURIComponent(pin)}` : ''}`,
  );
  const summary = resource.data?.summary;
  const specific =
    resource.data?.issues.filter((issue) => issue.category !== 'not-inspected') || [];
  const generic = resource.data?.issues.filter((issue) => issue.category === 'not-inspected') || [];
  const select = (next: typeof editor) => {
    if (pending || reading) {
      setNotice('Save or discard the current source review draft before opening another area.');
      return;
    }
    setEditor(next);
    setEditorPage(next?.page || 1);
    setNotice('');
  };
  const refresh = () => {
    setOffset(0);
    setPin(null);
    resource.reload();
  };
  const editorView = (selection: NonNullable<typeof editor>) => (
    <div className="import-source-issue-editor">
      {onAddRecord ? (
        <button
          className="button secondary"
          type="button"
          disabled={pending || reading}
          onClick={() => onAddRecord({ intakeId: intake.id, page: editorPage })}
        >
          Add record from this section
        </button>
      ) : (
        <fieldset className="import-source-manual" disabled={textPending || reading}>
          <ImportManualSourceRecord
            intakeId={intake.id}
            page={editorPage}
            onPendingChange={setManualPending}
            onCreated={(result) => {
              refresh();
              onManualCreated?.(result);
              onChanged();
            }}
          />
        </fieldset>
      )}
      <SourceTextReview
        key={`${intake.id}:${selection.issueId || selection.readerId || 'original'}:${selection.page}`}
        intakeId={intake.id}
        embedded
        initialPage={selection.page}
        initialIssueId={selection.issueId}
        onPageChange={setEditorPage}
        onPendingChange={setTextPending}
        pageNavigationBlocked={manualPending}
        onChanged={() => {
          refresh();
          onChanged();
        }}
      />
    </div>
  );
  const issueRows = (issues: Issue[]) => (
    <ul className="import-source-issue-list">
      {issues.map((issue) => (
        <li key={issue.id}>
          <button
            type="button"
            className="import-source-issue-row"
            aria-expanded={editor?.issueId === issue.id}
            disabled={reading}
            onClick={() =>
              select(
                editor?.issueId === issue.id
                  ? null
                  : { page: issue.region.page, issueId: issue.id },
              )
            }
          >
            <span>
              <strong>{issueState(issue)}</strong>
              <span>
                {issue.detail}
                {issue.detailTruncated ? '…' : ''}
              </span>
              <small>
                Page {issue.region.page} ·{' '}
                {issue.precision === 'region' ? 'Located area' : 'Page location only'}
              </small>
            </span>
            <span className="text-link">
              {editor?.issueId === issue.id ? 'Close review' : 'Review'}
            </span>
          </button>
          {editor?.issueId === issue.id && editorView(editor)}
        </li>
      ))}
    </ul>
  );
  const groupedIssueRows = (issues: Issue[]) => {
    const pages = new Map<number, Issue[]>();
    for (const issue of issues)
      pages.set(issue.region.page, [...(pages.get(issue.region.page) || []), issue]);
    return [...pages].map(([page, group]) =>
      group.length === 1 ? (
        <div key={page}>{issueRows(group)}</div>
      ) : (
        <details
          key={page}
          className="import-source-page-group"
          onToggle={(event) => {
            if (!event.currentTarget.open && pending && editor?.page === page)
              event.currentTarget.open = true;
          }}
        >
          <summary>
            Page {page} · {group.length} reading flags in this batch
          </summary>
          <p className="helper-text">
            Review this page together. Flags are extraction signals, not a count of missing records.
          </p>
          <button
            className="button secondary"
            type="button"
            disabled={pending || reading}
            onClick={() => select({ page, readerId: 'page-group:' + page })}
          >
            Review page {page} together
          </button>
          {editor?.readerId === 'page-group:' + page && editorView(editor)}
          <details>
            <summary>Individual flags</summary>
            {issueRows(group)}
          </details>
        </details>
      ),
    );
  };
  return (
    <article
      className={`import-report import-source-report${compact ? ' is-embedded' : ''}`}
      aria-label={`Original ${intake.filename}`}
    >
      {!compact && (
        <header className="import-report-title">
          <h3>{intake.filename}</h3>
        </header>
      )}
      <div className="import-source-report-summary">
        <button
          type="button"
          className="text-link"
          aria-label={intake.filename}
          aria-expanded={expanded}
          disabled={reading}
          onClick={onToggle}
        >
          {resource.loading && !resource.data
            ? 'Checking source issues…'
            : resource.error
              ? 'Source review status unavailable · Review'
              : resource.data?.extractionFailure
                ? 'Source processing needs attention · Review'
                : resource.data?.status === 'unavailable'
                  ? 'Text extraction not available yet · Review'
                  : summary?.specificIssues
                    ? `${summary.specificIssues} ${summary.specificIssues === 1 ? 'area needs' : 'areas need'} verification · Review`
                    : 'No specific issues flagged · Review original'}
        </button>
        {!!summary?.coverageIssues && (
          <span>
            Not fully inspected · {summary.coverageIssues}{' '}
            {summary.coverageIssues === 1 ? 'area' : 'areas'}
          </span>
        )}
        {!!summary?.inspectedPages && (
          <span>
            {summary.inspectedPages} of {summary.pages} pages inspected by you
          </span>
        )}
        {!!summary?.exceptions && (
          <span>
            {summary.exceptions} unreadable or deferred{' '}
            {summary.exceptions === 1 ? 'exception' : 'exceptions'}
          </span>
        )}
        <a
          className="text-link"
          href={apiUrl(`/sources/${encodeURIComponent(intake.id)}/content`)}
          target="_blank"
          rel="noreferrer"
        >
          Open original
        </a>
      </div>
      {expanded && (
        <div className="import-source-report-body">
          {notice && <p role="alert">{notice}</p>}
          {resource.data?.extractionFailure && (
            <p role="alert">
              Source processing stopped. The original is retained; review it or retry local
              extraction below.{' '}
              <small>
                Reason:{' '}
                {resource.data.extractionFailure.reasonCode.toLowerCase().replaceAll('_', ' ')}.
              </small>
            </p>
          )}
          {resource.error && (
            <p role="alert">
              {resource.error.message}{' '}
              <button
                type="button"
                className="text-link"
                disabled={pending || reading}
                onClick={refresh}
              >
                Refresh source issues
              </button>
            </p>
          )}
          {!!specific.length && (
            <section aria-label="Specific source issues">
              <h3>Areas needing verification</h3>
              {groupedIssueRows(specific)}
            </section>
          )}
          {!!generic.length && (
            <details
              className="import-source-coverage"
              onToggle={(event) => {
                if (
                  !event.currentTarget.open &&
                  pending &&
                  editor?.issueId &&
                  generic.some((issue) => issue.id === editor.issueId)
                )
                  event.currentTarget.open = true;
              }}
            >
              <summary>Not fully inspected ({generic.length} on this page)</summary>
              <p>
                These are coverage caveats, not detected low accuracy. Review the original when
                useful; unflagged content may still be wrong.
              </p>
              {issueRows(generic)}
            </details>
          )}
          {(offset > 0 ||
            (resource.data?.nextOffset !== null && resource.data?.nextOffset !== undefined)) && (
            <div className="source-review-toolbar">
              <button
                type="button"
                className="button secondary"
                disabled={pending || reading || offset === 0}
                onClick={() => {
                  select(null);
                  setOffset(Math.max(0, offset - 50));
                }}
              >
                Previous source issues
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={pending || reading || resource.data?.nextOffset == null}
                onClick={() => {
                  if (!resource.data?.revisionId || resource.data.nextOffset == null) return;
                  select(null);
                  setPin(resource.data.revisionId);
                  setOffset(resource.data.nextOffset);
                }}
              >
                More source issues
              </button>
            </div>
          )}
          <div className="import-source-issue-list">
            <button
              type="button"
              className="import-source-issue-row"
              aria-label="Review source text"
              aria-expanded={!!editor && !editor.issueId && !editor.readerId}
              disabled={reading}
              onClick={() =>
                select(editor && !editor.issueId && !editor.readerId ? null : { page: 1 })
              }
            >
              <span>
                <strong>Original and extracted text</strong>
                <span>Inspect every page, including unflagged and administrative material.</span>
              </span>
              <span className="text-link">Review source text</span>
            </button>
            {editor && !editor.issueId && !editor.readerId && editorView(editor)}
          </div>
          <SourceReaderObservations
            intakeId={intake.id}
            initial={resource.data?.readerCoverage}
            blocked={pending || reading}
            onPageChange={() => select(null)}
            onReview={(entry) =>
              select({ page: entry.pages?.[0] || 1, readerId: `${entry.planId}:${entry.unitId}` })
            }
            renderReview={(entry) =>
              editor?.readerId === `${entry.planId}:${entry.unitId}` ? editorView(editor) : null
            }
          />
          {children}
        </div>
      )}
    </article>
  );
}
