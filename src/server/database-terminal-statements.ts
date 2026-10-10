import { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  managedDatabaseMethodEpoch,
  managedDatabaseDataMethod,
  prepareManagedDatabaseCallbackBarrier,
  withoutManagedDatabaseCallbacks,
} from './database.ts';
import { withIntakeStateTerminalCleanup } from './intake-state-storage.ts';

declare const statementsBrand: unique symbol;
export interface PreparedTerminalStatements {
  readonly [statementsBrand]: true;
}
interface Entry {
  readonly statement: StatementSync;
  readonly facade: StatementSync;
  readonly bigInts: boolean;
}
interface Preparation {
  readonly db: DatabaseSync;
  readonly methods: object;
  readonly prepare: unknown;
  readonly exec: unknown;
  readonly applyChangeset: unknown;
  readonly main: StatementSync;
  readonly temp: StatementSync;
  readonly peer: StatementSync;
  readonly rollback: StatementSync;
  readonly mainSchema: unknown;
  readonly tempSchema: unknown;
  readonly dataVersion: unknown;
  readonly entries: Map<string, Entry>;
  readonly executions: Map<string, Entry>;
  readonly iterators: Set<Iterator<unknown>>;
  used: boolean;
}
const preparations = new WeakMap<PreparedTerminalStatements, Preparation>();
const active = new WeakMap<DatabaseSync, Preparation>();
const nativePrepare = DatabaseSync.prototype.prepare,
  nativeGet = StatementSync.prototype.get,
  nativeAll = StatementSync.prototype.all,
  nativeRun = StatementSync.prototype.run,
  nativeColumns = StatementSync.prototype.columns,
  nativeIterate = StatementSync.prototype.iterate,
  nativeReadBigInts = StatementSync.prototype.setReadBigInts;
const read = (statement: StatementSync) => Reflect.apply(nativeGet, statement, []);
const entryKey = (sql: string, bigInts: boolean) => JSON.stringify([sql, bigInts]);
function fail(): never {
  throw Error('Foreign, expired or unprepared terminal database statement');
}
function current(item: Preparation): void {
  if (
    active.get(item.db) !== item ||
    managedDatabaseMethodEpoch(item.db) !== item.methods ||
    managedDatabaseDataMethod(item.db, 'prepare') !== item.prepare ||
    managedDatabaseDataMethod(item.db, 'exec') !== item.exec ||
    managedDatabaseDataMethod(item.db, 'applyChangeset') !== item.applyChangeset
  )
    fail();
}
function facade(item: Preparation, statement: StatementSync, bigInts: boolean): StatementSync {
  const invoke = (name: 'get' | 'all' | 'run' | 'columns', args: unknown[]) => {
    current(item);
    return Reflect.apply(
      { get: nativeGet, all: nativeAll, run: nativeRun, columns: nativeColumns }[name],
      statement,
      args,
    );
  };
  return Object.freeze({
    sourceSQL: statement.sourceSQL,
    get: (...args: unknown[]) => invoke('get', args),
    all: (...args: unknown[]) => invoke('all', args),
    run: (...args: unknown[]) => invoke('run', args),
    columns: () => invoke('columns', []),
    setReadBigInts(value: boolean) {
      current(item);
      if (value !== bigInts) fail();
    },
    iterate(...args: unknown[]) {
      current(item);
      const iterator = Reflect.apply(nativeIterate, statement, args);
      item.iterators.add(iterator);
      const wrapped = {
        next() {
          current(item);
          const result = iterator.next();
          if (result.done) item.iterators.delete(iterator);
          return result;
        },
        return() {
          current(item);
          const result = iterator.return?.() ?? { done: true, value: undefined };
          item.iterators.delete(iterator);
          return result;
        },
        [Symbol.iterator]() {
          return wrapped;
        },
      };
      return wrapped;
    },
  }) as unknown as StatementSync;
}

/** Statement transport, not record authority. The private publication owner
 * must separately verify original evidence AFTER compiling this inventory. */
export function prepareTerminalStatements(
  db: DatabaseSync,
  inventory: {
    readonly statements: readonly { sql: string; bigInts?: boolean }[];
    readonly executions?: readonly string[];
  },
): PreparedTerminalStatements {
  if (db.isTransaction || active.has(db)) fail();
  prepareManagedDatabaseCallbackBarrier(db);
  const methods = managedDatabaseMethodEpoch(db);
  if (!methods) fail();
  const prepare = managedDatabaseDataMethod(db, 'prepare'),
    exec = managedDatabaseDataMethod(db, 'exec'),
    applyChangeset = managedDatabaseDataMethod(db, 'applyChangeset');
  if ([prepare, exec, applyChangeset].some((method) => typeof method !== 'function')) fail();
  const main = nativePrepare.call(db, 'PRAGMA main.schema_version'),
    temp = nativePrepare.call(db, 'PRAGMA temp.schema_version'),
    peer = nativePrepare.call(db, 'PRAGMA main.data_version'),
    rollback = nativePrepare.call(db, 'ROLLBACK');
  const item: Preparation = {
    db,
    methods,
    prepare,
    exec,
    applyChangeset,
    main,
    temp,
    peer,
    rollback,
    mainSchema: read(main)!.schema_version,
    tempSchema: read(temp)!.schema_version,
    dataVersion: read(peer)!.data_version,
    entries: new Map(),
    executions: new Map(),
    iterators: new Set(),
    used: false,
  };
  const compile = (sql: string, bigInts: boolean): Entry => {
    const statement = nativePrepare.call(db, sql);
    // SQLite prepare can ignore trailing statements; never certify such a batch.
    if (statement.sourceSQL.trim() !== sql.trim()) fail();
    Reflect.apply(nativeReadBigInts, statement, [bigInts]);
    return { statement, facade: facade(item, statement, bigInts), bigInts };
  };
  for (const spec of inventory.statements) {
    const key = entryKey(spec.sql, spec.bigInts === true);
    if (item.entries.has(key)) fail();
    item.entries.set(key, compile(spec.sql, spec.bigInts === true));
  }
  for (const sql of inventory.executions ?? []) {
    if (item.executions.has(sql)) fail();
    item.executions.set(sql, compile(sql, false));
  }
  if (
    managedDatabaseMethodEpoch(db) !== methods ||
    managedDatabaseDataMethod(db, 'prepare') !== prepare ||
    managedDatabaseDataMethod(db, 'exec') !== exec ||
    managedDatabaseDataMethod(db, 'applyChangeset') !== applyChangeset ||
    read(main)!.schema_version !== item.mainSchema ||
    read(temp)!.schema_version !== item.tempSchema ||
    read(peer)!.data_version !== item.dataVersion ||
    managedDatabaseMethodEpoch(db) !== methods
  )
    fail();
  const capability = Object.freeze({}) as PreparedTerminalStatements;
  preparations.set(capability, item);
  return capability;
}

/** No native handle escapes the exact synchronous owner scope. */
export function withTerminalStatements<T>(
  db: DatabaseSync,
  capability: PreparedTerminalStatements,
  run: () => T,
): T {
  const item = preparations.get(capability);
  if (!item || item.db !== db || item.used || db.isTransaction || active.has(db)) fail();
  item.used = true;
  return withIntakeStateTerminalCleanup(db, () => {
    active.set(db, item);
    try {
      return withoutManagedDatabaseCallbacks(db, () => {
        current(item);
        if (
          read(item.main)!.schema_version !== item.mainSchema ||
          read(item.temp)!.schema_version !== item.tempSchema ||
          read(item.peer)!.data_version !== item.dataVersion
        )
          fail();
        try {
          const result = run();
          current(item);
          if (item.iterators.size || db.isTransaction) fail();
          return result;
        } finally {
          try {
            for (const iterator of item.iterators) iterator.return?.();
          } finally {
            item.iterators.clear();
            if (db.isTransaction) Reflect.apply(nativeRun, item.rollback, []);
          }
        }
      });
    } finally {
      active.delete(db);
    }
  });
}

/** Ordinary callers keep native preparation; only the active private owner
 * resolves a literal to its already-authorized, nonescaping statement facade. */
export function terminalStatement(
  db: DatabaseSync,
  sql: string,
  cached?: StatementSync,
  bigInts = false,
): StatementSync {
  const item = active.get(db);
  if (!item) return cached ?? db.prepare(sql);
  current(item);
  return item.entries.get(entryKey(sql, bigInts))?.facade ?? fail();
}
/** Cache owners must never retain a facade beyond this exact owner scope. */
export function terminalStatementsActive(db: DatabaseSync): boolean {
  return active.has(db);
}
export function terminalExecution(db: DatabaseSync, sql: string): void {
  const item = active.get(db);
  if (!item) return db.exec(sql);
  current(item);
  const entry = item.executions.get(sql);
  if (!entry) fail();
  entry.facade.run();
}
