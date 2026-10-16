import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalLiteral } from '../intake-format.ts';
import { identityScopeCommitmentsWork } from '../intake-identity-commitment.ts';

const scope = () => ({
  intakeVersion: 4,
  profileId: 'fictional',
  intakeId: 'fictional-intake',
  selfVersion: 3,
  groupId: 'fictional-report',
  groupVersionId: 'fictional-report-v1',
  sourceHash: 'fictional-source',
  subject: { text: 'Fictional Iris Meadow', locator: 'page 1 patient' },
  membership: [{ candidateId: 'fictional-A', occurrences: [{ recordId: 'fictional-R' }] }],
  targets: [{ recordId: 'fictional-R', issueId: 'fictional-question' }],
  assignmentTargets: [{ recordId: 'fictional-R', issueIds: ['fictional-question'] }],
  questions: [{ prompt: 'Fictional question 🌿', textAnchor: 'Fictional evidence' }],
  competingSubjects: [{ groupId: 'fictional-other', subject: { text: 'Fictional Other Person' } }],
});
function digest(
  value = scope(),
  warnings: unknown[] = [
    {
      kind: 'model_birth_date_mismatch',
      modelBirthDate: '1991-01-01',
      savedBirthDate: '1992-01-01',
      personName: 'Fictional Iris Meadow',
    },
  ],
) {
  const { membership, targets, assignmentTargets, questions, competingSubjects, ...header } = value;
  const traversals = new Map<string, number>();
  const chunks = (key: string, rows: unknown) =>
    (function* () {
      traversals.set(key, (traversals.get(key) || 0) + 1);
      assert.equal(traversals.get(key), 1, key + ' must not be reread');
      // Split at every character to qualify arbitrary bounded chunk boundaries.
      const text = canonicalLiteral(rows);
      for (let at = 0; at < text.length; at++) yield text.slice(at, at + 1);
    })();
  const work = identityScopeCommitmentsWork({
    header,
    sourceHash: 'fictional-original-source',
    sections: {
      membership: chunks('membership', membership),
      targets: chunks('targets', targets),
      assignmentTargets: chunks('assignmentTargets', assignmentTargets),
      questions: chunks('questions', questions),
      competingSubjects: chunks('competingSubjects', competingSubjects),
    },
    warnings: chunks('warnings', warnings),
  });
  let result = work.next();
  while (!result.done) result = work.next();
  assert.equal(traversals.size, 6);
  assert.equal(
    result.value.scopeToken,
    createHash('sha256')
      .update(canonicalLiteral([value, 'fictional-original-source']))
      .digest('hex'),
  );
  const { intakeVersion: _intakeVersion, ...stable } = value;
  assert.equal(
    result.value.evidenceCommitment.sha256,
    createHash('sha256')
      .update(
        canonicalLiteral([
          'health-intake-identity-evidence-v1',
          stable,
          'fictional-original-source',
          warnings,
        ]),
      )
      .digest('hex'),
  );
  return result.value;
}

test('paired native stream preserves the literal legacy token and stable version-only proof', () => {
  const old = digest(),
    fresh = digest({ ...scope(), intakeVersion: 5 });
  assert.notEqual(old.scopeToken, fresh.scopeToken);
  assert.deepEqual(old.evidenceCommitment, fresh.evidenceCommitment);
});

test('same-count hidden evidence replacements change the complete proof', async (t) => {
  const baseline = digest();
  const replacements = [
    {
      ...scope(),
      membership: [
        {
          candidateId: 'fictional-B',
          occurrences: [{ recordId: 'fictional-R' }],
        },
      ],
    },
    {
      ...scope(),
      membership: [
        {
          candidateId: 'fictional-A',
          occurrences: [{ recordId: 'fictional-S' }],
        },
      ],
    },
    {
      ...scope(),
      targets: [{ recordId: 'fictional-S', issueId: 'fictional-question' }],
    },
    {
      ...scope(),
      assignmentTargets: [{ recordId: 'fictional-R', issueIds: ['fictional-other-question'] }],
    },
    {
      ...scope(),
      questions: [
        {
          prompt: 'A changed fictional question',
          textAnchor: 'Fictional evidence',
        },
      ],
    },
    {
      ...scope(),
      competingSubjects: [
        {
          groupId: 'fictional-other',
          subject: { text: 'Fictional Third Person' },
        },
      ],
    },
    { ...scope(), selfVersion: 4 },
    {
      ...scope(),
      subject: { ...scope().subject, text: 'Changed fictional identity' },
    },
  ];
  for (const value of replacements)
    await t.test(
      Object.keys(value).find(
        (key) =>
          canonicalLiteral(value[key as keyof typeof value]) !==
          canonicalLiteral(scope()[key as keyof ReturnType<typeof scope>]),
      )!,
      () => {
        assert.notEqual(
          digest(value).evidenceCommitment.sha256,
          baseline.evidenceCommitment.sha256,
        );
      },
    );
  assert.notEqual(
    digest(scope(), [
      {
        kind: 'model_birth_date_mismatch',
        modelBirthDate: '1993-01-01',
        savedBirthDate: '1992-01-01',
        personName: 'Fictional Iris Meadow',
      },
    ]).evidenceCommitment.sha256,
    baseline.evidenceCommitment.sha256,
  );
});

test('retained question hashing yields to current authority checks and closes on drift', async () => {
  const { identitySnapshotQuestionHashWork } = await import('../intake-identity-commitment.ts');
  const { runClinicalReviewWork } = await import('../clinical-review-work.ts');
  const pieces = Array.from(
    { length: 80 },
    (_, n) => String(n).padStart(4, '0') + '🌿'.repeat(510),
  );
  let heartbeat = false,
    boundaries = 0;
  setImmediate(() => {
    heartbeat = true;
  });
  const digest = await runClinicalReviewWork(identitySnapshotQuestionHashWork(pieces), {
    capture() {
      boundaries++;
      return () => assert.equal(heartbeat, true);
    },
  });
  assert.equal(digest, createHash('sha256').update(pieces.join('')).digest('hex'));
  assert.ok(boundaries >= 5);
  let changed = false,
    closed = false,
    read = 0;
  setImmediate(() => {
    changed = true;
  });
  const producer = (function* () {
    try {
      for (const piece of pieces) {
        read++;
        yield piece;
      }
    } finally {
      closed = true;
    }
  })();
  await assert.rejects(
    runClinicalReviewWork(identitySnapshotQuestionHashWork(producer), {
      capture() {
        return () => {
          if (changed) throw Error('Fictional current authority drift');
        };
      },
    }),
    /current authority drift/,
  );
  assert.equal(read, 16);
  assert.equal(closed, true);
});
