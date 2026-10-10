import { requireStoredIntakeDetails, writeIntakeDetails } from './intake-state-access.ts';
import { latestOwnershipDecision } from './ownership-journal.ts';
import { ownershipDecisionQueries } from './ownership-decision-index.ts';
import {
  intakeWorkflow,
  addWorkflowQuestion,
  workflowSummary,
  intakeCandidateId,
  intakeCandidateVersionId,
  workflowHash,
} from './intake-workflow.ts';
import { canonicalLiteral } from './intake-format.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { relatedRecordIds } from './related-records.ts';
import { verifyIntakeFileHash } from './intake-files.ts';
import { profileOriginal } from './profile-storage.ts';
import type {
  IntakePairScope,
  IntakePairScopeV2,
  IntakePairDraftScopeStatus,
  RelatedRecordSearch,
} from '../shared/clinical-review.ts';
import type {
  HealthRecordEnvelope,
  IntakeClinicalMapping,
  IntakeQuestion,
  IntakeQuestionAnswer,
  IntakePairDecision,
  IntakeEvidenceComparison,
} from '../shared/intake.ts';
import { HttpError, json, now, revision } from './database.ts';
import {
  savedDuplicateEvidenceReference,
  selectedDuplicateEvidenceDigest,
  savedDuplicateOriginalOverlap,
} from './duplicate-evidence-index.ts';
import type {
  SavedDuplicateEvidenceReference,
  RetainedDuplicateEvidenceReference,
} from '../shared/saved-duplicate-evidence.ts';
type ClinicalKind = 'observation' | 'medication' | 'procedure' | 'document';
type DuplicateOutcome = (typeof duplicateOutcomes)[number];
type SqlRow = Record<string, unknown>;

interface WorkflowFileRow extends SqlRow {
  id: string;
  sha256: string;
  details_json: string;
}

interface DuplicateReviewEvidence {
  label: string;
  locator: string;
  sourceRecordId?: string;
  original?: unknown;
  contentUrl?: string;
}

export interface DuplicateEvidence extends DuplicateReviewEvidence {
  sourceRecordId: string;
  contentUrl: string;
}

export interface DuplicateIdentity {
  kind: ClinicalKind;
  identity: string;
  version: string;
}

export interface DuplicateRecord extends DuplicateIdentity {
  id: string;
  title: string;
  date: string | null;
  sourceRecordId: string;
  mapping: IntakeClinicalMapping | SqlRow;
  evidence: DuplicateEvidence[];
  stateHash: string;
}
export type DuplicateRecordHeader = Omit<DuplicateRecord, 'evidence'>;
export interface DuplicateEvidenceSequence extends Iterable<DuplicateEvidence> {
  readonly length: number;
}
export type StreamingDuplicateRecord = DuplicateRecordHeader & {
  evidence: DuplicateEvidenceSequence;
};
export type NativeDuplicateRecord = DuplicateRecordHeader & {
  evidence: SavedDuplicateEvidenceReference;
};
type DuplicatePolicyRecord = DuplicateRecord | StreamingDuplicateRecord | NativeDuplicateRecord;
export function nativeDuplicateRecord(
  db: DatabaseSync,
  kind: string,
  id: string,
): NativeDuplicateRecord {
  return {
    ...duplicateRecordHeader(db, kind, id),
    evidence: savedDuplicateEvidenceReference(db, kind, id),
  };
}
function evidenceValues(
  db: DatabaseSync,
  record: DuplicatePolicyRecord,
): Iterable<DuplicateEvidence> {
  return 'format' in record.evidence
    ? duplicateEvidenceRows(db, record.kind, record.id)
    : record.evidence;
}

export interface DuplicateReviewRecord extends DuplicateIdentity {
  id: string;
  sourceRecordId: string;
  evidence: DuplicateReviewEvidence[];
}

interface DuplicateReference {
  kind: ClinicalKind;
  id: string;
  sourceRecordId: string;
  identity: string;
  version: string;
}

interface DuplicateDecisionInput {
  outcome: DuplicateOutcome;
  reason: string;
  occurrenceEvidence?: 'attach';
}

export interface IntakeOccurrenceContext {
  intakeId: string;
  intakeVersion: number;
  proposalId: string | null;
  candidateId: string;
  candidateVersionId: string;
  contextHash: string;
  locator: string;
  originalSourceFileId: string;
}

interface OccurrenceAttachmentTransition {
  format: 'reviewed-occurrence-attachment-v1';
  id: string;
  status: 'attached' | 'withdrawn';
  incomingSourceRecordId: string;
  targetKind: ClinicalKind;
  targetRecordId: string;
  evidenceId: string;
  evidenceRowHash: string;
  durableAuthorityHash: string;
  contextHash: string;
  previousTransitionId: string | null;
  appliedRevision: number;
  at: string;
}

export interface DuplicateDecision {
  id: string;
  pairKey: string;
  scope: 'pair';
  left: DuplicateReference;
  right: DuplicateReference;
  outcome: DuplicateOutcome;
  reason: string;
  occurrenceEvidence?: 'attach';
  evidence: {
    left: DuplicateReviewEvidence[];
    right: DuplicateReviewEvidence[] | RetainedDuplicateEvidenceReference;
  };
  evidenceBasis?: 'reviewed-pre-projection-v1';
  previousDecisionId: string | null;
  at: string;
  sequence: number;
  intakeScope?: IntakePairScope;
  occurrenceAttachment?: OccurrenceAttachmentTransition;
}

interface DuplicatePreviewInput extends DuplicateDecisionInput {
  kind: ClinicalKind;
  recordId: string;
  otherRecordId: string;
}

interface DuplicateQuestionAnswer extends IntakeQuestionAnswer {
  outcome: DuplicateOutcome;
  otherRecordId: string;
}

interface DuplicateQuestion extends Omit<IntakeQuestion, 'answers'> {
  answers: DuplicateQuestionAnswer[];
}

const tables: Record<ClinicalKind, string> = {
  observation: 'observations',
  medication: 'medications',
  procedure: 'procedures',
  document: 'documents',
};
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const duplicateOutcomes = [
  'same_event',
  'changed_version',
  'distinct',
  'unresolved',
] as const;
const isClinicalKind = (kind: string): kind is ClinicalKind => kind in tables;
const stringValue = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const parsedObject = (value: unknown): Record<string, unknown> => {
  const parsed: unknown = typeof value === 'string' ? json(value) : value;
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

export function duplicateRecordHeader(
  db: DatabaseSync,
  kind: string,
  id: string,
): DuplicateRecordHeader {
  if (!isClinicalKind(kind))
    throw new HttpError(400, 'DUPLICATE_KIND', 'Choose a supported clinical kind');
  const row = db.prepare(`SELECT * FROM ${tables[kind]} WHERE id=?`).get(id) as SqlRow | undefined;
  if (!row)
    throw new HttpError(404, 'RECORD_NOT_FOUND', 'Comparison record not found in this profile');
  const imported = parsedObject(parsedObject(row.extra_json).import);
  const acceptedMapping = parsedObject(imported.acceptedMapping);
  return {
    id,
    kind,
    title: stringValue(row.title) || stringValue(row.label) || id,
    date: stringValue(row.effective_at) || stringValue(acceptedMapping.date),
    sourceRecordId: stringValue(row.source_record_id) || '',
    identity: stringValue(imported.identity) || `${kind}:${id}`,
    version: stringValue(imported.version) || hash(row),
    stateHash: scopeHash(row),
    mapping: {
      ...(Object.keys(acceptedMapping).length ? acceptedMapping : row),
      personId:
        kind === 'document'
          ? stringValue(imported.personId) || 'patient'
          : stringValue(row.person_id) || 'patient',
    },
  };
}
export function* duplicateEvidenceRows(
  db: DatabaseSync,
  kind: ClinicalKind,
  id: string,
): Generator<DuplicateEvidence> {
  for (const source of db
    .prepare(
      'SELECT s.*,e.locator_json AS evidence_locator,p.name AS acquiring_source FROM evidence e JOIN source_records s ON s.id=e.source_record_id LEFT JOIN providers p ON p.id=s.provider_id WHERE e.entity_type=? AND e.entity_id=? ORDER BY e.id',
    )
    .iterate(kind, id)) {
    yield duplicateEvidenceValue(source);
  }
}
export function duplicateEvidenceValue(source: SqlRow): DuplicateEvidence {
  return {
    label: stringValue(source.acquiring_source) || 'Original source',
    locator:
      stringValue(parsedObject(source.evidence_locator).locator) ||
      stringValue(parsedObject(source.locator_json).locator) ||
      stringValue(source.source_key) ||
      'Retained record',
    sourceRecordId: stringValue(source.id) || '',
    original: json(source.raw_json),
    contentUrl: `/api/sources/${encodeURIComponent(
      stringValue(parsedObject(source.evidence_locator).originalSourceFileId) ||
        stringValue(source.source_file_id) ||
        '',
    )}/content`,
  };
}
/** Policy can inspect every source while retaining one evidence row at a time. */
export function streamingDuplicateRecord(
  db: DatabaseSync,
  kind: string,
  id: string,
): StreamingDuplicateRecord {
  const header = duplicateRecordHeader(db, kind, id);
  return {
    ...header,
    evidence: {
      get length() {
        return Number(
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM evidence e JOIN source_records s ON s.id=e.source_record_id WHERE e.entity_type=? AND e.entity_id=?',
            )
            .get(header.kind, id)!.n,
        );
      },
      [Symbol.iterator]: () => duplicateEvidenceRows(db, header.kind, id),
    },
  };
}
/** Legacy callers explicitly request the complete legacy DTO. */
export function duplicateRecord(db: DatabaseSync, kind: string, id: string): DuplicateRecord {
  const record = streamingDuplicateRecord(db, kind, id);
  return {
    ...record,
    evidence: Array.from(record.evidence),
  };
}
const reference = (
  record: DuplicateIdentity & Pick<DuplicateReviewRecord, 'id' | 'sourceRecordId'>,
): DuplicateReference => ({
  kind: record.kind,
  id: record.id,
  sourceRecordId: record.sourceRecordId,
  identity: record.identity,
  version: record.version,
});
const pairKey = (left: DuplicateIdentity, right: DuplicateIdentity): string =>
  hash(
    [left, right]
      .map((r) => [r.kind, r.identity, r.version])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
export function latestDuplicateDecision(
  db: DatabaseSync,
  left: DuplicateIdentity,
  right: DuplicateIdentity,
): string | undefined {
  const row = db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Duplicate evidence decision' AND json_extract(coverage_json,'$.duplicateDecision.pairKey')=? ORDER BY json_extract(coverage_json,'$.duplicateDecision.sequence') DESC,id DESC LIMIT 1",
    )
    .get(pairKey(left, right)) as { coverage_json?: string } | undefined;
  return row?.coverage_json;
}
export function duplicateCandidates(
  db: DatabaseSync,
  kind: string,
  mapping: IntakeClinicalMapping,
  identity: string,
): DuplicateRecord[] {
  if (!isClinicalKind(kind)) return [];
  return discoverDuplicateCandidates(db, kind, mapping, identity).records;
}
export function discoverDuplicateCandidates(
  db: DatabaseSync,
  kind: ClinicalKind,
  mapping: IntakeClinicalMapping,
  identity: string,
  search: RelatedRecordSearch = {},
) {
  const found = relatedRecordIds(db, { kind, mapping, identity }, search);
  return {
    records: found.matches.map((match) => ({
      ...duplicateRecord(db, kind, match.id),
      discoveryReasons: match.reasons,
    })),
    page: found.page,
  };
}

const scopeHash = (value: unknown): string =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');
export interface IntakePairIncoming extends DuplicateReviewRecord {
  stateHash: string;
}
export const intakeEnvelopeState = (value: HealthRecordEnvelope): string =>
  'candidate-version:' + createHash('sha256').update(canonicalLiteral(value)).digest('hex');
function* scopedEvidence(
  db: DatabaseSync,
  evidence: Iterable<DuplicateReviewEvidence>,
): Generator<unknown> {
  for (const item of evidence) {
    const match = /^\/api\/sources\/([^/?#]+)\/content(?:[?#]|$)/.exec(item.contentUrl || '');
    let source: unknown = null;
    if (match) {
      try {
        source =
          db
            .prepare('SELECT id,sha256,bytes FROM source_files WHERE id=?')
            .get(decodeURIComponent(match[1]!)) || null;
      } catch {
        throw new HttpError(
          409,
          'DUPLICATE_EVIDENCE',
          'The exact original reference is unavailable',
        );
      }
      if (!source)
        throw new HttpError(
          409,
          'DUPLICATE_EVIDENCE',
          'The exact original reference is unavailable',
        );
    }
    yield { evidence: item, source };
  }
}
function canonicalArrayHash(values: Iterable<unknown>): string {
  const hash = createHash('sha256').update('[');
  let first = true;
  for (const value of values) {
    if (!first) hash.update(',');
    first = false;
    hash.update(canonicalLiteral(value));
  }
  return hash.update(']').digest('hex');
}

const occurrenceEvidenceId = (
  transitionId: string,
  incomingSourceRecordId: string,
  targetKind: ClinicalKind,
  targetRecordId: string,
): string =>
  'evidence:reviewed-occurrence:' +
  scopeHash([transitionId, incomingSourceRecordId, targetKind, targetRecordId]);

function* occurrenceTransitions(
  db: DatabaseSync,
  incomingSourceRecordId: string,
): Generator<OccurrenceAttachmentTransition> {
  const rows =
    ownershipDecisionQueries(db)?.transitions(incomingSourceRecordId) ||
    db
      .prepare(
        "SELECT coverage_json FROM manual_batches WHERE title='Duplicate evidence decision' AND json_extract(coverage_json,'$.duplicateDecision.occurrenceAttachment.incomingSourceRecordId')=? ORDER BY json_extract(coverage_json,'$.duplicateDecision.sequence'),id",
      )
      .iterate(incomingSourceRecordId);
  for (const row of rows) {
    const transition = parsedObject(
      parsedObject(json(row.coverage_json)).duplicateDecision,
    ).occurrenceAttachment;
    if (transition && typeof transition === 'object' && !Array.isArray(transition))
      yield transition as OccurrenceAttachmentTransition;
  }
}

function latestOccurrenceAttachment(
  db: DatabaseSync,
  incomingSourceRecordId: string,
  targetKind?: ClinicalKind,
  targetRecordId?: string,
): OccurrenceAttachmentTransition | null {
  let latest: OccurrenceAttachmentTransition | null = null;
  for (const transition of occurrenceTransitions(db, incomingSourceRecordId))
    if (
      (!targetKind || transition.targetKind === targetKind) &&
      (!targetRecordId || transition.targetRecordId === targetRecordId)
    )
      latest = transition;
  const correction = latestOwnershipDecision<{ revision: number }>(
    db,
    'Record ownership source',
    'sourceRecordId',
    incomingSourceRecordId,
  );
  if (correction && latest && correction.revision >= latest.appliedRevision) return null;
  return latest;
}

function latestOccurrenceDecision(
  db: DatabaseSync,
  incomingSourceRecordId: string,
  targetKind: ClinicalKind,
  targetRecordId: string,
): string | undefined {
  return (
    db
      .prepare(
        "SELECT coverage_json FROM manual_batches WHERE title='Duplicate evidence decision' AND json_extract(coverage_json,'$.duplicateDecision.occurrenceAttachment.incomingSourceRecordId')=? AND json_extract(coverage_json,'$.duplicateDecision.occurrenceAttachment.targetKind')=? AND json_extract(coverage_json,'$.duplicateDecision.occurrenceAttachment.targetRecordId')=? ORDER BY json_extract(coverage_json,'$.duplicateDecision.sequence') DESC,id DESC LIMIT 1",
      )
      .get(incomingSourceRecordId, targetKind, targetRecordId) as
      { coverage_json: string } | undefined
  )?.coverage_json;
}

function evidenceRow(db: DatabaseSync, evidenceId: string): Record<string, unknown> | null {
  return (
    (db
      .prepare(
        'SELECT id,entity_type,entity_id,source_record_id,role,locator_json FROM evidence WHERE id=?',
      )
      .get(evidenceId) as Record<string, unknown> | undefined) || null
  );
}

function verifiedActiveAttachment(
  db: DatabaseSync,
  incomingSourceRecordId: string,
  targetKind: ClinicalKind,
  targetRecordId: string,
): OccurrenceAttachmentTransition | null {
  const transition = latestOccurrenceAttachment(
    db,
    incomingSourceRecordId,
    targetKind,
    targetRecordId,
  );
  if (!transition || transition.status === 'withdrawn') return null;
  const row = evidenceRow(db, transition.evidenceId);
  if (
    !row ||
    row.entity_type !== targetKind ||
    row.entity_id !== targetRecordId ||
    row.source_record_id !== incomingSourceRecordId ||
    row.role !== 'same_event_occurrence' ||
    scopeHash(row) !== transition.evidenceRowHash
  )
    throw new HttpError(
      409,
      'OCCURRENCE_ATTACHMENT_CHANGED',
      'The reviewed source occurrence no longer matches its durable attachment receipt',
    );
  const locator = parsedObject(row.locator_json);
  if (
    locator.attachmentTransitionId !== transition.id ||
    locator.incomingSourceRecordId !== incomingSourceRecordId
  )
    throw new HttpError(
      409,
      'OCCURRENCE_ATTACHMENT_CHANGED',
      'The reviewed source occurrence lineage no longer matches its receipt',
    );
  return transition;
}

function rawSavedEvidenceAuthority(
  db: DatabaseSync,
  targetKind: ClinicalKind,
  targetRecordId: string,
  active: OccurrenceAttachmentTransition | null,
): string {
  return canonicalArrayHash(
    rawSavedEvidenceValues(db, targetKind, targetRecordId, active?.evidenceId),
  );
}
export function* rawSavedEvidenceValues(
  db: DatabaseSync,
  targetKind: ClinicalKind,
  targetRecordId: string,
  excludedEvidenceId?: string,
): Generator<unknown> {
  const rows = db
    .prepare(
      `SELECT e.id,e.entity_type,e.entity_id,e.source_record_id,e.role,e.locator_json,
        s.source_file_id,s.provider_id,s.source_key,s.kind,s.raw_json,s.locator_json AS source_locator_json,s.extraction_status,
        f.sha256 AS source_file_sha256,f.bytes AS source_file_bytes,
        o.id AS original_source_file_id,o.sha256 AS original_source_file_sha256,o.bytes AS original_source_file_bytes
      FROM evidence e JOIN source_records s ON s.id=e.source_record_id
      JOIN source_files f ON f.id=s.source_file_id
      LEFT JOIN source_files o ON o.id=COALESCE(json_extract(e.locator_json,'$.originalSourceFileId'),s.source_file_id)
      WHERE e.entity_type=? AND e.entity_id=? ORDER BY e.id`,
    )
    .iterate(targetKind, targetRecordId);
  for (const row of rows) {
    if (!row.original_source_file_id)
      throw new HttpError(
        409,
        'DUPLICATE_EVIDENCE',
        'A saved evidence row no longer has its exact retained original',
      );
    if (excludedEvidenceId && row.id === excludedEvidenceId) continue;
    yield {
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      sourceRecordId: row.source_record_id,
      role: row.role,
      locator: row.locator_json,
      sourceFileId: row.source_file_id,
      providerId: row.provider_id,
      sourceKey: row.source_key,
      kind: row.kind,
      rawHash: scopeHash(String(row.raw_json)),
      sourceLocatorHash: scopeHash(String(row.source_locator_json)),
      extractionStatus: row.extraction_status,
      sourceFileSha256: row.source_file_sha256,
      sourceFileBytes: row.source_file_bytes,
      originalSourceFileId: row.original_source_file_id,
      originalSourceFileSha256: row.original_source_file_sha256,
      originalSourceFileBytes: row.original_source_file_bytes,
    };
  }
}

function sourceRecordAuthority(db: DatabaseSync, sourceRecordId: string): unknown {
  const row = db
    .prepare(
      `SELECT s.id,s.source_file_id,s.provider_id,s.source_key,s.kind,s.label,s.raw_json,s.locator_json,s.extraction_status,s.batch_id,
        f.sha256 AS source_file_sha256,f.bytes AS source_file_bytes,
        o.id AS original_source_file_id,o.sha256 AS original_source_file_sha256,o.bytes AS original_source_file_bytes
      FROM source_records s JOIN source_files f ON f.id=s.source_file_id
      LEFT JOIN source_files o ON o.id=COALESCE(json_extract(s.locator_json,'$.originalSourceFileId'),s.source_file_id)
      WHERE s.id=?`,
    )
    .get(sourceRecordId) as Record<string, unknown> | undefined;
  if (!row)
    throw new HttpError(
      409,
      'OCCURRENCE_ATTACHMENT_CHANGED',
      'The retained incoming source occurrence is unavailable',
    );
  if (!row.original_source_file_id)
    throw new HttpError(
      409,
      'OCCURRENCE_ATTACHMENT_CHANGED',
      'The incoming source occurrence no longer has its exact retained original',
    );
  return {
    ...row,
    raw_json: scopeHash(String(row.raw_json)),
    locator_json: scopeHash(String(row.locator_json)),
  };
}

function durableAttachmentAuthority(
  db: DatabaseSync,
  incoming: IntakePairIncoming,
  saved: DuplicatePolicyRecord,
  contextHash: string,
  active: OccurrenceAttachmentTransition | null,
): string {
  return scopeHash({
    profileId: String(
      db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value || '',
    ),
    contextHash,
    incoming: {
      ...intakePairReference(db, incoming),
      source: sourceRecordAuthority(db, incoming.sourceRecordId),
    },
    saved: {
      kind: saved.kind,
      recordId: saved.id,
      sourceRecordId: saved.sourceRecordId,
      identity: saved.identity,
      version: saved.version,
      stateHash: saved.stateHash,
      evidenceHash: rawSavedEvidenceAuthority(db, saved.kind, saved.id, active),
    },
  });
}

function occurrenceAttachmentCurrent(
  db: DatabaseSync,
  incoming: IntakePairIncoming,
  saved: DuplicatePolicyRecord,
  contextHash: string | undefined,
  transition: OccurrenceAttachmentTransition,
): boolean {
  if (!contextHash || transition.contextHash !== contextHash) return false;
  const latest = latestOccurrenceAttachment(db, incoming.sourceRecordId, saved.kind, saved.id);
  if (!latest || latest.id !== transition.id) return false;
  try {
    const active =
      transition.status === 'attached'
        ? verifiedActiveAttachment(db, incoming.sourceRecordId, saved.kind, saved.id)
        : null;
    if (transition.status === 'withdrawn' && evidenceRow(db, transition.evidenceId)) return false;
    return (
      transition.durableAuthorityHash ===
      durableAttachmentAuthority(db, incoming, saved, contextHash, active)
    );
  } catch {
    return false;
  }
}

function sameDurablePairScope(left: unknown, right: IntakePairScope): boolean {
  if (
    !left ||
    typeof left !== 'object' ||
    Array.isArray(left) ||
    (left as { format?: unknown }).format !== 'intake-pair-scope-v2' ||
    right.format !== 'intake-pair-scope-v2'
  )
    return canonicalLiteral(left) === canonicalLiteral(right);
  const durable = (scope: IntakePairScopeV2) => ({
    format: scope.format,
    profileId: scope.profileId,
    contextHash: scope.contextHash,
    incoming: scope.incoming,
    saved: scope.saved,
    activeAttachment: scope.activeAttachment,
  });
  return canonicalLiteral(durable(left as IntakePairScopeV2)) === canonicalLiteral(durable(right));
}
/** A scope pins evidence and state, not just IDs that may refer to later corrected records. */
export function intakePairScope(
  db: DatabaseSync,
  incoming: IntakePairIncoming,
  saved: DuplicatePolicyRecord,
  occurrence?: Pick<IntakeOccurrenceContext, 'intakeVersion' | 'contextHash'>,
): IntakePairScope {
  const profileId = String(
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value || '',
  );
  if (occurrence) {
    let active: OccurrenceAttachmentTransition | null = null;
    try {
      active = verifiedActiveAttachment(db, incoming.sourceRecordId, saved.kind, saved.id);
    } catch {
      // A corrupt active row must remain inside the digest and can never be
      // excluded as the operation's own verified row.
      active = null;
    }
    const scope = {
      format: 'intake-pair-scope-v2' as const,
      profileId,
      requestRevision: revision(db),
      intakeVersion: occurrence.intakeVersion,
      contextHash: occurrence.contextHash,
      incoming: intakePairReference(db, incoming),
      saved: {
        ...intakePairReference(db, saved),
        evidenceHash:
          !active && 'format' in saved.evidence
            ? selectedDuplicateEvidenceDigest(db, saved.kind, saved.id).rawDigest
            : rawSavedEvidenceAuthority(db, saved.kind, saved.id, active),
        recordId: saved.id,
      },
      activeAttachment: active
        ? {
            transitionId: active.id,
            evidenceId: active.evidenceId,
            targetKind: active.targetKind,
            targetRecordId: active.targetRecordId,
          }
        : null,
    };
    return { ...scope, token: scopeHash(scope) };
  }
  const scope = {
    format: 'intake-pair-scope-v1' as const,
    profileId,
    incoming: intakePairReference(db, incoming),
    saved: { ...intakePairReference(db, saved), recordId: saved.id },
  };
  return { ...scope, token: scopeHash(scope) };
}
export function intakePairReference(
  db: DatabaseSync,
  record: IntakePairIncoming | DuplicatePolicyRecord,
) {
  return {
    kind: record.kind,
    sourceRecordId: record.sourceRecordId,
    identity: record.identity,
    version: record.version,
    stateHash: record.stateHash,
    evidenceHash:
      'format' in record.evidence
        ? selectedDuplicateEvidenceDigest(db, record.kind, record.id).scopeDigest
        : canonicalArrayHash(scopedEvidence(db, record.evidence)),
  };
}
export function requireIntakePairScope(
  db: DatabaseSync,
  incoming: IntakePairIncoming,
  saved: DuplicatePolicyRecord,
  scope: unknown,
  occurrence?: IntakeOccurrenceContext,
): void {
  const current = intakePairScope(db, incoming, saved, occurrence);
  // This is the transient request CAS: every pin, including request revision
  // and intake version, must match before any projection starts. Compound
  // projection deliberately does not rerun it after its own authorized writes.
  if (!scope || canonicalLiteral(scope) !== canonicalLiteral(current))
    throw new HttpError(
      409,
      'DUPLICATE_SCOPE_CHANGED',
      'Review both exact record versions and their originals again before choosing this relationship',
    );
}
export function verifyDuplicateOriginals(
  db: DatabaseSync,
  root: string,
  profileId: string,
  record: DuplicatePolicyRecord,
  verified: Set<string>,
): void {
  // The evidence link can point to an uploaded original while the accepted
  // assertion itself came from a retained transcription/proposal. Both are
  // dependencies of this comparison; verify the carrier without rescanning
  // unrelated originals as the former whole-profile snapshot did.
  const verify = (id: string) => {
    if (verified.has(id)) return;
    const source = db.prepare('SELECT path,bytes,sha256 FROM source_files WHERE id=?').get(id) as
      { path: string; bytes: number; sha256: string } | undefined;
    if (!source)
      throw new HttpError(409, 'DUPLICATE_EVIDENCE', 'The saved record original is unavailable');
    verifyIntakeFileHash(profileOriginal(root, source.path, profileId), source);
    if (verified.size >= 256) verified.delete(verified.values().next().value!);
    verified.add(id);
  };
  const carrier = (sourceRecordId: string) => {
    if (!sourceRecordId) return;
    const source = db
      .prepare('SELECT source_file_id FROM source_records WHERE id=?')
      .get(sourceRecordId);
    if (!source)
      throw new HttpError(409, 'DUPLICATE_EVIDENCE', 'The saved assertion source is unavailable');
    verify(String(source.source_file_id));
  };
  carrier(record.sourceRecordId);
  for (const evidence of evidenceValues(db, record)) {
    carrier(evidence.sourceRecordId);
    const match = /^\/api\/sources\/([^/?#]+)\/content(?:[?#]|$)/.exec(evidence.contentUrl);
    if (!match)
      throw new HttpError(
        409,
        'DUPLICATE_EVIDENCE',
        'Both records need their exact retained originals',
      );
    verify(decodeURIComponent(match[1]!));
  }
}
export function intakePairDraftStatus(
  db: DatabaseSync,
  incoming: IntakePairIncoming,
  decision: { otherRecordId: string; scope?: IntakePairScope } | undefined,
  occurrence?: IntakeOccurrenceContext,
  nativeRetained = false,
): IntakePairDraftScopeStatus {
  if (!decision) return 'none';
  if (!decision.scope) return 'missing';
  try {
    if (nativeRetained)
      return sameDurablePairScope(
        decision.scope,
        intakePairScope(
          db,
          incoming,
          nativeDuplicateRecord(db, incoming.kind, decision.otherRecordId),
          occurrence,
        ),
      )
        ? 'current'
        : 'stale';
    requireIntakePairScope(
      db,
      incoming,
      streamingDuplicateRecord(db, incoming.kind, decision.otherRecordId),
      decision.scope,
      occurrence,
    );
    return 'current';
  } catch {
    return 'stale';
  }
}
export function intakePairPreviousDecision(
  db: DatabaseSync,
  incoming: IntakePairIncoming,
  candidate: DuplicatePolicyRecord,
  scope: IntakePairScope,
  contextHash?: string,
): IntakeEvidenceComparison['previousDecision'] {
  const saved =
    latestDuplicateDecision(db, incoming, candidate) ||
    latestOccurrenceDecision(db, incoming.sourceRecordId, candidate.kind, candidate.id);
  const prior = saved ? parsedObject(parsedObject(json(saved)).duplicateDecision) : null;
  if (!prior) return null;
  return {
    ...(prior as unknown as NonNullable<IntakeEvidenceComparison['previousDecision']>),
    attachmentStatus: (prior.occurrenceAttachment as OccurrenceAttachmentTransition | undefined)
      ?.status,
    scopeStatus: !prior.intakeScope
      ? 'legacy'
      : prior.occurrenceAttachment
        ? occurrenceAttachmentCurrent(
            db,
            incoming,
            candidate,
            contextHash,
            prior.occurrenceAttachment as OccurrenceAttachmentTransition,
          )
          ? 'current'
          : 'stale'
        : sameDurablePairScope(prior.intakeScope, scope)
          ? 'current'
          : 'stale',
  };
}
export function buildIntakeRelatedReview(
  db: DatabaseSync,
  incoming: IntakePairIncoming,
  mapping: IntakeClinicalMapping,
  decisions: IntakePairDecision[] = [],
  search: RelatedRecordSearch = {},
  occurrence?: IntakeOccurrenceContext,
  options: { native?: boolean } = {},
) {
  const found = options.native
    ? (() => {
        const found = relatedRecordIds(
          db,
          { kind: incoming.kind, mapping, identity: incoming.identity },
          search,
        );
        return {
          page: found.page,
          records: found.matches.map((match) => ({
            ...nativeDuplicateRecord(db, incoming.kind, match.id),
            discoveryReasons: match.reasons,
          })),
        };
      })()
    : discoverDuplicateCandidates(db, incoming.kind, mapping, incoming.identity, search);
  const comparisons: IntakeEvidenceComparison[] = found.records.map((candidate) => {
    const scope = intakePairScope(db, incoming, candidate, occurrence);
    return {
      ...candidate,
      ...(options.native
        ? {
            originalOverlap: savedDuplicateOriginalOverlap(
              db,
              candidate.kind,
              candidate.id,
              incoming.evidence,
            ),
          }
        : {}),
      mapping: candidate.mapping as IntakeClinicalMapping,
      previousDecision: intakePairPreviousDecision(
        db,
        incoming,
        candidate,
        scope,
        occurrence?.contextHash,
      ),
      scope,
      draftScopeStatus: intakePairDraftStatus(
        db,
        incoming,
        decisions.find((decision) => decision.otherRecordId === candidate.id),
        occurrence,
        options.native,
      ),
    };
  });
  return {
    comparisons,
    comparisonPage: found.page,
    comparisonReference: intakePairReference(db, incoming),
    comparisonDrafts: decisions.map((decision) => ({
      otherRecordId: decision.otherRecordId,
      status: intakePairDraftStatus(db, incoming, decision, occurrence, options.native),
    })),
  };
}
export function saveDuplicateDecision(
  db: DatabaseSync,
  left: DuplicateReviewRecord,
  right: DuplicateReviewRecord | StreamingDuplicateRecord,
  input: DuplicateDecisionInput,
  operationId: string,
  intakeScope?: {
    incoming: IntakePairIncoming;
    scope: unknown;
    occurrence?: IntakeOccurrenceContext;
    prevalidated?: boolean;
    reviewedSavedEvidence?: RetainedDuplicateEvidenceReference;
  },
): DuplicateDecision {
  if (intakeScope && !intakeScope.prevalidated)
    requireIntakePairScope(
      db,
      intakeScope.incoming,
      streamingDuplicateRecord(db, right.kind, right.id),
      intakeScope.scope,
      intakeScope.occurrence,
    );
  if (
    left.id === right.id ||
    left.kind !== right.kind ||
    !duplicateOutcomes.includes(input.outcome) ||
    typeof input.reason !== 'string' ||
    !input.reason.trim() ||
    input.reason.length > 4000
  )
    throw new HttpError(
      400,
      'DUPLICATE_DECISION',
      'Compare two different records of the same kind and give an evidence-based reason',
    );
  if (
    !intakeScope &&
    duplicateRecordHeader(db, left.kind, left.id).mapping.personId !==
      duplicateRecordHeader(db, right.kind, right.id).mapping.personId
  )
    throw new HttpError(409, 'DUPLICATE_PERSON', 'Both records must belong to the same person');
  if (!left.evidence?.length || !right.evidence?.length)
    throw new HttpError(400, 'DUPLICATE_EVIDENCE', 'Both records need retained original evidence');
  const rightEvidence =
    intakeScope?.reviewedSavedEvidence ||
    (Array.isArray(right.evidence) ? right.evidence : undefined);
  if (!rightEvidence)
    throw new HttpError(
      409,
      'DUPLICATE_EVIDENCE_PENDING',
      'Prepare the complete reviewed saved evidence before recording this relationship',
    );
  if (
    input.occurrenceEvidence !== undefined &&
    (input.occurrenceEvidence !== 'attach' || input.outcome !== 'same_event')
  )
    throw new HttpError(
      400,
      'DUPLICATE_DECISION',
      'Only a fresh same-event intake choice may attach a source occurrence',
    );
  if (
    input.occurrenceEvidence === 'attach' &&
    (!intakeScope?.occurrence ||
      (intakeScope.scope as { format?: unknown } | null)?.format !== 'intake-pair-scope-v2')
  )
    throw new HttpError(
      409,
      'DUPLICATE_SCOPE_CHANGED',
      'Refresh this exact incoming pair before attaching its source occurrence',
    );
  const previous = latestDuplicateDecision(db, left, right),
    prior = previous ? parsedObject(parsedObject(json(previous)).duplicateDecision) : null;
  const saved = intakeScope ? streamingDuplicateRecord(db, right.kind, right.id) : null;
  let active: OccurrenceAttachmentTransition | null = null;
  let priorOccurrenceTransition: OccurrenceAttachmentTransition | null = null;
  if (intakeScope?.occurrence && saved) {
    priorOccurrenceTransition = latestOccurrenceAttachment(
      db,
      intakeScope.incoming.sourceRecordId,
      saved.kind,
      saved.id,
    );
    if (priorOccurrenceTransition?.status === 'attached')
      active = verifiedActiveAttachment(
        db,
        intakeScope.incoming.sourceRecordId,
        saved.kind,
        saved.id,
      );
  }
  if (input.occurrenceEvidence === 'attach') {
    const corrected = latestOwnershipDecision<{ recordId: string; kind: string }>(
      db,
      'Record ownership source',
      'sourceRecordId',
      intakeScope!.incoming.sourceRecordId,
    );
    if (
      corrected &&
      db
        .prepare(
          'SELECT 1 FROM evidence WHERE entity_type=? AND entity_id=? AND source_record_id=?',
        )
        .get(corrected.kind, corrected.recordId, intakeScope!.incoming.sourceRecordId)
    )
      throw new HttpError(
        409,
        corrected.recordId === saved!.id && corrected.kind === saved!.kind
          ? 'OCCURRENCE_ALREADY_ATTACHED'
          : 'OCCURRENCE_ATTACHMENT_TARGET',
        'This corrected contribution already belongs to a saved record. Review another ownership correction to change that assignment.',
      );
    let other: OccurrenceAttachmentTransition | undefined;
    for (const transition of occurrenceTransitions(db, intakeScope!.incoming.sourceRecordId)) {
      if (
        latestOccurrenceAttachment(
          db,
          intakeScope!.incoming.sourceRecordId,
          transition.targetKind,
          transition.targetRecordId,
        )?.id === transition.id &&
        transition.status === 'attached' &&
        (transition.targetKind !== saved!.kind || transition.targetRecordId !== saved!.id)
      ) {
        other = transition;
        break;
      }
    }
    if (other)
      throw new HttpError(
        409,
        'OCCURRENCE_ATTACHMENT_TARGET',
        'Withdraw the current reviewed occurrence attachment before choosing another target',
      );
    if (active)
      throw new HttpError(
        409,
        'OCCURRENCE_ALREADY_ATTACHED',
        'This source occurrence is already attached to the selected record',
      );
  }
  const at = now();
  const decisionId = 'duplicate-decision:' + operationId;
  let occurrenceAttachment: OccurrenceAttachmentTransition | undefined;
  if (intakeScope?.occurrence && saved && input.occurrenceEvidence === 'attach') {
    const transitionId = decisionId + ':occurrence';
    const evidenceId = occurrenceEvidenceId(
      transitionId,
      intakeScope.incoming.sourceRecordId,
      saved.kind,
      saved.id,
    );
    const locator = JSON.stringify({
      locator: intakeScope.occurrence.locator,
      originalSourceFileId: intakeScope.occurrence.originalSourceFileId,
      reviewed: true,
      incomingSourceRecordId: intakeScope.incoming.sourceRecordId,
      attachmentTransitionId: transitionId,
    });
    const row = {
      id: evidenceId,
      entity_type: saved.kind,
      entity_id: saved.id,
      source_record_id: intakeScope.incoming.sourceRecordId,
      role: 'same_event_occurrence',
      locator_json: locator,
    };
    occurrenceAttachment = {
      format: 'reviewed-occurrence-attachment-v1',
      id: transitionId,
      status: 'attached',
      incomingSourceRecordId: intakeScope.incoming.sourceRecordId,
      targetKind: saved.kind,
      targetRecordId: saved.id,
      evidenceId,
      evidenceRowHash: scopeHash(row),
      durableAuthorityHash: durableAttachmentAuthority(
        db,
        intakeScope.incoming,
        saved,
        intakeScope.occurrence.contextHash,
        null,
      ),
      contextHash: intakeScope.occurrence.contextHash,
      previousTransitionId: priorOccurrenceTransition?.id || null,
      appliedRevision: revision(db) + 1,
      at,
    };
  } else if (intakeScope?.occurrence && saved && input.outcome !== 'same_event' && active) {
    occurrenceAttachment = {
      format: 'reviewed-occurrence-attachment-v1',
      id: decisionId + ':occurrence',
      status: 'withdrawn',
      incomingSourceRecordId: intakeScope.incoming.sourceRecordId,
      targetKind: saved.kind,
      targetRecordId: saved.id,
      evidenceId: active.evidenceId,
      evidenceRowHash: active.evidenceRowHash,
      durableAuthorityHash: durableAttachmentAuthority(
        db,
        intakeScope.incoming,
        saved,
        intakeScope.occurrence.contextHash,
        active,
      ),
      contextHash: intakeScope.occurrence.contextHash,
      previousTransitionId: active.id,
      appliedRevision: revision(db) + 1,
      at,
    };
  }
  const decision: DuplicateDecision = {
    id: decisionId,
    pairKey: pairKey(left, right),
    scope: 'pair',
    left: reference(left),
    right: reference(right),
    outcome: input.outcome,
    reason: input.reason.trim(),
    ...(input.occurrenceEvidence ? { occurrenceEvidence: input.occurrenceEvidence } : {}),
    evidence: { left: left.evidence, right: rightEvidence },
    ...(intakeScope?.reviewedSavedEvidence
      ? { evidenceBasis: 'reviewed-pre-projection-v1' as const }
      : {}),
    previousDecisionId: stringValue(prior?.id),
    at,
    sequence: Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(json_extract(coverage_json,'$.duplicateDecision.sequence')),0)+1 AS n FROM manual_batches",
          )
          .get() as { n: number | bigint }
      ).n,
    ),
    ...(intakeScope ? { intakeScope: structuredClone(intakeScope.scope) as IntakePairScope } : {}),
    ...(occurrenceAttachment ? { occurrenceAttachment } : {}),
  };
  db.prepare(
    "INSERT INTO manual_batches(id,title,status,created_at,verified_at,notes,coverage_json) VALUES(?,'Duplicate evidence decision','verified',?,?,?,?)",
  ).run(
    decision.id,
    decision.at,
    decision.at,
    'Reviewed relationship; every assertion, link and original remains retained.',
    JSON.stringify({ duplicateDecision: decision }),
  );
  // A relationship records the reviewed grouping. It never collapses rows or
  // elects a clinical value. Later decisions version this projection and retain
  // the complete superseded decision in the immutable curation journal.
  if (left.sourceRecordId !== right.sourceRecordId) {
    const ids = [left.sourceRecordId, right.sourceRecordId].sort();
    db.prepare(
      "INSERT INTO record_relationships(id,from_record_id,to_record_id,relation,status,rationale) VALUES(?,?,?,'reviewed_pair',?,?) ON CONFLICT(from_record_id,to_record_id,relation) DO UPDATE SET status=excluded.status,rationale=excluded.rationale",
    ).run(
      'reviewed-pair:' + hash(ids),
      ...ids,
      input.outcome === 'unresolved'
        ? 'proposed'
        : input.outcome === 'distinct'
          ? 'rejected'
          : 'accepted',
      JSON.stringify({
        decisionId: decision.id,
        outcome: decision.outcome,
        reason: decision.reason,
        left: decision.left,
        right: decision.right,
      }),
    );
  }
  if (occurrenceAttachment?.status === 'attached') {
    const locator = JSON.stringify({
      locator: intakeScope!.occurrence!.locator,
      originalSourceFileId: intakeScope!.occurrence!.originalSourceFileId,
      reviewed: true,
      incomingSourceRecordId: intakeScope!.incoming.sourceRecordId,
      attachmentTransitionId: occurrenceAttachment.id,
    });
    db.prepare(
      "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role,locator_json) VALUES(?,?,?,?, 'same_event_occurrence',?)",
    ).run(
      occurrenceAttachment.evidenceId,
      occurrenceAttachment.targetKind,
      occurrenceAttachment.targetRecordId,
      occurrenceAttachment.incomingSourceRecordId,
      locator,
    );
  } else if (occurrenceAttachment?.status === 'withdrawn') {
    const removed = db
      .prepare('DELETE FROM evidence WHERE id=?')
      .run(occurrenceAttachment.evidenceId);
    if (Number(removed.changes) !== 1)
      throw new HttpError(
        409,
        'OCCURRENCE_ATTACHMENT_CHANGED',
        'The reviewed source occurrence changed before withdrawal',
      );
  }
  return decision;
}

/** Finalize durable authority after every authorized projection in one atomic batch. */
export interface OccurrenceAuthorityFinalizer {
  decision: DuplicateDecision;
  incoming: IntakePairIncoming;
  context: IntakeOccurrenceContext;
}

/** Finalize only decisions registered by this trusted, still-uncommitted compound operation. */
export function refreshOccurrenceAttachmentAuthorities(
  db: DatabaseSync,
  pending: OccurrenceAuthorityFinalizer[],
): void {
  const ids = new Set<string>();
  for (const item of pending) {
    const expected = item.decision.occurrenceAttachment;
    if (!expected) continue;
    if (ids.has(item.decision.id))
      throw new HttpError(
        409,
        'OCCURRENCE_ATTACHMENT_CHANGED',
        'The compound operation repeated an occurrence decision',
      );
    ids.add(item.decision.id);
    const stored = db
      .prepare(
        "SELECT coverage_json FROM manual_batches WHERE id=? AND title='Duplicate evidence decision'",
      )
      .get(item.decision.id) as { coverage_json: string } | undefined;
    if (!stored)
      throw new HttpError(
        409,
        'OCCURRENCE_ATTACHMENT_CHANGED',
        'The durable occurrence decision is unavailable',
      );
    const coverage = parsedObject(json(stored.coverage_json));
    const storedDecision = parsedObject(coverage.duplicateDecision) as unknown as DuplicateDecision;
    const transition = storedDecision.occurrenceAttachment;
    const scope = storedDecision.intakeScope as IntakePairScopeV2 | undefined;
    if (
      storedDecision.id !== item.decision.id ||
      !transition ||
      transition.id !== expected.id ||
      transition.appliedRevision !== expected.appliedRevision ||
      !scope ||
      scope.format !== 'intake-pair-scope-v2'
    )
      throw new HttpError(
        409,
        'OCCURRENCE_ATTACHMENT_CHANGED',
        'The durable occurrence decision changed before finalization',
      );
    const saved = streamingDuplicateRecord(db, transition.targetKind, transition.targetRecordId);
    const active =
      transition.status === 'attached'
        ? verifiedActiveAttachment(
            db,
            transition.incomingSourceRecordId,
            transition.targetKind,
            transition.targetRecordId,
          )
        : null;
    if (transition.status === 'withdrawn' && evidenceRow(db, transition.evidenceId))
      throw new HttpError(
        409,
        'OCCURRENCE_ATTACHMENT_CHANGED',
        'The withdrawn occurrence evidence row still exists',
      );
    transition.durableAuthorityHash = durableAttachmentAuthority(
      db,
      item.incoming,
      saved,
      item.context.contextHash,
      active,
    );
    storedDecision.occurrenceAttachment = transition;
    coverage.duplicateDecision = storedDecision as unknown as Record<string, unknown>;
    db.prepare('UPDATE manual_batches SET coverage_json=? WHERE id=?').run(
      JSON.stringify(coverage),
      storedDecision.id,
    );
  }
}
export function previewDuplicateDecision(db: DatabaseSync, input: DuplicatePreviewInput) {
  const left = duplicateRecord(db, input.kind, input.recordId),
    right = duplicateRecord(db, input.kind, input.otherRecordId);
  if (
    left.id === right.id ||
    !duplicateOutcomes.includes(input.outcome) ||
    typeof input.reason !== 'string' ||
    !input.reason.trim() ||
    input.reason.length > 4000
  )
    throw new HttpError(
      400,
      'DUPLICATE_DECISION',
      'Choose two different records, an outcome and an evidence-based reason',
    );
  if (left.mapping.personId !== right.mapping.personId)
    throw new HttpError(409, 'DUPLICATE_PERSON', 'Both records must belong to the same person');
  const saved = latestDuplicateDecision(db, left, right);
  return {
    token: hash([revision(db), input, left, right]),
    version: revision(db),
    left,
    right,
    outcome: input.outcome,
    reason: input.reason,
    previousDecision: saved ? parsedObject(parsedObject(json(saved)).duplicateDecision) : null,
    assertionsRetained: true,
  };
}

// Assistant decisions must also remain discoverable on the source delivery after
// the conversation closes. This versions source workflow metadata, never bytes.
export function syncDuplicateQuestions(db: DatabaseSync, decision: DuplicateDecision): void {
  for (const [record, other] of [
    [decision.left, decision.right],
    [decision.right, decision.left],
  ]) {
    const source = db
      .prepare('SELECT * FROM source_records WHERE id=?')
      .get(record.sourceRecordId) as SqlRow | undefined;
    if (!source) continue;
    const sourceFileId =
      stringValue(parsedObject(source.locator_json).originalSourceFileId) ||
      stringValue(source.source_file_id);
    if (!sourceFileId) continue;
    const file = db
      .prepare("SELECT * FROM source_files WHERE id=? AND kind='intake_original'")
      .get(sourceFileId) as WorkflowFileRow | undefined;
    if (!file) continue;
    const intake = requireStoredIntakeDetails(db, file),
      workflow = intakeWorkflow(intake);
    const envelope = json(source.raw_json) as HealthRecordEnvelope,
      candidateId = intakeCandidateId(file, { value: envelope });
    if (!workflow.candidates.some((candidate) => candidate.id === candidateId)) continue;
    const candidateVersionId = intakeCandidateVersionId(
      intake as Parameters<typeof intakeCandidateVersionId>[0],
      source.source_file_id === file.id ? null : String(source.source_file_id),
      { value: envelope },
    );
    const question = addWorkflowQuestion(file, workflow, {
      key:
        'duplicate:' +
        workflowHash([candidateId, candidateVersionId, other.identity, other.version]),
      candidateId,
      candidateVersionId,
      prompt:
        'Review whether these paired records describe the same event, a changed version, or distinct events.',
      locator: envelope.provenance?.locator || 'Retained record',
      field: 'duplicate',
    }) as DuplicateQuestion;
    question.otherRecordId = other.id;
    if (!question.answers.some((answer) => answer.id === decision.id))
      question.answers.push({
        id: decision.id,
        answer: decision.reason,
        outcome: decision.outcome,
        otherRecordId: other.id,
        mapping: {},
        scope: 'record',
        at: decision.at,
      });
    question.status = decision.outcome === 'unresolved' ? 'unanswered' : 'resolved';
    if (question.status === 'resolved') {
      question.resolvedAt = decision.at;
      question.resolvedByDecisionId = decision.id;
    }
    intake.version = Number(intake.version || 0) + 1;
    intake.state = workflowSummary(intake).needsReview ? 'needs_review' : 'imported';
    writeIntakeDetails(db, file, intake, { effective: false });
  }
}
