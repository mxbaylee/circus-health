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
} from './intake.ts';
import type { DatabaseSync } from 'node:sqlite';
import type {
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceReceipt,
  IntakeReportAcceptanceResult,
  IntakeWorkflow,
} from '../shared/intake.ts';
import {
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
        !text(selection.candidateId) ||
        !text(selection.candidateVersionId) ||
        !object(selection.mapping) ||
        (selection.comparisons !== undefined && !Array.isArray(selection.comparisons)) ||
        Object.keys(selection).some(
          (key) =>
            !['recordId', 'candidateId', 'candidateVersionId', 'mapping', 'comparisons'].includes(
              key,
            ),
        )
      )
        throw new HttpError(
          400,
          'REPORT_ACCEPTANCE_INPUT',
          'Select at most 1000 exact candidate versions with explicit reviewed mappings',
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
function owner(db: DatabaseSync, profileId: string): void {
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
  owner(db, profileId);
  if (!uuid.test(operationId))
    throw new HttpError(400, 'REPORT_ACCEPTANCE_INPUT', 'Supply the acceptance operation UUID');
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
function acceptIntakeReportSelectionInternal(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: unknown,
): IntakeReportAcceptanceResult {
  owner(db, profileId);
  const selected = request(input),
    fingerprint = createHash('sha256').update(canonicalLiteral(selected)).digest('hex');
  const previous = retained(db, selected.operationId);
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
            for (const selection of block.selections) {
              const candidate = intake.workflow?.candidates.find(
                  (item) => item.id === selection.candidateId,
                ),
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
            const result = prepareIntakeImport(db, root, profileId, block.intakeId, {
              version: block.intakeVersion,
              proposalId: block.proposalId,
              reviewToken: block.reviewToken,
              decisions: block.selections.map((selection) => ({
                recordId: selection.recordId,
                action: 'accept',
                mapping: selection.mapping,
                comparisons: selection.comparisons,
              })),
            });
            for (const selection of block.selections) {
              const record = result.review?.records.find(
                (item) =>
                  item.id === selection.recordId &&
                  item.candidateId === selection.candidateId &&
                  item.candidateVersionId === selection.candidateVersionId,
              );
              // Preparation validates blockers against the user's exact mappings and
              // comparison decisions. Rechecking the pre-correction classification or
              // questions here would reject valid corrections and relationship choices.
              // Application still validates clinical semantics inside this transaction.
              if (!record)
                throw new HttpError(
                  409,
                  'REPORT_ACCEPTANCE_BLOCKED',
                  'Resolve each selected record before accepting; unselected records stay unchanged',
                );
            }
            return result;
          });
          const versions = new Map<string, number>(),
            receipts: IntakeReportAcceptanceReceipt['receipts'] = [],
            occurrenceAuthorityFinalizers: OccurrenceAuthorityFinalizer[] = [];
          for (const [index, block] of selected.blocks.entries()) {
            const before = versions.get(block.intakeId) ?? block.intakeVersion;
            const applied = measureImportPhase(
              'review_acceptance_apply',
              () => prepared[index]!.apply(before, occurrenceAuthorityFinalizers),
              { selectedCount: block.selections.length },
              { profileId, importId: block.intakeId },
            );
            versions.set(block.intakeId, applied.intakeVersion);
            const records = block.selections.map((selection) => {
              const accepted = applied.imported.clinical?.records?.find(
                (record) => record.recordId === selection.recordId,
              );
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
          const result: IntakeReportAcceptanceReceipt = {
            operationId: selected.operationId,
            status: 'accepted',
            atomic: true,
            at: now(),
            selectedCount: count,
            acceptedCount: receipts.reduce((sum, receipt) => sum + receipt.records.length, 0),
            receipts,
          };
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
