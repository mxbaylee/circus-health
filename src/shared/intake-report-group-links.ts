import type { IntakeReviewGroupReference } from './intake.ts';
/** A reference to the complete selected sequence; first is navigation metadata only. */
export interface IntakeReviewGroupLinksReference {
  format: 'health-intake-report-group-links-v1';
  count: number;
  first?: IntakeReviewGroupReference;
  selection: {
    candidateId: string;
    candidateVersionId: string;
    recordId: string;
    proposalId: string | null;
  };
}
export type IntakeReviewGroupLinks = IntakeReviewGroupReference[] | IntakeReviewGroupLinksReference;
export function firstReportGroup(value: IntakeReviewGroupLinks | undefined) {
  return Array.isArray(value) ? value[0] : value?.first;
}
