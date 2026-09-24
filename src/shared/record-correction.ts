import type { IntakeClinicalMapping } from './intake.ts';

export type CorrectableClinicalKind = 'observation' | 'medication' | 'procedure' | 'document';
/** A selected incoming occurrence; the host resolves its supporting original. */
export interface CorrectionSupportingReference {
  intakeId: string;
  proposalId: string | null;
  recordId: string;
  candidateId: string;
  candidateVersionId: string;
  originalSourceFileId: string;
}
export interface CorrectionSupportingEvidence extends CorrectionSupportingReference {
  intakeVersion: number;
  originalSourceHash: string;
  filename: string;
  contentUrl: string;
  locator: string;
  memberId: string | null;
  title: string;
}
export interface RecordCorrectionRequest {
  kind: CorrectableClinicalKind;
  recordId: string;
  set: Partial<IntakeClinicalMapping>;
  reason: string;
  supportingEvidence?: CorrectionSupportingReference[];
}
export interface RecordCorrectionApplyRequest extends RecordCorrectionRequest {
  operationId: string;
  version: number;
  previewToken: string;
}
export interface RecordCorrectionDestination {
  kind: CorrectableClinicalKind;
  recordId: string;
  appUrl: string;
  apiUrl: string;
}
export interface RecordCorrectionPreview {
  request: RecordCorrectionRequest;
  version: number;
  previewToken: string;
  before: IntakeClinicalMapping;
  after: IntakeClinicalMapping;
  evidence: {
    sourceRecordId: string;
    sourceFileId: string;
    acquiringSource: string | null;
    contentUrl: string;
    [key: string]: unknown;
  }[];
  supportingEvidence: CorrectionSupportingEvidence[];
  supportedTargetKinds: CorrectableClinicalKind[];
  editableFields: (keyof IntakeClinicalMapping)[];
  reclassification: boolean;
  destination: RecordCorrectionDestination;
  sourceUnchanged: true;
}
export interface RecordCorrectionApplyResult {
  operationId: string;
  replayed: boolean;
  destination: RecordCorrectionDestination;
  sourceUnchanged: true;
  receipt: {
    id: string;
    appliedRevision: number;
    result: {
      kind: CorrectableClinicalKind;
      previousKind: CorrectableClinicalKind;
      recordId: string;
      exceptionId: string;
      before: IntakeClinicalMapping;
      after: IntakeClinicalMapping;
      reason?: string;
      supportingEvidence?: CorrectionSupportingEvidence[];
      sourceUnchanged: true;
    };
  };
  durability?: { pending: boolean; error?: string | null; [key: string]: unknown };
}
