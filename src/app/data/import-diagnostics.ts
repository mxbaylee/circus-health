import { clinicalDatePrecision } from '../../shared/clinical-date.ts';
import type { IntakeClinicalMapping, IntakeReviewRecord } from '../../shared/intake';
import type { IntakeIdentityReview } from '../../shared/intake-identity';
export { diagnosticRoute } from '../../shared/import-diagnostic-route.ts';

export interface BrowserImportDiagnostic {
  at: string;
  event: 'api.started' | 'api.completed' | 'api.failed' | 'api.cancelled';
  requestId: string;
  serverRequestId?: string;
  route: string;
  method: string;
  status?: number;
  durationMs?: number;
  code?: string;
  cancellation?: 'caller' | 'profile_changed' | 'transport';
}

const events: BrowserImportDiagnostic[] = [];
export function recordBrowserImportDiagnostic(event: BrowserImportDiagnostic): void {
  // A bounded metadata-only buffer makes an interrupted request diagnosable even
  // when console logging was off. It is never written to persistent storage.
  events.push(event);
  if (events.length > 500) events.splice(0, events.length - 500);
  try {
    if (sessionStorage.getItem('circus:import-debug') === '1')
      console.debug('[Circus import]', JSON.stringify(event));
  } catch {
    /* Session storage may be unavailable; diagnostics must not break requests. */
  }
}

export function browserImportDiagnostics(): readonly BrowserImportDiagnostic[] {
  return events.map((event) => ({ ...event }));
}

export function clearBrowserImportDiagnostics(): void {
  events.length = 0;
  editorEvents.length = 0;
  identityEvents.length = 0;
}

const editorEvents: {
  at: string;
  recordKind: string;
  mappingKind: string;
  editorKind: string;
  fields: string[];
  dateState: string;
  missingUnit: boolean;
  missingResult: boolean;
  missingTestName: boolean;
  issues: { kind: string; field: string | null; blocking: boolean; resolved: boolean }[];
}[] = [];
const editorKinds = new Set(['observation', 'medication', 'procedure', 'document', 'unsupported']);
const editorFields = new Set([
  'kind',
  'subject',
  'testLabel',
  'valueText',
  'unit',
  'date',
  'documentDate',
  'startDate',
  'endDate',
  'documentTitle',
  'text',
  'medicationName',
  'doseText',
  'procedureLabel',
  'referenceText',
  'status',
  'specimen',
  'method',
  'code',
  'codeSystem',
  'observationCategory',
  'route',
  'frequency',
  'documentCategory',
  'visitSpecialty',
]);
export function recordReviewEditorDiagnostic(
  record: IntakeReviewRecord,
  mapping: IntakeClinicalMapping,
  fields: string[],
  editorKind: string = mapping.kind || record.kind,
): void {
  const snapshot = {
    recordKind: editorKinds.has(record.kind) ? record.kind : 'unsupported',
    mappingKind: editorKinds.has(mapping.kind || '') ? mapping.kind! : 'unsupported',
    editorKind: editorKinds.has(editorKind) ? editorKind : 'unsupported',
    fields: fields.filter((field) => editorFields.has(field)),
    dateState: clinicalDatePrecision(mapping.date || '') || 'invalid',
    missingUnit: !mapping.unit?.trim(),
    missingResult: !mapping.valueText?.trim(),
    missingTestName: !mapping.testLabel?.trim(),
    issues: (record.issues || []).slice(0, 100).map((issue) => ({
      kind: ['identity', 'date', 'uncertain_reading', 'information'].includes(issue.kind)
        ? issue.kind
        : 'unknown',
      field: editorFields.has(issue.field || '') ? issue.field : null,
      blocking: issue.blocking === true,
      resolved: issue.status === 'resolved',
    })),
  };
  const last = editorEvents.at(-1);
  if (last) {
    const { at: _, ...previous } = last;
    if (JSON.stringify(previous) === JSON.stringify(snapshot)) return;
  }
  editorEvents.push({ at: new Date().toISOString(), ...snapshot });
  if (editorEvents.length > 50) editorEvents.shift();
}
export function reviewEditorDiagnostics() {
  return structuredClone(editorEvents);
}

const identityEvents: {
  at: string;
  hasEvidencedName: boolean;
  hasEvidencedDob: boolean;
  hasSelfDob: boolean;
  dobConflict: boolean;
  blocking: boolean;
  status: string;
}[] = [];
/** Presence and policy outcomes only: never identity values, prompts, or IDs. */
export function recordIdentityReviewDiagnostic(review: IntakeIdentityReview) {
  const snapshot = {
    hasEvidencedName: Boolean(review.evidencedIdentity.fullName),
    hasEvidencedDob: Boolean(review.evidencedIdentity.birthDate),
    hasSelfDob: Boolean(review.self.birthDate),
    dobConflict: review.selfBirthDateConflict === true,
    blocking: review.blocking === true,
    status: [
      'evidenced_match',
      'prior_confirmation',
      'confirmation_required',
      'missing_warning',
      'conflict',
    ].includes(review.status)
      ? review.status
      : 'unknown',
  };
  const last = identityEvents.at(-1);
  if (last) {
    const { at: _, ...previous } = last;
    if (JSON.stringify(previous) === JSON.stringify(snapshot)) return;
  }
  identityEvents.push({ at: new Date().toISOString(), ...snapshot });
  if (identityEvents.length > 50) identityEvents.shift();
}
export function identityReviewDiagnostics() {
  return structuredClone(identityEvents);
}
