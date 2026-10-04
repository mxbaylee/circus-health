import test, { type TestContext } from 'node:test';
import { fictionalModel } from './fictional-model.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { profilePaths } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import {
  uploadIntake,
  getIntake,
  getIntakeRead,
  proposeConversion,
  reviewIntake,
  prepareIntakeImport,
} from '../intake.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import { readIntakeBatch } from '../intake-batch-journal.ts';
import { getIntakeSourceText } from '../intake-source-text.ts';
import {
  sourceTextExtractionPending,
  extractIntakeSourceText,
} from '../intake-source-extraction.ts';
import type { RecordStorage } from '../record-versions.ts';
import type { IntakeBatchReadingState } from '../../shared/intake-batch.ts';
import { selectedFixtureReview } from './helpers/selected-intake.ts';
import { prepareCurrentIntakeInterpretations } from '../intake-current-interpretations.ts';
import { proposalDependenciesCurrent } from '../intake-proposal-dependencies.ts';
async function waitFor(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), 'fictional runner reached checkpoint');
}
function fixture(t: TestContext, longClock = false) {
  fictionalModel(t);
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
    bytes: Buffer.from(
      'Fictional unstructured recordless material. '.repeat(longClock ? 8500 : 2900),
    ),
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
    reason: 'reading_exhausted',
    turns: 1,
    modelRequests: 1,
    measuredModelTokens: 10,
    modelUsageIncomplete: false,
    readyRecords: 0,
    remainingUnits: 0,
    pendingReadWindows: 0,
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
  let now = Date.now();
  const options = {
    root,
    databases: new Map([[profileId, db]]),
    assistant,
    pollMs: 1,
    continuationDelayMs: 1,
    clock: () => new Date(now),
    extract: async (context: Parameters<typeof extractIntakeSourceText>[0]) => {
      const result = await extractIntakeSourceText(context);
      if (longClock) now += 15000;
      return result;
    },
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

test('local source checkpoints finish fairly before model publication pins are created', async (t) => {
  const f = fixture(t);
  const batch = f.manager.list(f.profileId)[0]!;
  await waitFor(() => f.manager.get(f.profileId, batch.id).status !== 'running');
  assert.equal(f.dispatches.length, 2);
  assert.ok(f.dispatches.every((dispatch) => !dispatch.pending));
  assert.equal(f.dispatches[0].id, f.short.id, 'a short file progresses between long-file pages');
  const source = getIntakeSourceText(f.db, f.root, f.profileId, f.long.id);
  assert.equal(sourceTextExtractionPending(source), false);
  assert.equal(
    source.summary!.inspectedPages,
    0,
    'machine extraction never attests human inspection',
  );
  const saved = readIntakeBatch(f.root, f.profileId, batch.id);
  assert.equal(saved.items[0].sourceExtraction!.steps, source.revision!.pages.length);
});

test('productive local capture exceeds ten steps and 120 seconds without manual Resume', async (t) => {
  const f = fixture(t, true);
  const batch = f.manager.list(f.profileId)[0]!;
  await waitFor(() => f.manager.get(f.profileId, batch.id).status === 'complete');
  const saved = f.manager.get(f.profileId, batch.id).items[0].sourceExtraction!;
  assert.ok(saved.steps > 10);
  assert.ok(saved.spentMs > 120000);
  assert.equal(
    sourceTextExtractionPending(getIntakeSourceText(f.db, f.root, f.profileId, f.long.id)),
    false,
  );
  assert.equal(f.dispatches.length, 2);
  f.reopen();
  assert.equal(f.manager.get(f.profileId, batch.id).status, 'complete');
});

test('an early reviewable proposal does not stop later source capture and reading', async (t) => {
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
  const proposed = proposeConversion(
    f.db,
    f.root,
    f.profileId,
    f.long.id,
    {
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
    },
    { observedSourcePages: [{ intakeId: f.long.id, pages: [1] }] },
  );
  const batch = f.manager.create(f.profileId, {
    operationId: 'fictional-preserve-proposal',
    intakeIds: [f.long.id],
  });
  await waitFor(() => f.manager.get(f.profileId, batch.id).status !== 'running');
  assert.ok(f.dispatches.some((dispatch) => dispatch.id === f.long.id));
  const captured = getIntakeSourceText(f.db, f.root, f.profileId, f.long.id);
  assert.notEqual(captured.revision!.id, before.revision!.id);
  assert.equal(sourceTextExtractionPending(captured), false);
  assert.ok(getIntakeRead(f.db, f.root, f.profileId, f.long.id).version > proposed.version);
  const proposalId = proposed.proposals.at(-1)!.id;
  assert.equal(
    (await selectedFixtureReview(f.db, f.root, f.profileId, f.long.id, proposalId)).sourceTextStale,
    false,
  );
  assert.ok(
    (await prepareCurrentIntakeInterpretations(f.db, f.profileId, f.long.id)).hasCurrentProposal,
  );
  assert.equal(proposalDependenciesCurrent(f.db, proposalId), true);
});

test('an unrelated source append preserves a measured proposal review token', async (t) => {
  const f = fixture(t);
  await extractIntakeSourceText({
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    id: f.long.id,
    maxPages: 2,
  });
  const current = getIntake(f.db, f.root, f.profileId, f.long.id);
  const proposed = proposeConversion(
    f.db,
    f.root,
    f.profileId,
    f.long.id,
    {
      version: current.version,
      summary: 'Fictional first page context',
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-first-page-context',
        kind: 'context',
        payload: { text: 'Fictional context.' },
        provenance: {
          capturedVia: 'Fictional',
          sourceSystem: null,
          sourceRecordId: null,
          evidenceClass: 'transcription',
          locator: 'section 1',
        },
        coverage: { status: 'partial', notes: ['Later sections remain.'] },
      }),
    },
    { observedSourcePages: [{ intakeId: f.long.id, pages: [1] }] },
  );
  const proposalId = proposed.proposals.at(-1)!.id;
  const before = reviewIntake(f.db, f.root, f.profileId, f.long.id, proposalId);
  for (let count = 0; count < 100; count++) {
    const source = getIntakeSourceText(f.db, f.root, f.profileId, f.long.id);
    if (!sourceTextExtractionPending(source)) break;
    await extractIntakeSourceText({
      db: f.db,
      root: f.root,
      profileId: f.profileId,
      id: f.long.id,
      maxPages: 2,
    });
  }
  const after = reviewIntake(f.db, f.root, f.profileId, f.long.id, proposalId);
  assert.equal(after.sourceTextStale, false);
  assert.equal(after.reviewToken, before.reviewToken);
  assert.doesNotThrow(() =>
    prepareIntakeImport(f.db, f.root, f.profileId, f.long.id, {
      version: after.version,
      proposalId,
      reviewToken: before.reviewToken,
      decisions: [],
    }),
  );
});
