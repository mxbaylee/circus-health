import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import {
  acceptIntakeReportSelection,
  getIntakeReportAcceptance,
} from '../intake-report-acceptance.ts';
import { attachRecordDurability, rebuildRecordDatabase } from '../record-versions.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import type { HealthRecordEnvelope, IntakeReportAcceptanceBlock } from '../../shared/intake.ts';

// Independently fictional facts: two separate measurements from the same issuer.
function assertion(id: string, literal: string): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { literal },
    provenance: {
      capturedVia: 'Fictional courier',
      sourceSystem: 'Invented Juniper Lab',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'row ' + id,
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: 'Invented serum measure',
      valueText: literal,
      unit: 'mg/L',
      date: '2025-04',
    },
  };
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'independent-intake-review-'));
  const profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const authority = memoryRecordAuthority(db);
  const opened = [db];
  t.after(() => {
    for (const connection of opened) connection.close();
    rmSync(root, { recursive: true, force: true });
  });
  const upload = (id: string, literal: string, date = '2025-04') => {
    const value = assertion(id, literal);
    value.clinical = { ...(value.clinical as object), date };
    const bytes = Buffer.from(JSON.stringify(value));
    return {
      bytes,
      item: intake.uploadIntake(db, root, profileId, {
        filename: id + '.jsonl',
        bytes,
        newProviderName: 'Invented receiving clinic',
      }),
    };
  };
  const block = (
    id: string,
    review = intake.reviewIntake(db, root, profileId, id),
  ): IntakeReportAcceptanceBlock => {
    return {
      intakeId: id,
      proposalId: null,
      intakeVersion: review.version,
      reviewToken: review.reviewToken,
      selections: review.records.map((record) => ({
        recordId: record.id,
        candidateId: record.candidateId!,
        candidateVersionId: record.candidateVersionId!,
        selectionReviewToken: record.selectionReviewToken,
        mapping: {},
      })),
    };
  };
  return { db, root, opened, upload, block, ...authority };
}

for (const mode of ['ordinary', 'counted', 'mismatched', 'unsupported'] as const)
  test(`independent: ${mode} acceptance of a previously undecided comparison`, (t) => {
    const f = fixture(t);
    const first = f.upload('separate-draw-one', '< 0.030');
    const firstOperationId = randomUUID();
    acceptIntakeReportSelection(f.db, f.root, f.profileId, {
      operationId: firstOperationId,
      blocks: [f.block(first.item.id)],
    });
    const second = f.upload('separate-draw-two', '< 0.030');
    const review = intake.reviewIntake(f.db, f.root, f.profileId, second.item.id);
    const record = review.records[0]!;
    const target = record.comparisons![0]!;
    assert.ok(target, 'the same label locates a comparison without establishing equivalence');
    intake.importIntake(f.db, f.root, f.profileId, second.item.id, {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: [
        {
          recordId: record.id,
          action: 'skip',
          mapping: {},
          comparisons: [
            {
              otherRecordId: target.id,
              scope: target.scope,
              outcome: 'unresolved',
              reason: 'The two fictional specimen identifiers have not yet been checked.',
            },
          ],
        },
      ],
    });
    const firstReceipt = getIntakeReportAcceptance(f.db, f.root, f.profileId, firstOperationId);
    const freshReview = intake.reviewIntake(f.db, f.root, f.profileId, second.item.id);
    const freshTarget = freshReview.records[0]!.comparisons!.find(
      (comparison) => comparison.id === target.id,
    )!;
    const block = f.block(second.item.id, freshReview);
    block.selections[0]!.comparisons = [
      {
        otherRecordId: mode === 'mismatched' ? 'unreviewed-target' : target.id,
        scope: freshTarget.scope,
        outcome: 'distinct',
        reason: 'The originals identify separate fictional draws.',
      },
    ];
    if (mode === 'unsupported')
      (block.selections[0]!.comparisons[0]! as unknown as { outcome: string }).outcome =
        'invented-auto-merge';
    const request = { operationId: randomUUID(), blocks: [block] };
    if (mode === 'ordinary' || mode === 'counted') {
      const staleBlock = structuredClone(block);
      staleBlock.selections[0]!.comparisons![0]!.scope = target.scope;
      if (mode === 'ordinary')
        assert.throws(
          () =>
            intake.importIntake(f.db, f.root, f.profileId, second.item.id, {
              version: staleBlock.intakeVersion,
              reviewToken: staleBlock.reviewToken,
              decisions: staleBlock.selections.map((selection) => ({
                recordId: selection.recordId,
                action: 'accept' as const,
                mapping: selection.mapping,
                comparisons: selection.comparisons,
              })),
            }),
          { code: 'DUPLICATE_SCOPE_CHANGED' },
        );
      else
        assert.throws(
          () =>
            acceptIntakeReportSelection(f.db, f.root, f.profileId, {
              operationId: request.operationId,
              blocks: [staleBlock],
            }),
          { code: 'DUPLICATE_SCOPE_CHANGED' },
        );
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 1);
      assert.equal(
        intake.reviewIntake(f.db, f.root, f.profileId, second.item.id).records[0]!.questions![0]!
          .status,
        'unanswered',
      );
      assert.deepEqual(
        getIntakeReportAcceptance(f.db, f.root, f.profileId, firstOperationId),
        firstReceipt,
      );
      if (mode === 'counted')
        assert.throws(
          () => getIntakeReportAcceptance(f.db, f.root, f.profileId, request.operationId),
          { code: 'REPORT_ACCEPTANCE_NOT_FOUND' },
        );
    }
    if (mode === 'ordinary')
      intake.importIntake(f.db, f.root, f.profileId, second.item.id, {
        version: block.intakeVersion,
        reviewToken: block.reviewToken,
        decisions: block.selections.map((selection) => ({
          recordId: selection.recordId,
          action: 'accept' as const,
          mapping: selection.mapping,
          comparisons: selection.comparisons,
        })),
      });
    else if (mode === 'mismatched' || mode === 'unsupported') {
      assert.throws(() => acceptIntakeReportSelection(f.db, f.root, f.profileId, request));
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 1);
      assert.throws(
        () => getIntakeReportAcceptance(f.db, f.root, f.profileId, request.operationId),
        { code: 'REPORT_ACCEPTANCE_NOT_FOUND' },
      );
      assert.equal(
        intake.reviewIntake(f.db, f.root, f.profileId, second.item.id).records[0]!.questions![0]!
          .status,
        'unanswered',
      );
      return;
    } else
      assert.equal(
        acceptIntakeReportSelection(f.db, f.root, f.profileId, request).receipt.acceptedCount,
        1,
      );
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 2);
    assert.equal(
      intake.reviewIntake(f.db, f.root, f.profileId, second.item.id).records[0]!.questions![0]!
        .status,
      'resolved',
    );
  });

for (const mode of ['ordinary', 'counted'] as const)
  test(`independent: ${mode} acceptance validates the explicitly corrected mapping`, (t) => {
    const f = fixture(t);
    const { item } = f.upload('juniper-transcription', '7.20', '2025-99');
    assert.equal(
      intake.reviewIntake(f.db, f.root, f.profileId, item.id).records[0]!.classification,
      'unsupported',
    );
    const block = f.block(item.id);
    block.selections[0]!.mapping = { date: '2025-04', documentDate: '2025-04' };
    if (mode === 'ordinary')
      intake.importIntake(f.db, f.root, f.profileId, item.id, {
        version: block.intakeVersion,
        reviewToken: block.reviewToken,
        decisions: block.selections.map((selection) => ({
          recordId: selection.recordId,
          action: 'accept' as const,
          mapping: selection.mapping,
        })),
      });
    else
      acceptIntakeReportSelection(f.db, f.root, f.profileId, {
        operationId: randomUUID(),
        blocks: [block],
      });
    assert.equal(
      f.db.prepare('SELECT effective_at FROM observations').get()!.effective_at,
      '2025-04',
    );
    const raw = f.db.prepare('SELECT raw_json FROM source_records').get()!;
    assert.equal(
      JSON.parse(String(raw.raw_json)).clinical.date,
      '2025-99',
      'the reviewed correction never rewrites source evidence',
    );
  });

for (const boundary of ['before_head', 'after_head'] as const)
  test(`independent: ${boundary} failure preserves exact literals, receipt truth, and original attribution after cache loss`, (t) => {
    const f = fixture(t);
    const originals = [
      f.upload('juniper-sample-one', '< 0.030'),
      f.upload('juniper-sample-two', '+004.500'),
    ];
    for (const { item } of originals)
      intake.updateIntakeMetadata(f.db, f.root, f.profileId, item.id, {
        version: item.version,
        operationId: randomUUID(),
        metadata: { source: 'Invented reviewed issuer' },
      });
    const { objects, storage } = f;
    const retained = new Map(
      [...objects]
        .filter(([name]) => name !== 'head')
        .map(([name, bytes]) => [name, Buffer.from(bytes)]),
    );
    const input = {
      operationId: randomUUID(),
      blocks: originals.map(({ item }) => f.block(item.id)),
    };
    const publish = storage.publishHead;
    storage.publishHead = (bytes) => {
      if (boundary === 'after_head') publish(bytes);
      throw new Error('independent injected head failure');
    };
    assert.throws(
      () => acceptIntakeReportSelection(f.db, f.root, f.profileId, input),
      /injected head failure/,
    );
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 0);
    for (const [name, bytes] of retained) assert.deepEqual(objects.get(name), bytes);
    storage.publishHead = publish;
    const recoveredPath = join(f.root, 'recovered.sqlite');
    rebuildRecordDatabase(recoveredPath, { profileId: f.profileId, storage });
    const recovered = openDatabase(recoveredPath, f.profileId);
    f.opened.push(recovered);
    attachRecordDurability(recovered, { profileId: f.profileId, storage });
    if (boundary === 'before_head') {
      assert.throws(
        () => getIntakeReportAcceptance(recovered, f.root, f.profileId, input.operationId),
        { code: 'REPORT_ACCEPTANCE_NOT_FOUND' },
      );
      assert.equal(recovered.prepare('SELECT count(*) AS n FROM observations').get()!.n, 0);
    }
    const saved = acceptIntakeReportSelection(recovered, f.root, f.profileId, input);
    assert.equal(saved.replayed, boundary === 'after_head');
    assert.equal(saved.receipt.acceptedCount, 2);
    const rows = recovered
      .prepare(
        'SELECT value_text,unit,effective_at,date_precision,provider_id FROM observations ORDER BY value_text',
      )
      .all();
    assert.deepEqual(
      rows.map((row) => [row.value_text, row.unit, row.effective_at, row.date_precision]),
      [
        ['+004.500', 'mg/L', '2025-04', 'month'],
        ['< 0.030', 'mg/L', '2025-04', 'month'],
      ],
    );
    for (const row of rows)
      assert.equal(
        recovered.prepare('SELECT name FROM providers WHERE id=?').get(row.provider_id!)!.name,
        'Invented reviewed issuer',
      );
    for (const { item, bytes } of originals) {
      assert.deepEqual(
        intake.getIntakeOriginal(recovered, f.root, f.profileId, item.id).bytes,
        bytes,
      );
      const acquired = recovered
        .prepare(
          'SELECT p.name FROM source_files f JOIN providers p ON p.id=f.provider_id WHERE f.id=?',
        )
        .get(item.id)!;
      assert.equal(acquired.name, 'Invented receiving clinic');
      assert.equal(
        intake.getIntake(recovered, f.root, f.profileId, item.id).workflow!.candidates[0]!
          .versions[0]!.status,
        'accepted',
      );
    }
    assert.deepEqual(
      getIntakeReportAcceptance(recovered, f.root, f.profileId, input.operationId).receipt,
      saved.receipt,
    );
    assert.equal(
      recovered.prepare("SELECT count(*) AS n FROM evidence WHERE entity_type<>'person'").get()!.n,
      2,
    );
  });

for (const stale of [false, true])
  test(`partial selections sharing an explicit comparison destination commit together (stale: ${stale})`, (t) => {
    const f = fixture(t);
    const destination = f.upload('shared-destination', '4.50');
    acceptIntakeReportSelection(f.db, f.root, f.profileId, {
      operationId: randomUUID(),
      blocks: [f.block(destination.item.id)],
    });
    const incoming = [f.upload('shared-one', '4.50'), f.upload('shared-two', '4.50')];
    const unrelated = f.upload('independent-third', '7.00', '2024-01');
    const blocks = incoming.map(({ item }) => {
      const review = intake.reviewIntake(f.db, f.root, f.profileId, item.id);
      const target = review.records[0]!.comparisons![0]!;
      assert.ok(target);
      const block = f.block(item.id, review);
      block.selections[0]!.comparisons = [
        {
          otherRecordId: target.id,
          scope: target.scope,
          outcome: 'same_event',
          occurrenceEvidence: 'attach',
          reason: 'Both fictional deliveries describe the reviewed original event.',
        },
      ];
      return block;
    });
    assert.equal(
      blocks[0]!.selections[0]!.comparisons![0]!.otherRecordId,
      blocks[1]!.selections[0]!.comparisons![0]!.otherRecordId,
    );
    if (stale) blocks[1]!.selections[0]!.selectionReviewToken = 'stale-selected-authority';
    blocks.push(f.block(unrelated.item.id));
    const receipt = acceptIntakeReportSelection(f.db, f.root, f.profileId, {
      operationId: randomUUID(),
      mode: 'partial-v1',
      blocks,
    }).receipt;
    assert.equal(receipt.atomic, false);
    if (receipt.atomic) throw new Error('Expected partial receipt');
    assert.deepEqual(
      receipt.items.map((item) => item.status),
      stale ? ['needs_review', 'needs_review', 'saved'] : ['saved', 'saved', 'saved'],
    );
    assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM evidence WHERE entity_type<>'person'").get()!.n,
      stale ? 2 : 4,
    );
  });
