import type {
  IntakeClinicalMapping,
  IntakeEvidenceComparison,
  IntakeIssueResolution,
  IntakePairDecision,
  IntakeReviewDraftUpdate,
  IntakeReviewIssue,
  IntakeReviewRecord,
} from './intake.ts';
import type { IntakeClinicalReviewContext } from './intake-clinical-review.ts';
import type { RelatedRecordPage, RelatedRecordSearch } from './clinical-review.ts';
import type { SavedDuplicateEvidenceReference } from './saved-duplicate-evidence.ts';

export type ClinicalRecordSection =
  | 'issues'
  | 'comparisons'
  | 'comparisonDrafts'
  | 'mapping'
  | 'reportGroups'
  | 'questions'
  | 'ownershipBlockers';
export interface ClinicalRecordSelection {
  proposalId: string | null;
  recordId: string;
  candidateVersionId: string;
}
export interface ClinicalRecordSectionRequest extends ClinicalRecordSelection {
  section: ClinicalRecordSection;
  cursor?: string | null;
  limit?: number;
  bytes?: number;
  comparisonSearch?: RelatedRecordSearch;
}
export interface ClinicalRecordSectionReference extends ClinicalRecordSelection {
  format: 'health-clinical-record-section-reference-v1';
  reviewToken: string;
  section: ClinicalRecordSection;
  ordinal: number;
  bytes: number;
  comparisonSearch?: RelatedRecordSearch;
}
export type ClinicalRecordSectionControl =
  | {
      kind: 'question';
      id: string;
      status: import('./intake.ts').IntakeQuestion['status'];
      field: string | null;
      answer?: string;
      answerReferenced: boolean;
      answerHistory?: import('./intake.ts').IntakeQuestion['answerHistory'];
    }
  | { kind: 'ownershipBlocker' }
  | { kind: 'reportGroup'; groupId: string; groupVersionId: string }
  | {
      kind: 'issue';
      id: string;
      issueKind: IntakeReviewIssue['kind'];
      field: string | null;
      blocking: boolean;
      status: IntakeReviewIssue['status'];
      outcome?: IntakeIssueResolution['outcome'];
      mappingKind: IntakeClinicalMapping['kind'];
      resolutionFields: (keyof IntakeClinicalMapping)[];
      fieldValue?: string;
      fieldValueReferenced: boolean;
      questionAnswerHistory?: import('./intake.ts').IntakeQuestion['answerHistory'];
    }
  | {
      kind: 'pair';
      otherRecordId: string;
      /** A token identifies the exact fresh scope held by the server. */
      scopeToken?: string;
      targetAvailable: boolean;
      draftScopeStatus?: NonNullable<IntakeReviewRecord['comparisonDrafts']>[number]['status'];
      outcome?: IntakePairDecision['outcome'];
      occurrenceEvidence?: IntakePairDecision['occurrenceEvidence'];
      reason?: string;
      reasonReferenced: boolean;
      savedEvidence?: SavedDuplicateEvidenceReference;
      previousDecision?: Pick<
        NonNullable<IntakeEvidenceComparison['previousDecision']>,
        'outcome' | 'attachmentStatus' | 'scopeStatus'
      >;
    }
  | { kind: 'mapping'; field: keyof IntakeClinicalMapping; editable: boolean; present: boolean };
export interface ClinicalRecordSectionPage {
  format: 'health-clinical-record-section-page-v1';
  context: IntakeClinicalReviewContext;
  selection: ClinicalRecordSelection & { selectionReviewToken?: string };
  section: ClinicalRecordSection;
  total: number;
  items: {
    ordinal: number;
    control: ClinicalRecordSectionControl;
    detail:
      | { kind: 'value'; value: unknown }
      | { kind: 'reference'; reference: ClinicalRecordSectionReference };
  }[];
  nextCursor: string | null;
  discoveryPage?: RelatedRecordPage;
}
/** Sparse edits retain unseen mapping fields, resolutions and pair choices on the server. */
export interface ClinicalRecordAction extends ClinicalRecordSelection {
  version: number;
  operationId: string;
  reviewToken: string;
  patch?: Pick<
    IntakeReviewDraftUpdate,
    'mapping' | 'resolutions' | 'correctionReason' | 'correctionPatch' | 'answers'
  >;
  pair?: Omit<IntakePairDecision, 'scope'> & { scopeToken: string };
  /** Explicitly remove a pending choice whose saved target no longer exists. */
  clearMissingPair?: string;
}
