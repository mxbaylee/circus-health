import { createHash } from 'node:crypto';
import { HttpError, now, revision, transaction, type Database } from './database.ts';
import { canonicalLiteral } from './intake-format.ts';
import {
  duplicateRecord,
  intakePairReference,
  verifyDuplicateOriginals,
  type DuplicateRecord,
} from './duplicate-review.ts';
import {
  clinicalNavigation,
  resolveClinicalReference,
  clinicalTables,
} from './clinical-references.ts';
import { exportCuration, personalDurabilityStatus } from './portable.ts';
import type {
  ClinicalRelationshipApplyInput,
  ClinicalRelationshipApplyResult,
  ClinicalRelationshipEvidence,
  ClinicalRelationshipPreview,
  ClinicalRelationshipProjection,
  ClinicalRelationshipReceipt,
  ClinicalRelationshipRecord,
  ClinicalRelationshipRequest,
  ClinicalRelationshipScope,
  ClinicalRelationshipSide,
  ClinicalRelationshipStatus,
  ClinicalRelationshipView,
} from '../shared/clinical-relationships.ts';

interface Decision {
  id: string;
  key: string;
  previousDecisionId: string | null;
  at: string;
  sequence: number;
  request: ClinicalRelationshipRequest;
  scope: ClinicalRelationshipScope;
  reviewed: ClinicalRelationshipView['reviewed'];
}
interface Stored {
  clinicalRelationship: Decision;
  requestFingerprint: string;
  receipt: ClinicalRelationshipReceipt;
}
const title = 'Clinical relationship review';
const maximumPairs = 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= limit;
function owner(db: Database, profileId: string): void {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Relationship belongs to another profile');
  const durable = personalDurabilityStatus(db);
  if (durable.conflicted || (durable.dirty && durable.lastError))
    throw new HttpError(
      409,
      'RELATIONSHIP_RECOVERY_REQUIRED',
      'Reopen this profile to recover accepted relationship history before continuing',
    );
}
const selector = (value: unknown): value is ClinicalRelationshipRecord =>
  object(value) &&
  ['observation', 'medication', 'procedure', 'document'].includes(String(value.kind)) &&
  text(value.recordId, 500) &&
  Object.keys(value).every((key) => ['kind', 'recordId'].includes(key));
function request(value: unknown): ClinicalRelationshipRequest {
  if (
    !object(value) ||
    !selector(value.left) ||
    !selector(value.right) ||
    value.left.recordId === value.right.recordId ||
    !text(value.reason, 4000)
  )
    throw new HttpError(
      400,
      'RELATIONSHIP_INPUT',
      'Choose two different accepted records and explain the reviewed relationship',
    );
  const amendment = value.action === 'provider_amendment';
  const allowed = [
    'left',
    'right',
    'reason',
    'action',
    'mode',
    'attestation',
    ...(amendment ? ['direction', 'evidence'] : []),
  ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    (amendment
      ? !['confirm', 'withdraw'].includes(String(value.mode)) ||
        !['left_to_right', 'right_to_left'].includes(String(value.direction))
      : value.action !== 'display_preference' ||
        !['prefer_left', 'prefer_right', 'show_both', 'undecided', 'withdraw'].includes(
          String(value.mode),
        ))
  )
    throw new HttpError(
      400,
      'RELATIONSHIP_INPUT',
      'Choose an explicit amendment or display review action',
    );
  if (
    value.attestation !== undefined &&
    value.attestation !== (amendment ? 'reviewed_provider_amendment' : 'same_recorded_event')
  )
    throw new HttpError(400, 'RELATIONSHIP_INPUT', 'Relationship attestation is not supported');
  if (amendment && (value.mode === 'confirm' || value.evidence !== undefined)) {
    if (
      value.attestation !== 'reviewed_provider_amendment' ||
      !object(value.evidence) ||
      !text(value.evidence.sourceFileId, 500) ||
      !text(value.evidence.locator, 2000) ||
      !text(value.evidence.quote, 4000) ||
      Object.keys(value.evidence).some((key) => !['sourceFileId', 'locator', 'quote'].includes(key))
    )
      throw new HttpError(
        400,
        'AMENDMENT_EVIDENCE',
        'Explicitly review the provider amendment in its retained original and supply its location and quote',
      );
  }
  if (
    !amendment &&
    ['prefer_left', 'prefer_right', 'show_both'].includes(String(value.mode)) &&
    value.attestation !== 'same_recorded_event'
  )
    throw new HttpError(
      400,
      'DISPLAY_ATTESTATION',
      'Explicitly confirm that the two assertions describe the same recorded event',
    );
  return structuredClone(value) as unknown as ClinicalRelationshipRequest;
}
const key = (value: ClinicalRelationshipRequest): string =>
  'relationship:' + hash([value.action, [value.left.recordId, value.right.recordId].sort()]);
const direction = (
  value: ClinicalRelationshipRequest,
): { fromRecordId: string; toRecordId: string } | null =>
  value.action === 'provider_amendment'
    ? {
        fromRecordId:
          value.direction === 'left_to_right' ? value.left.recordId : value.right.recordId,
        toRecordId:
          value.direction === 'left_to_right' ? value.right.recordId : value.left.recordId,
      }
    : null;
const grouped = (value: ClinicalRelationshipRequest): boolean =>
  value.action === 'display_preference' &&
  ['prefer_left', 'prefer_right', 'show_both'].includes(value.mode);
function heads(db: Database): { decisions: Decision[]; truncated: boolean } {
  const rows = db
    .prepare(
      `WITH ranked AS (
    SELECT coverage_json, ROW_NUMBER() OVER (PARTITION BY json_extract(coverage_json,'$.clinicalRelationship.key')
      ORDER BY json_extract(coverage_json,'$.clinicalRelationship.sequence') DESC,id DESC) rank
    FROM manual_batches WHERE title=?
  ) SELECT coverage_json FROM ranked WHERE rank=1 ORDER BY json_extract(coverage_json,'$.clinicalRelationship.key') LIMIT ?`,
    )
    .all(title, maximumPairs + 1);
  return {
    decisions: rows
      .slice(0, maximumPairs)
      .map((row) => (JSON.parse(String(row.coverage_json)) as Stored).clinicalRelationship),
    truncated: rows.length > maximumPairs,
  };
}
function current(db: Database, selected: ClinicalRelationshipRecord): DuplicateRecord {
  const resolved = resolveClinicalReference(db, selected.kind, selected.recordId);
  if (!resolved)
    throw new HttpError(
      404,
      'RECORD_NOT_FOUND',
      'Relationship record no longer exists in this profile',
    );
  return duplicateRecord(db, resolved.kind, resolved.recordId);
}
const reference = (db: Database, record: DuplicateRecord) => ({
  ...intakePairReference(db, record),
  recordId: record.id,
});
function status(db: Database, decision: Decision): ClinicalRelationshipStatus {
  if (decision.request.mode === 'withdraw') return 'withdrawn';
  if (decision.request.mode === 'undecided') return 'undecided';
  try {
    if (
      canonicalLiteral(reference(db, current(db, decision.request.left))) !==
        canonicalLiteral(decision.scope.left) ||
      canonicalLiteral(reference(db, current(db, decision.request.right))) !==
        canonicalLiteral(decision.scope.right)
    )
      return 'stale';
    return 'current';
  } catch {
    return 'stale';
  }
}
function graph(db: Database) {
  const ledger = heads(db),
    statuses = new Map(ledger.decisions.map((decision) => [decision.id, status(db, decision)]));
  const displays = ledger.decisions.filter(
    (decision) => grouped(decision.request) && statuses.get(decision.id) === 'current',
  );
  const counts = new Map<string, number>();
  for (const decision of displays)
    for (const id of [decision.request.left.recordId, decision.request.right.recordId])
      counts.set(id, (counts.get(id) || 0) + 1);
  for (const decision of displays)
    if (
      [decision.request.left.recordId, decision.request.right.recordId].some(
        (id) => counts.get(id)! > 1,
      )
    )
      statuses.set(decision.id, 'conflict');
  const amendments = ledger.decisions.filter(
    (decision) =>
      decision.request.action === 'provider_amendment' &&
      decision.request.mode === 'confirm' &&
      statuses.get(decision.id) === 'current',
  );
  for (const decision of amendments) {
    const edge = direction(decision.request)!;
    if (
      reaches(
        amendments.filter((other) => other.id !== decision.id),
        edge.toRecordId,
        edge.fromRecordId,
      )
    )
      statuses.set(decision.id, 'conflict');
  }
  return { ...ledger, statuses };
}
function reaches(decisions: Decision[], from: string, target: string): boolean {
  const next = new Map<string, string[]>();
  for (const decision of decisions) {
    const edge = direction(decision.request);
    if (edge)
      next.set(edge.fromRecordId, [...(next.get(edge.fromRecordId) || []), edge.toRecordId]);
  }
  const pending = [from],
    seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(next.get(id) || []));
  }
  return false;
}
function constraints(
  selected: ClinicalRelationshipRequest,
  state: ReturnType<typeof graph>,
  prior: Decision | undefined,
): void {
  if (state.truncated)
    throw new HttpError(
      409,
      'RELATIONSHIP_LIMIT',
      'The relationship review exceeds the bounded graph; no preference was applied',
    );
  if (selected.mode === 'withdraw' && (!prior || prior.request.mode === 'withdraw'))
    throw new HttpError(
      409,
      'RELATIONSHIP_REVIEW_CHANGED',
      'There is no current decision to withdraw for this pair',
    );
  const others = state.decisions.filter((decision) => decision.key !== key(selected));
  if (
    grouped(selected) &&
    others.some(
      (decision) =>
        grouped(decision.request) &&
        [decision.request.left.recordId, decision.request.right.recordId].some(
          (id) => id === selected.left.recordId || id === selected.right.recordId,
        ),
    )
  )
    throw new HttpError(
      409,
      'DISPLAY_RELATIONSHIP_CONFLICT',
      'Withdraw the overlapping display pair before grouping these two records; relationships are not inferred transitively',
    );
  if (selected.action === 'provider_amendment') {
    const edge = direction(selected)!;
    if (
      prior &&
      prior.request.mode !== 'withdraw' &&
      canonicalLiteral(direction(prior.request)) !== canonicalLiteral(edge)
    )
      throw new HttpError(
        409,
        'AMENDMENT_DIRECTION_CONFLICT',
        'Withdraw the earlier amendment before changing its direction',
      );
    if (
      selected.mode === 'confirm' &&
      reaches(
        others.filter(
          (decision) =>
            decision.request.action === 'provider_amendment' &&
            decision.request.mode === 'confirm' &&
            state.statuses.get(decision.id) === 'current',
        ),
        edge.toRecordId,
        edge.fromRecordId,
      )
    )
      throw new HttpError(
        409,
        'AMENDMENT_CYCLE',
        'This direction would create a cycle in the reviewed provider amendments',
      );
  }
}
function evidence(record: DuplicateRecord, claim: ClinicalRelationshipEvidence): void {
  if (
    !record.evidence.some(
      (item) =>
        /^\/api\/sources\/([^/?#]+)\/content(?:[?#]|$)/.exec(item.contentUrl)?.[1] ===
        encodeURIComponent(claim.sourceFileId),
    )
  )
    throw new HttpError(
      409,
      'AMENDMENT_EVIDENCE',
      'The amendment quote must refer to an original retained for the amended assertion',
    );
}
function side(db: Database, record: DuplicateRecord): ClinicalRelationshipSide {
  return {
    record: { kind: record.kind, recordId: record.id },
    title: record.title,
    date: record.date,
    mapping: record.mapping as Record<string, unknown>,
    evidence: record.evidence.map(({ sourceRecordId, label, locator, contentUrl }) => {
      const sourceFileId = decodeURIComponent(
        /^\/api\/sources\/([^/?#]+)\/content(?:[?#]|$)/.exec(contentUrl)![1]!,
      );
      const original = db
        .prepare('SELECT sha256,bytes FROM source_files WHERE id=?')
        .get(sourceFileId)!;
      return {
        sourceRecordId,
        label,
        locator,
        contentUrl,
        sourceFileId,
        sha256: String(original.sha256),
        bytes: Number(original.bytes),
      };
    }),
    navigation: clinicalNavigation(record.kind, record.id)!,
  };
}
/** Current read-only sides for initial or renewed human review; historical snapshots stay separate. */
export function readClinicalRelationshipPair(
  db: Database,
  root: string,
  profileId: string,
  leftSelector: ClinicalRelationshipRecord,
  rightSelector: ClinicalRelationshipRecord,
): { left: ClinicalRelationshipSide; right: ClinicalRelationshipSide } {
  owner(db, profileId);
  if (
    !selector(leftSelector) ||
    !selector(rightSelector) ||
    leftSelector.recordId === rightSelector.recordId
  )
    throw new HttpError(400, 'RELATIONSHIP_INPUT', 'Choose two distinct accepted records');
  const left = current(db, leftSelector),
    right = current(db, rightSelector);
  const verified = new Set<string>();
  verifyDuplicateOriginals(db, root, profileId, left, verified);
  verifyDuplicateOriginals(db, root, profileId, right, verified);
  return { left: side(db, left), right: side(db, right) };
}
export function previewClinicalRelationship(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
): ClinicalRelationshipPreview {
  owner(db, profileId);
  const selected = request(input),
    left = current(db, selected.left),
    right = current(db, selected.right);
  if (
    (grouped(selected) ||
      (selected.action === 'provider_amendment' && selected.mode === 'confirm')) &&
    left.kind !== right.kind
  )
    throw new HttpError(
      400,
      'RELATIONSHIP_KIND',
      'Explicit relationship confirmation requires two records of the same current kind',
    );
  if (
    grouped(selected) ||
    (selected.action === 'provider_amendment' && selected.mode === 'confirm')
  ) {
    const person = (record: DuplicateRecord): string | null =>
      record.kind === 'document'
        ? typeof record.mapping.personId === 'string'
          ? record.mapping.personId
          : null
        : String(
            db
              .prepare(`SELECT person_id FROM ${clinicalTables[record.kind]} WHERE id=?`)
              .get(record.id)?.person_id || '',
          ) || null;
    if (!person(left) || person(left) !== person(right))
      throw new HttpError(
        409,
        'RELATIONSHIP_PERSON',
        'Both assertions must concern the same established person',
      );
    if (!left.evidence.length || !right.evidence.length)
      throw new HttpError(
        409,
        'RELATIONSHIP_EVIDENCE',
        'Both assertions need their retained original evidence',
      );
  }
  const verified = new Set<string>();
  verifyDuplicateOriginals(db, root, profileId, left, verified);
  verifyDuplicateOriginals(db, root, profileId, right, verified);
  if (selected.action === 'provider_amendment' && selected.mode === 'confirm')
    evidence(selected.direction === 'left_to_right' ? right : left, selected.evidence!);
  const state = graph(db),
    prior = state.decisions.find((decision) => decision.key === key(selected));
  constraints(selected, state, prior);
  const scope: ClinicalRelationshipScope = {
    format: 'clinical-relationship-scope-v1',
    profileId,
    left: reference(db, left),
    right: reference(db, right),
    previousDecisionId: prior?.id || null,
  };
  const version = revision(db);
  return {
    request: selected,
    scope,
    version,
    previewToken: hash([version, selected, scope]),
    left: side(db, left),
    right: side(db, right),
    originalsRetained: true,
    effect: {
      supersedes:
        selected.action === 'provider_amendment' && selected.mode === 'confirm'
          ? direction(selected)
          : null,
      preferredRecordId:
        selected.mode === 'prefer_left'
          ? left.id
          : selected.mode === 'prefer_right'
            ? right.id
            : null,
      showBoth: !['prefer_left', 'prefer_right'].includes(selected.mode),
      oneReviewedEvent: grouped(selected),
    },
  };
}
function view(
  db: Database,
  decision: Decision,
  selectedStatus: ClinicalRelationshipStatus,
  currentDecision = true,
): ClinicalRelationshipView {
  const navigation = (selected: ClinicalRelationshipRecord) => {
    const record = resolveClinicalReference(db, selected.kind, selected.recordId);
    return record ? clinicalNavigation(record.kind, record.recordId) : null;
  };
  return {
    decisionId: decision.id,
    previousDecisionId: decision.previousDecisionId,
    at: decision.at,
    request: decision.request,
    scope: decision.scope,
    reviewed: decision.reviewed,
    status: selectedStatus,
    currentDecision,
    leftNavigation: navigation(decision.request.left),
    rightNavigation: navigation(decision.request.right),
  };
}
export function clinicalRelationshipProjection(
  db: Database,
  profileId: string,
  selected: ClinicalRelationshipRecord,
): ClinicalRelationshipProjection {
  return clinicalRelationshipProjections(db, profileId, [selected])[0]!;
}
/** Share one bounded graph read across a detail/list/chart response. */
export function clinicalRelationshipProjections(
  db: Database,
  profileId: string,
  records: ClinicalRelationshipRecord[],
): ClinicalRelationshipProjection[] {
  owner(db, profileId);
  const state = graph(db);
  return records.map((selected) => projection(db, selected, state));
}
function projection(
  db: Database,
  selected: ClinicalRelationshipRecord,
  state: ReturnType<typeof graph>,
): ClinicalRelationshipProjection {
  if (!selector(selected))
    throw new HttpError(400, 'RELATIONSHIP_INPUT', 'Choose a supported record');
  const resolved = resolveClinicalReference(db, selected.kind, selected.recordId),
    record = resolved ? { kind: resolved.kind, recordId: resolved.recordId } : selected;
  const related = state.decisions.filter((decision) =>
    [decision.request.left.recordId, decision.request.right.recordId].includes(record.recordId),
  );
  const uncertain = new Set<string>();
  for (const decision of state.decisions)
    if (['stale', 'conflict', 'undecided'].includes(state.statuses.get(decision.id)!)) {
      uncertain.add(decision.request.left.recordId);
      uncertain.add(decision.request.right.recordId);
    }
  const display = {
    visibleByDefault: true,
    preferredRecordId: null as string | null,
    countGroupId: 'record:' + record.recordId,
    oneReviewedEvent: false,
    requiresReview: state.truncated || uncertain.has(record.recordId),
  };
  if (
    related.some(
      (decision) =>
        grouped(decision.request) &&
        (uncertain.has(decision.request.left.recordId) ||
          uncertain.has(decision.request.right.recordId)),
    )
  )
    display.requiresReview = true;
  const preferred = related.find(
    (decision) =>
      grouped(decision.request) &&
      state.statuses.get(decision.id) === 'current' &&
      !uncertain.has(decision.request.left.recordId) &&
      !uncertain.has(decision.request.right.recordId),
  );
  if (preferred && !state.truncated) {
    display.preferredRecordId =
      preferred.request.mode === 'prefer_left'
        ? preferred.request.left.recordId
        : preferred.request.mode === 'prefer_right'
          ? preferred.request.right.recordId
          : null;
    display.visibleByDefault =
      display.preferredRecordId === null || display.preferredRecordId === record.recordId;
    display.countGroupId = preferred.key;
    display.oneReviewedEvent = true;
  }
  const legacyRows = db
    .prepare(
      `SELECT coverage_json FROM manual_batches WHERE title='Duplicate evidence decision'
    AND (json_extract(coverage_json,'$.duplicateDecision.left.id')=? OR json_extract(coverage_json,'$.duplicateDecision.right.id')=?)
    ORDER BY json_extract(coverage_json,'$.duplicateDecision.sequence') DESC LIMIT 51`,
    )
    .all(record.recordId, record.recordId);
  return {
    record,
    relationships: related.map((decision) => view(db, decision, state.statuses.get(decision.id)!)),
    display,
    legacyPairs: legacyRows.slice(0, 50).map((row) => {
      const prior = JSON.parse(String(row.coverage_json)).duplicateDecision;
      return {
        decisionId: prior.id,
        outcome: prior.outcome,
        reason: prior.reason,
        otherRecordId: prior.left.id === record.recordId ? prior.right.id : prior.left.id,
        status: prior.outcome === 'unresolved' ? ('unresolved' as const) : ('historical' as const),
      };
    }),
    truncated: state.truncated || legacyRows.length > 50,
  };
}
function stored(db: Database, operationId: string): Stored | null {
  const row = db
    .prepare('SELECT coverage_json FROM manual_batches WHERE id=? AND title=?')
    .get('clinical-relationship:' + operationId, title);
  return row ? (JSON.parse(String(row.coverage_json)) as Stored) : null;
}
function result(
  db: Database,
  profileId: string,
  receipt: ClinicalRelationshipReceipt,
  replayed: boolean,
  error: string | null = null,
): ClinicalRelationshipApplyResult {
  const durable = personalDurabilityStatus(db);
  return {
    receipt,
    replayed,
    projections: clinicalRelationshipProjections(
      db,
      profileId,
      [receipt.scope.left, receipt.scope.right].map((record) => ({
        kind: record.kind,
        recordId: record.recordId,
      })),
    ),
    durability: {
      pending: !!error || durable.dirty || durable.conflicted,
      error: error || durable.lastError,
    },
  };
}
export function getClinicalRelationshipReceipt(
  db: Database,
  profileId: string,
  operationId: string,
): ClinicalRelationshipApplyResult {
  owner(db, profileId);
  if (!uuid.test(operationId))
    throw new HttpError(400, 'RELATIONSHIP_INPUT', 'Supply the stable relationship operation UUID');
  const previous = stored(db, operationId);
  if (!previous)
    throw new HttpError(404, 'RELATIONSHIP_NOT_FOUND', 'Relationship operation not found');
  return result(db, profileId, previous.receipt, true);
}
export function applyClinicalRelationship(
  db: Database,
  root: string,
  profileId: string,
  input: unknown,
): ClinicalRelationshipApplyResult {
  owner(db, profileId);
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) => !['operationId', 'request', 'scope', 'version', 'previewToken'].includes(key),
    ) ||
    typeof input.operationId !== 'string' ||
    !uuid.test(input.operationId) ||
    !object(input.scope) ||
    !Number.isSafeInteger(input.version) ||
    typeof input.previewToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.previewToken)
  )
    throw new HttpError(
      400,
      'RELATIONSHIP_INPUT',
      'Apply the exact preview request, scope, version and token with a stable operation UUID',
    );
  const selected = request(input.request),
    applied = structuredClone(input) as unknown as ClinicalRelationshipApplyInput;
  const fingerprint = hash([selected, applied.scope]),
    previous = stored(db, applied.operationId);
  if (previous) {
    if (previous.requestFingerprint !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation belongs to a different relationship review',
      );
    let error: string | null = null;
    try {
      exportCuration(db, root, profileId);
    } catch (failure) {
      error = (failure as Error).message;
    }
    return result(db, profileId, previous.receipt, true, error);
  }
  const receipt = transaction(
    db,
    () => {
      const preview = previewClinicalRelationship(db, root, profileId, selected);
      if (
        preview.version !== applied.version ||
        preview.previewToken !== applied.previewToken ||
        canonicalLiteral(preview.scope) !== canonicalLiteral(applied.scope)
      )
        throw new HttpError(
          409,
          'RELATIONSHIP_REVIEW_CHANGED',
          'Records, evidence or relationship decisions changed; review the current exact pair again',
        );
      const at = now(),
        decisionId = 'clinical-relationship:' + applied.operationId;
      const decision: Decision = {
        id: decisionId,
        key: key(selected),
        previousDecisionId: preview.scope.previousDecisionId,
        at,
        sequence: revision(db) + 1,
        request: selected,
        scope: preview.scope,
        reviewed: { left: preview.left, right: preview.right },
      };
      const receipt: ClinicalRelationshipReceipt = {
        operationId: applied.operationId,
        decisionId,
        at,
        action: selected.action,
        mode: selected.mode,
        scope: preview.scope,
      };
      db.prepare(
        "INSERT INTO manual_batches(id,title,status,created_at,verified_at,notes,coverage_json) VALUES(?,?,'verified',?,?,?,?)",
      ).run(
        decisionId,
        title,
        at,
        at,
        'Explicit relationship review; every assertion and original remains retained.',
        JSON.stringify({
          clinicalRelationship: decision,
          requestFingerprint: fingerprint,
          receipt,
        } satisfies Stored),
      );
      return receipt;
    },
    { operationId: applied.operationId, fingerprint },
  );
  let error: string | null = null;
  try {
    exportCuration(db, root, profileId);
  } catch (failure) {
    error = (failure as Error).message;
  }
  return result(db, profileId, receipt, false, error);
}
export function clinicalRelationshipHistory(
  db: Database,
  profileId: string,
  selected: ClinicalRelationshipRecord,
  options: { beforeSequence?: number; limit?: number } = {},
) {
  owner(db, profileId);
  const limit = options.limit ?? 20,
    before = options.beforeSequence ?? Number.MAX_SAFE_INTEGER;
  if (
    !selector(selected) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !Number.isSafeInteger(before) ||
    before < 0
  )
    throw new HttpError(400, 'RELATIONSHIP_INPUT', 'Choose a record and a bounded history page');
  const rows = db
    .prepare(
      `SELECT coverage_json FROM manual_batches WHERE title=? AND
    (json_extract(coverage_json,'$.clinicalRelationship.request.left.recordId')=? OR json_extract(coverage_json,'$.clinicalRelationship.request.right.recordId')=?)
    AND json_extract(coverage_json,'$.clinicalRelationship.sequence')<? ORDER BY json_extract(coverage_json,'$.clinicalRelationship.sequence') DESC LIMIT ?`,
    )
    .all(title, selected.recordId, selected.recordId, before, limit + 1)
    .map((row) => (JSON.parse(String(row.coverage_json)) as Stored).clinicalRelationship);
  const state = graph(db),
    ids = new Set(state.decisions.map((decision) => decision.id)),
    selectedRows = rows.slice(0, limit);
  return {
    entries: selectedRows.map((decision) => ({
      ...view(
        db,
        decision,
        state.statuses.get(decision.id) || status(db, decision),
        ids.has(decision.id),
      ),
      sequence: decision.sequence,
    })),
    nextBeforeSequence: rows.length > limit ? selectedRows.at(-1)!.sequence : null,
  };
}
