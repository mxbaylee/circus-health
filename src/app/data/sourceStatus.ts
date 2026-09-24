import type { SourceFile } from '../../shared/api';

export const SOURCE_SNAPSHOT_EXPLANATION =
  'These details describe the historical extraction snapshot kept with this source, not its current Import review. A retained original or proposal does not mean every part of the file was read.';

/** Current retained evidence/linkage, separate from historical extraction progress. */
export function sourceRecordStatus(status: string): string {
  switch (status) {
    case 'projected_reviewed':
    case 'retained_projected':
      return 'Linked to a saved health record';
    case 'retained_unprojected':
      return 'Evidence retained · no saved health record linked';
    case 'partial':
    case 'unreviewed':
      return 'Evidence retained';
    case 'mapped':
      return 'Linked to saved health records';
    case 'retained':
      return 'Evidence retained';
    default:
      return 'Saved-link state unavailable';
  }
}

/** Immutable extraction detail. This must only appear in historical context. */
export function sourceRecordHistoricalStatus(status: string): string | null {
  switch (status) {
    case 'partial':
      return 'Partial extraction recorded in this snapshot';
    case 'unreviewed':
      return 'Unreviewed when this snapshot was created';
    case 'retained':
      return 'Retention recorded; review state not recorded';
    default:
      return null;
  }
}

/** The retained file/proposal kind, separate from historical extraction coverage. */
export function sourceFileStatus(status: string): string {
  const parts = new Set(status.split(';').map((part) => part.trim()));
  if (parts.has('original_retained')) return 'Original retained';
  if (parts.has('derived_proposal')) return 'Proposal snapshot retained';
  if (parts.has('mapped')) return 'Linked to saved health records';
  if (parts.has('partial') || parts.has('unreviewed') || parts.has('clinical_coverage_unknown'))
    return 'Evidence retained';
  if (parts.has('retained') || parts.has('retained_original')) return 'File retained';
  return 'Retained-file state unavailable';
}

/** File coverage is an immutable retention-time snapshot, not current Import progress. */
export function sourceFileCoverageStatus(status: string): string {
  const parts = new Set(status.split(';').map((part) => part.trim()));
  if (parts.has('partial')) return 'Partial extraction recorded in this snapshot';
  if (parts.has('clinical_coverage_unknown'))
    return 'Full-file coverage was not recorded when this snapshot was created';
  if (parts.has('unreviewed')) return 'Unreviewed when this snapshot was created';
  if (parts.has('mapped')) return 'Saved-record mapping recorded in this snapshot';
  if (
    parts.has('original_retained') ||
    parts.has('derived_proposal') ||
    parts.has('retained') ||
    parts.has('retained_original')
  )
    return 'Extraction coverage was not separately recorded';
  return 'Historical coverage state unavailable';
}

/** Presentation contract for immutable acquisition and the separate reviewed label. */
export function sourceFileAttribution(file: Pick<SourceFile, 'provider' | 'reviewedSource'>): {
  acquisition: string;
  reviewedSource: string | null;
} {
  return {
    acquisition:
      file.provider === null || file.provider === 'Unknown source'
        ? 'Acquisition source not recorded'
        : file.provider,
    reviewedSource: file.reviewedSource || null,
  };
}
