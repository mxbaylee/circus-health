/** Disposable, inode-pinned SQLite transport for copy comparison. The managed
 * database and its retained read interval, never this backup, are authority. */
import { backup, DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intakeCopyTextPieces } from './intake-copy-json.ts';
import { intakeCopyNativeSqlite } from './intake-copy-native-sqlite.ts';
import { intakeCopyNativeSelect } from './intake-copy-work.ts';
import { HttpError } from './database.ts';

const CHUNK = 16 * 1024;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** One row's storage classes and bounded values, in table column order. A
 * column with a default still uses blob_open so virtual ALTER defaults retain
 * their existing refusal/verification behavior. */
function rowCellsSql(
  table: string,
  names: readonly string[],
  rowid: string,
  inline: ReadonlySet<string>,
): string {
  const limit = Math.floor(CHUNK / names.length);
  // Direct-column octet_length checks the stored byte count before CAST can
  // materialize a value; every row's inlined cells total at most one chunk.
  return `SELECT ${names
    .map((name, index) => {
      const column = quote(name);
      return `typeof(${column}) AS t${index}, CASE WHEN typeof(${column}) IN ('integer','real','null') THEN ${column}${inline.has(name) ? ` WHEN typeof(${column}) IN ('text','blob') AND octet_length(${column})<=${limit} THEN CAST(${column} AS BLOB)` : ''} END AS v${index}`;
    })
    .join(', ')} FROM main.${quote(table)} WHERE ${rowid}=?`;
}

export type IntakeCopyIncrementalWork = Readonly<{
  pages: number;
  chunks: number;
  bytes: number;
  maxChunk: number;
}>;

export interface IntakeCopyIncrementalReader {
  tables(): readonly string[];
  columns(table: string): readonly string[];
  rowIds(table: string): Iterable<bigint>;
  rowIdsLike(table: 'app_meta', column: 'key', pattern: string): Iterable<bigint>;
  rowPieces(
    table: string,
    rowid: bigint,
    columns: readonly string[],
    order?: 'sorted' | 'select',
  ): Iterable<string>;
  textPieces(table: string, column: string, rowid: bigint): Iterable<string>;
  columnType(table: string, column: string, rowid: bigint): string;
  bookkeepingKey(rowid: bigint): boolean;
  validateSourceTextInWorker(
    profileId: string,
    signal?: AbortSignal,
    onProgress?: () => void,
  ): Promise<void>;
  work(): IntakeCopyIncrementalWork;
  close(): void;
}

function* nativeColumnPieces(
  native: ReturnType<typeof intakeCopyNativeSqlite>,
  handle: unknown,
  table: string,
  column: string,
  rowid: bigint,
  identity: () => void,
  record: (bytes: number) => void,
): Generator<Uint8Array> {
  identity();
  const pointer: unknown[] = [null];
  const code = native.blobOpen(handle, 'main', table, column, rowid, 0, pointer);
  if (code !== 0 || !pointer[0]) throw new ColumnOpenError(code);
  const blob = pointer[0];
  try {
    const length = native.blobBytes(blob) as number;
    if (length < 0) throw Error('Incremental copy column length failed');
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (let offset = 0; offset < length;) {
      identity();
      const size = Math.min(CHUNK, length - offset);
      const read = native.blobRead(blob, buffer, size, offset);
      if (read !== 0) throw Error(`Incremental copy column read failed (${read})`);
      record(size);
      offset += size;
      yield buffer.subarray(0, size);
    }
  } finally {
    if (native.blobClose(blob) !== 0) throw Error('Incremental copy column close failed');
    identity();
  }
}

class ColumnOpenError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`Incremental copy column open failed (${code})`);
    this.code = code;
  }
}

function verifiedVirtualTextDefault(
  snapshot: DatabaseSync,
  identity: () => void,
  table: string,
  column: string,
  rowid: bigint,
  rowidAlias: string,
  encoding: number,
  error: unknown,
): Buffer {
  // These historical ALTER TABLE defaults can be visible without a stored cell.
  const virtualDefault =
    table === 'notes' && column === 'text_formats_json'
      ? '{}'
      : table === 'procedures' && column === 'category'
        ? 'unspecified'
        : undefined;
  if (!(error instanceof ColumnOpenError) || error.code !== 1 || !virtualDefault) throw error;
  const literal = Buffer.from(virtualDefault, encoding === 1 ? 'utf8' : 'utf16le');
  if (encoding === 3) literal.swap16();
  identity();
  const value = intakeCopyNativeSelect(
    snapshot,
    `SELECT CASE WHEN typeof(${quote(column)})='text' AND CAST(${quote(column)} AS BLOB) IS ? AND length(CAST(${quote(column)} AS BLOB))=? THEN 1 ELSE 0 END AS exact FROM main.${quote(table)} WHERE ${rowidAlias}=?`,
    identity,
  ).get(literal, literal.length, rowid);
  identity();
  if (value?.exact !== 1) throw error;
  return literal;
}

function* decodedTextPieces(pieces: Iterable<Uint8Array>, encoding: number): Generator<string> {
  const decoder = new TextDecoder(
    encoding === 1 ? 'utf-8' : encoding === 2 ? 'utf-16le' : 'utf-16be',
    { fatal: true, ignoreBOM: true },
  );
  for (const piece of pieces) {
    const text = decoder.decode(piece, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/** Backup is complete before any second connection opens it. The held fd and
 * path identity are checked on every read, including after callback yields. */
export async function createIntakeCopyIncrementalReader(
  source: DatabaseSync,
  checkpoint: () => void,
): Promise<IntakeCopyIncrementalReader> {
  const native = intakeCopyNativeSqlite();
  checkpoint();
  const directory = mkdtempSync(join(tmpdir(), 'health-copy-columns-'));
  const path = join(directory, 'snapshot.sqlite');
  let fd: number | undefined;
  let sql: DatabaseSync | undefined;
  let handle: unknown;
  let closed = false;
  let pages = 0,
    chunks = 0,
    bytes = 0,
    maxChunk = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      sql?.close();
    } finally {
      try {
        if (handle) native.close(handle);
      } finally {
        try {
          if (fd !== undefined) closeSync(fd);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  };
  try {
    chmodSync(directory, 0o700);
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const pinned = fstatSync(fd);
    pages = await backup(source, path, { rate: 32, progress: checkpoint });
    checkpoint();
    const filled = fstatSync(fd);
    if (filled.dev !== pinned.dev || filled.ino !== pinned.ino || !filled.size)
      throw Error('Incremental copy backup changed destination identity');
    const normalized = new DatabaseSync(path);
    try {
      normalized.prepare('PRAGMA journal_mode=DELETE').get();
    } finally {
      normalized.close();
    }
    checkpoint();
    if ([`${path}-wal`, `${path}-shm`, `${path}-journal`].some(existsSync))
      throw Error('Incremental copy snapshot retained SQLite sidecars');
    const sealed = fstatSync(fd, { bigint: true });
    const identity = () => {
      checkpoint();
      const held = fstatSync(fd!, { bigint: true }),
        named = lstatSync(path, { bigint: true });
      if (
        held.dev !== sealed.dev ||
        held.ino !== sealed.ino ||
        named.dev !== sealed.dev ||
        named.ino !== sealed.ino ||
        !held.isFile() ||
        !named.isFile() ||
        held.size !== sealed.size ||
        named.size !== sealed.size ||
        held.mtimeNs !== sealed.mtimeNs ||
        named.mtimeNs !== sealed.mtimeNs ||
        held.ctimeNs !== sealed.ctimeNs ||
        named.ctimeNs !== sealed.ctimeNs
      )
        throw Error('Incremental copy snapshot identity changed');
    };
    identity();
    const header = Buffer.alloc(100);
    if (
      readSync(fd, header, 0, 100, 0) !== 100 ||
      header.toString('ascii', 0, 16) !== 'SQLite format 3\0' ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      throw Error('Incremental copy snapshot is not standalone SQLite');
    const encoding = header.readUInt32BE(56);
    if (encoding < 1 || encoding > 3)
      throw Error('Incremental copy snapshot has unsupported text encoding');
    const alias = process.platform === 'darwin' ? `/dev/fd/${fd}` : `/proc/self/fd/${fd}`;
    const pointer: unknown[] = [null];
    const result = native.open(`file:${alias}?immutable=1`, pointer, 0x1 | 0x40, null);
    handle = pointer[0];
    if (result !== 0 || !handle) throw Error(`Incremental copy SQLite open failed (${result})`);
    sql = new DatabaseSync(path, { readOnly: true });
    const snapshot = sql;
    // Each caller enters intakeCopyNativeSelect with identity pre/post prepare;
    // this closes the actual row read.
    const checked = <T>(read: () => T): T => {
      const result = read();
      identity();
      return result;
    };
    const raw = function* (table: string, column: string, rowid: bigint): Generator<Uint8Array> {
      try {
        yield* nativeColumnPieces(native, handle, table, column, rowid, identity, (size) => {
          chunks++;
          bytes += size;
          maxChunk = Math.max(maxChunk, size);
        });
      } catch (error) {
        if (!(error instanceof ColumnOpenError)) throw error;
        columns(table);
        const literal = verifiedVirtualTextDefault(
          snapshot,
          identity,
          table,
          column,
          rowid,
          schema.get(table)!.rowid,
          encoding,
          error,
        );
        chunks++;
        bytes += literal.length;
        maxChunk = Math.max(maxChunk, literal.length);
        yield literal;
        identity();
      }
    };
    const textPieces = function* (table: string, column: string, rowid: bigint): Generator<string> {
      if (!columns(table).includes(column) || typeOf(table, column, rowid) !== 'text')
        throw Error('Incremental copy TEXT column changed');
      yield* decodedTextPieces(raw(table, column, rowid), encoding);
    };
    const schema = new Map<string, { columns: string[]; rowid: string; inline: Set<string> }>();
    const columns = (table: string) => {
      let known = schema.get(table);
      if (known) return known.columns;
      const kinds = checked(() =>
        intakeCopyNativeSelect(
          snapshot,
          "SELECT name,hidden,dflt_value FROM pragma_table_xinfo(?,'main') ORDER BY cid",
          identity,
        ).all(table),
      );
      const definition = 'SELECT type,sql FROM main.sqlite_schema WHERE name=?';
      const original = intakeCopyNativeSelect(source, definition, checkpoint).get(table);
      const copied = checked(() =>
        intakeCopyNativeSelect(snapshot, definition, identity).get(table),
      );
      if (
        original?.type !== 'table' ||
        typeof original.sql !== 'string' ||
        original.sql !== copied?.sql ||
        copied.type !== 'table'
      )
        throw Error('Incremental copy snapshot table definition changed');
      const tableInfo = checked(() =>
        intakeCopyNativeSelect(
          snapshot,
          "SELECT wr,type FROM pragma_table_list WHERE schema='main' AND name=?",
          identity,
        ).get(table),
      );
      if (
        !tableInfo ||
        tableInfo.wr !== 0 ||
        tableInfo.type !== 'table' ||
        kinds.length === 0 ||
        kinds.some((row) => row.hidden !== 0)
      )
        throw Error('Incremental copy requires ordinary rowid table');
      const names = kinds.map((row) => String(row.name));
      const rowid = ['rowid', '_rowid_', 'oid'].find(
        (candidate) => !names.some((name) => name.toLowerCase() === candidate),
      );
      if (!rowid) throw Error('Incremental copy table shadows all rowid aliases');
      intakeCopyNativeSelect(source, `SELECT * FROM main.${quote(table)} LIMIT 0`, checkpoint);
      for (const column of names)
        intakeCopyNativeSelect(
          source,
          `SELECT ${quote(column)} FROM main.${quote(table)} LIMIT 0`,
          checkpoint,
        );
      intakeCopyNativeSelect(
        source,
        `SELECT ${rowid} FROM main.${quote(table)} LIMIT 0`,
        checkpoint,
      );
      known = {
        columns: names,
        rowid,
        inline: new Set(
          kinds.filter((row) => row.dflt_value === null).map((row) => String(row.name)),
        ),
      };
      schema.set(table, known);
      return names;
    };
    const rowIds = function* (table: string): Generator<bigint> {
      columns(table);
      const alias = schema.get(table)!.rowid;
      const statement = checked(() =>
        intakeCopyNativeSelect(
          snapshot,
          `SELECT CAST(${alias} AS TEXT) AS id FROM main.${quote(table)}`,
          identity,
        ),
      );
      for (const row of statement.iterate()) {
        identity();
        const id = BigInt(String(row.id));
        yield id;
      }
    };
    const rowIdsLike = function* (
      table: 'app_meta',
      column: 'key',
      pattern: string,
    ): Generator<bigint> {
      if (table !== 'app_meta' || column !== 'key' || typeof pattern !== 'string')
        throw Error('Incremental copy LIKE scope changed');
      columns(table);
      const alias = schema.get(table)!.rowid;
      const statement = checked(() =>
        intakeCopyNativeSelect(
          snapshot,
          `SELECT CAST(${alias} AS TEXT) AS id FROM main.${quote(table)} WHERE ${quote(column)} LIKE ?`,
          identity,
        ),
      );
      try {
        for (const row of statement.iterate(pattern)) {
          identity();
          yield BigInt(String(row.id));
        }
      } finally {
        identity();
      }
    };
    const typeStatements = new Map<
      string,
      Map<string, ReturnType<typeof intakeCopyNativeSelect>>
    >();
    const typeOf = (table: string, column: string, rowid: bigint) => {
      if (!columns(table).includes(column)) throw Error('Incremental copy column unavailable');
      let statements = typeStatements.get(table);
      if (!statements) typeStatements.set(table, (statements = new Map()));
      let statement = statements.get(column);
      if (!statement) {
        statement = intakeCopyNativeSelect(
          snapshot,
          `SELECT typeof(${quote(column)}) AS type FROM main.${quote(table)} WHERE ${schema.get(table)!.rowid}=?`,
          identity,
        );
        statements.set(column, statement);
      }
      identity();
      return String(checked(() => statement.get(rowid))?.type);
    };
    const rowStatements = new Map<string, ReturnType<typeof intakeCopyNativeSelect>>();
    // A row read is one bracketed native statement instead of one per column.
    const rowCells = (table: string, rowid: bigint) => {
      const names = columns(table);
      let statement = rowStatements.get(table);
      if (!statement) {
        statement = intakeCopyNativeSelect(
          snapshot,
          rowCellsSql(table, names, schema.get(table)!.rowid, schema.get(table)!.inline),
          identity,
        );
        rowStatements.set(table, statement);
      }
      identity();
      return checked(() => statement.get(rowid));
    };
    const bookkeepingKey = (rowid: bigint) => {
      columns('app_meta');
      if (typeOf('app_meta', 'key', rowid) !== 'text') return false;
      // The longest discriminator is a 24-character prefix, in the database's
      // own TEXT encoding. No full key is retained or decoded.
      const iterator = textPieces('app_meta', 'key', rowid)[Symbol.iterator]();
      let prefix = '';
      try {
        const first = iterator.next();
        if (!first.done) prefix = first.value.slice(0, 24);
      } finally {
        iterator.return?.(undefined);
      }
      return (
        (prefix.startsWith('personal_') &&
          !prefix.startsWith('personal_assistant_') &&
          !prefix.startsWith('personal_restore_')) ||
        prefix === 'curation_revision'
      );
    };
    const rowPieces = function* (
      table: string,
      rowid: bigint,
      names: readonly string[],
      order: 'sorted' | 'select' = 'sorted',
    ): Generator<string> {
      if (JSON.stringify(names) !== JSON.stringify(columns(table)))
        throw Error('Incremental copy row column inventory changed');
      if (order !== 'sorted' && order !== 'select')
        throw Error('Incremental copy row order changed');
      const ordered = Object.keys(
        Object.fromEntries(
          (order === 'sorted' ? [...names].sort() : names).map((name) => [name, 0]),
        ),
      );
      const position = new Map(names.map((name, index) => [name, index]));
      const cells = rowCells(table, rowid);
      const inline = schema.get(table)!.inline;
      const limit = Math.floor(CHUNK / names.length);
      const bytesFor = function* (column: string, at: number): Generator<Uint8Array> {
        const value = cells?.[`v${at}`];
        if (!inline.has(column) || !(value instanceof Uint8Array)) {
          yield* raw(table, column, rowid);
          return;
        }
        if (value.byteLength > limit) throw Error('Incremental copy inline column bound changed');
        identity();
        try {
          if (value.byteLength) {
            chunks++;
            bytes += value.byteLength;
            maxChunk = Math.max(maxChunk, value.byteLength);
            yield value;
          }
        } finally {
          identity();
        }
      };
      try {
        yield '{';
        for (let index = 0; index < ordered.length; index++) {
          const column = ordered[index]!;
          if (index) yield ',';
          yield JSON.stringify(column) + ':';
          // Each resumed field step re-proves the pinned file, as the per-column
          // reads did; the row's cells were read under the same identity.
          identity();
          const at = position.get(column)!;
          const kind = cells?.[`t${at}`];
          if (kind === 'text') {
            yield '"';
            for (const piece of decodedTextPieces(bytesFor(column, at), encoding))
              for (const part of intakeCopyTextPieces(piece))
                yield JSON.stringify(part).slice(1, -1);
            yield '"';
          } else if (kind === 'blob') {
            yield '{';
            let n = 0;
            for (const piece of bytesFor(column, at))
              for (let at = 0; at < piece.length; at += 512) {
                const entries: string[] = [];
                for (const value of piece.subarray(at, at + 512))
                  entries.push(`${n ? ',' : ''}"${n++}":${value}`);
                yield entries.join('');
              }
            yield '}';
          } else if (kind === 'null' || kind === 'integer' || kind === 'real') {
            const encoded = JSON.stringify(cells![`v${at}`]);
            if (encoded === undefined) throw Error('Incremental copy scalar cannot be encoded');
            yield encoded;
          } else throw Error('Incremental copy column type changed');
        }
        yield '}';
      } finally {
        identity();
      }
    };
    return {
      tables: () =>
        checked(() =>
          intakeCopyNativeSelect(
            snapshot,
            "SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name",
            identity,
          )
            .all()
            .map((row) => String(row.name)),
        ),
      columns,
      rowIds,
      rowIdsLike,
      rowPieces,
      textPieces,
      columnType: typeOf,
      bookkeepingKey,
      async validateSourceTextInWorker(profileId, signal, onProgress) {
        columns('app_meta');
        columns('source_files');
        identity();
        signal?.throwIfAborted();
        const worker = new Worker(
          new URL('./intake-source-text-copy-validation-worker.ts', import.meta.url),
          { workerData: { path, profileId } },
        );
        await new Promise<void>((resolve, reject) => {
          let finished = false;
          let ready = false;
          let started = false;
          let pendingStop: unknown;
          const abort = () =>
            finish(signal?.reason ?? new DOMException('Copy cancelled', 'AbortError'));
          const finish = (error?: unknown) => {
            if (finished) return;
            if (!ready) {
              pendingStop = error ?? Error('Source-text copy worker stopped before ready');
              return;
            }
            finished = true;
            signal?.removeEventListener('abort', abort);
            void worker.terminate().then(
              () => {
                try {
                  identity();
                  if (error) reject(error);
                  else resolve();
                } catch (cause) {
                  reject(cause);
                }
              },
              (cause) => reject(error ?? cause),
            );
          };
          worker.on(
            'message',
            (message: {
              ready?: true;
              progress?: true;
              complete?: true;
              failure?: { status?: number; code?: string; message?: string };
            }) => {
              try {
                if (message.ready) {
                  if (ready || started) throw Error('Source-text copy worker protocol changed');
                  ready = true;
                  if (pendingStop) finish(pendingStop);
                  else if (signal?.aborted) abort();
                  else {
                    identity();
                    started = true;
                    worker.postMessage({ start: true });
                  }
                } else if (!ready || !started) {
                  finish(Error('Source-text copy worker protocol changed'));
                } else if (message.progress) {
                  identity();
                  onProgress?.();
                  identity();
                  if (signal?.aborted) abort();
                } else if (message.complete) {
                  identity();
                  finish();
                } else if (message.failure) {
                  identity();
                  const failure = message.failure;
                  finish(
                    failure.status === 409 && failure.code === 'SOURCE_TEXT_INTEGRITY'
                      ? new HttpError(409, failure.code, failure.message ?? 'Source text changed')
                      : Error('Source-text copy validation failed'),
                  );
                } else finish(Error('Source-text copy worker protocol changed'));
              } catch (error) {
                finish(error);
              }
            },
          );
          worker.on('error', (error) => {
            if (ready) finish(error);
            else pendingStop = error;
          });
          worker.on('exit', () => {
            if (finished) return;
            finished = true;
            signal?.removeEventListener('abort', abort);
            try {
              identity();
              reject(pendingStop ?? Error('Source-text copy worker exited before validation'));
            } catch (error) {
              reject(error);
            }
          });
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      },
      work: () => ({ pages, chunks, bytes, maxChunk }),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

export type IntakeCopyStandaloneTextReader = Pick<
  IntakeCopyIncrementalReader,
  'rowIds' | 'rowIdsLike' | 'textPieces' | 'columnType' | 'work' | 'close'
>;
export type IntakeCopyPortableBackupReader = Pick<
  IntakeCopyIncrementalReader,
  'tables' | 'columns' | 'rowIds' | 'rowPieces' | 'work' | 'close'
>;

/** Read a completed, private rollback-journal copy synchronously in the setup worker. */
export function createIntakeCopyIncrementalReaderFromStandalone(
  source: DatabaseSync,
  checkpoint: () => void,
): IntakeCopyStandaloneTextReader {
  return createStandaloneReader(source, checkpoint, 'source-text');
}

/** Export the completed private backup itself; never take a second full copy. */
export function createIntakeCopyIncrementalReaderFromPortableBackup(
  source: DatabaseSync,
  checkpoint: () => void,
): IntakeCopyPortableBackupReader {
  return createStandaloneReader(source, checkpoint, 'portable');
}

function createStandaloneReader(
  source: DatabaseSync,
  checkpoint: () => void,
  scope: 'source-text' | 'portable',
): IntakeCopyStandaloneTextReader & IntakeCopyPortableBackupReader {
  checkpoint();
  const path = source.location();
  if (!path || !source.isOpen || source.isTransaction)
    throw Error('Incremental copy standalone source unavailable');
  if ([`${path}-wal`, `${path}-shm`, `${path}-journal`].some(existsSync))
    throw Error('Incremental copy standalone source retained SQLite sidecars');
  const native = intakeCopyNativeSqlite();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let sql: DatabaseSync | undefined;
  let handle: unknown;
  let closed = false;
  let chunks = 0,
    bytes = 0,
    maxChunk = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      sql?.close();
    } finally {
      try {
        if (handle) native.close(handle);
      } finally {
        closeSync(fd);
      }
    }
  };
  try {
    const sealed = fstatSync(fd, { bigint: true });
    if (!sealed.isFile() || !sealed.size) throw Error('Incremental copy standalone file changed');
    const identity = () => {
      checkpoint();
      const held = fstatSync(fd, { bigint: true }),
        named = lstatSync(path, { bigint: true });
      if (
        !held.isFile() ||
        !named.isFile() ||
        held.dev !== sealed.dev ||
        named.dev !== sealed.dev ||
        held.ino !== sealed.ino ||
        named.ino !== sealed.ino ||
        held.size !== sealed.size ||
        named.size !== sealed.size ||
        held.mtimeNs !== sealed.mtimeNs ||
        named.mtimeNs !== sealed.mtimeNs ||
        held.ctimeNs !== sealed.ctimeNs ||
        named.ctimeNs !== sealed.ctimeNs ||
        [`${path}-wal`, `${path}-shm`, `${path}-journal`].some(existsSync)
      )
        throw Error('Incremental copy standalone identity changed');
    };
    identity();
    const header = Buffer.alloc(100);
    if (
      readSync(fd, header, 0, 100, 0) !== 100 ||
      header.toString('ascii', 0, 16) !== 'SQLite format 3\0' ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      throw Error('Incremental copy standalone source is not rollback-journal SQLite');
    const encoding = header.readUInt32BE(56);
    if (encoding < 1 || encoding > 3)
      throw Error('Incremental copy standalone source has unsupported text encoding');
    const alias = process.platform === 'darwin' ? `/dev/fd/${fd}` : `/proc/self/fd/${fd}`;
    const pointer: unknown[] = [null];
    const result = native.open(`file:${alias}?immutable=1`, pointer, 0x1 | 0x40, null);
    handle = pointer[0];
    if (result !== 0 || !handle)
      throw Error(`Incremental copy standalone SQLite open failed (${result})`);
    sql = new DatabaseSync(path, { readOnly: true });
    const snapshot = sql;
    const checked = <T>(read: () => T): T => {
      identity();
      const result = read();
      identity();
      return result;
    };
    const schema = new Map<string, { names: string[]; rowid: string; inline: Set<string> }>();
    let knownTables: string[] | undefined;
    const tables = () => {
      if (knownTables) return knownTables;
      const sql =
        "SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name";
      const original = intakeCopyNativeSelect(source, sql, checkpoint)
        .all()
        .map((row) => String(row.name));
      const copied = checked(() =>
        intakeCopyNativeSelect(snapshot, sql, identity)
          .all()
          .map((row) => String(row.name)),
      );
      if (JSON.stringify(original) !== JSON.stringify(copied))
        throw Error('Incremental copy standalone table inventory changed');
      knownTables = copied;
      return copied;
    };
    const schemaFor = (table: string) => {
      if (
        (scope === 'source-text' && table !== 'app_meta' && table !== 'source_files') ||
        (scope === 'portable' && !tables().includes(table))
      )
        throw Error('Incremental copy standalone table unavailable');
      const known = schema.get(table);
      if (known) return known;
      const kindRows = checked(() =>
        intakeCopyNativeSelect(
          snapshot,
          "SELECT name,hidden,dflt_value FROM pragma_table_xinfo(?,'main') ORDER BY cid",
          identity,
        ).all(table),
      );
      const definition = 'SELECT type,sql FROM main.sqlite_schema WHERE name=?';
      const original = intakeCopyNativeSelect(source, definition, checkpoint).get(table);
      const copied = checked(() =>
        intakeCopyNativeSelect(snapshot, definition, identity).get(table),
      );
      const tableInfo = checked(() =>
        intakeCopyNativeSelect(
          snapshot,
          "SELECT wr,type FROM pragma_table_list WHERE schema='main' AND name=?",
          identity,
        ).get(table),
      );
      if (
        original?.type !== 'table' ||
        typeof original.sql !== 'string' ||
        original.sql !== copied?.sql ||
        tableInfo?.wr !== 0 ||
        tableInfo?.type !== 'table' ||
        kindRows.length === 0 ||
        kindRows.some((row) => row.hidden !== 0)
      )
        throw Error('Incremental copy standalone table schema changed');
      const names = kindRows.map((row) => String(row.name));
      if (table === 'app_meta' && (!names.includes('key') || !names.includes('value')))
        throw Error('Incremental copy standalone app_meta columns changed');
      const rowid = ['rowid', '_rowid_', 'oid'].find(
        (candidate) => !names.some((name) => name.toLowerCase() === candidate),
      );
      if (!rowid) throw Error('Incremental copy standalone table shadows rowid');
      intakeCopyNativeSelect(source, `SELECT * FROM main.${quote(table)} LIMIT 0`, checkpoint);
      for (const column of names)
        intakeCopyNativeSelect(
          source,
          `SELECT ${quote(column)} FROM main.${quote(table)} LIMIT 0`,
          checkpoint,
        );
      intakeCopyNativeSelect(
        source,
        `SELECT ${rowid} FROM main.${quote(table)} LIMIT 0`,
        checkpoint,
      );
      const result = {
        names,
        rowid,
        inline: new Set(
          kindRows.filter((row) => row.dflt_value === null).map((row) => String(row.name)),
        ),
      };
      schema.set(table, result);
      return result;
    };
    const columns = (table: string) => schemaFor(table).names;
    // Compiled once per table or column on this private immutable snapshot;
    // every execution is still bracketed by the snapshot identity proof.
    const statements = new Map<string, ReturnType<typeof intakeCopyNativeSelect>>();
    const compiled = (key: string, sql: () => string) => {
      let statement = statements.get(key);
      if (!statement) {
        statement = checked(() => intakeCopyNativeSelect(snapshot, sql(), identity));
        statements.set(key, statement);
      }
      return statement;
    };
    const columnType = (table: string, column: string, id: bigint) => {
      const selected = schemaFor(table);
      if (!selected.names.includes(column))
        throw Error('Incremental copy standalone column unavailable');
      const statement = compiled(
        JSON.stringify(['type', table, column]),
        () =>
          `SELECT typeof(${quote(column)}) AS type FROM main.${quote(table)} WHERE ${selected.rowid}=?`,
      );
      return String(checked(() => statement.get(id))?.type);
    };
    const rowCells = (table: string, id: bigint) => {
      const selected = schemaFor(table);
      const statement = compiled(JSON.stringify(['row', table]), () =>
        rowCellsSql(table, selected.names, selected.rowid, selected.inline),
      );
      return checked(() => statement.get(id));
    };
    const raw = function* (table: string, column: string, id: bigint): Generator<Uint8Array> {
      try {
        yield* nativeColumnPieces(native, handle, table, column, id, identity, (size) => {
          chunks++;
          bytes += size;
          maxChunk = Math.max(maxChunk, size);
        });
      } catch (error) {
        if (scope !== 'portable' || !(error instanceof ColumnOpenError)) throw error;
        const literal = verifiedVirtualTextDefault(
          snapshot,
          identity,
          table,
          column,
          id,
          schemaFor(table).rowid,
          encoding,
          error,
        );
        chunks++;
        bytes += literal.length;
        maxChunk = Math.max(maxChunk, literal.length);
        yield literal;
        identity();
      }
    };
    identity();
    return {
      tables,
      columns,
      *rowIds(table) {
        const selected = schemaFor(table);
        const statement = checked(() =>
          intakeCopyNativeSelect(
            snapshot,
            `SELECT CAST(${selected.rowid} AS TEXT) AS id FROM main.${quote(table)}`,
            identity,
          ),
        );
        try {
          for (const row of statement.iterate()) {
            identity();
            yield BigInt(String(row.id));
          }
        } finally {
          identity();
        }
      },
      *rowIdsLike(table, column, pattern) {
        if (table !== 'app_meta' || column !== 'key' || typeof pattern !== 'string')
          throw Error('Incremental copy standalone LIKE scope changed');
        const selected = schemaFor(table);
        const statement = checked(() =>
          intakeCopyNativeSelect(
            snapshot,
            `SELECT CAST(${selected.rowid} AS TEXT) AS id FROM main.app_meta WHERE key LIKE ?`,
            identity,
          ),
        );
        try {
          for (const row of statement.iterate(pattern)) {
            identity();
            yield BigInt(String(row.id));
          }
        } finally {
          identity();
        }
      },
      *textPieces(table, column, id) {
        if (columnType(table, column, id) !== 'text')
          throw Error('Incremental copy standalone TEXT column changed');
        yield* decodedTextPieces(raw(table, column, id), encoding);
      },
      *rowPieces(table, id, names, order = 'sorted') {
        if (JSON.stringify(names) !== JSON.stringify(columns(table)))
          throw Error('Incremental copy row column inventory changed');
        if (order !== 'sorted' && order !== 'select')
          throw Error('Incremental copy row order changed');
        const ordered = Object.keys(
          Object.fromEntries(
            (order === 'sorted' ? [...names].sort() : names).map((name) => [name, 0]),
          ),
        );
        const position = new Map(names.map((name, index) => [name, index]));
        const cells = rowCells(table, id);
        const inline = schemaFor(table).inline;
        const limit = Math.floor(CHUNK / names.length);
        const bytesFor = function* (column: string, at: number): Generator<Uint8Array> {
          const value = cells?.[`v${at}`];
          if (!inline.has(column) || !(value instanceof Uint8Array)) {
            yield* raw(table, column, id);
            return;
          }
          if (value.byteLength > limit) throw Error('Incremental copy inline column bound changed');
          identity();
          try {
            if (value.byteLength) {
              chunks++;
              bytes += value.byteLength;
              maxChunk = Math.max(maxChunk, value.byteLength);
              yield value;
            }
          } finally {
            identity();
          }
        };
        try {
          yield '{';
          for (let index = 0; index < ordered.length; index++) {
            const column = ordered[index]!;
            if (index) yield ',';
            yield JSON.stringify(column) + ':';
            // Each resumed field step re-proves the pinned file, as the per-column
            // reads did; the row's cells were read under the same identity.
            identity();
            const at = position.get(column)!;
            const kind = cells?.[`t${at}`];
            if (kind === 'text') {
              yield '"';
              for (const piece of decodedTextPieces(bytesFor(column, at), encoding))
                for (const part of intakeCopyTextPieces(piece))
                  yield JSON.stringify(part).slice(1, -1);
              yield '"';
            } else if (kind === 'blob') {
              yield '{';
              let n = 0;
              for (const piece of bytesFor(column, at))
                for (let at = 0; at < piece.length; at += 512) {
                  const entries: string[] = [];
                  for (const value of piece.subarray(at, at + 512))
                    entries.push(`${n ? ',' : ''}"${n++}":${value}`);
                  yield entries.join('');
                }
              yield '}';
            } else if (kind === 'null' || kind === 'integer' || kind === 'real') {
              const encoded = JSON.stringify(cells![`v${at}`]);
              if (encoded === undefined) throw Error('Incremental copy scalar cannot be encoded');
              yield encoded;
            } else throw Error('Incremental copy column type changed');
          }
          yield '}';
        } finally {
          identity();
        }
      },
      columnType,
      work: () => ({ pages: 0, chunks, bytes, maxChunk }),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
