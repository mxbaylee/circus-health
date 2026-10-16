import type { IntakeReportAnchor, IntakeReportGroupMember } from './intake.ts';

export interface IntakeEvidencedIdentity {
  fullName?: string;
  birthDate?: string;
  /** Exact retained-original/person evidence key. It is not a display name. */
  personFingerprint?: string;
}

export interface IntakeIdentitySelfSnapshot {
  noteId: 'person-note:self';
  version: number;
  fullName: string | null;
  knownNames?: string[];
  challengedNames?: string[];
  futureNameOwners?: { name: string; personId: string }[];
  birthDate: string | null;
}

export interface IntakeIdentityConflict {
  field: 'fullName' | 'birthDate';
  selfValue: string | null;
  evidencedValue: string;
  /** Bounded conflict presentation; exact names remain in the record identity questions. */
  evidencedValueReference?: {
    format: 'health-intake-name-conflict-v1';
    names: number;
    bytes: number;
    sha256: string;
    evidence: 'record_identity_questions';
  };
  reason: 'self_mismatch' | 'evidence_disagreement';
}

/** Advisory model reading only; it never establishes original evidence or blocks assignment. */
export interface IntakeIdentityWarning {
  kind: 'model_birth_date_mismatch';
  modelBirthDate: string;
  savedBirthDate: string;
  personName: string;
}

export type IntakeIdentityReviewStatus =
  | 'evidenced_match'
  | 'prior_confirmation'
  | 'confirmation_required'
  | 'missing_warning'
  | 'conflict';

export type IntakeIdentityConfidence = 'strong' | 'limited' | 'possible' | 'none';

export interface IntakeIdentityPerson {
  noteId: string;
  personId: string;
  version: number;
  fullName: string;
  birthDate?: string | null;
  relationship?: string | null;
}

/** Report-level identity state. Clinical acceptance remains a separate operation. */
export interface IntakeIdentityReview {
  people?: IntakeIdentityPerson[];
  peopleTruncated?: boolean;
  assignedPerson?: IntakeIdentityPerson;
  confidence?: IntakeIdentityConfidence;
  /** A contradictory evidenced DOB cannot be assigned to Self. */
  selfBirthDateConflict?: boolean;
  defaultPerson?: 'self' | 'new';
  status: IntakeIdentityReviewStatus;
  blocking: boolean;
  message: string;
  /** A corrected association for this printed name needs a separate future-use choice. */
  challengedName?: string;
  correctedPerson?: { personId: string; fullName: string };
  /** Complete native scope except global version, plus ordered advisory warnings.
   * Historical views may omit this proof and cannot be automatically rebound. */
  evidenceCommitment?: {
    format: 'health-intake-identity-evidence-v1';
    sha256: string;
  };
  scope: IntakeIdentityScope | null;
  scopeReference?: IntakeIdentityScopeReference;
  scopeFragmentReference?: import('./intake-clinical-pages.ts').IntakeReviewFragmentReference;
  /** Complete selected receipt count for this report; history remains retained authority. */
  confirmationCount?: number;
  evidencedIdentity: IntakeEvidencedIdentity;
  self: IntakeIdentitySelfSnapshot;
  /** Exact evidence values that may be selected only while the Self fields stay blank. */
  offeredSelfFields: Pick<IntakeEvidencedIdentity, 'fullName' | 'birthDate'>;
  conflicts: IntakeIdentityConflict[];
  warnings?: IntakeIdentityWarning[];
  /** Explicit complete advisory collection when warnings do not fit the inline view. */
  warningsReference?:
    | {
        format: 'health-intake-identity-warnings-v1';
        scopeToken: string;
        snapshotId: string;
        count: number;
      }
    | {
        format: 'health-intake-identity-warnings-v2';
        scopeToken: string;
        /** Content-aware warning binding; the report scope snapshot is unchanged. */
        snapshotId: string;
        count: number;
        sha256: string;
      };
}

export interface IntakeIdentityAnswers {
  /** A human reading for this report only; null explicitly retains uncertainty. */
  birthDate?: string | null;
}

/** A human confirms only this displayed snapshot, never future group members. */
export interface IntakeIdentityScope {
  profileId: string;
  intakeId: string;
  intakeVersion: number;
  /** Pins Self identity while an explicit person choice is reviewed. */
  selfVersion?: number;
  groupId: string;
  groupVersionId: string;
  sourceHash: string;
  memberId: string | null;
  original: { filename: string; contentUrl: string; page: number | null };
  report: IntakeReportAnchor;
  subject: IntakeReportAnchor;
  /** Alternative readings and inferred centuries are suggestions requiring human review. */
  birthDateReview?: { choices: string[]; suggested?: string };
  /** Claims at this exact report boundary, pinned for an explicit scoped repair. */
  competingSubjects?: { groupId: string; subject: IntakeReportAnchor; groupVersionId: string }[];
  verificationMode: 'literal_text_match' | 'human_reviewed_original';
  /** Supported identity facts displayed with this exact scope. */
  evidencedIdentity?: IntakeEvidencedIdentity;
  /** Pins the retained original occurrence independently of a display URL. */
  evidenceOriginalFingerprint?: string;
  /** Full historical membership pins additions, changed versions and new occurrences. */
  membership: IntakeReportGroupMember[];
  /** Additional unresolved identity prompts, displayed in full before scoped confirmation. */
  questions?: { prompt: string; textAnchor?: string }[];
  /** Only current pending occurrences with the exact displayed identity issues. */
  targets: {
    candidateId: string;
    candidateVersionId: string;
    proposalId: string | null;
    recordId: string;
    title: string;
    issueId: string;
    /** Present when this occurrence also needs an explicit, non-generic identity answer. */
    issueIds?: string[];
  }[];
  /** All displayed pending records, including automatic matches, eligible for an explicit person choice. */
  assignmentTargets?: IntakeIdentityScope['targets'];
  scopeToken: string;
}

/** Complete selected scope; arrays are read through bounded pages, never inferred from a preview. */
export interface IntakeIdentityScopeReference extends Omit<
  IntakeIdentityScope,
  'membership' | 'targets' | 'assignmentTargets' | 'questions' | 'competingSubjects'
> {
  format: 'health-intake-identity-scope-v2';
  collection: {
    snapshotId: string;
    membership: number;
    targets: number;
    assignmentTargets: number;
    questions: number;
    competingSubjects: number;
  };
}
export type IntakeIdentityScopeSection =
  'membership' | 'targets' | 'assignmentTargets' | 'questions' | 'competingSubjects' | 'warnings';
export interface IntakeIdentityScopePage {
  format: 'health-intake-identity-scope-page-v2';
  scopeToken: string;
  /** Present only for an explicit content-aware warning snapshot selection. */
  snapshotId?: string;
  section: IntakeIdentityScopeSection;
  total: number;
  items: (
    | { kind: 'value'; value: unknown }
    | {
        kind: 'reference';
        reference: {
          format: 'health-intake-identity-item-v2';
          scopeToken: string;
          /** Pins a content-aware warning fragment across pages. */
          snapshotId?: string;
          section: IntakeIdentityScopeSection;
          ordinal: number;
          bytes: number;
        };
      }
  )[];
  nextCursor: string | null;
}

/** Records what the person actually confirmed; neither choice accepts clinical results. */
export type IntakeIdentityAttestation =
  | 'reviewed_original_and_membership'
  | 'confirmed_displayed_report_subject'
  | 'confirmed_displayed_identity_questions';

export interface IntakeIdentityConfirmation {
  version: number;
  operationId: string;
  scope: IntakeIdentityScope | IntakeIdentityScopeReference;
  outcome: 'this_is_me' | 'this_is_person';
  attestation: IntakeIdentityAttestation;
  identityAnswers?: IntakeIdentityAnswers;
  /** Exact printed name selected from the displayed subject when no safe name was derived. */
  printedName?: string;
  futureNameOwner?: {
    outcome: 'self' | 'person' | 'ask';
    noteId?: string;
    expectedVersion?: number;
  };
  personSelection?:
    | { noteId: string; expectedVersion: number }
    | { newPerson: { fullName: string; relationship?: string } };
  /** Optional one-action update; every selected value must equal an offered blank-field value. */
  selfUpdate?: {
    expectedVersion: number;
    fields: Pick<IntakeEvidencedIdentity, 'fullName' | 'birthDate'>;
  };
}

export interface IntakeIdentityReceipt {
  operationId: string;
  at: string;
  scope: IntakeIdentityScope;
  outcome: 'this_is_me' | 'this_is_person';
  attestation: IntakeIdentityAttestation;
  identityAnswers?: IntakeIdentityAnswers;
  draftIds: string[];
  assignedPerson?: IntakeIdentityPerson;
  knownNameAdded?: string;
  confirmedPrintedName?: string;
  selfUpdate?: {
    noteId: 'person-note:self';
    versionBefore: number;
    versionAfter: number;
    fields: Pick<IntakeEvidencedIdentity, 'fullName' | 'birthDate'>;
  };
}
