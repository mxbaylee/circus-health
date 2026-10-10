import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  json,
  observeDatabaseClose,
  observeTransactionOutcome,
  currentTransactionToken,
  rejectCurrentTransaction,
  type Database,
} from './database.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import {
  intakeEnvelopeAuthorityBinding,
  readIntakeEnvelopeMaterialized,
  type IntakeEnvelopeSource,
} from './intake-authority.ts';
import {
  hasIntakeCollectionEnvelope,
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import {
  boundedIntakeLookupText,
  intakeLookupContributions,
  INTAKE_LOOKUP_SCOPE_BYTES,
} from './intake-lookup-contributions.ts';
import {
  INTAKE_LOOKUP_INDEX_COLLECTION,
  INTAKE_LOOKUP_INDEX_POLICY,
  preparedIntakeLookupReadToken,
  readNativeIntakeLookupTarget,
} from './intake-lookup-state.ts';
import { consumeWorkflowReceiptAppendProof } from './intake-workflow-update.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { protectedIntakeLookupTempShadow } from './intake-lookup-frontier-observer.ts';
import {
  acknowledgeProjectionInputs,
  assertProjectionAnswerWitness,
  discardIntakeProjectionWitness,
  ensureIntakeProjectionWitness,
  intakeProjectionWitnessCurrent,
  ownedIntakeProjectionWrite,
  projectionInputVersion,
  projectionAnswerWitness,
  projectionWitnessHasForeignMutation,
  projectionWitnessRevision,
  renewIntakeProjectionWitnessAfterIndexRepair,
  resetIntakeProjectionWitness,
  sealIntakeProjectionWitness,
} from './intake-lookup-projection-witness.ts';
export {
  prepareIntakeLookupIndices,
  intakeDiscoveryRevision,
  assertIntakeDiscoveryRevision,
} from './intake-lookup-state.ts';

const PREFIX = '__record_intake_lookup_';
const VERSION = 2;
const tables = {
  state: 'singleton,format,profile_id',
  sources: 'source_id,source_order,kind,authority_key,authority_head,identity_first',
  groups: 'source_id,ordinal,discovery_order',
  acceptances: 'source_id,operation_id,hash',
  identities: 'source_id,id,next,hash',
  payloads: 'hash,payload',
};
export interface IntakeLookupCounters {
  builds: number;
  reconciledSources: number;
  authorityReads: number;
  authorityBytes: number;
  projectionRowsRead: number;
  projectionReadBytes: number;
  hashedPayloadBytes: number;
  contributionItemsVisited: number;
  serializedPayloadBytes: number;
  identityLinksWritten: number;
  cleanupQueries: number;
  projectionWrites: number;
  projectionBytes: number;
  payloadMemoCreated: number;
  payloadMemoClosed: number;
  nativeReceiptRowsWritten: number;
}
interface Connection {
  generation: object;
  dispose: () => void;
  rebuild: boolean;
  schema: number;
  counters: IntakeLookupCounters;
  hashes?: ReturnType<typeof disposableSqlite>;
  entries: WeakMap<object, Map<string, ProjectionRow>>;
  nativeCatalog?: NativeLookupCatalog & { token: object };
  nativeReceiptAppend?: {
    members: ReadonlyMap<string, NativeReceiptAppend>;
    outcomeToken?: object;
  };
  catalogAttempt?: object;
}
const connections = new WeakMap<DatabaseSync, Connection>();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const table = (name: keyof typeof tables) => PREFIX + name;
const fail = (reason: string): never => {
  throw Error(`Intake lookup projection: ${reason}`);
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function clearPayloadMemo(connection: Connection): void {
  connection.generation = {};
  connection.catalogAttempt = undefined;
  connection.nativeCatalog?.scratch.close();
  connection.nativeCatalog = undefined;
  connection.nativeReceiptAppend = undefined;
  if (connection.hashes) {
    connection.hashes.close();
    connection.hashes = undefined;
    connection.counters.payloadMemoClosed++;
  }
  connection.entries = new WeakMap();
}
function payloadMemo(connection: Connection) {
  if (!connection.hashes) {
    const scratch = disposableSqlite('circus-intake-lookup-memo-');
    try {
      // The exact text key avoids hashing unchanged payloads merely to find
      // their verified digest. SQLite retains a fixed page cache rather than
      // a JS Map containing the complete legacy receipt corpus.
      scratch.db.exec(
        'CREATE TABLE verified_payloads(payload TEXT PRIMARY KEY,hash TEXT NOT NULL) WITHOUT ROWID',
      );
      connection.hashes = scratch;
      connection.counters.payloadMemoCreated++;
    } catch (error) {
      scratch.close();
      throw error;
    }
  }
  return connection.hashes.db;
}
function create(db: DatabaseSync): Connection {
  const connection: Connection = {
    generation: {},
    dispose: () => {},
    rebuild: false,
    schema: -1,
    entries: new WeakMap(),
    counters: {
      builds: 0,
      reconciledSources: 0,
      authorityReads: 0,
      authorityBytes: 0,
      projectionRowsRead: 0,
      projectionReadBytes: 0,
      hashedPayloadBytes: 0,
      contributionItemsVisited: 0,
      serializedPayloadBytes: 0,
      identityLinksWritten: 0,
      cleanupQueries: 0,
      projectionWrites: 0,
      projectionBytes: 0,
      payloadMemoCreated: 0,
      payloadMemoClosed: 0,
      nativeReceiptRowsWritten: 0,
    },
  };
  const stopOutcome = observeTransactionOutcome(db, (outcome) => {
    if (!outcome.succeeded) {
      clearPayloadMemo(connection);
      connection.schema = -1;
    }
  });
  const stopClose = observeDatabaseClose(db, () => clearIntakeLookupCache(db));
  connection.dispose = () => {
    stopOutcome();
    stopClose();
    clearPayloadMemo(connection);
  };
  connections.set(db, connection);
  return connection;
}
export function intakeLookupCounters(db: DatabaseSync): IntakeLookupCounters {
  return (connections.get(db) ?? create(db)).counters;
}
/** Counters describe logical changed-row payload bytes, not physical SQLite writes. */
/** Remove decrypted connection state; TEMP tracking is recreated safely on next use. */
export function clearIntakeLookupCache(db: DatabaseSync): void {
  discardIntakeProjectionWitness(db);
  connections.get(db)?.dispose();
  connections.delete(db);
}
function schemaVersion(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA schema_version').get()!.schema_version);
}
function tracking(db: DatabaseSync): boolean {
  // An outer UPSERT can override a trigger's OR IGNORE conflict policy.
  // Avoid inserting repeated OLD/NEW keys, as the authority triggers do.
  const markDirty = (id: string) =>
    `INSERT INTO __intake_lookup_dirty(source_id) SELECT ${id}
      WHERE NOT EXISTS(SELECT 1 FROM __intake_lookup_dirty WHERE source_id=${id});`;
  const statements = [
    `CREATE TEMP TABLE IF NOT EXISTS __intake_lookup_dirty(source_id TEXT PRIMARY KEY)`,
    `CREATE TEMP TABLE IF NOT EXISTS __intake_lookup_authorities(authority_key TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE)`,
    `CREATE TEMP TRIGGER IF NOT EXISTS __intake_lookup_insert AFTER INSERT ON main.source_files BEGIN ${markDirty('NEW.id')} END`,
    `CREATE TEMP TRIGGER IF NOT EXISTS __intake_lookup_update AFTER UPDATE ON main.source_files BEGIN ${markDirty('OLD.id')} ${markDirty('NEW.id')} END`,
    `CREATE TEMP TRIGGER IF NOT EXISTS __intake_lookup_delete AFTER DELETE ON main.source_files BEGIN ${markDirty('OLD.id')} END`,
  ];
  const names = [
    '__intake_lookup_dirty',
    '__intake_lookup_authorities',
    '__intake_lookup_insert',
    '__intake_lookup_update',
    '__intake_lookup_delete',
  ];
  const existing = new Map(
    db
      .prepare(
        `SELECT name,sql FROM sqlite_temp_master WHERE name IN (${names.map(() => '?').join(',')})`,
      )
      .all(...names)
      .map((row) => [String(row.name), String(row.sql)]),
  );
  const canonical = (statement: string) =>
    statement.replace(/^CREATE TEMP (TABLE|TRIGGER) IF NOT EXISTS /, 'CREATE $1 ');
  let changed = false;
  for (let index = 0; index < names.length; index++) {
    const actual = existing.get(names[index]!);
    if (actual !== undefined && actual !== canonical(statements[index]!)) fail('tracking schema');
    if (actual === undefined) {
      db.exec(statements[index]!);
      changed = true;
    }
  }
  return changed;
}
function initialize(db: DatabaseSync, connection: Connection, profile: string): void {
  // Reconstruction cannot inherit text retained by an aborted attempt or an
  // earlier schema/profile binding. Keep work counters across invalidation.
  clearPayloadMemo(connection);
  const cold = connection.schema === -1;
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '__record_intake_lookup_*'",
    )
    .all()
    .map((r) => String(r.name));
  if (
    names.some(
      (name) => !Object.keys(tables).some((key) => table(key as keyof typeof tables) === name),
    )
  )
    fail('unknown projection schema');
  let valid = !connection.rebuild && names.length === Object.keys(tables).length;
  for (const [name, columns] of Object.entries(tables)) {
    const actual = db
      .prepare(`PRAGMA table_info(${PREFIX + name})`)
      .all()
      .map((r) => String(r.name))
      .join(',');
    valid &&= actual === columns;
    const info = db.prepare(`PRAGMA table_info(${PREFIX + name})`).all();
    const expectedPk =
      name === 'state'
        ? [1, 0, 0]
        : name === 'sources'
          ? [1, 0, 0, 0, 0, 0]
          : name === 'payloads'
            ? [1, 0]
            : name === 'identities'
              ? [1, 2, 0, 0]
              : [1, 2, 0];
    valid &&= info.every(
      (column, index) =>
        Number(column.pk) === expectedPk[index] &&
        column.type ===
          ([
            'singleton',
            'format',
            'source_order',
            'ordinal',
            'discovery_order',
            'identity_first',
            'id',
            'next',
          ].includes(String(column.name))
            ? 'INTEGER'
            : 'TEXT'),
    );
    const required =
      name === 'state' || name === 'sources'
        ? [1, 2]
        : name === 'payloads'
          ? [1]
          : name === 'groups'
            ? [0, 1]
            : name === 'identities'
              ? [0, 1, 3]
              : [0, 1, 2];
    valid &&= required.every((index) => info[index]?.notnull === 1);
  }
  if (valid) {
    const rows = db.prepare(`SELECT * FROM ${table('state')}`).all();
    valid =
      rows.length === 1 &&
      rows[0]!.singleton === 1 &&
      rows[0]!.format === VERSION &&
      rows[0]!.profile_id === profile;
  }
  // Every row here is disposable. Never delete source/accepted evidence to repair this cache.
  if (!valid) {
    resetIntakeProjectionWitness(db);
    for (const name of Object.keys(tables) as Array<keyof typeof tables>)
      db.exec(`DROP TABLE IF EXISTS ${table(name)}`);
    db.exec(`CREATE TABLE ${table('state')}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format INTEGER NOT NULL,profile_id TEXT NOT NULL);
      CREATE TABLE ${table('sources')}(source_id TEXT PRIMARY KEY,source_order INTEGER NOT NULL,kind TEXT NOT NULL,authority_key TEXT,authority_head TEXT,identity_first INTEGER);
      CREATE TABLE ${table('groups')}(source_id TEXT NOT NULL,ordinal INTEGER NOT NULL,discovery_order INTEGER,PRIMARY KEY(source_id,ordinal));
      CREATE INDEX ${PREFIX}discovery ON ${table('groups')}(discovery_order DESC);
      CREATE TABLE ${table('acceptances')}(source_id TEXT NOT NULL,operation_id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(source_id,operation_id));
      CREATE INDEX ${PREFIX}operation ON ${table('acceptances')}(operation_id);
      CREATE TABLE ${table('identities')}(source_id TEXT NOT NULL,id INTEGER NOT NULL,next INTEGER,hash TEXT NOT NULL,PRIMARY KEY(source_id,id));
      CREATE TABLE ${table('payloads')}(hash TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
    db.prepare(`INSERT INTO ${table('state')} VALUES(1,?,?)`).run(VERSION, profile);
    db.exec('INSERT OR IGNORE INTO temp.__intake_lookup_dirty SELECT id FROM source_files');
    connection.counters.builds++;
  } else if (cold) {
    // A new connection cannot assume that the closed connection's triggers saw later writes.
    db.exec('INSERT OR IGNORE INTO temp.__intake_lookup_dirty SELECT id FROM source_files');
    db.exec(
      `INSERT OR IGNORE INTO temp.__intake_lookup_dirty SELECT source_id FROM ${table('sources')}`,
    );
    connection.counters.builds++;
  }
  // Restore missing/replaced lookup indexes without reading any authority.
  for (const [name, target, column, descending] of [
    ['discovery', 'groups', 'discovery_order', true],
    ['operation', 'acceptances', 'operation_id', false],
    ['acceptance_hash', 'acceptances', 'hash', false],
    ['identity_hash', 'identities', 'hash', false],
    ['authority', 'sources', 'authority_key', false],
  ] as const) {
    const index = db
      .prepare(`PRAGMA index_xinfo(${PREFIX + name})`)
      .all()
      .filter((row) => row.key === 1);
    if (
      index.length !== 1 ||
      index[0]!.name !== column ||
      Number(index[0]!.desc) !== Number(descending)
    ) {
      db.exec(
        `DROP INDEX IF EXISTS ${PREFIX + name}; CREATE INDEX ${PREFIX + name} ON ${table(target)}(${column}${descending ? ' DESC' : ''})`,
      );
    }
  }
  for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
    const refs = op === 'INSERT' ? ['NEW'] : op === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
    const name = `__intake_lookup_authority_${op}`;
    const sql = `CREATE TRIGGER ${name} AFTER ${op} ON main.app_meta BEGIN ${refs.map((ref) => `INSERT INTO __intake_lookup_dirty SELECT source_id FROM __intake_lookup_authorities a WHERE authority_key=${ref}.key AND NOT EXISTS(SELECT 1 FROM __intake_lookup_dirty d WHERE d.source_id=a.source_id);`).join(' ')} END`;
    const existing = db
      .prepare("SELECT sql FROM sqlite_temp_schema WHERE type='trigger' AND name=?")
      .get(name)?.sql;
    if (existing !== undefined && existing !== sql) fail('authority tracking schema');
    if (existing === undefined) db.exec(sql.replace('CREATE TRIGGER ', 'CREATE TEMP TRIGGER '));
  }
  db.exec(
    `DELETE FROM temp.__intake_lookup_authorities; INSERT OR IGNORE INTO temp.__intake_lookup_authorities SELECT authority_key,source_id FROM ${table('sources')} WHERE authority_key IS NOT NULL`,
  );
  connection.rebuild = false;
  connection.schema = schemaVersion(db);
}
function countWrite(connection: Connection, payload: unknown): void {
  connection.counters.projectionWrites++;
  connection.counters.projectionBytes += Buffer.byteLength(JSON.stringify(payload));
}
function prune(db: DatabaseSync, connection: Connection, obsolete: Set<string>): void {
  for (const hash of obsolete) {
    connection.counters.cleanupQueries++;
    const retained = db
      .prepare(
        `SELECT 1 FROM ${table('acceptances')} WHERE hash=? UNION ALL SELECT 1 FROM ${table('identities')} WHERE hash=? LIMIT 1`,
      )
      .get(hash, hash);
    connection.counters.projectionRowsRead += retained ? 1 : 0;
    connection.counters.projectionReadBytes += retained
      ? Buffer.byteLength(JSON.stringify(retained))
      : 0;
    if (!retained) {
      const removed = ownedIntakeProjectionWrite(
        db,
        { table: 'payloads', operations: ['delete'], key: hash },
        () =>
          db.prepare(`DELETE FROM ${table('payloads')} WHERE hash=? RETURNING payload`).get(hash),
      );
      if (removed) {
        connection.hashes?.db
          .prepare('DELETE FROM verified_payloads WHERE payload=?')
          .run(String(removed.payload));
        countWrite(connection, { hash, deleted: true });
      }
    }
  }
}
type ProjectionRow = Record<string, import('node:sqlite').SQLOutputValue>;
function readRows(connection: Connection, rows: ProjectionRow[]): void {
  connection.counters.projectionRowsRead += rows.length;
  connection.counters.projectionReadBytes += Buffer.byteLength(JSON.stringify(rows));
}
function identityOrder(rows: ProjectionRow[], first: unknown): ProjectionRow[] | undefined {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: ProjectionRow[] = [];
  const seen = new Set<unknown>();
  let next = first;
  while (next !== null) {
    if (!Number.isSafeInteger(next) || seen.has(next)) return;
    const row = byId.get(next as number);
    if (!row) return;
    ordered.push(row);
    seen.add(next);
    next = row.next;
  }
  return ordered.length === rows.length ? ordered : undefined;
}
function reconcile(db: DatabaseSync, connection: Connection, id: string): Set<string> {
  const source = db
    .prepare(
      'SELECT rowid AS source_order,id,kind,sha256,details_json FROM source_files WHERE id=?',
    )
    .get(id);
  const obsolete = new Set<string>();
  const retainedHere = new Set<string>();
  if (!source)
    for (const name of ['acceptances', 'identities'] as const) {
      const rows = db.prepare(`SELECT hash FROM ${table(name)} WHERE source_id=?`).all(id);
      connection.counters.projectionRowsRead += rows.length;
      connection.counters.projectionReadBytes += Buffer.byteLength(JSON.stringify(rows));
      for (const row of rows) obsolete.add(String(row.hash));
    }
  connection.counters.reconciledSources++;
  connection.counters.authorityReads++;
  if (!source) {
    db.prepare('DELETE FROM temp.__intake_lookup_authorities WHERE source_id=?').run(id);
    for (const name of ['groups', 'acceptances', 'identities', 'sources'] as const) {
      const rows = ownedIntakeProjectionWrite(
        db,
        { table: name, operations: ['delete'], key: id },
        () => db.prepare(`DELETE FROM ${table(name)} WHERE source_id=? RETURNING *`).all(id),
      );
      for (const row of rows) countWrite(connection, { ...row, deleted: true });
      if (name === 'identities') connection.counters.identityLinksWritten += rows.length;
      if (name === 'sources' && rows[0]?.identity_first !== null)
        connection.counters.identityLinksWritten += rows.length;
    }
    db.prepare('DELETE FROM temp.__intake_lookup_dirty WHERE source_id=?').run(id);
    return obsolete;
  }
  const selected = source as unknown as IntakeEnvelopeSource;
  const binding = intakeEnvelopeAuthorityBinding(db, selected);
  if (binding.logicalHead !== undefined && hasIntakeCollectionEnvelope(db, selected)) {
    // Native semantic roots are independently checked by their point consumers.
    // Reconciliation records the logical binding only; it never derives an
    // index from the workflow or rewrites text on auxiliary head changes.
    connection.counters.authorityBytes += Buffer.byteLength(JSON.stringify(source));
    const prior = db.prepare(`SELECT * FROM ${table('sources')} WHERE source_id=?`).get(id);
    if (prior?.identity_first !== -1) {
      for (const name of ['acceptances', 'identities'] as const) {
        while (true) {
          const row = db
            .prepare(`SELECT hash FROM ${table(name)} WHERE source_id=? LIMIT 1`)
            .get(id);
          if (!row) break;
          ownedIntakeProjectionWrite(db, { table: name, operations: ['delete'], key: id }, () =>
            db
              .prepare(`DELETE FROM ${table(name)} WHERE source_id=? AND hash=?`)
              .run(id, row.hash!),
          );
          prune(db, connection, new Set([String(row.hash)]));
          countWrite(connection, { id, hash: row.hash, deleted: true });
        }
      }
      ownedIntakeProjectionWrite(db, { table: 'groups', operations: ['delete'], key: id }, () =>
        db.prepare(`DELETE FROM ${table('groups')} WHERE source_id=?`).run(id),
      );
    }
    if (
      !prior ||
      prior.source_order !== source.source_order ||
      prior.kind !== source.kind ||
      prior.authority_key !== binding.key ||
      prior.authority_head !== binding.logicalHead ||
      prior.identity_first !== -1
    ) {
      ownedIntakeProjectionWrite(
        db,
        { table: 'sources', operations: ['insert', 'update'], key: id },
        () =>
          db
            .prepare(
              `INSERT INTO ${table('sources')} VALUES(?,?,?,?,?,-1) ON CONFLICT(source_id) DO UPDATE SET source_order=excluded.source_order,kind=excluded.kind,authority_key=excluded.authority_key,authority_head=excluded.authority_head,identity_first=-1`,
            )
            .run(
              id,
              Number(source.source_order),
              String(source.kind),
              binding.key,
              binding.logicalHead!,
            ),
      );
      countWrite(connection, { id, logicalHead: binding.logicalHead });
    }
    db.prepare('DELETE FROM temp.__intake_lookup_authorities WHERE source_id=?').run(id);
    if (binding.key !== null)
      db.prepare('INSERT INTO temp.__intake_lookup_authorities VALUES(?,?)').run(binding.key, id);
    db.prepare('DELETE FROM temp.__intake_lookup_dirty WHERE source_id=?').run(id);
    return obsolete;
  }
  const material =
    source.kind === 'intake_original' ? readIntakeEnvelopeMaterialized(db, selected) : undefined;
  const raw = material?.text ?? String(source.details_json);
  connection.counters.authorityBytes += Buffer.byteLength(raw);
  const validJson =
    material?.mode === 'normalized' ||
    Number(db.prepare('SELECT json_valid(?) valid').get(raw)!.valid) === 1;
  const all = material?.value ?? json(raw);
  if (!object(all)) {
    if (source.kind === 'intake_original') fail('original metadata is unavailable');
  } else if (source.kind === 'intake_original' && !object(all.intake))
    fail('original metadata is unavailable');
  const intake = object(all) && object(all.intake) ? all.intake : undefined;
  const workflow = intake?.workflow;
  if (intake && Object.hasOwn(intake, 'workflow') && workflow !== undefined && !object(workflow))
    fail('malformed workflow');
  for (const name of ['reportGroups', 'reportAcceptances', 'identityConfirmations']) {
    const entries = object(workflow) ? workflow[name] : undefined;
    if (entries != null && !Array.isArray(entries)) fail('malformed contribution array');
  }
  const prior = db
    .prepare(
      `SELECT source_order,kind,authority_key,authority_head FROM ${table('sources')} WHERE source_id=?`,
    )
    .get(id);
  connection.counters.projectionRowsRead += prior ? 1 : 0;
  connection.counters.projectionReadBytes += prior ? Buffer.byteLength(JSON.stringify(prior)) : 0;
  if (
    !prior ||
    prior.source_order !== source.source_order ||
    prior.kind !== source.kind ||
    prior.authority_key !== binding.key ||
    prior.authority_head !== binding.head
  ) {
    ownedIntakeProjectionWrite(
      db,
      { table: 'sources', operations: ['insert', 'update'], key: id },
      () =>
        db
          .prepare(
            `INSERT INTO ${table('sources')}(source_id,source_order,kind,authority_key,authority_head) VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET source_order=excluded.source_order,kind=excluded.kind,authority_key=excluded.authority_key,authority_head=excluded.authority_head`,
          )
          .run(id, source.source_order!, source.kind!, binding.key, binding.head),
    );
    countWrite(connection, {
      id,
      source_order: source.source_order,
      kind: source.kind,
      authority_key: binding.key,
      authority_head: binding.head,
    });
    db.prepare('DELETE FROM temp.__intake_lookup_authorities WHERE source_id=?').run(id);
    if (binding.key !== null)
      db.prepare('INSERT INTO temp.__intake_lookup_authorities VALUES(?,?)').run(binding.key, id);
  }
  const entries = (name: string, originalOnly: boolean): ProjectionRow[] => {
    if (!validJson || (originalOnly && source.kind !== 'intake_original')) return [];
    const columns = `j.value AS payload,${name === 'reportGroups' ? "CAST(json_extract(j.value,'$.discoveryOrder') AS INTEGER)" : 'NULL'} discovery_order,${name === 'reportAcceptances' ? "json_extract(j.value,'$.receipt.operationId')" : 'NULL'} operation_id`;
    let rows: ProjectionRow[];
    if (material?.mode === 'normalized') {
      const values = object(workflow) && Array.isArray(workflow[name]) ? workflow[name] : [];
      rows = values.map((value: unknown) => {
        const cached =
          value && typeof value === 'object' ? connection.entries.get(value)?.get(name) : undefined;
        if (cached) return cached;
        const serialized = JSON.stringify([value]);
        connection.counters.serializedPayloadBytes += Buffer.byteLength(serialized);
        const row = db.prepare(`SELECT ${columns} FROM json_each(?) j`).get(serialized)!;
        if (value && typeof value === 'object') {
          const cached = connection.entries.get(value) ?? new Map<string, ProjectionRow>();
          cached.set(name, row);
          connection.entries.set(value, cached);
        }
        return row;
      });
    } else {
      // Exact SQL-first member selection is required for retained raw JSON with
      // duplicate keys, and json_each's scalar conversions remain observable.
      rows = db
        .prepare(`SELECT ${columns} FROM json_each(?,?) j`)
        .all(raw, '$.intake.workflow.' + name);
    }
    connection.counters.contributionItemsVisited += rows.length;
    return rows;
  };
  // Discovery exposes only a maximum. No consumer observes group ordinals or
  // multiplicity; retaining one scalar avoids shifting every later group.
  const groups = entries('reportGroups', true);
  let maximum: number | null = null;
  for (const entry of groups) {
    const value = entry.discovery_order;
    if (value !== null && (maximum === null || Number(value) > maximum)) maximum = Number(value);
  }
  const oldGroup = db
    .prepare(`SELECT ordinal,discovery_order FROM ${table('groups')} WHERE source_id=?`)
    .all(id);
  readRows(connection, oldGroup);
  for (const row of oldGroup)
    if (row.ordinal !== 0) {
      ownedIntakeProjectionWrite(
        db,
        { table: 'groups', operations: ['delete'], key: id, subkey: String(row.ordinal) },
        () =>
          db
            .prepare(`DELETE FROM ${table('groups')} WHERE source_id=? AND ordinal=?`)
            .run(id, row.ordinal!),
      );
      countWrite(connection, { id, ordinal: row.ordinal, deleted: true });
    }
  if (!oldGroup.some((row) => row.ordinal === 0 && row.discovery_order === maximum)) {
    ownedIntakeProjectionWrite(
      db,
      { table: 'groups', operations: ['insert', 'update'], key: id, subkey: '0' },
      () =>
        db
          .prepare(
            `INSERT INTO ${table('groups')} VALUES(?,0,?) ON CONFLICT(source_id,ordinal) DO UPDATE SET discovery_order=excluded.discovery_order`,
          )
          .run(id, maximum),
    );
    countWrite(connection, { id, ordinal: 0, discovery_order: maximum });
  }
  const payload = (value: unknown): string => {
    // Preserve json_each scalar behavior, including its boolean conversion.
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof value !== 'string')
      connection.counters.serializedPayloadBytes += Buffer.byteLength(text);
    const memo = payloadMemo(connection);
    let hash = memo.prepare('SELECT hash FROM verified_payloads WHERE payload=?').get(text)?.hash;
    if (!hash) {
      connection.counters.hashedPayloadBytes += Buffer.byteLength(text);
      hash = digest(text);
      // Only an actual digest of selected authority text can populate this
      // private index. Public disposable projection rows are never its proof.
      memo.prepare('INSERT INTO verified_payloads VALUES(?,?)').run(text, hash);
    }
    if (typeof hash !== 'string') return fail('invalid private payload memo');
    retainedHere.add(hash);
    const stored = db.prepare(`SELECT payload FROM ${table('payloads')} WHERE hash=?`).get(hash);
    readRows(connection, stored ? [stored] : []);
    if (!stored || stored.payload !== text) {
      ownedIntakeProjectionWrite(
        db,
        { table: 'payloads', operations: ['insert', 'update'], key: hash },
        () =>
          db
            .prepare(
              `INSERT INTO ${table('payloads')} VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET payload=excluded.payload`,
            )
            .run(hash, text),
      );
      countWrite(connection, { hash, payload: text });
    }
    return hash;
  };
  const oldAcceptances = db
    .prepare(`SELECT operation_id,hash FROM ${table('acceptances')} WHERE source_id=?`)
    .all(id);
  readRows(connection, oldAcceptances);
  const acceptanceMap = new Map(
    oldAcceptances.map((row) => [String(row.operation_id), String(row.hash)]),
  );
  for (const row of oldAcceptances) obsolete.add(String(row.hash));
  const seenOperations = new Set<string>();
  for (const entry of entries('reportAcceptances', true)) {
    const operation = entry.operation_id;
    if (operation !== null && typeof operation !== 'string')
      return fail('invalid acceptance operation identity');
    if (operation === null || seenOperations.has(operation)) continue;
    seenOperations.add(operation);
    const hash = payload(entry.payload);
    if (acceptanceMap.get(operation) !== hash) {
      ownedIntakeProjectionWrite(
        db,
        { table: 'acceptances', operations: ['insert', 'update'], key: id, subkey: operation },
        () =>
          db
            .prepare(
              `INSERT INTO ${table('acceptances')} VALUES(?,?,?) ON CONFLICT(source_id,operation_id) DO UPDATE SET hash=excluded.hash`,
            )
            .run(id, operation, hash),
      );
      countWrite(connection, { id, operation, hash });
    }
    acceptanceMap.delete(operation);
  }
  for (const operation of acceptanceMap.keys()) {
    ownedIntakeProjectionWrite(
      db,
      { table: 'acceptances', operations: ['delete'], key: id, subkey: operation },
      () =>
        db
          .prepare(`DELETE FROM ${table('acceptances')} WHERE source_id=? AND operation_id=?`)
          .run(id, operation),
    );
    countWrite(connection, { id, operation, deleted: true });
  }
  const oldIdentities = db
    .prepare(`SELECT id,next,hash FROM ${table('identities')} WHERE source_id=? ORDER BY id`)
    .all(id);
  readRows(connection, oldIdentities);
  for (const row of oldIdentities) obsolete.add(String(row.hash));
  const first = db
    .prepare(`SELECT identity_first FROM ${table('sources')} WHERE source_id=?`)
    .get(id)!.identity_first;
  const oldOrder = identityOrder(oldIdentities, first) ?? oldIdentities;
  const desired = entries('identityConfirmations', false).map((entry) => payload(entry.payload));
  const matched: Array<(typeof oldIdentities)[number] | undefined> = new Array(desired.length);
  const used = new Set<number>();
  let prefix = 0;
  while (
    prefix < Math.min(oldOrder.length, desired.length) &&
    oldOrder[prefix]!.hash === desired[prefix]
  ) {
    matched[prefix] = oldOrder[prefix];
    used.add(Number(oldOrder[prefix]!.id));
    prefix++;
  }
  let oldEnd = oldOrder.length - 1,
    nextEnd = desired.length - 1;
  while (oldEnd >= prefix && nextEnd >= prefix && oldOrder[oldEnd]!.hash === desired[nextEnd]) {
    matched[nextEnd] = oldOrder[oldEnd];
    used.add(Number(oldOrder[oldEnd]!.id));
    oldEnd--;
    nextEnd--;
  }
  const queues = new Map<string, { rows: typeof oldIdentities; cursor: number }>();
  for (const row of oldOrder) {
    if (used.has(Number(row.id))) continue;
    let queue = queues.get(String(row.hash));
    if (!queue) {
      queue = { rows: [], cursor: 0 };
      queues.set(String(row.hash), queue);
    }
    queue.rows.push(row);
  }
  let nextId = oldIdentities.reduce((maximum, row) => Math.max(maximum, Number(row.id)), -1) + 1;
  const nextRows = desired.map((hash, index) => {
    const queue = queues.get(hash);
    const before = matched[index] ?? queue?.rows[queue.cursor++];
    if (before) used.add(Number(before.id));
    const occurrence = before ? Number(before.id) : nextId++;
    if (!Number.isSafeInteger(occurrence)) fail('identity occurrence limit');
    return { id: occurrence, hash, before };
  });
  for (let index = 0; index < nextRows.length; index++) {
    const row = nextRows[index]!,
      next = nextRows[index + 1]?.id ?? null;
    if (!row.before || row.before.next !== next) {
      ownedIntakeProjectionWrite(
        db,
        { table: 'identities', operations: ['insert', 'update'], key: id, subkey: String(row.id) },
        () =>
          db
            .prepare(
              `INSERT INTO ${table('identities')} VALUES(?,?,?,?) ON CONFLICT(source_id,id) DO UPDATE SET next=excluded.next,hash=excluded.hash`,
            )
            .run(id, row.id, next, row.hash),
      );
      countWrite(connection, { id, occurrence: row.id, next, hash: row.hash });
      connection.counters.identityLinksWritten++;
    }
  }
  for (const row of oldIdentities)
    if (!used.has(Number(row.id))) {
      ownedIntakeProjectionWrite(
        db,
        { table: 'identities', operations: ['delete'], key: id, subkey: String(row.id) },
        () =>
          db
            .prepare(`DELETE FROM ${table('identities')} WHERE source_id=? AND id=?`)
            .run(id, row.id!),
      );
      countWrite(connection, { id, occurrence: row.id, deleted: true });
      connection.counters.identityLinksWritten++;
    }
  const nextFirst = nextRows[0]?.id ?? null;
  if (first !== nextFirst) {
    ownedIntakeProjectionWrite(db, { table: 'sources', operations: ['update'], key: id }, () =>
      db
        .prepare(`UPDATE ${table('sources')} SET identity_first=? WHERE source_id=?`)
        .run(nextFirst, id),
    );
    countWrite(connection, { id, identity_first: nextFirst });
    connection.counters.identityLinksWritten++;
  }
  for (const hash of retainedHere) obsolete.delete(hash);
  db.prepare('DELETE FROM temp.__intake_lookup_dirty WHERE source_id=?').run(id);
  return obsolete;
}
function current(db: DatabaseSync): Connection {
  if (!db.isOpen) {
    clearIntakeLookupCache(db);
    fail('closed');
  }
  if (protectedIntakeLookupTempShadow(db)) fail('protected lookup TEMP shadow');
  const authority = recordDurabilityStatus(db);
  if (authority?.dirty) {
    clearIntakeLookupCache(db);
    fail('accepted projection requires recovery');
  }
  const profile = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  if (typeof profile !== 'string' || !profile)
    throw Error('Intake lookup projection: profile binding');
  const connection = connections.get(db) ?? create(db);
  const cold = connection.schema === -1;
  if (tracking(db)) discardIntakeProjectionWitness(db);
  if (connection.schema !== schemaVersion(db)) {
    initialize(db, connection, profile);
    if (!cold) renewIntakeProjectionWitnessAfterIndexRepair(db);
  }
  const binding = db.prepare(`SELECT profile_id FROM ${table('state')} WHERE singleton=1`).get();
  if (binding?.profile_id !== profile) initialize(db, connection, profile);
  if (cold) ensureIntakeProjectionWitness(db);
  const inputVersion = projectionInputVersion(db);
  const witnessRevision = cold ? projectionWitnessRevision(db) : undefined;
  const reconciled = new Set<string>();
  db.exec('SAVEPOINT __intake_lookup_reconcile');
  try {
    if (cold) {
      // A lost/overflowed input witness needs a complete rebuild independent of
      // disposable dirty notifications, including projected rows whose source vanished.
      let after: string | undefined;
      for (;;) {
        const rows =
          after === undefined
            ? db
                .prepare(
                  `SELECT id AS source_id FROM main.source_files UNION SELECT source_id FROM main.${table('sources')} ORDER BY source_id LIMIT 64`,
                )
                .all()
            : db
                .prepare(
                  `SELECT id AS source_id FROM main.source_files WHERE id>? UNION SELECT source_id FROM main.${table('sources')} WHERE source_id>? ORDER BY source_id LIMIT 64`,
                )
                .all(after, after);
        if (!rows.length) break;
        for (const row of rows) {
          const id =
            typeof row.source_id === 'string'
              ? row.source_id
              : fail('invalid cold source identity');
          prune(db, connection, reconcile(db, connection, id));
        }
        after = String(rows.at(-1)!.source_id);
      }
    } else {
      while (true) {
        const row = db
          .prepare('SELECT source_id FROM temp.__intake_lookup_dirty ORDER BY source_id LIMIT 1')
          .get();
        if (!row) break;
        const id = String(row.source_id);
        prune(db, connection, reconcile(db, connection, id));
        reconciled.add(id);
      }
    }
    db.exec('RELEASE __intake_lookup_reconcile');
    if (!cold) acknowledgeProjectionInputs(db, inputVersion, reconciled);
  } catch (error) {
    try {
      db.exec('ROLLBACK TO __intake_lookup_reconcile; RELEASE __intake_lookup_reconcile');
    } catch {
      /* An aborted outer transaction is recovered by its owner. */
    }
    clearPayloadMemo(connection);
    connection.rebuild = true;
    connection.schema = -1;
    if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
    throw error;
  }
  if (db.isTransaction && !currentTransactionToken(db)) {
    clearPayloadMemo(connection);
    connection.schema = -1;
  }
  if (cold && connection.schema !== -1) sealIntakeProjectionWitness(db, witnessRevision, true);
  return connection;
}
export function reconcileActiveIntakeLookup(db: DatabaseSync): void {
  const connection = connections.get(db);
  if (connection && connection.schema !== -1 && currentTransactionToken(db)) current(db);
}
/** Complete the existing disposable projection before certifying a read-only
 * preparation. Its opaque lifetime changes on close, rollback or cache loss. */
export function prepareIntakeLookupProjection(db: DatabaseSync): object {
  return current(db).generation;
}
export function intakeLookupProjectionGeneration(db: DatabaseSync): object | undefined {
  return connections.get(db)?.generation;
}
interface NativeLookupCatalog {
  scratch: ReturnType<typeof disposableSqlite>;
  generation: object;
  attempt: object;
  unsafeMaximum: boolean;
  allOriginalsNative: boolean;
}
export interface AdvancedNativeLookupSource {
  sourceId: string;
  sourceOrder: number;
  sourceHash: string;
  authorityKey: string;
  logicalHead: string;
}
interface NativeReceiptAppend {
  catalog: NativeLookupCatalog & { token: object };
  generation: object;
  sourceId: string;
  sourceOrder: number;
  sourceHash: string;
  before: string;
  after: string;
  rows: readonly { operation: string; address: string }[];
  maximumAddress: string | null;
}
interface NativeReceiptAppendBasis extends Omit<
  NativeReceiptAppend,
  'after' | 'rows' | 'maximumAddress'
> {
  db: DatabaseSync;
}
const receiptAppendBases = new WeakMap<object, NativeReceiptAppendBasis>();
interface NativeLookupPointer {
  source_id: string;
  source_order: number;
  source_hash: string;
  authority_head: string;
  address: string;
}
export function discardNativeIntakeLookupCatalog(db: DatabaseSync): void {
  const connection = connections.get(db);
  connection?.nativeCatalog?.scratch.close();
  if (connection) {
    connection.nativeCatalog = undefined;
    connection.nativeReceiptAppend = undefined;
  }
}
/** An old token may only enter the changed-source transition from a complete native catalog. */
export function nativeIntakeLookupCatalogAllOriginalsNative(
  db: DatabaseSync,
  token: object,
): boolean {
  const connection = connections.get(db);
  return (
    connection?.nativeCatalog?.token === token &&
    connection.nativeCatalog.generation === connection.generation &&
    connection.nativeCatalog.allOriginalsNative &&
    !connection.nativeCatalog.unsafeMaximum
  );
}
/** Only a prior complete native catalog can prove a bounded head rewrite kept the same source digest. */
export function nativeIntakeLookupCatalogHeadBindingsEqual(
  db: DatabaseSync,
  token: object,
  sourceIds: readonly string[],
): boolean {
  if (!nativeIntakeLookupCatalogAllOriginalsNative(db, token) || sourceIds.length > 100)
    return false;
  const catalog = connections.get(db)?.nativeCatalog;
  if (!catalog) return false;
  const sourceRow = db.prepare(
    "SELECT rowid source_order,id,kind,sha256,details_json FROM main.source_files WHERE id=? AND kind='intake_original'",
  );
  const oldRow = catalog.scratch.db.prepare('SELECT * FROM sources WHERE source_id=?');
  for (const id of sourceIds) {
    const source = sourceRow.get(id) as
      (IntakeEnvelopeSource & { source_order: number }) | undefined;
    const prior = oldRow.get(id);
    if (
      !source ||
      !prior ||
      !Number.isSafeInteger(source.source_order) ||
      prior.source_order !== source.source_order ||
      prior.source_hash !== source.sha256
    )
      return false;
    const binding = intakeEnvelopeAuthorityBinding(db, source);
    if (typeof binding.key !== 'string' || binding.logicalHead !== prior.authority_head)
      return false;
  }
  return true;
}
/** The old complete source/index is checked before the owner starts its write. */
export function nativeIntakeReceiptAppendBasis(
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
  before: string,
): object | undefined {
  const connection = connections.get(db);
  const catalog = connection?.nativeCatalog;
  if (!connection || !catalog || typeof source.sha256 !== 'string') return undefined;
  const row = db
    .prepare('SELECT rowid source_order FROM source_files WHERE id=? AND kind=? AND sha256=?')
    .get(source.id, 'intake_original', source.sha256);
  if (!row || !Number.isSafeInteger(row.source_order)) return undefined;
  const prior = catalog.scratch.db
    .prepare('SELECT * FROM sources WHERE source_id=?')
    .get(source.id);
  if (
    !prior ||
    prior.source_order !== row.source_order ||
    prior.source_hash !== source.sha256 ||
    prior.authority_head !== before
  )
    return undefined;
  const { collections } = selectedEnvelopeStore(db, source);
  const selected = collections.openView();
  const complete =
    (collections.get(selected, 'builds', 'envelope.indexes', 'complete') === before &&
      collections.get(selected, 'builds', 'envelope.indexes', 'policy') ===
        'health-intake-workflow-index-v6') ||
    (collections.get(selected, 'builds', INTAKE_LOOKUP_INDEX_COLLECTION, 'complete') === before &&
      collections.get(selected, 'builds', INTAKE_LOOKUP_INDEX_COLLECTION, 'policy') ===
        INTAKE_LOOKUP_INDEX_POLICY);
  if (!complete) return undefined;
  const basis = {};
  receiptAppendBases.set(basis, {
    db,
    catalog,
    generation: connection.generation,
    sourceId: source.id,
    sourceOrder: Number(row.source_order),
    sourceHash: source.sha256,
    before,
  });
  return basis;
}
/** Retain only disposable per-source input, never a read token or answer. */
export function retainNativeIntakeReceiptAppend(
  db: Database,
  basis: object,
  proof: object,
  reader: IntakeCollectionEnvelopeReader,
  source: IntakeEnvelopeSource,
  before: string,
  after: string,
  outcomeToken?: object,
): void {
  retainNativeIntakeReceiptAppendBatch(
    db,
    [{ basis, proof, reader, source, before, after }],
    outcomeToken,
  );
}
export function retainNativeIntakeReceiptAppendBatch(
  db: Database,
  items: readonly {
    basis: object;
    proof: object;
    reader: IntakeCollectionEnvelopeReader;
    source: IntakeEnvelopeSource;
    before: string;
    after: string;
  }[],
  outcomeToken?: object,
): void {
  const connection = connections.get(db);
  if (!items.length || items.length > 100) {
    if (connection) {
      connection.nativeReceiptAppend = undefined;
      connection.catalogAttempt = undefined;
    }
    return;
  }
  const bases = items.map((item) => {
    const prior = receiptAppendBases.get(item.basis);
    receiptAppendBases.delete(item.basis);
    return prior;
  });
  if (!connection) return;
  connection.nativeReceiptAppend = undefined;
  connection.catalogAttempt = undefined;
  const members = new Map<string, NativeReceiptAppend>();
  let bytes = 0;
  for (const [index, item] of items.entries()) {
    const prior = bases[index];
    if (
      !prior ||
      prior.db !== db ||
      prior.generation !== connection.generation ||
      prior.catalog !== connection.nativeCatalog ||
      prior.sourceId !== item.source.id ||
      prior.sourceHash !== item.source.sha256 ||
      prior.before !== item.before ||
      members.has(item.source.id)
    )
      return;
    const contribution = consumeWorkflowReceiptAppendProof(
      item.proof,
      db,
      item.source,
      item.reader,
      item.before,
      item.after,
    );
    if (!contribution || contribution.rows.length > 64) return;
    const detached = contribution.rows.map(({ operation, address }) => ({ operation, address }));
    bytes +=
      Buffer.byteLength(item.source.id) +
      Buffer.byteLength(prior.sourceHash) +
      Buffer.byteLength(item.before) +
      Buffer.byteLength(item.after) +
      Buffer.byteLength(contribution.maximumAddress ?? '');
    for (const row of detached)
      bytes += Buffer.byteLength(row.operation) + Buffer.byteLength(row.address);
    if (bytes > 1024 * 1024) return;
    members.set(item.source.id, {
      catalog: prior.catalog,
      generation: prior.generation,
      sourceId: prior.sourceId,
      sourceOrder: prior.sourceOrder,
      sourceHash: prior.sourceHash,
      before: prior.before,
      after: item.after,
      rows: detached,
      maximumAddress: contribution.maximumAddress,
    });
  }
  if (
    !members.size ||
    members.size !== items.length ||
    [...members.values()].some(
      (member) =>
        member.catalog !== connection.nativeCatalog || member.generation !== connection.generation,
    )
  )
    return;
  connection.nativeReceiptAppend = { members, outcomeToken };
}

/** Advance one complete disposable catalog only from the final owned append outcome. */
export async function advanceNativeIntakeLookupCatalog(
  db: DatabaseSync,
  oldToken: object,
  nextToken: object,
  changedHeads: readonly string[],
  ordinaryToken: object | undefined,
  current: () => boolean,
  options: {
    assertRunning?: () => void;
    onCheckpoint?: (progress: { sourceId: string; visited: number }) => void | Promise<void>;
  },
): Promise<readonly AdvancedNativeLookupSource[] | undefined> {
  const connection = connections.get(db);
  const catalog = connection?.nativeCatalog;
  const batch = connection?.nativeReceiptAppend;
  if (connection) connection.nativeReceiptAppend = undefined;
  if (!connection || !catalog || catalog.token !== oldToken || catalog.unsafeMaximum) return;
  const members = batch?.members;
  if (
    (changedHeads.length > 0 && (!ordinaryToken || batch?.outcomeToken !== ordinaryToken)) ||
    (changedHeads.length === 0 && ordinaryToken !== undefined) ||
    changedHeads.length > 100 ||
    changedHeads.length !== (members?.size ?? 0) ||
    changedHeads.some((id) => !members?.has(id))
  )
    return;
  const scratch = catalog.scratch.db;
  const changed: AdvancedNativeLookupSource[] = [];
  const cast = db.prepare("SELECT CAST(json_extract(?,'$') AS INTEGER) n");
  cast.setReadBigInts(true);
  let units = 0;
  const checkpoint = () => {
    options.assertRunning?.();
    if (!current()) throw Error('Intake lookup frontier changed');
    return ++units % 64 === 0;
  };
  const cooperate = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    options.assertRunning?.();
    if (!current()) throw Error('Intake lookup frontier changed');
  };
  try {
    if (!current()) return;
    for (const member of [...(members?.values() ?? [])].sort(
      (a, b) => a.sourceOrder - b.sourceOrder,
    )) {
      if (checkpoint()) await cooperate();
      if (member.catalog !== catalog || member.generation !== connection.generation) return;
      const source = db
        .prepare(
          "SELECT rowid source_order,id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
        )
        .get(member.sourceId) as (IntakeEnvelopeSource & { source_order: number }) | undefined;
      if (
        !source ||
        !Number.isSafeInteger(source.source_order) ||
        source.source_order !== member.sourceOrder ||
        source.sha256 !== member.sourceHash
      )
        return;
      const binding = intakeEnvelopeAuthorityBinding(db, source);
      if (
        binding.logicalHead !== member.after ||
        typeof binding.key !== 'string' ||
        !hasIntakeCollectionEnvelope(db, source)
      )
        return;
      const prior = scratch.prepare('SELECT * FROM sources WHERE source_id=?').get(member.sourceId);
      if (
        !prior ||
        prior.source_order !== member.sourceOrder ||
        prior.source_hash !== member.sourceHash ||
        prior.authority_head !== member.before
      )
        return;
      const view = nativeReader(db, {
        ...source,
        source_order: member.sourceOrder,
        sha256: member.sourceHash,
        authority_head: member.after,
      });
      const maximum = readNativeIntakeLookupTarget(
        db,
        source,
        view,
        'lookup-discovery-maximum',
        [],
      );
      if ((maximum ? view.address(maximum) : null) !== member.maximumAddress)
        fail('native catalog discovery index differs from accepted contribution');
      let nextMaximum: bigint | null = null;
      let maximumAddress: string | undefined;
      if (maximum) {
        const text = boundedIntakeLookupText(view.fieldChunks(maximum, 'discoveryOrder'));
        nextMaximum = cast.get(text)!.n as bigint | null;
        if (
          nextMaximum !== null &&
          (nextMaximum < BigInt(Number.MIN_SAFE_INTEGER) ||
            nextMaximum > BigInt(Number.MAX_SAFE_INTEGER))
        )
          return;
        maximumAddress = view.address(maximum);
      }
      for (const item of member.rows) {
        if (checkpoint()) await cooperate();
        const selected = readNativeIntakeLookupTarget(
          db,
          source,
          view,
          'lookup-acceptance-operation-first',
          [item.operation],
        );
        const existing = scratch
          .prepare('SELECT address FROM acceptances WHERE operation=? AND source_id=?')
          .get(item.operation, member.sourceId);
        if (!selected || view.address(selected) !== (existing?.address ?? item.address)) return;
        connection.counters.nativeReceiptRowsWritten += Number(
          scratch
            .prepare('INSERT OR IGNORE INTO acceptances VALUES(?,?,?,?)')
            .run(item.operation, member.sourceId, member.sourceOrder, item.address).changes,
        );
      }
      scratch
        .prepare('UPDATE sources SET authority_head=? WHERE source_id=?')
        .run(member.after, member.sourceId);
      if (nextMaximum !== null && maximumAddress !== undefined)
        scratch
          .prepare(
            `INSERT INTO source_maxima VALUES(?,?,?,?,?,?)
            ON CONFLICT(source_id) DO UPDATE SET
            source_order=excluded.source_order,source_hash=excluded.source_hash,
            authority_head=excluded.authority_head,address=excluded.address,value=excluded.value`,
          )
          .run(
            member.sourceId,
            member.sourceOrder,
            member.sourceHash,
            member.after,
            maximumAddress,
            nextMaximum,
          );
      else scratch.prepare('DELETE FROM source_maxima WHERE source_id=?').run(member.sourceId);
      changed.push({
        sourceId: member.sourceId,
        sourceOrder: member.sourceOrder,
        sourceHash: member.sourceHash,
        authorityKey: binding.key,
        logicalHead: member.after,
      });
      if (options.onCheckpoint) {
        options.assertRunning?.();
        if (!current()) return;
        await options.onCheckpoint({ sourceId: member.sourceId, visited: member.rows.length });
        options.assertRunning?.();
        if (!current()) return;
      }
    }
    if (!current()) return;
    // The original complete catalog covers every unchanged contributor. The
    // ordered private index can select a runner-up without rereading originals.
    scratch.exec(`DELETE FROM maximum;
      INSERT INTO maximum SELECT 1,source_id,source_order,source_hash,authority_head,address,value
      FROM source_maxima ORDER BY value DESC,source_order ASC LIMIT 1;`);
    if (!current()) return;
    catalog.token = nextToken;
    return changed;
  } finally {
    if (catalog.token !== nextToken) discardNativeIntakeLookupCatalog(db);
  }
}
/** Read-only, checkpointed derivation. No incomplete catalog can answer a miss. */
export async function buildNativeIntakeLookupCatalog(
  db: DatabaseSync,
  frontierCurrent: () => boolean,
  options: {
    assertRunning?: () => void;
    onCheckpoint?: (progress: { sourceId: string; visited: number }) => void | Promise<void>;
  },
): Promise<NativeLookupCatalog | undefined> {
  const connection = connections.get(db);
  const generation = connection?.generation;
  if (!connection || !generation || !frontierCurrent()) return undefined;
  if (connections.get(db) !== connection || connection.generation !== generation) return undefined;
  const attempt = {};
  connection.catalogAttempt = attempt;
  const isCurrent = () =>
    frontierCurrent() &&
    connections.get(db) === connection &&
    connection.generation === generation &&
    connection.catalogAttempt === attempt;
  // An expired global certificate cannot answer queries. Its private per-source
  // derivations can still be reused after checking every current source binding.
  const previous = connection.nativeCatalog;
  const appendBatch = connection.nativeReceiptAppend;
  connection.nativeReceiptAppend = undefined;
  connection.nativeCatalog = undefined;
  const scratch = previous?.scratch ?? disposableSqlite('circus-intake-lookup-addresses-');
  const seenEpoch = randomUUID();
  let retained = false;
  const stopClose = observeDatabaseClose(db, () => scratch.close());
  try {
    scratch.db.exec(`
      CREATE TABLE IF NOT EXISTS sources(source_id TEXT PRIMARY KEY,source_order INTEGER,
        source_hash TEXT,authority_head TEXT,seen_epoch TEXT) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS acceptances(operation TEXT,source_id TEXT,source_order INTEGER,address TEXT,
        PRIMARY KEY(operation,source_id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS acceptance_order ON acceptances(operation,source_order);
      CREATE INDEX IF NOT EXISTS acceptance_source ON acceptances(source_id);
      CREATE TABLE IF NOT EXISTS maximum(singleton INTEGER PRIMARY KEY,source_id TEXT,source_order INTEGER,
        source_hash TEXT,authority_head TEXT,address TEXT,value INTEGER);
      CREATE TABLE IF NOT EXISTS source_maxima(source_id TEXT PRIMARY KEY,source_order INTEGER,
        source_hash TEXT,authority_head TEXT,address TEXT,value INTEGER) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS source_maxima_order ON source_maxima(value DESC,source_order ASC);
      DELETE FROM maximum;
    `);
    const put = scratch.db.prepare(`INSERT INTO acceptances VALUES(?,?,?,?)
      ON CONFLICT(operation,source_id) DO UPDATE SET
      source_order=excluded.source_order,address=excluded.address`);
    const putAppend = scratch.db.prepare('INSERT OR IGNORE INTO acceptances VALUES(?,?,?,?)');
    const putMaximum = scratch.db.prepare(`INSERT INTO maximum VALUES(1,?,?,?,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET source_id=excluded.source_id,
      source_order=excluded.source_order,source_hash=excluded.source_hash,
      authority_head=excluded.authority_head,address=excluded.address,value=excluded.value
      WHERE excluded.value>maximum.value`);
    const putSourceMaximum = scratch.db.prepare(`INSERT INTO source_maxima VALUES(?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET source_order=excluded.source_order,
      source_hash=excluded.source_hash,authority_head=excluded.authority_head,
      address=excluded.address,value=excluded.value`);
    const cast = db.prepare("SELECT CAST(json_extract(?,'$') AS INTEGER) n");
    cast.setReadBigInts(true);
    const checkpoint = async (sourceId: string, visited: number) => {
      await options.onCheckpoint?.({ sourceId, visited });
      await new Promise<void>((resolve) => setImmediate(resolve));
      options.assertRunning?.();
      return isCurrent();
    };
    const removeReceipts = async (sourceId: string) => {
      while (true) {
        const batch = scratch.db
          .prepare('SELECT operation FROM acceptances WHERE source_id=? LIMIT 64')
          .all(sourceId);
        if (!batch.length) return true;
        for (const row of batch)
          scratch.db
            .prepare('DELETE FROM acceptances WHERE operation=? AND source_id=?')
            .run(row.operation!, sourceId);
        if (!(await checkpoint(sourceId, 0))) return false;
      }
    };
    let unsafeMaximum = false;
    let allOriginalsNative = true;
    for (const row of originalSourceRows(db)) {
      options.assertRunning?.();
      if (!isCurrent()) return undefined;
      const source = checkedNativeSource(db, row);
      if (!source) {
        allOriginalsNative = false;
        if (!(await checkpoint(String(row.id), 0))) return undefined;
        continue;
      }
      const view = nativeReader(db, source);
      const group = readNativeIntakeLookupTarget(db, source, view, 'lookup-discovery-maximum', []);
      const prior = scratch.db.prepare('SELECT * FROM sources WHERE source_id=?').get(source.id);
      const reuse =
        prior?.source_order === source.source_order &&
        prior.source_hash === source.sha256 &&
        prior.authority_head === source.authority_head;
      const append = appendBatch?.members.get(source.id);
      let reuseAppend =
        !reuse &&
        !!append &&
        append.catalog === previous &&
        append.generation === generation &&
        append.sourceId === source.id &&
        append.sourceOrder === source.source_order &&
        append.sourceHash === source.sha256 &&
        append.before === prior?.authority_head &&
        append.after === source.authority_head &&
        prior?.source_order === source.source_order &&
        prior.source_hash === source.sha256;
      let expectedMaximum: string | null = null;
      if (reuse) {
        expectedMaximum =
          (scratch.db.prepare('SELECT address FROM source_maxima WHERE source_id=?').get(source.id)
            ?.address as string | undefined) ?? null;
      } else if (reuseAppend && append) expectedMaximum = append.maximumAddress;
      else {
        for (const contribution of intakeLookupContributions(db, view, 'discovery')) {
          if ('checkpoint' in contribution) {
            if (!(await checkpoint(source.id, 0))) return undefined;
          } else expectedMaximum = contribution.target ? view.address(contribution.target) : null;
        }
      }
      if ((group ? view.address(group) : null) !== expectedMaximum)
        fail('native catalog discovery index is incomplete or changed');
      if (reuseAppend && append) {
        for (const item of append.rows) {
          const selected = readNativeIntakeLookupTarget(
            db,
            source,
            view,
            'lookup-acceptance-operation-first',
            [item.operation],
          );
          const existing = scratch.db
            .prepare('SELECT address FROM acceptances WHERE operation=? AND source_id=?')
            .get(item.operation, source.id);
          if (!selected || view.address(selected) !== (existing?.address ?? item.address)) {
            reuseAppend = false;
            break;
          }
        }
      }
      scratch.db.prepare('DELETE FROM source_maxima WHERE source_id=?').run(source.id);
      if (group) {
        const text = boundedIntakeLookupText(view.fieldChunks(group, 'discoveryOrder'));
        const value = cast.get(text)!.n as bigint | null;
        if (value !== null) {
          // Preserve the synchronous getter's refusal for any unsafe contributor,
          // including a negative value that would not win the global maximum.
          unsafeMaximum ||=
            value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER);
          putMaximum.run(
            source.id,
            source.source_order,
            source.sha256,
            source.authority_head,
            view.address(group),
            value,
          );
          putSourceMaximum.run(
            source.id,
            source.source_order,
            source.sha256,
            source.authority_head,
            view.address(group),
            value,
          );
        }
      }
      let visited = 0;
      if (reuseAppend && append) {
        for (const item of append.rows) {
          connection.counters.nativeReceiptRowsWritten += Number(
            putAppend.run(item.operation, source.id, source.source_order, item.address).changes,
          );
        }
        visited = append.rows.length;
        scratch.db
          .prepare('UPDATE sources SET authority_head=?,seen_epoch=? WHERE source_id=?')
          .run(source.authority_head, seenEpoch, source.id);
      } else if (!reuse) {
        if (!(await removeReceipts(source.id))) return undefined;
        for (const contribution of intakeLookupContributions(db, view, 'acceptances')) {
          options.assertRunning?.();
          if ('checkpoint' in contribution) {
            if (!(await checkpoint(source.id, visited))) return undefined;
            continue;
          }
          if (contribution.target)
            connection.counters.nativeReceiptRowsWritten += Number(
              put.run(
                contribution.key[0]!,
                source.id,
                source.source_order,
                view.address(contribution.target),
              ).changes,
            );
          visited++;
        }
        scratch.db
          .prepare(
            `INSERT INTO sources VALUES(?,?,?,?,?) ON CONFLICT(source_id)
        DO UPDATE SET source_order=excluded.source_order,source_hash=excluded.source_hash,
        authority_head=excluded.authority_head,seen_epoch=excluded.seen_epoch`,
          )
          .run(source.id, source.source_order, source.sha256, source.authority_head, seenEpoch);
      } else
        scratch.db
          .prepare('UPDATE sources SET seen_epoch=? WHERE source_id=?')
          .run(seenEpoch, source.id);
      if (!(await checkpoint(source.id, visited))) return undefined;
    }
    if (!isCurrent()) return undefined;
    let cursor: string | undefined;
    while (true) {
      const batch =
        cursor === undefined
          ? scratch.db
              .prepare('SELECT source_id,seen_epoch FROM sources ORDER BY source_id LIMIT 64')
              .all()
          : scratch.db
              .prepare(
                'SELECT source_id,seen_epoch FROM sources WHERE source_id>? ORDER BY source_id LIMIT 64',
              )
              .all(cursor);
      if (!batch.length) break;
      for (const row of batch) {
        if (row.seen_epoch === seenEpoch) continue;
        if (!(await removeReceipts(String(row.source_id)))) return undefined;
        scratch.db.prepare('DELETE FROM source_maxima WHERE source_id=?').run(row.source_id!);
        scratch.db.prepare('DELETE FROM sources WHERE source_id=?').run(row.source_id!);
      }
      cursor = String(batch[batch.length - 1]!.source_id);
      if (!(await checkpoint(cursor, 0))) return undefined;
    }
    retained = true;
    return { scratch, generation, attempt, unsafeMaximum, allOriginalsNative };
  } finally {
    stopClose();
    if (!retained) scratch.close();
  }
}
export function retainNativeIntakeLookupCatalog(
  db: DatabaseSync,
  catalog: NativeLookupCatalog,
  token: object,
): boolean {
  const connection = connections.get(db);
  if (
    connection?.generation !== catalog.generation ||
    connection.catalogAttempt !== catalog.attempt
  ) {
    catalog.scratch.close();
    return false;
  }
  discardNativeIntakeLookupCatalog(db);
  connection.nativeCatalog = { ...catalog, token };
  return true;
}
function checkedNativeCatalog(db: DatabaseSync, connection: Connection) {
  const catalog = connection.nativeCatalog;
  if (!catalog) return undefined;
  if (catalog.token === preparedIntakeLookupReadToken(db)) return catalog;
  return undefined;
}
function assertNativeCatalogCurrent(db: DatabaseSync, catalog: { token: object }): void {
  if (catalog.token !== preparedIntakeLookupReadToken(db)) {
    discardNativeIntakeLookupCatalog(db);
    fail('native catalog frontier changed');
  }
}
function catalogTarget(
  db: DatabaseSync,
  pointer: NativeLookupPointer,
  index: string,
  key: readonly string[],
) {
  const source = db
    .prepare(
      'SELECT id,kind,sha256,details_json,rowid source_order FROM main.source_files WHERE id=?',
    )
    .get(pointer.source_id);
  const binding = source
    ? intakeEnvelopeAuthorityBinding(db, source as unknown as IntakeEnvelopeSource)
    : undefined;
  const selected =
    source && binding?.logicalHead !== undefined
      ? ({ ...source, authority_head: binding.logicalHead } as unknown as NativeSource)
      : undefined;
  if (
    !selected ||
    selected.kind !== 'intake_original' ||
    selected.source_order !== pointer.source_order ||
    selected.sha256 !== pointer.source_hash ||
    selected.authority_head !== pointer.authority_head
  )
    return fail('native catalog source binding changed');
  const view = nativeReader(db, selected);
  const record = readNativeIntakeLookupTarget(db, selected, view, index, key);
  if (!record || view.address(record) !== pointer.address)
    return fail('native catalog target changed');
  return { view, record };
}
export function maximumIntakeDiscoveryOrder(db: DatabaseSync): number {
  const retained = connections.get(db);
  const direct = retained ? checkedNativeCatalog(db, retained) : undefined;
  const connection =
    retained && direct?.allOriginalsNative && !direct.unsafeMaximum ? retained : current(db);
  const catalog =
    direct?.allOriginalsNative && !direct.unsafeMaximum
      ? direct
      : checkedNativeCatalog(db, connection);
  if (catalog?.allOriginalsNative && !catalog.unsafeMaximum) {
    const pointer = catalog.scratch.db.prepare('SELECT * FROM maximum WHERE singleton=1').get();
    if (!pointer) {
      assertNativeCatalogCurrent(db, catalog);
      return 0;
    }
    const { view, record } = catalogTarget(
      db,
      pointer as unknown as NativeLookupPointer,
      'lookup-discovery-maximum',
      [],
    );
    const text = boundedIntakeLookupText(view.fieldChunks(record, 'discoveryOrder'));
    const value = db.prepare("SELECT CAST(json_extract(?,'$') AS INTEGER) n").get(text)!.n;
    if (value !== pointer.value) return fail('native catalog discovery value changed');
    assertNativeCatalogCurrent(db, catalog);
    return Number(value || 0);
  }
  refreshLegacyProjection(db, connection);
  const answerWitness = projectionAnswerWitness(db);
  let nativeMaximum: number | null = null;
  let allOriginalsNative = true;
  for (const row of actualOriginalSourceRows(db)) {
    const source = actualNativeSource(db, row);
    if (!source) {
      allOriginalsNative = false;
      continue;
    }
    const view = nativeReader(db, source);
    const group = readNativeIntakeLookupTarget(db, source, view, 'lookup-discovery-maximum', []);
    if (!group) {
      // The synchronous compatibility path has no complete private catalog.
      // An index miss must agree with source evidence before answering empty.
      for (const contribution of intakeLookupContributions(db, view, 'discovery'))
        if (!('checkpoint' in contribution) && contribution.target)
          fail('native catalog discovery index is incomplete or changed');
      continue;
    }
    const text = boundedIntakeLookupText(view.fieldChunks(group, 'discoveryOrder'));
    const value = db.prepare("SELECT CAST(json_extract(?,'$') AS INTEGER) n").get(text)!.n;
    if (value !== null && (nativeMaximum === null || Number(value) > nativeMaximum))
      nativeMaximum = Number(value);
  }
  if (allOriginalsNative) {
    assertProjectionAnswerWitness(db, answerWitness);
    return nativeMaximum ?? 0;
  }
  let maximum = db
    .prepare(
      `SELECT MAX(g.discovery_order) n FROM ${table('groups')} g JOIN ${table('sources')} s ON s.source_id=g.source_id JOIN main.source_files f ON f.id=s.source_id WHERE f.kind='intake_original' AND (s.identity_first IS NULL OR s.identity_first<>-1)`,
    )
    .get()!.n;
  if (nativeMaximum !== null && (maximum === null || nativeMaximum > Number(maximum)))
    maximum = nativeMaximum;
  assertProjectionAnswerWitness(db, answerWitness);
  return Number(maximum || 0);
}
const receiptSelectionGuards = new WeakMap<IntakeLookupReceiptReference, () => void>();
function guardedReceiptReference(
  reference: IntakeLookupReceiptReference,
  assertCurrent: () => void,
): IntakeLookupReceiptReference {
  receiptSelectionGuards.set(reference, assertCurrent);
  return reference;
}
export function retainedIntakeAcceptance(db: DatabaseSync, operationId: string): unknown {
  const reference = retainedIntakeAcceptanceReference(db, operationId);
  if (!reference) return null;
  const value =
    reference.mode === 'legacy'
      ? reference.value
      : JSON.parse(boundedIntakeLookupText(reference.view.recordChunks(reference.record)));
  // The selected source may stay current while another original becomes first.
  // Keep the original global selection proof through callback-capable hydration.
  receiptSelectionGuards.get(reference)!();
  return value;
}
/** Point-selected receipt capability for consumers that cannot hydrate its targets. */
export function retainedIntakeAcceptanceReference(
  db: DatabaseSync,
  operationId: string,
): IntakeLookupReceiptReference | null {
  const retained = connections.get(db);
  const direct = retained ? checkedNativeCatalog(db, retained) : undefined;
  const connection = retained && direct?.allOriginalsNative ? retained : current(db);
  const catalog = direct?.allOriginalsNative ? direct : checkedNativeCatalog(db, connection);
  const nativeOperation = Buffer.from(operationId, 'utf8').toString('hex').toUpperCase();
  if (catalog?.allOriginalsNative) {
    const pointer = catalog.scratch.db
      .prepare(
        `SELECT a.operation,a.address,s.source_id,s.source_order,s.source_hash,
        s.authority_head FROM acceptances a JOIN sources s ON s.source_id=a.source_id
        WHERE a.operation=? AND a.source_order=s.source_order ORDER BY a.source_order LIMIT 1`,
      )
      .get(nativeOperation);
    if (!pointer) {
      assertNativeCatalogCurrent(db, catalog);
      return null;
    }
    const { view, record } = catalogTarget(
      db,
      pointer as unknown as NativeLookupPointer,
      'lookup-acceptance-operation-first',
      [nativeOperation],
    );
    assertNativeCatalogCurrent(db, catalog);
    return guardedReceiptReference(
      { mode: 'native', sourceId: String(pointer.source_id), view, record },
      () => assertNativeCatalogCurrent(db, catalog),
    );
  }
  refreshLegacyProjection(db, connection);
  const answerWitness = projectionAnswerWitness(db);
  let native: IntakeLookupReceiptReference | null = null;
  let nativeOrder = Infinity;
  let allOriginalsNative = true;
  for (const row of actualOriginalSourceRows(db)) {
    const source = actualNativeSource(db, row);
    if (!source) {
      allOriginalsNative = false;
      continue;
    }
    const view = nativeReader(db, source);
    const record = readNativeIntakeLookupTarget(
      db,
      source,
      view,
      'lookup-acceptance-operation-first',
      [nativeOperation],
    );
    if (record && Number(source.source_order) < nativeOrder) {
      native = { mode: 'native', sourceId: String(source.id), view, record };
      nativeOrder = Number(source.source_order);
    }
  }
  if (allOriginalsNative) {
    assertProjectionAnswerWitness(db, answerWitness);
    return (
      native &&
      guardedReceiptReference(native, () => assertProjectionAnswerWitness(db, answerWitness))
    );
  }
  const row = db
    .prepare(
      `SELECT p.payload,s.source_id,s.source_order FROM ${table('acceptances')} a JOIN ${table('payloads')} p ON p.hash=a.hash JOIN ${table('sources')} s ON s.source_id=a.source_id JOIN main.source_files f ON f.id=s.source_id WHERE a.operation_id=? AND f.kind='intake_original' AND (s.identity_first IS NULL OR s.identity_first<>-1) ORDER BY s.source_order LIMIT 1`,
    )
    .get(operationId);
  let selected: IntakeLookupReceiptReference | null = row
    ? { mode: 'legacy', sourceId: String(row.source_id), value: JSON.parse(String(row.payload)) }
    : null;
  if (native && nativeOrder < (row ? Number(row.source_order) : Infinity)) selected = native;
  assertProjectionAnswerWitness(db, answerWitness);
  return (
    selected &&
    guardedReceiptReference(selected, () => assertProjectionAnswerWitness(db, answerWitness))
  );
}
type NativeSource = IntakeEnvelopeSource & {
  source_order: number;
  authority_head: string;
  sha256: string;
};
function originalSourceRows(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT f.id,f.kind,f.sha256,f.details_json,f.rowid source_order,s.authority_head,s.identity_first FROM source_files f LEFT JOIN ${table('sources')} s ON s.source_id=f.id WHERE f.kind='intake_original' ORDER BY f.rowid`,
    )
    .iterate();
}
function actualOriginalSourceRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT id,kind,sha256,details_json,rowid source_order FROM main.source_files WHERE kind='intake_original' ORDER BY rowid",
    )
    .iterate();
}
function actualSourceIds(db: DatabaseSync) {
  return db.prepare('SELECT id FROM main.source_files ORDER BY rowid').iterate();
}
function actualNativeSource(
  db: DatabaseSync,
  row: Record<string, unknown>,
): NativeSource | undefined {
  const source = row as unknown as NativeSource;
  const binding = intakeEnvelopeAuthorityBinding(db, source);
  if (binding.logicalHead === undefined || !hasIntakeCollectionEnvelope(db, source))
    return undefined;
  assertProjectedNativeBinding(db, source, binding.logicalHead);
  return { ...source, authority_head: binding.logicalHead };
}
function assertProjectedNativeBinding(
  db: DatabaseSync,
  source: NativeSource,
  logicalHead: string,
): void {
  const projected = db
    .prepare(
      `SELECT source_order,identity_first,authority_head FROM ${table('sources')} WHERE source_id=?`,
    )
    .get(source.id);
  if (
    !projected ||
    projected.source_order !== source.source_order ||
    projected.identity_first !== -1 ||
    projected.authority_head !== logicalHead
  )
    return fail('native source projection binding is unavailable');
}
function refreshLegacyProjection(db: DatabaseSync, connection: Connection): void {
  ensureIntakeProjectionWitness(db);
  if (intakeProjectionWitnessCurrent(db)) return;
  if (projectionWitnessHasForeignMutation(db))
    fail('invalid identity occurrence chain or disposable projection mutation');
  const witnessRevision = projectionWitnessRevision(db);
  db.exec('SAVEPOINT __intake_lookup_legacy_read');
  try {
    for (const row of actualSourceIds(db))
      prune(db, connection, reconcile(db, connection, String(row.id)));
    let after: string | null = null;
    const orphanPage = db.prepare(
      `SELECT s.source_id FROM ${table('sources')} s
       WHERE (? IS NULL OR s.source_id>?)
         AND NOT EXISTS(SELECT 1 FROM main.source_files f WHERE f.id=s.source_id)
       ORDER BY s.source_id LIMIT 64`,
    );
    while (true) {
      const rows: Array<Record<string, unknown>> = orphanPage.all(after, after);
      if (rows.length === 0) break;
      for (const row of rows)
        prune(db, connection, reconcile(db, connection, String(row.source_id)));
      after = String(rows[rows.length - 1]!.source_id);
    }
    db.exec('RELEASE __intake_lookup_legacy_read');
    // Every current source and every projected source no longer present was replayed.
    sealIntakeProjectionWitness(db, witnessRevision, true);
  } catch (error) {
    discardIntakeProjectionWitness(db);
    try {
      db.exec('ROLLBACK TO __intake_lookup_legacy_read; RELEASE __intake_lookup_legacy_read');
    } catch {
      /* The transaction owner handles a failed rollback. */
    }
    connection.rebuild = true;
    connection.schema = -1;
    if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
    throw error;
  }
}
function checkedNativeSource(
  db: DatabaseSync,
  source: Record<string, unknown>,
): NativeSource | undefined {
  const selected = source as unknown as NativeSource;
  const binding = intakeEnvelopeAuthorityBinding(db, selected);
  if (!hasIntakeCollectionEnvelope(db, selected)) return undefined;
  if (source.identity_first !== -1 || source.authority_head !== binding.logicalHead)
    return fail('native source projection binding is unavailable');
  return selected;
}
function nativeReader(db: DatabaseSync, source: NativeSource): IntakeCollectionEnvelopeReader {
  if (intakeEnvelopeAuthorityBinding(db, source).logicalHead !== source.authority_head)
    return fail('native logical binding changed');
  const view = openIntakeCollectionEnvelope(db, source, { fieldSelection: 'first' });
  // The legacy adapter validated the JS-last operational contribution shapes
  // before issuing SQL-first extraction. Keep that independent validation;
  // it reads three descriptors and never visits the collection contents.
  const operational = view.subtree(view.root(), { fieldSelection: 'last' });
  const intake = operational.child(operational.root(), 'intake');
  if (!intake) return fail('original metadata is unavailable');
  const workflow = operational.child(intake, 'workflow');
  if (!workflow) {
    if (operational.has(intake, 'workflow')) return fail('malformed workflow');
    return view;
  }
  for (const name of ['reportGroups', 'reportAcceptances', 'identityConfirmations']) {
    const collection = operational.child(workflow, name);
    if (collection) {
      if (operational.info(collection).shape !== 'array')
        return fail('malformed contribution array');
    } else {
      const value = operational.field(workflow, name, { bytes: INTAKE_LOOKUP_SCOPE_BYTES });
      if (value.kind !== 'missing' && !(value.kind === 'value' && value.value == null))
        return fail('malformed contribution array');
    }
  }
  return view;
}
export type IntakeLookupReceiptReference =
  | { mode: 'legacy'; sourceId: string; value: unknown }
  | {
      mode: 'native';
      sourceId: string;
      view: IntakeCollectionEnvelopeReader;
      record: IntakeEnvelopeRecord;
    };
export type IntakeIdentityReference = IntakeLookupReceiptReference;
/** Ordered checked references. No global receipt array or native payload cache. */
export function* iterateIntakeIdentityReferences(
  db: DatabaseSync,
): Generator<IntakeIdentityReference> {
  const connection = current(db);
  refreshLegacyProjection(db, connection);
  const answerWitness = projectionAnswerWitness(db);
  for (const source of db
    .prepare(
      `SELECT f.id source_id,f.kind,f.sha256,f.details_json,f.rowid source_order,s.authority_head,s.identity_first FROM source_files f LEFT JOIN ${table('sources')} s ON s.source_id=f.id ORDER BY f.rowid`,
    )
    .iterate()) {
    assertProjectionAnswerWitness(db, answerWitness);
    const selected = { ...source, id: String(source.source_id) } as unknown as NativeSource;
    const logicalHead = intakeEnvelopeAuthorityBinding(db, selected).logicalHead;
    if (logicalHead !== undefined && hasIntakeCollectionEnvelope(db, selected)) {
      if (source.identity_first !== -1 || source.authority_head !== logicalHead)
        return fail('native source projection binding is unavailable');
      const view = nativeReader(db, selected);
      // Completeness is required even for an empty selected receipt collection.
      readNativeIntakeLookupTarget(db, selected, view, 'lookup-discovery-maximum', []);
      const intake = view.child(view.root(), 'intake');
      const workflow = intake && view.child(intake, 'workflow');
      const total = workflow ? view.childCount(workflow, 'identityConfirmations') : 0;
      for (let ordinal = 0; ordinal < total; ordinal++) {
        const record = readNativeIntakeLookupTarget(db, selected, view, 'lookup-identity-order', [
          String(ordinal),
        ]);
        if (!record) return fail('native identity index occurrence missing');
        assertProjectionAnswerWitness(db, answerWitness);
        yield { mode: 'native', sourceId: String(source.source_id), view, record };
        assertProjectionAnswerWitness(db, answerWitness);
      }
      view.address(view.root());
    } else {
      // Legacy chain traversal is bounded in retained reader memory; validate
      // cardinality rather than retaining all links to detect cycles/orphans.
      const total = Number(
        db
          .prepare(`SELECT COUNT(*) n FROM ${table('identities')} WHERE source_id=?`)
          .get(source.source_id!)!.n,
      );
      let next = source.identity_first;
      for (let ordinal = 0; ordinal < total; ordinal++) {
        if (!Number.isSafeInteger(next)) return fail('invalid identity occurrence chain');
        const row = db
          .prepare(
            `SELECT i.next,p.payload FROM ${table('identities')} i LEFT JOIN ${table('payloads')} p ON p.hash=i.hash WHERE i.source_id=? AND i.id=?`,
          )
          .get(source.source_id!, next!);
        if (!row || typeof row.payload !== 'string')
          return fail('invalid identity occurrence chain');
        const value = json(row.payload);
        assertProjectionAnswerWitness(db, answerWitness);
        yield { mode: 'legacy', sourceId: String(source.source_id), value };
        assertProjectionAnswerWitness(db, answerWitness);
        next = row.next;
      }
      if (next !== null) return fail('invalid identity occurrence chain');
    }
  }
  assertProjectionAnswerWitness(db, answerWitness);
}
/** Explicit small-scope compatibility decode. Large native receipts use refs. */
export function readIntakeIdentityReference(reference: IntakeIdentityReference): unknown {
  if (reference.mode === 'legacy') return reference.value;
  const value = JSON.parse(boundedIntakeLookupText(reference.view.recordChunks(reference.record)));
  // json_each transports booleans as INTEGER and strings as unquoted TEXT;
  // the historical json() consumer then parses that transported value again.
  return reference.view.info(reference.record).shape === 'scalar'
    ? json(typeof value === 'boolean' ? Number(value) : value)
    : value;
}
export function indexedIntakeIdentityConfirmations(db: DatabaseSync): unknown[] {
  const connection = current(db);
  refreshLegacyProjection(db, connection);
  const answerWitness = projectionAnswerWitness(db);
  const native = !!db
    .prepare(`SELECT 1 FROM ${table('sources')} WHERE identity_first=-1 LIMIT 1`)
    .get();
  assertProjectionAnswerWitness(db, answerWitness);
  const values: unknown[] = [];
  let bytes = 2;
  for (const reference of iterateIntakeIdentityReferences(db)) {
    const value = readIntakeIdentityReference(reference);
    if (native) {
      bytes += Buffer.byteLength(JSON.stringify(value)) + 1;
      if (bytes > INTAKE_LOOKUP_SCOPE_BYTES)
        return fail('identity ledger requires addressed consumption');
    }
    values.push(value);
  }
  assertProjectionAnswerWitness(db, answerWitness);
  return values;
}
