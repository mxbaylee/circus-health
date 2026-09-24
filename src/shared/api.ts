export interface ReclassifiedRecord {
  id: string;
  reclassifiedTo: {
    kind: 'observation' | 'medication' | 'procedure' | 'document';
    recordId: string;
    appUrl: string;
    apiUrl: string;
  };
}
export interface Meta {
  revision: number;
  total: number;
  complete: boolean;
  limit?: number;
  offset?: number;
  coverage?: Record<string, number>;
  profile?: { id: string; name: string; placebo: boolean; nameVersion: number };
}
export interface ApiResponse<T> {
  data: T;
  meta: Meta;
}
export interface ApiError {
  error: { code: string; message: string };
}
export interface Provider {
  id: string;
  name: string;
}
export interface TestType {
  archived?: boolean;
  id: string;
  label: string;
  category: string;
  unit: string | null;
  aliases: string[];
  codes: unknown[];
  context: string | null;
  count: number;
  numericCount: number;
  firstDate: string | null;
  lastDate: string | null;
}
export interface Observation {
  /** Optional derived display requested explicitly; original fields below never change. */
  measurement?: import('./measurement.ts').DerivedMeasurement;
  relationship?: {
    display: import('./clinical-relationships.ts').ClinicalRelationshipProjection['display'];
    hasProviderAmendment: boolean;
    relatedRecordIds: string[];
    truncated: boolean;
  };
  archived?: boolean;
  id: string;
  testTypeId: string;
  label: string;
  date: string | null;
  datePrecision: string;
  valueText: string;
  value: number | null;
  comparator: string | null;
  unit: string | null;
  reference: unknown;
  status: string | null;
  providerId: string | null;
  provider: string | null;
  sourceRecordId: string;
  reportId: string | null;
  extra: unknown;
  attachments?: Attachment[];
  evidence?: Evidence[];
}
export interface Trend {
  test: TestType;
  points: Observation[];
  complete: true;
  unplottableCount: number;
}
export type MedicationCurrentStatus = 'current' | 'not_current' | 'unknown';
export interface Medication {
  archived?: boolean;
  id: string;
  label: string;
  kind: 'order' | 'reported_use' | 'dispense' | 'administration' | 'unknown';
  status: string | null;
  currentStatus: MedicationCurrentStatus;
  currentStatusVersion: number;
  visibilityVersion: number;
  archiveHistory?: {
    id: string;
    archived: boolean;
    version: number;
    createdAt: string;
    actor: string;
  }[];
  currentStatusUpdatedAt: string | null;
  currentStatusAssertion: unknown;
  sourceRecordedDate: string | null;
  doseText: string | null;
  route: string | null;
  frequency: string | null;
  startAt: string | null;
  endAt: string | null;
  provider: string | null;
  sourceRecordId: string;
  extra: unknown;
  evidence?: Evidence[];
  attachments?: Attachment[];
}
export type ProcedureCategory =
  'surgery' | 'clinical_procedure' | 'imaging' | 'laboratory' | 'pathology' | 'unspecified';
export interface Procedure {
  archived?: boolean;
  category: ProcedureCategory;
  id: string;
  label: string;
  date: string | null;
  status: string | null;
  provider: string | null;
  sourceRecordId: string;
  extra: unknown;
  evidence?: Evidence[];
  attachments?: Attachment[];
}
export interface SourceFile {
  archived?: boolean;
  id: string;
  /** Immutable acquisition attribution stored on the source file. */
  providerId: string | null;
  provider: string | null;
  /** Mutable reviewed intake label, kept separate from acquisition attribution. */
  reviewedSourceProviderId?: string | null;
  reviewedSource?: string | null;
  path: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  kind: string;
  coverageStatus: string;
  details: unknown;
  contentUrl: string;
}
export interface SourceFileReference extends Omit<SourceFile, 'details'> {
  detailsUrl: string;
  detailsIncluded: false;
}
export interface SourceRecord {
  archived?: boolean;
  id: string;
  sourceFileId: string;
  providerId: string | null;
  /** Joined record-level source label. This is distinct from file acquisition attribution. */
  provider?: string | null;
  sourceKey: string | null;
  kind: string;
  label: string | null;
  date: string | null;
  raw: unknown;
  rawText?: string;
  locator: unknown;
  extractionStatus: string;
  file?: SourceFile;
  originalFile?: SourceFile | null;
  extractionFile?: SourceFile;
  originalMissing?: boolean;
  ancestorFiles?: SourceFile[];
  relationships?: unknown[];
}
export interface SourceRecordReference extends Omit<
  SourceRecord,
  'file' | 'originalFile' | 'extractionFile' | 'ancestorFiles'
> {
  fileView: 'reference';
  file?: SourceFileReference;
  originalFile?: SourceFileReference | null;
  extractionFile?: SourceFileReference;
  ancestorFiles?: SourceFileReference[];
}
export type SourceRecordFileView = 'full' | 'reference';
export interface Evidence {
  id: string;
  sourceRecordId: string;
  role: string;
  locator: unknown;
}
export type ClinicalEvidenceEntityType = 'observation' | 'medication' | 'procedure' | 'document';
export interface SourceRecordClinicalEvidence extends Evidence {
  entityType: ClinicalEvidenceEntityType;
  entityId: string;
}
export interface PersonSourceEvidence {
  sourceRecordId: string;
  sourceTitle: string;
  sourceArchived: boolean;
  sourceMissing: boolean;
  entries: {
    entityId: string;
    kind: LinkTargetType;
    title: string;
    appUrl?: string;
    archived: boolean;
    missing: boolean;
  }[];
}
export type NoteKind = 'note' | 'historical' | 'person';
export type NoteStatus = 'editable' | 'draft' | 'finished';
export type LinkTargetType =
  | 'note'
  | 'person'
  | 'observation'
  | 'test_type'
  | 'medication'
  | 'procedure'
  | 'source'
  | 'document';
export interface PersonProfile {
  onboarding?: {
    completedSteps: string[];
    skippedSteps: string[];
    deferredSteps?: string[];
    finished: boolean;
    careTeam?: { primaryCareId?: string; emergencyContactId?: string };
  };
  icon?: string;
  tags?: string[];
  phone?: string;
  email?: string;
  schedulingUrl?: string;
  fullName?: string;
  /** Names explicitly saved by the person, never inferred from imported records. */
  knownNames?: string[];
  pronouns?: string;
  birthDate?: string;
  deathDate?: string;
  lifeStatus?: 'alive' | 'deceased' | 'unknown';
  name?: string;
  relationship?: string;
  medicalHistory?: string;
  bloodType?: string;
  bloodTypeSource?: string;
  bloodTypeUncertainty?: string;
  [key: string]: unknown;
}
export interface NoteLinkInput {
  targetType: LinkTargetType;
  targetId: string;
  relation?: string;
}
export interface NoteLink extends NoteLinkInput {
  resolvedTargetType?: LinkTargetType;
  appUrl?: string;
  apiUrl?: string;
  sourceRecordId?: string;
  id: string;
  title: string;
  archived: boolean;
  missing: boolean;
  current: true;
}
export type NoteTextFormat = 'plain-v1' | 'markdown-v1';
export type NoteTextField = 'content' | 'topics' | 'rawThoughts' | 'medicalHistory';
export type NoteTextFormats = Partial<Record<NoteTextField, NoteTextFormat>>;
export interface Note {
  isSelf?: boolean;
  id: string;
  kind: NoteKind;
  status: NoteStatus;
  title: string;
  content: string;
  textFormats?: NoteTextFormats;
  typeLabel: string | null;
  eventDate: string | null;
  topics: string;
  rawThoughts: string;
  personId: string | null;
  person: PersonProfile;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  version: number;
  sourceRecordId: string | null;
  links: NoteLink[];
  backlinks: NoteLink[];
  attachments: Attachment[];
}
export interface HistoricalNoteBase {
  archived?: boolean;
  id: string;
  title: string;
  typeLabel: string | null;
  date: string | null;
  eventDate: string | null;
  recordDate: string | null;
  dateBasis: string;
  sourceId: string | null;
  sourceLabel: string;
  sourceStatus: string | null;
  sourceType: string | null;
  sourceRecordId: string | null;
  content: string | null;
  authors: string[];
  classificationBasis: string | null;
  presentationNote: string | null;
  evidence: Evidence[];
  attachments: Attachment[];
}
export interface PersonalHistoricalNote extends HistoricalNoteBase {
  origin: 'personal';
  status: 'draft' | 'finished';
  readOnly: boolean;
  sourceId: 'personal';
  note: Note;
}
export interface ProviderHistoricalNote extends HistoricalNoteBase {
  origin: 'provider';
  status: 'provider';
  readOnly: true;
  extra: unknown;
}
export type HistoricalNote = PersonalHistoricalNote | ProviderHistoricalNote;
export interface HistoricalNoteOptions {
  acquisitionSources?: { value: string; label: string }[];
  sources: { id: string; label: string; count: number }[];
  types: string[];
}
export interface NoteInput {
  id?: string;
  kind?: NoteKind;
  title: string;
  content: string;
  textFormats?: NoteTextFormats;
  typeLabel?: string | null;
  eventDate?: string | null;
  topics?: string;
  rawThoughts?: string;
  person?: PersonProfile;
  pinned?: boolean;
  archived?: boolean;
  links?: NoteLinkInput[];
  version?: number;
}
export interface Asset {
  id: string;
  originalName: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  attribution: string;
  contentUrl: string;
}
export interface Attachment {
  id: string;
  assetId: string;
  ownerType: 'note' | 'person' | 'observation' | 'medication' | 'procedure' | 'document';
  ownerId: string;
  caption: string;
  bodyLocation: string | null;
  eventDate: string | null;
  personId: string | null;
  createdAt: string;
  asset: Asset;
}
export interface AttachmentInput {
  id?: string;
  assetId: string;
  ownerType: Attachment['ownerType'];
  ownerId: string;
  caption?: string;
  bodyLocation?: string | null;
  eventDate?: string | null;
  personId?: string | null;
  version?: number;
}
export interface LinkTarget {
  targetType: LinkTargetType;
  targetId: string;
  title: string;
  subtitle: string | null;
  archived: boolean;
}
export interface Overview {
  counts: {
    observations: number;
    testTypes: number;
    medications: number;
    procedures: number;
    sourceFiles: number;
    sourceRecords: number;
    notes: number;
  };
  recentResults: Observation[];
  pinnedNotes: Note[];
  coverage: Record<string, number>;
  batches: unknown[];
}
export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  elapsedMs: number;
}
export interface Profile {
  icon?: string;
  id: string;
  name: string;
  placebo: boolean;
}

export interface HistoryValue {
  format?: NoteTextFormat;
  present: boolean;
  value?: unknown;
}
export interface NoteHistoryField {
  path: string;
  label: string;
  previous: HistoryValue;
  current: HistoryValue;
  changed: boolean;
  restorable: boolean;
}
export interface HistoryAssociation {
  id: string;
  kind: 'link' | 'attachment';
  label: string;
  previous: HistoryValue;
  current: HistoryValue;
  changed: boolean;
  restorable: boolean;
  reason: string | null;
}
export interface NoteHistoryEntry {
  recordedChanges?: { path: string; label: string; before: HistoryValue; after: HistoryValue }[];
  associations?: { links: HistoryAssociation[]; attachments: HistoryAssociation[] };
  sessionId?: string | null;
  operationId?: string;
  generationId: string;
  savedAt: string;
  revision: number;
  noteVersion: number;
  status: string;
  publication: 'baseline' | 'published';
  fields: NoteHistoryField[];
  links: number;
  attachments: number;
}
export interface NoteHistory {
  format?: 'record-versions';
  currentRevision?: number;
  groups?: {
    id: string;
    sessionId: string | null;
    label: string;
    savedAt: string;
    entries: string[];
  }[];
  noteId: string;
  currentVersion: number;
  finished: boolean;
  entries: NoteHistoryEntry[];
  nextCursor: string | null;
  complete: boolean;
  baselineReached: boolean;
  coverage: string;
}
export interface NoteRestoreResult {
  note: Note;
  operation: {
    operationId: string;
    previousVersion: number;
    currentVersion: number;
    fields: string[];
    status: string;
  };
  replayed: boolean;
  recovery: { generationId: string | null; published: boolean; historyAvailable: boolean };
}

export interface NoteRestorationPreview {
  noteId: string;
  generationId: string;
  version: number;
  expectedRevision: number;
  previewToken: string;
  fields: string[];
  associations: { links: string[]; attachments: string[] };
  changes: { path: string; label: string; before: HistoryValue; after: HistoryValue }[];
  associationChanges: HistoryAssociation[];
}
