/** Read-only selected source format proof for native V4 intakes. */
import { DatabaseSync, StatementSync, constants } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import type { Database } from './database.ts';
import {
  managedDatabaseMethodEpoch,
  observeManagedDatabaseAuthorization,
  rearmManagedDatabaseAuthorization,
} from './database.ts';
import {
  assertIntakeLegacyBridgeReadWitnessForSource,
  captureIntakeLegacyBridgeCommittedReadWitness,
  captureIntakeLegacyBridgeReadWitness,
  completeIntakeLegacyBridgeCommittedOpening,
  disposeIntakeLegacyBridgeReadWitness,
  type IntakeLegacyBridgeCommittedReadWitness,
  type IntakeLegacyBridgeReadWitness,
} from './intake-state-migration.ts';
import { ensureIntakeFrontierObserver } from './intake-lookup-frontier-observer.ts';
import {
  committedColumnShmTimestampRefusal,
  isCommittedColumnShmTimestampRefusal,
  openRecordCommittedColumnReader,
} from './record-committed-column-reader.ts';
import {
  assertRecordAcceptedSourcePreimage,
  captureRecordAcceptedSourceRead,
  closeRecordAcceptedSourceRead,
  recordAcceptedSourceHead,
  recordAcceptedSourcePair,
  borrowRecordAcceptedIntakeHeadRead,
  closeRecordAcceptedIntakeHeadRead,
  recordAcceptedSourceIncremental,
  verifyRecordAcceptedSourcePreimage,
  verifyRecordAcceptedSourceReadTerminal,
} from './record-versions.ts';
import type { RecordAcceptedIntakeHeadRead } from './record-versions.ts';
import { recordVersionWork } from './record-version-work.ts';
import type { RecordReplaySourcePair } from './record-replay-source-pair.ts';
import { prepareIntakeJsonCanonical } from './intake-json-canonical.ts';
import { hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';
import { assertAuthorizationSignalRunning } from './authorization-signal.ts';

const nativePrepare = DatabaseSync.prototype.prepare;
const nativeGet = StatementSync.prototype.get;
const nativeLocation = DatabaseSync.prototype.location;
const sourceSql = `SELECT CAST(rowid AS TEXT) AS rowid,
  id IS ? AS id_matches,kind IS 'intake_original' AS kind_matches,
  typeof(kind) AS kind_type,
  substr(sha256,1,65) AS sha256,sha256 IS substr(sha256,1,65) AS sha_complete,
  CASE WHEN typeof(bytes)='integer' THEN bytes END AS bytes,
  typeof(provider_id) AS provider_type,typeof(path) AS path_type,
  typeof(mime_type) AS mime_type,typeof(coverage_status) AS coverage_type,
  typeof(batch_id) AS batch_type,typeof(details_json) AS details_type
  FROM main.source_files WHERE id=?`;
const versionSql = `SELECT CAST(v.rowid AS TEXT) AS rowid,
  substr(c.version_id,1,129) AS version_id,
  c.version_id IS substr(c.version_id,1,129) AS version_complete,
  c.version_id IS v.version_id AS version_matches,
  CASE WHEN typeof(v.deleted)='integer' THEN v.deleted END AS deleted,
  v.profile_id IS ? AS profile_matches,v.entity IS 'source_files' AS entity_matches,
  v.record_id IS ? AS record_matches,typeof(v.contents_json) AS contents_type
  FROM main.__record_current c JOIN main.__record_versions v ON v.version_id=c.version_id
  WHERE c.entity='source_files' AND c.record_id=?`;

type Source = {
  rowid: string;
  id_matches: number;
  sha256: string;
  sha_complete: number;
  bytes: number | null;
  kind_matches: number;
  kind_type: string;
  provider_type: string;
  path_type: string;
  mime_type: string;
  coverage_type: string;
  batch_type: string;
  details_type: string;
};
type Version = {
  rowid: string;
  version_id: string;
  version_complete: number;
  version_matches: number;
  deleted: number | null;
  profile_matches: number;
  entity_matches: number;
  record_matches: number;
  contents_type: string;
};
type FileStamp = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;
type Interval = Readonly<{
  path: string;
  main: FileStamp;
  wal?: FileStamp;
  shm?: FileStamp;
  methods: object;
  schema: unknown;
  tempSchema: unknown;
  peer: unknown;
  writes: unknown;
}>;
type RetainedFormat = Readonly<{
  source: string;
  version: string;
  head: string;
  format: 'referenced' | 'legacy' | 'other' | 'unsupported';
  preimage: Readonly<{ hash: string; bytes: number }>;
  // Present only when a cold legacy read selected the parent from the same
  // verified preimage; the hot hit then needs no committed column reader.
  legacyParent?: Readonly<{ value: string | null | undefined }>;
  interval: Interval;
}>;
const retainedFormats = new WeakMap<Database, Map<string, RetainedFormat>>();
const MAX_RETAINED_FORMATS = 32;

function fileStamp(path: string): FileStamp | undefined {
  try {
    const value = lstatSync(path, { bigint: true });
    if (!value.isFile()) throw Error('Accepted intake source database file unavailable');
    return Object.freeze({
      dev: value.dev,
      ino: value.ino,
      size: value.size,
      mtimeNs: value.mtimeNs,
      ctimeNs: value.ctimeNs,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function sameFile(left: FileStamp | undefined, right: FileStamp | undefined): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined &&
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs;
}
function interval(db: Database): Interval {
  const path = Reflect.apply(nativeLocation, db, []) as string | null;
  const methods = managedDatabaseMethodEpoch(db);
  if (!path || !methods) throw Error('Accepted intake source interval unavailable');
  const main = fileStamp(path);
  if (!main) throw Error('Accepted intake source database file unavailable');
  const scalar = (sql: string, key: string) =>
    Reflect.apply(nativeGet, Reflect.apply(nativePrepare, db, [sql]), [])?.[key] as unknown;
  return Object.freeze({
    path,
    main,
    wal: fileStamp(path + '-wal'),
    shm: fileStamp(path + '-shm'),
    methods,
    schema: scalar('PRAGMA main.schema_version', 'schema_version'),
    tempSchema: scalar('PRAGMA temp.schema_version', 'schema_version'),
    peer: scalar('PRAGMA main.data_version', 'data_version'),
    writes: scalar('SELECT total_changes() AS n', 'n'),
  });
}
function sameInterval(left: Interval, right: Interval): boolean {
  return (
    left.path === right.path &&
    sameFile(left.main, right.main) &&
    sameFile(left.wal, right.wal) &&
    sameFile(left.shm, right.shm) &&
    left.methods === right.methods &&
    left.schema === right.schema &&
    left.tempSchema === right.tempSchema &&
    left.peer === right.peer &&
    left.writes === right.writes
  );
}
function shmTimestampOnlyIntervalMove(left: Interval, right: Interval): boolean {
  return (
    left.path === right.path &&
    sameFile(left.main, right.main) &&
    sameFile(left.wal, right.wal) &&
    !!left.shm &&
    !!right.shm &&
    left.shm.dev === right.shm.dev &&
    left.shm.ino === right.shm.ino &&
    left.shm.size === right.shm.size &&
    !sameFile(left.shm, right.shm) &&
    left.methods === right.methods &&
    left.schema === right.schema &&
    left.tempSchema === right.tempSchema &&
    left.peer === right.peer &&
    left.writes === right.writes
  );
}
/** Everything in the interval except what this connection's own writes move
 * (WAL/SHM stamps, temp schema, total changes). Concurrent same-connection
 * writes are attributed by the authorizer instead. */
function sameIdentity(left: Interval, right: Interval): boolean {
  return (
    left.path === right.path &&
    sameFile(left.main, right.main) &&
    left.methods === right.methods &&
    left.schema === right.schema &&
    left.peer === right.peer
  );
}
const READ_ACTIONS: ReadonlySet<number> = new Set([
  constants.SQLITE_SELECT,
  constants.SQLITE_READ,
  constants.SQLITE_FUNCTION,
  constants.SQLITE_RECURSIVE,
]);
export interface AcceptedSourceFileFormatScope {
  readonly format: 'referenced' | 'legacy' | 'other' | 'unsupported';
  assertCurrent(): void;
  legacyParent(): string | null | undefined;
  acceptedPair(): RecordReplaySourcePair;
  borrowHead(): Readonly<{
    identity: Readonly<{ profileId: string; intakeId: string; sourceHash: string }>;
    sourceVersionId: string;
    original: IntakeLegacyBridgeReadWitness;
    accepted: RecordAcceptedIntakeHeadRead;
  }>;
  verifyTerminal(): Promise<void>;
  abort(): void;
  close(): void;
}
export interface AcceptedNativeIntakeSourceFormatScope extends AcceptedSourceFileFormatScope {
  readonly format: 'referenced' | 'legacy';
}

/** SQL identifies candidate rowids; only the original-backed certificate can
 * admit their streamed exact preimage and therefore the format decision. */
async function captureAcceptedNativeIntakeSourceFormat(
  db: Database,
  profileId: string,
  intakeId: string,
  assertRunning: () => void,
  pairCandidate: boolean,
  selectLegacyParent: boolean,
  allowOther: boolean,
): Promise<AcceptedSourceFileFormatScope> {
  assertRunning();
  ensureIntakeFrontierObserver(db);
  const source = Reflect.apply(nativePrepare, db, [sourceSql]) as StatementSync;
  const version = Reflect.apply(nativePrepare, db, [versionSql]) as StatementSync;
  const recordId = JSON.stringify([intakeId]);
  const locate = () => ({
    source: Reflect.apply(nativeGet, source, [intakeId, intakeId]) as Source | undefined,
    version: Reflect.apply(nativeGet, version, [profileId, recordId, recordId]) as
      Version | undefined,
  });
  const before = locate();
  const row = before.source;
  const selected = before.version;
  if (
    !row ||
    !selected ||
    row.id_matches !== 1 ||
    (row.kind_matches !== 0 && row.kind_matches !== 1) ||
    row.kind_type !== 'text' ||
    row.sha_complete !== 1 ||
    !/^[a-f0-9]{64}$/.test(row.sha256) ||
    typeof row.bytes !== 'number' ||
    !Number.isSafeInteger(row.bytes) ||
    row.bytes < 0 ||
    !/^-?[0-9]+$/.test(row.rowid) ||
    !/^-?[0-9]+$/.test(selected.rowid) ||
    selected.profile_matches !== 1 ||
    selected.entity_matches !== 1 ||
    selected.record_matches !== 1 ||
    selected.version_matches !== 1 ||
    selected.version_complete !== 1 ||
    selected.deleted !== 0 ||
    selected.contents_type !== 'text' ||
    typeof selected.version_id !== 'string' ||
    row.path_type !== 'text' ||
    row.mime_type !== 'text' ||
    row.coverage_type !== 'text' ||
    row.details_type !== 'text' ||
    (row.provider_type !== 'text' && row.provider_type !== 'null') ||
    (row.batch_type !== 'text' && row.batch_type !== 'null')
  )
    throw Error('Accepted intake source locator unavailable');
  const cacheKey = JSON.stringify([profileId, intakeId]);
  const cachedFormats = retainedFormats.get(db);
  const candidate = cachedFormats?.get(cacheKey);
  const openingInterval = interval(db);
  // A legacy parent decision needs the committed column reader, whose own
  // snapshot opening changes the physical interval. It is a hot hit only when
  // the retained entry already holds the parent selected from its preimage.
  const cached =
    candidate &&
    !(selectLegacyParent && candidate.format === 'legacy' && !candidate.legacyParent) &&
    candidate.source === JSON.stringify(row) &&
    candidate.version === JSON.stringify(selected) &&
    sameInterval(candidate.interval, openingInterval)
      ? candidate
      : undefined;
  if (candidate && !cached) cachedFormats?.delete(cacheKey);
  let committedOriginal: IntakeLegacyBridgeCommittedReadWitness | undefined;
  let original: IntakeLegacyBridgeReadWitness;
  if (cached) original = captureIntakeLegacyBridgeReadWitness(db, intakeId);
  else {
    committedOriginal = captureIntakeLegacyBridgeCommittedReadWitness(db, intakeId);
    original = committedOriginal;
  }
  let reader: ReturnType<typeof openRecordCommittedColumnReader> | undefined;
  let accepted: Awaited<ReturnType<typeof captureRecordAcceptedSourceRead>> | undefined;
  let admitted = false;
  let terminal = false;
  let terminalVerified = false;
  let aborted = false;
  let retainRefusedBackend = false;
  let legacyParent: string | null | undefined;
  try {
    const originalCurrent = () => {
      if (!terminal) assertRunning();
      assertIntakeLegacyBridgeReadWitnessForSource(db, original, intakeId);
      const now = locate();
      if (
        JSON.stringify(now.source) !== JSON.stringify(row) ||
        JSON.stringify(now.version) !== JSON.stringify(selected)
      )
        throw Error('Accepted intake source locator changed');
      if (cached) {
        const current = interval(db);
        if (!sameInterval(cached.interval, current)) {
          cachedFormats?.delete(cacheKey);
          throw shmTimestampOnlyIntervalMove(cached.interval, current)
            ? committedColumnShmTimestampRefusal('Accepted intake source retained interval changed')
            : Error('Accepted intake source retained interval changed');
        }
      }
    };
    let readerCurrent = originalCurrent;
    if (committedOriginal) {
      const opening = committedOriginal;
      reader = openRecordCommittedColumnReader(db, (phase) => {
        if (phase === 'after-open') {
          assertRunning();
          completeIntakeLegacyBridgeCommittedOpening(db, opening);
        }
        readerCurrent();
      });
    }
    // Legacy source IDs may exceed the V4 identity limit. Establish their
    // accepted format before requiring an optional V4 pair identity.
    const pairIdentityEligible =
      row.kind_matches === 1 &&
      Buffer.byteLength(profileId) <= 256 &&
      Buffer.byteLength(intakeId) <= 256;
    const pairRequest =
      pairCandidate && pairIdentityEligible
        ? Object.freeze({
            identity: Object.freeze({ profileId, intakeId, sourceHash: row.sha256 }),
            sourceVersionId: selected.version_id,
          })
        : undefined;
    accepted = await captureRecordAcceptedSourceRead(db, profileId, originalCurrent, pairRequest);
    const held = accepted;
    const currentHead = recordAcceptedSourceHead(db, held, profileId);
    if (cached && cached.head !== currentHead)
      throw Error('Accepted intake source retained head changed');
    readerCurrent = () => {
      if (recordAcceptedSourceHead(db, held, profileId) !== currentHead)
        throw Error('Accepted intake source record HEAD changed');
    };
    readerCurrent();
    if (cached) {
      assertRecordAcceptedSourcePreimage(
        db,
        held,
        profileId,
        recordId,
        selected.version_id,
        cached.preimage,
      );
      recordVersionWork('acceptedSourceFormatHotHits');
      readerCurrent();
    }
    let preimage: { hash: string; bytes: number } | undefined;
    let format: 'referenced' | 'legacy' | 'other' | 'unsupported';
    if (cached) format = cached.format;
    else {
      if (!reader) throw Error('Accepted intake source committed reader unavailable');
      recordVersionWork('acceptedSourceFormatColdReads');
      const heldReader = reader;
      const sourceRowid = BigInt(row.rowid);
      const versionRowid = BigInt(selected.rowid);
      const columns: Record<string, unknown> = {
        id: intakeId,
        provider_id: row.provider_type === 'null' ? null : undefined,
        path: undefined,
        sha256: row.sha256,
        bytes: row.bytes,
        mime_type: undefined,
        kind: row.kind_matches === 1 ? 'intake_original' : undefined,
        coverage_status: undefined,
        batch_id: row.batch_type === 'null' ? null : undefined,
        details_json: undefined,
      };
      const text = (name: string) => heldReader.text('source_files', name, sourceRowid);
      const streamed = (name: string) => {
        if (name === 'kind' && row.kind_matches === 0) return text(name);
        if (name === 'provider_id' && row.provider_type === 'null') return undefined;
        if (name === 'batch_id' && row.batch_type === 'null') return undefined;
        return name === 'provider_id' ||
          name === 'path' ||
          name === 'mime_type' ||
          name === 'coverage_status' ||
          name === 'batch_id'
          ? text(name)
          : undefined;
      };
      preimage = await verifyRecordAcceptedSourcePreimage(
        db,
        held,
        profileId,
        recordId,
        selected.version_id,
        columns,
        () => text('details_json'),
        streamed,
        () => heldReader.text('__record_versions', 'contents_json', versionRowid),
        readerCurrent,
      );
      readerCurrent();
      let selectedFormat: 'referenced' | 'legacy' | 'other' | 'unsupported' | undefined;
      if (row.kind_matches === 0) selectedFormat = 'other';
      else {
        let prefix = '';
        for (const piece of text('details_json')) {
          readerCurrent();
          prefix += piece.slice(0, 96 - prefix.length);
          if (prefix.length === 96) break;
        }
        readerCurrent();
        selectedFormat = prefix.startsWith(
          '{"intakeAuthority":{"format":"health-intake-envelope-v3"',
        )
          ? 'referenced'
          : prefix.startsWith('{"intakeAuthority":{"format":"health-intake-envelope-v1"') ||
              prefix.startsWith('{"intakeAuthority":{"format":"health-intake-envelope-v2"')
            ? 'legacy'
            : undefined;
      }
      if (!selectedFormat) selectedFormat = 'unsupported';
      format = selectedFormat;
    }
    if (pairCandidate && format === 'referenced' && !pairRequest)
      throw Error('Accepted referenced intake identity unsupported');
    if ((format === 'other' || format === 'unsupported') && !allowOther)
      throw Error('Accepted intake source format unsupported');
    if (selectLegacyParent && format === 'legacy' && cached) {
      if (!cached.legacyParent) throw Error('Accepted legacy parent unavailable');
      legacyParent = cached.legacyParent.value;
      readerCurrent();
    } else if (selectLegacyParent && format === 'legacy') {
      if (!reader) throw Error('Accepted legacy parent reader unavailable');
      const heldReader = reader;
      const tree = await prepareIntakeJsonCanonical(
        heldReader.text('source_files', 'details_json', BigInt(row.rowid)),
        { mode: 'stringify', assertRunning: readerCurrent },
      );
      try {
        readerCurrent();
        const intake = tree.field(tree.root, 'intake');
        if (!intake || tree.kind(intake) !== 'object')
          throw Error('Accepted legacy intake header unavailable');
        const parent = tree.field(intake, 'parentSourceFileId');
        if (parent) {
          if (tree.kind(parent) === 'null') legacyParent = null;
          else if (tree.kind(parent) === 'string') {
            let decoded = '';
            const steps = hashIntakeJsonScalarSteps(tree.pieces(parent), [], (unit) => {
              decoded += unit;
            });
            try {
              for (;;) {
                const next = steps.next();
                if (next.done) break;
                await setImmediate();
                readerCurrent();
              }
            } finally {
              steps.return(undefined as never);
            }
            legacyParent = decoded;
          } else throw Error('Accepted legacy parent is not a string');
        }
        readerCurrent();
      } finally {
        tree.close();
      }
    }
    reader?.close();
    reader = undefined;
    let closed = false;
    admitted = true;
    return Object.freeze({
      format,
      assertCurrent() {
        if (closed) throw Error('Accepted intake source format read closed');
        readerCurrent();
      },
      legacyParent() {
        if (closed || format !== 'legacy' || !selectLegacyParent)
          throw Error('Accepted legacy parent unavailable');
        readerCurrent();
        return legacyParent;
      },
      acceptedPair() {
        if (closed || format !== 'referenced' || !pairRequest)
          throw Error('Accepted intake source pair unavailable');
        return recordAcceptedSourcePair(db, held, profileId, pairRequest);
      },
      borrowHead() {
        if (closed || format !== 'referenced' || !pairRequest)
          throw Error('Accepted intake source head borrow unavailable');
        const accepted = borrowRecordAcceptedIntakeHeadRead(
          db,
          held,
          pairRequest.identity,
          pairRequest,
        );
        try {
          return Object.freeze({
            identity: pairRequest.identity,
            sourceVersionId: pairRequest.sourceVersionId,
            original,
            accepted,
          });
        } catch (error) {
          closeRecordAcceptedIntakeHeadRead(accepted);
          throw error;
        }
      },
      async verifyTerminal() {
        if (closed || terminal) throw Error('Accepted intake source terminal read expired');
        readerCurrent();
        terminal = true;
        await verifyRecordAcceptedSourceReadTerminal(db, held, profileId);
        readerCurrent();
        terminalVerified = true;
      },
      abort() {
        aborted = true;
      },
      close() {
        if (closed) return;
        closed = true;
        if (!terminalVerified || aborted) cachedFormats?.delete(cacheKey);
        let finalInterval: Interval | undefined;
        let closeFailed = true;
        try {
          try {
            readerCurrent();
            finalInterval = interval(db);
          } finally {
            try {
              // A refusal before the terminal proof began (the consumer's own,
              // or a moved interval) does not impeach the adapter's verified
              // replay: it may be retained, and every reuse is gated again by
              // the adapter's frontier checks and a complete acquire. A failed
              // or skipped terminal proof never retains.
              closeRecordAcceptedSourceRead(
                held,
                terminalVerified ? !aborted : aborted && !terminal,
              );
            } finally {
              disposeIntakeLegacyBridgeReadWitness(original);
            }
          }
          closeFailed = false;
        } finally {
          if (closeFailed) cachedFormats?.delete(cacheKey);
        }
        if (
          terminalVerified &&
          !aborted &&
          finalInterval &&
          !cached &&
          preimage &&
          sameInterval(finalInterval, interval(db))
        ) {
          const entries = cachedFormats ?? new Map<string, RetainedFormat>();
          if (!cachedFormats) retainedFormats.set(db, entries);
          entries.delete(cacheKey);
          if (entries.size === MAX_RETAINED_FORMATS) entries.delete(entries.keys().next().value!);
          entries.set(
            cacheKey,
            Object.freeze({
              source: JSON.stringify(row),
              version: JSON.stringify(selected),
              head: currentHead,
              format,
              preimage: Object.freeze({ ...preimage }),
              ...(selectLegacyParent && format === 'legacy'
                ? { legacyParent: Object.freeze({ value: legacyParent }) }
                : {}),
              interval: finalInterval,
            }),
          );
        }
      },
    });
  } catch (error) {
    // Keep only a completed immutable-record derivative, never the refused
    // source preimage or format. The next attempt proves the source anew.
    retainRefusedBackend = !!accepted && isCommittedColumnShmTimestampRefusal(error);
    throw error;
  } finally {
    if (!admitted) {
      if (cached) cachedFormats?.delete(cacheKey);
      try {
        if (reader) reader.close();
      } finally {
        try {
          if (accepted) {
            if (retainRefusedBackend) {
              try {
                recordAcceptedSourceHead(db, accepted, profileId);
              } catch {
                retainRefusedBackend = false;
              }
            }
            closeRecordAcceptedSourceRead(accepted, retainRefusedBackend);
          }
        } finally {
          disposeIntakeLegacyBridgeReadWitness(original);
        }
      }
    }
  }
}

/** Routing only, never authorization. Hot paths take the accepted reader
 * for every row only where the attached adapter reuses and incrementally
 * advances its proof (contributor storage). Without durability there is no
 * accepted history. A vault-routed correction reload now keeps its frontier
 * (committed-reader openings no longer step the peer counter: 0 retries and
 * 0 cold replays in intake-accepted-source-correction-reload.test.ts), but the
 * browser correction flow still refuses concurrent work inside the longer
 * vault proofs: GET-path temp maintenance (first `__intake_queue_transitions`
 * install, reader-index and source-attention installs) rotates the method
 * epoch and temp schema under held legacy-bridge reads, and identity-review
 * and report-queue reads then answer `SOURCE_CHANGED` or
 * `REPORT_QUEUE_CURSOR` (import-field-correction.test.ts). Vault keeps its
 * existing readers except where only the accepted proof can decode a row.
 * Once the accepted reader is chosen, every refusal stands. */
export function acceptedSourceReaderAttached(db: Database): boolean {
  return recordAcceptedSourceIncremental(db);
}

export interface AcceptedSourceFormatOptions {
  /** The consumer is a pure read: a failed attempt may be repeated from a
   * complete new proof even after the consumer ran. Otherwise only failures
   * before the consumer starts are repeated. */
  idempotent?: boolean;
}

// One accepted proof per connection at a time, FIFO, from capture to close.
// Nested reads inside a held proof (same async context) do not queue.
const admissionTails = new WeakMap<Database, Promise<void>>();
const heldAdmissions = new AsyncLocalStorage<ReadonlySet<Database>>();
const ADMISSION_POLL_MS = 5;
const TRANSACTION_WAIT_MS = 30_000;
const MAX_PROOF_ATTEMPTS = 4;
/** Additional complete proofs allowed while every move is explained by this
 * process's own concurrent writes on the same connection (other requests
 * outside this held proof). Unexplained moves keep MAX_PROOF_ATTEMPTS. */
const MAX_CONCURRENT_WRITE_RETRIES = 16;

async function withAcceptedSourceAdmission<T>(
  db: Database,
  assertRunning: () => void,
  run: () => Promise<T>,
): Promise<T> {
  assertRunning();
  const held = heldAdmissions.getStore();
  if (held?.has(db)) return run();
  const heldPrevious = admissionTails.get(db);
  const previous = heldPrevious ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  admissionTails.set(db, tail);
  try {
    let settled = !heldPrevious;
    if (heldPrevious) void previous.then(() => (settled = true));
    while (!settled) {
      assertRunning();
      recordVersionWork('acceptedSourceAdmissionWaits');
      await Promise.race([previous, delay(ADMISSION_POLL_MS)]);
    }
    assertRunning();
    return await heldAdmissions.run(new Set([...(held ?? []), db]), run);
  } finally {
    release();
    if (admissionTails.get(db) === tail) admissionTails.delete(db);
  }
}

/** GET-path temp maintenance (reader-coverage store rebuilds and warm
 * passes) takes the same per-connection FIFO admission as a proof, so its
 * temp writes and authorizer swaps never land inside another request's proof
 * interval; that proof would otherwise refuse, and the content route cannot
 * repeat after its headers. Inside a held proof it runs directly, in that
 * proof's own interval. It grants no authority: every proof that follows is
 * still complete and still refuses any unexplained change. */
export function withAcceptedSourceMaintenanceAdmission<T>(
  db: Database,
  assertRunning: () => void,
  run: () => Promise<T>,
): Promise<T> {
  return withAcceptedSourceAdmission(db, assertRunning, run);
}

/** An accepted proof never observes an open transaction; it waits for the
 * holder to finish (bounded) instead of refusing. */
async function awaitIdleConnection(db: Database, assertRunning: () => void): Promise<void> {
  const deadline = Date.now() + TRANSACTION_WAIT_MS;
  while (db.isTransaction) {
    assertRunning();
    if (Date.now() > deadline)
      throw Error('Accepted source read waited too long for a transaction');
    recordVersionWork('acceptedSourceTransactionWaits');
    await delay(ADMISSION_POLL_MS);
  }
}

/** Per-connection counters of writes authorized outside any held accepted
 * proof, and of authorization policy changes. Registered once per connection
 * (a stable observer set; transient observers would perturb in-flight
 * changeset authorization). Used only to choose a retry budget. */
const concurrentWriteWatches = new WeakMap<Database, { writes: number; policies: number }>();
function concurrentWriteWatch(db: Database): { writes: number; policies: number } {
  let watch = concurrentWriteWatches.get(db);
  if (watch) return watch;
  const created = { writes: 0, policies: 0 };
  if (
    !observeManagedDatabaseAuthorization(
      db,
      (action) => {
        if (!READ_ACTIONS.has(action) && !heldAdmissions.getStore()?.has(db)) created.writes++;
      },
      () => void created.policies++,
    )
  )
    throw Error('Accepted intake source authorizer unavailable');
  concurrentWriteWatches.set(db, (watch = created));
  return watch;
}

/** Whole-proof retry. A refused attempt is repeated only when the selected
 * connection interval visibly moved during it: an open transaction, a write
 * authorized on this connection outside this held proof, an authorization
 * policy change, or a changed database file, schema, method or peer counter.
 * The proof's own work never counts as a move, so an unchanged refusal stands
 * after one attempt. Moves explained only by this process's concurrent writes
 * on the same connection (same file, peer counter, schema and policy) get a
 * larger bounded budget than unexplained ones. Classification only chooses the
 * budget: each attempt proves the source and format anew. A clean, completed
 * immutable-record derivative may survive a refused source attempt; no refused
 * source preimage, format, or caller scope is reused or accepted. */
async function withAcceptedSourceAttempts<T, S extends AcceptedSourceFileFormatScope>(
  db: Database,
  assertRunning: () => void,
  capture: () => Promise<S>,
  consume: (scope: S) => Promise<T> | T,
  signal: AbortSignal | undefined,
  options: AcceptedSourceFormatOptions,
): Promise<T> {
  return withAcceptedSourceAdmission(db, assertRunning, async () => {
    const watch = concurrentWriteWatch(db);
    let unexplained = 0,
      explainedRetries = 0;
    for (;;) {
      await awaitIdleConnection(db, assertRunning);
      // Expire prepared authorization decisions so a cached concurrent
      // writer is authorized (and observed) again during this attempt. A
      // write the watch misses only makes the refusal stand.
      if (!rearmManagedDatabaseAuthorization(db))
        throw Error('Accepted intake source authorizer unavailable');
      const writes = watch.writes,
        policies = watch.policies;
      // The proof's own capture may rotate the method epoch and touch temp
      // state; the attempt is judged from where its capture left the
      // connection. Writes are counted from before the capture.
      let before = interval(db),
        consumed = false;
      try {
        const scope = await capture();
        before = interval(db);
        return await withCapturedSourceFormat(
          scope,
          (admitted) => {
            consumed = true;
            return consume(admitted);
          },
          signal,
        );
      } catch (error) {
        assertRunning();
        if (signal) assertAuthorizationSignalRunning(signal);
        let identity = false,
          current: Interval | undefined;
        try {
          current = interval(db);
          identity = sameIdentity(before, current);
        } catch {
          identity = false;
        }
        const concurrentWrite = watch.writes !== writes,
          policyChanged = watch.policies !== policies,
          moved = db.isTransaction || concurrentWrite || policyChanged || !identity;
        if (isCommittedColumnShmTimestampRefusal(error)) {
          if (
            consumed ||
            db.isTransaction ||
            concurrentWrite ||
            policyChanged ||
            !current ||
            !shmTimestampOnlyIntervalMove(before, current) ||
            ++unexplained >= MAX_PROOF_ATTEMPTS
          )
            throw error;
          retainedFormats.delete(db);
          recordVersionWork('acceptedSourceProofRetries');
          continue;
        }
        if (!moved || (consumed && !options.idempotent)) throw error;
        const explained = concurrentWrite && !policyChanged && identity;
        if (
          explained
            ? ++explainedRetries > MAX_CONCURRENT_WRITE_RETRIES
            : ++unexplained >= MAX_PROOF_ATTEMPTS
        )
          throw error;
        recordVersionWork('acceptedSourceProofRetries');
        if (explained) recordVersionWork('acceptedSourceConcurrentWriteRetries');
      }
    }
  });
}

export async function withAcceptedNativeIntakeSourceFormat<T>(
  db: Database,
  profileId: string,
  intakeId: string,
  assertRunning: () => void,
  consume: (scope: AcceptedNativeIntakeSourceFormatScope) => Promise<T> | T,
  // Observation request only. The selected source preimage still decides format.
  pairCandidate = false,
  selectLegacyParent = false,
  options: AcceptedSourceFormatOptions = {},
): Promise<T> {
  return withAcceptedSourceAttempts(
    db,
    assertRunning,
    async () =>
      // The private capture refuses `other` before admission when allowOther=false.
      (await captureAcceptedNativeIntakeSourceFormat(
        db,
        profileId,
        intakeId,
        assertRunning,
        pairCandidate,
        selectLegacyParent,
        false,
      )) as AcceptedNativeIntakeSourceFormatScope,
    consume,
    undefined,
    options,
  );
}

/** A selected non-intake kind is established by the same complete source
 * preimage proof, so a rewritten V3 row cannot authorize a generic fallback. */
export async function withAcceptedSourceFileFormat<T>(
  db: Database,
  profileId: string,
  sourceId: string,
  assertRunning: () => void,
  consume: (scope: AcceptedSourceFileFormatScope) => Promise<T> | T,
  signal?: AbortSignal,
  options: AcceptedSourceFormatOptions = {},
): Promise<T> {
  return withAcceptedSourceAttempts(
    db,
    assertRunning,
    () =>
      captureAcceptedNativeIntakeSourceFormat(
        db,
        profileId,
        sourceId,
        assertRunning,
        false,
        false,
        true,
      ),
    consume,
    signal,
    options,
  );
}

async function withCapturedSourceFormat<T, S extends AcceptedSourceFileFormatScope>(
  scope: S,
  consume: (scope: S) => Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  let failed = false;
  let failure: unknown;
  try {
    scope.assertCurrent();
    const result = await consume(scope);
    await scope.verifyTerminal();
    if (signal) assertAuthorizationSignalRunning(signal);
    scope.assertCurrent();
    return result;
  } catch (error) {
    failed = true;
    failure = error;
    scope.abort();
    throw error;
  } finally {
    try {
      scope.close();
    } catch (closeError) {
      if (failed)
        throw new AggregateError(
          [failure, closeError],
          'Accepted intake source format read failed',
        );
      throw closeError;
    }
  }
}
