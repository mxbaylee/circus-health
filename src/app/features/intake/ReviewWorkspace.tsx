import type { IntakeHeader } from '../../../shared/intake-summary';
import { useContext, useEffect, useId, useRef, useState } from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';
import type { ReactNode } from 'react';
import type {
  IntakeClinicalMapping,
  IntakeIssueResolution,
  IntakeMetadata,
  IntakeReviewIssue,
  IntakeReviewRecord,
  IntakeEvidenceLocator,
} from '../../../shared/intake';
import type { SourceFile } from '../../../shared/api';
import { CreatableCombobox } from '../../components/CreatableCombobox';
import { SourcePreview } from '../../components/SourceDialog';
import { apiUrl } from '../../data/api';

export interface IntakeMetadataSuggestions {
  source: string[];
  careArea: string[];
  documentType: string[];
  topics: string[];
}

export function intakeOriginal(intake: IntakeHeader): SourceFile {
  return {
    id: intake.id,
    providerId: intake.providerId,
    provider: intake.provider,
    path: intake.filename ?? intake.contentUrl,
    sha256: intake.sha256,
    bytes: intake.bytes,
    mimeType: intake.mimeType,
    kind: 'original',
    coverageStatus: 'retained_original',
    details: null,
    contentUrl: intake.contentUrl,
  };
}

export function intakeEvidencePage(
  intake: IntakeHeader,
  evidence: IntakeEvidenceLocator[],
): number | undefined {
  const sameOriginal = (url?: string) => {
    if (!url) return false;
    const base = url.split('#')[0];
    const original = intake.contentUrl.split('#')[0];
    if (base === original) return true;
    try {
      return apiUrl(base) === apiUrl(original);
    } catch {
      return false;
    }
  };
  const reference = evidence.find(
    (item) =>
      sameOriginal(item.contentUrl) && /^page=[1-9]\d*$/.test(item.contentUrl?.split('#')[1] || ''),
  );
  const page = reference ? Number(reference.contentUrl!.split('#page=')[1]) : undefined;
  if (page && Number.isSafeInteger(page)) return page;
  // Older proposals locate pages in prose instead of URL fragments. Treat a
  // single same-original page mention as a navigation hint, never region proof.
  const pages = new Set(
    evidence
      .filter((item) => sameOriginal(item.contentUrl))
      .flatMap((item) =>
        [...item.locator.matchAll(/\bpage\s+([1-9]\d*)\b/gi)].map((match) => Number(match[1])),
      ),
  );
  if (pages.size !== 1) return undefined;
  const hint = [...pages][0];
  return Number.isSafeInteger(hint) ? hint : undefined;
}

export function ReviewLayout({
  intake,
  children,
  evidence = [],
  sideBySide = false,
}: {
  intake: IntakeHeader;
  children: ReactNode;
  evidence?: IntakeEvidenceLocator[];
  sideBySide?: boolean;
}) {
  // Only use locations attached to this original, never another package member.
  const initialPage = intakeEvidencePage(intake, evidence);
  const [tab, setTab] = useState<'details' | 'original'>('details');
  const id = useId();
  useEffect(() => setTab('details'), [intake.id]);
  return (
    <>
      <div
        className="intake-mobile-tabs"
        role="tablist"
        aria-label="Review workspace"
        hidden={sideBySide}
      >
        {(['details', 'original'] as const).map((value) => (
          <button
            key={value}
            id={`${id}-${value}-tab`}
            role="tab"
            aria-selected={tab === value}
            aria-controls={`${id}-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 'details'
                    : event.key === 'End'
                      ? 'original'
                      : tab === 'details'
                        ? 'original'
                        : 'details';
                setTab(next);
                document.getElementById(`${id}-${next}-tab`)?.focus();
              }
            }}
          >
            {value === 'details' ? 'Details' : 'Original'}
          </button>
        ))}
      </div>
      <div className={`intake-review-layout ${tab === 'original' ? 'is-original-open' : ''}`}>
        <div
          id={`${id}-details`}
          style={{ minWidth: 0, overflowWrap: 'anywhere' }}
          role="tabpanel"
          aria-labelledby={`${id}-details-tab`}
          hidden={!sideBySide && tab !== 'details'}
        >
          {children}
        </div>
        <aside
          id={`${id}-original`}
          className="intake-original-pane"
          role="tabpanel"
          aria-labelledby={`${id}-original-tab`}
          hidden={!sideBySide && tab !== 'original'}
        >
          <div className="intake-original-heading">
            <h3>Original</h3>
            <button
              className="text-link intake-original-back"
              onClick={() => {
                setTab('details');
                document.getElementById(`${id}-details-tab`)?.focus();
              }}
            >
              Back to report
            </button>
          </div>
          {evidence.length > 0 && (
            <ul className="intake-evidence-locations">
              {evidence.map((item, index) => (
                <li key={index}>
                  {item.contentUrl ? (
                    <a href={item.contentUrl} target="_blank" rel="noreferrer">
                      {item.label}: {item.locator}
                    </a>
                  ) : (
                    `${item.label}: ${item.locator}`
                  )}
                </li>
              ))}
            </ul>
          )}
          <SourcePreview key={intake.id} file={intakeOriginal(intake)} initialPage={initialPage} />
          <p className="helper-text">
            Your original stays retained, including anything left out of clinical records.
          </p>
        </aside>
      </div>
    </>
  );
}

export function IntakeMetadataEditor({
  intake,
  options,
  suggestions,
  busy,
  onSave,
  onDirtyChange,
}: {
  intake: IntakeHeader;
  options: IntakeHeader[];
  suggestions?: IntakeMetadataSuggestions;
  busy: boolean;
  onSave: (metadata: IntakeMetadata) => Promise<boolean>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const initial = (): IntakeMetadata => ({
    source: intake.metadata ? intake.metadata.source : intake.provider || null,
    careArea: intake.metadata?.careArea || null,
    documentType: intake.metadata?.documentType || null,
    topics: intake.metadata?.topics || [],
  });
  const [metadata, setMetadata] = useState(initial);
  const [dirty, setDirty] = useState(false);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );
  useEffect(() => {
    if (!dirty) setMetadata(initial());
    else if (JSON.stringify(metadata) === JSON.stringify(initial())) setDirty(false);
  }, [intake.metadata, intake.provider, dirty]);
  const applySuggestion = (field: keyof IntakeMetadata, value: string) => {
    const next = {
      ...metadata,
      [field]: field === 'topics' ? [...new Set([...metadata.topics, value])] : value,
    } as IntakeMetadata;
    setDirty(true);
    setMetadata(next);
    void onSave(next).then((saved) => {
      if (saved) setDirty(false);
    });
  };
  const suggestedEntries = suggestions
    ? (Object.entries(suggestions) as [keyof IntakeMetadataSuggestions, string[]][]).flatMap(
        ([field, values]) =>
          values
            .filter((value) => {
              const current = field === 'topics' ? metadata.topics : [metadata[field]];
              return !current.some(
                (item) => typeof item === 'string' && item.toLowerCase() === value.toLowerCase(),
              );
            })
            .map((value) => ({ field, value })),
      )
    : [];
  if (intake.metadataState === 'unloaded')
    return (
      <p role="status">
        File labels have not loaded completely. Refresh the file before editing its labels.
      </p>
    );
  return (
    <section className="intake-metadata" aria-label="File details">
      <p className="helper-text">
        Source is your label for this collection. Original issuer and signer details stay with the
        evidence.
        {intake.acquisition?.provider ? ` Uploaded from: ${intake.acquisition.provider}.` : ''}
      </p>
      {suggestedEntries.length > 0 && (
        <section className="intake-metadata-suggestions" aria-label="Suggested file details">
          <p>
            <strong>Suggested from this report</strong>
          </p>
          <p className="helper-text">Choose only the details supported by the original.</p>
          <div className="intake-actions">
            {suggestedEntries.map(({ field, value }) => {
              const label = {
                source: 'source',
                careArea: 'care area',
                documentType: 'document type',
                topics: 'topic',
              }[field];
              const replaces = field !== 'topics' && !!metadata[field];
              return (
                <button
                  className="button secondary"
                  type="button"
                  key={`${field}-${value}`}
                  disabled={busy}
                  onClick={() => applySuggestion(field, value)}
                >
                  {replaces ? `Replace ${label} with ${value}` : `Use suggested ${label}: ${value}`}
                </button>
              );
            })}
          </div>
        </section>
      )}
      <div className="intake-metadata-fields">
        {(['source', 'careArea', 'documentType', 'topics'] as const).map((field) => {
          const label = {
            source: 'Source',
            careArea: 'Care area',
            documentType: 'Document type',
            topics: 'Topics',
          }[field];
          return (
            <CreatableCombobox
              key={field}
              label={label}
              createNoun={label.toLowerCase()}
              multiple={field === 'topics'}
              disabled={busy}
              maxLength={200}
              values={
                field === 'topics' ? metadata.topics : metadata[field] ? [metadata[field]!] : []
              }
              options={[
                ...(field === 'careArea'
                  ? ['Medical', 'Dental', 'Vision']
                  : field === 'documentType'
                    ? [
                        'Prescription',
                        'Test report',
                        'Visit summary',
                        'Imaging report',
                        'Discharge summary',
                      ]
                    : []),
                ...options
                  .flatMap((item) =>
                    field === 'topics'
                      ? item.metadata?.topics || []
                      : [item.metadata?.[field] || (field === 'source' ? item.provider : '')],
                  )
                  .filter(Boolean),
              ]}
              onChange={(values) => {
                const next = {
                  ...metadata,
                  [field]: field === 'topics' ? values : values[0] || null,
                };
                setDirty(true);
                setMetadata(next);
                void onSave(next).then((saved) => {
                  if (saved) setDirty(false);
                });
              }}
            />
          );
        })}
      </div>
      {dirty && (
        <button
          className="button secondary"
          disabled={busy}
          onClick={async () => {
            if (await onSave(metadata)) setDirty(false);
          }}
        >
          Save file details
        </button>
      )}
    </section>
  );
}

export function ExactIssueText({ text, issues }: { text: string; issues: IntakeReviewIssue[] }) {
  const anchors = issues.filter((issue) => issue.textAnchor && text.includes(issue.textAnchor));
  const fragments: ReactNode[] = [];
  let offset = 0;
  const positioned = anchors
    .map((issue) => ({ issue, start: text.indexOf(issue.textAnchor!) }))
    .sort((a, b) => a.start - b.start);
  for (const { issue, start } of positioned) {
    if (start < offset) continue;
    fragments.push(text.slice(offset, start));
    fragments.push(
      <a
        key={`${issue.id}-${start}`}
        className="intake-text-anchor"
        href={`#issue-${issue.id}`}
        onClick={(event) => {
          event.preventDefault();
          const element = document.getElementById(`issue-${issue.id}`);
          for (let parent = element; parent; parent = parent.parentElement) {
            if (parent instanceof HTMLDetailsElement) parent.open = true;
          }
          element?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
          (
            element?.querySelector('summary') ||
            element?.closest('details')?.querySelector('summary')
          )?.focus();
        }}
      >
        {issue.textAnchor}
      </a>,
    );
    offset = start + issue.textAnchor!.length;
  }
  fragments.push(text.slice(offset));
  return <div className="intake-readable-text">{fragments}</div>;
}

export interface ReviewIssueGroup {
  issue: IntakeReviewIssue;
  issues: IntakeReviewIssue[];
}

// Group only within one candidate. Fieldless dates do not identify a logical field.
// Ownership questions with no field or subject both ask about this same candidate.
// A page-less date can join a page-specific date only when that region is unambiguous.
export function groupReviewIssues(
  record: IntakeReviewRecord,
  resolutions: IntakeIssueResolution[] = [],
): ReviewIssueGroup[] {
  const effective = (record.issues || []).map((issue) => {
    const resolution = resolutions.find((item) => item.issueId === issue.id) || issue.resolution;
    return resolution ? { ...issue, resolution, status: 'resolved' as const } : issue;
  });
  const dateField = (issue: IntakeReviewIssue) =>
    record.kind === 'document' && ['date', 'documentDate'].includes(issue.field || '')
      ? 'documentDate'
      : issue.field;
  const scope = (issue: IntakeReviewIssue) =>
    JSON.stringify([
      issue.kind === 'identity' && (!issue.field || issue.field === 'subject')
        ? 'subject'
        : dateField(issue),
      issue.memberId || '',
    ]);
  const groups = new Map<string, IntakeReviewIssue[]>();
  for (const issue of effective) {
    let key = issue.id;
    if (
      (issue.kind === 'date' && issue.field) ||
      (issue.kind === 'identity' && (!issue.field || issue.field === 'subject'))
    ) {
      const peers = effective.filter(
        (peer) => peer.kind === issue.kind && scope(peer) === scope(issue),
      );
      const pages = [...new Set(peers.flatMap((peer) => (peer.page ? [peer.page] : [])))];
      const page = issue.page || (pages.length === 1 ? pages[0] : null);
      key = JSON.stringify([issue.kind, scope(issue), page]);
    }
    const group = groups.get(key) || [];
    group.push(issue);
    groups.set(key, group);
  }
  const richness = (issue: IntakeReviewIssue) =>
    (issue.choices?.length || 0) * 100 +
    (issue.textAnchor ? 10 : 0) +
    (issue.questionId ? 1 : 0) +
    Math.min(issue.prompt.length, 1000) / 10000;
  return [...groups.values()].map((issues) => {
    const pending = issues.filter((issue) => issue.status !== 'resolved' && !issue.resolution);
    const ranked = [...issues].sort((a, b) => richness(b) - richness(a));
    const primary = ranked[0];
    const choices = [...issues]
      .sort((a, b) => richness(b) - richness(a))
      .flatMap((issue) => issue.choices || [])
      .filter(
        (choice, index, all) => all.findIndex((item) => item.value === choice.value) === index,
      );
    return {
      issue: {
        ...primary,
        status: pending.length ? 'unresolved' : 'resolved',
        resolution: pending.length ? undefined : primary.resolution,
        ...(choices.length ? { choices } : {}),
      },
      issues,
    };
  });
}

export function reviewRecordTitle(record: IntakeReviewRecord, mapping = record.mapping): string {
  const candidates = [record.title, mapping.documentTitle, mapping.label];
  return (
    candidates
      .find((title) => {
        const text = title?.trim();
        return text && !/(?:^|[:/\\])[a-f0-9]{32,}(?=$|[:/\\.])/i.test(text);
      })
      ?.trim() || (record.kind === 'document' ? 'Document' : 'Record')
  );
}

export function ReviewIssue({
  issue,
  mapping,
  resolution,
  busy,
  onResolve,
  onLater,
  onUseSource,
  relatedIssues = [],
}: {
  issue: IntakeReviewIssue;
  relatedIssues?: IntakeReviewIssue[];
  mapping: IntakeClinicalMapping;
  resolution?: IntakeIssueResolution;
  busy: boolean;
  onResolve: (resolution: IntakeIssueResolution) => void;
  onLater: () => void;
  onUseSource?: (source: string) => void;
}) {
  const key = issue.field as keyof IntakeClinicalMapping | null;
  const [value, setValue] = useState(String(key ? (mapping[key] ?? '') : ''));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setValue(String(key ? (mapping[key] ?? '') : ''));
  }, [mapping, key, editing]);
  const outcome = resolution?.outcome || issue.resolution?.outcome;
  const resolved = !!outcome || issue.status === 'resolved';
  const savedLabel =
    outcome === 'unknown'
      ? issue.kind === 'date'
        ? 'left unconfirmed'
        : 'left uncertain'
      : (outcome || 'confirmed').replaceAll('_', ' ');
  const isDocumentDate =
    mapping.kind === 'document' && ['date', 'documentDate'].includes(key || '');
  const resolve = (
    outcome: IntakeIssueResolution['outcome'],
    patch?: Partial<IntakeClinicalMapping>,
  ) => {
    const mapping = patch ? { ...patch } : undefined;
    // Both DTO fields can describe one document date. Keep grouped aliases consistent.
    if (issue.kind === 'date' && mapping && key && key in mapping) {
      if (isDocumentDate) {
        mapping.date = String(mapping[key] ?? '');
        mapping.documentDate = String(mapping[key] ?? '');
      }
      for (const related of relatedIssues) {
        if (['date', 'documentDate'].includes(related.field || '')) {
          mapping[related.field as 'date' | 'documentDate'] = String(mapping[key] ?? '');
        }
      }
    }
    onResolve({ issueId: issue.id, outcome, ...(mapping ? { mapping } : {}) });
  };
  return (
    <details
      id={`issue-${issue.id}`}
      className={`intake-issue ${resolved ? 'is-resolved' : ''}`}
      open={issue.kind !== 'information' && !resolved}
    >
      <summary>
        {issue.kind === 'information' ? 'ⓘ ' : resolved && outcome !== 'unknown' ? '✓ ' : ''}
        {issue.prompt}
        {resolved && <span className="intake-issue-saved">Saved: {savedLabel}</span>}
      </summary>
      {relatedIssues
        .filter((item) => item.id !== issue.id)
        .map((item) => (
          <span key={item.id} id={`issue-${item.id}`} />
        ))}
      <p className="helper-text">
        {issue.locator}
        {issue.page ? ` · Page ${issue.page}` : ''}
      </p>
      {issue.sourceSuggestion && (
        <p>
          Suggested source: {issue.sourceSuggestion}{' '}
          {onUseSource && (
            <button
              className="text-link"
              disabled={busy}
              onClick={() => onUseSource(issue.sourceSuggestion!)}
            >
              Review suggested source
            </button>
          )}
        </p>
      )}
      {relatedIssues.length > 1 && (
        <details className="intake-issue-history">
          <summary>{relatedIssues.length} related questions</summary>
          <ul>
            {relatedIssues.map((item) => (
              <li key={item.id}>
                {item.prompt}
                {item.resolution ? ` · Saved: ${item.resolution.outcome.replaceAll('_', ' ')}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      {resolved ? (
        <p>Saved: {savedLabel}</p>
      ) : (
        <div className="intake-issue-actions">
          {issue.kind === 'identity' ? (
            <>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => resolve('this_is_me', { subject: 'self' })}
              >
                This is me
              </button>
              <button className="text-link" disabled={busy} onClick={onLater}>
                Review later
              </button>
            </>
          ) : issue.kind === 'information' ? (
            <p>No action needed.</p>
          ) : (
            <>
              {issue.kind === 'date' &&
                issue.choices?.map((choice) => (
                  <button
                    key={choice.value}
                    className="button secondary"
                    disabled={busy || !key}
                    onClick={() => resolve('corrected', key ? { [key]: choice.value } : undefined)}
                  >
                    {choice.label}
                  </button>
                ))}
              <button
                className="button secondary"
                disabled={busy || (issue.kind === 'date' && !value)}
                onClick={() => resolve('confirmed', key && value ? { [key]: value } : undefined)}
              >
                {issue.kind === 'date' ? `Use ${value || 'this date'}` : 'Confirm reading'}
              </button>
              <button className="text-link" disabled={busy} onClick={() => setEditing(!editing)}>
                {issue.kind === 'date' ? 'Choose a date' : 'Edit reading'}
              </button>
              <button
                className="text-link"
                disabled={busy}
                onClick={() =>
                  resolve(
                    'unknown',
                    issue.kind === 'date' && key
                      ? {
                          ...(!relatedIssues.length ? { date: '', documentDate: '' } : {}),
                          [key]: '',
                          ...(relatedIssues.some((item) => item.field === 'date')
                            ? { date: '' }
                            : {}),
                          ...(relatedIssues.some((item) => item.field === 'documentDate')
                            ? { documentDate: '' }
                            : {}),
                        }
                      : undefined,
                  )
                }
              >
                {issue.kind === 'date' ? 'Keep unconfirmed' : 'Leave uncertain'}
              </button>
              {editing && key && (
                <label>
                  {issue.kind === 'date' ? 'Confirmed date' : 'Corrected reading'}
                  <input
                    value={value}
                    placeholder={issue.kind === 'date' ? 'YYYY-MM-DD' : undefined}
                    onChange={(event) => setValue(event.target.value)}
                  />
                  <button
                    className="button secondary"
                    disabled={busy || !value.trim()}
                    onClick={() => {
                      resolve('corrected', { [key]: value });
                      setEditing(false);
                    }}
                  >
                    Save correction
                  </button>
                </label>
              )}
            </>
          )}
        </div>
      )}
    </details>
  );
}

function NavigationGuard({
  pending,
  flush,
  anyLocationChange,
}: {
  pending: () => boolean;
  flush: () => Promise<boolean>;
  anyLocationChange?: boolean;
}) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      pending() &&
      ((anyLocationChange &&
        (currentLocation.search !== nextLocation.search ||
          currentLocation.hash !== nextLocation.hash)) ||
        currentLocation.pathname !== nextLocation.pathname ||
        new URLSearchParams(nextLocation.search).get('view') !== 'import'),
  );
  const latest = useRef(flush);
  latest.current = flush;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    let cancelled = false;
    void latest.current().then((saved) => {
      if (cancelled) return;
      if (saved) blocker.proceed();
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [blocker.state]);
  if (blocker.state !== 'blocked') return null;
  return (
    <div className="intake-notice" role="status">
      {failed
        ? 'Your review draft could not save. Stay here to retry before leaving.'
        : 'Saving your review before leaving…'}
      {failed && (
        <button
          className="text-link"
          onClick={() => {
            setFailed(false);
            blocker.reset();
          }}
        >
          Keep reviewing
        </button>
      )}
    </div>
  );
}
export function ReviewNavigationGuard(props: {
  anyLocationChange?: boolean;
  pending: () => boolean;
  flush: () => Promise<boolean>;
}) {
  const router = useContext(UNSAFE_DataRouterContext);
  return router ? <NavigationGuard {...props} /> : null;
}

// Read only the narrative string; retain the complete literal mapping as evidence.
function readablePassage(text: string | undefined): string {
  if (!text) return '';
  try {
    const payload: unknown = JSON.parse(text);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const fields = payload as Record<string, unknown>;
      if (typeof fields.text === 'string') return fields.text;
      if (typeof fields.transcription === 'string') return fields.transcription;
    }
  } catch {
    // Plain extracted text is already readable.
  }
  return text;
}

export function RecordText({
  record,
  mapping,
}: {
  record: IntakeReviewRecord;
  mapping: IntakeClinicalMapping;
}) {
  const [mode, setMode] = useState<'summary' | 'text'>(
    (mapping.kind || record.kind) === 'document' && mapping.text ? 'text' : 'summary',
  );
  const passage = readablePassage(mapping.text);
  const id = useId();
  return (
    <section className="intake-record-reading" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      <div
        className="intake-reading-tabs"
        role="tablist"
        aria-label={`Reading for ${reviewRecordTitle(record, mapping)}`}
      >
        {(['summary', 'text'] as const).map((value) => (
          <button
            key={value}
            id={`${id}-${value}-tab`}
            role="tab"
            aria-selected={mode === value}
            aria-controls={`${id}-${value}`}
            tabIndex={mode === value ? 0 : -1}
            onClick={() => setMode(value)}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 'summary'
                    : event.key === 'End'
                      ? 'text'
                      : mode === 'summary'
                        ? 'text'
                        : 'summary';
                setMode(next);
                document.getElementById(`${id}-${next}-tab`)?.focus();
              }
            }}
          >
            {value === 'summary' ? 'Summary' : 'Extracted text'}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-${mode}`} aria-labelledby={`${id}-${mode}-tab`}>
        {mode === 'summary' ? (
          <p>
            {[
              record.kind === 'document'
                ? reviewRecordTitle(record, mapping)
                : mapping.testLabel ||
                  mapping.medicationName ||
                  mapping.procedureLabel ||
                  mapping.documentTitle ||
                  reviewRecordTitle(record, mapping),
              mapping.valueText,
              mapping.unit,
              mapping.doseText,
              mapping.frequency,
              mapping.date === '' ? 'Date unconfirmed' : mapping.date || record.date,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        ) : mapping.text ? (
          <ExactIssueText text={passage} issues={record.issues || []} />
        ) : (
          <p className="helper-text">
            No extracted passage was supplied for this record. Check the original and the fields
            below.
          </p>
        )}
      </div>
    </section>
  );
}
