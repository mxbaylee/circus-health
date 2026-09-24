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
  birthDate: string | null;
}

export interface IntakeIdentityConflict {
  field: 'fullName' | 'birthDate';
  selfValue: string | null;
  evidencedValue: string;
  reason: 'self_mismatch' | 'evidence_disagreement';
}

export type IntakeIdentityReviewStatus =
  | 'evidenced_match'
  | 'prior_confirmation'
  | 'confirmation_required'
  | 'missing_warning'
  | 'conflict';

export type IntakeIdentityConfidence = 'strong' | 'limited' | 'possible' | 'none';

/** Report-level identity state. Clinical acceptance remains a separate operation. */
export interface IntakeIdentityReview {
  confidence?: IntakeIdentityConfidence;
  status: IntakeIdentityReviewStatus;
  blocking: boolean;
  message: string;
  scope: IntakeIdentityScope | null;
  evidencedIdentity: IntakeEvidencedIdentity;
  self: IntakeIdentitySelfSnapshot;
  /** Exact evidence values that may be selected only while the Self fields stay blank. */
  offeredSelfFields: Pick<IntakeEvidencedIdentity, 'fullName' | 'birthDate'>;
  conflicts: IntakeIdentityConflict[];
}

/** A human confirms only this displayed snapshot, never future group members. */
export interface IntakeIdentityScope {
  profileId: string;
  intakeId: string;
  intakeVersion: number;
  groupId: string;
  groupVersionId: string;
  sourceHash: string;
  memberId: string | null;
  original: { filename: string; contentUrl: string; page: number | null };
  report: IntakeReportAnchor;
  subject: IntakeReportAnchor;
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
  scopeToken: string;
}

/** Records what the person actually confirmed; neither choice accepts clinical results. */
export type IntakeIdentityAttestation =
  | 'reviewed_original_and_membership'
  | 'confirmed_displayed_report_subject'
  | 'confirmed_displayed_identity_questions';

export interface IntakeIdentityConfirmation {
  version: number;
  operationId: string;
  scope: IntakeIdentityScope;
  outcome: 'this_is_me';
  attestation: IntakeIdentityAttestation;
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
  outcome: 'this_is_me';
  attestation: IntakeIdentityAttestation;
  draftIds: string[];
  selfUpdate?: {
    noteId: 'person-note:self';
    versionBefore: number;
    versionAfter: number;
    fields: Pick<IntakeEvidencedIdentity, 'fullName' | 'birthDate'>;
  };
}
