import { mkdirSync, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

import { validProfileId } from './profiles.ts';
export { PROFILE_IDS } from './profiles.ts';
import { readProfileRegistry } from './profile-registry.ts';
import { legacyDatabaseFile, readDatabaseOwner } from './profile-ownership.ts';

const originalResolvers = new Map<string, (path: string) => void>();
/** The unlocked vault owns this hook; lock/failure must unregister it. */
export function registerProfileOriginalResolver(
  root: string,
  profileId: string,
  resolver: (path: string) => void,
): () => void {
  const key = profilePaths(root, profileId).root;
  if (originalResolvers.has(key)) throw Error('Profile original resolver already registered');
  originalResolvers.set(key, resolver);
  return () => {
    if (originalResolvers.get(key) === resolver) originalResolvers.delete(key);
  };
}

export interface ProfilePaths {
  relativeRoot: string;
  root: string;
  databaseDirectory: string;
  database: string;
  sources: string;
  personal: string;
  curation: string;
  records: string;
  attachments: string;
  intakeBatches: string;
}

export function profilePaths(root: string, profileId: unknown): ProfilePaths {
  if (!validProfileId(profileId)) throw new Error('Unknown profile');
  const relativeRoot = `data/profiles/${profileId}`;
  const base = resolve(root, relativeRoot);
  return {
    relativeRoot,
    root: base,
    databaseDirectory: resolve(base, 'db'),
    database: resolve(base, 'db/database.sqlite'),
    sources: resolve(base, 'sources'),
    personal: resolve(base, 'personal'),
    curation: resolve(base, 'curation'),
    records: resolve(base, 'records'),
    attachments: resolve(base, 'attachments'),
    intakeBatches: resolve(base, 'intake-batches'),
  };
}
export function ensureProfileDirectories(root: string, profileId: unknown): ProfilePaths {
  const paths = profilePaths(root, profileId);
  for (const path of [
    paths.root,
    paths.databaseDirectory,
    paths.sources,
    paths.personal,
    paths.curation,
    paths.attachments,
    paths.intakeBatches,
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  return paths;
}
export function legacyDatabasePath(root: string, profileId: unknown): string | null {
  if (!validProfileId(profileId)) throw new Error('Unknown profile');
  const entry = readProfileRegistry(root).profiles.find((profile) => profile.id === profileId);
  if (!entry) return null;
  const candidates = entry.legacyDatabase
    ? [entry.legacyDatabase]
    : [`data/profiles/${profileId}.sqlite`, 'data/database.sqlite'];
  for (const candidate of candidates) {
    const path = legacyDatabaseFile(root, candidate);
    if (!existsSync(path)) continue;
    const owner = readDatabaseOwner(path);
    if (owner === profileId) return path;
    if (entry.legacyDatabase) throw new Error('Legacy database belongs to a different profile');
  }
  return null;
}
export function existingProfileDatabase(root: string, profileId: unknown): string {
  const current = profilePaths(root, profileId).database;
  if (existsSync(current)) return current;
  const legacy = legacyDatabasePath(root, profileId);
  if (legacy && existsSync(legacy)) return legacy;
  throw new Error('Profile database is missing; rebuild it explicitly from portable sources');
}
export function safeRelative(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..')
  );
}
/** Resolve only an authorized missing original; ordinary filesystem validation
 * remains with each existing consumer after materialization. */
export function ensureProfileOriginal(root: string, path: unknown, profileId: unknown): void {
  const paths = profilePaths(root, profileId);
  if (
    !safeRelative(path) ||
    !['sources', 'attachments'].some((dir) => path.startsWith(`${paths.relativeRoot}/${dir}/`))
  )
    throw new Error('Original file is outside the selected profile');
  if (!existsSync(resolve(root, path))) originalResolvers.get(paths.root)?.(path);
}
// Portable rebuilds use the symmetric layout. Legacy recovery is handled by
// recovery.ts and must never relax this new-profile boundary.
export function profileOriginal(root: string, path: unknown, profileId: unknown): string {
  const paths = profilePaths(root, profileId);
  if (
    !safeRelative(path) ||
    !['sources', 'attachments'].some((dir) => path.startsWith(`${paths.relativeRoot}/${dir}/`))
  )
    throw new Error('Original file is outside the selected profile');
  const full = resolve(root, path);
  ensureProfileOriginal(root, path, profileId);
  const actual = realpathSync(full),
    base = realpathSync(paths.root);
  const rel = relative(base, actual);
  if (rel.startsWith('..') || isAbsolute(rel) || !statSync(actual).isFile())
    throw new Error('Original file escaped the selected profile');
  return actual;
}
