/** Native SQLite transport for private copy snapshots and transfer files only.
 * This is a second SQLite library in the node process. POSIX locks are per
 * process, so it never shares lock state with node:sqlite: opened on a live
 * WAL database it would believe it is the only connection and could truncate
 * the -shm node:sqlite still maps (SIGBUS on the next COMMIT). Live profile
 * databases are read through node:sqlite only. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getEnvironmentData, isMainThread, setEnvironmentData } from 'node:worker_threads';

type Pointer = Buffer;
type PointerSlot = Buffer & { deref(): Pointer };
type NativeFunctions = {
  sqlite3_open_v2(path: string, out: PointerSlot, flags: number, vfs: Pointer): number;
  sqlite3_close_v2(db: Pointer): number;
  sqlite3_exec(
    db: Pointer,
    sql: string,
    callback: Pointer,
    context: Pointer,
    error: Pointer,
  ): number;
  sqlite3_blob_open(
    db: Pointer,
    schema: string,
    table: string,
    column: string,
    rowid: string,
    flags: number,
    out: PointerSlot,
  ): number;
  sqlite3_blob_bytes(blob: Pointer): number;
  sqlite3_blob_read(blob: Pointer, buffer: Buffer, bytes: number, offset: number): number;
  sqlite3_blob_write(blob: Pointer, buffer: Buffer, bytes: number, offset: number): number;
  sqlite3_blob_close(blob: Pointer): number;
};
type Ffi = {
  Library(path: string, declarations: Record<string, [string, string[]]>): NativeFunctions;
};
type Ref = {
  alloc(type: 'pointer'): PointerSlot;
  NULL: Pointer;
  isNull(pointer: Pointer): boolean;
};

const require = createRequire(import.meta.url);
// This stamp orders addon lifetime across workers; it is not copy authority.
const workerReadyKey = 'circus-health:intake-copy-native-sqlite:main-ready:v1';
let cached: ReturnType<typeof createNative> | undefined;

export function intakeCopyNativeSqlite() {
  if (!cached) {
    cached = createNative();
    if (isMainThread) setEnvironmentData(workerReadyKey, true);
  }
  return cached;
}

function createNative() {
  if (!isMainThread && getEnvironmentData(workerReadyKey) !== true)
    throw Error('Incremental copy native worker requires main-thread initialization');
  const library =
    process.platform === 'darwin'
      ? '/usr/lib/libsqlite3.dylib'
      : process.platform === 'linux'
        ? 'libsqlite3.so.0'
        : undefined;
  if (!library) throw Error('Incremental copy transport requires macOS or Linux SQLite');
  let ffi: Ffi;
  let ref: Ref;
  let native: NativeFunctions;
  try {
    ffi = require('@napi-ffi/ffi-napi') as Ffi;
    ref = require('@napi-ffi/ref-napi') as Ref;
    native = ffi.Library(library, {
      sqlite3_open_v2: ['int', ['string', 'pointer', 'int', 'pointer']],
      sqlite3_close_v2: ['int', ['pointer']],
      sqlite3_exec: ['int', ['pointer', 'string', 'pointer', 'pointer', 'pointer']],
      sqlite3_blob_open: [
        'int',
        ['pointer', 'string', 'string', 'string', 'int64', 'int', 'pointer'],
      ],
      sqlite3_blob_bytes: ['int', ['pointer']],
      sqlite3_blob_read: ['int', ['pointer', 'pointer', 'int', 'int']],
      sqlite3_blob_write: ['int', ['pointer', 'pointer', 'int', 'int']],
      sqlite3_blob_close: ['int', ['pointer']],
    });
  } catch {
    throw Error(`Incremental copy transport requires ${library} and N-API FFI`);
  }
  const output = (pointer: unknown[], call: (slot: PointerSlot) => number): number => {
    const slot = ref.alloc('pointer');
    const code = call(slot);
    const value = slot.deref();
    pointer[0] = ref.isNull(value) ? null : value;
    return code;
  };
  // A fence, not authority: callers still own their private-file identity proofs.
  const privateTarget = (path: string, flags: number) => {
    if (path.startsWith('file:')) {
      // Only an immutable read-only descriptor alias: SQLite takes no locks
      // and opens no WAL or -shm for it.
      if (!/^file:\/(?:dev|proc\/self)\/fd\/\d+\?immutable=1$/.test(path) || flags & 0x2)
        throw Error('Native SQLite transport requires an immutable private alias');
      return;
    }
    // node:sqlite keeps a -shm beside every WAL database it has open.
    if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`))
      throw Error('Native SQLite transport refuses a WAL database');
  };
  const rowidText = (rowid: bigint | number): string => {
    if (typeof rowid === 'number' && !Number.isSafeInteger(rowid))
      throw Error('Incremental copy rowid is not exact');
    const value = BigInt(rowid);
    if (value < -(1n << 63n) || value >= 1n << 63n)
      throw Error('Incremental copy rowid is outside SQLite int64');
    return value.toString();
  };
  return {
    open: (path: string, pointer: unknown[], flags: number, vfs: string | null) => {
      if (vfs !== null) throw Error('Incremental copy custom SQLite VFS is unsupported');
      privateTarget(path, flags);
      return output(pointer, (slot) => native.sqlite3_open_v2(path, slot, flags, ref.NULL));
    },
    close: (db: unknown) => native.sqlite3_close_v2(db as Pointer),
    beginRead: (db: unknown) =>
      native.sqlite3_exec(
        db as Pointer,
        'BEGIN; SELECT name FROM sqlite_master LIMIT 1',
        ref.NULL,
        ref.NULL,
        ref.NULL,
      ),
    openDisposableTransfer: (path: string, pointer: unknown[]) => {
      privateTarget(path, 0x2);
      const opened = output(pointer, (slot) => native.sqlite3_open_v2(path, slot, 0x2, ref.NULL));
      if (opened !== 0 || !pointer[0]) return opened;
      const configured = native.sqlite3_exec(
        pointer[0] as Pointer,
        'PRAGMA main.synchronous=OFF',
        ref.NULL,
        ref.NULL,
        ref.NULL,
      );
      if (configured !== 0) {
        native.sqlite3_close_v2(pointer[0] as Pointer);
        pointer[0] = null;
      }
      return configured;
    },
    blobOpen: (
      db: unknown,
      schema: string,
      table: string,
      column: string,
      rowid: bigint | number,
      flags: number,
      pointer: unknown[],
    ) =>
      output(pointer, (slot) =>
        native.sqlite3_blob_open(
          db as Pointer,
          schema,
          table,
          column,
          rowidText(rowid),
          flags,
          slot,
        ),
      ),
    blobBytes: (blob: unknown) => native.sqlite3_blob_bytes(blob as Pointer),
    blobRead: (blob: unknown, buffer: Buffer, bytes: number, offset: number) =>
      native.sqlite3_blob_read(blob as Pointer, buffer, bytes, offset),
    blobWrite: (blob: unknown, buffer: Buffer, bytes: number, offset: number) =>
      native.sqlite3_blob_write(blob as Pointer, buffer, bytes, offset),
    blobClose: (blob: unknown) => native.sqlite3_blob_close(blob as Pointer),
  };
}
