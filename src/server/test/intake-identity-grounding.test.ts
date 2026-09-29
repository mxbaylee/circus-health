import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  retainIdentityGrounding,
  identitySubjectGroundingLookup,
  identityNameQuestionGroundingLookup,
  identityOriginalBirthDateEvidenceLookup,
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
