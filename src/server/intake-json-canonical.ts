/** Private disk-backed JSON normalization. Scratch is never recovery authority. */
import { mkdtempSync, openSync, closeSync, readSync, writeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { disposableSqlite } from './disposable-sqlite.ts';
import type { StatementSync } from 'node:sqlite';
import type { DatabaseSync } from 'node:sqlite';
import {
  withIntakeWork,
  recordIntakeWork,
  recordIntakePeak,
  type IntakeWorkPhase,
} from './intake-work-accounting.ts';

declare const handleBrand: unique symbol;
export interface IntakeJsonCanonicalHandle {
  readonly [handleBrand]: true;
}
export type IntakeJsonCanonicalKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
export interface IntakeJsonCanonicalWork {
  inputCodeUnits: number;
  sqliteCalls: number;
  scratchWrittenBytes: number;
  scratchReadBytes: number;
  outputBytes: number;
  maxChunkBytes: number;
  maxBufferBytes: number;
  maxNumberDigits: number;
  yields: number;
}
export interface PreparedIntakeJsonCanonical {
  readonly root: IntakeJsonCanonicalHandle;
  readonly bytes: number;
  readonly work: IntakeJsonCanonicalWork;
  kind(handle: IntakeJsonCanonicalHandle): IntakeJsonCanonicalKind;
  field(handle: IntakeJsonCanonicalHandle, name: string): IntakeJsonCanonicalHandle | undefined;
  arrayItems(handle: IntakeJsonCanonicalHandle): Iterable<IntakeJsonCanonicalHandle>;
  objectFields(handle: IntakeJsonCanonicalHandle): Iterable<{
    name(): Iterable<string>;
    value: IntakeJsonCanonicalHandle;
    matches(name: string): boolean;
  }>;
  pieces(handle: IntakeJsonCanonicalHandle): Iterable<string>;
  chunks(): Iterable<string>;
  splitObjectField(
    handle: IntakeJsonCanonicalHandle,
    name: string,
  ):
    | {
        before(): Iterable<string>;
        value: IntakeJsonCanonicalHandle;
        after(): Iterable<string>;
      }
    | undefined;
  close(): void;
}

/** Fixed logical work; scratch byte totals cover scalar/output spools. SQLite
 * calls are counted separately, not presented as physical SQLite IO or RSS. */
export function intakeJsonCanonicalWorkObserver(db: DatabaseSync, phase: IntakeWorkPhase = 'warm') {
  return (work: Readonly<IntakeJsonCanonicalWork>) =>
    withIntakeWork(db, phase, () => {
      recordIntakeWork('jsonCanonicalInputCodeUnits', work.inputCodeUnits);
      recordIntakeWork('jsonCanonicalSqliteCalls', work.sqliteCalls);
      recordIntakeWork('jsonCanonicalScratchReadBytes', work.scratchReadBytes);
      recordIntakeWork('jsonCanonicalScratchWrittenBytes', work.scratchWrittenBytes);
      recordIntakeWork('jsonCanonicalOutputBytes', work.outputBytes);
      recordIntakeWork('jsonCanonicalYields', work.yields);
      recordIntakePeak('jsonCanonicalPeakBufferBytes', work.maxBufferBytes);
      recordIntakePeak('jsonCanonicalPeakChunkBytes', work.maxChunkBytes);
    });
}

export interface IntakeJsonCanonicalOptions {
  mode?: 'canonical' | 'stringify';
  /** Preserve each valid numeric token for literal-preserving authority hashes. */
  preserveNumbers?: boolean;
  assertRunning?: () => void;
  onWork?: (work: Readonly<IntakeJsonCanonicalWork>) => void;
}

/** The same parser with explicit work boundaries for off-host replay drivers. */
export function* prepareIntakeJsonCanonicalSteps(
  pieces: Iterable<string>,
  options: IntakeJsonCanonicalOptions = {},
): Generator<void, PreparedIntakeJsonCanonical> {
  if (options.mode !== undefined && options.mode !== 'canonical' && options.mode !== 'stringify')
    throw Error('Invalid JSON canonical mode');
  options.assertRunning?.();
  const engine = new CanonicalEngine(
    pieces,
    options.mode ?? 'canonical',
    options.assertRunning,
    options.onWork,
    options.preserveNumbers ?? false,
  );
  let complete = false;
  try {
    for (const _ of engine.prepare()) {
      void _;
      options.assertRunning?.();
      engine.work.yields++;
      yield;
    }
    options.assertRunning?.();
    const result = engine.result();
    complete = true;
    return result;
  } finally {
    if (!complete) engine.close();
  }
}

export async function prepareIntakeJsonCanonical(
  pieces: Iterable<string>,
  options: IntakeJsonCanonicalOptions = {},
): Promise<PreparedIntakeJsonCanonical> {
  const steps = prepareIntakeJsonCanonicalSteps(pieces, options);
  try {
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
      await setImmediate();
    }
  } finally {
    steps.return(undefined as never);
  }
}

type SqlValue = string | number | null;
interface NodeRow {
  id: number;
  kind: IntakeJsonCanonicalKind | 'root';
  parent: number;
  state: string;
  n: number;
  key: number;
  trie: number;
  raw_start: number;
  raw_bytes: number;
  out_start: number;
  out_bytes: number;
  cursor: number;
  emitted: number;
  phase: number;
}
interface TrieRow {
  id: number;
  parent: number;
  unit: number;
  object: number;
  value: number | null;
  first_order: number;
  key_number: number;
  raw_start: number;
  raw_bytes: number;
}
const BUFFER = 8192;
class Spool {
  length = 0;
  private used = 0;
  private buffer = Buffer.alloc(BUFFER);
  readonly fd: number;
  private work: IntakeJsonCanonicalWork;
  constructor(fd: number, work: IntakeJsonCanonicalWork) {
    this.fd = fd;
    this.work = work;
    work.maxBufferBytes = Math.max(work.maxBufferBytes, BUFFER);
  }
  append(text: string) {
    this.appendBytes(Buffer.from(text));
  }
  appendBytes(bytes: Uint8Array) {
    let at = 0;
    while (at < bytes.length) {
      const count = Math.min(BUFFER - this.used, bytes.length - at);
      this.buffer.set(bytes.subarray(at, at + count), this.used);
      at += count;
      this.used += count;
      this.length += count;
      if (!Number.isSafeInteger(this.length)) throw Error('JSON scratch byte count overflow');
      if (this.used === BUFFER) this.flush();
    }
  }
  flush() {
    let at = 0;
    while (at < this.used) {
      const count = writeSync(this.fd, this.buffer, at, this.used - at);
      if (!count) throw Error('JSON scratch write did not advance');
      at += count;
      this.work.scratchWrittenBytes += count;
    }
    this.used = 0;
  }
  *read(start: number, bytes: number): Generator<Buffer> {
    this.flush();
    const buffer = Buffer.alloc(BUFFER);
    while (bytes) {
      const count = readSync(this.fd, buffer, 0, Math.min(BUFFER, bytes), start);
      if (!count) throw Error('Truncated JSON scratch');
      this.work.scratchReadBytes += count;
      yield buffer.subarray(0, count);
      start += count;
      bytes -= count;
    }
  }
}
class CanonicalEngine {
  readonly work: IntakeJsonCanonicalWork = {
    inputCodeUnits: 0,
    sqliteCalls: 0,
    scratchWrittenBytes: 0,
    scratchReadBytes: 0,
    outputBytes: 0,
    maxChunkBytes: 0,
    maxBufferBytes: 0,
    maxNumberDigits: 0,
    yields: 0,
  };
  private directory: string;
  private scratch: ReturnType<typeof disposableSqlite>;
  private raw: Spool;
  private output: Spool;
  private statements = new Map<string, StatementSync>();
  private handles = new WeakMap<IntakeJsonCanonicalHandle, number>();
  private iterator: Iterator<string>;
  private block = '';
  private at = 0;
  private ended = false;
  private inputClosed = false;
  private closed = false;
  private rootId = 0;
  private quantum = 0;
  private mode: 'canonical' | 'stringify';
  private preserveNumbers: boolean;
  private assertRunning?: () => void;
  private onWork?: (work: Readonly<IntakeJsonCanonicalWork>) => void;
  constructor(
    pieces: Iterable<string>,
    mode: 'canonical' | 'stringify',
    assertRunning?: () => void,
    onWork?: (work: Readonly<IntakeJsonCanonicalWork>) => void,
    preserveNumbers = false,
  ) {
    this.mode = mode;
    this.preserveNumbers = preserveNumbers;
    this.assertRunning = assertRunning;
    this.onWork = onWork;
    this.iterator = pieces[Symbol.iterator]();
    this.directory = mkdtempSync(join(tmpdir(), 'intake-json-canonical-'));
    let rawFd: number | undefined, outputFd: number | undefined;
    let scratch: ReturnType<typeof disposableSqlite> | undefined;
    try {
      rawFd = openSync(join(this.directory, 'scalars'), 'wx+', 0o600);
      outputFd = openSync(join(this.directory, 'output'), 'wx+', 0o600);
      scratch = disposableSqlite('intake-json-canonical-index-');
      this.scratch = scratch;
      this.raw = new Spool(rawFd, this.work);
      this.output = new Spool(outputFd, this.work);
      scratch.db.exec(`
        CREATE TABLE nodes(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,parent INTEGER NOT NULL,state TEXT NOT NULL,
          n INTEGER NOT NULL DEFAULT 0,key INTEGER NOT NULL DEFAULT 0,trie INTEGER NOT NULL DEFAULT 0,
          raw_start INTEGER NOT NULL DEFAULT 0,raw_bytes INTEGER NOT NULL DEFAULT 0,
          out_start INTEGER NOT NULL DEFAULT -1,out_bytes INTEGER NOT NULL DEFAULT 0,
          cursor INTEGER NOT NULL DEFAULT -1,emitted INTEGER NOT NULL DEFAULT 0,phase INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE children(parent INTEGER NOT NULL,ordinal INTEGER NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(parent,ordinal)) WITHOUT ROWID;
        CREATE TABLE trie(id INTEGER PRIMARY KEY,parent INTEGER NOT NULL,unit INTEGER NOT NULL,object INTEGER NOT NULL,
          value INTEGER,first_order INTEGER NOT NULL DEFAULT -1,key_number INTEGER NOT NULL DEFAULT -1,
          raw_start INTEGER NOT NULL DEFAULT 0,raw_bytes INTEGER NOT NULL DEFAULT 0,emit_order INTEGER NOT NULL DEFAULT -1);
        CREATE UNIQUE INDEX trie_edge ON trie(parent,unit);
        CREATE INDEX trie_numeric ON trie(object,key_number) WHERE value IS NOT NULL;
        CREATE INDEX trie_insertion ON trie(object,first_order) WHERE value IS NOT NULL;
        CREATE INDEX trie_emitted ON trie(object,emit_order) WHERE value IS NOT NULL;
        INSERT INTO nodes(id,kind,parent,state) VALUES(0,'root',-1,'value');
        BEGIN;
      `);
    } catch (error) {
      if (rawFd !== undefined) closeSync(rawFd);
      if (outputFd !== undefined) closeSync(outputFd);
      scratch?.close();
      rmSync(this.directory, { recursive: true, force: true });
      this.iterator.return?.();
      this.onWork?.(Object.freeze({ ...this.work }));
      throw error;
    }
  }
  private statement(sql: string) {
    this.work.sqliteCalls++;
    this.quantum++;
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.scratch.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  private get(sql: string, ...args: SqlValue[]) {
    return this.statement(sql).get(...args);
  }
  private run(sql: string, ...args: SqlValue[]) {
    return this.statement(sql).run(...args);
  }
  private node(id: number) {
    const value = this.get('SELECT * FROM nodes WHERE id=?', id);
    if (!value) throw Error('Missing JSON node');
    return value as unknown as NodeRow;
  }
  private trie(id: number) {
    const value = this.get('SELECT * FROM trie WHERE id=?', id);
    if (!value) throw Error('Missing JSON key');
    return value as unknown as TrieRow;
  }
  private due() {
    if (this.quantum < 2048) return false;
    this.quantum = 0;
    return true;
  }
  private peek(): string {
    while (this.at === this.block.length && !this.ended) {
      const next = this.iterator.next();
      this.ended = !!next.done;
      this.block = next.value ?? '';
      this.at = 0;
    }
    return this.block[this.at] ?? '';
  }
  private take() {
    const char = this.peek();
    if (char) {
      this.at++;
      this.work.inputCodeUnits++;
      this.quantum++;
    }
    return char;
  }
  private fail(): never {
    throw Error('Invalid JSON canonical input');
  }
  private closeInput() {
    if (this.inputClosed) return;
    this.inputClosed = true;
    this.iterator.return?.();
  }
  private expect(char: string) {
    if (this.take() !== char) this.fail();
  }
  private *space(): Generator<void> {
    while (/^[\x20\t\r\n]$/.test(this.peek())) {
      this.take();
      if (this.due()) yield;
    }
  }
  private keyEdge(parent: number, unit: number, object: number) {
    const row = this.get('SELECT id FROM trie WHERE parent=? AND unit=?', parent, unit);
    if (row) return Number(row.id);
    return Number(
      this.run('INSERT INTO trie(parent,unit,object) VALUES(?,?,?)', parent, unit, object)
        .lastInsertRowid,
    );
  }
  /** Decode only one code unit at a time. The trie stores full names on disk. */
  private *string(key?: {
    root: number;
    object: number;
    order: number;
  }): Generator<void, { start: number; bytes: number; terminal: number }> {
    this.expect('"');
    const start = this.raw.length;
    this.raw.append('"');
    let high = '',
      terminal = key?.root ?? 0,
      keyNumber = 0,
      keyDigits = 0,
      numeric = true;
    const emit = (char: string) => {
      if (high) {
        if (/^[\uDC00-\uDFFF]$/.test(char)) {
          this.raw.append(JSON.stringify(high + char).slice(1, -1));
          high = '';
          return;
        }
        this.raw.append(JSON.stringify(high).slice(1, -1));
        high = '';
      }
      if (/^[\uD800-\uDBFF]$/.test(char)) high = char;
      else this.raw.append(JSON.stringify(char).slice(1, -1));
    };
    while (true) {
      let char = this.take();
      if (!char) this.fail();
      if (char === '"') break;
      if (char === '\\') {
        const escape = this.take();
        if (escape === 'u') {
          let digits = '';
          for (let n = 0; n < 4; n++) {
            const digit = this.take();
            if (!/^[a-fA-F0-9]$/.test(digit)) this.fail();
            digits += digit;
          }
          char = String.fromCharCode(parseInt(digits, 16));
        } else {
          const escapes: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (!Object.hasOwn(escapes, escape)) this.fail();
          char = escapes[escape]!;
        }
      } else if (char.charCodeAt(0) < 32) this.fail();
      if (key) {
        terminal = this.keyEdge(terminal, char.charCodeAt(0), key.object);
        if (!/^\d$/.test(char) || keyDigits >= 10 || (keyDigits === 1 && keyNumber === 0))
          numeric = false;
        if (numeric) keyNumber = keyNumber * 10 + Number(char);
        keyDigits++;
      }
      emit(char);
      if (this.due()) yield;
    }
    if (high) this.raw.append(JSON.stringify(high).slice(1, -1));
    this.raw.append('"');
    const bytes = this.raw.length - start;
    if (key) {
      const row = this.trie(terminal);
      if (row.first_order < 0)
        this.run(
          'UPDATE trie SET first_order=?,key_number=?,raw_start=?,raw_bytes=? WHERE id=?',
          key.order,
          numeric && keyDigits > 0 && keyNumber < 4294967295 ? keyNumber : -1,
          start,
          bytes,
          terminal,
        );
    }
    return { start, bytes, terminal };
  }
  private *number(): Generator<void, string> {
    const take = () => {
      const char = this.take();
      if (this.preserveNumbers) this.raw.append(char);
      return char;
    };
    let negative = false,
      fraction = 0,
      significant = 0,
      kept = '',
      sticky = false,
      started = false;
    if (this.peek() === '-') {
      negative = true;
      take();
    }
    const digit = (char: string, decimal: boolean) => {
      if (decimal) fraction++;
      if (char !== '0') started = true;
      if (started) {
        significant++;
        if (kept.length < 1200) kept += char;
        else if (char !== '0') sticky = true;
      }
      if (!Number.isSafeInteger(fraction) || !Number.isSafeInteger(significant)) this.fail();
    };
    if (this.peek() === '0') digit(take(), false);
    else {
      if (!/^[1-9]$/.test(this.peek())) this.fail();
      do {
        digit(take(), false);
        if (this.due()) yield;
      } while (/^\d$/.test(this.peek()));
    }
    if (this.peek() === '.') {
      take();
      if (!/^\d$/.test(this.peek())) this.fail();
      do {
        digit(take(), true);
        if (this.due()) yield;
      } while (/^\d$/.test(this.peek()));
    }
    let exponent = 0,
      exponentNegative = false;
    if (this.peek() === 'e' || this.peek() === 'E') {
      take();
      if (this.peek() === '+' || this.peek() === '-') exponentNegative = take() === '-';
      if (!/^\d$/.test(this.peek())) this.fail();
      do {
        exponent = Math.min(Number.MAX_SAFE_INTEGER * 2, exponent * 10 + Number(take()));
        if (this.due()) yield;
      } while (/^\d$/.test(this.peek()));
    }
    if (exponentNegative) exponent = -exponent;
    // Same binary64 midpoint/sticky algorithm as intake-json-scalar.ts.
    const adjusted = exponent - fraction + significant - kept.length - (sticky ? 1 : 0);
    this.work.maxNumberDigits = Math.max(this.work.maxNumberDigits, kept.length + (sticky ? 1 : 0));
    return JSON.stringify(
      started ? Number((negative ? '-' : '') + kept + (sticky ? '1' : '') + 'e' + adjusted) : 0,
    );
  }
  private *value(parent: NodeRow): Generator<void, number> {
    yield* this.space();
    const char = this.peek();
    const kind: IntakeJsonCanonicalKind =
      char === '{'
        ? 'object'
        : char === '['
          ? 'array'
          : char === '"'
            ? 'string'
            : char === 'n'
              ? 'null'
              : char === 't' || char === 'f'
                ? 'boolean'
                : 'number';
    const id = Number(
      this.run('INSERT INTO nodes(kind,parent,state) VALUES(?,?,?)', kind, parent.id, 'first')
        .lastInsertRowid,
    );
    if (parent.kind === 'root') this.rootId = id;
    else if (parent.kind === 'array')
      this.run('INSERT INTO children(parent,ordinal,value) VALUES(?,?,?)', parent.id, parent.n, id);
    else this.run('UPDATE trie SET value=? WHERE id=?', id, parent.key);
    this.run('UPDATE nodes SET state=?,n=n+1 WHERE id=?', 'after', parent.id);
    if (kind === 'object' || kind === 'array') {
      this.take();
      if (kind === 'object') {
        const trie = Number(
          this.run('INSERT INTO trie(parent,unit,object) VALUES(?,?,?)', -id, -1, id)
            .lastInsertRowid,
        );
        this.run('UPDATE nodes SET trie=? WHERE id=?', trie, id);
      }
      return id;
    }
    const start = this.raw.length;
    if (kind === 'string') yield* this.string();
    else if (kind === 'number') {
      const normalized = yield* this.number();
      if (!this.preserveNumbers) this.raw.append(normalized);
    } else {
      const literal = kind === 'null' ? 'null' : char === 't' ? 'true' : 'false';
      for (const expected of literal) this.expect(expected);
      this.raw.append(literal);
    }
    this.run(
      'UPDATE nodes SET raw_start=?,raw_bytes=? WHERE id=?',
      start,
      this.raw.length - start,
      id,
    );
    return parent.id;
  }
  private *parse(): Generator<void> {
    let current = 0;
    while (true) {
      yield* this.space();
      const node = this.node(current),
        char = this.peek();
      if (this.due()) yield;
      if (node.kind === 'root') {
        if (node.state === 'after') {
          if (char) this.fail();
          break;
        }
        current = yield* this.value(node);
        continue;
      }
      const close = node.kind === 'object' ? '}' : ']';
      if (node.state === 'after') {
        if (char === close) {
          this.take();
          current = node.parent;
          continue;
        }
        this.expect(',');
        this.run('UPDATE nodes SET state=? WHERE id=?', 'next', current);
        continue;
      }
      if (node.state === 'first' && char === close) {
        this.take();
        current = node.parent;
        continue;
      }
      if (node.kind === 'object') {
        const key = yield* this.string({ root: node.trie, object: node.id, order: node.n });
        yield* this.space();
        this.expect(':');
        node.key = key.terminal;
        this.run('UPDATE nodes SET key=? WHERE id=?', key.terminal, node.id);
      }
      current = yield* this.value(node);
    }
    this.closeInput();
    this.ended = true;
    this.block = '';
    this.at = 0;
    this.raw.flush();
  }
  private *nextKey(root: number, last: number): Generator<void, TrieRow | undefined> {
    let current = last < 0 ? root : last,
      consider = last < 0;
    while (true) {
      if (this.due()) yield;
      const row = this.trie(current);
      if (consider && row.value !== null) return row;
      const child = this.get('SELECT id FROM trie WHERE parent=? ORDER BY unit LIMIT 1', current);
      if (child) {
        current = Number(child.id);
        consider = true;
        continue;
      }
      while (current !== root) {
        const at = this.trie(current),
          sibling = this.get(
            'SELECT id FROM trie WHERE parent=? AND unit>? ORDER BY unit LIMIT 1',
            at.parent,
            at.unit,
          );
        if (sibling) {
          current = Number(sibling.id);
          consider = true;
          break;
        }
        current = at.parent;
        if (this.due()) yield;
      }
      if (current === root) return undefined;
    }
  }
  private *emit(): Generator<void> {
    let current = this.rootId;
    while (current !== 0) {
      if (this.due()) yield;
      const node = this.node(current);
      if (node.out_start < 0) {
        this.run('UPDATE nodes SET out_start=? WHERE id=?', this.output.length, current);
        node.out_start = this.output.length;
        if (node.kind === 'array' || node.kind === 'object')
          this.output.append(node.kind === 'array' ? '[' : '{');
        else {
          for (const bytes of this.raw.read(node.raw_start, node.raw_bytes)) {
            this.output.appendBytes(bytes);
            this.quantum += bytes.length;
            if (this.due()) yield;
          }
          this.run(
            'UPDATE nodes SET out_bytes=? WHERE id=?',
            this.output.length - node.out_start,
            current,
          );
          current = node.parent;
          continue;
        }
      }
      let child: number | undefined, key: TrieRow | undefined;
      if (node.kind === 'array') {
        const row = this.get(
          'SELECT ordinal,value FROM children WHERE parent=? AND ordinal>? ORDER BY ordinal LIMIT 1',
          current,
          node.cursor,
        );
        if (row) {
          child = Number(row.value);
          this.run('UPDATE nodes SET cursor=? WHERE id=?', Number(row.ordinal), current);
        }
      } else if (this.mode === 'canonical') {
        key = yield* this.nextKey(node.trie, node.cursor);
        if (key) this.run('UPDATE nodes SET cursor=? WHERE id=?', key.id, current);
      } else {
        if (node.phase === 0) {
          key = this.get(
            'SELECT * FROM trie WHERE object=? AND value IS NOT NULL AND key_number>=0 AND key_number>? ORDER BY key_number LIMIT 1',
            current,
            node.cursor,
          ) as unknown as TrieRow | undefined;
          if (key) this.run('UPDATE nodes SET cursor=? WHERE id=?', key.key_number, current);
          else {
            node.phase = 1;
            node.cursor = -1;
            this.run('UPDATE nodes SET phase=1,cursor=-1 WHERE id=?', current);
          }
        }
        if (node.phase === 1) {
          key = this.get(
            'SELECT * FROM trie WHERE object=? AND value IS NOT NULL AND key_number=-1 AND first_order>? ORDER BY first_order LIMIT 1',
            current,
            node.cursor,
          ) as unknown as TrieRow | undefined;
          if (key) this.run('UPDATE nodes SET cursor=? WHERE id=?', key.first_order, current);
        }
      }
      if (key) child = key.value!;
      if (child !== undefined) {
        if (node.emitted) this.output.append(',');
        this.run('UPDATE nodes SET emitted=emitted+1 WHERE id=?', current);
        if (key) {
          this.run('UPDATE trie SET emit_order=? WHERE id=?', node.emitted, key.id);
          for (const bytes of this.raw.read(key.raw_start, key.raw_bytes)) {
            this.output.appendBytes(bytes);
            this.quantum += bytes.length;
            if (this.due()) yield;
          }
          this.output.append(':');
        }
        current = child;
      } else {
        this.output.append(node.kind === 'array' ? ']' : '}');
        this.run(
          'UPDATE nodes SET out_bytes=? WHERE id=?',
          this.output.length - node.out_start,
          current,
        );
        current = node.parent;
      }
    }
    this.output.flush();
    this.work.outputBytes = this.output.length;
    this.scratch.db.exec('COMMIT');
  }
  *prepare(): Generator<void> {
    yield* this.parse();
    yield* this.emit();
  }
  private check() {
    if (this.closed) throw Error('JSON canonical preparation is closed');
    this.assertRunning?.();
  }
  private handle(id: number): IntakeJsonCanonicalHandle {
    const value = Object.freeze({}) as IntakeJsonCanonicalHandle;
    this.handles.set(value, id);
    return value;
  }
  private id(handle: IntakeJsonCanonicalHandle) {
    this.check();
    const id = this.handles.get(handle);
    if (id === undefined) throw Error('Foreign JSON canonical handle');
    return id;
  }
  private *range(start: number, bytes: number, spool = this.output): Generator<string> {
    this.check();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (const chunk of spool.read(start, bytes)) {
      this.check();
      const text = decoder.decode(chunk, { stream: true });
      if (text) {
        this.work.maxChunkBytes = Math.max(this.work.maxChunkBytes, Buffer.byteLength(text));
        yield text;
      }
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  }
  result(): PreparedIntakeJsonCanonical {
    const engine = this,
      root = this.handle(this.rootId);
    const field = (handle: IntakeJsonCanonicalHandle, name: string) => {
      const node = engine.node(engine.id(handle));
      if (node.kind !== 'object') throw Error('JSON field requires object');
      let current = node.trie;
      for (let at = 0; at < name.length; at++) {
        const child = engine.get(
          'SELECT id FROM trie WHERE parent=? AND unit=?',
          current,
          name.charCodeAt(at),
        );
        if (!child) return undefined;
        current = Number(child.id);
      }
      const value = engine.trie(current).value;
      return value === null ? undefined : engine.handle(value);
    };
    const pieces = (handle: IntakeJsonCanonicalHandle) => {
      const node = engine.node(engine.id(handle));
      if (node.out_start < 0) throw Error('Unselected JSON node');
      return engine.range(node.out_start, node.out_bytes);
    };
    return {
      root,
      bytes: this.output.length,
      work: this.work,
      kind(handle) {
        return engine.node(engine.id(handle)).kind as IntakeJsonCanonicalKind;
      },
      field,
      pieces,
      chunks() {
        return pieces(root);
      },
      *arrayItems(handle) {
        const node = engine.node(engine.id(handle));
        if (node.kind !== 'array') throw Error('JSON array iteration requires array');
        let ordinal = -1;
        while (true) {
          engine.check();
          const row = engine.get(
            'SELECT ordinal,value FROM children WHERE parent=? AND ordinal>? ORDER BY ordinal LIMIT 1',
            node.id,
            ordinal,
          );
          if (!row) return;
          ordinal = Number(row.ordinal);
          yield engine.handle(Number(row.value));
        }
      },
      *objectFields(handle) {
        const node = engine.node(engine.id(handle));
        if (node.kind !== 'object') throw Error('JSON field iteration requires object');
        let ordinal = -1;
        while (true) {
          engine.check();
          const row = engine.get(
            'SELECT value,raw_start,raw_bytes,emit_order FROM trie WHERE object=? AND value IS NOT NULL AND emit_order>? ORDER BY emit_order LIMIT 1',
            node.id,
            ordinal,
          );
          if (!row) return;
          ordinal = Number(row.emit_order);
          const value = engine.handle(Number(row.value));
          yield {
            value,
            name: () => engine.range(Number(row.raw_start), Number(row.raw_bytes), engine.raw),
            matches(name) {
              const selected = field(handle, name);
              return !!selected && engine.id(selected) === Number(row.value);
            },
          };
        }
      },
      splitObjectField(handle, name) {
        const value = field(handle, name);
        if (!value) return undefined;
        const parent = engine.node(engine.id(handle)),
          child = engine.node(engine.id(value));
        return {
          before: () => engine.range(parent.out_start, child.out_start - parent.out_start),
          value,
          after: () =>
            engine.range(
              child.out_start + child.out_bytes,
              parent.out_start + parent.out_bytes - child.out_start - child.out_bytes,
            ),
        };
      },
      close() {
        engine.close();
      },
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.closeInput();
    } finally {
      try {
        closeSync(this.raw.fd);
        closeSync(this.output.fd);
      } finally {
        try {
          this.scratch.close();
        } finally {
          rmSync(this.directory, { recursive: true, force: true });
          this.onWork?.(Object.freeze({ ...this.work }));
        }
      }
    }
  }
}
