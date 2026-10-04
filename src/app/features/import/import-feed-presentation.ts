import type { IntakeImportFeedRecord } from '../../../shared/intake';
import { hasUnreviewedPairChoices } from '../../../shared/clinical-review';
import { initialDraft } from '../intake/useReviewDrafts';

export function recordLabel(record: IntakeImportFeedRecord) {
  return (
    record.mapping.testLabel ||
    record.mapping.medicationName ||
    record.mapping.procedureLabel ||
    record.mapping.documentTitle ||
    record.mapping.label ||
    record.title
  );
}

export function recordValue(record: IntakeImportFeedRecord) {
  const mapping = initialDraft(record).decision.mapping;
  if (record.feedKind === 'prescription')
    return { value: mapping.doseText || mapping.status || 'Prescription', unit: mapping.frequency };
  if (record.feedKind === 'procedure')
    return { value: mapping.status || mapping.eventKind || 'Procedure', unit: '' };
  if (record.feedKind === 'history' || record.feedKind === 'unsupported') {
    const literal = (mapping.text || mapping.status || record.title).replace(/\s+/g, ' ').trim();
    return { value: literal.length > 120 ? `${literal.slice(0, 117)}…` : literal, unit: '' };
  }
  if (record.feedKind === 'vision' && mapping.opticalPrescription) {
    const eyes = mapping.opticalPrescription.eyes.map((eye) => {
      const side =
        eye.sideText ||
        (eye.side === 'right'
          ? 'OD'
          : eye.side === 'left'
            ? 'OS'
            : eye.side === 'both'
              ? 'OU'
              : 'Eye');
      const values = [
        eye.sph && `SPH ${eye.sph.valueText}${eye.sph.unit ? ` ${eye.sph.unit}` : ''}`,
        eye.cyl && `CYL ${eye.cyl.valueText}${eye.cyl.unit ? ` ${eye.cyl.unit}` : ''}`,
        eye.axis && `AXIS ${eye.axis.valueText}${eye.axis.unit ? ` ${eye.axis.unit}` : ''}`,
        eye.add && `ADD ${eye.add.valueText}${eye.add.unit ? ` ${eye.add.unit}` : ''}`,
      ].filter(Boolean);
      return `${side} ${values.join(' ')}`.trim();
    });
    const literal = eyes.filter(Boolean).join(' · ');
    return { value: literal || 'Vision prescription', unit: '' };
  }
  return { value: mapping.valueText || 'Value to review', unit: mapping.unit };
}

export function recordSaveBlockReason(record: IntakeImportFeedRecord): string | undefined {
  if (record.selectable || (record.queueState !== 'pending' && record.queueState !== 'deferred'))
    return undefined;
  if (hasUnreviewedPairChoices(record))
    return 'Review the possible record matches before saving this record.';
  if (record.identityReview?.blocking)
    return record.identityReview.message || 'Review the report identity before saving this record.';
  const issue = record.issues?.find(
    (candidate) => candidate.blocking && candidate.status !== 'resolved',
  );
  if (issue?.kind === 'identity') return 'Review the report identity before saving this record.';
  if (issue?.kind === 'date') return 'Resolve the date question before saving this record.';
  if (issue?.kind === 'uncertain_reading')
    return 'Resolve the uncertain reading before saving this record.';
  if (issue?.kind === 'information')
    return 'Answer the required review question before saving this record.';
  if (record.classification === 'unsupported')
    return 'This item is kept with its original and cannot be saved as a structured record.';
  return 'Open the full review to resolve what is blocking this record.';
}
