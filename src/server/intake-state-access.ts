import {
  maximumIntakeDiscoveryOrder,
  retainedIntakeAcceptance,
  indexedIntakeIdentityConfirmations,
  reconcileActiveIntakeLookup,
} from './intake-lookup-projection.ts';
import type { IntakePersonProposalState } from '../shared/intake-people.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { currentTransactionToken } from './database.ts';
import {
  initializeIntakeEnvelope,
  intakeEnvelopeAuthorityBinding,
  prepareInitialIntakeEnvelope,
  readIntakeEnvelope,
  readIntakeEnvelopeMaterialized,
  readNonIntakeEnvelope,
  stageIntakeEnvelope,
} from './intake-authority.ts';
import { createSourceDetailsSearch } from './source-details-search.ts';
import { reconcileActiveSourceTextProjection } from './source-text-projection.ts';
import { withIntakeWork } from './intake-work-accounting.ts';
import { recordIntakeFileHash } from './intake-file-work.ts';
import { HttpError } from './database.ts';
import { INTAKE_ENVELOPE_FORMAT, intakeEnvelopeProjectionFormatHint } from './intake-authority.ts';
import {
  hasIntakeCollectionEnvelope,
  openIntakeCollectionEnvelope,
  openIntakeCollectionEnvelopeIfNative,
  intakeEnvelopeFilenameCell,
} from './intake-collection-envelope.ts';
import {
  isIntakeCompactScalar,
  isPreparedIntakeCompactScalar,
  compactIntakeScalar,
  type IntakeCompactScalar,
} from './intake-compact-scalar.ts';
import { parseIntakeFilenameFacts } from './intake-filename-facts.ts';
import { schemaKey } from './intake-envelope-schema.ts';
import { intakeLocatorKey } from './intake-locator-key.ts';
import type { IntakeMetadataScalarReference } from '../shared/intake-summary.ts';
import type {
  Intake,
  IntakeMetadata,
  IntakePackageFailure,
  IntakeProposal,
  IntakeState,
  IntakeValidation,
  IntakeWorkflow,
} from '../shared/intake.ts';
import type { IntakeIdentityReceipt } from '../shared/intake-identity.ts';
import type { intakeWorkflow } from './intake-workflow.ts';
import {
  parseIntakeSourcePin,
  readIntakeSourcePin,
  withIntakeSourcePin,
  withoutIntakeSourcePin,
} from './intake-source-pin.ts';
type Workflow = ReturnType<typeof intakeWorkflow>;
export interface InternalProposal extends IntakeProposal {
  modelIdentity?: Record<string, string | null> | null;
}

export interface IntakeDetails {
  sourceTextRevisionId?: string | null;
  sourceTextDependencyToken?: string | null;
  sourceTextRequiresInterpretation?: boolean;
  originalName: string;
  acquisition?: { providerId: string; provider: string };
  metadata?: IntakeMetadata;
  metadataHistory?: NonNullable<Intake['metadataHistory']>;
  receivedMimeType?: string | null;
  createdAt: string;
  version: number;
  state: IntakeState;
  validation: IntakeValidation;
  packageFailures?: Record<string, IntakePackageFailure>;
  proposals: InternalProposal[];
  acceptedProposalId: string | null;
  imported: Intake['imported'];
  conversionChatId?: string | null;
  importHistory?: (NonNullable<Intake['imported']> & {
    acceptedProposalId: string | null;
    reviewToken: string | null;
  })[];
  workflow?: Workflow & { peopleDrafts?: IntakePersonDraft[] };
  lastDecisionFingerprint?: string;
  lastReviewToken?: string | null;
  parentSourceFileId?: string | null;
  locator?: string;
  derivative?: boolean;
}

export interface IntakePersonDraft {
  proposalId: string;
  proposalVersion: string;
  state: Exclude<IntakePersonProposalState, 'saved'>;
  at: string;
}

interface DetailsRow {
  id: string;
  kind?: string;
  details_json?: string | null;
  source_pin?: unknown;
}
export type IntakeSourceMetadata = Omit<
  Pick<
    IntakeDetails,
    | 'originalName'
    | 'acquisition'
    | 'metadata'
    | 'receivedMimeType'
    | 'createdAt'
    | 'parentSourceFileId'
    | 'locator'
    | 'derivative'
    | 'sourceTextRevisionId'
  >,
  'originalName' | 'locator'
> & {
  originalName: string | IntakeCompactScalar;
  locator?: string | IntakeCompactScalar;
};
/** Ancestry authorization depends on the exact parent, not presentation facts. */
export function intakeSourceParent(db: DatabaseSync, id: string): unknown {
  const source = db
    .prepare("SELECT id,kind,sha256 FROM main.source_files WHERE id=? AND kind='intake_original'")
    .get(id);
  if (!source) throw Error('Source intake not found');
  const view = openIntakeCollectionEnvelopeIfNative(db, { id, sha256: source.sha256 as string });
  if (!view) return intakeSourceMetadata(db, id).parentSourceFileId;
  const intake = view.child(view.root(), 'intake');
  if (!intake) throw Error('Source intake header missing');
  const selected = view.field(intake, 'parentSourceFileId', { bytes: 16384 });
  if (selected.kind === 'missing') return undefined;
  if (selected.kind === 'value') return selected.value;
  // Preserve retained parent representations; this is not a new ID length cap.
  return JSON.parse([...view.fieldChunks(intake, 'parentSourceFileId')].join(''));
}

/** A checked compact source header, independent of inventory/workflow size.
 * Current authority and source identity are still checked on every call. The
 * compact raw representation retains JSON's existing last-member semantics. */
export function intakeSourceMetadata(db: DatabaseSync, id: string): IntakeSourceMetadata {
  const source = db
    .prepare(
      "SELECT id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(id);
  if (!source) throw Error('Source intake not found');
  intakeEnvelopeAuthorityBinding(
    db,
    source as unknown as Parameters<typeof intakeEnvelopeAuthorityBinding>[1],
  );
  const native = hasIntakeCollectionEnvelope(
    db,
    source as unknown as Parameters<typeof openIntakeCollectionEnvelope>[1],
  );
  const view = native
    ? openIntakeCollectionEnvelope(db, { id, sha256: source.sha256 as string })
    : undefined;
  if (
    view &&
    typeof source.details_json === 'string' &&
    source.details_json.length > 16384 &&
    intakeEnvelopeProjectionFormatHint(source.details_json) === INTAKE_ENVELOPE_FORMAT
  ) {
    const intake = view.child(view.root(), 'intake');
    if (!intake) throw Error('Source intake header missing');
    for (const field of ['originalName', 'locator'] as const) {
      const scalar = view.field(intake, field, { bytes: 16384 });
      if (
        scalar.kind === 'fragmented' &&
        view.fieldFragment(intake, field, { bytes: 4096 }).text.trimStart().startsWith('"')
      )
        throw new HttpError(
          409,
          'INTAKE_SUMMARY_UNAVAILABLE',
          'Prepare the selected source metadata first.',
        );
    }
  }
  const value = JSON.parse(source.details_json as string) as { intake: IntakeSourceMetadata };
  for (const field of ['originalName', 'locator'] as const) {
    const scalar = value.intake?.[field];
    if (!scalar || typeof scalar !== 'object') continue;
    // Only a scalar cell can produce a compact string descriptor. Retained
    // objects, including descriptor-shaped objects, remain ordinary values.
    if (view) {
      const intake = view.child(view.root(), 'intake');
      if (intake) {
        if (view.child(intake, field)) continue;
        const selected = view.field(intake, field, { bytes: 16384 });
        if (
          selected.kind === 'value' &&
          selected.value !== null &&
          typeof selected.value === 'object'
        )
          continue;
      }
    } else continue;
    if (!isIntakeCompactScalar(scalar) || scalar.field !== field)
      throw Error('Source metadata scalar requires native evidence');
    const intake = view.child(view.root(), 'intake');
    if (!intake) throw Error('Source intake header missing');
    const cell = intakeEnvelopeFilenameCell(view, intake, field);
    if (cell.facts === undefined)
      throw new HttpError(
        409,
        'INTAKE_SUMMARY_UNAVAILABLE',
        'Prepare the selected source metadata first.',
      );
    const facts = parseIntakeFilenameFacts(cell.facts);
    const prepared = compactIntakeScalar(field, facts);
    if (
      facts.binding !== cell.binding ||
      facts.bytes !== cell.bytes ||
      JSON.stringify(prepared) !== JSON.stringify(scalar)
    )
      throw Error('Source metadata scalar conflicts with exact evidence');
    value.intake[field] = prepared;
  }
  return value.intake;
}
export function intakeMetadataScalarReference(
  db: DatabaseSync,
  id: string,
  field: 'originalName' | 'locator',
  metadata: IntakeSourceMetadata,
): IntakeMetadataScalarReference | undefined {
  const scalar = metadata[field];
  if (!isPreparedIntakeCompactScalar(scalar)) return undefined;
  const source = db.prepare('SELECT sha256 FROM main.source_files WHERE id=?').get(id);
  const view = openIntakeCollectionEnvelope(db, { id, sha256: source?.sha256 as string });
  const version = intakeSourceVersion(db, id);
  return {
    format: 'health-intake-metadata-scalar-reference-v1',
    intakeId: id,
    field,
    pins: {
      sourceHash: source?.sha256 as string,
      logicalRoot: view.logical.root?.hash || '',
      domainVersion: view.logical.domainVersion,
      version: version.version,
    },
    scalarHash: scalar.scalarHash,
    bytes: scalar.bytes,
  };
}
/** SQLite JSON extraction selects the first raw occurrence, unlike JSON.parse. */
function firstLocatorEvidence(
  db: DatabaseSync,
  id: string,
): { literal: string } | { scalarHash: string } | undefined {
  const source = db
    .prepare(
      "SELECT id,kind,sha256,details_json,json_type(details_json,'$.intake.locator') locatorType,json_extract(details_json,'$.intake.locator') locator FROM main.source_files WHERE id=?",
    )
    .get(id);
  if (!source || source.kind !== 'intake_original') return undefined;
  intakeEnvelopeAuthorityBinding(
    db,
    source as unknown as Parameters<typeof intakeEnvelopeAuthorityBinding>[1],
  );
  if (typeof source.locator !== 'string') return undefined;
  const native = hasIntakeCollectionEnvelope(
    db,
    source as unknown as Parameters<typeof openIntakeCollectionEnvelope>[1],
  );
  if (!native) return source.locatorType === 'text' ? { literal: source.locator } : undefined;
  const view = openIntakeCollectionEnvelope(
    db,
    { id, sha256: source.sha256 as string },
    { fieldSelection: 'first' },
  );
  const intake = view.child(view.root(), 'intake');
  if (!intake) return undefined;
  if (source.locatorType === 'text') {
    const selected = view.field(intake, 'locator', { bytes: 16384 });
    if (selected.kind === 'fragmented')
      throw new HttpError(
        409,
        'INTAKE_SUMMARY_UNAVAILABLE',
        'Prepare the selected source metadata first.',
      );
    if (selected.kind !== 'value' || selected.value !== source.locator)
      throw Error('Source locator conflicts with exact first-occurrence evidence');
    return { literal: source.locator };
  }
  if (source.locatorType !== 'object') return undefined;
  if (view.child(intake, 'locator')) return undefined;
  const selected = view.field(intake, 'locator', { bytes: 16384 });
  if (selected.kind === 'value' && selected.value !== null && typeof selected.value === 'object')
    return undefined;
  const value: unknown = JSON.parse(source.locator);
  if (!isIntakeCompactScalar(value) || value.field !== 'locator') return undefined;
  const cell = intakeEnvelopeFilenameCell(view, intake, 'locator');
  if (cell.facts === undefined)
    throw new HttpError(
      409,
      'INTAKE_SUMMARY_UNAVAILABLE',
      'Prepare the selected source metadata first.',
    );
  const facts = parseIntakeFilenameFacts(cell.facts);
  if (
    facts.binding !== cell.binding ||
    facts.bytes !== cell.bytes ||
    JSON.stringify(compactIntakeScalar('locator', facts)) !== JSON.stringify(value)
  )
    throw Error('Source locator conflicts with exact first-occurrence evidence');
  return { scalarHash: facts.scalarHash };
}
export function intakeFirstLocatorMatcher(
  db: DatabaseSync,
  id: string,
): (exact: string) => boolean {
  const evidence = firstLocatorEvidence(db, id);
  return (exact) =>
    !!evidence &&
    ('literal' in evidence ? evidence.literal === exact : evidence.scalarHash === schemaKey(exact));
}
export function intakeFirstLocatorMatches(db: DatabaseSync, id: string, exact: string): boolean {
  return intakeFirstLocatorMatcher(db, id)(exact);
}
export async function intakeFirstLocatorMatchesCooperatively(
  db: DatabaseSync,
  id: string,
  exact: string,
  assertRunning: () => void,
): Promise<boolean> {
  const hash = await intakeLocatorKey(db, exact, assertRunning);
  assertRunning();
  // Read authority after the last yield, never reuse an earlier locator selection.
  const evidence = firstLocatorEvidence(db, id);
  assertRunning();
  return (
    !!evidence &&
    ('literal' in evidence ? evidence.literal === exact : evidence.scalarHash === hash)
  );
}

/** Public stale-tab version without hydrating a selected V4 workflow. The
 * separate source-text pin retains its existing additive version semantics. */
export function intakeSourceVersion(db: DatabaseSync, id: string) {
  const source = db
    .prepare(
      "SELECT id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(id);
  if (!source) throw Error('Source intake not found');
  const selected = source as unknown as Parameters<typeof intakeEnvelopeAuthorityBinding>[1];
  const binding = intakeEnvelopeAuthorityBinding(db, selected);
  const rawVersion =
    binding.logicalHead === undefined
      ? requireStoredIntakeDetails(db, selected).version
      : (JSON.parse(binding.head!) as { logical: { domainVersion: number } }).logical.domainVersion;
  const sourcePin = readIntakeSourcePin(db, id);
  const version = rawVersion + (sourcePin?.version ?? 0);
  if (!Number.isSafeInteger(rawVersion) || rawVersion < 0 || !Number.isSafeInteger(version))
    throw Error('Intake version is invalid');
  return { rawVersion, version, sourcePin, logicalBinding: binding.logicalHead };
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** Current persisted view, deliberately without merging the separate source pin. */
export function storedIntakeDetails(db: DatabaseSync, file: DetailsRow): IntakeDetails | undefined {
  const all =
    file.kind === 'intake_original' || file.kind === undefined
      ? readIntakeEnvelope(db, file)
      : readNonIntakeEnvelope(file.details_json);
  if (!object(all)) {
    if (file.kind === 'intake_original') throw Error('Intake source metadata is incomplete');
    return undefined;
  }
  if (!Object.hasOwn(all, 'intake')) {
    if (file.kind === 'intake_original') throw Error('Intake source metadata is incomplete');
    return undefined;
  }
  if (!object(all.intake)) throw Error('Intake source metadata is incomplete');
  if (typeof file.id !== 'string' || !file.id) throw Error('Intake source identity is incomplete');
  if (
    Object.hasOwn(all.intake, 'workflow') &&
    all.intake.workflow !== undefined &&
    !object(all.intake.workflow)
  )
    throw Error('Intake workflow is incomplete');
  return all.intake as unknown as IntakeDetails;
}
export function requireStoredIntakeDetails(db: DatabaseSync, file: DetailsRow): IntakeDetails {
  const details = storedIntakeDetails(db, file);
  if (!details) throw Error('Intake source metadata is incomplete');
  return details;
}
/** Effective DTO/version view used by intake mutations and stale-tab checks. */
export function intakeDetails(db: DatabaseSync, file: DetailsRow): IntakeDetails {
  return withIntakeSourcePin(
    requireStoredIntakeDetails(db, file),
    parseIntakeSourcePin(file.source_pin),
  );
}
export function readStoredIntakeDetails(
  db: DatabaseSync,
  id: string,
  { originalOnly = false }: { originalOnly?: boolean } = {},
): IntakeDetails | undefined {
  const file = db
    .prepare(
      'SELECT id,details_json,kind FROM source_files WHERE id=?' +
        (originalOnly ? " AND kind='intake_original'" : ''),
    )
    .get(id);
  return file ? storedIntakeDetails(db, file as unknown as DetailsRow) : undefined;
}
/** Write inside the caller's existing transaction; preserve envelope and separated pins. */
export function writeIntakeDetails(
  db: DatabaseSync,
  file: DetailsRow & { id: string },
  next: IntakeDetails,
  { effective = true }: { effective?: boolean } = {},
): string {
  // Replace the existing intake slot on a shallow envelope copy. The selected
  // stored view stays immutable, and unknown surrounding members retain order.
  const all = { ...readIntakeEnvelopeMaterialized(db, file).value };
  if (!object(all.intake)) throw Error('Intake source metadata is incomplete');
  const stored = all.intake as unknown as IntakeDetails;
  all.intake = effective
    ? withoutIntakeSourcePin(next, stored, parseIntakeSourcePin(file.source_pin))
    : next;
  const raw = stageIntakeEnvelope(db, file, all);
  reconcileActiveIntakeLookup(db);
  reconcileActiveSourceTextProjection(db);
  return raw;
}
/** Direct operational writers preserve their existing raw version/receipt semantics. */
export function updateStoredIntakeDetails(
  db: DatabaseSync,
  id: string,
  update: (details: IntakeDetails) => void,
): void {
  const file = db
    .prepare("SELECT id,details_json,kind FROM source_files WHERE id=? AND kind='intake_original'")
    .get(id);
  if (!file) throw Error('Source intake not found');
  const details = requireStoredIntakeDetails(db, file as unknown as DetailsRow);
  update(details);
  writeIntakeDetails(db, file as unknown as DetailsRow & { id: string }, details, {
    effective: false,
  });
}
/** Disposable current-source indexes preserve the scoped lookup contracts. */
export function maximumReportDiscoveryOrder(db: DatabaseSync): number {
  return maximumIntakeDiscoveryOrder(db);
}
export function retainedReportAcceptance(
  db: DatabaseSync,
  operationId: string,
): NonNullable<IntakeWorkflow['reportAcceptances']>[number] | null {
  return retainedIntakeAcceptance(db, operationId) as
    NonNullable<IntakeWorkflow['reportAcceptances']>[number] | null;
}
export function intakeIdentityConfirmations(db: DatabaseSync): IntakeIdentityReceipt[] {
  return indexedIntakeIdentityConfirmations(db) as IntakeIdentityReceipt[];
}
/** Source-file DTOs currently expose the complete envelope, including operational intake state. */
export function sourceFileDetails(db: DatabaseSync, file: DetailsRow & { id: string }): unknown {
  return file.kind === 'intake_original'
    ? readIntakeEnvelope(db, file, true)
    : readNonIntakeEnvelope(file.details_json);
}
/** Source list search includes operational JSON. Both count/page queries use this scoped adapter. */
export function sourceDetailsSearch(db: DatabaseSync, query: string) {
  return createSourceDetailsSearch(db, query);
}

/** Registration of roots, extracted children and proposals remains in the caller's publication transaction. */
export interface IntakeFileRegistration {
  id: string;
  providerId?: string | null;
  path: string;
  sha256?: string;
  bytes?: Buffer;
  size?: number;
  mimeType: string;
  kind: string;
  coverage: string;
  batchId?: string | null;
  details: Record<string, unknown> | string;
}

export function registerIntakeFile(db: DatabaseSync, file: IntakeFileRegistration): void {
  if (file.kind === 'intake_original' && (!currentTransactionToken(db) || !db.isTransaction))
    throw Error('Intake registration requires the existing application transaction');
  const prepared =
    file.kind === 'intake_original'
      ? withIntakeWork(db, 'warm', () => prepareInitialIntakeEnvelope(file.details))
      : null;
  let sourceHash = file.sha256;
  if (!sourceHash) {
    recordIntakeFileHash(file.bytes!);
    sourceHash = createHash('sha256').update(file.bytes!).digest('hex');
  }
  db.prepare(
    'INSERT INTO source_files(id,provider_id,path,sha256,bytes,mime_type,kind,coverage_status,batch_id,details_json) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(
    file.id,
    file.providerId ?? null,
    file.path,
    sourceHash,
    file.size ?? file.bytes!.length,
    file.mimeType,
    file.kind,
    file.coverage,
    file.batchId ?? null,
    prepared?.detailsJson ??
      (typeof file.details === 'string' ? file.details : JSON.stringify(file.details)),
  );
  if (prepared) initializeIntakeEnvelope(db, { id: file.id }, file.details);
  reconcileActiveIntakeLookup(db);
  reconcileActiveSourceTextProjection(db);
}
