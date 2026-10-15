import type {
  Intake,
  IntakeDurability,
  IntakePackageFailure,
  IntakeAcceptedRecord,
  IntakeExtractionUnit,
  IntakeExtractionPlan,
} from './intake.ts';
import type { IntakePackagePlanV2 } from './intake-package-plan.ts';

/** Counts describe the selected authority, never just the rows in a loaded page. */
export type IntakeReviewCounts = Required<
  Pick<
    Intake,
    'needsReview' | 'pendingCount' | 'unansweredCount' | 'pendingWorkCount' | 'reviewLaterCount'
  >
>;
export type IntakeReviewSummary =
  { state: 'exact'; counts: IntakeReviewCounts } | { state: 'pending'; counts: null };

/** Shared display fields; this type deliberately contains no workflow or history arrays. */
export type IntakeHeader = Pick<
  Intake,
  | 'id'
  | 'providerId'
  | 'provider'
  | 'acquisition'
  | 'parentSourceFileId'
  | 'metadata'
  | 'archived'
  | 'visibilityVersion'
  | 'mimeType'
  | 'bytes'
  | 'sha256'
  | 'createdAt'
  | 'state'
  | 'version'
  | 'contentUrl'
  | 'durability'
> & { metadataState?: 'complete' | 'unloaded' } & IntakeFilename;

export interface IntakeFilenameReferenceV1 {
  format: 'health-intake-filename-reference-v1';
  intakeId: string;
  field: 'originalName';
  pins: IntakeSummaryPins;
  scalarHash: string;
  bytes: number;
}
export interface IntakeFilenameReferenceV2 {
  format: 'health-intake-filename-reference-v2';
  intakeId: string;
  field: 'originalName';
  pins: {
    sourceHash: string;
    logicalRoot: string;
    storageSequence: number;
    sourceVersionId: string;
    fieldBinding: string;
  };
  scalarHash: string;
  bytes: number;
}
export type IntakeFilenameReference = IntakeFilenameReferenceV1 | IntakeFilenameReferenceV2;
export interface IntakeMetadataScalarReference {
  format: 'health-intake-metadata-scalar-reference-v1';
  intakeId: string;
  field: 'originalName' | 'locator';
  pins: IntakeSummaryPins;
  scalarHash: string;
  bytes: number;
}
export interface IntakeMetadataScalarFragment {
  format: 'health-intake-metadata-scalar-fragment-v1';
  reference: IntakeMetadataScalarReference;
  encoding: 'json-string';
  text: string;
  complete: boolean;
  nextCursor: string | null;
}
export type IntakeFilename =
  | {
      filename: string;
      filenamePreview?: never;
      filenameTruncated?: false;
      filenameReference?: never;
      retainOnly?: boolean;
      packageSource?: boolean;
    }
  | {
      filename?: never;
      filenamePreview: string;
      filenameTruncated: true;
      filenameReference: IntakeFilenameReference;
      retainOnly: boolean;
      packageSource: boolean;
    };
export function intakeFilenameDisplay(intake: IntakeFilename): string {
  return intake.filename ?? intake.filenamePreview + '… (shortened)';
}
export function isIntakePackageHeader(intake: IntakeFilename & { mimeType: string }): boolean {
  if (typeof intake.packageSource === 'boolean') return intake.packageSource;
  return (
    /zip/i.test(intake.mimeType) ||
    (intake.filename !== undefined && /\.zip$/i.test(intake.filename))
  );
}
export interface IntakeFilenameFragment {
  format: 'health-intake-filename-fragment-v1';
  reference: IntakeFilenameReference;
  encoding: 'json-string';
  text: string;
  complete: boolean;
  nextCursor: string | null;
}

export interface IntakeSummaryPins {
  sourceHash: string;
  logicalRoot: string;
  domainVersion: number;
  version: number;
}

/** Legacy plan metadata; unit and batch collections remain separately selected. */
export interface IntakePlanHeader extends Pick<
  IntakeExtractionPlan,
  'id' | 'createdAt' | 'status' | 'pins'
> {
  format: 'health-intake-plan-header-v1';
  unitCount: number;
  batchCount: number;
}

export type IntakeSummaryV2 = IntakeHeader & {
  format: 'health-intake-summary-v2';
  pins: IntakeSummaryPins;
  review: IntakeReviewSummary;
  /** Omitted metadata is explicitly unloaded, not evidence of absent labels. */
  metadataState: 'complete' | 'unloaded';
  activePlan:
    | { state: 'pending'; plan: null }
    | { state: 'exact'; plan: IntakePackagePlanV2 | IntakePlanHeader | null };
  collections: {
    proposals: { total: number };
    importHistory: { total: number };
    reportGroups: { total: number };
    candidates: { total: number };
    questions: { total: number };
    plans: { total: number };
    packageFailures: { total: number; href: string };
  };
  links: {
    original: string;
    review: string;
    reports: string;
    sourceText: string;
    package: string;
    plan: string;
  };
  durability: IntakeDurability;
};

export interface IntakeSourceFieldReferenceV1 {
  format: 'health-intake-source-field-reference-v1';
  intakeId: string;
  sourceHash: string;
  sourceVersionId: string;
  field: 'mimeType' | 'providerId';
  bytes: number;
  scalarHash: string;
}

export interface IntakeSourceFieldFragmentV1 {
  format: 'health-intake-source-field-fragment-v1';
  reference: IntakeSourceFieldReferenceV1;
  text: string;
  complete: boolean;
  nextCursor: string | null;
}

/** A reference is a locator, not proof; the server rechecks its accepted source version. */
export type IntakeSourceFieldV3 =
  { kind: 'value'; value: string } | { kind: 'reference'; reference: IntakeSourceFieldReferenceV1 };

export interface IntakeMimePredicatesV3 {
  pdf: boolean;
  image: boolean;
  previewableImage: boolean;
  packageMime: boolean;
}

export type IntakeFilenameV3 =
  | Extract<IntakeFilename, { filename: string }>
  | (Omit<Extract<IntakeFilename, { filenameTruncated: true }>, 'filenameReference'> & {
      filenameReference: IntakeFilenameReferenceV2;
    });

/** V3 does not coerce a giant provider ID or MIME value into a display string. */
export type IntakeSummaryV3 = Pick<
  IntakeSummaryV2,
  | 'id'
  | 'parentSourceFileId'
  | 'archived'
  | 'visibilityVersion'
  | 'bytes'
  | 'sha256'
  | 'createdAt'
  | 'state'
  | 'version'
  | 'contentUrl'
  | 'durability'
  | 'pins'
  | 'review'
  | 'activePlan'
  | 'collections'
  | 'links'
> &
  IntakeFilenameV3 & {
    format: 'health-intake-summary-v3';
    source: {
      providerId: IntakeSourceFieldV3 | null;
      mimeType: IntakeSourceFieldV3;
      mimePredicates: IntakeMimePredicatesV3;
      providerName: { state: 'exact'; value: string } | { state: 'unloaded' };
    };
    acquisition:
      | { state: 'exact'; providerId: IntakeSourceFieldV3 | null; provider: string | null }
      | { state: 'unloaded' };
    metadata: IntakeHeader['metadata'];
    metadataState: 'complete' | 'unloaded';
  };

/** Internal readers still return V1/V2; only the public GET can select V3. */
export type IntakeRead = Intake | IntakeSummaryV2;
export type IntakePublicRead = IntakeRead | IntakeSummaryV3;
export function isIntakeSummary(
  value: IntakePublicRead,
): value is IntakeSummaryV2 | IntakeSummaryV3 {
  return (
    'format' in value &&
    (value.format === 'health-intake-summary-v2' || value.format === 'health-intake-summary-v3')
  );
}
export function isReferencedIntakeSummary(value: IntakePublicRead): value is IntakeSummaryV3 {
  return 'format' in value && value.format === 'health-intake-summary-v3';
}

export interface IntakePackageFailurePage {
  format: 'health-intake-package-failure-page-v1';
  intakeId: string;
  pins: IntakeSummaryPins;
  entries: {
    key: string;
    failure: Omit<IntakePackageFailure, 'originalFilename' | 'filename' | 'locator'> &
      Partial<Pick<IntakePackageFailure, 'originalFilename' | 'filename' | 'locator'>>;
    fieldReferences?: Partial<
      Record<IntakePackageFailureField, IntakePackageFailureFieldReference>
    >;
  }[];
  total: number;
  complete: boolean;
  nextCursor: string | null;
}

export type IntakePackageFailureField = 'originalFilename' | 'filename' | 'locator';
export interface IntakePackageFailureFieldReference {
  format: 'health-intake-package-failure-field-reference-v1';
  intakeId: string;
  key: string;
  field: IntakePackageFailureField;
  pins: IntakeSummaryPins;
  bytes: number;
}
export interface IntakePackageFailureFieldFragment {
  format: 'health-intake-package-failure-field-fragment-v1';
  reference: IntakePackageFailureFieldReference;
  encoding: 'json-string';
  text: string;
  complete: boolean;
  nextCursor: string | null;
}

/** Complete destination joins for the explicitly requested record IDs only. */
export interface IntakeAcceptedDestinations {
  format: 'health-intake-accepted-destinations-v1';
  intakeId: string;
  version: number;
  groupId: string;
  proposalId: string | null;
  records: IntakeAcceptedRecord[];
}

export interface IntakeUnitDetail {
  format: 'health-intake-unit-detail-v1';
  intakeId: string;
  planId: string;
  version: number;
  pins: IntakeSummaryPins;
  unit: Pick<IntakeExtractionUnit, 'id' | 'pages' | 'coverage'>;
}
