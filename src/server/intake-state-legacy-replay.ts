/** Private disk replay for legacy contributions. Scratch cannot select or recover
 * accepted authority; every source frame and every version is authenticated. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, openSync, closeSync, readSync, writeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disposableSqlite } from './disposable-sqlite.ts';
import { ChatDecodeLimitError, type ChatDecodeBudget } from './chat-journal-codec.ts';
import {
  prepareIntakeJsonCanonicalSteps,
  type PreparedIntakeJsonCanonical,
  type IntakeJsonCanonicalHandle,
} from './intake-json-canonical.ts';
import { hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';
import {
  FORMAT,
  CHUNK_BYTES,
  FRAME_BYTES,
  HEAD_BYTES,
  exact,
  integer,
  invalid,
  uuid,
  decode,
  digest,
  usage,
  budget,
  addDecoded,
  intakeNamespace,
  checkIntakeResult,
  validateIntakeIdentity,
  parseIntakeHead,
  type Frame,
  type Head,
  type Reference,
  type Limits,
  type IntakeStateIdentity,
  type IntakeStateResult,
} from './intake-state-evidence.ts';
import { intakeCopyJsonString } from './intake-copy-json.ts';
import {
  prepareIntakeEnvelopeProjectionSteps,
  INTAKE_ENVELOPE_FORMAT,
  type IntakeEnvelopeProjectionFormat,
} from './intake-authority.ts';
import { compactIntakeScalarSteps, COMPACT_SCALAR_BYTES } from './intake-compact-scalar.ts';
import { schemaKey } from './intake-envelope-schema.ts';
import { finishIntakeCopySteps } from './intake-copy-work.ts';

const MAX_DEPTH = 64,
  MAX_ITEMS = 1_000_000,
  BAD = new Set(['__proto__', 'prototype', 'constructor']);
const hashSyntax = (value: unknown) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid('hash');
};
function natural(value: number): number {
  integer(value);
  return value;
}

export interface PreparedIntakeLegacyReplay {
  readonly head: Head;
  readonly fingerprint: string;
  readonly semanticBytes: number;
  readonly work: Readonly<IntakeLegacyReplayWork>;
  pieces(): Iterable<string>;
  envelopePieces(): Iterable<string>;
  consumed(): Iterable<string>;
  domainVersion(): number;
  domainVersionSteps(): Generator<void, number>;
  validateEnvelope(detailsJson: string): { domainVersion: number };
  validateEnvelopeSteps(detailsJson: string): Generator<void, { domainVersion: number }>;
  rebind(target: IntakeStateIdentity, write: (key: string, value: string) => void): Head;
  rebindSteps(
    target: IntakeStateIdentity,
    write: (key: string, value: string) => void,
  ): Generator<void, Head>;
  close(): void;
}

/** Source selection is supplied by the caller's independently verified owner.
 * No returned value can authorize a write to that owner's accepted storage. */
export function prepareIntakeLegacyReplay(
  ...args: Parameters<typeof prepareIntakeLegacyReplaySteps>
): PreparedIntakeLegacyReplay {
  return finishIntakeCopySteps(prepareIntakeLegacyReplaySteps(...args));
}

export function* prepareIntakeLegacyReplaySteps(
  scope: IntakeStateIdentity,
  caps: Limits,
  selected: Head,
  get: (key: string) => unknown,
  options: {
    checkpoint?: () => void;
    onVersion?: (version: number, fingerprint: string, pieces: () => Iterable<string>) => void;
  } = {},
): Generator<void, PreparedIntakeLegacyReplay> {
  const identity = validateIntakeIdentity(scope),
    head = parseIntakeHead(JSON.stringify(selected), identity, caps)!,
    prefix = intakeNamespace(identity),
    checkpoint = options.checkpoint ?? (() => {}),
    work: IntakeLegacyReplayWork = {
      frames: 0,
      versions: 0,
      inputBytes: 0,
      serializedBytes: 0,
      scalarScratchBytes: 0,
      peakScalarBufferBytes: 0,
      peakFrameBytes: 0,
    },
    state = new DiskIntakeValue(checkpoint, work),
    db = state.db;
  let closed = false,
    complete = false,
    rebindInFlight = false;
  const close = () => {
    if (closed) return;
    closed = true;
    state.close();
  };
  const current = () => {
    if (closed) invalid('closed legacy replay');
    checkpoint();
  };
  try {
    Object.freeze(head.usage);
    Object.freeze(head.tip);
    Object.freeze(head);
    db.exec(
      'CREATE TABLE frames(sequence INTEGER PRIMARY KEY,id TEXT UNIQUE,raw TEXT NOT NULL,sha TEXT NOT NULL); CREATE TABLE consumed(key TEXT PRIMARY KEY); CREATE TABLE receipts(id TEXT PRIMARY KEY,raw TEXT NOT NULL); CREATE TABLE copied_operations(id TEXT PRIMARY KEY,target TEXT UNIQUE NOT NULL);',
    );
    const mark = (key: string) => db.prepare('INSERT OR IGNORE INTO consumed VALUES(?)').run(key);
    mark(prefix + 'head');
    let ref: Reference | null = head.tip;
    let physicalBytes = 0;
    while (ref) {
      current();
      yield;
      if (work.frames >= caps.frames || db.prepare('SELECT 1 FROM frames WHERE id=?').get(ref.id))
        invalid('duplicate/frames limit');
      const key = prefix + 'frame:' + ref.id,
        raw = get(key);
      if (typeof raw !== 'string') invalid('missing contribution');
      const text = raw as string,
        bytes = Buffer.byteLength(text);
      work.peakFrameBytes = Math.max(work.peakFrameBytes, bytes);
      physicalBytes += bytes;
      if (bytes > FRAME_BYTES || physicalBytes > caps.bytes || digest(text) !== ref.sha256)
        invalid('bytes/hash');
      const frame = decode(text, FRAME_BYTES);
      exact(frame, [
        'format',
        'profileId',
        'intakeId',
        'sourceHash',
        'id',
        'sequence',
        'previous',
        'version',
        'operationId',
        'fingerprint',
        'chunk',
        'chunks',
        'payloadHash',
        'data',
      ]);
      if (
        frame.format !== FORMAT ||
        frame.profileId !== identity.profileId ||
        frame.intakeId !== identity.intakeId ||
        frame.sourceHash !== identity.sourceHash
      )
        invalid('scope');
      uuid(frame.id);
      uuid(frame.operationId);
      hashSyntax(frame.fingerprint);
      hashSyntax(frame.payloadHash);
      integer(frame.sequence, 1);
      integer(frame.version, 1);
      integer(frame.chunk);
      integer(frame.chunks, 1);
      if (
        frame.id !== ref.id ||
        frame.sequence !== ref.sequence ||
        Number(frame.chunk) >= Number(frame.chunks)
      )
        invalid('frame coordinates');
      if (frame.previous !== null) {
        exact(frame.previous, ['id', 'sequence', 'sha256']);
        uuid(frame.previous.id);
        integer(frame.previous.sequence, 1);
        hashSyntax(frame.previous.sha256);
      }
      if (
        (frame.previous === null
          ? 0
          : Number((frame.previous as unknown as Reference).sequence)) !==
        Number(frame.sequence) - 1
      )
        invalid('predecessor');
      if (typeof frame.data !== 'string' || frame.data.length > (CHUNK_BYTES * 4) / 3 + 4)
        invalid('chunk bytes');
      const bytesValue = Buffer.from(frame.data as string, 'base64');
      if (bytesValue.length > CHUNK_BYTES || bytesValue.toString('base64') !== frame.data)
        invalid('base64');
      db.prepare('INSERT INTO frames VALUES(?,?,?,?)').run(
        frame.sequence as number,
        frame.id as string,
        text,
        ref.sha256,
      );
      mark(key);
      work.frames++;
      ref = frame.previous as unknown as Reference | null;
    }
    let used = {
        bytes: physicalBytes,
        frames: work.frames,
        nodes: 0,
        operations: 0,
        stringWork: 0,
      },
      version = 0,
      offset = 0,
      fingerprint = '',
      semanticBytes = 0;
    while (offset < work.frames) {
      current();
      const first = decode(
        db.prepare('SELECT raw FROM frames WHERE sequence=?').get(offset + 1)!.raw,
        FRAME_BYTES,
      ) as Frame;
      if (first.version !== ++version || first.chunk !== 0 || first.chunks > work.frames - offset)
        invalid('logical sequence');
      const hash = createHash('sha256');
      let payloadBytes = 0;
      const pieces = function* () {
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        for (let chunk = 0; chunk < first.chunks; chunk++) {
          current();
          const row = db
            .prepare('SELECT raw,sha FROM frames WHERE sequence=?')
            .get(offset + chunk + 1)!;
          if (digest(String(row.raw)) !== row.sha) invalid('legacy frame scratch changed');
          const frame = decode(row.raw, FRAME_BYTES) as Frame;
          if (
            frame.version !== version ||
            frame.chunk !== chunk ||
            frame.chunks !== first.chunks ||
            frame.operationId !== first.operationId ||
            frame.fingerprint !== first.fingerprint ||
            frame.payloadHash !== first.payloadHash
          )
            invalid('chunk group');
          const bytes = Buffer.from(frame.data, 'base64');
          hash.update(bytes);
          payloadBytes += bytes.length;
          if (payloadBytes > caps.bytes) invalid('operation bytes');
          const text = decoder.decode(bytes, { stream: true });
          if (text) yield text;
        }
        const tail = decoder.decode();
        if (tail) yield tail;
      };
      const changes = yield* prepareIntakeJsonCanonicalSteps(pieces(), {
        mode: 'stringify',
        preserveNumbers: true,
      });
      let changed = 0;
      const remaining = budget(caps, used);
      try {
        if (hash.digest('hex') !== first.payloadHash) invalid('payload hash/UTF-8');
        if (changes.kind(changes.root) !== 'array') invalid('legacy change array');
        for (const change of changes.arrayItems(changes.root)) {
          if (++changed > MAX_ITEMS) invalid('legacy change count');
          yield* state.applySteps(changes, change, remaining);
        }
        if (state.root === undefined) invalid('missing legacy state');
      } finally {
        changes.close();
      }
      used = addDecoded(used, caps, remaining);
      const resultHash = createHash('sha256');
      semanticBytes = 0;
      for (const piece of state.pieces()) {
        resultHash.update(piece);
        semanticBytes += Buffer.byteLength(piece);
        yield;
      }
      fingerprint = resultHash.digest('hex');
      if (fingerprint !== first.fingerprint) invalid('result fingerprint');
      const receiptKey = prefix + 'operation:' + first.operationId,
        receiptRaw = get(receiptKey),
        receipt = decode(receiptRaw, HEAD_BYTES);
      exact(receipt, ['fingerprint', 'result']);
      hashSyntax(receipt.fingerprint);
      if (receipt.fingerprint !== fingerprint) invalid('operation receipt');
      checkIntakeResult(identity, receipt.result, first.operationId, version);
      if (receipt.result.changed !== changed > 0) invalid('receipt changed');
      used.bytes += Buffer.byteLength(receiptRaw as string);
      usage(used, caps);
      mark(receiptKey);
      db.prepare('INSERT INTO receipts VALUES(?,?)').run(first.operationId, receiptRaw as string);
      work.versions++;
      work.inputBytes += payloadBytes;
      work.serializedBytes += semanticBytes;
      options.onVersion?.(version, fingerprint, () => state.pieces());
      offset += first.chunks;
    }
    if (version !== head.version || JSON.stringify(used) !== JSON.stringify(head.usage))
      invalid('usage agreement');
    usage(used, caps);
    const result: PreparedIntakeLegacyReplay = Object.freeze({
      head,
      fingerprint,
      semanticBytes,
      work: Object.freeze({ ...work }),
      pieces() {
        current();
        return state.pieces();
      },
      envelopePieces() {
        current();
        return state.envelopePieces();
      },
      *consumed() {
        current();
        for (const row of db.prepare('SELECT key FROM consumed ORDER BY key').iterate()) {
          current();
          yield String(row.key);
        }
      },
      domainVersion() {
        current();
        return finishIntakeCopySteps(state.domainVersionSteps());
      },
      domainVersionSteps() {
        current();
        return state.domainVersionSteps();
      },
      validateEnvelope(detailsJson: string) {
        current();
        return finishIntakeCopySteps(state.validateEnvelopeSteps(detailsJson));
      },
      validateEnvelopeSteps(detailsJson: string) {
        current();
        return state.validateEnvelopeSteps(detailsJson);
      },
      rebind(target: IntakeStateIdentity, write: (key: string, value: string) => void) {
        return finishIntakeCopySteps(this.rebindSteps(target, write));
      },
      *rebindSteps(target: IntakeStateIdentity, write: (key: string, value: string) => void) {
        if (rebindInFlight) invalid('legacy rebind already in flight');
        rebindInFlight = true;
        try {
          current();
          const checked = validateIntakeIdentity(target);
          if (checked.intakeId !== identity.intakeId || checked.sourceHash !== identity.sourceHash)
            invalid('copy legacy identity');
          const targetPrefix = intakeNamespace(checked);
          let previous: Reference | null = null,
            bytes = 0;
          db.exec('DELETE FROM copied_operations');
          for (const row of db.prepare('SELECT id FROM receipts ORDER BY id').iterate()) {
            current();
            yield;
            db.prepare('INSERT INTO copied_operations VALUES(?,?)').run(row.id, randomUUID());
          }
          for (const row of db.prepare('SELECT raw,sha FROM frames ORDER BY sequence').iterate()) {
            current();
            yield;
            if (digest(String(row.raw)) !== row.sha) invalid('legacy frame scratch changed');
            const frame = decode(row.raw, FRAME_BYTES) as Frame,
              operationId = db
                .prepare('SELECT target FROM copied_operations WHERE id=?')
                .get(frame.operationId)?.target;
            if (typeof operationId !== 'string') invalid('copy legacy operation identity');
            const id = randomUUID(),
              copied: string = JSON.stringify({ ...frame, ...checked, id, operationId, previous });
            if (Buffer.byteLength(copied) > FRAME_BYTES) invalid('frame bound');
            bytes += Buffer.byteLength(copied);
            const key = targetPrefix + 'frame:' + id;
            write(key, copied);
            previous = { id, sequence: frame.sequence, sha256: digest(copied) };
          }
          for (const row of db
            .prepare('SELECT raw,target FROM receipts JOIN copied_operations USING(id) ORDER BY id')
            .iterate()) {
            current();
            yield;
            const receipt = decode(row.raw, HEAD_BYTES) as {
                fingerprint: string;
                result: IntakeStateResult;
              },
              copied = JSON.stringify({
                ...receipt,
                result: { ...receipt.result, operationId: row.target },
              });
            if (Buffer.byteLength(copied) > HEAD_BYTES) invalid('copy legacy receipt bound');
            bytes += Buffer.byteLength(copied);
            write(targetPrefix + 'operation:' + row.target, copied);
          }
          const rebound: Head = {
            ...head,
            ...checked,
            tip: previous!,
            usage: { ...head.usage, bytes },
          };
          usage(rebound.usage, caps);
          return rebound;
        } finally {
          rebindInFlight = false;
        }
      },
      close,
    });
    complete = true;
    return result;
  } finally {
    if (!complete) close();
  }
}
function validKey(value: string): string {
  if (value.length > 1000 || BAD.has(value)) invalid('legacy delta key');
  return value;
}
function numericKey(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < 0xffffffff && String(n) === value ? n : null;
}
function arrayIndex(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) invalid('legacy array index');
  const n = natural(Number(value));
  if (n >= MAX_ITEMS) invalid('legacy array index');
  return n;
}
function charge(budget: ChatDecodeBudget, kind: keyof ChatDecodeBudget, count: number) {
  budget[kind] -= count;
  if (budget[kind] < 0) throw new ChatDecodeLimitError('Intake decoded work limit exceeded');
}
function* numberValueSteps(
  tree: PreparedIntakeJsonCanonical,
  handle: IntakeJsonCanonicalHandle,
): Generator<void, number> {
  if (tree.kind(handle) !== 'number') invalid('legacy number');
  let result: number | undefined;
  yield* hashIntakeJsonScalarSteps(tree.pieces(handle), [], undefined, (n) => (result = n));
  if (result === undefined || !Number.isFinite(result)) invalid('legacy nonfinite number');
  return result as number;
}

interface Node {
  id: number;
  kind: string;
  value: string | null;
  start: number;
  units: number;
}
interface Entry {
  ordinal: number;
  key: string | null;
  numeric: number | null;
  child: number;
}
interface RawMember {
  nameStart: number;
  nameEnd: number;
  start: number;
  end: number;
}
const METADATA_FIELDS = new Set([
  'originalName',
  'acquisition',
  'metadata',
  'receivedMimeType',
  'createdAt',
  'parentSourceFileId',
  'locator',
  'derivative',
]);
export interface IntakeLegacyReplayWork {
  frames: number;
  versions: number;
  inputBytes: number;
  serializedBytes: number;
  scalarScratchBytes: number;
  peakScalarBufferBytes: number;
  peakFrameBytes: number;
}

class DiskIntakeValue {
  readonly checkpoint: () => void;
  readonly work: IntakeLegacyReplayWork;
  readonly scratch: ReturnType<typeof disposableSqlite>;
  readonly db: ReturnType<typeof disposableSqlite>['db'];
  readonly directory: string;
  readonly fd: number;
  root: number | undefined;
  private units = 0;
  constructor(checkpoint: () => void, work: IntakeLegacyReplayWork) {
    this.checkpoint = checkpoint;
    this.work = work;
    this.scratch = disposableSqlite('intake-legacy-values-');
    this.db = this.scratch.db;
    let directory: string | undefined, fd: number | undefined;
    try {
      this.directory = directory = mkdtempSync(join(tmpdir(), 'intake-legacy-scalars-'));
      this.fd = fd = openSync(join(directory, 'units'), 'wx+', 0o600);
      this.db.exec(`
      CREATE TABLE nodes(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,value TEXT,start INTEGER NOT NULL,units INTEGER NOT NULL);
      CREATE TABLE entries(parent INTEGER NOT NULL,ordinal INTEGER NOT NULL,key TEXT,numeric INTEGER,child INTEGER NOT NULL,PRIMARY KEY(parent,ordinal),UNIQUE(parent,key));
      CREATE TABLE reordered(position INTEGER PRIMARY KEY,key TEXT,numeric INTEGER,child INTEGER NOT NULL);
      CREATE TABLE inserted(position INTEGER PRIMARY KEY,child INTEGER NOT NULL);
      BEGIN;
    `);
    } catch (error) {
      try {
        if (fd !== undefined) closeSync(fd);
      } finally {
        try {
          this.scratch.close();
        } finally {
          if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
        }
      }
      throw error;
    }
  }
  close() {
    try {
      closeSync(this.fd);
    } finally {
      try {
        this.scratch.close();
      } finally {
        rmSync(this.directory, { recursive: true, force: true });
      }
    }
  }
  node(id: number): Node {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id=?').get(id);
    if (!row) invalid('missing replay node');
    return row as unknown as Node;
  }
  count(id: number): number {
    return Number(this.db.prepare('SELECT count(*) n FROM entries WHERE parent=?').get(id)!.n);
  }
  *entries(id: number, array = this.node(id).kind === 'array'): Generator<Entry> {
    const sql = array
      ? 'SELECT ordinal,key,numeric,child FROM entries WHERE parent=? ORDER BY ordinal'
      : 'SELECT ordinal,key,numeric,child FROM entries WHERE parent=? ORDER BY numeric IS NULL,numeric,ordinal';
    let visits = 0;
    for (const row of this.db.prepare(sql).iterate(id)) {
      if (++visits % 64 === 0) this.checkpoint();
      yield row as unknown as Entry;
    }
  }
  private write(text: string) {
    const bytes = Buffer.from(text, 'utf16le');
    this.work.peakScalarBufferBytes = Math.max(this.work.peakScalarBufferBytes, bytes.length);
    let at = 0;
    while (at < bytes.length) {
      const n = writeSync(this.fd, bytes, at, bytes.length - at, this.units * 2 + at);
      if (!n) invalid('legacy scalar scratch write stalled');
      at += n;
    }
    this.units += text.length;
    this.work.scalarScratchBytes += bytes.length;
  }
  *text(node: Node, start = 0, end = node.units): Generator<string> {
    const bytes = Buffer.alloc(4096);
    this.work.peakScalarBufferBytes = Math.max(this.work.peakScalarBufferBytes, bytes.length);
    while (start < end) {
      this.checkpoint();
      const count = Math.min(2048, end - start);
      let read = 0;
      while (read < count * 2) {
        const n = readSync(this.fd, bytes, read, count * 2 - read, (node.start + start) * 2 + read);
        if (!n) invalid('truncated legacy scalar scratch');
        read += n;
      }
      start += count;
      yield bytes.subarray(0, read).toString('utf16le');
    }
  }
  private *decodeStringSteps(
    tree: PreparedIntakeJsonCanonical,
    handle: IntakeJsonCanonicalHandle,
  ): Generator<void, Node> {
    const start = this.units;
    let pending = '';
    const flush = () => {
      this.write(pending);
      pending = '';
    };
    yield* hashIntakeJsonScalarSteps(tree.pieces(handle), [], (unit) => {
      pending += unit;
      if (pending.length === 512) flush();
    });
    flush();
    return { id: 0, kind: 'string', value: null, start, units: this.units - start };
  }
  private insertNode(node: Omit<Node, 'id'>): number {
    return Number(
      this.db
        .prepare('INSERT INTO nodes(kind,value,start,units) VALUES(?,?,?,?)')
        .run(node.kind, node.value, node.start, node.units).lastInsertRowid,
    );
  }
  private add(parent: number, ordinal: number, child: number, key: string | null = null) {
    this.db
      .prepare('INSERT INTO entries VALUES(?,?,?,?,?)')
      .run(parent, ordinal, key, key === null ? null : numericKey(key), child);
  }
  *cloneSteps(
    tree: PreparedIntakeJsonCanonical,
    handle: IntakeJsonCanonicalHandle,
    depth: number,
    budget: ChatDecodeBudget,
  ): Generator<void, number> {
    this.checkpoint();
    yield;
    charge(budget, 'nodes', 1);
    if (depth > MAX_DEPTH) invalid('legacy delta depth');
    const kind = tree.kind(handle);
    if (kind === 'string') return this.insertNode(yield* this.decodeStringSteps(tree, handle));
    if (kind !== 'object' && kind !== 'array') {
      const value =
        kind === 'number'
          ? JSON.stringify(yield* numberValueSteps(tree, handle))
          : kind === 'null'
            ? 'null'
            : [...tree.pieces(handle)].join('');
      return this.insertNode({ kind, value, start: 0, units: 0 });
    }
    const id = this.insertNode({ kind, value: null, start: 0, units: 0 });
    let count = 0;
    if (kind === 'array') {
      for (const child of tree.arrayItems(handle)) {
        if (count === MAX_ITEMS) invalid('legacy array items');
        this.add(id, count++, yield* this.cloneSteps(tree, child, depth + 1, budget));
      }
    } else {
      for (const field of tree.objectFields(handle)) {
        if (count === MAX_ITEMS) invalid('legacy object items');
        let key = '';
        for (const piece of field.name()) {
          key += piece;
          if (key.length > 6002) invalid('legacy delta key');
        }
        const name = validKey(JSON.parse(key) as string);
        this.add(id, count++, yield* this.cloneSteps(tree, field.value, depth + 1, budget), name);
      }
    }
    return id;
  }
  child(id: number, key: string): number | undefined {
    const node = this.node(id);
    if (node.kind === 'array') {
      const ordinal = arrayIndex(key);
      return this.db
        .prepare('SELECT child FROM entries WHERE parent=? AND ordinal=?')
        .get(id, ordinal)?.child as number | undefined;
    }
    if (node.kind !== 'object') invalid('legacy delta parent');
    return this.db.prepare('SELECT child FROM entries WHERE parent=? AND key=?').get(id, key)
      ?.child as number | undefined;
  }
  target(path: string[]): number {
    if (this.root === undefined) invalid('missing legacy delta state');
    let id = this.root as number;
    for (const key of path) {
      const child = this.child(id, key);
      if (child === undefined) invalid('missing legacy delta path');
      id = child as number;
    }
    return id;
  }
  private replace(parent: number, key: string, child: number) {
    const node = this.node(parent);
    if (node.kind === 'array') {
      const ordinal = arrayIndex(key),
        count = this.count(parent);
      if (ordinal > count) invalid('legacy array set index');
      if (ordinal === count) this.add(parent, ordinal, child);
      else
        this.db
          .prepare('UPDATE entries SET child=? WHERE parent=? AND ordinal=?')
          .run(child, parent, ordinal);
    } else {
      if (node.kind !== 'object') invalid('legacy delta parent');
      if (this.child(parent, key) === undefined) {
        const next = Number(
          this.db
            .prepare('SELECT coalesce(max(ordinal)+1,0) n FROM entries WHERE parent=?')
            .get(parent)!.n,
        );
        this.add(parent, next, child, key);
      } else
        this.db
          .prepare('UPDATE entries SET child=? WHERE parent=? AND key=?')
          .run(child, parent, key);
    }
  }
  private reordered(entry: Entry) {
    this.db
      .prepare('INSERT INTO reordered(key,numeric,child) VALUES(?,?,?)')
      .run(entry.key, entry.numeric, entry.child);
  }
  private finishOrder(parent: number) {
    this.db.prepare('DELETE FROM entries WHERE parent=?').run(parent);
    this.db
      .prepare(
        'INSERT INTO entries SELECT ?,position-1,key,numeric,child FROM reordered ORDER BY position',
      )
      .run(parent);
    this.db.exec('DELETE FROM reordered');
  }
  *applySteps(
    tree: PreparedIntakeJsonCanonical,
    change: IntakeJsonCanonicalHandle,
    budget: ChatDecodeBudget,
  ): Generator<void, void> {
    yield;
    if (tree.kind(change) !== 'object') invalid('legacy delta object');
    const op = intakeCopyJsonString(tree, tree.field(change, 'op'));
    const schemas: Record<string, string[]> = {
      set: ['op', 'path', 'value'],
      remove: ['op', 'path'],
      truncate: ['op', 'path', 'length'],
      splice: ['op', 'path', 'offset', 'remove', 'text'],
      'move-key': ['op', 'path', 'key', 'before'],
      'array-splice': ['op', 'path', 'offset', 'remove', 'values'],
      'array-move': ['op', 'path', 'from', 'to'],
    };
    if (!op || !Object.hasOwn(schemas, op)) invalid('legacy delta operation');
    const schema = schemas[op!]!;
    let fields = 0;
    for (const field of tree.objectFields(change)) {
      if (!schema.some((name) => field.matches(name))) invalid('legacy delta schema');
      fields++;
    }
    if (fields !== schema.length) invalid('legacy delta schema');
    const required = (name: string) => tree.field(change, name)!;
    const pathHandle = required('path');
    if (tree.kind(pathHandle) !== 'array') invalid('legacy delta path');
    const path: string[] = [];
    for (const entry of tree.arrayItems(pathHandle)) {
      const name = intakeCopyJsonString(tree, entry, 6002);
      if (name === undefined || path.length === MAX_DEPTH) invalid('legacy delta path');
      path.push(validKey(name as string));
    }
    if (!['move-key', 'array-splice', 'array-move'].includes(op!))
      charge(budget, 'operations', 1 + path.length);
    if (!path.length && op === 'set') {
      if (this.root !== undefined) invalid('legacy root replacement');
      this.root = yield* this.cloneSteps(tree, required('value'), 0, budget);
      if (this.node(this.root).kind !== 'object') invalid('legacy root object');
      return;
    }
    if (this.root === undefined) invalid('missing legacy delta state');
    if (op === 'set') {
      if (!path.length) invalid('legacy root replacement');
      const parent = this.target(path.slice(0, -1));
      this.replace(
        parent,
        path.at(-1)!,
        yield* this.cloneSteps(tree, required('value'), path.length, budget),
      );
    } else if (op === 'remove') {
      if (!path.length) invalid('legacy root removal');
      const parent = this.target(path.slice(0, -1));
      if (this.node(parent).kind !== 'object' || this.child(parent, path.at(-1)!) === undefined)
        invalid('legacy object removal');
      this.db.prepare('DELETE FROM entries WHERE parent=? AND key=?').run(parent, path.at(-1)!);
    } else if (op === 'truncate') {
      const target = this.target(path),
        length = natural(yield* numberValueSteps(tree, required('length')));
      if (this.node(target).kind !== 'array' || length >= this.count(target))
        invalid('legacy array truncate');
      this.db.prepare('DELETE FROM entries WHERE parent=? AND ordinal>=?').run(target, length);
    } else if (op === 'splice') {
      const target = this.node(this.target(path)),
        offset = natural(yield* numberValueSteps(tree, required('offset'))),
        remove = natural(yield* numberValueSteps(tree, required('remove'))),
        text = required('text');
      if (
        target.kind !== 'string' ||
        tree.kind(text) !== 'string' ||
        offset + remove > target.units ||
        !path.length
      )
        invalid('legacy string splice');
      const replacement = yield* this.decodeStringSteps(tree, text);
      charge(budget, 'stringWork', target.units + replacement.units);
      const start = this.units;
      for (const piece of this.text(target, 0, offset)) {
        this.write(piece);
        yield;
      }
      for (const piece of this.text(replacement)) {
        this.write(piece);
        yield;
      }
      for (const piece of this.text(target, offset + remove)) {
        this.write(piece);
        yield;
      }
      const next = this.insertNode({
        kind: 'string',
        value: null,
        start,
        units: this.units - start,
      });
      this.replace(this.target(path.slice(0, -1)), path.at(-1)!, next);
    } else if (op === 'move-key') {
      const target = this.target(path),
        key = intakeCopyJsonString(tree, required('key'), 6002),
        beforeHandle = required('before');
      const before =
        tree.kind(beforeHandle) === 'null' ? null : intakeCopyJsonString(tree, beforeHandle, 6002);
      if (this.node(target).kind !== 'object' || key === undefined || before === undefined)
        invalid('legacy key move');
      validKey(key!);
      if (numericKey(key!) !== null || this.child(target, key!) === undefined || before === key)
        invalid('legacy key move');
      if (
        before !== null &&
        (numericKey(validKey(before!)) !== null || this.child(target, before!) === undefined)
      )
        invalid('legacy key move');
      const count = this.count(target);
      if (count > MAX_ITEMS) invalid('legacy object items');
      charge(budget, 'operations', 1 + path.length + count);
      const moved = this.db
        .prepare('SELECT ordinal,key,numeric,child FROM entries WHERE parent=? AND key=?')
        .get(target, key!) as unknown as Entry;
      for (const entry of this.entries(target)) {
        yield;
        if (entry.key === key) continue;
        if (entry.key === before) this.reordered(moved);
        this.reordered(entry);
      }
      if (before === null) this.reordered(moved);
      this.finishOrder(target);
    } else {
      const target = this.target(path),
        count = this.count(target);
      if (this.node(target).kind !== 'array' || count > MAX_ITEMS) invalid('legacy array change');
      if (op === 'array-move') {
        const from = natural(yield* numberValueSteps(tree, required('from'))),
          to = natural(yield* numberValueSteps(tree, required('to')));
        if (from >= count || to >= count || from === to) invalid('legacy array move');
        charge(budget, 'operations', 1 + path.length + 2 * count);
        const moved = this.db
          .prepare('SELECT ordinal,key,numeric,child FROM entries WHERE parent=? AND ordinal=?')
          .get(target, from) as unknown as Entry;
        let at = 0;
        for (const entry of this.entries(target)) {
          yield;
          if (entry.ordinal === from) continue;
          if (at++ === to) this.reordered(moved);
          this.reordered(entry);
        }
        if (to === count - 1) this.reordered(moved);
        this.finishOrder(target);
      } else {
        const offset = natural(yield* numberValueSteps(tree, required('offset'))),
          remove = natural(yield* numberValueSteps(tree, required('remove'))),
          values = required('values');
        if (tree.kind(values) !== 'array' || offset + remove > count)
          invalid('legacy array splice');
        let inserted = 0;
        for (const _item of tree.arrayItems(values)) {
          yield;
          if (++inserted > MAX_ITEMS) invalid('legacy array items');
        }
        if (count - remove + inserted > MAX_ITEMS || (!remove && !inserted))
          invalid('legacy array splice');
        charge(budget, 'operations', 1 + path.length + count + inserted);
        for (const item of tree.arrayItems(values)) {
          this.db
            .prepare('INSERT INTO inserted(child) VALUES(?)')
            .run(yield* this.cloneSteps(tree, item, path.length + 1, budget));
        }
        for (const entry of this.entries(target)) {
          if (entry.ordinal < offset) this.reordered(entry);
          yield;
        }
        for (const row of this.db
          .prepare('SELECT child FROM inserted ORDER BY position')
          .iterate()) {
          this.reordered({ ordinal: 0, key: null, numeric: null, child: Number(row.child) });
          yield;
        }
        for (const entry of this.entries(target)) {
          if (entry.ordinal >= offset + remove) this.reordered(entry);
          yield;
        }
        this.finishOrder(target);
        this.db.exec('DELETE FROM inserted');
      }
    }
  }
  *pieces(id = this.root): Generator<string> {
    if (id === undefined) invalid('missing legacy value');
    const node = this.node(id as number);
    if (node.kind === 'string') {
      yield '"';
      let high = '';
      for (const piece of this.text(node)) {
        let text = high + piece;
        high = '';
        if (/[\uD800-\uDBFF]$/.test(text)) {
          high = text.slice(-1);
          text = text.slice(0, -1);
        }
        for (let at = 0; at < text.length;) {
          let end = Math.min(at + 512, text.length);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
          yield JSON.stringify(text.slice(at, end)).slice(1, -1);
          at = end;
        }
      }
      if (high) yield JSON.stringify(high).slice(1, -1);
      yield '"';
    } else if (node.kind === 'object' || node.kind === 'array') {
      yield node.kind === 'object' ? '{' : '[';
      let first = true;
      for (const entry of this.entries(node.id)) {
        if (!first) yield ',';
        first = false;
        if (node.kind === 'object') yield JSON.stringify(entry.key) + ':';
        yield* this.pieces(entry.child);
      }
      yield node.kind === 'object' ? '}' : ']';
    } else yield node.value!;
  }
  *domainVersionSteps(): Generator<void, number> {
    const root = this.node(this.target([]));
    let tree: PreparedIntakeJsonCanonical | undefined;
    try {
      const raw = this.child(root.id, 'raw');
      if (this.count(root.id) === 1 && raw !== undefined) {
        const node = this.node(raw);
        if (node.kind !== 'string') invalid('legacy envelope raw text');
        tree = yield* prepareIntakeJsonCanonicalSteps(this.text(node), {
          preserveNumbers: true,
          mode: 'stringify',
        });
        if (tree.kind(tree.root) !== 'object') invalid('legacy envelope');
        const intake = tree.field(tree.root, 'intake');
        if (!intake || tree.kind(intake) !== 'object') invalid('legacy intake');
        const version = tree.field(intake!, 'version');
        if (!version) invalid('legacy intake version');
        return natural(yield* numberValueSteps(tree, version!));
      }
      const intake = this.child(root.id, 'intake');
      if (intake === undefined || this.node(intake).kind !== 'object') invalid('legacy intake');
      const version = this.child(intake!, 'version');
      if (version === undefined || this.node(version).kind !== 'number')
        invalid('legacy intake version');
      return natural(Number(this.node(version!).value));
    } finally {
      tree?.close();
    }
  }
  envelopePieces(): Iterable<string> {
    const root = this.target([]),
      raw = this.child(root, 'raw');
    if (this.count(root) === 1 && raw !== undefined) {
      const node = this.node(raw);
      if (node.kind !== 'string') invalid('legacy envelope raw text');
      return this.text(node);
    }
    return this.pieces();
  }
  private *canonicalEnvelopeSteps(tree: PreparedIntakeJsonCanonical): Generator<void, number> {
    if (tree.kind(tree.root) !== 'object') invalid('legacy envelope');
    const intake = tree.field(tree.root, 'intake');
    if (!intake || tree.kind(intake) !== 'object') invalid('legacy intake');
    const workflow = tree.field(intake!, 'workflow');
    if (workflow) {
      if (tree.kind(workflow) !== 'object') invalid('unsupported legacy workflow');
      const format = tree.field(workflow, 'format');
      if (format && intakeCopyJsonString(tree, format) !== 'health-intake-workflow-v1')
        invalid('unsupported legacy workflow');
    }
    const version = tree.field(intake!, 'version');
    if (!version) invalid('legacy intake version');
    return natural(yield* numberValueSteps(tree, version!));
  }
  private *rawPieces(node: Node, start: number, end: number): Generator<string> {
    yield* this.text(node, start, end);
  }
  private *rawMembers(node: Node, start: number, end: number): Generator<RawMember | void> {
    let at = start,
      block = '',
      blockStart = -1;
    const peek = () => {
      if (at === end) return '';
      if (at < blockStart || at >= blockStart + block.length) {
        blockStart = at;
        block = this.text(node, at, Math.min(at + 2048, end)).next().value as string;
      }
      return block[at - blockStart] ?? '';
    };
    const ws = function* (this: DiskIntakeValue): Generator<void> {
      while (/^[\x20\t\r\n]$/.test(peek())) {
        at++;
        if (at % 4096 === 0) {
          this.checkpoint();
          yield;
        }
      }
    };
    const stringEnd = function* (this: DiskIntakeValue): Generator<void> {
      if (peek() !== '"') invalid('legacy raw string');
      at++;
      while (at < end) {
        if (at % 4096 === 0) {
          this.checkpoint();
          yield;
        }
        const char = peek();
        at++;
        if (char === '\\') at++;
        else if (char === '"') return;
      }
      invalid('incomplete legacy raw string');
    };
    const valueEnd = function* (this: DiskIntakeValue): Generator<void> {
      if (peek() === '"') {
        yield* stringEnd.call(this);
        return;
      }
      if (peek() === '{' || peek() === '[') {
        let depth = 0;
        do {
          if (at % 4096 === 0) {
            this.checkpoint();
            yield;
          }
          const char = peek();
          if (!char) invalid('incomplete legacy raw container');
          if (char === '"') {
            yield* stringEnd.call(this);
            continue;
          }
          at++;
          if (char === '{' || char === '[') depth++;
          else if (char === '}' || char === ']') depth--;
        } while (depth);
      } else
        while (peek() && !/^[\x20\t\r\n,}\]]$/.test(peek())) {
          at++;
          if (at % 4096 === 0) {
            this.checkpoint();
            yield;
          }
        }
    };
    yield* ws.call(this);
    if (peek() !== '{') invalid('legacy raw object');
    at++;
    yield* ws.call(this);
    if (peek() === '}') return;
    for (;;) {
      const nameStart = at;
      yield* stringEnd.call(this);
      const nameEnd = at;
      yield* ws.call(this);
      if (peek() !== ':') invalid('legacy raw property');
      at++;
      yield* ws.call(this);
      const valueStart = at;
      yield* valueEnd.call(this);
      yield { nameStart, nameEnd, start: valueStart, end: at };
      yield* ws.call(this);
      if (peek() === '}') return;
      if (peek() !== ',') invalid('legacy raw separator');
      at++;
      yield* ws.call(this);
    }
  }
  *validateEnvelopeSteps(detailsJson: string): Generator<void, { domainVersion: number }> {
    const projection = yield* prepareIntakeEnvelopeProjectionSteps(detailsJson);
    let rawTree: PreparedIntakeJsonCanonical | undefined;
    try {
      let domainVersion: number;
      let projected: Iterable<string | void>;
      if (projection.mode === 'raw') {
        const root = this.target([]),
          raw = this.child(root, 'raw');
        if (this.count(root) !== 1 || raw === undefined || this.node(raw).kind !== 'string')
          invalid('legacy raw sole text');
        const node = this.node(raw!);
        rawTree = yield* prepareIntakeJsonCanonicalSteps(this.text(node), {
          mode: 'stringify',
          preserveNumbers: true,
        });
        domainVersion = yield* this.canonicalEnvelopeSteps(rawTree);
        projected = this.rawMetadataPieces(node, projection.format);
      } else {
        const root = this.target([]),
          intake = this.child(root, 'intake');
        if (intake === undefined || this.node(intake).kind !== 'object') invalid('legacy intake');
        const workflow = this.child(intake!, 'workflow');
        if (workflow !== undefined) {
          if (this.node(workflow).kind !== 'object') invalid('unsupported legacy workflow');
          const format = this.child(workflow, 'format');
          if (format !== undefined) {
            const value = this.node(format);
            let text = '';
            if (value.kind !== 'string' || value.units !== 'health-intake-workflow-v1'.length)
              invalid('unsupported legacy workflow');
            for (const piece of this.text(value)) text += piece;
            if (text !== 'health-intake-workflow-v1') invalid('unsupported legacy workflow');
          }
        }
        domainVersion = yield* this.domainVersionSteps();
        projected = this.normalizedMetadataPieces(intake!, projection.format);
      }
      let offset = 0;
      for (const piece of projected) {
        this.checkpoint();
        yield;
        if (piece === undefined) continue;
        if (detailsJson.slice(offset, offset + piece.length) !== piece)
          invalid('compact metadata conflicts with legacy state');
        offset += piece.length;
      }
      if (offset !== detailsJson.length) invalid('compact metadata conflicts with legacy state');
      return { domainVersion };
    } finally {
      rawTree?.close();
    }
  }
  private *normalizedMetadataPieces(
    intake: number,
    format: IntakeEnvelopeProjectionFormat,
  ): Generator<string | void> {
    yield '{"intakeAuthority":' + JSON.stringify({ format, mode: 'normalized' }) + ',"intake":{';
    let first = true;
    for (const entry of this.entries(intake)) {
      if (!METADATA_FIELDS.has(entry.key!)) continue;
      if (!first) yield ',';
      first = false;
      yield JSON.stringify(entry.key) + ':';
      const node = this.node(entry.child);
      let bytes = 0;
      if (
        format !== INTAKE_ENVELOPE_FORMAT &&
        ['originalName', 'locator'].includes(entry.key!) &&
        node.kind === 'string'
      )
        for (const piece of this.pieces(node.id)) {
          bytes += Buffer.byteLength(piece);
          yield;
        }
      if (bytes > COMPACT_SCALAR_BYTES)
        yield JSON.stringify(
          yield* compactIntakeScalarSteps(
            entry.key as 'originalName' | 'locator',
            this.pieces(node.id),
          ),
        );
      else yield* this.pieces(node.id);
    }
    yield '}}';
  }
  private *rawMetadataPieces(
    node: Node,
    format: IntakeEnvelopeProjectionFormat,
  ): Generator<string | void> {
    const known = new Map([...METADATA_FIELDS].map((name) => [schemaKey(name), name]));
    const nameHash = function* (this: DiskIntakeValue, member: RawMember): Generator<void, string> {
      return (yield* hashIntakeJsonScalarSteps(
        this.rawPieces(node, member.nameStart, member.nameEnd),
      )).hash;
    };
    yield '{"intakeAuthority":' + JSON.stringify({ format, mode: 'raw' }) + ',';
    let firstIntake = true;
    for (const intake of this.rawMembers(node, 0, node.units)) {
      if (intake === undefined) {
        yield;
        continue;
      }
      if ((yield* nameHash.call(this, intake)) !== schemaKey('intake')) continue;
      if (!firstIntake) yield ',';
      firstIntake = false;
      yield* this.rawPieces(node, intake.nameStart, intake.nameEnd);
      yield ':';
      if (this.rawPieces(node, intake.start, intake.start + 1).next().value !== '{') {
        yield 'null';
        continue;
      }
      yield '{';
      let first = true;
      for (const member of this.rawMembers(node, intake.start, intake.end)) {
        if (member === undefined) {
          yield;
          continue;
        }
        const name = known.get(yield* nameHash.call(this, member));
        if (!name) continue;
        if (!first) yield ',';
        first = false;
        yield* this.rawPieces(node, member.nameStart, member.nameEnd);
        yield ':';
        let bytes = 0;
        const string = this.rawPieces(node, member.start, member.start + 1).next().value === '"';
        if (
          format !== INTAKE_ENVELOPE_FORMAT &&
          ['originalName', 'locator'].includes(name) &&
          string
        )
          for (const piece of this.rawPieces(node, member.start, member.end)) {
            bytes += Buffer.byteLength(piece);
            yield;
          }
        if (bytes > COMPACT_SCALAR_BYTES)
          yield JSON.stringify(
            yield* compactIntakeScalarSteps(
              name as 'originalName' | 'locator',
              this.rawPieces(node, member.start, member.end),
            ),
          );
        else yield* this.rawPieces(node, member.start, member.end);
      }
      yield '}';
    }
    yield '}';
  }
}
