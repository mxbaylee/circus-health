import type { Intake, IntakeClinicalMapping } from './intake.ts';
import type { IntakeIdentityPerson } from './intake-identity.ts';
import type { SourceTextRegion } from './intake-source-text.ts';

/** Human-authored proposal from a retained source; creation never accepts a clinical record. */
export interface ManualSourceRecordRequest {
  version: number;
  operationId: string;
  sourceHash: string;
  sourceTextRevisionId: string;
  scope: SourceTextRegion;
  person:
    | { kind: 'self'; expectedVersion: number }
    | { kind: 'person'; noteId: string; expectedVersion: number };
  /** The user's transcription, kept separately from the proposed clinical interpretation. */
  literalText: string;
  clinical: Omit<IntakeClinicalMapping, 'subject' | 'personId' | 'sourceRecordId' | 'sourceSystem'>;
}

/** Written by the authorized host, never copied from a submitted envelope. */
export interface ManualSourceRecordReceipt {
  actor: 'profile-owner';
  operationId: string;
  fingerprint: string;
  profileId: string;
  intakeId: string;
  sourceHash: string;
  sourceTextRevisionId: string;
  scope: SourceTextRegion;
  person: IntakeIdentityPerson;
}

export interface ManualSourceRecordResult {
  intake: Intake;
  proposalId: string;
  recordId: string;
  groupId: string;
  reviewUrl: string;
  replayed: boolean;
}
