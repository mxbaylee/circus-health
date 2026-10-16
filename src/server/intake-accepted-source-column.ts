import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Database } from './database.ts';
import type { IntakeStateIdentity } from './intake-state-evidence.ts';
import { ensureIntakeFrontierObserver } from './intake-lookup-frontier-observer.ts';
import {
  assertIntakeLegacyBridgeReadWitnessForSource,
  captureIntakeLegacyBridgeCommittedReadWitness,
  completeIntakeLegacyBridgeCommittedOpening,
  disposeIntakeLegacyBridgeReadWitness,
} from './intake-state-migration.ts';
import { openRecordCommittedColumnReader } from './record-committed-column-reader.ts';
import {
  captureRecordAcceptedIntakeHeadRead,
  closeRecordAcceptedIntakeHeadRead,
  recordAcceptedIntakeCurrentSourceDescriptor,
  recordAcceptedIntakeSourcePair,
} from './record-versions.ts';

const nativePrepare = DatabaseSync.prototype.prepare;
const nativeGet = StatementSync.prototype.get;
const nativeBigInts = StatementSync.prototype.setReadBigInts;

/** The separate SQLite snapshot supplies bytes, never the accepted baseline. */
export interface AcceptedIntakeSourceColumnScope {
  readonly bytes: number;
  readonly hash: string;
  readonly preview: string | null;
  readonly work: Readonly<{ chunks: number; bytes: number; maxChunk: number }>;
  page(
    ordinal: number,
    limit: number,
    assertRunning: () => void,
  ): { text: string; complete: boolean; nextOrdinal: number | null };
  close(): void;
}

export async function openAcceptedIntakeSourceColumn(
  db: Database,
  identity: IntakeStateIdentity,
  sourceVersionId: string,
  column: 'mime_type' | 'provider_id',
  assertRunning: () => void,
): Promise<AcceptedIntakeSourceColumnScope | null> {
  assertRunning();
  let requestCheck = assertRunning;
  ensureIntakeFrontierObserver(db);
  const selected = Reflect.apply(nativePrepare, db, [
    `SELECT s.rowid AS rowid,c.version_id AS version_id,s.bytes AS source_bytes,
       typeof(s.${column}) AS field_type
     FROM main.source_files s JOIN main.__record_current c
       ON c.entity='source_files' AND c.record_id=json_array(s.id)
     WHERE s.id=? AND s.kind='intake_original'`,
  ]) as StatementSync;
  Reflect.apply(nativeBigInts, selected, [true]);
  const locator = () =>
    Reflect.apply(nativeGet, selected, [identity.intakeId]) as
      { rowid: bigint; version_id: string; source_bytes: bigint; field_type: string } | undefined;
  const before = locator();
  if (!before || typeof before.rowid !== 'bigint' || before.version_id !== sourceVersionId)
    throw Error('Accepted source column original locator unavailable');
  let reader: ReturnType<typeof openRecordCommittedColumnReader> | undefined;
  let original: ReturnType<typeof captureIntakeLegacyBridgeCommittedReadWitness> | undefined;
  let accepted: Awaited<ReturnType<typeof captureRecordAcceptedIntakeHeadRead>> | undefined;
  let retained = false;
  try {
    original = captureIntakeLegacyBridgeCommittedReadWitness(db, identity.intakeId);
    const heldOriginal = original;
    const request = { identity, sourceVersionId };
    const originalCurrent = () => {
      requestCheck();
      assertIntakeLegacyBridgeReadWitnessForSource(db, heldOriginal, identity.intakeId);
    };
    reader = openRecordCommittedColumnReader(db, (phase) => {
      if (phase === 'after-open') {
        requestCheck();
        completeIntakeLegacyBridgeCommittedOpening(db, heldOriginal);
      }
      originalCurrent();
    });
    accepted = await captureRecordAcceptedIntakeHeadRead(db, identity, originalCurrent, request);
    const admitted = accepted;
    const readerCheckpoint = () => {
      originalCurrent();
      recordAcceptedIntakeSourcePair(db, admitted, identity, request);
    };
    readerCheckpoint();
    recordAcceptedIntakeCurrentSourceDescriptor(db, accepted, identity, request);
    const pair = recordAcceptedIntakeSourcePair(db, accepted, identity, request);
    const after = locator();
    if (
      !after ||
      after.rowid !== before.rowid ||
      after.version_id !== before.version_id ||
      after.source_bytes !== before.source_bytes ||
      after.field_type !== before.field_type ||
      after.source_bytes !== BigInt(pair.sourceFacts.sourceBytes)
    )
      throw Error('Accepted source column locator changed');
    const expected =
      column === 'mime_type' ? pair.sourceFacts.mimeType : pair.sourceFacts.providerId;
    if (!expected) {
      if (before.field_type !== 'null') throw Error('Accepted source column null changed');
      readerCheckpoint();
      return null;
    }
    if (before.field_type !== 'text') throw Error('Accepted source column type changed');
    const hash = createHash('sha256');
    let bytes = 0;
    let preview: string | null = '';
    for (const part of reader.text('source_files', column, before.rowid)) {
      readerCheckpoint();
      const size = Buffer.byteLength(part);
      bytes += size;
      if (bytes > expected.bytes) throw Error('Accepted source column length differs');
      hash.update(part);
      if (preview !== null) {
        if (Buffer.byteLength(preview) + size <= 16 * 1024) preview += part;
        else preview = null;
      }
      if (reader.work().chunks % 32 === 0) await setImmediate();
    }
    readerCheckpoint();
    const terminal = locator();
    if (
      !terminal ||
      terminal.rowid !== before.rowid ||
      terminal.version_id !== before.version_id ||
      terminal.source_bytes !== before.source_bytes ||
      terminal.field_type !== before.field_type ||
      bytes !== expected.bytes ||
      hash.digest('hex') !== expected.hash
    )
      throw Error('Accepted source column differs from replay');
    const heldReader = reader;
    const heldAccepted = admitted;
    let closed = false;
    let paging = false;
    let nextOrdinal = 0;
    let pending = '';
    let parts: Iterator<string> | undefined;
    const exactCurrent = () => {
      originalCurrent();
      recordAcceptedIntakeCurrentSourceDescriptor(db, heldAccepted, identity, request);
      const current = locator();
      if (
        !current ||
        current.rowid !== before.rowid ||
        current.version_id !== before.version_id ||
        current.source_bytes !== before.source_bytes ||
        current.field_type !== before.field_type
      )
        throw Error('Accepted source column locator changed');
      readerCheckpoint();
    };
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        parts?.return?.();
      } finally {
        try {
          heldReader.close();
        } finally {
          try {
            closeRecordAcceptedIntakeHeadRead(heldAccepted);
          } finally {
            disposeIntakeLegacyBridgeReadWitness(heldOriginal);
          }
        }
      }
    };
    const scope: AcceptedIntakeSourceColumnScope = Object.freeze({
      bytes,
      hash: expected.hash,
      preview,
      get work() {
        return heldReader.work();
      },
      page(ordinal: number, limit: number, check: () => void) {
        if (
          closed ||
          paging ||
          !Number.isSafeInteger(ordinal) ||
          ordinal !== nextOrdinal ||
          !Number.isSafeInteger(limit) ||
          limit < 4 ||
          limit > 16 * 1024
        )
          throw Error('Accepted source column page unavailable');
        paging = true;
        requestCheck = check;
        try {
          exactCurrent();
          parts ??= heldReader.text('source_files', column, before.rowid)[Symbol.iterator]();
          let text = '';
          let size = 0;
          while (size < limit) {
            if (!pending) {
              const next = parts.next();
              if (next.done) break;
              pending = next.value;
              if (!pending) continue;
            }
            let used = 0;
            for (const scalar of pending) {
              const amount = Buffer.byteLength(scalar);
              if (size + amount > limit) break;
              text += scalar;
              size += amount;
              used += scalar.length;
            }
            pending = pending.slice(used);
            if (pending || size === limit) break;
          }
          exactCurrent();
          let complete = false;
          if (!pending) {
            const next = parts.next();
            complete = !!next.done;
            if (!next.done) pending = next.value;
          }
          exactCurrent();
          if (!complete && !text) throw Error('Accepted source column page made no progress');
          nextOrdinal++;
          if (complete) {
            close();
          }
          return { text, complete, nextOrdinal: complete ? null : nextOrdinal };
        } catch (error) {
          close();
          throw error;
        } finally {
          paging = false;
          requestCheck = () => {};
        }
      },
      close,
    });
    requestCheck = () => {};
    retained = true;
    return scope;
  } finally {
    if (!retained) {
      try {
        reader?.close();
      } finally {
        try {
          if (accepted) closeRecordAcceptedIntakeHeadRead(accepted);
        } finally {
          if (original) disposeIntakeLegacyBridgeReadWitness(original);
        }
      }
    }
  }
}

export async function readAcceptedIntakeSourceColumn(
  db: Database,
  identity: IntakeStateIdentity,
  sourceVersionId: string,
  column: 'mime_type' | 'provider_id',
  assertRunning: () => void,
): Promise<null | {
  bytes: number;
  hash: string;
  preview: string | null;
  work: Readonly<{ chunks: number; bytes: number; maxChunk: number }>;
}> {
  const scope = await openAcceptedIntakeSourceColumn(
    db,
    identity,
    sourceVersionId,
    column,
    assertRunning,
  );
  if (!scope) return null;
  try {
    return { bytes: scope.bytes, hash: scope.hash, preview: scope.preview, work: scope.work };
  } finally {
    scope.close();
  }
}
