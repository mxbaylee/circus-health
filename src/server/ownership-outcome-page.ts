/** Accepted per-record outcomes remain durable; receipts contain bounded summaries. */
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
import { ownershipDecisionQueries } from './ownership-decision-index.ts';
import { childOwnershipOperation, type OwnershipGroupPlan } from './ownership-groups.ts';
import { clinicalTables } from './clinical-references.ts';
import { canonicalLiteral } from './intake-format.ts';
import type { OwnershipCommit, OwnershipReceipt } from '../shared/record-ownership.ts';
import type {
  OwnershipReceiptReference,
  OwnershipOutcomeEvidenceItem,
} from '../shared/ownership-report-reference.ts';

type StoredReceipt = Omit<OwnershipReceipt, 'outcomes'> & Partial<OwnershipReceiptReference>;
type AcceptedReceipt = { receipt: StoredReceipt; fingerprint: string };
type AcceptedGroup = { plan: OwnershipGroupPlan; accepted?: AcceptedReceipt };
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const outcomesUrl = (profileId: string, operationId: string) =>
  `/api/profiles/${encodeURIComponent(profileId)}/record-ownership/outcomes/${encodeURIComponent(operationId)}`;

function assertOwner(db: Database, profileId: string) {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Ownership correction belongs to another profile');
}
function acceptedReceipt(db: Database, operationId: string): AcceptedReceipt | undefined {
  const row = db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE id=? AND title='Record ownership correction'",
    )
    .get('ownership:' + operationId);
  if (!row) return undefined;
  const saved = json(row.coverage_json);
  if (!object(saved) || !object(saved.receipt) || !digest(saved.fingerprint))
    throw Error('Accepted ownership receipt is malformed');
  const receipt = saved.receipt;
  if (
    receipt.operationId !== operationId ||
    !nonempty(receipt.at) ||
    !nonempty(receipt.destinationPersonId) ||
    !nonempty(receipt.groupId) ||
    !count(receipt.moved) ||
    !count(receipt.unchanged) ||
    !count(receipt.pending) ||
    (receipt.outcomesIncluded !== undefined && receipt.outcomesIncluded !== false)
  )
    throw Error('Accepted ownership receipt is malformed');
  if (
    receipt.outcomesIncluded === false &&
    (!count(receipt.outcomeTotal) ||
      receipt.outcomeTotal !== receipt.moved ||
      !digest(receipt.outcomeDigest))
  )
    throw Error('Accepted report outcome count is unavailable');
  return { receipt: receipt as StoredReceipt, fingerprint: saved.fingerprint };
}

/** Explicit record selection has a 1,000-record bound, including all group metadata. */
function acceptedGroups(db: Database, operationId: string): AcceptedGroup[] {
  const indexed = ownershipDecisionQueries(db);
  const rows = indexed
    ? Array.from(indexed.receiptGroups(operationId))
    : db
        .prepare(
          "SELECT id,coverage_json FROM manual_batches WHERE title='Ownership correction group' AND json_extract(coverage_json,'$.parentOperationId')=? ORDER BY id LIMIT 1001",
        )
        .all(operationId);
  if (rows.length > 1000) throw Error('Accepted ownership group selection exceeds its bound');
  const groups: AcceptedGroup[] = [],
    selected = new Set<string>();
  for (const row of rows) {
    const value = json(row.coverage_json);
    if (
      !object(value) ||
      value.parentOperationId !== operationId ||
      !digest(value.fingerprint) ||
      !digest(value.groupId) ||
      row.id !== `ownership-plan:${operationId}:${value.groupId}` ||
      value.childOperationId !== childOwnershipOperation(operationId, value.groupId) ||
      !nonempty(value.destinationPersonId) ||
      !nonempty(value.at) ||
      !count(value.revision) ||
      value.totalGroups !== rows.length ||
      value.pendingCount !== 0 ||
      !Array.isArray(value.recordIds) ||
      !value.recordIds.length ||
      value.recordIds.length + selected.size > 1000 ||
      value.recordIds.some((id) => !text(id)) ||
      ownershipHash(value.recordIds) !== value.groupId ||
      (groups.length > 0 &&
        (value.fingerprint !== groups[0]!.plan.fingerprint ||
          value.destinationPersonId !== groups[0]!.plan.destinationPersonId))
    )
      throw Error('Accepted ownership group plan is malformed or incomplete');
    const plan = value as unknown as OwnershipGroupPlan;
    let previous: string | undefined;
    for (const id of plan.recordIds) {
      if (selected.has(id) || (previous !== undefined && previous >= id))
        throw Error('Accepted ownership group selection is duplicated or unordered');
      selected.add(id);
      previous = id;
    }
    const accepted = acceptedReceipt(db, plan.childOperationId);
    if (
      accepted &&
      (accepted.receipt.destinationPersonId !== plan.destinationPersonId ||
        accepted.receipt.groupId !== plan.groupId ||
        accepted.receipt.moved + accepted.receipt.unchanged !== plan.recordIds.length ||
        accepted.receipt.pending !== plan.pendingCount)
    )
      throw Error('Accepted ownership child does not match its group plan');
    if (
      !accepted &&
      (indexed
        ? indexed.hasReceiptEvents(plan.childOperationId)
        : db
            .prepare(
              "SELECT 1 FROM manual_batches WHERE title='Record ownership event' AND json_extract(coverage_json,'$.operationId')=? LIMIT 1",
            )
            .get(plan.childOperationId))
    )
      throw Error('Accepted ownership child receipt is missing');
    groups.push({ plan, accepted });
  }
  return groups;
}

function selectedOutcome(value: Record<string, unknown>): OwnershipOutcomeEvidenceItem {
  return {
    recordId: value.recordId as string,
    kind: value.kind as OwnershipOutcomeEvidenceItem['kind'],
    destinationRecordId: value.destinationRecordId as string,
    action: value.action as OwnershipOutcomeEvidenceItem['action'],
    previousOwnerNoteId: value.fromNoteId as string,
    sourceReport: value.sourceReport as OwnershipOutcomeEvidenceItem['sourceReport'],
  };
}
function outcomeRows(db: Database, operationId: string) {
  const indexed = ownershipDecisionQueries(db);
  return indexed
    ? indexed.receiptEvents(operationId)
    : db
        .prepare(
          "SELECT id,coverage_json FROM manual_batches WHERE title='Record ownership event' AND json_extract(coverage_json,'$.operationId')=? ORDER BY id",
        )
        .iterate(operationId);
}

/** Used by the writer before the receipt exists; canonical order is the accepted event ID order. */
export function ownershipOutcomeDigest(db: Database, operationId: string) {
  const hash = createHash('sha256').update('[');
  let comma = false;
  for (const row of outcomeRows(db, operationId)) {
    if (comma) hash.update(',');
    comma = true;
    hash.update(
      canonicalLiteral(selectedOutcome(json(row.coverage_json) as Record<string, unknown>)),
    );
  }
  return hash.update(']').digest('hex');
}

/** Stream all evidence, even when the caller only displays an earlier page. */
function visitOutcomes(
  db: Database,
  receipt: StoredReceipt,
  visit: (id: string, value: OwnershipOutcomeEvidenceItem) => void,
  plan?: OwnershipGroupPlan,
) {
  const hash = createHash('sha256').update('[');
  let total = 0;
  for (const row of outcomeRows(db, receipt.operationId)) {
    const value = json(row.coverage_json);
    if (
      !object(value) ||
      value.operationId !== receipt.operationId ||
      !nonempty(value.recordId) ||
      row.id !== `ownership-event:${receipt.operationId}:${value.recordId}` ||
      !nonempty(value.destinationRecordId) ||
      !nonempty(value.fromNoteId) ||
      value.toPersonId !== receipt.destinationPersonId ||
      typeof value.kind !== 'string' ||
      !Object.hasOwn(clinicalTables, value.kind) ||
      !['move', 'split', 'link'].includes(String(value.action)) ||
      (plan && !plan.recordIds.includes(value.recordId)) ||
      (value.sourceReport !== undefined &&
        (!object(value.sourceReport) ||
          !nonempty(value.sourceReport.intakeId) ||
          !nonempty(value.sourceReport.groupId) ||
          !nonempty(value.sourceReport.groupVersionId)))
    )
      throw Error('Accepted report outcome evidence is malformed');
    if (total) hash.update(',');
    total++;
    const outcome = selectedOutcome(value);
    hash.update(canonicalLiteral(outcome));
    visit(String(row.id), outcome);
  }
  if (total !== receipt.moved) throw Error('Accepted report outcome evidence is incomplete');
  const completeDigest = hash.update(']').digest('hex');
  if (receipt.outcomesIncluded === false && completeDigest !== receipt.outcomeDigest)
    throw Error('Accepted report outcome evidence does not match its complete digest');
  return { total, digest: completeDigest };
}
function parentReceipt(
  db: Database,
  profileId: string,
  groups: AcceptedGroup[],
  visit: (
    plan: OwnershipGroupPlan,
    id: string,
    value: OwnershipOutcomeEvidenceItem,
  ) => void = () => {},
): OwnershipReceiptReference {
  const first = groups[0]!.plan,
    hash = createHash('sha256').update('[');
  let moved = 0,
    unchanged = 0,
    pending = 0,
    total = 0;
  for (const { plan, accepted } of groups) {
    if (!accepted) continue;
    moved += accepted.receipt.moved;
    unchanged += accepted.receipt.unchanged;
    pending += accepted.receipt.pending;
    visitOutcomes(
      db,
      accepted.receipt,
      (id, value) => {
        if (total) hash.update(',');
        total++;
        hash.update(canonicalLiteral(value));
        visit(plan, id, value);
      },
      plan,
    );
  }
  if (moved !== total) throw Error('Accepted parent outcome evidence is incomplete');
  return {
    operationId: first.parentOperationId,
    at: first.at,
    destinationPersonId: first.destinationPersonId,
    moved,
    unchanged,
    pending,
    replayed: true,
    groupId: first.parentOperationId,
    groups: groups.map(({ plan, accepted }) => ({
      id: plan.groupId,
      recordIds: plan.recordIds,
      status: accepted ? 'committed' : 'needs_review',
      operationId: plan.childOperationId,
      moved: accepted?.receipt.moved ?? 0,
      pending: accepted?.receipt.pending ?? 0,
    })),
    outcomesIncluded: false,
    outcomeTotal: total,
    outcomeDigest: hash.update(']').digest('hex'),
    outcomesUrl: outcomesUrl(profileId, first.parentOperationId),
  };
}
function hasNativeChild(groups: AcceptedGroup[]) {
  return groups.some(({ accepted }) => accepted?.receipt.outcomesIncluded === false);
}
export function ownershipReceiptReference(
  db: Database,
  profileId: string,
  operationId: string,
): OwnershipReceiptReference | undefined {
  assertOwner(db, profileId);
  const accepted = acceptedReceipt(db, operationId);
  if (accepted)
    return accepted.receipt.outcomesIncluded === false
      ? {
          ...(accepted.receipt as OwnershipReceiptReference),
          outcomesUrl: outcomesUrl(profileId, operationId),
          replayed: true,
        }
      : undefined;
  const groups = acceptedGroups(db, operationId);
  return hasNativeChild(groups) ? parentReceipt(db, profileId, groups) : undefined;
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
  const accepted = acceptedReceipt(db, command.operationId),
    fingerprint =
      accepted?.fingerprint ?? acceptedGroups(db, command.operationId)[0]?.plan.fingerprint;
  if (fingerprint !== ownershipHash({ ...command, request: ownershipRequest(command.request) }))
    throw new HttpError(
      409,
      'OPERATION_CONFLICT',
      'This operation ID belongs to another correction',
    );
  return receipt;
}

type ParentCursor = [operationId: string, state: string, groupId: string, eventId: string];
function readParentCursor(after: string, operationId: string): ParentCursor | undefined {
  if (!after) return undefined;
  if (after.length > 4096 || !/^parent-v1\.[A-Za-z0-9_-]+$/.test(after))
    throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid parent outcome cursor');
  try {
    const encoded = after.slice('parent-v1.'.length),
      decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) throw Error();
    const value = JSON.parse(decoded.toString('utf8'));
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value[0] !== operationId ||
      !digest(value[1]) ||
      !digest(value[2]) ||
      !nonempty(value[3])
    )
      throw Error();
    return value as ParentCursor;
  } catch {
    throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid parent outcome cursor');
  }
}
export function ownershipOutcomePage(
  db: Database,
  profileId: string,
  operationId: string,
  after = '',
  limit = 32,
) {
  try {
    assertOwner(db, profileId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 || typeof after !== 'string')
      throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid report outcome cursor');
    const accepted = acceptedReceipt(db, operationId),
      groups = accepted ? [] : acceptedGroups(db, operationId);
    if (accepted?.receipt.outcomesIncluded !== false && !hasNativeChild(groups))
      throw new HttpError(404, 'OWNERSHIP_NOT_FOUND', 'No accepted report correction reference');
    const items: OwnershipOutcomeEvidenceItem[] = [];
    let more = false,
      last: string | null = null;
    if (accepted) {
      const result = visitOutcomes(db, accepted.receipt, (id, value) => {
        if (id <= after) return;
        if (items.length === limit) {
          more = true;
          return;
        }
        items.push(value);
        last = id;
      });
      return { items, ...result, complete: !more, after: more ? last : null };
    }
    const cursor = readParentCursor(after, operationId);
    let found = !cursor,
      lastGroup: string | undefined;
    const receipt = parentReceipt(db, profileId, groups, (plan, id, value) => {
        if (!found) {
          if (plan.groupId === cursor![2] && id === cursor![3]) found = true;
          return;
        }
        if (items.length === limit) {
          more = true;
          return;
        }
        items.push(value);
        last = id;
        lastGroup = plan.groupId;
      }),
      state = ownershipHash(receipt);
    if (!found || (cursor && cursor[1] !== state))
      throw new HttpError(
        409,
        'OWNERSHIP_CURSOR',
        'The accepted parent outcomes changed or the cursor is unavailable',
      );
    return {
      items,
      total: receipt.outcomeTotal,
      digest: receipt.outcomeDigest,
      complete: !more,
      after: more
        ? 'parent-v1.' +
          Buffer.from(JSON.stringify([operationId, state, lastGroup!, last!])).toString('base64url')
        : null,
    };
  } catch (error) {
    if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
    throw error;
  }
}
