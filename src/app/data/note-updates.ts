import type { Note } from '../../shared/api';

type NoteUpdate = { profileId: string; note: Note };
const listeners = new Set<(update: NoteUpdate) => void>();
/** Announce a committed external edit; no draft content or note cache is retained. */
export function publishNoteUpdate(profileId: string | undefined, note: Note) {
  if (profileId) for (const listener of listeners) listener({ profileId, note });
}
export function subscribeNoteUpdates(listener: (update: NoteUpdate) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
