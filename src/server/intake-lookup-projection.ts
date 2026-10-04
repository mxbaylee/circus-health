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
  readIntakeEnvelopeMaterialized,
  type IntakeEnvelopeSource,
} from './intake-authority.ts';
import {
  hasIntakeCollectionEnvelope,
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import {
  boundedIntakeLookupText,
  INTAKE_LOOKUP_SCOPE_BYTES,
} from './intake-lookup-contributions.ts';
import { readNativeIntakeLookupTarget } from './intake-lookup-state.ts';
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
}
interface Connection {
  dispose: () => void;
  rebuild: boolean;
  schema: number;
  counters: IntakeLookupCounters;
  hashes: Map<string, string>;
  entries: WeakMap<object, Map<string, ProjectionRow>>;
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
  connection.hashes.clear();
  connection.entries = new WeakMap();
}
function create(db: DatabaseSync): Connection {
  const connection: Connection = {
    dispose: () => {},
    rebuild: false,
    schema: -1,
    hashes: new Map(),
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
    },
  };
  connection.dispose = observeTransactionOutcome(db, (outcome) => {
    if (!outcome.succeeded) {
      clearPayloadMemo(connection);
      connection.schema = -1;
    }
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
      const removed = db
        .prepare(`DELETE FROM ${table('payloads')} WHERE hash=? RETURNING payload`)
        .get(hash);
      if (removed) {
        connection.hashes.delete(String(removed.payload));
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
      const rows = db.prepare(`DELETE FROM ${table(name)} WHERE source_id=? RETURNING *`).all(id);
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
          db.prepare(`DELETE FROM ${table(name)} WHERE source_id=? AND hash=?`).run(id, row.hash!);
          prune(db, connection, new Set([String(row.hash)]));
          countWrite(connection, { id, hash: row.hash, deleted: true });
        }
      }
      db.prepare(`DELETE FROM ${table('groups')} WHERE source_id=?`).run(id);
    }
    if (
      !prior ||
      prior.source_order !== source.source_order ||
      prior.kind !== source.kind ||
      prior.authority_key !== binding.key ||
      prior.authority_head !== binding.logicalHead ||
      prior.identity_first !== -1
    ) {
      db.prepare(
        `INSERT INTO ${table('sources')} VALUES(?,?,?,?,?,-1) ON CONFLICT(source_id) DO UPDATE SET source_order=excluded.source_order,kind=excluded.kind,authority_key=excluded.authority_key,authority_head=excluded.authority_head,identity_first=-1`,
      ).run(id, source.source_order!, source.kind!, binding.key, binding.logicalHead);
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
    db.prepare(
      `INSERT INTO ${table('sources')}(source_id,source_order,kind,authority_key,authority_head) VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET source_order=excluded.source_order,kind=excluded.kind,authority_key=excluded.authority_key,authority_head=excluded.authority_head`,
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
      db.prepare(`DELETE FROM ${table('groups')} WHERE source_id=? AND ordinal=?`).run(
        id,
        row.ordinal!,
      );
      countWrite(connection, { id, ordinal: row.ordinal, deleted: true });
    }
  if (!oldGroup.some((row) => row.ordinal === 0 && row.discovery_order === maximum)) {
    db.prepare(
      `INSERT INTO ${table('groups')} VALUES(?,0,?) ON CONFLICT(source_id,ordinal) DO UPDATE SET discovery_order=excluded.discovery_order`,
    ).run(id, maximum);
    countWrite(connection, { id, ordinal: 0, discovery_order: maximum });
  }
  const payload = (value: unknown): string => {
    // Preserve json_each scalar behavior, including its boolean conversion.
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof value !== 'string')
      connection.counters.serializedPayloadBytes += Buffer.byteLength(text);
    let hash = connection.hashes.get(text);
    if (!hash) {
      connection.counters.hashedPayloadBytes += Buffer.byteLength(text);
      hash = digest(text);
      // Only one legacy payload memo survives. Native readers retain no receipt
      // payloads, and a corpus-wide memo is unnecessary for correctness.
      connection.hashes.clear();
      connection.hashes.set(text, hash);
    }
    retainedHere.add(hash);
    const stored = db.prepare(`SELECT payload FROM ${table('payloads')} WHERE hash=?`).get(hash);
    readRows(connection, stored ? [stored] : []);
    if (!stored || stored.payload !== text) {
      db.prepare(
        `INSERT INTO ${table('payloads')} VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET payload=excluded.payload`,
      ).run(hash, text);
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
      db.prepare(
        `INSERT INTO ${table('acceptances')} VALUES(?,?,?) ON CONFLICT(source_id,operation_id) DO UPDATE SET hash=excluded.hash`,
      ).run(id, operation, hash);
      countWrite(connection, { id, operation, hash });
    }
    acceptanceMap.delete(operation);
  }
  for (const operation of acceptanceMap.keys()) {
    db.prepare(`DELETE FROM ${table('acceptances')} WHERE source_id=? AND operation_id=?`).run(
      id,
      operation,
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
      db.prepare(
        `INSERT INTO ${table('identities')} VALUES(?,?,?,?) ON CONFLICT(source_id,id) DO UPDATE SET next=excluded.next,hash=excluded.hash`,
      ).run(id, row.id, next, row.hash);
      countWrite(connection, { id, occurrence: row.id, next, hash: row.hash });
      connection.counters.identityLinksWritten++;
    }
  }
  for (const row of oldIdentities)
    if (!used.has(Number(row.id))) {
      db.prepare(`DELETE FROM ${table('identities')} WHERE source_id=? AND id=?`).run(id, row.id!);
      countWrite(connection, { id, occurrence: row.id, deleted: true });
      connection.counters.identityLinksWritten++;
    }
  const nextFirst = nextRows[0]?.id ?? null;
  if (first !== nextFirst) {
    db.prepare(`UPDATE ${table('sources')} SET identity_first=? WHERE source_id=?`).run(
      nextFirst,
      id,
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
    while (true) {
      const row = db
        .prepare('SELECT source_id FROM temp.__intake_lookup_dirty ORDER BY source_id LIMIT 1')
        .get();
      if (!row) break;
      prune(db, connection, reconcile(db, connection, String(row.source_id)));
    }
    db.exec('RELEASE __intake_lookup_reconcile');
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
  return connection;
}
export function reconcileActiveIntakeLookup(db: DatabaseSync): void {
  const connection = connections.get(db);
  if (connection && connection.schema !== -1 && currentTransactionToken(db)) current(db);
}
export function maximumIntakeDiscoveryOrder(db: DatabaseSync): number {
  current(db);
  let maximum = db
    .prepare(
      `SELECT MAX(g.discovery_order) n FROM ${table('groups')} g JOIN ${table('sources')} s ON s.source_id=g.source_id WHERE s.identity_first IS NULL OR s.identity_first<>-1`,
    )
    .get()!.n;
  for (const source of nativeSources(db)) {
    const view = nativeReader(db, source);
    const group = readNativeIntakeLookupTarget(db, source, view, 'lookup-discovery-maximum', []);
    if (!group) continue;
    const text = boundedIntakeLookupText(view.fieldChunks(group, 'discoveryOrder'));
    const value = db.prepare("SELECT CAST(json_extract(?,'$') AS INTEGER) n").get(text)!.n;
    if (value !== null && (maximum === null || Number(value) > Number(maximum))) maximum = value;
  }
  return Number(maximum || 0);
}
export function retainedIntakeAcceptance(db: DatabaseSync, operationId: string): unknown {
  const reference = retainedIntakeAcceptanceReference(db, operationId);
  if (!reference) return null;
  return reference.mode === 'legacy'
    ? reference.value
    : JSON.parse(boundedIntakeLookupText(reference.view.recordChunks(reference.record)));
}
/** Point-selected receipt capability for consumers that cannot hydrate its targets. */
export function retainedIntakeAcceptanceReference(
  db: DatabaseSync,
  operationId: string,
): IntakeLookupReceiptReference | null {
  current(db);
  const row = db
    .prepare(
      `SELECT p.payload,s.source_id,s.source_order FROM ${table('acceptances')} a JOIN ${table('payloads')} p ON p.hash=a.hash JOIN ${table('sources')} s ON s.source_id=a.source_id WHERE a.operation_id=? AND (s.identity_first IS NULL OR s.identity_first<>-1) ORDER BY s.source_order LIMIT 1`,
    )
    .get(operationId);
  let selected: IntakeLookupReceiptReference | null = row
    ? { mode: 'legacy', sourceId: String(row.source_id), value: JSON.parse(String(row.payload)) }
    : null;
  let order = row ? Number(row.source_order) : Infinity;
  const nativeOperation = Buffer.from(operationId, 'utf8').toString('hex').toUpperCase();
  for (const source of nativeSources(db)) {
    const view = nativeReader(db, source);
    const record = readNativeIntakeLookupTarget(
      db,
      source,
      view,
      'lookup-acceptance-operation-first',
      [nativeOperation],
    );
    if (record && Number(source.source_order) < order) {
      selected = { mode: 'native', sourceId: String(source.id), view, record };
      order = Number(source.source_order);
    }
  }
  return selected;
}
type NativeSource = IntakeEnvelopeSource & { source_order: number; authority_head: string };
function* nativeSources(db: DatabaseSync): Generator<NativeSource> {
  for (const source of db
    .prepare(
      `SELECT f.id,f.kind,f.sha256,f.details_json,f.rowid source_order,s.authority_head,s.identity_first FROM source_files f LEFT JOIN ${table('sources')} s ON s.source_id=f.id WHERE f.kind='intake_original' ORDER BY f.rowid`,
    )
    .iterate()) {
    const selected = source as unknown as NativeSource;
    const binding = intakeEnvelopeAuthorityBinding(db, selected);
    if (!hasIntakeCollectionEnvelope(db, selected)) continue;
    if (source.identity_first !== -1 || source.authority_head !== binding.logicalHead)
      return fail('native source projection binding is unavailable');
    yield selected;
  }
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
  current(db);
  for (const source of db
    .prepare(
      `SELECT f.id source_id,f.kind,f.sha256,f.details_json,f.rowid source_order,s.authority_head,s.identity_first FROM source_files f LEFT JOIN ${table('sources')} s ON s.source_id=f.id ORDER BY f.rowid`,
    )
    .iterate()) {
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
        yield { mode: 'native', sourceId: String(source.source_id), view, record };
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
        yield { mode: 'legacy', sourceId: String(source.source_id), value: json(row.payload) };
        next = row.next;
      }
      if (next !== null) return fail('invalid identity occurrence chain');
    }
  }
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
  current(db);
  const native = !!db
    .prepare(`SELECT 1 FROM ${table('sources')} WHERE identity_first=-1 LIMIT 1`)
    .get();
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
  return values;
}
