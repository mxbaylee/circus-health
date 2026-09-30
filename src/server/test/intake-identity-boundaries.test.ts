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
