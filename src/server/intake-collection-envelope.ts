import { types as utilTypes } from 'node:util';
import {
  resolveSchemaMetadata,
  resolveSchemaFieldTarget,
  schemaResolvedHeader,
  schemaResolvedTarget,
  schemaResolvedOrder,
} from './intake-schema-record-resolution.ts';
import type { Database } from './database.ts';
import {
  intakeEnvelopeAuthorityBinding,
  readIntakeEnvelopeMaterialized,
  type IntakeEnvelopeSource,
} from './intake-authority.ts';
import { INTAKE_LEGACY_BRIDGE_CONTROL } from './intake-state-migration.ts';
import {
  createIntakeStateStorage,
  type IntakeByteValue,
  type IntakeCollectionArea,
} from './intake-state-storage.ts';
import { validateIntakeIdentity, type IntakeCollectionHead } from './intake-state-evidence.ts';
import { createIntakeTree } from './intake-state-tree.ts';
import {
  parseIntakeCollectionDescriptor,
  parseIntakeStoredValue,
  intakeCollectionCacheGeneration,
  intakeSchemaRecordOwner,
} from './intake-state-collections.ts';
import {
  parseSchemaControl,
  schemaKey,
  schemaOrdinal,
  type SchemaControl,
  type SchemaOrder,
  type SchemaRecord,
  type SchemaTarget,
} from './intake-envelope-schema.ts';
import { iterateIntakeJsonVerification } from './intake-json-verify.ts';
import { hashIntakeJsonScalar, hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';
import { validateIntakeSchemaReachabilitySteps } from './intake-envelope-schema-validation.ts';

declare const recordBrand: unique symbol;
export interface IntakeEnvelopeRecord {
  readonly [recordBrand]: true;
  readonly kind: string;
}
export type IntakeEnvelopeField =
  { kind: 'missing' } | { kind: 'value'; value: unknown } | { kind: 'fragmented'; bytes: number };
export interface IntakeEnvelopeRecordPage {
  records: IntakeEnvelopeRecord[];
  total: number;
  complete: boolean;
  after: string | null;
}
export interface IntakeCollectionEnvelopeReader {
  readonly logical: IntakeCollectionHead['logical'];
  root(): IntakeEnvelopeRecord;
  recordChunks(record: IntakeEnvelopeRecord): Iterable<string>;
  subtree(
    record: IntakeEnvelopeRecord,
    options?: { fieldSelection?: 'first' | 'last' },
  ): IntakeCollectionEnvelopeReader;
  address(record: IntakeEnvelopeRecord): string;
  resolve(address: string): IntakeEnvelopeRecord;
  info(record: IntakeEnvelopeRecord): { shape: 'object' | 'array' | 'scalar'; count: number };
  child(record: IntakeEnvelopeRecord, field: string): IntakeEnvelopeRecord | undefined;
  has(record: IntakeEnvelopeRecord, field: string): boolean;
  contains(
    record: IntakeEnvelopeRecord,
    field: string,
    value: string | number | boolean | null,
  ): boolean;
  field(
    record: IntakeEnvelopeRecord,
    field: string,
    options?: { bytes: number },
  ): IntakeEnvelopeField;
  fields(
    record: IntakeEnvelopeRecord,
    options: { after?: string; items: number; bytes: number },
  ): {
    fields: Array<{ name: string; kind: 'record' | 'cell' }>;
    total: number;
    complete: boolean;
    after: string | null;
  };
  children(
    record: IntakeEnvelopeRecord,
    field: string,
    options: { after?: string; items: number; bytes: number },
  ): IntakeEnvelopeRecordPage;
  childCount(record: IntakeEnvelopeRecord, field: string): number;
  childAt(
    record: IntakeEnvelopeRecord,
    field: string,
    index: number,
  ): IntakeEnvelopeRecord | undefined;
  find(
    kind: string,
    parent: IntakeEnvelopeRecord,
    publicId: string,
    options?: { match?: 'first' | 'last' },
  ): IntakeEnvelopeRecord | undefined;
  lookup(index: string, key: readonly string[]): IntakeEnvelopeRecord | undefined;
  propertyRecords(
    record: IntakeEnvelopeRecord,
    options: { after?: string; items: number; bytes: number },
  ): IntakeEnvelopeRecordPage;
  fieldChunks(record: IntakeEnvelopeRecord, field: string): Iterable<string>;
  fieldFragment(
    record: IntakeEnvelopeRecord,
    field: string,
    options: { after?: string; bytes: number },
  ): { text: string; complete: boolean; after: string | null };
}
export interface EnvelopeCellReader {
  get(key: string): string | IntakeByteValue | undefined;
  range(
    after: string,
    items: number,
    bytes: number,
    /** Optional contiguous key scope; older/custom stores may ignore it. */
    prefix?: string,
  ): { items: Array<{ key: string; value: string | IntakeByteValue }>; complete: boolean };
  chunks(
    value: IntakeByteValue,
    after?: string,
    bytes?: number,
  ): { chunks: Buffer[]; complete: boolean; after: string | null };
  check(): void;
}
export interface IntakeEnvelopeFieldAccess {
  /** Resolve one named field once and stream its exact selected lexical value.
   * Missing is distinct from a present JSON null. No values are retained. */
  chunks(record: IntakeEnvelopeRecord, name: string): Iterable<string> | undefined;
  nameBytes(record: IntakeEnvelopeRecord, key: string): number;
  descriptors(
    record: IntakeEnvelopeRecord,
    options: { after?: string; items: number; bytes: number },
  ): {
    fields: Array<{ key: string; name?: string; nameBytes: number; kind: 'record' | 'cell' }>;
    total: number;
    complete: boolean;
    after: string | null;
  };
  value(
    record: IntakeEnvelopeRecord,
    key: string,
    options?: { bytes: number },
  ): IntakeEnvelopeField;
  child(record: IntakeEnvelopeRecord, key: string): IntakeEnvelopeRecord | undefined;
  nameFragment(
    record: IntakeEnvelopeRecord,
    key: string,
    options: { after?: string; bytes: number },
  ): { text: string; complete: boolean; after: string | null };
  valueFragment(
    record: IntakeEnvelopeRecord,
    key: string,
    options: { after?: string; bytes: number },
  ): { text: string; complete: boolean; after: string | null };
}
const fieldAccessors = new WeakMap<IntakeCollectionEnvelopeReader, IntakeEnvelopeFieldAccess>();
const recordOrders = new WeakMap<
  IntakeCollectionEnvelopeReader,
  (record: IntakeEnvelopeRecord) => readonly number[]
>();
const propertyOrders = new WeakMap<
  IntakeCollectionEnvelopeReader,
  (record: IntakeEnvelopeRecord) => readonly [0 | 1, number]
>();
export function intakeEnvelopePropertyOrder(
  reader: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
): readonly [0 | 1, number] {
  return propertyOrders.get(reader)?.(record) ?? fail('foreign property order reader');
}
export function intakeEnvelopeRecordOrder(
  reader: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
): readonly number[] {
  return recordOrders.get(reader)?.(record) ?? fail('foreign record order reader');
}

const compactProjectors = new WeakMap<IntakeCollectionEnvelopeReader, (bytes: number) => string>();
/** Exact compact source projection, including raw known-key duplicates and spelling.
 * The caller supplies a bounded metadata budget and publishes the source row in
 * the same normal transaction as the selected envelope change. */
export function projectIntakeEnvelopeMetadata(
  reader: IntakeCollectionEnvelopeReader,
  options: { bytes: number },
): string {
  if (!Number.isSafeInteger(options.bytes) || options.bytes < 1)
    throw Error('Invalid compact metadata budget');
  const project = compactProjectors.get(reader);
  if (!project) return fail('foreign metadata reader');
  return project(options.bytes);
}

export function intakeEnvelopeFieldAccess(
  reader: IntakeCollectionEnvelopeReader,
): IntakeEnvelopeFieldAccess {
  return fieldAccessors.get(reader) ?? fail('foreign field reader');
}
const fail = (reason: string): never => {
  throw Error(`Intake collection envelope: ${reason}`);
};
function textValue(store: EnvelopeCellReader, key: string, max = 8192): string {
  const value = store.get(key);
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > max) fail('field exceeds bounded header');
    return value;
  }
  if (!value || value.bytes > max) return fail('missing or fragmented schema header');
  let result = '';
  for (const text of cellChunks(store, key)) result += text;
  return result;
}
function* cellChunks(store: EnvelopeCellReader, key: string): Generator<string> {
  const value = store.get(key);
  if (value === undefined) return fail('missing exact lexical cell');
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
    read = 0;
  do {
    const page = store.chunks(value, after, 4096);
    for (const bytes of page.chunks) {
      read += bytes.length;
      const text = decoder.decode(bytes, { stream: true });
      if (text) yield text;
    }
    if (page.complete) break;
    if (!page.after || page.after === after) fail('byte cursor did not advance');
    after = page.after!;
  } while (true);
  const tail = decoder.decode();
  if (tail) yield tail;
  if (read !== value.bytes) fail('lexical cell byte count');
}
function target(value: unknown): SchemaTarget {
  return schemaResolvedTarget(value);
}
function header(store: EnvelopeCellReader, id: string): SchemaRecord {
  if (!/^[a-f0-9]{64}$/.test(id)) return fail('record address');
  return schemaResolvedHeader(textValue(store, 'r:' + id));
}
function order(value: string | IntakeByteValue): SchemaOrder {
  if (typeof value !== 'string') return fail('fragmented order entry');
  return schemaResolvedOrder(value);
}
function* orderEntries(store: EnvelopeCellReader, id: string): Generator<SchemaOrder> {
  const prefix = 'o:' + id + ':';
  let after = prefix,
    seen = 0;
  do {
    const page = store.range(after, 64, 32768, prefix);
    for (const item of page.items) {
      if (!item.key.startsWith(prefix)) {
        if (seen !== header(store, id).count) fail('record count');
        return;
      }
      if (!/^\d{16}$/.test(item.key.slice(prefix.length))) fail('record order key');
      seen++;
      yield order(item.value);
      after = item.key;
    }
    if (page.complete) break;
    if (!page.items.length) fail('order cursor');
  } while (true);
  if (seen !== header(store, id).count) fail('record count');
}
export function* iterateSchemaEnvelopeText(
  store: EnvelopeCellReader,
  control: SchemaControl,
): Generator<string> {
  function* record(id: string, depth: number): Generator<string> {
    if (depth > 128) fail('schema record depth');
    const meta = header(store, id);
    if (meta.shape === 'scalar') {
      yield* cellChunks(store, 'c:' + id);
      return;
    }
    for (const entry of orderEntries(store, id)) {
      yield* cellChunks(store, 'c:' + entry.prefix);
      if (entry.target.type === 'record') yield* record(entry.target.id, depth + 1);
      else yield* cellChunks(store, 'c:' + entry.target.id);
    }
    yield* cellChunks(store, 's:' + id);
  }
  store.check();
  yield* cellChunks(store, '$before');
  yield* record(control.root, 0);
  yield* cellChunks(store, '$after');
  store.check();
}
function* iterateSchemaRecordValue(
  store: EnvelopeCellReader,
  id: string,
  depth = 0,
): Generator<string> {
  if (depth > 128) fail('record depth');
  const meta = header(store, id);
  if (meta.shape === 'scalar') {
    yield* cellChunks(store, 'c:' + id);
    return;
  }
  for (const entry of orderEntries(store, id)) {
    yield* cellChunks(store, 'c:' + entry.prefix);
    if (entry.target.type === 'record')
      yield* iterateSchemaRecordValue(store, entry.target.id, depth + 1);
    else yield* cellChunks(store, 'c:' + entry.target.id);
  }
  yield* cellChunks(store, 's:' + id);
}
const schemaResolutionOwners = new WeakMap<
  EnvelopeCellReader,
  {
    methods: readonly Function[];
    resolve: (
      mode: 'raw' | 'normalized',
      root: string,
      id: string,
      selection: 'first' | 'last',
    ) => SchemaRecord;
    field: (
      mode: 'raw' | 'normalized',
      root: string,
      id: string,
      selection: 'first' | 'last',
      name: string,
    ) => { target: SchemaTarget | undefined };
    clear: () => void;
    current: () => boolean;
  }
>();
function inertSchemaControl(control: SchemaControl): string | undefined {
  if (!control || typeof control !== 'object' || utilTypes.isProxy(control)) return undefined;
  const values: unknown[] = [];
  for (const name of ['format', 'mode', 'root']) {
    const descriptor = Object.getOwnPropertyDescriptor(control, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string')
      return undefined;
    values.push(descriptor.value);
  }
  if (
    values[0] !== 'health-intake-record-envelope-v1' ||
    !['raw', 'normalized'].includes(values[1] as string) ||
    !/^[a-f0-9]{64}$/.test(values[2] as string)
  )
    return undefined;
  return JSON.stringify(values);
}
export function createSchemaEnvelopeReader(
  store: EnvelopeCellReader,
  control: SchemaControl,
  logical: IntakeCollectionHead['logical'],
  lookup?: (name: string, key: readonly string[]) => string | undefined,
  fieldSelection: 'first' | 'last' = 'last',
): IntakeCollectionEnvelopeReader {
  const handles = new WeakMap<IntakeEnvelopeRecord, string>();
  const capturedControl = inertSchemaControl(control);
  const ownedRead = (
    id: string,
    operation: { kind: 'header' } | { kind: 'field'; name: string },
  ): SchemaRecord | { target: SchemaTarget | undefined } | undefined => {
    const owner = schemaResolutionOwners.get(store);
    if (!owner) return undefined;
    const validMethods = ['get', 'check', 'range', 'chunks'].every((name, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(store, name);
      return (
        !!descriptor &&
        Object.hasOwn(descriptor, 'value') &&
        descriptor.value === owner.methods[index]
      );
    });
    const currentControl = inertSchemaControl(control);
    if (
      typeof id !== 'string' ||
      !validMethods ||
      !owner.current() ||
      !capturedControl ||
      currentControl !== capturedControl ||
      (fieldSelection !== 'first' && fieldSelection !== 'last')
    ) {
      owner.clear();
      return undefined;
    }
    const [, mode, root] = JSON.parse(capturedControl) as [string, 'raw' | 'normalized', string];
    const result =
      operation.kind === 'field'
        ? owner.field(mode, root, id, fieldSelection, operation.name)
        : owner.resolve(mode, root, id, fieldSelection);
    if (
      inertSchemaControl(control) !== capturedControl ||
      !owner.current() ||
      !['get', 'check', 'range', 'chunks'].every((name, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(store, name);
        return (
          !!descriptor &&
          Object.hasOwn(descriptor, 'value') &&
          descriptor.value === owner.methods[index]
        );
      })
    ) {
      owner.clear();
      fail('schema resolve authority changed');
    }
    return result;
  };
  const ownedHeader = (id: string) => ownedRead(id, { kind: 'header' }) as SchemaRecord | undefined;
  const checkedHeader = (id: string): SchemaRecord => ownedHeader(id) ?? header(store, id);
  const resolve = (id: string): IntakeEnvelopeRecord => {
    store.check();
    const meta =
      ownedHeader(id) ??
      resolveSchemaMetadata(
        (key) => textValue(store, key),
        () => control.root,
        id,
        fieldSelection,
      );
    const handle = Object.freeze({ kind: meta.kind }) as IntakeEnvelopeRecord;
    handles.set(handle, id);
    return handle;
  };
  const address = (record: IntakeEnvelopeRecord): string => {
    store.check();
    return handles.get(record) ?? fail('foreign record handle');
  };
  const fieldTarget = (record: IntakeEnvelopeRecord, name: string): SchemaTarget | undefined => {
    const id = address(record);
    const owned = ownedRead(id, { kind: 'field', name }) as
      { target: SchemaTarget | undefined } | undefined;
    if (owned) return owned.target;
    return resolveSchemaFieldTarget(
      checkedHeader(id),
      id,
      name,
      fieldSelection,
      (key) => store.get(key),
      (key) => textValue(store, key),
      (key) => cellChunks(store, key),
    );
  };
  const verifiedNames = new Set<string>();
  const keyedField = (record: IntakeEnvelopeRecord, key: string, verifyName = false) => {
    const id = address(record),
      prefix = 'f:' + id + ':';
    if (!key.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(key.slice(prefix.length)))
      fail('foreign addressed field');
    const stored = store.get(key);
    if (typeof stored !== 'string') return fail('missing addressed field');
    const selected = target(JSON.parse(stored)),
      ordinal = Number(
        textValue(
          store,
          (fieldSelection === 'first' ? 'b:' : 'l:') + id + ':' + key.slice(prefix.length),
        ),
      );
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) fail('addressed field ordinal');
    const entry = order(textValue(store, 'o:' + id + ':' + schemaOrdinal(ordinal)));
    if (
      entry.name === undefined ||
      (fieldSelection === 'last' && JSON.stringify(entry.target) !== JSON.stringify(selected))
    )
      fail('addressed field/order mismatch');
    if (verifyName && !verifiedNames.has(key)) {
      if (
        hashIntakeJsonScalar(cellChunks(store, 'n:' + entry.name)).hash !== key.slice(prefix.length)
      )
        fail('addressed field name mismatch');
      verifiedNames.add(key);
      while (verifiedNames.size > 128) verifiedNames.delete(verifiedNames.values().next().value!);
    } else if (verifyName) {
      verifiedNames.delete(key);
      verifiedNames.add(key);
    }
    return {
      target: fieldSelection === 'first' ? entry.target : selected,
      name: 'n:' + entry.name,
    };
  };
  const utf8Tail = (data: Buffer): number => {
    if (!data.length) return 0;
    let at = data.length - 1;
    while (at >= 0 && (data[at]! & 0xc0) === 0x80) at--;
    if (at < 0) return 0;
    const lead = data[at]!,
      expected =
        lead >= 0xc2 && lead <= 0xdf
          ? 2
          : lead >= 0xe0 && lead <= 0xef
            ? 3
            : lead >= 0xf0 && lead <= 0xf4
              ? 4
              : 1;
    return data.length - at < expected ? data.length - at : 0;
  };
  const fragment = (key: string, options: { after?: string; bytes: number }) => {
    if (!Number.isSafeInteger(options.bytes) || options.bytes < 4096 || options.bytes > 65536)
      fail('fragment budget');
    const value = store.get(key);
    if (value === undefined) return fail('missing fragment cell');
    if (typeof value === 'string') {
      const match = options.after === undefined ? undefined : /^u8i:([0-9]+)$/.exec(options.after);
      if (options.after && !match) fail('inline fragment cursor');
      const offset = match ? Number(match[1]) : 0,
        data = Buffer.from(value);
      if (!Number.isSafeInteger(offset) || offset < 0 || (offset >= data.length && offset !== 0))
        fail('inline fragment offset');
      let end = Math.min(offset + options.bytes, data.length);
      if (end < data.length) end -= utf8Tail(data.subarray(offset, end));
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, end));
      return {
        text,
        complete: end === data.length,
        after: end === data.length ? null : 'u8i:' + end,
      };
    }
    const continuation = options.after?.startsWith('u8:')
      ? /^u8:([0-9]{16}|):([0-9]{1,4})$/.exec(options.after)
      : undefined;
    if (options.after?.startsWith('u8:') && !continuation) fail('UTF-8 fragment cursor');
    const after = continuation ? continuation[1] || undefined : options.after,
      skip = continuation ? Number(continuation[2]) : 0;
    const result = store.chunks(value, after, options.bytes + (skip ? 4096 : 0));
    if (skip && (!result.chunks.length || skip >= result.chunks[0]!.length))
      fail('UTF-8 fragment offset');
    const chunks = result.chunks.map((chunk, index) =>
        index === 0 && skip ? chunk.subarray(skip) : chunk,
      ),
      data = Buffer.concat(chunks);
    let end = Math.min(data.length, options.bytes);
    if (!result.complete || end < data.length) end -= utf8Tail(data.subarray(0, end));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, end));
    if (result.complete && end === data.length) return { text, complete: true, after: null };
    if (end === data.length) return { text, complete: false, after: result.after };
    if (!result.after) fail('UTF-8 fragment did not advance');
    let index = 0,
      offset = end;
    while (index < chunks.length - 1 && offset >= chunks[index]!.length) {
      offset -= chunks[index]!.length;
      index++;
    }
    const ordinal = Number(result.after) - (chunks.length - 1 - index);
    offset += index === 0 ? skip : 0;
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) fail('UTF-8 fragment ordinal');
    return {
      text,
      complete: false,
      after: 'u8:' + (ordinal ? schemaOrdinal(ordinal - 1) : '') + ':' + offset,
    };
  };
  const child = (record: IntakeEnvelopeRecord, name: string) => {
    const item = fieldTarget(record, name);
    if (name === 'metadataHistory' && item?.type === 'cell')
      fail('metadata history requires explicit structured-field upgrade');
    return item?.type === 'record' ? resolve(item.id) : undefined;
  };
  const page = (
    record: IntakeEnvelopeRecord,
    options: { after?: string; items: number; bytes: number },
    properties = false,
  ): IntakeEnvelopeRecordPage => {
    const id = address(record),
      meta = checkedHeader(id),
      prefix = 'o:' + id + ':';
    if (
      !Number.isSafeInteger(options.items) ||
      options.items < 1 ||
      options.items > 100 ||
      !Number.isSafeInteger(options.bytes) ||
      options.bytes < 1 ||
      options.bytes > 256 * 1024
    )
      fail('page budget');
    if (options.after && !options.after.startsWith(prefix)) fail('foreign record cursor');
    const rows = store.range(options.after ?? prefix, options.items, options.bytes),
      records: IntakeEnvelopeRecord[] = [];
    let after: string | null = null,
      ended = false;
    for (const item of rows.items) {
      if (!item.key.startsWith(prefix)) {
        ended = true;
        break;
      }
      const entry = order(item.value);
      if (entry.target.type !== 'record') {
        if (properties) continue;
        fail('array item is not a selected record');
      }
      records.push(resolve(entry.target.id));
      after = item.key;
    }
    const complete = ended || rows.complete;
    return { records, total: meta.count, complete, after: complete ? null : after };
  };
  const view: IntakeCollectionEnvelopeReader = {
    logical: structuredClone(logical),
    root: () => resolve(control.root),
    *recordChunks(record) {
      yield* iterateSchemaRecordValue(store, address(record));
      store.check();
    },
    subtree(record, options = {}) {
      const id = address(record);
      return createSchemaEnvelopeReader(
        store,
        { ...control, root: id },
        logical,
        undefined,
        options.fieldSelection ?? fieldSelection,
      );
    },
    address,
    resolve,
    info: (record) => {
      const { shape, count } = checkedHeader(address(record));
      return {
        shape,
        count: shape === 'object' ? Number(textValue(store, 'u:' + address(record))) : count,
      };
    },
    child,
    has: (record, name) => fieldTarget(record, name) !== undefined,
    contains(record, name, value) {
      const array = child(record, name);
      if (!array) return false;
      const item = store.get('m:' + address(array) + ':' + schemaKey(value));
      if (item === undefined) return false;
      if (typeof item !== 'string') fail('scalar membership');
      const member = resolve(item as string);
      const edge = JSON.parse(textValue(store, 'p:' + address(member))) as { parent: string };
      if (edge.parent !== address(array)) fail('foreign scalar membership');
      const actual = hashIntakeJsonScalar(cellChunks(store, 'c:' + address(member)));
      if (actual.hash !== schemaKey(value)) fail('scalar membership disagreement');
      return true;
    },
    field(record, name, options = { bytes: 65536 }) {
      if (!Number.isSafeInteger(options.bytes) || options.bytes < 1 || options.bytes > 256 * 1024)
        fail('field budget');
      const item = fieldTarget(record, name);
      if (!item) return { kind: 'missing' };
      if (item.type === 'record') return { kind: 'fragmented', bytes: 0 };
      const value = store.get('c:' + item.id);
      if (value === undefined) fail('missing field cell');
      const bytes = typeof value === 'string' ? Buffer.byteLength(value) : value!.bytes;
      if (bytes > options.bytes) return { kind: 'fragmented', bytes };
      return { kind: 'value', value: JSON.parse(textValue(store, 'c:' + item.id, options.bytes)) };
    },
    fields(record, options) {
      const id = address(record),
        prefix = 'f:' + id + ':';
      if (options.after && !options.after.startsWith(prefix)) fail('foreign field cursor');
      const rows = store.range(options.after ?? prefix, options.items, options.bytes),
        fields: Array<{ name: string; kind: 'record' | 'cell' }> = [];
      let after: string | null = null,
        ended = false,
        bytes = 0,
        budgetEnded = false;
      for (const item of rows.items) {
        if (!item.key.startsWith(prefix)) {
          ended = true;
          break;
        }
        const ordinal = Number(
            textValue(
              store,
              (fieldSelection === 'first' ? 'b:' : 'l:') + id + ':' + item.key.slice(prefix.length),
            ),
          ),
          entry = order(textValue(store, 'o:' + id + ':' + schemaOrdinal(ordinal)));
        if (entry.name === undefined) fail('field name missing');
        const name = JSON.parse(textValue(store, 'n:' + entry.name, 256 * 1024)) as string;
        const selected = fieldTarget(record, name);
        if (!selected || schemaKey(name) !== item.key.slice(prefix.length))
          fail('field key disagreement');
        const entryBytes = Buffer.byteLength(JSON.stringify({ name, kind: selected!.type }));
        if (bytes + entryBytes > options.bytes) {
          budgetEnded = true;
          break;
        }
        bytes += entryBytes;
        fields.push({ name, kind: selected!.type });
        after = item.key;
      }
      const total = Number(textValue(store, 'u:' + id));
      if (!Number.isSafeInteger(total) || total < 0) fail('unique property count');
      if (budgetEnded && !fields.length) fail('field name requires fragment access');
      return {
        fields,
        total,
        complete: !budgetEnded && (ended || rows.complete),
        after: !budgetEnded && (ended || rows.complete) ? null : after,
      };
    },
    children(record, name, options) {
      const nested = child(record, name);
      if (!nested) return { records: [], total: 0, complete: true, after: null };
      return page(nested, options);
    },
    childCount(record, name) {
      const nested = child(record, name);
      return nested ? view.info(nested).count : 0;
    },
    childAt(record, name, index) {
      if (!Number.isSafeInteger(index) || index < 0) fail('child index');
      const array = child(record, name);
      if (!array) return undefined;
      const id = address(array),
        meta = checkedHeader(id);
      if (meta.shape !== 'array') fail('child index requires array');
      if (index >= meta.count) return undefined;
      const entry = order(textValue(store, 'o:' + id + ':' + schemaOrdinal(index)));
      if (entry.target.type !== 'record') fail('indexed array item');
      return resolve(entry.target.id);
    },
    find(kind, parent, publicId, options = {}) {
      if (fieldSelection === 'first')
        fail('public identity index requires operational field selection');
      const value = store.get(
        (options.match === 'last' ? 'j:' : 'i:') +
          address(parent) +
          ':' +
          schemaKey(kind, publicId),
      );
      if (value === undefined) return undefined;
      const record = resolve(typeof value === 'string' ? value : fail('public identity index'));
      const id = view.field(record, 'id');
      const edge = JSON.parse(textValue(store, 'p:' + address(record))) as { parent: string };
      const owner = JSON.parse(textValue(store, 'p:' + edge.parent)) as { parent: string };
      if (
        record.kind !== kind ||
        id.kind !== 'value' ||
        id.value !== publicId ||
        owner.parent !== address(parent)
      )
        fail('public identity index target');
      return record;
    },
    lookup(name, key) {
      if (!lookup) fail('semantic indexes are incomplete');
      const id = lookup!(name, key);
      return id === undefined ? undefined : resolve(id);
    },
    propertyRecords(record, options) {
      const page = view.fields(record, options);
      return {
        records: page.fields.map(
          (field) => view.child(record, field.name) ?? fail('dictionary property is not a record'),
        ),
        total: page.total,
        complete: page.complete,
        after: page.after,
      };
    },
    *fieldChunks(record, name) {
      const item = fieldTarget(record, name);
      if (!item) fail('missing field');
      if (item!.type !== 'cell') fail('structured field requires child traversal');
      yield* cellChunks(store, 'c:' + item!.id);
    },
    fieldFragment(record, name, options) {
      const item = fieldTarget(record, name);
      if (!item || item.type !== 'cell') return fail('field requires scalar fragment');
      return fragment('c:' + item.id, options);
    },
  };
  propertyOrders.set(view, (record) => {
    const id = address(record);
    resolve(id);
    if (id === control.root) fail('property order requires dictionary child');
    const edge = JSON.parse(textValue(store, 'p:' + id)) as {
      parent: string;
      ordinal: number;
      field: string | null;
    };
    if (edge.field === null || checkedHeader(edge.parent).shape !== 'object')
      fail('property order requires dictionary child');
    const first = Number(textValue(store, 'b:' + edge.parent + ':' + edge.field));
    if (!Number.isSafeInteger(first) || first < 0) fail('first property ordinal');
    const item = order(textValue(store, 'o:' + edge.parent + ':' + schemaOrdinal(first)));
    if (item.name === undefined) fail('missing property name');
    let name = '';
    const tooLong = Symbol('noninteger name');
    try {
      hashIntakeJsonScalar(cellChunks(store, 'n:' + item.name), [], (unit) => {
        if (name.length === 10) throw tooLong;
        name += unit;
      });
    } catch (error) {
      if (error === tooLong) return Object.freeze([1, first] as const);
      throw error;
    }
    const integer = /^(0|[1-9][0-9]*)$/.test(name) ? Number(name) : -1;
    return Object.freeze(
      integer >= 0 && integer < 4294967295 ? ([0, integer] as const) : ([1, first] as const),
    );
  });
  recordOrders.set(view, (record) => {
    let cursor = address(record);
    resolve(cursor);
    const result: number[] = [];
    while (cursor !== control.root) {
      if (result.length >= 128) fail('record ancestry');
      const edge = JSON.parse(textValue(store, 'p:' + cursor)) as {
        parent: string;
        ordinal: number;
      };
      if (!Number.isSafeInteger(edge.ordinal) || edge.ordinal < 0) fail('record ordinal');
      result.push(edge.ordinal);
      cursor = edge.parent;
    }
    return Object.freeze(result.reverse());
  });
  fieldAccessors.set(view, {
    chunks(record, name) {
      const item = fieldTarget(record, name);
      store.check();
      if (!item) return undefined;
      if (name === 'metadataHistory' && item.type === 'cell')
        fail('metadata history requires explicit structured-field upgrade');
      const selected =
        item.type === 'record'
          ? iterateSchemaRecordValue(store, address(resolve(item.id)))
          : cellChunks(store, 'c:' + item.id);
      return (function* () {
        store.check();
        for (const chunk of selected) {
          store.check();
          yield chunk;
        }
        store.check();
      })();
    },
    nameBytes(record, key) {
      const value = store.get(keyedField(record, key).name);
      if (value === undefined) fail('missing field name');
      return typeof value === 'string' ? Buffer.byteLength(value) : value!.bytes;
    },
    descriptors(record, options) {
      const id = address(record),
        prefix = 'f:' + id + ':';
      if (options.after && !options.after.startsWith(prefix))
        fail('foreign addressed field cursor');
      const rows = store.range(options.after ?? prefix, options.items, options.bytes),
        fields: Array<{ key: string; name?: string; nameBytes: number; kind: 'record' | 'cell' }> =
          [];
      let after: string | null = null,
        ended = false,
        full = false,
        bytes = 0;
      for (const row of rows.items) {
        if (!row.key.startsWith(prefix)) {
          ended = true;
          break;
        }
        const entry = keyedField(record, row.key, true),
          value = store.get(entry.name);
        if (value === undefined) fail('missing field name');
        const nameBytes = typeof value === 'string' ? Buffer.byteLength(value) : value!.bytes;
        const name =
          nameBytes <= 2048
            ? (JSON.parse(textValue(store, entry.name, 2048)) as string)
            : undefined;
        const item = {
          key: row.key,
          ...(name === undefined ? {} : { name }),
          nameBytes,
          kind: entry.target.type,
        };
        const size = Buffer.byteLength(JSON.stringify(item));
        if (bytes + size > options.bytes) {
          full = true;
          break;
        }
        bytes += size;
        fields.push(item);
        after = row.key;
      }
      if (full && !fields.length) fail('field descriptor page too small');
      const total = Number(textValue(store, 'u:' + id));
      if (!Number.isSafeInteger(total) || total < 0) fail('unique property count');
      const complete = !full && (ended || rows.complete);
      return { fields, total, complete, after: complete ? null : after };
    },
    value(record, key, options = { bytes: 65536 }) {
      if (!Number.isSafeInteger(options.bytes) || options.bytes < 1 || options.bytes > 256 * 1024)
        fail('field budget');
      const entry = keyedField(record, key);
      if (entry.target.type === 'record') return { kind: 'fragmented', bytes: 0 };
      const value = store.get('c:' + entry.target.id);
      if (value === undefined) fail('missing field cell');
      const bytes = typeof value === 'string' ? Buffer.byteLength(value) : value!.bytes;
      return bytes > options.bytes
        ? { kind: 'fragmented', bytes }
        : {
            kind: 'value',
            value: JSON.parse(textValue(store, 'c:' + entry.target.id, options.bytes)),
          };
    },
    child(record, key) {
      const entry = keyedField(record, key);
      return entry.target.type === 'record' ? resolve(entry.target.id) : undefined;
    },
    nameFragment(record, key, options) {
      return fragment(keyedField(record, key).name, options);
    },
    valueFragment(record, key, options) {
      const entry = keyedField(record, key);
      if (entry.target.type !== 'cell') return fail('structured addressed field');
      return fragment('c:' + entry.target.id, options);
    },
  });
  compactProjectors.set(view, (bytes) => {
    store.check?.();
    return projectSchemaCompactMetadata(store, control, bytes);
  });
  return view;
}
const selectedStorageHandles = new WeakMap<
  Database,
  {
    generation: object;
    handles: Map<string, ReturnType<typeof createIntakeStateStorage>['collections']>;
  }
>();
export function selectedEnvelopeStore(db: Database, input: IntakeEnvelopeSource) {
  const source = db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(input.id) as unknown as IntakeEnvelopeSource | undefined;
  if (!source || source.kind !== 'intake_original') return fail('missing original source');
  const identity = validateIntakeIdentity({
    profileId: db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()
      ?.value as string,
    intakeId: source.id,
    sourceHash: source.sha256 as string,
  });
  const binding = intakeEnvelopeAuthorityBinding(db, source),
    generation = intakeCollectionCacheGeneration(db),
    key = JSON.stringify(identity);
  let retained = selectedStorageHandles.get(db);
  if (!retained || retained.generation !== generation) {
    retained = { generation, handles: new Map() };
    selectedStorageHandles.set(db, retained);
  }
  let collections = retained.handles.get(key);
  if (collections) retained.handles.delete(key);
  else collections = createIntakeStateStorage(db, identity).collections;
  retained.handles.set(key, collections);
  if (retained.handles.size > 32) retained.handles.delete(retained.handles.keys().next().value!);
  return { source, identity, binding, collections };
}
export function collectionCellReader(
  db: Database,
  input: IntakeEnvelopeSource,
  area: IntakeCollectionArea = 'logical',
  collection = 'envelope.data',
): {
  store: EnvelopeCellReader;
  head: IntakeCollectionHead;
  collections: ReturnType<typeof createIntakeStateStorage>['collections'];
} {
  const { source, binding, collections } = selectedEnvelopeStore(db, input);
  let view = collections.openView();
  const head = collections.binding(view);
  if (!head) return fail('missing collection head');
  const check = () => {
    const current = selectedEnvelopeStore(db, source);
    if (
      current.source.details_json !== source.details_json ||
      current.source.sha256 !== source.sha256 ||
      current.binding.logicalHead !== binding.logicalHead
    )
      fail('stale logical envelope');
    view = collections.openView();
  };
  const store: EnvelopeCellReader = {
    check,
    get: (key) => collections.get(view, area, collection, key),
    range: (after, items, bytes) =>
      collections.range(view, area, collection, { after, items, bytes }),
    chunks: (value, after, bytes = 4096) =>
      collections.readBytes(value, { after, items: 64, bytes }),
  };
  const owner = intakeSchemaRecordOwner(collections);
  if (owner && ((area === 'logical' && collection === 'envelope.data') || area === 'builds'))
    schemaResolutionOwners.set(store, {
      methods: Object.freeze([store.get, store.check, store.range, store.chunks]),
      resolve: (mode, root, id, selection) =>
        owner.resolve(view, mode, root, id, selection, area, collection),
      field: (mode, root, id, selection, name) =>
        owner.field(view, mode, root, id, selection, name, area, collection),
      clear: owner.clear,
      current: owner.current,
    });
  return { head, collections, store };
}
/** A V4 storage head can still select an exact V3 bridge after interrupted
 * conversion. Only a completed schema may enter native record consumers. */
export function hasIntakeCollectionEnvelope(db: Database, source: IntakeEnvelopeSource): boolean {
  const { collections, binding } = selectedEnvelopeStore(db, source);
  if (binding.logicalHead === undefined) return false;
  const view = collections.openView();
  const control = collections.get(view, 'logical', 'envelope.control', 'representation');
  if (control === INTAKE_LEGACY_BRIDGE_CONTROL) {
    // This also rejects a forged legacy marker on a mixed logical directory.
    collections.readLegacyMaterialization();
    return false;
  }
  parseSchemaControl(control);
  if (!collections.collection(view, 'logical', 'envelope.data'))
    fail('missing selected envelope data');
  return true;
}
export function openIntakeCollectionEnvelope(
  db: Database,
  source: IntakeEnvelopeSource,
  options: { fieldSelection?: 'first' | 'last' } = {},
): IntakeCollectionEnvelopeReader {
  const selected = collectionCellReader(db, source),
    { collections, store, head } = selected;
  const control = parseSchemaControl(
    collections.get(collections.openView(), 'logical', 'envelope.control', 'representation'),
  );
  return createSchemaEnvelopeReader(
    store,
    control,
    head.logical,
    (name, key) => {
      const current = collections.openView(),
        manifest = collections.get(current, 'builds', 'envelope.indexes', 'complete');
      if (
        typeof manifest !== 'string' ||
        manifest !== JSON.stringify(head.logical) ||
        collections.get(current, 'builds', 'envelope.indexes', 'policy') !==
          'health-intake-workflow-index-v6'
      )
        return fail('semantic indexes are incomplete or stale');
      const value = collections.get(current, 'builds', 'envelope.indexes', schemaKey(name, ...key));
      return value === undefined
        ? undefined
        : typeof value === 'string'
          ? value
          : fail('semantic index target');
    },
    options.fieldSelection ?? 'last',
  );
}
export function* iterateIntakeEnvelopeText(
  db: Database,
  source: IntakeEnvelopeSource,
): Generator<string> {
  const { store, collections } = collectionCellReader(db, source);
  const representation = collections.get(
    collections.openView(),
    'logical',
    'envelope.control',
    'representation',
  );
  if (representation === INTAKE_LEGACY_BRIDGE_CONTROL) {
    const legacy = readIntakeEnvelopeMaterialized(db, source);
    for (let at = 0; at < legacy.text.length;) {
      let end = Math.min(at + 1024, legacy.text.length);
      if (end < legacy.text.length && /[\uD800-\uDBFF]/.test(legacy.text[end - 1]!)) end--;
      yield legacy.text.slice(at, end);
      at = end;
    }
    store.check();
    return;
  }
  const control = parseSchemaControl(representation);
  yield* iterateSchemaEnvelopeText(store, control);
}
export function prepareIntakeEnvelopeFieldMutation(
  db: Database,
  source: IntakeEnvelopeSource,
  input: {
    record: IntakeEnvelopeRecord;
    reader: IntakeCollectionEnvelopeReader;
    field: string;
    jsonText: string;
    operationId: string;
    requestDigest: string;
    domainVersion: number;
  },
) {
  if (Buffer.byteLength(input.jsonText) > 4096)
    fail('use staged chunks for a fragmented field mutation');
  JSON.parse(input.jsonText);
  const { collections, head, store } = collectionCellReader(db, source);
  if (JSON.stringify(input.reader.logical) !== JSON.stringify(head.logical))
    fail('stale field mutation');
  const id = input.reader.address(input.record),
    old = store.get('f:' + id + ':' + schemaKey(input.field));
  if (typeof old !== 'string') fail('field mutation requires existing field');
  const selected = target(JSON.parse(old as string));
  if (selected.type !== 'cell') fail('structured field mutation requires addressed child changes');
  return collections.prepare(collections.openView(), {
    operationId: input.operationId,
    requestDigest: input.requestDigest,
    domainVersion: input.domainVersion,
    changes: [
      {
        area: 'logical',
        collection: 'envelope.data',
        op: 'put',
        key: 'c:' + selected.id,
        value: input.jsonText,
      },
    ],
  });
}
export function stageIntakeEnvelopeFieldMutation(
  db: Database,
  source: IntakeEnvelopeSource,
  prepared: Parameters<ReturnType<typeof createIntakeStateStorage>['collections']['stage']>[0],
) {
  return selectedEnvelopeStore(db, source).collections.stage(prepared);
}

/** Cold recovery/proof reader: accepted node rows are authenticated by the same
 * owner codec. It never materializes the complete record map. */
export function createIntakeEnvelopeGraphReader(
  identity: import('./intake-state-evidence.ts').IntakeStateIdentity,
  head: IntakeCollectionHead,
  readNode: (hash: string) => unknown,
) {
  const tree = createIntakeTree(identity, readNode, new Map());
  const descriptor = (name: string) => {
    const raw = tree.get(head.logical.root, name);
    const value = parseIntakeCollectionDescriptor(raw);
    if (!value || value.kind !== 'map') return fail('missing schema map');
    return value;
  };
  const controlEntry = tree.get(descriptor('envelope.control').root, 'representation');
  if (controlEntry === undefined) fail('missing schema control');
  const controlValue = parseIntakeStoredValue(controlEntry!);
  if (controlValue.kind !== 'inline') fail('fragmented schema control');
  const control = parseSchemaControl(
      controlValue.kind === 'inline' ? controlValue.text : undefined,
    ),
    data = descriptor('envelope.data');
  const byteRefs = new WeakMap<IntakeByteValue, import('./intake-state-tree.ts').IntakeTreeRoot>();
  const publicValue = (raw: string): string | IntakeByteValue => {
    const item = parseIntakeStoredValue(raw);
    if (item.kind === 'inline') return item.text;
    if (item.kind === 'collection') return fail('schema cells cannot contain nested collections');
    const cap = Object.freeze({
      kind: 'bytes',
      bytes: item.bytes,
      chunks: item.root?.count ?? 0,
    }) as IntakeByteValue;
    byteRefs.set(cap, item.root);
    return cap;
  };
  const store: EnvelopeCellReader = {
    check() {},
    get(key) {
      const raw = tree.get(data.root, key);
      return raw === undefined ? undefined : publicValue(raw);
    },
    range(after, items, bytes, prefix) {
      if (prefix !== undefined && (typeof prefix !== 'string' || !after.startsWith(prefix)))
        fail('graph range prefix cursor');
      const result: Array<{ key: string; value: string | IntakeByteValue }> = [];
      let size = 0,
        complete = true;
      for (const row of tree.entries(data.root, after)) {
        // The authenticated, ordered boundary proves this prefix is complete.
        // Do not hydrate the rest of a page from unrelated record namespaces.
        if (prefix !== undefined && !row.key.startsWith(prefix)) break;
        const added = Buffer.byteLength(row.key) + Buffer.byteLength(row.value);
        if (result.length === items || size + added > bytes) {
          complete = false;
          break;
        }
        size += added;
        result.push({ key: row.key, value: publicValue(row.value) });
      }
      if (!complete && !result.length) fail('graph range budget');
      return { items: result, complete };
    },
    chunks(value, after, bytes = 4096) {
      const root = byteRefs.get(value);
      if (root === undefined) fail('foreign graph byte value');
      const chunks: Buffer[] = [];
      let size = 0,
        last: string | null = null,
        complete = true;
      for (const row of tree.entries(root!, after)) {
        const chunk = Buffer.from(row.value, 'base64');
        if (chunk.length < 1 || chunk.length > 4096 || chunk.toString('base64') !== row.value)
          fail('byte chunk');
        if (size + chunk.length > bytes) {
          complete = false;
          break;
        }
        size += chunk.length;
        chunks.push(chunk);
        last = row.key;
      }
      if (!complete && !chunks.length) fail('graph byte budget');
      return { chunks, complete, after: complete ? null : last };
    },
  };
  return { store, control, reader: createSchemaEnvelopeReader(store, control, head.logical) };
}

/** Cold complete traversal after graph authentication. Checks source metadata
 * against its exact selected representation without hydrating operational arrays. */
export function validateIntakeCollectionEnvelopeRepresentation(
  detailsJson: string,
  head: IntakeCollectionHead,
  readNode: (hash: string) => unknown,
): { mode: 'raw' | 'normalized'; domainVersion: number } {
  const steps = validateIntakeCollectionEnvelopeRepresentationSteps(detailsJson, head, readNode);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
export function* validateIntakeCollectionEnvelopeRepresentationSteps(
  detailsJson: string,
  head: IntakeCollectionHead,
  readNode: (hash: string) => unknown,
): Generator<void, { mode: 'raw' | 'normalized'; domainVersion: number }> {
  const { store, control, reader } = createIntakeEnvelopeGraphReader(head.identity, head, readNode);
  yield* validateIntakeSchemaReachabilitySteps(store, control);
  yield* iterateIntakeJsonVerification(iterateSchemaEnvelopeText(store, control));
  const expected = yield* projectSchemaCompactMetadataSteps(
    store,
    control,
    Buffer.byteLength(detailsJson) + 4096,
  );
  if (expected !== detailsJson) fail('compact metadata conflicts with selected schema');
  const intake = reader.child(reader.root(), 'intake');
  if (!intake) fail('missing intake');
  const version = reader.field(intake!, 'version');
  if (version.kind !== 'value' || version.value !== head.logical.domainVersion)
    fail('selected domain version disagreement');
  return { mode: control.mode, domainVersion: head.logical.domainVersion };
}

function projectSchemaCompactMetadata(
  store: EnvelopeCellReader,
  control: SchemaControl,
  budget: number,
): string {
  const steps = projectSchemaCompactMetadataSteps(store, control, budget);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
function* projectSchemaCompactMetadataSteps(
  store: EnvelopeCellReader,
  control: SchemaControl,
  budget: number,
): Generator<void, string> {
  let work = 0;
  const collect = function* (pieces: Iterable<string>, limit = budget): Generator<void, string> {
    let text = '',
      bytes = 0;
    for (const piece of pieces) {
      if (++work % 16 === 0) yield;
      bytes += Buffer.byteLength(piece);
      if (bytes > limit) fail('compact metadata byte agreement');
      text += piece;
    }
    return text;
  };
  function* selectedValue(item: SchemaTarget): Generator<string> {
    if (item.type === 'cell') {
      yield* cellChunks(store, 'c:' + item.id);
      return;
    }
    const meta = header(store, item.id);
    if (meta.shape === 'scalar') {
      yield* cellChunks(store, 'c:' + item.id);
      return;
    }
    for (const entry of orderEntries(store, item.id)) {
      yield* cellChunks(store, 'c:' + entry.prefix);
      yield* selectedValue(entry.target);
    }
    yield* cellChunks(store, 's:' + item.id);
  }
  const nameHash = function* (entry: SchemaOrder): Generator<void, string | undefined> {
    return entry.name === undefined
      ? undefined
      : (yield* hashIntakeJsonScalarSteps(cellChunks(store, 'n:' + entry.name))).hash;
  };
  const lexicalKey = (entry: SchemaOrder) => {
    let result = '',
      started = false,
      escaped = false;
    for (const piece of cellChunks(store, 'c:' + entry.prefix))
      for (let at = 0; at < piece.length; at++) {
        const char = piece[at]!;
        if (!started) {
          if (/[\s{,]/.test(char)) continue;
          if (char !== '"') fail('property prefix');
          started = true;
          result = '"';
          continue;
        }
        result += char;
        if (result.length > 4096) fail('known metadata key spelling');
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') escaped = true;
        else if (char === '"') return result;
      }
    return fail('metadata property key');
  };
  const metadata = new Map(
    [
      'originalName',
      'acquisition',
      'metadata',
      'receivedMimeType',
      'createdAt',
      'parentSourceFileId',
      'locator',
      'derivative',
    ].map((name) => [schemaKey(name), name]),
  );
  function* compactIntake(id: string): Generator<void, string> {
    const parts: string[] = [];
    let bytes = 0;
    for (const entry of orderEntries(store, id)) {
      if (++work % 64 === 0) yield;
      const hash = yield* nameHash(entry),
        field = hash && metadata.get(hash);
      if (!field) continue;
      const text = (yield* collect(selectedValue(entry.target))).trim(),
        piece = (control.mode === 'raw' ? lexicalKey(entry) : JSON.stringify(field)) + ':' + text;
      bytes += Buffer.byteLength(piece);
      if (bytes > budget) fail('compact metadata size');
      parts.push(piece);
    }
    return '{' + parts.join(',') + '}';
  }
  const intakes: string[] = [];
  let last: string | undefined,
    total = 0;
  for (const entry of orderEntries(store, control.root)) {
    if (++work % 64 === 0) yield;
    if ((yield* nameHash(entry)) !== schemaKey('intake')) continue;
    const retainedObject =
      entry.target.type === 'record' && header(store, entry.target.id).shape === 'object';
    if (!retainedObject && control.mode !== 'raw') fail('selected intake record');
    last = retainedObject ? entry.target.id : undefined;
    const piece =
      lexicalKey(entry) + ':' + (retainedObject ? yield* compactIntake(entry.target.id) : 'null');
    total += Buffer.byteLength(piece);
    if (total > budget) fail('compact root metadata size');
    intakes.push(piece);
  }
  if (!last) fail('missing intake record');
  const expected =
    control.mode === 'raw'
      ? '{"intakeAuthority":' +
        JSON.stringify({ format: 'health-intake-envelope-v1', mode: 'raw' }) +
        ',' +
        intakes.join(',') +
        '}'
      : JSON.stringify({
          intakeAuthority: { format: 'health-intake-envelope-v1', mode: 'normalized' },
          intake: JSON.parse(yield* compactIntake(last!)),
        });
  if (Buffer.byteLength(expected) > budget) fail('compact metadata size');
  return expected;
}

export {
  header as readSchemaRecordHeader,
  order as readSchemaOrder,
  textValue as readSchemaTextValue,
  cellChunks as iterateSchemaCellText,
  orderEntries as iterateSchemaRecordOrder,
};
