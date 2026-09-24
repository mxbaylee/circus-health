import { useEffect, useRef, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import type {
  HistoryValue,
  Note,
  NoteHistory,
  NoteRestoreResult,
  NoteRestorationPreview,
} from '../../../shared/api';
import { api, apiUrl, useResource } from '../../data/api';
import { NoteDialog } from './NoteDialog';
import { LoadingIndicator } from '../../components/LoadingIndicator';

export function historyValueLabel(cell: HistoryValue): string {
  if (!cell.present) return 'Not recorded (field absent)';
  if (cell.value === null) return 'Null';
  if (cell.value === '') return 'Empty text';
  if (Array.isArray(cell.value)) return cell.value.length ? cell.value.join(', ') : 'Empty list';
  if (typeof cell.value === 'boolean') return cell.value ? 'Yes' : 'No';
  if (typeof cell.value === 'object') return JSON.stringify(cell.value, null, 2);
  return String(cell.value);
}

export function NoteHistoryPanel({
  note,
  disabled,
  onRestored,
  onBusyChange,
  openSignal,
  hideTrigger = false,
}: {
  note: Note;
  disabled: boolean;
  onRestored: (result: Note) => void;
  onBusyChange: (busy: boolean) => void;
  openSignal?: number;
  hideTrigger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);
  return (
    <section className={hideTrigger ? 'note-history-dialog' : 'note-section'}>
      {!hideTrigger && (
        <>
          <button
            type="button"
            className="text-link"
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            <History size={17} /> Review saved history
          </button>
          {disabled && (
            <p className="helper-text">
              Save or resolve pending edits and uploads before comparing saved history.
            </p>
          )}
        </>
      )}
      <NoteDialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
        title="Saved history"
        description="Compare a published saved state with this entry. Restore only the fields you select as a new save."
      >
        {open && (
          <HistoryContents
            key={note.id}
            note={note}
            onRestored={onRestored}
            onBusyChange={(next) => {
              setBusy(next);
              onBusyChange(next);
            }}
          />
        )}
      </NoteDialog>
    </section>
  );
}

function HistoryContents({
  note,
  onRestored,
  onBusyChange,
}: {
  note: Note;
  onRestored: (note: Note) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const endpoint = useRef(apiUrl(`/notes/${encodeURIComponent(note.id)}`)).current;
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      busyCallback.current(false);
    };
  }, []);
  const [cursor, setCursor] = useState('');
  const [generation, setGeneration] = useState('');
  const [fields, setFields] = useState<string[]>([]);
  const [associations, setAssociations] = useState<{ links: string[]; attachments: string[] }>({
    links: [],
    attachments: [],
  });
  const [preview, setPreview] = useState<NoteRestorationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<{
    operationId: string;
    generationId: string;
    fields: string[];
    version: number;
    associations?: { links: string[]; attachments: string[] };
    expectedRevision?: number;
    previewToken?: string;
  } | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const resource = useResource<NoteHistory>(
    `${endpoint}/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
  const selected =
    resource.data?.entries.find((entry) => entry.generationId === generation) ||
    resource.data?.entries[0];
  const differences = selected?.fields.filter((field) => field.changed) || [];
  const indexed = resource.data?.format === 'record-versions';
  const selectionCount =
    fields.length + associations.links.length + associations.attachments.length;
  const clearSelection = () => {
    setFields([]);
    setAssociations({ links: [], attachments: [] });
    setPreview(null);
  };
  const choose = (id: string) => {
    setGeneration(id);
    clearSelection();
    setError('');
    setMessage('');
  };
  async function previewSelection() {
    if (busy || !resource.data || !selected || conflicted) return;
    setBusy(true);
    onBusyChange(true);
    setError('');
    controller.current = new AbortController();
    try {
      const { data } = await api<NoteRestorationPreview>(`${endpoint}/restore-preview`, {
        method: 'POST',
        body: JSON.stringify({
          generationId: selected.generationId,
          fields,
          associations,
          version: resource.data.currentVersion,
          expectedRevision: resource.data.currentRevision,
        }),
        signal: controller.current.signal,
      });
      if (mounted.current) setPreview(data);
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason instanceof Error ? reason.message : 'The preview could not be prepared.');
      if (reason && typeof reason === 'object' && 'status' in reason && reason.status === 409)
        setConflicted(true);
    } finally {
      if (mounted.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  async function restore() {
    if (busy || !resource.data || !selected || conflicted || note.status === 'finished') return;
    if (indexed && !preview && !pending) return;
    const request = pending || {
      operationId: crypto.randomUUID(),
      generationId: selected.generationId,
      fields,
      version: resource.data.currentVersion,
      ...(indexed && preview
        ? {
            associations,
            expectedRevision: preview.expectedRevision,
            previewToken: preview.previewToken,
          }
        : {}),
    };
    setPending(request);
    setBusy(true);
    onBusyChange(true);
    setError('');
    controller.current = new AbortController();
    try {
      const { data } = await api<NoteRestoreResult>(`${endpoint}/restore`, {
        method: 'POST',
        body: JSON.stringify(request),
        signal: controller.current.signal,
      });
      if (!mounted.current) return;
      onRestored(data.note);
      setPending(null);
      clearSelection();
      resource.reload();
      setMessage(
        data.recovery.published
          ? 'Selected fields restored as a new saved version.'
          : 'Selected fields are saved locally. The portable recovery copy still needs a retry.',
      );
    } catch (reason) {
      if (!mounted.current) return;
      setError(
        reason instanceof Error ? reason.message : 'The selected fields could not be restored.',
      );
      // Known rejections did not commit. An uncertain response must reuse the
      // identical operation ID and selection rather than applying another save.
      if (
        reason &&
        typeof reason === 'object' &&
        'status' in reason &&
        typeof reason.status === 'number' &&
        reason.status >= 400 &&
        reason.status < 500
      ) {
        setPending(null);
        setConflicted(true);
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  function refresh() {
    setConflicted(false);
    setPending(null);
    clearSelection();
    setError('');
    resource.reload();
  }
  return (
    <div className="note-history-content">
      <p className="helper-text">
        {resource.data?.coverage ||
          'Only verified published snapshots are shown. Loose older snapshot files are excluded.'}
      </p>
      {resource.loading && <LoadingIndicator label="Reading saved history…" layout="panel" />}
      {resource.error && (
        <div className="note-warning" role="alert">
          {resource.error.message}{' '}
          <button type="button" className="text-link" onClick={resource.reload}>
            Retry history
          </button>
        </div>
      )}
      {resource.data && !resource.loading && (
        <>
          {resource.data.groups && (
            <div aria-label="Editing sessions">
              {resource.data.groups.map((group) => (
                <details key={group.id}>
                  <summary>
                    {group.label} · {group.entries.length}{' '}
                    {group.entries.length === 1 ? 'save' : 'saves'} ·{' '}
                    {new Date(group.savedAt).toLocaleString()}
                  </summary>
                  {group.entries.map((id) => {
                    const entry = resource.data!.entries.find(
                      (value) => value.generationId === id,
                    )!;
                    return (
                      <button
                        key={id}
                        type="button"
                        className="text-link"
                        disabled={busy || Boolean(pending)}
                        onClick={() => choose(id)}
                      >
                        Inspect version {entry.noteVersion} ·{' '}
                        {new Date(entry.savedAt).toLocaleString()}
                      </button>
                    );
                  })}
                </details>
              ))}
            </div>
          )}
          <label className="note-field">
            Saved state
            <select
              aria-label="Saved state"
              value={selected?.generationId || ''}
              disabled={busy || Boolean(pending)}
              onChange={(event) => choose(event.target.value)}
            >
              {resource.data.entries.map((entry) => (
                <option key={entry.generationId} value={entry.generationId}>
                  {new Date(entry.savedAt).toLocaleString()} · version {entry.noteVersion} · save{' '}
                  {entry.revision}
                  {entry.publication === 'baseline' ? ' · known baseline' : ''}
                </option>
              ))}
            </select>
          </label>
          {!selected && <p>No published states for this entry appear on this page.</p>}
          {selected?.recordedChanges && selected.recordedChanges.length > 0 && (
            <details>
              <summary>What changed in this save</summary>
              {selected.recordedChanges.map((change) => (
                <p key={change.path}>
                  {change.label}: {historyValueLabel(change.before)} →{' '}
                  {historyValueLabel(change.after)}
                </p>
              ))}
            </details>
          )}
          {selected && (
            <>
              <p className="helper-text">
                Saved status: {selected.status}. {selected.links} links · {selected.attachments}{' '}
                attachments.{' '}
                {indexed
                  ? 'Select removed associations to recover them using retained originals. Status remains unchanged.'
                  : 'Status, links and attachment associations are not restored here.'}
              </p>
              {!differences.length && (
                <p>This saved state matches the currently restorable fields.</p>
              )}
              <div className="note-history-fields">
                {differences.map((field) => (
                  <div className="note-history-field" key={field.path}>
                    <label>
                      <input
                        type="checkbox"
                        checked={fields.includes(field.path)}
                        disabled={busy || Boolean(pending) || conflicted || !field.restorable}
                        onChange={(event) => {
                          setPreview(null);
                          setFields((previous) =>
                            event.target.checked
                              ? [...previous, field.path]
                              : previous.filter((path) => path !== field.path),
                          );
                        }}
                      />{' '}
                      {field.label}
                    </label>
                    <div>
                      <span>Current</span>
                      <pre>{historyValueLabel(field.current)}</pre>
                      {field.current.format && (
                        <small>
                          {field.current.format === 'markdown-v1' ? 'Markdown' : 'Literal text'}
                        </small>
                      )}
                    </div>
                    <div>
                      <span>Restore from saved state</span>
                      <pre>{historyValueLabel(field.previous)}</pre>
                      {field.previous.format && (
                        <small>
                          {field.previous.format === 'markdown-v1' ? 'Markdown' : 'Literal text'}
                        </small>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {selected.associations && (
                <div aria-label="Removed associations">
                  {(['links', 'attachments'] as const).flatMap((kind) =>
                    selected
                      .associations![kind].filter((item) => item.changed)
                      .map((item) => (
                        <div className="note-history-field" key={`${kind}:${item.id}`}>
                          <label>
                            <input
                              type="checkbox"
                              checked={associations[kind].includes(item.id)}
                              disabled={busy || Boolean(pending) || conflicted || !item.restorable}
                              onChange={(event) => {
                                setPreview(null);
                                setAssociations((previous) => ({
                                  ...previous,
                                  [kind]: event.target.checked
                                    ? [...previous[kind], item.id]
                                    : previous[kind].filter((id) => id !== item.id),
                                }));
                              }}
                            />{' '}
                            Restore {item.kind}: {item.label}
                          </label>
                          <p>
                            {item.reason ||
                              'This association was present in the saved version and is now removed.'}
                          </p>
                        </div>
                      )),
                  )}
                </div>
              )}
            </>
          )}
          {resource.data.finished && (
            <p className="helper-text">
              This note is finished. Its content remains fixed; create a linked correction note for
              changes.
            </p>
          )}
          {error && (
            <p className="note-warning" role="alert">
              {error}
            </p>
          )}
          {message && (
            <p className="note-flash" role="status">
              {message}
            </p>
          )}
          {preview && (
            <section aria-label="Restoration preview">
              <h3>Review selected changes</h3>
              {preview.changes.map((change) => (
                <p key={change.path}>
                  {change.label}: {historyValueLabel(change.before)} →{' '}
                  {historyValueLabel(change.after)}
                </p>
              ))}
              {preview.associationChanges.map((change) => (
                <p key={change.id}>
                  Restore {change.kind}: {change.label} · {historyValueLabel(change.previous)}
                </p>
              ))}
              <p className="helper-text">
                These selections will be saved as a new version. Other current fields and
                associations stay as they are.
              </p>
            </section>
          )}
          {conflicted ? (
            <button type="button" className="button secondary" onClick={refresh}>
              Refresh comparison
            </button>
          ) : (
            !resource.data.finished &&
            (indexed && !preview && !pending ? (
              <button
                type="button"
                className="button primary"
                disabled={busy || !selectionCount}
                onClick={() => void previewSelection()}
              >
                {busy ? 'Preparing preview…' : 'Preview restoration'}
              </button>
            ) : (
              <button
                type="button"
                className="button primary"
                disabled={busy || (!selectionCount && !pending)}
                onClick={() => void restore()}
              >
                <RotateCcw size={16} />
                {busy
                  ? 'Restoring…'
                  : pending
                    ? 'Retry same restoration'
                    : indexed
                      ? 'Restore selected changes'
                      : `Restore ${fields.length || 'selected'} ${fields.length === 1 ? 'field' : 'fields'}`}
              </button>
            ))
          )}
          <div className="notes-pager">
            {cursor && (
              <button
                type="button"
                className="button secondary"
                disabled={busy || Boolean(pending)}
                onClick={() => {
                  setCursor('');
                  setGeneration('');
                  clearSelection();
                }}
              >
                Latest states
              </button>
            )}
            {resource.data.nextCursor && (
              <button
                type="button"
                className="button secondary"
                disabled={busy || Boolean(pending)}
                onClick={() => {
                  setCursor(resource.data!.nextCursor!);
                  setGeneration('');
                  clearSelection();
                }}
              >
                Older states
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
