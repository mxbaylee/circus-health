import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { getNote, saveNote, createNote } from '../notes.ts';
import {
  uploadIntake,
  proposeConversion,
  reviewIntake,
  getIntake,
  importIntake,
  saveIntakeReviewDraft,
} from '../intake.ts';
import { getIntakeIdentityReview } from '../intake-identity.ts';
import { competingIdentityBoundaries, printedIdentityName } from '../intake-identity-policy.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';

const heading = 'Fictional composition report';
const name = 'Doe, Cookie';
const header = 'Doe, Cookie   Female   4/12/1988   64.0 in.   140.0 lbs.   8/11/2025';
const prompt =
  'Does this report for Doe, Cookie, birth date 4/12/1988, belong to you or another person?';
function fixture(
  t: TestContext,
  options: {
    wholeHeader?: boolean;
    family?: boolean;
    collision?: boolean;
    dob?: string;
    forgedAnchor?: boolean;
    specific?: boolean;
    count?: number;
    splitSubjectRoles?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-name-question-')),
    profile = 'cookie';
  const db = openDatabase(ensureProfileDirectories(root, profile).database, profile);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const self = getNote(db, 'person-note:self');
  saveNote(db, self.id, {
    version: self.version,
    person: {
      fullName: options.family ? 'Cookie Sample' : 'Cookie Doe',
      birthDate: options.dob || '1988-04-12',
    },
  });
  const family =
    options.family || options.collision
      ? createNote(db, {
          kind: 'person',
          title: 'Fictional family member',
          person: { fullName: 'Cookie Doe', birthDate: options.dob || '1988-04-12' },
        })
      : undefined;
  const subject = options.wholeHeader ? header : name;
  const original = `${heading}\n${options.forgedAnchor ? name : header}\nFictional count 12`;
  const item = uploadIntake(db, root, profile, {
    filename: 'fictional-cookie.txt',
    bytes: Buffer.from(original),
  });
  const value: HealthRecordEnvelope = {
    format: 'health-record-v1',
    id: 'count',
    kind: 'record',
    payload: `${heading}\n${header}\nFictional count 12`,
    provenance: {
      capturedVia: null,
      sourceSystem: 'Fictional clinic',
      sourceRecordId: 'count',
      evidenceClass: 'transcription',
      locator: 'page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'observation',
      subject: 'unknown',
      testLabel: 'Fictional count',
      valueText: '12',
      unit: 'fictional units',
      date: '2025-08-11',
    },
    report: {
      key: 'cookie',
      title: heading,
      anchor: { locator: 'page 1 heading', text: heading },
      subject: { locator: 'page 1 subject', text: subject },
    },
    reviewIssues: [
      {
        kind: 'identity',
        field: 'subject',
        prompt: options.specific
          ? 'Is the corrected patient name reliable, or does this page combine two people?'
          : prompt,
        textAnchor: header,
      },
    ],
  };
  const proposed = proposeConversion(db, root, profile, item.id, {
    version: item.version,
    summary: 'Fictional extraction',
    jsonlText: (options.splitSubjectRoles
      ? [
          value,
          {
            ...value,
            id: 'second-count',
            provenance: { ...value.provenance, sourceRecordId: 'second-count' },
            clinical: {
              ...(value.clinical as object),
              subject: 'self',
              testLabel: 'Second fictional count',
            },
          },
          {
            ...value,
            id: 'header',
            provenance: { ...value.provenance, sourceRecordId: 'header' },
            kind: 'document',
            payload: { text: original },
            clinical: { kind: 'document', subject: 'unknown', documentTitle: heading },
            report: { ...value.report!, subject: null },
            reviewIssues: undefined,
          },
        ]
      : Array.from({ length: options.count || 1 }, (_, index) => ({
          ...value,
          id: index ? `count-${index}` : value.id,
        }))
    )
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  });
  const proposal = proposed.proposals[0]!.id,
    group = proposed.workflow!.reportGroups![0]!.id;
  return {
    db,
    root,
    profile,
    item: proposed,
    proposal,
    group,
    value,
    family,
    read: () => reviewIntake(db, root, profile, item.id, proposal),
    preview: () => getIntakeIdentityReview(db, root, profile, item.id, group),
  };
}

for (const wholeHeader of [false, true])
  for (const family of [false, true])
    test(`a grounded unique ${family ? 'Person' : 'Self'} name resolves a generic question with ${wholeHeader ? 'demographic' : 'name-only'} subject`, async (t) => {
      const f = fixture(t, { wholeHeader, family });
      assert.equal(f.read().records[0]!.identityReview?.blocking, true);
      const identity = await f.preview();
      assert.equal(identity.status, 'evidenced_match');
      assert.equal(identity.blocking, false);
      assert.equal(identity.evidencedIdentity.fullName, name);
      assert.equal(
        identity.evidencedIdentity.birthDate,
        undefined,
        'ambiguous numeric DOB is neither normalized nor offered',
      );
      const review = f.read(),
        record = review.records[0]!;
      assert.equal(record.identityReview?.blocking, false);
      assert.ok(
        record
          .issues!.filter((issue) => issue.kind === 'identity')
          .every((issue) => !issue.blocking),
      );
      assert.equal(
        record.identityAttribution?.basis,
        family ? 'matched_saved_person' : 'matched_saved_self',
      );
      importIntake(f.db, f.root, f.profile, f.item.id, {
        version: review.version,
        proposalId: f.proposal,
        reviewToken: review.reviewToken,
        decisions: [{ recordId: record.id, action: 'accept', mapping: {} }],
      });
      assert.equal(
        f.db.prepare('SELECT person_id FROM observations').get()!.person_id,
        f.family?.personId || 'patient',
      );
      assert.equal(
        getIntake(f.db, f.root, f.profile, f.item.id).workflow?.identityConfirmations?.length || 0,
        0,
      );
    });

for (const [label, options] of Object.entries({
  collision: { collision: true },
  'contradictory DOB': { dob: '1970-02-03' },
  'ungrounded anchor': { forgedAnchor: true },
  'specific uncertainty': { specific: true },
}))
  test(`${label} still requires identity review`, async (t) => {
    const f = fixture(t, options);
    const identity = await f.preview();
    assert.equal(identity.blocking, true);
    assert.equal(f.read().records[0]!.identityReview?.blocking, true);
  });

test('human unknown answers and changed report membership revoke a generic question match', async (t) => {
  const f = fixture(t);
  await f.preview();
  const review = f.read(),
    record = review.records[0]!;
  saveIntakeReviewDraft(f.db, f.root, f.profile, f.item.id, {
    version: review.version,
    operationId: 'fictional-unknown',
    proposalId: f.proposal,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    resolutions: [
      { issueId: record.issues!.find((issue) => issue.prompt === prompt)!.id, outcome: 'unknown' },
    ],
  });
  assert.equal(f.read().records[0]!.identityReview?.blocking, true);
  assert.equal((await f.preview()).blocking, true);
  const another = fixture(t);
  await another.preview();
  proposeConversion(another.db, another.root, another.profile, another.item.id, {
    version: getIntake(another.db, another.root, another.profile, another.item.id).version,
    summary: 'Fictional later count',
    jsonlText: JSON.stringify({ ...another.value, id: 'later-count' }),
  });
  assert.equal(another.read().records[0]!.identityReview?.blocking, true);
});

test('header parsing does not invent a person from ambiguous names or arbitrary prose', () => {
  assert.equal(printedIdentityName(header), name);
  assert.equal(printedIdentityName('Cookie Doe and Sample Doe   Female   4/12/1988'), undefined);
  assert.equal(printedIdentityName(header + '   Patient: Cookie Sample'), undefined);
  assert.equal(
    printedIdentityName('Report for Cookie Doe with a birth date of 4/12/1988'),
    undefined,
  );
});

test('one repeated generic question can cover more than one hundred grounded results', async (t) => {
  const f = fixture(t, { count: 125 });
  assert.equal((await f.preview()).blocking, false);
  assert.equal(f.read().records.length, 125);
  assert.ok(f.read().records.every((record) => record.identityReview?.blocking === false));
});

test('a competing subject at the same report boundary invalidates the earlier question proof', async (t) => {
  const f = fixture(t);
  await f.preview();
  assert.equal(f.read().records[0]!.identityReview?.blocking, false);
  const other = {
    ...f.value,
    id: 'other-person',
    payload: `${heading}\nCookie Sample`,
    report: { ...f.value.report!, subject: { locator: 'page 1 subject', text: 'Cookie Sample' } },
    reviewIssues: undefined,
  };
  proposeConversion(f.db, f.root, f.profile, f.item.id, {
    version: getIntake(f.db, f.root, f.profile, f.item.id).version,
    summary: 'Fictional competing subject',
    jsonlText: JSON.stringify(other),
  });
  assert.equal(f.read().records[0]!.identityReview?.blocking, true);
  assert.equal((await f.preview()).blocking, true);
  const review = f.read();
  assert.throws(() =>
    importIntake(f.db, f.root, f.profile, f.item.id, {
      version: review.version,
      reviewToken: review.reviewToken,
      proposalId: f.proposal,
      decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
    }),
  );
});

test('unanchored Self assertions are not competing report subjects in an unnamed profile', (t) => {
  const f = fixture(t);
  const self = getNote(f.db, 'person-note:self');
  saveNote(f.db, self.id, { version: self.version, person: { fullName: '', birthDate: null } });
  const values = ['one', 'two'].map((id) => ({
    ...f.value,
    id,
    report: undefined,
    reviewIssues: undefined,
    payload: `Fictional unanchored result ${id}`,
    provenance: { ...f.value.provenance, sourceRecordId: `unanchored-${id}` },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: `Fictional unanchored count ${id}`,
      valueText: '12',
      unit: 'fictional units',
      date: '2025-08-11',
    },
  }));
  const item = uploadIntake(f.db, f.root, f.profile, {
    filename: 'fictional-unanchored.jsonl',
    bytes: Buffer.from(values.map((value) => JSON.stringify(value)).join('\n')),
  });
  const review = reviewIntake(f.db, f.root, f.profile, item.id);
  assert.equal(review.records.length, 2);
  assert.ok(
    review.records.every(
      (record) =>
        record.identityReview?.status === 'missing_warning' && !record.identityReview.blocking,
    ),
  );
  importIntake(f.db, f.root, f.profile, item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: review.records.map((record) => ({
      recordId: record.id,
      action: 'accept' as const,
      mapping: {},
    })),
  });
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
});

test('first upload: one proposal with header, self and unknown roles can be reviewed and saved without compaction', async (t) => {
  const f = fixture(t, { splitSubjectRoles: true });
  assert.equal(f.item.proposals.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 0);
  assert.ok(
    f.item.workflow!.reportGroups!.length > 1,
    'exercise separate model groups in the very first proposal',
  );
  for (const group of f.item.workflow!.reportGroups!) {
    const preview = await getIntakeIdentityReview(f.db, f.root, f.profile, f.item.id, group.id);
    assert.equal(preview.blocking, false, preview.message);
  }
  const review = f.read();
  assert.equal(review.records.length, 3);
  for (const record of review.records)
    assert.equal(record.identityReview?.blocking, false, record.identityReview?.message);
  assert.equal(
    getIntake(f.db, f.root, f.profile, f.item.id).version,
    f.item.version,
    'rechecking stored groups does not mutate the import',
  );
  importIntake(f.db, f.root, f.profile, f.item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    proposalId: f.proposal,
    decisions: review.records.map((record) => ({
      recordId: record.id,
      action: 'accept' as const,
      mapping: record.mapping,
    })),
  });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM observations').get()!.n, 2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 1);
});

test('competing boundaries require different printed identity in the same original report', (t) => {
  const f = fixture(t);
  const group = f.item.workflow!.reportGroups![0]!;
  const variant = (text: string | null) => ({
    ...structuredClone(group),
    id: 'another-extraction-group',
    report: {
      ...structuredClone(group.report!),
      subject: text === null ? null : { text, locator: 'a different subject locator' },
    },
  });
  for (const text of [name, 'Cookie Doe', 'Patient: Cookie Doe', null]) {
    const other = variant(text);
    assert.deepEqual(competingIdentityBoundaries(group, [group, other]), [], String(text));
    assert.deepEqual(competingIdentityBoundaries(other, [group, other]), [], String(text));
  }
  const different = variant('Cookie Sample');
  assert.deepEqual(competingIdentityBoundaries(group, [group, different]), [different]);
  for (const changed of [
    { ...different, sourceFileId: 'another-original' },
    { ...different, sourceHash: 'another-hash' },
    { ...different, memberId: 'another-package-member' },
  ])
    assert.deepEqual(competingIdentityBoundaries(group, [group, changed]), []);
  const firstDob = variant('Patient: Cookie Doe; DOB: 1988-04-12');
  const secondDob = { ...variant('Patient: Cookie Doe; DOB: 1989-04-12'), id: 'changed-dob' };
  assert.deepEqual(competingIdentityBoundaries(firstDob, [firstDob, secondDob]), [secondDob]);
});

test('import corrections retain per-update reasons and before/after values through acceptance', async (t) => {
  const f = fixture(t);
  await f.preview();
  let review = f.read();
  let record = review.records[0]!;
  const base = {
    version: review.version,
    proposalId: f.proposal,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
  };
  for (const reason of ['', ' '.repeat(2), 'x'.repeat(10001)])
    assert.throws(
      () =>
        saveIntakeReviewDraft(f.db, f.root, f.profile, f.item.id, {
          ...base,
          operationId: 'invalid-reason',
          mapping: { valueText: '18' },
          correctionReason: reason,
        }),
      { code: 'CORRECTION_REASON' },
    );
  assert.throws(
    () =>
      saveIntakeReviewDraft(f.db, f.root, f.profile, f.item.id, {
        ...base,
        operationId: 'invalid-date',
        mapping: { date: '2026-02-30' },
        correctionReason: 'Check original date',
      }),
    { code: 'IMPORT_DATE' },
  );
  const update = {
    ...base,
    operationId: 'cookie-value-correction',
    mapping: { valueText: '18' },
    correctionReason: 'Read the value in the original',
  };
  saveIntakeReviewDraft(f.db, f.root, f.profile, f.item.id, update);
  saveIntakeReviewDraft(f.db, f.root, f.profile, f.item.id, update);
  review = f.read();
  record = review.records[0]!;
  assert.equal(record.draft!.corrections!.length, 1);
  assert.deepEqual(record.draft!.corrections![0]!.before, { valueText: '12' });
  assert.deepEqual(record.draft!.corrections![0]!.after, { valueText: '18' });
  saveIntakeReviewDraft(f.db, f.root, f.profile, f.item.id, {
    ...base,
    version: review.version,
    operationId: 'cookie-unit-correction',
    mapping: { unit: 'count' },
    correctionReason: 'Corrected the unit from the original',
  });
  review = f.read();
  record = review.records[0]!;
  assert.equal(record.draft!.corrections!.length, 2);
  importIntake(f.db, f.root, f.profile, f.item.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    proposalId: f.proposal,
    decisions: [{ recordId: record.id, action: 'accept', mapping: record.mapping }],
  });
  const row = f.db.prepare('SELECT extra_json FROM observations').get()!;
  const saved = JSON.parse(String(row.extra_json));
  assert.equal(saved.import.manuallyEdited, true);
  assert.deepEqual(
    saved.import.corrections.map((entry: { reason: string }) => entry.reason),
    ['Read the value in the original', 'Corrected the unit from the original'],
  );
});
