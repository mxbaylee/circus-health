import type { IntakeClinicalMapping, IntakeReviewIssue } from '../../../shared/intake';
export type EditableKind = 'observation' | 'medication' | 'procedure' | 'document';
export type MappingField = {
  key: keyof IntakeClinicalMapping;
  label: string;
  placeholder?: string;
  multiline?: boolean;
};

export const mappingFields: Record<EditableKind, MappingField[]> = {
  observation: [
    { key: 'testLabel', label: 'Test name' },
    { key: 'observationCategory', label: 'Test classification' },
    { key: 'valueText', label: 'Result' },
    { key: 'unit', label: 'Unit' },
    { key: 'referenceText', label: 'Reference range' },
    { key: 'status', label: 'Status' },
    { key: 'code', label: 'Code' },
    { key: 'codeSystem', label: 'Code system' },
    { key: 'specimen', label: 'Specimen' },
    { key: 'method', label: 'Method' },
  ],
  medication: [
    { key: 'medicationName', label: 'Medication' },
    { key: 'doseText', label: 'Dose' },
    { key: 'route', label: 'Route' },
    { key: 'frequency', label: 'Frequency' },
    { key: 'status', label: 'Status' },
    { key: 'startDate', label: 'Explicit start date', placeholder: 'YYYY-MM-DD' },
    { key: 'endDate', label: 'Explicit end date', placeholder: 'YYYY-MM-DD' },
  ],
  procedure: [
    { key: 'procedureLabel', label: 'Procedure' },
    { key: 'status', label: 'Status' },
  ],
  document: [
    { key: 'documentTitle', label: 'Document title' },
    { key: 'documentCategory', label: 'Document classification' },
    { key: 'visitSpecialty', label: 'Visit specialty from evidence' },
    { key: 'documentDate', label: 'Document date', placeholder: 'YYYY-MM-DD' },
    { key: 'status', label: 'Status' },
    { key: 'text', label: 'Document text', multiline: true },
  ],
};

export function recordCorrectionFields(
  kind: string,
  issues: IntakeReviewIssue[] = [],
): MappingField[] {
  const scoped = new Set(
    issues
      .filter(
        (issue) =>
          ['uncertain_reading', 'date'].includes(issue.kind) && issue.status !== 'resolved',
      )
      .map((issue) => issue.field),
  );
  const available = [
    ...(mappingFields[kind as EditableKind] || mappingFields.document),
    { key: 'date' as const, label: 'Date' },
  ];
  const core =
    kind === 'observation'
      ? ['testLabel', 'valueText', 'unit', 'date']
      : kind === 'medication'
        ? ['medicationName', 'doseText']
        : kind === 'procedure'
          ? ['procedureLabel']
          : ['documentTitle', 'text'];
  return available.filter((field) => core.includes(field.key) || scoped.has(field.key));
}
