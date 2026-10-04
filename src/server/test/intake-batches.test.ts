import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { HttpError, openDatabase, transaction } from '../database.ts';
import { profilePaths } from '../profile-storage.ts';
import { attachPersonalDurability, rebuildProfile } from '../portable.ts';
import { createBackup } from '../recovery.ts';
import { createAssistant } from '../assistant.ts';
import { writeIntakeBatch, readIntakeBatch } from '../intake-batch-journal.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import {
  getIntake,
  getIntakeOriginal,
  linkIntakeConversion,
  uploadIntake as uploadIntakeRaw,
} from '../intake.ts';
import { createApp } from '../index.ts';
import { createImportDiagnostics } from '../import-diagnostics.ts';
import { writeIntakeSourcePin } from '../intake-source-pin.ts';
import { fictionalModel } from './fictional-model.ts';
import { extractIntakeSourceText } from '../intake-source-extraction.ts';
import { DEFAULT_INTAKE_READING_LIMITS } from '../intake-reading-budget.ts';

const profileId = 'cedar';
const waitFor = async <T>(
  predicate: () => T,
  message = 'condition',
): Promise<Exclude<T, false | null | undefined>> => {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value as Exclude<T, false | null | undefined>;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${message}`);
};

type AssistantOptions = Parameters<typeof createAssistant>[0];
type BatchOptions = Parameters<typeof createIntakeBatchManager>[0];
type BridgeFactory = NonNullable<AssistantOptions['bridgeFactory']>;
type TestBridge = ReturnType<BridgeFactory> & {
  callbacks: Parameters<BridgeFactory>[0];
  closed: boolean;
  started: boolean;
};

function uploadIntake(...args: Parameters<typeof uploadIntakeRaw>) {
  return Object.assign(uploadIntakeRaw(...args), { db: args[0], root: args[1] });
}

function setup(
  t: TestContext,
  overrides: Partial<AssistantOptions> = {},
  batchOverrides: Partial<BatchOptions> = {},
) {
  fictionalModel(t);
  const root = mkdtempSync(resolve(tmpdir(), 'health-intake-batches-'));
  const db = openDatabase(profilePaths(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const databases = new Map([[profileId, db]]);
  const bridges: TestBridge[] = [];
  let checks = 0;
  const newAssistant = () =>
    createAssistant({
      root,
      databases,
      availability: () => ({ available: true, readiness: 'ready' }),
      connectionCheck: async () => {
        checks++;
        return { available: true, readiness: 'ready' };
      },
      bridgeFactory(callbacks) {
        const bridge: TestBridge = {
          callbacks,
          closed: false,
          started: false,
          async start() {
            return { model: 'fictional-batch-model', backend: 'synthetic' };
          },
          async turn() {
            bridge.started = true;
            callbacks.onEvent?.('turn/started', { turn: { id: 'turn-1' } });
          },
          async cancel() {},
          close() {
            this.closed = true;
          },
        };
        bridges.push(bridge);
        return bridge;
      },
      ...overrides,
    });
  const assistant = newAssistant();
  const manager = createIntakeBatchManager({
    root,
    databases,
    assistant,
    pollMs: 5,
    ...batchOverrides,
  });
  t.after(() => {
    manager.close();
    assistant.close();
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    db,
    databases,
    assistant,
    manager,
    bridges,
    checks: () => checks,
    newAssistant,
  };
}

const record = (id: string, coverage = 'partial') =>
  JSON.stringify({
    format: 'health-record-v1',
    id,
    kind: 'document',
    payload: `Fictional document ${id}`,
    provenance: {
      capturedVia: 'Synthetic test upload',
      sourceSystem: null,
      sourceRecordId: id,
      evidenceClass: 'transcription',
      locator: `${id}.txt / supplied text`,
    },
    coverage: {
      status: coverage,
      notes: coverage === 'partial' ? ['Only this bounded pass was inspected'] : [],
    },
  });

type TestIntake = ReturnType<typeof uploadIntake>;
const propose = async (
  bridge: TestBridge,
  intake: TestIntake,
  jsonlText = record(intake.id),
  coverageKind: 'extracted' | 'inspected' = 'extracted',
) => {
  const dispatch = (tool: string, args: Record<string, unknown>) =>
    bridge.callbacks.onTool?.({
      tool,
      arguments: args,
      callId: `call-${tool}-${intake.id}`,
      threadId: 'thread-fixture',
      turnId: 'turn-1',
    } as unknown as Parameters<NonNullable<TestBridge['callbacks']['onTool']>>[0]);
  await dispatch('health_intake_read', { id: intake.id });
  const text = (await dispatch('health_intake_source_text', { id: intake.id })) as {
    revisionId?: string;
  };
  const current = getIntake(intake.db, intake.root, profileId, intake.id);
  const plan = current.workflow?.plans.find((plan) => plan.status === 'active');
  if (plan) {
    const unit = plan.units.find((unit) => unit.status === 'pending') ?? plan.units[0]!;
    await dispatch('health_intake_plan', { id: intake.id, action: 'read_unit', unitId: unit.id });
    return dispatch('health_intake_batch', {
      id: intake.id,
      version: getIntake(intake.db, intake.root, profileId, intake.id).version,
      planId: plan.id,
      operationId: `fictional-proposal-${intake.id}-${current.proposals.length}`,
      coverage: [
        {
          unitId: unit.id,
          kind: coverageKind,
          notes: 'The independently fictional dispatched source unit was read.',
        },
      ],
      sourceTextRevisionId: text?.revisionId,
      jsonlText,
      summary: 'Fictional bounded conversion pass',
    });
  }
  return dispatch('health_intake_propose', {
    id: intake.id,
    version: getIntake(intake.db, intake.root, profileId, intake.id).version,
    sourceTextRevisionId: text?.revisionId,
    jsonlText,
    summary: 'Fictional bounded conversion pass',
  });
};

const complete = (bridge: TestBridge) =>
  bridge.callbacks.onEvent?.('turn/completed', { turn: { status: 'completed' } });

test('queued time and preflight are visible by default and exclude time while the user pauses', async (t) => {
  let time = Date.parse('2026-01-01T00:00:00Z'),
    checks = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const diagnostics = createImportDiagnostics({ enabled: false, now: () => new Date(time) });
  t.after(() => {
    release();
    diagnostics.close();
  });
  const f = setup(
    t,
    {
      diagnostics,
      connectionCheck: async () => {
        checks++;
        await barrier;
        return { available: true, readiness: 'ready' };
      },
    },
    { diagnostics, clock: () => new Date(time) },
  );
  const first = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-first.txt',
    bytes: Buffer.from('Fictional first queue text'),
  });
  const second = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-second.txt',
    bytes: Buffer.from('Fictional second queue text'),
  });
  const batch = diagnostics.run(
    {
      profileId,
      operationId: 'browser-action',
      requestId: 'browser-request',
      spanId: 'browser-span',
    },
    () =>
      f.manager.create(profileId, {
        operationId: 'fictional-queue-metrics',
        intakeIds: [first.id, second.id],
      }),
  );
  await waitFor(() => checks === 1);
  const active = diagnostics.exportSnapshot(profileId).recentPerformance!.operations;
  assert.ok(active.some((operation) => operation.currentStage === 'model_preflight'));
  assert.ok(
    active
      .flatMap((operation) => operation.spans)
      .some((span) => span.phase === 'processing_queue' && span.durationMs === null),
  );
  assert.ok(
    active.every((operation) => !operation.context.operationId && !operation.context.requestId),
  );
  time += 700;
  f.manager.stop(profileId, batch.id);
  const stopped = diagnostics.exportSnapshot(profileId).recentPerformance!.operations;
  assert.ok(
    stopped
      .flatMap((operation) => operation.spans)
      .some((span) => span.phase === 'processing_queue' && span.fields.queuedWallMs === 700),
  );
  time += 60000;
  const resumed = f.manager.resume(profileId, batch.id);
  assert.equal(resumed.items[1].queuedAt, new Date(time).toISOString());
  time += 300;
  release();
  await waitFor(() => f.bridges.length === 1);
  await propose(f.bridges[0], first);
  complete(f.bridges[0]);
  await waitFor(() => f.bridges.length === 2);
  const spans = diagnostics
    .exportSnapshot(profileId)
    .recentPerformance!.operations.flatMap((operation) => operation.spans);
  assert.ok(
    spans.some((span) => span.phase === 'processing_queue' && span.fields.queuedWallMs === 300),
  );
  assert.ok(
    !spans.some(
      (span) => typeof span.fields.queuedWallMs === 'number' && span.fields.queuedWallMs >= 60000,
    ),
  );
});

test('two uploaded originals run sequentially into one durable review queue', async (t) => {
  const f = setup(t);
  const first = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-first.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('First fictional clinical letter'),
  });
  const second = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-second.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Second fictional clinical letter'),
  });
  first.db = second.db = f.db;
  first.root = second.root = f.root;
  const created = f.manager.create(profileId, {
    operationId: 'fictional-two-file-selection',
    intakeIds: [first.id, second.id],
  });
  assert.deepEqual(
    created.items.map((item) => item.sourceHash),
    [first.sha256, second.sha256],
  );
  assert.equal(
    f.manager.create(profileId, {
      operationId: 'fictional-two-file-selection',
      intakeIds: [first.id, second.id],
    }).id,
    created.id,
  );

  await waitFor(() => f.bridges.length === 1, 'first model pass');
  const firstChatId = f.manager.get(profileId, created.id).items[0].chatId;
  assert.ok(firstChatId);
  assert.deepEqual(f.assistant.get(profileId, firstChatId).context, {
    route: `#/import?intake=${encodeURIComponent(first.id)}`,
    intakeId: first.id,
  });
  assert.equal(f.manager.get(profileId, created.id).items[1].status, 'queued');
  await propose(f.bridges[0], first);
  complete(f.bridges[0]);
  await waitFor(() => f.bridges.length === 2, 'second model pass');
  assert.equal(f.manager.get(profileId, created.id).items[0].status, 'review_ready');
  await propose(f.bridges[1], second);
  complete(f.bridges[1]);
  const done = await waitFor(() => {
    const value = f.manager.get(profileId, created.id);
    return value.status === 'complete' && value;
  }, 'completed batch');
  assert.deepEqual(
    done.items.map(({ status, reason }) => ({ status, reason })),
    [
      { status: 'review_ready', reason: 'bounded_pass_ready' },
      { status: 'review_ready', reason: 'bounded_pass_ready' },
    ],
  );
  assert.equal(f.bridges.length, 2, 'only one model job ran at a time');
  assert.equal(f.checks(), 2);
});

test('restart does not treat cumulative capture steps as unread new work', async (t) => {
  const f = setup(t);
  const item = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-cumulative-steps.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional source for a completed model pass'),
  });
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-cumulative-steps',
    intakeIds: [item.id],
  });
  await waitFor(() => f.bridges.length === 1);
  await propose(f.bridges[0], item);
  complete(f.bridges[0]);
  await waitFor(() => {
    const value = f.manager.get(profileId, batch.id);
    return value.status === 'complete' && value;
  });
  f.manager.close();
  const completed = readIntakeBatch(f.root, profileId, batch.id);
  completed.items[0]!.sourceExtraction = {
    steps: 3,
    stepsAtModelPass: 3,
    spentMs: 0,
    allowanceId: 'fictional-allowance',
    stepsAtAllowance: 0,
    spentMsAtAllowance: 0,
    operationId: null,
    expectedRevisionId: null,
    startedAt: null,
    initialDone: true,
    draining: false,
  };
  completed.status = 'running';
  completed.automaticRun = true;
  completed.items[0]!.status = 'queued';
  completed.items[0]!.automaticRun = true;
  completed.items[0]!.reason = 'continuing';
  writeIntakeBatch(f.root, profileId, completed, 'fictional-restart-before-final-status');
  const restarted = createIntakeBatchManager({
    root: f.root,
    databases: f.databases,
    assistant: f.assistant,
    pollMs: 5,
  });
  t.after(() => restarted.close());
  restarted.wake(profileId);
  await waitFor(() => restarted.get(profileId, batch.id).status === 'complete');
  assert.equal(f.bridges.length, 1, 'the recorded pass already covered every capture step');
});

test('an active linked conversion is restarted under coordinator ownership after retaining its proposal', async (t) => {
  const f = setup(t);
  const first = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-active-linked.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional active linked conversion'),
  });
  const second = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-after-active.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional queued after active conversion'),
  });
  first.db = f.db;
  first.root = f.root;
  const chat = f.assistant.create(profileId, { title: 'Existing conversion' });
  linkIntakeConversion(f.db, f.root, profileId, first.id, chat.id);
  f.assistant.send(profileId, chat.id, {
    message: 'Convert the selected fictional delivery without accepting it.',
    context: { route: `/import?intake=${encodeURIComponent(first.id)}`, intakeId: first.id },
  });
  await waitFor(() => f.bridges.length === 1, 'existing linked model pass');
  await propose(f.bridges[0], first);

  const batch = f.manager.create(profileId, {
    operationId: 'fictional-attach-active',
    intakeIds: [first.id, second.id],
  });
  await waitFor(
    () => f.manager.get(profileId, batch.id).items[0].status === 'running',
    'batch attachment',
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    f.bridges.length,
    2,
    'the existing chat restarts with full coordinator authorization',
  );
  assert.equal(f.bridges[0].closed, true);
  assert.equal(f.manager.get(profileId, batch.id).items[1].status, 'queued');

  await propose(f.bridges[1], first);
  complete(f.bridges[1]);
  await waitFor(() => f.bridges.length === 3, 'next file after linked terminal pass');
  assert.equal(f.manager.get(profileId, batch.id).items[0].status, 'review_ready');
  f.manager.stop(profileId, batch.id);
});

test('a mismatched linked chat scope is never attached or retried', async (t) => {
  const f = setup(t);
  const first = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-scope-first.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional first scope'),
  });
  const second = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-scope-second.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional second scope'),
  });
  const unrelated = f.assistant.create(profileId, {
    title: 'Unrelated saved conversation',
    context: { route: `/import?intake=${encodeURIComponent(second.id)}`, intakeId: second.id },
  });
  linkIntakeConversion(f.db, f.root, profileId, first.id, unrelated.id);
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-scope-mismatch',
    intakeIds: [first.id, second.id],
  });
  await waitFor(
    () => f.manager.get(profileId, batch.id).items[1].status === 'running',
    'next valid item after mismatched link',
  );
  const state = f.manager.get(profileId, batch.id);
  assert.equal(state.items[0].status, 'paused');
  assert.equal(state.items[0].reason, 'conversion_scope_mismatch');
  assert.equal(f.assistant.get(profileId, unrelated.id).status, 'idle');
  assert.equal(f.bridges.length, 1);
  f.manager.stop(profileId, batch.id);
});

test('restart resumes a batch linked immediately before a simulated process crash', async (t) => {
  let crashed = false;
  let linkedJournalWritten = false;
  const f = setup(
    t,
    {},
    {
      journalWriter(root, savedProfileId, batch, reason) {
        if (crashed) throw new Error('Synthetic process exited after conversion-linked journal');
        writeIntakeBatch(root, savedProfileId, batch, reason);
        if (reason === 'conversion-linked') {
          linkedJournalWritten = true;
          crashed = true;
          throw new Error('Synthetic process exited before assistant.send');
        }
      },
    },
  );
  const original = Buffer.from('Fictional original retained across linked-chat crash');
  const intake = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-link-crash.txt',
    newProviderName: 'Fictional clinic',
    bytes: original,
  });
  intake.db = f.db;
  intake.root = f.root;
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-conversion-linked-crash',
    intakeIds: [intake.id],
  });
  await waitFor(() => linkedJournalWritten, 'durable conversion-linked crash boundary');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.bridges.length, 0, 'the model was not started before the simulated exit');
  assert.throws(() => f.manager.close(), /Synthetic process exited/);
  // This fixture represents a dead process: further cleanup cannot call its writer.
  f.manager.close = () => {};
  assert.deepEqual(getIntakeOriginal(f.db, f.root, profileId, intake.id).bytes, original);

  f.assistant.close();
  const restartedAssistant = f.newAssistant();
  const restarted = createIntakeBatchManager({
    root: f.root,
    databases: f.databases,
    assistant: restartedAssistant,
    pollMs: 5,
  });
  t.after(() => {
    restarted.close();
    restartedAssistant.close();
  });
  const interrupted = restarted.get(profileId, batch.id);
  assert.equal(interrupted.status, 'running');
  assert.equal(interrupted.reason, null);
  const chatId = interrupted.items[0].chatId;
  assert.ok(chatId);
  const restartedChat = restartedAssistant.get(profileId, chatId);
  assert.ok(restartedChat);
  assert.ok(restartedChat.context);
  assert.equal(restartedChat.context.intakeId, intake.id);

  await waitFor(() => f.bridges.length === 1, 'single resumed model pass');
  assert.equal(restarted.get(profileId, batch.id).items[0].chatId, chatId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.bridges.length, 1, 'restart did not create or start a second chat');
  await propose(f.bridges[0], intake);
  complete(f.bridges[0]);
  await waitFor(() => restarted.get(profileId, batch.id).status === 'complete', 'recovered batch');
  assert.equal(f.bridges.length, 1);
  assert.deepEqual(getIntakeOriginal(f.db, f.root, profileId, intake.id).bytes, original);
});

test('Stop, reload, and explicit resume retry only the linked cancelled conversion', async (t) => {
  const f = setup(t);
  const first = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-stopped.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional stopped pass'),
  });
  const second = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-after-stop.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional queued pass'),
  });
  first.db = second.db = f.db;
  first.root = second.root = f.root;
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-stop-reload',
    intakeIds: [first.id, second.id],
  });
  await waitFor(() => f.bridges.length === 1, 'running conversion before Stop');
  const chatId = f.manager.get(profileId, batch.id).items[0].chatId;
  assert.ok(chatId);
  f.manager.stop(profileId, batch.id);
  assert.equal(f.assistant.get(profileId, chatId).status, 'cancelled');
  f.manager.close();

  const reloaded = createIntakeBatchManager({
    root: f.root,
    databases: f.databases,
    assistant: f.assistant,
    pollMs: 5,
  });
  t.after(() => reloaded.close());
  assert.equal(reloaded.get(profileId, batch.id).status, 'stopped');
  reloaded.resume(profileId, batch.id);
  await waitFor(() => f.bridges.length === 2, 'retried linked conversion');
  assert.equal(reloaded.get(profileId, batch.id).items[0].chatId, chatId);
  await propose(f.bridges[1], first);
  complete(f.bridges[1]);
  await waitFor(() => f.bridges.length === 3, 'next queued conversion');
  await propose(f.bridges[2], second);
  complete(f.bridges[2]);
  await waitFor(() => reloaded.get(profileId, batch.id).status === 'complete', 'resumed batch');
  assert.deepEqual(
    reloaded.get(profileId, batch.id).items.map((item) => item.status),
    ['review_ready', 'review_ready'],
  );
});

test('reprocessing one stopped original leaves its sibling stopped and replays once', async (t) => {
  const f = setup(t);
  const first = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-stop-first.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional first source for Stop.'),
  });
  const second = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-stop-second.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional second source for Stop.'),
  });
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-stop-both',
    intakeIds: [first.id, second.id],
  });
  await waitFor(() => f.bridges.length > 0, 'first original starts');
  f.manager.stop(profileId, batch.id);
  const stopped = f.manager.get(profileId, batch.id);
  assert.equal(stopped.items[0]!.reason, 'stopped');
  assert.equal(stopped.items[1]!.reason, 'stopped');
  const selected = f.manager.create(profileId, {
    operationId: 'fictional-reprocess-second-only',
    intakeIds: [second.id],
  });
  assert.equal(selected.scheduled, true);
  assert.equal(
    f.manager.create(profileId, {
      operationId: 'fictional-reprocess-second-only',
      intakeIds: [second.id],
    }).scheduled,
    false,
  );
  await waitFor(
    () => f.manager.get(profileId, batch.id).items[1]!.status === 'running',
    'selected original resumes',
  );
  assert.equal(f.manager.get(profileId, batch.id).items[0]!.reason, 'stopped');
  f.manager.stop(profileId, batch.id);
});

test('Stop or resume on an old batch cannot invalidate the current batch runner', async (t) => {
  const f = setup(t);
  const oldIntake = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-old-batch.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional old batch source'),
  });
  const currentIntake = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-current-batch.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional current batch source'),
  });
  currentIntake.db = f.db;
  currentIntake.root = f.root;
  const oldBatch = f.manager.create(profileId, {
    operationId: 'fictional-old-batch-operation',
    intakeIds: [oldIntake.id],
  });
  await waitFor(() => f.bridges.length === 1, 'old batch runner');
  f.manager.stop(profileId, oldBatch.id);
  const currentBatch = f.manager.create(profileId, {
    operationId: 'fictional-current-batch-operation',
    intakeIds: [currentIntake.id],
  });
  await waitFor(() => f.bridges.length === 2, 'current batch runner');
  const currentChatId = f.manager.get(profileId, currentBatch.id).items[0].chatId;
  assert.ok(currentChatId);

  assert.throws(
    () => f.manager.resume(profileId, oldBatch.id),
    (error: unknown) => error instanceof HttpError && error.code === 'INTAKE_BATCH_BUSY',
  );
  assert.equal(f.manager.stop(profileId, oldBatch.id).status, 'stopped');
  assert.equal(f.assistant.get(profileId, currentChatId).status, 'running');
  assert.equal(f.manager.get(profileId, currentBatch.id).status, 'running');

  await propose(f.bridges[1], currentIntake);
  complete(f.bridges[1]);
  await waitFor(
    () => f.manager.get(profileId, currentBatch.id).status === 'complete',
    'current runner after old batch controls',
  );
  assert.equal(f.manager.get(profileId, currentBatch.id).items[0].status, 'review_ready');
});

test('prepared JSONL and an existing partial proposal skip model work without completeness claims', async (t) => {
  const f = setup(t);
  const prepared = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-prepared.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(record('prepared-fixture', 'complete_response')),
  });
  const partial = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-partial.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional original with unread remainder'),
  });
  await extractIntakeSourceText({
    db: f.db,
    root: f.root,
    profileId,
    id: partial.id,
  });
  const proposedPartial = (await import('../intake.ts')).proposeConversion(
    f.db,
    f.root,
    profileId,
    partial.id,
    {
      version: getIntake(f.db, f.root, profileId, partial.id).version,
      jsonlText: record('partial-fixture'),
      summary: 'One bounded section only; unread remainder retained',
    },
  );
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-ready-skips',
    intakeIds: [prepared.id, proposedPartial.id],
  });
  const done = await waitFor(() => {
    const value = f.manager.get(profileId, batch.id);
    return value.status === 'complete' && value;
  }, 'skipped-model batch');
  assert.equal(f.bridges.length, 0);
  assert.deepEqual(
    done.items.map(({ status, reason, reading }) => ({ status, reason, reading })),
    [
      { status: 'review_ready', reason: 'prepared_jsonl', reading: null },
      { status: 'review_ready', reason: 'already_reviewable', reading: null },
    ],
  );
});

test('a busy reprocess leaves stopped review-ready items unchanged', async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = setup(t, {
    connectionCheck: async () => {
      await blocked;
      return { available: true, readiness: 'ready' };
    },
  });
  const first = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-stopped-ready.jsonl',
    bytes: Buffer.from(record('fictional-stopped-ready', 'complete_response')),
  });
  const second = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-competing.txt',
    bytes: Buffer.from('Fictional competing source'),
  });
  const old = f.manager.create(profileId, {
    operationId: 'fictional-stopped-ready-batch',
    intakeIds: [first.id],
  });
  await waitFor(() => f.manager.get(profileId, old.id).status === 'complete');
  f.manager.stop(profileId, old.id);
  transaction(f.db, () => {
    writeIntakeSourcePin(f.db, first.id, {
      revisionId: 'fictional-new-source',
      dependencyToken: 'fictional-new-source',
      requiresInterpretation: true,
      version: 1,
    });
  });
  const competing = f.manager.create(profileId, {
    operationId: 'fictional-competing-batch',
    intakeIds: [second.id],
  });
  await waitFor(() => f.manager.get(profileId, competing.id).status === 'running');
  const before = f.manager.get(profileId, old.id);
  assert.throws(
    () =>
      f.manager.create(profileId, {
        operationId: 'fictional-reopen-while-busy',
        intakeIds: [first.id],
      }),
    { code: 'INTAKE_BATCH_BUSY' },
  );
  assert.deepEqual(f.manager.get(profileId, old.id), before);
  release();
});

test('corrected completed work cannot displace a different running batch or claim cross-batch selection', async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = setup(t, {
    connectionCheck: async () => {
      await blocked;
      return { available: true, readiness: 'ready' };
    },
  });
  const first = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-ready-first.jsonl',
    bytes: Buffer.from(record('fictional-ready-first', 'complete_response')),
  });
  const second = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-ready-second.jsonl',
    bytes: Buffer.from(record('fictional-ready-second', 'complete_response')),
  });
  const firstBatch = f.manager.create(profileId, {
    operationId: 'fictional-ready-first-run',
    intakeIds: [first.id],
  });
  await waitFor(() => f.manager.get(profileId, firstBatch.id).status === 'complete');
  const secondBatch = f.manager.create(profileId, {
    operationId: 'fictional-ready-second-run',
    intakeIds: [second.id],
  });
  await waitFor(() => f.manager.get(profileId, secondBatch.id).status === 'complete');
  for (const source of [first, second])
    transaction(f.db, () => {
      writeIntakeSourcePin(f.db, source.id, {
        revisionId: 'fictional-material-change',
        dependencyToken: 'fictional-material-change',
        requiresInterpretation: true,
        version: 1,
      });
    });
  assert.throws(
    () =>
      f.manager.create(profileId, {
        operationId: 'fictional-cross-batch-requeue',
        intakeIds: [first.id, second.id],
      }),
    { code: 'INTAKE_BATCH_SELECTION' },
  );
  assert.equal(f.manager.get(profileId, firstBatch.id).status, 'complete');
  assert.equal(f.manager.get(profileId, secondBatch.id).status, 'complete');
  const competing = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-competing.txt',
    bytes: Buffer.from('Fictional competing source'),
  });
  const competingBatch = f.manager.create(profileId, {
    operationId: 'fictional-competing-run',
    intakeIds: [competing.id],
  });
  await waitFor(() => f.manager.get(profileId, competingBatch.id).status === 'running');
  assert.throws(
    () =>
      f.manager.create(profileId, { operationId: 'fictional-busy-requeue', intakeIds: [first.id] }),
    { code: 'INTAKE_BATCH_BUSY' },
  );
  assert.equal(f.manager.get(profileId, competingBatch.id).status, 'running');
  release();
  await waitFor(() => f.bridges.length === 1);
});

test('a corrected earlier file cannot displace an in-flight sibling in its retained batch', async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = setup(t, {
    connectionCheck: async () => {
      await blocked;
      return { available: true, readiness: 'ready' };
    },
  });
  const first = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-ready-first.jsonl',
    bytes: Buffer.from(record('fictional-ready-first', 'complete_response')),
  });
  const second = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-inflight-second.txt',
    bytes: Buffer.from('Fictional second source waits for its model'),
  });
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-same-batch-start',
    intakeIds: [first.id, second.id],
  });
  await waitFor(() => {
    const current = f.manager.get(profileId, batch.id);
    return current.items[0]?.status === 'review_ready' && current.items[1]?.status === 'starting';
  }, 'second source preflight');
  transaction(f.db, () => {
    writeIntakeSourcePin(f.db, first.id, {
      revisionId: 'fictional-corrected-first',
      dependencyToken: 'fictional-corrected-first',
      requiresInterpretation: true,
      version: 1,
    });
  });
  const before = f.manager.get(profileId, batch.id);
  assert.throws(
    () =>
      f.manager.create(profileId, {
        operationId: 'fictional-same-batch-reprocess',
        intakeIds: [first.id],
      }),
    { code: 'INTAKE_BATCH_BUSY' },
  );
  assert.deepEqual(f.manager.get(profileId, batch.id), before);
  assert.equal(
    f.manager.create(profileId, {
      operationId: batch.operationId,
      intakeIds: [first.id, second.id],
    }).scheduled,
    false,
    'the original operation still replays exactly',
  );
  release();
  await waitFor(() => f.bridges.length === 1, 'sibling model pass');
});

test('a retained partial proposal survives a failed pass and the next original still starts', async (t) => {
  const f = setup(t);
  const first = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-partial-error.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional partial then provider error'),
  });
  const second = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-after-error.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional next file'),
  });
  first.db = second.db = f.db;
  first.root = second.root = f.root;
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-partial-error',
    intakeIds: [first.id, second.id],
  });
  await waitFor(() => f.bridges.length === 1, 'first pass');
  await propose(f.bridges[0], first);
  f.bridges[0].callbacks.onExit?.(new Error('Synthetic file-specific conversion failure'));
  await waitFor(() => f.bridges.length === 2, 'second pass after retained partial error');
  const retained = f.manager.get(profileId, batch.id).items[0];
  assert.equal(retained.status, 'review_ready');
  assert.equal(retained.reason, 'bounded_pass_ready');
  assert.equal(retained.proposalIds.length, 1);
  assert.equal(getIntake(f.db, f.root, profileId, first.id).proposals.length, 1);
  await propose(f.bridges[1], second);
  complete(f.bridges[1]);
  await waitFor(() => f.manager.get(profileId, batch.id).status === 'complete', 'complete batch');
});

test('an unknown provider result waits while the next file can run and proposals remain reviewable', async (t) => {
  const f = setup(t);
  const first = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-proxy-timeout.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional partial before proxy timeout'),
  });
  const second = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-waits-for-resume.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional queued while provider unavailable'),
  });
  first.db = f.db;
  first.root = f.root;
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-proxy-timeout',
    intakeIds: [first.id, second.id],
  });
  await waitFor(() => f.bridges.length === 1, 'partial provider pass');
  await propose(f.bridges[0], first);
  f.bridges[0].callbacks.onEvent?.('model/requestStarted', {
    requestId: 'fictional-lost',
    model: 'fictional',
    attempt: 1,
    requestDigest: 'a'.repeat(64),
    requestBytes: 1,
  });
  f.bridges[0].callbacks.onEvent?.('model/requestFinished', {
    requestId: 'fictional-lost',
    failed: true,
    outcome: 'unknown',
  });
  f.bridges[0].callbacks.onExit?.(new Error('Synthetic LiteLLM proxy timeout'));
  const paused = await waitFor(() => {
    const value = f.manager.get(profileId, batch.id);
    return value.items[0].reason === 'waiting_for_provider' && value;
  }, 'whole-batch provider pause');
  await waitFor(() => f.bridges.length === 2);
  assert.equal(paused.status, 'running');
  assert.equal(paused.items[0].status, 'queued');
  assert.equal(paused.items[0].providerWait?.outcome, 'unknown');
  assert.equal(paused.items[0].proposalIds.length, 1);
});

test('explicit resume continues a partial review-ready source after recreating the batch manager', async (t) => {
  const f = setup(t);
  const original = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-partial-resume.txt',
    bytes: Buffer.from('Fictional first section and a second section not read yet'),
  });
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-partial-resume',
    intakeIds: [original.id],
  });
  await waitFor(() => f.bridges.length === 1);
  await propose(f.bridges[0], original, record('fictional-first-section'), 'inspected');
  complete(f.bridges[0]);
  await waitFor(() => f.bridges.length === 2, 'partial proposal continues reading');
  complete(f.bridges[1]);
  await waitFor(() => f.bridges.length === 3, 'one bounded coverage reconciliation');
  complete(f.bridges[2]);
  for (let attempt = 1; attempt <= 6; attempt++) {
    await waitFor(
      () => f.bridges.length === attempt + 3 && f.bridges[attempt + 2].started,
      'unfinished unit continues reading',
    );
    const bridge = f.bridges[attempt + 2];
    for (let request = 0; request < DEFAULT_INTAKE_READING_LIMITS.requests!; request++) {
      const requestId = `fictional-no-progress-${attempt}-${request}`;
      bridge.callbacks.onEvent?.('model/requestStarted', {
        requestId,
        model: 'fictional',
        attempt: 1,
        requestDigest: 'b'.repeat(64),
        requestBytes: 1,
      });
      bridge.callbacks.onEvent?.('model/requestFinished', {
        requestId,
        failed: false,
        outcome: 'response',
      });
    }
    await waitFor(
      () =>
        f.manager.get(profileId, batch.id).items[0].reading?.usableModelResponses ===
        attempt * DEFAULT_INTAKE_READING_LIMITS.requests!,
      'all completed no-progress responses are accounted',
    );
    complete(bridge);
  }
  await waitFor(() => f.manager.get(profileId, batch.id).status === 'complete');
  assert.equal(f.manager.get(profileId, batch.id).items[0].status, 'review_ready');
  assert.equal(f.manager.get(profileId, batch.id).items[0].reason, 'processing_stalled');
  assert.equal(f.manager.get(profileId, batch.id).items[0].stalls?.attempts, 3);
  assert.equal(
    f.manager.get(profileId, batch.id).items[0].reading?.usableModelResponses,
    6 * DEFAULT_INTAKE_READING_LIMITS.requests!,
    'three source-unit stall attempts retain all six completed request windows',
  );
  assert.equal(f.manager.get(profileId, batch.id).items[0].readingJob?.extensions, 3);
  const retainedProposal = getIntake(f.db, f.root, profileId, original.id).proposals[0].id;
  f.manager.close();
  const restarted = createIntakeBatchManager({
    root: f.root,
    databases: f.databases,
    assistant: f.assistant,
    pollMs: 5,
  });
  t.after(() => restarted.close());
  assert.equal(f.bridges.length, 9, 'recreation alone does not restart model work');
  restarted.resume(profileId, batch.id);
  await waitFor(() => f.bridges.length === 10, 'explicit resume starts another linked pass');
  await propose(f.bridges[9], original, record('fictional-second-section'));
  complete(f.bridges[9]);
  await waitFor(() => restarted.get(profileId, batch.id).status === 'complete');
  const after = getIntake(f.db, f.root, profileId, original.id);
  assert.equal(after.proposals.length, 2);
  assert.equal(after.proposals[0].id, retainedProposal);
  assert.equal(after.imported, null, 'resuming reading cannot accept either proposal');
  assert.equal(
    getIntakeOriginal(f.db, f.root, profileId, original.id).bytes.toString(),
    'Fictional first section and a second section not read yet',
  );
});

test('the last file automatically retries an unknown result and retains its partial proposal', async (t) => {
  const f = setup(t, {}, { providerRetryBaseMs: 20 });
  const original = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-final-timeout.txt',
    bytes: Buffer.from('Fictional partial provider response'),
  });
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-final-timeout',
    intakeIds: [original.id],
  });
  await waitFor(() => f.bridges.length === 1);
  await propose(f.bridges[0], original);
  f.bridges[0].callbacks.onEvent?.('model/requestStarted', {
    requestId: 'fictional-lost-last',
    model: 'fictional',
    attempt: 1,
    requestDigest: 'a'.repeat(64),
    requestBytes: 1,
  });
  f.bridges[0].callbacks.onEvent?.('model/requestFinished', {
    requestId: 'fictional-lost-last',
    failed: true,
    outcome: 'unknown',
  });
  f.bridges[0].callbacks.onExit?.(new Error('Synthetic LiteLLM proxy timeout'));

  await waitFor(
    () => f.bridges.length === 2,
    'last partial file retries instead of rejecting resume',
  );
  assert.equal(getIntake(f.db, f.root, profileId, original.id).proposals.length, 1);
  f.manager.stop(profileId, batch.id);
});

test('unavailable model preflight recovers without Resume when its prerequisite changes', async (t) => {
  let checks = 0,
    available = false;
  const f = setup(
    t,
    {
      connectionCheck: async () => {
        checks++;
        return { available, readiness: available ? 'ready' : 'unavailable' };
      },
    },
    { providerRetryBaseMs: 20 },
  );
  const source = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-prerequisite.txt',
    bytes: Buffer.from('fictional prerequisite'),
  });
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-preflight',
    intakeIds: [source.id],
  });
  await waitFor(() => checks >= 2);
  assert.equal(f.manager.get(profileId, batch.id).status, 'running');
  assert.equal(f.bridges.length, 0);
  available = true;
  await waitFor(() => f.bridges.length === 1);
  f.manager.stop(profileId, batch.id);
});

test('profile lock during preflight persists a pause and generation-guards the late result', async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checks = 0;
  const f = setup(t, {
    connectionCheck: async () => {
      checks++;
      await blocked;
      return { available: true, readiness: 'ready' };
    },
  });
  const intake = uploadIntake(f.db, f.root, profileId, {
    filename: 'fictional-lock-race.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional lock race'),
  });
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-profile-lock',
    intakeIds: [intake.id],
  });
  await waitFor(() => checks === 1, 'blocked preflight');
  f.manager.close('profile_locked');
  release();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.bridges.length, 0, 'late preflight cannot start a model job after lock');

  const reloaded = createIntakeBatchManager({
    root: f.root,
    databases: f.databases,
    assistant: f.assistant,
    pollMs: 5,
  });
  t.after(() => reloaded.close());
  const paused = reloaded.get(profileId, batch.id);
  assert.equal(paused.status, 'running');
  assert.equal(paused.reason, null);
  assert.equal(paused.items[0].status, 'queued');
  await waitFor(() => f.bridges.length === 1, 'unlock automatically restarts the authorized pass');
  reloaded.close();
});

test('profile-scoped HTTP routes create, read, stop, and resume the durable queue', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'health-intake-batch-http-'));
  const db = openDatabase(profilePaths(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional-http-batch.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional HTTP batch original'),
  });
  const app = createApp({
    root,
    databases: new Map([[profileId, db]]),
    intakeBatchOptions: { pollMs: 5 },
    assistantOptions: {
      availability: () => ({ available: true, readiness: 'ready' }),
      connectionCheck: async () => ({
        available: false,
        readiness: 'unavailable',
        message: 'Synthetic provider unavailable',
      }),
    },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:5173';
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/${profileId}/intake-batches`;
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const createdResponse = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operationId: 'fictional-http-operation', intakeIds: [intake.id] }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).data;
  assert.equal(created.profileId, profileId);
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/${created.id}`)).status, 200);
  const stopped = await fetch(`${base}/${created.id}/stop`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).data.status, 'stopped');
  const resumed = await fetch(`${base}/${created.id}/resume`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).data.status, 'running');
});

function fictionalAppendOriginal(f: ReturnType<typeof setup>, suffix: string) {
  return uploadIntake(f.db, f.root, profileId, {
    filename: `fictional-append-${suffix}.txt`,
    bytes: Buffer.from(`Fictional appended original ${suffix}`),
  });
}

test('explicit append while preflight is in flight preserves the durable queue and each exact operation selection', async (t) => {
  let release!: () => void,
    checks = 0;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = setup(t, {
    connectionCheck: async () => {
      checks++;
      await barrier;
      return { available: true, readiness: 'ready' };
    },
  });
  const first = fictionalAppendOriginal(f, 'first'),
    second = fictionalAppendOriginal(f, 'second');
  const original = { operationId: 'fictional-initial-selection', intakeIds: [first.id] };
  const batch = f.manager.create(profileId, original);
  await waitFor(() => checks === 1, 'in-flight preflight');
  assert.throws(
    () =>
      f.manager.create(profileId, { operationId: 'fictional-legacy-busy', intakeIds: [second.id] }),
    { code: 'INTAKE_BATCH_BUSY' },
  );
  const request = {
    operationId: 'fictional-appended-selection',
    intakeIds: [second.id],
    appendToRunning: true,
  };
  const added = f.manager.create(profileId, request);
  assert.equal(added.id, batch.id);
  assert.deepEqual(
    added.items.map((item) => item.intakeId),
    [first.id, second.id],
  );
  assert.equal(added.appendOperations?.[0]?.operationId, request.operationId);
  assert.equal(
    f.manager.create(profileId, original).items.length,
    2,
    'initial operation still replays its original selection after append',
  );
  assert.equal(f.manager.create(profileId, request).items.length, 2);
  assert.throws(() => f.manager.create(profileId, { ...request, intakeIds: [first.id] }), {
    code: 'INTAKE_BATCH_OPERATION',
  });
  assert.equal(
    f.manager.create(profileId, { ...request, operationId: 'fictional-duplicate-original' }).id,
    batch.id,
    'older client enqueue reconciles the retained original',
  );
  assert.throws(() => f.manager.create('other-profile', request));
  assert.throws(
    () =>
      f.manager.create(profileId, {
        ...request,
        operationId: 'fictional-too-many',
        intakeIds: Array.from({ length: 100 }, (_, i) => `intake:fictional-${i}`),
      }),
    /not found/i,
  );
  assert.deepEqual(
    readIntakeBatch(f.root, profileId, batch.id).items.map((item) => item.intakeId),
    [first.id, second.id],
  );
  release();
  await waitFor(() => f.bridges.length === 1);
  assert.equal(
    f.manager.get(profileId, batch.id).items.length,
    2,
    'runner save after await retained appended work',
  );
  await propose(f.bridges[0], first);
  complete(f.bridges[0]);
  await waitFor(() => f.bridges.length === 2, 'appended original starts once');
  await propose(f.bridges[1], second);
  complete(f.bridges[1]);
  await waitFor(() => f.manager.get(profileId, batch.id).status === 'complete');
  assert.equal(f.bridges.length, 2);
  assert.equal(
    f.manager.create(profileId, request).id,
    batch.id,
    'completed receipt replay never starts another batch',
  );
});

test('append journal acknowledgement loss retains one append and retry never duplicates its model job', async (t) => {
  let loseAcknowledgement = true;
  const f = setup(
    t,
    {},
    {
      journalWriter(root, id, batch, reason) {
        writeIntakeBatch(root, id, batch, reason);
        if (reason === 'originals-appended' && loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error('Fictional acknowledgement loss');
        }
      },
    },
  );
  let requestGuard: NonNullable<Parameters<typeof f.assistant.send>[3]>['beforeModelRequest'];
  const send = f.assistant.send.bind(f.assistant);
  f.assistant.send = (...args) => {
    requestGuard = args[3]?.beforeModelRequest;
    return send(...args);
  };
  const first = fictionalAppendOriginal(f, 'uncertain-first'),
    second = fictionalAppendOriginal(f, 'uncertain-second');
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-uncertain-initial',
    intakeIds: [first.id],
  });
  await waitFor(() => f.bridges.length === 1);
  const request = {
    operationId: 'fictional-uncertain-append',
    intakeIds: [second.id],
    appendToRunning: true,
  };
  assert.throws(() => f.manager.create(profileId, request), /acknowledgement loss/);
  assert.equal(readIntakeBatch(f.root, profileId, batch.id).items.length, 2);
  assert.ok(requestGuard);
  assert.throws(
    () =>
      requestGuard!({
        status: 'running',
        reason: null,
        turns: 0,
        readyRecords: 0,
        remainingUnits: 1,
        pendingReadWindows: 1,
        coverage: 'reading_progress_only',
      }),
    /authorization ended/,
  );
  assert.equal(
    f.manager.get(profileId, batch.id).items.length,
    2,
    'active runner cannot overwrite the published append',
  );
  assert.equal(f.manager.create(profileId, request).items.length, 2);
  await propose(f.bridges[0], first);
  complete(f.bridges[0]);
  await waitFor(() => f.bridges.length === 2);
  await propose(f.bridges[1], second);
  complete(f.bridges[1]);
  await waitFor(() => f.manager.get(profileId, batch.id).status === 'complete');
  assert.equal(f.bridges.length, 2);
  assert.equal(f.manager.get(profileId, batch.id).appendOperations?.length, 1);
});

test('an append rejected before journal publication leaves the running queue unchanged and can be retried', async (t) => {
  let rejectWrite = true;
  const f = setup(
    t,
    {},
    {
      journalWriter(root, id, batch, reason) {
        if (reason === 'originals-appended' && rejectWrite) {
          rejectWrite = false;
          throw new Error('Fictional pre-publication failure');
        }
        writeIntakeBatch(root, id, batch, reason);
      },
    },
  );
  const first = fictionalAppendOriginal(f, 'failed-first'),
    second = fictionalAppendOriginal(f, 'failed-second');
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-failed-initial',
    intakeIds: [first.id],
  });
  const request = {
    operationId: 'fictional-failed-append',
    intakeIds: [second.id],
    appendToRunning: true,
  };
  assert.throws(() => f.manager.create(profileId, request), /pre-publication failure/);
  assert.equal(f.manager.get(profileId, batch.id).items.length, 1);
  assert.equal(readIntakeBatch(f.root, profileId, batch.id).items.length, 1);
  assert.equal(f.manager.create(profileId, request).items.length, 2);
});

test('appended selections survive restart and operation replay while automatic work resumes', async (t) => {
  const f = setup(t);
  const first = fictionalAppendOriginal(f, 'restart-first'),
    second = fictionalAppendOriginal(f, 'restart-second');
  const original = {
    operationId: 'fictional-restart-initial',
    intakeIds: [first.id],
    appendToRunning: true,
  };
  const batch = f.manager.create(profileId, original);
  await waitFor(() => f.bridges.length === 1);
  const request = {
    operationId: 'fictional-restart-append',
    intakeIds: [second.id],
    appendToRunning: true,
  };
  f.manager.create(profileId, request);
  f.manager.close();
  const reloaded = createIntakeBatchManager({
    root: f.root,
    databases: f.databases,
    assistant: f.assistant,
    pollMs: 5,
  });
  t.after(() => reloaded.close());
  assert.equal(reloaded.create(profileId, request).status, 'running');
  assert.equal(reloaded.create(profileId, original).items.length, 2);
  assert.deepEqual(reloaded.get(profileId, batch.id).appendOperations?.[0]?.intakeIds, [second.id]);
  assert.equal(f.bridges.length, 1);
  reloaded.resume(profileId, batch.id);
  await waitFor(() => f.bridges.length === 2);
  await propose(f.bridges[1], first);
  complete(f.bridges[1]);
  await waitFor(() => f.bridges.length === 3);
  await propose(f.bridges[2], second);
  complete(f.bridges[2]);
  await waitFor(() => reloaded.get(profileId, batch.id).status === 'complete');
  assert.equal(reloaded.get(profileId, batch.id).items.length, 2);
  const backup = await createBackup(f.db, f.root, profileId);
  const restoredRoot = resolve(f.root, 'fictional-rebuilt');
  const rebuilt = rebuildProfile(resolve(backup.path, 'files'), profileId, restoredRoot);
  const restoredDb = openDatabase(rebuilt.database, profileId);
  attachPersonalDurability(restoredDb, { root: restoredRoot, profileId });
  const restored = createIntakeBatchManager({
    root: restoredRoot,
    databases: new Map([[profileId, restoredDb]]),
    assistant: f.assistant,
  });
  try {
    assert.deepEqual(
      restored.create(profileId, request).appendOperations,
      reloaded.get(profileId, batch.id).appendOperations,
    );
    assert.deepEqual(
      restored.create(profileId, original).items.map((item) => item.intakeId),
      [first.id, second.id],
    );
    assert.deepEqual(
      getIntakeOriginal(restoredDb, restoredRoot, profileId, second.id).bytes,
      Buffer.from('Fictional appended original restart-second'),
    );
  } finally {
    restored.close();
    restoredDb.close();
  }
});

test('a failed Stop restores the durable running state and retries the stop with matching queue timestamps', (t) => {
  let rejectStop = true;
  const f = setup(
    t,
    {},
    {
      journalWriter(root, id, batch, reason) {
        if (reason === 'stopped' && rejectStop) {
          rejectStop = false;
          throw new Error('Fictional stop publication failure');
        }
        writeIntakeBatch(root, id, batch, reason);
      },
    },
  );
  const first = fictionalAppendOriginal(f, 'stop-failure-first');
  const second = fictionalAppendOriginal(f, 'stop-failure-second');
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-stop-failure',
    intakeIds: [first.id, second.id],
  });
  assert.ok(batch.items.every((item) => item.queuedAt));
  assert.throws(() => f.manager.stop(profileId, batch.id), /stop publication failure/);
  const retained = readIntakeBatch(f.root, profileId, batch.id);
  assert.equal(retained.status, 'running');
  assert.ok(retained.items.every((item) => item.queuedAt));
  const stopped = f.manager.stop(profileId, batch.id);
  assert.equal(stopped.status, 'stopped');
  assert.ok(stopped.items.every((item) => item.queuedAt === null));
  assert.deepEqual(
    JSON.parse(JSON.stringify(readIntakeBatch(f.root, profileId, batch.id))),
    stopped,
  );
  f.manager.close();
  const reopened = createIntakeBatchManager({
    root: f.root,
    databases: f.databases,
    assistant: f.assistant,
  });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.get(profileId, batch.id), stopped);
});

test('a published Stop with failed acknowledgement cannot return success until its writer retries', (t) => {
  let rejectAcknowledgement = false;
  let attempts = 0;
  const f = setup(
    t,
    {},
    {
      journalWriter(root, id, batch, reason) {
        writeIntakeBatch(root, id, batch, reason);
        if (reason === 'stopped') {
          attempts++;
          if (rejectAcknowledgement) throw new Error('Fictional encrypted publication failure');
        }
      },
    },
  );
  const intake = fictionalAppendOriginal(f, 'stop-acknowledgement');
  const request = { operationId: 'fictional-stop-acknowledgement', intakeIds: [intake.id] };
  const batch = f.manager.create(profileId, request);
  rejectAcknowledgement = true;
  assert.throws(() => f.manager.stop(profileId, batch.id), /encrypted publication failure/);
  assert.equal(readIntakeBatch(f.root, profileId, batch.id).status, 'stopped');
  assert.throws(() => f.manager.stop(profileId, batch.id), /encrypted publication failure/);
  assert.throws(() => f.manager.create(profileId, request), /encrypted publication failure/);
  assert.throws(() => f.manager.get(profileId, batch.id), /encrypted publication failure/);
  assert.equal(attempts, 4);
  rejectAcknowledgement = false;
  assert.equal(f.manager.stop(profileId, batch.id).status, 'stopped');
  assert.equal(attempts, 5, 'idempotent Stop retries acknowledgement before returning');
  assert.equal(f.manager.create(profileId, request).scheduled, false);
});

test('application close reports a queue publication failure after closing assistant, server, and every database', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'health-batch-close-failure-'));
  const db = openDatabase(profilePaths(root, profileId).database, profileId);
  const otherDb = openDatabase(profilePaths(root, 'other-person').database, 'other-person');
  attachPersonalDurability(db, { root, profileId });
  const failure = Error('Fictional close publication failure');
  const app = createApp({
    root,
    databases: new Map([
      [profileId, db],
      ['other-person', otherDb],
    ]),
    intakeBatchOptions: {
      journalWriter(root, id, batch, reason) {
        if (reason === 'runner-closed') throw failure;
        writeIntakeBatch(root, id, batch, reason);
      },
    },
  });
  t.after(() => {
    if (db.isOpen || otherDb.isOpen) {
      try {
        app.close();
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional-close-failure.txt',
    bytes: Buffer.from('Fictional close failure evidence'),
  });
  const batch = app.intakeBatches.create(profileId, {
    operationId: 'fictional-close-failure',
    intakeIds: [intake.id],
  });
  const retainedHandle = readIntakeBatch(root, profileId, batch.id);
  let assistantClosed = false;
  const closeAssistant = app.assistant.close.bind(app.assistant);
  app.assistant.close = () => {
    assistantClosed = true;
    closeAssistant();
  };
  assert.throws(
    () => app.close(),
    (error) => error === failure,
  );
  assert.equal(assistantClosed, true);
  assert.equal(app.server.listening, false);
  assert.equal(db.isOpen, false);
  assert.equal(otherDb.isOpen, false);
  assert.throws(() => {
    retainedHandle.reason = 'stale callback';
  }, /tracked intake batch/);
  assert.equal(
    readIntakeBatch(root, profileId, batch.id).status,
    'running',
    'failed close never acknowledges its unpublished pause',
  );
});

test('idempotent Stop and Resume reject a stale cached head before reporting success', (t) => {
  const f = setup(t);
  const intake = fictionalAppendOriginal(f, 'stale-idempotent');
  const batch = f.manager.create(profileId, {
    operationId: 'fictional-stale-idempotent',
    intakeIds: [intake.id],
  });
  f.manager.stop(profileId, batch.id);
  const external = readIntakeBatch(f.root, profileId, batch.id);
  external.status = 'running';
  external.automaticRun = true;
  external.reason = null;
  external.items[0]!.status = 'queued';
  external.items[0]!.automaticRun = true;
  writeIntakeBatch(f.root, profileId, external, 'fictional-external-resume');
  assert.throws(() => f.manager.stop(profileId, batch.id), { code: 'INTAKE_BATCH_STALE' });
  assert.equal(readIntakeBatch(f.root, profileId, batch.id).status, 'running');
  assert.equal(f.manager.stop(profileId, batch.id).status, 'stopped');
  f.manager.resume(profileId, batch.id);
  const stopped = readIntakeBatch(f.root, profileId, batch.id);
  stopped.status = 'stopped';
  stopped.automaticRun = false;
  stopped.reason = 'stopped';
  stopped.items[0]!.status = 'paused';
  stopped.items[0]!.reason = 'stopped';
  stopped.items[0]!.resumeAutomaticRun = true;
  stopped.items[0]!.automaticRun = false;
  writeIntakeBatch(f.root, profileId, stopped, 'fictional-external-stop');
  assert.throws(() => f.manager.resume(profileId, batch.id), { code: 'INTAKE_BATCH_STALE' });
  assert.equal(readIntakeBatch(f.root, profileId, batch.id).status, 'stopped');
  assert.equal(f.manager.resume(profileId, batch.id).status, 'running');
});

test('automatic coordinator dispatches a selected native direct plan with explicit proposal state and scalar reading checkpoint', async (t) => {
  const f = setup(t),
    source = uploadIntake(f.db, f.root, profileId, {
      filename: 'fictional-native-coordinator.txt',
      bytes: Buffer.from('Fictional native coordinator source.'),
    });
  const { buildIntakeCollectionEnvelope } = await import('../intake-envelope-build.ts'),
    { createIntakePlanRead, getIntakeRead } = await import('../intake.ts');
  await buildIntakeCollectionEnvelope(f.db, { id: source.id });
  const planned = await createIntakePlanRead(f.db, f.root, profileId, source.id, {
    version: source.version,
    operationId: 'native-coordinator-plan',
  });
  assert.ok('format' in planned);
  const batch = f.manager.create(profileId, {
    operationId: 'native-coordinator-batch',
    intakeIds: [source.id],
  });
  const until = Date.now() + 30000;
  while (!f.bridges[0]?.started && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const current = f.manager.get(profileId, batch.id);
  assert.equal(current.items[0]!.status, 'running', JSON.stringify(current.items[0]));
  assert.ok(f.bridges[0]?.started);
  assert.equal(current.items[0]!.proposalState?.format, 'health-intake-proposal-summary-v2');
  assert.equal(current.items[0]!.proposalState?.total, 0);
  const chat = f.assistant.get(profileId, current.items[0]!.chatId!);
  assert.ok(chat.conversionCheckpoint && 'format' in chat.conversionCheckpoint);
  assert.equal(chat.conversionCheckpoint.format, 'health-intake-conversion-checkpoint-v2');
  assert.equal('seen' in chat.conversionCheckpoint, false);
  assert.ok('format' in getIntakeRead(f.db, f.root, profileId, source.id));
  f.manager.stop(profileId, batch.id);
});
