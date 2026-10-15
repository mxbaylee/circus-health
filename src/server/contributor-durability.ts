import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  opendirSync,
  lstatSync,
  readFileSync,
  openSync,
  fsyncSync,
  closeSync,
  existsSync,
} from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { disposableSqlite } from './disposable-sqlite.ts';
import { portableWork } from './portable-work.ts';
import {
  durableWriteRetainedChunksAsync,
  assertDurableChunkArtifactCurrent,
  disposeDurableChunkArtifact,
  type DurableChunkArtifact,
} from './portable.ts';
import { openDatabase, databaseSchemaVersion, type Database } from './database.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  rebuildRecordDatabaseAsync,
  verifyRecordHistoryInputs,
  flushRecordDurability,
  recordDurabilityStatus,
  captureRecordReadOwner,
  assertRecordReadOwnerInterval,
  assertRecordReadOwnerBeforeVerification,
  closeRecordReadOwner,
  type RecordReadOwner,
  type RecordRebuildResult,
  type RecordStepDriverWork,
} from './record-versions.ts';
import {
  acceptValidatedProductionIntakeInputs,
  validatedProductionIntakeInputs,
  validateProductionIntakeAuthority,
} from './intake-state-bootstrap.ts';
import {
  intakeCopySerializedRowKeySteps,
  type IntakeCopyRowKeyQuantum,
} from './intake-copy-json.ts';
import {
  createIntakeCopyIncrementalReader,
  type IntakeCopyIncrementalReader,
} from './intake-copy-incremental-reader.ts';
import { intakeCopyNativeSqlite } from './intake-copy-native-sqlite.ts';
import { captureRecordHeadPhysical } from './record-head-physical.ts';
import {
  finishIntakeCopyStepsAsync,
  captureIntakeCopyReadInterval,
  intakeCopyNativeSelect,
} from './intake-copy-work.ts';
import {
  captureManagedPhysicalScope,
  managedPhysicalScopeCurrent,
  retainManagedPhysicalScope,
} from './clinical-review-physical-epoch.ts';
import { ensureProfileDirectories, profilePaths } from './profile-storage.ts';
import {
  contributorAuthorityPath,
  contributorAuthorityMarker,
  hasContributorAuthority,
  openContributorRecordStorage,
  contributorOriginalVerifier,
  captureContributorRecordReadOwner,
  closeContributorRecordReadOwner,
  contributorRecordBackingLocation,
  contributorRecordReadOwnerCurrent,
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
    // The indexed proof's per-table digests and change sessions let the final
    // selected proof re-read only cache tables that changed since it.
    const indexed = fresh ? undefined : assertIndexedContributorCache(db, root, profileId, storage);
    let status: ReturnType<typeof attachRecordDurability>;
    try {
      status = attachRecordDurability(db, {
        profileId,
        storage,
        verifyReferences: contributorOriginalVerifier(root, profileId),
      });
      validateProductionIntakeAuthority(db, profileId);
      if (indexed)
        contributorCopyCoherence(db, root, profileId, undefined, indexed.baseline, indexed.rebuild);
    } finally {
      indexed?.baseline.close();
      indexed?.rebuild.close();
    }
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
/** Cooperative rebuildContributorDatabase. The read-only storage's HEAD file,
 * profile, authority and objects directories keep their physical identity
 * (inode, size and timestamps; a same-byte replacement changes it) and the
 * HEAD bytes stay selected: both are proven at the start, after every host
 * yield and at completion. Production intake validation still runs in full
 * (or is reused only for byte-identical validated inputs). */
export async function rebuildContributorDatabaseAsync(
  database: string,
  root: string,
  profileId: string,
  { signal, work }: { signal?: AbortSignal; work?: RecordStepDriverWork } = {},
): Promise<RecordRebuildResult> {
  const storage = openContributorRecordStorage(root, profileId, { readOnly: true });
  let physical: ReturnType<typeof captureRecordHeadPhysical> | undefined;
  try {
    const base = contributorAuthorityPath(root, profileId);
    physical = captureRecordHeadPhysical(
      [resolve(base, 'head')],
      [profilePaths(root, profileId).root, base, resolve(base, 'objects')],
    );
    const head = storage.read('head')!;
    const assertCurrent = () => {
      if (!physical!.current()) throw Error('Contributor authority changed during reconstruction');
    };
    const result = await rebuildRecordDatabaseAsync(
      database,
      { profileId, storage, verifyReferences: contributorOriginalVerifier(root, profileId) },
      { assertCurrent, signal, work },
    );
    try {
      const db = openDatabase(database, profileId);
      try {
        validateProductionIntakeAuthority(db, profileId);
      } finally {
        db.close();
      }
      assertCurrent();
      if (!storage.read('head')!.equals(head))
        throw Error('Contributor authority changed during reconstruction');
    } catch (error) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(database + suffix, { force: true });
      throw error;
    }
    return result;
  } finally {
    try {
      physical?.close();
    } finally {
      storage.close();
    }
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
const comparedTables =
  "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name";
const rowEqualityWork = new WeakMap<Database, { tables: number; rows: number }>();
/** Tables and rows each cache handle actually read for open/recovery row equality. */
export function contributorRowEqualityWork(
  db: Database,
): Readonly<{ tables: number; rows: number }> {
  return { ...(rowEqualityWork.get(db) ?? { tables: 0, rows: 0 }) };
}
/** Order-independent digest of one table's normalized rows: the SHA-256 of
 * the sorted SHA-256 digests of the exact previous normalized-row grammar,
 * plus the row count. Equal digests mean equal row multisets. */
function tableRowsDigest(
  db: Database,
  name: string,
  scratch: ReturnType<typeof disposableSqlite>,
): string {
  let work = rowEqualityWork.get(db);
  if (!work) rowEqualityWork.set(db, (work = { tables: 0, rows: 0 }));
  work.tables++;
  // One private scratch transaction per table, not one implicit write
  // transaction per row; the digested rows and their order are unchanged.
  scratch.db.exec('BEGIN; DELETE FROM rows');
  const insert = scratch.db.prepare('INSERT INTO rows VALUES(?)');
  let order: string[] | undefined;
  for (const row of db.prepare(`SELECT * FROM ${quote(name)}`).iterate()) {
    if (name === 'app_meta' && bookkeeping(row.key)) continue;
    work.rows++;
    // The previous grammar sorted keys, then let Object.fromEntries order them.
    order ??= Object.keys(
      Object.fromEntries(
        Object.keys(row)
          .sort()
          .map((key) => [key, 0]),
      ),
    );
    const value = JSON.stringify(Object.fromEntries(order.map((key) => [key, row[key]])));
    insert.run(createHash('sha256').update(value).digest());
  }
  const hash = createHash('sha256');
  let count = 0;
  for (const row of scratch.db.prepare('SELECT digest FROM rows ORDER BY digest').iterate()) {
    hash.update(row.digest as Uint8Array);
    count++;
  }
  scratch.db.exec('COMMIT');
  return hash.update(':' + count).digest('hex');
}
/** Per-table row digests in table-name order. A table whose digest `reuse`
 * supplies is not read again. */
function tableDigests(
  db: Database,
  reuse: (name: string, sql: unknown) => string | undefined = () => undefined,
): Map<string, string> {
  const scratch = disposableSqlite('circus-contributor-compare-');
  try {
    scratch.db.exec('CREATE TABLE rows(digest BLOB NOT NULL)');
    const digests = new Map<string, string>();
    for (const { name, sql } of db.prepare(comparedTables).all())
      digests.set(
        String(name),
        reuse(String(name), sql) ?? tableRowsDigest(db, String(name), scratch),
      );
    return digests;
  } finally {
    scratch.close();
  }
}
function equalDigests(left: Map<string, string>, right: Map<string, string>): boolean {
  return JSON.stringify([...left]) === JSON.stringify([...right]);
}
/** A verified cache baseline: its per-table digests, proven equal to the
 * rebuild of the indexed accepted head, and per-table change sessions opened
 * before those digests were read. */
export interface ContributorCacheBaseline {
  /** The digest of a table still holding exactly the proven rows, if known. */
  unchanged(db: Database, name: string, sql: unknown): string | undefined;
  close(): void;
}
/** Opens per-table change sessions, then reads the cache's table digests.
 *
 * A session records each change by this connection to a row whose primary key
 * has no NULL, and changeset() omits a row whose current values equal its
 * original ones. So when a table had a primary key and no NULL key at capture,
 * its later changeset is empty and its row count is unchanged, every captured
 * row is still present unchanged and no other row exists: the table holds
 * exactly the captured rows. Other connections' commits move data_version, and
 * a changed table definition or any other table is read again. */
export function captureContributorCacheBaseline(db: Database): {
  baseline: ContributorCacheBaseline;
  digests: Map<string, string>;
} {
  const sessions = new Map<
    string,
    { sql: unknown; rows: number; session: ReturnType<Database['createSession']> }
  >();
  const dataVersion = () => db.prepare('PRAGMA data_version').get()!.data_version;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const { session } of sessions.values()) session.close();
  };
  const current = (name: string, sql: unknown) => {
    const tracked = sessions.get(name);
    return (
      !!tracked &&
      tracked.sql === sql &&
      !tracked.session.changeset().length &&
      Number(db.prepare(`SELECT count(*) n FROM ${quote(name)}`).get()!.n) === tracked.rows
    );
  };
  try {
    const version = dataVersion();
    for (const { name, sql } of db.prepare(comparedTables).all()) {
      const table = String(name),
        keys = db
          .prepare('SELECT name FROM pragma_table_info(?) WHERE pk>0')
          .all(table)
          .map((key) => quote(String(key.name)));
      if (
        !keys.length ||
        db
          .prepare(
            `SELECT 1 FROM ${quote(table)} WHERE ${keys.join(' IS NULL OR ')} IS NULL LIMIT 1`,
          )
          .get()
      )
        continue;
      const session = db.createSession({ table });
      sessions.set(table, {
        sql,
        session,
        rows: Number(db.prepare(`SELECT count(*) n FROM ${quote(table)}`).get()!.n),
      });
    }
    const digests = tableDigests(db);
    // The digests describe the captured rows only if nothing moved while read.
    for (const { name, sql } of db.prepare(comparedTables).all()) {
      const table = String(name);
      if (!sessions.has(table) || current(table, sql)) continue;
      sessions.get(table)!.session.close();
      sessions.delete(table);
    }
    if (dataVersion() !== version) close();
    return {
      digests,
      baseline: {
        unchanged(target, name, sql) {
          if (closed || target !== db || dataVersion() !== version || !current(name, sql))
            return undefined;
          return digests.get(name);
        },
        close,
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
/** Verify the cache against its own accepted baseline before catch-up can
 * overwrite rows. A newer selected head authorizes recovery of acknowledged
 * state, never silent erasure of conflicting unacknowledged cache edits. */
function sameHeadReference(selected: string, indexed: Buffer): boolean {
  try {
    const left = JSON.parse(selected) as Record<string, unknown>,
      right = JSON.parse(indexed.toString('utf8')) as Record<string, unknown>;
    return (
      !!left &&
      !!right &&
      Object.keys(left).sort().join() === 'bytes,name,sha256' &&
      Object.keys(right).sort().join() === 'bytes,name,sha256' &&
      left.name === right.name &&
      left.sha256 === right.sha256 &&
      left.bytes === right.bytes
    );
  } catch {
    return false;
  }
}
/** The indexed head's complete reconstruction, kept until attach completes. */
interface ContributorIndexedRebuild {
  path: string;
  head: Buffer;
  digests: Map<string, string>;
  close(): void;
}
const attachReconstructionWork = new WeakMap<
  Database,
  { reconstructions: number; reused: number; reverifiedVersions: number }
>();
/** Complete record reconstructions an attach performed for this handle, how
 * many coherence proofs reused the indexed reconstruction for byte-identical
 * selected history, and the versions those reuses re-verified physically. */
export function contributorAttachReconstructionWork(
  db: Database,
): Readonly<{ reconstructions: number; reused: number; reverifiedVersions: number }> {
  return {
    ...(attachReconstructionWork.get(db) ?? {
      reconstructions: 0,
      reused: 0,
      reverifiedVersions: 0,
    }),
  };
}
function countAttachWork(
  db: Database,
  key: 'reconstructions' | 'reused' | 'reverifiedVersions',
  amount = 1,
): void {
  let work = attachReconstructionWork.get(db);
  if (!work)
    attachReconstructionWork.set(
      db,
      (work = { reconstructions: 0, reused: 0, reverifiedVersions: 0 }),
    );
  work[key] += amount;
}
function assertIndexedContributorCache(
  db: Database,
  root: string,
  profileId: string,
  storage: ContributorRecordStorage,
): { baseline: ContributorCacheBaseline; rebuild: ContributorIndexedRebuild } {
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
  // The cache is read before the baseline rebuild, with its change sessions.
  const captured = captureContributorCacheBaseline(db);
  let complete = false;
  const directory = mkdtempSync(resolve(tmpdir(), 'health-contributor-baseline-'));
  try {
    const path = resolve(directory, 'baseline.sqlite');
    countAttachWork(db, 'reconstructions');
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
    let digests: Map<string, string>;
    try {
      digests = tableDigests(accepted);
      if (!equalDigests(captured.digests, digests))
        throw Error(
          'Contributor cache conflicts with its indexed accepted authority before recovery',
        );
    } finally {
      accepted.close();
    }
    complete = true;
    return {
      baseline: captured.baseline,
      rebuild: {
        path,
        head: baseline,
        digests,
        close: () => rmSync(directory, { recursive: true, force: true }),
      },
    };
  } finally {
    if (!complete) {
      captured.baseline.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
/** Full comparison occurs at open/recovery and one-time copy/backup certification.
 * The selected rebuild is always read completely; with a verified open baseline,
 * only cache tables changed since that proof are read again. */
export function assertContributorCopyCoherence(
  db: Database,
  root: string,
  profileId: string,
  backup?: Database,
  baseline?: ContributorCacheBaseline,
): void {
  contributorCopyCoherence(db, root, profileId, backup, baseline);
}
/** With `indexed`, a selected HEAD whose bytes are the indexed head's bytes
 * reuses that complete reconstruction (its rows and table digests) instead of
 * replaying the same history into SQLite again. Every physical input that a
 * second reconstruction would read is still read and proven: HEAD, every
 * commit and segment object by sha256, every decoded version's originals
 * (bytes, sha256 and fsync), then production intake validation of the reused
 * reconstruction. Any other selected head is reconstructed in full. */
function contributorCopyCoherence(
  db: Database,
  root: string,
  profileId: string,
  backup?: Database,
  baseline?: ContributorCacheBaseline,
  indexed?: ContributorIndexedRebuild,
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
    let path = resolve(directory, 'selected.sqlite'),
      expected: Map<string, string> | undefined;
    // The HEAD reference names the commit and its sha256, which authenticates
    // all history below it; equal references select byte-identical history.
    if (indexed && sameHeadReference(head, indexed.head)) {
      const storage = openContributorRecordStorage(root, profileId, { readOnly: true });
      try {
        const verified = verifyRecordHistoryInputs(storage, {
          profileId,
          schemaVersion: databaseSchemaVersion(db),
          verifyReferences: contributorOriginalVerifier(root, profileId),
        });
        if (verified.head !== head) throw Error('Contributor copy selected authority changed');
        countAttachWork(db, 'reverifiedVersions', verified.versions);
      } finally {
        storage.close();
      }
      path = indexed.path;
      const reused = openDatabase(path, profileId);
      try {
        validateProductionIntakeAuthority(reused, profileId);
      } finally {
        reused.close();
      }
      expected = indexed.digests;
      countAttachWork(db, 'reused');
    } else {
      if (indexed) countAttachWork(db, 'reconstructions');
      rebuildContributorDatabase(path, root, profileId);
    }
    const selected = openDatabase(path, profileId);
    try {
      expected ??= tableDigests(selected);
      if (
        !equalDigests(
          tableDigests(db, (name, sql) => baseline?.unchanged(db, name, sql)),
          expected,
        ) ||
        (backup && !equalDigests(tableDigests(backup), expected))
      )
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

declare const contributorCopyBrand: unique symbol;
export interface ContributorCopyCertification {
  readonly [contributorCopyBrand]: true;
}
interface ContributorCopyData {
  source: Database;
  root: string;
  profileId: string;
  objects: ReturnType<typeof captureRecordHeadPhysical>;
  directory: string;
  selected: Database;
  storage: ContributorRecordStorage;
  owner: RecordReadOwner;
  physicalScope: object;
  releasePhysicalScope: () => void;
  sourceCurrent: () => void;
  selectedCurrent: () => void;
  worker: ContributorCopyWorkerSession;
  backupCurrent?: () => void;
  releaseBackup?: () => void;
  portableArtifact?: DurableChunkArtifact;
}
const contributorCopies = new WeakMap<ContributorCopyCertification, ContributorCopyData>();
const contributorCopyDisposals = new WeakMap<ContributorCopyCertification, Promise<void>>();
const equalityWork = new WeakMap<Database, { rows: number; bytes: number }>();
/** Complete original proofs, nested native checks, guarded windows (each one
 * proof and at most one yield) and the bounded comparison quanta they ran. */
interface ComparisonGuardWork {
  fullChecks: number;
  nestedChecks: number;
  steps: number;
  quanta: number;
}
const comparisonGuardWork = new WeakMap<Database, ComparisonGuardWork>();
interface CopyTraversalWork {
  sourceRows: number;
  selectedRows: number;
  backupRows: number;
}
const comparisonTraversalWork = new WeakMap<Database, CopyTraversalWork>();
const portableSnapshotWork = new WeakMap<Database, { rows: number; bytes: number }>();

/** Backup rows encoded during comparison, including excluded bookkeeping. */
export function contributorCopyPortableSnapshotWork(db: Database): Readonly<{
  rows: number;
  bytes: number;
}> {
  return { ...(portableSnapshotWork.get(db) ?? { rows: 0, bytes: 0 }) };
}
const workerWork = new WeakMap<
  Database,
  { boots: number; physicalSweeps: number; exits: number }
>();

export function contributorCopyWorkerWork(
  db: Database,
): Readonly<{ boots: number; physicalSweeps: number; exits: number }> {
  return { ...(workerWork.get(db) ?? { boots: 0, physicalSweeps: 0, exits: 0 }) };
}

/** Counts rows actually encoded by native copy equality, per database handle. */
export function contributorCopyEqualityWork(
  db: Database,
): Readonly<{ rows: number; bytes: number }> {
  return { ...(equalityWork.get(db) ?? { rows: 0, bytes: 0 }) };
}

export function contributorCopyComparisonGuardWork(db: Database): Readonly<ComparisonGuardWork> {
  return {
    ...(comparisonGuardWork.get(db) ?? { fullChecks: 0, nestedChecks: 0, steps: 0, quanta: 0 }),
  };
}

export function contributorCopyComparisonTraversalWork(db: Database): Readonly<CopyTraversalWork> {
  return {
    ...(comparisonTraversalWork.get(db) ?? {
      sourceRows: 0,
      selectedRows: 0,
      backupRows: 0,
    }),
  };
}

function countEqualityRow(db: Database, key: string): void {
  let work = equalityWork.get(db);
  if (!work) {
    work = { rows: 0, bytes: 0 };
    equalityWork.set(db, work);
  }
  work.rows++;
  work.bytes += Number(key.slice(0, key.indexOf(':')));
}

const copyCurrentChecks = new WeakMap<Database, number>();
const workerMessageChecks = new WeakMap<Database, number>();
const workerIntakeValidations = new WeakMap<Database, number>();
/** Complete production intake validations run by copy workers for this source. */
export function contributorCopyWorkerIntakeValidations(db: Database): number {
  return workerIntakeValidations.get(db) ?? 0;
}
/** Counts complete original copy proofs per source handle, including failures. */
export function contributorCopyCurrentChecks(db: Database): number {
  return copyCurrentChecks.get(db) ?? 0;
}
/** Counts proofs taken on worker messages, one per main-thread message turn. */
export function contributorCopyWorkerMessageChecks(db: Database): number {
  return workerMessageChecks.get(db) ?? 0;
}

function assertCopyCurrent(
  data: Omit<ContributorCopyData, 'selected' | 'worker' | 'selectedCurrent'>,
): void {
  copyCurrentChecks.set(data.source, (copyCurrentChecks.get(data.source) ?? 0) + 1);
  data.sourceCurrent();
  data.backupCurrent?.();
  if (data.portableArtifact) assertDurableChunkArtifactCurrent(data.portableArtifact);
  if ('selectedCurrent' in data) (data.selectedCurrent as () => void)();
  const status = recordDurabilityStatus(data.source);
  if (
    !data.source.isOpen ||
    data.source.isTransaction ||
    !status ||
    status.dirty ||
    status.conflicted
  )
    throw Error('Contributor copy original durability changed');
  if (
    data.source.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
    data.profileId
  )
    throw Error('Contributor copy original owner changed');
  if (!managedPhysicalScopeCurrent(data.physicalScope))
    throw Error('Contributor copy original physical scope changed');
  if (!data.objects.current()) throw Error('Contributor copy original objects directory changed');
  // This retained owner checks the original HEAD bytes, marker and factory;
  // reopening a backend here repeats that proof without strengthening it.
  assertRecordReadOwnerBeforeVerification(data.source, data.owner);
  data.sourceCurrent();
  data.backupCurrent?.();
  if (data.portableArtifact) assertDurableChunkArtifactCurrent(data.portableArtifact);
  if ('selectedCurrent' in data) (data.selectedCurrent as () => void)();
}

interface ContributorCopyWorkerSession {
  run(
    kind: 'prepare' | 'verify',
    signal: AbortSignal | undefined,
    checkpoint: () => void,
  ): Promise<void>;
  close(): Promise<void>;
}

function createContributorCopyWorkerSession(
  db: Database,
  data: { root: string; profileId: string; directory: string; path: string },
): ContributorCopyWorkerSession {
  intakeCopyNativeSqlite();
  const worker = new Worker(new URL('./contributor-copy-worker.ts', import.meta.url), {
    workerData: { ...data, validatedIntakeInputs: validatedProductionIntakeInputs() },
  });
  const counts = workerWork.get(db) ?? { boots: 0, physicalSweeps: 0, exits: 0 };
  counts.boots++;
  workerWork.set(db, counts);
  let ready = false,
    exited = false,
    closed = false,
    busy = false,
    sequence = 0,
    failure: unknown,
    pending:
      | {
          id: number;
          scans: number;
          checkpoint: () => void;
          resolve(): void;
          reject(error: unknown): void;
        }
      | undefined,
    closePromise: Promise<void> | undefined;
  let close!: () => Promise<void>;
  let readyResolve!: () => void, readyReject!: (error: unknown) => void, exitResolve!: () => void;
  const boot = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    }),
    exit = new Promise<void>((resolve) => {
      exitResolve = resolve;
    });
  const poison = (error: unknown) => {
    failure ??= error;
    readyReject(failure);
    pending?.reject(failure);
    pending = undefined;
    closed = true;
    void close().catch(() => {});
  };
  worker.on('error', poison);
  worker.on('exit', () => {
    exited = true;
    counts.exits++;
    exitResolve();
    if (!closed) poison(Error('Contributor copy worker exited without certification'));
  });
  worker.on(
    'message',
    (message: {
      ready?: true;
      id?: number;
      progress?: true;
      scanComplete?: true;
      failure?: string;
      prepared?: { validatedIntakeInputs?: unknown; intakeValidations?: unknown };
    }) => {
      try {
        if (message.ready) {
          if (ready || closed) throw Error('Contributor copy worker protocol');
          ready = true;
          readyResolve();
          return;
        }
        if (!ready || closed || !pending || message.id !== pending.id)
          throw Error('Contributor copy worker protocol');
        workerMessageChecks.set(db, (workerMessageChecks.get(db) ?? 0) + 1);
        if (message.scanComplete) {
          if (++pending.scans > 2) throw Error('Contributor copy worker protocol');
          counts.physicalSweeps++;
          pending.checkpoint();
          return;
        }
        pending.checkpoint();
        if (message.progress) return;
        if (message.failure) throw Error(message.failure);
        if (!message.prepared || pending.scans !== 2)
          throw Error('Contributor copy worker protocol');
        const validations = message.prepared.intakeValidations;
        if (!Number.isSafeInteger(validations) || (validations as number) < 0)
          throw Error('Contributor copy worker protocol');
        workerIntakeValidations.set(
          db,
          (workerIntakeValidations.get(db) ?? 0) + (validations as number),
        );
        // The worker completely validated exactly these inputs in this process.
        acceptValidatedProductionIntakeInputs(message.prepared.validatedIntakeInputs);
        const complete = pending;
        pending = undefined;
        complete.resolve();
      } catch (error) {
        poison(error);
      }
    },
  );
  close = (): Promise<void> => {
    if (!closePromise) {
      closed = true;
      if (pending) {
        pending.reject(Error('Contributor copy worker disposed'));
        pending = undefined;
      }
      closePromise = exited ? exit : worker.terminate().then(() => exit);
    }
    return closePromise;
  };
  return {
    async run(kind, signal, checkpoint) {
      if (busy || closed || failure) throw failure ?? Error('Contributor copy worker unavailable');
      busy = true;
      const abort = () => poison(signal!.reason ?? Error('Contributor copy aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        await boot;
        signal?.throwIfAborted();
        checkpoint();
        const id = ++sequence;
        await new Promise<void>((resolve, reject) => {
          pending = { id, scans: 0, checkpoint, resolve, reject };
          worker.postMessage({ id, kind });
        });
        signal?.throwIfAborted();
        checkpoint();
      } catch (error) {
        poison(error);
        await close();
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
        busy = false;
      }
    },
    close,
  };
}

function* equalCopyRowsSteps(
  left: Database,
  right: Database,
  leftReader: IntakeCopyIncrementalReader,
  rightReader: IntakeCopyIncrementalReader,
  checkpoint: () => void,
  traversal?: CopyTraversalWork,
): Generator<void, boolean> {
  const names = (db: Database) =>
    intakeCopyNativeSelect(
      db,
      "SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name",
      checkpoint,
    )
      .all()
      .map((row) => String(row.name));
  const tables = names(left);
  if (
    JSON.stringify(tables) !== JSON.stringify(names(right)) ||
    JSON.stringify(tables) !== JSON.stringify(leftReader.tables()) ||
    JSON.stringify(tables) !== JSON.stringify(rightReader.tables())
  )
    return false;
  const scratch = disposableSqlite('contributor-copy-comparison-');
  try {
    scratch.db.exec('CREATE TABLE comparison(key TEXT PRIMARY KEY,count INTEGER NOT NULL)');
    const insert = scratch.db.prepare(
      'INSERT INTO comparison VALUES(?,1) ON CONFLICT(key) DO UPDATE SET count=count+1',
    );
    const decrement = scratch.db.prepare(
      'UPDATE comparison SET count=count-1 WHERE key=? AND count>0',
    );
    const quantum: IntakeCopyRowKeyQuantum = { bytes: 0, parts: 0, rows: 0 };
    const reset = () => {
      quantum.bytes = quantum.parts = quantum.rows = 0;
    };
    const rowDone = function* (): Generator<void> {
      if (++quantum.rows === 64) {
        yield;
        reset();
      }
    };
    const flush = function* (): Generator<void> {
      if (quantum.rows || quantum.parts) {
        yield;
        reset();
      }
    };
    for (const table of tables) {
      // The private multiplicity index for one table is one scratch
      // transaction rather than one implicit write transaction per row.
      if (scratch.db.isTransaction) scratch.db.exec('COMMIT');
      scratch.db.exec('BEGIN; DELETE FROM comparison');
      const leftColumns = leftReader.columns(table);
      const rightColumns = rightReader.columns(table);
      if (JSON.stringify(leftColumns) !== JSON.stringify(rightColumns)) return false;
      for (const rowid of leftReader.rowIds(table)) {
        checkpoint();
        if (table === 'app_meta' && leftReader.bookkeepingKey(rowid)) {
          yield* rowDone();
          continue;
        }
        const key = yield* intakeCopySerializedRowKeySteps(
          leftReader.rowPieces(table, rowid, leftColumns),
          quantum,
        );
        countEqualityRow(left, key);
        if (traversal) traversal.sourceRows++;
        insert.run(key);
        yield* rowDone();
      }
      yield* flush();
      for (const rowid of rightReader.rowIds(table)) {
        checkpoint();
        if (table === 'app_meta' && rightReader.bookkeepingKey(rowid)) {
          yield* rowDone();
          continue;
        }
        const key = yield* intakeCopySerializedRowKeySteps(
          rightReader.rowPieces(table, rowid, rightColumns),
          quantum,
        );
        countEqualityRow(right, key);
        if (traversal) traversal.selectedRows++;
        if (!decrement.run(key).changes) return false;
        yield* rowDone();
      }
      yield* flush();
      if (scratch.db.prepare('SELECT 1 FROM comparison WHERE count<>0 LIMIT 1').get()) return false;
    }
    return true;
  } finally {
    scratch.close();
  }
}

function* equalThreeCopyRowsSteps(
  source: Database,
  backup: Database,
  selected: Database,
  sourceReader: IntakeCopyIncrementalReader,
  backupReader: IntakeCopyIncrementalReader,
  selectedReader: IntakeCopyIncrementalReader,
  checkpoint: () => void,
  traversal: CopyTraversalWork,
  output?: { profileId: string; schemaVersion: number; work: { rows: number; bytes: number } },
): Generator<void | string, boolean> {
  const names = (db: Database) =>
    intakeCopyNativeSelect(
      db,
      "SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name",
      checkpoint,
    )
      .all()
      .map((row) => String(row.name));
  const tables = names(source);
  if (
    JSON.stringify(tables) !== JSON.stringify(names(backup)) ||
    JSON.stringify(tables) !== JSON.stringify(names(selected)) ||
    JSON.stringify(tables) !== JSON.stringify(sourceReader.tables()) ||
    JSON.stringify(tables) !== JSON.stringify(backupReader.tables()) ||
    JSON.stringify(tables) !== JSON.stringify(selectedReader.tables())
  )
    return false;
  const scratch = disposableSqlite('contributor-copy-comparison-');
  try {
    if (output)
      yield JSON.stringify({
        format: 'circus-health-portable-v1',
        profileId: output.profileId,
        schemaVersion: output.schemaVersion,
      }).slice(0, -1) + ',"tables":{';
    scratch.db.exec(
      'CREATE TABLE comparison(key TEXT PRIMARY KEY,source_count INTEGER NOT NULL,backup_count INTEGER NOT NULL)',
    );
    const insert = scratch.db.prepare(
      'INSERT INTO comparison VALUES(?,1,1) ON CONFLICT(key) DO UPDATE SET source_count=source_count+1,backup_count=backup_count+1',
    );
    const sourceDecrement = scratch.db.prepare(
      'UPDATE comparison SET source_count=source_count-1 WHERE key=? AND source_count>0',
    );
    const backupDecrement = scratch.db.prepare(
      'UPDATE comparison SET backup_count=backup_count-1 WHERE key=? AND backup_count>0',
    );
    const remaining = scratch.db.prepare(
      'SELECT 1 FROM comparison WHERE source_count<>0 OR backup_count<>0 LIMIT 1',
    );
    const quantum: IntakeCopyRowKeyQuantum = { bytes: 0, parts: 0, rows: 0 };
    const reset = () => {
      quantum.bytes = quantum.parts = quantum.rows = 0;
    };
    const rowDone = function* (): Generator<void> {
      if (++quantum.rows === 64) {
        yield;
        reset();
      }
    };
    const flush = function* (): Generator<void> {
      if (quantum.rows || quantum.parts) {
        yield;
        reset();
      }
    };
    let firstTable = true;
    for (const table of tables) {
      if (output) {
        if (!firstTable) yield ',';
        firstTable = false;
        yield JSON.stringify(table) + ':[';
      }
      // The private multiplicity index for one table is one scratch
      // transaction rather than one implicit write transaction per row.
      if (scratch.db.isTransaction) scratch.db.exec('COMMIT');
      scratch.db.exec('BEGIN; DELETE FROM comparison');
      const selectedColumns = selectedReader.columns(table);
      if (
        JSON.stringify(selectedColumns) !== JSON.stringify(sourceReader.columns(table)) ||
        JSON.stringify(selectedColumns) !== JSON.stringify(backupReader.columns(table))
      )
        return false;
      const visit = function* (
        db: Database,
        reader: IntakeCopyIncrementalReader,
        role: keyof CopyTraversalWork,
        apply: (key: string) => boolean,
      ): Generator<void | string, boolean> {
        let firstRow = true;
        for (const rowid of reader.rowIds(table)) {
          checkpoint();
          const bookkeeping = table === 'app_meta' && reader.bookkeepingKey(rowid);
          const emit = !!output && role === 'backupRows';
          if (bookkeeping && !emit) {
            yield* rowDone();
            continue;
          }
          if (emit) {
            if (!firstRow) yield ',';
            firstRow = false;
            output!.work.rows++;
          }
          const pieces = reader.rowPieces(
            table,
            rowid,
            selectedColumns,
            output ? 'select' : 'sorted',
          );
          let key: string;
          if (emit) {
            const keyed = intakeCopySerializedRowKeySteps(pieces, quantum, true);
            try {
              for (;;) {
                const next = keyed.next();
                if (next.done) {
                  key = next.value;
                  break;
                }
                if (typeof next.value === 'string')
                  output!.work.bytes += Buffer.byteLength(next.value);
                yield next.value;
              }
            } finally {
              keyed.return(undefined as never);
            }
          } else key = yield* intakeCopySerializedRowKeySteps(pieces, quantum);
          if (bookkeeping) {
            yield* rowDone();
            continue;
          }
          countEqualityRow(db, key);
          traversal[role]++;
          if (!apply(key)) return false;
          yield* rowDone();
        }
        yield* flush();
        return true;
      };
      if (!(yield* visit(selected, selectedReader, 'selectedRows', (key) => !!insert.run(key))))
        return false;
      if (
        !(yield* visit(
          source,
          sourceReader,
          'sourceRows',
          (key) => !!sourceDecrement.run(key).changes,
        ))
      )
        return false;
      if (
        !(yield* visit(
          backup,
          backupReader,
          'backupRows',
          (key) => !!backupDecrement.run(key).changes,
        ))
      )
        return false;
      if (remaining.get()) return false;
      if (output) yield ']';
    }
    if (output) yield '}}';
    return true;
  } finally {
    scratch.close();
  }
}

/** Most bounded comparison quanta run back to back inside one guarded window. */
export const CONTRIBUTOR_COPY_COMPARISON_WINDOW_QUANTA = 16;
function* guardedCopyComparisonSteps<T>(
  steps: Generator<void | string, T>,
  checkpoint: () => void,
  work: ComparisonGuardWork,
): Generator<void | string, T> {
  const full = () => {
    work.fullChecks++;
    checkpoint();
  };
  // Output pieces do not consume comparison quanta. Their fixed writer takes
  // the same full proof around its host yields; microtask callbacks can also
  // run during string pulls, so the closing interval proofs remain mandatory.
  let window = 1;
  try {
    for (;;) {
      // Every resumed window follows a complete original proof, closing the
      // yield window and the preceding window. A completed result is proven
      // again before it leaves; the finally proof closes every exit, including errors.
      full();
      work.steps++;
      for (let quanta = 0; quanta < window; quanta++) {
        const next = steps.next();
        if (!next.done && typeof next.value === 'string') {
          yield next.value;
          quanta--;
          continue;
        }
        work.quanta++;
        if (next.done) {
          full();
          return next.value;
        }
      }
      window = Math.min(window * 2, CONTRIBUTOR_COPY_COMPARISON_WINDOW_QUANTA);
      yield;
    }
  } finally {
    try {
      steps.return(undefined as never);
    } finally {
      full();
    }
  }
}

export async function prepareContributorCopyCertification(
  db: Database,
  root: string,
  profileId: string,
  backup?: Database,
  signal?: AbortSignal,
): Promise<ContributorCopyCertification> {
  return prepareContributorCopyCertificationInternal(db, root, profileId, backup, signal);
}

interface BackupPortableOutput {
  path: string;
  current: () => void;
  close: () => void;
  finishRead: () => void;
}
const nativeBackupLocation = DatabaseSync.prototype.location;

/** One unpublished backup operation owns both original snapshot and output. */
export async function prepareContributorBackupCertification(
  db: Database,
  root: string,
  profileId: string,
  backup: Database,
  outputPath: string,
  signal?: AbortSignal,
): Promise<ContributorCopyCertification> {
  const snapshotPath = Reflect.apply(nativeBackupLocation, backup, []);
  if (
    !snapshotPath ||
    resolve(snapshotPath) !== snapshotPath ||
    resolve(outputPath) !== outputPath ||
    dirname(snapshotPath) !== dirname(outputPath) ||
    snapshotPath === outputPath ||
    existsSync(outputPath)
  )
    throw Error('Contributor backup output binding changed');
  const physical = captureRecordHeadPhysical([snapshotPath], [dirname(snapshotPath)]);
  let retained = false;
  try {
    const interval = captureIntakeCopyReadInterval(backup, profileId);
    let reading = true;
    const current = () => {
      if (reading) interval();
      if (!physical.current()) throw Error('Contributor backup original snapshot changed');
      if (reading) interval();
    };
    current();
    const certification = await prepareContributorCopyCertificationInternal(
      db,
      root,
      profileId,
      backup,
      signal,
      {
        path: outputPath,
        current,
        close: physical.close,
        finishRead() {
          current();
          // All snapshot SQL work has ended. Publication retains its original
          // complete physical stamp even after recovery closes the readonly DB.
          reading = false;
          current();
        },
      },
    );
    try {
      assertContributorCopyCertificationCurrent(certification);
    } catch (error) {
      try {
        const artifact = contributorCopies.get(certification)?.portableArtifact;
        if (artifact) disposeDurableChunkArtifact(artifact, true);
      } finally {
        await disposeContributorCopyCertification(certification);
      }
      throw error;
    }
    retained = true;
    return certification;
  } finally {
    if (!retained) {
      physical.close();
    }
  }
}

async function prepareContributorCopyCertificationInternal(
  db: Database,
  root: string,
  profileId: string,
  backup?: Database,
  signal?: AbortSignal,
  output?: BackupPortableOutput,
): Promise<ContributorCopyCertification> {
  const sourceCurrent = captureIntakeCopyReadInterval(db, profileId);
  const storage = attached.get(db);
  if (!storage) throw Error('Contributor copy authority requires genuine attached writer');
  const locationOwner = captureContributorRecordReadOwner(storage);
  let base: string, owner: ReturnType<typeof captureRecordReadOwner>;
  try {
    const location = locationOwner && contributorRecordBackingLocation(storage, locationOwner);
    if (!location || resolve(location.root) !== resolve(root) || location.profileId !== profileId)
      throw Error('Contributor copy attached authority location differs');
    // Validate marker semantics once before retaining its original physical proof.
    selectedContributorHead(root, profileId);
    if (!contributorRecordReadOwnerCurrent(storage, locationOwner!))
      throw Error('Contributor copy attached authority changed during admission');
    base = location.base;
    owner = captureRecordReadOwner(db, profileId);
    if (!contributorRecordReadOwnerCurrent(storage, locationOwner!)) {
      closeRecordReadOwner(owner);
      throw Error('Contributor copy attached authority changed during owner capture');
    }
  } finally {
    if (locationOwner) closeContributorRecordReadOwner(locationOwner);
  }
  let physicalScope: ReturnType<typeof captureManagedPhysicalScope>;
  try {
    physicalScope = captureManagedPhysicalScope(resolve(root, 'data/profiles', profileId));
  } catch (error) {
    closeRecordReadOwner(owner);
    throw error;
  }
  if (!owner || !physicalScope) {
    closeRecordReadOwner(owner);
    throw Error('Contributor copy physical source unavailable');
  }
  let directory: string | undefined,
    selected: Database | undefined,
    worker: ContributorCopyWorkerSession | undefined,
    sourceReader: IntakeCopyIncrementalReader | undefined,
    selectedReader: IntakeCopyIncrementalReader | undefined,
    backupReader: IntakeCopyIncrementalReader | undefined,
    objects: ReturnType<typeof captureRecordHeadPhysical> | undefined,
    releasePhysicalScope: (() => void) | undefined,
    portableArtifact: DurableChunkArtifact | undefined,
    complete = false;
  try {
    releasePhysicalScope = retainManagedPhysicalScope(physicalScope);
    objects = captureRecordHeadPhysical([], [resolve(base, 'objects')]);
    directory = mkdtempSync(resolve(tmpdir(), 'health-contributor-copy-'));
    const initial: Omit<ContributorCopyData, 'selected' | 'selectedCurrent' | 'worker'> = {
      source: db,
      root,
      profileId,
      objects,
      directory,
      storage,
      owner,
      physicalScope,
      releasePhysicalScope,
      sourceCurrent,
      backupCurrent: output?.current,
      releaseBackup: output?.close,
    };
    const checkpoint = () => {
      signal?.throwIfAborted();
      assertCopyCurrent(initial);
    };
    const comparisonWork = { fullChecks: 0, nestedChecks: 0, steps: 0, quanta: 0 };
    comparisonGuardWork.set(db, comparisonWork);
    const traversal = { sourceRows: 0, selectedRows: 0, backupRows: 0 };
    comparisonTraversalWork.set(db, traversal);
    const portableCounters = { rows: 0, bytes: 0 };
    portableSnapshotWork.set(db, portableCounters);
    let comparisonPhase = false;
    const readerCheckpoint = () => {
      if (comparisonPhase) {
        comparisonWork.nestedChecks++;
        signal?.throwIfAborted();
      } else checkpoint();
    };
    checkpoint();
    const path = resolve(directory, 'selected.sqlite');
    worker = createContributorCopyWorkerSession(db, { root, profileId, directory, path });
    await worker.run('prepare', signal, checkpoint);
    selected = openDatabase(path, profileId);
    const selectedCurrent = captureIntakeCopyReadInterval(selected, profileId);
    const comparisonCheckpoint = () => {
      checkpoint();
      selectedCurrent();
    };
    sourceReader = await createIntakeCopyIncrementalReader(db, readerCheckpoint);
    selectedReader = await createIntakeCopyIncrementalReader(selected, readerCheckpoint);
    if (backup) backupReader = await createIntakeCopyIncrementalReader(backup, readerCheckpoint);
    comparisonCheckpoint();
    comparisonPhase = true;
    try {
      const comparison = backup
        ? equalThreeCopyRowsSteps(
            db,
            backup,
            selected,
            sourceReader,
            backupReader!,
            selectedReader,
            readerCheckpoint,
            traversal,
            output
              ? { profileId, schemaVersion: databaseSchemaVersion(backup), work: portableCounters }
              : undefined,
          )
        : equalCopyRowsSteps(
            db,
            selected,
            sourceReader,
            selectedReader,
            readerCheckpoint,
            traversal,
          );
      const guarded = guardedCopyComparisonSteps(comparison, comparisonCheckpoint, comparisonWork);
      if (output) {
        const chunks = async function* (): AsyncGenerator<string> {
          try {
            for (;;) {
              signal?.throwIfAborted();
              const next = guarded.next();
              if (next.done) {
                if (!next.value)
                  throw Error('Contributor copy cache conflicts with selected record authority');
                return;
              }
              if (typeof next.value === 'string') yield next.value;
              else await new Promise<void>((resolve) => setImmediate(resolve));
            }
          } finally {
            guarded.return(undefined as never);
          }
        };
        portableArtifact = await durableWriteRetainedChunksAsync(
          output.path,
          chunks(),
          comparisonCheckpoint,
        );
        initial.portableArtifact = portableArtifact;
        comparisonCheckpoint();
      } else {
        const onlyQuanta = function* (): Generator<void, boolean> {
          try {
            for (;;) {
              const next = guarded.next();
              if (next.done) return next.value;
              if (typeof next.value === 'string') throw Error('Unexpected contributor copy output');
              yield;
            }
          } finally {
            guarded.return(undefined as never);
          }
        };
        if (!(await finishIntakeCopyStepsAsync(onlyQuanta(), signal)))
          throw Error('Contributor copy cache conflicts with selected record authority');
      }
    } finally {
      comparisonPhase = false;
      comparisonCheckpoint();
    }
    checkpoint();
    selectedCurrent();
    sourceReader.close();
    selectedReader.close();
    backupReader?.close();
    sourceReader = selectedReader = backupReader = undefined;
    await worker.run('verify', signal, checkpoint);
    output?.finishRead();
    checkpoint();
    selectedCurrent();
    const certification = Object.freeze({}) as ContributorCopyCertification;
    contributorCopies.set(certification, {
      ...initial,
      selected,
      selectedCurrent,
      worker,
    });
    complete = true;
    return certification;
  } finally {
    try {
      try {
        sourceReader?.close();
      } finally {
        try {
          selectedReader?.close();
        } finally {
          backupReader?.close();
        }
      }
    } finally {
      if (!complete) {
        try {
          if (portableArtifact) disposeDurableChunkArtifact(portableArtifact, true);
        } finally {
          try {
            await worker?.close();
          } finally {
            try {
              selected?.close();
            } finally {
              try {
                if (directory) rmSync(directory, { recursive: true, force: true });
              } finally {
                try {
                  closeRecordReadOwner(owner);
                } finally {
                  try {
                    objects?.close();
                  } finally {
                    releasePhysicalScope?.();
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

export async function contributorCopySourceTextInventory(
  certification: ContributorCopyCertification,
  source: Database,
  root: string,
  profileId: string,
  signal?: AbortSignal,
): Promise<{ has(key: string): boolean; assertCurrent(): void }> {
  const data = contributorCopies.get(certification);
  if (!data || data.source !== source || data.root !== root || data.profileId !== profileId)
    throw Error('Contributor copy certification scope');
  const checkpoint = () => {
    signal?.throwIfAborted();
    assertCopyCurrent(data);
  };
  // Both native SQL intervals were captured before the initial exact comparison.
  // Their unchanged witnesses retain that comparison for this inventory lookup.
  checkpoint();
  await data.worker.run('verify', signal, checkpoint);
  checkpoint();
  return {
    assertCurrent: checkpoint,
    has(key) {
      checkpoint();
      const found = !!data.selected.prepare('SELECT 1 FROM app_meta WHERE key=?').get(key);
      checkpoint();
      return found;
    },
  };
}

export function disposeContributorCopyCertification(
  certification: ContributorCopyCertification,
): Promise<void> {
  const inFlight = contributorCopyDisposals.get(certification);
  if (inFlight) return inFlight;
  const data = contributorCopies.get(certification);
  if (!data) return Promise.resolve();
  contributorCopies.delete(certification);
  const cleanup = (async () => {
    try {
      await data.worker.close();
    } finally {
      try {
        data.selected.close();
      } finally {
        try {
          rmSync(data.directory, { recursive: true, force: true });
        } finally {
          try {
            closeRecordReadOwner(data.owner);
          } finally {
            try {
              data.objects.close();
            } finally {
              try {
                data.releasePhysicalScope();
              } finally {
                try {
                  if (data.portableArtifact) disposeDurableChunkArtifact(data.portableArtifact);
                } finally {
                  data.releaseBackup?.();
                }
              }
            }
          }
        }
      }
    }
  })();
  contributorCopyDisposals.set(certification, cleanup);
  return cleanup;
}

export function assertContributorCopyCertificationCurrent(
  certification: ContributorCopyCertification,
): void {
  const data = contributorCopies.get(certification);
  if (!data) throw Error('Contributor copy certification disposed');
  assertCopyCurrent(data);
}

declare const contributorPublicationBrand: unique symbol;
export interface ContributorCopyPublicationSeal {
  readonly [contributorPublicationBrand]: true;
}
const copyPublicationSeals = new WeakMap<
  ContributorCopyPublicationSeal,
  { certification: ContributorCopyCertification; data: ContributorCopyData }
>();

function assertCopyPublicationCurrent(data: ContributorCopyData): void {
  data.sourceCurrent();
  data.selectedCurrent();
  data.backupCurrent?.();
  if (data.portableArtifact) assertDurableChunkArtifactCurrent(data.portableArtifact);
  assertRecordReadOwnerInterval(data.source, data.owner);
  if (!managedPhysicalScopeCurrent(data.physicalScope))
    throw Error('Contributor copy original physical source changed');
  data.sourceCurrent();
  data.selectedCurrent();
  data.backupCurrent?.();
  if (data.portableArtifact) assertDurableChunkArtifactCurrent(data.portableArtifact);
  assertRecordReadOwnerInterval(data.source, data.owner);
}

/** Reverify the original complete roster after all callback-capable work. All
 * worker/handoff guards from this point use native reads and factory identities. */
export async function verifyContributorCopyCertificationForPublication(
  certification: ContributorCopyCertification,
  signal?: AbortSignal,
): Promise<ContributorCopyPublicationSeal> {
  const data = contributorCopies.get(certification);
  if (!data) throw Error('Contributor copy certification disposed');
  assertCopyCurrent(data);
  const checkpoint = () => {
    signal?.throwIfAborted();
    if (contributorCopies.get(certification) !== data)
      throw Error('Contributor copy certification disposed');
    assertCopyPublicationCurrent(data);
  };
  checkpoint();
  await data.worker.run('verify', signal, checkpoint);
  checkpoint();
  const seal = Object.freeze({}) as ContributorCopyPublicationSeal;
  copyPublicationSeals.set(seal, { certification, data });
  return seal;
}

/** One-use callback-free continuation immediately before owner-controlled rename. */
export function consumeContributorCopyPublicationSeal(
  seal: ContributorCopyPublicationSeal,
  certification: ContributorCopyCertification,
): void {
  const value = copyPublicationSeals.get(seal);
  copyPublicationSeals.delete(seal);
  if (
    !value ||
    value.certification !== certification ||
    contributorCopies.get(certification) !== value.data
  )
    throw Error('Contributor copy publication seal unavailable');
  assertCopyPublicationCurrent(value.data);
}

export async function assertContributorCopyCoherenceAsync(
  db: Database,
  root: string,
  profileId: string,
  backup?: Database,
  signal?: AbortSignal,
): Promise<void> {
  const certification = await prepareContributorCopyCertification(
    db,
    root,
    profileId,
    backup,
    signal,
  );
  await disposeContributorCopyCertification(certification);
}
/** Same-profile archive recovery retains journal identity, unlike private copy. */
export function copyContributorAuthority(
  root: string,
  profileId: string,
  targetRoot: string,
  { onFile }: { onFile?: (path: string) => void } = {},
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
      const directory = opendirSync(from);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync())
          if (entry.name !== 'writer.lock' && !entry.name.startsWith('.pending-'))
            copy(resolve(from, entry.name), resolve(to, entry.name));
      } finally {
        directory.closeSync();
      }
    } else if (stat.isFile()) {
      portableWork('fileCopyCalls', 1);
      copyFileSync(from, to);
      portableWork('fileCopyBytes', stat.size);
      const path = relative(targetRoot, to);
      if (onFile) onFile(path);
      else files.push(path);
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
