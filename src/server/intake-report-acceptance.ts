import {
  acceptPartialSelection,
  acceptPartialSelectionAsync,
  getPartialAcceptance,
  hasPartialAcceptance,
} from './intake-partial-acceptance.ts';
import { durableSelectionInputs } from './intake-selection-authority.ts';
import { measureImportPhase } from './import-diagnostics.ts';
import { createHash } from 'node:crypto';
import { HttpError, now } from './database.ts';
import { canonicalLiteral } from './intake-format.ts';
import { personalDurabilityStatus } from './portable.ts';
import {
  flushIntake,
  getIntake,
  intakeTransaction,
  listIntakes,
  prepareIntakeImport,
  reviewIntake,
} from './intake.ts';
import type { DatabaseSync } from 'node:sqlite';
import type {
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceReceipt,
  IntakeAtomicAcceptanceReceipt,
  IntakeReportAcceptanceResult,
  IntakeReview,
  IntakeWorkflow,
} from '../shared/intake.ts';
import {
  duplicateRecord,
  intakePairScope,
  refreshOccurrenceAttachmentAuthorities,
  type OccurrenceAuthorityFinalizer,
} from './duplicate-review.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= 2000;
function request(value: unknown): IntakeReportAcceptanceRequest {
  if (
    !object(value) ||
    (value.mode !== undefined && value.mode !== 'partial-v1') ||
    typeof value.operationId !== 'string' ||
    !uuid.test(value.operationId) ||
    !Array.isArray(value.blocks) ||
    !value.blocks.length ||
    value.blocks.length > 100
  )
    throw new HttpError(
      400,
      'REPORT_ACCEPTANCE_INPUT',
      'Supply a stable UUID and 1–100 explicitly selected proposal blocks',
    );
  let count = 0;
  const blocks = new Set<string>(),
    candidates = new Set<string>();
  for (const block of value.blocks) {
    if (
      !object(block) ||
      !text(block.intakeId) ||
      !(block.proposalId === null || text(block.proposalId)) ||
      !Number.isSafeInteger(block.intakeVersion) ||
      (block.intakeVersion as number) < 1 ||
      !text(block.reviewToken) ||
      !Array.isArray(block.selections) ||
      !block.selections.length
    )
      throw new HttpError(
        400,
        'REPORT_ACCEPTANCE_INPUT',
        'Each selected block needs exact source, proposal, version, review token and records',
      );
    const key = JSON.stringify([block.intakeId, block.proposalId]);
    if (blocks.has(key))
      throw new HttpError(
        400,
        'REPORT_ACCEPTANCE_INPUT',
        'Combine selections from the same proposal into one block',
      );
    blocks.add(key);
    for (const selection of block.selections) {
      if (
        ++count > 1000 ||
        !object(selection) ||
        !text(selection.recordId) ||
        (value.mode === 'partial-v1' && !text(selection.selectionReviewToken)) ||
        !text(selection.candidateId) ||
        !text(selection.candidateVersionId) ||
        !object(selection.mapping) ||
        (selection.comparisons !== undefined && !Array.isArray(selection.comparisons)) ||
        Object.keys(selection).some(
          (key) =>
            ![
              'recordId',
              'candidateId',
              'candidateVersionId',
              'mapping',
              'comparisons',
              'selectionReviewToken',
            ].includes(key),
        )
      )
        throw new HttpError(
          400,
          'REPORT_ACCEPTANCE_INPUT',
          'Select at most 1000 exact candidate versions per operation with explicit reviewed mappings. Split larger approvals into sequential operations.',
        );
      const identity = JSON.stringify([block.intakeId, selection.candidateId]);
      if (candidates.has(identity))
        throw new HttpError(
          400,
          'REPORT_ACCEPTANCE_INPUT',
          'A candidate may be selected only once in this operation',
        );
      candidates.add(identity);
    }
  }
  // Retain the caller's exact reviewed request independently of later object mutation.
  return structuredClone(value) as unknown as IntakeReportAcceptanceRequest;
}
export function acceptanceOwner(db: DatabaseSync, profileId: string): void {
  listIntakes(db, profileId, { limit: 1 });
  const durability = personalDurabilityStatus(db);
  if (durability.conflicted || (durability.dirty && durability.lastError))
    throw new HttpError(
      409,
      'REPORT_ACCEPTANCE_RECOVERY_REQUIRED',
      'Reopen this profile to recover durable acceptance history before checking or retrying this operation',
    );
}
function retained(
  db: DatabaseSync,
  operationId: string,
): { fingerprint: string; receipt: IntakeReportAcceptanceReceipt } | null {
  const row = db
    .prepare(
      "SELECT operation.value AS operation FROM source_files f, json_each(f.details_json,'$.intake.workflow.reportAcceptances') operation WHERE f.kind='intake_original' AND json_extract(operation.value,'$.receipt.operationId')=? LIMIT 1",
    )
    .get(operationId) as { operation: string } | undefined;
  return row
    ? (JSON.parse(row.operation) as { fingerprint: string; receipt: IntakeReportAcceptanceReceipt })
    : null;
}
export function getIntakeReportAcceptance(
  db: DatabaseSync,
  root: string,
  profileId: string,
  operationId: string,
): IntakeReportAcceptanceResult {
  acceptanceOwner(db, profileId);
  if (!uuid.test(operationId))
    throw new HttpError(400, 'REPORT_ACCEPTANCE_INPUT', 'Supply the acceptance operation UUID');
  const partial = getPartialAcceptance(db, root, profileId, operationId);
  if (partial) return partial;
  const saved = retained(db, operationId);
  if (!saved)
    throw new HttpError(404, 'REPORT_ACCEPTANCE_NOT_FOUND', 'Acceptance operation not found');
  return { receipt: saved.receipt, replayed: true, durability: flushIntake(db, root, profileId) };
}
export function acceptIntakeReportSelection(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: unknown,
): IntakeReportAcceptanceResult {
  return measureImportPhase(
    'review_acceptance',
    () => acceptIntakeReportSelectionInternal(db, root, profileId, input),
    {},
    { profileId },
  );
}
/** HTTP partial saves yield between bounded transactions so reads remain responsive. */
export async function acceptIntakeReportSelectionAsync(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: unknown,
): Promise<IntakeReportAcceptanceResult> {
  acceptanceOwner(db, profileId);
  const selected = request(input);
  if (selected.mode !== 'partial-v1')
    return acceptIntakeReportSelection(db, root, profileId, selected);
  if (retained(db, selected.operationId))
    throw new HttpError(
      409,
      'OPERATION_CONFLICT',
      'Operation ID already belongs to a different acceptance mode.',
    );
  const fingerprint = createHash('sha256').update(canonicalLiteral(selected)).digest('hex');
  return acceptPartialSelectionAsync(db, root, profileId, selected, fingerprint);
}
function acceptIntakeReportSelectionInternal(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: unknown,
): IntakeReportAcceptanceResult {
  acceptanceOwner(db, profileId);
  const selected = request(input),
    fingerprint = createHash('sha256').update(canonicalLiteral(selected)).digest('hex');
  const previous = retained(db, selected.operationId);
  if (
    (selected.mode === 'partial-v1' && previous) ||
    (selected.mode !== 'partial-v1' && hasPartialAcceptance(db, selected.operationId))
  )
    throw new HttpError(
      409,
      'OPERATION_CONFLICT',
      'Operation ID already belongs to a different acceptance mode.',
    );
  if (selected.mode === 'partial-v1')
    return acceptPartialSelection(db, root, profileId, selected, fingerprint);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'Acceptance operation ID already belongs to a different selection',
      );
    return {
      receipt: previous.receipt,
      replayed: true,
      durability: flushIntake(db, root, profileId),
    };
  }
  return applyAcceptanceGroup(db, root, profileId, selected, fingerprint);
}

export function applyAcceptanceGroup(
  db: DatabaseSync,
  root: string,
  profileId: string,
  selected: IntakeReportAcceptanceRequest,
  fingerprint: string,
  retainResult?: (receipt: IntakeAtomicAcceptanceReceipt) => void,
  reviewed?: Map<string, IntakeReview | null>,
): IntakeReportAcceptanceResult {
  const receipt = measureImportPhase(
    'review_acceptance_transaction',
    () =>
      intakeTransaction(
        db,
        () => {
          // Bound retained proposal memory before preparing every block at once.
          let reviewBytes = 0;
          for (const block of selected.blocks) {
            const original = getIntake(db, root, profileId, block.intakeId);
            if (
              block.proposalId &&
              !original.proposals.some((proposal) => proposal.id === block.proposalId)
            )
              throw new HttpError(404, 'NOT_FOUND', 'Proposal does not belong to this delivery');
            const inputFile = db
              .prepare('SELECT bytes FROM source_files WHERE id=?')
              .get(block.proposalId || block.intakeId) as { bytes: number } | undefined;
            reviewBytes += inputFile?.bytes || 0;
            if (reviewBytes > 64 * 1024 * 1024)
              throw new HttpError(
                413,
                'REPORT_ACCEPTANCE_LIMIT',
                'Select proposal blocks totaling at most 64 MiB per atomic acceptance',
              );
          }
          // All tokens and mappings are prepared against one unchanged profile revision.
          const prepared = selected.blocks.map((block) => {
            const intake = getIntake(db, root, profileId, block.intakeId);
            if (intake.archived)
              throw new HttpError(
                409,
                'REPORT_ACCEPTANCE_STALE',
                'This source has been removed from review',
              );
            const candidates = new Map(intake.workflow?.candidates.map((item) => [item.id, item]));
            for (const selection of block.selections) {
              const candidate = candidates.get(selection.candidateId),
                version = candidate?.versions.at(-1);
              if (
                !version ||
                version.id !== selection.candidateVersionId ||
                version.status !== 'pending' ||
                version.sourceContext ||
                !version.occurrences.some(
                  (occurrence) =>
                    occurrence.recordId === selection.recordId &&
                    occurrence.proposalId === block.proposalId,
                )
              )
                throw new HttpError(
                  409,
                  'REPORT_ACCEPTANCE_STALE',
                  'Select the current pending candidate version from its exact retained proposal',
                );
            }
            const pair = canonicalLiteral([block.intakeId, block.proposalId]);
            if (retainResult && reviewed?.has(pair) && reviewed.get(pair) === null)
              throw new HttpError(
                409,
                'SELECTION_REVIEW_CHANGED',
                'This selection could not be reviewed. Refresh its exact record before saving.',
              );
            const fresh = retainResult
              ? (reviewed?.get(pair) ??
                reviewIntake(db, root, profileId, block.intakeId, block.proposalId))
              : null;
            const comparisons = new Map<string, (typeof block.selections)[number]['comparisons']>();
            if (fresh) {
              const freshRecords = new Map(fresh.records.map((item) => [item.id, item]));
              for (const selection of block.selections) {
                const record = freshRecords.get(selection.recordId);
                if (!record || record.selectionReviewToken !== selection.selectionReviewToken)
                  throw new HttpError(
                    409,
                    'SELECTION_REVIEW_CHANGED',
                    'This record or its source/person dependencies changed. Review this exact record again.',
                  );
                comparisons.set(
                  selection.recordId,
                  selection.comparisons?.map((decision) => {
                    // Discovery is paginated and searchable, not an authority list.
                    // Resolve the exact reviewed target even when it is off this page.
                    const incoming = record.comparisonReference;
                    const current = incoming
                      ? intakePairScope(
                          db,
                          { ...incoming, id: record.id, evidence: record.evidence },
                          duplicateRecord(db, incoming.kind, decision.otherRecordId),
                          record.comparisonContextHash
                            ? {
                                intakeVersion: fresh.version,
                                contextHash: record.comparisonContextHash,
                              }
                            : undefined,
                        )
                      : undefined;
                    if (
                      !current ||
                      canonicalLiteral(durableSelectionInputs(decision.scope)) !==
                        canonicalLiteral(durableSelectionInputs(current))
                    )
                      throw new HttpError(
                        409,
                        'DUPLICATE_SCOPE_CHANGED',
                        'Compare the changed destination record again.',
                      );
                    return { ...decision, scope: current };
                  }),
                );
              }
            }
            const result = prepareIntakeImport(
              db,
              root,
              profileId,
              block.intakeId,
              {
                version: retainResult ? intake.version : block.intakeVersion,
                proposalId: block.proposalId,
                reviewToken: fresh?.reviewToken ?? block.reviewToken,
                decisions: block.selections.map((selection) => ({
                  recordId: selection.recordId,
                  action: 'accept',
                  mapping: selection.mapping,
                  comparisons: fresh ? comparisons.get(selection.recordId) : selection.comparisons,
                })),
              },
              fresh || undefined,
            );
            const resultRecords = new Map(result.review?.records.map((item) => [item.id, item]));
            for (const selection of block.selections) {
              const record = resultRecords.get(selection.recordId);
              // Preparation validates blockers against the user's exact mappings and
              // comparison decisions. Rechecking the pre-correction classification or
              // questions here would reject valid corrections and relationship choices.
              // Application still validates clinical semantics inside this transaction.
              if (
                record?.candidateId !== selection.candidateId ||
                record?.candidateVersionId !== selection.candidateVersionId
              )
                throw new HttpError(
                  409,
                  'REPORT_ACCEPTANCE_BLOCKED',
                  'Resolve each selected record before accepting; unselected records stay unchanged',
                );
            }
            return { result, version: intake.version };
          });
          const versions = new Map<string, number>(),
            receipts: IntakeReportAcceptanceReceipt['receipts'] = [],
            occurrenceAuthorityFinalizers: OccurrenceAuthorityFinalizer[] = [];
          for (const [index, block] of selected.blocks.entries()) {
            const before = versions.get(block.intakeId) ?? prepared[index]!.version;
            const applied = measureImportPhase(
              'review_acceptance_apply',
              () => prepared[index]!.result.apply(before, occurrenceAuthorityFinalizers),
              { selectedCount: block.selections.length },
              { profileId, importId: block.intakeId },
            );
            versions.set(block.intakeId, applied.intakeVersion);
            const importedRecords = new Map(
              applied.imported.clinical?.records?.map((record) => [record.recordId, record]),
            );
            const records = block.selections.map((selection) => {
              const accepted = importedRecords.get(selection.recordId);
              if (!accepted)
                throw new Error('Selected acceptance did not produce an exact clinical receipt');
              return {
                ...accepted,
                candidateId: selection.candidateId,
                candidateVersionId: selection.candidateVersionId,
              };
            });
            receipts.push({
              intakeId: block.intakeId,
              proposalId: block.proposalId,
              intakeVersionBefore: before,
              intakeVersionAfter: applied.intakeVersion,
              reviewToken: block.reviewToken,
              records,
            });
          }
          refreshOccurrenceAttachmentAuthorities(db, occurrenceAuthorityFinalizers);
          const count = selected.blocks.reduce((sum, block) => sum + block.selections.length, 0);
          const result: IntakeAtomicAcceptanceReceipt = {
            operationId: selected.operationId,
            status: 'accepted',
            atomic: true,
            at: now(),
            selectedCount: count,
            acceptedCount: receipts.reduce((sum, receipt) => sum + receipt.records.length, 0),
            receipts,
          };
          if (retainResult) {
            retainResult(result);
            return result;
          }
          const coordinator = selected.blocks[0]!.intakeId;
          const row = db
            .prepare('SELECT details_json FROM source_files WHERE id=?')
            .get(coordinator) as { details_json: string };
          const details = JSON.parse(row.details_json) as { intake: { workflow: IntakeWorkflow } };
          (details.intake.workflow.reportAcceptances ||= []).push({ fingerprint, receipt: result });
          db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
            JSON.stringify(details),
            coordinator,
          );
          return result;
        },
        { operationId: selected.operationId, fingerprint },
      ),
    { selectedCount: selected.blocks.reduce((n, b) => n + b.selections.length, 0) },
    { profileId },
  );
  return { receipt, replayed: false, durability: flushIntake(db, root, profileId) };
}
