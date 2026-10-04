import type { IntakeReportSourceConfirmation } from './intake.ts';
/** Owned immutable scopes in the selected report snapshot catalog. */
export interface IntakeReportSourceMembersReference {
  format: 'health-intake-report-source-members-v1';
  snapshotId: string;
  memberCount: number;
}
export interface IntakeReportSourceCoverageReference {
  format: 'health-intake-report-source-coverage-v1';
  snapshotId: string;
  entryCount: number;
}
/** Explicit native extension; unloaded member/coverage arrays are never fabricated. */
export interface IntakeReportSourceExtensionV2 {
  format: 'health-intake-report-source-extension-v2';
  id: string;
  groupVersionId: string;
  contextId: string;
  members: IntakeReportSourceMembersReference;
  coverageEntries?: IntakeReportSourceCoverageReference;
  authorityEntryId?: string;
  at: string;
}

/** Native original confirmation; the two exact scopes are owned references. */
export interface IntakeReportSourceConfirmationV2 extends Omit<
  IntakeReportSourceConfirmation,
  'members' | 'coverageEntries' | 'extensions'
> {
  format: 'health-intake-report-source-confirmation-v2';
  members: IntakeReportSourceMembersReference;
  coverageEntries?: IntakeReportSourceCoverageReference;
}

/** Bounded command result for either retained legacy or native receipt evidence. */
export interface IntakeReportSourceReceiptV2 extends Omit<
  IntakeReportSourceConfirmation,
  'members' | 'coverageEntries' | 'extensions'
> {
  format: 'health-intake-report-source-receipt-v2';
  memberCount: number;
  coverageEntryCount: number;
  extensionCount: number;
  evidence: { intakeId: string; address: string; logicalPin: string };
}
