/** Bounded transport for committed columns in the managed SQLite file.
 * Its read snapshot is disposable; the caller must supply the original
 * authority, method, write, and physical checks at every checkpoint.
 *
 * The snapshot is a second node:sqlite connection. No other SQLite library
 * and no raw descriptor may open the live file, WAL or -shm in this process:
 * POSIX locks are per process, so a second library copy would believe it is
 * the only connection (and could truncate the -shm that node:sqlite still
 * maps), and closing any raw descriptor drops node:sqlite's own locks.
 *
 * node:sqlite has no incremental BLOB API. Each value is therefore loaded
 * once, whole, inside SQLite by an uncorrelated scalar subquery and sliced
 * into bounded host pieces from that one register. Host pieces stay bounded;
 * SQLite's own materialization of the value does not. */
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';

const CHUNK = 16 * 1024;
const nativeLocation = DatabaseSync.prototype.location;
const nativePrepare = DatabaseSync.prototype.prepare;
const nativeExec = DatabaseSync.prototype.exec;
const nativeClose = DatabaseSync.prototype.close;
const nativeGet = StatementSync.prototype.get;
const nativeIterate = StatementSync.prototype.iterate;

function managedGet(db: DatabaseSync, sql: string, ...args: (string | bigint | number)[]) {
  return Reflect.apply(nativeGet, Reflect.apply(nativePrepare, db, [sql]), args) as
    Record<string, unknown> | undefined;
}

function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value))
    throw Error('Committed column identifier unavailable');
  return `"${value}"`;
}

type Identity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

function identity(path: string): Identity | undefined {
  try {
    const value = lstatSync(path, { bigint: true });
    if (!value.isFile()) throw Error('Committed column path is not a regular file');
    return {
      dev: value.dev,
      ino: value.ino,
      size: value.size,
      mtimeNs: value.mtimeNs,
      ctimeNs: value.ctimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function same(a: Identity | undefined, b: Identity | undefined): boolean {
  return a === undefined
    ? b === undefined
    : b !== undefined &&
        a.dev === b.dev &&
        a.ino === b.ino &&
        a.size === b.size &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs;
}

function changedIdentityFields(a: Identity | undefined, b: Identity | undefined): string {
  if (!a || !b) return 'presence';
  return (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const)
    .filter((field) => a[field] !== b[field])
    .join(',');
}

const shmTimestampRefusalBrand = Symbol('committed-column-shm-timestamp-refusal');
export function committedColumnShmTimestampRefusal(message: string): Error {
  return Object.assign(Error(message), { [shmTimestampRefusalBrand]: true });
}
export function isCommittedColumnShmTimestampRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { [shmTimestampRefusalBrand]?: boolean })[shmTimestampRefusalBrand] === true
  );
}

export interface RecordCommittedColumnReader {
  byteLength(table: string, column: string, rowid: bigint): number;
  bytes(table: string, column: string, rowid: bigint): Iterable<Uint8Array>;
  text(table: string, column: string, rowid: bigint): Iterable<string>;
  work(): Readonly<{ chunks: number; bytes: number; maxChunk: number }>;
  close(): void;
}

/** Only a committed original row can be read: never use this on a tentative
 * managed-connection write or as evidence in place of an accepted version. */
export function openRecordCommittedColumnReader(
  db: DatabaseSync,
  checkpoint: (phase?: 'after-open') => void,
): RecordCommittedColumnReader {
  checkpoint();
  if (db.isTransaction) throw Error('Committed column reader requires an idle managed database');
  const path = Reflect.apply(nativeLocation, db, []) as string | null;
  if (typeof path !== 'string' || !path) throw Error('Committed column reader requires a file');
  checkpoint();
  const encoding = managedGet(db, 'PRAGMA encoding')?.encoding;
  if (encoding !== 'UTF-8' && encoding !== 'UTF-16le' && encoding !== 'UTF-16be')
    throw Error('Committed column encoding unavailable');
  let snapshot: DatabaseSync | undefined;
  let closed = false;
  const pending = new Set<Iterator<unknown>>();
  let chunks = 0;
  let bytesRead = 0;
  let maxChunk = 0;
  try {
    const main = identity(path);
    if (!main) throw Error('Committed column main file changed before open');
    const openingWal = identity(`${path}-wal`);
    // The same library as the managed connection, so in-process lock state is shared.
    snapshot = new DatabaseSync(path, { readOnly: true });
    const reader = snapshot;
    Reflect.apply(nativeExec, reader, ['BEGIN']);
    managedGet(reader, 'SELECT name FROM sqlite_master LIMIT 1');
    if (managedGet(reader, 'PRAGMA encoding')?.encoding !== encoding)
      throw Error('Committed column snapshot encoding differs');
    checkpoint('after-open');
    const openedMain = identity(path),
      openedWal = identity(`${path}-wal`);
    if (!same(main, openedMain) || !same(openingWal, openedWal))
      throw Error(
        'Committed column opening file changed (database:' +
          changedIdentityFields(main, openedMain) +
          '; WAL:' +
          changedIdentityFields(openingWal, openedWal) +
          ')',
      );
    const wal = identity(`${path}-wal`);
    const shm = identity(`${path}-shm`);
    const check = () => {
      if (closed) throw Error('Committed column reader closed');
      checkpoint();
      if (db.isTransaction)
        throw Error('Committed column reader requires an idle managed database');
      const nowMain = identity(path);
      if (!same(main, nowMain))
        throw Error(
          'Committed column file identity changed (database: ' +
            changedIdentityFields(main, nowMain) +
            ')',
        );
      const nowWal = identity(`${path}-wal`);
      if (!same(wal, nowWal))
        throw Error(
          'Committed column file identity changed (WAL: ' +
            changedIdentityFields(wal, nowWal) +
            ')',
        );
      const nowShm = identity(`${path}-shm`);
      if (!same(shm, nowShm)) {
        const message =
          'Committed column file identity changed (shared-memory index: ' +
          changedIdentityFields(shm, nowShm) +
          ')';
        if (
          shm &&
          nowShm &&
          shm.dev === nowShm.dev &&
          shm.ino === nowShm.ino &&
          shm.size === nowShm.size
        )
          throw committedColumnShmTimestampRefusal(message);
        throw Error(message);
      }
    };
    check();
    // Compiling the exact column through the managed connection preserves its
    // installed authorizer policy before the snapshot transport reads it.
    const admitted = (table: string, column: string, rowid: bigint) => {
      const tableName = identifier(table);
      const columnName = identifier(column);
      check();
      Reflect.apply(nativePrepare, db, [`SELECT ${columnName} FROM main.${tableName} LIMIT 0`]);
      const type = managedGet(
        db,
        `SELECT typeof(${columnName}) AS type FROM main.${tableName} WHERE rowid=?`,
        rowid,
      )?.type;
      if (type !== 'text' && type !== 'blob') throw Error('Committed column is not TEXT or BLOB');
      check();
      const facts = managedGet(
        reader,
        `SELECT typeof(${columnName}) AS type,octet_length(${columnName}) AS length
         FROM main.${tableName} WHERE rowid=?`,
        rowid,
      );
      if (facts?.type !== type) throw Error('Committed column snapshot type differs');
      const length = facts.length;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
        throw Error('Committed column length unavailable');
      check();
      return { tableName, columnName, length };
    };
    const bytes = function* (table: string, column: string, rowid: bigint): Generator<Uint8Array> {
      const { tableName, columnName, length } = admitted(table, column, rowid);
      if (!length) return;
      // The uncorrelated subquery runs once per statement (OP_Once), so SQLite
      // loads the value once and every row slices that one register.
      const statement = Reflect.apply(nativePrepare, reader, [
        `WITH RECURSIVE piece(offset) AS (
           SELECT 1 UNION ALL SELECT offset+${CHUNK} FROM piece WHERE offset+${CHUNK}<=?
         )
         SELECT substr((SELECT CAST(${columnName} AS BLOB) FROM main.${tableName} WHERE rowid=?),
           offset,${CHUNK}) AS value
         FROM piece`,
      ]) as StatementSync;
      const rows = Reflect.apply(nativeIterate, statement, [length, rowid]) as Iterator<
        Record<string, unknown>
      >;
      pending.add(rows);
      try {
        for (let offset = 0; offset < length;) {
          check();
          const size = Math.min(CHUNK, length - offset);
          const row = rows.next();
          const value = row.done ? undefined : row.value.value;
          if (!(value instanceof Uint8Array) || value.byteLength !== size)
            throw Error('Committed column read failed');
          offset += size;
          chunks++;
          bytesRead += size;
          maxChunk = Math.max(maxChunk, size);
          yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        }
        check();
        if (!rows.next().done) throw Error('Committed column read failed');
      } finally {
        if (pending.delete(rows)) rows.return?.();
        if (!closed) check();
      }
    };
    const byteLength = (table: string, column: string, rowid: bigint): number =>
      admitted(table, column, rowid).length;
    const text = function* (table: string, column: string, rowid: bigint): Generator<string> {
      const tableName = identifier(table);
      const columnName = identifier(column);
      check();
      const type = managedGet(
        db,
        `SELECT typeof(${columnName}) AS type FROM main.${tableName} WHERE rowid=?`,
        rowid,
      )?.type;
      if (type !== 'text') throw Error('Committed column is not TEXT');
      const decoder = new TextDecoder(
        encoding === 'UTF-8' ? 'utf-8' : encoding === 'UTF-16le' ? 'utf-16le' : 'utf-16be',
        { fatal: true, ignoreBOM: true },
      );
      for (const piece of bytes(table, column, rowid)) {
        const value = decoder.decode(piece, { stream: true });
        if (value) yield value;
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    };
    return {
      byteLength,
      bytes,
      text,
      work: () => ({ chunks, bytes: bytesRead, maxChunk }),
      close() {
        if (closed) return;
        closed = true;
        let failure: unknown;
        for (const rows of pending) {
          pending.delete(rows);
          try {
            rows.return?.();
          } catch (error) {
            failure ??= error;
          }
        }
        try {
          Reflect.apply(nativeClose, reader, []);
        } catch {
          failure ??= Error('Committed column SQLite close failed');
        }
        if (failure) throw failure;
      },
    };
  } catch (error) {
    closed = true;
    if (snapshot?.isOpen) Reflect.apply(nativeClose, snapshot, []);
    throw error;
  }
}
