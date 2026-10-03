import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  json,
  observeTransactionOutcome,
  currentTransactionToken,
  rejectCurrentTransaction,
} from './database.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import {
  intakeEnvelopeAuthorityBinding,
  readIntakeEnvelopeText,
  type IntakeEnvelopeSource,
} from './intake-authority.ts';

const PREFIX = '__record_intake_lookup_';
const VERSION = 1;
const tables = {
  state: 'singleton,format,profile_id',
  sources: 'source_id,source_order,kind,authority_key,authority_head',
  groups: 'source_id,ordinal,discovery_order',
  acceptances: 'source_id,ordinal,operation_id,hash',
  identities: 'source_id,ordinal,hash',
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
  cleanupQueries: number;
  projectionWrites: number;
  projectionBytes: number;
}
interface Connection {
  dispose: () => void;
  rebuild: boolean;
  schema: number;
  counters: IntakeLookupCounters;
}
const connections = new WeakMap<DatabaseSync, Connection>();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const table = (name: keyof typeof tables) => PREFIX + name;
const fail = (reason: string): never => {
  throw Error(`Intake lookup projection: ${reason}`);
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function create(db: DatabaseSync): Connection {
  const connection: Connection = {
    dispose: () => {},
    rebuild: false,
    schema: -1,
    counters: {
      builds: 0,
      reconciledSources: 0,
      authorityReads: 0,
      authorityBytes: 0,
      projectionRowsRead: 0,
      projectionReadBytes: 0,
      hashedPayloadBytes: 0,
      cleanupQueries: 0,
      projectionWrites: 0,
      projectionBytes: 0,
    },
  };
  connection.dispose = observeTransactionOutcome(db, (outcome) => {
    if (!outcome.succeeded) connection.schema = -1;
  });
  connections.set(db, connection);
  return connection;
}
export function intakeLookupCounters(db: DatabaseSync): IntakeLookupCounters {
  return (connections.get(db) ?? create(db)).counters;
}
/** Counters describe logical changed-row payload bytes, not physical SQLite writes. */
/** Remove decrypted connection state; TEMP tracking is recreated safely on next use. */
export function clearIntakeLookupCache(db: DatabaseSync): void {
  connections.get(db)?.dispose();
  connections.delete(db);
}
function schemaVersion(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA schema_version').get()!.schema_version);
}
function tracking(db: DatabaseSync): void {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS __intake_lookup_dirty(source_id TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS __intake_lookup_authorities(authority_key TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE);
    CREATE TEMP TRIGGER IF NOT EXISTS __intake_lookup_insert AFTER INSERT ON main.source_files BEGIN
      INSERT OR IGNORE INTO __intake_lookup_dirty VALUES(NEW.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS __intake_lookup_update AFTER UPDATE ON main.source_files BEGIN
      INSERT OR IGNORE INTO __intake_lookup_dirty VALUES(OLD.id);
      INSERT OR IGNORE INTO __intake_lookup_dirty VALUES(NEW.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS __intake_lookup_delete AFTER DELETE ON main.source_files BEGIN
      INSERT OR IGNORE INTO __intake_lookup_dirty VALUES(OLD.id); END;`);
}
function initialize(db: DatabaseSync, connection: Connection, profile: string): void {
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
          ? [1, 0, 0, 0, 0]
          : name === 'payloads'
            ? [1, 0]
            : name === 'groups' || name === 'identities'
              ? [1, 2, 0]
              : [1, 2, 0, 0];
    valid &&= info.every(
      (column, index) =>
        Number(column.pk) === expectedPk[index] &&
        column.type ===
          (['singleton', 'format', 'source_order', 'ordinal', 'discovery_order'].includes(
            String(column.name),
          )
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
              ? [0, 1, 2]
              : [0, 1, 3];
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
    for (const name of Object.keys(tables) as Array<keyof typeof tables>)
      db.exec(`DROP TABLE IF EXISTS ${table(name)}`);
    db.exec(`CREATE TABLE ${table('state')}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format INTEGER NOT NULL,profile_id TEXT NOT NULL);
      CREATE TABLE ${table('sources')}(source_id TEXT PRIMARY KEY,source_order INTEGER NOT NULL,kind TEXT NOT NULL,authority_key TEXT,authority_head TEXT);
      CREATE TABLE ${table('groups')}(source_id TEXT NOT NULL,ordinal INTEGER NOT NULL,discovery_order INTEGER,PRIMARY KEY(source_id,ordinal));
      CREATE INDEX ${PREFIX}discovery ON ${table('groups')}(discovery_order DESC);
      CREATE TABLE ${table('acceptances')}(source_id TEXT NOT NULL,ordinal INTEGER NOT NULL,operation_id TEXT,hash TEXT NOT NULL,PRIMARY KEY(source_id,ordinal));
      CREATE INDEX ${PREFIX}operation ON ${table('acceptances')}(operation_id);
      CREATE TABLE ${table('identities')}(source_id TEXT NOT NULL,ordinal INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(source_id,ordinal));
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
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS __intake_lookup_authority_${op} AFTER ${op} ON main.app_meta BEGIN ${refs.map((ref) => `INSERT INTO __intake_lookup_dirty SELECT source_id FROM __intake_lookup_authorities a WHERE authority_key=${ref}.key AND NOT EXISTS(SELECT 1 FROM __intake_lookup_dirty d WHERE d.source_id=a.source_id);`).join(' ')} END`,
    );
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
      const result = db.prepare(`DELETE FROM ${table('payloads')} WHERE hash=?`).run(hash);
      if (result.changes) countWrite(connection, { hash, deleted: true });
    }
  }
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
      const result = db.prepare(`DELETE FROM ${table(name)} WHERE source_id=?`).run(id);
      connection.counters.projectionWrites += Number(result.changes);
    }
    db.prepare('DELETE FROM temp.__intake_lookup_dirty WHERE source_id=?').run(id);
    return obsolete;
  }
  const selected = source as unknown as IntakeEnvelopeSource;
  const binding = intakeEnvelopeAuthorityBinding(db, selected);
  const raw =
    source.kind === 'intake_original'
      ? readIntakeEnvelopeText(db, selected)
      : String(source.details_json);
  connection.counters.authorityBytes += Buffer.byteLength(raw);
  const validJson = Number(db.prepare('SELECT json_valid(?) valid').get(raw)!.valid) === 1;
  const all = json(raw);
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
    db.prepare(
      `INSERT INTO ${table('sources')} VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET source_order=excluded.source_order,kind=excluded.kind,authority_key=excluded.authority_key,authority_head=excluded.authority_head`,
    ).run(id, source.source_order!, source.kind!, binding.key, binding.head);
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
  const fields = {
    groups: 'reportGroups',
    acceptances: 'reportAcceptances',
    identities: 'identityConfirmations',
  } as const;
  for (const name of Object.keys(fields) as Array<keyof typeof fields>) {
    const originalOnly = name !== 'identities';
    const path = '$.intake.workflow.' + fields[name];
    const entries =
      !validJson || (originalOnly && source.kind !== 'intake_original')
        ? []
        : db
            .prepare(
              `SELECT j.key AS ordinal,j.value AS payload,${name === 'groups' ? "CAST(json_extract(j.value,'$.discoveryOrder') AS INTEGER)" : 'NULL'} AS discovery_order,${name === 'acceptances' ? "json_extract(j.value,'$.receipt.operationId')" : 'NULL'} AS operation_id FROM json_each(?,?) j`,
            )
            .all(raw, path);
    const oldRows = db
      .prepare(
        `SELECT ordinal,${name === 'groups' ? 'discovery_order' : name === 'acceptances' ? 'hash,operation_id' : 'hash'} FROM ${table(name)} WHERE source_id=?`,
      )
      .all(id);
    connection.counters.projectionRowsRead += oldRows.length;
    connection.counters.projectionReadBytes += Buffer.byteLength(JSON.stringify(oldRows));
    if (name !== 'groups') for (const row of oldRows) obsolete.add(String(row.hash));
    const old = new Map(oldRows.map((r) => [Number(r.ordinal), r]));
    for (const entry of entries) {
      const ordinal = Number(entry.ordinal);
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) fail('invalid contribution ordinal');
      const before = old.get(ordinal);
      old.delete(ordinal);
      if (name === 'groups') {
        if (!before || before.discovery_order !== entry.discovery_order) {
          db.prepare(
            `INSERT INTO ${table(name)} VALUES(?,?,?) ON CONFLICT(source_id,ordinal) DO UPDATE SET discovery_order=excluded.discovery_order`,
          ).run(id, ordinal, entry.discovery_order!);
          countWrite(connection, { id, ordinal, discovery_order: entry.discovery_order });
        }
      } else {
        // SQLite json_each returns primitive scalars directly; encode them as JSON
        // so the public json() result matches the former lookup exactly.
        const payload =
          typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload);
        connection.counters.hashedPayloadBytes += Buffer.byteLength(payload);
        const hash = digest(payload);
        retainedHere.add(hash);
        const stored = db
          .prepare(`SELECT payload FROM ${table('payloads')} WHERE hash=?`)
          .get(hash);
        connection.counters.projectionRowsRead += stored ? 1 : 0;
        connection.counters.projectionReadBytes += stored
          ? Buffer.byteLength(String(stored.payload))
          : 0;
        if (!stored || stored.payload !== payload) {
          db.prepare(
            `INSERT INTO ${table('payloads')} VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET payload=excluded.payload`,
          ).run(hash, payload);
          countWrite(connection, { hash, payload });
        }
        const operation = entry.operation_id;
        if (name === 'acceptances' && operation !== null && typeof operation !== 'string')
          fail('invalid acceptance operation identity');
        if (
          !before ||
          before.hash !== hash ||
          (name === 'acceptances' && before.operation_id !== operation)
        ) {
          if (name === 'acceptances')
            db.prepare(
              `INSERT INTO ${table(name)} VALUES(?,?,?,?) ON CONFLICT(source_id,ordinal) DO UPDATE SET operation_id=excluded.operation_id,hash=excluded.hash`,
            ).run(id, ordinal, operation ?? null, hash);
          else
            db.prepare(
              `INSERT INTO ${table(name)} VALUES(?,?,?) ON CONFLICT(source_id,ordinal) DO UPDATE SET hash=excluded.hash`,
            ).run(id, ordinal, hash);
          countWrite(connection, {
            id,
            ordinal,
            operation: name === 'acceptances' ? operation : undefined,
            hash,
          });
        }
      }
    }
    for (const ordinal of old.keys()) {
      db.prepare(`DELETE FROM ${table(name)} WHERE source_id=? AND ordinal=?`).run(id, ordinal);
      countWrite(connection, { id, ordinal, deleted: true });
    }
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
  tracking(db);
  if (connection.schema !== schemaVersion(db)) initialize(db, connection, profile);
  const binding = db.prepare(`SELECT profile_id FROM ${table('state')} WHERE singleton=1`).get();
  if (binding?.profile_id !== profile) initialize(db, connection, profile);
  db.exec('SAVEPOINT __intake_lookup_reconcile');
  try {
    const obsolete = new Set<string>();
    for (const row of db
      .prepare('SELECT source_id FROM temp.__intake_lookup_dirty ORDER BY source_id')
      .all()) {
      for (const hash of reconcile(db, connection, String(row.source_id))) obsolete.add(hash);
    }
    prune(db, connection, obsolete);
    db.exec('RELEASE __intake_lookup_reconcile');
  } catch (error) {
    try {
      db.exec('ROLLBACK TO __intake_lookup_reconcile; RELEASE __intake_lookup_reconcile');
    } catch {
      /* An aborted outer transaction is recovered by its owner. */
    }
    connection.rebuild = true;
    connection.schema = -1;
    if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
    throw error;
  }
  if (db.isTransaction && !currentTransactionToken(db)) connection.schema = -1;
  return connection;
}
export function reconcileActiveIntakeLookup(db: DatabaseSync): void {
  const connection = connections.get(db);
  if (connection && connection.schema !== -1 && currentTransactionToken(db)) current(db);
}
export function maximumIntakeDiscoveryOrder(db: DatabaseSync): number {
  current(db);
  return Number(db.prepare(`SELECT MAX(discovery_order) n FROM ${table('groups')}`).get()!.n || 0);
}
export function retainedIntakeAcceptance(db: DatabaseSync, operationId: string): unknown {
  current(db);
  const row = db
    .prepare(
      `SELECT p.payload FROM ${table('acceptances')} a JOIN ${table('payloads')} p ON p.hash=a.hash JOIN ${table('sources')} s ON s.source_id=a.source_id WHERE a.operation_id=? ORDER BY s.source_order,a.ordinal LIMIT 1`,
    )
    .get(operationId);
  return row ? JSON.parse(String(row.payload)) : null;
}
export function indexedIntakeIdentityConfirmations(db: DatabaseSync): unknown[] {
  current(db);
  return db
    .prepare(
      `SELECT p.payload FROM ${table('identities')} i JOIN ${table('payloads')} p ON p.hash=i.hash JOIN ${table('sources')} s ON s.source_id=i.source_id ORDER BY s.source_order,i.ordinal`,
    )
    .all()
    .map((r) => json(r.payload));
}
