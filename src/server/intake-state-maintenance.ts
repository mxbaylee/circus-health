import type { DatabaseSync } from 'node:sqlite';
import { terminalStatement } from './database-terminal-statements.ts';
import {
  currentTransactionToken,
  installTransactionTerminalGuard,
  managedDatabaseMethodEpoch,
  type TransactionOperation,
} from './database.ts';
import {
  recordDurabilityStatus,
  discardRecordSourcePriorFields,
  recordAuthorityWitnessIntervalCurrent,
  recordIndexedPublicationCurrent,
  recordIndexedPublicationWrites,
  type RecordIndexedPublication,
  type RecordSourcePriorFields,
  prepareRecordCompactTerminal,
  withRecordCompactTerminal,
  prepareRecordCompactReadmission,
  type RecordCompactReadmission,
  recordTransactionPreparationCaptured,
  recordPreparedReplayCurrent,
  recordPreparedMaintenanceReplayCurrent,
} from './record-versions.ts';
import { currentClinicalOperation, assertClinicalOperation } from './clinical-operation.ts';
import {
  HEAD_BYTES,
  intakeNamespace,
  parseIntakeCollectionHead,
  uuid,
  validateIntakeIdentity,
  type IntakeStateIdentity,
} from './intake-state-evidence.ts';
import { intakeSourcePinKey } from './intake-source-pin.ts';
import {
  verifyIntakeLegacyBridgeProof,
  intakeLegacyBridgeHasOriginalSourceWatch,
  legacyBridgeStampCurrent,
  type IntakeLegacyBridgeProof,
  type IntakeLegacyBridgeStamp,
  consumeIntakeCompactMetadataProof,
  type IntakeCompactMetadataProof,
  intakeCompactSourceRowsEqual,
  intakeCompactMetadataStampCurrent,
  type IntakeCompactMetadataStamp,
} from './intake-state-migration.ts';
import { sourceTextAuthorityDirtyRow } from './source-text-projection.ts';
import { readIntakeFrontierOwnedLookupDirtyWrite } from './intake-lookup-frontier-observer.ts';

declare const maintenanceBrand: unique symbol;
/** Host-owned, single-use permission for one exact auxiliary publication. */
export interface IntakeMaintenancePublication {
  readonly [maintenanceBrand]: true;
}
export interface IntakeMaintenanceWrite {
  readonly key: string;
  readonly value: string;
}
declare const maintenancePreparationBrand: unique symbol;
/** Frozen auxiliary publication retained from a genuine record T1 rollback. */
export interface IntakeMaintenancePreparation {
  readonly [maintenancePreparationBrand]: true;
}
interface PreparedPublication {
  db: DatabaseSync;
  originalToken: object;
  methods: object;
  identity: IntakeStateIdentity;
  headKey: string;
  beforeHead: string;
  afterHead: string;
  source: string;
  sourcePin: string | undefined;
  writes: ReadonlyMap<string, string>;
  result: string;
  mainSchema: number;
  tempSchema: number;
  bytes: number;
  token?: object;
  verified?: boolean;
}
interface Candidate {
  identity: IntakeStateIdentity;
  beforeHead: string;
  afterHead: string;
  writes: readonly IntakeMaintenanceWrite[];
  result: unknown;
  operationId: string;
  fingerprint: string;
  /** Only the checked one-time legacy bridge can preserve a review across a
   * format transition; ordinary callers cannot request this with a Boolean. */
  legacyBridge?: IntakeLegacyBridgeProof;
  compactMetadata?: IntakeCompactMetadataProof;
  assertCurrent?: () => void;
}
interface Publication {
  db: DatabaseSync;
  identity: IntakeStateIdentity;
  headKey: string;
  beforeHead: string;
  afterHead: string;
  source: string;
  sourcePin: string | undefined;
  writes: Map<string, string>;
  result: string;
  operationId: string;
  fingerprint: string;
  bytes: number;
  bridgeCertified: boolean;
  legacyStamp?: IntakeLegacyBridgeStamp;
  sourceDetailsOmitted?: boolean;
  legacyStartWrites?: number;
  legacyBeforeDirty?: ReturnType<typeof sourceTextAuthorityDirtyRow>;
  compactMetadata?: {
    sourceRow: Readonly<Record<string, unknown>>;
    target: string;
    sequence: number;
    stamp: IntakeCompactMetadataStamp;
    priorFields: RecordSourcePriorFields;
  };
  assertCurrent?: () => void;
  sourceStaged?: boolean;
  token?: object;
  mainSchema?: number;
  tempSchema?: number;
  verified?: boolean;
  verifiedWrites?: number;
  revision?: string;
  clinicalRevision?: string;
  startCapturedRows?: number;
  closing?: {
    main: ReturnType<DatabaseSync['prepare']>;
    temp: ReturnType<DatabaseSync['prepare']>;
    peer: ReturnType<DatabaseSync['prepare']>;
    writes: ReturnType<DatabaseSync['prepare']>;
  };
}
interface Retained {
  entries: Map<IntakeMaintenancePublication, Publication>;
  bytes: number;
}
const publications = new WeakMap<IntakeMaintenancePublication, Publication>();
const retained = new WeakMap<DatabaseSync, Retained>();
const preparedPublications = new WeakMap<IntakeMaintenancePreparation, PreparedPublication>();
const preparedRetained = new WeakMap<
  DatabaseSync,
  { entries: Map<IntakeMaintenancePreparation, PreparedPublication>; bytes: number }
>();
/** Capture before the terminal transaction disposes its original preparation. */
export function prepareIntakeCompactReadmission(
  db: DatabaseSync,
  capability: IntakeMaintenancePublication,
): RecordCompactReadmission {
  const publication = selected(db, capability);
  if (!publication.compactMetadata) fail('compact readmission requires private source proof');
  return prepareRecordCompactReadmission(db, publication.compactMetadata!.priorFields);
}
/** Only a certified compact source plan may enter the finite terminal path. */
export async function prepareIntakeCompactTerminalPublication(
  db: DatabaseSync,
  capability: IntakeMaintenancePublication,
): Promise<boolean> {
  const publication = selected(db, capability),
    operation = currentClinicalOperation(db);
  if (!publication.compactMetadata || !operation || publication.token)
    fail('compact terminal publication preparation');
  publication.assertCurrent?.();
  // Capture the genuine operation token, not the generic preparation callback.
  publication.assertCurrent = () => assertClinicalOperation(db, operation);
  return prepareRecordCompactTerminal(db, publication.compactMetadata!.priorFields);
}
export function withIntakeCompactTerminalPublication<T>(
  db: DatabaseSync,
  capability: IntakeMaintenancePublication,
  run: () => T,
): T {
  const publication = selected(db, capability);
  if (!publication.compactMetadata) fail('foreign compact terminal publication');
  return withRecordCompactTerminal(db, publication.compactMetadata!.priorFields, run);
}
const MAX_WRITES = 4096;
const MAX_ROW_BYTES = 32 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_BYTES = 24 * 1024 * 1024;
const MAX_RETAINED = 8;
function fail(reason: string): never {
  throw Error(`Intake maintenance publication: ${reason}`);
}
const bytes = (value: string) => Buffer.byteLength(value);
function boundedJson(value: unknown, limit: number): string {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || bytes(encoded) > limit) fail('result budget');
  return encoded;
}
/** Statement reuse lasts only for one synchronous validation phase. Every size
 * and value read still executes, in its original order. No values, authority
 * results or statements survive into publication/reentry or another connection. */
function metadataReader(db: DatabaseSync) {
  let readSize: ReturnType<DatabaseSync['prepare']> | undefined;
  let readValue: ReturnType<DatabaseSync['prepare']> | undefined;
  return (key: string, limit = HEAD_BYTES): string | undefined => {
    readSize ??= terminalStatement(
      db,
      'SELECT length(CAST(value AS BLOB)) AS bytes FROM app_meta WHERE key=?',
    );
    const size = readSize.get(key)?.bytes;
    if (size === undefined) return undefined;
    if (typeof size !== 'number' || size > limit) fail('metadata budget');
    readValue ??= terminalStatement(db, 'SELECT value FROM app_meta WHERE key=?');
    const value = readValue.get(key)?.value;
    if (typeof value !== 'string') fail('metadata representation');
    return value;
  };
}
function sourceBinding(
  db: DatabaseSync,
  identity: IntakeStateIdentity,
  readMeta: ReturnType<typeof metadataReader>,
  includeDetails = true,
): string {
  if (!db.isOpen) fail('closed database');
  if (readMeta('owner_profile_id') !== identity.profileId) fail('database owner');
  const size = terminalStatement(
    db,
    'SELECT length(CAST(details_json AS BLOB)) AS bytes FROM source_files WHERE id=?',
  ).get(identity.intakeId)?.bytes;
  if (typeof size !== 'number' || (includeDetails && size > MAX_WRITE_BYTES))
    fail('source metadata budget');
  const row = terminalStatement(
    db,
    includeDetails
      ? 'SELECT kind,sha256,details_json FROM source_files WHERE id=?'
      : 'SELECT kind,sha256 FROM main.source_files WHERE id=?',
  ).get(identity.intakeId);
  if (!row || row.kind !== 'intake_original' || row.sha256 !== identity.sourceHash)
    fail('original source');
  return JSON.stringify(row);
}
function heads(identity: IntakeStateIdentity, beforeRaw: string, afterRaw: string): void {
  const before = parseIntakeCollectionHead(beforeRaw, identity);
  const after = parseIntakeCollectionHead(afterRaw, identity);
  if (!before || !after) fail('missing collection head');
  if (
    after.storageSequence !== before.storageSequence + 1 ||
    JSON.stringify(before.logical) !== JSON.stringify(after.logical)
  )
    fail('auxiliary publication changed logical state');
}
function remove(capability: IntakeMaintenancePublication): void {
  const publication = publications.get(capability);
  if (!publication) return;
  publications.delete(capability);
  if (publication.compactMetadata)
    discardRecordSourcePriorFields(publication.compactMetadata.priorFields);
  const state = retained.get(publication.db);
  if (state?.entries.delete(capability)) state.bytes -= publication.bytes;
}
/** Expire an issued handle even when preparation failed before entering T1. */
export function discardIntakeMaintenancePublication(
  capability: IntakeMaintenancePublication,
): void {
  remove(capability);
}
/** Also called on storage invalidation/lock; expired handles can never regain authority. */
export function clearIntakeMaintenancePublications(db: DatabaseSync, preparedToken?: object): void {
  const preparations = preparedRetained.get(db);
  for (const [capability, proof] of preparations?.entries ?? [])
    if (
      !preparedToken ||
      proof.originalToken !== preparedToken ||
      !recordPreparedReplayCurrent(db, preparedToken)
    )
      discardIntakeMaintenancePreparation(capability);
  if (!preparations?.entries.size) preparedRetained.delete(db);
  const state = retained.get(db);
  if (!state) return;
  for (const capability of state.entries.keys()) remove(capability);
  state.entries.clear();
  retained.delete(db);
}

/** Internal primitive boundary: call only after validating its private preparation.
 * The transaction guard independently checks heads, current bindings, actual
 * captured rows and readback. No request field or actor string can mint this.
 * As with durable transaction hooks, host code owns the accepted-row capture
 * machinery. This catches misclassified application writes; it does not sandbox
 * arbitrary code that can tamper with that machinery or replace database hooks. */
export function prepareIntakeMaintenancePublication(
  db: DatabaseSync,
  candidate: Candidate,
): IntakeMaintenancePublication {
  if (db.isTransaction) fail('maintenance owns the outer transaction');
  const identity = validateIntakeIdentity(candidate.identity);
  uuid(candidate.operationId);
  if (typeof candidate.fingerprint !== 'string' || bytes(candidate.fingerprint) > 2048)
    fail('operation fingerprint');
  const prefix = intakeNamespace(identity);
  const headKey = prefix + 'head';
  const readMeta = metadataReader(db);
  if (readMeta(headKey) !== candidate.beforeHead) fail('stale prepared head');
  const sourceDetailsOmitted =
    candidate.legacyBridge !== undefined &&
    intakeLegacyBridgeHasOriginalSourceWatch(candidate.legacyBridge, db);
  const source = sourceBinding(
    db,
    identity,
    readMeta,
    candidate.compactMetadata === undefined && !sourceDetailsOmitted,
  );
  const sourcePin = readMeta(intakeSourcePinKey(identity.intakeId));
  if (candidate.legacyBridge !== undefined && candidate.compactMetadata !== undefined)
    fail('conflicting representation proofs');
  const detailsJson = sourceDetailsOmitted
    ? undefined
    : (terminalStatement(db, 'SELECT details_json FROM source_files WHERE id=?').get(
        identity.intakeId,
      )!.details_json as string);
  const proofBinding = {
    identity,
    beforeHead: candidate.beforeHead,
    afterHead: candidate.afterHead,
    sourcePin,
    detailsJson,
    writes: candidate.writes,
  };
  const compactMetadata =
    candidate.compactMetadata === undefined
      ? undefined
      : consumeIntakeCompactMetadataProof(db, candidate.compactMetadata, {
          ...proofBinding,
          detailsJson: detailsJson!,
        });
  const legacyStamp =
    candidate.legacyBridge === undefined
      ? undefined
      : verifyIntakeLegacyBridgeProof(candidate.legacyBridge, db, proofBinding);
  if (candidate.legacyBridge !== undefined && !compactMetadata && !legacyStamp)
    fail('legacy bridge original proof unavailable');
  if (candidate.legacyBridge === undefined && !compactMetadata)
    heads(identity, candidate.beforeHead, candidate.afterHead);
  if (!candidate.writes.length || candidate.writes.length > MAX_WRITES) fail('write count');
  const writes = new Map<string, string>();
  const seen = new Set<string>();
  let encodedBytes = 0;
  let retainedBytes =
    bytes(source) +
    bytes(candidate.beforeHead) +
    bytes(candidate.afterHead) +
    bytes(compactMetadata?.target ?? '');
  for (const { key, value } of candidate.writes) {
    if (
      typeof key !== 'string' ||
      typeof value !== 'string' ||
      seen.has(key) ||
      (key !== headKey &&
        (!key.startsWith(prefix + 'node:') ||
          !/^[a-f0-9]{64}$/.test(key.slice((prefix + 'node:').length))))
    )
      fail('foreign or repeated write');
    seen.add(key);
    const size = bytes(value);
    encodedBytes += size;
    if (size > (key === headKey ? HEAD_BYTES : MAX_ROW_BYTES) || encodedBytes > MAX_WRITE_BYTES)
      fail('write budget');
    if (key === headKey) {
      if (value !== candidate.afterHead) fail('head write');
      writes.set(key, value);
    } else {
      const prior = readMeta(key, MAX_ROW_BYTES);
      if (prior !== undefined) {
        if (prior !== value) fail('immutable collision');
        // Existing nodes must be reused without touching their accepted rows.
        // This also refuses deleting and reinserting an existing node.
        continue;
      }
      writes.set(key, value);
    }
    retainedBytes += bytes(key) + size;
  }
  if (!writes.has(headKey)) fail('missing head write');
  const result = boundedJson(candidate.result, HEAD_BYTES);
  retainedBytes += bytes(result) + bytes(candidate.fingerprint) + bytes(sourcePin ?? '');
  if (retainedBytes > MAX_RETAINED_BYTES) fail('preparation budget');
  const capability = Object.freeze({}) as IntakeMaintenancePublication;
  const publication: Publication = {
    db,
    identity,
    headKey,
    beforeHead: candidate.beforeHead,
    afterHead: candidate.afterHead,
    source,
    sourcePin,
    writes,
    result,
    operationId: candidate.operationId,
    fingerprint: candidate.fingerprint,
    bytes: retainedBytes,
    bridgeCertified: candidate.legacyBridge !== undefined || compactMetadata !== undefined,
    legacyStamp: compactMetadata ? undefined : legacyStamp,
    sourceDetailsOmitted,
    compactMetadata,
    assertCurrent: compactMetadata ? candidate.assertCurrent : undefined,
  };
  let state = retained.get(db);
  if (!state) {
    state = { entries: new Map(), bytes: 0 };
    retained.set(db, state);
  }
  while (state.entries.size >= MAX_RETAINED || state.bytes + retainedBytes > MAX_RETAINED_BYTES)
    remove(state.entries.keys().next().value!);
  state.entries.set(capability, publication);
  state.bytes += retainedBytes;
  publications.set(capability, publication);
  return capability;
}

function selected(db: DatabaseSync, capability: IntakeMaintenancePublication): Publication {
  const publication = publications.get(capability);
  if (!publication || publication.db !== db) fail('foreign, expired or consumed capability');
  return publication;
}

/** Capture only after the record issuer has frozen this actual T1 token/result.
 * The ordinary maintenance handle still expires at T1 finish. This derivative
 * grants no publication authority without the record issuer's fresh T2 token. */
export function captureIntakeMaintenancePreparation(
  db: DatabaseSync,
  capability: IntakeMaintenancePublication,
  token: object,
  operation: TransactionOperation,
): IntakeMaintenancePreparation {
  const publication = selected(db, capability),
    methods = managedDatabaseMethodEpoch(db);
  if (
    !methods ||
    !db.isTransaction ||
    currentTransactionToken(db) !== token ||
    publication.token !== token ||
    !publication.verified ||
    operation.intakeMaintenance !== capability ||
    operation.operationId !== publication.operationId ||
    operation.fingerprint !== publication.fingerprint ||
    !recordTransactionPreparationCaptured(db, operation, token)
  )
    fail('maintenance preparation requires its genuine verified record token');
  if (publication.compactMetadata || publication.legacyStamp || publication.bridgeCertified)
    fail('representation maintenance requires its specialized original proof');
  const proof: PreparedPublication = {
    db,
    originalToken: token,
    methods,
    identity: Object.freeze({ ...publication.identity }),
    headKey: publication.headKey,
    beforeHead: publication.beforeHead,
    afterHead: publication.afterHead,
    source: publication.source,
    sourcePin: publication.sourcePin,
    writes: new Map(publication.writes),
    result: publication.result,
    mainSchema: publication.mainSchema!,
    tempSchema: publication.tempSchema!,
    bytes: publication.bytes,
  };
  const preparation = Object.freeze({}) as IntakeMaintenancePreparation;
  let state = preparedRetained.get(db);
  if (!state) {
    state = { entries: new Map(), bytes: 0 };
    preparedRetained.set(db, state);
  }
  while (state.entries.size >= MAX_RETAINED || state.bytes + proof.bytes > MAX_RETAINED_BYTES)
    discardIntakeMaintenancePreparation(state.entries.keys().next().value!);
  state.entries.set(preparation, proof);
  state.bytes += proof.bytes;
  preparedPublications.set(preparation, proof);
  return preparation;
}

export function discardIntakeMaintenancePreparation(
  preparation: IntakeMaintenancePreparation,
): void {
  const proof = preparedPublications.get(preparation);
  if (!proof) return;
  preparedPublications.delete(preparation);
  const state = preparedRetained.get(proof.db);
  if (state?.entries.delete(preparation)) state.bytes -= proof.bytes;
}

function preparedSelected(
  db: DatabaseSync,
  preparation: IntakeMaintenancePreparation,
): PreparedPublication {
  const proof = preparedPublications.get(preparation);
  if (
    !proof ||
    proof.db !== db ||
    managedDatabaseMethodEpoch(db) !== proof.methods ||
    !recordPreparedReplayCurrent(db, proof.originalToken)
  )
    fail('foreign, expired or unreleased maintenance preparation');
  return proof!;
}

function preparedBinding(db: DatabaseSync, proof: PreparedPublication, after: boolean): void {
  const readMeta = metadataReader(db);
  if (
    Number(terminalStatement(db, 'PRAGMA main.schema_version').get()!.schema_version) !==
      proof.mainSchema ||
    Number(terminalStatement(db, 'PRAGMA temp.schema_version').get()!.schema_version) !==
      proof.tempSchema ||
    sourceBinding(db, proof.identity, readMeta) !== proof.source ||
    readMeta(intakeSourcePinKey(proof.identity.intakeId)) !== proof.sourcePin ||
    readMeta(proof.headKey) !== (after ? proof.afterHead : proof.beforeHead)
  )
    fail('maintenance preparation source, schema or selected head changed');
}

/** Admission is a logical check only. The record owner must retain and close
 * the complete ORIGINAL artifact/source/namespace proof after all callbacks. */
export function assertIntakeMaintenancePreparation(
  db: DatabaseSync,
  preparation: IntakeMaintenancePreparation,
): void {
  const proof = preparedSelected(db, preparation);
  if (db.isTransaction || proof.token) fail('maintenance preparation admission scope');
  preparedBinding(db, proof, false);
  const readMeta = metadataReader(db);
  for (const key of proof.writes.keys())
    if (key !== proof.headKey && readMeta(key, MAX_ROW_BYTES) !== undefined)
      fail('maintenance preparation immutable preimage changed');
  if (preparedSelected(db, preparation) !== proof || db.isTransaction)
    fail('maintenance preparation admission changed');
}

/** Include these exact literals in the genuine record T1 terminal inventory. */
export function intakeMaintenanceReplayStatements(): readonly {
  sql: string;
  bigInts?: boolean;
}[] {
  return [
    { sql: 'PRAGMA main.schema_version' },
    { sql: 'PRAGMA temp.schema_version' },
    { sql: 'SELECT total_changes() AS n', bigInts: true },
    { sql: 'SELECT length(CAST(value AS BLOB)) AS bytes FROM app_meta WHERE key=?' },
    { sql: 'SELECT value FROM app_meta WHERE key=?' },
    { sql: 'SELECT length(CAST(details_json AS BLOB)) AS bytes FROM source_files WHERE id=?' },
    { sql: 'SELECT kind,sha256,details_json FROM source_files WHERE id=?' },
    { sql: 'SELECT entity,record_id FROM __record_changed' },
  ];
}

/** A current transaction token alone cannot revive the disposed T1 handle. */
export function beginIntakeMaintenanceReplay(
  db: DatabaseSync,
  preparation: IntakeMaintenancePreparation,
  token: object,
): void {
  const proof = preparedSelected(db, preparation);
  if (
    proof.token ||
    !db.isTransaction ||
    currentTransactionToken(db) !== token ||
    token === proof.originalToken ||
    !recordPreparedMaintenanceReplayCurrent(db, proof.originalToken, token)
  )
    fail('maintenance replay requires its genuine fresh record token');
  preparedBinding(db, proof, false);
  const readMeta = metadataReader(db);
  for (const key of proof.writes.keys())
    if (key !== proof.headKey && readMeta(key, MAX_ROW_BYTES) !== undefined)
      fail('maintenance replay immutable preimage changed');
  if (
    preparedSelected(db, preparation) !== proof ||
    !recordPreparedMaintenanceReplayCurrent(db, proof.originalToken, token)
  )
    fail('maintenance replay admission changed');
  proof.token = token;
}

/** Before fixed bookkeeping: read back the exact frozen roster and result.
 * expectedChanges comes from the record owner's original counter plus its
 * literal recipe count; never adopt a post-callback observation as a baseline. */
export function verifyIntakeMaintenanceReplay(
  db: DatabaseSync,
  preparation: IntakeMaintenancePreparation,
  token: object,
  resultJson: string,
  expectedChanges: bigint,
): void {
  const proof = preparedSelected(db, preparation),
    total = () => terminalStatement(db, 'SELECT total_changes() AS n', undefined, true).get()!.n;
  const current = () => {
    if (
      proof.token !== token ||
      proof.verified ||
      !db.isTransaction ||
      currentTransactionToken(db) !== token ||
      !recordPreparedMaintenanceReplayCurrent(db, proof.originalToken, token) ||
      total() !== expectedChanges
    )
      fail('maintenance replay token or strict write interval changed');
  };
  current();
  if (resultJson !== proof.result) fail('maintenance replay result changed');
  preparedBinding(db, proof, true);
  const readMeta = metadataReader(db),
    seen = new Set<string>();
  for (const row of terminalStatement(
    db,
    'SELECT entity,record_id FROM __record_changed',
  ).iterate()) {
    if (row.entity !== 'app_meta' || typeof row.record_id !== 'string')
      fail('unexpected maintenance replay accepted row');
    let identity: unknown;
    try {
      identity = JSON.parse(row.record_id);
    } catch {
      fail('maintenance replay captured row identity');
    }
    if (!Array.isArray(identity) || identity.length !== 1 || typeof identity[0] !== 'string')
      fail('maintenance replay captured row identity');
    const key = identity[0] as string,
      expected = proof.writes.get(key);
    if (expected === undefined || seen.has(key) || readMeta(key, MAX_ROW_BYTES) !== expected)
      fail('maintenance replay accepted write readback');
    seen.add(key);
  }
  if (seen.size !== proof.writes.size) fail('maintenance replay missing frozen write');
  heads(proof.identity, proof.beforeHead, proof.afterHead);
  current();
  if (preparedSelected(db, preparation) !== proof) fail('maintenance replay proof changed');
  proof.verified = true;
}

/** Called only after this exact prepared head was staged inside its owner token. */
export function stageIntakeCompactMetadataPublication(
  db: DatabaseSync,
  capability: IntakeMaintenancePublication,
): void {
  const item = selected(db, capability),
    proof = item.compactMetadata;
  if (!proof) return;
  const status = recordDurabilityStatus(db);
  if (
    !item.token ||
    item.token !== currentTransactionToken(db) ||
    item.sourceStaged ||
    !status?.configured ||
    status.dirty ||
    status.conflicted ||
    status.sequence !== proof.sequence ||
    !intakeCompactMetadataStampCurrent(db, proof.stamp, false) ||
    metadataReader(db)(item.headKey) !== item.afterHead ||
    !intakeCompactSourceRowsEqual(
      terminalStatement(
        db,
        'SELECT CAST(rowid AS TEXT) AS __rowid,* FROM main.source_files WHERE id=?',
      ).get(item.identity.intakeId),
      proof.sourceRow,
    )
  )
    fail('compact metadata staging scope');
  const before = proof.sourceRow as { details_json: string };
  const update = terminalStatement(
    db,
    'UPDATE main.source_files SET details_json=? WHERE id=? AND details_json IS ?',
  ).run(proof.target, item.identity.intakeId, before.details_json);
  if (Number(update.changes) !== 1) fail('compact metadata exact update');
  item.sourceStaged = true;
}
/** Called by transaction(), before the durable replay shortcut. */
export function beginIntakeMaintenancePublication(
  db: DatabaseSync,
  capability: IntakeMaintenancePublication,
  token: object,
  operation: { operationId?: unknown; fingerprint?: unknown },
): void {
  const publication = selected(db, capability);
  const readMeta = metadataReader(db);
  if (publication.token) fail('capability already entered');
  if (publication.compactMetadata) {
    publication.revision = readMeta('revision');
    publication.clinicalRevision = readMeta('clinical_review_revision');
    publication.startCapturedRows = Number(
      terminalStatement(db, 'SELECT COUNT(*) AS n FROM __record_changed').get()!.n,
    );
    publication.closing = {
      main: terminalStatement(db, 'PRAGMA main.schema_version'),
      temp: terminalStatement(db, 'PRAGMA temp.schema_version'),
      peer: terminalStatement(db, 'PRAGMA main.data_version'),
      writes: terminalStatement(db, 'SELECT total_changes() AS n'),
    };
    const status = recordDurabilityStatus(db);
    if (
      !status?.configured ||
      status.dirty ||
      status.conflicted ||
      status.sequence !== publication.compactMetadata.sequence ||
      !intakeCompactMetadataStampCurrent(db, publication.compactMetadata.stamp, true)
    )
      fail('compact metadata authority changed before publication');
  }
  if (publication.legacyStamp) {
    if (!legacyBridgeStampCurrent(db, publication.legacyStamp, true, token))
      fail('legacy bridge original authority changed before publication');
    publication.legacyStartWrites = Number(publication.legacyStamp.writes);
    publication.startCapturedRows = Number(
      terminalStatement(db, 'SELECT COUNT(*) AS n FROM __record_changed').get()!.n,
    );
    publication.legacyBeforeDirty = sourceTextAuthorityDirtyRow(
      db,
      publication.identity.intakeId,
      publication.headKey,
    );
    if (!legacyBridgeStampCurrent(db, publication.legacyStamp, true, token))
      fail('legacy bridge original authority changed during admission');
  }
  publication.token = token;
  if (
    operation.operationId !== publication.operationId ||
    operation.fingerprint !== publication.fingerprint
  )
    fail('operation binding');
  if (
    readMeta(publication.headKey) !== publication.beforeHead ||
    sourceBinding(
      db,
      publication.identity,
      readMeta,
      publication.compactMetadata === undefined && !publication.sourceDetailsOmitted,
    ) !== publication.source ||
    (publication.compactMetadata &&
      !intakeCompactSourceRowsEqual(
        terminalStatement(
          db,
          'SELECT CAST(rowid AS TEXT) AS __rowid,* FROM main.source_files WHERE id=?',
        ).get(publication.identity.intakeId),
        publication.compactMetadata.sourceRow,
      )) ||
    readMeta(intakeSourcePinKey(publication.identity.intakeId)) !== publication.sourcePin
  )
    fail('stale authority or source binding');
  if (
    !terminalStatement(
      db,
      "SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='__record_changed'",
    ).get()
  )
    fail('accepted-row capture unavailable');
  publication.mainSchema = Number(
    terminalStatement(db, 'PRAGMA main.schema_version').get()!.schema_version,
  );
  publication.tempSchema = Number(
    terminalStatement(db, 'PRAGMA temp.schema_version').get()!.schema_version,
  );
  if (publication.compactMetadata)
    closePublication(db, publication, Number(publication.compactMetadata.stamp.writes));
}

/** Checks what actually changed, before transaction() writes revision bookkeeping. */
export function verifyIntakeMaintenancePublication(
  db: DatabaseSync,
  capability: IntakeMaintenancePublication,
  token: object,
  result: unknown,
): void {
  const publication = selected(db, capability);
  verifyPublication(db, publication, token, result, false);
  if (publication.legacyStamp) {
    const stamp = publication.legacyStamp;
    const frontier = stamp.frontier;
    if (!frontier) fail('legacy bridge original frontier unavailable');
    const beforeDirty = publication.legacyBeforeDirty;
    const afterDirty = sourceTextAuthorityDirtyRow(
      db,
      publication.identity.intakeId,
      publication.headKey,
    );
    if (
      !Number.isSafeInteger(publication.legacyStartWrites) ||
      !Number.isSafeInteger(publication.startCapturedRows) ||
      (beforeDirty?.authority ?? null) !== (afterDirty?.authority ?? null) ||
      (beforeDirty?.dirty && !afterDirty?.dirty)
    )
      fail('legacy bridge source-text tracking changed');
    const dirtyWrite = beforeDirty && !beforeDirty.dirty && afterDirty?.dirty ? 1 : 0;
    const lookupDirtyWrite = readIntakeFrontierOwnedLookupDirtyWrite(
      db,
      frontier,
      token,
      publication.identity.intakeId,
      publication.headKey,
    );
    if (lookupDirtyWrite === undefined) fail('legacy bridge lookup dirty authority changed');
    const expected =
      publication.legacyStartWrites! +
      publication.startCapturedRows! +
      2 * publication.writes.size +
      dirtyWrite +
      lookupDirtyWrite;
    const total = () => Number(terminalStatement(db, 'SELECT total_changes() AS n').get()!.n);
    const check = () => {
      if (
        total() !== expected ||
        readIntakeFrontierOwnedLookupDirtyWrite(
          db,
          frontier,
          token,
          publication.identity.intakeId,
          publication.headKey,
        ) !== lookupDirtyWrite ||
        !legacyBridgeStampCurrent(db, stamp, false, token)
      )
        fail('legacy bridge unowned publication write');
      const readMeta = metadataReader(db);
      if (
        sourceBinding(db, publication.identity, readMeta, !publication.sourceDetailsOmitted) !==
          publication.source ||
        readMeta(intakeSourcePinKey(publication.identity.intakeId)) !== publication.sourcePin ||
        readMeta(publication.headKey) !== publication.afterHead ||
        sourceTextAuthorityDirtyRow(db, publication.identity.intakeId, publication.headKey)
          ?.dirty !== afterDirty?.dirty ||
        total() !== expected ||
        readIntakeFrontierOwnedLookupDirtyWrite(
          db,
          frontier,
          token,
          publication.identity.intakeId,
          publication.headKey,
        ) !== lookupDirtyWrite ||
        !legacyBridgeStampCurrent(db, stamp, false, token)
      )
        fail('legacy bridge terminal authority changed');
    };
    check();
    installTransactionTerminalGuard(db, token, check);
  }
}
function verifyPublication(
  db: DatabaseSync,
  publication: Publication,
  token: object,
  result: unknown,
  final: boolean,
  indexed?: RecordIndexedPublication,
): void {
  const guarded: unknown = publication.assertCurrent?.();
  if (
    guarded &&
    (typeof guarded === 'object' || typeof guarded === 'function') &&
    'then' in guarded
  )
    fail('compact owner check must finish synchronously');
  const readMeta = metadataReader(db);
  if (publication.token !== token || (final ? !publication.verified : publication.verified))
    fail('transaction binding');
  if (
    final &&
    Number(terminalStatement(db, 'SELECT total_changes() AS n').get()!.n) !==
      (indexed
        ? recordIndexedPublicationWrites(db, indexed, publication.compactMetadata!.stamp.authority)
        : publication.verifiedWrites! + 4 + 2 * Number(publication.clinicalRevision === undefined))
  )
    fail('late mutation after compact verification');
  if (publication.compactMetadata) {
    const status = indexed ? undefined : recordDurabilityStatus(db);
    if (
      indexed
        ? !recordIndexedPublicationCurrent(db, indexed, publication.compactMetadata.stamp.authority)
        : !status?.configured ||
          status.dirty ||
          status.conflicted ||
          status.sequence !== publication.compactMetadata.sequence ||
          !intakeCompactMetadataStampCurrent(db, publication.compactMetadata.stamp, false)
    )
      fail('compact metadata authority changed during publication');
  }
  if (
    Number(terminalStatement(db, 'PRAGMA main.schema_version').get()!.schema_version) !==
      publication.mainSchema ||
    Number(terminalStatement(db, 'PRAGMA temp.schema_version').get()!.schema_version) !==
      publication.tempSchema
  )
    fail('capture/schema changed during publication');
  if (
    sourceBinding(
      db,
      publication.identity,
      readMeta,
      publication.compactMetadata === undefined && !publication.sourceDetailsOmitted,
    ) !== publication.source ||
    readMeta(intakeSourcePinKey(publication.identity.intakeId)) !== publication.sourcePin ||
    (!final && boundedJson(result, HEAD_BYTES) !== publication.result)
  )
    fail('source or result changed');
  const seen = new Set<string>();
  let sourceRows = 0;
  for (const row of terminalStatement(
    db,
    'SELECT entity,record_id FROM __record_changed',
  ).iterate()) {
    if (typeof row.record_id !== 'string') fail('unexpected accepted row');
    let identity: unknown;
    try {
      identity = JSON.parse(row.record_id);
    } catch {
      fail('captured row identity');
    }
    if (!Array.isArray(identity) || identity.length !== 1 || typeof identity[0] !== 'string')
      fail('captured row identity');
    const key = identity[0] as string;
    if (
      final &&
      row.entity === 'app_meta' &&
      (key === 'revision' || key === 'curation_revision' || key === 'clinical_review_revision')
    ) {
      const expected =
        key === 'clinical_review_revision'
          ? (publication.clinicalRevision ?? publication.revision)
          : String(Number(publication.revision) + 1);
      if (readMeta(key) !== expected) fail('late revision bookkeeping changed');
      continue;
    }
    if (row.entity === 'source_files' && publication.compactMetadata) {
      if (key !== publication.identity.intakeId || ++sourceRows !== 1 || !publication.sourceStaged)
        fail('unexpected compact metadata source row');
      const expected = {
        ...publication.compactMetadata.sourceRow,
        details_json: publication.compactMetadata.target,
      };
      if (
        !intakeCompactSourceRowsEqual(
          terminalStatement(
            db,
            'SELECT CAST(rowid AS TEXT) AS __rowid,* FROM main.source_files WHERE id=?',
          ).get(key),
          expected,
        )
      )
        fail('compact metadata complete source readback');
      continue;
    }
    if (row.entity !== 'app_meta') fail('unexpected accepted row');
    const expected = publication.writes.get(key);
    if (expected === undefined || seen.has(key)) fail('unexpected accepted key');
    if (readMeta(key, MAX_ROW_BYTES) !== expected) fail('accepted write readback');
    seen.add(key);
  }
  if (seen.size !== publication.writes.size) fail('missing prepared write');
  if (sourceRows !== (publication.compactMetadata ? 1 : 0))
    fail('missing compact metadata source row');
  const afterHead = readMeta(publication.headKey);
  if (afterHead !== publication.afterHead) fail('selected head readback');
  // A migration certificate already proved this exact representation-only
  // bridge before preparation. Its bound head and every write were read back
  // above, with the same source metadata/pin. Ordinary checkpoints still need
  // the unchanged logical root/version check here.
  if (!publication.bridgeCertified) heads(publication.identity, publication.beforeHead, afterHead);
  if (publication.compactMetadata) {
    const expected = indexed
      ? recordIndexedPublicationWrites(db, indexed, publication.compactMetadata.stamp.authority)
      : final
        ? publication.verifiedWrites! + 4 + 2 * Number(publication.clinicalRevision === undefined)
        : Number(publication.compactMetadata.stamp.writes) +
          publication.startCapturedRows! +
          2 * (publication.writes.size + 1);
    closePublication(db, publication, expected);
  }
  publication.verified = true;
  if (!final)
    publication.verifiedWrites = publication.compactMetadata
      ? Number(publication.compactMetadata.stamp.writes) +
        publication.startCapturedRows! +
        2 * (publication.writes.size + 1)
      : undefined;
}

function closePublication(db: DatabaseSync, publication: Publication, writes: number): void {
  const closing = publication.closing!,
    proof = publication.compactMetadata!;
  if (
    !closing ||
    closing.main.get()!.schema_version !== proof.stamp.mainSchema ||
    closing.temp.get()!.schema_version !== proof.stamp.tempSchema ||
    closing.peer.get()!.data_version !== proof.stamp.peer ||
    Number(closing.writes.get()!.n) !== writes ||
    managedDatabaseMethodEpoch(db) !== proof.stamp.methods ||
    !recordAuthorityWitnessIntervalCurrent(db, proof.stamp.authority)
  )
    fail('compact publication closing SQL/method/physical seal');
}

/** Last proof action; no callback-capable read follows this seal. */
export function sealIntakeMaintenancePriorFields(
  db: DatabaseSync,
  capability: IntakeMaintenancePublication,
): number {
  const publication = selected(db, capability);
  if (
    !publication.compactMetadata ||
    !publication.verified ||
    publication.token !== currentTransactionToken(db)
  )
    fail('compact closing token');
  const writes =
    publication.verifiedWrites! + 4 + 2 * Number(publication.clinicalRevision === undefined);
  closePublication(db, publication, writes);
  return writes;
}
/** Only a genuine fixed indexed transition may precede the accepted HEAD leaf. */
export function renewIntakeMaintenanceAfterIndex(
  db: DatabaseSync,
  capability: IntakeMaintenancePublication,
  indexed: RecordIndexedPublication,
): void {
  const publication = selected(db, capability);
  if (!publication.compactMetadata) fail('indexed renewal requires compact proof');
  verifyPublication(db, publication, currentTransactionToken(db)!, undefined, true, indexed);
}

/** Private durability renewal after callbacks and fixed revision bookkeeping. */
export function consumeIntakeMaintenancePriorFields(
  db: DatabaseSync,
  capability: IntakeMaintenancePublication,
): RecordSourcePriorFields | undefined {
  const publication = selected(db, capability);
  if (!publication.compactMetadata) return undefined;
  const token = currentTransactionToken(db);
  if (!token) fail('compact prior comparison outside transaction');
  verifyPublication(db, publication, token!, undefined, true);
  return publication.compactMetadata.priorFields;
}

/** Release retained preparation bytes on success or failure of this transaction. */
export function finishIntakeMaintenancePublication(
  capability: IntakeMaintenancePublication,
  token: object,
): void {
  if (publications.get(capability)?.token === token) remove(capability);
}
