import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { HttpError } from './database.ts';
import { profileOriginal, profilePaths } from './profile-storage.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import {
  createPackageSourceLeaseOwner,
  type PackageSourceLease,
} from './intake-package-source-lease.ts';

type Owner = ReturnType<typeof createPackageSourceLeaseOwner>;
interface Session {
  root: string;
  profileId: string;
  owner: Owner;
}
const sessions = new WeakMap<DatabaseSync, Session>();
interface SourceRow {
  id: string;
  kind: string;
  path: string;
  sha256: string;
  bytes: number;
}

function assertSession(db: DatabaseSync, profileId: string) {
  if (!db.isOpen) throw new HttpError(409, 'PROFILE_LOCKED', 'The source session is closed');
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Source belongs to another profile');
  const status = recordDurabilityStatus(db);
  if (!status?.configured || status.dirty)
    throw new HttpError(409, 'SOURCE_AUTHORITY', 'Retained source authority requires recovery');
}

/** Explicit lifecycle revocation. Metadata/checkpoint cache clears must not call
 * this: successful authority edits do not invalidate an unchanged original. */
export function clearPackageSourceSession(db: DatabaseSync): void {
  sessions.get(db)?.owner.close();
  sessions.delete(db);
}
export function packageSourceSessionWork(db: DatabaseSync): Readonly<Owner['work']> | null {
  const work = sessions.get(db)?.owner.work;
  return work ? Object.freeze({ ...work }) : null;
}

/** Per-DB/profile lifecycle-bound source verification. SQLite identifies the
 * current retained source only while the existing accepted owner is current;
 * physical FD/path verification still precedes every byte consumer. */
export async function withPackageSessionSource<T>(
  {
    db,
    root,
    profileId,
    id,
    assertRunning,
  }: { db: DatabaseSync; root: string; profileId: string; id: string; assertRunning?: () => void },
  writer: (lease: PackageSourceLease) => Promise<T>,
): Promise<T> {
  const canonicalRoot = resolve(root);
  const existing = sessions.get(db);
  if (existing && (existing.root !== canonicalRoot || existing.profileId !== profileId))
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Source session binding changed');
  assertSession(db, profileId);
  assertRunning?.();
  const query = db.prepare('SELECT id,kind,path,sha256,bytes FROM source_files WHERE id=?');
  const source = query.get(id) as unknown as SourceRow | undefined;
  if (!source || source.kind !== 'intake_original')
    throw new HttpError(404, 'NOT_FOUND', 'Retained source intake not found');
  const sourceIdentity = JSON.stringify(source);
  const check = () => {
    assertSession(db, profileId);
    assertRunning?.();
    if (JSON.stringify(query.get(id)) !== sourceIdentity)
      throw new HttpError(409, 'SOURCE_CHANGED', 'Retained source binding changed');
  };
  // Materialize and check containment, while preserving the lexical final
  // component for the lease's lstat/O_NOFOLLOW checks.
  profileOriginal(canonicalRoot, source.path, profileId);
  const path = resolve(canonicalRoot, source.path);
  check();
  const session = existing ?? {
    root: canonicalRoot,
    profileId,
    owner: createPackageSourceLeaseOwner({
      profileId,
      root: profilePaths(canonicalRoot, profileId).root,
      cacheEntries: 64,
      assertAuthorized: () => assertSession(db, profileId),
    }),
  };
  if (!existing) sessions.set(db, session);
  return session.owner.withSource(
    { profileId, intakeId: id, sourceHash: source.sha256, bytes: source.bytes, path },
    writer,
    check,
  );
}
