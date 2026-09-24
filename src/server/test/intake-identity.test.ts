import { zipFixture } from '../../tests/fixtures/zip.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import {
  getIntakeIdentityReview,
  getIntakeIdentityScope,
  confirmIntakeIdentityScope,
} from '../intake-identity.ts';
import {
  exactCurrentIdentityResolutionOperationId,
  identityReceiptAppliesToCurrentBoundary,
} from '../intake-identity-policy.ts';
import { acceptIntakeReportSelection } from '../intake-report-acceptance.ts';
import { listIntakeImportFeed } from '../intake-report-queue.ts';
import { getNote, saveNote } from '../notes.ts';
import { createBackup } from '../recovery.ts';
import { attachPersonalDurability, personalDurabilityStatus, rebuildProfile } from '../portable.ts';
import { fictionalModel } from './fictional-model.ts';
import type { HealthRecordEnvelope, Intake } from '../../shared/intake.ts';
import type {
  IntakeIdentityScope,
  IntakeIdentityConfirmation,
} from '../../shared/intake-identity.ts';

const heading = 'Fictional report IVY-61';
const subject = 'Patient: Fictional Iris Meadow';
const fictionalBirthDate = '1990-03-08';
const identityLine = `${subject}\nDOB: ${fictionalBirthDate}`;
const originalText = `${heading}\n${identityLine}\nFictional result A 12.00\nFictional result B 14.00`;
const envelope = (id: string): HealthRecordEnvelope => ({
  format: 'health-record-v1',
  id,
  kind: 'record',
  payload: { literal: '12.00' },
  provenance: {
    capturedVia: null,
    sourceSystem: 'Invented Clinic',
    sourceRecordId: id,
    evidenceClass: 'provider_export',
    locator: 'page 1 result ' + id,
  },
  coverage: { status: 'complete_response', notes: [] },
  clinical: {
    kind: 'observation',
    subject: 'unknown',
    testLabel: 'Fictional test ' + id,
    valueText: '12.00',
    unit: 'mg',
    date: '2026-03-02',
  },
  report: {
    key: 'claim',
    title: 'Fictional report',
    anchor: { locator: 'page 1 heading', text: heading },
    subject: { locator: 'page 1 patient', text: subject },
  },
});
function fixture(t: TestContext, bytes = Buffer.from(originalText), filename = 'fictional.txt') {
  const root = mkdtempSync(join(tmpdir(), 'fictional-identity-'));
  const profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const item = intake.uploadIntake(db, root, profileId, {
    filename,
    bytes,
    newProviderName: 'Invented Clinic',
  });
  const propose = (values: HealthRecordEnvelope[], target = item.id) =>
    intake.proposeConversion(db, root, profileId, target, {
      version: intake.getIntake(db, root, profileId, target).version,
      summary: 'Independently invented proposal',
      jsonlText: values.map((value) => JSON.stringify(value)).join('\n'),
    });
  const preview = (target = item.id, groupId?: string) =>
    getIntakeIdentityScope(
      db,
      root,
      profileId,
      target,
      groupId || intake.getIntake(db, root, profileId, target).workflow!.reportGroups![0]!.id,
    );
  const confirm = (scope: IntakeIdentityScope, operationId = 'fictional-identity-confirmation') =>
    confirmIntakeIdentityScope(db, root, profileId, item.id, request(scope, operationId));
  return { root, profileId, db, item, propose, preview, confirm };
}
const request = (
  scope: IntakeIdentityScope,
  operationId = 'fictional-confirm',
): IntakeIdentityConfirmation => ({
  version: scope.intakeVersion,
  operationId,
  scope,
  outcome: 'this_is_me',
  attestation: 'reviewed_original_and_membership',
});
const workflow = (f: ReturnType<typeof fixture>) =>
  intake.getIntake(f.db, f.root, f.profileId, f.item.id).workflow!;

function setSelf(
  f: ReturnType<typeof fixture>,
  fields: { fullName?: string; birthDate?: string; knownNames?: string[] },
) {
  const current = getNote(f.db, 'person-note:self');
  return saveNote(f.db, current.id, {
    version: current.version,
    person: { ...current.person, ...fields },
  });
}

function withIdentityEvidence(
  value: HealthRecordEnvelope,
  fullName = 'Fictional Iris Meadow',
  birthDate = fictionalBirthDate,
): HealthRecordEnvelope {
  value.payload = {
    literal: (value.payload as { literal?: string }).literal,
    transcript: `${value.report!.subject!.text}\nDOB: ${birthDate}`,
  };
  value.reviewIssues = [
    {
      kind: 'identity',
      field: 'subject',
      prompt: 'Does the printed fictional patient identity belong to you?',
      textAnchor: `${value.report!.subject!.text}\nDOB: ${birthDate}`,
      selfSuggestion: { fullName, birthDate },
    },
  ];
  return value;
}

function withAnchorOnlyIdentity(
  value: HealthRecordEnvelope,
  textAnchor = identityLine,
): HealthRecordEnvelope & {
  reviewIssues: { kind: 'identity'; field: 'subject'; prompt: string; textAnchor?: string }[];
} {
  return {
    ...value,
    reviewIssues: [
      {
        kind: 'identity',
        field: 'subject',
        prompt: 'Does the printed fictional patient identity belong to you?',
        textAnchor,
      },
    ],
  };
}

test('explicit common confirmation pins exact membership and appends drafts atomically without acceptance or Self update', async (t) => {
  const f = fixture(t);
  const item = f.propose([envelope('a'), envelope('b')]);
  const beforeSelf = f.db.prepare("SELECT * FROM people WHERE relationship='self'").all();
  const scope = await f.preview();
  assert.equal(scope.targets.length, 2);
  assert.equal(scope.verificationMode, 'literal_text_match');
  assert.equal(scope.subject.text, subject);
  assert.equal(scope.membership.length, 2);
  const saved = await f.confirm(scope);
  assert.equal(saved.workflow!.identityConfirmations!.length, 1);
  assert.deepEqual(saved.workflow!.identityConfirmations![0]!.scope, scope);
  assert.equal(saved.workflow!.decisions.length, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  assert.deepEqual(
    f.db.prepare("SELECT * FROM people WHERE relationship='self'").all(),
    beforeSelf,
  );
  const review = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, item.proposals[0]!.id);
  assert.ok(review.records.every((record) => record.mapping.subject === 'self'));
  assert.ok(
    review.records.every((record) =>
      record
        .issues!.filter((issue) => issue.kind === 'identity')
        .every((issue) => issue.status === 'resolved'),
    ),
  );
  assert.deepEqual((await f.confirm(scope)).workflow, saved.workflow);
  await assert.rejects(() => f.confirm({ ...scope, groupVersionId: 'changed' }), {
    code: 'OPERATION_CONFLICT',
  });
});

test('explicit report confirmation clears exact identity-question accounting and survives rebuild', async (t) => {
  const f = fixture(t);
  const proposed = f.propose([envelope('accounted-exact')]);
  let item = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  const record = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  ).records[0]!;
  item = intake.askIntakeQuestion(f.db, f.root, f.profileId, f.item.id, {
    version: item.version,
    key: 'fictional-exact-subject-question',
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    field: 'subject',
    prompt: 'Does the fictional subject printed on this report belong to you?',
    locator: record.evidence[0]!.locator,
  });
  assert.equal(item.unansweredCount, 1);

  const scope = await f.preview();
  assert.deepEqual(scope.questions, [
    { prompt: 'Does the fictional subject printed on this report belong to you?' },
  ]);
  item = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'fictional-exact-accounting-confirmation'),
    attestation: 'confirmed_displayed_identity_questions',
  });
  assert.equal(item.workflow!.questions[0]!.status, 'unanswered');
  assert.equal(item.unansweredCount, 0);
  assert.ok(
    item.workflow!.reviewDrafts!.some(
      (draft) =>
        draft.candidateId === record.candidateId &&
        draft.candidateVersionId === record.candidateVersionId &&
        draft.resolutions.some(
          (resolution) =>
            resolution.issueId === item.workflow!.questions[0]!.id &&
            resolution.outcome === 'this_is_me',
        ),
    ),
  );

  let confirmedReview = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  );
  assert.ok(
    confirmedReview.records[0]!.issues!.filter((issue) => issue.kind === 'identity').every(
      (issue) => issue.status === 'resolved',
    ),
  );
  const retainedReview = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    workflow(f).reportGroups![0]!.id,
  );
  assert.equal(retainedReview.status, 'prior_confirmation');
  assert.equal(retainedReview.blocking, false);
  assert.equal(retainedReview.scope!.targets.length, 0);
  assert.equal(
    listIntakeImportFeed(f.db, f.root, f.profileId, { view: 'all' }).blocks[0]!.records[0]!
      .selectable,
    true,
  );
  const beforeSecondQuestion = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  item = intake.askIntakeQuestion(f.db, f.root, f.profileId, f.item.id, {
    version: beforeSecondQuestion.version,
    key: 'fictional-later-subject-question',
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    field: 'subject',
    prompt: 'Does the second fictional subject clue also identify you?',
    locator: record.evidence[0]!.locator,
  });
  const afterSecondQuestion = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  assert.throws(
    () =>
      intake.askIntakeQuestion(f.db, f.root, f.profileId, f.item.id, {
        version: afterSecondQuestion.version,
        key: 'fictional-later-subject-question',
        candidateId: record.candidateId,
        candidateVersionId: record.candidateVersionId,
        field: 'subject',
        prompt: 'Changed fictional wording must not reuse the same question key.',
        locator: record.evidence[0]!.locator,
      }),
    { code: 'QUESTION_CONFLICT' },
  );
  const afterQuestionConflict = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  assert.equal(afterQuestionConflict.version, afterSecondQuestion.version);
  assert.equal(afterQuestionConflict.workflow!.questions.length, 2);

  const laterReview = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    workflow(f).reportGroups![0]!.id,
  );
  assert.equal(laterReview.status, 'confirmation_required');
  assert.equal(laterReview.blocking, true);
  assert.equal(laterReview.scope!.targets.length, 1);
  assert.deepEqual(laterReview.scope!.questions, [
    { prompt: 'Does the second fictional subject clue also identify you?' },
  ]);
  const laterClinicalReview = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  );
  const laterRecord = laterClinicalReview.records[0]!;
  const laterIssue = laterRecord.issues!.find(
    (issue) => issue.questionId === item.workflow!.questions[1]!.id,
  )!;
  assert.equal(laterIssue.status, 'unresolved');
  assert.equal(laterIssue.blocking, true);
  assert.equal(
    listIntakeImportFeed(f.db, f.root, f.profileId, { view: 'all' }).blocks[0]!.records[0]!
      .selectable,
    false,
  );
  assert.throws(
    () =>
      intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
        version: laterClinicalReview.version,
        proposalId: laterClinicalReview.proposalId,
        reviewToken: laterClinicalReview.reviewToken,
        decisions: [{ recordId: laterRecord.id, action: 'accept', mapping: {} }],
      }),
    { code: 'QUESTIONS_PENDING' },
  );
  assert.equal(intake.getIntake(f.db, f.root, f.profileId, f.item.id).pendingCount, 1);
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...request(laterReview.scope!, 'fictional-changed-later-question-scope'),
        scope: {
          ...laterReview.scope!,
          questions: [{ prompt: 'A changed fictional question was not displayed.' }],
        },
        attestation: 'confirmed_displayed_identity_questions',
      }),
    { code: 'IDENTITY_SCOPE' },
  );
  assert.equal(workflow(f).identityConfirmations!.length, 1);

  item = intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, f.item.id, {
    version: laterClinicalReview.version,
    operationId: 'fictional-unreceipted-later-question-draft',
    proposalId: laterClinicalReview.proposalId,
    recordId: laterRecord.id,
    candidateVersionId: laterRecord.candidateVersionId!,
    resolutions: [{ issueId: laterIssue.id, outcome: 'this_is_me' }],
  });
  const unreceiptedReview = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    workflow(f).reportGroups![0]!.id,
  );
  assert.equal(unreceiptedReview.status, 'confirmation_required');
  assert.equal(unreceiptedReview.blocking, true);
  assert.equal(unreceiptedReview.scope!.targets.length, 1);
  assert.ok(unreceiptedReview.scope!.targets[0]!.issueIds!.includes(laterIssue.id));
  assert.deepEqual(unreceiptedReview.scope!.questions, [
    { prompt: 'Does the second fictional subject clue also identify you?' },
  ]);
  const blockedFeed = listIntakeImportFeed(f.db, f.root, f.profileId, { view: 'all' });
  const blockedBlock = blockedFeed.blocks[0]!;
  const blockedRecord = blockedBlock.records.find(
    (record) => record.candidateId === laterRecord.candidateId,
  )!;
  assert.equal(blockedRecord.selectable, false);
  const blockedClinicalReview = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  );
  assert.throws(
    () =>
      intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
        version: blockedClinicalReview.version,
        proposalId: blockedClinicalReview.proposalId,
        reviewToken: blockedClinicalReview.reviewToken,
        decisions: [{ recordId: laterRecord.id, action: 'accept', mapping: {} }],
      }),
    { code: 'REVIEW_ISSUES_PENDING' },
  );
  assert.throws(
    () =>
      acceptIntakeReportSelection(f.db, f.root, f.profileId, {
        operationId: 'c6d0413c-617f-4e0b-baba-beb068a4a8bc',
        blocks: [
          {
            intakeId: blockedBlock.intakeId,
            proposalId: blockedBlock.proposalId,
            intakeVersion: blockedBlock.intakeVersion,
            reviewToken: blockedBlock.reviewToken,
            selections: [
              {
                recordId: laterRecord.id,
                candidateId: laterRecord.candidateId!,
                candidateVersionId: laterRecord.candidateVersionId!,
                mapping: laterRecord.mapping,
              },
            ],
          },
        ],
      }),
    { code: 'REVIEW_ISSUES_PENDING' },
  );
  assert.equal(workflow(f).identityConfirmations!.length, 1);

  item = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(unreceiptedReview.scope!, 'fictional-later-question-confirmation'),
    attestation: 'confirmed_displayed_identity_questions',
  });
  assert.equal(item.workflow!.identityConfirmations!.length, 2);
  const convergedReview = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    workflow(f).reportGroups![0]!.id,
  );
  assert.equal(convergedReview.status, 'prior_confirmation');
  assert.equal(convergedReview.blocking, false);
  assert.equal(convergedReview.scope!.targets.length, 0);
  assert.deepEqual(convergedReview.offeredSelfFields, {});
  assert.equal(
    listIntakeImportFeed(f.db, f.root, f.profileId, { view: 'all' }).blocks[0]!.records[0]!
      .selectable,
    true,
  );
  confirmedReview = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  );
  item = intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
    version: confirmedReview.version,
    proposalId: confirmedReview.proposalId,
    reviewToken: confirmedReview.reviewToken,
    decisions: [{ recordId: confirmedReview.records[0]!.id, action: 'accept', mapping: {} }],
  });
  assert.equal(item.pendingCount, 0);
  assert.equal(item.unansweredCount, 0);
  assert.equal(item.needsReview, false);

  const backup = await createBackup(f.db, f.root, f.profileId);
  const target = join(f.root, 'rebuilt-identity-accounting');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target);
  const recovered = openDatabase(rebuilt.database, f.profileId);
  try {
    const restored = intake.getIntake(recovered, target, f.profileId, f.item.id);
    assert.equal(restored.unansweredCount, 0);
    assert.equal(restored.needsReview, false);
    assert.deepEqual(restored.workflow, item.workflow);
  } finally {
    recovered.close();
  }
});

test('a resolved generic draft without an exact receipt cannot create an empty confirmation or accept the record', async (t) => {
  const f = fixture(t);
  const proposed = f.propose([envelope('empty-required-scope')]);
  let review = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposed.proposals[0]!.id);
  const record = review.records[0]!;
  const genericIssue = record.issues!.find((issue) => issue.kind === 'identity')!;
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, f.item.id, {
    version: review.version,
    operationId: 'fictional-unreceipted-generic-resolution',
    proposalId: proposed.proposals[0]!.id,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    resolutions: [{ issueId: genericIssue.id, outcome: 'this_is_me' }],
  });

  const current = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    workflow(f).reportGroups![0]!.id,
  );
  assert.equal(current.status, 'confirmation_required');
  assert.equal(current.blocking, true);
  assert.equal(current.scope!.targets.length, 0);
  await assert.rejects(() => f.confirm(current.scope!), { code: 'IDENTITY_SCOPE_EMPTY' });
  assert.equal(workflow(f).identityConfirmations?.length || 0, 0);

  const feed = listIntakeImportFeed(f.db, f.root, f.profileId, { view: 'all' });
  assert.equal(feed.blocks[0]!.records[0]!.selectable, false);
  review = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposed.proposals[0]!.id);
  assert.throws(
    () =>
      intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
        version: review.version,
        proposalId: review.proposalId,
        reviewToken: review.reviewToken,
        decisions: [{ recordId: record.id, action: 'accept', mapping: {} }],
      }),
    { code: 'REVIEW_ISSUES_PENDING' },
  );
});

test('a prepared Self report with a printed subject exposes an exact confirmable target', async (t) => {
  const value = envelope('prepared-report-target');
  value.clinical = { ...(value.clinical as object), subject: 'self' };
  const f = fixture(t, Buffer.from(JSON.stringify(value)), 'fictional-prepared.jsonl');
  let review = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id);
  const record = review.records[0]!;
  assert.equal(record.identityReview?.status, 'confirmation_required');
  assert.equal(record.identityReview?.blocking, true);
  assert.equal(record.issues!.filter((issue) => issue.kind === 'identity').length, 1);

  const displayed = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    workflow(f).reportGroups![0]!.id,
  );
  assert.equal(displayed.status, 'confirmation_required');
  assert.equal(displayed.scope!.targets.length, 1);
  const confirmed = await f.confirm(displayed.scope!, 'fictional-prepared-confirmation');
  assert.equal(confirmed.workflow!.identityConfirmations!.length, 1);

  review = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id);
  assert.equal(review.records[0]!.identityReview?.status, 'prior_confirmation');
  assert.equal(review.records[0]!.identityReview?.blocking, false);
  const accepted = intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: record.id, action: 'accept', mapping: {} }],
  });
  assert.equal(accepted.imported!.clinical!.records!.length, 1);
});

test('prepared report targets preserve evidenced match, conflict and missing-identity policy', (t) => {
  const matchedValue = withIdentityEvidence(envelope('prepared-evidenced-match'));
  matchedValue.clinical = { ...(matchedValue.clinical as object), subject: 'self' };
  const matched = fixture(
    t,
    Buffer.from(JSON.stringify(matchedValue)),
    'fictional-prepared-match.jsonl',
  );
  setSelf(matched, { fullName: 'Fictional Iris Meadow', birthDate: fictionalBirthDate });
  const matchedRecord = intake.reviewIntake(
    matched.db,
    matched.root,
    matched.profileId,
    matched.item.id,
  ).records[0]!;
  assert.equal(matchedRecord.identityReview?.status, 'evidenced_match');
  assert.equal(matchedRecord.identityReview?.blocking, false);

  const conflictValue = withIdentityEvidence(envelope('prepared-evidence-conflict'));
  conflictValue.clinical = { ...(conflictValue.clinical as object), subject: 'self' };
  const conflict = fixture(
    t,
    Buffer.from(JSON.stringify(conflictValue)),
    'fictional-prepared-conflict.jsonl',
  );
  setSelf(conflict, { fullName: 'Fictional Different Person' });
  const conflictRecord = intake.reviewIntake(
    conflict.db,
    conflict.root,
    conflict.profileId,
    conflict.item.id,
  ).records[0]!;
  assert.equal(conflictRecord.identityReview?.status, 'conflict');
  assert.equal(conflictRecord.identityReview?.blocking, true);

  const missingValue = envelope('prepared-missing-identity');
  missingValue.clinical = { ...(missingValue.clinical as object), subject: 'self' };
  delete missingValue.report;
  const missing = fixture(
    t,
    Buffer.from(JSON.stringify(missingValue)),
    'fictional-prepared-missing.jsonl',
  );
  const missingRecord = intake.reviewIntake(
    missing.db,
    missing.root,
    missing.profileId,
    missing.item.id,
  ).records[0]!;
  assert.equal(missingRecord.identityReview?.status, 'missing_warning');
  assert.equal(missingRecord.identityReview?.blocking, false);
});

test('unchanged explicit identity authority survives cumulative report membership growth', async (t) => {
  const f = fixture(t);
  const firstEnvelope = envelope('membership-first');
  firstEnvelope.clinical = { ...(firstEnvelope.clinical as object), subject: 'self' };
  const first = f.propose([firstEnvelope]);
  let item = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  const firstRecord = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    first.proposals[0]!.id,
  ).records[0]!;
  item = intake.askIntakeQuestion(f.db, f.root, f.profileId, f.item.id, {
    version: item.version,
    key: 'fictional-membership-subject-question',
    candidateId: firstRecord.candidateId,
    candidateVersionId: firstRecord.candidateVersionId,
    field: 'subject',
    prompt: 'Does this unchanged fictional report subject belong to you?',
    locator: firstRecord.evidence[0]!.locator,
  });
  const displayed = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    workflow(f).reportGroups![0]!.id,
  );
  assert.equal(displayed.status, 'confirmation_required');
  assert.equal(displayed.scope!.targets.length, 1);
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(displayed.scope!, 'fictional-membership-first-confirmation'),
    attestation: 'confirmed_displayed_identity_questions',
  });

  const laterEnvelope = envelope('membership-later');
  laterEnvelope.clinical = { ...(laterEnvelope.clinical as object), subject: 'self' };
  f.propose([laterEnvelope]);
  const current = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    workflow(f).reportGroups![0]!.id,
  );
  assert.equal(current.scope!.membership.length, 2);
  assert.equal(current.status, 'prior_confirmation');
  assert.equal(current.blocking, false);
  assert.equal(current.scope!.targets.length, 0);
  const feed = listIntakeImportFeed(f.db, f.root, f.profileId, { view: 'all' });
  const firstFeedRecord = feed.blocks
    .flatMap((block) => block.records)
    .find((record) => record.candidateId === firstRecord.candidateId)!;
  assert.equal(firstFeedRecord.selectable, true);
  const acceptanceReview = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    first.proposals[0]!.id,
  );
  const accepted = intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
    version: acceptanceReview.version,
    proposalId: acceptanceReview.proposalId,
    reviewToken: acceptanceReview.reviewToken,
    decisions: [{ recordId: acceptanceReview.records[0]!.id, action: 'accept', mapping: {} }],
  });
  assert.equal(accepted.imported!.clinical!.records!.length, 1);
  assert.equal(
    accepted.imported!.clinical!.records![0]!.identityAttribution?.status,
    'prior_confirmation',
  );

  const receipt = workflow(f).identityConfirmations![0]!;
  const boundary = {
    ...current.scope!,
    evidenceOriginalFingerprint: current.scope!.evidenceOriginalFingerprint || null,
  };
  assert.equal(identityReceiptAppliesToCurrentBoundary(receipt, boundary), true);
  const firstMember = current.scope!.membership.find(
    (member) => member.candidateId === firstRecord.candidateId,
  )!;
  for (const changed of [
    { ...boundary, profileId: 'another-fictional-profile' },
    { ...boundary, intakeId: 'another-fictional-original' },
    { ...boundary, groupId: 'another-fictional-report' },
    { ...boundary, sourceHash: 'changed-source-hash' },
    { ...boundary, memberId: 'changed-member' },
    { ...boundary, verificationMode: 'human_reviewed_original' as const },
    {
      ...boundary,
      report: { ...boundary.report, text: boundary.report.text + ' changed' },
    },
    {
      ...boundary,
      subject: { ...boundary.subject, text: 'Patient: Fictional Different Person' },
    },
    { ...boundary, evidenceOriginalFingerprint: 'changed-original' },
    { ...boundary, original: { ...boundary.original, filename: 'changed-original.txt' } },
    {
      ...boundary,
      membership: boundary.membership.filter(
        (member) => member.candidateId !== firstRecord.candidateId,
      ),
    },
    {
      ...boundary,
      membership: boundary.membership.map((member) =>
        member.candidateId === firstRecord.candidateId
          ? { ...member, candidateVersionId: 'changed-candidate-version' }
          : member,
      ),
    },
    {
      ...boundary,
      membership: boundary.membership.map((member) =>
        member.candidateId === firstRecord.candidateId
          ? { ...member, occurrences: firstMember.occurrences.slice(1) }
          : member,
      ),
    },
  ])
    assert.equal(identityReceiptAppliesToCurrentBoundary(receipt, changed), false);

  const namedReceipt = structuredClone(receipt);
  namedReceipt.scope.evidencedIdentity = {
    fullName: 'Fictional Shared Name',
    birthDate: '1990-03-08',
    personFingerprint: 'fictional-prior-person',
  };
  assert.equal(
    identityReceiptAppliesToCurrentBoundary(namedReceipt, {
      ...boundary,
      evidencedIdentity: {
        fullName: 'Fictional Shared Name',
        birthDate: '1991-04-09',
        personFingerprint: 'fictional-different-person',
      },
    }),
    false,
  );

  const confirmedRecord = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    first.proposals[0]!.id,
  ).records[0]!;
  const explicitIssue = confirmedRecord.issues!.find(
    (issue) => issue.questionId === item.workflow!.questions[0]!.id,
  )!;
  const occurrence = {
    candidateId: confirmedRecord.candidateId!,
    candidateVersionId: confirmedRecord.candidateVersionId!,
    proposalId: first.proposals[0]!.id,
    recordId: confirmedRecord.id,
    issueIds: [explicitIssue.id],
    resolutions: confirmedRecord.draft!.resolutions,
  };
  assert.equal(
    exactCurrentIdentityResolutionOperationId({
      receipts: [receipt],
      occurrences: [occurrence],
      receiptApplies: (candidate) => identityReceiptAppliesToCurrentBoundary(candidate, boundary),
    }),
    receipt.operationId,
  );
  assert.equal(
    exactCurrentIdentityResolutionOperationId({
      receipts: [{ ...receipt, scope: { ...receipt.scope, targets: [] } }],
      occurrences: [occurrence],
      receiptApplies: (candidate) => identityReceiptAppliesToCurrentBoundary(candidate, boundary),
    }),
    undefined,
  );
  assert.equal(
    exactCurrentIdentityResolutionOperationId({
      receipts: [receipt],
      occurrences: [{ ...occurrence, candidateVersionId: 'changed-candidate-version' }],
      receiptApplies: (candidate) => identityReceiptAppliesToCurrentBoundary(candidate, boundary),
    }),
    undefined,
  );
  assert.equal(
    exactCurrentIdentityResolutionOperationId({
      receipts: [receipt],
      occurrences: [{ ...occurrence, issueIds: ['changed-identity-issue'] }],
      receiptApplies: (candidate) => identityReceiptAppliesToCurrentBoundary(candidate, boundary),
    }),
    undefined,
  );
});

test('legacy identity accounting binds the current version and leaves unrelated or conflicting work open', async (t) => {
  const f = fixture(t);
  let proposed = f.propose([envelope('accounted-legacy')]);
  let item = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  let record = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposed.proposals[0]!.id)
    .records[0]!;
  item = intake.askIntakeQuestion(f.db, f.root, f.profileId, f.item.id, {
    version: item.version,
    key: 'fictional-legacy-subject-question',
    candidateId: record.candidateId,
    field: 'subject',
    prompt: 'Confirm the fictional legacy patient identity',
    locator: record.evidence[0]!.locator,
  });
  item = intake.askIntakeQuestion(f.db, f.root, f.profileId, f.item.id, {
    version: item.version,
    key: 'fictional-unrelated-reading-question',
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    field: 'valueText',
    prompt: 'One fictional result value is illegible',
    locator: record.evidence[0]!.locator,
  });
  assert.equal(item.workflow!.questions[0]!.candidateVersionId, null);
  assert.equal(item.unansweredCount, 2);

  const scope = await f.preview();
  item = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'fictional-legacy-accounting-confirmation'),
    attestation: 'confirmed_displayed_identity_questions',
  });
  assert.equal(item.unansweredCount, 1, 'the unrelated reading question remains open');

  const changed = envelope('accounted-legacy');
  changed.payload = { literal: '19.00' };
  proposed = f.propose([changed]);
  item = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  assert.equal(item.unansweredCount, 2, 'the old identity draft does not cover a future version');
  record = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposed.proposals.at(-1)!.id)
    .records[0]!;
  const legacyIssue = record.issues!.find(
    (issue) => issue.questionId === item.workflow!.questions[0]!.id,
  )!;
  item = intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, f.item.id, {
    version: item.version,
    operationId: 'fictional-conflicting-legacy-subject',
    proposalId: proposed.proposals.at(-1)!.id,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    resolutions: [{ issueId: legacyIssue.id, outcome: 'other_person' }],
  });
  assert.equal(item.unansweredCount, 2, 'an other-person conflict is not a Self confirmation');
});

test('missing attestation and edited selected membership cannot write any draft', async (t) => {
  const f = fixture(t);
  f.propose([envelope('a'), envelope('b')]);
  const scope = await f.preview();
  const input = {
    ...request(scope),
    attestation: undefined,
  } as unknown as IntakeIdentityConfirmation;
  await assert.rejects(
    () => confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input),
    { code: 'IDENTITY_CONFIRMATION' },
  );
  await assert.rejects(() => f.confirm({ ...scope, targets: scope.targets.slice(0, 1) }), {
    code: 'IDENTITY_SCOPE',
  });
  assert.equal(workflow(f).reviewDrafts!.length, 0);
});

test('profile-qualified evidence URLs round trip without relaxing the displayed scope', async (t) => {
  const f = fixture(t);
  f.propose([envelope('a')]);
  const scope = await f.preview();
  const qualify = (profileId: string) => ({
    ...scope,
    original: {
      ...scope.original,
      contentUrl:
        `/api/profiles/${encodeURIComponent(profileId)}` + scope.original.contentUrl.slice(4),
    },
  });
  await assert.rejects(() => f.confirm(qualify('another-fictional-profile')), {
    code: 'IDENTITY_SCOPE',
  });
  const qualified = qualify(f.profileId);
  await assert.rejects(
    () => f.confirm({ ...qualified, subject: { ...scope.subject, text: 'Changed claim' } }),
    { code: 'IDENTITY_SCOPE' },
  );
  assert.equal(workflow(f).reviewDrafts!.length, 0);
  const saved = await f.confirm(qualified);
  assert.deepEqual(saved.workflow!.identityConfirmations![0]!.scope, scope);
  assert.deepEqual((await f.confirm(qualified)).workflow, saved.workflow);
});

test('compact report-subject confirmation records its attestation and later same-person proposals inherit it without extending the old receipt', async (t) => {
  const f = fixture(t);
  f.propose([envelope('a'), envelope('b')]);
  const scope = await f.preview();
  const input: IntakeIdentityConfirmation = {
    ...request(scope, 'compact-subject-confirmation'),
    attestation: 'confirmed_displayed_report_subject',
  };
  const beforeSelf = f.db.prepare("SELECT * FROM people WHERE relationship='self'").all();
  const confirmed = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input);
  const receipt = confirmed.workflow!.identityConfirmations!.at(-1)!;
  assert.equal(receipt.attestation, 'confirmed_displayed_report_subject');
  assert.deepEqual(receipt.scope, scope);
  assert.equal(receipt.draftIds.length, 2);
  assert.equal(confirmed.workflow!.decisions.length, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  assert.deepEqual(
    f.db.prepare("SELECT * FROM people WHERE relationship='self'").all(),
    beforeSelf,
  );
  const added = f.propose([envelope('c')]);
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input);
  const newRecord = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    added.proposals.at(-1)!.id,
  ).records[0]!;
  assert.equal(newRecord.mapping.subject, 'self');
  assert.equal(newRecord.identityReview?.status, 'prior_confirmation');
  assert.equal(newRecord.identityAttribution?.confirmationOperationId, input.operationId);
  assert.equal(workflow(f).identityConfirmations!.length, 1);
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...input,
        operationId: 'new-click-old-scope',
        version: intake.getIntake(f.db, f.root, f.profileId, f.item.id).version,
      }),
    { code: 'IDENTITY_SCOPE' },
  );
});

test('a second report group on the same original reuses confirmation only through the same supported person facts', async (t) => {
  const secondHeading = 'Fictional report IVY-62';
  const secondSubject = 'Client name: Fictional Iris Meadow';
  const f = fixture(
    t,
    Buffer.from(`${originalText}\n${secondHeading}\n${secondSubject}\nDOB: ${fictionalBirthDate}`),
  );
  const first = withIdentityEvidence(envelope('first-group'));
  const second = envelope('second-group');
  second.report = {
    ...second.report!,
    key: 'second-claim',
    anchor: { locator: 'page 1 second heading', text: secondHeading },
    subject: { locator: 'page 1 second patient', text: secondSubject },
  };
  withIdentityEvidence(second);
  f.propose([first, second]);
  const groups = workflow(f).reportGroups!;
  assert.equal(groups.length, 2);
  const firstScope = await f.preview(f.item.id, groups[0]!.id);
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(firstScope, 'fictional-first-group-person'),
    attestation: 'confirmed_displayed_identity_questions',
  });
  const secondReview = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    groups[1]!.id,
  );
  assert.equal(secondReview.status, 'prior_confirmation');
  assert.equal(secondReview.blocking, false);
  assert.equal(workflow(f).identityConfirmations!.length, 1);
  const proposalId = intake.getIntake(f.db, f.root, f.profileId, f.item.id).proposals[0]!.id;
  const records = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposalId).records;
  assert.ok(records.every((record) => record.mapping.subject === 'self'));
});

test('running identity headers reuse a confirmation across report groups without payload restatements or Self suggestions', async (t) => {
  const secondHeading = 'Fictional report IVY-63';
  const f = fixture(t, Buffer.from(`${originalText}\n${secondHeading}\n${identityLine}`));
  const first = withAnchorOnlyIdentity(envelope('header-first'));
  const second = withAnchorOnlyIdentity(envelope('header-second'));
  second.report!.anchor = { locator: 'page 1 second heading', text: secondHeading };
  const proposed = f.propose([first, second]);
  const groups = workflow(f).reportGroups!;
  assert.equal(groups.length, 2);
  const records = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  ).records;
  assert.ok(!JSON.stringify(first.payload).includes(identityLine));
  assert.ok(!JSON.stringify(second.payload).includes(identityLine));
  assert.ok(records.every((record) => record.issues!.every((issue) => !issue.selfSuggestion)));
  const firstScope = await f.preview(f.item.id, groups[0]!.id);
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(firstScope, 'fictional-running-header-confirmation'),
    attestation: 'confirmed_displayed_identity_questions',
  });
  const secondReview = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    groups[1]!.id,
  );
  assert.equal(secondReview.status, 'prior_confirmation');
  assert.equal(secondReview.blocking, false);
  assert.equal(workflow(f).identityConfirmations!.length, 1);
  assert.equal(secondReview.evidencedIdentity.fullName, undefined);
  assert.equal(secondReview.evidencedIdentity.birthDate, undefined);
});

for (const acceptance of ['record', 'report'] as const)
  test(`one running-header confirmation permits actual ${acceptance} acceptance and exact replay`, async (t) => {
    const secondHeading = 'Fictional report ROLLUP-2';
    const f = fixture(t, Buffer.from(`${originalText}\n${secondHeading}\n${identityLine}`));
    const second = withAnchorOnlyIdentity(envelope('rollup-later'));
    second.report!.anchor = { locator: 'page 1 second heading', text: secondHeading };
    const proposed = f.propose([withAnchorOnlyIdentity(envelope('rollup-first')), second]);
    const groups = workflow(f).reportGroups!;
    await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
      ...request(await f.preview(f.item.id, groups[0]!.id), 'fictional-rollup-confirmation'),
      attestation: 'confirmed_displayed_identity_questions',
    });
    const proposalId = proposed.proposals[0]!.id;
    const before = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposalId);
    assert.equal(before.records[1]!.identityReview?.blocking, true);
    const preview = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      groups[1]!.id,
    );
    assert.equal(preview.status, 'prior_confirmation');
    const review = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposalId);
    const record = review.records[1]!;
    assert.equal(record.identityReview?.status, 'prior_confirmation');
    assert.equal(record.identityReview?.blocking, false);
    if (acceptance === 'record') {
      const input = {
        version: review.version,
        proposalId,
        reviewToken: review.reviewToken,
        decisions: [{ recordId: record.id, action: 'accept' as const, mapping: {} }],
      };
      intake.importIntake(f.db, f.root, f.profileId, f.item.id, input);
      intake.importIntake(f.db, f.root, f.profileId, f.item.id, input);
    } else {
      const feed = listIntakeImportFeed(f.db, f.root, f.profileId, { view: 'all' });
      const block = feed.blocks.find((block) => block.records.some((row) => row.id === record.id))!;
      assert.equal(block.records.find((row) => row.id === record.id)!.selectable, true);
      const input = {
        operationId: 'f0f6a246-e812-435a-af4e-ddb7074b1473',
        blocks: [
          {
            intakeId: block.intakeId,
            proposalId: block.proposalId,
            intakeVersion: block.intakeVersion,
            reviewToken: block.reviewToken,
            selections: [
              {
                recordId: record.id,
                candidateId: record.candidateId!,
                candidateVersionId: record.candidateVersionId!,
                mapping: record.mapping,
              },
            ],
          },
        ],
      };
      acceptIntakeReportSelection(f.db, f.root, f.profileId, input);
      assert.equal(acceptIntakeReportSelection(f.db, f.root, f.profileId, input).replayed, true);
    }
    assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
    assert.equal(workflow(f).identityConfirmations!.length, 1);
    assert.equal(workflow(f).decisions.length, 1);
  });

for (const outcome of ['unknown', 'other_person'] as const)
  test(`a generic ${outcome} answer prevents prior receipt reuse before and after grounding`, async (t) => {
    const secondHeading = 'Fictional report GENERIC-2';
    const f = fixture(t, Buffer.from(`${originalText}\n${secondHeading}\n${identityLine}`));
    const second = withAnchorOnlyIdentity(envelope('generic-later'));
    second.report!.anchor = { locator: 'page 1 second heading', text: secondHeading };
    const proposed = f.propose([withAnchorOnlyIdentity(envelope('generic-first')), second]);
    const groups = workflow(f).reportGroups!;
    await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
      ...request(await f.preview(f.item.id, groups[0]!.id), 'fictional-generic-confirmation'),
      attestation: 'confirmed_displayed_identity_questions',
    });
    await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, groups[1]!.id);
    const review = intake.reviewIntake(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      proposed.proposals[0]!.id,
    );
    const record = review.records[1]!;
    const issue = record.issues!.find(
      (issue) => issue.prompt === 'Does this record belong to you?',
    )!;
    intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, f.item.id, {
      version: review.version,
      operationId: 'fictional-generic-answer',
      proposalId: review.proposalId,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId!,
      resolutions: [{ issueId: issue.id, outcome }],
    });
    const current = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      groups[1]!.id,
    );
    assert.equal(current.status, outcome === 'unknown' ? 'confirmation_required' : 'conflict');
    assert.equal(current.blocking, true);
    const blocked = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, review.proposalId);
    assert.equal(blocked.records[1]!.identityReview?.blocking, true);
    assert.throws(() =>
      intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
        version: blocked.version,
        proposalId: blocked.proposalId,
        reviewToken: blocked.reviewToken,
        decisions: [{ recordId: record.id, action: 'accept', mapping: {} }],
      }),
    );
    assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  });

test('an unresolved identity question blocks its own record without blocking another record in the confirmed report', async (t) => {
  const f = fixture(t);
  f.propose([envelope('scoped-confirmed')]);
  await f.confirm(await f.preview(), 'fictional-record-scoped-confirmation');
  const proposed = f.propose([
    envelope('scoped-clean'),
    withAnchorOnlyIdentity(envelope('scoped-question'), 'Unprinted fictional identity clue'),
  ]);
  const review = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals.at(-1)!.id,
  );
  assert.equal(review.records[0]!.identityReview?.status, 'prior_confirmation');
  assert.equal(review.records[0]!.identityReview?.blocking, false);
  assert.equal(review.records[1]!.identityReview?.status, 'confirmation_required');
  assert.equal(review.records[1]!.identityReview?.blocking, true);
  assert.ok(
    review.records[1]!.issues!.some(
      (issue) => issue.kind === 'identity' && issue.status === 'unresolved' && issue.blocking,
    ),
  );
});

for (const outcome of ['unknown', 'other_person'] as const)
  test(`a generic-only ${outcome} answer overrides an otherwise applicable same-person receipt`, async (t) => {
    const secondHeading = 'Fictional report GENERIC-ONLY';
    const f = fixture(t, Buffer.from(`${originalText}\n${secondHeading}\n${identityLine}`));
    const later = envelope('generic-only-later');
    later.report!.anchor = { locator: 'page 1 second heading', text: secondHeading };
    const proposed = f.propose([envelope('generic-only-first'), later]);
    const groups = workflow(f).reportGroups!;
    await f.confirm(await f.preview(f.item.id, groups[0]!.id));
    const review = intake.reviewIntake(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      proposed.proposals[0]!.id,
    );
    const record = review.records[1]!;
    assert.equal(record.identityReview?.status, 'prior_confirmation');
    const issue = record.issues!.find((issue) => issue.kind === 'identity')!;
    intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, f.item.id, {
      version: review.version,
      operationId: 'fictional-generic-only-answer',
      proposalId: review.proposalId,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId!,
      resolutions: [{ issueId: issue.id, outcome }],
    });
    const current = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      groups[1]!.id,
    );
    assert.equal(current.status, outcome === 'unknown' ? 'confirmation_required' : 'conflict');
    const blocked = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, review.proposalId);
    assert.equal(blocked.records[1]!.identityReview?.blocking, true);
    assert.throws(() =>
      intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
        version: blocked.version,
        proposalId: blocked.proposalId,
        reviewToken: blocked.reviewToken,
        decisions: [{ recordId: record.id, action: 'accept', mapping: {} }],
      }),
    );
  });

for (const outcome of ['unknown', 'other_person'] as const)
  test(`a current ${outcome} identity answer prevents running-header confirmation reuse`, async (t) => {
    const secondHeading = 'Fictional report IVY-66';
    const f = fixture(t, Buffer.from(`${originalText}\n${secondHeading}\n${identityLine}`));
    const later = withAnchorOnlyIdentity(envelope('answered-header-later'));
    later.report!.anchor = { locator: 'page 1 second heading', text: secondHeading };
    const proposed = f.propose([withAnchorOnlyIdentity(envelope('answered-header-first')), later]);
    const groups = workflow(f).reportGroups!;
    await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
      ...request(
        await f.preview(f.item.id, groups[0]!.id),
        'fictional-answered-header-confirmation',
      ),
      attestation: 'confirmed_displayed_identity_questions',
    });
    const review = intake.reviewIntake(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      proposed.proposals[0]!.id,
    );
    const record = review.records[1]!;
    const issue = record.issues!.find((candidate) => candidate.textAnchor === identityLine)!;
    intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, f.item.id, {
      version: review.version,
      operationId: 'fictional-current-header-answer',
      proposalId: review.proposalId,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId!,
      resolutions: [{ issueId: issue.id, outcome }],
    });
    const current = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      groups[1]!.id,
    );
    assert.equal(current.status, outcome === 'unknown' ? 'confirmation_required' : 'conflict');
    assert.equal(current.blocking, true);
    assert.equal(workflow(f).identityConfirmations!.length, 1);
  });

for (const variation of [
  'unprinted-anchor',
  'missing-anchor',
  'changed-printed-DOB',
  'changed-question',
  'no-page-text',
  'other-original',
  'other-subject',
] as const)
  test(`${variation} cannot reuse an anchor-only identity confirmation`, async (t) => {
    const secondHeading = 'Fictional report IVY-64';
    const changedIdentity = `${subject}\nDOB: 1993-07-12`;
    const otherSubject = 'Patient: Fictional Orin Cypress';
    const text = `${originalText}\n${secondHeading}\n${changedIdentity}\n${otherSubject}`;
    const f = fixture(
      t,
      variation === 'no-page-text' ? pdf('') : Buffer.from(text),
      variation === 'no-page-text' ? 'fictional.pdf' : 'fictional.txt',
    );
    f.propose([withAnchorOnlyIdentity(envelope('anchor-safety-first'))]);
    await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
      ...request(await f.preview(), 'fictional-anchor-safety-confirmation'),
      attestation: 'confirmed_displayed_identity_questions',
    });
    const later = withAnchorOnlyIdentity(
      envelope('anchor-safety-later'),
      variation === 'unprinted-anchor'
        ? 'Patient: Fictional Unprinted Juniper'
        : variation === 'changed-printed-DOB'
          ? changedIdentity
          : identityLine,
    );
    later.report!.anchor = { locator: 'page 1 later heading', text: secondHeading };
    if (variation === 'changed-question')
      later.reviewIssues![0]!.prompt =
        'Does this fictional identity conflict with the other chart?';
    if (variation === 'missing-anchor') delete later.reviewIssues![0]!.textAnchor;
    if (variation === 'other-subject') later.report!.subject!.text = otherSubject;
    const target =
      variation === 'other-original'
        ? intake.uploadIntake(f.db, f.root, f.profileId, {
            filename: 'another-fictional-original.txt',
            bytes: Buffer.from(text + '\nIndependently retained fictional original'),
            newProviderName: 'Invented Clinic',
          }).id
        : f.item.id;
    const proposed = f.propose([later], target);
    const groupId = proposed.workflow!.reportGroups!.at(-1)!.id;
    const review = await getIntakeIdentityReview(f.db, f.root, f.profileId, target, groupId);
    assert.equal(review.status, 'confirmation_required');
    assert.equal(review.blocking, true);
    assert.equal(workflow(f).identityConfirmations!.length, 1);
  });

test('one displayed report scope confirms more than one feed page without per-row identity actions', async (t) => {
  const f = fixture(t);
  const proposed = f.propose(
    Array.from({ length: 120 }, (_, index) => envelope(`paged-result-${index}`)),
  );
  const scope = await f.preview();
  assert.equal(scope.targets.length, 120);
  await f.confirm(scope, 'fictional-paged-report-identity');
  const review = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  );
  assert.equal(review.records.length, 120);
  assert.ok(review.records.every((record) => record.mapping.subject === 'self'));
  assert.ok(
    review.records.every((record) =>
      record
        .issues!.filter((issue) => issue.kind === 'identity')
        .every((issue) => issue.status === 'resolved'),
    ),
  );
});

for (const change of ['append', 'version', 'occurrence'] as const)
  test(`${change} changes invalidate the displayed scope and never inherit identity`, async (t) => {
    const f = fixture(t);
    f.propose([envelope('a'), envelope('b')]);
    const scope = await f.preview();
    const changed = envelope(change === 'append' ? 'c' : 'a');
    if (change === 'version') changed.payload = { literal: '19.00' };
    f.propose(change === 'occurrence' ? [envelope('b'), envelope('a')] : [changed]);
    await assert.rejects(() => f.confirm(scope), { code: 'VERSION_CONFLICT' });
    const fresh = await f.preview();
    assert.notEqual(fresh.groupVersionId, scope.groupVersionId);
    await assert.rejects(() => f.confirm({ ...scope, intakeVersion: fresh.intakeVersion }), {
      code: 'IDENTITY_SCOPE',
    });
    assert.equal(workflow(f).reviewDrafts!.length, 0);
  });

for (const variation of ['missing', 'unmatched', 'different-subject', 'other-person'] as const)
  test(`${variation} evidence does not authorize common confirmation`, async (t) => {
    const f = fixture(t);
    const a = envelope('a'),
      b = envelope('b');
    if (variation === 'missing') a.report!.subject = null;
    if (variation === 'unmatched') a.report!.subject!.text = 'Unprinted Fictional Person';
    if (variation === 'different-subject')
      b.report!.subject!.text = 'Patient: Fictional Rowan Pebble';
    if (variation === 'other-person') b.clinical = { ...(b.clinical as object), subject: 'other' };
    f.propose([a, b]);
    await assert.rejects(() => f.preview(), { code: 'IDENTITY_SCOPE' });
    assert.equal(workflow(f).reviewDrafts!.length, 0);
  });

test('explicitly displayed identity questions deduplicate claims and resolve only their exact scoped issues', async (t) => {
  const f = fixture(t);
  const typed = {
    kind: 'identity',
    field: 'subject',
    prompt: 'Does the printed patient Fictional Iris Meadow identify you?',
    textAnchor: subject,
  };
  const a = envelope('a'),
    b = envelope('b');
  a.reviewIssues = [typed];
  b.reviewIssues = [typed];
  a.uncertainties = ['Please confirm this patient report belongs to you.'];
  const proposed = f.propose([a, b]);
  const scope = await f.preview();
  assert.equal(scope.questions!.length, 2);
  assert.deepEqual(
    scope.questions!.find((question) => question.textAnchor),
    {
      prompt: typed.prompt,
      textAnchor: subject,
    },
  );
  assert.equal(scope.targets.length, 2);
  assert.equal(scope.targets[0]!.issueIds!.length, 3);
  assert.equal(
    scope.targets[1]!.issueIds!.length,
    2,
    'each exact occurrence retains its generic and typed issue IDs',
  );
  for (const attestation of [
    'reviewed_original_and_membership',
    'confirmed_displayed_report_subject',
  ] as const)
    await assert.rejects(
      () =>
        confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
          ...request(scope),
          attestation,
        }),
      { code: 'IDENTITY_CONFIRMATION' },
    );
  const explicit: IntakeIdentityConfirmation = {
    ...request(scope),
    attestation: 'confirmed_displayed_identity_questions',
  };
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...explicit,
        scope: { ...scope, questions: scope.questions!.slice(0, 1) },
      }),
    { code: 'IDENTITY_SCOPE' },
  );
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...explicit,
        scope: {
          ...scope,
          targets: scope.targets.map((target) => ({ ...target, issueIds: [target.issueId] })),
        },
      }),
    { code: 'IDENTITY_SCOPE' },
  );
  assert.equal(workflow(f).reviewDrafts!.length, 0);
  const saved = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, explicit);
  const review = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  );
  assert.ok(review.records.every((record) => record.mapping.subject === 'self'));
  assert.ok(
    review.records.every((record) =>
      record
        .issues!.filter((issue) => issue.kind === 'identity')
        .every((issue) => issue.status === 'resolved'),
    ),
  );
  assert.equal(saved.workflow!.decisions.length, 0);
  assert.equal(saved.workflow!.identityConfirmations![0]!.attestation, explicit.attestation);
  assert.deepEqual(
    (await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, explicit)).workflow,
    saved.workflow,
  );
});

test('changed question claims and previous other-person decisions cannot inherit common confirmation', async (t) => {
  const f = fixture(t);
  const a = envelope('a');
  a.reviewIssues = [
    { kind: 'identity', field: 'subject', prompt: 'Please confirm this patient is you.' },
  ];
  f.propose([a]);
  const scope = await f.preview();
  a.reviewIssues = [
    {
      kind: 'identity',
      field: 'subject',
      prompt: 'Please confirm this differently printed patient is you.',
    },
  ];
  const changed = f.propose([a]);
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...request(scope),
        attestation: 'confirmed_displayed_identity_questions',
      }),
    { code: 'VERSION_CONFLICT' },
  );
  const fresh = await f.preview();
  assert.notDeepEqual(fresh.questions, scope.questions);
  const record = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    changed.proposals.at(-1)!.id,
  ).records[0]!;
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, f.item.id, {
    version: fresh.intakeVersion,
    operationId: 'fictional-other-person-boundary',
    proposalId: changed.proposals.at(-1)!.id,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    resolutions: [
      {
        issueId: record.issues!.find((issue) => issue.kind === 'identity')!.id,
        outcome: 'other_person',
      },
    ],
  });
  await assert.rejects(() => f.preview(), { code: 'IDENTITY_SCOPE' });
  assert.equal(workflow(f).identityConfirmations?.length || 0, 0);
});

test('typed identity without a generic issue is explicit and every draft rolls back on publication failure', async (t) => {
  const f = fixture(t);
  const a = envelope('a'),
    b = envelope('b');
  for (const row of [a, b]) {
    row.clinical = { ...(row.clinical as object), subject: 'self' };
    row.reviewIssues = [
      {
        kind: 'identity',
        field: 'subject',
        prompt: 'Confirm the printed patient is you before saving.',
      },
    ];
  }
  const original = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-explicit-identity.jsonl',
    bytes: Buffer.from([a, b].map((row) => JSON.stringify(row)).join('\n')),
  });
  const scope = await f.preview(original.id);
  const current = () => intake.getIntake(f.db, f.root, f.profileId, original.id).workflow!;
  assert.equal(scope.questions!.length, 1);
  assert.ok(scope.targets.every((target) => target.issueIds?.length === 1));
  const input: IntakeIdentityConfirmation = {
    ...request(scope),
    attestation: 'confirmed_displayed_identity_questions',
  };
  f.db.exec(
    "CREATE TEMP TRIGGER reject_explicit_identity BEFORE UPDATE ON source_files BEGIN SELECT RAISE(ABORT, 'fictional publication failure'); END",
  );
  await assert.rejects(() =>
    confirmIntakeIdentityScope(f.db, f.root, f.profileId, original.id, input),
  );
  f.db.exec('DROP TRIGGER reject_explicit_identity');
  assert.equal(current().reviewDrafts!.length, 0);
  assert.equal(current().identityConfirmations?.length || 0, 0);
  const saved = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, original.id, input);
  assert.equal(saved.workflow!.reviewDrafts!.length, 2);
});

test('accepted earlier history and unrelated draft corrections remain intact; later same-person additions reuse confirmation', async (t) => {
  const f = fixture(t);
  const item = f.propose([envelope('a'), envelope('b')]);
  const proposalId = item.proposals[0]!.id;
  const confirmedScope = await f.preview();
  await f.confirm(confirmedScope);
  let review = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposalId);
  const first = review.records[0]!;
  intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
    version: review.version,
    proposalId,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: first.id, action: 'accept', mapping: {} }],
  });
  const prior = structuredClone(workflow(f).decisions);
  review = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposalId);
  const second = review.records[1]!;
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, f.item.id, {
    version: review.version,
    operationId: 'deliberate-correction',
    proposalId,
    recordId: second.id,
    candidateVersionId: second.candidateVersionId!,
    mapping: { valueText: '14.00' },
    disposition: 'review_later',
  });
  const priorDrafts = structuredClone(workflow(f).reviewDrafts!);
  const scope = await f.preview();
  assert.equal(scope.membership.length, 2);
  assert.equal(scope.targets.length, 0);
  assert.deepEqual(workflow(f).decisions, prior);
  assert.deepEqual(workflow(f).reviewDrafts!.slice(0, priorDrafts.length), priorDrafts);
  const latest = workflow(f).reviewDrafts!.at(-1)!;
  assert.equal(latest.mapping.valueText, '14.00');
  assert.equal(latest.disposition, 'review_later');
  const added = f.propose([envelope('c')]);
  const addedReview = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    added.proposals.at(-1)!.id,
  );
  assert.equal(addedReview.records[0]!.draft, null);
  assert.equal(addedReview.records[0]!.mapping.subject, 'self');
  assert.equal(addedReview.records[0]!.identityReview?.status, 'prior_confirmation');
  assert.ok(
    addedReview.records[0]!.issues!.filter((issue) => issue.kind === 'identity').every(
      (issue) => issue.status === 'resolved',
    ),
  );
  const stable = structuredClone(workflow(f));
  await f.confirm(confirmedScope); // Lost-response replay cannot extend the retained scope.
  assert.deepEqual(workflow(f), stable);
  const backup = await createBackup(f.db, f.root, f.profileId);
  const target = join(f.root, 'rebuilt');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target);
  const recovered = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.deepEqual(intake.getIntake(recovered, target, f.profileId, f.item.id).workflow, stable);
  } finally {
    recovered.close();
  }
});

test('an evidenced match auto-allows records and one optional action atomically fills only blank Self fields', async (t) => {
  const f = fixture(t);
  setSelf(f, { fullName: 'Fictional Iris Meadow' });
  f.propose([withIdentityEvidence(envelope('matched-self'))]);
  const groupId = workflow(f).reportGroups![0]!.id;
  const review = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, groupId);
  assert.equal(review.status, 'evidenced_match');
  assert.equal(review.blocking, false);
  assert.deepEqual(review.offeredSelfFields, { birthDate: fictionalBirthDate });
  assert.equal(getNote(f.db, 'person-note:self').person.birthDate, '');
  assert.equal(workflow(f).identityConfirmations?.length || 0, 0);
  assert.ok(review.scope);
  const input: IntakeIdentityConfirmation = {
    ...request(review.scope, 'fictional-fill-blank-self'),
    attestation: 'confirmed_displayed_report_subject',
    selfUpdate: {
      expectedVersion: review.self.version,
      fields: { birthDate: fictionalBirthDate },
    },
  };
  f.db.exec(
    "CREATE TEMP TRIGGER reject_identity_and_self BEFORE UPDATE ON source_files BEGIN SELECT RAISE(ABORT, 'fictional identity publication failure'); END",
  );
  await assert.rejects(
    () => confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input),
    /fictional identity publication failure/,
  );
  f.db.exec('DROP TRIGGER reject_identity_and_self');
  assert.equal(getNote(f.db, 'person-note:self').person.birthDate, '');
  assert.equal(workflow(f).identityConfirmations?.length || 0, 0);

  attachPersonalDurability(f.db, {
    root: f.root,
    profileId: f.profileId,
    initialize: false,
    writer() {
      throw new Error('fictional curation publication failure');
    },
  });
  const committed = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input);
  assert.equal(committed.durability.pending, true);
  assert.equal(personalDurabilityStatus(f.db).dirty, true);
  assert.equal(getNote(f.db, 'person-note:self').person.birthDate, fictionalBirthDate);
  assert.equal(committed.workflow!.identityConfirmations!.length, 1);
  assert.deepEqual(committed.workflow!.identityConfirmations![0]!.selfUpdate, {
    noteId: 'person-note:self',
    versionBefore: review.self.version,
    versionAfter: review.self.version + 1,
    fields: { birthDate: fictionalBirthDate },
  });
  attachPersonalDurability(f.db, {
    root: f.root,
    profileId: f.profileId,
    initialize: false,
  });
  const saved = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input);
  assert.equal(saved.durability.pending, false);
  const stable = structuredClone(saved.workflow);
  assert.deepEqual(saved.workflow, committed.workflow);

  const backup = await createBackup(f.db, f.root, f.profileId);
  const target = join(f.root, 'rebuilt-self-and-identity');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target);
  const recovered = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.equal(getNote(recovered, 'person-note:self').person.birthDate, fictionalBirthDate);
    assert.deepEqual(intake.getIntake(recovered, target, f.profileId, f.item.id).workflow, stable);
  } finally {
    recovered.close();
  }
});

test('a stale optional Self update cannot overwrite a field filled after identity review', async (t) => {
  const f = fixture(t);
  setSelf(f, { fullName: 'Fictional Iris Meadow' });
  f.propose([withIdentityEvidence(envelope('stale-self'))]);
  const review = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    workflow(f).reportGroups![0]!.id,
  );
  assert.deepEqual(review.offeredSelfFields, { birthDate: fictionalBirthDate });
  setSelf(f, { birthDate: fictionalBirthDate });
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...request(review.scope!, 'fictional-stale-self-fill'),
        selfUpdate: {
          expectedVersion: review.self.version,
          fields: { birthDate: fictionalBirthDate },
        },
      }),
    { code: 'SELF_VERSION_CONFLICT' },
  );
  assert.equal(getNote(f.db, 'person-note:self').person.birthDate, fictionalBirthDate);
  assert.equal(workflow(f).identityConfirmations?.length || 0, 0);
});

test('late non-identity reading progress is write-free until the same action is rebound to an exact fresh scope', async (t) => {
  const f = fixture(t);
  const proposed = f.propose([withIdentityEvidence(envelope('late-reading-identity'))]);
  const groupId = workflow(f).reportGroups![0]!.id;
  const displayed = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, groupId);
  assert.equal(displayed.status, 'confirmation_required');
  const record = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  ).records[0]!;
  const progressed = intake.askIntakeQuestion(f.db, f.root, f.profileId, f.item.id, {
    version: displayed.scope!.intakeVersion,
    key: 'fictional-late-nonidentity-reading-question',
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    field: 'valueText',
    prompt: 'Is the independently fictional printed value exactly 12.00?',
    locator: record.evidence[0]!.locator,
  });
  assert.equal(progressed.version, displayed.scope!.intakeVersion + 1);

  const operationId = 'fictional-late-reading-one-action';
  const staleRequest: IntakeIdentityConfirmation = {
    ...request(displayed.scope!, operationId),
    attestation: 'confirmed_displayed_identity_questions',
    selfUpdate: {
      expectedVersion: displayed.self.version,
      fields: displayed.offeredSelfFields,
    },
  };
  await assert.rejects(
    () => confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, staleRequest),
    { code: 'VERSION_CONFLICT' },
  );
  assert.equal(workflow(f).identityConfirmations?.length || 0, 0);
  assert.equal(workflow(f).reviewDrafts?.length || 0, 0);
  assert.equal(getNote(f.db, 'person-note:self').person.fullName, '');
  assert.equal(getNote(f.db, 'person-note:self').person.birthDate, '');

  const fresh = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, groupId);
  const semanticScope = (scope: IntakeIdentityScope) => {
    const { intakeVersion: _intakeVersion, scopeToken: _scopeToken, ...semantic } = scope;
    return semantic;
  };
  assert.deepEqual(semanticScope(fresh.scope!), semanticScope(displayed.scope!));
  assert.notEqual(fresh.scope!.scopeToken, displayed.scope!.scopeToken);
  const saved = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...staleRequest,
    version: fresh.scope!.intakeVersion,
    scope: fresh.scope!,
  });
  assert.equal(saved.workflow!.identityConfirmations!.length, 1);
  assert.equal(saved.workflow!.identityConfirmations![0]!.operationId, operationId);
  assert.deepEqual(saved.workflow!.identityConfirmations![0]!.selfUpdate?.fields, {
    fullName: 'Fictional Iris Meadow',
    birthDate: fictionalBirthDate,
  });
  assert.equal(getNote(f.db, 'person-note:self').person.fullName, 'Fictional Iris Meadow');
  assert.equal(getNote(f.db, 'person-note:self').person.birthDate, fictionalBirthDate);
});

test('one This-is-me operation confirms identity and both selected blank Self fields', async (t) => {
  const f = fixture(t);
  f.propose([withIdentityEvidence(envelope('confirm-and-fill'))]);
  const review = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    workflow(f).reportGroups![0]!.id,
  );
  assert.equal(review.status, 'confirmation_required');
  assert.deepEqual(review.offeredSelfFields, {
    fullName: 'Fictional Iris Meadow',
    birthDate: fictionalBirthDate,
  });
  const saved = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(review.scope!, 'fictional-one-identity-and-self-action'),
    attestation: 'confirmed_displayed_identity_questions',
    selfUpdate: {
      expectedVersion: review.self.version,
      fields: review.offeredSelfFields,
    },
  });
  assert.deepEqual(
    {
      fullName: getNote(f.db, 'person-note:self').person.fullName,
      birthDate: getNote(f.db, 'person-note:self').person.birthDate,
    },
    review.offeredSelfFields,
  );
  assert.equal(saved.workflow!.identityConfirmations!.length, 1);
  assert.ok(saved.workflow!.identityConfirmations![0]!.draftIds.length > 0);
  assert.deepEqual(
    saved.workflow!.identityConfirmations![0]!.selfUpdate?.fields,
    review.offeredSelfFields,
  );

  const resolved = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    workflow(f).reportGroups![0]!.id,
  );
  assert.equal(resolved.status, 'prior_confirmation');
  assert.equal(resolved.blocking, false);
  assert.deepEqual(resolved.offeredSelfFields, {});
  assert.equal(resolved.scope!.targets.length, 0);
  const stable = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...request(resolved.scope!, 'fictional-redundant-identity-confirmation'),
        attestation: 'confirmed_displayed_identity_questions',
      }),
    { code: 'IDENTITY_ALREADY_RESOLVED' },
  );
  const afterRedundantAttempt = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  assert.equal(afterRedundantAttempt.version, stable.version);
  assert.deepEqual(afterRedundantAttempt.workflow, stable.workflow);
});

test('one This-is-me operation offers and fills identity from an exact linked report subject', async (t) => {
  const contextId = 'fictional-linked-identity-context';
  const linkedSubject = `${subject}\nDOB: ${fictionalBirthDate}`;
  const issueAnchor = `${linkedSubject}\nReport date: 2026-03-02`;
  const f = fixture(t, Buffer.from(`${heading}\n${issueAnchor}`));
  const context = envelope('linked-identity-context');
  context.kind = 'context';
  context.contextId = contextId;
  context.payload = { transcript: `${heading}\n${linkedSubject}` };
  context.report!.subject = { locator: 'page 1 patient and DOB', text: linkedSubject };
  delete context.clinical;

  const linked = envelope('linked-identity-record');
  linked.contextId = contextId;
  linked.payload = { transcript: issueAnchor };
  delete linked.report;
  linked.reviewIssues = [
    {
      kind: 'identity',
      field: 'subject',
      prompt: 'Does the printed linked patient identity belong to you?',
      textAnchor: issueAnchor,
      selfSuggestion: {
        fullName: 'Fictional Iris Meadow',
        birthDate: fictionalBirthDate,
      },
    },
  ];

  f.propose([context, linked]);
  const group = workflow(f).reportGroups!.find(
    (candidate) => candidate.versions[0]!.context?.contextId === contextId,
  )!;
  assert.equal(group.report!.subject!.text, linkedSubject);
  const review = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
  assert.equal(review.status, 'confirmation_required');
  assert.deepEqual(review.offeredSelfFields, {
    fullName: 'Fictional Iris Meadow',
    birthDate: fictionalBirthDate,
  });

  const saved = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(review.scope!, 'fictional-one-linked-identity-and-self-action'),
    attestation: 'confirmed_displayed_identity_questions',
    selfUpdate: {
      expectedVersion: review.self.version,
      fields: review.offeredSelfFields,
    },
  });
  assert.equal(saved.workflow!.identityConfirmations!.length, 1);
  assert.deepEqual(saved.workflow!.identityConfirmations![0]!.selfUpdate?.fields, {
    fullName: 'Fictional Iris Meadow',
    birthDate: fictionalBirthDate,
  });
  assert.deepEqual(
    {
      fullName: getNote(f.db, 'person-note:self').person.fullName,
      birthDate: getNote(f.db, 'person-note:self').person.birthDate,
    },
    review.offeredSelfFields,
  );
});

test('linked Self evidence withholds a reformatted subject but offers an exact multiline subject', async (t) => {
  const contextId = 'fictional-verbatim-subject-context';
  const exactName = 'Fictional Marigold Finch';
  const exactBirthDate = '1988-11-02';
  const exactSubject = `Subject: ${exactName}\nBirth date: ${exactBirthDate}`;
  const reformattedSubject = `Subject: ${exactName}; Birth date: ${exactBirthDate}`;
  const localHeading = 'Fictional observatory report ORB-17';
  const issuePrompt = 'Does this exact fictional subject belong to you?';
  const proposal = (reportSubject: string, suffix: string) => {
    const context = envelope(`verbatim-subject-context-${suffix}`);
    context.kind = 'context';
    context.contextId = contextId;
    context.payload = { transcript: `${localHeading}\n${exactSubject}` };
    context.report = {
      key: 'fictional-orb-17',
      title: 'Fictional observatory report',
      anchor: { locator: 'page 1 heading', text: localHeading },
      subject: { locator: 'page 1 subject block', text: reportSubject },
    };
    delete context.clinical;

    const linked = envelope(`verbatim-subject-record-${suffix}`);
    linked.contextId = contextId;
    linked.payload = { transcript: `${exactSubject}\nImaginary marker: 4.20` };
    delete linked.report;
    linked.reviewIssues = [
      {
        kind: 'identity',
        field: 'subject',
        prompt: issuePrompt,
        textAnchor: exactSubject,
        selfSuggestion: { fullName: exactName, birthDate: exactBirthDate },
      },
    ];
    return [context, linked];
  };
  const original = Buffer.from(`${localHeading}\n${exactSubject}\nImaginary marker: 4.20`);

  const malformed = fixture(t, original, 'fictional-reformatted-subject.txt');
  const malformedItem = malformed.propose(proposal(reformattedSubject, 'reformatted'));
  const malformedGroup = workflow(malformed).reportGroups!.find(
    (candidate) => candidate.versions.at(-1)?.context?.contextId === contextId,
  )!;
  assert.equal(malformedGroup.report!.subject, null);
  const malformedRecord = intake
    .reviewIntake(
      malformed.db,
      malformed.root,
      malformed.profileId,
      malformed.item.id,
      malformedItem.proposals.at(-1)!.id,
    )
    .records.find((record) => record.issues?.some((issue) => issue.prompt === issuePrompt))!;
  assert.equal(
    malformedRecord.issues!.find((issue) => issue.prompt === issuePrompt)!.selfSuggestion,
    undefined,
  );
  const malformedIdentity = await getIntakeIdentityReview(
    malformed.db,
    malformed.root,
    malformed.profileId,
    malformed.item.id,
    malformedGroup.id,
  );
  assert.equal(malformedIdentity.scope, null);
  assert.deepEqual(malformedIdentity.offeredSelfFields, {});

  const exact = fixture(t, original, 'fictional-exact-subject.txt');
  const exactItem = exact.propose(proposal(exactSubject, 'exact'));
  const exactGroup = workflow(exact).reportGroups!.find(
    (candidate) => candidate.report?.subject?.text === exactSubject,
  )!;
  const exactRecord = intake
    .reviewIntake(
      exact.db,
      exact.root,
      exact.profileId,
      exact.item.id,
      exactItem.proposals.at(-1)!.id,
    )
    .records.find((record) => record.issues?.some((issue) => issue.prompt === issuePrompt))!;
  assert.deepEqual(
    exactRecord.issues!.find((issue) => issue.prompt === issuePrompt)!.selfSuggestion,
    { fullName: exactName, birthDate: exactBirthDate },
  );
  const exactReview = await getIntakeIdentityReview(
    exact.db,
    exact.root,
    exact.profileId,
    exact.item.id,
    exactGroup.id,
  );
  assert.deepEqual(exactReview.offeredSelfFields, {
    fullName: exactName,
    birthDate: exactBirthDate,
  });
});

test('a changed linked report context makes earlier Self suggestions stale and write-free', async (t) => {
  const contextId = 'fictional-changing-identity-context';
  const initialSubject = `${subject}\nDOB: ${fictionalBirthDate}`;
  const changedSubject = 'Patient: Fictional Juniper Sample\nDOB: 1991-04-09';
  const makeProposal = (reportSubject: string) => {
    const issueAnchor = `${reportSubject}\nReport date: 2026-03-02`;
    const context = envelope('changing-identity-context');
    context.kind = 'context';
    context.contextId = contextId;
    context.payload = { transcript: `${heading}\n${reportSubject}` };
    context.report!.subject = { locator: 'page 1 patient and DOB', text: reportSubject };
    delete context.clinical;
    const linked = envelope('changing-identity-record');
    linked.contextId = contextId;
    linked.payload = { transcript: issueAnchor };
    delete linked.report;
    linked.reviewIssues = [
      {
        kind: 'identity',
        field: 'subject',
        prompt: 'Does the changing fictional identity belong to you?',
        textAnchor: issueAnchor,
        selfSuggestion: {
          fullName: reportSubject.includes('Juniper')
            ? 'Fictional Juniper Sample'
            : 'Fictional Iris Meadow',
          birthDate: reportSubject.includes('Juniper') ? '1991-04-09' : fictionalBirthDate,
        },
      },
    ];
    return [context, linked];
  };
  const f = fixture(
    t,
    Buffer.from(`${heading}\n${initialSubject}\n${changedSubject}\nReport date: 2026-03-02`),
  );
  f.propose(makeProposal(initialSubject));
  const initialGroup = workflow(f).reportGroups!.find(
    (candidate) => candidate.report?.subject?.text === initialSubject,
  )!;
  const displayed = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    initialGroup.id,
  );
  assert.deepEqual(displayed.offeredSelfFields, {
    fullName: 'Fictional Iris Meadow',
    birthDate: fictionalBirthDate,
  });

  f.propose(makeProposal(changedSubject));
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...request(displayed.scope!, 'fictional-stale-linked-context'),
        attestation: 'confirmed_displayed_identity_questions',
        selfUpdate: {
          expectedVersion: displayed.self.version,
          fields: displayed.offeredSelfFields,
        },
      }),
    { code: 'VERSION_CONFLICT' },
  );
  assert.equal(workflow(f).identityConfirmations?.length || 0, 0);
  assert.equal(getNote(f.db, 'person-note:self').person.fullName, '');
  assert.equal(getNote(f.db, 'person-note:self').person.birthDate, '');

  const changedGroup = workflow(f).reportGroups!.find(
    (candidate) => candidate.report?.subject?.text === changedSubject,
  )!;
  const fresh = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    changedGroup.id,
  );
  assert.deepEqual(
    {
      status: fresh.status,
      evidence: fresh.evidencedIdentity,
      offered: fresh.offeredSelfFields,
    },
    {
      status: 'conflict',
      evidence: {
        fullName: 'Fictional Juniper Sample',
        birthDate: '1991-04-09',
      },
      offered: {},
    },
  );
});

for (const conflict of ['fullName', 'birthDate'] as const)
  test(`a contradictory evidenced ${conflict} blocks report and generic candidate confirmation`, async (t) => {
    const f = fixture(t);
    setSelf(f, {
      fullName: conflict === 'fullName' ? 'Fictional Different Self' : 'Fictional Iris Meadow',
      birthDate: conflict === 'birthDate' ? '1984-02-01' : fictionalBirthDate,
    });
    const proposed = f.propose([withIdentityEvidence(envelope(`conflict-${conflict}`))]);
    const groupId = workflow(f).reportGroups![0]!.id;
    const identityReview = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      groupId,
    );
    assert.equal(identityReview.status, 'conflict');
    assert.equal(identityReview.blocking, true);
    assert.equal(identityReview.scope, null);
    assert.equal(identityReview.conflicts[0]!.field, conflict);
    await assert.rejects(() => f.preview(), { code: 'IDENTITY_SCOPE' });

    const candidateReview = intake.reviewIntake(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      proposed.proposals.at(-1)!.id,
    );
    const record = candidateReview.records[0]!;
    assert.equal(record.identityReview?.status, 'conflict');
    const issue = record.issues!.find((candidate) => candidate.kind === 'identity')!;
    assert.equal(issue.blocking, true);
    assert.throws(
      () =>
        intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, f.item.id, {
          version: candidateReview.version,
          operationId: `fictional-conflict-bypass-${conflict}`,
          proposalId: candidateReview.proposalId,
          recordId: record.id,
          candidateVersionId: record.candidateVersionId!,
          resolutions: [{ issueId: issue.id, outcome: 'this_is_me' }],
        }),
      { code: 'IDENTITY_CONFLICT' },
    );
  });

test('identity absent from the proposal is a visible nonblocking warning with no invented source fact', async (t) => {
  const f = fixture(t);
  const value = envelope('identity-missing');
  value.report!.subject = null;
  const proposed = f.propose([value]);
  const groupId = workflow(f).reportGroups![0]!.id;
  const identityReview = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    groupId,
  );
  assert.equal(identityReview.status, 'missing_warning');
  assert.equal(identityReview.blocking, false);
  assert.equal(identityReview.scope, null);
  assert.deepEqual(identityReview.evidencedIdentity, {});
  assert.deepEqual(identityReview.offeredSelfFields, {});

  const candidateReview = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals.at(-1)!.id,
  );
  const record = candidateReview.records[0]!;
  assert.equal(record.identityReview?.status, 'missing_warning');
  assert.equal(record.identityReview?.blocking, false);
  assert.equal(record.mapping.subject, 'self');
  assert.equal(record.identityAttribution?.basis, 'reviewed_active_profile_missing_identity');
  assert.ok(
    record
      .issues!.filter((issue) => issue.kind === 'identity')
      .every((issue) => issue.blocking === false),
  );
  const accepted = intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
    version: candidateReview.version,
    proposalId: candidateReview.proposalId,
    reviewToken: candidateReview.reviewToken,
    decisions: [{ recordId: record.id, action: 'accept', mapping: {} }],
  });
  assert.equal(
    accepted.imported!.clinical!.records![0]!.identityAttribution?.basis,
    'reviewed_active_profile_missing_identity',
  );
  assert.equal(accepted.workflow!.identityConfirmations?.length || 0, 0);
});

for (const outcome of ['unknown', 'other_person'] as const)
  test(`a bare identity prompt keeps the missing warning until an explicit ${outcome} answer`, async (t) => {
    const f = fixture(t);
    const value = withAnchorOnlyIdentity(envelope('identity-free-prompt'));
    value.report!.subject = null;
    delete value.reviewIssues[0]!.textAnchor;
    const proposed = f.propose([value]);
    const groupId = workflow(f).reportGroups![0]!.id;
    const initial = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, groupId);
    assert.equal(initial.status, 'missing_warning');
    assert.equal(initial.blocking, false);
    const review = intake.reviewIntake(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      proposed.proposals[0]!.id,
    );
    const record = review.records[0]!;
    assert.equal(record.mapping.subject, 'self');
    assert.equal(record.identityReview?.status, 'missing_warning');
    const issue = record.issues!.find(
      (candidate) => candidate.prompt === value.reviewIssues[0]!.prompt,
    )!;
    intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, f.item.id, {
      version: review.version,
      operationId: 'fictional-explicit-unidentified-subject-answer',
      proposalId: review.proposalId,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId!,
      resolutions: [{ issueId: issue.id, outcome }],
    });
    const current = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, groupId);
    assert.equal(current.status, outcome === 'other_person' ? 'conflict' : 'confirmation_required');
    assert.equal(current.blocking, true);
    assert.equal(
      intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, review.proposalId).records[0]!
        .identityReview?.blocking,
      true,
    );
  });

test('a changed evidenced person on the same original cannot inherit an earlier confirmation', async (t) => {
  const otherBirthDate = '1991-04-09';
  const f = fixture(t, Buffer.from(`${originalText}\n${subject}\nDOB: ${otherBirthDate}`));
  f.propose([
    withIdentityEvidence(envelope('changed-person'), 'Fictional Iris Meadow', fictionalBirthDate),
  ]);
  const initial = await f.preview();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(initial, 'fictional-original-person'),
    attestation: 'confirmed_displayed_identity_questions',
  });

  f.propose([
    withIdentityEvidence(envelope('changed-person'), 'Fictional Iris Meadow', otherBirthDate),
  ]);
  const groupId = workflow(f).reportGroups![0]!.id;
  const review = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, groupId);
  assert.equal(review.status, 'confirmation_required');
  assert.equal(review.blocking, true);
  assert.notEqual(
    review.evidencedIdentity.personFingerprint,
    initial.evidencedIdentity?.personFingerprint,
  );
});

test('scope cannot cross another original or profile', async (t) => {
  const f = fixture(t);
  f.propose([envelope('a')]);
  const scope = await f.preview();
  const other = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'other.txt',
    bytes: Buffer.from(originalText + '\nOther original'),
    newProviderName: 'Other invented clinic',
  });
  f.propose([envelope('a')], other.id);
  await assert.rejects(() =>
    confirmIntakeIdentityScope(f.db, f.root, f.profileId, other.id, request(scope)),
  );
  await assert.rejects(() =>
    confirmIntakeIdentityScope(f.db, f.root, 'another-profile', f.item.id, request(scope)),
  );
  await assert.rejects(() => f.confirm({ ...scope, profileId: 'another-profile' }), {
    code: 'IDENTITY_SCOPE',
  });
  assert.equal(workflow(f).reviewDrafts!.length, 0);
});

function pdf(text: string | string[]) {
  const pages = Array.isArray(text) ? text : [text];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...pages.flatMap((page, index) => {
      const stream = page ? `BT /F1 12 Tf 30 720 Td (${page}) Tj ET` : '';
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
      ];
    }),
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

test('running identity headers on later PDF pages reuse only the earlier explicit question confirmation', async (t) => {
  const secondHeading = 'Fictional report IVY-65';
  const f = fixture(
    t,
    pdf([`${heading} ${subject}`, `${secondHeading} ${subject}`]),
    'fictional.pdf',
  );
  const first = withAnchorOnlyIdentity(envelope('pdf-header-first'), subject);
  const later = withAnchorOnlyIdentity(envelope('pdf-header-later'), subject);
  later.provenance.locator = 'page 2 fictional result';
  later.report!.anchor = { locator: 'page 2 heading', text: secondHeading };
  later.report!.subject = { locator: 'page 2 patient', text: subject };
  f.propose([first, later]);
  const groups = workflow(f).reportGroups!;
  const firstScope = await f.preview(f.item.id, groups[0]!.id);
  assert.equal(firstScope.original.page, 1);
  assert.equal(firstScope.verificationMode, 'literal_text_match');
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(firstScope, 'fictional-pdf-running-header-confirmation'),
    attestation: 'confirmed_displayed_identity_questions',
  });
  const review = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, groups[1]!.id);
  assert.equal(review.scope!.original.page, 2);
  assert.equal(review.status, 'prior_confirmation');
  assert.equal(review.blocking, false);
  assert.equal(Object.hasOwn(review.scope!, 'pageText'), false);
  assert.equal(workflow(f).identityConfirmations!.length, 1);
});

test('PDF grounding is ephemeral, rebuild restores its human authority, and accepted replay needs no new confirmation', async (t) => {
  const headings = [heading, 'Fictional report REBUILD-2', 'Fictional report REBUILD-3'];
  const f = fixture(t, pdf(headings.map((heading) => `${heading} ${subject}`)), 'fictional.pdf');
  const values = headings.map((heading, index) => {
    const value = withAnchorOnlyIdentity(envelope(`rebuild-page-${index + 1}`), subject);
    value.provenance.locator = `page ${index + 1} fictional result`;
    value.report!.anchor = { locator: `page ${index + 1} heading`, text: heading };
    value.report!.subject = { locator: `page ${index + 1} patient`, text: subject };
    return value;
  });
  const proposed = f.propose(values);
  const groups = workflow(f).reportGroups!;
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(await f.preview(f.item.id, groups[0]!.id), 'fictional-rebuild-human-confirmation'),
    attestation: 'confirmed_displayed_identity_questions',
  });
  const durableBefore = structuredClone(workflow(f));
  for (const group of groups.slice(1))
    assert.equal(
      (await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id)).status,
      'prior_confirmation',
    );
  assert.deepEqual(
    workflow(f),
    durableBefore,
    'Grounding must not write drafts, receipts or page text',
  );
  const proposalId = proposed.proposals[0]!.id;
  const review = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposalId);
  const record = review.records[1]!;
  const input = {
    operationId: '244e20ea-d557-4976-8aaf-4f46a0bd2b61',
    blocks: [
      {
        intakeId: f.item.id,
        proposalId,
        intakeVersion: review.version,
        reviewToken: review.reviewToken,
        selections: [
          {
            recordId: record.id,
            candidateId: record.candidateId!,
            candidateVersionId: record.candidateVersionId!,
            mapping: record.mapping,
          },
        ],
      },
    ],
  };
  acceptIntakeReportSelection(f.db, f.root, f.profileId, input);
  const backup = await createBackup(f.db, f.root, f.profileId);
  const target = join(f.root, 'rebuilt-grounded-pdf');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target);
  const recovered = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.equal(acceptIntakeReportSelection(recovered, target, f.profileId, input).replayed, true);
    assert.equal(recovered.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
    let restored = intake.reviewIntake(recovered, target, f.profileId, f.item.id, proposalId);
    assert.equal(
      restored.records[2]!.identityReview?.blocking,
      true,
      'A new database must not inherit a transient proof',
    );
    assert.throws(
      () =>
        intake.importIntake(recovered, target, f.profileId, f.item.id, {
          version: restored.version,
          proposalId,
          reviewToken: restored.reviewToken,
          decisions: [{ recordId: restored.records[2]!.id, action: 'accept', mapping: {} }],
        }),
      { code: 'REVIEW_ISSUES_PENDING' },
    );
    const grounded = await getIntakeIdentityReview(
      recovered,
      target,
      f.profileId,
      f.item.id,
      groups[2]!.id,
    );
    assert.equal(grounded.status, 'prior_confirmation');
    restored = intake.reviewIntake(recovered, target, f.profileId, f.item.id, proposalId);
    const saved = intake.importIntake(recovered, target, f.profileId, f.item.id, {
      version: restored.version,
      proposalId,
      reviewToken: restored.reviewToken,
      decisions: [{ recordId: restored.records[2]!.id, action: 'accept', mapping: {} }],
    });
    assert.equal(saved.workflow!.identityConfirmations!.length, 1);
    assert.equal(
      saved.imported!.clinical!.records![0]!.identityAttribution?.confirmationOperationId,
      'fictional-rebuild-human-confirmation',
    );
    assert.equal(recovered.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
  } finally {
    recovered.close();
  }
});

test('confirmed native PDF headers authorize exact source reuse and preserve changed assertions after rebuild without payload restatements', async (t) => {
  const f = fixture(
    t,
    pdf(Array.from({ length: 3 }, () => `${heading} ${subject}`)),
    'fictional-running-header-source.pdf',
  );
  const values = ['12.00', '12.00', '14.00'].map((literal, index) => {
    const value = withAnchorOnlyIdentity(envelope(`shared-pdf-source-${index + 1}`), subject);
    value.payload = { literal };
    value.provenance.sourceRecordId = 'fictional-shared-pdf-source';
    value.provenance.locator = `page ${index + 1} fictional result`;
    value.clinical = {
      ...(value.clinical as Record<string, unknown>),
      testLabel: 'Fictional repeated measurement',
      valueText: literal,
    };
    value.report!.anchor = { locator: `page ${index + 1} heading`, text: heading };
    value.report!.subject = { locator: `page ${index + 1} patient`, text: subject };
    assert.ok(!JSON.stringify(value.payload).includes(heading));
    assert.ok(!JSON.stringify(value.payload).includes(subject));
    return value;
  });
  const proposed = f.propose(values);
  const proposalId = proposed.proposals[0]!.id;
  const groups = workflow(f).reportGroups!;
  assert.equal(groups.length, 3);
  const scope = await f.preview(f.item.id, groups[0]!.id);
  assert.equal(scope.original.page, 1);
  assert.equal(scope.verificationMode, 'literal_text_match');
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'fictional-pdf-source-confirm-first'),
    attestation: 'confirmed_displayed_identity_questions',
  });
  const accept = (db: typeof f.db, root: string, recordIndex: number, operationId: string) => {
    const review = intake.reviewIntake(db, root, f.profileId, f.item.id, proposalId);
    const record = review.records[recordIndex]!;
    assert.equal(record.identityReview?.blocking, false);
    return acceptIntakeReportSelection(db, root, f.profileId, {
      operationId,
      blocks: [
        {
          intakeId: f.item.id,
          proposalId,
          intakeVersion: review.version,
          reviewToken: review.reviewToken,
          selections: [
            {
              recordId: record.id,
              candidateId: record.candidateId!,
              candidateVersionId: record.candidateVersionId!,
              mapping: record.mapping,
            },
          ],
        },
      ],
    });
  };
  const first = accept(f.db, f.root, 0, 'd1a55f49-5750-403d-a6b4-6c7df50dc161');
  const originalAccepted = f.db.prepare('SELECT * FROM observations').get()!;
  const backup = await createBackup(f.db, f.root, f.profileId);
  const target = join(f.root, 'rebuilt-pdf-source-reuse');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target);
  const recovered = openDatabase(rebuilt.database, f.profileId);
  try {
    const grounded = await getIntakeIdentityReview(
      recovered,
      target,
      f.profileId,
      f.item.id,
      groups[1]!.id,
    );
    assert.equal(grounded.status, 'prior_confirmation');
    assert.equal(grounded.blocking, false);
    assert.equal(grounded.scope!.verificationMode, 'literal_text_match');
    const second = accept(recovered, target, 1, '35d2fe6e-75e2-47e7-b506-c5fdc7ebda03');
    assert.equal(second.receipt.receipts[0]!.records[0]!.outcome, 'matched');
    assert.equal(
      second.receipt.receipts[0]!.records[0]!.entityId,
      first.receipt.receipts[0]!.records[0]!.entityId,
    );
    assert.equal(recovered.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
    assert.equal(recovered.prepare('SELECT count(*) n FROM evidence').get()!.n, 2);
    const secondBackup = await createBackup(recovered, target, f.profileId);
    const nextRoot = join(f.root, 'rebuilt-pdf-source-reuse-again');
    const next = rebuildProfile(join(secondBackup.path, 'files'), f.profileId, nextRoot);
    const cold = openDatabase(next.database, f.profileId);
    try {
      const current = await getIntakeIdentityReview(
        cold,
        nextRoot,
        f.profileId,
        f.item.id,
        groups[2]!.id,
      );
      assert.equal(current.status, 'prior_confirmation');
      assert.equal(current.blocking, false);
      const third = accept(cold, nextRoot, 2, '6021d69d-90c6-4a79-b14e-c5821a934143');
      assert.notEqual(third.receipt.receipts[0]!.records[0]!.outcome, 'matched');
      assert.notEqual(
        third.receipt.receipts[0]!.records[0]!.entityId,
        first.receipt.receipts[0]!.records[0]!.entityId,
      );
      assert.deepEqual(
        cold
          .prepare('SELECT value_text FROM observations ORDER BY value_text')
          .all()
          .map((row) => row.value_text),
        ['12.00', '14.00'],
      );
      assert.equal(
        cold.prepare('SELECT value_text FROM observations WHERE id=?').get(originalAccepted.id)!
          .value_text,
        originalAccepted.value_text,
      );
      assert.equal(cold.prepare('SELECT count(*) n FROM evidence').get()!.n, 3);
      assert.equal(
        intake.getIntake(cold, nextRoot, f.profileId, f.item.id).workflow!.identityConfirmations!
          .length,
        1,
      );
    } finally {
      cold.close();
    }
  } finally {
    recovered.close();
  }
});

for (const change of ['candidate', 'question', 'source'] as const)
  test(`grounding never authorizes a stale ${change} and old review token`, async (t) => {
    const secondHeading = 'Fictional report STALE-2';
    const f = fixture(t, Buffer.from(`${originalText}\n${secondHeading}\n${identityLine}`));
    const later = withAnchorOnlyIdentity(envelope('stale-grounding-later'));
    later.report!.anchor = { locator: 'page 1 second heading', text: secondHeading };
    const proposed = f.propose([withAnchorOnlyIdentity(envelope('stale-grounding-first')), later]);
    const groups = workflow(f).reportGroups!;
    await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
      ...request(await f.preview(f.item.id, groups[0]!.id), 'fictional-stale-grounding-human'),
      attestation: 'confirmed_displayed_identity_questions',
    });
    await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, groups[1]!.id);
    const reviewed = intake.reviewIntake(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      proposed.proposals[0]!.id,
    );
    assert.equal(reviewed.records[1]!.identityReview?.blocking, false);
    if (change === 'source') {
      const original = f.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.item.id) as {
        path: string;
      };
      writeFileSync(join(f.root, original.path), 'Changed fictional retained bytes');
    } else {
      const changed = structuredClone(later);
      if (change === 'candidate') changed.payload = { literal: '13.00' };
      else
        changed.reviewIssues![0]!.prompt =
          'Does this new and different identity clue belong to you?';
      const replacement = f.propose([changed]);
      const current = intake.reviewIntake(
        f.db,
        f.root,
        f.profileId,
        f.item.id,
        replacement.proposals.at(-1)!.id,
      );
      assert.equal(current.records[0]!.identityReview?.blocking, true);
      const refreshed = await getIntakeIdentityReview(
        f.db,
        f.root,
        f.profileId,
        f.item.id,
        groups[1]!.id,
      );
      assert.equal(
        refreshed.status,
        change === 'candidate' ? 'prior_confirmation' : 'confirmation_required',
      );
    }
    assert.throws(() =>
      intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
        version: reviewed.version,
        proposalId: reviewed.proposalId,
        reviewToken: reviewed.reviewToken,
        decisions: [{ recordId: reviewed.records[1]!.id, action: 'accept', mapping: {} }],
      }),
    );
    assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
    assert.equal(workflow(f).identityConfirmations!.length, 1);
  });

for (const text of [`${heading} ${subject}`, ''])
  test(`PDF ${text ? 'text' : 'visual'} mode preserves explicit human authority`, async (t) => {
    const f = fixture(t, pdf(text), 'fictional.pdf');
    f.propose([envelope('a'), envelope('b')]);
    const scope = await f.preview();
    assert.equal(scope.verificationMode, text ? 'literal_text_match' : 'human_reviewed_original');
    assert.equal(scope.original.page, 1);
    assert.match(scope.original.contentUrl, /#page=1$/);
    assert.equal(workflow(f).reviewDrafts!.length, 0);
    await f.confirm(scope);
    assert.equal(workflow(f).reviewDrafts!.length, 2);
  });

test('text-bearing PDF with an unmatched subject cannot use the visual fallback', async (t) => {
  const f = fixture(t, pdf(heading + ' Patient: Fictional Other'), 'fictional.pdf');
  f.propose([envelope('a')]);
  await assert.rejects(() => f.preview(), { code: 'IDENTITY_SCOPE' });
});

test('mixed-person ZIP scopes exact retained member occurrences, including equal-byte copies', async (t) => {
  fictionalModel(t);
  const { readIntakePackageMember } = await import('../intake-package.ts');
  const bytes = zipFixture([
    { name: 'first.txt', data: originalText },
    { name: 'copy.txt', data: originalText },
    { name: 'other.txt', data: originalText.replace(subject, 'Patient: Fictional Rowan Pebble') },
  ]);
  const f = fixture(t, bytes, 'fictional.zip');
  const planned = await intake.createIntakePlan(f.db, f.root, f.profileId, f.item.id, {
    version: f.item.version,
  });
  const members = planned.workflow!.plans[0]!.index.members!;
  const values = members.map((member, index) => {
    const value = envelope('result-' + index);
    value.report!.memberId = member.memberId;
    if (index === 2) value.report!.subject!.text = 'Patient: Fictional Rowan Pebble';
    return value;
  });
  f.propose(values);
  await assert.rejects(() => f.preview(), { code: 'IDENTITY_SCOPE' });
  const context = { db: f.db, root: f.root, profileId: f.profileId, id: f.item.id };
  await readIntakePackageMember({ ...context, memberId: members[1]!.memberId });
  // Retaining an equal-byte sibling does not establish this occurrence's original link.
  await assert.rejects(() => f.preview(), { code: 'IDENTITY_SCOPE' });
  await readIntakePackageMember({ ...context, memberId: members[0]!.memberId });
  const scope = await f.preview();
  assert.equal(scope.memberId, members[0]!.memberId);
  assert.equal(scope.targets.length, 1);
  await f.confirm(scope);
  const records = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    intake.getIntake(f.db, f.root, f.profileId, f.item.id).proposals[0]!.id,
  ).records;
  assert.equal(records[0]!.mapping.subject, 'self');
  assert.ok(records.slice(1).every((record) => record.draft === null));
});

test('identity route dispatch preserves the preview contract and explicit atomic mutation', async (t) => {
  const { handleIntakeRoute } = await import('../intake-routes.ts');
  const f = fixture(t);
  f.propose([envelope('a')]);
  let response: unknown;
  const context = {
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    resource: 'intakes',
    id: f.item.id,
    action: 'identity-scope',
    method: 'GET',
    params: new URLSearchParams({ groupId: workflow(f).reportGroups![0]!.id }),
    respond: (value: unknown) => {
      response = value;
    },
  } as Parameters<typeof handleIntakeRoute>[0];
  assert.equal(await handleIntakeRoute({ ...context, action: 'identity-review' }), true);
  assert.equal(
    (response as Awaited<ReturnType<typeof getIntakeIdentityReview>>).status,
    'confirmation_required',
  );
  assert.equal(await handleIntakeRoute(context), true);
  const scope = response as IntakeIdentityScope;
  assert.equal(scope.targets.length, 1);
  await handleIntakeRoute({
    ...context,
    method: 'POST',
    req: { headers: { 'content-type': 'application/json' } } as Parameters<
      typeof handleIntakeRoute
    >[0]['req'],
    body: async () => Buffer.from(JSON.stringify(request(scope))),
  });
  assert.equal((response as Intake).workflow!.identityConfirmations!.length, 1);
});

test('publication failure rolls back every common draft and receipt', async (t) => {
  const f = fixture(t);
  f.propose([envelope('a'), envelope('b')]);
  const scope = await f.preview();
  const before = structuredClone(workflow(f));
  f.db.exec(
    "CREATE TEMP TRIGGER reject_identity_publication BEFORE UPDATE ON source_files BEGIN SELECT RAISE(ABORT, 'fictional injected publication failure'); END",
  );
  await assert.rejects(() => f.confirm(scope), /fictional injected publication failure/);
  f.db.exec('DROP TRIGGER reject_identity_publication');
  assert.deepEqual(workflow(f), before);
  await f.confirm(scope);
  assert.equal(workflow(f).identityConfirmations!.length, 1);
  assert.equal(workflow(f).reviewDrafts!.length, 2);
});

test('replaying a completed confirmation after later contradictions returns its receipt without applying new drafts', async (t) => {
  const f = fixture(t);
  f.propose([envelope('a')]);
  const scope = await f.preview();
  await f.confirm(scope);
  const contradictory = envelope('b');
  contradictory.report!.subject!.text = 'Patient: Fictional Rowan Pebble';
  f.propose([contradictory]);
  const before = structuredClone(workflow(f));
  await f.confirm(scope);
  assert.deepEqual(workflow(f), before);
  await assert.rejects(() => f.preview(), { code: 'IDENTITY_SCOPE' });
});

test('an explicit known Self name matches in record review, survives rebuild, and removing it restores conflict', (t) => {
  const value = withIdentityEvidence(envelope('known-name'));
  value.clinical = { ...(value.clinical as object), subject: 'self' };
  const f = fixture(t, Buffer.from(JSON.stringify(value)), 'fictional-known-name.jsonl');
  setSelf(f, {
    fullName: 'Fictional Iris Brook',
    birthDate: fictionalBirthDate,
    knownNames: ['Fictional Iris Meadow'],
  });
  const review = () => intake.reviewIntake(f.db, f.root, f.profileId, f.item.id);
  assert.equal(review().records[0]!.identityReview?.status, 'evidenced_match');
  assert.equal(review().records[0]!.identityReview?.confidence, 'strong');
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  attachPersonalDurability(f.db, { root: f.root, profileId: f.profileId });
  // Explicit Self edits are durable authority; a cache rebuild must retain aliases.
  setSelf(f, { knownNames: ['Fictional Iris Meadow'] });
  const rebuilt = rebuildProfile(f.root, f.profileId, join(f.root, 'alias-rebuild'));
  const db = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.deepEqual(getNote(db, 'person-note:self').person.knownNames, ['Fictional Iris Meadow']);
  } finally {
    db.close();
  }
  setSelf(f, { knownNames: [] });
  assert.equal(review().records[0]!.identityReview?.status, 'conflict');
});
