type NoteLocation = { pathname: string; search: string };

/** A save may canonicalize a new draft/person alias without replacing that editor. */
export function canonicalizesEditor(
  current: NoteLocation,
  next: NoteLocation,
  noteId: string,
  personId?: string | null,
): boolean {
  if (current.pathname !== next.pathname) return false;
  const from = new URLSearchParams(current.search),
    to = new URLSearchParams(next.search);
  return (
    to.get('id') === noteId &&
    to.get('new') !== '1' &&
    (from.get('new') === '1' || Boolean(personId && from.get('id') === personId))
  );
}

/** Filters can change without throwing away the current editor's unsaved work. */
export function leavesNoteEditor(current: NoteLocation, next: NoteLocation): boolean {
  if (current.pathname !== next.pathname) return true;
  const currentQuery = new URLSearchParams(current.search);
  const nextQuery = new URLSearchParams(next.search);
  if (currentQuery.get('id') !== nextQuery.get('id')) return true;
  if (currentQuery.get('new') !== nextQuery.get('new')) return true;
  // Unsaved new forms are keyed by kind; existing notes are keyed by stable ID.
  return (
    currentQuery.get('new') === '1' &&
    (currentQuery.get('kind') || 'note') !== (nextQuery.get('kind') || 'note')
  );
}
