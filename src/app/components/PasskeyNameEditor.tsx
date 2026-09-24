import { useEffect, useRef, useState } from 'react';
import { renameProfilePasskey, type SavedPasskey } from '../data/profile-management';
import { subscribeProfileIdentity } from '../data/profile';

/** Mount one keyed editor per profile/credential. Names remain in component memory. */
export function PasskeyNameEditor({
  profileId,
  passkey,
  onSaved,
  onCancel,
  onBusyChange,
}: {
  profileId: string;
  passkey: SavedPasskey;
  onSaved: (label: string) => void;
  onCancel: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [name, setName] = useState(passkey.label || '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const active = useRef(true),
    saving = useRef(false);
  const callbacks = useRef({ onSaved, onCancel, onBusyChange });
  callbacks.current = { onSaved, onCancel, onBusyChange };
  useEffect(() => {
    active.current = true;
    const unsubscribe = subscribeProfileIdentity(() => {
      active.current = false;
    });
    // Radix listens on document capture, before React's form handlers. Handle
    // Escape at window capture so cancelling this inline edit keeps its modal.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || !active.current) return;
      event.preventDefault();
      event.stopPropagation();
      if (!saving.current) callbacks.current.onCancel();
    };
    window.addEventListener('keydown', escape, true);
    return () => {
      active.current = false;
      unsubscribe();
      window.removeEventListener('keydown', escape, true);
    };
  }, []);
  const label = name.trim();
  const valid =
    label.length > 0 && label.length <= 80 && !/[\u0000-\u001f\u007f-\u009f]/u.test(name);
  async function save() {
    if (!active.current || saving.current || !valid || label === (passkey.label || '')) return;
    saving.current = true;
    setBusy(true);
    setError('');
    callbacks.current.onBusyChange?.(true);
    let result;
    try {
      result = await renameProfilePasskey(profileId, passkey.id, label);
    } catch (cause) {
      if (!active.current) return;
      saving.current = false;
      setBusy(false);
      callbacks.current.onBusyChange?.(false);
      setError(cause instanceof Error ? cause.message : 'The passkey name could not be saved.');
      return;
    }
    if (!active.current) return;
    saving.current = false;
    setBusy(false);
    callbacks.current.onBusyChange?.(false);
    callbacks.current.onSaved(result.label);
  }
  return (
    <form
      className="passkey-name-editor"
      aria-label="Name passkey"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="profile-management-field">
        Passkey name
        <input
          autoFocus
          value={name}
          maxLength={80}
          placeholder="1Password or Hardware key"
          disabled={busy}
          onChange={(event) => {
            setName(event.target.value);
            setError('');
          }}
        />
      </label>
      <div className="profile-management-actions">
        <button
          type="submit"
          className="button primary"
          disabled={busy || !valid || label === (passkey.label || '')}
        >
          {busy ? 'Saving…' : 'Save name'}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => {
            if (active.current) callbacks.current.onCancel();
          }}
        >
          Cancel
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
