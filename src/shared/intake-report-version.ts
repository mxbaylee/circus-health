import type { IntakeReportGroupVersion } from './intake.ts';
/** A selected immutable member snapshot. It never substitutes an unloaded v1 array. */
export interface IntakeReportMembersReference {
  format: 'health-intake-report-members-v1';
  snapshotId: string;
  memberCount: number;
  occurrenceCount: number;
}
export interface IntakeReportGroupVersionV2 extends Omit<IntakeReportGroupVersion, 'members'> {
  format: 'health-intake-report-group-version-v2';
  members: IntakeReportMembersReference;
}
