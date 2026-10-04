import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, on } from 'node:events';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import { writeIntakeBatch, cloneIntakeBatch } from '../intake-batch-journal.ts';
import type { IntakeBatch } from '../../shared/intake-batch.ts';
import {
  ensureNativeIntakeSchema,
  getIntakeRead,
  proposeConversionRead,
  reviewIntakeRead,
  uploadIntake,
} from '../intake.ts';
import { extractIntakeSourceText } from '../intake-source-extraction.ts';
import { reviewIntakeSourceText } from '../intake-source-text.ts';
import { fictionalModel } from './fictional-model.ts';
import { prepareCurrentIntakeInterpretations } from '../intake-current-interpretations.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { isIntakeSummary } from '../../shared/intake-summary.ts';

for (const kind of ['ready-original', 'existing-proposal'] as const)
  for (const outcome of ['current', 'empty', 'failed', 'fresh'] as const)
    test(
      `${kind}: ${outcome} interpretation obeys source readiness at enqueue`,
      { timeout: 30_000 },
      async (t) => {
        fictionalModel(t);
        const root = mkdtempSync(join(tmpdir(), 'fictional-source-batch-'));
        const profileId = 'fictional-source-batch';
        const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
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
        await ensureNativeIntakeSchema(db, profileId, source.id);
        const propose = () =>
          proposeConversionRead(db, root, profileId, source.id, {
            version: getIntakeRead(db, root, profileId, source.id).version,
            jsonlText,
            summary: 'Fictional interpretation',
          });
        const latestProposalId = () => {
          const view = openIntakeCollectionEnvelope(db, { id: source.id });
          const selected = view.child(view.root(), 'intake')!;
          const proposals = view.children(selected, 'proposals', { items: 4, bytes: 32768 });
          assert.equal(proposals.complete, true, 'all fictional proposals fit a bounded page');
          assert.equal(proposals.records.length, view.childCount(selected, 'proposals'));
          const last = proposals.records.at(-1);
          if (!last) return null;
          const id = view.field(last, 'id', { bytes: 8192 });
          assert.ok(id.kind === 'value' && typeof id.value === 'string');
          return id.value;
        };
        const review = async (proposalId: string | null) => {
          const page = await reviewIntakeRead(db, root, profileId, source.id, proposalId, {
            items: 1,
            bytes: 65536,
          });
          assert.ok('format' in page && page.format === 'health-intake-clinical-review-page-v2');
          assert.equal(page.total, 1);
          assert.equal(page.items.length, 1);
          assert.equal(page.nextCursor, null);
          return page;
        };
        if (kind === 'existing-proposal') await propose();
        const oldProposal = latestProposalId();
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
        const published = new EventEmitter();
        const snapshots = new Map<string, IntakeBatch>();
        // Observe durable state transitions, not a machine-speed deadline or a raw
        // dispatch count that can precede publication of the running checkpoint.
        const waitForBatch = async (id: string, running = false) => {
          const reached = (batch: IntakeBatch) =>
            batch.status !== 'running' || (running && batch.items[0]!.status === 'running');
          const current = snapshots.get(id);
          if (current && reached(current)) return current;
          for await (const [batch] of on(published, 'batch', { signal: t.signal }))
            if (batch.id === id && reached(batch)) return batch as IntakeBatch;
          throw new Error('Batch observation ended before publication');
        };
        // Each case exercises its first enqueue. Re-enqueueing an already owned
        // original intentionally returns the retained batch, even after completion.
        if (outcome !== 'current') {
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
          assert.equal((await review(oldProposal)).sourceTextStale, true);
          const current = await prepareCurrentIntakeInterpretations(db, profileId, source.id);
          assert.equal(current.original, false);
          assert.equal(current.hasCurrentProposal, false, 'no retained proposal is current');
          assert.equal(current.proposalTotal, kind === 'existing-proposal' ? 1 : 0);
        }
        if (outcome === 'fresh') {
          // The clinical payload may remain identical, but corrected evidence must
          // receive a new dependency-bound proposal and review version.
          const fresh = await propose();
          assert.ok(isIntakeSummary(fresh));
          const freshId = latestProposalId();
          assert.ok(freshId);
          assert.notEqual(freshId, oldProposal);
          assert.equal((await review(freshId)).sourceTextStale, false);
        }
        // Construction wakes the durable upload intent. Establish the selected
        // evidence before that first enqueue; native review preparation yields.
        const manager = createIntakeBatchManager({
          root,
          databases: new Map([[profileId, db]]),
          pollMs: 2,
          journalWriter: (...args) => {
            writeIntakeBatch(...args);
            const snapshot = cloneIntakeBatch(args[2]);
            snapshots.set(snapshot.id, snapshot);
            published.emit('batch', snapshot);
          },
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
        const start = (operationId: string = randomUUID()) =>
          manager.createPrepared(profileId, { operationId, intakeIds: [source.id] });
        const firstOperationId = randomUUID();
        const batch = await start(firstOperationId);
        if (outcome === 'current' || outcome === 'fresh') {
          assert.equal((await waitForBatch(batch.id)).status, 'complete');
          assert.equal(manager.get(profileId, batch.id).items[0].status, 'review_ready');
          assert.equal(sends, 0, 'Current evidence must avoid unnecessary rereading');
          assert.equal(
            (await start(randomUUID())).scheduled,
            false,
            'a completed, fully captured interpretation has no work for a new operation',
          );
          if (kind === 'existing-proposal' && outcome === 'current') {
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
                    id: 'fictional-later-correction',
                    text: 'Fictional source value 31.00 mg.',
                    region: { page: 1 },
                    provenance: 'human',
                  },
                ],
              },
              'profile-owner',
            );
            assert.equal(manager.get(profileId, batch.id).status, 'complete', 'before replay');
            assert.equal(
              (await start(batch.operationId)).status,
              'complete',
              'original operation replays',
            );
            const reopenOperationId = randomUUID();
            assert.equal(
              (await start(reopenOperationId)).scheduled,
              true,
              'new operation reopens affected evidence',
            );
            assert.equal(
              (await start(reopenOperationId)).scheduled,
              false,
              'reopen operation replays exactly',
            );
            assert.equal((await waitForBatch(batch.id, true)).items[0]!.status, 'running');
            assert.equal(sends, 1);
            await propose();
            const replacementId = latestProposalId();
            assert.ok(replacementId);
            assert.notEqual(replacementId, oldProposal);
            chat.status = 'idle';
            assert.equal((await waitForBatch(batch.id)).status, 'complete');
            assert.equal(manager.get(profileId, batch.id).items[0]!.status, 'review_ready');
            assert.equal(
              (await start()).scheduled,
              false,
              'fresh replacement closes the reopened work',
            );
          }
          return;
        }
        assert.equal((await waitForBatch(batch.id, true)).items[0].status, 'running');
        assert.equal(sends, 1, 'Stale evidence must receive another reading pass');
        chat.status = outcome === 'failed' ? 'failed' : 'idle';
        chat.error = outcome === 'failed' ? 'Fictional unclassified reader failure' : null;
        assert.equal((await waitForBatch(batch.id)).status, 'paused');
        assert.equal(manager.get(profileId, batch.id).items[0].status, 'paused');
        assert.equal(manager.get(profileId, batch.id).items[0].reason, 'no_proposal');
        assert.equal((await review(oldProposal)).sourceTextStale, true);
      },
    );
