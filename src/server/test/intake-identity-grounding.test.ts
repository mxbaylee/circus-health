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
  identityGroundingGeneration,
  identityGroundingSourceStamp,
  selectedIdentityReviewGroundingLookups,
} from '../intake-identity-grounding.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
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
const selectedBoundary = {
  ...boundary,
  originalFingerprint: (current: { id: string }) => current.id,
  boundaryFingerprint: (current: { id: string }) => current.id,
};
const sqlStamp = (db: DatabaseSync) =>
  JSON.stringify([
    db.prepare('SELECT total_changes() AS changes').get()!.changes,
    db.prepare('PRAGMA data_version').get()!.data_version,
    db.prepare('PRAGMA schema_version').get()!.schema_version,
    db.prepare('PRAGMA temp.schema_version').get()!.schema_version,
  ]);

test('grounding source certificates change only their actual live proof owner and clear never restores old captures', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const a = { ...selectedBoundary, intakeId: 'fictional-a' },
      b = { ...selectedBoundary, intakeId: 'fictional-b' },
      aGroup = group('a'),
      bGroup = group('b'),
      emptyA = identityGroundingSourceStamp(db, a.intakeId),
      emptyB = identityGroundingSourceStamp(db, b.intakeId);
    retainSelectedIdentityGrounding(db, a, aGroup, [], true);
    const publishedA = identityGroundingSourceStamp(db, a.intakeId);
    assert.notEqual(publishedA, emptyA);
    assert.equal(identityGroundingSourceStamp(db, b.intakeId), emptyB);
    const generation = identityGroundingGeneration(db);
    retainSelectedIdentityGrounding(db, a, aGroup, [], true);
    assert.equal(identityGroundingSourceStamp(db, a.intakeId), publishedA);
    assert.equal(identityGroundingGeneration(db), generation);
    retainSelectedIdentityGrounding(db, b, bGroup, [], true);
    assert.equal(identityGroundingSourceStamp(db, a.intakeId), publishedA);
    assert.notEqual(identityGroundingSourceStamp(db, b.intakeId), emptyB);
    clearIdentityGrounding(db);
    const clearedA = identityGroundingSourceStamp(db, a.intakeId);
    assert.notEqual(clearedA, publishedA);
    assert.notEqual(clearedA, emptyA);
    retainSelectedIdentityGrounding(db, a, aGroup, [], true);
    assert.notEqual(identityGroundingSourceStamp(db, a.intakeId), publishedA);
  } finally {
    db.close();
  }
});

test('zero-question native publications invalidate memory certificates with unchanged SQL and preserve identical facts', () => {
  const db = new DatabaseSync(':memory:');
  const cold = new DatabaseSync(':memory:');
  try {
    const first = group('first-zero'),
      second = group('second-zero');
    retainSelectedIdentityGrounding(db, selectedBoundary, first, [], true);
    const beforeSql = sqlStamp(db),
      beforeRead = reviewReadStamp(db),
      beforeGeneration = identityGroundingGeneration(db);
    const held = selectedIdentityReviewGroundingLookups(db, selectedBoundary);
    assert.equal(held.subjectGrounded(second), false);
    const dates = {
      dates: ['1986-02-14'],
      unreadable: false,
      suggestions: ['1986-02'],
      bannerDates: [['1986-02-14', '1986-14-02']],
    };
    retainSelectedIdentityGrounding(db, selectedBoundary, second, [], true, [], dates);
    assert.equal(sqlStamp(db), beforeSql);
    assert.notEqual(reviewReadStamp(db), beforeRead);
    assert.notEqual(identityGroundingGeneration(db), beforeGeneration);
    assert.throws(() => held.subjectGrounded(second), /Identity grounding snapshot changed/);
    const current = selectedIdentityReviewGroundingLookups(db, selectedBoundary);
    assert.equal(current.subjectGrounded(second), true);
    assert.deepEqual(current.originalBirthDateEvidence(second), dates);
    const published = identityGroundingGeneration(db),
      stamp = reviewReadStamp(db);
    retainSelectedIdentityGrounding(
      db,
      selectedBoundary,
      second,
      [],
      true,
      [],
      structuredClone(dates),
    );
    assert.equal(identityGroundingGeneration(db), published);
    assert.equal(reviewReadStamp(db), stamp);
    assert.equal(current.subjectGrounded(second), true);
    assert.notEqual(identityGroundingGeneration(cold), published);
    retainSelectedIdentityGrounding(db, selectedBoundary, second, [], true, [], {
      ...dates,
      bannerDates: [['1987-02-14']],
    });
    assert.notEqual(
      identityGroundingGeneration(db),
      published,
      'all DOB evidence fields participate',
    );
    const negative = selectedIdentityReviewGroundingLookups(db, selectedBoundary);
    const beforeClearSql = sqlStamp(db),
      beforeClear = reviewReadStamp(db);
    clearIdentityGrounding(db);
    assert.equal(sqlStamp(db), beforeClearSql);
    assert.notEqual(reviewReadStamp(db), beforeClear);
    assert.throws(() => negative.subjectGrounded(second), /Identity grounding snapshot changed/);
    assert.equal(
      selectedIdentityReviewGroundingLookups(db, selectedBoundary).subjectGrounded(second),
      false,
    );
  } finally {
    db.close();
    cold.close();
  }
});

test('streamed duplicate/reordered proofs preserve semantics and failed candidate iteration preserves prior complete grounding', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const current = group('streamed'),
      first = { prompt: 'Fictional first', textAnchor: 'Iris' },
      second = { prompt: 'Fictional second', textAnchor: 'Meadow' };
    retainSelectedIdentityGrounding(db, selectedBoundary, current, [], true, [first, second]);
    const generation = identityGroundingGeneration(db),
      prior = selectedIdentityReviewGroundingLookups(db, selectedBoundary);
    retainSelectedIdentityGrounding(
      db,
      selectedBoundary,
      current,
      [],
      true,
      (function* () {
        yield second;
        yield first;
        yield first;
      })(),
    );
    assert.equal(identityGroundingGeneration(db), generation);
    assert.equal(prior.nameQuestionGrounded(current, first), true);
    const stamp = reviewReadStamp(db);
    assert.throws(
      () =>
        retainSelectedIdentityGrounding(
          db,
          selectedBoundary,
          current,
          [],
          false,
          (function* () {
            yield { ...first, prompt: 'Fictional unpublished' };
            throw Error('Fictional iterator failure');
          })(),
        ),
      /Fictional iterator failure/,
    );
    assert.equal(identityGroundingGeneration(db), generation);
    assert.notEqual(
      reviewReadStamp(db),
      stamp,
      'partial SQL staging cannot reuse a cached read stamp',
    );
    assert.equal(prior.subjectGrounded(current), true);
    assert.equal(prior.nameQuestionGrounded(current, second), true);
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM intake_selected_identity_proofs').get()!.count,
      2,
    );
    const held = selectedIdentityReviewGroundingLookups(db, selectedBoundary);
    db.close();
    assert.throws(() => held.subjectGrounded(current), /Identity grounding snapshot changed/);
  } finally {
    if (db.isOpen) db.close();
  }
});

test('legacy semantic replacement and failed native disposal invalidate before removing authority', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const current = group('legacy-negative');
    retainIdentityGrounding(db, boundary, current, [], true);
    const generation = identityGroundingGeneration(db),
      stamp = reviewReadStamp(db),
      rawSql = sqlStamp(db);
    retainIdentityGrounding(db, boundary, current, [], false, [], { dates: [], unreadable: true });
    assert.equal(sqlStamp(db), rawSql);
    assert.notEqual(identityGroundingGeneration(db), generation);
    assert.notEqual(reviewReadStamp(db), stamp);
    const negative = identityGroundingGeneration(db);
    retainIdentityGrounding(db, boundary, current, [], false, [], { dates: [], unreadable: true });
    assert.equal(identityGroundingGeneration(db), negative);
    retainSelectedIdentityGrounding(db, selectedBoundary, group('native-disposal'), [], true);
    const held = selectedIdentityReviewGroundingLookups(db, selectedBoundary),
      captured = identityGroundingGeneration(db);
    assert.equal(held.subjectGrounded(group('native-disposal')), true);
    db.exec(
      "CREATE TEMP TRIGGER fictional_grounding_disposal BEFORE DELETE ON intake_selected_identity_proofs BEGIN SELECT RAISE(FAIL,'Fictional disposal failure'); END",
    );
    retainSelectedIdentityGrounding(db, selectedBoundary, group('native-disposal'), [], true, [
      { prompt: 'Fictional proof', textAnchor: 'Iris' },
    ]);
    const disposable = identityGroundingGeneration(db);
    assert.notEqual(disposable, captured);
    assert.throws(
      () =>
        retainSelectedIdentityGrounding(db, selectedBoundary, group('native-disposal'), [], false),
      /Fictional disposal failure/,
    );
    assert.notEqual(identityGroundingGeneration(db), disposable);
    assert.throws(
      () => held.subjectGrounded(group('native-disposal')),
      /Identity grounding snapshot changed/,
    );
    db.exec('DROP TRIGGER fictional_grounding_disposal');
    assert.equal(
      selectedIdentityReviewGroundingLookups(db, selectedBoundary).subjectGrounded(
        group('native-disposal'),
      ),
      false,
    );
  } finally {
    db.close();
  }
});

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
