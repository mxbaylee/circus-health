import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, HttpError } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, proposeConversion } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { prepareCollectionClinicalReview } from '../intake-review-collection-host.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import {
  acceptIntakeReportSelectionAsync,
  getIntakeReportAcceptance,
} from '../intake-report-acceptance.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { iterateIntakeEnvelopeText } from '../intake-collection-envelope.ts';
import type { IntakeReportAcceptanceRequest } from '../../shared/intake.ts';

function line(id: string) {
  return JSON.stringify({
    format: 'health-record-v1',
    id,
    kind: 'document',
    payload: { text: 'Fictional ' + id },
    provenance: {
      capturedVia: 'Fictional export',
      sourceSystem: 'Fictional clinic',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'page ' + id,
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional ' + id,
      date: '2026-01-01',
    },
  });
}
// Two durable schema migrations plus coupled checkpoint preparation exercise
// host integration. Work-count assertions, rather than this safety timeout,
// qualify scaling; slower CI filesystems need time to finish those writes.
for (const sameOriginal of [true, false])
  test(
    `native public grouped acceptance preserves ${sameOriginal ? 'one original history' : 'distinct originals'}, exact replay and atomic receipt`,
    { timeout: 120000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'fictional-native-report-host-')),
        profileId = 'fictional-reports',
        db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
      attachPersonalDurability(db, { root, profileId });
      t.after(() => {
        clearIntakeStateCache(db);
        db.close();
        rmSync(root, { recursive: true, force: true });
      });
      const upload = (id: string) =>
        uploadIntake(db, root, profileId, {
          filename: 'fictional-' + id + '.jsonl',
          newProviderName: 'Fictional clinic ' + id,
          bytes: Buffer.from(line(id)),
        });
      const first = upload('one'),
        second = sameOriginal ? first : upload('two'),
        current = new Map<string, ReturnType<typeof proposeConversion>>(
          [first, second].map((item) => [item.id, item]),
        );
      const selected = [first, second].map((item, index) => {
        const original = current.get(item.id)!,
          proposed = proposeConversion(db, root, profileId, item.id, {
            version: original.version,
            jsonlText: line(index ? 'two' : 'one'),
            summary: 'Fictional selected block',
          });
        current.set(item.id, proposed);
        return { intakeId: item.id, proposalId: proposed.proposals.at(-1)!.id };
      });
      for (const item of current.values()) {
        await buildIntakeCollectionEnvelope(db, { id: item.id });
        await prepareCollectionReviewMembership(db, { id: item.id });
      }
      const input: IntakeReportAcceptanceRequest = {
        operationId: randomUUID(),
        blocks: selected.map((block) => {
          const reviewed = prepareCollectionClinicalReview(
            db,
            root,
            profileId,
            block.intakeId,
            block.proposalId,
          );
          if (reviewed.status !== 'ready') throw Error('Expected complete selected review');
          const review = reviewed.session.review;
          return {
            ...block,
            intakeVersion: review.version,
            reviewToken: review.reviewToken,
            selections: review.records.map((record) => ({
              recordId: record.id,
              candidateId: record.candidateId!,
              candidateVersionId: record.candidateVersionId!,
              mapping: record.mapping,
            })),
          };
        }),
      };
      const before = { ...intakeWorkCounters(db).warm };
      const saved = await acceptIntakeReportSelectionAsync(db, root, profileId, input);
      assert.equal(saved.receipt.atomic, true);
      assert.equal(saved.receipt.status, 'accepted');
      assert.equal(saved.receipt.acceptedCount, 2);
      assert.equal(saved.replayed, false);
      if (!saved.receipt.atomic) throw Error('Expected atomic receipt');
      assert.equal(saved.receipt.receipts.length, 2);
      if (sameOriginal)
        assert.equal(
          saved.receipt.receipts[1]!.intakeVersionBefore,
          saved.receipt.receipts[0]!.intakeVersionAfter,
        );
      const full = JSON.parse([...iterateIntakeEnvelopeText(db, { id: first.id })].join(''));
      assert.equal(full.intake.workflow.reportAcceptances.length, 1);
      assert.equal(full.intake.importHistory?.length ?? 0, sameOriginal ? 1 : 0);
      clearIntakeStateCache(db);
      const replay = await acceptIntakeReportSelectionAsync(db, root, profileId, input);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.receipt, saved.receipt);
      assert.deepEqual(
        getIntakeReportAcceptance(db, root, profileId, input.operationId).receipt,
        saved.receipt,
      );
      const changed = structuredClone(input);
      changed.blocks[0]!.selections[0]!.mapping.documentTitle = 'Different fictional request';
      await assert.rejects(
        acceptIntakeReportSelectionAsync(db, root, profileId, changed),
        (error: unknown) => error instanceof HttpError && error.code === 'OPERATION_CONFLICT',
      );
      assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.envelopeHydrations);
      assert.equal(intakeWorkCounters(db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
    },
  );

test(
  'native partial approval preserves saved and stale outcomes without duplicate coordinator receipts',
  { timeout: 120000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-native-partial-host-')),
      profileId = 'fictional-partial',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    t.after(() => {
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const original = uploadIntake(db, root, profileId, {
      filename: 'fictional-partial.jsonl',
      bytes: Buffer.from(line('original')),
    });
    const proposed = proposeConversion(db, root, profileId, original.id, {
      version: original.version,
      jsonlText: line('first') + '\n' + line('second'),
      summary: 'Fictional two records',
    });
    await buildIntakeCollectionEnvelope(db, { id: original.id });
    await prepareCollectionReviewMembership(db, { id: original.id });
    const reviewed = prepareCollectionClinicalReview(
      db,
      root,
      profileId,
      original.id,
      proposed.proposals.at(-1)!.id,
    );
    if (reviewed.status !== 'ready') throw Error('Expected selected review');
    const review = reviewed.session.review;
    const input: IntakeReportAcceptanceRequest = {
      operationId: randomUUID(),
      mode: 'partial-v1',
      blocks: [
        {
          intakeId: original.id,
          proposalId: proposed.proposals.at(-1)!.id,
          intakeVersion: review.version,
          reviewToken: review.reviewToken,
          selections: review.records.map((record, ordinal) => ({
            recordId: record.id,
            candidateId: record.candidateId!,
            candidateVersionId: ordinal ? 'stale-fictional-version' : record.candidateVersionId!,
            selectionReviewToken: record.selectionReviewToken,
            mapping: record.mapping,
          })),
        },
      ],
    };
    reviewed.session.close();
    const assertNoPolicies = () => {
      assert.equal(db.prepare('SELECT count(*) n FROM intake_review_issue_policy_v2').get()!.n, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM intake_review_issue_scope').get()!.n, 0);
    };
    assertNoPolicies();
    const before = { ...intakeWorkCounters(db).warm };
    const saving = acceptIntakeReportSelectionAsync(db, root, profileId, input);
    await Promise.resolve();
    assert.throws(() => getIntakeReportAcceptance(db, root, profileId, input.operationId), {
      code: 'REPORT_ACCEPTANCE_IN_PROGRESS',
    });
    const saved = await saving;
    assertNoPolicies();
    assert.equal(saved.receipt.atomic, false);
    if (saved.receipt.atomic) throw Error('Expected partial receipt');
    assert.equal(saved.receipt.acceptedCount, 1);
    assert.deepEqual(
      saved.receipt.items.map((item) => item.status),
      ['saved', 'needs_review'],
    );
    const state = JSON.parse([...iterateIntakeEnvelopeText(db, { id: original.id })].join(''));
    assert.equal(state.intake.workflow.reportAcceptances?.length ?? 0, 0);
    clearIntakeStateCache(db);
    const replay = await acceptIntakeReportSelectionAsync(db, root, profileId, input);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, saved.receipt);
    assertNoPolicies();
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.deepEqual(
        (await acceptIntakeReportSelectionAsync(db, root, profileId, input)).receipt,
        saved.receipt,
      );
      assertNoPolicies();
    }
    assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.envelopeHydrations);
    assert.equal(intakeWorkCounters(db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
  },
);
