import type { IntakeReview, IntakeReviewRecord } from './intake.ts';

export type IntakeClinicalReviewSection = 'records' | 'sourceContext' | 'coverageGaps';
type Section = IntakeClinicalReviewSection;
export interface IntakeClinicalReviewReference {
  format: 'health-intake-clinical-review-reference-v2';
  reviewToken: string;
  section: Section;
  ordinal: number;
  bytes: number;
}
export interface IntakeClinicalReviewPage {
  format: 'health-intake-clinical-review-page-v2';
  intakeId: string;
  proposalId: string | null;
  version: number;
  reviewToken: string;
  section: Section;
  summary: IntakeReview['summary'];
  sourceTextStale: boolean;
  total: number;
  items: (
    | { kind: 'value'; ordinal: number; value: unknown }
    | { kind: 'reference'; reference: IntakeClinicalReviewReference }
  )[];
  nextCursor: string | null;
}

/** Selected record authority contains no claim that unloaded sections are absent. */
export type IntakeClinicalReviewContext = Pick<
  IntakeReview,
  'intakeId' | 'proposalId' | 'version' | 'reviewToken' | 'summary' | 'sourceTextStale'
>;
export interface IntakeClinicalRecordRead {
  format: 'health-intake-clinical-record-v2';
  context: IntakeClinicalReviewContext;
  record:
    | { kind: 'record'; record: IntakeReviewRecord }
    | {
        kind: 'reference';
        reference: IntakeClinicalReviewReference;
        ownershipBlockers?: import('./ownership-identity-values.ts').OwnershipIdentityBlockersReference;
        draftHistory?: NonNullable<IntakeReviewRecord['draft']>['history'];
        reportGroups?: import('./intake-report-group-links.ts').IntakeReviewGroupLinksReference;
        selection: {
          recordId: string;
          candidateId?: string;
          candidateVersionId?: string;
          selectionReviewToken?: string;
        };
        policy: {
          canAcceptUnchanged: boolean;
          blockingIssueCount: number;
          unreviewedPairChoices: boolean;
          classification: IntakeReviewRecord['classification'];
          kind: IntakeReviewRecord['kind'];
        };
      };
}
export interface IntakeClinicalReviewFragment {
  encoding: 'base64';
  data: string;
  complete: boolean;
  nextOffset: number | null;
}
export type IntakeClinicalReviewRead =
  IntakeReview | IntakeClinicalReviewPage | IntakeClinicalRecordRead;
export function isClinicalReviewPage(
  value: IntakeClinicalReviewRead,
): value is IntakeClinicalReviewPage {
  return 'format' in value && value.format === 'health-intake-clinical-review-page-v2';
}
export function isClinicalRecordRead(
  value: IntakeClinicalReviewRead,
): value is IntakeClinicalRecordRead {
  return 'format' in value && value.format === 'health-intake-clinical-record-v2';
}
