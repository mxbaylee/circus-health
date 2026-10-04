import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction, revision, observeTransactionOutcome } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability, rebuildProfile } from '../portable.ts';
import {
  uploadIntake,
  reviewIntake,
  importIntake,
  importIntakeRead,
  saveIntakeReviewDraftRead,
} from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import {
  prepareCollectionClinicalReview,
  prepareCollectionClinicalReviewDependencies,
} from '../intake-review-collection-host.ts';
import { acceptIntakeReportSelectionAsync } from '../intake-report-acceptance.ts';
import { selectedClinicalPair } from '../intake-clinical-record-sections.ts';
import { duplicateRecord } from '../duplicate-review.ts';
import { canonicalLiteral } from '../intake-format.ts';
import { prepareRetainedDuplicateEvidenceSnapshot } from '../duplicate-evidence-snapshots.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { hasIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import type { IntakeReportAcceptanceRequest } from '../../shared/intake.ts';
import type { RetainedDuplicateEvidenceReference } from '../../shared/saved-duplicate-evidence.ts';
import {
  previewDirectRecordCorrection,
  applyDirectRecordCorrection,
} from '../clinical-review-routes.ts';

const envelope = (id: string) => ({
  format: 'health-record-v1',
  id,
  kind: 'document',
  payload: { text: 'Fictional visit note from ' + id },
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
    documentTitle: 'Shared fictional visit',
    date: '2026-01-01',
  },
});

test('direct native import retains fresh same-event evidence through own maintenance and exact replay', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-direct-pair-')),
    profileId = 'fictional-profile',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const upload = (id: string) =>
    uploadIntake(db, root, profileId, {
      filename: id + '.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(JSON.stringify(envelope(id))),
    });
  const saved = upload('saved-direct'),
    review = reviewIntake(db, root, profileId, saved.id);
  importIntake(db, root, profileId, saved.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  const targetId = String(db.prepare('SELECT id FROM documents').get()!.id),
    expected = canonicalLiteral(duplicateRecord(db, 'document', targetId).evidence),
    incoming = upload('incoming-direct');
  await buildIntakeCollectionEnvelope(db, { id: incoming.id, sha256: incoming.sha256 });
  await prepareCollectionClinicalReviewDependencies(db, root, profileId, incoming.id);
  const selected = prepareCollectionClinicalReview(db, root, profileId, incoming.id);
  if (selected.status !== 'ready') throw Error('Expected complete direct review');
  const record = selected.session.review.records[0]!,
    comparison = selectedClinicalPair(db, selected.session.review, record, targetId);
  assert.ok(comparison?.scope);
  assert.equal(comparison.scope.format, 'intake-pair-scope-v2');
  const input = {
    version: selected.session.review.version,
    reviewToken: selected.session.review.reviewToken,
    proposalId: null,
    decisions: [
      {
        recordId: record.id,
        action: 'accept' as const,
        mapping: {},
        comparisons: [
          {
            otherRecordId: targetId,
            scope: comparison.scope,
            outcome: 'same_event' as const,
            occurrenceEvidence: 'attach' as const,
            reason: 'Fictional direct approval retains another source for this reviewed visit.',
          },
        ],
      },
    ],
  };
  selected.session.close();
  const stale = structuredClone(input),
    staleScope = stale.decisions[0]!.comparisons[0]!.scope;
  if (staleScope.format !== 'intake-pair-scope-v2') throw Error('Expected exact v2 scope');
  staleScope.requestRevision--;
  const { token: _token, ...payload } = staleScope;
  staleScope.token = createHash('sha256').update(canonicalLiteral(payload)).digest('hex');
  const beforeStale = revision(db);
  await assert.rejects(importIntakeRead(db, root, profileId, incoming.id, stale), {
    code: 'DUPLICATE_SCOPE_CHANGED',
  });
  assert.equal(revision(db), beforeStale);
  assert.equal(db.prepare('SELECT 1 FROM source_records WHERE id=?').get(record.id), undefined);

  let maintenance = 0;
  const stopObserving = observeTransactionOutcome(db, (outcome) => {
    if (outcome.committed && outcome.intakeMaintenance) maintenance++;
  });
  let accepted: Awaited<ReturnType<typeof importIntakeRead>>;
  try {
    accepted = await importIntakeRead(db, root, profileId, incoming.id, input);
  } finally {
    stopObserving();
  }
  assert.ok(
    maintenance > 0,
    'The actual direct approval must cross its own certified preparation writes',
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 1);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM evidence WHERE entity_id=?').get(targetId)!.n,
    2,
  );
  const decisionRows = () =>
    db
      .prepare(
        "SELECT coverage_json FROM manual_batches WHERE title='Duplicate evidence decision' ORDER BY id",
      )
      .all();
  assert.equal(decisionRows().length, 1);
  const decision = JSON.parse(String(decisionRows()[0]!.coverage_json)).duplicateDecision as {
    evidenceBasis: string;
    evidence: { right: RetainedDuplicateEvidenceReference };
  };
  assert.equal(decision.evidenceBasis, 'reviewed-pre-projection-v1');
  assert.equal(decision.evidence.right.source.intakeId, incoming.id);
  const retained = await prepareRetainedDuplicateEvidenceSnapshot(db, decision.evidence.right);
  try {
    assert.equal([...retained.chunks()].join(''), expected);
  } finally {
    retained.close();
  }
  const beforeReplay = revision(db),
    priorDecisions = decisionRows(),
    replay = await importIntakeRead(db, root, profileId, incoming.id, input);
  assert.equal(replay.version, accepted.version);
  assert.equal(revision(db), beforeReplay);
  assert.deepEqual(decisionRows(), priorDecisions);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM evidence WHERE entity_id=?').get(targetId)!.n,
    2,
  );
  const changed = structuredClone(input);
  changed.decisions[0]!.comparisons[0]!.reason = 'A changed decision is not exact replay.';
  await assert.rejects(importIntakeRead(db, root, profileId, incoming.id, changed), {
    code: 'OPERATION_CONFLICT',
  });
  await prepareCollectionClinicalReviewDependencies(db, root, profileId, incoming.id);
  const reopened = prepareCollectionClinicalReview(db, root, profileId, incoming.id);
  if (reopened.status !== 'ready') throw Error('Expected complete accepted source review');
  try {
    const current = reopened.session.record(record.id)!;
    assert.equal(current.reviewState, 'accepted');
    const pair = selectedClinicalPair(db, reopened.session.review, current, targetId);
    assert.equal(pair?.previousDecision?.attachmentStatus, 'attached');
    assert.equal(pair?.previousDecision?.scopeStatus, 'current');
  } finally {
    reopened.session.close();
  }
});

test('native duplicate snapshots preserve custody through accepted kind changes and return to an earlier kind', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-duplicate-kind-')),
    profileId = 'fictional-profile',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const upload = (id: string, kind: 'document' | 'observation') =>
    uploadIntake(db, root, profileId, {
      filename: id + '.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        JSON.stringify(
          kind === 'document'
            ? envelope(id)
            : {
                ...envelope(id),
                kind: 'record',
                clinical: {
                  kind: 'observation',
                  subject: 'unknown',
                  date: '2026-01-01',
                  testLabel: 'Fictional classification value',
                  valueText: '12.00',
                  unit: 'fictional units',
                },
              },
        ),
      ),
    });
  const saved = upload('saved-kind', 'document'),
    review = reviewIntake(db, root, profileId, saved.id);
  importIntake(db, root, profileId, saved.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  const targetId = String(db.prepare('SELECT id FROM documents').get()!.id),
    originalEvidence = db.prepare('SELECT * FROM evidence WHERE entity_id=?').get(targetId)!;
  transaction(db, () => {
    for (let index = 0; index < 16; index++)
      db.prepare(
        'INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role,locator_json) VALUES(?,?,?,?,?,?)',
      ).run(
        'kind-evidence-' + String(index).padStart(3, '0'),
        'document',
        targetId,
        originalEvidence.source_record_id!,
        'fictional_support_' + index,
        originalEvidence.locator_json!,
      );
  });
  const expected = canonicalLiteral(duplicateRecord(db, 'document', targetId).evidence);
  const latest = () =>
    JSON.parse(
      String(
        db
          .prepare(
            "SELECT json_extract(coverage_json,'$.duplicateDecision.evidence.right') AS reference FROM manual_batches WHERE json_extract(coverage_json,'$.duplicateDecision.right.id')=? AND json_extract(coverage_json,'$.duplicateDecision.evidenceBasis')='reviewed-pre-projection-v1' ORDER BY json_extract(coverage_json,'$.duplicateDecision.sequence') DESC LIMIT 1",
          )
          .get(targetId)!.reference,
      ),
    ) as RetainedDuplicateEvidenceReference;
  async function compare(id: string, kind: 'document' | 'observation') {
    const source = upload(id, kind);
    await buildIntakeCollectionEnvelope(db, { id: source.id, sha256: source.sha256 });
    await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id);
    const selected = prepareCollectionClinicalReview(db, root, profileId, source.id);
    if (selected.status !== 'ready') throw Error('Expected complete kind-change review');
    const record = selected.session.review.records[0]!,
      comparison = selectedClinicalPair(db, selected.session.review, record, targetId);
    assert.ok(comparison?.scope);
    const result = await acceptIntakeReportSelectionAsync(db, root, profileId, {
      operationId: randomUUID(),
      blocks: [
        {
          intakeId: source.id,
          proposalId: null,
          intakeVersion: selected.session.review.version,
          reviewToken: selected.session.review.reviewToken,
          selections: [
            {
              recordId: record.id,
              candidateId: record.candidateId!,
              candidateVersionId: record.candidateVersionId!,
              mapping: {},
              comparisons: [
                {
                  otherRecordId: targetId,
                  scope: comparison.scope,
                  outcome: 'distinct',
                  reason: 'Fictional evidence supports different visits.',
                },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(result.receipt.acceptedCount, 1);
    return latest();
  }
  function reclassify(kind: 'document' | 'observation', set: Record<string, string>) {
    const request = {
        kind,
        recordId: targetId,
        set,
        reason: 'The fictional original supports the reviewed classification.',
      },
      preview = previewDirectRecordCorrection(db, root, profileId, request);
    applyDirectRecordCorrection(db, root, profileId, {
      ...request,
      version: preview.version,
      previewToken: preview.previewToken,
      operationId: randomUUID(),
    });
  }
  const first = await compare('incoming-kind-a', 'document');
  reclassify('document', {
    kind: 'observation',
    testLabel: 'Fictional classification value',
    valueText: '12.00',
    unit: 'fictional units',
  });
  let before = intakeWorkCounters(db).warm.duplicateSnapshotChangedRows;
  const second = await compare('incoming-kind-b', 'observation');
  assert.equal(intakeWorkCounters(db).warm.duplicateSnapshotChangedRows - before, 0);
  assert.equal(second.source.intakeId, first.source.intakeId);
  assert.notEqual(second.snapshotId, first.snapshotId);
  reclassify('observation', {
    kind: 'document',
    documentTitle: 'Shared fictional visit',
    text: 'Fictional reviewed narrative',
  });
  before = intakeWorkCounters(db).warm.duplicateSnapshotChangedRows;
  const third = await compare('incoming-kind-c', 'document');
  assert.equal(intakeWorkCounters(db).warm.duplicateSnapshotChangedRows - before, 0);
  assert.equal(third.source.intakeId, first.source.intakeId);
  assert.notEqual(third.snapshotId, first.snapshotId);
  for (const [reference, kind] of [
    [first, 'document'],
    [second, 'observation'],
    [third, 'document'],
  ] as const) {
    const retained = await prepareRetainedDuplicateEvidenceSnapshot(db, reference);
    try {
      assert.deepEqual(retained.target, [kind, targetId]);
      assert.equal([...retained.chunks()].join(''), expected);
    } finally {
      retained.close();
    }
  }
});

test('native terminal pair composes its first saved-evidence snapshot with the incoming draft', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-terminal-')),
    profileId = 'fictional-profile',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const upload = (id: string) =>
    uploadIntake(db, root, profileId, {
      filename: id + '.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(JSON.stringify(envelope(id))),
    });
  const saved = upload('saved-terminal'),
    savedReview = reviewIntake(db, root, profileId, saved.id);
  importIntake(db, root, profileId, saved.id, {
    version: savedReview.version,
    reviewToken: savedReview.reviewToken,
    decisions: [{ recordId: savedReview.records[0]!.id, action: 'accept', mapping: {} }],
  });
  const targetId = String(db.prepare('SELECT id FROM documents').get()!.id),
    expected = canonicalLiteral(duplicateRecord(db, 'document', targetId).evidence),
    incoming = upload('incoming-terminal');
  await buildIntakeCollectionEnvelope(db, { id: incoming.id, sha256: incoming.sha256 });
  await prepareCollectionClinicalReviewDependencies(db, root, profileId, incoming.id);
  const selected = prepareCollectionClinicalReview(db, root, profileId, incoming.id);
  if (selected.status !== 'ready') throw Error('Expected complete terminal review');
  const record = selected.session.review.records[0]!,
    comparison = selectedClinicalPair(db, selected.session.review, record, targetId);
  assert.ok(comparison?.scope);
  const input = {
    version: selected.session.review.version,
    operationId: randomUUID(),
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    disposition: 'keep_original_only' as const,
    decision: {
      recordId: record.id,
      action: 'skip' as const,
      mapping: {},
      comparisons: [
        {
          otherRecordId: targetId,
          scope: comparison.scope,
          outcome: 'same_event' as const,
          occurrenceEvidence: 'attach' as const,
          reason: 'Fictional terminal original supports the same reviewed visit.',
        },
      ],
    },
  };
  await saveIntakeReviewDraftRead(db, root, profileId, incoming.id, input);
  assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 1);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM evidence WHERE entity_id=?').get(targetId)!.n,
    2,
  );
  const row = db
      .prepare(
        "SELECT json_extract(coverage_json,'$.duplicateDecision.evidence.right') AS reference FROM manual_batches WHERE json_extract(coverage_json,'$.duplicateDecision.evidenceBasis')='reviewed-pre-projection-v1'",
      )
      .get()!,
    reference = JSON.parse(String(row.reference)) as RetainedDuplicateEvidenceReference;
  assert.equal(reference.source.intakeId, incoming.id);
  const reader = await prepareRetainedDuplicateEvidenceSnapshot(db, reference);
  try {
    assert.equal([...reader.chunks()].join(''), expected);
  } finally {
    reader.close();
  }
  await saveIntakeReviewDraftRead(db, root, profileId, incoming.id, input);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM evidence WHERE entity_id=?').get(targetId)!.n,
    2,
  );
  await prepareCollectionClinicalReviewDependencies(db, root, profileId, incoming.id);
  const reopened = prepareCollectionClinicalReview(db, root, profileId, incoming.id);
  if (reopened.status !== 'ready') throw Error('Expected complete saved terminal review');
  assert.equal(reopened.session.record(record.id)?.reviewState, 'kept_original');
  assert.equal(
    selectedClinicalPair(db, reopened.session.review, reopened.session.record(record.id)!, targetId)
      ?.previousDecision?.scopeStatus,
    'current',
  );
});

for (const mode of ['atomic', 'partial-v1'] as const)
  // These fixtures retain 97 evidence rows, exercise concurrent/stale approvals,
  // and reconstruct contributor authority before replay. The host hang budget
  // covers real journal/filesystem work; exact outcomes and changed-row counts
  // below remain the qualification, independently of elapsed time.
  test(
    `compound native pair approval (${mode}) retains reviewed evidence, changed-row snapshots and recovery replay`,
    { timeout: 180000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'fictional-native-duplicate-')),
        profileId = 'fictional-profile',
        db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
      attachPersonalDurability(db, { root, profileId });
      t.after(() => {
        clearIntakeStateCache(db);
        db.close();
        rmSync(root, { recursive: true, force: true });
      });
      const upload = (id: string) =>
        uploadIntake(db, root, profileId, {
          filename: id + '.jsonl',
          newProviderName: 'Fictional clinic',
          bytes: Buffer.from(JSON.stringify(envelope(id))),
        });
      const original = upload('saved');
      const initial = reviewIntake(db, root, profileId, original.id);
      importIntake(db, root, profileId, original.id, {
        version: initial.version,
        reviewToken: initial.reviewToken,
        decisions: [{ recordId: initial.records[0]!.id, action: 'accept', mapping: {} }],
      });
      const targetId = String(db.prepare('SELECT id FROM documents').get()!.id),
        firstEvidence = db.prepare('SELECT * FROM evidence WHERE entity_id=?').get(targetId)!;
      transaction(db, () => {
        for (let index = 0; index < 96; index++)
          db.prepare(
            'INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role,locator_json) VALUES(?,?,?,?,?,?)',
          ).run(
            'fictional-retained-' + String(index).padStart(4, '0'),
            'document',
            targetId,
            firstEvidence.source_record_id!,
            'fictional_support_' + index,
            firstEvidence.locator_json!,
          );
      });
      const beforeEvidence = duplicateRecord(db, 'document', targetId).evidence,
        beforeText = canonicalLiteral(beforeEvidence),
        beforeDigest = createHash('sha256').update(beforeText).digest('hex');
      assert.equal(beforeEvidence.length, 97);
      assert.equal(hasIntakeCollectionEnvelope(db, { id: original.id }), false);

      async function request(ids: string[]): Promise<IntakeReportAcceptanceRequest> {
        const sources = ids.map(upload);
        for (const source of sources)
          await buildIntakeCollectionEnvelope(db, { id: source.id, sha256: source.sha256 });
        for (const source of sources)
          await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id);
        return {
          ...(mode === 'partial-v1' ? { mode } : {}),
          operationId: randomUUID(),
          blocks: sources.map((source) => {
            const selected = prepareCollectionClinicalReview(db, root, profileId, source.id);
            assert.equal(selected.status, 'ready');
            if (selected.status !== 'ready') throw Error('Expected complete native review');
            const review = selected.session.review,
              record = review.records[0]!,
              comparison = selectedClinicalPair(db, review, record, targetId);
            assert.ok(comparison?.scope);
            return {
              intakeId: source.id,
              proposalId: null,
              intakeVersion: review.version,
              reviewToken: review.reviewToken,
              selections: [
                {
                  recordId: record.id,
                  candidateId: record.candidateId!,
                  candidateVersionId: record.candidateVersionId!,
                  selectionReviewToken: record.selectionReviewToken!,
                  mapping: {},
                  comparisons: [
                    {
                      otherRecordId: targetId,
                      scope: comparison.scope,
                      outcome: 'same_event',
                      occurrenceEvidence: 'attach',
                      reason: 'Independent fictional export of the same reviewed visit.',
                    },
                  ],
                },
              ],
            };
          }),
        };
      }
      const decisions = (database: typeof db) =>
        database
          .prepare(
            "SELECT json_extract(coverage_json,'$.duplicateDecision') AS value FROM manual_batches WHERE json_extract(coverage_json,'$.duplicateDecision.evidenceBasis')='reviewed-pre-projection-v1' ORDER BY json_extract(coverage_json,'$.duplicateDecision.sequence')",
          )
          .all()
          .map(
            (row) =>
              JSON.parse(String(row.value)) as {
                evidenceBasis: string;
                evidence: { right: RetainedDuplicateEvidenceReference };
                occurrenceAttachment: { status: string };
              },
          );
      async function read(database: typeof db, ref: RetainedDuplicateEvidenceReference) {
        const reader = await prepareRetainedDuplicateEvidenceSnapshot(database, ref);
        try {
          return [...reader.chunks()].join('');
        } finally {
          reader.close();
        }
      }
      const compound = await request(['incoming-a', 'incoming-b']);
      if (mode === 'atomic') {
        const unreviewed = structuredClone(compound);
        unreviewed.operationId = randomUUID();
        unreviewed.blocks[0]!.reviewToken = 'not-the-complete-reviewed-token';
        const beforeUnreviewed = revision(db);
        await assert.rejects(acceptIntakeReportSelectionAsync(db, root, profileId, unreviewed), {
          code: 'REVIEW_CHANGED',
        });
        assert.equal(revision(db), beforeUnreviewed);
        const stale = structuredClone(compound);
        stale.operationId = randomUUID();
        for (const block of stale.blocks)
          for (const selection of block.selections)
            for (const comparison of selection.comparisons || []) {
              const scope = comparison.scope;
              if (scope?.format !== 'intake-pair-scope-v2') throw Error('Expected exact v2 scope');
              scope.requestRevision--;
              const { token: _token, ...payload } = scope;
              scope.token = createHash('sha256').update(canonicalLiteral(payload)).digest('hex');
            }
        await assert.rejects(acceptIntakeReportSelectionAsync(db, root, profileId, stale), {
          code: 'DUPLICATE_SCOPE_CHANGED',
        });
        assert.equal(decisions(db).length, 0);
      }
      const accepted = await acceptIntakeReportSelectionAsync(db, root, profileId, compound);
      assert.equal(accepted.receipt.acceptedCount, 2);
      assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 1);
      assert.equal(
        db.prepare('SELECT count(*) AS n FROM evidence WHERE entity_id=?').get(targetId)!.n,
        99,
      );
      const retained = decisions(db);
      assert.equal(retained.length, 2);
      assert.deepEqual(retained[0]!.evidence.right, retained[1]!.evidence.right);
      const first = retained[0]!.evidence.right;
      assert.equal(first.count, 97);
      assert.equal(first.digest, beforeDigest);
      assert.equal(
        first.source.intakeId,
        compound.blocks[0]!.intakeId,
        'legacy target uses the first native incoming custodian',
      );
      assert.equal(await read(db, first), beforeText);
      assert.ok(retained.every((item) => item.occurrenceAttachment.status === 'attached'));
      const replay = await acceptIntakeReportSelectionAsync(db, root, profileId, compound);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.receipt, accepted.receipt);
      assert.equal(decisions(db).length, 2);
      for (const block of compound.blocks) {
        await prepareCollectionClinicalReviewDependencies(db, root, profileId, block.intakeId);
        const reopened = prepareCollectionClinicalReview(db, root, profileId, block.intakeId);
        if (reopened.status !== 'ready') throw Error('Expected accepted native source review');
        const pair = selectedClinicalPair(
          db,
          reopened.session.review,
          reopened.session.record(block.selections[0]!.recordId)!,
          targetId,
        );
        assert.equal(pair?.previousDecision?.attachmentStatus, 'attached');
        assert.equal(pair?.previousDecision?.scopeStatus, 'current');
      }

      const secondText = canonicalLiteral(duplicateRecord(db, 'document', targetId).evidence),
        next = await request(['incoming-c']),
        changedBefore = intakeWorkCounters(db).warm.duplicateSnapshotChangedRows;
      const nextResult = await acceptIntakeReportSelectionAsync(db, root, profileId, next),
        latest = decisions(db).at(-1)!.evidence.right;
      assert.equal(intakeWorkCounters(db).warm.duplicateSnapshotChangedRows - changedBefore, 2);
      assert.equal(latest.count, 99);
      assert.equal(latest.source.intakeId, first.source.intakeId);
      assert.equal(await read(db, latest), secondText);
      assert.equal(await read(db, first), beforeText);
      assert.equal(
        db.prepare('SELECT count(*) AS n FROM evidence WHERE entity_id=?').get(targetId)!.n,
        100,
      );

      const recoveredRoot = join(root, 'recovered'),
        rebuilt = rebuildProfile(root, profileId, recoveredRoot),
        recovered = openDatabase(rebuilt.database, profileId);
      attachPersonalDurability(recovered, { root: recoveredRoot, profileId });
      try {
        assert.equal(await read(recovered, first), beforeText);
        assert.equal(await read(recovered, latest), secondText);
        assert.equal(
          recovered.prepare('SELECT count(*) AS n FROM evidence WHERE entity_id=?').get(targetId)!
            .n,
          100,
        );
        const replay = await acceptIntakeReportSelectionAsync(
          recovered,
          recoveredRoot,
          profileId,
          next,
        );
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.receipt, nextResult.receipt);
        assert.deepEqual(decisions(recovered), decisions(db));
      } finally {
        clearIntakeStateCache(recovered);
        recovered.close();
      }
      if (mode === 'atomic') {
        const racing = await request(['incoming-race']);
        const mutation = new Promise<void>((resolve, reject) => {
          setImmediate(() => {
            try {
              transaction(db, () => undefined, { actor: 'intake-envelope-build' });
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        });
        await assert.rejects(
          acceptIntakeReportSelectionAsync(db, root, profileId, racing),
          (error: unknown) => error instanceof Error && /changed|Refresh/i.test(error.message),
        );
        await mutation;
        assert.equal(decisions(db).length, 3);
        assert.equal(
          db.prepare('SELECT count(*) AS n FROM evidence WHERE entity_id=?').get(targetId)!.n,
          100,
        );
      }
    },
  );
