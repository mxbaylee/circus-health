import { selectedOwnershipBlockers } from './ownership-identity-values.ts';
import { reviewIssueCollection } from './intake-review-issue-state.ts';
import { reviewRecordIdentityWarnings } from './intake-review-identity-warnings.ts';
import { reviewRecordQuestions, reviewQuestionCount } from './intake-review-question-selection.ts';
import { hasIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import { selectedReportGroups } from './intake-selected-report-groups.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';
import { canonicalLiteral } from './intake-format.ts';
import { resolutionFields } from './intake-review.ts';
import { clinicalFields } from './clinical-import.ts';
import { relatedRecordIds, getIntakeRelatedRecords } from './related-records.ts';
import type { IntakeRelatedRecordsRequest } from '../shared/clinical-review.ts';
import { assertIntakeOwner } from './intake.ts';
import { visibilityState } from './visibility.ts';
import { savedDuplicateOriginalOverlap } from './duplicate-evidence-index.ts';
import {
  prepareCollectionClinicalReview,
  prepareCollectionClinicalReviewDependencies,
} from './intake-review-collection-host.ts';
import { collectionClinicalProjectionContext } from './intake-review-collection-session.ts';
import { saveIntakeReviewDraftRead, getIntakeRead, flushIntake } from './intake.ts';
import { retainedIntakeWorkflowCommand } from './intake-workflow-command.ts';
import {
  nativeDuplicateRecord,
  intakePairScope,
  intakePairPreviousDecision,
  intakePairDraftStatus,
  type IntakeOccurrenceContext,
} from './duplicate-review.ts';
import type {
  IntakeReview,
  IntakeReviewRecord,
  IntakeEvidenceComparison,
  IntakeClinicalMapping,
} from '../shared/intake.ts';
import type {
  ClinicalRecordSelection,
  ClinicalRecordSectionRequest,
  ClinicalRecordSectionReference,
  ClinicalRecordSectionControl,
  ClinicalRecordSectionPage,
  ClinicalRecordAction,
} from '../shared/intake-clinical-record-sections.ts';

function invalid() {
  return new HttpError(
    409,
    'REVIEW_SECTION_CHANGED',
    'Refresh the selected record and its exact evidence before continuing',
  );
}
function validateSelection(input: ClinicalRecordSelection) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !(input.proposalId === null || typeof input.proposalId === 'string') ||
    typeof input.recordId !== 'string' ||
    !input.recordId ||
    input.recordId.length > 2000 ||
    typeof input.candidateVersionId !== 'string' ||
    !input.candidateVersionId ||
    input.candidateVersionId.length > 2000
  )
    throw new HttpError(
      400,
      'REVIEW_RECORD_SELECTION',
      'Choose an exact record and candidate version',
    );
}
export async function openSelectedClinicalRecord(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  input: ClinicalRecordSelection,
) {
  validateSelection(input);
  await prepareCollectionClinicalReviewDependencies(
    db,
    root,
    profileId,
    intakeId,
    input.proposalId,
  );
  const result = prepareCollectionClinicalReview(db, root, profileId, intakeId, input.proposalId);
  if (result.status !== 'ready')
    throw new HttpError(
      409,
      'REVIEW_PREPARATION_REQUIRED',
      'Prepare the complete selected evidence before continuing',
    );
  const session = result.session,
    record = session.record(input.recordId, undefined, input.candidateVersionId);
  if (!record) {
    session.close();
    throw invalid();
  }
  return { session, record, review: session.review };
}
export function clinicalRecordOccurrence(
  review: IntakeReview,
  record: IntakeReviewRecord,
): IntakeOccurrenceContext | undefined {
  return record.comparisonContextHash
    ? {
        intakeId: review.intakeId,
        intakeVersion: review.version,
        proposalId: review.proposalId,
        candidateId: record.candidateId!,
        candidateVersionId: record.candidateVersionId!,
        contextHash: record.comparisonContextHash,
        locator: record.evidence[0]?.locator || 'Retained source occurrence',
        originalSourceFileId:
          decodeURIComponent(
            /^\/api\/sources\/([^/?#]+)\/content(?:[?#]|$)/.exec(
              record.evidence[0]?.contentUrl || '',
            )?.[1] || '',
          ) || review.intakeId,
      }
    : undefined;
}
/** Exact target refresh also covers retained choices outside the discovery page. */
export function selectedClinicalPair(
  db: DatabaseSync,
  review: IntakeReview,
  record: IntakeReviewRecord,
  id: string,
): IntakeEvidenceComparison | null {
  if (!record.comparisonReference) return null;
  const incoming = { ...record.comparisonReference, id: record.id, evidence: record.evidence },
    occurrence = clinicalRecordOccurrence(review, record);
  let candidate;
  try {
    candidate = nativeDuplicateRecord(db, incoming.kind, id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
  const scope = intakePairScope(db, incoming, candidate, occurrence);
  return {
    ...candidate,
    originalOverlap: savedDuplicateOriginalOverlap(
      db,
      candidate.kind,
      candidate.id,
      incoming.evidence,
    ),
    mapping: candidate.mapping as IntakeClinicalMapping,
    scope,
    previousDecision: intakePairPreviousDecision(
      db,
      incoming,
      candidate,
      scope,
      occurrence?.contextHash,
    ),
    draftScopeStatus: intakePairDraftStatus(
      db,
      incoming,
      record.draft?.decision?.comparisons?.find((choice) => choice.otherRecordId === id),
      occurrence,
      true,
    ),
  };
}
function sectionData(
  db: DatabaseSync,
  review: IntakeReview,
  record: IntakeReviewRecord,
  section: ClinicalRecordSectionRequest['section'],
  comparisonIds?: string[],
) {
  if (section === 'identityWarnings') {
    const warnings = reviewRecordIdentityWarnings(record);
    return {
      length: warnings.length,
      at(ordinal: number) {
        const warning = warnings.at(ordinal);
        return warning
          ? { value: warning, control: { kind: 'identityWarning' as const } }
          : undefined;
      },
    };
  }
  if (section === 'ownershipBlockers') {
    const reference = record.identityReview?.ownershipBlockers;
    return {
      length: reference?.count || 0,
      at(ordinal: number) {
        if (!reference) return undefined;
        const value = selectedOwnershipBlockers(reference).at(ordinal);
        return value === undefined
          ? undefined
          : { value, control: { kind: 'ownershipBlocker' as const } };
      },
    };
  }
  if (section === 'reportGroups') {
    const values = record.reportGroups,
      links = selectedReportGroups(values),
      iterator = links[Symbol.iterator]();
    let index = -1,
      current: ReturnType<typeof iterator.next> | undefined;
    return {
      length: Array.isArray(values) ? values.length : values?.count || 0,
      at(ordinal: number) {
        if (ordinal < index) throw Error('Report links require forward selected access');
        while (index < ordinal) {
          current = iterator.next();
          index++;
        }
        if (!current || current.done) return undefined;
        return {
          value: current.value,
          control: { kind: 'reportGroup' as const, ...current.value },
        };
      },
    };
  }
  if (section === 'questions') {
    const iterator = reviewRecordQuestions(record)[Symbol.iterator]();
    let index = -1,
      current: ReturnType<typeof iterator.next> | undefined;
    return {
      length: reviewQuestionCount(record),
      at(ordinal: number) {
        if (ordinal < index) throw Error('Question sections require forward access');
        while (index < ordinal) {
          current = iterator.next();
          index++;
        }
        if (!current || current.done) return undefined;
        const question = current.value,
          answer = question.answers.at(-1)?.answer;
        return {
          value: question,
          control: {
            kind: 'question' as const,
            id: question.id,
            status: question.status,
            field: question.field,
            ...(typeof answer === 'string' && Buffer.byteLength(answer) <= 2048 ? { answer } : {}),
            answerReferenced: typeof answer === 'string' && Buffer.byteLength(answer) > 2048,
            ...(question.answerHistory ? { answerHistory: question.answerHistory } : {}),
          },
        };
      },
    };
  }
  if (section === 'issues') {
    const issues = reviewIssueCollection(record);
    return {
      length: issues.length,
      at(ordinal: number) {
        const issue = issues.at(ordinal);
        if (!issue) return undefined;
        const question = issue.questionId
          ? reviewRecordQuestions(record).find((question) => question.id === issue.questionId)
          : undefined;
        return {
          value: issue,
          control: (() => {
            const value = issue.field
              ? record.mapping[issue.field as keyof IntakeClinicalMapping]
              : undefined;
            return {
              kind: 'issue',
              id: issue.id,
              issueKind: issue.kind,
              field: issue.field,
              blocking: issue.blocking,
              status: issue.status,
              ...(issue.resolution ? { outcome: issue.resolution.outcome } : {}),
              mappingKind: record.mapping.kind,
              resolutionFields: resolutionFields(issue),
              ...(typeof value === 'string' && Buffer.byteLength(value) <= 2048
                ? { fieldValue: value }
                : {}),
              fieldValueReferenced:
                value !== undefined &&
                !(typeof value === 'string' && Buffer.byteLength(value) <= 2048),
              ...(question?.answerHistory ? { questionAnswerHistory: question.answerHistory } : {}),
            } satisfies ClinicalRecordSectionControl;
          })(),
        };
      },
    };
  }
  if (section === 'mapping') {
    const editable = new Set<string>(Object.values(clinicalFields).flat());
    return [...new Set([...Object.keys(record.mapping), ...editable])].map((field) => ({
      value: Object.hasOwn(record.mapping, field)
        ? record.mapping[field as keyof IntakeClinicalMapping]
        : null,
      control: {
        kind: 'mapping',
        field: field as keyof IntakeClinicalMapping,
        editable: editable.has(field),
        present: Object.hasOwn(record.mapping, field),
      } satisfies ClinicalRecordSectionControl,
    }));
  }
  if (section !== 'comparisons' && section !== 'comparisonDrafts')
    throw new HttpError(400, 'REVIEW_SECTION', 'Choose a supported clinical review section');
  const ids =
    section === 'comparisons'
      ? comparisonIds || (record.comparisons || []).map((pair) => pair.id)
      : (record.comparisonDrafts || []).map((pair) => pair.otherRecordId);
  // Return lazy selected access; a page does not hydrate every related target.
  return ids.map((id) => {
    let loaded: IntakeEvidenceComparison | null | undefined;
    const load = () =>
      loaded === undefined ? (loaded = selectedClinicalPair(db, review, record, id)) : loaded;
    return {
      get value() {
        const pair = load();
        return {
          comparison: pair,
          decision:
            record.draft?.decision?.comparisons?.find((choice) => choice.otherRecordId === id) ||
            null,
        };
      },
      get control() {
        const pair = load(),
          choice = record.draft?.decision?.comparisons?.find((value) => value.otherRecordId === id);
        return {
          kind: 'pair',
          otherRecordId: id,
          ...(pair?.scope ? { scopeToken: pair.scope.token } : {}),
          targetAvailable: !!pair,
          ...(pair && !Array.isArray(pair.evidence) ? { savedEvidence: pair.evidence } : {}),
          draftScopeStatus:
            pair?.draftScopeStatus ||
            record.comparisonDrafts?.find((value) => value.otherRecordId === id)?.status,
          ...(choice
            ? { outcome: choice.outcome, occurrenceEvidence: choice.occurrenceEvidence }
            : {}),
          ...(choice && Buffer.byteLength(choice.reason) <= 2048 ? { reason: choice.reason } : {}),
          reasonReferenced: !!choice && Buffer.byteLength(choice.reason) > 2048,
          ...(pair?.previousDecision
            ? {
                previousDecision: {
                  outcome: pair.previousDecision.outcome,
                  attachmentStatus: pair.previousDecision.attachmentStatus,
                  scopeStatus: pair.previousDecision.scopeStatus,
                },
              }
            : {}),
        } satisfies ClinicalRecordSectionControl;
      },
    };
  });
}
function comparisonSearch(
  db: DatabaseSync,
  record: IntakeReviewRecord,
  input: Pick<ClinicalRecordSectionRequest, 'section' | 'comparisonSearch'>,
) {
  if (!input.comparisonSearch) return undefined;
  if (input.section !== 'comparisons' || !record.comparisonReference)
    throw new HttpError(
      400,
      'RELATED_RECORD_SEARCH',
      'Choose a clinical record to search related evidence',
    );
  return relatedRecordIds(
    db,
    {
      kind: record.comparisonReference.kind,
      mapping: record.mapping,
      identity: record.comparisonReference.identity,
    },
    input.comparisonSearch,
  );
}
const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');
export async function readClinicalRecordSection(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  input: ClinicalRecordSectionRequest,
): Promise<ClinicalRecordSectionPage> {
  const { session, review, record } = await openSelectedClinicalRecord(
    db,
    root,
    profileId,
    intakeId,
    input,
  );

  try {
    const limit = input.limit ?? 20,
      budget = input.bytes ?? 65536;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20 ||
      !Number.isSafeInteger(budget) ||
      budget < 4096 ||
      budget > 65536
    )
      throw new HttpError(400, 'REVIEW_WINDOW', 'Choose 1–20 items and 4096–65536 bytes');
    const binding = fingerprint([
      profileId,
      intakeId,
      review.reviewToken,
      input.proposalId,
      input.recordId,
      input.candidateVersionId,
      input.section,
      input.comparisonSearch || null,
    ]);
    const discovered = comparisonSearch(db, record, input);
    const all = sectionData(
      db,
      review,
      record,
      input.section,
      discovered?.matches.map((match) => match.id),
    );
    let ordinal = 0;
    if (input.cursor) {
      try {
        const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
        if (
          value.binding !== binding ||
          !Number.isSafeInteger(value.ordinal) ||
          value.ordinal < 0 ||
          value.ordinal >= all.length
        )
          throw invalid();
        ordinal = value.ordinal;
      } catch {
        throw invalid();
      }
    }
    const items: ClinicalRecordSectionPage['items'] = [];
    let used = 0;
    for (; ordinal < all.length && items.length < limit; ordinal++) {
      const selected = all.at(ordinal)!,
        value = selected.value,
        control = selected.control,
        size = Buffer.byteLength(canonicalLiteral(value));
      const reference: ClinicalRecordSectionReference = {
        format: 'health-clinical-record-section-reference-v1',
        proposalId: input.proposalId,
        recordId: record.id,
        candidateVersionId: input.candidateVersionId,
        reviewToken: review.reviewToken,
        section: input.section,
        ordinal,
        bytes: size,
        ...(input.comparisonSearch ? { comparisonSearch: input.comparisonSearch } : {}),
      };
      const inline = { ordinal, control, detail: { kind: 'value' as const, value } },
        ref = { ordinal, control, detail: { kind: 'reference' as const, reference } };
      const item = Buffer.byteLength(canonicalLiteral(inline)) <= budget - used ? inline : ref;
      const bytes = Buffer.byteLength(canonicalLiteral(item));
      if (items.length && used + bytes > budget) break;
      if (bytes > budget)
        throw new HttpError(
          409,
          'REVIEW_CONTROL_REQUIRED',
          'The selected action controls require a larger review window',
        );
      items.push(item);
      used += bytes;
    }
    collectionClinicalProjectionContext(session).assertCurrent();
    const { intakeId: id, proposalId, version, reviewToken, summary, sourceTextStale } = review;
    return {
      format: 'health-clinical-record-section-page-v1',
      context: { intakeId: id, proposalId, version, reviewToken, summary, sourceTextStale },
      selection: {
        proposalId,
        recordId: record.id,
        candidateVersionId: input.candidateVersionId,
        selectionReviewToken: record.selectionReviewToken,
      },
      section: input.section,
      total: all.length,
      items,
      ...(discovered ? { discoveryPage: discovered.page } : {}),
      nextCursor:
        ordinal < all.length
          ? Buffer.from(JSON.stringify({ binding, ordinal })).toString('base64url')
          : null,
    };
  } finally {
    session.close();
  }
}
export async function readClinicalRecordSectionFragment(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  input: { reference: ClinicalRecordSectionReference; offset?: number; bytes?: number },
) {
  const { reference } = input,
    offset = input.offset ?? 0,
    bytes = input.bytes ?? 32768;
  if (
    !reference ||
    reference.format !== 'health-clinical-record-section-reference-v1' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > 65536
  )
    throw invalid();
  const { session, record, review } = await openSelectedClinicalRecord(
    db,
    root,
    profileId,
    intakeId,
    reference,
  );

  try {
    if (reference.reviewToken !== review.reviewToken) throw invalid();
    const discovered = comparisonSearch(db, record, reference);
    const values = sectionData(
      db,
      review,
      record,
      reference.section,
      discovered?.matches.map((match) => match.id),
    );
    if (
      !Number.isSafeInteger(reference.ordinal) ||
      reference.ordinal < 0 ||
      reference.ordinal >= values.length
    )
      throw invalid();
    const raw = Buffer.from(canonicalLiteral(values.at(reference.ordinal)!.value));
    if (raw.length !== reference.bytes || offset > raw.length) throw invalid();
    collectionClinicalProjectionContext(session).assertCurrent();
    const end = Math.min(raw.length, offset + bytes);
    return {
      encoding: 'base64' as const,
      data: raw.subarray(offset, end).toString('base64'),
      totalBytes: raw.length,
      complete: end === raw.length,
      nextOffset: end === raw.length ? null : end,
    };
  } finally {
    session.close();
  }
}
export async function applyClinicalRecordAction(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  input: ClinicalRecordAction,
) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          'proposalId',
          'recordId',
          'candidateVersionId',
          'version',
          'operationId',
          'reviewToken',
          'patch',
          'pair',
          'clearMissingPair',
        ].includes(key),
    ) ||
    (input.patch !== undefined &&
      (!input.patch ||
        typeof input.patch !== 'object' ||
        Array.isArray(input.patch) ||
        Object.keys(input.patch).some(
          (key) =>
            !['mapping', 'resolutions', 'correctionReason', 'correctionPatch', 'answers'].includes(
              key,
            ),
        )))
  )
    throw new HttpError(400, 'REVIEW_RECORD_ACTION', 'Supply a supported sparse record action');
  assertIntakeOwner(db, profileId);
  validateSelection(input);
  if (
    typeof input.operationId !== 'string' ||
    !input.operationId.trim() ||
    input.operationId.length > 200
  )
    throw new HttpError(400, 'OPERATION_ID', 'A stable review operation ID is required');
  const request = { format: 'health-intake-clinical-record-action-v1', ...input };
  if (
    retainedIntakeWorkflowCommand(db, { id: intakeId }, { operationId: input.operationId, request })
  )
    return {
      ...getIntakeRead(db, root, profileId, intakeId),
      durability: flushIntake(db, root, profileId),
    };
  const { session, record, review } = await openSelectedClinicalRecord(
    db,
    root,
    profileId,
    intakeId,
    input,
  );

  try {
    if (input.version !== review.version || input.reviewToken !== review.reviewToken)
      throw invalid();
    if (input.pair && input.clearMissingPair)
      throw new HttpError(400, 'REVIEW_PAIR_ACTION', 'Choose one pair action');
    let decision = record.draft?.decision;
    if (input.pair || input.clearMissingPair) {
      const id = input.pair?.otherRecordId || input.clearMissingPair!;
      const selected = selectedClinicalPair(db, review, record, id);
      const previous = decision?.comparisons || [];
      const comparisons = previous.filter((choice) => choice.otherRecordId !== id);
      if (input.pair) {
        if (!selected?.scope || selected.scope.token !== input.pair.scopeToken) throw invalid();
        const { scopeToken: _token, ...choice } = input.pair;
        comparisons.push({ ...choice, scope: selected.scope });
      } else {
        const retained = previous.find((choice) => choice.otherRecordId === id);
        if (
          selected ||
          !retained ||
          (retained.scope?.format === 'intake-pair-scope-v2' && retained.scope.activeAttachment)
        )
          throw new HttpError(
            409,
            'REVIEW_PAIR_PRESENT',
            'Refresh and review this target before changing the retained relationship',
          );
      }
      decision = {
        ...decision,
        recordId: record.id,
        action: decision?.action || 'accept',
        mapping: decision?.mapping || {},
        comparisons,
      };
    }
    collectionClinicalProjectionContext(session).assertCurrent();
    const patch = input.patch?.correctionPatch
      ? {
          ...input.patch,
          correctionPatch: Object.fromEntries(
            Object.entries(input.patch.correctionPatch).filter(
              ([field, value]) =>
                canonicalLiteral(value) !==
                canonicalLiteral(record.mapping[field as keyof IntakeClinicalMapping]),
            ),
          ),
        }
      : input.patch;
    return await saveIntakeReviewDraftRead(
      db,
      root,
      profileId,
      intakeId,
      {
        version: input.version,
        operationId: input.operationId,
        proposalId: input.proposalId,
        recordId: input.recordId,
        candidateVersionId: input.candidateVersionId,
        ...patch,
        ...(decision && (input.pair || input.clearMissingPair) ? { decision } : {}),
      },
      { request },
    );
  } finally {
    session.close();
  }
}

/** Preserve the legacy route until this source activates native collection authority. */
export async function getIntakeRelatedRecordsRead(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  input: IntakeRelatedRecordsRequest,
) {
  assertIntakeOwner(db, profileId);
  const source = db
    .prepare("SELECT * FROM source_files WHERE id=? AND kind='intake_original'")
    .get(intakeId);
  if (!source) throw new HttpError(404, 'INTAKE_NOT_FOUND', 'Source intake not found');
  if (!hasIntakeCollectionEnvelope(db, { id: intakeId }))
    return getIntakeRelatedRecords(db, root, profileId, intakeId, input);
  validateSelection(input);
  if (visibilityState(db, 'source_file', intakeId).archived) throw invalid();
  if (
    Object.keys(input).some(
      (key) =>
        !['proposalId', 'recordId', 'candidateVersionId', 'query', 'cursor', 'limit'].includes(key),
    )
  )
    throw new HttpError(
      400,
      'RELATED_RECORD_SEARCH',
      'Supply the exact pending candidate and search',
    );
  return readClinicalRecordSection(db, root, profileId, intakeId, {
    proposalId: input.proposalId,
    recordId: input.recordId,
    candidateVersionId: input.candidateVersionId,
    section: 'comparisons',
    limit: Math.min(input.limit ?? 20, 20),
    comparisonSearch: { query: input.query, cursor: input.cursor, limit: input.limit ?? 20 },
  });
}
