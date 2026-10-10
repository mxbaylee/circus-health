import {
  terminalStatement,
  terminalExecution,
  terminalStatementsActive,
  prepareTerminalStatements,
  prepareTerminalStatementsInTransaction,
  withTerminalStatements,
  replayTerminalRecordMutations,
  replayTerminalPreparedRecordIndex,
  type PreparedTerminalStatements,
} from './database-terminal-statements.ts';
import {
  compactTerminalSql,
  compactTerminalBigIntSql,
  compactTerminalExecutions,
} from './intake-compact-terminal-sql.ts';
import {
  currentClinicalOperation,
  currentClinicalOperationReadonly,
  assertClinicalOperation,
  clinicalOperationCallerAssertions,
  type ClinicalOperation,
} from './clinical-operation.ts';
import type { VaultCompactAuthorization } from './vault-app.ts';
import type { PackageSourceOriginalPhysical } from './intake-package-source-lease.ts';
import {
  parseRecordJson,
  stringifyRecordJson,
  recordVersionWork,
  recordVersionWorkMaximum,
  recordVersionColumns,
  recordReplayCheckpoint,
  withRecordVersionWorkPhase,
} from './record-version-work.ts';
import { resolveClinicalReference } from './clinical-references.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { readRecordJsonLines, readRecordJsonLinesSteps } from './record-json-lines.ts';
import { parseRecordJsonPiecesSteps } from './record-json-pieces.ts';
import { recordSourceFieldChanges } from './record-source-field-changes.ts';
import { createRecordPreparedRows } from './record-prepared-rows.ts';
import { createRecordPreparedIndex } from './record-prepared-index.ts';
import { createRecordMutationRecipe } from './record-mutation-recipe.ts';
import { createRecordPreparedPriors } from './record-prepared-priors.ts';
import {
  prepareRecordPriorFields,
  recordFieldDigest,
  recordStringFieldDigest,
  type PreparedRecordPriorFields,
} from './record-prior-fields.ts';
import {
  consumeIntakeMaintenancePriorFields,
  sealIntakeMaintenancePriorFields,
  renewIntakeMaintenanceAfterIndex,
} from './intake-state-maintenance.ts';
import {
  captureVaultRecordStaging,
  vaultRecordStagingCurrent,
  stageVaultRecordObject,
  prepareVaultRecordHead,
  installVaultRecordHead,
  discardVaultRecordStaging,
  prepareVaultRecordStagingBacking,
  prepareVaultRecordTransactionBacking,
  assertVaultRecordTransactionPrior,
  prepareVaultRecordBackingAdvance,
  finishVaultRecordStagingPreparation,
  finishVaultRecordTransactionPreparation,
  assertVaultRecordMetadataPrior,
  bindVaultRecordStagingTransaction,
  type VaultRecordStagingWitness,
  captureVaultRecordReadOwner,
  vaultRecordReadOwnerCurrent,
  vaultRecordReadOwnerStagingCurrent,
  closeVaultRecordReadOwner,
  type VaultRecordReadOwner,
  vaultRecordReadOwnerSupported,
} from './vault-store.ts';
import {
  captureContributorRecordReadOwner,
  contributorRecordReadOwnerCurrent,
  closeContributorRecordReadOwner,
  type ContributorRecordReadOwner,
  contributorRecordReadOwnerSupported,
  captureContributorLegacyBridgeBackingScopeForStorage,
  bindContributorLegacyBridgeBackingScope,
  contributorLegacyBridgeBackingScopeCurrent,
  type ContributorLegacyBridgeBackingScope,
  closeContributorRecordHeadPublication,
  type ContributorRecordHeadPublication,
} from './contributor-record-storage.ts';
import {
  captureManagedPhysicalEpoch,
  managedPhysicalEpochCurrent,
} from './clinical-review-physical-epoch.ts';
// Logical record journal. All storage callbacks operate on plaintext bytes in
// memory; the profile vault must authenticate/encrypt durable objects and own
// the single-writer lock. This module never writes a plaintext journal to disk.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { setImmediate as yieldHost } from 'node:timers/promises';
import {
  openDatabase,
  databaseSchemaVersion,
  revision,
  observeDatabaseClose,
  registerTransactionDurability,
  managedDatabaseMethodEpoch,
  currentTransactionToken,
  HttpError,
  type Database,
  type SqliteRow,
  type TransactionOperation,
  type TransactionOutcome,
  type TransactionDurabilityHooks,
  prepareTerminalTransactionCallbacks,
  prepareRecordReplay,
  recordReplayCurrent,
  executeRecordReplay,
  notifyRecordReplay,
  terminalTransactionCallbacksCurrent,
  type TerminalTransactionCallbacks,
  transaction,
  transactionDurabilityParticipantCurrent,
} from './database.ts';
import { DatabaseSync, StatementSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import {
  expectIntakeFrontierMetaWrite,
  expectIntakeFrontierStateWrite,
  finishIntakeFrontierMetaWrite,
  intakeFrontierOwnedMetadataKeys,
  clearIntakeFrontierRecordCapture,
  prepareIntakeFrontierCaptureClear,
  type IntakeFrontierCaptureClear,
} from './intake-lookup-frontier-observer.ts';

const ownDescriptor = Object.getOwnPropertyDescriptor;
const readmissionPrepare = DatabaseSync.prototype.prepare;
const readmissionGet = StatementSync.prototype.get;

interface RecordBookkeeping {
  writes: bigint;
  metadataKeys: Set<string>;
  metadataOnly: boolean;
}
const maintenanceBookkeeping = new WeakMap<Database, { token: object; writes: bigint }>();
/** Only the accepted-record owner can mint these literal, transaction-bound counts. */
export function consumeRecordMaintenanceBookkeeping(db: Database, token: object): bigint {
  const receipt = maintenanceBookkeeping.get(db);
  maintenanceBookkeeping.delete(db);
  return receipt?.token === token ? receipt.writes : 0n;
}

export interface RecordStorage {
  read(name: string): Buffer | null | undefined;
  writeImmutable(name: string, bytes: Uint8Array): void;
  publishHead(bytes: Uint8Array): void;
}

export interface RecordObjectReference {
  name: string;
  sha256: string;
  bytes: number;
}

export interface DurableRecordVersion {
  format: 'health-record-versions-v1';
  profileId: string;
  schemaVersion: number;
  sequence: number;
  recordedAt: string;
  operationId: string;
  versionId: string;
  actor: unknown;
  origin: unknown;
  references: unknown;
  entity: string;
  recordId: string;
  contents: Record<string, unknown>;
  deleted: boolean;
  previousVersion: string | null;
}

interface RecordCommitHeader {
  profileId: string;
  schemaVersion: number;
  sequence: number;
  revision: number;
  previous: RecordObjectReference | null;
  operationId: string;
  fingerprint: unknown;
  result: unknown;
  recordedAt: string;
  records: number;
}
export interface RecordCommitV1 extends RecordCommitHeader {
  format: 'health-record-versions-v1';
  segments: RecordObjectReference[];
}
export interface RecordSegmentIndex {
  format: 'health-record-segment-index-v1';
  head: RecordObjectReference | null;
  count: number;
}
export interface RecordCommitV2 extends RecordCommitHeader {
  format: 'health-record-versions-v2';
  segments: RecordSegmentIndex;
}
export type RecordCommit = RecordCommitV1 | RecordCommitV2;
interface RecordSegmentPage {
  format: 'health-record-segment-page-v1';
  profileId: string;
  schemaVersion: number;
  sequence: number;
  operationId: string;
  previous: RecordObjectReference | null;
  firstSegment: number;
  segments: RecordObjectReference[];
}

interface TableSchema {
  name: string;
  columns: string[];
  pk: string[];
}

interface RecordConfig {
  profileId: string;
  storage: RecordStorage;
  verifyReferences?: (versions: DurableRecordVersion[]) => void;
  segmentBytes: number;
  schemaVersion: number;
  schema: TableSchema[];
}

interface IndexedTransaction {
  ref: RecordObjectReference;
  commit: RecordCommit;
  versions: Iterable<DurableRecordVersion>;
}

interface PendingRecordVersion {
  entity: string;
  recordId: string;
  contents: Record<string, unknown>;
  deleted: boolean;
  previousVersion: string | null;
}

interface CurrentVersionRow extends SqliteRow {
  version_id: string;
  deleted: number;
  contents_json: string;
}

interface RecordStateRow extends SqliteRow {
  profile_id: string;
  projection: number;
  schema_version: number;
  sequence: number;
  head_json: string;
}

export interface RecordDurabilityStatus {
  configured: true;
  format: 'health-record-versions-v1';
  dirty: boolean;
  conflicted: boolean;
  lastError: string | null;
  revision: number;
  persistedRevision: number;
  sequence: number;
}

export interface AttachRecordDurabilityOptions {
  profileId?: string;
  storage?: RecordStorage;
  verifyReferences?: (versions: DurableRecordVersion[]) => void;
  segmentBytes?: number;
}

export interface QueryRecordHistoryOptions {
  profileId?: string;
  entity?: string;
  recordId?: unknown;
  field?: string;
  beforeSequence?: number;
  limit?: number;
}

export type RecordFieldState = { present: false } | { present: true; value: unknown };
export interface RecordFieldChange {
  field: string;
  before: RecordFieldState;
  after: RecordFieldState;
}
export type RecordHistoryEntry = DurableRecordVersion & { changes: RecordFieldChange[] };
export interface RecordHistoryResult {
  entries: RecordHistoryEntry[];
  nextSequence: number | null;
}

const FORMAT = 'health-record-versions-v1';
const COMMIT_FORMAT = 'health-record-versions-v2';
const SEGMENT_REFERENCE_WINDOW = 64;
const SEGMENT_PAGE_BYTES = 32768;
const PROJECTION = 3;
const LIMIT = 256 * 1024;
const q = (s: string): string => '"' + s.replaceAll('"', '""') + '"';
const literal = (s: string): string => "'" + s.replaceAll("'", "''") + "'";
const digest = (bytes: Uint8Array): string => {
  recordVersionWork('hashCalls');
  recordVersionWork('hashedBytes', bytes.byteLength);
  return createHash('sha256').update(bytes).digest('hex');
};
const encode = (value: unknown): Buffer => {
  recordVersionWork('encodeCalls');
  const bytes = Buffer.from(stringifyRecordJson(value) + '\n');
  recordVersionWork('encodedBytes', bytes.length);
  return bytes;
};
const state = new WeakMap<Database, RecordConfig>();
interface RecordCapture {
  token: object;
  empty: boolean;
  bookkeeping?: RecordBookkeeping;
}
const recordParticipants = new WeakMap<Database, TransactionDurabilityHooks<RecordCapture>>();
declare const transactionPreparationBrand: unique symbol;
export interface RecordTransactionPreparation {
  readonly [transactionPreparationBrand]: true;
}
interface TransactionPreparationData {
  db: Database;
  config: RecordConfig;
  operation: TransactionOperation;
  operationJson: string;
  clinicalOperation: ClinicalOperation;
  methods: object;
  originalState: RecordStateRow;
  recordedAt: string;
  operationId: string;
  revision?: number;
  records: number;
  readOwner?: RecordReadOwner;
  authenticated?: boolean;
  completeBacking?: boolean;
  originals?: RecordPublicationOriginals;
  staging?: VaultRecordStagingWitness;
  staged?: Pick<IndexedTransaction, 'ref' | 'commit'> & {
    contributor?: ContributorRecordHeadPublication;
  };
  stagingStarted?: boolean;
  indexRows?: ReturnType<typeof createRecordPreparedIndex>;
  stateIndex?: ReturnType<typeof createRecordPreparedIndex>;
  valueChecks?: ReturnType<typeof createRecordPreparedIndex>;
  backingRows?: ReturnType<typeof createRecordPreparedIndex>;
  backingPlan?: RecordTransactionBackingPlan;
  indexBookkeeping?: RecordBookkeeping;
  indexWrites?: bigint;
  terminal?: PreparedTerminalStatements;
  rows: ReturnType<typeof createRecordPreparedRows>;
  recipe: ReturnType<typeof createRecordMutationRecipe>;
  token?: object;
  resultJson?: string;
  total?: bigint;
  tentativeStart?: bigint;
  tentativeWrites?: bigint;
  expectedTentativeWrites?: bigint;
  captureRows?: number | bigint;
  released?: boolean;
  closed: boolean;
  observers?: Set<PreparedPublicationObserver>;
}
interface PreparedPublicationObserver {
  published(outcome: TransactionOutcome): void;
  discarded(): void;
}
const transactionPreparations = new WeakMap<
  RecordTransactionPreparation,
  TransactionPreparationData
>();
const preparingTransactions = new WeakMap<TransactionOperation, TransactionPreparationData>();
const preparingTokens = new WeakMap<object, TransactionPreparationData>();
const preparedPublicationTokens = new WeakMap<object, TransactionPreparationData>();
declare const transactionBackingPlanBrand: unique symbol;
export interface RecordTransactionBackingPlan {
  readonly [transactionBackingPlanBrand]: true;
}
declare const transactionIndexedBrand: unique symbol;
export interface RecordTransactionIndexedPublication {
  readonly [transactionIndexedBrand]: true;
}
declare const transactionTerminalBrand: unique symbol;
export interface RecordTransactionTerminalExecution {
  readonly [transactionTerminalBrand]: true;
}
const transactionTerminalExecutions = new WeakMap<
  RecordTransactionTerminalExecution,
  {
    db: Database;
    witness: object;
    plan: RecordTransactionBackingPlan;
    used: boolean;
    complete(): unknown;
  }
>();
export function recordTransactionTerminalExecutionCurrent(
  execution: RecordTransactionTerminalExecution,
  db: Database,
  witness: object,
  plan: RecordTransactionBackingPlan,
): boolean {
  const owner = transactionTerminalExecutions.get(execution);
  return (
    !!owner &&
    !owner.used &&
    owner.db === db &&
    owner.witness === witness &&
    owner.plan === plan &&
    recordTransactionBackingPlanCurrent(plan, db, witness)
  );
}
/** Only the private consumer registered below supplies the finite T2 body. */
export function runRecordTransactionTerminalExecution(
  execution: RecordTransactionTerminalExecution,
  db: Database,
  witness: object,
  plan: RecordTransactionBackingPlan,
): unknown {
  if (!recordTransactionTerminalExecutionCurrent(execution, db, witness, plan))
    fail('record transaction terminal execution expired');
  const owner = transactionTerminalExecutions.get(execution)!;
  owner.used = true;
  return owner.complete();
}
const transactionBackingPlans = new WeakMap<
  RecordTransactionBackingPlan,
  {
    proof: TransactionPreparationData;
    witness: object;
    head: string;
  }
>();
const transactionIndexedPublications = new WeakMap<
  RecordTransactionIndexedPublication,
  {
    proof: TransactionPreparationData;
    plan: RecordTransactionBackingPlan;
    witness: object;
    token: object;
    head: string;
    consumed: boolean;
  }
>();
/** Exact payload transport only from this record owner's authenticated frozen
 * plan. A storage helper never receives authority from caller-provided rows. */
export function* verifiedRecordTransactionBackingVersions(
  plan: RecordTransactionBackingPlan,
  db: Database,
  witness: object,
  head: string,
): Generator<{
  entity: string;
  recordId: string;
  versionId: string;
  deleted: boolean;
  previousVersion: string | null;
  contentsJson: string;
}> {
  const found = transactionBackingPlans.get(plan);
  if (
    !found ||
    found.proof.db !== db ||
    found.witness !== witness ||
    found.head !== head ||
    found.proof.backingPlan !== plan ||
    !found.proof.authenticated ||
    found.proof.closed ||
    db.isTransaction
  )
    fail('foreign record transaction backing payload');
  const data = found!;
  const current = () => {
    assertClinicalOperation(db, data.proof.clinicalOperation);
    if (
      transactionBackingPlans.get(plan) !== data ||
      data.proof.closed ||
      state.get(db) !== data.proof.config ||
      managedDatabaseMethodEpoch(db) !== data.proof.methods
    )
      fail('record transaction backing payload changed');
  };
  let count = 0;
  current();
  if (!data.proof.backingRows) fail('record transaction backing payload is not sealed');
  for (const row of data.proof.backingRows!.inspect()) {
    current();
    const args = row.args;
    if (
      row.sql !== 'SELECT ?,?,?,?,?,?' ||
      args.length !== 6 ||
      typeof args[0] !== 'string' ||
      typeof args[1] !== 'string' ||
      typeof args[2] !== 'string' ||
      (args[3] !== 0 && args[3] !== 1) ||
      (args[4] !== null && typeof args[4] !== 'string') ||
      typeof args[5] !== 'string'
    )
      fail('record transaction backing payload shape differs');
    yield Object.freeze({
      entity: args[0] as string,
      recordId: args[1] as string,
      versionId: args[2] as string,
      deleted: args[3] === 1,
      previousVersion: args[4] as string | null,
      contentsJson: args[5] as string,
    });
    count++;
    current();
  }
  if (count !== data.proof.records) fail('record transaction backing payload membership differs');
  current();
}
/** One-shot private indexed receipt. Matching IDs or HEAD without the exact
 * original frozen payload plan cannot promote any reusable certificate root. */
export function consumeRecordTransactionBackingAdvance(
  db: Database,
  indexed: RecordTransactionIndexedPublication,
  witness: object,
  head: string,
  plan: RecordTransactionBackingPlan,
): boolean {
  const found = transactionIndexedPublications.get(indexed);
  if (
    !found ||
    found.consumed ||
    found.proof.db !== db ||
    found.witness !== witness ||
    found.head !== head ||
    found.plan !== plan ||
    found.proof.backingPlan !== plan ||
    transactionBackingPlans.get(plan)?.proof !== found.proof ||
    found.proof.closed ||
    !db.isTransaction ||
    currentTransactionToken(db) !== found.token ||
    state.get(db) !== found.proof.config ||
    managedDatabaseMethodEpoch(db) !== found.proof.methods
  )
    fail('foreign record indexed backing transition');
  found!.consumed = true;
  return true;
}
/** Readonly issuer checks for the genuine staged plan, not a caller callback. */
export function recordTransactionBackingPlanCurrent(
  plan: RecordTransactionBackingPlan,
  db: Database,
  witness: object,
): boolean {
  const data = transactionBackingPlans.get(plan),
    parent = data?.proof.originals && publicationOriginals.get(data.proof.originals),
    operation = currentClinicalOperationReadonly(db);
  if (
    !data ||
    !parent ||
    !operation ||
    data.witness !== witness ||
    data.proof.db !== db ||
    data.proof.closed ||
    data.proof.backingPlan !== plan ||
    !data.proof.authenticated ||
    state.get(db) !== data.proof.config ||
    managedDatabaseMethodEpoch(db) !== data.proof.methods
  )
    return false;
  try {
    assertClinicalOperation(db, data.proof.clinicalOperation);
    parent.current(clinicalOperationCallerAssertions(db, operation));
    return true;
  } catch {
    return false;
  }
}
/** Only the complete original parent union bound to this exact staged plan. */
export function* verifiedRecordTransactionOriginalArtifacts(
  plan: RecordTransactionBackingPlan,
  db: Database,
  witness: object,
): Generator<import('./intake-review-collection-session.ts').VerifiedClinicalArtifact> {
  const data = transactionBackingPlans.get(plan),
    parent = data?.proof.originals && publicationOriginals.get(data.proof.originals);
  if (!data || !parent || !recordTransactionBackingPlanCurrent(plan, db, witness))
    fail('record transaction original artifact owner unavailable');
  const artifacts = parent!.artifacts.captureVerifiedArtifacts();
  for (const row of artifacts()) {
    if (!recordTransactionBackingPlanCurrent(plan, db, witness))
      fail('record transaction original artifact owner changed');
    yield row;
  }
  if (!recordTransactionBackingPlanCurrent(plan, db, witness))
    fail('record transaction original artifact owner changed');
}
/** Open-time lease descriptors from the same genuine original assertion tree.
 * These are original evidence, never a new filesystem or SQL baseline. */
export function* verifiedRecordTransactionOriginalSources(
  plan: RecordTransactionBackingPlan,
  db: Database,
  witness: object,
): Generator<PackageSourceOriginalPhysical> {
  const data = transactionBackingPlans.get(plan),
    parent = data?.proof.originals && publicationOriginals.get(data.proof.originals),
    operation = currentClinicalOperationReadonly(db);
  if (!data || !parent || !operation || !recordTransactionBackingPlanCurrent(plan, db, witness))
    fail('record transaction original lease owner unavailable');
  for (const source of parent!.originalSources(clinicalOperationCallerAssertions(db, operation!))) {
    if (!recordTransactionBackingPlanCurrent(plan, db, witness))
      fail('record transaction original lease owner changed');
    yield source;
  }
  if (!recordTransactionBackingPlanCurrent(plan, db, witness))
    fail('record transaction original lease owner changed');
}
/** Private released-T1 provenance for the database replay transport. */
export function recordPreparedReplayCurrent(db: Database, token: object): boolean {
  const proof = preparedPublicationTokens.get(token);
  return (
    !!proof &&
    proof.db === db &&
    proof.token === token &&
    !proof.closed &&
    !!proof.resultJson &&
    !!proof.released &&
    state.get(db) === proof.config &&
    managedDatabaseMethodEpoch(db) === proof.methods &&
    transactionDurabilityParticipantCurrent(db, recordParticipants.get(db))
  );
}
function discardPreparedPublicationObservers(proof: TransactionPreparationData): void {
  if (proof.token) preparedPublicationTokens.delete(proof.token);
  const observers = proof.observers;
  proof.observers = undefined;
  for (const observer of observers ?? []) {
    try {
      observer.discarded();
    } catch {
      // Notification failure cannot make a discarded preparation publishable.
    }
  }
}
/** A genuine rollback receipt may retain a sealed consumer footprint for its
 * eventual fresh-token publication. This observer grants no write authority. */
export function tryObservePreparedRecordPublication(
  db: Database,
  token: object,
  observer: PreparedPublicationObserver,
): (() => void) | undefined {
  const proof = preparedPublicationTokens.get(token);
  if (!proof) return undefined;
  if (
    proof.db !== db ||
    proof.token !== token ||
    proof.closed ||
    !proof.released ||
    !proof.resultJson ||
    db.isTransaction ||
    state.get(db) !== proof.config
  )
    fail('foreign prepared publication observation');
  const captured = Object.freeze({ published: observer.published, discarded: observer.discarded });
  if (typeof captured.published !== 'function' || typeof captured.discarded !== 'function')
    fail('invalid prepared publication observation');
  const observers = (proof.observers ??= new Set());
  observers.add(captured);
  return () => observers.delete(captured);
}
function closeTransactionPreparationResources(proof: TransactionPreparationData): void {
  if (proof.backingPlan) transactionBackingPlans.delete(proof.backingPlan);
  discardPreparedPublicationObservers(proof);
  let failure: unknown;
  for (const close of [
    () => proof.recipe.close(),
    () => proof.rows.close(),
    () => proof.indexRows?.close(),
    () => proof.stateIndex?.close(),
    () => proof.valueChecks?.close(),
    () => proof.backingRows?.close(),
    () => proof.readOwner && closeRecordReadOwner(proof.readOwner),
    () => proof.staging && discardVaultRecordStaging(proof.staging),
    () =>
      proof.staged?.contributor && closeContributorRecordHeadPublication(proof.staged.contributor),
  ])
    try {
      close();
    } catch (error) {
      failure ??= error;
    }
  if (failure) throw failure;
}
declare const publicationOriginalsBrand: unique symbol;
export interface RecordPublicationOriginals {
  readonly [publicationOriginalsBrand]: true;
}
const publicationOriginals = new WeakMap<
  RecordPublicationOriginals,
  {
    db: Database;
    config: RecordConfig;
    operation: ClinicalOperation;
    expectedHead: string;
    expectedSequence: number;
    scratch: ReturnType<typeof disposableSqlite>;
    artifacts: ReturnType<
      typeof import('./clinical-review-artifact-proof.ts').createClinicalReviewArtifactProof
    >;
    current(additional?: readonly (() => void)[]): void;
    originalSources(additional: readonly (() => void)[]): Iterable<PackageSourceOriginalPhysical>;
  }
>();
/** Copy the genuine parent's complete signed union before child narrowing.
 * This transports original identities, never stats a newer child baseline. */
export async function captureRecordPublicationOriginals(
  db: Database,
  profileId: string,
  original: import('./ownership-report-plan.ts').OwnershipReportOriginalProof,
): Promise<RecordPublicationOriginals> {
  const config = state.get(db),
    operation = currentClinicalOperation(db);
  if (!config || config.profileId !== profileId || !operation || db.isTransaction)
    fail('record publication original parent unavailable');
  const originalState = readStatusRow(db);
  const report = await import('./ownership-report-plan.ts'),
    artifact = await import('./clinical-review-artifact-proof.ts'),
    native = await import('./record-ownership-native.ts'),
    request = await import('./index.ts'),
    assistant = await import('./assistant.ts'),
    session = await import('./intake-package-session.ts'),
    vault = await import('./vault-app.ts');
  assertClinicalOperation(db, operation);
  const assertions = clinicalOperationCallerAssertions(db, operation!),
    authorization = vault.currentVaultCompactAuthorization(db, profileId),
    scratch = disposableSqlite('circus-record-publication-originals-');
  try {
    const artifacts = artifact.createClinicalReviewArtifactProof(scratch.db, 'originals');
    const stamp = Reflect.apply(readmissionPrepare, scratch.db, ['SELECT total_changes() AS n']),
      schema = Reflect.apply(readmissionPrepare, scratch.db, ['PRAGMA main.schema_version']),
      temp = Reflect.apply(readmissionPrepare, scratch.db, ['PRAGMA temp.schema_version']),
      peer = Reflect.apply(readmissionPrepare, scratch.db, ['PRAGMA main.data_version']);
    stamp.setReadBigInts(true);
    const originalSchema = Reflect.apply(readmissionGet, schema, [])!.schema_version,
      originalTemp = Reflect.apply(readmissionGet, temp, [])!.schema_version,
      originalPeer = Reflect.apply(readmissionGet, peer, [])!.data_version;
    let copied = 0;
    const current = (additional: readonly (() => void)[] = []) => {
      assertClinicalOperation(db, operation!);
      if (
        state.get(db) !== config ||
        !db.isOpen ||
        !scratch.db.isOpen ||
        !report.ownershipReportOriginalProofCurrent(original, db, profileId) ||
        Reflect.apply(readmissionGet, stamp, [])!.n !== BigInt(copied) ||
        Reflect.apply(readmissionGet, schema, [])!.schema_version !== originalSchema ||
        Reflect.apply(readmissionGet, temp, [])!.schema_version !== originalTemp ||
        Reflect.apply(readmissionGet, peer, [])!.data_version !== originalPeer ||
        (authorization && !vault.vaultCompactAuthorizationCurrent(authorization, db, profileId))
      )
        fail('record publication original owner changed');
      const visiting = new Set<() => void>();
      const known = (assertion: () => void): boolean => {
        if (visiting.has(assertion)) return false;
        if (native.ownershipPlanAssertionKnown(assertion, db))
          return native.ownershipPlanAssertionCurrent(assertion, db);
        if (request.requestFilenameAssertionCurrent(assertion, db)) return true;
        const inputs =
          assistant.assistantCompactAssertionPrerequisites(assertion, db) ??
          session.packageSessionAssertionPrerequisites(assertion, db);
        if (!inputs) return false;
        visiting.add(assertion);
        try {
          return inputs.every(known);
        } finally {
          visiting.delete(assertion);
        }
      };
      if (!assertions.every(known) || !additional.every(known))
        fail('record publication requires genuine owner assertions');
    };
    const originalSources = function* (
      additional: readonly (() => void)[],
    ): Generator<PackageSourceOriginalPhysical> {
      current(additional);
      const visited = new Set<() => void>();
      function* visit(assertion: () => void): Generator<PackageSourceOriginalPhysical> {
        if (visited.has(assertion)) return;
        visited.add(assertion);
        current(additional);
        const source = session.packageSessionOriginalPhysicalSource(assertion, db);
        if (source) {
          if (source.binding.profileId !== profileId)
            fail('record publication original lease profile differs');
          yield source;
        }
        const inputs =
          assistant.assistantCompactAssertionPrerequisites(assertion, db) ??
          session.packageSessionAssertionPrerequisites(assertion, db);
        if (inputs)
          for (let index = 0; index < inputs.length; index++) yield* visit(inputs[index]!);
      }
      for (const assertion of assertions) yield* visit(assertion);
      for (const assertion of additional) yield* visit(assertion);
      current(additional);
    };
    current();
    for (const row of report.verifiedOwnershipReportOriginalArtifacts(original, db, profileId)) {
      current();
      artifacts.retain([row]);
      if (++copied % 64 === 0) {
        await yieldHost();
        current();
      }
    }
    current();
    const capability = Object.freeze({}) as RecordPublicationOriginals;
    publicationOriginals.set(capability, {
      db,
      config: config!,
      operation: operation!,
      expectedHead: originalState.head_json,
      expectedSequence: originalState.sequence,
      scratch,
      artifacts,
      current,
      originalSources,
    });
    return capability;
  } catch (error) {
    scratch.close();
    throw error;
  }
}
/** Last physical worker on the SAME complete parent union. The record owner
 * still has to close original SQL/HEAD and exact own additions before selection. */
export async function withRecordPublicationOriginals<T>(
  db: Database,
  capability: RecordPublicationOriginals,
  complete: (physicalCurrent: () => void) => T,
): Promise<T> {
  const proof = publicationOriginals.get(capability);
  if (!proof || proof.db !== db || state.get(db) !== proof.config || db.isTransaction)
    fail('foreign record publication originals');
  const operation = currentClinicalOperationReadonly(db);
  if (!operation) fail('record publication original child unavailable');
  const assertions = clinicalOperationCallerAssertions(db, operation!),
    current = () => {
      if (publicationOriginals.get(capability) !== proof)
        fail('record publication original child expired');
      assertClinicalOperation(db, operation);
      proof!.current(assertions);
    };
  current();
  return proof!.artifacts.withVerifiedTerminal({ assertCurrent: current }, complete, 'publication');
}
export function closeRecordPublicationOriginals(capability: RecordPublicationOriginals): void {
  const proof = publicationOriginals.get(capability);
  publicationOriginals.delete(capability);
  proof?.scratch.close();
}
/** Dispatch identity only. An arbitrary transaction operation cannot enroll
 * itself, and this branch can only roll back, never select accepted history. */
export function recordTransactionPreparationRequested(
  db: Database,
  operation: TransactionOperation,
): boolean {
  const proof = preparingTransactions.get(operation);
  if (!proof) return false;
  if (
    proof.db !== db ||
    state.get(db) !== proof.config ||
    proof.closed ||
    managedDatabaseMethodEpoch(db) !== proof.methods ||
    !transactionDurabilityParticipantCurrent(db, recordParticipants.get(db))
  )
    fail('record transaction preparation owner changed');
  return true;
}
export function recordTransactionPreparationCaptured(
  db: Database,
  operation: TransactionOperation,
  token: object,
): boolean {
  const proof = preparingTransactions.get(operation);
  if (!proof) return false;
  if (
    !recordTransactionPreparationRequested(db, operation) ||
    proof.token !== token ||
    !proof.resultJson
  )
    fail('record transaction preparation did not capture its actual token');
  return true;
}

/** Only the literal recipe and fixed application bookkeeping may advance the
 * original SQL counter. No post-callback counter is adopted as a baseline. */
export function recordPreparationBeforeBookkeeping(
  db: Database,
  operation: TransactionOperation,
): void {
  const proof = preparingTransactions.get(operation);
  if (!proof) return;
  if (!recordTransactionPreparationRequested(db, operation) || proof.tentativeStart === undefined)
    fail('record preparatory bookkeeping owner unavailable');
  const total = Reflect.apply(readmissionPrepare, db, ['SELECT total_changes() AS n']);
  total.setReadBigInts(true);
  const business = proof.recipe.writes();
  if (Reflect.apply(readmissionGet, total, []).n !== proof.tentativeStart! + business)
    fail('record preparatory unowned prepublication write');
  const read = Reflect.apply(readmissionPrepare, db, ['SELECT 1 FROM main.app_meta WHERE key=?']),
    captured = Reflect.apply(readmissionPrepare, db, [
      "SELECT 1 FROM temp.__record_changed WHERE entity='app_meta' AND record_id=?",
    ]);
  if (!Reflect.apply(readmissionGet, read, ['revision']))
    fail('record preparatory revision absent');
  const clinicalInsert = !Reflect.apply(readmissionGet, read, ['clinical_review_revision']),
    keys = ['revision', 'curation_revision'];
  if (clinicalInsert || operation.actor !== 'source-text') keys.push('clinical_review_revision');
  let captureWrites = 0n;
  for (const key of keys)
    if (!Reflect.apply(readmissionGet, captured, [stringifyRecordJson([key])])) captureWrites++;
  proof.expectedTentativeWrites =
    business +
    captureWrites +
    2n +
    BigInt(clinicalInsert) +
    BigInt(operation.actor !== 'source-text');
  if (Reflect.apply(readmissionGet, total, []).n !== proof.tentativeStart! + business)
    fail('record preparatory bookkeeping compilation wrote SQL');
}

/** Actual tentative-row execution, including normal observers and bookkeeping.
 * This preparatory receipt is NOT acceptance authority or an operation result;
 * the publication owner still has to authenticate/replay its exact retained
 * rows against original physical evidence using a distinct final token. */
export function prepareRecordTransaction<T>(
  db: Database,
  fn: () => T,
  operation: TransactionOperation,
): RecordTransactionPreparation {
  return prepareTransaction(db, fn, operation);
}

interface TransactionOriginalBacking {
  config: RecordConfig;
  operation: ClinicalOperation;
  methods: object;
  originalState: RecordStateRow;
  readOwner: RecordReadOwner;
  staging: VaultRecordStagingWitness;
  originals: RecordPublicationOriginals;
  total: bigint;
}

/** Capture the actual vault's complete original namespace BEFORE tentative
 * business reads/writes. The parent union remains its own original proof. */
export async function prepareRecordTransactionWithOriginals<T>(
  db: Database,
  fn: () => T,
  operation: TransactionOperation,
  originals: RecordPublicationOriginals,
): Promise<RecordTransactionPreparation> {
  const parent = publicationOriginals.get(originals),
    config = state.get(db),
    owner = currentClinicalOperation(db),
    methods = managedDatabaseMethodEpoch(db);
  if (
    !parent ||
    parent.db !== db ||
    parent.config !== config ||
    !config ||
    !owner ||
    !methods ||
    db.isTransaction ||
    !vaultRecordReadOwnerSupported(config.storage)
  )
    fail('record transaction original backing unavailable');
  const admittedParent = parent!,
    admittedConfig = config!,
    admittedOwner = owner!,
    admittedMethods = methods!,
    assertions = clinicalOperationCallerAssertions(db, admittedOwner);
  admittedParent.current(assertions);
  const readOwner = captureRecordReadOwner(db, admittedConfig.profileId);
  let staging: VaultRecordStagingWitness | undefined,
    prepared: RecordTransactionPreparation | undefined,
    transferred = false;
  try {
    const originalState = { ...readStatusRow(db) },
      epoch = captureManagedPhysicalEpoch();
    if (
      originalState.head_json !== admittedParent.expectedHead ||
      originalState.sequence !== admittedParent.expectedSequence
    )
      fail('record transaction parent accepted continuation changed');
    if (!epoch) fail('record transaction original physical interval unavailable');
    staging = captureVaultRecordStaging(db, admittedConfig.storage, epoch!);
    if (!staging) fail('record transaction original storage unavailable');
    const stamp = Reflect.apply(readmissionPrepare, db, ['SELECT total_changes() AS n']);
    stamp.setReadBigInts(true);
    const total = Reflect.apply(readmissionGet, stamp, []).n as bigint;
    let continuation: TransactionPreparationData | undefined;
    const check = () => {
      assertClinicalOperation(db, admittedOwner);
      admittedParent.current(assertions);
      if (
        publicationOriginals.get(originals) !== parent ||
        state.get(db) !== config ||
        db.isTransaction ||
        managedDatabaseMethodEpoch(db) !== methods ||
        Reflect.apply(readmissionGet, stamp, []).n !== (continuation?.total ?? total)
      )
        fail('record transaction original backing changed');
      if (continuation) {
        const retained = recordReadOwners.get(readOwner);
        if (
          !retained?.vault ||
          !vaultRecordReadOwnerStagingCurrent(admittedConfig.storage, retained.vault, staging!)
        )
          fail('record transaction owned physical continuation changed');
      } else assertRecordReadOwnerInterval(db, readOwner);
    };
    check();
    const originalHead = recordReadOwners.get(readOwner)?.wire;
    if (typeof originalHead !== 'string')
      fail('record transaction original HEAD bytes unavailable');
    await prepareVaultRecordTransactionBacking(staging!, originalHead!, check);
    check();
    const proof = prepareTransaction(db, fn, operation, {
      config: admittedConfig,
      operation: admittedOwner,
      methods: admittedMethods,
      originalState,
      readOwner,
      staging: staging!,
      originals,
      total,
    });
    const captured = transactionPreparations.get(proof);
    prepared = proof;
    if (
      !captured ||
      captured.tentativeStart !== total ||
      captured.expectedTentativeWrites !== captured.tentativeWrites
    )
      fail('record preparatory original write continuation differs');
    continuation = captured;
    check();
    transferred = true;
    return proof;
  } finally {
    if (!transferred) {
      if (prepared) {
        discardRecordTransactionPreparation(db, prepared);
      } else {
        try {
          closeRecordReadOwner(readOwner);
        } finally {
          if (staging) discardVaultRecordStaging(staging);
        }
      }
    }
  }
}

function prepareTransaction<T>(
  db: Database,
  fn: () => T,
  operation: TransactionOperation,
  backing?: TransactionOriginalBacking,
): RecordTransactionPreparation {
  const config = state.get(db),
    clinicalOperation = currentClinicalOperation(db),
    methods = managedDatabaseMethodEpoch(db),
    participant = recordParticipants.get(db);
  if (
    !config ||
    !clinicalOperation ||
    !methods ||
    !participant ||
    !transactionDurabilityParticipantCurrent(db, participant) ||
    db.isTransaction ||
    operation.intakeMaintenance
  )
    fail('record transaction preparation requires an idle genuine record owner');
  if (
    backing &&
    (backing.config !== config ||
      backing.operation !== clinicalOperation ||
      backing.methods !== methods)
  )
    fail('record transaction original backing owner changed');
  const operationJson = stringifyRecordJson(operation),
    selectedOperation = Object.freeze(parseRecordJson<TransactionOperation>(operationJson)),
    operationId = selectedOperation.operationId ?? randomUUID(),
    originalState = backing?.originalState ?? readStatusRow(db),
    rows = createRecordPreparedRows();
  if (typeof operationId !== 'string') {
    rows.close();
    fail('record transaction preparation operation identity');
  }
  let recipe: ReturnType<typeof createRecordMutationRecipe>;
  let readOwner: RecordReadOwner | undefined;
  let staging: VaultRecordStagingWitness | undefined;
  try {
    recipe = createRecordMutationRecipe(db);
    if (backing) {
      readOwner = backing.readOwner;
      staging = backing.staging;
    } else if (recordReadOwnerSupported(db, config!.profileId))
      readOwner = captureRecordReadOwner(db, config!.profileId);
    if (!backing && readOwner && vaultRecordReadOwnerSupported(config!.storage)) {
      const epoch = captureManagedPhysicalEpoch();
      if (!epoch) fail('record transaction preparation physical owner unavailable');
      staging = captureVaultRecordStaging(db, config!.storage, epoch!);
    }
  } catch (error) {
    recipe!?.close();
    if (readOwner) closeRecordReadOwner(readOwner);
    if (staging) discardVaultRecordStaging(staging);
    rows.close();
    throw error;
  }
  const proof: TransactionPreparationData = {
    db,
    config: config!,
    clinicalOperation: clinicalOperation!,
    methods: methods!,
    operation: selectedOperation,
    operationJson,
    originalState: { ...originalState },
    recordedAt: new Date().toISOString(),
    operationId: operationId as string,
    records: 0,
    readOwner,
    staging,
    completeBacking: !!backing,
    originals: backing?.originals,
    rows,
    recipe,
    closed: false,
  };
  preparingTransactions.set(selectedOperation, proof);
  try {
    const start = Reflect.apply(readmissionPrepare, db, ['SELECT total_changes() AS n']);
    start.setReadBigInts(true);
    transaction(
      db,
      () => {
        proof.tentativeStart = Reflect.apply(readmissionGet, start, []).n as bigint;
        return recipe.capture(fn);
      },
      selectedOperation,
    );
    assertClinicalOperation(db, clinicalOperation!);
    const statement = Reflect.apply(readmissionPrepare, db, ['SELECT total_changes() AS n']);
    statement.setReadBigInts(true);
    if (
      !proof.released ||
      !proof.token ||
      !proof.resultJson ||
      db.isTransaction ||
      state.get(db) !== config ||
      managedDatabaseMethodEpoch(db) !== methods ||
      !transactionDurabilityParticipantCurrent(db, participant) ||
      stringifyRecordJson(selectedOperation) !== proof.operationJson ||
      Reflect.apply(readmissionGet, statement, []).n !== proof.total
    )
      fail('record transaction preparation changed during rollback cleanup');
    const capability = Object.freeze({}) as RecordTransactionPreparation;
    transactionPreparations.set(capability, proof);
    return capability;
  } catch (error) {
    proof.closed = true;
    try {
      closeTransactionPreparationResources(proof);
    } catch {
      // Preserve the preparation refusal after trying every owned resource.
    }
    throw error;
  } finally {
    preparingTransactions.delete(selectedOperation);
  }
}
export function discardRecordTransactionPreparation(
  db: Database,
  capability: RecordTransactionPreparation,
): void {
  const proof = transactionPreparations.get(capability);
  if (!proof || proof.db !== db) fail('foreign record transaction preparation');
  transactionPreparations.delete(capability);
  proof!.closed = true;
  closeTransactionPreparationResources(proof!);
}
/** Authenticate changed keys in one newest-first accepted-history walk. The
 * private result remains bound to the original preparatory receipt; matching
 * disposable version rows never supply their own predecessor authority. */
export async function authenticateRecordTransactionPreparation(
  db: Database,
  capability: RecordTransactionPreparation,
): Promise<void> {
  const proof = transactionPreparations.get(capability);
  if (!proof || proof.db !== db || !proof.readOwner || proof.authenticated)
    fail('record publication predecessor owner unavailable');
  const selected = proof!,
    priors = createRecordPreparedPriors(),
    total = Reflect.apply(readmissionPrepare, db, ['SELECT total_changes() AS n']);
  total.setReadBigInts(true);
  const check = () => {
    assertClinicalOperation(db, selected.clinicalOperation);
    if (
      transactionPreparations.get(capability) !== selected ||
      selected.closed ||
      !selected.released ||
      !selected.token ||
      !selected.resultJson ||
      db.isTransaction ||
      state.get(db) !== selected.config ||
      managedDatabaseMethodEpoch(db) !== selected.methods ||
      !transactionDurabilityParticipantCurrent(db, recordParticipants.get(db)) ||
      stringifyRecordJson(selected.operation) !== selected.operationJson ||
      Reflect.apply(readmissionGet, total, []).n !== selected.total
    )
      fail('record publication predecessor preparation changed');
    assertRecordReadOwnerInterval(db, selected.readOwner!);
  };
  let pending = 0,
    absence = false;
  try {
    check();
    assertRecordReadOwnerBeforeVerification(db, selected.readOwner!);
    check();
    for (const raw of selected.rows.values()) {
      check();
      const version = await parsePreparedRecordVersion(raw, check),
        previous = current(db, version.entity, version.recordId);
      check();
      if ((previous?.version_id ?? null) !== version.previousVersion)
        fail('record publication cached predecessor changed');
      if (selected.completeBacking) {
        if (!selected.staging) fail('record publication complete backing unavailable');
        // Vault certificates use the quoted JSON-string codec. The portable
        // ancestry index below deliberately uses raw document bytes instead.
        const preimage = previous
          ? await recordStringFieldDigest(previous.contents_json, check)
          : null;
        assertVaultRecordTransactionPrior(
          selected.staging!,
          version.entity,
          version.recordId,
          version.previousVersion,
          previous ? { deleted: !!previous.deleted, preimage: preimage! } : null,
        );
        check();
        await yieldHost();
        check();
        continue;
      }
      const preimage = previous
        ? await digestRecordPieces(rawRecordPieces(previous.contents_json), check)
        : null;
      priors.append({
        entity: version.entity,
        recordId: version.recordId,
        previousVersion: version.previousVersion,
        deleted: !!previous?.deleted,
        preimage,
      });
      if (previous) pending++;
      else absence = true;
    }
    if (selected.completeBacking) {
      check();
      selected.authenticated = true;
      return;
    }
    priors.seal();
    let reference = parseRecordJson<RecordObjectReference>(selected.originalState.head_json),
      sequence = selected.originalState.sequence;
    while (reference) {
      check();
      const commit = readCommit(
        selected.config.storage,
        reference,
        selected.config.profileId,
        selected.config.schemaVersion,
      );
      check();
      if (commit.sequence !== sequence--)
        fail('record publication accepted predecessor sequence changed');
      const segments = function* () {
        for (const ref of iterateRecordCommitSegments(selected.config.storage, commit)) {
          check();
          const bytes = readObject(selected.config.storage, ref);
          check();
          yield bytes;
        }
      };
      const identities = versionIdentityIndex(),
        steps = readRecordJsonLinesSteps(segments(), { parseSmall: parseRecordJson });
      let count = 0;
      try {
        for (;;) {
          check();
          const next = steps.next();
          check();
          if (next.done) break;
          if (next.value) {
            const version = next.value.record as DurableRecordVersion,
              shape = selected.config.schema.find((table) => table.name === version?.entity);
            if (
              !shape ||
              version.format !== FORMAT ||
              version.profileId !== selected.config.profileId ||
              version.schemaVersion !== selected.config.schemaVersion ||
              version.sequence !== commit.sequence ||
              version.operationId !== commit.operationId ||
              version.recordedAt !== commit.recordedAt ||
              !/^[0-9a-f-]{36}$/.test(version.versionId) ||
              typeof version.deleted !== 'boolean' ||
              !version.contents ||
              typeof version.contents !== 'object' ||
              Array.isArray(version.contents) ||
              !eq(Object.keys(version.contents).sort(), [...shape.columns].sort()) ||
              identity(shape, version.contents) !== version.recordId ||
              (shape.name === 'app_meta' && internalKey(version.contents.key as string))
            )
              fail('invalid complete accepted publication predecessor record');
            const key = stringifyRecordJson([version.entity, version.recordId]);
            if (identities.has(key)) fail('duplicate accepted publication predecessor record');
            identities.add(key);
            count++;
            const expected = priors.find(version.entity, version.recordId);
            if (expected && !expected.matched) {
              const preimage = await digestRecordPieces(
                sourcePreimagePieces(version.contents),
                check,
              );
              priors.match(version.entity, version.recordId, {
                versionId: version.versionId,
                deleted: version.deleted,
                preimage,
              });
              pending--;
            }
          }
          await yieldHost();
          check();
        }
      } finally {
        try {
          steps.return(undefined);
        } finally {
          identities.close();
        }
      }
      if (count !== commit.records) fail('partial accepted publication predecessor transaction');
      reference = commit.previous!;
      if (!pending && !absence) break;
      await yieldHost();
      check();
    }
    if (!reference && sequence !== 0) fail('record publication predecessor root sequence changed');
    priors.finish({ reachedRoot: !reference });
    check();
    selected.authenticated = true;
  } finally {
    priors.close();
  }
}
/** Stage the immutable intent without a main SQL transaction or accepted HEAD.
 * Only the final private replay may consume this plan after original workers. */
function recordPreparedValueCheckSql(table: TableSchema, deleted: boolean): string {
  const columns = deleted ? table.pk : table.columns;
  return `SELECT 1 FROM main.${q(table.name)} WHERE ${columns.map((column) => q(column) + ' IS ?').join(' AND ')}`;
}
export async function stageRecordTransactionPreparation(
  db: Database,
  capability: RecordTransactionPreparation,
): Promise<void> {
  const found = transactionPreparations.get(capability);
  if (
    !found ||
    found.db !== db ||
    !found.authenticated ||
    !found.completeBacking ||
    found.stagingStarted
  )
    fail('record publication immutable preparation unavailable');
  const proof = found!,
    staging = proof.staging,
    readOwner = proof.readOwner && recordReadOwners.get(proof.readOwner),
    parent = proof.originals && publicationOriginals.get(proof.originals);
  if (!staging || !readOwner?.vault || !parent || proof.revision === undefined)
    fail('record publication immutable original owner unavailable');
  const stamp = Reflect.apply(readmissionPrepare, db, ['SELECT total_changes() AS n']);
  stamp.setReadBigInts(true);
  const assertions = clinicalOperationCallerAssertions(db, proof.clinicalOperation);
  const check = () => {
    assertClinicalOperation(db, proof.clinicalOperation);
    parent!.current(assertions);
    const read = ownDescriptor(proof.config.storage, 'read');
    if (
      transactionPreparations.get(capability) !== proof ||
      publicationOriginals.get(proof.originals!) !== parent ||
      proof.closed ||
      !proof.released ||
      !proof.authenticated ||
      !proof.token ||
      !proof.resultJson ||
      db.isTransaction ||
      state.get(db) !== proof.config ||
      managedDatabaseMethodEpoch(db) !== proof.methods ||
      !transactionDurabilityParticipantCurrent(db, recordParticipants.get(db)) ||
      stringifyRecordJson(proof.operation) !== proof.operationJson ||
      Reflect.apply(readmissionGet, stamp, []).n !== proof.total ||
      parent!.expectedHead !== proof.originalState.head_json ||
      parent!.expectedSequence !== proof.originalState.sequence ||
      !read ||
      !('value' in read) ||
      read.value !== readOwner!.read ||
      !vaultRecordReadOwnerStagingCurrent(proof.config.storage, readOwner!.vault!, staging!)
    )
      fail('record publication immutable original continuation changed');
  };
  check();
  proof.stagingStarted = true;
  const sequence = proof.originalState.sequence + 1,
    operationId = proof.operationId;
  let segmentHead: RecordObjectReference | null = null,
    segmentCount = 0,
    count = 0,
    page: RecordObjectReference[] = [],
    chunks: Buffer[] = [],
    size = 0;
  const stage = async (bytes: Buffer) => {
    check();
    const ref = { name: 'objects/' + randomUUID(), sha256: digest(bytes), bytes: bytes.length };
    stageVaultRecordObject(staging!, ref, bytes);
    await yieldHost();
    check();
    return ref;
  };
  const flushPage = async () => {
    if (!page.length) return;
    const value: RecordSegmentPage = {
      format: 'health-record-segment-page-v1',
      profileId: proof.config.profileId,
      schemaVersion: proof.config.schemaVersion,
      sequence,
      operationId,
      previous: segmentHead,
      firstSegment: segmentCount - page.length,
      segments: page,
    };
    const bytes = encode(value);
    if (bytes.length > SEGMENT_PAGE_BYTES) fail('prepared segment page exceeds controlled format');
    segmentHead = await stage(bytes);
    page = [];
    recordVersionWork('segmentIndexPagesWritten');
  };
  const flush = async () => {
    if (!size) return;
    page.push(await stage(Buffer.concat(chunks, size)));
    chunks = [];
    size = 0;
    segmentCount++;
    recordVersionWorkMaximum('maxSegmentReferencesBuffered', page.length);
    if (page.length === SEGMENT_REFERENCE_WINDOW) await flushPage();
  };
  for (const raw of proof.rows.values()) {
    check();
    // The signed row already contains the frozen version ID and metadata.
    // Encode bounded UTF-8 pieces rather than another complete version buffer.
    for (const piece of (function* () {
      yield* rawRecordPieces(raw);
      yield '\n';
    })()) {
      const bytes = Buffer.from(piece);
      for (let offset = 0; offset < bytes.length;) {
        const take = Math.min(proof.config.segmentBytes - size, bytes.length - offset);
        chunks.push(bytes.subarray(offset, offset + take));
        size += take;
        offset += take;
        if (size === proof.config.segmentBytes) await flush();
      }
      await yieldHost();
      check();
    }
    count++;
  }
  if (count !== proof.records) fail('prepared immutable version count changed');
  await flush();
  await flushPage();
  const commit: RecordCommitV2 = {
    format: COMMIT_FORMAT,
    profileId: proof.config.profileId,
    schemaVersion: proof.config.schemaVersion,
    sequence,
    revision: proof.revision!,
    previous: parseRecordJson<RecordObjectReference>(proof.originalState.head_json),
    operationId,
    fingerprint: proof.operation.fingerprint ?? null,
    result: parseRecordJson(proof.resultJson!),
    recordedAt: proof.recordedAt,
    segments: { format: 'health-record-segment-index-v1', head: segmentHead, count: segmentCount },
    records: count,
  };
  const ref = await stage(encode(commit));
  check();
  const indexRows = createRecordPreparedIndex(db, { assertRunning: check }),
    stateIndex = createRecordPreparedIndex(db, { assertRunning: check }),
    valueChecks = createRecordPreparedIndex(db, { assertRunning: check }),
    backingRows = createRecordPreparedIndex(db, { assertRunning: check }),
    identities = versionIdentityIndex(),
    bookkeeping: RecordBookkeeping = {
      writes: 0n,
      metadataKeys: new Set(),
      metadataOnly: true,
    };
  proof.indexRows = indexRows;
  proof.stateIndex = stateIndex;
  proof.valueChecks = valueChecks;
  proof.backingRows = backingRows;
  let indexWrites = 0n;
  const retainIndex = async (
    sql: string,
    args: SQLInputValue[],
    changes: number,
    bookkeep = true,
  ) => {
    check();
    await (bookkeep ? indexRows : stateIndex).append(sql, args, changes);
    check();
    indexWrites += BigInt(changes);
    if (bookkeep) bookkeeping.writes += BigInt(changes);
  };
  try {
    for (const raw of proof.rows.values()) {
      check();
      const version = await parsePreparedRecordVersion(raw, check),
        previous = validateVersion(db, proof.config, commit, version, identities),
        { contents, ...metadata } = version,
        contentsJson = await stringifyPreparedRecordContents(contents, check);
      await backingRows.append(
        'SELECT ?,?,?,?,?,?',
        [
          version.entity,
          version.recordId,
          version.versionId,
          Number(version.deleted),
          version.previousVersion,
          contentsJson,
        ],
        0,
      );
      check();
      const table = proof.config.schema.find((item) => item.name === version.entity);
      if (!table) fail('prepared changed-row entity unavailable');
      const columns = version.deleted ? table!.pk : table!.columns,
        args = version.deleted
          ? parseRecordJson<SQLInputValue[]>(version.recordId)
          : columns.map((column) => contents[column] as SQLInputValue);
      await valueChecks.appendCheck(
        recordPreparedValueCheckSql(table!, version.deleted),
        args,
        !version.deleted,
      );
      check();
      await retainIndex(
        'INSERT INTO __record_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [
          version.versionId,
          proof.config.profileId,
          version.entity,
          version.recordId,
          version.sequence,
          version.recordedAt,
          version.previousVersion,
          version.operationId,
          Number(version.deleted),
          contentsJson,
          stringifyRecordJson(metadata),
        ],
        1,
      );
      await retainIndex(
        'INSERT INTO __record_current VALUES(?,?,?) ON CONFLICT(entity,record_id) DO UPDATE SET version_id=excluded.version_id',
        [version.entity, version.recordId, version.versionId],
        1,
      );
      if (version.entity === 'app_meta' && bookkeeping.metadataKeys.size < 4100)
        bookkeeping.metadataKeys.add(contents.key as string);
      else bookkeeping.metadataOnly = false;
      if (!implicitInitialMetadataFields(version)) {
        const fields: SQLInputValue[] = [];
        const flushFields = async () => {
          if (!fields.length) return;
          const count = fields.length / 9;
          await retainIndex(
            'INSERT INTO __record_fields VALUES' +
              Array(count).fill('(?,?,?,?,?,?,?,?,?)').join(','),
            [...fields],
            count,
          );
          fields.length = 0;
        };
        const retainField = async (field: string, before: boolean, after: boolean) => {
          fields.push(
            version.versionId,
            proof.config.profileId,
            version.entity,
            version.recordId,
            field,
            version.sequence,
            previous?.version_id ?? null,
            Number(before),
            Number(after),
          );
          if (fields.length === 32 * 9) await flushFields();
        };
        if (
          version.entity === 'source_files' &&
          (contentsJson.length > 65536 || (previous?.contents_json.length ?? 0) > 65536)
        ) {
          const before = await prepareRecordPriorFields(
            [previous && !previous.deleted ? previous.contents_json : '{}'],
            check,
          );
          let after: PreparedRecordPriorFields | undefined;
          try {
            after = await prepareRecordPriorFields([version.deleted ? '{}' : contentsJson], check);
            const retain = async (field: string) => {
              check();
              const old = before.get(field),
                next = after!.get(field);
              if (old?.hash !== next?.hash || old?.bytes !== next?.bytes)
                await retainField(field, old !== undefined, next !== undefined);
            };
            for (const field of before.fields()) {
              await retain(field);
              await yieldHost();
            }
            for (const field of after.fields()) {
              if (before.get(field) === undefined) await retain(field);
              await yieldHost();
            }
          } finally {
            try {
              before.close();
            } finally {
              after?.close();
            }
          }
        } else {
          const before = values(
              previous && !previous.deleted ? parseRecordJson(previous.contents_json) : null,
            ),
            after = values(version.deleted ? null : contents);
          for (const field of (function* () {
            yield* before.keys();
            for (const field of after.keys()) if (!before.has(field)) yield field;
          })()) {
            if (before.get(field) !== after.get(field))
              await retainField(field, before.has(field), after.has(field));
            await yieldHost();
            check();
          }
        }
        await flushFields();
      }
      await yieldHost();
      check();
    }
    await retainIndex(
      'INSERT INTO __record_transactions VALUES(?,?,?,?,?)',
      [
        commit.operationId,
        commit.sequence,
        commit.fingerprint as SQLInputValue,
        stringifyRecordJson(commit.result),
        stringifyRecordJson(commit),
      ],
      1,
    );
    await retainIndex(
      'INSERT OR REPLACE INTO __record_state VALUES(1,?,?,?,?,?)',
      [
        proof.config.profileId,
        PROJECTION,
        proof.config.schemaVersion,
        commit.sequence,
        stringifyRecordJson(ref),
      ],
      1,
      false,
    );
    await valueChecks.seal();
    await backingRows.seal();
    check();
    await indexRows.seal();
    check();
    await stateIndex.seal();
    check();
  } finally {
    identities.close();
  }
  proof.indexBookkeeping = bookkeeping;
  proof.indexWrites = indexWrites;
  proof.staged = { ref, commit };
  const backingPlan = Object.freeze({}) as RecordTransactionBackingPlan;
  transactionBackingPlans.set(backingPlan, {
    proof,
    witness: staging!,
    head: encode(ref).toString('utf8'),
  });
  proof.backingPlan = backingPlan;
}
/** Actual-vault finalization of one frozen preparatory intent. Ordinary public
 * transactions are unchanged; portable staging is a separate owner variant. */
export async function commitRecordTransactionPreparation<T>(
  db: Database,
  capability: RecordTransactionPreparation,
): Promise<T> {
  const proof = transactionPreparations.get(capability),
    parent = proof?.originals && publicationOriginals.get(proof.originals);
  if (
    !proof ||
    !parent ||
    !proof.staging ||
    !proof.staged ||
    !proof.indexRows ||
    !proof.stateIndex ||
    !proof.valueChecks ||
    !proof.terminal ||
    proof.tentativeWrites === undefined ||
    proof.captureRows === undefined ||
    !proof.authenticated ||
    proof.closed ||
    !proof.token ||
    !proof.resultJson
  )
    fail('record final publication preparation unavailable');
  const admitted = proof!,
    originals = parent!,
    staging = admitted.staging!,
    plan = admitted.staged!,
    statements = admitted.terminal!,
    rows = admitted.indexRows!,
    valueChecks = admitted.valueChecks!,
    stateIndex = admitted.stateIndex!,
    assertions = clinicalOperationCallerAssertions(db, admitted.clinicalOperation),
    replay = prepareRecordReplay(db, admitted.token!),
    capture = prepareIntakeFrontierCaptureClear(db),
    stamp = Reflect.apply(readmissionPrepare, db, ['SELECT total_changes() AS n']);
  stamp.setReadBigInts(true);
  const check = () => {
    assertClinicalOperation(db, admitted.clinicalOperation);
    originals.current(assertions);
    if (
      transactionPreparations.get(capability) !== admitted ||
      admitted.closed ||
      publicationOriginals.get(admitted.originals!) !== originals ||
      state.get(db) !== admitted.config ||
      !recordReplayCurrent(db, replay) ||
      Reflect.apply(readmissionGet, stamp, []).n !== admitted.total ||
      originals.expectedHead !== admitted.originalState.head_json ||
      originals.expectedSequence !== admitted.originalState.sequence ||
      !vaultRecordStagingCurrent(staging)
    )
      fail('record final publication original continuation changed');
  };
  check();
  const preparedResult = parseRecordJson<T>(admitted.resultJson!);
  check();
  await admitted.recipe.prepareReplay();
  check();
  // Every caller/policy compilation effect has completed. Both workers retain
  // their ORIGINAL rosters, including exact owned immutable additions.
  // This preliminary source pass retains the existing original proof; the
  // combined final worker below closes sources AND immutable objects together.
  await withRecordPublicationOriginals(db, admitted.originals!, (physicalCurrent) => {
    physicalCurrent();
    check();
  });
  check();
  let result: T | undefined;
  const execution = Object.freeze({}) as RecordTransactionTerminalExecution;
  try {
    transactionTerminalExecutions.set(execution, {
      db,
      witness: staging,
      plan: admitted.backingPlan!,
      used: false,
      complete: () => {
        check();
        return withTerminalStatements(db, statements, () =>
          executeRecordReplay(db, replay, (token) => {
            const total = () =>
              terminalStatement(db, 'SELECT total_changes() AS n', undefined, true).get()!
                .n as bigint;
            const start = total();
            if (
              terminalStatement(db, 'SELECT 1 FROM temp.__record_changed LIMIT 1').get() ||
              clearIntakeFrontierRecordCapture(db, capture) !== 0
            )
              fail('record replay began with unowned captured rows');
            bindVaultRecordStagingTransaction(staging);
            replayTerminalRecordMutations(db, admitted.recipe);
            const metaWrite = (key: string, kinds: Array<'insert' | 'update'>, run: () => void) => {
              const expected = expectIntakeFrontierMetaWrite(db, key, kinds);
              let succeeded = false;
              try {
                run();
                succeeded = true;
              } finally {
                finishIntakeFrontierMetaWrite(db, expected, succeeded);
              }
            };
            const clinical = expectIntakeFrontierMetaWrite(db, 'clinical_review_revision', [
              'insert',
            ]);
            let inserted = false;
            try {
              inserted =
                terminalStatement(
                  db,
                  "INSERT OR IGNORE INTO app_meta(key,value) VALUES('clinical_review_revision',(SELECT value FROM app_meta WHERE key='revision'))",
                ).run().changes === 1;
            } finally {
              finishIntakeFrontierMetaWrite(db, clinical, inserted);
            }
            if (admitted.operation.actor !== 'source-text')
              metaWrite('clinical_review_revision', ['update'], () =>
                terminalExecution(
                  db,
                  "UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='clinical_review_revision'",
                ),
              );
            metaWrite('revision', ['update'], () =>
              terminalExecution(
                db,
                "UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'",
              ),
            );
            metaWrite('curation_revision', ['insert', 'update'], () => {
              if (
                terminalStatement(
                  db,
                  "INSERT INTO app_meta(key,value) VALUES('curation_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                ).run(String(admitted.revision)).changes !== 1
              )
                fail('record replay curation write differs');
            });
            if (total() - start !== admitted.tentativeWrites)
              fail('record replay tentative writes differ');
            // The same literal trigger recipe must recreate every frozen changed
            // value; no business function or UUID generator is called a second time.
            replayTerminalPreparedRecordIndex(db, valueChecks);
            replayTerminalPreparedRecordIndex(db, rows);
            const stateWrite = expectIntakeFrontierStateWrite(db);
            let wroteState = false;
            try {
              replayTerminalPreparedRecordIndex(db, stateIndex);
              wroteState = true;
            } finally {
              finishIntakeFrontierMetaWrite(db, stateWrite, wroteState);
            }
            if (total() - start !== admitted.tentativeWrites! + admitted.indexWrites!)
              fail('record replay indexed interval differs');
            if (
              BigInt(clearIntakeFrontierRecordCapture(db, capture)) !==
              BigInt(admitted.captureRows!)
            )
              fail('record replay captured membership differs');
            assertClinicalOperation(db, admitted.clinicalOperation);
            originals.current(assertions);
            if (
              state.get(db) !== admitted.config ||
              currentTransactionToken(db) !== token ||
              !vaultRecordStagingCurrent(staging)
            )
              fail('record replay final owner changed');
            prepareVaultRecordHead(staging);
            markSelectionAttempt(db);
            installVaultRecordHead(staging, encode(plan.ref));
            return preparedResult;
          }),
        );
      },
    });
    result = (await finishVaultRecordTransactionPreparation(
      staging,
      admitted.backingPlan!,
      execution,
    )) as T;
  } finally {
    transactionTerminalExecutions.delete(execution);
    // The real final outcome is observable only after the finite scope expires.
    // A failed selection retains existing uncertain-durability semantics.
    const outcome = notifyRecordReplay(db, replay);
    if (outcome?.committed && outcome.succeeded) {
      originals.expectedHead = stringifyRecordJson(plan.ref);
      originals.expectedSequence = plan.commit.sequence;
      const observers = admitted.observers;
      admitted.observers = undefined;
      preparedPublicationTokens.delete(admitted.token!);
      for (const observer of observers ?? []) {
        try {
          observer.published(outcome);
        } catch {
          /* notification only */
        }
      }
    }
  }
  return result as T;
}
const selectionAttempts = new WeakSet<object>();
/** Cleanup disposition only: an attempted selection cannot be called a
 * prepublication refusal, even when a later SQL COMMIT or participant fails. */
export function recordTerminalSelectionAttempted(token: object): boolean {
  return selectionAttempts.has(token);
}
function markSelectionAttempt(db: Database): void {
  const token = currentTransactionToken(db);
  if (token) selectionAttempts.add(token);
}
/** Only this attached record owner's frozen lexical hooks qualify. */
export function recordTerminalDurabilityParticipant(db: Database, participant: unknown): boolean {
  return state.has(db) && recordParticipants.get(db) === participant;
}
const fail = (message: string): never => {
  throw new Error('Record journal: ' + message);
};
const eq = (a: unknown, b: unknown): boolean => stringifyRecordJson(a) === stringifyRecordJson(b);
const internalKey = (key: string): boolean =>
  (key.startsWith('personal_') && !/^personal_(restore|assistant)_/.test(key)) ||
  key === 'curation_revision';
const meta = (db: Database, key: string): SQLOutputValue | undefined =>
  terminalStatement(db, 'SELECT value FROM app_meta WHERE key=?').get(key)?.value;
function tables(db: Database): TableSchema[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name",
      )
      .all() as Array<SqliteRow & { name: string }>
  ).map(({ name }) => {
    const columns = db.prepare(`PRAGMA table_info(${q(name)})`).all() as Array<
      SqliteRow & { name: string; pk: number }
    >;
    const pk = columns
      .filter((c) => c.pk)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    if (!pk.length) fail('table has no stable identity');
    return { name, columns: columns.map((c) => c.name), pk };
  });
}
function setupAssociationIndexes(db: Database): void {
  const definitions = [
    [
      '__record_link_owner',
      "CREATE INDEX __record_link_owner ON __record_versions(profile_id,entity,json_extract(contents_json,'$.note_id'),sequence DESC) WHERE entity='note_links'",
    ],
    [
      '__record_attachment_owner',
      "CREATE INDEX __record_attachment_owner ON __record_versions(profile_id,entity,json_extract(contents_json,'$.owner_type'),json_extract(contents_json,'$.owner_id'),sequence DESC) WHERE entity='attachments'",
    ],
  ] as const;
  const changed = definitions.filter(
    ([name, sql]) =>
      db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='index' AND name=?").get(name)
        ?.sql !== sql,
  );
  if (!changed.length) return;
  // Upgrade only disposable indexes; accepted objects and projected rows stay intact.
  db.exec('SAVEPOINT record_association_indexes');
  try {
    for (const [name, sql] of changed) {
      db.exec(`DROP INDEX IF EXISTS main.${q(name)}`);
      db.exec(sql);
    }
    db.exec('RELEASE record_association_indexes');
  } catch (error) {
    db.exec('ROLLBACK TO record_association_indexes; RELEASE record_association_indexes');
    throw error;
  }
}
function setup(db: Database): void {
  const saved = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__record_state'")
    .get();
  if (saved) {
    const row = db.prepare('SELECT projection FROM __record_state WHERE singleton=1').get();
    if (row && row.projection !== PROJECTION)
      fail('unsupported or incomplete history projection; rebuild cache');
    for (const [table, columns] of [
      [
        '__record_versions',
        'version_id,profile_id,entity,record_id,sequence,recorded_at,previous_version,operation_id,deleted,contents_json,metadata_json',
      ],
      [
        '__record_fields',
        'version_id,profile_id,entity,record_id,field,sequence,before_version,before_present,after_present',
      ],
    ]) {
      if (
        db
          .prepare(`PRAGMA table_info(${q(table)})`)
          .all()
          .map((column) => column.name)
          .join(',') !== columns
      )
        fail('invalid history projection schema; rebuild cache');
    }
    if (!row) {
      for (const table of [
        '__record_state',
        '__record_versions',
        '__record_fields',
        '__record_transactions',
        '__record_current',
      ]) {
        if (db.prepare(`SELECT count(*) AS count FROM ${q(table)}`).get()?.count !== 0)
          fail('incomplete populated history projection; rebuild cache');
      }
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS __record_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), profile_id TEXT NOT NULL, projection INTEGER NOT NULL, schema_version INTEGER NOT NULL, sequence INTEGER NOT NULL, head_json TEXT);
    CREATE TABLE IF NOT EXISTS __record_transactions (operation_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, fingerprint TEXT, result_json TEXT NOT NULL, commit_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS __record_versions (version_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, entity TEXT NOT NULL, record_id TEXT NOT NULL, sequence INTEGER NOT NULL, recorded_at TEXT NOT NULL, previous_version TEXT, operation_id TEXT NOT NULL, deleted INTEGER NOT NULL, contents_json TEXT NOT NULL, metadata_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS __record_history ON __record_versions(profile_id,entity,record_id,sequence DESC);
    CREATE INDEX IF NOT EXISTS __record_time ON __record_versions(profile_id,recorded_at,sequence);
    CREATE TABLE IF NOT EXISTS __record_current (entity TEXT NOT NULL, record_id TEXT NOT NULL, version_id TEXT NOT NULL, PRIMARY KEY(entity,record_id));
    CREATE TABLE IF NOT EXISTS __record_fields (version_id TEXT NOT NULL, profile_id TEXT NOT NULL, entity TEXT NOT NULL, record_id TEXT NOT NULL, field TEXT NOT NULL, sequence INTEGER NOT NULL, before_version TEXT, before_present INTEGER NOT NULL, after_present INTEGER NOT NULL, PRIMARY KEY(version_id,field));
    CREATE INDEX IF NOT EXISTS __record_field_history ON __record_fields(profile_id,entity,record_id,field,sequence DESC);
    CREATE TEMP TABLE IF NOT EXISTS __record_changed (entity TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(entity,record_id));
  `);
  setupAssociationIndexes(db);
}
function captureTriggers(db: Database, schema: TableSchema[]): void {
  for (const table of schema) {
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      const refs = op === 'UPDATE' ? ['OLD', 'NEW'] : [op === 'DELETE' ? 'OLD' : 'NEW'];
      // An outer UPSERT can override a trigger's OR IGNORE policy. Avoid the
      // conflict entirely so old/new identities and repeated updates coalesce.
      const statements = refs
        .map((ref) => {
          const id = `json_array(${table.pk.map((key) => `${ref}.${q(key)}`).join(',')})`;
          return `INSERT INTO __record_changed SELECT ${literal(table.name)},${id} WHERE NOT EXISTS(SELECT 1 FROM __record_changed WHERE entity=${literal(table.name)} AND record_id=${id});`;
        })
        .join('');
      db.exec(
        `CREATE TEMP TRIGGER IF NOT EXISTS ${q('__record_capture_' + table.name + '_' + op)} AFTER ${op} ON main.${q(table.name)} BEGIN ${statements} END`,
      );
    }
  }
}
function validStorage(storage: unknown): asserts storage is RecordStorage {
  for (const method of ['read', 'writeImmutable', 'publishHead'])
    if (
      typeof (storage as Partial<RecordStorage> | null)?.[method as keyof RecordStorage] !==
      'function'
    )
      fail('storage requires ' + method);
}
function refValid(ref: unknown): ref is RecordObjectReference {
  return (ref &&
    /^objects\/[0-9a-f-]{36}$/.test((ref as Partial<RecordObjectReference>).name as string) &&
    /^[0-9a-f]{64}$/.test((ref as Partial<RecordObjectReference>).sha256 as string) &&
    Number.isSafeInteger((ref as Partial<RecordObjectReference>).bytes) &&
    ((ref as Partial<RecordObjectReference>).bytes as number) > 0) as boolean;
}
function readObject(storage: RecordStorage, ref: unknown): Buffer {
  if (!refValid(ref)) fail('invalid object reference');
  recordVersionWork('objectReadCalls');
  const bytes = storage.read((ref as RecordObjectReference).name);
  if (Buffer.isBuffer(bytes)) recordVersionWork('objectReadBytes', bytes.length);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== (ref as RecordObjectReference).bytes ||
    digest(bytes) !== (ref as RecordObjectReference).sha256
  )
    fail('missing, partial or corrupt committed object');
  return bytes as Buffer;
}
function readHead(
  storage: RecordStorage,
  read: RecordStorage['read'] = storage.read,
): RecordObjectReference | null {
  return readHeadBinding(storage, read).head;
}
function readHeadBinding(
  storage: RecordStorage,
  read: RecordStorage['read'],
): { head: RecordObjectReference | null; wire: string | null } {
  recordVersionWork('headReadCalls');
  const bytes = Reflect.apply(read, storage, ['head']);
  if (Buffer.isBuffer(bytes)) recordVersionWork('headReadBytes', bytes.length);
  if (bytes === null || bytes === undefined) return { head: null, wire: null };
  const ref = parseRecordJson(bytes as unknown as string) as unknown;
  if (!refValid(ref)) fail('invalid head');
  if (!Buffer.isBuffer(bytes)) fail('record HEAD must be original bytes');
  return { head: ref as RecordObjectReference, wire: bytes.toString('utf8') };
}
function readConfiguredHead(db: Database, config: RecordConfig): RecordObjectReference | null {
  const terminal = activeCompactTerminal.get(db),
    authority = terminal && authorityWitnesses.get(terminal.prior.authority);
  if (!terminalStatementsActive(db)) return readHead(config.storage);
  if (
    !authority?.staging ||
    authority.config !== config ||
    !recordAuthorityWitnessIntervalCurrent(db, terminal!.prior.authority)
  )
    fail('compact accepted head owner changed');
  // Only the registered actual-vault staging owner reaches this branch. Its
  // captured original head reader is lexical manifest memory, not an adapter callback.
  return readHead(config.storage, authority!.read);
}
function writeObject(
  storage: RecordStorage,
  bytes: Buffer,
  prior?: SourcePriorData,
): RecordObjectReference {
  const ref = { name: 'objects/' + randomUUID(), sha256: digest(bytes), bytes: bytes.length };
  const staging = prior && authorityWitnesses.get(prior.authority)?.staging;
  if (staging) {
    prior!.assertCurrent();
    stageVaultRecordObject(staging, ref, bytes);
  } else storage.writeImmutable(ref.name, bytes);
  readObject(storage, ref); // Verify staged bytes before publishing acceptance.
  return ref;
}

function readCommit(
  storage: RecordStorage,
  ref: RecordObjectReference,
  profileId: string,
  schemaVersion: number,
): RecordCommit {
  const commit = parseRecordJson(readObject(storage, ref) as unknown as string) as RecordCommit;
  recordVersionWork('commitValidations');
  if (
    (commit.format !== FORMAT && commit.format !== COMMIT_FORMAT) ||
    commit.profileId !== profileId ||
    commit.schemaVersion !== schemaVersion ||
    !Number.isSafeInteger(commit.sequence) ||
    commit.sequence < 1 ||
    (commit.format === FORMAT
      ? !Array.isArray(commit.segments)
      : !segmentIndexValid(commit.segments)) ||
    !Number.isSafeInteger(commit.records) ||
    commit.records < 0 ||
    !Number.isSafeInteger(commit.revision) ||
    commit.revision < 0 ||
    typeof commit.operationId !== 'string' ||
    !commit.operationId ||
    !Number.isFinite(Date.parse(commit.recordedAt))
  )
    fail('unsupported or wrong-profile commit');
  if (commit.previous !== null && !refValid(commit.previous)) fail('invalid commit ancestry');
  return commit;
}

function segmentIndexValid(value: unknown): value is RecordSegmentIndex {
  if (!value || typeof value !== 'object') return false;
  const index = value as RecordSegmentIndex;
  return (
    Object.keys(index).sort().join(',') === 'count,format,head' &&
    index.format === 'health-record-segment-index-v1' &&
    Number.isSafeInteger(index.count) &&
    index.count >= 0 &&
    (index.count === 0 ? index.head === null : refValid(index.head))
  );
}
/** Authenticated forward order over bounded immutable manifest pages. Legacy commits retain their old per-object decoder boundary. */
export function* iterateRecordCommitSegments(
  storage: RecordStorage,
  commit: RecordCommit,
): Generator<RecordObjectReference> {
  if (commit.format === FORMAT) {
    for (const ref of commit.segments) {
      if (!refValid(ref)) fail('invalid segment reference');
      yield ref;
    }
    return;
  }
  if (commit.format !== COMMIT_FORMAT || !segmentIndexValid(commit.segments))
    fail('unsupported segment index');
  const scratch = disposableSqlite('circus-record-segments-');
  try {
    // This private ordering index is consumed on this connection and discarded.
    // Keep its bounded disk-backed work in one transaction instead of an
    // implicit pager transaction per reference. Journal objects are still read
    // and authenticated by the original reader on every traversal.
    scratch.db.exec(
      'CREATE TABLE segments(ordinal INTEGER PRIMARY KEY,reference TEXT NOT NULL); BEGIN',
    );
    const insert = scratch.db.prepare('INSERT INTO segments VALUES(?,?)');
    let ref = commit.segments.head,
      expected = commit.segments.count;
    while (ref) {
      if (!refValid(ref) || ref.bytes > SEGMENT_PAGE_BYTES) fail('invalid segment page reference');
      const page = parseRecordJson<RecordSegmentPage>(
        readObject(storage, ref) as unknown as string,
      );
      recordVersionWork('segmentIndexPagesRead');
      if (
        !page ||
        Object.keys(page).sort().join(',') !==
          'firstSegment,format,operationId,previous,profileId,schemaVersion,segments,sequence' ||
        page.format !== 'health-record-segment-page-v1' ||
        page.profileId !== commit.profileId ||
        page.schemaVersion !== commit.schemaVersion ||
        page.sequence !== commit.sequence ||
        page.operationId !== commit.operationId ||
        !Number.isSafeInteger(page.firstSegment) ||
        page.firstSegment < 0 ||
        !Array.isArray(page.segments) ||
        !page.segments.length ||
        page.segments.length > SEGMENT_REFERENCE_WINDOW ||
        page.firstSegment + page.segments.length !== expected ||
        (page.firstSegment === 0 ? page.previous !== null : !refValid(page.previous))
      )
        fail('invalid segment page binding, order or count');
      recordVersionWorkMaximum('maxSegmentReferencesBuffered', page.segments.length);
      for (let ordinal = 0; ordinal < page.segments.length; ordinal++) {
        const segment = page.segments[ordinal];
        if (!refValid(segment)) fail('invalid segment reference');
        insert.run(page.firstSegment + ordinal, JSON.stringify(segment));
        recordVersionWork('segmentReferencesSpooled');
      }
      expected = page.firstSegment;
      ref = page.previous;
    }
    if (expected !== 0) fail('incomplete segment index');
    for (const row of scratch.db
      .prepare('SELECT reference FROM segments ORDER BY ordinal')
      .iterate()) {
      recordVersionWork('segmentReferencesReplayed');
      yield JSON.parse(String(row.reference)) as RecordObjectReference;
    }
  } finally {
    scratch.close();
  }
}

/** Read the selected authoritative envelope even when the disposable cache is current. */
export function verifyRecordAuthorityHead(
  storage: RecordStorage,
  profileId: string,
  schemaVersion: number,
): void {
  const head = readHead(storage);
  if (!head) fail('no committed profile history');
  readCommit(storage, head as RecordObjectReference, profileId, schemaVersion);
}
function committedSince(
  storage: RecordStorage,
  profileId: string,
  schemaVersion: number,
  stop: RecordObjectReference | null = null,
): {
  head: RecordObjectReference | null;
  transactions: Iterable<IndexedTransaction>;
  length: number;
  close(): void;
} {
  const head = readHead(storage);
  // Only authenticated references enter this private ordering/cycle index.
  // Payloads always come from the selected journal again during replay.
  const scratch = disposableSqlite('circus-record-ancestry-');
  try {
    scratch.db.exec(
      'CREATE TABLE ancestry (ordinal INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, reference TEXT NOT NULL); BEGIN',
    );
    const insert = scratch.db.prepare('INSERT INTO ancestry VALUES(?,?,?)');
    const seen = scratch.db.prepare('SELECT 1 FROM ancestry WHERE name=?');
    let ref = head,
      length = 0;
    while (!eq(ref, stop)) {
      if (!ref || seen.get(ref.name)) fail('missing ancestry or cyclic commits');
      const selected = ref as RecordObjectReference;
      const commit = readCommit(storage, selected, profileId, schemaVersion);
      insert.run(length++, selected.name, JSON.stringify(selected));
      recordVersionWork('ancestryReferencesSpooled');
      ref = commit.previous;
    }
    return {
      head,
      length,
      close: scratch.close,
      transactions: {
        *[Symbol.iterator]() {
          for (const row of scratch.db
            .prepare('SELECT reference FROM ancestry ORDER BY ordinal DESC')
            .iterate()) {
            const ref = JSON.parse(String(row.reference)) as RecordObjectReference;
            recordVersionWork('ancestryReferencesReplayed');
            const commit = readCommit(storage, ref, profileId, schemaVersion);
            yield { ref, commit, versions: readSegmentVersions(storage, commit) };
          }
        },
      },
    };
  } catch (error) {
    scratch.close();
    throw error;
  }
}
/** Reiterable reader: giant JSONL framing is spooled, not repeatedly concatenated. */
function readSegmentVersions(
  storage: RecordStorage,
  commit: RecordCommit,
): Iterable<DurableRecordVersion> {
  return {
    *[Symbol.iterator]() {
      const segments = function* () {
        for (const ref of iterateRecordCommitSegments(storage, commit))
          yield readObject(storage, ref);
      };
      let count = 0;
      for (const version of readRecordJsonLines(segments(), {
        parseSmall: parseRecordJson,
        checkpoint: recordReplayCheckpoint,
        onWork(work) {
          recordVersionWork('journalRecordsSpooled', work.spooledRecords);
          recordVersionWork('journalRecordSpoolBytes', work.spooledBytes);
          recordVersionWorkMaximum('maxJournalRecordBufferBytes', work.maxRecordBufferBytes);
          recordVersionWorkMaximum('maxJournalRecordDecodeWindowBytes', work.maxSpoolReadBytes);
        },
      })) {
        recordVersionWork('decodedVersions');
        yield version as DurableRecordVersion;
        count++;
      }
      if (count !== commit.records) fail('partial transaction');
    },
  };
}
function values(contents: unknown): Map<string, string | undefined> {
  const found = new Map<string, string | undefined>();
  const visit = (path: string, value: unknown): void => {
    recordVersionWork('fieldVisits');
    found.set(path, stringifyRecordJson(value));
    if (value && typeof value === 'object' && !Array.isArray(value))
      for (const key of Object.keys(value))
        visit(path + '.' + key, (value as Record<string, unknown>)[key]);
  };
  if (contents)
    for (const [key, value] of Object.entries(contents)) {
      visit(key, value);
      if (key.endsWith('_json') && typeof value === 'string') {
        try {
          const parsed = parseRecordJson(value);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            for (const child of Object.keys(parsed))
              visit(key + '.' + child, (parsed as Record<string, unknown>)[child]);
        } catch {
          /* literal text is retained */
        }
      }
    }
  return found;
}
function implicitInitialMetadataFields(version: DurableRecordVersion): boolean {
  return (
    version.entity === 'app_meta' &&
    version.previousVersion === null &&
    !version.deleted &&
    version.contents !== null &&
    typeof version.contents === 'object' &&
    !Array.isArray(version.contents) &&
    Object.keys(version.contents).sort().join(',') === 'key,value' &&
    typeof version.contents.key === 'string' &&
    typeof version.contents.value === 'string'
  );
}
const currentStatements = new WeakMap<Database, ReturnType<Database['prepare']>>();
function current(
  db: Database,
  entity: string,
  id: string,
  prior?: SourcePriorData,
): CurrentVersionRow | undefined {
  if (prior && entity === 'source_files' && id === prior.recordId) {
    const row = terminalStatement(
      db,
      'SELECT v.version_id,v.deleted FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
    ).get(entity, id);
    if (!row || row.version_id !== prior.versionId || row.deleted !== 0)
      fail('prepared prior version changed');
    return row as CurrentVersionRow;
  }
  const sql =
    'SELECT v.* FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?';
  if (terminalStatementsActive(db))
    return terminalStatement(db, sql).get(entity, id) as CurrentVersionRow | undefined;
  let statement = currentStatements.get(db);
  if (!statement) {
    statement = terminalStatement(
      db,
      'SELECT v.* FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
    );
    currentStatements.set(db, statement);
  }
  return terminalStatement(db, statement.sourceSQL, statement).get(entity, id) as
    CurrentVersionRow | undefined;
}
function identity(table: TableSchema, row: Record<string, unknown>): string {
  return stringifyRecordJson(table.pk.map((key) => row[key]));
}
function versionIdentityIndex() {
  const scratch = disposableSqlite('circus-record-identities-');
  try {
    // One disposable index lifetime, not one implicit pager transaction per row.
    // Its bounded page cache still spills to disk; close discards this private work.
    scratch.db.exec('CREATE TABLE identities(value TEXT PRIMARY KEY); BEGIN');
  } catch (error) {
    scratch.close();
    throw error;
  }
  const contains = scratch.db.prepare('SELECT 1 FROM identities WHERE value=?'),
    insert = scratch.db.prepare('INSERT INTO identities VALUES(?)');
  return {
    close: scratch.close,
    has(value: string) {
      return !!contains.get(value);
    },
    add(value: string) {
      insert.run(value);
    },
  };
}
function validateVersion(
  db: Database,
  config: RecordConfig,
  commit: RecordCommit,
  version: DurableRecordVersion,
  identities: { has(value: string): boolean; add(value: string): void },
  prior?: SourcePriorData,
): CurrentVersionRow | undefined {
  recordVersionWork('versionValidations');
  const table = config.schema.find((table) => table.name === version.entity);
  if (
    !table ||
    version.format !== FORMAT ||
    version.profileId !== config.profileId ||
    version.schemaVersion !== config.schemaVersion ||
    version.sequence !== commit.sequence ||
    version.operationId !== commit.operationId ||
    version.recordedAt !== commit.recordedAt ||
    !/^[0-9a-f-]{36}$/.test(version.versionId) ||
    typeof version.deleted !== 'boolean' ||
    !version.contents ||
    Array.isArray(version.contents) ||
    !eq(recordVersionColumns(Object.keys(version.contents)).sort(), [...table.columns].sort()) ||
    identity(table, version.contents) !== version.recordId
  )
    fail('invalid complete record version');
  const key = stringifyRecordJson([version.entity, version.recordId]);
  if (identities.has(key)) fail('duplicate record in transaction');
  identities.add(key);
  if (
    prior &&
    version.entity === 'source_files' &&
    version.recordId === prior.recordId &&
    version.deleted
  )
    fail('prepared prior comparison cannot delete source');
  const previous = current(db, version.entity, version.recordId, prior);
  if (version.previousVersion !== (previous?.version_id ?? null))
    fail('invalid previous-version reference');
  if (version.deleted && (!previous || previous.deleted)) fail('deletion without current record');
  if (version.deleted && !eq(version.contents, parseRecordJson(previous!.contents_json)))
    fail('tombstone changed the removed record');
  if (table!.name === 'app_meta' && internalKey(version.contents.key as string))
    fail('operational metadata is not a durable record');
  return previous;
}
function indexTransaction(
  db: Database,
  config: RecordConfig,
  { ref, commit, versions }: IndexedTransaction,
  prior?: SourcePriorData,
): RecordBookkeeping {
  const bookkeeping: RecordBookkeeping = {
    writes: 0n,
    metadataKeys: new Set(),
    metadataOnly: true,
  };
  if (prior) prior.indexedWrites = 0;
  const indexed = terminalStatement(db, 'SELECT * FROM __record_state WHERE singleton=1').get() as
    RecordStateRow | undefined;
  if (
    commit.sequence !== (indexed?.sequence ?? 0) + 1 ||
    !eq(commit.previous, indexed ? parseRecordJson<RecordObjectReference>(indexed.head_json) : null)
  )
    fail('commit sequence gap or cache ancestry mismatch');
  if (indexed) {
    const previous = terminalStatement(
      db,
      'SELECT commit_json FROM __record_transactions WHERE sequence=?',
    ).get(indexed.sequence) as (SqliteRow & { commit_json: string }) | undefined;
    if (
      !previous ||
      commit.revision !== parseRecordJson<RecordCommit>(previous.commit_json).revision + 1
    )
      fail('profile revision gap');
  }
  if (indexed && commit.revision !== revision(db))
    fail('projection revision differs from committed transaction');
  const identities = versionIdentityIndex(),
    insertVersion = terminalStatement(
      db,
      'INSERT INTO __record_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ),
    selectVersion = terminalStatement(
      db,
      'INSERT INTO __record_current VALUES(?,?,?) ON CONFLICT(entity,record_id) DO UPDATE SET version_id=excluded.version_id',
    );
  // Only SQL bytecode is shared within this indexing call. Keep at most 32
  // statement shapes; metadata arguments never cross a complete-version
  // boundary, and every version still follows the original validation order.
  const fieldStatements = new Map<number, ReturnType<Database['prepare']>>();
  try {
    for (const version of versions) {
      recordVersionWork('indexedVersionAttempts');
      const previous = validateVersion(db, config, commit, version, identities, prior);
      const implicitFields = implicitInitialMetadataFields(version);
      const { contents, ...metadata } = version;
      const contentsJson = stringifyRecordJson(contents);
      const versionWrite = insertVersion.run(
        version.versionId,
        config.profileId,
        version.entity,
        version.recordId,
        version.sequence,
        version.recordedAt,
        version.previousVersion,
        version.operationId,
        Number(version.deleted),
        contentsJson,
        stringifyRecordJson(metadata),
      );
      const currentWrite = selectVersion.run(version.entity, version.recordId, version.versionId);
      if (versionWrite.changes !== 1 || currentWrite.changes !== 1)
        fail('indexed version write count');
      bookkeeping.writes += 2n;
      if (version.entity === 'app_meta' && bookkeeping.metadataKeys.size < 4100)
        bookkeeping.metadataKeys.add(contents.key as string);
      else bookkeeping.metadataOnly = false;
      if (prior) {
        if (versionWrite.changes !== 1 || currentWrite.changes !== 1)
          fail('indexed version write count');
        prior.indexedWrites! += 2;
        if (version.entity === 'source_files' && version.recordId === prior.recordId) {
          if (prior.newSource) fail('duplicate compact indexed source');
          prior.newSource = {
            versionId: version.versionId,
            contents: contentsJson,
            metadata: stringifyRecordJson(metadata),
          };
        }
      }
      if (!implicitFields) {
        if (
          !prior &&
          version.entity === 'source_files' &&
          (contentsJson.length > 65536 || (previous?.contents_json.length ?? 0) > 65536)
        ) {
          const fields: SQLInputValue[] = [];
          const flush = () => {
            if (!fields.length) return;
            const rows = fields.length / 9;
            let insert = fieldStatements.get(rows);
            if (!insert) {
              insert = terminalStatement(
                db,
                'INSERT INTO __record_fields VALUES' +
                  Array(rows).fill('(?,?,?,?,?,?,?,?,?)').join(','),
              );
              fieldStatements.set(rows, insert);
            }
            if (insert.run(...fields).changes !== rows) fail('indexed field write count');
            bookkeeping.writes += BigInt(rows);
            fields.length = 0;
          };
          for (const change of recordSourceFieldChanges(
            previous && !previous.deleted ? previous.contents_json : undefined,
            version.deleted ? undefined : contentsJson,
            recordReplayCheckpoint,
          )) {
            fields.push(
              version.versionId,
              config.profileId,
              version.entity,
              version.recordId,
              change.field,
              version.sequence,
              previous?.version_id ?? null,
              Number(change.beforePresent),
              Number(change.afterPresent),
            );
            if (fields.length === 32 * 9) flush();
          }
          flush();
          continue;
        }
        const preparedBefore =
          prior && version.entity === 'source_files' && version.recordId === prior.recordId
            ? prior.fields
            : undefined;
        const before = preparedBefore
            ? undefined
            : values(
                previous && !previous.deleted ? parseRecordJson(previous.contents_json) : null,
              ),
          after = values(version.deleted ? null : version.contents);
        const fields: SQLInputValue[] = [];
        const flushFields = () => {
          if (!fields.length) return;
          const rows = fields.length / 9;
          let insert = fieldStatements.get(rows);
          if (!insert) {
            insert = terminalStatement(
              db,
              'INSERT INTO __record_fields VALUES' +
                Array(rows).fill('(?,?,?,?,?,?,?,?,?)').join(','),
            );
            fieldStatements.set(rows, insert);
          }
          const written = insert.run(...fields);
          if (written.changes !== rows) fail('indexed field write count');
          bookkeeping.writes += BigInt(rows);
          if (prior) {
            if (written.changes !== rows) fail('indexed field write count');
            prior.indexedWrites! += rows;
          }
          fields.length = 0;
        };
        const beforeHas = (field: string) =>
          preparedBefore ? preparedBefore.get(field) !== undefined : before!.has(field);
        const changed = (field: string) => {
          if (!preparedBefore) return before!.get(field) !== after.get(field);
          const old = preparedBefore.get(field),
            value = after.get(field);
          if (!old || value === undefined) return !!old || value !== undefined;
          const next = recordFieldDigest(value);
          return old.hash !== next.hash || old.bytes !== next.bytes;
        };
        const union = function* () {
          yield* preparedBefore ? preparedBefore.fields() : before!.keys();
          for (const field of after.keys()) if (!beforeHas(field)) yield field;
        };
        for (const field of union())
          if (changed(field)) {
            fields.push(
              version.versionId,
              config.profileId,
              version.entity,
              version.recordId,
              field,
              version.sequence,
              previous?.version_id ?? null,
              Number(beforeHas(field)),
              Number(after.has(field)),
            );
            if (fields.length === 32 * 9) flushFields();
          }
        flushFields();
      }
    }
  } finally {
    identities.close();
  }
  const transactionWrite = terminalStatement(
    db,
    'INSERT INTO __record_transactions VALUES(?,?,?,?,?)',
  ).run(
    commit.operationId,
    commit.sequence,
    commit.fingerprint as SQLInputValue,
    stringifyRecordJson(commit.result),
    stringifyRecordJson(commit),
  );
  if (prior) {
    if (transactionWrite.changes !== 1) fail('indexed transaction write count');
    prior.indexedWrites!++;
  }
  if (transactionWrite.changes !== 1) fail('indexed transaction write count');
  bookkeeping.writes++;
  const expectedState = expectIntakeFrontierStateWrite(db);
  let wroteState = false;
  try {
    wroteState =
      terminalStatement(db, 'INSERT OR REPLACE INTO __record_state VALUES(1,?,?,?,?,?)').run(
        config.profileId,
        PROJECTION,
        config.schemaVersion,
        commit.sequence,
        stringifyRecordJson(ref),
      ).changes === 1;
  } finally {
    finishIntakeFrontierMetaWrite(db, expectedState, wroteState);
  }
  if (prior) {
    if (!wroteState || !prior.newSource) fail('compact indexed state/source missing');
    prior.indexedWrites!++;
    const proof = Object.freeze({}) as RecordIndexedPublication;
    indexedPublications.set(proof, {
      db,
      config,
      prior,
      ref,
      commit,
      token: currentTransactionToken(db)!,
    });
    prior.indexed = proof;
  }
  return bookkeeping;
}
function* collect(
  db: Database,
  config: RecordConfig,
  baseline = false,
  prior?: SourcePriorData,
): Generator<PendingRecordVersion> {
  const keys = baseline
    ? (function* () {
        for (const table of config.schema)
          for (const row of terminalStatement(
            db,
            `SELECT * FROM ${q(table.name)} ORDER BY ${table.pk.map(q).join(',')}`,
          ).iterate())
            yield {
              entity: table.name,
              record_id: identity(table, row as Record<string, unknown>),
            };
      })()
    : (terminalStatement(
        db,
        'SELECT * FROM __record_changed ORDER BY entity,record_id',
      ).iterate() as Iterable<SqliteRow & { entity: string; record_id: string }>);
  // A new traversal owns these statements, bounded by the configured tables.
  // Never memoize rows: even a deletion or an unchanged field must read the
  // current transaction's row and predecessor again.
  const readers = new Map<TableSchema, ReturnType<Database['prepare']>>();
  for (const { entity, record_id: recordId } of keys) {
    const table = config.schema.find((table) => table.name === entity),
      id = parseRecordJson(recordId) as SQLInputValue[];
    if (entity === 'app_meta' && internalKey(id[0] as string)) continue;
    let read = readers.get(table!);
    if (!read) {
      read = terminalStatement(
        db,
        `SELECT * FROM ${q(entity)} WHERE ${table!.pk.map((key) => q(key) + '=?').join(' AND ')}`,
      );
      readers.set(table!, read);
    }
    const contents = read.get(...id);
    const previous = current(db, entity, recordId, prior);
    if (!contents && (!previous || previous.deleted)) continue;
    yield {
      entity,
      recordId,
      contents:
        (contents as Record<string, unknown> | undefined) ??
        (parseRecordJson(previous!.contents_json) as Record<string, unknown>),
      deleted: !contents,
      previousVersion: previous?.version_id ?? null,
    };
  }
}
function hasChanges(db: Database, config: RecordConfig) {
  const changes = collect(db, config);
  try {
    return !changes.next().done;
  } finally {
    changes.return(undefined);
  }
}
function publish(
  db: Database,
  config: RecordConfig,
  records: Iterable<PendingRecordVersion>,
  operation: TransactionOperation = {},
  result: unknown = null,
  prior?: SourcePriorData,
) {
  if (prior?.plan) {
    const plan = prior.plan,
      staging = authorityWitnesses.get(prior.authority)?.staging;
    if (
      plan.consumed ||
      !staging ||
      operation.operationId !== plan.operation.operationId ||
      operation.fingerprint !== plan.operation.fingerprint ||
      operation.actor !== 'intake-state' ||
      operation.origin != null ||
      operation.references != null ||
      !eq(result, plan.operation.result) ||
      revision(db) !== plan.commit.revision ||
      readStatusRow(db).sequence + 1 !== plan.commit.sequence
    )
      fail('compact prepared publication operation changed');
    bindVaultRecordStagingTransaction(staging!);
    let count = 0;
    for (const record of records) {
      if (!eq(record, plan.pending[count++])) fail('compact prepared publication rows changed');
      prior.assertCurrent();
    }
    if (count !== plan.pending.length) fail('compact prepared publication rows missing');
    plan.consumed = true;
    prior.assertCurrent();
    const bookkeeping = indexTransaction(
      db,
      config,
      {
        ref: plan.ref,
        commit: plan.commit,
        versions: plan.versions,
      },
      prior,
    );
    prepareVaultRecordHead(staging!);
    renewIntakeMaintenanceAfterIndex(db, operation.intakeMaintenance!, prior.indexed!);
    markSelectionAttempt(db);
    installVaultRecordHead(staging!, encode(plan.ref), prior.indexed!);
    indexedPublications.get(prior.indexed!)!.installed = true;
    // The actual lexical installer authenticates HEAD readback itself. Do not
    // re-enter a storage callback after the final publication/continuation seal.
    return {
      sequence: plan.commit.sequence,
      operationId: plan.commit.operationId,
      records: count,
      bookkeeping,
    };
  }
  if (
    meta(db, 'owner_profile_id') !== config.profileId ||
    databaseSchemaVersion(db) !== config.schemaVersion
  )
    fail('database ownership or schema changed');
  const indexed = db.prepare('SELECT * FROM __record_state WHERE singleton=1').get() as
    RecordStateRow | undefined;
  const previous = indexed ? parseRecordJson<RecordObjectReference>(indexed.head_json) : null;
  if (!eq(readHead(config.storage), previous))
    fail('durable head changed; reopen or rebuild before saving');
  const sequence = (indexed?.sequence ?? 0) + 1,
    recordedAt = new Date().toISOString();
  const operationId = (operation.operationId ?? randomUUID()) as string;
  let count = 0;
  let page: RecordObjectReference[] = [],
    segmentCount = 0,
    segmentHead: RecordObjectReference | null = null;
  const flushPage = () => {
    if (!page.length) return;
    const value: RecordSegmentPage = {
      format: 'health-record-segment-page-v1',
      profileId: config.profileId,
      schemaVersion: config.schemaVersion,
      sequence,
      operationId,
      previous: segmentHead,
      firstSegment: segmentCount - page.length,
      segments: page,
    };
    const bytes = encode(value);
    if (bytes.length > SEGMENT_PAGE_BYTES) fail('segment page exceeds controlled format');
    segmentHead = writeObject(config.storage, bytes, prior);
    recordVersionWork('segmentIndexPagesWritten');
    page = [];
  };
  let chunks: Buffer[] = [],
    size = 0;
  const flush = (): void => {
    if (size) {
      page.push(writeObject(config.storage, Buffer.concat(chunks), prior));
      segmentCount++;
      recordVersionWorkMaximum('maxSegmentReferencesBuffered', page.length);
      if (page.length === SEGMENT_REFERENCE_WINDOW) flushPage();
    }
    chunks = [];
    size = 0;
  };
  for (const record of records) {
    const version: DurableRecordVersion = {
      format: FORMAT,
      profileId: config.profileId,
      schemaVersion: config.schemaVersion,
      sequence,
      recordedAt,
      operationId,
      versionId: randomUUID(),
      actor: operation.actor ?? null,
      origin: operation.origin ?? null,
      references: operation.references ?? null,
      ...record,
    };
    config.verifyReferences?.([version]);
    count++;
    const bytes = encode(version);
    for (let offset = 0; offset < bytes.length;) {
      const take = Math.min(config.segmentBytes - size, bytes.length - offset);
      chunks.push(bytes.subarray(offset, offset + take));
      size += take;
      offset += take;
      if (size === config.segmentBytes) flush();
    }
  }
  flush();
  flushPage();
  const commit: RecordCommitV2 = {
    format: COMMIT_FORMAT,
    profileId: config.profileId,
    schemaVersion: config.schemaVersion,
    sequence,
    revision: revision(db),
    previous,
    operationId,
    fingerprint: operation.fingerprint ?? null,
    result: result ?? null,
    recordedAt,
    segments: { format: 'health-record-segment-index-v1', head: segmentHead, count: segmentCount },
    records: count,
  };
  const ref = writeObject(config.storage, encode(commit), prior);
  prior?.assertCurrent();
  // All validation/indexing happens before the one acceptance boundary. The
  // SQLite transaction can roll back; the published commit remains recoverable.
  const bookkeeping = indexTransaction(
    db,
    config,
    {
      ref,
      commit,
      versions: readSegmentVersions(config.storage, commit),
    },
    prior,
  );
  if (prior) {
    const staging = authorityWitnesses.get(prior.authority)?.staging;
    if (staging) prepareVaultRecordHead(staging);
    renewIntakeMaintenanceAfterIndex(db, operation.intakeMaintenance!, prior.indexed!);
    markSelectionAttempt(db);
    if (staging) installVaultRecordHead(staging, encode(ref));
    else config.storage.publishHead(encode(ref));
  } else {
    markSelectionAttempt(db);
    config.storage.publishHead(encode(ref));
  }
  if (!eq(readHead(config.storage), ref)) fail('head publication failed verification');
  if (prior) indexedPublications.get(prior.indexed!)!.installed = true;
  return { sequence, operationId, records: count, bookkeeping };
}
function applyVersions(
  db: Database,
  config: RecordConfig,
  versions: Iterable<DurableRecordVersion>,
): void {
  // Values are complete records, never patches or rerun application operations.
  // Reuse only SQL bytecode within this transaction's replay, bounded by the
  // configured table set. Every version still performs its original row work;
  // no statement or record is shared with another replay or retained afterward.
  const removals = new Map<TableSchema, ReturnType<Database['prepare']>>();
  const insertions = new Map<TableSchema, ReturnType<Database['prepare']>>();
  // Delete changed rows first to allow accepted changes to unique associations.
  for (const version of versions) {
    recordVersionWork('replayDeleteAttempts');
    const table = config.schema.find((table) => table.name === version.entity);
    if (!table || !Array.isArray(parseRecordJson(version.recordId)))
      fail('unknown record identity');
    let remove = removals.get(table!);
    if (!remove) {
      remove = db.prepare(
        `DELETE FROM ${q(table!.name)} WHERE ${table!.pk.map((key) => q(key) + '=?').join(' AND ')}`,
      );
      removals.set(table!, remove);
    }
    remove.run(...(parseRecordJson(version.recordId) as SQLInputValue[]));
  }
  for (const version of versions)
    if (!version.deleted) {
      recordVersionWork('replayInsertAttempts');
      const table = config.schema.find((table) => table.name === version.entity)!;
      let insert = insertions.get(table);
      if (!insert) {
        insert = db.prepare(
          `INSERT INTO ${q(table.name)} (${table.columns.map(q).join(',')}) VALUES(${table.columns.map(() => '?').join(',')})`,
        );
        insertions.set(table, insert);
      }
      insert.run(...table.columns.map((key) => version.contents[key] as SQLInputValue));
    }
}
function verifyTargets(db: Database): void {
  const targetTables = {
    note: 'notes',
    person: 'people',
    observation: 'observations',
    test_type: 'test_types',
    medication: 'medications',
    procedure: 'procedures',
    document: 'documents',
    report: 'reports',
    source_file: 'source_files',
  };
  const exists = (type: unknown, id: unknown): boolean =>
    type === 'source'
      ? Boolean(
          db
            .prepare(
              'SELECT 1 FROM source_files WHERE id=? UNION ALL SELECT 1 FROM source_records WHERE id=? LIMIT 1',
            )
            .get(id as SQLInputValue, id as SQLInputValue),
        )
      : Boolean(resolveClinicalReference(db, type, id as string)) ||
        Boolean(
          targetTables[type as keyof typeof targetTables] &&
          db
            .prepare(
              `SELECT 1 FROM ${q(targetTables[type as keyof typeof targetTables])} WHERE id=?`,
            )
            .get(id as SQLInputValue),
        );
  for (const [table, typeKey, idKey] of [
    ['note_links', 'target_type', 'target_id'],
    ['attachments', 'owner_type', 'owner_id'],
    ['evidence', 'entity_type', 'entity_id'],
    ['visibility_events', 'target_type', 'target_id'],
  ]) {
    for (const row of db.prepare(`SELECT * FROM ${q(table)}`).iterate())
      if (!exists(row[typeKey], row[idKey]))
        fail('rebuilt polymorphic relationship target is missing');
  }
  if (!db.prepare("SELECT 1 FROM people WHERE id='patient' AND is_patient=1").get())
    fail('rebuilt profile owner identity is missing');
}
function catchUp(
  db: Database,
  config: RecordConfig,
  options: { empty?: boolean } = {},
): RecordObjectReference | null {
  return withRecordVersionWorkPhase('reconstruction', () => catchUpRecords(db, config, options));
}
function catchUpRecords(
  db: Database,
  config: RecordConfig,
  { empty = false }: { empty?: boolean } = {},
): RecordObjectReference | null {
  const indexed = db.prepare('SELECT * FROM __record_state WHERE singleton=1').get() as
    RecordStateRow | undefined;
  if (
    indexed &&
    (indexed.profile_id !== config.profileId ||
      indexed.projection !== PROJECTION ||
      indexed.schema_version !== config.schemaVersion)
  )
    fail('unsupported or wrong-profile projection');
  if (indexed) {
    const latest = db
      .prepare(
        'SELECT sequence,commit_json FROM __record_transactions ORDER BY sequence DESC LIMIT 1',
      )
      .get() as (SqliteRow & { sequence: number; commit_json: string }) | undefined;
    if (
      !latest ||
      latest.sequence !== indexed.sequence ||
      parseRecordJson<RecordCommit>(latest.commit_json).revision !== revision(db)
    )
      fail('cached projection sequence or revision is inconsistent');
  }
  const ancestry = committedSince(
    config.storage,
    config.profileId,
    config.schemaVersion,
    indexed ? parseRecordJson<RecordObjectReference>(indexed.head_json) : null,
  );
  const { head, transactions } = ancestry;
  try {
    if (!ancestry.length) return head;
    const triggers = db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")
      .all() as Array<SqliteRow & { name: string; sql: string }>;
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try {
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${q(trigger.name)}`);
      if (!indexed && empty)
        for (const table of config.schema) db.exec(`DELETE FROM ${q(table.name)}`);
      for (const tx of transactions) {
        const identities = versionIdentityIndex();
        try {
          for (const version of tx.versions)
            validateVersion(db, config, tx.commit, version, identities);
        } finally {
          identities.close();
        }
        if (config.verifyReferences)
          for (const version of tx.versions) config.verifyReferences([version]);
        applyVersions(db, config, tx.versions);
        indexTransaction(db, config, tx);
        if (revision(db) !== tx.commit.revision) fail('committed revision record is missing');
      }
      for (const trigger of triggers) db.exec(trigger.sql);
      if (
        meta(db, 'owner_profile_id') !== config.profileId ||
        databaseSchemaVersion(db) !== config.schemaVersion ||
        db.prepare('PRAGMA foreign_key_check').get()
      )
        fail('rebuilt ownership, schema or foreign-key integrity failed');
      verifyTargets(db);
      if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok')
        fail('rebuilt SQLite integrity failed');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys=ON');
    }
    return head;
  } finally {
    ancestry.close();
  }
}

/** Attach while the profile is unlocked and exclusively owned by one writer.
 * storage.read('head'|objectName) returns decrypted Buffer or null if missing;
 * writeImmutable(name,Buffer) verifies/encrypts/fsyncs without replacement;
 * publishHead(Buffer) atomically authenticates/encrypts/fsyncs the commit head.
 * Fresh databases are seeded once; a cache reuses its indexed sequence and only
 * reads later commits. Missing/stale cache is deterministically reconstructed.
 */
export function attachRecordDurability(
  db: Database,
  {
    profileId,
    storage,
    verifyReferences,
    segmentBytes = LIMIT,
  }: AttachRecordDurabilityOptions = {},
): RecordDurabilityStatus {
  validStorage(storage);
  if (meta(db, 'owner_profile_id') !== profileId) fail('database belongs to another profile');
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 1024 || segmentBytes > 16 * 1024 * 1024)
    fail('invalid segment bound');
  setup(db);
  const config = {
    profileId,
    storage,
    verifyReferences,
    segmentBytes,
    schemaVersion: databaseSchemaVersion(db),
    schema: tables(db),
  } as RecordConfig;
  const indexed = db.prepare('SELECT * FROM __record_state WHERE singleton=1').get() as
    RecordStateRow | undefined;
  if (readHead(storage)) catchUp(db, config, { empty: !indexed });
  else {
    if (indexed) fail('durable history missing for existing cache');
    db.exec('BEGIN IMMEDIATE');
    try {
      publish(db, config, collect(db, config, true), { origin: 'profile-initialization' });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  state.set(db, config);
  captureTriggers(db, config.schema);
  const markPersisted = () => {
    const expected = expectIntakeFrontierMetaWrite(db, 'curation_revision', ['insert', 'update']);
    let written = false;
    try {
      const result = terminalStatement(
        db,
        "INSERT INTO app_meta(key,value) VALUES('curation_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(String(revision(db)));
      written = result.changes === 1;
      return result;
    } finally {
      finishIntakeFrontierMetaWrite(db, expected, written);
    }
  };
  markPersisted();
  terminalExecution(db, 'DELETE FROM __record_changed');
  const participant: TransactionDurabilityHooks<RecordCapture> = {
    begin(operation) {
      const indexed = terminalStatement(
        db,
        'SELECT * FROM __record_state WHERE singleton=1',
      ).get() as RecordStateRow | undefined;
      if (!eq(readConfiguredHead(db, config), parseRecordJson(indexed!.head_json)))
        fail('cache is behind accepted history; reopen before writing');
      if (hasChanges(db, config))
        fail('uncommitted direct writes bypassed the transaction boundary');
      if (operation.operationId !== undefined) {
        if (
          typeof operation.operationId !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(operation.operationId) ||
          typeof operation.fingerprint !== 'string' ||
          !operation.fingerprint
        )
          throw new HttpError(
            400,
            'INVALID_OPERATION',
            'Stable operation ID requires a request fingerprint',
          );
        const prior = terminalStatement(
          db,
          'SELECT * FROM __record_transactions WHERE operation_id=?',
        ).get(operation.operationId as SQLInputValue) as
          (SqliteRow & { fingerprint: string; result_json: string }) | undefined;
        if (prior) {
          if (prior.fingerprint !== operation.fingerprint)
            throw new HttpError(
              409,
              'OPERATION_CONFLICT',
              'Operation ID was already used for a different request',
            );
          return { replayed: true, result: parseRecordJson(prior.result_json) };
        }
      }
      if (operation.expectedRevision !== undefined && operation.expectedRevision !== revision(db))
        throw new HttpError(
          409,
          'VERSION_CONFLICT',
          'Profile changed since this operation was prepared',
        );
    },
    capture() {
      maintenanceBookkeeping.delete(db);
      const token = currentTransactionToken(db)!;
      const empty = !terminalStatement(db, 'SELECT 1 FROM temp.__record_changed LIMIT 1').get();
      const cleared = clearIntakeFrontierRecordCapture(db, activeCompactTerminal.get(db)?.capture);
      return {
        token,
        empty: empty && cleared === 0,
        bookkeeping: undefined,
      };
    },
    markDirty: markPersisted,
    prepare(captured, { operation, result }) {
      const preparation = preparingTransactions.get(operation);
      if (preparation) {
        const token = currentTransactionToken(db),
          stamp = Reflect.apply(readmissionPrepare, db, ['SELECT total_changes() AS n']);
        stamp.setReadBigInts(true);
        const before = Reflect.apply(readmissionGet, stamp, []).n as bigint;
        assertClinicalOperation(db, preparation.clinicalOperation);
        if (
          !captured ||
          !captured.empty ||
          captured.token !== token ||
          preparation.token ||
          !recordTransactionPreparationRequested(db, operation) ||
          stringifyRecordJson(operation) !== preparation.operationJson ||
          managedDatabaseMethodEpoch(db) !== preparation.methods
        )
          fail('record tentative-row preparation changed');
        const names = new Set([
          ...config.schema.map((table) => table.name.toLowerCase()),
          '__record_changed',
          '__record_state',
          '__record_current',
          '__record_versions',
          '__record_fields',
          '__record_transactions',
        ]);
        for (const shadow of Reflect.apply(readmissionPrepare, db, [
          "SELECT name FROM sqlite_temp_schema WHERE type IN ('table','view')",
        ]).all())
          if (names.has(String(shadow.name).toLowerCase()) && shadow.name !== '__record_changed')
            fail('record tentative-row preparation has a TEMP shadow');
        for (const record of collect(db, config)) {
          const version: DurableRecordVersion = {
            format: FORMAT,
            profileId: config.profileId,
            schemaVersion: config.schemaVersion,
            sequence: preparation.originalState.sequence + 1,
            operationId: preparation.operationId,
            recordedAt: preparation.recordedAt,
            versionId: randomUUID(),
            actor: operation.actor ?? null,
            origin: operation.origin ?? null,
            references: operation.references ?? null,
            ...record,
          };
          // Reference observers see the genuine tentative rows, just as in an
          // ordinary publish. They do not run again in the sealed replay.
          config.verifyReferences?.([version]);
          preparation.rows.append(stringifyRecordJson(version));
          preparation.records++;
        }
        preparation.rows.seal();
        // Rollback removes these TEMP rows before participant.release runs.
        // Retain tentative membership separately from the cleanup delete count.
        preparation.captureRows = Reflect.apply(
          readmissionGet,
          Reflect.apply(readmissionPrepare, db, [
            'SELECT count(*) AS count FROM temp.__record_changed',
          ]),
          [],
        ).count as number | bigint;
        preparation.revision = revision(db);
        const resultJson = stringifyRecordJson(result ?? null);
        // Genuine policy decisions see the actual tentative rows and token.
        // The retained bytecode is transport only; acceptance still requires
        // authenticated predecessors, original physical proofs and a new token.
        preparation.terminal = prepareTerminalStatementsInTransaction(db, token!, {
          statements: [
            ...new Set([
              ...preparation.recipe.sql(),
              'SELECT total_changes() AS n',
              'SELECT * FROM __record_state WHERE singleton=1',
              'SELECT commit_json FROM __record_transactions WHERE sequence=?',
              'SELECT * FROM __record_transactions WHERE operation_id=?',
              'SELECT 1 FROM temp.__record_changed LIMIT 1',
              'SELECT total_changes() AS count',
              ...config.schema.flatMap((table) => [
                recordPreparedValueCheckSql(table, false),
                recordPreparedValueCheckSql(table, true),
              ]),
              ...config.schema.map(
                (table) =>
                  `SELECT * FROM ${q(table.name)} WHERE ${table.pk.map((key) => q(key) + '=?').join(' AND ')}`,
              ),
              "INSERT OR IGNORE INTO app_meta(key,value) VALUES('clinical_review_revision',(SELECT value FROM app_meta WHERE key='revision'))",
              "INSERT INTO app_meta(key,value) VALUES('curation_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              'SELECT v.* FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
              'INSERT INTO __record_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
              'INSERT INTO __record_current VALUES(?,?,?) ON CONFLICT(entity,record_id) DO UPDATE SET version_id=excluded.version_id',
              'INSERT INTO __record_transactions VALUES(?,?,?,?,?)',
              'INSERT OR REPLACE INTO __record_state VALUES(1,?,?,?,?,?)',
              "SELECT value FROM app_meta WHERE key='revision'",
              ...Array.from(
                { length: 32 },
                (_, index) =>
                  'INSERT INTO __record_fields VALUES' +
                  Array(index + 1)
                    .fill('(?,?,?,?,?,?,?,?,?)')
                    .join(','),
              ),
            ]),
          ].map((sql) => ({
            sql,
            bigInts: ['SELECT total_changes() AS n', 'SELECT total_changes() AS count'].includes(
              sql,
            ),
          })),
          executions: [
            'BEGIN IMMEDIATE',
            'COMMIT',
            'ROLLBACK',
            "UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'",
            "UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='clinical_review_revision'",
          ],
        });
        if (
          Reflect.apply(readmissionGet, stamp, []).n !== before ||
          preparation.expectedTentativeWrites === undefined ||
          before !== preparation.tentativeStart! + preparation.expectedTentativeWrites ||
          stringifyRecordJson(operation) !== preparation.operationJson ||
          managedDatabaseMethodEpoch(db) !== preparation.methods
        )
          fail('record tentative-row capture invoked an unowned SQL write');
        preparation.resultJson = resultJson;
        if (preparation.tentativeStart === undefined)
          fail('record preparatory write interval absent');
        preparation.tentativeWrites = before - preparation.tentativeStart!;
        preparation.total = before;
        preparation.token = token;
        preparingTokens.set(token!, preparation);
        return;
      }
      const prior = operation.intakeMaintenance
        ? consumeIntakeMaintenancePriorFields(db, operation.intakeMaintenance)
        : undefined;
      const prepared = prior && consumeRecordSourcePriorFields(db, prior);
      if (prepared)
        prepared.assertCurrent = () => {
          if (
            consumeIntakeMaintenancePriorFields(db, operation.intakeMaintenance!) !== prior ||
            !recordAuthorityWitnessCurrent(db, prepared.authority) ||
            managedDatabaseMethodEpoch(db) !== prepared.methods
          )
            fail('prepared prior comparison changed before indexing');
          prepared.expectedWrites = sealIntakeMaintenancePriorFields(
            db,
            operation.intakeMaintenance!,
          );
        };
      prepared?.assertCurrent();
      const publication = publish(
        db,
        config,
        collect(db, config, false, prepared),
        operation,
        result,
        prepared,
      );
      if (captured && operation.intakeMaintenance) captured.bookkeeping = publication.bookkeeping;
    },
    release(captured) {
      if (!captured) return;
      const keys = intakeFrontierOwnedMetadataKeys(db, captured.token);
      const bookkeeping = captured.bookkeeping;
      let exact = !!(captured.empty && keys && bookkeeping?.metadataOnly);
      if (exact) {
        const expected = new Set([...keys!].map((key) => JSON.stringify([key])));
        for (const row of terminalStatement(
          db,
          'SELECT entity,record_id FROM temp.__record_changed',
        ).iterate()) {
          if (row.entity !== 'app_meta' || !expected.delete(row.record_id as string)) {
            exact = false;
            break;
          }
        }
        exact &&= expected.size === 0;
        const indexed = new Set([...keys!].filter((key) => !internalKey(key)));
        exact &&=
          indexed.size === bookkeeping!.metadataKeys.size &&
          [...indexed].every((key) => bookkeeping!.metadataKeys.has(key));
      }
      const cleared = clearIntakeFrontierRecordCapture(db, activeCompactTerminal.get(db)?.capture);
      const preparation = preparingTokens.get(captured.token);
      if (preparation) {
        preparingTokens.delete(captured.token);
        if (db.isTransaction || preparation.total === undefined || preparation.released)
          fail('record preparation released before its rollback');
        preparation.total = preparation.total! + BigInt(cleared);
        preparation.released = true;
        preparedPublicationTokens.set(captured.token, preparation);
      }
      if (exact && BigInt(cleared) === BigInt(keys!.size))
        maintenanceBookkeeping.set(db, {
          token: captured.token,
          writes: bookkeeping!.writes + 2n * BigInt(keys!.size),
        });
    },
  };
  Object.freeze(participant);
  recordParticipants.set(db, participant);
  registerTransactionDurability(db, participant);
  const status = recordDurabilityStatus(db)!;
  // Only this successfully attached accepted-record owner may relax cache sync.
  // publish() still verifies and durably publishes immutable records and HEAD
  // before SQLite COMMIT. A lost WAL tail is rebuilt from that accepted history.
  // Unattached databases and non-WAL connections retain their existing settings.
  if (!status.dirty && db.prepare('PRAGMA main.journal_mode').get()?.journal_mode === 'wal') {
    db.exec('PRAGMA main.synchronous=NORMAL');
    db.exec('PRAGMA main.wal_autocheckpoint=32768');
  }
  return status;
}
const statusStatements = new WeakMap<
  Database,
  { statement: ReturnType<Database['prepare']>; busy: boolean }
>();
function readStatusRow(db: Database): RecordStateRow {
  const sql = 'SELECT * FROM __record_state WHERE singleton=1';
  if (terminalStatementsActive(db)) return terminalStatement(db, sql).get() as RecordStateRow;
  let cached = statusStatements.get(db);
  if (cached?.busy) return terminalStatement(db, sql).get() as RecordStateRow;
  if (!cached) {
    const entry = { statement: terminalStatement(db, sql), busy: false };
    observeDatabaseClose(db, () => {
      if (statusStatements.get(db) === entry) statusStatements.delete(db);
    });
    statusStatements.set(db, (cached = entry));
  }
  cached.busy = true;
  try {
    return terminalStatement(db, sql, cached.statement).get() as RecordStateRow;
  } finally {
    cached.busy = false;
  }
}
export function recordDurabilityStatus(db: Database): RecordDurabilityStatus | null {
  if (!state.has(db)) return null;
  const row = readStatusRow(db);
  const behind = !eq(readConfiguredHead(db, state.get(db)!), parseRecordJson(row.head_json));
  return {
    configured: true,
    format: FORMAT,
    dirty: behind,
    conflicted: behind,
    lastError: behind ? 'Projection requires recovery from accepted record history' : null,
    revision: revision(db),
    persistedRevision: revision(db),
    sequence: row.sequence,
  };
}
declare const authorityWitnessBrand: unique symbol;
declare const priorFieldsBrand: unique symbol;
declare const indexedPublicationBrand: unique symbol;
export interface RecordIndexedPublication {
  readonly [indexedPublicationBrand]: true;
}
const indexedPublications = new WeakMap<
  RecordIndexedPublication,
  {
    db: Database;
    config: RecordConfig;
    prior: SourcePriorData;
    ref: RecordObjectReference;
    commit: RecordCommit;
    token: object;
    backingConsumed?: boolean;
    installed?: boolean;
  }
>();
/** Read-only consumption of the private, exactly indexed preparation. No SQL,
 * storage or policy callback may run after the publication's closing seal. */
export function consumeRecordBackingAdvance(
  db: Database,
  proof: RecordIndexedPublication,
  staging: VaultRecordStagingWitness,
  head: string,
): readonly string[] {
  const data = indexedPublications.get(proof),
    plan = data?.prior.plan,
    authority = data && authorityWitnesses.get(data.prior.authority);
  if (
    !data ||
    !plan ||
    !authority ||
    data.backingConsumed ||
    data.db !== db ||
    state.get(db) !== data.config ||
    authority.staging !== staging ||
    data.prior.indexed !== proof ||
    !plan.consumed ||
    data.token !== currentTransactionToken(db) ||
    head !== stringifyRecordJson(plan.ref) + '\n' ||
    data.ref !== plan.ref ||
    data.commit !== plan.commit
  )
    fail('foreign installed backing transition');
  data!.backingConsumed = true;
  return plan!.versions.map((version) => version.versionId);
}
/** A count derived only from actual fixed index writes, never observed drift. */
export function recordIndexedPublicationWrites(
  db: Database,
  proof: RecordIndexedPublication,
  original: RecordAuthorityWitness,
): number {
  const data = indexedPublications.get(proof);
  if (
    !data ||
    data.db !== db ||
    data.prior.authority !== original ||
    data.prior.indexed !== proof ||
    data.token !== currentTransactionToken(db) ||
    data.prior.expectedWrites === undefined ||
    data.prior.indexedWrites === undefined
  )
    fail('foreign indexed compact publication');
  return data!.prior.expectedWrites! + data!.prior.indexedWrites!;
}
/** Exact indexed transition, while physical acceptance still names original HEAD. */
export function recordIndexedPublicationCurrent(
  db: Database,
  proof: RecordIndexedPublication,
  original: RecordAuthorityWitness,
): boolean {
  recordIndexedPublicationWrites(db, proof, original);
  const data = indexedPublications.get(proof)!,
    authority = authorityWitnesses.get(original)!;
  if (state.get(db) !== data.config || !recordAuthorityWitnessIntervalCurrent(db, original))
    return false;
  const indexed = readStatusRow(db),
    expected = data.prior.newSource!;
  if (
    indexed.profile_id !== data.config.profileId ||
    indexed.projection !== PROJECTION ||
    indexed.schema_version !== data.config.schemaVersion ||
    indexed.sequence !== data.commit.sequence ||
    indexed.head_json !== stringifyRecordJson(data.ref)
  )
    return false;
  const transaction = terminalStatement(
    db,
    'SELECT * FROM __record_transactions WHERE sequence=?',
  ).get(data.commit.sequence);
  if (
    !transaction ||
    transaction.operation_id !== data.commit.operationId ||
    transaction.fingerprint !== data.commit.fingerprint ||
    transaction.result_json !== stringifyRecordJson(data.commit.result) ||
    transaction.commit_json !== stringifyRecordJson(data.commit)
  )
    return false;
  const selected = terminalStatement(
    db,
    'SELECT version_id FROM __record_current WHERE entity=? AND record_id=?',
  ).get('source_files', data.prior.recordId);
  const version = terminalStatement(db, 'SELECT * FROM __record_versions WHERE version_id=?').get(
    expected.versionId,
  );
  if (
    selected?.version_id !== expected.versionId ||
    !version ||
    version.profile_id !== data.config.profileId ||
    version.entity !== 'source_files' ||
    version.record_id !== data.prior.recordId ||
    version.sequence !== data.commit.sequence ||
    version.recorded_at !== data.commit.recordedAt ||
    version.previous_version !== data.prior.versionId ||
    version.operation_id !== data.commit.operationId ||
    version.deleted !== 0 ||
    version.contents_json !== expected.contents ||
    version.metadata_json !== expected.metadata
  )
    return false;
  return (
    eq(readConfiguredHead(db, data.config), authority.head) &&
    recordAuthorityWitnessIntervalCurrent(db, original)
  );
}
export interface RecordSourcePriorFields {
  readonly [priorFieldsBrand]: true;
}
interface SourcePriorData {
  db: Database;
  authority: RecordAuthorityWitness;
  methods: object;
  recordId: string;
  versionId: string;
  contents: string;
  fields: PreparedRecordPriorFields;
  assertCurrent(): void;
  consumed?: boolean;
  expectedWrites?: number;
  indexedWrites?: number;
  newSource?: { versionId: string; contents: string; metadata: string };
  indexed?: RecordIndexedPublication;
  plan?: {
    pending: readonly PendingRecordVersion[];
    versions: readonly DurableRecordVersion[];
    ref: RecordObjectReference;
    commit: RecordCommitV2;
    operation: { operationId: string; fingerprint: string; result: unknown };
    consumed: boolean;
    deferredTerminal?: boolean;
  };
}
const sourcePriorFields = new WeakMap<RecordSourcePriorFields, SourcePriorData>();
declare const compactReadmissionBrand: unique symbol;
export interface RecordCompactReadmission {
  readonly [compactReadmissionBrand]: true;
}
const compactReadmissions = new WeakMap<RecordCompactReadmission, SourcePriorData>();
/** Retain the exact privately prepared successor across preparation disposal.
 * This does not admit any operation until its lexical HEAD installation succeeds. */
export function prepareRecordCompactReadmission(
  db: Database,
  capability: RecordSourcePriorFields,
): RecordCompactReadmission {
  const prior = sourcePriorFields.get(capability),
    authority = prior && authorityWitnesses.get(prior.authority);
  if (!prior || prior.db !== db || !authority || prior.consumed || prior.plan?.consumed)
    fail('compact readmission preparation unavailable');
  const proof = Object.freeze({}) as RecordCompactReadmission;
  compactReadmissions.set(proof, prior!);
  return proof;
}
/** A new-operation readback, not continuation credit for the revoked old proof.
 * Its caller must independently watch all attempts throughout observer installation. */
export function assertRecordCompactReadmission(
  db: Database,
  proof: RecordCompactReadmission,
): void {
  const prior = compactReadmissions.get(proof),
    authority = prior && authorityWitnesses.get(prior.authority),
    indexed = prior?.indexed && indexedPublications.get(prior.indexed),
    expected = prior?.newSource;
  const identity = () => {
    const read = authority && ownDescriptor(authority.config.storage, 'read');
    if (
      !prior ||
      !authority ||
      !indexed ||
      !expected ||
      prior.db !== db ||
      !db.isOpen ||
      db.isTransaction ||
      state.get(db) !== authority.config ||
      !indexed.installed ||
      (authority.staging && (!prior.plan?.consumed || !indexed.backingConsumed)) ||
      indexed.prior !== prior ||
      (prior.plan && (indexed.commit !== prior.plan.commit || indexed.ref !== prior.plan.ref)) ||
      !read ||
      !('value' in read) ||
      read.value !== authority.read
    )
      fail('committed compact readmission unavailable');
  };
  identity();
  const commit = indexed!.commit,
    ref = indexed!.ref;
  const get = (sql: string, ...args: SQLInputValue[]) =>
    Reflect.apply(readmissionGet, Reflect.apply(readmissionPrepare, db, [sql]), args) as
      SqliteRow | undefined;
  const status = get('SELECT * FROM main.__record_state WHERE singleton=1'),
    transaction = get('SELECT * FROM main.__record_transactions WHERE sequence=?', commit.sequence),
    selected = get(
      'SELECT version_id FROM main.__record_current WHERE entity=? AND record_id=?',
      'source_files',
      prior!.recordId,
    ),
    version = get('SELECT * FROM main.__record_versions WHERE version_id=?', expected!.versionId),
    source = get(
      'SELECT * FROM main.source_files WHERE id=?',
      parseRecordJson<SQLInputValue[]>(prior!.recordId)[0]!,
    );
  if (
    status?.profile_id !== authority!.config.profileId ||
    status.projection !== PROJECTION ||
    status.schema_version !== authority!.config.schemaVersion ||
    status.sequence !== commit.sequence ||
    status.head_json !== stringifyRecordJson(ref) ||
    transaction?.operation_id !== commit.operationId ||
    transaction.fingerprint !== commit.fingerprint ||
    transaction.result_json !== stringifyRecordJson(commit.result) ||
    transaction.commit_json !== stringifyRecordJson(commit) ||
    selected?.version_id !== expected!.versionId ||
    version?.profile_id !== authority!.config.profileId ||
    version.entity !== 'source_files' ||
    version.record_id !== prior!.recordId ||
    version.sequence !== commit.sequence ||
    version.recorded_at !== commit.recordedAt ||
    version.previous_version !== prior!.versionId ||
    version.operation_id !== commit.operationId ||
    version.deleted !== 0 ||
    version.contents_json !== expected!.contents ||
    version.metadata_json !== expected!.metadata ||
    !source ||
    stringifyRecordJson(source) !== expected!.contents ||
    !eq(readHead(authority!.config.storage, authority!.read), ref)
  )
    fail('committed compact readmission changed');
  identity();
}
interface CompactTerminal {
  readonly prior: SourcePriorData;
  readonly statements: PreparedTerminalStatements;
  readonly callbacks: TerminalTransactionCallbacks;
  readonly capture: IntakeFrontierCaptureClear;
  readonly owner: RecordCompactTerminalOwner;
}
declare const terminalOwnerBrand: unique symbol;
export interface RecordCompactTerminalOwner {
  readonly [terminalOwnerBrand]: true;
}
const compactTerminalOwners = new WeakMap<
  RecordCompactTerminalOwner,
  {
    db: Database;
    profileId: string;
    operation: ClinicalOperation;
    staging: VaultRecordStagingWitness;
    assertions: readonly (() => void)[];
    authorization?: VaultCompactAuthorization;
    issuers: {
      request: typeof import('./index.ts').requestFilenameAssertionCurrent;
      assistant: typeof import('./assistant.ts').assistantCompactAssertionPrerequisites;
      session: typeof import('./intake-package-session.ts').packageSessionAssertionPrerequisites;
      originalSource: typeof import('./intake-package-session.ts').packageSessionOriginalPhysicalSource;
      authorization: typeof import('./vault-app.ts').vaultCompactAuthorizationCurrent;
    };
  }
>();
/** Genuine issuer state only; no callback/SQL/storage reads at the last worker. */
export function recordCompactTerminalOwnerCurrent(
  owner: RecordCompactTerminalOwner,
  db: Database,
  staging: VaultRecordStagingWitness,
): boolean {
  const proof = compactTerminalOwners.get(owner);
  if (!proof || proof.db !== db || proof.staging !== staging) return false;
  try {
    assertClinicalOperation(db, proof.operation);
  } catch {
    return false;
  }
  if (proof.authorization && !proof.issuers.authorization(proof.authorization, db, proof.profileId))
    return false;
  const visiting = new Set<() => void>();
  const current = (assertion: () => void): boolean => {
    if (visiting.has(assertion)) return false;
    if (proof.issuers.request(assertion, db)) return true;
    const prerequisites =
      proof.issuers.assistant(assertion, db) ?? proof.issuers.session(assertion, db);
    if (!prerequisites) return false;
    visiting.add(assertion);
    try {
      for (let index = 0; index < prerequisites.length; index++)
        if (!current(prerequisites[index]!)) return false;
      return true;
    } finally {
      visiting.delete(assertion);
    }
  };
  for (let index = 0; index < proof.assertions.length; index++)
    if (!current(proof.assertions[index]!)) return false;
  return true;
}
const activeCompactTerminal = new WeakMap<Database, CompactTerminal>();
/** Original open-time evidence is transported only from genuine active issuers. */
export function* recordCompactTerminalOriginalSources(
  owner: RecordCompactTerminalOwner,
  db: Database,
  staging: VaultRecordStagingWitness,
): Generator<PackageSourceOriginalPhysical> {
  if (!recordCompactTerminalOwnerCurrent(owner, db, staging))
    fail('compact original source owner expired');
  const proof = compactTerminalOwners.get(owner)!;
  const visited = new Set<() => void>();
  function* visit(assertion: () => void): Generator<PackageSourceOriginalPhysical> {
    if (visited.has(assertion)) return;
    visited.add(assertion);
    const source = proof.issuers.originalSource(assertion, db);
    if (source) {
      if (source.binding.profileId !== proof.profileId)
        fail('compact original source profile differs');
      yield source;
    }
    const prerequisites =
      proof.issuers.assistant(assertion, db) ?? proof.issuers.session(assertion, db);
    if (prerequisites)
      for (let index = 0; index < prerequisites.length; index++)
        yield* visit(prerequisites[index]!);
  }
  for (let index = 0; index < proof.assertions.length; index++) {
    yield* visit(proof.assertions[index]!);
    if (!recordCompactTerminalOwnerCurrent(owner, db, staging))
      fail('compact original source issuer changed');
  }
}
const preparedCompactTerminals = new WeakMap<RecordSourcePriorFields, CompactTerminal>();
/** The accepted record owner selects the finite inventory; caller statement
 * capabilities cannot authorize a compact publication. */
export async function prepareRecordCompactTerminal(
  db: Database,
  capability: RecordSourcePriorFields,
): Promise<boolean> {
  const prior = sourcePriorFields.get(capability)!,
    plan = prior?.plan,
    authority = prior && authorityWitnesses.get(prior.authority),
    staging = authority?.staging,
    operation = currentClinicalOperation(db);
  if (!prior || prior.db !== db || prior.consumed || !authority)
    fail('foreign compact terminal preparation');
  if (!staging) return false;
  if (!operation || !plan?.deferredTerminal || preparedCompactTerminals.has(capability))
    fail('compact terminal preparation lifetime');
  // Application issuers load only on this async path, not record/database startup.
  prior.assertCurrent();
  const requestIssuer = await import('./index.ts'),
    assistantIssuer = await import('./assistant.ts'),
    sessionIssuer = await import('./intake-package-session.ts'),
    authorizationIssuer = await import('./vault-app.ts');
  prior.assertCurrent();
  assertClinicalOperation(db, operation);
  if (sourcePriorFields.get(capability) !== prior || prior.consumed || prior.plan !== plan)
    fail('compact terminal preparation changed while loading issuers');
  const owner = Object.freeze({}) as RecordCompactTerminalOwner;
  compactTerminalOwners.set(owner, {
    db,
    profileId: authority.config.profileId,
    operation: operation!,
    staging,
    assertions: clinicalOperationCallerAssertions(db, operation!),
    authorization: authorizationIssuer.currentVaultCompactAuthorization(
      db,
      authority.config.profileId,
    ),
    issuers: {
      request: requestIssuer.requestFilenameAssertionCurrent,
      assistant: assistantIssuer.assistantCompactAssertionPrerequisites,
      session: sessionIssuer.packageSessionAssertionPrerequisites,
      originalSource: sessionIssuer.packageSessionOriginalPhysicalSource,
      authorization: authorizationIssuer.vaultCompactAuthorizationCurrent,
    },
  });
  if (!recordCompactTerminalOwnerCurrent(owner, db, staging))
    fail('compact publication requires a genuine current owner issuer');
  const dynamic = ['source_files', 'app_meta'].map((entity) => {
    const table = authority.config.schema.find((item) => item.name === entity)!;
    return `SELECT * FROM ${q(entity)} WHERE ${table.pk.map((key) => q(key) + '=?').join(' AND ')}`;
  });
  const authorityQuery = DatabaseSync.prototype.prepare.call(
    db,
    "SELECT 1 FROM sqlite_temp_schema WHERE type='table' AND name='__intake_lookup_authorities'",
  );
  if (Reflect.apply(StatementSync.prototype.get, authorityQuery, []))
    dynamic.push(
      'SELECT source_id FROM temp.__intake_lookup_authorities WHERE authority_key=? LIMIT 2',
      'SELECT 1 FROM temp.__intake_lookup_dirty WHERE source_id=?',
    );
  const statements = prepareTerminalStatements(db, {
    statements: [
      ...compactTerminalSql.map((sql) => ({ sql })),
      ...dynamic.map((sql) => ({ sql })),
      ...Array.from({ length: 32 }, (_, index) => ({
        sql:
          'INSERT INTO __record_fields VALUES' +
          Array(index + 1)
            .fill('(?,?,?,?,?,?,?,?,?)')
            .join(','),
      })),
      ...compactTerminalBigIntSql.map((sql) => ({ sql, bigInts: true })),
    ],
    executions: compactTerminalExecutions,
  });
  const capture = prepareIntakeFrontierCaptureClear(db),
    callbacks = prepareTerminalTransactionCallbacks(db);
  // All compilation/caller effects precede verification of the ORIGINAL roster.
  prior.assertCurrent();
  assertClinicalOperation(db, operation);
  await finishVaultRecordStagingPreparation(staging, owner);
  assertClinicalOperation(db, operation);
  if (
    !terminalTransactionCallbacksCurrent(db, callbacks) ||
    !recordCompactTerminalOwnerCurrent(owner, db, staging) ||
    sourcePriorFields.get(capability) !== prior ||
    prior.consumed ||
    prior.plan !== plan
  )
    fail('compact terminal owner changed during worker');
  preparedCompactTerminals.set(capability, { prior, statements, callbacks, capture, owner });
  return true;
}
export function withRecordCompactTerminal<T>(
  db: Database,
  capability: RecordSourcePriorFields,
  run: () => T,
): T {
  const terminal = preparedCompactTerminals.get(capability)!;
  preparedCompactTerminals.delete(capability);
  if (
    !terminal ||
    terminal.prior.db !== db ||
    sourcePriorFields.get(capability) !== terminal.prior ||
    activeCompactTerminal.has(db) ||
    !terminalTransactionCallbacksCurrent(db, terminal.callbacks)
  )
    fail('foreign or expired compact terminal publication');
  activeCompactTerminal.set(db, terminal);
  try {
    return withTerminalStatements(db, terminal.statements, () => {
      if (!terminalTransactionCallbacksCurrent(db, terminal.callbacks))
        fail('compact transaction participants changed');
      const staging = authorityWitnesses.get(terminal.prior.authority)?.staging;
      if (!staging || !recordCompactTerminalOwnerCurrent(terminal.owner, db, staging))
        fail('compact publication owner expired');
      return run();
    });
  } finally {
    activeCompactTerminal.delete(db);
  }
}
/** This prepares changed immutable objects only. The issuing maintenance proof
 * must still admit the exact SQL transition and consume this private plan. */
export async function prepareRecordCompactPublication(
  db: Database,
  capability: RecordSourcePriorFields,
  input: {
    sourceRow: Readonly<Record<string, SQLOutputValue>>;
    target: string;
    headKey: string;
    afterHead: string;
    sourcePinKey: string;
    writes: readonly { key: string; value: string }[];
    operationId: string;
    fingerprint: string;
    result: unknown;
  },
  assertRunning: () => void,
  deferredTerminal = false,
): Promise<void> {
  const found = sourcePriorFields.get(capability),
    prior = found!,
    authority = prior && authorityWitnesses.get(prior.authority),
    staging = authority?.staging;
  if (!prior || prior.db !== db || prior.consumed || prior.plan || !authority)
    fail('foreign compact publication preparation');
  // Non-vault contributor adapters retain their original publication boundary.
  if (!staging) return;
  const config = authority.config;
  const check = () => {
    assertRunning();
    prior.assertCurrent();
    if (db.isTransaction || sourcePriorFields.get(capability) !== prior || prior.consumed)
      fail('compact immutable preparation expired');
  };
  check();
  const sourceColumns = config.schema.find((table) => table.name === 'source_files')!.columns,
    head = config.storage.read('head');
  if (!Buffer.isBuffer(head)) fail('compact accepted HEAD missing');
  await prepareVaultRecordStagingBacking(
    staging,
    head!.toString('utf8'),
    {
      sourceId: String(input.sourceRow.id),
      previousVersion: prior.versionId,
      preimage: await recordStringFieldDigest(prior.contents, check),
      fields: sourceColumns.map((name) => ({ name, ...prior.fields.get(name)! })),
      metadata: [input.headKey, input.sourcePinKey].map((key) => ({
        key,
        value: meta(db, key) as string | undefined,
      })),
    },
    check,
  );
  check();
  const pending: PendingRecordVersion[] = [],
    metadata = new Map(input.writes.map((row) => [row.key, row.value]));
  metadata.set(input.headKey, input.afterHead);
  metadata.set('revision', String(revision(db) + 1));
  if (meta(db, 'clinical_review_revision') === undefined)
    metadata.set('clinical_review_revision', String(revision(db)));
  let work = 0;
  for (const [key, value] of metadata) {
    check();
    const recordId = stringifyRecordJson([key]),
      previous = current(db, 'app_meta', recordId),
      existing = meta(db, key) as string | undefined;
    await assertVaultRecordMetadataPrior(
      staging,
      key,
      existing,
      previous && {
        versionId: previous.version_id,
        contents: previous.contents_json,
        deleted: previous.deleted,
      },
    );
    if (key === input.headKey || key === 'revision' || existing === undefined)
      pending.push({
        entity: 'app_meta',
        recordId,
        contents: { key, value },
        deleted: false,
        previousVersion: previous?.version_id ?? null,
      });
    else if (existing !== value) fail('compact immutable metadata preimage differs');
    if (++work % 64 === 0) await yieldHost();
  }
  const contents: Record<string, unknown> = {};
  for (const column of sourceColumns)
    contents[column] = column === 'details_json' ? input.target : input.sourceRow[column];
  pending.push({
    entity: 'source_files',
    recordId: prior.recordId,
    contents,
    deleted: false,
    previousVersion: prior.versionId,
  });
  pending.sort(
    (a, b) =>
      (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0) ||
      (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),
  );
  const sequence = readStatusRow(db).sequence + 1,
    recordedAt = new Date().toISOString(),
    operationId = input.operationId;
  let segmentHead: RecordObjectReference | null = null,
    segmentCount = 0,
    page: RecordObjectReference[] = [],
    chunks: Buffer[] = [],
    size = 0;
  const stage = async (bytes: Buffer): Promise<RecordObjectReference> => {
    check();
    const ref = writeObject(config.storage, bytes, prior);
    await yieldHost();
    check();
    return ref;
  };
  const flushPage = async () => {
    if (!page.length) return;
    const value: RecordSegmentPage = {
      format: 'health-record-segment-page-v1',
      profileId: config.profileId,
      schemaVersion: config.schemaVersion,
      sequence,
      operationId,
      previous: segmentHead,
      firstSegment: segmentCount - page.length,
      segments: page,
    };
    const bytes = encode(value);
    if (bytes.length > SEGMENT_PAGE_BYTES) fail('compact segment page exceeds controlled format');
    segmentHead = await stage(bytes);
    recordVersionWork('segmentIndexPagesWritten');
    page = [];
  };
  const flush = async () => {
    if (!size) return;
    page.push(await stage(Buffer.concat(chunks)));
    chunks = [];
    size = 0;
    segmentCount++;
    recordVersionWorkMaximum('maxSegmentReferencesBuffered', page.length);
    if (page.length === SEGMENT_REFERENCE_WINDOW) await flushPage();
  };
  const versions: DurableRecordVersion[] = [];
  for (const record of pending) {
    check();
    const version: DurableRecordVersion = {
      format: FORMAT,
      profileId: config.profileId,
      schemaVersion: config.schemaVersion,
      sequence,
      recordedAt,
      operationId,
      versionId: randomUUID(),
      actor: 'intake-state',
      origin: null,
      references: null,
      ...record,
    };
    versions.push(version);
    // The worker verified original references from authenticated history. This
    // derivative changes only metadata, not any original path/hash/byte column.
    const bytes = encode(version);
    for (let offset = 0; offset < bytes.length;) {
      const take = Math.min(config.segmentBytes - size, bytes.length - offset);
      chunks.push(bytes.subarray(offset, offset + take));
      size += take;
      offset += take;
      if (size === config.segmentBytes) await flush();
    }
  }
  await flush();
  await flushPage();
  const commit: RecordCommitV2 = {
    format: COMMIT_FORMAT,
    profileId: config.profileId,
    schemaVersion: config.schemaVersion,
    sequence,
    revision: revision(db) + 1,
    previous: authority.head,
    operationId,
    fingerprint: input.fingerprint,
    result: structuredClone(input.result),
    recordedAt,
    segments: { format: 'health-record-segment-index-v1', head: segmentHead, count: segmentCount },
    records: pending.length,
  };
  const ref = await stage(encode(commit));
  await prepareVaultRecordBackingAdvance(staging, encode(ref).toString('utf8'), versions);
  if (!deferredTerminal) await finishVaultRecordStagingPreparation(staging);
  check();
  prior.plan = {
    pending,
    versions,
    ref,
    commit,
    operation: {
      operationId,
      fingerprint: input.fingerprint,
      result: structuredClone(input.result),
    },
    consumed: false,
    deferredTerminal,
  };
}
async function parsePreparedRecordVersion(
  raw: string,
  check: () => void,
): Promise<DurableRecordVersion> {
  if (raw.length <= 16 * 1024) return parseRecordJson<DurableRecordVersion>(raw);
  recordVersionWork('parseCalls');
  const pieces = function* () {
    for (const piece of rawRecordPieces(raw)) {
      recordVersionWork('parsedBytes', Buffer.byteLength(piece));
      yield piece;
    }
  };
  const steps = parseRecordJsonPiecesSteps(pieces(), { assertRunning: check });
  try {
    for (;;) {
      check();
      const next = steps.next();
      check();
      if (next.done) return next.value as DurableRecordVersion;
      await yieldHost();
    }
  } finally {
    steps.return(undefined as never);
  }
}
async function stringifyPreparedRecordContents(
  contents: Record<string, unknown>,
  check: () => void,
): Promise<string> {
  // The final SQLite scalar still materializes once, but escaping a large
  // source string does not monopolize the host before that bind.
  const pieces: string[] = [];
  recordVersionWork('serializationCalls');
  for (const piece of sourcePreimagePieces(contents)) {
    check();
    pieces.push(piece);
    recordVersionWork('serializedBytes', Buffer.byteLength(piece));
    await yieldHost();
  }
  check();
  const result = pieces.join('');
  check();
  return result;
}
function* sourcePreimagePieces(contents: Record<string, unknown>): Generator<string> {
  yield '{';
  let first = true;
  for (const name of Object.keys(contents)) {
    if (!first) yield ',';
    first = false;
    yield JSON.stringify(name) + ':';
    const value = contents[name];
    if (typeof value !== 'string') {
      yield stringifyRecordJson(value);
      continue;
    }
    yield '"';
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(offset + 4096, value.length);
      if (
        end < value.length &&
        value.charCodeAt(end - 1) >= 0xd800 &&
        value.charCodeAt(end - 1) <= 0xdbff &&
        value.charCodeAt(end) >= 0xdc00 &&
        value.charCodeAt(end) <= 0xdfff
      )
        end++;
      yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
      offset = end;
    }
    yield '"';
  }
  yield '}';
}
async function digestRecordPieces(pieces: Iterable<string>, check: () => void) {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const piece of pieces) {
    check();
    hash.update(piece);
    bytes += Buffer.byteLength(piece);
    await yieldHost();
    check();
  }
  return { hash: hash.digest('hex'), bytes };
}
function* rawRecordPieces(raw: string): Generator<string> {
  for (let offset = 0; offset < raw.length;) {
    let end = Math.min(offset + 4096, raw.length);
    if (
      end < raw.length &&
      raw.charCodeAt(end - 1) >= 0xd800 &&
      raw.charCodeAt(end - 1) <= 0xdbff &&
      raw.charCodeAt(end) >= 0xdc00 &&
      raw.charCodeAt(end) <= 0xdfff
    )
      end++;
    yield raw.slice(offset, end);
    offset = end;
  }
}

/** SQL version rows are locators only. On an uncertified contributor adapter,
 * prove the latest selected preimage from its original accepted object chain. */
async function authenticateSelectedSourcePrior(
  config: RecordConfig,
  head: RecordObjectReference | null,
  recordId: string,
  previous: CurrentVersionRow,
  check: () => void,
): Promise<void> {
  let ref = head,
    expectedSequence: number | undefined;
  const table = config.schema.find((table) => table.name === 'source_files')!;
  while (ref) {
    check();
    const commit = readCommit(config.storage, ref, config.profileId, config.schemaVersion);
    check();
    if (expectedSequence !== undefined && commit.sequence !== expectedSequence)
      fail('accepted source ancestry sequence');
    expectedSequence = commit.sequence - 1;
    const segments = function* () {
      for (const segment of iterateRecordCommitSegments(config.storage, commit)) {
        check();
        const bytes = readObject(config.storage, segment);
        check();
        yield bytes;
      }
    };
    let count = 0,
      selected: { hash: string; bytes: number } | undefined;
    const identities = versionIdentityIndex();
    const steps = readRecordJsonLinesSteps(segments(), { parseSmall: parseRecordJson });
    try {
      for (;;) {
        check();
        const next = steps.next();
        check();
        if (next.done) break;
        if (next.value) {
          count++;
          const version = next.value.record as DurableRecordVersion;
          const shape = config.schema.find((table) => table.name === version?.entity);
          if (
            !shape ||
            version.format !== FORMAT ||
            version.profileId !== config.profileId ||
            version.schemaVersion !== config.schemaVersion ||
            version.sequence !== commit.sequence ||
            version.operationId !== commit.operationId ||
            version.recordedAt !== commit.recordedAt ||
            !/^[0-9a-f-]{36}$/.test(version.versionId) ||
            typeof version.deleted !== 'boolean' ||
            !version.contents ||
            typeof version.contents !== 'object' ||
            Array.isArray(version.contents) ||
            !eq(Object.keys(version.contents).sort(), [...shape.columns].sort()) ||
            identity(shape, version.contents) !== version.recordId ||
            (shape.name === 'app_meta' && internalKey(version.contents.key as string))
          )
            fail('invalid complete accepted source transaction record');
          const identityKey = stringifyRecordJson([version.entity, version.recordId]);
          if (identities.has(identityKey)) fail('duplicate record in accepted source transaction');
          identities.add(identityKey);
          if (version?.entity === 'source_files' && version.recordId === recordId) {
            if (
              selected ||
              version.deleted ||
              version.versionId !== previous.version_id ||
              version.format !== FORMAT ||
              version.profileId !== config.profileId ||
              version.schemaVersion !== config.schemaVersion ||
              version.sequence !== commit.sequence ||
              version.operationId !== commit.operationId ||
              version.recordedAt !== commit.recordedAt ||
              !version.contents ||
              typeof version.contents !== 'object' ||
              Array.isArray(version.contents) ||
              !eq(Object.keys(version.contents).sort(), [...table.columns].sort()) ||
              identity(table, version.contents) !== recordId
            )
              fail('selected source differs from accepted prior version');
            selected = await digestRecordPieces(sourcePreimagePieces(version.contents), check);
          }
        }
        await yieldHost();
        check();
      }
    } finally {
      try {
        steps.return(undefined);
      } finally {
        identities.close();
      }
    }
    if (count !== commit.records) fail('partial accepted source transaction');
    if (selected) {
      const pieces = function* () {
        for (let offset = 0; offset < previous.contents_json.length;) {
          let end = Math.min(offset + 4096, previous.contents_json.length);
          if (
            end < previous.contents_json.length &&
            previous.contents_json.charCodeAt(end - 1) >= 0xd800 &&
            previous.contents_json.charCodeAt(end - 1) <= 0xdbff &&
            previous.contents_json.charCodeAt(end) >= 0xdc00 &&
            previous.contents_json.charCodeAt(end) <= 0xdfff
          )
            end++;
          yield previous.contents_json.slice(offset, end);
          offset = end;
        }
      };
      const cached = await digestRecordPieces(pieces(), check);
      if (selected.hash !== cached.hash || selected.bytes !== cached.bytes)
        fail('source preimage differs from accepted immutable history');
      check();
      return;
    }
    ref = commit.previous;
    await yieldHost();
    check();
  }
  fail('selected source absent from accepted history');
}

export async function prepareRecordSourcePriorFields(
  db: Database,
  sourceId: string,
  assertRunning: () => void,
  sourceRow: Readonly<Record<string, SQLOutputValue>>,
  originalAuthority?: RecordAuthorityWitness,
): Promise<RecordSourcePriorFields> {
  assertRunning();
  const authority = originalAuthority ?? captureRecordAuthorityWitness(db),
    methods = managedDatabaseMethodEpoch(db),
    recordId = stringifyRecordJson([sourceId]),
    previous = current(db, 'source_files', recordId),
    writes = db.prepare('SELECT total_changes() AS n').get()!.n;
  if (!methods || !previous || previous.deleted) fail('prior source comparison unavailable');
  const authorityData = authorityWitnesses.get(authority);
  if (!authorityData || !recordAuthorityWitnessCurrent(db, authority))
    fail('foreign original source authority');
  if (authorityData!.staging) fail('original source staging already prepared');
  authorityData!.staging = captureVaultRecordStaging(
    db,
    authorityData!.config.storage,
    authorityData!.epoch,
  );
  const check = () => {
    assertRunning();
    if (
      !recordAuthorityWitnessCurrent(db, authority) ||
      managedDatabaseMethodEpoch(db) !== methods ||
      db.prepare('SELECT total_changes() AS n').get()!.n !== writes
    )
      fail('prior source comparison authority changed');
  };
  if (!authorityData!.staging)
    await authenticateSelectedSourcePrior(
      authorityData!.config,
      authorityData!.head,
      recordId,
      previous!,
      check,
    );
  const fields = await prepareRecordPriorFields([previous!.contents_json], check);
  try {
    check();
    const columns = authorityData!.config.schema.find(
      (table) => table.name === 'source_files',
    )!.columns;
    for (const column of columns) {
      const value = sourceRow[column];
      const expected =
        typeof value === 'string'
          ? await recordStringFieldDigest(value, check)
          : recordFieldDigest(stringifyRecordJson(value));
      const accepted = fields.get(column);
      if (!accepted || accepted.hash !== expected.hash || accepted.bytes !== expected.bytes)
        fail('compact source differs from its accepted prior version');
      check();
    }
    const retained = db
      .prepare(
        'SELECT 1 FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=? AND v.version_id=? AND v.contents_json IS ? AND v.deleted=0',
      )
      .get('source_files', recordId, previous!.version_id, previous!.contents_json);
    if (!retained) fail('prior source comparison changed');
    const capability = Object.freeze({}) as RecordSourcePriorFields;
    sourcePriorFields.set(capability, {
      db,
      authority,
      methods: methods!,
      recordId,
      versionId: previous!.version_id,
      contents: previous!.contents_json,
      fields,
      assertCurrent: check,
    });
    return capability;
  } catch (error) {
    fields.close();
    throw error;
  }
}
export function discardRecordSourcePriorFields(capability: RecordSourcePriorFields): void {
  const data = sourcePriorFields.get(capability);
  sourcePriorFields.delete(capability);
  data?.fields.close();
  const staging = data && authorityWitnesses.get(data.authority)?.staging;
  if (staging) discardVaultRecordStaging(staging);
}
function consumeRecordSourcePriorFields(
  db: Database,
  capability: RecordSourcePriorFields,
): SourcePriorData {
  const data = sourcePriorFields.get(capability);
  if (
    !data ||
    data.db !== db ||
    data.consumed ||
    (authorityWitnesses.get(data.authority)?.staging && !data.plan) ||
    !recordAuthorityWitnessCurrent(db, data.authority) ||
    managedDatabaseMethodEpoch(db) !== data.methods ||
    !terminalStatement(
      db,
      'SELECT 1 FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=? AND v.version_id=? AND v.contents_json IS ? AND v.deleted=0',
    ).get('source_files', data.recordId, data.versionId, data.contents)
  )
    fail('foreign, expired or changed prior source comparison');
  data!.consumed = true;
  return data!;
}
export interface RecordAuthorityWitness {
  readonly [authorityWitnessBrand]: true;
}
declare const recordReadOwnerBrand: unique symbol;
export interface RecordReadOwner {
  readonly [recordReadOwnerBrand]: true;
}
const recordReadOwners = new WeakMap<
  RecordReadOwner,
  {
    db: Database;
    config: RecordConfig;
    methods: object;
    read: RecordStorage['read'];
    status: StatementSync;
    row: string;
    head: RecordObjectReference | null;
    wire: string | null;
    vault?: VaultRecordReadOwner;
    contributor?: ContributorRecordReadOwner;
    legacyBridgeScope?: ContributorLegacyBridgeBackingScope;
  }
>();
/** Factory recognition only, not validity or a fallback on genuine drift. */
export function recordReadOwnerSupported(db: Database, profileId: string): boolean {
  const config = state.get(db);
  return (
    !!config &&
    config.profileId === profileId &&
    (vaultRecordReadOwnerSupported(config.storage) ||
      contributorRecordReadOwnerSupported(config.storage))
  );
}
/** Capture at read entry, before rendering or caller effects. Only actual
 * registered storage factories can bind their original durable HEAD paths. */
export function captureRecordReadOwner(db: Database, profileId: string): RecordReadOwner {
  const config = state.get(db),
    methods = managedDatabaseMethodEpoch(db),
    read = config && ownDescriptor(config.storage, 'read');
  if (
    !config ||
    config.profileId !== profileId ||
    !methods ||
    db.isTransaction ||
    !read ||
    !('value' in read) ||
    typeof read.value !== 'function'
  )
    fail('original record read owner unavailable');
  const vault = captureVaultRecordReadOwner(config!.storage),
    contributor = vault ? undefined : captureContributorRecordReadOwner(config!.storage);
  if (!vault && !contributor) fail('original record read owner requires a genuine storage factory');
  const owner = Object.freeze({}) as RecordReadOwner;
  try {
    const status = Reflect.apply(readmissionPrepare, db, [
        'SELECT * FROM main.__record_state WHERE singleton=1',
      ]),
      row = Reflect.apply(readmissionGet, status, []) as RecordStateRow | undefined,
      { head, wire } = readHeadBinding(config!.storage, read!.value);
    if (!row || !eq(head, parseRecordJson(row.head_json)))
      fail('original record read HEAD differs from its selected index');
    recordReadOwners.set(owner, {
      db,
      config: config!,
      methods: methods!,
      read: read!.value,
      status,
      row: stringifyRecordJson(row),
      head,
      wire,
      vault,
      contributor,
    });
    assertRecordReadOwnerBeforeVerification(db, owner);
    return owner;
  } catch (error) {
    recordReadOwners.delete(owner);
    try {
      if (vault) closeVaultRecordReadOwner(vault);
    } finally {
      if (contributor) closeContributorRecordReadOwner(contributor);
    }
    throw error;
  }
}
function recordReadOwnerIntervalCurrent(db: Database, owner: RecordReadOwner): boolean {
  const proof = recordReadOwners.get(owner),
    read = proof && ownDescriptor(proof.config.storage, 'read');
  return (
    !!proof &&
    proof.db === db &&
    db.isOpen &&
    !db.isTransaction &&
    state.get(db) === proof.config &&
    managedDatabaseMethodEpoch(db) === proof.methods &&
    !!read &&
    'value' in read &&
    read.value === proof.read &&
    (proof.vault
      ? vaultRecordReadOwnerCurrent(proof.config.storage, proof.vault)
      : !!proof.contributor &&
        contributorRecordReadOwnerCurrent(proof.config.storage, proof.contributor))
  );
}
/** The outer result owner retains its separate native SQL-attempt seal. This
 * continuation checks only original factory/HEAD resources, never queries SQL. */
export function assertRecordReadOwnerInterval(db: Database, owner: RecordReadOwner): void {
  if (!recordReadOwnerIntervalCurrent(db, owner)) fail('original record read interval changed');
}
/** Real adapter effects are allowed only BEFORE the final original worker. */
export function assertRecordReadOwnerBeforeVerification(
  db: Database,
  owner: RecordReadOwner,
): void {
  const proof = recordReadOwners.get(owner);
  if (
    !recordReadOwnerIntervalCurrent(db, owner) ||
    stringifyRecordJson(Reflect.apply(readmissionGet, proof!.status, [])) !== proof!.row ||
    !eq(readHead(proof!.config.storage, proof!.read), proof!.head) ||
    !recordReadOwnerIntervalCurrent(db, owner)
  )
    fail('original record read authority changed');
}
/** Fixed native status read plus genuine factory HEAD/FD identities. The
 * enclosing finite transport rejects reprepare before any policy callback. */
export function assertRecordReadOwnerTerminal(db: Database, owner: RecordReadOwner): void {
  const proof = recordReadOwners.get(owner);
  if (
    !terminalStatementsActive(db) ||
    !recordReadOwnerIntervalCurrent(db, owner) ||
    stringifyRecordJson(Reflect.apply(readmissionGet, proof!.status, [])) !== proof!.row ||
    !recordReadOwnerIntervalCurrent(db, owner)
  )
    fail('original record read terminal authority changed');
}
export function closeRecordReadOwner(owner: RecordReadOwner): void {
  const proof = recordReadOwners.get(owner);
  recordReadOwners.delete(owner);
  if (!proof) return;
  try {
    if (proof.vault) closeVaultRecordReadOwner(proof.vault);
  } finally {
    if (proof.contributor) closeContributorRecordReadOwner(proof.contributor);
  }
}
/** Only the registered contributor HEAD factory can narrow an original bridge
 * read against unrelated physical writes. Other adapters retain the global guard. */
export function captureContributorLegacyBridgeRecordOwner(
  db: Database,
): RecordReadOwner | undefined {
  const config = state.get(db);
  if (!config || !contributorRecordReadOwnerSupported(config.storage)) return undefined;
  const scope =
    captureContributorLegacyBridgeBackingScopeForStorage(config.storage) ??
    fail('original contributor backing scope unavailable');
  const owner = captureRecordReadOwner(db, config.profileId);
  try {
    const proof =
      recordReadOwners.get(owner) ?? fail('original contributor record owner unavailable');
    const contributor = proof.contributor ?? fail('original contributor record owner unavailable');
    if (!bindContributorLegacyBridgeBackingScope(config.storage, contributor, scope))
      fail('original contributor backing scope changed during capture');
    proof.legacyBridgeScope = scope;
    assertContributorLegacyBridgeRecordOwner(db, owner);
    return owner;
  } catch (error) {
    closeRecordReadOwner(owner);
    throw error;
  }
}
/** Original contributor HEAD and indexed state, including inside the exact
 * maintenance transaction. The bridge separately seals its SQL write interval. */
export function assertContributorLegacyBridgeRecordOwner(
  db: Database,
  owner: RecordReadOwner,
  token?: object,
): void {
  const proof = recordReadOwners.get(owner);
  const current = () => {
    const read = proof && ownDescriptor(proof.config.storage, 'read');
    return (
      !!proof?.contributor &&
      !proof.vault &&
      proof.db === db &&
      db.isOpen &&
      (token ? db.isTransaction && currentTransactionToken(db) === token : !db.isTransaction) &&
      state.get(db) === proof.config &&
      managedDatabaseMethodEpoch(db) === proof.methods &&
      !!read &&
      'value' in read &&
      read.value === proof.read &&
      contributorRecordReadOwnerCurrent(proof.config.storage, proof.contributor) &&
      !!proof.legacyBridgeScope &&
      contributorLegacyBridgeBackingScopeCurrent(
        proof.config.storage,
        proof.contributor,
        proof.legacyBridgeScope,
      )
    );
  };
  if (
    !current() ||
    stringifyRecordJson(Reflect.apply(readmissionGet, proof!.status, [])) !== proof!.row ||
    !eq(readHead(proof!.config.storage, proof!.read), proof!.head) ||
    !current()
  )
    fail('original contributor record authority changed');
}
const authorityWitnesses = new WeakMap<
  RecordAuthorityWitness,
  {
    db: Database;
    config: RecordConfig;
    read: RecordStorage['read'];
    row: string;
    head: RecordObjectReference | null;
    epoch: object;
    staging?: VaultRecordStagingWitness;
  }
>();
/** Same configured authority and managed mutation interval only. This does not
 * replace off-host verification of the consumed immutable backing objects. */
export function captureRecordAuthorityWitness(db: Database): RecordAuthorityWitness {
  const config = state.get(db),
    epoch = captureManagedPhysicalEpoch();
  if (!config || !epoch || db.isTransaction) fail('record authority witness unavailable');
  const row = readStatusRow(db),
    head = readHead(config!.storage);
  if (!eq(head, parseRecordJson(row.head_json))) fail('record authority witness stale');
  const witness = Object.freeze({}) as RecordAuthorityWitness;
  authorityWitnesses.set(witness, {
    db,
    config: config!,
    read: config!.storage.read,
    row: stringifyRecordJson(row),
    head,
    epoch: epoch!,
  });
  if (!recordAuthorityWitnessCurrent(db, witness)) fail('record authority witness changed');
  return witness;
}
export function recordAuthorityWitnessCurrent(
  db: Database,
  witness: RecordAuthorityWitness,
): boolean {
  const proof = authorityWitnesses.get(witness);
  if (!recordAuthorityWitnessIntervalCurrent(db, witness)) return false;
  return (
    stringifyRecordJson(readStatusRow(db)) === proof!.row &&
    eq(readConfiguredHead(db, proof!.config), proof!.head) &&
    recordAuthorityWitnessIntervalCurrent(db, witness)
  );
}
/** Closing identity/interval check only: no SQL, filesystem or storage callback. */
export function recordAuthorityWitnessIntervalCurrent(
  db: Database,
  witness: RecordAuthorityWitness,
): boolean {
  const proof = authorityWitnesses.get(witness);
  const read = proof && ownDescriptor(proof.config.storage, 'read');
  return (
    !!proof &&
    proof.db === db &&
    db.isOpen &&
    state.get(db) === proof.config &&
    !!read &&
    'value' in read &&
    read.value === proof.read &&
    (proof.staging
      ? vaultRecordStagingCurrent(proof.staging)
      : managedPhysicalEpochCurrent(proof.epoch))
  );
}
export function flushRecordDurability(db: Database): RecordDurabilityStatus | null {
  const config = state.get(db);
  if (!config) fail('durability not attached');
  // App mutations must use transaction(). Refuse a snapshot-like backfill of
  // direct writes: it cannot supply the intended transaction or attribution.
  const row = db.prepare('SELECT * FROM __record_state WHERE singleton=1').get() as RecordStateRow;
  if (!eq(readHead(config!.storage), parseRecordJson(row.head_json)))
    fail('projection requires recovery');
  if (hasChanges(db, config!)) fail('uncommitted direct writes bypassed the transaction boundary');
  return recordDurabilityStatus(db);
}
export function rebuildRecordDatabase(path: string, options: AttachRecordDurabilityOptions = {}) {
  return withRecordVersionWorkPhase('reconstruction', () =>
    rebuildRecordDatabaseInside(path, options),
  );
}
function rebuildRecordDatabaseInside(
  path: string,
  { profileId, storage, verifyReferences }: AttachRecordDurabilityOptions = {},
) {
  if (existsSync(path)) fail('rebuild target must be new');
  validStorage(storage);
  if (!readHead(storage)) fail('no committed profile history');
  const db = openDatabase(path, profileId);
  try {
    attachRecordDurability(db, { profileId, storage, verifyReferences });
    const result = recordDurabilityStatus(db)!;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { ...result, database: path, profileId };
  } catch (error) {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    throw error;
  } finally {
    try {
      db.close();
    } catch {}
  }
}
function indexedVersion(config: RecordConfig, row: SqliteRow): DurableRecordVersion {
  recordVersionWork('indexedVersionValidations');
  const metadata = parseRecordJson(String(row.metadata_json)) as Omit<
    DurableRecordVersion,
    'contents'
  >;
  const contents = parseRecordJson(String(row.contents_json)) as Record<string, unknown>;
  const table = config.schema.find((table) => table.name === row.entity);
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join(',') !==
      'actor,deleted,entity,format,operationId,origin,previousVersion,profileId,recordId,recordedAt,references,schemaVersion,sequence,versionId' ||
    metadata.format !== FORMAT ||
    metadata.profileId !== config.profileId ||
    metadata.schemaVersion !== config.schemaVersion ||
    metadata.versionId !== row.version_id ||
    metadata.profileId !== row.profile_id ||
    metadata.entity !== row.entity ||
    metadata.recordId !== row.record_id ||
    metadata.sequence !== row.sequence ||
    metadata.operationId !== row.operation_id ||
    metadata.previousVersion !== row.previous_version ||
    metadata.recordedAt !== row.recorded_at ||
    typeof metadata.deleted !== 'boolean' ||
    Number(metadata.deleted) !== row.deleted ||
    !table ||
    !contents ||
    Array.isArray(contents) ||
    !eq(recordVersionColumns(Object.keys(contents)).sort(), [...table.columns].sort()) ||
    identity(table, contents) !== row.record_id
  )
    fail('invalid indexed version');
  return { ...metadata, contents };
}
/** Selected-version lookup for history consumers; never reads the immutable archive. */
export function readIndexedRecordVersion(
  db: Database,
  profileId: string,
  entity: string,
  recordId: string,
  versionId: string,
): DurableRecordVersion | undefined {
  const config = state.get(db);
  if (!config || config.profileId !== profileId || meta(db, 'owner_profile_id') !== profileId)
    fail('history requires the unlocked owning profile');
  const row = db
    .prepare(
      'SELECT * FROM __record_versions WHERE profile_id=? AND entity=? AND record_id=? AND version_id=? AND deleted=0',
    )
    .get(profileId, entity, recordId, versionId);
  return row ? indexedVersion(config!, row) : undefined;
}
/** Indexed history; recordId is the literal single PK or array for compound PK.
 * A field such as profile_json.birthDate queries nested JSON with absence and
 * null preserved. No storage reads or full-archive replay are performed here.
 */
export function queryRecordHistory(
  db: Database,
  {
    profileId,
    entity,
    recordId,
    field,
    beforeSequence = Number.MAX_SAFE_INTEGER,
    limit = 50,
  }: QueryRecordHistoryOptions = {},
): RecordHistoryResult {
  if (
    !state.has(db) ||
    state.get(db)!.profileId !== profileId ||
    meta(db, 'owner_profile_id') !== profileId
  )
    fail('history requires the unlocked owning profile');
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(beforeSequence) ||
    beforeSequence < 1
  )
    fail('invalid history pagination');
  const params: SQLInputValue[] = [
    profileId as string,
    entity as string,
    stringifyRecordJson(Array.isArray(recordId) ? recordId : [recordId]),
    beforeSequence,
  ];
  let sql =
    'SELECT v.version_id FROM __record_versions v WHERE v.profile_id=? AND v.entity=? AND v.record_id=? AND v.sequence<?';
  if (field !== undefined) {
    const fieldReference =
      'EXISTS(SELECT 1 FROM __record_fields f WHERE f.version_id=v.version_id AND f.field=?)';
    sql +=
      entity === 'app_meta' && (field === 'key' || field === 'value')
        ? ` AND (${fieldReference} OR (v.previous_version IS NULL AND v.deleted=0))`
        : ` AND ${fieldReference}`;
    params.push(field);
  }
  sql += ' ORDER BY v.sequence DESC LIMIT ?';
  params.push(limit + 1);
  const rows = db.prepare(sql).all(...params),
    more = rows.length > limit;
  const config = state.get(db)!;
  const entries: RecordHistoryEntry[] = rows.slice(0, limit).map((selected) => {
    const row = db
      .prepare('SELECT * FROM __record_versions WHERE version_id=?')
      .get(selected.version_id);
    if (!row) fail('missing indexed version');
    const version = indexedVersion(config, row!);
    const priorRow = version.previousVersion
      ? db
          .prepare('SELECT * FROM __record_versions WHERE version_id=?')
          .get(version.previousVersion)
      : undefined;
    if (version.previousVersion && !priorRow) fail('missing indexed previous version');
    const prior = priorRow ? indexedVersion(config, priorRow) : undefined;
    if (
      prior &&
      (prior.entity !== version.entity ||
        prior.recordId !== version.recordId ||
        prior.sequence >= version.sequence)
    )
      fail('invalid indexed previous version');
    const before = values(prior && !prior.deleted ? prior.contents : null);
    const after = values(version.deleted ? null : version.contents);
    const storedChanges = db
      .prepare('SELECT * FROM __record_fields WHERE version_id=? ORDER BY field')
      .all(version.versionId);
    const implicitFields = implicitInitialMetadataFields(version);
    if (implicitFields && storedChanges.length) fail('unexpected indexed field reference');
    const changes: RecordFieldChange[] = implicitFields
      ? [...after.keys()].sort().map((field) => ({
          field,
          before: { present: false as const },
          after: { present: true as const, value: parseRecordJson(after.get(field)!) },
        }))
      : storedChanges.map((change) => {
          const name = String(change.field);
          if (
            change.profile_id !== version.profileId ||
            change.entity !== version.entity ||
            change.record_id !== version.recordId ||
            change.sequence !== version.sequence ||
            change.before_version !== version.previousVersion ||
            change.before_present !== Number(before.has(name)) ||
            change.after_present !== Number(after.has(name)) ||
            before.get(name) === after.get(name)
          )
            fail('invalid indexed field reference');
          return {
            field: name,
            before: before.has(name)
              ? { present: true as const, value: parseRecordJson(before.get(name)!) }
              : { present: false as const },
            after: after.has(name)
              ? { present: true as const, value: parseRecordJson(after.get(name)!) }
              : { present: false as const },
          };
        });
    const expected = [...new Set([...before.keys(), ...after.keys()])]
      .filter((name) => before.get(name) !== after.get(name))
      .sort();
    if (!eq(changes.map((change) => change.field).sort(), expected))
      fail('missing indexed field reference');
    return { ...version, changes };
  });
  return { entries, nextSequence: more ? entries.at(-1)!.sequence : null };
}
