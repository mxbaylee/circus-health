import { attachPersonalDurability } from '../portable.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessIdentityPolicy,
  collectEvidencedIdentity,
  type IdentityPolicyPersonSnapshot,
} from '../intake-identity-policy.ts';
import { identityPeopleSnapshots } from '../intake-identity-people.ts';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { createNote, getNote, saveNote } from '../notes.ts';
import {
  uploadIntake,
  proposeConversion,
  reviewIntake,
  importIntake,
  getIntake,
} from '../intake.ts';
import { getIntakeIdentityReview, confirmIntakeIdentityScope } from '../intake-identity.ts';
import { setVisibility } from '../visibility.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';

const self = {
  noteId: 'person-note:self' as const,
  version: 1,
  fullName: 'Iris Meadow',
  knownNames: ['Iris Brook'],
  birthDate: '1982-04-17',
};
const person: IdentityPolicyPersonSnapshot = {
  noteId: 'person-note:rowan',
  personId: 'rowan',
  version: 3,
  fullName: 'Rowan River',
  knownNames: ['Rowan Brook'],
  birthDate: '1950-01-05',
};
const assess = (
  evidence: { fullName?: string; birthDate?: string },
  people = [person],
  extra = {},
) =>
  assessIdentityPolicy({
    self,
    people,
    evidence,
    group: null,
    groupVersionId: null,
    originalFingerprint: null,
    ...extra,
  });

test('unique exact primary and saved aliases match Self or People symmetrically', () => {
  for (const fullName of ['Rowan River', '  ROWAN BROOK ', 'Brook, Rowan']) {
    const result = assess({ fullName });
    assert.equal(result.status, 'evidenced_match');
    assert.equal(result.blocking, false);
    assert.equal(result.attribution?.basis, 'matched_saved_person');
    assert.equal(result.attribution?.assignedPerson?.personId, 'rowan');
  }
  const result = assess({ fullName: 'Brook, Iris' });
  assert.equal(result.attribution?.basis, 'matched_saved_self');
  assert.equal(result.attribution?.assignedPerson, undefined);
});

test('shared names never prefer Self or use DOB to silently choose a household member', () => {
  const collision = { ...person, knownNames: ['Iris Brook'] };
  for (const birthDate of [undefined, self.birthDate, person.birthDate!]) {
    const result = assess({ fullName: 'Iris Brook', birthDate }, [collision]);
    assert.equal(result.blocking, true);
    assert.equal(result.status, 'confirmation_required');
    assert.equal(result.attribution, undefined);
  }
  const result = assess({ fullName: 'Rowan Brook' }, [
    person,
    { ...person, personId: 'other-rowan', noteId: 'other-note' },
  ]);
  assert.equal(result.blocking, true);
});

test('DOB-only, contradictions, approximate names, and current unanswered questions require choice', () => {
  assert.equal(assess({ birthDate: self.birthDate }).blocking, true);
  assert.equal(assess({ fullName: 'Rowan Brook', birthDate: self.birthDate }).blocking, true);
  assert.equal(assess({ fullName: 'R. Brook', birthDate: person.birthDate! }).blocking, true);
  for (const currentRefusal of ['unknown', 'other_person'])
    assert.equal(assess({ fullName: 'Rowan Brook' }, [person], { currentRefusal }).blocking, true);
  assert.equal(
    assess({ fullName: 'Rowan Brook' }, [person], { hasUnstructuredIdentityQuestion: true })
      .blocking,
    true,
  );
  // Missing family DOB must not inherit Self's unrelated birthday.
  assert.equal(
    assess({ fullName: 'Rowan Brook', birthDate: '1949-12-06' }, [{ ...person, birthDate: null }])
      .blocking,
    false,
  );
});

function fixture(
  t: TestContext,
  options: {
    structured?: boolean;
    forged?: boolean;
    subject?: string;
    structuredName?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-household-matching-'));
  const profileId = 'fictional-household';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId: profileId });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const current = getNote(db, 'person-note:self');
  saveNote(db, current.id, {
    version: current.version,
    person: { fullName: 'Iris Meadow', birthDate: self.birthDate },
  });
  const family = createNote(db, {
    kind: 'person',
    title: 'Display nickname only',
    person: { fullName: 'Rowan River', knownNames: ['Rowan Brook'], birthDate: person.birthDate },
  });
  const heading = 'Fictional family report';
  const subject = options.subject || 'Patient: Brook, Rowan';
  const original = `${heading}\n${subject}\nDOB: ${person.birthDate}\nFictional count 12.00`;
  const item = uploadIntake(db, root, profileId, {
    filename: 'fictional-family.txt',
    bytes: Buffer.from(
      options.forged ? original.replace(subject, 'Patient: Different Fictional Person') : original,
    ),
    newProviderName: 'Invented Clinic',
  });
  const entry: HealthRecordEnvelope = {
    format: 'health-record-v1',
    id: 'rowan-count',
    kind: 'record',
    payload: { text: original },
    provenance: {
      capturedVia: null,
      sourceSystem: 'Invented Clinic',
      sourceRecordId: 'rowan-count',
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
      key: 'family',
      title: heading,
      anchor: { locator: 'page 1 heading', text: heading },
      subject: { locator: 'page 1 subject', text: subject },
    },
    reviewIssues: [
      {
        kind: 'identity',
        field: 'subject',
        prompt: 'Confirm printed patient',
        textAnchor: `${subject}\nDOB: ${person.birthDate}`,
        selfSuggestion: {
          fullName: options.structuredName || 'Brook, Rowan',
          birthDate: person.birthDate!,
        },
      },
    ],
  };
  if (options.structured === false) delete entry.reviewIssues;
  const proposed = proposeConversion(db, root, profileId, item.id, {
    version: item.version,
    summary: 'Fictional family count',
    jsonlText: JSON.stringify(entry),
  });
  return {
    db,
    root,
    profileId,
    family,
    entry,
    item: proposed,
    proposalId: proposed.proposals[0]!.id,
  };
}

test('workflow, identity preview, and accepted mapping agree on a uniquely named Person', async (t) => {
  const f = fixture(t);
  const pending = reviewIntake(f.db, f.root, f.profileId, f.item.id, f.proposalId);
  assert.equal(pending.records[0]?.identityReview?.blocking, true);
  const group = getIntake(f.db, f.root, f.profileId, f.item.id).workflow!.reportGroups![0]!;
  const identity = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
  const review = reviewIntake(f.db, f.root, f.profileId, f.item.id, f.proposalId);
  const record = review.records[0]!;
  assert.equal(record.mapping.personId, f.family.personId);
  assert.equal(record.mapping.subject, 'other');
  assert.equal(record.identityAttribution?.basis, 'matched_saved_person');
  assert.equal(record.identityReview?.blocking, false);
  assert.equal(identity.blocking, false);
  assert.equal(identity.assignedPerson?.personId, f.family.personId);
  importIntake(f.db, f.root, f.profileId, f.item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    proposalId: f.proposalId,
    decisions: [{ recordId: record.id, action: 'accept', mapping: {} }],
  });
  assert.equal(
    f.db.prepare('SELECT person_id FROM observations').get()?.person_id,
    f.family.personId,
  );
});

test('a later family collision removes automatic ownership and display nicknames never establish it', (t) => {
  const f = fixture(t);
  const snapshot = identityPeopleSnapshots(f.db);
  assert.equal(snapshot[0]?.fullName, 'Rowan River');
  assert.ok(!snapshot[0]?.knownNames.includes('Display nickname only'));
  const current = getNote(f.db, 'person-note:self');
  saveNote(f.db, current.id, {
    version: current.version,
    person: { ...current.person, knownNames: ['Rowan Brook'] },
  });
  const record = reviewIntake(f.db, f.root, f.profileId, f.item.id, f.proposalId).records[0]!;
  assert.equal(record.identityReview?.blocking, true);
  assert.equal(record.identityAttribution, undefined);
  assert.equal(record.mapping.personId, undefined);
});

test('subject-only name matches require verified original grounding and invalidate after membership changes', async (t) => {
  const f = fixture(t, { structured: false });
  const read = () => reviewIntake(f.db, f.root, f.profileId, f.item.id, f.proposalId).records[0]!;
  assert.equal(read().identityReview?.blocking, true);
  assert.equal(read().mapping.personId, undefined);
  const group = getIntake(f.db, f.root, f.profileId, f.item.id).workflow!.reportGroups![0]!;
  const identity = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
  assert.equal(identity.blocking, false);
  assert.equal(read().mapping.personId, f.family.personId);
  proposeConversion(f.db, f.root, f.profileId, f.item.id, {
    version: getIntake(f.db, f.root, f.profileId, f.item.id).version,
    summary: 'Fictional later member',
    jsonlText: JSON.stringify({ ...f.entry, id: 'later-rowan-count' }),
  });
  assert.equal(read().identityReview?.blocking, true);
});

for (const structured of [false, true])
  test(`an invented ${structured ? 'structured' : 'subject-only'} model name cannot become an automatic owner`, async (t) => {
    const f = fixture(t, { structured, forged: true });
    const group = getIntake(f.db, f.root, f.profileId, f.item.id).workflow!.reportGroups![0]!;
    const identity = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
    assert.equal(identity.blocking, true);
    const record = reviewIntake(f.db, f.root, f.profileId, f.item.id, f.proposalId).records[0]!;
    assert.equal(record.mapping.personId, undefined);
    assert.equal(record.identityAttribution, undefined);
  });

test('archive and restore use current visibility for matching and the person chooser', async (t) => {
  const f = fixture(t);
  const group = getIntake(f.db, f.root, f.profileId, f.item.id).workflow!.reportGroups![0]!;
  const preview = () => getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
  assert.equal((await preview()).assignedPerson?.personId, f.family.personId);
  const archived = setVisibility(f.db, 'note', f.family.id, { version: 0, archived: true });
  assert.equal(f.db.prepare('SELECT archived FROM notes WHERE id=?').get(f.family.id)?.archived, 0);
  assert.equal(identityPeopleSnapshots(f.db).length, 0);
  assert.equal((await preview()).people?.length, 0);
  const record = reviewIntake(f.db, f.root, f.profileId, f.item.id, f.proposalId).records[0]!;
  assert.equal(record.identityReview?.blocking, true);
  assert.equal(record.mapping.personId, undefined);
  setVisibility(f.db, 'note', f.family.id, { version: archived.version, archived: false });
  assert.equal(identityPeopleSnapshots(f.db).length, 1);
  const restored = await preview();
  assert.equal(restored.assignedPerson?.personId, f.family.personId);
  assert.equal(restored.people?.[0]?.personId, f.family.personId);
});

test('structured name hints cannot protect an entire demographic sentence as a name', () => {
  const sentence = 'Patient: Rowan Brook DOB: 1950-01-05';
  const collected = collectEvidencedIdentity(
    [{ selfSuggestion: { fullName: sentence, birthDate: '1950-01-05' } }],
    sentence,
  );
  assert.equal(collected.evidence.fullName, 'Rowan Brook');
  assert.equal(
    collectEvidencedIdentity([{ selfSuggestion: { fullName: sentence } }]).evidence.fullName,
    undefined,
  );
  assert.equal(
    collectEvidencedIdentity(
      [{ selfSuggestion: { fullName: 'Fictional Fern Patient' } }],
      'Patient: Fictional Fern Patient',
    ).evidence.fullName,
    'Fictional Fern Patient',
  );
});

test('a guarantor substring cannot automatically own the patient report or become a saved alias', async (t) => {
  const f = fixture(t, {
    subject: 'Patient: Iris Meadow; Guarantor: Rowan River',
    structuredName: 'Rowan River',
  });
  const group = getIntake(f.db, f.root, f.profileId, f.item.id).workflow!.reportGroups![0]!;
  const identity = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
  assert.equal(identity.blocking, true);
  assert.equal(identity.assignedPerson, undefined);
  assert.equal(identity.evidencedIdentity.fullName, undefined);
  assert.equal(identity.evidencedIdentity.birthDate, undefined);
  assert.ok(identity.scope);
  const record = reviewIntake(f.db, f.root, f.profileId, f.item.id, f.proposalId).records[0]!;
  assert.equal(record.mapping.personId, undefined);
  assert.equal(record.identityAttribution, undefined);
  const input = {
    version: identity.scope.intakeVersion,
    operationId: 'fictional-role-choice',
    scope: identity.scope,
    outcome: 'this_is_me' as const,
    attestation: 'confirmed_displayed_identity_questions' as const,
  };
  const savedSelfNote = structuredClone(getNote(f.db, 'person-note:self'));
  await assert.rejects(confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, input), {
    code: 'IDENTITY_PRINTED_NAME',
  });
  const confirmed = await confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
    ...input,
    printedName: 'Iris Meadow',
  });
  // Keep the report decision without a redundant primary-name alias or Person write.
  assert.deepEqual(getNote(f.db, 'person-note:self'), savedSelfNote);
  assert.ok(
    'validation' in confirmed,
    'This direct legacy fixture retains its full intake contract',
  );
  const receipt = confirmed.workflow!.identityConfirmations!.find(
    (entry) => entry.operationId === input.operationId,
  )!;
  assert.equal(receipt.confirmedPrintedName, 'Iris Meadow');
  assert.equal(receipt.knownNameAdded, undefined);
});

test('report person defaults follow Cookie Doe name and birth-date combinations', () => {
  const cookie = {
    noteId: 'person-note:self' as const,
    version: 1,
    fullName: 'Cookie Doe',
    birthDate: '1986-02-14',
  };
  const evaluate = (fullName: string, birthDate?: string) =>
    assessIdentityPolicy({
      self: cookie,
      evidence: { fullName, birthDate },
      group: null,
      groupVersionId: null,
      originalFingerprint: null,
    });
  for (const name of ['Cookie Doe', 'Doe, Cookie']) {
    const match = evaluate(name, '1986-02-14');
    assert.equal(match.blocking, false);
    assert.equal(match.defaultPerson, 'self');
    const conflict = evaluate(name, '1987-02-14');
    assert.equal(conflict.blocking, true);
    assert.equal(conflict.selfBirthDateConflict, true);
    assert.equal(conflict.defaultPerson, 'new');
    assert.equal(evaluate(name).blocking, false);
  }
  const alias = evaluate('Cookie Meadow', '1986-02-14');
  assert.equal(alias.defaultPerson, 'self');
  assert.equal(alias.selfBirthDateConflict, false);
  assert.equal(alias.blocking, true); // The person explicitly adds the new name.
  assert.equal(evaluate('Cookie Meadow').defaultPerson, 'self');
});

test('an unreadable printed DOB asks instead of matching a name or warning about missing identity', () => {
  const collected = collectEvidencedIdentity([], 'Patient: Iris Meadow DOB: see attached');
  assert.equal(collected.unreadableBirthDate, true);
  assert.equal(collected.evidence.birthDate, undefined);
  assert.equal(collectEvidencedIdentity([], 'Patient: Iris Meadow').unreadableBirthDate, false);
  assert.equal(
    collectEvidencedIdentity([], 'Patient: Iris Meadow', { dates: [], unreadable: true })
      .unreadableBirthDate,
    true,
  );
  // Without the signal, the matching name alone is an evidenced match.
  assert.equal(assess({ fullName: 'Iris Meadow' }).status, 'evidenced_match');
  for (const evidence of [
    { fullName: 'Iris Meadow' },
    { fullName: 'Rowan River' },
    { fullName: 'Iris Meadow', birthDate: self.birthDate },
    {},
  ]) {
    const result = assess(evidence, [person], { unreadableBirthDate: true });
    assert.equal(result.status, 'confirmation_required', JSON.stringify(evidence));
    assert.equal(result.blocking, true);
    assert.equal(result.attribution, undefined);
    assert.notEqual(result.confidence, 'strong');
    assert.equal(result.defaultPerson, 'self');
  }
  // A contradiction still reports its conflict.
  assert.equal(
    assess({ fullName: 'Iris Meadow', birthDate: '1990-01-01' }, [person], {
      unreadableBirthDate: true,
    }).status,
    'conflict',
  );
});

test('a DOB in the printed subject survives without a model identity suggestion', () => {
  const result = collectEvidencedIdentity([], 'Patient: Cookie Doe DOB: 1986-02-14');
  assert.equal(result.evidence.birthDate, '1986-02-14');
  assert.equal(assess(result.evidence).selfBirthDateConflict, true);
});

test('original header DOB blocks Self even when the model supplies only the matching name', async (t) => {
  const f = fixture(t, { structured: false, subject: 'Patient: Iris Meadow' });
  const group = getIntake(f.db, f.root, f.profileId, f.item.id).workflow!.reportGroups![0]!;
  const identity = await getIntakeIdentityReview(f.db, f.root, f.profileId, f.item.id, group.id);
  assert.equal(identity.evidencedIdentity.birthDate, person.birthDate);
  assert.equal(identity.selfBirthDateConflict, true);
  assert.equal(identity.blocking, true);
  assert.equal(identity.defaultPerson, 'new');
  assert.ok(identity.scope);
  await assert.rejects(
    confirmIntakeIdentityScope(f.db, f.root, f.profileId, f.item.id, {
      version: getIntake(f.db, f.root, f.profileId, f.item.id).version,
      operationId: 'fictional-dob-mismatch',
      scope: identity.scope,
      outcome: 'this_is_me',
      attestation: 'confirmed_displayed_report_subject',
    }),
    { code: 'IDENTITY_CONFLICT' },
  );
  const review = reviewIntake(f.db, f.root, f.profileId, f.item.id, f.proposalId);
  assert.equal(review.records[0]!.identityReview?.blocking, true);
  assert.throws(() =>
    importIntake(f.db, f.root, f.profileId, f.item.id, {
      version: review.version,
      reviewToken: review.reviewToken,
      proposalId: f.proposalId,
      decisions: [
        { recordId: review.records[0]!.id, action: 'accept', mapping: { subject: 'self' } },
      ],
    }),
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM observations').get()?.count, 0);
});

test('a grounded name cannot automatically match without the accompanying original DOB check', () => {
  const result = assess({ fullName: self.fullName }, [], {
    nameEvidenceGrounded: true,
    originalEvidenceChecked: false,
  });
  assert.equal(result.blocking, true);
  assert.notEqual(result.status, 'evidenced_match');
});

test('an unprinted model DOB does not become evidence or a separate ownership question', () => {
  const collected = collectEvidencedIdentity(
    [{ selfSuggestion: { fullName: self.fullName, birthDate: self.birthDate } }],
    `Patient: ${self.fullName}`,
    { dates: [], unreadable: false },
  );
  assert.equal(collected.evidence.birthDate, undefined);
  assert.equal('birthDateHints' in collected.evidence, false);
  const result = assess(collected.evidence, [], {
    unreadableBirthDate: collected.unreadableBirthDate,
  });
  assert.equal(result.blocking, false);
  assert.equal(result.offeredSelfFields.birthDate, undefined);
});

test('printed two-digit DOB still asks even when a model supplies a plausible century', () => {
  const collected = collectEvidencedIdentity(
    [{ selfSuggestion: { fullName: self.fullName, birthDate: self.birthDate } }],
    'Patient: ' + self.fullName,
    { dates: [], unreadable: true, suggestions: [self.birthDate] },
  );
  const result = assess(collected.evidence, [], {
    unreadableBirthDate: collected.unreadableBirthDate,
  });
  assert.equal(collected.evidence.birthDate, undefined);
  assert.equal(result.blocking, true);
  assert.equal(result.offeredSelfFields.birthDate, undefined);
});
