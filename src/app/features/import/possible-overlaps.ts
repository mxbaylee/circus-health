import type { IntakeClinicalMapping, IntakeReviewRecord } from '../../../shared/intake';

/** A review cue, never a merge, selection restriction or clinical-equivalence decision. */
export function possibleSavedOverlapCount(
  record: Pick<
    IntakeReviewRecord,
    'kind' | 'evidence' | 'comparisons' | 'draft' | 'comparisonDrafts'
  >,
  mapping: IntakeClinicalMapping,
): number {
  if (record.kind !== 'observation' || !mapping.date || !mapping.valueText || !mapping.unit)
    return 0;
  const originals = new Set(record.evidence.map((item) => item.contentUrl).filter(Boolean));
  return (record.comparisons || []).filter((candidate) => {
    const previous = candidate.previousDecision;
    if (previous?.scopeStatus === 'current' && previous.outcome !== 'unresolved') return false;
    const draft = record.draft?.decision?.comparisons?.find(
      (choice) => choice.otherRecordId === candidate.id,
    );
    if (
      draft &&
      draft.outcome !== 'unresolved' &&
      draft.reason.trim() &&
      record.comparisonDrafts?.some(
        (choice) => choice.otherRecordId === candidate.id && choice.status === 'current',
      )
    )
      return false;
    return (
      candidate.kind === 'observation' &&
      candidate.mapping.date === mapping.date &&
      candidate.mapping.valueText === mapping.valueText &&
      candidate.mapping.unit === mapping.unit &&
      candidate.evidence.some((item) => !!item.contentUrl && originals.has(item.contentUrl))
    );
  }).length;
}
