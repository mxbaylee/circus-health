import type { DatabaseSync } from 'node:sqlite';
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
  type IntakeLegacyBridgeProof,
} from './intake-state-migration.ts';

declare const maintenanceBrand: unique symbol;
/** Host-owned, single-use permission for one exact auxiliary publication. */
export interface IntakeMaintenancePublication {
  readonly [maintenanceBrand]: true;
}
export interface IntakeMaintenanceWrite {
  readonly key: string;
  readonly value: string;
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
  token?: object;
  mainSchema?: number;
  tempSchema?: number;
  verified?: boolean;
}
interface Retained {
  entries: Map<IntakeMaintenancePublication, Publication>;
  bytes: number;
}
const publications = new WeakMap<IntakeMaintenancePublication, Publication>();
const retained = new WeakMap<DatabaseSync, Retained>();
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
    readSize ??= db.prepare(
      'SELECT length(CAST(value AS BLOB)) AS bytes FROM app_meta WHERE key=?',
    );
    const size = readSize.get(key)?.bytes;
    if (size === undefined) return undefined;
    if (typeof size !== 'number' || size > limit) fail('metadata budget');
    readValue ??= db.prepare('SELECT value FROM app_meta WHERE key=?');
    const value = readValue.get(key)?.value;
    if (typeof value !== 'string') fail('metadata representation');
    return value;
  };
}
function sourceBinding(
  db: DatabaseSync,
  identity: IntakeStateIdentity,
  readMeta: ReturnType<typeof metadataReader>,
): string {
  if (!db.isOpen) fail('closed database');
  if (readMeta('owner_profile_id') !== identity.profileId) fail('database owner');
  const size = db
    .prepare('SELECT length(CAST(details_json AS BLOB)) AS bytes FROM source_files WHERE id=?')
    .get(identity.intakeId)?.bytes;
  if (typeof size !== 'number' || size > MAX_WRITE_BYTES) fail('source metadata budget');
  const row = db
    .prepare('SELECT kind,sha256,details_json FROM source_files WHERE id=?')
    .get(identity.intakeId);
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
  const state = retained.get(publication.db);
  if (state?.entries.delete(capability)) state.bytes -= publication.bytes;
}
/** Also called on storage invalidation/lock; expired handles can never regain authority. */
export function clearIntakeMaintenancePublications(db: DatabaseSync): void {
  const state = retained.get(db);
  if (!state) return;
  for (const capability of state.entries.keys()) publications.delete(capability);
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
  const source = sourceBinding(db, identity, readMeta);
  const sourcePin = readMeta(intakeSourcePinKey(identity.intakeId));
  if (candidate.legacyBridge !== undefined) {
    verifyIntakeLegacyBridgeProof(candidate.legacyBridge, db, {
      identity,
      beforeHead: candidate.beforeHead,
      afterHead: candidate.afterHead,
      sourcePin,
      detailsJson: db
        .prepare('SELECT details_json FROM source_files WHERE id=?')
        .get(identity.intakeId)!.details_json as string,
      writes: candidate.writes,
    });
  } else heads(identity, candidate.beforeHead, candidate.afterHead);
  if (!candidate.writes.length || candidate.writes.length > MAX_WRITES) fail('write count');
  const writes = new Map<string, string>();
  const seen = new Set<string>();
  let encodedBytes = 0;
  let retainedBytes = bytes(source) + bytes(candidate.beforeHead) + bytes(candidate.afterHead);
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
    bridgeCertified: candidate.legacyBridge !== undefined,
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
  publication.token = token;
  if (
    operation.operationId !== publication.operationId ||
    operation.fingerprint !== publication.fingerprint
  )
    fail('operation binding');
  if (
    readMeta(publication.headKey) !== publication.beforeHead ||
    sourceBinding(db, publication.identity, readMeta) !== publication.source ||
    readMeta(intakeSourcePinKey(publication.identity.intakeId)) !== publication.sourcePin
  )
    fail('stale authority or source binding');
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='__record_changed'")
      .get()
  )
    fail('accepted-row capture unavailable');
  publication.mainSchema = Number(db.prepare('PRAGMA main.schema_version').get()!.schema_version);
  publication.tempSchema = Number(db.prepare('PRAGMA temp.schema_version').get()!.schema_version);
}

/** Checks what actually changed, before transaction() writes revision bookkeeping. */
export function verifyIntakeMaintenancePublication(
  db: DatabaseSync,
  capability: IntakeMaintenancePublication,
  token: object,
  result: unknown,
): void {
  const publication = selected(db, capability);
  const readMeta = metadataReader(db);
  if (publication.token !== token || publication.verified) fail('transaction binding');
  if (
    Number(db.prepare('PRAGMA main.schema_version').get()!.schema_version) !==
      publication.mainSchema ||
    Number(db.prepare('PRAGMA temp.schema_version').get()!.schema_version) !==
      publication.tempSchema
  )
    fail('capture/schema changed during publication');
  if (
    sourceBinding(db, publication.identity, readMeta) !== publication.source ||
    readMeta(intakeSourcePinKey(publication.identity.intakeId)) !== publication.sourcePin ||
    boundedJson(result, HEAD_BYTES) !== publication.result
  )
    fail('source or result changed');
  const seen = new Set<string>();
  for (const row of db.prepare('SELECT entity,record_id FROM __record_changed').iterate()) {
    if (row.entity !== 'app_meta' || typeof row.record_id !== 'string')
      fail('unexpected accepted row');
    let identity: unknown;
    try {
      identity = JSON.parse(row.record_id);
    } catch {
      fail('captured row identity');
    }
    if (!Array.isArray(identity) || identity.length !== 1 || typeof identity[0] !== 'string')
      fail('captured row identity');
    const key = identity[0] as string;
    const expected = publication.writes.get(key);
    if (expected === undefined || seen.has(key)) fail('unexpected accepted key');
    if (readMeta(key, MAX_ROW_BYTES) !== expected) fail('accepted write readback');
    seen.add(key);
  }
  if (seen.size !== publication.writes.size) fail('missing prepared write');
  const afterHead = readMeta(publication.headKey);
  if (afterHead !== publication.afterHead) fail('selected head readback');
  // A migration certificate already proved this exact representation-only
  // bridge before preparation. Its bound head and every write were read back
  // above, with the same source metadata/pin. Ordinary checkpoints still need
  // the unchanged logical root/version check here.
  if (!publication.bridgeCertified) heads(publication.identity, publication.beforeHead, afterHead);
  publication.verified = true;
}

/** Release retained preparation bytes on success or failure of this transaction. */
export function finishIntakeMaintenancePublication(
  capability: IntakeMaintenancePublication,
  token: object,
): void {
  if (publications.get(capability)?.token === token) remove(capability);
}
