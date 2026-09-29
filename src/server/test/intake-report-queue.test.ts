import { zipFixture } from '../../tests/fixtures/zip.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import {
  listIntakeReportQueue,
  getIntakeReportQueueGroup,
  listIntakeImportFeed,
} from '../intake-report-queue.ts';
import { acceptIntakeReportSelection } from '../intake-report-acceptance.ts';
import { randomUUID } from 'node:crypto';
import { handleIntakeRoute } from '../intake-routes.ts';
import { createBackup } from '../recovery.ts';
import { rebuildProfile } from '../portable.ts';
import { fictionalModel } from './fictional-model.ts';
import { readIntakeBatch, writeIntakeBatch } from '../intake-batch-journal.ts';
import { writeChat } from '../assistant-journal.ts';
import { getNote, saveNote } from '../notes.ts';
import { getIntakeIdentityReview, confirmIntakeIdentityScope } from '../intake-identity.ts';
import type {
  HealthRecordEnvelope,
  Intake,
  IntakeReportQueue,
  IntakeReportQueueDetail,
} from '../../shared/intake.ts';

function fixture(t: TestContext) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-report-queue-')),
    profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const self = getNote(db, 'person-note:self');
  saveNote(db, self.id, {
    version: self.version,
    person: { ...self.person, fullName: 'Fictional Fern Patient' },
  });
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db };
}
type Fixture = ReturnType<typeof fixture>;
const identityEvidence = () => ({
  kind: 'identity' as const,
  field: 'subject',
  prompt: 'Does the printed fictional patient identity belong to you?',
  textAnchor: 'Fictional Fern Patient',
  selfSuggestion: { fullName: 'Fictional Fern Patient' },
});
function envelope(id: string, reportName = 'Fictional DEXA A'): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: {
      literal: '+12.00',
      transcript: `${reportName}\nFictional Fern Patient`,
    },
    provenance: {
      capturedVia: 'Fictional delivery',
      sourceSystem: 'Fictional issuer',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'page 1 ' + id,
    },
    coverage: { status: 'partial', notes: [] },
    report: {
      key: reportName,
      title: reportName,
      anchor: { locator: 'heading ' + reportName, text: reportName },
      subject: { locator: 'patient header', text: 'Fictional Fern Patient' },
    },
    reviewIssues: [identityEvidence()],
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: id,
      valueText: '+12.00',
      date: '2026-09',
      unit: 'mg',
    },
  };
}
function upload(f: Fixture, values: HealthRecordEnvelope[], filename = 'fictional.jsonl'): Intake {
  return intake.uploadIntake(f.db, f.root, f.profileId, {
    filename,
    bytes: Buffer.from(values.map((value) => JSON.stringify(value)).join('\n')),
  });
}
function queue(f: Fixture, options: Parameters<typeof listIntakeReportQueue>[3] = {}) {
  return listIntakeReportQueue(f.db, f.root, f.profileId, options);
}
function detail(
  f: Fixture,
  id: string,
  options: Parameters<typeof getIntakeReportQueueGroup>[4] = {},
) {
  return getIntakeReportQueueGroup(f.db, f.root, f.profileId, id, options);
}
function rows(detail: IntakeReportQueueDetail) {
  return detail.blocks.flatMap((block) => block.records);
}
function mutateRecord(
  f: Fixture,
  groupId: string,
  index: number,
  action: 'accept' | 'review_later' | 'keep_original_only',
) {
  const current = detail(f, groupId),
    record = rows(current)[index]!,
    block = current.blocks.find((block) => block.records.some((row) => row.id === record.id))!;
  if (action === 'accept')
    return intake.importIntake(f.db, f.root, f.profileId, block.intakeId, {
      version: block.intakeVersion,
      proposalId: block.proposalId,
      reviewToken: block.reviewToken,
      decisions: [{ recordId: record.id, action: 'accept', mapping: {} }],
    });
  return intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, block.intakeId, {
    version: block.intakeVersion,
    proposalId: block.proposalId,
    operationId: action + record.candidateVersionId,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    disposition: action,
  });
}

test('DEXA queue counts 28 results independently and counts accepted, deferred, blocked and kept versions', (t) => {
  const f = fixture(t),
    values = Array.from({ length: 28 }, (_, i) => envelope('result-' + i));
  values[27]!.reviewIssues = [
    identityEvidence(),
    { kind: 'uncertain_reading', prompt: 'Is the fictional reading 12 or 13?', field: 'valueText' },
  ];
  upload(f, values);
  const groupId = queue(f).groups[0]!.groupId;
  assert.equal(detail(f, groupId).totalRecords, 28);
  assert.equal(queue(f).groups[0]!.counts.blocked, 1);
  mutateRecord(f, groupId, 0, 'accept');
  mutateRecord(f, groupId, 0, 'review_later');
  mutateRecord(f, groupId, 0, 'keep_original_only');
  const group = queue(f).groups[0]!;
  assert.deepEqual(group.counts, {
    pending: 25,
    deferred: 1,
    accepted: 1,
    keptOriginal: 1,
    superseded: 0,
    blocked: 1,
    questions: 1,
  });
  assert.equal(detail(f, groupId).totalRecords, 25);
  assert.equal(detail(f, groupId, { view: 'deferred' }).totalRecords, 1);
  assert.equal(rows(detail(f, groupId)).filter((record) => record.selectable).length, 24);
  assert.equal(
    rows(detail(f, groupId, { view: 'all' })).filter((record) =>
      ['accepted', 'kept_original'].includes(record.queueState),
    ).length,
    2,
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
});

test('newest candidate version replaces stale pending history while unrelated earlier proposal rows remain actionable', async (t) => {
  const f = fixture(t),
    original = envelope('versioned'),
    other = envelope('independent');
  let item = upload(f, [original, other]);
  const groupId = queue(f).groups[0]!.groupId,
    order = queue(f).groups[0]!.discoveryOrder;
  const proposalText = JSON.stringify({
    ...original,
    payload: { ...(original.payload as object), literal: '+13.00' },
  });
  item = intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    jsonlText: proposalText,
    summary: 'Fictional changed result',
  });
  const current = detail(f, groupId);
  assert.equal(current.blocks.length, 2);
  assert.equal(current.totalRecords, 2);
  assert.equal(current.group.counts.superseded, 1);
  assert.equal(current.group.discoveryOrder, order);
  assert.equal(
    current.blocks.find((block) => block.proposalId === null)!.records[0]!.mapping.testLabel,
    'independent',
  );
  const all = rows(detail(f, groupId, { view: 'all' }));
  assert.equal(all.filter((record) => record.queueState === 'superseded').length, 1);
  assert.equal(all.find((record) => record.queueState === 'superseded')!.selectable, false);
  const stable = queue(f);
  intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    jsonlText: proposalText,
    summary: 'Fictional retry',
  });
  assert.deepEqual(queue(f), stable);
  let newBlock = current.blocks.find((block) => block.proposalId !== null)!;
  assert.equal(newBlock.records[0]!.identityReview?.blocking, true);
  const identity = await getIntakeIdentityReview(f.db, f.root, f.profileId, item.id, groupId);
  assert.equal(identity.status, 'evidenced_match');
  newBlock = detail(f, groupId).blocks.find((block) => block.proposalId !== null)!;
  assert.equal(newBlock.records[0]!.identityReview?.status, 'evidenced_match');
  intake.importIntake(f.db, f.root, f.profileId, item.id, {
    version: newBlock.intakeVersion,
    proposalId: newBlock.proposalId,
    reviewToken: newBlock.reviewToken,
    decisions: [{ recordId: newBlock.records[0]!.id, action: 'accept', mapping: {} }],
  });
  assert.equal(queue(f).groups[0]!.counts.accepted, 1);
  assert.equal(queue(f).groups[0]!.counts.pending, 1);
  assert.equal(queue(f).groups[0]!.counts.superseded, 1);
});

test('accepted earlier version stays accepted when a later version needs review, with exact per-proposal receipt', (t) => {
  const f = fixture(t),
    original = envelope('accepted');
  let item = upload(f, [original]);
  const id = queue(f).groups[0]!.groupId;
  item = mutateRecord(f, id, 0, 'accept');
  assert.equal(queue(f).totalGroups, 0);
  item = intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    jsonlText: JSON.stringify({ ...original, payload: 'Later fictional evidence' }),
    summary: 'Changed evidence',
  });
  const current = detail(f, id);
  assert.equal(current.totalRecords, 1);
  assert.equal(current.group.counts.accepted, 1);
  assert.equal(current.group.counts.pending, 1);
  assert.equal(current.blocks[0]!.proposalId, item.proposals[0]!.id);
  assert.equal(current.blocks[0]!.intakeVersion, item.version);
  assert.equal(current.blocks[0]!.records[0]!.reviewState, 'pending');
});

test('new groups in older files append monotonically and cursors survive completed rows disappearing', (t) => {
  const f = fixture(t);
  let older = upload(f, [envelope('old', 'Old report')], 'older.jsonl');
  const firstId = queue(f).groups[0]!.groupId;
  upload(f, [envelope('new', 'New report')], 'newer.jsonl');
  const firstPage = queue(f, { limit: 1 });
  assert.ok(firstPage.nextCursor);
  older = intake.proposeConversion(f.db, f.root, f.profileId, older.id, {
    version: older.version,
    jsonlText: JSON.stringify(envelope('found-later', 'Late report in older file')),
    summary: 'Later discovery',
  });
  const list = queue(f);
  assert.deepEqual(
    list.groups.map((group) => group.title),
    ['Old report', 'New report', 'Late report in older file'],
  );
  assert.equal(new Set(list.groups.map((group) => group.discoveryOrder)).size, 3);
  mutateRecord(f, firstId, 0, 'accept');
  assert.deepEqual(
    queue(f, { limit: 1, cursor: firstPage.nextCursor }).groups.map((group) => group.title),
    ['New report'],
  );
  assert.equal(detail(f, firstId).totalRecords, 0);
  assert.equal(detail(f, firstId, { view: 'all' }).totalRecords, 1);
  assert.equal(intake.getIntake(f.db, f.root, f.profileId, older.id).proposals.length, 1);
});

test('record pagination remains stable after acceptance and newly discovered versions append', (t) => {
  const f = fixture(t),
    values = Array.from({ length: 5 }, (_, i) => envelope('page-' + i));
  const item = upload(f, values),
    groupId = queue(f).groups[0]!.groupId;
  const first = detail(f, groupId, { limit: 2 });
  assert.ok(first.nextCursor);
  mutateRecord(f, groupId, 0, 'accept');
  const second = detail(f, groupId, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(
    rows(second).map((record) => record.mapping.testLabel),
    ['page-2', 'page-3'],
  );
  assert.equal(second.blocks[0]!.intakeId, item.id);
  assert.throws(() => detail(f, groupId, { view: 'deferred', cursor: first.nextCursor }), {
    code: 'REPORT_QUEUE_CURSOR',
  });
});

test('package occurrences and valid retained child JSONL get separate durable groups without claiming complete reading', async (t) => {
  const f = fixture(t);
  const bytes = zipFixture([
    { name: 'a.txt', data: 'Fictional report A' },
    { name: 'b.txt', data: 'Fictional report B' },
  ]);
  let item: Intake = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional.zip',
    bytes,
  });
  item = await intake.createIntakePlan(f.db, f.root, f.profileId, item.id, {
    version: item.version,
  });
  const members = item.workflow!.plans[0]!.index.members!;
  const values = members.map((member) => {
    const value = envelope('same-result-id');
    value.report!.memberId = member.memberId;
    return value;
  });
  item = intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    jsonlText: values.map((value) => JSON.stringify(value)).join('\n'),
    summary: 'Fictional separate members',
  });
  assert.equal(queue(f).groups.length, 2);
  assert.equal(new Set(queue(f).groups.map((group) => group.member!.memberId)).size, 2);
  assert.equal(queue(f).activity.extractionComplete, false);
  const children = [
    {
      filename: 'child.jsonl',
      locator: 'fictional retained member',
      bytes: Buffer.from(JSON.stringify(envelope('child-result'))),
    },
  ];
  intake.retainIntakeChildren(f.db, f.root, f.profileId, item.id, children);
  const after = queue(f);
  assert.equal(after.groups.length, 3);
  assert.equal(after.groups[2]!.original.parentSourceFileId, item.id);
  intake.retainIntakeChildren(f.db, f.root, f.profileId, item.id, children);
  assert.deepEqual(queue(f), after);
});

test('queue state and discovery order survive rebuild and cannot cross profile ownership', async (t) => {
  const f = fixture(t);
  upload(f, [envelope('persisted'), envelope('deferred')]);
  const id = queue(f).groups[0]!.groupId;
  mutateRecord(f, id, 1, 'review_later');
  const expected = queue(f),
    expectedDetail = detail(f, id, { view: 'all' }),
    expectedFeed = feed(f, { view: 'all' });
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'rebuilt');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target);
  const db = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.deepEqual(listIntakeReportQueue(db, target, f.profileId), expected);
    assert.deepEqual(listIntakeImportFeed(db, target, f.profileId, { view: 'all' }), expectedFeed);
    assert.deepEqual(
      getIntakeReportQueueGroup(db, target, f.profileId, id, { view: 'all' }),
      expectedDetail,
    );
    assert.throws(() => listIntakeReportQueue(db, target, 'cedar'), {
      code: 'PROFILE_BOUNDARY',
    });
  } finally {
    db.close();
  }
  const other = openDatabase(ensureProfileDirectories(f.root, 'cedar').database, 'cedar');
  try {
    assert.throws(() => getIntakeReportQueueGroup(other, f.root, 'cedar', id), {
      code: 'REPORT_GROUP_NOT_FOUND',
    });
  } finally {
    other.close();
  }
});

test('reading activity does not equate ready reports or completed batches with complete extraction', (t) => {
  const f = fixture(t),
    item = upload(f, [envelope('reading')]);
  writeIntakeBatch(
    f.root,
    f.profileId,
    {
      id: '00000000-0000-4000-8000-000000000042',
      profileId: f.profileId,
      operationId: 'fictional-reading',
      status: 'running',
      reason: null,
      currentIndex: 0,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      items: [
        {
          intakeId: item.id,
          sourceHash: item.sha256,
          filename: item.filename,
          mimeType: item.mimeType,
          status: 'running',
          reason: null,
          chatId: null,
          proposalIds: [],
          reading: {
            status: 'running',
            reason: null,
            turns: 1,
            readyRecords: 1,
            remainingUnits: 2,
            pendingReadWindows: 1,
            coverage: 'reading_progress_only',
          },
          startedAt: null,
          endedAt: null,
        },
      ],
    },
    'Fictional test',
  );
  assert.equal(queue(f).activity.runningFiles, 1);
  mutateRecord(f, queue(f).groups[0]!.groupId, 0, 'accept');
  assert.equal(queue(f).activity.allCurrentReportsReviewed, true);
  assert.equal(queue(f).activity.runningFiles, 1);
  assert.equal(queue(f).activity.extractionComplete, false);
  const batch = readIntakeBatch(f.root, f.profileId, '00000000-0000-4000-8000-000000000042');
  batch.status = 'complete';
  batch.items[0]!.status = 'review_ready';
  batch.items[0]!.reading!.status = 'paused';
  batch.items[0]!.reading!.reason = 'bounded_reading_limit';
  writeIntakeBatch(f.root, f.profileId, batch, 'Fictional bounded pass');
  assert.equal(queue(f).activity.runningFiles, 0);
  assert.equal(queue(f).activity.pausedFiles, 1);
  batch.items[0]!.reading!.reason = 'reading_exhausted';
  writeIntakeBatch(f.root, f.profileId, batch, 'Fictional read windows exhausted');
  assert.equal(queue(f).activity.pausedFiles, 0, 'exhausted reads do not offer a futile resume');
  assert.equal(
    queue(f).activity.extractionComplete,
    false,
    'reading alone cannot prove extraction',
  );
  const chatId = randomUUID();
  intake.linkIntakeConversion(f.db, f.root, f.profileId, item.id, chatId);
  const chat = {
    id: chatId,
    status: 'running',
    context: { intakeId: item.id },
    conversionCheckpoint: { profileId: f.profileId, intakeId: item.id, sourceHash: 'wrong-source' },
  };
  writeChat(f.root, f.profileId, chat, 'Fictional different source');
  assert.equal(
    queue(f).activity.runningFiles,
    0,
    'unrelated source checkpoint is not active reading',
  );
  chat.conversionCheckpoint.sourceHash = item.sha256;
  writeChat(f.root, f.profileId, chat, 'Fictional direct Assistant resume');
  assert.equal(
    queue(f).activity.runningFiles,
    1,
    'current linked run overrides the completed batch',
  );
  assert.equal(queue(f).activity.pausedFiles, 0);
  chat.status = 'idle';
  writeChat(f.root, f.profileId, chat, 'Fictional direct Assistant stop');
  assert.equal(queue(f).activity.runningFiles, 0);
});

test('queue routes expose exact group selection and reject invalid windows', async (t) => {
  const f = fixture(t);
  upload(f, [envelope('route')]);
  let response: unknown;
  const context = {
    ...f,
    resource: 'intakes',
    id: 'report-queue',
    method: 'GET',
    params: new URLSearchParams(),
    respond: (value: unknown) => {
      response = value;
    },
  } as Parameters<typeof handleIntakeRoute>[0];
  assert.equal(await handleIntakeRoute(context), true);
  const result = response as IntakeReportQueue;
  await handleIntakeRoute({ ...context, action: result.groups[0]!.groupId });
  assert.equal(
    (response as IntakeReportQueueDetail).blocks[0]!.records[0]!.mapping.testLabel,
    'route',
  );
  for (const input of ['limit=0', 'limit=101', 'limit=Infinity', 'view=foreign', 'cursor=invalid'])
    await assert.rejects(handleIntakeRoute({ ...context, params: new URLSearchParams(input) }));
});

test('an unversioned legacy identity answer cannot unblock changed evidence or erase accepted history', async (t) => {
  const f = fixture(t),
    original = envelope('legacy-identity');
  let item = upload(f, [original]);
  const id = queue(f).groups[0]!.groupId;
  let review = intake.reviewIntake(f.db, f.root, f.profileId, item.id);
  item = intake.askIntakeQuestion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    key: 'legacy-patient',
    candidateId: review.records[0]!.candidateId,
    field: 'subject',
    prompt: 'Does this fictional report belong to you?',
    locator: 'patient header',
  });
  const questionId = item.workflow!.questions[0]!.id;
  item = intake.answerIntakeQuestion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    operationId: 'legacy-answer',
    questionId,
    answer: 'This fictional patient is me',
    mapping: { subject: 'self' },
  });
  review = intake.reviewIntake(f.db, f.root, f.profileId, item.id);
  assert.equal(review.records[0]!.identityReview?.blocking, true);
  assert.throws(
    () =>
      intake.importIntake(f.db, f.root, f.profileId, item.id, {
        version: item.version,
        reviewToken: review.reviewToken,
        decisions: [
          { recordId: review.records[0]!.id, action: 'accept', mapping: { subject: 'self' } },
        ],
      }),
    { code: 'REVIEW_ISSUES_PENDING' },
  );
  item = intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    operationId: 'reopen-legacy-answer',
    proposalId: null,
    recordId: review.records[0]!.id,
    candidateVersionId: review.records[0]!.candidateVersionId!,
    resolutions: [{ issueId: questionId, outcome: 'unknown' }],
  });
  const initialIdentity = await getIntakeIdentityReview(f.db, f.root, f.profileId, item.id, id);
  item = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, item.id, {
    version: initialIdentity.scope!.intakeVersion,
    operationId: 'confirm-initial-current-identity',
    scope: initialIdentity.scope!,
    outcome: 'this_is_me',
    attestation: 'confirmed_displayed_identity_questions',
  });
  review = intake.reviewIntake(f.db, f.root, f.profileId, item.id);
  item = intake.importIntake(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    reviewToken: review.reviewToken,
    decisions: [
      { recordId: review.records[0]!.id, action: 'accept', mapping: { subject: 'self' } },
    ],
  });
  const oldHistory = structuredClone(item.workflow!.questions);
  item = intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    jsonlText: JSON.stringify({
      ...original,
      payload: { literal: '+12.00', printedPatient: 'Fictional Rowan Changed' },
    }),
    summary: 'Changed patient cues',
  });
  let current = detail(f, id),
    record = rows(current)[0]!;
  assert.equal(record.selectable, false);
  assert.equal(current.group.counts.blocked, 1);
  assert.equal(
    record.issues!.find((issue) => issue.questionId === questionId)!.status,
    'unresolved',
  );
  assert.deepEqual(
    intake.getIntake(f.db, f.root, f.profileId, item.id).workflow!.questions,
    oldHistory,
  );
  assert.equal(
    intake.reviewIntake(f.db, f.root, f.profileId, item.id).records[0]!.reviewState,
    'accepted',
  );
  const block = current.blocks[0]!;
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
    version: block.intakeVersion,
    proposalId: block.proposalId,
    operationId: 'confirm-changed-version',
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    resolutions: [{ issueId: questionId, outcome: 'this_is_me' }],
  });
  current = detail(f, id);
  record = rows(current)[0]!;
  assert.equal(record.selectable, false);
  const reopened = intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
    version: current.blocks[0]!.intakeVersion,
    proposalId: current.blocks[0]!.proposalId,
    operationId: 'reopen-changed-version',
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    resolutions: [{ issueId: questionId, outcome: 'unknown' }],
  });
  const changedIdentity = await getIntakeIdentityReview(f.db, f.root, f.profileId, reopened.id, id);
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, reopened.id, {
    version: changedIdentity.scope!.intakeVersion,
    operationId: 'confirm-changed-current-identity',
    scope: changedIdentity.scope!,
    outcome: 'this_is_me',
    attestation: 'confirmed_displayed_identity_questions',
  });
  current = detail(f, id);
  record = rows(current)[0]!;
  assert.equal(record.selectable, true);
  assert.equal(current.group.counts.accepted, 1);
});

test('an old envelope copied into a later proposal cannot resurrect superseded work', (t) => {
  const f = fixture(t),
    old = envelope('echoed');
  let item = upload(f, [old]);
  const groupId = queue(f).groups[0]!.groupId;
  item = intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    jsonlText: JSON.stringify({ ...old, payload: 'Fictional newer result' }),
    summary: 'Newer candidate version',
  });
  const newest = rows(detail(f, groupId))[0]!.candidateVersionId;
  intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    jsonlText: JSON.stringify(old),
    summary: 'Later proposal echoes old evidence',
  });
  const current = detail(f, groupId);
  assert.equal(current.totalRecords, 1);
  assert.equal(rows(current)[0]!.candidateVersionId, newest);
  assert.equal(current.group.counts.superseded, 1);
});

test('context contributes no queue records and unsupported current records stay visibly blocked', (t) => {
  const f = fixture(t),
    context: HealthRecordEnvelope = { ...envelope('context'), kind: 'context' };
  delete context.clinical;
  const unsupported = {
    ...envelope('other-person'),
    clinical: { kind: 'observation', subject: 'other', testLabel: 'Fictional family finding' },
  };
  upload(f, [context, unsupported]);
  const result = queue(f);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]!.date, null);
  assert.equal(result.groups[0]!.counts.pending, 1);
  assert.equal(result.groups[0]!.counts.blocked, 1);
  assert.equal(rows(detail(f, result.groups[0]!.groupId))[0]!.selectable, false);
});

test('fallback groups display current clinical labels while retaining opaque group identity and history', (t) => {
  const f = fixture(t),
    value = envelope('fictional-opaque-envelope-id');
  delete value.report;
  value.clinical = { ...(value.clinical as object), testLabel: 'Fictional first result' };
  let item = upload(f, [value], 'fictional-source.jsonl');
  const originalGroup = structuredClone(item.workflow!.reportGroups![0]!);
  let summary = queue(f).groups[0]!;
  assert.equal(summary.title, 'Fictional first result');
  assert.equal(summary.groupId, originalGroup.id);
  const record = intake.reviewIntake(f.db, f.root, f.profileId, item.id).records[0]!;
  item = intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    operationId: 'fictional-label-correction',
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    mapping: { testLabel: 'Fictional corrected label' },
  });
  summary = queue(f).groups[0]!;
  assert.equal(summary.title, 'Fictional corrected label');
  assert.deepEqual(item.workflow!.reportGroups![0], originalGroup);
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    operationId: 'fictional-empty-label',
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    mapping: { testLabel: '' },
  });
  assert.equal(queue(f).groups[0]!.title, 'fictional-source.jsonl');
});

function feed(f: Fixture, options: Parameters<typeof listIntakeImportFeed>[3] = {}) {
  return listIntakeImportFeed(f.db, f.root, f.profileId, options);
}
function feedRows(value: ReturnType<typeof feed>) {
  return value.blocks
    .flatMap((block) => block.records)
    .sort((a, b) => (a.feedOrder < b.feedOrder ? -1 : a.feedOrder > b.feedOrder ? 1 : 0));
}
test('global feed bounds records across groups and cursors survive earlier deferral with exact keys', (t) => {
  const f = fixture(t);
  upload(f, [
    envelope('one', 'Report A'),
    envelope('two', 'Report A'),
    envelope('three', 'Report B'),
  ]);
  const first = feed(f, { limit: 2 });
  assert.equal(first.totalRecords, 3);
  assert.equal(first.groups.length, 1);
  assert.equal(feedRows(first).length, 2);
  assert.equal(first.kindCounts.test, 3);
  const before = feedRows(first).map((row) => row.feedKey);
  mutateRecord(f, first.groups[0]!.groupId, 0, 'review_later');
  const second = feed(f, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(
    feedRows(second).map((row) => row.mapping.testLabel),
    ['three'],
  );
  assert.equal(second.nextCursor, null);
  assert.equal(second.counts.deferred, 1);
  assert.equal(second.counts.pending, 2);
  assert.equal(feedRows(feed(f, { view: 'all' }))[0]!.feedKey, before[0]);
  const block = second.blocks[0]!;
  const exact = intake.reviewIntake(f.db, f.root, f.profileId, block.intakeId, block.proposalId);
  assert.equal(block.reviewToken, exact.reviewToken);
  assert.equal(block.intakeVersion, exact.version);
  assert.equal(feedRows(second)[0]!.mapping.valueText, '+12.00');
});

test('global feed counts current blocked records, clinical kinds and retained edits without inflating identity edits', (t) => {
  const f = fixture(t);
  const medication = envelope('Fictional medicine', 'Medication report');
  medication.clinical = {
    kind: 'medication',
    subject: 'self',
    medicationName: 'Fictional medicine',
    doseText: '2 mg',
  };
  const blocked = envelope('blocked result');
  blocked.reviewIssues = [
    identityEvidence(),
    { kind: 'uncertain_reading', field: 'valueText', prompt: 'Is this fictional result 12 or 13?' },
  ];
  upload(f, [envelope('editable result'), blocked, medication]);
  const original = feed(f);
  assert.deepEqual(original.kindCounts, {
    test: 2,
    prescription: 1,
    vision: 0,
    procedure: 0,
    history: 0,
    unsupported: 0,
    person: 0,
  });
  assert.equal(original.counts.pending, 3);
  assert.equal(original.counts.blocked, 1);
  const blockedRow = feedRows(original).find((row) => row.mapping.testLabel === 'blocked result')!;
  assert.equal(blockedRow.queueState, 'pending');
  assert.equal(blockedRow.selectable, false);
  const block = original.blocks[0]!,
    row = block.records[0]!;
  let item = intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, block.intakeId, {
    version: block.intakeVersion,
    proposalId: block.proposalId,
    operationId: 'fictional-subject-only',
    recordId: row.id,
    candidateVersionId: row.candidateVersionId!,
    mapping: { subject: 'self' },
  });
  assert.equal(feed(f, { edited: 'true' }).totalRecords, 0);
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, block.intakeId, {
    version: item.version,
    proposalId: block.proposalId,
    operationId: 'fictional-label-edit',
    recordId: row.id,
    candidateVersionId: row.candidateVersionId!,
    mapping: { testLabel: 'Reviewed fictional result' },
  });
  const edited = feed(f, { edited: 'true', q: 'REVIEWED FICTIONAL', kind: 'test' });
  assert.equal(edited.totalRecords, 1);
  assert.equal(feedRows(edited)[0]!.manuallyEdited, true);
  assert.equal(edited.counts.pending, 3, 'status counts remain global across filters');
  assert.equal(edited.kindCounts.test, 1);
  assert.equal(edited.kindCounts.prescription, 0);
  const onlyMedicine = feed(f, { kind: 'prescription' });
  assert.equal(onlyMedicine.totalRecords, 1);
  assert.equal(
    onlyMedicine.kindCounts.test,
    2,
    'kind counts are measured before the selected kind',
  );
});

test('global feed profile and filter boundaries reject foreign or repurposed cursors', async (t) => {
  const f = fixture(t);
  upload(f, [envelope('a'), envelope('b')]);
  const first = feed(f, { limit: 1 });
  for (const changed of [
    { view: 'all' },
    { q: 'a' },
    { kind: 'test' },
    { edited: 'true' },
    { state: 'pending' },
  ])
    assert.throws(() => feed(f, { ...changed, cursor: first.nextCursor }), {
      code: 'REPORT_QUEUE_CURSOR',
    });
  assert.throws(
    () => listIntakeImportFeed(f.db, f.root, 'foreign-profile', { cursor: first.nextCursor }),
    { code: 'REPORT_QUEUE_CURSOR' },
  );
  assert.throws(() => listIntakeImportFeed(f.db, f.root, 'foreign-profile'));
  for (const query of [
    'limit=101',
    'limit=0',
    'kind=foreign',
    'edited=yes',
    'q=' + 'a'.repeat(301),
  ])
    await assert.rejects(
      handleIntakeRoute({
        ...f,
        resource: 'intakes',
        id: 'import-feed',
        method: 'GET',
        params: new URLSearchParams(query),
        respond: (_value: unknown) => {},
      } as Parameters<typeof handleIntakeRoute>[0]),
    );
  let result: unknown;
  assert.equal(
    await handleIntakeRoute({
      ...f,
      resource: 'intakes',
      id: 'import-feed',
      method: 'GET',
      params: new URLSearchParams('limit=1'),
      respond: (value: unknown) => {
        result = value;
      },
    } as Parameters<typeof handleIntakeRoute>[0]),
    true,
  );
  assert.equal((result as ReturnType<typeof feed>).blocks[0]!.records.length, 1);
});

test('global feed discovers bounded People-only groups independently of clinical filters', (t) => {
  const f = fixture(t);
  for (const suffix of ['A', 'B']) {
    const value = envelope('fictional-person-' + suffix, 'Fictional people ' + suffix);
    delete value.clinical;
    value.payload = 'Dr Rowan Finch is the fictional clinician.';
    value.people = [
      {
        id: 'rowan-' + suffix,
        fullName: 'Rowan Finch',
        role: 'clinician',
        title: 'Dr Rowan Finch',
        evidence: [
          {
            textAnchor: 'Dr Rowan Finch is the fictional clinician.',
            supports: ['fullName', 'title'],
            locator: 'page 1',
          },
        ],
      },
    ];
    upload(f, [value], 'fictional-people-' + suffix + '.jsonl');
  }
  const first = feed(f, { limit: 1, kind: 'test', q: 'no clinical results', edited: 'true' });
  assert.equal(first.totalRecords, 0);
  assert.equal(first.kindCounts.person, 2);
  assert.equal(first.people.counts.pending, 2);
  assert.equal(first.people.groups.length, 1);
  assert.equal(first.people.totalGroups, 2);
  assert.ok(first.people.nextCursor);
  const next = feed(f, { limit: 1, peopleCursor: first.people.nextCursor });
  assert.equal(next.people.groups.length, 1);
  assert.notEqual(next.people.groups[0]!.groupId, first.people.groups[0]!.groupId);
  assert.equal(next.people.nextCursor, null);
  assert.throws(() => feed(f, { cursor: first.people.nextCursor }), {
    code: 'REPORT_QUEUE_CURSOR',
  });
});

test('feed cross-group acceptance preserves literal values, rejects stale snapshots and counts only selected ready versions', (t) => {
  const f = fixture(t);
  const blocked = envelope('blocked remaining', 'Report B');
  blocked.reviewIssues = [
    identityEvidence(),
    { kind: 'uncertain_reading', field: 'valueText', prompt: 'Is this fictional result 12 or 13?' },
  ];
  upload(f, [envelope('accept A', 'Report A'), envelope('accept B', 'Report B'), blocked]);
  const current = feed(f);
  const grouped = new Map<
    string,
    {
      intakeId: string;
      proposalId: string | null;
      intakeVersion: number;
      reviewToken: string;
      selections: {
        recordId: string;
        candidateId: string;
        candidateVersionId: string;
        mapping: {};
      }[];
    }
  >();
  for (const block of current.blocks) {
    const key = JSON.stringify([block.intakeId, block.proposalId]);
    const combined = grouped.get(key) || { ...block, selections: [] };
    for (const row of block.records.filter((row) => row.selectable))
      combined.selections.push({
        recordId: row.id,
        candidateId: row.candidateId!,
        candidateVersionId: row.candidateVersionId!,
        mapping: {},
      });
    grouped.set(key, combined);
  }
  const result = acceptIntakeReportSelection(f.db, f.root, f.profileId, {
    operationId: randomUUID(),
    blocks: [...grouped.values()],
  });
  assert.equal(result.receipt.selectedCount, 2);
  assert.equal(feed(f).counts.accepted, 2);
  assert.equal(feed(f).counts.pending, 1);
  assert.equal(feed(f).counts.blocked, 1);
  assert.deepEqual(
    f.db
      .prepare('SELECT value_text FROM observations')
      .all()
      .map((row) => row.value_text),
    ['+12.00', '+12.00'],
  );
  assert.throws(() =>
    acceptIntakeReportSelection(f.db, f.root, f.profileId, {
      operationId: randomUUID(),
      blocks: [...grouped.values()],
    }),
  );
  assert.equal(feed(f, { view: 'all' }).totalRecords, 3);
  assert.equal(feed(f, { view: 'all', state: 'accepted', limit: 1 }).totalRecords, 2);
  assert.equal(feed(f, { view: 'all', state: 'accepted' }).kindCounts.test, 2);
});

test('informational repeated subject notes remain evidence without creating feed blockers or question counts', (t) => {
  const f = fixture(t);
  const value = envelope('subject-note');
  value.uncertainties = ['The patient name is repeated in each report section.'];
  value.reviewIssues = [
    identityEvidence(),
    { kind: 'information', prompt: 'The printed patient header is repeated for context.' },
  ];
  upload(f, [value]);
  const result = feed(f),
    row = feedRows(result)[0]!;
  assert.equal(result.counts.questions, 0);
  assert.equal(result.counts.blocked, 0);
  assert.equal(row.selectable, true);
  assert.ok(row.issues?.some((issue) => issue.kind === 'information'));
  assert.ok(row.uncertainties.includes('The patient name is repeated in each report section.'));
});

test('a changed candidate has a new feed identity while retained original keys and literals remain in history', (t) => {
  const f = fixture(t);
  const value = envelope('changed');
  const item = upload(f, [value, envelope('independent')]);
  const before = feed(f),
    old = feedRows(before)[0]!;
  intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    jsonlText: JSON.stringify({
      ...value,
      payload: { literal: '+13.00' },
      clinical: {
        kind: 'observation',
        subject: 'self',
        testLabel: 'changed',
        valueText: '+13.00',
        date: '2026-09',
        unit: 'mg',
      },
    }),
    summary: 'Fictional revised reading',
  });
  const current = feed(f),
    history = feed(f, { view: 'all' });
  assert.equal(current.totalRecords, 2);
  assert.equal(current.counts.superseded, 1);
  const revised = feedRows(current).find((row) => row.mapping.testLabel === 'changed')!;
  assert.notEqual(revised.feedKey, old.feedKey);
  assert.equal(revised.mapping.valueText, '+13.00');
  const retained = feedRows(history).find((row) => row.feedKey === old.feedKey)!;
  assert.equal(retained.queueState, 'superseded');
  assert.equal(retained.mapping.valueText, '+12.00');
  assert.equal(retained.selectable, false);
  const staleBlock = before.blocks[0]!;
  assert.throws(() =>
    acceptIntakeReportSelection(f.db, f.root, f.profileId, {
      operationId: randomUUID(),
      blocks: [
        {
          intakeId: staleBlock.intakeId,
          proposalId: staleBlock.proposalId,
          intakeVersion: staleBlock.intakeVersion,
          reviewToken: staleBlock.reviewToken,
          selections: [
            {
              recordId: old.id,
              candidateId: old.candidateId!,
              candidateVersionId: old.candidateVersionId!,
              mapping: {},
            },
          ],
        },
      ],
    }),
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
});

test('full unchanged draft snapshots and Later are not manual edits; changed values retain the badge after acceptance', (t) => {
  const f = fixture(t);
  upload(f, [envelope('full-snapshot')]);
  let current = feed(f),
    block = current.blocks[0]!,
    row = block.records[0]!;
  // useReviewDrafts persists the complete displayed mapping for ordinary disposition changes.
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, block.intakeId, {
    version: block.intakeVersion,
    proposalId: block.proposalId,
    operationId: 'fictional-full-later',
    recordId: row.id,
    candidateVersionId: row.candidateVersionId!,
    mapping: row.mapping,
    disposition: 'review_later',
    decision: { recordId: row.id, action: 'skip', mapping: row.mapping },
  });
  current = feed(f, { view: 'deferred' });
  block = current.blocks[0]!;
  row = block.records[0]!;
  assert.equal(row.manuallyEdited, false);
  assert.equal(feed(f, { view: 'deferred', edited: 'true' }).totalRecords, 0);
  const editedMapping = { ...row.mapping, valueText: '+12.50' };
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, block.intakeId, {
    version: block.intakeVersion,
    proposalId: block.proposalId,
    operationId: 'fictional-full-value-change',
    recordId: row.id,
    candidateVersionId: row.candidateVersionId!,
    mapping: editedMapping,
    disposition: 'pending',
    decision: { recordId: row.id, action: 'accept', mapping: editedMapping },
  });
  current = feed(f, { edited: 'true' });
  block = current.blocks[0]!;
  row = block.records[0]!;
  assert.equal(current.totalRecords, 1);
  assert.equal(row.manuallyEdited, true);
  acceptIntakeReportSelection(f.db, f.root, f.profileId, {
    operationId: randomUUID(),
    blocks: [
      {
        intakeId: block.intakeId,
        proposalId: block.proposalId,
        intakeVersion: block.intakeVersion,
        reviewToken: block.reviewToken,
        selections: [
          {
            recordId: row.id,
            candidateId: row.candidateId!,
            candidateVersionId: row.candidateVersionId!,
            mapping: row.mapping,
          },
        ],
      },
    ],
  });
  const accepted = feed(f, { view: 'all', state: 'accepted', edited: 'true' });
  assert.equal(accepted.totalRecords, 1);
  assert.equal(feedRows(accepted)[0]!.mapping.valueText, '+12.50');
  assert.equal(feedRows(accepted)[0]!.manuallyEdited, true);
});
