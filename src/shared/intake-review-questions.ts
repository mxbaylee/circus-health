import type { IntakeReviewFragmentReference } from './intake-clinical-pages.ts';

/** Complete selected questions are available through selected-record sections. */
export interface IntakeReviewQuestionsReference {
  format: 'health-intake-review-questions-v1';
  count: number;
  candidateId: string;
  candidateVersionId: string;
  reference: IntakeReviewFragmentReference;
}
