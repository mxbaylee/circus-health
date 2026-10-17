/** Invocation-local encrypted working storage. Never durable record evidence.
 * Roots and keys exist only in this closure. Immutable COW pages, including
 * superseded pages, remain encrypted until invocation cleanup.
 * Temporary writes/retention are O(M log M); this implementation does not prune.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshKey, encryptObjectToFileDescriptor, decryptObject } from './vault-crypto.ts';
import {
  digest,
  validateIntakeIdentity,
  type IntakeStateIdentity,
} from './intake-state-evidence.ts';
import {
  createIntakeTree,
  INTAKE_TREE_PAGE_BYTES,
  INTAKE_TREE_VALUE_BYTES,
  intakeTreeKey,
  type IntakeTreeCachedNode,
  type IntakeTreeRoot,
} from './intake-state-tree.ts';

const CHUNK_BYTES = 4096;
const MAX_RANGE_BYTES = 65536;
// Leave room for five worst-case JSON-escaped 1024-byte tree keys and summaries.
const INLINE_JSON_BYTES = 1024;
const MAX_TABLES = 32;
const MAX_SPOOLS = 8;
const CAPACITY_CODES = new Set(['ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'EFBIG']);
const scalarBrand: unique symbol = Symbol('encrypted scratch scalar');
export interface IntakeEncryptedScratchScalar {
  readonly [scalarBrand]: true;
  readonly bytes: number;
  readonly chunks: number;
}
export type IntakeEncryptedScratchValue = string | IntakeEncryptedScratchScalar;
export class IntakeEncryptedScratchCapacityError extends Error {
  readonly kind = 'capacity';
  readonly code: string;
  constructor(code: string, cause?: unknown) {
    super('Encrypted intake scratch capacity unavailable', { cause });
    this.code = code;
  }
}
export class IntakeEncryptedScratchIntegrityError extends Error {
  readonly kind = 'integrity';
  constructor(cause?: unknown) {
    super('Encrypted intake scratch integrity unavailable', { cause });
  }
}
export interface IntakeEncryptedScratchOptions {
  identity: IntakeStateIdentity;
  selectedHead: string;
  /** Fixed table roster; opening a map never allocates another retained root. */
  tables: readonly string[];
  /** Fixed spool roster; each spool retains at most one 4KiB plaintext tail. */
  spools?: readonly string[];
  assertCurrent?: () => void;
  /** Optional caller resource budget, not an accepted-history format limit. */
  capacity?: { files?: number; bytes?: number };
}
interface ScalarRecord {
  id: string;
  bytes: number;
  chunks: number;
  sha256: string;
}
interface Table {
  root: IntakeTreeRoot;
  generation: number;
  epoch: number;
}
interface SpoolState {
  id: string;
  tail: Buffer;
  used: number;
  bytes: number;
  chunks: number;
  sealed: number;
  generation: number;
}
const ordered = (value: number) => String(value).padStart(16, '0');
function safeAdd(a: number, b: number) {
  const value = a + b;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new IntakeEncryptedScratchCapacityError('COUNTER_RANGE');
  return value;
}

export function createIntakeEncryptedScratch(options: IntakeEncryptedScratchOptions) {
  if (options.tables.length > MAX_TABLES || (options.spools?.length ?? 0) > MAX_SPOOLS)
    throw new Error('Encrypted scratch fixed roster bound');
  const identity = Object.freeze({ ...validateIntakeIdentity(options.identity) }),
    selectedHead = options.selectedHead,
    declaredTables = [...options.tables],
    declaredSpools = [...(options.spools ?? [])],
    assertCurrent = options.assertCurrent,
    capacity = { files: options.capacity?.files, bytes: options.capacity?.bytes };
  if (typeof selectedHead !== 'string' || Buffer.byteLength(selectedHead) > 4096)
    throw new Error('Encrypted scratch selected head bound');
  if (
    new Set(declaredTables).size !== declaredTables.length ||
    new Set(declaredSpools).size !== declaredSpools.length ||
    [...declaredTables, ...declaredSpools].some((name) => !/^[a-zA-Z0-9_.:-]{1,64}$/.test(name))
  )
    throw new Error('Encrypted scratch fixed table roster');
  for (const value of Object.values(capacity))
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error('Encrypted scratch resource budget');
  const tables = new Map<string, Table>(),
    cache = new Map<string, IntakeTreeCachedNode>(),
    scalars = new WeakMap<IntakeEncryptedScratchScalar, ScalarRecord>(),
    spools = new Map<string, SpoolState>();
  let directory = '',
    session: string,
    binding: string,
    allocatedKey: Buffer | undefined,
    allocatedFilenameKey: Buffer | undefined;
  try {
    allocatedKey = freshKey();
    allocatedFilenameKey = freshKey();
    session = randomUUID();
    binding = JSON.stringify([identity, digest(selectedHead), session]);
    for (const name of declaredSpools)
      spools.set(name, {
        id: randomUUID(),
        tail: Buffer.alloc(CHUNK_BYTES),
        used: 0,
        bytes: 0,
        chunks: 0,
        sealed: 0,
        generation: 0,
      });
    for (const name of [...declaredTables.map((name) => 'map:' + name), 'scalars', 'chunks'])
      tables.set(name, { root: null, generation: 0, epoch: 0 });
    directory = mkdtempSync(join(tmpdir(), 'intake-encrypted-scratch-'));
    directory = realpathSync.native(directory);
    mkdirSync(join(directory, 'cells'), { mode: 0o700 });
  } catch (error) {
    allocatedKey?.fill(0);
    allocatedFilenameKey?.fill(0);
    for (const spool of spools.values()) spool.tail.fill(0);
    if (directory) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {}
    }
    if (CAPACITY_CODES.has(String((error as NodeJS.ErrnoException)?.code)))
      throw new IntakeEncryptedScratchCapacityError(
        String((error as NodeJS.ErrnoException).code),
        error,
      );
    throw error;
  }
  const key = allocatedKey,
    filenameKey = allocatedFilenameKey;
  let closed = false,
    busy = false;
  const counts = {
    filesWritten: 0,
    ciphertextBytesWritten: 0,
    filesRetained: 0,
    ciphertextBytesRetained: 0,
    nodeReads: 0,
    nodeWrites: 0,
    scalarChunkReads: 0,
    scalarChunkWrites: 0,
    plaintextBytesRead: 0,
    plaintextBytesWritten: 0,
    preparations: 0,
    peakPreparedWritePages: 0,
    peakPreparedWriteBytes: 0,
    peakPreparationPageBound: 0,
    peakCachePages: 0,
    peakCacheBytes: 0,
    cleanupFailures: 0,
    peakReservedFiles: 0,
    peakReservedCiphertextBytes: 0,
    spoolTailBytes: declaredSpools.length * CHUNK_BYTES,
  };
  const checkpoint = () => {
    if (closed) throw new Error('Encrypted intake scratch closed');
    assertCurrent?.();
    if (closed) throw new Error('Encrypted intake scratch closed');
  };
  function sampleCache() {
    counts.peakCachePages = Math.max(counts.peakCachePages, cache.size);
    counts.peakCacheBytes = Math.max(
      counts.peakCacheBytes,
      [...cache.values()].reduce((n, page) => n + Buffer.byteLength(page.raw), 0),
    );
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const table of tables.values()) table.root = null;
    for (const spool of spools.values()) spool.tail.fill(0);
    cache.clear();
    key.fill(0);
    filenameKey.fill(0);
    try {
      rmSync(directory, { recursive: true, force: true });
      counts.filesRetained = 0;
      counts.ciphertextBytesRetained = 0;
    } catch (error) {
      counts.cleanupFailures++;
      throw error;
    }
  }
  function run<T>(operation: () => T): T {
    try {
      if (busy) throw new Error('Encrypted intake scratch reentrant operation');
      busy = true;
      checkpoint();
      const result = operation();
      sampleCache();
      checkpoint();
      return result;
    } catch (error) {
      sampleCache();
      try {
        close();
      } catch {
        // Keys/roots are already erased; preserve the operation's refusal.
      }
      if (CAPACITY_CODES.has(String((error as NodeJS.ErrnoException)?.code)))
        throw new IntakeEncryptedScratchCapacityError(
          String((error as NodeJS.ErrnoException).code),
          error,
        );
      throw error;
    } finally {
      busy = false;
    }
  }
  const purpose = (table: string, hash: string) =>
    JSON.stringify(['intake-encrypted-scratch-v1', binding, table, hash]);
  const path = (table: string, hash: string) =>
    join(
      directory,
      'cells',
      createHmac('sha256', filenameKey)
        .update(JSON.stringify([table, hash]))
        .digest('hex'),
    );
  function readCell(table: string, hash: string, maxBytes: number): Buffer {
    checkpoint();
    let bytes: Buffer;
    try {
      const target = path(table, hash),
        before = lstatSync(target, { bigint: true });
      if (!before.isFile() || before.size > BigInt(maxBytes + 1024))
        throw new IntakeEncryptedScratchIntegrityError();
      // The existing codec bounds each encrypted frame at 1MiB before allocation,
      // then enforces this smaller plaintext limit before returning any bytes.
      bytes = decryptObject(
        target,
        key,
        identity.profileId,
        purpose(table, hash),
        undefined,
        maxBytes,
      );
      const after = lstatSync(target, { bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new IntakeEncryptedScratchIntegrityError();
    } catch (error) {
      if (CAPACITY_CODES.has(String((error as NodeJS.ErrnoException)?.code))) throw error;
      throw new IntakeEncryptedScratchIntegrityError(error);
    }
    counts.plaintextBytesRead = safeAdd(counts.plaintextBytesRead, bytes.length);
    checkpoint();
    return bytes;
  }
  function writeCell(table: string, hash: string, bytes: Uint8Array) {
    checkpoint();
    const target = path(table, hash);
    // Conservative framing reservation, checked before file creation. The
    // ciphertext bound is also enforced on reads; it is not a history cap.
    const reservedFiles = safeAdd(counts.filesRetained, 1),
      reservedBytes = safeAdd(counts.ciphertextBytesRetained, bytes.length + 1024);
    try {
      lstatSync(target);
      if (!readCell(table, hash, bytes.length).equals(Buffer.from(bytes)))
        throw new IntakeEncryptedScratchIntegrityError();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      reservedFiles > (capacity.files ?? Infinity) ||
      reservedBytes > (capacity.bytes ?? Infinity)
    )
      throw new IntakeEncryptedScratchCapacityError('BUDGET');
    counts.peakReservedFiles = Math.max(counts.peakReservedFiles, reservedFiles);
    counts.peakReservedCiphertextBytes = Math.max(
      counts.peakReservedCiphertextBytes,
      reservedBytes,
    );
    let fd: number;
    try {
      fd = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!readCell(table, hash, bytes.length).equals(Buffer.from(bytes)))
        throw new IntakeEncryptedScratchIntegrityError();
      return;
    }
    let failure: unknown;
    try {
      encryptObjectToFileDescriptor(fd, bytes, key, identity.profileId, purpose(table, hash));
      counts.plaintextBytesWritten = safeAdd(counts.plaintextBytesWritten, bytes.length);
    } catch (error) {
      failure = error;
    } finally {
      try {
        closeSync(fd);
      } catch (error) {
        failure ??= error;
      }
      counts.filesWritten = safeAdd(counts.filesWritten, 1);
      counts.filesRetained = safeAdd(counts.filesRetained, 1);
      try {
        const size = Number(lstatSync(target, { bigint: true }).size);
        counts.ciphertextBytesWritten = safeAdd(counts.ciphertextBytesWritten, size);
        counts.ciphertextBytesRetained = safeAdd(counts.ciphertextBytesRetained, size);
        if (size > bytes.length + 1024) throw new IntakeEncryptedScratchIntegrityError();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
    checkpoint();
  }
  function pages(name: string) {
    const scope = {
      ...identity,
      // Keep private node headers bounded even for escaped profile identifiers;
      // the complete original identity remains authenticated in every cell AAD.
      profileId: digest(identity.profileId),
      intakeId: digest(JSON.stringify([session, name, tables.get(name)!.epoch])),
      sourceHash: digest(binding),
    };
    return createIntakeTree(
      scope,
      (hash) => {
        counts.nodeReads++;
        const bytes = readCell(name, hash, INTAKE_TREE_PAGE_BYTES);
        if (digest(bytes.toString('utf8')) !== hash)
          throw new IntakeEncryptedScratchIntegrityError();
        return bytes.toString('utf8');
      },
      cache,
    );
  }
  const get = (name: string, cellKey: string) => pages(name).get(tables.get(name)!.root, cellKey);
  function put(name: string, cellKey: string, value: string | null) {
    const table = tables.get(name)!;
    const before = get(name, cellKey);
    if (before === value || (value === null && before === undefined)) return false;
    const tree = pages(name),
      next = tree.put(table.root, cellKey, value);
    counts.preparations++;
    // Includes unreachable intermediates from a single-key path/rotations;
    // exact emitted pages/bytes are counted separately below.
    counts.peakPreparationPageBound = Math.max(
      counts.peakPreparationPageBound,
      4 * ((table.root?.height ?? 0) + 1) + 8,
    );
    let prepared = 0,
      bytes = 0;
    for (const node of tree.writes([next])) {
      prepared++;
      bytes += Buffer.byteLength(node.raw);
      writeCell(name, node.hash, Buffer.from(node.raw));
      counts.nodeWrites++;
    }
    counts.peakPreparedWritePages = Math.max(counts.peakPreparedWritePages, prepared);
    counts.peakPreparedWriteBytes = Math.max(counts.peakPreparedWriteBytes, bytes);
    checkpoint();
    table.root = next;
    table.generation++;
    sampleCache();
    return true;
  }
  function scalarRecord(value: IntakeEncryptedScratchScalar): ScalarRecord {
    const record = scalars.get(value);
    if (!record || get('scalars', record.id) !== JSON.stringify(record))
      throw new IntakeEncryptedScratchIntegrityError();
    return record;
  }
  function capability(record: ScalarRecord): IntakeEncryptedScratchScalar {
    const value = Object.freeze({
      [scalarBrand]: true as const,
      bytes: record.bytes,
      chunks: record.chunks,
    });
    scalars.set(value, record);
    return value;
  }
  const chunkKey = (id: string, index: number, bytes: number) =>
    id + ':' + ordered(index) + ':' + ordered(bytes);
  function writeChunk(id: string, index: number, content: Buffer) {
    const sha = digest(content.toString('base64'));
    writeCell('scalar:' + id, sha + ':' + ordered(index), content);
    counts.scalarChunkWrites++;
    put(
      'chunks',
      chunkKey(id, index, content.length),
      JSON.stringify({ sha, bytes: content.length }),
    );
  }
  function readChunk(id: string, index: number, expectedBytes: number): Buffer {
    const raw = get('chunks', chunkKey(id, index, expectedBytes));
    if (!raw) throw new IntakeEncryptedScratchIntegrityError();
    const cell = JSON.parse(raw) as { sha: string; bytes: number };
    if (
      !/^[a-f0-9]{64}$/.test(cell.sha) ||
      cell.bytes !== expectedBytes ||
      expectedBytes < 1 ||
      expectedBytes > CHUNK_BYTES
    )
      throw new IntakeEncryptedScratchIntegrityError();
    const bytes = readCell('scalar:' + id, cell.sha + ':' + ordered(index), expectedBytes);
    if (bytes.length !== expectedBytes || digest(bytes.toString('base64')) !== cell.sha)
      throw new IntakeEncryptedScratchIntegrityError();
    counts.scalarChunkReads++;
    return bytes;
  }
  function checkRange(total: number, start: number, bytes: number) {
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_RANGE_BYTES ||
      !Number.isSafeInteger(start + bytes) ||
      start + bytes > total
    )
      throw new Error('Encrypted scratch byte range bound');
  }
  function scalarRange(record: ScalarRecord, start: number, byteLength: number): Buffer {
    checkRange(record.bytes, start, byteLength);
    const result = Buffer.alloc(byteLength);
    for (let cursor = start; cursor < start + byteLength;) {
      const index = Math.floor(cursor / CHUNK_BYTES),
        offset = cursor % CHUNK_BYTES,
        expected = Math.min(CHUNK_BYTES, record.bytes - index * CHUNK_BYTES),
        chunk = readChunk(record.id, index, expected),
        count = Math.min(chunk.length - offset, start + byteLength - cursor);
      chunk.copy(result, cursor - start, offset, offset + count);
      cursor += count;
    }
    return result;
  }
  function writeScalar(pieces: Iterable<Uint8Array>): IntakeEncryptedScratchScalar {
    const id = randomUUID(),
      hash = createHash('sha256'),
      buffer = Buffer.alloc(CHUNK_BYTES);
    let used = 0,
      bytes = 0,
      chunks = 0;
    const flush = () => {
      if (!used) return;
      writeChunk(id, chunks, buffer.subarray(0, used));
      chunks = safeAdd(chunks, 1);
      used = 0;
    };
    try {
      for (const piece of pieces) {
        if (!(piece instanceof Uint8Array)) throw new Error('Encrypted scratch scalar byte pieces');
        for (let offset = 0; offset < piece.length;) {
          checkpoint();
          const count = Math.min(CHUNK_BYTES - used, piece.length - offset),
            part = piece.subarray(offset, offset + count);
          buffer.set(part, used);
          hash.update(part);
          bytes = safeAdd(bytes, count);
          used += count;
          offset += count;
          if (used === CHUNK_BYTES) flush();
        }
      }
      flush();
      const record = { id, bytes, chunks, sha256: hash.digest('hex') };
      put('scalars', id, JSON.stringify(record));
      return capability(record);
    } finally {
      buffer.fill(0);
    }
  }
  function* scalarChunks(value: IntakeEncryptedScratchScalar): Generator<Buffer> {
    const record = run(() => scalarRecord(value)),
      hash = createHash('sha256');
    let total = 0;
    for (let index = 0; index < record.chunks; index++) {
      const bytes = run(() =>
        readChunk(record.id, index, Math.min(CHUNK_BYTES, record.bytes - index * CHUNK_BYTES)),
      );
      hash.update(bytes);
      total += bytes.length;
      yield bytes;
    }
    run(() => {
      if (total !== record.bytes || hash.digest('hex') !== record.sha256)
        throw new IntakeEncryptedScratchIntegrityError();
    });
  }
  function decode(value: string | undefined): IntakeEncryptedScratchValue | undefined {
    if (value === undefined) return undefined;
    if (value[0] === '1') return value.slice(1);
    if (value[0] !== '2' && value[0] !== '3') throw new IntakeEncryptedScratchIntegrityError();
    const raw = get('scalars', value.slice(1));
    if (!raw) throw new IntakeEncryptedScratchIntegrityError();
    const record = JSON.parse(raw) as ScalarRecord;
    const scalar = capability(record);
    if (value[0] === '2') return scalar;
    // Inline strings that exceed the encoded cell bound use exact JSON bytes,
    // preserving lone UTF16 surrogates without an unbounded materialization.
    if (record.bytes > 6 * INTAKE_TREE_VALUE_BYTES + 2)
      throw new IntakeEncryptedScratchIntegrityError();
    const pieces: Buffer[] = [];
    for (const part of readScalarInside(record)) pieces.push(part);
    const result: unknown = JSON.parse(Buffer.concat(pieces).toString('utf8'));
    if (typeof result !== 'string' || Buffer.byteLength(result) > INTAKE_TREE_VALUE_BYTES)
      throw new IntakeEncryptedScratchIntegrityError();
    return result;
  }
  function* readScalarInside(record: ScalarRecord) {
    const hash = createHash('sha256');
    let total = 0;
    for (let index = 0; index < record.chunks; index++) {
      const bytes = readChunk(
        record.id,
        index,
        Math.min(CHUNK_BYTES, record.bytes - index * CHUNK_BYTES),
      );
      hash.update(bytes);
      total += bytes.length;
      yield bytes;
    }
    if (total !== record.bytes || hash.digest('hex') !== record.sha256)
      throw new IntakeEncryptedScratchIntegrityError();
  }
  function map(name: string) {
    const tableName = 'map:' + name,
      table = tables.get(tableName);
    if (!table) throw new Error('Encrypted scratch undeclared table');
    return Object.freeze({
      get(cellKey: string) {
        return run(() => decode(get(tableName, cellKey)));
      },
      set(cellKey: string, value: IntakeEncryptedScratchValue) {
        return run(() => {
          intakeTreeKey(cellKey);
          const before = get(tableName, cellKey);
          let encoded: string;
          if (typeof value === 'string') {
            if (Buffer.byteLength(value) > INTAKE_TREE_VALUE_BYTES)
              throw new Error('Encrypted scratch map payload bound');
            encoded = '1' + value;
            if (Buffer.byteLength(JSON.stringify(encoded)) > INLINE_JSON_BYTES) {
              if (decode(before) === value) return false;
              const scalar = writeScalar([Buffer.from(JSON.stringify(value))]);
              encoded = '3' + scalarRecord(scalar).id;
            }
          } else encoded = '2' + scalarRecord(value).id;
          if (before === encoded) return false;
          put(tableName, cellKey, encoded);
          return true;
        });
      },
      /** Deletes from the selected root; prior ciphertext remains until cleanup. */
      delete(cellKey: string) {
        return run(() => {
          const before = get(tableName, cellKey);
          if (before === undefined) return false;
          put(tableName, cellKey, null);
          return true;
        });
      },
      /** Bounded ordered scan; cursor names the last returned key. */
      scan(options: { after?: string; items?: number; scanned?: number } = {}) {
        return run(() => {
          const items = options.items ?? 64,
            scanned = options.scanned ?? 128;
          if (
            !Number.isInteger(items) ||
            items < 1 ||
            items > 128 ||
            !Number.isInteger(scanned) ||
            scanned < 1 ||
            scanned > 128
          )
            throw new Error('Encrypted scratch scan bound');
          const entries: Array<{ key: string; value: IntakeEncryptedScratchValue }> = [];
          let after = options.after,
            visited = 0,
            complete = true;
          const iterator = pages(tableName).entries(table.root, after);
          try {
            for (;;) {
              const next = iterator.next();
              if (next.done) break;
              if (visited === scanned || entries.length === items) {
                complete = false;
                break;
              }
              visited++;
              after = next.value.key;
              const value = decode(next.value.value);
              if (value !== undefined) entries.push({ key: next.value.key, value });
            }
          } finally {
            iterator.return(undefined);
          }
          return { entries, scanned: visited, after: complete ? undefined : after, complete };
        });
      },
      size: () => run(() => table.root?.count ?? 0),
      /** Fresh authenticated empty generation; immutable ciphertext is retained. */
      clear() {
        return run(() => {
          table.epoch = safeAdd(table.epoch, 1);
          table.generation = safeAdd(table.generation, 1);
          table.root = null;
        });
      },
    });
  }
  function spool(name: string) {
    const state = spools.get(name);
    if (!state) throw new Error('Encrypted scratch undeclared spool');
    return Object.freeze({
      appendBytes(input: Uint8Array) {
        return run(() => {
          if (!(input instanceof Uint8Array)) throw new Error('Encrypted scratch spool bytes');
          const total = safeAdd(state.bytes, input.length);
          if (input.length) state.sealed = 0;
          for (let offset = 0; offset < input.length;) {
            checkpoint();
            const count = Math.min(CHUNK_BYTES - state.used, input.length - offset);
            state.tail.set(input.subarray(offset, offset + count), state.used);
            state.used += count;
            offset += count;
            if (state.used === CHUNK_BYTES) {
              writeChunk(state.id, state.chunks, state.tail);
              state.chunks = safeAdd(state.chunks, 1);
              state.tail.fill(0);
              state.used = 0;
            }
          }
          state.bytes = total;
        });
      },
      length: () => run(() => state.bytes),
      /** Seals the current tail; later appends retain immutable older tail versions. */
      flush() {
        return run(() => {
          if (state.used) writeChunk(state.id, state.chunks, state.tail.subarray(0, state.used));
          state.sealed = state.used;
        });
      },
      /** Byte offsets; <=64KiB, including overlap with the current unflushed RAM tail. */
      read(start: number, byteLength: number) {
        return run(() => {
          checkRange(state.bytes, start, byteLength);
          const result = Buffer.alloc(byteLength);
          for (let cursor = start; cursor < start + byteLength;) {
            const index = Math.floor(cursor / CHUNK_BYTES),
              offset = cursor % CHUNK_BYTES,
              chunk =
                index === state.chunks
                  ? state.sealed === state.used
                    ? readChunk(state.id, index, state.used)
                    : state.tail.subarray(0, state.used)
                  : readChunk(state.id, index, CHUNK_BYTES),
              count = Math.min(chunk.length - offset, start + byteLength - cursor);
            chunk.copy(result, cursor - start, offset, offset + count);
            cursor += count;
          }
          return result;
        });
      },
      /** New logical generation; old ciphertext and index cells remain counted. */
      reset() {
        return run(() => {
          state.tail.fill(0);
          state.id = randomUUID();
          state.used = state.bytes = state.chunks = state.sealed = 0;
          state.generation = safeAdd(state.generation, 1);
        });
      },
      generation: () => run(() => state.generation),
    });
  }
  return Object.freeze({
    directory,
    map,
    spool,
    writeScalar: (pieces: Iterable<Uint8Array>) => run(() => writeScalar(pieces)),
    scalarChunks,
    /** <=64KiB; authenticates addressed chunks without scanning a preceding prefix. */
    readScalarRange: (value: IntakeEncryptedScratchScalar, start: number, byteLength: number) =>
      run(() => scalarRange(scalarRecord(value), start, byteLength)),
    close,
    stats: () => ({
      ...counts,
      cachePages: cache.size,
      cacheBytes: [...cache.values()].reduce((n, page) => n + Buffer.byteLength(page.raw), 0),
      closed,
    }),
  });
}

export async function withIntakeEncryptedScratch<T>(
  options: IntakeEncryptedScratchOptions,
  work: (scratch: ReturnType<typeof createIntakeEncryptedScratch>) => T | Promise<T>,
): Promise<T> {
  const scratch = createIntakeEncryptedScratch(options);
  try {
    const result = await work(scratch);
    scratch.close();
    return result;
  } catch (error) {
    try {
      scratch.close();
    } catch {
      /* Preserve the caller/operation failure. */
    }
    throw error;
  }
}
