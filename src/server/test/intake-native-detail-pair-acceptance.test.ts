import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { uploadIntake, reviewIntake, importIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  applyClinicalRecordAction,
  openSelectedClinicalRecord,
  readClinicalRecordSection,
} from '../intake-clinical-record-sections.ts';
import { acceptIntakeReportSelectionAsync } from '../intake-report-acceptance.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { canonicalLiteral } from '../intake-format.ts';
import type { IntakeReportAcceptanceRequest } from '../../shared/intake.ts';

test('small native detail approval commits its exact retained relationship and refuses an older selected draft', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-detail-pair-')),
    profileId = 'fictional-native-pair',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const upload = (id: string) =>
    uploadIntake(db, root, profileId, {
      filename: id + '.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        JSON.stringify({
          format: 'health-record-v1',
          id,
          kind: 'document',
          payload: { text: 'Fictional original ' + id },
          provenance: {
            capturedVia: 'Fictional export',
            sourceSystem: 'Fictional clinic',
            sourceRecordId: id,
            evidenceClass: 'provider_export',
            locator: 'page 1',
          },
          coverage: { status: 'complete_response', notes: [] },
          clinical: {
            kind: 'document',
            subject: 'unknown',
            documentTitle: 'Shared fictional note',
            date: '2026-01-01',
          },
        }),
      ),
    });
  const saved = upload('saved-native-note'),
    savedReview = reviewIntake(db, root, profileId, saved.id);
  importIntake(db, root, profileId, saved.id, {
    version: savedReview.version,
    reviewToken: savedReview.reviewToken,
    decisions: [{ recordId: savedReview.records[0]!.id, action: 'accept', mapping: {} }],
  });
  const incoming = upload('incoming-native-note'),
    incomingRecord = reviewIntake(db, root, profileId, incoming.id).records[0]!,
    selection = {
      proposalId: null,
      recordId: incomingRecord.id,
      candidateVersionId: incomingRecord.candidateVersionId!,
    };
  await buildIntakeCollectionEnvelope(db, { id: incoming.id });
  const choose = async (reason: string) => {
    const page = await readClinicalRecordSection(db, root, profileId, incoming.id, {
      ...selection,
      section: 'comparisons',
      comparisonSearch: { query: 'Shared' },
    });
    assert.equal(page.total, 1);
    const control = page.items[0]!.control;
    assert.ok(control.kind === 'pair');
    assert.ok(control.scopeToken);
    await applyClinicalRecordAction(db, root, profileId, incoming.id, {
      ...selection,
      version: page.context.version,
      reviewToken: page.context.reviewToken,
      operationId: randomUUID(),
      pair: {
        otherRecordId: control.otherRecordId,
        scopeToken: control.scopeToken,
        outcome: 'distinct',
        reason,
      },
    });
    return control.otherRecordId;
  };
  const targetId = await choose('Separate fictional source identifiers; retain both originals.');
  const approval = async (): Promise<IntakeReportAcceptanceRequest> => {
    const current = await openSelectedClinicalRecord(db, root, profileId, incoming.id, selection);
    try {
      assert.equal(current.session.selectedRecord(selection.recordId).record.kind, 'record');
      assert.equal(current.record.draft?.decision?.comparisons?.length, 1);
      return {
        mode: 'partial-v1',
        operationId: randomUUID(),
        blocks: [
          {
            intakeId: incoming.id,
            proposalId: null,
            intakeVersion: current.review.version,
            reviewToken: current.review.reviewToken,
            selections: [
              {
                recordId: selection.recordId,
                candidateVersionId: selection.candidateVersionId,
                candidateId: current.record.candidateId!,
                selectionReviewToken: current.record.selectionReviewToken!,
                mapping: {},
                useRetainedDecision: true,
              },
            ],
          },
        ],
      };
    } finally {
      current.session.close();
    }
  };
  const older = await approval();
  const reason = 'Reviewed both fictional originals again; these are separate notes.';
  const edit = await openSelectedClinicalRecord(db, root, profileId, incoming.id, selection);
  const retainedPair = canonicalLiteral(edit.record.draft!.decision!.comparisons![0]);
  await applyClinicalRecordAction(db, root, profileId, incoming.id, {
    ...selection,
    version: edit.review.version,
    reviewToken: edit.review.reviewToken,
    operationId: randomUUID(),
    patch: {
      mapping: { documentTitle: 'Shared fictional corrected note' },
      correctionPatch: { documentTitle: 'Shared fictional corrected note' },
      correctionReason: 'The fictional original supports the corrected note title.',
    },
  });
  edit.session.close();
  const changed = await openSelectedClinicalRecord(db, root, profileId, incoming.id, selection);
  assert.equal(canonicalLiteral(changed.record.draft!.decision!.comparisons![0]), retainedPair);
  assert.equal(changed.record.draft!.decision!.comparisons!.length, 1);
  assert.equal(changed.record.comparisonDrafts![0]!.status, 'stale');
  changed.session.close();
  const refused = await acceptIntakeReportSelectionAsync(db, root, profileId, older);
  assert.equal(refused.receipt.acceptedCount, 0);
  assert.ok(!refused.receipt.atomic);
  assert.equal(refused.receipt.items[0]!.status, 'needs_review');
  assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 1);
  const unreviewed = await acceptIntakeReportSelectionAsync(db, root, profileId, await approval());
  assert.equal(unreviewed.receipt.acceptedCount, 0);
  assert.ok(!unreviewed.receipt.atomic);
  assert.equal(unreviewed.receipt.items[0]!.status, 'needs_review');
  assert.equal(await choose(reason), targetId);
  const fresh = await approval();
  const accepted = await acceptIntakeReportSelectionAsync(db, root, profileId, fresh);
  assert.equal(accepted.receipt.acceptedCount, 1);
  assert.ok(!accepted.receipt.atomic);
  assert.equal(accepted.receipt.items[0]!.status, 'saved');
  const page = await readClinicalRecordSection(db, root, profileId, incoming.id, {
    ...selection,
    section: 'comparisons',
    comparisonSearch: { query: 'Shared' },
  });
  const item = page.items.find(
    (item) => item.control.kind === 'pair' && item.control.otherRecordId === targetId,
  )!;
  const pair = item.control;
  assert.ok(pair.kind === 'pair');
  assert.equal(pair.previousDecision?.outcome, 'distinct');
  assert.ok(item.detail.kind === 'value');
  assert.equal(
    (item.detail.value as { comparison: { previousDecision: { reason: string } } }).comparison
      .previousDecision.reason,
    reason,
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 2);
  const replayed = await acceptIntakeReportSelectionAsync(db, root, profileId, fresh);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.receipt, accepted.receipt);
});
