import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  currentTransactionToken,
  observeTransactionOutcome,
  rejectCurrentTransaction,
} from './database.ts';
import { recordDurabilityStatus } from './record-versions.ts';
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
const OBSOLETE = '__source_text_obsolete';
const WORK = '__source_text_reference_work';
const schemas = {
  state:
    'singleton INTEGER PRIMARY KEY CHECK(singleton=1),format INTEGER NOT NULL,profile_id TEXT NOT NULL',
  heads:
    'source_id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,source_hash TEXT NOT NULL,details_digest TEXT NOT NULL,head_json TEXT NOT NULL',
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
  dispose: () => void;
  counters: SourceTextProjectionCounters;
}
const connections = new WeakMap<DatabaseSync, Connection>();
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
    dispose: () => {},
    counters: {
      builds: 0,
      rebuiltSources: 0,
      reconciledSources: 0,
      authorityReads: 0,
      authorityBytes: 0,
      authorityHashBytes: 0,
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
    if (!succeeded) connection.schema = -1;
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
/** Forget private readiness on lock/close. No source text is retained in JS connection state. */
export function clearSourceTextProjectionCache(db: DatabaseSync): void {
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
const mark = (id: string) =>
  `INSERT INTO ${DIRTY} SELECT ${id} WHERE NOT EXISTS(SELECT 1 FROM ${DIRTY} WHERE source_id=${id});`;
function sourceTracking(db: DatabaseSync): void {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${DIRTY}(source_id TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS ${OBSOLETE}(id TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS ${WORK}(singleton INTEGER PRIMARY KEY,rows_read INTEGER NOT NULL);
    INSERT OR IGNORE INTO ${WORK} VALUES(1,0);
    CREATE TEMP TRIGGER IF NOT EXISTS __source_text_insert AFTER INSERT ON main.source_files BEGIN ${mark('NEW.id')} END;
    CREATE TEMP TRIGGER IF NOT EXISTS __source_text_update AFTER UPDATE ON main.source_files BEGIN ${mark('OLD.id')} ${mark('NEW.id')} END;
    CREATE TEMP TRIGGER IF NOT EXISTS __source_text_delete AFTER DELETE ON main.source_files BEGIN ${mark('OLD.id')} END;`);
}
function cacheTracking(db: DatabaseSync): void {
  for (const name of ['heads', 'occurrences', 'links'] as const)
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      const refs = op === 'INSERT' ? ['NEW'] : op === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
      const orphan =
        name === 'occurrences' && op !== 'INSERT'
          ? `INSERT INTO ${OBSOLETE} SELECT OLD.content_id WHERE NOT EXISTS(SELECT 1 FROM ${OBSOLETE} WHERE id=OLD.content_id);`
          : '';
      db.exec(
        `CREATE TEMP TRIGGER IF NOT EXISTS __source_text_${name}_${op} AFTER ${op} ON main.${table(name)} BEGIN ${refs.map((ref) => mark(ref + '.source_id')).join(' ')} ${orphan} END`,
      );
    }
  for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
    const refs = op === 'INSERT' ? ['NEW'] : op === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS __source_text_contents_${op} AFTER ${op} ON main.${table('contents')} BEGIN ${refs.map((ref) => `UPDATE ${WORK} SET rows_read=rows_read+2*(SELECT COUNT(*) FROM ${table('occurrences')} WHERE content_id=${ref}.id) WHERE singleton=1; INSERT INTO ${DIRTY} SELECT DISTINCT source_id FROM ${table('occurrences')} o WHERE content_id=${ref}.id AND NOT EXISTS(SELECT 1 FROM ${DIRTY} d WHERE d.source_id=o.source_id); INSERT INTO ${OBSOLETE} SELECT ${ref}.id WHERE NOT EXISTS(SELECT 1 FROM ${OBSOLETE} WHERE id=${ref}.id);`).join(' ')} END`,
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
  cacheTracking(db);
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
): Retained | null {
  const row = readRows(
    connection,
    db
      .prepare(
        `SELECT source_id,CASE WHEN typeof(profile_id)='text' AND length(CAST(profile_id AS BLOB))<=1024 THEN profile_id END profile_id,CASE WHEN typeof(source_hash)='text' AND length(CAST(source_hash AS BLOB))<=1024 THEN source_hash END source_hash,CASE WHEN typeof(details_digest)='text' AND length(details_digest)=64 THEN details_digest END details_digest,CASE WHEN typeof(head_json)='text' AND length(CAST(head_json AS BLOB))<=? THEN head_json ELSE NULL END head_json FROM ${table('heads')} WHERE source_id=?`,
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
    return { row, snapshot, text: result.text };
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
  const raw = source.details_json as string;
  connection.counters.authorityBytes += Buffer.byteLength(raw);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('selected authority JSON is corrupt');
  }
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (source.kind === 'intake_original' && (!object(value) || !object(value.intake)))
    fail('selected original intake authority is incomplete');
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
  };
  if (bytes(head) > TEXT_PIECE_LIMITS.maxRowBytes) fail('source head binding exceeds row bound');
  db.prepare(
    `INSERT INTO ${table('heads')} VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET profile_id=excluded.profile_id,source_hash=excluded.source_hash,details_digest=excluded.details_digest,head_json=excluded.head_json`,
  ).run(id, profile, source.sha256!, plan.head.digest, head.head_json);
  write(connection, 'heads', head);
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
  const raw = source.details_json as string;
  connection.counters.authorityHashBytes += Buffer.byteLength(raw);
  const digest = createHash('sha256').update(raw).digest('hex');
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
/** Bounded exact reconstruction. Warm calls read no source details/operational intake.
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
    const selected = retained(db, connection, sourceId, profile);
    if (!selected) return fail('selected source is missing');
    if (options.limits) {
      const result = reconstructTextPieces(selected.snapshot, { limits: options.limits });
      addMetrics(connection.counters.engine, result.metrics);
      return result.text;
    }
    return selected.text;
  });
}
