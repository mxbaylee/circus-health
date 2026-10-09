import { schemaResolvedHeader, schemaResolvedOrder } from './intake-schema-record-resolution.ts';
import type { SchemaOrder, SchemaRecord } from './intake-envelope-schema.ts';
import type { EnvelopeCellReader } from './intake-collection-envelope.ts';
import { recordIntakeWork } from './intake-work-accounting.ts';

const fail = (reason: string): never => {
  throw Error(`Intake collection envelope: ${reason}`);
};

export function textValue(store: EnvelopeCellReader, key: string, max = 8192): string {
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

export function* cellChunks(store: EnvelopeCellReader, key: string): Generator<string> {
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

export function header(store: EnvelopeCellReader, id: string): SchemaRecord {
  if (!/^[a-f0-9]{64}$/.test(id)) return fail('record address');
  return schemaResolvedHeader(textValue(store, 'r:' + id));
}

export function order(value: string | object): SchemaOrder {
  if (typeof value !== 'string') return fail('fragmented order entry');
  return schemaResolvedOrder(value);
}

export function* orderEntries(store: EnvelopeCellReader, id: string): Generator<SchemaOrder> {
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

export function* iterateSchemaRecordValue(
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

export interface SchemaRecordCursor {
  readonly kind: 'native-schema-record-cursor';
}

interface CursorState {
  active: EnvelopeCellReader | undefined;
  iterator: Generator<string>;
  pending: string | undefined;
  pendingDone: boolean;
  closed: boolean;
  ownerToken: object | undefined;
  tainted: boolean;
  revision: number;
}

const cursors = new WeakMap<SchemaRecordCursor, CursorState>();

export function createSchemaRecordCursor(id: string, ownerToken?: object): SchemaRecordCursor {
  if (!/^[a-f0-9]{64}$/.test(id)) fail('record address');
  const state: CursorState = {
    active: undefined,
    iterator: undefined!,
    pending: undefined,
    pendingDone: false,
    closed: false,
    ownerToken,
    tainted: false,
    revision: 0,
  };
  const current = () => state.active ?? fail('inactive record cursor');
  const store: EnvelopeCellReader = {
    get: (key) => current().get(key),
    range: (after, items, bytes, prefix) => current().range(after, items, bytes, prefix),
    chunks: (value, after, bytes) => current().chunks(value, after, bytes),
    check: () => current().check(),
  };
  state.iterator = iterateSchemaRecordValue(store, id);
  const cursor = Object.freeze({ kind: 'native-schema-record-cursor' as const });
  cursors.set(cursor, state);
  return cursor;
}

export function stepSchemaRecordCursor(
  cursor: SchemaRecordCursor,
  port: EnvelopeCellReader,
  ownerToken?: object,
): IteratorResult<string> {
  const state = cursors.get(cursor);
  if (!state) return fail('foreign record cursor');
  if (ownerToken !== state.ownerToken) {
    state.tainted = true;
    state.revision++;
  }
  if (state.closed || state.active) return fail('closed record cursor');
  if (ownerToken && state.tainted) return fail('tainted record cursor');
  state.revision++;
  state.active = port;
  try {
    if (state.pending !== undefined) {
      port.check();
      const value = state.pending;
      state.pending = undefined;
      return { done: false, value };
    }
    if (state.pendingDone) {
      port.check();
      state.pendingDone = false;
      state.closed = true;
      return { done: true, value: undefined };
    }
    const result = state.iterator.next();
    if (result.done) state.closed = true;
    return result;
  } catch (error) {
    state.closed = true;
    throw error;
  } finally {
    state.active = undefined;
  }
}

function utf8Prefix(text: string, maxBytes: number): [string, string] {
  let end = 0;
  let bytes = 0;
  for (const scalar of text) {
    const next = Buffer.byteLength(scalar);
    if (bytes + next > maxBytes) break;
    bytes += next;
    end += scalar.length;
  }
  if (end === 0) return fail('lexical fragment byte budget');
  return [text.slice(0, end), text.slice(end)];
}

/** The fixed owner can consume a few lexical pieces under one fresh read seal. */
export function stepSchemaRecordCursorBatch(
  cursor: SchemaRecordCursor,
  port: EnvelopeCellReader,
  ownerToken: object,
): IteratorResult<string> {
  const state = cursors.get(cursor);
  if (!state) return fail('foreign record cursor');
  if (ownerToken !== state.ownerToken) {
    state.tainted = true;
    state.revision++;
    return fail('tainted record cursor');
  }
  if (state.closed || state.active) return fail('closed record cursor');
  if (state.tainted) return fail('tainted record cursor');
  state.revision++;
  state.active = port;
  try {
    let text = '';
    let bytes = 0;
    for (let pieces = 0; pieces < 4; pieces++) {
      if (state.pendingDone) {
        port.check();
        state.pendingDone = false;
        state.closed = true;
        return { done: true, value: undefined };
      }
      let next: IteratorResult<string>;
      if (state.pending !== undefined) {
        port.check();
        next = { done: false, value: state.pending };
        state.pending = undefined;
      } else {
        recordIntakeWork('nativeSchemaRecordIntrinsicAdvances');
        next = state.iterator.next();
      }
      if (next.done) {
        if (text) {
          state.pendingDone = true;
          break;
        }
        state.closed = true;
        return next;
      }
      const part = next.value;
      const partBytes = Buffer.byteLength(part);
      if (partBytes > 4099) return fail('lexical fragment byte budget');
      if (bytes + partBytes <= 4096) {
        text += part;
        bytes += partBytes;
        continue;
      }
      if (text) {
        state.pending = part;
        break;
      }
      const [prefix, suffix] = utf8Prefix(part, 4096);
      text = prefix;
      state.pending = suffix;
      break;
    }
    return { done: false, value: text };
  } catch (error) {
    state.closed = true;
    state.pending = undefined;
    state.pendingDone = false;
    throw error;
  } finally {
    state.active = undefined;
  }
}

export function closeSchemaRecordCursor(cursor: SchemaRecordCursor): void {
  const state = cursors.get(cursor);
  if (!state) return fail('foreign record cursor');
  if (state.active) {
    state.tainted = true;
    state.revision++;
    return fail('active record cursor');
  }
  state.revision++;
  state.closed = true;
  state.pending = undefined;
  state.pendingDone = false;
  state.iterator.return(undefined);
}

export function schemaRecordCursorRevision(
  cursor: SchemaRecordCursor,
  ownerToken: object,
): number | undefined {
  const state = cursors.get(cursor);
  return state && state.ownerToken === ownerToken && !state.tainted && !state.active
    ? state.revision
    : undefined;
}
