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
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
import { intakeFileIdentity } from '../intake-files.ts';
import { observeTransactionBeforePublication, type Database } from '../database.ts';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { getNativeIntakeIdentityReview } from '../intake-identity-native.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync, lstatSync, renameSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { profileOriginal } from '../profile-storage.ts';
import { intakeTransaction } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { prepareIntakeWorkflowCommand } from '../intake-workflow-command.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { nativeIdentityPreviewCounts } from '../intake-identity-preview-cache.ts';
import type { IntakeIdentityScope } from '../../shared/intake-identity.ts';
import { fixture, envelope } from './intake-identity-native-fixture.ts';

// Opt-in, aggregate-only observation of the actual 257-artifact preparation.
// Inclusive method totals overlap; maintenance segments partition that call.
function observeArtifactHistoryPreparation(t: test.TestContext, db: Database, id: string) {
  const collections = selectedEnvelopeStore(db, { id }).collections;
  const workKeys = [
    'collectionNodeReads',
    'collectionReadWitnessQueries',
    'collectionNodeCacheHits',
    'collectionPreparedBytes',
    'collectionNodesWritten',
    'collectionWrittenBytes',
    'candidatePathCopies',
    'candidateCopiedMembers',
    'candidateVerificationCalls',
    'candidateVerificationBytes',
    'hashCalls',
    'hashedBytes',
  ] as const;
  const work = () => {
    const counters = intakeWorkCounters(db).warm;
    return Object.fromEntries(workKeys.map((key) => [key, counters[key]])) as Record<
      string,
      number
    >;
  };
  const point = () => ({
    ms: performance.now(),
    cpu: process.cpuUsage(),
    fsWrite: process.resourceUsage().fsWrite,
    work: work(),
  });
  type Point = ReturnType<typeof point>;
  type Totals = {
    calls: number;
    ms: number;
    cpuMicros: number;
    fsWrite: number;
    work: Record<string, number>;
  };
  const totals = new Map<string, Totals>();
  const add = (name: string, before: Point, after: Point) => {
    const value = totals.get(name) ?? { calls: 0, ms: 0, cpuMicros: 0, fsWrite: 0, work: {} };
    value.calls++;
    value.ms += after.ms - before.ms;
    value.cpuMicros += after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system;
    value.fsWrite += after.fsWrite - before.fsWrite;
    for (const key of workKeys) {
      const delta = after.work[key]! - before.work[key]!;
      if (delta) value.work[key] = (value.work[key] ?? 0) + delta;
    }
    totals.set(name, value);
  };
  const start = point();
  const stack: Array<{ name: string; started: number }> = [];
  const occupancy = {
    prepared: 0,
    committed: 0,
    changes: 0,
    full: 0,
    partial: 0,
    histogram: Array<number>(65).fill(0),
  };
  const commitExecAttempts = { calls: 0, ms: 0, fsWrite: 0 };
  const methodCalls = { prepare: 0, stage: 0, commitMaintenance: 0 };
  const maxCompletedMethodMs = { prepare: 0, stage: 0, commitMaintenance: 0 };
  let lastEnteredMethod: { name: string; ordinal: number; elapsedMs: number } | null = null;
  let lastCompletedMethod: {
    name: string;
    ordinal: number;
    elapsedMs: number;
    durationMs: number;
  } | null = null;
  const preparedKinds = new WeakMap<object, 'build' | 'adoption' | 'other'>();
  const byKind = {
    build: { prepared: 0, committed: 0, changes: 0 },
    adoption: { prepared: 0, committed: 0, changes: 0 },
    other: { prepared: 0, committed: 0, changes: 0 },
  };
  const restores: Array<() => void> = [];
  let active: { entry: Point; stageEntry?: Point; stageExit?: Point; verified?: Point } | undefined;
  let closed = false;
  const snapshot = () => {
    const now = point();
    const changedWork = Object.fromEntries(
      workKeys.map((key) => [key, now.work[key]! - start.work[key]!]),
    );
    return {
      elapsedMs: now.ms - start.ms,
      activeCall: stack.at(-1)?.name ?? null,
      activeCallMs: stack.length ? now.ms - stack.at(-1)!.started : null,
      lastEnteredMethod,
      lastCompletedMethod,
      maxCompletedMethodMs: { ...maxCompletedMethodMs },
      selectedHandleStable: selectedEnvelopeStore(db, { id }).collections === collections,
      processCpuMicros: now.cpu.user + now.cpu.system - start.cpu.user - start.cpu.system,
      processFsWriteUnits: now.fsWrite - start.fsWrite,
      work: changedWork,
      preparedBatches: { ...occupancy, histogram: [...occupancy.histogram] },
      preparedBatchKinds: Object.fromEntries(
        Object.entries(byKind).map(([kind, counts]) => [kind, { ...counts }]),
      ),
      commitExecAttempts: { ...commitExecAttempts },
      inclusiveMethodAndExclusiveMaintenanceSegments: Object.fromEntries(
        [...totals].map(([key, value]) => [key, { ...value, work: { ...value.work } }]),
      ),
      note: 'Process CPU/fsWrite include other work; fsWrite units are OS-specific. Method totals count completed attempts and overlap nested calls; prepared/committed batch counts require successful calls. Prepared bytes are cumulative, not resident memory. Unlisted SQL/filesystem work is unmeasured. Timer/abort callbacks cannot run inside a synchronous blocked call; last-entry/completion markers expose that limit after it returns.',
    };
  };
  let lastSnapshot: ReturnType<typeof snapshot> | undefined;
  const fallbackSnapshot = () => ({
    elapsedMs: performance.now() - start.ms,
    activeCall: stack.at(-1)?.name ?? null,
    activeCallMs: stack.length ? performance.now() - stack.at(-1)!.started : null,
    lastEnteredMethod,
    lastCompletedMethod,
    maxCompletedMethodMs: { ...maxCompletedMethodMs },
    preparedBatches: { ...occupancy, histogram: [...occupancy.histogram] },
    preparedBatchKinds: Object.fromEntries(
      Object.entries(byKind).map(([kind, counts]) => [kind, { ...counts }]),
    ),
    commitExecAttempts: { ...commitExecAttempts },
    inclusiveMethodAndExclusiveMaintenanceSegments: Object.fromEntries(
      [...totals].map(([key, value]) => [key, { ...value, work: { ...value.work } }]),
    ),
    lastCompleteSnapshot: lastSnapshot ?? null,
    note: 'Fallback does not read the possibly closed database; cumulative work may lag the last method.',
  });
  const emit = (reason: string) => {
    if (closed) return;
    try {
      lastSnapshot = snapshot();
      process.stderr.write(
        JSON.stringify({ probe: 'artifact-history-preparation', reason, ...lastSnapshot }) + '\n',
      );
    } catch {
      try {
        process.stderr.write(
          JSON.stringify({
            probe: 'artifact-history-preparation',
            reason: reason + '-snapshot-unavailable',
            ...fallbackSnapshot(),
          }) + '\n',
        );
      } catch {
        // Diagnostics must not alter the guarded publication result.
      }
    }
  };
  const onAbort = () => emit('abort');
  let intervals = 0;
  const timer = setInterval(() => {
    if (intervals++ < 20) emit('interval');
  }, 30000);
  timer.unref();
  t.signal.addEventListener('abort', onAbort, { once: true });
  const dispose = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    t.signal.removeEventListener('abort', onAbort);
    for (const restore of restores.reverse()) restore();
  };
  t.after(() => {
    if (!closed) emit('teardown');
    dispose();
  });
  const install = (target: object, key: string, replacement: unknown) => {
    const original = Reflect.get(target, key);
    if (!Reflect.set(target, key, replacement) || Reflect.get(target, key) !== replacement)
      throw Error('Artifact history diagnostic method is not replaceable');
    restores.push(() => Reflect.set(target, key, original));
  };
  try {
    const originalExec = DatabaseSync.prototype.exec;
    install(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, query: string) {
      const isCommit = this === db && /^COMMIT\s*;?\s*$/i.test(query.trim());
      const before = isCommit ? point() : undefined;
      try {
        return originalExec.call(this, query);
      } finally {
        if (before) {
          const after = point();
          commitExecAttempts.calls++;
          commitExecAttempts.ms += after.ms - before.ms;
          commitExecAttempts.fsWrite += after.fsWrite - before.fsWrite;
        }
      }
    });
    const removeObserver = observeTransactionBeforePublication(db, () => {
      if (active) active.verified = point();
    });
    restores.push(removeObserver);
    for (const method of ['prepare', 'stage', 'commitMaintenance'] as const) {
      const original = collections[method];
      install(collections, method, (...args: unknown[]) => {
        const before = point();
        const ordinal = ++methodCalls[method];
        lastEnteredMethod = { name: method, ordinal, elapsedMs: before.ms - start.ms };
        stack.push({ name: method, started: before.ms });
        if (method === 'commitMaintenance') active = { entry: before };
        if (method === 'stage' && active) active.stageEntry = before;
        let succeeded = false;
        let result: unknown;
        try {
          result = Reflect.apply(original, collections, args);
          succeeded = true;
          return result;
        } finally {
          const after = point();
          add(method, before, after);
          const durationMs = after.ms - before.ms;
          maxCompletedMethodMs[method] = Math.max(maxCompletedMethodMs[method], durationMs);
          lastCompletedMethod = {
            name: method,
            ordinal,
            elapsedMs: after.ms - start.ms,
            durationMs,
          };
          if (method === 'prepare' && succeeded) {
            const changes = (args[1] as { changes?: unknown } | undefined)?.changes;
            if (Array.isArray(changes) && changes.length <= 64) {
              const kind =
                changes.length === 1 && changes[0]?.op === 'adoptCollection'
                  ? 'adoption'
                  : changes.every((change) => change?.area === 'builds')
                    ? 'build'
                    : 'other';
              occupancy.prepared++;
              occupancy.changes += changes.length;
              occupancy.histogram[changes.length]!++;
              if (changes.length === 64) occupancy.full++;
              else occupancy.partial++;
              byKind[kind].prepared++;
              byKind[kind].changes += changes.length;
              if (result && typeof result === 'object') preparedKinds.set(result, kind);
            }
          }
          if (method === 'stage' && active) active.stageExit = after;
          let milestone = false;
          if (method === 'commitMaintenance' && active) {
            const { entry, stageEntry, stageExit, verified } = active;
            if (stageEntry) add('maintenancePreStage', entry, stageEntry);
            if (stageEntry && stageExit) add('maintenanceStage', stageEntry, stageExit);
            if (stageExit && verified) add('maintenancePostStageVerify', stageExit, verified);
            if (verified) add('maintenancePostVerifyPublication', verified, after);
            active = undefined;
            if (succeeded) {
              occupancy.committed++;
              const prepared = args[0];
              if (prepared && typeof prepared === 'object') {
                const kind = preparedKinds.get(prepared);
                if (kind) byKind[kind].committed++;
              }
              milestone =
                occupancy.committed <= 16384 &&
                (occupancy.committed & (occupancy.committed - 1)) === 0;
            }
          }
          stack.pop();
          if (milestone) emit('commit-power-of-two');
        }
      });
    }
  } catch (error) {
    dispose();
    throw error;
  }
  emit('start');
  return {
    snapshot,
    finish() {
      emit('publication-complete');
      dispose();
    },
  };
}

if (process.env.CRS_ARTIFACT_HISTORY_DIAGNOSTICS === 'smoke')
  test('artifact history preparation probe plumbing', async (t) => {
    const f = await fixture(t, false, 1);
    await buildIntakeCollectionEnvelope(f.db, { id: f.original.id });
    const probe = observeArtifactHistoryPreparation(t, f.db, f.original.id);
    const collections = selectedEnvelopeStore(f.db, { id: f.original.id }).collections;
    const id = randomUUID();
    const prepared = collections.prepare(collections.openView(), {
      operationId: id,
      requestDigest: workflowHash(id),
      domainVersion: intakeSourceVersion(f.db, f.original.id).version,
      changes: [{ area: 'builds', collection: id, op: 'put', key: 'marker', value: 'fictional' }],
    });
    collections.commitMaintenance(prepared);
    const result = probe.snapshot();
    assert.equal(result.selectedHandleStable, true);
    assert.equal(result.preparedBatches.prepared, 1);
    assert.equal(result.preparedBatches.committed, 1);
    assert.equal(result.commitExecAttempts.calls, 1);
    assert.equal(result.inclusiveMethodAndExclusiveMaintenanceSegments.prepare?.calls, 1);
    assert.equal(result.inclusiveMethodAndExclusiveMaintenanceSegments.maintenanceStage?.calls, 1);
    probe.finish();
  });

// This fixture converts its small seed, then publishes genuine retained JSONL
// history through one supported native workflow command.
// Its historical member is intentionally not the candidate's latest version:
// identity clinical preparation may skip it, but artifact verification may not.
async function artifactHistoryFixture(t: test.TestContext, phase: (name: string) => void) {
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
      for (let n = 0; n < 256; n++) {
        const id = 'proposal:fictional-artifact-' + n,
          path = firstPath.slice(0, firstPath.lastIndexOf('/') + 1) + 'artifact-' + n + '.jsonl',
          value = n === 255 ? latestRecord : oldRecord,
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
        if (n === 255) latestOccurrence = occurrence;
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
  for (let n = 0; n < 192; n++) occurrences.push({ ...occurrences[0]! });
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
    257,
  );
  assert.equal(new Set(details.proposals.map((value) => value.id)).size, 257);
  const finishProbe =
    process.env.CRS_ARTIFACT_HISTORY_DIAGNOSTICS === '1'
      ? observeArtifactHistoryPreparation(t, f.db, f.original.id)
      : undefined;
  phase('publication-prepare-start');
  const prepared = await prepareIntakeWorkflowCommand(
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
  );
  phase('publication-prepare-complete');
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
  phase('publication-stage-complete');
  finishProbe?.finish();
  phase('cold-http-start');
  const cold = await f.review();
  assert.ok(cold.scopeReference);
  phase('cold-http-complete');
  phase('stable-http-start');
  const stable = await f.review();
  assert.ok(stable.scopeReference);
  assert.equal(nativeIdentityPreviewCounts(f.db).entries, 1);
  assert.equal(stable.scopeReference.collection.membership, 3);
  phase('stable-http-complete');
  phase('membership-pages-start');
  const membership = await f.request(
    `identity-scope-page?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${stable.scopeReference.scopeToken}&section=membership&limit=3`,
  );
  assert.equal(membership.total, 3);
  const members: IntakeIdentityScope['membership'] = [];
  for (const [ordinal, item] of membership.items.entries()) {
    if (item.kind === 'value') members.push(item.value);
    else {
      const chunks: Buffer[] = [];
      let offset = 0,
        fragmentCursor = 'start';
      for (;;) {
        const fragment = await f.request(
          `identity-scope-fragment?groupId=${encodeURIComponent(f.groupId)}&scopeToken=${stable.scopeReference.scopeToken}&section=membership&ordinal=${ordinal}&offset=${offset}&cursor=${encodeURIComponent(fragmentCursor)}`,
        );
        chunks.push(Buffer.from(fragment.data, 'base64'));
        if (fragment.complete) {
          assert.equal(fragment.nextCursor, null);
          break;
        }
        assert.ok(fragment.nextOffset > offset);
        assert.ok(typeof fragment.nextCursor === 'string' && fragment.nextCursor.length > 0);
        fragmentCursor = fragment.nextCursor;
        offset = fragment.nextOffset;
      }
      members.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }
  }
  assert.equal(members.length, 3);
  assert.equal(members[0]!.candidateVersionId, oldVersionId);
  // Count complete native membership by its public retained occurrence pages;
  // do not infer reachability from the setup's in-memory envelope alone.
  assert.equal(members[0]!.occurrences.length, occurrences.length);
  assert.equal(
    members.reduce((total, member) => total + member.occurrences.length, 0),
    449,
  );
  assert.equal(members[1]!.candidateVersionId, latestVersionId);
  assert.equal(members[2]!.candidateVersionId, seedVersion.id);
  assert.deepEqual(
    new Set(members.flatMap((member) => member.occurrences.map((value) => value.proposalId))),
    new Set(details.proposals.map((value) => value.id)),
  );
  phase('membership-pages-complete');
  const totalBytes = Number(
    f.db
      .prepare(
        "SELECT sum(bytes) AS bytes FROM source_files WHERE kind IN ('intake_original','intake_proposal')",
      )
      .get()!.bytes,
  );
  return {
    ...f,
    artifacts,
    stable,
    totalBytes,
    duplicateEnd: occurrences.length,
    occurrences: occurrences.length + 2,
  };
}

// Genuine 257-file native publication, public warming, cancellation and replacement phases.
// This is a host hang guard, not an interactive latency or model-time target.
test(
  'native warm identity cooperates across 257 retained proposal artifacts and duplicate occurrences',
  { timeout: 450000 },
  async (t) => {
    const started = performance.now();
    const phase = (name: string) => {
      if (process.env.CRS_ARTIFACT_HISTORY_PHASES === '1')
        process.stderr.write(
          JSON.stringify({
            fixture: 'fictional retained artifact history',
            phase: name,
            elapsedMs: performance.now() - started,
          }) + '\n',
        );
    };
    phase('fixture-start');
    t.after(() => phase('test-teardown'));
    const f = await artifactHistoryFixture(t, phase);
    phase('fixture-complete');
    // Node's test runner isolates files in child processes. Observe actual allocations
    // in this fixture's process; sibling files' temporary scopes are not ours.
    const allocatedScopes = new Set<string>(),
      scopePrefixes = [
        'fictional-identity-scope-',
        'fictional-identity-delta-',
        'fictional-identity-original-proof-',
        'fictional-identity-prerequisites-',
      ].map((prefix) => join(tmpdir(), prefix)),
      originalMkdtemp = fs.mkdtempSync;
    const allocationObserver = t.mock.method(fs, 'mkdtempSync', ((
      ...args: Parameters<typeof originalMkdtemp>
    ) => {
      const directory = Reflect.apply(originalMkdtemp, fs, args);
      if (scopePrefixes.some((prefix) => String(args[0]).startsWith(prefix)))
        allocatedScopes.add(String(directory));
      return directory;
    }) as typeof originalMkdtemp);
    syncBuiltinESMExports();
    try {
      const scratch = () =>
          [...allocatedScopes]
            .filter((directory) => {
              try {
                lstatSync(directory);
                return true;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
                throw error;
              }
            })
            .sort(),
        baselineScratch = scratch(),
        before = { ...intakeWorkCounters(f.db).warm },
        fileWork = createIntakeFileWorkCounters();
      let complete = false;
      phase('direct-warm-start');
      const warm = withIntakeFileWork(fileWork, () =>
        getNativeIntakeIdentityReview(f.db, f.root, f.profileId, f.original.id, f.groupId),
      );
      void warm.then(
        () => {
          complete = true;
        },
        () => {
          complete = true;
        },
      );
      const waitFor = async (
        ready: () => boolean,
        pending: Promise<unknown>,
        finished: () => boolean,
      ) => {
        while (!ready()) {
          t.signal.throwIfAborted();
          if (finished()) {
            await pending;
            assert.fail('verification completed before the required nested checkpoint');
          }
          await setImmediate();
        }
      };
      try {
        await waitFor(
          () => fileWork.streamHashBytes > 256 * 1024,
          warm,
          () => complete,
        );
        assert.ok(
          fileWork.streamHashBytes < f.artifacts[0]!.bytes,
          'a host turn occurs inside the first retained artifact hash, before its payload completes',
        );
        await waitFor(
          () =>
            intakeWorkCounters(f.db).warm.identityPreviewArtifactOccurrences -
              before.identityPreviewArtifactOccurrences >
            256,
          warm,
          () => complete,
        );
        const notes = await fetch(
          new URL(`/api/profiles/${encodeURIComponent(f.profileId)}/notes`, f.base),
        );
        assert.equal(notes.status, 200);
        assert.ok(Array.isArray((await notes.json()).data));
        assert.equal(
          complete,
          false,
          'same-database HTTP completes during duplicate-skipped verification',
        );
        assert.ok(
          intakeWorkCounters(f.db).warm.identityPreviewArtifactOccurrences -
            before.identityPreviewArtifactOccurrences <
            f.duplicateEnd,
        );
        // HTTP presentation adds the profile prefix; the internal verifier keeps
        // its domain URL. Assert both exact routes and compare every other field.
        const expectedWarm = structuredClone(f.stable);
        assert.ok(expectedWarm.scopeReference);
        assert.equal(
          expectedWarm.scopeReference.original.contentUrl,
          `/api/profiles/${encodeURIComponent(f.profileId)}/sources/${encodeURIComponent(f.original.id)}/content`,
        );
        expectedWarm.scopeReference.original.contentUrl = `/api/sources/${encodeURIComponent(f.original.id)}/content`;
        assert.deepEqual(await warm, expectedWarm);
        phase('direct-warm-complete');
      } finally {
        await warm.catch(() => undefined);
      }
      const after = intakeWorkCounters(f.db).warm;
      assert.equal(after.identityPreviewFullPreparations, before.identityPreviewFullPreparations);
      assert.equal(
        after.identityPreviewArtifactOccurrences - before.identityPreviewArtifactOccurrences,
        f.occurrences,
      );
      assert.equal(after.identityPreviewArtifactChecks - before.identityPreviewArtifactChecks, 258);
      assert.ok(
        fileWork.streamHashBytes > 0,
        '257 distinct proposals exceed the shared 256-file verification cache',
      );
      assert.equal(fileWork.streamReadBytes, fileWork.streamHashBytes);
      assert.ok(
        fileWork.streamHashBytes <= f.totalBytes,
        'final physical proof never rehashes the already verified payloads',
      );
      assert.deepEqual(scratch(), baselineScratch);
      assert.deepEqual(reviewIssueScratchCounts(f.db), {
        databases: 0,
        scopes: 0,
        rows: 0,
      });
      t.diagnostic(JSON.stringify({ artifacts: 257, occurrences: f.occurrences, fileWork }));

      // Abort the sole HTTP subscriber inside actual verification, then wait for
      // the next owner to prove abandoned scratch and work are completely drained.
      const controller = new AbortController(),
        cancelBefore = { ...intakeWorkCounters(f.db).warm };
      let cancelComplete = false;
      const cancelled = fetch(f.base + 'identity-review?groupId=' + encodeURIComponent(f.groupId), {
        signal: controller.signal,
      });
      void cancelled.then(
        () => {
          cancelComplete = true;
        },
        () => {
          cancelComplete = true;
        },
      );
      const refused = assert.rejects(cancelled, { name: 'AbortError' });
      await waitFor(
        () =>
          intakeWorkCounters(f.db).warm.identityPreviewArtifactOccurrences -
            cancelBefore.identityPreviewArtifactOccurrences >=
          32,
        cancelled,
        () => cancelComplete,
      );
      controller.abort();
      await refused;
      await runExclusiveClinicalOperation(f.db, async () => undefined);
      phase('subscriber-cancellation-drained');
      const stopped = { ...intakeWorkCounters(f.db).warm };
      for (let n = 0; n < 4; n++) await setImmediate();
      assert.equal(
        intakeWorkCounters(f.db).warm.identityPreviewArtifactOccurrences,
        stopped.identityPreviewArtifactOccurrences,
      );
      assert.ok(
        stopped.identityPreviewArtifactOccurrences -
          cancelBefore.identityPreviewArtifactOccurrences <
          f.occurrences,
        'last-subscriber cancellation interrupts unfinished verification',
      );
      assert.equal(
        stopped.identityPreviewFullPreparations,
        cancelBefore.identityPreviewFullPreparations,
      );
      assert.equal(
        stopped.reportSnapshotCheckpointChanges,
        cancelBefore.reportSnapshotCheckpointChanges,
      );
      assert.deepEqual(scratch(), baselineScratch);
      assert.deepEqual(reviewIssueScratchCounts(f.db), {
        databases: 0,
        scopes: 0,
        rows: 0,
      });

      // Replace a verified earlier artifact with identical bytes while later
      // artifacts yield. A forbidden rehash/new baseline would accept its digest;
      // only the original physical identity proves this replacement must refuse.
      assert.equal(nativeIdentityPreviewCounts(f.db).entries, 1);
      const physicalBefore = { ...intakeWorkCounters(f.db).warm },
        stamp = reviewReadStamp(f.db),
        originalBytes = readFileSync(f.artifacts[0]!.path),
        originalIdentity = intakeFileIdentity(f.artifacts[0]!.path),
        displacedPath = f.artifacts[0]!.path + '.before-replacement',
        replacementPath = f.artifacts[0]!.path + '.replacement';
      let displaced = false;
      let physicalComplete = false;
      const changed = f.request(
        'identity-review?groupId=' + encodeURIComponent(f.groupId),
        undefined,
        409,
      );
      void changed.then(
        () => {
          physicalComplete = true;
        },
        () => {
          physicalComplete = true;
        },
      );
      try {
        await waitFor(
          () =>
            intakeWorkCounters(f.db).warm.identityPreviewArtifactChecks -
              physicalBefore.identityPreviewArtifactChecks >=
            32,
          changed,
          () => physicalComplete,
        );
        writeFileSync(replacementPath, originalBytes);
        renameSync(f.artifacts[0]!.path, displacedPath);
        displaced = true;
        renameSync(replacementPath, f.artifacts[0]!.path);
        assert.notEqual(intakeFileIdentity(f.artifacts[0]!.path), originalIdentity);
        assert.deepEqual(readFileSync(f.artifacts[0]!.path), originalBytes);
        assert.equal(reviewReadStamp(f.db), stamp);
        assert.equal((await changed).error.code, 'SOURCE_CHANGED');
        assert.equal(nativeIdentityPreviewCounts(f.db).entries, 0);
        assert.deepEqual(scratch(), baselineScratch);
        assert.deepEqual(reviewIssueScratchCounts(f.db), {
          databases: 0,
          scopes: 0,
          rows: 0,
        });
      } finally {
        await changed.catch(() => undefined);
        if (displaced) renameSync(displacedPath, f.artifacts[0]!.path);
      }
    } finally {
      allocationObserver.mock.restore();
      syncBuiltinESMExports();
    }
  },
);
