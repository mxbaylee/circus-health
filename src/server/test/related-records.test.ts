import { fixtureTransaction } from './helpers/accepted-record-fixture.ts';
import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { attachPersonalDurability } from '../portable.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import { getIntakeIdentityReview, confirmIntakeIdentityScope } from '../intake-identity.ts';
import { getIntakeRelatedRecords } from '../related-records.ts';
import { listIntakeReportQueue, getIntakeReportQueueGroup } from '../intake-report-queue.ts';
import { duplicateRecord, saveDuplicateDecision } from '../duplicate-review.ts';
import { previewRecordCorrection } from '../record-corrections.ts';
import { applyClinicalDecision } from '../mapping-actions.ts';
import { acceptIntakeReportSelection } from '../intake-report-acceptance.ts';
import { createBackup } from '../recovery.ts';
import { rebuildProfile } from '../portable.ts';
import { getNote, saveNote } from '../notes.ts';
import { hasUnreviewedPairChoices } from '../../shared/clinical-review.ts';
import type {
  HealthRecordEnvelope,
  IntakeEvidenceComparison,
  IntakePairDecision,
  IntakeReview,
} from '../../shared/intake.ts';

function sample(
  id: string,
  label = 'Fictional serum alpha',
  code = 'FICTION-A',
): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { printed: id + ' < 0.040' },
    provenance: {
      capturedVia: 'Invented courier',
      sourceSystem: 'Fictional Orchid laboratory',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'specimen ' + id,
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'observation' as const,
      subject: 'self',
      date: '2025-03-17',
      testLabel: label,
      valueText: '< 0.040',
      unit: 'mg/L',
      code,
      codeSystem: 'urn:fictional:orchid',
    },
  };
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-related-review-')),
    profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId: profileId });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const upload = (values: HealthRecordEnvelope[]) =>
    intake.uploadIntake(db, root, profileId, {
      filename: 'invented-' + randomUUID() + '.jsonl',
      bytes: Buffer.from(values.map((value) => JSON.stringify(value)).join('\n')),
      newProviderName: 'Fictional receiving clinic',
    });
  const review = (id: string) => intake.reviewIntake(db, root, profileId, id);
  const accept = (current: IntakeReview, comparisons?: IntakePairDecision[]) =>
    intake.importIntake(db, root, profileId, current.intakeId, {
      version: current.version,
      reviewToken: current.reviewToken,
      decisions: current.records.map((record) => ({
        recordId: record.id,
        action: 'accept',
        mapping: {},
        ...(comparisons ? { comparisons } : {}),
      })),
    });
  const search = (
    current: IntakeReview,
    options: { query?: string; cursor?: string | null; limit?: number } = {},
  ) =>
    getIntakeRelatedRecords(db, root, profileId, current.intakeId, {
      proposalId: null,
      recordId: current.records[0]!.id,
      candidateVersionId: current.records[0]!.candidateVersionId!,
      ...options,
    });
  const correct = (id: string, literal: string) => {
    const input = {
      kind: 'observation' as const,
      recordId: id,
      set: { valueText: literal },
      reason: 'The independently fictional original supports this reviewed correction.',
    };
    const preview = previewRecordCorrection(db, input);
    return applyClinicalDecision(db, root, profileId, 'clinical_correction', {
      ...input,
      operationId: randomUUID(),
      previewToken: preview.token,
      version: preview.version,
    });
  };
  return { db, root, profileId, upload, review, accept, search, correct };
}
const choose = (
  other: IntakeEvidenceComparison,
  outcome: IntakePairDecision['outcome'] = 'distinct',
): IntakePairDecision => ({
  otherRecordId: other.id,
  scope: other.scope,
  outcome,
  reason: 'Separate fictional specimen identifiers appear in the originals.',
});

const attach = (other: IntakeEvidenceComparison): IntakePairDecision => ({
  otherRecordId: other.id,
  scope: other.scope,
  outcome: 'same_event',
  reason: 'Both fictional originals explicitly identify another occurrence of one event.',
  occurrenceEvidence: 'attach',
});

test('ranked discovery finds code aliases beyond exact labels, pages past twelve, and never merges similar values', (t) => {
  const f = fixture(t);
  const values = Array.from({ length: 24 }, (_, i) =>
    sample('draw-' + i, 'Fictional serum alpha', 'OTHER-CODE'),
  );
  values.push(sample('code-alias', 'Alternate plasma name', 'FICTION-A'));
  values.push(sample('unrelated', 'Independent optical note', 'UNRELATED-CODE'));
  f.accept(f.review(f.upload(values).id));
  const pending = f.review(f.upload([sample('new-draw')]).id);
  assert.equal(hasUnreviewedPairChoices(pending.records[0]!), false);
  const first = f.search(pending, { limit: 7 });
  assert.equal(first.comparisons[0]!.title, 'Alternate plasma name');
  assert.ok(first.comparisons[0]!.discoveryReasons!.includes('same_code'));
  assert.ok(!first.comparisons[0]!.discoveryReasons!.includes('same_label'));
  const ids = first.comparisons.map((record) => record.id);
  let cursor = first.page.nextCursor;
  while (cursor) {
    const page = f.search(pending, { limit: 7, cursor });
    ids.push(...page.comparisons.map((record) => record.id));
    cursor = page.page.nextCursor;
  }
  assert.equal(ids.length, 25);
  assert.equal(new Set(ids).size, 25);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 26);
  const refined = f.search(pending, { query: 'unrelated' });
  assert.equal(
    refined.comparisons.length,
    1,
    'explicit search can locate a particular saved specimen outside automatic signals',
  );
  assert.equal(refined.comparisons[0]!.title, 'Independent optical note');
  assert.ok(refined.comparisons[0]!.discoveryReasons!.includes('search_match'));
  assert.ok(Array.isArray(refined.comparisons[0]!.evidence));
  assert.ok(
    refined.comparisons[0]!.evidence.every((evidence) =>
      evidence.contentUrl?.startsWith('/api/sources/'),
    ),
  );
  assert.deepEqual(f.search(pending, { limit: 7 }), first);
  assert.throws(() => f.search(pending, { limit: 8, cursor: first.page.nextCursor }), {
    code: 'RELATED_RECORD_SEARCH_CHANGED',
  });
});

test('bounded discovery reports truncation, literal search characters, and stale page cursors', (t) => {
  const f = fixture(t);
  const values = Array.from({ length: 205 }, (_, i) => sample('bounded-' + i));
  values.push(sample('literal-percent', 'Literal 5% specimen', 'UNRELATED'));
  f.accept(f.review(f.upload(values).id));
  const pending = f.review(f.upload([sample('bounded-incoming')]).id);
  const page = f.search(pending, { limit: 50 });
  assert.equal(page.page.returned, 50);
  assert.equal(page.page.truncated, true);
  assert.equal(page.page.maximumResults, 200);
  const literal = f.search(pending, { query: '%' });
  assert.deepEqual(
    literal.comparisons.map((record) => record.title),
    ['Literal 5% specimen'],
  );
  assert.throws(() => f.search(pending, { limit: 51 }), { code: 'RELATED_RECORD_SEARCH' });
  const savedId = String(f.db.prepare('SELECT id FROM observations ORDER BY id LIMIT 1').get()!.id);
  f.correct(savedId, '0.05');
  assert.throws(
    () => f.search(f.review(pending.intakeId), { limit: 50, cursor: page.page.nextCursor }),
    { code: 'RELATED_RECORD_SEARCH_CHANGED' },
  );
});

test('a fresh same-event choice attaches one lossless occurrence without rewriting the target', (t) => {
  const f = fixture(t);
  f.accept(f.review(f.upload([sample('attachment-target')]).id));
  const targetBefore = f.db.prepare('SELECT * FROM observations').get()!;
  const pending = f.review(f.upload([sample('attachment-incoming')]).id);
  const incoming = pending.records[0]!;
  const comparison = incoming.comparisons!.find(
    (candidate) => candidate.id === String(targetBefore.id),
  )!;
  assert.equal(comparison.scope?.format, 'intake-pair-scope-v2');

  const saved = f.accept(pending, [attach(comparison)]);
  assert.equal(saved.imported!.clinical!.records![0]!.outcome, 'matched');
  assert.equal(saved.imported!.clinical!.records![0]!.entityId, targetBefore.id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.deepEqual(f.db.prepare('SELECT * FROM observations').get(), targetBefore);
  const evidence = f.db
    .prepare('SELECT * FROM evidence WHERE entity_type=? AND entity_id=? ORDER BY id')
    .all('observation', targetBefore.id);
  assert.equal(evidence.length, 2);
  assert.equal(evidence.filter((row) => row.role === 'same_event_occurrence').length, 1);
  assert.equal(
    evidence.find((row) => row.role === 'same_event_occurrence')!.source_record_id,
    incoming.id,
  );
  f.accept(pending, [attach(comparison)]);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM evidence WHERE role='same_event_occurrence'").get()!.n,
    1,
    'exact import replay never inserts the deterministic occurrence twice',
  );
  let refreshed = f.review(pending.intakeId);
  assert.equal(refreshed.records[0]!.comparisons![0]!.previousDecision!.scopeStatus, 'current');

  transaction(f.db, () =>
    f.db
      .prepare(
        "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role,locator_json) VALUES(?,?,?,?, 'independent_support',?)",
      )
      .run(
        'fictional-independent-same-source-row',
        'observation',
        targetBefore.id,
        incoming.id,
        JSON.stringify({ locator: 'independent fictional locator' }),
      ),
  );
  refreshed = f.review(pending.intakeId);
  assert.equal(
    refreshed.records[0]!.comparisons![0]!.previousDecision!.scopeStatus,
    'stale',
    'a different row using the same source record is never hidden by self-exclusion',
  );
});

test('counted acceptance attaches two prevalidated occurrences to one target atomically', (t) => {
  const f = fixture(t);
  f.accept(f.review(f.upload([sample('counted-attachment-target')]).id));
  const targetId = String(f.db.prepare('SELECT id FROM observations').get()!.id);
  const intakeA = f.upload([sample('counted-occurrence-a')]);
  const intakeB = f.upload([sample('counted-occurrence-b')]);
  const intakeOther = f.upload([
    sample('counted-unaffected', 'Fictional unrelated retained result', 'FICTION-OTHER'),
  ]);
  const reviewA = f.review(intakeA.id);
  const reviewB = f.review(intakeB.id);
  const reviewOther = f.review(intakeOther.id);
  const selection = (review: IntakeReview) => {
    const record = review.records[0]!;
    const target = record.comparisons!.find((candidate) => candidate.id === targetId)!;
    return {
      recordId: record.id,
      candidateId: record.candidateId!,
      candidateVersionId: record.candidateVersionId!,
      mapping: {},
      comparisons: [attach(target)],
    };
  };
  const request = {
    operationId: randomUUID(),
    blocks: [
      {
        intakeId: reviewA.intakeId,
        proposalId: null,
        intakeVersion: reviewA.version,
        reviewToken: reviewA.reviewToken,
        selections: [selection(reviewA)],
      },
      {
        intakeId: reviewB.intakeId,
        proposalId: null,
        intakeVersion: reviewB.version,
        reviewToken: reviewB.reviewToken,
        selections: [selection(reviewB)],
      },
      {
        intakeId: reviewOther.intakeId,
        proposalId: null,
        intakeVersion: reviewOther.version,
        reviewToken: reviewOther.reviewToken,
        selections: [
          {
            recordId: reviewOther.records[0]!.id,
            candidateId: reviewOther.records[0]!.candidateId!,
            candidateVersionId: reviewOther.records[0]!.candidateVersionId!,
            mapping: {},
          },
        ],
      },
    ],
  };
  const conflictingFile = f.db
    .prepare('SELECT provider_id,batch_id FROM source_files WHERE id=?')
    .get(intakeB.id)!;
  fixtureTransaction(f.db, () =>
    f.db
      .prepare(
        'INSERT INTO source_records(id,source_file_id,provider_id,source_key,kind,label,raw_json,locator_json,extraction_status,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        reviewB.records[0]!.id,
        intakeB.id,
        conflictingFile.provider_id,
        'line:1',
        'intake_record',
        'counted-occurrence-b',
        JSON.stringify({ independentlyChanged: true }),
        JSON.stringify({ independentlyChanged: true }),
        'retained_unprojected',
        conflictingFile.batch_id,
      ),
  );
  const refreshRequest = () => {
    for (const block of request.blocks) {
      const refreshed = f.review(block.intakeId);
      block.reviewToken = refreshed.reviewToken;
      block.intakeVersion = refreshed.version;
      for (const chosen of block.selections) {
        if ('comparisons' in chosen) {
          const current = refreshed.records.find((record) => record.id === chosen.recordId)!;
          chosen.comparisons = [
            attach(current.comparisons!.find((candidate) => candidate.id === targetId)!),
          ];
        }
      }
    }
  };
  refreshRequest();
  assert.throws(() => acceptIntakeReportSelection(f.db, f.root, f.profileId, request), {
    code: 'SOURCE_CHANGED',
  });
  assert.equal(
    f.db.prepare('SELECT 1 FROM source_records WHERE id=?').get(reviewA.records[0]!.id),
    undefined,
    'an earlier valid block is rolled back when a later incoming row conflicts',
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM evidence WHERE role='same_event_occurrence'").get()!.n,
    0,
  );
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM manual_batches WHERE title='Duplicate evidence decision'")
      .get()!.n,
    0,
  );
  fixtureTransaction(f.db, () =>
    f.db.prepare('DELETE FROM source_records WHERE id=?').run(reviewB.records[0]!.id),
  );

  refreshRequest();
  const result = acceptIntakeReportSelection(f.db, f.root, f.profileId, request);
  assert.equal(result.receipt.selectedCount, 3);
  assert.equal(result.receipt.acceptedCount, 3);
  assert.deepEqual(
    result.receipt.receipts.slice(0, 2).map((receipt) => receipt.records[0]!.outcome),
    ['matched', 'matched'],
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM evidence WHERE entity_type='observation' AND entity_id=? AND role='same_event_occurrence'",
      )
      .get(targetId)!.n,
    2,
  );
  for (const review of [reviewA, reviewB])
    assert.equal(
      f
        .review(review.intakeId)
        .records[0]!.comparisons!.find((candidate) => candidate.id === targetId)!.previousDecision!
        .scopeStatus,
      'current',
    );
});

test('fresh non-same review withdraws only the exact occurrence and cross-kind correction waits', (t) => {
  const f = fixture(t);
  f.accept(f.review(f.upload([sample('withdraw-target')]).id));
  const targetId = String(f.db.prepare('SELECT id FROM observations').get()!.id);
  const pending = f.review(f.upload([sample('withdraw-incoming')]).id);
  const comparison = pending.records[0]!.comparisons!.find(
    (candidate) => candidate.id === targetId,
  )!;
  f.accept(pending, [attach(comparison)]);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM evidence WHERE role='same_event_occurrence'").get()!.n,
    1,
  );

  f.correct(targetId, '0.043');
  assert.equal(
    f
      .review(pending.intakeId)
      .records[0]!.comparisons!.find((candidate) => candidate.id === targetId)!.previousDecision!
      .scopeStatus,
    'stale',
    'same-kind correction keeps the occurrence but stales the prior authority',
  );

  assert.throws(
    () =>
      previewRecordCorrection(f.db, {
        kind: 'observation',
        recordId: targetId,
        set: { kind: 'document', documentTitle: 'Fictional reclassification' },
        reason: 'Fictional correction after reviewing the retained original.',
      }),
    { code: 'OCCURRENCE_ATTACHMENT_ACTIVE' },
  );
  assert.throws(
    () =>
      previewRecordCorrection(f.db, {
        kind: 'observation',
        recordId: targetId,
        set: { kind: 'unsupported-future-kind' },
        reason: 'Fictional correction cannot bypass an active occurrence attachment.',
      }),
    { code: 'OCCURRENCE_ATTACHMENT_ACTIVE' },
  );

  const current = f.review(pending.intakeId);
  const active = current.records[0]!.comparisons!.find((candidate) => candidate.id === targetId)!;
  assert.equal(active.scope?.format, 'intake-pair-scope-v2');
  assert.ok(active.scope?.format === 'intake-pair-scope-v2' && active.scope.activeAttachment);
  const withdrawn = intake.importIntake(f.db, f.root, f.profileId, current.intakeId, {
    version: current.version,
    reviewToken: current.reviewToken,
    decisions: [
      {
        recordId: current.records[0]!.id,
        action: 'skip',
        mapping: {},
        comparisons: [
          {
            otherRecordId: targetId,
            scope: active.scope,
            outcome: 'distinct',
            reason: 'The fictional originals establish two separate events.',
          },
        ],
      },
    ],
  });
  assert.equal(withdrawn.imported!.clinical!.retainedOnly, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM evidence WHERE role='same_event_occurrence'").get()!.n,
    0,
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.equal(
    f
      .review(pending.intakeId)
      .records[0]!.comparisons!.find((candidate) => candidate.id === targetId)!.previousDecision!
      .scopeStatus,
    'current',
  );
});

test('one exact request can withdraw an occurrence and attach it to another reviewed target', (t) => {
  const f = fixture(t);
  f.accept(f.review(f.upload([sample('move-target-a')]).id));
  f.accept(f.review(f.upload([sample('move-target-b', 'Fictional plasma alpha', 'FICTION-A')]).id));
  const targets = f.db
    .prepare('SELECT id FROM observations ORDER BY id')
    .all()
    .map((row) => String(row.id));
  assert.equal(targets.length, 2);
  const pending = f.review(f.upload([sample('move-incoming')]).id);
  const first = pending.records[0]!.comparisons!.find((item) => item.id === targets[0])!;
  f.accept(pending, [attach(first)]);

  const current = f.review(pending.intakeId);
  const from = current.records[0]!.comparisons!.find((item) => item.id === targets[0])!;
  const to = current.records[0]!.comparisons!.find((item) => item.id === targets[1])!;
  assert.ok(from.scope?.format === 'intake-pair-scope-v2' && from.scope.activeAttachment);
  const moved = f.accept(current, [choose(from, 'distinct'), attach(to)]);
  assert.equal(moved.imported!.clinical!.records![0]!.entityId, targets[1]);
  assert.equal(moved.imported!.clinical!.records![0]!.outcome, 'matched');
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM evidence WHERE role='same_event_occurrence' AND entity_id=?")
      .get(targets[0])!.n,
    0,
  );
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM evidence WHERE role='same_event_occurrence' AND entity_id=?")
      .get(targets[1])!.n,
    1,
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
});

test('finalization never reanchors a pre-existing receipt that happens to share its revision', (t) => {
  const f = fixture(t);
  f.accept(f.review(f.upload([sample('receipt-target')]).id));
  const targetId = String(f.db.prepare('SELECT id FROM observations').get()!.id);
  const first = f.review(f.upload([sample('receipt-occurrence-one')]).id);
  f.accept(first, [
    attach(first.records[0]!.comparisons!.find((candidate) => candidate.id === targetId)!),
  ]);
  const prior = f.db
    .prepare(
      "SELECT id,coverage_json FROM manual_batches WHERE title='Duplicate evidence decision' ORDER BY id LIMIT 1",
    )
    .get() as { id: string; coverage_json: string };
  let second = f.review(f.upload([sample('receipt-occurrence-two')]).id);
  const forgedCollision = JSON.parse(prior.coverage_json);
  forgedCollision.duplicateDecision.occurrenceAttachment.appliedRevision =
    Number(f.db.prepare("SELECT value FROM app_meta WHERE key='revision'").get()!.value) + 2;
  fixtureTransaction(f.db, () =>
    f.db
      .prepare('UPDATE manual_batches SET coverage_json=? WHERE id=?')
      .run(JSON.stringify(forgedCollision), prior.id),
  );
  const immutablePrior = String(
    f.db.prepare('SELECT coverage_json FROM manual_batches WHERE id=?').get(prior.id)!
      .coverage_json,
  );

  second = f.review(second.intakeId);
  f.accept(second, [
    attach(second.records[0]!.comparisons!.find((candidate) => candidate.id === targetId)!),
  ]);
  assert.equal(
    f.db.prepare('SELECT coverage_json FROM manual_batches WHERE id=?').get(prior.id)!
      .coverage_json,
    immutablePrior,
    'only trusted decision IDs registered by the active operation may be finalized',
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM evidence WHERE role='same_event_occurrence'").get()!.n,
    2,
  );
});

test('a relationship from a later search page retains undecided and resolved history across reload and rebuild', async (t) => {
  const f = fixture(t);
  f.accept(f.review(f.upload(Array.from({ length: 24 }, (_, i) => sample('saved-' + i))).id));
  let pending = f.review(f.upload([sample('incoming-later-page')]).id);
  const first = f.search(pending, { limit: 20 });
  const second = f.search(pending, { limit: 20, cursor: first.page.nextCursor });
  const target = second.comparisons[0]!;
  assert.ok(!pending.records[0]!.comparisons!.some((record) => record.id === target.id));
  const record = pending.records[0]!;
  intake.importIntake(f.db, f.root, f.profileId, pending.intakeId, {
    version: pending.version,
    reviewToken: pending.reviewToken,
    decisions: [
      {
        recordId: record.id,
        action: 'skip',
        mapping: {},
        comparisons: [choose(target, 'unresolved')],
      },
    ],
  });
  pending = f.review(pending.intakeId);
  const refreshedFirst = f.search(pending, { limit: 20 });
  const refreshedSecond = f.search(pending, {
    limit: 20,
    cursor: refreshedFirst.page.nextCursor,
  });
  const refreshedTarget = refreshedSecond.comparisons.find((item) => item.id === target.id)!;
  assert.equal(
    pending.records[0]!.questions!.find((question) => question.otherRecordId === target.id)!.status,
    'unanswered',
  );
  const request = {
    operationId: randomUUID(),
    blocks: [
      {
        intakeId: pending.intakeId,
        proposalId: null,
        intakeVersion: pending.version,
        reviewToken: pending.reviewToken,
        selections: [
          {
            recordId: record.id,
            candidateId: record.candidateId!,
            candidateVersionId: record.candidateVersionId!,
            mapping: {},
            comparisons: [choose(refreshedTarget)],
          },
        ],
      },
    ],
  };
  const result = acceptIntakeReportSelection(f.db, f.root, f.profileId, request);
  assert.equal(result.receipt.acceptedCount, 1);
  const journal = f.db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Duplicate evidence decision' ORDER BY json_extract(coverage_json,'$.duplicateDecision.sequence') DESC LIMIT 1",
    )
    .get()!;
  assert.deepEqual(
    JSON.parse(String(journal.coverage_json)).duplicateDecision.intakeScope,
    refreshedTarget.scope,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 25);
  const resolved = f
    .review(pending.intakeId)
    .records[0]!.questions!.find((question) => question.otherRecordId === target.id)!;
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.answers.length, 2);
  const backup = await createBackup(f.db, f.root, f.profileId),
    rebuiltRoot = join(f.root, 'rebuilt-page');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, rebuiltRoot),
    db = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(db, { root: rebuiltRoot, profileId: f.profileId });
  try {
    const restored = intake
      .reviewIntake(db, rebuiltRoot, f.profileId, pending.intakeId)
      .records[0]!.questions!.find((question) => question.otherRecordId === target.id)!;
    assert.deepEqual(restored, resolved);
  } finally {
    db.close();
  }
});

test('correcting a saved record and returning A to B to A invalidates the pending relationship without altering retained drafts', (t) => {
  const f = fixture(t);
  f.accept(f.review(f.upload([sample('old-result')]).id));
  let current = f.review(f.upload([sample('new-result')]).id);
  const record = current.records[0]!,
    target = record.comparisons![0]!,
    decision = choose(target);
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, current.intakeId, {
    version: current.version,
    operationId: randomUUID(),
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    decision: { recordId: record.id, action: 'accept', mapping: {}, comparisons: [decision] },
  });
  const before = structuredClone(f.review(current.intakeId).records[0]!.draft);
  f.correct(target.id, '0.041');
  f.correct(target.id, '< 0.040');
  current = f.review(current.intakeId);
  assert.equal(current.records[0]!.comparisonDrafts![0]!.status, 'stale');
  assert.equal(hasUnreviewedPairChoices(current.records[0]!), true);
  const group = listIntakeReportQueue(f.db, f.root, f.profileId).groups.find(
    (group) => group.intakeId === current.intakeId,
  )!;
  const queued = getIntakeReportQueueGroup(f.db, f.root, f.profileId, group.groupId);
  assert.equal(
    queued.blocks.flatMap((block) => block.records)[0]!.selectable,
    false,
    'a stale pair decision cannot appear ready for counted acceptance',
  );
  assert.equal(queued.group.counts.blocked, 1);
  assert.deepEqual(current.records[0]!.draft, before);
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, current.intakeId, {
    version: current.version,
    operationId: randomUUID(),
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    mapping: { referenceText: 'Fictional unrelated annotation' },
    decision: current.records[0]!.draft!.decision!,
  });
  current = f.review(current.intakeId);
  assert.equal(current.records[0]!.comparisonDrafts![0]!.status, 'stale');
  assert.deepEqual(current.records[0]!.draft!.decision!.comparisons![0], decision);
  assert.equal(
    current.records[0]!.comparisons![0]!.version,
    target.version,
    'clinical fields returned to A',
  );
  assert.notEqual(
    current.records[0]!.comparisons![0]!.scope!.saved.stateHash,
    target.scope!.saved.stateHash,
    'accepted history did not return to its old version',
  );
  assert.throws(() => f.accept(current, [decision]), { code: 'DUPLICATE_SCOPE_CHANGED' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 1);
  f.accept(current, [choose(current.records[0]!.comparisons![0]!)]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 2);
});

test('missing, edited, cross-profile and wrong-original scopes cannot authorize a pending relationship', (t) => {
  const f = fixture(t);
  f.accept(f.review(f.upload([sample('scope-saved')]).id));
  const pending = f.review(f.upload([sample('scope-incoming')]).id),
    target = pending.records[0]!.comparisons![0]!;
  for (const variation of [
    'missing',
    'wrong-original',
    'profile',
    'incoming-version',
    'saved-id',
  ] as const) {
    const decision = structuredClone(choose(target));
    if (variation === 'missing') delete decision.scope;
    if (variation === 'wrong-original') decision.scope!.saved.evidenceHash = '0'.repeat(64);
    if (variation === 'profile') decision.scope!.profileId = 'another-profile';
    if (variation === 'incoming-version')
      decision.scope!.incoming.stateHash = 'candidate-version:changed';
    if (variation === 'saved-id') decision.scope!.saved.recordId = 'another-record';
    assert.throws(() => f.accept(pending, [decision]), { code: 'DUPLICATE_SCOPE_CHANGED' });
  }
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM manual_batches WHERE title='Duplicate evidence decision'")
      .get()!.n,
    0,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 1);
  assert.throws(
    () =>
      getIntakeRelatedRecords(f.db, f.root, 'another-profile', pending.intakeId, {
        proposalId: null,
        recordId: pending.records[0]!.id,
        candidateVersionId: pending.records[0]!.candidateVersionId!,
      }),
    { code: 'PROFILE_BOUNDARY' },
  );
});

test('malformed, legacy-scoped, and multiple occurrence attachment markers fail closed', (t) => {
  const f = fixture(t);
  f.accept(
    f.review(
      f.upload([sample('marker-target-one'), sample('marker-target-two', 'Fictional serum alpha')])
        .id,
    ),
  );
  const pending = f.review(f.upload([sample('marker-incoming')]).id);
  const targets = pending.records[0]!.comparisons!;
  assert.ok(targets.length >= 2);
  const wrongOutcome = { ...attach(targets[0]!), outcome: 'distinct' as const };
  assert.throws(() => f.accept(pending, [wrongOutcome]), { code: 'DUPLICATE_DECISION' });

  const unknown = {
    ...attach(targets[0]!),
    occurrenceEvidence: 'merge',
  } as unknown as IntakePairDecision;
  assert.throws(() => f.accept(pending, [unknown]), { code: 'DUPLICATE_DECISION' });

  const legacy = structuredClone(attach(targets[0]!));
  legacy.scope = {
    format: 'intake-pair-scope-v1',
    profileId: legacy.scope!.profileId,
    incoming: legacy.scope!.incoming,
    saved: legacy.scope!.saved,
    token: legacy.scope!.token,
  };
  assert.throws(() => f.accept(pending, [legacy]), { code: 'DUPLICATE_SCOPE_CHANGED' });

  assert.throws(() => f.accept(pending, [attach(targets[0]!), attach(targets[1]!)]), {
    code: 'DUPLICATE_DECISION',
  });
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM evidence WHERE role='same_event_occurrence'").get()!.n,
    0,
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
});

test('ordinary attachment verifies every deterministic incoming source field before mutation', (t) => {
  const f = fixture(t);
  const targetIntake = f.upload([sample('incoming-authority-target')]);
  f.accept(f.review(targetIntake.id));
  const targetId = String(f.db.prepare('SELECT id FROM observations').get()!.id);
  const alternateIntake = f.upload([sample('incoming-authority-alternate-file')]);
  const envelope = sample('incoming-authority-occurrence');
  const pendingIntake = f.upload([envelope]);
  let pending = f.review(pendingIntake.id);
  const record = pending.records[0]!;
  const acquisition = f.db
    .prepare(
      'SELECT f.provider_id,f.batch_id,p.name FROM source_files f JOIN providers p ON p.id=f.provider_id WHERE f.id=?',
    )
    .get(pendingIntake.id)!;
  const otherFile = f.db
    .prepare('SELECT id,batch_id FROM source_files WHERE id=?')
    .get(alternateIntake.id)!;
  const otherProviderId = 'provider:fictional-same-name-drift';
  fixtureTransaction(f.db, () =>
    f.db
      .prepare('INSERT INTO providers(id,name) VALUES(?,?)')
      .run(otherProviderId, acquisition.name),
  );
  const exact = {
    id: record.id,
    source_file_id: pendingIntake.id,
    provider_id: acquisition.provider_id,
    source_key: 'line:1',
    kind: 'intake_record',
    label: envelope.id,
    raw_json: JSON.stringify(envelope),
    locator_json: JSON.stringify({
      line: 1,
      originalSourceFileId: pendingIntake.id,
      selectedProposalId: null,
      sourceEnvelopeId: envelope.id,
      literal: true,
    }),
    extraction_status: 'retained_unprojected',
    batch_id: acquisition.batch_id,
  };
  const mismatches = [
    ['raw_json', JSON.stringify({ independentlyChanged: true })],
    ['source_key', 'line:999'],
    ['label', 'Independently changed label'],
    ['locator_json', JSON.stringify({ independentlyChanged: true })],
    ['source_file_id', otherFile.id],
    ['kind', 'intake_document'],
    ['batch_id', otherFile.batch_id],
    ['provider_id', otherProviderId],
    ['extraction_status', 'mapped'],
  ] as const;
  const insert = f.db.prepare(
    'INSERT INTO source_records(id,source_file_id,provider_id,source_key,kind,label,raw_json,locator_json,extraction_status,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
  );
  for (const [field, changed] of mismatches) {
    const conflicting = { ...exact, [field]: changed };
    fixtureTransaction(f.db, () => insert.run(...Object.values(conflicting)));
    pending = f.review(pendingIntake.id);
    const currentComparison = pending.records[0]!.comparisons!.find(
      (candidate) => candidate.id === targetId,
    )!;
    assert.throws(() => f.accept(pending, [attach(currentComparison)]), { code: 'SOURCE_CHANGED' });
    assert.deepEqual(
      {
        ...f.db
          .prepare(
            'SELECT id,source_file_id,provider_id,source_key,kind,label,raw_json,locator_json,extraction_status,batch_id FROM source_records WHERE id=?',
          )
          .get(record.id),
      },
      conflicting,
      `${field} conflict is not normalized, promoted or marked projected`,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM evidence WHERE role='same_event_occurrence'").get()!.n,
      0,
    );
    assert.equal(
      f.db
        .prepare("SELECT count(*) n FROM manual_batches WHERE title='Duplicate evidence decision'")
        .get()!.n,
      0,
    );
    fixtureTransaction(f.db, () =>
      f.db.prepare('DELETE FROM source_records WHERE id=?').run(record.id),
    );
  }

  pending = f.review(pendingIntake.id);
  const accepted = f.accept(pending, [
    attach(pending.records[0]!.comparisons!.find((candidate) => candidate.id === targetId)!),
  ]);
  assert.equal(accepted.imported!.clinical!.records![0]!.outcome, 'matched');
  const staleEnvelope = sample('incoming-authority-stale-revision');
  const stale = f.review(f.upload([staleEnvelope]).id);
  const staleTarget = stale.records[0]!.comparisons!.find(
    (candidate) => candidate.id === targetId,
  )!;
  transaction(f.db, () =>
    f.db
      .prepare('INSERT INTO providers(id,name) VALUES(?,?)')
      .run('provider:independent-revision', 'Fictional independent revision'),
  );
  assert.throws(() => f.accept(stale, [attach(staleTarget)]), { code: 'REVIEW_CHANGED' });
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM evidence WHERE role='same_event_occurrence'").get()!.n,
    1,
  );
});

test('a physically changed saved original invalidates acceptance even when its old database hash and scope remain', (t) => {
  const f = fixture(t);
  const saved = f.upload([sample('original-integrity')]);
  f.accept(f.review(saved.id));
  const pending = f.review(f.upload([sample('integrity-incoming')]).id);
  const target = pending.records[0]!.comparisons![0]!;
  const original = f.db.prepare('SELECT path FROM source_files WHERE id=?').get(saved.id)!;
  writeFileSync(
    profileOriginal(f.root, String(original.path), f.profileId),
    'Independently fictional corrupted original bytes',
  );
  assert.throws(() => f.accept(pending, [choose(target)]), { code: 'SOURCE_CHANGED' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 1);
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM manual_batches WHERE title='Duplicate evidence decision'")
      .get()!.n,
    0,
  );
});

test('legacy pending choices remain visible but unpinned; historical accepted pair journals are never rewritten', async (t) => {
  const f = fixture(t);
  const patient = 'Fictional Avery Orchid';
  const self = getNote(f.db, 'person-note:self');
  saveNote(f.db, self.id, {
    version: self.version,
    person: { ...self.person, fullName: patient },
  });
  const scopedSample = (id: string): HealthRecordEnvelope => ({
    ...sample(id),
    payload: { printed: id + ' < 0.040', patient },
    report: {
      key: id,
      title: id,
      anchor: { locator: 'specimen ' + id, text: id },
      subject: { locator: 'specimen ' + id, text: patient },
    },
    reviewIssues: [
      {
        kind: 'identity',
        field: 'subject',
        prompt: 'Confirm the printed patient.',
        textAnchor: patient,
        selfSuggestion: { fullName: patient },
      },
    ],
  });
  const reviewSubject = async (id: string) => {
    const identityOriginal = intake.getIntake(f.db, f.root, f.profileId, id);
    for (const group of identityOriginal.workflow?.reportGroups || []) {
      const identity = await getIntakeIdentityReview(
        f.db,
        f.root,
        f.profileId,
        identityOriginal.id,
        group.id,
      );
      assert.ok(identity.scope);
      assert.equal(identity.scope.subject.text, 'Fictional Avery Orchid');
      if (identity.blocking)
        await confirmIntakeIdentityScope(f.db, f.root, f.profileId, identityOriginal.id, {
          version: identity.scope.intakeVersion,
          operationId: randomUUID(),
          scope: identity.scope,
          outcome: 'this_is_me',
          attestation: 'confirmed_displayed_identity_questions',
        });
    }
  };
  const firstOriginal = f.upload([scopedSample('legacy-one'), scopedSample('legacy-two')]);
  await reviewSubject(firstOriginal.id);
  f.accept(f.review(firstOriginal.id));
  const ids = f.db
    .prepare('SELECT id FROM observations ORDER BY id')
    .all()
    .map((row) => String(row.id));
  transaction(f.db, () =>
    saveDuplicateDecision(
      f.db,
      duplicateRecord(f.db, 'observation', ids[0]!),
      duplicateRecord(f.db, 'observation', ids[1]!),
      { outcome: 'distinct', reason: 'Previously reviewed fictional independent specimens.' },
      randomUUID(),
    ),
  );
  const legacyJournal = f.db
    .prepare("SELECT coverage_json FROM manual_batches WHERE title='Duplicate evidence decision'")
    .get()!.coverage_json;
  const copy = scopedSample('legacy-one');
  copy.payload = {
    printed: 'legacy-one < 0.040',
    patient,
    delivery: 'A new fictional copy retains the same source assertion.',
  };
  const nextOriginal = f.upload([copy]);
  await reviewSubject(nextOriginal.id);
  const pending = f.review(nextOriginal.id),
    record = pending.records[0]!;
  const target = record.comparisons!.find((other) => other.previousDecision)!;
  assert.equal(target.previousDecision!.scopeStatus, 'legacy');
  assert.equal(
    hasUnreviewedPairChoices(record),
    false,
    'accepted legacy history alone never blocks an unrelated pending record',
  );
  // Construct only the fictional legacy storage shape that older application versions wrote.
  transaction(f.db, () => {
    const row = f.db.prepare('SELECT id FROM source_files WHERE id=?').get(pending.intakeId)!;
    const details = JSON.parse(readIntakeEnvelopeText(f.db, { id: String(row.id) })!);
    details.intake.workflow.reviewDrafts.push({
      id: 'fictional-old-draft',
      proposalId: null,
      recordId: record.id,
      candidateId: record.candidateId,
      candidateVersionId: record.candidateVersionId,
      mapping: {},
      resolutions: [],
      disposition: 'pending',
      at: '2025-03-18T00:00:00Z',
      decision: {
        recordId: record.id,
        action: 'accept',
        mapping: {},
        comparisons: [
          { otherRecordId: target.id, outcome: 'distinct', reason: 'Old unpinned choice.' },
        ],
      },
    });
    writeIntakeFixtureEnvelope(f.db, pending.intakeId, details);
  });
  let refreshed = f.review(pending.intakeId);
  assert.equal(refreshed.records[0]!.comparisonDrafts![0]!.status, 'missing');
  assert.equal(hasUnreviewedPairChoices(refreshed.records[0]!), true);
  assert.throws(
    () =>
      intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, pending.intakeId, {
        version: refreshed.version,
        operationId: randomUUID(),
        proposalId: null,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId!,
        decision: {
          recordId: record.id,
          action: 'accept',
          mapping: {},
          comparisons: [
            {
              otherRecordId: target.id,
              outcome: 'distinct',
              reason: 'A changed explicit choice still has no scope.',
            },
          ],
        },
      }),
    { code: 'DUPLICATE_SCOPE_CHANGED' },
  );
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, pending.intakeId, {
    version: refreshed.version,
    operationId: randomUUID(),
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    mapping: { referenceText: 'An unrelated fictional draft annotation' },
    decision: refreshed.records[0]!.draft!.decision!,
  });
  refreshed = f.review(pending.intakeId);
  assert.equal(refreshed.records[0]!.comparisonDrafts![0]!.status, 'missing');
  assert.equal(
    refreshed.records[0]!.draft!.mapping.referenceText,
    'An unrelated fictional draft annotation',
  );
  assert.throws(() => f.accept(refreshed, refreshed.records[0]!.draft!.decision!.comparisons), {
    code: 'DUPLICATE_SCOPE_CHANGED',
  });
  assert.equal(
    f.db
      .prepare("SELECT coverage_json FROM manual_batches WHERE title='Duplicate evidence decision'")
      .get()!.coverage_json,
    legacyJournal,
  );
  const backup = await createBackup(f.db, f.root, f.profileId),
    rebuiltRoot = join(f.root, 'rebuilt');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, rebuiltRoot),
    db = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(db, { root: rebuiltRoot, profileId: f.profileId });
  try {
    const restored = intake.reviewIntake(db, rebuiltRoot, f.profileId, pending.intakeId);
    assert.equal(restored.records[0]!.comparisonDrafts![0]!.status, 'missing');
    assert.equal(
      db
        .prepare(
          "SELECT coverage_json FROM manual_batches WHERE title='Duplicate evidence decision'",
        )
        .get()!.coverage_json,
      legacyJournal,
    );
  } finally {
    db.close();
  }
});

for (const discovery of ['later-page', 'explicit-search'] as const)
  for (const changed of [false, true])
    test(`partial approval resolves ${discovery} destinations and preserves changed authority rejection (${changed})`, (t) => {
      const f = fixture(t);
      f.accept(
        f.review(
          f.upload([
            ...Array.from({ length: 24 }, (_, i) => sample('saved-' + i)),
            sample('search-only-destination', 'Zircon marker', 'OTHER-CODE'),
          ]).id,
        ),
      );
      const pending = f.review(f.upload([sample('incoming-selected')]).id);
      const first = f.search(pending, { limit: 20 });
      const target = (
        discovery === 'later-page'
          ? f.search(pending, { limit: 20, cursor: first.page.nextCursor })
          : f.search(pending, { query: 'search-only-destination' })
      ).comparisons[0]!;
      assert.ok(target);
      assert.ok(!pending.records[0]!.comparisons!.some((item) => item.id === target.id));
      const independent = f.review(
        f.upload([sample('independent-selected', 'Separate gamma', 'OTHER-GAMMA')]).id,
      );
      const blockFor = (review: IntakeReview, comparisons?: IntakePairDecision[]) => ({
        intakeId: review.intakeId,
        proposalId: review.proposalId,
        intakeVersion: review.version,
        reviewToken: review.reviewToken,
        selections: review.records.map((record) => ({
          recordId: record.id,
          candidateId: record.candidateId!,
          candidateVersionId: record.candidateVersionId!,
          selectionReviewToken: record.selectionReviewToken,
          mapping: record.mapping,
          comparisons,
        })),
      });
      if (changed) f.correct(target.id, '0.125');
      // The first independent commit advances transport revisions, not the person's
      // approval of this exact off-page destination. A real correction still rejects it.
      const result = acceptIntakeReportSelection(f.db, f.root, f.profileId, {
        mode: 'partial-v1',
        operationId: randomUUID(),
        blocks: [blockFor(independent), blockFor(pending, [choose(target)])],
      }).receipt;
      assert.equal(result.atomic, false);
      if (result.atomic) throw Error('Expected partial receipt');
      assert.deepEqual(
        result.items.map((item) => item.status),
        ['saved', changed ? 'needs_review' : 'saved'],
      );
      assert.equal(result.acceptedCount, changed ? 1 : 2);
      if (changed) assert.equal(result.items[1]!.reasonCode, 'DUPLICATE_SCOPE_CHANGED');
      assert.equal(
        f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n,
        changed ? 26 : 27,
      );
    });
