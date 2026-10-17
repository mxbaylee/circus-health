/** V4 bounded collections owned and staged by intake-state-storage. */
import { constants } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { validateIntakeCollectionGraphSteps } from './intake-state-graph.ts';
import {
  FORMAT as LOG_FORMAT,
  initializeIntakeLog,
  authenticateIntakeLogHeadRoots,
  intakeLogBaseHead,
  rebuildIntakeLogSnapshot,
  rebuildIntakeLogSnapshotSteps,
  replayIntakeLog,
  readIntakeLogSequence,
  prepareIntakeLogAppend,
  forkIntakeLogSnapshot,
  inspectIntakeLogAppend,
  discardIntakeLogAppend,
  disposeIntakeLogSnapshot,
  cacheIntakeLogSnapshot,
  holdIntakeLogSnapshot,
  isIntakeLogSnapshotResident,
  retireIntakeLogSnapshot,
  confirmOwnedIntakeLogPublication,
  type IntakeLogSnapshot,
  type IntakeLogAppend,
  type Head as LogHead,
  type LogAdmission,
} from './intake-state-log.ts';
import { types as utilTypes } from 'node:util';
import { terminalStatement } from './database-terminal-statements.ts';
import {
  currentTransactionToken,
  managedDatabaseMethodEpoch,
  observeManagedDatabaseAuthorization,
  rejectCurrentTransaction,
  transaction,
  type Database,
} from './database.ts';
import {
  prepareIntakeMaintenancePublication,
  discardIntakeMaintenancePublication,
  stageIntakeCompactMetadataPublication,
  prepareIntakeCompactReadmission,
  prepareIntakeCompactTerminalPublication,
  withIntakeCompactTerminalPublication,
  intakeCompactContributorTerminalPrepared,
  commitIntakeCompactContributorTerminalPublication,
} from './intake-state-maintenance.ts';
import { currentClinicalOperation, assertClinicalOperation } from './clinical-operation.ts';
import {
  blockIntakeFrontierReadmission,
  captureIntakeFrontierAttempts,
  readIntakeFrontierAttempts,
  readIntakeFrontierActiveUnwritten,
  type IntakeFrontierAttemptSnapshot,
  ensureIntakeFrontierObserver,
  expectIntakeFrontierMetaWrite,
  finishIntakeFrontierMetaWrite,
} from './intake-lookup-frontier-observer.ts';
import {
  assertRecordCompactReadmission,
  captureRecordAcceptedIntakeHeadRead,
  closeRecordAcceptedIntakeHeadRead,
  registerRecordIntakeLogPublication,
  finishRecordCompactContributorReadmission,
  authenticateRecordTransactionPreparation,
  commitRecordTransactionPreparation,
  discardRecordTransactionPreparation,
  prepareRecordTransactionWithOriginals,
  stageRecordTransactionPreparation,
  assertRecordAcceptedIntakeHeadRead,
  type RecordAcceptedIntakeHeadRead,
  type RecordPublicationOriginals,
  type RecordTransactionPreparation,
} from './record-versions.ts';
import {
  prepareIntakeLegacyBridgeProof,
  captureIntakeLegacyBridgeReadWitness,
  disposeIntakeLegacyBridgeReadWitness,
  prepareIntakeLegacyBridgeProofAsync,
  type IntakeLegacyBridgeReadWitness,
  assertIntakeLegacyBridgeReadWitnessForSource,
  prepareIntakeSchemaAdoptionProof,
  prepareIntakeSchemaAdoptionProofAsync,
  validateIntakeLegacyBridgeControl,
  INTAKE_LEGACY_BRIDGE_CONTROL,
  type IntakeLegacyBridgeProof,
  type IntakeCompactMetadataProof,
  prepareIntakeCompactMetadataProofAsync,
  consumeIntakeReferencedTargetIntent,
  projectIntakeReferencedTargetCandidateAsync,
} from './intake-state-migration.ts';
import type { IntakeStateMaterialization } from './intake-state-storage.ts';
import type { PreparedSelectedIntakeEnvelope } from './intake-authority.ts';
import {
  COLLECTION_FORMAT,
  HEAD_BYTES,
  decode,
  exact,
  integer,
  invalid,
  uuid,
  parseIntakeCollectionHead,
  parseIntakeHead,
  limits,
  type Head,
  type IntakeCollectionHead,
  type IntakeCollectionHeadV4,
  type IntakeCollectionResult,
  type IntakeStateIdentity,
} from './intake-state-evidence.ts';
import {
  createIntakeTree,
  decodeIntakeTreeNode,
  intakeTreeRef,
  intakeTreeKey,
  INTAKE_TREE_PAGE_BYTES,
  INTAKE_TREE_VALUE_BYTES,
  type IntakeTreeCachedNode,
  type IntakeTreeReadCertificate,
  type IntakeTreeRef,
  type IntakeTreeRoot,
} from './intake-state-tree.ts';
import {
  resolveSchemaMetadata,
  resolveSchemaFieldTarget,
} from './intake-schema-record-resolution.ts';
import {
  parseSchemaControl,
  type SchemaRecord,
  type SchemaTarget,
} from './intake-envelope-schema.ts';
import {
  createSchemaRecordCursor,
  stepSchemaRecordCursor,
  closeSchemaRecordCursor,
  schemaRecordCursorRevision,
  type SchemaRecordCursor,
  textValue,
  cellChunks,
} from './intake-schema-record-stream.ts';
import type { EnvelopeCellReader, IntakeEnvelopeField } from './intake-collection-envelope.ts';
import { recordIntakeWork, recordIntakePeak, withIntakeWork } from './intake-work-accounting.ts';
import { stagePrivateReaderCoverageTransitions } from './intake-source-reader-index.ts';
import {
  createPrivateEnvelopeCandidate,
  type PrivateEnvelopeCandidate,
  type PrivateEnvelopeNodeRoster,
} from './intake-envelope-candidate.ts';

declare const viewBrand: unique symbol;
declare const preparationBrand: unique symbol;
declare const byteValueBrand: unique symbol;
declare const collectionValueBrand: unique symbol;
export interface IntakeCollectionValue {
  readonly [collectionValueBrand]: true;
  readonly kind: 'collection';
  readonly collectionKind: IntakeCollectionDescriptor['kind'];
  readonly count: number;
  readonly bytes: number;
}
export interface IntakeByteValue {
  readonly [byteValueBrand]: true;
  readonly kind: 'bytes';
  readonly bytes: number;
  readonly chunks: number;
}
export interface IntakeCollectionView {
  readonly [viewBrand]: true;
}
export interface PreparedIntakeCollectionMutation {
  readonly [preparationBrand]: true;
}
export type IntakeCollectionArea = 'logical' | 'builds';
export type IntakeCollectionChange = {
  area: IntakeCollectionArea;
  collection: string;
} & (
  | { op: 'put'; key: string; value: string }
  | { op: 'delete'; key: string }
  | { op: 'append'; value: string }
  | { op: 'replace'; index: number; value: string }
  | { op: 'appendBytes'; bytes: Uint8Array }
  | { op: 'adoptBytesReferenced'; value: IntakeByteValue }
  | { op: 'replaceBytes'; index: number; bytes: Uint8Array }
  /** Exactly one authenticated last leaf per bounded maintenance change. */
  | { op: 'truncateBytes'; length: number }
  | {
      op: 'putBytes';
      key: string;
      fromArea: IntakeCollectionArea;
      fromCollection: string;
    }
  | {
      op: 'putCollection';
      key: string;
      fromArea: IntakeCollectionArea;
      fromCollection: string;
    }
  | { op: 'adoptReferenced'; value: IntakeCollectionValue }
  | {
      op: 'adoptCollection';
      fromArea: IntakeCollectionArea;
      fromCollection: string;
    }
);
export interface IntakeCollectionMutation {
  operationId: string;
  /** Existing domain request digest; identical operation IDs must keep it. */
  requestDigest: string;
  domainVersion: number;
  changes: readonly IntakeCollectionChange[];
}
export interface IntakeCollectionDescriptor {
  kind: 'map' | 'sequence' | 'bytes';
  root: IntakeTreeRoot;
  bytes: number;
}
interface ViewData {
  prefix: string;
  raw: string | undefined;
  head: IntakeCollectionHead | undefined;
  legacy?: Head;
}
interface PreparedData {
  prefix: string;
  before: string | undefined;
  after: string;
  writes: Array<{ key: string; value: string }>;
  result: IntakeCollectionResult;
  requestDigest: string;
  size: number;
  legacyBridge?: IntakeLegacyBridgeProof;
  compactMetadata?: IntakeCompactMetadataProof;
  logAppend?: IntakeLogAppend;
  logSnapshot?: IntakeLogSnapshot;
  privateEnvelope?: {
    candidate: PrivateEnvelopeCandidate;
    roster: PrivateEnvelopeNodeRoster;
  };
}
export type SchemaChildResolution =
  { kind: 'missing' } | { kind: 'cell' } | { kind: 'record'; id: string; header: SchemaRecord };
interface SchemaRecordOwner {
  canReadChild: () => boolean;
  child: (
    view: IntakeCollectionView,
    mode: 'raw' | 'normalized',
    root: string,
    id: string,
    selection: 'first' | 'last',
    name: string,
    area?: IntakeCollectionArea,
    collection?: string,
  ) => SchemaChildResolution;
  canReadFields: () => boolean;
  fields: (
    view: IntakeCollectionView,
    mode: 'raw' | 'normalized',
    root: string,
    selection: 'first' | 'last',
    requests: readonly { id: string; name: string; bytes: number }[],
    area?: IntakeCollectionArea,
    collection?: string,
  ) => IntakeEnvelopeField[];
  createCursor: (
    view: IntakeCollectionView,
    id: string,
    area: IntakeCollectionArea,
    collection: string,
  ) => SchemaRecordCursor | undefined;
  nextCursor: (cursor: SchemaRecordCursor) => IteratorResult<string>;
  closeCursor: (cursor: SchemaRecordCursor) => void;
  canAdvance: () => boolean;
  field: (
    view: IntakeCollectionView,
    mode: 'raw' | 'normalized',
    root: string,
    id: string,
    selection: 'first' | 'last',
    name: string,
    area?: IntakeCollectionArea,
    collection?: string,
  ) => { target: SchemaTarget | undefined };
  resolve: (
    view: IntakeCollectionView,
    mode: 'raw' | 'normalized',
    root: string,
    id: string,
    selection: 'first' | 'last',
    area?: IntakeCollectionArea,
    collection?: string,
  ) => SchemaRecord;
  clear: () => void;
  current: () => boolean;
}
const schemaRecordOwners = new WeakMap<object, Readonly<SchemaRecordOwner>>();
/** Only exact owner-produced handles obtain this fixed authenticated resolver. */
export function intakeSchemaRecordOwner(
  collections: object,
): Readonly<SchemaRecordOwner> | undefined {
  return schemaRecordOwners.get(collections);
}
function detachSchemaFieldRequests(
  requests: readonly { id: string; name: string; bytes: number }[],
) {
  if (!Array.isArray(requests) || utilTypes.isProxy(requests) || requests.length > 64)
    invalid('schema field snapshot requests');
  let bytes = 0,
    metadata = 0;
  return Array.from({ length: requests.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(requests, String(index));
    const request = item && Object.hasOwn(item, 'value') ? item.value : undefined;
    if (!request || typeof request !== 'object' || utilTypes.isProxy(request))
      invalid('schema field snapshot request');
    const values = ['id', 'name', 'bytes'].map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(request, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value'))
        invalid('schema field snapshot descriptor');
      return descriptor.value;
    });
    const [id, name, budget] = values;
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(id) ||
      typeof name !== 'string' ||
      !Number.isSafeInteger(budget) ||
      budget < 1 ||
      budget > 256 * 1024
    )
      invalid('schema field snapshot arguments');
    bytes += budget;
    metadata += Buffer.byteLength(name) + 64;
    if (bytes > 256 * 1024 || metadata > 64 * 1024) invalid('schema field snapshot budget');
    return { id, name, bytes: budget };
  });
}
interface ResolvedSchemaEntry {
  header: Readonly<SchemaRecord>;
  witness: string;
  epoch: object;
  bytes: number;
}
interface Registry {
  schemaRecords: Map<string, ResolvedSchemaEntry>;
  schemaRecordBytes: number;
  schemaRecordEpoch: object;
  schemaRecordWitness?: string;
  generation: object;
  pages: Map<string, IntakeTreeCachedNode>;
  views: WeakMap<IntakeCollectionView, ViewData>;
  preparations: Map<PreparedIntakeCollectionMutation, PreparedData>;
  preparedBytes: number;
  privateCandidates: Map<PrivateEnvelopeCandidate, object>;
  byteValues: Map<
    IntakeByteValue,
    {
      prefix: string;
      logical: string;
      root: IntakeTreeRoot;
      bytes: number;
      count: number;
    }
  >;
  collectionValues: Map<
    IntakeCollectionValue,
    {
      prefix: string;
      logical: string;
      descriptor: IntakeCollectionDescriptor;
      privateCandidate?: PrivateEnvelopeCandidate;
    }
  >;
}
interface CompleteLogState {
  raw: string | undefined;
  snapshot: IntakeLogSnapshot;
  head: LogHead;
  frontier: IntakeFrontierAttemptSnapshot;
  methods: object | undefined;
  current: () => void;
  admissions?: Map<object, () => void>;
  close?: () => void;
  pending?: {
    append: IntakeLogAppend;
    before: string | undefined;
    token?: object;
    publication?: import('./record-versions.ts').RecordIntakeLogPublication;
  };
}
const completeLogs = new WeakMap<Database, Map<string, CompleteLogState>>();
function dropCompleteLogs(db: Database, preparedToken?: object) {
  const entries = completeLogs.get(db);
  for (const [prefix, entry] of entries ?? []) {
    if (preparedToken && entry.pending?.token === preparedToken) continue;
    entries!.delete(prefix);
    try {
      entry.close?.();
    } catch {
      /* derivative cleanup */
    }
    try {
      disposeIntakeLogSnapshot(entry.snapshot);
    } catch {
      /* already revoked */
    }
  }
  if (!entries?.size) completeLogs.delete(db);
}
const registries = new WeakMap<Database, Registry>();
/** Invalidates owner-handle reuse along with the existing disposable registry. */
export function intakeCollectionCacheGeneration(db: Database): object {
  return registryFor(db).generation;
}

/** Compose this lifetime seal with the reader's selected-logical/owner check.
 * A fresh traversal may capture a new registry; a started one may never do so. */
export function retainIntakeCollectionCache(db: Database): () => void {
  const generation = intakeCollectionCacheGeneration(db);
  return () => {
    if (intakeCollectionCacheGeneration(db) !== generation) invalid('expired collection traversal');
  };
}
export function clearIntakeCollectionCache(db: Database, preparedToken?: object): void {
  dropCompleteLogs(db, preparedToken);
  const registry = registries.get(db);
  const candidates = new Set(registry?.privateCandidates.keys());
  for (const data of registry?.preparations.values() ?? [])
    if (data.privateEnvelope) candidates.add(data.privateEnvelope.candidate);
  registries.delete(db);
  registry?.pages.clear();
  registry?.schemaRecords.clear();
  if (registry) {
    registry.schemaRecordBytes = 0;
    registry.schemaRecordEpoch = {};
  }
  if (registry) registry.views = new WeakMap();
  registry?.preparations.clear();
  registry?.byteValues.clear();
  registry?.collectionValues.clear();
  registry?.privateCandidates.clear();
  // Disposal cannot restore a revoked registry or turn an accepted outcome
  // into failure. Drain every private workspace, even if one cleanup fails.
  for (const candidate of candidates) {
    try {
      candidate.close();
    } catch {
      // The candidate and registry are already revoked.
    }
  }
}
function registryFor(db: Database): Registry {
  let value = registries.get(db);
  if (!value) {
    value = {
      generation: Object.freeze({}),
      schemaRecords: new Map(),
      schemaRecordBytes: 0,
      schemaRecordEpoch: {},
      pages: new Map(),
      views: new WeakMap(),
      preparations: new Map(),
      preparedBytes: 0,
      privateCandidates: new Map(),
      byteValues: new Map(),
      collectionValues: new Map(),
    };
    registries.set(db, value);
  }
  return value;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const orderedKey = (index: number) => {
  integer(index);
  return String(index).padStart(16, '0');
};
function collectionName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value))
    invalid('collection name');
}
export function parseIntakeCollectionDescriptor(
  raw: string | undefined,
): IntakeCollectionDescriptor | undefined {
  if (raw === undefined) return undefined;
  const value = decode(raw, INTAKE_TREE_VALUE_BYTES);
  exact(value, ['kind', 'root', 'bytes']);
  if (!['map', 'sequence', 'bytes'].includes(String(value.kind))) invalid('collection kind');
  intakeTreeRef(value.root);
  integer(value.bytes);
  return value as unknown as IntakeCollectionDescriptor;
}
export function checkIntakeCollectionResult(
  value: unknown,
  identity: IntakeStateIdentity,
  operationId: string,
): IntakeCollectionResult {
  exact(value, ['format', 'intakeId', 'operationId', 'storageSequence', 'logical', 'changed']);
  if (
    value.format !== 'health-intake-state-result-v4' ||
    value.intakeId !== identity.intakeId ||
    value.operationId !== operationId ||
    typeof value.changed !== 'boolean'
  )
    invalid('collection receipt result');
  integer(value.storageSequence, 1);
  exact(value.logical, ['root', 'domainVersion']);
  intakeTreeRef(value.logical.root);
  integer(value.logical.domainVersion);
  return value as unknown as IntakeCollectionResult;
}
export function parseIntakeCollectionReceipt(
  raw: string,
  identity: IntakeStateIdentity,
  operationId: string,
) {
  const value = decode(raw, INTAKE_TREE_VALUE_BYTES);
  exact(value, ['format', 'requestDigest', 'result']);
  if (
    value.format !== 'health-intake-state-receipt-v4' ||
    typeof value.requestDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.requestDigest)
  )
    invalid('collection receipt');
  return {
    format: 'health-intake-state-receipt-v4' as const,
    requestDigest: value.requestDigest,
    result: checkIntakeCollectionResult(value.result, identity, operationId),
  };
}
export function parseIntakeCollectionHistory(raw: string, identity: IntakeStateIdentity) {
  const value = decode(raw, INTAKE_TREE_VALUE_BYTES);
  exact(value, ['format', 'operationId', 'previous', 'logical', 'builds']);
  if (value.format !== 'health-intake-state-history-v4') invalid('collection history');
  uuid(value.operationId);
  let previous: IntakeCollectionHead | { format: 'health-intake-legacy-v3'; head: Head } | null;
  if (value.previous === null) previous = null;
  else if (
    typeof value.previous === 'object' &&
    Reflect.get(value.previous as object, 'format') === 'health-intake-legacy-v3'
  ) {
    exact(value.previous, ['format', 'head']);
    previous = {
      format: 'health-intake-legacy-v3',
      head: parseIntakeHead(JSON.stringify(value.previous.head), identity, limits())!,
    };
  } else previous = parseIntakeCollectionHead(JSON.stringify(value.previous), identity)!;
  exact(value.logical, ['root', 'domainVersion']);
  intakeTreeRef(value.logical.root);
  integer(value.logical.domainVersion);
  intakeTreeRef(value.builds);
  return {
    format: value.format,
    operationId: value.operationId as string,
    previous,
    logical: value.logical as unknown as IntakeCollectionHead['logical'],
    builds: value.builds,
  };
}
const descriptor = parseIntakeCollectionDescriptor;
export type IntakeStoredValue =
  | { kind: 'inline'; text: string }
  | { kind: 'bytes'; root: IntakeTreeRoot; bytes: number }
  | { kind: 'collection'; descriptor: IntakeCollectionDescriptor };
export function parseIntakeStoredValue(raw: string): IntakeStoredValue {
  const value = decode(raw, INTAKE_TREE_VALUE_BYTES);
  if (value && typeof value === 'object' && Reflect.get(value, 'kind') === 'inline') {
    exact(value, ['kind', 'text']);
    if (typeof value.text !== 'string') invalid('inline collection value');
  } else if (value && typeof value === 'object' && Reflect.get(value, 'kind') === 'collection') {
    exact(value, ['kind', 'descriptor']);
    parseIntakeCollectionDescriptor(JSON.stringify(value.descriptor));
  } else {
    exact(value, ['kind', 'root', 'bytes']);
    if (value.kind !== 'bytes') invalid('collection value kind');
    intakeTreeRef(value.root);
    integer(value.bytes);
  }
  return value as IntakeStoredValue;
}
const inlineValue = (text: string) => {
  if (typeof text !== 'string') invalid('inline collection text');
  if (Buffer.byteLength(text) > INTAKE_TREE_VALUE_BYTES)
    invalid('inline collection value requires byte chunks');
  const encoded = JSON.stringify({ kind: 'inline', text });
  if (Buffer.byteLength(encoded) > INTAKE_TREE_VALUE_BYTES)
    invalid('encoded collection value requires byte chunks');
  return encoded;
};
const valueBytes = (raw: string | undefined) => {
  if (raw === undefined) return 0;
  const value = parseIntakeStoredValue(raw);
  return value.kind === 'inline'
    ? Buffer.byteLength(value.text)
    : value.kind === 'bytes'
      ? value.bytes
      : Buffer.byteLength(JSON.stringify(value.descriptor));
};
/** Receives lifecycle/readiness/publication primitives from the one intake owner. */
export function createIntakeCollections(owner: {
  db: Database;
  identity: IntakeStateIdentity;
  prefix: string;
  ready: () => void;
  get: (key: string, maxBytes?: number) => unknown;
  immutable: (key: string, value: string, maxBytes?: number) => boolean;
  invalidate: () => void;
  legacyMaterialization: (head: Head) => IntakeStateMaterialization;
  legacyMaterializationAsync: (
    head: Head,
    assertCurrent: () => void,
  ) => Promise<IntakeStateMaterialization>;
}) {
  const { db, identity, prefix, ready, immutable } = owner;
  const headKey = prefix + 'head';
  const readGeneration = db.prepare(
    'SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS external,(SELECT schema_version FROM pragma_schema_version) AS schema',
  );
  readGeneration.setReadBigInts(true);
  const readTempGeneration = db.prepare('PRAGMA temp.schema_version');
  readTempGeneration.setReadBigInts(true);
  let validatedSelection:
    { raw: unknown; generation: string; registry: Registry; value: ViewData } | undefined;
  let bridgeTransaction: object | undefined;
  let deferredLegacyInput: IntakeCollectionMutation | undefined;
  const privateCandidates = new WeakMap<
    PrivateEnvelopeCandidate,
    { logical: string; methods: object; operation: string }
  >();
  const privateOwner = Object.freeze({});
  let readEpoch: object = {};
  let activeFieldRead: { poisoned: boolean } | undefined;
  const schemaTransactionReads = new WeakMap<IntakeTreeReadCertificate, () => void>();
  const readWitness = () => {
    recordIntakeWork('collectionReadWitnessQueries', 2);
    const stamp = terminalStatement(db, readGeneration.sourceSQL, readGeneration, true).get()!,
      temp = terminalStatement(db, readTempGeneration.sourceSQL, readTempGeneration, true).get()!;
    return `${stamp.changes}:${stamp.external}:${stamp.schema}:${temp.schema_version}`;
  };
  const get = (key: string) => owner.get(key, key === headKey ? HEAD_BYTES : 32 * 1024);
  const run = <T>(fn: () => T): T =>
    withIntakeWork(db, 'warm', () => {
      if (activeFieldRead) {
        activeFieldRead.poisoned = true;
        invalid('reentrant schema field snapshot operation');
      }
      try {
        // A mutator or callback-bearing preparation never inherits an optimistic read.
        readEpoch = {};
        ready();
        return fn();
      } catch (error) {
        if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
        owner.invalidate();
        throw error;
      }
    });
  // Callers synchronously consume tree iterators and detach bounded results.
  // Preparation starts a fresh epoch and returns only an opaque capability after
  // its final authority check; input callbacks cannot rebase the entry witness.
  // No write or asynchronous work is authorized by this certificate.
  function readSchemaTransaction<T>(
    fn: (pages: typeof tree, certificate?: IntakeTreeReadCertificate) => T,
    token: object,
    methods: object,
    requireCertificate = false,
  ): T {
    const epoch = (readEpoch = {}),
      generation = registryFor(db).generation;
    let attempted = false;
    let proof: IntakeTreeReadCertificate | undefined;
    const stop = observeManagedDatabaseAuthorization(
      db,
      (action, name, detail) => {
        const readOnlyPragma =
          action === constants.SQLITE_PRAGMA &&
          (name === 'schema_version' || name === 'data_version') &&
          detail == null;
        if (
          action !== constants.SQLITE_READ &&
          action !== constants.SQLITE_SELECT &&
          action !== constants.SQLITE_FUNCTION &&
          !readOnlyPragma
        )
          attempted = true;
      },
      () => {
        attempted = true;
      },
    );
    const check = () => {
      if (
        attempted ||
        !db.isTransaction ||
        currentTransactionToken(db) !== token ||
        managedDatabaseMethodEpoch(db) !== methods ||
        readEpoch !== epoch ||
        registryFor(db).generation !== generation ||
        (proof && proof.state !== 'active')
      )
        invalid('schema transaction read authority changed');
    };
    try {
      if (!stop) {
        if (requireCertificate) invalid('schema field transaction observer unavailable');
        ready();
        return fn(tree);
      }
      proof = { witness: readWitness(), registry: generation, epoch, state: 'active' };
      check();
      schemaTransactionReads.set(proof, check);
      ready();
      check();
      const certificate = proof;
      const result = fn(() => tree({ certificate, check }), certificate);
      if (result && typeof result === 'object' && ('then' in result || 'next' in result))
        invalid('schema transaction read must finish synchronously');
      check();
      if (readWitness() !== proof.witness) invalid('schema transaction read authority changed');
      check();
      return result;
    } finally {
      // Never reuse transaction-authenticated pages after this call or a rollback.
      if (proof) {
        proof.state = 'expired';
        schemaTransactionReads.delete(proof);
      }
      stop?.();
    }
  }
  const runRead = <T>(
    fn: (pages: typeof tree, certificate?: IntakeTreeReadCertificate) => T,
    options: {
      sealTransaction?: boolean;
      privateCandidate?: PrivateEnvelopeCandidate;
      schemaTransaction?: boolean;
      fixedSchemaFields?: boolean;
    } = {},
  ): T =>
    withIntakeWork(db, 'warm', () => {
      if (activeFieldRead && !options.fixedSchemaFields) {
        activeFieldRead.poisoned = true;
        invalid('reentrant schema field snapshot read');
      }
      let certificate: IntakeTreeReadCertificate | undefined;
      try {
        const fixedMethods = options.fixedSchemaFields && managedDatabaseMethodEpoch(db);
        const checkFixedMethods = () => {
          if (options.fixedSchemaFields && activeFieldRead?.poisoned)
            invalid('poisoned schema snapshot');
          if (
            options.fixedSchemaFields &&
            (!fixedMethods || managedDatabaseMethodEpoch(db) !== fixedMethods)
          )
            invalid('schema field read methods changed');
        };
        checkFixedMethods();
        const token = options.schemaTransaction && db.isTransaction && currentTransactionToken(db);
        const methods = token && managedDatabaseMethodEpoch(db);
        if (options.fixedSchemaFields && db.isTransaction && (!token || !methods))
          invalid('schema field transaction authority');
        if (token && methods) {
          const result = readSchemaTransaction(fn, token, methods, options.fixedSchemaFields);
          checkFixedMethods();
          return result;
        }
        ready();
        checkFixedMethods();
        if (db.isTransaction) {
          readEpoch = {};
          if (!options.sealTransaction) return fn(() => tree(undefined, options.privateCandidate));
          // Raw transaction reads still need a whole-call lifecycle seal before
          // a callback-bearing preparation can expose its capability.
          const epoch = readEpoch,
            generation = registryFor(db).generation,
            token = currentTransactionToken(db),
            witness = readWitness();
          const check = () => {
            if (
              !db.isTransaction ||
              currentTransactionToken(db) !== token ||
              readEpoch !== epoch ||
              registryFor(db).generation !== generation
            )
              invalid('collection preparation authority changed');
          };
          const result = fn(() => tree(undefined, options.privateCandidate));
          check();
          if (readWitness() !== witness) invalid('collection preparation authority changed');
          check();
          return result;
        }
        const registry = registryFor(db);
        certificate = {
          witness: readWitness(),
          registry: registry.generation,
          epoch: readEpoch,
          state: 'active',
        };
        const proof = certificate;
        const check = () => {
          checkFixedMethods();
          if (
            db.isTransaction ||
            proof.epoch !== readEpoch ||
            proof.registry !== registryFor(db).generation ||
            proof.state !== 'active'
          ) {
            proof.state = 'expired';
            invalid('collection read authority changed');
          }
        };
        const result = fn(
          () => tree({ certificate: proof, check }, options.privateCandidate),
          proof,
        );
        // Internal readers return only detached DTOs, buffers and opaque refs.
        if (result && typeof result === 'object' && ('then' in result || 'next' in result))
          invalid('collection read must finish synchronously');
        check();
        if (readWitness() !== proof.witness) invalid('collection read authority changed');
        check();
        proof.state = 'sealed';
        return result;
      } catch (error) {
        if (certificate) certificate.state = 'expired';
        readEpoch = {};
        if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
        owner.invalidate();
        throw error;
      }
    });
  function selected(certificate?: IntakeTreeReadCertificate): ViewData {
    const raw = get(headKey);
    const generation = certificate?.witness ?? readWitness(),
      registry = registryFor(db);
    // Fixed schema reads and bounded preparation pass a private certificate.
    // Reuse the entry snapshot, not a new mid-read baseline. runRead must still
    // match it after the final physical HEAD check before returning any result.
    if (
      certificate &&
      (certificate.state !== 'active' ||
        certificate.epoch !== readEpoch ||
        certificate.registry !== registry.generation ||
        (db.isTransaction && !schemaTransactionReads.has(certificate)))
    )
      invalid('collection read authority changed');
    // total_changes does not advance on ROLLBACK. Never retain a selection
    // authenticated inside a transaction: a savepoint rollback may restore
    // different bytes without changing the head or the generation stamp.
    const reusable = !db.isTransaction;
    if (!reusable) validatedSelection = undefined;
    // Root authentication is reusable only while this exact SQLite projection
    // stays unchanged. Local writes (including rolled-back writes), external
    // commits, schema changes and authority-cache invalidation all break it.
    // Raw paths still authenticate every page. Read-only paths can borrow only
    // an exact generation-certified page and seal it after their final check.
    if (
      validatedSelection &&
      validatedSelection.raw === raw &&
      validatedSelection.generation === generation &&
      validatedSelection.registry === registry
    )
      return validatedSelection.value;
    const head = parseIntakeCollectionHead(raw, identity);
    if (!head && db.prepare('SELECT 1 FROM app_meta WHERE key GLOB ? LIMIT 1').get(prefix + '*'))
      invalid('missing collection head');
    if (head) {
      if (head.format === LOG_FORMAT)
        authenticateIntakeLogHeadRoots(head, identity, (hash) => get(prefix + 'node:' + hash));
      const check = certificate && schemaTransactionReads.get(certificate);
      const pages = check ? tree({ certificate: certificate!, check }) : tree();
      for (const root of [
        head.logical.root,
        head.builds,
        ...(head.format === COLLECTION_FORMAT ? [head.receipts, head.history] : []),
      ])
        if (root) pages.load(root);
    }
    const value = { prefix, raw: raw as string | undefined, head };
    if (reusable) validatedSelection = { raw, generation, registry, value };
    return value;
  }
  function viewData(view: IntakeCollectionView): ViewData {
    const value = registryFor(db).views.get(view);
    if (!value || value.prefix !== prefix) invalid('foreign or expired collection view');
    return value;
  }
  function tree(
    proof?: Parameters<typeof createIntakeTree>[3],
    privateCandidate?: PrivateEnvelopeCandidate,
  ) {
    return createIntakeTree(
      identity,
      (hash) => get(prefix + 'node:' + hash) ?? privateCandidate?.readNode(hash),
      registryFor(db).pages,
      proof,
    );
  }
  function readScope(
    view: IntakeCollectionView,
    area: IntakeCollectionArea,
    certificate?: IntakeTreeReadCertificate,
  ) {
    if (area !== 'logical' && area !== 'builds') invalid('collection area');
    const before = viewData(view),
      current = selected(certificate);
    const beforeRoot = area === 'logical' ? before.head?.logical : before.head?.builds;
    const currentRoot = area === 'logical' ? current.head?.logical : current.head?.builds;
    if (!same(beforeRoot, currentRoot)) invalid('stale collection view');
    return area === 'logical' ? (before.head?.logical.root ?? null) : (before.head?.builds ?? null);
  }
  const logEntries = () => {
    let entries = completeLogs.get(db);
    if (!entries) {
      entries = new Map();
      completeLogs.set(db, entries);
    }
    trimLogEntries(entries);
    return entries;
  };
  function trimLogEntries(entries: Map<string, CompleteLogState>) {
    // Only optional idle continuations expire. A registered preparation still
    // owns its frozen roster; a live transaction owns its acceptance candidate.
    const prepared = new Set(
      [...(registries.get(db)?.preparations.values() ?? [])]
        .filter((data) => data.logAppend)
        .map((data) => data.prefix),
    );
    const token = currentTransactionToken(db);
    const idle = [...entries].filter(
      ([key, entry]) =>
        !entry.close &&
        !entry.admissions?.size &&
        !prepared.has(key) &&
        !(token && entry.pending?.token === token),
    );
    while (idle.length > 64) {
      const [key, entry] = idle.shift()!;
      retireIntakeLogSnapshot(entry.snapshot);
      disposeIntakeLogSnapshot(entry.snapshot);
      entries.delete(key);
    }
  }
  function cacheLogEntry(entry: CompleteLogState) {
    if (entry.admissions?.size) return;
    try {
      cacheIntakeLogSnapshot(entry.snapshot);
      const entries = completeLogs.get(db);
      if (entries?.get(prefix) === entry) {
        entries.delete(prefix);
        entries.set(prefix, entry);
        trimLogEntries(entries);
      }
    } catch {
      try {
        disposeIntakeLogSnapshot(entry.snapshot);
      } catch {
        /* Accepted evidence survives derivative cleanup failure. */
      }
    }
  }
  function holdLogAdmission(entry: CompleteLogState, current: () => void): () => void {
    let releaseIndex: () => void;
    try {
      releaseIndex = holdIntakeLogSnapshot(entry.snapshot);
    } catch (error) {
      cacheLogEntry(entry);
      throw error;
    }
    const admissions = (entry.admissions ??= new Map()),
      token = {};
    admissions.set(token, current);
    entry.current = current;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      admissions.delete(token);
      releaseIndex();
      const remaining = [...admissions.values()].at(-1);
      if (remaining) entry.current = remaining;
      else cacheLogEntry(entry);
    };
  }
  function logAdmission(): LogAdmission {
    const entry = completeLogs.get(db)?.get(prefix);
    if (!entry) invalid('collection log requires asynchronous accepted admission');
    const assertCurrent = () => {
      ready();
      if (managedDatabaseMethodEpoch(db) !== entry.methods || get(headKey) !== entry.raw)
        invalid('collection log storage interval changed');
      if (db.isTransaction) {
        if (!readIntakeFrontierActiveUnwritten(db, entry.frontier))
          invalid('collection log transaction interval changed');
      } else {
        const interval = readIntakeFrontierAttempts(db, entry.frontier);
        if (!interval || interval.headSourceIds.includes(identity.intakeId))
          invalid('collection log storage provenance changed');
        entry.current();
      }
    };
    return {
      assertCurrent,
      lookupBaseOperation(base, operationId) {
        assertCurrent();
        const raw = tree().get(base.receipts, operationId);
        assertCurrent();
        return raw === undefined
          ? { kind: 'absent' }
          : {
              kind: 'receipt',
              receipt: parseIntakeCollectionReceipt(raw, identity, operationId),
              identity,
            };
      },
    };
  }
  function completeLog(head?: LogHead): IntakeLogSnapshot {
    const entry = completeLogs.get(db)?.get(prefix);
    if (!entry || (head && JSON.stringify(head) !== JSON.stringify(entry.head)))
      invalid('collection log requires asynchronous accepted admission');
    logAdmission().assertCurrent();
    return entry.snapshot;
  }
  function v4Base(head: IntakeCollectionHead): IntakeCollectionHeadV4 | undefined {
    return head.format === COLLECTION_FORMAT
      ? head
      : intakeLogBaseHead(head, identity, (hash) => get(prefix + 'node:' + hash));
  }
  function historyAt(head: IntakeCollectionHead, sequence: number, pages: ReturnType<typeof tree>) {
    if (head.format === LOG_FORMAT && sequence > head.baseSequence) {
      const event = readIntakeLogSequence(
        JSON.stringify(head),
        identity,
        (hash) => get(prefix + 'node:' + hash),
        sequence,
        { assertCurrent: ready },
      );
      return event.transition;
    }
    const base = v4Base(head);
    const raw = pages.get(base?.history ?? null, orderedKey(sequence));
    if (raw === undefined) invalid('missing historical envelope membership');
    return parseIntakeCollectionHistory(raw, identity);
  }
  function receipt(
    head: IntakeCollectionHead | undefined,
    operationId: string,
    requestDigest: string,
    pages: typeof tree = tree,
  ) {
    if (head?.format === LOG_FORMAT) {
      const pending = completeLogs.get(db)?.get(prefix)?.pending;
      if (pending) {
        const append = inspectIntakeLogAppend(pending.append);
        if (append.head === JSON.stringify(head)) {
          const event = readIntakeLogSequence(
            append.head,
            identity,
            (hash) => get(prefix + 'node:' + hash),
            head.storageSequence,
            { assertCurrent: ready },
          );
          if (event.receipt.result.operationId === operationId) {
            if (event.receipt.requestDigest !== requestDigest)
              invalid('collection operation replay conflict');
            return event.receipt.result;
          }
        }
      }
      const retained = replayIntakeLog(
        completeLog(head),
        operationId,
        requestDigest,
        logAdmission(),
      );
      return retained?.result;
    }
    const raw = pages().get(head?.receipts ?? null, operationId);
    if (raw === undefined) return undefined;
    const value = parseIntakeCollectionReceipt(raw, identity, operationId);
    if (value.requestDigest !== requestDigest) invalid('collection operation replay conflict');
    const result = value.result;
    if (result.storageSequence > head!.storageSequence) invalid('collection future receipt');
    return result;
  }
  function inspect(prepared: PreparedIntakeCollectionMutation): PreparedData {
    const value = registryFor(db).preparations.get(prepared);
    if (!value || value.prefix !== prefix) invalid('foreign or expired collection preparation');
    return value;
  }
  function discard(prepared: PreparedIntakeCollectionMutation, staged = false) {
    const registry = registryFor(db),
      data = registry.preparations.get(prepared);
    if (data) {
      if (data.logAppend && !staged) {
        try {
          discardIntakeLogAppend(data.logAppend);
        } catch {
          /* A sibling accepted publication may already revoke this reservation. */
        }
        if (data.logSnapshot) disposeIntakeLogSnapshot(data.logSnapshot);
        const entry = completeLogs.get(db)?.get(prefix);
        if (entry?.pending?.append === data.logAppend) entry.pending = undefined;
      }
      registry.preparedBytes -= data.size;
      registry.preparations.delete(prepared);
      if (data.privateEnvelope) registry.privateCandidates.delete(data.privateEnvelope.candidate);
      data.privateEnvelope?.candidate.close();
    }
  }
  function preparePrivateCandidate(
    candidate: PrivateEnvelopeCandidate,
    input: IntakeCollectionMutation,
  ): PreparedIntakeCollectionMutation {
    candidate.check();
    const binding = privateCandidates.get(candidate),
      operation = {
        operationId: input.operationId,
        requestDigest: input.requestDigest,
        domainVersion: input.domainVersion,
      };
    if (!binding || binding.operation !== JSON.stringify(operation))
      invalid('foreign or nested private envelope preparation');
    const changes = input.changes;
    candidate.check();
    const prepared = prepareCollection(
      api.openView(),
      { ...operation, changes },
      undefined,
      candidate,
    );
    const data = inspect(prepared);
    if (
      JSON.stringify({
        operationId: data.result.operationId,
        requestDigest: data.requestDigest,
        domainVersion: data.result.logical.domainVersion,
      }) !== binding.operation
    ) {
      discard(prepared);
      invalid('private envelope operation agreement');
    }
    return prepared;
  }
  function publicValue(
    raw: string,
    kind: IntakeCollectionDescriptor['kind'],
    certificate?: IntakeTreeReadCertificate,
  ): string | IntakeByteValue {
    if (kind === 'bytes') return raw;
    const value = parseIntakeStoredValue(raw);
    if (value.kind === 'inline') return value.text;
    if (value.kind === 'collection') invalid('nested collection requires checked reference reader');
    const capability = Object.freeze({
      kind: 'bytes',
      bytes: value.bytes,
      chunks: value.root?.count ?? 0,
    }) as IntakeByteValue;
    const registry = registryFor(db);
    registry.byteValues.set(capability, {
      prefix,
      logical: JSON.stringify(selected(certificate).head?.logical ?? null),
      root: value.root,
      bytes: value.bytes,
      count: value.root?.count ?? 0,
    });
    if (registry.byteValues.size > 128)
      registry.byteValues.delete(registry.byteValues.keys().next().value!);
    return capability;
  }
  function collectionValue(raw: string, pages: typeof tree = tree): IntakeCollectionValue {
    const value = parseIntakeStoredValue(raw);
    if (value.kind !== 'collection') invalid('expected nested collection reference');
    const current = selected(),
      capability = Object.freeze({
        kind: 'collection',
        collectionKind: value.descriptor.kind,
        count: value.descriptor.root?.count ?? 0,
        bytes: value.descriptor.bytes,
      }) as IntakeCollectionValue;
    if (value.descriptor.root) pages().load(value.descriptor.root);
    const values = registryFor(db).collectionValues;
    values.set(capability, {
      prefix,
      logical: JSON.stringify(current.head?.logical ?? null),
      descriptor: value.descriptor,
    });
    while (values.size > 128) values.delete(values.keys().next().value!);
    return capability;
  }
  function referenced(
    value: IntakeCollectionValue,
    privateCandidate?: PrivateEnvelopeCandidate,
  ): IntakeCollectionDescriptor {
    const values = registryFor(db).collectionValues,
      retained = values.get(value);
    if (
      !retained ||
      retained.prefix !== prefix ||
      retained.logical !== JSON.stringify(selected().head?.logical ?? null) ||
      (retained.privateCandidate && retained.privateCandidate !== privateCandidate)
    )
      invalid('foreign, stale or expired collection reference');
    values.delete(value);
    values.set(value, retained);
    return retained.descriptor;
  }
  function retainedBytes(
    value: IntakeByteValue,
    certificate?: IntakeTreeReadCertificate,
    consuming = false,
  ) {
    const retained = registryFor(db).byteValues.get(value);
    if (!retained || retained.prefix !== prefix)
      invalid(
        consuming ? 'foreign or expired byte value' : 'foreign, stale or expired byte reference',
      );
    if (
      retained.logical !== JSON.stringify(selected(certificate).head?.logical ?? null) ||
      value.kind !== 'bytes' ||
      value.bytes !== retained.bytes ||
      value.chunks !== retained.count ||
      (retained.root?.count ?? 0) !== retained.count
    )
      invalid('foreign, stale or expired byte reference');
    return retained;
  }
  function referencedBytes(
    value: IntakeByteValue,
    pages: ReturnType<typeof tree>,
    certificate?: IntakeTreeReadCertificate,
  ) {
    const retained = retainedBytes(value, certificate);
    if (retained.root) pages.load(retained.root);
    else if (retained.bytes !== 0) invalid('empty byte reference size');
    return {
      kind: 'bytes' as const,
      root: retained.root,
      bytes: retained.bytes,
    };
  }
  function checkedByteChunk(raw: string | undefined) {
    if (raw === undefined) invalid('missing byte chunk');
    if (raw.length > 5500) invalid('byte chunk representation');
    const chunk = Buffer.from(raw, 'base64');
    if (!chunk.length || chunk.length > 4096 || chunk.toString('base64') !== raw)
      invalid('byte chunk representation');
    return chunk;
  }
  /** No callback or iterator supplied by a caller can enter this private scope. */
  function resolveSchemaRead(
    view: IntakeCollectionView,
    mode: 'raw' | 'normalized',
    root: string,
    id: string,
    fieldSelection: 'first' | 'last',
    operation: { kind: 'header' } | { kind: 'field' | 'child'; name: string },
    area: IntakeCollectionArea,
    name: string,
  ): SchemaRecord | { target: SchemaTarget | undefined } | SchemaChildResolution {
    const admissions: {
      registry: Registry;
      schemaEpoch: object;
      epoch: object;
      witness: string;
      key: string;
      header: Readonly<SchemaRecord>;
      bytes: number;
    }[] = [];
    const result = runRead(
      (_readTree, certificate) => {
        if (
          (mode !== 'raw' && mode !== 'normalized') ||
          typeof root !== 'string' ||
          !/^[a-f0-9]{64}$/.test(root) ||
          typeof id !== 'string' ||
          !/^[a-f0-9]{64}$/.test(id) ||
          (fieldSelection !== 'first' && fieldSelection !== 'last') ||
          (operation.kind !== 'header' && typeof operation.name !== 'string')
        )
          invalid('schema resolve arguments');
        collectionName(name);
        const registry = registryFor(db);
        // This fixed, synchronous owner operation shares its lexical certificate.
        // No callback, iterator or result escapes it; final ready() and the
        // runRead seal still check physical HEAD and the exact SQL witness.
        // Transaction certificates are lexical only and expire without admission.
        const collection = certificate
          ? descriptor(_readTree().get(readScope(view, area, certificate), name))
          : schemaReadOperations.collection(view, area, name);
        if (!collection) invalid('missing selected envelope data');
        const current = viewData(view);
        const keyFor = (recordId: string) =>
          JSON.stringify([
            identity,
            prefix,
            area,
            name,
            current.head?.logical ?? null,
            ...(area === 'builds' ? [current.head?.builds ?? null] : []),
            collection,
            mode,
            root,
            fieldSelection,
            recordId,
          ]);
        if (!certificate || registry.schemaRecordWitness !== certificate.witness) {
          registry.schemaRecords.clear();
          registry.schemaRecordBytes = 0;
          registry.schemaRecordEpoch = {};
          registry.schemaRecordWitness = certificate?.witness;
        }
        const schemaEpoch = registry.schemaRecordEpoch;
        const read = (key: string) =>
          certificate
            ? (() => {
                const raw = _readTree().get(collection.root, key);
                if (raw !== undefined) recordIntakeWork('collectionItemsRead');
                return raw === undefined
                  ? undefined
                  : publicValue(raw, collection.kind, certificate);
              })()
            : schemaReadOperations.get(view, area, name, key);
        // Large lexical names remain streamed through the checked byte reader.
        // The iterator is private and completely consumed before this scope seals.
        function* chunks(key: string): Generator<string> {
          const value = read(key);
          if (value === undefined)
            throw Error('Intake collection envelope: missing exact lexical cell');
          if (typeof value === 'string') {
            for (let at = 0; at < value.length;) {
              let end = Math.min(at + 1024, value.length);
              if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
              yield value.slice(at, end);
              at = end;
            }
            return;
          }
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let after: string | undefined,
            count = 0;
          do {
            const page = certificate
              ? readByteRange(_readTree(), value, { after, items: 64, bytes: 4096 }, certificate)
              : schemaReadOperations.readBytes(value, { after, items: 64, bytes: 4096 });
            for (const chunk of page.chunks) {
              count += chunk.length;
              const decoded = decoder.decode(chunk, { stream: true });
              if (decoded) yield decoded;
            }
            if (page.complete) break;
            if (!page.after || page.after === after)
              throw Error('Intake collection envelope: byte cursor did not advance');
            after = page.after;
          } while (true);
          const tail = decoder.decode();
          if (tail) yield tail;
          if (count !== value.bytes)
            throw Error('Intake collection envelope: lexical cell byte count');
        }
        const text = (key: string): string => {
          const value = read(key);
          if (typeof value === 'string') {
            if (Buffer.byteLength(value) > 8192)
              throw Error('Intake collection envelope: field exceeds bounded header');
            return value;
          }
          if (!value || value.bytes > 8192)
            throw Error('Intake collection envelope: missing or fragmented schema header');
          let result = '';
          for (const chunk of chunks(key)) result += chunk;
          return result;
        };
        const resolveHeader = (recordId: string): Readonly<SchemaRecord> => {
          const key = keyFor(recordId),
            cached = certificate && registry.schemaRecords.get(key),
            reusable =
              cached &&
              cached.epoch === certificate!.epoch &&
              cached.witness === certificate!.witness;
          if (cached && !reusable) {
            registry.schemaRecordBytes -= cached.bytes;
            registry.schemaRecords.delete(key);
          }
          const header = reusable
            ? cached.header
            : Object.freeze({
                ...resolveSchemaMetadata(text, () => root, recordId, fieldSelection),
              });
          if (reusable) {
            registry.schemaRecords.delete(key);
            registry.schemaRecords.set(key, cached);
          } else if (certificate) {
            const bytes =
              Buffer.byteLength(JSON.stringify({ key, header, witness: certificate.witness })) +
              256;
            admissions.push({
              registry,
              schemaEpoch,
              epoch: certificate.epoch,
              witness: certificate.witness,
              key,
              header,
              bytes,
            });
          }
          return header;
        };
        const header = resolveHeader(id);
        let value: SchemaRecord | { target: SchemaTarget | undefined } | SchemaChildResolution;
        if (operation.kind === 'header') value = { ...header };
        else {
          const target = resolveSchemaFieldTarget(
            header,
            id,
            operation.name,
            fieldSelection,
            read,
            text,
            chunks,
          );
          value =
            operation.kind === 'field'
              ? { target }
              : !target
                ? { kind: 'missing' }
                : target.type === 'cell'
                  ? { kind: 'cell' }
                  : { kind: 'record', id: target.id, header: { ...resolveHeader(target.id) } };
        }
        ready();
        return value;
      },
      { schemaTransaction: true, fixedSchemaFields: operation.kind === 'child' },
    );
    // Admission follows the outer runRead final exact witness, never an optimistic result.
    for (const admission of admissions) {
      if (
        !db.isTransaction &&
        registryFor(db) === admission.registry &&
        admission.registry.schemaRecordEpoch === admission.schemaEpoch &&
        readEpoch === admission.epoch &&
        admission.bytes <= 256 * 1024
      ) {
        const { registry, key, header, witness, epoch, bytes } = admission;
        const previous = registry.schemaRecords.get(key);
        if (previous) registry.schemaRecordBytes -= previous.bytes;
        registry.schemaRecords.set(key, { header, witness, epoch, bytes });
        registry.schemaRecordBytes += bytes;
        while (registry.schemaRecords.size > 32 || registry.schemaRecordBytes > 256 * 1024) {
          const oldest = registry.schemaRecords.keys().next().value!;
          registry.schemaRecordBytes -= registry.schemaRecords.get(oldest)!.bytes;
          registry.schemaRecords.delete(oldest);
        }
      }
    }
    return result;
  }
  const readCollectionItem = (
    pages: ReturnType<typeof tree>,
    source: IntakeCollectionDescriptor | undefined,
    key: string,
    certificate?: IntakeTreeReadCertificate,
  ): string | IntakeByteValue | undefined => {
    const raw = pages.get(source?.root ?? null, key);
    if (raw !== undefined) recordIntakeWork('collectionItemsRead');
    return raw === undefined ? undefined : publicValue(raw, source!.kind, certificate);
  };
  const readCollectionRange = (
    pages: ReturnType<typeof tree>,
    source: IntakeCollectionDescriptor | undefined,
    options: { after?: string; prefix?: string; items: number; bytes: number },
    certificate?: IntakeTreeReadCertificate,
  ) => {
    integer(options.items, 1);
    integer(options.bytes, 1);
    if (options.items > 100 || options.bytes > 256 * 1024) invalid('collection range budget');
    // A scoped range retains the existing exclusive cursor.
    const keyPrefix = options.prefix,
      after = options.after;
    if (keyPrefix !== undefined) {
      intakeTreeKey(keyPrefix);
      if (typeof after !== 'string' || !after.startsWith(keyPrefix))
        invalid('collection range cursor outside prefix');
    }
    const items: Array<{ key: string; value: string | IntakeByteValue }> = [];
    let bytes = 0,
      complete = true;
    for (const item of pages.entries(source?.root ?? null, after)) {
      if (keyPrefix !== undefined && !item.key.startsWith(keyPrefix)) break;
      const size = Buffer.byteLength(item.key) + Buffer.byteLength(item.value);
      if (items.length === options.items || bytes + size > options.bytes) {
        complete = false;
        break;
      }
      items.push({ key: item.key, value: publicValue(item.value, source!.kind, certificate) });
      bytes += size;
      recordIntakeWork('collectionItemsRead');
    }
    if (!complete && !items.length) invalid('collection range item exceeds byte budget');
    return {
      items,
      bytes,
      complete,
      after: complete ? null : items.at(-1)!.key,
      count: source?.root?.count ?? 0,
    };
  };
  const readByteRange = (
    pages: ReturnType<typeof tree>,
    value: IntakeByteValue,
    options: { after?: string; items: number; bytes: number },
    certificate?: IntakeTreeReadCertificate,
  ) => {
    const retained = retainedBytes(value, certificate, true);
    integer(options.items, 1);
    integer(options.bytes, 1);
    if (options.items > 64 || options.bytes > 256 * 1024) invalid('byte range budget');
    const chunks: Buffer[] = [];
    let bytes = 0,
      after: string | null = null,
      complete = true;
    for (const item of pages.entries(retained.root, options.after)) {
      const chunk = Buffer.from(item.value, 'base64');
      if (!chunk.length || chunk.length > 4096 || chunk.toString('base64') !== item.value)
        invalid('byte chunk representation');
      recordIntakeWork('collectionByteChunkReads');
      recordIntakeWork('collectionByteChunkReadBytes', chunk.length);
      if (chunks.length === options.items || bytes + chunk.length > options.bytes) {
        complete = false;
        break;
      }
      chunks.push(chunk);
      bytes += chunk.length;
      after = item.key;
    }
    if (!complete && !chunks.length) invalid('byte range item exceeds budget');
    return { chunks, bytes, complete, after: complete ? null : after };
  };
  function prepareCollection(
    view: IntakeCollectionView,
    input: IntakeCollectionMutation,
    originalRead?: IntakeLegacyBridgeReadWitness,
    privateCandidate?: PrivateEnvelopeCandidate,
  ): PreparedIntakeCollectionMutation {
    const deferredLegacy = deferredLegacyInput === input;
    if (deferredLegacy) deferredLegacyInput = undefined;
    // Do not inherit a caller's optimistic read, even if an input getter
    // starts this preparation from another read. Existing page-cache bounds
    // apply; SQL transactions retain the uncached, checked fallback.
    readEpoch = {};
    if (!db.isTransaction) ensureIntakeFrontierObserver(db);
    const prepareCurrent = (readTree: typeof tree, certificate?: IntakeTreeReadCertificate) => {
      uuid(input.operationId);
      if (!/^[a-f0-9]{64}$/.test(input.requestDigest)) invalid('collection request digest');
      integer(input.domainVersion);
      if (!Array.isArray(input.changes) || input.changes.length > 64)
        invalid('collection change budget');
      const before = viewData(view),
        current = before.legacy ? { raw: get(headKey), head: undefined } : selected(certificate);
      if (before.raw !== current.raw) invalid('stale collection preparation basis; reopen view');
      if (receipt(current.head, input.operationId, input.requestDigest, readTree))
        invalid('collection operation already retained; use replay');
      const pages = readTree();
      let logical = before.head?.logical.root ?? null,
        builds = before.head?.builds ?? null;
      const changedCollections = new Map<
        string,
        { area: IntakeCollectionArea; name: string; keys: Set<string> | null }
      >();
      for (let changeIndex = 0; changeIndex < input.changes.length; changeIndex++) {
        const change = input.changes[changeIndex]!;
        if (privateCandidate?.hasFinalBuilds() && change.area === 'builds') continue;
        if (change.area !== 'logical' && change.area !== 'builds') invalid('collection area');
        collectionName(change.collection);
        let root = change.area === 'logical' ? logical : builds;
        const old = descriptor(pages.get(root, change.collection));
        if (change.op === 'put') {
          if (old && old.kind !== 'map') invalid('collection kind mismatch');
          const entries = [{ key: change.key, value: inlineValue(change.value) }];
          // Only adjacent inline puts to this exact collection commute. Flush
          // before deletion, adoption, byte references or another collection.
          while (changeIndex + 1 < input.changes.length) {
            const next = input.changes[changeIndex + 1]!;
            if (
              next.op !== 'put' ||
              next.area !== change.area ||
              next.collection !== change.collection
            )
              break;
            entries.push({ key: next.key, value: inlineValue(next.value) });
            changeIndex++;
          }
          const batch = pages.putMany(old?.root ?? null, entries);
          let byteCount = old?.bytes ?? 0;
          for (const [key, value] of new Map(entries.map((entry) => [entry.key, entry.value])))
            byteCount += valueBytes(value) - valueBytes(batch.previous.get(key));
          integer(byteCount);
          root = pages.put(
            root,
            change.collection,
            JSON.stringify({ kind: 'map', root: batch.root, bytes: byteCount }),
          );
          if (change.area === 'logical') logical = root;
          else builds = root;
          const changeKey = change.area + ':' + change.collection;
          const remembered = changedCollections.get(changeKey);
          if (remembered) for (const entry of entries) remembered.keys?.add(entry.key);
          else
            changedCollections.set(changeKey, {
              area: change.area,
              name: change.collection,
              keys: new Set(entries.map((entry) => entry.key)),
            });
          continue;
        }
        if (change.op === 'adoptBytesReferenced') {
          const adopted = referencedBytes(change.value, pages, certificate);
          root = pages.put(root, change.collection, JSON.stringify(adopted));
          if (change.area === 'logical') logical = root;
          else builds = root;
          changedCollections.set(change.area + ':' + change.collection, {
            area: change.area,
            name: change.collection,
            keys: null,
          });
          continue;
        }
        if (change.op === 'adoptCollection' || change.op === 'adoptReferenced') {
          if (
            change.op === 'adoptCollection' &&
            change.fromArea !== 'logical' &&
            change.fromArea !== 'builds'
          )
            invalid('adoption area');
          if (change.op === 'adoptCollection') collectionName(change.fromCollection);
          const source =
            change.op === 'adoptReferenced'
              ? JSON.stringify(referenced(change.value, privateCandidate))
              : privateCandidate && change.fromArea === 'builds'
                ? JSON.stringify(privateCandidate.collection(change.fromCollection))
                : pages.get(
                    change.fromArea === 'logical' ? logical : builds,
                    change.fromCollection,
                  );
          if (source === undefined) invalid('missing adopted collection');
          descriptor(source);
          root = pages.put(root, change.collection, source);
          if (change.area === 'logical') logical = root;
          else builds = root;
          changedCollections.set(change.area + ':' + change.collection, {
            area: change.area,
            name: change.collection,
            keys: null,
          });
          continue;
        }
        const kind = ['put', 'delete', 'putBytes', 'putCollection'].includes(change.op)
          ? 'map'
          : ['appendBytes', 'replaceBytes', 'truncateBytes'].includes(change.op)
            ? 'bytes'
            : 'sequence';
        if (old && old.kind !== kind) invalid('collection kind mismatch');
        let values = old?.root ?? null,
          byteCount = old?.bytes ?? 0;
        let changedKey: string;
        if (change.op === 'delete' || change.op === 'putBytes' || change.op === 'putCollection') {
          changedKey = change.key;
          const prior = pages.get(values, change.key);
          let value: string | null = null;
          if (change.op === 'putBytes') {
            if (change.fromArea !== 'logical' && change.fromArea !== 'builds')
              invalid('byte attachment area');
            collectionName(change.fromCollection);
            const source = descriptor(
              pages.get(change.fromArea === 'logical' ? logical : builds, change.fromCollection),
            );
            if (!source || source.kind !== 'bytes') invalid('byte attachment source');
            value = JSON.stringify({
              kind: 'bytes',
              root: source.root,
              bytes: source.bytes,
            });
          }
          if (change.op === 'putCollection') {
            if (change.fromArea !== 'logical' && change.fromArea !== 'builds')
              invalid('collection reference area');
            collectionName(change.fromCollection);
            const source = descriptor(
              pages.get(change.fromArea === 'logical' ? logical : builds, change.fromCollection),
            );
            if (!source) invalid('missing collection reference source');
            value = JSON.stringify({
              kind: 'collection',
              descriptor: source,
            });
          }
          byteCount += valueBytes(value ?? undefined) - valueBytes(prior);
          values = pages.put(values, change.key, value);
        } else if (change.op === 'append' || change.op === 'replace') {
          const index = change.op === 'append' ? (values?.count ?? 0) : change.index;
          integer(index);
          if (change.op === 'replace' && index >= (values?.count ?? 0)) invalid('sequence index');
          const key = orderedKey(index),
            prior = pages.get(values, key);
          changedKey = key;
          byteCount += Buffer.byteLength(change.value) - valueBytes(prior);
          values = pages.put(values, key, inlineValue(change.value));
        } else if (change.op === 'replaceBytes' || change.op === 'truncateBytes') {
          const count = values?.count ?? 0;
          const index = change.op === 'replaceBytes' ? change.index : count - 1;
          if (change.op === 'truncateBytes') {
            integer(change.length);
            if (!count || change.length !== count - 1)
              invalid('byte truncation must remove one suffix chunk');
          } else {
            integer(index);
            if (index >= count) invalid('byte replacement index');
            if (
              !(change.bytes instanceof Uint8Array) ||
              !change.bytes.length ||
              change.bytes.length > 4096
            )
              invalid('byte chunk budget');
          }
          changedKey = orderedKey(index);
          const prior = checkedByteChunk(pages.get(values, changedKey));
          if (change.op === 'replaceBytes') {
            const chunk = Buffer.from(change.bytes);
            values = pages.put(values, changedKey, chunk.toString('base64'));
            byteCount += chunk.length - prior.length;
          } else {
            values = pages.put(values, changedKey, null);
            byteCount -= prior.length;
            if (!values && byteCount !== 0) invalid('empty byte collection size');
          }
        } else if (change.op === 'appendBytes') {
          if (
            !(change.bytes instanceof Uint8Array) ||
            !change.bytes.length ||
            change.bytes.length > 4096
          )
            invalid('byte chunk budget');
          const chunk = Buffer.from(change.bytes);
          changedKey = orderedKey(values?.count ?? 0);
          values = pages.put(values, changedKey, chunk.toString('base64'));
          byteCount += chunk.length;
        } else invalid('collection operation');
        integer(byteCount);
        if (change.op === 'delete' && !old) continue;
        root = pages.put(
          root,
          change.collection,
          JSON.stringify({ kind, root: values, bytes: byteCount }),
        );
        if (change.area === 'logical') logical = root;
        else builds = root;
        const changeKey = change.area + ':' + change.collection;
        const remembered = changedCollections.get(changeKey);
        if (remembered) remembered.keys?.add(changedKey);
        else
          changedCollections.set(changeKey, {
            area: change.area,
            name: change.collection,
            keys: new Set([changedKey]),
          });
      }
      // A bounded remove/reinsert request can rebalance pages yet leave the
      // exact map unchanged. Check only addressed keys and retain its prior
      // root; structural hashes alone do not define a semantic no-op.
      for (const item of changedCollections.values()) {
        if (!item.keys) continue; // adoption deliberately selects a new scope
        const priorRoot =
          item.area === 'logical'
            ? (before.head?.logical.root ?? null)
            : (before.head?.builds ?? null);
        const currentRoot = item.area === 'logical' ? logical : builds;
        const oldRaw = pages.get(priorRoot, item.name),
          oldValue = descriptor(oldRaw);
        const currentValue = descriptor(pages.get(currentRoot, item.name));
        if (
          !oldValue ||
          !currentValue ||
          oldValue.kind !== currentValue.kind ||
          oldValue.bytes !== currentValue.bytes ||
          (oldValue.root?.count ?? 0) !== (currentValue.root?.count ?? 0)
        )
          continue;
        if (
          [...item.keys].every(
            (key) => pages.get(oldValue.root, key) === pages.get(currentValue.root, key),
          )
        ) {
          const restored = pages.put(currentRoot, item.name, oldRaw!);
          if (item.area === 'logical') logical = restored;
          else builds = restored;
        }
      }
      if (privateCandidate?.hasFinalBuilds()) builds = privateCandidate.finalBuildsRoot();
      const priorVersion = before.head?.logical.domainVersion ?? 0;
      if (
        input.domainVersion < priorVersion ||
        (same(logical, before.head?.logical.root ?? null) && input.domainVersion !== priorVersion)
      )
        invalid('collection domain version');
      const sequence = (before.head?.storageSequence ?? 0) + 1;
      integer(sequence, 1);
      const result: IntakeCollectionResult = {
        format: 'health-intake-state-result-v4',
        intakeId: identity.intakeId,
        operationId: input.operationId,
        storageSequence: sequence,
        logical: { root: logical, domainVersion: input.domainVersion },
        changed: before.legacy ? false : !same(logical, before.head?.logical.root ?? null),
      };
      let receipts: IntakeTreeRoot = null,
        history: IntakeTreeRoot = null;
      let head: IntakeCollectionHead,
        logAppend: IntakeLogAppend | undefined,
        logSnapshot: IntakeLogSnapshot | undefined;
      const logWrites: Array<{ key: string; value: string }> = [];
      if (before.legacy) {
        const base = before.head?.format === COLLECTION_FORMAT ? before.head : undefined;
        receipts = pages.put(
          base?.receipts ?? null,
          input.operationId,
          JSON.stringify({
            format: 'health-intake-state-receipt-v4',
            requestDigest: input.requestDigest,
            result,
          }),
        );
        history = pages.put(
          base?.history ?? null,
          orderedKey(sequence),
          JSON.stringify({
            format: 'health-intake-state-history-v4',
            operationId: input.operationId,
            previous: { format: 'health-intake-legacy-v3', head: before.legacy },
            logical: result.logical,
            builds,
          }),
        );
        head = {
          format: COLLECTION_FORMAT,
          identity,
          storageSequence: sequence,
          logical: result.logical,
          receipts,
          history,
          builds,
        };
      } else {
        let entry = completeLogs.get(db)?.get(prefix);
        if (!entry && before.head === undefined) {
          const initial = initializeIntakeLog(identity),
            frontier = captureIntakeFrontierAttempts(db);
          if (!frontier) invalid('collection log initial storage provenance unavailable');
          const current = () => ready();
          const steps = rebuildIntakeLogSnapshotSteps(
            initial.head,
            identity,
            (hash) => get(prefix + 'node:' + hash),
            {
              assertCurrent: current,
            },
          );
          const next = steps.next();
          if (!next.done) {
            steps.return(undefined as never);
            invalid('empty log verifier yielded');
          }
          entry = {
            raw: undefined,
            snapshot: next.value,
            head: JSON.parse(initial.head) as LogHead,
            frontier,
            methods: managedDatabaseMethodEpoch(db),
            current,
          };
          logEntries().set(prefix, entry);
        }
        if (!entry || entry.raw !== before.raw)
          invalid('collection log requires asynchronous accepted admission');
        if (before.head?.format === COLLECTION_FORMAT) {
          for (const row of initializeIntakeLog(identity, before.raw).writes)
            logWrites.push({ key: prefix + 'node:' + row.hash, value: row.raw });
        }
        while (registryFor(db).preparations.size >= 8)
          discard(registryFor(db).preparations.keys().next().value!);
        logSnapshot = forkIntakeLogSnapshot(completeLog(), logAdmission());
        logAppend = prepareIntakeLogAppend(
          logSnapshot,
          {
            receipt: {
              format: 'health-intake-state-receipt-v4',
              requestDigest: input.requestDigest,
              result,
            },
            transition: {
              format: 'health-intake-state-log-transition-v1',
              operationId: input.operationId,
              previous: entry.head,
              logical: result.logical,
              builds,
            },
          },
          logAdmission(),
        );
        const log = inspectIntakeLogAppend(logAppend);
        for (const row of log.writes)
          logWrites.push({ key: prefix + 'node:' + row.hash, value: row.raw });
        head = JSON.parse(log.head) as LogHead;
        entry.pending = { append: logAppend, before: before.raw };
      }
      const after = JSON.stringify(head);
      parseIntakeCollectionHead(after, identity);
      if (Buffer.byteLength(after) > HEAD_BYTES) invalid('collection head bytes');
      const roots = [logical, builds, receipts, history];
      for (const item of changedCollections.values()) {
        const itemRoot = descriptor(
          pages.get(item.area === 'logical' ? logical : builds, item.name),
        )?.root;
        if (itemRoot) roots.push(itemRoot);
      }
      const embedded = (raw: string): IntakeTreeRoot[] => {
        // Only codec-owned descriptor/value wrappers contain references.
        // Inline user text and base64 chunks cannot introduce graph edges.
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          return [];
        }
        if (
          !value ||
          typeof value !== 'object' ||
          !['map', 'sequence', 'bytes', 'collection'].includes(String(Reflect.get(value, 'kind')))
        )
          return [];
        const root: unknown =
          Reflect.get(value, 'kind') === 'collection'
            ? (
                parseIntakeStoredValue(raw) as {
                  kind: 'collection';
                  descriptor: IntakeCollectionDescriptor;
                }
              ).descriptor.root
            : Reflect.get(value, 'root');
        intakeTreeRef(root);
        return [root];
      };
      const writes = [...pages.writes(roots, embedded)].map(({ hash, raw, ref }) => {
        decodeIntakeTreeNode(raw, ref, identity);
        return { key: prefix + 'node:' + hash, value: raw };
      });
      writes.push(...logWrites);
      writes.push({ key: headKey, value: after });
      if (writes.length > 4096) invalid('collection prepared write count');
      const size = writes.reduce(
        (sum, row) => sum + Buffer.byteLength(row.key) + Buffer.byteLength(row.value),
        0,
      );
      if (size > 8 * 1024 * 1024) invalid('collection selected preparation bytes');
      const prepared = Object.freeze({}) as PreparedIntakeCollectionMutation,
        registry = registryFor(db);
      while (
        registry.preparations.size &&
        (registry.preparations.size >= 8 || registry.preparedBytes + size > 16 * 1024 * 1024)
      )
        discard(registry.preparations.keys().next().value!);
      registry.preparedBytes += size;
      const legacyBridge = before.legacy
        ? deferredLegacy
          ? undefined
          : prepareIntakeLegacyBridgeProof(
              db,
              {
                identity,
                beforeHead: before.raw!,
                afterHead: after,
                writes,
              },
              originalRead,
            )
        : undefined;
      registry.preparations.set(prepared, {
        prefix,
        before: before.raw,
        after,
        writes,
        result,
        requestDigest: input.requestDigest,
        size,
        legacyBridge,
        logAppend,
        logSnapshot,
      });
      // The candidate does not escape until its physical authority and
      // closing SQL/registry witness are checked. runRead invalidates every
      // provisional capability if this seal fails.
      ready();
      return prepared;
    };
    return runRead(prepareCurrent, { sealTransaction: true, privateCandidate });
  }
  const api = {
    /** Async owning preflight around the existing synchronous preparation core. */
    async prepareAsync(
      view: IntakeCollectionView,
      input: IntakeCollectionMutation,
      assertRunning: () => void = () => {},
    ): Promise<PreparedIntakeCollectionMutation> {
      const operation = currentClinicalOperation(db);
      const current = () => {
        if (operation) assertClinicalOperation(db, operation);
        assertRunning();
      };
      await api.admitCurrentLogAsync(current);
      try {
        current();
        return api.prepare(view, input);
      } finally {
        api.releaseLogAdmission();
      }
    },
    releaseLogAdmission(): void {
      const entry = completeLogs.get(db)?.get(prefix),
        close = entry?.close;
      if (entry) entry.close = undefined;
      try {
        close?.();
      } catch {
        /* Accepted evidence is independent of derivative lease cleanup. */
      }
      if (entry) cacheLogEntry(entry);
    },
    /** Generic collection preflight for legacy build checkpoints. Existing
     * accepted source/build guards remain required; referenced descriptors also
     * request the genuine source/HEAD pair from the original record owner. */
    async admitCurrentLogAsync(assertRunning: () => void = () => {}): Promise<void> {
      assertRunning();
      ready();
      if (db.isTransaction) invalid('collection log admission requires no transaction');
      ensureIntakeFrontierObserver(db);
      if (typeof get(headKey) !== 'string') return;
      const old = completeLogs.get(db)?.get(prefix);
      try {
        old?.close?.();
      } catch {
        /* The previous owned publication may have advanced the lease. */
      }
      if (old) old.close = undefined;
      const original = captureIntakeLegacyBridgeReadWitness(db, identity.intakeId);
      let accepted: RecordAcceptedIntakeHeadRead | undefined;
      let releaseResource: (() => void) | undefined;
      const current = () => {
        assertRunning();
        assertIntakeLegacyBridgeReadWitnessForSource(db, original, identity.intakeId);
      };
      const close = () => {
        try {
          if (accepted) closeRecordAcceptedIntakeHeadRead(accepted);
        } finally {
          try {
            disposeIntakeLegacyBridgeReadWitness(original);
          } finally {
            releaseResource?.();
          }
        }
      };
      try {
        current();
        const selectedSource = db
          .prepare(
            'SELECT substr(details_json,1,16385) AS value, length(CAST(details_json AS BLOB)) AS bytes FROM main.source_files WHERE id=?',
          )
          .get(identity.intakeId);
        let pair: { identity: IntakeStateIdentity; sourceVersionId: string } | undefined;
        if (typeof selectedSource?.value === 'string' && Number(selectedSource.bytes) <= 16384) {
          const source = JSON.parse(selectedSource.value) as {
            intakeAuthority?: { format?: unknown };
          };
          if (source.intakeAuthority?.format === 'health-intake-envelope-v3') {
            const version = db
              .prepare(
                "SELECT version_id FROM __record_current WHERE entity='source_files' AND record_id=?",
              )
              .get(JSON.stringify([identity.intakeId]));
            if (typeof version?.version_id !== 'string')
              invalid('collection log source pair version unavailable');
            pair = { identity, sourceVersionId: version.version_id };
          }
        }
        accepted = await captureRecordAcceptedIntakeHeadRead(db, identity, current, pair);
        releaseResource = await api.admitLogAsync(original, accepted, assertRunning);
        current();
        const entry = completeLogs.get(db)?.get(prefix);
        if (!entry) invalid('collection log admission unavailable');
        entry.close = close;
      } catch (error) {
        close();
        throw error;
      }
    },
    async admitLogAsync(
      originalRead: IntakeLegacyBridgeReadWitness,
      acceptedHead: RecordAcceptedIntakeHeadRead,
      assertRunning: () => void = () => {},
    ): Promise<() => void> {
      assertRunning();
      ready();
      if (db.isTransaction) invalid('collection log admission requires no transaction');
      ensureIntakeFrontierObserver(db);
      const raw = get(headKey);
      if (typeof raw !== 'string') return () => {};
      const head = parseIntakeCollectionHead(raw, identity)!;
      const current = () => {
        assertRunning();
        ready();
        assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
        assertRecordAcceptedIntakeHeadRead(db, acceptedHead, identity, raw);
        if (get(headKey) !== raw) invalid('collection log accepted head changed');
      };
      current();
      const frontier = captureIntakeFrontierAttempts(db);
      if (!frontier) invalid('collection log storage provenance unavailable');
      const prior = completeLogs.get(db)?.get(prefix);
      if (prior && prior.raw === raw && isIntakeLogSnapshotResident(prior.snapshot)) {
        const interval = readIntakeFrontierAttempts(db, prior.frontier);
        if (
          interval &&
          !interval.headSourceIds.includes(identity.intakeId) &&
          prior.methods === managedDatabaseMethodEpoch(db)
        ) {
          prior.frontier = frontier;
          const previousCurrent = prior.current;
          prior.current = current;
          try {
            logAdmission().assertCurrent();
            return holdLogAdmission(prior, current);
          } catch (error) {
            prior.current = previousCurrent;
            throw error;
          }
        }
      }
      if (prior?.pending?.publication) {
        try {
          const prepared = inspectIntakeLogAppend(prior.pending.append);
          if (prepared.head === raw) {
            const promoted = await confirmOwnedIntakeLogPublication(
              db,
              prior.pending.append,
              prior.pending.publication,
              prior.pending.before,
              { assertCurrent: current },
            );
            if (promoted?.snapshot) {
              const afterFrontier = captureIntakeFrontierAttempts(db);
              if (!afterFrontier) {
                disposeIntakeLogSnapshot(promoted.snapshot);
                invalid('collection log promotion interval');
              }
              const promotedEntry: CompleteLogState = {
                raw,
                snapshot: promoted.snapshot,
                head: head as LogHead,
                frontier: afterFrontier,
                methods: managedDatabaseMethodEpoch(db),
                current,
              };
              let installed = false;
              try {
                logEntries().set(prefix, promotedEntry);
                current();
                const release = holdLogAdmission(promotedEntry, current);
                installed = true;
                return release;
              } finally {
                if (!installed) {
                  if (completeLogs.get(db)?.get(prefix) === promotedEntry)
                    completeLogs.get(db)?.delete(prefix);
                  disposeIntakeLogSnapshot(promoted.snapshot);
                }
              }
            }
          }
        } catch {
          current(); /* Accepted evidence remains; rebuild only the derivative. */
        }
      }
      if (prior) {
        try {
          prior.close?.();
        } catch {
          /* Discarded derivative lease. */
        }
        completeLogs.get(db)?.delete(prefix);
        disposeIntakeLogSnapshot(prior.snapshot);
      }
      const steps = validateIntakeCollectionGraphSteps(
        identity,
        raw,
        (key, bytes) => {
          const value = owner.get(key, bytes);
          if (value !== undefined && typeof value !== 'string') invalid('collection graph row');
          return value;
        },
        current,
      );
      try {
        for (;;) {
          current();
          const next = steps.next();
          current();
          if (next.done) break;
          await setImmediate();
          current();
        }
      } finally {
        steps.return(undefined as never);
      }
      const initial = head.format === LOG_FORMAT ? undefined : initializeIntakeLog(identity, raw);
      const codecRaw = initial?.head ?? raw,
        codecHead = JSON.parse(codecRaw) as LogHead;
      const extra = new Map(initial?.writes.map((row) => [row.hash, row.raw]));
      const lookup = (hash: string) => extra.get(hash) ?? get(prefix + 'node:' + hash);
      const snapshot = await rebuildIntakeLogSnapshot(codecRaw, identity, lookup, {
        assertCurrent: current,
        lookupBaseOperation(base, operationId) {
          current();
          const found = tree().get(base.receipts, operationId);
          current();
          return found === undefined
            ? { kind: 'absent' }
            : {
                kind: 'receipt',
                identity,
                receipt: parseIntakeCollectionReceipt(found, identity, operationId),
              };
        },
      });
      let installed = false;
      try {
        current();
        const finalFrontier = captureIntakeFrontierAttempts(db);
        if (!finalFrontier) invalid('collection log admission changed');
        const entries = logEntries();
        entries.set(prefix, {
          raw,
          snapshot,
          head: codecHead,
          frontier: finalFrontier,
          methods: managedDatabaseMethodEpoch(db),
          current,
        });
        const release = holdLogAdmission(entries.get(prefix)!, current);
        installed = true;
        return release;
      } finally {
        if (!installed) disposeIntakeLogSnapshot(snapshot);
      }
    },
    prepareLegacyBridge(
      input: {
        operationId: string;
        requestDigest: string;
        domainVersion: number;
      },
      originalRead?: IntakeLegacyBridgeReadWitness,
    ): PreparedIntakeCollectionMutation {
      return run(() => {
        const raw = get(headKey);
        const legacy = parseIntakeHead(raw, identity, limits());
        if (!legacy) invalid('legacy bridge requires v3 authority');
        const view = Object.freeze({}) as IntakeCollectionView;
        registryFor(db).views.set(view, {
          prefix,
          raw: raw as string,
          head: undefined,
          legacy,
        });
        try {
          return api.prepare(
            view,
            {
              ...input,
              changes: [
                {
                  area: 'logical',
                  collection: 'envelope.control',
                  op: 'put',
                  key: 'representation',
                  value: INTAKE_LEGACY_BRIDGE_CONTROL,
                },
              ],
            },
            originalRead,
          );
        } finally {
          registryFor(db).views.delete(view);
        }
      });
    },
    async prepareLegacyBridgeAsync(
      input: {
        operationId: string;
        requestDigest: string;
        domainVersion: number;
      },
      originalRead: IntakeLegacyBridgeReadWitness,
      assertCurrent: () => void,
      selectedProof?: PreparedSelectedIntakeEnvelope,
    ): Promise<PreparedIntakeCollectionMutation> {
      assertCurrent();
      const raw = get(headKey);
      const legacy = parseIntakeHead(raw, identity, limits());
      if (!legacy) invalid('legacy bridge requires v3 authority');
      const view = Object.freeze({}) as IntakeCollectionView;
      const registry = registryFor(db);
      registry.views.set(view, { prefix, raw: raw as string, head: undefined, legacy });
      const mutation: IntakeCollectionMutation = {
        ...input,
        changes: [
          {
            area: 'logical',
            collection: 'envelope.control',
            op: 'put',
            key: 'representation',
            value: INTAKE_LEGACY_BRIDGE_CONTROL,
          },
        ],
      };
      let prepared: PreparedIntakeCollectionMutation;
      try {
        if (deferredLegacyInput) invalid('nested legacy bridge preparation');
        deferredLegacyInput = mutation;
        prepared = api.prepare(view, mutation, originalRead);
      } finally {
        deferredLegacyInput = undefined;
        registry.views.delete(view);
      }
      try {
        assertCurrent();
        const data = inspect(prepared);
        if (!data.before || data.legacyBridge) invalid('legacy bridge deferred preparation');
        data.legacyBridge = await prepareIntakeLegacyBridgeProofAsync(
          db,
          {
            identity,
            beforeHead: data.before,
            afterHead: data.after,
            writes: data.writes,
          },
          originalRead,
          selectedProof,
        );
        assertCurrent();
        return prepared;
      } catch (error) {
        discard(prepared);
        throw error;
      }
    },
    readLegacyMaterialization(): IntakeStateMaterialization {
      const head = run(() => {
        const current = selected();
        if (!current.head) invalid('missing legacy bridge');
        validateIntakeLegacyBridgeControl(identity, current.head, (hash) =>
          get(prefix + 'node:' + hash),
        );
        const raw = tree().get(v4Base(current.head)!.history, orderedKey(1));
        if (raw === undefined) invalid('missing retained legacy edge');
        const event = parseIntakeCollectionHistory(raw, identity);
        if (!event.previous || event.previous.format !== 'health-intake-legacy-v3')
          invalid('missing retained v3 authority');
        return event.previous.head;
      });
      return owner.legacyMaterialization(head);
    },
    async readLegacyMaterializationAsync(
      assertCurrent: () => void,
    ): Promise<IntakeStateMaterialization> {
      assertCurrent();
      const head = run(() => {
        const current = selected();
        if (!current.head) invalid('missing legacy bridge');
        validateIntakeLegacyBridgeControl(identity, current.head, (hash) =>
          get(prefix + 'node:' + hash),
        );
        const raw = tree().get(v4Base(current.head)!.history, orderedKey(1));
        if (raw === undefined) invalid('missing retained legacy edge');
        const event = parseIntakeCollectionHistory(raw, identity);
        if (!event.previous || event.previous.format !== 'health-intake-legacy-v3')
          invalid('missing retained v3 authority');
        return event.previous.head;
      });
      assertCurrent();
      const result = await owner.legacyMaterializationAsync(head, assertCurrent);
      assertCurrent();
      return result;
    },
    openView(expectedLogical?: string): IntakeCollectionView {
      if (
        expectedLogical !== undefined &&
        (typeof expectedLogical !== 'string' || Buffer.byteLength(expectedLogical) > HEAD_BYTES)
      )
        invalid('logical view binding');
      return runRead((_readTree, certificate) => {
        const view = Object.freeze({}) as IntakeCollectionView,
          registry = registryFor(db);
        const current = selected(expectedLogical === undefined ? undefined : certificate);
        if (
          expectedLogical !== undefined &&
          JSON.stringify(current.head?.logical) !== expectedLogical
        )
          invalid('stale logical envelope');
        registry.views.set(view, current);
        // A live reader owns this opaque view until it lets go. Weak keys avoid
        // retaining discarded handles without evicting another active reader.
        return view;
      });
    },
    acceptedCurrentEnvelopeSelection(
      originalRead: IntakeLegacyBridgeReadWitness,
      acceptedHead: RecordAcceptedIntakeHeadRead,
    ): { storageSequence: number; logicalRoot: IntakeTreeRef; domainVersion: number } {
      assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
      const result = runRead((_readTree, certificate) => {
        const selection = selected(certificate);
        if (typeof selection.raw !== 'string' || !selection.head)
          invalid('missing accepted current envelope head');
        assertRecordAcceptedIntakeHeadRead(db, acceptedHead, identity, selection.raw);
        const logicalRoot = selection.head.logical.root;
        if (!logicalRoot) invalid('missing accepted current envelope root');
        const current = {
          storageSequence: selection.head.storageSequence,
          logicalRoot,
          domainVersion: selection.head.logical.domainVersion,
        };
        assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
        assertRecordAcceptedIntakeHeadRead(db, acceptedHead, identity, selection.raw);
        return current;
      });
      assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
      return result;
    },
    historicalEnvelopeFieldCellKey(
      originalRead: IntakeLegacyBridgeReadWitness,
      acceptedHead: RecordAcceptedIntakeHeadRead,
      storageSequence: number,
      logicalRoot: IntakeTreeRoot,
      path:
        | 'intake.originalName'
        | 'intake.metadata.source'
        | 'intake.metadata.sourceProviderId'
        | 'intake.metadata.careArea'
        | 'intake.metadata.documentType'
        | 'intake.metadata.topics'
        | 'intake.acquisition.providerId'
        | 'intake.acquisition.provider'
        | 'intake.state'
        | 'intake.createdAt'
        | 'intake.parentSourceFileId',
    ): { key: string | null; mode: 'raw' | 'normalized' } {
      integer(storageSequence, 1);
      intakeTreeRef(logicalRoot);
      const fields = {
        'intake.originalName': ['intake', 'originalName'],
        'intake.metadata.source': ['intake', 'metadata', 'source'],
        'intake.metadata.sourceProviderId': ['intake', 'metadata', 'sourceProviderId'],
        'intake.metadata.careArea': ['intake', 'metadata', 'careArea'],
        'intake.metadata.documentType': ['intake', 'metadata', 'documentType'],
        'intake.metadata.topics': ['intake', 'metadata', 'topics'],
        'intake.acquisition.providerId': ['intake', 'acquisition', 'providerId'],
        'intake.acquisition.provider': ['intake', 'acquisition', 'provider'],
        'intake.state': ['intake', 'state'],
        'intake.createdAt': ['intake', 'createdAt'],
        'intake.parentSourceFileId': ['intake', 'parentSourceFileId'],
      } as const;
      if (!Object.hasOwn(fields, path)) invalid('historical envelope field path');
      assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
      const result = runRead((readTree, certificate) => {
        assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
        const selection = selected(certificate);
        if (typeof selection.raw !== 'string') invalid('missing accepted historical head');
        assertRecordAcceptedIntakeHeadRead(db, acceptedHead, identity, selection.raw);
        const head = selection.head;
        if (!head || storageSequence > head.storageSequence)
          invalid('historical envelope sequence');
        const pages = readTree();
        const history = historyAt(head, storageSequence, pages);
        if (!same(history.logical.root, logicalRoot)) invalid('historical envelope root differs');
        if (storageSequence === head.storageSequence && !same(history.logical, head.logical))
          invalid('historical envelope selected head differs');
        const control = descriptor(pages.get(logicalRoot, 'envelope.control'));
        const data = descriptor(pages.get(logicalRoot, 'envelope.data'));
        if (!control || control.kind !== 'map' || !data || data.kind !== 'map')
          invalid('missing historical envelope schema');
        const representation = pages.get(control.root, 'representation');
        if (representation === undefined) invalid('missing historical envelope representation');
        const storedControl = parseIntakeStoredValue(representation);
        if (storedControl.kind !== 'inline') invalid('fragmented historical envelope control');
        const schema = parseSchemaControl(storedControl.text);
        const read = (key: string) => {
          const raw = pages.get(data.root, key);
          return raw === undefined ? undefined : parseIntakeStoredValue(raw);
        };
        function* chunks(key: string): Generator<string> {
          const value = read(key);
          if (!value) invalid('missing historical schema cell');
          if (value.kind === 'inline') {
            for (let at = 0; at < value.text.length;) {
              let end = Math.min(at + 1024, value.text.length);
              if (end < value.text.length && /[\uD800-\uDBFF]/.test(value.text[end - 1]!)) end--;
              yield value.text.slice(at, end);
              at = end;
            }
            return;
          }
          if (value.kind !== 'bytes' || !value.root) invalid('historical schema byte cell');
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let bytes = 0;
          for (const item of pages.entries(value.root)) {
            const chunk = checkedByteChunk(item.value);
            bytes += chunk.length;
            const decoded = decoder.decode(chunk, { stream: true });
            if (decoded) yield decoded;
          }
          const tail = decoder.decode();
          if (tail) yield tail;
          if (bytes !== value.bytes) invalid('historical schema byte count');
        }
        const text = (key: string): string => {
          const value = read(key);
          if (
            !value ||
            value.kind === 'collection' ||
            (value.kind === 'inline' ? Buffer.byteLength(value.text) : value.bytes) > 8192
          )
            invalid('historical schema header bytes');
          return [...chunks(key)].join('');
        };
        let id = schema.root;
        const selectedFields: readonly string[] = fields[path];
        for (const [index, field] of selectedFields.entries()) {
          const header = resolveSchemaMetadata(text, () => schema.root, id, 'last');
          const target = resolveSchemaFieldTarget(
            header,
            id,
            field,
            'last',
            (key) => {
              const value = read(key);
              return value?.kind === 'inline' ? value.text : value;
            },
            text,
            chunks,
          );
          if (!target) {
            assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
            assertRecordAcceptedIntakeHeadRead(db, acceptedHead, identity, selection.raw);
            return { key: null, mode: schema.mode };
          }
          if (index === selectedFields.length - 1) {
            if (target.type !== 'cell') invalid('historical envelope field target');
            assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
            assertRecordAcceptedIntakeHeadRead(db, acceptedHead, identity, selection.raw);
            return { key: 'c:' + target.id, mode: schema.mode };
          }
          if (target.type !== 'record') invalid('historical envelope record target');
          id = target.id;
        }
        invalid('historical envelope field path');
      });
      assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
      return result;
    },
    historicalEnvelopeCellPart(
      originalRead: IntakeLegacyBridgeReadWitness,
      acceptedHead: RecordAcceptedIntakeHeadRead,
      storageSequence: number,
      logicalRoot: IntakeTreeRoot,
      key: string,
      after?: string,
    ):
      | { kind: 'inline'; text: string; bytes: number }
      | { kind: 'bytes'; chunk: Buffer; bytes: number; after: string | null; complete: boolean }
      | undefined {
      integer(storageSequence, 1);
      intakeTreeRef(logicalRoot);
      intakeTreeKey(key);
      if (after !== undefined) intakeTreeKey(after);
      assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
      const result = runRead((readTree, certificate) => {
        assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
        const selection = selected(certificate),
          rawHead = selection.raw;
        if (typeof rawHead !== 'string') invalid('missing accepted historical head');
        assertRecordAcceptedIntakeHeadRead(db, acceptedHead, identity, rawHead);
        const seal = () => {
          assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
          assertRecordAcceptedIntakeHeadRead(db, acceptedHead, identity, rawHead);
        };
        const head = selection.head;
        if (!head || storageSequence > head.storageSequence)
          invalid('historical envelope sequence');
        const pages = readTree();
        const history = historyAt(head, storageSequence, pages);
        if (!same(history.logical.root, logicalRoot)) invalid('historical envelope root differs');
        if (storageSequence === head.storageSequence && !same(history.logical, head.logical))
          invalid('historical envelope selected head differs');
        const data = descriptor(pages.get(logicalRoot, 'envelope.data'));
        if (!data || data.kind !== 'map') invalid('missing historical envelope data');
        const raw = pages.get(data.root, key);
        if (raw === undefined) {
          seal();
          return undefined;
        }
        const value = parseIntakeStoredValue(raw);
        if (value.kind === 'inline') {
          if (after !== undefined) invalid('inline historical envelope cursor');
          const bytes = Buffer.byteLength(value.text);
          if (bytes > INTAKE_TREE_VALUE_BYTES) invalid('historical envelope inline bytes');
          seal();
          return { kind: 'inline' as const, text: value.text, bytes };
        }
        if (value.kind !== 'bytes') invalid('historical envelope nested value');
        if (value.root === null) {
          if (value.bytes !== 0 || after !== undefined) invalid('historical envelope empty bytes');
          seal();
          return {
            kind: 'bytes' as const,
            chunk: Buffer.alloc(0),
            bytes: 0,
            after: null,
            complete: true,
          };
        }
        if (after !== undefined && pages.get(value.root, after) === undefined)
          invalid('historical envelope byte cursor');
        let chunk = Buffer.alloc(0);
        let cursor: string | null = null;
        let complete = true;
        for (const item of pages.entries(value.root, after)) {
          const next = checkedByteChunk(item.value);
          if (chunk.length + next.length > 16 * 1024) {
            complete = false;
            break;
          }
          chunk = Buffer.concat([chunk, next]);
          cursor = item.key;
        }
        if (!complete && cursor === null) invalid('historical envelope byte progress');
        if (complete && cursor === null && after === undefined && value.bytes !== 0)
          invalid('historical envelope missing bytes');
        if (after !== undefined && cursor === null) invalid('historical envelope byte cursor');
        seal();
        return {
          kind: 'bytes' as const,
          chunk,
          bytes: value.bytes,
          after: complete ? null : cursor,
          complete,
        };
      });
      assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
      return result;
    },
    historicalEnvelopeFilenameFacts(
      originalRead: IntakeLegacyBridgeReadWitness,
      acceptedHead: RecordAcceptedIntakeHeadRead,
      storageSequence: number,
      logicalRoot: IntakeTreeRoot,
      key: string,
    ): { binding: string; bytes: number; facts: string } {
      integer(storageSequence, 1);
      intakeTreeRef(logicalRoot);
      if (!/^c:[a-zA-Z0-9_-]+$/.test(key)) invalid('historical filename cell');
      assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
      const result = runRead((readTree, certificate) => {
        const selection = selected(certificate);
        if (typeof selection.raw !== 'string') invalid('missing accepted historical head');
        assertRecordAcceptedIntakeHeadRead(db, acceptedHead, identity, selection.raw);
        const head = selection.head;
        if (!head || storageSequence > head.storageSequence)
          invalid('historical filename sequence');
        const pages = readTree();
        const history = historyAt(head, storageSequence, pages);
        if (!same(history.logical.root, logicalRoot)) invalid('historical filename root differs');
        if (storageSequence === head.storageSequence && !same(history.logical, head.logical))
          invalid('historical filename selected head differs');
        const data = descriptor(pages.get(logicalRoot, 'envelope.data'));
        if (!data || data.kind !== 'map') invalid('missing historical filename data');
        const raw = pages.get(data.root, key);
        if (raw === undefined) invalid('missing historical filename cell');
        const value = parseIntakeStoredValue(raw);
        if (value.kind !== 'bytes') invalid('historical filename is not fragmented');
        const factsRaw = pages.get(data.root, 'q:' + key.slice(2));
        if (factsRaw === undefined) invalid('missing historical filename facts');
        const factsValue = parseIntakeStoredValue(factsRaw);
        if (factsValue.kind !== 'inline') invalid('fragmented historical filename facts');
        const binding = JSON.stringify({ kind: 'bytes', root: value.root, bytes: value.bytes });
        assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
        assertRecordAcceptedIntakeHeadRead(db, acceptedHead, identity, selection.raw);
        return { binding, bytes: value.bytes, facts: factsValue.text };
      });
      assertIntakeLegacyBridgeReadWitnessForSource(db, originalRead, identity.intakeId);
      return result;
    },
    binding(view: IntakeCollectionView): IntakeCollectionHead | undefined {
      return runRead(() => {
        const value = viewData(view).head;
        return value && structuredClone(value);
      });
    },
    /** A fixed synchronous observation, not a reusable authority capability. */
    collectionState(
      area: IntakeCollectionArea,
      name: string,
      includeBuild = false,
    ): {
      logical: IntakeCollectionHead['logical'] | undefined;
      collection: IntakeCollectionDescriptor | undefined;
      buildCollection: IntakeCollectionDescriptor | undefined;
    } {
      if (area !== 'logical' && area !== 'builds') invalid('collection area');
      collectionName(name);
      if (typeof includeBuild !== 'boolean') invalid('collection build selector');
      const raw = () => {
        const head = api.binding(api.openView()),
          collection = api.collection(api.openView(), area, name);
        return {
          logical: head?.logical,
          collection,
          buildCollection: includeBuild
            ? api.collection(api.openView(), 'builds', name)
            : undefined,
        };
      };
      if (db.isTransaction) return raw();
      return runRead((readTree, certificate) => {
        if (!certificate) return raw();
        const head = selected(certificate).head,
          pages = readTree(),
          collection = descriptor(
            pages.get(
              area === 'logical' ? (head?.logical.root ?? null) : (head?.builds ?? null),
              name,
            ),
          ),
          buildCollection = includeBuild
            ? area === 'builds'
              ? collection
              : descriptor(pages.get(head?.builds ?? null, name))
            : undefined;
        ready();
        return structuredClone({ logical: head?.logical, collection, buildCollection });
      });
    },
    /** Fixed authenticated schema operations; callers cannot insert fabricated proofs. */
    resolveSchemaRecord(
      view: IntakeCollectionView,
      mode: 'raw' | 'normalized',
      root: string,
      id: string,
      fieldSelection: 'first' | 'last',
      area: IntakeCollectionArea = 'logical',
      collection = 'envelope.data',
    ): SchemaRecord {
      return resolveSchemaRead(
        view,
        mode,
        root,
        id,
        fieldSelection,
        {
          kind: 'header',
        },
        area,
        collection,
      ) as SchemaRecord;
    },
    resolveSchemaField(
      view: IntakeCollectionView,
      mode: 'raw' | 'normalized',
      root: string,
      id: string,
      fieldSelection: 'first' | 'last',
      name: string,
      area: IntakeCollectionArea = 'logical',
      collection = 'envelope.data',
    ): { target: SchemaTarget | undefined } {
      return resolveSchemaRead(
        view,
        mode,
        root,
        id,
        fieldSelection,
        { kind: 'field', name },
        area,
        collection,
      ) as {
        target: SchemaTarget | undefined;
      };
    },
    resolveSchemaChild(
      view: IntakeCollectionView,
      mode: 'raw' | 'normalized',
      root: string,
      id: string,
      fieldSelection: 'first' | 'last',
      name: string,
      area: IntakeCollectionArea = 'logical',
      collection = 'envelope.data',
    ): SchemaChildResolution {
      if (activeFieldRead) {
        activeFieldRead.poisoned = true;
        invalid('reentrant schema child snapshot');
      }
      if (db.isTransaction) invalid('schema child snapshot transaction');
      const batch = { poisoned: false };
      activeFieldRead = batch;
      try {
        const result = resolveSchemaRead(
          view,
          mode,
          root,
          id,
          fieldSelection,
          { kind: 'child', name },
          area,
          collection,
        ) as SchemaChildResolution;
        if (batch.poisoned) invalid('poisoned schema child snapshot');
        return result;
      } finally {
        activeFieldRead = undefined;
      }
    },
    readSchemaFields(
      view: IntakeCollectionView,
      mode: 'raw' | 'normalized',
      root: string,
      selection: 'first' | 'last',
      requests: readonly { id: string; name: string; bytes: number }[],
      area: IntakeCollectionArea = 'logical',
      name = 'envelope.data',
    ): IntakeEnvelopeField[] {
      if (activeFieldRead) {
        activeFieldRead.poisoned = true;
        invalid('reentrant schema field snapshot');
      }
      const batch = { poisoned: false };
      activeFieldRead = batch;
      const check = () => {
        if (batch.poisoned) invalid('poisoned schema field snapshot');
      };
      try {
        const input = detachSchemaFieldRequests(requests);
        if (
          (mode !== 'raw' && mode !== 'normalized') ||
          typeof root !== 'string' ||
          !/^[a-f0-9]{64}$/.test(root) ||
          (selection !== 'first' && selection !== 'last')
        )
          invalid('schema field snapshot arguments');
        const result = runRead(
          (readTree, certificate) => {
            check();
            collectionName(name);
            const pages = readTree();
            const source = descriptor(pages.get(readScope(view, area, certificate), name));
            if (!source) invalid('missing selected envelope data');
            const port: EnvelopeCellReader = {
              check,
              get: (key) => {
                check();
                const raw = pages.get(source.root, key);
                if (raw !== undefined) recordIntakeWork('collectionItemsRead');
                return raw === undefined ? undefined : publicValue(raw, source.kind, certificate);
              },
              range: (after, items, bytes, prefix) =>
                readCollectionRange(pages, source, { after, items, bytes, prefix }, certificate),
              chunks: (value, after, bytes = 4096) =>
                readByteRange(pages, value, { after, items: 64, bytes }, certificate),
            };
            const headers = new Map<string, SchemaRecord>();
            const values = input.map(({ id, name, bytes }): IntakeEnvelopeField => {
              let meta = headers.get(id);
              if (!meta) {
                meta = resolveSchemaMetadata(
                  (key) => textValue(port, key),
                  () => root,
                  id,
                  selection,
                );
                headers.set(id, meta);
              }
              const target = resolveSchemaFieldTarget(
                meta,
                id,
                name,
                selection,
                (key) => port.get(key),
                (key) => textValue(port, key),
                (key) => cellChunks(port, key),
              );
              if (!target) return { kind: 'missing' };
              if (target.type === 'record') return { kind: 'fragmented', bytes: 0 };
              const key = 'c:' + target.id;
              const value = port.get(key);
              if (value === undefined) invalid('missing schema field cell');
              const size = typeof value === 'string' ? Buffer.byteLength(value) : value.bytes;
              if (size > bytes) return { kind: 'fragmented', bytes: size };
              // This private lexical value is consumed completely before the seal.
              // No second read or caller-supplied iterator can replace its payload.
              const text =
                typeof value === 'string'
                  ? value
                  : [...cellChunks({ ...port, get: () => value }, key)].join('');
              return { kind: 'value', value: JSON.parse(text) };
            });
            ready();
            check();
            return values;
          },
          { schemaTransaction: true, fixedSchemaFields: true },
        );
        check();
        return result;
      } finally {
        activeFieldRead = undefined;
      }
    },
    clearSchemaRecordCache(): void {
      if (activeFieldRead) activeFieldRead.poisoned = true;
      const registry = registries.get(db);
      registry?.schemaRecords.clear();
      if (registry) {
        registry.schemaRecordBytes = 0;
        registry.schemaRecordEpoch = {};
      }
    },
    collection(
      view: IntakeCollectionView,
      area: IntakeCollectionArea,
      name: string,
    ): IntakeCollectionDescriptor | undefined {
      return runRead((readTree) => {
        collectionName(name);
        return descriptor(readTree().get(readScope(view, area), name));
      });
    },
    /** Authenticate one bounded namespace-presence lookup without exposing its iterator. */
    hasCollectionPrefix(
      view: IntakeCollectionView,
      area: IntakeCollectionArea,
      prefix: string,
    ): boolean {
      return runRead((readTree) => {
        collectionName(prefix);
        const pages = readTree(),
          root = readScope(view, area),
          exact = pages.get(root, prefix);
        if (exact !== undefined) {
          descriptor(exact);
          return true;
        }
        const entries = pages.entries(root, prefix);
        try {
          const first = entries.next();
          if (first.done || !first.value.key.startsWith(prefix)) return false;
          descriptor(first.value.value);
          return true;
        } finally {
          entries.return(undefined);
        }
      });
    },
    get(
      view: IntakeCollectionView,
      area: IntakeCollectionArea,
      name: string,
      key: string,
    ): string | IntakeByteValue | undefined {
      return runRead((readTree, certificate) => {
        collectionName(name);
        const pages = readTree(),
          collection = descriptor(pages.get(readScope(view, area, certificate), name));
        return readCollectionItem(pages, collection, key, certificate);
      });
    },
    rank(
      view: IntakeCollectionView,
      area: IntakeCollectionArea,
      name: string,
      key: string,
    ): number {
      return runRead((readTree) => {
        collectionName(name);
        const pages = readTree(),
          collection = descriptor(pages.get(readScope(view, area), name));
        return pages.rank(collection?.root ?? null, key);
      });
    },
    getCollectionReference(
      view: IntakeCollectionView,
      area: IntakeCollectionArea,
      name: string,
      key: string,
    ): IntakeCollectionValue | undefined {
      return runRead((readTree) => {
        collectionName(name);
        const pages = readTree(),
          collection = descriptor(pages.get(readScope(view, area), name));
        if (collection && collection.kind === 'bytes')
          invalid('byte collections have no nested references');
        const value = pages.get(collection?.root ?? null, key);
        return value === undefined ? undefined : collectionValue(value, readTree);
      });
    },
    preceding(view: IntakeCollectionView, area: IntakeCollectionArea, name: string, key: string) {
      return runRead((readTree, certificate) => {
        collectionName(name);
        const pages = readTree(),
          source = descriptor(pages.get(readScope(view, area, certificate), name));
        const item = pages.preceding(source?.root ?? null, key);
        if (!item) return undefined;
        recordIntakeWork('collectionItemsRead');
        return { key: item.key, value: publicValue(item.value, source!.kind, certificate) };
      });
    },
    precedingReferenced(value: IntakeCollectionValue, key: string) {
      return runRead((readTree, certificate) => {
        const source = referenced(value),
          item = readTree().preceding(source.root, key);
        if (!item) return undefined;
        recordIntakeWork('collectionItemsRead');
        return { key: item.key, value: publicValue(item.value, source.kind, certificate) };
      });
    },
    referenceFrom(value: IntakeCollectionValue, key: string): IntakeCollectionValue | undefined {
      return runRead((readTree) => {
        const source = referenced(value);
        if (source.kind === 'bytes') invalid('byte collections have no nested references');
        const raw = readTree().get(source.root, key);
        return raw === undefined ? undefined : collectionValue(raw, readTree);
      });
    },
    getReferenced(value: IntakeCollectionValue, key: string): string | IntakeByteValue | undefined {
      return runRead((readTree, certificate) => {
        const source = referenced(value),
          raw = readTree().get(source.root, key);
        if (raw !== undefined) recordIntakeWork('collectionItemsRead');
        return raw === undefined ? undefined : publicValue(raw, source.kind, certificate);
      });
    },
    rankReferenced(value: IntakeCollectionValue, key: string): number {
      return runRead((readTree) => readTree().rank(referenced(value).root, key));
    },
    rangeReferenced(
      value: IntakeCollectionValue,
      options: { after?: string; items: number; bytes: number },
    ) {
      return runRead((readTree, certificate) => {
        const source = referenced(value);
        integer(options.items, 1);
        integer(options.bytes, 1);
        if (options.items > 100 || options.bytes > 256 * 1024) invalid('reference range budget');
        const items: Array<{ key: string; value: string | IntakeByteValue }> = [];
        let bytes = 0,
          complete = true;
        for (const item of readTree().entries(source.root, options.after)) {
          const added = Buffer.byteLength(item.key) + Buffer.byteLength(item.value);
          if (items.length === options.items || bytes + added > options.bytes) {
            complete = false;
            break;
          }
          bytes += added;
          items.push({
            key: item.key,
            value: publicValue(item.value, source.kind, certificate),
          });
          recordIntakeWork('collectionItemsRead');
        }
        if (!complete && !items.length) invalid('reference range item exceeds byte budget');
        return {
          items,
          bytes,
          complete,
          after: complete ? null : items.at(-1)!.key,
          count: source.root?.count ?? 0,
        };
      });
    },
    rangeCollectionReferences(
      view: IntakeCollectionView,
      area: IntakeCollectionArea,
      name: string,
      options: { after?: string; items: number; bytes: number },
    ) {
      return runRead((readTree) => {
        collectionName(name);
        integer(options.items, 1);
        integer(options.bytes, 1);
        if (options.items > 100 || options.bytes > 256 * 1024) invalid('reference range budget');
        const pages = readTree(),
          source = descriptor(pages.get(readScope(view, area), name));
        if (source?.kind === 'bytes') invalid('byte collections have no nested references');
        const items: Array<{ key: string; value: IntakeCollectionValue }> = [];
        let bytes = 0,
          complete = true;
        for (const item of pages.entries(source?.root ?? null, options.after)) {
          const added = Buffer.byteLength(item.key) + Buffer.byteLength(item.value);
          if (items.length === options.items || bytes + added > options.bytes) {
            complete = false;
            break;
          }
          bytes += added;
          items.push({
            key: item.key,
            value: collectionValue(item.value, readTree),
          });
          recordIntakeWork('collectionItemsRead');
        }
        if (!complete && !items.length) invalid('reference range item exceeds byte budget');
        return {
          items,
          bytes,
          complete,
          after: complete ? null : items.at(-1)!.key,
          count: source?.root?.count ?? 0,
        };
      });
    },
    range(
      view: IntakeCollectionView,
      area: IntakeCollectionArea,
      name: string,
      options: { after?: string; prefix?: string; items: number; bytes: number },
    ) {
      return runRead((readTree, certificate) => {
        collectionName(name);
        const pages = readTree(),
          collection = descriptor(pages.get(readScope(view, area, certificate), name));
        return readCollectionRange(pages, collection, options, certificate);
      });
    },
    readBytes(value: IntakeByteValue, options: { after?: string; items: number; bytes: number }) {
      return runRead((readTree, certificate) =>
        readByteRange(readTree(), value, options, certificate),
      );
    },
    /** A detached identity for one owner-issued, currently selected byte value.
     * This does not grant a caller authority to resolve a self-described root. */
    byteValueBinding(value: IntakeByteValue): string {
      return runRead((readTree, certificate) =>
        JSON.stringify(referencedBytes(value, readTree(), certificate)),
      );
    },
    replay(operationId: string, requestDigest: string): IntakeCollectionResult | undefined {
      return runRead((readTree) => {
        uuid(operationId);
        return receipt(selected().head, operationId, requestDigest, readTree);
      });
    },
    createPrivateEnvelopeMutation(
      view: IntakeCollectionView,
      originalSource: { sha256?: unknown; details_json?: unknown },
      operation: Pick<IntakeCollectionMutation, 'operationId' | 'requestDigest' | 'domainVersion'>,
    ): PrivateEnvelopeCandidate {
      const originalOperation = JSON.stringify({
        operationId: operation.operationId,
        requestDigest: operation.requestDigest,
        domainVersion: operation.domainVersion,
      });
      const methods = managedDatabaseMethodEpoch(db),
        generation = registryFor(db).generation,
        originalView = viewData(view),
        originalLogical = JSON.stringify(originalView.head?.logical),
        sourceHash = originalSource.sha256,
        sourceDetails = originalSource.details_json;
      return runRead((readTree) => {
        const selectedHead = selected().head;
        if (!selectedHead || JSON.stringify(selectedHead.logical) !== originalLogical)
          invalid('private envelope requires its original selected head');
        const initial = descriptor(readTree().get(selectedHead.logical.root, 'envelope.data'));
        if (!initial || initial.kind !== 'map') invalid('private envelope requires selected data');
        const logical = JSON.stringify(selectedHead.logical),
          registry = registryFor(db),
          sourceStatement = terminalStatement(
            db,
            'SELECT sha256,details_json FROM source_files WHERE id=?',
          ),
          source = sourceStatement.get(identity.intakeId);
        if (!methods) invalid('private envelope requires managed owner');
        if (
          !source ||
          source.sha256 !== identity.sourceHash ||
          source.sha256 !== sourceHash ||
          source.details_json !== sourceDetails ||
          managedDatabaseMethodEpoch(db) !== methods ||
          registry.generation !== generation
        )
          invalid('private envelope source binding');
        const assertOriginalSelection = (certificate?: IntakeTreeReadCertificate) => {
          const currentSource = terminalStatement(
            db,
            'SELECT sha256,details_json FROM source_files WHERE id=?',
            sourceStatement,
          ).get(identity.intakeId);
          if (
            managedDatabaseMethodEpoch(db) !== methods ||
            registryFor(db).generation !== generation ||
            JSON.stringify(selected(certificate).head?.logical) !== logical ||
            currentSource?.sha256 !== sourceHash ||
            currentSource?.details_json !== sourceDetails
          )
            invalid('private envelope original owner changed');
        };
        const assertOriginal = () =>
          runRead((_pages, certificate) => assertOriginalSelection(certificate));
        let originalReadScope: { poisoned: boolean } | undefined;
        const readOriginalScope = <T>(read: () => T): T => {
          if (originalReadScope) {
            originalReadScope.poisoned = true;
            invalid('reentrant private original read');
          }
          // Transaction reads retain their existing per-edge fallback checks.
          if (db.isTransaction) {
            assertOriginal();
            const result = read();
            assertOriginal();
            return result;
          }
          const scope = { poisoned: false };
          originalReadScope = scope;
          try {
            return runRead(
              (_pages, certificate) => {
                assertOriginalSelection(certificate);
                const result = read();
                if (
                  result &&
                  (typeof result === 'object' || typeof result === 'function') &&
                  ('then' in result || 'next' in result)
                )
                  invalid('private original read must finish synchronously');
                assertOriginalSelection(certificate);
                // A SQL witness alone cannot detect an external accepted HEAD
                // replacement. Keep a real physical authority check at exit.
                ready();
                if (scope.poisoned) invalid('poisoned private original read');
                return result;
              },
              { sealTransaction: true },
            );
          } finally {
            originalReadScope = undefined;
          }
        };
        const candidate = createPrivateEnvelopeCandidate({
          db,
          nodePrefix: prefix + 'node:',
          identity,
          collection: 'envelope.data',
          descriptor: initial,
          originalBuilds: selected().head?.builds ?? null,
          assertOriginal,
          readOriginalScope,
          readOriginal: (hash) =>
            originalReadScope
              ? get(prefix + 'node:' + hash)
              : runRead(() => get(prefix + 'node:' + hash)),
          readOriginalDescriptor: (area, name) =>
            runRead(() =>
              tree().get(
                area === 'builds'
                  ? (selected().head?.builds ?? null)
                  : (selected().head?.logical.root ?? null),
                name,
              ),
            ),
        });
        while (registry.privateCandidates.size >= 8) {
          const expired = registry.privateCandidates.keys().next().value!;
          registry.privateCandidates.delete(expired);
          expired.close();
        }
        registry.privateCandidates.set(candidate, privateOwner);
        privateCandidates.set(candidate, {
          logical,
          methods: methods!,
          operation: originalOperation,
        });
        return candidate;
      });
    },
    privateEnvelopeChange(candidate: PrivateEnvelopeCandidate): IntakeCollectionChange {
      candidate.check();
      const binding = privateCandidates.get(candidate);
      if (
        !binding ||
        registryFor(db).privateCandidates.get(candidate) !== privateOwner ||
        binding.methods !== managedDatabaseMethodEpoch(db) ||
        binding.logical !== JSON.stringify(selected().head?.logical)
      )
        invalid('foreign or expired private envelope candidate');
      const selectedDescriptor = candidate.descriptor(),
        capability = Object.freeze({
          kind: 'collection',
          collectionKind: selectedDescriptor.kind,
          count: selectedDescriptor.root?.count ?? 0,
          bytes: selectedDescriptor.bytes,
        }) as IntakeCollectionValue;
      registryFor(db).collectionValues.set(capability, {
        prefix,
        logical: binding.logical,
        descriptor: selectedDescriptor,
        privateCandidate: candidate,
      });
      const values = registryFor(db).collectionValues;
      while (values.size > 128) values.delete(values.keys().next().value!);
      return {
        area: 'logical',
        collection: 'envelope.data',
        op: 'adoptReferenced',
        value: capability,
      };
    },
    disposePrivateEnvelopeMutation(candidate: PrivateEnvelopeCandidate): void {
      if (!privateCandidates.has(candidate)) return;
      privateCandidates.delete(candidate);
      registryFor(db).privateCandidates.delete(candidate);
      candidate.close();
    },
    previewPrivateEnvelopeMutation(
      candidate: PrivateEnvelopeCandidate,
      input: IntakeCollectionMutation,
    ): IntakeCollectionHead['logical'] {
      const prepared = preparePrivateCandidate(candidate, input);
      try {
        return structuredClone(inspect(prepared).result.logical);
      } finally {
        discard(prepared);
      }
    },
    async preparePrivateEnvelopeMutation(
      candidate: PrivateEnvelopeCandidate,
      input: IntakeCollectionMutation,
      options: { assertCurrent?: () => void } = {},
    ): Promise<PreparedIntakeCollectionMutation> {
      if (!privateCandidates.has(candidate)) invalid('foreign private envelope candidate');
      const normalized = {
        operationId: input.operationId,
        requestDigest: input.requestDigest,
        domainVersion: input.domainVersion,
        changes: input.changes.map((change) => ({
          ...change,
          ...('bytes' in change ? { bytes: Buffer.from(change.bytes) } : {}),
        })),
      };
      const buildChanges = normalized.changes.filter((change) => change.area === 'builds');
      if (buildChanges.length) candidate.apply(buildChanges);
      if (buildChanges.length || candidate.needsBuildsFinalization())
        await candidate.finalizeBuilds(
          buildChanges.map((change) => change.collection),
          options.assertCurrent,
        );
      const roster = await candidate.seal(options.assertCurrent);
      candidate.check();
      const prepared = preparePrivateCandidate(candidate, normalized);
      try {
        const data = inspect(prepared);
        if (data.legacyBridge || data.compactMetadata) invalid('private representation adoption');
        const after = parseIntakeCollectionHead(data.after, identity)!,
          pages = createIntakeTree(
            identity,
            (hash) =>
              data.writes.find((row) => row.key === prefix + 'node:' + hash)?.value ??
              candidate.readNode(hash),
            new Map(),
          ),
          selectedData = descriptor(pages.get(after.logical.root, 'envelope.data'));
        if (
          roster.nodePrefix !== prefix + 'node:' ||
          JSON.stringify(selectedData) !== JSON.stringify(roster.descriptor) ||
          JSON.stringify(roster.descriptor) !== JSON.stringify(candidate.descriptor())
        )
          invalid('private envelope selected roster agreement');
        data.privateEnvelope = { candidate, roster };
        privateCandidates.delete(candidate);
        roster.check();
        return prepared;
      } catch (error) {
        try {
          discard(prepared);
        } catch {
          // Retain the original preparation refusal after revocation.
        }
        try {
          candidate.close();
        } catch {
          // Try both owned cleanup paths without replacing the first failure.
        }
        throw error;
      }
    },
    prepare(
      view: IntakeCollectionView,
      input: IntakeCollectionMutation,
      originalRead?: IntakeLegacyBridgeReadWitness,
    ): PreparedIntakeCollectionMutation {
      return prepareCollection(view, input, originalRead);
    },
    /** Small copies only; this exposes neither mutable candidate pages nor an
     * authority capability that a caller can manufacture from hashes. */
    inspectPrepared(prepared: PreparedIntakeCollectionMutation) {
      return run(() => {
        const data = inspect(prepared);
        return {
          identity: { ...identity },
          beforeHead: data.before,
          afterHead: data.after,
          result: structuredClone(data.result),
          logical: structuredClone(parseIntakeCollectionHead(data.after, identity)!.logical),
          writeCount: data.writes.length,
          writeBytes: data.size,
        };
      });
    },
    stage(
      prepared: PreparedIntakeCollectionMutation,
      options: { assertCurrent?: () => void } = {},
    ): IntakeCollectionResult {
      return run(() => {
        const guarded: unknown = options.assertCurrent?.();
        if (
          guarded &&
          (typeof guarded === 'object' || typeof guarded === 'function') &&
          'then' in guarded
        )
          invalid('collection publication guard must finish synchronously');
        const token = currentTransactionToken(db);
        if (!token || !db.isTransaction)
          invalid('collection stage requires application transaction');
        const freshRows: Array<{ key: string; value: string }> = [];
        const data = inspect(prepared),
          current =
            data.legacyBridge || data.compactMetadata
              ? { raw: get(headKey), head: undefined }
              : selected();
        if ((data.legacyBridge || data.compactMetadata) && bridgeTransaction !== token)
          invalid('legacy bridge requires certified maintenance publication');
        const retained = data.logAppend
          ? current.raw === data.after
            ? receipt(current.head, data.result.operationId, data.requestDigest)
            : undefined
          : receipt(current.head, data.result.operationId, data.requestDigest);
        if (retained) {
          discard(prepared);
          return structuredClone(retained);
        }
        if (current.raw !== data.before) invalid('stale collection preparation; reopen view');
        if (data.privateEnvelope) {
          const { roster } = data.privateEnvelope;
          roster.check();
          for (const part of roster.parts()) {
            recordIntakeWork('privateEnvelopeStagedParts');
            recordIntakePeak(
              'privateEnvelopePeakPartBytes',
              part.reduce(
                (sum, row) =>
                  sum + Buffer.byteLength(prefix + 'node:' + row.hash) + Buffer.byteLength(row.raw),
                0,
              ),
            );
            for (const row of part) {
              const key = prefix + 'node:' + row.hash;
              const inserted = immutable(key, row.raw, INTAKE_TREE_PAGE_BYTES);
              if (get(key) !== row.raw) invalid('private envelope staged readback');
              if (inserted) {
                freshRows.push({ key, value: row.raw });
                recordIntakeWork('collectionNodesWritten');
                recordIntakeWork('collectionWrittenBytes', Buffer.byteLength(row.raw));
              }
            }
          }
          roster.check();
        }
        // Validate every new encoded page before publishing any row. Preparation
        // bytes are private; writes/readback remain inside the existing transaction.
        for (const row of data.writes) {
          if (row.key === headKey) continue;
          const inserted = immutable(row.key, row.value, INTAKE_TREE_PAGE_BYTES);
          if (get(row.key) !== row.value) invalid('collection staged readback');
          if (inserted) {
            freshRows.push(row);
            recordIntakeWork('collectionNodesWritten');
            recordIntakeWork('collectionWrittenBytes', Buffer.byteLength(row.value));
          }
        }
        if (data.privateEnvelope) {
          if (!current.head) invalid('private reader transition requires selected head');
          data.privateEnvelope.candidate.check();
          stagePrivateReaderCoverageTransitions(
            db,
            identity.intakeId,
            JSON.stringify(current.head.logical),
            JSON.stringify(data.result.logical),
            data.privateEnvelope.candidate.readerCoverageRows(),
          );
        }
        const expectedHead = expectIntakeFrontierMetaWrite(
          db,
          headKey,
          ['insert', 'update'],
          identity.intakeId,
        );
        let headWritten = false;
        try {
          headWritten =
            terminalStatement(
              db,
              'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
              undefined,
              false,
              'changes',
            ).run(headKey, data.after).changes === 1;
        } finally {
          finishIntakeFrontierMetaWrite(db, expectedHead, headWritten);
        }
        if (data.logAppend) {
          const entry = completeLogs.get(db)?.get(prefix);
          if (!entry) invalid('collection log staged reservation changed');
          entry.pending = { append: data.logAppend, before: data.before };
          freshRows.push({ key: headKey, value: data.after });
          entry.pending.token = token;
          entry.pending.publication = registerRecordIntakeLogPublication(db, {
            identity,
            beforeHead: data.before,
            afterHead: data.after,
            receipt: {
              format: 'health-intake-state-receipt-v4',
              requestDigest: data.requestDigest,
              result: data.result,
            },
            writes: freshRows,
          });
        }
        discard(prepared, true);
        return structuredClone(data.result);
      });
    },
    disposePreparation(prepared: PreparedIntakeCollectionMutation): void {
      discard(prepared);
    },
    certifySchemaAdoption(prepared: PreparedIntakeCollectionMutation): void {
      return run(() => {
        const data = inspect(prepared);
        if (data.before === undefined || data.legacyBridge) invalid('schema adoption preparation');
        data.legacyBridge = prepareIntakeSchemaAdoptionProof(db, {
          identity,
          beforeHead: data.before,
          afterHead: data.after,
          writes: data.writes,
        });
      });
    },
    async certifySchemaAdoptionAsync(
      prepared: PreparedIntakeCollectionMutation,
      options: { assertRunning?: () => void } = {},
    ): Promise<void> {
      const data = run(() => inspect(prepared));
      if (data.before === undefined || data.legacyBridge) invalid('schema adoption preparation');
      const proof = await prepareIntakeSchemaAdoptionProofAsync(
        db,
        {
          identity,
          beforeHead: data.before,
          afterHead: data.after,
          writes: data.writes,
        },
        options,
      );
      run(() => {
        if (inspect(prepared) !== data || data.legacyBridge)
          invalid('expired schema adoption preparation');
        data.legacyBridge = proof;
      });
    },
    async certifyCompactMetadataAsync(
      prepared: PreparedIntakeCollectionMutation,
      options: {
        assertRunning?: () => void;
        deferredTerminal?: boolean;
        referencedTargetCandidate?: import('./intake-state-migration.ts').IntakeReferencedTargetCandidate;
      } = {},
    ): Promise<boolean> {
      const data = run(() => inspect(prepared));
      if (data.before === undefined || data.legacyBridge || data.compactMetadata)
        invalid('compact metadata preparation');
      let referencedTargetCandidate = options.referencedTargetCandidate;
      if (referencedTargetCandidate) {
        consumeIntakeReferencedTargetIntent(db, referencedTargetCandidate, identity, data.before);
        referencedTargetCandidate = await projectIntakeReferencedTargetCandidateAsync(
          db,
          { identity, afterHead: data.after, writes: data.writes },
          options.assertRunning ?? (() => {}),
        );
      }
      const proof = await prepareIntakeCompactMetadataProofAsync(
        db,
        {
          identity,
          beforeHead: data.before,
          afterHead: data.after,
          writes: data.writes,
        },
        {
          ...options,
          referencedTargetCandidate,
          publication: {
            operationId: data.result.operationId,
            fingerprint: prefix + data.requestDigest,
            result: data.result,
          },
        },
      );
      if (!proof) return false;
      run(() => {
        if (inspect(prepared) !== data || data.legacyBridge || data.compactMetadata)
          invalid('expired compact metadata preparation');
        data.compactMetadata = proof;
      });
      return true;
    },
    async commitCompactMaintenanceAsync(
      prepared: PreparedIntakeCollectionMutation,
      options: { assertCurrent?: () => void } = {},
    ): Promise<IntakeCollectionResult> {
      const operation = currentClinicalOperation(db),
        stage = api.stage,
        data = run(() => inspect(prepared));
      if (!operation || !data.compactMetadata || data.legacyBridge || data.before === undefined)
        invalid('compact terminal collection preparation');
      options.assertCurrent?.();
      const fingerprint = prefix + data.requestDigest,
        capability = prepareIntakeMaintenancePublication(db, {
          identity,
          beforeHead: data.before!,
          afterHead: data.after,
          writes: data.writes,
          result: data.result,
          operationId: data.result.operationId,
          fingerprint,
          compactMetadata: data.compactMetadata,
          assertCurrent: options.assertCurrent,
        });
      const readmission = prepareIntakeCompactReadmission(db, capability);
      const terminal = await prepareIntakeCompactTerminalPublication(db, capability);
      const contributor = terminal && intakeCompactContributorTerminalPrepared(db, capability);
      const assertCurrent = () => assertClinicalOperation(db, operation);
      const commit = () =>
        transaction(
          db,
          () => {
            assertCurrent();
            bridgeTransaction = currentTransactionToken(db);
            try {
              const result = stage(prepared, { assertCurrent });
              stageIntakeCompactMetadataPublication(db, capability);
              return result;
            } finally {
              bridgeTransaction = undefined;
            }
          },
          {
            operationId: data.result.operationId,
            fingerprint,
            actor: 'intake-state',
            intakeMaintenance: capability,
          },
        );
      const result = contributor
        ? await commitIntakeCompactContributorTerminalPublication(db, capability, commit)
        : terminal
          ? withIntakeCompactTerminalPublication(db, capability, commit)
          : commit();
      let attempted = false;
      let admitted = false;
      let contributorFinalized = false;
      let stop: ReturnType<typeof observeManagedDatabaseAuthorization>;
      try {
        const methods = managedDatabaseMethodEpoch(db);
        stop = observeManagedDatabaseAuthorization(
          db,
          (action, name, detail) => {
            const readOnlyPragma =
              action === constants.SQLITE_PRAGMA &&
              (name === 'schema_version' || name === 'data_version') &&
              detail == null;
            if (
              action !== constants.SQLITE_READ &&
              action !== constants.SQLITE_SELECT &&
              action !== constants.SQLITE_FUNCTION &&
              !readOnlyPragma
            )
              attempted = true;
          },
          () => {
            attempted = true;
          },
        );
        if (!methods || !stop || attempted) throw Error('compact readmission unavailable');
        assertRecordCompactReadmission(db, readmission);
        if (attempted || managedDatabaseMethodEpoch(db) !== methods)
          throw Error('compact readmission changed');
        admitted = true;
        ensureIntakeFrontierObserver(db);
        if (!captureIntakeFrontierAttempts(db)) throw Error('compact frontier unavailable');
        assertRecordCompactReadmission(db, readmission);
        if (attempted || managedDatabaseMethodEpoch(db) !== methods)
          throw Error('compact readmission changed');
        if (contributor) {
          finishRecordCompactContributorReadmission(db, readmission, true);
          contributorFinalized = true;
        }
      } catch {
        admitted = false;
      } finally {
        if (contributor && !contributorFinalized) {
          try {
            finishRecordCompactContributorReadmission(db, readmission, false);
          } catch {
            /* accepted receipt survives derivative disposal */
          }
        }
        try {
          stop?.();
        } catch {
          admitted = false;
        }
      }
      if (!admitted) blockIntakeFrontierReadmission(db);
      return result;
    },
    async commitMaintenanceWithOriginalsAsync(
      prepared: PreparedIntakeCollectionMutation,
      originals: RecordPublicationOriginals,
      options: { assertCurrent?: () => void } = {},
    ): Promise<IntakeCollectionResult> {
      const operation = currentClinicalOperation(db);
      if (!operation) invalid('original-backed maintenance requires its live record owner');
      const assertCurrent = () => {
        assertClinicalOperation(db, operation!);
        const guarded: unknown = options.assertCurrent?.();
        if (
          guarded &&
          (typeof guarded === 'object' || typeof guarded === 'function') &&
          'then' in guarded
        )
          invalid('collection publication guard must finish synchronously');
      };
      assertCurrent();
      const data = run(() => inspect(prepared));
      if (data.legacyBridge || data.compactMetadata)
        invalid('representation maintenance requires its specialized original proof');
      const current = run(() => selected()),
        retained = data.logAppend
          ? undefined
          : receipt(current.head, data.result.operationId, data.requestDigest);
      if (retained) {
        discard(prepared);
        return structuredClone(retained);
      }
      if (data.before === undefined) invalid('maintenance requires initialized collection head');
      const fingerprint = prefix + data.requestDigest,
        capability = prepareIntakeMaintenancePublication(db, {
          identity,
          beforeHead: data.before,
          afterHead: data.after,
          writes: data.writes,
          result: data.result,
          operationId: data.result.operationId,
          fingerprint,
        });
      let preparation: RecordTransactionPreparation | undefined;
      try {
        preparation = await prepareRecordTransactionWithOriginals(
          db,
          () => api.stage(prepared, { assertCurrent }),
          {
            operationId: data.result.operationId,
            fingerprint,
            actor: 'intake-state',
            intakeMaintenance: capability,
          },
          originals,
        );
        assertCurrent();
        await authenticateRecordTransactionPreparation(db, preparation);
        assertCurrent();
        await stageRecordTransactionPreparation(db, preparation);
        assertCurrent();
        const result = await commitRecordTransactionPreparation<IntakeCollectionResult>(
          db,
          preparation,
        );
        assertCurrent();
        return result;
      } finally {
        try {
          if (preparation) discardRecordTransactionPreparation(db, preparation);
        } finally {
          discardIntakeMaintenancePublication(capability);
        }
      }
    },
    commitMaintenance(
      prepared: PreparedIntakeCollectionMutation,
      options: { assertCurrent?: () => void } = {},
    ): IntakeCollectionResult {
      return run(() => {
        const guarded: unknown = options.assertCurrent?.();
        if (
          guarded &&
          (typeof guarded === 'object' || typeof guarded === 'function') &&
          'then' in guarded
        )
          invalid('collection publication guard must finish synchronously');
        const data = inspect(prepared),
          current =
            data.legacyBridge || data.compactMetadata
              ? { raw: get(headKey), head: undefined }
              : selected();
        const retained = data.logAppend
          ? undefined
          : receipt(current.head, data.result.operationId, data.requestDigest);
        if (retained) {
          discard(prepared);
          return structuredClone(retained);
        }
        if (data.before === undefined) invalid('maintenance requires initialized collection head');
        const fingerprint = prefix + data.requestDigest;
        const capability = prepareIntakeMaintenancePublication(db, {
          identity,
          beforeHead: data.before,
          afterHead: data.after,
          writes: data.writes,
          result: data.result,
          operationId: data.result.operationId,
          fingerprint,
          legacyBridge: data.legacyBridge,
          compactMetadata: data.compactMetadata,
          assertCurrent: data.compactMetadata ? options.assertCurrent : undefined,
        });
        return transaction(
          db,
          () => {
            if (data.legacyBridge || data.compactMetadata)
              bridgeTransaction = currentTransactionToken(db);
            try {
              const result = api.stage(prepared, options);
              stageIntakeCompactMetadataPublication(db, capability);
              return result;
            } finally {
              bridgeTransaction = undefined;
            }
          },
          {
            operationId: data.result.operationId,
            fingerprint,
            actor: 'intake-state',
            intakeMaintenance: capability,
          },
        );
      });
    },
  };
  // Lexical references are captured before this owner handle becomes public.
  const recordCursorToken = Object.freeze({});
  const issuedRecordCursors = new WeakSet<SchemaRecordCursor>();
  const nativeRecordCursors = new WeakMap<
    SchemaRecordCursor,
    {
      area: IntakeCollectionArea;
      name: string;
      binding: string;
      collection: string;
      source: IntakeCollectionDescriptor;
      generation: object;
      logical: string;
      advancing: boolean;
      poisoned: boolean;
      exhausted: boolean;
    }
  >();
  const selectedCursorBinding = (current: IntakeCollectionHead, area: IntakeCollectionArea) => {
    return JSON.stringify(area === 'logical' ? current.logical : current.builds);
  };
  const createRecordCursor = (
    view: IntakeCollectionView,
    id: string,
    area: IntakeCollectionArea,
    name: string,
  ): SchemaRecordCursor | undefined => {
    if (db.isTransaction) return undefined;
    return runRead((readTree, certificate) => {
      collectionName(name);
      const head = selected(certificate).head;
      if (!head) invalid('missing selected envelope data');
      const binding = selectedCursorBinding(head, area);
      const source = descriptor(readTree().get(readScope(view, area, certificate), name));
      if (!source) invalid('missing selected envelope data');
      const cursor = createSchemaRecordCursor(id, recordCursorToken);
      nativeRecordCursors.set(cursor, {
        area,
        name,
        binding,
        collection: JSON.stringify(source),
        source,
        generation: registryFor(db).generation,
        logical: JSON.stringify(head.logical),
        advancing: false,
        poisoned: false,
        exhausted: false,
      });
      issuedRecordCursors.add(cursor);
      return cursor;
    });
  };
  const nextRecordCursor = (cursor: SchemaRecordCursor): IteratorResult<string> => {
    const retained = nativeRecordCursors.get(cursor);
    if (!retained || db.isTransaction) invalid('foreign or transaction record cursor');
    if (retained.advancing) {
      retained.poisoned = true;
      invalid('reentrant record cursor');
    }
    if (retained.poisoned) invalid('poisoned record cursor');
    const beforeRevision = schemaRecordCursorRevision(cursor, recordCursorToken);
    if (beforeRevision === undefined) invalid('tainted record cursor');
    retained.advancing = true;
    try {
      let steps = 0;
      const result = runRead((readTree, certificate) => {
        if (retained.poisoned) invalid('poisoned record cursor');
        const pages = readTree();
        const current = () => {
          if (registryFor(db).generation !== retained.generation) invalid('expired record cursor');
          const head = selected(certificate).head;
          if (
            !head ||
            JSON.stringify(head.logical) !== retained.logical ||
            selectedCursorBinding(head, retained.area) !== retained.binding
          )
            invalid('stale selected envelope');
          const scope = retained.area === 'logical' ? head.logical.root : head.builds;
          const source = descriptor(pages.get(scope, retained.name));
          if (!source || JSON.stringify(source) !== retained.collection)
            invalid('stale selected envelope data');
        };
        current();
        const port: EnvelopeCellReader = {
          check: current,
          get: (key) => readCollectionItem(pages, retained.source, key, certificate),
          range: (after, items, bytes, keyPrefix) =>
            readCollectionRange(
              pages,
              retained.source,
              {
                after,
                prefix: keyPrefix,
                items,
                bytes,
              },
              certificate,
            ),
          chunks: (value, after, bytes = 4096) =>
            readByteRange(pages, value, { after, items: 64, bytes }, certificate),
        };
        const parts: string[] = [];
        let bytes = 0;
        // cellChunks splits already-escaped lexical text into <=1024 UTF-16
        // units or decodes <=4096 UTF-8 bytes with at most three bytes held
        // from the preceding chunk. Reserve that entire next-part bound.
        const maxPartBytes = 4099;
        while (!retained.exhausted && parts.length < 64 && bytes < 16 * 1024 - maxPartBytes) {
          const part = stepSchemaRecordCursor(cursor, port, recordCursorToken);
          steps++;
          if (part.done) {
            retained.exhausted = true;
            break;
          }
          const size = Buffer.byteLength(part.value);
          if (size > maxPartBytes || bytes + size > 16 * 1024)
            invalid('record cursor lexical part exceeds bound');
          parts.push(part.value);
          bytes += size;
        }
        ready();
        if (retained.poisoned) invalid('poisoned record cursor');
        return parts.length
          ? { done: false as const, value: parts.join('') }
          : { done: true as const, value: undefined };
      });
      if (
        retained.poisoned ||
        schemaRecordCursorRevision(cursor, recordCursorToken) !== beforeRevision + steps
      )
        invalid('record cursor authority changed');
      return result;
    } catch (error) {
      nativeRecordCursors.delete(cursor);
      closeSchemaRecordCursor(cursor);
      throw error;
    } finally {
      retained.advancing = false;
    }
  };
  const closeRecordCursor = (cursor: SchemaRecordCursor): void => {
    if (activeFieldRead) activeFieldRead.poisoned = true;
    if (!issuedRecordCursors.has(cursor)) invalid('foreign record cursor');
    const retained = nativeRecordCursors.get(cursor);
    if (retained?.advancing) {
      retained.poisoned = true;
      invalid('reentrant record cursor close');
    }
    if (!nativeRecordCursors.delete(cursor)) return;
    closeSchemaRecordCursor(cursor);
  };
  const schemaReadOperations = Object.freeze({
    collection: api.collection,
    get: api.get,
    range: api.range,
    readBytes: api.readBytes,
  });
  const schemaMethods = Object.freeze({
    ...schemaReadOperations,
    openView: api.openView,
    binding: api.binding,
    resolveSchemaRecord: api.resolveSchemaRecord,
    resolveSchemaField: api.resolveSchemaField,
    resolveSchemaChild: api.resolveSchemaChild,
    readSchemaFields: api.readSchemaFields,
    clearSchemaRecordCache: api.clearSchemaRecordCache,
  });
  schemaRecordOwners.set(
    api,
    Object.freeze({
      resolve: api.resolveSchemaRecord,
      field: api.resolveSchemaField,
      child: api.resolveSchemaChild,
      canReadChild: () => !db.isTransaction && !!managedDatabaseMethodEpoch(db),
      fields: api.readSchemaFields,
      canReadFields: () => !db.isTransaction && !!managedDatabaseMethodEpoch(db),
      clear: api.clearSchemaRecordCache,
      createCursor: createRecordCursor,
      nextCursor: nextRecordCursor,
      closeCursor: closeRecordCursor,
      canAdvance: () => !db.isTransaction,
      current: () =>
        Object.entries(schemaMethods).every(([name, method]) => {
          const descriptor = Object.getOwnPropertyDescriptor(api, name);
          return !!descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === method;
        }),
    }),
  );
  return api;
}
