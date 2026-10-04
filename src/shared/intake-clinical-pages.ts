import type { IntakePersonProposal, IntakePersonProposalState } from './intake-people.ts';
import type { IntakeClinicalReviewReference } from './intake-clinical-review.ts';
import type {
  IntakeImportFeedKind,
  IntakeImportFeedRecord,
  IntakeReportQueueCounts,
  IntakeReportQueueView,
  IntakeReportQueueRecord,
  IntakeReportQueueRecordState,
  IntakeReportSourceCoverageCounts,
} from './intake.ts';
export interface IntakeReviewFragmentReference {
  format: 'health-intake-review-fragment-v1';
  logical: {
    root: { hash: string; count: number; height: number; first: string; last: string } | null;
    domainVersion: number;
  };
  address: string;
  field?: string;
}
type Evidence = unknown | IntakeReviewFragmentReference;
export interface CollectionReportGroupSummary {
  format: 'health-intake-report-group-v2';
  intakeId: string;
  intakeVersion: number;
  groupId: string;
  groupOrdinal: number;
  groupVersionId: string | null;
  basis: string;
  discoveryOrder: number | null;
  title: Evidence;
  source: Evidence;
  sourceScope: 'report' | 'intake' | 'issuer' | null;
  date: string | null;
  original: { filename: Evidence; contentUrl: string; parentSourceFileId: string | null };
  member: { memberId: string; filename: Evidence; locator: Evidence } | null;
  report: Evidence;
  reportContext: Evidence;
  counts: IntakeReportQueueCounts;
  peopleCounts: { pending: number; later: number; excluded: number; saved: number };
  sourceCoverage: { current: CollectionSourceCoverage; saved: CollectionSourceCoverage };
  sourceReview: { intakeId: string; groupId: string; view: 'all'; scopeToken: string } | null;
  records: { intakeId: string; groupId: string };
  people: { intakeId: string; groupId: string };
}
export interface CollectionSourceCoverage extends Omit<
  IntakeReportSourceCoverageCounts,
  'bySource'
> {
  sourceCount: number;
  /** Bounded first page; all labels remain available through the source coverage endpoint. */
  bySource: {
    items: { source: string; count: number }[];
    total: number;
    nextCursor: string | null;
  };
}
type Text = string | IntakeReviewFragmentReference;
export type CollectionPersonProposal = Omit<IntakePersonProposal, 'source'> & {
  source: Omit<IntakePersonProposal['source'], 'filename' | 'member'> & {
    filename: Text;
    member: { memberId: string; filename: Text | null; locator: Text | null } | null;
  };
};
export interface CollectionPersonReference {
  format: 'health-intake-person-reference-v2';
  intakeId: string;
  id: string;
  binding: string;
  bytes: number;
  selection: {
    id: string;
    version: string;
    intakeVersion: number;
    state: IntakePersonProposalState;
  };
  policy: { selfMatch: boolean; canAdd: boolean };
  matches: {
    items: { noteId: string; version: number; title: string }[];
    total: number;
    truncated: boolean;
  };
  saved?: IntakePersonProposal['saved'];
}
export interface CollectionPeoplePage {
  format: 'health-intake-people-page-v2';
  intakeId: string;
  groupId: string | null;
  selectedPersonId: string | null;
  people: (
    | { kind: 'person'; person: CollectionPersonProposal }
    | { kind: 'reference'; reference: CollectionPersonReference }
  )[];
  totalPeople: number;
  counts: Record<IntakePersonProposalState, number>;
  nextCursor: string | null;
}
export interface CollectionReportGroupReference {
  format: 'health-intake-report-group-reference-v2';
  binding: string;
  intakeId: string;
  groupId: string;
  ordinal: number;
  bytes: number;
}
export interface CollectionIntakeReportRecordPage {
  format: 'health-intake-report-record-page-v2';
  intakeId: string;
  version: number;
  /** Clinical records only. People and reading activity retain their own selected read contracts. */
  scope: 'clinical_records';
  view: IntakeReportQueueView;
  records: ({
    groupId: string;
    proposalId: string | null;
    reviewToken: string;
    queueState: IntakeReportQueueRecordState;
    selectable: boolean;
  } & (
    | { kind: 'record'; record: IntakeReportQueueRecord }
    | {
        kind: 'record_reference';
        reference: IntakeClinicalReviewReference;
        selection: { recordId: string; candidateVersionId?: string };
      }
  ))[];
  totalRecords: number;
  nextCursor: string | null;
}
export interface CollectionFeedRecord {
  intakeId: string;
  groupId: string;
  groupOrdinal: number;
  proposalId: string | null;
  intakeVersion: number;
  reviewToken: string;
  feedKind: Exclude<IntakeImportFeedKind, 'person'>;
  feedKey: string;
  feedOrder: string;
  manuallyEdited: boolean;
  detail:
    | { kind: 'record'; record: IntakeImportFeedRecord }
    | {
        kind: 'reference';
        reference: IntakeClinicalReviewReference;
        selection: { recordId: string; candidateVersionId?: string };
      };
}

export interface CollectionReportActivity {
  format: string;
  binding: string;
  runningFiles: number;
  pausedFiles: number;
  queuedFiles: number;
  filesAwaitingConversion: number;
  remainingUnits: { state: 'exact'; value: number } | { state: 'pending'; value: null };
  extractionUnknownFiles: number;
  extractionComplete: boolean;
  allCurrentReportsReviewed: boolean;
  readingAccounting: { state: 'referenced'; scope: string; binding: string };
}
export interface CollectionReportDetail {
  format: 'health-intake-report-detail-v2';
  group: CollectionReportGroupSummary;
  records: CollectionIntakeReportRecordPage;
  people: CollectionPeoplePage;
}
export interface CollectionImportFeed {
  format: 'health-intake-import-feed-v2';
  view: IntakeReportQueueView;
  records: CollectionFeedRecord[];
  totalRecords: number;
  totalGroups: number;
  nextCursor: string | null;
  counts: IntakeReportQueueCounts;
  kindCounts: Record<IntakeImportFeedKind, number>;
  groups: CollectionReportGroupReference[];
  people: {
    groups: CollectionReportGroupReference[];
    totalGroups: number;
    counts: { pending: number; later: number; excluded: number; saved: number };
    nextCursor: string | null;
  };
  activity: CollectionReportActivity;
}
export function isCollectionReportDetail(value: unknown): value is CollectionReportDetail {
  return (
    !!value &&
    typeof value === 'object' &&
    'format' in value &&
    value.format === 'health-intake-report-detail-v2'
  );
}
export function isCollectionImportFeed(value: unknown): value is CollectionImportFeed {
  return (
    !!value &&
    typeof value === 'object' &&
    'format' in value &&
    value.format === 'health-intake-import-feed-v2'
  );
}
