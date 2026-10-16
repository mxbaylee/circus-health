/** Private disk-backed JSON normalization. Scratch is never recovery authority. */
import {
  mkdtempSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  rmSync,
  ftruncateSync,
} from 'node:fs';
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
  scratchReadBufferAllocations: number;
  scratchReadBufferReuses: number;
  outputBytes: number;
  maxChunkBytes: number;
  maxBufferBytes: number;
  maxNumberDigits: number;
  yields: number;
  /** Rows written to the scratch member-name index (per object, not per character). */
  keyIndexRows: number;
}
/** Parsed traversal without a container projection. pieces() accepts scalars only. */
export interface PreparedIntakeJsonTree {
  readonly root: IntakeJsonCanonicalHandle;
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
  close(): void;
}
export interface PreparedIntakeJsonCanonical extends PreparedIntakeJsonTree {
  readonly bytes: number;
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
  /** Private scratch reused across a sequence of preparations, one at a time. */
  scratch?: IntakeJsonCanonicalScratch;
}

declare const scratchBrand: unique symbol;
/** A caller-owned private scratch set (spool files plus SQLite index) that
 * consecutive preparations reuse instead of creating and removing their own.
 * Each preparation starts from emptied tables and truncated spools; a closed
 * preparation's handles and pieces still refuse to read. The caller closes it. */
export interface IntakeJsonCanonicalScratch {
  readonly [scratchBrand]: true;
  /** Preparations that started from this set, and those that reused it. */
  readonly uses: number;
  readonly reuses: number;
  close(): void;
}
const SCHEMA = `
  CREATE TABLE nodes(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,parent INTEGER NOT NULL,state TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,key INTEGER NOT NULL DEFAULT 0,trie INTEGER NOT NULL DEFAULT 0,
    raw_start INTEGER NOT NULL DEFAULT 0,raw_bytes INTEGER NOT NULL DEFAULT 0,
    out_start INTEGER NOT NULL DEFAULT -1,
    cursor INTEGER NOT NULL DEFAULT -1,emitted INTEGER NOT NULL DEFAULT 0,phase INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE children(parent INTEGER NOT NULL,ordinal INTEGER NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(parent,ordinal)) WITHOUT ROWID;
  CREATE TABLE trie(id INTEGER PRIMARY KEY,parent INTEGER NOT NULL,chunk BLOB NOT NULL,object INTEGER NOT NULL,
    value INTEGER,first_order INTEGER NOT NULL DEFAULT -1,key_number INTEGER NOT NULL DEFAULT -1,
    raw_start INTEGER NOT NULL DEFAULT 0,raw_bytes INTEGER NOT NULL DEFAULT 0);
  CREATE UNIQUE INDEX trie_edge ON trie(parent,chunk);
  CREATE TABLE outs(id INTEGER PRIMARY KEY,start INTEGER NOT NULL,bytes INTEGER NOT NULL);
  CREATE TABLE members(object INTEGER NOT NULL,ordinal INTEGER NOT NULL,trie INTEGER NOT NULL,PRIMARY KEY(object,ordinal)) WITHOUT ROWID;`;
/** Stringify order reads members by array-index name, then first position;
 * canonical order walks the name trie and needs neither index. A set gains
 * them on its first stringify preparation. */
const STRINGIFY_INDEXES = `
  CREATE INDEX trie_numeric ON trie(object,key_number) WHERE value IS NOT NULL;
  CREATE INDEX trie_insertion ON trie(object,first_order) WHERE value IS NOT NULL;`;
/** Empty every table inside the preparation's own transaction, then seed the root. */
const RESET = `BEGIN; DELETE FROM nodes; DELETE FROM children; DELETE FROM trie; DELETE FROM outs; DELETE FROM members;
  INSERT INTO nodes(id,kind,parent,state) VALUES(0,'root',-1,'value');`;
class ScratchSet {
  readonly directory: string;
  readonly rawFd: number;
  readonly outputFd: number;
  readonly scratch: ReturnType<typeof disposableSqlite>;
  readonly statements = new Map<string, StatementSync>();
  busy = false;
  closed = false;
  uses = 0;
  private indexed = false;
  constructor() {
    const directory = mkdtempSync(join(tmpdir(), 'intake-json-canonical-'));
    let rawFd: number | undefined, outputFd: number | undefined;
    let scratch: ReturnType<typeof disposableSqlite> | undefined;
    try {
      rawFd = openSync(join(directory, 'scalars'), 'wx+', 0o600);
      outputFd = openSync(join(directory, 'output'), 'wx+', 0o600);
      scratch = disposableSqlite('intake-json-canonical-index-');
      scratch.db.exec(SCHEMA);
    } catch (error) {
      if (rawFd !== undefined) closeSync(rawFd);
      if (outputFd !== undefined) closeSync(outputFd);
      scratch?.close();
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    this.directory = directory;
    this.rawFd = rawFd;
    this.outputFd = outputFd;
    this.scratch = scratch;
  }
  /** Start one preparation: empty tables and spools, inside a fresh transaction. */
  acquire(mode: 'canonical' | 'stringify') {
    if (this.closed) throw Error('JSON canonical scratch is closed');
    if (this.busy) throw Error('JSON canonical scratch is in use');
    if (this.scratch.db.isTransaction) this.scratch.db.exec('COMMIT');
    if (mode === 'stringify' && !this.indexed) {
      this.scratch.db.exec(STRINGIFY_INDEXES);
      this.indexed = true;
    }
    ftruncateSync(this.rawFd, 0);
    ftruncateSync(this.outputFd, 0);
    this.scratch.db.exec(RESET);
    this.busy = true;
    this.uses++;
  }
  release() {
    this.busy = false;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.rawFd);
      closeSync(this.outputFd);
    } finally {
      try {
        this.scratch.close();
      } finally {
        rmSync(this.directory, { recursive: true, force: true });
      }
    }
  }
}
const scratchSets = new WeakMap<IntakeJsonCanonicalScratch, ScratchSet>();
export function createIntakeJsonCanonicalScratch(): IntakeJsonCanonicalScratch {
  const set = new ScratchSet();
  const scratch = Object.freeze({
    get uses() {
      return set.uses;
    },
    get reuses() {
      return Math.max(0, set.uses - 1);
    },
    close() {
      if (set.busy) throw Error('JSON canonical scratch is in use');
      set.close();
    },
  }) as unknown as IntakeJsonCanonicalScratch;
  scratchSets.set(scratch, set);
  return scratch;
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
    options.scratch,
  );
  let complete = false;
  try {
    for (const _ of engine.prepare()) {
      void _;
      options.assertRunning?.();
      engine.work.yields++;
      yield;
      options.assertRunning?.();
    }
    options.assertRunning?.();
    const result = engine.result();
    complete = true;
    return result;
  } finally {
    if (!complete) engine.close();
  }
}

/** The same complete parser, retaining stringify traversal and scalar spans
 * without eagerly serializing a root that the legacy delta consumer never reads. */
export function* prepareIntakeJsonTreeSteps(
  pieces: Iterable<string>,
  options: Omit<IntakeJsonCanonicalOptions, 'mode'> = {},
): Generator<void, PreparedIntakeJsonTree> {
  options.assertRunning?.();
  const engine = new CanonicalEngine(
    pieces,
    'stringify',
    options.assertRunning,
    options.onWork,
    options.preserveNumbers ?? false,
    options.scratch,
  );
  let complete = false;
  try {
    for (const _ of engine.prepareTree()) {
      void _;
      options.assertRunning?.();
      engine.work.yields++;
      yield;
      options.assertRunning?.();
    }
    options.assertRunning?.();
    const result = engine.treeResult();
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

type SqlValue = string | number | null | Uint8Array;
/** Parse and emit traversal state of one value. Kind, parent, trie and raw
 * columns never change once parsing ends; the rest is traversal state. */
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
  cursor: number;
  emitted: number;
  phase: number;
}
const NODE_COLUMNS = [
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
] as const;
interface TrieRow {
  id: number;
  parent: number;
  chunk: Uint8Array | number;
  object: number;
  value: number | null;
  first_order: number;
  key_number: number;
  raw_start: number;
  raw_bytes: number;
}
/** Immutable facts of one prepared value, carried by its handle. */
interface PreparedValue {
  id: number;
  kind: IntakeJsonCanonicalKind;
  trie: number;
  start: number;
  bytes: number;
}
/** One child selected by emit, with the immutable columns emit needs. */
interface EmitChild {
  cursor: number;
  value: number;
  kind: IntakeJsonCanonicalKind;
  raw_start: number;
  raw_bytes: number;
  key?: { id: number; raw_start: number; raw_bytes: number };
}
const BUFFER = 8192;
/** Code units of a member name stored in one scratch name-index row. */
export const INTAKE_JSON_CANONICAL_KEY_CHUNK_UNITS = 1024;
const KEY_CHUNK = INTAKE_JSON_CANONICAL_KEY_CHUNK_UNITS;
/** Bounded write-back cache of node rows; evicted rows are written to SQLite. */
const ROW_CACHE = 1024;
/** Rows per multi-row scratch write, and per paged scratch read. */
const BATCH = 64;
/** Bounded per-container read pages retained by emit. */
const PAGE_CACHE = 64;
/** Recent objects whose complete first-chunk member names are held in memory,
 * at most this many names each and only names of at most NAME_MEMO_UNITS. */
const OBJECT_NAME_CACHE = 64;
const OBJECT_NAMES = 64;
const NAME_MEMO_UNITS = 64;
/** Big-endian UTF-16 bytes: SQLite's BLOB order (memcmp, then length) is then
 * exactly JavaScript code-unit order, including surrogates, BOM and NUL. */
function chunkBytes(units: Uint16Array, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length * 2);
  for (let at = 0; at < length; at++) bytes.writeUInt16BE(units[at]!, at * 2);
  return bytes;
}
function nameChunk(name: string, start: number): Buffer {
  const length = Math.min(KEY_CHUNK, name.length - start),
    bytes = Buffer.allocUnsafe(length * 2);
  for (let at = 0; at < length; at++) bytes.writeUInt16BE(name.charCodeAt(start + at), at * 2);
  return bytes;
}
/** Longer names are resolved through the trie each time instead of memoized. */
const FIELD_MEMO_NAME_UNITS = 256;
/** Fixed-width multi-row statements: one compiled statement per batch width. */
function rowsSql(prefix: string, columns: number, rows: number, suffix = ''): string {
  return (
    prefix +
    ' VALUES' +
    Array(rows)
      .fill('(' + Array(columns).fill('?').join(',') + ')')
      .join(',') +
    suffix
  );
}
class Spool {
  length = 0;
  private used = 0;
  private buffer = Buffer.alloc(BUFFER);
  private idleReadBuffer?: Buffer;
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
    // Positional: a reused spool starts truncated at offset 0.
    const base = this.length - this.used;
    let at = 0;
    while (at < this.used) {
      const count = writeSync(this.fd, this.buffer, at, this.used - at, base + at);
      if (!count) throw Error('JSON scratch write did not advance');
      at += count;
      this.work.scratchWrittenBytes += count;
    }
    this.used = 0;
  }
  *read(start: number, bytes: number): Generator<Buffer> {
    this.flush();
    const buffer = this.idleReadBuffer ?? Buffer.alloc(BUFFER);
    if (this.idleReadBuffer) this.work.scratchReadBufferReuses++;
    else this.work.scratchReadBufferAllocations++;
    // Each iterator owns its buffer until closed; overlapping reads cannot alias.
    this.idleReadBuffer = undefined;
    try {
      while (bytes) {
        const count = readSync(this.fd, buffer, 0, Math.min(BUFFER, bytes), start);
        if (!count) throw Error('Truncated JSON scratch');
        this.work.scratchReadBytes += count;
        yield buffer.subarray(0, count);
        start += count;
        bytes -= count;
      }
    } finally {
      this.idleReadBuffer ??= buffer;
    }
  }
}
class CanonicalEngine {
  readonly work: IntakeJsonCanonicalWork = {
    inputCodeUnits: 0,
    sqliteCalls: 0,
    scratchWrittenBytes: 0,
    scratchReadBytes: 0,
    scratchReadBufferAllocations: 0,
    scratchReadBufferReuses: 0,
    outputBytes: 0,
    maxChunkBytes: 0,
    maxBufferBytes: 0,
    maxNumberDigits: 0,
    yields: 0,
    keyIndexRows: 0,
  };
  private set: ScratchSet;
  /** Set when the scratch belongs to the caller and outlives this preparation. */
  private shared?: ScratchSet;
  private scratch: ReturnType<typeof disposableSqlite>;
  private raw: Spool;
  private output: Spool;
  private statements: Map<string, StatementSync>;
  private handles = new WeakMap<IntakeJsonCanonicalHandle, PreparedValue>();
  // Recently used node rows, at most ROW_CACHE of them, plus at most BATCH
  // evicted changed rows awaiting one multi-row write. A retained row is the
  // current version, so every row is either retained or current on disk.
  // Readers get copies, keeping the snapshot semantics of a SQLite row.
  private nodeRows = new Map<number, NodeRow>();
  private dirtyNodes = new Set<number>();
  private spilledNodes = new Map<number, NodeRow>();
  private nextNodeId = 1;
  // Trie rows are assigned ids in SQLite's own rowid order and written in
  // bounded multi-row batches. Unwritten rows are found here by id or edge.
  private nextTrieId = 1;
  private pendingTrie = new Map<number, TrieRow>();
  private pendingEdges = new Map<string, number>();
  // Complete first-chunk member names of recent objects, keyed by their trie
  // root. A missing or null entry is unknown and is resolved through SQLite.
  private objectNames = new Map<number, Map<string, number> | null>();
  // Unwritten insert-only rows, flattened, each bounded by BATCH rows.
  private pendingChildren: SqlValue[] = [];
  private pendingOuts: SqlValue[] = [];
  private pendingMembers: SqlValue[] = [];
  // Emit read pages of recent containers; a dropped page is re-read from the
  // container's durable cursor.
  private pages = new Map<number, { rows: EmitChild[]; at: number; complete: boolean }>();
  // Prepared trees are immutable: object/name resolutions are memoized there.
  private fieldValues = new Map<string, PreparedValue | null>();
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
    shared?: IntakeJsonCanonicalScratch,
  ) {
    this.mode = mode;
    this.preserveNumbers = preserveNumbers;
    this.assertRunning = assertRunning;
    this.onWork = onWork;
    this.iterator = pieces[Symbol.iterator]();
    let set: ScratchSet | undefined;
    try {
      if (shared) {
        set = scratchSets.get(shared);
        if (!set) throw Error('Foreign JSON canonical scratch');
        this.shared = set;
      } else set = new ScratchSet();
      set.acquire(mode);
    } catch (error) {
      if (set && !shared) set.close();
      this.iterator.return?.();
      this.onWork?.(Object.freeze({ ...this.work }));
      throw error;
    }
    this.set = set;
    this.scratch = set.scratch;
    this.statements = set.statements;
    this.raw = new Spool(set.rawFd, this.work);
    this.output = new Spool(set.outputFd, this.work);
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
  private all(sql: string, ...args: SqlValue[]) {
    return this.statement(sql).all(...args);
  }
  private run(sql: string, ...args: SqlValue[]) {
    return this.statement(sql).run(...args);
  }
  /** Write flattened rows in statements of at most BATCH rows. */
  private writeRows(prefix: string, columns: number, values: SqlValue[], suffix = '') {
    const rows = values.length / columns;
    for (let at = 0; at < rows; at += BATCH) {
      const count = Math.min(BATCH, rows - at);
      this.run(
        rowsSql(prefix, columns, count, suffix),
        ...values.slice(at * columns, (at + count) * columns),
      );
    }
    values.length = 0;
  }
  private rememberNode(row: NodeRow) {
    this.nodeRows.delete(row.id);
    this.nodeRows.set(row.id, row);
    if (this.nodeRows.size <= ROW_CACHE) return;
    const evicted = this.nodeRows.values().next().value!;
    this.nodeRows.delete(evicted.id);
    if (!this.dirtyNodes.delete(evicted.id)) return;
    this.spilledNodes.set(evicted.id, evicted);
    if (this.spilledNodes.size >= BATCH) this.writeNodes([...this.spilledNodes.values()]);
  }
  /** One multi-row upsert per BATCH changed rows. Kind and parent never change. */
  private writeNodes(rows: NodeRow[]) {
    for (const row of rows) this.spilledNodes.delete(row.id);
    this.writeRows(
      'INSERT INTO nodes(' + NODE_COLUMNS.join(',') + ')',
      NODE_COLUMNS.length,
      rows.flatMap((row) => NODE_COLUMNS.map((column) => row[column])),
      ' ON CONFLICT(id) DO UPDATE SET ' +
        NODE_COLUMNS.slice(3)
          .map((column) => `${column}=excluded.${column}`)
          .join(','),
    );
  }
  /** After parsing, every node's immutable columns are on disk for joined reads. */
  private writeAllNodes() {
    const rows = [...this.spilledNodes.values()];
    for (const id of this.dirtyNodes) rows.push(this.nodeRows.get(id)!);
    this.dirtyNodes.clear();
    this.writeNodes(rows);
  }
  private node(id: number): NodeRow {
    let row = this.nodeRows.get(id);
    if (row) this.quantum++;
    else if ((row = this.spilledNodes.get(id))) {
      this.spilledNodes.delete(id);
      this.dirtyNodes.add(id);
      this.quantum++;
    } else {
      const value = this.get('SELECT * FROM nodes WHERE id=?', id);
      if (!value) throw Error('Missing JSON node');
      row = { ...(value as unknown as NodeRow) };
    }
    this.rememberNode(row);
    return { ...row };
  }
  private insertNode(kind: IntakeJsonCanonicalKind, parent: number): number {
    // Ids follow SQLite's own rowid order (root is 0); the row reaches disk later.
    const id = this.nextNodeId++;
    this.dirtyNodes.add(id);
    this.rememberNode({
      id,
      kind,
      parent,
      state: 'first',
      n: 0,
      key: 0,
      trie: 0,
      raw_start: 0,
      raw_bytes: 0,
      out_start: -1,
      cursor: -1,
      emitted: 0,
      phase: 0,
    });
    return id;
  }
  /** Apply one node write to its retained row, or to SQLite when not retained. */
  private updateNode(id: number, apply: (row: NodeRow) => void, sql: string, ...args: SqlValue[]) {
    const row = this.nodeRows.get(id) ?? this.spilledNodes.get(id);
    if (!row) {
      this.run(sql, ...args);
      return;
    }
    this.quantum++;
    apply(row);
    if (this.nodeRows.has(id)) this.dirtyNodes.add(id);
  }
  private trie(id: number): TrieRow {
    const pending = this.pendingTrie.get(id);
    if (pending) return pending;
    const value = this.get('SELECT * FROM trie WHERE id=?', id);
    if (!value) throw Error('Missing JSON key');
    return value as unknown as TrieRow;
  }
  private addTrie(row: TrieRow) {
    // Keep the newest row unwritten: it may become the current name's terminal.
    if (this.pendingTrie.size >= BATCH) this.writeTrie();
    this.pendingTrie.set(row.id, row);
    this.quantum++;
  }
  private writeTrie() {
    const rows = [...this.pendingTrie.values()];
    if (!rows.length) return;
    this.work.keyIndexRows += rows.length;
    this.pendingTrie.clear();
    this.pendingEdges.clear();
    this.writeRows(
      'INSERT INTO trie(id,parent,chunk,object,value,first_order,key_number,raw_start,raw_bytes)',
      9,
      rows.flatMap((row) => [
        row.id,
        row.parent,
        row.chunk,
        row.object,
        row.value,
        row.first_order,
        row.key_number,
        row.raw_start,
        row.raw_bytes,
      ]),
    );
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
  /** Each edge holds up to KEY_CHUNK code units of one name. Only a name's
   * final edge can be shorter, so an edge with children always holds a full
   * chunk and sibling BLOB order equals code-unit order of the names below them.
   * A node inserted during this name has no children yet, so the next edge
   * from it cannot exist and is created without a lookup. */
  private keyEdge(parent: number, chunk: Buffer, object: number, fresh: boolean, first: boolean) {
    const text = chunk.toString('latin1'),
      edge = parent + ':' + text;
    let names = first ? this.objectNames.get(parent) : undefined;
    if (names) {
      this.objectNames.delete(parent);
      this.objectNames.set(parent, names);
    }
    if (!fresh) {
      const pending = this.pendingEdges.get(edge);
      if (pending !== undefined) {
        this.quantum++;
        return { id: pending, fresh: false };
      }
      const known = names?.get(text);
      if (known !== undefined) {
        this.quantum++;
        return { id: known, fresh: false };
      }
      if (!names) {
        const row = this.get('SELECT id FROM trie WHERE parent=? AND chunk=?', parent, chunk);
        if (row) return { id: Number(row.id), fresh: false };
      }
    }
    const id = this.nextTrieId++;
    this.addTrie({
      id,
      parent,
      chunk,
      object,
      value: null,
      first_order: -1,
      key_number: -1,
      raw_start: 0,
      raw_bytes: 0,
    });
    this.pendingEdges.set(edge, id);
    if (names) {
      if (names.size < OBJECT_NAMES && chunk.length <= NAME_MEMO_UNITS * 2) names.set(text, id);
      else this.objectNames.set(parent, (names = null));
    }
    return { id, fresh: true };
  }
  /** Decode only one code unit at a time. The trie stores full names on disk,
   * at most one bounded chunk of a name in memory. */
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
      fresh = false,
      keyNumber = 0,
      keyDigits = 0,
      numeric = true;
    const pending: string[] = [];
    let pendingUnits = 0,
      chunkUnits = 0;
    const chunk = key ? new Uint16Array(KEY_CHUNK) : undefined;
    const keyChunk = () => {
      const first = terminal === key!.root;
      const edge = this.keyEdge(
        terminal,
        chunkBytes(chunk!, chunkUnits),
        key!.object,
        fresh,
        first,
      );
      terminal = edge.id;
      fresh = edge.fresh;
      chunkUnits = 0;
    };
    const flush = () => {
      if (!pending.length) return;
      this.raw.append(pending.join(''));
      pending.length = 0;
      pendingUnits = 0;
    };
    const append = (text: string) => {
      pending.push(text);
      pendingUnits += text.length;
      if (pendingUnits >= 4096) flush();
    };
    const emit = (char: string) => {
      if (high) {
        const code = char.charCodeAt(0);
        if (code >= 0xdc00 && code <= 0xdfff) {
          append(high + char);
          high = '';
          return;
        }
        append(JSON.stringify(high).slice(1, -1));
        high = '';
      }
      const code = char.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdbff) high = char;
      else if (code >= 0x20 && code !== 0x22 && code !== 0x5c && (code < 0xd800 || code > 0xdfff))
        append(char);
      else append(JSON.stringify(char).slice(1, -1));
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
        chunk![chunkUnits++] = char.charCodeAt(0);
        if (chunkUnits === KEY_CHUNK) keyChunk();
        if (!/^\d$/.test(char) || keyDigits >= 10 || (keyDigits === 1 && keyNumber === 0))
          numeric = false;
        if (numeric) keyNumber = keyNumber * 10 + Number(char);
        keyDigits++;
      }
      emit(char);
      if (this.due()) {
        flush();
        yield;
      }
    }
    if (high) append(JSON.stringify(high).slice(1, -1));
    flush();
    if (key && chunkUnits) keyChunk();
    this.raw.append('"');
    const bytes = this.raw.length - start;
    if (key) {
      const keyNumberValue = numeric && keyDigits > 0 && keyNumber < 4294967295 ? keyNumber : -1;
      const row = this.pendingTrie.get(terminal);
      if (row) {
        // Unwritten (normally this name's new terminal): set its member columns.
        if (row.first_order < 0) {
          row.first_order = key.order;
          row.key_number = keyNumberValue;
          row.raw_start = start;
          row.raw_bytes = bytes;
        }
      } else if (this.trie(terminal).first_order < 0)
        // An existing prefix node that becomes a name for the first time.
        this.run(
          'UPDATE trie SET first_order=?,key_number=?,raw_start=?,raw_bytes=? WHERE id=?',
          key.order,
          keyNumberValue,
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
    const id = this.insertNode(kind, parent.id);
    if (parent.kind === 'root') this.rootId = id;
    else if (parent.kind === 'array') {
      this.pendingChildren.push(parent.id, parent.n, id);
      if (this.pendingChildren.length >= BATCH * 3)
        this.writeRows('INSERT INTO children(parent,ordinal,value)', 3, this.pendingChildren);
    } else {
      // The last value of a repeated name replaces the earlier one.
      const row = this.pendingTrie.get(parent.key);
      if (row) row.value = id;
      else this.run('UPDATE trie SET value=? WHERE id=?', id, parent.key);
    }
    this.updateNode(
      parent.id,
      (row) => {
        row.state = 'after';
        row.n++;
      },
      'UPDATE nodes SET state=?,n=n+1 WHERE id=?',
      'after',
      parent.id,
    );
    if (kind === 'object' || kind === 'array') {
      this.take();
      if (kind === 'object') {
        const trie = this.nextTrieId++;
        this.addTrie({
          id: trie,
          parent: -id,
          chunk: -1,
          object: id,
          value: null,
          first_order: -1,
          key_number: -1,
          raw_start: 0,
          raw_bytes: 0,
        });
        this.objectNames.set(trie, new Map());
        if (this.objectNames.size > OBJECT_NAME_CACHE)
          this.objectNames.delete(this.objectNames.keys().next().value!);
        this.updateNode(
          id,
          (row) => {
            row.trie = trie;
          },
          'UPDATE nodes SET trie=? WHERE id=?',
          trie,
          id,
        );
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
    const rawBytes = this.raw.length - start;
    this.updateNode(
      id,
      (row) => {
        row.raw_start = start;
        row.raw_bytes = rawBytes;
      },
      'UPDATE nodes SET raw_start=?,raw_bytes=? WHERE id=?',
      start,
      rawBytes,
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
        this.updateNode(
          current,
          (row) => {
            row.state = 'next';
          },
          'UPDATE nodes SET state=? WHERE id=?',
          'next',
          current,
        );
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
        this.updateNode(
          node.id,
          (row) => {
            row.key = key.terminal;
          },
          'UPDATE nodes SET key=? WHERE id=?',
          key.terminal,
          node.id,
        );
      }
      current = yield* this.value(node);
    }
    this.closeInput();
    this.ended = true;
    this.block = '';
    this.at = 0;
    this.raw.flush();
    // Every index row and node is now on disk; emit and readers join them.
    this.writeTrie();
    this.objectNames.clear();
    this.writeRows('INSERT INTO children(parent,ordinal,value)', 3, this.pendingChildren);
    this.writeAllNodes();
  }
  private *nextKey(root: number, last: number): Generator<void, TrieRow | undefined> {
    let current = last < 0 ? root : last,
      consider = last < 0;
    while (true) {
      if (this.due()) yield;
      const row = this.trie(current);
      if (consider && row.value !== null) return row;
      const child = this.get('SELECT id FROM trie WHERE parent=? ORDER BY chunk LIMIT 1', current);
      if (child) {
        current = Number(child.id);
        consider = true;
        continue;
      }
      while (current !== root) {
        const at = this.trie(current),
          sibling = this.get(
            'SELECT id FROM trie WHERE parent=? AND chunk>? ORDER BY chunk LIMIT 1',
            at.parent,
            at.chunk,
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
  /** The next child of a container from its bounded page, advancing its cursor. */
  private nextPaged(node: NodeRow, read: (cursor: number) => EmitChild[]): EmitChild | undefined {
    let page = this.pages.get(node.id);
    if (page) {
      this.pages.delete(node.id);
      this.pages.set(node.id, page);
    }
    if (!page || (page.at === page.rows.length && !page.complete)) {
      const rows = read(node.cursor);
      page = { rows, at: 0, complete: rows.length < BATCH };
      this.pages.delete(node.id);
      this.pages.set(node.id, page);
      if (this.pages.size > PAGE_CACHE) this.pages.delete(this.pages.keys().next().value!);
    }
    const child = page.rows[page.at];
    if (!child) return undefined;
    page.at++;
    this.quantum++;
    this.setCursor(node.id, child.cursor);
    node.cursor = child.cursor;
    return child;
  }
  private emitRows(sql: string, ...args: SqlValue[]): EmitChild[] {
    return this.all(sql, ...args).map((row) => ({
      cursor: Number(row.cursor),
      value: Number(row.value),
      kind: row.kind as IntakeJsonCanonicalKind,
      raw_start: Number(row.raw_start),
      raw_bytes: Number(row.raw_bytes),
      key:
        row.key_id === undefined
          ? undefined
          : {
              id: Number(row.key_id),
              raw_start: Number(row.key_start),
              raw_bytes: Number(row.key_bytes),
            },
    }));
  }
  private *nextChild(node: NodeRow): Generator<void, EmitChild | undefined> {
    if (node.kind === 'array')
      return this.nextPaged(node, (cursor) =>
        this.emitRows(
          `SELECT c.ordinal AS cursor,c.value,n.kind,n.raw_start,n.raw_bytes FROM children c
           JOIN nodes n ON n.id=c.value WHERE c.parent=? AND c.ordinal>? ORDER BY c.ordinal LIMIT ${BATCH}`,
          node.id,
          cursor,
        ),
      );
    if (this.mode === 'canonical') {
      const key = yield* this.nextKey(node.trie, node.cursor);
      if (!key) return undefined;
      this.setCursor(node.id, key.id);
      const value = this.node(key.value!);
      return {
        cursor: key.id,
        value: value.id,
        kind: value.kind as IntakeJsonCanonicalKind,
        raw_start: value.raw_start,
        raw_bytes: value.raw_bytes,
        key: { id: key.id, raw_start: key.raw_start, raw_bytes: key.raw_bytes },
      };
    }
    const members = (where: string, order: string) => (cursor: number) =>
      this.emitRows(
        `SELECT t.${order} AS cursor,t.id AS key_id,t.raw_start AS key_start,t.raw_bytes AS key_bytes,
           t.value,n.kind,n.raw_start,n.raw_bytes FROM trie t JOIN nodes n ON n.id=t.value
         WHERE t.object=? AND t.value IS NOT NULL AND ${where} AND t.${order}>? ORDER BY t.${order} LIMIT ${BATCH}`,
        node.id,
        cursor,
      );
    if (node.phase === 0) {
      const child = this.nextPaged(node, members('t.key_number>=0', 'key_number'));
      if (child) return child;
      // Array-index names are exhausted; other names follow in first position.
      this.pages.delete(node.id);
      node.phase = 1;
      node.cursor = -1;
      this.updateNode(
        node.id,
        (row) => {
          row.phase = 1;
          row.cursor = -1;
        },
        'UPDATE nodes SET phase=1,cursor=-1 WHERE id=?',
        node.id,
      );
    }
    return this.nextPaged(node, members('t.key_number=-1', 'first_order'));
  }
  private recordOut(id: number, start: number, bytes: number) {
    this.pendingOuts.push(id, start, bytes);
    if (this.pendingOuts.length >= BATCH * 3)
      this.writeRows('INSERT INTO outs(id,start,bytes)', 3, this.pendingOuts);
  }
  private *emitScalar(id: number, start: number, bytes: number): Generator<void> {
    const outStart = this.output.length;
    for (const piece of this.raw.read(start, bytes)) {
      this.output.appendBytes(piece);
      this.quantum += piece.length;
      if (this.due()) yield;
    }
    this.recordOut(id, outStart, this.output.length - outStart);
  }
  private *emit(): Generator<void> {
    let current = this.rootId;
    const top = this.node(current);
    if (top.kind !== 'object' && top.kind !== 'array') {
      yield* this.emitScalar(top.id, top.raw_start, top.raw_bytes);
      current = 0;
    }
    while (current !== 0) {
      if (this.due()) yield;
      const node = this.node(current);
      if (node.out_start < 0) {
        const outStart = this.output.length;
        this.updateNode(
          current,
          (row) => {
            row.out_start = outStart;
          },
          'UPDATE nodes SET out_start=? WHERE id=?',
          outStart,
          current,
        );
        node.out_start = outStart;
        this.output.append(node.kind === 'array' ? '[' : '{');
      }
      const child = yield* this.nextChild(node);
      if (!child) {
        this.output.append(node.kind === 'array' ? ']' : '}');
        this.recordOut(current, node.out_start, this.output.length - node.out_start);
        this.pages.delete(current);
        current = node.parent;
        continue;
      }
      if (node.emitted) this.output.append(',');
      this.updateNode(
        current,
        (row) => {
          row.emitted++;
        },
        'UPDATE nodes SET emitted=emitted+1 WHERE id=?',
        current,
      );
      if (child.key) {
        this.pendingMembers.push(current, node.emitted, child.key.id);
        if (this.pendingMembers.length >= BATCH * 3)
          this.writeRows('INSERT INTO members(object,ordinal,trie)', 3, this.pendingMembers);
        for (const piece of this.raw.read(child.key.raw_start, child.key.raw_bytes)) {
          this.output.appendBytes(piece);
          this.quantum += piece.length;
          if (this.due()) yield;
        }
        this.output.append(':');
      }
      if (child.kind === 'object' || child.kind === 'array') current = child.value;
      else yield* this.emitScalar(child.value, child.raw_start, child.raw_bytes);
    }
    this.writeRows('INSERT INTO outs(id,start,bytes)', 3, this.pendingOuts);
    this.writeRows('INSERT INTO members(object,ordinal,trie)', 3, this.pendingMembers);
    this.pages.clear();
    this.output.flush();
    this.work.outputBytes = this.output.length;
    this.scratch.db.exec('COMMIT');
  }
  private setCursor(id: number, cursor: number) {
    this.updateNode(
      id,
      (row) => {
        row.cursor = cursor;
      },
      'UPDATE nodes SET cursor=? WHERE id=?',
      cursor,
      id,
    );
  }
  private preparedRow(row: Record<string, unknown>): PreparedValue {
    return {
      id: Number(row.id),
      kind: row.kind as IntakeJsonCanonicalKind,
      trie: Number(row.trie),
      start: Number(row.start),
      bytes: Number(row.bytes),
    };
  }
  private prepared(id: number, treeOnly = false): PreparedValue {
    const row = this.get(
      treeOnly
        ? 'SELECT n.id,n.kind,n.trie,n.raw_start AS start,n.raw_bytes AS bytes FROM nodes n WHERE n.id=?'
        : 'SELECT n.id,n.kind,n.trie,o.start,o.bytes FROM nodes n JOIN outs o ON o.id=n.id WHERE n.id=?',
      id,
    );
    if (!row) throw Error('Unselected JSON node');
    return this.preparedRow(row);
  }
  /** Resolve one member of a prepared object. Results are memoized for short
   * names because the prepared tree no longer changes. */
  private fieldValue(
    object: PreparedValue,
    name: string,
    treeOnly = false,
  ): PreparedValue | undefined {
    const memo = name.length <= FIELD_MEMO_NAME_UNITS ? object.id + ':' + name : undefined;
    if (memo !== undefined) {
      const known = this.fieldValues.get(memo);
      if (known !== undefined) {
        this.quantum++;
        return known ?? undefined;
      }
    }
    const value = treeOnly
      ? 'SELECT n.id,n.kind,n.trie,n.raw_start AS start,n.raw_bytes AS bytes FROM trie t JOIN nodes n ON n.id=t.value WHERE '
      : `SELECT n.id,n.kind,n.trie,o.start,o.bytes FROM trie t JOIN nodes n ON n.id=t.value
      JOIN outs o ON o.id=t.value WHERE `;
    let current = object.trie,
      row: Record<string, unknown> | undefined;
    if (!name.length) row = this.get(value + 't.id=?', current);
    for (let at = 0; at < name.length; at += KEY_CHUNK) {
      const chunk = nameChunk(name, at);
      if (at + KEY_CHUNK >= name.length) {
        row = this.get(value + 't.parent=? AND t.chunk=?', current, chunk);
        break;
      }
      const child = this.get('SELECT id FROM trie WHERE parent=? AND chunk=?', current, chunk);
      if (!child) break;
      current = Number(child.id);
    }
    const result = row ? this.preparedRow(row) : null;
    if (memo !== undefined) {
      this.fieldValues.set(memo, result);
      if (this.fieldValues.size > ROW_CACHE)
        this.fieldValues.delete(this.fieldValues.keys().next().value!);
    }
    return result ?? undefined;
  }
  *prepare(): Generator<void> {
    yield* this.parse();
    yield* this.emit();
  }
  *prepareTree(): Generator<void> {
    yield* this.parse();
    this.scratch.db.exec('COMMIT');
  }
  private check() {
    if (this.closed) throw Error('JSON canonical preparation is closed');
    this.assertRunning?.();
  }
  private handle(value: PreparedValue): IntakeJsonCanonicalHandle {
    const handle = Object.freeze({}) as IntakeJsonCanonicalHandle;
    this.handles.set(handle, value);
    return handle;
  }
  private handleValue(handle: IntakeJsonCanonicalHandle): PreparedValue {
    this.check();
    const value = this.handles.get(handle);
    if (value === undefined) throw Error('Foreign JSON canonical handle');
    return value;
  }
  /** Bounded pages of an immutable prepared query, checked before each item. */
  private *paged(sql: string, id: number): Generator<Record<string, unknown>> {
    let cursor = -1;
    while (true) {
      this.check();
      const rows = this.all(sql, id, cursor);
      for (const row of rows) {
        this.check();
        cursor = Number(row.cursor);
        yield row;
      }
      if (rows.length < BATCH) return;
    }
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
  private traversal(treeOnly: boolean): PreparedIntakeJsonTree {
    const engine = this,
      root = this.handle(this.prepared(this.rootId, treeOnly));
    const field = (handle: IntakeJsonCanonicalHandle, name: string) => {
      const object = engine.handleValue(handle);
      if (object.kind !== 'object') throw Error('JSON field requires object');
      const value = engine.fieldValue(object, name, treeOnly);
      return value === undefined ? undefined : engine.handle(value);
    };
    const pieces = (handle: IntakeJsonCanonicalHandle) => {
      const value = engine.handleValue(handle);
      if (treeOnly && (value.kind === 'object' || value.kind === 'array'))
        throw Error('JSON tree pieces require scalar');
      return engine.range(value.start, value.bytes, treeOnly ? engine.raw : engine.output);
    };
    const joined = treeOnly
      ? 'n.id,n.kind,n.trie,n.raw_start AS start,n.raw_bytes AS bytes FROM nodes n'
      : 'n.id,n.kind,n.trie,o.start,o.bytes FROM nodes n JOIN outs o ON o.id=n.id';
    const objectRows = function* (object: PreparedValue) {
      const columns = `t.raw_start AS name_start,t.raw_bytes AS name_bytes,
        t.id AS name_id,t.parent AS name_parent,
        CASE WHEN t.parent>0 AND length(t.chunk)<=${FIELD_MEMO_NAME_UNITS * 2}
          THEN t.chunk END AS name_chunk,${joined} JOIN trie t ON t.value=n.id`;
      if (treeOnly) {
        // Last duplicate value wins; numeric names precede first-insertion order.
        for (const [order, where] of [
          ['key_number', 't.key_number>=0'],
          ['first_order', 't.key_number=-1'],
        ])
          yield* engine.paged(
            `SELECT t.${order} AS cursor,${columns} WHERE t.object=? AND t.value IS NOT NULL
             AND ${where} AND t.${order}>? ORDER BY t.${order} LIMIT ${BATCH}`,
            object.id,
          );
      } else
        yield* engine.paged(
          `SELECT m.ordinal AS cursor,${columns} JOIN members m ON m.trie=t.id
           WHERE m.object=? AND m.ordinal>? ORDER BY m.ordinal LIMIT ${BATCH}`,
          object.id,
        );
    };
    return {
      root,
      work: this.work,
      kind(handle) {
        return engine.handleValue(handle).kind;
      },
      field,
      pieces,
      *arrayItems(handle) {
        const array = engine.handleValue(handle);
        if (array.kind !== 'array') throw Error('JSON array iteration requires array');
        for (const row of engine.paged(
          `SELECT c.ordinal AS cursor,${joined} JOIN children c ON c.value=n.id
           WHERE c.parent=? AND c.ordinal>? ORDER BY c.ordinal LIMIT ${BATCH}`,
          array.id,
        ))
          yield engine.handle(engine.preparedRow(row));
      },
      *objectFields(handle) {
        const object = engine.handleValue(handle);
        if (object.kind !== 'object') throw Error('JSON field iteration requires object');
        for (const row of objectRows(object)) {
          const valueId = Number(row.id),
            prepared = engine.preparedRow(row),
            value = engine.handle(prepared),
            nameStart = Number(row.name_start),
            nameBytes = Number(row.name_bytes),
            nameId = Number(row.name_id),
            nameParent = Number(row.name_parent),
            nameChunk = row.name_chunk instanceof Uint8Array ? row.name_chunk : undefined;
          yield {
            value,
            name: () => engine.range(nameStart, nameBytes, engine.raw),
            matches(name) {
              engine.check();
              // Short single-edge names are already in this bounded member page.
              // Only a match proves a field value; a different member is not absence.
              if (
                name.length <= FIELD_MEMO_NAME_UNITS &&
                (nameId === object.trie || (nameParent === object.trie && nameChunk !== undefined))
              ) {
                let matches =
                  nameId === object.trie
                    ? name.length === 0
                    : nameChunk!.length === name.length * 2;
                if (matches && nameId !== object.trie)
                  for (let at = 0; at < name.length; at++)
                    if (
                      name.charCodeAt(at) !==
                      ((nameChunk![at * 2]! << 8) | nameChunk![at * 2 + 1]!)
                    ) {
                      matches = false;
                      break;
                    }
                engine.quantum++;
                if (matches) {
                  engine.fieldValues.set(object.id + ':' + name, prepared);
                  if (engine.fieldValues.size > ROW_CACHE)
                    engine.fieldValues.delete(engine.fieldValues.keys().next().value!);
                }
                return matches;
              }
              // Longer names retain the full trie lookup and node-id comparison.
              return engine.fieldValue(object, name, treeOnly)?.id === valueId;
            },
          };
        }
      },
      close() {
        engine.close();
      },
    };
  }
  treeResult(): PreparedIntakeJsonTree {
    return this.traversal(true);
  }
  result(): PreparedIntakeJsonCanonical {
    const tree = this.traversal(false),
      engine = this;
    return {
      ...tree,
      bytes: this.output.length,
      chunks: () => tree.pieces(tree.root),
      splitObjectField(handle, name) {
        const value = tree.field(handle, name);
        if (!value) return undefined;
        const parent = engine.handleValue(handle),
          child = engine.handleValue(value);
        return {
          before: () => engine.range(parent.start, child.start - parent.start),
          value,
          after: () =>
            engine.range(
              child.start + child.bytes,
              parent.start + parent.bytes - child.start - child.bytes,
            ),
        };
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
        if (this.shared) this.set.release();
        else this.set.close();
      } finally {
        this.onWork?.(Object.freeze({ ...this.work }));
      }
    }
  }
}
