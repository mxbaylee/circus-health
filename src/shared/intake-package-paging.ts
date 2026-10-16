import type { IntakePackageInventory, IntakePackageMember } from './intake.ts';

/** Host-resolved identity for exact metadata fragments. No filesystem path,
 * offset into archive bytes or extraction capability is accepted from it. */
export interface IntakeMetadataFragmentReference {
  format: 'health-intake-metadata-reference-v1';
  kind: 'package_member' | 'package_unit';
  /** Unit metadata binds its exact retained plan, including superseded plans. */
  planId?: string;
  intakeId: string;
  inventoryId: string;
  memberId: string;
  ordinal: number;
  sourceHash: string;
  version: number;
  metadataHash: string;
  bytes: number;
}
export interface IntakePackageMemberReference {
  format: 'health-intake-package-member-reference-v1';
  memberId: string;
  ordinal: number;
  filenamePreview: string;
  filenameTruncated: boolean;
  metadata: IntakeMetadataFragmentReference;
}
/** Exact retained child identity with its full source name addressed separately. */
export interface IntakePackageOriginalIdentity {
  format: 'health-intake-package-original-identity-v2';
  id: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  contentUrl: string;
  filenamePreview: string;
  filenameTruncated: boolean;
  sourceMemberMetadata: IntakeMetadataFragmentReference;
}
export interface IntakePackageInventoryPaged extends Omit<IntakePackageInventory, 'members'> {
  format: 'health-intake-package-inventory-v2';
  inventoryId: string;
  members: (IntakePackageMember | IntakePackageMemberReference)[];
}
export interface IntakeMetadataFragment {
  format: 'health-intake-metadata-fragment-v1';
  reference: IntakeMetadataFragmentReference;
  text: string;
  offset: number;
  nextOffset: number | null;
  totalBytes: number;
  complete: boolean;
}
