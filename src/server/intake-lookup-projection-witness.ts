import { randomUUID } from 'node:crypto';
import { constants, type DatabaseSync } from 'node:sqlite';
import {
  managedDatabaseMethodEpoch,
  observeDatabaseClose,
  observeManagedDatabaseAuthorization,
  observeManagedDatabaseFunctionRegistration,
  observeTransactionOutcome,
} from './database.ts';

const names = ['state', 'sources', 'groups', 'acceptances', 'identities', 'payloads'] as const;
interface Witness {
  readonly functionName: string;
  readonly triggerNames: readonly string[];
  readonly triggerSql: readonly string[];
  readonly dispose: () => void;
  foreign: number;
  authorizationVersion: number;
  foreignMutation: boolean;
  inputVersion: number;
  inputOverflow: boolean;
  pendingSources: Set<string>;
  pendingHeadKeys: Set<string>;
  owned?: ProjectionWriteTicket & { events: number; invalid: boolean; method: object | undefined };
  functionReplaced: boolean;
  sealed?: Readonly<{
    inputVersion: number;
    authorizationVersion: number;
    foreign: number;
    method: object;
    mainSchema: unknown;
    tempSchema: unknown;
    peer: unknown;
    otherSchema: string;
  }>;
}
type ProjectionTable = (typeof names)[number];
type ProjectionOperation = 'insert' | 'update' | 'delete';
export interface ProjectionWriteTicket {
  table: ProjectionTable;
  operations: readonly ProjectionOperation[];
  key: string;
  subkey?: string;
}
const witnesses = new WeakMap<DatabaseSync, Witness>();
const suffixes = new WeakMap<DatabaseSync, string>();
const MAX_PENDING_INPUTS = 100;
const scalar = (db: DatabaseSync, pragma: string): unknown =>
  Object.values(db.prepare(`PRAGMA ${pragma}`).get() ?? {})[0];
const otherSchema = (db: DatabaseSync): string =>
  JSON.stringify(
    db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE NOT (type='index' AND name IN ('__record_intake_lookup_discovery','__record_intake_lookup_operation','__record_intake_lookup_acceptance_hash','__record_intake_lookup_identity_hash','__record_intake_lookup_authority')) ORDER BY type,name",
      )
      .all(),
  );
const readOnlyPragmas = new Set([
  'table_info',
  'table_xinfo',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
]);

function triggersIntact(db: DatabaseSync, witness: Witness): boolean {
  return witness.triggerNames.every(
    (name, index) =>
      db.prepare("SELECT sql FROM sqlite_temp_schema WHERE type='trigger' AND name=?").get(name)
        ?.sql === witness.triggerSql[index],
  );
}

export function ensureIntakeProjectionWitness(db: DatabaseSync): void {
  const prior = witnesses.get(db);
  if (prior?.functionReplaced) throw Error('Intake projection observer function was replaced');
  if (prior && triggersIntact(db, prior)) return;
  if (prior) resetIntakeProjectionWitness(db);
  let suffix = suffixes.get(db);
  if (!suffix) {
    suffix = randomUUID().replaceAll('-', '');
    suffixes.set(db, suffix);
  }
  const functionName = `__intake_projection_event_${suffix}`;
  const triggerNames: string[] = [];
  let witness: Witness | undefined;
  db.function(functionName, (table: unknown, operation: unknown, key: unknown, subkey: unknown) => {
    if (witness) {
      if (table === 'source_files' || table === 'app_meta') {
        witness.inputVersion++;
        const pending = table === 'source_files' ? witness.pendingSources : witness.pendingHeadKeys;
        if (
          !Number.isSafeInteger(witness.inputVersion) ||
          typeof key !== 'string' ||
          (!pending.has(key) && pending.size >= MAX_PENDING_INPUTS)
        ) {
          witness.inputOverflow = true;
          witness.sealed = undefined;
        } else pending.add(key);
        return null;
      }
      const ticket = witness.owned;
      if (
        !ticket ||
        table !== ticket.table ||
        !ticket.operations.includes(operation as ProjectionOperation) ||
        key !== ticket.key ||
        (ticket.subkey !== undefined && subkey !== ticket.subkey)
      ) {
        witness.foreign++;
        witness.foreignMutation = true;
        witness.sealed = undefined;
        if (ticket) ticket.invalid = true;
      } else {
        ticket.events++;
      }
    }
    return null;
  });
  for (const name of names) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const trigger = `__intake_projection_${name}_${operation.toLowerCase()}_${suffix}`;
      const side = operation === 'DELETE' ? 'OLD' : 'NEW';
      const key =
        name === 'payloads'
          ? `${side}.hash`
          : name === 'state'
            ? `CAST(${side}.singleton AS TEXT)`
            : `${side}.source_id`;
      const subkey =
        name === 'groups'
          ? `CAST(${side}.ordinal AS TEXT)`
          : name === 'acceptances'
            ? `${side}.operation_id`
            : name === 'identities'
              ? `CAST(${side}.id AS TEXT)`
              : 'NULL';
      db.exec(
        `CREATE TEMP TRIGGER ${trigger} AFTER ${operation} ON main.__record_intake_lookup_${name} BEGIN SELECT ${functionName}('${name}','${operation.toLowerCase()}',${key},${subkey}); END`,
      );
      triggerNames.push(trigger);
    }
  }
  for (const [table, column] of [
    ['source_files', 'id'],
    ['app_meta', 'key'],
  ] as const) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const trigger = `__intake_projection_${table}_${operation.toLowerCase()}_${suffix}`;
      const sides =
        operation === 'UPDATE' ? ['OLD', 'NEW'] : [operation === 'DELETE' ? 'OLD' : 'NEW'];
      db.exec(
        `CREATE TEMP TRIGGER ${trigger} AFTER ${operation} ON main.${table} BEGIN ${sides.map((side) => `SELECT ${functionName}('${table}','${operation.toLowerCase()}',${side}.${column},NULL);`).join(' ')} END`,
      );
      triggerNames.push(trigger);
    }
  }
  const triggerSql = triggerNames.map((name) =>
    String(
      db.prepare("SELECT sql FROM sqlite_temp_schema WHERE type='trigger' AND name=?").get(name)
        ?.sql,
    ),
  );
  const stopAuthorization = observeManagedDatabaseAuthorization(
    db,
    (action, _name, detail) => {
      if (!witness) return;
      if (
        action === constants.SQLITE_CREATE_TRIGGER ||
        action === constants.SQLITE_CREATE_TEMP_TRIGGER ||
        action === constants.SQLITE_DROP_TRIGGER ||
        action === constants.SQLITE_DROP_TEMP_TRIGGER ||
        action === constants.SQLITE_ALTER_TABLE ||
        action === constants.SQLITE_CREATE_TABLE ||
        action === constants.SQLITE_CREATE_TEMP_TABLE ||
        action === constants.SQLITE_DROP_TABLE ||
        action === constants.SQLITE_DROP_TEMP_TABLE ||
        action === constants.SQLITE_CREATE_VIEW ||
        action === constants.SQLITE_CREATE_TEMP_VIEW ||
        action === constants.SQLITE_DROP_VIEW ||
        action === constants.SQLITE_DROP_TEMP_VIEW ||
        (action === constants.SQLITE_PRAGMA && detail !== null && !readOnlyPragmas.has(_name ?? ''))
      ) {
        witness.authorizationVersion++;
        witness.sealed = undefined;
      }
    },
    () => {
      if (witness) {
        witness.authorizationVersion++;
        witness.sealed = undefined;
      }
    },
  );
  const stopFunction = observeManagedDatabaseFunctionRegistration(db, (name) => {
    if (witness && name.toLowerCase() === functionName.toLowerCase()) {
      witness.functionReplaced = true;
      witness.authorizationVersion++;
      witness.sealed = undefined;
    }
  });
  const stopOutcome = observeTransactionOutcome(db, (outcome) => {
    if (witness && !outcome.succeeded) {
      witness.authorizationVersion++;
      witness.sealed = undefined;
    }
  });
  const stopClose = observeDatabaseClose(db, () => {
    witnesses.delete(db);
  });
  witness = {
    functionName,
    triggerNames,
    triggerSql,
    foreign: 0,
    authorizationVersion: 0,
    foreignMutation: false,
    inputVersion: 0,
    inputOverflow: false,
    pendingSources: new Set(),
    pendingHeadKeys: new Set(),
    owned: undefined,
    functionReplaced: false,
    dispose: () => {
      stopAuthorization?.();
      stopFunction?.();
      stopOutcome();
      stopClose();
    },
  };
  witnesses.set(db, witness);
}

export function resetIntakeProjectionWitness(db: DatabaseSync): void {
  const witness = witnesses.get(db);
  if (!witness) return;
  witness.dispose();
  witnesses.delete(db);
  for (const name of witness.triggerNames) db.exec(`DROP TRIGGER IF EXISTS temp.${name}`);
}

/** This scope encloses one fixed synchronous projection statement, never source parsing. */
export function ownedIntakeProjectionWrite<T>(
  db: DatabaseSync,
  ticket: ProjectionWriteTicket,
  write: () => T,
): T {
  const witness = witnesses.get(db);
  if (!witness) return write();
  if (witness.owned) {
    witness.sealed = undefined;
    throw Error('Nested intake projection write');
  }
  const active = { ...ticket, events: 0, invalid: false, method: managedDatabaseMethodEpoch(db) };
  witness.owned = active;
  try {
    const result = write();
    const count = Array.isArray(result)
      ? result.length
      : result && typeof result === 'object' && 'changes' in result
        ? Number(result.changes)
        : result === undefined
          ? 0
          : 1;
    if (
      active.invalid ||
      !Number.isSafeInteger(count) ||
      active.events !== count ||
      active.method !== managedDatabaseMethodEpoch(db)
    ) {
      witness.sealed = undefined;
      throw Error('Intake projection owned write diverged');
    }
    return result;
  } catch (error) {
    witness.sealed = undefined;
    throw error;
  } finally {
    witness.owned = undefined;
  }
}

export function intakeProjectionWitnessCurrent(db: DatabaseSync): boolean {
  const witness = witnesses.get(db),
    seal = witness?.sealed;
  if (!witness || !seal) return false;
  const mainSchema = scalar(db, 'main.schema_version');
  const tempSchema = scalar(db, 'temp.schema_version');
  const peer = scalar(db, 'data_version');
  const intact = triggersIntact(db, witness);
  return !!(
    witnesses.get(db) === witness &&
    witness.sealed === seal &&
    !witness.owned &&
    !witness.functionReplaced &&
    !witness.foreignMutation &&
    !witness.inputOverflow &&
    witness.pendingSources.size === 0 &&
    witness.pendingHeadKeys.size === 0 &&
    witness.inputVersion === seal.inputVersion &&
    witness.authorizationVersion === seal.authorizationVersion &&
    witness.foreign === seal.foreign &&
    managedDatabaseMethodEpoch(db) === seal.method &&
    mainSchema === seal.mainSchema &&
    tempSchema === seal.tempSchema &&
    peer === seal.peer &&
    intact
  );
}

export function projectionAnswerWitness(db: DatabaseSync): object {
  if (!intakeProjectionWitnessCurrent(db))
    throw Error('Intake projection answer witness is unavailable');
  return witnesses.get(db)!.sealed!;
}

export function assertProjectionAnswerWitness(db: DatabaseSync, seal: object): void {
  const witness = witnesses.get(db);
  if (!witness || witness.sealed !== seal) throw Error('Intake projection answer witness changed');
  // The full trigger/schema check ran at capture. Supported local DDL and
  // replacement attempts are monotonic; peer changes advance data_version.
  const peer = scalar(db, 'data_version');
  if (
    witnesses.get(db) !== witness ||
    witness.sealed !== seal ||
    witness.owned ||
    witness.functionReplaced ||
    witness.foreignMutation ||
    witness.inputOverflow ||
    witness.pendingSources.size !== 0 ||
    witness.pendingHeadKeys.size !== 0 ||
    witness.inputVersion !== witness.sealed.inputVersion ||
    witness.authorizationVersion !== witness.sealed.authorizationVersion ||
    witness.foreign !== witness.sealed.foreign ||
    managedDatabaseMethodEpoch(db) !== witness.sealed.method ||
    peer !== witness.sealed.peer
  )
    throw Error('Intake projection answer witness changed');
}

export function projectionWitnessHasForeignMutation(db: DatabaseSync): boolean {
  return witnesses.get(db)?.foreignMutation === true;
}

export function projectionInputVersion(db: DatabaseSync): number | undefined {
  return witnesses.get(db)?.inputVersion;
}

export function projectionWitnessRevision(db: DatabaseSync):
  | {
      inputVersion: number;
      foreign: number;
      authorizationVersion: number;
      identity: object;
      method: object | undefined;
      mainSchema: unknown;
      tempSchema: unknown;
      peer: unknown;
    }
  | undefined {
  const witness = witnesses.get(db);
  return (
    witness && {
      inputVersion: witness.inputVersion,
      foreign: witness.foreign,
      authorizationVersion: witness.authorizationVersion,
      identity: witness,
      method: managedDatabaseMethodEpoch(db),
      mainSchema: scalar(db, 'main.schema_version'),
      tempSchema: scalar(db, 'temp.schema_version'),
      peer: scalar(db, 'data_version'),
    }
  );
}

/** Only rows actually reconciled by this uninterrupted pass can close input events. */
export function acknowledgeProjectionInputs(
  db: DatabaseSync,
  beforeVersion: number | undefined,
  reconciled: ReadonlySet<string>,
): void {
  const witness = witnesses.get(db);
  if (!witness || beforeVersion === undefined || witness.inputVersion !== beforeVersion) return;
  const beforeAuthorization = witness.authorizationVersion;
  const beforeForeign = witness.foreign;
  const beforeMethod = managedDatabaseMethodEpoch(db);
  const seal = witness.sealed;
  const acknowledgedKeys: string[] = [];
  for (const key of witness.pendingHeadKeys) {
    const rows = db
      .prepare('SELECT source_id FROM __record_intake_lookup_sources WHERE authority_key=? LIMIT 2')
      .all(key);
    if (rows.length === 0 || (rows.length === 1 && reconciled.has(String(rows[0]!.source_id))))
      acknowledgedKeys.push(key);
  }
  if (
    witnesses.get(db) !== witness ||
    witness.inputVersion !== beforeVersion ||
    witness.authorizationVersion !== beforeAuthorization ||
    witness.foreign !== beforeForeign ||
    managedDatabaseMethodEpoch(db) !== beforeMethod ||
    witness.sealed !== seal
  )
    return;
  for (const id of reconciled) witness.pendingSources.delete(id);
  for (const key of acknowledgedKeys) witness.pendingHeadKeys.delete(key);
  if (
    seal &&
    !witness.inputOverflow &&
    witness.pendingSources.size === 0 &&
    witness.pendingHeadKeys.size === 0
  )
    if (seal.inputVersion !== witness.inputVersion)
      witness.sealed = Object.freeze({ ...seal, inputVersion: witness.inputVersion });
}

/** Only known disposable-index DDL may change while all other schema SQL stays exact. */
export function renewIntakeProjectionWitnessAfterIndexRepair(db: DatabaseSync): boolean {
  const witness = witnesses.get(db),
    seal = witness?.sealed;
  if (!witness || !seal) return false;
  const tempSchema = scalar(db, 'temp.schema_version');
  const peer = scalar(db, 'data_version');
  const intact = triggersIntact(db, witness);
  const schema = otherSchema(db);
  const mainSchema = scalar(db, 'main.schema_version');
  if (
    witnesses.get(db) !== witness ||
    witness.sealed !== seal ||
    witness.functionReplaced ||
    witness.foreignMutation ||
    witness.inputOverflow ||
    witness.pendingSources.size !== 0 ||
    witness.pendingHeadKeys.size !== 0 ||
    witness.inputVersion !== seal.inputVersion ||
    witness.authorizationVersion !== seal.authorizationVersion ||
    witness.foreign !== seal.foreign ||
    managedDatabaseMethodEpoch(db) !== seal.method ||
    tempSchema !== seal.tempSchema ||
    peer !== seal.peer ||
    !intact ||
    schema !== seal.otherSchema
  )
    return false;
  if (seal.mainSchema !== mainSchema) witness.sealed = Object.freeze({ ...seal, mainSchema });
  return true;
}

export function sealIntakeProjectionWitness(
  db: DatabaseSync,
  revision: ReturnType<typeof projectionWitnessRevision>,
  completeSources = false,
): void {
  const witness = witnesses.get(db);
  if (!witness || !revision) throw Error('Intake projection witness is unavailable');
  const mainSchema = scalar(db, 'main.schema_version');
  const tempSchema = scalar(db, 'temp.schema_version');
  const peer = scalar(db, 'data_version');
  const schema = otherSchema(db);
  const intact = triggersIntact(db, witness);
  const method = managedDatabaseMethodEpoch(db);
  if (
    !method ||
    witnesses.get(db) !== witness ||
    revision.identity !== witness ||
    witness.inputVersion !== revision.inputVersion ||
    witness.foreign !== revision.foreign ||
    witness.authorizationVersion !== revision.authorizationVersion ||
    method !== revision.method ||
    (!completeSources &&
      (witness.inputOverflow ||
        witness.pendingSources.size !== 0 ||
        witness.pendingHeadKeys.size !== 0)) ||
    mainSchema !== revision.mainSchema ||
    tempSchema !== revision.tempSchema ||
    peer !== revision.peer ||
    witness.owned ||
    witness.functionReplaced ||
    !intact
  )
    throw Error('Intake projection witness is unavailable');
  witness.sealed = Object.freeze({
    inputVersion: witness.inputVersion,
    authorizationVersion: witness.authorizationVersion,
    foreign: witness.foreign,
    method,
    mainSchema,
    tempSchema,
    peer,
    otherSchema: schema,
  });
  witness.pendingSources.clear();
  witness.pendingHeadKeys.clear();
  witness.inputOverflow = false;
  witness.foreignMutation = false;
}

export function discardIntakeProjectionWitness(db: DatabaseSync): void {
  const witness = witnesses.get(db);
  if (witness) witness.sealed = undefined;
}
