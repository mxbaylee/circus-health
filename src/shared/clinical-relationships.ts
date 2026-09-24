import type { ClinicalPairReference, ClinicalReviewKind } from './clinical-review.ts';

export interface ClinicalRelationshipRecord {
  kind: ClinicalReviewKind;
  recordId: string;
}
export interface ClinicalRelationshipEvidence {
  sourceFileId: string;
  locator: string;
  quote: string;
}
interface RelationshipRequestBase {
  left: ClinicalRelationshipRecord;
  right: ClinicalRelationshipRecord;
  reason: string;
}
export type ClinicalRelationshipRequest = RelationshipRequestBase &
  (
    | {
        action: 'provider_amendment';
        mode: 'confirm' | 'withdraw';
        direction: 'left_to_right' | 'right_to_left';
        attestation?: 'reviewed_provider_amendment';
        evidence?: ClinicalRelationshipEvidence;
      }
    | {
        action: 'display_preference';
        mode: 'prefer_left' | 'prefer_right' | 'show_both' | 'undecided' | 'withdraw';
        attestation?: 'same_recorded_event';
      }
  );
export interface ClinicalRelationshipScope {
  format: 'clinical-relationship-scope-v1';
  profileId: string;
  left: ClinicalPairReference & { recordId: string };
  right: ClinicalPairReference & { recordId: string };
  previousDecisionId: string | null;
}
export interface ClinicalRelationshipSide {
  record: ClinicalRelationshipRecord;
  title: string;
  date: string | null;
  mapping: Record<string, unknown>;
  evidence: {
    sourceRecordId: string;
    sourceFileId: string;
    sha256: string;
    bytes: number;
    label: string;
    locator: string;
    contentUrl: string;
  }[];
  navigation: { kind: ClinicalReviewKind; recordId: string; appUrl: string; apiUrl: string };
}
export interface ClinicalRelationshipPreview {
  request: ClinicalRelationshipRequest;
  scope: ClinicalRelationshipScope;
  version: number;
  previewToken: string;
  left: ClinicalRelationshipSide;
  right: ClinicalRelationshipSide;
  effect: {
    supersedes: { fromRecordId: string; toRecordId: string } | null;
    preferredRecordId: string | null;
    showBoth: boolean;
    oneReviewedEvent: boolean;
  };
  originalsRetained: true;
}
/** Apply needs only the exact preview request, scope, version and token, plus its stable ID. */
export type ClinicalRelationshipApplyInput = Pick<
  ClinicalRelationshipPreview,
  'request' | 'scope' | 'version' | 'previewToken'
> & { operationId: string };
export interface ClinicalRelationshipReceipt {
  operationId: string;
  decisionId: string;
  at: string;
  action: ClinicalRelationshipRequest['action'];
  mode: ClinicalRelationshipRequest['mode'];
  scope: ClinicalRelationshipScope;
}
export type ClinicalRelationshipStatus =
  'current' | 'stale' | 'conflict' | 'undecided' | 'withdrawn';
export interface ClinicalRelationshipView {
  decisionId: string;
  previousDecisionId: string | null;
  at: string;
  request: ClinicalRelationshipRequest;
  scope: ClinicalRelationshipScope;
  reviewed: { left: ClinicalRelationshipSide; right: ClinicalRelationshipSide };
  status: ClinicalRelationshipStatus;
  currentDecision: boolean;
  leftNavigation: ClinicalRelationshipSide['navigation'] | null;
  rightNavigation: ClinicalRelationshipSide['navigation'] | null;
}
export interface ClinicalRelationshipProjection {
  record: ClinicalRelationshipRecord;
  relationships: ClinicalRelationshipView[];
  /** Existing pair decisions are readable history, never provider-amendment/display authority. */
  legacyPairs: {
    decisionId: string;
    outcome: string;
    reason: string;
    otherRecordId: string;
    status: 'historical' | 'unresolved';
  }[];
  display: {
    visibleByDefault: boolean;
    preferredRecordId: string | null;
    countGroupId: string;
    oneReviewedEvent: boolean;
    requiresReview: boolean;
  };
  truncated: boolean;
}
export interface ClinicalRelationshipApplyResult {
  receipt: ClinicalRelationshipReceipt;
  replayed: boolean;
  projections: ClinicalRelationshipProjection[];
  durability: { pending: boolean; error: string | null };
}
