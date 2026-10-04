import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  currentTransactionToken,
  observeTransactionOutcome,
  rejectCurrentTransaction,
} from './database.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import {
  intakeEnvelopeAuthorityBinding,
  readIntakeEnvelopeMaterialized,
  type IntakeEnvelopeSource,
} from './intake-authority.ts';
import { iterateIntakeEnvelopeText } from './intake-collection-envelope.ts';
import {
  createTextPiecePlan,
  reconstructTextPieces,
  TEXT_PIECE_LIMITS,
  TextPieceError,
  type TextPieceHead,
  type TextPieceLimits,
  type TextPieceMetrics,
  type TextPiecePlan,
  type TextPieceSnapshot,
} from './text-piece-edits.ts';
import {
  reconcileTextPieces,
  type TextPieceReconcileLimits,
  type TextPieceReconcileMetrics,
} from './text-piece-reconcile.ts';

const PREFIX = '__record_source_text_';
const DIRTY = '__source_text_dirty';
const INVALIDATED = '__source_text_invalidated';
const OBSOLETE = '__source_text_obsolete';
const WORK = '__source_text_reference_work';
const AUTHORITIES = '__source_text_authorities';
const schemas = {
  state:
    'singleton INTEGER PRIMARY KEY CHECK(singleton=1),format INTEGER NOT NULL,profile_id TEXT NOT NULL',
  heads:
    'source_id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,source_hash TEXT NOT NULL,details_digest TEXT NOT NULL,head_json TEXT NOT NULL,authority_key TEXT,authority_head TEXT',
  contents: 'id TEXT PRIMARY KEY,text TEXT NOT NULL',
  occurrences:
    'source_id TEXT NOT NULL,id TEXT NOT NULL,content_id TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,PRIMARY KEY(source_id,id)',
  links: 'source_id TEXT NOT NULL,id TEXT NOT NULL,next TEXT,PRIMARY KEY(source_id,id)',
} as const;
type Table = keyof typeof schemas;
type Row = Record<string, SQLInputValue>;
export interface SourceTextProjectionOptions {
  limits?: Partial<TextPieceLimits>;
  matchingLimits?: Partial<TextPieceReconcileLimits>;
}
export interface SourceTextProjectionCounters {
  builds: number;
  rebuiltSources: number;
  reconciledSources: number;
  authorityReads: number;
  authorityBytes: number;
  authorityHashBytes: number;
  snapshotLoads: number;
  snapshotReuses: number;
  projectionRowsRead: number;
  projectionReadBytes: number;
  projectionWrites: number;
  projectionBytes: number;
  contentRowsWritten: number;
  contentBytesWritten: number;
  occurrenceRowsWritten: number;
  occurrenceBytesWritten: number;
  linkRowsWritten: number;
  linkBytesWritten: number;
  headRowsWritten: number;
  headBytesWritten: number;
  rowsDeleted: number;
  deletedBytes: number;
  cleanupQueries: number;
  cleanupAffectedReferences: number;
  coldContentRowsScanned: number;
  triggerReferenceRowsRead: number;
  engine: Partial<TextPieceMetrics>;
  matching: Partial<TextPieceReconcileMetrics>;
}
interface Connection {
  schema: number;
  dataVersion: number;
  snapshots: Map<string, Retained>;
  active: boolean;
  dispose: () => void;
  counters: SourceTextProjectionCounters;
}
const connections = new WeakMap<DatabaseSync, Connection>();
// Preparation owners retain their original raw SQL witness. Search must not
// repair this shared disposable cache across their asynchronous gaps.
const readOnlyOwners = new WeakMap<DatabaseSync, Set<() => void>>();
export function holdReadOnlySourceTextProjection(db: DatabaseSync, assertCurrent: () => void) {
  assertCurrent();
  let owners = readOnlyOwners.get(db);
  if (!owners) readOnlyOwners.set(db, (owners = new Set()));
  const owner = () => assertCurrent();
  owners.add(owner);
  const owned = owners;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    owned.delete(owner);
    if (!owned.size) readOnlyOwners.delete(db);
  };
}
/** Selects a read path only; it grants no write permission or witness refresh. */
export function sourceTextProjectionReadOnly(db: DatabaseSync): boolean {
  const owners = readOnlyOwners.get(db);
  if (!owners?.size) return false;
  for (const assertCurrent of owners) assertCurrent();
  return true;
}
const table = (name: Table) => PREFIX + name;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
// Corrupt BLOB keys have no JSON text representation. Hex-encode them only for
// deletion accounting inside SQLite; never decode or accept them as source IDs.
const deletionKey = (column: string) =>
  `CASE WHEN typeof(${column})='blob' THEN hex(${column}) ELSE ${column} END`;
const deletionFields = (name: 'heads' | 'links' | 'occurrences') =>
  `'source_id',${deletionKey('source_id')}${name === 'heads' ? '' : `,'id',${deletionKey('id')}`}`;
const fail = (message: string): never => {
  throw Error(`Source text projection: ${message}`);
};
class CorruptCache extends Error {}
const corrupt = (message: string): never => {
  throw new CorruptCache(message);
};
function connectionFor(db: DatabaseSync): Connection {
  const existing = connections.get(db);
  if (existing) return existing;
  const connection: Connection = {
    schema: -1,
    dataVersion: -1,
    snapshots: new Map(),
    active: false,
    dispose: () => {},
    counters: {
      builds: 0,
      rebuiltSources: 0,
      reconciledSources: 0,
      authorityReads: 0,
      authorityBytes: 0,
      authorityHashBytes: 0,
      snapshotLoads: 0,
      snapshotReuses: 0,
      projectionRowsRead: 0,
      projectionReadBytes: 0,
      projectionWrites: 0,
      projectionBytes: 0,
      contentRowsWritten: 0,
      contentBytesWritten: 0,
      occurrenceRowsWritten: 0,
      occurrenceBytesWritten: 0,
      linkRowsWritten: 0,
      linkBytesWritten: 0,
      headRowsWritten: 0,
      headBytesWritten: 0,
      rowsDeleted: 0,
      deletedBytes: 0,
      cleanupQueries: 0,
      cleanupAffectedReferences: 0,
      coldContentRowsScanned: 0,
      triggerReferenceRowsRead: 0,
      engine: {},
      matching: {},
    },
  };
  connection.dispose = observeTransactionOutcome(db, ({ succeeded }) => {
    if (!succeeded) {
      connection.schema = -1;
      connection.snapshots.clear();
    }
  });
  connections.set(db, connection);
  return connection;
}
/** Logical SQL payload work includes rolled-back attempts. Pure-engine metrics
 * include completed calls only: a refused pure call supplies no metrics.
 * Trigger reference metrics count completed tracking intervals, including their
 * measurement scan. SQLite allocation and index navigation are separate. */
export function sourceTextProjectionCounters(db: DatabaseSync): SourceTextProjectionCounters {
  return connectionFor(db).counters;
}
/** Forget private readiness and retained exact snapshots on lock/close. */
export function clearSourceTextProjectionCache(db: DatabaseSync): void {
  connections.get(db)?.snapshots.clear();
  connections.get(db)?.dispose();
  connections.delete(db);
}
function addMetrics<T extends object>(target: Partial<T>, input: Readonly<T>): void {
  for (const key of Object.keys(input) as (keyof T)[])
    (target as Record<keyof T, number>)[key] = Number(target[key] ?? 0) + Number(input[key]);
}
function readRows(connection: Connection, rows: Row[]): Row[] {
  connection.counters.projectionRowsRead += rows.length;
  for (const row of rows) connection.counters.projectionReadBytes += bytes(row);
  return rows;
}
function write(connection: Connection, name: Table, row: unknown, deleted = false): void {
  const size = bytes(row);
  const c = connection.counters;
  c.projectionWrites++;
  c.projectionBytes += size;
  if (deleted) {
    c.rowsDeleted++;
    c.deletedBytes += size;
    return;
  }
  const prefix = (
    { contents: 'content', occurrences: 'occurrence', links: 'link', heads: 'head' } as const
  )[name as Exclude<Table, 'state'>];
  if (prefix) {
    c[`${prefix}RowsWritten`]++;
    c[`${prefix}BytesWritten`] += size;
  }
}
const mark = (id: string, target = DIRTY) =>
  `INSERT INTO ${target} SELECT ${id} WHERE NOT EXISTS(SELECT 1 FROM ${target} WHERE source_id=${id});`;
function sourceTracking(db: DatabaseSync): void {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${DIRTY}(source_id TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS ${INVALIDATED}(source_id TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS ${AUTHORITIES}(authority_key TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE);
    CREATE TEMP TABLE IF NOT EXISTS ${OBSOLETE}(id TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS ${WORK}(singleton INTEGER PRIMARY KEY,rows_read INTEGER NOT NULL);
    INSERT OR IGNORE INTO ${WORK} VALUES(1,0);
    CREATE TEMP TRIGGER IF NOT EXISTS __source_text_insert AFTER INSERT ON main.source_files BEGIN ${mark('NEW.id')} END;
    CREATE TEMP TRIGGER IF NOT EXISTS __source_text_update AFTER UPDATE ON main.source_files BEGIN ${mark('OLD.id')} ${mark('NEW.id')} END;
    CREATE TEMP TRIGGER IF NOT EXISTS __source_text_delete AFTER DELETE ON main.source_files BEGIN ${mark('OLD.id')} END;`);
}
function cacheTracking(db: DatabaseSync): void {
  for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
    const refs = op === 'INSERT' ? ['NEW'] : op === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS __source_text_authority_${op} AFTER ${op} ON main.app_meta BEGIN ${refs.map((ref) => `INSERT INTO ${DIRTY} SELECT source_id FROM ${AUTHORITIES} a WHERE authority_key=${ref}.key AND NOT EXISTS(SELECT 1 FROM ${DIRTY} d WHERE d.source_id=a.source_id);`).join(' ')} END`,
    );
  }
  for (const name of ['heads', 'occurrences', 'links'] as const)
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      const refs = op === 'INSERT' ? ['NEW'] : op === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
      const orphan =
        name === 'occurrences' && op !== 'INSERT'
          ? `INSERT INTO ${OBSOLETE} SELECT OLD.content_id WHERE NOT EXISTS(SELECT 1 FROM ${OBSOLETE} WHERE id=OLD.content_id);`
          : '';
      db.exec(
        `CREATE TEMP TRIGGER IF NOT EXISTS __source_text_${name}_${op} AFTER ${op} ON main.${table(name)} BEGIN ${refs.map((ref) => mark(ref + '.source_id') + mark(ref + '.source_id', INVALIDATED)).join(' ')} ${orphan} END`,
      );
    }
  for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
    const refs = op === 'INSERT' ? ['NEW'] : op === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS __source_text_contents_${op} AFTER ${op} ON main.${table('contents')} BEGIN ${refs.map((ref) => `UPDATE ${WORK} SET rows_read=rows_read+3*(SELECT COUNT(*) FROM ${table('occurrences')} WHERE content_id=${ref}.id) WHERE singleton=1; INSERT INTO ${DIRTY} SELECT DISTINCT source_id FROM ${table('occurrences')} o WHERE content_id=${ref}.id AND NOT EXISTS(SELECT 1 FROM ${DIRTY} d WHERE d.source_id=o.source_id); INSERT INTO ${INVALIDATED} SELECT DISTINCT source_id FROM ${table('occurrences')} o WHERE content_id=${ref}.id AND NOT EXISTS(SELECT 1 FROM ${INVALIDATED} d WHERE d.source_id=o.source_id); INSERT INTO ${OBSOLETE} SELECT ${ref}.id WHERE NOT EXISTS(SELECT 1 FROM ${OBSOLETE} WHERE id=${ref}.id);`).join(' ')} END`,
    );
  }
}
const schemaVersion = (db: DatabaseSync) =>
  Number(db.prepare('PRAGMA schema_version').get()!.schema_version);
function bindingMatches(db: DatabaseSync, profile: string): boolean {
  const rows = db
    .prepare(
      `SELECT singleton=1 AND format=1 AND typeof(profile_id)='text' AND profile_id=? valid FROM ${table('state')} LIMIT 2`,
    )
    .all(profile);
  return rows.length === 1 && rows[0]!.valid === 1;
}
function initialize(db: DatabaseSync, connection: Connection, profile: string): void {
  connection.snapshots.clear();
  const cold = connection.schema === -1;
  let valid = true;
  for (const [name, definition] of Object.entries(schemas)) {
    const actual = db.prepare(`PRAGMA table_info(${PREFIX + name})`).all();
    const columns = definition
      .split(',')
      .filter((part) => !part.startsWith('PRIMARY KEY') && !part.endsWith('id)'));
    valid &&=
      actual.length === columns.length &&
      actual.every((row, i) => {
        const [column, type] = columns[i]!.split(' ');
        const pk =
          name === 'occurrences' || name === 'links' ? (i < 2 ? i + 1 : 0) : i === 0 ? 1 : 0;
        return (
          row.name === column &&
          row.type === type &&
          row.pk === pk &&
          row.notnull === Number(columns[i]!.includes('NOT NULL'))
        );
      });
  }
  if (valid) valid = bindingMatches(db, profile);
  if (!valid) {
    for (const name of Object.keys(schemas) as Table[])
      db.exec(`DROP TABLE IF EXISTS ${table(name)}`);
    for (const [name, definition] of Object.entries(schemas))
      db.exec(`CREATE TABLE ${PREFIX + name}(${definition})`);
    db.prepare(`INSERT INTO ${table('state')} VALUES(1,1,?)`).run(profile);
    connection.counters.builds++;
  } else if (cold) connection.counters.builds++;
  const index = db.prepare(`PRAGMA index_info(${PREFIX}content_references)`).all();
  const listed = db
    .prepare(`PRAGMA index_list(${table('occurrences')})`)
    .all()
    .find((row) => row.name === PREFIX + 'content_references');
  if (
    listed?.partial !== 0 ||
    index.length !== 2 ||
    index[0]!.name !== 'content_id' ||
    index[1]!.name !== 'source_id'
  )
    db.exec(
      `DROP INDEX IF EXISTS ${PREFIX}content_references; CREATE INDEX ${PREFIX}content_references ON ${table('occurrences')}(content_id,source_id)`,
    );
  const authorityIndex = db.prepare(`PRAGMA index_info(${PREFIX}authority)`).all();
  if (authorityIndex.length !== 1 || authorityIndex[0]!.name !== 'authority_key')
    db.exec(
      `DROP INDEX IF EXISTS ${PREFIX}authority; CREATE INDEX ${PREFIX}authority ON ${table('heads')}(authority_key)`,
    );
  cacheTracking(db);
  db.exec(
    `DELETE FROM temp.${AUTHORITIES}; INSERT OR IGNORE INTO temp.${AUTHORITIES} SELECT authority_key,source_id FROM ${table('heads')} WHERE authority_key IS NOT NULL`,
  );
  if (!valid || cold) {
    db.exec(`INSERT OR IGNORE INTO temp.${DIRTY} SELECT id FROM source_files;
      INSERT OR IGNORE INTO temp.${DIRTY} SELECT source_id FROM ${table('heads')};
      INSERT OR IGNORE INTO temp.${DIRTY} SELECT DISTINCT source_id FROM ${table('occurrences')};
      INSERT OR IGNORE INTO temp.${DIRTY} SELECT DISTINCT source_id FROM ${table('links')};`);
    // A cold connection cannot observe content orphaned while tracking was absent.
    // This one explicit inventory scan is counted separately from affected cleanup.
    connection.counters.coldContentRowsScanned += Number(
      db.prepare(`SELECT COUNT(*) n FROM ${table('contents')}`).get()!.n,
    );
    db.exec(`INSERT OR IGNORE INTO temp.${OBSOLETE} SELECT id FROM ${table('contents')}`);
  }
  connection.schema = schemaVersion(db);
}
interface Retained {
  row: Row;
  snapshot: TextPieceSnapshot;
  text: string;
}
function retained(
  db: DatabaseSync,
  connection: Connection,
  id: string,
  profile: string,
  validateSelection = false,
): Retained | null {
  if (db.prepare(`DELETE FROM temp.${INVALIDATED} WHERE source_id=?`).run(id).changes)
    connection.snapshots.delete(id);
  const cached = connection.snapshots.get(id);
  if (cached) {
    if (cached.row.profile_id !== profile) return corrupt('head binding');
    if (
      validateSelection &&
      cached.row.authority_key !== null &&
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(cached.row.authority_key!)?.value !==
        cached.row.authority_head
    )
      return corrupt('selected intake head binding');
    connection.counters.snapshotReuses++;
    return cached;
  }
  connection.counters.snapshotLoads++;
  const row = readRows(
    connection,
    db
      .prepare(
        `SELECT source_id,CASE WHEN typeof(profile_id)='text' AND length(CAST(profile_id AS BLOB))<=1024 THEN profile_id END profile_id,CASE WHEN typeof(source_hash)='text' AND length(CAST(source_hash AS BLOB))<=1024 THEN source_hash END source_hash,CASE WHEN typeof(details_digest)='text' AND length(details_digest)=64 THEN details_digest END details_digest,CASE WHEN typeof(head_json)='text' AND length(CAST(head_json AS BLOB))<=? THEN head_json ELSE NULL END head_json,CASE WHEN authority_key IS NULL OR (typeof(authority_key)='text' AND length(authority_key)<=128) THEN authority_key ELSE '' END authority_key,CASE WHEN authority_head IS NULL OR (typeof(authority_head)='text' AND length(CAST(authority_head AS BLOB))<=4096) THEN authority_head ELSE '' END authority_head FROM ${table('heads')} WHERE source_id=?`,
      )
      .all(TEXT_PIECE_LIMITS.maxHeadBytes, id),
  )[0];
  if (!row) return null;
  if (
    row.profile_id !== profile ||
    typeof row.source_hash !== 'string' ||
    typeof row.head_json !== 'string'
  )
    corrupt('head binding');
  if (row.authority_key !== null) {
    if (
      typeof row.authority_key !== 'string' ||
      !row.authority_key ||
      typeof row.authority_head !== 'string' ||
      (validateSelection &&
        db.prepare('SELECT value FROM app_meta WHERE key=?').get(row.authority_key)?.value !==
          row.authority_head)
    )
      corrupt('selected intake head binding');
  } else if (row.authority_head !== null) corrupt('unexpected intake head binding');
  let head: TextPieceHead;
  try {
    head = JSON.parse(row.head_json as string) as TextPieceHead;
  } catch {
    return corrupt('head JSON');
  }
  if (!head || head.digest !== row.details_digest) corrupt('head digest binding');
  const occurrences = readRows(
    connection,
    db
      .prepare(
        `SELECT CASE WHEN typeof(id)='text' AND length(id)<=128 THEN id END id,CASE WHEN typeof(content_id)='text' AND length(content_id)=64 THEN content_id END content_id,CASE WHEN typeof(start)='integer' AND start BETWEEN 0 AND ${TEXT_PIECE_LIMITS.maxTextUtf16Units} THEN start END start,CASE WHEN typeof(end)='integer' AND end BETWEEN 0 AND ${TEXT_PIECE_LIMITS.maxTextUtf16Units} THEN end END end FROM ${table('occurrences')} WHERE source_id=? LIMIT ?`,
      )
      .all(id, TEXT_PIECE_LIMITS.maxPieces + 1),
  );
  const links = readRows(
    connection,
    db
      .prepare(
        `SELECT CASE WHEN typeof(id)='text' AND length(id)<=128 THEN id END id,CASE WHEN next IS NULL THEN NULL WHEN typeof(next)='text' AND length(next)<=128 THEN next ELSE '' END next FROM ${table('links')} WHERE source_id=? LIMIT ?`,
      )
      .all(id, TEXT_PIECE_LIMITS.maxPieces + 1),
  );
  if (
    occurrences.length > TEXT_PIECE_LIMITS.maxPieces ||
    links.length > TEXT_PIECE_LIMITS.maxPieces
  )
    corrupt('row inventory bound');
  const contents = readRows(
    connection,
    db
      .prepare(
        `SELECT CASE WHEN typeof(c.id)='text' AND length(c.id)=64 THEN c.id END id,CASE WHEN typeof(c.text)='text' AND length(CAST(c.text AS BLOB))<=? THEN c.text ELSE NULL END text FROM ${table('contents')} c WHERE c.id IN (SELECT content_id FROM ${table('occurrences')} WHERE source_id=?) LIMIT ?`,
      )
      .all(TEXT_PIECE_LIMITS.maxContentBytes, id, TEXT_PIECE_LIMITS.maxRetainedContentRows + 1),
  );
  const snapshot: TextPieceSnapshot = {
    head,
    contents: new Map(
      contents.map((r) => [String(r.id), { id: String(r.id), text: r.text as string }]),
    ),
    occurrences: new Map(
      occurrences.map((r) => [
        String(r.id),
        {
          id: String(r.id),
          contentId: String(r.content_id),
          start: r.start as number,
          end: r.end as number,
        },
      ]),
    ),
    links: new Map(
      links.map((r) => [String(r.id), { id: String(r.id), next: r.next as string | null }]),
    ),
  };
  try {
    const result = reconstructTextPieces(snapshot);
    addMetrics(connection.counters.engine, result.metrics);
    const selected = { row, snapshot, text: result.text };
    // The compatibility engine materializes one bounded v3 value. Never retain
    // one such value per source across a large source-list traversal.
    connection.snapshots.clear();
    connection.snapshots.set(id, selected);
    return selected;
  } catch (error) {
    // Only validation with the engine's DEFAULT limits is cache repair evidence.
    // Caller-lowered budgets and automatic matching run outside this catch.
    if (error instanceof TextPieceError) return corrupt(error.message);
    throw error;
  }
}
function authority(db: DatabaseSync, connection: Connection, id: string): Row | undefined {
  const source = db
    .prepare(
      "SELECT id,CASE WHEN typeof(sha256)='text' AND length(CAST(sha256 AS BLOB))<=1024 THEN sha256 END sha256,CASE WHEN typeof(kind)='text' AND length(CAST(kind AS BLOB))<=1024 THEN kind END kind,CASE WHEN typeof(details_json)='text' AND length(CAST(details_json AS BLOB))<=? THEN details_json ELSE NULL END details_json FROM source_files WHERE id=?",
    )
    .get(TEXT_PIECE_LIMITS.maxTextBytes, id);
  connection.counters.authorityReads++;
  if (!source) return undefined;
  if (
    typeof source.details_json !== 'string' ||
    typeof source.kind !== 'string' ||
    !source.kind ||
    typeof source.sha256 !== 'string' ||
    !source.sha256
  )
    fail('selected authority is unavailable or exceeds the text bound');
  const selected = source as unknown as IntakeEnvelopeSource;
  const binding = intakeEnvelopeAuthorityBinding(db, selected);
  source.authority_key = binding.key;
  source.authority_head = binding.head;
  // V4 text already belongs to the checked logical tree. Keeping a second rope
  // would copy that authority and hide a complete traversal in ordinary writes.
  if (binding.logicalHead !== undefined) {
    source.logical_head = binding.logicalHead;
    connection.counters.authorityBytes += Buffer.byteLength(source.details_json as string);
    return source;
  }
  if (source.kind === 'intake_original') {
    const materialized = readIntakeEnvelopeMaterialized(db, selected);
    source.details_json = materialized.text;
    source.selected_digest = materialized.fingerprint;
  }
  const raw = source.details_json as string;
  if (Buffer.byteLength(raw) > TEXT_PIECE_LIMITS.maxTextBytes)
    fail('selected authority exceeds the text bound');
  connection.counters.authorityBytes += Buffer.byteLength(raw);
  // Original authority already checked shape, supported workflow and exact compact agreement.
  if (source.kind === 'intake_original') return source;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('selected authority JSON is corrupt');
  }
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (object(value) && Object.hasOwn(value, 'intake')) {
    if (!object(value.intake)) fail('selected intake authority is incomplete');
    const workflow = (value.intake as Record<string, unknown>).workflow;
    if (workflow !== undefined && !object(workflow))
      fail('selected workflow authority is incomplete');
    if (
      object(workflow) &&
      workflow.format !== undefined &&
      workflow.format !== 'health-intake-workflow-v1'
    )
      fail('unsupported selected workflow authority');
  }
  return source;
}
function removeSource(
  db: DatabaseSync,
  connection: Connection,
  id: string,
  obsolete: Set<string>,
): void {
  connection.snapshots.delete(id);
  db.prepare(`DELETE FROM temp.${AUTHORITIES} WHERE source_id=?`).run(id);
  for (const row of db
    .prepare(
      `SELECT DISTINCT CASE WHEN typeof(content_id)='text' AND length(content_id)=64 THEN content_id END content_id FROM ${table('occurrences')} WHERE source_id=?`,
    )
    .iterate(id)) {
    readRows(connection, [row]);
    if (typeof row.content_id === 'string') obsolete.add(row.content_id);
    connection.counters.cleanupAffectedReferences++;
  }
  for (const name of ['links', 'occurrences', 'heads'] as const) {
    // Count encoded deletion keys inside SQLite, without hydrating potentially
    // malformed/unbounded identifiers from damaged disposable rows.
    const fields = deletionFields(name);
    const aggregate = db
      .prepare(
        `SELECT COUNT(*) n,COALESCE(SUM(length(CAST(json_object(${fields},'deleted',json('true')) AS BLOB))),0) bytes FROM ${table(name)} WHERE source_id=?`,
      )
      .get(id)!;
    connection.counters.projectionRowsRead += Number(aggregate.n);
    connection.counters.projectionReadBytes += Number(aggregate.bytes);
    db.prepare(`DELETE FROM ${table(name)} WHERE source_id=?`).run(id);
    connection.counters.projectionWrites += Number(aggregate.n);
    connection.counters.rowsDeleted += Number(aggregate.n);
    connection.counters.projectionBytes += Number(aggregate.bytes);
    connection.counters.deletedBytes += Number(aggregate.bytes);
  }
  db.prepare(`DELETE FROM temp.${INVALIDATED} WHERE source_id=?`).run(id);
}
function apply(
  db: DatabaseSync,
  connection: Connection,
  id: string,
  profile: string,
  source: Row,
  plan: TextPiecePlan,
  before: Retained | null,
  obsolete: Set<string>,
): void {
  for (const row of plan.contentWrites) {
    const old = readRows(
      connection,
      db
        .prepare(
          `SELECT id,CASE WHEN typeof(text)='text' AND length(CAST(text AS BLOB))<=? THEN text END text FROM ${table('contents')} WHERE id=?`,
        )
        .all(TEXT_PIECE_LIMITS.maxContentBytes, row.id),
    )[0];
    if (!old || old.text !== row.text) {
      db.prepare(
        `INSERT INTO ${table('contents')} VALUES(?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text`,
      ).run(row.id, row.text);
      write(connection, 'contents', row);
    }
  }
  const changing = new Set([...plan.occurrenceDeletes, ...plan.occurrenceWrites.map((r) => r.id)]);
  for (const key of changing) {
    const old = before?.snapshot.occurrences.get(key);
    if (old) {
      obsolete.add(old.contentId);
      connection.counters.cleanupAffectedReferences++;
    }
  }
  for (const [name, keys] of [
    ['links', plan.linkDeletes],
    ['occurrences', plan.occurrenceDeletes],
  ] as const)
    for (const key of keys) {
      db.prepare(`DELETE FROM ${table(name)} WHERE source_id=? AND id=?`).run(id, key);
      write(connection, name, { source_id: id, id: key, deleted: true }, true);
    }
  for (const row of plan.occurrenceWrites) {
    db.prepare(
      `INSERT INTO ${table('occurrences')} VALUES(?,?,?,?,?) ON CONFLICT(source_id,id) DO UPDATE SET content_id=excluded.content_id,start=excluded.start,end=excluded.end`,
    ).run(id, row.id, row.contentId, row.start, row.end);
    write(connection, 'occurrences', {
      source_id: id,
      id: row.id,
      content_id: row.contentId,
      start: row.start,
      end: row.end,
    });
  }
  for (const row of plan.linkWrites) {
    db.prepare(
      `INSERT INTO ${table('links')} VALUES(?,?,?) ON CONFLICT(source_id,id) DO UPDATE SET next=excluded.next`,
    ).run(id, row.id, row.next);
    write(connection, 'links', { source_id: id, ...row });
  }
  const head = {
    source_id: id,
    profile_id: profile,
    source_hash: source.sha256,
    details_digest: plan.head.digest,
    head_json: JSON.stringify(plan.head),
    authority_key: source.authority_key,
    authority_head: source.authority_head,
  };
  if (bytes(head) > TEXT_PIECE_LIMITS.maxRowBytes) fail('source head binding exceeds row bound');
  db.prepare(
    `INSERT INTO ${table('heads')} VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET profile_id=excluded.profile_id,source_hash=excluded.source_hash,details_digest=excluded.details_digest,head_json=excluded.head_json,authority_key=excluded.authority_key,authority_head=excluded.authority_head`,
  ).run(
    id,
    profile,
    source.sha256!,
    plan.head.digest,
    head.head_json,
    head.authority_key!,
    head.authority_head!,
  );
  write(connection, 'heads', head);
  db.prepare(`DELETE FROM temp.${AUTHORITIES} WHERE source_id=?`).run(id);
  if (head.authority_key !== null)
    db.prepare(`INSERT INTO temp.${AUTHORITIES} VALUES(?,?)`).run(head.authority_key!, id);
}
function reconcile(
  db: DatabaseSync,
  connection: Connection,
  id: string,
  profile: string,
  options: SourceTextProjectionOptions,
  obsolete: Set<string>,
): void {
  const source = authority(db, connection, id);
  connection.counters.reconciledSources++;
  if (!source) {
    removeSource(db, connection, id, obsolete);
    return;
  }
  if (typeof source.logical_head === 'string') {
    // Conversion removes a prior compatibility rope once. Subsequent logical or
    // auxiliary changes touch no content rows; query-time export is explicit.
    if (db.prepare(`SELECT 1 FROM ${table('heads')} WHERE source_id=?`).get(id))
      removeSource(db, connection, id, obsolete);
    db.prepare(`DELETE FROM temp.${AUTHORITIES} WHERE source_id=?`).run(id);
    db.prepare(`INSERT INTO temp.${AUTHORITIES} VALUES(?,?)`).run(source.authority_key!, id);
    return;
  }
  const raw = source.details_json as string;
  let digest = source.selected_digest;
  if (typeof digest !== 'string') {
    connection.counters.authorityHashBytes += Buffer.byteLength(raw);
    digest = createHash('sha256').update(raw).digest('hex');
  }
  let before: Retained | null;
  try {
    before = retained(db, connection, id, profile);
  } catch (error) {
    if (!(error instanceof CorruptCache)) throw error;
    before = null;
  }
  if (
    before &&
    before.row.source_hash === source.sha256 &&
    before.row.authority_key === source.authority_key &&
    before.row.authority_head === source.authority_head &&
    before.row.details_digest === digest &&
    before.text === raw
  )
    return;
  let plan: TextPiecePlan;
  if (!before) {
    // This branch is exclusively absent/invalid disposable evidence. Automatic
    // discovery and work-limit refusals below never enter it, including on retry.
    plan = createTextPiecePlan(raw, { sequenceId: randomUUID(), limits: options.limits });
    removeSource(db, connection, id, obsolete);
    connection.counters.rebuiltSources++;
  } else {
    const automatic = reconcileTextPieces(before.snapshot, raw, options);
    addMetrics(connection.counters.matching, automatic.matchingMetrics);
    plan = automatic;
  }
  addMetrics(connection.counters.engine, plan.metrics);
  apply(db, connection, id, profile, source, plan, before, obsolete);
}
function prune(db: DatabaseSync, connection: Connection, obsolete: Set<string>): void {
  for (const id of obsolete) {
    connection.counters.cleanupQueries++;
    const references = readRows(
      connection,
      db
        .prepare(`SELECT source_id FROM ${table('occurrences')} WHERE content_id=? LIMIT 1`)
        .all(id),
    );
    if (
      !references.length &&
      db.prepare(`DELETE FROM ${table('contents')} WHERE id=?`).run(id).changes
    )
      write(connection, 'contents', { id, deleted: true }, true);
  }
}
function removeMalformedIdentity(
  db: DatabaseSync,
  connection: Connection,
  dirtyRow: SQLInputValue,
): void {
  const selected = `(SELECT source_id FROM temp.${DIRTY} WHERE rowid=?)`;
  connection.counters.authorityReads++;
  if (db.prepare(`SELECT 1 FROM source_files WHERE id IS ${selected}`).get(dirtyRow))
    fail('source identity exceeds binding bound');
  // Cache-only malformed identities cannot become authority. Delete just their
  // indexed references, using the queued SQL identity without decoding it in JS.
  for (const name of ['links', 'occurrences', 'heads'] as const) {
    const fields = deletionFields(name);
    const count = db
      .prepare(
        `SELECT COUNT(*) n,COALESCE(SUM(length(CAST(json_object(${fields},'deleted',json('true')) AS BLOB))),0) bytes FROM ${table(name)} WHERE source_id IS ${selected}`,
      )
      .get(dirtyRow)!;
    connection.counters.projectionRowsRead += Number(count.n);
    connection.counters.projectionReadBytes += Number(count.bytes);
    db.prepare(`DELETE FROM ${table(name)} WHERE source_id IS ${selected}`).run(dirtyRow);
    connection.counters.projectionWrites += Number(count.n);
    connection.counters.projectionBytes += Number(count.bytes);
    connection.counters.rowsDeleted += Number(count.n);
    connection.counters.deletedBytes += Number(count.bytes);
  }
  db.prepare(`DELETE FROM temp.${INVALIDATED} WHERE source_id IS ${selected}`).run(dirtyRow);
  db.prepare(`DELETE FROM temp.${DIRTY} WHERE rowid=?`).run(dirtyRow);
}
function current<T>(
  db: DatabaseSync,
  options: SourceTextProjectionOptions,
  consume: (connection: Connection, profile: string) => T,
): T {
  if (!db.isOpen) {
    clearSourceTextProjectionCache(db);
    return fail('closed');
  }
  const connection = connectionFor(db);
  try {
    if (recordDurabilityStatus(db)?.dirty) fail('accepted projection requires recovery');
    const profile = db
      .prepare(
        "SELECT CASE WHEN length(CAST(value AS BLOB))<=1024 THEN value END value FROM app_meta WHERE key='owner_profile_id'",
      )
      .get()?.value;
    if (typeof profile !== 'string' || !profile) fail('profile binding');
    db.exec('SAVEPOINT __source_text_reconcile');
    try {
      sourceTracking(db);
      const dataVersion = Number(db.prepare('PRAGMA data_version').get()!.data_version);
      if (connection.dataVersion !== dataVersion) {
        connection.schema = -1;
        connection.snapshots.clear();
        connection.dataVersion = dataVersion;
      }
      if (connection.schema !== schemaVersion(db)) initialize(db, connection, profile as string);
      if (!bindingMatches(db, profile as string)) initialize(db, connection, profile as string);
      const obsolete = new Set<string>();
      // Own writes can mark shared-content dependents. Drain them before clearing
      // markers; removing a marker before its reconciliation preserves new marks.
      while (true) {
        const next = db
          .prepare(
            `SELECT rowid dirty_row,CASE WHEN length(CAST(source_id AS BLOB))<=1024 THEN source_id END source_id FROM temp.${DIRTY} ORDER BY source_id LIMIT 1`,
          )
          .get();
        if (!next) break;
        if (typeof next.source_id !== 'string' || !next.source_id) {
          removeMalformedIdentity(db, connection, next.dirty_row!);
          continue;
        }
        const id = String(next.source_id);
        db.prepare(`DELETE FROM temp.${DIRTY} WHERE source_id=?`).run(id);
        reconcile(db, connection, id, profile as string, options, obsolete);
        db.prepare(`DELETE FROM temp.${DIRTY} WHERE source_id=?`).run(id);
      }
      let invalidContentKeys = false;
      for (const row of db
        .prepare(
          `SELECT CASE WHEN typeof(id)='text' AND length(id)=64 THEN id END id FROM temp.${OBSOLETE}`,
        )
        .iterate()) {
        readRows(connection, [row]);
        if (typeof row.id === 'string') obsolete.add(row.id);
        else invalidContentKeys = true;
      }
      prune(db, connection, obsolete);
      // Invalid hash keys can only be corrupt disposable content. Remove them in
      // SQL after affected sources have rebuilt, without loading oversized keys.
      if (invalidContentKeys) {
        const predicate = `(id IN (SELECT id FROM temp.${OBSOLETE} WHERE typeof(id)!='text' OR length(id)!=64) OR id IS NULL) AND NOT EXISTS(SELECT 1 FROM ${table('occurrences')} o WHERE o.content_id IS ${table('contents')}.id)`;
        const invalid = db
          .prepare(
            `SELECT COUNT(*) n,COALESCE(SUM(length(CAST(json_object('id',${deletionKey('id')},'deleted',json('true')) AS BLOB))),0) bytes FROM ${table('contents')} WHERE ${predicate}`,
          )
          .get()!;
        connection.counters.cleanupQueries++;
        connection.counters.projectionRowsRead += Number(invalid.n);
        connection.counters.projectionReadBytes += Number(invalid.bytes);
        if (invalid.n) {
          db.exec(`DELETE FROM ${table('contents')} WHERE ${predicate}`);
          connection.counters.projectionWrites += Number(invalid.n);
          connection.counters.rowsDeleted += Number(invalid.n);
          connection.counters.projectionBytes += Number(invalid.bytes);
          connection.counters.deletedBytes += Number(invalid.bytes);
        }
      }
      db.exec(`DELETE FROM temp.${OBSOLETE}`);
      const result = consume(connection, profile as string);
      connection.counters.triggerReferenceRowsRead += Number(
        db.prepare(`SELECT rows_read FROM temp.${WORK} WHERE singleton=1`).get()!.rows_read,
      );
      db.exec(`UPDATE temp.${WORK} SET rows_read=0 WHERE singleton=1`);
      db.exec('RELEASE __source_text_reconcile');
      connection.active = true;
      if (db.isTransaction && !currentTransactionToken(db)) connection.schema = -1;
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK TO __source_text_reconcile; RELEASE __source_text_reconcile');
      } catch {
        /* Outer transaction owner recovers an aborted transaction. */
      }
      throw error;
    }
  } catch (error) {
    connection.schema = -1;
    connection.snapshots.clear();
    if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
    throw error;
  }
}
/** Reconcile current source rows in the caller transaction; never publish authority. */
export function reconcileSourceTextProjection(
  db: DatabaseSync,
  options: SourceTextProjectionOptions = {},
): void {
  current(db, options, () => {});
}
/** Operational intake writers stage an already-used projection in their existing
 * application transaction. Cold, direct-SQL and non-application-transaction
 * producers retain transactional dirty tracking and repair on the next read. */
export function reconcileActiveSourceTextProjection(db: DatabaseSync): void {
  if (connections.get(db)?.active && currentTransactionToken(db)) reconcileSourceTextProjection(db);
}
/** Bounded exact reconstruction. Warm calls reuse verified unchanged snapshots.
 * Limits apply per pure-engine call, not cumulatively across a multi-source batch.
 * Default-budget validation always precedes optional lowered-budget reconstruction.
 */
export function readSourceTextProjection(
  db: DatabaseSync,
  sourceId: string,
  options: SourceTextProjectionOptions = {},
): string {
  if (typeof sourceId !== 'string' || !sourceId || Buffer.byteLength(sourceId) > 1024)
    fail('source identity exceeds binding bound');
  return current(db, options, (connection, profile) => {
    const selected = retained(db, connection, sourceId, profile, true);
    if (!selected) {
      const source = authority(db, connection, sourceId);
      if (typeof source?.logical_head === 'string')
        return fail('native intake text requires ordered stream consumption');
      return fail('selected source is missing');
    }
    if (options.limits) {
      const result = reconstructTextPieces(selected.snapshot, { limits: options.limits });
      addMetrics(connection.counters.engine, result.metrics);
      return result.text;
    }
    return selected.text;
  });
}

/** Read-only analogue of upfront dirty reconciliation. During preparation we
 * cannot initialize or drain tracking rows, so validate the source inventory
 * one identity at a time. These complete compatibility reads are counted. */
export function prepareReadOnlySourceTextSearch(db: DatabaseSync): boolean {
  if (!sourceTextProjectionReadOnly(db)) return false;
  const connection = connectionFor(db);
  if (recordDurabilityStatus(db)?.dirty) fail('accepted projection requires recovery');
  for (const row of db
    .prepare(
      "SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB)) BETWEEN 1 AND 1024 THEN id END id FROM source_files ORDER BY id",
    )
    .iterate()) {
    connection.counters.authorityReads++;
    if (typeof row.id !== 'string') return fail('source identity exceeds binding bound');
    const selected = authority(db, connection, row.id);
    if (!selected) return fail('selected source text is unavailable');
    if (
      selected.logical_head === undefined &&
      (selected.details_json as string).length > TEXT_PIECE_LIMITS.maxTextUtf16Units
    )
      fail('selected authority exceeds the text bound');
  }
  sourceTextProjectionReadOnly(db);
  return true;
}

function consumeReadOnlySourceText(
  db: DatabaseSync,
  sourceId: string,
  consume: (chunk: string) => void,
): void {
  const connection = connectionFor(db);
  if (recordDurabilityStatus(db)?.dirty) fail('accepted projection requires recovery');
  const profile = () =>
    db
      .prepare(
        "SELECT CASE WHEN length(CAST(value AS BLOB))<=1024 THEN value END value FROM app_meta WHERE key='owner_profile_id'",
      )
      .get()?.value;
  const owner = profile();
  if (typeof owner !== 'string' || !owner) fail('profile binding');
  const selected = authority(db, connection, sourceId);
  if (!selected) return fail('selected source text is unavailable');
  if (typeof selected.logical_head === 'string') {
    for (const chunk of iterateIntakeEnvelopeText(
      db,
      selected as unknown as IntakeEnvelopeSource,
    )) {
      connection.counters.authorityReads++;
      connection.counters.authorityBytes += Buffer.byteLength(chunk);
      consume(chunk);
    }
  } else {
    // Retained/raw compatibility remains explicitly bounded by authority().
    // Consume UTF8-safe fragments through the same exact matcher as native text.
    const text = selected.details_json as string;
    if (text.length > TEXT_PIECE_LIMITS.maxTextUtf16Units)
      fail('selected authority exceeds the text bound');
    for (let at = 0; at < text.length;) {
      let end = Math.min(at + 1024, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      consume(text.slice(at, end));
      at = end;
    }
  }
  const after = authority(db, connection, sourceId);
  if (
    profile() !== owner ||
    !after ||
    ['sha256', 'kind', 'details_json', 'authority_key', 'authority_head', 'logical_head'].some(
      (key) => after[key] !== selected[key],
    )
  )
    fail('selected source text binding changed');
  // Final physical/source observations cannot adopt a changed-and-restored SQL
  // witness. The original preparation owners still decide whether it is current.
  sourceTextProjectionReadOnly(db);
}

/** Consume checked selected text in order without joining a query text operand.
 * Retained v3 uses its explicitly bounded compatibility snapshot; v4 uses the
 * selected authority's streamed logical export rather than a text-piece copy.
 * Always finish traversal: a match before corrupt/missing evidence is incomplete.
 */
export function consumeSourceTextProjection(
  db: DatabaseSync,
  sourceId: string,
  consume: (chunk: string) => void,
): void {
  if (typeof sourceId !== 'string' || !sourceId || Buffer.byteLength(sourceId) > 1024)
    fail('source identity exceeds binding bound');
  if (sourceTextProjectionReadOnly(db)) return consumeReadOnlySourceText(db, sourceId, consume);
  current(db, {}, (connection, profile) => {
    if (!db.prepare(`SELECT 1 FROM ${table('heads')} WHERE source_id=?`).get(sourceId)) {
      const selected = authority(db, connection, sourceId);
      if (!selected || typeof selected.logical_head !== 'string')
        return fail('selected source text is unavailable');
      for (const chunk of iterateIntakeEnvelopeText(
        db,
        selected as unknown as IntakeEnvelopeSource,
      )) {
        connection.counters.authorityReads++;
        connection.counters.authorityBytes += Buffer.byteLength(chunk);
        consume(chunk);
      }
      // A consumer cannot turn a traversal bound to one logical source into a
      // successful result for a different selected source during consumption.
      const after = authority(db, connection, sourceId);
      if (
        !after ||
        after.sha256 !== selected.sha256 ||
        after.logical_head !== selected.logical_head
      )
        return fail('selected source text binding changed');
      return;
    }
    const selected = retained(db, connection, sourceId, profile, true);
    if (!selected) return fail('selected source is missing');
    let id = selected.snapshot.head.first;
    while (id !== null) {
      const piece = selected.snapshot.occurrences.get(id)!;
      consume(selected.snapshot.contents.get(piece.contentId)!.text.slice(piece.start, piece.end));
      id = selected.snapshot.links.get(id)!.next;
    }
  });
}
