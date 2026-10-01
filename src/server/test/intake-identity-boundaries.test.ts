import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import { getIntakeIdentityReview, confirmIntakeIdentityScope } from '../intake-identity.ts';
import { acceptIntakeReportSelection } from '../intake-report-acceptance.ts';
import { listIntakeImportFeed } from '../intake-report-queue.ts';
import { createNote, getNote, saveNote } from '../notes.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';
import { canonicalIdentityName } from '../../shared/self-identity.ts';
import {
  assessIdentityPolicy,
  identityBoundaryRepairApplies,
  identityReceiptAppliesToCurrentBoundary,
} from '../intake-identity-policy.ts';

const heading = 'Fictional Alder report';
const patient = 'Iris Meadow';
const otherPatient = 'Rowan River';
const selfBirthDate = '1982-04-17';

test('another report cannot reuse a Self confirmation after its printed name uniquely names a different person', async (t) => {
  const secondHeading = 'Fictional Willow report';
  const f = fixture(
    t,
    `${heading}\nPatient: ${patient}\nFictional count 12.00\n${secondHeading}\nPatient: ${patient}\nFictional count 14.00`,
    'fictional-alder.txt',
  );
  const first = await f.identity();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    version: first.scope!.intakeVersion,
    operationId: randomUUID(),
    scope: first.scope!,
    outcome: 'this_is_me',
    attestation: 'confirmed_displayed_report_subject',
  });
  const self = getNote(f.db, 'person-note:self');
  saveNote(f.db, self.id, {
    version: self.version,
    person: { ...self.person, fullName: 'Fictional Other Self' },
  });
  createNote(f.db, {
    kind: 'person',
    title: patient,
    person: { fullName: patient, birthDate: selfBirthDate },
  });
  const own = await f.identity();
  assert.equal(own.status, 'prior_confirmation');
  assert.equal(own.blocking, false);
  const later = record();
  later.id = 'fictional-second-count';
  later.provenance.sourceRecordId = later.id;
  later.report!.key = 'willow';
  later.report!.title = secondHeading;
  later.report!.anchor = { locator: 'page 1 later heading', text: secondHeading };
  const current = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  const proposed = intake.proposeConversion(f.db, f.root, f.profileId, f.item.id, {
    version: current.version,
    summary: 'Independently fictional later observation',
    jsonlText: JSON.stringify(later),
  });
  const group = proposed.workflow!.reportGroups!.find(
    (candidate) => candidate.report?.anchor?.text === secondHeading,
  )!;
  const second = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
  assert.equal(second.status, 'confirmation_required');
  assert.equal(second.blocking, true);
  const pending = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals.at(-1)!.id,
  );
  assert.equal(pending.records[0]!.identityReview?.blocking, true);
});

function record(subject = patient): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id: 'fictional-count',
    kind: 'record',
    payload: { literal: '12.00' },
    provenance: {
      capturedVia: null,
      sourceSystem: 'Fictional Alder Clinic',
      sourceRecordId: 'fictional-count',
      evidenceClass: 'provider_export',
      locator: 'page 1 count',
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'observation',
      subject: 'unknown',
      testLabel: 'Fictional count',
      valueText: '12.00',
      unit: 'mg',
      date: '2026-03-02',
    },
    report: {
      key: 'alder',
      title: 'Fictional Alder report',
      anchor: { locator: 'page 1 heading', text: heading },
      subject: { locator: 'page 1 patient', text: subject },
    },
  };
}

function fixture(
  t: TestContext,
  original: string,
  filename: string,
  self: { fullName?: string; birthDate?: string } = {
    fullName: patient,
    birthDate: selfBirthDate,
  },
) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-identity-boundaries-'));
  const profileId = 'fictional-alder';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const existingSelf = getNote(db, 'person-note:self');
  saveNote(db, existingSelf.id, {
    version: existingSelf.version,
    person: { ...existingSelf.person, ...self },
  });
  const item = intake.uploadIntake(db, root, profileId, {
    filename,
    bytes: Buffer.from(original),
    newProviderName: 'Fictional Alder Clinic',
  });
  const proposed = intake.proposeConversion(db, root, profileId, item.id, {
    version: item.version,
    summary: 'Independently fictional observation',
    jsonlText: JSON.stringify(record()),
  });
  const proposalId = proposed.proposals[0]!.id;
  const groupId = proposed.workflow!.reportGroups![0]!.id;
  const identity = () => getIntakeIdentityReview(db, root, profileId, item.id, groupId);
  const clinical = () => intake.reviewIntake(db, root, profileId, item.id, proposalId);
  const individual = () => {
    const review = clinical();
    return intake.importIntake(db, root, profileId, item.id, {
      version: review.version,
      proposalId,
      reviewToken: review.reviewToken,
      decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
    });
  };
  const bulk = () => {
    const review = clinical();
    const selected = review.records[0]!;
    return acceptIntakeReportSelection(db, root, profileId, {
      operationId: randomUUID(),
      blocks: [
        {
          intakeId: item.id,
          proposalId,
          intakeVersion: review.version,
          reviewToken: review.reviewToken,
          selections: [
            {
              recordId: selected.id,
              candidateId: selected.candidateId!,
              candidateVersionId: selected.candidateVersionId!,
              mapping: selected.mapping,
            },
          ],
        },
      ],
    });
  };
  const acceptedCount = () => Number(db.prepare('SELECT count(*) AS n FROM observations').get()!.n);
  return { db, root, profileId, item, identity, clinical, individual, bulk, acceptedCount };
}

function addReport(
  f: ReturnType<typeof fixture>,
  reportHeading: string,
  id: string,
  issue?: string,
) {
  const later = record();
  later.id = id;
  later.provenance.sourceRecordId = id;
  later.report!.key = id;
  later.report!.title = reportHeading;
  later.report!.anchor = { locator: `${id} heading`, text: reportHeading };
  if (issue)
    later.reviewIssues = [
      { kind: 'identity', field: 'subject', prompt: issue, textAnchor: patient },
    ];
  const current = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  const proposed = intake.proposeConversion(f.db, f.root, f.profileId, f.item.id, {
    version: current.version,
    summary: 'Independently fictional later observation',
    jsonlText: JSON.stringify(later),
  });
  return {
    group: proposed.workflow!.reportGroups!.find(
      (candidate) => candidate.report?.anchor?.text === reportHeading,
    )!,
    proposalId: proposed.proposals.at(-1)!.id,
  };
}

function blockedReportPaths(f: ReturnType<typeof fixture>, groupId: string, proposalId: string) {
  const clinical = () => intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposalId);
  const review = clinical();
  assert.equal(review.records[0]!.identityReview?.blocking, true);
  const feed = listIntakeImportFeed(f.db, f.root, f.profileId);
  const feedRecord = feed.blocks
    .flatMap((block) => block.records)
    .find((candidate) => candidate.id === review.records[0]!.id);
  assert.ok(feedRecord);
  assert.equal(feedRecord.selectable, false);
  assert.equal(feedRecord.identityReview?.blocking, true);
  const individual = () => {
    const current = clinical();
    intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
      version: current.version,
      proposalId,
      reviewToken: current.reviewToken,
      decisions: [{ recordId: current.records[0]!.id, action: 'accept', mapping: {} }],
    });
  };
  const bulk = () => {
    const current = clinical();
    const selected = current.records[0]!;
    acceptIntakeReportSelection(f.db, f.root, f.profileId, {
      operationId: randomUUID(),
      blocks: [
        {
          intakeId: f.item.id,
          proposalId,
          intakeVersion: current.version,
          reviewToken: current.reviewToken,
          selections: [
            {
              recordId: selected.id,
              candidateId: selected.candidateId!,
              candidateVersionId: selected.candidateVersionId!,
              mapping: selected.mapping,
            },
          ],
        },
      ],
    });
  };
  assert.throws(individual);
  assert.throws(bulk);
  assert.equal(f.acceptedCount(), 0, `${groupId} must make no clinical writes`);
}

for (const modelQuestion of [false, true])
  test(`ADV5: a Self receipt cannot answer another report after its alias makes two owners match (${modelQuestion ? 'routine question' : 'no question'})`, async (t) => {
    const secondHeading = 'Fictional Willow report';
    const thirdHeading = 'Fictional Cedar report';
    const f = fixture(
      t,
      `${heading}\n${patient}   Female   4/17/1982\nFictional count 12.00\n${secondHeading}\n${patient}   Female   4/17/1970\nFictional count 14.00\n${thirdHeading}\n${patient}   Female   4/17/1960\nFictional count 16.00`,
      'fictional-alder.txt',
      { fullName: otherPatient, birthDate: selfBirthDate },
    );
    const person = createNote(f.db, {
      kind: 'person',
      title: patient,
      person: { fullName: patient, birthDate: selfBirthDate },
    });
    const later = record();
    later.id = 'fictional-second-count';
    later.provenance.sourceRecordId = later.id;
    later.report!.key = 'willow';
    later.report!.title = secondHeading;
    later.report!.anchor = { locator: 'page 1 later heading', text: secondHeading };
    if (modelQuestion)
      later.reviewIssues = [
        {
          kind: 'identity',
          field: 'subject',
          prompt: 'Does this report belong to you or another person?',
          textAnchor: `${patient}   Female   4/17/1970`,
        },
      ];
    const current = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
    const proposed = intake.proposeConversion(f.db, f.root, f.profileId, f.item.id, {
      version: current.version,
      summary: 'Independently fictional later observation',
      jsonlText: JSON.stringify(later),
    });
    const group = proposed.workflow!.reportGroups!.find(
      (candidate) => candidate.report?.anchor?.text === secondHeading,
    )!;
    const before = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
    assert.equal(before.blocking, true);
    const a = await f.identity();
    await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
      version: a.scope!.intakeVersion,
      operationId: randomUUID(),
      scope: a.scope!,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_report_subject',
    });
    const after = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
    assert.deepEqual(getNote(f.db, 'person-note:self').person.knownNames, [patient]);
    const policy = assessIdentityPolicy({
      self: { ...after.self, knownNames: [patient] },
      people: [
        {
          noteId: person.id,
          personId: person.personId!,
          version: person.version,
          fullName: patient,
          knownNames: [],
          birthDate: selfBirthDate,
        },
      ],
      evidence: after.evidencedIdentity,
      group,
      groupVersionId: after.scope!.groupVersionId,
      originalFingerprint: after.scope!.evidenceOriginalFingerprint || '',
      receipts: [
        intake.getIntake(f.db, f.root, f.profileId, f.item.id).workflow!.identityConfirmations![0]!,
      ],
      nameEvidenceGrounded: true,
      originalEvidenceChecked: true,
      bannerBirthDates: [['1970-04-17']],
    });
    assert.equal(policy.status, 'confirmation_required');
    const aliasAbsent = assessIdentityPolicy({
      self: { ...after.self, knownNames: [] },
      people: [
        {
          noteId: person.id,
          personId: person.personId!,
          version: person.version,
          fullName: patient,
          knownNames: [],
          birthDate: selfBirthDate,
        },
      ],
      evidence: after.evidencedIdentity,
      group,
      groupVersionId: after.scope!.groupVersionId,
      originalFingerprint: after.scope!.evidenceOriginalFingerprint || '',
      receipts: [
        intake.getIntake(f.db, f.root, f.profileId, f.item.id).workflow!.identityConfirmations![0]!,
      ],
      bannerBirthDates: [['1970-04-17']],
    });
    assert.equal(
      aliasAbsent.status,
      'confirmation_required',
      'a borrowed Self answer cannot apply after the matched owner changes, even without its alias',
    );
    const receipt = intake.getIntake(f.db, f.root, f.profileId, f.item.id).workflow!
      .identityConfirmations![0]!;
    const assignedOwnerGate = (self: typeof after.self, bannerBirthDates: string[][]) =>
      assessIdentityPolicy({
        self,
        people: [
          {
            noteId: person.id,
            personId: person.personId!,
            version: person.version,
            fullName: patient,
            knownNames: [],
            birthDate: selfBirthDate,
          },
        ],
        evidence: after.evidencedIdentity,
        group,
        groupVersionId: after.scope!.groupVersionId,
        originalFingerprint: after.scope!.evidenceOriginalFingerprint || '',
        receipts: [receipt],
        bannerBirthDates,
      });
    assert.equal(
      assignedOwnerGate({ ...after.self, challengedNames: [patient] }, [['1970-04-17']]).status,
      'confirmation_required',
      'a challenged alias cannot make the borrowed receipt answer B',
    );
    assert.equal(
      assignedOwnerGate(
        { ...after.self, futureNameOwners: [{ name: patient, personId: 'patient' }] },
        [['1970-04-17']],
      ).status,
      'confirmation_required',
      'a reviewed future owner does not override B’s incompatible banner',
    );
    assert.equal(
      assignedOwnerGate(
        { ...after.self, futureNameOwners: [{ name: patient, personId: 'patient' }] },
        [['1982-04-17']],
      ).status,
      'prior_confirmation',
      'a reviewed future Self owner permits compatible reuse',
    );
    assert.equal(after.status, 'confirmation_required');
    assert.equal(after.blocking, true);
    blockedReportPaths(f, group.id, proposed.proposals.at(-1)!.id);
    await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
      version: after.scope!.intakeVersion,
      operationId: randomUUID(),
      scope: after.scope!,
      outcome: 'this_is_me',
      attestation: after.scope!.questions?.length
        ? 'confirmed_displayed_identity_questions'
        : 'confirmed_displayed_report_subject',
    });
    const own = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
    assert.equal(own.blocking, false, own.message);
    assert.equal(getNote(f.db, 'person-note:self').person.birthDate, selfBirthDate);
    const third = addReport(f, thirdHeading, 'fictional-third-count');
    const c = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, third.group.id);
    assert.equal(c.status, 'confirmation_required', 'B’s own receipt cannot answer C');
    blockedReportPaths(f, third.group.id, third.proposalId);
    const self = getNote(f.db, 'person-note:self');
    saveNote(f.db, self.id, {
      version: self.version,
      person: { ...self.person, birthDate: '1990-04-17' },
    });
    const edited = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
    assert.equal(
      edited.status,
      'prior_confirmation',
      'B’s own answer survives a later saved DOB edit',
    );
    const clinical = intake.reviewIntake(
      f.db,
      f.root,
      f.profileId,
      f.item.id,
      proposed.proposals.at(-1)!.id,
    );
    const selected = clinical.records[0]!;
    intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
      version: clinical.version,
      proposalId: proposed.proposals.at(-1)!.id,
      reviewToken: clinical.reviewToken,
      decisions: [{ recordId: selected.id, action: 'accept', mapping: {} }],
    });
    assert.equal(f.acceptedCount(), 1);
    assert.equal(f.db.prepare('SELECT person_id FROM observations').get()!.person_id, 'patient');
  });

test('a same-named Person keeps another report from borrowing the Self receipt without a banner', async (t) => {
  const secondHeading = 'Fictional Willow report';
  const f = fixture(
    t,
    `${heading}\nPatient: ${patient}\nFictional count 12.00\n${secondHeading}\nPatient: ${patient}\nFictional count 14.00`,
    'fictional-alder.txt',
  );
  createNote(f.db, { kind: 'person', title: patient, person: { fullName: patient } });
  const later = record();
  later.id = 'fictional-second-count';
  later.provenance.sourceRecordId = later.id;
  later.report!.key = 'willow';
  later.report!.title = secondHeading;
  later.report!.anchor = { locator: 'page 1 later heading', text: secondHeading };
  const current = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  const proposed = intake.proposeConversion(f.db, f.root, f.profileId, f.item.id, {
    version: current.version,
    summary: 'Independently fictional later observation',
    jsonlText: JSON.stringify(later),
  });
  const group = proposed.workflow!.reportGroups!.find(
    (candidate) => candidate.report?.anchor?.text === secondHeading,
  )!;
  const a = await f.identity();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    version: a.scope!.intakeVersion,
    operationId: randomUUID(),
    scope: a.scope!,
    outcome: 'this_is_me',
    attestation: 'confirmed_displayed_report_subject',
  });
  const after = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
  const receipt = intake.getIntake(f.db, f.root, f.profileId, f.item.id).workflow!
    .identityConfirmations![0]!;
  // The policy itself must reject reuse even without a separately raised model
  // issue. The concrete feed currently raises the same-name issue independently.
  const policy = assessIdentityPolicy({
    self: after.self,
    people: [
      {
        noteId: 'fictional-family-note',
        personId: 'fictional-family',
        version: 1,
        fullName: patient,
        knownNames: [],
        birthDate: null,
      },
    ],
    evidence: after.evidencedIdentity,
    group,
    groupVersionId: after.scope!.groupVersionId,
    originalFingerprint: after.scope!.evidenceOriginalFingerprint || '',
    receipts: [receipt],
    nameEvidenceGrounded: true,
    originalEvidenceChecked: true,
  });
  assert.equal(policy.status, 'confirmation_required');
  assert.match(policy.message, /more than one person/);
  assert.equal(after.status, 'confirmation_required');
  assert.equal(after.blocking, true);
  blockedReportPaths(f, group.id, proposed.proposals.at(-1)!.id);
});

test('a stale Self receipt cannot waive a new banner clue on a changed report version', async (t) => {
  const f = fixture(
    t,
    `${heading}\nPatient: ${patient}\nFictional count 12.00`,
    'fictional-changed-banner.txt',
  );
  const a = await f.identity();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    version: a.scope!.intakeVersion,
    operationId: randomUUID(),
    scope: a.scope!,
    outcome: 'this_is_me',
    attestation: a.scope!.questions?.length
      ? 'confirmed_displayed_identity_questions'
      : 'confirmed_displayed_report_subject',
  });
  const own = await f.identity();
  assert.equal(own.status, 'prior_confirmation');
  const workflow = intake.getIntake(f.db, f.root, f.profileId, f.item.id).workflow!;
  const changed = assessIdentityPolicy({
    self: own.self,
    people: [],
    evidence: own.evidencedIdentity,
    group: workflow.reportGroups![0]!,
    groupVersionId: `${own.scope!.groupVersionId}-changed-members`,
    originalFingerprint: own.scope!.evidenceOriginalFingerprint || '',
    receipts: workflow.identityConfirmations,
    nameEvidenceGrounded: true,
    originalEvidenceChecked: true,
    bannerBirthDates: [['1970-04-17']],
  });
  assert.equal(changed.status, 'confirmation_required');
  assert.equal(changed.blocking, true);
  const staleScope = {
    self: own.self,
    people: [],
    evidence: own.evidencedIdentity,
    group: workflow.reportGroups![0]!,
    groupVersionId: `${own.scope!.groupVersionId}-changed-members`,
    originalFingerprint: own.scope!.evidenceOriginalFingerprint || '',
    receipts: workflow.identityConfirmations,
    nameEvidenceGrounded: true,
    originalEvidenceChecked: true,
    explicitlyConfirmedOperationId: workflow.identityConfirmations![0]!.operationId,
  };
  for (const clue of [
    { bannerBirthDates: [['1970-04-17']] },
    { unreadableBirthDate: true },
    {
      people: [
        {
          noteId: 'fictional-peer',
          personId: 'fictional-peer',
          version: 1,
          fullName: patient,
          knownNames: [],
          birthDate: selfBirthDate,
        },
      ],
    },
  ]) {
    const explicit = assessIdentityPolicy({ ...staleScope, ...clue });
    assert.equal(
      explicit.blocking,
      true,
      'An old explicit operation cannot waive current competing identity evidence',
    );
    assert.notEqual(explicit.status, 'prior_confirmation');
  }
  const compatible = assessIdentityPolicy({ ...staleScope, bannerBirthDates: [[selfBirthDate]] });
  assert.equal(
    compatible.status,
    'prior_confirmation',
    'Compatible membership growth can reuse the report assignment',
  );
  assert.equal(compatible.blocking, false);
  const changedOwner = {
    ...staleScope,
    self: { ...own.self, fullName: otherPatient, knownNames: [] },
    people: [
      {
        noteId: 'fictional-peer',
        personId: 'fictional-peer',
        version: 1,
        fullName: patient,
        knownNames: [],
        birthDate: selfBirthDate,
      },
    ],
  };
  for (const operationId of [undefined, staleScope.explicitlyConfirmedOperationId]) {
    const staleOwner = assessIdentityPolicy({
      ...changedOwner,
      explicitlyConfirmedOperationId: operationId,
    });
    assert.equal(
      staleOwner.blocking,
      true,
      'Changed-version assignment must recheck the currently matched owner',
    );
    const unchangedOwner = assessIdentityPolicy({
      ...changedOwner,
      groupVersionId: own.scope!.groupVersionId,
      explicitlyConfirmedOperationId: operationId,
    });
    assert.equal(
      unchangedOwner.blocking,
      false,
      'The unchanged report keeps its own explicit assignment',
    );
  }
});

for (const banner of [false, true])
  for (const confirmedOwner of ['Self', 'Person'] as const)
    for (const suffix of ['Jr.', 'Jr', 'II', 'III.', 'IV', ', II.', ', III.', ', IV.'] as const)
      test(`suffix-only family names ask again after A is confirmed as ${confirmedOwner} (${banner ? 'banner' : 'no banner'}, ${suffix})`, async (t) => {
        const secondHeading = 'Fictional Willow report';
        const printed = (date: string) =>
          banner ? `${patient}   Female   ${date}` : `Patient: ${patient}`;
        const f = fixture(
          t,
          `${heading}\n${printed('4/17/1982')}\nFictional count 12.00\n${secondHeading}\n${printed('4/17/1970')}\nFictional count 14.00`,
          'fictional-family-suffixes.txt',
          {
            fullName: confirmedOwner === 'Self' ? `${patient} Sr.` : otherPatient,
            birthDate: selfBirthDate,
          },
        );
        const senior =
          confirmedOwner === 'Person'
            ? createNote(f.db, {
                kind: 'person',
                title: `${patient} Sr.`,
                person: { fullName: `${patient} Sr.`, birthDate: selfBirthDate },
              })
            : null;
        const junior = createNote(f.db, {
          kind: 'person',
          title: `${patient} ${suffix}`,
          person: { fullName: `${patient} ${suffix}`, birthDate: '1970-04-17' },
        });
        const b = addReport(f, secondHeading, 'fictional-junior-count');
        const a = await f.identity();
        await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
          version: a.scope!.intakeVersion,
          operationId: randomUUID(),
          scope: a.scope!,
          outcome: confirmedOwner === 'Self' ? 'this_is_me' : 'this_is_person',
          attestation: a.scope!.questions?.length
            ? 'confirmed_displayed_identity_questions'
            : 'confirmed_displayed_report_subject',
          ...(senior
            ? { personSelection: { noteId: senior.id, expectedVersion: senior.version } }
            : {}),
        });
        const aAfter = await f.identity();
        assert.equal(aAfter.blocking, false, 'A keeps its own confirmation');
        const aReceipt = intake.getIntake(f.db, f.root, f.profileId, f.item.id).workflow!
          .identityConfirmations![0]!;
        const aGroup = intake
          .getIntake(f.db, f.root, f.profileId, f.item.id)
          .workflow!.reportGroups!.find((candidate) => candidate.id === a.scope!.groupId)!;
        const changedA = assessIdentityPolicy({
          self: aAfter.self,
          people: [senior, junior]
            .filter((saved) => saved !== null)
            .map((saved) => ({
              noteId: saved.id,
              personId: saved.personId!,
              version: saved.version,
              fullName: saved.person.fullName!,
              knownNames: saved.person.knownNames ?? [],
              birthDate: saved.person.birthDate ?? null,
            })),
          evidence: aAfter.evidencedIdentity,
          group: aGroup,
          groupVersionId: `${aAfter.scope!.groupVersionId}-changed-members`,
          originalFingerprint: aAfter.scope!.evidenceOriginalFingerprint || '',
          receipts: [aReceipt],
          nameEvidenceGrounded: true,
          originalEvidenceChecked: true,
        });
        assert.equal(
          changedA.blocking,
          true,
          'a stale Self or Person receipt cannot answer a changed report version',
        );
        const review = await getIntakeIdentityReview(
          f.db,
          f.root,
          f.profileId,
          f.item.id,
          b.group.id,
        );
        assert.equal(review.status, 'confirmation_required');
        assert.equal(review.blocking, true);
        if (confirmedOwner === 'Self') {
          const explicitlyBorrowed = assessIdentityPolicy({
            self: review.self,
            people: [junior].map((saved) => ({
              noteId: saved.id,
              personId: saved.personId!,
              version: saved.version,
              fullName: saved.person.fullName!,
              knownNames: saved.person.knownNames ?? [],
              birthDate: saved.person.birthDate ?? null,
            })),
            evidence: review.evidencedIdentity,
            group: b.group,
            groupVersionId: review.scope!.groupVersionId,
            originalFingerprint: review.scope!.evidenceOriginalFingerprint || '',
            receipts: [aReceipt],
            explicitlyConfirmedOperationId: aReceipt.operationId,
            nameEvidenceGrounded: true,
            originalEvidenceChecked: true,
          });
          assert.equal(explicitlyBorrowed.blocking, true);
        }
        blockedReportPaths(f, b.group.id, b.proposalId);
        await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
          version: review.scope!.intakeVersion,
          operationId: randomUUID(),
          scope: review.scope!,
          outcome: 'this_is_person',
          attestation: review.scope!.questions?.length
            ? 'confirmed_displayed_identity_questions'
            : 'confirmed_displayed_report_subject',
          personSelection: { noteId: junior.id, expectedVersion: junior.version },
        });
        const resolved = await getIntakeIdentityReview(
          f.db,
          f.root,
          f.profileId,
          f.item.id,
          b.group.id,
        );
        assert.equal(resolved.blocking, false, 'B keeps its own exact Person confirmation');
        const clinical = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, b.proposalId);
        assert.equal(clinical.records[0]!.mapping.personId, junior.personId);
      });

for (const banner of [false, true])
  for (const confirmedOwner of ['Self', 'Person'] as const)
    test(`same-name owners block report B without reusing A's ${confirmedOwner} answer (${banner ? 'banner' : 'no banner'})`, async (t) => {
      const secondHeading = 'Fictional Willow report';
      const header = (date: string) =>
        banner ? `${patient}   Female   ${date}` : `Patient: ${patient}`;
      const f = fixture(
        t,
        `${heading}\n${header('4/17/1982')}\nFictional count 12.00\n${secondHeading}\n${header('4/17/1970')}\nFictional count 14.00`,
        'fictional-alder.txt',
        { fullName: confirmedOwner === 'Self' ? patient : otherPatient, birthDate: selfBirthDate },
      );
      const person = createNote(f.db, {
        kind: 'person',
        title: patient,
        person: { fullName: patient, birthDate: selfBirthDate },
      });
      const b = addReport(f, secondHeading, 'fictional-second-count');
      const a = await f.identity();
      await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        version: a.scope!.intakeVersion,
        operationId: randomUUID(),
        scope: a.scope!,
        outcome: confirmedOwner === 'Self' ? 'this_is_me' : 'this_is_person',
        attestation: 'confirmed_displayed_report_subject',
        ...(confirmedOwner === 'Person'
          ? { personSelection: { noteId: person.id, expectedVersion: person.version } }
          : {}),
      });
      const second =
        confirmedOwner === 'Person'
          ? createNote(f.db, {
              kind: 'person',
              title: `Second ${patient}`,
              person: { fullName: patient, birthDate: selfBirthDate },
            })
          : null;
      const review = await getIntakeIdentityReview(
        f.db,
        f.root,
        f.profileId,
        f.item.id,
        b.group.id,
      );
      assert.equal(review.status, 'confirmation_required');
      assert.equal(review.blocking, true);
      if (second) {
        const borrowed = assessIdentityPolicy({
          self: review.self,
          people: [person, second].map((saved) => ({
            noteId: saved.id,
            personId: saved.personId!,
            version: saved.version,
            fullName: patient,
            knownNames: [],
            birthDate: selfBirthDate,
          })),
          evidence: review.evidencedIdentity,
          group: b.group,
          groupVersionId: review.scope!.groupVersionId,
          originalFingerprint: review.scope!.evidenceOriginalFingerprint || '',
          receipts: intake.getIntake(f.db, f.root, f.profileId, f.item.id).workflow!
            .identityConfirmations,
        });
        assert.equal(borrowed.blocking, true);
        assert.match(borrowed.message, /more than one person/);
      }
      blockedReportPaths(f, b.group.id, b.proposalId);
      if (second) {
        // B's own exact Person receipt answers B; A's receipt cannot choose
        // between the same-named people, even when they share a birth date.
        await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
          version: review.scope!.intakeVersion,
          operationId: randomUUID(),
          scope: review.scope!,
          outcome: 'this_is_person',
          attestation: review.scope!.questions?.length
            ? 'confirmed_displayed_identity_questions'
            : 'confirmed_displayed_report_subject',
          personSelection: { noteId: second.id, expectedVersion: second.version },
        });
        const own = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, b.group.id);
        assert.equal(own.blocking, false, own.message);
        const ownReceipt = intake
          .getIntake(f.db, f.root, f.profileId, f.item.id)
          .workflow!.identityConfirmations!.at(-1)!;
        const direct = assessIdentityPolicy({
          self: own.self,
          people: [person, second].map((saved) => ({
            noteId: saved.id,
            personId: saved.personId!,
            version: saved.version,
            fullName: patient,
            knownNames: [],
            birthDate: selfBirthDate,
          })),
          evidence: own.evidencedIdentity,
          group: b.group,
          groupVersionId: own.scope!.groupVersionId,
          originalFingerprint: own.scope!.evidenceOriginalFingerprint || '',
          receipts: [ownReceipt],
          bannerBirthDates: banner ? [['1970-04-17']] : [],
        });
        assert.equal(direct.blocking, false, 'the shared policy must honor B’s own Person choice');
        const personWithDifferentDate = {
          ...ownReceipt,
          identityAnswers: { birthDate: '1970-04-17' },
        };
        const repairedPerson = assessIdentityPolicy({
          self: own.self,
          people: [person, second].map((saved) => ({
            noteId: saved.id,
            personId: saved.personId!,
            version: saved.version,
            fullName: patient,
            knownNames: [],
            birthDate: saved.id === second.id ? '1970-04-17' : selfBirthDate,
          })),
          evidence: own.evidencedIdentity,
          group: b.group,
          groupVersionId: own.scope!.groupVersionId,
          originalFingerprint: own.scope!.evidenceOriginalFingerprint || '',
          receipts: [personWithDifferentDate],
          explicitlyConfirmedOperationId: ownReceipt.operationId,
        });
        assert.equal(
          repairedPerson.blocking,
          false,
          'an exact Person repair must not compare DOB to Self',
        );
        assert.equal(repairedPerson.attribution?.assignedPerson?.personId, second.personId);
        const staleVersion = assessIdentityPolicy({
          self: own.self,
          people: [person, second].map((saved) => ({
            noteId: saved.id,
            personId: saved.personId!,
            version: saved.version,
            fullName: patient,
            knownNames: [],
            birthDate: selfBirthDate,
          })),
          evidence: own.evidencedIdentity,
          group: b.group,
          groupVersionId: `${own.scope!.groupVersionId}-changed-members`,
          originalFingerprint: own.scope!.evidenceOriginalFingerprint || '',
          receipts: [ownReceipt],
        });
        assert.equal(staleVersion.blocking, true, 'a changed report version needs its own review');
        const staleExplicitPerson = assessIdentityPolicy({
          self: own.self,
          people: [person, second].map((saved) => ({
            noteId: saved.id,
            personId: saved.personId!,
            version: saved.version,
            fullName: patient,
            knownNames: [],
            birthDate: saved.id === second.id ? '1970-04-17' : selfBirthDate,
          })),
          evidence: own.evidencedIdentity,
          group: b.group,
          groupVersionId: `${own.scope!.groupVersionId}-changed-members`,
          originalFingerprint: own.scope!.evidenceOriginalFingerprint || '',
          receipts: [personWithDifferentDate],
          explicitlyConfirmedOperationId: ownReceipt.operationId,
        });
        assert.equal(staleExplicitPerson.status, 'confirmation_required');
        assert.equal(staleExplicitPerson.attribution, undefined);
        const labelledConflict = assessIdentityPolicy({
          self: own.self,
          people: [person, second].map((saved) => ({
            noteId: saved.id,
            personId: saved.personId!,
            version: saved.version,
            fullName: patient,
            knownNames: [],
            birthDate: selfBirthDate,
          })),
          evidence: { ...own.evidencedIdentity, birthDate: '1970-04-17' },
          group: b.group,
          groupVersionId: own.scope!.groupVersionId,
          originalFingerprint: own.scope!.evidenceOriginalFingerprint || '',
          receipts: [ownReceipt],
        });
        assert.equal(
          labelledConflict.blocking,
          true,
          'own Person choice cannot waive a verified DOB conflict',
        );
        const clinical = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, b.proposalId);
        assert.equal(clinical.records[0]!.identityReview?.blocking, false);
        assert.equal(clinical.records[0]!.mapping.personId, second.personId);
      }
    });

test('a competing-subject Person repair stays assigned to that Person when Self has another birth date', async (t) => {
  const f = fixture(
    t,
    `${heading}\nPatient: ${otherPatient}\nDOB: 1970-04-17\nDOB: 1982-04-17\nFictional count 12.00`,
    'fictional-competing-people.txt',
  );
  const other = createNote(f.db, {
    kind: 'person',
    title: otherPatient,
    person: { fullName: otherPatient, birthDate: '1970-04-17' },
  });
  const second = record(otherPatient);
  second.id = 'fictional-competing-count';
  second.provenance.sourceRecordId = second.id;
  const current = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  const proposed = intake.proposeConversion(f.db, f.root, f.profileId, f.item.id, {
    version: current.version,
    summary: 'Independently fictional competing subject at one report heading',
    jsonlText: JSON.stringify(second),
  });
  const group = proposed.workflow!.reportGroups!.find(
    (candidate) => candidate.report?.subject?.text === otherPatient,
  )!;
  assert.ok(group);
  const before = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
  assert.ok(
    before.scope?.competingSubjects?.length,
    'a second subject shares this report boundary',
  );
  assert.ok(before.scope?.birthDateReview?.choices.includes('1970-04-17'));
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    version: before.scope!.intakeVersion,
    operationId: randomUUID(),
    scope: before.scope!,
    outcome: 'this_is_person',
    attestation: 'confirmed_displayed_identity_questions',
    ...(before.scope?.birthDateReview ? { identityAnswers: { birthDate: '1970-04-17' } } : {}),
    personSelection: { noteId: other.id, expectedVersion: other.version },
  });
  const after = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
  const workflow = intake.getIntake(f.db, f.root, f.profileId, f.item.id).workflow!;
  const receipt = workflow.identityConfirmations!.at(-1)!;
  assert.equal(receipt.identityAnswers?.birthDate, '1970-04-17');
  assert.equal(
    identityBoundaryRepairApplies(
      receipt,
      group,
      workflow.reportGroups!,
      after.scope!.assignmentTargets || after.scope!.targets,
    ),
    true,
  );
  assert.equal(
    identityReceiptAppliesToCurrentBoundary(receipt, {
      profileId: f.profileId,
      intakeId: f.item.id,
      groupId: group.id,
      groupVersionId: after.scope!.groupVersionId,
      sourceHash: after.scope!.sourceHash,
      memberId: after.scope!.memberId,
      original: after.scope!.original,
      report: after.scope!.report,
      subject: after.scope!.subject,
      verificationMode: after.scope!.verificationMode,
      evidencedIdentity: after.evidencedIdentity,
      evidenceOriginalFingerprint: after.scope!.evidenceOriginalFingerprint || null,
      membership: after.scope!.membership,
    }),
    true,
  );
  const repaired = assessIdentityPolicy({
    self: after.self,
    people: [
      {
        noteId: other.id,
        personId: other.personId!,
        version: other.version,
        fullName: otherPatient,
        knownNames: [],
        birthDate: '1970-04-17',
      },
    ],
    evidence: after.evidencedIdentity,
    group,
    groupVersionId: after.scope!.groupVersionId,
    originalFingerprint: after.scope!.evidenceOriginalFingerprint || '',
    receipts: [receipt],
    hasUnstructuredIdentityQuestion: true,
    explicitlyConfirmedOperationId: receipt.operationId,
  });
  assert.equal(repaired.status, 'prior_confirmation');
  assert.equal(repaired.attribution?.assignedPerson?.personId, other.personId);
  const unansweredNewIssue = assessIdentityPolicy({
    self: after.self,
    people: [
      {
        noteId: other.id,
        personId: other.personId!,
        version: other.version,
        fullName: otherPatient,
        knownNames: [],
        birthDate: '1970-04-17',
      },
    ],
    evidence: after.evidencedIdentity,
    group,
    groupVersionId: after.scope!.groupVersionId,
    originalFingerprint: after.scope!.evidenceOriginalFingerprint || '',
    receipts: [receipt],
    hasUnstructuredIdentityQuestion: true,
  });
  assert.equal(unansweredNewIssue.blocking, true);
  assert.equal(after.blocking, false, after.message);
  const clinical = intake.reviewIntake(
    f.db,
    f.root,
    f.profileId,
    f.item.id,
    proposed.proposals.at(-1)!.id,
  );
  assert.equal(clinical.records[0]!.identityReview?.blocking, false);
  assert.equal(clinical.records[0]!.mapping.personId, other.personId);
});

test('confirmation cannot cross an original even when the printed subject is unchanged', async (t) => {
  const f = fixture(
    t,
    `${heading}\nPatient: ${patient}\nFictional count 12.00`,
    'fictional-alder.txt',
  );
  createNote(f.db, { kind: 'person', title: patient, person: { fullName: patient } });
  const a = await f.identity();
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    version: a.scope!.intakeVersion,
    operationId: randomUUID(),
    scope: a.scope!,
    outcome: 'this_is_me',
    attestation: 'confirmed_displayed_report_subject',
  });
  const other = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-willow.txt',
    bytes: Buffer.from(`Fictional Willow report\nPatient: ${patient}\nFictional count 14.00`),
    newProviderName: 'Fictional Willow Clinic',
  });
  const later = record();
  later.id = 'fictional-other-original';
  later.provenance.sourceRecordId = later.id;
  later.report!.key = 'willow';
  later.report!.title = 'Fictional Willow report';
  later.report!.anchor = { locator: 'page 1 heading', text: 'Fictional Willow report' };
  const proposed = intake.proposeConversion(f.db, f.root, f.profileId, other.id, {
    version: other.version,
    summary: 'Fictional separate original',
    jsonlText: JSON.stringify(later),
  });
  const group = proposed.workflow!.reportGroups![0]!;
  const b = await getIntakeIdentityReview(f.db, f.root, f.profileId, other.id, group.id);
  assert.equal(b.status, 'confirmation_required');
  assert.equal(b.blocking, true);
  assert.deepEqual(proposed.workflow!.identityConfirmations || [], []);
  assert.equal(f.acceptedCount(), 0);
});

for (const label of ['DOB: 04/05/1982', 'DOB: 1970-04-17'])
  test(`A's receipt does not answer B's labelled ${label.includes('/') ? 'ambiguous' : 'conflicting'} date`, async (t) => {
    const secondHeading = 'Fictional Willow report';
    const f = fixture(
      t,
      `${heading}\nPatient: ${patient}\nFictional count 12.00\n${secondHeading}\nPatient: ${patient}\n${label}\nFictional count 14.00`,
      'fictional-alder.txt',
    );
    const b = addReport(f, secondHeading, 'fictional-second-count');
    const a = await f.identity();
    await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
      version: a.scope!.intakeVersion,
      operationId: randomUUID(),
      scope: a.scope!,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_report_subject',
    });
    const review = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, b.group.id);
    assert.equal(review.blocking, true);
    assert.notEqual(review.status, 'prior_confirmation');
    blockedReportPaths(f, b.group.id, b.proposalId);
  });

test('canonical identity names retain Jr., Sr., II and III rather than merging generations', () => {
  const names = ['Robin Lane Jr.', 'Robin Lane Sr.', 'Robin Lane II', 'Robin Lane III'];
  assert.equal(new Set(names.map(canonicalIdentityName)).size, names.length);
  assert.equal(
    canonicalIdentityName('Robin Lane Jr.'),
    canonicalIdentityName('  ROBIN   LANE JR. '),
  );
  assert.notEqual(
    canonicalIdentityName('Robin Lane, Jr.'),
    canonicalIdentityName('Robin Lane, Sr.'),
  );
});

// A caregiver can upload several people's reports together. Confirmation of A
// cannot answer B's discrepancy, even with the same name and retained original.
for (const family of [false, true])
  for (const modelQuestion of [false, true])
    test(`another report's ${family ? 'Person' : 'Self'} confirmation cannot answer a banner mismatch (${modelQuestion ? 'routine' : 'no'} question)`, async (t) => {
      const secondHeading = 'Fictional Willow report';
      const secondBanner = `${patient}   Female   4/17/1970`;
      const f = fixture(
        t,
        `${heading}\n${patient}   Female   4/17/1982\nFictional count 12.00\n${secondHeading}\n${secondBanner}\nFictional count 14.00`,
        'fictional-alder.txt',
        { fullName: family ? otherPatient : patient, birthDate: selfBirthDate },
      );
      const person = family
        ? createNote(f.db, {
            kind: 'person',
            title: patient,
            person: { fullName: patient, birthDate: selfBirthDate },
          })
        : undefined;
      const later = record();
      later.id = 'fictional-second-count';
      later.provenance.sourceRecordId = later.id;
      later.report!.key = 'willow';
      later.report!.title = secondHeading;
      later.report!.anchor = { locator: 'page 1 later heading', text: secondHeading };
      if (modelQuestion)
        later.reviewIssues = [
          {
            kind: 'identity',
            field: 'subject',
            prompt: 'Does this report belong to you or another person?',
            textAnchor: secondBanner,
          },
        ];
      const current = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
      const proposed = intake.proposeConversion(f.db, f.root, f.profileId, f.item.id, {
        version: current.version,
        summary: 'Independently fictional later observation',
        jsonlText: JSON.stringify(later),
      });
      const group = proposed.workflow!.reportGroups!.find(
        (candidate) => candidate.report?.anchor?.text === secondHeading,
      )!;
      const preview = () => getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
      const proposalId = proposed.proposals.at(-1)!.id;
      const clinical = () => intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposalId);
      const individual = () => {
        const review = clinical();
        return intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
          version: review.version,
          proposalId,
          reviewToken: review.reviewToken,
          decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
        });
      };
      const bulk = () => {
        const review = clinical();
        const selected = review.records[0]!;
        return acceptIntakeReportSelection(f.db, f.root, f.profileId, {
          operationId: randomUUID(),
          blocks: [
            {
              intakeId: f.item.id,
              proposalId,
              intakeVersion: review.version,
              reviewToken: review.reviewToken,
              selections: [
                {
                  recordId: selected.id,
                  candidateId: selected.candidateId!,
                  candidateVersionId: selected.candidateVersionId!,
                  mapping: {},
                },
              ],
            },
          ],
        });
      };
      const confirm = async (review: Awaited<ReturnType<typeof preview>>) => {
        const selected = person && getNote(f.db, person.id);
        return confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
          version: review.scope!.intakeVersion,
          operationId: randomUUID(),
          scope: review.scope!,
          outcome: selected ? 'this_is_person' : 'this_is_me',
          attestation: review.scope!.questions?.length
            ? 'confirmed_displayed_identity_questions'
            : 'confirmed_displayed_report_subject',
          ...(selected
            ? { personSelection: { noteId: selected.id, expectedVersion: selected.version } }
            : {}),
        });
      };
      assert.equal((await preview()).blocking, true);
      await confirm(await f.identity());
      const after = await preview();
      assert.equal(after.status, 'confirmation_required');
      assert.equal(after.blocking, true);
      assert.equal(after.evidencedIdentity.birthDate, undefined);
      assert.deepEqual(after.conflicts, []);
      assert.equal(clinical().records[0]!.identityReview?.blocking, true);
      const feed = listIntakeImportFeed(f.db, f.root, f.profileId);
      const feedRecord = feed.blocks
        .flatMap((block) => block.records)
        .find((candidate) => candidate.id === clinical().records[0]!.id);
      assert.ok(feedRecord);
      assert.equal(feedRecord.selectable, false);
      assert.throws(individual, {
        code: /^(?:QUESTIONS_PENDING|REVIEW_ISSUES_PENDING|IDENTITY_REVIEW_REQUIRED)$/,
      });
      assert.throws(bulk, {
        code: /^(?:QUESTIONS_PENDING|REVIEW_ISSUES_PENDING|IDENTITY_REVIEW_REQUIRED)$/,
      });
      assert.equal(f.acceptedCount(), 0);

      // B remains answerable: an explicit report decision resolves ownership
      // without claiming that its unlabelled column is the person's birth date.
      await confirm(after);
      assert.equal((await preview()).blocking, false);
      assert.equal(clinical().records[0]!.identityReview?.blocking, false);
      const receipts = intake.getIntake(f.db, f.root, f.profileId, f.item.id).workflow!
        .identityConfirmations!;
      assert.equal(receipts.length, 2);
      assert.equal(receipts[1]!.scope.groupId, group.id);
      assert.notEqual(receipts[0]!.scope.groupId, group.id);
      assert.equal(receipts[1]!.scope.evidencedIdentity?.birthDate, undefined);
      assert.equal(getNote(f.db, person?.id || 'person-note:self').person.birthDate, selfBirthDate);
      if (modelQuestion) bulk();
      else individual();
      assert.equal(f.acceptedCount(), 1);
      assert.equal(
        f.db.prepare('SELECT person_id FROM observations').get()!.person_id,
        person?.personId || 'patient',
      );
    });

for (const [label, original] of [
  [
    'nested patient DOB',
    JSON.stringify({
      reportTitle: heading,
      patient: { name: patient, dob: '1950-01-05' },
      result: 'Fictional count 12.00',
    }),
  ],
  [
    'patient DOB before name',
    JSON.stringify({
      reportTitle: heading,
      patient: { dob: '1950-01-05', name: patient },
      result: 'Fictional count 12.00',
    }),
  ],
  ...(['birthDate', 'birth_date', 'dateOfBirth', 'date_of_birth'] as const).map(
    (key) =>
      [
        `patient ${key}`,
        JSON.stringify({
          reportTitle: heading,
          patient: { name: patient, [key]: '1950-01-05' },
          result: 'Fictional count 12.00',
        }),
      ] as const,
  ),
  [
    'labelled patient DOB',
    JSON.stringify({
      reportTitle: heading,
      patient: `Patient: ${patient}\nDOB: 1950-01-05`,
      result: 'Fictional count 12.00',
    }),
  ],
] as const)
  test(`original JSON ${label} conflicts with Self through both acceptance paths`, async (t) => {
    const f = fixture(t, original, 'fictional-alder.json');
    const review = await f.identity();
    assert.equal(review.evidencedIdentity.birthDate, '1950-01-05');
    assert.equal(review.selfBirthDateConflict, true);
    assert.equal(review.blocking, true);
    assert.equal(f.clinical().records.length, 1, 'reading continues through identity review');
    assert.throws(f.individual);
    assert.throws(f.bulk);
    assert.equal(f.acceptedCount(), 0);
  });

for (const [label, original] of [
  [
    'nested guardian',
    JSON.stringify({
      reportTitle: heading,
      patient: { name: otherPatient, dob: '2010-01-05' },
      guardian: { name: patient, dob: selfBirthDate },
      result: 'Fictional count 12.00',
    }),
  ],
  [
    'nested policyholder',
    JSON.stringify({
      reportTitle: heading,
      patient: { name: otherPatient, dob: '2010-01-05' },
      policyholder: { name: patient, dob: selfBirthDate },
      result: 'Fictional count 12.00',
    }),
  ],
  [
    'flattened guardian camel keys',
    JSON.stringify({
      reportTitle: heading,
      patient: { name: otherPatient, dob: '2010-01-05' },
      guardianName: patient,
      guardianDOB: selfBirthDate,
      result: 'Fictional count 12.00',
    }),
  ],
  [
    'flattened guardian snake keys',
    JSON.stringify({
      reportTitle: heading,
      patient: { name: otherPatient, dob: '2010-01-05' },
      guardian_name: patient,
      guardian_dob: selfBirthDate,
      result: 'Fictional count 12.00',
    }),
  ],
  [
    'flattened subscriber camel keys',
    JSON.stringify({
      reportTitle: heading,
      patient: { name: otherPatient, dob: '2010-01-05' },
      subscriberName: patient,
      subscriberDOB: selfBirthDate,
      result: 'Fictional count 12.00',
    }),
  ],
  [
    'flattened subscriber snake keys',
    JSON.stringify({
      reportTitle: heading,
      patient: { name: otherPatient, dob: '2010-01-05' },
      subscriber_name: patient,
      subscriber_dob: selfBirthDate,
      result: 'Fictional count 12.00',
    }),
  ],
  ...(['caregiverName', 'nextOfKinName', 'familyMemberName'] as const).map(
    (key) =>
      [
        `flattened ${key}`,
        JSON.stringify({
          reportTitle: heading,
          patient: { name: otherPatient, dob: '2010-01-05' },
          [key]: patient,
          result: 'Fictional count 12.00',
        }),
      ] as const,
  ),
  [
    'unrelated physician object',
    JSON.stringify({
      reportTitle: heading,
      patient: { name: otherPatient, dob: '2010-01-05' },
      physician: { name: patient, dob: selfBirthDate },
      result: 'Fictional count 12.00',
    }),
  ],
  [
    'nested guardian metadata before name',
    JSON.stringify({
      reportTitle: heading,
      patient: { name: otherPatient, dob: '2010-01-05' },
      guardian: { address: { city: 'Fictional Orchard' }, name: patient, dob: selfBirthDate },
      result: 'Fictional count 12.00',
    }),
  ],
  [
    'guardian nested inside patient',
    JSON.stringify({
      reportTitle: heading,
      patient: {
        name: otherPatient,
        dob: '2010-01-05',
        guardian: { name: patient, dob: selfBirthDate },
      },
      result: 'Fictional count 12.00',
    }),
  ],
  [
    'multiline guardian',
    `${heading}\nPatient: ${otherPatient}\nGuardian:\n${patient}\nDOB: ${selfBirthDate}\nFictional count 12.00`,
  ],
  [
    'multiline policyholder',
    `${heading}\nPatient: ${otherPatient}\nPolicyholder:\n${patient}\nDOB: ${selfBirthDate}\nFictional count 12.00`,
  ],
  [
    'multiline neighboring patient',
    `${heading}\nPatient: ${otherPatient}\nDOB: 2010-01-05\nFictional second report\nPatient: ${patient}\nDOB: ${selfBirthDate}`,
  ],
  [
    'multiline neighboring patient after blank headers',
    `${heading}\nPatient:\n${otherPatient}\nDOB: 2010-01-05\nOther fictional test panel\nPatient:\n${patient}\nDOB: ${selfBirthDate}`,
  ],
] as const)
  test(`${label} cannot turn another person into this report's patient`, async (t) => {
    const f = fixture(
      t,
      original,
      label.startsWith('multiline') ? 'fictional-alder.txt' : 'fictional-alder.json',
    );
    const review = await f.identity();
    assert.notEqual(review.status, 'evidenced_match');
    assert.equal(review.blocking, true);
    assert.notEqual(review.evidencedIdentity.fullName, patient);
    assert.notEqual(review.evidencedIdentity.birthDate, selfBirthDate);
    assert.equal(f.clinical().records.length, 1, 'reading continues through identity review');
    assert.throws(f.individual);
    assert.throws(f.bulk);
    assert.equal(f.acceptedCount(), 0);
  });

for (const [label, original, filename] of [
  [
    'JSON',
    JSON.stringify({
      reportTitle: heading,
      patient: { name: patient, dob: selfBirthDate },
      result: 'Fictional count 12.00',
    }),
    'fictional-alder.json',
  ],
  [
    'text',
    `${heading}\nPatient: ${patient}\nDOB: ${selfBirthDate}\nFictional count 12.00`,
    'fictional-alder.txt',
  ],
  [
    'text with blank Patient header',
    `${heading}\nPatient:\n${patient}\nDOB: ${selfBirthDate}\nFictional count 12.00`,
    'fictional-alder.txt',
  ],
] as const)
  test(`true patient ${label} remains matchable and assignable`, async (t) => {
    const f = fixture(t, original, filename);
    const review = await f.identity();
    assert.equal(review.status, 'evidenced_match');
    assert.equal(review.blocking, false);
    assert.equal(review.evidencedIdentity.fullName, patient);
    assert.equal(review.evidencedIdentity.birthDate, selfBirthDate);
    const recordReview = f.clinical().records[0]!;
    assert.equal(recordReview.identityReview?.blocking, false);
    assert.equal(recordReview.mapping.subject, 'self');
    if (label === 'JSON') f.individual();
    else f.bulk();
    assert.equal(f.acceptedCount(), 1);
  });

for (const [label, ownBirthDate] of [
  ['name only', undefined],
  ['complete patient DOB', selfBirthDate],
] as const)
  test(`nested guardian DOB does not replace ${label} patient evidence`, async (t) => {
    const f = fixture(
      t,
      JSON.stringify({
        reportTitle: heading,
        patient: {
          name: patient,
          ...(ownBirthDate ? { dob: ownBirthDate } : {}),
          guardian: { name: otherPatient, dob: '1950-01-05' },
        },
        result: 'Fictional count 12.00',
      }),
      'fictional-alder.json',
    );
    const review = await f.identity();
    assert.equal(review.status, 'evidenced_match');
    assert.equal(review.blocking, false);
    assert.equal(review.evidencedIdentity.fullName, patient);
    assert.equal(review.evidencedIdentity.birthDate, ownBirthDate);
    assert.equal(f.clinical().records[0]!.mapping.subject, 'self');
    f.bulk();
    assert.equal(f.acceptedCount(), 1);
  });

test('a physician DOB does not become the printed patient DOB', async (t) => {
  const f = fixture(
    t,
    `${heading}\nPatient: ${patient}\nPhysician: ${otherPatient}\nDOB: 1950-01-05\nFictional count 12.00`,
    'fictional-alder.txt',
  );
  const review = await f.identity();
  assert.equal(review.status, 'evidenced_match');
  assert.equal(review.blocking, false);
  assert.equal(review.evidencedIdentity.fullName, patient);
  assert.equal(review.evidencedIdentity.birthDate, undefined);
  f.bulk();
  assert.equal(f.acceptedCount(), 1);
});

for (const [label, original, suggested] of [
  [
    'dated above heading',
    `Report date: 1926-01-02\n${heading}\nPatient: ${patient}\nDOB: 14-Feb-86\nFictional count 12.00`,
    '1886-02-14',
  ],
  [
    'undated beside a later report',
    `${heading}\nPatient: ${patient}\nDOB: 14-Feb-86\nFictional count 12.00\nFictional second report\nReport date: 1926-01-02\nPatient: ${otherPatient}`,
    '1986-02-14',
  ],
] as const)
  test(`two-digit DOB ${label} requires a human answer using its own report date`, async (t) => {
    const f = fixture(t, original, 'fictional-alder.txt', {
      fullName: patient,
      birthDate: undefined,
    });
    const review = await f.identity();
    assert.equal(review.status, 'confirmation_required');
    assert.equal(review.blocking, true);
    assert.equal(review.evidencedIdentity.birthDate, undefined);
    assert.equal(review.scope?.birthDateReview?.suggested, suggested);
    assert.ok(review.scope?.birthDateReview?.choices.includes(suggested));
    assert.equal(review.offeredSelfFields.birthDate, undefined);
    assert.throws(f.individual);
    assert.throws(f.bulk);
    assert.equal(f.acceptedCount(), 0);
    await assert.rejects(
      () =>
        confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
          version: review.scope!.intakeVersion,
          operationId: randomUUID(),
          scope: review.scope!,
          outcome: 'this_is_me',
          attestation: 'reviewed_original_and_membership',
          identityAnswers: { birthDate: suggested.slice(0, 4) },
        }),
      { code: 'IDENTITY_BIRTH_DATE' },
    );
    await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
      version: review.scope!.intakeVersion,
      operationId: randomUUID(),
      scope: review.scope!,
      outcome: 'this_is_me',
      attestation: 'reviewed_original_and_membership',
      identityAnswers: { birthDate: suggested },
    });
    assert.equal(getNote(f.db, 'person-note:self').person.birthDate, undefined);
    assert.equal(f.clinical().records[0]!.identityReview?.blocking, false);
    f.individual();
    assert.equal(f.acceptedCount(), 1);
  });

test('printed year-only DOB suggests a century without inventing a day or filling Self', async (t) => {
  const f = fixture(
    t,
    `${heading}\nPatient: ${patient}\nDOB: 88\nFictional count 12.00`,
    'fictional-alder.txt',
    { fullName: patient, birthDate: undefined },
  );
  const review = await f.identity();
  assert.equal(review.status, 'confirmation_required');
  assert.equal(review.blocking, true);
  assert.equal(review.evidencedIdentity.birthDate, undefined);
  assert.equal(review.scope?.birthDateReview?.suggested, '1988');
  assert.deepEqual(review.scope?.birthDateReview?.choices, ['1988']);
  assert.equal(review.offeredSelfFields.birthDate, undefined);
  assert.throws(f.individual);
  assert.throws(f.bulk);
  for (const invalidYear of ['0000', String(new Date().getUTCFullYear() + 1)])
    await assert.rejects(
      () =>
        confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
          version: review.scope!.intakeVersion,
          operationId: randomUUID(),
          scope: review.scope!,
          outcome: 'this_is_me',
          attestation: 'reviewed_original_and_membership',
          identityAnswers: { birthDate: invalidYear },
        }),
      { code: 'IDENTITY_BIRTH_DATE' },
    );
  assert.equal(
    intake.getIntake(f.db, f.root, f.profileId, f.item.id).workflow!.identityConfirmations
      ?.length || 0,
    0,
  );
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    version: review.scope!.intakeVersion,
    operationId: randomUUID(),
    scope: review.scope!,
    outcome: 'this_is_me',
    attestation: 'reviewed_original_and_membership',
    identityAnswers: { birthDate: '1988' },
  });
  assert.equal(getNote(f.db, 'person-note:self').person.birthDate, undefined);
  assert.equal(f.clinical().records[0]!.identityReview?.blocking, false);
  f.individual();
  assert.equal(f.acceptedCount(), 1);
});

for (const evidenceMode of ['complete', 'year-only'] as const)
  for (const changeBirthDate of [true, false])
    test(`${evidenceMode} family assignment ${changeBirthDate ? 'blocks a changed DOB' : 'survives an unrelated person edit'}`, async (t) => {
      const f = fixture(
        t,
        `${heading}\nPatient: ${patient}\nDOB: ${evidenceMode === 'complete' ? selfBirthDate : '82'}\nFictional count 12.00`,
        'fictional-alder.txt',
      );
      const family = createNote(f.db, {
        kind: 'person',
        title: 'Fictional Iris Meadow',
        content: '',
        person: { fullName: patient, birthDate: selfBirthDate },
      });
      const review = await f.identity();
      assert.ok(review.scope?.assignmentTargets?.length || review.scope?.targets.length);
      if (evidenceMode === 'year-only') {
        assert.equal(review.evidencedIdentity.birthDate, undefined);
        assert.equal(review.scope?.birthDateReview?.suggested, '1982');
      }
      await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
        version: review.scope!.intakeVersion,
        operationId: randomUUID(),
        scope: review.scope!,
        outcome: 'this_is_person',
        attestation: 'confirmed_displayed_report_subject',
        personSelection: { noteId: family.id, expectedVersion: family.version },
        ...(evidenceMode === 'year-only' ? { identityAnswers: { birthDate: '1982' } } : {}),
      });
      assert.equal(f.clinical().records[0]!.mapping.personId, family.personId);

      const current = getNote(f.db, family.id);
      const edited = saveNote(f.db, current.id, {
        version: current.version,
        person: {
          ...current.person,
          ...(changeBirthDate ? { birthDate: '1970-01-01' } : { relationship: 'sibling' }),
        },
      });
      assert.ok(edited.version > current.version);
      const after = f.clinical().records[0]!;
      if (changeBirthDate) {
        assert.equal(after.identityReview?.blocking, true);
        assert.throws(f.individual);
        assert.throws(f.bulk);
        assert.equal(f.acceptedCount(), 0);
      } else {
        assert.equal(after.identityReview?.status, 'prior_confirmation');
        assert.equal(after.identityReview?.blocking, false);
        f.bulk();
        assert.equal(f.acceptedCount(), 1);
        assert.equal(
          f.db.prepare('SELECT person_id FROM observations').get()!.person_id,
          family.personId,
        );
      }
    });

for (const changeBirthDate of [true, false])
  test(`year-only Self confirmation ${changeBirthDate ? 'blocks a changed DOB' : 'survives an unrelated note edit'}`, async (t) => {
    const f = fixture(
      t,
      `${heading}\nPatient: ${patient}\nDOB: 82\nFictional count 12.00`,
      'fictional-alder.txt',
    );
    const review = await f.identity();
    assert.equal(review.status, 'confirmation_required');
    assert.equal(review.scope?.birthDateReview?.suggested, '1982');
    await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
      version: review.scope!.intakeVersion,
      operationId: randomUUID(),
      scope: review.scope!,
      outcome: 'this_is_me',
      attestation: 'reviewed_original_and_membership',
      identityAnswers: { birthDate: '1982' },
    });
    assert.equal(f.clinical().records[0]!.identityReview?.blocking, false);
    const current = getNote(f.db, 'person-note:self');
    if (changeBirthDate)
      saveNote(f.db, current.id, {
        version: current.version,
        person: { ...current.person, birthDate: '1970-01-01' },
      });
    else
      saveNote(f.db, current.id, {
        version: current.version,
        content: 'Fictional identity note edit',
      });
    const after = f.clinical().records[0]!;
    if (changeBirthDate) {
      assert.equal(after.identityReview?.blocking, true);
      assert.throws(f.individual);
      assert.throws(f.bulk);
      assert.equal(f.acceptedCount(), 0);
    } else {
      assert.equal(after.identityReview?.status, 'prior_confirmation');
      assert.equal(after.identityReview?.blocking, false);
      f.individual();
      assert.equal(f.acceptedCount(), 1);
    }
  });

test('a Self receipt on one report cannot authorize a later narrative name as the patient', async (t) => {
  const secondHeading = 'Fictional Willow report';
  const f = fixture(
    t,
    `${heading}\nPatient: ${patient}\nDOB: ${selfBirthDate}\nFictional count 12.00\n${secondHeading}\nPatient: ${otherPatient}\nDOB: 2010-01-05\nFinding: ${patient}\nDOB: ${selfBirthDate}\nFictional count 14.00`,
    'fictional-alder.txt',
  );
  const first = await f.identity();
  assert.equal(first.status, 'evidenced_match');
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    version: first.scope!.intakeVersion,
    operationId: randomUUID(),
    scope: first.scope!,
    outcome: 'this_is_me',
    attestation: 'confirmed_displayed_report_subject',
  });
  assert.equal(
    intake.getIntake(f.db, f.root, f.profileId, f.item.id).workflow!.identityConfirmations?.length,
    1,
  );

  const later = record();
  later.id = 'fictional-second-count';
  later.provenance.sourceRecordId = later.id;
  later.report!.key = 'willow';
  later.report!.title = secondHeading;
  later.report!.anchor = { locator: 'page 1 later heading', text: secondHeading };
  const current = intake.getIntake(f.db, f.root, f.profileId, f.item.id);
  const proposed = intake.proposeConversion(f.db, f.root, f.profileId, f.item.id, {
    version: current.version,
    summary: 'Independently fictional later observation',
    jsonlText: JSON.stringify(later),
  });
  const group = proposed.workflow!.reportGroups!.find(
    (candidate) => candidate.report?.anchor?.text === secondHeading,
  )!;
  assert.ok(group);
  const identity = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
  assert.equal(identity.blocking, true);
  assert.notEqual(identity.status, 'prior_confirmation');
  assert.notEqual(identity.evidencedIdentity.fullName, patient);
  const proposalId = proposed.proposals.at(-1)!.id;
  const clinical = intake.reviewIntake(f.db, f.root, f.profileId, f.item.id, proposalId);
  const selected = clinical.records[0]!;
  assert.equal(selected.identityReview?.blocking, true);
  assert.throws(() =>
    intake.importIntake(f.db, f.root, f.profileId, f.item.id, {
      version: clinical.version,
      proposalId,
      reviewToken: clinical.reviewToken,
      decisions: [{ recordId: selected.id, action: 'accept', mapping: {} }],
    }),
  );
  assert.throws(() =>
    acceptIntakeReportSelection(f.db, f.root, f.profileId, {
      operationId: randomUUID(),
      blocks: [
        {
          intakeId: f.item.id,
          proposalId,
          intakeVersion: clinical.version,
          reviewToken: clinical.reviewToken,
          selections: [
            {
              recordId: selected.id,
              candidateId: selected.candidateId!,
              candidateVersionId: selected.candidateVersionId!,
              mapping: selected.mapping,
            },
          ],
        },
      ],
    }),
  );
  assert.equal(f.acceptedCount(), 0);
  assert.equal(
    intake.getIntake(f.db, f.root, f.profileId, f.item.id).workflow!.identityConfirmations?.length,
    1,
  );
});
