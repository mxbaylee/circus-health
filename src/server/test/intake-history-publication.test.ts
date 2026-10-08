/** Small publication diagnosis; the original full identity histories remain separate gates. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { writeFileSync, opendirSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from '../database.ts';
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

function observePublication(t: test.TestContext, db: Database, id: string, archive: string) {
  const collections = selectedEnvelopeStore(db, { id }).collections;
  const record = createRecordVersionWorkCounters();
  const phases = new Map<
    string,
    {
      calls: number;
      elapsedMs: number;
      cpuMicros: number;
      sqlPrepared: number;
      sqlExecuted: number;
      work: Record<string, number>;
    }
  >();
  const stack: string[] = [];
  const snapshot = () => intakeWorkCounters(db).warm;
  const start = snapshot();
  const sql = { prepared: 0, executed: 0 };
  const retainedBytesBefore = journalBytes(archive);
  const filesystem = new Map<string, { calls: number; elapsedMs: number; bytes: number }>();
  const fsProbes = (['readFileSync', 'writeFileSync', 'fsyncSync', 'lstatSync'] as const).map(
    (method) => {
      const original = fs[method];
      return t.mock.method(fs, method, (...args: unknown[]) => {
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
    },
  );
  syncBuiltinESMExports();
  const sqlTimings = new Map<string, { calls: number; elapsedMs: number }>();
  const statementPrototype = Object.getPrototypeOf(db.prepare('SELECT 1'));
  const statementProbes = (['run', 'get', 'all', 'iterate'] as const).map((method) => {
    const original = statementPrototype[method];
    return t.mock.method(
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
  });
  const prepareSql = DatabaseSync.prototype.prepare;
  const sqlProbe = t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, query: string) {
      sql.prepared++;
      return prepareSql.call(this, query);
    },
  );
  const probes = (['prepare', 'stage', 'commitMaintenance'] as const).map((method) => {
    const original = collections[method];
    return t.mock.method(collections, method, (...args: unknown[]) => {
      const phase = [...stack, method].join('/');
      stack.push(method);
      const before = snapshot(),
        beforeSql = { ...sql },
        cpu = process.cpuUsage(),
        time = performance.now();
      try {
        return Reflect.apply(original, collections, args);
      } finally {
        const after = snapshot(),
          used = process.cpuUsage(cpu);
        const delta = Object.fromEntries(
          Object.entries(after)
            .filter(
              ([key, value]) =>
                !key.includes('Peak') && value !== before[key as keyof typeof before],
            )
            .map(([key, value]) => [key, value - before[key as keyof typeof before]]),
        );
        const value = phases.get(phase) ?? {
          calls: 0,
          elapsedMs: 0,
          cpuMicros: 0,
          sqlPrepared: 0,
          sqlExecuted: 0,
          work: {},
        };
        value.calls++;
        value.elapsedMs += performance.now() - time;
        value.cpuMicros += used.user + used.system;
        value.sqlPrepared += sql.prepared - beforeSql.prepared;
        value.sqlExecuted += sql.executed - beforeSql.executed;
        for (const [key, count] of Object.entries(delta))
          value.work[key] = (value.work[key] ?? 0) + count;
        phases.set(phase, value);
        if (process.env.CRS_HISTORY_CHECKPOINTS === '1')
          t.diagnostic(
            JSON.stringify({
              phase,
              checkpoint: value.calls,
              work: delta,
              sqlPrepared: sql.prepared - beforeSql.prepared,
              sqlExecuted: sql.executed - beforeSql.executed,
            }),
          );
        stack.pop();
      }
    });
  });
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      for (const probe of probes) probe.mock.restore();
      sqlProbe.mock.restore();
      for (const probe of statementProbes) probe.mock.restore();
      for (const probe of fsProbes) probe.mock.restore();
      syncBuiltinESMExports();
      disposed = true;
    }
  };
  t.after(dispose);
  return {
    record,
    finish() {
      dispose();
      const end = snapshot();
      t.diagnostic(
        JSON.stringify({
          phases: Object.fromEntries(phases),
          record,
          totalSql: sql,
          filesystem: Object.fromEntries(filesystem),
          retainedJournalGrowthBytes: journalBytes(archive) - retainedBytesBefore,
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
          note: 'Instrumented durations include probe overhead. Nested phases overlap. SQL covers all connections; iterate timing excludes iteration. Intake work is fixture-connection scoped. Filesystem bytes are API transfers, not physical device I/O. fsRead/fsWrite are OS counters; maxRSS and prepared-byte peaks cover the process/connection lifetime, not cumulative work.',
        }),
      );
      assert.ok((phases.get('prepare')?.calls ?? 0) > 0);
      assert.ok((phases.get('commitMaintenance/stage')?.calls ?? 0) > 0);
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
  const probe = observePublication(
    t,
    f.db,
    f.original.id,
    profilePaths(f.root, f.profileId).records,
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
