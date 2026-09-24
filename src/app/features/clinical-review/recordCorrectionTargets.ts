import type { HistoricalNote, Medication, Observation, Procedure } from '../../../shared/api';
import type { IntakeClinicalMapping } from '../../../shared/intake';
import type { RecordCorrectionTarget } from './RecordCorrectionDialog';

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function retainedMapping(extra: unknown): IntakeClinicalMapping {
  const accepted = object(object(extra)?.import)?.acceptedMapping;
  return object(accepted) ? (accepted as IntakeClinicalMapping) : {};
}

const optional = (value: string | null) => value ?? undefined;

export function observationCorrectionTarget(record: Observation): RecordCorrectionTarget {
  return {
    kind: 'observation',
    recordId: record.id,
    title: record.label,
    mapping: {
      ...retainedMapping(record.extra),
      kind: 'observation',
      testLabel: record.label,
      date: optional(record.date),
      valueText: record.valueText,
      unit: optional(record.unit),
      referenceText:
        typeof record.reference === 'string'
          ? record.reference
          : record.reference == null
            ? undefined
            : JSON.stringify(record.reference),
      status: optional(record.status),
    },
  };
}

export function medicationCorrectionTarget(record: Medication): RecordCorrectionTarget {
  return {
    kind: 'medication',
    recordId: record.id,
    title: record.label,
    mapping: {
      ...retainedMapping(record.extra),
      kind: 'medication',
      medicationName: record.label,
      medicationKind: record.kind,
      status: optional(record.status),
      date: optional(record.sourceRecordedDate),
      doseText: optional(record.doseText),
      route: optional(record.route),
      frequency: optional(record.frequency),
      startDate: optional(record.startAt),
      endDate: optional(record.endAt),
    },
  };
}

export function procedureCorrectionTarget(record: Procedure): RecordCorrectionTarget {
  return {
    kind: 'procedure',
    recordId: record.id,
    title: record.label,
    mapping: {
      ...retainedMapping(record.extra),
      kind: 'procedure',
      procedureLabel: record.label,
      procedureCategory: record.category,
      date: optional(record.date),
      status: optional(record.status),
    },
  };
}

export function documentCorrectionTarget(
  record: Extract<HistoricalNote, { origin: 'provider' }>,
): RecordCorrectionTarget {
  return {
    kind: 'document',
    recordId: record.id,
    title: record.title,
    mapping: {
      ...retainedMapping(record.extra),
      kind: 'document',
      documentTitle: record.title,
      documentDate: optional(record.recordDate || record.date),
      date: optional(record.eventDate || record.date),
      documentCategory: optional(record.typeLabel),
      status: optional(record.sourceStatus),
      text: optional(record.content),
    },
  };
}
