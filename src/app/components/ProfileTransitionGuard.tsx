import { useEffect, useRef, useState } from 'react';
import { currentProfile, subscribeProfileIdentity } from '../data/profile';
import { prepareProfileTransition, profileTransitionEditors } from '../data/profile-transition';
import { NoteDialog } from '../features/notes/NoteDialog';

type Transition = {
  profileId: string | undefined;
  action: (active: () => boolean) => void | Promise<void>;
  valid: boolean;
  resume?: () => void;
};

export function useProfileTransition() {
  const [pending, setPending] = useState<Transition | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<Transition | null>(null);
  const running = useRef<Transition | null>(null);
  const mounted = useRef(true);
  const identityVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeProfileIdentity(() => {
      identityVersion.current++;
      if (current.current) {
        current.current.valid = false;
        current.current.resume?.();
      }
      current.current = null;
      setPending(null);
      setError('');
    });
    return () => {
      mounted.current = false;
      if (current.current) {
        current.current.valid = false;
        current.current.resume?.();
      }
      current.current = null;
      unsubscribe();
    };
  }, []);
  function cancel() {
    if (running.current) return;
    if (current.current) current.current.valid = false;
    current.current = null;
    setPending(null);
    setError('');
  }
  function cancelAction() {
    if (current.current) {
      current.current.valid = false;
      current.current.resume?.();
    }
    current.current = null;
    running.current = null;
    setPending(null);
    setSaving(false);
    setError('');
  }
  async function execute(transition: Transition, choice?: 'save' | 'discard') {
    if (running.current || current.current !== transition) return;
    running.current = transition;
    setSaving(true);
    setError('');
    const active = () =>
      mounted.current && transition.valid && currentProfile()?.id === transition.profileId;
    let resume: (() => void) | undefined;
    try {
      if (choice) {
        resume = await prepareProfileTransition(transition.profileId, choice, active);
        transition.resume = resume;
      }
      if (!active()) return;
      setPending(null);
      await transition.action(active);
      if (current.current === transition) current.current = null;
    } catch (reason) {
      if (active()) {
        setPending(transition);
        setError(
          reason instanceof Error
            ? reason.message
            : 'Could not save your changes. Try again or go Back to the entry.',
        );
      }
    } finally {
      resume?.();
      if (running.current === transition) {
        running.current = null;
        if (mounted.current) setSaving(false);
      }
    }
  }
  function request(action: Transition['action'], leaving = true) {
    if (current.current || running.current) return;
    const transition = { profileId: currentProfile()?.id, action, valid: true };
    current.current = transition;
    if (
      leaving &&
      profileTransitionEditors(transition.profileId).some((editor) => editor.pending())
    ) {
      setError('');
      setPending(transition);
    } else void execute(transition);
  }
  function captureActive() {
    const version = identityVersion.current;
    return () => mounted.current && identityVersion.current === version;
  }
  const dialog = (
    <NoteDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
      onBack={cancel}
      backLabel="Back"
      backDisabled={saving}
      title="Save changes before continuing?"
      description="Some changes or attachment links are not saved yet. Save them before continuing, or discard only unsaved changes. Completed saves remain stored."
    >
      <div className="note-dialog-actions">
        <button
          className="button secondary"
          type="button"
          disabled={saving}
          onClick={() => {
            if (pending) void execute(pending, 'discard');
          }}
        >
          Discard and continue
        </button>
        <button
          className="button primary"
          type="button"
          disabled={saving}
          onClick={() => {
            if (pending) void execute(pending, 'save');
          }}
        >
          {saving ? 'Saving…' : 'Save and continue'}
        </button>
      </div>
      {error && (
        <p className="note-warning" role="alert">
          {error}
        </p>
      )}
    </NoteDialog>
  );
  return { request, dialog, cancelAction, captureActive };
}
