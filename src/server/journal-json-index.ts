import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { DatabaseSync } from 'node:sqlite';

const BAD = new Set(['__proto__', 'constructor', 'prototype']);
function fail(): never {
  throw Error('Invalid journal JSON index input');
}
export interface JournalJsonWork {
  bytes: number;
  events: number;
  nodes: number;
  maxBufferBytes: number;
  parsedCodeUnits: number;
  validatedNodes: number;
  appliedChanges: number;
  droppedNodes: number;
  clonedNodes: number;
  yields: number;
}
export const journalJsonWork = (): JournalJsonWork => ({
  bytes: 0,
  events: 0,
  nodes: 0,
  maxBufferBytes: 0,
  parsedCodeUnits: 0,
  validatedNodes: 0,
  appliedChanges: 0,
  droppedNodes: 0,
  clonedNodes: 0,
  yields: 0,
});

export function drainJournalWork<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** Complete disposable JSON tree. Containers and strings live on disk; JS retains
 * only a 64 KiB input block, a string chunk, and the bounded path stack. */
export class JournalJsonIndex {
  readonly db: DatabaseSync;
  readonly work: JournalJsonWork;
  constructor(db: DatabaseSync, work = journalJsonWork()) {
    this.db = db;
    this.work = work;
    db.function('journal_key_valid', { deterministic: true }, (encoded) => {
      if (encoded === null) return 1;
      const key = JSON.parse(String(encoded)) as string;
      return key.length <= 1000 && !BAD.has(key) ? 1 : 0;
    });
    db.exec(`CREATE TABLE IF NOT EXISTS journal_nodes(id INTEGER PRIMARY KEY,parent INTEGER,key TEXT,kind TEXT NOT NULL,value TEXT,length INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS journal_child ON journal_nodes(parent,key);
      CREATE TABLE IF NOT EXISTS journal_strings(node INTEGER,ordinal INTEGER,text TEXT,PRIMARY KEY(node,ordinal));`);
  }
  node(id: number): {
    id: number;
    parent: number | null;
    key: string | null;
    kind: string;
    value: string | null;
    length: number;
  } {
    const row = this.db.prepare('SELECT * FROM journal_nodes WHERE id=?').get(id);
    if (!row) fail();
    return row as any;
  }
  child(id: number, key: string): number {
    const row = this.db
      .prepare('SELECT id FROM journal_nodes WHERE parent=? AND key=?')
      .get(id, JSON.stringify(key));
    if (!row) fail();
    return Number(row.id);
  }
  maybe(id: number, key: string): number | undefined {
    const row = this.db
      .prepare('SELECT id FROM journal_nodes WHERE parent=? AND key=?')
      .get(id, JSON.stringify(key));
    return row ? Number(row.id) : undefined;
  }
  scalar(id: number, maximum = Infinity): any {
    const row = this.node(id);
    if (row.kind === 'string') {
      if (row.length > maximum) fail();
      let value = '';
      for (const chunk of this.db
        .prepare('SELECT text FROM journal_strings WHERE node=? ORDER BY ordinal')
        .iterate(id))
        value += JSON.parse(String(chunk.text));
      return value;
    }
    if (row.kind === 'number' || row.kind === 'boolean' || row.kind === 'null')
      return JSON.parse(row.value!);
    fail();
  }
  field(id: number, key: string): any {
    return this.scalar(this.child(id, key));
  }
  nullable(id: number | undefined, key: string): unknown {
    const child = id === undefined ? undefined : this.maybe(id, key);
    return child === undefined ? null : this.scalar(child);
  }
  fields(id: number): string[] {
    if (this.node(id).kind !== 'object') fail();
    // Used only for envelopes and changes, whose fixed shapes bound this result.
    const keys: string[] = [];
    for (const row of this.db.prepare('SELECT key FROM journal_nodes WHERE parent=?').iterate(id)) {
      if (keys.length === 16) fail();
      keys.push(JSON.parse(String(row.key)) as string);
    }
    return keys.sort();
  }
  exact(id: number, fields: string[]): void {
    if (this.fields(id).join() !== fields.toSorted().join()) fail();
  }
  drop(id: number): void {
    drainJournalWork(this.dropSteps(id));
  }
  *dropSteps(id: number): Generator<void> {
    let current = id,
      steps = 0;
    for (;;) {
      const child = this.db
        .prepare('SELECT id FROM journal_nodes WHERE parent=? LIMIT 1')
        .get(current);
      if (child) {
        current = Number(child.id);
        if (++steps >= 128) {
          steps = 0;
          yield;
        }
        continue;
      }
      const node = this.node(current);
      for (;;) {
        const removed = this.db
          .prepare(
            'DELETE FROM journal_strings WHERE node=? AND ordinal IN (SELECT ordinal FROM journal_strings WHERE node=? LIMIT 128)',
          )
          .run(current, current);
        if (Number(removed.changes) < 128) break;
        yield;
      }
      this.db.prepare('DELETE FROM journal_nodes WHERE id=?').run(current);
      this.work.droppedNodes++;
      if (++steps >= 128) {
        steps = 0;
        yield;
      }
      if (current === id) return;
      if (node.parent === null) fail();
      current = node.parent;
    }
  }
  detach(id: number): void {
    this.db.prepare('UPDATE journal_nodes SET parent=NULL,key=NULL WHERE id=?').run(id);
  }
  clone(id: number): number {
    return drainJournalWork(this.cloneSteps(id));
  }
  *cloneSteps(id: number): Generator<void, number> {
    const original = this.node(id),
      copied = Number(
        this.db
          .prepare(
            'INSERT INTO journal_nodes(parent,key,kind,value,length) VALUES(NULL,NULL,?,?,?)',
          )
          .run(original.kind, original.value, original.length).lastInsertRowid,
      );
    this.work.clonedNodes++;
    let chunks = 0;
    for (const row of this.db
      .prepare('SELECT ordinal,text FROM journal_strings WHERE node=? ORDER BY ordinal')
      .iterate(id)) {
      this.db
        .prepare('INSERT INTO journal_strings VALUES(?,?,?)')
        .run(copied, row.ordinal, row.text);
      if (++chunks % 128 === 0) yield;
    }
    for (const row of this.db
      .prepare('SELECT id,key FROM journal_nodes WHERE parent=?')
      .iterate(id)) {
      const child = yield* this.cloneSteps(Number(row.id));
      this.db
        .prepare('UPDATE journal_nodes SET parent=?,key=? WHERE id=?')
        .run(copied, String(row.key), child);
    }
    if (this.work.clonedNodes % 128 === 0) yield;
    return copied;
  }
  path(id: number, keys: string[]): number {
    let current = id;
    for (const key of keys) {
      const node = this.node(current);
      if (node.kind !== 'object' && node.kind !== 'array') fail();
      if (node.kind === 'array' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= node.length))
        fail();
      current = this.child(current, key);
    }
    return current;
  }
  keys(id: number): string[] {
    const row = this.node(id);
    if (row.kind !== 'array' || row.length > 64) fail();
    const keys: string[] = [];
    for (let i = 0; i < row.length; i++) {
      const key = this.scalar(this.child(id, String(i)), 1000);
      if (typeof key !== 'string' || BAD.has(key)) fail();
      keys.push(key);
    }
    return keys;
  }
  parse(
    file: string,
    work: JournalJsonWork,
    onRead?: (bytes: number) => void,
    stagedTwin?: string,
  ): { root: number; digest: string; bytes: number } {
    return drainJournalWork(this.parseSteps(file, work, onRead, stagedTwin));
  }
  *parseSteps(
    file: string,
    work: JournalJsonWork,
    onRead?: (bytes: number) => void,
    stagedTwin?: string,
  ): Generator<void, { root: number; digest: string; bytes: number }> {
    if (realpathSync(file) !== file) fail();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const decoder = new StringDecoder('utf8'),
      hash = createHash('sha256'),
      block = Buffer.alloc(64 * 1024);
    let text = '',
      offset = 0,
      ended = false,
      bytes = 0,
      units = 0;
    work.maxBufferBytes = Math.max(work.maxBufferBytes, block.length);
    const peek = (): string => {
      while (offset === text.length && !ended) {
        const count = readSync(fd, block, 0, block.length, null);
        bytes += count;
        work.bytes += count;
        onRead?.(count);
        hash.update(block.subarray(0, count));
        text = count ? decoder.write(block.subarray(0, count)) : decoder.end();
        offset = 0;
        ended = !count;
      }
      return text[offset] ?? '';
    };
    const take = () => {
      const ch = peek();
      if (ch) {
        offset++;
        units++;
        work.parsedCodeUnits++;
      }
      return ch;
    };
    const ws = function* () {
      while (/^[\x20\t\r\n]$/.test(peek())) {
        take();
        if (units >= 4096) {
          units = 0;
          yield;
        }
      }
    };
    const expect = function* (ch: string) {
      yield* ws();
      if (take() !== ch) fail();
    };
    const insert = (
      parent: number | null,
      key: string | null,
      kind: string,
      value: string | null = null,
    ) => {
      work.nodes++;
      return Number(
        this.db
          .prepare('INSERT INTO journal_nodes(parent,key,kind,value) VALUES(?,?,?,?)')
          .run(parent, key === null ? null : JSON.stringify(key), kind, value).lastInsertRowid,
      );
    };
    const string = function* (emit: (chunk: string) => void): Generator<void, number> {
      yield* expect('"');
      let chunk = '',
        length = 0;
      const add = (ch: string) => {
        chunk += ch;
        length += ch.length;
        if (chunk.length >= 8192) {
          emit(chunk);
          chunk = '';
        }
      };
      while (true) {
        if (units >= 4096) {
          units = 0;
          yield;
        }
        const ch = take();
        if (!ch) fail();
        if (ch === '"') {
          if (chunk) emit(chunk);
          return length;
        }
        if (ch === '\\') {
          const escaped = take();
          if (escaped === 'u') {
            let code = '';
            for (let i = 0; i < 4; i++) {
              const hex = take();
              if (!/^[0-9a-fA-F]$/.test(hex)) fail();
              code += hex;
            }
            add(String.fromCharCode(parseInt(code, 16)));
          } else {
            const escapedChars: Record<string, string> = {
              '"': '"',
              '\\': '\\',
              '/': '/',
              b: '\b',
              f: '\f',
              n: '\n',
              r: '\r',
              t: '\t',
            };
            if (!Object.hasOwn(escapedChars, escaped)) fail();
            add(escapedChars[escaped]!);
          }
        } else {
          if (ch.charCodeAt(0) < 32) fail();
          add(ch);
        }
      }
    };
    const owner = this;
    const value = function* (parent: number | null, key: string | null): Generator<void, number> {
      yield* ws();
      const ch = peek();
      if (ch === '{' || ch === '[') {
        take();
        return insert(parent, key, ch === '[' ? 'array' : 'object', 'first');
      }
      if (ch === '"') {
        const id = insert(parent, key, 'string');
        let ordinal = 0;
        const length = yield* string((chunk) => {
          owner.db
            .prepare('INSERT INTO journal_strings VALUES(?,?,?)')
            .run(id, ordinal++, JSON.stringify(chunk));
        });
        owner.db.prepare('UPDATE journal_nodes SET length=? WHERE id=?').run(length, id);
        return id;
      }
      let raw = '';
      while (peek() && !/^[\x20\t\r\n,}\]]$/.test(peek())) {
        raw += take();
        if (raw.length > 1024) fail();
      }
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'number' && !Number.isFinite(parsed)) fail();
      if (parsed !== null && !['number', 'boolean'].includes(typeof parsed)) fail();
      return insert(parent, key, parsed === null ? 'null' : typeof parsed, raw);
    };
    try {
      const stat = fstatSync(fd),
        captured = fstatSync(fd, { bigint: true });
      if (!stat.isFile()) fail();
      if (stat.nlink !== 1) {
        if (stat.nlink !== 2 || !stagedTwin || realpathSync(stagedTwin) !== stagedTwin) fail();
        const twin = openSync(stagedTwin, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const other = fstatSync(twin);
          if (
            !other.isFile() ||
            other.nlink !== 2 ||
            other.dev !== stat.dev ||
            other.ino !== stat.ino
          )
            fail();
        } finally {
          closeSync(twin);
        }
      }
      const root = yield* value(null, null);
      let current: number | null = ['array', 'object'].includes(this.node(root).kind) ? root : null;
      // Parser continuation is stored on each container. Even ignored legacy
      // envelope fields cannot create a growing JS recursion stack.
      while (current !== null) {
        if (work.nodes % 128 === 0 || units >= 4096) {
          units = 0;
          yield;
        }
        const node = this.node(current),
          array = node.kind === 'array',
          close = array ? ']' : '}';
        yield* ws();
        if ((node.value === 'first' || node.value === 'after') && peek() === close) {
          take();
          this.db.prepare('UPDATE journal_nodes SET value=NULL WHERE id=?').run(current);
          current = node.parent;
          continue;
        }
        if (node.value === 'after') yield* expect(',');
        let name = String(node.length),
          old: number | undefined;
        if (!array) {
          name = '';
          yield* string((chunk) => {
            name += chunk;
          });
          yield* expect(':');
          old = this.maybe(current, name);
          if (old !== undefined) yield* this.dropSteps(old);
        }
        const child = yield* value(current, name);
        this.db
          .prepare("UPDATE journal_nodes SET value='after',length=length+? WHERE id=?")
          .run(old === undefined ? 1 : 0, current);
        if (['array', 'object'].includes(this.node(child).kind)) current = child;
      }
      yield* ws();
      if (peek() || bytes !== stat.size) fail();
      // A cold caller can yield while this descriptor is open. The selected
      // path must still name this exact unchanged retained file at completion.
      if (realpathSync(file) !== file) fail();
      const selectedFd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const selected = fstatSync(selectedFd, { bigint: true }),
          retained = fstatSync(fd, { bigint: true });
        for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'] as const)
          if (selected[key] !== captured[key] || retained[key] !== captured[key]) fail();
      } finally {
        closeSync(selectedFd);
      }
      work.events++;
      return { root, digest: hash.digest('hex'), bytes };
    } finally {
      closeSync(fd);
    }
  }
  replace(parent: number, key: string, value: number): void {
    drainJournalWork(this.replaceSteps(parent, key, value));
  }
  *replaceSteps(parent: number, key: string, value: number): Generator<void> {
    const node = this.node(parent),
      old = this.maybe(parent, key);
    if (node.kind !== 'object' && node.kind !== 'array') fail();
    if (node.kind === 'array') {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > node.length) fail();
      if (Number(key) === node.length)
        this.db.prepare('UPDATE journal_nodes SET length=length+1 WHERE id=?').run(parent);
    }
    this.detach(value);
    if (old !== undefined) yield* this.dropSteps(old);
    this.db
      .prepare('UPDATE journal_nodes SET parent=?,key=? WHERE id=?')
      .run(parent, JSON.stringify(key), value);
  }
  truncate(id: number, length: number, allowEqual = false): void {
    drainJournalWork(this.truncateSteps(id, length, allowEqual));
  }
  *truncateSteps(id: number, length: number, allowEqual = false): Generator<void> {
    const node = this.node(id);
    if (
      node.kind !== 'array' ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      (allowEqual ? length > node.length : length >= node.length)
    )
      fail();
    for (let i = length; i < node.length; i++) {
      const child = this.maybe(id, String(i));
      if (child !== undefined) yield* this.dropSteps(child);
    }
    this.db.prepare('UPDATE journal_nodes SET length=? WHERE id=?').run(length, id);
  }
  splice(id: number, offset: number, remove: number, inserted: number): number {
    return drainJournalWork(this.spliceSteps(id, offset, remove, inserted));
  }
  *spliceSteps(
    id: number,
    offset: number,
    remove: number,
    inserted: number,
  ): Generator<void, number> {
    const node = this.node(id),
      addition = this.node(inserted);
    if (
      node.kind !== 'string' ||
      addition.kind !== 'string' ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(remove) ||
      offset < 0 ||
      remove < 0 ||
      offset + remove > node.length
    )
      fail();
    const result = Number(
      this.db.prepare("INSERT INTO journal_nodes(kind) VALUES('string')").run().lastInsertRowid,
    );
    let ordinal = 0;
    const append = (text: string) => {
      if (text)
        this.db
          .prepare('INSERT INTO journal_strings VALUES(?,?,?)')
          .run(result, ordinal++, JSON.stringify(text));
    };
    const owner = this;
    const slice = function* (from: number, to: number): Generator<void> {
      let position = 0;
      for (const row of owner.db
        .prepare('SELECT text FROM journal_strings WHERE node=? ORDER BY ordinal')
        .iterate(id)) {
        const text = JSON.parse(String(row.text)) as string,
          end = position + text.length;
        if (end > from && position < to)
          append(text.slice(Math.max(0, from - position), Math.min(text.length, to - position)));
        position = end;
        yield;
        if (position >= to) break;
      }
    };
    yield* slice(0, offset);
    for (const row of this.db
      .prepare('SELECT text FROM journal_strings WHERE node=? ORDER BY ordinal')
      .iterate(inserted)) {
      append(JSON.parse(String(row.text)) as string);
      yield;
    }
    yield* slice(offset + remove, node.length);
    this.db
      .prepare('UPDATE journal_nodes SET length=? WHERE id=?')
      .run(node.length - remove + addition.length, result);
    return result;
  }
}
