import { DatabaseSync, StatementSync, constants, type SQLOutputValue } from 'node:sqlite';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profilePaths } from './profile-storage.ts';
import { profileDefinition, validProfileId } from './profiles.ts';
import { readDatabaseOwner } from './profile-ownership.ts';
import {
  beginIntakeMaintenancePublication,
  finishIntakeMaintenancePublication,
  verifyIntakeMaintenancePublication,
  type IntakeMaintenancePublication,
} from './intake-state-maintenance.ts';
import {
  expectIntakeFrontierMetaWrite,
  finishIntakeFrontierMetaWrite,
  intakeFrontierTerminalEvent,
  intakeFrontierTerminalStart,
  intakeFrontierTerminalOutcome,
} from './intake-lookup-frontier-observer.ts';
import {
  intakeProjectionTerminalEvent,
  intakeProjectionTerminalOutcome,
} from './intake-lookup-projection-witness.ts';
import { sourceDetailsTerminalOutcome } from './source-details-search.ts';
import { sourceTextTerminalOutcome } from './source-text-projection.ts';
import { intakeLookupTerminalOutcome } from './intake-lookup-projection.ts';
import { intakeDiscoveryTerminalOutcome } from './intake-discovery-admission.ts';
import { intakeSourceContextTerminalOutcome } from './intake-source-context-classification.ts';
import { intakeStateTerminalOutcome } from './intake-state-storage.ts';
import {
  recordTerminalDurabilityParticipant,
  recordPreparedReplayCurrent,
  recordPreparedMaintenanceReplayVerified,
  recordPreparationBeforeBookkeeping,
  recordTransactionPreparationRequested,
  recordTransactionPreparationCaptured,
} from './record-versions.ts';
import {
  terminalStatement,
  terminalExecution,
  terminalStatementsActive,
  terminalNativeStatementOwned,
} from './database-terminal-statements.ts';
import { ensureSourceDetailsSearchFunction } from './source-details-search.ts';
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const LATEST_SCHEMA_VERSION = 7;
export type Database = DatabaseSync;
export type SqliteRow = Record<string, SQLOutputValue>;

type Authorizer = NonNullable<Parameters<DatabaseSync['setAuthorizer']>[0]>;
type AuthorizationObserver = (...args: Parameters<Authorizer>) => void;
interface ManagedAuthorization {
  setter: DatabaseSync['setAuthorizer'];
  refresh: () => void;
  readonly observers: Set<AuthorizationObserver>;
  readonly policyChanges: Set<() => void>;
  policy: Authorizer | null;
  callbackDepth: number;
  dispatchDepth: number;
  protectCallbacks: boolean;
  dispatch: Authorizer;
}
const managedAuthorizers = new WeakMap<DatabaseSync, ManagedAuthorization>();
const managedMethodEpochs = new WeakMap<DatabaseSync, object>();
const managedMethodSerials = new WeakMap<DatabaseSync, bigint>();
const callbackBarriers = new WeakMap<DatabaseSync, number>();
const nativeOwnDescriptor = Object.getOwnPropertyDescriptor;
const nativePrototypeOf = Object.getPrototypeOf;
const databasePrototype = DatabaseSync.prototype;
const nativeDatabaseMethods = new Map(
  ['function', 'aggregate', 'setAuthorizer', 'prepare', 'exec', 'applyChangeset'].map((name) => [
    name,
    nativeOwnDescriptor(databasePrototype, name)?.value,
  ]),
);
type ChangesetAuthorizationEvent = {
  readonly args: Parameters<Authorizer>;
  readonly answer: number;
};
declare const changesetInvocationBrand: unique symbol;
export interface RecordChangesetInvocation {
  readonly [changesetInvocationBrand]: true;
}
interface ChangesetInvocation {
  readonly db: DatabaseSync;
  readonly authorization: ManagedAuthorization;
  readonly methods: object;
  readonly observers: readonly AuthorizationObserver[];
  readonly policyChanges: readonly (() => void)[];
  readonly policy: Authorizer | null;
  readonly bytes: Buffer;
  readonly key: Buffer;
  total: StatementSync;
  main: StatementSync;
  temp: StatementSync;
  peer: StatementSync;
  readonly mainSchema: unknown;
  readonly tempSchema: unknown;
  readonly dataVersion: unknown;
  readonly tape: ChangesetAuthorizationEvent[];
  signature?: string;
  prepared: boolean;
  used: boolean;
  failed: boolean;
  failure?: unknown;
  statement?: StatementSync;
}
const changesetInvocations = new WeakMap<RecordChangesetInvocation, ChangesetInvocation>();
const terminalNativeAuthorizations = new WeakMap<StatementSync, ChangesetInvocation>();
const terminalNativeIterators = new WeakMap<
  Iterator<unknown>,
  { readonly statement: StatementSync; readonly item: ChangesetInvocation }
>();
const changesetAuthorizationScopes = new WeakMap<
  DatabaseSync,
  {
    readonly item: ChangesetInvocation;
    readonly mode: 'capture' | 'prepare' | 'replay';
    cursor: number;
  }
>();
const changesetTotalReads = new WeakMap<
  DatabaseSync,
  { readonly item: ChangesetInvocation; readonly statement: StatementSync; cursor: number }
>();
const changesetPrepare = DatabaseSync.prototype.prepare,
  changesetGet = StatementSync.prototype.get,
  changesetReadBigInts = StatementSync.prototype.setReadBigInts,
  changesetApply = DatabaseSync.prototype.applyChangeset;
const terminalNativeGet = StatementSync.prototype.get,
  terminalNativeAll = StatementSync.prototype.all,
  terminalNativeRun = StatementSync.prototype.run,
  terminalNativeColumns = StatementSync.prototype.columns,
  terminalNativeIterate = StatementSync.prototype.iterate;
let terminalIteratorNext: ((...args: unknown[]) => IteratorResult<unknown>) | undefined,
  terminalIteratorReturn: ((...args: unknown[]) => IteratorResult<unknown>) | undefined;
function prepareTerminalIteratorMethods(): void {
  if (terminalIteratorNext && terminalIteratorReturn) return;
  const probeDb = new DatabaseSync(':memory:');
  try {
    const probe = Reflect.apply(
      terminalNativeIterate,
      Reflect.apply(changesetPrepare, probeDb, ['SELECT 1']),
      [],
    );
    const prototype = Object.getPrototypeOf(probe);
    terminalIteratorNext = Object.getOwnPropertyDescriptor(prototype, 'next')?.value;
    terminalIteratorReturn = Object.getOwnPropertyDescriptor(prototype, 'return')?.value;
    if (typeof terminalIteratorNext !== 'function' || typeof terminalIteratorReturn !== 'function')
      changesetFailure();
    Reflect.apply(terminalIteratorReturn, probe, []);
  } finally {
    probeDb.close();
  }
}
// Bind iterator intrinsics before application policy callbacks can replace them.
prepareTerminalIteratorMethods();
function changesetFailure(item?: ChangesetInvocation, reason?: string): never {
  const error = Error(
    reason
      ? `Record changeset invocation refused ${reason}`
      : 'Record changeset invocation changed, escaped or was already consumed',
  );
  if (item) {
    item.failed = true;
    item.failure ??= error;
  }
  throw error;
}
/** SQLite may expire this counter's bytecode inside its changeset PRAGMAs.
 * Only this issuer-created native handle can enter the fixed builtin read slot. */
function readChangesetTotal(item: ChangesetInvocation): bigint {
  if (
    item.failed ||
    managedAuthorizers.get(item.db) !== item.authorization ||
    managedDatabaseMethodEpoch(item.db) !== item.methods ||
    managedDatabaseDataMethod(item.db, 'applyChangeset') !== changesetApply ||
    changesetAuthorizationScopes.get(item.db)?.item !== item ||
    item.authorization.dispatchDepth !== 1 ||
    changesetTotalReads.has(item.db)
  )
    changesetFailure(item, 'foreign or recursive write-count read');
  const slot = { item, statement: item.total, cursor: 0 };
  changesetTotalReads.set(item.db, slot);
  try {
    const result = Reflect.apply(changesetGet, slot.statement, []).n;
    if ((slot.cursor !== 0 && slot.cursor !== 2) || typeof result !== 'bigint')
      changesetFailure(item, 'incomplete write-count authorization');
    return result;
  } catch (error) {
    item.failed = true;
    throw item.failure ?? error;
  } finally {
    changesetTotalReads.delete(item.db);
  }
}
function changesetCurrent(item: ChangesetInvocation): void {
  const same = <T>(actual: Set<T>, expected: readonly T[]) =>
    actual.size === expected.length &&
    [...actual].every((entry, index) => entry === expected[index]);
  if (
    item.failed ||
    !item.db.isOpen ||
    managedAuthorizers.get(item.db) !== item.authorization ||
    managedDatabaseMethodEpoch(item.db) !== item.methods ||
    managedDatabaseDataMethod(item.db, 'applyChangeset') !== changesetApply ||
    item.authorization.policy !== item.policy ||
    !same(item.authorization.observers, item.observers) ||
    !same(item.authorization.policyChanges, item.policyChanges) ||
    (!item.statement &&
      (Reflect.apply(changesetGet, item.main, []).schema_version !== item.mainSchema ||
        Reflect.apply(changesetGet, item.temp, []).schema_version !== item.tempSchema ||
        Reflect.apply(changesetGet, item.peer, []).data_version !== item.dataVersion))
  )
    changesetFailure(item);
}
function changesetSignature(item: ChangesetInvocation): string {
  return createHmac('sha256', item.key)
    .update(item.bytes)
    .update(JSON.stringify(item.tape))
    .digest('hex');
}
function changesetScope<T>(
  item: ChangesetInvocation,
  mode: 'capture' | 'prepare' | 'replay',
  run: () => T,
): T {
  changesetCurrent(item);
  if (changesetAuthorizationScopes.has(item.db) || item.authorization.dispatchDepth)
    changesetFailure(item);
  const scope = { item, mode, cursor: 0 };
  changesetAuthorizationScopes.set(item.db, scope);
  try {
    const result = run();
    changesetCurrent(item);
    if (scope.cursor !== item.tape.length && !(item.statement && scope.cursor === 0))
      changesetFailure(item);
    return result;
  } catch (error) {
    item.failed = true;
    throw item.failure ?? error;
  } finally {
    changesetAuthorizationScopes.delete(item.db);
  }
}
/** The native invocation alone issues this transport. No caller-selected
 * filter, conflict handler or authorization transcript can create one. */
export function captureRecordChangesetInvocation(
  db: DatabaseSync,
  bytes: Uint8Array,
  originalChanges: bigint,
): RecordChangesetInvocation {
  if (!db.isTransaction) changesetFailure();
  const item = createNativeAuthorizationInvocation(db, bytes, originalChanges);
  try {
    if (
      !changesetScope(item, 'capture', () =>
        Reflect.apply(changesetApply, db, [
          item.bytes,
          { onConflict: () => constants.SQLITE_CHANGESET_ABORT },
        ]),
      )
    )
      changesetFailure(item);
    item.signature = changesetSignature(item);
    const capability = Object.freeze({}) as RecordChangesetInvocation;
    changesetInvocations.set(capability, item);
    return capability;
  } catch (error) {
    item.key.fill(0);
    item.bytes.fill(0);
    throw error;
  }
}
function createNativeAuthorizationInvocation(
  db: DatabaseSync,
  bytes: Uint8Array,
  originalChanges: bigint,
): ChangesetInvocation {
  const authorization = managedAuthorizers.get(db),
    methods = managedDatabaseMethodEpoch(db);
  if (
    !authorization ||
    !methods ||
    authorization.dispatchDepth ||
    callbackBarriers.has(db) ||
    changesetAuthorizationScopes.has(db) ||
    managedDatabaseDataMethod(db, 'applyChangeset') !== changesetApply
  )
    changesetFailure();
  prepareManagedDatabaseCallbackBarrier(db);
  const total = Reflect.apply(changesetPrepare, db, ['SELECT total_changes() AS n']),
    main = Reflect.apply(changesetPrepare, db, ['PRAGMA main.schema_version']),
    temp = Reflect.apply(changesetPrepare, db, ['PRAGMA temp.schema_version']),
    peer = Reflect.apply(changesetPrepare, db, ['PRAGMA main.data_version']);
  Reflect.apply(changesetReadBigInts, total, [true]);
  if (Reflect.apply(changesetGet, total, []).n !== originalChanges) changesetFailure();
  return {
    db,
    authorization: authorization!,
    methods: methods!,
    observers: [...authorization!.observers],
    policyChanges: [...authorization!.policyChanges],
    policy: authorization!.policy,
    bytes: Buffer.from(bytes),
    key: randomBytes(32),
    total,
    main,
    temp,
    peer,
    mainSchema: Reflect.apply(changesetGet, main, []).schema_version,
    tempSchema: Reflect.apply(changesetGet, temp, []).schema_version,
    dataVersion: Reflect.apply(changesetGet, peer, []).data_version,
    tape: [],
    prepared: false,
    used: false,
    failed: false,
  };
}

/** A native literal is freshly compiled under the installed policy. The
 * terminal issuer must separately bind this exact handle to its recipe owner. */
export function prepareTerminalAuthorizedStatement(
  db: DatabaseSync,
  sql: string,
  bigInts: boolean,
  originalChanges: bigint,
): StatementSync {
  prepareTerminalIteratorMethods();
  const item = createNativeAuthorizationInvocation(db, Buffer.from(sql), originalChanges);
  try {
    const statement = changesetScope(item, 'capture', () =>
      Reflect.apply(changesetPrepare, db, [sql]),
    );
    if (statement.sourceSQL.trim() !== sql.trim()) changesetFailure(item);
    Reflect.apply(changesetReadBigInts, statement, [bigInts]);
    item.statement = statement;
    item.signature = changesetSignature(item);
    item.prepared = true;
    terminalNativeAuthorizations.set(statement, item);
    return statement;
  } catch (error) {
    item.key.fill(0);
    item.bytes.fill(0);
    throw error;
  }
}
function currentTerminalNativeAuthorization(db: DatabaseSync, statement: StatementSync) {
  const item = terminalNativeAuthorizations.get(statement);
  if (
    !item ||
    item.db !== db ||
    item.statement !== statement ||
    !item.prepared ||
    !callbackBarriers.has(db) ||
    !terminalNativeStatementOwned(db, statement) ||
    changesetSignature(item) !== item.signature
  )
    changesetFailure(item);
  changesetCurrent(item!);
  return item!;
}
/** Fixed native invocation only; no caller callback or replacement method can
 * enter the freshly authorized exact-handle recompile slot. */
export function invokeTerminalAuthorizedStatement(
  db: DatabaseSync,
  statement: StatementSync,
  method: 'get' | 'all' | 'run' | 'columns',
  args: readonly unknown[],
): unknown {
  const item = currentTerminalNativeAuthorization(db, statement);
  const native = {
    get: terminalNativeGet,
    all: terminalNativeAll,
    run: terminalNativeRun,
    columns: terminalNativeColumns,
  }[method];
  if (!native) changesetFailure(item);
  return changesetScope(item, 'replay', () => Reflect.apply(native, statement, args));
}
export function iterateTerminalAuthorizedStatement(
  db: DatabaseSync,
  statement: StatementSync,
  args: readonly unknown[],
): Iterator<unknown> {
  const item = currentTerminalNativeAuthorization(db, statement);
  if (!terminalIteratorNext || !terminalIteratorReturn) changesetFailure(item);
  const iterator = changesetScope(item, 'replay', () =>
    Reflect.apply(terminalNativeIterate, statement, args),
  );
  terminalNativeIterators.set(iterator, { statement, item });
  return iterator;
}
export function stepTerminalAuthorizedIterator(
  db: DatabaseSync,
  iterator: Iterator<unknown>,
  method: 'next' | 'return',
): IteratorResult<unknown> {
  const retained = terminalNativeIterators.get(iterator);
  if (!retained) changesetFailure();
  const item = currentTerminalNativeAuthorization(db, retained!.statement);
  if (item !== retained!.item) changesetFailure(item);
  const native =
    method === 'next'
      ? terminalIteratorNext
      : method === 'return'
        ? terminalIteratorReturn
        : undefined;
  if (!native) changesetFailure(item);
  const result = changesetScope(item, 'replay', () => Reflect.apply(native!, iterator, []));
  return result;
}
export function closeTerminalAuthorizedStatement(statement: StatementSync): void {
  const item = terminalNativeAuthorizations.get(statement);
  if (!item) return;
  terminalNativeAuthorizations.delete(statement);
  item.failed = true;
  item.key.fill(0);
  item.bytes.fill(0);
}
/** Refresh the installed policy before the final physical proof. Its managed
 * dispatch context refuses nested SQL and preserves the genuine event tuples. */
export function prepareRecordChangesetInvocation(
  db: DatabaseSync,
  capability: RecordChangesetInvocation,
): void {
  const item = changesetInvocations.get(capability);
  if (!item || item.db !== db || item.used || item.prepared) changesetFailure(item);
  changesetCurrent(item!);
  if (changesetSignature(item!) !== item!.signature) changesetFailure(item);
  // Callback-barrier arming expires old bytecode. Refresh every native witness
  // before authorizing the transcript and before the final physical closure.
  item!.total = Reflect.apply(changesetPrepare, db, ['SELECT total_changes() AS n']);
  Reflect.apply(changesetReadBigInts, item!.total, [true]);
  item!.main = Reflect.apply(changesetPrepare, db, ['PRAGMA main.schema_version']);
  item!.temp = Reflect.apply(changesetPrepare, db, ['PRAGMA temp.schema_version']);
  item!.peer = Reflect.apply(changesetPrepare, db, ['PRAGMA main.data_version']);
  changesetScope(item!, 'prepare', () => {
    for (const event of item!.tape) item!.authorization.dispatch(...event.args);
  });
  item!.prepared = true;
}
/** Every actual internal SQLite compilation event must match its freshly
 * authorized native transcript. No external callback runs in this final slot. */
export function replayRecordChangesetInvocation(
  db: DatabaseSync,
  capability: RecordChangesetInvocation,
  bytes: Uint8Array,
): boolean {
  const item = changesetInvocations.get(capability);
  if (
    !item ||
    item.db !== db ||
    !item.prepared ||
    item.used ||
    !db.isTransaction ||
    !callbackBarriers.has(db) ||
    !terminalStatementsActive(db) ||
    !item.bytes.equals(bytes) ||
    changesetSignature(item) !== item.signature
  )
    changesetFailure(item);
  item!.used = true;
  return changesetScope(item!, 'replay', () =>
    Reflect.apply(changesetApply, db, [
      item!.bytes,
      {
        onConflict: () => constants.SQLITE_CHANGESET_ABORT,
      },
    ]),
  );
}
export function closeRecordChangesetInvocation(capability: RecordChangesetInvocation): void {
  const item = changesetInvocations.get(capability);
  if (!item) return;
  changesetInvocations.delete(capability);
  item.failed = true;
  item.key.fill(0);
  item.bytes.fill(0);
}
/** Identity only: never evaluate an accessor on the public database surface. */
export function managedDatabaseDataMethod(
  db: DatabaseSync,
  name: 'function' | 'aggregate' | 'setAuthorizer' | 'prepare' | 'exec' | 'applyChangeset',
): unknown {
  if (nativePrototypeOf(db) !== databasePrototype) return undefined;
  const own = nativeOwnDescriptor(db, name);
  if (own) return 'value' in own ? own.value : undefined;
  const inherited = nativeOwnDescriptor(databasePrototype, name),
    original = nativeDatabaseMethods.get(name);
  return inherited && 'value' in inherited && inherited.value === original ? original : undefined;
}
let nativeFunctionSignatures: Set<string> | undefined;
const functionSignature = (row: SqliteRow) =>
  JSON.stringify([row.name, row.builtin, row.type, row.enc, row.narg, row.flags]);
function sqliteNativeFunctions(): Set<string> {
  if (!nativeFunctionSignatures) {
    const native = new DatabaseSync(':memory:');
    try {
      nativeFunctionSignatures = new Set(
        native.prepare('PRAGMA function_list').all().map(functionSignature),
      );
    } finally {
      native.close();
    }
  }
  return nativeFunctionSignatures;
}
function assertManagedDatabaseCallbackAllowed(db: DatabaseSync): void {
  if (callbackBarriers.has(db))
    throw Error('Managed database callback refused during terminal publication');
}

/** Cached native statements may execute after evidence verification, but a
 * reprepare or custom scalar must not enter JavaScript inside that last seal. */
export function withoutManagedDatabaseCallbacks<T>(db: DatabaseSync, run: () => T): T {
  if (
    !managedDatabaseMethodEpoch(db) ||
    managedFunctions.get(db)!.unwrapped.size ||
    !managedAuthorizers.get(db)?.protectCallbacks
  )
    throw Error('Terminal database callback barrier requires managed scalar registration');
  const depth = callbackBarriers.get(db) ?? 0;
  callbackBarriers.set(db, depth + 1);
  try {
    const result = run();
    if (
      result &&
      (typeof result === 'object' || typeof result === 'function') &&
      (typeof (result as { then?: unknown }).then === 'function' ||
        typeof (result as { next?: unknown }).next === 'function')
    )
      throw Error('Terminal database callback barrier requires synchronous work');
    return result;
  } finally {
    if (depth) callbackBarriers.set(db, depth);
    else callbackBarriers.delete(db);
  }
}

/** Arm before compiling terminal statements, never after their authorization. */
export function prepareManagedDatabaseCallbackBarrier(db: DatabaseSync): void {
  const state = managedAuthorizers.get(db);
  if (!state || !managedDatabaseMethodEpoch(db) || managedFunctions.get(db)!.unwrapped.size)
    throw Error('Terminal database callback barrier requires managed scalar registration');
  if (!state.protectCallbacks) {
    state.protectCallbacks = true;
    state.refresh();
  }
}
function rotateManagedMethodEpoch(db: DatabaseSync): void {
  managedMethodEpochs.set(db, {});
  managedMethodSerials.set(db, (managedMethodSerials.get(db) ?? 0n) + 1n);
}
const managedFunctions = new WeakMap<
  DatabaseSync,
  {
    setter: DatabaseSync['function'];
    aggregateSetter: DatabaseSync['aggregate'];
    observers: Set<(name: string) => void>;
    unwrapped: Set<string>;
  }
>();

export function installManagedDatabaseFunctionRegistration(db: DatabaseSync): void {
  if (managedFunctions.has(db)) return;
  const nativeFunction = db.function;
  const nativeAggregate = db.aggregate;
  const observers = new Set<(name: string) => void>();
  const functions = db.prepare('PRAGMA function_list').all();
  const unwrapped = new Set(
    functions
      .filter((row) => !sqliteNativeFunctions().has(functionSignature(row)))
      .map((row) => String(row.name).toLowerCase()),
  );
  const builtins = new Set(
    functions
      .filter((row) => row.builtin === 1 && typeof row.name === 'string')
      .map((row) => (row.name as string).toLowerCase()),
  );
  const setter = function (this: DatabaseSync, ...args: Parameters<DatabaseSync['function']>) {
    if (this === db) assertManagedDatabaseCallbackAllowed(db);
    if (this === db) {
      rotateManagedMethodEpoch(db);
      for (const observer of observers) {
        try {
          observer(args[0]);
        } catch {
          /* Disposable observation cannot replace native registration. */
        }
      }
    }
    if (this === db && builtins.has(args[0].toLowerCase()))
      throw Error('Replacing a SQLite built-in function is unsupported');
    const callbackIndex = args.length - 1,
      callback = args[callbackIndex];
    if (this === db && typeof callback === 'function') {
      const guarded = function (this: unknown, ...values: unknown[]) {
        if (
          !intakeFrontierTerminalEvent(db, callback) &&
          !intakeProjectionTerminalEvent(db, callback)
        )
          assertManagedDatabaseCallbackAllowed(db);
        return Reflect.apply(callback, this, values);
      };
      Object.defineProperty(guarded, 'length', { value: callback.length });
      args[callbackIndex] = guarded as never;
    }
    // A same-name registration may replace only one SQLite arity. Never
    // rehabilitate a connection that already contained an unwrapped overload.
    return Reflect.apply(nativeFunction, this, args);
  } as DatabaseSync['function'];
  const aggregateSetter = function (
    this: DatabaseSync,
    ...args: Parameters<DatabaseSync['aggregate']>
  ) {
    if (this !== db) return Reflect.apply(nativeAggregate, this, args);
    assertManagedDatabaseCallbackAllowed(db);
    rotateManagedMethodEpoch(db);
    for (const observer of observers) {
      try {
        observer(args[0]);
      } catch {
        /* Observation cannot replace native registration. */
      }
    }
    if (builtins.has(args[0].toLowerCase()))
      throw Error('Replacing a SQLite built-in function is unsupported');
    const options = { ...args[1] };
    for (const name of ['start', 'step', 'inverse', 'result'] as const) {
      const callback = options[name];
      if (typeof callback !== 'function') continue;
      const guarded = function (this: unknown, ...values: unknown[]) {
        assertManagedDatabaseCallbackAllowed(db);
        return Reflect.apply(callback, this, values);
      };
      Object.defineProperty(guarded, 'length', { value: callback.length });
      options[name] = guarded as never;
    }
    return Reflect.apply(nativeAggregate, this, [args[0], options]);
  } as DatabaseSync['aggregate'];
  db.function = setter;
  db.aggregate = aggregateSetter;
  managedFunctions.set(db, { setter, aggregateSetter, observers, unwrapped });
  rotateManagedMethodEpoch(db);
}

/** Private identity for read proofs; failed registrations also invalidate prior reads. */
export function managedDatabaseMethodEpoch(db: DatabaseSync): object | undefined {
  if (
    !db.isOpen ||
    managedDatabaseDataMethod(db, 'function') !== managedFunctions.get(db)?.setter ||
    managedDatabaseDataMethod(db, 'aggregate') !== managedFunctions.get(db)?.aggregateSetter ||
    managedDatabaseDataMethod(db, 'setAuthorizer') !== managedAuthorizers.get(db)?.setter
  )
    return undefined;
  return managedMethodEpochs.get(db);
}

/** Monotonic method mutation count; undefined when managed wrappers are replaced. */
export function managedDatabaseMethodSerial(db: DatabaseSync): bigint | undefined {
  return managedDatabaseMethodEpoch(db) ? managedMethodSerials.get(db) : undefined;
}

export function observeManagedDatabaseFunctionRegistration(
  db: DatabaseSync,
  observer: (name: string) => void,
): (() => void) | undefined {
  const state = managedFunctions.get(db);
  if (!state || db.function !== state.setter) return undefined;
  state.observers.add(observer);
  return () => state.observers.delete(observer);
}

export function managedDatabaseFunctionSetter(
  db: DatabaseSync,
): DatabaseSync['function'] | undefined {
  return managedFunctions.get(db)?.setter;
}

/** Install before a connection exposes mutable authorizer policy to consumers. */
export function installManagedDatabaseAuthorization(db: DatabaseSync): void {
  if (managedAuthorizers.has(db)) return;
  const nativeSetter = db.setAuthorizer;
  const state: ManagedAuthorization = {
    setter: undefined as unknown as DatabaseSync['setAuthorizer'],
    refresh: () => {},
    observers: new Set(),
    policyChanges: new Set(),
    policy: null,
    callbackDepth: 0,
    dispatchDepth: 0,
    protectCallbacks: false,
    dispatch: undefined as unknown as Authorizer,
  };
  const notify = (callback: () => void) => {
    state.callbackDepth++;
    try {
      callback();
    } finally {
      state.callbackDepth--;
    }
  };
  const setter = function (this: DatabaseSync, policy: Authorizer | null) {
    if (this !== db) return Reflect.apply(nativeSetter, this, [policy]);
    assertManagedDatabaseCallbackAllowed(db);
    rotateManagedMethodEpoch(db);
    for (const changed of state.policyChanges) notify(changed);
    state.policy = policy;
    state.refresh();
  } as DatabaseSync['setAuthorizer'];
  state.setter = setter;
  const dispatch: Authorizer = (...args) => {
    const totalRead = changesetTotalReads.get(db);
    if (totalRead) {
      const { item } = totalRead,
        expected: Parameters<Authorizer> =
          totalRead.cursor === 0
            ? [constants.SQLITE_SELECT, null, null, null, null]
            : [constants.SQLITE_FUNCTION, null, 'total_changes', null, null];
      if (
        item.failed ||
        state !== item.authorization ||
        state.dispatchDepth !== 1 ||
        changesetAuthorizationScopes.get(db)?.item !== item ||
        totalRead.statement !== item.total ||
        totalRead.cursor >= 2 ||
        JSON.stringify(args) !== JSON.stringify(expected)
      )
        changesetFailure(item, 'unexpected write-count authorization');
      totalRead.cursor++;
      return constants.SQLITE_OK;
    }
    const scope = changesetAuthorizationScopes.get(db);
    if (scope) {
      const { item } = scope;
      if (state !== item.authorization || state.dispatchDepth)
        changesetFailure(item, 'nested authorization');
      if (scope.mode !== 'capture') {
        const event = item.tape[scope.cursor];
        if (!event || JSON.stringify(args) !== JSON.stringify(event.args)) changesetFailure(item);
        if (scope.mode === 'replay') {
          scope.cursor++;
          return event!.answer;
        }
      }
    }
    assertManagedDatabaseCallbackAllowed(db);
    state.dispatchDepth++;
    try {
      const before = scope && readChangesetTotal(scope.item);
      if (scope?.mode !== 'prepare')
        for (const observer of state.observers) notify(() => observer(...args));
      const answer = state.policy?.(...args) ?? constants.SQLITE_OK;
      if (scope) {
        if (readChangesetTotal(scope.item) !== before)
          changesetFailure(scope.item, 'authorization callback writes');
        if (scope.mode === 'capture')
          scope.item.tape.push(
            Object.freeze({ args: Object.freeze([...args]) as Parameters<Authorizer>, answer }),
          );
        else if (answer !== scope.item.tape[scope.cursor]?.answer) changesetFailure(scope.item);
        scope.cursor++;
      }
      return answer;
    } catch (error) {
      if (scope) scope.item.failure ??= error;
      throw error;
    } finally {
      state.dispatchDepth--;
    }
  };
  state.dispatch = dispatch;
  state.refresh = () =>
    nativeSetter.call(
      db,
      state.policy || state.observers.size || state.protectCallbacks ? dispatch : null,
    );
  db.setAuthorizer = setter;
  managedAuthorizers.set(db, state);
  rotateManagedMethodEpoch(db);
}

/** Distinguishes observer SQL from the statement whose policy it is observing. */
export function managedDatabaseAuthorizationCallbackActive(db: DatabaseSync): boolean {
  return (managedAuthorizers.get(db)?.callbackDepth ?? 0) > 0;
}
/** Nested SQL dispatched from a policy/observer is never an owner's compile slot. */
export function managedDatabaseAuthorizationNestedCallbackActive(db: DatabaseSync): boolean {
  return (managedAuthorizers.get(db)?.dispatchDepth ?? 0) > 1;
}

export function observeManagedDatabaseAuthorization(
  db: DatabaseSync,
  observer: AuthorizationObserver,
  onPolicyChange: () => void,
): (() => void) | undefined {
  const state = managedAuthorizers.get(db);
  if (!state || db.setAuthorizer !== state.setter) return undefined;
  state.observers.add(observer);
  state.policyChanges.add(onPolicyChange);
  state.refresh();
  return () => {
    state.observers.delete(observer);
    state.policyChanges.delete(onPolicyChange);
    state.refresh();
  };
}

export function managedDatabaseAuthorizerSetter(
  db: DatabaseSync,
): DatabaseSync['setAuthorizer'] | undefined {
  return managedAuthorizers.get(db)?.setter;
}

/** Expire prepared SQLite authorization decisions without changing user policy. */
export function rearmManagedDatabaseAuthorization(db: DatabaseSync): boolean {
  const state = managedAuthorizers.get(db);
  if (!state || db.setAuthorizer !== state.setter) return false;
  state.refresh();
  return true;
}

export const databaseSchemaVersion = (db: DatabaseSync): number => {
  const row = terminalStatement(db, 'SELECT MAX(version) AS version FROM schema_migrations').get();
  return Number(row?.version ?? 0);
};

export function openDatabase(path?: string | null, profileId?: string): DatabaseSync {
  if (profileId === undefined) {
    if (!path) throw new Error('Choose an explicit profile and database path');
    profileId = readDatabaseOwner(path);
  }
  if (!validProfileId(profileId)) throw new Error('Unknown profile');
  path ??= profilePaths(REPO_ROOT, profileId).database;
  if (existsSync(path) && statSync(path).size > 0 && readDatabaseOwner(path) !== profileId)
    throw new Error('Database belongs to a different profile');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  let inTransaction = false;
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    const fresh = !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    if (fresh)
      db.exec(readFileSync(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8'));
    const versions = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => Number(row.version));
    if (
      !versions.length ||
      versions.length > LATEST_SCHEMA_VERSION ||
      versions.some((version, index) => version !== index + 1)
    )
      throw new Error('Unsupported or inconsistent database schema version');
    const owner = db
      .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
      .get()?.value;
    if (!fresh && owner === undefined)
      throw new Error(
        'Database has no verified profile owner; explicit ownership recovery is required',
      );
    if (owner !== undefined && owner !== profileId)
      throw new Error('Database belongs to a different profile');
    db.prepare("INSERT OR IGNORE INTO app_meta(key,value) VALUES('owner_profile_id',?)").run(
      profileId,
    );
    if (databaseSchemaVersion(db) < 2)
      db.exec(
        readFileSync(new URL('./migrations/002-procedure-categories.sql', import.meta.url), 'utf8'),
      );
    if (fresh)
      db.prepare("UPDATE people SET display_name=? WHERE id='patient'").run(
        profileDefinition(profileId).defaultName,
      );
    if (databaseSchemaVersion(db) < 3)
      db.exec(
        readFileSync(new URL('./migrations/003-note-series-links.sql', import.meta.url), 'utf8'),
      );
    if (databaseSchemaVersion(db) < 4)
      db.exec(
        readFileSync(
          new URL('./migrations/004-personal-medication-status.sql', import.meta.url),
          'utf8',
        ),
      );
    if (databaseSchemaVersion(db) < 5)
      db.exec(
        readFileSync(new URL('./migrations/005-note-text-formats.sql', import.meta.url), 'utf8'),
      );
    if (databaseSchemaVersion(db) < 6)
      db.exec(
        readFileSync(new URL('./migrations/006-visibility-events.sql', import.meta.url), 'utf8'),
      );
    if (databaseSchemaVersion(db) < 7)
      db.exec(
        readFileSync(
          new URL('./migrations/007-condition-occurrences.sql', import.meta.url),
          'utf8',
        ),
      );
    // Disposable lookup only: retained accepted decisions remain authoritative.
    // It is recreated with the cache and does not change the journal schema.
    db.exec(`CREATE INDEX IF NOT EXISTS manual_batches_native_correction_source
      ON manual_batches(json_extract(coverage_json,'$.sourceRecordId'),id)
      WHERE title='Accepted clinical contribution'
        AND json_type(coverage_json,'$.reviewDraftHistory')='object'`);
    db.exec('COMMIT');
    inTransaction = false;
    installManagedDatabaseAuthorization(db);
    installManagedDatabaseFunctionRegistration(db);
    ensureSourceDetailsSearchFunction(db);
    return db;
  } catch (error) {
    if (inTransaction) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
}
export function json(source: unknown, fallback: unknown = null): unknown {
  try {
    // JSON.parse performs the same ToString coercion at runtime. The assertion
    // models that built-in boundary without claiming parsed storage is trusted.
    return JSON.parse(source as string) as unknown;
  } catch {
    return fallback;
  }
}
// SQLite datetime('now') values in app-managed metadata are UTC. Only adapt
// their exact timestamp shape for API presentation; never use this helper on
// provider clinical dates, event dates, or stored source evidence.
export function managedTimestamp<T>(value: T): T | string {
  if (typeof value !== 'string') return value;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(value);
  return match ? `${match[1]}T${match[2]}Z` : value;
}
export const now = () => new Date().toISOString();
const revisionStatements = new WeakMap<
  DatabaseSync,
  { statement: ReturnType<DatabaseSync['prepare']>; busy: boolean }
>();
export const revision = (db: DatabaseSync): number => {
  const sql = "SELECT value FROM app_meta WHERE key='revision'";
  if (terminalStatementsActive(db)) return Number(terminalStatement(db, sql).get()?.value || 0);
  let cached = revisionStatements.get(db);
  // A reentrant SQL function must retain the original fresh-statement behavior.
  if (cached?.busy) return Number(terminalStatement(db, sql).get()?.value || 0);
  if (!cached) {
    const entry = { statement: terminalStatement(db, sql), busy: false };
    observeDatabaseClose(db, () => {
      if (revisionStatements.get(db) === entry) revisionStatements.delete(db);
    });
    revisionStatements.set(db, (cached = entry));
  }
  cached.busy = true;
  try {
    return Number(terminalStatement(db, sql, cached.statement).get()?.value || 0);
  } finally {
    cached.busy = false;
  }
};
/** Clinical review authority excludes source-text-only journal revisions. */
export const clinicalReviewRevision = (db: DatabaseSync): number =>
  Number(
    db.prepare("SELECT value FROM app_meta WHERE key='clinical_review_revision'").get()?.value ??
      revision(db),
  );

export interface TransactionOperation {
  operationId?: unknown;
  fingerprint?: unknown;
  expectedRevision?: unknown;
  intakeMaintenance?: IntakeMaintenancePublication;
  [key: string]: unknown;
}

export interface TransactionRetry<T = unknown> {
  replayed: boolean;
  result: T;
}

export interface TransactionDurabilityHooks<Capture = unknown, Result = unknown> {
  begin?(operation: TransactionOperation): TransactionRetry<Result> | void;
  capture?(): Capture;
  release?(captured: Capture | undefined): void;
  markDirty?(): void;
  prepare(
    captured: Capture | undefined,
    context: { operation: TransactionOperation; result: Result },
  ): void;
  flush?(): void;
}

const durabilityHooks = new WeakMap<DatabaseSync, TransactionDurabilityHooks>();
export function registerTransactionDurability<Capture, Result>(
  db: DatabaseSync,
  hooks: TransactionDurabilityHooks<Capture, Result> | null | undefined,
): void {
  if (hooks) durabilityHooks.set(db, hooks as TransactionDurabilityHooks);
  else durabilityHooks.delete(db);
  rotateTransactionObserverSerial(db);
}
/** Whether a real transaction durability participant is already attached. */
export function hasTransactionDurability(db: DatabaseSync): boolean {
  return durabilityHooks.has(db);
}
/** Read-only identity; this neither registers nor certifies a participant. */
export function transactionDurabilityParticipantCurrent(
  db: DatabaseSync,
  participant: unknown,
): boolean {
  return durabilityHooks.get(db) === participant;
}
/** Memory-only observers; accepted-record durability hooks retain their ordering. */
export type TransactionOutcome = {
  token: object;
  committed: boolean;
  succeeded: boolean;
  /** A genuine record-owner planning transaction rolled back after retaining
   * its tentative write set. This is never an accepted or replayed operation. */
  prepared?: true;
  /** Set only by the transaction owner after exact maintenance verification,
   * successful commit, durable flush and participant cleanup. */
  intakeMaintenance?: true;
};
const transactionTokens = new WeakMap<DatabaseSync, object>();
const transactionFailures = new WeakMap<DatabaseSync, unknown>();
const terminalTransactionGuards = new WeakMap<
  DatabaseSync,
  {
    token: object;
    check: () => void;
  }
>();
/** A failed staged storage write must abort its outer transaction even if caught. */
export function rejectCurrentTransaction(db: DatabaseSync, error: unknown): void {
  if (!transactionTokens.has(db)) throw Error('No application transaction');
  transactionFailures.set(db, error);
}
/** A fixed owner may close a synchronous publication witness immediately before
 * revision and durability work. The guard is bound to this exact transaction. */
export function installTransactionTerminalGuard(
  db: DatabaseSync,
  token: object,
  check: () => void,
): () => void {
  if (transactionTokens.get(db) !== token || terminalTransactionGuards.has(db))
    throw Error('Foreign or competing terminal transaction guard');
  const guard = { token, check };
  terminalTransactionGuards.set(db, guard);
  return () => {
    if (!terminalTransactionGuards.has(db) && transactionTokens.get(db) !== token) return;
    if (terminalTransactionGuards.get(db) !== guard)
      throw Error('Terminal transaction guard changed');
    terminalTransactionGuards.delete(db);
  };
}
const outcomeObservers = new WeakMap<DatabaseSync, Set<(outcome: TransactionOutcome) => void>>();
const closeObservers = new WeakMap<DatabaseSync, Set<() => void>>();
/** Dispose connection-owned resources after actual close, including explicit
 * resource management. Cleanup cannot replace the native close result or
 * prevent another observer from releasing its resources. */
export function observeDatabaseClose(db: DatabaseSync, observer: () => void): () => void {
  if (!db.isOpen) throw Error('Cannot observe a closed database');
  let observers = closeObservers.get(db);
  if (!observers) {
    closeObservers.set(db, (observers = new Set()));
    const notify = () => {
      if (db.isOpen) return;
      const pending = [...(closeObservers.get(db) ?? [])];
      closeObservers.get(db)?.clear();
      for (const cleanup of pending) {
        try {
          cleanup();
        } catch {
          /* Disposable cleanup cannot change the close acknowledgement. */
        }
      }
    };
    const close = db.close;
    db.close = function () {
      try {
        return close.call(this);
      } finally {
        if (this === db) notify();
      }
    };
    const dispose = db[Symbol.dispose];
    db[Symbol.dispose] = function () {
      try {
        return dispose.call(this);
      } finally {
        if (this === db) notify();
      }
    };
  }
  observers.add(observer);
  return () => observers.delete(observer);
}
const beforePublicationObservers = new WeakMap<DatabaseSync, Set<(token: object) => void>>();
const startObservers = new WeakMap<DatabaseSync, Set<(token: object) => void>>();
const transactionObserverSerials = new WeakMap<DatabaseSync, bigint>();
const rotateTransactionObserverSerial = (db: DatabaseSync) =>
  transactionObserverSerials.set(db, (transactionObserverSerials.get(db) ?? 0n) + 1n);
declare const recordReplayBrand: unique symbol;
export interface PreparedRecordReplay {
  readonly [recordReplayBrand]: true;
}
const recordReplays = new WeakMap<
  PreparedRecordReplay,
  {
    db: DatabaseSync;
    original: object;
    serial: bigint;
    hooks: TransactionDurabilityHooks | undefined;
    used: boolean;
    outcome?: TransactionOutcome;
  }
>();
/** Transaction transport only. The record owner must separately close its
 * original backing, frozen write recipe and durable intent before using it. */
export function prepareRecordReplay(db: DatabaseSync, original: object): PreparedRecordReplay {
  if (
    db.isTransaction ||
    !recordPreparedReplayCurrent(db, original) ||
    !recordTerminalDurabilityParticipant(db, durabilityHooks.get(db)) ||
    [...(startObservers.get(db) ?? [])].some(
      (callback) => !intakeFrontierTerminalStart(db, callback),
    )
  )
    throw Error('Record replay requires its genuine released preparation');
  const capability = Object.freeze({}) as PreparedRecordReplay;
  recordReplays.set(capability, {
    db,
    original,
    serial: transactionObserverSerials.get(db) ?? 0n,
    hooks: durabilityHooks.get(db),
    used: false,
  });
  return capability;
}
export function recordReplayCurrent(db: DatabaseSync, capability: PreparedRecordReplay): boolean {
  const item = recordReplays.get(capability);
  return (
    !!item &&
    item.db === db &&
    !item.used &&
    !db.isTransaction &&
    recordPreparedReplayCurrent(db, item.original) &&
    item.serial === (transactionObserverSerials.get(db) ?? 0n) &&
    durabilityHooks.get(db) === item.hooks &&
    recordTerminalDurabilityParticipant(db, item.hooks)
  );
}
/** The finite native scope owns BEGIN/COMMIT/ROLLBACK. No preparatory callbacks
 * or business logic are rerun; ordinary observers already saw the honest T1. */
export function executeRecordReplay<T>(
  db: DatabaseSync,
  capability: PreparedRecordReplay,
  body: (token: object) => T,
): T {
  if (!terminalStatementsActive(db) || !recordReplayCurrent(db, capability))
    throw Error('Foreign or expired record replay');
  const item = recordReplays.get(capability)!;
  item.used = true;
  const token = Object.freeze({});
  let committed = false,
    maintenance = false,
    failed = false,
    firstFailure: unknown,
    result: T | undefined;
  terminalExecution(db, 'BEGIN IMMEDIATE');
  transactionTokens.set(db, token);
  try {
    for (const observer of startObservers.get(db) ?? []) observer(token);
    result = body(token);
    if (
      result &&
      (typeof result === 'object' || typeof result === 'function') &&
      ('then' in result || Symbol.iterator in result || Symbol.asyncIterator in result)
    )
      throw Error('Record replay requires synchronous nonescaping work');
    maintenance = recordPreparedMaintenanceReplayVerified(db, item.original, token);
    terminalExecution(db, 'COMMIT');
    committed = true;
  } catch (error) {
    failed = true;
    firstFailure = error;
  } finally {
    try {
      if (!committed && db.isTransaction) terminalExecution(db, 'ROLLBACK');
    } catch (error) {
      if (!failed) {
        failed = true;
        firstFailure = error;
      }
    } finally {
      transactionFailures.delete(db);
      terminalTransactionGuards.delete(db);
      transactionTokens.delete(db);
      item.outcome = Object.freeze({
        token,
        committed,
        succeeded: committed,
        ...(committed && maintenance ? { intakeMaintenance: true as const } : {}),
      });
    }
  }
  if (failed) throw firstFailure;
  return result as T;
}
/** Notifications are not publication authority. They run only after the finite
 * scope expires; mutation by one cannot certify a later child's originals. */
export function notifyRecordReplay(
  db: DatabaseSync,
  capability: PreparedRecordReplay,
): TransactionOutcome | undefined {
  const item = recordReplays.get(capability);
  if (!item || item.db !== db || db.isTransaction || terminalStatementsActive(db))
    throw Error('Record replay outcome is not closed');
  recordReplays.delete(capability);
  if (!item.outcome) return undefined;
  for (const observer of outcomeObservers.get(db) ?? []) {
    try {
      observer(item.outcome);
    } catch {
      /* notifications cannot change acknowledgement */
    }
  }
  return item.outcome;
}
declare const terminalCallbacksBrand: unique symbol;
export interface TerminalTransactionCallbacks {
  readonly [terminalCallbacksBrand]: true;
}
const terminalCallbacks = new WeakMap<
  TerminalTransactionCallbacks,
  { db: DatabaseSync; serial: bigint; hooks: TransactionDurabilityHooks | undefined }
>();
/** Only actual lexical issuers qualify; a caller-created issuer is unrelated.
 * Fixed-SQL frontier notifications still need the terminal statement resolver. */
export function prepareTerminalTransactionCallbacks(
  db: DatabaseSync,
): TerminalTransactionCallbacks {
  if (
    db.isTransaction ||
    !recordTerminalDurabilityParticipant(db, durabilityHooks.get(db)) ||
    (beforePublicationObservers.get(db)?.size ?? 0) !== 0 ||
    [...(startObservers.get(db) ?? [])].some(
      (callback) => !intakeFrontierTerminalStart(db, callback),
    ) ||
    [...(outcomeObservers.get(db) ?? [])].some(
      (callback) =>
        ![
          intakeFrontierTerminalOutcome,
          intakeProjectionTerminalOutcome,
          sourceDetailsTerminalOutcome,
          sourceTextTerminalOutcome,
          intakeLookupTerminalOutcome,
          intakeDiscoveryTerminalOutcome,
          intakeSourceContextTerminalOutcome,
          intakeStateTerminalOutcome,
        ].some((recognizes) => recognizes(db, callback)),
    )
  )
    throw Error('Compact publication has unsupported transaction callbacks');
  const capability = Object.freeze({}) as TerminalTransactionCallbacks;
  terminalCallbacks.set(capability, {
    db,
    serial: transactionObserverSerials.get(db) ?? 0n,
    hooks: durabilityHooks.get(db),
  });
  return capability;
}
export function terminalTransactionCallbacksCurrent(
  db: DatabaseSync,
  capability: TerminalTransactionCallbacks,
): boolean {
  const item = terminalCallbacks.get(capability);
  return (
    !!item &&
    item.db === db &&
    db.isOpen &&
    (transactionObserverSerials.get(db) ?? 0n) === item.serial &&
    durabilityHooks.get(db) === item.hooks &&
    recordTerminalDurabilityParticipant(db, item.hooks)
  );
}
export function observeTransactionStart(
  db: DatabaseSync,
  observer: (token: object) => void,
): () => void {
  let observers = startObservers.get(db);
  if (!observers) startObservers.set(db, (observers = new Set()));
  observers.add(observer);
  rotateTransactionObserverSerial(db);
  return () => {
    observers.delete(observer);
    rotateTransactionObserverSerial(db);
  };
}
/** Read-only witnesses inspect the caller write set before durability work.
 * Their exceptions are isolated; an owner may explicitly reject this transaction. */
export function observeTransactionBeforePublication(
  db: DatabaseSync,
  observer: (token: object) => void,
): () => void {
  let observers = beforePublicationObservers.get(db);
  if (!observers) beforePublicationObservers.set(db, (observers = new Set()));
  observers.add(observer);
  rotateTransactionObserverSerial(db);
  return () => {
    observers.delete(observer);
    rotateTransactionObserverSerial(db);
  };
}
export function currentTransactionToken(db: DatabaseSync): object | undefined {
  return transactionTokens.get(db);
}
export function observeTransactionOutcome(
  db: DatabaseSync,
  observer: (outcome: TransactionOutcome) => void,
): () => void {
  let observers = outcomeObservers.get(db);
  if (!observers) outcomeObservers.set(db, (observers = new Set()));
  observers.add(observer);
  rotateTransactionObserverSerial(db);
  return () => {
    observers.delete(observer);
    rotateTransactionObserverSerial(db);
  };
}
export function transaction<T>(
  db: DatabaseSync,
  fn: () => T,
  operation: TransactionOperation = {},
): T {
  terminalExecution(db, 'BEGIN IMMEDIATE');
  let committed = false;
  let rolledBack = false;
  let prepared = false;
  let succeeded = false;
  let verifiedIntakeMaintenance = false;
  const token = {};
  transactionTokens.set(db, token);
  for (const observer of startObservers.get(db) ?? []) {
    try {
      observer(token);
    } catch {
      /* memory-only witnesses cannot change a durable transaction */
    }
  }
  const hooks = durabilityHooks.get(db);
  let hooksAdmitted = true;
  let captured;
  try {
    // A planning owner must reject start-observer hook substitution BEFORE
    // dispatching any begin/capture/prepare callback from that replacement.
    try {
      recordTransactionPreparationRequested(db, operation);
    } catch (error) {
      hooksAdmitted = false;
      throw error;
    }
    if (operation.intakeMaintenance) {
      if (!hooks?.capture) throw Error('Intake maintenance requires accepted-row capture');
      beginIntakeMaintenancePublication(db, operation.intakeMaintenance, token, operation);
    }
    const retry = hooks?.begin?.(operation);
    if (retry?.replayed) {
      if (recordTransactionPreparationRequested(db, operation))
        throw Error('Record preparation cannot reuse an accepted transaction');
      if (operation.intakeMaintenance)
        throw Error('Intake maintenance replay must be resolved before preparation');
      terminalExecution(db, 'COMMIT');
      committed = true;
      succeeded = true;
      return retry.result as T;
    }
    captured = hooks?.capture?.();
    const result = fn();
    if (transactionFailures.has(db)) throw transactionFailures.get(db);
    if (operation.intakeMaintenance) {
      verifyIntakeMaintenancePublication(db, operation.intakeMaintenance, token, result);
      verifiedIntakeMaintenance = true;
    }
    for (const observer of beforePublicationObservers.get(db) ?? []) {
      try {
        observer(token);
      } catch {
        /* memory-only witnesses must remain ineligible after a failed check */
      }
    }
    if (transactionFailures.has(db)) throw transactionFailures.get(db);
    const terminalGuard = terminalTransactionGuards.get(db);
    if (terminalGuard) {
      if (terminalGuard.token !== token) throw Error('Foreign terminal transaction guard');
      terminalGuard.check();
    }
    recordPreparationBeforeBookkeeping(db, operation);
    const clinicalInsert = expectIntakeFrontierMetaWrite(db, 'clinical_review_revision', [
      'insert',
    ]);
    let clinicalInserted = false;
    try {
      clinicalInserted =
        terminalStatement(
          db,
          "INSERT OR IGNORE INTO app_meta(key,value) VALUES('clinical_review_revision',(SELECT value FROM app_meta WHERE key='revision'))",
        ).run().changes === 1;
    } finally {
      finishIntakeFrontierMetaWrite(db, clinicalInsert, clinicalInserted);
    }
    if (operation.actor !== 'source-text' && !operation.intakeMaintenance) {
      const clinicalUpdate = expectIntakeFrontierMetaWrite(db, 'clinical_review_revision', [
        'update',
      ]);
      try {
        terminalExecution(
          db,
          "UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='clinical_review_revision'",
        );
      } finally {
        finishIntakeFrontierMetaWrite(db, clinicalUpdate, true);
      }
    }
    const revisionUpdate = expectIntakeFrontierMetaWrite(db, 'revision', ['update']);
    try {
      terminalExecution(
        db,
        "UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'",
      );
    } finally {
      finishIntakeFrontierMetaWrite(db, revisionUpdate, true);
    }
    hooks?.markDirty?.();
    // The recoverable intent must reach durable profile storage before an
    // ephemeral SQLite COMMIT can be acknowledged.
    hooks?.prepare(captured, { operation, result });
    if (recordTransactionPreparationCaptured(db, operation, token)) {
      terminalExecution(db, 'ROLLBACK');
      rolledBack = true;
      prepared = true;
      return result;
    }
    terminalExecution(db, 'COMMIT');
    committed = true;
    // Publication may be retried from the durable intent, even after losing
    // this database and its WAL entirely.
    hooks?.flush?.();
    succeeded = true;
    return result;
  } catch (error) {
    if (!committed && !rolledBack) terminalExecution(db, 'ROLLBACK');
    throw error;
  } finally {
    if (operation.intakeMaintenance)
      finishIntakeMaintenancePublication(operation.intakeMaintenance, token);
    transactionFailures.delete(db);
    terminalTransactionGuards.delete(db);
    // Read at completion: observers can register while fn stages its first value.
    try {
      if (hooksAdmitted) hooks?.release?.(captured);
    } catch (error) {
      succeeded = false;
      throw error;
    } finally {
      transactionTokens.delete(db);
      for (const observer of outcomeObservers.get(db) ?? []) {
        // A disposable-cache observer cannot change a durable acknowledgement
        // or suppress cleanup by another observer.
        try {
          observer({
            token,
            committed,
            succeeded,
            ...(prepared ? { prepared: true as const } : {}),
            ...(verifiedIntakeMaintenance && committed && succeeded
              ? { intakeMaintenance: true as const }
              : {}),
          });
        } catch {
          /* memory only */
        }
      }
    }
  }
}
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
export function required<T>(value: T, message = 'Resource not found'): NonNullable<T> {
  if (!value) throw new HttpError(404, 'NOT_FOUND', message);
  return value as NonNullable<T>;
}
export function safeText(value: unknown, name: string, max = 1000000): string {
  if (typeof value !== 'string' || value.length > max)
    throw new HttpError(400, 'INVALID_INPUT', `${name} must be text of at most ${max} characters`);
  return value;
}
export function optionalText(value: unknown, name: string, max = 10000): string | null {
  return value == null || value === '' ? null : safeText(value, name, max);
}
