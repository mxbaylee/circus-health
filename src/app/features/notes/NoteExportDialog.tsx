import { useState, useRef } from 'react';
import { Printer } from 'lucide-react';
import { api, apiUrl } from '../../data/api';
import { currentProfile } from '../../data/profile';
import { NoteDialog } from './NoteDialog';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import './note-export.css';

type Choice = {
  key: string;
  type: string;
  kind?: string | null;
  id: string;
  title: string;
  date: string | null;
  archived?: boolean;
  linked?: boolean;
  current?: boolean;
  history?: boolean;
  missing?: boolean;
  topic: string;
  source: string;
};
type Asset = {
  id: string;
  title?: string;
  originalName?: string;
  contentUrl?: string;
  ownerType?: string;
  ownerId?: string;
  date?: string | null;
  caption?: string;
};
type Options = {
  noteVersion: number | string;
  noteTitle: string;
  choices: Choice[];
  assets: Asset[];
};
type Preview = {
  token: string;
  html: string;
  fingerprint: string;
  generatedAt: string;
  assets: Asset[];
};
export function NoteExportDialog({
  type,
  id,
  prepare,
  disabled = false,
  label = 'Print / Export',
}: {
  type: 'note' | 'document' | 'person';
  id: string;
  prepare?: () => Promise<unknown>;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false),
    [options, setOptions] = useState<Options | null>(null),
    [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [mode, setMode] = useState(type === 'person' ? 'provider' : 'brief'),
    [noteIds, setNoteIds] = useState<string[]>([]);
  const [includeLinked, setIncludeLinked] = useState(false),
    [includeAttachments, setIncludeAttachments] = useState(false);
  const [includeProcedures, setIncludeProcedures] = useState(false),
    [includePrescriptions, setIncludePrescriptions] = useState(false),
    [includePatient, setIncludePatient] = useState(false);
  const [search, setSearch] = useState('');
  const frame = useRef<HTMLIFrameElement>(null),
    profile = useRef(currentProfile()?.id);
  function checkProfile() {
    if (profile.current !== currentProfile()?.id)
      throw new Error('The profile changed. Reopen Print / Export in the selected profile.');
  }
  async function start() {
    setOpen(true);
    setBusy(true);
    setError('');
    setPreview(null);
    setOptions(null);
    setNoteIds(type === 'note' ? [id] : []);
    setIncludeLinked(false);
    setIncludeAttachments(false);
    setIncludeProcedures(false);
    setIncludePrescriptions(false);
    setIncludePatient(false);
    setSearch('');
    setMode(type === 'person' ? 'provider' : 'brief');
    profile.current = currentProfile()?.id;
    try {
      await prepare?.();
      checkProfile();
      const response = await api<Options>('/note-exports/options', {
        method: 'POST',
        body: JSON.stringify({ type, id }),
      });
      checkProfile();
      setOptions(response.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed. Nothing was exported.');
    } finally {
      setBusy(false);
    }
  }
  const endpoint = (suffix: string) => `/note-exports/${suffix}`;
  async function buildPreview() {
    if (!options) return;
    setBusy(true);
    setError('');
    try {
      checkProfile();
      await prepare?.();
      checkProfile();
      const latest = (
        await api<Options>(endpoint('options'), {
          method: 'POST',
          body: JSON.stringify({ type, id }),
        })
      ).data;
      checkProfile();
      setOptions(latest);
      const response = await api<Preview>(endpoint('preview'), {
        method: 'POST',
        body: JSON.stringify({
          type,
          id,
          noteVersion: latest.noteVersion,
          mode,
          noteIds,
          includeLinked,
          includeAttachments,
          includeProcedures,
          includePrescriptions,
          includePatient,
          selected: [],
          assets: [],
        }),
      });
      checkProfile();
      setPreview(response.data);
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : 'Could not create a preview.');
    } finally {
      setBusy(false);
    }
  }
  async function output(format: 'print' | 'pdf' | 'evidence') {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      checkProfile();
      await prepare?.();
      checkProfile();
      await api(endpoint(`${preview.token}/validate`), { method: 'POST' });
      checkProfile();
      if (format === 'print') {
        frame.current?.contentWindow?.focus();
        frame.current?.contentWindow?.print();
      } else {
        const response = await fetch(apiUrl(endpoint(`${preview.token}/${format}`)), {
          method: 'POST',
        });
        checkProfile();
        if (!response.ok) {
          const payload = await response.json();
          throw new Error(payload.error?.message || 'Download generation failed.');
        }
        const blob = await response.blob();
        checkProfile();
        const expectedType = format === 'pdf' ? 'application/pdf' : 'application/json';
        if (!blob.type.includes(expectedType))
          throw new Error(
            format === 'pdf'
              ? 'The renderer did not return a PDF.'
              : 'The server did not return evidence JSON.',
          );
        const url = URL.createObjectURL(blob),
          link = document.createElement('a');
        link.href = url;
        link.download = `${(options?.noteTitle || 'note').replace(/[^a-z0-9 _-]/gi, '').slice(0, 80) || 'note'}-${mode}${format === 'evidence' ? '-evidence.json' : '.pdf'}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }
  function toggle(value: string, values: string[], setter: (v: string[]) => void) {
    setter(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  }
  const notes = (options?.choices || []).filter(
    (c) => c.type === 'note' && c.kind !== 'person' && !c.missing && c.id !== id,
  );
  const visibleNotes = notes.filter(
    (c) => !search || c.title.toLowerCase().includes(search.toLowerCase()),
  );
  const supplements =
    includeLinked ||
    includeAttachments ||
    includeProcedures ||
    includePrescriptions ||
    includePatient;
  return (
    <>
      <button
        className="button secondary note-export-trigger"
        type="button"
        disabled={disabled || busy}
        onClick={() => void start()}
      >
        <Printer size={16} />
        {label}
      </button>
      <NoteDialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
        onBack={
          preview
            ? () => {
                setPreview(null);
                setError('');
              }
            : undefined
        }
        backLabel="Back to export options"
        backDisabled={busy}
        title="Print / Export"
        description="Prepare a focused visit brief or a complete introduction for a new provider."
        className="note-export-dialog"
      >
        {error && (
          <p className="note-warning" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <LoadingIndicator
            label={options ? 'Preparing the saved revision…' : 'Loading your saved information…'}
            layout="panel"
          />
        )}
        {!preview && options && (
          <div className="export-options">
            {type !== 'person' && (
              <label className="note-field">
                Format
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="brief">Visit brief</option>
                  <option value="provider">New provider packet</option>
                </select>
              </label>
            )}
            {mode === 'brief' ? (
              <>
                <p>
                  <strong>{options.noteTitle}</strong> is always included. Choose any supporting
                  information for this visit.
                </p>
                <fieldset className="export-inclusions">
                  <legend>Include</legend>
                  <label className="export-check">
                    <input
                      type="checkbox"
                      checked={includeLinked}
                      onChange={(e) => setIncludeLinked(e.target.checked)}
                    />
                    <span>
                      Linked entries<small>Direct links only.</small>
                    </span>
                  </label>
                  <label className="export-check">
                    <input
                      type="checkbox"
                      checked={includeAttachments}
                      onChange={(e) => setIncludeAttachments(e.target.checked)}
                    />
                    <span>
                      Attachments
                      <small>Original files belonging to the note and included entries.</small>
                    </span>
                  </label>
                  <label className="export-check">
                    <input
                      type="checkbox"
                      checked={includeProcedures}
                      onChange={(e) => setIncludeProcedures(e.target.checked)}
                    />
                    Procedure history
                  </label>
                  <label className="export-check">
                    <input
                      type="checkbox"
                      checked={includePrescriptions}
                      onChange={(e) => setIncludePrescriptions(e.target.checked)}
                    />
                    Current prescriptions
                  </label>
                  <label className="export-check">
                    <input
                      type="checkbox"
                      checked={includePatient}
                      onChange={(e) => setIncludePatient(e.target.checked)}
                    />
                    Patient information
                  </label>
                </fieldset>
              </>
            ) : (
              <>
                <h3>New provider packet</h3>
                <p>
                  Patient information, recorded prescriptions, procedures, results, and source
                  references are included automatically. Care contacts and additional clinical
                  assertions appear when they are linked or assigned to this person.
                </p>
                <fieldset className="export-inclusions">
                  <legend>Notes to include</legend>
                  {type !== 'person' && (
                    <p>
                      <strong>{options.noteTitle}</strong> is included as your introduction.
                    </p>
                  )}
                  <p className="text-muted">
                    Selected notes include their direct links and attachments. Other personal notes
                    stay out.
                  </p>
                  {!!notes.length && (
                    <label className="note-field">
                      Find a note
                      <input
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search notes"
                      />
                    </label>
                  )}
                  <div className="export-choices">
                    {visibleNotes.map((note) => (
                      <label className="export-check" key={note.key}>
                        <input
                          type="checkbox"
                          checked={noteIds.includes(note.id)}
                          onChange={() => toggle(note.id, noteIds, setNoteIds)}
                        />
                        <span>
                          {note.title}
                          {note.archived && <small>Inactive</small>}
                        </span>
                      </label>
                    ))}
                    {!visibleNotes.length && (
                      <p>
                        {notes.length ? 'No matching notes.' : 'No additional notes to include.'}
                      </p>
                    )}
                  </div>
                  {!!noteIds.filter((noteId) => noteId !== id).length && (
                    <p className="text-muted">
                      {noteIds.filter((noteId) => noteId !== id).length} additional notes selected.
                    </p>
                  )}
                </fieldset>
              </>
            )}
            <p className="text-muted">
              Repeated entries are included once. The preview lists accompanying attachment
              downloads separately from the printable document.
            </p>
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => void buildPreview()}
            >
              {mode === 'provider'
                ? 'Preview provider packet'
                : supplements
                  ? 'Preview visit brief'
                  : 'Preview note only'}
            </button>
          </div>
        )}
        {preview && (
          <div>
            <p className="text-muted">
              Preview generated {new Date(preview.generatedAt).toLocaleString()}. Refresh the
              preview if content changes.
            </p>
            <div className="note-dialog-actions">
              <button className="button secondary" disabled={busy} onClick={() => setPreview(null)}>
                Edit options
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void buildPreview()}
              >
                Refresh preview
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void output('print')}
              >
                Print
              </button>
              <button className="button primary" disabled={busy} onClick={() => void output('pdf')}>
                Download PDF
              </button>
              {mode === 'provider' && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void output('evidence')}
                >
                  Download evidence JSON
                </button>
              )}
            </div>
            {mode === 'provider' && (
              <p className="text-muted">
                The PDF presents the readable clinical records. The accompanying evidence JSON
                contains exact retained source assertions and full attribution for this packet.
              </p>
            )}
            <iframe
              ref={frame}
              className="export-preview"
              title="Exact export preview"
              sandbox="allow-same-origin allow-modals"
              srcDoc={preview.html}
            />
            {!!preview.assets.length && (
              <div>
                <h3>Accompanying attachments</h3>
                {preview.assets.map((a) => (
                  <p key={a.id}>
                    <a href={a.contentUrl} download>
                      {a.originalName}
                    </a>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
        {!options && !busy && (
          <button className="button secondary" onClick={() => void start()}>
            Retry save and load
          </button>
        )}
      </NoteDialog>
    </>
  );
}
