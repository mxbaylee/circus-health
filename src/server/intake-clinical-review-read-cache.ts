import { randomUUID } from 'node:crypto';
import { observeDatabaseClose } from './database.ts';
import type { DatabaseSync } from 'node:sqlite';
import { intakeCollectionCacheGeneration } from './intake-state-collections.ts';
import type { CollectionClinicalReviewSession } from './intake-review-collection-session.ts';
const reviewReadStates = new WeakMap<
  DatabaseSync,
  {
    registry: object;
    epoch: string;
    read: ReturnType<DatabaseSync['prepare']>;
    readTempSchema: ReturnType<DatabaseSync['prepare']>;
  }
>();
export function reviewReadStamp(db: DatabaseSync): string | undefined {
  if (!db.isOpen || db.isTransaction) return undefined;
  const registry = intakeCollectionCacheGeneration(db);
  let state = reviewReadStates.get(db);
  if (!state || state.registry !== registry) {
    const read =
      state?.read ||
      db.prepare(
        'SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS external,(SELECT schema_version FROM pragma_schema_version) AS schema',
      );
    read.setReadBigInts(true);
    state = {
      registry,
      epoch: randomUUID(),
      read,
      readTempSchema: state?.readTempSchema || db.prepare('PRAGMA temp.schema_version'),
    };
    if (!reviewReadStates.has(db)) observeDatabaseClose(db, () => reviewReadStates.delete(db));
    reviewReadStates.set(db, state);
  }
  const row = state.read.get()!;
  return `${state.epoch}:${row.changes}:${row.external}:${row.schema}:${state.readTempSchema.get()!.schema_version}`;
}

export interface PreparedClinicalReviewRead {
  key: string;
  stamp: string;
  sourcePin: string;
  requestRevision: number;
  session: CollectionClinicalReviewSession;
}
// Exactly one retained proposal review and one active request token per connection.
const preparedReads = new WeakMap<DatabaseSync, PreparedClinicalReviewRead>();
const attempts = new WeakMap<DatabaseSync, object>();
export function beginPreparedClinicalReviewRead(db: DatabaseSync) {
  const token = {};
  attempts.set(db, token);
  return token;
}
export function isPreparedClinicalReviewReadCurrent(db: DatabaseSync, token: object) {
  return attempts.get(db) === token;
}
export function preparedClinicalReviewRead(db: DatabaseSync) {
  return preparedReads.get(db);
}
export function discardPreparedClinicalReviewRead(db: DatabaseSync) {
  const prior = preparedReads.get(db);
  preparedReads.delete(db);
  prior?.session.close();
}
export function clearPreparedClinicalReviewRead(db: DatabaseSync) {
  attempts.delete(db);
  discardPreparedClinicalReviewRead(db);
}
export function retainPreparedClinicalReviewRead(
  db: DatabaseSync,
  value: PreparedClinicalReviewRead,
) {
  if (preparedReads.get(db) === value) return;
  discardPreparedClinicalReviewRead(db);
  preparedReads.set(db, value);
}
