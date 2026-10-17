/** Authenticated encrypted canonical index and UTF8 byte spools. Invocation-local. */
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
> & { assertCurrent: () => void };
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
  const storage = createIntakeEncryptedScratch({
    ...options,
    tables: names,
    spools: ['raw', 'output'],
  });
  const maps = Object.fromEntries(names.map((name) => [name, storage.map(name)])) as Record<
    (typeof names)[number],
    ReturnType<typeof storage.map>
  >;
  function get<T>(table: (typeof names)[number], key: string): T | undefined {
    const raw = maps[table].get(key);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') throw Error('JSON encrypted index cell kind');
    return JSON.parse(raw) as T;
  }
  function put(table: (typeof names)[number], key: string, value: unknown) {
    maps[table].set(key, JSON.stringify(value));
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
      const key = edgeKey(row.parent, row.chunk),
        previous = get<number>('edges', key);
      if (previous !== undefined && previous !== row.id) throw Error('Duplicate JSON trie edge');
      put('edges', key, row.id);
    }
    put('trie', numberKey(row.id), {
      ...row,
      chunk: typeof row.chunk === 'number' ? row.chunk : Buffer.from(row.chunk).toString('hex'),
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
        after: after ? edgeKey(parent, after) : base,
        items: 1,
        scanned: 1,
      }).entries[0];
    if (!first || !first.key.startsWith(base)) return undefined;
    if (typeof first.value !== 'string') throw Error('JSON encrypted edge kind');
    return JSON.parse(first.value) as number;
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
  return {
    index,
    raw: storage.spool('raw'),
    output: storage.spool('output'),
    reset() {
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
    },
    close: storage.close,
    stats: storage.stats,
  };
}
