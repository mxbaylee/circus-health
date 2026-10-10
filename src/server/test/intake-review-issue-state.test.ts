import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../database.ts';
import { reviewIssueFactory } from '../intake-review-issue-state.ts';
import { canonicalLiteral } from '../intake-format.ts';
import type { IntakeReviewIssue } from '../../shared/intake.ts';

test('native issue policy isolates held sessions, preserves reset flags and undefined values, and refuses lost scratch', () => {
  const db = openDatabase(':memory:', 'fictional-profile');
  const input = { sourceId: 'fictional-source', generation: 'fictional-pins', assertCurrent() {} },
    first = reviewIssueFactory(db, input),
    second = reviewIssueFactory(db, input),
    selection = { id: 'fictional-record', candidateVersionId: 'fictional-version' },
    a = first(selection),
    b = second(selection);
  const issue: IntakeReviewIssue = {
    id: 'fictional-question',
    kind: 'uncertain_reading',
    field: 'documentTitle',
    prompt: 'Confirm the fictional title',
    blocking: true,
    status: 'unresolved',
    locator: 'page 1',
    questionId: 'fictional-question',
  };
  try {
    a.push(issue);
    b.push({ ...issue, status: 'resolved' });
    a.at(0)!.resolution = undefined;
    assert.equal(a.at(0)!.status, 'unresolved');
    assert.equal(b.at(0)!.status, 'resolved');
    assert.equal(canonicalLiteral(a.at(0)), canonicalLiteral({ ...issue, resolution: undefined }));
    a.markQuestionReset!(issue.id);
    a.at(0)!.status = 'resolved';
    assert.equal(a.questionWasReset!(issue.id), true);
    assert.equal(b.questionWasReset!(issue.id), false);
    const sameRun = first(selection);
    sameRun.push({ ...issue, prompt: 'Fictional second policy pass' });
    assert.equal(a.at(0)!.prompt, issue.prompt);
    assert.equal(sameRun.at(0)!.prompt, 'Fictional second policy pass');
    first.dispose();
    first.dispose();
    assert.throws(() => a.findId!('absent'), /Closed/);
    assert.equal(b.length, 1);
    db.exec('DELETE FROM intake_review_issue_policy_v2');
    assert.throws(() => b.findId!('absent'), /scratch lost/);
    second.dispose();
    const third = reviewIssueFactory(db, input),
      old = third(selection);
    old.push(issue);
    db.exec('DROP TABLE intake_review_issue_policy_v2');
    const rebuilt = reviewIssueFactory(db, input),
      next = rebuilt(selection);
    next.push(issue);
    assert.throws(() => old.findId!('absent'), /scratch lost/);
    assert.equal(next.findId!(issue.id)!.prompt, issue.prompt);
    db.close();
    assert.doesNotThrow(() => {
      third.dispose();
      rebuilt.dispose();
    });
  } finally {
    if (db.isOpen) db.close();
  }
});
