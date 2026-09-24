/** Accounting describes retained host-enumerated scope and explicit dispositions, not clinical truth. */
export interface IntakeReadingAccounting {
  state: 'empty' | 'pending' | 'unknown' | 'accounted' | 'accounted_with_gaps';
  sourceCount: number;
  accountedSources: number;
  pendingSources: number;
  unknownSources: number;
  parentAccountedChildren: number;
  allSourceOccurrencesAccounted: boolean;
  clinicalExtraction: 'unknown' | 'no_sources';
  units: {
    total: number;
    pending: number;
    extractedClaims: number;
    contextOnly: number;
    unreadable: number;
  };
  packageOccurrences: {
    total: number;
    accounted: number;
    pending: number;
    unknownRoles: number;
    duplicateBytes: number;
  };
  dependencies: { missing: number; uninspected: number; ambiguous: number };
  hostReading: {
    checkpoints: number;
    unknownSources: number;
    pendingWindows: number;
    dispositionedWindows: number;
    exhaustedSources: number;
  };
  pauseReasons: { reason: string; files: number }[];
}
