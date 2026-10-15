/** Private row transport for a portable rebuild. It is not recovery authority. */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  type BigIntStats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  currentTransactionToken,
  managedDatabaseMethodEpoch,
  observeTransactionOutcome,
} from './database.ts';
import { intakeCopyNativeSqlite } from './intake-copy-native-sqlite.ts';
import { intakeCopyTextPieces } from './intake-copy-json.ts';

const ALIAS = '__portable_projection_transfer';
const CHUNK = 16 * 1024;
const transfers = new WeakSet<object>();
const targets = new WeakMap<
  object,
  {
    transfer: PortableProjectionTransfer;
    db: DatabaseSync;
    token: object;
    active: () => boolean;
  }
>();
type Cell =
  | {
      readonly name: string;
      readonly kind: 'text';
      readonly pieces: () => Iterable<string>;
    }
  | { readonly name: string; readonly kind: 'number'; readonly value: number }
  | { readonly name: string; readonly kind: 'null' };
type FileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
  nlink: bigint;
}>;
const identity = (value: BigIntStats): FileIdentity => ({
  dev: value.dev,
  ino: value.ino,
  size: value.size,
  mtimeNs: value.mtimeNs,
  ctimeNs: value.ctimeNs,
  mode: value.mode,
  nlink: value.nlink,
});
const same = (a: FileIdentity, b: FileIdentity) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.mode === b.mode &&
  a.nlink === b.nlink;
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
function* textBytes(pieces: Iterable<string>): Generator<Buffer> {
  let high = '';
  for (const piece of pieces) {
    const text = high + piece;
    const carry = /[\uD800-\uDBFF]$/.test(text);
    high = carry ? text.slice(-1) : '';
    const ready = carry ? text.slice(0, -1) : text;
    for (const part of intakeCopyTextPieces(ready)) yield Buffer.from(part);
  }
  if (high) yield Buffer.from(high);
}

export interface PortableProjectionTarget {
  apply(table: string): number;
  applyMigrations(
    versions: readonly number[],
    fallbackCreatedAt: string | number | bigint | null,
  ): void;
}
export interface PortableProjectionTransfer {
  putRow(table: string, ordinal: number, cells: readonly Cell[]): void;
  assertInventory(expected: ReadonlyMap<string, number>): void;
  seal(): void;
  withTarget<T>(db: DatabaseSync, token: object, run: (view: PortableProjectionTarget) => T): T;
  assertReleased(): void;
  close(): void;
}
export function assertPortableProjectionTransfer(transfer: PortableProjectionTransfer): void {
  if (!transfers.has(transfer)) throw Error('Portable projection transfer identity changed');
}
export function assertPortableProjectionTarget(
  view: PortableProjectionTarget,
  transfer: PortableProjectionTransfer,
  db: DatabaseSync,
  token: object,
): void {
  assertPortableProjectionTransfer(transfer);
  const selected = targets.get(view);
  if (
    !selected ||
    selected.transfer !== transfer ||
    selected.db !== db ||
    selected.token !== token ||
    !selected.active()
  )
    throw Error('Portable projection target identity changed');
}

/** Only the target's fresh trusted schema may define table and column names. */
export function createPortableProjectionTransfer(
  schema: ReadonlyMap<string, readonly string[]>,
  checkpoint: () => void,
): PortableProjectionTransfer {
  checkpoint();
  const allowed = new Map<string, ReadonlySet<string>>();
  for (const [table, names] of schema) {
    if (!table || !names.length || names.some((name) => !name || name.includes('\0')))
      throw Error('Invalid portable projection schema');
    allowed.set(table, new Set(names));
    if (allowed.get(table)!.size !== names.length)
      throw Error('Duplicate portable projection schema column');
  }
  const directory = mkdtempSync(join(tmpdir(), 'health-portable-transfer-'));
  const path = join(directory, 'transfer.sqlite');
  let stage: DatabaseSync | undefined;
  let nativeDb: unknown;
  let heldFd: number | undefined;
  let sealed: FileIdentity | undefined;
  let inventoried = false;
  let closed = false;
  let failed = false;
  let attached = false;
  let attachedDb: DatabaseSync | undefined;
  let detachFailure: unknown;
  const native = intakeCopyNativeSqlite();
  const current = () => {
    if (closed || failed) throw Error('Portable projection transfer unavailable');
    checkpoint();
  };
  const fileCurrent = () => {
    current();
    if (!sealed) return;
    const named = lstatSync(path, { bigint: true });
    const held = fstatSync(heldFd!, { bigint: true });
    if (
      !named.isFile() ||
      !held.isFile() ||
      !same(sealed, identity(named)) ||
      !same(sealed, identity(held))
    )
      throw Error('Portable projection transfer file changed');
  };
  try {
    chmodSync(directory, 0o700);
    stage = new DatabaseSync(path);
    chmodSync(path, 0o600);
    stage.exec(`CREATE TABLE rows(table_name TEXT NOT NULL,ordinal INTEGER NOT NULL,columns_json TEXT NOT NULL,
      PRIMARY KEY(table_name,ordinal));
      CREATE TABLE cells(table_name TEXT NOT NULL,ordinal INTEGER NOT NULL,column_name TEXT NOT NULL,
      kind TEXT NOT NULL,value BLOB,numeric_value REAL,sha256 TEXT,bytes INTEGER,
      PRIMARY KEY(table_name,ordinal,column_name));`);
    const opened: unknown[] = [null];
    const code = native.open(path, opened, 0x2, null);
    nativeDb = opened[0];
    if (code !== 0 || !nativeDb) throw Error(`Portable projection native open failed (${code})`);
    const db = stage;
    const transfer: PortableProjectionTransfer = Object.freeze({
      putRow(table: string, ordinal: number, cells: readonly Cell[]) {
        current();
        if (
          sealed ||
          inventoried ||
          attached ||
          !allowed.has(table) ||
          !Number.isSafeInteger(ordinal) ||
          ordinal < 0
        )
          throw Error('Invalid portable projection row');
        const names = allowed.get(table)!;
        const selected = new Set<string>();
        if (!cells.length || cells.length > names.size)
          throw Error('Invalid portable projection columns');
        try {
          for (const cell of cells) {
            current();
            if (!names.has(cell.name) || selected.has(cell.name))
              throw Error('Unknown portable projection column');
            selected.add(cell.name);
            if (cell.kind === 'null') {
              db.prepare(
                'INSERT INTO cells(table_name,ordinal,column_name,kind) VALUES(?,?,?,?)',
              ).run(table, ordinal, cell.name, 'null');
              continue;
            }
            if (cell.kind === 'number') {
              if (!Number.isFinite(cell.value)) throw Error('Invalid portable projection number');
              db.prepare(
                'INSERT INTO cells(table_name,ordinal,column_name,kind,numeric_value) VALUES(?,?,?,?,?)',
              ).run(
                table,
                ordinal,
                cell.name,
                Number.isSafeInteger(cell.value) ? 'integer' : 'real',
                cell.value,
              );
              continue;
            }
            const hash = createHash('sha256');
            let bytes = 0;
            for (const data of textBytes(cell.pieces())) {
              current();
              hash.update(data);
              bytes += data.length;
            }
            const expected = hash.digest('hex');
            const inserted = db
              .prepare(
                `INSERT INTO cells(table_name,ordinal,column_name,kind,value,sha256,bytes)
              VALUES(?,?,?,'text',zeroblob(?),?,?)`,
              )
              .run(table, ordinal, cell.name, bytes, expected, bytes);
            const pointer: unknown[] = [null];
            const opened = native.blobOpen(
              nativeDb,
              'main',
              'cells',
              'value',
              inserted.lastInsertRowid,
              1,
              pointer,
            );
            const blob = pointer[0];
            if (opened !== 0 || !blob)
              throw Error(`Portable projection blob open failed (${opened})`);
            let offset = 0;
            const written = createHash('sha256');
            try {
              if (native.blobBytes(blob) !== bytes)
                throw Error('Portable projection blob length changed');
              for (const data of textBytes(cell.pieces())) {
                current();
                for (let at = 0; at < data.length; at += CHUNK) {
                  current();
                  const chunk = data.subarray(at, Math.min(data.length, at + CHUNK));
                  if (
                    offset + chunk.length > bytes ||
                    native.blobWrite(blob, chunk, chunk.length, offset) !== 0
                  )
                    throw Error('Portable projection blob write failed');
                  written.update(chunk);
                  offset += chunk.length;
                }
              }
            } finally {
              if (native.blobClose(blob) !== 0)
                throw Error('Portable projection blob close failed');
            }
            if (offset !== bytes || written.digest('hex') !== expected)
              throw Error('Portable projection source changed during write');
            const readPointer: unknown[] = [null];
            const readCode = native.blobOpen(
              nativeDb,
              'main',
              'cells',
              'value',
              inserted.lastInsertRowid,
              0,
              readPointer,
            );
            const readBlob = readPointer[0];
            if (readCode !== 0 || !readBlob)
              throw Error(`Portable projection readback open failed (${readCode})`);
            const actual = createHash('sha256');
            try {
              const buffer = Buffer.alloc(CHUNK);
              for (let at = 0; at < bytes; at += CHUNK) {
                current();
                const count = Math.min(CHUNK, bytes - at);
                if (native.blobRead(readBlob, buffer, count, at) !== 0)
                  throw Error('Portable projection readback failed');
                actual.update(buffer.subarray(0, count));
              }
            } finally {
              if (native.blobClose(readBlob) !== 0)
                throw Error('Portable projection readback close failed');
            }
            if (actual.digest('hex') !== expected)
              throw Error('Portable projection readback changed');
          }
          db.prepare('INSERT INTO rows VALUES(?,?,?)').run(
            table,
            ordinal,
            JSON.stringify([...selected]),
          );
        } catch (error) {
          failed = true;
          throw error;
        }
      },
      assertInventory(expected: ReadonlyMap<string, number>) {
        current();
        if (sealed || attached || inventoried || expected.size !== allowed.size)
          throw Error('Portable projection inventory changed');
        for (const [table] of allowed) {
          const count = expected.get(table);
          if (count === undefined || !Number.isSafeInteger(count) || count < 0)
            throw Error('Portable projection inventory changed');
          const actual = db
            .prepare(
              'SELECT count(*) AS n,min(ordinal) AS first,max(ordinal) AS last FROM rows WHERE table_name=?',
            )
            .get(table)!;
          if (
            Number(actual.n) !== count ||
            (count > 0 && (actual.first !== 0 || actual.last !== count - 1))
          )
            throw Error('Portable projection inventory changed');
          const orphan = db
            .prepare(
              `SELECT 1 FROM cells AS c LEFT JOIN rows AS r
               ON r.table_name=c.table_name AND r.ordinal=c.ordinal
               WHERE c.table_name=? AND r.ordinal IS NULL LIMIT 1`,
            )
            .get(table);
          if (orphan) throw Error('Portable projection cell inventory changed');
        }
        inventoried = true;
      },
      seal() {
        current();
        if (sealed || attached || !inventoried)
          throw Error('Portable projection transfer seal changed');
        db.close();
        stage = undefined;
        if (native.close(nativeDb) !== 0) throw Error('Portable projection native close failed');
        nativeDb = undefined;
        heldFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const named = lstatSync(path, { bigint: true });
        const held = fstatSync(heldFd, { bigint: true });
        if (
          !named.isFile() ||
          !held.isFile() ||
          held.nlink !== 1n ||
          !same(identity(named), identity(held))
        )
          throw Error('Portable projection seal file changed');
        chmodSync(path, 0o400);
        sealed = identity(lstatSync(path, { bigint: true }));
        fileCurrent();
      },
      withTarget<T>(
        target: DatabaseSync,
        token: object,
        run: (view: PortableProjectionTarget) => T,
      ): T {
        fileCurrent();
        if (
          !sealed ||
          attached ||
          detachFailure ||
          !target.isTransaction ||
          currentTransactionToken(target) !== token
        )
          throw Error('Portable projection target transaction changed');
        const epoch = managedDatabaseMethodEpoch(target);
        const prepare = target.prepare;
        let active = true;
        const check = () => {
          fileCurrent();
          if (
            !active ||
            !target.isTransaction ||
            currentTransactionToken(target) !== token ||
            managedDatabaseMethodEpoch(target) !== epoch ||
            target.prepare !== prepare
          )
            throw Error('Portable projection target authority changed');
        };
        check();
        target.prepare(`ATTACH DATABASE ? AS ${ALIAS}`).run(path);
        attached = true;
        attachedDb = target;
        let stopOutcome: (() => void) | undefined;
        stopOutcome = observeTransactionOutcome(target, (outcome) => {
          if (outcome.token !== token) return;
          stopOutcome?.();
          try {
            target.exec(`DETACH DATABASE ${ALIAS}`);
            attached = false;
            attachedDb = undefined;
          } catch (error) {
            detachFailure = error;
          }
        });
        const view: PortableProjectionTarget = Object.freeze({
          applyMigrations(
            versions: readonly number[],
            fallbackCreatedAt: string | number | bigint | null,
          ): void {
            check();
            if (!allowed.has('schema_migrations'))
              throw Error('Portable migration projection unavailable');
            const insert = target.prepare(
              `INSERT INTO main.schema_migrations(version,applied_at)
               SELECT ?, COALESCE((
                 SELECT CASE applied.kind
                   WHEN 'text' THEN CAST(applied.value AS TEXT)
                   WHEN 'integer' THEN CAST(applied.numeric_value AS INTEGER)
                   WHEN 'real' THEN applied.numeric_value
                   ELSE NULL END
                 FROM ${ALIAS}.rows AS r
                 JOIN ${ALIAS}.cells AS version
                   ON version.table_name=r.table_name AND version.ordinal=r.ordinal
                     AND version.column_name='version'
                 LEFT JOIN ${ALIAS}.cells AS applied
                   ON applied.table_name=r.table_name AND applied.ordinal=r.ordinal
                     AND applied.column_name='applied_at'
                 WHERE r.table_name='schema_migrations'
                   AND version.kind IN ('integer','real') AND version.numeric_value=?
                 ORDER BY r.ordinal LIMIT 1
               ), ?)`,
            );
            for (const version of versions) {
              check();
              if (!Number.isSafeInteger(version) || version < 0)
                throw Error('Portable target migration version changed');
              if (insert.run(version, version, fallbackCreatedAt).changes !== 1)
                throw Error('Portable migration insertion changed');
            }
            check();
          },
          apply(table: string): number {
            check();
            const selected = allowed.get(table);
            if (!selected) throw Error('Unknown portable projection table');
            const physical = target
              .prepare(`PRAGMA main.table_info(${quote(table)})`)
              .all()
              .map((row) => String(row.name));
            if (physical.length !== selected.size || physical.some((name) => !selected.has(name)))
              throw Error('Portable projection target schema changed');
            let count = 0;
            for (const row of target
              .prepare(
                `SELECT ordinal,columns_json FROM ${ALIAS}.rows WHERE table_name=? ORDER BY ordinal`,
              )
              .iterate(table)) {
              check();
              const columns = JSON.parse(String(row.columns_json)) as string[];
              if (
                !columns.length ||
                columns.length > selected.size ||
                new Set(columns).size !== columns.length ||
                columns.some((name) => !selected.has(name))
              )
                throw Error('Portable projection row columns changed');
              const actual = Number(
                target
                  .prepare(
                    `SELECT count(*) AS n FROM ${ALIAS}.cells WHERE table_name=? AND ordinal=?`,
                  )
                  .get(table, row.ordinal)!.n,
              );
              if (actual !== columns.length)
                throw Error('Portable projection cell inventory changed');
              const expressions = columns.map(
                () => `(
                SELECT CASE kind WHEN 'text' THEN CAST(value AS TEXT)
                  WHEN 'integer' THEN CAST(numeric_value AS INTEGER)
                  WHEN 'real' THEN numeric_value ELSE NULL END
                FROM ${ALIAS}.cells WHERE table_name=? AND ordinal=? AND column_name=?)`,
              );
              const sql = `INSERT INTO main.${quote(table)}(${columns.map(quote).join(',')}) SELECT ${expressions.join(',')}`;
              const arguments_: (string | number | bigint)[] = [];
              for (const column of columns)
                arguments_.push(table, row.ordinal as number | bigint, column);
              const result = target.prepare(sql).run(...arguments_);
              if (result.changes !== 1) throw Error('Portable projection insert changed');
              count++;
            }
            check();
            return count;
          },
        });
        targets.set(view, {
          transfer,
          db: target,
          token,
          active: () => active,
        });
        try {
          check();
          const result = run(view);
          if (result instanceof Promise)
            throw Error('Portable projection target callback must be synchronous');
          check();
          return result;
        } finally {
          active = false;
        }
      },
      assertReleased() {
        fileCurrent();
        if (attached || detachFailure) throw Error('Portable projection target detach failed');
      },
      close() {
        if (closed) return;
        if (attached && attachedDb?.isOpen) {
          if (attachedDb.isTransaction)
            throw Error('Portable projection target transaction active');
          attachedDb.exec(`DETACH DATABASE ${ALIAS}`);
        }
        closed = true;
        if (heldFd !== undefined) closeSync(heldFd);
        if (nativeDb) native.close(nativeDb);
        stage?.close();
        rmSync(directory, { recursive: true, force: true });
      },
    });
    transfers.add(transfer);
    return transfer;
  } catch (error) {
    if (heldFd !== undefined) closeSync(heldFd);
    if (nativeDb) native.close(nativeDb);
    stage?.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
