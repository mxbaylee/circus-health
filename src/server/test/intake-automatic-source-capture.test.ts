import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { profilePaths } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, getIntake, proposeConversion } from '../intake.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import { readIntakeBatch } from '../intake-batch-journal.ts';
import { getIntakeSourceText } from '../intake-source-text.ts';
import {
  sourceTextExtractionPending,
  extractIntakeSourceText,
} from '../intake-source-extraction.ts';
import type { RecordStorage } from '../record-versions.ts';
import type { IntakeBatchReadingState } from '../../shared/intake-batch.ts';
async function waitFor(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), 'fictional runner reached checkpoint');
}
function fixture(t: TestContext, limits = { steps: 10, elapsedMs: 120000 }) {
  const root = mkdtempSync(join(tmpdir(), 'circus-auto-source-')),
    profileId = 'fictional-auto-source';
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
  attachPersonalDurability(db, { root, profileId, recordStorage });
  const long = uploadIntake(db, root, profileId, {
    filename: 'fictional-long.txt',
    bytes: Buffer.from('Fictional unstructured recordless material. '.repeat(2900)),
  });
  const short = uploadIntake(db, root, profileId, {
    filename: 'fictional-short.txt',
    bytes: Buffer.from('Fictional unrelated source.'),
  });
  const chats = new Map<
    string,
    { id: string; status: string; context: { intakeId: string }; reading: IntakeBatchReadingState }
  >();
  const dispatches: { id: string; pending: boolean; pages: number }[] = [];
  const reading: IntakeBatchReadingState = {
    status: 'paused',
    reason: 'no_progress',
    turns: 1,
    modelRequests: 1,
    measuredModelTokens: 10,
    modelUsageIncomplete: false,
    readyRecords: 0,
    remainingUnits: 1,
    pendingReadWindows: 1,
    readWindows: 0,
    accountedUnits: 0,
    coverage: 'reading_progress_only',
  };
  const assistant = {
    get: (_p: string, id: string) => structuredClone(chats.get(id)!),
    isBusy: () => false,
    create: (_p: string, input: { context: { intakeId: string } }) => {
      const chat = {
        id: `chat-${chats.size}`,
        status: 'idle',
        context: input.context,
        reading: structuredClone(reading),
      };
      chats.set(chat.id, chat);
      return structuredClone(chat);
    },
    send: (_p: string, id: string) => {
      const chat = chats.get(id)!;
      const text = getIntakeSourceText(db, root, profileId, chat.context.intakeId);
      dispatches.push({
        id: chat.context.intakeId,
        pending: sourceTextExtractionPending(text),
        pages: text.revision?.pages.length || 0,
      });
      return structuredClone(chat);
    },
    retry: (_p: string, id: string) => structuredClone(chats.get(id)!),
    attachIntakeReadingRequestGuard: () => true,
    cancel: () => {},
  };
  const options = {
    root,
    databases: new Map([[profileId, db]]),
    assistant,
    pollMs: 1,
    continuationDelayMs: 1,
    sourceCaptureLimits: limits,
  };
  let manager = createIntakeBatchManager(options);
  t.after(() => {
    manager.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    db,
    profileId,
    long,
    short,
    dispatches,
    get manager() {
      return manager;
    },
    reopen() {
      manager.close('profile_locked');
      manager = createIntakeBatchManager(options);
    },
  };
}

test('recordless imports capture two sections before model, then drain locally and continue other files', async (t) => {
  const f = fixture(t);
  const batch = f.manager.create(f.profileId, {
    operationId: 'fictional-auto-drain',
    intakeIds: [f.long.id, f.short.id],
  });
  await waitFor(() => f.manager.get(f.profileId, batch.id).status !== 'running');
  assert.equal(f.dispatches.length, 2);
  assert.equal(
    f.dispatches[0].pending,
    true,
    'whole-document capture does not gate clinical model start',
  );
  assert.ok(f.dispatches[0].pages > 2);
  const source = getIntakeSourceText(f.db, f.root, f.profileId, f.long.id);
  assert.equal(sourceTextExtractionPending(source), false);
  assert.equal(source.summary!.inspectedPages, 0, 'extraction does not attest human inspection');
  const saved = readIntakeBatch(f.root, f.profileId, batch.id);
  assert.equal(
    saved.items[0].sourceExtraction!.steps,
    Math.ceil(source.revision!.pages.length / 2),
  );
  assert.equal(saved.items[0].reason, 'no_progress');
  assert.equal(saved.items[1].intakeId, f.short.id);
});

test('bounded source allowance persists across reload, continues unrelated files and extends only explicitly', async (t) => {
  const f = fixture(t, { steps: 1, elapsedMs: 120000 });
  const batch = f.manager.create(f.profileId, {
    operationId: 'fictional-auto-cap',
    intakeIds: [f.long.id, f.short.id],
  });
  await waitFor(() => f.manager.get(f.profileId, batch.id).status !== 'running');
  const first = readIntakeBatch(f.root, f.profileId, batch.id).items[0];
  assert.equal(first.reason, 'source_review_required');
  assert.equal(first.sourceExtraction!.steps, 1);
  assert.equal(first.sourceExtraction!.draining, true);
  assert.equal(f.dispatches.length, 2, 'source cap does not stall unrelated source');
  assert.equal(
    sourceTextExtractionPending(getIntakeSourceText(f.db, f.root, f.profileId, f.long.id)),
    true,
  );
  f.reopen();
  assert.deepEqual(
    f.manager.get(f.profileId, batch.id).items[0].sourceExtraction,
    first.sourceExtraction,
  );
  // Explicitly queue just the unfinished source; its existing terminal chat must not rerun.
  const continuation = f.manager.create(f.profileId, {
    operationId: 'fictional-explicit-source-continuation',
    intakeIds: [f.long.id],
  });
  await waitFor(() => f.manager.get(f.profileId, continuation.id).status !== 'running');
  assert.equal(
    f.dispatches.length,
    2,
    'existing terminal conversion is not rerun for source capture',
  );
  const before = f.manager.get(f.profileId, continuation.id).items[0].sourceExtraction!;
  f.manager.resume(f.profileId, continuation.id);
  await waitFor(() => f.manager.get(f.profileId, continuation.id).status !== 'running');
  const after = f.manager.get(f.profileId, continuation.id).items[0].sourceExtraction!;
  assert.ok(after.steps > before.steps);
  assert.ok(after.spentMs >= before.spentMs);
  assert.notEqual(after.allowanceId, before.allowanceId);
  assert.equal(
    sourceTextExtractionPending(getIntakeSourceText(f.db, f.root, f.profileId, f.long.id)),
    false,
  );
  assert.equal(f.dispatches.length, 2);
});

test('an existing reviewable proposal prevents automatic text continuation from staling its pins', async (t) => {
  const f = fixture(t);
  await extractIntakeSourceText({
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    id: f.long.id,
    maxPages: 2,
  });
  const before = getIntakeSourceText(f.db, f.root, f.profileId, f.long.id);
  assert.equal(sourceTextExtractionPending(before), true);
  const intake = getIntake(f.db, f.root, f.profileId, f.long.id);
  const proposed = proposeConversion(f.db, f.root, f.profileId, f.long.id, {
    version: intake.version,
    summary: 'Fictional context only',
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'context-only',
      kind: 'context',
      payload: { text: 'Fictional source context retained.' },
      provenance: {
        capturedVia: 'Fictional',
        sourceSystem: null,
        sourceRecordId: null,
        evidenceClass: 'transcription',
        locator: 'section 1',
      },
      coverage: { status: 'partial', notes: ['Other sections remain.'] },
    }),
  });
  const batch = f.manager.create(f.profileId, {
    operationId: 'fictional-preserve-proposal',
    intakeIds: [f.long.id],
  });
  await waitFor(() => f.manager.get(f.profileId, batch.id).status !== 'running');
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.manager.get(f.profileId, batch.id).items[0].status, 'review_ready');
  assert.equal(
    getIntakeSourceText(f.db, f.root, f.profileId, f.long.id).revision!.id,
    before.revision!.id,
  );
  assert.equal(getIntake(f.db, f.root, f.profileId, f.long.id).version, proposed.version);
});
