import { Worker } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createHash,
  createHmac,
  createSecretKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setImmediate as yieldHost } from 'node:timers/promises';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Database } from './database.ts';
import type { IntakeTreeRoot } from './intake-state-tree.ts';
import { intakeTreeRef } from './intake-state-tree.ts';
import { intakeNamespace } from './intake-state-evidence.ts';
import { vaultRecordCertificates } from './vault-record-certificates.ts';
import { recordVersionWork } from './record-version-work.ts';
import { captureRecordHeadPhysical } from './record-head-physical.ts';
import {
  MAX_CERTIFICATE_DELTA_CHUNK_BYTES,
  certificateDeltaHead,
  checkedCertificateDeltaChunk,
  checkedCertificateDeltaTerminal,
  type ContributorCertificateDelta,
} from './contributor-certificate-delta.ts';
import { unlockPhysicalEntries, unlockPhysicalIdentity } from './encrypted-unlock-physical.ts';
import { recordFieldDigest, recordStringFieldDigest } from './record-prior-fields.ts';
import type {
  RecordReplaySourcePair,
  RecordReplaySourcePairRequest,
} from './record-replay-source-pair.ts';
import {
  checkedRecordReplaySourcePair,
  signRecordReplaySourcePair,
  signRecordReplaySourcePairSelection,
} from './record-replay-source-pair.ts';
import {
  consumeContributorRecordBackingAdvance,
  consumeContributorRecordBackingPublication,
  verifiedContributorRecordBackingVersions,
  verifiedContributorRecordOriginalArtifacts,
  verifiedContributorRecordOriginalSources,
  contributorRecordTerminalExecutionCurrent,
  sealContributorRecordTerminalWorker,
  contributorRecordBackingPlanCurrent,
  runContributorRecordTerminalExecution,
  type ContributorRecordTerminalExecution,
  type ContributorRecordBackingPlan,
  type ContributorRecordIndexedPublication,
} from './record-versions.ts';
import {
  contributorRecordBackingLocation,
  contributorRecordReadOwnerCurrent,
  contributorRecordReadOwnerHeadBytes,
  takeContributorRecordOwnPublication,
  captureContributorRecordWriteWitness,
  contributorRecordWriteWitnessCurrent,
  contributorRecordWriteWitnessSequence,
  closeContributorRecordWriteWitness,
  stageContributorRecordFactoryObject,
  prepareContributorRecordHeadPublication,
  contributorRecordHeadPublicationCurrent,
  installContributorRecordHeadPublication,
  closeContributorRecordHeadPublication,
  closeContributorRecordReadOwner,
  captureContributorRecordReadOwner,
  contributorRecordReadOwnersSameSelection,
  captureContributorRecordInstalledReadOwner,
  registerContributorRecordStagingDisposal,
  type ContributorRecordReadOwner,
  type ContributorRecordWriteWitness,
  type ContributorRecordHeadPublication,
} from './contributor-record-storage.ts';

export interface ContributorRecordBackingInput {
  mode: 'prepare' | 'verify' | 'advance';
  root: string;
  profileId: string;
  base: string;
  marker: string;
  selectedHead: string;
  database: string;
  physical: string;
  nonce: string;
  signatureKey: Uint8Array;
  checkpointControl: SharedArrayBuffer;
  entries?: number;
  originalArtifacts?: number;
  originalSources?: number;
  objectsIdentity?: string;
  objectsSignature?: string;
  pair?: RecordReplaySourcePairRequest;
  readOnlyPairCandidate?: boolean;
  /** verify only: re-verification of a retained backing at capture, before
   * any consumer. The checks are identical; only the terminal proof carries
   * the 'final-verify' checkpoint phase. */
  retainedCapture?: boolean;
  /** advance only: exact HEAD bytes this process published, oldest first. */
  ownHeads?: string[];
  /** advance only: physical objects added by those publications. */
  ownObjects?: string[];
}
/** Bound on own publications retained before a full replay is preferred. */
const MAX_OWN_HEADS = 256;
const replayResidue = ['-wal', '-shm', '-journal'];

declare const stagingBrand: unique symbol;
export interface ContributorRecordStagingWitness {
  readonly [stagingBrand]: true;
}
interface StagingData {
  db: Database;
  storage: object;
  original: ContributorRecordReadOwner;
  writes: ContributorRecordWriteWitness;
  location: { root: string; profileId: string; base: string; marker: string };
  staged: number;
  preparationAttempted: boolean;
  callerCheckWithoutPrepared?: boolean;
  prepared?: {
    session: BackingWorkerSession;
    scratch: string;
    sql: DatabaseSync;
    input: ContributorRecordBackingInput;
    root: IntakeTreeRoot;
    entries: number;
    sourcePair?: RecordReplaySourcePair;
    /** The exact request the retained pair answers; never reused for another. */
    sourcePairRequest?: string;
    optionalPairSelection?: {
      request: string;
      selectedHead: string;
      signature: string;
      absent: boolean;
      replay: ReturnType<typeof captureRecordHeadPhysical>;
    };
    /** File identity of the retained replay projection between workers. */
    replay?: ReturnType<typeof captureRecordHeadPhysical>;
    expectedChanges: bigint;
    schema: unknown;
    tempSchema: unknown;
    dataVersion: unknown;
    statements: {
      changes: StatementSync;
      schema: StatementSync;
      tempSchema: StatementSync;
      dataVersion: StatementSync;
      insert: StatementSync;
      lookup: StatementSync;
      count: StatementSync;
      own: StatementSync;
      promote: StatementSync;
      replace: StatementSync;
      clearOwn: StatementSync;
      clearSources: StatementSync;
      clearArtifacts: StatementSync;
      physicalRow: StatementSync;
    };
    physical?: ReturnType<typeof captureRecordHeadPhysical>;
  };
  head?: ContributorRecordHeadPublication;
  candidateHead?: string;
  pending?: {
    root: IntakeTreeRoot;
    head: string;
    plan: ContributorRecordBackingPlan;
    versionIds: string[];
  };
  finished: boolean;
  finalAttempted: boolean;
  closed: boolean;
  reused?: boolean;
  readOnly?: boolean;
  installed?: boolean;
  installedSuccessor?: ContributorRecordReadOwner;
  installedParents?: readonly { path: string; kind: 'file' | 'directory'; identity: string }[];
}
const witnesses = new WeakMap<ContributorRecordStagingWitness, StagingData>();
interface RetainedFrontier {
  db: Database;
  original: ContributorRecordReadOwner;
  prepared: NonNullable<StagingData['prepared']>;
  poisoned: boolean;
  active: boolean;
  /** Exact HEAD bytes of this process's own publications after
   * prepared.input.selectedHead, not yet folded into the replay. */
  ownHeads?: string[];
  ownObjects?: string[];
  /** Own HEADs queued since the last complete physical-roster reconciliation. */
  provisionalHeads?: number;
  provisionalObjects?: readonly { name: string; identity: string }[];
}
const frontiers = new WeakMap<object, RetainedFrontier>();
declare const acceptedHeadReadBrand: unique symbol;
export interface ContributorRecordAcceptedHeadRead {
  readonly [acceptedHeadReadBrand]: true;
}
declare const acceptedSourceReadBrand: unique symbol;
export interface ContributorRecordAcceptedSourceRead {
  readonly [acceptedSourceReadBrand]: true;
}
const acceptedHeadReads = new WeakMap<
  ContributorRecordAcceptedHeadRead | ContributorRecordAcceptedSourceRead,
  {
    witness: ContributorRecordStagingWitness;
    original: ContributorRecordReadOwner;
    key: string;
    value: string;
    db: Database;
    current: () => void;
    pair?: RecordReplaySourcePairRequest;
    sourceProven?: boolean;
  }
>();
const closedStorages = new WeakSet<object>();
const storageResources = new WeakMap<
  object,
  {
    active: Set<ContributorRecordStagingWitness>;
    release(): void;
  }
>();
const nativePrepare = DatabaseSync.prototype.prepare,
  nativeClose = DatabaseSync.prototype.close,
  nativeGet = StatementSync.prototype.get,
  nativeRun = StatementSync.prototype.run;
const get = (statement: StatementSync, ...args: unknown[]) =>
  Reflect.apply(nativeGet, statement, args) as ReturnType<StatementSync['get']>;
const run = (statement: StatementSync, ...args: unknown[]) =>
  Reflect.apply(nativeRun, statement, args) as ReturnType<StatementSync['run']>;
const closingPrepared = new WeakSet<object>();
function live(data: StagingData): void {
  if (
    data.closed ||
    !contributorRecordReadOwnerCurrent(data.storage, data.original) ||
    !contributorRecordWriteWitnessCurrent(data.storage, data.writes)
  )
    throw Error('Contributor original staging owner changed');
}
function closePrepared(prepared: NonNullable<StagingData['prepared']>): void {
  if (closingPrepared.has(prepared)) return;
  closingPrepared.add(prepared);
  prepared.input.signatureKey.fill(0);
  const cleanup = () => {
    try {
      prepared.physical?.close();
    } finally {
      try {
        prepared.replay?.close();
      } finally {
        try {
          if (prepared.sql.isOpen) Reflect.apply(nativeClose, prepared.sql, []);
        } finally {
          rmSync(prepared.scratch, { recursive: true, force: true });
        }
      }
    }
  };
  void prepared.session
    .close()
    .then(cleanup)
    .catch(() =>
      process.emitWarning('Contributor backing scratch cleanup failed', {
        code: 'CONTRIBUTOR_BACKING_CLEANUP',
      }),
    );
}
function retainedScratch(data: StagingData, prepared: NonNullable<StagingData['prepared']>) {
  if (data.closed || data.prepared !== prepared || !prepared.sql.isOpen)
    throw Error('Contributor original backing unavailable');
  const { statements } = prepared;
  if (
    contributorRecordWriteWitnessSequence(data.storage, data.writes) !== BigInt(data.staged) ||
    BigInt(String(get(statements.changes)!.n)) !== prepared.expectedChanges ||
    get(statements.schema)!.schema_version !== prepared.schema ||
    get(statements.tempSchema)!.schema_version !== prepared.tempSchema ||
    get(statements.dataVersion)!.data_version !== prepared.dataVersion
  )
    throw Error('Contributor original backing scratch changed');
}
function retained(data: StagingData) {
  live(data);
  const prepared = data.prepared;
  const frontier = frontiers.get(data.storage);
  if (frontier && frontier.prepared === prepared && frontier.provisionalHeads)
    throw Error('Contributor own publication roster is unproved');
  if (
    !prepared ||
    !prepared.session.available() ||
    !prepared.sql.isOpen ||
    (prepared.physical && !prepared.physical.current())
  )
    throw Error('Contributor original backing unavailable');
  retainedScratch(data, prepared);
  recordVersionWork('contributorBackingRetainedChecks');
  return prepared;
}
function discardFrontier(storage: object, frontier: RetainedFrontier, keep?: object): void {
  if (frontiers.get(storage) === frontier) frontiers.delete(storage);
  try {
    if (frontier.original !== keep) closeContributorRecordReadOwner(frontier.original);
  } catch {
    /* derivative cleanup cannot revoke an accepted HEAD */
  }
  try {
    closePrepared(frontier.prepared);
  } catch {
    /* the next proof is a complete cold replay */
  }
}
function signedPhysical(prepared: NonNullable<StagingData['prepared']>) {
  // Keep the native key copy within this synchronous check, never the frontier:
  // wiping signatureKey cannot revoke a retained native copy.
  const key = createSecretKey(prepared.input.signatureKey);
  return (path: string, kind: string, identity: string) =>
    createHmac('sha256', key)
      .update(JSON.stringify([prepared.input.nonce, path, kind, identity]))
      .digest('hex');
}
function retainReplay(prepared: NonNullable<StagingData['prepared']>): void {
  const database = prepared.input.database;
  if (replayResidue.some((suffix) => existsSync(database + suffix)))
    throw Error('Contributor retained replay residue present');
  const real = realpathSync.native(database);
  prepared.replay = captureRecordHeadPhysical([real], [dirname(real)]);
}
function dropReplay(prepared: NonNullable<StagingData['prepared']>): void {
  try {
    prepared.replay?.close();
  } finally {
    prepared.replay = undefined;
    for (const suffix of ['', ...replayResidue])
      rmSync(prepared.input.database + suffix, { force: true });
  }
}
function sameRequest(pair: RecordReplaySourcePairRequest | undefined) {
  return pair ? JSON.stringify([pair.sourceVersionId, pair.identity]) : undefined;
}

function checkedOptionalPairSelection(
  prepared: NonNullable<StagingData['prepared']>,
  pair: RecordReplaySourcePairRequest | undefined,
  optional: boolean,
  selectedHead: string,
  sourcePair: RecordReplaySourcePair | undefined,
  signature: string | undefined,
): NonNullable<NonNullable<StagingData['prepared']>['optionalPairSelection']> | undefined {
  if (!pair || !optional) {
    if (signature) throw Error('Contributor unsolicited optional source selection');
    return undefined;
  }
  const expected = Buffer.from(
      signRecordReplaySourcePairSelection(
        prepared.input.signatureKey,
        prepared.input.nonce,
        pair,
        selectedHead,
        sourcePair ?? null,
      ),
      'hex',
    ),
    actual = Buffer.from(signature ?? '', 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw Error('Contributor optional source selection worker receipt changed');
  recordVersionWork('contributorBackingOptionalPairSelections');
  const replay = prepared.replay;
  if (!replay) return undefined;
  if (
    !replay.current() ||
    replayResidue.some((suffix) => existsSync(prepared.input.database + suffix)) ||
    prepared.input.selectedHead !== selectedHead
  )
    throw Error('Contributor optional source selection replay changed');
  return {
    request: sameRequest(pair)!,
    selectedHead,
    signature: signature!,
    absent: !sourcePair,
    replay,
  };
}

// Callers complete retained(data) before these synchronous follow-on checks.
function retainedOptionalPairSelection(
  prepared: NonNullable<StagingData['prepared']>,
  selection: NonNullable<NonNullable<StagingData['prepared']>['optionalPairSelection']>,
  pair: RecordReplaySourcePairRequest,
): void {
  if (selection.request !== sameRequest(pair) || selection.absent !== !prepared.sourcePair)
    throw Error('Contributor retained optional source selection changed');
  const expected = Buffer.from(
      signRecordReplaySourcePairSelection(
        prepared.input.signatureKey,
        prepared.input.nonce,
        pair,
        selection.selectedHead,
        prepared.sourcePair ?? null,
      ),
      'hex',
    ),
    actual = Buffer.from(selection.signature, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw Error('Contributor retained optional source selection changed');
}

function retainedSelectionReplay(
  prepared: NonNullable<StagingData['prepared']>,
  selection: NonNullable<NonNullable<StagingData['prepared']>['optionalPairSelection']>,
): void {
  if (
    prepared.replay !== selection.replay ||
    !selection.replay.current() ||
    replayResidue.some((suffix) => existsSync(prepared.input.database + suffix)) ||
    prepared.input.selectedHead !== selection.selectedHead
  )
    throw Error('Contributor retained optional source selection changed');
}

function certificateDeltaSpool(input: ContributorRecordBackingInput) {
  const { directory, path, fd, opened } = (() => {
      const created = mkdtempSync(resolve(tmpdir(), 'circus-contributor-certificate-delta-'));
      let fd: number | undefined;
      try {
        const directory = realpathSync.native(created),
          path = resolve(directory, 'chunks');
        fd = openSync(path, 'wx+', 0o600);
        return { directory, path, fd, opened: fstatSync(fd, { bigint: true }) };
      } catch (error) {
        try {
          if (fd !== undefined) closeSync(fd);
        } finally {
          rmSync(created, { recursive: true, force: true });
        }
        throw error;
      }
    })(),
    head = certificateDeltaHead(input.selectedHead, input.ownHeads),
    hash = createHash('sha256');
  let offset = 0,
    chunks = 0,
    count = 0,
    digest: string | undefined,
    physical: ReturnType<typeof captureRecordHeadPhysical> | undefined;
  const currentPath = () => {
    const stat = lstatSync(path, { bigint: true });
    if (
      stat.dev !== opened.dev ||
      stat.ino !== opened.ino ||
      stat.mode !== opened.mode ||
      stat.nlink !== opened.nlink
    )
      throw Error('Contributor certificate delta spool changed');
  };
  const write = (bytes: Buffer) => {
    let at = 0;
    while (at < bytes.length) {
      const written = writeSync(fd, bytes, at, bytes.length - at, offset + at);
      if (!written) throw Error('Contributor certificate delta spool write stopped');
      at += written;
    }
    offset += bytes.length;
  };
  const read = (bytes: Buffer, position: number) => {
    let at = 0;
    while (at < bytes.length) {
      const received = readSync(fd, bytes, at, bytes.length - at, position + at);
      if (!received) throw Error('Contributor certificate delta spool truncated');
      at += received;
    }
  };
  return {
    stage(value: unknown) {
      if (physical || digest) throw Error('Contributor certificate delta after terminal');
      currentPath();
      const { chunk, encoded } = checkedCertificateDeltaChunk(
        input.signatureKey,
        input.nonce,
        head,
        value,
      );
      if (chunk.ordinal !== chunks) throw Error('Contributor certificate delta order changed');
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(encoded.length);
      write(length);
      write(encoded);
      currentPath();
      hash.update(encoded);
      chunks++;
      count += chunk.certificates.length;
      if (!Number.isSafeInteger(count)) throw Error('Contributor certificate delta count invalid');
    },
    finish(terminal: unknown) {
      if (physical || digest) throw Error('Contributor certificate delta terminal repeated');
      currentPath();
      digest = hash.digest('hex');
      checkedCertificateDeltaTerminal(
        input.signatureKey,
        input.nonce,
        head,
        terminal,
        chunks,
        count,
        digest,
      );
      if (fstatSync(fd).size !== offset)
        throw Error('Contributor certificate delta spool length changed');
      physical = captureRecordHeadPhysical([path], [directory]);
    },
    get count() {
      return count;
    },
    *readChunks(): Generator<ContributorCertificateDelta[]> {
      if (!physical || !digest || !physical.current())
        throw Error('Contributor certificate delta spool unavailable');
      const replayHash = createHash('sha256');
      let position = 0,
        ordinal = 0,
        found = 0;
      while (position < offset) {
        if (!physical.current()) throw Error('Contributor certificate delta spool changed');
        const header = Buffer.allocUnsafe(4);
        read(header, position);
        position += 4;
        const bytes = header.readUInt32BE();
        if (bytes < 1 || bytes > MAX_CERTIFICATE_DELTA_CHUNK_BYTES || bytes > offset - position)
          throw Error('Contributor certificate delta spool frame invalid');
        const encoded = Buffer.allocUnsafe(bytes);
        read(encoded, position);
        position += bytes;
        const { chunk, encoded: canonical } = checkedCertificateDeltaChunk(
          input.signatureKey,
          input.nonce,
          head,
          JSON.parse(encoded.toString('utf8')),
        );
        if (!encoded.equals(canonical) || chunk.ordinal !== ordinal++)
          throw Error('Contributor certificate delta spool frame changed');
        replayHash.update(encoded);
        found += chunk.certificates.length;
        if (!physical.current()) throw Error('Contributor certificate delta spool changed');
        yield chunk.certificates;
      }
      if (
        position !== offset ||
        ordinal !== chunks ||
        found !== count ||
        replayHash.digest('hex') !== digest ||
        !physical.current()
      )
        throw Error('Contributor certificate delta spool changed');
    },
    close() {
      try {
        physical?.close();
      } finally {
        try {
          closeSync(fd);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
  };
}

interface BackingWorkerResult {
  entries: number;
  certificateRoot?: IntakeTreeRoot;
  decodedVersions?: number;
  sourcePair?: RecordReplaySourcePair;
  sourcePairSignature?: string;
  sourcePairSelectionSignature?: string;
  certificateCount?: number;
  certificateChunks?: number;
  certificateDigest?: string;
  certificateSignature?: string;
  result?: unknown;
}

class BackingWorkerSession {
  private readonly worker = new Worker(
    new URL('./contributor-record-backing-worker.ts', import.meta.url),
    { workerData: null },
  );
  private ready = false;
  private readonly readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: unknown) => void;
  private readonly exitPromise: Promise<void>;
  private exitResolve!: () => void;
  private closed = false;
  private poisoned = false;
  private starting = false;
  private generation = 0;
  private nextId = 0;
  private pending?: {
    id: number;
    generation: number;
    input: ContributorRecordBackingInput;
    current: () => void;
    beforeBaseline: () => void;
    complete?: (entries: number) => unknown;
    onCertificateChunk?: (chunk: unknown) => void;
    handleMessage: (message: unknown) => void;
    completing?: boolean;
    resolve: (result: BackingWorkerResult) => void;
    reject: (error: unknown) => void;
  };

  available(): boolean {
    return !this.closed;
  }

  constructor() {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyPromise.catch(() => undefined);
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
    this.worker.on('message', (message) => {
      const pending = this.pending;
      if (pending) pending.handleMessage(message);
      else this.message(message);
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.once('exit', (code) => {
      this.exitResolve();
      if (!this.closed) this.fail(Error(`Contributor backing worker exited (${code})`));
    });
  }

  private fail(error: unknown): void {
    this.poisoned = true;
    this.readyReject(error);
    this.close(error);
  }

  private message(message: unknown): void {
    if (this.closed) return;
    const row = message as {
      ready?: boolean;
      id?: number;
      checkpoint?: boolean;
      baselineReady?: boolean;
      certificateChunk?: unknown;
      result?: BackingWorkerResult;
      refused?: boolean;
    };
    if (row?.ready === true) {
      if (this.ready || this.pending || row.id !== undefined) {
        this.fail(Error('Contributor backing worker repeated ready'));
        return;
      }
      this.ready = true;
      this.readyResolve();
      if (!this.starting) this.worker.unref();
      return;
    }
    const pending = this.pending;
    if (!pending || row?.id !== pending.id || pending.generation !== this.generation) {
      this.fail(Error('Contributor backing worker response changed'));
      return;
    }
    if (pending.completing) {
      this.fail(Error('Contributor backing worker reentered final reply'));
      return;
    }
    const wake = () => {
      const control = new Int32Array(pending.input.checkpointControl);
      Atomics.store(control, 0, 0);
      Atomics.notify(control, 0);
    };
    if (row.checkpoint === true || row.certificateChunk !== undefined) {
      try {
        if (row.checkpoint === true) {
          if (row.certificateChunk !== undefined)
            throw Error('Contributor backing worker response changed');
          (row.baselineReady === true ? pending.current : pending.beforeBaseline)();
        } else {
          if (pending.input.mode !== 'advance' || !pending.onCertificateChunk)
            throw Error('Contributor certificate delta unsolicited');
          pending.current();
          pending.onCertificateChunk(row.certificateChunk);
          pending.current();
        }
      } catch (error) {
        this.fail(error);
      } finally {
        wake();
      }
      return;
    }
    if (row.refused || !row.result || !Number.isSafeInteger(row.result.entries)) {
      this.fail(Error('Contributor original backing verification refused'));
      return;
    }
    let result: unknown;
    try {
      if (pending.complete) {
        pending.completing = true;
        result = pending.complete(row.result.entries);
      }
      if (
        this.poisoned ||
        (!this.closed && (this.pending !== pending || pending.generation !== this.generation))
      )
        throw Error('Contributor backing owner closed during final reply');
    } catch (error) {
      pending.reject(error);
      this.fail(error);
      return;
    } finally {
      pending.completing = false;
    }
    this.pending = undefined;
    if (!this.closed) this.worker.unref();
    pending.resolve({ ...row.result, result });
  }

  async run(
    input: ContributorRecordBackingInput,
    current: () => void,
    beforeBaseline: () => void,
    complete?: (entries: number) => unknown,
    onCertificateChunk?: (chunk: unknown) => void,
  ): Promise<BackingWorkerResult> {
    if (this.closed || this.pending || this.starting)
      throw Error('Contributor backing worker session unavailable');
    const handleMessage = AsyncLocalStorage.bind((message: unknown) => this.message(message));
    this.starting = true;
    try {
      beforeBaseline();
      this.worker.ref();
      await this.readyPromise;
      beforeBaseline();
      if (this.closed || this.pending)
        throw Error('Contributor backing worker session unavailable');
      const id = ++this.nextId,
        generation = this.generation;
      return await new Promise<BackingWorkerResult>((resolve, reject) => {
        this.pending = {
          id,
          generation,
          input,
          current,
          beforeBaseline,
          complete,
          onCertificateChunk,
          handleMessage,
          resolve,
          reject,
        };
        this.starting = false;
        try {
          this.worker.postMessage({ id, input });
        } catch (error) {
          this.fail(error);
        }
      });
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.starting = false;
      if (!this.pending && !this.closed) this.worker.unref();
    }
  }

  close(reason: unknown = Error('Contributor backing worker session closed')): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.generation++;
      const pending = this.pending;
      this.pending = undefined;
      if (pending) {
        const control = new Int32Array(pending.input.checkpointControl);
        Atomics.store(control, 0, 0);
        Atomics.notify(control, 0);
        if (!pending.completing) pending.reject(reason);
      }
      this.readyReject(reason);
      void this.worker.terminate().catch(() => undefined);
    }
    return this.exitPromise;
  }
}

async function runWorker(
  session: BackingWorkerSession,
  input: ContributorRecordBackingInput,
  current: () => void,
  beforeBaseline: () => void = current,
  complete?: (entries: number) => unknown,
  onCertificateChunk?: (chunk: unknown) => void,
): Promise<BackingWorkerResult> {
  return session.run(input, current, beforeBaseline, complete, onCertificateChunk);
}

export function captureContributorRecordStaging(
  db: Database,
  storage: object,
  original: ContributorRecordReadOwner,
  readOnly = false,
): ContributorRecordStagingWitness | undefined {
  const location = contributorRecordBackingLocation(storage, original);
  if (!location) return undefined;
  const writes = captureContributorRecordWriteWitness(storage);
  if (!writes) return undefined;
  const witness = Object.freeze({}) as ContributorRecordStagingWitness;
  let frontier = frontiers.get(storage);
  if (
    frontier &&
    !frontier.poisoned &&
    !frontier.active &&
    (frontier.db !== db ||
      !contributorRecordReadOwnersSameSelection(storage, frontier.original, original))
  ) {
    // A HEAD or physical change this process did not record as its own is
    // never adopted: the retained proof is dropped and a full replay follows.
    discardFrontier(storage, frontier, original);
    recordVersionWork('contributorBackingForeignFallbacks');
    frontier = undefined;
  }
  if (frontier && frontier.active && readOnly) {
    // A concurrent read proves independently instead of refusing; the
    // retained frontier stays with its current reader.
    frontier = undefined;
  } else if (frontier && (frontier.poisoned || frontier.active)) {
    closeContributorRecordWriteWitness(writes);
    throw Error('Contributor retained backing requires recovery');
  }
  if (frontier) {
    frontier.active = true;
    if (frontier.provisionalHeads) {
      try {
        reconcileOwnContributorPublications(storage, frontier, original);
      } catch {
        discardFrontier(storage, frontier, original);
        recordVersionWork('contributorBackingForeignFallbacks');
        frontier = undefined;
      }
    }
  }
  witnesses.set(witness, {
    db,
    storage,
    original,
    writes,
    location,
    staged: 0,
    preparationAttempted: false,
    finished: false,
    finalAttempted: false,
    closed: false,
    prepared: frontier?.prepared,
    reused: !!frontier,
  });
  let resources = storageResources.get(storage);
  if (!resources) {
    const active = new Set<ContributorRecordStagingWitness>(),
      release = registerContributorRecordStagingDisposal(storage, original, () => {
        closedStorages.add(storage);
        storageResources.delete(storage);
        const frontier = frontiers.get(storage);
        frontiers.delete(storage);
        let failed: unknown;
        for (const member of active) {
          try {
            closeContributorRecordStaging(member);
          } catch (error) {
            failed ??= error;
          }
        }
        active.clear();
        if (frontier) {
          try {
            closeContributorRecordReadOwner(frontier.original);
          } catch (error) {
            failed ??= error;
          }
          try {
            closePrepared(frontier.prepared);
          } catch (error) {
            failed ??= error;
          }
        }
        if (failed) throw failed;
      });
    resources = { active, release };
    storageResources.set(storage, resources);
  }
  resources.active.add(witness);
  return witness;
}

export function contributorRecordStagingCurrent(witness: ContributorRecordStagingWitness): boolean {
  const data = witnesses.get(witness);
  if (!data) return false;
  try {
    if (data.prepared && !data.callerCheckWithoutPrepared) retained(data);
    else live(data);
    return true;
  } catch {
    return false;
  }
}

export async function prepareContributorRecordTransactionBacking(
  witness: ContributorRecordStagingWitness,
  selectedHead: string,
  current: () => void,
  pair?: RecordReplaySourcePairRequest,
  readOnlyPairCandidate = false,
): Promise<void> {
  const data = witnesses.get(witness);
  if (
    !data ||
    data.preparationAttempted ||
    (data.prepared && !data.reused) ||
    data.closed ||
    data.staged
  )
    throw Error('Contributor backing attempt expired');
  data.preparationAttempted = true;
  live(data);
  if (contributorRecordWriteWitnessSequence(data.storage, data.writes))
    throw Error('Contributor backing capture followed immutable writes');
  if (data.reused) {
    const frontier = frontiers.get(data.storage);
    try {
      if (!frontier || frontier.prepared !== data.prepared || !frontier.active)
        throw Error('Contributor retained backing frontier changed');
      const prepared = retained(data),
        ownHeads = frontier.ownHeads ?? [];
      if (
        selectedHead !==
          (ownHeads.length ? ownHeads[ownHeads.length - 1] : prepared.input.selectedHead) ||
        get(prepared.statements.count)!.n !== 0
      )
        throw Error('Contributor retained backing original selection differs');
      const selection = prepared.optionalPairSelection,
        reuseSelection =
          !!pair &&
          readOnlyPairCandidate &&
          !ownHeads.length &&
          !frontier.ownObjects?.length &&
          selection?.request === sameRequest(pair) &&
          selection?.selectedHead === selectedHead;
      if (reuseSelection || (!ownHeads.length && !pair)) {
        let pinned = selection;
        if (!reuseSelection && pinned) {
          try {
            if (retained(data) !== prepared)
              throw Error('Contributor retained backing original selection changed');
            retainedSelectionReplay(prepared, pinned);
          } catch {
            pinned = undefined;
          }
        }
        if (!pinned) {
          prepared.sourcePair = undefined;
          prepared.sourcePairRequest = undefined;
          prepared.optionalPairSelection = undefined;
        }
        const check = () => {
          current();
          if (retained(data) !== prepared)
            throw Error('Contributor retained backing original selection changed');
          if (pinned) retainedSelectionReplay(prepared, pinned);
          if (reuseSelection) retainedOptionalPairSelection(prepared, pinned!, pair!);
        };
        const verified = await runWorker(
          prepared.session,
          { ...prepared.input, mode: 'verify', entries: prepared.entries, retainedCapture: true },
          check,
        );
        check();
        if (verified.entries !== prepared.entries)
          throw Error('Contributor retained backing member count changed');
        recordVersionWork('contributorBackingPhysicalMemberVisits', 2 * prepared.entries);
        if (reuseSelection) recordVersionWork('contributorBackingOptionalPairSelectionReuses');
      } else await advanceRetainedBacking(data, frontier, current, pair, readOnlyPairCandidate);
      return;
    } catch (error) {
      // Only a still-current caller may fall back; the fallback is a complete
      // cold replay from the selected HEAD, never the retained derivative.
      let callerCurrent = !data.closed;
      if (callerCurrent) {
        const failedPrepared = data.prepared;
        data.callerCheckWithoutPrepared = !!failedPrepared && !failedPrepared.session.available();
        try {
          current();
          live(data);
        } catch {
          callerCurrent = false;
        } finally {
          data.callerCheckWithoutPrepared = false;
        }
      }
      if (!callerCurrent || !frontier || frontier.prepared !== data.prepared) {
        closeContributorRecordStaging(witness);
        throw error;
      }
      data.prepared = undefined;
      data.reused = false;
      discardFrontier(data.storage, frontier, data.original);
      recordVersionWork('contributorBackingForeignFallbacks');
    }
  }
  const scratch = mkdtempSync(resolve(tmpdir(), 'circus-contributor-backing-'));
  mkdirSync(resolve(scratch, 'replay'), { mode: 0o700 });
  const input: ContributorRecordBackingInput = {
    mode: 'prepare',
    ...data.location,
    selectedHead,
    database: resolve(scratch, 'replay', 'accepted.sqlite'),
    physical: resolve(scratch, 'physical.sqlite'),
    nonce: randomUUID(),
    signatureKey: randomBytes(32),
    checkpointControl: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    pair,
    readOnlyPairCandidate,
  };
  let session: BackingWorkerSession | undefined,
    sql: DatabaseSync | undefined,
    replay: ReturnType<typeof captureRecordHeadPhysical> | undefined;
  try {
    session = new BackingWorkerSession();
    const privateCurrent = () => {
      live(data);
      if (contributorRecordWriteWitnessSequence(data.storage, data.writes))
        throw Error('Contributor original backing changed during replay');
    };
    const prepared = await runWorker(
      session,
      input,
      () => {
        current();
        privateCurrent();
      },
      privateCurrent,
    );
    if (prepared.certificateRoot === undefined)
      throw Error('Contributor accepted certificate root missing');
    let sourcePair: RecordReplaySourcePair | undefined;
    if (pair && (!readOnlyPairCandidate || prepared.sourcePair)) {
      sourcePair = checkedRecordReplaySourcePair(pair, prepared.sourcePair);
      const expected = Buffer.from(
          signRecordReplaySourcePair(input.signatureKey, input.nonce, sourcePair),
          'hex',
        ),
        actual = Buffer.from(prepared.sourcePairSignature ?? '', 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw Error('Contributor accepted source pair worker receipt changed');
    } else if (prepared.sourcePair || prepared.sourcePairSignature)
      throw Error('Contributor unsolicited accepted source pair');
    intakeTreeRef(prepared.certificateRoot);
    try {
      // Keep the private replay projection so later own publications extend
      // it. Without a clean identity it is removed and the next proof is cold.
      const retainedReplay = { input } as NonNullable<StagingData['prepared']>;
      retainReplay(retainedReplay);
      replay = retainedReplay.replay;
    } catch {
      for (const suffix of ['', ...replayResidue]) rmSync(input.database + suffix, { force: true });
    }
    sql = new DatabaseSync(input.physical);
    const prepare = (source: string) =>
        Reflect.apply(nativePrepare, sql!, [source]) as StatementSync,
      statements = {
        changes: prepare('SELECT total_changes() AS n'),
        schema: prepare('PRAGMA main.schema_version'),
        tempSchema: prepare('PRAGMA temp.schema_version'),
        dataVersion: prepare('PRAGMA main.data_version'),
        insert: prepare('INSERT INTO own_additions VALUES(?,?,?,?,?,?)'),
        lookup: prepare('SELECT identity,sha256,bytes,signature FROM own_additions WHERE name=?'),
        count: prepare('SELECT count(*) AS n FROM own_additions'),
        own: prepare(
          'SELECT name,identity,sha256,bytes,signature FROM own_additions WHERE sequence=?',
        ),
        promote: prepare('INSERT INTO physical VALUES(?,?,?,?)'),
        replace: prepare('UPDATE physical SET kind=?,identity=?,signature=? WHERE path=?'),
        clearOwn: prepare('DELETE FROM own_additions'),
        clearSources: prepare('DELETE FROM consumed_sources'),
        clearArtifacts: prepare('DELETE FROM original_artifacts'),
        physicalRow: prepare('SELECT kind,identity,signature FROM physical WHERE path=?'),
      },
      expectedChanges = BigInt(String(get(statements.changes)!.n));
    data.prepared = {
      session,
      scratch,
      sql,
      input,
      root: prepared.certificateRoot,
      entries: prepared.entries,
      sourcePair,
      sourcePairRequest: sourcePair ? sameRequest(pair) : undefined,
      replay,
      expectedChanges,
      schema: get(statements.schema)!.schema_version,
      tempSchema: get(statements.tempSchema)!.schema_version,
      dataVersion: get(statements.dataVersion)!.data_version,
      statements,
    };
    retained(data);
    data.prepared.optionalPairSelection = checkedOptionalPairSelection(
      data.prepared,
      pair,
      readOnlyPairCandidate,
      selectedHead,
      sourcePair,
      prepared.sourcePairSelectionSignature,
    );
    recordVersionWork('contributorBackingPhysicalMemberVisits', 3 * prepared.entries);
    recordVersionWork('contributorBackingColdDecodedVersions', prepared.decodedVersions ?? 0);
    recordVersionWork('contributorBackingColdReplays');
  } catch (error) {
    if (!data.prepared) {
      await session?.close();
      sql?.close();
      replay?.close();
      input.signatureKey.fill(0);
      rmSync(scratch, { recursive: true, force: true });
    }
    closeContributorRecordStaging(witness);
    throw error;
  }
}

/** Extend the retained original proof across exactly this process's recorded
 * own publications (or answer a pair at an unchanged HEAD). The worker replays
 * only the new commits into the retained projection, requires the commit chain
 * to be the recorded own HEAD bytes, and re-verifies the whole physical roster
 * twice. Any refusal discards the frontier and the caller replays cold. */
async function advanceRetainedBacking(
  data: StagingData,
  frontier: RetainedFrontier,
  current: () => void,
  pair: RecordReplaySourcePairRequest | undefined,
  readOnlyPairCandidate: boolean,
): Promise<void> {
  const prepared = retained(data),
    ownHeads = [...(frontier.ownHeads ?? [])],
    ownObjects = [...(frontier.ownObjects ?? [])];
  if (
    !prepared.replay?.current() ||
    replayResidue.some((suffix) => existsSync(prepared.input.database + suffix))
  )
    throw Error('Contributor retained replay changed');
  // The worker writes the projection; its identity is recaptured afterwards.
  prepared.replay.close();
  prepared.replay = undefined;
  prepared.sourcePair = undefined;
  prepared.sourcePairRequest = undefined;
  prepared.optionalPairSelection = undefined;
  const input: ContributorRecordBackingInput = {
    ...prepared.input,
    mode: 'advance',
    entries: prepared.entries,
    ownHeads,
    ownObjects,
    pair,
    readOnlyPairCandidate: !!pair && readOnlyPairCandidate,
  };
  const spool = ownHeads.length ? certificateDeltaSpool(input) : undefined;
  try {
    const advanced = await runWorker(
      prepared.session,
      input,
      () => {
        current();
        retained(data);
      },
      undefined,
      undefined,
      (chunk) => {
        if (!spool) throw Error('Contributor certificate delta unsolicited');
        spool.stage(chunk);
      },
    );
    current();
    if (spool) spool.finish(advanced);
    else
      checkedCertificateDeltaTerminal(
        input.signatureKey,
        input.nonce,
        certificateDeltaHead(input.selectedHead, input.ownHeads),
        advanced,
        0,
        0,
        createHash('sha256').digest('hex'),
      );
    if (advanced.entries !== prepared.entries)
      throw Error('Contributor advanced backing member count changed');
    retainReplay(prepared);
    let sourcePair: RecordReplaySourcePair | undefined;
    if (pair && (!readOnlyPairCandidate || advanced.sourcePair)) {
      sourcePair = checkedRecordReplaySourcePair(pair, advanced.sourcePair);
      const expected = Buffer.from(
          signRecordReplaySourcePair(input.signatureKey, input.nonce, sourcePair),
          'hex',
        ),
        actual = Buffer.from(advanced.sourcePairSignature ?? '', 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw Error('Contributor accepted source pair worker receipt changed');
    } else if (advanced.sourcePair || advanced.sourcePairSignature)
      throw Error('Contributor unsolicited accepted source pair');
    const changed = spool?.count ?? 0;
    if (!Number.isSafeInteger(changed) || (!ownHeads.length && changed))
      throw Error('Contributor advanced certificate delta invalid');
    if (changed) {
      prepared.physical?.close();
      prepared.physical = undefined;
      const fullCheck = () => {
          recordVersionWork('contributorBackingAdvanceFullChecks');
          if (retained(data) !== prepared) throw Error('Contributor original backing unavailable');
        },
        scratchCheck = () => {
          recordVersionWork('contributorBackingAdvanceScratchChecks');
          retainedScratch(data, prepared);
        };
      const certificates = vaultRecordCertificates(
        prepared.sql,
        prepared.input.profileId,
        prepared.input.nonce,
        scratchCheck,
        (writes) => {
          prepared.expectedChanges += BigInt(writes);
        },
      );
      const yieldChunk = async () => {
        current();
        fullCheck();
        await yieldHost();
        current();
        fullCheck();
      };
      let root = prepared.root;
      for (const chunk of spool!.readChunks()) {
        if (certificates.supportsPrivateBatch) {
          fullCheck();
          let predecessors: ReturnType<typeof certificates.getManyPrivate>;
          try {
            predecessors = certificates.getManyPrivate(root, chunk);
          } finally {
            fullCheck();
          }
          if (!predecessors || predecessors.length !== chunk.length)
            throw Error('Contributor private certificate batch unavailable');
          for (let index = 0; index < chunk.length; index++)
            if ((predecessors[index]?.versionId ?? null) !== chunk[index]!.previousAccepted)
              throw Error('Contributor advanced predecessor differs from original proof');
        } else {
          for (const certificate of chunk) {
            // Callback-bearing preparation keeps every original owner seal.
            fullCheck();
            let predecessor: ReturnType<typeof certificates.get>;
            try {
              predecessor = certificates.getPrivate(root, certificate.entity, certificate.recordId);
            } finally {
              fullCheck();
            }
            if ((predecessor?.versionId ?? null) !== certificate.previousAccepted)
              throw Error('Contributor advanced predecessor differs from original proof');
          }
        }
        await yieldChunk();
      }
      prepared.sql.exec('BEGIN');
      try {
        for (const chunk of spool!.readChunks()) {
          fullCheck();
          let next: IntakeTreeRoot = root;
          try {
            next = certificates.putMany(
              root,
              chunk.map(({ previousAccepted: _, ...value }) => value),
            ).root;
          } finally {
            fullCheck();
          }
          root = next;
          await yieldChunk();
        }
        for (const chunk of spool!.readChunks()) {
          if (!chunk.length) throw Error('Contributor certificate delta spool empty frame');
          await yieldChunk();
        }
        fullCheck();
        prepared.sql.exec('COMMIT');
      } catch (error) {
        if (prepared.sql.isTransaction) prepared.sql.exec('ROLLBACK');
        throw error;
      }
      intakeTreeRef(root);
      prepared.root = root;
      const physical = realpathSync.native(prepared.input.physical);
      prepared.physical = captureRecordHeadPhysical([physical], [dirname(physical)]);
    }
    if (ownHeads.length) prepared.input.selectedHead = ownHeads[ownHeads.length - 1]!;
    frontier.ownHeads = [];
    frontier.ownObjects = [];
    prepared.sourcePair = sourcePair;
    prepared.sourcePairRequest = sourcePair ? sameRequest(pair) : undefined;
    retained(data);
    prepared.optionalPairSelection = checkedOptionalPairSelection(
      prepared,
      pair,
      readOnlyPairCandidate,
      ownHeads.length ? ownHeads[ownHeads.length - 1]! : input.selectedHead,
      sourcePair,
      advanced.sourcePairSelectionSignature,
    );
    recordVersionWork('contributorBackingIncrementalAdvances');
    recordVersionWork(
      'contributorBackingIncrementalDecodedVersions',
      advanced.decodedVersions ?? 0,
    );
    recordVersionWork('contributorBackingPhysicalMemberVisits', 2 * prepared.entries);
  } finally {
    spool?.close();
  }
}

export function assertContributorRecordTransactionPrior(
  witness: ContributorRecordStagingWitness,
  entity: string,
  recordId: string,
  previousVersion: string | null,
  prior: { deleted: boolean; preimage: { hash: string; bytes: number } } | null,
): void {
  const data = witnesses.get(witness);
  if (!data) throw Error('Contributor original predecessor unavailable');
  const prepared = retained(data),
    certificates = vaultRecordCertificates(
      prepared.sql,
      prepared.input.profileId,
      prepared.input.nonce,
      () => retained(data),
    ),
    accepted = certificates.getPrivate(prepared.root, entity, recordId);
  if (
    previousVersion === null
      ? accepted !== undefined || prior !== null
      : !accepted ||
        !prior ||
        accepted.versionId !== previousVersion ||
        !!accepted.deleted !== prior.deleted ||
        accepted.preimage.hash !== prior.preimage.hash ||
        accepted.preimage.bytes !== prior.preimage.bytes
  )
    throw Error('Contributor accepted record predecessor differs');
  retained(data);
}
export async function captureContributorRecordAcceptedHeadRead(
  db: Database,
  storage: object,
  original: ContributorRecordReadOwner,
  selectedHead: string,
  key: string,
  value: string,
  current: () => void,
  pair?: RecordReplaySourcePairRequest,
): Promise<ContributorRecordAcceptedHeadRead> {
  if (
    !key.startsWith('intake_state_v1:') ||
    !key.endsWith(':head') ||
    Buffer.byteLength(value) > 4096 ||
    (pair && intakeNamespace(pair.identity) + 'head' !== key)
  )
    throw Error('Contributor accepted head read scope');
  const ownedOriginal = captureContributorRecordReadOwner(storage);
  if (
    !ownedOriginal ||
    !contributorRecordReadOwnersSameSelection(storage, original, ownedOriginal)
  ) {
    if (ownedOriginal) closeContributorRecordReadOwner(ownedOriginal);
    throw Error('Contributor accepted head read owner unavailable');
  }
  let witness: ContributorRecordStagingWitness | undefined;
  try {
    witness = captureContributorRecordStaging(db, storage, ownedOriginal, true);
  } catch (error) {
    closeContributorRecordReadOwner(ownedOriginal);
    throw error;
  }
  if (!witness) {
    closeContributorRecordReadOwner(ownedOriginal);
    throw Error('Contributor accepted head read owner unavailable');
  }
  const data = witnesses.get(witness)!;
  data.readOnly = true;
  const check = () => {
    current();
    if (!contributorRecordStagingCurrent(witness))
      throw Error('Contributor accepted head read owner changed');
  };
  try {
    await prepareContributorRecordTransactionBacking(witness, selectedHead, check, pair);
    check();
    const cap = Object.freeze({}) as ContributorRecordAcceptedHeadRead;
    acceptedHeadReads.set(cap, {
      witness,
      original: ownedOriginal,
      key,
      value,
      db,
      current: check,
      pair,
    });
    assertContributorRecordAcceptedHeadRead(cap, key, value);
    return cap;
  } catch (error) {
    closeContributorRecordStaging(witness);
    if (frontiers.get(storage)?.original !== ownedOriginal)
      closeContributorRecordReadOwner(ownedOriginal);
    throw error;
  }
}
/** Read-only complete certificate proof for selected records without a V4
 * app_meta HEAD. A missing V4 key is never used as an admission signal. */
export async function captureContributorRecordAcceptedSourceRead(
  db: Database,
  storage: object,
  original: ContributorRecordReadOwner,
  selectedHead: string,
  current: () => void,
  pair?: RecordReplaySourcePairRequest,
): Promise<ContributorRecordAcceptedSourceRead> {
  const ownedOriginal = captureContributorRecordReadOwner(storage);
  if (
    !ownedOriginal ||
    !contributorRecordReadOwnersSameSelection(storage, original, ownedOriginal)
  ) {
    if (ownedOriginal) closeContributorRecordReadOwner(ownedOriginal);
    throw Error('Contributor accepted source read owner unavailable');
  }
  let witness: ContributorRecordStagingWitness | undefined;
  try {
    witness = captureContributorRecordStaging(db, storage, ownedOriginal, true);
  } catch (error) {
    closeContributorRecordReadOwner(ownedOriginal);
    throw error;
  }
  if (!witness) {
    closeContributorRecordReadOwner(ownedOriginal);
    throw Error('Contributor accepted source read owner unavailable');
  }
  const data = witnesses.get(witness)!;
  data.readOnly = true;
  const check = () => {
    current();
    if (!contributorRecordStagingCurrent(witness))
      throw Error('Contributor accepted source read owner changed');
  };
  try {
    await prepareContributorRecordTransactionBacking(witness, selectedHead, check, pair, !!pair);
    check();
    const cap = Object.freeze({}) as ContributorRecordAcceptedSourceRead;
    acceptedHeadReads.set(cap, {
      witness,
      original: ownedOriginal,
      key: '',
      value: '',
      db,
      current: check,
      pair,
    });
    return cap;
  } catch (error) {
    closeContributorRecordStaging(witness, false);
    if (frontiers.get(storage)?.original !== ownedOriginal)
      closeContributorRecordReadOwner(ownedOriginal);
    throw error;
  }
}
export function contributorRecordAcceptedSourcePair(
  cap: ContributorRecordAcceptedHeadRead | ContributorRecordAcceptedSourceRead,
  request: RecordReplaySourcePairRequest,
): RecordReplaySourcePair {
  const read = acceptedHeadReads.get(cap);
  if (
    !read?.pair ||
    (read.key === '' && !read.sourceProven) ||
    read.pair.sourceVersionId !== request.sourceVersionId ||
    JSON.stringify(read.pair.identity) !== JSON.stringify(request.identity)
  )
    throw Error('Contributor accepted source pair read unavailable');
  read.current();
  const prepared = retained(witnesses.get(read.witness)!);
  if (
    !prepared.sourcePair ||
    prepared.sourcePairRequest !== sameRequest(read.pair) ||
    read.pair.sourceVersionId !== request.sourceVersionId ||
    JSON.stringify(read.pair.identity) !== JSON.stringify(request.identity)
  )
    throw Error('Contributor accepted source pair changed during read');
  return prepared.sourcePair;
}
export function assertContributorRecordAcceptedSourcePreimage(
  cap: ContributorRecordAcceptedHeadRead | ContributorRecordAcceptedSourceRead,
  recordId: string,
  versionId: string,
  preimage: { hash: string; bytes: number },
): void {
  const read = acceptedHeadReads.get(cap);
  if (!read) throw Error('Contributor accepted source preimage read unavailable');
  if (
    read.pair &&
    (recordId !== JSON.stringify([read.pair.identity.intakeId]) ||
      versionId !== read.pair.sourceVersionId)
  )
    throw Error('Contributor accepted source preimage pair differs');
  read.current();
  assertContributorRecordTransactionPrior(read.witness, 'source_files', recordId, versionId, {
    deleted: false,
    preimage,
  });
  read.current();
  if (read.pair) read.sourceProven = true;
}
export async function verifyContributorRecordAcceptedSourceRead(
  cap: ContributorRecordAcceptedSourceRead,
): Promise<void> {
  const read = acceptedHeadReads.get(cap);
  if (!read || (read.pair && !read.sourceProven))
    throw Error('Contributor accepted source terminal read unavailable');
  read.current();
  const data = witnesses.get(read.witness);
  if (!data || !data.readOnly)
    throw Error('Contributor accepted source terminal owner unavailable');
  const prepared = retained(data);
  const verified = await runWorker(
    prepared.session,
    { ...prepared.input, mode: 'verify', entries: prepared.entries },
    () => {
      read.current();
      retained(data);
    },
  );
  if (verified.entries !== prepared.entries)
    throw Error('Contributor accepted source terminal member count changed');
  recordVersionWork('contributorBackingPhysicalMemberVisits', 2 * verified.entries);
  read.current();
}
export function assertContributorRecordAcceptedHeadRead(
  cap: ContributorRecordAcceptedHeadRead | ContributorRecordAcceptedSourceRead,
  key: string,
  value: string,
): void {
  const read = acceptedHeadReads.get(cap);
  const sourceHead =
    read?.key === '' &&
    read.sourceProven &&
    read.pair &&
    key === intakeNamespace(read.pair.identity) + 'head';
  if (!read || (!sourceHead && (read.key !== key || read.value !== value)))
    throw Error('Contributor accepted head read changed');
  read.current();
  const data = witnesses.get(read.witness);
  const prepared = data?.prepared;
  // read.current() just checked this witness's retained backing, with no
  // callback or yield between that check and taking its prepared reference.
  if (!data || !data.readOnly || !prepared)
    throw Error('Contributor accepted head backing unavailable');
  const certificates = vaultRecordCertificates(
    prepared.sql,
    prepared.input.profileId,
    prepared.input.nonce,
    () => retained(data),
  );
  const accepted = certificates.getPrivate(prepared.root, 'app_meta', JSON.stringify([key]));
  if (!accepted || accepted.deleted || accepted.preimage.bytes > 8192)
    throw Error('Contributor accepted head certificate missing or oversized');
  // Contributor certificates sign the exact version preimage, not app_meta fields.
  const recordId = JSON.stringify([key]);
  const version = get(
    Reflect.apply(nativePrepare, read.db, [
      "SELECT c.version_id,v.profile_id,v.entity,v.record_id,v.deleted,substr(v.contents_json,1,8193) AS contents_json,v.contents_json IS substr(v.contents_json,1,8193) AS complete FROM main.__record_current c JOIN main.__record_versions v ON v.version_id=c.version_id WHERE c.entity='app_meta' AND c.record_id=?",
    ]) as StatementSync,
    recordId,
  );
  const contents = version?.contents_json;
  if (typeof contents !== 'string' || Buffer.byteLength(contents) > 8192)
    throw Error('Contributor accepted head version oversized');
  const digest = recordFieldDigest(contents);
  if (
    !version ||
    accepted.versionId !== version.version_id ||
    version.profile_id !== prepared.input.profileId ||
    version.entity !== 'app_meta' ||
    version.record_id !== recordId ||
    version.deleted !== 0 ||
    version.complete !== 1 ||
    accepted.preimage.hash !== digest.hash ||
    accepted.preimage.bytes !== digest.bytes
  )
    throw Error('Contributor accepted head differs from immutable history');
  const row = JSON.parse(contents) as unknown;
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    Reflect.get(row, 'key') !== key ||
    Reflect.get(row, 'value') !== value
  )
    throw Error('Contributor accepted head version differs from selected SQL');
  const statement = Reflect.apply(nativePrepare, read.db, [
    'SELECT substr(value,1,4097) AS value,value IS substr(value,1,4097) AS complete FROM main.app_meta WHERE key=?',
  ]) as StatementSync;
  const selected = get(statement, key);
  if (selected?.complete !== 1 || selected.value !== value)
    throw Error('Contributor accepted head differs from selected SQL');
  read.current();
}
function closeContributorAcceptedRead(
  cap: ContributorRecordAcceptedHeadRead | ContributorRecordAcceptedSourceRead,
  retainRead = true,
): void {
  const read = acceptedHeadReads.get(cap);
  acceptedHeadReads.delete(cap);
  if (!read) return;
  const storage = witnesses.get(read.witness)?.storage;
  try {
    closeContributorRecordStaging(read.witness, retainRead);
  } finally {
    if (!storage || frontiers.get(storage)?.original !== read.original)
      closeContributorRecordReadOwner(read.original);
  }
}
export function closeContributorRecordAcceptedHeadRead(
  cap: ContributorRecordAcceptedHeadRead,
): void {
  closeContributorAcceptedRead(cap);
}
export function closeContributorRecordAcceptedSourceRead(
  cap: ContributorRecordAcceptedSourceRead,
  retainRead = true,
): void {
  closeContributorAcceptedRead(cap, retainRead);
}

export function stageContributorRecordObject(
  witness: ContributorRecordStagingWitness,
  ref: { name: string; sha256: string; bytes: number },
  input: Uint8Array,
): void {
  const data = witnesses.get(witness);
  if (!data || data.readOnly || !data.prepared || data.head || data.finished)
    throw Error('Contributor immutable staging continuation expired');
  const preparedParent = retained(data),
    objects = get(preparedParent.statements.physicalRow, 'objects'),
    expectedObjects = preparedParent.input.objectsIdentity ?? String(objects?.identity),
    actualObjects = unlockPhysicalIdentity(resolve(data.location.base, 'objects'));
  if (
    !objects ||
    objects.kind !== 'directory' ||
    objects.signature !==
      createHmac('sha256', preparedParent.input.signatureKey)
        .update(
          JSON.stringify([preparedParent.input.nonce, 'objects', 'directory', objects.identity]),
        )
        .digest('hex') ||
    actualObjects.kind !== 'directory' ||
    actualObjects.value !== expectedObjects
  )
    throw Error('Contributor original objects parent changed before own write');
  // This exact owned write begins a new scratch recipe. The next final worker
  // receives a fresh seal after the signed additions and pending root are fixed.
  data.prepared.physical?.close();
  data.prepared.physical = undefined;
  const retainedObject = stageContributorRecordFactoryObject(data.storage, data.writes, ref, input),
    prepared = data.prepared,
    signature = createHmac('sha256', prepared.input.signatureKey)
      .update(
        JSON.stringify([
          prepared.input.nonce,
          'own-addition',
          ref.name,
          retainedObject.identity,
          retainedObject.sha256,
          retainedObject.bytes,
        ]),
      )
      .digest('hex');
  if (
    run(
      prepared.statements.insert,
      ref.name,
      retainedObject.identity,
      retainedObject.sha256,
      retainedObject.bytes,
      signature,
      data.staged,
    ).changes !== 1
  )
    throw Error('Contributor immutable staging row changed');
  prepared.expectedChanges++;
  data.staged++;
  const ownedObjects = unlockPhysicalIdentity(resolve(data.location.base, 'objects'));
  if (ownedObjects.kind !== 'directory') throw Error('Contributor owned objects parent changed');
  prepared.input.objectsIdentity = ownedObjects.value;
  prepared.input.objectsSignature = createHmac('sha256', prepared.input.signatureKey)
    .update(JSON.stringify([prepared.input.nonce, 'objects', 'directory', ownedObjects.value]))
    .digest('hex');
  retained(data);
}

export function prepareContributorRecordStagingHead(
  witness: ContributorRecordStagingWitness,
  ref: { name: string; sha256: string; bytes: number },
): void {
  const data = witnesses.get(witness);
  if (!data || data.readOnly || data.head || data.finished || !data.prepared)
    throw Error('Contributor HEAD staging expired');
  retained(data);
  const row = get(data.prepared.statements.lookup, ref.name);
  if (!row || row.sha256 !== ref.sha256 || row.bytes !== ref.bytes)
    throw Error('Contributor HEAD object was not staged');
  const cap = prepareContributorRecordHeadPublication(data.storage, ref);
  if (!cap) throw Error('Contributor HEAD installation owner missing');
  data.head = cap;
  data.candidateHead = JSON.stringify(ref) + '\n';
}

async function rawRecordDigest(value: string, current: () => void) {
  const hash = createHash('sha256');
  let bytes = 0;
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + 4096, value.length);
    if (
      end < value.length &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    )
      end++;
    const piece = value.slice(offset, end);
    hash.update(piece);
    bytes += Buffer.byteLength(piece);
    offset = end;
    current();
    await yieldHost();
  }
  current();
  return { hash: hash.digest('hex'), bytes };
}

/** Keep the successor derivative separate until the exact indexed receipt is consumed. */
export async function prepareContributorRecordBackingAdvance(
  witness: ContributorRecordStagingWitness,
  exactHead: string,
  plan: ContributorRecordBackingPlan,
): Promise<void> {
  const data = witnesses.get(witness);
  if (!data || !data.head || !data.prepared || data.pending || data.finished)
    throw Error('Contributor retained backing transition expired');
  const prepared = retained(data);
  if (exactHead !== data.candidateHead)
    throw Error('Contributor retained backing successor HEAD differs');
  const certificates = vaultRecordCertificates(
    prepared.sql,
    prepared.input.profileId,
    prepared.input.nonce,
    () => retained(data),
    (writes) => {
      prepared.expectedChanges += BigInt(writes);
    },
  );
  let root = prepared.root;
  const versionIds: string[] = [],
    seen = new Set<string>();
  for (const version of verifiedContributorRecordBackingVersions(
    plan,
    data.db,
    witness,
    exactHead,
  )) {
    retained(data);
    if (
      !version.entity ||
      !version.recordId ||
      !version.versionId ||
      typeof version.contentsJson !== 'string' ||
      seen.has(version.versionId)
    )
      throw Error('Contributor retained backing changed version invalid');
    const predecessor = certificates.getPrivate(root, version.entity, version.recordId);
    if ((predecessor?.versionId ?? null) !== version.previousVersion)
      throw Error('Contributor retained backing changed predecessor differs');
    root = certificates.put(root, {
      entity: version.entity,
      recordId: version.recordId,
      versionId: version.versionId,
      deleted: Number(version.deleted),
      preimage: await rawRecordDigest(version.contentsJson, () => {
        if (!contributorRecordBackingPlanCurrent(plan, data.db, witness))
          throw Error('Contributor pending backing owner changed');
        retained(data);
      }),
      fields: version.sourceFields,
    }).root;
    versionIds.push(version.versionId);
    seen.add(version.versionId);
  }
  if (!versionIds.length) throw Error('Contributor retained backing transition empty');
  retained(data);
  data.pending = { root, head: exactHead, plan, versionIds };
}

export async function finishContributorRecordStagingPreparation(
  witness: ContributorRecordStagingWitness,
  current: () => void,
): Promise<void> {
  const data = witnesses.get(witness);
  if (!data || !data.head || data.finished || data.finalAttempted)
    throw Error('Contributor final staging expired');
  data.finalAttempted = true;
  const prepared = retained(data);
  if (get(prepared.statements.count)!.n !== data.staged)
    throw Error('Contributor immutable write roster differs from staged objects');
  const physical = realpathSync.native(prepared.input.physical);
  prepared.physical = captureRecordHeadPhysical([physical], [dirname(physical)]);
  current();
  const verified = await runWorker(
    prepared.session,
    {
      ...prepared.input,
      mode: 'verify',
      entries: prepared.entries,
    },
    () => {
      current();
      retained(data);
      if (!contributorRecordHeadPublicationCurrent(data.storage, data.head!))
        throw Error('Contributor HEAD owner changed during final verification');
    },
  );
  if (verified.entries !== prepared.entries + data.staged)
    throw Error('Contributor final physical member count differs');
  data.finished = true;
  recordVersionWork('contributorBackingPhysicalMemberVisits', 2 * verified.entries);
}

/** The final reply can execute only the private core-issued T2 body. */
export async function finishContributorRecordTransactionPreparation(
  witness: ContributorRecordStagingWitness,
  plan: ContributorRecordBackingPlan,
  execution: ContributorRecordTerminalExecution,
): Promise<unknown> {
  const data = witnesses.get(witness);
  if (
    !data ||
    !data.head ||
    !data.pending ||
    data.finished ||
    data.finalAttempted ||
    data.pending.plan !== plan
  )
    throw Error('Contributor record transaction completion expired');
  data.finalAttempted = true;
  const prepared = retained(data),
    current = () => {
      retained(data);
      if (
        !contributorRecordTerminalExecutionCurrent(execution, data.db, witness, plan) ||
        !contributorRecordHeadPublicationCurrent(data.storage, data.head!)
      )
        throw Error('Contributor record transaction terminal issuer changed');
    },
    prepare = (sql: string) => Reflect.apply(nativePrepare, prepared.sql, [sql]) as StatementSync,
    sourceInsert = prepare('INSERT OR IGNORE INTO consumed_sources VALUES(?,?,?)'),
    sourceClear = prepare('DELETE FROM consumed_sources'),
    artifactInsert = prepare('INSERT INTO original_artifacts VALUES(?,?,?,?,?)'),
    artifactClear = prepare('DELETE FROM original_artifacts'),
    certificates = vaultRecordCertificates(
      prepared.sql,
      prepared.input.profileId,
      prepared.input.nonce,
      current,
    ),
    sign = (path: string, kind: string, identity: string) =>
      createHmac('sha256', prepared.input.signatureKey)
        .update(JSON.stringify([prepared.input.nonce, path, kind, identity]))
        .digest('hex');
  prepared.physical?.close();
  prepared.physical = undefined;
  prepared.expectedChanges += BigInt(run(sourceClear).changes) + BigInt(run(artifactClear).changes);
  let sources = 0;
  for (const original of verifiedContributorRecordOriginalSources(plan, data.db, witness)) {
    current();
    const accepted = certificates.getPrivate(
      prepared.root,
      'source_files',
      JSON.stringify([original.binding.intakeId]),
    );
    if (!accepted || accepted.deleted || original.binding.profileId !== prepared.input.profileId)
      throw Error('Contributor original leased source certificate missing');
    const binding = {
      id: original.binding.intakeId,
      kind: 'intake_original',
      path: original.acceptedPath,
      sha256: original.binding.sourceHash,
      bytes: original.binding.bytes,
    };
    for (const [name, value] of Object.entries(binding)) {
      const field = accepted.fields.find((candidate) => candidate.name === name),
        digest =
          typeof value === 'string'
            ? await recordStringFieldDigest(value, current)
            : recordFieldDigest(JSON.stringify(value));
      if (!field || field.hash !== digest.hash || field.bytes !== digest.bytes)
        throw Error('Contributor original leased source certificate differs');
    }
    const serialized = JSON.stringify(original),
      inserted = run(
        sourceInsert,
        sources,
        serialized,
        sign('consumed-source:' + sources, 'source', serialized),
      ).changes;
    prepared.expectedChanges += BigInt(inserted);
    sources += Number(inserted);
    await yieldHost();
  }
  prepared.input.originalSources = sources;
  let artifacts = 0;
  for (const original of verifiedContributorRecordOriginalArtifacts(plan, data.db, witness)) {
    current();
    if (
      run(
        artifactInsert,
        artifacts,
        original.id,
        original.path,
        original.identity,
        sign(
          'parent-artifact:' + artifacts,
          'artifact',
          JSON.stringify([original.id, original.path, original.identity]),
        ),
      ).changes !== 1
    )
      throw Error('Contributor original artifact membership differs');
    prepared.expectedChanges++;
    artifacts++;
    if (artifacts % 64 === 0) await yieldHost();
  }
  prepared.input.originalArtifacts = artifacts;
  current();
  if (get(prepared.statements.count)!.n !== data.staged)
    throw Error('Contributor immutable write roster differs from staged objects');
  sealContributorRecordTerminalWorker(execution, data.db, witness, plan);
  const physical = realpathSync.native(prepared.input.physical);
  prepared.physical = captureRecordHeadPhysical([physical], [dirname(physical)]);
  const verified = await runWorker(
    prepared.session,
    { ...prepared.input, mode: 'verify', entries: prepared.entries },
    current,
    current,
    (entries) => {
      if (entries !== prepared.entries + data.staged)
        throw Error('Contributor final physical member count differs');
      current();
      data.finished = true;
      recordVersionWork('contributorBackingPhysicalMemberVisits', 2 * entries);
      return runContributorRecordTerminalExecution(execution, data.db, witness, plan);
    },
  );
  return verified.result;
}

export function installContributorRecordStagingHead(
  witness: ContributorRecordStagingWitness,
  indexed: ContributorRecordIndexedPublication,
  plan: ContributorRecordBackingPlan,
): void {
  const data = witnesses.get(witness);
  if (!data || !data.finished || !data.head || !data.pending)
    throw Error('Contributor HEAD installation not sealed');
  retained(data);
  if (!contributorRecordHeadPublicationCurrent(data.storage, data.head))
    throw Error('Contributor HEAD installation owner changed');
  if (
    data.pending.head !== data.candidateHead ||
    data.pending.plan !== plan ||
    !consumeContributorRecordBackingAdvance(data.db, indexed, witness, data.pending.head, plan)
  )
    throw Error('Contributor indexed backing transition unavailable');
  const cap = data.head;
  data.finished = false;
  installContributorRecordHeadPublication(data.storage, cap);
  data.installedSuccessor = captureContributorRecordInstalledReadOwner(data.storage, cap);
  const paths = ['', 'objects', 'head'],
    parents = [];
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index]!;
    const actual = unlockPhysicalIdentity(resolve(data.location.base, path));
    parents.push(Object.freeze({ path, kind: actual.kind, identity: actual.value }));
  }
  data.installedParents = Object.freeze(parents);
  data.installed = true;
}

/** Post-commit derivative promotion is not publication permission. A failed
 * promotion expires the cache but preserves the already committed receipt. */
export function completeContributorRecordStagingPublication(
  db: Database,
  witness: ContributorRecordStagingWitness,
  plan: ContributorRecordBackingPlan,
): void {
  // Validate the actual one-use committed grant BEFORE observing a possibly
  // disposed derivative. Closing resources cannot erase an accepted receipt.
  consumeContributorRecordBackingPublication(plan, db, witness);
  const data = witnesses.get(witness);
  if (!data) return;
  if (
    data.db !== db ||
    !db.isOpen ||
    !data.installed ||
    !data.head ||
    !data.pending ||
    !data.prepared ||
    data.pending.plan !== plan
  ) {
    try {
      closeContributorRecordStaging(witness);
    } catch {
      /* accepted receipt survives disposal */
    }
    return;
  }
  const prepared = data.prepared;
  const previousFrontier = frontiers.get(data.storage);
  let successor: ContributorRecordReadOwner | undefined;
  try {
    if (
      !prepared.physical?.current() ||
      BigInt(String(get(prepared.statements.changes)!.n)) !== prepared.expectedChanges ||
      get(prepared.statements.schema)!.schema_version !== prepared.schema ||
      get(prepared.statements.tempSchema)!.schema_version !== prepared.tempSchema ||
      get(prepared.statements.dataVersion)!.data_version !== prepared.dataVersion ||
      get(prepared.statements.count)!.n !== data.staged
    )
      throw Error('Contributor accepted scratch continuation changed');
    successor = data.installedSuccessor;
    if (
      !successor ||
      !contributorRecordReadOwnerCurrent(data.storage, successor) ||
      !data.installedParents
    )
      throw Error('Contributor original installed successor changed');
    prepared.physical.close();
    prepared.physical = undefined;
    const sign = (path: string, kind: string, identity: string) =>
      createHmac('sha256', prepared.input.signatureKey)
        .update(JSON.stringify([prepared.input.nonce, path, kind, identity]))
        .digest('hex');
    for (let sequence = 0; sequence < data.staged; sequence++) {
      const row = get(prepared.statements.own, sequence);
      if (
        !row ||
        row.signature !==
          createHmac('sha256', prepared.input.signatureKey)
            .update(
              JSON.stringify([
                prepared.input.nonce,
                'own-addition',
                row.name,
                row.identity,
                row.sha256,
                row.bytes,
              ]),
            )
            .digest('hex')
      )
        throw Error('Contributor accepted own addition changed');
      if (
        run(
          prepared.statements.promote,
          row.name,
          'file',
          row.identity,
          sign(String(row.name), 'file', String(row.identity)),
        ).changes !== 1
      )
        throw Error('Contributor accepted own addition membership changed');
      prepared.expectedChanges++;
    }
    // Only identities changed by this exact create-only object recipe and
    // lexical HEAD installer advance. No namespace enumeration occurs here.
    for (const original of data.installedParents) {
      const { path } = original,
        actual = unlockPhysicalIdentity(resolve(data.location.base, path));
      if (
        actual.kind !== original.kind ||
        actual.value !== original.identity ||
        (path === 'head' ? actual.kind !== 'file' : actual.kind !== 'directory') ||
        run(
          prepared.statements.replace,
          actual.kind,
          original.identity,
          sign(path, original.kind, original.identity),
          path,
        ).changes !== 1
      )
        throw Error('Contributor accepted owned parent continuation changed');
      prepared.expectedChanges++;
    }
    prepared.expectedChanges +=
      BigInt(run(prepared.statements.clearOwn).changes) +
      BigInt(run(prepared.statements.clearSources).changes) +
      BigInt(run(prepared.statements.clearArtifacts).changes);
    prepared.entries += data.staged;
    prepared.root = data.pending.root;
    prepared.input.selectedHead = data.pending.head;
    prepared.input.originalSources = undefined;
    prepared.input.originalArtifacts = undefined;
    prepared.input.objectsIdentity = undefined;
    prepared.input.objectsSignature = undefined;
    // The certificate root now names the staged HEAD, but the retained replay
    // projection does not; it can no longer extend this proof.
    dropReplay(prepared);
    const physical = realpathSync.native(prepared.input.physical);
    prepared.physical = captureRecordHeadPhysical([physical], [dirname(physical)]);
    if (previousFrontier) closeContributorRecordReadOwner(previousFrontier.original);
    frontiers.set(data.storage, {
      db: data.db,
      original: successor,
      prepared,
      poisoned: false,
      active: false,
    });
    successor = undefined;
    data.installedSuccessor = undefined;
    data.prepared = undefined;
    try {
      closeContributorRecordStaging(witness);
    } catch {
      /* accepted receipt survives disposal */
    }
  } catch {
    try {
      if (successor) closeContributorRecordReadOwner(successor);
    } catch {
      /* continue disposal */
    }
    try {
      if (previousFrontier) closeContributorRecordReadOwner(previousFrontier.original);
    } catch {
      /* continue disposal */
    }
    // An uncertain derivative must not adopt orphan additions on a later try.
    frontiers.set(data.storage, {
      db: data.db,
      original: data.original,
      prepared,
      poisoned: true,
      active: false,
    });
    try {
      closeContributorRecordStaging(witness);
    } catch {
      /* accepted receipt survives disposal */
    }
  }
}

export function discardContributorRecordStaging(witness: ContributorRecordStagingWitness): void {
  closeContributorRecordStaging(witness);
}
/** After this process's own ordinary HEAD publication, record its exact HEAD
 * bytes provisionally. The next retained capture reconciles the complete
 * physical roster before any derivative proof can use it. */
export function retireContributorRecordStagingAfterOrdinaryHead(
  storage: object,
  published?: { head: string; previous: string | null },
): void {
  const frontier = frontiers.get(storage);
  if (!frontier || frontier.poisoned || frontier.active) return;
  if (published && recordOwnContributorPublication(storage, frontier, published)) return;
  discardFrontier(storage, frontier);
}
function recordOwnContributorPublication(
  storage: object,
  frontier: RetainedFrontier,
  published: { head: string; previous: string | null },
): boolean {
  const prepared = frontier.prepared,
    ownHeads = frontier.ownHeads ?? [],
    ownObjects = frontier.ownObjects ?? [],
    provisionalObjects = frontier.provisionalObjects ?? [];
  let successor: ContributorRecordReadOwner | undefined;
  try {
    const { statements } = prepared;
    if (
      !prepared.replay?.current() ||
      !prepared.sql.isOpen ||
      (prepared.physical && !prepared.physical.current()) ||
      ownHeads.length >= MAX_OWN_HEADS ||
      published.previous !==
        (ownHeads.length ? ownHeads[ownHeads.length - 1] : prepared.input.selectedHead) ||
      get(statements.count)!.n !== 0 ||
      BigInt(String(get(statements.changes)!.n)) !== prepared.expectedChanges ||
      get(statements.schema)!.schema_version !== prepared.schema ||
      get(statements.tempSchema)!.schema_version !== prepared.tempSchema ||
      get(statements.dataVersion)!.data_version !== prepared.dataVersion
    )
      return false;
    successor = captureContributorRecordReadOwner(storage);
    if (
      !successor ||
      contributorRecordBackingLocation(storage, successor)?.base !== prepared.input.base ||
      contributorRecordReadOwnerHeadBytes(storage, successor).toString('utf8') !== published.head
    )
      return false;
    const receipt = takeContributorRecordOwnPublication(storage, successor, published);
    if (
      !receipt?.length ||
      ownObjects.length + provisionalObjects.length + receipt.length > 64 * MAX_OWN_HEADS
    )
      return false;
    const names = new Set([...ownObjects, ...provisionalObjects.map((item) => item.name)]);
    for (const item of receipt) {
      if (names.has(item.name)) return false;
      names.add(item.name);
    }
    const sign = signedPhysical(prepared),
      marker = unlockPhysicalIdentity(prepared.input.marker),
      markerRow = get(statements.physicalRow, '@marker');
    if (
      marker.kind !== 'file' ||
      markerRow?.identity !== marker.value ||
      markerRow.signature !== sign('@marker', 'file', marker.value)
    )
      return false;
    closeContributorRecordReadOwner(frontier.original);
    frontier.original = successor;
    successor = undefined;
    frontier.ownHeads = [...ownHeads, published.head];
    frontier.provisionalHeads = (frontier.provisionalHeads ?? 0) + 1;
    frontier.provisionalObjects = [...provisionalObjects, ...receipt];
    recordVersionWork('contributorBackingOwnHeadsRecorded');
    return true;
  } catch {
    return false;
  } finally {
    if (successor) closeContributorRecordReadOwner(successor);
  }
}

function reconcileOwnContributorPublications(
  storage: object,
  frontier: RetainedFrontier,
  original: ContributorRecordReadOwner,
): void {
  const prepared = frontier.prepared,
    pending = frontier.provisionalHeads ?? 0,
    ownHeads = frontier.ownHeads ?? [],
    ownObjects = frontier.ownObjects ?? [],
    receipts = frontier.provisionalObjects ?? [],
    { statements } = prepared;
  if (!pending || pending > ownHeads.length || !receipts.length || !frontier.active)
    throw Error('Contributor own publication reconciliation unavailable');
  const unobserved = new Map(receipts.map((item) => [item.name, item.identity]));
  if (unobserved.size !== receipts.length)
    throw Error('Contributor own publication object receipt changed');
  const current = () => {
    if (
      frontiers.get(storage) !== frontier ||
      !frontier.active ||
      !prepared.sql.isOpen ||
      !prepared.replay?.current() ||
      !contributorRecordReadOwnersSameSelection(storage, frontier.original, original) ||
      contributorRecordReadOwnerHeadBytes(storage, original).toString('utf8') !==
        ownHeads[ownHeads.length - 1] ||
      replayResidue.some((suffix) => existsSync(prepared.input.database + suffix))
    )
      throw Error('Contributor own publication owner changed');
  };
  current();
  if (
    (prepared.physical && !prepared.physical.current()) ||
    get(statements.count)!.n !== 0 ||
    BigInt(String(get(statements.changes)!.n)) !== prepared.expectedChanges ||
    get(statements.schema)!.schema_version !== prepared.schema ||
    get(statements.tempSchema)!.schema_version !== prepared.tempSchema ||
    get(statements.dataVersion)!.data_version !== prepared.dataVersion
  )
    throw Error('Contributor own publication scratch changed');
  const sign = signedPhysical(prepared),
    marker = unlockPhysicalIdentity(prepared.input.marker),
    markerRow = get(statements.physicalRow, '@marker');
  if (
    marker.kind !== 'file' ||
    markerRow?.identity !== marker.value ||
    markerRow.signature !== sign('@marker', 'file', marker.value)
  )
    throw Error('Contributor own publication marker changed');
  const replaced: { path: string; kind: string; identity: string }[] = [],
    added: { path: string; identity: string }[] = [];
  let members = 0;
  for (const item of unlockPhysicalEntries(prepared.input.base)) {
    members++;
    const row = get(statements.physicalRow, item.path);
    if (row) {
      if (
        row.kind !== item.kind ||
        row.signature !== sign(item.path, String(row.kind), String(row.identity))
      )
        throw Error('Contributor original physical member changed');
      if (row.identity === item.identity) continue;
      if (
        !(item.path === 'head'
          ? item.kind === 'file'
          : ['', 'objects'].includes(item.path) && item.kind === 'directory')
      )
        throw Error('Contributor original physical member changed');
      replaced.push(item);
    } else {
      if (
        item.kind !== 'file' ||
        !/^objects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.path)
      )
        throw Error('Contributor foreign physical member appeared');
      if (unobserved.get(item.path) !== item.identity)
        throw Error('Contributor own publication object identity changed');
      unobserved.delete(item.path);
      added.push({ path: item.path, identity: item.identity });
    }
    if (added.length + ownObjects.length > 64 * MAX_OWN_HEADS)
      throw Error('Contributor own publication roster exceeded bound');
  }
  recordVersionWork('contributorBackingPhysicalMemberVisits', members);
  if (
    members !== prepared.entries + added.length ||
    added.length < pending ||
    unobserved.size ||
    !replaced.some((item) => item.path === 'head')
  )
    throw Error('Contributor own publication roster changed');
  current();
  if (
    unlockPhysicalIdentity(prepared.input.marker).value !== marker.value ||
    (prepared.physical && !prepared.physical.current()) ||
    BigInt(String(get(statements.changes)!.n)) !== prepared.expectedChanges
  )
    throw Error('Contributor own publication interval changed');
  prepared.physical?.close();
  prepared.physical = undefined;
  prepared.sql.exec('BEGIN');
  try {
    for (const item of replaced) {
      if (
        run(
          statements.replace,
          item.kind,
          item.identity,
          sign(item.path, item.kind, item.identity),
          item.path,
        ).changes !== 1
      )
        throw Error('Contributor own publication roster changed');
    }
    for (const item of added) {
      if (
        run(
          statements.promote,
          item.path,
          'file',
          item.identity,
          sign(item.path, 'file', item.identity),
        ).changes !== 1
      )
        throw Error('Contributor own publication roster changed');
    }
    current();
    prepared.sql.exec('COMMIT');
  } catch (error) {
    if (prepared.sql.isTransaction) prepared.sql.exec('ROLLBACK');
    throw error;
  }
  prepared.expectedChanges += BigInt(replaced.length + added.length);
  prepared.entries += added.length;
  const physical = realpathSync.native(prepared.input.physical);
  prepared.physical = captureRecordHeadPhysical([physical], [dirname(physical)]);
  current();
  if (
    !prepared.physical.current() ||
    BigInt(String(get(statements.changes)!.n)) !== prepared.expectedChanges ||
    get(statements.schema)!.schema_version !== prepared.schema ||
    get(statements.tempSchema)!.schema_version !== prepared.tempSchema ||
    get(statements.dataVersion)!.data_version !== prepared.dataVersion
  )
    throw Error('Contributor own publication reconciliation changed');
  frontier.ownObjects = [...ownObjects, ...added.map((item) => item.path)];
  frontier.provisionalHeads = 0;
  frontier.provisionalObjects = [];
  recordVersionWork('contributorBackingOwnRosterReconciliations');
}
function closeContributorRecordStaging(
  witness: ContributorRecordStagingWitness,
  retainRead = true,
): void {
  const data = witnesses.get(witness);
  const cleanRead =
    retainRead &&
    !!data?.readOnly &&
    !data.callerCheckWithoutPrepared &&
    contributorRecordStagingCurrent(witness);
  witnesses.delete(witness);
  if (!data || data.closed) return;
  data.closed = true;
  storageResources.get(data.storage)?.active.delete(witness);
  let failed: unknown;
  const dispose = (cleanup: () => void) => {
    try {
      cleanup();
    } catch (error) {
      failed ??= error;
    }
  };
  const frontier = frontiers.get(data.storage);
  if (
    data.readOnly &&
    data.prepared &&
    !data.staged &&
    !data.head &&
    !data.pending &&
    cleanRead &&
    (data.reused ? frontier?.prepared === data.prepared : !frontier)
  ) {
    if (frontier) frontier.active = false;
    else
      frontiers.set(data.storage, {
        db: data.db,
        original: data.original,
        prepared: data.prepared,
        poisoned: false,
        active: false,
      });
    data.prepared = undefined;
  } else if (data.readOnly) {
    if (frontier && frontier.prepared === data.prepared) {
      frontiers.delete(data.storage);
      frontier.active = false;
      dispose(() => closeContributorRecordReadOwner(frontier.original));
    }
  } else if (
    data.reused &&
    frontier &&
    frontier.prepared === data.prepared &&
    !data.preparationAttempted &&
    !data.staged &&
    !data.head
  ) {
    frontier.active = false;
    data.prepared = undefined;
  } else if (data.reused && frontier && frontier.prepared === data.prepared) {
    frontier.poisoned = true;
    frontier.active = false;
    dispose(() => closeContributorRecordReadOwner(frontier.original));
  } else if (retainRead && data.prepared && !frontier && !closedStorages.has(data.storage)) {
    frontiers.set(data.storage, {
      db: data.db,
      original: data.original,
      prepared: data.prepared,
      poisoned: true,
      active: false,
    });
  }
  if (data.head) dispose(() => closeContributorRecordHeadPublication(data.head!));
  if (data.installedSuccessor)
    dispose(() => closeContributorRecordReadOwner(data.installedSuccessor!));
  dispose(() => closeContributorRecordWriteWitness(data.writes));
  if (data.prepared) {
    dispose(() => closePrepared(data.prepared!));
  }
  if (failed) throw failed;
}
