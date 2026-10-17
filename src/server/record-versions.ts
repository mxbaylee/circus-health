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
  compactTerminalTempSql,
} from './intake-compact-terminal-sql.ts';
import {
  currentClinicalOperation,
  currentClinicalOperationReadonly,
  assertClinicalOperation,
  clinicalOperationCallerAssertions,
  clinicalOperationReadContinuations,
  clinicalOperationImmediateUnassertedContinuation,
  type ClinicalOperation,
} from './clinical-operation.ts';
import type { VaultCompactAuthorization } from './vault-app.ts';
import type { PackageSourceOriginalPhysical } from './intake-package-source-lease.ts';
import {
  captureContributorRecordStaging,
  contributorRecordStagingCurrent,
  prepareContributorRecordTransactionBacking,
  assertContributorRecordTransactionPrior,
  stageContributorRecordObject,
  prepareContributorRecordStagingHead,
  prepareContributorRecordBackingAdvance,
  finishContributorRecordTransactionPreparation,
  installContributorRecordStagingHead,
  completeContributorRecordStagingPublication,
  discardContributorRecordStaging,
  retireContributorRecordStagingAfterOrdinaryHead,
  captureContributorRecordAcceptedHeadRead,
  captureContributorRecordAcceptedSourceRead,
  assertContributorRecordAcceptedHeadRead,
  contributorRecordAcceptedSourcePair,
  assertContributorRecordAcceptedSourcePreimage,
  verifyContributorRecordAcceptedSourceRead,
  closeContributorRecordAcceptedHeadRead,
  closeContributorRecordAcceptedSourceRead,
  type ContributorRecordAcceptedHeadRead,
  type ContributorRecordAcceptedSourceRead,
  type ContributorRecordStagingWitness,
} from './contributor-record-staging.ts';
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
import {
  completeRecordReplayCommit,
  observeRecordReplayVersion,
  type RecordReplaySourcePair,
  type RecordReplaySourcePairRequest,
} from './record-replay-source-pair.ts';
import { parseRecordJsonPiecesSteps } from './record-json-pieces.ts';
import { intakeSourcePinKey } from './intake-source-pin-key.ts';
import { recordSourceFieldChanges } from './record-source-field-changes.ts';
import { createRecordPreparedRows } from './record-prepared-rows.ts';
import { createRecordPreparedIndex } from './record-prepared-index.ts';
import { createRecordMutationRecipe } from './record-mutation-recipe.ts';
import { createRecordPreparedPriors } from './record-prepared-priors.ts';
import {
  retainRecordAcceptedSourceDeltaCandidate,
  MAX_SOURCE_DELTA_CANDIDATES,
  MAX_SOURCE_DELTA_ROWS,
  type RecordAcceptedSourceDeltaRow,
} from './record-accepted-source-delta.ts';
import {
  prepareRecordPriorFields,
  recordFieldDigest,
  recordStringFieldDigest,
  type RecordFieldDigest,
  type PreparedRecordPriorFields,
} from './record-prior-fields.ts';
import type { RecordCommittedColumnReader } from './record-committed-column-reader.ts';
import {
  consumeIntakeMaintenancePriorFields,
  sealIntakeMaintenancePriorFields,
  renewIntakeMaintenanceAfterIndex,
  captureIntakeMaintenancePreparation,
  assertIntakeMaintenancePreparation,
  beginIntakeMaintenanceReplay,
  verifyIntakeMaintenanceReplay,
  discardIntakeMaintenancePreparation,
  intakeMaintenanceReplayStatements,
  type IntakeMaintenancePreparation,
} from './intake-state-maintenance.ts';
import {
  captureVaultRecordStaging,
  vaultRecordReadOwnerSupported,
  retainVaultRecordFrontierAfterOrdinaryHead,
  vaultRecordStagingCurrent,
  stageVaultRecordObject,
  prepareVaultRecordHead,
  installVaultRecordHead,
  discardVaultRecordStaging,
  prepareVaultRecordStagingBacking,
  prepareVaultRecordTransactionBacking,
  prepareVaultRecordTransactionBackingAdvance,
  installVaultRecordTransactionHead,
  completeVaultRecordTransactionPublication,
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
  captureVaultRecordAcceptedHeadRead,
  captureVaultRecordAcceptedSourceRead,
  assertVaultRecordAcceptedHeadRead,
  vaultRecordAcceptedSourcePair,
  assertVaultRecordAcceptedSourcePreimage,
  verifyVaultRecordAcceptedSourceRead,
  closeVaultRecordAcceptedHeadRead,
  closeVaultRecordAcceptedSourceRead,
  type VaultRecordAcceptedHeadRead,
  type VaultRecordAcceptedSourceRead,
} from './vault-store.ts';
import {
  intakeNamespace,
  parseIntakeCollectionHead,
  validateIntakeIdentity,
  type IntakeStateIdentity,
} from './intake-state-evidence.ts';
import {
  captureContributorRecordReadOwner,
  contributorRecordReadOwnerCurrent,
  contributorRecordReadOwnerHeadBytes,
  closeContributorRecordReadOwner,
  type ContributorRecordReadOwner,
  contributorRecordReadOwnerSupported,
  captureContributorLegacyBridgeBackingScopeForStorage,
  bindContributorLegacyBridgeBackingScope,
  contributorLegacyBridgeBackingScopeCurrent,
  contributorLegacyBridgeBackingIntervalCurrent,
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
  prepareManagedDatabaseCallbackBarrier,
  withoutManagedDatabaseCallbacks,
} from './database.ts';
import { createTransactionOutcomeIssuer } from './transaction-observer-issuer.ts';
const sourceDeltaOutcomes = createTransactionOutcomeIssuer();
export const recordSourceDeltaTerminalOutcome = sourceDeltaOutcomes.recognizes;
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
const maintenanceBookkeeping = new WeakMap<
  Database,
  { token: object; writes: bigint; sources?: ReadonlySet<string> }
>();
/** Only the accepted-record owner can mint these literal, transaction-bound
 * counts. A receipt that also indexed source rows names them; it is honoured
 * only when they are exactly the sources the caller observed being written,
 * and reports that it did (`sources`). */
export function consumeRecordMaintenanceBookkeeping(
  db: Database,
  token: object,
  observedSources?: ReadonlySet<string>,
): { writes: bigint; sources: boolean } {
  const receipt = maintenanceBookkeeping.get(db);
  maintenanceBookkeeping.delete(db);
  if (receipt?.token !== token) return { writes: 0n, sources: false };
  if (!receipt.sources) return { writes: receipt.writes, sources: false };
  return observedSources &&
    observedSources.size === receipt.sources.size &&
    [...receipt.sources].every((id) => observedSources.has(id))
    ? { writes: receipt.writes, sources: true }
    : { writes: 0n, sources: false };
}

export interface RecordStorage {
  read(name: string): Buffer | null | undefined;
  writeImmutable(name: string, bytes: Uint8Array): void;
  publishHead(bytes: Uint8Array): void;
  /** Optional stat-identity hook for the HEAD object, never its bytes. The key
   * must change whenever the bytes `read('head')` returns may have changed;
   * `settled` means a later change must also change the key (racy-timestamp
   * rule). Return null whenever identity is unknown or this is not the genuine
   * factory object; absent or null always means a real HEAD read. In-memory
   * and wrapping test storages deliberately omit it. */
  headIdentity?(): RecordHeadIdentity | null;
}
export interface RecordHeadIdentity {
  readonly key: string;
  readonly settled: boolean;
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
type SourcePriorVersion = Pick<CurrentVersionRow, 'version_id' | 'deleted' | 'contents_json'>;

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
const ordinarySourceDeltaPending = new WeakMap<
  Database,
  Map<
    object,
    {
      previousHeadJson: string;
      headJson: string;
      sequence: number;
      sources: readonly RecordAcceptedSourceDeltaRow[];
    }
  >
>();
const ordinarySourceDeltaStops = new WeakMap<Database, () => void>();
const recordParticipants = new WeakMap<Database, TransactionDurabilityHooks<RecordCapture>>();
declare const intakeLogPublicationBrand: unique symbol;
/** An intent is not publication authority. Only this record owner can mark its
 * exact changed-row footprint accepted, after the real final transaction outcome. */
export interface RecordIntakeLogPublication {
  readonly [intakeLogPublicationBrand]: true;
}
export interface RecordIntakeLogPublicationBinding {
  identity: IntakeStateIdentity;
  beforeHead: string | undefined;
  afterHead: string;
  receipt: unknown;
  writes: readonly { key: string; value: string }[];
}
interface IntakeLogPublicationData {
  db: Database;
  config: RecordConfig;
  methods: object;
  token: object;
  namespace: string;
  identity: string;
  beforeHead: string | undefined;
  afterHead: string;
  receipt: string;
  rows: Map<string, { hash: string; bytes: number }>;
  pendingLogRows: Set<string>;
  remaining: Set<string>;
  valid: boolean;
  validated: boolean;
  accepted: boolean;
}
const intakeLogPublications = new WeakMap<RecordIntakeLogPublication, IntakeLogPublicationData>();
const pendingIntakeLogPublications = new WeakMap<
  Database,
  Map<object, RecordIntakeLogPublication[]>
>();
const logValueDigest = (value: string) => {
  const bytes = Buffer.from(value);
  return { hash: digest(bytes), bytes: bytes.length };
};
function logDataField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') fail('log publication data object');
  const field = Object.getOwnPropertyDescriptor(value, key);
  if (!field || !('value' in field)) fail('log publication requires inert data fields');
  return field!.value;
}
/** Detach the small receipt without calling accessors or custom serialization. */
function logReceiptJson(value: unknown): string {
  let remaining = 8192,
    nodes = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (++nodes > 1024 || depth > 16) fail('log publication receipt structure');
    if (
      input === null ||
      typeof input === 'boolean' ||
      typeof input === 'number' ||
      typeof input === 'string'
    ) {
      if (typeof input === 'number' && !Number.isFinite(input))
        fail('log publication receipt number');
      if (typeof input === 'string' && input.length > remaining)
        fail('log publication receipt bytes');
      remaining -= Buffer.byteLength(JSON.stringify(input));
      if (remaining < 0) fail('log publication receipt bytes');
      return input;
    }
    if (
      !input ||
      typeof input !== 'object' ||
      ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(input))
    )
      fail('log publication receipt data');
    const keys = Object.keys(input);
    if (keys.length > 64) fail('log publication receipt fields');
    if (
      Array.isArray(input) &&
      (input.length > 64 ||
        input.length !== keys.length ||
        keys.some((key, index) => key !== String(index)))
    )
      fail('log publication receipt array');
    remaining -= keys.length + 2;
    const result: Record<string, unknown> | unknown[] = Array.isArray(input)
      ? []
      : Object.create(null);
    for (const key of keys) {
      if (key.length > remaining) fail('log publication receipt bytes');
      remaining -= Buffer.byteLength(JSON.stringify(key)) + 1;
      if (remaining < 0) fail('log publication receipt bytes');
      Object.defineProperty(result, key, {
        value: copy(logDataField(input, key), depth + 1),
        enumerable: true,
      });
    }
    return result;
  };
  const raw = JSON.stringify(copy(value, 0));
  if (Buffer.byteLength(raw) > 8192) fail('log publication receipt bytes');
  return raw;
}
function logPublicationHeader(input: RecordIntakeLogPublicationBinding) {
  const rawIdentity = logDataField(input, 'identity');
  const identity = validateIntakeIdentity({
    profileId: logDataField(rawIdentity, 'profileId') as string,
    intakeId: logDataField(rawIdentity, 'intakeId') as string,
    sourceHash: logDataField(rawIdentity, 'sourceHash') as string,
  });
  const beforeHead = logDataField(input, 'beforeHead') as string | undefined;
  const afterHead = logDataField(input, 'afterHead') as string;
  if (
    typeof afterHead !== 'string' ||
    afterHead.length > 4096 ||
    (beforeHead !== undefined && (typeof beforeHead !== 'string' || beforeHead.length > 4096))
  )
    fail('log publication head bytes');
  const writes = logDataField(input, 'writes');
  if (!Array.isArray(writes)) fail('log publication row roster');
  return {
    identity,
    beforeHead,
    afterHead,
    receipt: logReceiptJson(logDataField(input, 'receipt')),
    writes: writes as readonly { key: string; value: string }[],
  };
}
/** Called inside the staging transaction with freshly inserted rows and HEAD.
 * Descriptor bounds discard this optional accelerator; they do not cap a save.
 * Inputs are detached before registration; no caller callbacks survive here. */
export function registerRecordIntakeLogPublication(
  db: Database,
  input: RecordIntakeLogPublicationBinding,
): RecordIntakeLogPublication | undefined {
  const token = currentTransactionToken(db),
    config = state.get(db);
  if (
    !token ||
    !db.isTransaction ||
    !config ||
    !transactionDurabilityParticipantCurrent(db, recordParticipants.get(db))
  )
    fail('log publication requires its active record owner');
  const methods = managedDatabaseMethodEpoch(db);
  if (!methods) fail('log publication requires managed database methods');
  const binding = logPublicationHeader(input),
    identity = binding.identity;
  if (identity.profileId !== config!.profileId) fail('foreign log publication profile');
  const namespace = intakeNamespace(identity);
  const after = parseIntakeCollectionHead(binding.afterHead, identity);
  if (after?.format !== 'health-intake-state-v5') fail('log publication requires a V5 head');
  if (binding.beforeHead !== undefined) parseIntakeCollectionHead(binding.beforeHead, identity);
  const receipt = binding.receipt;
  if (binding.writes.length > 100_000) return undefined;
  let pending = pendingIntakeLogPublications.get(db);
  if (!pending) pendingIntakeLogPublications.set(db, (pending = new Map()));
  let candidates = pending.get(token!);
  if (!candidates) pending.set(token!, (candidates = []));
  if (candidates.length >= 64) return undefined;
  const rows = new Map<string, { hash: string; bytes: number }>();
  const pendingLogRows = new Set<string>();
  let descriptorBytes = 0,
    matchingReceipts = 0,
    payloadBytes = 0;
  for (let index = 0; index < binding.writes.length; index++) {
    const raw = logDataField(binding.writes, String(index));
    const row = {
      key: logDataField(raw, 'key') as string,
      value: logDataField(raw, 'value') as string,
    };
    if (typeof row.key !== 'string' || typeof row.value !== 'string' || rows.has(row.key))
      fail('log publication duplicate or malformed row');
    const head = row.key === namespace + 'head';
    const hash = row.key.slice((namespace + 'node:').length);
    if (!head && (!row.key.startsWith(namespace + 'node:') || !/^[a-f0-9]{64}$/.test(hash)))
      fail('log publication foreign row');
    if (
      row.value.length > (head ? 4096 : 32768) ||
      Buffer.byteLength(row.value) > (head ? 4096 : 32768)
    )
      fail('log publication row bytes');
    const value = logValueDigest(row.value);
    payloadBytes += value.bytes;
    if (payloadBytes > 256 * 1024 * 1024) return undefined;
    if (head ? row.value !== binding.afterHead : value.hash !== hash)
      fail('log publication row binding');
    if (!head) {
      const node = JSON.parse(row.value) as Record<string, unknown>;
      if (node.format === 'health-intake-state-log-node-v1' && node.kind !== 'anchor')
        pendingLogRows.add(row.key);
      if (node.format === 'health-intake-state-log-node-v1' && node.kind === 'leaf') {
        const event = node.event as { receipt?: unknown } | undefined;
        if (JSON.stringify(event?.receipt) === receipt) matchingReceipts++;
      }
    }
    descriptorBytes += Buffer.byteLength(row.key) + 80;
    if (descriptorBytes > 32 * 1024 * 1024) return undefined;
    rows.set(row.key, value);
  }
  if (!rows.has(namespace + 'head') || matchingReceipts !== 1)
    fail('log publication missing selected head or receipt leaf');
  if (
    !db.isOpen ||
    !db.isTransaction ||
    currentTransactionToken(db) !== token ||
    state.get(db) !== config ||
    managedDatabaseMethodEpoch(db) !== methods ||
    !transactionDurabilityParticipantCurrent(db, recordParticipants.get(db))
  )
    fail('log publication owner changed during binding');
  const candidate = Object.freeze({}) as RecordIntakeLogPublication;
  intakeLogPublications.set(candidate, {
    db,
    config: config!,
    methods: methods!,
    token: token!,
    namespace,
    identity: JSON.stringify(identity),
    beforeHead: binding.beforeHead,
    afterHead: binding.afterHead,
    receipt,
    rows,
    pendingLogRows,
    remaining: new Set(rows.keys()),
    valid: true,
    validated: false,
    accepted: false,
  });
  candidates.push(candidate);
  return candidate;
}
function observeIntakeLogPublicationVersion(
  candidates: readonly RecordIntakeLogPublication[] | undefined,
  version: DurableRecordVersion,
  previous: CurrentVersionRow | undefined,
): void {
  if (version.entity !== 'app_meta' || typeof version.contents.key !== 'string') return;
  for (const candidate of candidates ?? []) {
    const data = intakeLogPublications.get(candidate);
    if (!data?.valid || !version.contents.key.startsWith(data.namespace)) continue;
    const key = version.contents.key,
      expected = data.rows.get(key);
    if (
      !expected ||
      !data.remaining.delete(key) ||
      version.deleted ||
      typeof version.contents.value !== 'string'
    ) {
      data.valid = false;
      continue;
    }
    const actual = logValueDigest(version.contents.value);
    if (actual.hash !== expected.hash || actual.bytes !== expected.bytes) data.valid = false;
    if (key === data.namespace + 'head') {
      const old =
        previous && !previous.deleted
          ? parseRecordJson<Record<string, unknown>>(previous.contents_json)
          : undefined;
      if (data.beforeHead === undefined ? previous !== undefined : old?.value !== data.beforeHead)
        data.valid = false;
    } else if (previous) data.valid = false;
  }
}
function finishIntakeLogPublicationIndex(
  candidates: readonly RecordIntakeLogPublication[] | undefined,
): void {
  for (const candidate of candidates ?? []) {
    const data = intakeLogPublications.get(candidate);
    if (data) data.validated = data.valid && data.remaining.size === 0;
  }
}
function finishIntakeLogPublicationOutcome(
  db: Database,
  candidates: readonly RecordIntakeLogPublication[] | undefined,
  outcome: TransactionOutcome | undefined,
  originalToken: object | undefined,
  publishedToken: object | undefined,
): void {
  for (const candidate of candidates ?? []) {
    const data = intakeLogPublications.get(candidate);
    if (!data) continue;
    if (
      data.db === db &&
      data.token === originalToken &&
      outcome?.token === publishedToken &&
      data.config === state.get(db) &&
      data.validated &&
      outcome?.committed &&
      outcome.succeeded
    )
      data.accepted = true;
    else intakeLogPublications.delete(candidate);
  }
}
/** Destructive verification by the codec itself. This proves the exact owned
 * publication, not current source/storage authority; the caller admits that
 * separately. A caller-supplied boolean or a fabricated object cannot pass. */
export function consumeAcceptedRecordIntakeLogPublication(
  db: Database,
  candidate: RecordIntakeLogPublication,
  input: RecordIntakeLogPublicationBinding,
): boolean {
  const data = intakeLogPublications.get(candidate);
  intakeLogPublications.delete(candidate);
  if (
    !data ||
    !data.accepted ||
    data.db !== db ||
    !db.isOpen ||
    db.isTransaction ||
    state.get(db) !== data.config ||
    managedDatabaseMethodEpoch(db) !== data.methods
  )
    return false;
  let binding: ReturnType<typeof logPublicationHeader>;
  try {
    binding = logPublicationHeader(input);
  } catch {
    return false;
  }
  if (
    JSON.stringify(binding.identity) !== data.identity ||
    binding.beforeHead !== data.beforeHead ||
    binding.afterHead !== data.afterHead ||
    binding.receipt !== data.receipt ||
    binding.writes.length > data.rows.size
  )
    return false;
  const seen = new Set<string>();
  for (let index = 0; index < binding.writes.length; index++) {
    let row: { key: string; value: string };
    try {
      const raw = logDataField(binding.writes, String(index));
      row = {
        key: logDataField(raw, 'key') as string,
        value: logDataField(raw, 'value') as string,
      };
    } catch {
      return false;
    }
    const expected = data.rows.get(row.key);
    if (!expected || seen.has(row.key) || typeof row.value !== 'string' || row.value.length > 32768)
      return false;
    seen.add(row.key);
    const value = logValueDigest(row.value);
    if (value.hash !== expected.hash || value.bytes !== expected.bytes) return false;
  }
  return (
    [...data.pendingLogRows].every((key) => seen.has(key)) &&
    db.isOpen &&
    !db.isTransaction &&
    state.get(db) === data.config &&
    managedDatabaseMethodEpoch(db) === data.methods &&
    transactionDurabilityParticipantCurrent(db, recordParticipants.get(db))
  );
}
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
  contributorStaging?: ContributorRecordStagingWitness;
  staged?: Pick<IndexedTransaction, 'ref' | 'commit'> & {
    contributor?: ContributorRecordHeadPublication;
  };
  stagingStarted?: boolean;
  indexRows?: ReturnType<typeof createRecordPreparedIndex>;
  stateIndex?: ReturnType<typeof createRecordPreparedIndex>;
  valueChecks?: ReturnType<typeof createRecordPreparedIndex>;
  backingRows?: ReturnType<typeof createRecordPreparedIndex>;
  sourceDeltaRows?: readonly RecordAcceptedSourceDeltaRow[];
  intakeLogPublications?: readonly RecordIntakeLogPublication[];
  backingPlan?: RecordTransactionBackingPlan;
  indexBookkeeping?: RecordBookkeeping;
  indexWrites?: bigint;
  terminal?: PreparedTerminalStatements;
  rows: ReturnType<typeof createRecordPreparedRows>;
  recipe: ReturnType<typeof createRecordMutationRecipe>;
  token?: object;
  resultJson?: string;
  maintenance?: IntakeMaintenancePreparation;
  replayToken?: object;
  replayMaintenanceVerified?: boolean;
  total?: bigint;
  tentativeStart?: bigint;
  tentativeWrites?: bigint;
  businessWrites?: bigint;
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
declare const compactContributorBackingBrand: unique symbol;
export interface RecordCompactContributorBackingPlan {
  readonly [compactContributorBackingBrand]: true;
}
export type ContributorRecordBackingPlan =
  RecordTransactionBackingPlan | RecordCompactContributorBackingPlan;
declare const transactionIndexedBrand: unique symbol;
export interface RecordTransactionIndexedPublication {
  readonly [transactionIndexedBrand]: true;
}
declare const compactContributorIndexedBrand: unique symbol;
export interface RecordCompactContributorIndexedPublication {
  readonly [compactContributorIndexedBrand]: true;
}
export type ContributorRecordIndexedPublication =
  RecordTransactionIndexedPublication | RecordCompactContributorIndexedPublication;
declare const transactionTerminalBrand: unique symbol;
export interface RecordTransactionTerminalExecution {
  readonly [transactionTerminalBrand]: true;
}
declare const compactContributorTerminalBrand: unique symbol;
export interface RecordCompactContributorTerminalExecution {
  readonly [compactContributorTerminalBrand]: true;
}
export type ContributorRecordTerminalExecution =
  RecordTransactionTerminalExecution | RecordCompactContributorTerminalExecution;
const transactionTerminalExecutions = new WeakMap<
  object,
  {
    db: Database;
    witness: object;
    plan: RecordTransactionBackingPlan;
    used: boolean;
    complete(): unknown;
  }
>();
function isRecordTransactionTerminalExecution(
  execution: ContributorRecordTerminalExecution,
): execution is RecordTransactionTerminalExecution {
  return transactionTerminalExecutions.has(execution);
}
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
  object,
  {
    proof: TransactionPreparationData;
    plan: RecordTransactionBackingPlan;
    witness: object;
    token: object;
    head: string;
    consumed: boolean;
  }
>();
function isRecordTransactionIndexedPublication(
  indexed: ContributorRecordIndexedPublication,
): indexed is RecordTransactionIndexedPublication {
  return transactionIndexedPublications.has(indexed);
}
const acceptedTransactionBackings = new WeakMap<
  RecordTransactionBackingPlan,
  { db: Database; witness: object }
>();
type ContributorBackingVersion = {
  entity: string;
  recordId: string;
  versionId: string;
  deleted: boolean;
  previousVersion: string | null;
  contentsJson: string;
  sourceFields: readonly { name: string; hash: string; bytes: number }[];
};
const compactContributorBackings = new WeakMap<
  object,
  {
    db: Database;
    witness: ContributorRecordStagingWitness;
    prior: SourcePriorData;
    head: string;
    versions: readonly ContributorBackingVersion[];
    preparationCurrent(): void;
    owner?: RecordCompactTerminalOwner;
    accepted: boolean;
  }
>();
function isCompactContributorBackingPlan(
  plan: ContributorRecordBackingPlan,
): plan is RecordCompactContributorBackingPlan {
  return compactContributorBackings.has(plan);
}
const compactContributorIndexed = new WeakMap<
  object,
  {
    plan: RecordCompactContributorBackingPlan;
    token: object;
    head: string;
    consumed: boolean;
  }
>();
const compactContributorExecutions = new WeakMap<
  object,
  {
    plan: RecordCompactContributorBackingPlan;
    witness: ContributorRecordStagingWitness;
    used: boolean;
    complete(): unknown;
  }
>();
function isCompactContributorIndexed(
  indexed: ContributorRecordIndexedPublication,
): indexed is RecordCompactContributorIndexedPublication {
  return compactContributorIndexed.has(indexed);
}
function isCompactContributorExecution(
  execution: ContributorRecordTerminalExecution,
): execution is RecordCompactContributorTerminalExecution {
  return compactContributorExecutions.has(execution);
}
function compactContributorBackingCurrent(
  plan: RecordCompactContributorBackingPlan,
  db: Database,
  witness: object,
): boolean {
  const data = compactContributorBackings.get(plan);
  if (
    !data ||
    data.db !== db ||
    data.witness !== witness ||
    data.prior.plan?.contributorBacking !== plan ||
    !contributorRecordStagingCurrent(data.witness)
  )
    return false;
  if (data.owner && !recordCompactTerminalOwnerCurrent(data.owner, db, data.witness)) return false;
  if (db.isTransaction || (data.owner && compactTerminalOwners.get(data.owner)?.sealed))
    return !!data.owner;
  try {
    data.preparationCurrent();
    return !data.owner || recordCompactTerminalOwnerCurrent(data.owner, db, data.witness);
  } catch {
    return false;
  }
}
/** The compact issuer is separate from the ownership-report parent and cannot
 * borrow its artifact or source roster. */
export function contributorRecordBackingPlanCurrent(
  plan: ContributorRecordBackingPlan,
  db: Database,
  witness: object,
): boolean {
  return isCompactContributorBackingPlan(plan)
    ? compactContributorBackingCurrent(plan, db, witness)
    : recordTransactionBackingPlanCurrent(plan, db, witness);
}
export function* verifiedContributorRecordBackingVersions(
  plan: ContributorRecordBackingPlan,
  db: Database,
  witness: object,
  head: string,
): Generator<ContributorBackingVersion> {
  if (!isCompactContributorBackingPlan(plan)) {
    yield* verifiedRecordTransactionBackingVersions(plan, db, witness, head);
    return;
  }
  const compact = compactContributorBackings.get(plan)!;
  if (compact.head !== head || !compactContributorBackingCurrent(plan, db, witness))
    fail('compact contributor backing payload changed');
  for (const version of compact.versions) {
    if (!compactContributorBackingCurrent(plan, db, witness))
      fail('compact contributor backing payload changed');
    yield version;
  }
  if (!compactContributorBackingCurrent(plan, db, witness))
    fail('compact contributor backing payload changed');
}
export function* verifiedContributorRecordOriginalSources(
  plan: ContributorRecordBackingPlan,
  db: Database,
  witness: object,
): Generator<PackageSourceOriginalPhysical> {
  if (!isCompactContributorBackingPlan(plan)) {
    yield* verifiedRecordTransactionOriginalSources(plan, db, witness);
    return;
  }
  const compact = compactContributorBackings.get(plan)!;
  if (!compactContributorBackingCurrent(plan, db, witness))
    fail('compact contributor source owner changed');
  if (!compact.owner) fail('compact contributor source issuer missing');
  for (const source of recordCompactTerminalOriginalSources(compact.owner, db, compact.witness)) {
    if (!compactContributorBackingCurrent(plan, db, witness))
      fail('compact contributor source owner changed');
    yield source;
  }
  if (!compactContributorBackingCurrent(plan, db, witness))
    fail('compact contributor source owner changed');
}
export function* verifiedContributorRecordOriginalArtifacts(
  plan: ContributorRecordBackingPlan,
  db: Database,
  witness: object,
): Generator<import('./intake-review-collection-session.ts').VerifiedClinicalArtifact> {
  if (!isCompactContributorBackingPlan(plan)) {
    yield* verifiedRecordTransactionOriginalArtifacts(plan, db, witness);
    return;
  }
  if (!compactContributorBackingCurrent(plan, db, witness))
    fail('compact contributor artifact owner changed');
  // A compact metadata operation has no clinical artifact issuer. The physical
  // worker still verifies every accepted and newly staged immutable object.
}
export function contributorRecordTerminalExecutionCurrent(
  execution: ContributorRecordTerminalExecution,
  db: Database,
  witness: object,
  plan: ContributorRecordBackingPlan,
): boolean {
  if (!isCompactContributorBackingPlan(plan)) {
    if (!isRecordTransactionTerminalExecution(execution)) return false;
    return recordTransactionTerminalExecutionCurrent(execution, db, witness, plan);
  }
  if (!isCompactContributorExecution(execution)) return false;
  const data = compactContributorExecutions.get(execution);
  return (
    !!data &&
    !data.used &&
    data.plan === plan &&
    data.witness === witness &&
    compactContributorBackingCurrent(plan, db, witness)
  );
}
export function runContributorRecordTerminalExecution(
  execution: ContributorRecordTerminalExecution,
  db: Database,
  witness: object,
  plan: ContributorRecordBackingPlan,
): unknown {
  if (!isCompactContributorBackingPlan(plan)) {
    if (!isRecordTransactionTerminalExecution(execution))
      fail('foreign contributor terminal execution');
    return runRecordTransactionTerminalExecution(execution, db, witness, plan);
  }
  if (!contributorRecordTerminalExecutionCurrent(execution, db, witness, plan))
    fail('compact contributor terminal execution expired');
  const data = compactContributorExecutions.get(execution)!;
  data.used = true;
  return data.complete();
}
export function sealContributorRecordTerminalWorker(
  execution: ContributorRecordTerminalExecution,
  db: Database,
  witness: ContributorRecordStagingWitness,
  plan: ContributorRecordBackingPlan,
): void {
  if (!isCompactContributorExecution(execution)) return;
  const data = compactContributorExecutions.get(execution),
    backing = compactContributorBackings.get(plan);
  if (
    !data ||
    data.plan !== plan ||
    data.witness !== witness ||
    !backing?.owner ||
    !contributorRecordTerminalExecutionCurrent(execution, db, witness, plan)
  )
    fail('compact contributor worker issuer expired');
  sealRecordCompactTerminalWorker(backing.owner, db, witness);
}
export function consumeContributorRecordBackingAdvance(
  db: Database,
  indexed: ContributorRecordIndexedPublication,
  witness: object,
  head: string,
  plan: ContributorRecordBackingPlan,
): boolean {
  if (!isCompactContributorBackingPlan(plan)) {
    if (!isRecordTransactionIndexedPublication(indexed))
      fail('foreign contributor indexed transition');
    return consumeRecordTransactionBackingAdvance(db, indexed, witness, head, plan);
  }
  if (!isCompactContributorIndexed(indexed)) fail('foreign compact contributor indexed transition');
  const data = compactContributorIndexed.get(indexed);
  if (!data) fail('compact contributor indexed backing transition unavailable');
  if (
    data.consumed ||
    data.plan !== plan ||
    data.head !== head ||
    data.token !== currentTransactionToken(db) ||
    !db.isTransaction ||
    !compactContributorBackingCurrent(plan, db, witness)
  )
    fail('compact contributor indexed backing transition unavailable');
  data.consumed = true;
  return true;
}
export function consumeContributorRecordBackingPublication(
  plan: ContributorRecordBackingPlan,
  db: Database,
  witness: object,
): boolean {
  if (!isCompactContributorBackingPlan(plan))
    return consumeRecordTransactionBackingPublication(plan, db, witness);
  const data = compactContributorBackings.get(plan)!;
  if (!data.accepted || data.db !== db || data.witness !== witness)
    fail('compact contributor accepted backing continuation unavailable');
  data.accepted = false;
  return true;
}
/** Retained derivatives are admitted only after the genuine fresh-T2 outcome. */
export function consumeRecordTransactionBackingPublication(
  plan: RecordTransactionBackingPlan,
  db: Database,
  witness: object,
): boolean {
  const found = acceptedTransactionBackings.get(plan);
  if (!found || found.db !== db || found.witness !== witness)
    fail('foreign record accepted backing continuation');
  acceptedTransactionBackings.delete(plan);
  return true;
}
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
  sourceFields: readonly { name: string; hash: string; bytes: number }[];
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
      row.sql !== 'SELECT ?,?,?,?,?,?,?' ||
      args.length !== 7 ||
      typeof args[0] !== 'string' ||
      typeof args[1] !== 'string' ||
      typeof args[2] !== 'string' ||
      (args[3] !== 0 && args[3] !== 1) ||
      (args[4] !== null && typeof args[4] !== 'string') ||
      typeof args[5] !== 'string' ||
      typeof args[6] !== 'string' ||
      args[6].length > 2048
    )
      fail('record transaction backing payload shape differs');
    yield Object.freeze({
      entity: args[0] as string,
      recordId: args[1] as string,
      versionId: args[2] as string,
      deleted: args[3] === 1,
      previousVersion: args[4] as string | null,
      contentsJson: args[5] as string,
      sourceFields: Object.freeze(
        parseRecordJson<{ name: string; hash: string; bytes: number }[]>(args[6] as string),
      ),
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
/** Only the core's exact released T1 may enter its own fresh T2. */
export function recordPreparedMaintenanceReplayCurrent(
  db: Database,
  original: object,
  token: object,
): boolean {
  const proof = preparedPublicationTokens.get(original);
  return (
    recordPreparedReplayCurrent(db, original) &&
    !!proof?.maintenance &&
    proof.replayToken === token &&
    token !== original &&
    db.isTransaction &&
    currentTransactionToken(db) === token
  );
}
export function recordPreparedMaintenanceReplayVerified(
  db: Database,
  original: object,
  token: object,
): boolean {
  return (
    recordPreparedMaintenanceReplayCurrent(db, original, token) &&
    preparedPublicationTokens.get(original)?.replayMaintenanceVerified === true
  );
}
function discardPreparedPublicationObservers(proof: TransactionPreparationData): void {
  for (const candidate of proof.intakeLogPublications ?? [])
    intakeLogPublications.delete(candidate);
  proof.intakeLogPublications = undefined;
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
    () => proof.maintenance && discardIntakeMaintenancePreparation(proof.maintenance),
    () => proof.recipe.close(),
    () => proof.rows.close(),
    () => proof.indexRows?.close(),
    () => proof.stateIndex?.close(),
    () => proof.valueChecks?.close(),
    () => proof.backingRows?.close(),
    () => proof.readOwner && closeRecordReadOwner(proof.readOwner),
    () => proof.staging && discardVaultRecordStaging(proof.staging),
    () => proof.contributorStaging && discardContributorRecordStaging(proof.contributorStaging),
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
    ownsContinuation(work: Function): boolean;
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
      ownsContinuation: (work) =>
        report.ownershipReportOriginalProofOwnsContinuation(original, work, db, profileId),
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
  proof.businessWrites = business;
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
  const clinicalUpdate = operation.actor !== 'source-text' && !operation.intakeMaintenance;
  if (clinicalInsert || clinicalUpdate) keys.push('clinical_review_revision');
  let captureWrites = 0n;
  for (const key of keys)
    if (!Reflect.apply(readmissionGet, captured, [stringifyRecordJson([key])])) captureWrites++;
  proof.expectedTentativeWrites =
    business + captureWrites + 2n + BigInt(clinicalInsert) + BigInt(clinicalUpdate);
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
  staging?: VaultRecordStagingWitness;
  contributorStaging?: ContributorRecordStagingWitness;
  originals: RecordPublicationOriginals;
  total: bigint;
}
declare const transactionOriginalBackingBrand: unique symbol;
export interface RecordTransactionOriginalBacking {
  readonly [transactionOriginalBackingBrand]: true;
}
const originalTransactionBackings = new WeakMap<
  RecordTransactionOriginalBacking,
  {
    db: Database;
    backing: TransactionOriginalBacking;
    consumed: boolean;
    current(total?: bigint): void;
    advance(preparation: RecordTransactionPreparation): void;
  }
>();

/** Capture the actual vault's complete original namespace BEFORE tentative
 * business reads/writes. The parent union remains its own original proof. */
export async function prepareRecordTransactionOriginalBacking(
  db: Database,
  originals: RecordPublicationOriginals,
): Promise<RecordTransactionOriginalBacking> {
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
    !recordReadOwnerSupported(db, config.profileId)
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
    contributorStaging: ContributorRecordStagingWitness | undefined,
    transferred = false;
  try {
    const originalState = { ...readStatusRow(db) },
      retainedRead = recordReadOwners.get(readOwner)!;
    if (
      originalState.head_json !== admittedParent.expectedHead ||
      originalState.sequence !== admittedParent.expectedSequence
    )
      fail('record transaction parent accepted continuation changed');
    if (retainedRead.vault) {
      const epoch = captureManagedPhysicalEpoch();
      if (!epoch) fail('record transaction original physical interval unavailable');
      staging = captureVaultRecordStaging(db, admittedConfig.storage, epoch!);
      if (!staging) fail('record transaction original storage unavailable');
    } else if (retainedRead.contributor) {
      contributorStaging = captureContributorRecordStaging(
        db,
        admittedConfig.storage,
        retainedRead.contributor,
      );
      if (!contributorStaging) fail('record transaction original contributor unavailable');
    } else fail('record transaction original storage unavailable');
    const stamp = Reflect.apply(readmissionPrepare, db, ['SELECT total_changes() AS n']);
    stamp.setReadBigInts(true);
    const total = Reflect.apply(readmissionGet, stamp, []).n as bigint;
    let expectedTotal = total,
      advanced = false;
    const check = (selectedTotal = expectedTotal) => {
      assertClinicalOperation(db, admittedOwner);
      admittedParent.current(assertions);
      if (
        publicationOriginals.get(originals) !== parent ||
        state.get(db) !== config ||
        db.isTransaction ||
        managedDatabaseMethodEpoch(db) !== methods ||
        Reflect.apply(readmissionGet, stamp, []).n !== selectedTotal
      )
        fail('record transaction original backing changed');
      if (
        staging
          ? !vaultRecordReadOwnerStagingCurrent(
              admittedConfig.storage,
              retainedRead.vault!,
              staging,
            )
          : !contributorRecordStagingCurrent(contributorStaging!)
      )
        fail('record transaction owned physical continuation changed');
    };
    check();
    const originalHead = recordReadOwners.get(readOwner)?.wire;
    if (typeof originalHead !== 'string')
      fail('record transaction original HEAD bytes unavailable');
    if (staging) await prepareVaultRecordTransactionBacking(staging, originalHead!, check);
    else
      await prepareContributorRecordTransactionBacking(contributorStaging!, originalHead!, check);
    check();
    const backing: TransactionOriginalBacking = {
      config: admittedConfig,
      operation: admittedOwner,
      methods: admittedMethods,
      originalState,
      readOwner,
      staging,
      contributorStaging,
      originals,
      total,
    };
    const capability = Object.freeze({}) as RecordTransactionOriginalBacking;
    originalTransactionBackings.set(capability, {
      db,
      backing,
      consumed: false,
      current: check,
      advance(preparation) {
        const proof = transactionPreparations.get(preparation);
        if (
          advanced ||
          !proof ||
          proof.closed ||
          !proof.released ||
          !proof.token ||
          preparedPublicationTokens.get(proof.token) !== proof ||
          proof.db !== db ||
          proof.config !== admittedConfig ||
          proof.clinicalOperation !== admittedOwner ||
          proof.methods !== admittedMethods ||
          proof.readOwner !== readOwner ||
          proof.staging !== staging ||
          proof.contributorStaging !== contributorStaging ||
          proof.originals !== originals ||
          !proof.completeBacking ||
          proof.tentativeStart !== total ||
          proof.expectedTentativeWrites !== proof.tentativeWrites ||
          proof.total === undefined
        )
          fail('record preparatory original write continuation differs');
        // Honest rollback keeps total_changes attempts. Advance only by this
        // exact released recipe; never adopt a fresh counter or physical base.
        const recordedTotal = proof!.total!;
        check(recordedTotal);
        expectedTotal = recordedTotal;
        advanced = true;
      },
    });
    transferred = true;
    return capability;
  } finally {
    if (!transferred) {
      try {
        closeRecordReadOwner(readOwner);
      } finally {
        if (staging) discardVaultRecordStaging(staging);
        if (contributorStaging) discardContributorRecordStaging(contributorStaging);
      }
    }
  }
}
export function discardRecordTransactionOriginalBacking(
  capability: RecordTransactionOriginalBacking,
): void {
  const data = originalTransactionBackings.get(capability);
  originalTransactionBackings.delete(capability);
  if (!data || data.consumed) return;
  data.consumed = true;
  try {
    closeRecordReadOwner(data.backing.readOwner);
  } finally {
    if (data.backing.staging) discardVaultRecordStaging(data.backing.staging);
    if (data.backing.contributorStaging)
      discardContributorRecordStaging(data.backing.contributorStaging);
  }
}
/** Consume only inside the original operation or its genuine same-plan report
 * child. T1 is synchronous; its lifetime remains the original parent owner. */
export function prepareRecordTransactionFromOriginalBacking<T>(
  db: Database,
  capability: RecordTransactionOriginalBacking,
  fn: () => T,
  operation: TransactionOperation,
): RecordTransactionPreparation {
  const data = originalTransactionBackings.get(capability);
  if (!data || data.db !== db || data.consumed) fail('record original backing expired');
  const admitted = data!;
  // Consumption precedes any supplied business callback, even on refusal.
  admitted.consumed = true;
  originalTransactionBackings.delete(capability);
  let preparation: RecordTransactionPreparation | undefined;
  try {
    admitted.current();
    const currentOwner = currentClinicalOperationReadonly(db),
      parent = publicationOriginals.get(admitted.backing.originals);
    if (
      !currentOwner ||
      !parent ||
      (currentOwner !== admitted.backing.operation &&
        (!clinicalOperationImmediateUnassertedContinuation(
          db,
          admitted.backing.operation,
          currentOwner,
        ) ||
          !parent.ownsContinuation(clinicalOperationReadContinuations(db, currentOwner)[0]!)))
    )
      fail('record original backing admission owner differs');
    preparation = prepareTransaction(db, fn, operation, admitted.backing);
    admitted.advance(preparation);
    return preparation;
  } catch (error) {
    if (preparation) discardRecordTransactionPreparation(db, preparation);
    else {
      try {
        closeRecordReadOwner(admitted.backing.readOwner);
      } finally {
        if (admitted.backing.staging) discardVaultRecordStaging(admitted.backing.staging);
        if (admitted.backing.contributorStaging)
          discardContributorRecordStaging(admitted.backing.contributorStaging);
      }
    }
    throw error;
  }
}
export async function prepareRecordTransactionWithOriginals<T>(
  db: Database,
  fn: () => T,
  operation: TransactionOperation,
  originals: RecordPublicationOriginals,
): Promise<RecordTransactionPreparation> {
  const backing = await prepareRecordTransactionOriginalBacking(db, originals);
  try {
    return prepareRecordTransactionFromOriginalBacking(db, backing, fn, operation);
  } finally {
    discardRecordTransactionOriginalBacking(backing);
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
    (operation.intakeMaintenance && !backing)
  )
    fail('record transaction preparation requires an idle genuine record owner');
  if (backing && (backing.config !== config || backing.methods !== methods))
    fail('record transaction original backing owner changed');
  const operationJson = stringifyRecordJson(operation),
    selectedOperation = Object.freeze({
      ...parseRecordJson<TransactionOperation>(operationJson),
      ...(operation.intakeMaintenance ? { intakeMaintenance: operation.intakeMaintenance } : {}),
    }),
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
  let contributorStaging: ContributorRecordStagingWitness | undefined;
  try {
    recipe = createRecordMutationRecipe(db);
    if (backing) {
      readOwner = backing.readOwner;
      staging = backing.staging;
      contributorStaging = backing.contributorStaging;
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
    if (contributorStaging) discardContributorRecordStaging(contributorStaging);
    rows.close();
    throw error;
  }
  const proof: TransactionPreparationData = {
    db,
    config: config!,
    clinicalOperation: backing?.operation ?? clinicalOperation!,
    methods: methods!,
    operation: selectedOperation,
    operationJson,
    originalState: { ...originalState },
    recordedAt: new Date().toISOString(),
    operationId: operationId as string,
    records: 0,
    readOwner,
    staging,
    contributorStaging,
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
    for (const raw of selected.rows.pieceRows()) {
      check();
      const version = await parsePreparedRecordVersion(raw, check),
        previous = current(db, version.entity, version.recordId);
      check();
      if ((previous?.version_id ?? null) !== version.previousVersion)
        fail('record publication cached predecessor changed');
      if (selected.completeBacking) {
        if (!selected.staging && !selected.contributorStaging)
          fail('record publication complete backing unavailable');
        // Vault certificates use the quoted JSON-string codec. The portable
        // ancestry index below deliberately uses raw document bytes instead.
        const preimage = previous
          ? selected.staging
            ? await recordStringFieldDigest(previous.contents_json, check)
            : await digestRecordPieces(rawRecordPieces(previous.contents_json), check)
          : null;
        const prior = previous ? { deleted: !!previous.deleted, preimage: preimage! } : null;
        if (selected.staging)
          assertVaultRecordTransactionPrior(
            selected.staging,
            version.entity,
            version.recordId,
            version.previousVersion,
            prior,
          );
        else
          assertContributorRecordTransactionPrior(
            selected.contributorStaging!,
            version.entity,
            version.recordId,
            version.previousVersion,
            prior,
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
    await priors.sealAsync(check);
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
  if (
    (!staging && !proof.contributorStaging) ||
    !readOwner ||
    !parent ||
    proof.revision === undefined
  )
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
      (staging
        ? !readOwner!.vault ||
          !vaultRecordReadOwnerStagingCurrent(proof.config.storage, readOwner!.vault!, staging)
        : !readOwner!.contributor || !contributorRecordStagingCurrent(proof.contributorStaging!))
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
    if (staging) stageVaultRecordObject(staging, ref, bytes);
    else stageContributorRecordObject(proof.contributorStaging!, ref, bytes);
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
  for (const raw of proof.rows.pieceRows()) {
    check();
    // The signed row already contains the frozen version ID and metadata.
    // Encode bounded UTF-8 pieces rather than another complete version buffer.
    for (const piece of (function* () {
      yield* raw;
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
  if (proof.contributorStaging) prepareContributorRecordStagingHead(proof.contributorStaging, ref);
  check();
  const indexRows = createRecordPreparedIndex(db, { assertRunning: check }),
    stateIndex = createRecordPreparedIndex(db, { assertRunning: check }),
    valueChecks = createRecordPreparedIndex(db, { assertRunning: check }),
    backingRows = createRecordPreparedIndex(db, { assertRunning: check }),
    identities = versionIdentityIndex(),
    sourceDeltaRows: RecordAcceptedSourceDeltaRow[] = [],
    bookkeeping: RecordBookkeeping = {
      writes: 0n,
      metadataKeys: new Set(),
      metadataOnly: true,
    };
  proof.indexRows = indexRows;
  proof.stateIndex = stateIndex;
  proof.valueChecks = valueChecks;
  proof.backingRows = backingRows;
  let sourceDeltaOverflow = false;
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
    for (const raw of proof.rows.pieceRows()) {
      check();
      const version = await parsePreparedRecordVersion(raw, check),
        previous = validateVersion(db, proof.config, commit, version, identities),
        { contents, ...metadata } = version,
        contentsJson = await stringifyPreparedRecordContents(contents, check);
      observeIntakeLogPublicationVersion(proof.intakeLogPublications, version, previous);
      const sourceFields: { name: string; hash: string; bytes: number }[] = [];
      if (version.entity === 'source_files' && !version.deleted)
        for (const name of ['id', 'kind', 'path', 'sha256', 'bytes']) {
          const value = contents[name];
          if (name === 'bytes' ? typeof value !== 'number' : typeof value !== 'string')
            fail('prepared source binding field differs');
          const field =
            typeof value === 'string'
              ? await recordStringFieldDigest(value, check)
              : recordFieldDigest(JSON.stringify(value));
          sourceFields.push({ name, ...field });
        }
      if (version.entity === 'source_files' && !sourceDeltaOverflow) {
        if (sourceDeltaRows.length >= MAX_SOURCE_DELTA_ROWS) {
          sourceDeltaRows.length = 0;
          sourceDeltaOverflow = true;
        } else {
          const digest = await digestRecordPieces(rawRecordPieces(contentsJson), check);
          sourceDeltaRows.push({
            recordId: version.recordId,
            versionId: version.versionId,
            previousVersion: version.previousVersion,
            deleted: version.deleted,
            contentsHash: digest.hash,
            contentsBytes: digest.bytes,
            fields: sourceFields,
          });
        }
      }
      await backingRows.append(
        'SELECT ?,?,?,?,?,?,?',
        [
          version.entity,
          version.recordId,
          version.versionId,
          Number(version.deleted),
          version.previousVersion,
          contentsJson,
          stringifyRecordJson(sourceFields),
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
    for (const source of parent!.originalSources(assertions)) {
      check();
      await valueChecks.appendCheck(
        'SELECT 1 FROM main.source_files WHERE id IS ? AND kind IS ? AND path IS ? AND sha256 IS ? AND bytes IS ?',
        [
          source.binding.intakeId,
          'intake_original',
          source.acceptedPath,
          source.binding.sourceHash,
          source.binding.bytes,
        ],
        true,
      );
      check();
    }
    await valueChecks.seal();
    await backingRows.seal();
    finishIntakeLogPublicationIndex(proof.intakeLogPublications);
    proof.sourceDeltaRows = sourceDeltaOverflow ? undefined : Object.freeze(sourceDeltaRows);
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
    witness: staging ?? proof.contributorStaging!,
    head: encode(ref).toString('utf8'),
  });
  proof.backingPlan = backingPlan;
  if (proof.contributorStaging) {
    await prepareContributorRecordBackingAdvance(
      proof.contributorStaging,
      encode(ref).toString('utf8'),
      backingPlan,
    );
    check();
  } else {
    await prepareVaultRecordTransactionBackingAdvance(
      staging!,
      encode(ref).toString('utf8'),
      backingPlan,
    );
    check();
  }
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
    (!proof.staging && !proof.contributorStaging) ||
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
    staging = (admitted.staging ?? admitted.contributorStaging)!,
    plan = admitted.staged!,
    statements = admitted.terminal!,
    rows = admitted.indexRows!,
    valueChecks = admitted.valueChecks!,
    stateIndex = admitted.stateIndex!,
    assertions = clinicalOperationCallerAssertions(db, admitted.clinicalOperation),
    replay = prepareRecordReplay(db, admitted.token!),
    capture = prepareIntakeFrontierCaptureClear(db),
    stamp = Reflect.apply(readmissionPrepare, db, ['SELECT total_changes() AS n']);
  if (currentClinicalOperationReadonly(db) !== admitted.clinicalOperation)
    fail('record final publication requires its original operation');
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
      (admitted.staging
        ? !vaultRecordStagingCurrent(admitted.staging)
        : !contributorRecordStagingCurrent(admitted.contributorStaging!))
    )
      fail('record final publication original continuation changed');
  };
  check();
  const preparedResult = parseRecordJson<T>(admitted.resultJson!);
  check();
  if (admitted.maintenance) assertIntakeMaintenancePreparation(db, admitted.maintenance);
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
            admitted.replayToken = token;
            const total = () =>
              terminalStatement(db, 'SELECT total_changes() AS n', undefined, true).get()!
                .n as bigint;
            const start = total();
            if (
              terminalStatement(db, 'SELECT 1 FROM temp.__record_changed LIMIT 1').get() ||
              clearIntakeFrontierRecordCapture(db, capture) !== 0
            )
              fail('record replay began with unowned captured rows');
            if (admitted.staging) bindVaultRecordStagingTransaction(admitted.staging);
            if (admitted.maintenance) beginIntakeMaintenanceReplay(db, admitted.maintenance, token);
            replayTerminalRecordMutations(db, admitted.recipe);
            if (admitted.maintenance) {
              verifyIntakeMaintenanceReplay(
                db,
                admitted.maintenance,
                token,
                admitted.resultJson!,
                start + admitted.businessWrites!,
              );
              admitted.replayMaintenanceVerified = true;
            }
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
            if (admitted.operation.actor !== 'source-text' && !admitted.maintenance)
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
            let maintenanceWrites: bigint | undefined;
            if (admitted.maintenance) {
              const keys = intakeFrontierOwnedMetadataKeys(db, token),
                bookkeeping = admitted.indexBookkeeping;
              if (keys && bookkeeping?.metadataOnly) {
                const capturedKeys = new Set([...keys].map((key) => stringifyRecordJson([key])));
                let exact = true;
                for (const row of terminalStatement(
                  db,
                  'SELECT entity,record_id FROM __record_changed',
                ).iterate())
                  if (row.entity !== 'app_meta' || !capturedKeys.delete(row.record_id as string))
                    exact = false;
                const indexedKeys = new Set([...keys].filter((key) => !internalKey(key)));
                if (
                  exact &&
                  capturedKeys.size === 0 &&
                  BigInt(keys.size) === BigInt(admitted.captureRows!) &&
                  indexedKeys.size === bookkeeping.metadataKeys.size &&
                  [...indexedKeys].every((key) => bookkeeping.metadataKeys.has(key))
                )
                  maintenanceWrites = bookkeeping.writes + 2n * BigInt(keys.size);
              }
            }
            if (
              BigInt(clearIntakeFrontierRecordCapture(db, capture)) !==
              BigInt(admitted.captureRows!)
            )
              fail('record replay captured membership differs');
            if (maintenanceWrites !== undefined)
              maintenanceBookkeeping.set(db, { token, writes: maintenanceWrites });
            assertClinicalOperation(db, admitted.clinicalOperation);
            originals.current(assertions);
            if (
              state.get(db) !== admitted.config ||
              currentTransactionToken(db) !== token ||
              (admitted.staging
                ? !vaultRecordStagingCurrent(admitted.staging)
                : !contributorRecordStagingCurrent(admitted.contributorStaging!))
            )
              fail('record replay final owner changed');
            if (admitted.staging) prepareVaultRecordHead(admitted.staging);
            const indexed = Object.freeze({}) as RecordTransactionIndexedPublication;
            transactionIndexedPublications.set(indexed, {
              proof: admitted,
              plan: admitted.backingPlan!,
              witness: staging,
              token,
              head: encode(plan.ref).toString('utf8'),
              consumed: false,
            });
            try {
              markSelectionAttempt(db);
              noteHeadPublication(admitted.config.storage);
              if (admitted.staging)
                installVaultRecordTransactionHead(
                  admitted.staging,
                  encode(plan.ref),
                  indexed,
                  admitted.backingPlan!,
                );
              else
                installContributorRecordStagingHead(
                  admitted.contributorStaging!,
                  indexed,
                  admitted.backingPlan!,
                );
            } finally {
              noteHeadPublication(admitted.config.storage);
              transactionIndexedPublications.delete(indexed);
            }
            return preparedResult;
          }),
        );
      },
    });
    result = (await (admitted.staging
      ? finishVaultRecordTransactionPreparation(admitted.staging, admitted.backingPlan!, execution)
      : finishContributorRecordTransactionPreparation(
          admitted.contributorStaging!,
          admitted.backingPlan!,
          execution,
        ))) as T;
  } finally {
    transactionTerminalExecutions.delete(execution);
    // The real final outcome is observable only after the finite scope expires.
    // A failed selection retains existing uncertain-durability semantics.
    const outcome = notifyRecordReplay(db, replay);
    finishIntakeLogPublicationOutcome(
      db,
      admitted.intakeLogPublications,
      outcome,
      admitted.token,
      admitted.replayToken,
    );
    admitted.intakeLogPublications = undefined;
    if (outcome?.committed && outcome.succeeded) {
      originals.expectedHead = stringifyRecordJson(plan.ref);
      originals.expectedSequence = plan.commit.sequence;
      acceptedTransactionBackings.set(admitted.backingPlan!, {
        db,
        witness: staging,
      });
      if (admitted.contributorStaging)
        completeContributorRecordStagingPublication(
          db,
          admitted.contributorStaging,
          admitted.backingPlan!,
        );
      else completeVaultRecordTransactionPublication(db, admitted.staging!, admitted.backingPlan!);
      try {
        if (admitted.sourceDeltaRows !== undefined) {
          retainRecordAcceptedSourceDeltaCandidate(
            db,
            outcome.token,
            stringifyRecordJson(plan.commit.previous),
            stringifyRecordJson(plan.ref),
            plan.commit.sequence,
            admitted.sourceDeltaRows,
          );
        }
      } catch {
        // A retained accelerator cannot change an already accepted outcome.
      }
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
    } else if (admitted.contributorStaging) {
      discardContributorRecordStaging(admitted.contributorStaging);
    } else if (admitted.staging) {
      discardVaultRecordStaging(admitted.staging);
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
  if (!token) return;
  // Every HEAD selection path reaches this point after its last SQL statement,
  // index update and policy compilation. Installed owners close their ORIGINAL
  // physical proofs here, so a refusal is still an unselected prepublication.
  const closures = selectionClosures.get(db);
  if (closures?.token === token) for (const close of [...closures.checks]) close();
  selectionAttempts.add(token);
}
const selectionClosures = new WeakMap<Database, { token: object; checks: Set<() => void> }>();
/** A fixed publication owner retains its original complete proof through the
 * transaction's callback-capable work (observers, installed SQL policy, journal
 * indexing) and closes it immediately before HEAD selection. The closure must
 * perform only filesystem and private-scratch checks: it runs after the final
 * application SQL, and it is bound to one transaction rather than a later one. */
export function installRecordSelectionClosure(
  db: Database,
  token: object,
  check: () => void,
): () => void {
  if (currentTransactionToken(db) !== token || selectionAttempts.has(token))
    fail('record selection closure requires its unselected transaction');
  let closures = selectionClosures.get(db);
  if (closures?.token !== token)
    selectionClosures.set(db, (closures = { token, checks: new Set() }));
  const owned = () => check();
  closures!.checks.add(owned);
  return () => {
    const current = selectionClosures.get(db);
    current?.checks.delete(owned);
    if (current && !current.checks.size) selectionClosures.delete(db);
  };
}
/** Only this attached record owner's frozen lexical hooks qualify. */
export function recordTerminalDurabilityParticipant(db: Database, participant: unknown): boolean {
  return state.has(db) && recordParticipants.get(db) === participant;
}
function fail(message: string): never {
  throw new Error('Record journal: ' + message);
}
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
  return parseHeadBinding(bytes);
}
function parseHeadBinding(bytes: unknown): {
  head: RecordObjectReference | null;
  wire: string | null;
} {
  if (Buffer.isBuffer(bytes)) recordVersionWork('headReadBytes', bytes.length);
  if (bytes === null || bytes === undefined) return { head: null, wire: null };
  const ref = parseRecordJson(bytes as unknown as string) as unknown;
  if (!refValid(ref)) fail('invalid head');
  if (!Buffer.isBuffer(bytes)) fail('record HEAD must be original bytes');
  return { head: ref as RecordObjectReference, wire: bytes.toString('utf8') };
}
function readOwnerHead(proof: {
  config: RecordConfig;
  read: RecordStorage['read'];
  contributor?: ContributorRecordReadOwner;
}): RecordObjectReference | null {
  if (!proof.contributor) return readHead(proof.config.storage, proof.read);
  recordVersionWork('headReadCalls');
  return parseHeadBinding(
    contributorRecordReadOwnerHeadBytes(proof.config.storage, proof.contributor),
  ).head;
}
/** Status-only HEAD cache, per attached configuration (one profile and one
 * storage object). An entry is reused only while the genuine storage's own
 * read and identity hook are unchanged and the hook reports the exact key
 * observed, settled, before the admitting content read and again after it.
 * Unknown or changed identity always reads. Own publications drop the entry. */
const statusHeadCache = new WeakMap<
  RecordConfig,
  {
    storage: RecordStorage;
    profileId: string;
    read: RecordStorage['read'];
    hook: () => RecordHeadIdentity | null;
    epoch: object;
    key: string;
    head: RecordObjectReference | null;
  }
>();
function forgetStatusHead(config: RecordConfig): void {
  statusHeadCache.delete(config);
}
// Every own HEAD publication or installation renews its storage's epoch, so
// cached status entries of every configuration sharing that storage drop.
const headPublicationEpochs = new WeakMap<object, object>();
function headPublicationEpoch(storage: RecordStorage): object {
  let epoch = headPublicationEpochs.get(storage);
  if (!epoch) headPublicationEpochs.set(storage, (epoch = Object.freeze({})));
  return epoch;
}
function noteHeadPublication(storage: RecordStorage): void {
  headPublicationEpochs.set(storage, Object.freeze({}));
}
function observeHeadIdentity(
  storage: RecordStorage,
  hook: () => RecordHeadIdentity | null,
): RecordHeadIdentity | null {
  recordVersionWork('headIdentityChecks');
  const identity = Reflect.apply(hook, storage, []) as unknown;
  return identity &&
    typeof (identity as RecordHeadIdentity).key === 'string' &&
    (identity as RecordHeadIdentity).key.length > 0 &&
    typeof (identity as RecordHeadIdentity).settled === 'boolean'
    ? {
        key: (identity as RecordHeadIdentity).key,
        settled: (identity as RecordHeadIdentity).settled,
      }
    : null;
}
function readStatusHead(config: RecordConfig): RecordObjectReference | null {
  const storage = config.storage,
    read = ownDescriptor(storage, 'read'),
    hook = ownDescriptor(storage, 'headIdentity');
  if (
    !read ||
    !('value' in read) ||
    typeof read.value !== 'function' ||
    !hook ||
    !('value' in hook) ||
    typeof hook.value !== 'function'
  ) {
    forgetStatusHead(config);
    return readHead(storage);
  }
  const epoch = headPublicationEpoch(storage),
    entry = statusHeadCache.get(config),
    before = observeHeadIdentity(storage, hook.value);
  if (
    entry &&
    before &&
    entry.storage === storage &&
    entry.profileId === config.profileId &&
    entry.read === read.value &&
    entry.hook === hook.value &&
    entry.epoch === epoch &&
    entry.key === before.key
  ) {
    recordVersionWork('headCacheHits');
    return entry.head;
  }
  forgetStatusHead(config);
  const head = readHead(storage, read.value);
  if (!before?.settled) return head;
  const after = observeHeadIdentity(storage, hook.value);
  if (after?.key === before.key && headPublicationEpoch(storage) === epoch)
    statusHeadCache.set(config, {
      storage,
      profileId: config.profileId,
      read: read.value,
      hook: hook.value,
      epoch,
      key: before.key,
      head,
    });
  return head;
}
function readConfiguredHead(db: Database, config: RecordConfig): RecordObjectReference | null {
  const terminal = activeCompactTerminal.get(db),
    authority = terminal && authorityWitnesses.get(terminal.prior.authority);
  if (!terminalStatementsActive(db)) return readHead(config.storage);
  if (
    (!authority?.staging && !authority?.contributorStaging) ||
    authority.config !== config ||
    !recordAuthorityWitnessIntervalCurrent(db, terminal!.prior.authority)
  )
    fail('compact accepted head owner changed');
  // The retained genuine staging owner keeps the original HEAD reader fixed
  // until its own lexical installer crosses the final publication boundary.
  return readHead(config.storage, authority!.read);
}
function writeObject(
  storage: RecordStorage,
  bytes: Buffer,
  prior?: SourcePriorData,
): RecordObjectReference {
  const ref = { name: 'objects/' + randomUUID(), sha256: digest(bytes), bytes: bytes.length };
  const authority = prior && authorityWitnesses.get(prior.authority);
  if (authority?.staging || authority?.contributorStaging) {
    prior!.assertCurrent();
    if (authority.staging) stageVaultRecordObject(authority.staging, ref, bytes);
    else stageContributorRecordObject(authority.contributorStaging!, ref, bytes);
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
function readRecordSegmentPage(
  storage: RecordStorage,
  ref: RecordObjectReference,
  commit: RecordCommitV2,
  expected: number,
): RecordSegmentPage {
  if (!refValid(ref) || ref.bytes > SEGMENT_PAGE_BYTES) fail('invalid segment page reference');
  const page = parseRecordJson<RecordSegmentPage>(readObject(storage, ref) as unknown as string);
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
  for (const segment of page.segments) if (!refValid(segment)) fail('invalid segment reference');
  return page;
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
  let first = commit.segments.head
    ? readRecordSegmentPage(storage, commit.segments.head, commit, commit.segments.count)
    : undefined;
  if (first?.firstSegment === 0) {
    // A complete authenticated page already supplies the bounded forward spool.
    // Validate every reference above before exposing even its first member.
    recordVersionWork('segmentReferencesSpooled', first.segments.length);
    for (const segment of first.segments) {
      recordVersionWork('segmentReferencesReplayed');
      yield segment;
    }
    return;
  }
  recordVersionWork('segmentOrderingScratchOpened');
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
      expected = commit.segments.count,
      preparedPage = first;
    first = undefined;
    while (ref) {
      const page = preparedPage ?? readRecordSegmentPage(storage, ref, commit, expected);
      preparedPage = undefined;
      for (let ordinal = 0; ordinal < page.segments.length; ordinal++) {
        const segment = page.segments[ordinal];
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
interface CommittedAncestry {
  head: RecordObjectReference | null;
  transactions: Iterable<IndexedTransaction>;
  length: number;
  close(): void;
}
/** Commits authenticated between ancestry-walk yields. */
const ANCESTRY_STEP_COMMITS = 64;
function* committedSinceSteps(
  storage: RecordStorage,
  profileId: string,
  schemaVersion: number,
  stop: RecordObjectReference | null = null,
): Generator<void, CommittedAncestry> {
  const head = readHead(storage);
  // Only authenticated references enter this private ordering/cycle index.
  // Payloads always come from the selected journal again during replay.
  const scratch = disposableSqlite('circus-record-ancestry-');
  let complete = false;
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
      if (length % ANCESTRY_STEP_COMMITS === 0) yield;
    }
    complete = true;
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
  } finally {
    if (!complete) scratch.close();
  }
}
/** Reiterable reader: giant JSONL framing is spooled, not repeatedly concatenated. */
function readSegmentVersions(
  storage: RecordStorage,
  commit: RecordCommit,
  onSegmentBytes?: (bytes: number) => void,
  decodedPrefix?: readonly DurableRecordVersion[],
): Iterable<DurableRecordVersion> {
  return {
    *[Symbol.iterator]() {
      const segments = function* () {
        for (const ref of iterateRecordCommitSegments(storage, commit)) {
          const bytes = readObject(storage, ref);
          onSegmentBytes?.(bytes.length);
          yield bytes;
        }
      };
      let count = 0;
      let reused = false;
      for (const version of readRecordJsonLines(segments(), {
        parseSmall(text) {
          const retained = decodedPrefix?.[count];
          if (retained) {
            reused = true;
            return retained;
          }
          return parseRecordJson(text);
        },
        checkpoint: recordReplayCheckpoint,
        onWork(work) {
          recordVersionWork('journalRecordsSpooled', work.spooledRecords);
          recordVersionWork('journalRecordSpoolBytes', work.spooledBytes);
          recordVersionWorkMaximum('maxJournalRecordBufferBytes', work.maxRecordBufferBytes);
          recordVersionWorkMaximum('maxJournalRecordDecodeWindowBytes', work.maxSpoolReadBytes);
        },
      })) {
        recordVersionWork(reused ? 'replayDecodedVersionReuses' : 'decodedVersions');
        reused = false;
        yield version as DurableRecordVersion;
        count++;
      }
      if (count !== commit.records) fail('partial transaction');
    },
  };
}
/** One transaction's replay passes share one decode of the exact same
 * authenticated segment bytes. The first pass reads, hashes and parses every
 * segment once and still enforces the record count; later passes (validation,
 * reference checks, both application passes and indexing) each run their own
 * checks on those decoded values. Retention is bounded per transaction and
 * dropped with it, so memory never grows with history. Above either budget,
 * later passes still authenticate and frame every segment, but small records
 * in the retained prefix need not be parsed again. Giant records keep their
 * ordinary spool/decode path. No retained value escapes to caller callbacks. */
export const REPLAY_DECODE_REUSE_RECORDS = 4096;
export const REPLAY_DECODE_REUSE_BYTES = 8 * 1024 * 1024;
function replayTransactionVersions(
  storage: RecordStorage,
  commit: RecordCommit,
): Iterable<DurableRecordVersion> {
  let decoded: DurableRecordVersion[] | null = null;
  return {
    *[Symbol.iterator]() {
      if (decoded && decoded.length === commit.records) {
        for (const version of decoded) {
          recordVersionWork('replayDecodedVersionReuses');
          yield version;
        }
        return;
      }
      let bytes = 0;
      const collecting: DurableRecordVersion[] | null = decoded === null ? [] : null;
      let retaining = collecting !== null;
      const versions = readSegmentVersions(
        storage,
        commit,
        (length) => {
          bytes += length;
          if (retaining && bytes > REPLAY_DECODE_REUSE_BYTES) {
            retaining = false;
            recordVersionWork('replayDecodeReuseOverBudget');
          }
        },
        decoded ?? undefined,
      );
      for (const version of versions) {
        if (retaining) {
          collecting!.push(version);
          if (collecting!.length === REPLAY_DECODE_REUSE_RECORDS) retaining = false;
        }
        yield version;
      }
      // Reached only after the complete pass, including the partial-transaction check.
      if (collecting) decoded = collecting;
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
  const logPublications = [
    ...(pendingIntakeLogPublications.get(db)?.get(currentTransactionToken(db)!) ?? []),
  ];
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
      observeIntakeLogPublicationVersion(logPublications, version, previous);
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
  finishIntakeLogPublicationIndex(logPublications);
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
/** The inert changed-row locator for one accepted source version: the field
 * digests a lookup consumer compares against current SQL. Throws when a bound
 * field is unavailable; the caller then retains no candidate at all. */
function acceptedSourceDeltaRow(version: DurableRecordVersion): RecordAcceptedSourceDeltaRow {
  const digestPieces = (pieces: Iterable<string>) => {
    const hash = createHash('sha256');
    let bytes = 0;
    for (const piece of pieces) {
      hash.update(piece);
      bytes += Buffer.byteLength(piece);
    }
    return { hash: hash.digest('hex'), bytes };
  };
  const fields = version.deleted
    ? []
    : ['id', 'kind', 'path', 'sha256', 'bytes'].map((name) => {
        const value = version.contents[name];
        if (name === 'bytes' ? typeof value !== 'number' : typeof value !== 'string')
          throw Error('source candidate field unavailable');
        return {
          name,
          ...digestPieces(
            typeof value === 'string'
              ? escapedRecordStringPieces([value])
              : [stringifyRecordJson(value)],
          ),
        };
      });
  const contentDigest = digestPieces(sourcePreimagePieces(version.contents));
  return {
    recordId: version.recordId,
    versionId: version.versionId,
    previousVersion: version.previousVersion,
    deleted: version.deleted,
    contentsHash: contentDigest.hash,
    contentsBytes: contentDigest.bytes,
    fields,
  };
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
      authority = authorityWitnesses.get(prior.authority),
      staging = authority?.staging,
      contributor = authority?.contributorStaging;
    if (
      plan.consumed ||
      (!staging && !contributor) ||
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
    if (staging) bindVaultRecordStagingTransaction(staging);
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
    if (staging) prepareVaultRecordHead(staging);
    renewIntakeMaintenanceAfterIndex(db, operation.intakeMaintenance!, prior.indexed!);
    markSelectionAttempt(db);
    noteHeadPublication(config.storage);
    if (staging) {
      try {
        installVaultRecordHead(staging, encode(plan.ref), prior.indexed!);
      } finally {
        noteHeadPublication(config.storage);
      }
    } else {
      const backing = plan.contributorBacking;
      if (!backing) fail('compact contributor backing plan missing');
      const indexed = Object.freeze({}) as RecordCompactContributorIndexedPublication;
      compactContributorIndexed.set(indexed, {
        plan: backing,
        token: currentTransactionToken(db)!,
        head: encode(plan.ref).toString('utf8'),
        consumed: false,
      });
      try {
        installContributorRecordStagingHead(contributor!, indexed, backing);
        if (!compactContributorIndexed.get(indexed)?.consumed)
          fail('compact contributor indexed backing not consumed');
      } finally {
        noteHeadPublication(config.storage);
        compactContributorIndexed.delete(indexed);
      }
      indexedPublications.get(prior.indexed!)!.backingConsumed = true;
    }
    indexedPublications.get(prior.indexed!)!.installed = true;
    // The actual lexical installer authenticates HEAD readback itself. Do not
    // re-enter a storage callback after the final publication/continuation seal.
    // The accepted link is the plan's own installed HEAD and commit; its source
    // rows are inert locators over the exact versions just indexed.
    let sourceDeltaRows: readonly RecordAcceptedSourceDeltaRow[] | undefined;
    try {
      sourceDeltaRows = Object.freeze(
        plan.versions
          .filter((version) => version.entity === 'source_files')
          .map(acceptedSourceDeltaRow),
      );
    } catch {
      sourceDeltaRows = undefined;
    }
    return {
      sequence: plan.commit.sequence,
      operationId: plan.commit.operationId,
      records: count,
      bookkeeping,
      headJson: stringifyRecordJson(plan.ref),
      previousHeadJson: stringifyRecordJson(plan.commit.previous),
      sourceDeltaRows,
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
  const sourceDeltaRows: RecordAcceptedSourceDeltaRow[] = [];
  let sourceDeltaOverflow = false;
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
    if (version.entity === 'source_files' && !sourceDeltaOverflow) {
      // Bounded, not capped at one page: a candidate past the absolute row
      // bound is dropped and its interval takes the full fallback.
      if (sourceDeltaRows.length >= MAX_SOURCE_DELTA_ROWS) {
        sourceDeltaRows.length = 0;
        sourceDeltaOverflow = true;
      } else {
        try {
          sourceDeltaRows.push(acceptedSourceDeltaRow(version));
        } catch {
          sourceDeltaRows.length = 0;
          sourceDeltaOverflow = true;
        }
      }
    }
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
    noteHeadPublication(config.storage);
    try {
      if (staging) installVaultRecordHead(staging, encode(ref));
      else config.storage.publishHead(encode(ref));
    } finally {
      noteHeadPublication(config.storage);
    }
  } else {
    markSelectionAttempt(db);
    noteHeadPublication(config.storage);
    try {
      config.storage.publishHead(encode(ref));
    } finally {
      noteHeadPublication(config.storage);
    }
  }
  if (!eq(readHead(config.storage), ref)) fail('head publication failed verification');
  if (!prior) {
    const published = {
      head: JSON.stringify(ref) + '\n',
      previous: previous ? JSON.stringify(previous) + '\n' : null,
    };
    retireContributorRecordStagingAfterOrdinaryHead(config.storage, published);
    retainVaultRecordFrontierAfterOrdinaryHead(db, config.storage, published);
  }
  if (prior) indexedPublications.get(prior.indexed!)!.installed = true;
  return {
    sequence,
    operationId,
    records: count,
    bookkeeping,
    headJson: stringifyRecordJson(ref),
    previousHeadJson: stringifyRecordJson(previous),
    sourceDeltaRows: sourceDeltaOverflow ? undefined : Object.freeze(sourceDeltaRows),
  };
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
/** Drive step-wise work synchronously, unchanged from its former sync form. */
function finishRecordSteps<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
/** Runs each step of `steps` inside a record-version work phase, so counters
 * stay attributed across a driver's yields. */
function* recordPhaseSteps<T>(
  phase: 'operation' | 'reconstruction',
  steps: Generator<void, T>,
): Generator<void, T> {
  try {
    for (;;) {
      const next = withRecordVersionWorkPhase(phase, () => steps.next());
      if (next.done) return next.value;
      yield;
    }
  } finally {
    withRecordVersionWorkPhase(phase, () => steps.return(undefined as never));
  }
}
/** Replay versions validated or applied between catch-up yields. */
const CATCH_UP_STEP_VERSIONS = 256;
function catchUpSteps(
  db: Database,
  config: RecordConfig,
  options: { empty?: boolean } = {},
): Generator<void, RecordObjectReference | null> {
  return recordPhaseSteps('reconstruction', catchUpRecordsSteps(db, config, options));
}
function* catchUpRecordsSteps(
  db: Database,
  config: RecordConfig,
  { empty = false }: { empty?: boolean } = {},
): Generator<void, RecordObjectReference | null> {
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
  const ancestry = yield* committedSinceSteps(
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
    // A driver may abandon these steps between yields (return()), which runs
    // finally blocks only; the private transaction is then rolled back too.
    let committed = false;
    try {
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${q(trigger.name)}`);
      if (!indexed && empty)
        for (const table of config.schema) db.exec(`DELETE FROM ${q(table.name)}`);
      let stepVersions = 0;
      for (const selected of transactions) {
        const tx = {
          ...selected,
          versions: replayTransactionVersions(config.storage, selected.commit),
        };
        const identities = versionIdentityIndex();
        try {
          for (const version of tx.versions) {
            validateVersion(db, config, tx.commit, version, identities);
            observeRecordReplayVersion(version);
            if (++stepVersions >= CATCH_UP_STEP_VERSIONS) {
              stepVersions = 0;
              yield;
            }
          }
        } finally {
          identities.close();
        }
        if (config.verifyReferences)
          for (const version of tx.versions) config.verifyReferences([structuredClone(version)]);
        applyVersions(db, config, tx.versions);
        indexTransaction(db, config, tx);
        if (revision(db) !== tx.commit.revision) fail('committed revision record is missing');
        completeRecordReplayCommit(tx.commit);
        stepVersions = 0;
        yield;
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
      committed = true;
    } finally {
      if (!committed && db.isTransaction) db.exec('ROLLBACK');
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
  options: AttachRecordDurabilityOptions = {},
): RecordDurabilityStatus {
  return finishRecordSteps(attachRecordDurabilitySteps(db, options));
}
/** Step-wise attachment: the same work as attachRecordDurability, yielding
 * between bounded replay steps of catch-up. The database stays inside one
 * private IMMEDIATE transaction across those yields, so it must not be shared
 * until the generator completes. A step driver owns re-proof around yields. */
export function* attachRecordDurabilitySteps(
  db: Database,
  {
    profileId,
    storage,
    verifyReferences,
    segmentBytes = LIMIT,
  }: AttachRecordDurabilityOptions = {},
): Generator<void, RecordDurabilityStatus> {
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
  if (readHead(storage)) yield* catchUpSteps(db, config, { empty: !indexed });
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
  return completeRecordAttach(db, config);
}
function completeRecordAttach(db: Database, config: RecordConfig): RecordDurabilityStatus {
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
        preparation.intakeLogPublications = pendingIntakeLogPublications.get(db)?.get(token!);
        pendingIntakeLogPublications.get(db)?.delete(token!);
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
          recordMutationRecipe: preparation.recipe,
          statements: [
            ...new Set([
              ...preparation.recipe.sql(),
              ...(operation.intakeMaintenance
                ? intakeMaintenanceReplayStatements().map((statement) => statement.sql)
                : []),
              'SELECT total_changes() AS n',
              'SELECT * FROM __record_state WHERE singleton=1',
              'SELECT commit_json FROM __record_transactions WHERE sequence=?',
              'SELECT * FROM __record_transactions WHERE operation_id=?',
              'SELECT 1 FROM temp.__record_changed LIMIT 1',
              'DELETE FROM temp.__record_changed',
              'SELECT 1 FROM main.source_files WHERE id IS ? AND kind IS ? AND path IS ? AND sha256 IS ? AND bytes IS ?',
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
        if (operation.intakeMaintenance)
          preparation.maintenance = captureIntakeMaintenancePreparation(
            db,
            operation.intakeMaintenance,
            token!,
            operation,
          );
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
      if (
        captured &&
        captured.token === currentTransactionToken(db) &&
        publication.sourceDeltaRows &&
        publication.headJson &&
        publication.previousHeadJson
      ) {
        let pending = ordinarySourceDeltaPending.get(db);
        if (!pending) ordinarySourceDeltaPending.set(db, (pending = new Map()));
        if (!pending.has(captured.token) && pending.size < MAX_SOURCE_DELTA_CANDIDATES)
          pending.set(captured.token, {
            previousHeadJson: publication.previousHeadJson,
            headJson: publication.headJson,
            sequence: publication.sequence,
            sources: publication.sourceDeltaRows,
          });
      }
    },
    release(captured) {
      if (!captured) return;
      const keys = intakeFrontierOwnedMetadataKeys(db, captured.token);
      const bookkeeping = captured.bookkeeping;
      let exact = !!(captured.empty && keys && bookkeeping);
      // Owned source rows (an intake maintenance commit's own source writes,
      // whose trigger capture the frontier observer already credits) add
      // exactly their indexed writes and one capture clear each.
      const sources = new Set<string>();
      if (exact) {
        const expected = new Set([...keys!].map((key) => JSON.stringify([key])));
        for (const row of terminalStatement(
          db,
          'SELECT entity,record_id FROM temp.__record_changed',
        ).iterate()) {
          if (row.entity === 'app_meta' && expected.delete(row.record_id as string)) continue;
          let id: string | undefined;
          if (row.entity === 'source_files' && typeof row.record_id === 'string')
            try {
              const key: unknown = JSON.parse(row.record_id);
              if (
                Array.isArray(key) &&
                key.length === 1 &&
                typeof key[0] === 'string' &&
                JSON.stringify(key) === row.record_id
              )
                id = key[0];
            } catch {
              id = undefined;
            }
          if (id === undefined || sources.has(id)) {
            exact = false;
            break;
          }
          sources.add(id);
        }
        exact &&= expected.size === 0 && bookkeeping!.metadataOnly === (sources.size === 0);
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
      if (exact && BigInt(cleared) === BigInt(keys!.size + sources.size))
        maintenanceBookkeeping.set(db, {
          token: captured.token,
          writes: bookkeeping!.writes + 2n * BigInt(keys!.size) + BigInt(sources.size),
          ...(sources.size ? { sources: Object.freeze(sources) } : {}),
        });
    },
  };
  Object.freeze(participant);
  ordinarySourceDeltaStops.get(db)?.();
  ordinarySourceDeltaStops.delete(db);
  ordinarySourceDeltaPending.delete(db);
  pendingIntakeLogPublications.delete(db);
  recordParticipants.set(db, participant);
  registerTransactionDurability(db, participant);
  const stopSourceDeltaOutcome = sourceDeltaOutcomes.observe(db, (outcome) => {
    if (recordParticipants.get(db) !== participant) return;
    const logPublications = pendingIntakeLogPublications.get(db)?.get(outcome.token);
    pendingIntakeLogPublications.get(db)?.delete(outcome.token);
    finishIntakeLogPublicationOutcome(db, logPublications, outcome, outcome.token, outcome.token);
    const pending = ordinarySourceDeltaPending.get(db),
      candidate = pending?.get(outcome.token);
    pending?.delete(outcome.token);
    if (candidate && outcome.committed && outcome.succeeded)
      retainRecordAcceptedSourceDeltaCandidate(
        db,
        outcome.token,
        candidate.previousHeadJson,
        candidate.headJson,
        candidate.sequence,
        candidate.sources,
      );
  });
  ordinarySourceDeltaStops.set(db, stopSourceDeltaOutcome);
  observeDatabaseClose(db, () => {
    stopSourceDeltaOutcome();
    if (ordinarySourceDeltaStops.get(db) === stopSourceDeltaOutcome)
      ordinarySourceDeltaStops.delete(db);
    ordinarySourceDeltaPending.delete(db);
    pendingIntakeLogPublications.delete(db);
  });
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
  const config = state.get(db)!,
    head = terminalStatementsActive(db) ? readConfiguredHead(db, config) : readStatusHead(config);
  const behind = !eq(head, parseRecordJson(row.head_json));
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
/** Route selection only. The later staging capture still proves authority. */
export function recordCompactSourceStreamSupported(db: Database): boolean {
  const config = state.get(db);
  return (
    !!config &&
    (vaultRecordReadOwnerSupported(config.storage) ||
      contributorRecordReadOwnerSupported(config.storage))
  );
}
interface SourcePriorData {
  db: Database;
  authority: RecordAuthorityWitness;
  methods: object;
  recordId: string;
  versionId: string;
  contents?: string;
  preimage?: RecordFieldDigest;
  fields: PreparedRecordPriorFields;
  assertCurrent(): void;
  consumed?: boolean;
  contributorTerminalActive?: boolean;
  contributorTerminalCommitted?: boolean;
  contributorTerminalFinalized?: boolean;
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
    contributorBacking?: RecordCompactContributorBackingPlan;
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
      ((authority.staging || authority.contributorStaging) &&
        (!prior.plan?.consumed || !indexed.backingConsumed)) ||
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
type CompactParentBinding = Readonly<{
  id: string;
  path: string;
  sha256: string;
  bytes: number;
  provider_id: string;
  batch_id: string;
}>;
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
    staging: VaultRecordStagingWitness | ContributorRecordStagingWitness;
    assertions: readonly (() => void)[];
    authorization?: VaultCompactAuthorization;
    sealed?: {
      originals: readonly PackageSourceOriginalPhysical[];
      parents: readonly CompactParentBinding[];
    };
    issuers: {
      request: typeof import('./index.ts').requestFilenameAssertionCurrent;
      assistant: typeof import('./assistant.ts').assistantCompactAssertionPrerequisites;
      session: typeof import('./intake-package-session.ts').packageSessionAssertionPrerequisites;
      child: typeof import('./intake.ts').intakeChildSchemaAssertionPrerequisites;
      childLive: typeof import('./intake.ts').intakeChildSchemaAssertionLive;
      childParent: typeof import('./intake.ts').intakeChildSchemaParentBinding;
      originalSource: typeof import('./intake-package-session.ts').packageSessionOriginalPhysicalSource;
      authorization: typeof import('./vault-app.ts').vaultCompactAuthorizationCurrent;
    };
  }
>();
/** Genuine issuer state only; no callback/SQL/storage reads at the last worker. */
export function recordCompactTerminalOwnerCurrent(
  owner: RecordCompactTerminalOwner,
  db: Database,
  staging: VaultRecordStagingWitness | ContributorRecordStagingWitness,
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
      proof.issuers.assistant(assertion, db) ??
      proof.issuers.session(assertion, db) ??
      (proof.sealed ? proof.issuers.childLive(assertion, db) : proof.issuers.child(assertion, db));
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
  staging: VaultRecordStagingWitness | ContributorRecordStagingWitness,
): Generator<PackageSourceOriginalPhysical> {
  if (!recordCompactTerminalOwnerCurrent(owner, db, staging))
    fail('compact original source owner expired');
  const proof = compactTerminalOwners.get(owner)!;
  if (proof.sealed) {
    yield* proof.sealed.originals;
    return;
  }
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
      proof.issuers.assistant(assertion, db) ??
      proof.issuers.session(assertion, db) ??
      proof.issuers.child(assertion, db);
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
/** Run every dynamic child/source callback before the last physical worker. */
export function sealRecordCompactTerminalWorker(
  owner: RecordCompactTerminalOwner,
  db: Database,
  staging: VaultRecordStagingWitness | ContributorRecordStagingWitness,
): void {
  const proof = compactTerminalOwners.get(owner);
  if (!proof || proof.sealed || !recordCompactTerminalOwnerCurrent(owner, db, staging))
    fail('compact worker issuer expired');
  const originals = Object.freeze([...recordCompactTerminalOriginalSources(owner, db, staging)]);
  const parents: CompactParentBinding[] = [];
  const visited = new Set<() => void>();
  const visit = (assertion: () => void): void => {
    if (visited.has(assertion)) return;
    visited.add(assertion);
    const parent = proof.issuers.childParent(assertion, db);
    if (parent) parents.push(parent);
    const prerequisites =
      proof.issuers.assistant(assertion, db) ??
      proof.issuers.session(assertion, db) ??
      proof.issuers.childLive(assertion, db);
    if (prerequisites) for (const prerequisite of prerequisites) visit(prerequisite);
  };
  for (const assertion of proof.assertions) visit(assertion);
  if (!recordCompactTerminalOwnerCurrent(owner, db, staging))
    fail('compact worker issuer changed before physical verification');
  proof.sealed = { originals, parents: Object.freeze(parents) };
  if (!recordCompactTerminalOwnerCurrent(owner, db, staging)) fail('compact worker lease expired');
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
    contributor = authority?.contributorStaging,
    operation = currentClinicalOperation(db);
  if (!prior || prior.db !== db || prior.consumed || !authority)
    fail('foreign compact terminal preparation');
  if (!staging && !contributor) return false;
  if (!operation || !plan?.deferredTerminal || preparedCompactTerminals.has(capability))
    fail('compact terminal preparation lifetime');
  // Application issuers load only on this async path, not record/database startup.
  prior.assertCurrent();
  const requestIssuer = await import('./index.ts'),
    assistantIssuer = await import('./assistant.ts'),
    sessionIssuer = await import('./intake-package-session.ts'),
    childIssuer = await import('./intake.ts'),
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
    staging: (staging ?? contributor)!,
    assertions: clinicalOperationCallerAssertions(db, operation!),
    authorization: staging
      ? authorizationIssuer.currentVaultCompactAuthorization(db, authority.config.profileId)
      : undefined,
    issuers: {
      request: requestIssuer.requestFilenameAssertionCurrent,
      assistant: assistantIssuer.assistantCompactAssertionPrerequisites,
      session: sessionIssuer.packageSessionAssertionPrerequisites,
      child: childIssuer.intakeChildSchemaAssertionPrerequisites,
      childLive: childIssuer.intakeChildSchemaAssertionLive,
      childParent: childIssuer.intakeChildSchemaParentBinding,
      originalSource: sessionIssuer.packageSessionOriginalPhysicalSource,
      authorization: authorizationIssuer.vaultCompactAuthorizationCurrent,
    },
  });
  if (!recordCompactTerminalOwnerCurrent(owner, db, (staging ?? contributor)!))
    fail('compact publication requires a genuine current owner issuer');
  const dynamic = ['source_files', 'app_meta'].map((entity) => {
    const table = authority.config.schema.find((item) => item.name === entity)!;
    return `SELECT * FROM ${q(entity)} WHERE ${table.pk.map((key) => q(key) + '=?').join(' AND ')}`;
  });
  dynamic.push(
    "SELECT f.id,f.path,f.sha256,f.bytes,f.provider_id,f.batch_id FROM main.source_files f JOIN main.providers p ON p.id=f.provider_id WHERE f.id=? AND f.kind='intake_original'",
  );
  const tempTableQuery = DatabaseSync.prototype.prepare.call(
    db,
    "SELECT 1 FROM sqlite_temp_schema WHERE type='table' AND name=?",
  );
  const tempSql = compactTerminalTempSql(
    (table) => !!Reflect.apply(StatementSync.prototype.get, tempTableQuery, [table]),
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
      ...tempSql,
    ],
    executions: compactTerminalExecutions,
  });
  const capture = prepareIntakeFrontierCaptureClear(db),
    callbacks = prepareTerminalTransactionCallbacks(db);
  // All compilation/caller effects precede verification of the ORIGINAL roster.
  prior.assertCurrent();
  assertClinicalOperation(db, operation);
  if (staging) await finishVaultRecordStagingPreparation(staging, owner);
  assertClinicalOperation(db, operation);
  if (
    !terminalTransactionCallbacksCurrent(db, callbacks) ||
    !recordCompactTerminalOwnerCurrent(owner, db, (staging ?? contributor)!) ||
    sourcePriorFields.get(capability) !== prior ||
    prior.consumed ||
    prior.plan !== plan
  )
    fail('compact terminal owner changed during worker');
  if (contributor) {
    const backing = plan.contributorBacking,
      retained = backing && compactContributorBackings.get(backing);
    if (!retained || retained.prior !== prior || retained.witness !== contributor)
      fail('compact contributor backing issuer changed');
    retained.owner = owner;
  }
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
  const authority = authorityWitnesses.get(terminal.prior.authority),
    staging = authority?.staging ?? authority?.contributorStaging;
  if (!staging || !recordCompactTerminalOwnerCurrent(terminal.owner, db, staging))
    fail('compact publication owner expired before terminal');
  const ownerProof = compactTerminalOwners.get(terminal.owner)!;
  if (!ownerProof.sealed) fail('compact terminal lacks final physical preflight');
  activeCompactTerminal.set(db, terminal);
  try {
    return withTerminalStatements(db, terminal.statements, () => {
      if (!terminalTransactionCallbacksCurrent(db, terminal.callbacks))
        fail('compact transaction participants changed');
      if (!recordCompactTerminalOwnerCurrent(terminal.owner, db, staging))
        fail('compact publication owner expired');
      const parentSql =
        "SELECT f.id,f.path,f.sha256,f.bytes,f.provider_id,f.batch_id FROM main.source_files f JOIN main.providers p ON p.id=f.provider_id WHERE f.id=? AND f.kind='intake_original'";
      for (const parent of ownerProof.sealed!.parents) {
        recordVersionWork('compactTerminalParentChecks');
        const selected = terminalStatement(db, parentSql).get(parent.id) as
          CompactParentBinding | undefined;
        if (
          !selected ||
          selected.id !== parent.id ||
          selected.path !== parent.path ||
          selected.sha256 !== parent.sha256 ||
          selected.bytes !== parent.bytes ||
          selected.provider_id !== parent.provider_id ||
          selected.batch_id !== parent.batch_id
        ) {
          recordVersionWork('compactTerminalParentRefusals');
          fail('compact parent source scope changed before terminal');
        }
      }
      return run();
    });
  } finally {
    activeCompactTerminal.delete(db);
    compactTerminalOwners.delete(terminal.owner);
  }
}
export function recordCompactContributorTerminalPrepared(
  db: Database,
  capability: RecordSourcePriorFields,
): boolean {
  const terminal = preparedCompactTerminals.get(capability),
    prior = terminal?.prior,
    authority = prior && authorityWitnesses.get(prior.authority),
    backing = prior?.plan?.contributorBacking;
  return (
    !!terminal &&
    !!prior &&
    prior.db === db &&
    !!authority?.contributorStaging &&
    !!backing &&
    compactContributorBackingCurrent(backing, db, authority.contributorStaging)
  );
}
/** The contributor worker performs its original physical pass before invoking
 * the exact already prepared compact T2 body. No adapter callback can replace
 * that body or turn the private capability into an ownership-report plan. */
export async function commitRecordCompactContributorTerminal<T>(
  db: Database,
  capability: RecordSourcePriorFields,
  run: () => T,
): Promise<T> {
  const terminal = preparedCompactTerminals.get(capability),
    prior = terminal?.prior,
    authority = prior && authorityWitnesses.get(prior.authority),
    witness = authority?.contributorStaging,
    plan = prior?.plan?.contributorBacking;
  if (
    !terminal ||
    !prior ||
    !witness ||
    !plan ||
    prior.contributorTerminalActive ||
    !compactContributorBackingCurrent(plan, db, witness)
  )
    fail('compact contributor terminal unavailable');
  prior.contributorTerminalActive = true;
  const execution = Object.freeze({}) as RecordCompactContributorTerminalExecution;
  compactContributorExecutions.set(execution, {
    plan,
    witness,
    used: false,
    complete: () => withRecordCompactTerminal(db, capability, run),
  });
  try {
    const result = (await finishContributorRecordTransactionPreparation(
      witness,
      plan,
      execution,
    )) as T;
    prior.contributorTerminalCommitted = true;
    return result;
  } catch (error) {
    prior.contributorTerminalFinalized = true;
    prior.contributorTerminalActive = false;
    try {
      if (sourcePriorFields.has(capability)) discardRecordSourcePriorFields(capability);
      else closeCompactContributorOriginal(prior);
    } catch {
      /* preserve the publication refusal or uncertain outcome */
    }
    throw error;
  } finally {
    compactContributorExecutions.delete(execution);
  }
}
/** Readmission is the only post-T2 point allowed to promote this derivative.
 * The genuine accepted HEAD/SQL receipt survives a refused or lost cache. */
export function finishRecordCompactContributorReadmission(
  db: Database,
  proof: RecordCompactReadmission,
  admitted: boolean,
): void {
  const prior = compactReadmissions.get(proof),
    authority = prior && authorityWitnesses.get(prior.authority),
    witness = authority?.contributorStaging,
    plan = prior?.plan?.contributorBacking;
  if (!prior || prior.db !== db || !witness || !plan || prior.contributorTerminalFinalized)
    fail('compact contributor readmission continuation unavailable');
  prior.contributorTerminalFinalized = true;
  try {
    if (admitted && prior.contributorTerminalCommitted) {
      const indexed = prior.indexed && indexedPublications.get(prior.indexed);
      if (!prior.plan?.consumed || !indexed?.installed || !indexed.backingConsumed)
        fail('compact contributor accepted index unavailable');
      const backing = compactContributorBackings.get(plan);
      if (!backing || backing.prior !== prior || backing.witness !== witness)
        fail('compact contributor accepted backing changed');
      backing.accepted = true;
      completeContributorRecordStagingPublication(db, witness, plan);
    } else discardContributorRecordStaging(witness);
  } finally {
    prior.contributorTerminalActive = false;
    compactContributorBackings.delete(plan);
    try {
      closeCompactContributorOriginal(prior);
    } catch {
      /* an accepted receipt is not revoked by derivative disposal */
    }
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
    staging = authority?.staging,
    contributor = authority?.contributorStaging;
  if (!prior || prior.db !== db || prior.consumed || prior.plan || !authority)
    fail('foreign compact publication preparation');
  if (!staging && !contributor) return;
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
  if (staging)
    await prepareVaultRecordStagingBacking(
      staging,
      head!.toString('utf8'),
      {
        sourceId: String(input.sourceRow.id),
        previousVersion: prior.versionId,
        preimage: prior.preimage ?? (await recordStringFieldDigest(prior.contents!, check)),
        fields: sourceColumns.map((name) => ({ name, ...prior.fields.get(name)! })),
        metadata: [input.headKey, input.sourcePinKey].map((key) => ({
          key,
          value: meta(db, key) as string | undefined,
        })),
      },
      check,
    );
  else if (!prior.preimage) fail('compact contributor accepted source preimage missing');
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
    if (staging)
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
    else
      assertContributorRecordTransactionPrior(
        contributor!,
        'app_meta',
        recordId,
        previous?.version_id ?? null,
        previous
          ? {
              deleted: !!previous.deleted,
              preimage: await digestRecordPieces(rawRecordPieces(previous.contents_json), check),
            }
          : null,
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
  const headWire = encode(ref).toString('utf8'),
    plan: NonNullable<SourcePriorData['plan']> = {
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
  if (staging) {
    await prepareVaultRecordBackingAdvance(staging, headWire, versions);
    if (!deferredTerminal) await finishVaultRecordStagingPreparation(staging);
    check();
    prior.plan = plan;
    return;
  }
  const backing = Object.freeze({}) as RecordCompactContributorBackingPlan;
  plan.contributorBacking = backing;
  prior.plan = plan;
  const changed: ContributorBackingVersion[] = [];
  try {
    for (const version of versions) {
      check();
      const sourceFields: { name: string; hash: string; bytes: number }[] = [];
      if (version.entity === 'source_files' && !version.deleted)
        for (const name of ['id', 'kind', 'path', 'sha256', 'bytes']) {
          const value = version.contents[name];
          if (name === 'bytes' ? typeof value !== 'number' : typeof value !== 'string')
            fail('compact contributor source binding field differs');
          const field =
            typeof value === 'string'
              ? await recordStringFieldDigest(value, check)
              : recordFieldDigest(stringifyRecordJson(value));
          sourceFields.push({ name, ...field });
        }
      changed.push(
        Object.freeze({
          entity: version.entity,
          recordId: version.recordId,
          versionId: version.versionId,
          deleted: version.deleted,
          previousVersion: version.previousVersion,
          contentsJson: await stringifyPreparedRecordContents(version.contents, check),
          sourceFields: Object.freeze(sourceFields),
        }),
      );
    }
    compactContributorBackings.set(backing, {
      db,
      witness: contributor!,
      prior,
      head: headWire,
      versions: Object.freeze(changed),
      preparationCurrent: check,
      accepted: false,
    });
    prepareContributorRecordStagingHead(contributor!, ref);
    await prepareContributorRecordBackingAdvance(contributor!, headWire, backing);
    check();
  } catch (error) {
    compactContributorBackings.delete(backing);
    prior.plan = undefined;
    throw error;
  }
}
async function parsePreparedRecordVersion(
  raw: Iterable<string>,
  check: () => void,
): Promise<DurableRecordVersion> {
  const iterator = raw[Symbol.iterator]();
  let prefix = '';
  try {
    // Small rows retain their fast path, but only after consuming the signed
    // stream to completion. Larger rows keep only this bounded prefix.
    while (prefix.length <= 16 * 1024) {
      check();
      const next = iterator.next();
      check();
      if (next.done) return parseRecordJson<DurableRecordVersion>(prefix);
      prefix += next.value;
    }
  } catch (error) {
    iterator.return?.();
    throw error;
  }
  recordVersionWork('parseCalls');
  const pieces = function* () {
    try {
      recordVersionWork('parsedBytes', Buffer.byteLength(prefix));
      yield prefix;
      for (;;) {
        const next = iterator.next();
        if (next.done) return;
        recordVersionWork('parsedBytes', Buffer.byteLength(next.value));
        yield next.value;
      }
    } finally {
      iterator.return?.();
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
    try {
      steps.return(undefined as never);
    } finally {
      iterator.return?.();
    }
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
function* escapedRecordStringPieces(values: Iterable<string>): Generator<string> {
  yield '"';
  for (const value of values) {
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(offset + 2048, value.length);
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
  }
  yield '"';
}
function* sourcePreimagePieces(
  contents: Record<string, unknown>,
  detail?: () => Iterable<string>,
  strings?: (name: string) => Iterable<string> | undefined,
): Generator<string> {
  yield '{';
  let first = true;
  for (const name of Object.keys(contents)) {
    if (!first) yield ',';
    first = false;
    yield JSON.stringify(name) + ':';
    if (name === 'details_json' && detail) {
      yield* escapedRecordStringPieces(detail());
      continue;
    }
    const streamed = strings?.(name);
    if (streamed) {
      yield* escapedRecordStringPieces(streamed);
      continue;
    }
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
async function compareRecordTextPieces(
  left: Iterable<string>,
  right: Iterable<string>,
  check: () => void,
): Promise<boolean> {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  let first: IteratorResult<string>;
  let second: IteratorResult<string>;
  let leftAt = 0;
  let rightAt = 0;
  try {
    first = a.next();
    second = b.next();
    for (;;) {
      check();
      while (!first.done && leftAt === first.value.length) {
        first = a.next();
        leftAt = 0;
      }
      while (!second.done && rightAt === second.value.length) {
        second = b.next();
        rightAt = 0;
      }
      if (first.done || second.done) return first.done === second.done;
      const length = Math.min(first.value.length - leftAt, second.value.length - rightAt);
      if (
        first.value.slice(leftAt, leftAt + length) !== second.value.slice(rightAt, rightAt + length)
      )
        return false;
      leftAt += length;
      rightAt += length;
      await yieldHost();
      check();
    }
  } finally {
    a.return?.();
    b.return?.();
  }
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
  previous: SourcePriorVersion,
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
  stream?: { reader: RecordCommittedColumnReader; sourceRowid: bigint },
): Promise<RecordSourcePriorFields> {
  assertRunning();
  const authority = originalAuthority ?? captureRecordAuthorityWitness(db),
    methods = managedDatabaseMethodEpoch(db),
    recordId = stringifyRecordJson([sourceId]),
    pointer = db
      .prepare(
        'SELECT CAST(v.rowid AS TEXT) AS __rowid,v.version_id,v.deleted FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
      )
      .get('source_files', recordId),
    writes = db.prepare('SELECT total_changes() AS n').get()!.n;
  const versionId = pointer?.version_id;
  if (!methods || typeof versionId !== 'string' || pointer?.deleted !== 0)
    throw Error('Record journal: prior source comparison unavailable');
  const authorityData = authorityWitnesses.get(authority);
  if (!authorityData || !recordAuthorityWitnessCurrent(db, authority))
    fail('foreign original source authority');
  if (authorityData!.staging || authorityData!.contributorStaging)
    fail('original source staging already prepared');
  authorityData!.staging = captureVaultRecordStaging(
    db,
    authorityData!.config.storage,
    authorityData!.epoch,
  );
  if (
    stream &&
    !authorityData!.staging &&
    contributorRecordReadOwnerSupported(authorityData!.config.storage)
  ) {
    const owner = captureRecordReadOwner(db, authorityData!.config.profileId),
      read = recordReadOwners.get(owner),
      contributor = read?.contributor;
    try {
      if (
        !read ||
        !contributor ||
        typeof read.wire !== 'string' ||
        !eq(read.head, authorityData!.head)
      )
        fail('compact contributor original selection unavailable');
      authorityData!.contributorStaging = captureContributorRecordStaging(
        db,
        authorityData!.config.storage,
        contributor,
      );
      if (!authorityData!.contributorStaging)
        fail('compact contributor original backing unavailable');
      authorityData!.contributorReadOwner = owner;
    } catch (error) {
      closeRecordReadOwner(owner);
      throw error;
    }
  }
  const check = () => {
    assertRunning();
    if (
      !recordAuthorityWitnessCurrent(db, authority) ||
      managedDatabaseMethodEpoch(db) !== methods ||
      db.prepare('SELECT total_changes() AS n').get()!.n !== writes
    )
      fail('prior source comparison authority changed');
  };
  const columns = authorityData!.config.schema.find(
    (table) => table.name === 'source_files',
  )!.columns;
  if (stream) {
    let prepared = false;
    try {
      if (authorityData!.contributorStaging) {
        const wire = recordReadOwners.get(authorityData!.contributorReadOwner!)?.wire;
        if (typeof wire !== 'string') fail('compact contributor original HEAD missing');
        await prepareContributorRecordTransactionBacking(
          authorityData!.contributorStaging,
          wire,
          check,
        );
        check();
      }
      if (
        (!authorityData!.staging && !authorityData!.contributorStaging) ||
        typeof sourceRow.__rowid !== 'string' ||
        sourceRow.__rowid !== String(stream.sourceRowid) ||
        Object.keys(sourceRow).length !== columns.length ||
        !columns.every((column) =>
          column === 'details_json'
            ? !Object.hasOwn(sourceRow, column)
            : Object.hasOwn(sourceRow, column),
        ) ||
        typeof pointer?.__rowid !== 'string'
      )
        fail('streamed compact source prior unavailable');
      const candidate = Object.fromEntries(columns.map((column) => [column, sourceRow[column]]));
      const details = () => stream.reader.text('source_files', 'details_json', stream.sourceRowid);
      const pieces = () => sourcePreimagePieces(candidate, details);
      const versionRowid = BigInt(pointer!.__rowid as string);
      if (
        !(await compareRecordTextPieces(
          pieces(),
          stream.reader.text('__record_versions', 'contents_json', versionRowid),
          check,
        ))
      )
        fail('compact source differs from selected prior version');
      recordVersionWork('compactPriorExactSourceMatches');
      const preimage = await digestRecordPieces(
        authorityData!.contributorStaging ? pieces() : escapedRecordStringPieces(pieces()),
        check,
      );
      const fields = await prepareRecordPriorFields(pieces(), check);
      try {
        check();
        for (const column of columns) {
          const value = sourceRow[column];
          const expected =
            column === 'details_json'
              ? await digestRecordPieces(escapedRecordStringPieces(details()), check)
              : typeof value === 'string'
                ? await recordStringFieldDigest(value, check)
                : recordFieldDigest(stringifyRecordJson(value));
          const accepted = fields.get(column);
          if (!accepted || accepted.hash !== expected.hash || accepted.bytes !== expected.bytes)
            fail('compact source differs from its accepted prior version');
          check();
        }
        if (authorityData!.contributorStaging)
          assertContributorRecordTransactionPrior(
            authorityData!.contributorStaging,
            'source_files',
            recordId,
            versionId,
            { deleted: false, preimage },
          );
        const retained = db
          .prepare(
            'SELECT 1 FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=? AND v.version_id=? AND v.deleted=0',
          )
          .get('source_files', recordId, versionId);
        if (!retained) fail('prior source comparison changed');
        const capability = Object.freeze({}) as RecordSourcePriorFields;
        sourcePriorFields.set(capability, {
          db,
          authority,
          methods: methods!,
          recordId,
          versionId,
          preimage,
          fields,
          assertCurrent: check,
        });
        prepared = true;
        return capability;
      } catch (error) {
        fields.close();
        throw error;
      }
    } finally {
      if (!prepared) {
        const staging = authorityData!.staging,
          contributor = authorityData!.contributorStaging,
          owner = authorityData!.contributorReadOwner;
        authorityData!.staging = undefined;
        authorityData!.contributorStaging = undefined;
        authorityData!.contributorReadOwner = undefined;
        try {
          if (staging) discardVaultRecordStaging(staging);
          if (contributor) discardContributorRecordStaging(contributor);
        } finally {
          if (owner) closeRecordReadOwner(owner);
        }
      }
    }
  }
  let candidateContents: string | undefined;
  let candidate: Record<string, unknown> | undefined;
  if (
    typeof sourceRow.__rowid === 'string' &&
    Object.keys(sourceRow).length === columns.length + 1 &&
    columns.every((column) => Object.hasOwn(sourceRow, column))
  ) {
    candidate = Object.fromEntries(columns.map((column) => [column, sourceRow[column]]));
    const pieces: string[] = [];
    for (const piece of sourcePreimagePieces(candidate)) {
      check();
      pieces.push(piece);
      await yieldHost();
    }
    candidateContents = pieces.join('');
    check();
  }
  const matching =
    candidateContents !== undefined &&
    db
      .prepare(
        'SELECT 1 FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=? AND v.version_id=? AND v.contents_json IS ? AND v.deleted=0',
      )
      .get('source_files', recordId, versionId, candidateContents);
  if (matching) recordVersionWork('compactPriorExactSourceMatches');
  check();
  const fallback = matching ? undefined : current(db, 'source_files', recordId);
  if (fallback) {
    recordVersionWork('compactPriorFullNativeRowsRead');
    recordVersionWork('compactPriorFullNativeBytesRead', Buffer.byteLength(fallback.contents_json));
  }
  const previous: SourcePriorVersion | undefined =
    matching && candidateContents !== undefined
      ? { version_id: versionId, deleted: 0, contents_json: candidateContents }
      : fallback;
  if (!previous || previous.deleted || previous.version_id !== versionId)
    fail('prior source comparison changed');
  if (!authorityData!.staging)
    await authenticateSelectedSourcePrior(
      authorityData!.config,
      authorityData!.head,
      recordId,
      previous!,
      check,
    );
  const fields = await prepareRecordPriorFields(
    matching ? sourcePreimagePieces(candidate!) : [previous!.contents_json],
    check,
  );
  try {
    check();
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
  if (data?.contributorTerminalActive) return;
  if (data) closeCompactContributorOriginal(data);
}
function closeCompactContributorOriginal(data: SourcePriorData): void {
  const authority = authorityWitnesses.get(data.authority),
    staging = authority?.staging,
    contributor = authority?.contributorStaging,
    owner = authority?.contributorReadOwner;
  try {
    if (staging) discardVaultRecordStaging(staging);
    if (contributor) discardContributorRecordStaging(contributor);
  } finally {
    if (owner) closeRecordReadOwner(owner);
  }
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
    ((authorityWitnesses.get(data.authority)?.staging ||
      authorityWitnesses.get(data.authority)?.contributorStaging) &&
      !data.plan) ||
    !recordAuthorityWitnessCurrent(db, data.authority) ||
    managedDatabaseMethodEpoch(db) !== data.methods ||
    !(data.contents === undefined
      ? terminalStatement(
          db,
          'SELECT 1 FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=? AND v.version_id=? AND v.deleted=0',
        ).get('source_files', data.recordId, data.versionId)
      : terminalStatement(
          db,
          'SELECT 1 FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=? AND v.version_id=? AND v.contents_json IS ? AND v.deleted=0',
        ).get('source_files', data.recordId, data.versionId, data.contents))
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
    !eq(readOwnerHead(proof!), proof!.head) ||
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
  const fixed = legacyFixedReads.get(owner);
  if (fixed) fixed.head.fill(0);
  legacyFixedReads.delete(owner);
  if (!proof) return;
  try {
    if (proof.vault) closeVaultRecordReadOwner(proof.vault);
  } finally {
    if (proof.contributor) closeContributorRecordReadOwner(proof.contributor);
  }
}
declare const acceptedIntakeHeadBrand: unique symbol;
export interface RecordAcceptedIntakeHeadRead {
  readonly [acceptedIntakeHeadBrand]: true;
}
const acceptedIntakeHeads = new WeakMap<
  RecordAcceptedIntakeHeadRead,
  {
    db: Database;
    owner: RecordReadOwner;
    key: string;
    value: string;
    methods: object;
    schema: unknown;
    tempSchema: unknown;
    peer: unknown;
    writes: unknown;
    selected: StatementSync;
    main: StatementSync;
    temp: StatementSync;
    external: StatementSync;
    total: StatementSync;
    current: () => void;
    vault?: VaultRecordAcceptedHeadRead;
    contributor?: ContributorRecordAcceptedHeadRead;
    pair?: RecordReplaySourcePairRequest;
    borrowedSource?: RecordAcceptedSourceRead;
    borrowedVault?: VaultRecordAcceptedSourceRead;
    borrowedContributor?: ContributorRecordAcceptedSourceRead;
  }
>();
/** Read-only accepted app_meta HEAD proof. Derivative SQL supplies only the
 * proposed bytes; the genuine original worker must agree before use. */
export async function captureRecordAcceptedIntakeHeadRead(
  db: Database,
  identity: IntakeStateIdentity,
  assertRunning: () => void,
  pair?: RecordReplaySourcePairRequest,
): Promise<RecordAcceptedIntakeHeadRead> {
  const requestedPair =
    pair &&
    Object.freeze({
      identity: Object.freeze(validateIntakeIdentity(pair.identity)),
      sourceVersionId: pair.sourceVersionId,
    });
  if (requestedPair && JSON.stringify(requestedPair.identity) !== JSON.stringify(identity))
    fail('accepted intake source pair identity differs');
  if (db.isTransaction || !recordReadOwnerSupported(db, identity.profileId))
    fail('accepted intake head read owner unavailable');
  const key = intakeNamespace(identity) + 'head',
    selected = Reflect.apply(readmissionPrepare, db, [
      'SELECT substr(value,1,4097) AS value,value IS substr(value,1,4097) AS complete FROM main.app_meta WHERE key=?',
    ]) as StatementSync,
    main = Reflect.apply(readmissionPrepare, db, ['PRAGMA main.schema_version']) as StatementSync,
    temp = Reflect.apply(readmissionPrepare, db, ['PRAGMA temp.schema_version']) as StatementSync,
    external = Reflect.apply(readmissionPrepare, db, ['PRAGMA main.data_version']) as StatementSync,
    total = Reflect.apply(readmissionPrepare, db, ['SELECT total_changes() AS n']) as StatementSync,
    methods = managedDatabaseMethodEpoch(db),
    row = Reflect.apply(readmissionGet, selected, [key]),
    value = row?.value;
  if (
    !methods ||
    typeof value !== 'string' ||
    row.complete !== 1 ||
    Buffer.byteLength(value) > 4096
  )
    fail('accepted intake head selected bytes unavailable');
  parseIntakeCollectionHead(value, identity);
  const owner = captureRecordReadOwner(db, identity.profileId),
    read = recordReadOwners.get(owner)!;
  if (typeof read.wire !== 'string') {
    closeRecordReadOwner(owner);
    fail('accepted intake head original HEAD unavailable');
  }
  const cap = Object.freeze({}) as RecordAcceptedIntakeHeadRead;
  const data = {
    db,
    owner,
    key,
    value,
    methods,
    schema: Reflect.apply(readmissionGet, main, [])!.schema_version,
    tempSchema: Reflect.apply(readmissionGet, temp, [])!.schema_version,
    peer: Reflect.apply(readmissionGet, external, [])!.data_version,
    writes: Reflect.apply(readmissionGet, total, [])!.n,
    selected,
    main,
    temp,
    external,
    total,
    current: () => {},
    vault: undefined as VaultRecordAcceptedHeadRead | undefined,
    contributor: undefined as ContributorRecordAcceptedHeadRead | undefined,
    pair: requestedPair,
  };
  acceptedIntakeHeads.set(cap, data);
  const current = () => {
    assertRunning();
    if (
      acceptedIntakeHeads.get(cap) !== data ||
      db.isTransaction ||
      managedDatabaseMethodEpoch(db) !== methods ||
      Reflect.apply(readmissionGet, main, [])!.schema_version !== data.schema ||
      Reflect.apply(readmissionGet, temp, [])!.schema_version !== data.tempSchema ||
      Reflect.apply(readmissionGet, external, [])!.data_version !== data.peer ||
      Reflect.apply(readmissionGet, total, [])!.n !== data.writes
    )
      fail('accepted intake head read interval changed');
    const now = Reflect.apply(readmissionGet, selected, [key]);
    if (now?.complete !== 1 || now.value !== value)
      fail('accepted intake head selected bytes changed');
    assertRecordReadOwnerBeforeVerification(db, owner);
  };
  data.current = current;
  try {
    current();
    if (read.vault)
      data.vault = await captureVaultRecordAcceptedHeadRead(
        db,
        read.config.storage,
        read.vault,
        read.wire,
        key,
        value,
        current,
        requestedPair,
      );
    else if (read.contributor)
      data.contributor = await captureContributorRecordAcceptedHeadRead(
        db,
        read.config.storage,
        read.contributor,
        read.wire,
        key,
        value,
        current,
        requestedPair,
      );
    else fail('accepted intake head genuine storage unavailable');
    current();
    return cap;
  } catch (error) {
    try {
      if (data.vault) closeVaultRecordAcceptedHeadRead(data.vault);
      if (data.contributor) closeContributorRecordAcceptedHeadRead(data.contributor);
    } catch {
      // The original failed admission is authoritative; cleanup still closes.
    } finally {
      acceptedIntakeHeads.delete(cap);
      closeRecordReadOwner(owner);
    }
    throw error;
  }
}
/** Borrow the selected V4 HEAD from a source-only replay without opening a
 * second original owner or replacing the retained physical roster. */
export function borrowRecordAcceptedIntakeHeadRead(
  db: Database,
  sourceCap: RecordAcceptedSourceRead,
  identity: IntakeStateIdentity,
  request: RecordReplaySourcePairRequest,
): RecordAcceptedIntakeHeadRead {
  identity = Object.freeze(validateIntakeIdentity(identity));
  const source = acceptedSourceReads.get(sourceCap);
  if (
    !source ||
    source.db !== db ||
    source.profileId !== identity.profileId ||
    JSON.stringify(request.identity) !== JSON.stringify(identity)
  )
    fail('foreign borrowed intake source owner');
  const pair = recordAcceptedSourcePair(db, sourceCap, identity.profileId, request);
  if (pair.latestSourceVersionId !== request.sourceVersionId)
    fail('borrowed intake source is not current');
  source.current();
  const key = intakeNamespace(identity) + 'head';
  const selected = Reflect.apply(readmissionPrepare, db, [
    'SELECT substr(value,1,4097) AS value,value IS substr(value,1,4097) AS complete FROM main.app_meta WHERE key=?',
  ]) as StatementSync;
  const row = Reflect.apply(readmissionGet, selected, [key]);
  const value = row?.value;
  if (typeof value !== 'string' || row.complete !== 1 || Buffer.byteLength(value) > 4096)
    fail('borrowed intake head selected bytes unavailable');
  parseIntakeCollectionHead(value, identity);
  source.current();
  const cap = Object.freeze({}) as RecordAcceptedIntakeHeadRead;
  const data = {
    db,
    owner: source.owner,
    key,
    value,
    methods: source.methods,
    schema: source.schema,
    tempSchema: source.tempSchema,
    peer: source.peer,
    writes: source.writes,
    selected,
    main: source.main,
    temp: source.temp,
    external: source.external,
    total: source.total,
    current: () => {},
    pair: request,
    borrowedSource: sourceCap,
    borrowedVault: source.vault,
    borrowedContributor: source.contributor,
  };
  data.current = () => {
    if (acceptedIntakeHeads.get(cap) !== data) fail('borrowed intake head read expired');
    source.current();
    const now = Reflect.apply(readmissionGet, selected, [key]);
    if (now?.complete !== 1 || now.value !== value)
      fail('borrowed intake head selected bytes changed');
    source.current();
  };
  acceptedIntakeHeads.set(cap, data);
  source.borrows.add(cap);
  try {
    assertRecordAcceptedIntakeHeadRead(db, cap, identity, value);
    return cap;
  } catch (error) {
    source.borrows.delete(cap);
    acceptedIntakeHeads.delete(cap);
    throw error;
  }
}
export function recordAcceptedIntakeSourcePair(
  db: Database,
  cap: RecordAcceptedIntakeHeadRead,
  identity: IntakeStateIdentity,
  request: RecordReplaySourcePairRequest,
): RecordReplaySourcePair {
  const data = acceptedIntakeHeads.get(cap);
  if (
    !data ||
    data.db !== db ||
    data.key !== intakeNamespace(identity) + 'head' ||
    !data.pair ||
    data.pair.sourceVersionId !== request.sourceVersionId ||
    JSON.stringify(data.pair.identity) !== JSON.stringify(request.identity)
  )
    fail('foreign accepted intake source pair read');
  assertRecordAcceptedIntakeHeadRead(db, cap, identity, data.value);
  const pair = data.vault
    ? vaultRecordAcceptedSourcePair(data.vault, request)
    : data.contributor
      ? contributorRecordAcceptedSourcePair(data.contributor, request)
      : data.borrowedVault
        ? vaultRecordAcceptedSourcePair(data.borrowedVault, request)
        : data.borrowedContributor
          ? contributorRecordAcceptedSourcePair(data.borrowedContributor, request)
          : fail('accepted intake source pair owner unavailable');
  assertRecordAcceptedIntakeHeadRead(db, cap, identity, data.value);
  if (
    data.pair.sourceVersionId !== request.sourceVersionId ||
    JSON.stringify(data.pair.identity) !== JSON.stringify(request.identity)
  )
    fail('accepted intake source pair request changed');
  return pair;
}
/** Point-compare one selected source version to the immutable accepted record
 * certificate retained by a non-pair read cap. SQL supplies only the candidate. */
export function assertRecordAcceptedIntakeSourcePreimage(
  db: Database,
  cap: RecordAcceptedIntakeHeadRead,
  identity: IntakeStateIdentity,
  versionId: string,
  preimage: { hash: string; bytes: number },
): void {
  const data = acceptedIntakeHeads.get(cap);
  if (!data || data.db !== db || data.key !== intakeNamespace(identity) + 'head' || data.pair)
    fail('foreign accepted intake source preimage read');
  assertRecordAcceptedIntakeHeadRead(db, cap, identity, data.value);
  const recordId = JSON.stringify([identity.intakeId]);
  if (data.vault)
    assertVaultRecordAcceptedSourcePreimage(data.vault, recordId, versionId, preimage);
  else if (data.contributor)
    assertContributorRecordAcceptedSourcePreimage(data.contributor, recordId, versionId, preimage);
  else fail('accepted intake source preimage owner unavailable');
  recordVersionWork('acceptedSourceFormatCertificatePoints');
  assertRecordAcceptedIntakeHeadRead(db, cap, identity, data.value);
}
export async function verifyRecordAcceptedIntakeSourcePreimage(
  db: Database,
  cap: RecordAcceptedIntakeHeadRead,
  identity: IntakeStateIdentity,
  versionId: string,
  columns: Record<string, unknown>,
  details: () => Iterable<string>,
  strings: (name: string) => Iterable<string> | undefined,
  selectedVersion: () => Iterable<string>,
  assertRunning: () => void,
): Promise<{ hash: string; bytes: number }> {
  const data = acceptedIntakeHeads.get(cap);
  if (!data || data.db !== db || data.key !== intakeNamespace(identity) + 'head' || data.pair)
    fail('foreign accepted intake source preimage read');
  const current = () => {
    assertRunning();
    assertRecordAcceptedIntakeHeadRead(db, cap, identity, data.value);
  };
  current();
  const pieces = () => sourcePreimagePieces(columns, details, strings);
  if (!(await compareRecordTextPieces(pieces(), selectedVersion(), current)))
    fail('accepted intake selected source version differs');
  current();
  const preimage = await digestRecordPieces(
    data.vault ? escapedRecordStringPieces(pieces()) : pieces(),
    current,
  );
  current();
  assertRecordAcceptedIntakeSourcePreimage(db, cap, identity, versionId, preimage);
  recordVersionWork('acceptedSourceFormatVerifiedPreimageBytes', preimage.bytes);
  current();
  return preimage;
}
/** The historical pair is not a current-row claim. This separate read admits
 * only its descriptor after the accepted replay's latest source version and
 * the selected SQL locator agree within the retained original read interval. */
export function recordAcceptedIntakeCurrentSourceDescriptor(
  db: Database,
  cap: RecordAcceptedIntakeHeadRead,
  identity: IntakeStateIdentity,
  request: RecordReplaySourcePairRequest,
): string {
  const pair = recordAcceptedIntakeSourcePair(db, cap, identity, request);
  if (pair.latestSourceVersionId !== pair.sourceVersionId)
    fail('accepted intake source pair is historical, not current');
  const currentHead = acceptedIntakeHeads.get(cap)?.value;
  if (currentHead === undefined) fail('accepted intake head read expired');
  const statement = Reflect.apply(readmissionPrepare, db, [
    `SELECT c.version_id AS version_id,s.id AS id,s.sha256 AS sha256,s.kind AS kind,
      substr(s.details_json,1,8193) AS details_json,
      s.details_json IS substr(s.details_json,1,8193) AS complete
      FROM main.source_files s JOIN main.__record_current c
      ON c.entity='source_files' AND c.record_id=? WHERE s.id=?`,
  ]) as StatementSync;
  const row = Reflect.apply(readmissionGet, statement, [
    JSON.stringify([identity.intakeId]),
    identity.intakeId,
  ]);
  assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
  if (
    row?.version_id !== pair.sourceVersionId ||
    row.id !== identity.intakeId ||
    row.sha256 !== identity.sourceHash ||
    row.kind !== 'intake_original' ||
    row.complete !== 1 ||
    row.details_json !== pair.sourceDetails ||
    request.sourceVersionId !== pair.sourceVersionId ||
    JSON.stringify(request.identity) !== JSON.stringify(identity)
  )
    fail('accepted intake selected source descriptor differs');
  return pair.sourceDetails;
}
export type RecordAcceptedSourceText =
  { kind: 'value'; value: string } | { kind: 'reference'; bytes: number; hash: string };

/** Selected SQL values are compared piece by piece with accepted replay facts.
 * A long value stays referential; no new source-column size limit is imposed. */
export async function recordAcceptedIntakeCurrentSourceSummaryFacts(
  db: Database,
  cap: RecordAcceptedIntakeHeadRead,
  identity: IntakeStateIdentity,
  request: RecordReplaySourcePairRequest,
): Promise<{
  bytes: number;
  path: RecordAcceptedSourceText;
  mimeType: RecordAcceptedSourceText;
  mimePredicates: RecordReplaySourcePair['sourceFacts']['mimePredicates'];
  providerId: RecordAcceptedSourceText | null;
}> {
  recordAcceptedIntakeCurrentSourceDescriptor(db, cap, identity, request);
  const pair = recordAcceptedIntakeSourcePair(db, cap, identity, request);
  const currentHead = acceptedIntakeHeads.get(cap)?.value;
  if (currentHead === undefined) fail('accepted intake head read expired');
  const source = Reflect.apply(readmissionPrepare, db, [
    "SELECT bytes AS source_bytes FROM main.source_files WHERE id=? AND kind='intake_original'",
  ]) as StatementSync;
  const sourceRow = Reflect.apply(readmissionGet, source, [identity.intakeId]);
  if (!sourceRow || sourceRow.source_bytes !== pair.sourceFacts.sourceBytes)
    fail('accepted intake selected source bytes differ');
  const field = async (
    column: 'path' | 'mime_type' | 'provider_id',
    expected: { bytes: number; hash: string } | null,
  ): Promise<RecordAcceptedSourceText | null> => {
    const piece = Reflect.apply(readmissionPrepare, db, [
      `SELECT substr(CAST(s.${column} AS BLOB),?,4096) AS part,
        typeof(s.${column}) AS value_type
        FROM main.source_files s WHERE s.id=? AND s.kind='intake_original'`,
    ]) as StatementSync;
    const complete = Reflect.apply(readmissionPrepare, db, [
      `SELECT CAST(s.${column} AS BLOB) IS
        substr(CAST(s.${column} AS BLOB),1,?) AS complete
        FROM main.source_files s WHERE s.id=? AND s.kind='intake_original'`,
    ]) as StatementSync;
    let offset = 1;
    let bytes = 0;
    let preview: string | undefined = '';
    const digest = createHash('sha256'),
      decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    for (let index = 0; ; index++) {
      assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
      const row = Reflect.apply(readmissionGet, piece, [offset, identity.intakeId]);
      assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
      if (!row || (row.value_type !== 'text' && row.value_type !== 'null'))
        fail('accepted intake selected source field disappeared');
      if (row.value_type === 'null') {
        if (expected !== null || index !== 0) fail('accepted intake selected source null differs');
        return null;
      }
      if (!expected || !(row.part instanceof Uint8Array))
        fail('accepted intake selected source field type differs');
      const part = row.part as Uint8Array;
      if (part.byteLength > 4096) fail('accepted intake selected source field piece exceeds bound');
      bytes += part.byteLength;
      if (bytes > expected.bytes) fail('accepted intake selected source field bytes differ');
      digest.update(part);
      const decoded = decoder.decode(part, { stream: part.byteLength !== 0 });
      if (preview !== undefined) {
        if (bytes <= 16 * 1024) preview += decoded;
        else preview = undefined;
      }
      offset += part.byteLength;
      if (!part.byteLength) break;
      if (index % 32 === 31) {
        await yieldHost();
        recordAcceptedIntakeCurrentSourceDescriptor(db, cap, identity, request);
      }
    }
    const final = Reflect.apply(readmissionGet, complete, [offset - 1, identity.intakeId]);
    assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
    if (
      !final ||
      final.complete !== 1 ||
      bytes !== expected.bytes ||
      digest.digest('hex') !== expected.hash
    )
      fail('accepted intake selected source field differs');
    recordAcceptedIntakeCurrentSourceDescriptor(db, cap, identity, request);
    return preview === undefined
      ? { kind: 'reference', bytes: expected.bytes, hash: expected.hash }
      : { kind: 'value', value: preview };
  };
  const path = await field('path', pair.sourceFacts.path);
  const mimeType = await field('mime_type', pair.sourceFacts.mimeType);
  const providerId = await field('provider_id', pair.sourceFacts.providerId);
  if (!path || !mimeType) fail('accepted intake selected source path or mime type missing');
  recordAcceptedIntakeCurrentSourceDescriptor(db, cap, identity, request);
  return {
    bytes: pair.sourceFacts.sourceBytes,
    path,
    mimeType,
    mimePredicates: pair.sourceFacts.mimePredicates,
    providerId,
  };
}
/** Current visibility is a separate accepted event from the historical
 * source/HEAD pair. The replay supplies its exact identity and field facts;
 * selected SQL may only propose the current event under the retained owner. */
export async function recordAcceptedIntakeCurrentSourceVisibility(
  db: Database,
  cap: RecordAcceptedIntakeHeadRead,
  identity: IntakeStateIdentity,
  request: RecordReplaySourcePairRequest,
): Promise<{ archived: boolean; version: number }> {
  const pair = recordAcceptedIntakeSourcePair(db, cap, identity, request);
  const currentHead = acceptedIntakeHeads.get(cap)?.value;
  if (currentHead === undefined) fail('accepted intake head read expired');
  const selected = Reflect.apply(readmissionPrepare, db, [
    `SELECT e.archived AS archived,e.version AS version,c.version_id AS version_id
      FROM main.visibility_events e LEFT JOIN main.__record_current c
      ON c.entity='visibility_events' AND c.record_id=json_array(e.id)
      WHERE e.target_type='source_file' AND e.target_id=?
      ORDER BY e.version DESC LIMIT 1`,
  ]) as StatementSync;
  assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
  const row = Reflect.apply(readmissionGet, selected, [identity.intakeId]);
  assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
  const expected = pair.currentVisibility;
  if (!expected) {
    if (row) fail('accepted intake selected visibility differs');
    return { archived: false, version: 0 };
  }
  if (
    !row ||
    row.version_id !== expected.versionId ||
    row.version !== expected.version ||
    row.archived !== Number(expected.archived)
  )
    fail('accepted intake selected visibility differs');
  const field = async (
    column: 'id' | 'created_at' | 'actor',
    digest: { bytes: number; hash: string },
  ): Promise<void> => {
    const piece = Reflect.apply(readmissionPrepare, db, [
      `SELECT substr(CAST(e.${column} AS BLOB),?,4096) AS part,
        typeof(e.${column}) AS value_type
        FROM main.visibility_events e
        WHERE e.target_type='source_file' AND e.target_id=? AND e.version=?`,
    ]) as StatementSync;
    const complete = Reflect.apply(readmissionPrepare, db, [
      `SELECT CAST(e.${column} AS BLOB) IS
        substr(CAST(e.${column} AS BLOB),1,?) AS complete
        FROM main.visibility_events e
        WHERE e.target_type='source_file' AND e.target_id=? AND e.version=?`,
    ]) as StatementSync;
    const hash = createHash('sha256');
    let bytes = 0;
    for (let index = 0; ; index++) {
      assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
      const current = Reflect.apply(readmissionGet, piece, [
        bytes + 1,
        identity.intakeId,
        expected.version,
      ]);
      assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
      if (!current || current.value_type !== 'text' || !(current.part instanceof Uint8Array))
        fail('accepted intake selected visibility field differs');
      const part = current.part as Uint8Array;
      if (part.byteLength > 4096) fail('accepted intake selected visibility piece exceeds bound');
      bytes += part.byteLength;
      if (bytes > digest.bytes) fail('accepted intake selected visibility length differs');
      hash.update(part);
      if (!part.byteLength) break;
      if (index % 32 === 31) await yieldHost();
    }
    const terminal = Reflect.apply(readmissionGet, complete, [
      bytes,
      identity.intakeId,
      expected.version,
    ]);
    assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
    if (terminal?.complete !== 1 || bytes !== digest.bytes || hash.digest('hex') !== digest.hash)
      fail('accepted intake selected visibility field differs');
  };
  await field('id', expected.id);
  await field('created_at', expected.createdAt);
  await field('actor', expected.actor);
  assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
  return { archived: expected.archived, version: expected.version };
}
/** The additive source-text version is a separate accepted app_meta record.
 * A selected SQL value cannot supply this version without its replayed digest. */
export async function recordAcceptedIntakeCurrentSourcePinVersion(
  db: Database,
  cap: RecordAcceptedIntakeHeadRead,
  identity: IntakeStateIdentity,
  request: RecordReplaySourcePairRequest,
): Promise<number> {
  const pair = recordAcceptedIntakeSourcePair(db, cap, identity, request);
  const currentHead = acceptedIntakeHeads.get(cap)?.value;
  if (currentHead === undefined) fail('accepted intake head read expired');
  const key = intakeSourcePinKey(identity.intakeId);
  const selected = Reflect.apply(readmissionPrepare, db, [
    'SELECT typeof(value) AS value_type FROM main.app_meta WHERE key=?',
  ]) as StatementSync;
  const current = Reflect.apply(readmissionPrepare, db, [
    "SELECT version_id FROM main.__record_current WHERE entity='app_meta' AND record_id=?",
  ]) as StatementSync;
  assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
  const row = Reflect.apply(readmissionGet, selected, [key]);
  const version = Reflect.apply(readmissionGet, current, [JSON.stringify([key])]);
  assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
  const expected = pair.currentSourcePin;
  if (!expected) {
    if (row || version) fail('accepted intake selected source pin differs');
    return 0;
  }
  if (expected.kind === 'deleted') {
    if (row || version?.version_id !== expected.versionId)
      fail('accepted intake selected source pin tombstone differs');
    return 0;
  }
  if (row?.value_type !== 'text' || version?.version_id !== expected.versionId)
    fail('accepted intake selected source pin version differs');
  const piece = Reflect.apply(readmissionPrepare, db, [
    'SELECT substr(CAST(value AS BLOB),?,4096) AS part FROM main.app_meta WHERE key=?',
  ]) as StatementSync;
  const complete = Reflect.apply(readmissionPrepare, db, [
    'SELECT CAST(value AS BLOB) IS substr(CAST(value AS BLOB),1,?) AS complete FROM main.app_meta WHERE key=?',
  ]) as StatementSync;
  const hash = createHash('sha256');
  let bytes = 0;
  for (let index = 0; ; index++) {
    assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
    const currentPart = Reflect.apply(readmissionGet, piece, [bytes + 1, key]);
    assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
    if (!currentPart || !(currentPart.part instanceof Uint8Array))
      fail('accepted intake selected source pin bytes differ');
    const part = currentPart.part as Uint8Array;
    if (part.byteLength > 4096) fail('accepted intake selected source pin piece exceeds bound');
    bytes += part.byteLength;
    if (bytes > expected.value.bytes) fail('accepted intake selected source pin length differs');
    hash.update(part);
    if (!part.byteLength) break;
    if (index % 32 === 31) await yieldHost();
  }
  const terminal = Reflect.apply(readmissionGet, complete, [bytes, key]);
  assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
  const finalVersion = Reflect.apply(readmissionGet, current, [JSON.stringify([key])]);
  assertRecordAcceptedIntakeHeadRead(db, cap, identity, currentHead);
  if (
    terminal?.complete !== 1 ||
    finalVersion?.version_id !== expected.versionId ||
    bytes !== expected.value.bytes ||
    hash.digest('hex') !== expected.value.hash
  )
    fail('accepted intake selected source pin differs');
  return expected.version;
}
export function assertRecordAcceptedIntakeHeadRead(
  db: Database,
  cap: RecordAcceptedIntakeHeadRead,
  identity: IntakeStateIdentity,
  value: string,
): void {
  const data = acceptedIntakeHeads.get(cap);
  if (
    !data ||
    data.db !== db ||
    data.key !== intakeNamespace(identity) + 'head' ||
    data.value !== value
  )
    fail('foreign accepted intake head read');
  if (acceptedIntakeHeads.get(cap) !== data) fail('accepted intake head read expired');
  if (data.vault) assertVaultRecordAcceptedHeadRead(data.vault, data.key, value);
  else if (data.contributor)
    assertContributorRecordAcceptedHeadRead(data.contributor, data.key, value);
  else if (data.borrowedVault)
    assertVaultRecordAcceptedHeadRead(data.borrowedVault, data.key, value);
  else if (data.borrowedContributor)
    assertContributorRecordAcceptedHeadRead(data.borrowedContributor, data.key, value);
  else fail('accepted intake head proof unavailable');
  if (acceptedIntakeHeads.get(cap) !== data) fail('accepted intake head read expired');
}
export function closeRecordAcceptedIntakeHeadRead(cap: RecordAcceptedIntakeHeadRead): void {
  const data = acceptedIntakeHeads.get(cap);
  if (!data) return;
  if (data.borrowedSource) {
    acceptedIntakeHeads.delete(cap);
    acceptedSourceReads.get(data.borrowedSource)?.borrows.delete(cap);
    return;
  }
  try {
    if (data.vault) closeVaultRecordAcceptedHeadRead(data.vault);
    if (data.contributor) closeContributorRecordAcceptedHeadRead(data.contributor);
  } finally {
    acceptedIntakeHeads.delete(cap);
    closeRecordReadOwner(data.owner);
  }
}
declare const acceptedSourceReadBrand: unique symbol;
export interface RecordAcceptedSourceRead {
  readonly [acceptedSourceReadBrand]: true;
}
const acceptedSourceReads = new WeakMap<
  RecordAcceptedSourceRead,
  {
    db: Database;
    owner: RecordReadOwner;
    profileId: string;
    methods: object;
    schema: unknown;
    tempSchema: unknown;
    peer: unknown;
    writes: unknown;
    main: StatementSync;
    temp: StatementSync;
    external: StatementSync;
    total: StatementSync;
    current: () => void;
    vault?: VaultRecordAcceptedSourceRead;
    contributor?: ContributorRecordAcceptedSourceRead;
    pair?: RecordReplaySourcePairRequest;
    borrows: Set<RecordAcceptedIntakeHeadRead>;
  }
>();
/** Genuine record HEAD and completed replay certificate, without assuming an
 * intake V4 app_meta key exists. A selected source still needs its exact point
 * preimage checked before any format or legacy decision. */
/** Routing only: the attached adapter retains and incrementally advances its
 * accepted proof across this process's own publications (contributor storage).
 * The vault also advances exact own publications, but concurrent TEMP
 * maintenance still invalidates its accepted-source intervals and retained
 * frontiers. Broad vault routing remains with CRS-240. */
export function recordAcceptedSourceIncremental(db: Database): boolean {
  const config = state.get(db);
  return !!config && contributorRecordReadOwnerSupported(config.storage);
}

export async function captureRecordAcceptedSourceRead(
  db: Database,
  profileId: string,
  assertRunning: () => void,
  pair?: RecordReplaySourcePairRequest,
): Promise<RecordAcceptedSourceRead> {
  const requestedPair =
    pair &&
    Object.freeze({
      identity: Object.freeze(validateIntakeIdentity(pair.identity)),
      sourceVersionId: pair.sourceVersionId,
    });
  if (requestedPair && requestedPair.identity.profileId !== profileId)
    fail('accepted source pair profile differs');
  if (db.isTransaction || !recordReadOwnerSupported(db, profileId))
    fail('accepted source read owner unavailable');
  const methods = managedDatabaseMethodEpoch(db),
    main = Reflect.apply(readmissionPrepare, db, ['PRAGMA main.schema_version']) as StatementSync,
    temp = Reflect.apply(readmissionPrepare, db, ['PRAGMA temp.schema_version']) as StatementSync,
    external = Reflect.apply(readmissionPrepare, db, ['PRAGMA main.data_version']) as StatementSync,
    total = Reflect.apply(readmissionPrepare, db, ['SELECT total_changes() AS n']) as StatementSync;
  if (!methods) fail('accepted source method unavailable');
  const owner = captureRecordReadOwner(db, profileId);
  const read = recordReadOwners.get(owner)!;
  if (typeof read.wire !== 'string') {
    closeRecordReadOwner(owner);
    fail('accepted source original HEAD unavailable');
  }
  const selectedHead = read.wire;
  const cap = Object.freeze({}) as RecordAcceptedSourceRead;
  const data = {
    db,
    owner,
    profileId,
    methods,
    schema: Reflect.apply(readmissionGet, main, [])!.schema_version,
    tempSchema: Reflect.apply(readmissionGet, temp, [])!.schema_version,
    peer: Reflect.apply(readmissionGet, external, [])!.data_version,
    writes: Reflect.apply(readmissionGet, total, [])!.n,
    main,
    temp,
    external,
    total,
    current: () => {},
    vault: undefined as VaultRecordAcceptedSourceRead | undefined,
    contributor: undefined as ContributorRecordAcceptedSourceRead | undefined,
    pair: requestedPair,
    borrows: new Set<RecordAcceptedIntakeHeadRead>(),
  };
  acceptedSourceReads.set(cap, data);
  const current = () => {
    assertRunning();
    if (
      acceptedSourceReads.get(cap) !== data ||
      db.isTransaction ||
      managedDatabaseMethodEpoch(db) !== methods ||
      Reflect.apply(readmissionGet, main, [])!.schema_version !== data.schema ||
      Reflect.apply(readmissionGet, temp, [])!.schema_version !== data.tempSchema ||
      Reflect.apply(readmissionGet, external, [])!.data_version !== data.peer ||
      Reflect.apply(readmissionGet, total, [])!.n !== data.writes
    )
      fail('accepted source read interval changed');
    assertRecordReadOwnerBeforeVerification(db, owner);
  };
  data.current = current;
  try {
    current();
    if (read.vault)
      data.vault = await captureVaultRecordAcceptedSourceRead(
        db,
        read.config.storage,
        read.vault,
        selectedHead,
        current,
        requestedPair,
      );
    else if (read.contributor)
      data.contributor = await captureContributorRecordAcceptedSourceRead(
        db,
        read.config.storage,
        read.contributor,
        selectedHead,
        current,
        requestedPair,
      );
    else fail('accepted source genuine storage unavailable');
    current();
    return cap;
  } catch (error) {
    try {
      if (data.vault) closeVaultRecordAcceptedSourceRead(data.vault, false);
      if (data.contributor) closeContributorRecordAcceptedSourceRead(data.contributor, false);
    } finally {
      acceptedSourceReads.delete(cap);
      closeRecordReadOwner(owner);
    }
    throw error;
  }
}
export function assertRecordAcceptedSourcePreimage(
  db: Database,
  cap: RecordAcceptedSourceRead,
  profileId: string,
  recordId: string,
  versionId: string,
  preimage: { hash: string; bytes: number },
): void {
  const data = acceptedSourceReads.get(cap);
  if (!data || data.db !== db || data.profileId !== profileId) fail('foreign accepted source read');
  data.current();
  if (data.vault)
    assertVaultRecordAcceptedSourcePreimage(data.vault, recordId, versionId, preimage);
  else if (data.contributor)
    assertContributorRecordAcceptedSourcePreimage(data.contributor, recordId, versionId, preimage);
  else fail('accepted source preimage proof unavailable');
  recordVersionWork('acceptedSourceFormatCertificatePoints');
  data.current();
}
export function assertRecordAcceptedSourceRead(
  db: Database,
  cap: RecordAcceptedSourceRead,
  profileId: string,
): void {
  const data = acceptedSourceReads.get(cap);
  if (!data || data.db !== db || data.profileId !== profileId) fail('foreign accepted source read');
  data.current();
}
export async function verifyRecordAcceptedSourceReadTerminal(
  db: Database,
  cap: RecordAcceptedSourceRead,
  profileId: string,
): Promise<void> {
  const data = acceptedSourceReads.get(cap);
  if (!data || data.db !== db || data.profileId !== profileId) fail('foreign accepted source read');
  if (data.borrows.size) fail('accepted source terminal read has active V4 borrows');
  data.current();
  if (data.vault) await verifyVaultRecordAcceptedSourceRead(data.vault);
  else if (data.contributor) await verifyContributorRecordAcceptedSourceRead(data.contributor);
  else fail('accepted source terminal proof unavailable');
  data.current();
}
export function recordAcceptedSourceHead(
  db: Database,
  cap: RecordAcceptedSourceRead,
  profileId: string,
): string {
  assertRecordAcceptedSourceRead(db, cap, profileId);
  const data = acceptedSourceReads.get(cap)!;
  const wire = recordReadOwners.get(data.owner)?.wire;
  if (typeof wire !== 'string') fail('accepted source original HEAD unavailable');
  return wire;
}
/** The candidate pair is usable only after this same lease proved the exact
 * selected source preimage. A missing pair is a refusal, never a legacy hint. */
export function recordAcceptedSourcePair(
  db: Database,
  cap: RecordAcceptedSourceRead,
  profileId: string,
  request: RecordReplaySourcePairRequest,
): RecordReplaySourcePair {
  const data = acceptedSourceReads.get(cap);
  if (
    !data ||
    data.db !== db ||
    data.profileId !== profileId ||
    !data.pair ||
    data.pair.sourceVersionId !== request.sourceVersionId ||
    JSON.stringify(data.pair.identity) !== JSON.stringify(request.identity)
  )
    fail('foreign accepted source pair read');
  data.current();
  const pair = data.vault
    ? vaultRecordAcceptedSourcePair(data.vault, request)
    : data.contributor
      ? contributorRecordAcceptedSourcePair(data.contributor, request)
      : fail('accepted source pair owner unavailable');
  data.current();
  return pair;
}
const ACCEPTED_SOURCE_PIECE_UNITS = 16 * 1024;
/** Concatenate adjacent pieces into at most 16 Ki UTF-16 units without
 * splitting any input piece, so surrogate boundaries and the exact streamed
 * text, digest and comparison are unchanged. Only the check cadence changes. */
function* coalescedAcceptedSourcePieces(pieces: Iterable<string>): Generator<string> {
  let pending = '';
  for (const piece of pieces) {
    if (pending.length && pending.length + piece.length > ACCEPTED_SOURCE_PIECE_UNITS) {
      recordVersionWork('acceptedSourcePreimageQuanta');
      yield pending;
      pending = '';
    }
    if (piece.length >= ACCEPTED_SOURCE_PIECE_UNITS) {
      recordVersionWork('acceptedSourcePreimageQuanta');
      yield piece;
    } else pending += piece;
  }
  if (pending) {
    recordVersionWork('acceptedSourcePreimageQuanta');
    yield pending;
  }
}
export async function verifyRecordAcceptedSourcePreimage(
  db: Database,
  cap: RecordAcceptedSourceRead,
  profileId: string,
  recordId: string,
  versionId: string,
  columns: Record<string, unknown>,
  details: () => Iterable<string>,
  strings: (name: string) => Iterable<string> | undefined,
  selectedVersion: () => Iterable<string>,
  assertRunning: () => void,
): Promise<{ hash: string; bytes: number }> {
  const current = () => {
    assertRunning();
    assertRecordAcceptedSourceRead(db, cap, profileId);
  };
  current();
  // The structural serializer emits many tiny pieces (braces, names, short
  // scalars). Each owner check is a physical/SQL interval proof, so group the
  // exact same text into bounded quanta: checks then scale with bytes.
  const pieces = () =>
    coalescedAcceptedSourcePieces(sourcePreimagePieces(columns, details, strings));
  if (!(await compareRecordTextPieces(pieces(), selectedVersion(), current)))
    fail('accepted source selected version differs');
  current();
  const preimage = await digestRecordPieces(
    acceptedSourceReads.get(cap)!.vault
      ? coalescedAcceptedSourcePieces(
          escapedRecordStringPieces(sourcePreimagePieces(columns, details, strings)),
        )
      : pieces(),
    current,
  );
  current();
  assertRecordAcceptedSourcePreimage(db, cap, profileId, recordId, versionId, preimage);
  recordVersionWork('acceptedSourceFormatVerifiedPreimageBytes', preimage.bytes);
  current();
  return preimage;
}
export function closeRecordAcceptedSourceRead(
  cap: RecordAcceptedSourceRead,
  retainRead = true,
): void {
  const data = acceptedSourceReads.get(cap);
  if (!data) return;
  for (const borrow of data.borrows) acceptedIntakeHeads.delete(borrow);
  data.borrows.clear();
  try {
    data.current();
  } finally {
    try {
      if (data.vault) closeVaultRecordAcceptedSourceRead(data.vault, retainRead);
      if (data.contributor) closeContributorRecordAcceptedSourceRead(data.contributor, retainRead);
    } finally {
      acceptedSourceReads.delete(cap);
      closeRecordReadOwner(data.owner);
    }
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
  let fixedNativeRead = false;
  try {
    // Arm before capture compiles its fixed status statement. Auto-reprepare
    // must refuse before an installed policy can enter the finite verifier.
    prepareManagedDatabaseCallbackBarrier(db);
    fixedNativeRead = true;
  } catch {
    // Unwrapped scalar registrations retain the original conservative path.
  }
  const owner = captureRecordReadOwner(db, config.profileId);
  try {
    const proof =
      recordReadOwners.get(owner) ?? fail('original contributor record owner unavailable');
    const contributor = proof.contributor ?? fail('original contributor record owner unavailable');
    if (!bindContributorLegacyBridgeBackingScope(config.storage, contributor, scope))
      fail('original contributor backing scope changed during capture');
    proof.legacyBridgeScope = scope;
    if (fixedNativeRead) {
      const row = withoutManagedDatabaseCallbacks(db, () =>
        Reflect.apply(readmissionGet, proof.status, []),
      );
      const status = legacyStatusSnapshot(row);
      recordVersionWork('headReadCalls');
      const head = contributorRecordReadOwnerHeadBytes(config.storage, contributor);
      // Capture exact original bytes, after validating their reference against
      // the original indexed state. No decoded/re-encoded bytes supply proof.
      if (stringifyRecordJson(row) !== proof.row || !eq(parseHeadBinding(head).head, proof.head))
        fail('original contributor record authority changed');
      if (status)
        legacyFixedReads.set(owner, {
          status,
          head: Buffer.from(head),
          active: false,
          poisoned: false,
        });
    }
    assertContributorLegacyBridgeRecordOwner(db, owner);
    return owner;
  } catch (error) {
    closeRecordReadOwner(owner);
    throw error;
  }
}
type LegacyStatusValue = string | number | bigint | null;
const legacyFixedReads = new WeakMap<
  RecordReadOwner,
  {
    status: Readonly<Record<string, LegacyStatusValue>>;
    head: Buffer;
    active: boolean;
    poisoned: boolean;
  }
>();
function legacyStatusSnapshot(
  row: unknown,
): Readonly<Record<string, LegacyStatusValue>> | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const values: Record<string, LegacyStatusValue> = Object.create(null);
  for (const key of Reflect.ownKeys(row)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = ownDescriptor(row, key);
    if (!descriptor || !('value' in descriptor)) return undefined;
    const value: unknown = descriptor.value;
    if (value !== null && !['string', 'number', 'bigint'].includes(typeof value)) return undefined;
    values[key] = value as LegacyStatusValue;
  }
  return Object.freeze(values);
}
function legacyStatusMatches(row: unknown, expected: Readonly<Record<string, LegacyStatusValue>>) {
  if (!row || typeof row !== 'object') return false;
  const keys = Reflect.ownKeys(row);
  if (keys.length !== Object.keys(expected).length) return false;
  return keys.every((key) => {
    if (typeof key !== 'string' || !Object.hasOwn(expected, key)) return false;
    const descriptor = ownDescriptor(row, key);
    return !!descriptor && 'value' in descriptor && Object.is(descriptor.value, expected[key]);
  });
}
/** Original contributor HEAD and indexed state, including inside the exact
 * maintenance transaction. The bridge separately seals its SQL write interval. */
export function assertContributorLegacyBridgeRecordOwner(
  db: Database,
  owner: RecordReadOwner,
  token?: object,
): void {
  const proof = recordReadOwners.get(owner);
  const fixed = legacyFixedReads.get(owner);
  if (fixed) {
    if (proof?.db !== db) fail('original contributor record authority changed');
    if (fixed.active) fixed.poisoned = true;
    if (fixed.poisoned) fail('original contributor record authority changed');
    fixed.active = true;
    const interval = () => {
      const read = proof && ownDescriptor(proof.config.storage, 'read');
      return (
        !fixed.poisoned &&
        recordReadOwners.get(owner) === proof &&
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
        !!proof.legacyBridgeScope &&
        contributorLegacyBridgeBackingIntervalCurrent(
          proof.config.storage,
          proof.contributor,
          proof.legacyBridgeScope,
        ) &&
        !fixed.poisoned &&
        recordReadOwners.get(owner) === proof
      );
    };
    try {
      if (
        !interval() ||
        !contributorRecordReadOwnerCurrent(proof!.config.storage, proof!.contributor!)
      )
        fail('original contributor record authority changed');
      withoutManagedDatabaseCallbacks(db, () => {
        if (!legacyStatusMatches(Reflect.apply(readmissionGet, proof!.status, []), fixed.status))
          fail('original contributor record authority changed');
      });
      // The retained read seals physical paths before and after the fresh FD
      // bytes, after the final native SQL access. No callback follows this seal.
      recordVersionWork('headReadCalls');
      const head = contributorRecordReadOwnerHeadBytes(proof!.config.storage, proof!.contributor!);
      recordVersionWork('headReadBytes', head.length);
      if (!head.equals(fixed.head) || !interval())
        fail('original contributor record authority changed');
      return;
    } catch (error) {
      fixed.poisoned = true;
      throw error;
    } finally {
      fixed.active = false;
    }
  }
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
    !eq(readOwnerHead(proof!), proof!.head) ||
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
    sequence: number;
    head: RecordObjectReference | null;
    epoch: object;
    staging?: VaultRecordStagingWitness;
    contributorStaging?: ContributorRecordStagingWitness;
    contributorReadOwner?: RecordReadOwner;
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
    sequence: row.sequence,
    head,
    epoch: epoch!,
  });
  if (!recordAuthorityWitnessCurrent(db, witness)) fail('record authority witness changed');
  return witness;
}
export function recordAuthorityWitnessCurrent(
  db: Database,
  witness: RecordAuthorityWitness,
  expectedSequence?: number,
): boolean {
  const proof = authorityWitnesses.get(witness);
  if (!recordAuthorityWitnessIntervalCurrent(db, witness)) return false;
  return (
    (expectedSequence === undefined || proof!.sequence === expectedSequence) &&
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
      : proof.contributorStaging
        ? contributorRecordStagingCurrent(proof.contributorStaging)
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
export type RecordRebuildResult = RecordDurabilityStatus & {
  database: string;
  profileId: string | undefined;
};
export function rebuildRecordDatabase(
  path: string,
  options: AttachRecordDurabilityOptions = {},
): RecordRebuildResult {
  return finishRecordSteps(rebuildRecordDatabaseSteps(path, options));
}
/** Step-wise reconstruction into a new private SQLite file. Abandoning the
 * steps (return() or a throw) closes and removes the partial target. */
export function rebuildRecordDatabaseSteps(
  path: string,
  options: AttachRecordDurabilityOptions = {},
): Generator<void, RecordRebuildResult> {
  return recordPhaseSteps('reconstruction', rebuildRecordDatabaseInsideSteps(path, options));
}
function* rebuildRecordDatabaseInsideSteps(
  path: string,
  { profileId, storage, verifyReferences }: AttachRecordDurabilityOptions = {},
): Generator<void, RecordRebuildResult> {
  if (existsSync(path)) fail('rebuild target must be new');
  validStorage(storage);
  if (!readHead(storage)) fail('no committed profile history');
  const db = openDatabase(path, profileId);
  let complete = false;
  try {
    yield* attachRecordDurabilitySteps(db, { profileId, storage, verifyReferences });
    const result = recordDurabilityStatus(db)!;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    complete = true;
    return { ...result, database: path, profileId };
  } finally {
    try {
      db.close();
    } catch {}
    if (!complete)
      for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  }
}
/** Physical re-proof of a selected history whose logical reconstruction is
 * already in hand: it reads and authenticates HEAD, every ancestry commit and
 * every segment object (sha256 and byte length), decodes every version and
 * passes each to verifyReferences exactly as reconstruction does, but performs
 * no SQLite replay. Callers reuse an earlier reconstruction only when this
 * HEAD's bytes are the bytes that reconstruction replayed. */
export function verifyRecordHistoryInputs(
  storage: RecordStorage,
  {
    profileId,
    schemaVersion,
    verifyReferences,
  }: {
    profileId: string;
    schemaVersion: number;
    verifyReferences?: (versions: DurableRecordVersion[]) => void;
  },
): { head: string; commits: number; versions: number } {
  return withRecordVersionWorkPhase('reconstruction', () => {
    validStorage(storage);
    const { wire } = readHeadBinding(storage, storage.read);
    if (wire === null) fail('no committed profile history');
    const ancestry = finishRecordSteps(committedSinceSteps(storage, profileId, schemaVersion));
    let versions = 0;
    try {
      if (stringifyRecordJson(ancestry.head) !== stringifyRecordJson(parseRecordJson(wire)))
        fail('record HEAD changed during input verification');
      for (const selected of ancestry.transactions)
        for (const version of replayTransactionVersions(storage, selected.commit)) {
          if (version.profileId !== profileId || version.sequence !== selected.commit.sequence)
            fail('invalid record version ownership or sequence');
          verifyReferences?.([version]);
          versions++;
        }
      return { head: wire, commits: ancestry.length, versions };
    } finally {
      ancestry.close();
    }
  });
}
/** Proofs, yields, windows and steps of one cooperative record-step driver. */
export interface RecordStepDriverWork {
  proofs: number;
  yields: number;
  windows: number;
  steps: number;
}
export interface RecordStepDriverOptions {
  /** Caller's physical identity proof (for example the storage's HEAD file
   * and directories). It runs with every record HEAD proof. */
  assertCurrent?: () => void;
  signal?: AbortSignal;
  work?: RecordStepDriverWork;
}
/** Most bounded record steps run back to back inside one cooperative window. */
export const RECORD_STEP_WINDOW = 16;
/** Drives record steps with host yields between windows. The selected HEAD
 * bytes, read through the storage's original read, and the caller's physical
 * proof are re-proven at the start, after every yield and at completion, as
 * contributor copy certification does; any exit is proven again. Windows
 * start at one step and double to RECORD_STEP_WINDOW. */
async function driveRecordStepsAsync<T>(
  storage: RecordStorage | undefined,
  steps: () => Generator<void, T>,
  { assertCurrent, signal, work }: RecordStepDriverOptions,
): Promise<T> {
  validStorage(storage);
  const read = ownDescriptor(storage, 'read'),
    original = read && 'value' in read ? read.value : undefined;
  if (typeof original !== 'function') fail('record step driver requires an own storage read');
  const counts = work ?? { proofs: 0, yields: 0, windows: 0, steps: 0 };
  signal?.throwIfAborted();
  assertCurrent?.();
  const selected = readHeadBinding(storage, original).wire;
  if (selected === null) fail('no committed profile history');
  const proof = () => {
    counts.proofs++;
    signal?.throwIfAborted();
    const current = ownDescriptor(storage, 'read');
    if (!current || !('value' in current) || current.value !== original)
      fail('record step storage changed');
    assertCurrent?.();
    if (readHeadBinding(storage, original).wire !== selected)
      fail('record HEAD changed during step-wise work');
  };
  const generator = steps();
  let window = 1,
    done = false;
  try {
    for (;;) {
      proof();
      counts.windows++;
      for (let index = 0; index < window; index++) {
        const next = generator.next();
        counts.steps++;
        if (next.done) {
          done = true;
          proof();
          return next.value;
        }
      }
      window = Math.min(window * 2, RECORD_STEP_WINDOW);
      counts.yields++;
      await yieldHost();
    }
  } finally {
    if (!done) {
      try {
        generator.return(undefined as never);
      } finally {
        proof();
      }
    }
  }
}
/** Cooperative rebuildRecordDatabase: identical replay, re-proven around
 * every host yield (see driveRecordStepsAsync). */
export function rebuildRecordDatabaseAsync(
  path: string,
  options: AttachRecordDurabilityOptions = {},
  driver: RecordStepDriverOptions = {},
): Promise<RecordRebuildResult> {
  return driveRecordStepsAsync(
    options.storage,
    () => rebuildRecordDatabaseSteps(path, options),
    driver,
  );
}
/** Cooperative attachRecordDurability for a connection no other caller can
 * use until it resolves: catch-up holds its private transaction across yields. */
export function attachRecordDurabilityAsync(
  db: Database,
  options: AttachRecordDurabilityOptions = {},
  driver: RecordStepDriverOptions = {},
): Promise<RecordDurabilityStatus> {
  return driveRecordStepsAsync(
    options.storage,
    () => attachRecordDurabilitySteps(db, options),
    driver,
  );
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
