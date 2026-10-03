import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  lstatSync,
  readFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, type Database } from './database.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  flushRecordDurability,
  recordDurabilityStatus,
} from './record-versions.ts';
import { validateProductionIntakeAuthority } from './intake-state-bootstrap.ts';
import { ensureProfileDirectories } from './profile-storage.ts';
import {
  contributorAuthorityPath,
  contributorAuthorityMarker,
  hasContributorAuthority,
  openContributorRecordStorage,
  contributorOriginalVerifier,
  type ContributorRecordStorage,
} from './contributor-record-storage.ts';

const attached = new WeakMap<Database, ContributorRecordStorage>();
export function attachContributorDurability(
  db: Database,
  root: string,
  profileId: string,
  initialize = false,
) {
  if (attached.has(db)) return flushRecordDurability(db)!;
  ensureProfileDirectories(root, profileId);
  // Initialization is permitted only for a fresh unpublished profile. Existing
  // marker presence always selects the journal, including incomplete authority.
  const fresh = !hasContributorAuthority(root, profileId);
  if (fresh && db.prepare("SELECT 1 FROM sqlite_schema WHERE name='__record_state'").get())
    throw Error('Contributor selected authority is missing; existing cache cannot initialize it');
  if (fresh) validateProductionIntakeAuthority(db, profileId);
  const storage = openContributorRecordStorage(root, profileId, { initialize });
  try {
    if (!fresh) assertIndexedContributorCache(db, root, profileId, storage);
    const status = attachRecordDurability(db, {
      profileId,
      storage,
      verifyReferences: contributorOriginalVerifier(root, profileId),
    });
    validateProductionIntakeAuthority(db, profileId);
    if (!fresh) assertContributorCopyCoherence(db, root, profileId);
    attached.set(db, storage);
    const close = db.close.bind(db);
    db.close = () => {
      try {
        close();
      } finally {
        storage.close();
        attached.delete(db);
      }
    };
    return status;
  } catch (error) {
    storage.close();
    throw error;
  }
}
export function selectedContributorHead(root: string, profileId: string): string {
  const storage = openContributorRecordStorage(root, profileId, { readOnly: true });
  try {
    return storage.read('head')!.toString('utf8');
  } finally {
    storage.close();
  }
}
export function rebuildContributorDatabase(database: string, root: string, profileId: string) {
  const storage = openContributorRecordStorage(root, profileId, { readOnly: true });
  const head = storage.read('head')!;
  try {
    const result = rebuildRecordDatabase(database, {
      profileId,
      storage,
      verifyReferences: contributorOriginalVerifier(root, profileId),
    });
    const db = openDatabase(database, profileId);
    try {
      validateProductionIntakeAuthority(db, profileId);
    } finally {
      db.close();
    }
    if (!storage.read('head')!.equals(head))
      throw Error('Contributor authority changed during reconstruction');
    return result;
  } finally {
    storage.close();
  }
}
/** Registry-free discovery requires the verified selected journal, including its
 * reconstructed owner and originals. A directory name or selection marker alone
 * does not establish profile identity. The source archive remains unchanged. */
export function verifyContributorProfileAuthority(root: string, profileId: string): void {
  const directory = mkdtempSync(resolve(tmpdir(), 'health-contributor-owner-'));
  try {
    rebuildContributorDatabase(resolve(directory, 'owner.sqlite'), root, profileId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const bookkeeping = (key: unknown) =>
  typeof key === 'string' &&
  ((key.startsWith('personal_') && !/^personal_(assistant|restore)_/.test(key)) ||
    key === 'curation_revision');
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
function rows(db: Database): string {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name",
    )
    .all();
  return JSON.stringify(
    tables.map(({ name }) => [
      name,
      db
        .prepare(`SELECT * FROM ${quote(String(name))}`)
        .all()
        .filter((row) => name !== 'app_meta' || !bookkeeping(row.key))
        .map((row) =>
          JSON.stringify(
            Object.fromEntries(
              Object.keys(row)
                .sort()
                .map((key) => [key, row[key]]),
            ),
          ),
        )
        .sort(),
    ]),
  );
}
/** Verify the cache against its own accepted baseline before catch-up can
 * overwrite rows. A newer selected head authorizes recovery of acknowledged
 * state, never silent erasure of conflicting unacknowledged cache edits. */
function assertIndexedContributorCache(
  db: Database,
  root: string,
  profileId: string,
  storage: ContributorRecordStorage,
): void {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='__record_state'").get())
    throw Error('Contributor cache is missing its accepted index; rebuild it explicitly');
  const indexed = db
    .prepare('SELECT profile_id,head_json FROM __record_state WHERE singleton=1')
    .get();
  if (!indexed)
    throw Error('Contributor cache is missing its accepted baseline; rebuild it explicitly');
  if (indexed.profile_id !== profileId || typeof indexed.head_json !== 'string')
    throw Error('Contributor indexed cache has invalid authority binding');
  const baseline = Buffer.from(indexed.head_json);
  const directory = mkdtempSync(resolve(tmpdir(), 'health-contributor-baseline-'));
  try {
    const path = resolve(directory, 'baseline.sqlite');
    rebuildRecordDatabase(path, {
      profileId,
      storage: {
        read: (name) => (name === 'head' ? baseline : storage.read(name)),
        writeImmutable() {
          throw Error('Contributor baseline validation is read only');
        },
        publishHead() {
          throw Error('Contributor baseline validation is read only');
        },
      },
      verifyReferences: contributorOriginalVerifier(root, profileId),
    });
    const accepted = openDatabase(path, profileId);
    try {
      if (rows(db) !== rows(accepted))
        throw Error(
          'Contributor cache conflicts with its indexed accepted authority before recovery',
        );
    } finally {
      accepted.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
/** Full comparison occurs at open/recovery and one-time copy/backup certification. */
export function assertContributorCopyCoherence(
  db: Database,
  root: string,
  profileId: string,
  backup?: Database,
): void {
  if (!db.isOpen || db.isTransaction || (backup && (!backup.isOpen || backup.isTransaction)))
    throw Error('Contributor copy requires an idle source and backup');
  const status = recordDurabilityStatus(db);
  if (!status || status.dirty || status.conflicted)
    throw Error('Contributor copy requires current accepted record authority');
  flushRecordDurability(db);
  const head = selectedContributorHead(root, profileId);
  const directory = mkdtempSync(resolve(tmpdir(), 'health-contributor-copy-'));
  try {
    const path = resolve(directory, 'selected.sqlite');
    rebuildContributorDatabase(path, root, profileId);
    const selected = openDatabase(path, profileId);
    try {
      const accepted = rows(selected);
      if (rows(db) !== accepted || (backup && rows(backup) !== accepted))
        throw Error('Contributor copy cache conflicts with selected record authority');
    } finally {
      selected.close();
    }
    if (selectedContributorHead(root, profileId) !== head)
      throw Error('Contributor copy selected authority changed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
/** Same-profile archive recovery retains journal identity, unlike private copy. */
export function copyContributorAuthority(
  root: string,
  profileId: string,
  targetRoot: string,
): string[] {
  const source = contributorAuthorityPath(root, profileId),
    target = contributorAuthorityPath(targetRoot, profileId);
  const head = selectedContributorHead(root, profileId);
  if (hasContributorAuthority(targetRoot, profileId))
    throw Error('Contributor recovery authority target exists');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const files: string[] = [];
  function copy(from: string, to: string): void {
    const stat = lstatSync(from);
    if (stat.isDirectory()) {
      mkdirSync(to, { mode: 0o700 });
      for (const entry of readdirSync(from))
        if (entry !== 'writer.lock' && !entry.startsWith('.pending-'))
          copy(resolve(from, entry), resolve(to, entry));
    } else if (stat.isFile()) {
      copyFileSync(from, to);
      files.push(relative(targetRoot, to));
    } else throw Error('Contributor authority copy contains nonregular files');
    const fd = openSync(to, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  copy(source, target);
  copy(
    contributorAuthorityMarker(root, profileId),
    contributorAuthorityMarker(targetRoot, profileId),
  );
  if (
    selectedContributorHead(root, profileId) !== head ||
    readFileSync(resolve(target, 'head'), 'utf8') !== head
  )
    throw Error('Contributor authority changed during archive copy');
  return files;
}
