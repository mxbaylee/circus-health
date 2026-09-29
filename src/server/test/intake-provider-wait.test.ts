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
  let sends = 0;
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
    providerRetryBaseMs: 5,
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
test('a retained known rejection resumes only after explicit unlock/resume and its original deadline', async (t) => {
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
  assert.equal(f.manager.get(f.profileId, f.batch.id).status, 'paused');
  assert.equal(f.sends, 1);
  f.manager.resume(f.profileId, f.batch.id);
  await waitFor(() => f.sends === 2);
  assert.ok(f.dispatchTimes[1] >= Date.parse(retryAt), 'restart preserves provider deadline');
  assert.equal(f.manager.get(f.profileId, f.batch.id).items[0].reading?.modelRequests, 7);
});
test('unknown transport outcomes cannot be blindly resumed; authentication pauses without automatic retry', async (t) => {
  for (const classification of ['unknown', 'authentication'] as const) {
    const f = fixture(t);
    await waitFor(() => f.sends === 1);
    f.fail({
      requestId: `fictional-${classification}`,
      outcome: classification === 'unknown' ? 'unknown' : 'rejected',
      classification,
      retryAt: null,
    });
    await waitFor(() => f.manager.get(f.profileId, f.batch.id).status === 'paused');
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(f.sends, 1);
    if (classification === 'unknown')
      assert.throws(() => f.manager.resume(f.profileId, f.batch.id), {
        code: 'INTAKE_REQUEST_OUTCOME_UNKNOWN',
      });
  }
});
test('recurrent rejected attempts reach a named intervention state instead of an endless retry loop', async (t) => {
  const f = fixture(t);
  await waitFor(() => f.sends === 1);
  for (let i = 1; i <= 6; i++) {
    f.fail({
      requestId: `fictional-rejection-${i}`,
      outcome: 'rejected',
      classification: 'transient',
      retryAt: null,
    });
    if (i < 6) await waitFor(() => f.sends === i + 1);
    else await waitFor(() => f.manager.get(f.profileId, f.batch.id).status === 'paused');
  }
  assert.equal(f.sends, 6);
  assert.equal(f.manager.get(f.profileId, f.batch.id).reason, 'provider_retry_limit');
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
