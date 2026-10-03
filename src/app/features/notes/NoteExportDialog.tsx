import { useState, useRef } from 'react';
import { Printer } from 'lucide-react';
import { api, apiUrl } from '../../data/api';
import { currentProfile, useProfile } from '../../data/profile';
import { NoteDialog } from './NoteDialog';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import { PacketSelection, PacketPrivateReview, type PacketOptions } from './PacketSelection';
import type {
  PacketCandidate,
  PacketSelection as Selection,
  PacketReview,
} from '../../../shared/packet-selection';
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
  packet?: PacketOptions;
};
type Preview = {
  token: string;
  html: string;
  fingerprint: string;
  generatedAt: string;
  assets: Asset[];
  packetReview?: PacketReview;
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
  const activeProfile = useProfile();
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
  const [packetSelection, setPacketSelection] = useState<Selection>({});
  const [previewChoicesChanged, setPreviewChoicesChanged] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null),
    profile = useRef(currentProfile()?.id);
  const profileChanged = profile.current !== activeProfile?.id;
  function changeScope(change: () => void) {
    change();
    setPacketSelection((selection) => ({ ...selection, approvals: [] }));
    setPreviewChoicesChanged(true);
  }
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
    setPacketSelection({});
    setPreviewChoicesChanged(false);
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
          ...(latest.packet ? { packetSelection } : {}),
        }),
      });
      checkProfile();
      setPreview(response.data);
      setPreviewChoicesChanged(false);
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : 'Could not create a preview.');
    } finally {
      setBusy(false);
    }
  }
  async function output(format: 'print' | 'pdf' | 'evidence') {
    if (!preview || previewChoicesChanged) return;
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
        link.download = `health-packet-${mode}${format === 'evidence' ? '-evidence.json' : '.pdf'}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }
  async function savePreference(
    candidate: PacketCandidate,
    alwaysWithhold: boolean,
    tags = candidate.tags,
  ) {
    if (!options?.packet) return;
    setBusy(true);
    setError('');
    try {
      checkProfile();
      await api(endpoint('preferences'), {
        method: 'POST',
        body: JSON.stringify({
          type,
          id,
          personId: options.packet.personId,
          record: candidate.record,
          alwaysWithhold,
          tags,
          expectedVersion: candidate.preferenceVersion,
        }),
      });
      checkProfile();
      const latest = await api<Options>(endpoint('options'), {
        method: 'POST',
        body: JSON.stringify({ type, id }),
      });
      checkProfile();
      setOptions(latest.data);
      setPacketSelection((selection) => ({ ...selection, approvals: [] }));
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the withholding preference.');
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
    includePatient ||
    !!packetSelection.include?.length ||
    !!packetSelection.exclude?.length ||
    packetSelection.kinds !== undefined ||
    !!packetSelection.tags?.length ||
    !!packetSelection.from ||
    !!packetSelection.to;
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
        description="Prepare a visit brief or selected history to share with a provider."
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
                <select
                  disabled={busy}
                  value={mode}
                  onChange={(e) => changeScope(() => setMode(e.target.value))}
                >
                  <option value="brief">Visit brief</option>
                  <option value="provider">New provider packet</option>
                </select>
              </label>
            )}
            {mode === 'brief' ? (
              <>
                <p>
                  <strong>{options.noteTitle}</strong> is your starting note. Choose any supporting
                  information and review what to leave out.
                </p>
                <fieldset className="export-inclusions">
                  <legend>Include</legend>
                  <label className="export-check">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={includeLinked}
                      onChange={(e) => changeScope(() => setIncludeLinked(e.target.checked))}
                    />
                    <span>
                      Linked entries<small>Direct links only.</small>
                    </span>
                  </label>
                  <label className="export-check">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={includeAttachments}
                      onChange={(e) => changeScope(() => setIncludeAttachments(e.target.checked))}
                    />
                    <span>
                      Attachments
                      <small>Original files belonging to the note and included entries.</small>
                    </span>
                  </label>
                  <label className="export-check">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={includeProcedures}
                      onChange={(e) => changeScope(() => setIncludeProcedures(e.target.checked))}
                    />
                    Procedure history
                  </label>
                  <label className="export-check">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={includePrescriptions}
                      onChange={(e) => changeScope(() => setIncludePrescriptions(e.target.checked))}
                    />
                    Current prescriptions
                  </label>
                  <label className="export-check">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={includePatient}
                      onChange={(e) => changeScope(() => setIncludePatient(e.target.checked))}
                    />
                    Patient information
                  </label>
                </fieldset>
              </>
            ) : (
              <>
                <h3>New provider packet</h3>
                <p>
                  Start with this person's recorded history, then choose which records to share.
                  Care contacts and additional clinical assertions appear when they are linked or
                  assigned to this person.
                </p>
                <fieldset className="export-inclusions">
                  <legend>Notes to include</legend>
                  {type !== 'person' && (
                    <p>
                      <strong>{options.noteTitle}</strong> starts as your introduction, subject to
                      your packet choices.
                    </p>
                  )}
                  <p className="text-muted">
                    Selected notes start with their direct links and attachments, subject to your
                    withholding choices and original review. Other personal notes stay out.
                  </p>
                  {!!notes.length && (
                    <label className="note-field">
                      Find a note
                      <input
                        type="search"
                        disabled={busy}
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
                          disabled={busy}
                          checked={noteIds.includes(note.id)}
                          onChange={() => changeScope(() => toggle(note.id, noteIds, setNoteIds))}
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
            {options.packet && (
              <PacketSelection
                packet={options.packet}
                selection={packetSelection}
                onChange={setPacketSelection}
                onPreference={(candidate, alwaysWithhold, tags) =>
                  void savePreference(candidate, alwaysWithhold, tags)
                }
                busy={busy || profileChanged}
              />
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
            {preview.packetReview && (
              <PacketPrivateReview
                review={preview.packetReview}
                selection={packetSelection}
                onChange={(selection) => {
                  setPacketSelection(selection);
                  setPreviewChoicesChanged(true);
                }}
                busy={busy || profileChanged}
              />
            )}
            {previewChoicesChanged && (
              <p className="note-warning" role="status">
                Disclosure choices changed. Refresh the preview before sharing.
              </p>
            )}
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
                disabled={busy || previewChoicesChanged}
                onClick={() => void output('print')}
              >
                Print
              </button>
              <button
                className="button primary"
                disabled={busy || previewChoicesChanged}
                onClick={() => void output('pdf')}
              >
                Download PDF
              </button>
              {mode === 'provider' && (
                <button
                  className="button secondary"
                  disabled={busy || previewChoicesChanged}
                  onClick={() => void output('evidence')}
                >
                  Download evidence JSON
                </button>
              )}
            </div>
            {mode === 'provider' && (
              <p className="text-muted">
                The PDF presents the readable clinical records. The accompanying evidence JSON
                contains the selected evidence and attribution for this packet. Any explicitly
                approved narrative or original is included unredacted.
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
                    {busy || previewChoicesChanged || profileChanged ? (
                      <span>{a.originalName} — refresh the preview to download</span>
                    ) : (
                      <a
                        href={a.contentUrl}
                        download
                        onClick={(event) => {
                          try {
                            checkProfile();
                          } catch (e) {
                            event.preventDefault();
                            setError(e instanceof Error ? e.message : 'The profile changed.');
                          }
                        }}
                      >
                        {a.originalName}
                      </a>
                    )}
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
