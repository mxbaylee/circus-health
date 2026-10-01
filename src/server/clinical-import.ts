import { retainAcceptedContribution } from './ownership-contributions.ts';
import {
  requireCorrectedOwnershipReview,
  correctedOccurrence,
  ownershipEnvelopeHash,
} from './record-ownership-authority.ts';
import { clinicalDatePrecision } from '../shared/clinical-date.ts';
import { noteVisibilitySQL } from './visibility.ts';
import { clinicalSourceIdentityV1 } from './intake-source-identity.ts';
import { clinicalSourceScopeCheck } from './clinical-source-scope.ts';
import { appendImportedMedicationDefault } from './medication-preferences.ts';
import { opticalPrescriptionProblem, validClinicalFieldValue } from './optical-prescription.ts';
import {
  buildIntakeRelatedReview,
  duplicateRecord,
  intakePairDraftStatus,
  intakePairPreviousDecision,
  intakePairReference,
  intakePairScope,
  intakeEnvelopeState,
  requireIntakePairScope,
  refreshOccurrenceAttachmentAuthorities,
  verifyDuplicateOriginals,
  saveDuplicateDecision,
  type IntakeOccurrenceContext,
  type OccurrenceAuthorityFinalizer,
} from './duplicate-review.ts';
import { verifyIntakeFileHash } from './intake-files.ts';
import { validatedIntakePeople } from './intake-people-format.ts';
import { profileOriginal } from './profile-storage.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  HealthRecordEnvelope,
  IntakeAcceptedRecord,
  IntakeClinicalMapping,
  IntakeEvidenceComparison,
  IntakeReview,
  IntakeReviewDecision,
  IntakeReviewDraft,
  IntakeReviewRecord,
  IntakeReportGroup,
  IntakeReportSourceConfirmation,
  IntakeSourceContext,
  IntakeWorkflow,
} from '../shared/intake.ts';
import { canonicalLiteral, type IntakeEntry } from './intake-format.ts';
import { HttpError, json, revision, now } from './database.ts';
import { intakeReportSourceForMember } from './intake-report-source.ts';
import { projectObservationNumber } from './observation-number.ts';

type ClinicalKind = 'observation' | 'medication' | 'procedure' | 'document';
type DatePrecision = 'unknown' | 'year' | 'month' | 'day' | 'datetime';
type SqlValue = string | number | bigint | Uint8Array | null;
interface SqlRow {
  id: string;
  source_record_id: string;
  source_file_id: string;
  source_key: string;
  kind: string;
  provider_id: string;
  provider_name: string;
  name: string;
  title: string;
  label: string;
  category: string;
  effective_at: string | null;
  test_type_id: string;
  extra_json: string;
  raw_json: string;
  locator_json: string;
  evidence_locator: string;
  acquiring_source: string | null;
  details_json: string;
  path: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  unit: string | null;
  aliases_json: string;
  codes_json: string;
  context: string | null;
  coverage_json: string;
  extraction_status: string;
  batch_id: string;
  created_at: string;
  n: number | bigint;
}
type PartialSqlRow = Partial<SqlRow>;

interface ClinicalMapping {
  personId?: string;
  eventKind: string;
  observationCategory: string;
  documentCategory: string;
  visitSpecialty: string;
  kind: string;
  subject: string;
  date: string;
  dateRole: string;
  startDate: string;
  endDate: string;
  testLabel: string;
  valueText: string;
  unit: string;
  referenceText: string;
  medicationName: string;
  doseText: string;
  route: string;
  frequency: string;
  status: string;
  medicationKind: string;
  procedureLabel: string;
  procedureCategory: string;
  documentTitle: string;
  documentDate: string;
  text: string;
  code: string;
  codeSystem: string;
  specimen: string;
  method: string;
  assets: string[];
  uncertainties: string[];
  mappingOrigins?: {
    kind: 'clinical' | 'envelope';
    documentTitle: 'clinical' | 'envelope';
    text: 'clinical' | 'payload';
    opticalPrescription?: 'clinical' | 'envelope';
  };
  sourceSystem?: string;
  sourceRecordId?: string;
  label?: string;
  opticalPrescription?: unknown;
}

interface ActiveMappingRule {
  id: string;
  providerId: string;
  sequence?: number;
  replaces?: string | null;
  disabled?: boolean;
  scope?: string;
  match: { kind: string; label: string; sourceSystem?: string };
  set: Partial<ClinicalMapping>;
}

interface SourceFileRow extends PartialSqlRow {
  id: string;
  batch_id: string;
  provider_id: string;
  sha256: string;
  provider?: string;
  reviewedMetadata?: unknown;
  reportSourceConfirmations?: IntakeReportSourceConfirmation[];
}

interface InputFileRow extends PartialSqlRow {
  id: string;
  sha256: string;
}

interface RetainedClinicalSourceRecord {
  id: string;
  sourceFileId: string;
  providerId: string;
  sourceKey: string;
  kind: string;
  label: string;
  raw: string;
  locator: string;
  extractionStatus: 'retained_unprojected';
  batchId: string;
}

interface AssetFileRow extends SourceFileRow {
  path: string;
  mime_type: string;
  bytes: number;
}

interface RecordException {
  id?: string;
  identityKey: string;
  sourceVersion: string;
  set: Partial<ClinicalMapping>;
  recordId: string;
  sourceFileId?: string;
  locator?: unknown;
  scope?: 'record';
  sequence?: number;
  at?: string;
}

interface PriorRecord extends PartialSqlRow {
  id: string;
  source_record_id: string;
  kind: ClinicalKind;
  exact: boolean;
}

interface ClinicalReviewRecord extends Omit<
  IntakeReviewRecord,
  'kind' | 'mapping' | 'suggestedMapping' | 'supportedFields' | 'comparisons'
> {
  kind: ClinicalKind | 'unsupported';
  identityConfirmationRequired: boolean;
  mapping: ClinicalMapping;
  undraftedMapping: ClinicalMapping;
  recordException: RecordException | null;
  comparisons: ClinicalEvidenceComparison[];
  problem: string | null;
  sourceScopeProblem: string | null;
  appliedRuleIds: string[];
  supportedFields: (keyof IntakeClinicalMapping)[];
}

interface ClinicalEvidenceComparison extends Omit<IntakeEvidenceComparison, 'kind'> {
  kind: ClinicalKind;
  sourceRecordId: string;
}

interface ClinicalReview extends Omit<IntakeReview, 'records'> {
  records: ClinicalReviewRecord[];
  sourceContext: IntakeSourceContext[];
}

interface BuildReviewInput {
  file: SourceFileRow;
  inputFile: InputFileRow;
  entries: IntakeEntry[];
  proposalId: string | null;
  version: number;
  drafts?: IntakeReviewDraft[];
  acceptedDecisions?: IntakeReviewDecision[];
}

interface ProjectReviewInput {
  file: SourceFileRow;
  inputFile: InputFileRow;
  entries: IntakeEntry[];
  review: ClinicalReview;
  decisions?: IntakeReviewDecision[];
  root?: string;
  profileId: string;
  prevalidatedPairScopes?: Set<string>;
  occurrenceAuthorityFinalizers?: OccurrenceAuthorityFinalizer[];
}

interface MappingRule {
  scope?: 'future_imports' | string;
  match: { kind: ClinicalKind; label: string; sourceSystem?: string };
  set: Partial<ClinicalMapping> & { kind?: ClinicalKind };
  replaces?: string;
}

interface FutureClassificationMatch {
  id: string;
  before: unknown;
  after: ClinicalMapping;
  sourceRecordId: string;
  individualException: boolean;
  problem: string | null;
}

interface ProjectionResults {
  added: number;
  duplicates: number;
  retainedOnly: number;
  versions: number;
  ruleIds: string[];
  records: IntakeAcceptedRecord[];
}

const parsedObject = (value: unknown): Record<string, unknown> => {
  const parsed: unknown = typeof value === 'string' ? json(value) : value;
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};
const stringValue = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const hash = (x: unknown): string =>
  createHash('sha256')
    .update(typeof x === 'string' ? x : JSON.stringify(x))
    .digest('hex');
const UNKNOWN_SOURCE_PROVIDER_ID = 'source-' + hash('unknown source').slice(0, 24);
const kinds = ['observation', 'medication', 'procedure', 'document'] as const;
const category = [
  'surgery',
  'clinical_procedure',
  'imaging',
  'laboratory',
  'pathology',
  'unspecified',
];
const isClinicalKind = (value: string): value is ClinicalKind =>
  kinds.includes(value as ClinicalKind);
const scalar = (x: unknown): string =>
  x == null
    ? ''
    : JSON.isRawJSON(x)
      ? JSON.stringify(x)
      : typeof x === 'string'
        ? x
        : typeof x === 'number'
          ? String(x)
          : '';
const clean = (x: unknown): string => scalar(x).trim();
const stable = (x: unknown): unknown =>
  Array.isArray(x)
    ? x.map(stable)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, stable((x as Record<string, unknown>)[k])]),
        )
      : x;
const canonical = (x: unknown): string => JSON.stringify(stable(x));
export { CLINICAL_INSTRUCTIONS } from './clinical-instructions.ts';
const common: (keyof ClinicalMapping)[] = ['kind', 'subject', 'date', 'status', 'eventKind'];
export const clinicalFields: Record<ClinicalKind, (keyof ClinicalMapping)[]> = {
  observation: [
    ...common,
    'testLabel',
    'observationCategory',
    'valueText',
    'unit',
    'referenceText',
    'code',
    'codeSystem',
    'specimen',
    'method',
  ],
  medication: [
    ...common,
    'medicationName',
    'doseText',
    'route',
    'frequency',
    'medicationKind',
    'dateRole',
    'startDate',
    'endDate',
  ],
  procedure: [...common, 'procedureLabel', 'procedureCategory'],
  document: [
    ...common,
    'documentTitle',
    'documentDate',
    'text',
    'documentCategory',
    'visitSpecialty',
    'opticalPrescription',
  ],
};
function clinicalMappingChanged(
  edits: Partial<IntakeClinicalMapping> | Partial<ClinicalMapping> | undefined,
  baseline: ClinicalMapping,
): boolean {
  const fields = new Set<string>(Object.values(clinicalFields).flat());
  return Object.entries(edits || {}).some(
    ([field, value]) =>
      field !== 'subject' &&
      fields.has(field) &&
      canonical(value) !== canonical(baseline[field as keyof ClinicalMapping]),
  );
}
export function activeMappingRules(db: DatabaseSync, providerId: string): ActiveMappingRule[] {
  const rows = db
    .prepare(
      "SELECT id,coverage_json,created_at FROM manual_batches WHERE title='Import mapping decision' ORDER BY created_at,id",
    )
    .all() as PartialSqlRow[];
  const ordered = rows
    .map((row) => ({ ...row, rule: parsedObject(parsedObject(row.coverage_json).mappingRule) }))
    .filter((row) => row.rule.providerId === providerId)
    .sort(
      (a, b) =>
        Number(a.rule.sequence || 0) - Number(b.rule.sequence || 0) ||
        String(a.created_at).localeCompare(String(b.created_at)) ||
        String(a.id).localeCompare(String(b.id)),
    );
  const rules = new Map<string, ActiveMappingRule>();
  for (const { id, rule } of ordered) {
    const normalized = rule as unknown as Omit<ActiveMappingRule, 'id'>;
    if (normalized.replaces)
      for (const [key, value] of rules) if (value.id === normalized.replaces) rules.delete(key);
    if (!normalized.disabled)
      rules.set(canonical(normalized.match), { id: String(id), ...normalized });
  }
  return [...rules.values()];
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function clinicalMappingEnvelope(value: unknown): Record<string, unknown> {
  // Some retained proposals used this earlier name for the same reviewed
  // mapping contract. A supplied canonical clinical object is authoritative.
  if (!object(value)) return {};
  return object(value.clinical)
    ? value.clinical
    : object(value.proposedClinicalMapping)
      ? value.proposedClinicalMapping
      : {};
}
export function sourceContextEnvelope(value: unknown): boolean {
  if (!object(value)) return false;
  return value?.kind === 'context' && Object.keys(clinicalMappingEnvelope(value)).length === 0;
}
export function mappingFrom(entry: Pick<IntakeEntry, 'value'>): ClinicalMapping {
  const raw = clinicalMappingEnvelope(entry.value);
  // Earlier document envelopes put literal optical data beside the payload.
  // Retain it as a proposal; subject checks and explicit review still govern
  // acceptance. An explicit clinical value (including null) takes precedence.
  const opticalPrescription =
    raw.opticalPrescription !== undefined
      ? raw.opticalPrescription
      : entry.value.kind === 'document'
        ? entry.value.opticalPrescription !== undefined
          ? entry.value.opticalPrescription
          : object(entry.value.payload)
            ? entry.value.payload.opticalPrescription
            : undefined
        : undefined;
  return {
    eventKind: clean(raw.eventKind) || 'unknown',
    observationCategory: clean(raw.observationCategory),
    documentCategory: clean(raw.documentCategory),
    visitSpecialty: clean(raw.visitSpecialty),
    kind: clean(raw.kind) || (entry.value.kind === 'document' ? 'document' : 'unsupported'),
    subject: clean(raw.subject) || clean(entry.value.subject) || 'unknown',
    date: clean(raw.date || raw.documentDate),
    dateRole: clean(raw.dateRole) || 'recorded',
    startDate: clean(raw.startDate),
    endDate: clean(raw.endDate),
    testLabel: clean(raw.testLabel || raw.label),
    valueText: scalar(raw.valueText),
    unit: clean(raw.unit),
    referenceText: scalar(raw.referenceText),
    medicationName: clean(raw.medicationName || raw.label),
    doseText: scalar(raw.doseText),
    route: clean(raw.route),
    frequency: clean(raw.frequency),
    status: clean(raw.status),
    medicationKind: clean(raw.medicationKind) || 'unknown',
    procedureLabel: clean(raw.procedureLabel || raw.label),
    procedureCategory: clean(raw.procedureCategory) || 'unspecified',
    documentTitle: clean(raw.documentTitle || raw.label) || entry.value.id,
    documentDate: clean(raw.documentDate || raw.date),
    ...(opticalPrescription !== undefined ? { opticalPrescription } : {}),
    mappingOrigins: {
      kind: clean(raw.kind) ? 'clinical' : 'envelope',
      documentTitle: clean(raw.documentTitle || raw.label) ? 'clinical' : 'envelope',
      text: typeof raw.text === 'string' ? 'clinical' : 'payload',
      ...(opticalPrescription !== undefined
        ? { opticalPrescription: raw.opticalPrescription !== undefined ? 'clinical' : 'envelope' }
        : {}),
    },
    text:
      typeof raw.text === 'string'
        ? raw.text
        : typeof entry.value.payload === 'string'
          ? entry.value.payload
          : JSON.stringify(entry.value.payload),
    code: clean(raw.code),
    codeSystem: clean(raw.codeSystem),
    specimen: clean(raw.specimen),
    method: clean(raw.method),
    assets: Array.isArray(raw.assets) ? raw.assets.filter((x) => typeof x === 'string') : [],
    uncertainties: [
      ...(Array.isArray(raw.uncertainties) ? raw.uncertainties : []),
      ...(Array.isArray(entry.value.uncertainties) ? entry.value.uncertainties : []),
    ].filter((x) => typeof x === 'string'),
  };
}
const labelOf = (
  m: Pick<
    ClinicalMapping,
    'kind' | 'testLabel' | 'medicationName' | 'procedureLabel' | 'documentTitle'
  >,
): string =>
  m.kind === 'observation'
    ? m.testLabel
    : m.kind === 'medication'
      ? m.medicationName
      : m.kind === 'procedure'
        ? m.procedureLabel
        : m.documentTitle;
export function clinicalMappingLabel(mapping: Partial<ClinicalMapping>): string {
  return labelOf({
    kind: mapping.kind || 'unsupported',
    testLabel: mapping.testLabel || '',
    medicationName: mapping.medicationName || '',
    procedureLabel: mapping.procedureLabel || '',
    documentTitle: mapping.documentTitle || '',
  });
}
export function applyRules(mapping: ClinicalMapping, rules: ActiveMappingRule[]): ClinicalMapping {
  let result = { ...mapping };
  for (const rule of rules)
    if (
      rule.match.kind === result.kind &&
      rule.match.label === labelOf(result) &&
      (!rule.match.sourceSystem || rule.match.sourceSystem === mapping.sourceSystem)
    )
      result = { ...result, ...rule.set };
  return result;
}
export function datePrecision(date: string): DatePrecision {
  const precision = clinicalDatePrecision(date);
  if (precision) return precision;
  throw new HttpError(400, 'IMPORT_DATE', 'Keep a valid original date or leave it unknown');
}
export function checkClinicalMapping(mapping: ClinicalMapping): string | null {
  if (
    !['order', 'performed', 'historical_mention', 'unknown'].includes(
      mapping.eventKind || 'unknown',
    )
  )
    return 'Event type is unsupported';
  if (!isClinicalKind(mapping.kind)) return 'No supported clinical mapping';
  if (mapping.opticalPrescription != null) {
    if (mapping.kind !== 'document')
      return 'Optical prescriptions belong to documents, separate from medications and examination findings';
    const problem = opticalPrescriptionProblem(mapping.opticalPrescription);
    if (problem) return problem;
  }
  if (
    mapping.subject !== 'self' &&
    !(mapping.subject === 'other' && mapping.personId && mapping.personId !== 'patient')
  )
    return 'Choose who this clinical record belongs to';
  if (!labelOf(mapping).trim()) return 'Entry label is missing';
  if (mapping.kind === 'observation' && !mapping.valueText.trim()) return 'Result value is missing';
  if (
    mapping.kind === 'medication' &&
    (!['recorded', 'start'].includes(mapping.dateRole) ||
      !['order', 'reported_use', 'dispense', 'administration', 'unknown'].includes(
        mapping.medicationKind,
      ))
  )
    return 'Medication date role or assertion kind is unsupported';
  if (mapping.kind === 'procedure' && !category.includes(mapping.procedureCategory))
    return 'Procedure category is unsupported';
  try {
    datePrecision(mapping.date);
    datePrecision(mapping.startDate);
    datePrecision(mapping.endDate);
    datePrecision(mapping.documentDate);
  } catch {
    return 'Original date is invalid or needs review';
  }
  return null;
}

/** Re-evaluate the subject-dependent classification after derived identity policy is applied. */
export function refreshClinicalIdentityPolicy(
  db: DatabaseSync,
  file: SourceFileRow,
  record: IntakeReviewRecord,
  workflow?: IntakeWorkflow,
): void {
  const internal = record as IntakeReviewRecord & {
    problem?: string | null;
    sourceScopeProblem?: string | null;
    classification: IntakeReviewRecord['classification'];
  };
  const clinicalIdentity = (record as IntakeReviewRecord & { ownershipIdentity?: string })
    .ownershipIdentity;
  if (clinicalIdentity)
    requireCorrectedOwnershipReview(db, record, clinicalIdentity, file, workflow);
  const assigned = record.identityAttribution?.assignedPerson;
  if (record.mapping.personId) {
    const person = db
      .prepare(
        `SELECT n.id FROM notes n WHERE n.kind='person' AND n.person_id=? AND ${noteVisibilitySQL('n')}=0`,
      )
      .get(record.mapping.personId);
    if (!assigned || assigned.personId !== record.mapping.personId || !person) {
      record.identityReview = {
        ...(record.identityReview || { status: 'conflict', evidencedIdentity: {}, conflicts: [] }),
        status: 'conflict',
        blocking: true,
        message: record.identityReview?.blocking
          ? record.identityReview.message
          : 'Choose an available person for this exact report before saving.',
      };
      delete record.mapping.personId;
      delete record.identityAttribution;
    }
  }
  const problem =
    internal.sourceScopeProblem ||
    checkClinicalMapping(record.mapping as ClinicalMapping) ||
    assetProblem(db, file, record.mapping as ClinicalMapping);
  internal.problem = problem;
  internal.classification = problem ? 'unsupported' : record.duplicateOf ? 'duplicate' : 'addition';
}
function sourceRoot(db: DatabaseSync, id: string): string {
  const seen = new Set<string>();
  let last = id;
  while (id && !seen.has(id)) {
    seen.add(id);
    last = id;
    const row = db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id) as
      PartialSqlRow | undefined;
    id = clean(parsedObject(parsedObject(row?.details_json).intake).parentSourceFileId);
  }
  return last;
}
export function assetProblem(
  db: DatabaseSync,
  file: SourceFileRow,
  mapping: ClinicalMapping,
): string | null {
  for (const id of mapping.assets) {
    if (!db.prepare('SELECT 1 FROM source_files WHERE id=?').get(id))
      return 'A referenced attachment was not retained; correct the proposal';
    if (sourceRoot(db, id) !== sourceRoot(db, file.id))
      return 'An attachment belongs to a different delivery; review its attribution';
  }
  return null;
}
const identity = clinicalSourceIdentityV1;

// Exceptions bind to the complete original mapping: fields outside the original
// kind can become clinical fields after reclassification. A changed result must
// not inherit an exception for an earlier source assertion.
const sourceMappingContents = (mapping: ClinicalMapping): Partial<ClinicalMapping> => {
  const { mappingOrigins, ...contents } = mapping;
  return contents;
};
const legacyClinicalSourceVersion = (mapping: ClinicalMapping): string =>
  'mapping-v2:' + hash(canonical(sourceMappingContents(mapping)));
export function clinicalSourceVersion(mapping: ClinicalMapping): string {
  if (!mapping.mappingOrigins) return legacyClinicalSourceVersion(mapping);
  const contents = sourceMappingContents(mapping);
  // Keep explicit fields of every clinical kind, but a non-document's generated
  // document defaults belong to its delivery, not the clinical assertion.
  if (mapping.kind !== 'document') {
    if (mapping.mappingOrigins?.documentTitle === 'envelope') delete contents.documentTitle;
    if (mapping.mappingOrigins?.text === 'payload') delete contents.text;
  }
  return 'mapping-v3:' + hash(canonical(contents));
}
export function clinicalVersion(mapping: ClinicalMapping): string {
  const keys: (keyof ClinicalMapping)[] = [
    'kind',
    'subject',
    'date',
    'status',
    ...(isClinicalKind(mapping.kind) ? clinicalFields[mapping.kind] : []),
    ...(mapping.kind === 'observation'
      ? (['code', 'codeSystem', 'specimen', 'method'] as (keyof ClinicalMapping)[])
      : mapping.kind === 'medication'
        ? (['medicationKind', 'dateRole', 'startDate', 'endDate'] as (keyof ClinicalMapping)[])
        : mapping.kind === 'document'
          ? (['text'] as (keyof ClinicalMapping)[])
          : []),
  ];
  return hash(
    canonical({
      ...Object.fromEntries(keys.map((k) => [k, mapping[k]])),
      ...(mapping.personId && mapping.personId !== 'patient' ? { personId: mapping.personId } : {}),
    }),
  );
}
function previous(
  db: DatabaseSync,
  identityKey: string,
  versionKey: string,
  personId = 'patient',
): PriorRecord | null {
  let changed: PriorRecord | null = null;
  for (const [table, kind] of Object.entries({
    observations: 'observation',
    medications: 'medication',
    procedures: 'procedure',
    documents: 'document',
  })) {
    const rows = db
      .prepare(
        `SELECT id,source_record_id,extra_json FROM ${table} WHERE json_extract(extra_json,'$.import.identity')=? AND ${table === 'documents' ? "COALESCE(json_extract(extra_json,'$.import.personId'),'patient')" : 'person_id'}=? ORDER BY id`,
      )
      .all(identityKey, personId) as PartialSqlRow[];
    const exact = rows.find(
      (row) => parsedObject(parsedObject(row.extra_json).import).version === versionKey,
    );
    if (exact)
      return {
        ...exact,
        id: String(exact.id),
        source_record_id: String(exact.source_record_id),
        kind: kind as ClinicalKind,
        exact: true,
      };
    const last = rows.at(-1);
    if (last)
      changed = {
        ...last,
        id: String(last.id),
        source_record_id: String(last.source_record_id),
        kind: kind as ClinicalKind,
        exact: false,
      };
  }
  return changed;
}
export function buildClinicalReview(
  db: DatabaseSync,
  {
    file,
    inputFile,
    entries,
    proposalId,
    version,
    drafts = [],
    acceptedDecisions = [],
  }: BuildReviewInput,
): ClinicalReview {
  const rules = activeMappingRules(db, file.provider_id);
  const sourceScopeProblem = clinicalSourceScopeCheck(db, file, entries, inputFile.id);
  const local = new Map<string, PriorRecord>(),
    localIdentity = new Map<string, PriorRecord>();
  const contextOnly = (entry: IntakeEntry): boolean => {
    const peopleOnly =
      validatedIntakePeople(entry.value).length > 0 &&
      Object.keys(clinicalMappingEnvelope(entry.value)).length === 0;
    if (!sourceContextEnvelope(entry.value) && !peopleOnly) return false;
    const original = mappingFrom(entry);
    const mapping = applyRules(
      { ...original, sourceSystem: clean(entry.value.provenance.sourceSystem) },
      rules,
    );
    const exception = sourceScopeProblem(entry)
      ? null
      : latestRecordException(db, identity(entry, file), original);
    if (exception) Object.assign(mapping, { kind: original.kind, ...exception.set });
    const draft = drafts.find((item) => item.recordId === `${inputFile.id}:line:${entry.line}`);
    const accepted = acceptedDecisions.findLast(
      (item) => item.action === 'accept' && item.recordId === `${inputFile.id}:line:${entry.line}`,
    );
    Object.assign(
      mapping,
      accepted?.mapping || {},
      draft?.mapping || {},
      draft?.decision?.mapping || {},
    );
    return !isClinicalKind(mapping.kind);
  };
  const classifiedEntries = entries.map((entry) => ({ entry, contextOnly: contextOnly(entry) }));
  const reviewEntries = classifiedEntries
    .filter((item) => !item.contextOnly)
    .map((item) => item.entry);
  const retainedGroups = (() => {
    const intake = parsedObject(parsedObject(file.details_json).intake);
    const workflow = parsedObject(intake.workflow);
    return Array.isArray(workflow.reportGroups)
      ? (workflow.reportGroups as IntakeReportGroup[])
      : [];
  })();
  const sourceContext: IntakeSourceContext[] = classifiedEntries
    .filter((item) => item.contextOnly)
    .map(({ entry }) => {
      const value = entry.value;
      const reportContext = retainedGroups
        .flatMap((group) => group.versions)
        .findLast(
          (groupVersion) =>
            groupVersion.context?.envelopeId === value.id &&
            groupVersion.members.some((member) =>
              member.occurrences.some((occurrence) => occurrence.proposalId === proposalId),
            ),
        )?.context;
      return {
        id: `${inputFile.id}:line:${entry.line}`,
        envelopeId: value.id,
        kind: 'context',
        title: 'Source context',
        payload: value.payload,
        text:
          typeof value.payload === 'string'
            ? value.payload
            : JSON.stringify(value.payload, null, 2),
        provenance: value.provenance,
        coverage: value.coverage,
        notes: [
          ...value.coverage.notes,
          ...(Array.isArray(value.uncertainties) ? value.uncertainties : []),
          ...(Array.isArray(value.reviewIssues)
            ? value.reviewIssues
                .filter(
                  (issue): issue is { kind: 'information'; prompt: string } =>
                    object(issue) &&
                    issue.kind === 'information' &&
                    typeof issue.prompt === 'string',
                )
                .map((issue) => issue.prompt)
            : []),
        ].filter((note, index, notes) => typeof note === 'string' && notes.indexOf(note) === index),
        evidence: [
          {
            label: 'Original source',
            locator: value.provenance.locator,
            contentUrl: `/api/sources/${encodeURIComponent(file.id)}/content`,
          },
        ],
        ...(reportContext ? { reportContext: structuredClone(reportContext) } : {}),
      };
    });
  const records: ClinicalReviewRecord[] = reviewEntries.map((entry) => {
    const original = mappingFrom(entry),
      mapping = {
        ...applyRules(
          { ...original, sourceSystem: clean(entry.value.provenance.sourceSystem) },
          rules,
        ),
        label: labelOf(original),
        sourceSystem: clean(entry.value.provenance.sourceSystem),
        sourceRecordId: clean(entry.value.provenance.sourceRecordId),
      },
      scopeProblem = sourceScopeProblem(entry),
      exception = scopeProblem ? null : latestRecordException(db, identity(entry, file), original);
    const beforeExceptionMapping = { ...mapping };
    Object.assign(mapping, exception ? { kind: original.kind, ...exception.set } : {});
    const undraftedMapping = { ...mapping },
      draft = drafts.find((d) => d.recordId === `${inputFile.id}:line:${entry.line}`),
      accepted = acceptedDecisions.findLast(
        (item) =>
          item.action === 'accept' && item.recordId === `${inputFile.id}:line:${entry.line}`,
      );
    Object.assign(
      mapping,
      sourceContextEnvelope(entry.value) ? accepted?.mapping || {} : {},
      draft?.mapping || {},
      sourceContextEnvelope(entry.value) ? draft?.decision?.mapping || {} : {},
    );
    const problem =
        scopeProblem || checkClinicalMapping(mapping) || assetProblem(db, file, mapping),
      identityKey = identity(entry, file),
      versionKey = clinicalVersion(mapping),
      prior = scopeProblem
        ? null
        : correctedOccurrence(db, identityKey, file.sha256, entry.value, mapping) ||
          previous(db, identityKey, versionKey, mapping.personId),
      found = scopeProblem
        ? null
        : (prior?.exact ? prior : null) ||
          local.get(identityKey + versionKey) ||
          prior ||
          localIdentity.get(identityKey);
    const id = `${inputFile.id}:line:${entry.line}`,
      classification = problem ? 'unsupported' : found?.exact ? 'duplicate' : 'addition';
    if (!problem) {
      local.set(identityKey + versionKey, {
        id,
        source_record_id: id,
        kind: mapping.kind as ClinicalKind,
        exact: true,
      });
      localIdentity.set(identityKey, {
        id,
        source_record_id: id,
        kind: mapping.kind as ClinicalKind,
        exact: false,
      });
    }
    const transcriptionCoverageWarning =
      entry.value.coverage.status === 'partial'
        ? 'Model transcription covers only part of this source entry. Whole-file reading progress is tracked separately; the retained original remains available.'
        : entry.value.coverage.status === 'unknown'
          ? 'Model transcription coverage is unknown for this source entry. Whole-file reading progress is tracked separately; the retained original remains available.'
          : null;
    const uncertainties = [
      ...mapping.uncertainties,
      ...(transcriptionCoverageWarning ? [transcriptionCoverageWarning] : []),
      ...(found && !found.exact
        ? ['Same source identity has a different assertion; both versions will be preserved']
        : []),
    ];
    const result = {
      id,
      ownershipIdentity: identityKey,
      ownershipEnvelopeHash: ownershipEnvelopeHash(entry.value),
      identityConfirmationRequired: proposalId !== null,
      classification,
      kind: isClinicalKind(mapping.kind) ? mapping.kind : 'unsupported',
      title: labelOf(mapping) || entry.value.id,
      date: mapping.date || null,
      provider: file.provider || file.provider_id,
      confidence: null,
      uncertainties,
      evidence: [
        {
          label: 'Original source',
          locator: entry.value.provenance.locator,
          contentUrl: `/api/sources/${encodeURIComponent(file.id)}/content`,
        },
        ...mapping.assets
          .filter((id) => id !== file.id)
          .map((id) => {
            const asset = db
              .prepare('SELECT path,details_json FROM source_files WHERE id=?')
              .get(id) as PartialSqlRow | undefined;
            return {
              label: asset?.path?.split('/').at(-1) || 'Missing attachment',
              locator:
                clean(parsedObject(parsedObject(asset?.details_json).intake).locator) ||
                'Referenced attachment',
              ...(asset
                ? {
                    contentUrl: `/api/sources/${encodeURIComponent(id)}/content`,
                  }
                : {}),
            };
          }),
      ],
      ...(found?.exact
        ? {
            duplicateOf: {
              id: found.id,
              label: found.exact ? 'Previously accepted assertion' : 'Prior source version',
              date: null,
              sameSourceRecord: found.source_record_id === id,
              persistedMatch: found === prior,
            },
          }
        : {}),
      mapping,
      undraftedMapping,
      manuallyEdited:
        clinicalMappingChanged(draft?.mapping, undraftedMapping) ||
        (exception?.recordId === id &&
          clinicalMappingChanged(exception.set, beforeExceptionMapping)),
      recordException: exception || null,
      // A retained acceptance may predate top-level optical support. Reopen
      // only that missing projection for review; an explicitly cleared value
      // remains a reviewed choice, and no accepted row is changed here.
      projectionUpgrade:
        !!original.opticalPrescription &&
        !opticalPrescriptionProblem(original.opticalPrescription) &&
        found?.kind === 'document' &&
        !found.exact &&
        !Object.hasOwn(
          parsedObject(parsedObject(found.extra_json).import).acceptedMapping || {},
          'opticalPrescription',
        ),
      comparisons: [],
      supportedFields: (isClinicalKind(mapping.kind)
        ? clinicalFields[mapping.kind]
        : common) as (keyof IntakeClinicalMapping)[],
      problem,
      sourceScopeProblem: scopeProblem,
      appliedRuleIds: rules
        .filter(
          (rule) =>
            rule.match.kind === original.kind &&
            rule.match.label === labelOf(original) &&
            (!rule.match.sourceSystem ||
              rule.match.sourceSystem === clean(entry.value.provenance.sourceSystem)),
        )
        .map((r) => r.id),
    } as ClinicalReviewRecord;
    if (isClinicalKind(mapping.kind))
      Object.assign(
        result,
        buildIntakeRelatedReview(
          db,
          {
            id,
            kind: mapping.kind,
            sourceRecordId: id,
            identity: identityKey,
            version: versionKey,
            stateHash: intakeEnvelopeState(entry.value),
            evidence: result.evidence,
          },
          mapping as IntakeClinicalMapping,
          draft?.decision?.comparisons,
        ),
      );
    return result;
  });
  const summary = {
    additions: records.filter((r) => r.classification === 'addition').length,
    duplicates: records.filter((r) => r.classification === 'duplicate').length,
    unsupported: records.filter((r) => r.classification === 'unsupported').length,
    uncertain: records.filter((r) => r.uncertainties.length).length,
  };
  const reviewToken = hash([
    revision(db),
    file.id,
    inputFile.sha256,
    version,
    proposalId,
    rules,
    records,
    sourceContext,
  ]);
  return {
    intakeId: file.id,
    proposalId,
    version,
    reviewToken,
    summary,
    records,
    sourceContext,
    coverageGaps: records
      .filter((r) => r.problem || r.uncertainties.length)
      .map((r) => ({
        id: r.id,
        label: r.title,
        detail: [r.problem, ...r.uncertainties].filter(Boolean).join('; '),
        evidence: r.evidence,
      })),
  };
}

function occurrenceContext(
  db: DatabaseSync,
  file: SourceFileRow,
  inputFile: InputFileRow,
  entry: IntakeEntry,
  review: ClinicalReview,
  record: ClinicalReviewRecord,
  confirmationHashes: Map<IntakeReportSourceConfirmation, string>,
): IntakeOccurrenceContext {
  const acquisition = db
    .prepare('SELECT provider_id,sha256,bytes FROM source_files WHERE id=?')
    .get(file.id) as { provider_id: string; sha256: string; bytes: number } | undefined;
  if (!acquisition)
    throw new HttpError(409, 'SOURCE_CHANGED', 'The retained intake source is unavailable');
  const reportSource = intakeReportSourceForMember(
    file.reportSourceConfirmations,
    record.reportGroups,
    record,
    { proposalId: review.proposalId, recordId: record.id },
  );
  // Hash the entire immutable confirmation once per synchronous pass. Every
  // field remains pinned, without serializing all report members for every row.
  let confirmationHash: string | undefined;
  if (reportSource) {
    confirmationHash = confirmationHashes.get(reportSource.confirmation);
    if (!confirmationHash) {
      confirmationHash = hash(canonical(reportSource.confirmation));
      confirmationHashes.set(reportSource.confirmation, confirmationHash);
    }
  }
  const context = {
    intakeId: review.intakeId,
    proposalId: review.proposalId,
    candidateId: record.candidateId || '',
    candidateVersionId: record.candidateVersionId || '',
    inputFile: { id: inputFile.id, sha256: inputFile.sha256 },
    original: { id: file.id, ...acquisition },
    envelopeHash: intakeEnvelopeState(entry.value),
    mapping: record.mapping,
    identityAttribution: record.identityAttribution || null,
    identityReview: record.identityReview || null,
    reportGroups: record.reportGroups || [],
    reviewedReportSource: reportSource
      ? {
          confirmationHash,
          groupVersionId: reportSource.coverage.groupVersionId,
          contextId: reportSource.coverage.contextId,
          extensionId: reportSource.coverage.extensionId || null,
          coverageEntryId: reportSource.coverage.coverageEntryId || null,
        }
      : null,
    evidence: record.evidence,
  };
  return {
    intakeId: review.intakeId,
    intakeVersion: review.version,
    proposalId: review.proposalId,
    candidateId: record.candidateId || '',
    candidateVersionId: record.candidateVersionId || '',
    contextHash: hash(canonical(context)),
    locator: entry.value.provenance.locator,
    originalSourceFileId: file.id,
  };
}

export function retainedClinicalSourceRecord(
  entry: IntakeEntry,
  inputFileId: string,
  originalSourceFileId: string,
  proposalId: string | null,
  acquisitionProviderId: string,
  batchId: string,
): RetainedClinicalSourceRecord {
  return {
    id: `${inputFileId}:line:${entry.line}`,
    sourceFileId: inputFileId,
    providerId: acquisitionProviderId,
    sourceKey: `line:${entry.line}`,
    kind: 'intake_' + entry.value.kind,
    label: entry.value.id.slice(0, 500),
    raw: entry.raw,
    locator: JSON.stringify({
      line: entry.line,
      originalSourceFileId,
      selectedProposalId: proposalId,
      sourceEnvelopeId: entry.value.id,
      literal: true,
    }),
    extractionStatus: 'retained_unprojected',
    batchId,
  };
}

function authorizedIncomingProviderIds(
  acquisitionProviderId: string,
  file: SourceFileRow,
  review: ClinicalReview,
  record: ClinicalReviewRecord,
): Set<string> {
  const providers = new Set([acquisitionProviderId]);
  const confirmations = file.reportSourceConfirmations || [];
  // A previously projected row may retain a formerly current reviewed source.
  // Re-run the existing exact member resolver at each append-only history edge;
  // unrelated report confirmations never become provider authority for this row.
  for (let length = 1; length <= confirmations.length; length++) {
    const resolved = intakeReportSourceForMember(
      confirmations.slice(0, length),
      record.reportGroups,
      record,
      { proposalId: review.proposalId, recordId: record.id },
    );
    if (resolved) providers.add(resolved.confirmation.sourceProviderId);
  }
  return providers;
}

function verifyRetainedClinicalSourceRecord(
  db: DatabaseSync,
  file: SourceFileRow,
  inputFile: InputFileRow,
  entry: IntakeEntry,
  review: ClinicalReview,
  record: ClinicalReviewRecord,
): void {
  const acquisition = db.prepare('SELECT provider_id FROM source_files WHERE id=?').get(file.id) as
    { provider_id: string } | undefined;
  if (!acquisition)
    throw new HttpError(409, 'SOURCE_CHANGED', 'The retained intake source is unavailable');
  const expected = retainedClinicalSourceRecord(
    entry,
    inputFile.id,
    file.id,
    review.proposalId,
    acquisition.provider_id,
    String(file.batch_id),
  );
  const retained = db
    .prepare(
      'SELECT id,source_file_id,provider_id,source_key,kind,label,raw_json,locator_json,extraction_status,batch_id FROM source_records WHERE id=?',
    )
    .get(expected.id) as PartialSqlRow | undefined;
  if (
    !retained ||
    retained.id !== expected.id ||
    retained.source_file_id !== expected.sourceFileId ||
    retained.source_key !== expected.sourceKey ||
    retained.kind !== expected.kind ||
    retained.label !== expected.label ||
    retained.raw_json !== expected.raw ||
    retained.locator_json !== expected.locator ||
    retained.batch_id !== expected.batchId ||
    !['retained_unprojected', 'projected_reviewed'].includes(String(retained.extraction_status)) ||
    !authorizedIncomingProviderIds(acquisition.provider_id, file, review, record).has(
      String(retained.provider_id),
    )
  )
    throw new HttpError(
      409,
      'SOURCE_CHANGED',
      'Retained review evidence no longer matches its exact proposal and source authority',
    );
}

/** Finalize v2 scopes only after candidate/report and identity policy enrichment. */
export function finalizeClinicalPairScopes(
  db: DatabaseSync,
  file: SourceFileRow,
  inputFile: InputFileRow,
  entries: IntakeEntry[],
  review: ClinicalReview,
): void {
  const confirmationHashes = new Map<IntakeReportSourceConfirmation, string>();
  const entriesByRecordId = new Map(
    entries.map((entry) => [`${inputFile.id}:line:${entry.line}`, entry]),
  );
  for (const record of review.records) {
    if (!isClinicalKind(record.kind) || !record.comparisonReference) continue;
    const entry = entriesByRecordId.get(record.id);
    if (!entry) throw new Error('Clinical review entry is missing from its retained proposal');
    const occurrence = occurrenceContext(
      db,
      file,
      inputFile,
      entry,
      review,
      record,
      confirmationHashes,
    );
    record.comparisonContextHash = occurrence.contextHash;
    const incoming = {
      ...record.comparisonReference,
      id: record.id,
      evidence: record.evidence,
    };
    for (const comparison of record.comparisons) {
      const candidate = duplicateRecord(db, record.kind, comparison.id);
      comparison.scope = intakePairScope(db, incoming, candidate, occurrence);
      comparison.previousDecision = intakePairPreviousDecision(
        db,
        incoming,
        candidate,
        comparison.scope,
        occurrence.contextHash,
      );
      comparison.draftScopeStatus = intakePairDraftStatus(
        db,
        incoming,
        record.draft?.decision?.comparisons?.find(
          (decision) => decision.otherRecordId === comparison.id,
        ),
        occurrence,
      );
    }
    record.comparisonDrafts = (record.draft?.decision?.comparisons || []).map((decision) => ({
      otherRecordId: decision.otherRecordId,
      status: intakePairDraftStatus(db, incoming, decision, occurrence),
    }));
  }
}
export function conceptKey(mapping: ClinicalMapping): string {
  return hash([
    mapping.codeSystem,
    mapping.code,
    mapping.testLabel,
    mapping.observationCategory || '',
    mapping.unit,
    mapping.specimen,
    mapping.method,
  ]);
}
export function conceptId(db: DatabaseSync, mapping: ClinicalMapping): string {
  return (
    (
      db
        .prepare(
          "SELECT id FROM test_types WHERE json_extract(extra_json,'$.importConcept')=? ORDER BY id LIMIT 1",
        )
        .get(conceptKey(mapping)) as { id?: string } | undefined
    )?.id || 'test:import:' + conceptKey(mapping)
  );
}

function insert(
  db: DatabaseSync,
  table: string,
  value: Record<string, SqlValue | undefined>,
): void {
  const keys = Object.keys(value);
  db.prepare(
    `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
  ).run(...keys.map((k) => value[k] ?? null));
}
const classificationRuleFields: Partial<Record<ClinicalKind, (keyof ClinicalMapping)[]>> = {
  observation: ['kind', 'testLabel', 'observationCategory'],
  procedure: ['kind', 'procedureLabel', 'procedureCategory'],
  document: ['kind', 'documentTitle', 'documentCategory'],
};
function validateFutureClassificationRule(rule: MappingRule): void {
  const targetKind = rule?.set?.kind;
  const allowed = targetKind ? classificationRuleFields[targetKind] : undefined;
  if (
    rule?.scope !== 'future_imports' ||
    !Object.hasOwn(classificationRuleFields, rule.match?.kind) ||
    !Array.isArray(allowed) ||
    rule.set.kind === rule.match.kind ||
    typeof rule.match.label !== 'string' ||
    !rule.match.label.trim() ||
    rule.match.label.length > 500 ||
    typeof rule.match.sourceSystem !== 'string' ||
    !rule.match.sourceSystem.trim() ||
    rule.match.sourceSystem.length > 500 ||
    Object.keys(rule.match).some((key) => !['kind', 'label', 'sourceSystem'].includes(key)) ||
    !allowed ||
    Object.entries(rule.set).some(
      ([key, value]) =>
        !allowed.includes(key as keyof ClinicalMapping) ||
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > 500,
    ) ||
    !(rule.set as Record<string, unknown>)[
      { observation: 'testLabel', procedure: 'procedureLabel', document: 'documentTitle' }[
        rule.set.kind as 'observation' | 'procedure' | 'document'
      ]
    ] ||
    (rule.set.procedureCategory && !category.includes(rule.set.procedureCategory))
  )
    throw new HttpError(
      400,
      'MAPPING_RULE',
      'A future classification rule requires an exact source system, source kind and label, a target kind and label; values, dates, doses and individual identities cannot be reused',
    );
}
function futureClassificationPreview(db: DatabaseSync, providerId: string, rule: MappingRule) {
  validateFutureClassificationRule(rule);
  if (!db.prepare('SELECT 1 FROM providers WHERE id=?').get(providerId))
    throw new HttpError(404, 'SOURCE_NOT_FOUND', 'Source not found');
  const matches: FutureClassificationMatch[] = [];
  for (const table of ['observations', 'procedures', 'documents']) {
    for (const row of db
      .prepare(
        `SELECT id,extra_json,source_record_id FROM ${table} WHERE provider_id=? ORDER BY id`,
      )
      .all(providerId) as PartialSqlRow[]) {
      const imported = parsedObject(parsedObject(row.extra_json).import);
      const originalMapping = parsedObject(imported.originalMapping) as unknown as ClinicalMapping;
      if (
        !imported ||
        originalMapping.kind !== rule.match.kind ||
        labelOf(originalMapping) !== rule.match.label ||
        imported.sourceSystem !== rule.match.sourceSystem
      )
        continue;
      const recordException = parsedObject(imported.recordException);
      const excepted = parsedObject(recordException.set);
      const after: ClinicalMapping = {
        ...originalMapping,
        ...rule.set,
        ...(Object.keys(recordException).length ? { kind: originalMapping.kind, ...excepted } : {}),
      };
      matches.push({
        id: String(row.id),
        before: imported.acceptedMapping,
        after,
        sourceRecordId: String(row.source_record_id),
        individualException: Object.keys(recordException).length > 0,
        problem: checkClinicalMapping(after),
      });
    }
  }
  return {
    token: hash([revision(db), providerId, rule, matches]),
    version: revision(db),
    scope: 'future_imports',
    count: 0,
    matchingExistingCount: matches.length,
    exceptionCount: matches.filter((item) => item.individualException).length,
    examples: matches.slice(0, 30),
    complete: matches.length <= 30,
    match: {
      providerId,
      providerName: (
        db.prepare('SELECT name FROM providers WHERE id=?').get(providerId) as { name: string }
      ).name,
      ...rule.match,
    },
    set: rule.set,
    sourceUnchanged: true,
    requiresImportReview: true,
  };
}
export function saveMappingRule(
  db: DatabaseSync,
  providerId: string,
  rule: MappingRule,
  batchId: string,
): string {
  if (rule?.scope === 'future_imports') validateFutureClassificationRule(rule);
  if (
    !rule ||
    typeof rule !== 'object' ||
    !kinds.includes(rule.match?.kind) ||
    typeof rule.match.label !== 'string' ||
    !rule.match.label.trim()
  )
    throw new HttpError(400, 'MAPPING_RULE', 'A rule needs an exact kind and source label');
  const allowed =
    rule.scope === 'future_imports'
      ? classificationRuleFields[rule.set.kind!]
      : {
          observation: ['testLabel'],
          medication: ['medicationName'],
          procedure: ['procedureLabel', 'procedureCategory'],
          document: ['documentTitle'],
        }[rule.match.kind];
  const set = rule.set;
  if (
    !set ||
    typeof set !== 'object' ||
    !Object.keys(set).length ||
    Object.keys(set).some(
      (k) =>
        !allowed?.includes(k as keyof ClinicalMapping) ||
        typeof set[k as keyof ClinicalMapping] !== 'string' ||
        !String(set[k as keyof ClinicalMapping]).trim() ||
        String(set[k as keyof ClinicalMapping]).length > 500,
    )
  )
    throw new HttpError(
      400,
      'MAPPING_RULE',
      'Reusable rules may only rename labels or classify procedure categories; values/dates/doses are never reused',
    );
  if (set.procedureCategory && !category.includes(set.procedureCategory))
    throw new HttpError(400, 'MAPPING_RULE', 'Invalid procedure category');
  const id = 'mapping:' + hash([batchId, providerId, rule]);
  if (db.prepare('SELECT 1 FROM manual_batches WHERE id=?').get(id)) return id;
  insert(db, 'manual_batches', {
    id,
    title: 'Import mapping decision',
    status: 'verified',
    created_at: now(),
    verified_at: now(),
    notes: 'User-approved exact-label mapping; originals preserved.',
    coverage_json: JSON.stringify({
      mappingRule: {
        providerId,
        ...(rule.scope ? { scope: rule.scope } : {}),
        match: rule.match,
        set,
        replaces: rule.replaces || null,
        sequence: Number(
          (
            db
              .prepare(
                "SELECT COALESCE(MAX(json_extract(coverage_json,'$.mappingRule.sequence')),0)+1 AS n FROM manual_batches",
              )
              .get() as { n: number | bigint }
          ).n,
        ),
      },
    }),
  });
  return id;
}
export function assertClinicalSourceScopes(
  db: DatabaseSync,
  file: SourceFileRow,
  inputFile: InputFileRow,
  entries: IntakeEntry[],
  decisions: IntakeReviewDecision[],
): void {
  const selected = new Map(decisions.map((decision) => [decision.recordId, decision]));
  const mutatingEntries = entries.filter((entry) => {
    const decision = selected.get(`${inputFile.id}:line:${entry.line}`);
    return decision?.action === 'accept' || !!decision?.comparisons?.length;
  });
  const scopeProblem = clinicalSourceScopeCheck(db, file, mutatingEntries, inputFile.id);
  for (const entry of mutatingEntries) {
    const problem = scopeProblem(entry);
    if (problem) throw new HttpError(409, 'CLINICAL_SOURCE_SCOPE_COLLISION', problem);
  }
}

export function validateClinicalPairScopes(
  db: DatabaseSync,
  file: SourceFileRow,
  inputFile: InputFileRow,
  entries: IntakeEntry[],
  review: ClinicalReview,
  decisions: IntakeReviewDecision[],
): Set<string> {
  const confirmationHashes = new Map<IntakeReportSourceConfirmation, string>();
  const selected = new Map(decisions.map((decision) => [decision.recordId, decision]));
  assertClinicalSourceScopes(db, file, inputFile, entries, decisions);
  const entriesByRecordId = new Map(
    entries.map((entry) => [`${inputFile.id}:line:${entry.line}`, entry]),
  );
  const validated = new Set<string>();
  for (const record of review.records) {
    const entry = entriesByRecordId.get(record.id);
    if (!entry) throw new Error('Clinical review entry is missing from its retained proposal');
    if (!isClinicalKind(record.kind)) continue;
    const occurrence = occurrenceContext(
      db,
      file,
      inputFile,
      entry,
      review,
      record,
      confirmationHashes,
    );
    const incoming = {
      id: record.id,
      kind: record.kind,
      sourceRecordId: record.id,
      identity: identity(entry, file),
      version: clinicalVersion(record.mapping),
      evidence: record.evidence,
      stateHash: intakeEnvelopeState(entry.value),
    };
    const comparisons = selected.get(record.id)?.comparisons || [];
    if (comparisons.filter((item) => item.occurrenceEvidence === 'attach').length > 1)
      throw new HttpError(
        400,
        'DUPLICATE_DECISION',
        'Attach one incoming occurrence to at most one reviewed saved record',
      );
    for (const comparison of comparisons) {
      const target = duplicateRecord(db, record.kind, comparison.otherRecordId);
      requireIntakePairScope(
        db,
        incoming,
        target,
        comparison.scope,
        comparison.scope?.format === 'intake-pair-scope-v2' ? occurrence : undefined,
      );
      validated.add(hash(canonical([record.id, comparison])));
    }
  }
  return validated;
}

export function projectClinicalReview(
  db: DatabaseSync,
  {
    file,
    inputFile,
    entries,
    review,
    decisions,
    root,
    profileId,
    prevalidatedPairScopes,
    occurrenceAuthorityFinalizers: compoundOccurrenceFinalizers,
  }: ProjectReviewInput,
): ProjectionResults {
  const confirmationHashes = new Map<IntakeReportSourceConfirmation, string>();
  const selected = new Map<string, IntakeReviewDecision>(
    (decisions || []).map((decision) => [decision.recordId, decision]),
  );
  if (
    selected.size !== (decisions || []).length ||
    [...selected.keys()].some((id) => !review.records.some((r) => r.id === id))
  )
    throw new HttpError(400, 'IMPORT_REVIEW', 'Unknown or repeated review decision');
  const results: ProjectionResults = {
    added: 0,
    duplicates: 0,
    retainedOnly: 0,
    versions: 0,
    ruleIds: [],
    records: [],
  };
  const entriesByRecordId = new Map(
    entries.map((entry) => [`${inputFile.id}:line:${entry.line}`, entry]),
  );
  // A coordinator may have prepared multiple blocks against one unchanged
  // snapshot. Recheck against earlier blocks in this transaction even when
  // paired-evidence scopes were already prevalidated.
  assertClinicalSourceScopes(db, file, inputFile, entries, decisions || []);
  // INSERT OR IGNORE materialization is not authority. Prove every existing
  // deterministic row before any provider, relationship, evidence, workflow,
  // or accepted clinical write in this compound projection.
  for (const record of review.records) {
    const entry = entriesByRecordId.get(record.id);
    if (!entry) throw new Error('Clinical review entry is missing from its retained proposal');
    verifyRetainedClinicalSourceRecord(db, file, inputFile, entry, review, record);
  }
  prevalidatedPairScopes ||= validateClinicalPairScopes(
    db,
    file,
    inputFile,
    entries,
    review,
    decisions || [],
  );
  const verifiedComparisonOriginals = new Set<string>();
  const occurrenceAuthorityFinalizers: OccurrenceAuthorityFinalizer[] = [];
  for (const record of review.records) {
    const entry = entriesByRecordId.get(record.id);
    if (!entry) throw new Error('Clinical review entry is missing from its retained proposal');
    const reportSourceResolution = intakeReportSourceForMember(
      file.reportSourceConfirmations,
      record.reportGroups,
      record,
      { proposalId: review.proposalId, recordId: record.id },
    );
    const reportSource = reportSourceResolution?.confirmation;
    const reviewedReportSource = reportSourceResolution
      ? {
          ...(reportSourceResolution.confirmation.basis
            ? { basis: reportSourceResolution.confirmation.basis }
            : {}),
          source: reportSourceResolution.confirmation.source,
          sourceProviderId: reportSourceResolution.confirmation.sourceProviderId,
          groupId: reportSourceResolution.confirmation.groupId,
          groupVersionId: reportSourceResolution.coverage.groupVersionId,
          contextId: reportSourceResolution.coverage.contextId,
          operationId: reportSourceResolution.confirmation.operationId,
          ...(reportSourceResolution.coverage.extensionId
            ? { scopeExtensionId: reportSourceResolution.coverage.extensionId }
            : {}),
          ...(reportSourceResolution.coverage.coverageEntryId
            ? { coverageEntryId: reportSourceResolution.coverage.coverageEntryId }
            : {}),
          candidateId: record.candidateId,
          candidateVersionId: record.candidateVersionId,
          recordId: record.id,
        }
      : null;
    const recordFile = reportSource
      ? {
          ...file,
          provider_id: reportSource.sourceProviderId,
          provider: reportSource.source,
        }
      : file;
    const decision =
      selected.get(record.id) ||
      ({
        recordId: record.id,
        action: 'skip',
        mapping: record.mapping as IntakeClinicalMapping,
      } satisfies IntakeReviewDecision);
    if (!['accept', 'skip'].includes(decision.action))
      throw new HttpError(400, 'IMPORT_REVIEW', 'Choose accept or skip');
    if (
      decision.comparisons !== undefined &&
      (!Array.isArray(decision.comparisons) ||
        decision.comparisons.length > 100 ||
        decision.comparisons.some(
          (item) =>
            !item ||
            typeof item !== 'object' ||
            Object.keys(item).some(
              (key) =>
                !['otherRecordId', 'scope', 'outcome', 'reason', 'occurrenceEvidence'].includes(
                  key,
                ),
            ) ||
            typeof item.otherRecordId !== 'string' ||
            !['same_event', 'changed_version', 'distinct', 'unresolved'].includes(item.outcome) ||
            typeof item.reason !== 'string' ||
            (item.occurrenceEvidence !== undefined &&
              (item.occurrenceEvidence !== 'attach' || item.outcome !== 'same_event')),
        ) ||
        new Set(decision.comparisons.map((item) => item.otherRecordId)).size !==
          decision.comparisons.length)
    )
      throw new HttpError(400, 'DUPLICATE_DECISION', 'Provide unique paired-evidence decisions');
    const recordComparisons = decision.comparisons || [];
    const markedComparisons = recordComparisons.filter(
      (comparison) => comparison.occurrenceEvidence === 'attach',
    );
    if (markedComparisons.length > 1)
      throw new HttpError(
        400,
        'DUPLICATE_DECISION',
        'Attach one incoming occurrence to at most one reviewed saved record',
      );
    const recordOccurrence = occurrenceContext(
      db,
      file,
      inputFile,
      entry,
      review,
      record,
      confirmationHashes,
    );
    const saveComparisons = (mapping: ClinicalMapping, entityId = record.id): void => {
      for (const comparison of [...recordComparisons].sort(
        (left, right) =>
          Number(left.occurrenceEvidence === 'attach') -
          Number(right.occurrenceEvidence === 'attach'),
      )) {
        // A scoped result from any search page is valid; the default page is not an allowlist.
        const target = duplicateRecord(db, mapping.kind, comparison.otherRecordId);
        const targetTable = {
          observation: 'observations',
          medication: 'medications',
          procedure: 'procedures',
          document: 'documents',
        }[mapping.kind as ClinicalKind];
        const targetOwner =
          targetTable &&
          db
            .prepare(
              `SELECT ${targetTable === 'documents' ? "COALESCE(json_extract(extra_json,'$.import.personId'),'patient')" : 'person_id'} AS personId FROM ${targetTable} WHERE id=?`,
            )
            .get(target.id)?.personId;
        if (targetOwner !== (mapping.personId || 'patient'))
          throw new HttpError(
            409,
            'IDENTITY_SELECTION',
            'Clinical comparisons must stay within the selected person',
          );
        const left = {
          id: entityId,
          kind: mapping.kind as ClinicalKind,
          sourceRecordId: record.id,
          identity: identity(entry, recordFile),
          version: clinicalVersion(mapping),
          evidence: record.evidence,
          stateHash: intakeEnvelopeState(entry.value),
        };
        const scopedOccurrence =
          comparison.scope?.format === 'intake-pair-scope-v2' ? recordOccurrence : undefined;
        if (!prevalidatedPairScopes.has(hash(canonical([record.id, comparison]))))
          throw new HttpError(
            409,
            'DUPLICATE_SCOPE_CHANGED',
            'The paired-evidence request was not validated against the transaction snapshot',
          );
        if (
          canonicalLiteral(comparison.scope?.incoming) !==
          canonicalLiteral(intakePairReference(db, left))
        )
          throw new HttpError(
            409,
            'DUPLICATE_SCOPE_CHANGED',
            'The incoming clinical mapping changed after paired-evidence review',
          );
        if (!root)
          throw new HttpError(
            409,
            'DUPLICATE_EVIDENCE',
            'Open the retained originals before applying this relationship',
          );
        verifyDuplicateOriginals(db, root, profileId, target, verifiedComparisonOriginals);
        const savedDecision = saveDuplicateDecision(
          db,
          left,
          target,
          comparison,
          hash([review.reviewToken, record.id, comparison]),
          {
            incoming: left,
            scope: comparison.scope,
            occurrence: scopedOccurrence,
            prevalidated: true,
          },
        );
        if (savedDecision.occurrenceAttachment && scopedOccurrence)
          occurrenceAuthorityFinalizers.push({
            decision: savedDecision,
            incoming: left,
            context: scopedOccurrence,
          });
      }
    };
    if (decision.action === 'skip') {
      saveComparisons(record.mapping);
      results.retainedOnly++;
      continue;
    }
    const mapping = { ...record.mapping };
    if (
      mapping.personId &&
      record.identityAttribution?.assignedPerson?.personId !== mapping.personId
    )
      throw new HttpError(
        409,
        'IDENTITY_SELECTION',
        'The selected person requires an exact retained identity confirmation',
      );
    for (const [k, v] of Object.entries(decision.mapping || {})) {
      if (canonical(v) === canonical((record.mapping as unknown as Record<string, unknown>)[k]))
        continue;
      if (
        ![
          'kind',
          'date',
          ...clinicalFields.observation,
          ...clinicalFields.medication,
          ...clinicalFields.procedure,
          ...clinicalFields.document,
        ].includes(k) ||
        !validClinicalFieldValue(k as keyof IntakeClinicalMapping, v)
      )
        throw new HttpError(400, 'IMPORT_MAPPING', 'Unsupported mapping edit');
      (mapping as unknown as Record<string, unknown>)[k] = v;
    }
    const problem = checkClinicalMapping(mapping) || assetProblem(db, file, mapping);
    if (problem) throw new HttpError(400, 'IMPORT_MAPPING', problem);
    const marked = markedComparisons[0];
    if (marked) {
      if (decision.rememberRule)
        throw new HttpError(
          400,
          'MAPPING_RULE',
          'An occurrence attachment cannot also create a reusable clinical mapping rule',
        );
      const target = duplicateRecord(db, mapping.kind, marked.otherRecordId);
      if (target.kind !== mapping.kind)
        throw new HttpError(
          409,
          'OCCURRENCE_ATTACHMENT_KIND',
          'Attach an incoming occurrence only to a reviewed record of the same clinical kind',
        );
      // The final durable authority observes the authorized incoming provider
      // and extraction state, while the request scope remains the pre-write CAS.
      if (reportSource)
        db.prepare('UPDATE source_records SET provider_id=? WHERE id=?').run(
          reportSource.sourceProviderId,
          record.id,
        );
      db.prepare("UPDATE source_records SET extraction_status='projected_reviewed' WHERE id=?").run(
        record.id,
      );
      // The reviewed left side remains the retained incoming occurrence. The
      // matched entity is the right-side target and is returned separately.
      saveComparisons(mapping);
      retainAcceptedContribution(db, {
        sourceRecordId: record.id,
        identity: identity(entry, recordFile),
        recordId: target.id,
        kind: target.kind,
        mapping: mapping as IntakeClinicalMapping,
        intakeId: file.id,
        candidateVersionId: record.candidateVersionId || null,
      });
      results.duplicates++;
      results.records.push({
        recordId: record.id,
        entityId: target.id,
        kind: target.kind,
        title: target.title,
        optical: false,
        outcome: 'matched',
        ...(record.identityAttribution ? { identityAttribution: record.identityAttribution } : {}),
      });
      continue;
    }
    const withdrawsActiveAttachment = recordComparisons.some(
      (comparison) =>
        comparison.outcome !== 'same_event' &&
        comparison.scope?.format === 'intake-pair-scope-v2' &&
        comparison.scope.activeAttachment !== null,
    );
    if (withdrawsActiveAttachment) {
      if (reportSource)
        db.prepare('UPDATE source_records SET provider_id=? WHERE id=?').run(
          reportSource.sourceProviderId,
          record.id,
        );
      db.prepare("UPDATE source_records SET extraction_status='projected_reviewed' WHERE id=?").run(
        record.id,
      );
    }
    // The accepted mapping defaults to Self when personId is absent. Record
    // that decision as evidence too, so packet ownership survives cache loss.
    const assignedPersonId = mapping.personId || 'patient';
    db.prepare(
      "INSERT OR IGNORE INTO evidence(id,entity_type,entity_id,source_record_id,role,locator_json) VALUES(?,'person',?,?,'report_subject',?)",
    ).run(
      'identity-person:' + hash([assignedPersonId, record.id]),
      assignedPersonId,
      record.id,
      JSON.stringify({
        intakeId: file.id,
        confirmationOperationId: record.identityAttribution?.confirmationOperationId,
      }),
    );
    const identityKey = identity(entry, recordFile),
      versionKey = clinicalVersion(mapping),
      found =
        correctedOccurrence(db, identityKey, recordFile.sha256, entry.value, mapping) ||
        previous(db, identityKey, versionKey, mapping.personId);
    const exceptionSet = Object.fromEntries(
      Object.entries(decision.mapping || {}).filter(
        ([key, value]) =>
          canonical(value) !==
            canonical((record.undraftedMapping as unknown as Record<string, unknown>)[key]) &&
          !Object.hasOwn(decision.rememberRule?.set || {}, key),
      ),
    );
    const recordException = Object.keys(exceptionSet).length
      ? saveRecordException(
          db,
          recordFile,
          entry,
          identityKey,
          { ...record.recordException?.set, ...exceptionSet, kind: mapping.kind },
          record.id,
        )
      : record.recordException;
    let entityId: string,
      entityKind: ClinicalKind = mapping.kind as ClinicalKind,
      reviewedSourceOutcome: {
        destinationProviderId: string;
        destinationProvider: string;
        outcome: 'assigned' | 'enriched_unknown' | 'preserved_known';
      } | null = null;
    if (found?.exact) {
      entityId = found.id;
      entityKind = found.kind;
      if (recordException || reviewedReportSource || record.identityAttribution) {
        const table = {
            observation: 'observations',
            medication: 'medications',
            procedure: 'procedures',
            document: 'documents',
          }[entityKind],
          existingRow = db
            .prepare(
              `SELECT r.extra_json,r.provider_id,p.name AS provider_name FROM ${table} r LEFT JOIN providers p ON p.id=r.provider_id WHERE r.id=?`,
            )
            .get(entityId) as PartialSqlRow,
          existing = parsedObject(existingRow.extra_json),
          imported = parsedObject(existing.import);
        if (recordException) imported.recordException = recordException;
        if (record.identityAttribution) {
          const priorAttributions = Array.isArray(imported.identityAttributions)
            ? imported.identityAttributions.filter(
                (attribution): attribution is Record<string, unknown> =>
                  !!attribution && typeof attribution === 'object' && !Array.isArray(attribution),
              )
            : imported.identityAttribution && typeof imported.identityAttribution === 'object'
              ? [imported.identityAttribution as Record<string, unknown>]
              : [];
          if (
            !priorAttributions.some(
              (attribution) => canonical(attribution) === canonical(record.identityAttribution),
            )
          )
            priorAttributions.push(
              record.identityAttribution as unknown as Record<string, unknown>,
            );
          if (!imported.identityAttribution)
            imported.identityAttribution = record.identityAttribution;
          imported.identityAttributions = priorAttributions;
        }
        let destinationProviderId = String(existingRow.provider_id || ''),
          destinationProvider = String(existingRow.provider_name || 'Unknown source'),
          sourceOutcome: 'enriched_unknown' | 'preserved_known' = 'preserved_known';
        if (
          record.manuallyEdited ||
          clinicalMappingChanged(decision.mapping, record.undraftedMapping)
        )
          imported.manuallyEdited = true;
        if (reviewedReportSource) {
          const priorSources = Array.isArray(imported.reviewedReportSources)
            ? imported.reviewedReportSources.filter(
                (source): source is Record<string, unknown> =>
                  !!source && typeof source === 'object' && !Array.isArray(source),
              )
            : imported.reviewedReportSource && typeof imported.reviewedReportSource === 'object'
              ? [imported.reviewedReportSource as Record<string, unknown>]
              : [];
          if (!priorSources.some((source) => canonical(source) === canonical(reviewedReportSource)))
            priorSources.push(reviewedReportSource);
          if (!imported.reviewedReportSource) imported.reviewedReportSource = reviewedReportSource;
          imported.reviewedReportSources = priorSources;
          if (destinationProviderId === UNKNOWN_SOURCE_PROVIDER_ID) {
            destinationProviderId = reportSource!.sourceProviderId;
            destinationProvider = reportSource!.source;
            sourceOutcome = 'enriched_unknown';
          }
          reviewedSourceOutcome = {
            destinationProviderId,
            destinationProvider,
            outcome: sourceOutcome,
          };
        }
        if (record.draft?.corrections?.length) {
          const prior = Array.isArray(imported.corrections) ? imported.corrections : [];
          imported.corrections = [
            ...prior,
            ...record.draft.corrections.filter(
              (correction) =>
                !prior.some(
                  (item: { operationId?: string }) => item.operationId === correction.operationId,
                ),
            ),
          ];
        }
        existing.import = imported;
        db.prepare(`UPDATE ${table} SET provider_id=?,extra_json=? WHERE id=?`).run(
          destinationProviderId || existingRow.provider_id || null,
          JSON.stringify(existing),
          entityId,
        );
      }
      results.duplicates++;
    } else {
      entityId = `import:${mapping.kind}:${hash([identityKey, versionKey])}`;
      const extra = {
        import: {
          identity: identityKey,
          version: versionKey,
          acceptedMapping: mapping,
          personId: mapping.personId || 'patient',
          originalMapping: mappingFrom(entry),
          ...(record.draft?.corrections?.length ? { corrections: record.draft.corrections } : {}),
          recordException,
          manuallyEdited:
            record.manuallyEdited ||
            clinicalMappingChanged(decision.mapping, record.undraftedMapping),
          ...(record.identityAttribution
            ? {
                identityAttribution: record.identityAttribution,
                identityAttributions: [record.identityAttribution],
              }
            : {}),
          intakeId: file.id,
          ...(file.reviewedMetadata ? { reviewedSourceMetadata: file.reviewedMetadata } : {}),
          ...(reviewedReportSource
            ? {
                reviewedReportSource,
                reviewedReportSources: [reviewedReportSource],
              }
            : {}),
          sourceSystem: entry.value.provenance.sourceSystem,
          sourceRecordId: entry.value.provenance.sourceRecordId,
          ruleIds: record.appliedRuleIds,
          ...(found
            ? {
                priorEntity: {
                  id: found.id,
                  kind: found.kind,
                  sourceRecordId: found.source_record_id,
                },
              }
            : {}),
        },
        datePrecision: datePrecision(mapping.date),
        attribution: entry.value.provenance,
        ...(mapping.kind === 'medication'
          ? {
              sourceFields: {
                recordedDate: mapping.dateRole === 'recorded' ? mapping.date : null,
              },
            }
          : {}),
      };
      insertClinicalProjection(db, entityId, record.id, recordFile.provider_id, mapping, extra);
      if (mapping.kind === 'medication') appendImportedMedicationDefault(db, entityId);
      if (reportSource)
        reviewedSourceOutcome = {
          destinationProviderId: reportSource.sourceProviderId,
          destinationProvider: reportSource.source,
          outcome: 'assigned',
        };
      results.added++;
      if (found) {
        if (record.id !== found.source_record_id)
          db.prepare(
            "INSERT OR IGNORE INTO record_relationships(id,from_record_id,to_record_id,relation,status,rationale) VALUES(?,?,?,'source_version','accepted',?)",
          ).run(
            'rel:' + hash([record.id, found.source_record_id]),
            record.id,
            found.source_record_id,
            'Same issuing source/record identity, changed extracted assertion; both retained without assuming which is current.',
          );
        results.versions++;
      }
    }
    retainAcceptedContribution(db, {
      sourceRecordId: record.id,
      identity: identityKey,
      recordId: entityId,
      kind: entityKind,
      mapping: mapping as IntakeClinicalMapping,
      intakeId: file.id,
      candidateVersionId: record.candidateVersionId || null,
    });
    saveComparisons(mapping, entityId);
    results.records.push({
      recordId: record.id,
      entityId,
      kind: entityKind,
      title: labelOf(mapping),
      optical: mapping.kind === 'document' && mapping.opticalPrescription != null,
      outcome: found?.exact ? 'matched' : found ? 'updated' : 'added',
      ...(record.identityAttribution ? { identityAttribution: record.identityAttribution } : {}),
      ...(reviewedReportSource && reviewedSourceOutcome
        ? {
            reviewedSource: {
              ...(reviewedReportSource.basis ? { basis: reviewedReportSource.basis } : {}),
              source: reviewedReportSource.source,
              sourceProviderId: reviewedReportSource.sourceProviderId,
              confirmationOperationId: reviewedReportSource.operationId,
              groupId: reviewedReportSource.groupId,
              groupVersionId: reviewedReportSource.groupVersionId,
              ...(reviewedReportSource.coverageEntryId
                ? { coverageEntryId: reviewedReportSource.coverageEntryId }
                : {}),
              ...reviewedSourceOutcome,
            },
          }
        : {}),
    });
    db.prepare(
      "INSERT OR IGNORE INTO evidence(id,entity_type,entity_id,source_record_id,role,locator_json) VALUES(?,?,?,?, 'source',?)",
    ).run(
      'evidence:' + hash([entityKind, entityId, record.id]),
      entityKind,
      entityId,
      record.id,
      JSON.stringify({
        locator: entry.value.provenance.locator,
        originalSourceFileId: file.id,
        reviewed: true,
      }),
    );
    if (reportSource)
      db.prepare('UPDATE source_records SET provider_id=? WHERE id=?').run(
        reportSource.sourceProviderId,
        record.id,
      );
    db.prepare("UPDATE source_records SET extraction_status='projected_reviewed' WHERE id=?").run(
      record.id,
    );
    for (const sourceId of [file.id, ...mapping.assets]) {
      const assetFile = db.prepare('SELECT * FROM source_files WHERE id=?').get(sourceId) as
        AssetFileRow | undefined;
      if (assetFile && root) {
        verifyIntakeFileHash(profileOriginal(root, assetFile.path, profileId), assetFile);
      }
      if (
        !assetFile ||
        !['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(assetFile.mime_type)
      )
        continue;
      const assetId = 'asset:import:' + hash(assetFile.id);
      db.prepare(
        'INSERT OR IGNORE INTO assets(id,original_name,stored_path,mime_type,bytes,sha256,created_at,attribution,source_file_id) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(
        assetId,
        assetFile.path.split('/').at(-1) ?? 'retained-evidence',
        assetFile.path,
        assetFile.mime_type,
        assetFile.bytes,
        assetFile.sha256,
        now(),
        'provider-evidence',
        assetFile.id,
      );
      const attached = db
        .prepare('SELECT id FROM assets WHERE stored_path=?')
        .get(assetFile.path) as { id: string };
      if (
        !db
          .prepare('SELECT 1 FROM attachments WHERE owner_type=? AND owner_id=? AND asset_id=?')
          .get(entityKind, entityId, attached.id)
      )
        insert(db, 'attachments', {
          id: 'attachment:import:' + hash([entityKind, entityId, attached.id]),
          asset_id: attached.id,
          owner_type: entityKind,
          owner_id: entityId,
          caption: entry.value.provenance.locator,
          created_at: now(),
        });
    }
    if (decision.rememberRule)
      results.ruleIds.push(
        saveMappingRule(
          db,
          recordFile.provider_id,
          decision.rememberRule as unknown as MappingRule,
          file.id,
        ),
      );
  }
  if (compoundOccurrenceFinalizers)
    compoundOccurrenceFinalizers.push(...occurrenceAuthorityFinalizers);
  else refreshOccurrenceAttachmentAuthorities(db, occurrenceAuthorityFinalizers);
  return results;
}

function affectedRows(
  db: DatabaseSync,
  providerId: string,
  rule: MappingRule,
): { table: string; row: PartialSqlRow }[] {
  const table = (
    {
      observation: 'observations',
      medication: 'medications',
      procedure: 'procedures',
      document: 'documents',
    } as Record<ClinicalKind, string>
  )[rule.match?.kind];
  if (!table) return [];
  const column = rule.match.kind === 'document' ? 'title' : 'label';
  return db
    .prepare(
      `SELECT * FROM ${table} WHERE provider_id=? AND (${column}=? OR json_extract(extra_json,'$.import.originalMapping.'||?)=?) ORDER BY id`,
    )
    .all(
      providerId,
      rule.match.label,
      rule.match.kind === 'observation'
        ? 'testLabel'
        : rule.match.kind === 'medication'
          ? 'medicationName'
          : rule.match.kind === 'procedure'
            ? 'procedureLabel'
            : 'documentTitle',
      rule.match.label,
    )
    .filter((row) => {
      const typedRow = row as PartialSqlRow;
      const extra = parsedObject(typedRow.extra_json),
        saved = parsedObject(parsedObject(extra.import).recordException || extra.recordException);
      return (
        !Object.keys(saved).length ||
        !Object.keys(rule.set).some((field) => Object.hasOwn(parsedObject(saved.set), field))
      );
    })
    .map((row) => ({ table, row: row as PartialSqlRow }));
}
export function previewMappingChange(db: DatabaseSync, providerId: string, rule: MappingRule) {
  if (rule?.scope === 'future_imports') return futureClassificationPreview(db, providerId, rule);
  // Validate without writing by using the same narrow field policy.
  const allowed = {
    observation: ['testLabel'],
    medication: ['medicationName'],
    procedure: ['procedureLabel', 'procedureCategory'],
    document: ['documentTitle'],
  };
  if (
    !rule ||
    !allowed[rule.match?.kind] ||
    !clean(rule.match.label) ||
    !rule.set ||
    !Object.keys(rule.set).length ||
    Object.entries(rule.set).some(
      ([k, v]) =>
        !allowed[rule.match.kind].includes(k) ||
        typeof v !== 'string' ||
        !v.trim() ||
        v.length > 500,
    ) ||
    (rule.set.procedureCategory && !category.includes(rule.set.procedureCategory))
  )
    throw new HttpError(
      400,
      'MAPPING_RULE',
      'Choose an exact source label and a supported label/category correction',
    );
  if (!db.prepare('SELECT 1 FROM providers WHERE id=?').get(providerId))
    throw new HttpError(404, 'SOURCE_NOT_FOUND', 'Source not found');
  const affected = affectedRows(db, providerId, rule);
  return {
    token: hash([revision(db), providerId, rule, affected]),
    version: revision(db),
    count: affected.length,
    examples: affected.slice(0, 30).map(({ row }) => ({
      id: row.id,
      before: row.label || row.title,
      after:
        rule.set.testLabel ||
        rule.set.medicationName ||
        rule.set.procedureLabel ||
        rule.set.documentTitle ||
        row.label,
      category: rule.set.procedureCategory || row.category,
      sourceRecordId: row.source_record_id,
    })),
    complete: affected.length <= 30,
  };
}
export function applyMappingRows(
  db: DatabaseSync,
  providerId: string,
  rule: MappingRule,
): {
  id: string;
  kind: ClinicalKind;
  before: unknown;
  after: Partial<ClinicalMapping>;
  sourceRecordId: string;
}[] {
  if (rule?.scope === 'future_imports') {
    validateFutureClassificationRule(rule);
    return [];
  }
  const changes: {
    id: string;
    kind: ClinicalKind;
    before: unknown;
    after: Partial<ClinicalMapping>;
    sourceRecordId: string;
  }[] = [];
  const affected = affectedRows(db, providerId, rule);
  const groupSizes = new Map<string, number>();
  for (const { row } of affected)
    if (row.test_type_id)
      groupSizes.set(row.test_type_id, (groupSizes.get(row.test_type_id) || 0) + 1);
  const originalGroupSizes = new Map(
    [...groupSizes.keys()].map((id) => [
      id,
      Number(
        (
          db.prepare('SELECT COUNT(*) AS n FROM observations WHERE test_type_id=?').get(id) as {
            n: number | bigint;
          }
        ).n,
      ),
    ]),
  );
  for (const { table, row } of affected) {
    const label =
      rule.set.testLabel ||
      rule.set.medicationName ||
      rule.set.procedureLabel ||
      rule.set.documentTitle;
    const extra = parsedObject(row.extra_json);
    const imported = parsedObject(extra.import);
    const acceptedMapping = parsedObject(imported.acceptedMapping);
    const prior = {
      label: row.label || row.title,
      category: row.category,
      testTypeId: row.test_type_id,
    };
    if (Object.keys(acceptedMapping).length) {
      imported.acceptedMapping = {
        ...acceptedMapping,
        ...rule.set,
      };
      imported.version = clinicalVersion(imported.acceptedMapping as unknown as ClinicalMapping);
      extra.import = imported;
    }
    extra.mappingCorrections = [
      ...(Array.isArray(extra.mappingCorrections) ? extra.mappingCorrections : []),
      { before: prior, set: rule.set, sourceUnchanged: true },
    ];
    if (table === 'observations' && label) {
      const original = db
        .prepare('SELECT * FROM test_types WHERE id=?')
        .get(row.test_type_id ?? null) as PartialSqlRow | undefined;
      if (!original?.id) throw new Error('Observation test type is missing');
      const accepted = Object.keys(acceptedMapping).length
        ? (imported.acceptedMapping as ClinicalMapping)
        : null;
      const wholeGroup =
        accepted && originalGroupSizes.get(original.id) === groupSizes.get(original.id);
      let testId;
      if (wholeGroup) {
        // Keep the concept ID and its note links when every observation in the
        // group is covered by this source-scoped rename. Future imports resolve
        // the reviewed signature back to this same group.
        testId = original.id;
        db.prepare('UPDATE test_types SET label=?,extra_json=? WHERE id=?').run(
          label,
          JSON.stringify({
            ...parsedObject(original.extra_json),
            importConcept: conceptKey(accepted),
          }),
          testId,
        );
      } else
        testId = accepted ? conceptId(db, accepted) : 'test:mapped:' + hash([original.id, label]);
      db.prepare(
        'INSERT OR IGNORE INTO test_types(id,label,category,unit,aliases_json,codes_json,context,extra_json) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        testId,
        label,
        original.category ?? null,
        original.unit ?? null,
        original.aliases_json ?? null,
        original.codes_json ?? null,
        original.context ?? null,
        JSON.stringify({
          ...parsedObject(original.extra_json),
          ...(accepted ? { importConcept: conceptKey(accepted) } : {}),
        }),
      );
      db.prepare('UPDATE observations SET test_type_id=?,label=?,extra_json=? WHERE id=?').run(
        testId,
        label,
        JSON.stringify(extra),
        row.id ?? null,
      );
    } else if (table === 'procedures')
      db.prepare('UPDATE procedures SET label=?,category=?,extra_json=? WHERE id=?').run(
        label || row.label || null,
        rule.set.procedureCategory || row.category || null,
        JSON.stringify(extra),
        row.id ?? null,
      );
    else
      db.prepare(
        `UPDATE ${table} SET ${table === 'documents' ? 'title' : 'label'}=?,extra_json=? WHERE id=?`,
      ).run(label || row.title || row.label || null, JSON.stringify(extra), row.id ?? null);
    changes.push({
      id: String(row.id),
      kind: rule.match.kind,
      before: prior,
      after: rule.set,
      sourceRecordId: String(row.source_record_id),
    });
  }
  return changes;
}

function legacyExceptionOriginal(db: DatabaseSync, item: RecordException): ClinicalMapping | null {
  // Older exceptions lack fallback-origin metadata. Recover it from retained
  // original evidence without rewriting the decision or invoking extraction.
  let sourceId: string | null = item.recordId;
  if (!db.prepare('SELECT 1 FROM source_records WHERE id=?').get(sourceId)) {
    sourceId = null;
    for (const table of ['observations', 'medications', 'procedures', 'documents']) {
      const row = db
        .prepare(`SELECT source_record_id FROM ${table} WHERE id=?`)
        .get(item.recordId) as { source_record_id: string } | undefined;
      if (row) {
        sourceId = row.source_record_id;
        break;
      }
    }
  }
  const original =
    sourceId &&
    json(
      (
        db.prepare('SELECT raw_json FROM source_records WHERE id=?').get(sourceId) as
          { raw_json: string } | undefined
      )?.raw_json,
    );
  const envelope = parsedObject(original);
  return envelope.format === 'health-record-v1' &&
    (envelope.clinical || envelope.proposedClinicalMapping || envelope.kind === 'document')
    ? mappingFrom({ value: envelope as unknown as HealthRecordEnvelope })
    : null;
}
function latestRecordException(
  db: DatabaseSync,
  identityKey: string,
  original: ClinicalMapping,
): RecordException | null {
  const sourceVersion = clinicalSourceVersion(original),
    versions = new Set([
      sourceVersion,
      legacyClinicalSourceVersion(original),
      clinicalVersion(original),
    ]);
  const omittedOpticalVersions = new Set();
  // Match explicit identity/date decisions made before top-level optical data
  // was included in the proposal. This only reuses reviewed corrections; the
  // newly available optical projection still requires another acceptance.
  if (original.mappingOrigins?.opticalPrescription === 'envelope') {
    const { opticalPrescription, ...legacy } = original;
    omittedOpticalVersions.add(clinicalSourceVersion(legacy));
    omittedOpticalVersions.add(legacyClinicalSourceVersion(legacy));
    omittedOpticalVersions.add(clinicalVersion(legacy));
    if (original.mappingOrigins?.kind === 'envelope') {
      const unsupported = { ...legacy, kind: 'unsupported', subject: 'unknown', uncertainties: [] };
      omittedOpticalVersions.add(clinicalSourceVersion(unsupported));
      omittedOpticalVersions.add(legacyClinicalSourceVersion(unsupported));
      omittedOpticalVersions.add(clinicalVersion(unsupported));
    }
  }
  // Earlier converters retained top-level document envelopes without a clinical
  // kind, subject or uncertainty list. Match their explicit reviewed exceptions
  // without replacing the retained original decision or its fingerprint.
  if (original.kind === 'document' && original.mappingOrigins?.kind === 'envelope') {
    const legacy = { ...original, kind: 'unsupported', subject: 'unknown', uncertainties: [] };
    versions.add(clinicalSourceVersion(legacy));
    versions.add(legacyClinicalSourceVersion(legacy));
    versions.add(clinicalVersion(legacy));
  }
  const rows = db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Import record exception' ORDER BY json_extract(coverage_json,'$.recordException.sequence') DESC,id DESC",
    )
    .all() as { coverage_json: string }[];
  return (
    (rows
      .map((row) => parsedObject(parsedObject(json(row.coverage_json)).recordException))
      .find((item) => {
        if (item?.identityKey !== identityKey) return false;
        const itemSourceVersion = stringValue(item.sourceVersion);
        if (!itemSourceVersion) return false;
        if (versions.has(itemSourceVersion)) return true;
        if (omittedOpticalVersions.has(itemSourceVersion)) {
          const retained = legacyExceptionOriginal(db, item as unknown as RecordException);
          return retained && clinicalSourceVersion(retained) === sourceVersion;
        }
        if (!itemSourceVersion.startsWith('mapping-v2:')) return false;
        const retained = legacyExceptionOriginal(db, item as unknown as RecordException);
        return (
          retained &&
          legacyClinicalSourceVersion(retained) === itemSourceVersion &&
          clinicalSourceVersion(retained) === sourceVersion
        );
      }) as RecordException | undefined) || null
  );
}
function saveRecordException(
  db: DatabaseSync,
  file: SourceFileRow,
  entry: IntakeEntry,
  identityKey: string,
  set: Partial<ClinicalMapping>,
  recordId: string,
): RecordException {
  const sourceVersion = clinicalSourceVersion(mappingFrom(entry));
  const id = 'exception:' + hash([file.id, recordId, identityKey, sourceVersion, set]);
  const prior = db.prepare('SELECT coverage_json FROM manual_batches WHERE id=?').get(id);
  if (prior)
    return parsedObject(
      parsedObject(json((prior as { coverage_json: string }).coverage_json)).recordException,
    ) as unknown as RecordException;
  const value: RecordException = {
    id,
    identityKey,
    sourceVersion,
    set,
    recordId,
    sourceFileId: file.id,
    locator: entry.value.provenance.locator,
    scope: 'record',
    sequence: Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(json_extract(coverage_json,'$.recordException.sequence')),0)+1 AS n FROM manual_batches",
          )
          .get() as { n: number | bigint }
      ).n,
    ),
    at: now(),
  };
  insert(db, 'manual_batches', {
    id,
    title: 'Import record exception',
    status: 'verified',
    created_at: value.at,
    verified_at: value.at,
    notes:
      'Explicitly reviewed individual correction. Later general rules cannot overwrite its fields.',
    coverage_json: JSON.stringify({ recordException: value }),
  });
  return value;
}

/** Called within the reviewed correction transaction; the operation ID retains distinct A→B→A decisions. */
export function procedureClassificationException(
  db: DatabaseSync,
  row: PartialSqlRow,
  category: string,
  operationId: string,
): Record<string, unknown> {
  const extra = parsedObject(row.extra_json),
    imported = parsedObject(extra.import);
  const source = db
    .prepare('SELECT source_file_id,locator_json FROM source_records WHERE id=?')
    .get(row.source_record_id ?? null) as PartialSqlRow | undefined;
  const prior = parsedObject(imported.recordException || extra.recordException);
  const value = {
    id: 'exception:assistant:' + operationId,
    identityKey: clean(imported.identity) || 'procedure:' + row.id,
    sourceVersion: imported.originalMapping
      ? clinicalSourceVersion(imported.originalMapping as ClinicalMapping)
      : hash([row.source_record_id]),
    set: { ...parsedObject(prior.set), procedureCategory: category },
    recordId: row.id,
    sourceFileId: clean(imported.intakeId) || source?.source_file_id,
    locator: json(source?.locator_json || '{}'),
    scope: 'record',
    sequence: Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(json_extract(coverage_json,'$.recordException.sequence')),0)+1 AS n FROM manual_batches",
          )
          .get() as { n: number | bigint }
      ).n,
    ),
    at: now(),
  };
  insert(db, 'manual_batches', {
    id: value.id,
    title: 'Import record exception',
    status: 'verified',
    created_at: value.at,
    verified_at: value.at,
    notes: 'Explicitly reviewed assistant correction. General rules cannot overwrite its fields.',
    coverage_json: JSON.stringify({ recordException: value }),
  });
  if (!Object.keys(imported).length) extra.recordException = value;
  if (Object.keys(imported).length) {
    imported.recordException = value;
    // Match a repeated original against the corrected current assertion instead of creating another entity.
    imported.acceptedMapping = {
      ...parsedObject(imported.acceptedMapping),
      procedureCategory: category,
    };
    imported.version = clinicalVersion(imported.acceptedMapping as unknown as ClinicalMapping);
    extra.import = imported;
  }
  return extra;
}

/** Shared literal projection for accepted imports and reviewed contribution splits. */
export function insertClinicalProjection(
  db: DatabaseSync,
  id: string,
  sourceRecordId: string,
  providerId: string,
  mapping: ClinicalMapping,
  extra: Record<string, unknown>,
  update = false,
): void {
  const write = (table: string, values: Record<string, SqlValue | undefined>) => {
    if (!update) return insert(db, table, values);
    const keys = Object.keys(values).filter((k) => k !== 'id');
    db.prepare(`UPDATE ${table} SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`).run(
      ...keys.map((k) => values[k] ?? null),
      id,
    );
  };
  if (mapping.kind === 'observation') {
    const testId = conceptId(db, mapping);
    db.prepare(
      'INSERT OR IGNORE INTO test_types(id,label,category,unit,codes_json,extra_json) VALUES(?,?,?,?,?,?)',
    ).run(
      testId,
      mapping.testLabel,
      mapping.observationCategory || 'Unspecified',
      mapping.unit || null,
      JSON.stringify(mapping.code ? [{ system: mapping.codeSystem, code: mapping.code }] : []),
      JSON.stringify({
        specimen: mapping.specimen,
        method: mapping.method,
        importConcept: conceptKey(mapping),
      }),
    );
    const number = projectObservationNumber(mapping.valueText, mapping.unit);
    write('observations', {
      id: id,
      test_type_id: testId,
      person_id: mapping.personId || 'patient',
      source_record_id: sourceRecordId,
      provider_id: providerId,
      label: mapping.testLabel,
      effective_at: mapping.date || null,
      date_precision: datePrecision(mapping.date),
      value_text: mapping.valueText,
      value_numeric: number?.numeric ?? null,
      comparator: number?.comparator ?? null,
      unit: mapping.unit || null,
      reference_json: JSON.stringify({ text: mapping.referenceText }),
      status: mapping.status || null,
      extra_json: JSON.stringify(extra),
    });
  } else if (mapping.kind === 'medication')
    write('medications', {
      id: id,
      person_id: mapping.personId || 'patient',
      source_record_id: sourceRecordId,
      provider_id: providerId,
      kind: ['order', 'reported_use', 'dispense', 'administration', 'unknown'].includes(
        mapping.medicationKind,
      )
        ? mapping.medicationKind
        : 'unknown',
      label: mapping.medicationName,
      status: mapping.status || null,
      dose_text: mapping.doseText || null,
      route: mapping.route || null,
      frequency: mapping.frequency || null,
      start_at: mapping.startDate || (mapping.dateRole === 'start' ? mapping.date : null),
      end_at: mapping.endDate || null,
      extra_json: JSON.stringify(extra),
    });
  else if (mapping.kind === 'procedure')
    write('procedures', {
      id: id,
      person_id: mapping.personId || 'patient',
      source_record_id: sourceRecordId,
      provider_id: providerId,
      label: mapping.procedureLabel,
      effective_at: mapping.date || null,
      status: mapping.status || null,
      category: mapping.procedureCategory,
      extra_json: JSON.stringify(extra),
    });
  else
    write('documents', {
      id: id,
      source_record_id: sourceRecordId,
      provider_id: providerId,
      title: mapping.documentTitle,
      effective_at: mapping.documentDate || mapping.date || null,
      text_content: mapping.text,
      extra_json: JSON.stringify(extra),
    });
}
