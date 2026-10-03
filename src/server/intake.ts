import { cachedSourceContextVersions } from './intake-source-context-classification.ts';
import {
  intakeDetails as details,
  registerIntakeFile as registerFile,
  writeIntakeDetails,
  type IntakeDetails,
} from './intake-state-access.ts';
import { readIntakeEnvelopeText } from './intake-authority.ts';
import { copiedManualSourceRecordApplies } from './intake-manual-copy.ts';
import {
  effectiveKnownNames,
  challengedKnownNames,
  futureNameOwners,
  activeIdentityReceipts,
} from './name-associations.ts';
import { selectionAuthority } from './intake-selection-authority.ts';
import { identityPeopleSnapshots } from './intake-identity-people.ts';
import { observeIntakeVersion, intakeVersionConflictFacts } from './import-version-diagnostics.ts';
import {
  measureImportPhase,
  beginImportPhase,
  recordImportProgress,
} from './import-diagnostics.ts';
import { stampNewReportGroups } from './intake-report-discovery.ts';
import {
  copyDiagnosticValidation,
  withDiagnosticValidation,
  withDiagnosticContext,
} from './import-diagnostic-error.ts';
import { identityReviewGroundingLookups } from './intake-identity-grounding.ts';
import {
  intakeReportSourceCoverageCounts,
  intakeReportSourceForMember,
  intakeReportSourceReviewScope,
  intakeReportSourceScope,
  priorIntakeReportSourceExtensions,
} from './intake-report-source.ts';
import { receiveIntakeUpload } from './intake-upload.ts';
import {
  withVerifiedSourceDescriptor,
  withPrivateChildStage,
  childStorageError,
} from './intake-staged-child.ts';
export { isUnpublishedIntakeChildError } from './intake-staged-child.ts';
import {
  assertCurrentProposalSourceText,
  sourceTextProposalId,
} from './intake-source-text-dependencies.ts';
import {
  proposalDependenciesCurrent,
  writeProposalDependencies,
  type ObservedSourcePages,
} from './intake-proposal-dependencies.ts';
import { issueResolutionCurrent, issueResolutionDependency } from './intake-issue-dependencies.ts';
import {
  inspectIntakeFile,
  intakeLimits,
  assertExtractionSize,
  verifyIntakeFileHash,
} from './intake-files.ts';
import {
  intakeWorkflow,
  recordCandidateVersions,
  intakeCandidateVersionId,
  addWorkflowQuestion,
  workflowReview,
  workflowSummary,
  saveWorkflowDecisions,
  workflowHash,
} from './intake-workflow.ts';
import { extractionPins, extractionUnits } from './intake-plan.ts';
import { readPlannedIntakeUnit } from './intake-navigation.ts';
import { exportMappingRules } from './mapping-actions.ts';
import {
  currentReviewDraft,
  validateDraftMapping,
  validateDraftDecision,
  resolutionFields,
  issueKind,
} from './intake-review.ts';
import {
  buildClinicalReview,
  assertClinicalSourceScopes,
  finalizeClinicalPairScopes,
  projectClinicalReview,
  refreshClinicalIdentityPolicy,
  retainedClinicalSourceRecord,
  validateClinicalPairScopes,
  datePrecision,
} from './clinical-import.ts';
import { getNote } from './notes.ts';
import type { OccurrenceAuthorityFinalizer } from './duplicate-review.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  openSync,
  closeSync,
  rmSync,
  realpathSync,
  constants as fsConstants,
} from 'node:fs';
import {
  readIntakeFileSync as readFileSync,
  writeIntakeFileSync as writeFileSync,
  fsyncIntakeFileSync as fsyncSync,
  renameIntakeFileSync as renameSync,
  copyIntakeFileSync,
  recordIntakeFileHash,
  recordIntakeFileWork,
} from './intake-file-work.ts';
import { resolve, dirname, basename } from 'node:path';
import { HttpError, required, safeText, transaction, revision, now } from './database.ts';
import { profilePaths, profileOriginal, safeRelative } from './profile-storage.ts';
import { visibilityState, visibilitySQL, visibilityCondition } from './visibility.ts';
import { exportCuration } from './portable.ts';
import {
  MAX_INTAKE_BYTES,
  validateJSONL,
  validationSummary,
  canonicalLiteral,
  parseLiteralJSON,
} from './intake-format.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { TransactionOperation } from './database.ts';
import type { IncomingMessage } from 'node:http';
import type {
  Intake,
  IntakeAcceptedRecord,
  IntakeClinicalMapping,
  IntakeExtractionCoverage,
  IntakeExtractionUnit,
  IntakeMetadata,
  IntakePackageRole,
  IntakeReview,
  IntakeReviewDecision,
  IntakeReviewDraft,
  IntakeReviewDraftUpdate,
  IntakeDraftRepairUpdate,
  IntakeDraftRepairField,
  IntakeReviewIssue,
  IntakeReportSourceUpdate,
  IntakeReportSourceConfirmation,
  IntakeReportSourceResult,
  IntakeReportSourceReview,
  IntakeReportQueueView,
} from '../shared/intake.ts';
import type { IntakeEntry } from './intake-format.ts';
import { parseIntakeSourcePin } from './intake-source-pin.ts';

type Workflow = ReturnType<typeof intakeWorkflow>;

interface SourceFileRow {
  id: string;
  provider_id: string;
  provider: string;
  path: string;
  sha256: string;
  bytes: number;
  mime_type: string;
  batch_id: string;
  details_json: string;
  /** The intake's source pin record, joined by `row()` and the intake list. */
  source_pin: string | null;
}

interface PersistenceOptions {
  /** Host-only receipt supplied by the authorized manual creation path. */
  manualSourceRecord?: import('../shared/intake-manual-source-record.ts').ManualSourceRecordReceipt;
  exportFn?: typeof exportCuration;
  observedSourcePages?: ObservedSourcePages[];
  workflowBatch?: {
    planId: string;
    operationId: string;
    coverage: IntakeExtractionCoverage[];
    fingerprint: string;
  };
}

interface StagedUpload {
  path: string;
  bytes: number;
  sha256: string;
  prefix: Buffer;
}

interface IntakeUploadInput {
  providerId?: string | null;
  newProviderName?: string | null;
  filename: string;
  mimeType?: string | null;
  bytes?: Buffer;
}

interface ProviderInput {
  providerId?: string | null;
  newProviderName?: string | null;
}

interface ProviderRow {
  id: string;
  name: string;
  create: boolean;
}

interface IntakeListOptions {
  offset?: number;
  limit?: number;
  visibility?: string;
  rootOnly?: boolean;
}

interface ReadIntakeOptions {
  offset?: number;
  limit?: number;
}

interface InspectedIntakeFile {
  bytes: number;
  sha256: string;
  text: string | null;
  totalCharacters: number | null;
}

interface ConversionProposalInput {
  version: number;
  jsonlText: string;
  summary: string;
  runId?: string | null;
  modelIdentity?: Record<string, unknown> | null;
}

interface ImportIntakeInput {
  version: number;
  proposalId?: string | null;
  reviewToken?: string | null;
  decisions?: IntakeReviewDecision[];
}

interface IntakeChildInput {
  bytes: Buffer;
  filename: string;
  locator: string;
  derivative?: boolean;
}

interface WorkflowMutationInput {
  version: number;
  operationId?: string;
}

interface AskQuestionInput extends WorkflowMutationInput {
  key: string;
  candidateId?: string | null;
  candidateVersionId?: string | null;
  prompt: string;
  locator: string;
  field?: string | null;
}

interface AnswerQuestionInput extends WorkflowMutationInput {
  operationId: string;
  questionId: string;
  answer: string;
  mapping?: Partial<IntakeClinicalMapping>;
}

interface MetadataUpdateInput extends WorkflowMutationInput {
  operationId: string;
  metadata: unknown;
}

type ReportSourceUpdateInput = IntakeReportSourceUpdate;

interface PlanInput extends WorkflowMutationInput {
  planId?: string;
  replacePlanId?: string;
  unitSize?: number;
  overlap?: number;
  assertRunning?: () => void;
}

interface PackagePlanInput extends WorkflowMutationInput {
  operationId: string;
  planId: string;
  roles: IntakePackageRole[];
}

interface SubmitBatchInput extends ConversionProposalInput, WorkflowMutationInput {
  operationId: string;
  planId: string;
  coverage: IntakeExtractionCoverage[];
}

interface ReviewedSourceRow extends SourceFileRow {
  reviewedMetadata: IntakeMetadata | null;
  reportSourceConfirmations: NonNullable<Intake['workflow']>['reportSourceConfirmations'];
}

type InspectIntakeFile = (
  path: string,
  expected?: { bytes?: number; sha256?: string },
  window?: ReadIntakeOptions | null,
) => InspectedIntakeFile;
type ReceiveIntakeUpload = <T>(
  req: IncomingMessage,
  publish: (staged: StagedUpload) => T | Promise<T>,
  options: { maxBytes?: number; tempRoot: string },
) => Promise<T>;
type BuildClinicalReview = (
  db: DatabaseSync,
  input: {
    file: ReviewedSourceRow;
    inputFile: SourceFileRow;
    entries: IntakeEntry[];
    proposalId: string | null;
    version: number;
    acceptedDecisions: unknown[];
    drafts: IntakeReviewDraft[];
  },
) => IntakeReview;
interface ClinicalProjectionResult {
  newMedications?: number;
  added: number;
  duplicates: number;
  retainedOnly: number;
  versions: number;
  records?: IntakeAcceptedRecord[];
}
type ProjectClinicalReview = (
  db: DatabaseSync,
  input: {
    file: ReviewedSourceRow;
    inputFile: SourceFileRow;
    entries: IntakeEntry[];
    review: IntakeReview;
    decisions: IntakeReviewDecision[];
    root: string;
    profileId: string;
    prevalidatedPairScopes?: Set<string>;
    occurrenceAuthorityFinalizers?: OccurrenceAuthorityFinalizer[];
  },
) => ClinicalProjectionResult;
type CurrentReviewDraft = (
  workflow: Workflow,
  proposalId: string | null,
  recordId: string,
  candidateVersionId: string,
) => IntakeReviewDraft | null;
type ValidateDraftMapping = (
  mapping: unknown,
  baseline: IntakeClinicalMapping,
) => Partial<IntakeClinicalMapping>;
type ValidateDraftDecision = (
  decision: unknown,
  record: IntakeReview['records'][number],
) => IntakeReviewDecision;
type ResolutionFields = (
  issue: Pick<IntakeReviewIssue, 'kind' | 'field'>,
) => (keyof IntakeClinicalMapping)[];
type IssueKind = (prompt: string, field?: string | null) => IntakeReviewIssue['kind'];
type ExtractionIndex = NonNullable<Intake['workflow']>['plans'][number]['index'];
type ExtractionPins = (
  db: DatabaseSync,
  file: SourceFileRow,
) => NonNullable<Intake['workflow']>['plans'][number]['pins'];
type ExtractionUnits = (index: ExtractionIndex, input: PlanInput) => IntakeExtractionUnit[];
const hash = (x: string | Uint8Array): string => {
  recordIntakeFileHash(x);
  return createHash('sha256').update(x).digest('hex');
};
const meta = (db: DatabaseSync, key: string): string | undefined =>
  (db.prepare('SELECT value FROM app_meta WHERE key=?').get(key) as { value?: string } | undefined)
    ?.value;
function owner(db: DatabaseSync, profileId: string): void {
  if (meta(db, 'owner_profile_id') !== profileId)
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Intake belongs to a different profile');
}
export { owner as assertIntakeOwner };
export function intakeDurability(db: DatabaseSync): Intake['durability'] {
  const mutationRevision = Number(meta(db, 'intake_mutation_revision') || 0),
    persistedRevision = Number(meta(db, 'curation_revision') || 0);
  return {
    pending: mutationRevision > persistedRevision,
    mutationRevision,
    persistedRevision,
    error: null,
  };
}
export function flushIntake(
  db: DatabaseSync,
  root: string,
  profileId: string,
  { exportFn = exportCuration }: PersistenceOptions = {},
): Intake['durability'] {
  owner(db, profileId);
  const span = beginImportPhase('curation_flush', {}, { profileId });
  return span.run(() => {
    try {
      if (intakeDurability(db).pending) exportFn(db, root, profileId);
      exportMappingRules(db, root, profileId);
      span.finish();
      return intakeDurability(db);
    } catch (error: unknown) {
      span.fail(error);
      return {
        ...intakeDurability(db),
        pending: true,
        error: (error as { message: string }).message,
      };
    }
  });
}

function mutate<T>(db: DatabaseSync, fn: () => T, operation: TransactionOperation = {}): T {
  return transaction(
    db,
    () => {
      const result = fn();
      db.prepare(
        "INSERT INTO app_meta(key,value) VALUES('intake_mutation_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(String(revision(db) + 1));
      return result;
    },
    operation,
  );
}
export function intakeTransaction<T>(
  db: DatabaseSync,
  fn: () => T,
  operation: TransactionOperation,
): T {
  return mutate(db, fn, operation);
}
function row(db: DatabaseSync, id: string): SourceFileRow {
  return required(
    db
      .prepare(
        "SELECT f.*,p.name AS provider,pin.value AS source_pin FROM source_files f JOIN providers p ON p.id=f.provider_id LEFT JOIN app_meta pin ON pin.key='intake_source_pin:v1:'||f.id WHERE f.id=? AND f.kind='intake_original'",
      )
      .get(id) as SourceFileRow | undefined,
    'Source intake not found',
  );
}
function checkVersion(db: DatabaseSync, file: SourceFileRow, version: unknown): void {
  if (!Number.isSafeInteger(version) || version !== details(db, file).version)
    throw withDiagnosticContext(
      new HttpError(409, 'VERSION_CONFLICT', 'This intake changed. Reload it before continuing.'),
      intakeVersionConflictFacts(
        db,
        file.id,
        version,
        details(db, file).version,
        readIntakeEnvelopeText(db, file),
      ),
    );
}

function dto(
  db: DatabaseSync,
  root: string | null,
  profileId: string,
  file: SourceFileRow,
): Intake {
  const d = details(db, file);
  const visibility = visibilityState(db, 'source_file', file.id);
  const workflow = workflowSummary(d, {
    sourceContextVersionIds: cachedSourceContextVersions(db, root, profileId, file, d),
  });
  return {
    id: file.id,
    providerId: d.metadata?.sourceProviderId || file.provider_id,
    provider: d.metadata?.source || file.provider,
    acquisition: d.acquisition || { providerId: file.provider_id, provider: file.provider },
    parentSourceFileId: d.parentSourceFileId || null,
    metadata: d.metadata || { source: null, careArea: null, documentType: null, topics: [] },
    metadataHistory: d.metadataHistory || [],
    archived: visibility.archived,
    visibilityVersion: visibility.version,
    filename: d.originalName,
    mimeType: file.mime_type,
    bytes: file.bytes,
    sha256: file.sha256,
    createdAt: d.createdAt,
    state: d.state,
    version: d.version,
    contentUrl: `/api/sources/${encodeURIComponent(file.id)}/content`,
    validation: d.validation,
    ...(d.packageFailures ? { packageFailures: d.packageFailures } : {}),
    proposals: d.proposals,
    acceptedProposalId: d.acceptedProposalId,
    imported: d.imported,
    conversionChatId: d.conversionChatId || null,
    importHistory: d.importHistory || [],
    ...workflow,
    durability: intakeDurability(db),
  };
}
export function listIntakes(
  db: DatabaseSync,
  profileId: string,
  { offset = 0, limit = 30, visibility = 'visible', rootOnly = false }: IntakeListOptions = {},
  root: string | null = null,
) {
  owner(db, profileId);
  offset = Math.max(0, Number(offset) || 0);
  limit = Math.min(100, Math.max(1, Number(limit) || 30));
  const where =
    "f.kind='intake_original' AND " +
    (rootOnly ? "json_extract(f.details_json,'$.intake.parentSourceFileId') IS NULL AND " : '') +
    visibilityCondition(
      new URLSearchParams({ visibility: visibility || 'visible' }),
      visibilitySQL("'source_file'", 'f.id'),
    );
  const files = db
    .prepare(
      "SELECT f.*,p.name AS provider,pin.value AS source_pin FROM source_files f JOIN providers p ON p.id=f.provider_id LEFT JOIN app_meta pin ON pin.key='intake_source_pin:v1:'||f.id WHERE " +
        where +
        " ORDER BY json_extract(f.details_json,'$.intake.createdAt') DESC,f.id LIMIT ? OFFSET ?",
    )
    .all(limit, offset) as unknown as SourceFileRow[];
  const total = (
    db.prepare('SELECT COUNT(*) AS n FROM source_files f WHERE ' + where).get() as { n: number }
  ).n;
  return {
    data: files.map((file) => dto(db, root, profileId, file)),
    total,
    limit,
    offset,
    complete: offset + files.length >= total,
    intakeDurability: intakeDurability(db),
  };
}
export function getIntake(
  db: DatabaseSync,
  root: string | null,
  profileId: string,
  id: string,
): Intake {
  owner(db, profileId);
  return dto(db, root, profileId, row(db, id));
}
export function verifyIntakeOriginal(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
) {
  const original = getRetainedIntakeOriginalReference(db, root, profileId, id);
  measureImportPhase(
    'original_integrity_verification',
    () =>
      verifyIntakeFileHash(original.path, {
        bytes: original.size,
        sha256: original.sourceHash,
      }),
    { bytes: original.size },
    { profileId, importId: id },
  );
  return original;
}

/**
 * Resolve the managed retained file and its durable integrity expectation
 * without loading it. The reference is not itself proof that the live path is
 * unchanged: byte consumers must verify `size` and `sourceHash` first. The PDF
 * evidence worker does that once through the same file descriptor it retains
 * for bounded range reads.
 */
export function getRetainedIntakeOriginalReference(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
) {
  owner(db, profileId);
  const file = row(db, id);
  return {
    id: file.id,
    path: profileOriginal(root, file.path, profileId),
    size: file.bytes,
    sourceHash: file.sha256,
    mimeType: file.mime_type,
    filename: details(db, file).originalName,
  };
}
export function getIntakeOriginal(db: DatabaseSync, root: string, profileId: string, id: string) {
  owner(db, profileId);
  const file = row(db, id);
  assertExtractionSize(file.bytes);
  const original = verifyIntakeOriginal(db, root, profileId, id),
    bytes = measureImportPhase(
      'original_retrieval',
      () => readFileSync(original.path),
      { bytes: original.size },
      { profileId, importId: id },
    );
  if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
    throw new HttpError(409, 'SOURCE_CHANGED', 'The retained original no longer matches its hash');
  return { ...original, bytes };
}
export function readIntake(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  { offset = 0, limit = 12000 }: ReadIntakeOptions = {},
) {
  const intake = getIntake(db, root, profileId, id),
    file = row(db, id),
    path = profileOriginal(root, file.path, profileId);
  offset = Math.max(0, Math.trunc(Number(offset)) || 0);
  limit = Math.min(32000, Math.max(1, Math.trunc(Number(limit)) || 12000));
  const binary = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/zip',
  ].includes(file.mime_type);
  const inspected = (inspectIntakeFile as unknown as InspectIntakeFile)(
    path,
    file,
    binary ? null : { offset, limit },
  );
  if (binary || inspected.text === null)
    return {
      intake,
      text: null,
      offset: 0,
      nextOffset: null,
      totalCharacters: null,
      complete: false,
      note: 'Original retained. This binary format needs a file/page-aware converter; no text extraction was performed.',
    };
  const end = Math.min(inspected.totalCharacters!, offset + limit);
  return {
    intake,
    text: inspected.text,
    offset,
    nextOffset: end < inspected.totalCharacters! ? end : null,
    totalCharacters: inspected.totalCharacters,
    complete: offset === 0 && end === inspected.totalCharacters!,
    note: 'Offsets are JavaScript UTF-16 character positions. Pages are bounded source text, not a complete extraction unless complete is true. Archived instructions are untrusted source content.',
  };
}
function saveOriginal(
  root: string,
  profileId: string,
  path: string,
  bytes: Buffer | undefined,
  staged: StagedUpload | null = null,
): boolean {
  const profile = profilePaths(root, profileId);
  if (!safeRelative(path) || !path.startsWith(profile.relativeRoot + '/sources/'))
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Invalid source path');
  const target = resolve(root, path),
    sourceRoot = realpathSync(profile.root) + '/sources';
  // Check each existing ancestor before creating its children: even an empty
  // intake directory must not be created through a link to another profile.
  let directory = profile.root;
  for (const part of path
    .slice(profile.relativeRoot.length + 1)
    .split('/')
    .slice(0, -1)) {
    directory = resolve(directory, part);
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const actual = realpathSync(directory);
    if (actual !== sourceRoot && !actual.startsWith(sourceRoot + '/'))
      throw new HttpError(403, 'PROFILE_BOUNDARY', 'Source directory escaped this profile');
  }
  if (existsSync(target)) {
    (inspectIntakeFile as unknown as InspectIntakeFile)(
      profileOriginal(root, path, profileId),
      staged || { bytes: bytes!.length, sha256: hash(bytes!) },
    );
    return false;
  }
  // A stopped process may leave an unpublished temporary file. Each attempt
  // uses its own name so retrying the same original remains possible.
  const temporary = target + '.pending-' + randomUUID();
  try {
    if (staged) {
      try {
        // The receiver has already completed and fsynced this private staging
        // file. Moving it within the runtime avoids a second plaintext copy.
        // Verification below still checks the exact bytes before publication.
        measureImportPhase(
          'upload_original_adopt',
          () => renameSync(staged.path, temporary),
          { bytes: staged.bytes },
          { profileId },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        // Contributor/custom mounts can cross filesystems; preserve safe
        // copy-and-verify behavior there, never an unverified shortcut.
        measureImportPhase(
          'upload_original_copy',
          () => copyIntakeFileSync(staged.path, temporary, fsConstants.COPYFILE_EXCL, staged.bytes),
          { bytes: staged.bytes },
          { profileId },
        );
      }
    }
    const fd = openSync(
      temporary,
      staged ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW : 'wx',
      0o600,
    );
    try {
      if (staged) {
        measureImportPhase(
          'upload_original_verify',
          () => (inspectIntakeFile as unknown as InspectIntakeFile)(temporary, staged),
          { bytes: staged.bytes },
          { profileId },
        );
      } else
        measureImportPhase(
          'upload_original_copy',
          () => writeFileSync(fd, bytes!),
          { bytes: bytes!.length },
          { profileId },
        );
      measureImportPhase('upload_original_fsync', () => fsyncSync(fd), {}, { profileId });
    } finally {
      closeSync(fd);
    }
    measureImportPhase(
      'upload_original_publish',
      () => {
        renameSync(temporary, target);
        recordIntakeFileWork('publications');
      },
      {},
      { profileId },
    );
    const directory = openSync(dirname(target), 'r');
    try {
      measureImportPhase('upload_directory_fsync', () => fsyncSync(directory), {}, { profileId });
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}
function mime(bytes: Buffer, name: string, retainedBytes = bytes.length): string {
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString() === 'RIFF' &&
    bytes.subarray(8, 12).toString() === 'WEBP'
  )
    return 'image/webp';
  if (bytes.subarray(0, 2).toString() === 'PK') return 'application/zip';
  // Retain-only eligibility must survive renaming. Recognize common media
  // signatures before extension hints; unsupported variants remain explicit.
  if (bytes.length >= 132 && bytes.subarray(128, 132).toString() === 'DICM')
    return 'application/dicom';
  if (bytes.subarray(0, 4).toString() === 'RIFF') {
    if (bytes.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
    if (bytes.subarray(8, 12).toString() === 'AVI ') return 'video/x-msvideo';
  }
  if (bytes.subarray(0, 3).toString() === 'ID3') return 'audio/mpeg';
  if (bytes.subarray(0, 4).toString() === 'fLaC') return 'audio/flac';
  if (bytes.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  // Sync bits alone also match arbitrary binary. ADTS needs a complete header,
  // a defined sample rate and a frame length consistent with the retained file.
  if (bytes.length >= 7 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) {
    const headerBytes = bytes[1]! & 1 ? 7 : 9;
    const frameBytes = ((bytes[3]! & 3) << 11) | (bytes[4]! << 3) | (bytes[5]! >> 5);
    if (((bytes[2]! >> 2) & 15) <= 12 && frameBytes >= headerBytes && frameBytes <= retainedBytes)
      return 'audio/aac';
  }
  // MPEG audio reserves one version, layer zero, bitrate index 15 and sample
  // rate index 3. Keep valid free-format bitrate zero eligible as MPEG audio.
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    (bytes[1]! & 0xe0) === 0xe0 &&
    (bytes[1]! & 0x18) !== 0x08 &&
    (bytes[1]! & 0x06) !== 0 &&
    (bytes[2]! & 0xf0) !== 0xf0 &&
    (bytes[2]! & 0x0c) !== 0x0c &&
    (bytes[3]! & 0x03) !== 0x02
  )
    return 'audio/mpeg';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/x-matroska';
  if (bytes.subarray(4, 8).toString() === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString();
    if (['M4A ', 'M4B ', 'M4P '].includes(brand)) return 'audio/mp4';
    if (
      ['isom', 'iso2', 'avc1', 'mp41', 'mp42', 'M4V ', 'qt  ', '3gp4', '3gp5', '3g2a'].includes(
        brand,
      )
    )
      return 'video/mp4';
  }
  if (/\.(jsonl|ndjson)$/i.test(name)) return 'application/x-ndjson';
  if (/\.json$/i.test(name)) return 'application/json';
  return 'application/octet-stream';
}
function provider(db: DatabaseSync, input: ProviderInput): ProviderRow {
  if (input.providerId) {
    const p = required(
      db.prepare('SELECT * FROM providers WHERE id=?').get(input.providerId) as
        Omit<ProviderRow, 'create'> | undefined,
      'Choose an existing source or enter a new source name',
    );
    return { ...p, create: false };
  }
  const name = safeText(input.newProviderName || '', 'source name', 200).trim() || 'Unknown source';
  const existing = db.prepare('SELECT * FROM providers WHERE name=? COLLATE NOCASE').get(name) as
    Omit<ProviderRow, 'create'> | undefined;
  return existing
    ? { ...existing, create: false }
    : { id: 'source-' + hash(name.toLowerCase()).slice(0, 24), name, create: true };
}
export function validateIntakeUpload(
  db: DatabaseSync,
  profileId: string,
  input: IntakeUploadInput,
): void {
  owner(db, profileId);
  provider(db, input);
  safeText(input.filename, 'filename', 500);
}
export async function uploadIntakeStream(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: IntakeUploadInput,
  req: IncomingMessage,
  options?: PersistenceOptions,
) {
  validateIntakeUpload(db, profileId, input);
  const tempRoot = resolve(root, '.upload-staging'),
    actualRoot = realpathSync(root);
  if (!existsSync(tempRoot)) mkdirSync(tempRoot, { mode: 0o700 });
  if (realpathSync(tempRoot) !== resolve(actualRoot, '.upload-staging'))
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Upload staging escaped its runtime');
  return (receiveIntakeUpload as unknown as ReceiveIntakeUpload)(
    req,
    (staged) => publishIntake(db, root, profileId, input, staged, options),
    { tempRoot },
  );
}
export function uploadIntake(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: IntakeUploadInput,
  options?: PersistenceOptions,
) {
  validateIntakeUpload(db, profileId, input);
  if (
    !Buffer.isBuffer(input.bytes) ||
    !input.bytes.length ||
    input.bytes.length > intakeLimits().uploadBytes
  )
    throw new HttpError(
      413,
      'FILE_SIZE',
      'Choose a nonempty source file within the configured upload limit',
    );
  return publishIntake(db, root, profileId, input, null, options);
}
function publishIntake(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: IntakeUploadInput,
  staged: StagedUpload | null,
  options?: PersistenceOptions,
) {
  return measureImportPhase(
    'upload_curation_publish',
    () => {
      const result = publishIntakeInternal(db, root, profileId, input, staged, options);
      recordImportProgress(
        { phase: 'upload_retained', repeatedUpload: result.repeatedUpload },
        { profileId, importId: result.id },
      );
      return result;
    },
    {},
    { profileId },
  );
}
function publishIntakeInternal(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: IntakeUploadInput,
  staged: StagedUpload | null,
  options?: PersistenceOptions,
) {
  owner(db, profileId);
  const size = staged?.bytes ?? input.bytes!.length;
  const originalName = safeText(input.filename, 'filename', 500);
  const name =
    basename(originalName.replace(/\\/g, '/'))
      .replace(/[\x00-\x1f]/g, '')
      .slice(0, 200) || 'original';
  if (name === '.' || name === '..')
    throw new HttpError(400, 'INVALID_INPUT', 'Choose a regular filename');
  const p = provider(db, input),
    digest = staged?.sha256 || hash(input.bytes!),
    key = hash(randomUUID()),
    id = 'intake:' + key;
  const existing = db
    .prepare(
      "SELECT id FROM source_files WHERE provider_id=? AND sha256=? AND kind='intake_original' AND json_extract(details_json,'$.intake.originalName')=? AND json_extract(details_json,'$.intake.parentSourceFileId') IS NULL ORDER BY id LIMIT 1",
    )
    .get(p.id, digest, originalName) as { id: string } | undefined;
  if (existing) {
    verifyIntakeOriginal(db, root, profileId, existing.id);
    if (!db.prepare('SELECT 1 FROM app_meta WHERE key=?').get('intake_enqueue:v1:' + existing.id))
      mutate(db, () =>
        db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
          'intake_enqueue:v1:' + existing.id,
          JSON.stringify({
            intakeId: existing.id,
            sourceHash: digest,
            operationId: 'upload:' + existing.id,
          }),
        ),
      );
    return {
      ...getIntake(db, root, profileId, existing.id),
      repeatedUpload: true,
      durability: flushIntake(db, root, profileId, options),
    };
  }
  const path = `${profilePaths(root, profileId).relativeRoot}/sources/${encodeURIComponent(p.id)}/intake/${key}/${name}`;
  const mimeType = mime(staged?.prefix || input.bytes!, name, staged?.bytes ?? input.bytes!.length);
  const binary = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/zip',
  ].includes(mimeType);
  const parsed =
    !binary && size <= MAX_INTAKE_BYTES
      ? validateJSONL(staged ? readFileSync(staged.path) : input.bytes!)
      : {
          valid: false,
          rows: 0,
          exactRepeatedRows: 0,
          partialRows: 0,
          unrecognizedRows: 0,
          preview: [],
          previewComplete: false,
          issues: [
            {
              line: 0,
              message: binary
                ? 'Binary original retained in full; file/page-aware conversion is pending. JSONL validation was not attempted.'
                : 'Original retained in full. Files above 25 MiB require bounded conversion proposals; JSONL validation was not attempted.',
            },
          ],
          entries: [],
        };
  const validation = validationSummary(parsed),
    createdAt = now(),
    batchId = id;
  const d: IntakeDetails = {
    originalName,
    acquisition: { providerId: p.id, provider: p.name },
    metadata: {
      source: input.providerId || input.newProviderName ? p.name : null,
      careArea: null,
      documentType: null,
      topics: [],
    },
    metadataHistory: [],
    receivedMimeType: input.mimeType || null,
    createdAt,
    version: 1,
    state: validation.valid ? 'ready' : 'pending_conversion',
    validation,
    proposals: [],
    acceptedProposalId: null,
    imported: null,
  };
  saveOriginal(root, profileId, path, input.bytes!, staged);
  // Preserve this original if a commit response is uncertain: a durable intent may already reference it.
  recordCandidateVersions({ id, sha256: digest }, d, parsed.entries || [], null);
  mutate(db, () => {
    stampNewReportGroups(db, intakeWorkflow(d));
    if (p.create) db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(p.id, p.name);
    db.prepare(
      "INSERT INTO manual_batches(id,title,status,created_at,notes,coverage_json) VALUES(?,?,'in_progress',?,?,?)",
    ).run(
      batchId,
      `Source intake: ${name}`,
      createdAt,
      'Original upload preserved. Clinical normalization has not been performed.',
      JSON.stringify({
        sourceIntake: id,
        sourceHash: digest,
        rawPreserved: true,
        clinicalProjection: 'none',
      }),
    );
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
      'intake_enqueue:v1:' + id,
      JSON.stringify({ intakeId: id, sourceHash: digest, operationId: 'upload:' + id }),
    );
    registerFile(db, {
      id,
      providerId: p.id,
      path,
      sha256: digest,
      size,
      mimeType,
      kind: 'intake_original',
      coverage: 'original_retained; clinical_coverage_unknown',
      batchId,
      details: { intake: d },
    });
  });
  return {
    ...getIntake(db, root, profileId, id),
    repeatedUpload: false,
    durability: flushIntake(db, root, profileId, options),
  };
}
function update(db: DatabaseSync, file: SourceFileRow, d: IntakeDetails): void {
  const before = details(db, file);
  const rawBefore = readIntakeEnvelopeText(db, file);
  const raw = writeIntakeDetails(db, file, d);
  try {
    observeIntakeVersion(db, file.id, before, d, raw, rawBefore);
  } catch {
    /* Diagnostics do not change publication. */
  }
}
/** Readiness uses dependency pins, not merely the presence of an old proposal. */
export function currentIntakeInterpretations(db: DatabaseSync, profileId: string, id: string) {
  owner(db, profileId);
  const d = details(db, row(db, id));
  return {
    original: !d.sourceTextRequiresInterpretation,
    proposalIds: d.proposals
      .filter((p) => {
        const measured = proposalDependenciesCurrent(db, p.id);
        return (
          measured ??
          ((p.sourceTextRevisionId || null) === (d.sourceTextRevisionId || null) &&
            (p.sourceTextDependencyToken || null) === (d.sourceTextDependencyToken || null))
        );
      })
      .map((p) => p.id),
  };
}
export function proposeConversion(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: ConversionProposalInput,
  options?: PersistenceOptions,
) {
  owner(db, profileId);
  const file = row(db, id),
    d = details(db, file);
  safeText(input.jsonlText, 'JSONL proposal', MAX_INTAKE_BYTES);
  const bytes = Buffer.from(input.jsonlText),
    proposalId = sourceTextProposalId(
      id,
      hash(bytes),
      d.sourceTextRevisionId,
      d.sourceTextDependencyToken,
    );
  const existingProposal = d.proposals.some((p) => p.id === proposalId);
  if (
    existingProposal &&
    options?.manualSourceRecord &&
    d.proposals.find((p) => p.id === proposalId)?.manualSourceRecord?.fingerprint !==
      options.manualSourceRecord.fingerprint
  )
    throw new HttpError(
      409,
      'OPERATION_CONFLICT',
      'This source proposal already has different authorship',
    );
  if (existingProposal && !options?.workflowBatch)
    return {
      ...getIntake(db, root, profileId, id),
      durability: flushIntake(db, root, profileId, options),
    };
  checkVersion(db, file, input.version);
  verifyIntakeOriginal(db, root, profileId, id);
  const parsed = validateJSONL(bytes),
    validation = validationSummary(parsed);
  if (!validation.valid)
    throw copyDiagnosticValidation(
      new HttpError(
        400,
        'INVALID_JSONL',
        'Proposal is not valid health-record-v1 JSONL: ' +
          validation.issues.map((i) => `line ${i.line}: ${i.message}`).join('; '),
      ),
      parsed,
    );
  const summary = safeText(input.summary, 'conversion summary', 10000),
    runId = input.runId == null ? null : safeText(input.runId, 'assistant run ID', 200);
  const modelIdentity = input.modelIdentity
    ? Object.fromEntries(
        ['backend', 'model', 'reasoningEffort', 'instructionVersion'].map((key) => [
          key,
          input.modelIdentity![key] == null
            ? null
            : safeText(input.modelIdentity![key], 'model identity', 200),
        ]),
      )
    : null;
  const path = `${profilePaths(root, profileId).relativeRoot}/sources/${encodeURIComponent(file.provider_id)}/intake/${id.slice(7)}/${proposalId.slice(9)}.jsonl`;
  saveOriginal(root, profileId, path, bytes);
  // Preserve this original if a commit response is uncertain: a durable intent may already reference it.
  mutate(db, () => {
    checkVersion(db, row(db, id), input.version);
    if (!existingProposal)
      registerFile(db, {
        id: proposalId,
        providerId: file.provider_id,
        path,
        bytes,
        mimeType: 'application/x-ndjson',
        kind: 'intake_proposal',
        coverage: 'derived_proposal; unreviewed',
        batchId: file.batch_id,
        details: {
          originalSourceFileId: id,
          assistantRunId: runId,
          modelIdentity,
          summary,
          validation,
          clinicalProjection: 'none',
          ...(options?.manualSourceRecord
            ? { manualSourceRecord: options.manualSourceRecord }
            : {}),
          sourceTextRevisionId: d.sourceTextRevisionId || null,
          sourceTextDependencyToken: d.sourceTextDependencyToken || null,
        },
      });
    if (!existingProposal)
      d.proposals.push({
        id: proposalId,
        fileId: proposalId,
        summary,
        createdAt: now(),
        runId,
        modelIdentity,
        validation,
        ...(options?.manualSourceRecord ? { manualSourceRecord: options.manualSourceRecord } : {}),
        contentUrl: `/api/sources/${encodeURIComponent(proposalId)}/content`,
        sourceTextRevisionId: d.sourceTextRevisionId || null,
        sourceTextDependencyToken: d.sourceTextDependencyToken || null,
      });
    if (!existingProposal)
      writeProposalDependencies(db, id, proposalId, options?.observedSourcePages);
    const existingGroupIds = new Set(
      workflowSummary(d).workflow.reportGroups.map((group) => group.id),
    );
    recordCandidateVersions(
      file,
      d,
      parsed.entries!,
      proposalId,
      options?.workflowBatch?.operationId || null,
    );
    stampNewReportGroups(db, intakeWorkflow(d), existingGroupIds);
    if (options?.workflowBatch) recordExtractionBatch(d, proposalId, options.workflowBatch);
    d.version++;
    d.state = 'conversion_proposed';
    update(db, file, d);
  });

  return {
    ...getIntake(db, root, profileId, id),
    durability: flushIntake(db, root, profileId, options),
  };
}
export function linkIntakeConversion(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  chatId: string,
): void {
  owner(db, profileId);
  const file = row(db, id),
    d = details(db, file);
  if (d.conversionChatId === chatId) return;
  mutate(db, () => {
    d.conversionChatId = chatId;
    update(db, file, d);
  });
  flushIntake(db, root, profileId);
}
let reviewCallObserver: (() => void) | null = null;
/** Scoped work counter for regression tests; counts reviews without timing model or host work. */
export function observeIntakeReviewCalls(observer: (() => void) | null) {
  const previous = reviewCallObserver;
  reviewCallObserver = observer;
  return () => {
    reviewCallObserver = previous;
  };
}
export function reviewIntake(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  proposalId: string | null = null,
): IntakeReview {
  return createIntakeReviewSession(db, root, profileId, id).review(proposalId);
}
/** Prepare one immutable original/workflow/identity context for several exact proposal reviews. */
export function createIntakeReviewSession(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
) {
  const context = prepareIntakeReviewContext(db, root, profileId, id);
  return {
    filename: context.d.originalName,
    review: (proposalId: string | null = null): IntakeReview =>
      reviewIntakePrepared(db, root, profileId, id, proposalId, context),
  };
}
function prepareIntakeReviewContext(db: DatabaseSync, root: string, profileId: string, id: string) {
  reviewCallObserver?.();
  owner(db, profileId);
  const file = row(db, id),
    d = details(db, file);
  verifyIntakeOriginal(db, root, profileId, id);
  const workflow = intakeWorkflow(d);
  const selfNote = getNote(db, 'person-note:self');
  const reviewedFile = reviewedSource(db, file, d);
  const self = {
    noteId: 'person-note:self' as const,
    version: selfNote.version,
    knownNames: effectiveKnownNames(db, selfNote.id, selfNote.person),
    challengedNames: challengedKnownNames(db, selfNote.id),
    futureNameOwners: futureNameOwners(db),
    fullName:
      typeof selfNote.person.fullName === 'string' && selfNote.person.fullName.trim()
        ? selfNote.person.fullName.trim()
        : null,
    birthDate:
      typeof selfNote.person.birthDate === 'string' && selfNote.person.birthDate.trim()
        ? selfNote.person.birthDate.trim()
        : null,
  };
  const people = identityPeopleSnapshots(db);
  const grounding = identityReviewGroundingLookups(db, {
    profileId,
    intakeId: id,
    sourceHash: file.sha256,
    workflow,
  });
  return { file, d, workflow, self, people, grounding, reviewedFile };
}
function reviewIntakePrepared(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  proposalId: string | null,
  context: ReturnType<typeof prepareIntakeReviewContext>,
): IntakeReview {
  const { file, d, workflow, self, people, grounding, reviewedFile } = context;
  if (proposalId && !d.proposals.some((p) => p.id === proposalId))
    throw new HttpError(404, 'NOT_FOUND', 'Proposal does not belong to this delivery');
  const inputFile: SourceFileRow = proposalId
    ? required(
        db.prepare('SELECT * FROM source_files WHERE id=?').get(proposalId) as
          SourceFileRow | undefined,
      )
    : file;
  if (inputFile.bytes > MAX_INTAKE_BYTES)
    throw new HttpError(
      413,
      'CONVERSION_REQUIRED',
      'Original retained; review a bounded JSONL conversion proposal (at most 25 MiB)',
    );
  const bytes = measureImportPhase(
    'review_proposal_read',
    () => readFileSync(profileOriginal(root, inputFile.path, profileId)),
    { bytes: inputFile.bytes },
    { profileId },
  );
  if (hash(bytes) !== inputFile.sha256 || bytes.length !== inputFile.bytes)
    throw new HttpError(409, 'SOURCE_CHANGED', 'Review source changed');
  const validation = validateJSONL(bytes);
  if (!validation.valid)
    throw new HttpError(400, 'INVALID_JSONL', 'Convert the original before clinical review');
  const review = workflowReview(
    file,
    d,
    (buildClinicalReview as unknown as BuildClinicalReview)(db, {
      file: reviewedFile,
      inputFile,
      entries: validation.entries!,
      proposalId,
      version: d.version,
      ...(proposalId && proposalDependenciesCurrent(db, proposalId) !== null
        ? { reviewTokenVersion: d.version - (parseIntakeSourcePin(file.source_pin)?.version ?? 0) }
        : {}),
      acceptedDecisions: workflow.decisions,
      drafts: validation
        .entries!.map((entry) =>
          (currentReviewDraft as unknown as CurrentReviewDraft)(
            workflow,
            proposalId,
            `${inputFile.id}:line:${entry.line}`,
            intakeCandidateVersionId(d, proposalId, entry),
          ),
        )
        .filter(Boolean) as IntakeReviewDraft[],
    }),
    validation.entries!,
    self,
    {
      profileId,
      people,
      activeReceipts: (receipts) => activeIdentityReceipts(db, receipts),
      copiedManualSourceApplies: (receipt, selectedProposalId) =>
        selectedProposalId === proposalId &&
        copiedManualSourceRecordApplies(
          db,
          {
            profileId,
            intakeId: id,
            sourceHash: file.sha256,
            proposalId: selectedProposalId,
            proposalHash: inputFile.sha256,
          },
          receipt,
        ),
      resolutionCurrent: (resolution, mapping) => issueResolutionCurrent(db, resolution, mapping),
      ...grounding,
    },
  );
  // One immutable workflow snapshot per synchronous review, not a full JSON parse per row.
  for (const record of review.records)
    refreshClinicalIdentityPolicy(db, reviewedFile, record, workflow);
  (
    finalizeClinicalPairScopes as unknown as (
      db: DatabaseSync,
      file: SourceFileRow,
      inputFile: SourceFileRow,
      entries: IntakeEntry[],
      review: IntakeReview,
    ) => void
  )(db, reviewedFile, inputFile, validation.entries!, review);
  // Candidate/report/identity enrichment and v2 pair scopes are part of the
  // transient request token. Durable attachment-current authority is stored
  // separately so this transaction's own revision does not stale itself.
  review.reviewToken = hash(canonicalLiteral([review.reviewToken, review.records]));
  review.summary = {
    additions: review.records.filter((record) => record.classification === 'addition').length,
    duplicates: review.records.filter((record) => record.classification === 'duplicate').length,
    unsupported: review.records.filter((record) => record.classification === 'unsupported').length,
    uncertain: review.records.filter((record) => record.uncertainties.length).length,
  };
  review.coverageGaps = review.records
    .filter(
      (record) =>
        !!(record as typeof record & { problem?: string | null }).problem ||
        record.uncertainties.length,
    )
    .map((record) => ({
      id: record.id,
      label: record.title,
      detail: [
        (record as typeof record & { problem?: string | null }).problem,
        ...record.uncertainties,
      ]
        .filter(Boolean)
        .join('; '),
      evidence: record.evidence,
    }));
  if (proposalId || d.sourceTextRequiresInterpretation) {
    const proposal = d.proposals.find((item) => item.id === proposalId);
    const measured = proposal ? proposalDependenciesCurrent(db, proposal.id) : null;
    review.sourceTextStale =
      (!proposalId && !!d.sourceTextRequiresInterpretation) ||
      !(
        measured ??
        ((proposal?.sourceTextRevisionId || null) === (d.sourceTextRevisionId || null) &&
          (proposal?.sourceTextDependencyToken || null) === (d.sourceTextDependencyToken || null))
      );
    if (review.sourceTextStale)
      review.coverageGaps.push({
        id: 'source-text-changed',
        label: 'Source text changed',
        detail:
          'This proposal uses earlier source text. Read the corrected source and create a new proposal before acceptance.',
      });
  }
  for (const record of review.records)
    record.selectionReviewToken = selectionAuthority({
      profileId,
      intakeId: id,
      proposalId,
      originalHash: file.sha256,
      proposalHash: inputFile.sha256,
      sourceTextRevisionId:
        proposalId && proposalDependenciesCurrent(db, proposalId) !== null
          ? d.proposals.find((proposal) => proposal.id === proposalId)?.sourceTextRevisionId || null
          : d.sourceTextRevisionId || null,
      sourceTextDependencyToken:
        proposalId && proposalDependenciesCurrent(db, proposalId) !== null
          ? d.proposals.find((proposal) => proposal.id === proposalId)?.sourceTextDependencyToken ||
            null
          : d.sourceTextDependencyToken || null,
      sourceTextStale: review.sourceTextStale || false,
      // Discovery suggestions are not approvals. Exact chosen comparison scopes are
      // independently validated inside acceptance; duplicate classification remains pinned.
      record: { ...record, comparisons: undefined },
    });
  return review;
}

/** Exact model-shaped source rows for a bounded pending-draft repair context. */
export function intakeDraftRepairSourceSections(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  proposalId: string | null,
) {
  owner(db, profileId);
  const file = row(db, id);
  const d = details(db, file);
  if (proposalId && !d.proposals.some((proposal) => proposal.id === proposalId))
    throw new HttpError(404, 'NOT_FOUND', 'Proposal does not belong to this delivery');
  verifyIntakeOriginal(db, root, profileId, id);
  const inputFile: SourceFileRow = proposalId
    ? required(
        db.prepare('SELECT * FROM source_files WHERE id=?').get(proposalId) as
          SourceFileRow | undefined,
      )
    : file;
  const bytes = measureImportPhase(
    'review_proposal_read',
    () => readFileSync(profileOriginal(root, inputFile.path, profileId)),
    { bytes: inputFile.bytes },
    { profileId },
  );
  if (hash(bytes) !== inputFile.sha256 || bytes.length !== inputFile.bytes)
    throw new HttpError(409, 'SOURCE_CHANGED', 'Review source changed');
  const validation = validateJSONL(bytes);
  if (!validation.valid)
    throw new HttpError(400, 'INVALID_JSONL', 'Convert the original before draft repair');
  return {
    sourceSha256: inputFile.sha256,
    sections: new Map(
      validation.entries!.map((entry) => [
        `${inputFile.id}:line:${entry.line}`,
        JSON.stringify({
          payload: entry.value.payload,
          provenance: {
            locator: entry.value.provenance.locator,
            sourceSystem: entry.value.provenance.sourceSystem,
            sourceRecordId: entry.value.provenance.sourceRecordId,
          },
          coverage: entry.value.coverage,
        }),
      ]),
    ),
  };
}
export function importIntake(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: ImportIntakeInput,
  options?: PersistenceOptions,
) {
  owner(db, profileId);
  const file = row(db, id),
    d = details(db, file);
  const selected = input.proposalId || null;
  const decisionFingerprint = hash(
    canonicalLiteral({ proposalId: selected, decisions: input.decisions || [] }),
  );
  if (
    d.imported &&
    d.acceptedProposalId === selected &&
    (!input.reviewToken || input.reviewToken === d.lastReviewToken)
  ) {
    if (
      (input.reviewToken || input.decisions?.length) &&
      d.lastDecisionFingerprint !== decisionFingerprint
    )
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This accepted review belongs to different decisions; load a fresh review',
      );
    return {
      ...getIntake(db, root, profileId, id),
      durability: flushIntake(db, root, profileId, options),
    };
  }
  const prepared = prepareIntakeImport(db, root, profileId, id, input);
  mutate(db, () => prepared.apply(input.version));
  return {
    ...getIntake(db, root, profileId, id),
    durability: flushIntake(db, root, profileId, options),
  };
}

/** Prepare exact reviewed evidence without writing; callers apply inside one intake transaction. */
export function prepareIntakeImport(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: ImportIntakeInput,
  reviewed?: IntakeReview,
) {
  return measureImportPhase(
    'review_acceptance_validation',
    () => prepareIntakeImportInternal(db, root, profileId, id, input, reviewed),
    {},
    { profileId, importId: id },
  );
}
function prepareIntakeImportInternal(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: ImportIntakeInput,
  reviewed?: IntakeReview,
) {
  owner(db, profileId);
  const file = row(db, id),
    d = details(db, file),
    selected = input.proposalId || null;
  const decisionFingerprint = hash(
    canonicalLiteral({ proposalId: selected, decisions: input.decisions || [] }),
  );
  checkVersion(db, file, input.version);
  verifyIntakeOriginal(db, root, profileId, id);
  if (selected && !d.proposals.some((p) => p.id === selected))
    throw new HttpError(404, 'NOT_FOUND', 'Proposal does not belong to this delivery');
  assertCurrentProposalSourceText(d, selected, db);
  const inputFile: SourceFileRow = selected
    ? required(
        db.prepare('SELECT * FROM source_files WHERE id=?').get(selected) as
          SourceFileRow | undefined,
      )
    : file;
  if (inputFile.bytes > MAX_INTAKE_BYTES)
    throw new HttpError(
      413,
      'CONVERSION_REQUIRED',
      'Original retained; review a bounded JSONL conversion proposal (at most 25 MiB)',
    );
  const bytes = measureImportPhase(
    'review_proposal_read',
    () => readFileSync(profileOriginal(root, inputFile.path, profileId)),
    { bytes: inputFile.bytes },
    { profileId },
  );
  if (hash(bytes) !== inputFile.sha256 || bytes.length !== inputFile.bytes)
    throw new HttpError(409, 'SOURCE_CHANGED', 'Import source hash changed');
  const validation = validateJSONL(bytes);
  if (!validation.valid)
    throw new HttpError(
      400,
      'INVALID_JSONL',
      'The original needs conversion before it can be imported',
    );
  const clinicalReview = input.reviewToken
    ? (reviewed ?? reviewIntake(db, root, profileId, id, selected))
    : null;
  if (clinicalReview && clinicalReview.reviewToken !== input.reviewToken)
    throw new HttpError(
      409,
      'REVIEW_CHANGED',
      'The archive or proposal changed. Review it again before accepting.',
    );
  if (!clinicalReview && validation.entries!.some((e) => e.value.clinical))
    throw new HttpError(
      400,
      'REVIEW_REQUIRED',
      'Review clinical additions before accepting this proposal',
    );
  const decisions: IntakeReviewDecision[] = Array.isArray(input.decisions)
    ? input.decisions.map((decision) => {
        const record = clinicalReview?.records.find((r) => r.id === decision.recordId);
        return {
          ...decision,
          mapping: { ...(record?.draft?.mapping || {}), ...(decision.mapping || {}) },
        };
      })
    : [];
  if (clinicalReview)
    assertClinicalSourceScopes(db, file, inputFile, validation.entries!, decisions);
  if (clinicalReview)
    for (const decision of decisions.filter((d) => d.action === 'accept')) {
      const record = clinicalReview.records.find((r) => r.id === decision.recordId);
      if (record?.reviewState === 'kept_original')
        throw new HttpError(
          409,
          'REVIEW_DISPOSITION',
          'This candidate was kept as original evidence only',
        );
      if (
        record?.issues?.some(
          (issue) => issue.blocking && issue.status !== 'resolved' && !issue.questionId,
        )
      )
        throw new HttpError(
          409,
          'REVIEW_ISSUES_PENDING',
          'Review this record’s identity or uncertain reading before accepting it',
        );
      if (
        record?.questions?.some(
          (q) =>
            q.status === 'unanswered' &&
            record.issues?.find((issue) => issue.questionId === q.id)?.blocking !== false &&
            record.issues?.find((issue) => issue.questionId === q.id)?.status !== 'resolved' &&
            !(
              q.field === 'duplicate' &&
              decision.comparisons?.some(
                (pair) =>
                  pair.otherRecordId === q.otherRecordId &&
                  ['same_event', 'changed_version', 'distinct'].includes(pair.outcome),
              )
            ),
        )
      )
        throw new HttpError(
          409,
          'QUESTIONS_PENDING',
          'Answer this record’s questions before accepting it; other resolved records can be accepted independently',
        );
      if (record?.identityReview?.blocking)
        throw new HttpError(
          409,
          'REVIEW_ISSUES_PENDING',
          'Review this record’s current identity evidence before accepting it',
        );
      for (const [field, value] of Object.entries(record?.suggestedMapping || {}))
        if (
          canonicalLiteral(
            decision.mapping?.[field as keyof IntakeClinicalMapping] ??
              record!.mapping[field as keyof IntakeClinicalMapping],
          ) !== canonicalLiteral(value)
        )
          throw new HttpError(
            409,
            'ANSWER_REVIEW_REQUIRED',
            'Review the saved answer’s proposed field correction before accepting this record',
          );
    }
  const previous = new Set(
    db
      .prepare("SELECT raw_json FROM source_records WHERE provider_id=? AND kind LIKE 'intake_%'")
      .all(file.provider_id)
      .map((r) => canonicalLiteral(parseLiteralJSON((r as { raw_json: string }).raw_json))),
  );
  const matchingEarlierRows = validation.entries!.filter((e) => previous.has(e.canonical)).length;
  const prevalidatedPairScopes = clinicalReview
    ? (
        validateClinicalPairScopes as unknown as (
          db: DatabaseSync,
          file: SourceFileRow,
          inputFile: SourceFileRow,
          entries: IntakeEntry[],
          review: IntakeReview,
          decisions: IntakeReviewDecision[],
        ) => Set<string>
      )(db, reviewedSource(db, file, d), inputFile, validation.entries!, clinicalReview, decisions)
    : undefined;
  return {
    review: clinicalReview,
    decisions,
    apply(expectedVersion: number, occurrenceAuthorityFinalizers?: OccurrenceAuthorityFinalizer[]) {
      const file = row(db, id),
        d = details(db, file);
      checkVersion(db, file, expectedVersion);
      const insert = db.prepare(
        'INSERT OR IGNORE INTO source_records(id,source_file_id,provider_id,source_key,kind,label,raw_json,locator_json,extraction_status,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      );
      for (const entry of validation.entries!) {
        const retained = retainedClinicalSourceRecord(
          entry,
          inputFile.id,
          id,
          selected,
          file.provider_id,
          file.batch_id,
        );
        insert.run(
          retained.id,
          retained.sourceFileId,
          retained.providerId,
          retained.sourceKey,
          retained.kind,
          retained.label,
          retained.raw,
          retained.locator,
          retained.extractionStatus,
          retained.batchId,
        );
      }
      const medicationsBefore = (
        db.prepare('SELECT count(*) AS n FROM medications').get() as { n: number }
      ).n;
      const clinical = clinicalReview
        ? (projectClinicalReview as unknown as ProjectClinicalReview)(db, {
            file: reviewedSource(db, file, d, true),
            inputFile,
            entries: validation.entries!,
            review: clinicalReview,
            decisions,
            root,
            profileId,
            prevalidatedPairScopes,
            occurrenceAuthorityFinalizers,
          })
        : null;
      if (clinical)
        clinical.newMedications = Math.max(
          0,
          (db.prepare('SELECT count(*) AS n FROM medications').get() as { n: number }).n -
            medicationsBefore,
        );
      if (d.imported)
        (d.importHistory ||= []).push({
          ...d.imported,
          acceptedProposalId: d.acceptedProposalId,
          reviewToken: d.lastReviewToken || null,
        });
      recordCandidateVersions(file, d, validation.entries!, selected);
      if (clinicalReview) saveWorkflowDecisions(file, d, clinicalReview, decisions);
      d.lastDecisionFingerprint = decisionFingerprint;
      d.lastReviewToken = input.reviewToken || null;
      d.version++;
      d.state = workflowSummary(d).needsReview ? 'needs_review' : 'imported';
      d.acceptedProposalId = selected;
      d.imported = {
        records: validation.rows,
        repeatedRows: validation.exactRepeatedRows,
        matchingEarlierRows,
        at: now(),
        fileId: inputFile.id,
        ...(clinical ? { clinical } : {}),
      };
      update(db, file, d);
      db.prepare(
        "UPDATE manual_batches SET status='verified',verified_at=?,coverage_json=?,notes=? WHERE id=?",
      ).run(
        now(),
        JSON.stringify({
          sourceIntake: id,
          rawPreserved: true,
          validation: validationSummary(validation),
          imported: d.imported,
          clinicalProjection: clinical ? 'reviewed' : 'none',
        }),
        clinical
          ? 'Explicitly accepted clinical projection, original assertions and evidence preserved.'
          : 'Verified original hash and JSONL syntax/provenance. All source occurrences retained; repeated content is counted, not merged as clinical events. Clinical mapping and source truth are unreviewed.',
        file.batch_id,
      );
      return { intakeVersion: d.version, imported: d.imported };
    },
  };
}

interface IntakeChildContext {
  db: DatabaseSync;
  root: string;
  profileId: string;
  assertRunning?: () => void;
}

/** Host-only verified descriptor. No extraction-size ceiling applies to ranges. */
export async function withVerifiedIntakeOriginalDescriptor<T>(
  context: IntakeChildContext & { id: string },
  writer: (source: { sourceFd: number; assertRunning: () => void }) => Promise<T>,
): Promise<T> {
  const { db, root, profileId, id } = context;
  const original = getRetainedIntakeOriginalReference(db, root, profileId, id);
  return withVerifiedSourceDescriptor(
    { ...original, path: resolve(root, row(db, id).path) },
    () => {
      owner(db, profileId);
      context.assertRunning?.();
    },
    (sourceFd, assertRunning) => writer({ sourceFd, assertRunning }),
  );
}

function childIdentity(parentId: string, locator: string, digest: string) {
  const key = hash([parentId, locator, digest].join('\0'));
  return { key, id: 'intake:' + key };
}
function childDescriptor(file: SourceFileRow, d: IntakeDetails) {
  return {
    id: file.id,
    filename: d.originalName,
    locator: d.locator,
    derivative: d.derivative,
    mimeType: file.mime_type,
    bytes: file.bytes,
    contentUrl: `/api/sources/${encodeURIComponent(file.id)}/content`,
  };
}
function prepareIntakeChild(
  context: IntakeChildContext & { parentId: string },
  parent: SourceFileRow,
  child: { filename: string; locator: string; derivative?: boolean; bytes?: Buffer },
  staged: StagedUpload | null = null,
) {
  const { root, profileId, parentId } = context;
  const digest = staged?.sha256 ?? hash(child.bytes!),
    size = staged?.bytes ?? child.bytes!.length,
    { key, id } = childIdentity(parentId, child.locator, digest),
    name =
      basename(child.filename.replaceAll('\\', '/'))
        .replace(/[\x00-\x1f]/g, '')
        .slice(0, 200) || 'extracted',
    path = `${profilePaths(root, profileId).relativeRoot}/sources/${encodeURIComponent(parent.provider_id)}/intake/${key}/${name}`,
    mimeType = mime(staged?.prefix ?? child.bytes!, name, size),
    binary =
      !['application/octet-stream', 'application/json', 'application/x-ndjson'].includes(
        mimeType,
      ) || (staged?.prefix ?? child.bytes!).subarray(0, 512).includes(0);
  const parsed =
    !binary && size <= MAX_INTAKE_BYTES
      ? validateJSONL(staged ? readFileSync(staged.path) : child.bytes!)
      : null;
  const validation = parsed
    ? validationSummary(parsed)
    : {
        valid: false,
        rows: 0,
        exactRepeatedRows: 0,
        partialRows: 0,
        unrecognizedRows: 0,
        preview: [],
        previewComplete: false,
        issues: [
          {
            line: 0,
            message: binary
              ? 'Binary original retained in full; file/page-aware conversion is pending. JSONL validation was not attempted.'
              : 'Original retained in full. Files above 25 MiB require bounded conversion proposals; JSONL validation was not attempted.',
          },
        ],
      };
  const d: IntakeDetails = {
    originalName: child.filename,
    createdAt: now(),
    version: 1,
    state: validation.valid ? 'ready' : 'pending_conversion',
    validation,
    proposals: [],
    acceptedProposalId: null,
    imported: null,
    parentSourceFileId: parentId,
    locator: child.locator,
    derivative: !!child.derivative,
  };
  saveOriginal(root, profileId, path, child.bytes, staged);
  if (parsed?.valid) recordCandidateVersions({ id, sha256: digest }, d, parsed.entries, null);
  return {
    id,
    path,
    providerId: parent.provider_id,
    sha256: digest,
    size,
    mimeType,
    kind: 'intake_original',
    coverage: child.derivative
      ? 'derived_page_render; unreviewed'
      : 'embedded_original; unreviewed',
    batchId: parent.batch_id,
    details: { intake: d },
  };
}
function publishIntakeChildren(
  context: IntakeChildContext,
  files: ReturnType<typeof prepareIntakeChild>[],
) {
  const { db, root, profileId } = context;
  const missing = files.filter(
    (f) => !db.prepare('SELECT 1 FROM source_files WHERE id=?').get(f.id),
  );
  if (missing.length) {
    mutate(db, () => {
      for (const f of missing) {
        stampNewReportGroups(db, intakeWorkflow(f.details.intake));
        registerFile(db, f);
      }
    });
    flushIntake(db, root, profileId);
  }
  return files.map((f) => {
    const retained = row(db, f.id);
    return childDescriptor(retained, details(db, retained));
  });
}

/** Stream one selected occurrence to a private stage, then use the same durable
 * original/registration boundary as bounded PDF attachments. */
export async function withStagedIntakeChild(
  context: IntakeChildContext & { parentId: string },
  member: { filename: string; locator: string; bytes: number; sourceHash: string },
  writer: (files: {
    sourceFd: number;
    outputFd: number;
    assertRunning: () => void;
  }) => Promise<void>,
) {
  const { db, root, profileId, parentId } = context;
  if (
    !Number.isSafeInteger(member.bytes) ||
    member.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(member.sourceHash)
  )
    throw new HttpError(400, 'PACKAGE_MEMBER', 'Invalid verified member size or hash');
  const original = getRetainedIntakeOriginalReference(db, root, profileId, parentId),
    parent = row(db, parentId);
  let publicationAttempted = false;
  try {
    return await withVerifiedSourceDescriptor(
      { ...original, path: resolve(root, parent.path) },
      () => {
        owner(db, profileId);
        context.assertRunning?.();
      },
      async (sourceFd, assertUnchanged) => {
        const { id } = childIdentity(parentId, member.locator, member.sourceHash);
        if (db.prepare('SELECT 1 FROM source_files WHERE id=?').get(id)) {
          const retained = row(db, id),
            d = details(db, retained);
          if (
            d.parentSourceFileId !== parentId ||
            d.locator !== member.locator ||
            retained.sha256 !== member.sourceHash ||
            retained.bytes !== member.bytes
          )
            throw new HttpError(409, 'SOURCE_CHANGED', 'Retained member scope changed');
          return withVerifiedIntakeOriginalDescriptor({ ...context, id }, async () =>
            childDescriptor(retained, d),
          );
        }
        return withPrivateChildStage(
          root,
          member,
          (outputFd) => writer({ sourceFd, outputFd, assertRunning: assertUnchanged }),
          (staged) => {
            assertUnchanged();
            const file = prepareIntakeChild(
              context,
              parent,
              { filename: member.filename, locator: member.locator },
              staged,
            );
            assertUnchanged();
            publicationAttempted = true;
            return publishIntakeChildren(context, [file])[0]!;
          },
        );
      },
    );
  } catch (error) {
    let safeToRecordFailure = false;
    if (!publicationAttempted)
      try {
        verifyIntakeOriginal(db, root, profileId, parentId);
        safeToRecordFailure = true;
      } catch {
        // A changed/locked parent cannot authorize a new failure mutation.
      }
    return childStorageError(error, safeToRecordFailure);
  }
}

// Keep the Buffer boundary bounded for PDF attachment callers that have not
// migrated to a streaming producer.
export function retainIntakeChildren(
  db: DatabaseSync,
  root: string,
  profileId: string,
  parentId: string,
  children: IntakeChildInput[],
) {
  owner(db, profileId);
  const parent = row(db, parentId);
  verifyIntakeOriginal(db, root, profileId, parentId);
  if (children.length > 300 || children.reduce((n, c) => n + c.bytes.length, 0) > 100 * 1024 * 1024)
    throw new HttpError(413, 'EXTRACTION_LIMIT', 'Extract fewer members at a time');
  const context = { db, root, profileId, parentId };
  const files = children.map((child) => {
    if (
      !Buffer.isBuffer(child.bytes) ||
      !child.bytes.length ||
      child.bytes.length > MAX_INTAKE_BYTES
    )
      throw new HttpError(413, 'EXTRACTION_LIMIT', 'An extracted file is empty or exceeds 25 MiB');
    return prepareIntakeChild(context, parent, child);
  });
  return publishIntakeChildren(context, files);
}

/** Internal compound review mutations share the existing durable source transaction. */
export function workflowMutation<T extends WorkflowMutationInput>(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: T,
  callback: (workflow: Workflow, file: SourceFileRow, details: IntakeDetails) => void,
) {
  owner(db, profileId);
  const file = row(db, id),
    d = details(db, file),
    workflow = intakeWorkflow(d);
  const operationId = input.operationId ? safeText(input.operationId, 'operation ID', 200) : null;
  const { version, ...request } = input,
    fingerprint = workflowHash(request);
  if (operationId) {
    const prior = workflow.operations.find((op) => op.id === operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new HttpError(
          409,
          'OPERATION_CONFLICT',
          'This operation already records a different request',
        );
      return {
        ...getIntake(db, root, profileId, id),
        durability: flushIntake(db, root, profileId),
      };
    }
  }
  checkVersion(db, file, version);
  verifyIntakeOriginal(db, root, profileId, id);
  mutate(db, () => {
    checkVersion(db, row(db, id), version);
    callback(workflow, file, d);
    if (operationId) workflow.operations.push({ id: operationId, fingerprint, at: now() });
    d.version++;
    if (workflowSummary(d).needsReview) d.state = 'needs_review';
    update(db, file, d);
  });
  return {
    ...getIntake(db, root, profileId, id),
    durability: flushIntake(db, root, profileId),
  };
}
export function askIntakeQuestion(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: AskQuestionInput,
) {
  owner(db, profileId);
  const file = row(db, id),
    workflow = intakeWorkflow(details(db, file));
  if (workflow.questions.some((q) => q.id === 'question:' + workflowHash([file.id, input.key]))) {
    addWorkflowQuestion(file, workflow, input);
    return getIntake(db, root, profileId, id);
  }
  return workflowMutation(db, root, profileId, id, input, (workflow, file) =>
    addWorkflowQuestion(file, workflow, input),
  );
}
export function answerIntakeQuestion(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: AnswerQuestionInput,
) {
  if (!input.operationId)
    throw new HttpError(400, 'OPERATION_ID', 'A stable answer operation ID is required');
  return workflowMutation(db, root, profileId, id, input, (workflow) => {
    const question = required(
      workflow.questions.find((q) => q.id === input.questionId),
      'Question does not belong to this delivery',
    );
    const answer = safeText(input.answer, 'answer', 10000).trim();
    if (!answer) throw new HttpError(400, 'QUESTION_ANSWER', 'Enter an answer');
    const mapping = input.mapping || {};
    if (
      !mapping ||
      typeof mapping !== 'object' ||
      Array.isArray(mapping) ||
      Object.entries(mapping).some(
        ([key, value]) =>
          ![
            'kind',
            'subject',
            'date',
            'status',
            'testLabel',
            'valueText',
            'unit',
            'referenceText',
            'code',
            'codeSystem',
            'specimen',
            'method',
            'medicationName',
            'doseText',
            'route',
            'frequency',
            'medicationKind',
            'dateRole',
            'startDate',
            'endDate',
            'procedureLabel',
            'procedureCategory',
            'documentTitle',
            'documentDate',
            'text',
          ].includes(key) ||
          typeof value !== 'string' ||
          value.length > 10000,
      )
    )
      throw new HttpError(
        400,
        'QUESTION_MAPPING',
        'Answer mapping must contain supported record fields',
      );
    const kind = (issueKind as unknown as IssueKind)(question.prompt, question.field);
    const scopedFields = (resolutionFields as unknown as ResolutionFields)({
      kind,
      field: question.field,
    });
    if (
      (kind === 'information' && Object.keys(mapping).length) ||
      Object.keys(mapping).some(
        (field) =>
          ['date', 'documentDate', 'startDate', 'endDate'].includes(field) &&
          !scopedFields.includes(field as keyof IntakeClinicalMapping),
      )
    )
      throw new HttpError(
        400,
        'QUESTION_MAPPING',
        'A date correction requires an explicitly scoped date question',
      );
    question.answers.push({ id: input.operationId, answer, mapping, scope: 'record', at: now() });
    question.status = 'answered';
  });
}
export function updateIntakeMetadata(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: MetadataUpdateInput,
) {
  if (!input.operationId)
    throw new HttpError(400, 'OPERATION_ID', 'A stable metadata operation ID is required');
  return workflowMutation(db, root, profileId, id, input, (_workflow, file, d) => {
    const value = input.metadata as Record<string, unknown> | null;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !['source', 'careArea', 'documentType', 'topics'].includes(key),
      )
    )
      throw new HttpError(400, 'INTAKE_METADATA', 'Supply supported source metadata fields');
    const metadata: IntakeMetadata = {
      source: null,
      careArea: null,
      documentType: null,
      topics: [],
      ...d.metadata,
    };
    for (const field of ['source', 'careArea', 'documentType'] as const)
      if (Object.hasOwn(value, field))
        metadata[field] =
          value[field] === null ? null : safeText(value[field], field, 200).trim() || null;
    if (Object.hasOwn(value, 'topics')) {
      if (!Array.isArray(value.topics) || value.topics.length > 30)
        throw new HttpError(400, 'INTAKE_METADATA', 'Supply at most 30 topics');
      metadata.topics = [
        ...new Set(
          value.topics
            .map((topic: unknown) => safeText(topic, 'topic', 200).trim())
            .filter(Boolean),
        ),
      ];
    }
    d.acquisition ||= { providerId: file.provider_id, provider: file.provider };
    if (metadata.source) {
      const p = provider(db, { newProviderName: metadata.source });
      if (p.create) db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(p.id, p.name);
      metadata.sourceProviderId = p.id;
    } else metadata.sourceProviderId = null;
    (d.metadataHistory ||= []).push({
      id: input.operationId,
      before: d.metadata || null,
      metadata,
      at: now(),
    });
    d.metadata = metadata;
  });
}
export function getIntakeReportSourceReview(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupIdInput: string,
  viewInput: string,
): IntakeReportSourceReview {
  const groupId = safeText(groupIdInput, 'report group ID', 2000);
  if (!['active', 'deferred', 'all'].includes(viewInput))
    throw new HttpError(400, 'REPORT_SOURCE_SCOPE', 'Choose active, deferred or all records');
  const view = viewInput as IntakeReportQueueView;
  const intake = getIntake(db, root, profileId, id);
  const workflow = intake.workflow;
  const scope = workflow && intakeReportSourceReviewScope(workflow, profileId, id, groupId, view);
  if (!scope)
    throw new HttpError(
      409,
      'REPORT_SOURCE_SCOPE',
      'This report does not have a current anchored source-label scope',
    );
  const reviews = new Map<string, IntakeReview>();
  const targets = scope.entries.map((entry) => {
    const reviewKey = entry.occurrence.proposalId || '';
    let review = reviews.get(reviewKey);
    if (!review) {
      review = reviewIntake(db, root, profileId, id, entry.occurrence.proposalId);
      reviews.set(reviewKey, review);
    }
    const record = review.records.find(
      (candidate) =>
        candidate.id === entry.occurrence.recordId &&
        candidate.candidateId === entry.candidateId &&
        candidate.candidateVersionId === entry.candidateVersionId,
    );
    if (!record)
      throw new HttpError(
        409,
        'REPORT_SOURCE_SCOPE',
        'An affected report record changed; reload its source review',
      );
    const effective = intakeReportSourceForMember(
      workflow.reportSourceConfirmations,
      [{ groupId: entry.sourceRef.groupId, groupVersionId: entry.sourceRef.groupVersionId }],
      entry,
      entry.occurrence,
    );
    return {
      ...entry,
      title: record.title,
      date: record.date,
      kind: record.kind,
      effectiveSource: effective?.confirmation.source || null,
    };
  });
  return {
    profileId,
    intakeId: id,
    intakeVersion: intake.version,
    groupId,
    groupVersionId: scope.current.id,
    view,
    scopeToken: scope.scopeToken,
    targets,
    coverage: intakeReportSourceCoverageCounts(targets.map((target) => target.effectiveSource)),
    sourceEvidence: scope.sourceEvidence,
    ...(scope.sourceEvidence.length > 1
      ? {
          warning: `This report contains conflicting source branding: ${scope.sourceEvidence.join(
            ', ',
          )}. Check the retained report before using one source.`,
        }
      : {}),
  };
}

export function confirmIntakeReportSource(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: ReportSourceUpdateInput,
): IntakeReportSourceResult {
  if (!input.operationId)
    throw new HttpError(400, 'OPERATION_ID', 'A stable report source operation ID is required');
  let applied: IntakeReportSourceConfirmation | null = null;
  const updated = workflowMutation(db, root, profileId, id, input, (workflow) => {
    const groupId = safeText(input.groupId, 'report group ID', 2000);
    const groupVersionId = safeText(input.groupVersionId, 'report group version ID', 2000);
    const contextId = safeText(input.contextId, 'report context ID', 2000);
    const source = safeText(input.source, 'source label', 200).trim();
    if (!source) throw new HttpError(400, 'REPORT_SOURCE', 'Choose a nonempty source label');
    if (
      input.basis !== undefined &&
      input.basis !== 'manual_report_label' &&
      input.basis !== 'explicit_current_members'
    )
      throw new HttpError(400, 'REPORT_SOURCE', 'Unsupported report source label basis');
    if (
      input.basis === 'explicit_current_members' &&
      (!input.scopeToken ||
        safeText(input.scopeToken, 'report source scope token', 200) !== input.scopeToken ||
        (input.view !== 'active' && input.view !== 'deferred' && input.view !== 'all'))
    )
      throw new HttpError(
        400,
        'REPORT_SOURCE_SCOPE',
        'Load the exact active, deferred or all source review before confirming it',
      );
    const group = workflow.reportGroups?.find((item) => item.id === groupId);
    const current = group?.versions.at(-1);
    if (!group || !current || current.id !== groupVersionId)
      throw new HttpError(
        409,
        'REPORT_SOURCE_SCOPE',
        'This report changed; review its current source evidence before confirming it',
      );
    const explicit =
      input.basis === 'explicit_current_members'
        ? intakeReportSourceReviewScope(workflow, profileId, id, groupId, input.view!)
        : null;
    const validScope =
      input.basis === 'explicit_current_members'
        ? !!explicit && contextId === current.id
        : input.basis === 'manual_report_label'
          ? group.basis === 'report_anchor' && !!group.report?.anchor && contextId === current.id
          : current.context?.status === 'linked' &&
            current.context.contextId === contextId &&
            !!current.context.sourceSuggestion;
    if (!validScope)
      throw new HttpError(
        409,
        'REPORT_SOURCE_SCOPE',
        'Review the current report boundary or source suggestion before labeling it',
      );
    if (
      input.basis === 'explicit_current_members' &&
      (!input.scopeToken || input.scopeToken !== explicit?.scopeToken)
    )
      throw new HttpError(
        409,
        'REPORT_SOURCE_SCOPE',
        'The affected report records changed; review the exact current source scope again',
      );
    const scope =
      input.basis === 'explicit_current_members'
        ? null
        : intakeReportSourceScope(group, current, input.basis);
    if (input.basis !== 'explicit_current_members' && !scope)
      throw new HttpError(
        409,
        'REPORT_SOURCE_SCOPE',
        'This report has mixed source context; review its records separately before labeling it',
      );
    const members =
      input.basis === 'explicit_current_members'
        ? [
            ...new Map(
              (explicit?.entries || []).map(
                (entry) =>
                  [
                    canonicalLiteral([entry.candidateId, entry.candidateVersionId]),
                    {
                      candidateId: entry.candidateId,
                      candidateVersionId: entry.candidateVersionId,
                    },
                  ] as const,
              ),
            ).values(),
          ]
        : current.members
            .filter((member) => {
              const candidate = workflow.candidates.find(
                (candidate) => candidate.id === member.candidateId,
              );
              const version = candidate?.versions.find(
                (version) => version.id === member.candidateVersionId,
              );
              return (
                version?.status === 'pending' &&
                !workflow.decisions.some(
                  (decision) =>
                    decision.action === 'accept' &&
                    decision.candidateId === member.candidateId &&
                    decision.candidateVersionId === member.candidateVersionId,
                )
              );
            })
            .map(({ candidateId, candidateVersionId }) => ({ candidateId, candidateVersionId }));
    if (!members.length)
      throw new HttpError(
        409,
        'REPORT_SOURCE_SCOPE',
        'This report has no current pending members to label; preserve accepted source history',
      );
    const selected = provider(db, { newProviderName: source });
    if (selected.create)
      db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(selected.id, selected.name);
    const at = now();
    const extensions =
      input.basis === 'explicit_current_members'
        ? []
        : priorIntakeReportSourceExtensions(
            group,
            current,
            input.basis,
            input.operationId,
            members,
            at,
          );
    const coverageEntries =
      input.basis === 'explicit_current_members'
        ? explicit!.entries.map((entry) => ({
            ...entry,
            id:
              'report-source-coverage:' +
              workflowHash([input.operationId, entry.id, entry.sourceRef]),
          }))
        : [];
    applied = {
      ...(input.basis ? { basis: input.basis } : {}),
      operationId: input.operationId,
      groupId,
      groupVersionId,
      contextId,
      source: selected.name,
      sourceProviderId: selected.id,
      members,
      ...(scope ? { scope } : {}),
      ...(extensions.length ? { extensions } : {}),
      ...(input.basis === 'explicit_current_members'
        ? {
            scopeToken: explicit!.scopeToken,
            view: explicit!.view,
            coverageEntries,
          }
        : {}),
      at,
    };
    (workflow.reportSourceConfirmations ||= []).push(applied);
  });
  const confirmation =
    applied ||
    updated.workflow?.reportSourceConfirmations?.find(
      (candidate) => candidate.operationId === input.operationId,
    );
  if (!confirmation) throw new Error('Report source confirmation was not retained');
  return { intake: updated, confirmation };
}
function reviewedSource(
  db: DatabaseSync,
  file: SourceFileRow,
  d: IntakeDetails,
  materialize = false,
): ReviewedSourceRow {
  // Defaults are derived from the exact linked context/version, not a filename or
  // another package member. Manual choices take precedence. Accepted snapshots
  // retain the selection basis without inventing a human confirmation receipt.
  const defaults: IntakeReportSourceConfirmation[] = (d.workflow?.reportGroups || []).flatMap(
    (group) =>
      group.versions.flatMap((version) => {
        const context = version.context;
        if (
          group.basis !== 'report_anchor' ||
          version.contextState === 'mixed' ||
          context?.status !== 'linked' ||
          !context.sourceSuggestion
        )
          return [];
        const source = context.sourceSuggestion.value.trim();
        if (!source) return [];
        const selected = provider(db, { newProviderName: source });
        return [
          {
            basis: 'suggested_report_label' as const,
            operationId:
              'default-report-source:' +
              workflowHash([group.id, version.id, context.contextId, source]),
            groupId: group.id,
            groupVersionId: version.id,
            contextId: context.contextId,
            source: selected.name,
            sourceProviderId: selected.id,
            members: version.members.map(({ candidateId, candidateVersionId }) => ({
              candidateId,
              candidateVersionId,
            })),
            at: '',
          },
        ];
      }),
  );
  const reportSources = [...defaults, ...(d.workflow?.reportSourceConfirmations || [])];
  for (const confirmation of reportSources) {
    const existing = db
      .prepare('SELECT name FROM providers WHERE id=?')
      .get(confirmation.sourceProviderId) as { name: string } | undefined;
    if (existing && existing.name !== confirmation.source)
      throw new HttpError(
        409,
        'REPORT_SOURCE_SCOPE',
        'The retained report source no longer matches its provider identity',
      );
    if (!existing && materialize)
      db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(
        confirmation.sourceProviderId,
        confirmation.source,
      );
  }
  return {
    ...file,
    provider_id: d.metadata?.sourceProviderId || file.provider_id,
    provider: d.metadata?.source || file.provider,
    reviewedMetadata: d.metadata || null,
    reportSourceConfirmations: reportSources,
  };
}

function retainTerminalPairDecision(
  db: DatabaseSync,
  root: string,
  profileId: string,
  file: SourceFileRow,
  d: IntakeDetails,
  proposalId: string | null,
  review: IntakeReview,
  record: IntakeReview['records'][number],
  decision: IntakeReviewDecision,
): void {
  const comparisons = decision.comparisons?.filter(
    (comparison) =>
      comparison.outcome !== 'unresolved' ||
      (comparison.scope?.format === 'intake-pair-scope-v2' &&
        comparison.scope.activeAttachment !== null),
  );
  if (!comparisons?.length) return;
  if (decision.action !== 'skip')
    throw new HttpError(
      400,
      'IMPORT_REVIEW',
      'Keeping original evidence can retain pair decisions but cannot accept a clinical record',
    );
  const inputFile: SourceFileRow = proposalId
    ? required(
        db.prepare('SELECT * FROM source_files WHERE id=?').get(proposalId) as
          SourceFileRow | undefined,
      )
    : file;
  if (inputFile.bytes > MAX_INTAKE_BYTES)
    throw new HttpError(
      413,
      'CONVERSION_REQUIRED',
      'Original retained; review a bounded JSONL conversion proposal (at most 25 MiB)',
    );
  const bytes = measureImportPhase(
    'review_proposal_read',
    () => readFileSync(profileOriginal(root, inputFile.path, profileId)),
    { bytes: inputFile.bytes },
    { profileId },
  );
  if (hash(bytes) !== inputFile.sha256 || bytes.length !== inputFile.bytes)
    throw new HttpError(409, 'SOURCE_CHANGED', 'Review source changed');
  const validation = validateJSONL(bytes);
  if (!validation.valid)
    throw new HttpError(400, 'INVALID_JSONL', 'Convert the original before clinical review');
  const entry = required(
    validation.entries!.find((candidate) => `${inputFile.id}:line:${candidate.line}` === record.id),
    'Clinical review entry is missing from its retained proposal',
  );
  const retained = retainedClinicalSourceRecord(
    entry,
    inputFile.id,
    file.id,
    proposalId,
    file.provider_id,
    file.batch_id,
  );
  db.prepare(
    'INSERT OR IGNORE INTO source_records(id,source_file_id,provider_id,source_key,kind,label,raw_json,locator_json,extraction_status,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(
    retained.id,
    retained.sourceFileId,
    retained.providerId,
    retained.sourceKey,
    retained.kind,
    retained.label,
    retained.raw,
    retained.locator,
    retained.extractionStatus,
    retained.batchId,
  );
  (projectClinicalReview as unknown as ProjectClinicalReview)(db, {
    file: reviewedSource(db, file, d, true),
    inputFile,
    entries: [entry],
    review: { ...review, records: [record] },
    decisions: [{ ...decision, comparisons }],
    root,
    profileId,
  });
}

export function saveIntakeReviewDraft(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: IntakeReviewDraftUpdate,
) {
  if (!input.operationId)
    throw new HttpError(400, 'OPERATION_ID', 'A stable review operation ID is required');
  return workflowMutation(db, root, profileId, id, input, (workflow, file, d) => {
    const proposalId = input.proposalId || null;
    const review = reviewIntake(db, root, profileId, id, proposalId);
    const record = required(
      review.records.find((r) => r.id === input.recordId),
      'Review record does not belong to this proposal',
    );
    if (record.candidateVersionId !== input.candidateVersionId)
      throw new HttpError(
        409,
        'CANDIDATE_VERSION_CONFLICT',
        'Reload the current candidate before saving this review',
      );
    const previous = (currentReviewDraft as unknown as CurrentReviewDraft)(
      workflow,
      proposalId,
      record.id,
      record.candidateVersionId!,
    );
    if (record.reviewState === 'accepted' || record.reviewState === 'kept_original')
      throw new HttpError(
        409,
        'REVIEW_DISPOSITION',
        'This review is already complete; retained decisions cannot be replaced',
      );
    const disposition = input.disposition || 'pending';
    if (!['pending', 'review_later', 'keep_original_only'].includes(disposition))
      throw new HttpError(400, 'REVIEW_DISPOSITION', 'Choose a supported review disposition');
    const mapping = {
      ...previous?.mapping,
      ...(validateDraftMapping as unknown as ValidateDraftMapping)(input.mapping, record.mapping),
    };
    const decision =
      input.decision === undefined
        ? previous?.decision
        : (validateDraftDecision as unknown as ValidateDraftDecision)(input.decision, record);
    const answers = { ...previous?.answers };
    if (input.answers !== undefined) {
      if (
        !input.answers ||
        typeof input.answers !== 'object' ||
        Array.isArray(input.answers) ||
        Object.entries(input.answers).some(
          ([key, value]) =>
            !record.questions!.some((q) => q.id === key) ||
            typeof value !== 'string' ||
            value.length > 10000,
        )
      )
        throw new HttpError(
          400,
          'QUESTION_ANSWER',
          'Supply answer drafts for this record’s questions',
        );
      Object.assign(answers, input.answers);
    }
    if (
      input.resolutions !== undefined &&
      (!Array.isArray(input.resolutions) || input.resolutions.length > 100)
    )
      throw new HttpError(400, 'REVIEW_RESOLUTION', 'Supply a bounded list of issue resolutions');
    const resolutions = [...(previous?.resolutions || [])];
    const at = now();
    // Hydrated clients send their current resolutions with each autosave. Only
    // the latest submitted choice for each issue can be a new review action.
    const submittedResolutions = new Map<string, NonNullable<typeof input.resolutions>[number]>();
    for (const resolution of input.resolutions || []) {
      if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution))
        throw new HttpError(400, 'REVIEW_RESOLUTION', 'Supply supported issue resolutions');
      submittedResolutions.set(resolution.issueId, resolution);
    }
    for (const resolution of submittedResolutions.values()) {
      const retained = resolutions.findLast((r) => r.issueId === resolution.issueId);
      // A hydrated autosave carries the exact historical decision. Keep it in
      // history even if a later field edit or identity projection removed the
      // issue from the current review. Only a fresh choice can pin new evidence.
      if (
        retained &&
        resolution.operationId === retained.operationId &&
        resolution.at === retained.at &&
        canonicalLiteral(resolution) === canonicalLiteral(retained)
      )
        continue;
      const issue = required(
        record.issues!.find((i) => i.id === resolution.issueId),
        'Issue does not belong to this candidate',
      );
      // Retain old decisions, including older unscoped date choices, without
      // reapplying their edits when a hydrated draft is saved again.
      if (
        retained?.outcome === resolution.outcome &&
        canonicalLiteral(retained.mapping || {}) === canonicalLiteral(resolution.mapping || {}) &&
        issueResolutionCurrent(db, retained, { ...record.mapping, ...mapping })
      )
        continue;
      if (
        ![
          'this_is_me',
          'other_person',
          'unknown',
          'confirmed',
          'corrected',
          'acknowledged',
        ].includes(resolution.outcome) ||
        (['this_is_me', 'other_person'].includes(resolution.outcome) &&
          issue.kind !== 'identity') ||
        (issue.kind === 'identity' &&
          !['this_is_me', 'other_person', 'unknown'].includes(resolution.outcome))
      )
        throw new HttpError(400, 'REVIEW_RESOLUTION', 'Choose an outcome supported by this issue');
      const correction = {
        ...(validateDraftMapping as unknown as ValidateDraftMapping)(
          resolution.mapping,
          record.mapping,
        ),
      };
      const fields = (resolutionFields as unknown as ResolutionFields)(issue);
      if (
        Object.keys(correction).some(
          (field) => !fields.includes(field as keyof IntakeClinicalMapping),
        )
      )
        throw new HttpError(
          400,
          'REVIEW_RESOLUTION',
          'A field correction requires an issue explicitly scoped to that field',
        );
      if (resolution.outcome === 'this_is_me') {
        if (record.identityReview?.status === 'conflict')
          throw new HttpError(
            409,
            'IDENTITY_CONFLICT',
            'The evidenced name or date of birth conflicts with Self and cannot be bypassed',
          );
        correction.subject = 'self';
        if (record.mapping.kind === 'document') correction.kind = 'document';
      }
      if (resolution.outcome === 'other_person') correction.subject = 'other';
      const priorResolution = resolutions.findLast((r) => r.issueId === issue.id);
      const effectiveCorrection =
        resolution.outcome === 'unknown' && issue.kind === 'date' && fields.length
          ? Object.fromEntries(fields.map((field) => [field, '']))
          : correction;
      if (
        priorResolution?.outcome === resolution.outcome &&
        canonicalLiteral(priorResolution.mapping) === canonicalLiteral(effectiveCorrection) &&
        issueResolutionCurrent(db, priorResolution, { ...record.mapping, ...mapping }) &&
        (resolution.outcome !== 'unknown' ||
          !Object.keys(correction).length ||
          canonicalLiteral(correction) === canonicalLiteral(priorResolution.mapping))
      )
        continue;
      // Keep original assertions intact. Explicitly unconfirmed dates become
      // unknown only in the reviewed mapping, never in retained source evidence.
      const clearsUnconfirmedDate =
        issue.kind === 'date' &&
        fields.length > 0 &&
        Object.entries(correction).every(
          ([field, value]) => fields.includes(field as keyof IntakeClinicalMapping) && value === '',
        );
      if (
        resolution.outcome === 'unknown' &&
        Object.keys(correction).length &&
        !clearsUnconfirmedDate
      )
        throw new HttpError(
          400,
          'REVIEW_RESOLUTION',
          'Keeping a field uncertain cannot also correct its value',
        );
      if (resolution.outcome === 'unknown' && issue.kind === 'date')
        for (const field of fields) (correction as Record<string, unknown>)[field] = '';
      Object.assign(mapping, correction);
      resolutions.push({
        issueId: issue.id,
        outcome: resolution.outcome,
        mapping: correction,
        at,
        operationId: input.operationId,
        dependency: issueResolutionDependency(db, id, issue, { ...record.mapping, ...mapping }),
      });
      const question = workflow.questions.find((q) => q.id === issue.questionId);
      if (question && resolution.outcome !== 'unknown') {
        question.answers.push({
          id: input.operationId + ':' + issue.id,
          answer: resolution.outcome,
          outcome: resolution.outcome,
          mapping: correction,
          scope: 'record',
          at,
        });
        question.status = 'answered';
      }
    }
    // A save may resolve several questions and apply several corrections. Pin
    // each newly made answer to the final reviewed mapping, independent of the
    // order in which those answers appeared in the request.
    for (const resolution of resolutions) {
      if (resolution.operationId !== input.operationId) continue;
      const issue = record.issues!.find((candidate) => candidate.id === resolution.issueId);
      if (issue)
        resolution.dependency = issueResolutionDependency(db, id, issue, {
          ...record.mapping,
          ...mapping,
        });
    }
    if (
      input.correctionReason !== undefined &&
      (typeof input.correctionReason !== 'string' ||
        !input.correctionReason.trim() ||
        input.correctionReason.length > 10000)
    )
      throw new HttpError(
        400,
        'CORRECTION_REASON',
        'Supply a correction reason of at most 10000 characters',
      );
    const corrections = [...(previous?.corrections || [])];
    const correctedMapping = { ...record.mapping, ...mapping, ...decision?.mapping };
    const changedFields = Object.keys(correctedMapping).filter(
      (key) =>
        !['subject', 'personId', 'sourceSystem'].includes(key) &&
        canonicalLiteral(correctedMapping[key as keyof IntakeClinicalMapping]) !==
          canonicalLiteral(record.mapping[key as keyof IntakeClinicalMapping]),
    );
    if (
      input.correctionPatch !== undefined &&
      (!input.correctionReason ||
        canonicalLiteral(input.correctionPatch) !==
          canonicalLiteral(
            Object.fromEntries(
              changedFields.map((key) => [
                key,
                correctedMapping[key as keyof IntakeClinicalMapping],
              ]),
            ),
          ))
    )
      throw new HttpError(
        409,
        'CORRECTION_PATCH_CHANGED',
        'The correction reason must describe exactly these changed fields and values. Review the patch and its reason again.',
      );
    if (input.correctionReason && changedFields.length)
      corrections.push({
        operationId: input.operationId,
        at,
        reason: input.correctionReason.trim(),
        before: Object.fromEntries(
          changedFields.map((key) => [key, record.mapping[key as keyof IntakeClinicalMapping]]),
        ),
        after: Object.fromEntries(
          changedFields.map((key) => [key, correctedMapping[key as keyof IntakeClinicalMapping]]),
        ),
      });
    const draft: IntakeReviewDraft = {
      ...(corrections.length ? { corrections } : {}),
      id: input.operationId,
      proposalId,
      recordId: record.id,
      candidateId: record.candidateId!,
      candidateVersionId: record.candidateVersionId!,
      mapping,
      resolutions,
      disposition,
      at,
      ...(decision ? { decision } : {}),
      answers,
    };
    workflow.reviewDrafts.push(draft);
    if (disposition === 'keep_original_only') {
      if (decision)
        retainTerminalPairDecision(
          db,
          root,
          profileId,
          file,
          d,
          proposalId,
          review,
          record,
          decision,
        );
      const candidateVersion = workflow.candidates
        .find((c) => c.id === record.candidateId)
        ?.versions.find((v) => v.id === record.candidateVersionId);
      if (candidateVersion) candidateVersion.status = 'kept_original';
      workflow.decisions.push({
        ...draft,
        action: 'keep_original_only',
        scope: 'record',
        evidence: record.evidence,
      });
      d.state = workflowSummary(d).needsReview
        ? 'needs_review'
        : d.imported
          ? 'imported'
          : 'kept_original';
    }
  });
}

const draftRepairFields = new Set<IntakeDraftRepairField>([
  'date',
  'method',
  'observationCategory',
]);

/** Apply one explicitly previewed field value to an exact group of pending drafts. */
export function saveIntakeDraftRepair(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: IntakeDraftRepairUpdate,
) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !['version', 'operationId', 'groupId', 'corrections'].includes(key),
    ) ||
    !Number.isInteger(input.version) ||
    typeof input.operationId !== 'string' ||
    !input.operationId
  )
    throw new HttpError(400, 'OPERATION_ID', 'A stable draft repair operation ID is required');
  if (
    !input.groupId ||
    !Array.isArray(input.corrections) ||
    !input.corrections.length ||
    input.corrections.length > 100
  )
    throw new HttpError(400, 'DRAFT_REPAIR_SCOPE', 'Choose 1–100 exact pending draft fields');
  const seen = new Set<string>();
  for (const correction of input.corrections) {
    if (
      !correction ||
      typeof correction !== 'object' ||
      Array.isArray(correction) ||
      Object.keys(correction).some(
        (key) =>
          !['proposalId', 'recordId', 'candidateVersionId', 'field', 'before', 'after'].includes(
            key,
          ),
      ) ||
      !draftRepairFields.has(correction.field) ||
      typeof correction.recordId !== 'string' ||
      typeof correction.candidateVersionId !== 'string' ||
      (correction.proposalId !== null && typeof correction.proposalId !== 'string') ||
      typeof correction.before !== 'string' ||
      typeof correction.after !== 'string' ||
      correction.after.length > 1000
    )
      throw new HttpError(400, 'DRAFT_REPAIR_SCOPE', 'Supply exact supported draft corrections');
    const key = JSON.stringify([
      correction.proposalId,
      correction.recordId,
      correction.candidateVersionId,
      correction.field,
    ]);
    if (seen.has(key))
      throw new HttpError(400, 'DRAFT_REPAIR_SCOPE', 'Each selected field may be corrected once');
    seen.add(key);
  }
  return workflowMutation(db, root, profileId, id, input, (workflow) => {
    const reviews = new Map<string, IntakeReview>();
    for (const correction of input.corrections) {
      const proposalKey = correction.proposalId || '';
      let review = reviews.get(proposalKey);
      if (!review) {
        review = reviewIntake(db, root, profileId, id, correction.proposalId);
        reviews.set(proposalKey, review);
      }
      const record = required(
        review.records.find((candidate) => candidate.id === correction.recordId),
        'Selected draft does not belong to this proposal',
      );
      if (record.candidateVersionId !== correction.candidateVersionId)
        throw new HttpError(
          409,
          'DRAFT_REPAIR_STALE',
          'A selected draft changed. Review the current fields before applying this correction.',
        );
      if (!record.reportGroups?.some((group) => group.groupId === input.groupId))
        throw new HttpError(
          409,
          'DRAFT_REPAIR_SCOPE',
          'Selected drafts no longer share the reviewed report boundary',
        );
      if (record.reviewState === 'accepted' || record.reviewState === 'kept_original')
        throw new HttpError(409, 'DRAFT_REPAIR_STATE', 'Only pending drafts can be corrected');
      if (
        (correction.field === 'date' &&
          record.mapping.kind !== 'observation' &&
          record.mapping.kind !== 'procedure') ||
        ((correction.field === 'method' || correction.field === 'observationCategory') &&
          record.mapping.kind !== 'observation')
      )
        throw new HttpError(
          400,
          'DRAFT_REPAIR_FIELD',
          'That correction field does not apply to this draft kind',
        );
      if (correction.field === 'date') datePrecision(correction.after);
      else if (!correction.after.trim())
        throw new HttpError(400, 'DRAFT_REPAIR_FIELD', 'Method and category cannot be blank');
      const previous = currentReviewDraft(
        workflow,
        correction.proposalId,
        record.id,
        record.candidateVersionId!,
      );
      const currentMapping = {
        ...record.mapping,
        ...previous?.mapping,
        ...previous?.decision?.mapping,
      };
      const currentValue = String(currentMapping[correction.field] ?? '');
      if (currentValue !== correction.before)
        throw new HttpError(
          409,
          'DRAFT_REPAIR_STALE',
          'A selected field changed. Review the current value before applying this correction.',
        );
      const patch = validateDraftMapping({ [correction.field]: correction.after }, record.mapping);
      const mapping = { ...previous?.mapping, ...patch };
      const decision = previous?.decision
        ? {
            ...previous.decision,
            mapping: { ...previous.decision.mapping, ...patch },
          }
        : undefined;
      workflow.reviewDrafts.push({
        id: `${input.operationId}:${seen.size}:${correction.recordId}:${correction.field}`,
        proposalId: correction.proposalId,
        recordId: record.id,
        candidateId: record.candidateId!,
        candidateVersionId: record.candidateVersionId!,
        mapping,
        ...(previous?.corrections ? { corrections: previous.corrections } : {}),
        resolutions: previous?.resolutions || [],
        disposition: previous?.disposition || 'pending',
        ...(decision ? { decision } : {}),
        answers: previous?.answers || {},
        at: now(),
      });
    }
  });
}
export async function saveIntakePackagePlan(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: PackagePlanInput,
) {
  const { validatePackageRolePlan } = await import('./intake-package.ts');
  if (!input.operationId)
    throw new HttpError(400, 'OPERATION_ID', 'A stable package role operation ID is required');
  return workflowMutation(db, root, profileId, id, input, (workflow) => {
    const plan = required(
      workflow.plans.find((p) => p.id === input.planId && p.status === 'active'),
      'Active extraction plan not found',
    );
    const roles = (
      validatePackageRolePlan as unknown as (
        index: ExtractionIndex,
        input: PackagePlanInput,
      ) => IntakePackageRole[]
    )(plan.index, input);
    const merged = new Map((plan.packageRoles || []).map((role) => [role.memberId, role]));
    for (const role of roles) merged.set(role.memberId, role);
    plan.packageRoles = [...merged.values()];
    (plan.packageRolesHistory ||= []).push({ id: input.operationId, roles, at: now() });
  });
}
export async function createIntakePlan(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: PlanInput,
) {
  owner(db, profileId);
  const initial = row(db, id);
  checkVersion(db, initial, input.version);
  const { indexIntakeEvidence } = await import('./intake-evidence.ts');
  const index = (await indexIntakeEvidence({
    db,
    root,
    profileId,
    id,
    assertRunning: input.assertRunning,
  })) as ExtractionIndex;
  input.assertRunning?.();
  return workflowMutation(db, root, profileId, id, input, (workflow, file) => {
    const pins = (extractionPins as unknown as ExtractionPins)(db, file),
      units = (extractionUnits as unknown as ExtractionUnits)(index, input);
    const planId = 'plan:' + workflowHash([file.id, pins, units.map(({ id }) => id)]);
    if (workflow.plans.some((p) => p.id === planId)) return;
    const current = workflow.plans.find((p) => p.status === 'active');
    if (current && input.replacePlanId !== current.id)
      throw new HttpError(
        409,
        'PLAN_CHANGED',
        'Explicitly replace the prior extraction plan; completed work remains retained',
      );
    if (current) current.status = 'superseded';
    workflow.plans.push({
      id: planId,
      createdAt: now(),
      status: 'active',
      pins,
      index,
      units,
      batches: [],
    });
  });
}
export function getIntakePlan(db: DatabaseSync, root: string, profileId: string, id: string) {
  const intake = getIntake(db, root, profileId, id);
  return {
    intakeId: id,
    version: intake.version,
    plans: intake.workflow!.plans,
    candidates: intake.workflow!.candidates,
    questions: intake.workflow!.questions,
    pendingWorkCount: intake.pendingWorkCount,
  };
}
export function intakePlanPinsCurrent(
  db: DatabaseSync,
  profileId: string,
  id: string,
  planId: string,
  operationId?: string,
): boolean {
  owner(db, profileId);
  const file = row(db, id);
  const workflow = intakeWorkflow(details(db, file));
  const plan = workflow.plans.find(
    (candidate) => candidate.id === planId && candidate.status === 'active',
  );
  const operation = operationId
    ? workflow.operations.find((candidate) => candidate.id === operationId)
    : null;
  return (
    !!plan &&
    (!operationId || operation?.fingerprint === workflowHash({ operationId })) &&
    workflowHash(plan.pins) ===
      workflowHash((extractionPins as unknown as ExtractionPins)(db, file))
  );
}
export function readIntakeUnit(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  unitId: string,
  { offset = 0, limit = 24000 }: ReadIntakeOptions = {},
) {
  const intake = getIntake(db, root, profileId, id),
    plan =
      intake.workflow!.plans.find(
        (p) => p.status === 'active' && p.units.some((u) => u.id === unitId),
      ) || intake.workflow!.plans.find((p) => p.units.some((u) => u.id === unitId));
  const unit = required(
    plan?.units.find((u) => u.id === unitId),
    'Extraction unit not found',
  );
  return readPlannedIntakeUnit({
    db,
    root,
    profileId,
    id,
    plan: plan as Parameters<typeof readPlannedIntakeUnit>[0]['plan'],
    unit,
    offset,
    limit,
  });
}
function recordExtractionBatch(
  d: IntakeDetails,
  proposalId: string,
  batch: NonNullable<PersistenceOptions['workflowBatch']>,
): void {
  const workflow = intakeWorkflow(d),
    plan = required(
      workflow.plans.find((p) => p.id === batch.planId),
      'Extraction plan not found',
    );
  const receipt = { id: batch.operationId, proposalId, coverage: batch.coverage, at: now() };
  plan.batches.push(receipt);
  for (const item of batch.coverage) {
    const unit = plan.units.find((u) => u.id === item.unitId)!;
    unit.attempts.push(receipt.id);
    unit.status = item.kind === 'extracted' ? 'completed' : 'partial';
    unit.coverage = item;
  }
  workflow.operations.push({
    id: batch.operationId,
    fingerprint: batch.fingerprint,
    at: receipt.at,
  });
}
export function submitIntakeBatch(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: SubmitBatchInput,
  observedSourcePages?: ObservedSourcePages[],
) {
  owner(db, profileId);
  const file = row(db, id),
    workflow = intakeWorkflow(details(db, file));
  const operationId = safeText(input.operationId, 'batch operation ID', 200);
  if (!operationId)
    throw new HttpError(400, 'OPERATION_ID', 'A stable batch operation ID is required');
  const { version, ...request } = input,
    fingerprint = workflowHash(request),
    prior = workflow.operations.find((op) => op.id === operationId);
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'Batch operation already recorded a different result',
      );
    return getIntake(db, root, profileId, id);
  }
  checkVersion(db, file, version);
  const plan = required(
    workflow.plans.find((p) => p.id === input.planId && p.status === 'active'),
    'Active extraction plan not found',
  );
  if (
    workflowHash(plan.pins) !==
    workflowHash((extractionPins as unknown as ExtractionPins)(db, file))
  )
    throw new HttpError(
      409,
      'EXTRACTION_CONFIG_CHANGED',
      'Model, instructions, mapping or source changed. Create an explicit replacement plan; prior completed work is retained',
    );
  const coverage = input.coverage;
  if (
    !Array.isArray(coverage) ||
    !coverage.length ||
    coverage.length > 50 ||
    new Set(coverage.map((c) => c.unitId)).size !== coverage.length ||
    coverage.some(
      (c) =>
        !plan.units.some((u) => u.id === c.unitId) ||
        !['inspected', 'extracted', 'context', 'unreadable'].includes(c.kind) ||
        typeof c.notes !== 'string' ||
        c.notes.length > 4000,
    )
  )
    throw withDiagnosticValidation(
      new HttpError(
        400,
        'BATCH_COVERAGE',
        'Supply distinct plan units with explicit extracted/context/inspected/unreadable coverage and notes',
      ),
      { code: 'invalid_batch_coverage', path: 'arguments.coverage' },
    );
  return proposeConversion(
    db,
    root,
    profileId,
    id,
    { ...input, modelIdentity: plan.pins },
    { workflowBatch: { planId: plan.id, operationId, coverage, fingerprint }, observedSourcePages },
  );
}
