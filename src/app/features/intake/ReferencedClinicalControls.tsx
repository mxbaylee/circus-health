import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  IntakeClinicalMapping,
  IntakeIssueResolution,
  IntakePairDecision,
  IntakeEvidenceComparison,
  IntakeReviewRecord,
} from '../../../shared/intake';
import type {
  IntakeClinicalRecordRead,
  IntakeClinicalReviewContext,
} from '../../../shared/intake-clinical-review';
import type {
  ClinicalRecordAction,
  ClinicalRecordSection,
  ClinicalRecordSectionControl,
  ClinicalRecordSectionPage,
} from '../../../shared/intake-clinical-record-sections';
import type { OpticalPrescription } from '../../../shared/vision';
import { api, ApiError } from '../../data/api';
import { useProfile } from '../../data/profile';
import { ClinicalEvidenceWindow } from './ClinicalReviewPages';
import { ReviewNavigationGuard } from './ReviewWorkspace';
import { QuestionAnswerHistory } from './QuestionAnswerHistory';
import { OpticalPrescriptionEditor } from '../../components/OpticalPrescriptionEditor';
import { mappingFields } from '../import/import-correction-fields';
import { SavedDuplicateEvidence } from '../clinical-review/SavedDuplicateEvidence';
import type { SavedDuplicateEvidenceReference } from '../../../shared/saved-duplicate-evidence';
import { ClinicalEvidencePair } from '../clinical-review/ClinicalEvidencePair';

type IncomingEvidence = Pick<IntakeReviewRecord, 'title' | 'date' | 'mapping' | 'evidence'>;

type ReferenceRecord = Extract<IntakeClinicalRecordRead['record'], { kind: 'reference' }>;
type Item = ClinicalRecordSectionPage['items'][number];
type Change = Pick<ClinicalRecordAction, 'patch' | 'pair' | 'clearMissingPair'>;
const labels: Record<ClinicalRecordSection, string> = {
  issues: 'Review questions',
  questions: 'Saved source questions',
  comparisons: 'Related records',
  comparisonDrafts: 'Saved related-record choices',
  mapping: 'Clinical fields',
  reportGroups: 'Linked reports',
  ownershipBlockers: 'Person assignment requirements',
  identityWarnings: 'Record identity warnings',
};
const fieldLabel = (field: string) =>
  Object.values(mappingFields)
    .flat()
    .find((item) => item.key === field)?.label ||
  { date: 'Date', opticalPrescription: 'Optical prescription', subject: 'Person' }[field] ||
  field;
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'This review action could not complete.';

/** A section page is evidence for its exact selected record, never a partial IntakeReviewRecord. */
export function ReferencedClinicalControls({
  context,
  selection,
  initialSection = 'issues',
  sections,
  triggerLabel = 'Resolve questions or correct this record',
  disabled = false,
  guardNavigation = true,
  externalPending = false,
  onRefresh,
  onPending,
  onCorrectSaved,
  initiallyOpen = false,
  incoming,
  incomingContent,
}: {
  context: IntakeClinicalReviewContext;
  selection: ReferenceRecord['selection'];
  initialSection?: ClinicalRecordSection;
  sections?: ClinicalRecordSection[];
  triggerLabel?: string;
  disabled?: boolean;
  guardNavigation?: boolean;
  externalPending?: boolean;
  onRefresh: () => void;
  onPending: (pending: boolean) => void;
  onCorrectSaved?: (comparison: IntakeEvidenceComparison) => void;
  initiallyOpen?: boolean;
  incoming?: IncomingEvidence;
  incomingContent?: ReactNode;
}) {
  const profile = useProfile();
  const scope = JSON.stringify([
    profile?.id,
    context.intakeId,
    context.proposalId,
    selection.recordId,
    selection.candidateVersionId,
  ]);
  const active = useRef(scope);
  active.current = scope;
  const [open, setOpen] = useState(initiallyOpen);
  const [section, setSection] = useState<ClinicalRecordSection>(initialSection);
  const [cursor, setCursor] = useState<string>();
  const [queryInput, setQueryInput] = useState('');
  const [search, setSearch] = useState<{ query: string; cursor?: string }>({ query: '' });
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<number>();
  const [pageState, setPageState] = useState<{
    key: string;
    data?: ClinicalRecordSectionPage;
    error?: string;
  }>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ClinicalRecordAction>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const key = JSON.stringify([
    scope,
    context.reviewToken,
    context.version,
    selection.selectionReviewToken,
    section,
    cursor,
    search,
    revision,
  ]);
  const held = dirty || busy || !!pending;
  const pendingCallback = useRef(onPending);
  pendingCallback.current = onPending;
  useEffect(() => {
    pendingCallback.current(held);
  }, [held]);
  useEffect(() => () => pendingCallback.current(false), []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!held) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [held]);
  useEffect(() => {
    setDirty(false);
    setBusy(false);
    setPending(undefined);
    setError('');
    setNotice('');
    setStale(false);
    setCursor(undefined);
    setSelected(undefined);
    return () => {
      active.current = '';
    };
  }, [scope]);
  useEffect(() => {
    if (!open || held) return;
    const request = new AbortController();
    setPageState({ key });
    void api<ClinicalRecordSectionPage>(
      `/intakes/${encodeURIComponent(context.intakeId)}/review-record-section`,
      {
        method: 'POST',
        signal: request.signal,
        body: JSON.stringify({
          proposalId: context.proposalId,
          recordId: selection.recordId,
          candidateVersionId: selection.candidateVersionId,
          section,
          cursor,
          limit: 20,
          bytes: 65536,
          ...(section === 'comparisons' ? { comparisonSearch: { ...search, limit: 20 } } : {}),
        }),
      },
    )
      .then(({ data }) => {
        if (request.signal.aborted) return;
        if (
          data.format !== 'health-clinical-record-section-page-v1' ||
          data.context.intakeId !== context.intakeId ||
          data.context.proposalId !== context.proposalId ||
          data.context.reviewToken !== context.reviewToken ||
          data.context.version !== context.version ||
          data.selection.recordId !== selection.recordId ||
          data.selection.candidateVersionId !== selection.candidateVersionId ||
          data.selection.proposalId !== context.proposalId ||
          data.selection.selectionReviewToken !== selection.selectionReviewToken ||
          data.section !== section ||
          (data.discoveryPage &&
            (data.discoveryPage.query !== search.query.trim() ||
              data.discoveryPage.returned !== data.total ||
              data.discoveryPage.hasMore !== (data.discoveryPage.nextCursor !== null) ||
              (data.discoveryPage.nextCursor !== null &&
                data.discoveryPage.nextCursor === search.cursor))) ||
          !Number.isSafeInteger(data.total) ||
          data.total < 0 ||
          data.items.length > 20 ||
          data.items.length > data.total ||
          (data.nextCursor !== null &&
            (!data.nextCursor || data.nextCursor === cursor || !data.items.length)) ||
          data.items.some(
            (item, index) =>
              item.control.kind !==
                (section === 'issues'
                  ? 'issue'
                  : section === 'questions'
                    ? 'question'
                    : section === 'mapping'
                      ? 'mapping'
                      : section === 'reportGroups'
                        ? 'reportGroup'
                        : section === 'ownershipBlockers'
                          ? 'ownershipBlocker'
                          : section === 'identityWarnings'
                            ? 'identityWarning'
                            : 'pair') ||
              !Number.isSafeInteger(item.ordinal) ||
              item.ordinal < 0 ||
              item.ordinal >= data.total ||
              (index > 0 && item.ordinal !== data.items[index - 1]!.ordinal + 1) ||
              (item.detail.kind === 'reference' &&
                (item.detail.reference.reviewToken !== context.reviewToken ||
                  item.detail.reference.recordId !== selection.recordId ||
                  item.detail.reference.candidateVersionId !== selection.candidateVersionId ||
                  item.detail.reference.proposalId !== context.proposalId ||
                  item.detail.reference.section !== section ||
                  item.detail.reference.ordinal !== item.ordinal)),
          ) ||
          (!cursor && data.items.length > 0 && data.items[0]!.ordinal !== 0) ||
          (data.nextCursor === null && (data.items.at(-1)?.ordinal ?? -1) + 1 !== data.total)
        )
          throw new Error(
            'These controls no longer match the exact record. Refresh the review before making a choice.',
          );
        setPageState({ key, data });
        if (
          (incoming || incomingContent) &&
          (section === 'comparisons' || section === 'comparisonDrafts')
        )
          setSelected((current) =>
            data.items.some((item) => item.ordinal === current) ? current : data.items[0]?.ordinal,
          );
        // A successful write/409 holds controls until this exact server read
        // validates the current authority. Merely receiving new props is not
        // enough, and unresolved writes keep this effect paused.
        setStale(false);
        setNotice('');
      })
      .catch((cause) => {
        if (!request.signal.aborted) setPageState({ key, error: message(cause) });
      });
    return () => request.abort();
  }, [key, open, held]);
  const page = pageState?.key === key || held ? pageState : undefined;
  const authorityChanged =
    !!page?.data &&
    (page.data.context.reviewToken !== context.reviewToken ||
      page.data.context.version !== context.version ||
      page.data.selection.selectionReviewToken !== selection.selectionReviewToken);
  const item = page?.data?.items.find((value) => value.ordinal === selected);
  async function send(command: ClinicalRecordAction) {
    if (busy || active.current !== scope) return;
    setBusy(true);
    setPending(command);
    setError('');
    setNotice('');
    try {
      await api(`/intakes/${encodeURIComponent(context.intakeId)}/review-record-action`, {
        method: 'POST',
        operationId: command.operationId,
        body: JSON.stringify(command),
      });
      if (active.current !== scope) return;
      setPending(undefined);
      setDirty(false);
      setStale(true);
      setNotice(
        'Your choice was saved. Refreshing the exact review and its remaining requirements…',
      );
      pendingCallback.current(false);
      onRefresh();
    } catch (cause) {
      if (active.current !== scope) return;
      if (
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        ![408, 429].includes(cause.status)
      ) {
        setPending(undefined);
        if (cause.status === 409) setStale(true);
        setError(message(cause));
      } else
        setError(
          `${message(cause)} The save outcome is not confirmed. Retry this exact choice before leaving.`,
        );
    } finally {
      if (active.current === scope) setBusy(false);
    }
  }
  const save = (change: Change) => {
    if (
      !page?.data ||
      authorityChanged ||
      disabled ||
      busy ||
      pending ||
      stale ||
      !selection.candidateVersionId
    )
      return;
    void send({
      proposalId: context.proposalId,
      recordId: selection.recordId,
      candidateVersionId: selection.candidateVersionId,
      version: context.version,
      reviewToken: context.reviewToken,
      operationId: crypto.randomUUID(),
      ...change,
    });
  };
  const refresh = () => {
    if (held) return;
    setSelected(undefined);
    setCursor(undefined);
    onRefresh();
    setRevision((value) => value + 1);
  };
  return (
    <section aria-label="Exact record controls" className="intake-processing-details">
      {guardNavigation && (
        <ReviewNavigationGuard
          anyLocationChange
          pending={() => held || externalPending}
          flush={async () => !held && !externalPending}
        />
      )}
      <button
        type="button"
        className="button secondary"
        disabled={held || disabled}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide record controls' : triggerLabel}
      </button>
      {open && (
        <>
          <p>
            Review one question, relationship or field at a time. Other saved choices remain
            retained.
          </p>
          <label>
            Review section
            <select
              value={section}
              disabled={held}
              onChange={(event) => {
                setSection(event.target.value as ClinicalRecordSection);
                setCursor(undefined);
                setSelected(undefined);
                setError('');
              }}
            >
              {Object.entries(labels)
                .filter(([value]) => !sections || sections.includes(value as ClinicalRecordSection))
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {pending && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void send(pending)}
            >
              Retry exact review choice
            </button>
          )}
          {dirty && !pending && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setDirty(false);
                setSelected(undefined);
                setError('');
                setRevision((value) => value + 1);
              }}
            >
              Discard unsaved edit
            </button>
          )}
          {(stale || authorityChanged) && (
            <p role="status">
              Read the refreshed review before making another choice.
              <button type="button" className="button secondary" disabled={held} onClick={refresh}>
                Refresh exact record controls
              </button>
            </p>
          )}
          {page?.error ? (
            <p role="alert">
              {page.error}
              <button type="button" disabled={held} onClick={refresh}>
                Refresh exact record controls
              </button>
            </p>
          ) : !page?.data ? (
            <p role="status">Opening exact record controls…</p>
          ) : (
            <>
              <p>
                {page.data.total.toLocaleString()} {labels[section].toLowerCase()}{' '}
                {page.data.discoveryPage
                  ? 'in this search result window.'
                  : 'in this complete record.'}
              </p>
              {section === 'comparisons' && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (held || disabled) return;
                    setSearch({ query: queryInput.trim() });
                    setCursor(undefined);
                    setSelected(undefined);
                  }}
                >
                  <label>
                    Search related saved records
                    <input
                      value={queryInput}
                      disabled={held || disabled}
                      onChange={(event) => setQueryInput(event.target.value)}
                    />
                  </label>
                  <button type="submit" className="button secondary" disabled={held || disabled}>
                    Search related records
                  </button>
                </form>
              )}
              {page.data.discoveryPage?.truncated && (
                <p>
                  More records matched than this search can show. Refine the search to find the
                  record you need.
                </p>
              )}
              <div aria-label="Record section entries">
                {page.data.items.map((entry) => (
                  <button
                    type="button"
                    className="button secondary"
                    key={entry.ordinal}
                    disabled={held || stale || disabled}
                    aria-pressed={selected === entry.ordinal}
                    onClick={() => setSelected(entry.ordinal)}
                  >
                    {entry.control.kind === 'issue'
                      ? `Question ${entry.ordinal + 1}${entry.control.blocking ? ' · required' : ''}`
                      : entry.control.kind === 'question'
                        ? `Source question ${entry.ordinal + 1}`
                        : entry.control.kind === 'pair'
                          ? `Related record ${entry.ordinal + 1}`
                          : entry.control.kind === 'ownershipBlocker'
                            ? `Person requirement ${entry.ordinal + 1}`
                            : entry.control.kind === 'identityWarning'
                              ? `Identity warning ${entry.ordinal + 1}`
                              : entry.control.kind === 'reportGroup'
                                ? `Linked report ${entry.ordinal + 1}`
                                : fieldLabel(entry.control.field)}
                  </button>
                ))}
              </div>
              {item && (
                <SelectedControl
                  key={`${pageState!.key}:${item.ordinal}`}
                  item={item}
                  intakeId={context.intakeId}
                  disabled={
                    disabled ||
                    busy ||
                    !!pending ||
                    stale ||
                    authorityChanged ||
                    !!context.sourceTextStale
                  }
                  onDirty={() => setDirty(true)}
                  onSave={save}
                  onRefresh={refresh}
                  onCorrectSaved={!dirty ? onCorrectSaved : undefined}
                  incoming={incoming}
                  incomingContent={incomingContent}
                />
              )}
              {page.data.nextCursor && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={held || stale || disabled}
                  onClick={() => {
                    setSelected(undefined);
                    setCursor(page.data!.nextCursor!);
                  }}
                >
                  Next record section page
                </button>
              )}
              {cursor && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={held || stale || disabled}
                  onClick={() => {
                    setSelected(undefined);
                    setCursor(undefined);
                  }}
                >
                  First record section page
                </button>
              )}
              {!page.data.nextCursor && page.data.discoveryPage?.nextCursor && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={held || stale || disabled}
                  onClick={() => {
                    setSearch({ ...search, cursor: page.data!.discoveryPage!.nextCursor! });
                    setCursor(undefined);
                    setSelected(undefined);
                  }}
                >
                  Next related search results
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function SelectedControl({
  item,
  intakeId,
  disabled,
  onDirty,
  onSave,
  onRefresh,
  onCorrectSaved,
  incoming,
  incomingContent,
}: {
  item: Item;
  intakeId: string;
  disabled: boolean;
  onDirty: () => void;
  onSave: (change: Change) => void;
  onRefresh: () => void;
  onCorrectSaved?: (comparison: IntakeEvidenceComparison) => void;
  incoming?: IncomingEvidence;
  incomingContent?: ReactNode;
}) {
  const [inspected, setInspected] = useState(item.detail.kind === 'value');
  const blocked = disabled || !inspected;
  const comparison =
    item.control.kind === 'pair' &&
    item.detail.kind === 'value' &&
    item.detail.value &&
    typeof item.detail.value === 'object' &&
    'comparison' in item.detail.value
      ? (item.detail.value.comparison as IntakeEvidenceComparison | null)
      : null;
  const savedEvidence:
    IntakeEvidenceComparison['evidence'] | SavedDuplicateEvidenceReference | undefined =
    item.control.kind === 'pair' ? item.control.savedEvidence || comparison?.evidence : undefined;
  const paired = item.control.kind === 'pair' && (incoming || incomingContent);
  const detail =
    item.detail.kind === 'value' ? (
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {JSON.stringify(item.detail.value, null, 2)}
      </pre>
    ) : (
      <ClinicalEvidenceWindow
        endpoint={`/intakes/${encodeURIComponent(intakeId)}/review-record-section-fragment`}
        reference={item.detail.reference}
        onRefresh={onRefresh}
        onInspected={setInspected}
      />
    );
  const content = (
    <>
      {paired ? (
        <ClinicalEvidencePair
          {...(incoming ? { incoming } : { incomingContent })}
          {...(comparison
            ? { saved: comparison, onCorrectSaved }
            : {
                savedContent: (
                  <>
                    {detail}
                    {savedEvidence && !Array.isArray(savedEvidence) && (
                      <SavedDuplicateEvidence reference={savedEvidence} />
                    )}
                  </>
                ),
              })}
          disabled={blocked}
        />
      ) : (
        detail
      )}
      {!inspected && <p>Read every page of this selected evidence before choosing an outcome.</p>}
      {paired && comparison?.previousDecision && (
        <p>
          Saved decision:{' '}
          {
            {
              distinct: 'Separate measurement',
              same_event: 'Another source for the same measurement',
              changed_version: 'Different version — keep both records',
              unresolved: 'Not sure yet',
            }[comparison.previousDecision.outcome]
          }
          . {comparison.previousDecision.reason}
          {comparison.previousDecision.scopeStatus !== 'current' &&
            ' The displayed record version has changed, so review this pair again.'}
        </p>
      )}
      {item.control.kind === 'issue' && (
        <QuestionAnswerHistory
          intakeId={intakeId}
          history={item.control.questionAnswerHistory}
          onRefresh={onRefresh}
        />
      )}
      {!paired && savedEvidence && !Array.isArray(savedEvidence) && (
        <SavedDuplicateEvidence reference={savedEvidence} />
      )}
      {!paired && comparison && onCorrectSaved && (
        <button
          type="button"
          className="button secondary"
          disabled={blocked}
          onClick={() => onCorrectSaved(comparison)}
        >
          Correct this saved record
        </button>
      )}
      {item.control.kind === 'issue' ? (
        <IssueControl control={item.control} disabled={blocked} onDirty={onDirty} onSave={onSave} />
      ) : item.control.kind === 'pair' ? (
        <PairControl control={item.control} disabled={blocked} onDirty={onDirty} onSave={onSave} />
      ) : item.control.kind === 'question' ? (
        <>
          <QuestionControl
            control={item.control}
            disabled={blocked}
            onDirty={onDirty}
            onSave={onSave}
          />
          <QuestionAnswerHistory
            intakeId={intakeId}
            history={item.control.answerHistory}
            onRefresh={onRefresh}
          />
        </>
      ) : item.control.kind === 'mapping' ? (
        <MappingControl
          control={item.control}
          detail={item.detail}
          disabled={blocked}
          onDirty={onDirty}
          onSave={onSave}
        />
      ) : item.control.kind === 'identityWarning' ? (
        <p>
          This advisory warning belongs to the complete identity review for this exact record.
          Reading it does not change person assignment or accept the record.
        </p>
      ) : item.control.kind === 'ownershipBlocker' ? (
        <p>
          Resolve this requirement in the person review for this report. Reading it does not confirm
          a person or accept clinical records.
        </p>
      ) : (
        <p>
          This retained report link belongs to the selected record. Group: {item.control.groupId};
          version: {item.control.groupVersionId}.
        </p>
      )}
    </>
  );
  return (
    <article aria-label="Selected record question or field">
      {paired ? (
        <details>
          <summary>
            {comparison
              ? `${comparison.title} · ${comparison.date || 'Unknown date'}`
              : 'Saved record with paged evidence'}
          </summary>
          {content}
        </details>
      ) : (
        content
      )}
    </article>
  );
}

function IssueControl({
  control,
  disabled,
  onDirty,
  onSave,
}: {
  control: Extract<ClinicalRecordSectionControl, { kind: 'issue' }>;
  disabled: boolean;
  onDirty: () => void;
  onSave: (change: Change) => void;
}) {
  const [value, setValue] = useState(control.fieldValue || '');
  const [reason, setReason] = useState('');
  const [edited, setEdited] = useState(false);
  const fields = control.resolutionFields.length
    ? control.resolutionFields
    : control.field
      ? [control.field as keyof IntakeClinicalMapping]
      : [];
  const resolve = (
    outcome: IntakeIssueResolution['outcome'],
    correction?: Partial<IntakeClinicalMapping>,
  ) =>
    onSave({
      patch: {
        resolutions: [
          { issueId: control.id, outcome, ...(correction ? { mapping: correction } : {}) },
        ],
        ...(correction
          ? { mapping: correction, correctionReason: reason, correctionPatch: correction }
          : {}),
      },
    });
  return (
    <fieldset disabled={disabled}>
      <legend>{control.field ? fieldLabel(control.field) : 'Review question'}</legend>
      {control.outcome && <p>Saved choice: {control.outcome.replaceAll('_', ' ')}</p>}
      {control.issueKind === 'identity' ? (
        <p>Use the source identity review above to confirm whose record this is.</p>
      ) : control.issueKind === 'information' ? (
        <button type="button" className="button secondary" onClick={() => resolve('acknowledged')}>
          Acknowledge this information
        </button>
      ) : (
        <>
          <button
            type="button"
            className="button secondary"
            disabled={edited}
            onClick={() => resolve('confirmed')}
          >
            Confirm current reading
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={edited}
            onClick={() => resolve('unknown')}
          >
            {control.issueKind === 'date' ? 'Keep date unconfirmed' : 'Leave reading uncertain'}
          </button>
          {fields.length > 0 && (
            <>
              {control.fieldValueReferenced && (
                <p>
                  The current field is retained in the evidence pages. Enter its complete
                  replacement only if it needs correction.
                </p>
              )}
              <label>
                Corrected reading
                <textarea
                  value={value}
                  maxLength={fields.includes('text') ? 1000000 : 10000}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setEdited(true);
                    onDirty();
                  }}
                />
              </label>
              <label>
                Reason for correction
                <textarea
                  value={reason}
                  maxLength={10000}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setEdited(true);
                    onDirty();
                  }}
                />
              </label>
              <button
                type="button"
                className="button secondary"
                disabled={!reason.trim()}
                onClick={() =>
                  resolve('corrected', Object.fromEntries(fields.map((field) => [field, value])))
                }
              >
                Save corrected reading
              </button>
            </>
          )}
        </>
      )}
    </fieldset>
  );
}

function PairControl({
  control,
  disabled,
  onDirty,
  onSave,
}: {
  control: Extract<ClinicalRecordSectionControl, { kind: 'pair' }>;
  disabled: boolean;
  onDirty: () => void;
  onSave: (change: Change) => void;
}) {
  const [outcome, setOutcome] = useState<IntakePairDecision['outcome']>(
    control.outcome || 'unresolved',
  );
  const [reason, setReason] = useState(control.reason || '');
  return (
    <fieldset disabled={disabled}>
      <legend>Relationship with this record</legend>
      {control.draftScopeStatus && (
        <p>Saved evidence scope: {control.draftScopeStatus.replaceAll('_', ' ')}</p>
      )}
      {!control.targetAvailable ? (
        <>
          <p>
            The saved related record is no longer available. Remove this pending choice only after
            checking the evidence.
          </p>
          <button
            type="button"
            className="button secondary"
            onClick={() => onSave({ clearMissingPair: control.otherRecordId })}
          >
            Remove unavailable pending choice
          </button>
        </>
      ) : (
        <>
          {control.reasonReferenced && (
            <p>
              The full earlier explanation is retained in the evidence pages. Enter your explanation
              for this new choice.
            </p>
          )}
          <label>
            Relationship
            <select
              value={outcome}
              onChange={(event) => {
                setOutcome(event.target.value as IntakePairDecision['outcome']);
                onDirty();
              }}
            >
              <option value="distinct">Separate measurement or event</option>
              <option value="same_event">Another source for the same event</option>
              <option value="changed_version">Different version, keep both</option>
              <option value="unresolved">Not sure yet</option>
            </select>
          </label>
          <label>
            Reason for this relationship
            <textarea
              value={reason}
              maxLength={10000}
              onChange={(event) => {
                setReason(event.target.value);
                onDirty();
              }}
            />
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={!control.scopeToken || !reason.trim()}
            onClick={() =>
              onSave({
                pair: {
                  otherRecordId: control.otherRecordId,
                  scopeToken: control.scopeToken!,
                  outcome,
                  reason,
                  ...(outcome === 'same_event' ? { occurrenceEvidence: 'attach' as const } : {}),
                },
              })
            }
          >
            Save this relationship
          </button>
        </>
      )}
    </fieldset>
  );
}

function MappingControl({
  control,
  detail,
  disabled,
  onDirty,
  onSave,
}: {
  control: Extract<ClinicalRecordSectionControl, { kind: 'mapping' }>;
  detail: Item['detail'];
  disabled: boolean;
  onDirty: () => void;
  onSave: (change: Change) => void;
}) {
  const initial = detail.kind === 'value' ? detail.value : undefined;
  const [value, setValue] = useState(typeof initial === 'string' ? initial : '');
  const [optical, setOptical] = useState<OpticalPrescription | null>(
    control.field === 'opticalPrescription' && initial && typeof initial === 'object'
      ? (initial as OpticalPrescription)
      : null,
  );
  const [changed, setChanged] = useState(false);
  const [reason, setReason] = useState('');
  if (!control.editable)
    return (
      <p>This retained field is reviewed through its dedicated source or identity controls.</p>
    );
  return (
    <fieldset disabled={disabled}>
      <legend>Correct {fieldLabel(control.field).toLowerCase()}</legend>
      {!control.present && <p>This field has no retained value yet.</p>}
      {detail.kind === 'reference' && (
        <p>
          The complete current value is retained in the evidence pages. An edit replaces this field
          only.
        </p>
      )}
      {control.field === 'opticalPrescription' && optical ? (
        <OpticalPrescriptionEditor
          prescription={optical}
          disabled={disabled}
          onChange={(next) => {
            setOptical(next);
            setChanged(true);
            onDirty();
          }}
        />
      ) : control.field === 'opticalPrescription' ? (
        <>
          <p>
            To replace the prescription, enter all values exactly as written. Saving an empty
            prescription removes this field.
          </p>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setOptical({ type: 'unknown', eyes: [] });
              setChanged(true);
              onDirty();
            }}
          >
            Enter replacement optical prescription
          </button>
        </>
      ) : (
        <label>
          Corrected field value
          <textarea
            value={value}
            maxLength={control.field === 'text' ? 1000000 : 10000}
            onChange={(event) => {
              setValue(event.target.value);
              setChanged(true);
              onDirty();
            }}
          />
        </label>
      )}
      <button
        type="button"
        className="text-link"
        onClick={() => {
          setValue('');
          setOptical(null);
          setChanged(true);
          onDirty();
        }}
      >
        Clear this field
      </button>
      <label>
        Reason for field correction
        <textarea
          value={reason}
          maxLength={10000}
          onChange={(event) => {
            setReason(event.target.value);
            onDirty();
          }}
        />
      </label>
      <button
        type="button"
        className="button secondary"
        disabled={!changed || !reason.trim()}
        onClick={() => {
          const patch = {
            [control.field]: control.field === 'opticalPrescription' ? optical : value,
          };
          onSave({ patch: { mapping: patch, correctionReason: reason, correctionPatch: patch } });
        }}
      >
        Save this field correction
      </button>
    </fieldset>
  );
}

function QuestionControl({
  control,
  disabled,
  onDirty,
  onSave,
}: {
  control: Extract<ClinicalRecordSectionControl, { kind: 'question' }>;
  disabled: boolean;
  onDirty: () => void;
  onSave: (change: Change) => void;
}) {
  const [answer, setAnswer] = useState('');
  return (
    <fieldset disabled={disabled || control.status !== 'unanswered'}>
      <legend>Answer this source question</legend>
      {control.answer !== undefined && <p>Latest saved answer: {control.answer}</p>}
      {control.answerReferenced && (
        <p>The latest saved answer is included in the complete selected evidence above.</p>
      )}
      {control.status !== 'unanswered' ? (
        <p>Answer saved; clinical acceptance remains separate.</p>
      ) : (
        <>
          <label>
            Answer
            <textarea
              value={answer}
              maxLength={10000}
              onChange={(event) => {
                setAnswer(event.target.value);
                onDirty();
              }}
            />
          </label>
          <button
            className="button secondary"
            type="button"
            disabled={!answer.trim()}
            onClick={() => onSave({ patch: { answers: { [control.id]: answer } } })}
          >
            Save answer
          </button>
        </>
      )}
    </fieldset>
  );
}
