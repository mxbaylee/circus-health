import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, type Database } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { createNote, getNote, saveNote } from '../notes.ts';
import * as intake from '../intake.ts';
import {
  applyIntakePerson,
  getIntakePeopleQueue,
  saveIntakePersonDisposition,
} from '../intake-people.ts';
import { getIntakeReportQueueGroup, listIntakeReportQueue } from '../intake-report-queue.ts';
import { validateJSONL } from '../intake-format.ts';
import { intakePersonDisplayTitle } from '../intake-people-format.ts';
import { attachPersonalDurability, rebuildProfile } from '../portable.ts';
import { personSourceEvidence } from '../person-source-evidence.ts';

const uuid = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const deterministicNoteId = (proposalId: string) => {
  const hash = createHash('sha256').update(proposalId).digest('hex');
  return `note:${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

const envelope = () => ({
  format: 'health-record-v1',
  id: 'fictional-people-only',
  kind: 'record',
  payload: [
    'Fictional visit summary',
    'Mira Finch, OD (fictional license FX-4242) electronically signed 8 January 2031 at 09:15; phone +1 415 555 0127.',
    'Aunt Juniper Vale reported migraines since college; the onset year is uncertain.',
    'Mother had an unclassified illness; no personal name was supplied.',
  ].join('\n'),
  provenance: {
    capturedVia: 'Fictional upload',
    sourceSystem: 'Fictional issuer',
    sourceRecordId: 'fictional-people-only',
    evidenceClass: 'provider_export',
    locator: 'page 1',
  },
  coverage: { status: 'complete_response', notes: [] },
  report: {
    key: 'fictional-visit',
    title: 'Fictional visit summary',
    anchor: { locator: 'page 1 heading', text: 'Fictional visit summary' },
    subject: null,
  },
  people: [
    {
      id: 'mira-finch',
      fullName: 'Mira Finch',
      role: 'clinician',
      title: 'Mira Finch, OD',
      phone: '+1 415 555 0127',
      evidence: [
        {
          textAnchor:
            'Mira Finch, OD (fictional license FX-4242) electronically signed 8 January 2031 at 09:15; phone +1 415 555 0127.',
          supports: ['fullName', 'title', 'phone'],
          locator: 'page 1, clinician line',
          page: 1,
        },
      ],
    },
    {
      id: 'juniper-vale',
      fullName: 'Juniper Vale',
      role: 'relative',
      relationship: 'Aunt',
      medicalHistory: 'migraines since college',
      evidence: [
        {
          textAnchor:
            'Aunt Juniper Vale reported migraines since college; the onset year is uncertain.',
          supports: ['fullName', 'relationship', 'medicalHistory'],
          locator: 'page 1, family history',
          page: 1,
        },
      ],
      uncertainties: ['The onset year is uncertain.'],
    },
  ],
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'health-intake-people-')),
    profileId = 'cookie-dough',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  let rebuilt: Database | null = null;
  const rebuiltRoot = root + '-rebuilt';
  t.after(() => {
    try {
      db.close();
    } catch {}
    try {
      rebuilt?.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
    rmSync(rebuiltRoot, { recursive: true, force: true });
  });
  return {
    root,
    rebuiltRoot,
    profileId,
    db,
    setRebuilt(value: Database) {
      rebuilt = value;
    },
  };
}

test('people-only source creates a separate populated queue without clinical rows or writes', (t) => {
  const f = fixture(t);
  const item = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-people.jsonl',
    newProviderName: 'Fictional archive',
    bytes: Buffer.from(JSON.stringify(envelope())),
  });
  const review = intake.reviewIntake(f.db, f.root, f.profileId, item.id);
  assert.equal(review.records.length, 0);
  assert.equal(item.pendingCount, 0);
  assert.equal(item.reviewLaterCount, 0);
  assert.equal(item.needsReview, false);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM notes WHERE kind='person'").get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_records').get()!.n, 0);
  const groupId = item.workflow!.reportGroups![0]!.id;
  const queue = getIntakePeopleQueue(f.db, f.root, f.profileId, groupId);
  assert.equal(queue.totalPeople, 2);
  assert.equal(queue.people.length, 2);
  assert.equal(queue.peopleNextCursor, null);
  assert.deepEqual(queue.people.map((person) => person.person.fullName).sort(), [
    'Juniper Vale',
    'Mira Finch',
  ]);
  assert.equal(JSON.stringify(queue).includes('Mother'), false);
  assert.equal(
    queue.people.every((person) => person.matches.length === 0),
    true,
  );
  assert.equal(
    queue.people.every((person) => person.selfMatch === undefined),
    true,
  );
  const reportQueue = listIntakeReportQueue(f.db, f.root, f.profileId);
  assert.equal(reportQueue.groups.length, 1);
  assert.deepEqual(reportQueue.groups[0]!.peopleCounts, {
    pending: 2,
    later: 0,
    excluded: 0,
    saved: 0,
  });
  const reportDetail = getIntakeReportQueueGroup(f.db, f.root, f.profileId, groupId);
  assert.deepEqual(reportDetail.blocks, []);
  assert.equal(reportDetail.totalRecords, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_records').get()!.n, 0);
  let intakeVersion = item.version;
  for (const [index, person] of queue.people.entries()) {
    const result = saveIntakePersonDisposition(f.db, f.root, f.profileId, {
      operationId: `exclude-fictional-person-${index}`,
      intakeId: item.id,
      intakeVersion,
      proposalId: person.id,
      proposalVersion: person.version,
      state: 'excluded',
    });
    intakeVersion = result.version;
  }
  assert.equal(listIntakeReportQueue(f.db, f.root, f.profileId).groups.length, 0);
  assert.deepEqual(
    listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'all' }).groups[0]!.peopleCounts,
    { pending: 0, later: 0, excluded: 2, saved: 0 },
  );
  assert.equal(intake.getIntake(f.db, f.root, f.profileId, item.id).needsReview, false);
});

test('named People require a same-passage name and field association', () => {
  const contextPeople = { ...envelope(), kind: 'context' };
  const invalidContext = validateJSONL(Buffer.from(JSON.stringify(contextPeople)));
  assert.equal(invalidContext.valid, false);
  assert.match(invalidContext.issues[0]!.message, /record envelope/i);

  const unnamed = envelope() as Record<string, unknown> & { people: unknown[] };
  unnamed.people = [
    {
      id: 'generic-mother',
      fullName: 'mother',
      role: 'relative',
      relationship: 'mother',
      evidence: [
        {
          textAnchor: 'Mother had an unclassified illness; no personal name was supplied.',
          supports: ['fullName', 'relationship'],
          locator: 'page 1, unnamed history',
          page: 1,
        },
      ],
    },
  ];
  const missingName = validateJSONL(Buffer.from(JSON.stringify(unnamed)));
  assert.equal(missingName.valid, false);
  assert.match(missingName.issues[0]!.message, /personal name stays retained source text/i);

  for (const [fullName, relationship] of [
    ['maternal uncle', 'uncle'],
    ['my mother', 'mother'],
  ]) {
    const rolePhrase = envelope() as Record<string, unknown> & { people: unknown[] };
    const textAnchor = `${fullName} reported fictional family history.`;
    rolePhrase.payload = textAnchor;
    rolePhrase.people = [
      {
        id: `unnamed-${relationship}`,
        fullName,
        role: 'relative',
        relationship,
        evidence: [{ textAnchor, supports: ['fullName', 'relationship'] }],
      },
    ];
    const missingPersonalName = validateJSONL(Buffer.from(JSON.stringify(rolePhrase)));
    assert.equal(missingPersonalName.valid, false);
    assert.match(
      missingPersonalName.issues[0]!.message,
      /personal name stays retained source text/i,
    );
  }

  const namedControls = envelope() as Record<string, unknown> & { people: unknown[] };
  namedControls.payload = 'Mother Teresa was her aunt. Dr Mira Finch was the physician.';
  namedControls.people = [
    {
      id: 'mother-teresa',
      fullName: 'Mother Teresa',
      role: 'relative',
      relationship: 'aunt',
      evidence: [
        {
          textAnchor: 'Mother Teresa was her aunt.',
          supports: ['fullName', 'relationship'],
        },
      ],
    },
    {
      id: 'mira-finch-control',
      fullName: 'Mira Finch',
      role: 'clinician',
      title: 'Dr Mira Finch',
      evidence: [
        {
          textAnchor: 'Dr Mira Finch was the physician.',
          supports: ['fullName', 'title'],
        },
      ],
    },
  ];
  assert.equal(validateJSONL(Buffer.from(JSON.stringify(namedControls))).valid, true);

  const borrowedContact = envelope() as Record<string, unknown> & { people: unknown[] };
  borrowedContact.people = [
    {
      id: 'mira-borrowed-phone',
      fullName: 'Mira Finch',
      role: 'clinician',
      phone: '+1 415 555 0127',
      evidence: [
        {
          textAnchor: 'Fictional visit summary',
          supports: ['fullName', 'phone'],
          locator: 'page 1 heading',
          page: 1,
        },
      ],
    },
  ];
  const missingAssociation = validateJSONL(Buffer.from(JSON.stringify(borrowedContact)));
  assert.equal(missingAssociation.valid, false);
  assert.match(missingAssociation.issues[0]!.message, /named person must occur/i);

  const transformedContact = envelope() as Record<string, unknown> & { people: unknown[] };
  transformedContact.payload = 'Dr Mira Finch uses MIRA@EXAMPLE.TEST.';
  transformedContact.people = [
    {
      id: 'mira-transformed-email',
      fullName: 'Mira Finch',
      role: 'clinician',
      email: 'mira@example.test',
      evidence: [
        {
          textAnchor: 'Dr Mira Finch uses MIRA@EXAMPLE.TEST.',
          supports: ['fullName', 'email'],
        },
      ],
    },
  ];
  const transformed = validateJSONL(Buffer.from(JSON.stringify(transformedContact)));
  assert.equal(transformed.valid, false);
  assert.match(transformed.issues[0]!.message, /must occur with the name/i);

  const substringName = envelope() as Record<string, unknown> & { people: unknown[] };
  substringName.payload = 'Doctor Joanne Reed was consulted.';
  substringName.people = [
    {
      id: 'ann-substring',
      fullName: 'Ann',
      role: 'clinician',
      evidence: [
        {
          textAnchor: 'Doctor Joanne Reed was consulted.',
          supports: ['fullName'],
        },
      ],
    },
  ];
  const substring = validateJSONL(Buffer.from(JSON.stringify(substringName)));
  assert.equal(substring.valid, false);
  assert.match(substring.issues[0]!.message, /named person must occur/i);
});

test('Person display titles require a whole evidenced name, not just a credential or name fragment', () => {
  const fullName = 'Mira Finch';
  for (const title of [undefined, 'OD', 'Clinician', 'Dr Mira Finchley', 'Amira Finch'])
    assert.equal(intakePersonDisplayTitle({ fullName, title }), fullName);
  for (const title of ['Dr Mira Finch', 'Mira Finch, OD', 'DR MIRA   FINCH'])
    assert.equal(intakePersonDisplayTitle({ fullName, title }), title);
  assert.equal(intakePersonDisplayTitle({ fullName: 'Ann', title: 'Joann, MD' }), 'Ann');
  assert.equal(intakePersonDisplayTitle({ fullName: 'Ann', title: 'Ann2, MD' }), 'Ann');
  assert.equal(
    intakePersonDisplayTitle({ fullName: 'Renée Finch', title: 'Dr Rene\u0301e Finch' }),
    'Dr Rene\u0301e Finch',
  );
});

test('credential-only titles never become new Person names and retained evidence survives rebuild', (t) => {
  const f = fixture(t);
  attachPersonalDurability(f.db, { root: f.root, profileId: f.profileId });
  const source = envelope();
  source.people[0]!.title = 'OD';
  const original = Buffer.from(JSON.stringify(source));
  const item = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-credential-title.jsonl',
    newProviderName: 'Fictional archive',
    bytes: original,
  });
  const clinician = getIntakePeopleQueue(
    f.db,
    f.root,
    f.profileId,
    item.workflow!.reportGroups![0]!.id,
  ).people.find((person) => person.person.fullName === 'Mira Finch')!;
  assert.equal(clinician.title, 'Mira Finch');
  const request = {
    operationId: uuid('112'),
    intakeId: item.id,
    proposalId: clinician.id,
    proposalVersion: clinician.version,
    action: 'add' as const,
  };
  const result = applyIntakePerson(f.db, f.root, f.profileId, request);
  const saved = getNote(f.db, result.noteId);
  assert.equal(saved.title, 'Mira Finch');
  assert.equal(saved.person.fullName, 'Mira Finch');
  assert.match(saved.content, /Mira Finch, OD \(fictional license FX-4242\)/);
  assert.equal(applyIntakePerson(f.db, f.root, f.profileId, request).replayed, true);
  const rebuiltReceipt = rebuildProfile(f.root, f.profileId, f.rebuiltRoot);
  const rebuilt = openDatabase(rebuiltReceipt.database, f.profileId);
  f.setRebuilt(rebuilt);
  const restored = getNote(rebuilt, result.noteId);
  assert.equal(restored.title, saved.title);
  assert.deepEqual(restored.person, saved.person);
  assert.equal(restored.content, saved.content);
  assert.deepEqual(
    readFileSync(intake.verifyIntakeOriginal(rebuilt, f.rebuiltRoot, f.profileId, item.id).path),
    original,
  );
});

test('defer, explicit add/update, replay and rebuild retain exact People evidence', (t) => {
  const f = fixture(t);
  let existing = createNote(f.db, {
    kind: 'person',
    title: 'A carefully curated relative',
    content: 'Unrelated personal notes stay untouched.',
    person: {
      fullName: 'Juniper Vale',
      relationship: 'Aunt',
      medicalHistory: 'Prior retained history.',
      tags: ['Fictional custom tag'],
      unrelated: { retained: true },
    },
  });
  const selfBefore = getNote(f.db, 'patient');
  attachPersonalDurability(f.db, { root: f.root, profileId: f.profileId });
  const item = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-people.jsonl',
    newProviderName: 'Fictional archive',
    bytes: Buffer.from(JSON.stringify(envelope())),
  });
  const groupId = item.workflow!.reportGroups![0]!.id;
  let queue = getIntakePeopleQueue(f.db, f.root, f.profileId, groupId);
  let relative = queue.people.find((person) => person.person.fullName === 'Juniper Vale')!;
  assert.deepEqual(
    relative.matches.map((match) => match.noteId),
    [existing.id],
  );
  assert.equal(relative.matches[0]!.reason, 'Exact full-name match; choose Add or Update.');
  assert.equal(getNote(f.db, existing.id).person.medicalHistory, 'Prior retained history.');
  const disposition = {
    operationId: 'defer-fictional-relative',
    intakeId: item.id,
    intakeVersion: item.version,
    proposalId: relative.id,
    proposalVersion: relative.version,
    state: 'later',
  } as const;
  const deferredItem = saveIntakePersonDisposition(f.db, f.root, f.profileId, disposition);
  assert.equal(deferredItem.id, item.id);
  assert.equal(
    saveIntakePersonDisposition(f.db, f.root, f.profileId, disposition).version,
    deferredItem.version,
  );
  assert.throws(
    () =>
      saveIntakePersonDisposition(f.db, f.root, f.profileId, {
        ...disposition,
        state: 'excluded',
      }),
    (error: unknown) => error instanceof Error && /different request/i.test(error.message),
  );
  const otherProposal = queue.people.find((person) => person.id !== relative.id)!;
  const excludedItem = saveIntakePersonDisposition(f.db, f.root, f.profileId, {
    operationId: 'exclude-fictional-clinician',
    intakeId: item.id,
    intakeVersion: deferredItem.version,
    proposalId: otherProposal.id,
    proposalVersion: otherProposal.version,
    state: 'excluded',
  });
  assert.equal(
    listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'all' }).groups[0]!.peopleCounts!
      .excluded,
    1,
  );
  saveIntakePersonDisposition(f.db, f.root, f.profileId, {
    operationId: 'restore-fictional-clinician',
    intakeId: item.id,
    intakeVersion: excludedItem.version,
    proposalId: otherProposal.id,
    proposalVersion: otherProposal.version,
    state: 'pending',
  });
  assert.throws(
    () =>
      saveIntakePersonDisposition(f.db, f.root, f.profileId, {
        ...disposition,
        proposalId: otherProposal.id,
        proposalVersion: otherProposal.version,
      }),
    (error: unknown) => error instanceof Error && /different request/i.test(error.message),
  );
  assert.equal(
    getIntakePeopleQueue(f.db, f.root, f.profileId, groupId).people.find(
      (person) => person.id === relative.id,
    )!.state,
    'later',
  );
  assert.equal(
    listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'deferred' }).groups[0]!.peopleCounts!
      .later,
    1,
  );

  saveNote(f.db, existing.id, {
    version: existing.version,
    person: { ...existing.person, pronouns: 'they/them' },
  });
  assert.throws(
    () =>
      applyIntakePerson(f.db, f.root, f.profileId, {
        operationId: uuid('1'),
        intakeId: item.id,
        proposalId: relative.id,
        proposalVersion: relative.version,
        action: 'update',
        noteId: existing.id,
        version: existing.version,
      }),
    (error: unknown) => error instanceof Error && /changed/i.test(error.message),
  );
  assert.equal(getNote(f.db, existing.id).person.medicalHistory, 'Prior retained history.');

  queue = getIntakePeopleQueue(f.db, f.root, f.profileId, groupId);
  relative = queue.people.find((person) => person.person.fullName === 'Juniper Vale')!;
  existing = getNote(f.db, existing.id);
  const updateRequest = {
    operationId: uuid('2'),
    intakeId: item.id,
    proposalId: relative.id,
    proposalVersion: relative.version,
    action: 'update' as const,
    noteId: existing.id,
    version: existing.version,
  };
  const updated = applyIntakePerson(f.db, f.root, f.profileId, updateRequest);
  assert.equal(updated.action, 'update');
  assert.equal(updated.replayed, false);
  existing = getNote(f.db, existing.id);
  assert.equal(existing.title, 'A carefully curated relative');
  assert.equal(
    existing.content,
    [
      'Unrelated personal notes stay untouched.',
      'Aunt Juniper Vale reported migraines since college; the onset year is uncertain.',
      'Uncertainty: The onset year is uncertain.',
    ].join('\n\n'),
  );
  assert.equal(existing.person.pronouns, 'they/them');
  assert.deepEqual(existing.person.unrelated, { retained: true });
  assert.equal(
    existing.person.medicalHistory,
    'Prior retained history.\n\nmigraines since college',
  );
  assert.deepEqual(existing.person.tags, ['Family', 'fictional custom tag']);
  const replay = applyIntakePerson(f.db, f.root, f.profileId, updateRequest);
  assert.equal(replay.replayed, true);
  assert.equal(getNote(f.db, existing.id).version, existing.version);

  existing = saveNote(f.db, existing.id, {
    version: existing.version,
    person: { ...existing.person, fullName: 'Juniper Vale, personally corrected' },
  });
  const replayAfterEdit = applyIntakePerson(f.db, f.root, f.profileId, updateRequest);
  assert.equal(replayAfterEdit.replayed, true);
  assert.equal(replayAfterEdit.version, updated.version);
  assert.equal(getNote(f.db, existing.id).version, existing.version);

  let currentIntake = intake.getIntake(f.db, f.root, f.profileId, item.id);
  currentIntake = intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: currentIntake.version,
    jsonlText: JSON.stringify(envelope()),
    summary: 'Repeated exact fictional evidence',
  });
  const afterRepeatedSource = getIntakePeopleQueue(f.db, f.root, f.profileId, groupId);
  assert.equal(afterRepeatedSource.totalPeople, 2);
  assert.equal(
    afterRepeatedSource.people.find((person) => person.person.fullName === 'Juniper Vale')!.state,
    'saved',
  );
  const replayAfterRepeatedSource = applyIntakePerson(f.db, f.root, f.profileId, updateRequest);
  assert.equal(replayAfterRepeatedSource.replayed, true);
  assert.equal(replayAfterRepeatedSource.version, updated.version);

  const clinician = getIntakePeopleQueue(f.db, f.root, f.profileId, groupId).people.find(
    (person) => person.person.fullName === 'Mira Finch',
  )!;
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_records').get()!.n, 1);
  const added = applyIntakePerson(f.db, f.root, f.profileId, {
    operationId: uuid('3'),
    intakeId: item.id,
    proposalId: clinician.id,
    proposalVersion: clinician.version,
    action: 'add',
  });
  const savedClinician = getNote(f.db, added.noteId);
  assert.equal(savedClinician.title, 'Mira Finch, OD');
  assert.equal(savedClinician.person.fullName, 'Mira Finch');
  assert.equal(savedClinician.person.phone, '+1 415 555 0127');
  assert.deepEqual(savedClinician.person.tags, ['Professional']);
  assert.equal(savedClinician.person.lifeStatus, undefined);
  assert.equal(savedClinician.person.onboarding, undefined);
  assert.match(savedClinician.content, /fictional license FX-4242/);
  assert.match(savedClinician.content, /8 January 2031 at 09:15/);
  assert.deepEqual(getNote(f.db, 'patient'), selfBefore);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_records').get()!.n, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM evidence WHERE entity_type='person'").get()!.n,
    2,
  );

  const laterEnvelope = envelope();
  laterEnvelope.id = 'later-unrelated-envelope';
  laterEnvelope.report.key = 'later-unrelated-report';
  laterEnvelope.report.title = 'Later unrelated report';
  laterEnvelope.report.anchor.text = 'Later unrelated report';
  laterEnvelope.payload = 'Later unrelated report\nDr Rowan Cedar was the consulting physician.';
  (laterEnvelope as { people: unknown[] }).people = [
    {
      id: 'rowan-cedar',
      fullName: 'Rowan Cedar',
      role: 'clinician',
      title: 'Dr Rowan Cedar',
      evidence: [
        {
          textAnchor: 'Dr Rowan Cedar was the consulting physician.',
          supports: ['fullName', 'title'],
          locator: 'page 2',
          page: 2,
        },
      ],
    },
  ];
  currentIntake = intake.getIntake(f.db, f.root, f.profileId, item.id);
  intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: currentIntake.version,
    jsonlText: JSON.stringify(laterEnvelope),
    summary: 'Later independent fictional evidence',
  });
  const replayAfterLaterProposal = applyIntakePerson(f.db, f.root, f.profileId, updateRequest);
  assert.equal(replayAfterLaterProposal.replayed, true);
  assert.equal(replayAfterLaterProposal.version, updated.version);

  const original = intake.verifyIntakeOriginal(f.db, f.root, f.profileId, item.id);
  const originalBytes = readFileSync(original.path);
  const relativeSourceEvidence = personSourceEvidence(
    f.db,
    existing.id,
    new URLSearchParams({ limit: '200' }),
  );
  const clinicianSourceEvidence = personSourceEvidence(
    f.db,
    added.noteId,
    new URLSearchParams({ limit: '200' }),
  );
  assert.equal(relativeSourceEvidence.total, 1);
  assert.equal(clinicianSourceEvidence.total, 1);
  const rebuiltReceipt = rebuildProfile(f.root, f.profileId, f.rebuiltRoot);
  const rebuilt = openDatabase(rebuiltReceipt.database, f.profileId);
  f.setRebuilt(rebuilt);
  const rebuiltRelative = getNote(rebuilt, existing.id);
  assert.equal(rebuiltRelative.person.medicalHistory, existing.person.medicalHistory);
  assert.equal(rebuiltRelative.content, existing.content);
  assert.deepEqual(rebuiltRelative.person.unrelated, { retained: true });
  const rebuiltClinician = getNote(rebuilt, added.noteId);
  assert.equal(rebuiltClinician.title, 'Mira Finch, OD');
  assert.equal(rebuiltClinician.person.phone, '+1 415 555 0127');
  assert.match(rebuiltClinician.content, /fictional license FX-4242/);
  assert.match(rebuiltClinician.content, /8 January 2031 at 09:15/);
  assert.deepEqual(
    personSourceEvidence(rebuilt, existing.id, new URLSearchParams({ limit: '200' })),
    relativeSourceEvidence,
  );
  assert.deepEqual(
    personSourceEvidence(rebuilt, added.noteId, new URLSearchParams({ limit: '200' })),
    clinicianSourceEvidence,
  );
  assert.equal(
    rebuilt.prepare("SELECT count(*) AS n FROM evidence WHERE entity_type='person'").get()!.n,
    2,
  );
  assert.equal(
    rebuilt
      .prepare("SELECT count(*) AS n FROM app_meta WHERE key GLOB 'personal_assistant_*'")
      .get()!.n,
    2,
  );
  assert.deepEqual(
    readFileSync(intake.verifyIntakeOriginal(rebuilt, f.rebuiltRoot, f.profileId, item.id).path),
    originalBytes,
  );
  const rebuiltQueue = getIntakePeopleQueue(rebuilt, f.rebuiltRoot, f.profileId, groupId);
  assert.equal(
    rebuiltQueue.people.every((person) => person.state === 'saved'),
    true,
  );
  const rebuiltDraftStates = (
    intake.getIntake(rebuilt, f.rebuiltRoot, f.profileId, item.id).workflow as unknown as {
      peopleDrafts: { state: string }[];
    }
  ).peopleDrafts.map((draft) => draft.state);
  assert.deepEqual(rebuiltDraftStates, ['later', 'excluded', 'pending']);
  assert.deepEqual(rebuilt.prepare('PRAGMA foreign_key_check').all(), []);
});

for (const knownName of [false, true])
  test(`saved ${knownName ? 'alias' : 'full name'} cannot create another Person and exact matches report truncation`, (t) => {
    const f = fixture(t);
    const self = getNote(f.db, 'patient');
    saveNote(f.db, self.id, {
      version: self.version,
      person: {
        ...self.person,
        fullName: knownName ? 'Fictional Mira Brook' : 'Mira Finch',
        ...(knownName ? { knownNames: ['Mira Finch'] } : {}),
      },
    });
    const existingPeople = Array.from({ length: 21 }, (_, index) =>
      createNote(f.db, {
        kind: 'person',
        title: `Mira Finch ${index}`,
        person: { fullName: 'Mira Finch' },
      }),
    );
    attachPersonalDurability(f.db, { root: f.root, profileId: f.profileId });
    const item = intake.uploadIntake(f.db, f.root, f.profileId, {
      filename: 'fictional-self-name.jsonl',
      newProviderName: 'Fictional archive',
      bytes: Buffer.from(JSON.stringify(envelope())),
    });
    const groupId = item.workflow!.reportGroups![0]!.id;
    const person = getIntakePeopleQueue(f.db, f.root, f.profileId, groupId).people.find(
      (candidate) => candidate.person.fullName === 'Mira Finch',
    )!;
    assert.equal(person.matchCount, 21);
    assert.equal(person.matches.length, 20);
    assert.equal(person.matchesTruncated, true);
    assert.match(person.selfMatch!.reason, /matches Self/i);
    assert.throws(
      () =>
        applyIntakePerson(f.db, f.root, f.profileId, {
          operationId: uuid('10'),
          intakeId: item.id,
          proposalId: person.id,
          proposalVersion: person.version,
          action: 'add',
        }),
      (error: unknown) => error instanceof Error && /matches Self/i.test(error.message),
    );
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_records').get()!.n, 0);
    assert.equal(
      f.db
        .prepare("SELECT count(*) AS n FROM app_meta WHERE key GLOB 'personal_assistant_*'")
        .get()!.n,
      0,
    );
    const omittedMatch = existingPeople.find(
      (candidate) => !person.matches.some((match) => match.noteId === candidate.id),
    )!;
    const currentSelf = getNote(f.db, 'patient');
    saveNote(f.db, currentSelf.id, {
      version: currentSelf.version,
      person: { ...currentSelf.person, fullName: 'Different Fictional Self', knownNames: [] },
    });
    const updated = applyIntakePerson(f.db, f.root, f.profileId, {
      operationId: uuid('13'),
      intakeId: item.id,
      proposalId: person.id,
      proposalVersion: person.version,
      action: 'update',
      noteId: omittedMatch.id,
      version: omittedMatch.version,
    });
    assert.equal(updated.noteId, omittedMatch.id);
    assert.equal(getNote(f.db, omittedMatch.id).person.phone, '+1 415 555 0127');
  });

test('a failed Personal save leaves source durable and the exact Apply retry can recover', (t) => {
  const f = fixture(t);
  attachPersonalDurability(f.db, { root: f.root, profileId: f.profileId });
  const item = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-recoverable-person.jsonl',
    newProviderName: 'Fictional archive',
    bytes: Buffer.from(JSON.stringify(envelope())),
  });
  const groupId = item.workflow!.reportGroups![0]!.id;
  const person = getIntakePeopleQueue(f.db, f.root, f.profileId, groupId).people.find(
    (candidate) => candidate.person.fullName === 'Mira Finch',
  )!;
  const conflictingId = deterministicNoteId(person.id);
  createNote(f.db, {
    id: conflictingId,
    kind: 'note',
    title: 'Fictional transient conflict',
    content: 'This forces the Personal transaction to fail after source publication.',
  });
  const request = {
    operationId: uuid('11'),
    intakeId: item.id,
    proposalId: person.id,
    proposalVersion: person.version,
    action: 'add' as const,
  };
  assert.throws(
    () => applyIntakePerson(f.db, f.root, f.profileId, request),
    (error: unknown) => error instanceof Error && /note id was already used/i.test(error.message),
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_records').get()!.n, 1);
  assert.equal(
    getIntakePeopleQueue(f.db, f.root, f.profileId, groupId).people.find(
      (candidate) => candidate.id === person.id,
    )!.state,
    'pending',
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM app_meta WHERE key GLOB 'personal_assistant_*'").get()!
      .n,
    0,
  );
  transaction(f.db, () => f.db.prepare('DELETE FROM notes WHERE id=?').run(conflictingId));
  const saved = applyIntakePerson(f.db, f.root, f.profileId, request);
  assert.equal(saved.replayed, false);
  assert.equal(saved.noteId, conflictingId);
  assert.equal(getNote(f.db, saved.noteId).person.fullName, 'Mira Finch');
  assert.equal(
    getIntakePeopleQueue(f.db, f.root, f.profileId, groupId).people.find(
      (candidate) => candidate.id === person.id,
    )!.state,
    'saved',
  );
});
