import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createImportDiagnostics,
  beginImportPhase,
  measureImportPhase,
} from '../import-diagnostics.ts';
import { recentPerformanceLimits, validateClientOperation } from '../import-performance.ts';
import { openVault } from '../vault-store.ts';
import { freshKey } from '../vault-crypto.ts';
import { createEncryptedProfiles } from '../encrypted-profiles.ts';
import { receiveIntakeUpload } from '../intake-upload.ts';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, flushIntake } from '../intake.ts';

const profileId = 'fictional-performance';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const summary = (d: ReturnType<typeof createImportDiagnostics>) =>
  d.exportSnapshot(profileId).recentPerformance!;
function directory(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'circus-performance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test('metadata summaries are default on, nested intervals use a union and plain HTTP polling is excluded', () => {
  let ms = 0;
  const d = createImportDiagnostics({
    now: () => new Date(1_800_000_000_000 + ms),
    monotonicNow: () => ms,
  });
  const operationId = randomUUID();
  const context = { profileId, operationId };
  d.record('http.request.started', {}, context);
  d.record('import.phase.started', { phase: 'upload_stream' }, { ...context, spanId: 'outer' });
  ms = 10;
  d.record(
    'import.phase.started',
    { phase: 'hash' },
    { ...context, spanId: 'inner', parentSpanId: 'outer' },
  );
  ms = 30;
  d.record(
    'import.phase.completed',
    { phase: 'hash', durationMs: 20 },
    { ...context, spanId: 'inner', parentSpanId: 'outer' },
  );
  ms = 40;
  d.record(
    'import.phase.completed',
    { phase: 'upload_stream', durationMs: 40 },
    { ...context, spanId: 'outer' },
  );
  ms = 65;
  d.record('http.request.completed', { durationMs: 65 }, context);
  for (let n = 0; n < 100; n++)
    d.record('http.request.completed', { durationMs: 1 }, { profileId, requestId: randomUUID() });
  const result = summary(d);
  assert.equal(d.snapshot(profileId).length, 0);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0]!.measuredServerMs, 40);
  assert.equal(result.operations[0]!.unattributedServerMs, 25);
  assert.equal(result.operations[0]!.status, 'completed');
  assert.equal(
    result.operations[0]!.spans[2]!.parentSpanId,
    result.operations[0]!.spans[1]!.spanId,
  );
  d.close();
});
test('client timing ingestion is bounded, whitelists fields and cannot smuggle content into export', () => {
  const d = createImportDiagnostics();
  const operationId = randomUUID();
  assert.equal(
    d.recordClientOperation(profileId, {
      operationId,
      kind: 'upload',
      outcome: 'completed',
      durationMs: 100,
      phases: [{ phase: 'render_wait', startMs: 80, durationMs: 20, text: 'fictional secret' }],
      counts: { bytes: 12, secret: 'fictional secret' },
      filename: 'fictional secret',
    }),
    true,
  );
  assert.equal(JSON.stringify(summary(d)).includes('fictional secret'), false);
  assert.equal(
    validateClientOperation({
      operationId,
      kind: 'upload',
      outcome: 'completed',
      durationMs: 10,
      phases: [{ phase: 'render_wait', startMs: 8, durationMs: 20 }],
    }),
    null,
  );
  assert.equal(
    validateClientOperation({
      operationId: 'fictional secret',
      kind: 'upload',
      outcome: 'completed',
      durationMs: 10,
    }),
    null,
  );
  assert.equal(
    validateClientOperation({
      operationId,
      kind: 'upload',
      outcome: 'completed',
      durationMs: 10,
      counts: { bytes: -1 },
    }),
    null,
  );
  d.close();
});
test('failed and cancelled phases retain reason and unfinished work survives lock as interrupted', async () => {
  const d = createImportDiagnostics();
  let bytes: Uint8Array | null = null;
  d.attachSummaryStore(profileId, {
    read: () => bytes,
    write: (value) => {
      bytes = Uint8Array.from(value);
    },
  });
  await assert.rejects(
    d.run({ profileId, operationId: randomUUID() }, () =>
      measureImportPhase('review_query', async () => {
        await delay(12);
        throw Error('fictional secret');
      }),
    ),
    /fictional secret/,
  );
  d.run({ profileId, operationId: randomUUID() }, () => beginImportPhase('upload_stream').cancel());
  d.run({ profileId, operationId: randomUUID() }, () => beginImportPhase('provider_request'));
  const old = summary(d);
  assert.ok(old.operations.some((o) => o.status === 'failed'));
  assert.ok(old.operations.some((o) => o.status === 'cancelled'));
  d.detachSummaryStore(profileId);
  assert.ok(bytes);
  assert.equal(summary(d).operations.length, 0);
  const next = createImportDiagnostics();
  next.attachSummaryStore(profileId, {
    read: () => bytes,
    write: (value) => {
      bytes = value;
    },
  });
  const restored = summary(next);
  assert.equal(restored.operations.length, 3);
  assert.ok(
    restored.operations.some(
      (o) => o.status === 'interrupted' && o.currentStage === 'provider_request',
    ),
  );
  assert.equal(JSON.stringify(restored).includes('fictional secret'), false);
  next.close();
  d.close();
});
test('persistence errors are optional, counted, bounded and age-limited', () => {
  let now = 1_800_000_000_000;
  const d = createImportDiagnostics({ now: () => new Date(now) });
  d.attachSummaryStore(profileId, {
    read: () => {
      throw Error('read failure');
    },
    write: () => {
      throw Error('write failure');
    },
  });
  for (let n = 0; n < 100; n++)
    d.run({ profileId, operationId: randomUUID() }, () =>
      measureImportPhase('upload_publish', () => 42),
    );
  d.flushSummaries(profileId);
  let result = summary(d);
  assert.equal(result.readFailures, 1);
  assert.equal(result.writeFailures, 1);
  assert.equal(result.operations.length, 64);
  assert.equal(result.droppedOperations, 36);
  now += recentPerformanceLimits.maxAgeMs + 1;
  result = summary(d);
  assert.equal(result.operations.length, 0);
  d.close();
});
test('encrypted diagnostics are outside the evidence manifest and cannot be read under another profile', (t) => {
  const root = directory(t),
    key = freshKey();
  const vault = openVault({ directory: root, profileId, key, initialize: true });
  const d = createImportDiagnostics();
  d.attachSummaryStore(profileId, {
    read: () => vault.readPerformanceSummary(),
    write: (b) => vault.writePerformanceSummary(b),
  });
  d.run({ profileId, operationId: randomUUID() }, () =>
    measureImportPhase('fictional_storage_delay', () => 42),
  );
  d.flushSummaries(profileId);
  const before = vault.metadata();
  assert.deepEqual(before.files, {});
  assert.deepEqual(before.objects, {});
  const encrypted = readFileSync(join(root, 'diagnostics/recent-performance.enc'));
  assert.equal(encrypted.includes(Buffer.from('fictional_storage_delay')), false);
  assert.ok(vault.readPerformanceSummary());
  assert.throws(() =>
    vault.writePerformanceSummary(Buffer.alloc(recentPerformanceLimits.maxBytes + 1)),
  );
  d.close();
  vault.close();
  key.fill(0);
});
test('encrypted profile lock, fresh manager and SQLite rebuild retain timing summaries', async (t) => {
  const base = directory(t),
    data = join(base, 'data'),
    runtime = join(base, 'runtime');
  mkdirSync(data);
  const d = createImportDiagnostics();
  const manager = createEncryptedProfiles({
    dataDirectory: data,
    runtimeDirectory: runtime,
    diagnostics: d,
  });
  const setup = manager.begin({
    fullName: 'Fictional Timer',
    birthDate: '1982-04-17',
    name: 'Fictional Timer',
    placebo: false,
  });
  const card = await manager.verify(setup.setupId, {
    acknowledged: true,
    recovery: setup.recoveryKit,
  });
  const id = card.id;
  d.run({ profileId: id, operationId: randomUUID() }, () =>
    measureImportPhase('fictional_durable_wait', () => 42),
  );
  manager.lock(id);
  assert.equal(d.exportSnapshot(id).recentPerformance!.operations.length, 0);
  manager.close();
  d.close();
  rmSync(join(data, 'profiles', id, 'cache'), { recursive: true, force: true });
  const restored = createImportDiagnostics();
  const second = createEncryptedProfiles({
    dataDirectory: data,
    runtimeDirectory: runtime,
    diagnostics: restored,
  });
  second.unlock(id, setup.recoveryKit);
  assert.ok(
    restored
      .exportSnapshot(id)
      .recentPerformance!.operations.some((op) =>
        op.spans.some((span) => span.phase === 'fictional_durable_wait'),
      ),
  );
  const scan = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.name.endsWith('.enc'))
        assert.equal(readFileSync(file).includes(Buffer.from('fictional_durable_wait')), false);
    }
  };
  scan(data);
  second.close();
  restored.close();
});
test('upload streaming delay is attributed separately from local hash/write and publication delay', async (t) => {
  const root = directory(t);
  const d = createImportDiagnostics();
  const operationId = randomUUID();
  await d.run({ profileId, operationId }, () =>
    receiveIntakeUpload(
      {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('fictional');
          await delay(25);
          yield Buffer.from(' report');
        },
      },
      async () => {
        await delay(15);
        return 12;
      },
      { tempRoot: root, diagnostics: d },
    ),
  );
  const spans = summary(d).operations[0]!.spans;
  const stream = spans.find((s) => s.phase === 'upload_stream')!,
    publish = spans.find((s) => s.phase === 'upload_publish')!;
  assert.ok((stream.fields.streamWaitMs as number) >= 20);
  assert.ok(publish.durationMs! >= 10);
  assert.ok(typeof stream.fields.hashMs === 'number');
  assert.ok(typeof stream.fields.stagingWriteMs === 'number');
  assert.equal(stream.fields.chunkCount, 2);
  d.close();
});
test('curation delay and failed durability are measured without changing upload or flush outcome', (t) => {
  const root = directory(t);
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const d = createImportDiagnostics();
  t.after(() => {
    db.close();
    d.close();
  });
  const intake = d.run({ profileId, operationId: randomUUID() }, () =>
    uploadIntake(
      db,
      root,
      profileId,
      { filename: 'fictional.txt', bytes: Buffer.from('fictional report') },
      {
        exportFn: () => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12);
          throw Error('fictional storage failure');
        },
      },
    ),
  );
  assert.equal(intake.durability.pending, true);
  const spans = summary(d).operations[0]!.spans;
  const flush = spans.find((s) => s.phase === 'curation_flush')!;
  assert.equal(flush.outcome, 'failed');
  assert.ok(flush.durationMs! >= 10);
  assert.ok(spans.some((s) => s.phase === 'upload_original_copy'));
  assert.ok(spans.some((s) => s.phase === 'upload_original_fsync'));
  const failure = d.run({ profileId, operationId: randomUUID() }, () =>
    flushIntake(db, root, profileId, {
      exportFn: () => {
        throw Error('retry failure');
      },
    }),
  );
  assert.equal(failure.pending, true);
});

test('one export salt joins import IDs across summaries and attribution without making exports linkable by default', () => {
  const d = createImportDiagnostics({ enabled: true }),
    salt = Buffer.alloc(32, 7),
    importId = 'intake:fictional-shared';
  d.record(
    'import.phase.completed',
    { phase: 'provider_request', durationMs: 12 },
    { profileId, importId },
  );
  const a = d.exportSnapshot(profileId, salt),
    expected = createHash('sha256').update(salt).update(importId).digest('hex').slice(0, 20);
  assert.equal(a.events[0]!.context.importId, expected);
  assert.equal(a.recentPerformance!.operations[0]!.context.importId, expected);
  assert.equal(a.recentPerformance!.operations[0]!.operationId, expected);
  assert.notEqual(
    d.exportSnapshot(profileId).recentPerformance!.operations[0]!.operationId,
    d.exportSnapshot(profileId).recentPerformance!.operations[0]!.operationId,
  );
  d.close();
});

test('finishing one correlated HTTP request leaves concurrent request stages active', () => {
  let ms = 0;
  const d = createImportDiagnostics({ now: () => new Date(1_800_000_000_000 + ms) }),
    operationId = randomUUID();
  const a = { profileId, operationId, requestId: randomUUID() },
    b = { profileId, operationId, requestId: randomUUID() };
  d.record('http.request.started', {}, a);
  d.record('http.request.started', {}, b);
  ms = 10;
  d.record('http.request.completed', { durationMs: 10, status: 200 }, a);
  assert.equal(summary(d).operations[0]!.status, 'active');
  assert.equal(summary(d).operations[0]!.currentStage, 'server_request');
  ms = 30;
  d.record('http.request.completed', { durationMs: 30, status: 200 }, b);
  assert.equal(summary(d).operations[0]!.status, 'completed');
  assert.equal(summary(d).operations[0]!.elapsedWallMs, 30);
  d.close();
});
test('lock erases both detail and summaries and ignores late callbacks until authenticated unlock attaches storage', () => {
  const d = createImportDiagnostics({ enabled: true });
  let bytes: Uint8Array | null = null;
  const store = {
    read: () => bytes,
    write: (value: Uint8Array) => {
      bytes = Uint8Array.from(value);
    },
  };
  d.attachSummaryStore(profileId, store);
  const context = { profileId, operationId: randomUUID() };
  const active = d.startActive(profileId, context);
  d.run(context, () => beginImportPhase('provider_request'));
  d.detachSummaryStore(profileId);
  active.finish();
  d.record('http.request.completed', { durationMs: 10 }, context);
  assert.equal(d.snapshot(profileId).length, 0);
  assert.equal(summary(d).operations.length, 0);
  assert.equal(
    d.recordClientOperation(profileId, {
      operationId: context.operationId,
      kind: 'upload',
      outcome: 'completed',
      durationMs: 10,
    }),
    false,
  );
  d.attachSummaryStore(profileId, store);
  assert.equal(summary(d).operations[0]!.status, 'interrupted');
  d.run({ profileId, operationId: randomUUID() }, () =>
    measureImportPhase('review_query', () => 42),
  );
  assert.equal(summary(d).operations.length, 2);
  d.close();
});
test('optional span sinks cannot change synchronous return values or thrown application errors', () => {
  const d = createImportDiagnostics(),
    sink = {
      ...d,
      record() {
        throw Error('diagnostic fault');
      },
    };
  assert.equal(
    measureImportPhase('upload_publish', () => 42, {}, { profileId }, sink),
    42,
  );
  const original = Error('fictional application failure');
  assert.throws(
    () =>
      measureImportPhase(
        'upload_publish',
        () => {
          throw original;
        },
        {},
        { profileId },
        sink,
      ),
    (error) => error === original,
  );
  d.close();
});

test('long operations retain slow-stage aggregates after detailed span eviction', () => {
  const d = createImportDiagnostics(),
    context = { profileId, operationId: randomUUID() };
  d.record('http.request.started', {}, context);
  d.record('import.phase.completed', { phase: 'early_slow_storage', durationMs: 1234 }, context);
  for (let n = 0; n < 400; n++)
    d.record('import.phase.completed', { phase: 'provider_request', durationMs: 1 }, context);
  const op = summary(d).operations[0]!;
  assert.ok(op.droppedEvents > 0);
  assert.equal(
    op.spans.some((s) => s.phase === 'early_slow_storage'),
    false,
  );
  assert.deepEqual(
    op.phaseTotals.find((p) => p.phase === 'early_slow_storage'),
    { phase: 'early_slow_storage', count: 1, totalMs: 1234, maxMs: 1234, failed: 0, cancelled: 0 },
  );
  assert.equal(op.phaseTotals.find((p) => p.phase === 'provider_request')!.count, 400);
  d.close();
});

test('explicit context clears survive nested runs, delayed phases and active resource scopes', async () => {
  const d = createImportDiagnostics({ enabled: true, resourceIntervalMs: 250 });
  const browser = {
    profileId,
    operationId: randomUUID(),
    requestId: randomUUID(),
    clientRequestId: randomUUID(),
    spanId: randomUUID(),
  };
  const background = {
    profileId,
    importId: 'intake:fictional-independent',
    runId: 'fictional-background-run',
    operationId: undefined,
    requestId: undefined,
    clientRequestId: undefined,
    spanId: undefined,
    parentSpanId: undefined,
  };
  let ownPhaseId = '';
  await d.run(browser, async () => {
    d.run(background, () => d.record('import.progress', { phase: 'nested_run' }));
    const phase = beginImportPhase('background_phase', {}, background, d);
    ownPhaseId = phase.id;
    phase.run(() => d.record('import.progress', { phase: 'inside_background_phase' }));
    // Finish while the original tagged browser context is current again.
    phase.finish();
    const active = d.startActive(profileId, background);
    active.record('import.progress', { phase: 'active_background_scope' });
    await delay(300);
    active.finish();
    d.record('http.request.completed', { durationMs: 300, status: 200 });
  });
  const events = d
    .snapshot(profileId)
    .filter((event) => event.context.importId === background.importId);
  assert.ok(events.some((event) => event.fields.phase === 'nested_run'));
  assert.ok(events.some((event) => event.event === 'process.resource.sample'));
  assert.ok(events.some((event) => event.event === 'import.active.completed'));
  for (const event of events) {
    assert.equal(event.context.operationId, undefined);
    assert.equal(event.context.requestId, undefined);
    assert.equal(event.context.clientRequestId, undefined);
    assert.notEqual(event.context.spanId, browser.spanId);
    assert.notEqual(event.context.parentSpanId, browser.spanId);
    assert.ok(Object.values(event.context).every((value) => typeof value === 'string'));
  }
  assert.equal(
    events.find((event) => event.fields.phase === 'inside_background_phase')!.context.parentSpanId,
    ownPhaseId,
  );
  assert.equal(
    summary(d).operations.length,
    2,
    'browser completion and background work remain separate operations',
  );
  d.close();
});

test('active scopes and phases finish with their captured context inside a later provider turn', () => {
  for (const enabled of [false, true]) {
    for (const turnId of [undefined, 'fictional-original-turn']) {
      for (const laterProfileId of [profileId, 'fictional-unrelated-profile']) {
        const d = createImportDiagnostics({ enabled });
        try {
          const context = {
            profileId,
            importId: 'fictional-scoped-import',
            runId: 'fictional-scoped-run',
            sliceId: 'fictional-scoped-slice',
            ...(turnId ? { turnId } : {}),
          };
          const active = d.run(context, () => d.startActive(profileId));
          const phase = d.run(context, () => beginImportPhase('model_preflight', {}, {}, d));
          d.run(
            {
              ...context,
              profileId: laterProfileId,
              operationId: randomUUID(),
              requestId: randomUUID(),
              clientRequestId: randomUUID(),
              spanId: randomUUID(),
              parentSpanId: randomUUID(),
              turnId: 'fictional-later-turn',
              providerRequestId: randomUUID(),
            },
            () => {
              phase.finish();
              active.finish({ outcome: 'idle' });
              active.finish({ outcome: 'failed' });
            },
          );
          const operations = summary(d).operations;
          assert.equal(operations.length, 1, 'later request identity must not capture a terminal');
          const operation = operations[0]!;
          assert.equal(operation.status, 'completed');
          assert.equal(operation.currentStage, null);
          assert.equal(operation.spans.length, 2);
          assert.ok(operation.spans.every((span) => span.durationMs !== null));
          assert.ok(operation.spans.every((span) => span.outcome !== 'active'));
          assert.equal(
            d.exportSnapshot('fictional-unrelated-profile').recentPerformance!.operations.length,
            0,
          );
          if (enabled) {
            const events = d.snapshot(profileId);
            for (const prefix of ['import.active', 'import.phase']) {
              const started = events.find((event) => event.event === prefix + '.started')!;
              const completed = events.filter((event) => event.event === prefix + '.completed');
              assert.equal(completed.length, 1);
              assert.deepEqual(completed[0]!.context, started.context);
            }
          }
        } finally {
          d.close();
        }
      }
    }
  }
});

test('scoped progress keeps same-profile turn enrichment without borrowing another profile', () => {
  const d = createImportDiagnostics({ enabled: true });
  try {
    const context = { profileId, importId: 'fictional-progress-import' };
    const active = d.run(context, () => d.startActive(profileId));
    d.run(
      { ...context, turnId: 'fictional-current-turn', providerRequestId: 'fictional-request' },
      () => active.record('import.progress', { phase: 'provider_progress' }),
    );
    d.run(
      {
        profileId: 'fictional-other-profile',
        turnId: 'fictional-foreign-turn',
        providerRequestId: 'fictional-foreign-request',
      },
      () => {
        active.record('import.progress', { phase: 'outside_profile' });
        active.finish();
      },
    );
    const events = d.snapshot(profileId);
    const progress = events.find((event) => event.fields.phase === 'provider_progress')!;
    assert.equal(progress.context.turnId, 'fictional-current-turn');
    assert.equal(progress.context.providerRequestId, 'fictional-request');
    const outside = events.find((event) => event.fields.phase === 'outside_profile')!;
    assert.equal(outside.context.turnId, undefined);
    assert.equal(outside.context.providerRequestId, undefined);
    assert.equal(summary(d).operations[0]!.status, 'completed');
    assert.equal(d.snapshot('fictional-other-profile').length, 0);

    const unscoped = beginImportPhase('unscoped_phase', {}, {}, d);
    d.run({ profileId: 'fictional-other-profile' }, () => unscoped.finish());
    assert.equal(d.snapshot('fictional-other-profile').length, 0);
  } finally {
    d.close();
  }
});

test('default upload and processing share a salted source reference after detail eviction and restart', (t) => {
  const root = directory(t),
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const d = createImportDiagnostics(),
    operationId = randomUUID(),
    salt = Buffer.alloc(32, 9);
  let bytes: Uint8Array | null = null;
  const store = {
    read: () => bytes,
    write: (value: Uint8Array) => {
      bytes = Uint8Array.from(value);
    },
  };
  d.attachSummaryStore(profileId, store);
  const intake = d.run({ profileId, operationId }, () =>
    uploadIntake(db, root, profileId, {
      filename: 'fictional-link.txt',
      bytes: Buffer.from('independently fictional report'),
    }),
  );
  for (let n = 0; n < 400; n++)
    d.record(
      'import.phase.completed',
      { phase: 'later_browser_request', durationMs: 1 },
      { profileId, operationId },
    );
  d.run({ profileId, importId: intake.id, runId: 'fictional-processing' }, () =>
    measureImportPhase('provider_request', () => 42),
  );
  d.detachSummaryStore(profileId);
  d.close();
  db.close();
  const restored = createImportDiagnostics();
  restored.attachSummaryStore(profileId, store);
  const exported = restored.exportSnapshot(profileId, salt),
    source = createHash('sha256').update(salt).update(intake.id).digest('hex').slice(0, 20);
  assert.equal(exported.events.length, 0, 'detailed tracing stays disabled');
  const upload = exported.recentPerformance!.operations.find(
    (op) => op.operationId === operationId,
  )!;
  const processing = exported.recentPerformance!.operations.find(
    (op) => op.context.importId === source,
  )!;
  assert.ok(upload.droppedEvents > 0);
  assert.equal(upload.context.importId, undefined, 'the original linking detail has been evicted');
  assert.deepEqual(upload.relatedImportIds, [source]);
  assert.deepEqual(processing.relatedImportIds, [source]);
  assert.equal(JSON.stringify(exported).includes(intake.id), false);
  restored.close();
});
test('related import links are bounded and disclose truncation without exporting raw source IDs', () => {
  const d = createImportDiagnostics(),
    operationId = randomUUID();
  for (let n = 0; n < 150; n++)
    d.record(
      'import.progress',
      {},
      { profileId, operationId, importId: `intake:fictional-linked-${n}` },
    );
  const op = summary(d).operations[0]!;
  assert.equal(op.relatedImportIds.length, 128);
  assert.equal(op.relatedImportIdsTruncated, true);
  assert.equal(JSON.stringify(op).includes('intake:fictional-linked'), false);
  d.close();
});

test('phase failure aggregates recognize HTTP failure statuses and explicit terminal outcomes', () => {
  const d = createImportDiagnostics(),
    context = { profileId, operationId: randomUUID() };
  d.record('http.request.completed', { durationMs: 20, status: 400 }, context);
  d.record(
    'import.phase.completed',
    { phase: 'review_acceptance', durationMs: 30, outcome: 'failed' },
    context,
  );
  d.record(
    'import.phase.completed',
    { phase: 'upload_publish', durationMs: 40, outcome: 'cancelled' },
    context,
  );
  const totals = summary(d).operations[0]!.phaseTotals;
  assert.equal(totals.find((p) => p.phase === 'server_request')!.failed, 1);
  assert.equal(totals.find((p) => p.phase === 'review_acceptance')!.failed, 1);
  assert.equal(totals.find((p) => p.phase === 'upload_publish')!.cancelled, 1);
  d.close();
});

test('resource counts distinguish unsampled short operations, measured zero CPU and absent worker RSS across restart', () => {
  let time = 1_800_000_000_000;
  const d = createImportDiagnostics({ now: () => new Date(time) }),
    context = { profileId, operationId: randomUUID() };
  let bytes: Uint8Array | null = null;
  const store = {
    read: () => bytes,
    write: (value: Uint8Array) => {
      bytes = Uint8Array.from(value);
    },
  };
  d.attachSummaryStore(profileId, store);
  d.record('import.phase.completed', { phase: 'short_review', durationMs: 1 }, context);
  let op = summary(d).operations[0]!;
  assert.equal(op.resourceSampleCount, 0);
  assert.equal(op.pdfWorkerSampleCount, 0);
  const lastProgress = op.lastProgressAt;
  time += 5000;
  d.record(
    'process.resource.sample',
    { rssBytes: 64, cpuPercent: 0, eventLoopMaxMs: 0, pdfWorkerRssSampleBytes: null },
    context,
  );
  op = summary(d).operations[0]!;
  assert.equal(op.resourceSampleCount, 1);
  assert.equal(op.pdfWorkerSampleCount, 0);
  assert.equal(
    op.resourcePeak.cpuPercent,
    0,
    'zero CPU is measured only when the process sample count is positive',
  );
  assert.equal(op.lastProgressAt, lastProgress, 'resource observation is not application progress');
  d.flushSummaries(profileId);
  d.detachSummaryStore(profileId);
  const restored = createImportDiagnostics();
  restored.attachSummaryStore(profileId, store);
  op = summary(restored).operations[0]!;
  assert.equal(op.resourceSampleCount, 1);
  assert.equal(op.pdfWorkerSampleCount, 0);
  restored.record(
    'process.resource.sample',
    { rssBytes: 32, cpuPercent: 0, eventLoopMaxMs: 0, pdfWorkerRssSampleBytes: 128 },
    context,
  );
  op = summary(restored).operations[0]!;
  assert.equal(op.resourceSampleCount, 2);
  assert.equal(op.pdfWorkerSampleCount, 1);
  assert.equal(op.resourcePeak.pdfWorkerRssSampleBytes, 128);
  restored.close();
  d.close();
});
test('legacy summaries without resource counters report unknown sampling instead of measured zero', () => {
  const d = createImportDiagnostics(),
    context = { profileId, operationId: randomUUID() };
  let bytes: Uint8Array | null = null;
  const store = {
    read: () => bytes,
    write: (value: Uint8Array) => {
      bytes = Uint8Array.from(value);
    },
  };
  d.attachSummaryStore(profileId, store);
  d.record('import.phase.completed', { phase: 'legacy_review', durationMs: 1 }, context);
  d.detachSummaryStore(profileId);
  const old = JSON.parse(Buffer.from(bytes!).toString());
  delete old.operations[0].resourceSampleCount;
  delete old.operations[0].pdfWorkerSampleCount;
  bytes = Buffer.from(JSON.stringify(old));
  const restored = createImportDiagnostics();
  restored.attachSummaryStore(profileId, store);
  const op = summary(restored).operations[0]!;
  assert.equal(op.resourceSampleCount, null);
  assert.equal(op.pdfWorkerSampleCount, null);
  restored.close();
  d.close();
});

test('restart closes old unfinished spans without durations and a resumed run can complete', () => {
  const d = createImportDiagnostics();
  let bytes: Uint8Array | null = null;
  const store = {
    read: () => bytes,
    write: (value: Uint8Array) => {
      bytes = Uint8Array.from(value);
    },
  };
  const old = { profileId, importId: 'intake:fictional-resumed', runId: 'old-run' };
  d.attachSummaryStore(profileId, store);
  d.record('import.active.started', {}, old);
  d.record(
    'model.request.started',
    {},
    { ...old, turnId: 'old-turn', providerRequestId: 'old-provider' },
  );
  d.detachSummaryStore(profileId);
  d.close();
  const resumed = createImportDiagnostics();
  resumed.attachSummaryStore(profileId, store);
  const current = { ...old, runId: 'new-run' };
  resumed.record('import.active.started', {}, current);
  resumed.record(
    'model.request.started',
    {},
    { ...current, turnId: 'new-turn', providerRequestId: 'new-provider' },
  );
  resumed.record(
    'model.request.completed',
    { durationMs: 23 },
    { ...current, turnId: 'new-turn', providerRequestId: 'new-provider' },
  );
  resumed.record('import.active.completed', { outcome: 'completed' }, current);
  const op = summary(resumed).operations[0]!;
  assert.equal(op.status, 'completed');
  assert.equal(op.currentStage, null);
  assert.equal(op.spans.filter((span) => span.outcome === 'active').length, 0);
  const interrupted = op.spans.filter((span) => span.outcome === 'interrupted');
  assert.equal(interrupted.length, 2);
  assert.ok(interrupted.every((span) => span.durationMs === null));
  resumed.close();
});
test('evicted queue completion never turns a completed operation into a live queued stage', () => {
  const d = createImportDiagnostics(),
    context = { profileId, importId: 'intake:fictional-eviction', runId: 'current-run' };
  d.record('import.phase.started', { phase: 'processing_queue' }, context);
  d.record('import.phase.completed', { phase: 'processing_queue', durationMs: 10 }, context);
  d.record('import.active.started', {}, context);
  for (let n = 0; n < 400; n++)
    d.record('import.phase.completed', { phase: 'read_page', durationMs: 1 }, context);
  d.record('import.active.completed', { outcome: 'completed' }, context);
  const op = summary(d).operations[0]!;
  assert.ok(op.droppedEvents > 0);
  assert.equal(op.status, 'completed');
  assert.equal(op.currentStage, null);
  assert.equal(op.spans.filter((span) => span.outcome === 'active').length, 0);
  const queue = op.spans.find((span) => span.phase === 'processing_queue')!;
  assert.equal(queue.durationMs, null);
  assert.equal(queue.outcome, 'terminal_detail_unavailable');
  d.close();
});
test('independent lifecycle keeps concurrent run and provider scopes active until each completes', () => {
  const d = createImportDiagnostics(),
    base = { profileId, importId: 'intake:fictional-concurrent', turnId: 'same-turn' };
  const a = { ...base, runId: 'run-a', providerRequestId: 'provider-a' },
    b = { ...base, runId: 'run-b', providerRequestId: 'provider-b' };
  d.record('model.request.started', {}, a);
  d.record('model.request.started', {}, b);
  d.record('model.request.completed', { durationMs: 1 }, a);
  let op = summary(d).operations[0]!;
  assert.equal(op.status, 'active');
  assert.equal(op.currentStage, 'provider_request');
  d.record('model.request.completed', { durationMs: 2 }, b);
  op = summary(d).operations[0]!;
  assert.equal(op.status, 'completed');
  assert.equal(op.currentStage, null);
  assert.deepEqual(
    op.spans.map((span) => span.durationMs),
    [1, 2],
  );
  d.close();
});

test('saturated summaries size only changed metadata and serialize the full state once per flush', () => {
  const d = createImportDiagnostics({ enabled: false });
  let bytes: Uint8Array | null = null;
  d.attachSummaryStore(profileId, {
    read: () => null,
    write: (value) => {
      bytes = value;
    },
  });
  const stringify = JSON.stringify;
  let fullStates = 0;
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
    if (value && typeof value === 'object' && 'schemaVersion' in value && 'operations' in value)
      fullStates++;
    return Reflect.apply(stringify, JSON, [value, ...rest]);
  }) as typeof JSON.stringify;
  try {
    for (let i = 0; i < 5000; i++)
      d.record(
        i % 2 ? 'import.phase.completed' : 'import.phase.started',
        { phase: `fictional_phase_${i % 60}`, durationMs: i, bytes: i },
        {
          profileId,
          operationId: `operation-${Math.floor(i / 200)}`,
          spanId: `span-${Math.floor(i / 2)}`,
        },
      );
    assert.equal(fullStates, 0, 'event capture/eviction must not serialize retained state');
    d.flushSummaries(profileId);
    assert.equal(fullStates, 1);
    assert.ok(bytes && (bytes as Uint8Array).byteLength <= recentPerformanceLimits.maxBytes);
    assert.ok(summary(d).droppedOperations > 0);
    assert.equal(d.snapshot(profileId).length, 0);
  } finally {
    JSON.stringify = stringify;
    d.close();
  }
});

test('default summary resource sampling never waits on filesystem capacity and caches completed samples', async () => {
  let calls = 0;
  let release!: (value: number) => void;
  const pending = new Promise<number>((resolve) => {
    release = resolve;
  });
  const d = createImportDiagnostics({
    enabled: true,
    resourceIntervalMs: 250,
    filesystemIntervalMs: 30000,
    filesystemAvailableBytes: async () => {
      calls++;
      return pending;
    },
  });
  const scope = d.startActive(profileId, { operationId: randomUUID() });
  try {
    await delay(300);
    const initial = d.snapshot(profileId).filter((e) => e.event === 'process.resource.sample');
    assert.ok(initial.length);
    assert.equal(initial[0].fields.runtimeAvailableBytes, null);
    assert.equal(initial[0].fields.filesystemSampleAgeMs, null);
    assert.equal(initial[0].fields.filesystemSamplePending, true);
    assert.equal(calls, 2);
    release(123456);
    await delay(550);
    const samples = d.snapshot(profileId).filter((e) => e.event === 'process.resource.sample');
    assert.equal(samples.at(-1)!.fields.runtimeAvailableBytes, 123456);
    assert.equal(samples.at(-1)!.fields.filesystemSamplePending, false);
    assert.ok(Number(samples.at(-1)!.fields.filesystemSampleAgeMs) >= 0);
    assert.equal(calls, 2, 'CPU/RSS ticks must not repeat filesystem calls');
  } finally {
    scope.finish();
    d.close();
  }
});
