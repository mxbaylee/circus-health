/** Selected diagnostic metadata projection. No clinical DTO or workflow is
 * synthesized, and iterators are consumed only by the export's global budget. */
import type { Database } from './database.ts';
import type { IntakeRead } from '../shared/intake-summary.ts';
import { isIntakeSummary } from '../shared/intake-summary.ts';
import type {
  AttributionDiagnosticSource,
  AttributionMetadataItems,
} from './intake-attribution.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { openCollectionReaderPlan } from './intake-source-reader-unit.ts';
import { assertIntakeOwner } from './intake.ts';

const MAX_FIELD_BYTES = 8192;
const MAX_PROJECTED_BYTES = 8 * 1024 * 1024;
class DiagnosticProjectionIncomplete extends Error {}

export function prepareIntakeAttributionSources(
  db: Database,
  root: string,
  profileId: string,
  intakes: readonly IntakeRead[],
): Array<Exclude<IntakeRead, { format: string }> | AttributionDiagnosticSource> {
  assertIntakeOwner(db, profileId);
  let projectedBytes = 0;
  return intakes.map((intake) => {
    if (!isIntakeSummary(intake)) return intake;
    const view = openIntakeCollectionEnvelope(db, { id: intake.id }),
      selected = view.child(view.root(), 'intake')!,
      workflow = view.child(selected, 'workflow');
    let incomplete = false;
    const field = <T>(record: IntakeEnvelopeRecord, name: string): T | undefined => {
      const selected = view.field(record, name, { bytes: MAX_FIELD_BYTES });
      if (selected.kind === 'missing') return undefined;
      if (selected.kind !== 'value') throw new DiagnosticProjectionIncomplete();
      projectedBytes += Buffer.byteLength(JSON.stringify(selected.value));
      if (projectedBytes > MAX_PROJECTED_BYTES) throw new DiagnosticProjectionIncomplete();
      return selected.value as T;
    };
    const text = (record: IntakeEnvelopeRecord, name: string) => {
      const value = field<string>(record, name);
      if (typeof value !== 'string') throw new DiagnosticProjectionIncomplete();
      return value;
    };
    const items = <T>(length: number, at: (ordinal: number) => T): AttributionMetadataItems<T> => ({
      length,
      *[Symbol.iterator]() {
        for (let ordinal = 0; ordinal < length; ordinal++) {
          try {
            assertIntakeOwner(db, profileId);
            view.info(selected);
            if (projectedBytes >= MAX_PROJECTED_BYTES) throw new DiagnosticProjectionIncomplete();
            yield at(ordinal);
          } catch {
            // Diagnostic history remains visibly partial if an old selected
            // scope needs preparation, changed, or exceeds its field budget.
            incomplete = true;
            return;
          }
        }
      },
    });
    const children = <T>(
      record: IntakeEnvelopeRecord | undefined,
      name: string,
      project: (record: IntakeEnvelopeRecord) => T,
    ) =>
      items(record ? view.childCount(record, name) : 0, (ordinal) =>
        project(view.childAt(record!, name, ordinal)!),
      );
    const history = (record: IntakeEnvelopeRecord, original = false) => ({
      acceptedProposalId: field<string | null>(original ? selected : record, 'acceptedProposalId'),
      clinical: {
        records: children(view.child(record, 'clinical'), 'records', (record) => ({
          recordId: text(record, 'recordId'),
        })),
      },
    });
    const imported = view.child(selected, 'imported');
    const result: AttributionDiagnosticSource = {
      format: 'health-intake-attribution-source-v1',
      id: intake.id,
      sha256: intake.sha256,
      parentSourceFileId: intake.parentSourceFileId || null,
      incomplete: () => incomplete,
      proposals: children(selected, 'proposals', (record) => ({ id: text(record, 'id') })),
      history: view.childCount(selected, 'importHistory')
        ? children(selected, 'importHistory', (record) => history(record))
        : imported
          ? items(1, () => history(imported, true))
          : [],
      decisions: children(workflow, 'decisions', (record) => ({
        action: text(record, 'action'),
        candidateId: text(record, 'candidateId'),
        candidateVersionId: text(record, 'candidateVersionId'),
        recordId: text(record, 'recordId'),
      })),
      reportAcceptances: children(workflow, 'reportAcceptances', (record) => ({
        receipt: {
          receipts: children(view.child(record, 'receipt'), 'receipts', (record) => ({
            intakeId: text(record, 'intakeId'),
            proposalId: field<string | null>(record, 'proposalId') ?? null,
            records: children(record, 'records', (record) => ({
              candidateId: text(record, 'candidateId'),
              candidateVersionId: text(record, 'candidateVersionId'),
              recordId: text(record, 'recordId'),
            })),
          })),
        },
      })),
      plans: children(workflow, 'plans', (plan) => {
        const format = field<string>(plan, 'format');
        const length =
          format === 'health-intake-package-plan-v2' || format === 'health-intake-direct-plan-v2'
            ? field<number>(plan, 'unitCount')
            : view.childCount(plan, 'units');
        if (!Number.isSafeInteger(length) || length! < 0)
          throw new DiagnosticProjectionIncomplete();
        let scope: ReturnType<typeof openCollectionReaderPlan> | undefined;
        return {
          id: text(plan, 'id'),
          status: text(plan, 'status'),
          units: items(length!, (ordinal) => {
            scope ??= openCollectionReaderPlan(db, root, profileId, intake.id, view.address(plan));
            const unit = scope.attributionUnit(ordinal);
            // Selected scope fields are bounded too; do not retain diagnostic
            // payloads beyond the global source metadata byte allowance.
            projectedBytes += Buffer.byteLength(JSON.stringify({ ...unit, pages: undefined }));
            if (projectedBytes > MAX_PROJECTED_BYTES) throw new DiagnosticProjectionIncomplete();
            return unit;
          }),
          batches: children(plan, 'batches', (record) => ({
            id: text(record, 'id'),
            coverage: children(record, 'coverage', (record) => ({
              unitId: text(record, 'unitId'),
            })),
          })),
        };
      }),
      candidates: children(workflow, 'candidates', (record) => ({
        id: text(record, 'id'),
        versions: children(record, 'versions', (record) => ({
          id: text(record, 'id'),
          status: text(record, 'status'),
          occurrences: children(record, 'occurrences', (record) => ({
            proposalId: field<string | null>(record, 'proposalId') ?? null,
            recordId: text(record, 'recordId'),
            batchId: field<string | null>(record, 'batchId'),
            locator: field<string>(record, 'locator'),
          })),
        })),
      })),
    };
    return result;
  });
}
