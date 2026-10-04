import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, proposeConversion } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import { prepareClinicalSourceFingerprintIndex } from '../intake-clinical-source-index.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { prepareCollectionClinicalReview } from '../intake-review-collection-host.ts';
import { collectionClinicalProjectionContext } from '../intake-review-collection-session.ts';
import { prepareNativeIntakeAcceptanceGroup } from '../intake-collection-acceptance-group.ts';
import { buildReportContextLookup } from '../intake-report-context.ts';
import { iterateIntakeEnvelopeText } from '../intake-collection-envelope.ts';
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
for (const sameOriginal of [true, false])
  test(`coupled native approval preserves ordered ${sameOriginal ? 'same-original history' : 'distinct-original'} receipts atomically`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-coupled-acceptance-')),
      profileId = 'fictional-coupled',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId),
      cleanup: Array<() => void> = [];
    attachPersonalDurability(db, { root, profileId });
    t.after(() => {
      for (const close of cleanup.reverse()) close();
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
      initial = [first, second];
    const current = new Map<string, Pick<typeof first, 'id' | 'sha256' | 'version'>>(
      initial.map((item) => [item.id, item]),
    );
    const blocks = initial.map((item, index) => {
      const original = current.get(item.id)!,
        proposed = proposeConversion(db, root, profileId, item.id, {
          version: original.version,
          jsonlText: line(index ? 'two' : 'one'),
          summary: 'Fictional selected block',
        });
      current.set(item.id, proposed);
      return { id: item.id, sha256: item.sha256, proposalId: proposed.proposals.at(-1)!.id };
    });
    for (const item of current.values()) {
      await buildIntakeCollectionEnvelope(db, { id: item.id, sha256: item.sha256 });
      await prepareCollectionReviewMembership(db, { id: item.id });
    }
    await prepareClinicalSourceFingerprintIndex(db);
    const members = blocks.map((block) => {
      const result = prepareCollectionClinicalReview(
        db,
        root,
        profileId,
        block.id,
        block.proposalId,
      );
      if (result.status !== 'ready') throw Error('Expected complete review');
      const session = result.session,
        context = collectionClinicalProjectionContext(session);
      return {
        session,
        expectedVersion: session.review.version,
        reviewToken: session.review.reviewToken,
        decisions: session.review.records.map((record) => ({
          recordId: record.id,
          action: 'accept' as const,
          mapping: record.mapping,
        })),
        reportEvidence: {
          packageEvidence: false,
          hasMember: () => false,
          contextLookup: buildReportContextLookup(context.proposal.entries),
        },
        nextDiscoveryOrder: () => 1,
      };
    });
    const operationId = randomUUID(),
      fingerprint = 'd'.repeat(64),
      input: Parameters<typeof prepareNativeIntakeAcceptanceGroup>[3] = {
        members,
        operationId,
        fingerprint,
        retainReportReceipt: sameOriginal,
        async prepareDerived(_source, { acceptance }) {
          assert.equal(acceptance.importedReceiptAddresses.length, sameOriginal ? 2 : 1);
          assert.equal(acceptance.archivedImportAddresses.length, sameOriginal ? 1 : 0);
          return { changes: [], needsReview: false };
        },
      };
    let prepared = await prepareNativeIntakeAcceptanceGroup(db, root, profileId, input);
    cleanup.push(() => prepared.dispose());
    assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 0);
    assert.throws(
      () =>
        transaction(
          db,
          () => {
            prepared.apply();
            throw Error('Fictional coupled failure');
          },
          { operationId, fingerprint },
        ),
      /Fictional coupled failure/,
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 0);
    prepared.dispose();
    prepared = await prepareNativeIntakeAcceptanceGroup(db, root, profileId, input);
    const receipt = transaction(db, () => prepared.apply(), { operationId, fingerprint });
    assert.equal(receipt.acceptedCount, 2);
    assert.equal(receipt.receipts.length, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 2);
    clearIntakeStateCache(db);
    const selected = JSON.parse(
      [...iterateIntakeEnvelopeText(db, { id: first.id })].join(''),
    ).intake;
    if (sameOriginal) {
      assert.equal(selected.workflow.reportAcceptances.length, 1);
      assert.deepEqual(selected.workflow.reportAcceptances[0].receipt, receipt);
    } else assert.equal(selected.workflow.reportAcceptances, undefined);
    if (sameOriginal) {
      assert.equal(selected.version, members[0]!.expectedVersion + 2);
      assert.equal(selected.importHistory.length, 1);
      assert.equal(selected.importHistory[0].acceptedProposalId, blocks[0]!.proposalId);
      assert.equal(selected.imported.fileId, blocks[1]!.proposalId);
      assert.equal(
        receipt.receipts[1]!.intakeVersionBefore,
        receipt.receipts[0]!.intakeVersionAfter,
      );
    }
  });
