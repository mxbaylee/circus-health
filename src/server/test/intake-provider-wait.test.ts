import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError, openDatabase } from '../database.ts';
import { profilePaths } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, getRetainedIntakeOriginalReference } from '../intake.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import { readIntakeBatch, writeIntakeBatch } from '../intake-batch-journal.ts';
import type { RecordStorage } from '../record-versions.ts';
import { getIntakeSourceText } from '../intake-source-text.ts';
import type { IntakeBatchReadingState, IntakeProviderWait } from '../../shared/intake-batch.ts';
async function waitFor(check: () => boolean) {
  const end = Date.now() + 2500;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check());
}
function fixture(
  t: TestContext,
  sourceFailure: boolean | 'retain-only' = false,
  journalFault?: (reason: string) => void,
  randomValue = 1,
  retryBaseMs = 5,
) {
  const root = mkdtempSync(join(tmpdir(), 'circus-provider-wait-')),
    profileId = 'fictional-wait';
  const db = openDatabase(profilePaths(root, profileId).database, profileId);
  const objects = new Map<string, Buffer>();
  const recordStorage: RecordStorage = {
    read: (name) => objects.get(name) || null,
    writeImmutable: (name, value) => {
      assert.ok(!objects.has(name));
      objects.set(name, Buffer.from(value));
    },
    publishHead: (value) => objects.set('head', Buffer.from(value)),
  };
  attachPersonalDurability(db, { root, profileId, ...(sourceFailure ? { recordStorage } : {}) });
  const source = uploadIntake(db, root, profileId, {
    filename: sourceFailure === 'retain-only' ? 'fictional.dcm' : 'fictional.txt',
    bytes: Buffer.from('Fictional Rowan source only.'),
  });
  let prerequisite = 'fictional-credential-1';
  let sends = 0,
    elapsed = 0;
  const dispatchTimes: number[] = [];
  const reading: IntakeBatchReadingState = {
    status: 'paused',
    reason: null,
    turns: 1,
    modelRequests: 7,
    measuredModelTokens: 81,
    modelUsageIncomplete: true,
    readyRecords: 0,
    remainingUnits: 1,
    pendingReadWindows: 1,
    readWindows: 0,
    accountedUnits: 0,
    coverage: 'reading_progress_only',
  };
  const chat = {
    id: 'fictional-chat',
    status: 'idle',
    context: { intakeId: source.id },
    reading,
    error: null as string | null,
  };
  const start = () => {
    sends++;
    dispatchTimes.push(Date.now());
    chat.status = 'running';
    chat.reading.providerWait = null;
    return structuredClone(chat);
  };
  const assistant = {
    get: () => structuredClone(chat),
    isBusy: () => chat.status === 'running',
    create: () => structuredClone(chat),
    send: start,
    retry: start,
    attachIntakeReadingRequestGuard: () => true,
    cancel: () => {
      chat.status = 'cancelled';
    },
  };
  const options = {
    root,
    databases: new Map([[profileId, db]]),
    assistant,
    pollMs: 2,
    clock: () => new Date(Date.now() + elapsed),
    providerRetryBaseMs: retryBaseMs,
    providerPrerequisiteKey: () => prerequisite,
    random: () => randomValue,
    continuationDelayMs: 1,
    journalWriter: (
      root: string,
      profileId: string,
      batch: Parameters<typeof writeIntakeBatch>[2],
      reason: string,
    ) => {
      journalFault?.(reason);
      writeIntakeBatch(root, profileId, batch, reason);
      if (sourceFailure === true && reason === 'source-extraction-started')
        writeFileSync(
          getRetainedIntakeOriginalReference(db, root, profileId, source.id).path,
          'Fictional changed original',
        );
    },
  };
  let manager = createIntakeBatchManager(options);
  t.after(() => {
    manager.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const batch = manager.create(profileId, {
    operationId: 'fictional-wait-start',
    intakeIds: [source.id],
  });
  return {
    root,
    db,
    profileId,
    chat,
    batch,
    dispatchTimes,
    now: () => Date.now() + elapsed,
    restoreConnection: () => {
      prerequisite = 'fictional-credential-2';
    },
    advance: (ms: number) => {
      elapsed += ms;
    },
    get manager() {
      return manager;
    },
    get sends() {
      return sends;
    },
    fail(wait: IntakeProviderWait) {
      chat.status = 'failed';
      chat.error = 'No error-text classification required';
      chat.reading.providerWait = wait;
    },
    reopen() {
      manager.close('profile_locked');
      manager = createIntakeBatchManager(options);
    },
    reopenWith(batch: Parameters<typeof writeIntakeBatch>[2]) {
      manager.close('profile_locked');
      writeIntakeBatch(root, profileId, batch, 'fictional-completed');
      manager = createIntakeBatchManager(options);
    },
  };
}
test('known quota rejections persist a wait before retry without resetting unknown costs', async (t) => {
  const f = fixture(t);
  await waitFor(() => f.sends === 1);
  const retryAt = new Date(Date.now() + 100).toISOString();
  f.fail({ requestId: 'fictional-quota', outcome: 'rejected', classification: 'quota', retryAt });
  await waitFor(
    () => f.manager.get(f.profileId, f.batch.id).items[0].reason === 'waiting_for_provider',
  );
  const saved = readIntakeBatch(f.root, f.profileId, f.batch.id).items[0];
  assert.equal(saved.providerWait?.retryAt, retryAt);
  assert.equal(saved.reading?.modelUsageIncomplete, true);
  assert.equal(saved.reading?.measuredModelTokens, 81);
  await waitFor(() => f.sends === 2);
  assert.ok(f.dispatchTimes[1] >= Date.parse(retryAt), 'never dispatch before provider deadline');
  f.manager.stop(f.profileId, f.batch.id);
});
test('a retained rejection resumes after authorized unlock at its original deadline', async (t) => {
  const f = fixture(t);
  await waitFor(() => f.sends === 1);
  const retryAt = new Date(Date.now() + 300).toISOString();
  f.fail({
    requestId: 'fictional-restart-quota',
    outcome: 'rejected',
    classification: 'quota',
    retryAt,
  });
  await waitFor(
    () => f.manager.get(f.profileId, f.batch.id).items[0].reason === 'waiting_for_provider',
  );
  f.reopen();
  assert.equal(f.manager.get(f.profileId, f.batch.id).status, 'running');
  assert.equal(f.sends, 1);
  await waitFor(() => f.sends === 2);
  assert.ok(f.dispatchTimes[1] >= Date.parse(retryAt), 'restart preserves provider deadline');
  assert.equal(f.manager.get(f.profileId, f.batch.id).items[0].reading?.modelRequests, 7);
});
test('unknown outcomes retry automatically while authentication waits for the prerequisite', async (t) => {
  for (const classification of ['unknown', 'authentication'] as const) {
    const f = fixture(t);
    await waitFor(() => f.sends === 1);
    f.fail({
      requestId: 'fictional-' + classification,
      outcome: classification === 'unknown' ? 'unknown' : 'rejected',
      classification,
      retryAt: null,
    });
    if (classification === 'unknown') await waitFor(() => f.sends === 2);
    else {
      await waitFor(
        () => f.manager.get(f.profileId, f.batch.id).items[0].reason === 'provider_authentication',
      );
      assert.equal(f.manager.get(f.profileId, f.batch.id).status, 'running');
      assert.equal(f.sends, 1);
    }
    f.manager.stop(f.profileId, f.batch.id);
  }
});
test('Stop keeps a waiting file resumable even when the cursor has passed it', async (t) => {
  const f = fixture(t);
  await waitFor(() => f.sends === 1);
  const second = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-finished.txt',
    bytes: Buffer.from('Fictional second file'),
  });
  f.manager.create(f.profileId, {
    operationId: 'fictional-second-file',
    intakeIds: [second.id],
    appendToRunning: true,
  });
  f.fail({
    requestId: 'fictional-waiting',
    outcome: 'rejected',
    classification: 'quota',
    retryAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await waitFor(
    () => f.manager.get(f.profileId, f.batch.id).items[0].reason === 'waiting_for_provider',
  );
  const live = f.manager.get(f.profileId, f.batch.id);
  live.items[1].status = 'review_ready';
  live.items[1].automaticRun = false;
  live.currentIndex = live.items.length;
  writeIntakeBatch(f.root, f.profileId, live, 'fictional-second-complete');
  const stopped = f.manager.stop(f.profileId, f.batch.id);
  assert.equal(stopped.items[0].status, 'paused');
  assert.equal(stopped.items[0].reason, 'stopped');
  f.reopen();
  const resumed = f.manager.resume(f.profileId, f.batch.id);
  assert.equal(resumed.items[0].automaticRun, true);
  assert.equal(resumed.items[0].status, 'queued');
});
test('create reports whether a stopped or completed selection actually scheduled work', async (t) => {
  const f = fixture(t);
  await waitFor(() => f.sends === 1);
  f.manager.stop(f.profileId, f.batch.id);
  const restarted = f.manager.create(f.profileId, {
    operationId: 'fictional-reprocess-stopped',
    intakeIds: [f.batch.items[0].intakeId],
  });
  assert.equal(restarted.scheduled, true);
  assert.equal(restarted.status, 'running');
  f.manager.stop(f.profileId, f.batch.id);
  const completed = f.manager.get(f.profileId, f.batch.id);
  completed.status = 'complete';
  completed.items[0].status = 'review_ready';
  completed.items[0].reason = 'bounded_pass_ready';
  completed.items[0].resumeAutomaticRun = false;
  completed.items[0].automaticRun = false;
  completed.automaticRun = false;
  f.reopenWith(completed);
  const noWork = f.manager.create(f.profileId, {
    operationId: 'fictional-reprocess-complete',
    intakeIds: [f.batch.items[0].intakeId],
  });
  assert.equal(noWork.scheduled, false);
});
test('authentication waits for a changed prerequisite after the retry deadline', async (t) => {
  const f = fixture(t);
  await waitFor(() => f.sends === 1);
  f.fail({
    requestId: 'fictional-auth',
    outcome: 'rejected',
    classification: 'authentication',
    retryAt: null,
  });
  await waitFor(
    () => f.manager.get(f.profileId, f.batch.id).items[0].reason === 'provider_authentication',
  );
  f.advance(31_000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.sends, 1, 'a known-rejected credential must not be sent again');
  f.restoreConnection();
  f.manager.wake(f.profileId);
  await waitFor(() => f.sends === 2);
  f.manager.stop(f.profileId, f.batch.id);
});
test('eight consecutive transient rejections recover without spending a local stall allowance', async (t) => {
  const f = fixture(t);
  await waitFor(() => f.sends === 1);
  for (let i = 1; i <= 8; i++) {
    f.fail({
      requestId: 'fictional-rejection-' + i,
      outcome: 'rejected',
      classification: 'transient',
      retryAt: null,
    });
    await waitFor(() => f.sends === i + 1);
  }
  const item = f.manager.get(f.profileId, f.batch.id).items[0];
  assert.equal(f.sends, 9);
  assert.equal(item.providerWait?.attempts, 8);
  assert.equal(item.stalls?.attempts || 0, 0, 'provider waiting is not failed local work');
  f.manager.stop(f.profileId, f.batch.id);
});
test('provider backoff grows with both equal-jitter extremes and reaches its cap', async (t) => {
  for (const random of [0, 1]) {
    const f = fixture(t, false, undefined, random, 5_000);
    await waitFor(() => f.sends === 1);
    for (let attempt = 1; attempt <= 9; attempt++) {
      const before = f.now();
      f.fail({
        requestId: `fictional-jitter-${random}-${attempt}`,
        outcome: 'rejected',
        classification: 'transient',
        retryAt: null,
      });
      await waitFor(
        () => f.manager.get(f.profileId, f.batch.id).items[0].providerWait?.attempts === attempt,
      );
      const wait = f.manager.get(f.profileId, f.batch.id).items[0].providerWait!;
      const capped = Math.min(300_000, 5_000 * 2 ** Math.min(attempt - 1, 6));
      const expected = Math.round(capped * (0.5 + random / 2));
      assert.ok(Math.abs(Date.parse(wait.retryAt!) - before - expected) < 100);
      f.advance(expected + 100);
      f.manager.wake(f.profileId);
      await waitFor(() => f.sends === attempt + 1);
    }
    f.manager.stop(f.profileId, f.batch.id);
  }
});

test('default production jobs continue productive slices past the former total-slice allowance', async (t) => {
  const f = fixture(t);
  await waitFor(() => f.sends === 1);
  for (let i = 1; i <= 18; i++) {
    f.chat.reading.readWindows = i;
    f.chat.reading.reason = 'time_limit';
    f.chat.reading.turns = i;
    f.chat.status = 'idle';
    await waitFor(() => f.sends === i + 1);
  }
  const item = f.manager.get(f.profileId, f.batch.id).items[0];
  assert.equal(item.readingJob?.limitPolicy, 'progress-window');
  assert.equal(item.readingJob?.slices, 19);
  assert.equal(item.readingJob?.extensions, 0);
  assert.ok((item.readingJob?.progressWindows || 0) >= 18);
  f.manager.stop(f.profileId, f.batch.id);
});
test('legacy cumulative budget starts a fresh request window after restart', async (t) => {
  const f = fixture(t);
  await waitFor(() => f.sends === 1);
  const saved = f.manager.get(f.profileId, f.batch.id);
  assert.ok(saved.items[0].readingJob);
  saved.items[0].readingJob!.limitPolicy = 'cumulative';
  saved.items[0].readingJob!.activeMs = 900_000;
  saved.items[0].readingJob!.budgetAtActiveMs = 0;
  saved.items[0].readingJob!.budgetAtResponses = 0;
  saved.items[0].stalls = { unitId: 'fictional-unit', locator: 'Page 1', attempts: 0 };
  f.reopenWith(saved);
  const recovered = f.manager.get(f.profileId, f.batch.id).items[0];
  assert.equal(recovered.readingJob?.limitPolicy, 'progress-window');
  assert.equal(recovered.readingJob?.budgetAtActiveMs, recovered.readingJob?.activeMs);
  assert.equal(recovered.stalls?.attempts, 0);
});
test('a slow productive fake route completes without a model-speed stall', async (t) => {
  const f = fixture(t);
  await waitFor(() => f.sends === 1);
  for (let response = 1; response <= 3; response++) {
    f.advance(600_000);
    f.chat.reading.modelRequests = 7 + response;
    f.chat.reading.usableModelResponses = response;
    f.chat.reading.readWindows = response;
    f.chat.reading.reason = response === 3 ? 'reading_exhausted' : 'time_limit';
    f.chat.reading.remainingUnits = response === 3 ? 0 : 1;
    f.chat.reading.pendingReadWindows = response === 3 ? 0 : 1;
    f.chat.status = 'idle';
    if (response < 3) await waitFor(() => f.sends === response + 1);
  }
  await waitFor(() => f.manager.get(f.profileId, f.batch.id).status === 'complete');
  const item = f.manager.get(f.profileId, f.batch.id).items[0];
  assert.equal(item.stalls?.attempts || 0, 0);
  assert.equal(item.exceptions?.length || 0, 0);
});

test('an extraction failure while queued leaves an actionable paused item, never a stranded queued row', async (t) => {
  const f = fixture(t, true);
  await waitFor(() => f.manager.get(f.profileId, f.batch.id).status === 'paused');
  const batch = f.manager.get(f.profileId, f.batch.id);
  assert.equal(batch.items[0].status, 'paused');
  assert.equal(batch.items[0].reason, 'source_changed');
  assert.equal(f.sends, 0);
});

test('a failed capacity-wait journal stops work without an unhandled rejection or retry', async (t) => {
  const reasons: string[] = [];
  const f = fixture(t, true, (reason) => {
    reasons.push(reason);
    // Inject the same named local-admission failure at the pump boundary.
    if (reason === 'source-extraction-started')
      throw new HttpError(429, 'SOURCE_EXTRACTION_BUSY', 'Fictional occupied workers');
    if (reason === 'source-extraction-capacity-wait') throw Error('Fictional journal unavailable');
  });
  await waitFor(() => f.manager.get(f.profileId, f.batch.id).status === 'paused');
  assert.ok(reasons.includes('source-extraction-capacity-wait'));
  assert.ok(reasons.includes('runner-paused'));
  assert.equal(f.manager.get(f.profileId, f.batch.id).items[0].status, 'paused');
  assert.equal(f.manager.get(f.profileId, f.batch.id).reason, 'runner_error');
  await new Promise((r) => setTimeout(r, 1050));
  assert.equal(reasons.filter((r) => r === 'source-extraction-started').length, 1);
  assert.equal(f.sends, 0);
});

test('retain-only batch sources retain an explicit limitation and never dispatch a model', async (t) => {
  const f = fixture(t, 'retain-only');
  await waitFor(() => f.manager.get(f.profileId, f.batch.id).items[0].status === 'skipped');
  const item = f.manager.get(f.profileId, f.batch.id).items[0];
  assert.equal(item.reason, 'retain_only');
  assert.equal(f.sends, 0);
  const source = getIntakeSourceText(f.db, f.root, f.profileId, item.intakeId);
  assert.equal(source.revision!.pages[0].disposition, 'unsupported');
  assert.ok(source.revision!.issues.some((i) => i.detail.includes('retain-only')));
});

test('shared model-tool prerequisite waits never consume the active source-stall window', async (t) => {
  const f = fixture(t);
  await waitFor(() => f.sends === 1);
  for (let cycle = 1; cycle <= 4; cycle++) {
    f.advance(180001);
    f.chat.reading.reason = 'source_prerequisite';
    f.chat.status = 'idle';
    await waitFor(
      () => f.manager.get(f.profileId, f.batch.id).items[0].reason === 'source_prerequisite',
    );
    const item = f.manager.get(f.profileId, f.batch.id).items[0];
    assert.equal(item.stalls?.attempts || 0, 0);
    assert.equal(item.reading?.usableModelResponses || 0, item.readingJob?.budgetAtResponses || 0);
    f.advance(30001);
    f.manager.wake(f.profileId);
    await waitFor(() => f.sends === cycle + 1);
  }
  assert.ok(f.manager.get(f.profileId, f.batch.id).items[0].readingJob!.activeMs > 4 * 180000);
});

// Old Stop cleared every automatic flag but marked only the cursor item stopped.
// Decode all remaining queued work without resuming human review or completed files.
test('legacy stopped journals restore every automatic item after restart', async (t) => {
  const f = fixture(t);
  await waitFor(() => f.sends === 1);
  f.manager.stop(f.profileId, f.batch.id);
  const legacy = f.manager.get(f.profileId, f.batch.id);
  const template = structuredClone(legacy.items[0]);
  legacy.items = Array.from({ length: 5 }, (_, index) => {
    const source = uploadIntake(f.db, f.root, f.profileId, {
      filename: `fictional-legacy-${index}.txt`,
      bytes: Buffer.from(`Fictional legacy source ${index}`),
    });
    const item = { ...structuredClone(template), intakeId: source.id };
    delete item.resumeAutomaticRun;
    item.automaticRun = false;
    item.chatId = null;
    item.status = index < 2 ? 'queued' : index === 3 ? 'review_ready' : 'paused';
    item.reason =
      index === 0
        ? 'waiting_for_provider'
        : index === 1
          ? null
          : index === 2
            ? 'stopped'
            : index === 3
              ? 'bounded_pass_ready'
              : 'source_review_required';
    return item;
  });
  legacy.currentIndex = 2;
  f.reopenWith(legacy);
  const decoded = f.manager.get(f.profileId, f.batch.id);
  assert.equal(decoded.status, 'stopped');
  assert.deepEqual(
    decoded.items.slice(0, 3).map((item) => item.reason),
    ['stopped', 'stopped', 'stopped'],
  );
  const resumed = f.manager.resume(f.profileId, f.batch.id);
  assert.equal(resumed.currentIndex, 0);
  assert.deepEqual(
    resumed.items.map((item) => item.automaticRun),
    [true, true, true, false, false],
  );
  assert.deepEqual(
    resumed.items.map((item) => item.status),
    ['queued', 'queued', 'queued', 'review_ready', 'paused'],
  );
});
