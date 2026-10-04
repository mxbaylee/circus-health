/** Accepted per-record outcomes remain durable; report receipts contain only totals. */
import { createHash } from 'node:crypto';
import {
  HttpError,
  json,
  currentTransactionToken,
  rejectCurrentTransaction,
  type Database,
} from './database.ts';
import { ownershipRequest, object, text, invalid } from './record-ownership-input.ts';
import { ownershipHash } from './ownership-journal.ts';
import { canonicalLiteral } from './intake-format.ts';
import type { OwnershipCommit, OwnershipReceipt } from '../shared/record-ownership.ts';
import type {
  OwnershipReceiptReference,
  OwnershipOutcomeEvidenceItem,
} from '../shared/ownership-report-reference.ts';
export function ownershipOutcomeDigest(db: Database, operationId: string) {
  const hash = createHash('sha256');
  hash.update('[');
  let comma = false;
  for (const row of db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Record ownership event' AND json_extract(coverage_json,'$.operationId')=? ORDER BY id",
    )
    .iterate(operationId)) {
    const value = json(row.coverage_json) as OwnershipReceipt['outcomes'][number] & {
      fromNoteId: string;
      sourceReport?: OwnershipOutcomeEvidenceItem['sourceReport'];
    };
    if (comma) hash.update(',');
    comma = true;
    hash.update(
      canonicalLiteral({
        recordId: value.recordId,
        kind: value.kind,
        destinationRecordId: value.destinationRecordId,
        action: value.action,
        previousOwnerNoteId: value.fromNoteId,
        sourceReport: value.sourceReport,
      }),
    );
  }
  hash.update(']');
  return hash.digest('hex');
}
export function ownershipReceiptReference(
  db: Database,
  profileId: string,
  operationId: string,
): OwnershipReceiptReference | undefined {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Ownership correction belongs to another profile');
  const row = db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE id=? AND title='Record ownership correction'",
    )
    .get('ownership:' + operationId);
  if (!row) return undefined;
  const receipt = (json(row.coverage_json) as { receipt: OwnershipReceiptReference }).receipt;
  if (receipt.outcomesIncluded !== false) return undefined;
  if (
    !Number.isSafeInteger(receipt.outcomeTotal) ||
    receipt.outcomeTotal < 0 ||
    receipt.outcomeTotal !== receipt.moved ||
    typeof receipt.outcomeDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(receipt.outcomeDigest) ||
    receipt.operationId !== operationId
  )
    throw Error('Accepted report outcome count is unavailable');
  return { ...receipt, replayed: true };
}
export function replayOwnershipReceiptReference(db: Database, profileId: string, input: unknown) {
  if (
    !object(input) ||
    Object.keys(input).some(
      (k) => !['operationId', 'request', 'scopeToken', 'version'].includes(k),
    ) ||
    typeof input.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.operationId,
    ) ||
    !Number.isSafeInteger(input.version) ||
    !text(input.scopeToken)
  )
    return invalid('Commit the displayed preview with a stable operation ID');
  const command = input as unknown as OwnershipCommit,
    receipt = ownershipReceiptReference(db, profileId, command.operationId);
  if (!receipt) return undefined;
  const row = db
    .prepare('SELECT coverage_json FROM manual_batches WHERE id=?')
    .get('ownership:' + command.operationId)!;
  if (
    (json(row.coverage_json) as { fingerprint: string }).fingerprint !==
    ownershipHash({ ...command, request: ownershipRequest(command.request) })
  )
    throw new HttpError(
      409,
      'OPERATION_CONFLICT',
      'This operation ID belongs to another correction',
    );
  return receipt;
}
export function ownershipOutcomePage(
  db: Database,
  profileId: string,
  operationId: string,
  after = '',
  limit = 32,
) {
  try {
    const receipt = ownershipReceiptReference(db, profileId, operationId);
    if (!receipt)
      throw new HttpError(404, 'OWNERSHIP_NOT_FOUND', 'No accepted report correction reference');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 || typeof after !== 'string')
      throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid report outcome cursor');
    const items: OwnershipOutcomeEvidenceItem[] = [];
    let total = 0,
      more = false,
      last: string | null = null;
    const hash = createHash('sha256');
    hash.update('[');
    // Validate every selected outcome, including rows beyond the requested page.
    for (const row of db
      .prepare(
        "SELECT id,coverage_json FROM manual_batches WHERE title='Record ownership event' AND json_extract(coverage_json,'$.operationId')=? ORDER BY id",
      )
      .iterate(operationId)) {
      const outcome = json(row.coverage_json) as OwnershipReceipt['outcomes'][number] & {
        operationId: string;
        fromNoteId: string;
        sourceReport?: OwnershipOutcomeEvidenceItem['sourceReport'];
      };
      if (
        outcome.operationId !== operationId ||
        typeof outcome.recordId !== 'string' ||
        typeof outcome.destinationRecordId !== 'string' ||
        typeof outcome.fromNoteId !== 'string' ||
        !['move', 'split', 'link'].includes(outcome.action)
      )
        throw Error('Accepted report outcome evidence is malformed');
      if (total) hash.update(',');
      total++;
      const selectedOutcome = {
        recordId: outcome.recordId,
        kind: outcome.kind,
        destinationRecordId: outcome.destinationRecordId,
        action: outcome.action,
        previousOwnerNoteId: outcome.fromNoteId,
        sourceReport: outcome.sourceReport,
      };
      hash.update(canonicalLiteral(selectedOutcome));
      if (String(row.id) <= after) continue;
      if (items.length === limit) {
        more = true;
        continue;
      }
      items.push(selectedOutcome);
      last = String(row.id);
    }
    if (total !== receipt.outcomeTotal)
      throw Error('Accepted report outcome evidence is incomplete');
    hash.update(']');
    const digest = hash.digest('hex');
    if (digest !== receipt.outcomeDigest)
      throw Error('Accepted report outcome evidence does not match its complete digest');
    return { items, total, digest, complete: !more, after: more ? last : null };
  } catch (error) {
    if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
    throw error;
  }
}
