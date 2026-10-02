import { zipFixture } from '../../tests/fixtures/zip.ts';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
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
  modelBirthDateWarnings,
  printedIdentityName,
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
test('labelled ISO DOB sentence separates a full name while preserving terminal initials and suffixes', () => {
  for (const name of ['Fictional Cedar Vale', 'Fictional O’Neil Meadow', 'Fictional J. Meadow'])
    assert.equal(printedIdentityName(`Patient: ${name}. DOB: 1982-04-17.`), name);
  for (const name of [
    'Fictional John Q.',
    'Fictional John AJ.',
    'Fictional John Aj.',
    'Fictional John MD.',
    'Fictional John M.D.',
    'Fictional John Ph.D.',
    'Fictional John PhD.',
    'Fictional John Phd.',
    'Fictional John Jr.',
    'Fictional John Jr..',
    'Fictional John Sr.',
    'Fictional John Esq.',
  ])
    assert.equal(printedIdentityName(`Patient: ${name} DOB: 1982-04-17.`), name);
  assert.equal(
    printedIdentityName('Patient: Fictional Cedar Vale. DOB: unclear'),
    'Fictional Cedar Vale.',
  );
  assert.equal(
    printedIdentityName('Patient: Fictional Cedar Vale. DOB: 1982-99-17.'),
    'Fictional Cedar Vale.',
  );
  assert.equal(
    printedIdentityName(
      'Patient: Fictional Cedar Vale. DOB: 1982-04-17. Patient: Fictional Willow Brook',
    ),
    undefined,
  );
  assert.equal(
    printedIdentityName(
      'Patient: Fictional Cedar Vale and Fictional Willow Brook. DOB: 1982-04-17.',
    ),
    undefined,
  );
  assert.equal(
    printedIdentityName('Patient: Fictional Different Meadow. DOB: 1982-04-17.'),
    'Fictional Different Meadow',
  );
});
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
  ...(scope.birthDateReview?.choices.length
    ? { identityAnswers: { birthDate: scope.birthDateReview.suggested || null } }
    : {}),
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
  assert.deepEqual(convergedReview.offeredSelfFields, {
    fullName: 'Fictional Iris Meadow',
    birthDate: '1990-03-08',
  });
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

test('prepared report targets preserve evidenced match, conflict and missing-identity policy after original checking', async (t) => {
  const matchedValue = withIdentityEvidence(envelope('prepared-evidenced-match'));
  matchedValue.clinical = { ...(matchedValue.clinical as object), subject: 'self' };
  const matched = fixture(
    t,
    Buffer.from(JSON.stringify(matchedValue)),
    'fictional-prepared-match.jsonl',
  );
  setSelf(matched, { fullName: 'Fictional Iris Meadow', birthDate: fictionalBirthDate });
  assert.equal(
    intake.reviewIntake(matched.db, matched.root, matched.profileId, matched.item.id).records[0]!
      .identityReview?.blocking,
    true,
  );
  await matched.preview();
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
      receipts: [{ ...receipt, scope: { ...receipt.scope, targets: [], assignmentTargets: [] } }],
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
    { code: 'SELF_VERSION_CONFLICT' },
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
  assert.equal(secondReview.evidencedIdentity.fullName, 'Fictional Iris Meadow');
  assert.equal(secondReview.evidencedIdentity.birthDate, fictionalBirthDate);
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
    // The second report has its own original header; recheck it before receipt reuse.
    await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, groups[1]!.id);
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
    // Two different Patient lines under the later heading need review; neither is a proven match.
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

for (const variation of ['missing', 'unmatched'] as const)
  test(`${variation} evidence does not authorize common confirmation`, async (t) => {
    const f = fixture(t);
    const a = envelope('a'),
      b = envelope('b');
    if (variation === 'missing') a.report!.subject = null;
    if (variation === 'unmatched') a.report!.subject!.text = 'Unprinted Fictional Person';
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
  const reassignment = await f.preview();
  assert.ok(reassignment.targets.length > 0);
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
    // Only the selected birth-date update writes Self; its unchanged primary
    // name needs no redundant alias/support write or second version increment.
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
  assert.equal(fresh.blocking, true);
  assert.equal(fresh.status, 'confirmation_required');
  // The retained original has two Patient lines under one heading; neither can fill Self.
  assert.equal(fresh.evidencedIdentity.fullName, undefined);
  assert.equal(fresh.evidencedIdentity.birthDate, undefined);
  assert.deepEqual(fresh.offeredSelfFields, {});
  assert.ok(fresh.scope?.competingSubjects?.length);
  assert.equal(getNote(f.db, 'person-note:self').person.fullName, '');
});

for (const conflict of ['fullName', 'birthDate'] as const)
  test(`a contradictory evidenced ${conflict} offers explicit person choice while blocking generic bypass`, async (t) => {
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
    assert.ok(identityReview.scope);
    assert.equal(identityReview.conflicts[0]!.field, conflict);
    assert.deepEqual(await f.preview(), identityReview.scope);

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
    const beforeEdit = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, review.proposalId);
    intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, f.item.id, {
      version: beforeEdit.version,
      operationId: `fictional-${outcome}-classification-edit`,
      proposalId: beforeEdit.proposalId,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId!,
      mapping: { kind: 'document' },
      resolutions: beforeEdit.records[0]!.draft!.resolutions,
    });
    const afterEdit = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, groupId);
    assert.equal(afterEdit.blocking, true, 'classification edits never erase an explicit refusal');
  });

test('a changed model DOB hint cannot change original evidence or revoke a matching confirmation', async (t) => {
  const otherBirthDate = '1991-04-09';
  const f = fixture(t);
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
  assert.equal(review.status, 'prior_confirmation');
  assert.equal(review.blocking, false);
  assert.equal('birthDateHints' in review.evidencedIdentity, false);
  assert.equal(review.evidencedIdentity.birthDate, fictionalBirthDate);
  assert.ok(review.scope);
  assert.equal(workflow(f).identityConfirmations!.length, 1);
});

test('a model-only DOB mismatch warns on an automatic name match without changing its authority', async (t) => {
  const f = fixture(t, Buffer.from(`${heading}\n${subject}\nFictional result A`));
  setSelf(f, { fullName: 'Fictional Iris Meadow', birthDate: fictionalBirthDate });
  const proposed = f.propose([
    withIdentityEvidence(envelope('model-only-dob'), 'Fictional Iris Meadow', '1991-04-09'),
  ]);
  const groupId = workflow(f).reportGroups![0]!.id;
  const report = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, groupId);
  const record = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  ).records[0]!;
  assert.equal(report.status, 'evidenced_match');
  assert.equal(report.blocking, false);
  assert.equal(report.evidencedIdentity.birthDate, undefined);
  assert.deepEqual(report.warnings, [
    {
      kind: 'model_birth_date_mismatch',
      modelBirthDate: '1991-04-09',
      savedBirthDate: fictionalBirthDate,
      personName: 'Fictional Iris Meadow',
    },
  ]);
  assert.deepEqual(record.identityReview?.warnings, report.warnings);
  assert.equal(record.identityReview?.blocking, false);
  assert.equal(record.identityAttribution?.status, 'evidenced_match');
  assert.equal(workflow(f).identityConfirmations?.length || 0, 0);
});

test('a matching model DOB or a host-readable original DOB does not add a model mismatch warning', async (t) => {
  for (const originalHasDob of [false, true]) {
    const f = fixture(
      t,
      Buffer.from(
        `${heading}\n${subject}${originalHasDob ? `\nDOB: ${fictionalBirthDate}` : ''}\nFictional result A`,
      ),
    );
    setSelf(f, { fullName: 'Fictional Iris Meadow', birthDate: fictionalBirthDate });
    f.propose([
      withIdentityEvidence(
        envelope(originalHasDob ? 'original-dob' : 'matching-model-dob'),
        'Fictional Iris Meadow',
        originalHasDob ? '1991-04-09' : fictionalBirthDate,
      ),
    ]);
    const report = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      workflow(f).reportGroups![0]!.id,
    );
    assert.equal(report.status, 'evidenced_match');
    assert.equal(report.warnings, undefined);
    assert.equal(
      report.evidencedIdentity.birthDate,
      originalHasDob ? fictionalBirthDate : undefined,
    );
  }
});

test('model date warnings compare the selected person and never replace printed uncertainty', async (t) => {
  assert.deepEqual(
    modelBirthDateWarnings({
      issues: [{ selfSuggestion: { birthDate: '1991-04-09' } }],
      unreadableBirthDate: false,
      person: { fullName: 'Fictional Family Member', birthDate: '1986-02-14' },
    }),
    [
      {
        kind: 'model_birth_date_mismatch',
        modelBirthDate: '1991-04-09',
        savedBirthDate: '1986-02-14',
        personName: 'Fictional Family Member',
      },
    ],
  );
  assert.deepEqual(
    modelBirthDateWarnings({
      issues: [{ selfSuggestion: { birthDate: '2020-99-99' } }],
      unreadableBirthDate: false,
      person: { fullName: 'Fictional Family Member', birthDate: '1986-02-14' },
    }),
    [],
  );

  const f = fixture(
    t,
    Buffer.from(`${heading}\n${subject}\nDOB: see attached\nFictional result A`),
  );
  setSelf(f, { fullName: 'Fictional Iris Meadow', birthDate: fictionalBirthDate });
  f.propose([
    withIdentityEvidence(envelope('printed-uncertainty'), 'Fictional Iris Meadow', '1991-04-09'),
  ]);
  const report = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    workflow(f).reportGroups![0]!.id,
  );
  assert.equal(report.status, 'confirmation_required');
  assert.equal(report.blocking, true);
  assert.equal(report.warnings, undefined);
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
    assert.equal(
      recovered.prepare("SELECT count(*) n FROM evidence WHERE entity_type<>'person'").get()!.n,
      2,
    );
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
      assert.equal(
        cold.prepare("SELECT count(*) n FROM evidence WHERE entity_type<>'person'").get()!.n,
        3,
      );
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
  const fresh = await f.preview();
  assert.ok(fresh.competingSubjects?.length);
  await assert.rejects(() => f.confirm(fresh, 'unreviewed-conflict'), {
    code: 'IDENTITY_CONFIRMATION',
  });
  assert.deepEqual(workflow(f), before);
});

test('an explicit known Self name matches after original checking, survives rebuild, and removing it restores conflict', async (t) => {
  const value = withIdentityEvidence(envelope('known-name'));
  value.clinical = { ...(value.clinical as object), subject: 'self' };
  const f = fixture(t, Buffer.from(JSON.stringify(value)), 'fictional-known-name.jsonl');
  setSelf(f, {
    fullName: 'Fictional Iris Brook',
    birthDate: fictionalBirthDate,
    knownNames: ['Fictional Iris Meadow'],
  });
  const review = () => intake.reviewIntake(f.db, f.root, f.profileId, f.item.id);
  assert.equal(review().records[0]!.identityReview?.blocking, true);
  await f.preview();
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

for (const destination of ['new', 'existing'] as const)
  test(`an explicitly selected ${destination} family person owns accepted mismatched clinical results`, async (t) => {
    const f = fixture(t);
    setSelf(f, { fullName: 'Fictional Separate Self', birthDate: '1982-01-03' });
    let personSelection: NonNullable<IntakeIdentityConfirmation['personSelection']>;
    if (destination === 'existing') {
      const { createNote } = await import('../notes.ts');
      const person = createNote(f.db, {
        kind: 'person',
        title: 'Fictional Family Iris',
        content: '',
        person: { fullName: 'Fictional Family Iris', tags: ['Family'] },
      });
      personSelection = { noteId: person.id, expectedVersion: person.version };
    } else
      personSelection = {
        newPerson: { fullName: 'Fictional Family Iris', relationship: 'Sibling' },
      };
    const proposed = f.propose([withIdentityEvidence(envelope('family-owned'))]);
    const scope = await f.preview();
    const input: IntakeIdentityConfirmation = {
      ...request(scope, `fictional-family-${destination}`),
      outcome: 'this_is_person',
      attestation: 'confirmed_displayed_identity_questions',
      personSelection,
    };
    const saved = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input);
    const assigned = saved.workflow!.identityConfirmations!.at(-1)!.assignedPerson!;
    assert.ok(assigned.personId);
    assert.notEqual(assigned.personId, 'patient');
    assert.equal(getNote(f.db, 'person-note:self').person.fullName, 'Fictional Separate Self');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM observations').get()!.n, 0);
    assert.deepEqual(
      (await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input)).workflow,
      saved.workflow,
    );
    assert.equal(
      f.db
        .prepare("SELECT COUNT(*) n FROM notes WHERE kind='person' AND person_id!='patient'")
        .get()!.n,
      1,
    );
    const review = intake.reviewIntake(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      proposed.proposals.at(-1)!.id,
    );
    assert.equal(review.records[0]!.identityReview!.blocking, false);
    assert.equal(review.records[0]!.mapping.personId, assigned.personId);
    assert.equal(review.records[0]!.mapping.subject, 'other');
    intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
      version: review.version,
      proposalId: review.proposalId,
      reviewToken: review.reviewToken,
      decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
    });
    assert.equal(
      f.db.prepare('SELECT person_id FROM observations').get()!.person_id,
      assigned.personId,
    );
    assert.equal(
      f.db.prepare("SELECT COUNT(*) n FROM observations WHERE person_id='patient'").get()!.n,
      0,
    );
    const refreshed = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      scope.groupId,
    );
    assert.equal(refreshed.assignedPerson?.personId, assigned.personId);
  });

test('explicit Self choice with a matching DOB adds the evidenced alias once', async (t) => {
  const f = fixture(t);
  setSelf(f, { fullName: 'Fictional Other Name', birthDate: fictionalBirthDate });
  const proposed = f.propose([withIdentityEvidence(envelope('alias-self'))]);
  const scope = await f.preview();
  const input: IntakeIdentityConfirmation = {
    ...request(scope, 'fictional-explicit-alias'),
    attestation: 'confirmed_displayed_identity_questions',
  };
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input);
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input);
  const self = getNote(f.db, 'person-note:self');
  assert.equal(self.person.fullName, 'Fictional Other Name');
  assert.equal(self.person.birthDate, fictionalBirthDate);
  assert.deepEqual(self.person.knownNames, ['Fictional Iris Meadow']);
  const review = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals.at(-1)!.id,
  );
  assert.equal(review.records[0]!.identityReview!.blocking, false);
  intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
    version: review.version,
    proposalId: review.proposalId,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  assert.equal(f.db.prepare('SELECT person_id FROM observations').get()!.person_id, 'patient');
});

test('an automatic Self match can instead be explicitly assigned to a family person', async (t) => {
  const f = fixture(t);
  setSelf(f, { fullName: 'Fictional Iris Meadow', birthDate: fictionalBirthDate });
  const proposed = f.propose([withIdentityEvidence(envelope('same-named-family'))]);
  const scope = await f.preview();
  assert.equal(scope.targets.length, 0);
  assert.equal(scope.assignmentTargets?.length, 1);
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'fictional-same-named-family'),
    outcome: 'this_is_person',
    attestation: 'confirmed_displayed_report_subject',
    personSelection: { newPerson: { fullName: 'Fictional Iris Meadow Junior' } },
  });
  const review = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals.at(-1)!.id,
  );
  assert.equal(review.records[0]!.identityReview!.blocking, false);
  assert.equal(review.records[0]!.mapping.subject, 'other');
  assert.notEqual(review.records[0]!.mapping.personId, 'patient');
});

test('new Person creation rolls back with failed identity publication and stale existing Person versions reject', async (t) => {
  const f = fixture(t);
  f.propose([withIdentityEvidence(envelope('family-rollback'))]);
  const scope = await f.preview();
  const input: IntakeIdentityConfirmation = {
    ...request(scope, 'family-rollback'),
    outcome: 'this_is_person',
    attestation: 'confirmed_displayed_identity_questions',
    personSelection: { newPerson: { fullName: 'Fictional Rollback Family' } },
  };
  f.db.exec(
    "CREATE TEMP TRIGGER reject_family BEFORE UPDATE ON source_files BEGIN SELECT RAISE(ABORT, 'fictional family publication failure'); END",
  );
  await assert.rejects(
    () => confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input),
    /fictional family publication failure/,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM notes WHERE kind='person' AND person_id!='patient'").get()!
      .n,
    0,
  );
  assert.equal(workflow(f).identityConfirmations?.length || 0, 0);
  f.db.exec('DROP TRIGGER reject_family');
  const { createNote } = await import('../notes.ts');
  const person = createNote(f.db, {
    kind: 'person',
    title: 'Fictional Existing Family',
    content: '',
    person: { tags: ['Family'] },
  });
  saveNote(f.db, person.id, { version: person.version, title: 'Fictional Renamed Family' });
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...input,
        personSelection: { noteId: person.id, expectedVersion: person.version },
      }),
    { code: 'PERSON_VERSION_CONFLICT' },
  );
  assert.equal(workflow(f).identityConfirmations?.length || 0, 0);
});

test('pending report can be reassigned Self to family and back without losing alias or moving accepted history', async (t) => {
  const f = fixture(t);
  const proposed = f.propose([withIdentityEvidence(envelope('reassign-family'))]);
  let scope = await f.preview();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'reassign-self-first'),
    attestation: 'confirmed_displayed_identity_questions',
  });
  const approved = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals.at(-1)!.id,
  );
  scope = await f.preview();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'reassign-family-next'),
    outcome: 'this_is_person',
    attestation: 'confirmed_displayed_identity_questions',
    personSelection: { newPerson: { fullName: 'Fictional Alternative Person' } },
  });
  // Moving this report to a different Person cannot reuse an approval of Self.
  const partial = acceptIntakeReportSelection(f.db, f.root, f.profileId, {
    operationId: randomUUID(),
    mode: 'partial-v1',
    blocks: [
      {
        intakeId: f.item.id,
        proposalId: approved.proposalId,
        intakeVersion: approved.version,
        reviewToken: approved.reviewToken,
        selections: approved.records.map((record) => ({
          recordId: record.id,
          candidateId: record.candidateId!,
          candidateVersionId: record.candidateVersionId!,
          selectionReviewToken: record.selectionReviewToken,
          mapping: record.mapping,
        })),
      },
    ],
  }).receipt;
  assert.equal(partial.atomic, false);
  if (partial.atomic) throw new Error('Expected partial receipt');
  assert.equal(partial.acceptedCount, 0);
  assert.equal(partial.items[0]!.status, 'needs_review');
  assert.equal(partial.items[0]!.reasonCode, 'SELECTION_REVIEW_CHANGED');
  scope = await f.preview();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'reassign-self-final'),
    attestation: 'confirmed_displayed_identity_questions',
  });
  const review = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals.at(-1)!.id,
  );
  assert.equal(review.records[0]!.mapping.subject, 'self');
  assert.equal(review.records[0]!.mapping.personId, undefined);
  assert.equal(review.records[0]!.identityReview!.blocking, false);
  assert.deepEqual(getNote(f.db, 'person-note:self').person.knownNames, ['Fictional Iris Meadow']);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM observations').get()!.n, 0);
});

test('encrypted cache-loss rebuild retains all clinical Person owners, aliases and exact assignment receipts', async (t) => {
  const { newProfile, vaultFixture } = await import('./helpers/vault-fixture.ts');
  const { manager } = vaultFixture(t);
  const created = await newProfile(manager, 'Fictional Vault Self');
  const profileId = created.profile.id;
  let state = manager.opened.get(profileId)!;
  const savedSelf = getNote(state.db, 'person-note:self');
  saveNote(state.db, savedSelf.id, {
    version: savedSelf.version,
    person: { ...savedSelf.person, birthDate: fictionalBirthDate },
  });
  const original = intake.uploadIntake(state.db, state.root, profileId, {
    filename: 'fictional-family.txt',
    bytes: Buffer.from(originalText),
    newProviderName: 'Invented Clinic',
  });
  const values = ['observation', 'medication', 'procedure', 'document'].map((kind) => {
    const value = withIdentityEvidence(envelope('vault-' + kind));
    value.clinical = {
      ...(value.clinical as object),
      kind,
      medicationName: 'Fictional medication',
      medicationKind: 'reported_use',
      procedureLabel: 'Fictional procedure',
      procedureCategory: 'unspecified',
      documentTitle: 'Fictional document',
      text: 'Fictional retained document',
    };
    return value;
  });
  let source = intake.proposeConversion(state.db, state.root, profileId, original.id, {
    version: original.version,
    summary: 'Fictional family clinical records',
    jsonlText: values.map((value) => JSON.stringify(value)).join('\n'),
  });
  let scope = await getIntakeIdentityScope(
    state.db,
    state.root,
    profileId,
    original.id,
    source.workflow!.reportGroups![0]!.id,
  );
  await confirmIntakeIdentityScope(state.db, state.root, profileId, original.id, {
    ...request(scope, 'vault-self-alias'),
    attestation: 'confirmed_displayed_identity_questions',
  });
  scope = await getIntakeIdentityScope(
    state.db,
    state.root,
    profileId,
    original.id,
    source.workflow!.reportGroups![0]!.id,
  );
  const input: IntakeIdentityConfirmation = {
    ...request(scope, 'vault-family-assignment'),
    outcome: 'this_is_person',
    attestation: 'confirmed_displayed_identity_questions',
    personSelection: { newPerson: { fullName: 'Fictional Vault Family' } },
  };
  source = await confirmIntakeIdentityScope(state.db, state.root, profileId, original.id, input);
  const assigned = source.workflow!.identityConfirmations!.at(-1)!.assignedPerson!;
  const review = intake.reviewIntake(
    state.db,
    state.root,
    profileId,
    original.id,
    source.proposals.at(-1)!.id,
  );
  intake.importIntake(state.db, state.root, profileId, original.id, {
    version: review.version,
    proposalId: review.proposalId,
    reviewToken: review.reviewToken,
    decisions: review.records.map((record) => ({
      recordId: record.id,
      action: 'accept',
      mapping: {},
    })),
  });
  const receipts = intake.getIntake(state.db, state.root, profileId, original.id).workflow!
    .identityConfirmations;
  const sourceNames = [
    getNote(state.db, 'person-note:self'),
    getNote(state.db, assigned.noteId),
  ].map((note) => note.person.sourceKnownNames);
  manager.lock(profileId);
  rmSync(join(manager.pathFor(profileId), 'cache'), { recursive: true, force: true });
  manager.unlock(profileId, created.recoveryKit);
  state = manager.opened.get(profileId)!;
  for (const table of ['observations', 'medications', 'procedures'])
    assert.equal(
      state.db.prepare(`SELECT person_id FROM ${table}`).get()!.person_id,
      assigned.personId,
    );
  assert.equal(
    state.db
      .prepare("SELECT json_extract(extra_json,'$.import.personId') owner FROM documents")
      .get()!.owner,
    assigned.personId,
  );
  assert.deepEqual(getNote(state.db, 'person-note:self').person.knownNames, [
    'Fictional Iris Meadow',
  ]);
  assert.equal(getNote(state.db, assigned.noteId).personId, assigned.personId);
  assert.deepEqual(
    [getNote(state.db, 'person-note:self'), getNote(state.db, assigned.noteId)].map(
      (note) => note.person.sourceKnownNames,
    ),
    sourceNames,
  );
  assert.deepEqual(
    intake.getIntake(state.db, state.root, profileId, original.id).workflow!.identityConfirmations,
    receipts,
  );
  assert.deepEqual(
    (await confirmIntakeIdentityScope(state.db, state.root, profileId, original.id, input))
      .workflow!.identityConfirmations,
    receipts,
  );
  const document = state.db.prepare('SELECT id FROM documents').get()!;
  const { transaction } = await import('../database.ts');
  const { correctClinicalRecord } = await import('../record-corrections.ts');
  transaction(state.db, () =>
    correctClinicalRecord(
      state.db,
      {
        kind: 'document',
        recordId: document.id,
        set: { kind: 'procedure', procedureLabel: 'Fictional reviewed procedure' },
        reason: 'Fictional human reclassification',
      },
      'fictional-family-reclassification',
      { root: state.root, profileId },
    ),
  );
  assert.equal(
    state.db.prepare('SELECT person_id FROM procedures WHERE id=?').get(document.id)!.person_id,
    assigned.personId,
  );
  transaction(state.db, () =>
    correctClinicalRecord(
      state.db,
      {
        kind: 'procedure',
        recordId: document.id,
        set: { kind: 'document', documentTitle: 'Fictional reviewed document' },
        reason: 'Fictional reverse reclassification',
      },
      'fictional-family-reclassification-back',
      { root: state.root, profileId },
    ),
  );
  assert.equal(
    state.db
      .prepare(
        "SELECT json_extract(extra_json,'$.import.personId') owner FROM documents WHERE id=?",
      )
      .get(document.id)!.owner,
    assigned.personId,
  );
});

test('a report-wide family choice includes auto-matched and unresolved pending records together', async (t) => {
  const f = fixture(t);
  setSelf(f, { fullName: 'Fictional Iris Meadow', birthDate: fictionalBirthDate });
  const proposed = f.propose([
    withIdentityEvidence(envelope('auto-match')),
    withAnchorOnlyIdentity(envelope('explicit-question')),
  ]);
  const scope = await f.preview();
  assert.equal(scope.targets.length, 1);
  assert.equal(scope.assignmentTargets?.length, 2);
  const saved = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'mixed-report-family'),
    outcome: 'this_is_person',
    attestation: 'confirmed_displayed_identity_questions',
    personSelection: { newPerson: { fullName: 'Fictional Chosen Family' } },
  });
  const person = saved.workflow!.identityConfirmations!.at(-1)!.assignedPerson!;
  const review = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals.at(-1)!.id,
  );
  assert.equal(review.records.length, 2);
  assert.ok(
    review.records.every(
      (record) =>
        record.mapping.personId === person.personId && record.identityReview?.blocking === false,
    ),
  );
});

test('new report rows cannot reuse superseded Self assignment and explicit Self choice covers all pending rows', async (t) => {
  const f = fixture(t);
  const initialValue = withIdentityEvidence(envelope('earlier-family-row'));
  f.propose([initialValue]);
  let scope = await f.preview();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'superseded-self'),
    attestation: 'confirmed_displayed_identity_questions',
  });
  scope = await f.preview();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'current-family'),
    outcome: 'this_is_person',
    attestation: 'confirmed_displayed_identity_questions',
    personSelection: { newPerson: { fullName: 'Fictional Current Family' } },
  });
  const proposed = f.propose([initialValue, withIdentityEvidence(envelope('new-report-row'))]);
  let review = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals.at(-1)!.id,
  );
  assert.ok(review.records.every((record) => record.identityReview?.blocking === true));
  scope = await f.preview();
  assert.equal(scope.assignmentTargets?.length, 3);
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'whole-current-report-self'),
    attestation: 'confirmed_displayed_identity_questions',
  });
  review = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposed.proposals.at(-1)!.id);
  assert.ok(
    review.records.every(
      (record) =>
        record.mapping.subject === 'self' &&
        !record.mapping.personId &&
        record.identityReview?.blocking === false,
    ),
  );
});

test('an exact family assignment resolves identity-question accounting without accepting records', async (t) => {
  const f = fixture(t);
  const proposed = f.propose([withIdentityEvidence(envelope('family-question-accounting'))]);
  const record = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  ).records[0]!;
  let current = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  current = intake.askIntakeQuestion(f.db, f.root, f.profileId, f.item.id, {
    version: current.version,
    key: 'family-subject',
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    field: 'subject',
    prompt: 'Who is the fictional patient?',
    locator: record.evidence[0]!.locator,
  });
  assert.ok((current.unansweredCount || 0) > 0);
  const scope = await f.preview();
  current = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'family-question-accounting'),
    outcome: 'this_is_person',
    attestation: 'confirmed_displayed_identity_questions',
    personSelection: { newPerson: { fullName: 'Fictional Question Owner' } },
  });
  assert.equal(current.unansweredCount, 0);
  assert.equal(current.workflow!.decisions.length, 0);
});

test('a new identity question on a family-assigned candidate requires a fresh explicit person choice', async (t) => {
  const f = fixture(t);
  const proposed = f.propose([withIdentityEvidence(envelope('family-new-question'))]);
  let scope = await f.preview();
  let current = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'first-family-question-scope'),
    outcome: 'this_is_person',
    attestation: 'confirmed_displayed_identity_questions',
    personSelection: { newPerson: { fullName: 'Fictional Question Family' } },
  });
  const person = current.workflow!.identityConfirmations!.at(-1)!.assignedPerson!;
  let review = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposed.proposals[0]!.id);
  const record = review.records[0]!;
  current = intake.askIntakeQuestion(f.db, f.root, f.profileId, f.item.id, {
    version: current.version,
    key: 'new-family-identity-clue',
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    field: 'subject',
    prompt: 'Does this new fictional subject clue identify the same person?',
    locator: record.evidence[0]!.locator,
  });
  review = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposed.proposals[0]!.id);
  assert.equal(review.records[0]!.identityReview?.blocking, true);
  assert.ok(
    review.records[0]!.issues!.some(
      (issue) =>
        issue.prompt.includes('new fictional subject clue') && issue.status === 'unresolved',
    ),
  );
  assert.ok((current.unansweredCount || 0) > 0);
  scope = await f.preview();
  assert.ok(
    scope.questions?.some((question) => question.prompt.includes('new fictional subject clue')),
  );
  current = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope, 'second-family-question-scope'),
    outcome: 'this_is_person',
    attestation: 'confirmed_displayed_identity_questions',
    personSelection: { noteId: person.noteId, expectedVersion: person.version },
  });
  assert.equal(current.unansweredCount, 0);
  review = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposed.proposals[0]!.id);
  assert.equal(review.records[0]!.identityReview?.blocking, false);
  assert.equal(review.records[0]!.mapping.personId, person.personId);
});

for (const owner of ['self', 'family'] as const)
  test(`a subject-only confirmed name is immutable source-backed evidence for ${owner}`, async (t) => {
    const f = fixture(t);
    f.propose([envelope('subject-only-alias')]);
    const scope = await f.preview();
    assert.equal(scope.evidencedIdentity?.fullName, 'Fictional Iris Meadow');
    const input: IntakeIdentityConfirmation = {
      ...request(scope, `protected-source-name-${owner}`),
      ...(owner === 'family'
        ? {
            outcome: 'this_is_person',
            personSelection: { newPerson: { fullName: 'Fictional Family Display' } },
          }
        : {}),
    };
    const result = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input);
    const receipt = result.workflow!.identityConfirmations!.at(-1)!;
    assert.equal(receipt.confirmedPrintedName, 'Fictional Iris Meadow');
    const noteId = receipt.assignedPerson?.noteId || 'person-note:self';
    const note = getNote(f.db, noteId);
    assert.deepEqual(note.person.knownNames, ['Fictional Iris Meadow']);
    assert.equal(note.person.sourceKnownNames?.[0]?.sourceHash, f.item.sha256);
    const edited = saveNote(f.db, noteId, {
      version: note.version,
      person: { ...note.person, knownNames: [], sourceKnownNames: [] },
    });
    assert.deepEqual(edited.person.knownNames, ['Fictional Iris Meadow']);
    assert.deepEqual(edited.person.sourceKnownNames, note.person.sourceKnownNames);
    await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input);
    assert.equal(getNote(f.db, noteId).person.sourceKnownNames!.length, 1);
  });

test('ambiguous printed subject needs an explicit literal name selection and stores only that name', async (t) => {
  const ambiguous = 'For Fictional Iris Meadow and Fictional Orin Pine';
  const f = fixture(t, Buffer.from(`${heading}\n${ambiguous}\nFictional result A 12.00`));
  const value = envelope('ambiguous-name');
  value.report!.subject!.text = ambiguous;
  f.propose([value]);
  const scope = await f.preview();
  assert.equal(scope.evidencedIdentity?.fullName, undefined);
  const input = request(scope, 'selected-literal-name');
  await assert.rejects(
    () => confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input),
    { code: 'IDENTITY_PRINTED_NAME' },
  );
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...input,
        printedName: ambiguous,
      }),
    { code: 'IDENTITY_PRINTED_NAME' },
  );
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...input,
        printedName: 'Fictional Invented Name',
      }),
    { code: 'IDENTITY_PRINTED_NAME' },
  );
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...input,
    printedName: 'Fictional Iris Meadow',
  });
  assert.deepEqual(getNote(f.db, 'person-note:self').person.knownNames, ['Fictional Iris Meadow']);
  // Simulate a pre-upgrade confirmation whose Person projection lacks the new
  // source-name authority. A fresh explicit selection must repair it.
  f.db
    .prepare(
      "UPDATE notes SET profile_json=json_remove(profile_json,'$.sourceKnownNames','$.knownNames') WHERE id='person-note:self'",
    )
    .run();
  const current = await f.preview();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(current, 'legacy-confirmation-name-repair'),
    printedName: 'Fictional Iris Meadow',
  });
  assert.equal(
    getNote(f.db, 'person-note:self').person.sourceKnownNames?.[0]?.name,
    'Fictional Iris Meadow',
  );
});

test('source spellings survive a full manual-name list and canonical-equivalent printed variants', async (t) => {
  const { transaction } = await import('../database.ts');
  const { rememberSourceNameInTransaction } = await import('../notes.ts');
  const f = fixture(t);
  setSelf(f, { knownNames: Array.from({ length: 32 }, (_, index) => `Fictional Manual ${index}`) });
  const proof = {
    operationId: 'fictional-source-name',
    intakeId: f.item.id,
    sourceHash: f.item.sha256,
    groupId: 'fictional-group',
    subjectText: 'Patient: Fictional Iris Meadow',
  };
  transaction(f.db, () => {
    rememberSourceNameInTransaction(f.db, 'person-note:self', {
      ...proof,
      name: 'Fictional Iris Meadow',
    });
    rememberSourceNameInTransaction(f.db, 'person-note:self', {
      ...proof,
      name: 'Meadow, Fictional Iris',
    });
  });
  const note = getNote(f.db, 'person-note:self');
  assert.equal(note.person.knownNames!.length, 33);
  assert.deepEqual(
    note.person.sourceKnownNames!.map((entry) => entry.name),
    ['Fictional Iris Meadow', 'Meadow, Fictional Iris'],
  );
  const saved = saveNote(f.db, note.id, {
    version: note.version,
    person: {
      ...note.person,
      knownNames: [],
      sourceKnownNames: [{ ...proof, name: 'Forged Name' }],
    },
  });
  assert.deepEqual(saved.person.knownNames, ['Fictional Iris Meadow']);
  assert.deepEqual(saved.person.sourceKnownNames, note.person.sourceKnownNames);
});

test('a mismatching evidenced DOB rejects Self and permits a new person without trapping a value draft', async (t) => {
  const f = fixture(t);
  setSelf(f, { fullName: 'Cookie Doe', birthDate: '1986-02-14' });
  const proposed = f.propose([withIdentityEvidence(envelope('dob-conflict'))]);
  const scope = await f.preview();
  await assert.rejects(
    confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
      ...request(scope, 'cookie-wrong-self'),
      attestation: 'confirmed_displayed_identity_questions',
    }),
    /birth date differs from Self/,
  );
  const review = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals.at(-1)!.id,
  );
  const record = review.records[0]!;
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, f.item.id, {
    version: review.version,
    operationId: 'cookie-value-draft',
    proposalId: review.proposalId,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    mapping: { ...record.mapping, valueText: '4.1' },
  });
  const nextScope = await f.preview();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(nextScope, 'cookie-new-person'),
    outcome: 'this_is_person',
    attestation: 'confirmed_displayed_identity_questions',
    personSelection: { newPerson: { fullName: 'Cookie Meadow' } },
  });
  const ready = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals.at(-1)!.id,
  );
  assert.equal(ready.records[0]!.mapping.subject, 'other');
  assert.equal(ready.records[0]!.mapping.valueText, '4.1');
  assert.equal(ready.records[0]!.identityReview!.blocking, false);
});

test('a same-name other-person role stays separate from a confirmed report group', async (t) => {
  const f = fixture(t);
  const a = envelope('a'),
    b = envelope('b');
  b.clinical = { ...(b.clinical as object), subject: 'other' };
  const proposed = f.propose([a, b]);
  const scope = await f.preview();
  assert.equal(scope.targets.length, 1, 'confirmation covers only its own extraction group');
  await f.confirm(scope);
  const review = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  );
  assert.equal(review.records[0]!.identityReview?.blocking, false);
  assert.equal(
    review.records[1]!.identityReview?.blocking,
    true,
    'a receipt never assigns another group',
  );
  assert.throws(() =>
    intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
      version: review.version,
      proposalId: review.proposalId,
      reviewToken: review.reviewToken,
      decisions: [
        { recordId: review.records[1]!.id, action: 'accept', mapping: review.records[1]!.mapping },
      ],
    }),
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 0);
});

for (const includeModelDob of [true, false])
  test(`labelled DOB survives multi-date identity evidence (model DOB ${includeModelDob})`, async (t) => {
    const anchor = `${subject}\nDate of birth: ${fictionalBirthDate}\nCollected: 2026-09-20\nReported: 2026-09-21`;
    const f = fixture(t, Buffer.from(`${originalText}\n${anchor}`));
    setSelf(f, { fullName: 'Cookie Doe', birthDate: '1986-02-14' });
    const value = withIdentityEvidence(envelope('multi-date'));
    value.payload = { literal: 'Result A', transcript: anchor };
    value.reviewIssues = [
      {
        kind: 'identity',
        field: 'subject',
        prompt: 'Who is this report for?',
        textAnchor: anchor,
        selfSuggestion: {
          fullName: 'Fictional Iris Meadow',
          ...(includeModelDob ? { birthDate: fictionalBirthDate } : {}),
        },
      },
    ];
    f.propose([value]);
    const scope = await f.preview();
    await assert.rejects(
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...request(scope, 'multi-date-self'),
        attestation: 'confirmed_displayed_identity_questions',
      }),
      /birth date differs from Self/,
    );
  });

for (const identityText of [
  `${subject}\nDOB: 03/08/1990\nReported: 2026-09-21`,
  `${subject}\nMother DOB: 1990-03-08\nReported: 2026-09-21`,
])
  test(`DOB inference does not guess from ${identityText.includes('Mother') ? 'a relative' : 'an ambiguous numeric date'}`, async (t) => {
    const f = fixture(t, Buffer.from(`${heading}\n${identityText}\nResult A`));
    setSelf(f, { fullName: 'Cookie Doe', birthDate: '1990-03-08' });
    const value = withIdentityEvidence(envelope('ambiguous-birth'));
    value.payload = { literal: 'Result A', transcript: identityText };
    value.reviewIssues = [
      {
        kind: 'identity',
        field: 'subject',
        prompt: 'Who is this report for?',
        textAnchor: identityText,
        selfSuggestion: { fullName: 'Fictional Iris Meadow', birthDate: '1990-03-08' },
      },
    ];
    f.propose([value]);
    if (identityText.includes('Mother')) {
      const scope = await f.preview();
      assert.equal(scope.evidencedIdentity?.birthDate, undefined);
    } else {
      const review = await getIntakeIdentityReview(
        f.db,
        f.root,
        f.profileId,
        f.item.id,
        workflow(f).reportGroups![0]!.id,
      );
      assert.equal(review.evidencedIdentity.birthDate, undefined);
      assert.equal(review.blocking, true);
      assert.deepEqual(review.scope?.birthDateReview?.choices, ['1990-03-08', '1990-08-03']);
    }
  });

test('native PDF DOB blocks Self without a model DOB and with a repeated name footer', async (t) => {
  const f = fixture(
    t,
    pdf([
      `${heading} ${subject} Date of birth: ${fictionalBirthDate} Collected: 2026-09-20 ${subject}`,
    ]),
    'fictional-cookie.pdf',
  );
  setSelf(f, { fullName: 'Fictional Iris Meadow', birthDate: '1986-02-14' });
  f.propose([envelope('no-model-birthday')]);
  const review = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    workflow(f).reportGroups![0]!.id,
  );
  assert.equal(review.evidencedIdentity.birthDate, fictionalBirthDate);
  assert.equal(review.selfBirthDateConflict, true);
  assert.ok(review.scope);
  await assert.rejects(f.confirm(review.scope), { code: 'IDENTITY_CONFLICT' });
});

test('a printed but unreadable, partial or two-digit-year DOB asks even when the name matches Self', async (t) => {
  const identityFor = async (dobLine: string | null) => {
    const lines = [heading, subject, ...(dobLine === null ? [] : [dobLine]), 'Fictional result'];
    const f = fixture(t, Buffer.from(lines.join('\n')));
    setSelf(f, { fullName: 'Fictional Iris Meadow', birthDate: fictionalBirthDate });
    const proposed = f.propose([envelope('printed-dob')]);
    const groupId = workflow(f).reportGroups![0]!.id;
    const review = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, groupId);
    const record = () =>
      intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposed.proposals[0]!.id)
        .records[0]!;
    return { f, review, record };
  };
  // Control: with no birth-date label at all, the matching name alone is an evidenced match.
  const absent = await identityFor(null);
  assert.equal(absent.review.status, 'evidenced_match');
  assert.equal(absent.review.blocking, false);
  for (const dobLine of [
    'DOB: ██/██/19██',
    'DOB: see attached',
    'DOB: 03/1990',
    'Date of birth: March 1990',
    'DOB: 08-MAR-90',
    'D.O.B. 03/08/90',
    'Born: unknown',
  ]) {
    const { f, review, record } = await identityFor(dobLine);
    assert.equal(review.status, 'confirmation_required', dobLine);
    assert.equal(review.blocking, true, dobLine);
    assert.equal(review.evidencedIdentity.birthDate, undefined, dobLine);
    assert.equal(review.selfBirthDateConflict, false, dobLine);
    assert.equal(review.defaultPerson, 'self', dobLine);
    assert.match(review.message, /birth date/i, dobLine);
    assert.equal(record().identityReview?.blocking, true, dobLine);
    assert.equal(record().identityAttribution, undefined, dobLine);
    // Asking is an answerable choice, never a dead end.
    assert.ok(review.scope, dobLine);
    await f.confirm(review.scope, 'fictional-unreadable-dob-self');
    assert.equal(record().identityReview?.blocking, false, dobLine);
    assert.equal(record().identityReview?.status, 'prior_confirmation', dobLine);
  }
});

test('a Self confirmation of another report on the same original does not answer an unreadable DOB', async (t) => {
  const secondHeading = 'Fictional report IVY-64';
  for (const secondDob of [null, 'DOB: see attached']) {
    const lines = [heading, subject, 'Fictional result A', secondHeading, subject];
    const f = fixture(
      t,
      Buffer.from([...lines, ...(secondDob ? [secondDob] : []), 'Fictional result B'].join('\n')),
    );
    const second = envelope('second-report');
    second.report = {
      ...second.report!,
      key: 'second-claim',
      anchor: { locator: 'page 1 second heading', text: secondHeading },
    };
    f.propose([envelope('first-report'), second]);
    const groups = workflow(f).reportGroups!;
    assert.equal(groups.length, 2);
    await f.confirm(await f.preview(f.item.id, groups[0]!.id), 'fictional-first-report-self');
    const review = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      groups[1]!.id,
    );
    // Control: a readable (here absent) DOB lets the same printed person reuse it.
    assert.equal(review.status, secondDob ? 'confirmation_required' : 'prior_confirmation');
    assert.equal(review.blocking, !!secondDob);
  }
});

test('newly accepted DOB labels and layouts establish a complete-date match or conflict', async (t) => {
  for (const [dobLine, selfBirthDate, conflict] of [
    ['Born: 8 Mar 1990', fictionalBirthDate, false],
    ['Birthdate: 08-MAR-1990', fictionalBirthDate, false],
    ['D.O.B. 8-Mar-1990', '1986-02-14', true],
  ] as const) {
    const f = fixture(t, Buffer.from(`${heading}\n${subject}\n${dobLine}\nFictional result`));
    setSelf(f, { fullName: 'Fictional Iris Meadow', birthDate: selfBirthDate });
    f.propose([envelope('new-dob-layout')]);
    const review = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      workflow(f).reportGroups![0]!.id,
    );
    assert.equal(review.evidencedIdentity.birthDate, fictionalBirthDate, dobLine);
    assert.equal(review.selfBirthDateConflict, conflict, dobLine);
    assert.equal(review.blocking, conflict, dobLine);
    if (!conflict) {
      assert.equal(review.status, 'evidenced_match', dobLine);
      assert.equal(review.confidence, 'strong', dobLine);
    }
  }
});

test('a patient banner printed above the report heading keeps its DOB', async (t) => {
  for (const [bytes, filename] of [
    [
      Buffer.from(`${subject}   DOB: ${fictionalBirthDate}\n${heading}\nFictional result\nPage 1`),
      'fictional-banner.txt',
    ],
    [
      pdf([`${subject} DOB: ${fictionalBirthDate} ${heading} Fictional result`]),
      'fictional-banner.pdf',
    ],
  ] as const) {
    const f = fixture(t, bytes, filename);
    setSelf(f, { fullName: 'Fictional Iris Meadow', birthDate: '1986-02-14' });
    f.propose([envelope('banner-dob')]);
    const review = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      workflow(f).reportGroups![0]!.id,
    );
    assert.equal(review.evidencedIdentity.birthDate, fictionalBirthDate, filename);
    assert.equal(review.selfBirthDateConflict, true, filename);
    assert.equal(review.blocking, true, filename);
    assert.equal(review.defaultPerson, 'new', filename);
  }
});

test('ambiguous DOB asks even when one reading matches Self, records the human reading, and guards acceptance', async (t) => {
  const f = fixture(
    t,
    Buffer.from(`${heading}\n${subject}\nDOB: 03/08/1990\nFictional result A 12.00`),
  );
  setSelf(f, { fullName: 'Fictional Iris Meadow', birthDate: fictionalBirthDate });
  const proposed = f.propose([envelope('ambiguous-human-date')]);
  const scope = await f.preview();
  assert.equal(scope.evidencedIdentity?.birthDate, undefined);
  assert.deepEqual(scope.birthDateReview?.choices, ['1990-03-08', '1990-08-03']);
  const blocked = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  );
  assert.equal(blocked.records[0]!.identityReview?.blocking, true);
  assert.throws(
    () =>
      intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
        version: blocked.version,
        proposalId: blocked.proposalId,
        reviewToken: blocked.reviewToken,
        decisions: [{ recordId: blocked.records[0]!.id, action: 'accept', mapping: {} }],
      }),
    { code: 'REVIEW_ISSUES_PENDING' },
  );
  const input = {
    ...request(scope, 'choose-ambiguous-date'),
    attestation: 'confirmed_displayed_identity_questions' as const,
  };
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...input,
        identityAnswers: undefined,
      }),
    { code: 'IDENTITY_BIRTH_DATE' },
  );
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...input,
        identityAnswers: { birthDate: '1990-08-03' },
      }),
    { code: 'IDENTITY_CONFLICT' },
  );
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...input,
    identityAnswers: { birthDate: fictionalBirthDate },
  });
  assert.deepEqual(workflow(f).identityConfirmations!.at(-1)!.identityAnswers, {
    birthDate: fictionalBirthDate,
  });
  assert.equal(getNote(f.db, 'person-note:self').person.birthDate, fictionalBirthDate);
  const ready = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  );
  assert.equal(ready.records[0]!.identityReview?.blocking, false);
});

test('existing-person assignment checks their current DOB without writing drafts or aliases', async (t) => {
  const f = fixture(t);
  const { createNote } = await import('../notes.ts');
  const other = createNote(f.db, {
    kind: 'person',
    title: 'Fictional Iris',
    content: '',
    person: { fullName: 'Fictional Iris Meadow', birthDate: '1980-01-01' },
  });
  f.propose([envelope('existing-dob-mismatch')]);
  const scope = await f.preview();
  await assert.rejects(
    () =>
      confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        ...request(scope),
        outcome: 'this_is_person',
        attestation: 'confirmed_displayed_identity_questions',
        personSelection: { noteId: other.id, expectedVersion: other.version },
      }),
    { code: 'IDENTITY_CONFLICT' },
  );
  assert.equal(workflow(f).identityConfirmations?.length || 0, 0);
  assert.equal(workflow(f).reviewDrafts!.length, 0);
  assert.equal(getNote(f.db, other.id).version, other.version);
});

test('a single printed name can be confirmed for this report without adding an identity alias', async (t) => {
  const f = fixture(t, Buffer.from(`${heading}\nPatient: Iris\nFictional result A 12.00`));
  const value = envelope('single-name');
  value.report!.subject!.text = 'Patient: Iris';
  f.propose([value]);
  const scope = await f.preview();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope),
    attestation: 'confirmed_displayed_identity_questions',
  });
  assert.equal(workflow(f).identityConfirmations!.at(-1)!.confirmedPrintedName, 'Iris');
  assert.equal(workflow(f).identityConfirmations!.at(-1)!.knownNameAdded, undefined);
  assert.ok(!getNote(f.db, 'person-note:self').person.knownNames?.includes('Iris'));
});

test('conflicting subject claims have an exact human repair without covering the other claim or later records', async (t) => {
  const f = fixture(t);
  const other = envelope('contradictory-subject');
  other.report!.subject!.text = 'Patient: Fictional Rowan Pebble';
  const proposed = f.propose([envelope('repairable-subject'), other]);
  const scope = await f.preview();
  assert.equal(scope.competingSubjects?.length, 1);
  await assert.rejects(() => f.confirm(scope), { code: 'IDENTITY_CONFIRMATION' });
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope),
    attestation: 'confirmed_displayed_identity_questions',
  });
  const reviewed = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals[0]!.id,
  );
  assert.equal(reviewed.records[0]!.identityReview?.blocking, false);
  assert.equal(reviewed.records[1]!.identityReview?.blocking, true);
  const later = f.propose([envelope('new-unreviewed-record')]);
  const newReview = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    later.proposals.at(-1)!.id,
  );
  assert.equal(newReview.records[0]!.identityReview?.blocking, true);
});

test('a repaired boundary cannot authorize a newly added identity question on the same occurrence', async (t) => {
  const f = fixture(t);
  const other = envelope('competing-question');
  other.report!.subject!.text = 'Patient: Fictional Rowan Pebble';
  f.propose([envelope('repair-question'), other]);
  const scope = await f.preview();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...request(scope),
    attestation: 'confirmed_displayed_identity_questions',
  });
  const { identityBoundaryRepairApplies } = await import('../intake-identity-policy.ts');
  const receipt = workflow(f).identityConfirmations!.at(-1)!;
  const groups = workflow(f).reportGroups!;
  const group = groups.find((item) => item.id === scope.groupId)!;
  const targets = scope.assignmentTargets!;
  assert.equal(identityBoundaryRepairApplies(receipt, group, groups, targets), true);
  assert.equal(
    identityBoundaryRepairApplies(
      receipt,
      group,
      groups,
      targets.map((target) => ({
        ...target,
        issueIds: [...(target.issueIds || [target.issueId]), 'new-unreviewed-identity-question'],
      })),
    ),
    false,
  );
});

test('report new-Person assignment rejects canonical Self names and saved aliases', async (t) => {
  const f = fixture(t);
  setSelf(f, { fullName: 'Fictional Separate Self', knownNames: ['Fictional Former Self'] });
  f.propose([withIdentityEvidence(envelope('self-duplicate-guard'))]);
  const scope = await f.preview();
  for (const fullName of ['Fictional Separate Self', '  fictional former self  '])
    await assert.rejects(
      () =>
        confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
          ...request(scope, 'duplicate-self-' + fullName),
          outcome: 'this_is_person',
          attestation: 'confirmed_displayed_identity_questions',
          personSelection: { newPerson: { fullName } },
        }),
      { code: 'INTAKE_PERSON_SELF' },
    );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM notes WHERE kind='person' AND person_id!='patient'").get()!
      .n,
    0,
  );
});
