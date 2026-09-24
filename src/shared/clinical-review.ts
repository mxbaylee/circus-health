/** Discovery locates evidence. None of these signals establishes clinical equivalence. */
export type RelatedRecordReason =
  'same_code' | 'same_label' | 'label_terms' | 'search_match' | 'same_date' | 'same_issuer';
export interface RelatedRecordPage {
  query: string;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** More than the bounded result window matched; refine the search. */
  truncated: boolean;
  maximumResults: number;
}
export interface RelatedRecordSearch {
  query?: string;
  cursor?: string | null;
  limit?: number;
}
export type ClinicalReviewKind = 'observation' | 'medication' | 'procedure' | 'document';
export interface ClinicalPairReference {
  kind: ClinicalReviewKind;
  sourceRecordId: string;
  identity: string;
  version: string;
  /** Exact candidate envelope for incoming records; exact accepted row for saved records. */
  stateHash: string;
  /** Includes retained original hashes and exact source occurrences. */
  evidenceHash: string;
}
export interface IntakePairScopeV1 {
  format: 'intake-pair-scope-v1';
  profileId: string;
  incoming: ClinicalPairReference;
  saved: ClinicalPairReference & { recordId: string };
  token: string;
}
export interface IntakePairScopeV2 {
  format: 'intake-pair-scope-v2';
  profileId: string;
  /** Transient apply CAS. A successful transaction intentionally advances it. */
  requestRevision: number;
  intakeVersion: number;
  /** Durable candidate/person/report/source authority, excluding workflow bookkeeping. */
  contextHash: string;
  incoming: ClinicalPairReference;
  saved: ClinicalPairReference & { recordId: string };
  activeAttachment: null | {
    transitionId: string;
    evidenceId: string;
    targetKind: ClinicalReviewKind;
    targetRecordId: string;
  };
  token: string;
}
export type IntakePairScope = IntakePairScopeV1 | IntakePairScopeV2;
export type IntakePairDraftScopeStatus = 'none' | 'current' | 'missing' | 'stale';
/** Only retained pending choices block readiness; discovery and historical decisions do not. */
export const hasUnreviewedPairChoices = (record: {
  comparisonDrafts?: { status: IntakePairDraftScopeStatus }[];
}): boolean =>
  (record.comparisonDrafts || []).some(
    (choice) => choice.status === 'missing' || choice.status === 'stale',
  );
export interface IntakeRelatedRecordsRequest extends RelatedRecordSearch {
  proposalId: string | null;
  recordId: string;
  candidateVersionId: string;
}
export interface IntakeRelatedRecordsResult {
  intakeId: string;
  proposalId: string | null;
  recordId: string;
  candidateVersionId: string;
  intakeVersion: number;
  reviewToken: string;
  comparisons: IntakeEvidenceComparison[];
  page: RelatedRecordPage;
}
import type { IntakeEvidenceComparison } from './intake.ts';
