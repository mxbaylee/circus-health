import type {
  OwnershipPreview,
  OwnershipReceipt,
  OwnershipPreviewRecord,
} from './record-ownership.ts';
import type {
  OwnershipNameEvidenceReference,
  OwnershipNameEvidencePage,
} from './ownership-name-reference.ts';
export interface OwnershipContributionReference {
  format: 'ownership-contributions-v1';
  key: string;
  total: number;
  selectedTotal: number;
  digest: string;
  url: string;
}
export type OwnershipContributionEvidence = Omit<
  import('./record-ownership.ts').OwnershipContribution,
  'reportScopes'
> & {
  reportScopes: { total: number; url: string };
};
export interface OwnershipMatchEvidenceReference {
  format: 'ownership-match-evidence-v1';
  key: string;
  total: number;
  digest: string;
  url: string;
}
export interface OwnershipBlockerReference {
  format: 'ownership-blockers-v1';
  key: string;
  count: number;
  digest: string;
  url: string;
}
export type OwnershipReportPreviewRecord = Omit<
  OwnershipPreviewRecord,
  'contributions' | 'matches' | 'blockers'
> & {
  blockers: string[] | OwnershipBlockerReference;
  contributions: OwnershipPreviewRecord['contributions'] | OwnershipContributionReference;
  matches: (Omit<OwnershipPreviewRecord['matches'][number], 'evidence'> & {
    evidence:
      OwnershipPreviewRecord['matches'][number]['evidence'] | OwnershipMatchEvidenceReference;
  })[];
};
export interface OwnershipReportEvidenceReference {
  token: string;
  digest: string;
  complete: true;
  recordTotal: number;
  pendingTotal: number;
  relationshipTotal: number;
  recordBlockerTotal: number;
  reportHoldTotal: number;
  url: string;
}
export type OwnershipReportPreviewReference = Omit<
  OwnershipPreview,
  'names' | 'records' | 'pending' | 'relationships' | 'commitGroups' | 'blockers' | 'reportHolds'
> & {
  blockers: string[] | OwnershipBlockerReference;
  namesIncluded: false;
  nameEvidence: OwnershipNameEvidenceReference;
  recordsIncluded: false;
  pendingIncluded: false;
  relationshipsIncluded: false;
  reportHoldsIncluded: false;
  reportEvidence: OwnershipReportEvidenceReference;
  commitGroups: {
    id: string;
    atomic: true;
    recordTotal: number;
    pendingCount: number;
    url: string;
  }[];
};
export type OwnershipReportEvidencePage = OwnershipNameEvidencePage<
  | OwnershipPreviewRecord
  | OwnershipPreview['pending'][number]
  | OwnershipPreview['relationships'][number]
>;
export type OwnershipReceiptReference = Omit<OwnershipReceipt, 'outcomes' | 'groups'> & {
  /** Explicit record selection bounds this metadata to 1,000 selected records. */
  groups?: OwnershipReceipt['groups'];
  outcomesIncluded: false;
  outcomeTotal: number;
  outcomeDigest: string;
  outcomesUrl: string;
};

export interface OwnershipReportItemReference {
  type: 'reference';
  section: 'records' | 'pending' | 'relationships' | 'holds';
  ordinal: number;
  bytes: number;
  token: string;
  url: string;
}
export type OwnershipReportPageItem =
  | OwnershipReportPreviewRecord
  | import('./record-ownership.ts').OwnershipPreview['pending'][number]
  | import('./record-ownership.ts').OwnershipPreview['relationships'][number]
  | import('./record-ownership.ts').OwnershipPreview['reportHolds'][number]
  | OwnershipReportItemReference;
export interface OwnershipReportPage {
  items: OwnershipReportPageItem[];
  total: number;
  complete: boolean;
  after: string | null;
}
export type OwnershipReceiptView = OwnershipReceipt | OwnershipReceiptReference;
export type OwnershipOutcomeEvidenceItem = OwnershipReceipt['outcomes'][number] & {
  previousOwnerNoteId: string;
  sourceReport?: { intakeId: string; groupId: string; groupVersionId: string };
};
