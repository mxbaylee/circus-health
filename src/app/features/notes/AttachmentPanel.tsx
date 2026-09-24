import { useEffect, useRef, useState } from 'react';
import { Download, FileImage, FileText, Paperclip, Pencil, Trash2, Upload } from 'lucide-react';
import type { Asset, Attachment, Note } from '../../../shared/api';
import { api, apiUrl, useResource } from '../../data/api';
import { NoteDialog } from './NoteDialog';
import { PdfPreview } from '../../components/PdfPreview';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import './notes.css';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ACCEPTED_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif';
const contentUrl = (asset: Asset) => apiUrl(asset.contentUrl);
const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'The attachment could not be saved.';
type PendingUpload = {
  key: string;
  name: string;
  progress: number;
  asset?: Asset;
  attached?: boolean;
  error?: string;
};
type AttachmentMetadata = { caption: string; bodyLocation: string; eventDate: string };

function uploadOriginal(
  url: string,
  file: File,
  onProgress: (value: number) => void,
  requests: Set<XMLHttpRequest>,
): Promise<Asset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl(url));
    requests.add(xhr);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => {
      requests.delete(xhr);
      reject(new Error('Unable to reach the local server.'));
    };
    xhr.onabort = () => {
      requests.delete(xhr);
      reject(new Error('Upload canceled.'));
    };
    xhr.onload = () => {
      requests.delete(xhr);
      try {
        const response = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300)
          reject(new Error(response.error?.message || `Upload failed (${xhr.status}).`));
        else if (!response.data?.id)
          reject(new Error('The upload returned an unexpected response.'));
        else resolve(response.data as Asset);
      } catch {
        reject(new Error('The upload returned an unreadable response.'));
      }
    };
    xhr.send(file);
  });
}

export function AttachmentPanel({
  ownerType,
  ownerId,
  version,
  readOnly = false,
  disabled = false,
  additionalOwner,
  onNoteChanged,
  onChanged,
  onBusyChange,
  prepareOwner,
  mutateOwner,
}: {
  ownerType: Attachment['ownerType'];
  ownerId: string;
  version?: number;
  readOnly?: boolean;
  disabled?: boolean;
  additionalOwner?: { ownerType: Attachment['ownerType']; ownerId: string };
  onNoteChanged?: (note: Note) => void;
  onChanged?: () => void;
  onBusyChange?: (busy: boolean) => void;
  prepareOwner?: () => Promise<Note>;
  mutateOwner?: (mutation: (saved: Note) => Promise<void>) => Promise<void>;
}) {
  const resource = useResource<Attachment[]>(
    `/attachments?ownerType=${ownerType}&ownerId=${encodeURIComponent(ownerId)}`,
  );
  const additional = useResource<Attachment[]>(
    additionalOwner
      ? `/attachments?ownerType=${additionalOwner.ownerType}&ownerId=${encodeURIComponent(additionalOwner.ownerId)}`
      : null,
  );
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const operationActive = useRef(false);
  const mutationCallback = useRef(mutateOwner);
  mutationCallback.current = mutateOwner;
  const prepareCallback = useRef(prepareOwner);
  prepareCallback.current = prepareOwner;
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [editing, setEditing] = useState<Attachment | null>(null);
  const [removing, setRemoving] = useState<Attachment | null>(null);
  const [metadata, setMetadata] = useState<AttachmentMetadata>({
    caption: '',
    bodyLocation: '',
    eventDate: '',
  });
  const apiBase = useRef(apiUrl('/')).current;
  const endpoint = (path: string) => `${apiBase.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  const uploadRequests = useRef(new Set<XMLHttpRequest>());
  const mounted = useRef(true);
  const versionRef = useRef(version);
  const noteCallback = useRef(onNoteChanged);
  const changeCallback = useRef(onChanged);
  versionRef.current = version;
  noteCallback.current = onNoteChanged;
  changeCallback.current = onChanged;
  const blocked = busy || disabled || readOnly;
  const metadataChanged =
    editing !== null &&
    (metadata.caption !== editing.caption ||
      (metadata.bodyLocation || null) !== (editing.bodyLocation || null) ||
      (metadata.eventDate || null) !== (editing.eventDate || null));
  // A failed response may follow a committed change; keep explicit retry or
  // refresh available even when the user returns to the displayed baseline.
  const metadataNeedsSave = metadataChanged || Boolean(editing && error);
  const allAttachments = [...(resource.data || []), ...(additional.data || [])].filter(
    (item, index, all) => all.findIndex((other) => other.id === item.id) === index,
  );
  const loading = resource.loading || additional.loading;
  const loadError = resource.error || additional.error;
  useEffect(() => {
    onBusyChange?.(busy || pending.length > 0 || Boolean(editing));
  }, [busy, pending, editing, onBusyChange]);
  useEffect(
    () => () => {
      onBusyChange?.(false);
    },
    [onBusyChange],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      uploadRequests.current.forEach((xhr) => xhr.abort());
    };
  }, []);

  async function refreshOwner() {
    if (ownerType === 'note' || ownerType === 'person') {
      const response = await api<Note>(endpoint(`/notes/${encodeURIComponent(ownerId)}`));
      versionRef.current = response.data.version;
      noteCallback.current?.(response.data);
    }
    resource.reload();
    if (additionalOwner) additional.reload();
    changeCallback.current?.();
  }
  async function mutate(action: (latestVersion: number | undefined) => Promise<void>) {
    if (mutationCallback.current) {
      await mutationCallback.current(async (saved) => {
        versionRef.current = saved.version;
        await action(saved.version);
        await refreshOwner();
      });
    } else {
      await action(versionRef.current);
      await refreshOwner();
    }
  }
  async function associate(asset: Asset, key: string) {
    await mutate(async (latestVersion) => {
      await api<Attachment>(endpoint('/attachments'), {
        method: 'POST',
        body: JSON.stringify({
          id: `attachment:${key}`,
          assetId: asset.id,
          ownerType,
          ownerId,
          version: latestVersion,
        }),
      });
      if (mounted.current)
        setPending((items) =>
          items.map((item) => (item.key === key ? { ...item, attached: true } : item)),
        );
    });
  }
  async function uploadFiles(files: File[]) {
    if (blocked || operationActive.current || !files.length) return;
    setError('');
    const invalid = files.find(
      (file) => !ACCEPTED_TYPES.includes(file.type) || file.size > MAX_UPLOAD_BYTES || !file.size,
    );
    if (invalid) {
      setError(`${invalid.name}: choose a nonempty PDF, PNG, JPEG, WebP or GIF of 25 MB or less.`);
      return;
    }
    operationActive.current = true;
    setBusy(true);
    try {
      await prepareCallback.current?.();
    } catch (reason) {
      setError(errorMessage(reason));
      operationActive.current = false;
      setBusy(false);
      return;
    }
    for (const file of files) {
      if (!mounted.current) break;
      const key = crypto.randomUUID();
      setPending((items) => [...items, { key, name: file.name, progress: 0 }]);
      try {
        const asset = await uploadOriginal(
          endpoint('/assets'),
          file,
          (progress) =>
            setPending((items) =>
              items.map((item) => (item.key === key ? { ...item, progress } : item)),
            ),
          uploadRequests.current,
        );
        setPending((items) =>
          items.map((item) => (item.key === key ? { ...item, progress: 100, asset } : item)),
        );
        await associate(asset, key);
        setPending((items) => items.filter((item) => item.key !== key));
      } catch (uploadError) {
        setPending((items) =>
          items.map((item) =>
            item.key === key
              ? {
                  ...item,
                  error: `${errorMessage(uploadError)} The batch stopped here; choose any remaining files again.`,
                }
              : item,
          ),
        );
        break;
      }
    }
    operationActive.current = false;
    if (mounted.current) setBusy(false);
  }
  async function retryLink(item: PendingUpload) {
    if (!item.asset || blocked || operationActive.current) return;
    operationActive.current = true;
    setBusy(true);
    try {
      await prepareCallback.current?.();
      if (item.attached) await mutate(async () => {});
      else await associate(item.asset, item.key);
      setPending((items) => items.filter((p) => p.key !== item.key));
    } catch (retryError) {
      setError(errorMessage(retryError));
    }
    operationActive.current = false;
    setBusy(false);
  }
  async function saveMetadata() {
    if (!editing || !metadataNeedsSave || blocked || operationActive.current) return;
    operationActive.current = true;
    setBusy(true);
    setError('');
    try {
      await prepareCallback.current?.();
      await mutate(async (latestVersion) => {
        await api(endpoint(`/attachments/${encodeURIComponent(editing.id)}`), {
          method: 'PATCH',
          body: JSON.stringify({
            ...metadata,
            bodyLocation: metadata.bodyLocation || null,
            eventDate: metadata.eventDate || null,
            version: latestVersion,
          }),
        });
        setEditing(null);
      });
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
    operationActive.current = false;
    setBusy(false);
  }
  async function unlink() {
    if (!removing || blocked || operationActive.current) return;
    operationActive.current = true;
    setBusy(true);
    setError('');
    try {
      await prepareCallback.current?.();
      await mutate(async (latestVersion) => {
        await api(endpoint(`/attachments/${encodeURIComponent(removing.id)}`), {
          method: 'DELETE',
          body: JSON.stringify({ version: latestVersion }),
        });
        setRemoving(null);
      });
    } catch (unlinkError) {
      setError(errorMessage(unlinkError));
    }
    operationActive.current = false;
    setBusy(false);
  }
  const activeUploads = pending.filter((item) => !item.error);
  const uploadLabel =
    activeUploads.length === 1
      ? activeUploads[0].progress < 100
        ? `Uploading ${activeUploads[0].name}…`
        : `Linking ${activeUploads[0].name}…`
      : `Uploading ${activeUploads.length} files…`;
  return (
    <section className="note-section" aria-label="Attachments">
      <div className="attachment-toolbar">
        <h3>
          <Paperclip size={17} /> Attachments
        </h3>
        <span className="quiet-badge">PDFs & photos</span>
      </div>
      {!readOnly && (
        <div
          className="attachment-drop"
          data-dragging={dragging}
          onDragOver={(event) => {
            event.preventDefault();
            if (!blocked) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!blocked) void uploadFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <label className={`button secondary ${blocked ? 'muted' : ''}`}>
            <Upload size={17} /> Add files
            <input
              type="file"
              aria-label="Add PDF or photo attachments"
              accept={ACCEPT}
              multiple
              disabled={blocked}
              onChange={(event) => {
                void uploadFiles(Array.from(event.target.files || []));
                event.target.value = '';
              }}
            />
          </label>
          <p>Choose files or drop them here. Up to 25 MB each; originals are preserved.</p>
        </div>
      )}
      {error && (
        <div role="alert" className="note-warning">
          {error}
          <br />
          <button
            type="button"
            className="text-link"
            disabled={busy || disabled}
            onClick={() => {
              void (async () => {
                await prepareCallback.current?.();
                await mutate(async () => {});
              })()
                .then(() => setError(''))
                .catch((refreshError) => setError(errorMessage(refreshError)));
            }}
          >
            Refresh saved attachment details
          </button>
        </div>
      )}
      {!!activeUploads.length && <LoadingIndicator label={uploadLabel} size="small" />}
      <div>
        {pending.map((item) => (
          <div className="attachment-progress" key={item.key}>
            <p>
              <span>{item.name}</span>
              <span>{item.progress}%</span>
            </p>
            <progress value={item.progress} max={100} aria-label={`Uploading ${item.name}`} />
            {item.error && (
              <div className="note-warning" role="alert">
                <p>{item.error}</p>
                {item.asset && (
                  <p>
                    {item.attached
                      ? 'The attachment was saved, but its latest status could not be loaded. Refresh before continuing.'
                      : 'The original was uploaded, but linking needs to be completed. Finishing this note is paused.'}
                  </p>
                )}
                <div className="attachment-actions">
                  {item.asset && (
                    <button
                      type="button"
                      className="text-link"
                      disabled={busy}
                      onClick={() => void retryLink(item)}
                    >
                      {item.attached ? 'Refresh saved attachment' : 'Retry link'}
                    </button>
                  )}
                  {!item.attached && (
                    <button
                      type="button"
                      className="text-link"
                      disabled={busy}
                      onClick={() => setPending((items) => items.filter((p) => p.key !== item.key))}
                    >
                      {item.asset
                        ? 'Keep original; continue without confirming link'
                        : 'Dismiss; choose file again'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {loading && (
        <LoadingIndicator className="notes-loading" label="Loading attachments…" layout="panel" />
      )}
      {loadError && (
        <div role="alert" className="note-warning">
          {loadError.message}
          <br />
          <button
            type="button"
            className="text-link"
            onClick={() => {
              resource.reload();
              additional.reload();
            }}
          >
            Try again
          </button>
        </div>
      )}
      {!loading && !loadError && !allAttachments.length && (
        <p className="muted">No attachments saved here yet.</p>
      )}
      <div className="attachment-list">
        {allAttachments.map((attachment) => (
          <article className="attachment-card" key={attachment.id}>
            <button
              className="attachment-thumbnail"
              type="button"
              onClick={() => {
                setPreviewFailed(false);
                setPreview(attachment);
              }}
              aria-label={`Preview ${attachment.asset.originalName}`}
            >
              {attachment.asset.mimeType.startsWith('image/') ? (
                <img src={contentUrl(attachment.asset)} alt="" loading="lazy" />
              ) : (
                <FileText size={26} />
              )}
            </button>
            <div className="attachment-copy">
              <h4>{attachment.asset.originalName}</h4>
              {attachment.caption && <p className="attachment-caption">{attachment.caption}</p>}
              <p>
                {fileSize(attachment.asset.bytes)} ·{' '}
                {attachment.eventDate
                  ? `Taken / event ${attachment.eventDate}`
                  : 'Taken / event date unknown'}
                {attachment.bodyLocation ? ` · ${attachment.bodyLocation}` : ''}
              </p>
              <div className="attachment-actions">
                <button
                  type="button"
                  className="text-link"
                  onClick={() => {
                    setPreviewFailed(false);
                    setPreview(attachment);
                  }}
                >
                  <FileImage size={14} /> Preview
                </button>
                <a
                  className="text-link"
                  href={contentUrl(attachment.asset)}
                  download={attachment.asset.originalName}
                >
                  <Download size={14} /> Original
                </a>
                {!readOnly && (
                  <>
                    <button
                      type="button"
                      className="text-link"
                      disabled={blocked}
                      onClick={() => {
                        setError('');
                        setEditing(attachment);
                        setMetadata({
                          caption: attachment.caption,
                          bodyLocation: attachment.bodyLocation || '',
                          eventDate: attachment.eventDate || '',
                        });
                      }}
                    >
                      <Pencil size={14} /> Details
                    </button>
                    <button
                      type="button"
                      className="text-link"
                      disabled={blocked}
                      onClick={() => {
                        setError('');
                        setRemoving(attachment);
                      }}
                    >
                      <Trash2 size={14} /> Unlink
                    </button>
                  </>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
      <NoteDialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        title={preview?.asset.originalName || 'Attachment'}
        description="Original file with its recorded details."
        className="attachment-preview-dialog"
      >
        {preview && (
          <>
            {preview.asset.mimeType === 'application/pdf' ? (
              <PdfPreview
                contentUrl={contentUrl(preview.asset)}
                filename={preview.asset.originalName}
              />
            ) : previewFailed ? (
              <p className="note-warning" role="alert">
                The original photo could not be opened. The file may be missing or unavailable; it
                has not been replaced.
              </p>
            ) : (
              <img
                className="attachment-preview"
                src={contentUrl(preview.asset)}
                alt={preview.caption || preview.asset.originalName}
                onError={() => setPreviewFailed(true)}
              />
            )}
            <dl className="attachment-meta-fields">
              <dt>Caption</dt>
              <dd>{preview.caption || 'Not recorded'}</dd>
              <dt>Location</dt>
              <dd>{preview.bodyLocation || 'Not recorded'}</dd>
              <dt>Taken / event date</dt>
              <dd>{preview.eventDate || 'Unknown'}</dd>
              <dt>Added</dt>
              <dd>{new Date(preview.createdAt).toLocaleString()}</dd>
              <dt>Attribution</dt>
              <dd>{preview.asset.attribution}</dd>
            </dl>
            <p className="attachment-integrity">SHA-256: {preview.asset.sha256}</p>
            <a
              href={contentUrl(preview.asset)}
              download={preview.asset.originalName}
              className="text-link"
            >
              <Download size={16} /> Download original
            </a>
          </>
        )}
      </NoteDialog>
      <NoteDialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(null);
        }}
        title="Attachment details"
        description="These details describe this attachment link. They do not change the original file."
      >
        <form
          className="note-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveMetadata();
          }}
        >
          <label className="note-field">
            Caption
            <textarea
              value={metadata.caption}
              disabled={busy}
              onChange={(event) => setMetadata({ ...metadata, caption: event.target.value })}
            />
          </label>
          <label className="note-field">
            Body location, if relevant
            <input
              value={metadata.bodyLocation}
              disabled={busy}
              onChange={(event) => setMetadata({ ...metadata, bodyLocation: event.target.value })}
              placeholder="For example, left shoulder"
            />
          </label>
          <label className="note-field">
            Photo taken / event date
            <input
              type="date"
              value={metadata.eventDate}
              disabled={busy}
              onChange={(event) => setMetadata({ ...metadata, eventDate: event.target.value })}
            />
            <small>
              Leave blank when unknown. Upload date does not establish when a photo was taken.
            </small>
          </label>
          {error && (
            <p className="note-warning" role="alert">
              {error}
            </p>
          )}
          <div className="note-dialog-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => setEditing(null)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={blocked || !metadataNeedsSave}
            >
              {busy ? 'Saving…' : 'Save details'}
            </button>
          </div>
        </form>
      </NoteDialog>
      <NoteDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
        title="Unlink attachment?"
        description="This removes the attachment from this entry. The original file and its other links remain stored."
      >
        {error && (
          <p className="note-warning" role="alert">
            {error}
          </p>
        )}
        <div className="note-dialog-actions">
          <button
            className="button secondary"
            type="button"
            onClick={() => setRemoving(null)}
            disabled={busy}
          >
            Keep attachment
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => void unlink()}
            disabled={blocked}
          >
            {busy ? 'Unlinking…' : 'Unlink attachment'}
          </button>
        </div>
      </NoteDialog>
    </section>
  );
}
