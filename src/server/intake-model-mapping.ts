/** Current mapping policy has its existing decoded-array contract. This adapter
 * adds bounded model pages and addressed fragments without serializing a giant
 * rule into an additional in-memory string. Scratch is never authority. */
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { Database } from './database.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import type { ModelIntakeSectionBackend } from './intake-model-context-v4.ts';

type Provider = Pick<ModelIntakeSectionBackend, 'section' | 'sectionPage' | 'externalFragment'>;
type Cached = {
  db: Database;
  version: string;
  scratch: ReturnType<typeof disposableSqlite>;
  count: number;
};
const cache: Cached[] = [];
const epochs = new WeakMap<Database, number>();
let allEpoch = 0;
let preparations = 0;
export function clearIntakeMappingSections(db?: Database) {
  if (db) epochs.set(db, (epochs.get(db) ?? 0) + 1);
  else allEpoch++;
  for (let i = cache.length - 1; i >= 0; i--)
    if (!db || cache[i]!.db === db) cache.splice(i, 1)[0]!.scratch.close();
}
/** JSON-decoded policy values have no accessors, cycles or custom toJSON. */
function* pieces(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield '"';
    for (let at = 0; at < value.length;) {
      let end = Math.min(value.length, at + 1024);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
      yield JSON.stringify(value.slice(at, end)).slice(1, -1);
      at = end;
    }
    yield '"';
  } else if (Array.isArray(value)) {
    yield '[';
    for (let i = 0; i < value.length; i++) {
      if (i) yield ',';
      yield* pieces(value[i] ?? null);
    }
    yield ']';
  } else if (value && typeof value === 'object') {
    yield '{';
    let first = true;
    for (const key in value)
      if (Object.hasOwn(value, key)) {
        const child = (value as Record<string, unknown>)[key];
        if (child === undefined) continue;
        if (!first) yield ',';
        first = false;
        yield* pieces(key);
        yield ':';
        yield* pieces(child);
      }
    yield '}';
  } else yield JSON.stringify(value) ?? 'null';
}
export async function prepareIntakeMappingSection(
  db: Database,
  rules: readonly unknown[],
  version: string,
  options: { assertCurrent?: () => void } = {},
): Promise<Provider> {
  options.assertCurrent?.();
  let entry = cache.find((x) => x.db === db && x.version === version);
  if (!entry) {
    if (preparations >= 2) throw Error('Mapping section preparation is busy');
    const scratch = disposableSqlite('intake-model-mapping-'),
      epoch = epochs.get(db) ?? 0,
      global = allEpoch;
    const assert = () => {
      options.assertCurrent?.();
      if (epoch !== (epochs.get(db) ?? 0) || global !== allEpoch)
        throw Error('Mapping section preparation cancelled');
    };
    preparations++;
    try {
      scratch.db.exec(
        'CREATE TABLE rules(ordinal INTEGER PRIMARY KEY,bytes INTEGER,root TEXT); CREATE TABLE chunks(ordinal INTEGER,offset INTEGER,text TEXT,bytes INTEGER,PRIMARY KEY(ordinal,offset));',
      );
      const put = scratch.db.prepare('INSERT INTO chunks VALUES(?,?,?,?)'),
        putRule = scratch.db.prepare('INSERT INTO rules VALUES(?,?,?)');
      let work = 0;
      for (let ordinal = 0; ordinal < rules.length; ordinal++) {
        let bytes = 0,
          buffer = '';
        const hash = createHash('sha256');
        const flush = () => {
          if (!buffer) return;
          const n = Buffer.byteLength(buffer);
          put.run(ordinal, bytes, buffer, n);
          hash.update(buffer);
          bytes += n;
          buffer = '';
        };
        for (const piece of pieces(rules[ordinal])) {
          if (Buffer.byteLength(buffer) + Buffer.byteLength(piece) > 8192) flush();
          buffer += piece;
          if (++work % 128 === 0) {
            assert();
            await setImmediate();
          }
        }
        flush();
        putRule.run(ordinal, bytes, hash.digest('hex'));
        assert();
      }
      assert();
      entry = { db, version, scratch, count: rules.length };
      cache.push(entry);
      while (cache.length > 8) cache.shift()!.scratch.close();
    } catch (error) {
      scratch.close();
      throw error;
    } finally {
      preparations--;
    }
  }
  const selected = entry;
  const assert = () => {
    options.assertCurrent?.();
    if (!cache.includes(selected)) throw Error('Mapping section preparation required');
  };
  const position = (text: string | undefined, max: number) => {
    if (text === undefined) return 0;
    if (!/^(0|[1-9][0-9]*)$/.test(text)) throw Error('Invalid mapping position');
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n > max) throw Error('Invalid mapping position');
    return n;
  };
  return {
    section(section) {
      assert();
      return section === 'mapping_rules'
        ? { state: 'complete', root: version, count: selected.count }
        : { state: 'pending' };
    },
    sectionPage(section, options) {
      assert();
      if (section !== 'mapping_rules') throw Error('Invalid mapping section');
      const start = position(options.after, selected.count),
        entries: ReturnType<Provider['sectionPage']>['entries'] = [];
      let bytes = 0,
        ordinal = start;
      while (ordinal < selected.count && entries.length < options.items) {
        const row = selected.scratch.db
          .prepare('SELECT bytes,root FROM rules WHERE ordinal=?')
          .get(ordinal) as { bytes: number; root: string };
        const value = {
          tag: 'mapping_rule',
          records: [],
          externalValue: { key: String(ordinal), bytes: row.bytes, root: row.root },
        };
        const size = Buffer.byteLength(JSON.stringify(value));
        if (entries.length && bytes + size > options.bytes) break;
        entries.push(value);
        bytes += size;
        ordinal++;
      }
      return {
        root: version,
        entries,
        complete: ordinal === selected.count,
        after: ordinal === selected.count ? null : String(ordinal),
      };
    },
    externalFragment(section, key, options) {
      assert();
      if (section !== 'mapping_rules') throw Error('Invalid mapping section');
      const ordinal = position(key, selected.count - 1),
        row = selected.scratch.db
          .prepare('SELECT bytes,root FROM rules WHERE ordinal=?')
          .get(ordinal) as { bytes: number; root: string } | undefined;
      if (!row) throw Error('Unknown mapping rule');
      let offset = position(options.after, row.bytes),
        jsonText = '';
      const start = offset;
      while (offset < row.bytes && offset - start < options.bytes) {
        const chunk = selected.scratch.db
          .prepare(
            'SELECT offset,text,bytes FROM chunks WHERE ordinal=? AND offset<=? ORDER BY offset DESC LIMIT 1',
          )
          .get(ordinal, offset) as { offset: number; text: string; bytes: number };
        const buffer = Buffer.from(chunk.text),
          local = offset - chunk.offset;
        let end = Math.min(buffer.length, local + options.bytes - (offset - start));
        while (end > local && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
        if (end === local) break;
        jsonText += buffer.subarray(local, end).toString('utf8');
        offset += end - local;
      }
      if (offset === start && offset < row.bytes)
        throw Error('Mapping fragment budget is too small');
      return {
        root: row.root,
        jsonText,
        totalBytes: row.bytes,
        complete: offset === row.bytes,
        after: offset === row.bytes ? null : String(offset),
      };
    },
  };
}
