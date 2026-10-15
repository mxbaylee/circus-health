import { constants, DatabaseSync, StatementSync } from 'node:sqlite';
import {
  HttpError,
  managedDatabaseMethodEpoch,
  observeManagedDatabaseAuthorization,
  prepareManagedDatabaseCallbackBarrier,
  withoutManagedDatabaseCallbacks,
} from './database.ts';
import {
  assertClinicalOperation,
  clinicalOperationCallerAssertions,
  clinicalOperationReadContinuations,
  type ClinicalOperation,
} from './clinical-operation.ts';
import {
  captureManagedPhysicalEpoch,
  managedPhysicalEpochCurrent,
} from './clinical-review-physical-epoch.ts';
import type { RecordReadOwner } from './record-versions.ts';
import type { OwnershipNameReadOwner } from './ownership-name-plan.ts';
import type { OwnershipReportReadOwner } from './ownership-report-plan.ts';
import type { ClinicalArtifactReadTerminal } from './clinical-review-artifact-proof.ts';
let validators:
  | {
      record: typeof import('./record-versions.ts');
      name: typeof import('./ownership-name-plan.ts');
      report: typeof import('./ownership-report-plan.ts');
      artifacts: typeof import('./clinical-review-artifact-proof.ts');
    }
  | undefined;

const nativePrepare = DatabaseSync.prototype.prepare,
  nativeGet = StatementSync.prototype.get;
const unavailable = () =>
  new HttpError(409, 'OWNERSHIP_CHANGED', 'Original ownership read authority changed');
declare const intervalBrand: unique symbol;
export interface OwnershipReadInterval {
  readonly [intervalBrand]: true;
}
const intervals = new WeakMap<
  OwnershipReadInterval,
  {
    db: DatabaseSync;
    assertCurrent(): void;
    close(): void;
    resources?: {
      record: RecordReadOwner;
      name: OwnershipNameReadOwner;
      report: OwnershipReportReadOwner;
    };
    terminal?: ClinicalArtifactReadTerminal;
  }
>();
declare const ownerBrand: unique symbol;
export interface OwnershipReadOwner {
  readonly [ownerBrand]: true;
}
const owners = new WeakMap<
  OwnershipReadOwner,
  {
    db: DatabaseSync;
    operation: ClinicalOperation;
    assertCurrent(): void;
  }
>();

/** Pins the original SQL/attempt interval; it does not certify physical files. */
export function captureOwnershipReadInterval(db: DatabaseSync) {
  let active = true,
    attempted = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail) => {
      const pragma =
        action === constants.SQLITE_PRAGMA &&
        ['schema_version', 'data_version'].includes(name ?? '') &&
        detail == null;
      // The finite native transport compiles its fail-safe ROLLBACK before proof.
      const rollback = action === constants.SQLITE_TRANSACTION && name === 'ROLLBACK';
      if (
        action !== constants.SQLITE_READ &&
        action !== constants.SQLITE_SELECT &&
        action !== constants.SQLITE_FUNCTION &&
        !pragma &&
        !rollback
      )
        attempted = true;
    },
    () => {
      attempted = true;
    },
  );
  if (!stop) throw unavailable();
  try {
    prepareManagedDatabaseCallbackBarrier(db);
    const methods = managedDatabaseMethodEpoch(db),
      physical = captureManagedPhysicalEpoch(),
      statements = [
        'SELECT total_changes() AS value',
        'PRAGMA main.schema_version',
        'PRAGMA temp.schema_version',
        'PRAGMA main.data_version',
      ].map((sql) => Reflect.apply(nativePrepare, db, [sql]));
    const stamp = () =>
      statements.map((statement) => Object.values(Reflect.apply(nativeGet, statement, [])!)[0]);
    const original = stamp();
    const assertCurrent = () => {
      if (physical && !managedPhysicalEpochCurrent(physical))
        throw new HttpError(
          409,
          'SOURCE_CHANGED',
          'Retained physical evidence changed; prepare a fresh review',
        );
      if (
        !active ||
        attempted ||
        !methods ||
        !physical ||
        !db.isOpen ||
        db.isTransaction ||
        managedDatabaseMethodEpoch(db) !== methods ||
        !managedPhysicalEpochCurrent(physical)
      )
        throw unavailable();
      withoutManagedDatabaseCallbacks(db, () => {
        const selected = stamp();
        if (selected.some((value, index) => value !== original[index])) throw unavailable();
      });
      if (attempted) throw unavailable();
    };
    assertCurrent();
    const value = Object.freeze({}) as OwnershipReadInterval;
    intervals.set(value, {
      db,
      assertCurrent,
      close() {
        if (!active) return;
        active = false;
        stop();
      },
    });
    return value;
  } catch (error) {
    active = false;
    stop();
    throw error;
  }
}
export function assertOwnershipReadInterval(db: DatabaseSync, value: OwnershipReadInterval): void {
  const original = intervals.get(value);
  if (!original || original.db !== db) throw unavailable();
  original.assertCurrent();
  if (original.resources) {
    if (!validators) throw unavailable();
    validators.record.assertRecordReadOwnerInterval(db, original.resources.record);
    validators.name.assertOwnershipNameReadOwner(db, original.resources.name);
    validators.report.assertOwnershipReportReadOwner(db, original.resources.report);
  }
  if (original.terminal)
    validators!.artifacts.assertClinicalArtifactReadTerminal(original.terminal);
}
export function bindOwnershipReadInterval(
  db: DatabaseSync,
  value: OwnershipReadInterval,
  report: OwnershipReportReadOwner,
  name: OwnershipNameReadOwner,
): RecordReadOwner {
  const original = intervals.get(value);
  if (!original || original.db !== db || original.resources || !validators) throw unavailable();
  const record = validators.report.ownershipReportReadRecordOwner(db, report);
  original.resources = { record, report, name };
  assertOwnershipReadInterval(db, value);
  return record;
}
export function sealOwnershipReadInterval(
  db: DatabaseSync,
  value: OwnershipReadInterval,
  terminal: ClinicalArtifactReadTerminal,
): void {
  const original = intervals.get(value);
  if (!original || original.db !== db || !original.resources || original.terminal)
    throw unavailable();
  if (
    !validators!.report.ownershipReportReadTerminalCurrent(db, original.resources.report, terminal)
  )
    throw unavailable();
  validators!.artifacts.assertClinicalArtifactReadTerminal(terminal);
  original.terminal = terminal;
  assertOwnershipReadInterval(db, value);
}
export function ownershipReadIntervalSealed(value: OwnershipReadInterval): boolean {
  return !!intervals.get(value)?.terminal;
}
export function closeOwnershipReadInterval(value: OwnershipReadInterval): void {
  const original = intervals.get(value);
  intervals.delete(value);
  original?.close();
}

/** Original genuine assertion identities, never caller-selected callback approval. */
export async function prepareOwnershipReadOwner(
  db: DatabaseSync,
  profileId: string,
  operation: ClinicalOperation,
  retained: readonly (() => void)[],
) {
  const assertions = Object.freeze([
    ...clinicalOperationCallerAssertions(db, operation),
    ...retained,
  ]);
  const continuations = clinicalOperationReadContinuations(db, operation);
  validators ??= {
    record: await import('./record-versions.ts'),
    name: await import('./ownership-name-plan.ts'),
    report: await import('./ownership-report-plan.ts'),
    artifacts: await import('./clinical-review-artifact-proof.ts'),
  };
  const request = await import('./index.ts'),
    assistant = await import('./assistant.ts'),
    session = await import('./intake-package-session.ts'),
    native = await import('./record-ownership-native.ts'),
    vault = await import('./vault-app.ts');
  const authorization = vault.currentVaultCompactAuthorization(db, profileId);
  const assertCurrent = () => {
    // The exact receipt remains in its ancestor frames after the child returns.
    assertClinicalOperation(db);
    if (authorization && !vault.vaultCompactAuthorizationCurrent(authorization, db, profileId))
      throw unavailable();
    if (
      !continuations.every(
        (work) =>
          native.ownershipReadContinuationCurrent(work, db) ||
          validators!.report.ownershipReportReadContinuationCurrent(work, db),
      )
    )
      throw unavailable();
    const visiting = new Set<() => void>();
    const current = (assertion: () => void): boolean => {
      if (visiting.has(assertion)) return false;
      if (native.ownershipPlanAssertionKnown(assertion, db)) {
        if (!native.ownershipPlanAssertionCurrent(assertion, db))
          throw new HttpError(401, 'PROFILE_LOCKED', 'Unlock this profile to continue');
        return true;
      }
      if (request.requestFilenameAssertionCurrent(assertion, db)) return true;
      const prerequisites =
        assistant.assistantCompactAssertionPrerequisites(assertion, db) ??
        session.packageSessionAssertionPrerequisites(assertion, db);
      if (!prerequisites) return false;
      visiting.add(assertion);
      try {
        return prerequisites.every(current);
      } finally {
        visiting.delete(assertion);
      }
    };
    if (!assertions.every(current)) throw unavailable();
  };
  assertCurrent();
  const owner = Object.freeze({}) as OwnershipReadOwner;
  owners.set(owner, { db, operation, assertCurrent });
  return owner;
}
export function assertOwnershipReadOwner(db: DatabaseSync, value: OwnershipReadOwner): void {
  const original = owners.get(value);
  if (!original || original.db !== db) throw unavailable();
  original.assertCurrent();
}
export function ownershipReadOwnerOperation(
  value: OwnershipReadOwner,
): ClinicalOperation | undefined {
  return owners.get(value)?.operation;
}
