/** Small publication diagnosis; the original full identity histories remain separate gates. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { writeFileSync, opendirSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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
  const databaseFilesBefore = databaseFiles();
  let maxObservedWalBytes = databaseFilesBefore.walBytes;
  const filesystem = new Map<string, { calls: number; elapsedMs: number; bytes: number }>();
  const dbExec = new Map<string, { calls: number; elapsedMs: number; fsWrite: number }>();
  const sqlTimings = new Map<string, { calls: number; elapsedMs: number }>();
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
      const time = performance.now();
      const fsWrite = process.resourceUsage().fsWrite;
      try {
        return executeSql.call(this, query);
      } finally {
        const value = dbExec.get(shape) ?? { calls: 0, elapsedMs: 0, fsWrite: 0 };
        value.calls++;
        value.elapsedMs += performance.now() - time;
        value.fsWrite += process.resourceUsage().fsWrite - fsWrite;
        dbExec.set(shape, value);
        if (shape === 'COMMIT' && this === db)
          maxObservedWalBytes = Math.max(maxObservedWalBytes, fileBytes(databasePath + '-wal'));
      }
    });
    for (const method of ['prepare', 'stage', 'commitMaintenance'] as const) {
      const original = collections[method];
      install(collections, method, (...args: unknown[]) => {
        const phase = [...stack, method].join('/');
        stack.push(method);
        const before = point();
        if (method === 'commitMaintenance') activeMaintenance = { entry: before };
        if (phase === 'commitMaintenance/stage' && activeMaintenance)
          activeMaintenance.stageEntry = before;
        try {
          return Reflect.apply(original, collections, args);
        } finally {
          const after = point();
          const value = accumulate(phases, phase, before, after);
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
      const end = snapshot();
      const maintenanceNodes = maintenanceSegments.get('stage')?.work.collectionNodesWritten ?? 0;
      const publication = maintenanceSegments.get('postVerifyPublication');
      const retainedJournalGrowthBytes = journalBytes(archive) - retainedBytesBefore;
      t.diagnostic(
        JSON.stringify({
          phases: Object.fromEntries(phases),
          maintenanceSegments: Object.fromEntries(maintenanceSegments),
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
          note: 'Instrumented durations include probe overhead. Nested phases overlap; final checkpoint drain is separate from maintenance. Whole-probe process fsWrite includes preparation, staging, publication and final drain after a setup-only WAL drain. Post-stage verify ends after accepted-row verification; post-verify publication includes revision bookkeeping and journal encode/index/head publication. SQL and db.exec cover all connections; iterate timing excludes iteration. db.exec shapes exclude SQL text/values. Intake work is fixture-connection scoped. Filesystem bytes are API transfers, not physical device I/O. Linux process fsWrite deltas are kernel-reported write units, not attributable to one SQLite connection; normalized values are unavailable on other platforms. WAL size is sampled after fixture-connection COMMIT, not a physical write count or absolute peak; the configured threshold can be overshot by a bounded transaction, so the fixture uses an independent 256 MiB ceiling. maxRSS and prepared-byte peaks cover the process/connection lifetime, not cumulative work.',
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
  assert.equal(baselineWalCheckpoint, 8192, 'comparison requires the attached WAL policy');
  if (candidateWalCheckpoint === '1000') f.db.exec('PRAGMA main.wal_autocheckpoint=1000');
  else if (candidateWalCheckpoint !== undefined && candidateWalCheckpoint !== '8192')
    throw Error('Unsupported history diagnostic WAL threshold');
  const selectedWalCheckpoint = Number(
    f.db.prepare('PRAGMA main.wal_autocheckpoint').get()?.wal_autocheckpoint,
  );
  assert.equal(selectedWalCheckpoint, candidateWalCheckpoint === '1000' ? 1000 : 8192);
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
}

for (const count of [4, 8])
  test(
    `retained artifact publication phase counts: ${count} new artifacts`,
    { timeout: 120_000 },
    async (t) => {
      await publicationFixture(t, count);
    },
  );
