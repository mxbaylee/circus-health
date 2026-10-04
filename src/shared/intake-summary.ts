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

export interface IntakeFilenameReference {
  format: 'health-intake-filename-reference-v1';
  intakeId: string;
  field: 'originalName';
  pins: IntakeSummaryPins;
  scalarHash: string;
  bytes: number;
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

/** V1 is still complete. V2 requires the named selected-page APIs. */
export type IntakeRead = Intake | IntakeSummaryV2;
export function isIntakeSummary(value: IntakeRead): value is IntakeSummaryV2 {
  return 'format' in value && value.format === 'health-intake-summary-v2';
}

export interface IntakePackageFailurePage {
  format: 'health-intake-package-failure-page-v1';
  intakeId: string;
  pins: IntakeSummaryPins;
  entries: { key: string; failure: IntakePackageFailure }[];
  total: number;
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
