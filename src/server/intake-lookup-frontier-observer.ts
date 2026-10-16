import { randomUUID } from 'node:crypto';
import {
  terminalStatement,
  terminalStatementsActive,
  terminalRecordMutationNativeScopeActive,
} from './database-terminal-statements.ts';
import { recordMutationChangeset } from './record-mutation-recipe.ts';
import { constants, DatabaseSync, StatementSync } from 'node:sqlite';
import {
  managedDatabaseAuthorizerSetter,
  managedDatabaseFunctionSetter,
  managedDatabaseMethodEpoch,
  managedDatabaseDataMethod,
  managedDatabaseAuthorizationNestedCallbackActive,
  currentTransactionToken,
  observeManagedDatabaseAuthorization,
  observeManagedDatabaseFunctionRegistration,
  rearmManagedDatabaseAuthorization,
  observeDatabaseClose,
} from './database.ts';
import {
  createTransactionOutcomeIssuer,
  createTransactionStartIssuer,
} from './transaction-observer-issuer.ts';
const starts = createTransactionStartIssuer();
const outcomes = createTransactionOutcomeIssuer();
export const intakeFrontierTerminalStart = starts.recognizes;
export const intakeFrontierTerminalOutcome = outcomes.recognizes;
import { intakeClinicalCachePin } from './intake-clinical-cache-pin.ts';
import { consumeRecordMaintenanceBookkeeping } from './record-versions.ts';

type Operation = 'insert' | 'update' | 'delete';

interface ExpectedWrite {
  readonly table: 'app_meta' | '__record_state' | 'source_files';
  readonly key: string;
  readonly operations: readonly Operation[];
  readonly headSourceId?: string;
  readonly insertsLookupDirty?: boolean;
  readonly sourceToken?: object;
  readonly sourceKind?: string;
  readonly sourceClinicalWrites?: bigint;
  readonly sourceBeforeRowid?: bigint;
  readonly sourceMaximumRowid?: bigint;
  readonly sourceBeforeChanges?: bigint;
  readonly sourceClinicalPin?: bigint;
  readonly sourceTempSchema?: number | bigint;
  readonly sourceCaptureBefore?: boolean | null;
  readonly sourceDirtyBefore?: boolean | null;
  readonly sourceLookupDirtyBefore?: boolean | null;
  readonly standaloneBeforeChanges?: bigint;
  readonly standaloneValue?: string;
  seen: number;
}

type AuxiliaryKind = 'ownership' | 'clinical-source' | 'duplicate-evidence';
interface AuxiliaryPreparation {
  readonly kind: AuxiliaryKind;
  readonly beforeAttempts: number;
  readonly mainSchema: number | bigint;
  statement: boolean;
  ddl: boolean;
}

interface Observer {
  readonly event: (...values: unknown[]) => unknown;
  identity: object;
  readonly functionName: string;
  readonly triggerNames: readonly string[];
  readonly triggerSql: readonly string[];
  readonly managedFunction: DatabaseSync['function'];
  readonly managedAuthorizer: DatabaseSync['setAuthorizer'];
  readonly nativeApplyChangeset: DatabaseSync['applyChangeset'];
  readonly reinstall: () => void;
  attempts: number;
  ownedWrites: number;
  readonly headChanges: HeadChangeLog;
  headFloorAttempts: number;
  readonly ordinaryOutcomes: Map<
    object,
    { sequence: number; unrelatedChanges: bigint; sourceIds?: readonly string[] }
  >;
  ordinaryFloorSequence: number;
  outcomeSequence: number;
  /** Every committed writing outcome, maintenance included, in commit order.
   * A HEAD-continuity candidate only; it grants no lookup authority. */
  readonly committedOutcomes: Map<object, CommittedOutcome>;
  committedFloorSequence: number;
  committedSequence: number;
  committedSources: number;
  activeUnrelatedBefore?: bigint;
  settledChanges: bigint;
  unrelatedChanges: bigint;
  activeToken?: object;
  activeChanges?: bigint;
  activeAttempts?: number;
  activeMetadata?: Set<string>;
  activeSourceIds?: Set<string>;
  activeSourceOverflow?: boolean;
  activeSourceClinicalWrites?: bigint;
  activeSourceTriggerWrites?: bigint;
  activeLookupDirtyWrites: bigint;
  activeLookupDirtyHeadKey?: string;
  captureClearCount: number;
  clearingCapture?: { seen: boolean };
  compilingCapture?: object;
  terminalCapture?: { capability: IntakeFrontierCaptureClear; token: object };
  captureSchemaSequence: bigint;
  changesetPragma?: { phase: 0 | 1 | 2 };
  expected?: ExpectedWrite;
  auxiliary?: AuxiliaryPreparation;
  auxiliarySequence: number;
  /** Maintenance outcomes whose accepted-record index writes for their own
   * source rows were credited. Only the committed chain, which closes each
   * such outcome against its source-delta row, may span one. */
  sourceIndexedOutcomes: number;
  functionReplaced: boolean;
  revoked: boolean;
  firstRevocation?: string;
}

/** Selected-head changes in attempt order. A source rewritten later keeps
 * only its latest entry live, so an interval reads exactly its own suffix. */
interface HeadChangeLog {
  ids: string[];
  attempts: number[];
  start: number;
  readonly latest: Map<string, number>;
}
function clearHeadChanges(log: HeadChangeLog): void {
  log.ids = [];
  log.attempts = [];
  log.start = 0;
  log.latest.clear();
}
function recordHeadChange(observer: Observer, sourceId: string, attempt: number): void {
  const log = observer.headChanges;
  log.latest.delete(sourceId);
  if (log.latest.size >= MAX_CHAIN_SOURCES)
    while (log.start < log.ids.length) {
      const index = log.start++;
      if (log.latest.get(log.ids[index]!) !== log.attempts[index]) continue;
      // An evicted change raises the floor: an older snapshot no longer closes.
      observer.headFloorAttempts = log.attempts[index]!;
      log.latest.delete(log.ids[index]!);
      break;
    }
  log.ids.push(sourceId);
  log.attempts.push(attempt);
  log.latest.set(sourceId, attempt);
  if (log.ids.length - log.start > 2 * log.latest.size + 1024) {
    const ids: string[] = [],
      attempts: number[] = [];
    for (let index = log.start; index < log.ids.length; index++)
      if (log.latest.get(log.ids[index]!) === log.attempts[index]) {
        ids.push(log.ids[index]!);
        attempts.push(log.attempts[index]!);
      }
    log.ids = ids;
    log.attempts = attempts;
    log.start = 0;
  }
}
/** The live sources changed after `since`, or undefined past `limit`. The
 * work is the interval's own suffix, never the whole retained log. */
function headChangesSince(
  log: HeadChangeLog,
  since: number,
  limit: number,
): readonly string[] | undefined {
  let low = log.start,
    high = log.ids.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (log.attempts[middle]! > since) high = middle;
    else low = middle + 1;
  }
  const ids: string[] = [];
  for (let index = low; index < log.ids.length; index++)
    if (log.latest.get(log.ids[index]!) === log.attempts[index]) {
      if (ids.length >= limit) return undefined;
      ids.push(log.ids[index]!);
    }
  return ids;
}

interface CommittedOutcome {
  readonly sequence: number;
  readonly maintenance: boolean;
  readonly unrelatedBefore: bigint;
  readonly unrelatedAfter: bigint;
  readonly sourceIds?: readonly string[];
}

export interface IntakeFrontierAttemptSnapshot {
  readonly identity: object;
  readonly attempts: number;
  readonly ownedWrites: number;
  readonly tempSchema: number | bigint;
  readonly mainSchema: number | bigint;
  readonly dataVersion: number | bigint;
  readonly totalChanges: bigint;
  readonly unrelatedChanges: bigint;
  readonly outcomeSequence: number;
  readonly committedSequence: number;
  readonly auxiliarySequence: number;
  readonly sourceIndexedOutcomes: number;
}

const observers = new WeakMap<DatabaseSync, Observer>();
const blockedReadmissions = new WeakSet<DatabaseSync>();
const nativePrepare = DatabaseSync.prototype.prepare,
  nativeGet = StatementSync.prototype.get,
  nativeRun = StatementSync.prototype.run;
const schemaValue = (statement: StatementSync) =>
  Reflect.apply(nativeGet, statement, [])!.schema_version;

/** Only the issuer's bounded memory-only event can run in a closing SQL seal. */
export function intakeFrontierTerminalEvent(db: DatabaseSync, callback: unknown): boolean {
  const observer = observers.get(db);
  return !!observer && !observer.functionReplaced && observer.event === callback;
}
declare const captureClearBrand: unique symbol;
export interface IntakeFrontierCaptureClear {
  readonly [captureClearBrand]: true;
}
const captureClears = new WeakMap<
  IntakeFrontierCaptureClear,
  {
    db: DatabaseSync;
    observer: Observer;
    identity: object;
    schemaSequence: bigint;
    methods: object;
    main: StatementSync;
    temp: StatementSync;
    mainSchema: unknown;
    tempSchema: unknown;
    statement: StatementSync;
    base: number;
    phase: number;
    token?: object;
  }
>();

/** Fixed cleanup transport only, not permission to accept any captured row. */
export function prepareIntakeFrontierCaptureClear(db: DatabaseSync): IntakeFrontierCaptureClear {
  const observer = observers.get(db),
    methods = managedDatabaseMethodEpoch(db);
  if (!observer || !methods || db.isTransaction || observer.functionReplaced)
    throw Error('Terminal capture cleanup requires its original idle observer');
  if (observer.compilingCapture) throw Error('Nested terminal capture compilation');
  const main = nativePrepare.call(db, 'PRAGMA main.schema_version'),
    temp = nativePrepare.call(db, 'PRAGMA temp.schema_version');
  const identity = observer.identity,
    schemaSequence = observer.captureSchemaSequence,
    revoked = observer.revoked,
    mainSchema = schemaValue(main),
    tempSchema = schemaValue(temp);
  let statement: StatementSync;
  observer.compilingCapture = Object.freeze({});
  try {
    statement = nativePrepare.call(db, 'DELETE FROM temp.__record_changed');
  } finally {
    observer.compilingCapture = undefined;
  }
  if (
    observers.get(db) !== observer ||
    observer.identity !== identity ||
    observer.revoked !== revoked ||
    observer.captureSchemaSequence !== schemaSequence ||
    managedDatabaseMethodEpoch(db) !== methods ||
    schemaValue(main) !== mainSchema ||
    schemaValue(temp) !== tempSchema ||
    observer.captureSchemaSequence !== schemaSequence ||
    managedDatabaseMethodEpoch(db) !== methods
  )
    throw Error('Terminal capture compilation changed its original owner');
  const capability = Object.freeze({}) as IntakeFrontierCaptureClear;
  captureClears.set(capability, {
    db,
    observer,
    identity,
    schemaSequence,
    methods,
    main,
    temp,
    statement,
    // A genuine preparatory rollback leaves the old observer revoked. Its
    // cleanup transport retains that count; it never renews observer authority.
    base: observer.revoked ? observer.captureClearCount : 0,
    mainSchema,
    tempSchema,
    phase: 0,
  });
  return capability;
}
function revoke(observer: Observer, reason: string): void {
  if (!observer.revoked) observer.firstRevocation = reason;
  observer.revoked = true;
}
const MAX_ATTEMPTS = Number.MAX_SAFE_INTEGER;
const MAX_HEAD_SOURCES = 100;
/** A committed chain pages over at most this many changed sources, retained
 * across all of its outcomes; past it the interval takes the full fallback. */
const MAX_CHAIN_SOURCES = 10_000;
const schemaActions = new Set([
  constants.SQLITE_CREATE_INDEX,
  constants.SQLITE_CREATE_TABLE,
  constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_TABLE,
  constants.SQLITE_CREATE_TEMP_TRIGGER,
  constants.SQLITE_CREATE_TEMP_VIEW,
  constants.SQLITE_CREATE_TRIGGER,
  constants.SQLITE_CREATE_VIEW,
  constants.SQLITE_CREATE_VTABLE,
  constants.SQLITE_DROP_INDEX,
  constants.SQLITE_DROP_TABLE,
  constants.SQLITE_DROP_TEMP_INDEX,
  constants.SQLITE_DROP_TEMP_TABLE,
  constants.SQLITE_DROP_TEMP_TRIGGER,
  constants.SQLITE_DROP_TEMP_VIEW,
  constants.SQLITE_DROP_TRIGGER,
  constants.SQLITE_DROP_VIEW,
  constants.SQLITE_DROP_VTABLE,
  constants.SQLITE_ALTER_TABLE,
  constants.SQLITE_ATTACH,
  constants.SQLITE_DETACH,
]);
const readOnlyArgumentPragmas = new Set([
  'table_info',
  'table_xinfo',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
]);
const writeActions = new Set([
  constants.SQLITE_INSERT,
  constants.SQLITE_UPDATE,
  constants.SQLITE_DELETE,
]);
const auxiliaryPrefix = (kind: AuxiliaryKind) =>
  kind === 'ownership'
    ? '__ownership_decision_index'
    : kind === 'clinical-source'
      ? '__clinical_source_fingerprint'
      : '__duplicate_evidence_';

function tempSchema(db: DatabaseSync): number | bigint {
  const value = terminalStatement(db, 'PRAGMA temp.schema_version').get()?.schema_version;
  if (typeof value !== 'number' && typeof value !== 'bigint')
    throw Error('Intake frontier TEMP schema is unavailable');
  return value;
}

function mainSchema(db: DatabaseSync): number | bigint {
  const value = terminalStatement(db, 'PRAGMA main.schema_version').get()?.schema_version;
  if (typeof value !== 'number' && typeof value !== 'bigint')
    throw Error('Intake frontier main schema is unavailable');
  return value;
}

function dataVersion(db: DatabaseSync): number | bigint {
  const value = terminalStatement(db, 'PRAGMA data_version').get()?.data_version;
  if (typeof value !== 'number' && typeof value !== 'bigint')
    throw Error('Intake frontier peer revision is unavailable');
  return value;
}

function totalChanges(db: DatabaseSync): bigint {
  const statement = terminalStatement(db, 'SELECT total_changes() AS count', undefined, true);
  statement.setReadBigInts(true);
  const value = statement.get()?.count;
  if (typeof value !== 'bigint') throw Error('Intake frontier write count is unavailable');
  return value;
}

function settleUnrelatedChanges(db: DatabaseSync, observer: Observer): boolean {
  const changes = totalChanges(db);
  if (changes < observer.settledChanges) {
    revoke(observer, 'write count decreased');
    return false;
  }
  observer.unrelatedChanges += changes - observer.settledChanges;
  observer.settledChanges = changes;
  return true;
}

export const protectedIntakeLookupTempShadowSql =
  "SELECT 1 FROM sqlite_temp_schema WHERE type IN ('table','view') AND (lower(name) IN ('source_files','app_meta','__record_state','__record_current','__record_versions','__record_transactions','__record_fields') OR lower(name) GLOB '__record_intake_lookup_*') LIMIT 1";

const shadowStatements = new WeakMap<
  DatabaseSync,
  { methods: object; statement: StatementSync; busy: boolean }
>();
export function protectedIntakeLookupTempShadow(db: DatabaseSync, cached?: StatementSync): boolean {
  if (cached || terminalStatementsActive(db))
    return !!terminalStatement(db, protectedIntakeLookupTempShadowSql, cached).get();
  const methods = managedDatabaseMethodEpoch(db);
  // Custom preparation and unmanaged connections keep their existing callback
  // behavior. Only bytecode is reused: every call still scans the TEMP schema.
  if (!methods || managedDatabaseDataMethod(db, 'prepare') !== nativePrepare)
    return !!terminalStatement(db, protectedIntakeLookupTempShadowSql).get();
  let entry = shadowStatements.get(db);
  if (entry?.busy) return !!terminalStatement(db, protectedIntakeLookupTempShadowSql).get();
  if (!entry || entry.methods !== methods) {
    const next = {
      methods,
      statement: terminalStatement(db, protectedIntakeLookupTempShadowSql),
      busy: false,
    };
    if (!entry) observeDatabaseClose(db, () => shadowStatements.delete(db));
    shadowStatements.set(db, (entry = next));
  }
  entry.busy = true;
  try {
    return !!terminalStatement(db, protectedIntakeLookupTempShadowSql, entry.statement).get();
  } finally {
    entry.busy = false;
  }
}

function ownTriggersIntact(db: DatabaseSync, observer: Observer): boolean {
  return observer.triggerNames.every(
    (name, index) =>
      db.prepare("SELECT sql FROM sqlite_temp_schema WHERE type='trigger' AND name=?").get(name)
        ?.sql === observer.triggerSql[index],
  );
}

function classify(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096) return undefined;
  return value;
}

/** Observation is private and monotonic; it does not authorize a lookup by itself. */
export function ensureIntakeFrontierObserver(db: DatabaseSync): void {
  if (blockedReadmissions.has(db))
    throw Error('Intake frontier compact readmission is unavailable');
  if (!db.isOpen || db.isTransaction)
    throw Error('Intake frontier observer requires an open idle DB');
  const existing = observers.get(db);
  if (existing) {
    if (
      !existing.revoked &&
      db.function === existing.managedFunction &&
      existing.activeToken === undefined &&
      existing.expected === undefined &&
      totalChanges(db) === existing.settledChanges
    )
      return;
    if (db.setAuthorizer !== existing.managedAuthorizer)
      throw Error('Intake frontier database authorizer was replaced');
    if (db.function !== existing.managedFunction)
      throw Error('Intake frontier function registration was replaced');
    if (
      !existing.revoked &&
      !existing.functionReplaced &&
      existing.activeToken === undefined &&
      existing.expected === undefined &&
      existing.auxiliary === undefined &&
      ownTriggersIntact(db, existing) &&
      settleUnrelatedChanges(db, existing)
    )
      return;
    existing.revoked = true;
    if (existing.functionReplaced || !ownTriggersIntact(db, existing)) existing.reinstall();
    if (!rearmManagedDatabaseAuthorization(db))
      throw Error('Intake frontier database authorizer was replaced');
    existing.identity = {};
    existing.attempts = 0;
    existing.ownedWrites = 0;
    clearHeadChanges(existing.headChanges);
    existing.headFloorAttempts = 0;
    existing.ordinaryOutcomes.clear();
    existing.ordinaryFloorSequence = 0;
    existing.outcomeSequence = 0;
    existing.committedOutcomes.clear();
    existing.committedFloorSequence = 0;
    existing.committedSequence = 0;
    existing.committedSources = 0;
    existing.activeUnrelatedBefore = undefined;
    existing.settledChanges = totalChanges(db);
    existing.unrelatedChanges = 0n;
    existing.activeToken = undefined;
    existing.activeChanges = undefined;
    existing.activeAttempts = undefined;
    existing.activeSourceIds = undefined;
    existing.activeSourceOverflow = undefined;
    existing.expected = undefined;
    existing.auxiliary = undefined;
    existing.auxiliarySequence = 0;
    existing.sourceIndexedOutcomes = 0;
    existing.functionReplaced = false;
    existing.revoked = false;
    existing.firstRevocation = undefined;
    return;
  }
  const managedAuthorizer = managedDatabaseAuthorizerSetter(db);
  const managedFunction = managedDatabaseFunctionSetter(db);
  if (!managedAuthorizer || db.setAuthorizer !== managedAuthorizer)
    throw Error('Intake frontier observer requires a managed database authorizer');
  if (!managedFunction || db.function !== managedFunction)
    throw Error('Intake frontier observer requires managed function registration');
  // Clinical pin setup owns TEMP triggers; finish it before sealing this observer's schema.
  intakeClinicalCachePin(db);
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `__intake_frontier_event_${suffix}`;
  const triggerNames = [
    `__intake_frontier_source_insert_${suffix}`,
    `__intake_frontier_source_update_${suffix}`,
    `__intake_frontier_source_delete_${suffix}`,
    `__intake_frontier_meta_insert_${suffix}`,
    `__intake_frontier_meta_update_${suffix}`,
    `__intake_frontier_meta_delete_${suffix}`,
    `__intake_frontier_state_insert_${suffix}`,
    `__intake_frontier_state_update_${suffix}`,
    `__intake_frontier_state_delete_${suffix}`,
  ];
  let observer: Observer | undefined;
  const event = (table: unknown, operation: unknown, rawBefore: unknown, rawAfter: unknown) => {
    if (!observer || observer.revoked) return null;
    const before = classify(rawBefore),
      after = classify(rawAfter);
    if (
      (table !== 'source_files' && table !== 'app_meta' && table !== '__record_state') ||
      (operation !== 'insert' && operation !== 'update' && operation !== 'delete') ||
      before === undefined ||
      after === undefined ||
      observer.attempts >= MAX_ATTEMPTS
    ) {
      revoke(observer, 'invalid protected event');
      return null;
    }
    observer.attempts++;
    const expected = observer.expected;
    const key = operation === 'delete' ? before : after;
    if (
      (table !== 'app_meta' && table !== '__record_state' && table !== 'source_files') ||
      !expected ||
      table !== expected.table ||
      key !== expected.key ||
      (before !== null && after !== null && before !== after) ||
      !expected.operations.includes(operation) ||
      expected.seen !== 0
    )
      revoke(observer, 'unowned protected event');
    else {
      expected.seen = 1;
      observer.ownedWrites++;
      if (table === 'source_files' && observer.activeSourceIds && !observer.activeSourceOverflow) {
        if (
          observer.activeSourceIds.size >= MAX_CHAIN_SOURCES &&
          !observer.activeSourceIds.has(key!)
        )
          observer.activeSourceOverflow = true;
        else observer.activeSourceIds.add(key!);
      }
      if (table === 'app_meta' && observer.activeMetadata) {
        if (observer.activeMetadata.size >= 4100 && !observer.activeMetadata.has(key!))
          revoke(observer, 'maintenance metadata window');
        else observer.activeMetadata.add(key!);
      }
      if (expected.headSourceId)
        recordHeadChange(observer, expected.headSourceId, observer.attempts);
    }
    return null;
  };
  const triggerSQL = [
    ['source_files', 'id'],
    ['app_meta', 'key'],
    ['__record_state', 'singleton'],
  ] as const;
  const reinstall = () => {
    db.function(functionName, event);
    for (const name of triggerNames) db.exec(`DROP TRIGGER IF EXISTS temp.${name}`);
    let index = 0;
    for (const [table, key] of triggerSQL) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
        const scalar = (side: 'OLD' | 'NEW') =>
          table === '__record_state' ? `CAST(${side}.${key} AS TEXT)` : `${side}.${key}`;
        const before = operation === 'INSERT' ? 'NULL' : scalar('OLD');
        const after = operation === 'DELETE' ? 'NULL' : scalar('NEW');
        db.exec(
          `CREATE TEMP TRIGGER ${triggerNames[index++]} AFTER ${operation} ON main.${table} BEGIN SELECT ${functionName}('${table}','${operation.toLowerCase()}',${before},${after}); END`,
        );
      }
    }
  };
  reinstall();
  const triggerSql = triggerNames.map((name) => {
    const sql = db
      .prepare("SELECT sql FROM sqlite_temp_schema WHERE type='trigger' AND name=?")
      .get(name)?.sql;
    if (typeof sql !== 'string') throw Error('Intake frontier trigger installation failed');
    return sql;
  });
  observer = {
    event,
    activeLookupDirtyWrites: 0n,
    captureClearCount: 0,
    captureSchemaSequence: 0n,
    identity: {},
    functionName,
    triggerNames,
    triggerSql,
    managedFunction,
    managedAuthorizer,
    nativeApplyChangeset: db.applyChangeset,
    reinstall,
    attempts: 0,
    ownedWrites: 0,
    headChanges: { ids: [], attempts: [], start: 0, latest: new Map() },
    headFloorAttempts: 0,
    ordinaryOutcomes: new Map(),
    ordinaryFloorSequence: 0,
    outcomeSequence: 0,
    committedOutcomes: new Map(),
    committedFloorSequence: 0,
    committedSequence: 0,
    committedSources: 0,
    auxiliarySequence: 0,
    sourceIndexedOutcomes: 0,
    functionReplaced: false,
    settledChanges: totalChanges(db),
    unrelatedChanges: 0n,
    revoked: false,
  };
  observers.set(db, observer);
  const observedFunction = observeManagedDatabaseFunctionRegistration(db, (name) => {
    if (!observer) return;
    revoke(observer, 'function registration');
    if (name.toLowerCase() === functionName.toLowerCase()) observer.functionReplaced = true;
  });
  if (!observedFunction) observer.revoked = true;
  const observed = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail, _database, origin) => {
      if (observer) {
        if (
          schemaActions.has(action) ||
          (action === constants.SQLITE_PRAGMA &&
            detail !== null &&
            !readOnlyArgumentPragmas.has(name ?? ''))
        )
          observer.captureSchemaSequence++;
        const captureDelete =
          action === constants.SQLITE_DELETE && _database === 'temp' && name === '__record_changed';
        const ownedCaptureDelete =
          captureDelete && observer.clearingCapture && !observer.clearingCapture.seen;
        const ownedCaptureCompile =
          captureDelete &&
          observer.compilingCapture &&
          !managedDatabaseAuthorizationNestedCallbackActive(db);
        if (ownedCaptureDelete) observer.clearingCapture!.seen = true;
        if (
          _database === 'temp' &&
          name === '__record_changed' &&
          writeActions.has(action) &&
          !(
            ownedCaptureDelete ||
            ownedCaptureCompile ||
            (action === constants.SQLITE_INSERT &&
              /^__record_capture_[a-z_]+_(INSERT|UPDATE|DELETE)$/.test(origin ?? ''))
          )
        )
          revoke(observer, 'unowned accepted-row capture write');
        if (
          _database === 'temp' &&
          writeActions.has(action) &&
          (name === '__source_text_dirty' || name === '__source_text_authorities') &&
          !(
            name === '__source_text_dirty' &&
            action === constants.SQLITE_INSERT &&
            (/^__source_text_authority_(INSERT|UPDATE|DELETE)$/.test(origin ?? '') ||
              (origin === '__source_text_insert' &&
                observer.expected?.table === 'source_files' &&
                observer.expected.operations[0] === 'insert') ||
              (origin === '__source_text_update' &&
                observer.expected?.table === 'source_files' &&
                observer.expected.operations[0] === 'update'))
          )
        )
          revoke(observer, 'unowned source-text tracking write');
        if (
          writeActions.has(action) &&
          ((_database === 'main' && name?.startsWith('__record_intake_lookup_')) ||
            (_database === 'temp' &&
              name?.startsWith('__intake_lookup_') &&
              !(
                name === '__intake_lookup_dirty' &&
                action === constants.SQLITE_INSERT &&
                /^__intake_lookup_(authority_(INSERT|UPDATE|DELETE)|insert|update|delete)$/.test(
                  origin ?? '',
                )
              )))
        )
          revoke(observer, 'lookup projection write');
        const auxiliary = observer.auxiliary;
        const allowedAuxiliaryName =
          auxiliary?.statement &&
          (name?.startsWith(auxiliaryPrefix(auxiliary.kind)) ||
            name?.startsWith(`sqlite_autoindex_${auxiliaryPrefix(auxiliary.kind)}`));
        const internalMainSchemaWrite =
          auxiliary?.statement && auxiliary.ddl && _database === 'main' && name === 'sqlite_master';
        if (
          auxiliary &&
          (writeActions.has(action) || schemaActions.has(action)) &&
          !(
            auxiliary.statement &&
            ((_database === 'temp' && (allowedAuxiliaryName || name === 'sqlite_temp_master')) ||
              internalMainSchemaWrite)
          )
        ) {
          revoke(observer, 'auxiliary write');
        }
        if (
          (schemaActions.has(action) && !allowedAuxiliaryName) ||
          (action === constants.SQLITE_PRAGMA &&
            detail !== null &&
            !readOnlyArgumentPragmas.has(name ?? ''))
        ) {
          const changeset = observer.changesetPragma;
          if (action === constants.SQLITE_PRAGMA && name === 'defer_foreign_keys' && changeset) {
            if (changeset.phase === 0 && detail === '1') changeset.phase = 1;
            else if (changeset.phase === 1 && detail === '0') changeset.phase = 2;
            else revoke(observer, 'clinical changeset PRAGMA sequence');
          } else
            revoke(
              observer,
              schemaActions.has(action)
                ? `schema action ${action} ${name ?? ''} ${_database ?? ''}`
                : `mutable PRAGMA ${name ?? ''} ${detail ?? ''} ${_database ?? ''}`,
            );
        }
        if (
          action === constants.SQLITE_FUNCTION &&
          detail === functionName &&
          !observer.triggerNames.includes(origin ?? '')
        )
          revoke(observer, 'frontier function');
      }
    },
    () => {
      if (observer) revoke(observer, 'authorizer replacement');
    },
  );
  if (!observed) observer.revoked = true;
  starts.observe(db, (token) => {
    if (!observer || observer.revoked) return;
    if (observer.auxiliary) revoke(observer, 'transaction during auxiliary');
    const changes = totalChanges(db);
    if (observer.activeToken || !settleUnrelatedChanges(db, observer)) {
      revoke(observer, 'transaction start');
    }
    observer.activeToken = token;
    observer.activeUnrelatedBefore = observer.unrelatedChanges;
    observer.activeChanges = changes;
    observer.activeAttempts = observer.attempts;
    observer.activeMetadata = new Set();
    observer.activeSourceIds = new Set();
    observer.activeSourceOverflow = false;
    observer.activeSourceClinicalWrites = 0n;
    observer.activeSourceTriggerWrites = 0n;
    observer.activeLookupDirtyWrites = 0n;
    observer.activeLookupDirtyHeadKey = undefined;
    observer.captureClearCount = 0;
  });
  outcomes.observe(db, (outcome) => {
    if (!observer || observer.revoked) return;
    if (
      observer.activeToken !== outcome.token ||
      observer.activeChanges === undefined ||
      observer.activeAttempts === undefined
    ) {
      revoke(observer, 'outcome token');
      return;
    }
    const changes = totalChanges(db);
    const unrelatedBefore = observer.activeUnrelatedBefore;
    if (!outcome.succeeded || !outcome.committed || changes < observer.activeChanges) {
      revoke(observer, 'outcome failure');
    } else {
      const protectedWrites = BigInt(observer.attempts - observer.activeAttempts);
      const receipt = outcome.intakeMaintenance
        ? consumeRecordMaintenanceBookkeeping(
            db,
            outcome.token,
            observer.activeSourceOverflow ? undefined : observer.activeSourceIds,
          )
        : undefined;
      const bookkeeping = receipt?.writes ?? 0n;
      if (receipt?.sources) observer.sourceIndexedOutcomes++;
      const dirtyWrites = outcome.intakeMaintenance ? observer.activeLookupDirtyWrites : 0n;
      const extra =
        changes -
        observer.activeChanges -
        protectedWrites -
        bookkeeping -
        dirtyWrites -
        (observer.activeSourceClinicalWrites ?? 0n) -
        (observer.activeSourceTriggerWrites ?? 0n);
      if (extra < 0n) revoke(observer, 'outcome write count');
      else observer.unrelatedChanges += extra;
    }
    if (changes !== observer.activeChanges && !outcome.intakeMaintenance) {
      if (observer.ordinaryOutcomes.size >= 100) {
        const oldest = observer.ordinaryOutcomes.entries().next().value;
        if (oldest) {
          observer.ordinaryFloorSequence = oldest[1].sequence;
          observer.ordinaryOutcomes.delete(oldest[0]);
        }
      }
      observer.ordinaryOutcomes.set(outcome.token, {
        sequence: ++observer.outcomeSequence,
        unrelatedChanges: observer.unrelatedChanges,
        // The single-outcome accepted transition keeps its one-page bound.
        sourceIds:
          observer.activeSourceOverflow || (observer.activeSourceIds?.size ?? 0) > MAX_HEAD_SOURCES
            ? undefined
            : Object.freeze([...(observer.activeSourceIds ?? [])]),
      });
    }
    if (
      outcome.succeeded &&
      outcome.committed &&
      !observer.revoked &&
      changes !== observer.activeChanges &&
      unrelatedBefore !== undefined
    ) {
      const sourceCount = observer.activeSourceOverflow ? 0 : (observer.activeSourceIds?.size ?? 0);
      // Retained source identities stay bounded across every committed outcome.
      while (
        observer.committedOutcomes.size &&
        (observer.committedOutcomes.size >= 100 ||
          observer.committedSources + sourceCount > MAX_CHAIN_SOURCES)
      ) {
        const oldest = observer.committedOutcomes.entries().next().value!;
        observer.committedFloorSequence = oldest[1].sequence;
        observer.committedSources -= oldest[1].sourceIds?.length ?? 0;
        observer.committedOutcomes.delete(oldest[0]);
      }
      observer.committedSources += sourceCount;
      observer.committedOutcomes.set(outcome.token, {
        sequence: ++observer.committedSequence,
        maintenance: !!outcome.intakeMaintenance,
        unrelatedBefore,
        unrelatedAfter: observer.unrelatedChanges,
        sourceIds: observer.activeSourceOverflow
          ? undefined
          : Object.freeze([...(observer.activeSourceIds ?? [])]),
      });
    }
    observer.settledChanges = changes;
    observer.activeToken = undefined;
    observer.activeUnrelatedBefore = undefined;
    observer.activeChanges = undefined;
    observer.activeAttempts = undefined;
    observer.activeMetadata = undefined;
    observer.activeSourceIds = undefined;
    observer.activeSourceOverflow = undefined;
    observer.activeSourceClinicalWrites = undefined;
    observer.activeSourceTriggerWrites = undefined;
  });
}

/** A committed compact write may leave only a failed next-operation admission. */
export function blockIntakeFrontierReadmission(db: DatabaseSync): void {
  blockedReadmissions.add(db);
  const observer = observers.get(db);
  if (!observer) return;
  revoke(observer, 'compact readmission failed');
}

/** Read only genuine, original protected events for this exact transaction. */
export function intakeFrontierOwnedMetadataKeys(
  db: DatabaseSync,
  token: object,
): ReadonlySet<string> | undefined {
  const observer = observers.get(db);
  if (!observer || observer.revoked || observer.activeToken !== token) return undefined;
  return observer.activeMetadata && new Set(observer.activeMetadata);
}

/** The capture owner alone runs this fixed cleanup statement, never a callback. */
export function clearIntakeFrontierRecordCapture(
  db: DatabaseSync,
  capability?: IntakeFrontierCaptureClear,
): number | bigint {
  const observer = observers.get(db);
  const currentToken = currentTransactionToken(db);
  if (observer?.terminalCapture) {
    if (observer.terminalCapture.token !== currentToken) observer.terminalCapture = undefined;
    else if (observer.terminalCapture.capability !== capability)
      throw Error('Ordinary cleanup cannot consume terminal capture slots');
  }
  const prepared = capability && captureClears.get(capability);
  const terminal = terminalRecordMutationNativeScopeActive(db);
  if (capability) {
    const token = currentTransactionToken(db);
    if (
      !prepared ||
      prepared.db !== db ||
      prepared.observer !== observer ||
      prepared.identity !== observer!.identity ||
      prepared.schemaSequence !== observer!.captureSchemaSequence ||
      !token ||
      (!db.isTransaction && prepared.phase !== 1) ||
      prepared.phase >= 2 ||
      (prepared.token && prepared.token !== token) ||
      observer!.captureClearCount !== prepared.base + prepared.phase ||
      observer!.clearingCapture ||
      observer!.functionReplaced ||
      managedDatabaseMethodEpoch(db) !== prepared.methods ||
      (terminal
        ? terminalStatement(db, 'PRAGMA main.schema_version').get()!.schema_version
        : schemaValue(prepared.main)) !== prepared.mainSchema ||
      (terminal
        ? terminalStatement(db, 'PRAGMA temp.schema_version').get()!.schema_version
        : schemaValue(prepared.temp)) !== prepared.tempSchema
    )
      throw Error('Foreign, expired or replayed terminal capture cleanup');
    prepared.token = token;
    prepared.phase++;
    observer!.terminalCapture = { capability, token };
  }
  if (observer?.clearingCapture) revoke(observer, 'reentrant accepted-row cleanup');
  if (observer) {
    if (!observer.activeToken || observer.captureClearCount >= 2)
      revoke(observer, 'accepted-row cleanup phase');
    observer.captureClearCount++;
  }
  const clearing = { seen: !!prepared };
  if (observer) observer.clearingCapture = clearing;
  try {
    // Fresh bytecode must consume this slot. Rearming here would invalidate
    // every unrelated prepared statement twice per durable publication.
    return prepared
      ? terminal
        ? terminalStatement(db, 'DELETE FROM temp.__record_changed').run().changes
        : Reflect.apply(nativeRun, prepared.statement, []).changes
      : db.prepare('DELETE FROM temp.__record_changed').run().changes;
  } finally {
    if (observer && !clearing.seen) revoke(observer, 'capture cleanup authorization missing');
    if (observer) observer.clearingCapture = undefined;
  }
}

export function captureIntakeFrontierAttempts(
  db: DatabaseSync,
): IntakeFrontierAttemptSnapshot | undefined {
  if (blockedReadmissions.has(db)) return undefined;
  const observer = observers.get(db);
  if (
    !db.isOpen ||
    !observer ||
    observer.revoked ||
    observer.expected ||
    observer.auxiliary ||
    protectedIntakeLookupTempShadow(db) ||
    managedDatabaseDataMethod(db, 'function') !== observer.managedFunction ||
    managedDatabaseDataMethod(db, 'setAuthorizer') !== observer.managedAuthorizer ||
    managedDatabaseDataMethod(db, 'applyChangeset') !== observer.nativeApplyChangeset ||
    observer.activeToken !== undefined ||
    totalChanges(db) !== observer.settledChanges
  )
    return undefined;
  const peer = dataVersion(db),
    schema = mainSchema(db),
    temp = tempSchema(db);
  if (peer !== dataVersion(db) || schema !== mainSchema(db)) return undefined;
  return {
    identity: observer.identity,
    attempts: observer.attempts,
    ownedWrites: observer.ownedWrites,
    tempSchema: temp,
    mainSchema: schema,
    dataVersion: peer,
    totalChanges: observer.settledChanges,
    unrelatedChanges: observer.unrelatedChanges,
    outcomeSequence: observer.outcomeSequence,
    committedSequence: observer.committedSequence,
    auxiliarySequence: observer.auxiliarySequence,
    sourceIndexedOutcomes: observer.sourceIndexedOutcomes,
  };
}

function readAttempts(
  db: DatabaseSync,
  snapshot: IntakeFrontierAttemptSnapshot,
  mode: 'strict' | 'accepted' | 'source-equality' | 'chain',
  opening = false,
):
  | {
      attempts: number;
      ownedWrites: number;
      headSourceIds: readonly string[];
      ordinaryTokens: readonly object[];
    }
  | undefined {
  const observer = observers.get(db);
  if (
    !db.isOpen ||
    !observer ||
    observer.identity !== snapshot.identity ||
    snapshot.attempts < observer.headFloorAttempts ||
    snapshot.outcomeSequence < observer.ordinaryFloorSequence ||
    observer.revoked ||
    observer.expected ||
    observer.auxiliary ||
    protectedIntakeLookupTempShadow(db) ||
    managedDatabaseDataMethod(db, 'function') !== observer.managedFunction ||
    managedDatabaseDataMethod(db, 'setAuthorizer') !== observer.managedAuthorizer ||
    managedDatabaseDataMethod(db, 'applyChangeset') !== observer.nativeApplyChangeset ||
    observer.activeToken !== undefined ||
    !settleUnrelatedChanges(db, observer) ||
    (mode === 'strict' && observer.unrelatedChanges !== snapshot.unrelatedChanges) ||
    mainSchema(db) !== snapshot.mainSchema ||
    (!opening && dataVersion(db) !== snapshot.dataVersion) ||
    (mode === 'source-equality' && observer.auxiliarySequence !== snapshot.auxiliarySequence) ||
    (mode !== 'chain' && observer.sourceIndexedOutcomes !== snapshot.sourceIndexedOutcomes) ||
    (tempSchema(db) !== snapshot.tempSchema &&
      observer.auxiliarySequence === snapshot.auxiliarySequence)
  )
    return undefined;
  const headSourceIds = headChangesSince(
    observer.headChanges,
    snapshot.attempts,
    mode === 'chain' ? MAX_CHAIN_SOURCES : MAX_HEAD_SOURCES,
  );
  if (!headSourceIds) return undefined;
  const ordinary = [...observer.ordinaryOutcomes].filter(
    ([, outcome]) => outcome.sequence > snapshot.outcomeSequence,
  );
  if (
    mode === 'accepted' &&
    (ordinary.length !== 1 || ordinary[0]![1].unrelatedChanges !== observer.unrelatedChanges)
  )
    return undefined;
  return {
    attempts: observer.attempts - snapshot.attempts,
    ownedWrites: observer.ownedWrites - snapshot.ownedWrites,
    headSourceIds,
    ordinaryTokens: ordinary.map(([token]) => token),
  };
}

export function readIntakeFrontierAttempts(
  db: DatabaseSync,
  snapshot: IntakeFrontierAttemptSnapshot,
): ReturnType<typeof readAttempts> {
  return readAttempts(db, snapshot, 'strict');
}

/** The exact original frontier, observed from inside the caller's active
 * transaction before that transaction has made any write. A read here sees
 * the same committed state the snapshot certified; the first write of any kind
 * (or any protected attempt, schema or peer change) ends it. */
export function readIntakeFrontierActiveUnwritten(
  db: DatabaseSync,
  snapshot: IntakeFrontierAttemptSnapshot,
): boolean {
  const observer = observers.get(db);
  const token = currentTransactionToken(db);
  const current = () =>
    db.isOpen &&
    db.isTransaction &&
    !!token &&
    !!observer &&
    !blockedReadmissions.has(db) &&
    observer.identity === snapshot.identity &&
    !observer.revoked &&
    !observer.expected &&
    !observer.auxiliary &&
    !observer.changesetPragma &&
    observer.activeToken === token &&
    observer.activeAttempts === observer.attempts &&
    observer.activeChanges === observer.settledChanges &&
    observer.attempts === snapshot.attempts &&
    observer.ownedWrites === snapshot.ownedWrites &&
    observer.settledChanges === snapshot.totalChanges &&
    observer.unrelatedChanges === snapshot.unrelatedChanges &&
    observer.outcomeSequence === snapshot.outcomeSequence &&
    observer.auxiliarySequence === snapshot.auxiliarySequence &&
    observer.sourceIndexedOutcomes === snapshot.sourceIndexedOutcomes &&
    managedDatabaseDataMethod(db, 'function') === observer.managedFunction &&
    managedDatabaseDataMethod(db, 'setAuthorizer') === observer.managedAuthorizer &&
    managedDatabaseDataMethod(db, 'applyChangeset') === observer.nativeApplyChangeset;
  if (!current() || protectedIntakeLookupTempShadow(db)) return false;
  if (
    totalChanges(db) !== snapshot.totalChanges ||
    mainSchema(db) !== snapshot.mainSchema ||
    tempSchema(db) !== snapshot.tempSchema ||
    dataVersion(db) !== snapshot.dataVersion
  )
    return false;
  return current() && totalChanges(db) === snapshot.totalChanges;
}

/** Candidate interval check for a single committed-reader opening. This is not
 * an authority witness: the caller must pin its original owner and main/WAL
 * files before rechecking the ordinary strict frontier with the new peer value. */
export function readIntakeFrontierCommittedOpeningCandidate(
  db: DatabaseSync,
  snapshot: IntakeFrontierAttemptSnapshot,
): ReturnType<typeof readAttempts> {
  return readAttempts(db, snapshot, 'strict', true);
}

/** Candidate membership only. Accepted record and original-file proofs remain
 * separate requirements before any source can enter a retained catalog. */
export function readIntakeFrontierSourceOutcomeCandidates(
  db: DatabaseSync,
  snapshot: IntakeFrontierAttemptSnapshot,
): readonly { token: object; sourceIds: readonly string[] }[] | undefined {
  const interval = readAttempts(db, snapshot, 'strict');
  const observer = observers.get(db);
  if (!interval || !observer) return undefined;
  const outcomes = interval.ordinaryTokens.map((token) => {
    const item = observer.ordinaryOutcomes.get(token);
    return item?.sourceIds && Object.freeze({ token, sourceIds: item.sourceIds });
  });
  return outcomes.every((item) => item !== undefined)
    ? Object.freeze(outcomes as { token: object; sourceIds: readonly string[] }[])
    : undefined;
}

export interface IntakeFrontierCommittedChain {
  readonly attempts: number;
  readonly ownedWrites: number;
  readonly headSourceIds: readonly string[];
  readonly outcomes: readonly {
    readonly token: object;
    readonly maintenance: boolean;
    readonly sourceIds: readonly string[];
  }[];
}

/** Every committed writing outcome since the original snapshot, in commit
 * order, with each unrelated write attributed to exactly one of them. A
 * maintenance outcome may not carry any unrelated write; an ordinary outcome
 * may, as the single-outcome accepted transition does. These are HEAD
 * continuity and changed-source candidates only: the consumer must still
 * close each against accepted record evidence and the current source rows. */
export function readIntakeFrontierCommittedChain(
  db: DatabaseSync,
  snapshot: IntakeFrontierAttemptSnapshot,
): IntakeFrontierCommittedChain | undefined {
  const interval = readAttempts(db, snapshot, 'chain');
  const observer = observers.get(db);
  if (
    !interval ||
    !observer ||
    interval.attempts !== interval.ownedWrites ||
    interval.headSourceIds.length > MAX_CHAIN_SOURCES ||
    snapshot.committedSequence < observer.committedFloorSequence ||
    snapshot.committedSequence > observer.committedSequence
  )
    return undefined;
  const committed = [...observer.committedOutcomes].filter(
    ([, outcome]) => outcome.sequence > snapshot.committedSequence,
  );
  if (committed.length !== observer.committedSequence - snapshot.committedSequence)
    return undefined;
  let unrelated = snapshot.unrelatedChanges;
  let sequence = snapshot.committedSequence;
  const ordinary: object[] = [];
  const outcomes: { token: object; maintenance: boolean; sourceIds: readonly string[] }[] = [];
  for (const [token, outcome] of committed) {
    if (
      outcome.sequence !== ++sequence ||
      outcome.unrelatedBefore !== unrelated ||
      outcome.unrelatedAfter < outcome.unrelatedBefore ||
      (outcome.maintenance && outcome.unrelatedAfter !== outcome.unrelatedBefore) ||
      !outcome.sourceIds
    )
      return undefined;
    unrelated = outcome.unrelatedAfter;
    if (!outcome.maintenance) ordinary.push(token);
    outcomes.push(
      Object.freeze({ token, maintenance: outcome.maintenance, sourceIds: outcome.sourceIds }),
    );
  }
  if (
    unrelated !== observer.unrelatedChanges ||
    ordinary.length !== interval.ordinaryTokens.length ||
    ordinary.some((token, index) => token !== interval.ordinaryTokens[index])
  )
    return undefined;
  return Object.freeze({
    attempts: interval.attempts,
    ownedWrites: interval.ownedWrites,
    headSourceIds: interval.headSourceIds,
    outcomes: Object.freeze(outcomes),
  });
}

/** Observation only; the caller must independently close the exact durable owner outcome. */
export function readIntakeFrontierAcceptedTransition(
  db: DatabaseSync,
  snapshot: IntakeFrontierAttemptSnapshot,
): ReturnType<typeof readAttempts> {
  return readAttempts(db, snapshot, 'accepted');
}

/** Equality only: no selected-source or head attempt may change the existing digest. */
export function readIntakeFrontierSourceEquality(
  db: DatabaseSync,
  snapshot: IntakeFrontierAttemptSnapshot,
): { attempts: number; ownedWrites: number; headSourceIds: readonly string[] } | undefined {
  const interval = readAttempts(db, snapshot, 'source-equality');
  return interval &&
    interval.attempts === interval.ownedWrites &&
    interval.headSourceIds.length <= MAX_HEAD_SOURCES &&
    interval.ordinaryTokens.length === 0
    ? {
        attempts: interval.attempts,
        ownedWrites: interval.ownedWrites,
        headSourceIds: interval.headSourceIds,
      }
    : undefined;
}

/** Read the original source attempt interval while its exact maintenance transaction
 * is active. The caller separately proves the transaction's literal total_changes. */
export function readIntakeFrontierOwnedSourceEquality(
  db: DatabaseSync,
  snapshot: IntakeFrontierAttemptSnapshot,
  token: object,
): { attempts: number; ownedWrites: number; headSourceIds: readonly string[] } | undefined {
  const observer = observers.get(db);
  const current = () =>
    db.isOpen &&
    !!observer &&
    observer.identity === snapshot.identity &&
    !observer.revoked &&
    !observer.expected &&
    !observer.auxiliary &&
    observer.activeToken === token &&
    currentTransactionToken(db) === token &&
    observer.attempts >= snapshot.attempts &&
    snapshot.attempts >= observer.headFloorAttempts &&
    observer.ownedWrites >= snapshot.ownedWrites &&
    observer.unrelatedChanges === snapshot.unrelatedChanges &&
    observer.outcomeSequence === snapshot.outcomeSequence &&
    observer.auxiliarySequence === snapshot.auxiliarySequence &&
    observer.sourceIndexedOutcomes === snapshot.sourceIndexedOutcomes &&
    managedDatabaseDataMethod(db, 'function') === observer.managedFunction &&
    managedDatabaseDataMethod(db, 'setAuthorizer') === observer.managedAuthorizer &&
    managedDatabaseDataMethod(db, 'applyChangeset') === observer.nativeApplyChangeset &&
    !observer.revoked &&
    observer.attempts >= snapshot.attempts &&
    observer.ownedWrites >= snapshot.ownedWrites;
  if (!current() || protectedIntakeLookupTempShadow(db)) return undefined;
  const main = mainSchema(db),
    temp = tempSchema(db),
    peer = dataVersion(db);
  if (
    !current() ||
    main !== snapshot.mainSchema ||
    temp !== snapshot.tempSchema ||
    peer !== snapshot.dataVersion
  )
    return undefined;
  const attempts = observer!.attempts - snapshot.attempts,
    ownedWrites = observer!.ownedWrites - snapshot.ownedWrites,
    headSourceIds = headChangesSince(observer!.headChanges, snapshot.attempts, MAX_HEAD_SOURCES);
  return current() && attempts === ownedWrites && headSourceIds
    ? { attempts, ownedWrites, headSourceIds }
    : undefined;
}

/** One selected-head dirty insertion certified by the original fixed writer. */
export function readIntakeFrontierOwnedLookupDirtyWrite(
  db: DatabaseSync,
  snapshot: IntakeFrontierAttemptSnapshot,
  token: object,
  sourceId: string,
  headKey: string,
): 0 | 1 | undefined {
  const interval = readIntakeFrontierOwnedSourceEquality(db, snapshot, token);
  const observer = observers.get(db);
  if (
    !interval ||
    !observer ||
    interval.headSourceIds.some((id) => id !== sourceId) ||
    (observer.activeLookupDirtyWrites === 1n && !interval.headSourceIds.includes(sourceId)) ||
    (observer.activeLookupDirtyWrites === 1n && observer.activeLookupDirtyHeadKey !== headKey) ||
    (observer.activeLookupDirtyWrites !== 0n && observer.activeLookupDirtyWrites !== 1n)
  )
    return undefined;
  const count = Number(observer.activeLookupDirtyWrites) as 0 | 1;
  const closing = readIntakeFrontierOwnedSourceEquality(db, snapshot, token);
  return closing &&
    closing.headSourceIds.every((id) => id === sourceId) &&
    (count === 0 || closing.headSourceIds.includes(sourceId)) &&
    (count === 0 || observer.activeLookupDirtyHeadKey === headKey) &&
    observer.activeLookupDirtyWrites === BigInt(count)
    ? count
    : undefined;
}

export function intakeFrontierAttemptCounts(db: DatabaseSync) {
  const observer = observers.get(db);
  return observer
    ? {
        attempts: observer.attempts,
        ownedWrites: observer.ownedWrites,
        revoked: observer.revoked,
        firstRevocation: observer.firstRevocation,
      }
    : undefined;
}

/** The native changeset call itself, not an arbitrary caller callback, owns this PRAGMA interval. */
export function applyObservedClinicalProjectionChangeset(
  db: DatabaseSync,
  changes: Uint8Array,
): boolean {
  const apply = () => recordMutationChangeset(db, changes);
  const observer = observers.get(db);
  if (!observer || observer.revoked) return apply();
  if (
    observer.changesetPragma ||
    observer.expected ||
    observer.auxiliary ||
    !observer.activeToken ||
    currentTransactionToken(db) !== observer.activeToken ||
    managedDatabaseDataMethod(db, 'applyChangeset') !== observer.nativeApplyChangeset
  ) {
    revoke(observer, 'clinical changeset ownership');
    return apply();
  }
  const bracket = { phase: 0 as 0 | 1 | 2 };
  observer.changesetPragma = bracket;
  try {
    const applied = apply();
    if (!applied || bracket.phase !== 2) revoke(observer, 'clinical changeset completion');
    return applied;
  } catch (error) {
    revoke(observer, 'clinical changeset failure');
    throw error;
  } finally {
    observer.changesetPragma = undefined;
  }
}

/** Brackets exactly one fixed owner SQL write; an extra/reentrant write revokes reuse. */
export function expectIntakeFrontierMetaWrite(
  db: DatabaseSync,
  key: string,
  operations: readonly Operation[],
  headSourceId?: string,
): ExpectedWrite | undefined {
  const observer = observers.get(db);
  if (!observer || observer.revoked) return undefined;
  if (
    observer.expected ||
    !key ||
    Buffer.byteLength(key) > 4096 ||
    !operations.length ||
    (headSourceId !== undefined && (!headSourceId || Buffer.byteLength(headSourceId) > 4096))
  ) {
    revoke(observer, 'owned write setup');
    return undefined;
  }
  let insertsLookupDirty = false;
  if (
    headSourceId &&
    terminalStatement(
      db,
      "SELECT 1 FROM sqlite_temp_schema WHERE type='table' AND name='__intake_lookup_authorities'",
    ).get()
  ) {
    const authorities = terminalStatement(
      db,
      'SELECT source_id FROM temp.__intake_lookup_authorities WHERE authority_key=? LIMIT 2',
    ).all(key);
    if (authorities.length === 1 && authorities[0]!.source_id === headSourceId)
      insertsLookupDirty = !terminalStatement(
        db,
        'SELECT 1 FROM temp.__intake_lookup_dirty WHERE source_id=?',
      ).get(headSourceId);
    else if (authorities.length) revoke(observer, 'lookup dirty authority binding');
  }
  const expected = {
    table: 'app_meta' as const,
    key,
    operations,
    headSourceId,
    insertsLookupDirty,
    seen: 0,
  };
  observer.expected = expected;
  return expected;
}

/** The accepted-record projector alone writes the singleton durability row. */
export function expectIntakeFrontierStateWrite(db: DatabaseSync): ExpectedWrite | undefined {
  const observer = observers.get(db);
  if (!observer || observer.revoked) return undefined;
  if (observer.expected) {
    revoke(observer, 'durability write setup');
    return undefined;
  }
  const expected = {
    table: '__record_state' as const,
    key: '1',
    operations: ['insert'] as const,
    seen: 0,
  };
  observer.expected = expected;
  return expected;
}

/** Only an exact production statement may claim one source-row event. The row is
 * still a candidate until accepted evidence and the original file are checked. */
function clinicalPinValue(db: DatabaseSync): bigint {
  const statement = terminalStatement(
    db,
    'SELECT value FROM temp.__intake_clinical_cache_pin WHERE id=1',
    undefined,
    true,
  );
  statement.setReadBigInts(true);
  const value = statement.get()?.value;
  if (typeof value !== 'bigint') throw Error('Clinical cache pin is unavailable');
  return value;
}

function sourceMarker(
  db: DatabaseSync,
  table: '__record_changed' | '__source_text_dirty' | '__intake_lookup_dirty',
  id: string,
): boolean | null {
  const present = terminalStatement(
    db,
    "SELECT 1 AS present FROM temp.sqlite_master WHERE type='table' AND name=?",
  ).get(table);
  if (!present) return null;
  const sql =
    table === '__record_changed'
      ? "SELECT 1 AS present FROM temp.__record_changed WHERE entity='source_files' AND record_id=json_array(?)"
      : table === '__source_text_dirty'
        ? 'SELECT 1 AS present FROM temp.__source_text_dirty WHERE source_id=?'
        : 'SELECT 1 AS present FROM temp.__intake_lookup_dirty WHERE source_id=?';
  return !!terminalStatement(db, sql).get(id);
}

/** A registered non-original row (a proposal or extracted child) is never a
 * lookup catalog member; it is credited without a selected-head identity. */
export function expectIntakeFrontierSourceWrite(
  db: DatabaseSync,
  id: string,
  operation: 'insert' | 'update',
  kind = 'intake_original',
): ExpectedWrite | undefined {
  const observer = observers.get(db);
  if (!observer || observer.revoked) return undefined;
  const token = currentTransactionToken(db);
  if (
    !token ||
    !db.isTransaction ||
    observer.activeToken !== token ||
    observer.expected ||
    !id ||
    Buffer.byteLength(id) > 4096 ||
    !kind ||
    Buffer.byteLength(kind) > 4096 ||
    (operation === 'update' && kind !== 'intake_original')
  ) {
    revoke(observer, 'source write setup');
    return undefined;
  }
  const before = terminalStatement(
    db,
    'SELECT rowid AS source_rowid,kind FROM main.source_files WHERE id=?',
    undefined,
    true,
  );
  before.setReadBigInts(true);
  const prior = before.get(id);
  const oldRowid = prior?.source_rowid;
  const maximum = terminalStatement(
    db,
    'SELECT MAX(rowid) AS maximum_rowid FROM main.source_files',
    undefined,
    true,
  );
  maximum.setReadBigInts(true);
  const maximumRowid = maximum.get()?.maximum_rowid;
  if (
    (operation === 'insert' && oldRowid !== undefined) ||
    (operation === 'update' &&
      (typeof oldRowid !== 'bigint' || prior?.kind !== 'intake_original')) ||
    (maximumRowid !== null && typeof maximumRowid !== 'bigint')
  ) {
    revoke(observer, 'source write prior row');
    return undefined;
  }
  let sourceClinicalPin: bigint;
  let sourceClinicalWrites: bigint;
  let sourceTempSchema: number | bigint;
  let sourceCaptureBefore: boolean | null;
  let sourceDirtyBefore: boolean | null;
  let sourceLookupDirtyBefore: boolean | null;
  try {
    sourceClinicalPin = clinicalPinValue(db);
    // The fixed pin trigger's own WHEN clause: an unreferenced proposal row
    // does not change clinical state. Every other inserted kind does.
    sourceClinicalWrites =
      operation === 'update'
        ? 0n
        : kind !== 'intake_proposal' ||
            terminalStatement(
              db,
              'SELECT 1 AS present FROM main.source_records WHERE source_file_id=? LIMIT 1',
            ).get(id)
          ? 1n
          : 0n;
    sourceTempSchema = tempSchema(db);
    sourceCaptureBefore = sourceMarker(db, '__record_changed', id);
    sourceDirtyBefore = sourceMarker(db, '__source_text_dirty', id);
    sourceLookupDirtyBefore = sourceMarker(db, '__intake_lookup_dirty', id);
  } catch {
    revoke(observer, 'source clinical pin unavailable');
    return undefined;
  }
  const expected: ExpectedWrite = {
    table: 'source_files',
    key: id,
    operations: [operation],
    headSourceId: kind === 'intake_original' ? id : undefined,
    sourceToken: token,
    sourceKind: kind,
    sourceClinicalWrites,
    sourceBeforeRowid: oldRowid as bigint | undefined,
    sourceMaximumRowid: maximumRowid as bigint | undefined,
    sourceBeforeChanges: totalChanges(db),
    sourceClinicalPin,
    sourceTempSchema,
    sourceCaptureBefore,
    sourceDirtyBefore,
    sourceLookupDirtyBefore,
    seen: 0,
  };
  observer.expected = expected;
  return expected;
}

export function finishIntakeFrontierSourceWrite(
  db: DatabaseSync,
  expected: ExpectedWrite | undefined,
  written: boolean,
): void {
  if (!expected) return;
  const observer = observers.get(db);
  if (!observer || observer.expected !== expected) return;
  observer.expected = undefined;
  if (
    expected.table !== 'source_files' ||
    expected.sourceToken !== currentTransactionToken(db) ||
    expected.seen !== Number(written)
  ) {
    revoke(observer, 'source write completion');
    return;
  }
  const after = terminalStatement(
    db,
    'SELECT rowid AS source_rowid,kind FROM main.source_files WHERE id=?',
    undefined,
    true,
  );
  after.setReadBigInts(true);
  const next = after.get(expected.key);
  const nextRowid = next?.source_rowid;
  let clinicalWrites: bigint;
  let captureWrites: bigint;
  let dirtyWrites: bigint;
  let lookupDirtyWrites: bigint;
  try {
    clinicalWrites = clinicalPinValue(db) - expected.sourceClinicalPin!;
    const captureAfter = sourceMarker(db, '__record_changed', expected.key);
    const dirtyAfter = sourceMarker(db, '__source_text_dirty', expected.key);
    const lookupDirtyAfter = sourceMarker(db, '__intake_lookup_dirty', expected.key);
    if (
      (expected.sourceCaptureBefore === null) !== (captureAfter === null) ||
      (expected.sourceDirtyBefore === null) !== (dirtyAfter === null) ||
      (expected.sourceLookupDirtyBefore === null) !== (lookupDirtyAfter === null) ||
      (expected.sourceCaptureBefore === true && captureAfter !== true) ||
      (expected.sourceDirtyBefore === true && dirtyAfter !== true) ||
      (expected.sourceLookupDirtyBefore === true && lookupDirtyAfter !== true)
    )
      throw Error('Source marker changed outside its owned trigger');
    captureWrites = expected.sourceCaptureBefore === false && captureAfter === true ? 1n : 0n;
    dirtyWrites = expected.sourceDirtyBefore === false && dirtyAfter === true ? 1n : 0n;
    lookupDirtyWrites =
      expected.sourceLookupDirtyBefore === false && lookupDirtyAfter === true ? 1n : 0n;
  } catch {
    revoke(observer, 'source trigger witness unavailable');
    return;
  }
  const sourceChanges = totalChanges(db) - expected.sourceBeforeChanges!;
  if (
    !written ||
    tempSchema(db) !== expected.sourceTempSchema ||
    clinicalWrites !== expected.sourceClinicalWrites ||
    sourceChanges !== 1n + clinicalWrites + captureWrites + dirtyWrites + lookupDirtyWrites ||
    typeof nextRowid !== 'bigint' ||
    next?.kind !== expected.sourceKind ||
    (expected.operations[0] === 'update' && nextRowid !== expected.sourceBeforeRowid) ||
    (expected.operations[0] === 'insert' &&
      expected.sourceMaximumRowid !== undefined &&
      nextRowid <= expected.sourceMaximumRowid)
  )
    revoke(observer, 'source write row identity');
  else {
    observer.activeSourceClinicalWrites =
      (observer.activeSourceClinicalWrites ?? 0n) + clinicalWrites;
    observer.activeSourceTriggerWrites =
      (observer.activeSourceTriggerWrites ?? 0n) + captureWrites + dirtyWrites + lookupDirtyWrites;
  }
}

/** The exporter's internal curation revision is not an accepted record. Its
 * exact autocommit statement is tracked without renewing a stale frontier. */
export function expectIntakeFrontierCurationRevisionWrite(
  db: DatabaseSync,
  value: string,
): ExpectedWrite | undefined {
  const observer = observers.get(db);
  if (!observer || observer.revoked) return undefined;
  if (
    db.isTransaction ||
    observer.activeToken ||
    observer.expected ||
    observer.auxiliary ||
    !value ||
    Buffer.byteLength(value) > 4096 ||
    !settleUnrelatedChanges(db, observer)
  ) {
    revoke(observer, 'curation revision setup');
    return undefined;
  }
  const expected: ExpectedWrite = {
    table: 'app_meta',
    key: 'curation_revision',
    operations: ['insert', 'update'],
    standaloneBeforeChanges: observer.settledChanges,
    standaloneValue: value,
    seen: 0,
  };
  observer.expected = expected;
  return expected;
}

export function finishIntakeFrontierCurationRevisionWrite(
  db: DatabaseSync,
  expected: ExpectedWrite | undefined,
  written: boolean,
): void {
  if (!expected) return;
  const observer = observers.get(db);
  if (!observer || observer.expected !== expected) return;
  observer.expected = undefined;
  const changes = totalChanges(db);
  if (
    db.isTransaction ||
    observer.activeToken ||
    expected.key !== 'curation_revision' ||
    expected.standaloneBeforeChanges === undefined ||
    expected.standaloneValue === undefined ||
    !written ||
    expected.seen !== 1 ||
    changes !== expected.standaloneBeforeChanges + 1n ||
    terminalStatement(db, 'SELECT value FROM main.app_meta WHERE key=?').get('curation_revision')
      ?.value !== expected.standaloneValue
  ) {
    revoke(observer, 'curation revision completion');
    return;
  }
  observer.settledChanges = changes;
}

export function finishIntakeFrontierMetaWrite(
  db: DatabaseSync,
  expected: ExpectedWrite | undefined,
  written: boolean,
): void {
  if (!expected) return;
  const observer = observers.get(db);
  if (!observer || observer.expected !== expected) return;
  if (expected.seen !== Number(written)) revoke(observer, 'owned write completion');
  if (written && expected.insertsLookupDirty && expected.headSourceId) {
    if (
      // A compact terminal publication may finish this write; only fixed
      // terminal statements may run there, never a managed prepare.
      !terminalStatement(db, 'SELECT 1 FROM temp.__intake_lookup_dirty WHERE source_id=?').get(
        expected.headSourceId,
      )
    )
      revoke(observer, 'lookup dirty insertion missing');
    else {
      observer.activeLookupDirtyWrites++;
      observer.activeLookupDirtyHeadKey = expected.key;
    }
  }
  observer.expected = undefined;
}

/** Only fixed disposable index builders use this across their own awaited preparation. */
export function beginIntakeFrontierAuxiliaryPreparation(
  db: DatabaseSync,
  kind: AuxiliaryKind,
): AuxiliaryPreparation | undefined {
  const observer = observers.get(db);
  if (
    !observer ||
    observer.revoked ||
    observer.expected ||
    observer.auxiliary ||
    observer.activeToken ||
    db.isTransaction ||
    protectedIntakeLookupTempShadow(db) ||
    !settleUnrelatedChanges(db, observer)
  ) {
    return undefined;
  }
  const preparation = {
    kind,
    beforeAttempts: observer.attempts,
    mainSchema: mainSchema(db),
    statement: false,
    ddl: false,
  };
  observer.auxiliary = preparation;
  if (!rearmManagedDatabaseAuthorization(db)) revoke(observer, 'auxiliary authorizer');
  return preparation;
}

function auxiliaryStatement<T>(
  db: DatabaseSync,
  preparation: AuxiliaryPreparation | undefined,
  fn: () => T,
  ddl = false,
): T {
  const observer = observers.get(db);
  if (!preparation || !observer || observer.auxiliary !== preparation || observer.revoked)
    return fn();
  if (preparation.statement || db.isTransaction) {
    revoke(observer, 'auxiliary statement overlap');
    return fn();
  }
  preparation.statement = true;
  preparation.ddl = ddl;
  try {
    return fn();
  } catch (error) {
    revoke(observer, 'auxiliary statement failed');
    throw error;
  } finally {
    preparation.statement = false;
    preparation.ddl = false;
    if (!rearmManagedDatabaseAuthorization(db)) revoke(observer, 'auxiliary rearm');
  }
}

export function execIntakeFrontierAuxiliarySQL(
  db: DatabaseSync,
  preparation: AuxiliaryPreparation | undefined,
  sql: string,
): void {
  auxiliaryStatement(db, preparation, () => db.exec(sql), /^\s*(?:CREATE|DROP)\b/i.test(sql));
}

export function runIntakeFrontierAuxiliaryInsert(
  db: DatabaseSync,
  preparation: AuxiliaryPreparation | undefined,
  insert: StatementSync,
  values: readonly (string | number | bigint | null)[],
): void {
  auxiliaryStatement(db, preparation, () => insert.run(...values));
}

export function prepareIntakeFrontierAuxiliaryInsert(
  db: DatabaseSync,
  preparation: AuxiliaryPreparation | undefined,
  sql: string,
): StatementSync {
  return auxiliaryStatement(db, preparation, () => db.prepare(sql));
}

export function finishIntakeFrontierAuxiliaryPreparation(
  db: DatabaseSync,
  preparation: AuxiliaryPreparation | undefined,
  complete: boolean,
): boolean {
  if (!preparation) return false;
  const observer = observers.get(db);
  if (!observer || observer.auxiliary !== preparation) return false;
  observer.auxiliary = undefined;
  if (
    !complete ||
    observer.revoked ||
    preparation.statement ||
    observer.attempts !== preparation.beforeAttempts ||
    mainSchema(db) !== preparation.mainSchema ||
    db.isTransaction ||
    protectedIntakeLookupTempShadow(db) ||
    !rearmManagedDatabaseAuthorization(db)
  ) {
    revoke(observer, 'auxiliary completion');
    return false;
  }
  observer.settledChanges = totalChanges(db);
  observer.auxiliarySequence++;
  return true;
}
