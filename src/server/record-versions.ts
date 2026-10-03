import { resolveClinicalReference } from './clinical-references.ts';
// Logical record journal. All storage callbacks operate on plaintext bytes in
// memory; the profile vault must authenticate/encrypt durable objects and own
// the single-writer lock. This module never writes a plaintext journal to disk.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import {
  openDatabase,
  databaseSchemaVersion,
  revision,
  registerTransactionDurability,
  HttpError,
  type Database,
  type SqliteRow,
  type TransactionOperation,
} from './database.ts';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

export interface RecordStorage {
  read(name: string): Buffer | null | undefined;
  writeImmutable(name: string, bytes: Uint8Array): void;
  publishHead(bytes: Uint8Array): void;
}

export interface RecordObjectReference {
  name: string;
  sha256: string;
  bytes: number;
}

export interface DurableRecordVersion {
  format: 'health-record-versions-v1';
  profileId: string;
  schemaVersion: number;
  sequence: number;
  recordedAt: string;
  operationId: string;
  versionId: string;
  actor: unknown;
  origin: unknown;
  references: unknown;
  entity: string;
  recordId: string;
  contents: Record<string, unknown>;
  deleted: boolean;
  previousVersion: string | null;
}

export interface RecordCommit {
  format: 'health-record-versions-v1';
  profileId: string;
  schemaVersion: number;
  sequence: number;
  revision: number;
  previous: RecordObjectReference | null;
  operationId: string;
  fingerprint: unknown;
  result: unknown;
  recordedAt: string;
  segments: RecordObjectReference[];
  records: number;
}

interface TableSchema {
  name: string;
  columns: string[];
  pk: string[];
}

interface RecordConfig {
  profileId: string;
  storage: RecordStorage;
  verifyReferences?: (versions: DurableRecordVersion[]) => void;
  segmentBytes: number;
  schemaVersion: number;
  schema: TableSchema[];
}

interface IndexedTransaction {
  ref: RecordObjectReference;
  commit: RecordCommit;
  versions: Iterable<DurableRecordVersion>;
}

interface PendingRecordVersion {
  entity: string;
  recordId: string;
  contents: Record<string, unknown>;
  deleted: boolean;
  previousVersion: string | null;
}

interface CurrentVersionRow extends SqliteRow {
  version_id: string;
  deleted: number;
  contents_json: string;
}

interface RecordStateRow extends SqliteRow {
  profile_id: string;
  projection: number;
  schema_version: number;
  sequence: number;
  head_json: string;
}

export interface RecordDurabilityStatus {
  configured: true;
  format: 'health-record-versions-v1';
  dirty: boolean;
  conflicted: boolean;
  lastError: string | null;
  revision: number;
  persistedRevision: number;
  sequence: number;
}

export interface AttachRecordDurabilityOptions {
  profileId?: string;
  storage?: RecordStorage;
  verifyReferences?: (versions: DurableRecordVersion[]) => void;
  segmentBytes?: number;
}

export interface QueryRecordHistoryOptions {
  profileId?: string;
  entity?: string;
  recordId?: unknown;
  field?: string;
  beforeSequence?: number;
  limit?: number;
}

export type RecordFieldState = { present: false } | { present: true; value: unknown };
export interface RecordFieldChange {
  field: string;
  before: RecordFieldState;
  after: RecordFieldState;
}
export type RecordHistoryEntry = DurableRecordVersion & { changes: RecordFieldChange[] };
export interface RecordHistoryResult {
  entries: RecordHistoryEntry[];
  nextSequence: number | null;
}

const FORMAT = 'health-record-versions-v1';
const PROJECTION = 2;
const LIMIT = 256 * 1024;
const q = (s: string): string => '"' + s.replaceAll('"', '""') + '"';
const literal = (s: string): string => "'" + s.replaceAll("'", "''") + "'";
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + '\n');
const state = new WeakMap<Database, RecordConfig>();
const fail = (message: string): never => {
  throw new Error('Record journal: ' + message);
};
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const internalKey = (key: string): boolean =>
  (key.startsWith('personal_') && !/^personal_(restore|assistant)_/.test(key)) ||
  key === 'curation_revision';
const meta = (db: Database, key: string): SQLOutputValue | undefined =>
  db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
function tables(db: Database): TableSchema[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name",
      )
      .all() as Array<SqliteRow & { name: string }>
  ).map(({ name }) => {
    const columns = db.prepare(`PRAGMA table_info(${q(name)})`).all() as Array<
      SqliteRow & { name: string; pk: number }
    >;
    const pk = columns
      .filter((c) => c.pk)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    if (!pk.length) fail('table has no stable identity');
    return { name, columns: columns.map((c) => c.name), pk };
  });
}
function setup(db: Database): void {
  const saved = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__record_state'")
    .get();
  if (saved) {
    const row = db.prepare('SELECT projection FROM __record_state WHERE singleton=1').get();
    if (row && row.projection !== PROJECTION)
      fail('unsupported or incomplete history projection; rebuild cache');
    for (const [table, columns] of [
      [
        '__record_versions',
        'version_id,profile_id,entity,record_id,sequence,recorded_at,previous_version,operation_id,deleted,contents_json,metadata_json',
      ],
      [
        '__record_fields',
        'version_id,profile_id,entity,record_id,field,sequence,before_version,before_present,after_present',
      ],
    ]) {
      if (
        db
          .prepare(`PRAGMA table_info(${q(table)})`)
          .all()
          .map((column) => column.name)
          .join(',') !== columns
      )
        fail('invalid history projection schema; rebuild cache');
    }
    if (!row) {
      for (const table of [
        '__record_state',
        '__record_versions',
        '__record_fields',
        '__record_transactions',
        '__record_current',
      ]) {
        if (db.prepare(`SELECT count(*) AS count FROM ${q(table)}`).get()?.count !== 0)
          fail('incomplete populated history projection; rebuild cache');
      }
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS __record_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), profile_id TEXT NOT NULL, projection INTEGER NOT NULL, schema_version INTEGER NOT NULL, sequence INTEGER NOT NULL, head_json TEXT);
    CREATE TABLE IF NOT EXISTS __record_transactions (operation_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, fingerprint TEXT, result_json TEXT NOT NULL, commit_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS __record_versions (version_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, entity TEXT NOT NULL, record_id TEXT NOT NULL, sequence INTEGER NOT NULL, recorded_at TEXT NOT NULL, previous_version TEXT, operation_id TEXT NOT NULL, deleted INTEGER NOT NULL, contents_json TEXT NOT NULL, metadata_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS __record_history ON __record_versions(profile_id,entity,record_id,sequence DESC);
    CREATE INDEX IF NOT EXISTS __record_time ON __record_versions(profile_id,recorded_at,sequence);
    CREATE INDEX IF NOT EXISTS __record_link_owner ON __record_versions(profile_id,entity,json_extract(contents_json,'$.note_id'),sequence DESC);
    CREATE INDEX IF NOT EXISTS __record_attachment_owner ON __record_versions(profile_id,entity,json_extract(contents_json,'$.owner_type'),json_extract(contents_json,'$.owner_id'),sequence DESC);
    CREATE TABLE IF NOT EXISTS __record_current (entity TEXT NOT NULL, record_id TEXT NOT NULL, version_id TEXT NOT NULL, PRIMARY KEY(entity,record_id));
    CREATE TABLE IF NOT EXISTS __record_fields (version_id TEXT NOT NULL, profile_id TEXT NOT NULL, entity TEXT NOT NULL, record_id TEXT NOT NULL, field TEXT NOT NULL, sequence INTEGER NOT NULL, before_version TEXT, before_present INTEGER NOT NULL, after_present INTEGER NOT NULL, PRIMARY KEY(version_id,field));
    CREATE INDEX IF NOT EXISTS __record_field_history ON __record_fields(profile_id,entity,record_id,field,sequence DESC);
    CREATE TEMP TABLE IF NOT EXISTS __record_changed (entity TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(entity,record_id));
  `);
}
function captureTriggers(db: Database, schema: TableSchema[]): void {
  for (const table of schema) {
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      const refs = op === 'UPDATE' ? ['OLD', 'NEW'] : [op === 'DELETE' ? 'OLD' : 'NEW'];
      // An outer UPSERT can override a trigger's OR IGNORE policy. Avoid the
      // conflict entirely so old/new identities and repeated updates coalesce.
      const statements = refs
        .map((ref) => {
          const id = `json_array(${table.pk.map((key) => `${ref}.${q(key)}`).join(',')})`;
          return `INSERT INTO __record_changed SELECT ${literal(table.name)},${id} WHERE NOT EXISTS(SELECT 1 FROM __record_changed WHERE entity=${literal(table.name)} AND record_id=${id});`;
        })
        .join('');
      db.exec(
        `CREATE TEMP TRIGGER IF NOT EXISTS ${q('__record_capture_' + table.name + '_' + op)} AFTER ${op} ON main.${q(table.name)} BEGIN ${statements} END`,
      );
    }
  }
}
function validStorage(storage: unknown): asserts storage is RecordStorage {
  for (const method of ['read', 'writeImmutable', 'publishHead'])
    if (
      typeof (storage as Partial<RecordStorage> | null)?.[method as keyof RecordStorage] !==
      'function'
    )
      fail('storage requires ' + method);
}
function refValid(ref: unknown): ref is RecordObjectReference {
  return (ref &&
    /^objects\/[0-9a-f-]{36}$/.test((ref as Partial<RecordObjectReference>).name as string) &&
    /^[0-9a-f]{64}$/.test((ref as Partial<RecordObjectReference>).sha256 as string) &&
    Number.isSafeInteger((ref as Partial<RecordObjectReference>).bytes) &&
    ((ref as Partial<RecordObjectReference>).bytes as number) > 0) as boolean;
}
function readObject(storage: RecordStorage, ref: unknown): Buffer {
  if (!refValid(ref)) fail('invalid object reference');
  const bytes = storage.read((ref as RecordObjectReference).name);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== (ref as RecordObjectReference).bytes ||
    digest(bytes) !== (ref as RecordObjectReference).sha256
  )
    fail('missing, partial or corrupt committed object');
  return bytes as Buffer;
}
function readHead(storage: RecordStorage): RecordObjectReference | null {
  const bytes = storage.read('head');
  if (bytes === null || bytes === undefined) return null;
  const ref = JSON.parse(bytes as unknown as string) as unknown;
  if (!refValid(ref)) fail('invalid head');
  return ref as RecordObjectReference;
}
function writeObject(storage: RecordStorage, bytes: Buffer): RecordObjectReference {
  const ref = { name: 'objects/' + randomUUID(), sha256: digest(bytes), bytes: bytes.length };
  storage.writeImmutable(ref.name, bytes);
  readObject(storage, ref); // Verify staged bytes before publishing acceptance.
  return ref;
}

function readCommit(
  storage: RecordStorage,
  ref: RecordObjectReference,
  profileId: string,
  schemaVersion: number,
): RecordCommit {
  const commit = JSON.parse(readObject(storage, ref) as unknown as string) as RecordCommit;
  if (
    commit.format !== FORMAT ||
    commit.profileId !== profileId ||
    commit.schemaVersion !== schemaVersion ||
    !Number.isSafeInteger(commit.sequence) ||
    commit.sequence < 1 ||
    !Array.isArray(commit.segments) ||
    !Number.isSafeInteger(commit.records) ||
    commit.records < 0 ||
    !Number.isSafeInteger(commit.revision) ||
    commit.revision < 0 ||
    typeof commit.operationId !== 'string' ||
    !commit.operationId ||
    !Number.isFinite(Date.parse(commit.recordedAt))
  )
    fail('unsupported or wrong-profile commit');
  if (commit.previous !== null && !refValid(commit.previous)) fail('invalid commit ancestry');
  return commit;
}

/** Read the selected authoritative envelope even when the disposable cache is current. */
export function verifyRecordAuthorityHead(
  storage: RecordStorage,
  profileId: string,
  schemaVersion: number,
): void {
  const head = readHead(storage);
  if (!head) fail('no committed profile history');
  readCommit(storage, head as RecordObjectReference, profileId, schemaVersion);
}
function committedSince(
  storage: RecordStorage,
  profileId: string,
  schemaVersion: number,
  stop: RecordObjectReference | null = null,
): { head: RecordObjectReference | null; transactions: IndexedTransaction[] } {
  const head = readHead(storage),
    result: IndexedTransaction[] = [],
    seen = new Set<string>();
  let ref: RecordObjectReference | null = head;
  while (!eq(ref, stop)) {
    if (!ref || seen.has(ref.name)) fail('missing ancestry or cyclic commits');
    seen.add((ref as RecordObjectReference).name);
    const commit = readCommit(storage, ref as RecordObjectReference, profileId, schemaVersion);
    const versions = readSegmentVersions(storage, commit);
    result.push({ ref, commit, versions } as IndexedTransaction);
    ref = commit.previous;
  }
  return { head, transactions: result.reverse() };
}
/** Reiterable bounded reader: keep at most a segment plus one logical record in memory. */
function readSegmentVersions(
  storage: RecordStorage,
  commit: RecordCommit,
): Iterable<DurableRecordVersion> {
  return {
    *[Symbol.iterator]() {
      let pending: Buffer = Buffer.alloc(0),
        count = 0;
      for (const ref of commit.segments) {
        const bytes = readObject(storage, ref);
        let offset = 0;
        for (let end = bytes.indexOf(10, offset); end !== -1; end = bytes.indexOf(10, offset)) {
          const line = pending.length
            ? Buffer.concat([pending, bytes.subarray(offset, end)])
            : bytes.subarray(offset, end);
          const text = line.toString('utf8');
          if (!Buffer.from(text).equals(line)) fail('invalid UTF-8');
          yield JSON.parse(text) as DurableRecordVersion;
          count++;
          pending = Buffer.alloc(0);
          offset = end + 1;
        }
        if (offset < bytes.length)
          pending = pending.length
            ? Buffer.concat([pending, bytes.subarray(offset)])
            : bytes.subarray(offset);
      }
      if (pending.length) fail('partial final JSONL record');
      if (count !== commit.records) fail('partial transaction');
    },
  };
}
function values(contents: unknown): Map<string, string | undefined> {
  const found = new Map<string, string | undefined>();
  const visit = (path: string, value: unknown): void => {
    found.set(path, JSON.stringify(value));
    if (value && typeof value === 'object' && !Array.isArray(value))
      for (const key of Object.keys(value))
        visit(path + '.' + key, (value as Record<string, unknown>)[key]);
  };
  if (contents)
    for (const [key, value] of Object.entries(contents)) {
      visit(key, value);
      if (key.endsWith('_json') && typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            for (const child of Object.keys(parsed))
              visit(key + '.' + child, (parsed as Record<string, unknown>)[child]);
        } catch {
          /* literal text is retained */
        }
      }
    }
  return found;
}
function current(db: Database, entity: string, id: string): CurrentVersionRow | undefined {
  return db
    .prepare(
      'SELECT v.* FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
    )
    .get(entity, id) as CurrentVersionRow | undefined;
}
function identity(table: TableSchema, row: Record<string, unknown>): string {
  return JSON.stringify(table.pk.map((key) => row[key]));
}
function validateVersion(
  db: Database,
  config: RecordConfig,
  commit: RecordCommit,
  version: DurableRecordVersion,
  identities: Set<string>,
): CurrentVersionRow | undefined {
  const table = config.schema.find((table) => table.name === version.entity);
  if (
    !table ||
    version.format !== FORMAT ||
    version.profileId !== config.profileId ||
    version.schemaVersion !== config.schemaVersion ||
    version.sequence !== commit.sequence ||
    version.operationId !== commit.operationId ||
    version.recordedAt !== commit.recordedAt ||
    !/^[0-9a-f-]{36}$/.test(version.versionId) ||
    typeof version.deleted !== 'boolean' ||
    !version.contents ||
    Array.isArray(version.contents) ||
    !eq(Object.keys(version.contents).sort(), [...table.columns].sort()) ||
    identity(table, version.contents) !== version.recordId
  )
    fail('invalid complete record version');
  const key = JSON.stringify([version.entity, version.recordId]);
  if (identities.has(key)) fail('duplicate record in transaction');
  identities.add(key);
  const previous = current(db, version.entity, version.recordId);
  if (version.previousVersion !== (previous?.version_id ?? null))
    fail('invalid previous-version reference');
  if (version.deleted && (!previous || previous.deleted)) fail('deletion without current record');
  if (version.deleted && !eq(version.contents, JSON.parse(previous!.contents_json)))
    fail('tombstone changed the removed record');
  if (table!.name === 'app_meta' && internalKey(version.contents.key as string))
    fail('operational metadata is not a durable record');
  return previous;
}
function indexTransaction(
  db: Database,
  config: RecordConfig,
  { ref, commit, versions }: IndexedTransaction,
): void {
  const indexed = db.prepare('SELECT * FROM __record_state WHERE singleton=1').get() as
    RecordStateRow | undefined;
  if (
    commit.sequence !== (indexed?.sequence ?? 0) + 1 ||
    !eq(commit.previous, indexed ? JSON.parse(indexed.head_json) : null)
  )
    fail('commit sequence gap or cache ancestry mismatch');
  if (indexed) {
    const previous = db
      .prepare('SELECT commit_json FROM __record_transactions WHERE sequence=?')
      .get(indexed.sequence) as (SqliteRow & { commit_json: string }) | undefined;
    if (!previous || commit.revision !== JSON.parse(previous.commit_json).revision + 1)
      fail('profile revision gap');
  }
  if (indexed && commit.revision !== revision(db))
    fail('projection revision differs from committed transaction');
  const identities = new Set<string>();
  for (const version of versions) {
    const previous = validateVersion(db, config, commit, version, identities);
    const before = values(
        previous && !previous.deleted ? JSON.parse(previous.contents_json) : null,
      ),
      after = values(version.deleted ? null : version.contents);
    const { contents, ...metadata } = version;
    db.prepare('INSERT INTO __record_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      version.versionId,
      config.profileId,
      version.entity,
      version.recordId,
      version.sequence,
      version.recordedAt,
      version.previousVersion,
      version.operationId,
      Number(version.deleted),
      JSON.stringify(contents),
      JSON.stringify(metadata),
    );
    db.prepare(
      'INSERT INTO __record_current VALUES(?,?,?) ON CONFLICT(entity,record_id) DO UPDATE SET version_id=excluded.version_id',
    ).run(version.entity, version.recordId, version.versionId);
    for (const field of new Set([...before.keys(), ...after.keys()]))
      if (before.get(field) !== after.get(field))
        db.prepare('INSERT INTO __record_fields VALUES(?,?,?,?,?,?,?,?,?)').run(
          version.versionId,
          config.profileId,
          version.entity,
          version.recordId,
          field,
          version.sequence,
          previous?.version_id ?? null,
          Number(before.has(field)),
          Number(after.has(field)),
        );
  }
  db.prepare('INSERT INTO __record_transactions VALUES(?,?,?,?,?)').run(
    commit.operationId,
    commit.sequence,
    commit.fingerprint as SQLInputValue,
    JSON.stringify(commit.result),
    JSON.stringify(commit),
  );
  db.prepare('INSERT OR REPLACE INTO __record_state VALUES(1,?,?,?,?,?)').run(
    config.profileId,
    PROJECTION,
    config.schemaVersion,
    commit.sequence,
    JSON.stringify(ref),
  );
}
function* collect(
  db: Database,
  config: RecordConfig,
  baseline = false,
): Generator<PendingRecordVersion> {
  const keys = baseline
    ? (function* () {
        for (const table of config.schema)
          for (const row of db
            .prepare(`SELECT * FROM ${q(table.name)} ORDER BY ${table.pk.map(q).join(',')}`)
            .iterate())
            yield {
              entity: table.name,
              record_id: identity(table, row as Record<string, unknown>),
            };
      })()
    : (db.prepare('SELECT * FROM __record_changed ORDER BY entity,record_id').iterate() as Iterable<
        SqliteRow & { entity: string; record_id: string }
      >);
  for (const { entity, record_id: recordId } of keys) {
    const table = config.schema.find((table) => table.name === entity),
      id = JSON.parse(recordId) as SQLInputValue[];
    if (entity === 'app_meta' && internalKey(id[0] as string)) continue;
    const contents = db
      .prepare(
        `SELECT * FROM ${q(entity)} WHERE ${table!.pk.map((key) => q(key) + '=?').join(' AND ')}`,
      )
      .get(...id);
    const previous = current(db, entity, recordId);
    if (!contents && (!previous || previous.deleted)) continue;
    yield {
      entity,
      recordId,
      contents:
        (contents as Record<string, unknown> | undefined) ??
        (JSON.parse(previous!.contents_json) as Record<string, unknown>),
      deleted: !contents,
      previousVersion: previous?.version_id ?? null,
    };
  }
}
function hasChanges(db: Database, config: RecordConfig) {
  const changes = collect(db, config);
  try {
    return !changes.next().done;
  } finally {
    changes.return(undefined);
  }
}
function publish(
  db: Database,
  config: RecordConfig,
  records: Iterable<PendingRecordVersion>,
  operation: TransactionOperation = {},
  result: unknown = null,
) {
  if (
    meta(db, 'owner_profile_id') !== config.profileId ||
    databaseSchemaVersion(db) !== config.schemaVersion
  )
    fail('database ownership or schema changed');
  const indexed = db.prepare('SELECT * FROM __record_state WHERE singleton=1').get() as
    RecordStateRow | undefined;
  const previous = indexed ? JSON.parse(indexed.head_json) : null;
  if (!eq(readHead(config.storage), previous))
    fail('durable head changed; reopen or rebuild before saving');
  const sequence = (indexed?.sequence ?? 0) + 1,
    recordedAt = new Date().toISOString();
  const operationId = (operation.operationId ?? randomUUID()) as string;
  let count = 0;
  const segments: RecordObjectReference[] = [];
  let chunks: Buffer[] = [],
    size = 0;
  const flush = (): void => {
    if (size) segments.push(writeObject(config.storage, Buffer.concat(chunks)));
    chunks = [];
    size = 0;
  };
  for (const record of records) {
    const version: DurableRecordVersion = {
      format: FORMAT,
      profileId: config.profileId,
      schemaVersion: config.schemaVersion,
      sequence,
      recordedAt,
      operationId,
      versionId: randomUUID(),
      actor: operation.actor ?? null,
      origin: operation.origin ?? null,
      references: operation.references ?? null,
      ...record,
    };
    config.verifyReferences?.([version]);
    count++;
    const bytes = encode(version);
    for (let offset = 0; offset < bytes.length;) {
      const take = Math.min(config.segmentBytes - size, bytes.length - offset);
      chunks.push(bytes.subarray(offset, offset + take));
      size += take;
      offset += take;
      if (size === config.segmentBytes) flush();
    }
  }
  flush();
  const commit: RecordCommit = {
    format: FORMAT,
    profileId: config.profileId,
    schemaVersion: config.schemaVersion,
    sequence,
    revision: revision(db),
    previous,
    operationId,
    fingerprint: operation.fingerprint ?? null,
    result: result ?? null,
    recordedAt,
    segments,
    records: count,
  };
  const ref = writeObject(config.storage, encode(commit));
  // All validation/indexing happens before the one acceptance boundary. The
  // SQLite transaction can roll back; the published commit remains recoverable.
  indexTransaction(db, config, {
    ref,
    commit,
    versions: readSegmentVersions(config.storage, commit),
  });
  config.storage.publishHead(encode(ref));
  if (!eq(readHead(config.storage), ref)) fail('head publication failed verification');
  return { sequence, operationId, records: count };
}
function applyVersions(
  db: Database,
  config: RecordConfig,
  versions: Iterable<DurableRecordVersion>,
): void {
  // Values are complete records, never patches or rerun application operations.
  // Delete changed rows first to allow accepted changes to unique associations.
  for (const version of versions) {
    const table = config.schema.find((table) => table.name === version.entity);
    if (!table || !Array.isArray(JSON.parse(version.recordId))) fail('unknown record identity');
    db.prepare(
      `DELETE FROM ${q(table!.name)} WHERE ${table!.pk.map((key) => q(key) + '=?').join(' AND ')}`,
    ).run(...(JSON.parse(version.recordId) as SQLInputValue[]));
  }
  for (const version of versions)
    if (!version.deleted) {
      const table = config.schema.find((table) => table.name === version.entity)!;
      db.prepare(
        `INSERT INTO ${q(table.name)} (${table.columns.map(q).join(',')}) VALUES(${table.columns.map(() => '?').join(',')})`,
      ).run(...table.columns.map((key) => version.contents[key] as SQLInputValue));
    }
}
function verifyTargets(db: Database): void {
  const targetTables = {
    note: 'notes',
    person: 'people',
    observation: 'observations',
    test_type: 'test_types',
    medication: 'medications',
    procedure: 'procedures',
    document: 'documents',
    report: 'reports',
    source_file: 'source_files',
  };
  const exists = (type: unknown, id: unknown): boolean =>
    type === 'source'
      ? Boolean(
          db
            .prepare(
              'SELECT 1 FROM source_files WHERE id=? UNION ALL SELECT 1 FROM source_records WHERE id=? LIMIT 1',
            )
            .get(id as SQLInputValue, id as SQLInputValue),
        )
      : Boolean(resolveClinicalReference(db, type, id as string)) ||
        Boolean(
          targetTables[type as keyof typeof targetTables] &&
          db
            .prepare(
              `SELECT 1 FROM ${q(targetTables[type as keyof typeof targetTables])} WHERE id=?`,
            )
            .get(id as SQLInputValue),
        );
  for (const [table, typeKey, idKey] of [
    ['note_links', 'target_type', 'target_id'],
    ['attachments', 'owner_type', 'owner_id'],
    ['evidence', 'entity_type', 'entity_id'],
    ['visibility_events', 'target_type', 'target_id'],
  ]) {
    for (const row of db.prepare(`SELECT * FROM ${q(table)}`).all())
      if (!exists(row[typeKey], row[idKey]))
        fail('rebuilt polymorphic relationship target is missing');
  }
  if (!db.prepare("SELECT 1 FROM people WHERE id='patient' AND is_patient=1").get())
    fail('rebuilt profile owner identity is missing');
}
function catchUp(
  db: Database,
  config: RecordConfig,
  { empty = false }: { empty?: boolean } = {},
): RecordObjectReference | null {
  const indexed = db.prepare('SELECT * FROM __record_state WHERE singleton=1').get() as
    RecordStateRow | undefined;
  if (
    indexed &&
    (indexed.profile_id !== config.profileId ||
      indexed.projection !== PROJECTION ||
      indexed.schema_version !== config.schemaVersion)
  )
    fail('unsupported or wrong-profile projection');
  if (indexed) {
    const latest = db
      .prepare(
        'SELECT sequence,commit_json FROM __record_transactions ORDER BY sequence DESC LIMIT 1',
      )
      .get() as (SqliteRow & { sequence: number; commit_json: string }) | undefined;
    if (
      !latest ||
      latest.sequence !== indexed.sequence ||
      JSON.parse(latest.commit_json).revision !== revision(db)
    )
      fail('cached projection sequence or revision is inconsistent');
  }
  const { head, transactions } = committedSince(
    config.storage,
    config.profileId,
    config.schemaVersion,
    indexed ? JSON.parse(indexed.head_json) : null,
  );
  if (!transactions.length) return head;
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")
    .all() as Array<SqliteRow & { name: string; sql: string }>;
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${q(trigger.name)}`);
    if (!indexed && empty)
      for (const table of config.schema) db.exec(`DELETE FROM ${q(table.name)}`);
    for (const tx of transactions) {
      const identities = new Set<string>();
      for (const version of tx.versions)
        validateVersion(db, config, tx.commit, version, identities);
      if (config.verifyReferences)
        for (const version of tx.versions) config.verifyReferences([version]);
      applyVersions(db, config, tx.versions);
      indexTransaction(db, config, tx);
      if (revision(db) !== tx.commit.revision) fail('committed revision record is missing');
    }
    for (const trigger of triggers) db.exec(trigger.sql);
    if (
      meta(db, 'owner_profile_id') !== config.profileId ||
      databaseSchemaVersion(db) !== config.schemaVersion ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      fail('rebuilt ownership, schema or foreign-key integrity failed');
    verifyTargets(db);
    if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok')
      fail('rebuilt SQLite integrity failed');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
  return head;
}

/** Attach while the profile is unlocked and exclusively owned by one writer.
 * storage.read('head'|objectName) returns decrypted Buffer or null if missing;
 * writeImmutable(name,Buffer) verifies/encrypts/fsyncs without replacement;
 * publishHead(Buffer) atomically authenticates/encrypts/fsyncs the commit head.
 * Fresh databases are seeded once; a cache reuses its indexed sequence and only
 * reads later commits. Missing/stale cache is deterministically reconstructed.
 */
export function attachRecordDurability(
  db: Database,
  {
    profileId,
    storage,
    verifyReferences,
    segmentBytes = LIMIT,
  }: AttachRecordDurabilityOptions = {},
): RecordDurabilityStatus {
  validStorage(storage);
  if (meta(db, 'owner_profile_id') !== profileId) fail('database belongs to another profile');
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 1024 || segmentBytes > 16 * 1024 * 1024)
    fail('invalid segment bound');
  setup(db);
  const config = {
    profileId,
    storage,
    verifyReferences,
    segmentBytes,
    schemaVersion: databaseSchemaVersion(db),
    schema: tables(db),
  } as RecordConfig;
  const indexed = db.prepare('SELECT * FROM __record_state WHERE singleton=1').get() as
    RecordStateRow | undefined;
  if (readHead(storage)) catchUp(db, config, { empty: !indexed });
  else {
    if (indexed) fail('durable history missing for existing cache');
    db.exec('BEGIN IMMEDIATE');
    try {
      publish(db, config, collect(db, config, true), { origin: 'profile-initialization' });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  state.set(db, config);
  captureTriggers(db, config.schema);
  const markPersisted = () =>
    db
      .prepare(
        "INSERT INTO app_meta(key,value) VALUES('curation_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(revision(db)));
  markPersisted();
  db.exec('DELETE FROM __record_changed');
  registerTransactionDurability(db, {
    begin(operation) {
      const indexed = db.prepare('SELECT * FROM __record_state WHERE singleton=1').get() as
        RecordStateRow | undefined;
      if (!eq(readHead(storage), JSON.parse(indexed!.head_json)))
        fail('cache is behind accepted history; reopen before writing');
      if (hasChanges(db, config))
        fail('uncommitted direct writes bypassed the transaction boundary');
      if (operation.operationId !== undefined) {
        if (
          typeof operation.operationId !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(operation.operationId) ||
          typeof operation.fingerprint !== 'string' ||
          !operation.fingerprint
        )
          throw new HttpError(
            400,
            'INVALID_OPERATION',
            'Stable operation ID requires a request fingerprint',
          );
        const prior = db
          .prepare('SELECT * FROM __record_transactions WHERE operation_id=?')
          .get(operation.operationId as SQLInputValue) as
          (SqliteRow & { fingerprint: string; result_json: string }) | undefined;
        if (prior) {
          if (prior.fingerprint !== operation.fingerprint)
            throw new HttpError(
              409,
              'OPERATION_CONFLICT',
              'Operation ID was already used for a different request',
            );
          return { replayed: true, result: JSON.parse(prior.result_json) };
        }
      }
      if (operation.expectedRevision !== undefined && operation.expectedRevision !== revision(db))
        throw new HttpError(
          409,
          'VERSION_CONFLICT',
          'Profile changed since this operation was prepared',
        );
    },
    capture() {
      db.exec('DELETE FROM __record_changed');
      return true;
    },
    markDirty: markPersisted,
    prepare(_captured, { operation, result }) {
      publish(db, config, collect(db, config), operation, result);
    },
    release(captured) {
      if (captured) db.exec('DELETE FROM __record_changed');
    },
  });
  return recordDurabilityStatus(db)!;
}
export function recordDurabilityStatus(db: Database): RecordDurabilityStatus | null {
  if (!state.has(db)) return null;
  const row = db.prepare('SELECT * FROM __record_state WHERE singleton=1').get() as RecordStateRow;
  const behind = !eq(readHead(state.get(db)!.storage), JSON.parse(row.head_json));
  return {
    configured: true,
    format: FORMAT,
    dirty: behind,
    conflicted: behind,
    lastError: behind ? 'Projection requires recovery from accepted record history' : null,
    revision: revision(db),
    persistedRevision: revision(db),
    sequence: row.sequence,
  };
}
export function flushRecordDurability(db: Database): RecordDurabilityStatus | null {
  const config = state.get(db);
  if (!config) fail('durability not attached');
  // App mutations must use transaction(). Refuse a snapshot-like backfill of
  // direct writes: it cannot supply the intended transaction or attribution.
  const row = db.prepare('SELECT * FROM __record_state WHERE singleton=1').get() as RecordStateRow;
  if (!eq(readHead(config!.storage), JSON.parse(row.head_json)))
    fail('projection requires recovery');
  if (hasChanges(db, config!)) fail('uncommitted direct writes bypassed the transaction boundary');
  return recordDurabilityStatus(db);
}
export function rebuildRecordDatabase(
  path: string,
  { profileId, storage, verifyReferences }: AttachRecordDurabilityOptions = {},
) {
  if (existsSync(path)) fail('rebuild target must be new');
  validStorage(storage);
  if (!readHead(storage)) fail('no committed profile history');
  const db = openDatabase(path, profileId);
  try {
    attachRecordDurability(db, { profileId, storage, verifyReferences });
    const result = recordDurabilityStatus(db)!;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { ...result, database: path, profileId };
  } catch (error) {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    throw error;
  } finally {
    try {
      db.close();
    } catch {}
  }
}
function indexedVersion(config: RecordConfig, row: SqliteRow): DurableRecordVersion {
  const metadata = JSON.parse(String(row.metadata_json)) as Omit<DurableRecordVersion, 'contents'>;
  const contents = JSON.parse(String(row.contents_json)) as Record<string, unknown>;
  const table = config.schema.find((table) => table.name === row.entity);
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join(',') !==
      'actor,deleted,entity,format,operationId,origin,previousVersion,profileId,recordId,recordedAt,references,schemaVersion,sequence,versionId' ||
    metadata.format !== FORMAT ||
    metadata.profileId !== config.profileId ||
    metadata.schemaVersion !== config.schemaVersion ||
    metadata.versionId !== row.version_id ||
    metadata.profileId !== row.profile_id ||
    metadata.entity !== row.entity ||
    metadata.recordId !== row.record_id ||
    metadata.sequence !== row.sequence ||
    metadata.operationId !== row.operation_id ||
    metadata.previousVersion !== row.previous_version ||
    metadata.recordedAt !== row.recorded_at ||
    typeof metadata.deleted !== 'boolean' ||
    Number(metadata.deleted) !== row.deleted ||
    !table ||
    !contents ||
    Array.isArray(contents) ||
    !eq(Object.keys(contents).sort(), [...table.columns].sort()) ||
    identity(table, contents) !== row.record_id
  )
    fail('invalid indexed version');
  return { ...metadata, contents };
}
/** Selected-version lookup for history consumers; never reads the immutable archive. */
export function readIndexedRecordVersion(
  db: Database,
  profileId: string,
  entity: string,
  recordId: string,
  versionId: string,
): DurableRecordVersion | undefined {
  const config = state.get(db);
  if (!config || config.profileId !== profileId || meta(db, 'owner_profile_id') !== profileId)
    fail('history requires the unlocked owning profile');
  const row = db
    .prepare(
      'SELECT * FROM __record_versions WHERE profile_id=? AND entity=? AND record_id=? AND version_id=? AND deleted=0',
    )
    .get(profileId, entity, recordId, versionId);
  return row ? indexedVersion(config!, row) : undefined;
}
/** Indexed history; recordId is the literal single PK or array for compound PK.
 * A field such as profile_json.birthDate queries nested JSON with absence and
 * null preserved. No storage reads or full-archive replay are performed here.
 */
export function queryRecordHistory(
  db: Database,
  {
    profileId,
    entity,
    recordId,
    field,
    beforeSequence = Number.MAX_SAFE_INTEGER,
    limit = 50,
  }: QueryRecordHistoryOptions = {},
): RecordHistoryResult {
  if (
    !state.has(db) ||
    state.get(db)!.profileId !== profileId ||
    meta(db, 'owner_profile_id') !== profileId
  )
    fail('history requires the unlocked owning profile');
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(beforeSequence) ||
    beforeSequence < 1
  )
    fail('invalid history pagination');
  const params: SQLInputValue[] = [
    profileId as string,
    entity as string,
    JSON.stringify(Array.isArray(recordId) ? recordId : [recordId]),
    beforeSequence,
  ];
  let sql =
    'SELECT v.version_id FROM __record_versions v WHERE v.profile_id=? AND v.entity=? AND v.record_id=? AND v.sequence<?';
  if (field !== undefined) {
    sql +=
      ' AND EXISTS(SELECT 1 FROM __record_fields f WHERE f.version_id=v.version_id AND f.field=?)';
    params.push(field);
  }
  sql += ' ORDER BY v.sequence DESC LIMIT ?';
  params.push(limit + 1);
  const rows = db.prepare(sql).all(...params),
    more = rows.length > limit;
  const config = state.get(db)!;
  const entries: RecordHistoryEntry[] = rows.slice(0, limit).map((selected) => {
    const row = db
      .prepare('SELECT * FROM __record_versions WHERE version_id=?')
      .get(selected.version_id);
    if (!row) fail('missing indexed version');
    const version = indexedVersion(config, row!);
    const priorRow = version.previousVersion
      ? db
          .prepare('SELECT * FROM __record_versions WHERE version_id=?')
          .get(version.previousVersion)
      : undefined;
    if (version.previousVersion && !priorRow) fail('missing indexed previous version');
    const prior = priorRow ? indexedVersion(config, priorRow) : undefined;
    if (
      prior &&
      (prior.entity !== version.entity ||
        prior.recordId !== version.recordId ||
        prior.sequence >= version.sequence)
    )
      fail('invalid indexed previous version');
    const before = values(prior && !prior.deleted ? prior.contents : null);
    const after = values(version.deleted ? null : version.contents);
    const changes: RecordFieldChange[] = db
      .prepare('SELECT * FROM __record_fields WHERE version_id=? ORDER BY field')
      .all(version.versionId)
      .map((change) => {
        const name = String(change.field);
        if (
          change.profile_id !== version.profileId ||
          change.entity !== version.entity ||
          change.record_id !== version.recordId ||
          change.sequence !== version.sequence ||
          change.before_version !== version.previousVersion ||
          change.before_present !== Number(before.has(name)) ||
          change.after_present !== Number(after.has(name)) ||
          before.get(name) === after.get(name)
        )
          fail('invalid indexed field reference');
        return {
          field: name,
          before: before.has(name)
            ? { present: true as const, value: JSON.parse(before.get(name)!) }
            : { present: false as const },
          after: after.has(name)
            ? { present: true as const, value: JSON.parse(after.get(name)!) }
            : { present: false as const },
        };
      });
    const expected = [...new Set([...before.keys(), ...after.keys()])]
      .filter((name) => before.get(name) !== after.get(name))
      .sort();
    if (!eq(changes.map((change) => change.field).sort(), expected))
      fail('missing indexed field reference');
    return { ...version, changes };
  });
  return { entries, nextSequence: more ? entries.at(-1)!.sequence : null };
}
