import type {
  OwnershipNameEffect,
  OwnershipPreview,
  OwnershipPreviewRecord,
} from './record-ownership.ts';

export interface OwnershipNameEvidenceReference {
  token: string;
  digest: string;
  decisionDigest: string;
  total: number;
  supportTotal: number;
  targetTotal: number;
  complete: true;
  url: string;
}
export type OwnershipNameHeader = Omit<OwnershipNameEffect, 'support' | 'affectedSourceIds'> & {
  supportTotal: number;
  affectedSourceTotal: number;
};
export interface OwnershipNameEvidencePage<T> {
  items: T[];
  total: number;
  complete: boolean;
  after: string | null;
}
export type OwnershipNameSupportHeader = Omit<
  OwnershipNameEffect['support'][number],
  'sourceRecordIds'
> & {
  ordinal: number;
  targetTotal: number;
};
export type OwnershipPreviewReference = Omit<OwnershipPreview, 'names' | 'records' | 'blockers'> & {
  blockers: string[] | import('./ownership-report-reference.ts').OwnershipBlockerReference;
  records: (Omit<OwnershipPreviewRecord, 'blockers'> & {
    blockers: string[] | import('./ownership-report-reference.ts').OwnershipBlockerReference;
  })[];
  namesIncluded: false;
  nameEvidence: OwnershipNameEvidenceReference;
};
export type OwnershipPreviewView =
  | OwnershipPreview
  | OwnershipPreviewReference
  | import('./ownership-report-reference.ts').OwnershipReportPreviewReference;
export interface OwnershipNameSupportReference {
  operationId: string;
  effectKey: string;
  total: number;
  digest: string;
  complete: true;
  url: string;
}
