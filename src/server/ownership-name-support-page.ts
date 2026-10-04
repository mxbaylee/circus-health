import { createHash } from 'node:crypto';
import {
  HttpError,
  json,
  type Database,
  currentTransactionToken,
  rejectCurrentTransaction,
} from './database.ts';
import type {
  OwnershipNameEvidencePage,
  OwnershipNameSupportReference,
} from '../shared/ownership-name-reference.ts';
export interface PublishedOwnershipNameSupport {
  operationId: string;
  correctionOperationId: string;
  effectKey: string;
  supportOrdinal: number;
  noteId: string;
  name: string;
  sourceRecordId: string;
  intakeId: string;
  groupId: string;
}
/** Accepted ledger rows survive temporary plan eviction, cache rebuild and export. */
export function publishedOwnershipNameSupportPage(
  db: Database,
  profileId: string,
  operationId: string,
  effectKey: string,
  after = -1,
  limit = 32,
): OwnershipNameEvidencePage<PublishedOwnershipNameSupport> {
  try {
    return readPublishedOwnershipNameSupportPage(
      db,
      profileId,
      operationId,
      effectKey,
      after,
      limit,
    );
  } catch (error) {
    if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
    throw error;
  }
}
function readPublishedOwnershipNameSupportPage(
  db: Database,
  profileId: string,
  operationId: string,
  effectKey: string,
  after: number,
  limit: number,
): OwnershipNameEvidencePage<PublishedOwnershipNameSupport> {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Ownership evidence belongs to another profile');
  if (
    !Number.isSafeInteger(after) ||
    after < -1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 32
  )
    throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Select an exact ownership evidence page');
  const row = db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE id=? AND title='Remembered name correction'",
    )
    .get('name-correction:' + operationId + ':destination:' + effectKey);
  const authority = row
    ? (json(row.coverage_json) as {
        supportOperationsIncluded?: boolean;
        supportOperationsReference?: OwnershipNameSupportReference;
      })
    : undefined;
  const reference = authority?.supportOperationsReference;
  if (
    authority?.supportOperationsIncluded !== false ||
    !reference ||
    reference.operationId !== operationId ||
    reference.effectKey !== effectKey ||
    reference.complete !== true ||
    !Number.isSafeInteger(reference.total) ||
    reference.total < 0
  )
    throw new HttpError(409, 'OWNERSHIP_EVIDENCE', 'Complete accepted name support is unavailable');
  const digest = createHash('sha256');
  digest.update('[');
  let count = 0;
  const items: PublishedOwnershipNameSupport[] = [];
  for (const row of db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Ownership name support' AND json_extract(coverage_json,'$.correctionOperationId')=? AND json_extract(coverage_json,'$.effectKey')=? ORDER BY json_extract(coverage_json,'$.supportOrdinal')",
    )
    .iterate(operationId, effectKey)) {
    const support = json(row.coverage_json) as PublishedOwnershipNameSupport;
    if (
      support.supportOrdinal !== count ||
      support.effectKey !== effectKey ||
      support.correctionOperationId !== operationId ||
      typeof support.operationId !== 'string'
    )
      throw new HttpError(409, 'OWNERSHIP_EVIDENCE', 'Accepted name support order is incomplete');
    if (count++) digest.update(',');
    digest.update(JSON.stringify(support.operationId));
    if (support.supportOrdinal > after && items.length < limit) items.push(support);
  }
  digest.update(']');
  if (count !== reference.total || digest.digest('hex') !== reference.digest)
    throw new HttpError(409, 'OWNERSHIP_EVIDENCE', 'Accepted name support is incomplete');
  const last = items.at(-1)?.supportOrdinal;
  const complete = last === undefined || last + 1 === count;
  return { items, total: count, complete, after: complete ? null : String(last) };
}
