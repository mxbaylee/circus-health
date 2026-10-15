import type { IntakeExtractionPlan, IntakeExtractionUnit } from './intake.ts';
import type { IntakeMetadataFragmentReference } from './intake-package-paging.ts';

/** Explicit paged package plan. It never represents unloaded v1 arrays as empty. */
export interface IntakePackagePlanV2 {
  format: 'health-intake-package-plan-v2';
  id: string;
  createdAt: string;
  status: 'active' | 'superseded';
  pins: IntakeExtractionPlan['pins'] & { connectionIdentity?: string };
  inventory: {
    id: string;
    sourceHash: string;
    memberCount: number;
    totalExpandedBytes: number;
    uniqueByteContents: number;
  };
  unitRecipe: 'health-intake-package-member-unit-v1';
  unitCount: number;
}

/** A page has explicit scope; it cannot stand in for complete plan coverage. */
export interface IntakePackageUnitPage {
  format: 'health-intake-package-unit-page-v1';
  intakeId: string;
  planId: string;
  version: number;
  inventoryId: string;
  units: (IntakePackageUnitSummary | IntakePackageUnitReference)[];
  total: number;
  offset: number;
  nextOffset: number | null;
  pageComplete: boolean;
}

/** Attempt history is separately paged; this summary makes no empty-history claim. */
export type IntakePackageUnitSummary = Omit<IntakeExtractionUnit, 'attempts'> & {
  attemptCount: number;
};

export interface IntakePackageUnitReference {
  format: 'health-intake-package-unit-reference-v1';
  id: string;
  memberId: string;
  filenamePreview: string;
  filenameTruncated: boolean;
  metadata: IntakeMetadataFragmentReference;
}

export interface IntakePackagePlanResult {
  format: 'health-intake-package-plan-result-v2';
  intakeId: string;
  version: number;
  plan: IntakePackagePlanV2;
  replayed: boolean;
}
