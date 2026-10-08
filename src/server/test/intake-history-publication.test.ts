/** Small publication diagnosis; the original full identity histories remain separate gates. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { writeFileSync, opendirSync, statSync } from 'node:fs';
import crypto from 'node:crypto';
import { Session } from 'node:inspector';
import { syncBuiltinESMExports } from 'node:module';
import timers from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { observeTransactionBeforePublication, type Database } from '../database.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import {
  registerIntakeFile,
  intakeSourceVersion,
  type IntakeDetails,
} from '../intake-state-access.ts';
import {
  intakeCandidateId,
  intakeCandidateVersionIdForRevision,
  workflowHash,
} from '../intake-workflow.ts';
import { canonicalLiteral, validateJSONL, validationSummary } from '../intake-format.ts';
import { profileOriginal, profilePaths } from '../profile-storage.ts';
import { intakeTransaction } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { prepareIntakeWorkflowCommand } from '../intake-workflow-command.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { fixture, envelope } from './intake-identity-native-fixture.ts';
import { getNativeIntakeIdentityReview } from '../intake-identity-native.ts';

function journalBytes(path: string): number {
  let bytes = 0;
  const directory = opendirSync(path);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      const child = join(path, entry.name);
      bytes += entry.isDirectory() ? journalBytes(child) : statSync(child).size;
    }
  } finally {
    directory.closeSync();
  }
  return bytes;
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

// Node's test mocks retain every call argument/result. These probes retain
// aggregate counts and SQL shapes, never bound values or returned history.
function replaceMethod(target: object, key: string, replacement: unknown) {
  const original = Reflect.get(target, key);
  Reflect.set(target, key, replacement);
  return () => {
    Reflect.set(target, key, original);
  };
}

function execShape(query: string): string {
  const value = query.trimStart().toUpperCase();
  if (/^COMMIT\s*;?\s*$/.test(value)) return 'COMMIT';
  if (/^BEGIN IMMEDIATE\s*;?\s*$/.test(value)) return 'BEGIN IMMEDIATE';
  if (/^ROLLBACK\s*;?\s*$/.test(value)) return 'ROLLBACK';
  if (/^PRAGMA\b/.test(value)) return 'PRAGMA';
  return (value.match(/^[A-Z]+/)?.[0] ?? 'OTHER') + (value.includes(';') ? ' MULTI' : '');
}

function observePublication(
  t: test.TestContext,
  db: Database,
  id: string,
  archive: string,
  databasePath: string,
  pageSize: number,
  walCheckpointPages: number,
) {
  const collections = selectedEnvelopeStore(db, { id }).collections;
  const record = createRecordVersionWorkCounters();
  type Totals = {
    calls: number;
    elapsedMs: number;
    cpuMicros: number;
    sqlPrepared: number;
    sqlExecuted: number;
    work: Record<string, number>;
    record: Record<string, number>;
    filesystem: Record<string, { calls: number; elapsedMs: number; bytes: number }>;
    dbExec: Record<string, { calls: number; elapsedMs: number; fsWrite: number }>;
    processFsWrite: number;
  };
  const phases = new Map<string, Totals>();
  const maintenanceSegments = new Map<string, Totals>();
  const stack: string[] = [];
  const snapshot = () => intakeWorkCounters(db).warm;
  const start = snapshot();
  const probeFsWriteBefore = process.resourceUsage().fsWrite;
  const sql = { prepared: 0, executed: 0 };
  const retainedBytesBefore = journalBytes(archive);
  const databaseFiles = () => ({
    mainBytes: fileBytes(databasePath),
    walBytes: fileBytes(databasePath + '-wal'),
    pageSize,
  });
  // A WAL file may retain its length after its valid frames reset. Read only
  // SQLite's fixed header; never treat file length as frame count.
  const walSample = () => {
    let files: { mainBytes: number | null; walBytes: number | null; pageSize: number };
    try {
      files = databaseFiles();
    } catch {
      files = { mainBytes: null, walBytes: null, pageSize };
    }
    let header: { cycle: string; checkpointSequence: number } | null = null;
    if (files.walBytes !== null && files.walBytes >= 32) {
      try {
        const fd = fs.openSync(databasePath + '-wal', 'r');
        try {
          const bytes = Buffer.allocUnsafe(32);
          if (fs.readSync(fd, bytes, 0, 32, 0) === 32) {
            const magic = bytes.readUInt32BE(0);
            if (
              (magic === 0x377f0682 || magic === 0x377f0683) &&
              bytes.readUInt32BE(4) === 3007000 &&
              bytes.readUInt32BE(8) === pageSize
            )
              header = {
                cycle: bytes.subarray(16, 24).toString('hex'),
                checkpointSequence: bytes.readUInt32BE(12),
              };
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // A missing or short header is an unavailable sample, not zero frames.
      }
    }
    return { ...files, header, processFsWriteUnits: process.resourceUsage().fsWrite };
  };
  type WalSample = ReturnType<typeof walSample>;
  type WalCommitWindow = {
    firstCommit: number;
    lastCommit: number;
    commits: number;
    nodesWritten: number;
    commitMs: number;
    commitFsWriteUnits: number;
    betweenCommitFsWriteUnits: number;
    mainFileLengthDeltaBeforeCommit: number;
    walFileLengthDeltaBeforeCommit: number;
    mainFileLengthDeltaDuringCommit: number;
    walFileLengthDeltaDuringCommit: number;
    mainFileLengthGrowthCommits: number;
    unavailableFileLengthPairs: number;
    cycleChangedBeforeCommit: number;
    cycleChangedDuringCommit: number;
    sequenceChangedBeforeCommit: number;
    sequenceChangedDuringCommit: number;
    unavailableBetweenCommitHeaderPairs: number;
    unavailableHeaderPairs: number;
  };
  const walCommitWindows = new Map<number, WalCommitWindow>();
  type PriorCommit = {
    after: WalSample;
    nodesWritten: number;
    elapsedMs: number;
    fsWriteUnits: number;
    mainFileLengthGrowth: boolean | null;
  };
  type PriorCommitTotals = {
    commits: number;
    nodesWritten: number;
    commitMs: number;
    commitFsWriteUnits: number;
    mainFileLengthGrowthCommits: number;
    unavailableMainFileLengthPairs: number;
  };
  const priorCommitTotals = (): PriorCommitTotals => ({
    commits: 0,
    nodesWritten: 0,
    commitMs: 0,
    commitFsWriteUnits: 0,
    mainFileLengthGrowthCommits: 0,
    unavailableMainFileLengthPairs: 0,
  });
  const resetFollowed = priorCommitTotals();
  const noResetFollowed = priorCommitTotals();
  const unclassified = priorCommitTotals();
  const unclassifiedReasons = { finalCommit: 0, unavailableHeader: 0, observationGap: 0 };
  const addPrior = (totals: PriorCommitTotals, prior: PriorCommit) => {
    totals.commits++;
    totals.nodesWritten += prior.nodesWritten;
    totals.commitMs += prior.elapsedMs;
    totals.commitFsWriteUnits += prior.fsWriteUnits;
    if (prior.mainFileLengthGrowth === null) totals.unavailableMainFileLengthPairs++;
    else if (prior.mainFileLengthGrowth) totals.mainFileLengthGrowthCommits++;
  };
  let pendingPrior: PriorCommit | undefined;
  let previousCommitAfter: WalSample | undefined;
  let previousCommitNodes = intakeWorkCounters(db).warm.collectionNodesWritten;
  let fixtureCommitAttempts = 0;
  let walObservationFailures = 0;
  const observeWalCommit = (
    before: WalSample,
    after: WalSample,
    elapsedMs: number,
    fsWriteUnits: number,
  ) => {
    const ordinal = fixtureCommitAttempts;
    const windowIndex = Math.min(15, Math.floor((ordinal - 1) / 32));
    const window = walCommitWindows.get(windowIndex) ?? {
      firstCommit: ordinal,
      lastCommit: ordinal,
      commits: 0,
      nodesWritten: 0,
      commitMs: 0,
      commitFsWriteUnits: 0,
      betweenCommitFsWriteUnits: 0,
      mainFileLengthDeltaBeforeCommit: 0,
      walFileLengthDeltaBeforeCommit: 0,
      mainFileLengthDeltaDuringCommit: 0,
      walFileLengthDeltaDuringCommit: 0,
      mainFileLengthGrowthCommits: 0,
      unavailableFileLengthPairs: 0,
      cycleChangedBeforeCommit: 0,
      cycleChangedDuringCommit: 0,
      sequenceChangedBeforeCommit: 0,
      sequenceChangedDuringCommit: 0,
      unavailableBetweenCommitHeaderPairs: 0,
      unavailableHeaderPairs: 0,
    };
    const nodes = intakeWorkCounters(db).warm.collectionNodesWritten;
    window.lastCommit = ordinal;
    window.commits++;
    window.nodesWritten += nodes - previousCommitNodes;
    window.commitMs += elapsedMs;
    window.commitFsWriteUnits += fsWriteUnits;
    if (previousCommitAfter) {
      window.betweenCommitFsWriteUnits +=
        before.processFsWriteUnits - previousCommitAfter.processFsWriteUnits;
      if (
        before.mainBytes !== null &&
        before.walBytes !== null &&
        previousCommitAfter.mainBytes !== null &&
        previousCommitAfter.walBytes !== null
      ) {
        window.mainFileLengthDeltaBeforeCommit += before.mainBytes - previousCommitAfter.mainBytes;
        window.walFileLengthDeltaBeforeCommit += before.walBytes - previousCommitAfter.walBytes;
      } else window.unavailableFileLengthPairs++;
    }
    if (
      before.mainBytes !== null &&
      before.walBytes !== null &&
      after.mainBytes !== null &&
      after.walBytes !== null
    ) {
      window.mainFileLengthDeltaDuringCommit += after.mainBytes - before.mainBytes;
      window.walFileLengthDeltaDuringCommit += after.walBytes - before.walBytes;
      if (after.mainBytes > before.mainBytes) window.mainFileLengthGrowthCommits++;
    } else window.unavailableFileLengthPairs++;
    if (before.header && after.header) {
      if (before.header.cycle !== after.header.cycle) window.cycleChangedDuringCommit++;
      if (before.header.checkpointSequence !== after.header.checkpointSequence)
        window.sequenceChangedDuringCommit++;
    } else window.unavailableHeaderPairs++;
    if (previousCommitAfter?.header && before.header) {
      if (previousCommitAfter.header.cycle !== before.header.cycle)
        window.cycleChangedBeforeCommit++;
      if (previousCommitAfter.header.checkpointSequence !== before.header.checkpointSequence)
        window.sequenceChangedBeforeCommit++;
    } else if (previousCommitAfter) window.unavailableBetweenCommitHeaderPairs++;
    walCommitWindows.set(windowIndex, window);
    if (pendingPrior) {
      if (pendingPrior.after.header && before.header)
        addPrior(
          pendingPrior.after.header.cycle === before.header.cycle ? noResetFollowed : resetFollowed,
          pendingPrior,
        );
      else {
        addPrior(unclassified, pendingPrior);
        unclassifiedReasons.unavailableHeader++;
      }
    }
    pendingPrior = {
      after,
      nodesWritten: nodes - previousCommitNodes,
      elapsedMs,
      fsWriteUnits,
      mainFileLengthGrowth:
        before.mainBytes !== null && after.mainBytes !== null
          ? after.mainBytes > before.mainBytes
          : null,
    };
    previousCommitAfter = after;
    previousCommitNodes = nodes;
  };
  const databaseFilesBefore = databaseFiles();
  const recordBtrees = [
    '__record_versions',
    '__record_fields',
    '__record_current',
    '__record_history',
    '__record_time',
    '__record_link_owner',
    '__record_attachment_owner',
    '__record_field_history',
  ] as const;
  const recordBtreeFootprint = () => {
    try {
      const rows = (() => {
        const reader = new DatabaseSync(databasePath, { readOnly: true });
        try {
          return reader
            .prepare(
              `SELECT name,count(*) AS pages,sum(pgsize) AS bytes FROM dbstat WHERE name IN (${recordBtrees.map(() => '?').join(',')}) GROUP BY name`,
            )
            .all(...recordBtrees);
        } finally {
          reader.close();
        }
      })();
      const found = new Map(rows.map((row) => [String(row.name), row]));
      return Object.fromEntries(
        recordBtrees.map((name) => [
          name,
          {
            pages: Number(found.get(name)?.pages ?? 0),
            bytes: Number(found.get(name)?.bytes ?? 0),
          },
        ]),
      );
    } catch {
      return null;
    }
  };
  const recordBtreesBefore = recordBtreeFootprint();
  let maxObservedWalBytes = databaseFilesBefore.walBytes;
  const filesystem = new Map<string, { calls: number; elapsedMs: number; bytes: number }>();
  const dbExec = new Map<string, { calls: number; elapsedMs: number; fsWrite: number }>();
  const sqlTimings = new Map<string, { calls: number; elapsedMs: number }>();
  type BatchKind = 'build' | 'adoption' | 'other';
  type BatchInfo = { kind: BatchKind; changes: number; keyed: number; repeated: number };
  const preparedBatches = new WeakMap<object, BatchInfo>();
  const batchOccupancy = new Map<
    BatchKind,
    {
      prepared: number;
      committed: number;
      changes: number;
      keyed: number;
      repeated: number;
      histogram: number[];
      commitMs: number;
      commitFsWrite: number;
      processFsWrite: number;
      walFileSizeDelta: number;
      mainFileSizeDelta: number;
    }
  >();
  const batchTotals = (kind: BatchKind) => {
    let totals = batchOccupancy.get(kind);
    if (!totals) {
      totals = {
        prepared: 0,
        committed: 0,
        changes: 0,
        keyed: 0,
        repeated: 0,
        histogram: Array(65).fill(0) as number[],
        commitMs: 0,
        commitFsWrite: 0,
        processFsWrite: 0,
        walFileSizeDelta: 0,
        mainFileSizeDelta: 0,
      };
      batchOccupancy.set(kind, totals);
    }
    return totals;
  };
  const describeBatch = (input: unknown): BatchInfo | undefined => {
    const changes = (input as { changes?: unknown })?.changes;
    if (!Array.isArray(changes) || changes.length > 64) return undefined;
    const kind: BatchKind =
      changes.length === 1 && changes[0]?.op === 'adoptCollection'
        ? 'adoption'
        : changes.every((change) => change?.area === 'builds')
          ? 'build'
          : 'other';
    const keys = new Set<string>();
    let keyed = 0;
    let repeated = 0;
    for (const change of changes) {
      if (typeof change?.key !== 'string') continue;
      keyed++;
      const key = JSON.stringify([change.area, change.collection, change.key]);
      if (keys.has(key)) repeated++;
      else keys.add(key);
    }
    return { kind, changes: changes.length, keyed, repeated };
  };
  const restores: Array<() => void> = [];
  let removeObserver: (() => void) | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    removeObserver?.();
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
  };
  t.after(dispose);
  const install = (target: object, key: string, replacement: unknown) => {
    restores.push(replaceMethod(target, key, replacement));
  };
  const point = () => ({
    elapsedMs: performance.now(),
    cpu: process.cpuUsage(),
    fsWrite: process.resourceUsage().fsWrite,
    sql: { ...sql },
    work: { ...snapshot() } as Record<string, number>,
    record: { ...record.operation } as Record<string, number>,
    filesystem: Object.fromEntries(
      [...filesystem].map(([key, value]) => [key, { ...value }]),
    ) as Record<string, { calls: number; elapsedMs: number; bytes: number }>,
    dbExec: Object.fromEntries([...dbExec].map(([key, value]) => [key, { ...value }])) as Record<
      string,
      { calls: number; elapsedMs: number; fsWrite: number }
    >,
  });
  type Point = ReturnType<typeof point>;
  const difference = (before: Record<string, number>, after: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(after)
        .filter(
          ([key, value]) =>
            !key.includes('Peak') && !key.startsWith('max') && value !== (before[key] ?? 0),
        )
        .map(([key, value]) => [key, value - (before[key] ?? 0)]),
    );
  const accumulate = (target: Map<string, Totals>, name: string, before: Point, after: Point) => {
    const value = target.get(name) ?? {
      calls: 0,
      elapsedMs: 0,
      cpuMicros: 0,
      sqlPrepared: 0,
      sqlExecuted: 0,
      work: {},
      record: {},
      filesystem: {},
      dbExec: {},
      processFsWrite: 0,
    };
    value.calls++;
    value.elapsedMs += after.elapsedMs - before.elapsedMs;
    value.cpuMicros += after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system;
    value.sqlPrepared += after.sql.prepared - before.sql.prepared;
    value.sqlExecuted += after.sql.executed - before.sql.executed;
    value.processFsWrite += after.fsWrite - before.fsWrite;
    for (const [key, count] of Object.entries(difference(before.work, after.work)))
      value.work[key] = (value.work[key] ?? 0) + count;
    for (const [key, count] of Object.entries(difference(before.record, after.record)))
      value.record[key] = (value.record[key] ?? 0) + count;
    for (const [key, totals] of Object.entries(after.filesystem)) {
      const prior = before.filesystem[key] ?? { calls: 0, elapsedMs: 0, bytes: 0 };
      const delta = value.filesystem[key] ?? { calls: 0, elapsedMs: 0, bytes: 0 };
      delta.calls += totals.calls - prior.calls;
      delta.elapsedMs += totals.elapsedMs - prior.elapsedMs;
      delta.bytes += totals.bytes - prior.bytes;
      value.filesystem[key] = delta;
    }
    for (const [key, totals] of Object.entries(after.dbExec)) {
      const prior = before.dbExec[key] ?? { calls: 0, elapsedMs: 0, fsWrite: 0 };
      const delta = value.dbExec[key] ?? { calls: 0, elapsedMs: 0, fsWrite: 0 };
      delta.calls += totals.calls - prior.calls;
      delta.elapsedMs += totals.elapsedMs - prior.elapsedMs;
      delta.fsWrite += totals.fsWrite - prior.fsWrite;
      value.dbExec[key] = delta;
    }
    target.set(name, value);
    return value;
  };
  let activeMaintenance:
    { entry: Point; stageEntry?: Point; stageExit?: Point; verified?: Point } | undefined;
  removeObserver = observeTransactionBeforePublication(db, () => {
    if (activeMaintenance) activeMaintenance.verified = point();
  });
  try {
    for (const method of ['readFileSync', 'writeFileSync', 'fsyncSync', 'lstatSync'] as const) {
      const original = fs[method];
      install(fs, method, (...args: unknown[]) => {
        const time = performance.now();
        let bytes = 0;
        try {
          const result = Reflect.apply(original, fs, args);
          if (method === 'readFileSync' && (typeof result === 'string' || Buffer.isBuffer(result)))
            bytes = Buffer.byteLength(result);
          if (method === 'writeFileSync') {
            if (typeof args[1] === 'string') bytes = Buffer.byteLength(args[1]);
            else if (ArrayBuffer.isView(args[1])) bytes = args[1].byteLength;
          }
          return result;
        } finally {
          const value = filesystem.get(method) ?? { calls: 0, elapsedMs: 0, bytes: 0 };
          value.calls++;
          value.elapsedMs += performance.now() - time;
          value.bytes += bytes;
          filesystem.set(method, value);
        }
      });
    }
    syncBuiltinESMExports();
    const statementPrototype = Object.getPrototypeOf(db.prepare('SELECT 1'));
    for (const method of ['run', 'get', 'all', 'iterate'] as const) {
      const original = statementPrototype[method];
      install(
        statementPrototype,
        method,
        function (this: { sourceSQL: string }, ...args: unknown[]) {
          sql.executed++;
          const time = performance.now();
          try {
            return Reflect.apply(original, this, args);
          } finally {
            const key = method + ':' + this.sourceSQL;
            const value = sqlTimings.get(key) ?? { calls: 0, elapsedMs: 0 };
            value.calls++;
            value.elapsedMs += performance.now() - time;
            sqlTimings.set(key, value);
          }
        },
      );
    }
    const prepareSql = DatabaseSync.prototype.prepare;
    install(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, query: string) {
      sql.prepared++;
      return prepareSql.call(this, query);
    });
    const executeSql = DatabaseSync.prototype.exec;
    install(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, query: string) {
      const shape = execShape(query);
      const fixtureCommit = shape === 'COMMIT' && this === db;
      if (fixtureCommit) fixtureCommitAttempts++;
      const commitBefore = fixtureCommit ? walSample() : undefined;
      const time = performance.now();
      const fsWrite = process.resourceUsage().fsWrite;
      try {
        return executeSql.call(this, query);
      } finally {
        const elapsedMs = performance.now() - time;
        const fsWriteUnits = process.resourceUsage().fsWrite - fsWrite;
        const value = dbExec.get(shape) ?? { calls: 0, elapsedMs: 0, fsWrite: 0 };
        value.calls++;
        value.elapsedMs += elapsedMs;
        value.fsWrite += fsWriteUnits;
        dbExec.set(shape, value);
        if (commitBefore) {
          try {
            const commitAfter = walSample();
            observeWalCommit(commitBefore, commitAfter, elapsedMs, fsWriteUnits);
            if (commitAfter.walBytes !== null)
              maxObservedWalBytes = Math.max(maxObservedWalBytes, commitAfter.walBytes);
          } catch {
            walObservationFailures++;
            if (pendingPrior) {
              addPrior(unclassified, pendingPrior);
              unclassifiedReasons.observationGap++;
              pendingPrior = undefined;
            }
          }
        }
      }
    });
    for (const method of ['prepare', 'stage', 'commitMaintenance'] as const) {
      const original = collections[method];
      install(collections, method, (...args: unknown[]) => {
        const phase = [...stack, method].join('/');
        stack.push(method);
        const before = point();
        const committedBatch =
          method === 'commitMaintenance' && args[0] && typeof args[0] === 'object'
            ? preparedBatches.get(args[0])
            : undefined;
        const filesBefore = committedBatch ? databaseFiles() : undefined;
        let completed = false;
        if (method === 'commitMaintenance') activeMaintenance = { entry: before };
        if (phase === 'commitMaintenance/stage' && activeMaintenance)
          activeMaintenance.stageEntry = before;
        try {
          const result = Reflect.apply(original, collections, args);
          completed = true;
          if (method === 'prepare' && result && typeof result === 'object') {
            const batch = describeBatch(args[1]);
            if (batch) {
              preparedBatches.set(result, batch);
              const totals = batchTotals(batch.kind);
              totals.prepared++;
              totals.changes += batch.changes;
              totals.keyed += batch.keyed;
              totals.repeated += batch.repeated;
              totals.histogram[batch.changes]++;
            }
          }
          return result;
        } finally {
          const after = point();
          const value = accumulate(phases, phase, before, after);
          if (committedBatch && completed) {
            const totals = batchTotals(committedBatch.kind);
            const previousCommit = before.dbExec.COMMIT ?? { elapsedMs: 0, fsWrite: 0 };
            const currentCommit = after.dbExec.COMMIT ?? { elapsedMs: 0, fsWrite: 0 };
            const filesAfter = databaseFiles();
            totals.committed++;
            totals.commitMs += currentCommit.elapsedMs - previousCommit.elapsedMs;
            totals.commitFsWrite += currentCommit.fsWrite - previousCommit.fsWrite;
            totals.processFsWrite += after.fsWrite - before.fsWrite;
            totals.walFileSizeDelta += filesAfter.walBytes - filesBefore!.walBytes;
            totals.mainFileSizeDelta += filesAfter.mainBytes - filesBefore!.mainBytes;
          }
          if (phase === 'commitMaintenance/stage' && activeMaintenance)
            activeMaintenance.stageExit = after;
          if (method === 'commitMaintenance' && activeMaintenance) {
            const { entry, stageEntry, stageExit, verified } = activeMaintenance;
            if (stageEntry) accumulate(maintenanceSegments, 'preStage', entry, stageEntry);
            if (stageEntry && stageExit)
              accumulate(maintenanceSegments, 'stage', stageEntry, stageExit);
            if (stageExit && verified)
              accumulate(maintenanceSegments, 'postStageVerify', stageExit, verified);
            if (verified) accumulate(maintenanceSegments, 'postVerifyPublication', verified, after);
            activeMaintenance = undefined;
          }
          if (process.env.CRS_HISTORY_CHECKPOINTS === '1')
            t.diagnostic(
              JSON.stringify({
                phase,
                checkpoint: value.calls,
                work: difference(before.work, after.work),
                record: difference(before.record, after.record),
                sqlPrepared: after.sql.prepared - before.sql.prepared,
                sqlExecuted: after.sql.executed - before.sql.executed,
              }),
            );
          stack.pop();
        }
      });
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    record,
    finish() {
      const databaseFilesBeforeDrain = databaseFiles();
      const drainBefore = point();
      const checkpoint = db.prepare('PRAGMA main.wal_checkpoint(TRUNCATE)').get();
      const drainAfter = point();
      const finalCheckpointDrain = accumulate(
        maintenanceSegments,
        'finalCheckpointDrain',
        drainBefore,
        drainAfter,
      );
      const databaseFilesAfterDrain = databaseFiles();
      const probeFsWrite = process.resourceUsage().fsWrite - probeFsWriteBefore;
      const fsWriteAvailable = process.platform === 'linux';
      assert.equal(checkpoint?.busy, 0, 'fixture checkpoint must drain without another reader');
      assert.ok(pageSize > 0 && pageSize <= 65536);
      assert.ok(
        Math.max(maxObservedWalBytes, databaseFilesBeforeDrain.walBytes) <= 256 * 1024 * 1024,
        'bounded fictional WAL fixture exceeded its diagnostic file ceiling',
      );
      dispose();
      const recordBtreesAfter = recordBtreeFootprint();
      const end = snapshot();
      const observedWalCommits = [...walCommitWindows.values()].reduce(
        (sum, window) => sum + window.commits,
        0,
      );
      if (pendingPrior) {
        addPrior(unclassified, pendingPrior);
        unclassifiedReasons.finalCommit++;
        pendingPrior = undefined;
      }
      const classified = [resetFollowed, noResetFollowed, unclassified];
      assert.ok(walCommitWindows.size <= 16);
      assert.equal(observedWalCommits + walObservationFailures, fixtureCommitAttempts);
      assert.equal(
        classified.reduce((sum, bucket) => sum + bucket.commits, 0),
        observedWalCommits,
      );
      assert.equal(
        Object.values(unclassifiedReasons).reduce((sum, count) => sum + count, 0),
        unclassified.commits,
      );
      if (!walObservationFailures)
        for (const nodes of [
          [...walCommitWindows.values()].reduce((sum, window) => sum + window.nodesWritten, 0),
          classified.reduce((sum, bucket) => sum + bucket.nodesWritten, 0),
        ])
          assert.equal(nodes, end.collectionNodesWritten - start.collectionNodesWritten);
      const maintenanceNodes = maintenanceSegments.get('stage')?.work.collectionNodesWritten ?? 0;
      const publication = maintenanceSegments.get('postVerifyPublication');
      const retainedJournalGrowthBytes = journalBytes(archive) - retainedBytesBefore;
      t.diagnostic(
        JSON.stringify({
          phases: Object.fromEntries(phases),
          maintenanceSegments: Object.fromEntries(maintenanceSegments),
          batchOccupancy: Object.fromEntries(
            [...batchOccupancy].map(([kind, totals]) => [
              kind,
              {
                ...totals,
                histogram: totals.histogram.flatMap((calls, changes) =>
                  calls ? [[changes, calls]] : [],
                ),
              },
            ]),
          ),
          recordBtreeFootprint:
            recordBtreesBefore && recordBtreesAfter
              ? {
                  before: recordBtreesBefore,
                  after: recordBtreesAfter,
                  growth: Object.fromEntries(
                    recordBtrees.map((name) => [
                      name,
                      {
                        pages: recordBtreesAfter[name].pages - recordBtreesBefore[name].pages,
                        bytes: recordBtreesAfter[name].bytes - recordBtreesBefore[name].bytes,
                      },
                    ]),
                  ),
                }
              : null,
          normalizedMaintenance: {
            nodes: maintenanceNodes,
            nodeBytes: maintenanceSegments.get('stage')?.work.collectionWrittenBytes ?? 0,
            journalEncodedBytesPerNode: maintenanceNodes
              ? (publication?.record.encodedBytes ?? 0) / maintenanceNodes
              : null,
            journalObjectReadBytesPerNode: maintenanceNodes
              ? (publication?.record.objectReadBytes ?? 0) / maintenanceNodes
              : null,
            processFsWriteUnitsPerNode:
              maintenanceNodes && fsWriteAvailable ? probeFsWrite / maintenanceNodes : null,
            postVerifyPublicationFsWriteUnitsPerNode:
              maintenanceNodes && fsWriteAvailable
                ? (publication?.processFsWrite ?? 0) / maintenanceNodes
                : null,
            postVerifyPublicationAndFinalDrainFsWriteUnitsPerNode:
              maintenanceNodes && fsWriteAvailable
                ? ((publication?.processFsWrite ?? 0) + finalCheckpointDrain.processFsWrite) /
                  maintenanceNodes
                : null,
          },
          walCheckpoint: {
            thresholdPages: walCheckpointPages,
            thresholdBytes: walCheckpointPages * pageSize,
            result: checkpoint,
            finalDrain: finalCheckpointDrain,
            databaseFilesBefore,
            databaseFilesBeforeDrain,
            databaseFilesAfterDrain,
            maxObservedWalBytesAfterCommit: maxObservedWalBytes,
          },
          walCommitWindows: [...walCommitWindows.values()],
          priorCommitResetCorrelation: {
            resetFollowed,
            noResetFollowed,
            unclassified,
            unclassifiedReasons,
          },
          walCommitWindowOracle: {
            fixtureCommitAttempts,
            observedWalCommits,
            walObservationFailures,
            nodeParityChecked: walObservationFailures === 0,
          },
          record,
          totalSql: sql,
          filesystem: Object.fromEntries(filesystem),
          dbExec: Object.fromEntries(dbExec),
          probeProcessFsWrite: probeFsWrite,
          retainedJournalGrowthBytes,
          connectionPeakPreparedBytes: end.collectionPeakPreparedBytes,
          sqlTimings: [...sqlTimings].sort((a, b) => b[1].elapsedMs - a[1].elapsedMs).slice(0, 12),
          work: Object.fromEntries(
            Object.entries(end)
              .filter(
                ([key, value]) =>
                  !key.includes('Peak') && value !== start[key as keyof typeof start],
              )
              .map(([key, value]) => [key, value - start[key as keyof typeof start]]),
          ),
          resourceUsage: process.resourceUsage(),
          note: [
            'Instrumented durations include probe overhead. Nested phases overlap; final checkpoint drain is separate from maintenance. Whole-probe process fsWrite includes preparation, staging, publication and final drain after a setup-only WAL drain.',
            'Batch occupancy counts prepared changes and repeats of keyed changes only; byte append operations have no key. Batch COMMIT and process fsWrite totals cover successful maintenance calls.',
            'WAL commit windows hold at most 16 buckets: the first 15 span 32 fixture-connection COMMIT attempts each, and the final bucket absorbs overflow. Each sample reads only the fixed 32-byte WAL header and main/WAL file lengths, not allocated disk blocks or valid frame counts. Unavailable file-length/header pairs are counted, not read as zero.',
            'Between-commit deltas exclude the first call and include all intervening process work, not only SQLite. Header cycle or sequence changes observed before COMMIT may have occurred at the next transaction start; they do not assign checkpoint cost to that COMMIT. Main-file pages can be rewritten without growing the file.',
            'Prior-COMMIT buckets classify one observed COMMIT attempt by the WAL header cycle before the next observed attempt; exec-finally observations also include failed COMMITs. The last attempt and unavailable or interrupted observations remain unclassified. After an observation gap, a node delta can span attempts while elapsed time and process writes belong only to the current observed exec, so such samples are not per-COMMIT ratios. Reset-followed cost is a correlation, not proof that the prior COMMIT performed a checkpoint.',
            'dbstat traverses eight named record B-trees on a separate read-only connection outside publication after WAL drains; its bounded output does not bound scan work. Page lengths are neither whole-cache size, VFS write bytes nor a causal index-cost comparison.',
            'Post-stage verify ends after accepted-row verification; post-verify publication includes revision bookkeeping and journal encode/index/head publication. SQL and db.exec cover all connections; iterate timing excludes iteration. db.exec shapes exclude SQL text/values. Intake work is fixture-connection scoped.',
            'Filesystem bytes are API transfers, not physical device I/O. Linux process fsWrite deltas are kernel-reported write units, not attributable to one SQLite connection; normalized values are unavailable on other platforms. WAL length is sampled after fixture-connection COMMIT, not a physical write count or absolute peak; a bounded transaction can overshoot the configured threshold, so the fixture keeps an independent 256 MiB ceiling. maxRSS and prepared-byte peaks cover process/connection lifetime, not cumulative work.',
          ].join(' '),
        }),
      );
      assert.ok((phases.get('prepare')?.calls ?? 0) > 0);
      assert.ok((phases.get('commitMaintenance/stage')?.calls ?? 0) > 0);
      assert.equal(
        maintenanceSegments.get('postVerifyPublication')?.calls,
        phases.get('commitMaintenance')?.calls,
      );
    },
  };
}

async function publicationFixture(t: test.TestContext, count: number) {
  const f = await fixture(t, false, 1),
    raw = JSON.parse(readIntakeEnvelopeText(f.db, { id: f.original.id })),
    details = raw.intake as IntakeDetails,
    seedCandidate = details.workflow!.candidates[0]!,
    group = details.workflow!.reportGroups!.find((value) => value.id === f.groupId)!,
    seedGroupVersion = group.versions.at(-1)!,
    seedVersion = seedCandidate.versions.at(-1)!,
    oldRecord = envelope('fictional-history');
  oldRecord.payload = { literal: '11.00' };
  oldRecord.clinical = {
    ...(oldRecord.clinical as Record<string, unknown>),
    valueText: '11.00',
  };
  const latestRecord = structuredClone(oldRecord);
  latestRecord.payload = { literal: '12.00' };
  latestRecord.clinical = {
    ...(latestRecord.clinical as Record<string, unknown>),
    valueText: '12.00',
  };
  const oldVersionId = intakeCandidateVersionIdForRevision({
      value: oldRecord,
    }),
    latestVersionId = intakeCandidateVersionIdForRevision({
      value: latestRecord,
    }),
    originalFile = f.db
      .prepare('SELECT id,sha256,provider_id FROM source_files WHERE id=?')
      .get(f.original.id)!,
    historyCandidateId = intakeCandidateId(
      { id: String(originalFile.id), sha256: String(originalFile.sha256) },
      { value: oldRecord },
    ),
    proposal = details.proposals[0]!,
    firstPath = String(
      f.db.prepare('SELECT path FROM source_files WHERE id=?').get(proposal.id)!.path,
    ),
    proposalDirectory = dirname(profileOriginal(f.root, firstPath, f.profileId)),
    artifacts: { id: string; path: string; bytes: number }[] = [],
    occurrences: typeof seedVersion.occurrences = [];
  let latestOccurrence: (typeof occurrences)[number] | undefined;
  assert.notEqual(oldVersionId, latestVersionId);
  assert.notEqual(historyCandidateId, seedCandidate.id);
  assert.equal(proposal.sourceTextRevisionId ?? null, null);
  assert.equal(proposal.sourceTextDependencyToken ?? null, null);
  assert.equal(seedGroupVersion.members.length, 1);
  const baselineCache = Number(f.db.prepare('PRAGMA cache_size').get()?.cache_size);
  const baselineWalCheckpoint = Number(
    f.db.prepare('PRAGMA main.wal_autocheckpoint').get()?.wal_autocheckpoint,
  );
  const candidateWalCheckpoint = process.env.CRS_HISTORY_WAL_CHECKPOINT_PAGES;
  assert.equal(baselineCache, -2000, 'comparison requires the default 2000 KiB cache');
  assert.equal(baselineWalCheckpoint, 32768, 'comparison requires the attached WAL policy');
  if (candidateWalCheckpoint === '1000') f.db.exec('PRAGMA main.wal_autocheckpoint=1000');
  else if (candidateWalCheckpoint === '8192') f.db.exec('PRAGMA main.wal_autocheckpoint=8192');
  else if (candidateWalCheckpoint !== undefined && candidateWalCheckpoint !== '32768')
    throw Error('Unsupported history diagnostic WAL threshold');
  const selectedWalCheckpoint = Number(
    f.db.prepare('PRAGMA main.wal_autocheckpoint').get()?.wal_autocheckpoint,
  );
  assert.equal(selectedWalCheckpoint, Number(candidateWalCheckpoint ?? 32768));
  assert.equal(Number(f.db.prepare('PRAGMA cache_size').get()?.cache_size), baselineCache);
  const pageSize = Number(f.db.prepare('PRAGMA main.page_size').get()?.page_size);
  t.diagnostic(
    JSON.stringify({
      cacheKiB: -baselineCache,
      baselineWalCheckpointPages: baselineWalCheckpoint,
      walCheckpointPages: selectedWalCheckpoint,
      pageSize,
    }),
  );
  await buildIntakeCollectionEnvelope(f.db, { id: f.original.id });
  intakeTransaction(
    f.db,
    () => {
      for (let n = 0; n < count; n++) {
        const id = 'proposal:fictional-artifact-' + n,
          path = firstPath.slice(0, firstPath.lastIndexOf('/') + 1) + 'artifact-' + n + '.jsonl',
          value = n === count - 1 ? latestRecord : oldRecord,
          bytes = Buffer.from(
            JSON.stringify(value) +
              '\n' +
              (n === 0 ? (' '.repeat(1024 * 1024) + '\n').repeat(8) : ' '.repeat(1024 + n) + '\n'),
          ),
          validation = validationSummary(validateJSONL(bytes));
        assert.equal(validation.valid, true, JSON.stringify(validation.issues));
        writeFileSync(join(proposalDirectory, 'artifact-' + n + '.jsonl'), bytes);
        registerIntakeFile(f.db, {
          id,
          providerId: String(originalFile.provider_id),
          path,
          bytes,
          kind: 'intake_proposal',
          mimeType: 'application/x-ndjson',
          coverage: 'derived_proposal; unreviewed',
          details: { originalSourceFileId: f.original.id, validation },
        });
        // Preserve every required descriptor and its complete real validation;
        // absent optional model/source-pin fields need no copied null entries.
        details.proposals.push({
          id,
          fileId: id,
          summary: 'Fictional retained history',
          createdAt: proposal.createdAt,
          runId: null,
          validation,
          contentUrl: '/api/sources/' + encodeURIComponent(id) + '/content',
        });
        const occurrence = {
          proposalId: id,
          recordId: id + ':line:1',
          batchId: null,
          locator: value.provenance.locator,
        };
        if (n === count - 1) latestOccurrence = occurrence;
        else occurrences.push(occurrence);
        artifacts.push({
          id,
          path: profileOriginal(f.root, path, f.profileId),
          bytes: bytes.length,
        });
      }
    },
    {},
  );
  assert.ok(latestOccurrence);
  for (let n = 0; n < count; n++) occurrences.push({ ...occurrences[0]! });
  const historicalVersion = {
      ...seedVersion,
      id: oldVersionId,
      contentDigest: workflowHash(canonicalLiteral(oldRecord)),
      status: 'superseded' as const,
      occurrences,
    },
    latestVersion = {
      ...seedVersion,
      id: latestVersionId,
      contentDigest: workflowHash(canonicalLiteral(latestRecord)),
      status: 'pending' as const,
      occurrences: [latestOccurrence],
    },
    historyCandidate = {
      id: historyCandidateId,
      envelopeId: oldRecord.id,
      sourceSystem: oldRecord.provenance.sourceSystem,
      sourceRecordId: oldRecord.provenance.sourceRecordId,
      versions: [historicalVersion, latestVersion],
    },
    nextMembers = [
      {
        candidateId: historyCandidateId,
        candidateVersionId: oldVersionId,
        occurrences,
      },
      {
        candidateId: historyCandidateId,
        candidateVersionId: latestVersionId,
        occurrences: [latestOccurrence],
      },
      ...seedGroupVersion.members,
    ],
    contributionId = 'fictional-artifact-history-contribution',
    nextGroupVersion = {
      ...seedGroupVersion,
      contributionId,
      id: 'report-group-version:' + workflowHash([group.id, contributionId, nextMembers]),
      members: nextMembers,
    };
  assert.equal(
    f.db.prepare("SELECT count(*) AS count FROM source_files WHERE kind='intake_proposal'").get()!
      .count,
    count + 1,
  );
  assert.equal(new Set(details.proposals.map((value) => value.id)).size, count + 1);
  const setupDrainBefore = process.resourceUsage().fsWrite;
  const setupDrain = f.db.prepare('PRAGMA main.wal_checkpoint(TRUNCATE)').get();
  assert.equal(setupDrain?.busy, 0, 'fixture setup checkpoint must drain');
  t.diagnostic(
    JSON.stringify({
      setupWalDrain: setupDrain,
      setupDrainProcessFsWrite: process.resourceUsage().fsWrite - setupDrainBefore,
      setupWalBytesAfterDrain: fileBytes(profilePaths(f.root, f.profileId).database + '-wal'),
    }),
  );
  const probe = observePublication(
    t,
    f.db,
    f.original.id,
    profilePaths(f.root, f.profileId).records,
    profilePaths(f.root, f.profileId).database,
    pageSize,
    selectedWalCheckpoint,
  );
  const prepared = await withRecordVersionWork(probe.record, () =>
    prepareIntakeWorkflowCommand(
      f.db,
      { id: f.original.id },
      {
        version: intakeSourceVersion(f.db, f.original.id).version,
        operationId: 'fictional-artifact-history',
        request: {
          proposalIds: details.proposals.slice(1).map((value) => value.id),
          groupVersionId: nextGroupVersion.id,
        },
        createdAt: '2026-01-01T00:00:00Z',
        changes: function* ({ reader, intake, workflow }) {
          const groupRecord = reader.find('reportGroup', workflow, group.id);
          assert.ok(groupRecord);
          for (const descriptor of details.proposals.slice(1))
            yield {
              op: 'append' as const,
              record: intake,
              field: 'proposals',
              jsonText: JSON.stringify(descriptor),
            };
          yield {
            op: 'append' as const,
            record: workflow,
            field: 'candidates',
            jsonText: JSON.stringify(historyCandidate),
          };
          yield {
            op: 'append' as const,
            record: groupRecord,
            field: 'versions',
            jsonText: JSON.stringify(nextGroupVersion),
          };
        },
      },
    ),
  );
  if (prepared.replayed) throw Error('Unexpected artifact fixture replay');
  intakeTransaction(
    f.db,
    () => {
      prepared.assertCurrent();
      return selectedEnvelopeStore(f.db, {
        id: f.original.id,
      }).collections.stage(prepared.prepared);
    },
    { operationId: prepared.publicationId, fingerprint: prepared.fingerprint },
  );
  probe.finish();
  assert.equal(intakeSourceVersion(f.db, f.original.id).version, details.version + 1);
  return f;
}

for (const count of [4, 8])
  test(
    `retained artifact publication phase counts: ${count} new artifacts`,
    { timeout: 120_000 },
    async (t) => {
      await publicationFixture(t, count);
    },
  );

if (process.env.CRS_IDENTITY_GROUNDING_DIAGNOSTIC === '1')
  for (const count of process.env.CRS_IDENTITY_GROUNDING_DIAGNOSTIC_EXTENDED === '1'
    ? [4, 8, 16, 32]
    : [4, 8])
    test(`native identity grounding phase counts: ${count} new artifacts`, async (t) => {
      const f = await publicationFixture(t, count);
      const start = { ...intakeWorkCounters(f.db).warm };
      const record = createRecordVersionWorkCounters();
      const counters = {
        proofSweeps: 0,
        proofRows: 0,
        proofSweepMs: 0,
        statCalls: 0,
        statMs: 0,
        fsyncCalls: 0,
        fsyncMs: 0,
        hmacCalls: 0,
        sourceVersionReads: 0,
        sourceVersionGetMs: 0,
        readStampReads: 0,
        readStampGetMs: 0,
        tempSchemaReads: 0,
        tempSchemaGetMs: 0,
        immediateCalls: 0,
        commitExecs: 0,
        commitExecMs: 0,
      };
      const restores: Array<() => void> = [];
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const restore of restores.reverse()) restore();
        syncBuiltinESMExports();
      };
      t.after(dispose);
      const install = (target: object, key: string, replacement: unknown) => {
        restores.push(replaceMethod(target, key, replacement));
      };
      try {
        const originalStat = fs.statSync;
        install(fs, 'statSync', (...args: Parameters<typeof originalStat>) => {
          const before = performance.now();
          try {
            return Reflect.apply(originalStat, fs, args);
          } finally {
            counters.statCalls++;
            counters.statMs += performance.now() - before;
          }
        });
        const originalFsync = fs.fsyncSync;
        install(fs, 'fsyncSync', (...args: Parameters<typeof originalFsync>) => {
          const before = performance.now();
          try {
            return Reflect.apply(originalFsync, fs, args);
          } finally {
            counters.fsyncCalls++;
            counters.fsyncMs += performance.now() - before;
          }
        });
        const originalHmac = crypto.createHmac;
        install(crypto, 'createHmac', (...args: Parameters<typeof originalHmac>) => {
          counters.hmacCalls++;
          return Reflect.apply(originalHmac, crypto, args);
        });
        const originalImmediate = timers.setImmediate;
        install(timers, 'setImmediate', (...args: Parameters<typeof originalImmediate>) => {
          counters.immediateCalls++;
          return Reflect.apply(originalImmediate, timers, args);
        });
        syncBuiltinESMExports();
        const statementPrototype = Object.getPrototypeOf(f.db.prepare('SELECT 1'));
        const originalExec = DatabaseSync.prototype.exec;
        install(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, query: string) {
          const commit = /^COMMIT\s*;?\s*$/i.test(query);
          const before = performance.now();
          try {
            return originalExec.call(this, query);
          } finally {
            if (commit) {
              counters.commitExecs++;
              counters.commitExecMs += performance.now() - before;
            }
          }
        });
        const originalGet = statementPrototype.get;
        install(
          statementPrototype,
          'get',
          function (this: { sourceSQL: string }, ...args: unknown[]) {
            const sourceVersion = this.sourceSQL.startsWith(
                'SELECT id,kind,sha256,details_json FROM source_files',
              ),
              readStamp = this.sourceSQL.startsWith('SELECT total_changes() AS changes'),
              tempSchema = this.sourceSQL === 'PRAGMA temp.schema_version',
              before = performance.now();
            if (sourceVersion) counters.sourceVersionReads++;
            if (readStamp) counters.readStampReads++;
            if (tempSchema) counters.tempSchemaReads++;
            try {
              return Reflect.apply(originalGet, this, args);
            } finally {
              const elapsed = performance.now() - before;
              if (sourceVersion) counters.sourceVersionGetMs += elapsed;
              if (readStamp) counters.readStampGetMs += elapsed;
              if (tempSchema) counters.tempSchemaGetMs += elapsed;
            }
          },
        );
        const originalIterate = statementPrototype.iterate;
        install(
          statementPrototype,
          'iterate',
          function (this: { sourceSQL: string }, ...args: unknown[]) {
            const rows = Reflect.apply(originalIterate, this, args) as Iterable<unknown>;
            if (
              this.sourceSQL !==
              'SELECT id,path,identity,signature FROM identity_artifact_proof ORDER BY id'
            )
              return rows;
            counters.proofSweeps++;
            return (function* () {
              const before = performance.now();
              try {
                for (const row of rows) {
                  counters.proofRows++;
                  yield row;
                }
              } finally {
                counters.proofSweepMs += performance.now() - before;
              }
            })();
          },
        );
      } catch (error) {
        dispose();
        throw error;
      }
      const profileDirectory = process.env.CRS_IDENTITY_CPU_PROFILE_DIR;
      const profileSelection = process.env.CRS_IDENTITY_CPU_PROFILE_PHASE || 'all';
      if (!['all', 'coldHttp', 'stableHttp', 'directWarm'].includes(profileSelection))
        throw Error('Unsupported native grounding profile phase');
      let cpuProfileBytes = 0;
      const phases: Array<Record<string, unknown>> = [];
      const point = () => ({
        time: performance.now(),
        cpu: process.cpuUsage(),
        fsWrite: process.resourceUsage().fsWrite,
        counters: { ...counters },
        work: { ...intakeWorkCounters(f.db).warm },
        record: { ...record.operation },
      });
      const delta = (before: Record<string, number>, after: Record<string, number>) =>
        Object.fromEntries(
          Object.entries(after)
            .filter(
              ([key, value]) =>
                !key.includes('Peak') && !key.startsWith('max') && value !== (before[key] ?? 0),
            )
            .map(([key, value]) => [key, value - (before[key] ?? 0)]),
        );
      const measure = async (name: string, run: () => Promise<unknown>) => {
        const before = point();
        const shouldProfile =
          !!profileDirectory && (profileSelection === 'all' || profileSelection === name);
        const profiler = shouldProfile ? new Session() : undefined;
        let profilerConnected = false;
        let profilerStarted = false;
        let outcome = 'failed';
        try {
          if (profiler) {
            profiler.connect();
            profilerConnected = true;
            await new Promise<void>((resolve, reject) =>
              profiler.post('Profiler.enable', (error) => (error ? reject(error) : resolve())),
            );
            await new Promise<void>((resolve, reject) =>
              profiler.post('Profiler.start', (error) => (error ? reject(error) : resolve())),
            );
            profilerStarted = true;
          }
          const review = await run();
          assert.ok(review);
          outcome = 'completed';
          return review;
        } finally {
          const after = point();
          const phase: Record<string, unknown> = {
            name,
            outcome,
            elapsedMs: after.time - before.time,
            cpuMicros: after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system,
            processFsWrite: after.fsWrite - before.fsWrite,
            ...delta(before.counters, after.counters),
            intakeWork: delta(before.work, after.work),
            recordWork: name === 'directWarm' ? delta(before.record, after.record) : null,
          };
          phases.push(phase);
          if (profiler) {
            try {
              if (profilerStarted) {
                const profile = await new Promise<unknown>((resolve, reject) =>
                  profiler.post('Profiler.stop', (error, result) =>
                    error ? reject(error) : resolve(result.profile),
                  ),
                );
                const encoded = JSON.stringify(profile);
                writeFileSync(
                  join(profileDirectory!, `native-${name}-${count}.cpuprofile`),
                  encoded,
                );
                const profileBytes = Buffer.byteLength(encoded);
                phase.cpuProfileBytes = profileBytes;
                cpuProfileBytes += profileBytes;
              }
            } finally {
              if (profilerConnected) profiler.disconnect();
            }
          }
        }
      };
      const before = point();
      try {
        await measure('coldHttp', () => f.review());
        await measure('stableHttp', () => f.review());
        await measure('directWarm', () =>
          withRecordVersionWork(record, () =>
            getNativeIntakeIdentityReview(f.db, f.root, f.profileId, f.original.id, f.groupId),
          ),
        );
      } finally {
        const afterPoint = point(),
          after = intakeWorkCounters(f.db).warm;
        dispose();
        t.diagnostic(
          JSON.stringify({
            nativeGroundingDiagnostic: {
              newArtifacts: count,
              retainedProposals: count + 1,
              ...counters,
              phases,
              elapsedMs: afterPoint.time - before.time,
              cpuMicros:
                afterPoint.cpu.user + afterPoint.cpu.system - before.cpu.user - before.cpu.system,
              cpuProfileBytes,
              fullPreparations:
                after.identityPreviewFullPreparations - start.identityPreviewFullPreparations,
              collectionNodesWritten: after.collectionNodesWritten - start.collectionNodesWritten,
              collectionWrittenBytes: after.collectionWrittenBytes - start.collectionWrittenBytes,
              recordWorkDirectWarm: record.operation,
              artifactChecks:
                after.identityPreviewArtifactChecks - start.identityPreviewArtifactChecks,
              artifactOccurrences:
                after.identityPreviewArtifactOccurrences - start.identityPreviewArtifactOccurrences,
              note: "Aggregate fixture-only observation. Cold and stable phases use the same HTTP route as the original 257-artifact fixture; directWarm matches its guarded native call. Record-version work is unavailable for HTTP phases because their request context does not inherit this test call's work scope; recordWorkDirectWarm covers only the direct call. Counter deltas exclude peak gauges. Failed phases retain partial counts. All diagnostic sizes remain below the 256-file verification cache boundary and do not prove the full-run outcome. Proof sweep elapsed includes caller HMAC/stat work between iterator rows, not isolated SQLite scan time. Stat/HMAC and immediate counts include other native work. Timing includes probe overhead and is not a gate.",
            },
          }),
        );
      }
      assert.ok(counters.proofSweeps > 0);
      assert.ok(counters.proofRows >= count + 2);
    });
