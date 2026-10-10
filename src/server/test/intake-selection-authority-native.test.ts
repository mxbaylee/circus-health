import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { uploadIntake, reviewIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  prepareIntakeEnvelopeFieldMutation,
  stageIntakeEnvelopeFieldMutation,
} from '../intake-collection-envelope.ts';
import { openSelectedClinicalRecord } from '../intake-clinical-record-sections.ts';
import { workflowHash } from '../intake-workflow.ts';
import { createApp } from '../index.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { durableSelectionInputs } from '../intake-selection-authority.ts';
import { canonicalReviewValueChunks } from '../intake-review-question-state.ts';
const presentationHash = (record: object) => {
  const hash = createHash('sha256');
  for (const chunk of canonicalReviewValueChunks(
    durableSelectionInputs({ ...record, comparisons: undefined }),
  ))
    hash.update(chunk);
  return hash.digest('hex');
};

// The immutable fixture backend retains and verifies the real accepted journal;
// encrypted backup is independently exercised by provider qualification.
test(
  'actual native partial retained approval rejects an off-page edit, accepts its fresh review and replays',
  { timeout: 120000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-selection-authority-')),
      profileId = 'fictional-selection',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    memoryRecordAuthority(db);
    const app = createApp({
      root,
      databases: new Map([[profileId, db]]),
      intakeBatchOptions: { authorized: () => false },
    });
    t.after(() => {
      app.close();
      if (db.isOpen) db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const original = uploadIntake(db, root, profileId, {
      filename: 'fictional.jsonl',
      bytes: Buffer.from(
        JSON.stringify({
          format: 'health-record-v1',
          id: 'one',
          kind: 'document',
          payload: { text: 'Fictional original' },
          provenance: {
            capturedVia: 'Fictional export',
            sourceSystem: 'Fictional clinic',
            sourceRecordId: 'one',
            evidenceClass: 'provider_export',
            locator: 'page 1',
          },
          coverage: { status: 'complete_response', notes: [] },
          clinical: {
            kind: 'document',
            subject: 'self',
            documentTitle: 'Fictional note',
            date: '2026-01-01',
          },
        }),
      ),
    });
    const first = { record: reviewIntake(db, root, profileId, original.id).records[0]! };
    await buildIntakeCollectionEnvelope(db, { id: original.id });
    const view = openIntakeCollectionEnvelope(db, { id: original.id }),
      flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
      draftId = 'draft:fictional-complete-resolution-policy',
      operationId = randomUUID();
    const draft = {
      id: draftId,
      proposalId: null,
      recordId: first.record.id,
      candidateId: first.record.candidateId,
      candidateVersionId: first.record.candidateVersionId,
      mapping: first.record.mapping,
      disposition: 'pending',
      decision: { action: 'accept', mapping: first.record.mapping },
      answers: [],
      corrections: [],
      at: '2026-01-01',
      resolutions: Array.from({ length: 80 }, (_, n) => ({
        issueId: 'fictional-historical-' + n,
        outcome: n === 79 ? 'this_is_me' : 'unknown',
        reason: 'before',
        unknown: 'Fictional ' + 'x'.repeat(3500),
        literalNumber: JSON.rawJSON('12.00'),
      })),
    };
    const prepared = await prepareIntakeEnvelopeMutation(
      db,
      { id: original.id },
      {
        reader: view,
        operationId,
        requestDigest: workflowHash(operationId),
        domainVersion: view.logical.domainVersion,
        changes: [
          { op: 'append', record: flow, field: 'reviewDrafts', jsonText: JSON.stringify(draft) },
        ],
      },
    );
    transaction(db, () =>
      selectedEnvelopeStore(db, { id: original.id }).collections.stage(prepared.prepared!),
    );
    const captured = await openSelectedClinicalRecord(db, root, profileId, original.id, {
      proposalId: null,
      recordId: first.record.id,
      candidateVersionId: first.record.candidateVersionId!,
    });
    assert.equal(captured.record.draft!.resolutionsReference!.count, 80);
    assert.equal(captured.record.draft!.resolutions.length, 0);
    const oldPresentationHash = presentationHash(captured.record);
    const body = {
      mode: 'partial-v1',
      operationId: randomUUID(),
      blocks: [
        {
          intakeId: original.id,
          proposalId: null,
          intakeVersion: captured.review.version,
          reviewToken: captured.review.reviewToken,
          selections: [
            {
              recordId: captured.record.id,
              candidateId: captured.record.candidateId!,
              candidateVersionId: captured.record.candidateVersionId!,
              selectionReviewToken: captured.record.selectionReviewToken!,
              mapping: {},
              useRetainedDecision: true,
            },
          ],
        },
      ],
    };
    captured.session.close();
    const currentView = openIntakeCollectionEnvelope(db, { id: original.id }),
      currentFlow = currentView.child(
        currentView.child(currentView.root(), 'intake')!,
        'workflow',
      )!,
      currentDraft = currentView.find('draft', currentFlow, draftId)!,
      last = currentView.childAt(currentDraft, 'resolutions', 79)!,
      changedOperation = randomUUID();
    const changed = prepareIntakeEnvelopeFieldMutation(
      db,
      { id: original.id },
      {
        reader: currentView,
        record: last,
        field: 'reason',
        jsonText: JSON.stringify('after'),
        operationId: changedOperation,
        requestDigest: workflowHash(changedOperation),
        domainVersion: currentView.logical.domainVersion,
      },
    );
    transaction(db, () => stageIntakeEnvelopeFieldMutation(db, { id: original.id }, changed));
    const fresh = await openSelectedClinicalRecord(db, root, profileId, original.id, {
      proposalId: null,
      recordId: first.record.id,
      candidateVersionId: first.record.candidateVersionId!,
    });
    assert.equal(fresh.record.draft!.resolutionsReference!.count, 80);
    assert.equal(
      presentationHash(fresh.record),
      oldPresentationHash,
      'the prior presentation-only recipe misses this edit',
    );
    assert.notEqual(fresh.record.selectionReviewToken, captured.record.selectionReviewToken);
    fresh.session.close();
    const before = intakeWorkCounters(db).warm.envelopeHydrations;
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/profiles/${profileId}/intakes/report-acceptance`,
      {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const receipt = result.data.receipt;
    assert.equal(receipt.acceptedCount, 0);
    assert.equal(receipt.items[0].status, 'needs_review');
    assert.equal(receipt.items[0].reasonCode, 'SELECTION_REVIEW_CHANGED');
    assert.equal(db.prepare('SELECT count(*) n FROM documents').get()!.n, 0);
    assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before);

    // Publishing the partial operation manifest advances transport revisions,
    // but cannot invalidate an unchanged exact selection's retained approval.
    const freshBody = {
      ...body,
      operationId: randomUUID(),
      blocks: [
        {
          ...body.blocks[0]!,
          intakeVersion: fresh.review.version,
          reviewToken: fresh.review.reviewToken,
          selections: [
            {
              ...body.blocks[0]!.selections[0]!,
              selectionReviewToken: fresh.record.selectionReviewToken!,
            },
          ],
        },
      ],
    };
    const postFresh = () =>
      fetch(
        `http://127.0.0.1:${address.port}/api/profiles/${profileId}/intakes/report-acceptance`,
        {
          method: 'POST',
          headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
          body: JSON.stringify(freshBody),
        },
      );
    const acceptedResponse = await postFresh(),
      accepted = await acceptedResponse.json();
    assert.equal(acceptedResponse.status, 200, JSON.stringify(accepted));
    assert.equal(accepted.data.receipt.acceptedCount, 1, JSON.stringify(accepted));
    assert.equal(accepted.data.receipt.items[0].status, 'saved');
    assert.equal(db.prepare('SELECT count(*) n FROM documents').get()!.n, 1);
    const replayResponse = await postFresh(),
      replay = await replayResponse.json();
    assert.equal(replayResponse.status, 200, JSON.stringify(replay));
    assert.equal(replay.data.replayed, true);
    assert.deepEqual(replay.data.receipt, accepted.data.receipt);
    assert.equal(db.prepare('SELECT count(*) n FROM documents').get()!.n, 1);
    assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before);
  },
);
