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
  prepareInitialIntakeEnvelope,
  readIntakeEnvelope,
  readNonIntakeEnvelope,
  stageIntakeEnvelope,
} from './intake-authority.ts';
import { createSourceDetailsSearch } from './source-details-search.ts';
import { reconcileActiveSourceTextProjection } from './source-text-projection.ts';
import type {
  Intake,
  IntakeMetadata,
  IntakeProposal,
  IntakeState,
  IntakeValidation,
  IntakeWorkflow,
} from '../shared/intake.ts';
import type { IntakeIdentityReceipt } from '../shared/intake-identity.ts';
import type { intakeWorkflow } from './intake-workflow.ts';
import {
  parseIntakeSourcePin,
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
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function envelope(db: DatabaseSync, file: DetailsRow): Record<string, unknown> {
  const value = readIntakeEnvelope(db, file);
  if (!object(value)) throw Error('Intake source metadata is incomplete');
  return value;
}
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
  const all = envelope(db, file);
  const stored = requireStoredIntakeDetails(db, file);
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
    ? readIntakeEnvelope(db, file)
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
    file.kind === 'intake_original' ? prepareInitialIntakeEnvelope(file.details) : null;
  db.prepare(
    'INSERT INTO source_files(id,provider_id,path,sha256,bytes,mime_type,kind,coverage_status,batch_id,details_json) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(
    file.id,
    file.providerId ?? null,
    file.path,
    file.sha256 || createHash('sha256').update(file.bytes!).digest('hex'),
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
