import type { IntakeReviewRecord } from '../../shared/intake';
import {
  isClinicalRecordRead,
  isClinicalReviewPage,
  type IntakeClinicalRecordRead,
  type IntakeClinicalReviewContext,
  type IntakeClinicalReviewRead,
} from '../../shared/intake-clinical-review';
import { api, type ApiOptions } from './api';

export interface SelectedClinicalReview {
  native: boolean;
  revision?: number;
  context: IntakeClinicalReviewContext;
  record: IntakeClinicalRecordRead['record'];
}
export async function readSelectedClinicalReview(
  intakeId: string,
  proposalId: string | null,
  recordId: string,
  candidateVersionId?: string,
  options?: ApiOptions,
): Promise<SelectedClinicalReview> {
  const query = new URLSearchParams({ recordId, bytes: '65536' });
  if (proposalId) query.set('proposalId', proposalId);
  if (candidateVersionId) query.set('candidateVersionId', candidateVersionId);
  const { data, meta } = await api<IntakeClinicalReviewRead>(
    `/intakes/${encodeURIComponent(intakeId)}/review-record?${query}`,
    options,
  );
  if (isClinicalRecordRead(data)) {
    const selectedId =
      data.record.kind === 'record' ? data.record.record.id : data.record.selection.recordId;
    const selectedVersion =
      data.record.kind === 'record'
        ? data.record.record.candidateVersionId
        : data.record.selection.candidateVersionId;
    if (
      data.context.intakeId !== intakeId ||
      data.context.proposalId !== proposalId ||
      selectedId !== recordId ||
      (candidateVersionId && selectedVersion !== candidateVersionId)
    )
      throw new Error('The server did not return this exact record version. Refresh its review.');
    const revision = meta?.revision;
    return {
      native: true,
      ...(typeof revision === 'number' ? { revision } : {}),
      context: data.context,
      record: data.record,
    };
  }
  if (isClinicalReviewPage(data))
    throw new Error('The server returned a display page instead of this exact record.');
  if (data.intakeId !== intakeId || data.proposalId !== proposalId)
    throw new Error('The server did not return this exact record context. Refresh its review.');
  const record: IntakeReviewRecord | undefined = data.records.find(
    (item) =>
      item.id === recordId &&
      (!candidateVersionId || item.candidateVersionId === candidateVersionId),
  );
  if (!record) throw new Error('This exact record version is no longer current.');
  return { native: false, context: data, record: { kind: 'record', record } };
}
