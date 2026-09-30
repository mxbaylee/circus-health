import type { IntakeClinicalMapping } from './intake.ts';
import type { IntakeIdentityPerson } from './intake-identity.ts';
import type { CorrectableClinicalKind } from './record-correction.ts';

export interface OwnershipRecordReference {
  kind: CorrectableClinicalKind;
  recordId: string;
  /** Omit only when requesting the first preview; approval always pins the returned version. */
  version?: string;
}
export type OwnershipSelection =
  | { type: 'records'; records: OwnershipRecordReference[] }
  | { type: 'report'; intakeId: string; groupId: string; groupVersionId: string };
export type OwnershipDestination =
  | { noteId: string; expectedVersion: number }
  | { newPerson: { fullName: string; relationship?: string } };
export interface OwnershipRequest {
  selection: OwnershipSelection;
  destination: OwnershipDestination;
  decisions?: {
    recordId: string;
    action?: 'keep_both' | 'link';
    targetRecordId?: string;
    /** Exact reviewed contents for a contribution split, never a clone of the canonical record. */
    splitMapping?: IntakeClinicalMapping;
    remainingMapping?: IntakeClinicalMapping;
    reviewedSplit?: boolean;
  }[];
  nameDecisions?: { key: string; outcome: 'old' | 'destination' | 'both' | 'unresolved' }[];
  relationshipDecisions?: { decisionId: string; action: 'withdraw' }[];
  reason?: string;
}
export interface OwnershipContribution {
  sourceRecordId: string;
  sourceFileId: string;
  reportScopes: string[];
  contentUrl: string;
  locator: unknown;
  version: string;
  selected: boolean;
  identity: string;
  acceptedMapping: IntakeClinicalMapping | null;
}
export interface OwnershipPreviewRecord extends OwnershipRecordReference {
  version: string;
  title: string;
  owner: IntakeIdentityPerson;
  action: 'move' | 'split' | 'link' | 'unchanged';
  mapping: IntakeClinicalMapping;
  contributions: OwnershipContribution[];
  remainingMapping?: IntakeClinicalMapping;
  splitReviewRequired: boolean;
  sourceReport?: { intakeId: string; groupId: string; groupVersionId: string };
  matches: {
    recordId: string;
    version: string;
    title: string;
    mapping: IntakeClinicalMapping;
    evidence: { label: string; locator: string; sourceRecordId: string; contentUrl: string }[];
  }[];
  blockers: string[];
  medicationActivity: 'inactive' | 'preserved' | null;
}
export interface OwnershipPreview {
  request: OwnershipRequest;
  profileId: string;
  version: number;
  scopeToken: string;
  title: 'Change person for this report' | 'Move these saved records and all their sources';
  destination: IntakeIdentityPerson | { newPerson: { fullName: string; relationship?: string } };
  records: OwnershipPreviewRecord[];
  pending: {
    recordId: string;
    candidateId: string;
    candidateVersionId: string;
    personId?: string;
  }[];
  blockers: string[];
  reportDefault: boolean;
  reportHolds: {
    defaultOperationId: string;
    intakeId: string;
    groupId: string;
    intakeVersion: number;
  }[];
  names: OwnershipNameEffect[];
  relationships: OwnershipRelationship[];
  /** This displayed correction and all its dependencies publish as one atomic group. */
  commitGroups: { id: string; recordIds: string[]; pendingCount: number; atomic: true }[];
}
export interface OwnershipCommit {
  operationId: string;
  request: OwnershipRequest;
  scopeToken: string;
  version: number;
}
export interface OwnershipReceipt {
  operationId: string;
  at: string;
  destinationPersonId: string;
  moved: number;
  unchanged: number;
  pending: number;
  replayed: boolean;
  groupId: string;
  groups?: {
    id: string;
    recordIds: string[];
    status: 'committed' | 'needs_review';
    operationId: string;
    moved: number;
    pending: number;
  }[];
  outcomes: {
    recordId: string;
    kind: CorrectableClinicalKind;
    destinationRecordId: string;
    action: OwnershipPreviewRecord['action'];
  }[];
}

export interface OwnershipNameEffect {
  key: string;
  noteId: string;
  personId: string;
  name: string;
  proposed: 'destination' | 'unresolved';
  decision: 'old' | 'destination' | 'both' | 'unresolved';
  independentSupport: boolean;
  unknownSupport: boolean;
  affectedSourceIds: string[];
  support: {
    operationId: string;
    sourceRecordIds: string[];
    intakeId: string;
    groupId: string;
    version: string;
    moves: boolean;
    affected: boolean;
  }[];
}
export interface OwnershipRelationship {
  decisionId: string;
  recordId: string;
  otherRecordId: string;
  action: string;
  resolution: 'withdraw' | 'move_together' | null;
}
