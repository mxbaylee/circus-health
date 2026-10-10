import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { HttpError } from './database.ts';
import { assertAuthorizationSignalRunning } from './authorization-signal.ts';
import { assertClinicalOperation, currentClinicalOperation } from './clinical-operation.ts';
import { profileOriginal, profilePaths } from './profile-storage.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import {
  createPackageSourceLeaseOwner,
  packageSourceLeaseAssertionCurrent,
  packageSourceLeaseOriginalPhysical,
  type PackageSourceLease,
  type PackageSourceOriginalPhysical,
} from './intake-package-source-lease.ts';

type Owner = ReturnType<typeof createPackageSourceLeaseOwner>;
interface Session {
  root: string;
  profileId: string;
  owner: Owner;
}
const sessions = new WeakMap<DatabaseSync, Session>();
const sessionAssertions = new WeakMap<
  () => void,
  {
    db: DatabaseSync;
    session: Session;
    profileId: string;
    operation: ReturnType<typeof currentClinicalOperation>;
    signal?: AbortSignal;
    active: () => boolean;
    prerequisites: readonly (() => void)[];
  }
>();

/** Exact active session issuer plus its original caller dependencies, not an approval. */
export function packageSessionAssertionPrerequisites(
  assertion: () => void,
  db: DatabaseSync,
): readonly (() => void)[] | undefined {
  const proof = sessionAssertions.get(assertion);
  if (
    !proof ||
    proof.db !== db ||
    !db.isOpen ||
    sessions.get(db) !== proof.session ||
    proof.session.profileId !== proof.profileId ||
    !proof.active() ||
    !packageSourceLeaseAssertionCurrent(assertion)
  )
    return undefined;
  if (proof.signal) assertAuthorizationSignalRunning(proof.signal);
  if (proof.operation) assertClinicalOperation(db, proof.operation);
  return proof.prerequisites;
}
/** Transport of the genuine lease's open-time source, not physical approval. */
export function packageSessionOriginalPhysicalSource(
  assertion: () => void,
  db: DatabaseSync,
): PackageSourceOriginalPhysical | undefined {
  return packageSessionAssertionPrerequisites(assertion, db)
    ? packageSourceLeaseOriginalPhysical(assertion)
    : undefined;
}
interface SourceRow {
  id: string;
  kind: string;
  path: string;
  sha256: string;
  bytes: number;
}

function assertSessionOwner(db: DatabaseSync, profileId: string) {
  if (!db.isOpen) throw new HttpError(409, 'PROFILE_LOCKED', 'The source session is closed');
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Source belongs to another profile');
}
function assertSession(db: DatabaseSync, profileId: string) {
  assertSessionOwner(db, profileId);
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
    assertPublicationCurrent,
    signal,
  }: {
    db: DatabaseSync;
    root: string;
    profileId: string;
    id: string;
    assertRunning?: () => void;
    assertPublicationCurrent?: () => void;
    signal?: AbortSignal;
  },
  writer: (lease: PackageSourceLease) => Promise<T>,
): Promise<T> {
  const canonicalRoot = resolve(root);
  const operation = currentClinicalOperation(db);
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
      assertPublicationAuthorized: () => assertSessionOwner(db, profileId),
    }),
  };
  if (!existing) sessions.set(db, session);
  let active = true;
  try {
    return await session.owner.withSource(
      {
        profileId,
        intakeId: id,
        sourceHash: source.sha256,
        bytes: source.bytes,
        path,
        acceptedPath: source.path,
      },
      async (lease) => {
        const prerequisites = Object.freeze(
          [assertRunning, assertPublicationCurrent].filter(
            (assertion): assertion is () => void => assertion !== undefined,
          ),
        );
        const proof = {
          db,
          session,
          profileId,
          operation,
          signal,
          active: () => active,
          prerequisites,
        };
        sessionAssertions.set(lease.assertCurrent, proof);
        sessionAssertions.set(lease.assertPublicationCurrent, proof);
        return writer(lease);
      },
      check,
      () => {
        signal?.throwIfAborted();
        if (operation) assertClinicalOperation(db, operation);
        if (assertPublicationCurrent) assertPublicationCurrent();
        else assertRunning?.();
        assertSessionOwner(db, profileId);
        if (JSON.stringify(query.get(id)) !== sourceIdentity)
          throw new HttpError(409, 'SOURCE_CHANGED', 'Retained source binding changed');
      },
    );
  } finally {
    active = false;
  }
}
