import type { IntakeDurability, IntakeEvidenceLocator } from './intake.ts';

export type IntakePersonRole = 'clinician' | 'relative';
export type IntakePersonField =
  'fullName' | 'title' | 'relationship' | 'phone' | 'email' | 'schedulingUrl' | 'medicalHistory';

/** Unreviewed, source-grounded Person data carried by one retained envelope. */
export interface IntakePersonEnvelopeProposal {
  id: string;
  fullName: string;
  role: IntakePersonRole;
  title?: string;
  relationship?: string;
  phone?: string;
  email?: string;
  schedulingUrl?: string;
  medicalHistory?: string;
  evidence: {
    textAnchor: string;
    supports: IntakePersonField[];
    locator?: string;
    memberId?: string;
    page?: number;
  }[];
  uncertainties?: string[];
}

export type IntakePersonProposalState = 'pending' | 'later' | 'excluded' | 'saved';

export interface IntakePersonMatch {
  noteId: string;
  personId: string;
  title: string;
  fullName: string;
  relationship: string | null;
  version: number;
  reason: string;
}

export interface IntakePersonEvidence extends IntakeEvidenceLocator {
  textAnchor: string;
  supports: IntakePersonField[];
  memberId?: string;
  page?: number;
}

export interface IntakePersonProposal {
  id: string;
  version: string;
  state: IntakePersonProposalState;
  intakeId: string;
  intakeVersion: number;
  proposalId: string | null;
  envelopeRecordId: string;
  envelopeId: string;
  groupId: string;
  groupVersionId: string;
  title: string;
  person: {
    fullName: string;
    relationship?: string;
    phone?: string;
    email?: string;
    schedulingUrl?: string;
    medicalHistory?: string;
    tags: ('Family' | 'Professional')[];
  };
  uncertainties: string[];
  evidence: IntakePersonEvidence[];
  source: {
    sourceRecordId: string;
    filename: string;
    contentUrl: string;
    originalSourceFileId: string;
    originalSha256: string;
    member: { memberId: string; filename: string | null; locator: string | null } | null;
  };
  matches: IntakePersonMatch[];
  matchCount: number;
  matchesTruncated: boolean;
  selfMatch?: { reason: string };
  saved?: { noteId: string; personId: string; version: number; resultUrl: string };
}

export interface IntakePeopleQueue {
  groupId: string;
  people: IntakePersonProposal[];
  totalPeople: number;
  peopleNextCursor: string | null;
}

export interface IntakePersonDispositionRequest {
  operationId: string;
  intakeId: string;
  proposalId: string;
  proposalVersion: string;
  state: 'pending' | 'later' | 'excluded';
  intakeVersion: number;
}

export interface IntakePersonApplyRequest {
  operationId: string;
  intakeId: string;
  proposalId: string;
  proposalVersion: string;
  action: 'add' | 'update';
  noteId?: string;
  version?: number;
}

export interface IntakePersonApplyResult {
  proposalId: string;
  status: 'saved';
  action: 'add' | 'update';
  noteId: string;
  personId: string;
  version: number;
  resultUrl: string;
  replayed: boolean;
  durability: IntakeDurability & {
    personal: {
      configured: boolean;
      dirty: boolean;
      revision: number;
      persistedRevision: number | null;
      conflicted: boolean;
      lastError: string | null;
    };
  };
}
