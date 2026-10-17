/** Authenticated encrypted canonical index and UTF8 byte spools. Invocation-local. */
import { types } from 'node:util';
import {
  createIntakeEncryptedScratch,
  type IntakeEncryptedScratchOptions,
} from './intake-encrypted-scratch.ts';
import type {
  CanonicalIndex,
  CanonicalNodeRow,
  CanonicalTrieRow,
} from './intake-json-canonical-index.ts';

export type IntakeEncryptedCanonicalOptions = Pick<
  IntakeEncryptedScratchOptions,
  'identity' | 'selectedHead' | 'capacity'
> & { assertCurrent: () => void; livePointChecks?: boolean };
const { isProxy, isUint8Array, isSharedArrayBuffer } = types;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype),
  typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'length')!.get!,
  typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!,
  typedSet = Uint8Array.prototype.set,
  resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')!.get!,
  detached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')!.get!,
  bufferHex = Buffer.prototype.toString;
const nodeFields = [
  'id',
  'kind',
  'parent',
  'state',
  'n',
  'key',
  'trie',
  'raw_start',
  'raw_bytes',
  'out_start',
  'cursor',
  'emitted',
  'phase',
];
const trieFields = [
  'id',
  'parent',
  'chunk',
  'object',
  'value',
  'first_order',
  'key_number',
  'raw_start',
  'raw_bytes',
];
function bad(): never {
  throw Error('JSON encrypted typed row');
}
function integer(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) bad();
}
/** No caller accessor, iterator, proxy trap or coercion runs in an owned leaf. */
function flat(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value)) bad();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) bad();
  const keys = Reflect.ownKeys(value),
    result = Object.create(null) as Record<string, unknown>;
  if (keys.length !== fields.length) bad();
  for (const key of keys) {
    if (typeof key !== 'string' || !fields.includes(key)) bad();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) bad();
    result[key] = descriptor.value;
  }
  return result;
}
function chunkCopy(value: unknown): Buffer {
  if (!value || typeof value !== 'object' || isProxy(value) || !isUint8Array(value)) bad();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) bad();
  const backing = Reflect.apply(typedBuffer, value, []) as ArrayBuffer;
  if (
    isSharedArrayBuffer(backing) ||
    Reflect.apply(resizable, backing, []) ||
    Reflect.apply(detached, backing, [])
  )
    bad();
  const length = Reflect.apply(typedLength, value, []) as number;
  if (length > 256) bad();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length) bad();
  for (let n = 0; n < length; n++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(n));
    if (!descriptor?.enumerable || !('value' in descriptor)) bad();
  }
  const result = Buffer.alloc(length);
  Reflect.apply(typedSet, result, [value]);
  return result;
}
function nodeCopy(value: unknown): CanonicalNodeRow {
  // Eleven safe integers + two fixed enums: <=326 JSON bytes, <=359 encoded.
  const row = flat(value, nodeFields);
  for (const key of nodeFields) if (key !== 'kind' && key !== 'state') integer(row[key]);
  if (
    !['object', 'array', 'string', 'number', 'boolean', 'null', 'root'].includes(
      row.kind as string,
    ) ||
    !['value', 'first', 'after', 'next'].includes(row.state as string)
  )
    bad();
  return row as unknown as CanonicalNodeRow;
}
function trieCopy(value: unknown, stored = false): CanonicalTrieRow {
  // Eight safe integer/null fields + <=256 owned bytes: <=750 JSON bytes,
  // <=773 encoded; its edge key is <=16+1+512=529 bytes. These live rows stay
  // inline, so each point/row has a fixed number of bounded AVL operations.
  const row = flat(value, trieFields);
  for (const key of trieFields)
    if (key !== 'chunk' && !(key === 'value' && row[key] === null)) integer(row[key]);
  if (typeof row.chunk === 'number') {
    if (row.chunk !== -1) bad();
  } else if (stored) {
    if (
      typeof row.chunk !== 'string' ||
      row.chunk.length > 512 ||
      row.chunk.length % 2 ||
      !/^[0-9a-f]*$/.test(row.chunk)
    )
      bad();
    row.chunk = Buffer.from(row.chunk, 'hex');
  } else row.chunk = chunkCopy(row.chunk);
  return row as unknown as CanonicalTrieRow;
}
const names = [
  'nodes',
  'trie',
  'edges',
  'numeric',
  'insertion',
  'children',
  'outs',
  'members',
] as const;
const numberKey = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0) throw Error('JSON encrypted index integer');
  return String(n).padStart(16, '0');
};
const prefix = (n: number) => numberKey(n) + ':';
const edgeKey = (parent: number, bytes: Uint8Array) =>
  prefix(parent) + Buffer.from(bytes).toString('hex');

export function createEncryptedCanonicalIndex(options: IntakeEncryptedCanonicalOptions) {
  const { assertCurrent, ...ownedOptions } = options;
  const live = ownedOptions.livePointChecks === true;
  let active = false,
    poisoned = false,
    closed = false;
  const localCurrent = () => {
    if (closed || poisoned) throw Error('JSON encrypted canonical authority closed');
  };
  const storage = createIntakeEncryptedScratch({
    ...ownedOptions,
    assertCurrent() {
      if (live && active) localCurrent();
      else assertCurrent();
    },
    tables: names,
    spools: ['raw', 'output'],
  });
  const maps = Object.fromEntries(names.map((name) => [name, storage.map(name)])) as Record<
    (typeof names)[number],
    ReturnType<typeof storage.map>
  >;
  function close() {
    if (live) {
      closed = true;
      if (active) poisoned = true;
    }
    storage.close();
  }
  function data<T>(operation: () => T): T {
    if (!live) return operation();
    if (active) {
      poisoned = true;
      throw Error('JSON encrypted canonical reentrant operation');
    }
    localCurrent();
    try {
      return operation();
    } catch (error) {
      poisoned = true;
      try {
        close();
      } catch {
        /* Preserve the first refusal after key erasure. */
      }
      throw error;
    }
  }
  /** One fixed synchronous point/owned-row operation, never a batch, iterator,
   * spool or parser. Its result remains private until the original closing
   * proof succeeds. Local checks do not mint or retain source authority. */
  function fixed<T>(operation: () => T): T {
    active = true;
    try {
      assertCurrent();
      localCurrent();
      const result = operation();
      assertCurrent();
      localCurrent();
      return result;
    } finally {
      active = false;
    }
  }
  function batch<T>(rows: readonly T[], copy: (row: unknown) => T, write: (row: T) => void) {
    return data(() => {
      if (
        !rows ||
        isProxy(rows) ||
        !Array.isArray(rows) ||
        Object.getPrototypeOf(rows) !== Array.prototype
      )
        bad();
      const length = Object.getOwnPropertyDescriptor(rows, 'length')!.value as number;
      // Consume descriptors per row, without a caller iterator or a whole-batch
      // copy/history cap. Even a later malformed row erases this invocation.
      for (let n = 0; n < length; n++) {
        const descriptor = Object.getOwnPropertyDescriptor(rows, String(n));
        if (!descriptor?.enumerable || !('value' in descriptor)) bad();
        const row = copy(descriptor.value);
        fixed(() => write(row));
      }
    });
  }
  const hex = (bytes: Uint8Array) =>
    live
      ? (Reflect.apply(bufferHex, bytes, ['hex']) as string)
      : Buffer.from(bytes).toString('hex');
  const ownedEdgeKey = (parent: number, bytes: Uint8Array) =>
    live ? prefix(parent) + hex(bytes) : edgeKey(parent, bytes);
  function get<T>(table: (typeof names)[number], key: string): T | undefined {
    const raw = maps[table].get(key);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') throw Error('JSON encrypted index cell kind');
    // Live roots contain only bounded typed writes; reject a malformed stored
    // row before parsing/converting it or rewriting its chunk.
    if (live && Buffer.byteLength(raw) > 1024) bad();
    return JSON.parse(raw) as T;
  }
  function put(table: (typeof names)[number], key: string, value: unknown) {
    const owned =
      live && active && value && typeof value === 'object'
        ? Object.assign(Object.create(null), value)
        : value;
    maps[table].set(key, JSON.stringify(owned));
  }
  function page<T>(
    table: (typeof names)[number],
    parent: number,
    after: number,
    limit: number,
  ): Array<{ cursor: number; value: T }> {
    const base = prefix(parent),
      result: Array<{ cursor: number; value: T }> = [];
    for (const row of maps[table].scan({
      after: base + (after < 0 ? '' : numberKey(after)),
      items: limit,
      scanned: limit,
    }).entries) {
      if (!row.key.startsWith(base)) break;
      if (typeof row.value !== 'string') throw Error('JSON encrypted index page kind');
      result.push({
        cursor: Number(row.key.slice(base.length)),
        value: JSON.parse(row.value) as T,
      });
    }
    return result;
  }
  function trie(id: number): CanonicalTrieRow | undefined {
    const row = get<Omit<CanonicalTrieRow, 'chunk'> & { chunk: number | string }>(
      'trie',
      numberKey(id),
    );
    if (live) return row && trieCopy(row, true);
    return (
      row && {
        ...row,
        chunk: typeof row.chunk === 'number' ? row.chunk : Buffer.from(row.chunk, 'hex'),
      }
    );
  }
  function writeTrie(row: CanonicalTrieRow) {
    const old = trie(row.id);
    if (old?.value !== null && old?.value !== undefined) {
      maps[old.key_number >= 0 ? 'numeric' : 'insertion'].delete(
        prefix(old.object) + numberKey(old.key_number >= 0 ? old.key_number : old.first_order),
      );
    }
    if (row.chunk instanceof Uint8Array) {
      const key = ownedEdgeKey(row.parent, row.chunk),
        previous = get<number>('edges', key);
      if (previous !== undefined && previous !== row.id) throw Error('Duplicate JSON trie edge');
      put('edges', key, row.id);
    }
    put('trie', numberKey(row.id), {
      ...row,
      chunk: typeof row.chunk === 'number' ? row.chunk : hex(row.chunk),
    });
    if (row.value !== null)
      put(
        row.key_number >= 0 ? 'numeric' : 'insertion',
        prefix(row.object) + numberKey(row.key_number >= 0 ? row.key_number : row.first_order),
        row.id,
      );
  }
  function nextEdge(parent: number, after?: Uint8Array) {
    const base = prefix(parent),
      first = maps.edges.scan({
        after: after ? ownedEdgeKey(parent, after) : base,
        items: 1,
        scanned: 1,
      }).entries[0];
    if (!first || !first.key.startsWith(base)) return undefined;
    if (typeof first.value !== 'string') throw Error('JSON encrypted edge kind');
    const result = JSON.parse(first.value) as number;
    if (live) integer(result);
    return result;
  }
  const index: CanonicalIndex = {
    node: (id) => get<CanonicalNodeRow>('nodes', numberKey(id)),
    nodes: (rows) => {
      for (const row of rows) put('nodes', numberKey(row.id), row);
    },
    trie,
    tries: (rows) => {
      for (const row of rows) writeTrie(row);
    },
    terminal(id, first_order, key_number, raw_start, raw_bytes) {
      const row = trie(id);
      if (!row) throw Error('Missing JSON key');
      writeTrie({ ...row, first_order, key_number, raw_start, raw_bytes });
    },
    value(id, value) {
      const row = trie(id);
      if (!row) throw Error('Missing JSON key');
      writeTrie({ ...row, value });
    },
    edge: (parent, chunk) => get<number>('edges', edgeKey(parent, chunk)),
    firstEdge: (parent) => nextEdge(parent),
    nextEdge: (parent, chunk) => {
      if (typeof chunk === 'number') throw Error('JSON trie sibling chunk');
      return nextEdge(parent, chunk);
    },
    children: (rows) => {
      for (const row of rows)
        put('children', prefix(row.parent) + numberKey(row.ordinal), row.value);
    },
    childPage: (parent, after, limit) => page<number>('children', parent, after, limit),
    terminalPage: (object, after, order, limit) =>
      page<number>(order, object, after, limit).map(({ value }) => {
        const row = trie(value);
        if (!row) throw Error('Missing JSON member');
        return row;
      }),
    outs: (rows) => {
      for (const row of rows)
        put('outs', numberKey(row.id), { start: row.start, bytes: row.bytes });
    },
    out: (id) => get('outs', numberKey(id)),
    members: (rows) => {
      for (const row of rows) put('members', prefix(row.object) + numberKey(row.ordinal), row.trie);
    },
    memberPage: (object, after, limit) => page<number>('members', object, after, limit),
  };
  let exposedIndex = index;
  if (live) {
    // Unoptimized siblings keep their original per-cell policy schedule, but
    // cannot be entered by a callback inside any fixed operation.
    exposedIndex = Object.fromEntries(
      Object.entries(index).map(([name, method]) => [
        name,
        (...args: unknown[]) => data(() => Reflect.apply(method, index, args)),
      ]),
    ) as unknown as CanonicalIndex;
    const point = <T>(operation: () => T) => data(() => fixed(operation));
    const small = (value: unknown, fields: readonly string[]) => {
      const row = flat(value, fields);
      for (const field of fields) integer(row[field]);
      return row;
    };
    Object.assign(exposedIndex, {
      node(id: number) {
        return point(() => {
          const row = index.node(id);
          return row && { ...nodeCopy(row) };
        });
      },
      nodes(rows: readonly CanonicalNodeRow[]) {
        return batch(rows, nodeCopy, (row) => put('nodes', numberKey(row.id), row));
      },
      trie(id: number) {
        return point(() => {
          const row = trie(id);
          return row && { ...row };
        });
      },
      tries(rows: readonly CanonicalTrieRow[]) {
        return batch(rows, (row) => trieCopy(row), writeTrie);
      },
      terminal(id: number, first: number, key: number, start: number, bytes: number) {
        return point(() => {
          for (const value of [id, first, key, start, bytes]) integer(value);
          index.terminal(id, first, key, start, bytes);
        });
      },
      value(id: number, value: number) {
        return point(() => {
          integer(id);
          integer(value);
          index.value(id, value);
        });
      },
      edge(parent: number, input: Uint8Array) {
        return data(() => {
          const chunk = chunkCopy(input);
          return fixed(() => {
            const result = get<number>('edges', ownedEdgeKey(parent, chunk));
            if (result !== undefined) integer(result);
            return result;
          });
        });
      },
      firstEdge(parent: number) {
        return point(() => nextEdge(parent));
      },
      nextEdge(parent: number, input: Uint8Array | number) {
        return data(() => {
          if (typeof input === 'number') throw Error('JSON trie sibling chunk');
          const chunk = chunkCopy(input);
          return fixed(() => nextEdge(parent, chunk));
        });
      },
      outs(rows: readonly { id: number; start: number; bytes: number }[]) {
        return batch(
          rows,
          (row) =>
            small(row, ['id', 'start', 'bytes']) as { id: number; start: number; bytes: number },
          (row) =>
            put(
              'outs',
              numberKey(row.id),
              Object.assign(Object.create(null), { start: row.start, bytes: row.bytes }),
            ),
        );
      },
      out(id: number) {
        return point(() => {
          const row = index.out(id);
          return (
            row &&
            ({ ...small(row, ['start', 'bytes']) } as { start: number; bytes: number } | undefined)
          );
        });
      },
      members(rows: readonly { object: number; ordinal: number; trie: number }[]) {
        return batch(
          rows,
          (row) =>
            small(row, ['object', 'ordinal', 'trie']) as {
              object: number;
              ordinal: number;
              trie: number;
            },
          (row) => put('members', prefix(row.object) + numberKey(row.ordinal), row.trie),
        );
      },
    } satisfies Partial<CanonicalIndex>);
  }
  function spool(name: string) {
    const original = storage.spool(name);
    if (!live) return original;
    return {
      appendBytes: (bytes: Uint8Array) => data(() => original.appendBytes(bytes)),
      length: () => data(() => original.length()),
      flush: () => data(() => original.flush()),
      read: (start: number, bytes: number) => data(() => original.read(start, bytes)),
      reset: () => data(() => original.reset()),
      generation: () => data(() => original.generation()),
    };
  }
  return {
    index: exposedIndex,
    raw: spool('raw'),
    output: spool('output'),
    reset() {
      return data(() => {
        for (const map of Object.values(maps)) map.clear();
        storage.spool('raw').reset();
        storage.spool('output').reset();
        index.nodes([
          {
            id: 0,
            kind: 'root',
            parent: -1,
            state: 'value',
            n: 0,
            key: 0,
            trie: 0,
            raw_start: 0,
            raw_bytes: 0,
            out_start: -1,
            cursor: -1,
            emitted: 0,
            phase: 0,
          },
        ]);
      });
    },
    close,
    stats: storage.stats,
  };
}
