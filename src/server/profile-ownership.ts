import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { validProfileId } from './profiles.ts';

/** No migration, ownership assignment, directory creation or write connection. */
export function readDatabaseOwner(path: string): string {
  if (!existsSync(path) || !lstatSync(path).isFile())
    throw new Error('Profile database must be an existing regular file');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_meta'").get())
      throw new Error(
        'Database has no verified profile owner; explicit ownership recovery is required',
      );
    const value = db
      .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
      .get()?.value;
    if (!validProfileId(value))
      throw new Error(
        'Database has no verified profile owner; explicit ownership recovery is required',
      );
    return value;
  } finally {
    db.close();
  }
}
export function safeLegacyDatabasePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith('data/') &&
    path.endsWith('.sqlite') &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..')
  );
}
/** Generic historical paths stay beneath data/ and cannot traverse a symlink. */
export function legacyDatabaseFile(root: string, path: string): string {
  if (!safeLegacyDatabasePath(path)) throw new Error('Invalid legacy database path');
  let current = resolve(root);
  for (const part of path.split('/')) {
    current = resolve(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error('Legacy database path must not contain symbolic links');
  }
  const rel = relative(resolve(root, 'data'), current);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Legacy database is outside data storage');
  return current;
}
