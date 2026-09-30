import { zipFixture } from '../../tests/fixtures/zip.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ModelContextLimitError } from '../model-config.ts';
import { fictionalModel } from './fictional-model.ts';
import { HttpError, openDatabase } from '../database.ts';
import { profilePaths } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, getIntake } from '../intake.ts';
import { createAssistant } from '../assistant.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import { DEFAULT_INTAKE_READING_LIMITS } from '../intake-reading-budget.ts';
import { readIntakeBatch, writeIntakeBatch } from '../intake-batch-journal.ts';
import {
  extractIntakeSourceText,
  locateSourceExtractionProgress,
} from '../intake-source-extraction.ts';
import { getIntakeSourceText, publishIntakeSourceText } from '../intake-source-text.ts';
import type { IntakeBatch } from '../../shared/intake-batch.ts';

async function until(check: () => boolean, harnessTimeoutMs = 8000) {
  const end = Date.now() + harnessTimeoutMs;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), 'automatic recovery reached its durable checkpoint');
}
function fixture(
  t: TestContext,
  mode:
    | 'model'
    | 'slice'
    | 'initial'
    | 'capacity'
    | 'pdf'
    | 'zip'
    | 'unknown'
    | 'source'
    | 'source-race'
    | 'source-watchdog',
  readingRequests = 1,
  sourceCopies = 1000,
) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-automatic-recovery-'));
  const profileId = 'fictional-recovery';
  const db = openDatabase(profilePaths(root, profileId).database, profileId);
  const objects = new Map<string, Buffer>();
  attachPersonalDurability(db, {
    root,
    profileId,
    recordStorage: {
      read: (name) => objects.get(name) || null,
      writeImmutable: (name, bytes) => {
        assert.ok(!objects.has(name));
        objects.set(name, Buffer.from(bytes));
      },
      publishHead: (bytes) => objects.set('head', Buffer.from(bytes)),
    },
  });
  const source = uploadIntake(
    db,
    root,
    profileId,
    mode === 'zip'
      ? { filename: 'fictional.zip', bytes: zipFixture([{ name: 'fictional.pdf', data: pdf() }]) }
      : mode === 'pdf'
        ? { filename: 'fictional.pdf', bytes: pdf() }
        : {
            filename: 'fictional.txt',
            bytes: Buffer.from(
              'Fictional retained source text. '.repeat(mode === 'source' ? 2000 : sourceCopies),
            ),
          },
  );
  if (mode === 'pdf')
    publishIntakeSourceText(db, root, profileId, source.id, {
      operationId: randomUUID(),
      sourceHash: source.sha256,
      expectedRevisionId: null,
      evidence: {
        adapter: { name: 'fictional-capture', version: '1' },
        pages: [1, 2, 3].map((page) => ({
          page,
          disposition: 'extracted' as const,
          inspected: false,
        })),
        spans: [1, 2, 3].map((page) => ({
          id: 'fictional-page-' + page,
          region: { page },
          text: 'Fictional independently captured page ' + page,
          provenance: 'native' as const,
        })),
        relations: [],
        issues: [],
      },
    });
  let now = Date.now(),
    sourceAttempts = 0,
    prerequisite = 'fictional-configuration-1';
  type Callbacks = Parameters<
    NonNullable<Parameters<typeof createAssistant>[0]['bridgeFactory']>
  >[0];
  const calls: Callbacks[] = [];
  const units: string[] = [];
  const assistant = createAssistant({
    root,
    databases: new Map([[profileId, db]]),
    clock: () => new Date(now),
    availability: () => ({ available: true, readiness: 'ready' }),
    connectionCheck: async () => ({ available: true, readiness: 'ready' }),
    bridgeFactory(callbacks) {
      calls.push(callbacks);
      const n = calls.length;
      return {
        async start() {
          return { model: 'fictional', backend: 'synthetic' };
        },
        async turn() {
          callbacks.beforeRequest?.();
          const current = getIntake(db, root, profileId, source.id);
          const unit = current
            .workflow!.plans.find((p) => p.status === 'active')!
            .units.find((u) => !u.processingException)!;
          units.push(unit.id);
          callbacks.onEvent?.('model/requestStarted', {
            requestId: 'fictional-request-' + n,
            model: 'fictional',
            attempt: n,
            requestBytes: 1,
            requestDigest: 'b'.repeat(64),
          });
          if (mode === 'pdf' || mode === 'zip') return;
          if (mode === 'initial') {
            callbacks.onEvent?.('model/requestFinished', {
              requestId: 'fictional-request-' + n,
              outcome: 'rejected',
              classification: 'context_limit',
              failed: true,
            });
            callbacks.onExit?.(
              new ModelContextLimitError('Fictional initial request rejected', 'initial'),
            );
            return;
          }
          if (mode === 'unknown') {
            if (n === 1) {
              callbacks.onEvent?.('model/requestFinished', {
                requestId: 'fictional-request-1',
                outcome: 'unknown',
                failed: true,
              });
              callbacks.onExit?.(Error('Fictional transport loss'));
            }
            return;
          }
          now += 101;
          callbacks.onEvent?.('model/requestFinished', {
            requestId: 'fictional-request-' + n,
            outcome: 'response',
            failed: false,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          if (mode === 'slice')
            callbacks.onExit?.(
              new ModelContextLimitError('Fictional bounded slice ended', 'slice'),
            );
          else callbacks.onEvent?.('turn/completed', { turn: { status: 'completed' } });
        },
        async cancel() {},
        close() {},
      };
    },
  });
  const manager = createIntakeBatchManager({
    root,
    databases: new Map([[profileId, db]]),
    assistant,
    clock: () => new Date(now),
    pollMs: 1,
    continuationDelayMs: 0,
    providerRetryBaseMs: 1,
    random: () => 0,
    readingLimits: { activeMs: 100, slices: 1, turns: 1, requests: readingRequests },
    providerPrerequisiteKey: () => prerequisite,
    ...(mode === 'source-watchdog' ? { sourceStallMs: 20 } : {}),
    extract: async (context) => {
      if (mode === 'source-watchdog')
        return new Promise<Awaited<ReturnType<typeof extractIntakeSourceText>>>(() => {});
      if (mode === 'source-race' && sourceAttempts++ === 0)
        throw new HttpError(
          409,
          'SOURCE_TEXT_CHANGED',
          'Fictional revision changed before admission',
        );
      if (mode === 'capacity' && sourceAttempts++ < 4)
        throw new HttpError(429, 'SOURCE_EXTRACTION_BUSY', 'Fictional shared worker busy');
      if (
        mode === 'source' &&
        locateSourceExtractionProgress(getIntakeSourceText(db, root, profileId, source.id)).page ===
          2 &&
        sourceAttempts++ < 3
      ) {
        throw Error('fictional stalled page');
      }
      return extractIntakeSourceText(context);
    },
  });
  t.after(() => {
    manager.close();
    assistant.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    db,
    profileId,
    source,
    manager,
    assistant,
    calls,
    units,
    tick: (ms = 10) => {
      now += ms;
    },
    fixPrerequisite: () => {
      prerequisite = 'fictional-configuration-2';
    },
  };
}

test('successful model calls without unique progress retry each exact unit three times, retain exceptions, and reopen explicitly', async (t) => {
  const f = fixture(t, 'model');
  const batch = f.manager.list(f.profileId)[0]!;
  await until(() => f.manager.get(f.profileId, batch.id).status === 'complete');
  const result = f.manager.get(f.profileId, batch.id);
  assert.equal(result.reason, 'exceptions');
  const units = getIntake(f.db, f.root, f.profileId, f.source.id).workflow!.plans[0].units;
  assert.ok(units.length > 1);
  for (const unit of units) {
    assert.equal(f.units.filter((id) => id === unit.id).length, 3);
    assert.equal(unit.processingException?.reason, 'processing_stalled');
    assert.notEqual(
      unit.coverage?.kind,
      'unreadable',
      'model stuckness is not evidence about source readability',
    );
  }
  assert.equal(result.items[0].reading!.accountedUnits, 0);
  f.manager.retryExceptions(f.profileId, batch.id);
  assert.equal(f.manager.get(f.profileId, batch.id).status, 'running');
  assert.equal(
    getIntake(f.db, f.root, f.profileId, f.source.id).workflow!.plans[0].units.some(
      (u) => u.processingException,
    ),
    false,
  );
  await until(() => f.manager.get(f.profileId, batch.id).status === 'complete');
  assert.equal(f.manager.get(f.profileId, batch.id).items[0].exceptions!.length, units.length);
  for (const unit of units) assert.equal(f.units.filter((id) => id === unit.id).length, 6);
});

test('default no-progress windows retain an exception after 48 usable responses per unit', async (t) => {
  const allowance = DEFAULT_INTAKE_READING_LIMITS.requests!;
  // One located unit proves the default 3 × 16 bound; the preceding test
  // separately covers moving between multiple units and explicit exception retry.
  const f = fixture(t, 'model', allowance, 1);
  const batch = f.manager.list(f.profileId)[0]!;
  // This synthetic bridge performs no inference; allow its durable host writes to finish.
  await until(() => f.manager.get(f.profileId, batch.id).status === 'complete', 120_000);
  const result = f.manager.get(f.profileId, batch.id);
  assert.equal(result.reason, 'exceptions');
  const units = getIntake(f.db, f.root, f.profileId, f.source.id).workflow!.plans[0].units;
  assert.equal(units.length, 1);
  for (const unit of units) {
    assert.equal(f.units.filter((id) => id === unit.id).length, 3 * allowance);
    assert.equal(unit.processingException?.reason, 'processing_stalled');
  }
  assert.equal(result.items[0].reading!.usableModelResponses, units.length * 3 * allowance);
  assert.equal(result.items[0].reading!.accountedUnits, 0);
});

test('source revision races persist an item backoff and retry without review', async (t) => {
  const f = fixture(t, 'source-race');
  const batch = f.manager.list(f.profileId)[0]!;
  await until(() => f.manager.get(f.profileId, batch.id).items[0].reason === 'retrying_extraction');
  const waiting = readIntakeBatch(f.root, f.profileId, batch.id).items[0];
  assert.equal(waiting.status, 'queued');
  assert.ok(waiting.retryAt);
  assert.notEqual(waiting.reason, 'source_review_required');
  f.tick(2_000);
  f.manager.wake(f.profileId);
  await until(
    () => (f.manager.get(f.profileId, batch.id).items[0].sourceExtraction?.progress || 0) > 0,
  );
  f.manager.stop(f.profileId, batch.id);
});
test('non-default local source watchdog locates a stalled inventory after three attempts', async (t) => {
  const f = fixture(t, 'source-watchdog');
  const batch = f.manager.list(f.profileId)[0]!;
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.tick(2_000);
    f.manager.wake(f.profileId);
    if (attempt < 3)
      await until(
        () =>
          (f.manager.get(f.profileId, batch.id).items[0].sourceExtraction?.stalls || 0) >= attempt,
      );
  }
  await until(() => !!f.manager.get(f.profileId, batch.id).items[0].exceptions?.length);
  const item = f.manager.get(f.profileId, batch.id).items[0];
  assert.equal(item.exceptions?.[0]?.reason, 'processing_stalled');
  assert.match(item.exceptions?.[0]?.locator || '', /inventory unavailable/);
});

test('ordinary context slices continue beyond two boundaries without becoming an unsupported context', async (t) => {
  const f = fixture(t, 'slice');
  const batch = f.manager.list(f.profileId)[0]!;
  await until(() => f.manager.get(f.profileId, batch.id).status === 'complete');
  assert.ok(f.calls.length > 3, 'a bounded context yield is not a document-wide allowance');
  const result = f.manager.get(f.profileId, batch.id);
  assert.equal(result.reason, 'exceptions');
  assert.ok(
    result.items[0].exceptions!.every((exception) => exception.reason === 'processing_stalled'),
  );
});

test('unknown replacement retains its predecessor, and superseded tools cannot publish after late success or Stop', async (t) => {
  const f = fixture(t, 'unknown');
  const batch = f.manager.list(f.profileId)[0]!;
  await until(() => {
    f.tick();
    return f.calls.length === 2;
  });
  const item = f.manager.get(f.profileId, batch.id).items[0];
  let chat = f.assistant.get(f.profileId, item.chatId!);
  assert.equal(chat.intakeModelAttempts![0].outcome, 'unknown');
  assert.equal(chat.intakeModelAttempts![0].recovery!.replacementRequestId, 'fictional-request-2');
  const current = getIntake(f.db, f.root, f.profileId, f.source.id);
  const plan = current.workflow!.plans.find((plan) => plan.status === 'active')!;
  const unit = plan.units[0];
  const sourceText = (await f.calls[1].onTool!({
    tool: 'health_intake_source_text',
    arguments: { id: f.source.id },
    callId: 'current-source-text',
  })) as { revisionId: string };
  await f.calls[1].onTool!({
    tool: 'health_intake_plan',
    arguments: { id: f.source.id, action: 'read_unit', unitId: unit.id },
    callId: 'current-read',
  });
  const valid = {
    tool: 'health_intake_batch',
    callId: 'current-proposal',
    arguments: {
      id: f.source.id,
      version: current.version,
      planId: plan.id,
      operationId: 'fictional-replacement-publication',
      coverage: [{ unitId: unit.id, kind: 'extracted', notes: 'Fictional supplied unit read.' }],
      sourceTextRevisionId: sourceText.revisionId,
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-replacement-record',
        kind: 'record',
        subject: 'self',
        payload: { literal: 'Fictional retained source text.' },
        provenance: {
          capturedVia: 'Fictional test',
          sourceSystem: null,
          sourceRecordId: f.source.id,
          evidenceClass: 'transcription',
          locator: unit.locator,
        },
        coverage: { status: 'partial', notes: ['Only the bounded fictional unit was read.'] },
      }),
      summary: 'Fictional replacement proposal',
    },
  };
  await assert.rejects(
    async () => f.calls[0].onTool!(structuredClone(valid)),
    /no longer running|authoriz/,
  );
  await f.calls[1].onTool!(structuredClone(valid));
  const published = getIntake(f.db, f.root, f.profileId, f.source.id);
  assert.equal(
    published.proposals.length,
    1,
    'the current replacement can publish this exact valid mutation',
  );
  f.calls[0].onEvent?.('model/requestFinished', {
    requestId: 'fictional-request-1',
    outcome: 'response',
    failed: false,
    usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
  });
  await assert.rejects(
    async () => f.calls[0].onTool!(structuredClone(valid)),
    /no longer running|authoriz/,
  );
  chat = f.assistant.get(f.profileId, item.chatId!);
  assert.equal(chat.intakeModelAttempts![0].outcome, 'unknown');
  assert.equal(chat.intakeModelAttempts![0].usage!.totalTokens, 6);
  f.manager.stop(f.profileId, batch.id);
  await assert.rejects(
    async () => f.calls[1].onTool!(structuredClone(valid)),
    /no longer running|authoriz/,
  );
  assert.equal(
    getIntake(f.db, f.root, f.profileId, f.source.id).version,
    published.version,
    'late results preserve usage but cannot create another local result',
  );
});

test('batch journal changes are proportional to the edited state and replay legacy initial snapshots', (t) => {
  const f = fixture(t, 'model');
  f.manager.close();
  const batch: IntakeBatch = {
    id: randomUUID(),
    profileId: f.profileId,
    operationId: 'fictional-bounded-journal',
    status: 'running',
    reason: null,
    currentIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    items: [],
  };
  for (let i = 0; i < 200; i++)
    batch.items.push({
      intakeId: 'fictional-' + i,
      sourceHash: 'a'.repeat(64),
      filename: 'fictional.txt',
      mimeType: 'text/plain',
      status: 'queued',
      reason: null,
      chatId: null,
      proposalIds: [],
      reading: null,
      startedAt: null,
      endedAt: null,
    });
  writeIntakeBatch(f.root, f.profileId, batch, 'created');
  for (let i = 0; i < 20; i++) {
    batch.items[0].reason = 'fictional checkpoint ' + i;
    writeIntakeBatch(f.root, f.profileId, batch, 'checkpoint');
  }
  const dir = join(profilePaths(f.root, f.profileId).root, 'intake-batches', batch.id, 'events');
  const sizes = readdirSync(dir)
    .sort()
    .map((file) => statSync(join(dir, file)).size);
  assert.ok(sizes[0] > 50000);
  assert.ok(
    sizes.slice(1).every((size) => size < 1000),
    'a small update must not copy the entire queue',
  );
  assert.deepEqual(readIntakeBatch(f.root, f.profileId, batch.id), batch);
});

test('three local failures isolate page two and preserve completed and later pages', async (t) => {
  const f = fixture(t, 'source');
  await until(() => {
    f.tick();
    const source = getIntakeSourceText(f.db, f.root, f.profileId, f.source.id);
    return source.status === 'available' && locateSourceExtractionProgress(source).page === 0;
  });
  const source = getIntakeSourceText(f.db, f.root, f.profileId, f.source.id);
  assert.equal(source.status, 'available');
  assert.ok(source.revision!.issues.some((issue) => issue.id === 'p2-processing-stalled'));
  assert.ok(source.revision!.spans.some((span) => span.region.page === 1));
  assert.ok(source.revision!.spans.some((span) => span.region.page === 3));
  f.manager.close();
});

test("finishing one batch preserves another batch's future wake without browser polling", async (t) => {
  const f = fixture(t, 'unknown');
  f.manager.close();
  f.assistant.close();
  const first = f.manager.list(f.profileId)[0]!;
  const otherSource = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-other.txt',
    bytes: Buffer.from('Another independent fictional source.'),
  });
  let schedulerNow = Date.now();
  const second = structuredClone(first);
  second.id = randomUUID();
  second.operationId = 'fictional-other-operation';
  second.items = [
    {
      ...structuredClone(first.items[0]),
      intakeId: otherSource.id,
      sourceHash: otherSource.sha256,
      filename: otherSource.filename,
      retryAt: new Date(schedulerNow + 700).toISOString(),
    },
  ];
  writeIntakeBatch(f.root, f.profileId, second, 'fictional-future-wait');
  const dispatched: string[] = [];
  let current = {
    id: 'fictional-scheduler-chat',
    status: 'idle',
    context: { intakeId: '' },
    reading: {
      status: 'paused' as const,
      reason: 'reading_exhausted',
      turns: 1,
      readyRecords: 0,
      remainingUnits: 0,
      pendingReadWindows: 0,
      coverage: 'reading_progress_only' as const,
    },
  };
  const manager = createIntakeBatchManager({
    root: f.root,
    databases: new Map([[f.profileId, f.db]]),
    pollMs: 1,
    clock: () => new Date(schedulerNow),
    assistant: {
      attachIntakeReadingRequestGuard: () => true,
      create: () => structuredClone(current),
      get: () => structuredClone(current),
      isBusy: () => false,
      cancel() {},
      send: (_profile, _chat, input) => {
        current = { ...current, context: { intakeId: input.context!.intakeId! } };
        dispatched.push(current.context.intakeId);
        return structuredClone(current);
      },
      retry: () => {
        dispatched.push(current.context.intakeId);
        return structuredClone(current);
      },
    },
  });
  try {
    await until(() => manager.get(f.profileId, first.id).status === 'complete');
    schedulerNow += 1000;
    await until(() => dispatched.includes(otherSource.id));
    assert.equal(manager.get(f.profileId, first.id).status, 'complete');
    assert.deepEqual(dispatched, [f.source.id, otherSource.id]);
  } finally {
    manager.close();
  }
});

function pdf() {
  const objects = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
  ];
  for (let i = 0; i < 3; i++) {
    const stream = `BT /F1 12 Tf 72 720 Td (Fictional page ${i + 1} contains independent fictional administrative text with no clinical findings or identifying details.) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  let text = '%PDF-1.4\n',
    offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(text));
    text += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

test('repeated initial-context rejection waits for a repaired prerequisite without clearing intent', async (t) => {
  const f = fixture(t, 'initial');
  const batch = f.manager.list(f.profileId)[0]!;
  await until(() => {
    f.tick();
    return f.manager.get(f.profileId, batch.id).items[0].reason === 'provider_rejected';
  });
  assert.equal(f.calls.length, 2, 'one reduced initial request is tried before requiring a repair');
  assert.equal(f.manager.get(f.profileId, batch.id).items[0].automaticRun, true);
  f.tick(31000);
  f.manager.wake(f.profileId);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.calls.length, 2, 'unchanged invalid input is not sent repeatedly');
  f.fixPrerequisite();
  f.tick(31000);
  f.manager.wake(f.profileId);
  await until(() => {
    f.tick();
    return f.calls.length === 3;
  });
});

test('automatic PDF units after page one can read their exact unit and source passage', async (t) => {
  const f = fixture(t, 'pdf');
  await until(() => {
    f.tick();
    return f.calls.length === 1;
  });
  const batch = f.manager.list(f.profileId)[0]!;
  const current = getIntake(f.db, f.root, f.profileId, f.source.id);
  const plan = current.workflow!.plans[0];
  // Retain a first-group exception so the next dispatch owns later pages.
  const unit = plan.units[0];
  const source = (await f.calls[0].onTool!({
    tool: 'health_intake_source_text',
    arguments: { id: current.id },
    callId: 'first-source',
  })) as { revisionId: string };
  await f.calls[0].onTool!({
    tool: 'health_intake_plan',
    arguments: { id: current.id, action: 'read_unit', unitId: unit.id },
    callId: 'first-unit',
  });
  // This fixture exercises later-unit admission independently of OCR availability.
  const { workflowMutation } = await import('../intake.ts');
  workflowMutation(
    f.db,
    f.root,
    f.profileId,
    current.id,
    { operationId: 'fictional-first-accounted', version: current.version },
    (workflow) => {
      const selected = workflow.plans[0].units[0];
      selected.processingException = { reason: 'processing_stalled', at: new Date().toISOString() };
    },
  );
  f.calls[0].onExit?.(new ModelContextLimitError('Fictional bounded slice ended', 'slice'));
  await until(() => {
    f.tick();
    return f.calls.length === 2;
  });
  const next = f.manager.get(f.profileId, batch.id).items[0].reading!.workUnit!;
  const nextUnit = getIntake(f.db, f.root, f.profileId, current.id).workflow!.plans[0].units.find(
    (unit) => unit.id === next.id,
  )!;
  assert.ok(nextUnit.pages![0] > 1);
  await f.calls[1].onTool!({
    tool: 'health_intake_plan',
    arguments: { id: current.id, action: 'read_unit', unitId: next.id },
    callId: 'later-unit',
  });
  await f.calls[1].onTool!({
    tool: 'health_intake_source_text',
    arguments: { id: current.id, page: nextUnit.pages![0] },
    callId: 'later-source',
  });
  await assert.rejects(
    async () =>
      f.calls[1].onTool!({
        tool: 'health_intake_source_text',
        arguments: { id: current.id, page: 1 },
        callId: 'wrong-source',
      }),
    { code: 'INTAKE_WORK_UNIT_SCOPE' },
  );
  assert.ok(source.revisionId);
});

test('an automatic ZIP media member permits follow-up reads of its verified retained child', async (t) => {
  const f = fixture(t, 'zip');
  await until(() => {
    f.tick();
    return f.calls.length === 1;
  });
  const current = getIntake(f.db, f.root, f.profileId, f.source.id);
  const unit = current.workflow!.plans[0].units[0];
  const { retainIntakeChildren } = await import('../intake.ts');
  const [child] = retainIntakeChildren(f.db, f.root, f.profileId, current.id, [
    { filename: unit.filename!, locator: unit.locator, bytes: pdf() },
  ]);
  publishIntakeSourceText(f.db, f.root, f.profileId, child!.id, {
    operationId: randomUUID(),
    sourceHash: getIntake(f.db, f.root, f.profileId, child!.id).sha256,
    expectedRevisionId: null,
    evidence: {
      adapter: { name: 'fictional-capture', version: '1' },
      pages: [1, 2, 3].map((page) => ({
        page,
        disposition: 'extracted' as const,
        inspected: false,
      })),
      spans: [],
      relations: [],
      issues: [],
    },
  });
  const media = (await f.calls[0].onTool!({
    tool: 'health_intake_package',
    arguments: { id: current.id, action: 'read_member', memberId: unit.memberId, page: 1 },
    callId: 'package-media',
  })) as { metadata: { sourceFileId: string } };
  assert.ok(media.metadata.sourceFileId);
  const text = (await f.calls[0].onTool!({
    tool: 'health_intake_source_text',
    arguments: { id: media.metadata.sourceFileId, page: 1 },
    callId: 'package-source',
  })) as { revisionId: string };
  assert.ok(text.revisionId);
});

test('one explicit Resume restores every previously automatic prerequisite wait', (t) => {
  const f = fixture(t, 'unknown');
  f.manager.close();
  f.assistant.close();
  const saved = f.manager.list(f.profileId)[0]!;
  saved.status = 'running';
  saved.automaticRun = true;
  saved.items[0].status = 'paused';
  saved.items[0].automaticRun = true;
  saved.items[0].reason = 'provider_authentication';
  saved.items[0].retryAt = new Date(Date.now() + 60000).toISOString();
  saved.items.push({
    ...structuredClone(saved.items[0]),
    intakeId: 'fictional-second-prerequisite',
    reason: 'provider_rejected',
    prerequisiteKey: 'unchanged',
  });
  saved.items.push({
    ...structuredClone(saved.items[0]),
    intakeId: 'fictional-historical-review',
    automaticRun: false,
    retryAt: null,
    reason: 'unrecognized_historical_pause',
  });
  writeIntakeBatch(f.root, f.profileId, saved, 'fictional-prerequisite-waits');
  const manager = createIntakeBatchManager({
    root: f.root,
    databases: new Map([[f.profileId, f.db]]),
    assistant: f.assistant,
  });
  try {
    const stopped = manager.stop(f.profileId, saved.id);
    assert.ok(stopped.items.every((item) => item.automaticRun === false));
    manager.stop(f.profileId, saved.id); // Repeated Stop cannot forget the original intent.
    const resumed = manager.resume(f.profileId, saved.id);
    assert.deepEqual(
      resumed.items.map((item) => item.automaticRun),
      [true, true, false],
    );
  } finally {
    manager.close();
  }
});

test('a model-correctable wrong-unit call retries automatically in a fresh scoped slice', async (t) => {
  const f = fixture(t, 'unknown');
  await until(() => {
    f.tick();
    return f.calls.length === 2;
  });
  f.calls[1].onEvent?.('model/requestFinished', {
    requestId: 'fictional-request-2',
    outcome: 'response',
    failed: false,
  });
  await assert.rejects(
    async () =>
      f.calls[1].onTool!({
        tool: 'health_intake_plan',
        arguments: { id: f.source.id, action: 'read_unit', unitId: 'fictional-wrong-unit' },
        callId: 'wrong-unit',
      }),
    { code: 'INTAKE_WORK_UNIT_SCOPE' },
  );
  await until(() => {
    f.tick();
    return f.calls.length === 3;
  });
  const current = getIntake(f.db, f.root, f.profileId, f.source.id);
  const unit = current.workflow!.plans[0].units.find((unit) => !unit.processingException)!;
  await f.calls[2].onTool!({
    tool: 'health_intake_plan',
    arguments: { id: current.id, action: 'read_unit', unitId: unit.id },
    callId: 'repaired-unit',
  });
  assert.equal(f.manager.list(f.profileId)[0].status, 'running');
});

test('repeated local capacity interruptions preserve pending pages without spending the stall streak', async (t) => {
  const f = fixture(t, 'capacity');
  await until(() => {
    f.tick(1001);
    return f.calls.length > 0;
  });
  const item = f.manager.list(f.profileId)[0].items[0];
  f.manager.stop(f.profileId, f.manager.list(f.profileId)[0].id);
  assert.ok(item.sourceExtraction!.steps >= 5);
  assert.equal(item.sourceExtraction!.stalls || 0, 0);
  assert.ok(!item.exceptions?.length);
  assert.equal(
    getIntakeSourceText(f.db, f.root, f.profileId, f.source.id).revision!.issues.some((issue) =>
      issue.id.endsWith('-processing-stalled'),
    ),
    false,
  );
});
