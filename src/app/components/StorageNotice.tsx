import { useState } from 'react';
import { api } from '../data/api';
import { useDurability } from '../data/durability';

export function StorageNotice() {
  const state = useDurability();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!state?.configured || !state.dirty) return null;
  async function retry() {
    setBusy(true);
    setError(false);
    try {
      await api('/storage/flush', { method: 'POST', body: '{}' });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="storage-notice" role="alert">
      <p>Your changes are saved locally, but their recovery copy could not be saved yet.</p>
      <button className="button secondary" disabled={busy} onClick={() => void retry()}>
        {busy ? 'Retrying…' : 'Retry recovery copy'}
      </button>
      {error && <p>The copy still needs attention. Your local changes remain saved.</p>}
    </aside>
  );
}
