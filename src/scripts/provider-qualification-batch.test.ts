import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import {
  runQualificationBatch,
  summarizeQualificationBatch,
} from './provider-qualification-batch.ts';
import {
  captureQualificationEvidence,
  finishQualificationBudgetFailure,
  qualificationRequestSignal,
  readQualificationResponse,
  recordQualificationCleanupFailure,
  shareQualificationEvidence,
  writeQualificationPrivateJson,
} from './qualify-provider-pdf.ts';
import type { QualificationRequestBudget } from './provider-qualification-request-budget.ts';

test('deployment model-await requests ignore the host guard and retain operator cancellation', () => {
  const operator = new AbortController();
  const host = new AbortController();
  let guards = 0;
  const guard = () => {
    guards++;
    return host.signal;
  };
  const model = qualificationRequestSignal(operator.signal, true, guard);
  const local = qualificationRequestSignal(operator.signal, false, guard);
  assert.equal(guards, 1, 'model work must not create an elapsed-time guard');
  const hostFailure = Error('Fictional host guard expired');
  host.abort(hostFailure);
  assert.equal(local.aborted, true);
  assert.equal(local.reason, hostFailure);
  assert.equal(model.aborted, false);
  const canceled = Error('Fictional operator cancellation');
  operator.abort(canceled);
  assert.equal(model.aborted, true);
  assert.equal(model.reason, canceled);
  const otherHost = new AbortController();
  const localCanceled = qualificationRequestSignal(operator.signal, false, () => otherHost.signal);
  assert.equal(localCanceled.reason, canceled);
});

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

test('batch observation awaits its asynchronous review checkpoint before another poll', async () => {
  const order: string[] = [];
  const states = [snapshot(), complete()];
  const result = await runQualificationBatch({
    prefix: '/api/profiles/fictional-profile',
    profileId: 'fictional-profile',
    intakeId: 'fictional-original',
    signal: new AbortController().signal,
    request: async <T>() => {
      order.push('request');
      return states.shift() as T;
    },
    onSnapshot: async (batch) => {
      order.push('observe-' + batch.status);
      await new Promise<void>((done) => setImmediate(done));
      order.push('retained-' + batch.status);
    },
    wait: async () => {
      order.push('wait');
    },
  });
  assert.equal(result.passed, true);
  assert.deepEqual(order, [
    'request',
    'observe-running',
    'retained-running',
    'wait',
    'request',
    'observe-complete',
    'retained-complete',
  ]);
});

test('asynchronous checkpoint failure stops polling without a retry', async () => {
  let calls = 0;
  await assert.rejects(
    runQualificationBatch({
      prefix: '/api/profiles/fictional-profile',
      profileId: 'fictional-profile',
      intakeId: 'fictional-original',
      signal: new AbortController().signal,
      request: async <T>() => {
        calls++;
        return snapshot() as T;
      },
      onSnapshot: async () => {
        await Promise.resolve();
        throw Error('Fictional retained review failure');
      },
      wait: async () => assert.fail('failed checkpoint must not continue'),
    }),
    /retained review failure/,
  );
  assert.equal(calls, 1);
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

test('deployment qualification can follow coordinator progress without a model-time deadline', async () => {
  const states = [snapshot(), snapshot(), complete()];
  let time = 0;
  const result = await runQualificationBatch({
    prefix: '/api/profiles/fictional-profile',
    profileId: 'fictional-profile',
    intakeId: 'fictional-original',
    signal: new AbortController().signal,
    request: async <T>() => states.shift() as T,
    onSnapshot: () => {},
    now: () => time,
    wait: async () => {
      time += 365 * 24 * 60 * 60_000;
    },
  });
  assert.equal(result.passed, true);
  assert.equal(states.length, 0);
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

const exhaustedBudget: QualificationRequestBudget = {
  limit: 16,
  admitted: 16,
  denied: 1,
  runtimeClaimed: true,
  stopReason: 'completion_request_cap_reached',
  scope: 'Independently fictional admission receipts.',
};

test('verified cap exhaustion captures once before teardown, including an observer during final capture', async () => {
  const events: string[] = [];
  const deadline = new AbortController();
  let release!: (value: boolean) => void;
  const evidence = shareQualificationEvidence(
    [
      async () => {
        events.push('diagnostics');
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      },
      async () => {
        events.push('review');
        return false;
      },
    ],
    (outcomes) => {
      events.push('retained');
      assert.deepEqual(outcomes, [true, false]);
    },
  );
  const normal = evidence.capture(deadline.signal);
  // Normal finalization has begun, but neither the observer nor finalization
  // may issue another pair of capture requests or double-count their failures.
  const cleanup = finishQualificationBudgetFailure(
    exhaustedBudget,
    {
      abort: () => {
        events.push('abort');
      },
      capture: evidence.capture,
      stop: async () => {
        events.push('stop');
      },
    },
    deadline.signal,
  );
  await Promise.resolve();
  assert.deepEqual(events, ['diagnostics', 'review', 'abort']);
  release(true);
  await normal;
  await cleanup;
  assert.deepEqual(events, ['diagnostics', 'review', 'abort', 'retained', 'stop']);
});

test('completed evidence refreshes for later run state while its cap observer shares the new capture', async () => {
  let activeRun = 'fictional earlier run';
  const capturedRuns: string[] = [];
  const retained: (readonly boolean[])[] = [];
  const events: string[] = [];
  let release!: (value: boolean) => void;
  const deadline = new AbortController();
  const evidence = shareQualificationEvidence(
    [
      async () => {
        capturedRuns.push(activeRun);
        if (activeRun === 'fictional earlier run') return true;
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      },
    ],
    (outcomes) => {
      retained.push(outcomes);
    },
  );
  const earlier = evidence.capture(deadline.signal);
  await earlier;

  activeRun = 'fictional later updated run';
  const later = evidence.capture(deadline.signal);
  assert.notEqual(later, earlier);
  const observerDeadline = new AbortController();
  const observer = evidence.capture(observerDeadline.signal);
  assert.equal(observer, later);
  const cleanup = finishQualificationBudgetFailure(
    exhaustedBudget,
    {
      abort: () => {
        events.push('abort');
      },
      capture: evidence.capture,
      stop: async () => {
        events.push('stop');
      },
    },
    deadline.signal,
  );
  await Promise.resolve();
  assert.deepEqual(capturedRuns, ['fictional earlier run', 'fictional later updated run']);
  assert.deepEqual(events, ['abort']);
  release(false);
  await later;
  await cleanup;
  assert.deepEqual(retained, [[true], [false]]);
  assert.deepEqual(events, ['abort', 'stop']);
});

test('an observer shares the existing capture deadline even if its own signal remains live', async () => {
  const firstDeadline = new AbortController();
  const laterDeadline = new AbortController();
  const outcomes: (readonly boolean[])[] = [];
  let stopped = false;
  let captures = 0;
  const evidence = shareQualificationEvidence(
    [
      async () => {
        captures++;
        return new Promise<boolean>(() => {});
      },
    ],
    (result) => {
      outcomes.push(result);
    },
  );
  const normal = evidence.capture(firstDeadline.signal);
  const cleanup = finishQualificationBudgetFailure(
    exhaustedBudget,
    {
      abort() {},
      capture: evidence.capture,
      stop: async () => {
        stopped = true;
      },
    },
    laterDeadline.signal,
  );
  firstDeadline.abort();
  await normal;
  await cleanup;
  assert.equal(laterDeadline.signal.aborted, false);
  assert.equal(captures, 1);
  assert.equal(stopped, true);
  assert.deepEqual(outcomes, [[false]]);
});

test('cap capture deadline tears down an ignored signal and late completion cannot upgrade evidence', async () => {
  const deadline = new AbortController();
  const events: string[] = [];
  let release!: (value: boolean) => void;
  let retained: readonly boolean[] | undefined;
  const evidence = shareQualificationEvidence(
    [
      async (signal) => {
        assert.equal(signal, deadline.signal);
        events.push('capture');
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      },
    ],
    (outcomes) => {
      retained = outcomes;
    },
  );
  const cleanup = finishQualificationBudgetFailure(
    exhaustedBudget,
    {
      abort: () => {
        events.push('abort');
      },
      capture: evidence.capture,
      stop: async () => {
        events.push('stop');
      },
    },
    deadline.signal,
  );
  assert.deepEqual(events, ['abort', 'capture']);
  deadline.abort();
  await cleanup;
  assert.deepEqual(events, ['abort', 'capture', 'stop']);
  assert.deepEqual(retained, [false]);
  release(true);
  await Promise.resolve();
  assert.deepEqual(retained, [false]);
});

test('late batch JSON and deployment error bodies cannot mutate evidence after teardown', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-late-qualification-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const kind of ['batch', 'deployment-error'] as const) {
    const deadline = new AbortController();
    let release!: () => void;
    const transport = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled!: () => void;
    const captureSettled = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const report = {
      coordinator: summarizeQualificationBatch(snapshot()),
      diagnosticCaptureFailures: 0,
      reviewCaptureFailures: 0,
      cookie: '',
    };
    let subsequentReads = 0;
    let stopped = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          await transport;
          const body =
            kind === 'batch'
              ? JSON.stringify({ data: snapshot({ status: 'complete' }) })
              : 'Independently fictional late body';
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
      { status: kind === 'batch' ? 200 : 503 },
    );
    const evidence = shareQualificationEvidence(
      [
        async (signal) => {
          try {
            const batch = await readQualificationResponse<IntakeBatch>(response, signal, {
              cookie: (cookie) => {
                report.cookie = cookie;
              },
              failure: (status, body) =>
                writeQualificationPrivateJson(join(root, 'http-failure.json'), { status, body }),
            });
            // The production batch capture publishes only after this same guarded
            // response reader returns, then proceeds to intake/feed/proposal reads.
            report.coordinator = summarizeQualificationBatch(batch);
            subsequentReads++;
            writeQualificationPrivateJson(join(root, 'batch.json'), batch);
            return true;
          } finally {
            settled();
          }
        },
      ],
      ([review]) => {
        if (!review) report.reviewCaptureFailures++;
      },
    );
    const cleanup = finishQualificationBudgetFailure(
      exhaustedBudget,
      {
        abort() {},
        capture: evidence.capture,
        stop: async () => {
          stopped = true;
        },
      },
      deadline.signal,
    );
    deadline.abort();
    await cleanup;
    assert.equal(stopped, true);
    assert.equal(report.reviewCaptureFailures, 1);
    const beforeLateResponse = JSON.stringify(report);
    release();
    await captureSettled;
    assert.equal(JSON.stringify(report), beforeLateResponse);
    assert.equal(subsequentReads, 0);
    assert.deepEqual(readdirSync(root), []);
  }
});

test('unproven admission closure stops immediately without a diagnostic window', async () => {
  for (const snapshot of [
    null,
    { ...exhaustedBudget, admitted: 15 },
    { ...exhaustedBudget, runtimeClaimed: false },
    ...(
      [
        'unexpected_request_route',
        'worker_network_request_refused',
        'runtime_restart_refused',
        'receipt_integrity_failure',
      ] as const
    ).map((stopReason) => ({ ...exhaustedBudget, stopReason })),
  ]) {
    const events: string[] = [];
    await finishQualificationBudgetFailure(snapshot, {
      abort: () => {
        events.push('abort');
      },
      capture: async () => {
        events.push('capture');
      },
      stop: async () => {
        events.push('stop');
      },
    });
    assert.deepEqual(events, ['abort', 'stop']);
  }
});

test('budget cleanup propagates teardown failure after evidence failure without replacing the budget verdict', async () => {
  const failure = Error('Independently fictional teardown failure');
  const events: string[] = [];
  const evidence = shareQualificationEvidence(
    [
      async () => {
        throw Error('Independently fictional capture failure');
      },
    ],
    (outcomes) => {
      assert.deepEqual(outcomes, [false]);
      events.push('partial');
    },
  );
  await assert.rejects(
    finishQualificationBudgetFailure(exhaustedBudget, {
      abort: () => {
        events.push('abort');
      },
      capture: evidence.capture,
      stop: async () => {
        events.push('stop');
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, ['abort', 'partial', 'stop']);
  assert.equal(exhaustedBudget.stopReason, 'completion_request_cap_reached');
  assert.equal(exhaustedBudget.admitted, 16);
});

test('cleanup failure invalidates a successful verdict and preserves an earlier budget failure', () => {
  for (const failure of [null, 'Qualification inconclusive: completion_request_cap_reached.']) {
    const report = { passed: failure === null, failure, cleanupFailure: null as string | null };
    recordQualificationCleanupFailure(report);
    assert.equal(report.passed, false);
    assert.equal(
      report.cleanupFailure,
      'Qualification cleanup failed; inspect the isolated Compose project.',
    );
    assert.equal(report.failure, failure ?? report.cleanupFailure);
  }
});
