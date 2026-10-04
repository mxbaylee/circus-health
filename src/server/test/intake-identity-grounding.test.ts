import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  retainIdentityGrounding,
  identityReviewGroundingLookups,
  identitySubjectGroundingLookup,
  identityNameQuestionGroundingLookup,
  identityOriginalBirthDateEvidenceLookup,
  retainSelectedIdentityGrounding,
  clearIdentityGrounding,
} from '../intake-identity-grounding.ts';
import type { IntakeReportGroup } from '../../shared/intake.ts';

const group = (id: string): IntakeReportGroup => ({
  id,
  basis: 'report_anchor',
  sourceFileId: 'fictional-original',
  sourceHash: 'fictional-hash',
  sourceSystem: 'Fictional clinic',
  memberId: null,
  report: {
    key: id,
    title: 'Fictional report',
    anchor: { locator: 'page 1', text: 'Report ' + id },
    subject: { locator: 'page 1', text: 'Patient: Iris Meadow' },
  },
  versions: [
    {
      id: 'v1',
      createdAt: '2026-01-01',
      title: 'Fictional report',
      members: [],
      contributionId: 'fictional-contribution',
    },
  ],
});
const boundary = {
  profileId: 'fictional-profile',
  intakeId: 'fictional-original',
  sourceHash: 'fictional-hash',
  workflow: { plans: [], reportGroups: [] },
};

test('mixed native and legacy grounding eviction disposes complete SQL proofs and lock clear', () => {
  const db = new DatabaseSync(':memory:');
  const selected = {
    ...boundary,
    originalFingerprint: (current: { id: string }) => current.id,
    boundaryFingerprint: (current: { id: string }) => current.id,
  };
  const question = { prompt: 'Fictional exact question', textAnchor: 'Patient: Iris Meadow' };
  const count = () =>
    Number(db.prepare('SELECT count(*) n FROM intake_selected_identity_proofs').get()!.n);
  try {
    retainSelectedIdentityGrounding(
      db,
      selected,
      group('native'),
      [],
      true,
      (function* () {
        for (let n = 0; n < 1000; n++) yield { ...question, prompt: question.prompt + n };
      })(),
    );
    assert.equal(count(), 1000);
    for (let n = 0; n < 256; n++)
      retainIdentityGrounding(db, boundary, group('legacy-' + n), [], true);
    assert.equal(count(), 0);
    retainSelectedIdentityGrounding(db, selected, group('native-again'), [], true, [question]);
    assert.equal(count(), 1);
    clearIdentityGrounding(db);
    assert.equal(count(), 0);
    assert.equal(identitySubjectGroundingLookup(db, boundary)(group('legacy-255')), false);
    clearIdentityGrounding(db);
  } finally {
    db.close();
  }
});

test('new review snapshots recheck replaced proofs, membership, and database ownership', () => {
  const db = new DatabaseSync(':memory:');
  const other = new DatabaseSync(':memory:');
  try {
    const current = group('snapshot');
    const question = { prompt: 'Fictional identity question', textAnchor: 'Patient: Iris Meadow' };
    retainIdentityGrounding(db, boundary, current, [], true, [question], {
      dates: ['1986-02-14'],
      unreadable: false,
    });
    const review = identityReviewGroundingLookups(db, boundary);
    assert.equal(review.subjectGrounded(current), true);
    assert.equal(review.nameQuestionGrounded(current, question), true);
    const returned = review.originalBirthDateEvidence(current)!;
    returned.dates.push('1999-01-01');
    assert.deepEqual(review.originalBirthDateEvidence(current)?.dates, ['1986-02-14']);
    const grown = {
      ...current,
      versions: [...current.versions, { ...current.versions[0]!, id: 'v2' }],
    };
    assert.equal(review.subjectGrounded(grown), false);
    assert.deepEqual(review.originalBirthDateEvidence(grown)?.dates, ['1986-02-14']);
    assert.equal(identityReviewGroundingLookups(other, boundary).subjectGrounded(current), false);
    retainIdentityGrounding(db, boundary, current, [], false, [], { dates: [], unreadable: true });
    const next = identityReviewGroundingLookups(db, boundary);
    assert.equal(next.subjectGrounded(current), false);
    assert.equal(next.nameQuestionGrounded(current, question), false);
    assert.equal(next.originalBirthDateEvidence(current)?.unreadable, true);
  } finally {
    db.close();
    other.close();
  }
});

test('grounding atomically replaces negative proofs and evicts date facts together with name proofs', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const first = group('first');
    const question = {
      prompt: 'Does this report belong to you?',
      textAnchor: 'Patient: Iris Meadow',
    };
    retainIdentityGrounding(db, boundary, first, [], true, [question], {
      dates: ['1986-02-14'],
      unreadable: false,
    });
    assert.equal(identitySubjectGroundingLookup(db, boundary)(first), true);
    assert.equal(identityNameQuestionGroundingLookup(db, boundary)(first, question), true);
    retainIdentityGrounding(db, boundary, first, [], false, [], { dates: [], unreadable: true });
    assert.equal(identitySubjectGroundingLookup(db, boundary)(first), false);
    assert.equal(identityNameQuestionGroundingLookup(db, boundary)(first, question), false);
    assert.deepEqual(identityOriginalBirthDateEvidenceLookup(db, boundary)(first), {
      dates: [],
      unreadable: true,
    });
    retainIdentityGrounding(db, boundary, first, [], true, [question], {
      dates: ['1986-02-14'],
      unreadable: false,
    });
    for (let i = 0; i < 256; i++) retainIdentityGrounding(db, boundary, group(String(i)), [], true);
    assert.equal(identitySubjectGroundingLookup(db, boundary)(first), false);
    assert.equal(identityNameQuestionGroundingLookup(db, boundary)(first, question), false);
    assert.equal(identityOriginalBirthDateEvidenceLookup(db, boundary)(first), undefined);
  } finally {
    db.close();
  }
});

test('groups sharing one original report anchor keep separate grounded proofs', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const first = group('first');
    const second = { ...group('second'), report: first.report };
    const current = {
      ...boundary,
      workflow: { ...boundary.workflow, reportGroups: [first, second] },
    };
    const question = {
      prompt: 'Does this fictional report belong to you?',
      textAnchor: 'Patient: Iris Meadow',
    };
    retainIdentityGrounding(db, current, first, [], true, [question], {
      dates: ['1986-02-14'],
      unreadable: false,
    });
    retainIdentityGrounding(db, current, second, [], true, [question], {
      dates: ['1986-02-14'],
      unreadable: false,
    });
    assert.equal(identitySubjectGroundingLookup(db, current)(first), true);
    assert.equal(identitySubjectGroundingLookup(db, current)(second), true);
    assert.equal(identityNameQuestionGroundingLookup(db, current)(first, question), true);
    assert.equal(identityNameQuestionGroundingLookup(db, current)(second, question), true);
    retainIdentityGrounding(db, current, second, [], false, [], {
      dates: [],
      unreadable: true,
    });
    assert.equal(identitySubjectGroundingLookup(db, current)(first), true);
    assert.equal(identityNameQuestionGroundingLookup(db, current)(first, question), true);
    assert.deepEqual(identityOriginalBirthDateEvidenceLookup(db, current)(first), {
      dates: ['1986-02-14'],
      unreadable: false,
    });
    assert.equal(identitySubjectGroundingLookup(db, current)(second), false);
    assert.deepEqual(identityOriginalBirthDateEvidenceLookup(db, current)(second), {
      dates: [],
      unreadable: true,
    });
  } finally {
    db.close();
  }
});

test('immutable date facts survive membership growth while name proofs and other databases need rechecking', () => {
  const db = new DatabaseSync(':memory:'),
    cold = new DatabaseSync(':memory:');
  try {
    const current = group('growth');
    retainIdentityGrounding(db, boundary, current, [], true, [], {
      dates: [],
      unreadable: true,
      suggestions: ['1985-03-04'],
    });
    const grown = {
      ...current,
      versions: [...current.versions, { ...current.versions[0]!, id: 'v2' }],
    };
    assert.equal(identitySubjectGroundingLookup(db, boundary)(grown), false);
    const facts = identityOriginalBirthDateEvidenceLookup(db, boundary)(grown)!;
    assert.deepEqual(facts.suggestions, ['1985-03-04']);
    facts.suggestions!.push('1999-01-01');
    assert.deepEqual(identityOriginalBirthDateEvidenceLookup(db, boundary)(grown)?.suggestions, [
      '1985-03-04',
    ]);
    assert.equal(identitySubjectGroundingLookup(cold, boundary)(current), false);
    assert.equal(identityOriginalBirthDateEvidenceLookup(cold, boundary)(current), undefined);
  } finally {
    db.close();
    cold.close();
  }
});
