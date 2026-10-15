import {
  PACKET_PREFERENCE_PREFIX,
  validatePacketPreferenceRows,
} from './packet-preference-codec.ts';
import { resolveClinicalReference } from './clinical-references.ts';
import { canonicalLiteral } from './intake-format.ts';
import {
  validatePortableIntakeState,
  validatePortableIntakeRows,
} from './intake-state-portable.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { streamPortableJson } from './portable-json-stream.ts';
import { portableWork } from './portable-work.ts';
import { createPortableProjectionTransfer } from './portable-projection-transfer.ts';
import { stagePortableGenerationRows } from './portable-restore-stage.ts';
import {
  selectedPortablePersonalSpecialFields,
  stagePortablePersonalSpecialRows,
} from './portable-special-stage.ts';
import { createPortableOriginalInventory } from './portable-original-inventory.ts';
import { createPortableSourceIndex } from './portable-source-index.ts';
import {
  createPortableOriginalPhysicalRoster,
  verifyPortableOriginalInventory,
} from './portable-original-work.ts';
import { validatePortableStagedIntakeDatabase } from './portable-staged-intake-validator.ts';
import { logicalDatabaseHashIncremental } from './portable-logical-hash.ts';
import { captureRecordHeadPhysical } from './record-head-physical.ts';
import {
  expectIntakeFrontierCurationRevisionWrite,
  finishIntakeFrontierCurationRevisionWrite,
} from './intake-lookup-frontier-observer.ts';
import {
  attachContributorDurability,
  rebuildContributorDatabase,
  rebuildContributorDatabaseAsync,
  copyContributorAuthority,
  selectedContributorHead,
} from './contributor-durability.ts';
import { hasContributorAuthority } from './contributor-record-storage.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  opendirSync,
  chmodSync as rawChmodSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  writeSync,
  readFileSync,
  mkdirSync as rawMkdirSync,
  renameSync as rawRenameSync,
  linkSync as rawLinkSync,
  existsSync,
  copyFileSync as rawCopyFileSync,
  readdirSync,
  rmSync as rawRmSync,
  rmdirSync as rawRmdirSync,
  realpathSync,
  unlinkSync as rawUnlinkSync,
  statSync,
  fstatSync,
  lstatSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import {
  managedPhysicalMutationPaths,
  withManagedPhysicalMutation,
} from './clinical-review-physical-epoch.ts';

const chmodSync: typeof rawChmodSync = (...args) =>
  withManagedPhysicalMutation(() => rawChmodSync(...args), managedPhysicalMutationPaths([args[0]]));
const mkdirSync: typeof rawMkdirSync = (...args) =>
  withManagedPhysicalMutation(() => rawMkdirSync(...args), managedPhysicalMutationPaths([args[0]]));
const renameSync: typeof rawRenameSync = (...args) =>
  withManagedPhysicalMutation(
    () => rawRenameSync(...args),
    managedPhysicalMutationPaths([args[0], args[1]]),
  );
const copyFileSync: typeof rawCopyFileSync = (...args) =>
  withManagedPhysicalMutation(
    () => rawCopyFileSync(...args),
    managedPhysicalMutationPaths([args[1]]),
  );
const rmSync: typeof rawRmSync = (...args) =>
  withManagedPhysicalMutation(
    () => rawRmSync(...args),
    managedPhysicalMutationPaths([args[0]], true),
  );
const rmdirSync: typeof rawRmdirSync = (...args) =>
  withManagedPhysicalMutation(
    () => rawRmdirSync(...args),
    managedPhysicalMutationPaths([args[0]], true),
  );
const unlinkSync: typeof rawUnlinkSync = (...args) =>
  withManagedPhysicalMutation(
    () => rawUnlinkSync(...args),
    managedPhysicalMutationPaths([args[0]]),
  );
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import {
  openDatabase,
  databaseSchemaVersion,
  revision,
  clinicalReviewRevision,
  registerTransactionDurability,
  LATEST_SCHEMA_VERSION,
  type Database,
  type SqliteRow,
  transaction,
  currentTransactionToken,
} from './database.ts';
import { DatabaseSync, type Session, type SQLInputValue, type StatementSync } from 'node:sqlite';
import {
  ensureProfileDirectories,
  profilePaths,
  profileOriginal,
  safeRelative,
} from './profile-storage.ts';
import { copyAssistantJournals } from './assistant-journal.ts';
import { copyIntakeBatchJournals } from './intake-batch-journal.ts';
import {
  attachRecordDurability,
  recordDurabilityStatus,
  flushRecordDurability,
  type DurableRecordVersion,
  type RecordStepDriverWork,
  type RecordStorage,
} from './record-versions.ts';

export type PortableKind = 'personal' | 'curation';
export type DurableWriter = (path: string, bytes: Uint8Array) => void;
export interface PortableManifest {
  format: 'circus-health-generation-v1';
  profileId: string;
  kind: PortableKind;
  revision: number;
  file: string;
  sha256: string;
  bytes: number;
}
export type PortableRow = Record<string, unknown>;
export interface PortableSnapshot {
  format: 'circus-health-profile-source-v1';
  kind: PortableKind;
  profileId: string;
  schemaVersion: number;
  revision: number;
  createdAt: string;
  semantics: string;
  /** Scalar review authority at this personal generation, including later edits. */
  clinicalReviewRevision?: number;
  tables: Record<string, PortableRow[]>;
  restoreOperations?: PortableRow[];
  assistantOperations?: PortableRow[];
  packetPreferences?: Array<{ key: string; value: string }>;
  history?: {
    format: 'circus-health-personal-lineage-v1';
    previous: PortableManifest | null;
  };
  rawJson?: { referenced: number; verbatim: number };
}
type PortableHeader = Pick<
  PortableSnapshot,
  'format' | 'kind' | 'profileId' | 'schemaVersion' | 'revision' | 'createdAt' | 'semantics'
>;
export interface CheckedGeneration {
  manifest: PortableManifest;
  value: PortableSnapshot;
}
export interface OriginalFile extends PortableRow {
  path: string;
  stored_path?: string;
  sha256: string;
  bytes: number;
}
export interface LoadedPortable {
  personal: CheckedGeneration;
  curation?: CheckedGeneration;
  rows?: Record<string, PortableRow[]>;
  originals?: Map<string, OriginalFile>;
}
export interface CompleteLoadedPortable extends LoadedPortable {
  curation: CheckedGeneration;
  rows: Record<string, PortableRow[]>;
  originals: Map<string, OriginalFile>;
}
export interface PortableRows {
  personal: {
    manifest: PortableManifest;
    value: Omit<
      PortableSnapshot,
      'tables' | 'restoreOperations' | 'assistantOperations' | 'packetPreferences'
    >;
  };
  curation: PortableRows['personal'];
  tableNames(): string[];
  rows(table: string): Iterable<PortableRow>;
  rowCount(table: string): number;
  originals(): Iterable<OriginalFile>;
  originalCount: number;
  close(): void;
}
export interface ProjectPortableResult {
  database: string;
  profileId: string;
  revision: number;
  schemaVersion: number;
  files: number;
  counts: Record<string, unknown>;
  logicalSha256: string;
  databaseBytes: number;
}
interface PersonalDurabilityState {
  root: string;
  profileId: string;
  writer?: DurableWriter;
  journalWriter: DurableWriter;
  lastError: string | null;
}
interface PortableConflictError extends Error {
  portableConflict?: boolean;
}
interface DurableIntent {
  format: 'circus-health-durable-intent-v1';
  profileId: string;
  personal: PortableManifest;
  curation: PortableManifest | null;
  previousCuration: PortableManifest | null;
}
export interface PersonalDurabilityStatus {
  configured: boolean;
  dirty: boolean;
  revision: number;
  persistedRevision: number | null;
  conflicted: boolean;
  lastError: string | null;
  format?: string;
}
export interface AttachPersonalDurabilityOptions {
  root?: string;
  profileId?: string;
  writer?: DurableWriter;
  journalWriter?: DurableWriter;
  initialize?: boolean;
  /** Explicit standalone legacy portable-format facility; never runtime fallback. */
  portableSnapshots?: boolean;
  recordStorage?: RecordStorage;
  verifyReferences?: (versions: DurableRecordVersion[]) => void;
}
interface RecoverPendingOptions {
  writer?: DurableWriter;
  maxRevision?: number;
  validateOriginals?: boolean;
}
interface PinnedGenerations {
  personal?: PortableManifest;
  curation?: PortableManifest | null;
}
interface ProjectPortableOptions {
  phase?: (phase: string) => void;
}

const sha256 = (value: string | Buffer): string => {
  portableWork('bufferHashCalls', 1);
  portableWork('bufferHashBytes', Buffer.byteLength(value));
  return createHash('sha256').update(value).digest('hex');
};
const PERSONAL_TABLES = [
  'people',
  'notes',
  'note_links',
  'assets',
  'attachments',
  'medication_preferences',
  'visibility_events',
];
const PERSONAL_EVIDENCE = "entity_type IN ('note','person')";
const config = new WeakMap<Database, PersonalDurabilityState>();
const meta = (db: Database, key: string) =>
  db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
const putMeta = (db: Database, key: string, value: unknown) =>
  db
    .prepare(
      'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, String(value));
const internalMeta = (key: string): boolean =>
  key.startsWith('personal_') || key === 'curation_revision';
const tableNames = (db: Database): string[] =>
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name",
    )
    .all()
    .map((r) => r.name as string);
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';

export function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function durableWrite(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const pending = path + '.pending-' + randomUUID();
  const fd = openSync(pending, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(pending, path);
    syncDirectory(dirname(path));
  } catch (error) {
    rmSync(pending, { force: true });
    throw error;
  }
}
function stageGeneration(
  directory: string,
  value: PortableSnapshot,
  writer: DurableWriter = durableWrite,
): PortableManifest {
  const file = `snapshots/${String(value.revision).padStart(12, '0')}-${randomUUID()}.json`;
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  writer(resolve(directory, file), bytes);
  const manifest: PortableManifest = {
    format: 'circus-health-generation-v1',
    profileId: value.profileId,
    kind: value.kind,
    revision: value.revision,
    file,
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
  return manifest;
}
function writeGeneration(
  directory: string,
  value: PortableSnapshot,
  writer: DurableWriter = durableWrite,
): PortableManifest {
  const manifest = stageGeneration(directory, value, writer);
  // Only this atomic pointer publishes a generation. Unpublished files are
  // harmless recovery candidates, never implicitly substituted on read.
  writer(resolve(directory, 'current.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  return manifest;
}
function checkedGeneration(
  directory: string,
  profileId: string,
  kind: PortableKind,
  manifest: Partial<PortableManifest> | null | undefined,
): CheckedGeneration {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.format !== 'circus-health-generation-v1' ||
    manifest.profileId !== profileId ||
    manifest.kind !== kind ||
    !safeRelative(manifest.file) ||
    !/^snapshots\/[^/]+\.json$/.test(manifest.file)
  )
    throw new Error('Invalid portable generation manifest');
  const file = realpathSync(resolve(directory, manifest.file as string));
  const contained = relative(realpathSync(directory), file);
  if (contained.startsWith('..') || isAbsolute(contained))
    throw new Error('Portable generation escaped its profile');
  const bytes = readFileSync(file);
  if (bytes.length !== manifest.bytes || sha256(bytes) !== manifest.sha256)
    throw new Error('Portable generation checksum failed');
  const value = JSON.parse(bytes as unknown as string) as Partial<PortableSnapshot>;
  if (
    value.format !== 'circus-health-profile-source-v1' ||
    value.profileId !== profileId ||
    value.kind !== kind ||
    value.revision !== manifest.revision ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Number.isInteger(value.schemaVersion) ||
    (value.schemaVersion as number) < 1 ||
    (value.schemaVersion as number) > LATEST_SCHEMA_VERSION ||
    (value.clinicalReviewRevision !== undefined &&
      (!Number.isSafeInteger(value.clinicalReviewRevision) ||
        value.clinicalReviewRevision < 0 ||
        value.clinicalReviewRevision > (value.revision as number))) ||
    !value.tables ||
    typeof value.tables !== 'object' ||
    Array.isArray(value.tables)
  )
    throw new Error('Unsupported portable generation');
  return { manifest, value } as CheckedGeneration;
}
function readGeneration(
  directory: string,
  profileId: string,
  kind: PortableKind,
): CheckedGeneration {
  return checkedGeneration(
    directory,
    profileId,
    kind,
    JSON.parse(readFileSync(resolve(directory, 'current.json'), 'utf8')),
  );
}

// Follow only manifests linked from the actually published current pointer.
// Older loose snapshots are never discovered by listing a directory.
export function* publishedPersonalLineage(
  root: string,
  profileId: string,
  { manifest }: { manifest?: PortableManifest } = {},
): Generator<CheckedGeneration, void> {
  const directory = profilePaths(root, profileId).personal;
  if (!manifest && !existsSync(resolve(directory, 'current.json'))) return;
  let generation = manifest
    ? checkedGeneration(directory, profileId, 'personal', manifest)
    : readGeneration(directory, profileId, 'personal');
  const seen = new Set<string>();
  while (true) {
    if (seen.has(generation.manifest.file))
      throw new Error('Personal history lineage contains a cycle');
    seen.add(generation.manifest.file);
    yield generation;
    if (!generation.value.history) return; // Validated legacy current is a baseline, not an inferred history.
    if (generation.value.history.format !== 'circus-health-personal-lineage-v1')
      throw new Error('Unsupported personal history lineage');
    const previous = generation.value.history.previous;
    if (!previous) return;
    const parent = checkedGeneration(directory, profileId, 'personal', previous);
    if (parent.value.revision > generation.value.revision)
      throw new Error('Personal history revision order is invalid');
    generation = parent;
  }
}

export function copyPublishedPersonalHistory(
  root: string,
  profileId: string,
  targetRoot: string,
  {
    maxRevision = Infinity,
    manifest,
    onFile,
  }: { maxRevision?: number; manifest?: PortableManifest; onFile?: (path: string) => void } = {},
) {
  const source = profilePaths(root, profileId).personal;
  const target = ensureProfileDirectories(targetRoot, profileId);
  const files: string[] = [];
  let current: PortableManifest | null = null;
  for (const generation of publishedPersonalHeaders(root, profileId, { manifest })) {
    if (generation.value.revision > maxRevision) continue;
    current ??= generation.manifest;
    durableCopyFile(
      resolve(source, generation.manifest.file),
      resolve(target.personal, generation.manifest.file),
    );
    const path = `${target.relativeRoot}/personal/${generation.manifest.file}`;
    if (onFile) onFile(path);
    else files.push(path);
  }
  if (current) {
    durableWrite(
      resolve(target.personal, 'current.json'),
      Buffer.from(JSON.stringify(current, null, 2) + '\n'),
    );
    const path = `${target.relativeRoot}/personal/current.json`;
    if (onFile) onFile(path);
    else files.push(path);
  }
  return { files, current };
}

// Curation predates explicit lineage. Preserve retained files as candidates;
// their presence alone never proves acceptance or makes them rebuild inputs.
export function copyRetainedCurationHistory(
  root: string,
  profileId: string,
  targetRoot: string,
  { onFile }: { onFile?: (path: string) => void } = {},
) {
  const source = profilePaths(root, profileId),
    target = ensureProfileDirectories(targetRoot, profileId),
    paths: string[] = [];
  if (!existsSync(source.curation)) return { paths, receipt: null };
  if (resolve(root) === resolve(targetRoot))
    throw Error('Curation history must be copied to separate storage');
  const scratch = disposableSqlite('circus-retained-curation-'),
    db = scratch.db;
  try {
    db.exec(`CREATE TABLE files(ordinal INTEGER PRIMARY KEY, value TEXT);
      CREATE TABLE originals(ordinal INTEGER PRIMARY KEY, key TEXT UNIQUE, value TEXT, status TEXT);
      CREATE TABLE candidates(ordinal INTEGER PRIMARY KEY, key TEXT, path TEXT);
      CREATE INDEX candidate_key ON candidates(key,ordinal);
      CREATE TABLE selected(name TEXT, value TEXT);
      CREATE TABLE copied(path TEXT PRIMARY KEY);
      CREATE TABLE directories(parent TEXT, sort BLOB, path TEXT);`);
    function copied(path: string) {
      if (db.prepare('SELECT 1 FROM copied WHERE path=?').get(path)) return;
      db.prepare('INSERT INTO copied VALUES(?)').run(path);
      if (onFile) onFile(path);
      else paths.push(path);
    }
    function copyExact(
      sourcePath: string,
      path: string,
      expected: { sha256: string; bytes: number },
    ) {
      const destination = resolve(targetRoot, path);
      if (existsSync(destination))
        verifyFileDigest(
          destination,
          expected.bytes,
          expected.sha256,
          'Conflicting retained historical bytes: ' + path,
        );
      else durableCopyFile(sourcePath, destination);
      verifyFileDigest(
        destination,
        expected.bytes,
        expected.sha256,
        'Retained historical copy failed verification',
      );
      copied(path);
    }
    function original(file: PortableRow | null | undefined, candidate: string) {
      const path = file?.path ?? file?.stored_path,
        key = JSON.stringify([path, file?.sha256, file?.bytes]);
      db.prepare('INSERT INTO candidates(key,path) VALUES(?,?)').run(key, candidate);
      if (db.prepare('SELECT 1 FROM originals WHERE key=?').get(key)) return;
      const entry = {
        path: typeof path === 'string' ? path : null,
        sha256: file?.sha256 ?? null,
        bytes: file?.bytes ?? null,
      };
      let originalPath: string | undefined;
      try {
        if (
          typeof entry.sha256 !== 'string' ||
          !Number.isSafeInteger(entry.bytes) ||
          (entry.bytes as number) < 0
        )
          throw Error('Invalid metadata');
        originalPath = profileOriginal(root, path as string, profileId);
        verifyFileDigest(
          originalPath,
          entry.bytes as number,
          entry.sha256,
          'Original checksum mismatch',
        );
      } catch {
        originalPath = undefined;
      }
      let status = 'unavailable';
      if (originalPath) {
        copyExact(originalPath, path as string, {
          sha256: entry.sha256 as string,
          bytes: entry.bytes as number,
        });
        status = 'copied';
      }
      db.prepare('INSERT INTO originals(key,value,status) VALUES(?,?,?)').run(
        key,
        JSON.stringify(entry),
        status,
      );
    }
    function walk(directory: string) {
      if (lstatSync(directory).isSymbolicLink())
        throw Error('Retained curation directories cannot be symbolic links');
      const handle = opendirSync(directory);
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          const sort = Buffer.from(entry.name, 'utf16le');
          sort.swap16();
          db.prepare('INSERT INTO directories VALUES(?,?,?)').run(
            directory,
            sort,
            resolve(directory, entry.name),
          );
        }
      } finally {
        handle.closeSync();
      }
      for (const entry of db
        .prepare('SELECT path FROM directories WHERE parent=? ORDER BY sort')
        .iterate(directory)) {
        const full = String(entry.path),
          info = lstatSync(full);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
          throw Error('Retained curation history must contain regular files');
        if (info.isDirectory()) {
          walk(full);
          continue;
        }
        const digest = portableFileDigest(full),
          sourcePath = relative(source.curation, full);
        const retainedPath =
          sourcePath === 'current.json' ? `retained-pointers/${digest.sha256}.json` : sourcePath;
        const path = `${target.relativeRoot}/curation/${retainedPath}`;
        copyExact(full, path, digest);
        db.prepare('INSERT INTO files(value) VALUES(?)').run(
          JSON.stringify({
            sourcePath,
            path,
            ...digest,
            role: sourcePath === 'current.json' ? 'retained-pointer' : 'retained-candidate',
            acceptance: 'not-inferred',
          }),
        );
        db.exec('DELETE FROM selected');
        let header: Record<string, unknown>;
        try {
          header = streamPortableJson(
            full,
            (name) => {
              db.prepare('DELETE FROM selected WHERE name=?').run(name);
            },
            (table, row) => {
              if (table === 'source_files' || table === 'assets')
                db.prepare('INSERT INTO selected VALUES(?,?)').run(table, JSON.stringify(row));
            },
            digest,
            {
              candidate: true,
              tablesStart: () => {
                db.exec('DELETE FROM selected');
              },
            },
          );
        } catch {
          continue;
        } // Opaque/corrupt candidates are retained literally, never selected.
        if (
          header.format !== 'circus-health-profile-source-v1' ||
          header.profileId !== profileId ||
          header.kind !== 'curation'
        )
          continue;
        for (const row of db.prepare('SELECT value FROM selected').iterate())
          original(JSON.parse(String(row.value)) as PortableRow, path);
      }
    }
    walk(source.curation);
    const receiptPath = `${target.relativeRoot}/curation/history-receipts/${randomUUID()}.json`;
    function* receiptChunks() {
      yield JSON.stringify({
        format: 'circus-health-retained-curation-v1',
        profileId,
        copiedAt: new Date().toISOString(),
        semantics:
          'Byte-preserved historical candidates; acceptance is not inferred and no candidate is promoted to current',
      }).slice(0, -1) + ',"files":[';
      let first = true;
      for (const row of db.prepare('SELECT value FROM files ORDER BY ordinal').iterate()) {
        if (!first) yield ',';
        first = false;
        yield String(row.value);
      }
      yield '],"originals":[';
      first = true;
      for (const row of db
        .prepare('SELECT key,value,status FROM originals ORDER BY ordinal')
        .iterate()) {
        if (!first) yield ',';
        first = false;
        yield String(row.value).slice(0, -1) + ',"candidates":[';
        let initial = true;
        for (const candidate of db
          .prepare('SELECT path FROM candidates WHERE key=? ORDER BY ordinal')
          .iterate(row.key!)) {
          if (!initial) yield ',';
          initial = false;
          yield JSON.stringify(candidate.path);
        }
        yield '],"status":' + JSON.stringify(row.status) + '}';
      }
      yield ']}\n';
    }
    durableWriteChunks(resolve(targetRoot, receiptPath), receiptChunks());
    copied(receiptPath);
    return {
      paths,
      receipt: {
        path: receiptPath,
        files: Number(db.prepare('SELECT COUNT(*) n FROM files').get()!.n),
        originals: Number(
          db.prepare("SELECT COUNT(*) n FROM originals WHERE status='copied'").get()!.n,
        ),
        unavailableOriginals: Number(
          db.prepare("SELECT COUNT(*) n FROM originals WHERE status!='copied'").get()!.n,
        ),
      },
    };
  } finally {
    scratch.close();
  }
}

function checkOwner(db: Database, profileId: string): void {
  if (meta(db, 'owner_profile_id') !== profileId) throw new Error('Portable profile mismatch');
}
function header(db: Database, profileId: string, kind: PortableKind): PortableHeader {
  return {
    format: 'circus-health-profile-source-v1',
    kind,
    profileId,
    schemaVersion: databaseSchemaVersion(db),
    revision: revision(db),
    createdAt: new Date().toISOString(),
    semantics: 'complete replacement of owned tables',
  };
}
function personalSnapshot(db: Database, profileId: string): PortableSnapshot {
  const version = databaseSchemaVersion(db);
  if (!Number.isInteger(version) || version < 1 || version > LATEST_SCHEMA_VERSION)
    throw new Error('Unsupported database schema version for personal export');
  const tables = PERSONAL_TABLES.filter(
    (table) =>
      !(
        ((table === 'medication_preferences' && version < 4) ||
          (table === 'visibility_events' && version < 6)) &&
        !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      ),
  );
  const snapshot: PortableSnapshot = {
    ...header(db, profileId, 'personal'),
    clinicalReviewRevision: clinicalReviewRevision(db),
    tables: Object.fromEntries(
      tables.map((table) => [
        table,
        db
          .prepare(
            `SELECT * FROM ${quote(table)} ORDER BY ${table === 'medication_preferences' ? 'medication_id' : 'id'}`,
          )
          .all(),
      ]),
    ),
  };
  snapshot.packetPreferences = db
    .prepare('SELECT key,value FROM app_meta WHERE substr(key,1,?)=? ORDER BY key')
    .all(PACKET_PREFERENCE_PREFIX.length, PACKET_PREFERENCE_PREFIX) as Array<{
    key: string;
    value: string;
  }>;
  validatePacketPreferenceRows(snapshot.packetPreferences);
  snapshot.restoreOperations = db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'personal_restore_*' ORDER BY key")
    .all();
  snapshot.assistantOperations = db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'personal_assistant_*' ORDER BY key")
    .all();
  snapshot.tables.evidence = db
    .prepare(`SELECT * FROM evidence WHERE ${PERSONAL_EVIDENCE} ORDER BY id`)
    .all();
  return snapshot;
}
export function personalDurabilityStatus(db: Database): PersonalDurabilityStatus {
  const recordStatus = recordDurabilityStatus(db);
  if (recordStatus) return recordStatus;
  const state = config.get(db);
  return {
    configured: Boolean(state),
    dirty: meta(db, 'personal_dirty') === '1',
    revision: revision(db),
    persistedRevision:
      meta(db, 'personal_persisted_revision') === undefined
        ? null
        : Number(meta(db, 'personal_persisted_revision')),
    conflicted: Boolean(meta(db, 'personal_conflict')),
    lastError: (state?.lastError || meta(db, 'personal_last_error') || null) as string | null,
  };
}
export function attachPersonalDurability(
  db: Database,
  {
    root,
    profileId,
    writer,
    journalWriter = durableWrite,
    initialize = true,
    portableSnapshots = false,
    recordStorage,
    verifyReferences,
  }: AttachPersonalDurabilityOptions = {},
) {
  checkOwner(db, profileId as string);
  if (recordStorage)
    return attachRecordDurability(db, { profileId, storage: recordStorage, verifyReferences });
  if (!portableSnapshots)
    return attachContributorDurability(db, root as string, profileId as string, initialize);
  if (
    recordDurabilityStatus(db) ||
    hasContributorAuthority(root as string, profileId as string) ||
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name='__record_state'").get()
  )
    throw Error('Selected record authority cannot attach a second portable publisher');
  ensureProfileDirectories(root as string, profileId as string);
  config.set(db, {
    root,
    profileId,
    writer,
    journalWriter,
    lastError: null,
  } as PersonalDurabilityState);
  registerTransactionDurability<Session[], unknown>(db, {
    capture() {
      return tableNames(db)
        .filter(
          (table) =>
            !PERSONAL_TABLES.includes(table) && !['app_meta', 'schema_migrations'].includes(table),
        )
        .map((table) => db.createSession({ table }));
    },
    release(sessions) {
      for (const session of sessions || []) session.close();
    },
    markDirty() {
      putMeta(db, 'personal_dirty', '1');
    },
    prepare(sessions) {
      prepareDurableIntent(
        db,
        config.get(db)!,
        sessions!.some((session) => session.changeset().length > 0),
      );
    },
    flush() {
      flushPersonal(db);
    },
  });
  // Startup retries any commit whose portable write was interrupted. A current
  // snapshot is also needed for an existing database first enabling durability.
  return initialize ? flushPersonal(db) : personalDurabilityStatus(db);
}
export function flushPersonal(db: Database): PersonalDurabilityStatus {
  if (recordDurabilityStatus(db)) return flushRecordDurability(db)!;
  const state = config.get(db);
  if (!state) throw new Error('Personal durability is not configured');
  let locked = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    locked = true;
    writePersonalLocked(db, state);
    db.exec('COMMIT');
    locked = false;
  } catch (error) {
    if (locked) db.exec('ROLLBACK');
    rememberFailure(db, state, error);
  }
  return personalDurabilityStatus(db);
}
function writePersonalLocked(db: Database, state: PersonalDurabilityState): void {
  checkOwner(db, state.profileId);
  const recovered = recoverPendingProfile(state.root, state.profileId, {
    writer: state.writer,
    maxRevision: revision(db),
    validateOriginals: false,
  });
  if (recovered?.curation) putMeta(db, 'curation_revision', recovered.curation.revision);
  const directory = profilePaths(state.root, state.profileId).personal;
  const existing = existsSync(resolve(directory, 'current.json'))
    ? readGeneration(directory, state.profileId, 'personal')
    : null;
  if (meta(db, 'personal_conflict') || (existing && existing.value.revision > revision(db))) {
    const error: PortableConflictError = new Error(
      'Portable personal history is newer than or conflicts with this database. Rebuild or review the restored database before publishing personal changes.',
    );
    error.portableConflict = true;
    throw error;
  }
  const snapshot = personalSnapshot(db, state.profileId);
  // Attaching to a just-rebuilt database must not invent another history
  // revision or alter the pinned startup inputs.
  if (
    !state.writer &&
    existing &&
    existing.value.revision === snapshot.revision &&
    JSON.stringify(existing.value.tables) === JSON.stringify(snapshot.tables) &&
    JSON.stringify(existing.value.restoreOperations || []) ===
      JSON.stringify(snapshot.restoreOperations) &&
    JSON.stringify(existing.value.assistantOperations || []) ===
      JSON.stringify(snapshot.assistantOperations) &&
    JSON.stringify(existing.value.packetPreferences) === JSON.stringify(snapshot.packetPreferences)
  ) {
    putMeta(db, 'personal_persisted_revision', snapshot.revision);
    putMeta(db, 'personal_dirty', '0');
    putMeta(db, 'personal_last_error', '');
    state.lastError = null;
    return;
  }
  snapshot.history = {
    format: 'circus-health-personal-lineage-v1',
    previous: existing?.manifest || null,
  };
  writeGeneration(directory, snapshot, state.writer);
  putMeta(db, 'personal_persisted_revision', snapshot.revision);
  putMeta(db, 'personal_dirty', '0');
  putMeta(db, 'personal_last_error', '');
  state.lastError = null;
}

// pending.json is an external commit intent, not a SQLite-only retry marker.
// Its immutable snapshots are accepted recovery evidence. A lost/failed HTTP
// response can therefore complete on recovery; version checks make retries
// detect the newer value. Never guess by scanning loose snapshot candidates.
function prepareDurableIntent(
  db: Database,
  state: PersonalDurabilityState,
  curationChanged: boolean,
): void {
  const paths = profilePaths(state.root, state.profileId);
  recoverPendingProfile(state.root, state.profileId, {
    maxRevision: revision(db) - 1,
    validateOriginals: false,
  });
  const previous = existsSync(resolve(paths.personal, 'current.json'))
    ? readGeneration(paths.personal, state.profileId, 'personal')
    : null;
  if (meta(db, 'personal_conflict') || (previous && previous.value.revision >= revision(db)))
    throw new Error('Personal recovery state conflicts with this database; rebuild before saving');
  const personal = personalSnapshot(db, state.profileId);
  personal.history = {
    format: 'circus-health-personal-lineage-v1',
    previous: previous?.manifest || null,
  };
  const intent: DurableIntent = {
    format: 'circus-health-durable-intent-v1',
    profileId: state.profileId,
    personal: stageGeneration(paths.personal, personal, state.journalWriter),
    curation: null,
    previousCuration: null,
  };
  // Source intake owns curation. Its source index and raw-record changes must
  // survive the same crash window as personal edits.
  if (
    curationChanged ||
    Number(meta(db, 'intake_mutation_revision') || 0) > Number(meta(db, 'curation_revision') || 0)
  ) {
    intent.previousCuration = existsSync(resolve(paths.curation, 'current.json'))
      ? readGeneration(paths.curation, state.profileId, 'curation').manifest
      : null;
    intent.curation = stageGeneration(
      paths.curation,
      curationSnapshot(db, state.root, state.profileId),
      state.journalWriter,
    );
  }
  state.journalWriter(
    resolve(paths.personal, 'pending.json'),
    Buffer.from(JSON.stringify(intent, null, 2) + '\n'),
  );
}

export function recoverPendingProfile(
  root: string,
  profileId: string,
  {
    writer = durableWrite,
    maxRevision = Infinity,
    validateOriginals = true,
  }: RecoverPendingOptions = {},
): DurableIntent | null {
  const paths = profilePaths(root, profileId),
    pendingPath = resolve(paths.personal, 'pending.json');
  if (hasContributorAuthority(root, profileId)) {
    selectedContributorHead(root, profileId);
    if (existsSync(pendingPath))
      throw Error('Portable recovery intent conflicts with selected record authority');
    return null;
  }
  if (!existsSync(pendingPath)) return null;
  const intent = JSON.parse(readFileSync(pendingPath, 'utf8')) as DurableIntent;
  if (intent.format !== 'circus-health-durable-intent-v1' || intent.profileId !== profileId)
    throw new Error('Invalid durable recovery intent');
  const personal = checkedGenerationHeader(paths.personal, profileId, 'personal', intent.personal);
  if (personal.value.revision > maxRevision)
    throw new Error('Durable recovery intent is newer than SQLite; rebuild before saving');
  const same = (a: PortableManifest | null, b: PortableManifest | null) =>
    (!a && !b) ||
    Boolean(a && b && a.file === b.file && a.sha256 === b.sha256 && a.revision === b.revision);
  const current = (kind: PortableKind): PortableManifest | null =>
    existsSync(resolve(paths[kind], 'current.json'))
      ? checkedGenerationHeader(paths[kind], profileId, kind).manifest
      : null;
  if (
    personal.value.history?.format !== 'circus-health-personal-lineage-v1' ||
    ![intent.personal, personal.value.history.previous].some((expected) =>
      same(current('personal'), expected),
    )
  )
    throw new Error('Durable personal intent conflicts with published history');
  // Validate the entire lineage before making its head current.
  for (const generation of publishedPersonalHeaders(root, profileId, { manifest: intent.personal }))
    void generation;
  if (intent.curation) {
    const curated = checkedGenerationHeader(paths.curation, profileId, 'curation', intent.curation);
    if (
      curated.value.revision !== personal.value.revision ||
      ![intent.curation, intent.previousCuration].some((expected) =>
        same(current('curation'), expected),
      )
    )
      throw new Error('Durable curation intent conflicts with published history');
  }
  // Validate all referenced source and attachment bytes while still pending.
  if (validateOriginals) {
    const curation = intent.curation || current('curation');
    if (curation)
      openPortableRows(root, profileId, { personal: intent.personal, curation }).close();
    else {
      const file = selectedGenerationPath(paths.personal, profileId, 'personal', intent.personal);
      streamPortableJson(
        file,
        () => {},
        (table, value) => {
          if (table === 'assets') {
            const asset = value as PortableRow;
            verifyPortableOriginal(root, profileId, {
              path: asset.stored_path,
              ...asset,
            } as OriginalFile);
          }
        },
        intent.personal,
      );
    }
  }
  writer(
    resolve(paths.personal, 'current.json'),
    Buffer.from(JSON.stringify(intent.personal, null, 2) + '\n'),
  );
  if (intent.curation)
    writer(
      resolve(paths.curation, 'current.json'),
      Buffer.from(JSON.stringify(intent.curation, null, 2) + '\n'),
    );
  unlinkSync(pendingPath);
  syncDirectory(paths.personal);
  return intent;
}
function rememberFailure(db: Database, state: PersonalDurabilityState, error: unknown): void {
  state.lastError = String((error as PortableConflictError).message || error);
  // Do not throw after a successful application COMMIT: the API must report
  // the saved note plus dirty durability status, allowing an explicit retry.
  try {
    putMeta(db, 'personal_dirty', '1');
    putMeta(db, 'personal_last_error', state.lastError);
    if ((error as PortableConflictError).portableConflict)
      putMeta(db, 'personal_conflict', state.lastError);
  } catch {
    /* Existing in-transaction dirty marker remains recoverable. */
  }
}

function checkedBytes(root: string, profileId: string, file: OriginalFile): Buffer {
  const bytes = readFileSync(profileOriginal(root, file.path, profileId));
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
    throw new Error('Original checksum failed: ' + file.path);
  return bytes;
}
function byteLines(bytes: Buffer): Array<{ offset: number; bytes: number }> {
  const result: Array<{ offset: number; bytes: number }> = [];
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start);
    let end = newline === -1 ? bytes.length : newline;
    if (bytes[end - 1] === 13) end--;
    result.push({ offset: start, bytes: end - start });
    start = newline === -1 ? bytes.length : newline + 1;
  }
  return result;
}
function curationSnapshot(db: Database, root: string, profileId: string): PortableSnapshot {
  checkOwner(db, profileId);
  const sources = db.prepare('SELECT * FROM source_files ORDER BY id').all() as Array<
    SqliteRow & OriginalFile & { id: string }
  >;
  const files = new Map<
    string,
    {
      file: SqliteRow & OriginalFile & { id: string };
      bytes: Buffer;
      lines: Array<{ offset: number; bytes: number }> | null;
    }
  >(
    sources.map((file) => {
      const bytes = checkedBytes(root, profileId, file);
      return [file.id, { file, bytes, lines: null }];
    }),
  );
  const snapshot: PortableSnapshot = {
    ...header(db, profileId, 'curation'),
    tables: {},
    rawJson: { referenced: 0, verbatim: 0 },
  };
  for (const table of tableNames(db)) {
    if (PERSONAL_TABLES.includes(table)) continue;
    let rows: PortableRow[] = db.prepare(`SELECT * FROM ${quote(table)}`).all();
    if (table === 'app_meta') rows = rows.filter((row) => !internalMeta(row.key as string));
    if (table === 'evidence')
      rows = rows.filter((row) => !['note', 'person'].includes(row.entity_type as string));
    if (table === 'source_records')
      rows = rows.map((row) => {
        const file = files.get(row.source_file_id as string);
        const raw = Buffer.from(row.raw_json as string, 'utf8');
        let span: { offset: number; bytes: number } | undefined;
        const locator = JSON.parse(row.locator_json as string) as PortableRow;
        if (file && Number.isInteger(locator.line) && (locator.line as number) > 0) {
          file.lines ??= byteLines(file.bytes);
          span = file.lines[(locator.line as number) - 1];
        }
        if (!span && file && raw.equals(file.bytes)) span = { offset: 0, bytes: raw.length };
        if (span && raw.equals(file!.bytes.subarray(span.offset, span.offset + span.bytes))) {
          snapshot.rawJson!.referenced++;
          const { raw_json, ...metadata } = row;
          return {
            ...metadata,
            raw_source: {
              sourceFileId: row.source_file_id,
              ...span,
              sha256: sha256(raw),
            },
          };
        }
        snapshot.rawJson!.verbatim++;
        return row;
      });
    snapshot.tables[table] = rows;
  }
  return snapshot;
}
// Mapping files are retained input, even when a rule is not executable yet.
// Copy literal bytes without treating a filename or a loose rule as accepted.
export function copyProfileMappings(
  root: string,
  profileId: string,
  targetRoot: string,
  { onFile }: { onFile?: (path: string) => void } = {},
): string[] {
  const base = profilePaths(root, profileId),
    directory = resolve(base.root, 'mappings');
  const copied: string[] = [];
  if (!existsSync(directory)) return copied;
  function walk(path: string): void {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('Profile mappings cannot be symbolic links');
    if (info.isDirectory()) {
      const directory = opendirSync(path);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync())
          walk(resolve(path, entry.name));
      } finally {
        directory.closeSync();
      }
    } else if (info.isFile()) {
      const relativePath = `${base.relativeRoot}/mappings/${relative(directory, path)}`;
      const digest = portableFileDigest(path),
        target = resolve(targetRoot, relativePath);
      durableCopyFile(path, target);
      verifyFileDigest(target, digest.bytes, digest.sha256, 'Mapping copy failed verification');
      if (onFile) onFile(relativePath);
      else copied.push(relativePath);
    } else throw new Error('Profile mappings must contain regular files');
  }
  walk(directory);
  return copied;
}

/** Stream the existing generation grammar from a consistent database snapshot. */
/** Portable rows encoded between export yields. */
const PORTABLE_EXPORT_STEP_ROWS = 64;
function* writeStreamedGenerationSteps(
  db: Database,
  root: string,
  profileId: string,
  directory: string,
  kind: PortableKind,
  history?: PortableSnapshot['history'],
): Generator<void, PortableManifest> {
  const value = header(db, profileId, kind);
  if (
    !Number.isInteger(value.schemaVersion) ||
    value.schemaVersion < 1 ||
    value.schemaVersion > LATEST_SCHEMA_VERSION
  )
    throw Error('Unsupported database schema version for personal export');
  const file = `snapshots/${String(value.revision).padStart(12, '0')}-${randomUUID()}.json`;
  const path = resolve(directory, file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const hash = createHash('sha256');
  const scratch = disposableSqlite('circus-portable-export-');
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    scratch.close();
    throw error;
  }
  let length = 0,
    closed = false,
    complete = false,
    publicationAttempted = false,
    referenced = 0,
    verbatim = 0;
  // Encoded output gathers in one bounded buffer; a value larger than it is
  // written directly. Everything is flushed before the generation's fsync.
  const pending = Buffer.allocUnsafe(DURABLE_OUTPUT_BUFFER_BYTES);
  let pendingBytes = 0;
  function writeAll(bytes: Uint8Array) {
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!count) throw Error('Portable generation write did not advance');
      offset += count;
    }
    portableWork('outputWrites', 1);
  }
  function flush() {
    if (!pendingBytes) return;
    writeAll(pending.subarray(0, pendingBytes));
    pendingBytes = 0;
  }
  function write(text: string) {
    const bytes = Buffer.from(text);
    hash.update(bytes);
    portableWork('outputBytes', bytes.length);
    portableWork('maxOutputChunkBytes', bytes.length, true);
    length += bytes.length;
    if (pendingBytes + bytes.length > pending.length) flush();
    if (bytes.length > pending.length) writeAll(bytes);
    else pendingBytes += bytes.copy(pending, pendingBytes);
  }
  let stepRows = 0;
  function* array(rows: Iterable<PortableRow>): Generator<void> {
    write('[');
    let first = true;
    for (const row of rows) {
      if (!first) write(',');
      first = false;
      write(JSON.stringify(row));
      if (++stepRows >= PORTABLE_EXPORT_STEP_ROWS) {
        stepRows = 0;
        yield;
      }
    }
    write(']');
  }
  try {
    // One private scratch transaction for the line index, not one implicit
    // write transaction per indexed line; the scratch is disposed either way.
    scratch.db.exec(
      'CREATE TABLE indexed(id TEXT PRIMARY KEY); CREATE TABLE lines(id TEXT, line INTEGER, offset INTEGER, bytes INTEGER, PRIMARY KEY(id,line)); BEGIN;',
    );
    const sources = db.prepare('SELECT * FROM source_files WHERE id=?');
    function indexLines(source: OriginalFile & { id: string }) {
      if (scratch.db.prepare('SELECT 1 FROM indexed WHERE id=?').get(source.id)) return;
      const file = openSync(profileOriginal(root, source.path, profileId), 'r'),
        block = Buffer.alloc(64 * 1024);
      let position = 0,
        start = 0,
        line = 1,
        previous = -1;
      const insert = scratch.db.prepare('INSERT INTO lines VALUES(?,?,?,?)');
      try {
        for (
          let size = readSync(file, block, 0, block.length, null);
          size;
          size = readSync(file, block, 0, block.length, null)
        ) {
          portableWork('lineIndexReadBytes', size);
          portableWork('maxReadBufferBytes', block.length, true);
          for (let i = 0; i < size; i++, position++) {
            if (block[i] === 10) {
              insert.run(source.id, line++, start, position - start - (previous === 13 ? 1 : 0));
              start = position + 1;
            }
            previous = block[i]!;
          }
        }
        if (start < position)
          insert.run(source.id, line, start, position - start - (previous === 13 ? 1 : 0));
      } finally {
        closeSync(file);
      }
      scratch.db.prepare('INSERT INTO indexed VALUES(?)').run(source.id);
    }
    function canonicalRow(row: PortableRow): PortableRow {
      const source = sources.get(row.source_file_id as SQLInputValue) as
        (SqliteRow & OriginalFile & { id: string }) | undefined;
      const raw = Buffer.from(row.raw_json as string),
        locator = JSON.parse(row.locator_json as string) as PortableRow;
      let span: { offset: number; bytes: number } | undefined;
      if (source && Number.isInteger(locator.line) && (locator.line as number) > 0) {
        indexLines(source);
        span = scratch.db
          .prepare('SELECT offset,bytes FROM lines WHERE id=? AND line=?')
          .get(source.id, locator.line as number) as typeof span;
      }
      if (!span && source && source.bytes === raw.length) span = { offset: 0, bytes: raw.length };
      if (span && source && span.bytes === raw.length) {
        const fd = openSync(profileOriginal(root, source.path, profileId), 'r'),
          bytes = Buffer.alloc(raw.length);
        let total = 0;
        portableWork('rangeReadCalls', 1);
        portableWork('maxRangeBytes', bytes.length, true);
        try {
          while (total < bytes.length) {
            const count = readSync(fd, bytes, total, bytes.length - total, span.offset + total);
            if (!count) break;
            total += count;
            portableWork('rangeReadBytes', count);
          }
        } finally {
          closeSync(fd);
        }
        if (total === bytes.length && raw.equals(bytes)) {
          referenced++;
          const { raw_json, ...metadata } = row;
          return {
            ...metadata,
            raw_source: { sourceFileId: row.source_file_id, ...span, sha256: sha256(raw) },
          };
        }
      }
      verbatim++;
      return row;
    }
    if (kind === 'curation')
      for (const file of db.prepare('SELECT * FROM source_files ORDER BY id').iterate())
        verifyPortableOriginal(root, profileId, file as SqliteRow & OriginalFile);
    write(JSON.stringify(value).slice(0, -1));
    if (kind === 'personal') write(',"clinicalReviewRevision":' + clinicalReviewRevision(db));
    write(',"tables":{');
    const names =
      kind === 'personal'
        ? [
            ...PERSONAL_TABLES.filter(
              (name) =>
                !(
                  ((name === 'medication_preferences' && value.schemaVersion < 4) ||
                    (name === 'visibility_events' && value.schemaVersion < 6)) &&
                  !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
                ),
            ),
            'evidence',
          ]
        : tableNames(db).filter((name) => !PERSONAL_TABLES.includes(name));
    let first = true;
    for (const name of names) {
      if (!first) write(',');
      first = false;
      write(JSON.stringify(name) + ':');
      const personalOrder =
        kind === 'personal'
          ? ` ORDER BY ${name === 'medication_preferences' ? 'medication_id' : 'id'}`
          : '';
      const condition =
        name === 'evidence'
          ? ` WHERE ${kind === 'personal' ? PERSONAL_EVIDENCE : 'NOT (' + PERSONAL_EVIDENCE + ')'}`
          : '';
      function* rows() {
        for (const row of db
          .prepare(`SELECT * FROM ${quote(name)}${condition}${personalOrder}`)
          .iterate()) {
          if (name === 'app_meta' && internalMeta(String(row.key))) continue;
          yield name === 'source_records' ? canonicalRow(row) : row;
        }
      }
      yield* array(rows());
    }
    write('}');
    if (kind === 'personal') {
      for (const [field, pattern] of [
        ['packetPreferences', PACKET_PREFERENCE_PREFIX + '%'],
        ['restoreOperations', 'personal_restore_%'],
        ['assistantOperations', 'personal_assistant_%'],
      ]) {
        write(',' + JSON.stringify(field) + ':');
        // Prefix uses substr, matching the retained codec (SQL '_' is literal).
        const prefix = pattern!.slice(0, -1);
        const values = db
          .prepare('SELECT key,value FROM app_meta WHERE substr(key,1,?)=? ORDER BY key')
          .iterate(prefix.length, prefix);
        function* checked() {
          for (const row of values) {
            if (field === 'packetPreferences') validatePacketPreferenceRows([row]);
            yield row;
          }
        }
        yield* array(checked());
      }
      if (history) write(',"history":' + JSON.stringify(history));
    } else write(',"rawJson":' + JSON.stringify({ referenced, verbatim }));
    write('}\n');
    flush();
    fsyncSync(fd);
    closeSync(fd);
    closed = true;
    syncDirectory(dirname(path));
    const manifest: PortableManifest = {
      format: 'circus-health-generation-v1',
      profileId,
      kind,
      revision: value.revision,
      file,
      sha256: hash.digest('hex'),
      bytes: length,
    };
    publicationAttempted = true;
    durableWrite(
      resolve(directory, 'current.json'),
      Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
    );
    complete = true;
    return manifest;
  } finally {
    // Also reached when a driver abandons the steps between yields.
    if (!complete) {
      if (!closed) closeSync(fd);
      if (!publicationAttempted) rmSync(path, { force: true });
    }
    scratch.close();
  }
}

// Pure snapshot-to-files operation, also used by backup against its consistent
// SQLite snapshot. It does not mutate the source database or live profile files.
export function writePortableSources(
  db: Database,
  sourceRoot: string,
  profileId: string,
  outputRoot: string,
  options: { onFile?: (path: string) => void } = {},
): string[] {
  const steps = writePortableSourcesSteps(db, sourceRoot, profileId, outputRoot, options);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
/** Proofs, yields and windows of one cooperative portable step driver. */
export interface PortableStepWork {
  proofs: number;
  yields: number;
  windows: number;
  steps: number;
}
/** Most bounded portable steps run back to back inside one cooperative window. */
export const PORTABLE_STEP_WINDOW = 16;
/** Drives portable steps with host yields between windows that start at one
 * step and double to PORTABLE_STEP_WINDOW. `checkpoint` is the caller's
 * complete source proof; it runs at the start, after every yield, at
 * completion and on every other exit. */
export async function finishPortableStepsAsync<T>(
  steps: Generator<void, T>,
  checkpoint: () => void,
  { signal, work }: { signal?: AbortSignal; work?: PortableStepWork } = {},
): Promise<T> {
  const counts = work ?? { proofs: 0, yields: 0, windows: 0, steps: 0 };
  const proof = () => {
    counts.proofs++;
    signal?.throwIfAborted();
    checkpoint();
  };
  let window = 1,
    done = false;
  try {
    for (;;) {
      proof();
      counts.windows++;
      for (let index = 0; index < window; index++) {
        const next = steps.next();
        counts.steps++;
        if (next.done) {
          done = true;
          proof();
          return next.value;
        }
      }
      window = Math.min(window * 2, PORTABLE_STEP_WINDOW);
      counts.yields++;
      await setImmediate();
    }
  } finally {
    if (!done)
      try {
        steps.return(undefined as never);
      } finally {
        proof();
      }
  }
}
/** Cooperative writePortableSources. The database snapshot must stay
 * unchanged while it runs; `checkpoint` proves that (and any other source
 * identity) around every yield. */
export function writePortableSourcesAsync(
  db: Database,
  sourceRoot: string,
  profileId: string,
  outputRoot: string,
  options: { onFile?: (path: string) => void },
  checkpoint: () => void,
  driver: { signal?: AbortSignal; work?: PortableStepWork } = {},
): Promise<string[]> {
  return finishPortableStepsAsync(
    writePortableSourcesSteps(db, sourceRoot, profileId, outputRoot, options),
    checkpoint,
    driver,
  );
}
/** Step-wise portable export: the same files and bytes as writePortableSources,
 * yielding between bounded row windows of each streamed generation. */
export function* writePortableSourcesSteps(
  db: Database,
  sourceRoot: string,
  profileId: string,
  outputRoot: string,
  { onFile }: { onFile?: (path: string) => void } = {},
): Generator<void, string[]> {
  checkOwner(db, profileId);
  const paths = ensureProfileDirectories(outputRoot, profileId);
  const sameRoot = resolve(sourceRoot) === resolve(outputRoot);
  const mappings = sameRoot
    ? []
    : copyProfileMappings(sourceRoot, profileId, outputRoot, { onFile });
  const retained = sameRoot
    ? { paths: [] }
    : copyRetainedCurationHistory(sourceRoot, profileId, outputRoot, { onFile });
  const history = sameRoot
    ? {
        files: [],
        current: checkedCurrentPersonalManifest(sourceRoot, profileId),
      }
    : copyPublishedPersonalHistory(sourceRoot, profileId, outputRoot, {
        maxRevision: revision(db),
        onFile,
      });
  const manifests: Array<[PortableKind, PortableManifest]> = [
    [
      'personal',
      yield* writeStreamedGenerationSteps(db, sourceRoot, profileId, paths.personal, 'personal', {
        format: 'circus-health-personal-lineage-v1',
        previous: history.current,
      }),
    ],
    [
      'curation',
      yield* writeStreamedGenerationSteps(db, sourceRoot, profileId, paths.curation, 'curation'),
    ],
  ];
  if (onFile) {
    for (const [kind, manifest] of manifests) {
      onFile(`${paths.relativeRoot}/${kind}/${manifest.file}`);
      onFile(`${paths.relativeRoot}/${kind}/current.json`);
    }
    return [];
  }
  return [
    ...new Set([
      ...history.files,
      ...retained.paths,
      ...mappings,
      ...manifests.flatMap(([kind, manifest]) => [
        `${paths.relativeRoot}/${kind}/${manifest.file}`,
        `${paths.relativeRoot}/${kind}/current.json`,
      ]),
    ]),
  ];
}
function verifyPolymorphicTargets(db: Database): void {
  const scratch = disposableSqlite('circus-portable-targets-');
  try {
    scratch.db.exec(
      'CREATE TABLE latest(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE incoming(id TEXT PRIMARY KEY); CREATE TABLE active(id TEXT PRIMARY KEY)',
    );
    const tables = {
      note: 'notes',
      person: 'people',
      observation: 'observations',
      test_type: 'test_types',
      medication: 'medications',
      procedure: 'procedures',
      document: 'documents',
      report: 'reports',
    };
    function hasTarget(type: unknown, id: unknown): boolean {
      if (type === 'source')
        return Boolean(
          db
            .prepare(
              'SELECT 1 FROM source_files WHERE id=? UNION ALL SELECT 1 FROM source_records WHERE id=? LIMIT 1',
            )
            .get(id as SQLInputValue, id as SQLInputValue),
        );
      if (resolveClinicalReference(db, type, id as string)) return true;
      return Boolean(
        tables[type as keyof typeof tables] &&
        db
          .prepare(`SELECT 1 FROM ${quote(tables[type as keyof typeof tables])} WHERE id=?`)
          .get(id as SQLInputValue),
      );
    }
    for (const row of db.prepare('SELECT id,target_type,target_id FROM note_links').iterate())
      if (!hasTarget(row.target_type, row.target_id))
        throw new Error('Rebuilt note-link target missing: ' + row.id);
    for (const row of db.prepare('SELECT id,owner_type,owner_id FROM attachments').iterate())
      if (!hasTarget(row.owner_type, row.owner_id))
        throw new Error('Rebuilt attachment owner missing: ' + row.id);
    for (const row of db.prepare('SELECT id,entity_type,entity_id FROM evidence').iterate())
      if (!hasTarget(row.entity_type, row.entity_id))
        throw new Error('Rebuilt evidence target missing: ' + row.id);
    const occurrenceDecisions = db
      .prepare(
        "SELECT coverage_json FROM manual_batches WHERE title='Duplicate evidence decision' AND json_type(coverage_json,'$.duplicateDecision.occurrenceAttachment')='object' ORDER BY json_extract(coverage_json,'$.duplicateDecision.sequence'),id",
      )
      .iterate();
    for (const stored of occurrenceDecisions) {
      let transition: Record<string, unknown>;
      try {
        transition = (
          JSON.parse(String(stored.coverage_json)) as {
            duplicateDecision: { occurrenceAttachment: Record<string, unknown> };
          }
        ).duplicateDecision.occurrenceAttachment;
      } catch {
        throw new Error('Rebuilt occurrence attachment receipt is malformed');
      }
      if (
        transition.format !== 'reviewed-occurrence-attachment-v1' ||
        !['attached', 'withdrawn'].includes(String(transition.status)) ||
        typeof transition.id !== 'string' ||
        typeof transition.incomingSourceRecordId !== 'string' ||
        typeof transition.targetKind !== 'string' ||
        typeof transition.targetRecordId !== 'string' ||
        typeof transition.evidenceId !== 'string' ||
        typeof transition.evidenceRowHash !== 'string' ||
        typeof transition.durableAuthorityHash !== 'string' ||
        typeof transition.contextHash !== 'string' ||
        typeof transition.at !== 'string' ||
        !(
          transition.previousTransitionId === null ||
          typeof transition.previousTransitionId === 'string'
        ) ||
        !Number.isSafeInteger(transition.appliedRevision)
      )
        throw new Error('Rebuilt occurrence attachment receipt is incomplete');
      if (
        !hasTarget(transition.targetKind, transition.targetRecordId) ||
        !hasTarget('source', transition.incomingSourceRecordId)
      )
        throw new Error('Rebuilt occurrence attachment target or source is missing');
      scratch.db
        .prepare('INSERT OR REPLACE INTO latest VALUES(?,?)')
        .run(
          JSON.stringify([
            transition.incomingSourceRecordId,
            transition.targetKind,
            transition.targetRecordId,
          ]),
          JSON.stringify(transition),
        );
    }
    for (const row of scratch.db.prepare('SELECT value FROM latest').iterate()) {
      const transition = JSON.parse(String(row.value)) as Record<string, unknown>;
      const evidence = db
        .prepare(
          'SELECT id,entity_type,entity_id,source_record_id,role,locator_json FROM evidence WHERE id=?',
        )
        .get(transition.evidenceId as SQLInputValue);
      if (transition.status === 'withdrawn') {
        if (evidence) throw new Error('Rebuilt withdrawn occurrence evidence still exists');
        continue;
      }
      if (
        !evidence ||
        evidence.entity_type !== transition.targetKind ||
        evidence.entity_id !== transition.targetRecordId ||
        evidence.source_record_id !== transition.incomingSourceRecordId ||
        evidence.role !== 'same_event_occurrence' ||
        createHash('sha256').update(canonicalLiteral(evidence)).digest('hex') !==
          transition.evidenceRowHash
      )
        throw new Error('Rebuilt occurrence evidence does not match its receipt');
      let locator: Record<string, unknown>;
      try {
        locator = JSON.parse(String(evidence.locator_json)) as Record<string, unknown>;
      } catch {
        throw new Error('Rebuilt occurrence evidence locator is malformed');
      }
      if (
        locator.attachmentTransitionId !== transition.id ||
        locator.incomingSourceRecordId !== transition.incomingSourceRecordId
      )
        throw new Error('Rebuilt occurrence evidence lineage does not match its receipt');
      if (
        scratch.db
          .prepare('SELECT 1 FROM incoming WHERE id=?')
          .get(String(transition.incomingSourceRecordId))
      )
        throw new Error('Rebuilt occurrence is attached to multiple clinical targets');
      scratch.db
        .prepare('INSERT INTO incoming VALUES(?)')
        .run(String(transition.incomingSourceRecordId));
      scratch.db
        .prepare('INSERT OR IGNORE INTO active VALUES(?)')
        .run(String(transition.evidenceId));
    }
    for (const evidence of db
      .prepare("SELECT id FROM evidence WHERE role='same_event_occurrence'")
      .iterate())
      if (!scratch.db.prepare('SELECT 1 FROM active WHERE id=?').get(String(evidence.id)))
        throw new Error('Rebuilt occurrence evidence has no active durable receipt');
    const visibilityTables = {
      note: 'notes',
      person: 'people',
      observation: 'observations',
      test_type: 'test_types',
      medication: 'medications',
      procedure: 'procedures',
      document: 'documents',
      source: 'source_records',
      source_file: 'source_files',
    };
    if (tableNames(db).includes('visibility_events'))
      for (const row of db.prepare('SELECT * FROM visibility_events').iterate()) {
        const table = visibilityTables[row.target_type as keyof typeof visibilityTables];
        if (
          !table ||
          (!db.prepare(`SELECT 1 FROM ${quote(table)} WHERE id=?`).get(row.target_id) &&
            !resolveClinicalReference(db, row.target_type, row.target_id as string))
        )
          throw new Error('Rebuilt visibility target missing');
        if (row.target_type === 'person' && row.target_id === 'patient')
          throw new Error('Self cannot have visibility events');
        if (
          row.target_type === 'note' &&
          db.prepare('SELECT kind FROM notes WHERE id=?').get(row.target_id)!.kind === 'person'
        )
          throw new Error('Person visibility requires its canonical person identity');
      }
  } finally {
    scratch.close();
  }
}

export function exportCuration(db: Database, root: string, profileId: string) {
  checkOwner(db, profileId);
  if (recordDurabilityStatus(db)) {
    const personal = flushRecordDurability(db)!;
    const value = String(personal.persistedRevision);
    const expected = expectIntakeFrontierCurationRevisionWrite(db, value);
    let written = false;
    try {
      written = putMeta(db, 'curation_revision', value).changes === 1;
    } finally {
      finishIntakeFrontierCurationRevisionWrite(db, expected, written);
    }
    return { profileId, revision: personal.revision, personal, format: personal.format };
  }
  const state = config.get(db);
  if (!state) attachPersonalDurability(db, { root, profileId, portableSnapshots: true });
  else if (state.root !== root || state.profileId !== profileId)
    throw new Error('Durability storage location mismatch');
  const current = config.get(db)!;
  db.exec('BEGIN IMMEDIATE');
  let personalSaved = false;
  try {
    writePersonalLocked(db, current);
    personalSaved = true;
    const snapshot = curationSnapshot(db, root, profileId);
    const manifest = writeGeneration(profilePaths(root, profileId).curation, snapshot);
    putMeta(db, 'curation_revision', snapshot.revision);
    db.exec('COMMIT');
    return {
      profileId,
      revision: snapshot.revision,
      path: resolve(profilePaths(root, profileId).curation, manifest.file),
      rawJson: snapshot.rawJson,
      personal: personalDurabilityStatus(db),
    };
  } catch (error) {
    db.exec('ROLLBACK');
    if (!personalSaved) {
      rememberFailure(db, current, error);
      throw new Error(
        'Personal snapshot must be durable before curation export: ' + (error as Error).message,
      );
    }
    throw error;
  }
}

export function portableFileDigest(path: string): { bytes: number; sha256: string } {
  portableWork('fileHashCalls', 1);
  const fd = openSync(path, 'r'),
    block = Buffer.alloc(64 * 1024),
    hash = createHash('sha256');
  let bytes = 0;
  try {
    for (
      let size = readSync(fd, block, 0, block.length, null);
      size;
      size = readSync(fd, block, 0, block.length, null)
    ) {
      bytes += size;
      portableWork('fileHashBytes', size);
      portableWork('maxReadBufferBytes', block.length, true);
      hash.update(block.subarray(0, size));
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}
export function durableWriteChunks(path: string, chunks: Iterable<string | Buffer>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const pending = path + '.pending-' + randomUUID(),
    fd = openSync(pending, 'wx', 0o600);
  let closed = false;
  try {
    for (const chunk of chunks) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      portableWork('outputBytes', bytes.length);
      portableWork('maxOutputChunkBytes', bytes.length, true);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fsyncSync(fd);
    closeSync(fd);
    closed = true;
    renameSync(pending, path);
    syncDirectory(dirname(path));
  } catch (error) {
    if (!closed) closeSync(fd);
    rmSync(pending, { force: true });
    throw error;
  }
}

export async function portableFileDigestAsync(
  path: string,
  checkpoint: () => void,
): Promise<{
  bytes: number;
  sha256: string;
  stamp: Readonly<
    Record<'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs' | 'mode' | 'nlink', string>
  >;
}> {
  checkpoint();
  const fd = openSync(path, 'r');
  try {
    const initial = fstatSync(fd, { bigint: true });
    if (!initial.isFile()) throw Error('Portable backup source file changed');
    const hash = createHash('sha256');
    const block = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      checkpoint();
      const size = readSync(fd, block, 0, block.length, null);
      if (!size) break;
      hash.update(block.subarray(0, size));
      bytes += size;
      portableWork('fileHashBytes', size);
      portableWork('maxReadBufferBytes', block.length, true);
      portableWork('backupYields', 1);
      // The next loop-top proof runs first on the resumed turn, before any read.
      await setImmediate();
    }
    const held = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      !named.isFile() ||
      held.dev !== initial.dev ||
      named.dev !== initial.dev ||
      held.ino !== initial.ino ||
      named.ino !== initial.ino ||
      held.size !== initial.size ||
      named.size !== initial.size ||
      held.mtimeNs !== initial.mtimeNs ||
      named.mtimeNs !== initial.mtimeNs ||
      held.ctimeNs !== initial.ctimeNs ||
      named.ctimeNs !== initial.ctimeNs ||
      BigInt(bytes) !== initial.size
    )
      throw Error('Portable backup source file changed');
    checkpoint();
    return {
      bytes,
      sha256: hash.digest('hex'),
      stamp: {
        dev: String(held.dev),
        ino: String(held.ino),
        size: String(held.size),
        mtimeNs: String(held.mtimeNs),
        ctimeNs: String(held.ctimeNs),
        mode: String(held.mode),
        nlink: String(held.nlink),
      },
    };
  } finally {
    closeSync(fd);
  }
}

/** Bytes of encoded backup output gathered per file write. */
export const DURABLE_OUTPUT_BUFFER_BYTES = 64 * 1024;

declare const durableChunkArtifactBrand: unique symbol;
export interface DurableChunkArtifact {
  readonly [durableChunkArtifactBrand]: true;
}
const durableChunkArtifacts = new WeakMap<
  DurableChunkArtifact,
  {
    owner: ReturnType<typeof captureRecordHeadPhysical>;
    parent: ReturnType<typeof captureRecordHeadPhysical>;
    path: string;
    dev: bigint;
    ino: bigint;
  }
>();
export class DurableChunkArtifactChangedError extends Error {
  constructor() {
    super('Portable backup retained output changed');
    this.name = 'DurableChunkArtifactChangedError';
  }
}
export function assertDurableChunkArtifactCurrent(artifact: DurableChunkArtifact): void {
  const owner = durableChunkArtifacts.get(artifact)?.owner;
  if (!owner?.current()) throw new DurableChunkArtifactChangedError();
}
export function disposeDurableChunkArtifact(artifact: DurableChunkArtifact, discard = false): void {
  const data = durableChunkArtifacts.get(artifact);
  if (!data) return;
  durableChunkArtifacts.delete(artifact);
  try {
    // The enclosing backup directory owns broader cleanup. A direct failed
    // operation must never remove a replacement that this artifact did not own.
    if (discard && data.parent.current()) {
      try {
        const named = lstatSync(data.path, { bigint: true });
        if (named.isFile() && named.dev === data.dev && named.ino === data.ino)
          rmSync(data.path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  } finally {
    try {
      data.owner.close();
    } finally {
      data.parent.close();
    }
  }
}

/** Retain the verified, unpublished output before returning across an await. */
export async function durableWriteRetainedChunksAsync(
  path: string,
  chunks: AsyncIterable<string | Buffer>,
  checkpoint: () => void,
): Promise<DurableChunkArtifact> {
  return (await durableWriteChunksOperation(path, chunks, checkpoint, true))!;
}

/** Cooperative private-backup writer. Its caller retains the source proof
 * across every yield and through the final archive publication. `checkpoint`
 * runs at the start, before and after each of this writer's yields and at
 * completion, so its work scales with yields rather than received chunks. A
 * chunk source that yields to the event loop itself must run the same proof
 * before and after that yield. */
export async function durableWriteChunksAsync(
  path: string,
  chunks: AsyncIterable<string | Buffer>,
  checkpoint: () => void,
): Promise<void> {
  await durableWriteChunksOperation(path, chunks, checkpoint, false);
}

async function durableWriteChunksOperation(
  path: string,
  chunks: AsyncIterable<string | Buffer>,
  checkpoint: () => void,
  retain: boolean,
): Promise<DurableChunkArtifact | undefined> {
  checkpoint();
  if (retain && existsSync(path)) throw Error('Portable backup retained output already exists');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const pending = path + '.pending-' + randomUUID();
  const fd = openSync(pending, 'wx', 0o600);
  const opened = fstatSync(fd, { bigint: true });
  const digest = createHash('sha256');
  let closed = false;
  let written = 0n;
  let quantum = 0;
  let completed: BigIntStats | undefined;
  let renamed = false;
  let retainedParent: ReturnType<typeof captureRecordHeadPhysical> | undefined;
  const current = () => {
    checkpoint();
    if (retainedParent && !retainedParent.current())
      throw Error('Portable backup retained parent changed');
    const held = fstatSync(fd, { bigint: true });
    const named = lstatSync(renamed ? path : pending, { bigint: true });
    if (
      !held.isFile() ||
      !named.isFile() ||
      held.nlink !== 1n ||
      named.nlink !== 1n ||
      held.dev !== opened.dev ||
      named.dev !== opened.dev ||
      held.ino !== opened.ino ||
      named.ino !== opened.ino ||
      held.size !== written ||
      named.size !== written ||
      (completed &&
        (held.mtimeNs !== completed.mtimeNs ||
          named.mtimeNs !== completed.mtimeNs ||
          held.ctimeNs !== completed.ctimeNs ||
          named.ctimeNs !== completed.ctimeNs))
    )
      throw Error('Portable backup staged output changed');
  };
  // Encoded output gathers in one bounded buffer and reaches the file in
  // writes of at most its size. It is always flushed before a proof, so every
  // proof still sees exactly the bytes received so far.
  const pendingOutput = Buffer.allocUnsafe(DURABLE_OUTPUT_BUFFER_BYTES);
  let pendingBytes = 0;
  const flush = () => {
    let offset = 0;
    while (offset < pendingBytes) {
      const count = writeSync(fd, pendingOutput, offset, pendingBytes - offset);
      if (!count) throw Error('Portable backup output write did not advance');
      offset += count;
    }
    if (pendingBytes) portableWork('outputWrites', 1);
    written += BigInt(pendingBytes);
    pendingBytes = 0;
  };
  const output = (bytes: Buffer) => {
    digest.update(bytes);
    portableWork('outputBytes', bytes.length);
    portableWork('maxOutputChunkBytes', bytes.length, true);
    for (let at = 0; at < bytes.length;) {
      if (pendingBytes === pendingOutput.length) flush();
      const count = bytes.copy(pendingOutput, pendingBytes, at);
      pendingBytes += count;
      at += count;
    }
    quantum += bytes.length;
  };
  const yieldForWork = async () => {
    if (quantum < 64 * 1024) return;
    flush();
    current();
    portableWork('backupYields', 1);
    await setImmediate();
    current();
    quantum = 0;
  };
  try {
    if (retain) retainedParent = captureRecordHeadPhysical([], [dirname(path)]);
    for await (const chunk of chunks) {
      // Writing a received chunk cannot let another host task run. The complete
      // source proof runs at the start, on both sides of every yield below and
      // at the end; the chunk source proves around any yield of its own.
      portableWork('outputChunks', 1);
      if (typeof chunk === 'string') {
        for (let at = 0; at < chunk.length;) {
          let end = Math.min(at + 4096, chunk.length);
          if (end < chunk.length && /[\uD800-\uDBFF]/.test(chunk[end - 1]!)) end--;
          output(Buffer.from(chunk.slice(at, end)));
          at = end;
          await yieldForWork();
        }
      } else {
        for (let at = 0; at < chunk.length; at += 16 * 1024) {
          output(chunk.subarray(at, at + 16 * 1024));
          await yieldForWork();
        }
      }
    }
    flush();
    current();
    fsyncSync(fd);
    completed = fstatSync(fd, { bigint: true });
    current();
    if (retain) {
      // Installation changes ctime. Retained authority is issued only after reading
      // back the final name against the original still-owned output inode.
      // Both names belong to this one pinned output inode. Record the complete
      // pair before the intentional two-link transition, not an unknown unlink
      // of an arbitrary hard-linked file.
      withManagedPhysicalMutation(
        () => {
          rawLinkSync(pending, path);
          renamed = true;
          rawUnlinkSync(pending);
        },
        managedPhysicalMutationPaths([pending, path]),
      );
      syncDirectory(dirname(path));
      completed = fstatSync(fd, { bigint: true });
      current();
    }
    const readback = openSync(renamed ? path : pending, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const reading = fstatSync(readback, { bigint: true });
      if (
        reading.dev !== completed.dev ||
        reading.ino !== completed.ino ||
        reading.size !== completed.size ||
        reading.mtimeNs !== completed.mtimeNs ||
        reading.ctimeNs !== completed.ctimeNs
      )
        throw Error('Portable backup staged output changed');
      const check = createHash('sha256');
      const block = Buffer.alloc(64 * 1024);
      let position = 0;
      while (true) {
        const size = readSync(readback, block, 0, block.length, position);
        if (!size) break;
        check.update(block.subarray(0, size));
        position += size;
        quantum += size;
        await yieldForWork();
      }
      if (BigInt(position) !== written || check.digest('hex') !== digest.digest('hex'))
        throw Error('Portable backup staged output changed');
      const afterRead = fstatSync(readback, { bigint: true });
      if (
        afterRead.size !== completed.size ||
        afterRead.mtimeNs !== completed.mtimeNs ||
        afterRead.ctimeNs !== completed.ctimeNs
      )
        throw Error('Portable backup staged output changed');
    } finally {
      closeSync(readback);
    }
    current();
    if (!retain) {
      closeSync(fd);
      closed = true;
    }
    checkpoint();
    const named = lstatSync(renamed ? path : pending, { bigint: true });
    if (
      !named.isFile() ||
      named.dev !== completed.dev ||
      named.ino !== completed.ino ||
      named.size !== completed.size ||
      named.mtimeNs !== completed.mtimeNs ||
      named.ctimeNs !== completed.ctimeNs
    )
      throw Error('Portable backup staged output changed');
    if (!retain) {
      renameSync(pending, path);
      renamed = true;
      syncDirectory(dirname(path));
    }
    if (retain) {
      const owner = captureRecordHeadPhysical([path], [dirname(path)]);
      try {
        const held = fstatSync(fd, { bigint: true });
        const retained = lstatSync(path, { bigint: true });
        if (
          held.dev !== completed.dev ||
          held.ino !== completed.ino ||
          held.size !== completed.size ||
          held.mtimeNs !== completed.mtimeNs ||
          held.ctimeNs !== completed.ctimeNs ||
          !retained.isFile() ||
          retained.nlink !== 1n ||
          held.nlink !== 1n ||
          retained.dev !== held.dev ||
          retained.ino !== held.ino ||
          retained.size !== held.size ||
          retained.mtimeNs !== held.mtimeNs ||
          retained.ctimeNs !== held.ctimeNs
        )
          throw Error('Portable backup retained output changed');
        if (!owner.current() || !retainedParent!.current())
          throw Error('Portable backup retained output changed');
        closeSync(fd);
        closed = true;
        const artifact = Object.freeze({}) as DurableChunkArtifact;
        durableChunkArtifacts.set(artifact, {
          owner,
          parent: retainedParent!,
          path,
          dev: opened.dev,
          ino: opened.ino,
        });
        retainedParent = undefined;
        return artifact;
      } catch (error) {
        owner.close();
        throw error;
      }
    }
  } catch (error) {
    if (!retain) {
      if (!closed) closeSync(fd);
      rmSync(pending, { force: true });
    } else {
      try {
        if (retainedParent?.current()) {
          for (const name of [pending, ...(renamed ? [path] : [])]) {
            try {
              const named = lstatSync(name, { bigint: true });
              if (named.isFile() && named.dev === opened.dev && named.ino === opened.ino)
                rmSync(name, { force: true });
            } catch (cleanup) {
              if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanup;
            }
          }
        }
      } finally {
        if (!closed) closeSync(fd);
      }
    }
    throw error;
  } finally {
    retainedParent?.close();
  }
}

/** Verify file bytes with a fixed read block; originals remain the authority. */
export function verifyPortableOriginal(root: string, profileId: string, file: OriginalFile): void {
  verifyFileDigest(
    profileOriginal(root, file.path, profileId),
    file.bytes,
    file.sha256,
    'Original checksum failed: ' + file.path,
  );
}
function verifyFileDigest(path: string, bytes: number, digest: string, message: string): void {
  portableWork('fileHashCalls', 1);
  const fd = openSync(path, 'r'),
    block = Buffer.alloc(64 * 1024),
    hash = createHash('sha256');
  let total = 0;
  try {
    for (
      let length = readSync(fd, block, 0, block.length, null);
      length;
      length = readSync(fd, block, 0, block.length, null)
    ) {
      total += length;
      portableWork('fileHashBytes', length);
      portableWork('maxReadBufferBytes', block.length, true);
      hash.update(block.subarray(0, length));
    }
    if (total !== bytes || hash.digest('hex') !== digest) throw Error(message);
  } finally {
    closeSync(fd);
  }
}
function selectedGenerationPath(
  directory: string,
  profileId: string,
  kind: PortableKind,
  manifest: PortableManifest,
  verify = true,
): string {
  if (
    !manifest ||
    manifest.format !== 'circus-health-generation-v1' ||
    manifest.profileId !== profileId ||
    manifest.kind !== kind ||
    !safeRelative(manifest.file) ||
    !/^snapshots\/[^/]+\.json$/.test(manifest.file)
  )
    throw Error('Invalid portable generation manifest');
  const file = realpathSync(resolve(directory, manifest.file));
  const contained = relative(realpathSync(directory), file);
  if (contained.startsWith('..') || isAbsolute(contained))
    throw Error('Portable generation escaped its profile');
  if (verify)
    verifyFileDigest(file, manifest.bytes, manifest.sha256, 'Portable generation checksum failed');
  return file;
}
function validateGenerationHeader(
  value: Record<string, unknown>,
  manifest: PortableManifest,
): void {
  if (
    value.format !== 'circus-health-profile-source-v1' ||
    value.profileId !== manifest.profileId ||
    value.kind !== manifest.kind ||
    value.revision !== manifest.revision ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Number.isInteger(value.schemaVersion) ||
    (value.schemaVersion as number) < 1 ||
    (value.schemaVersion as number) > LATEST_SCHEMA_VERSION ||
    (value.clinicalReviewRevision !== undefined &&
      (!Number.isSafeInteger(value.clinicalReviewRevision) ||
        (value.clinicalReviewRevision as number) < 0 ||
        (value.clinicalReviewRevision as number) > (value.revision as number)))
  )
    throw Error('Unsupported portable generation');
}

function checkedCurrentPersonalManifest(root: string, profileId: string): PortableManifest | null {
  const directory = profilePaths(root, profileId).personal;
  return existsSync(resolve(directory, 'current.json'))
    ? checkedGenerationHeader(directory, profileId, 'personal').manifest
    : null;
}
function checkedGenerationHeader(
  directory: string,
  profileId: string,
  kind: PortableKind,
  manifest = JSON.parse(
    readFileSync(resolve(directory, 'current.json'), 'utf8'),
  ) as PortableManifest,
): PortableRows['personal'] {
  const path = selectedGenerationPath(directory, profileId, kind, manifest);
  const value = streamPortableJson(
    path,
    () => {},
    () => {},
    manifest,
    { rowPieces: () => {} },
  );
  validateGenerationHeader(value, manifest);
  return { manifest, value: value as PortableRows['personal']['value'] };
}

/** Bounded header/lineage traversal for production history verification. */
export function* publishedPersonalHeaders(
  root: string,
  profileId: string,
  { manifest }: { manifest?: PortableManifest } = {},
): Generator<PortableRows['personal']> {
  const directory = profilePaths(root, profileId).personal;
  if (!manifest && !existsSync(resolve(directory, 'current.json'))) return;
  let selected =
    manifest ??
    (JSON.parse(readFileSync(resolve(directory, 'current.json'), 'utf8')) as PortableManifest);
  const scratch = disposableSqlite('circus-personal-lineage-');
  try {
    scratch.db.exec('CREATE TABLE seen (file TEXT PRIMARY KEY)');
    let revision = Infinity;
    while (true) {
      if (scratch.db.prepare('SELECT 1 FROM seen WHERE file=?').get(selected.file))
        throw Error('Personal history lineage contains a cycle');
      scratch.db.prepare('INSERT INTO seen VALUES(?)').run(selected.file);
      const path = selectedGenerationPath(directory, profileId, 'personal', selected);
      const value = streamPortableJson(
        path,
        () => {},
        () => {},
        selected,
        { rowPieces: () => {} },
      );
      validateGenerationHeader(value, selected);
      if ((value.revision as number) > revision)
        throw Error('Personal history revision order is invalid');
      revision = value.revision as number;
      yield { manifest: selected, value: value as PortableRows['personal']['value'] };
      if (!value.history) return;
      const history = value.history as PortableSnapshot['history'];
      if (history!.format !== 'circus-health-personal-lineage-v1')
        throw Error('Unsupported personal history lineage');
      if (!history!.previous) return;
      selected = history!.previous;
    }
  } finally {
    scratch.close();
  }
}
function durableCopyFile(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const pending = target + '.pending-' + randomUUID();
  try {
    portableWork('fileCopyCalls', 1);
    copyFileSync(source, pending);
    portableWork('fileCopyBytes', statSync(pending).size);
    chmodSync(pending, 0o600);
    const fd = openSync(pending, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(pending, target);
    syncDirectory(dirname(target));
  } catch (error) {
    rmSync(pending, { force: true });
    throw error;
  }
}

let portableTables: ReadonlySet<string> | undefined;
function supportedPortableTables(profileId: string): ReadonlySet<string> {
  if (!portableTables) {
    const schema = openDatabase(':memory:', profileId);
    try {
      portableTables = new Set(tableNames(schema));
    } finally {
      schema.close();
    }
  }
  return portableTables;
}
/** Authenticated selected generations, indexed privately one row at a time.
 * Callers own close(), including rejected/cancelled copies. The scratch index
 * is never a recovery authority: it is rebuilt only from the pinned evidence. */
export function openPortableRows(
  root: string,
  profileId: string,
  pinned: PinnedGenerations = {},
): PortableRows {
  const scratch = disposableSqlite('circus-portable-rows-'),
    db = scratch.db;
  try {
    db.exec(`CREATE TABLE inventory(kind TEXT, name TEXT, PRIMARY KEY(kind,name));
      CREATE TABLE rows(kind TEXT, name TEXT, ordinal INTEGER PRIMARY KEY, value TEXT);
      CREATE INDEX rows_table ON rows(kind,name,ordinal);
      CREATE TABLE sources(id TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE originals(path TEXT PRIMARY KEY, sort BLOB, value TEXT);
      CREATE TABLE preferences(key TEXT PRIMARY KEY);
      BEGIN;`);
    // Selection runs in one private scratch transaction, committed before the
    // rows are handed out; a refusal disposes the scratch with it.
    const insert = db.prepare('INSERT INTO rows(kind,name,value) VALUES(?,?,?)');
    const paths = profilePaths(root, profileId);
    function generation(kind: PortableKind): PortableRows['personal'] {
      const manifest =
        pinned[kind] ??
        (JSON.parse(
          readFileSync(resolve(paths[kind], 'current.json'), 'utf8'),
        ) as PortableManifest);
      const file = selectedGenerationPath(paths[kind], profileId, kind, manifest);
      const header = streamPortableJson(
        file,
        (name, field) => {
          if (!field && !supportedPortableTables(profileId).has(name))
            throw Error('Unknown portable table: ' + name);
          db.prepare('DELETE FROM rows WHERE kind=? AND name=?').run(kind, name);
          db.prepare('INSERT OR IGNORE INTO inventory VALUES(?,?)').run(kind, name);
        },
        (name, row) => {
          if (!row || typeof row !== 'object' || Array.isArray(row))
            throw Error('Invalid portable row');
          insert.run(kind, name, JSON.stringify(row));
        },
        manifest,
        {
          tablesStart: () => {
            db.prepare("DELETE FROM rows WHERE kind=? AND name NOT LIKE '$%'").run(kind);
            db.prepare("DELETE FROM inventory WHERE kind=? AND name NOT LIKE '$%'").run(kind);
          },
        },
      );
      validateGenerationHeader(header, manifest);
      return { manifest, value: header as PortableRows['personal']['value'] };
    }
    const personal = generation('personal'),
      curation = generation('curation');
    if (personal.value.revision < curation.value.revision)
      throw Error('Personal snapshot predates the curation snapshot');
    const has = (kind: string, name: string) =>
      !!db.prepare('SELECT 1 FROM inventory WHERE kind=? AND name=?').get(kind, name);
    const read = function* (kind: string, name: string): Generator<PortableRow> {
      for (const row of db
        .prepare('SELECT value FROM rows WHERE kind=? AND name=? ORDER BY ordinal')
        .iterate(kind, name))
        yield JSON.parse(String(row.value)) as PortableRow;
    };
    for (const table of PERSONAL_TABLES) {
      if (
        ((table === 'medication_preferences' && personal.value.schemaVersion < 4) ||
          (table === 'visibility_events' && personal.value.schemaVersion < 6)) &&
        !has('personal', table)
      )
        db.prepare('INSERT INTO inventory VALUES(?,?)').run('personal', table);
      if (!has('personal', table) || has('curation', table))
        throw Error('Invalid portable table ownership');
    }
    for (const row of db.prepare('SELECT name FROM inventory WHERE kind=?').iterate('personal'))
      if (
        !String(row.name).startsWith('$') &&
        ![...PERSONAL_TABLES, 'evidence'].includes(String(row.name))
      )
        throw Error('Invalid personal portable table ownership');
    if (!has('personal', 'evidence') || !has('curation', 'evidence'))
      throw Error('Invalid personal portable table ownership');
    for (const kind of ['personal', 'curation'])
      for (const row of read(kind, 'evidence'))
        if (['note', 'person'].includes(String(row.entity_type)) !== (kind === 'personal'))
          throw Error('Invalid portable evidence ownership');
    for (const type of ['restore', 'assistant'] as const) {
      for (const row of read(
        'personal',
        type === 'restore' ? '$restoreOperations' : '$assistantOperations',
      )) {
        let valid = false;
        try {
          const operation = typeof row.value === 'string' ? JSON.parse(row.value) : null;
          valid =
            !!operation &&
            new RegExp(`^personal_${type}_[0-9a-f-]{36}$`, 'i').test(String(row.key)) &&
            operation.profileId === profileId &&
            typeof operation.noteId === 'string' &&
            (type === 'restore'
              ? row.key === `personal_restore_${operation.operationId}` &&
                typeof operation.fingerprint === 'string' &&
                Number.isInteger(operation.previousVersion) &&
                Number.isInteger(operation.currentVersion)
              : row.key === `personal_assistant_${operation.proposalId}` &&
                typeof operation.kind === 'string' &&
                Number.isInteger(operation.version) &&
                operation.version >= 1);
        } catch {
          /* Refuse malformed receipt. */
        }
        if (!valid)
          throw Error(
            type === 'restore'
              ? 'Invalid personal restore receipts'
              : 'Invalid personal assistant receipts',
          );
      }
    }
    for (const row of read('personal', '$packetPreferences')) {
      validatePacketPreferenceRows([row]);
      if (db.prepare('SELECT 1 FROM preferences WHERE key=?').get(String(row.key)))
        throw Error('Invalid stored packet preference');
      db.prepare('INSERT INTO preferences VALUES(?)').run(String(row.key));
    }
    if (!has('curation', 'source_files') || !has('curation', 'source_records'))
      throw Error('Incomplete portable source tables');
    const originals = function* (): Generator<OriginalFile> {
      for (const row of db.prepare('SELECT value FROM originals ORDER BY sort').iterate())
        yield JSON.parse(String(row.value)) as OriginalFile;
    };
    function addOriginal(file: OriginalFile): void {
      verifyPortableOriginal(root, profileId, file);
      const prior = db.prepare('SELECT value FROM originals WHERE path=?').get(file.path);
      if (prior) {
        const existing = JSON.parse(String(prior.value)) as OriginalFile;
        if (existing.sha256 !== file.sha256 || existing.bytes !== file.bytes)
          throw Error('Conflicting original metadata');
      }
      const sort = Buffer.from([file.path, file.sha256, file.bytes].toString(), 'utf16le');
      sort.swap16();
      db.prepare('INSERT OR REPLACE INTO originals VALUES(?,?,?)').run(
        file.path,
        sort,
        JSON.stringify(file),
      );
    }
    for (const file of read('curation', 'source_files')) {
      addOriginal(file as OriginalFile);
      db.prepare('INSERT OR REPLACE INTO sources VALUES(?,?)').run(
        String(file.id),
        JSON.stringify(file),
      );
    }
    for (const asset of read('personal', 'assets'))
      addOriginal({
        path: asset.stored_path,
        sha256: asset.sha256,
        bytes: asset.bytes,
      } as OriginalFile);
    function resolveRaw(row: PortableRow): PortableRow {
      if (!row.raw_source) {
        if (typeof row.raw_json !== 'string') throw Error('Missing verbatim source record');
        return row;
      }
      const { raw_source, ...metadata } = row,
        ref = raw_source as PortableRow;
      const stored = db
        .prepare('SELECT value FROM sources WHERE id=?')
        .get(String(ref.sourceFileId));
      const source = stored ? (JSON.parse(String(stored.value)) as OriginalFile) : undefined;
      if (
        row.raw_json !== undefined ||
        !source ||
        ref.sourceFileId !== row.source_file_id ||
        !Number.isSafeInteger(ref.offset) ||
        !Number.isSafeInteger(ref.bytes) ||
        (ref.offset as number) < 0 ||
        (ref.bytes as number) < 1 ||
        (ref.offset as number) + (ref.bytes as number) > source.bytes
      )
        throw Error('Invalid canonical raw JSON reference');
      const bytes = Buffer.alloc(ref.bytes as number),
        fd = openSync(profileOriginal(root, source.path, profileId), 'r');
      portableWork('rangeReadCalls', 1);
      portableWork('maxRangeBytes', bytes.length, true);
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(
            fd,
            bytes,
            offset,
            bytes.length - offset,
            (ref.offset as number) + offset,
          );
          if (!count) throw Error('Canonical raw JSON reference checksum failed');
          offset += count;
          portableWork('rangeReadBytes', count);
        }
      } finally {
        closeSync(fd);
      }
      if (sha256(bytes) !== ref.sha256) throw Error('Canonical raw JSON reference checksum failed');
      const raw_json = bytes.toString('utf8');
      if (!Buffer.from(raw_json).equals(bytes)) throw Error('Canonical JSON is not valid UTF-8');
      return { ...metadata, raw_json };
    }
    // Resolve and authenticate canonical ranges once; only the selected raw row
    // is retained in memory, never every original's Buffer.
    for (const entry of db
      .prepare(
        "SELECT ordinal,value FROM rows WHERE kind='curation' AND name='source_records' ORDER BY ordinal",
      )
      .iterate()) {
      const resolved = resolveRaw(JSON.parse(String(entry.value)) as PortableRow);
      db.prepare('UPDATE rows SET value=? WHERE ordinal=?').run(
        JSON.stringify(resolved),
        entry.ordinal!,
      );
    }
    db.exec('COMMIT');
    const selected: PortableRows = {
      personal,
      curation,
      close: scratch.close,
      tableNames: () =>
        db
          .prepare("SELECT DISTINCT name FROM inventory WHERE name NOT LIKE '$%' ORDER BY name")
          .all()
          .map((row) => String(row.name)),
      *rows(name) {
        if (name === 'evidence') {
          yield* read('curation', name);
          yield* read('personal', name);
          return;
        }
        if (name === 'app_meta') {
          for (const row of read('curation', name))
            if (
              !has('personal', '$packetPreferences') ||
              !String(row.key).startsWith(PACKET_PREFERENCE_PREFIX)
            )
              yield row;
          yield* read('personal', '$restoreOperations');
          yield* read('personal', '$assistantOperations');
          yield* read('personal', '$packetPreferences');
          return;
        }
        yield* read(PERSONAL_TABLES.includes(name) ? 'personal' : 'curation', name);
      },
      rowCount(name) {
        const count = (kind: string, table: string) =>
          Number(
            db.prepare('SELECT COUNT(*) n FROM rows WHERE kind=? AND name=?').get(kind, table)!.n,
          );
        if (name === 'evidence') return count('curation', name) + count('personal', name);
        if (name === 'app_meta') {
          const base = has('personal', '$packetPreferences')
            ? Number(
                db
                  .prepare(
                    "SELECT COUNT(*) n FROM rows WHERE kind='curation' AND name='app_meta' AND substr(json_extract(value,'$.key'),1,?)!=?",
                  )
                  .get(PACKET_PREFERENCE_PREFIX.length, PACKET_PREFERENCE_PREFIX)!.n,
              )
            : count('curation', name);
          return (
            base +
            count('personal', '$restoreOperations') +
            count('personal', '$assistantOperations') +
            count('personal', '$packetPreferences')
          );
        }
        return count(PERSONAL_TABLES.includes(name) ? 'personal' : 'curation', name);
      },
      originals,
      originalCount: Number(db.prepare('SELECT COUNT(*) n FROM originals').get()!.n),
    };
    validatePortableIntakeRows(selected, profileId);
    return selected;
  } catch (error) {
    scratch.close();
    throw error;
  }
}

/** Explicit full-work compatibility reader. Production recovery/copy uses openPortableRows. */
export function loadPortable(
  root: string,
  profileId: string,
  pinned: PinnedGenerations = {},
  { allowMissingCuration = false }: { allowMissingCuration?: boolean } = {},
): LoadedPortable {
  const paths = profilePaths(root, profileId);
  const personal = pinned.personal
    ? checkedGeneration(paths.personal, profileId, 'personal', pinned.personal)
    : readGeneration(paths.personal, profileId, 'personal');
  if (allowMissingCuration) {
    for (const asset of personal.value.tables.assets || [])
      checkedBytes(root, profileId, { path: asset.stored_path, ...asset } as OriginalFile);
    return { personal };
  }
  const curation = pinned.curation
    ? checkedGeneration(paths.curation, profileId, 'curation', pinned.curation)
    : readGeneration(paths.curation, profileId, 'curation');
  if (personal.value.revision < curation.value.revision)
    throw new Error('Personal snapshot predates the curation snapshot');
  for (const table of PERSONAL_TABLES) {
    if (
      ((table === 'medication_preferences' && personal.value.schemaVersion < 4) ||
        (table === 'visibility_events' && personal.value.schemaVersion < 6)) &&
      personal.value.tables[table] === undefined
    )
      personal.value.tables[table] = [];
    if (!Array.isArray(personal.value.tables[table]) || curation.value.tables[table] !== undefined)
      throw new Error('Invalid portable table ownership');
  }
  if (
    Object.keys(personal.value.tables).some(
      (table) => ![...PERSONAL_TABLES, 'evidence'].includes(table),
    ) ||
    !Array.isArray(personal.value.tables.evidence) ||
    !Array.isArray(curation.value.tables.evidence)
  )
    throw new Error('Invalid personal portable table ownership');
  if (
    personal.value.tables.evidence.some(
      (row) => !['note', 'person'].includes(row.entity_type as string),
    ) ||
    curation.value.tables.evidence.some((row) =>
      ['note', 'person'].includes(row.entity_type as string),
    )
  )
    throw new Error('Invalid portable evidence ownership');
  const operations = personal.value.restoreOperations || [];
  if (
    !Array.isArray(operations) ||
    operations.some((row) => {
      if (
        !row ||
        !/^personal_restore_[0-9a-f-]{36}$/i.test(row.key as string) ||
        typeof row.value !== 'string'
      )
        return true;
      try {
        const operation = JSON.parse(row.value);
        return (
          !operation ||
          operation.profileId !== profileId ||
          row.key !== `personal_restore_${operation.operationId}` ||
          typeof operation.fingerprint !== 'string' ||
          typeof operation.noteId !== 'string' ||
          !Number.isInteger(operation.previousVersion) ||
          !Number.isInteger(operation.currentVersion)
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error('Invalid personal restore receipts');
  const assistantOperations = personal.value.assistantOperations || [];
  if (
    !Array.isArray(assistantOperations) ||
    assistantOperations.some((row) => {
      if (
        !row ||
        !/^personal_assistant_[0-9a-f-]{36}$/i.test(row.key as string) ||
        typeof row.value !== 'string'
      )
        return true;
      try {
        const operation = JSON.parse(row.value);
        return (
          !operation ||
          operation.profileId !== profileId ||
          row.key !== `personal_assistant_${operation.proposalId}` ||
          typeof operation.noteId !== 'string' ||
          typeof operation.kind !== 'string' ||
          !Number.isInteger(operation.version) ||
          operation.version < 1
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error('Invalid personal assistant receipts');
  const rows: Record<string, PortableRow[]> = {
    ...curation.value.tables,
    ...personal.value.tables,
    evidence: [
      ...(curation.value.tables.evidence || []),
      ...(personal.value.tables.evidence || []),
    ],
  };
  const packetPreferences = personal.value.packetPreferences;
  if (packetPreferences !== undefined) validatePacketPreferenceRows(packetPreferences);
  rows.app_meta = [
    ...(rows.app_meta || []).filter(
      (row) =>
        packetPreferences === undefined || !String(row.key).startsWith(PACKET_PREFERENCE_PREFIX),
    ),
    ...operations,
    ...assistantOperations,
    ...(packetPreferences || []),
  ];
  if (!Array.isArray(rows.source_files) || !Array.isArray(rows.source_records))
    throw new Error('Incomplete portable source tables');
  const files = new Map<string, { file: PortableRow; bytes: Buffer }>();
  for (const file of rows.source_files || [])
    files.set(file.id as string, {
      file,
      bytes: checkedBytes(root, profileId, file as OriginalFile),
    });
  rows.source_records = (rows.source_records || []).map((row) => {
    if (!row.raw_source) {
      if (typeof row.raw_json !== 'string') throw new Error('Missing verbatim source record');
      return row;
    }
    const { raw_source: ref, ...metadata } = row as PortableRow & { raw_source: PortableRow };
    const source = files.get(ref.sourceFileId as string);
    if (
      row.raw_json !== undefined ||
      !source ||
      ref.sourceFileId !== row.source_file_id ||
      !Number.isSafeInteger(ref.offset) ||
      !Number.isSafeInteger(ref.bytes) ||
      (ref.offset as number) < 0 ||
      (ref.bytes as number) < 1 ||
      (ref.offset as number) + (ref.bytes as number) > source.bytes.length
    )
      throw new Error('Invalid canonical raw JSON reference');
    const bytes = source.bytes.subarray(
      ref.offset as number,
      (ref.offset as number) + (ref.bytes as number),
    );
    if (sha256(bytes) !== (ref.sha256 as string))
      throw new Error('Canonical raw JSON reference checksum failed');
    const raw_json = bytes.toString('utf8');
    if (!Buffer.from(raw_json, 'utf8').equals(bytes))
      throw new Error('Canonical JSON is not valid UTF-8');
    return { ...metadata, raw_json };
  });
  const originals = new Map<string, OriginalFile>();
  for (const file of [
    ...(rows.source_files || []),
    ...(rows.assets || []).map((asset) => ({
      path: asset.stored_path,
      sha256: asset.sha256,
      bytes: asset.bytes,
    })),
  ]) {
    checkedBytes(root, profileId, file as OriginalFile);
    const existing = originals.get(file.path as string);
    if (existing && (existing.sha256 !== file.sha256 || existing.bytes !== file.bytes))
      throw new Error('Conflicting original metadata');
    originals.set(file.path as string, file as OriginalFile);
  }
  validatePortableIntakeState(rows, profileId);
  return { personal, curation, rows, originals };
}
export function rebuildProfile(root: string, profileId: string, targetRoot: string) {
  if (hasContributorAuthority(root, profileId))
    return rebuildContributorProfile(root, profileId, targetRoot);
  if (existsSync(resolve(profilePaths(root, profileId).personal, 'pending.json')))
    throw new Error('Pending durable changes require recovery before rebuilding');
  if (
    resolve(targetRoot) === resolve(root) ||
    (existsSync(targetRoot) && readdirSync(targetRoot).length)
  )
    throw new Error('Rebuild target must be new or empty; live storage is never overwritten');
  const portable = openPortableRows(root, profileId);
  const staged = targetRoot + '.rebuild-' + randomUUID();
  let db: Database | undefined;
  try {
    const paths = ensureProfileDirectories(staged, profileId);
    for (const file of portable.originals()) {
      const target = resolve(staged, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      portableWork('fileCopyCalls', 1);
      copyFileSync(profileOriginal(root, file.path, profileId), target);
      portableWork('fileCopyBytes', statSync(target).size);
      verifyPortableOriginal(staged, profileId, file);
    }
    // The loaded generation defines the rebuild. A concurrent later autosave
    // must not move its pointer ahead of the state inserted into this database.
    copyPublishedPersonalHistory(root, profileId, staged, {
      manifest: portable.personal.manifest,
      onFile: () => {},
    });
    copyAssistantJournals(root, profileId, staged, { onFile: () => {} });
    copyIntakeBatchJournals(root, profileId, staged, { onFile: () => {} });
    copyProfileMappings(root, profileId, staged, { onFile: () => {} });
    const retainedCuration = copyRetainedCurationHistory(root, profileId, staged, {
      onFile: () => {},
    });
    for (const kind of ['curation'] as const) {
      const generation = portable[kind];
      const source = profilePaths(root, profileId)[kind],
        target = paths[kind];
      durableCopyFile(
        resolve(source, generation.manifest.file),
        resolve(target, generation.manifest.file),
      );
      durableWrite(
        resolve(target, 'current.json'),
        Buffer.from(JSON.stringify(generation.manifest, null, 2) + '\n'),
      );
    }
    const result = {
      ...projectPortableDatabase(paths.database, profileId, portable),
      path: targetRoot,
      database: profilePaths(targetRoot, profileId).database,
      curationHistory: retainedCuration.receipt,
    };
    durableWrite(
      resolve(staged, 'rebuild-receipt.json'),
      Buffer.from(JSON.stringify(result, null, 2) + '\n'),
    );
    if (existsSync(targetRoot)) rmdirSync(targetRoot);
    renameSync(staged, targetRoot);
    syncDirectory(dirname(targetRoot));
    return result;
  } catch (error) {
    db?.close();
    rmSync(staged, { recursive: true, force: true });
    throw error;
  } finally {
    portable.close();
  }
}

function rebuildContributorProfile(root: string, profileId: string, targetRoot: string) {
  const stage = stageContributorProfileRebuild(root, profileId, targetRoot);
  let db: Database | undefined;
  try {
    const rebuilt = rebuildContributorDatabase(stage.paths.database, stage.staged, profileId);
    db = openDatabase(stage.paths.database, profileId);
    writePortableSources(db, root, profileId, stage.staged, { onFile: () => {} });
    const result = completeContributorProfileRebuild(
      db,
      rebuilt,
      root,
      profileId,
      targetRoot,
      stage,
    );
    db = undefined;
    return result;
  } catch (error) {
    db?.close();
    rmSync(stage.staged, { recursive: true, force: true });
    throw error;
  }
}
/** Cooperative rebuildProfile for contributor authority: the same copies,
 * reconstruction, validation and portable export, with record replay and
 * portable generation output yielding to the host. The source's selected HEAD
 * is proven at start, around every yield and at completion; the private
 * staged reconstruction keeps its own HEAD physical proof. A portable-only
 * archive still uses the synchronous projection path. */
export async function rebuildProfileAsync(
  root: string,
  profileId: string,
  targetRoot: string,
  {
    signal,
    work,
  }: {
    signal?: AbortSignal;
    work?: { record: RecordStepDriverWork; portable: PortableStepWork };
  } = {},
) {
  if (!hasContributorAuthority(root, profileId)) return rebuildProfile(root, profileId, targetRoot);
  const stage = stageContributorProfileRebuild(root, profileId, targetRoot);
  let db: Database | undefined;
  try {
    const sourceCurrent = () => {
      if (selectedContributorHead(root, profileId) !== stage.head)
        throw Error('Contributor authority changed during rebuild');
    };
    sourceCurrent();
    const rebuilt = await rebuildContributorDatabaseAsync(
      stage.paths.database,
      stage.staged,
      profileId,
      { signal, work: work?.record },
    );
    sourceCurrent();
    db = openDatabase(stage.paths.database, profileId);
    const target = db,
      targetCurrent = () => {
        if (!target.isOpen || target.isTransaction)
          throw Error('Contributor rebuild target changed');
        sourceCurrent();
      };
    await writePortableSourcesAsync(
      db,
      root,
      profileId,
      stage.staged,
      { onFile: () => {} },
      targetCurrent,
      { signal, work: work?.portable },
    );
    const result = completeContributorProfileRebuild(
      db,
      rebuilt,
      root,
      profileId,
      targetRoot,
      stage,
    );
    db = undefined;
    return result;
  } catch (error) {
    db?.close();
    rmSync(stage.staged, { recursive: true, force: true });
    throw error;
  }
}
function stageContributorProfileRebuild(root: string, profileId: string, targetRoot: string) {
  if (
    resolve(root) === resolve(targetRoot) ||
    (existsSync(targetRoot) && readdirSync(targetRoot).length)
  )
    throw Error('Rebuild target must be new or empty; live storage is never overwritten');
  const head = selectedContributorHead(root, profileId),
    staged = targetRoot + '.rebuild-' + randomUUID();
  const paths = ensureProfileDirectories(staged, profileId);
  try {
    function copyTree(source: string, target: string): void {
      if (!existsSync(source)) return;
      const stat = lstatSync(source);
      if (stat.isDirectory()) {
        mkdirSync(target, { recursive: true, mode: 0o700 });
        const directory = opendirSync(source);
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync())
            copyTree(resolve(source, entry.name), resolve(target, entry.name));
        } finally {
          directory.closeSync();
        }
        syncDirectory(target);
      } else if (stat.isFile()) durableCopyFile(source, target);
      else throw Error('Rebuild original tree contains nonregular files');
    }
    for (const kind of ['sources', 'attachments'] as const)
      copyTree(profilePaths(root, profileId)[kind], paths[kind]);
    copyContributorAuthority(root, profileId, staged, { onFile: () => {} });
    return { head, staged, paths };
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}
/** Closes `db` on every path; the caller removes the stage on failure. */
function completeContributorProfileRebuild(
  db: Database,
  rebuilt: ReturnType<typeof rebuildContributorDatabase>,
  root: string,
  profileId: string,
  targetRoot: string,
  stage: ReturnType<typeof stageContributorProfileRebuild>,
) {
  let result;
  try {
    copyAssistantJournals(root, profileId, stage.staged, { onFile: () => {} });
    copyIntakeBatchJournals(root, profileId, stage.staged, { onFile: () => {} });
    result = {
      ...rebuilt,
      path: targetRoot,
      database: profilePaths(targetRoot, profileId).database,
      schemaVersion: databaseSchemaVersion(db),
      files: Number(db.prepare('SELECT COUNT(*) n FROM source_files').get()!.n),
      counts: Object.fromEntries(
        tableNames(db).map((table) => [
          table,
          Number(db.prepare(`SELECT COUNT(*) n FROM ${quote(table)}`).get()!.n),
        ]),
      ),
      logicalSha256: logicalDatabaseHash(db),
      databaseBytes: statSync(stage.paths.database).size,
      curationHistory: null,
    };
  } finally {
    db.close();
  }
  if (selectedContributorHead(root, profileId) !== stage.head)
    throw Error('Contributor authority changed during rebuild');
  durableWrite(
    resolve(stage.staged, 'rebuild-receipt.json'),
    Buffer.from(JSON.stringify(result, null, 2) + '\n'),
  );
  if (existsSync(targetRoot)) rmdirSync(targetRoot);
  renameSync(stage.staged, targetRoot);
  syncDirectory(dirname(targetRoot));
  return result;
}

// Construct only the disposable SQLite projection; originals and retained
// history remain in the durable archive root. Callers stage and activate it.
export function projectPortableDatabase(
  database: string,
  profileId: string,
  portable: CompleteLoadedPortable | PortableRows,
  { phase = () => {} }: ProjectPortableOptions = {},
): ProjectPortableResult {
  const streamed = 'tableNames' in portable;
  const names = streamed ? portable.tableNames() : Object.keys(portable.rows);
  const rows = (table: string): Iterable<PortableRow> =>
    streamed ? portable.rows(table) : (portable.rows[table] ?? []);
  if (streamed) validatePortableIntakeRows(portable, profileId);
  else validatePortableIntakeState(portable.rows, profileId);
  if (existsSync(database)) throw new Error('Projection database must be new');
  let db: Database | null | undefined;
  try {
    phase('project');
    db = openDatabase(database, profileId);
    const migrations = db.prepare('SELECT * FROM schema_migrations').all();
    const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
    const indexes = db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all();
    const known = new Set(tableNames(db));
    for (const table of known)
      if (!names.includes(table)) throw new Error('Incomplete portable tables: ' + table);
    // This new, unserved staging database is checked in full before COMMIT.
    // Deferring constraints while inserting child tables ahead of parents can
    // repeatedly scan the growing corpus; one full check is deterministic.
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    try {
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name as string)}`);
      for (const index of indexes) db.exec(`DROP INDEX ${quote(index.name as string)}`);
      for (const table of known) db.exec(`DELETE FROM ${quote(table)}`);
      for (const table of names) {
        const records = rows(table);
        if (!known.has(table)) throw new Error('Unknown portable table: ' + table);
        if (table === 'schema_migrations') continue;
        const columns = new Set<string>(
          db
            .prepare(`PRAGMA table_info(${quote(table)})`)
            .all()
            .map((c) => c.name as string),
        );
        const statements = new Map<string, StatementSync>();
        for (const record of records) {
          const keys = Object.keys(record);
          if (!keys.length || keys.some((key) => !columns.has(key)))
            throw new Error('Unknown portable column in ' + table);
          const sql = `INSERT INTO ${quote(table)} (${keys.map(quote).join(',')}) VALUES(${keys.map(() => '?').join(',')})`;
          if (!statements.has(sql)) {
            if (statements.size >= 32) statements.delete(statements.keys().next().value!);
            statements.set(sql, db.prepare(sql));
          }
          statements.get(sql)!.run(...keys.map((key) => record[key] as SQLInputValue));
        }
      }
      for (const migration of migrations) {
        let original: PortableRow | undefined;
        for (const row of rows('schema_migrations'))
          if (row.version === migration.version) {
            original = row;
            break;
          }
        db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(
          migration.version as SQLInputValue,
          (original?.applied_at ?? portable.personal.value.createdAt) as SQLInputValue,
        );
      }
      checkOwner(db, profileId);
      putMeta(db, 'revision', portable.personal.value.revision);
      // Legacy generations had no separate counter. A conservative broad
      // revision invalidates old review tokens without losing accepted data.
      putMeta(
        db,
        'clinical_review_revision',
        portable.personal.value.clinicalReviewRevision ?? portable.personal.value.revision,
      );
      putMeta(db, 'personal_dirty', '0');
      putMeta(db, 'personal_persisted_revision', portable.personal.value.revision);
      putMeta(db, 'personal_last_error', '');
      putMeta(db, 'personal_conflict', '');
      putMeta(db, 'curation_revision', portable.curation.value.revision);
      phase('index');
      for (const index of indexes) db.exec(index.sql as string);
      for (const trigger of triggers) db.exec(trigger.sql as string);
      phase('integrity');
      if (db.prepare('PRAGMA foreign_key_check').get())
        throw new Error('Rebuilt foreign-key verification failed');
      verifyPolymorphicTargets(db);
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys=ON');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok')
      throw new Error('Rebuilt database integrity failed');
    const result = {
      database,
      profileId,
      revision: revision(db),
      schemaVersion: databaseSchemaVersion(db),
      files: streamed ? portable.originalCount : portable.originals.size,
      counts: Object.fromEntries(
        [...known].map((table) => [
          table,
          db!.prepare(`SELECT COUNT(*) n FROM ${quote(table)}`).get()!.n,
        ]),
      ),
    } as ProjectPortableResult;
    result.logicalSha256 = logicalDatabaseHash(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;
    result.databaseBytes = statSync(database).size;
    return result;
  } finally {
    db?.close();
  }
}

/** Build only a new, unpublished database from the selected portable generations.
 * The restore caller still owns archive/original authority and the final rename. */
function projectionSchemaRows(
  path: string,
  current: () => void,
): {
  rows: readonly Readonly<{
    rowid: number;
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
    type_length: number;
    name_length: number;
    table_length: number;
    sql_length: number | null;
  }>[];
  pragmas: readonly (string | number | bigint)[];
} {
  current();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT rowid,type,name,tbl_name,sql,length(type) AS type_length,
                length(name) AS name_length,length(tbl_name) AS table_length,
                length(sql) AS sql_length FROM sqlite_schema ORDER BY rowid`,
      )
      .all()
      .map((row) => {
        if (
          typeof row.rowid !== 'number' ||
          typeof row.type !== 'string' ||
          typeof row.name !== 'string' ||
          typeof row.tbl_name !== 'string' ||
          (row.sql !== null && typeof row.sql !== 'string') ||
          typeof row.type_length !== 'number' ||
          typeof row.name_length !== 'number' ||
          typeof row.table_length !== 'number' ||
          (row.sql_length !== null && typeof row.sql_length !== 'number')
        )
          throw Error('Portable projection reference schema is invalid');
        return {
          rowid: row.rowid,
          type: row.type,
          name: row.name,
          tbl_name: row.tbl_name,
          sql: row.sql,
          type_length: row.type_length,
          name_length: row.name_length,
          table_length: row.table_length,
          sql_length: row.sql_length,
        };
      });
    const pragmas = [
      'schema_version',
      'user_version',
      'application_id',
      'encoding',
      'page_size',
      'auto_vacuum',
    ].map(
      (name) => Object.values(db.prepare(`PRAGMA ${name}`).get()!)[0] as string | number | bigint,
    );
    current();
    return { rows, pragmas };
  } finally {
    db.close();
  }
}

function assertProjectionSchema(
  path: string,
  expected: ReturnType<typeof projectionSchemaRows>,
  current: () => void,
): void {
  current();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const actualCount = Number(db.prepare('SELECT COUNT(*) AS n FROM sqlite_schema').get()!.n);
    if (actualCount !== expected.rows.length)
      throw Error('Portable projection target schema differs from sealed transfer');
    const rows = db
      .prepare(
        `SELECT rowid,typeof(type) AS type_type,length(type) AS type_length,
                typeof(name) AS name_type,length(name) AS name_length,
                typeof(tbl_name) AS table_type,length(tbl_name) AS table_length,
                typeof(sql) AS sql_type,length(sql) AS sql_length
           FROM sqlite_schema ORDER BY rowid LIMIT ?`,
      )
      .all(expected.rows.length + 1);
    if (rows.length !== expected.rows.length)
      throw Error('Portable projection target schema differs from sealed transfer');
    const read = db.prepare(
      `SELECT substr(type,1,?) AS type,substr(name,1,?) AS name,
              substr(tbl_name,1,?) AS tbl_name,substr(sql,1,?) AS sql,
              length(type) AS type_length,length(name) AS name_length,
              length(tbl_name) AS table_length,length(sql) AS sql_length
         FROM sqlite_schema WHERE rowid=?`,
    );
    const exact = db.prepare(
      `SELECT 1 AS same FROM sqlite_schema
        WHERE rowid=? AND type IS ? AND name IS ? AND tbl_name IS ? AND sql IS ?`,
    );
    for (let index = 0; index < rows.length; index++) {
      current();
      const expectedRow = expected.rows[index]!;
      const meta = rows[index]!;
      if (meta.rowid !== expectedRow.rowid)
        throw Error('Portable projection target schema differs from sealed transfer');
      const fields = [
        ['type', 'type_type', 'type_length', 'type_length'],
        ['name', 'name_type', 'name_length', 'name_length'],
        ['tbl_name', 'table_type', 'table_length', 'table_length'],
        ['sql', 'sql_type', 'sql_length', 'sql_length'],
      ] as const;
      const lengths = fields.map(([field, typeKey, lengthKey, referenceLengthKey]) => {
        const value = expectedRow[field];
        const type = value === null ? 'null' : 'text';
        const length = expectedRow[referenceLengthKey];
        if (meta[typeKey] !== type || meta[lengthKey] !== length)
          throw Error('Portable projection target schema differs from sealed transfer');
        return length === null ? 0 : length + 1;
      });
      const value = read.get(...lengths, meta.rowid) as Record<string, unknown> | undefined;
      if (
        !value ||
        fields.some(
          ([field, , lengthKey]) =>
            value[field] !== expectedRow[field] || value[lengthKey] !== meta[lengthKey],
        ) ||
        !exact.get(
          expectedRow.rowid,
          expectedRow.type,
          expectedRow.name,
          expectedRow.tbl_name,
          expectedRow.sql,
        )
      )
        throw Error('Portable projection target schema differs from sealed transfer');
      current();
    }
    const pragmas = [
      'schema_version',
      'user_version',
      'application_id',
      'encoding',
      'page_size',
      'auto_vacuum',
    ].map((name) => Object.values(db.prepare(`PRAGMA ${name}`).get()!)[0]);
    if (JSON.stringify(pragmas) !== JSON.stringify(expected.pragmas))
      throw Error('Portable projection target schema differs from sealed transfer');
    current();
  } finally {
    db.close();
  }
}

export async function projectPortableDatabaseBounded(
  root: string,
  profileId: string,
  database: string,
  pinned: Readonly<{ personal: PortableManifest; curation: PortableManifest }>,
  checkpoint: () => void,
  { phase = () => {} }: ProjectPortableOptions = {},
): Promise<
  ProjectPortableResult & {
    acceptedSourcesSha256: string;
    originalBytes: number;
    inputRecords: number;
    sourceRecords: number;
    terminalProof: { current(): void; close(): void };
  }
> {
  if (existsSync(database)) throw Error('Projection database must be new');
  const paths = profilePaths(root, profileId);
  const personalFile = selectedGenerationPath(
    paths.personal,
    profileId,
    'personal',
    pinned.personal,
    false,
  );
  const curationFile = selectedGenerationPath(
    paths.curation,
    profileId,
    'curation',
    pinned.curation,
    false,
  );
  const selectedFiles = captureRecordHeadPhysical([personalFile, curationFile], []);
  const reference = resolve(dirname(database), `.portable-reference-${randomUUID()}.sqlite`);
  let inTarget = false;
  const current = () => {
    if (!inTarget) checkpoint();
    if (!selectedFiles.current()) throw Error('Portable selected generation changed');
  };
  let db: Database | undefined;
  let initialTargetFd: number | undefined;
  let targetFd: number | undefined;
  let stagedTargetFile: ReturnType<typeof captureRecordHeadPhysical> | undefined;
  let referenceFile: ReturnType<typeof captureRecordHeadPhysical> | undefined;
  let transfer: ReturnType<typeof createPortableProjectionTransfer> | undefined;
  let originalRoster: ReturnType<typeof createPortableOriginalPhysicalRoster> | undefined;
  let targetFile: ReturnType<typeof captureRecordHeadPhysical> | undefined;
  let originals: ReturnType<typeof createPortableOriginalInventory> | undefined;
  let sourceIndex: ReturnType<typeof createPortableSourceIndex> | undefined;
  let terminalProof: { current(): void; close(): void } | undefined;
  try {
    current();
    verifyFileDigest(
      personalFile,
      pinned.personal.bytes,
      pinned.personal.sha256,
      'Portable generation checksum failed',
    );
    current();
    verifyFileDigest(
      curationFile,
      pinned.curation.bytes,
      pinned.curation.sha256,
      'Portable generation checksum failed',
    );
    originalRoster = createPortableOriginalPhysicalRoster(root, profileId, current);
    originals = createPortableOriginalInventory(current, (original) =>
      originalRoster!.add(original),
    );
    sourceIndex = createPortableSourceIndex(current);
    current();
    phase('project');
    current();
    initialTargetFd = openSync(reference, 'wx', 0o600);
    db = openDatabase(reference, profileId);
    const known = tableNames(db);
    const migrations = db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => Number(row.version));
    const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
    const indexes = db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all();
    const schema = new Map(
      known.map(
        (table) =>
          [
            table,
            db!
              .prepare(`PRAGMA table_info(${quote(table)})`)
              .all()
              .map((column) => String(column.name)),
          ] as const,
      ),
    );
    const sidecars = ['-wal', '-shm', '-journal'] as const;
    const initialSidecars = sidecars.filter((suffix) => existsSync(reference + suffix));
    stagedTargetFile = captureRecordHeadPhysical(
      [resolve(reference), ...initialSidecars.map((suffix) => resolve(reference + suffix))],
      [],
    );
    const stagedTargetCurrent = () => {
      current();
      if (
        !stagedTargetFile!.current() ||
        sidecars.some(
          (suffix) => existsSync(reference + suffix) !== initialSidecars.includes(suffix),
        )
      )
        throw Error('Portable projection target changed before transaction');
    };
    transfer = createPortableProjectionTransfer(schema, current);
    const specialFields = selectedPortablePersonalSpecialFields(
      personalFile,
      pinned.personal,
      current,
    );
    const curation = stagePortableGenerationRows(
      curationFile,
      pinned.curation,
      schema,
      transfer,
      current,
      new Set(PERSONAL_TABLES),
      sourceIndex,
      { root, profileId },
      originals,
      new Map(),
      specialFields.has('packetPreferences') ? PACKET_PREFERENCE_PREFIX : undefined,
    );
    validateGenerationHeader(curation.header, pinned.curation);
    const personal = stagePortableGenerationRows(
      personalFile,
      pinned.personal,
      schema,
      transfer,
      current,
      new Set(known.filter((name) => !PERSONAL_TABLES.includes(name) && name !== 'evidence')),
      undefined,
      undefined,
      originals,
      curation.rows,
    );
    validateGenerationHeader(personal.header, pinned.personal);
    if ((personal.header.revision as number) < (curation.header.revision as number))
      throw Error('Personal snapshot predates the curation snapshot');
    for (const table of PERSONAL_TABLES) {
      const legacyMissing =
        (table === 'medication_preferences' && (personal.header.schemaVersion as number) < 4) ||
        (table === 'visibility_events' && (personal.header.schemaVersion as number) < 6);
      if ((!legacyMissing && !personal.rows.has(table)) || curation.deferred.has(table))
        throw Error('Invalid portable table ownership');
    }
    if (!personal.rows.has('evidence') || !curation.rows.has('evidence'))
      throw Error('Invalid personal portable table ownership');
    if (!curation.rows.has('source_files') || !curation.rows.has('source_records'))
      throw Error('Incomplete portable source tables');
    for (const table of known)
      if (
        !curation.rows.has(table) &&
        !personal.rows.has(table) &&
        !(
          (table === 'medication_preferences' && (personal.header.schemaVersion as number) < 4) ||
          (table === 'visibility_events' && (personal.header.schemaVersion as number) < 6)
        )
      )
        throw Error('Incomplete portable tables: ' + table);
    if (
      [...personal.deferred].some(([name]) => schema.has(name)) ||
      [...curation.deferred].some(([name]) => PERSONAL_TABLES.includes(name))
    )
      throw Error('Invalid portable table ownership');
    const special = stagePortablePersonalSpecialRows(
      personalFile,
      pinned.personal,
      transfer,
      curation.rows.get('app_meta') ?? 0,
      profileId,
      current,
    );
    if ([...specialFields].some((field) => !special.fields.has(field)))
      throw Error('Portable selected special field changed');
    const expected = new Map<string, number>(known.map((table) => [table, 0]));
    for (const [table, count] of curation.rows) expected.set(table, count);
    for (const [table, count] of personal.rows) expected.set(table, count);
    expected.set('app_meta', special.nextOrdinal);
    transfer.assertInventory(expected);
    transfer.seal();
    current();
    await verifyPortableOriginalInventory(root, profileId, originals, current);
    originalRoster.current(originals.count());
    current();
    stagedTargetCurrent();
    phase('index');
    stagedTargetCurrent();
    originalRoster.current(originals.count());
    stagedTargetFile.close();
    stagedTargetFile = undefined;
    inTarget = true;
    const project = (active: Database, path: string): ProjectPortableResult => {
      if (JSON.stringify(tableNames(active)) !== JSON.stringify(known))
        throw Error('Portable projection target schema changed');
      for (const [table, columns] of schema) {
        const actual = active
          .prepare(`PRAGMA table_info(${quote(table)})`)
          .all()
          .map((column) => String(column.name));
        if (JSON.stringify(actual) !== JSON.stringify(columns))
          throw Error('Portable projection target columns changed');
      }
      const actualMigrations = active
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => Number(row.version));
      const actualTriggers = active
        .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")
        .all();
      const actualIndexes = active
        .prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
        .all();
      if (
        JSON.stringify(actualMigrations) !== JSON.stringify(migrations) ||
        JSON.stringify(actualTriggers) !== JSON.stringify(triggers) ||
        JSON.stringify(actualIndexes) !== JSON.stringify(indexes)
      )
        throw Error('Portable projection target schema changed');
      active.exec('PRAGMA foreign_keys=OFF');
      transaction(active, () => {
        const token = currentTransactionToken(active);
        if (!token) throw Error('Portable projection target transaction unavailable');
        for (const trigger of triggers)
          active.exec(`DROP TRIGGER ${quote(trigger.name as string)}`);
        for (const index of indexes) active.exec(`DROP INDEX ${quote(index.name as string)}`);
        for (const table of known) active.exec(`DELETE FROM ${quote(table)}`);
        transfer!.withTarget(active, token, (view) => {
          for (const table of known)
            if (table !== 'schema_migrations' && view.apply(table) !== expected.get(table))
              throw Error('Portable projection row count changed');
          view.applyMigrations(
            migrations,
            personal.header.createdAt as string | number | bigint | null,
          );
        });
        const curationEvidence = curation.rows.get('evidence') ?? 0;
        const mixedEvidence = active
          .prepare(
            `SELECT 1 FROM (
             SELECT entity_type, row_number() OVER (ORDER BY rowid) AS ordinal FROM evidence
           ) WHERE (ordinal<=? AND entity_type IN ('note','person'))
               OR (ordinal>? AND entity_type NOT IN ('note','person')) LIMIT 1`,
          )
          .get(curationEvidence, curationEvidence);
        if (mixedEvidence) throw Error('Invalid portable evidence ownership');
        checkOwner(active, profileId);
        putMeta(active, 'revision', personal.header.revision);
        putMeta(
          active,
          'clinical_review_revision',
          personal.header.clinicalReviewRevision ?? personal.header.revision,
        );
        putMeta(active, 'personal_dirty', '0');
        putMeta(active, 'personal_persisted_revision', personal.header.revision);
        putMeta(active, 'personal_last_error', '');
        putMeta(active, 'personal_conflict', '');
        putMeta(active, 'curation_revision', curation.header.revision);
        for (const index of indexes) active.exec(index.sql as string);
        for (const trigger of triggers) active.exec(trigger.sql as string);
        if (active.prepare('PRAGMA foreign_key_check').get())
          throw Error('Rebuilt foreign-key verification failed');
        verifyPolymorphicTargets(active);
      });
      transfer!.assertReleased();
      // The managed wrapper advances live-write counters after its callback.
      putMeta(active, 'revision', personal.header.revision);
      putMeta(
        active,
        'clinical_review_revision',
        personal.header.clinicalReviewRevision ?? personal.header.revision,
      );
      if (active.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok')
        throw Error('Rebuilt database integrity failed');
      const result: ProjectPortableResult = {
        database: path,
        profileId,
        revision: revision(active),
        schemaVersion: databaseSchemaVersion(active),
        files: originals!.count(),
        counts: Object.fromEntries(
          known.map((table) => [
            table,
            active.prepare(`SELECT COUNT(*) n FROM ${quote(table)}`).get()!.n,
          ]),
        ),
        logicalSha256: '',
        databaseBytes: 0,
      };
      active.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      active.exec('PRAGMA journal_mode=DELETE');
      active.close();
      result.databaseBytes = statSync(path).size;
      return result;
    };
    const referenceResult = project(db, reference);
    db = undefined;
    const firstReference = fstatSync(initialTargetFd, { bigint: true });
    const namedReference = lstatSync(reference, { bigint: true });
    if (
      firstReference.dev !== namedReference.dev ||
      firstReference.ino !== namedReference.ino ||
      !namedReference.isFile()
    )
      throw Error('Portable projection reference identity changed');
    referenceFile = captureRecordHeadPhysical([resolve(reference)], []);
    const referenceCurrent = () => {
      current();
      if (
        !referenceFile!.current() ||
        existsSync(reference + '-wal') ||
        existsSync(reference + '-shm') ||
        existsSync(reference + '-journal')
      )
        throw Error('Portable projection reference changed');
    };
    referenceCurrent();
    const expectedHash = logicalDatabaseHashIncremental(reference, referenceCurrent);
    const expectedSchema = projectionSchemaRows(reference, referenceCurrent);
    referenceCurrent();
    referenceFile.close();
    referenceFile = undefined;
    closeSync(initialTargetFd);
    initialTargetFd = undefined;
    rawUnlinkSync(reference);
    targetFd = openSync(database, 'wx', 0o600);
    db = openDatabase(database, profileId);
    const result = project(db, database);
    db = undefined;
    if (
      result.revision !== referenceResult.revision ||
      result.schemaVersion !== referenceResult.schemaVersion ||
      result.files !== referenceResult.files ||
      JSON.stringify(result.counts) !== JSON.stringify(referenceResult.counts)
    )
      throw Error('Portable projection target inventory differs from sealed transfer');
    const firstTarget = fstatSync(targetFd, { bigint: true });
    const namedTarget = lstatSync(database, { bigint: true });
    if (
      firstTarget.dev !== namedTarget.dev ||
      firstTarget.ino !== namedTarget.ino ||
      !namedTarget.isFile()
    )
      throw Error('Portable projection target identity changed');
    targetFile = captureRecordHeadPhysical([resolve(database)], []);
    inTarget = false;
    const targetCurrent = () => {
      current();
      if (
        !targetFile!.current() ||
        existsSync(database + '-wal') ||
        existsSync(database + '-shm') ||
        existsSync(database + '-journal')
      )
        throw Error('Portable projection target changed');
    };
    targetCurrent();
    phase('integrity');
    targetCurrent();
    originalRoster.current(originals.count());
    const verify = new DatabaseSync(database, { readOnly: true });
    try {
      validatePortableStagedIntakeDatabase(verify, profileId, targetCurrent);
    } finally {
      verify.close();
    }
    targetCurrent();
    result.logicalSha256 = logicalDatabaseHashIncremental(database, targetCurrent);
    if (result.logicalSha256 !== expectedHash)
      throw Error('Portable projection target differs from sealed transfer');
    assertProjectionSchema(database, expectedSchema, targetCurrent);
    targetCurrent();
    result.databaseBytes = statSync(database).size;
    const acceptedDigest = createHash('sha256');
    acceptedDigest.update('[');
    let firstOriginal = true;
    let originalBytes = 0;
    for (const file of originals.originals()) {
      if (!firstOriginal) acceptedDigest.update(',');
      firstOriginal = false;
      acceptedDigest.update(JSON.stringify([file.path, file.sha256, file.bytes]));
      originalBytes += file.bytes;
    }
    acceptedDigest.update(']');
    targetCurrent();
    originalRoster.current(originals.count());
    await verifyPortableOriginalInventory(root, profileId, originals, current);
    originalRoster.current(originals.count());
    current();
    selectedGenerationPath(paths.personal, profileId, 'personal', pinned.personal);
    selectedGenerationPath(paths.curation, profileId, 'curation', pinned.curation);
    current();
    targetCurrent();
    const heldRoster = originalRoster;
    const heldSelected = selectedFiles;
    const heldTarget = targetFile;
    const originalCount = originals.count();
    let closed = false;
    const proof = {
      current() {
        if (closed) throw Error('Portable projection terminal proof closed');
        heldRoster.terminalCurrent(originalCount);
        if (
          !heldSelected.current() ||
          !heldTarget.current() ||
          existsSync(database + '-wal') ||
          existsSync(database + '-shm') ||
          existsSync(database + '-journal')
        )
          throw Error('Portable projection terminal source or target changed');
      },
      close() {
        if (closed) return;
        closed = true;
        heldRoster.close();
        heldTarget.close();
        heldSelected.close();
      },
    };
    proof.current();
    terminalProof = proof;
    return {
      ...result,
      acceptedSourcesSha256: acceptedDigest.digest('hex'),
      originalBytes,
      inputRecords: [...expected.values()].reduce((sum, count) => sum + count, 0),
      sourceRecords: expected.get('source_records') ?? 0,
      terminalProof,
    };
  } finally {
    db?.close();
    transfer?.close();
    stagedTargetFile?.close();
    referenceFile?.close();
    if (!terminalProof) targetFile?.close();
    if (initialTargetFd !== undefined) closeSync(initialTargetFd);
    if (targetFd !== undefined) closeSync(targetFd);
    rawRmSync(reference, { force: true });
    for (const suffix of ['-wal', '-shm', '-journal'])
      rawRmSync(reference + suffix, { force: true });
    if (!terminalProof) originalRoster?.close();
    sourceIndex?.close();
    originals?.close();
    if (!terminalProof) selectedFiles.close();
  }
}
export function logicalDatabaseHash(db: Database): string {
  const digest = createHash('sha256'),
    scratch = disposableSqlite('circus-logical-hash-');
  try {
    scratch.db.exec('CREATE TABLE rows (sort BLOB, value TEXT)');
    const insert = scratch.db.prepare('INSERT INTO rows VALUES(?,?)');
    for (const table of tableNames(db)) {
      digest.update(table + '\n');
      // One private scratch transaction per table, not one per row.
      scratch.db.exec('BEGIN; DELETE FROM rows');
      for (const row of db.prepare(`SELECT * FROM ${quote(table)}`).iterate()) {
        const text = JSON.stringify(row);
        // JavaScript sort compares UTF-16 code units; preserve that exact old
        // logical digest ordering, including astral/BMP differences.
        const sort = Buffer.from(text, 'utf16le');
        sort.swap16();
        insert.run(sort, text);
      }
      for (const row of scratch.db.prepare('SELECT value FROM rows ORDER BY sort').iterate())
        digest.update(String(row.value) + '\n');
      scratch.db.exec('COMMIT');
    }
    return digest.digest('hex');
  } finally {
    scratch.close();
  }
}
