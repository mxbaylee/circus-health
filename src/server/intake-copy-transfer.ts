/** Disposable copy transport. A sealed transfer is never an authority: callers
 * retain the original copy interval and unpublished target transaction. */
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
import { setImmediate } from 'node:timers/promises';
import { toUSVString } from 'node:util';
import {
  currentTransactionToken,
  managedDatabaseMethodEpoch,
  observeTransactionOutcome,
} from './database.ts';
import { intakeCopyTextPieces } from './intake-copy-json.ts';
import { intakeCopyNativeSqlite } from './intake-copy-native-sqlite.ts';

const ALIAS = '__intake_copy_transfer';
const CHUNK = 16 * 1024;
const transfers = new WeakSet<object>();
const targets = new WeakMap<
  object,
  { transfer: IntakeCopyTransfer; db: DatabaseSync; token: object; active: () => boolean }
>();
export type IntakeCopyTransferKind =
  'originals' | 'source' | 'prepared' | 'revision-before' | 'revision-after';

type FileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;
function identity(value: BigIntStats): FileIdentity {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}
function same(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

export interface IntakeCopyTransferTarget {
  assertOriginalDetails(): void;
  assertInventory(kind: 'source' | 'prepared'): void;
  applyState(): void;
  applyRevisions(): void;
}

export interface IntakeCopyTransfer {
  put(kind: IntakeCopyTransferKind, key: string, pieces: () => Iterable<string>): Promise<void>;
  putSync(kind: IntakeCopyTransferKind, key: string, pieces: () => Iterable<string>): void;
  seal(): void;
  withTarget<T>(db: DatabaseSync, token: object, run: (target: IntakeCopyTransferTarget) => T): T;
  assertReleased(): void;
  work(): Readonly<{
    values: number;
    bytes: number;
    chunks: number;
    maxChunk: number;
    readbackBytes: number;
    sealedFileBytes: number;
  }>;
  close(): void;
}

export function assertIntakeCopyTransfer(transfer: IntakeCopyTransfer): void {
  if (!transfers.has(transfer)) throw Error('Copy transfer identity changed');
}

export function assertIntakeCopyTransferTarget(
  view: IntakeCopyTransferTarget,
  transfer: IntakeCopyTransfer,
  db: DatabaseSync,
  token: object,
): void {
  assertIntakeCopyTransfer(transfer);
  const selected = targets.get(view);
  if (
    !selected ||
    selected.transfer !== transfer ||
    selected.db !== db ||
    selected.token !== token ||
    !selected.active()
  )
    throw Error('Copy transfer target identity changed');
}

export function createIntakeCopyTransfer(checkpoint: () => void): IntakeCopyTransfer {
  checkpoint();
  const directory = mkdtempSync(join(tmpdir(), 'health-copy-transfer-'));
  const path = join(directory, 'transfer.sqlite');
  let db: DatabaseSync | undefined;
  let nativeHandle: unknown;
  let heldFd: number | undefined;
  let sealedIdentity: FileIdentity | undefined;
  let closed = false;
  let busy = false;
  let attached = false;
  let attachedDb: DatabaseSync | undefined;
  let detachFailure: unknown;
  let failed = false;
  let values = 0;
  let bytes = 0;
  let chunks = 0;
  let maxChunk = 0;
  let readbackBytes = 0;
  let sealedFileBytes = 0;
  const native = intakeCopyNativeSqlite();
  const current = () => {
    if (closed) throw Error('Copy transfer closed');
    checkpoint();
  };
  const fileCurrent = () => {
    current();
    if (sealedIdentity) {
      const named = lstatSync(path, { bigint: true });
      const held = fstatSync(heldFd!, { bigint: true });
      if (
        !named.isFile() ||
        !held.isFile() ||
        !same(sealedIdentity, identity(named)) ||
        !same(sealedIdentity, identity(held))
      )
        throw Error('Copy transfer file changed');
    }
  };
  try {
    chmodSync(directory, 0o700);
    db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    // This private spool is discarded on failure, never resumed as recovery evidence.
    // Final target durability and mandatory source/readback proofs are independent.
    db.exec('PRAGMA main.synchronous=OFF');
    db.exec(
      'CREATE TABLE transfer(kind TEXT NOT NULL,key TEXT NOT NULL,value BLOB NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(kind,key));' +
        'CREATE VIEW text_transfer AS SELECT kind,key,CAST(value AS TEXT) AS value FROM transfer;',
    );
    const pointer: unknown[] = [null];
    const opened = native.openDisposableTransfer(path, pointer);
    nativeHandle = pointer[0];
    if (opened !== 0 || !nativeHandle) throw Error(`Copy transfer SQLite open failed (${opened})`);
    const stage = db;
    // Values stay BLOBs here: target statements read them through one explicit
    // UTF-8 TEXT cast (the attached schema shares the target encoding), instead
    // of rewriting every complete value inside this spool after readback.
    const insertValue = stage.prepare(
      'INSERT INTO transfer(kind,key,value,sha256,bytes) VALUES(?,?,zeroblob(?),?,?)',
    );
    function* putSteps(
      kind: IntakeCopyTransferKind,
      key: string,
      pieces: () => Iterable<string>,
    ): Generator<void> {
      current();
      if (sealedIdentity || busy || attached || failed || typeof key !== 'string' || !key)
        throw Error('Copy transfer admission changed');
      busy = true;
      try {
        let length = 0;
        const expected = createHash('sha256');
        let scanned = 0;
        for (const piece of pieces()) {
          current();
          for (const part of intakeCopyTextPieces(piece)) {
            if (toUSVString(part) !== part) throw Error('Copy transfer text is not Unicode');
            const raw = Buffer.from(part);
            length += raw.length;
            expected.update(raw);
            if (++scanned % 16 === 0) yield;
          }
        }
        current();
        const digest = expected.digest('hex');
        const inserted = insertValue.run(kind, key, length, digest, length);
        const rowid = inserted.lastInsertRowid;
        const slot: unknown[] = [null];
        const opened = native.blobOpen(nativeHandle, 'main', 'transfer', 'value', rowid, 1, slot);
        const blob = slot[0];
        if (opened !== 0 || !blob) throw Error(`Copy transfer blob open failed (${opened})`);
        let offset = 0;
        const written = createHash('sha256');
        try {
          if (native.blobBytes(blob) !== length) throw Error('Copy transfer length changed');
          for (const piece of pieces()) {
            current();
            for (const part of intakeCopyTextPieces(piece)) {
              if (toUSVString(part) !== part) throw Error('Copy transfer text changed');
              const raw = Buffer.from(part);
              for (let at = 0; at < raw.length; at += CHUNK) {
                current();
                const chunk = raw.subarray(at, Math.min(at + CHUNK, raw.length));
                if (
                  offset + chunk.length > length ||
                  native.blobWrite(blob, chunk, chunk.length, offset) !== 0
                )
                  throw Error('Copy transfer blob write failed');
                written.update(chunk);
                offset += chunk.length;
                chunks++;
                maxChunk = Math.max(maxChunk, chunk.length);
                if (chunks % 16 === 0) yield;
              }
            }
          }
        } finally {
          if (native.blobClose(blob) !== 0) throw Error('Copy transfer blob close failed');
        }
        if (offset !== length || written.digest('hex') !== digest)
          throw Error('Copy transfer source changed during write');
        current();
        const verified: unknown[] = [null];
        if (
          native.blobOpen(nativeHandle, 'main', 'transfer', 'value', rowid, 0, verified) !== 0 ||
          !verified[0]
        )
          throw Error('Copy transfer readback unavailable');
        const read = verified[0];
        const actual = createHash('sha256');
        try {
          const buffer = Buffer.alloc(CHUNK);
          let checked = 0;
          for (let at = 0; at < length; at += CHUNK) {
            current();
            const count = Math.min(CHUNK, length - at);
            if (native.blobRead(read, buffer, count, at) !== 0)
              throw Error('Copy transfer readback failed');
            actual.update(buffer.subarray(0, count));
            readbackBytes += count;
            if (++checked % 16 === 0) yield;
          }
        } finally {
          if (native.blobClose(read) !== 0) throw Error('Copy transfer readback close failed');
        }
        if (actual.digest('hex') !== digest) throw Error('Copy transfer readback changed');
        current();
        values++;
        bytes += length;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        busy = false;
      }
    }
    const transfer: IntakeCopyTransfer = Object.freeze({
      async put(kind: IntakeCopyTransferKind, key: string, pieces: () => Iterable<string>) {
        for (const _ of putSteps(kind, key, pieces)) await setImmediate();
      },
      putSync(kind: IntakeCopyTransferKind, key: string, pieces: () => Iterable<string>) {
        for (const _ of putSteps(kind, key, pieces)) {
          // The encrypted copy route is synchronous; every chunk remains bounded.
        }
      },
      seal() {
        current();
        if (busy || attached || failed || sealedIdentity) throw Error('Copy transfer seal changed');
        stage.close();
        db = undefined;
        if (native.close(nativeHandle) !== 0) throw Error('Copy transfer native close failed');
        nativeHandle = undefined;
        heldFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const named = lstatSync(path, { bigint: true });
        const held = fstatSync(heldFd, { bigint: true });
        if (!named.isFile() || !held.isFile() || !same(identity(named), identity(held)))
          throw Error('Copy transfer seal file changed');
        sealedIdentity = identity(named);
        chmodSync(path, 0o400);
        sealedIdentity = identity(lstatSync(path, { bigint: true }));
        sealedFileBytes = Number(sealedIdentity.size);
        fileCurrent();
      },
      withTarget<T>(
        targetDb: DatabaseSync,
        token: object,
        run: (target: IntakeCopyTransferTarget) => T,
      ): T {
        fileCurrent();
        if (
          !sealedIdentity ||
          attached ||
          detachFailure ||
          currentTransactionToken(targetDb) !== token ||
          !targetDb.isTransaction
        )
          throw Error('Copy transfer target transaction changed');
        const epoch = managedDatabaseMethodEpoch(targetDb);
        const prepare = targetDb.prepare;
        let active = true;
        const check = () => {
          fileCurrent();
          if (
            !active ||
            currentTransactionToken(targetDb) !== token ||
            !targetDb.isTransaction ||
            managedDatabaseMethodEpoch(targetDb) !== epoch ||
            targetDb.prepare !== prepare
          )
            throw Error('Copy transfer target authority changed');
        };
        check();
        targetDb.prepare(`ATTACH DATABASE ? AS ${ALIAS}`).run(path);
        attached = true;
        attachedDb = targetDb;
        let stopOutcome: (() => void) | undefined;
        stopOutcome = observeTransactionOutcome(targetDb, (outcome) => {
          if (outcome.token !== token) return;
          stopOutcome?.();
          try {
            targetDb.exec(`DETACH DATABASE ${ALIAS}`);
            attached = false;
            attachedDb = undefined;
          } catch (error) {
            detachFailure = error;
          }
        });
        const count = (kind: IntakeCopyTransferKind) => {
          check();
          return Number(
            targetDb
              .prepare(`SELECT count(*) AS n FROM ${ALIAS}.text_transfer WHERE kind=?`)
              .get(kind)!.n,
          );
        };
        const inventory = (kind: 'source' | 'prepared') => {
          check();
          const missing = targetDb
            .prepare(
              `SELECT 1 FROM main.app_meta a WHERE a.key GLOB 'intake_state_*' AND NOT EXISTS(SELECT 1 FROM ${ALIAS}.text_transfer t WHERE t.kind=? AND t.key=a.key AND t.value IS a.value) LIMIT 1`,
            )
            .get(kind);
          const extra = targetDb
            .prepare(
              `SELECT 1 FROM ${ALIAS}.text_transfer t WHERE t.kind=? AND NOT EXISTS(SELECT 1 FROM main.app_meta a WHERE a.key=t.key AND a.value IS t.value) LIMIT 1`,
            )
            .get(kind);
          if (missing || extra) throw Error('Copy transfer target inventory conflict');
          check();
        };
        const view: IntakeCopyTransferTarget = Object.freeze({
          assertOriginalDetails() {
            check();
            const missing = targetDb
              .prepare(
                `SELECT 1 FROM main.source_files f WHERE f.kind='intake_original' AND NOT EXISTS(SELECT 1 FROM ${ALIAS}.text_transfer t WHERE t.kind='originals' AND t.key=f.id AND t.value IS f.details_json) LIMIT 1`,
              )
              .get();
            const extra = targetDb
              .prepare(
                `SELECT 1 FROM ${ALIAS}.text_transfer t WHERE t.kind='originals' AND NOT EXISTS(SELECT 1 FROM main.source_files f WHERE f.id=t.key AND f.kind='intake_original' AND f.details_json IS t.value) LIMIT 1`,
              )
              .get();
            if (missing || extra) throw Error('Copy transfer target original conflict');
            check();
          },
          assertInventory: inventory,
          applyState() {
            inventory('source');
            const deleted = targetDb
              .prepare(
                `DELETE FROM main.app_meta WHERE key IN(SELECT key FROM ${ALIAS}.text_transfer WHERE kind='source') AND value IS (SELECT value FROM ${ALIAS}.text_transfer WHERE kind='source' AND key=app_meta.key)`,
              )
              .run();
            if (deleted.changes !== count('source'))
              throw Error('Copy transfer source delete changed');
            check();
            const inserted = targetDb
              .prepare(
                `INSERT INTO main.app_meta(key,value) SELECT key,value FROM ${ALIAS}.text_transfer WHERE kind='prepared' ORDER BY key`,
              )
              .run();
            if (inserted.changes !== count('prepared'))
              throw Error('Copy transfer prepared insert changed');
            inventory('prepared');
          },
          applyRevisions() {
            check();
            if (count('revision-before') !== count('revision-after'))
              throw Error('Copy transfer revision inventory changed');
            const updated = targetDb
              .prepare(
                `UPDATE main.app_meta SET value=(SELECT t.value FROM ${ALIAS}.text_transfer t WHERE t.kind='revision-after' AND t.key=app_meta.key) WHERE key IN(SELECT key FROM ${ALIAS}.text_transfer WHERE kind='revision-before') AND value IS (SELECT t.value FROM ${ALIAS}.text_transfer t WHERE t.kind='revision-before' AND t.key=app_meta.key)`,
              )
              .run();
            if (updated.changes !== count('revision-before'))
              throw Error('Copy transfer revision preimage changed');
            const mismatch = targetDb
              .prepare(
                `SELECT 1 FROM ${ALIAS}.text_transfer t WHERE t.kind='revision-after' AND NOT EXISTS(SELECT 1 FROM main.app_meta a WHERE a.key=t.key AND a.value IS t.value) LIMIT 1`,
              )
              .get();
            if (mismatch) throw Error('Copy transfer revision target changed');
            check();
          },
        });
        targets.set(view, { transfer, db: targetDb, token, active: () => active });
        try {
          check();
          const result = run(view);
          if (result instanceof Promise)
            throw Error('Copy transfer target callback must be synchronous');
          check();
          return result;
        } finally {
          active = false;
        }
      },
      assertReleased() {
        fileCurrent();
        if (attached || detachFailure) throw Error('Copy transfer target detach failed');
      },
      work() {
        return Object.freeze({ values, bytes, chunks, maxChunk, readbackBytes, sealedFileBytes });
      },
      close() {
        if (closed) return;
        if (attached && attachedDb?.isOpen) {
          if (attachedDb.isTransaction) throw Error('Copy transfer target transaction active');
          attachedDb.exec(`DETACH DATABASE ${ALIAS}`);
          attached = false;
          attachedDb = undefined;
        }
        closed = true;
        if (heldFd !== undefined) closeSync(heldFd);
        if (nativeHandle) native.close(nativeHandle);
        db?.close();
        rmSync(directory, { recursive: true, force: true });
      },
    });
    transfers.add(transfer);
    return transfer;
  } catch (error) {
    if (heldFd !== undefined) closeSync(heldFd);
    if (nativeHandle) native.close(nativeHandle);
    db?.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
