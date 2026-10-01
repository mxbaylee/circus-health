import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import { runQualificationBatch } from './provider-qualification-batch.ts';
import {
  captureQualificationEvidence,
  writeQualificationPrivateJson,
} from './qualify-provider-pdf.ts';

function snapshot(overrides: Partial<IntakeBatch> = {}): IntakeBatch {
  return {
    id: 'fictional-batch',
    profileId: 'fictional-profile',
    operationId: 'fictional-operation',
    automaticRun: true,
    status: 'running',
    reason: null,
    currentIndex: 0,
    createdAt: '',
    updatedAt: '',
    items: [
      {
        intakeId: 'fictional-original',
        sourceHash: 'fictional-sha',
        filename: 'fictional.pdf',
        mimeType: 'application/pdf',
        status: 'running',
        reason: null,
        chatId: 'fictional-chat',
        proposalIds: ['fictional-proposal'],
        startedAt: '',
        endedAt: null,
        reading: {
          status: 'paused',
          reason: 'time_limit',
          turns: 1,
          modelRequests: 31,
          measuredModelTokens: 2000,
          modelUsageIncomplete: false,
          readyRecords: 80,
          remainingUnits: 40,
          pendingReadWindows: 1,
          coverage: 'reading_progress_only',
        },
        readingJob: {
          slices: 1,
          activeMs: 900_000,
          sliceStartedAt: null,
          lastProgressAt: '',
          baseline: { records: 0, windows: 0, accounted: 0 },
          budgetAtSlices: 0,
          budgetAtActiveMs: 0,
          budgetAtTurns: 0,
          extensions: 0,
        },
      },
    ],
    ...overrides,
  };
}

function complete() {
  const result = snapshot({ status: 'complete' });
  result.items[0].status = 'review_ready';
  result.items[0].reason = 'bounded_pass_ready';
  result.items[0].reading = {
    ...result.items[0].reading!,
    reason: 'reading_exhausted',
    readyRecords: 400,
    remainingUnits: 0,
    pendingReadWindows: 0,
  };
  result.items[0].readingJob!.slices = 2;
  return result;
}

function runner(states: IntakeBatch[]) {
  const calls: { path: string; input: unknown }[] = [];
  const waits: number[] = [];
  const retained: IntakeBatch[] = [];
  let time = 0;
  return {
    calls,
    waits,
    retained,
    run: (timeoutMs = 60_000) =>
      runQualificationBatch({
        prefix: '/api/profiles/fictional-profile',
        profileId: 'fictional-profile',
        intakeId: 'fictional-original',
        operationId: 'fictional-operation',
        timeoutMs,
        signal: new AbortController().signal,
        request: async <T>(path: string, input?: unknown) => {
          calls.push({ path, input });
          const state = states.shift();
          assert.ok(state, 'the helper must not issue extra requests');
          return state as T;
        },
        now: () => time,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
          time += milliseconds;
        },
        onSnapshot: (batch) => {
          retained.push(structuredClone(batch));
        },
      }),
  };
}

test('qualification waits through an idle time-limited slice for the batch coordinator', async () => {
  const firstChatIdle = snapshot();
  const continuing = snapshot();
  continuing.items[0].status = 'queued';
  continuing.items[0].reason = 'continuing';
  const nextSlice = snapshot();
  nextSlice.items[0].reading!.status = 'running';
  nextSlice.items[0].reading!.reason = null;
  nextSlice.items[0].readingJob!.slices = 2;
  const execution = runner([snapshot(), firstChatIdle, continuing, nextSlice, complete()]);
  const result = await execution.run();
  assert.equal(result.passed, true);
  assert.equal(result.readingJob?.slices, 2);
  assert.equal(result.readingJob?.extensions, 0);
  assert.equal(execution.retained.length, 5);
  assert.deepEqual(execution.waits, [5_000, 5_000, 5_000, 5_000]);
  assert.deepEqual(execution.calls[0], {
    path: '/api/profiles/fictional-profile/intake-batches',
    input: {
      operationId: 'fictional-operation',
      intakeIds: ['fictional-original'],
      appendToRunning: true,
    },
  });
  assert.equal(execution.calls.filter((call) => call.input !== undefined).length, 1);
  assert.ok(
    execution.calls
      .slice(1)
      .every(
        (call) =>
          call.path === '/api/profiles/fictional-profile/intake-batches/fictional-batch' &&
          call.input === undefined,
      ),
  );
  assert.ok(execution.calls.every((call) => !/convert|resume|assistant\/chats/.test(call.path)));
});

test('upload-created automatic batch retains its own operation ID throughout polling', async () => {
  const first = snapshot({ operationId: 'upload-operation' });
  const last = complete();
  last.operationId = 'upload-operation';
  const execution = runner([first, last]);
  assert.equal((await execution.run()).passed, true);
  assert.equal(execution.calls.length, 2);
  const drift = complete();
  drift.operationId = 'another-operation';
  await assert.rejects(
    runner([snapshot({ operationId: 'upload-operation' }), drift]).run(),
    /operation_id/,
  );
});

test('paused, stopped and exhausted whole-job budgets cannot pass qualification', async () => {
  const exhausted = complete();
  exhausted.reason = 'items_paused';
  exhausted.items[0].reason = 'job_limit';
  exhausted.items[0].reading!.reason = 'job_limit';
  for (const terminal of [
    snapshot({ status: 'paused' }),
    snapshot({ status: 'stopped' }),
    exhausted,
  ]) {
    const execution = runner([terminal]);
    assert.equal((await execution.run()).passed, false);
    assert.equal(execution.calls.length, 1, 'terminal failures must never resume or retry');
  }
});

test('explicitly extended jobs and incomplete terminal reading never qualify as autonomous completion', async () => {
  const extended = complete();
  extended.items[0].readingJob!.extensions = 1;
  const missingJob = complete();
  delete missingJob.items[0].readingJob;
  const pending = complete();
  pending.items[0].reading!.remainingUnits = 1;
  for (const terminal of [extended, missingJob, pending])
    assert.equal((await runner([terminal]).run()).passed, false);
});

test('a running batch reaches the harness deadline without another start or resume', async () => {
  const execution = runner([snapshot(), snapshot()]);
  await assert.rejects(execution.run(5_000), /within its bound/);
  assert.equal(execution.calls.length, 1);
  assert.equal(execution.retained[0].status, 'running');
});

test('the coordinator receipt must remain in the freshly created profile and original', async () => {
  const wrongIntake = snapshot();
  wrongIntake.items[0]!.intakeId = 'unrelated-original';
  for (const invalid of [
    snapshot({ profileId: 'unrelated-profile' }),
    snapshot({ items: [snapshot().items[0], snapshot().items[0]] }),
    wrongIntake,
  ]) {
    await assert.rejects(runner([invalid]).run(), /scope/);
  }
});

test('cancellation cannot start or resume a qualification batch', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    runQualificationBatch({
      prefix: '/api/profiles/fictional-profile',
      profileId: 'fictional-profile',
      intakeId: 'fictional-original',
      timeoutMs: 60_000,
      signal: controller.signal,
      request: async <T>() => {
        calls++;
        return complete() as T;
      },
      onSnapshot: () => {
        throw Error('Cancelled qualification must not advance.');
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
});

test('external recovery and review receipts retain exact data with owner-only permissions', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-qualification-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(statSync(root).mode & 0o777, 0o700);
  const path = join(root, 'fictional-recovery.json');
  const receipt = {
    profileId: 'fictional-profile',
    recoveryKit: { fictional: true, words: ['never-real'] },
  };
  writeQualificationPrivateJson(path, receipt);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), receipt);
  chmodSync(path, 0o644);
  const updated = { ...receipt, actualReview: [{ mapping: { valueText: '<0.01' } }] };
  writeQualificationPrivateJson(path, updated);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), updated);
});

test('read-only capture counts artifact rejection and partial results once per capture', async () => {
  const signals: AbortSignal[] = [];
  const outcomes = await captureQualificationEvidence([
    (signal) => {
      signals.push(signal);
      throw Error('Fictional write failure before request.');
    },
    async (signal) => {
      signals.push(signal);
      return false;
    },
    async (signal) => {
      signals.push(signal);
      return true;
    },
  ]);
  assert.deepEqual(outcomes, [false, false, true]);
  assert.ok(
    signals.every((signal) => signal === signals[0]),
    'one shared cleanup deadline',
  );
});
