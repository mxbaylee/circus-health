import { PACKET_PREFERENCE_PREFIX, validatePacketPreferenceRows } from './packet-preferences.ts';
import { resolveClinicalReference } from './clinical-references.ts';
import { canonicalLiteral } from './intake-format.ts';
import { validatePortableIntakeState } from './intake-state-portable.ts';
import {
  attachContributorDurability,
  rebuildContributorDatabase,
  copyContributorAuthority,
  selectedContributorHead,
} from './contributor-durability.ts';
import { hasContributorAuthority } from './contributor-record-storage.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  copyFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  realpathSync,
  unlinkSync,
  statSync,
  lstatSync,
} from 'node:fs';
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
} from './database.ts';
import type { Session, SQLInputValue, StatementSync } from 'node:sqlite';
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
interface OriginalFile extends PortableRow {
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

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
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
  { maxRevision = Infinity, manifest }: { maxRevision?: number; manifest?: PortableManifest } = {},
) {
  const source = profilePaths(root, profileId).personal;
  const target = ensureProfileDirectories(targetRoot, profileId);
  const files: string[] = [];
  let current: PortableManifest | null = null;
  for (const generation of publishedPersonalLineage(root, profileId, { manifest })) {
    if (generation.value.revision > maxRevision) continue;
    current ??= generation.manifest;
    durableWrite(
      resolve(target.personal, generation.manifest.file),
      readFileSync(resolve(source, generation.manifest.file)),
    );
    files.push(`${target.relativeRoot}/personal/${generation.manifest.file}`);
  }
  if (current) {
    durableWrite(
      resolve(target.personal, 'current.json'),
      Buffer.from(JSON.stringify(current, null, 2) + '\n'),
    );
    files.push(`${target.relativeRoot}/personal/current.json`);
  }
  return { files, current };
}

// Curation predates explicit lineage. Preserve retained files as candidates;
// their presence alone never proves acceptance or makes them rebuild inputs.
export function copyRetainedCurationHistory(root: string, profileId: string, targetRoot: string) {
  const source = profilePaths(root, profileId),
    target = ensureProfileDirectories(targetRoot, profileId);
  const paths: string[] = [],
    entries: Array<{
      sourcePath: string;
      path: string;
      sha256: string;
      bytes: number;
      role: string;
      acceptance: string;
    }> = [],
    originalEntries = new Map<
      string,
      {
        path: string | null;
        sha256: unknown;
        bytes: unknown;
        candidates: string[];
        status: string;
      }
    >();
  if (!existsSync(source.curation)) return { paths, receipt: null };
  if (resolve(root) === resolve(targetRoot))
    throw new Error('Curation history must be copied to separate storage');
  const copyExact = (path: string, bytes: Buffer): void => {
    const destination = resolve(targetRoot, path);
    if (existsSync(destination)) {
      if (!readFileSync(destination).equals(bytes))
        throw new Error('Conflicting retained historical bytes: ' + path);
    } else durableWrite(destination, bytes);
    const actual = readFileSync(destination);
    if (!actual.equals(bytes)) throw new Error('Retained historical copy failed verification');
    paths.push(path);
  };
  const original = (file: PortableRow | null | undefined, candidate: string): void => {
    const path = file?.path ?? file?.stored_path;
    const key = JSON.stringify([path, file?.sha256, file?.bytes]);
    if (originalEntries.has(key)) {
      originalEntries.get(key)!.candidates.push(candidate);
      return;
    }
    const entry = {
      path: typeof path === 'string' ? path : null,
      sha256: file?.sha256 ?? null,
      bytes: file?.bytes ?? null,
      candidates: [candidate],
      status: 'unavailable',
    };
    originalEntries.set(key, entry);
    let bytes;
    try {
      if (
        typeof entry.sha256 !== 'string' ||
        !Number.isSafeInteger(entry.bytes) ||
        (entry.bytes as number) < 0
      )
        throw new Error('Invalid metadata');
      bytes = readFileSync(profileOriginal(root, path as string, profileId));
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
        throw new Error('Original checksum mismatch');
    } catch {
      return;
    } // Preserve candidate bytes even if its old original is unavailable.
    copyExact(path as string, bytes);
    entry.status = 'copied';
  };
  const walk = (directory: string): void => {
    if (lstatSync(directory).isSymbolicLink())
      throw new Error('Retained curation directories cannot be symbolic links');
    for (const name of readdirSync(directory).sort()) {
      const full = resolve(directory, name),
        info = lstatSync(full);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new Error('Retained curation history must contain regular files');
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      const bytes = readFileSync(full),
        digest = sha256(bytes),
        sourcePath = relative(source.curation, full);
      const retainedPath =
        sourcePath === 'current.json' ? `retained-pointers/${digest}.json` : sourcePath;
      const path = `${target.relativeRoot}/curation/${retainedPath}`;
      copyExact(path, bytes);
      entries.push({
        sourcePath,
        path,
        sha256: digest,
        bytes: bytes.length,
        role: sourcePath === 'current.json' ? 'retained-pointer' : 'retained-candidate',
        acceptance: 'not-inferred',
      });
      let value;
      try {
        value = JSON.parse(bytes as unknown as string) as PortableSnapshot;
      } catch {
        continue;
      }
      if (
        value?.format !== 'circus-health-profile-source-v1' ||
        value.profileId !== profileId ||
        value.kind !== 'curation'
      )
        continue;
      for (const table of ['source_files', 'assets'])
        for (const file of Array.isArray(value.tables?.[table]) ? value.tables[table] : [])
          original(file, path);
    }
  };
  walk(source.curation);
  const receiptPath = `${target.relativeRoot}/curation/history-receipts/${randomUUID()}.json`;
  const receipt = {
    format: 'circus-health-retained-curation-v1',
    profileId,
    copiedAt: new Date().toISOString(),
    semantics:
      'Byte-preserved historical candidates; acceptance is not inferred and no candidate is promoted to current',
    files: entries,
    originals: [...originalEntries.values()],
  };
  copyExact(receiptPath, Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
  return {
    paths: [...new Set(paths)],
    receipt: {
      path: receiptPath,
      files: entries.length,
      originals: receipt.originals.filter((file) => file.status === 'copied').length,
      unavailableOriginals: receipt.originals.filter((file) => file.status !== 'copied').length,
    },
  };
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
  const personal = checkedGeneration(paths.personal, profileId, 'personal', intent.personal);
  if (personal.value.revision > maxRevision)
    throw new Error('Durable recovery intent is newer than SQLite; rebuild before saving');
  const same = (a: PortableManifest | null, b: PortableManifest | null) =>
    (!a && !b) ||
    Boolean(a && b && a.file === b.file && a.sha256 === b.sha256 && a.revision === b.revision);
  const current = (kind: PortableKind): PortableManifest | null =>
    existsSync(resolve(paths[kind], 'current.json'))
      ? readGeneration(paths[kind], profileId, kind).manifest
      : null;
  if (
    personal.value.history?.format !== 'circus-health-personal-lineage-v1' ||
    ![intent.personal, personal.value.history.previous].some((expected) =>
      same(current('personal'), expected),
    )
  )
    throw new Error('Durable personal intent conflicts with published history');
  // Validate the entire lineage before making its head current.
  for (const generation of publishedPersonalLineage(root, profileId, { manifest: intent.personal }))
    void generation;
  if (intent.curation) {
    const curated = checkedGeneration(paths.curation, profileId, 'curation', intent.curation);
    if (
      curated.value.revision !== personal.value.revision ||
      ![intent.curation, intent.previousCuration].some((expected) =>
        same(current('curation'), expected),
      )
    )
      throw new Error('Durable curation intent conflicts with published history');
  }
  // Validate all referenced source and attachment bytes while still pending.
  if (validateOriginals)
    loadPortable(
      root,
      profileId,
      { personal: intent.personal, curation: intent.curation || current('curation') },
      { allowMissingCuration: !current('curation') && !intent.curation },
    );
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
export function copyProfileMappings(root: string, profileId: string, targetRoot: string): string[] {
  const base = profilePaths(root, profileId),
    directory = resolve(base.root, 'mappings');
  const copied: string[] = [];
  if (!existsSync(directory)) return copied;
  function walk(path: string): void {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('Profile mappings cannot be symbolic links');
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(resolve(path, name));
    } else if (info.isFile()) {
      const relativePath = `${base.relativeRoot}/mappings/${relative(directory, path)}`;
      const bytes = readFileSync(path),
        target = resolve(targetRoot, relativePath);
      durableWrite(target, bytes);
      if (!readFileSync(target).equals(bytes)) throw new Error('Mapping copy failed verification');
      copied.push(relativePath);
    } else throw new Error('Profile mappings must contain regular files');
  }
  walk(directory);
  return copied;
}

// Pure snapshot-to-files operation, also used by backup against its consistent
// SQLite snapshot. It does not mutate the source database or live profile files.
export function writePortableSources(
  db: Database,
  sourceRoot: string,
  profileId: string,
  outputRoot: string,
): string[] {
  checkOwner(db, profileId);
  const paths = ensureProfileDirectories(outputRoot, profileId);
  const personal = personalSnapshot(db, profileId);
  const sameRoot = resolve(sourceRoot) === resolve(outputRoot);
  const mappings = sameRoot ? [] : copyProfileMappings(sourceRoot, profileId, outputRoot);
  const retained = sameRoot
    ? { paths: [] }
    : copyRetainedCurationHistory(sourceRoot, profileId, outputRoot);
  const history = sameRoot
    ? {
        files: [],
        current: publishedPersonalLineage(sourceRoot, profileId).next().value?.manifest ?? null,
      }
    : copyPublishedPersonalHistory(sourceRoot, profileId, outputRoot, {
        maxRevision: personal.revision,
      });
  personal.history = { format: 'circus-health-personal-lineage-v1', previous: history.current };
  const curation = curationSnapshot(db, sourceRoot, profileId);
  const manifests: Array<[PortableKind, PortableManifest]> = [
    ['personal', writeGeneration(paths.personal, personal)],
    ['curation', writeGeneration(paths.curation, curation)],
  ];
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
  for (const row of db.prepare('SELECT id,target_type,target_id FROM note_links').all())
    if (!hasTarget(row.target_type, row.target_id))
      throw new Error('Rebuilt note-link target missing: ' + row.id);
  for (const row of db.prepare('SELECT id,owner_type,owner_id FROM attachments').all())
    if (!hasTarget(row.owner_type, row.owner_id))
      throw new Error('Rebuilt attachment owner missing: ' + row.id);
  for (const row of db.prepare('SELECT id,entity_type,entity_id FROM evidence').all())
    if (!hasTarget(row.entity_type, row.entity_id))
      throw new Error('Rebuilt evidence target missing: ' + row.id);
  const occurrenceDecisions = db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Duplicate evidence decision' AND json_type(coverage_json,'$.duplicateDecision.occurrenceAttachment')='object' ORDER BY json_extract(coverage_json,'$.duplicateDecision.sequence'),id",
    )
    .all();
  const latestOccurrences = new Map<string, Record<string, unknown>>();
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
    latestOccurrences.set(
      JSON.stringify([
        transition.incomingSourceRecordId,
        transition.targetKind,
        transition.targetRecordId,
      ]),
      transition,
    );
  }
  const activeIncoming = new Set<string>();
  const activeEvidence = new Set<string>();
  for (const transition of latestOccurrences.values()) {
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
    if (activeIncoming.has(String(transition.incomingSourceRecordId)))
      throw new Error('Rebuilt occurrence is attached to multiple clinical targets');
    activeIncoming.add(String(transition.incomingSourceRecordId));
    activeEvidence.add(String(transition.evidenceId));
  }
  for (const evidence of db
    .prepare("SELECT id FROM evidence WHERE role='same_event_occurrence'")
    .all())
    if (!activeEvidence.has(String(evidence.id)))
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
    for (const row of db.prepare('SELECT * FROM visibility_events').all()) {
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
}
export function exportCuration(db: Database, root: string, profileId: string) {
  checkOwner(db, profileId);
  if (recordDurabilityStatus(db)) {
    const personal = flushRecordDurability(db)!;
    putMeta(db, 'curation_revision', personal.persistedRevision);
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
  const portable = loadPortable(root, profileId) as CompleteLoadedPortable;
  const staged = targetRoot + '.rebuild-' + randomUUID();
  const paths = ensureProfileDirectories(staged, profileId);
  let db: Database | undefined;
  try {
    for (const file of portable.originals.values()) {
      const target = resolve(staged, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(profileOriginal(root, file.path, profileId), target);
      checkedBytes(staged, profileId, file);
    }
    // The loaded generation defines the rebuild. A concurrent later autosave
    // must not move its pointer ahead of the state inserted into this database.
    copyPublishedPersonalHistory(root, profileId, staged, { manifest: portable.personal.manifest });
    copyAssistantJournals(root, profileId, staged);
    copyIntakeBatchJournals(root, profileId, staged);
    copyProfileMappings(root, profileId, staged);
    const retainedCuration = copyRetainedCurationHistory(root, profileId, staged);
    for (const kind of ['curation'] as const) {
      const generation = portable[kind];
      const source = profilePaths(root, profileId)[kind],
        target = paths[kind];
      durableWrite(
        resolve(target, generation.manifest.file),
        readFileSync(resolve(source, generation.manifest.file)),
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
  }
}

function rebuildContributorProfile(root: string, profileId: string, targetRoot: string) {
  if (
    resolve(root) === resolve(targetRoot) ||
    (existsSync(targetRoot) && readdirSync(targetRoot).length)
  )
    throw Error('Rebuild target must be new or empty; live storage is never overwritten');
  const head = selectedContributorHead(root, profileId),
    staged = targetRoot + '.rebuild-' + randomUUID();
  const paths = ensureProfileDirectories(staged, profileId);
  let db: Database | undefined;
  try {
    function copyTree(source: string, target: string): void {
      if (!existsSync(source)) return;
      const stat = lstatSync(source);
      if (stat.isDirectory()) {
        mkdirSync(target, { recursive: true, mode: 0o700 });
        for (const name of readdirSync(source))
          copyTree(resolve(source, name), resolve(target, name));
        syncDirectory(target);
      } else if (stat.isFile()) durableWrite(target, readFileSync(source));
      else throw Error('Rebuild original tree contains nonregular files');
    }
    for (const kind of ['sources', 'attachments'] as const)
      copyTree(profilePaths(root, profileId)[kind], paths[kind]);
    copyContributorAuthority(root, profileId, staged);
    const rebuilt = rebuildContributorDatabase(paths.database, staged, profileId);
    db = openDatabase(paths.database, profileId);
    writePortableSources(db, root, profileId, staged);
    copyAssistantJournals(root, profileId, staged);
    copyIntakeBatchJournals(root, profileId, staged);
    const result = {
      ...rebuilt,
      path: targetRoot,
      database: profilePaths(targetRoot, profileId).database,
      schemaVersion: databaseSchemaVersion(db),
      files: Number(db.prepare('SELECT COUNT(*) n FROM source_files').get()!.n),
      counts: Object.fromEntries(
        tableNames(db).map((table) => [
          table,
          Number(db!.prepare(`SELECT COUNT(*) n FROM ${quote(table)}`).get()!.n),
        ]),
      ),
      logicalSha256: logicalDatabaseHash(db),
      databaseBytes: statSync(paths.database).size,
      curationHistory: null,
    };
    db.close();
    db = undefined;
    if (selectedContributorHead(root, profileId) !== head)
      throw Error('Contributor authority changed during rebuild');
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
  }
}

// Construct only the disposable SQLite projection; originals and retained
// history remain in the durable archive root. Callers stage and activate it.
export function projectPortableDatabase(
  database: string,
  profileId: string,
  portable: CompleteLoadedPortable,
  { phase = () => {} }: ProjectPortableOptions = {},
): ProjectPortableResult {
  validatePortableIntakeState(portable.rows, profileId);
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
      if (!Array.isArray(portable.rows[table]))
        throw new Error('Incomplete portable tables: ' + table);
    // This new, unserved staging database is checked in full before COMMIT.
    // Deferring constraints while inserting child tables ahead of parents can
    // repeatedly scan the growing corpus; one full check is deterministic.
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    try {
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name as string)}`);
      for (const index of indexes) db.exec(`DROP INDEX ${quote(index.name as string)}`);
      for (const table of known) db.exec(`DELETE FROM ${quote(table)}`);
      for (const [table, records] of Object.entries(portable.rows)) {
        if (!known.has(table) || !Array.isArray(records))
          throw new Error('Unknown portable table: ' + table);
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
          if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
          statements.get(sql)!.run(...keys.map((key) => record[key] as SQLInputValue));
        }
      }
      for (const migration of migrations) {
        const original = portable.rows.schema_migrations?.find(
          (row) => row.version === migration.version,
        );
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
      if (db.prepare('PRAGMA foreign_key_check').all().length)
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
      files: portable.originals.size,
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
export function logicalDatabaseHash(db: Database): string {
  const digest = createHash('sha256');
  for (const table of tableNames(db)) {
    digest.update(table + '\n');
    const rows = db
      .prepare(`SELECT * FROM ${quote(table)}`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort();
    for (const row of rows) digest.update(row + '\n');
  }
  return digest.digest('hex');
}
