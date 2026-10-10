import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatementSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, proposeConversion } from '../intake.ts';
import { readIntakeEnvelope, stageIntakeEnvelope } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import { prepareCollectionClinicalReview } from '../intake-review-collection-host.ts';
import { acceptIntakeReportSelectionAsync } from '../intake-report-acceptance.ts';
import { iterateIntakeEnvelopeText } from '../intake-collection-envelope.ts';
import { prepareIntakeLookupIndices } from '../intake-lookup-state.ts';
import {
  maximumIntakeDiscoveryOrder,
  retainedIntakeAcceptance,
} from '../intake-lookup-projection.ts';
import { recordDurabilityStatus } from '../record-versions.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
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

for (const retainedCount of [1, 65])
  for (const sameOriginal of [true, false])
    test(`grouped public approval revisits only new receipts after ${retainedCount} retained receipts in ${sameOriginal ? 'one original' : 'two originals'}`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'fictional-grouped-receipts-'));
      const profileId = 'fictional-grouped-receipts';
      const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
      const authority = memoryRecordAuthority(db);
      t.after(() => {
        clearIntakeStateCache(db);
        db.close();
        rmSync(root, { recursive: true, force: true });
      });
      const selected = uploadIntake(db, root, profileId, {
        filename: 'fictional-selected.jsonl',
        bytes: Buffer.from(line('grouped-one')),
      });
      const first = proposeConversion(db, root, profileId, selected.id, {
        version: selected.version,
        jsonlText: line('grouped-one'),
        summary: 'Fictional first block',
      });
      const other = sameOriginal
        ? selected
        : uploadIntake(db, root, profileId, {
            filename: 'fictional-second.jsonl',
            bytes: Buffer.from(line('grouped-two')),
          });
      const second = proposeConversion(db, root, profileId, other.id, {
        version: sameOriginal ? first.version : other.version,
        jsonlText: line('grouped-two'),
        summary: 'Fictional second block',
      });
      const control = uploadIntake(db, root, profileId, {
        filename: 'fictional-control.txt',
        bytes: Buffer.from('Fictional unrelated original'),
      });
      const retained = Array.from({ length: retainedCount }, (_, index) => ({
        receipt: { operationId: `fictional-retained-${index}` },
        marker: `fictional-history-${index}`,
      }));
      const otherRetained = Array.from({ length: retainedCount }, (_, index) => ({
        receipt: { operationId: `fictional-other-retained-${index}` },
        marker: `fictional-other-history-${index}`,
      }));
      const controlReceipt = {
        receipt: { operationId: 'fictional-control-receipt' },
        marker: 'fictional-control',
      };
      const histories = [
        { id: selected.id, receipts: retained },
        { id: control.id, receipts: [controlReceipt] },
      ];
      if (!sameOriginal) histories.push({ id: other.id, receipts: otherRetained });
      for (const { id, receipts } of histories) {
        const envelope = readIntakeEnvelope(db, { id }) as {
          intake: { workflow?: Record<string, unknown> };
        };
        envelope.intake.workflow ??= {};
        envelope.intake.workflow.reportAcceptances = receipts;
        transaction(db, () => stageIntakeEnvelope(db, { id }, envelope));
        await buildIntakeCollectionEnvelope(db, { id });
        await buildVerifiedWorkflowSummary(
          db,
          { id },
          {
            mappingVersion: 'fictional-v1',
            isSourceContextVersion: () => false,
          },
        );
      }
      await prepareCollectionReviewMembership(db, { id: selected.id });
      if (!sameOriginal) await prepareCollectionReviewMembership(db, { id: other.id });
      await prepareIntakeLookupIndices(db);
      const maximum = maximumIntakeDiscoveryOrder(db);
      assert.deepEqual(retainedIntakeAcceptance(db, retained[0]!.receipt.operationId), retained[0]);
      if (!sameOriginal)
        assert.deepEqual(
          retainedIntakeAcceptance(db, otherRetained[0]!.receipt.operationId),
          otherRetained[0],
        );
      assert.deepEqual(
        retainedIntakeAcceptance(db, controlReceipt.receipt.operationId),
        controlReceipt,
      );
      const input: IntakeReportAcceptanceRequest = {
        operationId: randomUUID(),
        blocks: [
          { proposal: first, source: selected },
          { proposal: second, source: other },
        ].map(({ proposal, source }) => {
          const proposalId = proposal.proposals.at(-1)!.id;
          const reviewed = prepareCollectionClinicalReview(
            db,
            root,
            profileId,
            source.id,
            proposalId,
          );
          if (reviewed.status !== 'ready') throw Error('Expected complete selected review');
          const review = reviewed.session.review;
          return {
            intakeId: source.id,
            proposalId,
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
      const saved = await acceptIntakeReportSelectionAsync(db, root, profileId, input);
      assert.equal(saved.replayed, false);
      assert.equal(saved.receipt.atomic, true);
      assert.equal(saved.receipt.acceptedCount, 2);
      if (!saved.receipt.atomic) throw Error('Expected atomic grouped receipt');
      assert.equal(saved.receipt.receipts.length, 2);
      const selectedAfterAcceptance = [...iterateIntakeEnvelopeText(db, { id: selected.id })].join(
        '',
      );
      const newReceipt =
        JSON.parse(selectedAfterAcceptance).intake.workflow.reportAcceptances.at(-1);
      assert.equal(newReceipt.receipt.operationId, input.operationId);
      const otherAfterAcceptance = sameOriginal
        ? undefined
        : [...iterateIntakeEnvelopeText(db, { id: other.id })].join('');
      if (otherAfterAcceptance)
        assert.deepEqual(
          JSON.parse(otherAfterAcceptance).intake.workflow.reportAcceptances,
          otherRetained,
        );
      const beforeObjects = authority.objects.size;
      const beforeSequence = recordDurabilityStatus(db)?.sequence;
      const beforeTransactions = Number(
        db.prepare('SELECT COUNT(*) AS n FROM __record_transactions').get()!.n,
      );
      const visits = new Map<string, number>();
      const run = StatementSync.prototype.run;
      let privateWrites = 0;
      StatementSync.prototype.run = function (
        this: StatementSync,
        ...parameters: Parameters<StatementSync['run']>
      ) {
        const result = Reflect.apply(run, this, parameters) as ReturnType<StatementSync['run']>;
        if (/\b(?:INTO|UPDATE|FROM)\s+acceptances\b/i.test(this.sourceSQL))
          privateWrites += Number(result.changes);
        return result;
      } as typeof StatementSync.prototype.run;
      let fresh: Awaited<ReturnType<typeof prepareIntakeLookupIndices>>;
      try {
        fresh = await prepareIntakeLookupIndices(db, {
          onCheckpoint: ({ sourceId, visited }) => {
            visits.set(sourceId, Math.max(visits.get(sourceId) ?? 0, visited));
          },
        });
      } finally {
        StatementSync.prototype.run = run;
      }
      const changedVisits = visits.get(selected.id) ?? 0;
      const otherVisits = sameOriginal ? undefined : (visits.get(other.id) ?? 0);
      const controlVisits = visits.get(control.id) ?? 0;
      t.diagnostic(
        JSON.stringify({
          retainedCount,
          sameOriginal,
          changedVisits,
          otherVisits,
          controlVisits,
          privateWrites,
          prepared: fresh.prepared,
        }),
      );
      assert.equal(fresh.prepared, 0);
      assert.equal(authority.objects.size, beforeObjects);
      assert.equal(recordDurabilityStatus(db)?.sequence, beforeSequence);
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS n FROM __record_transactions').get()!.n),
        beforeTransactions,
      );
      assert.equal(
        [...iterateIntakeEnvelopeText(db, { id: selected.id })].join(''),
        selectedAfterAcceptance,
      );
      if (otherAfterAcceptance)
        assert.equal(
          [...iterateIntakeEnvelopeText(db, { id: other.id })].join(''),
          otherAfterAcceptance,
        );
      assert.equal(maximumIntakeDiscoveryOrder(db), maximum);
      assert.deepEqual(retainedIntakeAcceptance(db, retained[0]!.receipt.operationId), retained[0]);
      if (!sameOriginal)
        assert.deepEqual(
          retainedIntakeAcceptance(db, otherRetained[0]!.receipt.operationId),
          otherRetained[0],
        );
      assert.deepEqual(retainedIntakeAcceptance(db, input.operationId), newReceipt);
      assert.deepEqual(
        retainedIntakeAcceptance(db, controlReceipt.receipt.operationId),
        controlReceipt,
      );
      assert.equal(retainedIntakeAcceptance(db, 'fictional-missing-receipt'), null);
      const replay = await acceptIntakeReportSelectionAsync(db, root, profileId, input);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.receipt, saved.receipt);
      assert.equal(controlVisits, 0);
      assert.deepEqual(
        { changedVisits, otherVisits, privateWrites },
        { changedVisits: 1, otherVisits: sameOriginal ? undefined : 0, privateWrites: 1 },
        'Only the one new receipt may be derived and written to the private catalog',
      );
    });
