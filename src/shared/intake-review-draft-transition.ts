/** Response-only proof of one newly committed draft and certified preparation.
 * Never retained as clinical authority or returned for an operation replay. */
export interface IntakeReviewDraftTransition {
  format: 'health-intake-own-draft-transition-v1';
  profileId: string;
  intakeId: string;
  proposalId: string | null;
  recordId: string;
  candidateId: string;
  candidateVersionId: string;
  operationId: string;
  fromVersion: number;
  toVersion: number;
  fromRevision: number;
  toRevision: number;
}
