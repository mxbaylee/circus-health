import { ImportPersonChoice } from '../import/ImportPersonChoice';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../data/api';
import { useProfile } from '../../data/profile';
import { NoteDialog } from '../notes/NoteDialog';
import { linkHref } from '../notes/NoteLinks';
import { fieldsByKind } from './RecordCorrectionDialog';
import type { IntakeClinicalMapping } from '../../../shared/intake';
import type { IntakeIdentityPerson } from '../../../shared/intake-identity';
import type {
  OwnershipSelection,
  OwnershipRequest,
  OwnershipPreview,
  OwnershipCommit,
  OwnershipReceipt,
} from '../../../shared/record-ownership';

export function RecordOwnershipAction({
  selection,
  onApplied,
  label = 'Change person',
  initialDestinationNoteId,
  previewOnOpen = false,
}: {
  selection: OwnershipSelection;
  onApplied?: () => void | Promise<void>;
  label?: string;
  initialDestinationNoteId?: string;
  previewOnOpen?: boolean;
}) {
  const profile = useProfile();
  const dialogId = useId();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [reviewSelection, setReviewSelection] = useState(selection);
  const [people, setPeople] = useState<IntakeIdentityPerson[]>([]),
    [personId, setPersonId] = useState('');
  const [fullName, setFullName] = useState(''),
    [relationship, setRelationship] = useState(''),
    [reason, setReason] = useState('');
  const [preview, setPreview] = useState<OwnershipPreview | null>(null),
    [result, setResult] = useState<OwnershipReceipt | null>(null);
  const [decisions, setDecisions] = useState<OwnershipRequest['decisions']>([]),
    [names, setNames] = useState<OwnershipRequest['nameDecisions']>([]),
    [relationships, setRelationships] = useState<OwnershipRequest['relationshipDecisions']>([]);
  const [dirty, setDirty] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const commit = useRef<OwnershipCommit | null>(null);
  const prefix = `/api/profiles/${encodeURIComponent(profile?.id || '')}/record-ownership`;
  const selectionKey =
    selection.type === 'report'
      ? `report:${selection.intakeId}:${selection.groupId}`
      : `records:${selection.records
          .map((record) => `${record.kind}:${record.recordId}`)
          .sort()
          .join('|')}`;
  const routeKey =
    typeof window === 'undefined'
      ? ''
      : window.location.hash.split('?')[0] || window.location.pathname;
  const recoveryKey = `ownership-operation:${profile?.id || ''}:${routeKey}:${label}:${selectionKey}`;
  const contextKey = `${profile?.id || ''}:${dialogId}:${open}`;
  const liveContext = useRef(contextKey);
  liveContext.current = contextKey;
  const message = (e: unknown) =>
    e instanceof Error ? e.message : 'The correction could not be completed.';
  const completed = async (receipt: OwnershipReceipt, context: string) => {
    if (liveContext.current !== context) return;
    sessionStorage.removeItem(recoveryKey);
    setUncertain(false);
    setResult(receipt);
  };
  async function reconcile() {
    const context = liveContext.current;
    const id = sessionStorage.getItem(recoveryKey);
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      await completed(
        (await api<OwnershipReceipt>(`${prefix}/${encodeURIComponent(id)}`)).data,
        context,
      );
    } catch (e) {
      if (liveContext.current !== context) return;
      if (e instanceof ApiError && e.code === 'OWNERSHIP_NOT_FOUND') {
        setUncertain(false);
        sessionStorage.removeItem(recoveryKey);
        commit.current = null;
        setDirty(true);
        setError(e.message);
      } else {
        setUncertain(true);
        setError(message(e));
      }
    } finally {
      if (liveContext.current === context) setBusy(false);
    }
  }
  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy(true);
    setError('');
    setPreview(null);
    setResult(null);
    setDecisions([]);
    setNames([]);
    setRelationships([]);
    setDirty(false);
    setReviewSelection(selection);
    commit.current = null;
    api<IntakeIdentityPerson[]>(`${prefix}/people`)
      .then(({ data }) => {
        if (active) {
          setPeople(data);
          const initial = data.find((person) => person.noteId === initialDestinationNoteId);
          setPersonId(initial?.noteId || data[0]?.noteId || '');
          if (previewOnOpen && initial)
            void loadPreview(
              selection,
              { noteId: initial.noteId, expectedVersion: initial.version },
              'Review reversal of earlier person correction',
              true,
            );
        }
      })
      .catch((e) => active && setError(message(e)))
      .finally(() => active && setBusy(false));
    if (sessionStorage.getItem(recoveryKey)) {
      setUncertain(true);
      void reconcile();
    }
    return () => {
      active = false;
    };
  }, [open, prefix, initialDestinationNoteId, previewOnOpen]);
  const changed = () => {
    setDirty(true);
    commit.current = null;
  };
  const destination = () =>
    personId === 'new'
      ? { newPerson: { fullName, relationship } }
      : (() => {
          const p = people.find((p) => p.noteId === personId);
          return p ? { noteId: p.noteId, expectedVersion: p.version } : null;
        })();
  async function loadPreview(
    selectedSelection: OwnershipSelection = reviewSelection,
    selectedDestination = destination(),
    selectedReason = reason,
    clearChoices = false,
  ) {
    const context = liveContext.current;
    const dest = selectedDestination;
    if (!dest) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await api<OwnershipPreview>(`${prefix}/preview`, {
        method: 'POST',
        body: JSON.stringify({
          selection: selectedSelection,
          destination: dest,
          decisions: clearChoices ? [] : decisions,
          nameDecisions: clearChoices ? [] : names,
          relationshipDecisions: clearChoices ? [] : relationships,
          reason: selectedReason,
        }),
      });
      if (liveContext.current !== context) return;
      setPreview(data);
      setDirty(false);
      commit.current = {
        operationId: crypto.randomUUID(),
        request: data.request,
        scopeToken: data.scopeToken,
        version: data.version,
      };
    } catch (e) {
      if (liveContext.current !== context) return;
      setError(message(e));
      setDirty(true);
    } finally {
      if (liveContext.current === context) setBusy(false);
    }
  }
  async function save() {
    const context = liveContext.current;
    if (!commit.current || dirty || uncertain) return;
    setBusy(true);
    setError('');
    sessionStorage.setItem(recoveryKey, commit.current.operationId);
    try {
      await completed(
        (
          await api<OwnershipReceipt>(prefix, {
            method: 'POST',
            body: JSON.stringify(commit.current),
          })
        ).data,
        context,
      );
    } catch (e) {
      if (liveContext.current !== context) return;
      setError(message(e));
      if (e instanceof ApiError && [403, 409].includes(e.status) && e.code) {
        sessionStorage.removeItem(recoveryKey);
        commit.current = null;
        setDirty(true);
        setUncertain(false);
      } else {
        setUncertain(true);
        await reconcile();
      }
    } finally {
      if (liveContext.current === context) setBusy(false);
    }
  }
  function decide(
    recordId: string,
    patch: Partial<NonNullable<OwnershipRequest['decisions']>[number]>,
  ) {
    setDecisions((old) => [
      ...(old || []).filter((d) => d.recordId !== recordId),
      {
        recordId,
        ...(old || []).find((d) => d.recordId === recordId),
        ...patch,
      },
    ]);
    changed();
  }
  const blocked = preview?.blockers.length || preview?.records.some((r) => r.blockers.length);
  function reviewUndo(outcome: OwnershipReceipt['outcomes'][number]) {
    const previous = preview?.records.find((record) => record.recordId === outcome.recordId);
    const former = people.find((person) => person.noteId === previous?.owner.noteId);
    if (!previous || !former) return;
    const reverseSelection: OwnershipSelection =
      (outcome.action === 'link' || outcome.action === 'split') && previous.sourceReport
        ? { type: 'report', ...previous.sourceReport }
        : {
            type: 'records',
            records: [{ kind: outcome.kind, recordId: outcome.destinationRecordId }],
          };
    setReviewSelection(reverseSelection);
    setPersonId(former.noteId);
    setReason('Review reversal of earlier person correction');
    setResult(null);
    setPreview(null);
    setDecisions([]);
    setNames([]);
    setRelationships([]);
    void loadPreview(
      reverseSelection,
      { noteId: former.noteId, expectedVersion: former.version },
      'Review reversal of earlier person correction',
      true,
    );
  }
  return (
    <>
      <button
        type="button"
        className="button secondary"
        disabled={!profile || (selection.type === 'records' && !selection.records.length)}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      <NoteDialog
        open={open}
        onOpenChange={(value) => {
          if (!busy && !uncertain) setOpen(value);
        }}
        title={
          result
            ? 'Person correction saved'
            : reviewSelection.type === 'report'
              ? 'Change person for this report'
              : 'Move these saved records and all their sources'
        }
        description={
          reviewSelection.type === 'report'
            ? 'This report’s saved records, pending assignments and remembered names are reviewed together. Later records from the unchanged report use this person and still require acceptance.'
            : 'All sources of the selected saved records move together. Other records and report defaults keep their assignments.'
        }
        className="record-correction-dialog"
      >
        {error && <p role="alert">{error}</p>}
        {uncertain ? (
          <>
            <p>The save outcome is unknown. Check it before starting another correction.</p>
            <button className="button primary" disabled={busy} onClick={() => void reconcile()}>
              Check save outcome
            </button>
          </>
        ) : result ? (
          <>
            <p>
              {result.moved} saved records corrected; {result.pending} pending assignments updated.
              Originals and earlier assignments remain in history.
            </p>
            {result.outcomes.some((o) => o.kind === 'medication' && o.action !== 'unchanged') && (
              <p>
                A moved prescription starts inactive. Open the moved medication to activate it
                separately if appropriate.
              </p>
            )}
            <ul>
              {result.outcomes.map((outcome) => (
                <li key={outcome.recordId}>
                  <Link
                    to={linkHref({
                      targetType: outcome.kind,
                      targetId: outcome.destinationRecordId,
                    })}
                  >
                    View corrected {outcome.kind} and its history
                  </Link>{' '}
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => reviewUndo(outcome)}
                  >
                    Review undo
                  </button>
                </li>
              ))}
            </ul>
            {result.groups && (
              <ul>
                {result.groups.map((g, i) => (
                  <li key={g.id}>
                    Group {i + 1}:{' '}
                    {g.status === 'committed'
                      ? 'Saved'
                      : 'Not saved — select these records and review a fresh correction'}{' '}
                    {g.status === 'needs_review'
                      ? ': ' +
                        g.recordIds
                          .map((id) => preview?.records.find((r) => r.recordId === id)?.title || id)
                          .join(', ')
                      : ` (${g.recordIds.length} records)`}
                  </li>
                ))}
              </ul>
            )}
            <button
              className="button primary"
              onClick={() => {
                setOpen(false);
                if (onApplied) void onApplied();
                else window.location.reload();
              }}
            >
              Done
            </button>
          </>
        ) : (
          <>
            <fieldset disabled={busy}>
              {/* A reviewed correction may move a mistaken Self alias to a new Person
                  of that name. Its audited name effects replace ordinary Self-name vetoes.
                  See docs/import/identity-review.md#correcting-accepted-person-assignments. */}
              <ImportPersonChoice
                purpose="ownership"
                people={people.filter((p) => p.personId !== 'patient')}
                selection={
                  personId === 'new'
                    ? { newPerson: { fullName, relationship } }
                    : people.find((p) => p.noteId === personId)?.personId === 'patient'
                      ? undefined
                      : destination() || undefined
                }
                onChange={(value) => {
                  if (!value)
                    setPersonId(people.find((p) => p.personId === 'patient')?.noteId || '');
                  else if ('newPerson' in value) {
                    setPersonId('new');
                    setFullName(value.newPerson.fullName);
                    setRelationship(value.newPerson.relationship || '');
                  } else setPersonId(value.noteId);
                  setDecisions([]);
                  setNames([]);
                  setRelationships([]);
                  setPreview(null);
                  changed();
                }}
                disabled={busy}
              />
              <label>
                Reason (optional)
                <textarea
                  value={reason}
                  maxLength={4000}
                  onChange={(e) => {
                    setReason(e.target.value);
                    changed();
                  }}
                />
              </label>
              <button
                type="button"
                className="button secondary"
                disabled={personId === 'new' && !fullName.trim()}
                onClick={() => void loadPreview()}
              >
                {preview ? 'Update preview' : 'Preview correction'}
              </button>
            </fieldset>
            {preview && (
              <>
                <p>
                  {preview.commitGroups.length} independent correction{' '}
                  {preview.commitGroups.length === 1 ? 'group' : 'groups'}: {preview.records.length}{' '}
                  saved records and {preview.pending.length} pending records. Each group saves
                  atomically. If a later group fails, earlier committed groups remain saved.
                </p>
                <ul>
                  {preview.commitGroups.map((g, i) => (
                    <li key={g.id}>
                      Group {i + 1}:{' '}
                      {g.recordIds
                        .map((id) => preview.records.find((r) => r.recordId === id)?.title)
                        .join(', ')}
                      {g.pendingCount ? ' · ' + g.pendingCount + ' pending records' : ''}
                    </li>
                  ))}
                </ul>
                {!!preview.reportHolds.length && (
                  <p>
                    Earlier person defaults for {preview.reportHolds.length} reports will require
                    renewed identity review. Saved records outside this selection retain their
                    owners.
                  </p>
                )}
                <p>
                  Earlier packet inclusion is not recorded. If you shared a packet containing one of
                  these records, review the copy you sent and provide a corrected packet.
                </p>
                {preview.blockers.map((b) => (
                  <p role="alert" key={b}>
                    {b}
                  </p>
                ))}
                {preview.records.map((r) => (
                  <section key={r.kind + r.recordId} className="panel">
                    <h3>{r.title}</h3>
                    <p>
                      {r.owner.fullName} →{' '}
                      {'personId' in preview.destination
                        ? preview.destination.fullName
                        : preview.destination.newPerson.fullName}{' '}
                      ·{' '}
                      {r.action === 'split'
                        ? 'Split this report’s contribution'
                        : r.action === 'link'
                          ? 'Link to the reviewed destination record'
                          : r.action === 'unchanged'
                            ? 'Already assigned here'
                            : 'Move saved record'}
                    </p>
                    {r.medicationActivity && (
                      <p>
                        {r.medicationActivity === 'inactive'
                          ? 'The destination prescription starts inactive. Activate it separately if appropriate.'
                          : 'The existing personal activity decision stays unchanged.'}
                      </p>
                    )}
                    <ul>
                      {r.contributions.map((c) => (
                        <li key={c.sourceRecordId}>
                          <a href={c.contentUrl} target="_blank" rel="noreferrer">
                            {c.selected
                              ? 'Selected source'
                              : 'Source staying with ' + r.owner.fullName}
                          </a>{' '}
                          — {typeof c.locator === 'string' ? c.locator : JSON.stringify(c.locator)}
                        </li>
                      ))}
                    </ul>
                    {reviewSelection.type === 'records' && r.sourceReport && (
                      <p>
                        <Link
                          to={`/import?${new URLSearchParams({ intake: r.sourceReport.intakeId, group: r.sourceReport.groupId })}`}
                        >
                          Open the report to correct only that report’s contribution
                        </Link>
                      </p>
                    )}
                    {r.matches.length > 0 && (
                      <label>
                        Destination match
                        <select
                          disabled={busy}
                          value={
                            decisions?.find((d) => d.recordId === r.recordId)?.action === 'link'
                              ? decisions.find((d) => d.recordId === r.recordId)?.targetRecordId
                              : decisions?.some(
                                    (d) => d.recordId === r.recordId && d.action === 'keep_both',
                                  )
                                ? 'keep_both'
                                : ''
                          }
                          onChange={(e) =>
                            decide(
                              r.recordId,
                              e.target.value === 'keep_both'
                                ? { action: 'keep_both', targetRecordId: undefined }
                                : { action: 'link', targetRecordId: e.target.value },
                            )
                          }
                        >
                          <option value="">Choose after comparing</option>
                          <option value="keep_both">Keep both records</option>
                          {r.matches.map((m) => (
                            <option key={m.recordId} value={m.recordId}>
                              Link to {m.title} ·{' '}
                              {m.mapping.date || m.mapping.documentDate || 'date unknown'}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {r.matches.map((m) => (
                      <details key={m.recordId}>
                        <summary>Compare {m.title}</summary>
                        <ul>
                          {m.evidence.map((e, i) => (
                            <li key={i}>
                              <a href={e.contentUrl} target="_blank" rel="noreferrer">
                                {e.label}
                              </a>{' '}
                              — {e.locator}
                            </li>
                          ))}
                        </ul>
                        <MappingValues mapping={r.mapping} kind={r.kind} label="Incoming values" />
                        <MappingValues
                          mapping={m.mapping}
                          kind={r.kind}
                          label="Destination values (retained when linked)"
                        />
                      </details>
                    ))}
                    {r.splitReviewRequired && (
                      <>
                        <MappingEditor
                          label="Transferred clinical contents"
                          kind={r.kind}
                          mapping={
                            decisions?.find((d) => d.recordId === r.recordId)?.splitMapping ||
                            r.mapping
                          }
                          disabled={busy}
                          onChange={(mapping) =>
                            decide(r.recordId, { splitMapping: mapping, reviewedSplit: false })
                          }
                        />
                        <MappingEditor
                          label={`Contents staying with ${r.owner.fullName}`}
                          kind={r.kind}
                          mapping={
                            decisions?.find((d) => d.recordId === r.recordId)?.remainingMapping ||
                            r.remainingMapping ||
                            {}
                          }
                          disabled={busy}
                          onChange={(mapping) =>
                            decide(r.recordId, { remainingMapping: mapping, reviewedSplit: false })
                          }
                        />
                        <label>
                          <input
                            type="checkbox"
                            checked={
                              decisions?.find((d) => d.recordId === r.recordId)?.reviewedSplit ||
                              false
                            }
                            disabled={busy}
                            onChange={(e) =>
                              decide(r.recordId, {
                                splitMapping:
                                  decisions?.find((d) => d.recordId === r.recordId)?.splitMapping ||
                                  r.mapping,
                                remainingMapping:
                                  decisions?.find((d) => d.recordId === r.recordId)
                                    ?.remainingMapping || r.remainingMapping,
                                reviewedSplit: e.target.checked,
                              })
                            }
                          />
                          I reviewed both records’ exact contents against their sources.
                        </label>
                      </>
                    )}
                    {r.blockers.map((b) => (
                      <p key={b}>{b}</p>
                    ))}
                  </section>
                ))}
                {preview.names.map((n) => (
                  <label key={n.key}>
                    {n.name} — remembered by{' '}
                    {preview.records.find((r) => r.owner.personId === n.personId)?.owner.fullName ||
                      'the former person'}
                    {n.unknownSupport
                      ? ' (some historical support is unknown)'
                      : n.independentSupport
                        ? ' (independent support remains)'
                        : ' (all supporting assignments move)'}
                    <select
                      disabled={busy}
                      value={names?.find((d) => d.key === n.key)?.outcome || n.decision}
                      onChange={(e) => {
                        setNames((old) => [
                          ...(old || []).filter((d) => d.key !== n.key),
                          { key: n.key, outcome: e.target.value as typeof n.decision },
                        ]);
                        changed();
                      }}
                    >
                      <option value="old">
                        Keep for{' '}
                        {preview.records.find((r) => r.owner.personId === n.personId)?.owner
                          .fullName || 'the former person'}
                      </option>
                      <option value="destination">
                        Remove from{' '}
                        {preview.records.find((r) => r.owner.personId === n.personId)?.owner
                          .fullName || 'the former person'}{' '}
                        and use for{' '}
                        {'personId' in preview.destination
                          ? preview.destination.fullName
                          : preview.destination.newPerson.fullName}
                      </option>
                      <option value="both">Use for both people</option>
                      <option value="unresolved">
                        Ask each time for later reports with this printed name
                      </option>
                    </select>
                  </label>
                ))}
                {preview.relationships
                  .filter((r) => r.resolution !== 'move_together')
                  .map((r) => (
                    <label key={r.decisionId}>
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={relationships?.some((d) => d.decisionId === r.decisionId) || false}
                        onChange={(e) => {
                          setRelationships((old) =>
                            e.target.checked
                              ? [...(old || []), { decisionId: r.decisionId, action: 'withdraw' }]
                              : (old || []).filter((d) => d.decisionId !== r.decisionId),
                          );
                          changed();
                        }}
                      />
                      Withdraw the {r.action.replaceAll('_', ' ')} relationship involving{' '}
                      {preview.records.find((i) => i.recordId === r.recordId)?.title}. The prior
                      decision remains in history.
                    </label>
                  ))}
                <button
                  className="button primary"
                  disabled={busy || dirty || !!blocked}
                  onClick={() => void save()}
                >
                  {busy ? 'Saving…' : 'Confirm person correction'}
                </button>
                {dirty && (
                  <p>Update the preview to review your changed choices before confirming.</p>
                )}
              </>
            )}
          </>
        )}
      </NoteDialog>
    </>
  );
}
function MappingValues({
  mapping,
  kind,
  label,
}: {
  mapping: IntakeClinicalMapping;
  kind: keyof typeof fieldsByKind;
  label: string;
}) {
  return (
    <div>
      <h4>{label}</h4>
      <dl>
        {fieldsByKind[kind].map((f) => (
          <div key={f.key}>
            <dt>{f.label}</dt>
            <dd>{String(mapping[f.key] || 'Not recorded')}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
function MappingEditor({
  mapping,
  kind,
  label,
  disabled,
  onChange,
}: {
  mapping: IntakeClinicalMapping;
  kind: keyof typeof fieldsByKind;
  label: string;
  disabled: boolean;
  onChange: (value: IntakeClinicalMapping) => void;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>{label}</legend>
      {fieldsByKind[kind].map((f) => (
        <label key={f.key}>
          {f.label}
          {f.multiline ? (
            <textarea
              value={String(mapping[f.key] || '')}
              onChange={(e) => onChange({ ...mapping, [f.key]: e.target.value })}
            />
          ) : (
            <input
              value={String(mapping[f.key] || '')}
              onChange={(e) => onChange({ ...mapping, [f.key]: e.target.value })}
            />
          )}
        </label>
      ))}
    </fieldset>
  );
}
