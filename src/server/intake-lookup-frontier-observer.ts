import { randomUUID } from 'node:crypto';
import { constants, type DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  managedDatabaseAuthorizerSetter,
  managedDatabaseFunctionSetter,
  currentTransactionToken,
  observeManagedDatabaseAuthorization,
  observeManagedDatabaseFunctionRegistration,
  observeTransactionOutcome,
  observeTransactionStart,
  rearmManagedDatabaseAuthorization,
} from './database.ts';
import { intakeClinicalCachePin } from './intake-clinical-cache-pin.ts';
import { consumeRecordMaintenanceBookkeeping } from './record-versions.ts';

type Operation = 'insert' | 'update' | 'delete';

interface ExpectedWrite {
  readonly table: 'app_meta' | '__record_state';
  readonly key: string;
  readonly operations: readonly Operation[];
  readonly headSourceId?: string;
  readonly insertsLookupDirty?: boolean;
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
  readonly headChanges: Map<string, number>;
  headFloorAttempts: number;
  readonly ordinaryOutcomes: Map<object, { sequence: number; unrelatedChanges: bigint }>;
  ordinaryFloorSequence: number;
  outcomeSequence: number;
  settledChanges: bigint;
  unrelatedChanges: bigint;
  activeToken?: object;
  activeChanges?: bigint;
  activeAttempts?: number;
  activeMetadata?: Set<string>;
  activeLookupDirtyWrites: bigint;
  captureClearCount: number;
  clearingCapture?: { seen: boolean };
  changesetPragma?: { phase: 0 | 1 | 2 };
  expected?: ExpectedWrite;
  auxiliary?: AuxiliaryPreparation;
  auxiliarySequence: number;
  functionReplaced: boolean;
  revoked: boolean;
  firstRevocation?: string;
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
  readonly auxiliarySequence: number;
}

const observers = new WeakMap<DatabaseSync, Observer>();
function revoke(observer: Observer, reason: string): void {
  if (!observer.revoked) observer.firstRevocation = reason;
  observer.revoked = true;
}
const MAX_ATTEMPTS = Number.MAX_SAFE_INTEGER;
const MAX_HEAD_SOURCES = 100;
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
  const value = db.prepare('PRAGMA temp.schema_version').get()?.schema_version;
  if (typeof value !== 'number' && typeof value !== 'bigint')
    throw Error('Intake frontier TEMP schema is unavailable');
  return value;
}

function mainSchema(db: DatabaseSync): number | bigint {
  const value = db.prepare('PRAGMA main.schema_version').get()?.schema_version;
  if (typeof value !== 'number' && typeof value !== 'bigint')
    throw Error('Intake frontier main schema is unavailable');
  return value;
}

function dataVersion(db: DatabaseSync): number | bigint {
  const value = db.prepare('PRAGMA data_version').get()?.data_version;
  if (typeof value !== 'number' && typeof value !== 'bigint')
    throw Error('Intake frontier peer revision is unavailable');
  return value;
}

function totalChanges(db: DatabaseSync): bigint {
  const statement = db.prepare('SELECT total_changes() AS count');
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

export function protectedIntakeLookupTempShadow(db: DatabaseSync): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_temp_schema WHERE type IN ('table','view') AND (lower(name) IN ('source_files','app_meta','__record_state') OR lower(name) GLOB '__record_intake_lookup_*') LIMIT 1",
    )
    .get();
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
    existing.identity = {};
    existing.attempts = 0;
    existing.ownedWrites = 0;
    existing.headChanges.clear();
    existing.headFloorAttempts = 0;
    existing.ordinaryOutcomes.clear();
    existing.ordinaryFloorSequence = 0;
    existing.outcomeSequence = 0;
    existing.settledChanges = totalChanges(db);
    existing.unrelatedChanges = 0n;
    existing.activeToken = undefined;
    existing.activeChanges = undefined;
    existing.activeAttempts = undefined;
    existing.expected = undefined;
    existing.auxiliary = undefined;
    existing.auxiliarySequence = 0;
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
      (table !== 'app_meta' && table !== '__record_state') ||
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
      if (table === 'app_meta' && observer.activeMetadata) {
        if (observer.activeMetadata.size >= 4100 && !observer.activeMetadata.has(key!))
          revoke(observer, 'maintenance metadata window');
        else observer.activeMetadata.add(key!);
      }
      if (expected.headSourceId) {
        observer.headChanges.delete(expected.headSourceId);
        if (observer.headChanges.size >= MAX_HEAD_SOURCES) {
          const oldest = observer.headChanges.entries().next().value;
          if (oldest) {
            observer.headFloorAttempts = oldest[1];
            observer.headChanges.delete(oldest[0]);
          }
        }
        observer.headChanges.set(expected.headSourceId, observer.attempts);
      }
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
    activeLookupDirtyWrites: 0n,
    captureClearCount: 0,
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
    headChanges: new Map(),
    headFloorAttempts: 0,
    ordinaryOutcomes: new Map(),
    ordinaryFloorSequence: 0,
    outcomeSequence: 0,
    auxiliarySequence: 0,
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
        const captureDelete =
          action === constants.SQLITE_DELETE && _database === 'temp' && name === '__record_changed';
        const ownedCaptureDelete =
          captureDelete && observer.clearingCapture && !observer.clearingCapture.seen;
        if (ownedCaptureDelete) observer.clearingCapture!.seen = true;
        if (
          _database === 'temp' &&
          name === '__record_changed' &&
          writeActions.has(action) &&
          !(
            ownedCaptureDelete ||
            (action === constants.SQLITE_INSERT &&
              /^__record_capture_[a-z_]+_(INSERT|UPDATE|DELETE)$/.test(origin ?? ''))
          )
        )
          revoke(observer, 'unowned accepted-row capture write');
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
  observeTransactionStart(db, (token) => {
    if (!observer || observer.revoked) return;
    if (observer.auxiliary) revoke(observer, 'transaction during auxiliary');
    const changes = totalChanges(db);
    if (observer.activeToken || !settleUnrelatedChanges(db, observer)) {
      revoke(observer, 'transaction start');
    }
    observer.activeToken = token;
    observer.activeChanges = changes;
    observer.activeAttempts = observer.attempts;
    observer.activeMetadata = new Set();
    observer.activeLookupDirtyWrites = 0n;
    observer.captureClearCount = 0;
  });
  observeTransactionOutcome(db, (outcome) => {
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
    if (!outcome.succeeded || !outcome.committed || changes < observer.activeChanges) {
      revoke(observer, 'outcome failure');
    } else {
      const protectedWrites = BigInt(observer.attempts - observer.activeAttempts);
      const bookkeeping = outcome.intakeMaintenance
        ? consumeRecordMaintenanceBookkeeping(db, outcome.token)
        : 0n;
      const dirtyWrites = outcome.intakeMaintenance ? observer.activeLookupDirtyWrites : 0n;
      const extra = changes - observer.activeChanges - protectedWrites - bookkeeping - dirtyWrites;
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
      });
    }
    observer.settledChanges = changes;
    observer.activeToken = undefined;
    observer.activeChanges = undefined;
    observer.activeAttempts = undefined;
    observer.activeMetadata = undefined;
  });
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
export function clearIntakeFrontierRecordCapture(db: DatabaseSync): number | bigint {
  const observer = observers.get(db);
  if (observer?.clearingCapture) revoke(observer, 'reentrant accepted-row cleanup');
  if (observer) {
    if (!observer.activeToken || observer.captureClearCount >= 2)
      revoke(observer, 'accepted-row cleanup phase');
    observer.captureClearCount++;
  }
  const clearing = { seen: false };
  if (observer) observer.clearingCapture = clearing;
  try {
    // Fresh bytecode must consume this slot. Rearming here would invalidate
    // every unrelated prepared statement twice per durable publication.
    return db.prepare('DELETE FROM temp.__record_changed').run().changes;
  } finally {
    if (observer && !clearing.seen) revoke(observer, 'capture cleanup authorization missing');
    if (observer) observer.clearingCapture = undefined;
  }
}

export function captureIntakeFrontierAttempts(
  db: DatabaseSync,
): IntakeFrontierAttemptSnapshot | undefined {
  const observer = observers.get(db);
  if (
    !db.isOpen ||
    !observer ||
    observer.revoked ||
    observer.expected ||
    observer.auxiliary ||
    protectedIntakeLookupTempShadow(db) ||
    db.function !== observer.managedFunction ||
    db.setAuthorizer !== observer.managedAuthorizer ||
    db.applyChangeset !== observer.nativeApplyChangeset ||
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
    auxiliarySequence: observer.auxiliarySequence,
  };
}

function readAttempts(
  db: DatabaseSync,
  snapshot: IntakeFrontierAttemptSnapshot,
  mode: 'strict' | 'accepted' | 'source-equality',
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
    db.function !== observer.managedFunction ||
    db.setAuthorizer !== observer.managedAuthorizer ||
    db.applyChangeset !== observer.nativeApplyChangeset ||
    observer.activeToken !== undefined ||
    !settleUnrelatedChanges(db, observer) ||
    (mode === 'strict' && observer.unrelatedChanges !== snapshot.unrelatedChanges) ||
    mainSchema(db) !== snapshot.mainSchema ||
    dataVersion(db) !== snapshot.dataVersion ||
    (mode === 'source-equality' && observer.auxiliarySequence !== snapshot.auxiliarySequence) ||
    (tempSchema(db) !== snapshot.tempSchema &&
      observer.auxiliarySequence === snapshot.auxiliarySequence)
  )
    return undefined;
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
    headSourceIds: [...observer.headChanges]
      .filter(([, attempt]) => attempt > snapshot.attempts)
      .map(([sourceId]) => sourceId),
    ordinaryTokens: ordinary.map(([token]) => token),
  };
}

export function readIntakeFrontierAttempts(
  db: DatabaseSync,
  snapshot: IntakeFrontierAttemptSnapshot,
): ReturnType<typeof readAttempts> {
  return readAttempts(db, snapshot, 'strict');
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
  const apply = () =>
    db.applyChangeset(changes, { onConflict: () => constants.SQLITE_CHANGESET_ABORT });
  const observer = observers.get(db);
  if (!observer || observer.revoked) return apply();
  if (
    observer.changesetPragma ||
    observer.expected ||
    observer.auxiliary ||
    !observer.activeToken ||
    currentTransactionToken(db) !== observer.activeToken ||
    db.applyChangeset !== observer.nativeApplyChangeset
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
    db
      .prepare(
        "SELECT 1 FROM sqlite_temp_schema WHERE type='table' AND name='__intake_lookup_authorities'",
      )
      .get()
  ) {
    const authorities = db
      .prepare(
        'SELECT source_id FROM temp.__intake_lookup_authorities WHERE authority_key=? LIMIT 2',
      )
      .all(key);
    if (authorities.length === 1 && authorities[0]!.source_id === headSourceId)
      insertsLookupDirty = !db
        .prepare('SELECT 1 FROM temp.__intake_lookup_dirty WHERE source_id=?')
        .get(headSourceId);
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
      !db
        .prepare('SELECT 1 FROM temp.__intake_lookup_dirty WHERE source_id=?')
        .get(expected.headSourceId)
    )
      revoke(observer, 'lookup dirty insertion missing');
    else observer.activeLookupDirtyWrites++;
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
