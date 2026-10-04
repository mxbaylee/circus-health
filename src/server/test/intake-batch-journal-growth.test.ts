import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntakeBatch, IntakeBatchReadingState } from '../../shared/intake-batch.ts';
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

type Work = ReturnType<typeof createIntakeBatchJournalWorkCounters>;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function measured<T>(run: () => T) {
  const work = createIntakeBatchJournalWorkCounters();
  const value = withIntakeBatchJournalWork(work, run);
  return { value, work: { ...work } };
}
function assertWarm(work: Work) {
  for (const key of [
    'eventReads',
    'eventReadBytes',
    'replayedEvents',
    'replayedChanges',
    'replayPathVisits',
    'replayCloneNodes',
    'replayStringUnits',
    'directoryEntries',
    'diffCalls',
    'diffSerializationCalls',
    'diffSerializedBytes',
  ] as const)
    assert.equal(work[key], 0, `${key} must not revisit prior history or state`);
}

/** Independent filesystem oracle: no production decoder, counters or manifest is
 * trusted to discover retained files or compute their exact payload sizes. */
function retainedJournal(root: string, profileId: string, id: string) {
  const directory = join(profilePaths(root, profileId).intakeBatches, id);
  const retained = new Map<string, Buffer>();
  let previousHead: Buffer | undefined;
  function inspect(work?: Work) {
    const files = new Map<string, Buffer>();
    function walk(relative = '') {
      for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        assert.equal(entry.isSymbolicLink(), false);
        if (entry.isDirectory()) walk(name);
        else files.set(name, readFileSync(join(directory, name)));
      }
    }
    walk();
    for (const [name, bytes] of retained)
      assert.deepEqual(files.get(name), bytes, `retained event changed or disappeared: ${name}`);
    const events = [...files].filter(([name]) => /^events\/\d{12}-[0-9a-f-]{36}\.json$/.test(name));
    const fresh = events.filter(([name]) => !retained.has(name));
    const head = files.get('events/current');
    assert.ok(head, 'a fixed current marker selects the immutable event chain');
    assert.ok(head.length < 1024, 'head cannot contain a snapshot or growing reference array');
    for (const [name, bytes] of files) {
      if (name === 'events/current') continue;
      if (name === 'writer.lock') {
        assert.equal(bytes.length, 0);
        continue;
      }
      assert.ok(
        events.some(([event]) => event === name),
        `unaccounted durable file: ${name}`,
      );
    }
    for (const [name, bytes] of fresh) {
      const event = JSON.parse(bytes.toString('utf8'));
      assert.equal(event.profileId, profileId);
      assert.equal(event.batchId, id);
      assert.equal(event.sequence, Number(name.slice('events/'.length, 'events/'.length + 12)));
      assert.equal(event.format, 'health-intake-batch-delta-v3');
      if (event.sequence > 1)
        assert.ok(
          event.changes.every((change: { path: string[] }) => change.path.length > 0),
          'only creation may contain the complete state',
        );
      retained.set(name, bytes);
    }
    if (work) {
      assert.equal(work.eventWrites, fresh.length);
      assert.equal(work.publishedEvents, fresh.length);
      assert.equal(
        work.eventWriteBytes,
        fresh.reduce((sum, [, bytes]) => sum + bytes.length, 0),
      );
      assert.equal(work.eventSerializedBytes, work.eventWriteBytes);
      if (previousHead) {
        assert.equal(work.headWrites, fresh.length ? 1 : 0);
        assert.equal(work.headWriteBytes, fresh.length ? head.length : 0);
      }
      if (!fresh.length && previousHead) assert.deepEqual(head, previousHead);
    }
    previousHead = Buffer.from(head);
    return {
      retainedEvents: retained.size,
      retainedBytes: [...retained.values()].reduce((sum, bytes) => sum + bytes.length, 0),
      headBytes: head.length,
      fresh: fresh.map(([, bytes]) => JSON.parse(bytes.toString('utf8'))),
    };
  }
  return { inspect };
}

test('scheduler manager retains exact initial plus 100/200/300 transitions with bounded warm journal work', (t) => {
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
  assert.equal(source.sha256, sha256(bytes));
  const creation = measured(() =>
    manager.create(profileId, {
      operationId: 'fictional-scheduler-growth',
      intakeIds: [source.id],
    }),
  );
  const id = creation.value.id;
  const journal = retainedJournal(root, profileId, id);
  journal.inspect(creation.work);
  const initialStop = measured(() => manager.stop(profileId, id));
  journal.inspect(initialStop.work);
  const expected: IntakeBatch = {
    id,
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
        sourceHash: sha256(bytes),
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
        queuedAt: null,
      },
    ],
  };
  assert.deepEqual(
    initialStop.value,
    expected,
    'Stop persists the same cleared queuedAt returned publicly',
  );
  const cumulative = createIntakeBatchJournalWorkCounters();
  const checkpoints: {
    transitions: number;
    retainedEvents: number;
    retainedBytes: number;
    headBytes: number;
    warm: Work;
    cold: Work;
    cumulative: Work;
  }[] = [];
  function checkpoint(transitions: number, warm: Work) {
    const retained = journal.inspect();
    const cold = measured(() => readIntakeBatch(root, profileId, id));
    assert.deepEqual(cold.value, expected);
    assert.equal(cold.work.eventReads, retained.retainedEvents);
    assert.equal(cold.work.eventReadBytes, retained.retainedBytes);
    assert.equal(cold.work.replayedEvents, retained.retainedEvents);
    assert.ok(cold.work.hashedBytes >= retained.retainedBytes);
    checkpoints.push({
      transitions,
      retainedEvents: retained.retainedEvents,
      retainedBytes: retained.retainedBytes,
      headBytes: retained.headBytes,
      warm,
      cold: cold.work,
      cumulative: { ...cumulative },
    });
  }
  checkpoint(0, initialStop.work);
  for (let change = 1; change <= 300; change++) {
    at = new Date(Date.UTC(2026, 0, 1, 0, 0, change)).toISOString();
    expected.updatedAt = at;
    const item = expected.items[0]!;
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
      item.queuedAt = null;
    }
    const last = measured(() =>
      change % 2 ? manager.resume(profileId, id) : manager.stop(profileId, id),
    );
    assertWarm(last.work);
    assert.deepEqual(
      last.value,
      expected,
      'complete response follows independent transition oracle',
    );
    assert.ok(last.work.dtoCloneCalls > 0, 'explicit complete responses are counted separately');
    journal.inspect(last.work);
    for (const key of Object.keys(cumulative) as (keyof Work)[]) cumulative[key] += last.work[key];
    if (change % 100 === 0) checkpoint(change, last.work);
  }
  for (const checkpoint of checkpoints.slice(2)) {
    const baseline = checkpoints[1]!.warm;
    for (const key of [
      'proxyPropertyReads',
      'proxyEnumeratedKeys',
      'proxyPathSerializationCalls',
      'proxyPathSerializedUnits',
      'headComparisonFields',
      'changeCloneNodes',
      'changeStringUnits',
      'fileSyncCalls',
      'directorySyncCalls',
      'authorityStats',
      'headReads',
      'headWrites',
      'headSerializationCalls',
      'eventSerializationCalls',
      'mutationOperations',
      'mutationPathVisits',
      'mutationCloneNodes',
      'mutationStringUnits',
      'hashCalls',
      'eventWrites',
      'dtoCloneNodes',
    ] as const)
      assert.equal(checkpoint.warm[key], baseline[key], `${key} cannot grow with retained history`);
    assert.ok(checkpoint.warm.eventWriteBytes <= baseline.eventWriteBytes + 8);
    assert.ok(checkpoint.warm.headReadBytes <= baseline.headReadBytes + 32);
    assert.ok(checkpoint.warm.headWriteBytes <= baseline.headWriteBytes + 32);
  }
  manager.close();
  const reopened = createIntakeBatchManager(options);
  assert.deepEqual(reopened.get(profileId, id), expected);
  reopened.close();
  assert.deepEqual(getIntakeOriginal(db, root, profileId, source.id).bytes, bytes);
  assert.equal(modelChecks, 0);
  t.diagnostic(
    JSON.stringify({
      format: 'fictional-intake-batch-journal-growth-v3',
      proofScope:
        'actual manager create/stop/resume; full DTO work and cold reconstruction separate; every immutable event and original retained byte-for-byte',
      limits: 'production defaults; no pruning or capacity changes',
      creation: creation.work,
      checkpoints,
      responseBoundary:
        'Stopped durable and returned queuedAt are both null; prior timestamps remain in immutable events.',
    }),
  );
});

test('actual manager request checkpoints touch one small subtree across growing history and many untouched items', async (t) => {
  fictionalModel(t);
  type Options = Parameters<typeof createIntakeBatchManager>[0];
  type Guard = NonNullable<Parameters<Options['assistant']['send']>[3]>['beforeModelRequest'];
  const receipts: {
    items: number;
    retainedUntouchedBytes: number;
    checkpoints: unknown[];
    small: Work;
    noChange: Work;
    dto: Work;
  }[] = [];
  for (const itemCount of [1, 100]) {
    const root = mkdtempSync(join(tmpdir(), 'fictional-manager-checkpoint-'));
    const profileId = 'fictional-checkpoint-person';
    const db = openDatabase(profilePaths(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    const databases = new Map([[profileId, db]]);
    const originals = Array.from({ length: itemCount }, (_, index) => {
      const bytes = Buffer.from(`Independently fictional clinic delivery ${index}.`);
      const source = uploadIntake(db, root, profileId, {
        filename: `fictional-${index}.txt`,
        newProviderName: 'Fictional checkpoint clinic',
        bytes,
      });
      return { source, bytes };
    });
    const untouched = Array.from({ length: itemCount === 1 ? 5 : 500 }, (_, index) => ({
      unitId: `retained-${index}`,
      locator: `Fictional retained exception ${index}: ${'x'.repeat(128)}`,
      reason: 'processing_stalled' as const,
    }));
    const ready = Promise.withResolvers<NonNullable<Guard>>();
    let syntheticDispatches = 0;
    const chat = { id: 'fictional-inert-chat', status: 'running' };
    const assistant: Options['assistant'] = {
      async ensureConnection() {},
      cancel() {},
      get: () => chat,
      isBusy: () => false,
      create: () => chat,
      send(_profile, _chat, _input, options) {
        syntheticDispatches++;
        assert.ok(options?.beforeModelRequest);
        ready.resolve(options.beforeModelRequest);
        return chat;
      },
      retry() {
        assert.fail('No synthetic retry is expected');
      },
      attachIntakeReadingRequestGuard() {
        return false;
      },
    };
    // Setup adds a valid large retained field before its first durable publication.
    // All subsequent mutations are the manager's real request checkpoint path.
    let seeded = false;
    const savedReasons: string[] = [];
    const manager = createIntakeBatchManager({
      root,
      databases,
      assistant,
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
      pollMs: 1,
      journalWriter(root, profileId, batch, reason) {
        savedReasons.push(reason);
        if (!seeded) {
          batch.items[0]!.exceptions = structuredClone(untouched);
          seeded = true;
        }
        writeIntakeBatch(root, profileId, batch, reason);
      },
    });
    try {
      const created = manager.create(profileId, {
        operationId: `fictional-checkpoints-${itemCount}`,
        intakeIds: originals.map(({ source }) => source.id),
      });
      // The measured invariant begins at dispatch. Native plan preparation is
      // real host work; the test's hang guard bounds admission, not a 3 s target.
      const guard = await new Promise<NonNullable<Guard>>((resolve, reject) => {
        const aborted = () =>
          reject(
            Error(
              `Guard not published: ${JSON.stringify({ savedReasons, current: { ...manager.get(profileId, created.id), items: manager.get(profileId, created.id).items.map(({ exceptions: _exceptions, ...item }) => item) } })}`,
            ),
          );
        if (t.signal.aborted) {
          aborted();
          return;
        }
        t.signal.addEventListener('abort', aborted, { once: true });
        ready.promise.then((value) => {
          t.signal.removeEventListener('abort', aborted);
          resolve(value);
        }, reject);
      });
      const id = created.id;
      const journal = retainedJournal(root, profileId, id);
      const initial = journal.inspect();
      const expected = manager.get(profileId, id);
      assert.equal(expected.items.length, itemCount);
      assert.deepEqual(expected.items[0]!.exceptions, untouched);
      assert.equal(expected.items[0]!.status, 'running');
      const reading: IntakeBatchReadingState = {
        status: 'running',
        reason: null,
        turns: 1,
        readyRecords: 0,
        remainingUnits: 1,
        pendingReadWindows: 0,
        coverage: 'reading_progress_only',
      };
      const checkpoints: unknown[] = [];
      let lastWork: Work | undefined;
      for (let transition = 0; transition <= 300; transition++) {
        if (transition) {
          const workUnit = {
            id: `fictional-unit-${String(transition).padStart(3, '0')}`,
            locator: 'fictional constant-size locator',
          };
          const result = measured(() => guard({ ...reading, workUnit }));
          assert.equal(result.value, false);
          assertWarm(result.work);
          assert.equal(
            result.work.dtoCloneCalls,
            0,
            'background checkpoint does not return a full DTO',
          );
          assert.equal(result.work.eventWrites, 1);
          const retained = journal.inspect(result.work);
          assert.deepEqual(retained.fresh[0].changes, [
            {
              op: 'set',
              path: ['items', '0', 'stalls'],
              value: { unitId: workUnit.id, locator: workUnit.locator, attempts: 0 },
            },
          ]);
          expected.items[0]!.stalls = {
            unitId: workUnit.id,
            locator: workUnit.locator,
            attempts: 0,
          };
          if (lastWork) {
            for (const key of [
              'proxyPropertyReads',
              'proxyEnumeratedKeys',
              'proxyPathSerializationCalls',
              'proxyPathSerializedUnits',
              'headComparisonFields',
              'changeCloneNodes',
              'changeStringUnits',
              'fileSyncCalls',
              'directorySyncCalls',
              'authorityStats',
              'headReads',
              'headWrites',
              'headSerializationCalls',
              'eventSerializationCalls',
              'mutationOperations',
              'mutationPathVisits',
              'mutationCloneNodes',
              'mutationStringUnits',
              'hashCalls',
            ] as const)
              assert.equal(
                result.work[key],
                lastWork[key],
                `${key} remains constant after one changed subtree`,
              );
          }
          if (lastWork)
            assert.ok(result.work.eventSerializedBytes <= lastWork.eventSerializedBytes + 1);
          lastWork = result.work;
        }
        if (transition % 100 === 0) {
          const retained = journal.inspect();
          assert.equal(retained.retainedEvents, initial.retainedEvents + transition);
          const cold = measured(() => readIntakeBatch(root, profileId, id));
          assert.deepEqual(
            cold.value,
            expected,
            'cold reconstruction equals complete independently updated DTO',
          );
          assert.equal(cold.work.eventReadBytes, retained.retainedBytes);
          checkpoints.push({
            transition,
            retainedEvents: retained.retainedEvents,
            retainedBytes: retained.retainedBytes,
            headBytes: retained.headBytes,
            warm: lastWork,
            cold: cold.work,
          });
        }
      }
      const small = measured(() =>
        guard({ ...reading, workUnit: { id: 'fictional-small-unit', locator: 'tiny' } }),
      );
      assertWarm(small.work);
      assert.equal(small.work.eventWrites, 1);
      assert.ok(small.work.mutationCloneNodes < 16, 'only the tiny changed subtree is copied');
      assert.ok(small.work.eventWriteBytes < 1024, 'unchanged retained fields are not serialized');
      journal.inspect(small.work);
      expected.items[0]!.stalls = { unitId: 'fictional-small-unit', locator: 'tiny', attempts: 0 };
      const noChange = measured(() =>
        guard({ ...reading, workUnit: { id: 'fictional-small-unit', locator: 'tiny' } }),
      );
      assertWarm(noChange.work);
      assert.equal(noChange.work.eventWrites, 0);
      assert.equal(noChange.work.headWrites, 0);
      assert.equal(noChange.work.eventSerializedBytes, 0);
      assert.equal(noChange.work.mutationOperations, 0);
      for (const key of [
        'mutationCloneNodes',
        'changeCloneNodes',
        'changeStringUnits',
        'headSerializedBytes',
        'fileSyncCalls',
        'directorySyncCalls',
      ] as const)
        assert.equal(noChange.work[key], 0, `${key} must be absent for an unchanged checkpoint`);
      journal.inspect(noChange.work);
      const dto = measured(() => manager.get(profileId, id));
      assert.deepEqual(dto.value, expected);
      assert.equal(dto.work.dtoCloneCalls, 1);
      assert.ok(dto.work.dtoCloneNodes > 20);
      assert.deepEqual(readIntakeBatch(root, profileId, id), expected);
      for (const { source, bytes } of originals)
        assert.deepEqual(getIntakeOriginal(db, root, profileId, source.id).bytes, bytes);
      assert.equal(
        syntheticDispatches,
        1,
        'one inert synthetic dispatch supplies the guard; no provider is connected',
      );
      receipts.push({
        items: itemCount,
        retainedUntouchedBytes: Buffer.byteLength(JSON.stringify(untouched)),
        checkpoints,
        small: small.work,
        noChange: noChange.work,
        dto: dto.work,
      });
    } finally {
      manager.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
  for (const operation of ['small', 'noChange'] as const) {
    const one = receipts[0]![operation],
      many = receipts[1]![operation];
    for (const key of [
      'proxyPropertyReads',
      'proxyEnumeratedKeys',
      'proxyPathSerializationCalls',
      'proxyPathSerializedUnits',
      'headComparisonFields',
      'changeCloneNodes',
      'changeStringUnits',
      'fileSyncCalls',
      'directorySyncCalls',
      'authorityStats',
      'headReads',
      'headWrites',
      'headSerializationCalls',
      'eventSerializationCalls',
      'mutationOperations',
      'mutationPathVisits',
      'mutationCloneNodes',
      'mutationStringUnits',
      'eventSerializedBytes',
      'hashCalls',
    ] as const)
      assert.equal(many[key], one[key], `${operation} ${key} cannot scale with untouched items`);
  }
  assert.ok(receipts[1]!.dto.dtoCloneNodes > receipts[0]!.dto.dtoCloneNodes);
  t.diagnostic(
    JSON.stringify({
      format: 'fictional-manager-checkpoint-growth-v3',
      proofScope:
        'real manager request checkpoint/save with inert in-process assistant and real tiny originals; no provider calls; valid large untouched exception field seeded before first publication',
      limits: 'production defaults; no pruning or capacity changes',
      receipts,
    }),
  );
});
