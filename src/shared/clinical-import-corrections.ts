import type { IntakeReviewDraftHistory } from './intake.ts';

export interface ClinicalImportCorrectionHistoryPage {
  format: 'health-clinical-import-corrections-v1';
  recordId: string;
  kind: 'observation' | 'medication' | 'procedure' | 'document';
  entries: Array<{
    id: string;
    sourceRecordId: string;
    intakeId: string;
    candidateId: string;
    candidateVersionId: string;
    proposalId: string | null;
    draftId: string;
    at: string;
    history: IntakeReviewDraftHistory;
  }>;
  complete: boolean;
  nextCursor: string | null;
}
