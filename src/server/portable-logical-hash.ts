import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  ftruncateSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createIntakeCopyIncrementalReaderFromPortableBackup } from './intake-copy-incremental-reader.ts';

const CHUNK = 16 * 1024;
const FAN_IN = 16;
type Bytes = { offset: number; bytes: number; sha256: string };
type Row = { id: bigint; sort: Bytes; value: Bytes; signature: string };

function* utf8(pieces: Iterable<string>): Generator<Buffer> {
  let high = '';
  for (const piece of pieces) {
    for (let offset = 0; offset < piece.length; offset += CHUNK) {
      const text = high + piece.slice(offset, offset + CHUNK);
      const hold = /[\uD800-\uDBFF]$/.test(text);
      const ready = hold ? text.slice(0, -1) : text;
      high = hold ? text.slice(-1) : '';
      if (ready) yield Buffer.from(ready, 'utf8');
    }
  }
  if (high) yield Buffer.from(high, 'utf8');
}

function* utf16Sort(pieces: Iterable<string>): Generator<Buffer> {
  for (const piece of pieces) {
    for (let offset = 0; offset < piece.length; offset += CHUNK) {
      const part = piece.slice(offset, offset + CHUNK);
      const bytes = Buffer.allocUnsafe(part.length * 2);
      for (let at = 0; at < part.length; at++) bytes.writeUInt16BE(part.charCodeAt(at), at * 2);
      if (bytes.length) yield bytes;
    }
  }
}

function exactRead(fd: number, offset: number, bytes: number): Buffer {
  const value = Buffer.alloc(bytes);
  for (let at = 0; at < bytes;) {
    const read = readSync(fd, value, at, bytes - at, offset + at);
    if (!read) throw Error('Portable logical scratch truncated');
    at += read;
  }
  return value;
}

/** Exact legacy JSON.stringify row hash, ordered by UTF-16 code units with fixed-fan-in
 * external merge. The scratch is disposable and never grants recovery authority. */
export function logicalDatabaseHashIncremental(
  databasePath: string,
  checkpoint: () => void,
): string {
  const directory = mkdtempSync(join(tmpdir(), 'circus-portable-logical-'));
  const payloadPath = join(directory, 'payload');
  let payload!: number;
  let scratch!: DatabaseSync;
  let source!: DatabaseSync;
  let sourceFd!: number;
  let sourceStamp!: BigIntStats;
  try {
    payload = openSync(payloadPath, 'w+');
    scratch = new DatabaseSync(join(directory, 'runs.sqlite'));
    source = new DatabaseSync(databasePath, { readOnly: true });
    sourceFd = openSync(databasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    sourceStamp = fstatSync(sourceFd, { bigint: true });
  } catch (error) {
    if (sourceFd !== undefined) closeSync(sourceFd);
    source?.close();
    scratch?.close();
    if (payload !== undefined) closeSync(payload);
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const secret = randomBytes(32);
  let reader: ReturnType<typeof createIntakeCopyIncrementalReaderFromPortableBackup> | undefined;
  let end = 0;
  const sign = (text: string) => createHmac('sha256', secret).update(text).digest('hex');
  const check = (stamp?: BigIntStats) => {
    checkpoint();
    const sourceHeld = fstatSync(sourceFd, { bigint: true });
    const sourceNamed = lstatSync(databasePath, { bigint: true });
    if (
      sourceHeld.dev !== sourceStamp.dev ||
      sourceHeld.ino !== sourceStamp.ino ||
      sourceHeld.size !== sourceStamp.size ||
      sourceHeld.mtimeNs !== sourceStamp.mtimeNs ||
      sourceHeld.ctimeNs !== sourceStamp.ctimeNs ||
      sourceNamed.dev !== sourceHeld.dev ||
      sourceNamed.ino !== sourceHeld.ino ||
      sourceNamed.size !== sourceHeld.size ||
      sourceNamed.mtimeNs !== sourceHeld.mtimeNs ||
      sourceNamed.ctimeNs !== sourceHeld.ctimeNs ||
      !sourceNamed.isFile() ||
      sourceNamed.nlink !== 1n
    )
      throw Error('Portable logical source physical interval changed');
    if (!stamp) return;
    const held = fstatSync(payload, { bigint: true });
    const named = lstatSync(payloadPath, { bigint: true });
    if (
      held.dev !== stamp.dev ||
      held.ino !== stamp.ino ||
      held.size !== stamp.size ||
      held.mtimeNs !== stamp.mtimeNs ||
      held.ctimeNs !== stamp.ctimeNs ||
      named.dev !== held.dev ||
      named.ino !== held.ino ||
      named.size !== held.size ||
      named.mtimeNs !== held.mtimeNs ||
      named.ctimeNs !== held.ctimeNs
    )
      throw Error('Portable logical scratch physical interval changed');
  };
  const append = (chunks: Iterable<Buffer>): Bytes => {
    const offset = end;
    const hash = createHash('sha256');
    for (const chunk of chunks) {
      if (!Number.isSafeInteger(end + chunk.length))
        throw Error('Portable logical scratch address cannot be represented');
      for (let at = 0; at < chunk.length;) {
        const written = writeSync(payload, chunk, at, chunk.length - at, end + at);
        if (!written) throw Error('Portable logical scratch write stalled');
        at += written;
      }
      end += chunk.length;
      hash.update(chunk);
    }
    return { offset, bytes: end - offset, sha256: hash.digest('hex') };
  };
  const readHash = (where: Bytes, update?: (bytes: Buffer) => void): string => {
    const hash = createHash('sha256');
    for (let at = 0; at < where.bytes; at += CHUNK) {
      const part = exactRead(payload, where.offset + at, Math.min(CHUNK, where.bytes - at));
      hash.update(part);
      update?.(part);
    }
    return hash.digest('hex');
  };
  let rowStatement: ReturnType<DatabaseSync['prepare']>;
  const row = (id: bigint): Row => {
    const item = rowStatement.get(id);
    if (!item || item.id !== id) throw Error('Portable logical scratch row missing');
    const sort: Bytes = {
      offset: Number(item.sort_offset),
      bytes: Number(item.sort_bytes),
      sha256: String(item.sort_hash),
    };
    const value: Bytes = {
      offset: Number(item.value_offset),
      bytes: Number(item.value_bytes),
      sha256: String(item.value_hash),
    };
    for (const field of [sort, value])
      if (
        !Number.isSafeInteger(field.offset) ||
        !Number.isSafeInteger(field.bytes) ||
        field.offset < 0 ||
        field.bytes < 0 ||
        field.offset + field.bytes > end
      )
        throw Error('Portable logical scratch row address changed');
    const signature = sign(
      `${id}:${sort.offset}:${sort.bytes}:${sort.sha256}:${value.offset}:${value.bytes}:${value.sha256}`,
    );
    if (item.signature !== signature) throw Error('Portable logical scratch row signature changed');
    return { id, sort, value, signature };
  };
  const compare = (a: bigint, b: bigint): number => {
    const left = row(a).sort;
    const right = row(b).sort;
    let at = 0;
    while (at < Math.min(left.bytes, right.bytes)) {
      const size = Math.min(CHUNK, left.bytes - at, right.bytes - at);
      const difference = Buffer.compare(
        exactRead(payload, left.offset + at, size),
        exactRead(payload, right.offset + at, size),
      );
      if (difference) return difference;
      at += size;
    }
    return Math.sign(left.bytes - right.bytes);
  };
  const addRun = (level: number, run: number, ids: Iterable<bigint>) => {
    const insert = scratch.prepare('INSERT INTO runs(level,run,ordinal,rowid) VALUES(?,?,?,?)');
    const hash = createHmac('sha256', secret).update(`${level}:${run}:`);
    let count = 0;
    for (const id of ids) {
      insert.run(level, run, count, id);
      hash.update(`${count}:${id};`);
      count++;
    }
    scratch
      .prepare('INSERT INTO run_meta(level,run,count,signature) VALUES(?,?,?,?)')
      .run(level, run, count, hash.digest('hex'));
    return count;
  };
  const readRun = function* (level: number, run: number): Generator<bigint> {
    const meta = scratch
      .prepare('SELECT count,signature FROM run_meta WHERE level=? AND run=?')
      .get(level, run);
    if (!meta) throw Error('Portable logical scratch run missing');
    const selected = scratch.prepare(
      'SELECT ordinal,rowid FROM runs WHERE level=? AND run=? ORDER BY ordinal',
    );
    selected.setReadBigInts(true);
    const hash = createHmac('sha256', secret).update(`${level}:${run}:`);
    let count = 0;
    for (const item of selected.iterate(level, run)) {
      if (item.ordinal !== BigInt(count)) throw Error('Portable logical scratch run order changed');
      const id = item.rowid as bigint;
      hash.update(`${count}:${id};`);
      count++;
      yield id;
    }
    if (count !== meta.count || hash.digest('hex') !== meta.signature)
      throw Error('Portable logical scratch run signature changed');
  };
  try {
    check();
    reader = createIntakeCopyIncrementalReaderFromPortableBackup(source, checkpoint);
    scratch.exec('PRAGMA main.synchronous=OFF');
    scratch.exec(
      'CREATE TABLE rows(id INTEGER PRIMARY KEY,sort_offset INTEGER,sort_bytes INTEGER,sort_hash TEXT,value_offset INTEGER,value_bytes INTEGER,value_hash TEXT,signature TEXT);' +
        'CREATE TABLE runs(level INTEGER,run INTEGER,ordinal INTEGER,rowid INTEGER,PRIMARY KEY(level,run,ordinal));' +
        'CREATE TABLE run_meta(level INTEGER,run INTEGER,count INTEGER,signature TEXT,PRIMARY KEY(level,run));',
    );
    rowStatement = scratch.prepare(
      'SELECT id,sort_offset,sort_bytes,sort_hash,value_offset,value_bytes,value_hash,signature FROM rows WHERE id=?',
    );
    rowStatement.setReadBigInts(true);
    const insertRow = scratch.prepare(
      'INSERT INTO rows(sort_offset,sort_bytes,sort_hash,value_offset,value_bytes,value_hash,signature) VALUES(?,?,?,?,?,?,?)',
    );
    const updateSignature = scratch.prepare('UPDATE rows SET signature=? WHERE id=?');
    const result = createHash('sha256');
    for (const table of reader.tables()) {
      check();
      result.update(table + '\n');
      scratch.exec('DELETE FROM rows;DELETE FROM runs;DELETE FROM run_meta');
      ftruncateSync(payload, 0);
      end = 0;
      const names = reader.columns(table);
      let count = 0n;
      for (const sourceId of reader.rowIds(table)) {
        check();
        const pieces = () => reader!.rowPieces(table, sourceId, names, 'select');
        const sort = append(utf16Sort(pieces()));
        const value = append(utf8(pieces()));
        const inserted = insertRow.run(
          sort.offset,
          sort.bytes,
          sort.sha256,
          value.offset,
          value.bytes,
          value.sha256,
          '',
        );
        const id = BigInt(inserted.lastInsertRowid);
        if (id !== ++count || readHash(sort) !== sort.sha256 || readHash(value) !== value.sha256)
          throw Error('Portable logical scratch readback changed');
        updateSignature.run(
          sign(
            `${id}:${sort.offset}:${sort.bytes}:${sort.sha256}:${value.offset}:${value.bytes}:${value.sha256}`,
          ),
          id,
        );
      }
      // A callback during row generation cannot bless an earlier scratch edit.
      for (let id = 1n; id <= count; id++) {
        const selected = row(id);
        if (
          readHash(selected.sort) !== selected.sort.sha256 ||
          readHash(selected.value) !== selected.value.sha256
        )
          throw Error('Portable logical scratch generation changed');
      }
      const rowInventory = scratch.prepare(
        'SELECT COUNT(*) AS count,MIN(id) AS first,MAX(id) AS last FROM rows',
      );
      rowInventory.setReadBigInts(true);
      const inventory = rowInventory.get()!;
      if (
        inventory.count !== count ||
        (count > 0n && (inventory.first !== 1n || inventory.last !== count))
      )
        throw Error('Portable logical scratch row inventory changed');
      const stamp = fstatSync(payload, { bigint: true });
      check(stamp);
      let runs = 0;
      for (let first = 1n; first <= count; first += BigInt(FAN_IN)) {
        const ids: bigint[] = [];
        for (let id = first; id < first + BigInt(FAN_IN) && id <= count; id++) ids.push(id);
        ids.sort(compare);
        addRun(0, runs++, ids);
      }
      let level = 0;
      while (runs > 1) {
        check(stamp);
        for (let first = 0; first < runs; first += 2) {
          const left = readRun(level, first)[Symbol.iterator]();
          const right = first + 1 < runs ? readRun(level, first + 1)[Symbol.iterator]() : null;
          const merged = function* (): Generator<bigint> {
            let a = left.next(),
              b = right?.next() ?? { done: true as const, value: undefined };
            while (!a.done || !b.done) {
              if (a.done) {
                if (b.done) throw Error('Portable logical merge ended unexpectedly');
                yield b.value;
                b = right!.next();
              } else if (b.done || compare(a.value, b.value) <= 0) {
                yield a.value;
                a = left.next();
              } else {
                yield b.value;
                b = right!.next();
              }
            }
          };
          addRun(level + 1, Math.floor(first / 2), merged());
        }
        scratch.prepare('DELETE FROM runs WHERE level=?').run(level);
        scratch.prepare('DELETE FROM run_meta WHERE level=?').run(level);
        runs = Math.ceil(runs / 2);
        level++;
      }
      if (runs) {
        let visited = 0n;
        for (const id of readRun(level, 0)) {
          check(stamp);
          const selected = row(id);
          if (
            readHash(selected.sort) !== selected.sort.sha256 ||
            readHash(selected.value, (part) => result.update(part)) !== selected.value.sha256
          )
            throw Error('Portable logical sorted row changed');
          result.update('\n');
          visited++;
        }
        if (visited !== count) throw Error('Portable logical sorted inventory changed');
      }
      check(stamp);
    }
    check();
    return result.digest('hex');
  } finally {
    reader?.close();
    source.close();
    closeSync(sourceFd);
    scratch.close();
    closeSync(payload);
    secret.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
}
