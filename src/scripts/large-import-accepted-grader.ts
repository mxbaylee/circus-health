import type { Observation, Medication, Procedure } from '../shared/api.ts';
import type {
  IntakeClinicalMapping,
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceReceipt,
  IntakeReview,
  IntakeReviewRecord,
} from '../shared/intake.ts';
import type { IntakeIdentityPerson } from '../shared/intake-identity.ts';
import type { LargeImportOracle } from './large-import-fixture.ts';
import { acceptedQualificationRecord } from './provider-qualification-acceptance.ts';
import { exactLargeImportPages, largeImportFieldMismatches } from './large-import-review-grader.ts';

export type LargeImportAcceptedEntity =
  | { kind: 'observation'; record: Observation }
  | { kind: 'medication'; record: Medication }
  | { kind: 'procedure'; record: Procedure };
export interface LargeImportAcceptedInput {
  oracle: LargeImportOracle;
  originalId: string;
  people: Readonly<Record<string, IntakeIdentityPerson>>;
  records: readonly LargeImportAcceptedEntity[];
  /** Fresh snapshots and the exact submitted requests, captured before acceptance. */
  transactions: readonly {
    request: IntakeReportAcceptanceRequest;
    reviews: readonly IntakeReview[];
    receipt: IntakeReportAcceptanceReceipt;
  }[];
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const label = (mapping: IntakeClinicalMapping) =>
  mapping.kind === 'observation'
    ? mapping.testLabel
    : mapping.kind === 'medication'
      ? mapping.medicationName
      : mapping.procedureLabel;
const selectionKey = (
  intake: string,
  proposal: string | null,
  record: string,
  candidate: string,
  version: string,
) => JSON.stringify([intake, proposal, record, candidate, version]);

/** Current accepted responses and receipts are observations, never acceptance authority.
 * The result contains only fixture keys, counts and fixed mismatch categories. */
export function gradeLargeImportAccepted(input: LargeImportAcceptedInput) {
  const { oracle, originalId } = input;
  if (
    oracle.format !== 'circus-fictional-large-import-oracle-v1' ||
    oracle.pages !== 900 ||
    oracle.assertions.length !== 901 ||
    oracle.people.length !== 2 ||
    oracle.reports.length !== 6 ||
    new Set(oracle.assertions.map((item) => item.key)).size !== 901
  )
    throw Error('Unsupported or invalid fictional large-import oracle');
  const authorityIssues = new Set<string>();
  if (!originalId) authorityIssues.add('originalBinding');
  const personIds = new Set<string>();
  const noteIds = new Set<string>();
  for (const person of oracle.people) {
    const bound = Object.hasOwn(input.people, person.key) ? input.people[person.key] : undefined;
    if (
      !bound ||
      !bound.personId ||
      !bound.noteId ||
      !Number.isSafeInteger(bound.version) ||
      bound.version < 1 ||
      bound.fullName !== person.name ||
      bound.birthDate !== person.birthDate ||
      personIds.has(bound.personId) ||
      noteIds.has(bound.noteId) ||
      (person.key === oracle.people[0]!.key &&
        (bound.personId !== 'patient' || bound.noteId !== 'person-note:self'))
    )
      authorityIssues.add('peopleBinding');
    if (bound) {
      personIds.add(bound.personId);
      noteIds.add(bound.noteId);
    }
  }
  if (Object.keys(input.people).some((key) => !oracle.people.some((person) => person.key === key)))
    authorityIssues.add('peopleBinding');
  const expectedByLabel = new Map(oracle.assertions.map((item) => [label(item.mapping), item]));
  const entities = new Map<string, LargeImportAcceptedEntity>();
  const occurrences = new Map<string, number>();
  const invalid = new Set<string>();
  let unexpectedRecords = 0,
    duplicateEntities = 0;
  const mismatches: Array<{
    key: string;
    retained: string[];
    public: string[];
    provenance: string[];
    ownership: string[];
  }> = [];
  for (const entity of input.records) {
    const { kind, record } = entity;
    if (!record.id || entities.has(record.id)) duplicateEntities++;
    else entities.set(record.id, entity);
    const imported = object(object(record.extra).import);
    const retained = object(imported.acceptedMapping) as IntakeClinicalMapping;
    // Public labels bind assertions; a retained correct label cannot hide a wrong projection.
    const expected = expectedByLabel.get(record.label);
    if (!expected) {
      unexpectedRecords++;
      continue;
    }
    occurrences.set(expected.key, (occurrences.get(expected.key) ?? 0) + 1);
    const retainedFields = largeImportFieldMismatches(
      { kind, mapping: retained },
      expected,
      originalId,
    );
    const adapted = acceptedQualificationRecord(kind, record);
    const publicFields = largeImportFieldMismatches(
      { kind, mapping: adapted.mapping },
      expected,
      originalId,
    );
    if (kind === 'observation') {
      const observed = record as Observation;
      const numeric = /^([<>]=?|=)?([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/.exec(
        expected.mapping.valueText ?? '',
      );
      if (!numeric || observed.value !== Number(numeric[2])) publicFields.push('numericValue');
      if (!numeric || observed.comparator !== (numeric[1] ?? null)) publicFields.push('comparator');
      const date = expected.mapping.date;
      const precision = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? 'day' : undefined;
      if (!precision || observed.datePrecision !== precision) publicFields.push('datePrecision');
    }
    const evidencePages = new Set<number>();
    const evidenceKeys = new Set<string>();
    const provenance = new Set<string>();
    if (!record.sourceRecordId || !record.evidence?.length) provenance.add('sourceEvidence');
    for (const evidence of record.evidence ?? []) {
      const key = JSON.stringify([evidence.sourceRecordId, evidence.role, evidence.locator]);
      if (evidenceKeys.has(key)) provenance.add('duplicateEvidence');
      evidenceKeys.add(key);
      const locator = object(evidence.locator);
      if (evidence.sourceRecordId !== record.sourceRecordId) provenance.add('sourceLinkage');
      const pages = exactLargeImportPages(
        {
          label: 'Original source',
          locator: typeof locator.locator === 'string' ? locator.locator : '',
          ...(typeof locator.originalSourceFileId === 'string'
            ? {
                contentUrl: `/api/sources/${encodeURIComponent(locator.originalSourceFileId)}/content`,
              }
            : {}),
        },
        originalId,
      );
      if (!pages) provenance.add('originalEvidence');
      else
        for (const page of pages) {
          if (evidencePages.has(page)) provenance.add('duplicateEvidence');
          evidencePages.add(page);
        }
    }
    if (
      expected.pages.some((page) => !evidencePages.has(page)) ||
      [...evidencePages].some((page) => !expected.pages.includes(page))
    )
      provenance.add('originalPages');
    const ownership: string[] = [];
    if (!record.personId || record.personId !== input.people[expected.personKey]?.personId)
      ownership.push('publicOwner');
    // Current accepted mappings may omit Self's personId. Populated assignments
    // are evidence too and must never contradict the current public owner/binding.
    const expectedOwner = input.people[expected.personKey]?.personId;
    if (
      (retained.personId && retained.personId !== expectedOwner) ||
      (retained.subject && retained.subject !== (expectedOwner === 'patient' ? 'self' : 'other'))
    )
      ownership.push('retainedOwner');
    if (retainedFields.length || publicFields.length || provenance.size || ownership.length) {
      invalid.add(expected.key);
      mismatches.push({
        key: expected.key,
        retained: retainedFields,
        public: publicFields,
        provenance: [...provenance],
        ownership,
      });
    }
  }
  const receiptIssues = new Set<string>();
  const receiptEntities = new Set<string>();
  const selectedOccurrences = new Set<string>();
  const operations = new Set<string>();
  let selectedRecords = 0,
    receiptedRecords = 0;
  for (const transaction of input.transactions) {
    const { request, receipt, reviews } = transaction;
    const reviewsByBlock = new Map<
      string,
      { review: IntakeReview; records: Map<string, IntakeReviewRecord> }
    >();
    for (const review of reviews) {
      const key = JSON.stringify([review.intakeId, review.proposalId]);
      if (reviewsByBlock.has(key)) receiptIssues.add('selectionScope');
      const records = new Map<string, IntakeReviewRecord>();
      for (const record of review.records) {
        const occurrence = selectionKey(
          review.intakeId,
          review.proposalId,
          record.id,
          record.candidateId ?? '',
          record.candidateVersionId ?? '',
        );
        if (records.has(occurrence)) receiptIssues.add('selectionScope');
        records.set(occurrence, record);
      }
      reviewsByBlock.set(key, { review, records });
    }
    if (!request.operationId || operations.has(request.operationId)) receiptIssues.add('operation');
    operations.add(request.operationId);
    if (
      receipt.operationId !== request.operationId ||
      receipt.status !== 'accepted' ||
      !receipt.atomic ||
      request.mode
    )
      receiptIssues.add('operation');
    const selected = new Map<string, { kind: string; label: string | undefined }>();
    const blocks = new Map<string, (typeof request.blocks)[number]>();
    for (const block of request.blocks) {
      const blockKey = JSON.stringify([block.intakeId, block.proposalId]);
      if (blocks.has(blockKey) || block.intakeId !== originalId)
        receiptIssues.add('selectionScope');
      blocks.set(blockKey, block);
      const snapshot = reviewsByBlock.get(blockKey);
      const review = snapshot?.review;
      if (
        !review ||
        review.version !== block.intakeVersion ||
        review.reviewToken !== block.reviewToken
      )
        receiptIssues.add('selectionScope');
      for (const selection of block.selections) {
        selectedRecords++;
        const key = selectionKey(
          block.intakeId,
          block.proposalId,
          selection.recordId,
          selection.candidateId,
          selection.candidateVersionId,
        );
        if (selectedOccurrences.has(key)) receiptIssues.add('duplicateSelection');
        selectedOccurrences.add(key);
        const candidate = snapshot?.records.get(key);
        if (
          !candidate ||
          !selection.recordId ||
          !selection.candidateId ||
          !selection.candidateVersionId ||
          Object.keys(selection.mapping).length ||
          candidate.issues?.some((issue) => issue.blocking && issue.status === 'unresolved') ||
          candidate.identityReview?.blocking
        )
          receiptIssues.add('selectionScope');
        selected.set(key, {
          kind: candidate?.kind ?? '',
          label: candidate ? label(candidate.mapping) : undefined,
        });
      }
    }
    const received = new Set<string>();
    const receivedBlocks = new Set<string>();
    let count = 0;
    for (const part of receipt.receipts) {
      const blockKey = JSON.stringify([part.intakeId, part.proposalId]);
      const block = blocks.get(blockKey);
      if (
        receivedBlocks.has(blockKey) ||
        !block ||
        part.intakeId !== originalId ||
        part.intakeVersionBefore !== block.intakeVersion ||
        part.reviewToken !== block.reviewToken ||
        !Number.isSafeInteger(part.intakeVersionAfter) ||
        part.intakeVersionAfter <= part.intakeVersionBefore
      )
        receiptIssues.add('receiptScope');
      receivedBlocks.add(blockKey);
      for (const accepted of part.records) {
        count++;
        receiptedRecords++;
        const key = selectionKey(
          part.intakeId,
          part.proposalId,
          accepted.recordId,
          accepted.candidateId,
          accepted.candidateVersionId,
        );
        const selection = selected.get(key);
        if (!selection || received.has(key)) receiptIssues.add('receiptSelection');
        received.add(key);
        const entity = entities.get(accepted.entityId);
        if (!accepted.entityId || receiptEntities.has(accepted.entityId))
          receiptIssues.add('duplicateEntity');
        receiptEntities.add(accepted.entityId);
        if (accepted.outcome !== 'added') receiptIssues.add('outcome');
        if (!entity) receiptIssues.add('missingEntity');
        else if (
          entity.kind !== accepted.kind ||
          selection?.kind !== accepted.kind ||
          entity.record.label !== selection?.label
        )
          receiptIssues.add('entityBinding');
      }
    }
    const expectedCount = request.blocks.reduce((sum, block) => sum + block.selections.length, 0);
    if (
      !expectedCount ||
      receipt.selectedCount !== expectedCount ||
      receipt.acceptedCount !== expectedCount ||
      count !== expectedCount ||
      received.size !== selected.size
    )
      receiptIssues.add('count');
    if (
      [...selected.keys()].some((key) => !received.has(key)) ||
      [...blocks.keys()].some((key) => !receivedBlocks.has(key))
    )
      receiptIssues.add('missingSelection');
  }
  if (
    entities.size !== receiptEntities.size ||
    [...entities.keys()].some((id) => !receiptEntities.has(id))
  )
    receiptIssues.add('unreceiptedEntity');
  const missing = oracle.assertions
    .filter((item) => !occurrences.has(item.key))
    .map((item) => item.key);
  const duplicate = [...occurrences].filter(([, count]) => count > 1).map(([key]) => key);
  const exactRecords = oracle.assertions.filter(
    (item) => occurrences.get(item.key) === 1 && !invalid.has(item.key),
  ).length;
  const observedRecordsPassed =
    !authorityIssues.size &&
    !invalid.size &&
    !duplicate.length &&
    !duplicateEntities &&
    !unexpectedRecords;
  const receiptsPassed = !receiptIssues.size && input.transactions.length > 0;
  return {
    format: 'circus-large-import-accepted-grade-v1' as const,
    passed: observedRecordsPassed && receiptsPassed && !missing.length,
    observedRecordsPassed,
    receiptsPassed,
    expectedRecords: oracle.assertions.length,
    observedRecords: input.records.length,
    exactRecords,
    selectedRecords,
    receiptedRecords,
    missing,
    duplicate,
    unexpectedRecords,
    duplicateEntities,
    authorityIssues: [...authorityIssues],
    receiptIssues: [...receiptIssues],
    mismatches,
  };
}
