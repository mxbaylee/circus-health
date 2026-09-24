import { notifySuccess } from './Toasts';
import { useEffect, useRef, useState } from 'react';
import type { LinkTargetType } from '../../shared/api';
import { api, apiUrl, useResource } from '../data/api';
import { History } from 'lucide-react';
import { NoteDialog } from '../features/notes/NoteDialog';
import { LoadingIndicator } from './LoadingIndicator';
import './archive.css';
import './detail-header.css';
type Visibility = {
  archived: boolean;
  version: number;
  protected: boolean;
  history?: { id: string; archived: boolean; version: number; createdAt: string; actor: string }[];
};
export function ArchiveControl({
  targetType,
  targetId,
  disabled = false,
  onChanged,
  showHistory = false,
}: {
  targetType: LinkTargetType | 'source_file';
  targetId: string;
  disabled?: boolean;
  onChanged?: () => void;
  showHistory?: boolean;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const endpoint = apiUrl(`/visibility/${targetType}/${encodeURIComponent(targetId)}`);
  const activeEndpoint = useRef(endpoint);
  activeEndpoint.current = endpoint;
  const request = useRef<AbortController | null>(null);
  const resource = useResource<Visibility>(endpoint);
  const [saved, setSaved] = useState<{ endpoint: string; value: Visibility } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setSaved(resource.data ? { endpoint, value: resource.data } : null);
  }, [resource.data, endpoint]);
  useEffect(() => {
    setBusy(false);
    setError('');
    setHistoryOpen(false);
    return () => request.current?.abort();
  }, [endpoint]);
  const state = saved?.endpoint === endpoint ? saved.value : resource.data;
  async function toggle() {
    if (!state || busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await api<Visibility>(endpoint, {
        method: 'PATCH',
        signal: controller.signal,
        body: JSON.stringify({ archived: !state.archived, version: state.version }),
      });
      if (controller.signal.aborted || activeEndpoint.current !== endpoint) return;
      setSaved({ endpoint, value: response.data });
      notifySuccess(response.data.archived ? 'Entry archived.' : 'Entry restored.');
      onChanged?.();
    } catch (cause) {
      if (controller.signal.aborted || activeEndpoint.current !== endpoint) return;
      setError(cause instanceof Error ? cause.message : 'Visibility could not be saved.');
      resource.reload();
    } finally {
      if (!controller.signal.aborted && activeEndpoint.current === endpoint) setBusy(false);
    }
  }
  if (state?.protected) return null;
  return (
    <div className="archive-control">
      <label className="entry-archive-switch">
        {state?.archived ? 'Inactive' : 'Active'}
        <input
          type="checkbox"
          role="switch"
          aria-label="Active"
          checked={Boolean(state && !state.archived)}
          disabled={disabled || busy || !state}
          onChange={() => void toggle()}
        />
      </label>
      {busy && <LoadingIndicator label="Saving…" layout="control" />}
      {showHistory && (
        <button
          className="entry-history-action"
          type="button"
          aria-haspopup="dialog"
          disabled={!state}
          onClick={() => setHistoryOpen(true)}
        >
          <History size={16} aria-hidden="true" />
          Archive history
        </button>
      )}
      <NoteDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        title="Archive history"
        description="Personal archive and restore actions for this entry. Original record contents remain unchanged."
      >
        {state?.history?.length ? (
          <ol className="archive-history">
            {state.history.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.archived ? 'Archived' : 'Restored'}</strong>
                <span>
                  {new Date(entry.createdAt).toLocaleString()} · By: {entry.actor}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p>No archive or restore actions have been recorded.</p>
        )}
      </NoteDialog>
      {(error || resource.error) && (
        <span role="alert">
          {error || resource.error?.message}
          <button className="text-link" onClick={resource.reload}>
            Reload visibility
          </button>
        </span>
      )}
    </div>
  );
}
export function VisibilityFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="visibility-filter">
      Show{' '}
      <select
        aria-label="Visibility"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="visible">Active</option>
        <option value="archived">Inactive</option>
        <option value="all">All</option>
      </select>
    </label>
  );
}
