import type {
  IntakeReportQueueView,
  IntakeReportSourceCoverageEntry,
  IntakeReportSourceCoverageCounts,
} from './intake.ts';
export interface IntakeReportSourceScopeFragment {
  format: 'health-intake-report-source-scope-fragment-v1';
  intakeId: string;
  groupId: string;
  view: IntakeReportQueueView;
  scopeToken: string;
  section: 'target' | 'sourceEvidence';
  ordinal: number;
}
export interface IntakeReportSourceReviewTargetV2 {
  candidateId: string;
  candidateVersionId: string;
  proposalId: string | null;
  recordId: string;
  sourceRef: IntakeReportSourceCoverageEntry['sourceRef'];
  effectiveSource: string | null;
  detail:
    | { state: 'available'; title: string; date: string | null; kind: string }
    | {
        state: 'referenced';
        proposalId: string | null;
        recordId: string;
        candidateId: string;
        candidateVersionId: string;
      };
  evidence: IntakeReportSourceScopeFragment;
}
export interface IntakeReportSourceReviewV2 {
  format: 'health-intake-report-source-review-v2';
  profileId: string;
  intakeId: string;
  intakeVersion: number;
  groupId: string;
  groupVersionId: string;
  view: IntakeReportQueueView;
  scopeToken: string;
  targets: { items: IntakeReportSourceReviewTargetV2[]; total: number; nextCursor: string | null };
  coverage: Omit<IntakeReportSourceCoverageCounts, 'bySource'> & {
    sourceCount: number;
    bySource: {
      items: { source: string; count: number }[];
      total: number;
      nextCursor: string | null;
    };
  };
  sourceEvidence: {
    items: { preview: string; truncated: boolean; evidence: IntakeReportSourceScopeFragment }[];
    total: number;
    nextCursor: string | null;
  };
  conflictingSourceEvidence: boolean;
}
