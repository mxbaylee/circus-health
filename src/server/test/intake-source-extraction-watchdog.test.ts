import { randomUUID } from 'node:crypto';
import { getIntakeSourceText, publishIntakeSourceText } from '../intake-source-text.ts';
import { writeIntakeBatch, readIntakeBatch } from '../intake-batch-journal.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError, openDatabase } from '../database.ts';
import { profilePaths } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake } from '../intake.ts';
import { createAssistant } from '../assistant.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import type { extractIntakeSourceText } from '../intake-source-extraction.ts';

function gate(t: TestContext) {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  t.signal.addEventListener('abort', resolve, { once: true });
  t.after(resolve);
  return { promise, resolve };
}
async function until(t: TestContext, predicate: () => boolean) {
  while (!predicate()) {
    t.signal.throwIfAborted();
    t.mock.timers.tick(0);
    await setImmediate();
  }
}
function fixture(
  t: TestContext,
  extract: typeof extractIntakeSourceText,
  authorized?: Parameters<typeof createIntakeBatchManager>[0]['authorized'],
) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-extraction-watchdog-'));
  const profileId = 'fictional-watchdog';
  const db = openDatabase(profilePaths(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    bytes: Buffer.from('Fictional local source text.'),
  });
  let time = 0;
  const epoch = Date.now();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => time);
  const databases = new Map([[profileId, db]]);
  const assistant = createAssistant({
    root,
    databases,
    availability: () => ({ available: false, readiness: 'unavailable' }),
    connectionCheck: async () => ({ available: false, readiness: 'unavailable' }),
    bridgeFactory() {
      throw Error('No provider dispatch in fictional watchdog fixture');
    },
  });
  const journalReasons: string[] = [];
  let manager: ReturnType<typeof createIntakeBatchManager> | undefined;
  t.after(() => {
    manager?.close();
    assistant.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    profileId,
    db,
    source,
    journalReasons,
    advance(ms: number) {
      time += ms;
      t.mock.timers.tick(ms);
    },
    start() {
      manager = createIntakeBatchManager({
        root,
        databases,
        assistant,
        extract,
        sourceStallMs: 100,
        authorized,
        journalWriter(root, profileId, batch, reason) {
          journalReasons.push(reason);
          writeIntakeBatch(root, profileId, batch, reason);
        },
        clock: () => new Date(epoch + time),
        pollMs: 1,
        providerRetryBaseMs: 1000,
      });
      return manager;
    },
  };
}

for (const mode of ['initial admission', 'publication admission'] as const)
  test(
    `source watchdog excludes ${mode} wait and retains its remaining active budget`,
    { timeout: 30000 },
    async (t) => {
      const entered = gate(t),
        release = gate(t),
        workerStarted = gate(t),
        continueWorker = gate(t);
      let dispatched = 0,
        phaseDone = false;
      let context: Parameters<typeof extractIntakeSourceText>[0] | undefined;
      const f = fixture(t, async (c) => {
        dispatched++;
        context = c;
        workerStarted.resolve();
        await continueWorker.promise;
        if (mode === 'publication admission') {
          c.onCoordinationWait?.(true);
          try {
            await runExclusiveClinicalOperation(
              c.db,
              async () => {
                c.onCoordinationWait?.(false);
                c.assertRunning?.();
              },
              { assertRunning: c.assertRunning },
            );
          } finally {
            c.onCoordinationWait?.(false);
          }
          phaseDone = true;
        }
        return new Promise<Awaited<ReturnType<typeof extractIntakeSourceText>>>(() => {});
      });
      let owner: Promise<unknown> | undefined;
      if (mode === 'initial admission')
        owner = runExclusiveClinicalOperation(f.db, async () => {
          entered.resolve();
          await release.promise;
        });
      const manager = f.start();
      const batch = manager.list(f.profileId)[0]!;
      const item = () => manager.get(f.profileId, batch.id).items[0]!;
      const receipts = () =>
        f.db
          .prepare("SELECT value FROM app_meta WHERE key LIKE 'intake_source_extraction:v1:%'")
          .all()
          .map((row) => JSON.parse(String(row.value)).receipt);
      t.after(async () => {
        release.resolve();
        continueWorker.resolve();
        await Promise.allSettled([owner]);
      });
      try {
        if (mode === 'initial admission') {
          await entered.promise;
          await until(t, () => !!item().sourceExtraction?.operationId);
          f.advance(1000);
          await setImmediate();
          assert.equal(dispatched, 0);
          assert.equal(receipts().length, 0, 'Queued admission has no worker receipt yet');
          assert.equal(item().sourceExtraction?.stalls ?? 0, 0);
          release.resolve();
          await owner;
          await until(t, () => dispatched === 1);
          continueWorker.resolve();
        } else {
          await until(t, () => dispatched === 1);
          f.advance(40);
          owner = runExclusiveClinicalOperation(f.db, async () => {
            entered.resolve();
            await release.promise;
          });
          await entered.promise;
          continueWorker.resolve();
          await setImmediate();
          f.advance(1000);
          await setImmediate();
          assert.equal(phaseDone, false);
          assert.equal(receipts()[0].status, 'started');
          assert.equal(item().sourceExtraction?.stalls ?? 0, 0);
          release.resolve();
          await owner;
          await until(t, () => phaseDone);
        }
        assert.ok(context);
        const remaining = mode === 'initial admission' ? 100 : 60;
        f.advance(remaining - 1);
        await setImmediate();
        assert.equal(receipts()[0].status, 'started');
        assert.doesNotThrow(() => context!.assertRunning?.());
        f.advance(1);
        await until(t, () => receipts()[0].status === 'interrupted');
        assert.equal(receipts()[0].reasonCode, 'SOURCE_EXTRACTION_INTERRUPTED');
        await until(t, () => item().sourceExtraction?.stalls === 1);
        assert.equal(dispatched, 1);
        assert.equal(item().reason, 'retrying_extraction');
        assert.throws(
          () => context!.assertRunning?.(),
          /SOURCE_EXTRACTION_STALLED|operation changed/,
        );
        manager.stop(f.profileId, batch.id);
      } finally {
        release.resolve();
        continueWorker.resolve();
        await Promise.allSettled([owner]);
      }
    },
  );

// The public authorization callback schedules Stop only after it observes the
// newly accepted source exception. It returns true for that completed phase;
// Stop runs in the next microtask before the batch's await continuation.
for (const mode of ['no progress', 'revision race'] as const)
  test(
    `Stop after accepted source exception prevents late ${mode} batch saves`,
    { timeout: 30000 },
    async (t) => {
      let calls = 0,
        stopQueued = false,
        stopped = false,
        acceptedRevision: string | undefined;
      let manager: ReturnType<typeof createIntakeBatchManager> | undefined;
      let batchId: string | undefined;
      const f = fixture(
        t,
        async () => {
          calls++;
          if (mode === 'revision race')
            throw new HttpError(409, 'SOURCE_TEXT_CHANGED', 'Fictional independent human edit');
          throw Error('Fictional worker produced no progress');
        },
        (profileId, id, operation) => {
          if (
            operation === 'publish' &&
            !stopQueued &&
            profileId === f.profileId &&
            id === f.source.id
          ) {
            const source = getIntakeSourceText(f.db, f.root, profileId, id);
            if (source.revision?.issues.some((issue) => issue.id === 'p1-processing-stalled')) {
              assert.equal(
                f.db.isTransaction,
                false,
                'The accepted publication transaction has ended',
              );
              assert.notEqual(source.revision.id, initial.revision!.id);
              acceptedRevision = source.revision.id;
              stopQueued = true;
              queueMicrotask(() => {
                assert.ok(manager && batchId);
                manager.stop(f.profileId, batchId);
                stopped = true;
              });
            }
          }
          return true;
        },
      );
      const initial = publishIntakeSourceText(f.db, f.root, f.profileId, f.source.id, {
        operationId: randomUUID(),
        expectedRevisionId: null,
        sourceHash: f.source.sha256,
        evidence: {
          adapter: { name: 'fictional-pending-page', version: '1' },
          pages: [{ page: 1, disposition: 'partial', inspected: false }],
          spans: [],
          relations: [],
          issues: [
            {
              id: 'p1-pending',
              region: { page: 1 },
              kind: 'coverage',
              status: 'open',
              detail: 'Fictional pending source page',
            },
          ],
        },
      });
      manager = f.start();
      batchId = manager.list(f.profileId)[0]!.id;
      const state = () => manager!.get(f.profileId, batchId!).items[0]!;
      for (let attempt = 1; attempt <= 3; attempt++) {
        f.advance(10_000);
        manager.wake(f.profileId);
        if (attempt < 3)
          await until(
            t,
            () =>
              (mode === 'revision race'
                ? state().sourceRetryAttempts
                : state().sourceExtraction?.stalls) === attempt,
          );
      }
      await until(t, () => stopped);
      for (let i = 0; i < 8; i++) {
        t.mock.timers.tick(0);
        await setImmediate();
      }
      const retained = readIntakeBatch(f.root, f.profileId, batchId);
      assert.equal(retained.status, 'stopped');
      assert.equal(retained.items[0]!.reason, 'stopped');
      assert.equal(retained.items[0]!.automaticRun, false);
      assert.equal(calls, 3);
      const stop = f.journalReasons.lastIndexOf('stopped');
      assert.ok(stop >= 0);
      assert.deepEqual(f.journalReasons.slice(stop + 1), [], 'No late batch save follows Stop');
      assert.equal(
        getIntakeSourceText(f.db, f.root, f.profileId, f.source.id).revision?.id,
        acceptedRevision,
      );
    },
  );
