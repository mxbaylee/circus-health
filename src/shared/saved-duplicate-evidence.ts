/** Complete saved-side evidence stays separate from a bounded pair display. */
export interface RetainedDuplicateEvidenceReference {
  format: 'health-duplicate-evidence-snapshot-v1';
  source: { intakeId: string; sourceHash: string };
  snapshotId: string;
  count: number;
  digest: string;
}

export interface SavedDuplicateEvidenceReference {
  format: 'health-saved-evidence-v1';
  kind: 'observation' | 'medication' | 'procedure' | 'document';
  recordId: string;
  count: number;
  digest: string;
  scopeDigest: string;
  stateHash: string;
  url: string;
}
export interface SavedDuplicateEvidenceValue {
  label: string;
  locator: string;
  sourceRecordId: string;
  original?: unknown;
  contentUrl: string;
}
export type SavedDuplicateEvidenceItem =
  | { kind: 'value'; id: string; value: SavedDuplicateEvidenceValue }
  | { kind: 'fragment'; id: string; bytes: number; url: string };
export interface SavedDuplicateEvidencePage {
  reference: SavedDuplicateEvidenceReference;
  items: SavedDuplicateEvidenceItem[];
  complete: boolean;
  after: string | null;
}
