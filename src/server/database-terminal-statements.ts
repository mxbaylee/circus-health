import { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  managedDatabaseMethodEpoch,
  managedDatabaseDataMethod,
  prepareManagedDatabaseCallbackBarrier,
  withoutManagedDatabaseCallbacks,
  currentTransactionToken,
  prepareTerminalAuthorizedStatement,
  invokeTerminalAuthorizedStatement,
  iterateTerminalAuthorizedStatement,
  stepTerminalAuthorizedIterator,
  closeTerminalAuthorizedStatement,
} from './database.ts';
import { withIntakeStateTerminalCleanup } from './intake-state-storage.ts';
import {
  recordMutationRecipeBoundTo,
  recordMutationStatement,
  type RecordMutationOutput,
  type createRecordMutationRecipe,
} from './record-mutation-recipe.ts';
import {
  recordPreparedIndexBoundTo,
  type createRecordPreparedIndex,
} from './record-prepared-index.ts';

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
  main: StatementSync;
  temp: StatementSync;
  peer: StatementSync;
  rollback: StatementSync;
  total?: StatementSync;
  readonly mainSchema: unknown;
  readonly tempSchema: unknown;
  readonly dataVersion: unknown;
  readonly entries: Map<string, Entry>;
  readonly executions: Map<string, Entry>;
  readonly iterators: Set<Iterator<unknown>>;
  readonly owned: Set<StatementSync>;
  readonly recipe?: ReturnType<typeof createRecordMutationRecipe>;
  refreshed: boolean;
  used: boolean;
}
const preparations = new WeakMap<PreparedTerminalStatements, Preparation>();
const active = new WeakMap<DatabaseSync, Preparation>();
const recipePreparations = new WeakMap<object, Preparation>();
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
function ownedRead(item: Preparation, statement: StatementSync) {
  return item.recipe
    ? (invokeTerminalAuthorizedStatement(item.db, statement, 'get', []) as ReturnType<
        StatementSync['get']
      >)
    : read(statement);
}
function schemaCurrent(item: Preparation): void {
  current(item);
  if (
    ownedRead(item, item.main)!.schema_version !== item.mainSchema ||
    ownedRead(item, item.temp)!.schema_version !== item.tempSchema ||
    ownedRead(item, item.peer)!.data_version !== item.dataVersion
  )
    fail();
  current(item);
}
/** Identity only. The cooperating native issuer never accepts a caller-created
 * resolver or a handle outside this exact active recipe inventory. */
export function terminalNativeStatementOwned(db: DatabaseSync, statement: StatementSync): boolean {
  const item = active.get(db);
  if (!item?.recipe || !item.refreshed || !recordMutationRecipeBoundTo(db, item.recipe))
    return false;
  current(item);
  return item.owned.has(statement);
}
function facade(item: Preparation, statement: StatementSync, bigInts: boolean): StatementSync {
  const invoke = (name: 'get' | 'all' | 'run' | 'columns', args: unknown[]) => {
    current(item);
    if (item.recipe) schemaCurrent(item);
    const result = item.recipe
      ? invokeTerminalAuthorizedStatement(item.db, statement, name, args)
      : Reflect.apply(
          { get: nativeGet, all: nativeAll, run: nativeRun, columns: nativeColumns }[name],
          statement,
          args,
        );
    if (item.recipe) schemaCurrent(item);
    return result;
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
      if (item.recipe) schemaCurrent(item);
      const iterator = item.recipe
        ? iterateTerminalAuthorizedStatement(item.db, statement, args)
        : Reflect.apply(nativeIterate, statement, args);
      item.iterators.add(iterator);
      const wrapped = {
        next() {
          current(item);
          if (item.recipe) schemaCurrent(item);
          const result = item.recipe
            ? stepTerminalAuthorizedIterator(item.db, iterator, 'next')
            : iterator.next();
          if (item.recipe) schemaCurrent(item);
          if (result.done) item.iterators.delete(iterator);
          return result;
        },
        return() {
          current(item);
          if (item.recipe) schemaCurrent(item);
          const result = item.recipe
            ? stepTerminalAuthorizedIterator(item.db, iterator, 'return')
            : (iterator.return?.() ?? { done: true, value: undefined });
          if (item.recipe) schemaCurrent(item);
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
    readonly recordMutationRecipe?: ReturnType<typeof createRecordMutationRecipe>;
  },
): PreparedTerminalStatements {
  return prepareStatements(db, inventory);
}

/** Compile in the genuine tentative transaction, not an empty surrogate.
 * The caller must separately bind its rollback receipt to a fresh final token. */
export function prepareTerminalStatementsInTransaction(
  db: DatabaseSync,
  token: object,
  inventory: Parameters<typeof prepareTerminalStatements>[1],
): PreparedTerminalStatements {
  if (!token || !db.isTransaction || currentTransactionToken(db) !== token) fail();
  return prepareStatements(db, inventory, token);
}

function prepareStatements(
  db: DatabaseSync,
  inventory: Parameters<typeof prepareTerminalStatements>[1],
  token?: object,
): PreparedTerminalStatements {
  const originalTransaction = () =>
    token
      ? db.isTransaction && currentTransactionToken(db) === token
      : !db.isTransaction && currentTransactionToken(db) === undefined;
  if (!originalTransaction() || active.has(db)) fail();
  const recipe = inventory.recordMutationRecipe;
  if (recipe && (!recordMutationRecipeBoundTo(db, recipe) || recipePreparations.has(recipe)))
    fail();
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
    rollback = nativePrepare.call(db, 'ROLLBACK'),
    total = recipe ? nativePrepare.call(db, 'SELECT total_changes() AS n') : undefined;
  if (total) Reflect.apply(nativeReadBigInts, total, [true]);
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
    total,
    mainSchema: read(main)!.schema_version,
    tempSchema: read(temp)!.schema_version,
    dataVersion: read(peer)!.data_version,
    entries: new Map(),
    executions: new Map(),
    iterators: new Set(),
    owned: new Set(),
    used: false,
    recipe,
    refreshed: false,
  };
  const compile = (sql: string, bigInts: boolean): Entry => {
    if (!originalTransaction()) fail();
    const statement = nativePrepare.call(db, sql);
    // SQLite prepare can ignore trailing statements; never certify such a batch.
    if (statement.sourceSQL.trim() !== sql.trim()) fail();
    Reflect.apply(nativeReadBigInts, statement, [bigInts]);
    if (!originalTransaction()) fail();
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
    !originalTransaction() ||
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
  if (recipe) recipePreparations.set(recipe, item);
  return capability;
}

/** Refresh every literal against the current installed policy before the final
 * physical proof. No T1 authorization answer is silently carried forward. */
export function refreshTerminalRecordMutationStatements(
  db: DatabaseSync,
  recipe: ReturnType<typeof createRecordMutationRecipe>,
): void {
  const item = recipePreparations.get(recipe);
  if (!item) return;
  if (
    item.db !== db ||
    item.recipe !== recipe ||
    item.used ||
    item.refreshed ||
    db.isTransaction ||
    active.has(db) ||
    !recordMutationRecipeBoundTo(db, recipe)
  )
    fail();
  const methodsCurrent = () =>
    managedDatabaseMethodEpoch(db) === item.methods &&
    managedDatabaseDataMethod(db, 'prepare') === item.prepare &&
    managedDatabaseDataMethod(db, 'exec') === item.exec &&
    managedDatabaseDataMethod(db, 'applyChangeset') === item.applyChangeset;
  if (!methodsCurrent()) fail();
  const before = read(item.total!)!.n,
    made: StatementSync[] = [];
  const compile = (sql: string, bigInts = false) => {
    if (!methodsCurrent() || db.isTransaction) fail();
    const statement = prepareTerminalAuthorizedStatement(db, sql, bigInts, before as bigint);
    made.push(statement);
    if (!methodsCurrent() || read(item.total!)!.n !== before || db.isTransaction) fail();
    return statement;
  };
  try {
    const main = compile('PRAGMA main.schema_version'),
      temp = compile('PRAGMA temp.schema_version'),
      peer = compile('PRAGMA main.data_version'),
      rollback = compile('ROLLBACK'),
      total = compile('SELECT total_changes() AS n', true),
      entries = new Map<string, Entry>(),
      executions = new Map<string, Entry>();
    for (const [key, entry] of item.entries) {
      const statement = compile(entry.statement.sourceSQL, entry.bigInts);
      entries.set(key, {
        statement,
        facade: facade(item, statement, entry.bigInts),
        bigInts: entry.bigInts,
      });
    }
    for (const [key, entry] of item.executions) {
      const statement = compile(entry.statement.sourceSQL, entry.bigInts);
      executions.set(key, {
        statement,
        facade: facade(item, statement, entry.bigInts),
        bigInts: entry.bigInts,
      });
    }
    if (
      read(main)!.schema_version !== item.mainSchema ||
      read(temp)!.schema_version !== item.tempSchema ||
      read(peer)!.data_version !== item.dataVersion ||
      read(total)!.n !== before ||
      !methodsCurrent()
    )
      fail();
    item.main = main;
    item.temp = temp;
    item.peer = peer;
    item.rollback = rollback;
    item.total = total;
    item.entries.clear();
    for (const [key, entry] of entries) item.entries.set(key, entry);
    item.executions.clear();
    for (const [key, entry] of executions) item.executions.set(key, entry);
    item.owned.clear();
    for (const statement of made) item.owned.add(statement);
    item.refreshed = true;
  } catch (error) {
    for (const statement of made) closeTerminalAuthorizedStatement(statement);
    throw error;
  }
}
/** Revoke an unused inventory without retaining its refreshed authorization tapes. */
export function disposeTerminalRecordMutationStatements(
  db: DatabaseSync,
  recipe: ReturnType<typeof createRecordMutationRecipe>,
): void {
  const item = recipePreparations.get(recipe);
  if (!item) return;
  if (item.db !== db || item.recipe !== recipe || active.get(db) === item) fail();
  recipePreparations.delete(recipe);
  item.used = true;
  for (const statement of item.owned) closeTerminalAuthorizedStatement(statement);
  item.owned.clear();
  item.entries.clear();
  item.executions.clear();
}
export function terminalRecordMutationReprepareActive(db: DatabaseSync, recipe: object): boolean {
  const item = active.get(db);
  return !!item?.refreshed && item.recipe === recipe && recordMutationRecipeBoundTo(db, recipe);
}
export function terminalRecordMutationNativeScopeActive(db: DatabaseSync): boolean {
  const item = active.get(db);
  return !!item?.recipe && terminalRecordMutationReprepareActive(db, item.recipe);
}
export function readTerminalRecordMutationCount(db: DatabaseSync, recipe: object): bigint {
  const item = active.get(db);
  if (!item || !terminalRecordMutationReprepareActive(db, recipe)) fail();
  schemaCurrent(item!);
  const value = ownedRead(item!, item!.total!)!.n;
  if (typeof value !== 'bigint') fail();
  schemaCurrent(item!);
  return value as bigint;
}
export function runTerminalRecordMutationStatement(
  db: DatabaseSync,
  recipe: object,
  sql: string,
  args: readonly unknown[],
): ReturnType<StatementSync['run']> {
  const item = active.get(db);
  if (!item || !terminalRecordMutationReprepareActive(db, recipe)) fail();
  schemaCurrent(item!);
  const entry = item!.entries.get(entryKey(sql, false));
  if (!entry || entry.statement.sourceSQL !== sql) fail();
  const result = invokeTerminalAuthorizedStatement(db, entry!.statement, 'run', args);
  schemaCurrent(item!);
  return result as ReturnType<StatementSync['run']>;
}

/** No native handle escapes the exact synchronous owner scope. */
export function withTerminalStatements<T>(
  db: DatabaseSync,
  capability: PreparedTerminalStatements,
  run: () => T,
): T {
  const item = preparations.get(capability);
  if (
    !item ||
    item.db !== db ||
    item.used ||
    db.isTransaction ||
    active.has(db) ||
    (item.recipe && !item.refreshed)
  )
    fail();
  item.used = true;
  return withIntakeStateTerminalCleanup(db, () => {
    active.set(db, item);
    try {
      return withoutManagedDatabaseCallbacks(db, () => {
        current(item);
        schemaCurrent(item);
        let failed = false,
          firstFailure: unknown,
          result: T | undefined;
        try {
          result = run();
          current(item);
          if (item.iterators.size || db.isTransaction) fail();
          if (item.recipe) schemaCurrent(item);
        } catch (error) {
          failed = true;
          firstFailure = error;
        } finally {
          try {
            for (const iterator of item.iterators) {
              try {
                if (item.recipe) stepTerminalAuthorizedIterator(db, iterator, 'return');
                else iterator.return?.();
              } catch (error) {
                if (!failed) {
                  failed = true;
                  firstFailure = error;
                }
              }
            }
          } finally {
            item.iterators.clear();
            if (db.isTransaction) {
              try {
                if (item.recipe) invokeTerminalAuthorizedStatement(db, item.rollback, 'run', []);
                else Reflect.apply(nativeRun, item.rollback, []);
              } catch (error) {
                if (!failed) {
                  failed = true;
                  firstFailure = error;
                }
              }
            }
          }
        }
        if (failed) throw firstFailure;
        return result as T;
      });
    } finally {
      active.delete(db);
      if (item.recipe) disposeTerminalRecordMutationStatements(db, item.recipe);
    }
  });
}

/** Only a genuine frozen exact-connection recipe reaches native handles; the
 * resolver stays inside these two issuers and cannot escape to caller code. */
export function replayTerminalRecordMutations(
  db: DatabaseSync,
  recipe: ReturnType<typeof createRecordMutationRecipe>,
): void {
  const item = active.get(db);
  if (!item || !recordMutationRecipeBoundTo(db, recipe)) fail();
  current(item!);
  recipe.replay((sql) => {
    current(item!);
    const entry = item!.entries.get(entryKey(sql, false));
    if (!entry) return fail();
    return entry.statement;
  });
  current(item!);
}
/** Only a genuine exact-DB typed index can resolve the owner's private native
 * inventory. No caller-selected resolver or native statement escapes. */
export function replayTerminalPreparedRecordIndex(
  db: DatabaseSync,
  index: ReturnType<typeof createRecordPreparedIndex>,
): void {
  const item = active.get(db);
  if (!item || !recordPreparedIndexBoundTo(db, index)) fail();
  current(item!);
  for (const row of index.consume()) {
    current(item!);
    if (item!.recipe) schemaCurrent(item!);
    const entry = item!.entries.get(entryKey(row.sql, false));
    if (!entry) fail();
    if (row.mode === 'check') {
      if (
        Number(
          (item!.recipe
            ? invokeTerminalAuthorizedStatement(db, entry!.statement, 'get', row.args)
            : Reflect.apply(nativeGet, entry!.statement, row.args)) !== undefined,
        ) !== row.expected
      )
        fail();
    } else if (
      (item!.recipe
        ? (invokeTerminalAuthorizedStatement(db, entry!.statement, 'run', row.args) as ReturnType<
            StatementSync['run']
          >)
        : Reflect.apply(nativeRun, entry!.statement, row.args)
      ).changes !== row.expected
    )
      fail();
    current(item!);
    if (item!.recipe) schemaCurrent(item!);
  }
  current(item!);
}

/** Ordinary callers keep native preparation; only the active private owner
 * resolves a literal to its already-authorized, nonescaping statement facade. */
export function terminalStatement(
  db: DatabaseSync,
  sql: string,
  cached?: StatementSync,
  bigInts = false,
  mutationOutput?: RecordMutationOutput,
): StatementSync {
  const item = active.get(db);
  if (!item)
    return mutationOutput === undefined
      ? (cached ?? db.prepare(sql))
      : recordMutationStatement(db, sql, mutationOutput, cached);
  current(item);
  const entry = item.entries.get(entryKey(sql, bigInts));
  if (entry) return entry.facade;
  if (item.recipe && !bigInts) {
    const witness =
      sql === 'PRAGMA main.schema_version'
        ? item.main
        : sql === 'PRAGMA temp.schema_version'
          ? item.temp
          : sql === 'PRAGMA main.data_version'
            ? item.peer
            : undefined;
    if (witness) return facade(item, witness, false);
  }
  return fail();
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
