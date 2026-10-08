/** V4 bounded collections owned and staged by intake-state-storage. */
import {
  currentTransactionToken,
  rejectCurrentTransaction,
  transaction,
  type Database,
} from './database.ts';
import { prepareIntakeMaintenancePublication } from './intake-state-maintenance.ts';
import {
  prepareIntakeLegacyBridgeProof,
  prepareIntakeSchemaAdoptionProof,
  prepareIntakeSchemaAdoptionProofAsync,
  validateIntakeLegacyBridgeControl,
  INTAKE_LEGACY_BRIDGE_CONTROL,
  type IntakeLegacyBridgeProof,
} from './intake-state-migration.ts';
import type { IntakeStateMaterialization } from './intake-state-storage.ts';
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
  type IntakeCollectionResult,
  type IntakeStateIdentity,
} from './intake-state-evidence.ts';
import {
  createIntakeTree,
  decodeIntakeTreeNode,
  intakeTreeRef,
  intakeTreeKey,
  INTAKE_TREE_VALUE_BYTES,
  type IntakeTreeCachedNode,
  type IntakeTreeReadCertificate,
  type IntakeTreeRoot,
} from './intake-state-tree.ts';
import {
  resolveSchemaMetadata,
  resolveSchemaFieldTarget,
} from './intake-schema-record-resolution.ts';
import type { SchemaRecord, SchemaTarget } from './intake-envelope-schema.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';

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
}
interface SchemaRecordOwner {
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
    { prefix: string; logical: string; descriptor: IntakeCollectionDescriptor }
  >;
}
const registries = new WeakMap<Database, Registry>();
/** Invalidates owner-handle reuse along with the existing disposable registry. */
export function intakeCollectionCacheGeneration(db: Database): object {
  return registryFor(db).generation;
}
export function clearIntakeCollectionCache(db: Database): void {
  const registry = registries.get(db);
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
  registries.delete(db);
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
    format: value.format,
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
  immutable: (key: string, value: string) => void;
  invalidate: () => void;
  legacyMaterialization: (head: Head) => IntakeStateMaterialization;
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
  let readEpoch: object = {};
  const readWitness = () => {
    recordIntakeWork('collectionReadWitnessQueries', 2);
    const stamp = readGeneration.get()!,
      temp = readTempGeneration.get()!;
    return `${stamp.changes}:${stamp.external}:${stamp.schema}:${temp.schema_version}`;
  };
  const get = (key: string) => owner.get(key, key === headKey ? HEAD_BYTES : 32 * 1024);
  const run = <T>(fn: () => T): T =>
    withIntakeWork(db, 'warm', () => {
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
  const runRead = <T>(fn: (pages: typeof tree, certificate?: IntakeTreeReadCertificate) => T): T =>
    withIntakeWork(db, 'warm', () => {
      let certificate: IntakeTreeReadCertificate | undefined;
      try {
        ready();
        if (db.isTransaction) {
          readEpoch = {};
          return fn(tree);
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
        const result = fn(() => tree({ certificate: proof, check }), proof);
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
        db.isTransaction)
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
      const pages = tree();
      for (const root of [head.logical.root, head.receipts, head.history, head.builds])
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
  function tree(proof?: Parameters<typeof createIntakeTree>[3]) {
    return createIntakeTree(
      identity,
      (hash) => get(prefix + 'node:' + hash),
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
  function receipt(
    head: IntakeCollectionHead | undefined,
    operationId: string,
    requestDigest: string,
    pages: typeof tree = tree,
  ) {
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
  function discard(prepared: PreparedIntakeCollectionMutation) {
    const registry = registryFor(db),
      data = registry.preparations.get(prepared);
    if (data) {
      registry.preparedBytes -= data.size;
      registry.preparations.delete(prepared);
    }
  }
  function publicValue(
    raw: string,
    kind: IntakeCollectionDescriptor['kind'],
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
      logical: JSON.stringify(selected().head?.logical ?? null),
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
  function referenced(value: IntakeCollectionValue): IntakeCollectionDescriptor {
    const values = registryFor(db).collectionValues,
      retained = values.get(value);
    if (
      !retained ||
      retained.prefix !== prefix ||
      retained.logical !== JSON.stringify(selected().head?.logical ?? null)
    )
      invalid('foreign, stale or expired collection reference');
    values.delete(value);
    values.set(value, retained);
    return retained.descriptor;
  }
  function referencedBytes(value: IntakeByteValue, pages: ReturnType<typeof tree>) {
    const retained = registryFor(db).byteValues.get(value);
    if (
      !retained ||
      retained.prefix !== prefix ||
      retained.logical !== JSON.stringify(selected().head?.logical ?? null) ||
      value.kind !== 'bytes' ||
      value.bytes !== retained.bytes ||
      value.chunks !== retained.count ||
      (retained.root?.count ?? 0) !== retained.count
    )
      invalid('foreign, stale or expired byte reference');
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
    operation: { kind: 'header' } | { kind: 'field'; name: string },
    area: IntakeCollectionArea,
    name: string,
  ): SchemaRecord | { target: SchemaTarget | undefined } {
    let admission:
      | {
          registry: Registry;
          schemaEpoch: object;
          epoch: object;
          witness: string;
          key: string;
          header: Readonly<SchemaRecord>;
          bytes: number;
        }
      | undefined;
    const result = runRead((_readTree, certificate) => {
      if (
        (mode !== 'raw' && mode !== 'normalized') ||
        typeof root !== 'string' ||
        !/^[a-f0-9]{64}$/.test(root) ||
        typeof id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(id) ||
        (fieldSelection !== 'first' && fieldSelection !== 'last') ||
        (operation.kind === 'field' && typeof operation.name !== 'string')
      )
        invalid('schema resolve arguments');
      collectionName(name);
      const registry = registryFor(db);
      // This fixed, synchronous owner operation shares its lexical certificate.
      // No callback, iterator or result escapes it; final ready() and the
      // runRead seal still check physical HEAD and the exact SQL witness.
      // Transactions retain all original point-operation observations.
      const collection = certificate
        ? descriptor(_readTree().get(readScope(view, area, certificate), name))
        : schemaReadOperations.collection(view, area, name);
      if (!collection) invalid('missing selected envelope data');
      const current = viewData(view);
      const key = JSON.stringify([
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
        id,
      ]);
      if (!certificate || registry.schemaRecordWitness !== certificate.witness) {
        registry.schemaRecords.clear();
        registry.schemaRecordBytes = 0;
        registry.schemaRecordEpoch = {};
        registry.schemaRecordWitness = certificate?.witness;
      }
      const schemaEpoch = registry.schemaRecordEpoch;
      const cached = certificate && registry.schemaRecords.get(key);
      const reusable =
        cached && cached.epoch === certificate!.epoch && cached.witness === certificate!.witness;
      if (cached && !reusable) {
        registry.schemaRecordBytes -= cached.bytes;
        registry.schemaRecords.delete(key);
      }
      const read = (key: string) =>
        certificate
          ? (() => {
              const raw = _readTree().get(collection.root, key);
              if (raw !== undefined) recordIntakeWork('collectionItemsRead');
              return raw === undefined ? undefined : publicValue(raw, collection.kind);
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
          const page = schemaReadOperations.readBytes(value, { after, items: 64, bytes: 4096 });
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
      const header = reusable
        ? cached.header
        : Object.freeze({
            ...resolveSchemaMetadata(text, () => root, id, fieldSelection),
          });
      if (reusable) {
        registry.schemaRecords.delete(key);
        registry.schemaRecords.set(key, cached);
      }
      const value =
        operation.kind === 'field'
          ? {
              target: resolveSchemaFieldTarget(
                header,
                id,
                operation.name,
                fieldSelection,
                read,
                text,
                chunks,
              ),
            }
          : { ...header };
      ready();
      if (certificate && !reusable) {
        const bytes =
          Buffer.byteLength(JSON.stringify({ key, header, witness: certificate.witness })) + 256;
        admission = {
          registry,
          schemaEpoch,
          epoch: certificate.epoch,
          witness: certificate.witness,
          key,
          header,
          bytes,
        };
      }
      return value;
    });
    // Admission follows the outer runRead final exact witness, never an optimistic result.
    if (
      admission &&
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
    return result;
  }
  const api = {
    prepareLegacyBridge(input: {
      operationId: string;
      requestDigest: string;
      domainVersion: number;
    }): PreparedIntakeCollectionMutation {
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
          return api.prepare(view, {
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
          });
        } finally {
          registryFor(db).views.delete(view);
        }
      });
    },
    readLegacyMaterialization(): IntakeStateMaterialization {
      return run(() => {
        const current = selected();
        if (!current.head) invalid('missing legacy bridge');
        validateIntakeLegacyBridgeControl(identity, current.head, (hash) =>
          get(prefix + 'node:' + hash),
        );
        const raw = tree().get(current.head.history, orderedKey(1));
        if (raw === undefined) invalid('missing retained legacy edge');
        const event = parseIntakeCollectionHistory(raw, identity);
        if (!event.previous || event.previous.format !== 'health-intake-legacy-v3')
          invalid('missing retained v3 authority');
        return owner.legacyMaterialization(event.previous.head);
      });
    },
    openView(): IntakeCollectionView {
      return runRead(() => {
        const view = Object.freeze({}) as IntakeCollectionView,
          registry = registryFor(db);
        registry.views.set(view, selected());
        // A live reader owns this opaque view until it lets go. Weak keys avoid
        // retaining discarded handles without evicting another active reader.
        return view;
      });
    },
    binding(view: IntakeCollectionView): IntakeCollectionHead | undefined {
      return runRead(() => {
        const value = viewData(view).head;
        return value && structuredClone(value);
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
    clearSchemaRecordCache(): void {
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
      return runRead((readTree) => {
        collectionName(name);
        const pages = readTree(),
          collection = descriptor(pages.get(readScope(view, area), name));
        const result = pages.get(collection?.root ?? null, key);
        if (result !== undefined) recordIntakeWork('collectionItemsRead');
        return result === undefined ? undefined : publicValue(result, collection!.kind);
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
      return runRead((readTree) => {
        collectionName(name);
        const pages = readTree(),
          source = descriptor(pages.get(readScope(view, area), name));
        const item = pages.preceding(source?.root ?? null, key);
        if (!item) return undefined;
        recordIntakeWork('collectionItemsRead');
        return { key: item.key, value: publicValue(item.value, source!.kind) };
      });
    },
    precedingReferenced(value: IntakeCollectionValue, key: string) {
      return runRead((readTree) => {
        const source = referenced(value),
          item = readTree().preceding(source.root, key);
        if (!item) return undefined;
        recordIntakeWork('collectionItemsRead');
        return { key: item.key, value: publicValue(item.value, source.kind) };
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
      return runRead((readTree) => {
        const source = referenced(value),
          raw = readTree().get(source.root, key);
        if (raw !== undefined) recordIntakeWork('collectionItemsRead');
        return raw === undefined ? undefined : publicValue(raw, source.kind);
      });
    },
    rankReferenced(value: IntakeCollectionValue, key: string): number {
      return runRead((readTree) => readTree().rank(referenced(value).root, key));
    },
    rangeReferenced(
      value: IntakeCollectionValue,
      options: { after?: string; items: number; bytes: number },
    ) {
      return runRead((readTree) => {
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
            value: publicValue(item.value, source.kind),
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
      return runRead((readTree) => {
        collectionName(name);
        integer(options.items, 1);
        integer(options.bytes, 1);
        if (options.items > 100 || options.bytes > 256 * 1024) invalid('collection range budget');
        // A scoped range retains the existing exclusive cursor. Its namespace
        // must contain that cursor, so the first different key proves completion.
        // Count below still describes the whole authenticated collection.
        const prefix = options.prefix,
          after = options.after;
        if (prefix !== undefined) {
          intakeTreeKey(prefix);
          if (typeof after !== 'string' || !after.startsWith(prefix))
            invalid('collection range cursor outside prefix');
        }
        const pages = readTree(),
          collection = descriptor(pages.get(readScope(view, area), name));
        const items: Array<{ key: string; value: string | IntakeByteValue }> = [];
        let bytes = 0,
          complete = true;
        for (const item of pages.entries(collection?.root ?? null, after)) {
          if (prefix !== undefined && !item.key.startsWith(prefix)) break;
          const size = Buffer.byteLength(item.key) + Buffer.byteLength(item.value);
          if (items.length === options.items || bytes + size > options.bytes) {
            complete = false;
            break;
          }
          items.push({
            key: item.key,
            value: publicValue(item.value, collection!.kind),
          });
          bytes += size;
          recordIntakeWork('collectionItemsRead');
        }
        // A caller must increase its per-item window, not loop forever on an
        // unchanging empty cursor. Stored values themselves are always bounded.
        if (!complete && !items.length) invalid('collection range item exceeds byte budget');
        return {
          items,
          bytes,
          complete,
          after: complete ? null : items.at(-1)!.key,
          count: collection?.root?.count ?? 0,
        };
      });
    },
    readBytes(value: IntakeByteValue, options: { after?: string; items: number; bytes: number }) {
      return runRead((readTree) => {
        selected();
        const retained = registryFor(db).byteValues.get(value);
        if (!retained || retained.prefix !== prefix) invalid('foreign or expired byte value');
        integer(options.items, 1);
        integer(options.bytes, 1);
        if (options.items > 64 || options.bytes > 256 * 1024) invalid('byte range budget');
        const chunks: Buffer[] = [];
        let bytes = 0,
          after: string | null = null,
          complete = true;
        for (const item of readTree().entries(retained.root, options.after)) {
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
      });
    },
    replay(operationId: string, requestDigest: string): IntakeCollectionResult | undefined {
      return runRead((readTree) => {
        uuid(operationId);
        return receipt(selected().head, operationId, requestDigest, readTree);
      });
    },
    prepare(
      view: IntakeCollectionView,
      input: IntakeCollectionMutation,
    ): PreparedIntakeCollectionMutation {
      // Do not inherit a caller's optimistic read, even if an input getter
      // starts this preparation from another read. Existing page-cache bounds
      // apply; SQL transactions retain the uncached, checked fallback.
      readEpoch = {};
      return runRead((readTree, certificate) => {
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
            const adopted = referencedBytes(change.value, pages);
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
                ? JSON.stringify(referenced(change.value))
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
        const receipts = pages.put(
          before.head?.receipts ?? null,
          input.operationId,
          JSON.stringify({
            format: 'health-intake-state-receipt-v4',
            requestDigest: input.requestDigest,
            result,
          }),
        );
        const history = pages.put(
          before.head?.history ?? null,
          orderedKey(sequence),
          JSON.stringify({
            format: 'health-intake-state-history-v4',
            operationId: input.operationId,
            previous: before.legacy
              ? { format: 'health-intake-legacy-v3', head: before.legacy }
              : (before.head ?? null),
            logical: result.logical,
            builds,
          }),
        );
        const head: IntakeCollectionHead = {
          format: COLLECTION_FORMAT,
          identity,
          storageSequence: sequence,
          logical: result.logical,
          receipts,
          history,
          builds,
        };
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
          ? prepareIntakeLegacyBridgeProof(db, {
              identity,
              beforeHead: before.raw!,
              afterHead: after,
              writes,
            })
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
        });
        // The candidate does not escape until its physical authority and
        // closing SQL/registry witness are checked. runRead invalidates every
        // provisional capability if this seal fails.
        ready();
        return prepared;
      });
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
        const data = inspect(prepared),
          current = data.legacyBridge ? { raw: get(headKey), head: undefined } : selected();
        if (data.legacyBridge && bridgeTransaction !== token)
          invalid('legacy bridge requires certified maintenance publication');
        const retained = receipt(current.head, data.result.operationId, data.requestDigest);
        if (retained) {
          discard(prepared);
          return structuredClone(retained);
        }
        if (current.raw !== data.before) invalid('stale collection preparation; reopen view');
        // Validate every new encoded page before publishing any row. Preparation
        // bytes are private; writes/readback remain inside the existing transaction.
        for (const row of data.writes) {
          if (row.key === headKey) continue;
          const existed = get(row.key) !== undefined;
          immutable(row.key, row.value);
          if (get(row.key) !== row.value) invalid('collection staged readback');
          if (!existed) {
            recordIntakeWork('collectionNodesWritten');
            recordIntakeWork('collectionWrittenBytes', Buffer.byteLength(row.value));
          }
        }
        db.prepare(
          'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        ).run(headKey, data.after);
        discard(prepared);
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
          current = data.legacyBridge ? { raw: get(headKey), head: undefined } : selected();
        const retained = receipt(current.head, data.result.operationId, data.requestDigest);
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
        });
        return transaction(
          db,
          () => {
            if (data.legacyBridge) bridgeTransaction = currentTransactionToken(db);
            try {
              return api.stage(prepared, options);
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
  const schemaReadOperations = Object.freeze({
    collection: api.collection,
    get: api.get,
    readBytes: api.readBytes,
  });
  const schemaMethods = Object.freeze({
    ...schemaReadOperations,
    openView: api.openView,
    binding: api.binding,
    resolveSchemaRecord: api.resolveSchemaRecord,
    resolveSchemaField: api.resolveSchemaField,
    clearSchemaRecordCache: api.clearSchemaRecordCache,
  });
  schemaRecordOwners.set(
    api,
    Object.freeze({
      resolve: api.resolveSchemaRecord,
      field: api.resolveSchemaField,
      clear: api.clearSchemaRecordCache,
      current: () =>
        Object.entries(schemaMethods).every(([name, method]) => {
          const descriptor = Object.getOwnPropertyDescriptor(api, name);
          return !!descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === method;
        }),
    }),
  );
  return api;
}
