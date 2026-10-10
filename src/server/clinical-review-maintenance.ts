import {
  constants,
  type DatabaseSync,
  type SQLInputValue,
  type StatementResultingChanges,
} from 'node:sqlite';
import { observeDatabaseClose } from './database.ts';
import { reviewReadStamp } from './intake-clinical-review-read-cache.ts';

type Owner = 'reader' | 'attention';
const maintenanceObservers = new WeakMap<
  DatabaseSync,
  { functionName: string; origins: ReadonlyMap<string, { table: string; sql: string }> }
>();

/** Fixed private attention triggers may report execution without performing SQL writes. */
export function registerAttentionMaintenanceObserver(
  db: DatabaseSync,
  functionName: string,
  origins: readonly string[],
) {
  if (
    !/^__source_attention_event_[a-f0-9]{32}$/.test(functionName) ||
    origins.length !== 8 ||
    new Set(origins).size !== origins.length ||
    origins.some(
      (origin) =>
        !origin.startsWith(functionName + '_') ||
        !/^source_attention_(counts|dirty|state)_v1_(insert|update|delete)$/.test(
          origin.slice(functionName.length + 1),
        ) ||
        origin.endsWith('_dirty_v1_insert'),
    )
  )
    throw Error('Invalid private attention maintenance observer');
  maintenanceObservers.set(db, {
    functionName,
    origins: new Map(
      origins.map((origin) => {
        const suffix = origin.slice(functionName.length + 1),
          separator = suffix.lastIndexOf('_'),
          table = suffix.slice(0, separator),
          operation = suffix.slice(separator + 1).toUpperCase();
        return [
          origin,
          {
            table,
            sql: `CREATE TRIGGER ${origin} AFTER ${operation} ON temp.${table} BEGIN SELECT ${functionName}(); END`,
          },
        ];
      }),
    ),
  });
}
const readerTables = [
  'control',
  'sources',
  'plans',
  'units',
  'tree',
  'excluded',
  'proposals',
  'dependencies',
  'dirty',
  'dirty_proposals',
  'transitions',
  'effects',
  'path',
].map((name) => '__intake_reader_' + name);
const attentionTables = ['counts', 'dirty', 'state'].map(
  (name) => 'source_attention_' + name + '_v1',
);
const objects: Record<
  Owner,
  { tables: Set<string>; indexes: Set<string>; triggers: Map<string, string> }
> = {
  reader: {
    tables: new Set(readerTables),
    indexes: new Set(
      ['plan_address', 'unit_proposal', 'dependency_proposal'].map(
        (name) => '__intake_reader_' + name,
      ),
    ),
    triggers: new Map(
      ['meta', 'source'].flatMap((kind) =>
        ['insert', 'update', 'delete'].map(
          (event) =>
            [
              `__intake_reader_${kind}_${event}`,
              kind === 'meta' ? 'app_meta' : 'source_files',
            ] as const,
        ),
      ),
    ),
  },
  attention: {
    tables: new Set(attentionTables),
    indexes: new Set<string>(),
    triggers: new Map(
      ['meta', 'files'].flatMap((kind) =>
        ['insert', 'update', 'delete'].map(
          (event) =>
            [
              `source_attention_${kind}_${event}`,
              kind === 'meta' ? 'app_meta' : 'source_files',
            ] as const,
        ),
      ),
    ),
  },
};
const tableColumns: Record<Owner, Record<string, string>> = {
  reader: {
    control: 'singleton INTEGER PRIMARY KEY,generation INTEGER NOT NULL',
    sources:
      'id TEXT PRIMARY KEY,logical TEXT NOT NULL,sourceHash TEXT NOT NULL,ready INTEGER NOT NULL,generation INTEGER NOT NULL,run TEXT NOT NULL',
    plans:
      'source TEXT,ordinal INTEGER,address TEXT,unitCount INTEGER,eligible INTEGER,summary TEXT,PRIMARY KEY(source,ordinal)',
    units:
      'source TEXT,plan INTEGER,ordinal INTEGER,facts TEXT,proposal TEXT,stale INTEGER,PRIMARY KEY(source,plan,ordinal)',
    tree: 'source TEXT,level INTEGER,slot INTEGER,value TEXT,PRIMARY KEY(source,level,slot)',
    excluded:
      'source TEXT,plan INTEGER,level INTEGER,slot INTEGER,value INTEGER,PRIMARY KEY(source,plan,level,slot)',
    proposals: 'source TEXT,id TEXT,current INTEGER,PRIMARY KEY(source,id)',
    dependencies: 'key TEXT,source TEXT,proposal TEXT,PRIMARY KEY(key,source,proposal)',
    dirty: 'key TEXT PRIMARY KEY',
    dirty_proposals: 'source TEXT,proposal TEXT,PRIMARY KEY(source,proposal)',
    transitions: 'source TEXT,after TEXT,before TEXT,PRIMARY KEY(source,after)',
    effects:
      'source TEXT,after TEXT,kind TEXT,key TEXT,value TEXT,PRIMARY KEY(source,after,kind,key)',
    path: 'source TEXT,run TEXT,after TEXT,PRIMARY KEY(source,run,after)',
  },
  attention: {
    counts: 'source_id TEXT PRIMARY KEY,sections INTEGER NOT NULL',
    dirty: 'source_id TEXT PRIMARY KEY',
    state: 'singleton INTEGER PRIMARY KEY,profile_id TEXT NOT NULL,data_version INTEGER NOT NULL',
  },
};
const canonicalTables = Object.fromEntries(
  Object.entries(tableColumns).map(([owner, entries]) => [
    owner,
    new Map(
      Object.entries(entries).map(([suffix, columns]) => {
        const name =
          owner === 'reader' ? '__intake_reader_' + suffix : 'source_attention_' + suffix + '_v1';
        return [name, 'CREATE TABLE ' + name + '(' + columns + ')'];
      }),
    ),
  ]),
) as Record<Owner, Map<string, string>>;
const canonicalIndexes = new Map([
  [
    '__intake_reader_plan_address',
    'CREATE INDEX __intake_reader_plan_address ON __intake_reader_plans(source,address)',
  ],
  [
    '__intake_reader_unit_proposal',
    'CREATE INDEX __intake_reader_unit_proposal ON __intake_reader_units(source,proposal)',
  ],
  [
    '__intake_reader_dependency_proposal',
    'CREATE INDEX __intake_reader_dependency_proposal ON __intake_reader_dependencies(source,proposal)',
  ],
]);
const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const schemaProofs = new WeakMap<DatabaseSync, Map<Owner, string>>();
function assertCanonicalSchema(db: DatabaseSync, owner: Owner, stamp: string): void {
  let proofs = schemaProofs.get(db);
  if (proofs?.get(owner) === stamp) return;
  const names = [...objects[owner].tables];
  const rows = db
    .prepare(
      'SELECT type,name,tbl_name,sql FROM sqlite_temp_schema WHERE tbl_name IN (' +
        names.map(() => '?').join(',') +
        ')',
    )
    .iterate(...names);
  for (const row of rows) {
    const name = String(row.name),
      table = String(row.tbl_name);
    const expected =
      row.type === 'table'
        ? canonicalTables[owner].get(name)
        : row.type === 'index'
          ? canonicalIndexes.get(name)
          : row.type === 'trigger' && owner === 'attention'
            ? maintenanceObservers.get(db)?.origins.get(name)?.sql
            : undefined;
    if (
      row.type === 'index' &&
      row.sql === null &&
      name.startsWith('sqlite_autoindex_' + table + '_')
    )
      continue;
    if (!expected || typeof row.sql !== 'string' || normalizeSql(row.sql) !== expected)
      throw Error('Uncertified clinical cache schema');
  }
  if (!proofs) schemaProofs.set(db, (proofs = new Map()));
  proofs.set(owner, stamp);
}
interface Credit {
  changes: bigint;
  schema: bigint;
}
const credits = new WeakMap<DatabaseSync, Credit>();
const active = new WeakSet<DatabaseSync>();
function parts(stamp: string) {
  const [epoch, changes, external, main, schema] = stamp.split(':');
  return { epoch, changes: BigInt(changes!), external, main, schema: BigInt(schema!) };
}

/** Cache compatibility remains raw. Only fresh cooperative work may discount
 * independently certified, synchronous disposable-cache SQL. */
export function reviewPreparationStamp(db: DatabaseSync): string | undefined {
  const raw = reviewReadStamp(db);
  if (raw === undefined) return undefined;
  const state = parts(raw),
    credit = credits.get(db);
  return `${state.epoch}:${state.changes - (credit?.changes || 0n)}:${state.external}:${state.main}:${state.schema - (credit?.schema || 0n)}`;
}

function execute(
  db: DatabaseSync,
  owner: Owner,
  sql: string,
  parameters: SQLInputValue[],
  ddl: boolean,
): StatementResultingChanges {
  if (active.has(db)) throw Error('Nested clinical cache maintenance');
  // Publication callbacks keep their ordinary transactional behavior. Their
  // writes receive no credit, including if the caller later rolls back.
  if (db.isTransaction) return db.prepare(sql).run(...parameters);
  const beforeRaw = reviewReadStamp(db);
  if (beforeRaw === undefined) throw Error('Clinical cache maintenance authority unavailable');
  assertCanonicalSchema(db, owner, beforeRaw);
  const before = parts(beforeRaw),
    allowed = objects[owner];
  let catalogWrites = false,
    declaredDdl = false,
    declaredTempTrigger = false;
  const catalog = (name: string | null) =>
    name === 'sqlite_temp_master' || name === 'sqlite_temp_schema';
  const index = (name: string | null, table: string | null) =>
    !!name &&
    !!table &&
    allowed.tables.has(table) &&
    (allowed.indexes.has(name) ||
      (/^sqlite_autoindex_.*_\d+$/.test(name) && name.startsWith(`sqlite_autoindex_${table}_`)));
  active.add(db);
  try {
    // These connections have no other application authorizer. Install only for
    // this fresh statement's compilation/execution, then restore normal SQL.
    db.setAuthorizer((action, name, detail, database, origin) => {
      if (action === constants.SQLITE_READ || action === constants.SQLITE_SELECT)
        return constants.SQLITE_OK;
      const observer = owner === 'attention' ? maintenanceObservers.get(db) : undefined;
      if (
        action === constants.SQLITE_FUNCTION &&
        observer &&
        detail === observer.functionName &&
        origin &&
        observer.origins.has(origin)
      )
        return constants.SQLITE_OK;
      if (
        action === constants.SQLITE_INSERT ||
        action === constants.SQLITE_UPDATE ||
        action === constants.SQLITE_DELETE
      ) {
        if (
          ddl &&
          declaredTempTrigger &&
          !origin &&
          database === 'main' &&
          name === 'sqlite_master' &&
          action === constants.SQLITE_INSERT
        )
          return constants.SQLITE_OK;
        if (origin || database !== 'temp') return constants.SQLITE_DENY;
        if (name && allowed.tables.has(name)) return constants.SQLITE_OK;
        // SQLite authorizes catalog writes before its CREATE action. They are
        // provisional until the complete single statement has been compiled.
        if (ddl && catalog(name)) {
          catalogWrites = true;
          return constants.SQLITE_OK;
        }
        return constants.SQLITE_DENY;
      }
      if (!ddl || origin || database !== 'temp') return constants.SQLITE_DENY;
      if (action === constants.SQLITE_REINDEX && declaredDdl && name && allowed.indexes.has(name))
        return constants.SQLITE_OK;
      if (
        (action === constants.SQLITE_CREATE_TEMP_TABLE ||
          action === constants.SQLITE_DROP_TEMP_TABLE) &&
        name &&
        allowed.tables.has(name)
      ) {
        declaredDdl = true;
        return constants.SQLITE_OK;
      }
      if (
        (action === constants.SQLITE_CREATE_TEMP_INDEX ||
          action === constants.SQLITE_DROP_TEMP_INDEX) &&
        index(name, detail)
      ) {
        declaredDdl = true;
        return constants.SQLITE_OK;
      }
      if (
        (action === constants.SQLITE_CREATE_TEMP_TRIGGER ||
          action === constants.SQLITE_DROP_TEMP_TRIGGER) &&
        name &&
        (allowed.triggers.get(name) === detail || observer?.origins.get(name)?.table === detail)
      ) {
        declaredTempTrigger = true;
        declaredDdl = true;
        return constants.SQLITE_OK;
      }
      return constants.SQLITE_DENY;
    });
    const statement = db.prepare(sql);
    if (statement.sourceSQL.trim() !== sql.trim())
      throw Error('Clinical cache maintenance requires one SQL statement');
    if (catalogWrites && !declaredDdl) throw Error('Uncertified clinical cache catalog write');
    const result = statement.run(...parameters);
    db.setAuthorizer(null);
    const afterRaw = reviewReadStamp(db);
    if (afterRaw === undefined) throw Error('Clinical cache maintenance changed transaction state');
    const after = parts(afterRaw);
    if (
      before.epoch !== after.epoch ||
      before.external !== after.external ||
      before.main !== after.main ||
      after.changes < before.changes ||
      after.schema < before.schema
    )
      throw Error('Clinical cache maintenance changed authority');
    if (after.schema === before.schema) schemaProofs.get(db)!.set(owner, afterRaw);
    else assertCanonicalSchema(db, owner, afterRaw);
    let credit = credits.get(db);
    if (!credit) {
      credits.set(db, (credit = { changes: 0n, schema: 0n }));
      observeDatabaseClose(db, () => {
        credits.delete(db);
        schemaProofs.delete(db);
      });
    }
    credit.changes += after.changes - before.changes;
    credit.schema += after.schema - before.schema;
    return result;
  } finally {
    if (db.isOpen) db.setAuthorizer(null);
    active.delete(db);
  }
}

/** Exactly one statement. No callbacks, existing statement handles or async work
 * can execute inside the certification boundary. Failure never receives credit. */
export function runClinicalReviewMaintenance(
  db: DatabaseSync,
  owner: Owner,
  sql: string,
  ...parameters: SQLInputValue[]
): StatementResultingChanges {
  return execute(db, owner, sql, parameters, false);
}
export function execClinicalReviewMaintenance(db: DatabaseSync, owner: Owner, sql: string): void {
  execute(db, owner, sql, [], true);
}
export function prepareClinicalReviewMaintenance(db: DatabaseSync, owner: Owner, sql: string) {
  return {
    run: (...parameters: SQLInputValue[]) =>
      runClinicalReviewMaintenance(db, owner, sql, ...parameters),
  };
}
