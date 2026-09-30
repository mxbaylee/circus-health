import test from 'node:test';
import { fictionalModel } from './fictional-model.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntakeBatchItem, IntakeBatchReadingState } from '../../shared/intake-batch.ts';
import {
  DEFAULT_INTAKE_READING_LIMITS,
  beginReadingSlice,
  finishReadingSlice,
  readingBudgetReached,
  readingModelRequestBudgetReached,
  extendReadingBudget,
  canContinueReadingSlice,
} from '../intake-reading-budget.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import { createAssistant } from '../assistant.ts';
import { openDatabase } from '../database.ts';
import { profilePaths } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake } from '../intake.ts';
import { ProxyModelBridge } from '../proxy-model-bridge.ts';
const waitFor = async (check: () => boolean) => {
  const until = Date.now() + 3000;
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check());
};
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

test('default stall allowance permits bootstrap tools and remains bounded by completed responses', () => {
  const file = item();
  beginReadingSlice(file, '2026-01-01T00:00:00Z', DEFAULT_INTAKE_READING_LIMITS);
  const limit = DEFAULT_INTAKE_READING_LIMITS.requests!;
  assert.ok(limit > 2, 'context read and plan creation must fit before the first source window');
  for (let responses = 1; responses < limit; responses++) {
    file.reading = state({ modelRequests: responses, usableModelResponses: responses });
    assert.equal(readingBudgetReached(file, '2026-01-02T00:00:00Z'), false);
  }
  file.reading = state({ modelRequests: limit, usableModelResponses: limit });
  assert.equal(readingBudgetReached(file, '2026-01-02T00:00:00Z'), true);
  assert.equal(
    readingModelRequestBudgetReached(
      file,
      state({ modelRequests: limit, usableModelResponses: limit, readWindows: 1 }),
      '2026-01-02T00:00:00Z',
    ),
    false,
    'new source coverage renews the allowance',
  );
});

test('only completed requests without unique durable progress can end a reading attempt', () => {
  const file = item();
  const limits = { activeMs: 1000, slices: 1, turns: 1, requests: 3, measuredTokens: 1 };
  beginReadingSlice(file, '2026-01-01T00:00:00Z', limits);
  assert.equal(
    readingModelRequestBudgetReached(
      file,
      state({ turns: 100, modelRequests: 2, usableModelResponses: 2, measuredModelTokens: 999999 }),
      '2026-01-01T00:10:00Z',
      limits,
    ),
    false,
  );
  assert.equal(
    readingModelRequestBudgetReached(
      file,
      state({ modelRequests: 3, usableModelResponses: 3 }),
      '2026-01-01T00:20:00Z',
      limits,
    ),
    true,
  );
  finishReadingSlice(
    file,
    state({ modelRequests: 3, usableModelResponses: 3 }),
    '2026-01-01T00:20:00Z',
  );
  extendReadingBudget(file);
  beginReadingSlice(file, '2026-01-02T00:00:00Z', limits);
  assert.equal(
    readingBudgetReached(file, '2026-01-02T00:00:00Z', limits),
    false,
    'dormant/queued time is not active work',
  );
  assert.equal(file.readingJob!.activeMs, 20 * 60_000);
});
test('slow completed model requests do not spend a stall attempt when the next request progresses', () => {
  const file = item();
  const limits = { activeMs: 1000, slices: 16, turns: 16, requests: 3, measuredTokens: 10000 };
  beginReadingSlice(file, '2026-01-01T00:00:00Z', limits);
  assert.equal(
    readingModelRequestBudgetReached(
      file,
      state({ modelRequests: 1, usableModelResponses: 1 }),
      '2026-01-01T00:10:00Z',
      limits,
    ),
    false,
  );
  assert.equal(
    readingModelRequestBudgetReached(
      file,
      state({ modelRequests: 2, usableModelResponses: 2, readWindows: 1 }),
      '2026-01-01T00:20:00Z',
      limits,
    ),
    false,
  );
});
test('substantive versions renew progress; identical versions and reads do not', () => {
  const file = item(),
    limits = { activeMs: 1000, slices: 1, turns: 1, requests: 1 };
  file.reading = state({ readyRecords: 1, substantiveVersions: 1, readWindows: 1 });
  beginReadingSlice(file, '2026-01-01T00:00:00Z', limits);
  const newVersion = state({
    readyRecords: 1,
    substantiveVersions: 2,
    readWindows: 1,
    modelRequests: 1,
    usableModelResponses: 1,
  });
  assert.equal(
    readingModelRequestBudgetReached(file, newVersion, '2026-01-01T00:00:01Z', limits),
    false,
  );
  assert.equal(
    readingModelRequestBudgetReached(
      file,
      { ...newVersion, modelRequests: 2, usableModelResponses: 2 },
      '2026-01-01T00:00:02Z',
      limits,
    ),
    true,
  );
});
test('legacy cumulative budgets cannot restore a manual pause', () => {
  const file = item();
  beginReadingSlice(file, '2026-01-01T00:00:00Z', {
    mode: 'cumulative',
    activeMs: 1,
    slices: 1,
    turns: 1,
  });
  file.reading = state({ turns: 100, modelRequests: 10000, measuredModelTokens: 99999999 });
  file.readingJob!.limitPolicy = 'progress-window';
  extendReadingBudget(file);
  assert.equal(readingBudgetReached(file, '2026-01-01T00:00:01Z'), false);
  for (const reason of ['job_limit', 'no_progress', 'time_limit', 'context_limit'])
    assert.equal(canContinueReadingSlice(state({ reason }), false), true);
  for (const reason of ['stopped', 'profile_locked', 'reading_exhausted'])
    assert.equal(canContinueReadingSlice(state({ reason }), false), false);
});
test('explicit Stop still aborts an admitted provider request immediately', async (t) => {
  fictionalModel(t);
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
      usableModelResponses: (i + 1) * 2,
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
      { ...file.reading!, modelRequests: 18, usableModelResponses: 18 },
      '2026-01-01T00:01:01Z',
      limits,
    ),
    true,
    'no-progress work still stops',
  );
});
