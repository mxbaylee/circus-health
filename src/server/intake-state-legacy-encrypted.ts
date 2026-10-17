/** Encrypted private legacy index. Immutable pages remain counted until close. */
import {
  createIntakeEncryptedScratch,
  IntakeEncryptedScratchCapacityError,
  type IntakeEncryptedScratchOptions,
} from './intake-encrypted-scratch.ts';
import { schemaKey } from './intake-envelope-schema.ts';
import { FRAME_BYTES, invalid, intakeNamespace } from './intake-state-evidence.ts';
import type { LegacyIndex, LegacyEntry, LegacyNode } from './intake-state-legacy-index.ts';

export type IntakeLegacyEncryptedScratchOptions = Pick<
  IntakeEncryptedScratchOptions,
  'identity' | 'selectedHead' | 'capacity'
> & { assertCurrent: () => void };
const names = [
  'nodes',
  'entries',
  'order',
  'names',
  'reverse',
  'counts',
  'frames',
  'frame_sha',
  'frame_ids',
  'consumed',
  'receipts',
  'copies',
  'copy_targets',
  'reordered',
  'inserted',
] as const;
function ordered(n: number) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new IntakeEncryptedScratchCapacityError('COUNTER_RANGE');
  return String(n).padStart(16, '0');
}
const prefix = (n: number) => ordered(n) + ':';
const increment = (n: number) => {
  ordered(n + 1);
  return n + 1;
};
export function createIntakeLegacyEncryptedScratch(options: IntakeLegacyEncryptedScratchOptions) {
  if (
    typeof options.selectedHead !== 'string' ||
    !options.selectedHead ||
    typeof options.assertCurrent !== 'function'
  )
    throw Error('Encrypted legacy scratch requires selected HEAD and current scope');
  const storage = createIntakeEncryptedScratch({ ...options, tables: names, spools: ['units'] }),
    namespace = intakeNamespace(options.identity),
    maps = Object.fromEntries(names.map((name) => [name, storage.map(name)])) as Record<
      (typeof names)[number],
      ReturnType<typeof storage.map>
    >;
  let nodeId = 0,
    reorderPosition = 0,
    insertPosition = 0;
  function get<T>(table: (typeof names)[number], key: string): T | undefined {
    const raw = maps[table].get(key);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') invalid('legacy index cell kind');
    return JSON.parse(raw as string) as T;
  }
  function put(table: (typeof names)[number], key: string, value: unknown) {
    maps[table].set(key, JSON.stringify(value));
  }
  function* rows<T>(
    table: (typeof names)[number],
    base = '',
    after = base,
  ): Generator<{ key: string; value: T }> {
    for (;;) {
      const page = maps[table].scan({ after, items: 64, scanned: 64 });
      for (const row of page.entries) {
        if (!row.key.startsWith(base)) return;
        if (typeof row.value !== 'string') invalid('legacy index page kind');
        after = row.key;
        yield { key: row.key, value: JSON.parse(row.value as string) as T };
      }
      if (page.complete) return;
    }
  }
  function scalar(raw: string) {
    const bytes = Buffer.from(raw);
    return bytes.length <= 8192 ? raw : storage.writeScalar([bytes]);
  }
  function raw(table: 'frames' | 'receipts', key: string): string | undefined {
    const cell = maps[table].get(key);
    if (cell === undefined || typeof cell === 'string') return cell;
    if (cell.bytes > FRAME_BYTES) invalid('legacy frame scratch bound');
    return storage.readScalarRange(cell, 0, cell.bytes).toString('utf8');
  }
  const nameKey = (parent: number, key: string) => prefix(parent) + schemaKey('legacy-name', key);
  const orderKey = (parent: number, entry: LegacyEntry) =>
    prefix(parent) +
    (entry.numeric === null
      ? '1' + ordered(entry.ordinal)
      : '0' + ordered(entry.numeric) + ':' + ordered(entry.ordinal));
  function entry(parent: number, ordinal: number) {
    return get<LegacyEntry>('entries', prefix(parent) + ordered(ordinal));
  }
  function named(parent: number, key: string) {
    const ordinal = get<number>('names', nameKey(parent, key));
    if (ordinal === undefined) return undefined;
    const row = entry(parent, ordinal);
    if (!row || row.key !== key) invalid('legacy name index agreement');
    return row;
  }
  function add(parent: number, row: LegacyEntry) {
    if (entry(parent, row.ordinal) || (row.key !== null && named(parent, row.key)))
      invalid('duplicate legacy entry');
    put('entries', prefix(parent) + ordered(row.ordinal), row);
    if (row.key !== null) put('names', nameKey(parent, row.key), row.ordinal);
    put('order', orderKey(parent, row), row.ordinal);
    put('reverse', prefix(parent) + ordered(Number.MAX_SAFE_INTEGER - row.ordinal), row.ordinal);
    put('counts', ordered(parent), increment(get<number>('counts', ordered(parent)) ?? 0));
  }
  function remove(parent: number, row: LegacyEntry) {
    maps.entries.delete(prefix(parent) + ordered(row.ordinal));
    if (row.key !== null) maps.names.delete(nameKey(parent, row.key));
    maps.order.delete(orderKey(parent, row));
    maps.reverse.delete(prefix(parent) + ordered(Number.MAX_SAFE_INTEGER - row.ordinal));
    const count = get<number>('counts', ordered(parent));
    if (!count) invalid('legacy entry count');
    put('counts', ordered(parent), count! - 1);
  }
  function* entries(parent: number, array: boolean) {
    for (const row of rows<LegacyEntry | number>(array ? 'entries' : 'order', prefix(parent))) {
      const value = array ? (row.value as LegacyEntry) : entry(parent, row.value as number);
      if (!value) invalid('legacy ordered entry');
      yield value!;
    }
  }
  const index: LegacyIndex = {
    frameSeen: (id) => maps.frame_ids.get(id) !== undefined,
    putFrame(sequence, id, text, sha) {
      if (maps.frame_ids.get(id) !== undefined || maps.frames.get(ordered(sequence)) !== undefined)
        invalid('duplicate legacy frame');
      maps.frames.set(ordered(sequence), scalar(text));
      put('frame_sha', ordered(sequence), sha);
      put('frame_ids', id, sequence);
    },
    frame(sequence) {
      const text = raw('frames', ordered(sequence));
      return text === undefined
        ? undefined
        : { raw: text, sha: get<string>('frame_sha', ordered(sequence))! };
    },
    *frames() {
      let after: string | undefined;
      for (;;) {
        const page = maps.frames.scan({ after, items: 64, scanned: 64 });
        for (const row of page.entries) {
          after = row.key;
          yield { raw: raw('frames', row.key)!, sha: get<string>('frame_sha', row.key)! };
        }
        if (page.complete) return;
      }
    },
    consume(key) {
      if (!key.startsWith(namespace)) invalid('legacy consumed namespace');
      maps.consumed.set(key.slice(namespace.length), '1');
    },
    *consumed() {
      for (const row of rows<number>('consumed')) yield namespace + row.key;
    },
    receipt(id, text) {
      if (maps.receipts.get(id) !== undefined) invalid('duplicate legacy receipt');
      maps.receipts.set(id, text);
    },
    *receipts() {
      let after: string | undefined;
      for (;;) {
        const page = maps.receipts.scan({ after, items: 64, scanned: 64 });
        for (const row of page.entries) {
          after = row.key;
          yield { id: row.key, raw: raw('receipts', row.key)! };
        }
        if (page.complete) return;
      }
    },
    clearCopies() {
      maps.copies.clear();
      maps.copy_targets.clear();
    },
    copy(id, target) {
      if (maps.copies.get(id) !== undefined || maps.copy_targets.get(target) !== undefined)
        invalid('duplicate legacy copy');
      put('copies', id, target);
      put('copy_targets', target, id);
    },
    copied: (id) => get<string>('copies', id),
    node: (id) => get<LegacyNode>('nodes', ordered(id)),
    insertNode(node) {
      nodeId = increment(nodeId);
      put('nodes', ordered(nodeId), { ...node, id: nodeId });
      return nodeId;
    },
    count: (parent) => get<number>('counts', ordered(parent)) ?? 0,
    nextOrdinal(parent) {
      const first = maps.reverse.scan({ after: prefix(parent), items: 1, scanned: 1 }).entries[0];
      return first?.key.startsWith(prefix(parent))
        ? increment(JSON.parse(first.value as string) as number)
        : 0;
    },
    entry,
    named,
    entries,
    add,
    replace(parent, row, child) {
      put('entries', prefix(parent) + ordered(row.ordinal), { ...row, child });
    },
    remove,
    *truncateSteps(parent, length) {
      for (const row of rows<LegacyEntry>(
        'entries',
        prefix(parent),
        prefix(parent) + (length ? ordered(length - 1) : ''),
      )) {
        remove(parent, row.value);
        yield;
      }
    },
    reorder(row) {
      put('reordered', ordered(reorderPosition), row);
      reorderPosition = increment(reorderPosition);
    },
    *finishOrderSteps(parent) {
      for (const row of entries(parent, true)) {
        remove(parent, row);
        yield;
      }
      let ordinal = 0;
      for (const row of rows<LegacyEntry>('reordered')) {
        add(parent, { ...row.value, ordinal: ordinal++ });
        yield;
      }
      maps.reordered.clear();
      reorderPosition = 0;
    },
    insert(child) {
      put('inserted', ordered(insertPosition), child);
      insertPosition = increment(insertPosition);
    },
    *inserted() {
      for (const row of rows<number>('inserted')) yield row.value;
    },
    clearInserted() {
      maps.inserted.clear();
      insertPosition = 0;
    },
  };
  return { index, units: storage.spool('units'), stats: storage.stats, close: storage.close };
}
