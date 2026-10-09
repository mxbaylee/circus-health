import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDatabase } from '../database.ts';
import {
  bindReviewRecordIssues,
  inlineReviewRecordIssues,
  inlineReviewRecordIssuesWork,
  reviewIssueFactory,
} from '../intake-review-issue-state.ts';
import { canonicalLiteral } from '../intake-format.ts';
import { runClinicalReviewWork } from '../clinical-review-work.ts';
import type { IntakeReviewIssue, IntakeReviewRecord } from '../../shared/intake.ts';

const issue = (n: number): IntakeReviewIssue => ({
  id: `fictional-issue-${n}`,
  kind: 'uncertain_reading',
  field: 'documentTitle',
  prompt: `Confirm fictional title ${n}`,
  blocking: true,
  status: 'unresolved',
  locator: `page ${n + 1}`,
  questionId: `fictional-question-${n}`,
  resolution: undefined,
});

function fixture(count: number) {
  const db = openDatabase(':memory:', 'fictional-profile');
  let current = true;
  const factory = reviewIssueFactory(db, {
    sourceId: 'fictional-source',
    generation: 'fictional-pins',
    assertCurrent() {
      if (!current) throw Error('Fictional source invalidated');
    },
  });
  const record = {
    id: 'fictional-record',
    candidateVersionId: 'fictional-version',
  } as IntakeReviewRecord;
  const selected = factory(record);
  for (let n = 0; n < count; n++) selected.push(issue(n));
  bindReviewRecordIssues(record, selected);
  return {
    db,
    factory,
    selected,
    record,
    invalidate() {
      current = false;
    },
    close() {
      factory.dispose();
      db.close();
    },
  };
}

test('inline issue policy yields across all retained issues and preserves the canonical token', async () => {
  for (const count of [4, 65]) {
    const scope = fixture(count);
    try {
      const record = scope.record;
      const work = inlineReviewRecordIssuesWork(record, 0);
      let visits = 0;
      for (;;) {
        const step = work.next();
        if (step.done) {
          assert.equal(step.value, 0);
          break;
        }
        visits++;
      }
      assert.equal(visits, count);
      assert.equal(record.issues, undefined);
      assert.equal(record.issuesReference?.count, count);
      assert.equal(
        record.issuesReference?.token,
        createHash('sha256')
          .update(canonicalLiteral(Array.from({ length: count }, (_, n) => issue(n))))
          .digest('hex'),
      );
      let turns = 0;
      assert.equal(
        await runClinicalReviewWork(inlineReviewRecordIssuesWork(record, 0), {
          capture() {
            turns++;
            return () => undefined;
          },
        }),
        0,
      );
      assert.equal(turns, Math.floor(count / 16));
    } finally {
      scope.close();
    }
  }
});

test('inline issue policy refuses invalidation without publishing a partial token or inline list', () => {
  const scope = fixture(65);
  try {
    const ref = scope.record.issuesReference!;
    const work = inlineReviewRecordIssuesWork(scope.record, 128 * 1024);
    assert.equal(work.next().done, false);
    scope.invalidate();
    assert.throws(() => work.next(), /invalidated/);
    assert.equal(ref.token, '');
    assert.equal(scope.record.issues, undefined);
    assert.equal(scope.record.issuesReference, ref);
  } finally {
    scope.close();
  }
});

test('empty referenced issue policy rechecks source and count after its checkpoint', () => {
  const invalidated = fixture(0);
  try {
    const ref = invalidated.record.issuesReference!;
    const work = inlineReviewRecordIssuesWork(invalidated.record, 0);
    assert.equal(work.next().done, false);
    invalidated.invalidate();
    assert.throws(() => work.next(), /invalidated/);
    assert.equal(ref.token, '');
    assert.equal(invalidated.record.issuesReference, ref);
  } finally {
    invalidated.close();
  }

  const changed = fixture(0);
  try {
    const ref = changed.record.issuesReference!;
    const work = inlineReviewRecordIssuesWork(changed.record, 0);
    assert.equal(work.next().done, false);
    changed.selected.push(issue(0));
    assert.throws(() => work.next(), /Issue policy scratch changed|scratch lost/);
    assert.equal(ref.token, '');
    assert.equal(changed.record.issuesReference, ref);
  } finally {
    changed.close();
  }
});

test('inline issue checkpoint holds no live SQL iterator and refuses lost scratch', () => {
  const scope = fixture(65);
  try {
    const ref = scope.record.issuesReference!;
    const work = inlineReviewRecordIssuesWork(scope.record, 128 * 1024);
    assert.equal(work.next().done, false);
    scope.db.exec('DROP TABLE intake_review_issue_policy_v2');
    assert.throws(() => work.next(), /no such table|scratch lost/);
    assert.equal(ref.token, '');
    assert.equal(scope.record.issues, undefined);
  } finally {
    scope.close();
  }
});

test('host-turn invalidation refuses issue token publication', async () => {
  const scope = fixture(65);
  try {
    const ref = scope.record.issuesReference!;
    let captures = 0;
    await assert.rejects(
      runClinicalReviewWork(inlineReviewRecordIssuesWork(scope.record, 0), {
        capture() {
          captures++;
          scope.invalidate();
          return () => {
            throw Error('Fictional source invalidated');
          };
        },
      }),
      /invalidated/,
    );
    assert.equal(captures, 1);
    assert.equal(ref.token, '');
    assert.equal(scope.record.issues, undefined);
  } finally {
    scope.close();
  }
});

test('host-turn abort refuses issue token publication', async () => {
  const scope = fixture(65);
  const controller = new AbortController();
  try {
    const ref = scope.record.issuesReference!;
    await assert.rejects(
      runClinicalReviewWork(inlineReviewRecordIssuesWork(scope.record, 0), {
        signal: controller.signal,
        capture() {
          controller.abort();
          return () => undefined;
        },
      }),
      /abort/i,
    );
    assert.equal(ref.token, '');
    assert.equal(scope.record.issues, undefined);
  } finally {
    scope.close();
  }
});

test('empty and already-inline policies each consume work with exact literal bytes', () => {
  for (const values of [[], Array.from({ length: 65 }, (_, n) => issue(n))]) {
    const record = { issues: values } as IntakeReviewRecord;
    const work = inlineReviewRecordIssuesWork(record, 0);
    let visits = 0;
    for (;;) {
      const step = work.next();
      if (step.done) {
        assert.equal(step.value, Buffer.byteLength(canonicalLiteral(values)));
        break;
      }
      visits++;
    }
    assert.equal(visits, Math.max(1, values.length));
  }
});

test('synchronous issue wrapper retains exact inline budget behavior', () => {
  const scope = fixture(4);
  try {
    const expected = canonicalLiteral(Array.from({ length: 4 }, (_, n) => issue(n)));
    // The existing inline budget counts one separator allowance per issue.
    assert.equal(
      inlineReviewRecordIssues(scope.record, Buffer.byteLength(expected) + 1),
      Buffer.byteLength(expected) + 1,
    );
    assert.equal(canonicalLiteral(scope.record.issues), expected);
    assert.equal(scope.record.issuesReference, undefined);
  } finally {
    scope.close();
  }
});
