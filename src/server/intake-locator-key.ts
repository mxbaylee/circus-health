import { constants, type DatabaseSync } from 'node:sqlite';
import {
  HttpError,
  managedDatabaseMethodEpoch,
  observeManagedDatabaseAuthorization,
} from './database.ts';
import { currentClinicalOperation, assertClinicalOperation } from './clinical-operation.ts';
import { reviewReadStamp } from './intake-clinical-review-read-cache.ts';
import {
  captureManagedPhysicalEpoch,
  managedPhysicalEpochCurrent,
} from './clinical-review-physical-epoch.ts';
import { schemaStringKey } from './intake-envelope-schema.ts';

/** Hash an already selected locator; this does not replace original-byte verification. */
export async function intakeLocatorKey(
  db: DatabaseSync,
  value: string,
  assertCurrent: () => void,
): Promise<string> {
  const changed = (): never => {
    throw new HttpError(409, 'SOURCE_CHANGED', 'The locator authority changed during preparation');
  };
  if (db.isTransaction) changed();
  let attempted = false,
    active = true;
  // One refresh observes even statements prepared before entry; no rearming per chunk.
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, _name, detail) => {
      if (
        action !== constants.SQLITE_READ &&
        action !== constants.SQLITE_SELECT &&
        action !== constants.SQLITE_FUNCTION &&
        action !== constants.SQLITE_RECURSIVE &&
        !(action === constants.SQLITE_PRAGMA && detail === null)
      )
        attempted = true;
    },
    () => {
      attempted = true;
    },
  );
  if (!stop) changed();
  try {
    const methods = managedDatabaseMethodEpoch(db),
      prepare = db.prepare,
      exec = db.exec,
      physical = captureManagedPhysicalEpoch();
    assertCurrent();
    const stamp = reviewReadStamp(db),
      operation = currentClinicalOperation(db);
    if (!methods || !physical || stamp === undefined) changed();
    const check = () => {
      if (operation) assertClinicalOperation(db, operation);
      const stable = () =>
        active &&
        !attempted &&
        db.prepare === prepare &&
        db.exec === exec &&
        managedDatabaseMethodEpoch(db) === methods &&
        managedPhysicalEpochCurrent(physical!);
      if (!stable() || reviewReadStamp(db) !== stamp || !stable()) changed();
    };
    assertCurrent();
    check();
    const hash = await schemaStringKey(value, check);
    assertCurrent();
    check();
    return hash;
  } finally {
    active = false;
    stop!();
  }
}
