import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { attachRecordDurability } from '../record-versions.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import {
  currentIntakeInterpretations,
  getIntake,
  proposeConversion,
  reviewIntake,
  uploadIntake,
} from '../intake.ts';
import { extractIntakeSourceText } from '../intake-source-extraction.ts';
import { reviewIntakeSourceText } from '../intake-source-text.ts';
import { fictionalModel } from './fictional-model.ts';

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), 'Fictional coordinator did not reach the expected state');
}

for (const kind of ['ready-original', 'existing-proposal'] as const)
  test(`${kind}: corrected evidence must be reread, stale output cannot finish review-ready, and fresh replacement stops rereading`, async (t) => {
    fictionalModel(t);
    const root = mkdtempSync(join(tmpdir(), 'fictional-source-batch-'));
    const profileId = 'fictional-source-batch';
    const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    const objects = new Map<string, Buffer>();
    attachRecordDurability(db, {
      profileId,
      storage: {
        read: (name) => objects.get(name) || null,
        writeImmutable: (name, bytes) => {
          assert.ok(!objects.has(name));
          objects.set(name, Buffer.from(bytes));
        },
        publishHead: (bytes) => objects.set('head', Buffer.from(bytes)),
      },
    });
    const jsonlText = JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-batch-value',
      kind: 'record',
      payload: { literal: '12.00' },
      provenance: {
        capturedVia: 'Fictional delivery',
        sourceSystem: 'Fictional clinic',
        sourceRecordId: 'fictional-batch-value',
        evidenceClass: 'provider_export',
        locator: 'page 1',
      },
      coverage: { status: 'complete_response', notes: [] },
      clinical: {
        kind: 'observation',
        subject: 'self',
        testLabel: 'Fictional example',
        valueText: '12.00',
        unit: 'mg',
        date: '2026-09',
      },
    });
    const source = uploadIntake(db, root, profileId, {
      filename: kind === 'ready-original' ? 'fictional.jsonl' : 'fictional.txt',
      bytes: Buffer.from(
        kind === 'ready-original' ? jsonlText : 'Fictional source value 12.00 mg.',
      ),
      newProviderName: 'Fictional clinic',
    });
    const extracted = await extractIntakeSourceText({ db, root, profileId, id: source.id });
    const propose = () =>
      proposeConversion(db, root, profileId, source.id, {
        version: getIntake(db, root, profileId, source.id).version,
        jsonlText,
        summary: 'Fictional interpretation',
      });
    if (kind === 'existing-proposal') propose();
    const oldProposal = getIntake(db, root, profileId, source.id).proposals.at(-1)?.id ?? null;
    let sends = 0;
    const chat = {
      id: 'fictional-chat',
      status: 'idle',
      context: { intakeId: source.id },
      error: null as string | null,
    };
    const dispatch = () => {
      sends++;
      chat.status = 'running';
      return structuredClone(chat);
    };
    const manager = createIntakeBatchManager({
      root,
      databases: new Map([[profileId, db]]),
      pollMs: 2,
      assistant: {
        get: () => structuredClone(chat),
        isBusy: () => chat.status === 'running',
        create: () => structuredClone(chat),
        send: dispatch,
        retry: dispatch,
        attachIntakeReadingRequestGuard: () => true,
        cancel: () => {
          chat.status = 'cancelled';
        },
      },
    });
    t.after(() => {
      manager.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const start = () =>
      manager.create(profileId, { operationId: randomUUID(), intakeIds: [source.id] });
    const initialBatch = start();
    await waitFor(() => manager.get(profileId, initialBatch.id).status === 'complete');
    assert.equal(manager.get(profileId, initialBatch.id).items[0].status, 'review_ready');
    assert.equal(sends, 0, 'Current evidence should preserve the no-reread shortcut');

    reviewIntakeSourceText(
      db,
      root,
      profileId,
      source.id,
      {
        operationId: randomUUID(),
        expectedRevisionId: extracted.sourceText.revision!.id,
        sourceHash: source.sha256,
        action: 'correct',
        scope: { page: 1 },
        spans: [
          {
            id: 'fictional-correction',
            text: 'Fictional source value 21.00 mg.',
            region: { page: 1 },
            provenance: 'human',
          },
        ],
      },
      'profile-owner',
    );
    assert.equal(reviewIntake(db, root, profileId, source.id, oldProposal).sourceTextStale, true);
    assert.deepEqual(currentIntakeInterpretations(db, profileId, source.id), {
      original: false,
      proposalIds: [],
    });
    const correctedBatch = start();
    await waitFor(() => sends === 1);
    assert.equal(manager.get(profileId, correctedBatch.id).items[0].status, 'running');
    // A reader that produces no replacement has not repaired stale clinical output.
    chat.status = 'idle';
    await waitFor(() => manager.get(profileId, correctedBatch.id).status === 'complete');
    assert.equal(manager.get(profileId, correctedBatch.id).items[0].status, 'paused');

    const failedBatch = start();
    await waitFor(() => sends === 2);
    chat.status = 'failed';
    chat.error = 'Fictional provider unavailable';
    await waitFor(() => manager.get(profileId, failedBatch.id).status === 'paused');
    assert.equal(manager.get(profileId, failedBatch.id).items[0].status, 'paused');
    assert.equal(manager.get(profileId, failedBatch.id).items[0].reason, 'model_unavailable');

    // Identical clinical JSON can legitimately remain after rereading changed evidence,
    // but it must receive a fresh dependency-bound proposal and review version.
    const fresh = propose().proposals.at(-1)!;
    assert.notEqual(fresh.id, oldProposal);
    assert.equal(reviewIntake(db, root, profileId, source.id, fresh.id).sourceTextStale, false);
    const freshBatch = start();
    await waitFor(() => manager.get(profileId, freshBatch.id).status === 'complete');
    assert.equal(manager.get(profileId, freshBatch.id).items[0].status, 'review_ready');
    assert.equal(sends, 2, 'Fresh replacement must avoid an endless rereading loop');
  });
