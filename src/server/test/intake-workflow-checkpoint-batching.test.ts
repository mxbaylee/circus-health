import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase, transaction } from '../database.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import {
  buildVerifiedWorkflowSummary,
  readVerifiedWorkflowSummary,
} from '../intake-workflow-state.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

async function fixture(t: test.TestContext, separateCandidates = false) {
  const db = openDatabase(':memory:', 'fictional-workflow-checkpoints');
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
  });
  const source = {
    id: 'fictional-workflow-checkpoints',
    kind: 'intake_original' as const,
    sha256: 'e'.repeat(64),
  };
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 1,
      originalName: 'fictional.zip',
      workflow: {
        format: 'health-intake-workflow-v1',
        candidates: Array.from({ length: separateCandidates ? 65 : 1 }, (_, candidate) => ({
          id: 'fictional-candidate-' + candidate,
          envelopeId: 'fictional-candidate-' + candidate,
          sourceSystem: null,
          sourceRecordId: null,
          versions: Array.from({ length: separateCandidates ? 1 : 65 }, (_, ordinal) => ({
            id: `fictional-version-${candidate}-${ordinal}`,
            status: 'pending',
            createdAt: '2026-01-01',
            occurrences: [],
          })),
        })),
        reviewDrafts: [],
        questions: [],
        decisions: [],
        plans: [],
      },
    },
  });
  const storage = createIntakeStateStorage(db, {
    profileId: 'fictional-workflow-checkpoints',
    intakeId: source.id,
    sourceHash: source.sha256,
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(source.id, 'fictional.zip', source.sha256, 0, source.kind, initial.detailsJson);
    storage.stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(db, source);
  return { db, source };
}

test('workflow checkpoints skip only identical empty markers while retaining progress and exact counts', async (t) => {
  const { db, source } = await fixture(t);
  const options = { mappingVersion: 'fictional-mapping', isSourceContextVersion: () => false };
  const checkpoints: Array<{ marker: string; head: string; nodes: number }> = [];
  let runningChecks = 0;
  const built = await buildVerifiedWorkflowSummary(db, source, {
    ...options,
    assertRunning() {
      runningChecks++;
    },
    onCheckpoint() {
      const { collections } = selectedEnvelopeStore(db, source);
      const view = collections.openView();
      const items = collections.range(view, 'builds', 'workflow.builds', {
        items: 2,
        bytes: 4096,
      }).items;
      assert.equal(items.length, 1);
      assert.equal(typeof items[0]!.value, 'string');
      checkpoints.push({
        marker: items[0]!.value as string,
        head: JSON.stringify(collections.binding(view)),
        nodes: intakeWorkCounters(db).warm.collectionNodesWritten,
      });
    },
  });

  assert.ok(checkpoints.length >= 3);
  assert.ok(runningChecks > checkpoints.length);
  assert.ok(
    checkpoints.some(
      (point, index) =>
        index > 0 &&
        point.marker === checkpoints[index - 1]!.marker &&
        point.head === checkpoints[index - 1]!.head &&
        point.nodes === checkpoints[index - 1]!.nodes,
    ),
    'an identical empty marker still yields without publishing a collection head',
  );
  assert.ok(
    checkpoints.some(
      (point, index) =>
        index > 0 &&
        point.marker !== checkpoints[index - 1]!.marker &&
        point.head !== checkpoints[index - 1]!.head &&
        point.nodes > checkpoints[index - 1]!.nodes,
    ),
    'a changed marker remains a durable checkpoint',
  );
  assert.deepEqual(built.counts, {
    needsReview: true,
    pendingCount: 1,
    unansweredCount: 0,
    pendingWorkCount: 0,
    reviewLaterCount: 0,
  });
  assert.deepEqual(readVerifiedWorkflowSummary(db, source, options).counts, built.counts);
  assert.equal((await buildVerifiedWorkflowSummary(db, source, options)).reused, true);
});

test('an identical-marker checkpoint still refuses a mapping change after yielding', async (t) => {
  const { db, source } = await fixture(t);
  let mapping = 'fictional-mapping';
  let previous: { marker: string; head: string } | undefined;
  let changed = false;
  await assert.rejects(
    buildVerifiedWorkflowSummary(db, source, {
      mappingVersion: 'fictional-mapping',
      currentMappingVersion: () => mapping,
      isSourceContextVersion: () => false,
      onCheckpoint() {
        const { collections } = selectedEnvelopeStore(db, source);
        const view = collections.openView();
        const items = collections.range(view, 'builds', 'workflow.builds', {
          items: 2,
          bytes: 4096,
        }).items;
        assert.equal(items.length, 1);
        const point = {
          marker: items[0]!.value as string,
          head: JSON.stringify(collections.binding(view)),
        };
        if (!changed && previous?.marker === point.marker && previous.head === point.head) {
          changed = true;
          mapping = 'changed-mapping';
        }
        previous = point;
      },
    }),
    /Workflow summary source or policy pins changed/,
  );
  assert.equal(changed, true);
  assert.equal(
    readVerifiedWorkflowSummary(db, source, { mappingVersion: 'fictional-mapping' }).state,
    'pending',
  );
});

test('workflow buffering yields to mapping invalidation before its first larger publication', async (t) => {
  const { db, source } = await fixture(t),
    before = intakeWorkCounters(db).warm.collectionNodesWritten;
  let mapping = 'fictional-mapping',
    turn: NodeJS.Immediate | undefined,
    checkpoints = 0;
  t.after(() => {
    if (turn) clearImmediate(turn);
  });
  await assert.rejects(
    buildVerifiedWorkflowSummary(db, source, {
      mappingVersion: 'fictional-mapping',
      currentMappingVersion: () => mapping,
      isSourceContextVersion: () => false,
      assertRunning() {
        turn ??= setImmediate(() => {
          mapping = 'changed-mapping';
        });
      },
      onCheckpoint() {
        checkpoints++;
      },
    }),
    /Workflow summary source or policy pins changed/,
  );
  assert.equal(mapping, 'changed-mapping');
  assert.equal(checkpoints, 0, 'the cooperative turn precedes the larger durable checkpoint');
  assert.equal(intakeWorkCounters(db).warm.collectionNodesWritten, before);
});

test('workflow fact buffering preserves a host turn within 15 candidate contributions', async (t) => {
  const { db, source } = await fixture(t, true);
  await buildVerifiedWorkflowSummary(db, source, {
    mappingVersion: 'fictional-before',
    isSourceContextVersion: () => false,
  });
  let visited = 0,
    observed = 0,
    turn: NodeJS.Immediate | undefined;
  const versions = new Set<string>();
  t.after(() => {
    if (turn) clearImmediate(turn);
  });
  const built = await buildVerifiedWorkflowSummary(db, source, {
    mappingVersion: 'fictional-after',
    isSourceContextVersion(versionId) {
      visited++;
      versions.add(versionId);
      turn ??= setImmediate(() => {
        observed = visited;
      });
      return false;
    },
  });
  assert.ok(observed > 0 && observed <= 15, 'actual host turn precedes a 60-change publication');
  assert.equal(visited, 130, 'counting and dependency construction each check all versions');
  assert.deepEqual(
    versions,
    new Set(Array.from({ length: 65 }, (_, n) => `fictional-version-${n}-0`)),
  );
  assert.equal(built.counts.pendingCount, 65);
  assert.equal(built.counts.needsReview, true);
});
