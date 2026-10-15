import { randomUUID } from 'node:crypto';
import { observeDatabaseClose } from './database.ts';
import type { DatabaseSync } from 'node:sqlite';
import { intakeCollectionCacheGeneration } from './intake-state-collections.ts';
import { identityGroundingGeneration } from './intake-identity-grounding.ts';
import type { CollectionClinicalReviewSession } from './intake-review-collection-session.ts';
const reviewReadStates = new WeakMap<
  DatabaseSync,
  {
    registry: object;
    grounding: object;
    epoch: string;
    read: ReturnType<DatabaseSync['prepare']>;
    readTempSchema: ReturnType<DatabaseSync['prepare']>;
  }
>();
export function reviewReadStamp(db: DatabaseSync): string | undefined {
  if (!db.isOpen || db.isTransaction) return undefined;
  const registry = intakeCollectionCacheGeneration(db),
    grounding = identityGroundingGeneration(db);
  let state = reviewReadStates.get(db);
  if (!state || state.registry !== registry || state.grounding !== grounding) {
    const read =
      state?.read ||
      db.prepare(
        'SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS external,(SELECT schema_version FROM pragma_schema_version) AS schema',
      );
    read.setReadBigInts(true);
    state = {
      registry,
      grounding,
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

/** Late session callbacks reach only the request that currently leases the
 * retained review; with no lease they are inert, and grounding dependencies
 * stay recorded so every later borrower replays the complete set. */
export interface PreparedClinicalReviewRoute {
  leased: boolean;
  discarded: boolean;
  dependencies: Set<string>;
  borrower?: { assertRunning?: () => void; groundingDependency?: (intakeId: string) => void };
}
export interface PreparedClinicalReviewRead {
  key: string;
  stamp: string;
  sourcePin: string;
  requestRevision: number;
  session: CollectionClinicalReviewSession;
  route?: PreparedClinicalReviewRoute;
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
function closePreparedClinicalReviewRead(value: PreparedClinicalReviewRead) {
  // A leased review closes when its request releases it, never under that request.
  if (value.route?.leased) value.route.discarded = true;
  else value.session.close();
}
export function discardPreparedClinicalReviewRead(db: DatabaseSync) {
  const prior = preparedReads.get(db);
  preparedReads.delete(db);
  if (prior) closePreparedClinicalReviewRead(prior);
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
/** One request at a time may lease the retained review; release is idempotent. */
export function leasePreparedClinicalReviewRead(
  value: PreparedClinicalReviewRead,
  borrower: NonNullable<PreparedClinicalReviewRoute['borrower']>,
): (() => void) | undefined {
  const route = value.route;
  if (!route || route.leased || route.discarded) return undefined;
  route.leased = true;
  route.borrower = borrower;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    route.leased = false;
    route.borrower = undefined;
    if (route.discarded) value.session.close();
  };
}
