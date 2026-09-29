import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntakeBatchItem, IntakeBatchReadingState } from '../../shared/intake-batch.ts';
import {
  beginReadingSlice,
  canContinueReadingSlice,
  extendReadingBudget,
  finishReadingSlice,
  readingBudgetReached,
  readingModelRequestBudgetReached,
} from '../intake-reading-budget.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import { createAssistant } from '../assistant.ts';
import { openDatabase } from '../database.ts';
import { profilePaths } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { linkIntakeConversion, uploadIntake } from '../intake.ts';
import { ProxyModelBridge, type HealthTool } from '../proxy-model-bridge.ts';

const waitFor = async (check: () => boolean) => {
  const until = Date.now() + 2_000;
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check());
};

const boundaryTool: HealthTool = {
  type: 'function',
  name: 'health_fictional_budget_write',
  description: 'Retain an independently fictional budget-boundary receipt',
  inputSchema: {
    type: 'object',
    properties: { operationId: { type: 'string' } },
    required: ['operationId'],
    additionalProperties: false,
  },
};

const toolResponse = (model: string, totalTokens = 0) =>
  new Response(
    JSON.stringify({
      model,
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                type: 'function',
                id: 'fictional-budget-call',
                function: {
                  name: boundaryTool.name,
                  arguments: JSON.stringify({ operationId: 'fictional-budget-operation' }),
                },
              },
            ],
          },
        },
      ],
      ...(totalTokens
        ? {
            usage: {
              prompt_tokens: Math.max(1, totalTokens - 1),
              completion_tokens: 1,
              total_tokens: totalTokens,
            },
          }
        : {}),
    }),
    { headers: { 'content-type': 'application/json' } },
  );

const unavailableResponse = () =>
  new Response('{"error":{"message":"fictional temporary outage"}}', {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });

const state = (overrides: Partial<IntakeBatchReadingState> = {}): IntakeBatchReadingState => ({
  status: 'paused',
  reason: 'time_limit',
  turns: 1,
  readyRecords: 0,
  remainingUnits: 2,
  pendingReadWindows: 2,
  readWindows: 0,
  accountedUnits: 0,
  totalUnits: 2,
  coverage: 'reading_progress_only',
  ...overrides,
});
const item = (): IntakeBatchItem => ({
  intakeId: 'fictional',
  sourceHash: 'fictional-hash',
  filename: 'fictional.txt',
  mimeType: 'text/plain',
  status: 'running',
  reason: null,
  chatId: 'fictional-chat',
  proposalIds: [],
  reading: state(),
  startedAt: null,
  endedAt: null,
});

test('automatic slices count cumulative active work and only monotonic evidence progress', () => {
  const file = item();
  beginReadingSlice(file, '2026-01-01T00:00:00Z');
  assert.equal(finishReadingSlice(file, state({ turns: 9 }), '2026-01-01T00:01:00Z'), false);
  assert.equal(file.readingJob!.activeMs, 60_000);
  beginReadingSlice(file, '2026-01-01T03:00:00Z');
  const reading = state({ readWindows: 1 });
  assert.equal(finishReadingSlice(file, reading, '2026-01-01T03:01:00Z'), true);
  file.reading = reading;
  assert.equal(file.readingJob!.activeMs, 120_000, 'paused wall time is not active work');
  assert.equal(file.readingJob!.slices, 2);
  assert.equal(
    readingBudgetReached(file, '2026-01-01T03:02:00Z', {
      activeMs: 120_000,
      slices: 16,
      turns: 256,
    }),
    true,
  );
  extendReadingBudget(file);
  assert.equal(file.readingJob!.slices, 2, 'explicit extension preserves history');
  assert.equal(file.readingJob!.activeMs, 120_000);
  assert.equal(file.readingJob!.extensions, 1);
  assert.equal(readingBudgetReached(file, '2026-01-01T03:02:00Z'), false);
});

test('only productive time/context boundaries auto-continue; failures, Stop and lock do not', () => {
  assert.equal(canContinueReadingSlice(state(), true), true);
  assert.equal(canContinueReadingSlice(state({ reason: 'context_limit' }), true), true);
  assert.equal(canContinueReadingSlice(state(), false), false);
  for (const reason of [
    'stopped',
    'profile_locked',
    'error',
    'no_progress',
    'tool_error',
    'model_unavailable',
    'job_limit',
    'interrupted',
    'reading_exhausted',
  ])
    assert.equal(canContinueReadingSlice(state({ reason }), true), false, reason);
  assert.equal(
    canContinueReadingSlice(state({ remainingUnits: 0, pendingReadWindows: 0 }), true),
    false,
  );
});

test('an active slice is stopped at the whole-job budget rather than resetting time', () => {
  const file = item();
  beginReadingSlice(file, '2026-01-01T00:00:00Z');
  const limits = { activeMs: 1_000, slices: 1, turns: 2 };
  assert.equal(readingBudgetReached(file, '2026-01-01T00:00:00Z', limits), false);
  assert.equal(readingBudgetReached(file, '2026-01-01T00:00:01Z', limits), true);
  finishReadingSlice(file, state(), '2026-01-01T00:00:01Z');
  assert.equal(readingBudgetReached(file, '2026-01-01T00:00:01Z', limits), true);
});

test('request and measured-token budgets persist across slices and only explicit extension resets their offsets', () => {
  const file = item();
  file.reading = state({ modelRequests: 5, measuredModelTokens: 100 });
  beginReadingSlice(file, '2026-01-01T00:00:00Z');
  file.reading = state({ modelRequests: 7, measuredModelTokens: 120 });
  const limits = { activeMs: 100_000, slices: 16, turns: 256, requests: 2, measuredTokens: 50 };
  assert.equal(readingBudgetReached(file, '2026-01-01T00:00:01Z', limits), true);
  finishReadingSlice(file, file.reading, '2026-01-01T00:00:01Z');
  extendReadingBudget(file);
  assert.equal(readingBudgetReached(file, '2026-01-01T00:00:01Z', limits), false);
  beginReadingSlice(file, '2026-01-01T00:00:02Z');
  file.reading.measuredModelTokens = 170;
  assert.equal(readingBudgetReached(file, '2026-01-01T00:00:02Z', limits), true);
  assert.equal(file.reading.modelRequests, 7);
  assert.equal(file.readingJob?.budgetAtRequests, 7);
});

test('the provider-request boundary uses live counters, elapsed time and extension offsets without consuming the current turn twice', () => {
  const file = item();
  file.reading = state({ turns: 10, modelRequests: 5, measuredModelTokens: 100 });
  beginReadingSlice(file, '2026-01-01T00:00:00.000Z');
  const limits = { activeMs: 1_000, slices: 3, turns: 2, requests: 2, measuredTokens: 50 };

  assert.equal(
    readingModelRequestBudgetReached(
      file,
      state({ turns: 11, modelRequests: 6, measuredModelTokens: 149 }),
      '2026-01-01T00:00:00.999Z',
      limits,
    ),
    false,
    'the final allowed request and its already-reserved turn remain available',
  );
  assert.equal(
    readingModelRequestBudgetReached(
      file,
      state({ turns: 12, modelRequests: 6, measuredModelTokens: 149 }),
      '2026-01-01T00:00:00.999Z',
      limits,
    ),
    false,
    'the final productive continuation turn remains available',
  );
  assert.equal(
    readingModelRequestBudgetReached(
      file,
      state({ turns: 13, modelRequests: 6, measuredModelTokens: 149 }),
      '2026-01-01T00:00:00.999Z',
      limits,
    ),
    true,
    'a further continuation cannot start a provider request',
  );
  assert.equal(
    readingModelRequestBudgetReached(
      file,
      state({ turns: 11, modelRequests: 7, measuredModelTokens: 149 }),
      '2026-01-01T00:00:00.999Z',
      limits,
    ),
    true,
    'a retry cannot overshoot the cumulative request limit',
  );
  assert.equal(
    readingModelRequestBudgetReached(
      file,
      state({ turns: 11, modelRequests: 6, measuredModelTokens: 150 }),
      '2026-01-01T00:00:00.999Z',
      limits,
    ),
    true,
    'known measured tokens stop the next request',
  );
  assert.equal(
    readingModelRequestBudgetReached(
      file,
      state({ turns: 11, modelRequests: 6, measuredModelTokens: 149 }),
      '2026-01-01T00:00:01.000Z',
      limits,
    ),
    true,
    'current active elapsed time stops the next request',
  );

  file.reading = state({ turns: 11, modelRequests: 7, measuredModelTokens: 150 });
  finishReadingSlice(file, file.reading, '2026-01-01T00:00:01.000Z');
  extendReadingBudget(file);
  beginReadingSlice(file, '2026-01-01T00:00:02.000Z');
  assert.equal(
    readingModelRequestBudgetReached(
      file,
      state({ turns: 12, modelRequests: 7, measuredModelTokens: 150 }),
      '2026-01-01T00:00:02.000Z',
      limits,
    ),
    false,
    'an explicit extension advances every cumulative offset without erasing history',
  );
  assert.equal(file.readingJob?.extensions, 1);
});

test('the actual assistant and proxy bridge stop a 503 retry at the last whole-job request and resume only after extension', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'circus-reading-request-boundary-'));
  const profileId = 'fictional-request-boundary';
  const db = openDatabase(profilePaths(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const databases = new Map([[profileId, db]]);
  let physicalRequests = 0;
  const pending: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = [];
  const assistant = createAssistant({
    root,
    databases,
    availability: () => ({ available: true, readiness: 'ready' }),
    connectionCheck: async () => ({ available: true, readiness: 'ready' }),
    bridgeFactory: (options) =>
      new ProxyModelBridge({
        ...options,
        config: {
          backend: 'litellm',
          model: 'fictional-request-boundary-alias',
          baseUrl: 'http://proxy.test:4000',
          apiKey: 'fictional-request-boundary-key',
          reasoning: null,
          images: false,
          pdf: false,
          promptCache: false,
          localOnly: false,
          resolvedModel: null,
          timeoutSeconds: 60,
        },
        fetchImpl: async (_url, init) => {
          physicalRequests++;
          const signal = init?.signal;
          assert.ok(signal);
          return new Promise<Response>((resolve, reject) => {
            pending.push({ signal, resolve });
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        onDiagnostic: () => {},
        retryDelay: async () => {},
      }),
  });
  const manager = createIntakeBatchManager({
    root,
    databases,
    assistant,
    pollMs: 2,
    continuationDelayMs: 1,
    readingLimits: {
      activeMs: 60_000,
      slices: 16,
      turns: 256,
      requests: 1,
      measuredTokens: 20_000_000,
    },
  });
  t.after(() => {
    manager.close();
    assistant.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-request-boundary.txt',
    bytes: Buffer.from('Independently fictional request-boundary fixture.'),
  });
  const batch = manager.create(profileId, {
    operationId: 'fictional-request-boundary-start',
    intakeIds: [source.id],
  });
  const waitFor = async (check: () => boolean) => {
    const until = Date.now() + 2_000;
    while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(check());
  };

  await waitFor(() => pending.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(pending[0]!.signal.aborted, false, 'polling preserves the admitted request');
  pending[0]!.resolve(
    new Response('{"error":{"message":"fictional temporary outage"}}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await waitFor(() => {
    const current = manager.get(profileId, batch.id);
    return current.status === 'complete' && current.items[0]!.reason === 'job_limit';
  });
  let limited = manager.get(profileId, batch.id).items[0]!;
  assert.equal(physicalRequests, 1, 'the 503 retry is blocked before transport');
  assert.equal(limited.reading?.modelRequests, 1, 'only the physical request is counted');
  assert.equal(limited.reading?.reason, 'job_limit');

  manager.resume(profileId, batch.id);
  await waitFor(() => pending.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(pending[1]!.signal.aborted, false, 'extension request survives bounded polling');
  pending[1]!.resolve(
    new Response('{"error":{"message":"fictional temporary outage"}}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await waitFor(() => {
    const current = manager.get(profileId, batch.id);
    return (
      current.status === 'complete' &&
      current.items[0]!.reason === 'job_limit' &&
      current.items[0]!.readingJob?.extensions === 1 &&
      current.items[0]!.reading?.modelRequests === 2
    );
  });
  limited = manager.get(profileId, batch.id).items[0]!;
  assert.equal(physicalRequests, 2, 'the explicit extension allows exactly one more request');
  assert.equal(limited.reading?.modelRequests, 2);
  assert.equal(limited.readingJob?.budgetAtRequests, 1);
});

test('known-token and active-time boundaries preserve an admitted response and its host tool before stopping the next request', async (t) => {
  for (const boundary of ['tokens', 'active-time'] as const)
    await t.test(boundary, async (t) => {
      const root = mkdtempSync(join(tmpdir(), `circus-reading-${boundary}-boundary-`));
      const profileId = `fictional-${boundary}-boundary`;
      const db = openDatabase(profilePaths(root, profileId).database, profileId);
      attachPersonalDurability(db, { root, profileId });
      const databases = new Map([[profileId, db]]);
      let physicalRequests = 0;
      let hostWrites = 0;
      let batchNow = Date.parse('2026-01-01T00:00:00.000Z');
      let admitted: { signal: AbortSignal; resolve: (response: Response) => void } | undefined;
      const model = `fictional-${boundary}-alias`;
      const assistant = createAssistant({
        root,
        databases,
        availability: () => ({ available: true, readiness: 'ready' }),
        connectionCheck: async () => ({ available: true, readiness: 'ready' }),
        actionExtensions: {
          tools: [boundaryTool],
          call: async () => {
            hostWrites++;
            return { retained: true };
          },
        },
        bridgeFactory: (options) =>
          new ProxyModelBridge({
            ...options,
            config: {
              backend: 'litellm',
              model,
              baseUrl: 'http://proxy.test:4000',
              apiKey: 'fictional-boundary-key',
              reasoning: null,
              images: false,
              pdf: false,
              promptCache: false,
              localOnly: false,
              resolvedModel: null,
              timeoutSeconds: 60,
            },
            fetchImpl: async (_url, init) => {
              physicalRequests++;
              const signal = init?.signal;
              assert.ok(signal);
              return new Promise<Response>((resolve, reject) => {
                admitted = { signal, resolve };
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              });
            },
            onDiagnostic: () => {},
            retryDelay: async () => {},
          }),
      });
      const manager = createIntakeBatchManager({
        root,
        databases,
        assistant,
        clock: () => new Date(batchNow),
        pollMs: 2,
        readingLimits: {
          activeMs: boundary === 'active-time' ? 20 : 60_000,
          slices: 16,
          turns: 256,
          requests: 10,
          measuredTokens: boundary === 'tokens' ? 5 : 20_000_000,
        },
      });
      t.after(() => {
        manager.close();
        assistant.close();
        db.close();
        rmSync(root, { recursive: true, force: true });
      });
      const source = uploadIntake(db, root, profileId, {
        filename: `fictional-${boundary}-boundary.txt`,
        bytes: Buffer.from(`Independently fictional ${boundary} boundary fixture.`),
      });
      const batch = manager.create(profileId, {
        operationId: `fictional-${boundary}-boundary-start`,
        intakeIds: [source.id],
      });

      await waitFor(() => physicalRequests === 1 && !!admitted);
      if (boundary === 'active-time') batchNow += 20;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(admitted!.signal.aborted, false, 'the final admitted response is preserved');
      admitted!.resolve(toolResponse(model, boundary === 'tokens' ? 5 : 0));
      await waitFor(() => {
        const current = manager.get(profileId, batch.id);
        return current.status === 'complete' && current.items[0]!.reason === 'job_limit';
      });
      const limited = manager.get(profileId, batch.id).items[0]!;
      assert.equal(physicalRequests, 1, 'the next provider request is blocked before transport');
      assert.equal(hostWrites, 1, 'the admitted host tool completes exactly once');
      assert.equal(limited.reading?.reason, 'job_limit');
      if (boundary === 'tokens') assert.equal(limited.reading?.measuredModelTokens, 5);
      else assert.ok((limited.readingJob?.activeMs || 0) >= 20);
    });
});

test('the final allowed turn completes one host tool and its same-turn provider continuation without replay', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'circus-reading-final-turn-'));
  const profileId = 'fictional-final-turn';
  const db = openDatabase(profilePaths(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const databases = new Map([[profileId, db]]);
  const pending: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = [];
  let hostWrites = 0;
  const model = 'fictional-final-turn-alias';
  const assistant = createAssistant({
    root,
    databases,
    availability: () => ({ available: true, readiness: 'ready' }),
    connectionCheck: async () => ({ available: true, readiness: 'ready' }),
    actionExtensions: {
      tools: [boundaryTool],
      call: async () => {
        hostWrites++;
        return { retained: true };
      },
    },
    bridgeFactory: (options) =>
      new ProxyModelBridge({
        ...options,
        config: {
          backend: 'litellm',
          model,
          baseUrl: 'http://proxy.test:4000',
          apiKey: 'fictional-final-turn-key',
          reasoning: null,
          images: false,
          pdf: false,
          promptCache: false,
          localOnly: false,
          resolvedModel: null,
          timeoutSeconds: 60,
        },
        fetchImpl: async (_url, init) => {
          const signal = init?.signal;
          assert.ok(signal);
          return new Promise<Response>((resolve, reject) => {
            pending.push({ signal, resolve });
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        onDiagnostic: () => {},
        retryDelay: async () => {},
      }),
  });
  const manager = createIntakeBatchManager({
    root,
    databases,
    assistant,
    pollMs: 2,
    readingLimits: {
      activeMs: 60_000,
      slices: 16,
      turns: 1,
      requests: 2,
      measuredTokens: 20_000_000,
    },
  });
  t.after(() => {
    manager.close();
    assistant.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-final-turn.txt',
    bytes: Buffer.from('Independently fictional final-turn fixture.'),
  });
  const batch = manager.create(profileId, {
    operationId: 'fictional-final-turn-start',
    intakeIds: [source.id],
  });

  await waitFor(() => pending.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(pending[0]!.signal.aborted, false);
  pending[0]!.resolve(toolResponse(model));
  await waitFor(() => pending.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    pending[1]!.signal.aborted,
    false,
    'the reserved final turn permits its post-tool provider continuation',
  );
  pending[1]!.resolve(unavailableResponse());
  await waitFor(() => {
    const current = manager.get(profileId, batch.id);
    return current.status === 'complete' && current.items[0]!.reason === 'job_limit';
  });
  const limited = manager.get(profileId, batch.id).items[0]!;
  assert.equal(pending.length, 2, 'the 503 retry is blocked before a third physical request');
  assert.equal(limited.reading?.modelRequests, 2);
  assert.equal(limited.reading?.turns, 1);
  assert.equal(hostWrites, 1, 'the prior host write is never replayed');
});

test('attaching a running conversion installs the same synchronous allowance before fast provider rounds', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'circus-reading-attached-boundary-'));
  const profileId = 'fictional-attached-boundary';
  const db = openDatabase(profilePaths(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const databases = new Map([[profileId, db]]);
  let physicalRequests = 0;
  let hostWrites = 0;
  let firstRequest: { signal: AbortSignal; resolve: (response: Response) => void } | undefined;
  const model = 'fictional-attached-boundary-alias';
  const assistant = createAssistant({
    root,
    databases,
    availability: () => ({ available: true, readiness: 'ready' }),
    connectionCheck: async () => ({ available: true, readiness: 'ready' }),
    actionExtensions: {
      tools: [boundaryTool],
      call: async () => {
        hostWrites++;
        return { retained: true };
      },
    },
    bridgeFactory: (options) =>
      new ProxyModelBridge({
        ...options,
        config: {
          backend: 'litellm',
          model,
          baseUrl: 'http://proxy.test:4000',
          apiKey: 'fictional-attached-boundary-key',
          reasoning: null,
          images: false,
          pdf: false,
          promptCache: false,
          localOnly: false,
          resolvedModel: null,
          timeoutSeconds: 60,
        },
        fetchImpl: async (_url, init) => {
          physicalRequests++;
          const signal = init?.signal;
          assert.ok(signal);
          if (physicalRequests > 1) return unavailableResponse();
          return new Promise<Response>((resolve, reject) => {
            firstRequest = { signal, resolve };
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        onDiagnostic: () => {},
        retryDelay: async () => {},
      }),
  });
  const manager = createIntakeBatchManager({
    root,
    databases,
    assistant,
    pollMs: 100,
    readingLimits: {
      activeMs: 60_000,
      slices: 16,
      turns: 256,
      requests: 1,
      measuredTokens: 20_000_000,
    },
  });
  t.after(() => {
    manager.close();
    assistant.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-attached-boundary.txt',
    bytes: Buffer.from('Independently fictional attached-running fixture.'),
  });
  const chat = assistant.create(profileId, {
    title: 'Fictional attached conversion',
    context: { route: `/import?intake=${encodeURIComponent(source.id)}`, intakeId: source.id },
  });
  linkIntakeConversion(db, root, profileId, source.id, chat.id);
  assistant.send(profileId, chat.id, {
    message: 'Begin the independently fictional linked conversion.',
    context: { route: `/import?intake=${encodeURIComponent(source.id)}`, intakeId: source.id },
  });
  await waitFor(() => physicalRequests === 1 && !!firstRequest);

  const batch = manager.create(profileId, {
    operationId: 'fictional-attached-boundary-start',
    intakeIds: [source.id],
  });
  await waitFor(() => manager.get(profileId, batch.id).items[0]!.status === 'running');
  const attached = manager.get(profileId, batch.id).items[0]!;
  assert.equal(attached.readingJob?.budgetAtRequests, 1);
  assert.equal(firstRequest!.signal.aborted, false, 'attachment preserves the admitted request');
  firstRequest!.resolve(toolResponse(model));

  await waitFor(() => {
    const current = manager.get(profileId, batch.id);
    return current.status === 'complete' && current.items[0]!.reason === 'job_limit';
  });
  const limited = manager.get(profileId, batch.id).items[0]!;
  assert.equal(physicalRequests, 2, 'only one post-attachment physical request is admitted');
  assert.equal(limited.reading?.modelRequests, 2);
  assert.equal(hostWrites, 1, 'the pre-attachment response tool is dispatched once');
});

test('explicit Stop still aborts an admitted provider request immediately', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'circus-reading-stop-boundary-'));
  const profileId = 'fictional-stop-boundary';
  const db = openDatabase(profilePaths(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const databases = new Map([[profileId, db]]);
  let admittedSignal: AbortSignal | undefined;
  let batchNow = Date.parse('2026-01-01T00:00:00.000Z');
  const assistant = createAssistant({
    root,
    databases,
    availability: () => ({ available: true, readiness: 'ready' }),
    connectionCheck: async () => ({ available: true, readiness: 'ready' }),
    bridgeFactory: (options) =>
      new ProxyModelBridge({
        ...options,
        config: {
          backend: 'litellm',
          model: 'fictional-stop-boundary-alias',
          baseUrl: 'http://proxy.test:4000',
          apiKey: 'fictional-stop-boundary-key',
          reasoning: null,
          images: false,
          pdf: false,
          promptCache: false,
          localOnly: false,
          resolvedModel: null,
          timeoutSeconds: 60,
        },
        fetchImpl: async (_url, init) => {
          const signal = init?.signal;
          assert.ok(signal);
          admittedSignal = signal;
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        onDiagnostic: () => {},
      }),
  });
  const manager = createIntakeBatchManager({
    root,
    databases,
    assistant,
    clock: () => new Date(batchNow),
    pollMs: 2,
    readingLimits: {
      activeMs: 20,
      slices: 16,
      turns: 1,
      requests: 1,
      measuredTokens: 1,
    },
  });
  t.after(() => {
    manager.close();
    assistant.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-stop-boundary.txt',
    bytes: Buffer.from('Independently fictional Stop boundary fixture.'),
  });
  const batch = manager.create(profileId, {
    operationId: 'fictional-stop-boundary-start',
    intakeIds: [source.id],
  });
  await waitFor(() => !!admittedSignal);
  batchNow += 20;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(admittedSignal!.aborted, false, 'passive limits do not abort admitted work');
  const stopped = manager.stop(profileId, batch.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(admittedSignal!.aborted, true, 'explicit Stop remains immediate');
});

test('the batch automatically starts another productive slice then exposes the cumulative limit', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'circus-reading-budget-'));
  const profileId = 'fictional-budget';
  const db = openDatabase(profilePaths(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  let sends = 0;
  const chat = {
    id: 'fictional-budget-chat',
    status: 'idle',
    context: { intakeId: '' },
    reading: state(),
  };
  const assistant = {
    get: () => structuredClone(chat),
    isBusy: () => chat.status === 'running',
    create: (_profile: string, input: { context: { intakeId: string } }) => {
      chat.context = input.context;
      return structuredClone(chat);
    },
    send: () => {
      sends++;
      chat.status = 'running';
      return structuredClone(chat);
    },
    retry: () => {
      sends++;
      chat.status = 'running';
      return structuredClone(chat);
    },
    attachIntakeReadingRequestGuard: () => true,
    cancel: () => {
      chat.status = 'cancelled';
    },
  };
  const manager = createIntakeBatchManager({
    root,
    databases: new Map([[profileId, db]]),
    assistant,
    pollMs: 2,
    continuationDelayMs: 1,
    readingLimits: { activeMs: 60_000, slices: 2, turns: 256 },
  });
  t.after(() => {
    manager.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-budget.txt',
    bytes: Buffer.from('Independently fictional reading fixture.'),
  });
  const batch = manager.create(profileId, {
    operationId: 'fictional-budget-start',
    intakeIds: [source.id],
  });
  const waitFor = async (check: () => boolean) => {
    const until = Date.now() + 2_000;
    while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(check());
  };
  await waitFor(() => sends === 1);
  chat.reading = state({ readWindows: 1 });
  chat.status = 'idle';
  await waitFor(() => sends === 2);
  assert.equal(manager.get(profileId, batch.id).items[0]!.readingJob!.slices, 2);
  chat.reading = state({ readWindows: 2 });
  chat.status = 'idle';
  await waitFor(() => {
    const current = manager.get(profileId, batch.id);
    return current.status === 'complete' && current.items[0]!.reason === 'job_limit';
  });
  assert.equal(sends, 2);
  const limited = manager.get(profileId, batch.id).items[0]!;
  assert.equal(limited.reading!.reason, 'job_limit');
  assert.equal(limited.readingJob!.slices, 2);
  manager.resume(profileId, batch.id);
  await waitFor(() => sends === 3);
  assert.equal(manager.get(profileId, batch.id).items[0]!.readingJob!.extensions, 1);
  manager.stop(profileId, batch.id);
  assert.equal(manager.get(profileId, batch.id).status, 'stopped');
  assert.equal(sends, 3);
});

test('new productive-window policy continues beyond total guards without erasing cumulative work', () => {
  const file = item(),
    limits = {
      mode: 'progress-window' as const,
      activeMs: 1000,
      slices: 2,
      turns: 2,
      requests: 2,
      measuredTokens: 50,
    };
  for (let i = 0; i < 8; i++) {
    const at = new Date(Date.parse('2026-01-01T00:00:00Z') + i * 2000).toISOString();
    beginReadingSlice(file, at, limits);
    const reading = state({
      readWindows: i + 1,
      turns: i + 1,
      modelRequests: (i + 1) * 2,
      measuredModelTokens: (i + 1) * 50,
    });
    assert.equal(
      finishReadingSlice(file, reading, new Date(Date.parse(at) + 1000).toISOString()),
      true,
    );
    file.reading = reading;
    assert.equal(
      readingBudgetReached(file, new Date(Date.parse(at) + 1000).toISOString(), limits),
      false,
    );
  }
  assert.equal(file.readingJob!.slices, 8);
  assert.equal(file.readingJob!.activeMs, 8000);
  assert.equal(file.reading?.modelRequests, 16);
  assert.equal(file.reading?.measuredModelTokens, 400);
  assert.equal(file.readingJob!.extensions, 0);
  beginReadingSlice(file, '2026-01-01T00:01:00Z', limits);
  assert.equal(
    readingModelRequestBudgetReached(
      file,
      { ...file.reading!, modelRequests: 18 },
      '2026-01-01T00:01:01Z',
      limits,
    ),
    true,
    'no-progress work still stops',
  );
});
