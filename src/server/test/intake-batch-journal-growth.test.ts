import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntakeBatch } from '../../shared/intake-batch.ts';
import { createAssistant } from '../assistant.ts';
import { openDatabase } from '../database.ts';
import {
  createIntakeBatchJournalWorkCounters,
  readIntakeBatch,
  withIntakeBatchJournalWork,
  writeIntakeBatch,
} from '../intake-batch-journal.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import { getIntakeOriginal, uploadIntake } from '../intake.ts';
import { attachPersonalDurability } from '../portable.ts';
import { profilePaths } from '../profile-storage.ts';
import { fictionalModel } from './fictional-model.ts';

test('scheduler batch journal retains 300 manager transitions and attributes its growing history scans', (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-batch-journal-growth-'));
  const profileId = 'fictional-journal-person';
  const db = openDatabase(profilePaths(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const databases = new Map([[profileId, db]]);
  let modelChecks = 0;
  const assistant = createAssistant({
    root,
    databases,
    availability: () => ({ available: false, readiness: 'unavailable' }),
    connectionCheck: async () => {
      modelChecks++;
      return { available: false, readiness: 'unavailable' };
    },
  });
  let at = '2026-01-01T00:00:00.000Z';
  const options = { root, databases, assistant, clock: () => new Date(at) };
  const manager = createIntakeBatchManager(options);
  t.after(() => {
    manager.close();
    assistant.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from('Fictional clinic source retained through scheduler transitions.');
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-journal-source.txt',
    newProviderName: 'Fictional journal clinic',
    bytes,
  });
  assert.equal(source.sha256, createHash('sha256').update(bytes).digest('hex'));
  const cumulative = createIntakeBatchJournalWorkCounters();
  const retained = new Map<string, Buffer>();
  let retainedBytes = 0;
  let replayedChanges = 0;
  let replayPathVisits = 0;
  let directory = '';
  const checkpoints: unknown[] = [];

  // These calls are synchronous: each durable callback completes before return.
  // Stop cancels the scheduled timer before yielding, so this measures scheduler
  // state transitions, not clinical processing or the separate intake authority.
  function mutation<T>(run: () => T) {
    const previousEvents = retained.size;
    const previousBytes = retainedBytes;
    const work = createIntakeBatchJournalWorkCounters();
    const value = withIntakeBatchJournalWork(work, run);
    assert.equal(work.writeCalls, 1);
    assert.equal(work.eventWrites, 1);
    assert.equal(work.publishedEvents, 1);
    assert.equal(work.eventReads, previousEvents);
    assert.equal(work.eventReadBytes, previousBytes);
    assert.equal(work.replayedEvents, previousEvents);
    assert.equal(work.replayedChanges, replayedChanges);
    assert.equal(work.replayPathVisits, replayPathVisits);
    assert.equal(work.directoryEntries, 2 * previousEvents);
    if (!directory) {
      directory = join(
        profilePaths(root, profileId).root,
        'intake-batches',
        (value as IntakeBatch).id,
        'events',
      );
    }
    const files = readdirSync(directory).sort();
    assert.equal(files.length, previousEvents + 1, 'every immutable event remains present');
    for (const [name, saved] of retained) {
      assert.deepEqual(
        readFileSync(join(directory, name)),
        saved,
        'published events are immutable',
      );
    }
    const name = files.at(-1)!;
    const content = readFileSync(join(directory, name));
    const event = JSON.parse(content.toString('utf8'));
    assert.equal(event.sequence, previousEvents + 1);
    assert.equal(event.profileId, profileId);
    retained.set(name, content);
    retainedBytes += content.length;
    assert.equal(work.eventWriteBytes, content.length);
    assert.equal(
      files.reduce((total, file) => total + readFileSync(join(directory, file)).length, 0),
      retainedBytes,
    );
    const changes: [string[], unknown][] = event.changes || [];
    const removed: string[][] = event.removed || [];
    replayedChanges += changes.length + removed.length;
    replayPathVisits += [...changes.map(([path]) => path), ...removed].reduce(
      (total, path) => total + path.length,
      0,
    );
    assert.equal(work.emittedChanges, changes.length);
    assert.equal(work.emittedRemovals, removed.length);
    for (const key of Object.keys(cumulative) as (keyof typeof cumulative)[])
      cumulative[key] += work[key];
    return {
      value,
      work,
      emittedValueBytes: changes.reduce(
        (total, [, value]) => total + Buffer.byteLength(JSON.stringify(value)),
        0,
      ),
      emittedSnapshotBytes: event.batch ? Buffer.byteLength(JSON.stringify(event.batch)) : 0,
    };
  }

  const creation = mutation(() =>
    manager.create(profileId, {
      operationId: 'fictional-scheduler-growth',
      intakeIds: [source.id],
    }),
  );
  const created = creation.value;
  const initialStop = mutation(() => manager.stop(profileId, created.id));
  const expected: IntakeBatch = {
    id: created.id,
    profileId,
    operationId: 'fictional-scheduler-growth',
    selectionIntakeIds: [source.id],
    automaticRun: false,
    status: 'stopped',
    reason: 'stopped',
    currentIndex: 0,
    createdAt: at,
    updatedAt: at,
    items: [
      {
        intakeId: source.id,
        sourceHash: createHash('sha256').update(bytes).digest('hex'),
        filename: 'fictional-journal-source.txt',
        mimeType: 'application/octet-stream',
        automaticRun: false,
        resumeAutomaticRun: true,
        status: 'paused',
        reason: 'stopped',
        retryAt: null,
        chatId: null,
        proposalIds: [],
        reading: null,
        startedAt: null,
        endedAt: at,
        queuedAt: at,
      },
    ],
  };
  function checkpoint(changes: number, lastMutation: unknown) {
    const opening = createIntakeBatchJournalWorkCounters();
    assert.deepEqual(
      withIntakeBatchJournalWork(opening, () => readIntakeBatch(root, profileId, created.id)),
      expected,
    );
    assert.equal(opening.eventReads, retained.size);
    assert.equal(opening.eventReadBytes, retainedBytes);
    checkpoints.push({
      changes,
      retainedEvents: retained.size,
      retainedBytes,
      cumulative: { ...cumulative },
      lastMutation,
      opening,
    });
  }
  checkpoint(0, { work: initialStop.work, emittedValueBytes: initialStop.emittedValueBytes });
  for (let change = 1; change <= 300; change++) {
    at = new Date(Date.UTC(2026, 0, 1, 0, 0, change)).toISOString();
    expected.updatedAt = at;
    const item = expected.items[0];
    if (change % 2) {
      expected.status = 'running';
      expected.reason = null;
      expected.automaticRun = true;
      item.status = 'queued';
      item.reason = null;
      item.automaticRun = true;
      item.forceModelResume = true;
      item.endedAt = null;
      item.queuedAt = at;
      delete item.resumeAutomaticRun;
    } else {
      expected.status = 'stopped';
      expected.reason = 'stopped';
      expected.automaticRun = false;
      item.status = 'paused';
      item.reason = 'stopped';
      item.automaticRun = false;
      item.resumeAutomaticRun = true;
      item.retryAt = null;
      item.endedAt = at;
    }
    const last = mutation(() =>
      change % 2 ? manager.resume(profileId, created.id) : manager.stop(profileId, created.id),
    );
    const responseExpected = structuredClone(expected);
    // observeQueues clears this diagnostic field after journal publication.
    if (change % 2 === 0) responseExpected.items[0].queuedAt = null;
    assert.deepEqual(
      last.value,
      responseExpected,
      'full manager response follows an independent transition oracle',
    );
    if (change % 100 === 0)
      checkpoint(change, { work: last.work, emittedValueBytes: last.emittedValueBytes });
  }
  manager.close();
  const reopened = createIntakeBatchManager(options);
  assert.deepEqual(reopened.get(profileId, created.id), expected);
  reopened.close();

  // One exact field change after the large history qualifies the journal alone.
  expected.items[0].reason = 'fictional-small-change';
  const small = mutation(() =>
    writeIntakeBatch(root, profileId, expected, 'fictional-small-change'),
  );
  assert.equal(small.work.emittedChanges, 1);
  assert.equal(small.work.emittedRemovals, 0);
  assert.equal(small.work.eventReads, 302, 'the current journal still scans all old events');
  const lastEvent = JSON.parse(retained.get([...retained.keys()].at(-1)!)!.toString());
  assert.deepEqual(lastEvent.changes, [[['items', '0', 'reason'], 'fictional-small-change']]);
  assert.deepEqual(readIntakeBatch(root, profileId, created.id), expected);
  assert.deepEqual(getIntakeOriginal(db, root, profileId, source.id).bytes, bytes);
  assert.equal(modelChecks, 0);
  t.diagnostic(
    JSON.stringify({
      format: 'fictional-intake-batch-journal-growth-v1',
      proofScope:
        'actual create/stop/resume scheduler APIs; no scheduler dispatch, clinical processing, or intake authority qualification',
      limits: 'production defaults; no pruning or capacity changes',
      initialState: 'one uploaded physical source; create and stop publish two initial events',
      initialCreation: { work: creation.work, emittedSnapshotBytes: creation.emittedSnapshotBytes },
      checkpoints,
      smallMutation: {
        retainedEvents: retained.size,
        retainedBytes,
        work: small.work,
        emittedValueBytes: small.emittedValueBytes,
      },
      limitation:
        'Every write rereads and replays all retained scheduler events; diff serializes the full batch. This is attribution evidence, not bounded processing evidence.',
      responseBoundary:
        'Stopped public responses clear diagnostic queuedAt after publication; durable/reopened state retains the timestamp. Both are checked independently.',
    }),
  );
});
