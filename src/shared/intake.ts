import type { OpticalPrescription } from './vision.ts';
import type {
  IntakeEvidencedIdentity,
  IntakeIdentityConflict,
  IntakeIdentityConfidence,
  IntakeIdentityReceipt,
  IntakeIdentityReviewStatus,
  IntakeIdentityWarning,
} from './intake-identity.ts';
import type { IntakeReadingAccounting } from './intake-reading-accounting.ts';
import type { IntakePersonEnvelopeProposal } from './intake-people.ts';
import type {
  ClinicalPairReference,
  IntakePairScope,
  IntakePairDraftScopeStatus,
  RelatedRecordPage,
  RelatedRecordReason,
} from './clinical-review.ts';

export type IntakeState =
  | 'ready'
  | 'pending_conversion'
  | 'conversion_proposed'
  | 'needs_review'
  | 'imported'
  | 'kept_original';
export interface IntakeMetadata {
  source: string | null;
  sourceProviderId?: string | null;
  careArea: string | null;
  documentType: string | null;
  topics: string[];
}
export interface IntakeMetadataUpdate {
  version: number;
  operationId: string;
  metadata: Partial<Omit<IntakeMetadata, 'sourceProviderId'>>;
}
export interface IntakeCoverage {
  status: 'complete_response' | 'partial' | 'unknown';
  notes: string[];
}
/** A source quote supplied by extraction, not independently verified geometry or identity. */
export interface IntakeReportAnchor {
  locator: string;
  text: string;
}
export interface IntakeReportReference {
  key: string;
  title: string;
  anchor: IntakeReportAnchor;
  /** Printed subject evidence; null means unknown, never identity confirmation. */
  subject: IntakeReportAnchor | null;
  /** Exact inventory occurrence ID, required when proposing directly from a package. */
  memberId?: string;
  section?: { key: string; title: string; anchor: IntakeReportAnchor };
}
export interface IntakeReportGroupMember {
  candidateId: string;
  candidateVersionId: string;
  occurrences: IntakeCandidateVersion['occurrences'];
  section?: IntakeReportReference['section'];
}
export interface IntakeReportGroupVersion {
  id: string;
  createdAt: string;
  title: string;
  members: IntakeReportGroupMember[];
  /** Immutable ingest receipt; replaying earlier evidence must not roll back the latest group. */
  contributionId: string;
  /** Version-pinned, unreviewed shared context. It never establishes patient or clinical identity. */
  context?: IntakeReportContextReference | null;
  /** Distinguishes no linked context from conflicting contexts in one contribution. */
  contextState?: 'none' | 'uniform' | 'mixed';
}
export interface IntakeReportSourceSuggestion {
  value: string;
  textAnchor: string;
  locator: string;
}
export interface IntakeReportContextReference {
  contextId: string;
  envelopeId: string;
  status: 'linked' | 'unresolved';
  detail: string;
  sourceSuggestion?: IntakeReportSourceSuggestion;
}
export interface IntakeReportSourceScope {
  kind: 'anchored_report';
  /** Hash of the exact retained original/report/source/subject boundary. */
  reportFingerprint: string;
  /** Null when no linked/shared context existed at explicit confirmation time. */
  contextFingerprint: string | null;
}
export interface IntakeReportSourceExtension {
  id: string;
  groupVersionId: string;
  contextId: string;
  members: { candidateId: string; candidateVersionId: string }[];
  /** Exact occurrence coverage for explicit-current authority; absent on retained legacy extensions. */
  coverageEntries?: IntakeReportSourceCoverageEntry[];
  /** Precise user-authorized entry whose unchanged scope allowed this automatic extension. */
  authorityEntryId?: string;
  at: string;
}
export interface IntakeReportSourceCoverageEntry {
  id: string;
  candidateId: string;
  candidateVersionId: string;
  occurrence: IntakeCandidateVersion['occurrences'][number];
  sourceRef: {
    groupId: string;
    groupVersionId: string;
    contributionId: string;
    contextId: string;
    /** Hash of the immutable report/person/source/context reference. */
    fingerprint: string;
    /** Only an unchanged exact scope may seed compatible later-member coverage. */
    extensionScope?: IntakeReportSourceScope;
  };
}
export interface IntakeReportSourceConfirmation {
  /** suggested_report_label is a derived default, never a human confirmation. */
  basis?: 'manual_report_label' | 'explicit_current_members' | 'suggested_report_label';
  operationId: string;
  groupId: string;
  groupVersionId: string;
  contextId: string;
  source: string;
  sourceProviderId: string;
  members: { candidateId: string; candidateVersionId: string }[];
  /** Optional on retained legacy confirmations, which stay frozen to their original members. */
  scope?: IntakeReportSourceScope;
  /** Append-only exact-version coverage created only while the retained scope stays unchanged. */
  extensions?: IntakeReportSourceExtension[];
  /** Exact user-authorized occurrences; never rewrites already accepted outcomes. */
  coverageEntries?: IntakeReportSourceCoverageEntry[];
  /** Canonical server preflight boundary for the exact view and occurrences shown. */
  scopeToken?: string;
  view?: IntakeReportQueueView;
  at: string;
}
export interface IntakeReportSourceUpdate {
  basis?: 'manual_report_label' | 'explicit_current_members';
  version: number;
  operationId: string;
  groupId: string;
  groupVersionId: string;
  contextId: string;
  source: string;
  scopeToken?: string;
  view?: IntakeReportQueueView;
}
export interface IntakeReportSourceResult {
  intake: Intake;
  confirmation: IntakeReportSourceConfirmation;
}
export interface IntakeReportGroup {
  id: string;
  /** Monotonic profile-wide discovery order, assigned in the source publication transaction. */
  discoveryOrder?: number;
  basis: 'report_anchor' | 'candidate_fallback';
  sourceFileId: string | null;
  sourceHash: string | null;
  sourceSystem: string | null;
  memberId: string | null;
  /** Extraction's source claim, never a reviewed assertion of clinical or patient identity. */
  report: IntakeReportReference | null;
  versions: IntakeReportGroupVersion[];
}
export interface IntakeReviewGroupReference {
  groupId: string;
  groupVersionId: string;
}
export interface HealthRecordEnvelope {
  format: 'health-record-v1';
  id: string;
  kind: 'record' | 'document' | 'context' | 'unrecognized';
  payload: unknown;
  provenance: {
    capturedVia: string | null;
    sourceSystem: string | null;
    sourceRecordId: string | null;
    evidenceClass:
      'provider_export' | 'health_response' | 'transcription' | 'personal_report' | 'unknown';
    locator: string;
  };
  coverage: IntakeCoverage;
  /** Explicit same-proposal report-context link. Older payload.contextId links remain readable. */
  contextId?: string;
  report?: IntakeReportReference;
  people?: IntakePersonEnvelopeProposal[];
  [key: string]: unknown;
}
export interface IntakeValidation {
  valid: boolean;
  rows: number;
  exactRepeatedRows: number;
  partialRows: number;
  unrecognizedRows: number;
  issues: { line: number; message: string }[];
  preview: { line: number; id: string; kind: string; text: string }[];
  previewComplete: boolean;
}
export interface IntakeDurability {
  pending: boolean;
  mutationRevision: number;
  persistedRevision: number;
  error: string | null;
}
export interface IntakeProposal {
  /** Host-retained human authorship; never supplied by a model envelope. */
  manualSourceRecord?: import('./intake-manual-source-record.ts').ManualSourceRecordReceipt;
  id: string;
  fileId: string;
  summary: string;
  createdAt: string;
  runId: string | null;
  validation: IntakeValidation;
  contentUrl: string;
  /** Material source-text revision used to create this proposal; absent on legacy originals. */
  sourceTextRevisionId?: string | null;
  sourceTextDependencyToken?: string | null;
}
export interface IntakeAcceptedRecord {
  recordId: string;
  entityId: string;
  kind: 'observation' | 'medication' | 'procedure' | 'document';
  title: string;
  optical: boolean;
  identityAttribution?: IntakeClinicalIdentityAttribution;
  outcome: 'added' | 'matched' | 'updated';
  reviewedSource?: {
    basis?: IntakeReportSourceConfirmation['basis'];
    source: string;
    sourceProviderId: string;
    confirmationOperationId: string;
    groupId: string;
    groupVersionId: string;
    coverageEntryId?: string;
    destinationProviderId: string;
    destinationProvider: string;
    outcome: 'assigned' | 'enriched_unknown' | 'preserved_known';
  };
}

/** Durable host-derived explanation for the accepted clinical mapping's person. */
export interface IntakeClinicalIdentityAttribution {
  assignedPerson?: import('./intake-identity.ts').IntakeIdentityPerson;
  confidence?: IntakeIdentityConfidence;
  status: Exclude<IntakeIdentityReviewStatus, 'confirmation_required' | 'conflict'>;
  basis:
    | 'explicit_ownership_correction'
    | 'explicit_manual_source_record'
    | 'explicit_person_confirmation'
    | 'matched_saved_self'
    | 'matched_saved_person'
    | 'same_original_person_confirmation'
    | 'explicit_report_confirmation'
    | 'reviewed_active_profile_missing_identity';
  groupId: string | null;
  groupVersionId: string | null;
  personFingerprint?: string;
  /** Host verification of the exact original subject; absent on older auto matches. */
  originalSubjectFingerprint?: string;
  confirmationOperationId?: string;
  manualSourceRecord?: import('./intake-manual-source-record.ts').ManualSourceRecordReceipt;
  evidencedIdentity?: IntakeEvidencedIdentity;
}
export interface Intake {
  id: string;
  providerId: string;
  provider: string;
  acquisition?: { providerId: string; provider: string };
  parentSourceFileId?: string | null;
  metadata?: IntakeMetadata;
  archived?: boolean;
  visibilityVersion?: number;
  metadataHistory?: {
    id: string;
    before: IntakeMetadata | null;
    metadata: IntakeMetadata;
    at: string;
  }[];
  filename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  state: IntakeState;
  version: number;
  contentUrl: string;
  validation: IntakeValidation;
  proposals: IntakeProposal[];
  acceptedProposalId: string | null;
  conversionChatId: string | null;
  imported: null | {
    records: number;
    repeatedRows: number;
    matchingEarlierRows: number;
    at: string;
    fileId: string;
    clinical?: {
      newMedications?: number;
      added: number;
      duplicates: number;
      retainedOnly: number;
      versions: number;
      records?: IntakeAcceptedRecord[];
    };
  };
  importHistory?: {
    acceptedProposalId: string | null;
    reviewToken: string | null;
    at: string;
    clinical?: {
      newMedications?: number;
      added: number;
      duplicates: number;
      retainedOnly: number;
      versions: number;
      records?: IntakeAcceptedRecord[];
    };
  }[];
  durability: IntakeDurability;
  repeatedUpload?: boolean;
  workflow?: IntakeWorkflow;
  needsReview?: boolean;
  pendingCount?: number;
  unansweredCount?: number;
  pendingWorkCount?: number;
  reviewLaterCount?: number;
}
export interface IntakeTextPage {
  intake: Intake;
  text: string | null;
  offset: number;
  nextOffset: number | null;
  totalCharacters: number | null;
  complete: boolean;
  note: string;
}

export type ReviewClassification = 'addition' | 'duplicate' | 'unsupported';
export type ReviewRecordKind =
  'observation' | 'medication' | 'procedure' | 'document' | 'unsupported';
export type ProcedureMappingCategory =
  'surgery' | 'clinical_procedure' | 'imaging' | 'laboratory' | 'pathology' | 'unspecified';
export interface IntakeEvidenceLocator {
  label: string;
  locator: string;
  contentUrl?: string;
}
export interface IntakeClinicalMapping {
  /** Server-derived reviewed person identity; never accepted from model output. */
  personId?: string;
  kind?: ReviewRecordKind;
  label?: string;
  date?: string;
  subject?: 'self' | 'other' | 'unknown' | string;
  status?: string;
  sourceRecordId?: string;
  sourceSystem?: string;
  eventKind?: 'order' | 'performed' | 'historical_mention' | 'unknown' | string;
  observationCategory?: string;
  documentCategory?: string;
  visitSpecialty?: string;
  testLabel?: string;
  valueText?: string;
  unit?: string;
  referenceText?: string;
  code?: string;
  codeSystem?: string;
  specimen?: string;
  method?: string;
  medicationName?: string;
  doseText?: string;
  route?: string;
  frequency?: string;
  medicationKind?: 'order' | 'reported_use' | 'dispense' | 'administration' | 'unknown' | string;
  dateRole?: 'recorded' | 'start' | string;
  startDate?: string;
  endDate?: string;
  procedureLabel?: string;
  procedureCategory?: ProcedureMappingCategory;
  documentTitle?: string;
  documentDate?: string;
  opticalPrescription?: OpticalPrescription | null;
  text?: string;
  assets?: string[];
  uncertainties?: string[];
}
export interface IntakeReviewRecord {
  id: string;
  /** Exact per-occurrence authority, independent of unrelated transport revisions. */
  selectionReviewToken?: string;
  classification: ReviewClassification;
  kind: ReviewRecordKind;
  title: string;
  date: string | null;
  provider: string | null;
  candidateId?: string;
  candidateVersionId?: string;
  questions?: IntakeQuestion[];
  reportGroups?: IntakeReviewGroupReference[];
  reviewState?: 'pending' | 'accepted' | 'kept_original';
  projectionUpgrade?: boolean;
  issues?: IntakeReviewIssue[];
  draft?: IntakeReviewDraft | null;
  /** Derived clinical field changes, excluding full unchanged snapshots and identity/source confirmation. */
  manuallyEdited?: boolean;
  suggestedMapping?: Partial<IntakeClinicalMapping>;
  confidence: number | null;
  uncertainties: string[];
  evidence: IntakeEvidenceLocator[];
  comparisons?: IntakeEvidenceComparison[];
  comparisonPage?: RelatedRecordPage;
  comparisonReference?: ClinicalPairReference;
  /** Server-derived durable candidate/person/report/source authority for v2 pair scopes. */
  comparisonContextHash?: string;
  /** Legacy or changed pending decisions stay retained but require explicit fresh review. */
  comparisonDrafts?: { otherRecordId: string; status: IntakePairDraftScopeStatus }[];
  duplicateOf?: {
    id: string;
    label: string;
    date: string | null;
    /** True when review rediscovered the already-saved assertion from this exact source row. */
    sameSourceRecord?: boolean;
    /** False for a duplicate found only among unsaved rows in the current proposal. */
    persistedMatch?: boolean;
  };
  mapping: IntakeClinicalMapping;
  identityReview?: {
    assignedPerson?: import('./intake-identity.ts').IntakeIdentityPerson;
    confidence?: IntakeIdentityConfidence;
    status: IntakeIdentityReviewStatus;
    blocking: boolean;
    message: string;
    evidencedIdentity: IntakeEvidencedIdentity;
    conflicts: IntakeIdentityConflict[];
    warnings?: IntakeIdentityWarning[];
  };
  /** Derived identity policy for this exact candidate version; it never accepts the record. */
  identityAttribution?: IntakeClinicalIdentityAttribution;
  supportedFields: (keyof IntakeClinicalMapping)[];
}
export interface IntakeSourceContext {
  id: string;
  envelopeId: string;
  kind: 'context';
  title: string;
  payload: unknown;
  text: string;
  provenance: HealthRecordEnvelope['provenance'];
  coverage: IntakeCoverage;
  notes: string[];
  evidence: IntakeEvidenceLocator[];
  reportContext?: IntakeReportContextReference;
}
export interface IntakeCoverageGap {
  id: string;
  label: string;
  detail: string;
  evidence?: IntakeEvidenceLocator[];
}
export interface IntakeReview {
  intakeId: string;
  proposalId: string | null;
  version: number;
  reviewToken: string;
  summary: { additions: number; duplicates: number; unsupported: number; uncertain: number };
  records: IntakeReviewRecord[];
  sourceContext?: IntakeSourceContext[];
  coverageGaps: IntakeCoverageGap[];
  sourceTextStale?: boolean;
}
export interface IntakeMappingRule {
  match: { kind: ReviewRecordKind; label: string };
  set: Partial<IntakeClinicalMapping>;
}
export interface IntakeReviewDecision {
  recordId: string;
  action: 'accept' | 'skip';
  mapping: IntakeClinicalMapping;
  rememberRule?: IntakeMappingRule;
  comparisons?: IntakePairDecision[];
}
export interface IntakeReviewIssue {
  id: string;
  kind: 'identity' | 'date' | 'uncertain_reading' | 'information';
  prompt: string;
  field: string | null;
  blocking: boolean;
  status: 'unresolved' | 'resolved';
  locator: string;
  questionId: string | null;
  textAnchor?: string;
  page?: number;
  memberId?: string;
  sourceSuggestion?: string;
  /** Evidence-scoped unreviewed labels; persisting one requires a separate user action. */
  metadataSuggestion?: { careArea?: string; documentType?: string; topics?: string[] };
  /** Evidence-scoped missing Self fields; persisting one requires an explicit selected confirmation. */
  selfSuggestion?: { fullName?: string; birthDate?: string };
  /** Evidence-scoped date interpretations; unknown/manual review remain available. */
  choices?: { label: string; value: string }[];
  resolution?: IntakeIssueResolution;
}
export interface IntakeIssueResolution {
  issueId: string;
  outcome: 'this_is_me' | 'other_person' | 'unknown' | 'confirmed' | 'corrected' | 'acknowledged';
  mapping?: Partial<IntakeClinicalMapping>;
  at?: string;
  operationId?: string;
}
export interface IntakeImportCorrection {
  operationId: string;
  at: string;
  reason: string;
  before: Partial<IntakeClinicalMapping>;
  after: Partial<IntakeClinicalMapping>;
}
export interface IntakeReviewDraft {
  corrections?: IntakeImportCorrection[];
  id: string;
  proposalId: string | null;
  recordId: string;
  candidateId: string;
  candidateVersionId: string;
  mapping: Partial<IntakeClinicalMapping>;
  resolutions: IntakeIssueResolution[];
  disposition: 'pending' | 'review_later' | 'keep_original_only';
  decision?: IntakeReviewDecision;
  answers?: Record<string, string>;
  at: string;
}
export interface IntakeReviewDraftUpdate {
  /** Literal fields/values explained by this reason; independently checked against the changed patch. */
  correctionPatch?: Partial<IntakeClinicalMapping>;
  correctionReason?: string;
  version: number;
  operationId: string;
  proposalId: string | null;
  recordId: string;
  candidateVersionId: string;
  mapping?: Partial<IntakeClinicalMapping>;
  resolutions?: IntakeIssueResolution[];
  disposition?: IntakeReviewDraft['disposition'];
  decision?: IntakeReviewDecision;
  answers?: Record<string, string>;
}
export type IntakeDraftRepairField = 'date' | 'method' | 'observationCategory';
export interface IntakeDraftRepairSelection {
  format: 'intake-draft-repair-selection-v1';
  intakeId: string;
  groupId: string;
  rows: {
    proposalId: string | null;
    recordId: string;
    candidateVersionId: string;
    fields: IntakeDraftRepairField[];
  }[];
}
export interface IntakeDraftFieldCorrection {
  proposalId: string | null;
  recordId: string;
  candidateVersionId: string;
  field: IntakeDraftRepairField;
  before: string;
  after: string;
}
export interface IntakeDraftRepairUpdate {
  version: number;
  operationId: string;
  groupId: string;
  corrections: IntakeDraftFieldCorrection[];
}
export interface IntakeConversion {
  chatId: string;
}

export interface IntakeQuestionAnswer {
  id: string;
  answer: string;
  mapping: Partial<IntakeClinicalMapping>;
  scope: 'record';
  at: string;
}
export interface IntakeQuestion {
  otherRecordId?: string;
  id: string;
  key: string;
  candidateId: string | null;
  candidateVersionId: string | null;
  prompt: string;
  locator: string;
  field: string | null;
  status: 'unanswered' | 'answered' | 'resolved';
  createdAt: string;
  answers: IntakeQuestionAnswer[];
  resolvedAt?: string;
  resolvedByDecisionId?: string;
}
export interface IntakeCandidateVersion {
  contentDigest?: string;
  id: string;
  status: 'pending' | 'accepted' | 'superseded' | 'kept_original';
  createdAt: string;
  sourceContext?: boolean;
  /** Named People stay in this report scope but never enter clinical block counts. */
  peopleCount?: number;
  peopleOnly?: boolean;
  occurrences: {
    proposalId: string | null;
    recordId: string;
    batchId: string | null;
    locator: string;
  }[];
}
export interface IntakeCandidate {
  id: string;
  envelopeId: string;
  sourceSystem: string | null;
  sourceRecordId: string | null;
  versions: IntakeCandidateVersion[];
}
export interface IntakeExtractionCoverage {
  unitId: string;
  kind: 'inspected' | 'extracted' | 'context' | 'unreadable';
  notes: string;
}
export interface IntakeExtractionUnit {
  processingException?: { reason: 'processing_stalled'; at: string };
  id: string;
  kind: 'pdf' | 'html' | 'text' | 'package_member' | 'archive' | 'image' | 'unsupported';
  memberId?: string;
  sourceFileId?: string;
  sourceHash?: string;
  filename?: string;
  bytes?: number;
  duplicateOf?: string | null;
  locator: string;
  status: 'pending' | 'partial' | 'completed';
  pages?: number[];
  start?: number;
  end?: number;
  attempts: string[];
  coverage?: IntakeExtractionCoverage;
}
export interface IntakePackageRole {
  memberId: string;
  role: 'clinical' | 'context' | 'attachment' | 'historical' | 'unknown' | 'nonclinical';
  reason: string;
  coverage: 'pending' | 'context' | 'unreadable';
  references: {
    path: string;
    reason: string;
    status: 'supplied_uninspected' | 'not_supplied' | 'ambiguous';
    targetMemberId: string | null;
    candidateMemberIds?: string[];
  }[];
}
export interface IntakePackageMember {
  memberId: string;
  ordinal: number;
  filename: string;
  locator: string;
  bytes: number;
  compressedBytes: number;
  sourceHash: string;
  duplicateOf: string | null;
  unitId?: string;
  status?: IntakeExtractionUnit['status'];
  coverage?: IntakeExtractionCoverage | null;
  role?: {
    role: IntakePackageRole['role'];
    reason: string;
    coverage: IntakePackageRole['coverage'];
    referenceCount: number;
    missingReferenceCount: number;
    ambiguousReferenceCount?: number;
  } | null;
}
export interface IntakePackageInventory {
  intakeId: string;
  version: number;
  planId: string | null;
  sourceHash: string;
  totalMembers: number;
  totalExpandedBytes: number;
  uniqueByteContents: number;
  members: IntakePackageMember[];
  offset: number;
  nextOffset: number | null;
  coverage: 'inventory_only';
  complete: false;
  note: string;
}
export interface IntakeExtractionPlan {
  id: string;
  createdAt: string;
  status: 'active' | 'superseded';
  pins: {
    sourceHash: string;
    backend: string;
    model: string | null;
    reasoningEffort: string | null;
    instructionVersion: string;
    mappingVersion: string;
    reviewedMetadataVersion?: string;
  };
  index: {
    kind: string;
    coverage: string;
    inventoryVersion?: 1;
    members?: IntakePackageMember[];
    totalMembers?: number;
    totalExpandedBytes?: number;
    uniqueByteContents?: number;
    missingAssets: {
      locator: string;
      source: string;
      status: string;
      sourceFileId?: string;
      contentUrl?: string;
    }[];
  };
  units: IntakeExtractionUnit[];
  packageRoles?: IntakePackageRole[];
  packageRolesHistory?: { id: string; roles: IntakePackageRole[]; at: string }[];
  batches: { id: string; proposalId: string; at: string; coverage: IntakeExtractionCoverage[] }[];
}
export interface IntakeWorkflow {
  format: 'health-intake-workflow-v1';
  identityConfirmations?: IntakeIdentityReceipt[];
  reportAcceptances?: { fingerprint: string; receipt: IntakeReportAcceptanceReceipt }[];
  reportGroups?: IntakeReportGroup[];
  reportSourceConfirmations?: IntakeReportSourceConfirmation[];
  questions: IntakeQuestion[];
  candidates: IntakeCandidate[];
  plans: IntakeExtractionPlan[];
  reviewDrafts?: IntakeReviewDraft[];
  decisions: {
    id: string;
    candidateId: string;
    candidateVersionId: string;
    recordId: string;
    action: 'accept' | 'keep_original_only';
    mapping: Partial<IntakeClinicalMapping>;
    scope: 'record' | 'reusable-rule';
    at: string;
  }[];
}

export interface IntakePairDecision {
  otherRecordId: string;
  /** Required for new explicit incoming choices; absent only in retained legacy data. */
  scope?: IntakePairScope;
  outcome: 'same_event' | 'changed_version' | 'distinct' | 'unresolved';
  reason: string;
  /** Added only by a fresh intake same-event choice; absent legacy choices stay relationship-only. */
  occurrenceEvidence?: 'attach';
}
export interface IntakeEvidenceComparison {
  id: string;
  kind: ReviewRecordKind;
  title: string;
  date: string | null;
  identity: string;
  version: string;
  mapping: IntakeClinicalMapping;
  evidence: IntakeEvidenceLocator[];
  previousDecision: null | {
    outcome: IntakePairDecision['outcome'];
    reason: string;
    id: string;
    occurrenceEvidence?: 'attach';
    attachmentStatus?: 'attached' | 'withdrawn';
    scopeStatus?: 'current' | 'legacy' | 'stale';
  };
  scope?: IntakePairScope;
  discoveryReasons?: RelatedRecordReason[];
  draftScopeStatus?: IntakePairDraftScopeStatus;
}

export type IntakeReportQueueView = 'active' | 'deferred' | 'all';
export type IntakeReportQueueRecordState =
  'pending' | 'deferred' | 'accepted' | 'kept_original' | 'superseded';
export interface IntakeReportQueueCounts {
  /** Current versions needing review, excluding deferred versions. Includes blocked. */
  pending: number;
  deferred: number;
  /** Blocked current versions across both pending and deferred states. */
  blocked: number;
  accepted: number;
  keptOriginal: number;
  superseded: number;
  /** Unresolved actionable issues on current pending/deferred versions. */
  questions: number;
}
export interface IntakeReportQueueGroup {
  groupId: string;
  groupVersionId: string;
  intakeId: string;
  intakeVersion: number;
  discoveryOrder: number | null;
  title: string;
  source: string | null;
  /** Distinguishes a reviewed group label from file metadata and unreviewed issuer claims. */
  sourceScope?: 'report' | 'intake' | 'issuer' | null;
  sourceConfirmation?: {
    operationId: string;
    groupVersionId: string;
    contextId: string;
    memberCount: number;
  };
  /** An evidence-aligned personal source-label proposal; applying it is a separate user action. */
  sourceSuggestion?: {
    value: string;
    contextId: string;
    evidence: IntakeEvidenceLocator;
  };
  /** Exact report boundary for a user-entered personal label; makes no issuer claim. */
  sourceLabelScope?: { contextId: string; evidence: IntakeEvidenceLocator };
  reportContext?: Pick<IntakeReportContextReference, 'contextId' | 'status' | 'detail'>;
  date: string | null;
  basis: IntakeReportGroup['basis'];
  original: { filename: string; contentUrl: string; parentSourceFileId: string | null };
  member: { memberId: string; filename: string | null; locator: string | null } | null;
  anchor: IntakeReportAnchor | null;
  counts: IntakeReportQueueCounts;
  peopleCounts?: { pending: number; later: number; excluded: number; saved: number };
  sourceCoverage?: IntakeReportSourceCoverage;
}
export interface IntakeReportSourceCoverageCounts {
  total: number;
  covered: number;
  uncovered: number;
  status: 'empty' | 'uncovered' | 'partial' | 'single' | 'mixed';
  bySource: { source: string; count: number }[];
}
export interface IntakeReportSourceCoverage {
  current: IntakeReportSourceCoverageCounts;
  saved: IntakeReportSourceCoverageCounts;
}
export interface IntakeReportSourceReviewTarget {
  id: string;
  candidateId: string;
  candidateVersionId: string;
  occurrence: IntakeCandidateVersion['occurrences'][number];
  sourceRef: IntakeReportSourceCoverageEntry['sourceRef'];
  title: string;
  date: string | null;
  kind: ReviewRecordKind;
  effectiveSource: string | null;
}
export interface IntakeReportSourceReview {
  profileId: string;
  intakeId: string;
  intakeVersion: number;
  groupId: string;
  groupVersionId: string;
  view: IntakeReportQueueView;
  scopeToken: string;
  targets: IntakeReportSourceReviewTarget[];
  coverage: IntakeReportSourceCoverageCounts;
  /** Only actual contradictory source branding is surfaced; context hash variation is ordinary. */
  sourceEvidence: string[];
  warning?: string;
}
export interface IntakeReportQueueActivity {
  /** Durable scope/disposition accounting, separate from clinical completeness. */
  readingAccounting?: IntakeReadingAccounting;
  runningFiles: number;
  pausedFiles: number;
  queuedFiles: number;
  filesAwaitingConversion: number;
  remainingUnits: number;
  /** Count of visible files lacking host-confirmed complete extraction. */
  extractionUnknownFiles: number;
  extractionComplete: boolean;
  allCurrentReportsReviewed: boolean;
}
export interface IntakeReportQueue {
  view: IntakeReportQueueView;
  groups: IntakeReportQueueGroup[];
  totalGroups: number;
  nextCursor: string | null;
  activity: IntakeReportQueueActivity;
}
export interface IntakeReportQueueRecord extends IntakeReviewRecord {
  queueState: IntakeReportQueueRecordState;
  /** Only current, unblocked pending/deferred versions may be deliberately selected. */
  selectable: boolean;
}
export interface IntakeReportQueueBlock {
  intakeId: string;
  proposalId: string | null;
  intakeVersion: number;
  reviewToken: string;
  proposalContentUrl: string;
  records: IntakeReportQueueRecord[];
}
export interface IntakeReportQueueDetail {
  view: IntakeReportQueueView;
  group: IntakeReportQueueGroup;
  blocks: IntakeReportQueueBlock[];
  totalRecords: number;
  nextCursor: string | null;
}

/** Display categories; vision records retain their original clinical mapping kind. */
export type IntakeImportFeedKind =
  'test' | 'prescription' | 'vision' | 'procedure' | 'history' | 'unsupported' | 'person';
export interface IntakeImportFeedRecord extends IntakeReportQueueRecord {
  /** Stable exact-version identity, independent of the current proposal occurrence. */
  feedKey: string;
  /** Sort rows by this opaque lexical order after flattening exact proposal blocks. */
  feedOrder: string;
  feedKind: Exclude<IntakeImportFeedKind, 'person'>;
  /** A literal clinical mapping change; full unchanged drafts and source/identity confirmations do not count. */
  manuallyEdited: boolean;
}
export interface IntakeImportFeedBlock extends Omit<IntakeReportQueueBlock, 'records'> {
  groupId: string;
  records: IntakeImportFeedRecord[];
}
export interface IntakeImportFeed {
  view: IntakeReportQueueView;
  /** Headers only for the bounded clinical record page. */
  groups: IntakeReportQueueGroup[];
  blocks: IntakeImportFeedBlock[];
  totalRecords: number;
  totalGroups: number;
  nextCursor: string | null;
  /** Global clinical counts, independent of view, search, edited and kind filters. */
  counts: IntakeReportQueueCounts;
  /** Clinical counts after view/state/search/edited, before kind. People counts apply view only. */
  kindCounts: Record<IntakeImportFeedKind, number>;
  /** Independent bounded discovery, unaffected by clinical search/kind/edit filters. */
  people: {
    groups: IntakeReportQueueGroup[];
    totalGroups: number;
    counts: { pending: number; later: number; excluded: number; saved: number };
    nextCursor: string | null;
  };
  activity: IntakeReportQueueActivity;
}

export interface IntakeReportAcceptanceSelection {
  selectionReviewToken?: string;
  recordId: string;
  candidateId: string;
  candidateVersionId: string;
  mapping: Partial<IntakeClinicalMapping>;
  comparisons?: IntakePairDecision[];
}
export interface IntakeReportAcceptanceBlock {
  intakeId: string;
  proposalId: string | null;
  intakeVersion: number;
  reviewToken: string;
  selections: IntakeReportAcceptanceSelection[];
}
export interface IntakeReportAcceptanceRequest {
  mode?: 'partial-v1';
  operationId: string;
  blocks: IntakeReportAcceptanceBlock[];
}
export interface IntakeAtomicAcceptanceReceipt {
  operationId: string;
  status: 'accepted';
  atomic: true;
  at: string;
  selectedCount: number;
  acceptedCount: number;
  receipts: {
    intakeId: string;
    proposalId: string | null;
    intakeVersionBefore: number;
    intakeVersionAfter: number;
    reviewToken: string;
    records: (IntakeAcceptedRecord & { candidateId: string; candidateVersionId: string })[];
  }[];
}
export interface IntakePartialAcceptanceItem {
  selectionReviewToken: string;
  reviewedSelectionHash: string;
  intakeId: string;
  proposalId: string | null;
  recordId: string;
  candidateId: string;
  candidateVersionId: string;
  operationId: string;
  status: 'saved' | 'needs_review' | 'failed' | 'not_attempted';
  reasonCode?: string;
  message?: string;
  receipt?: IntakeAtomicAcceptanceReceipt['receipts'][number];
}
export interface IntakePartialAcceptanceReceipt {
  version: 1;
  operationId: string;
  status: 'completed';
  atomic: false;
  at: string;
  selectedCount: number;
  acceptedCount: number;
  receipts: IntakeAtomicAcceptanceReceipt['receipts'];
  items: IntakePartialAcceptanceItem[];
}
export type IntakeReportAcceptanceReceipt =
  IntakeAtomicAcceptanceReceipt | IntakePartialAcceptanceReceipt;
export interface IntakeReportAcceptanceResult {
  receipt: IntakeReportAcceptanceReceipt;
  replayed: boolean;
  durability: IntakeDurability;
}
