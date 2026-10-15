import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  IntakeCandidateVersion,
  IntakeQuestion,
  IntakeReviewDraft,
  IntakeWorkflow,
} from '../../shared/intake.ts';
import { legacyWorkflowCountReader } from '../intake-workflow-legacy-reader.ts';
import { workflowCounts, workflowQuestionNeedsAnswer } from '../intake-workflow-reader.ts';
import {
  advanceWorkflowRecount,
  beginWorkflowRecount,
  workflowRecountSummary,
  type WorkflowCountClosureReader,
  type WorkflowCountFacts,
} from '../intake-workflow-counts.ts';

const version = (
  id: string,
  fields: Partial<IntakeCandidateVersion> = {},
): IntakeCandidateVersion => ({
  id,
  status: 'pending',
  createdAt: '2026-01-01',
  occurrences: [],
  ...fields,
});
const question = (fields: Partial<IntakeQuestion> = {}): IntakeQuestion => ({
  id: 'question',
  key: 'question',
  candidateId: 'candidate',
  candidateVersionId: null,
  prompt: 'Confirm the patient identity',
  field: 'subject',
  locator: 'page 1',
  status: 'unanswered',
  createdAt: '2026-01-01',
  answers: [],
  ...fields,
});
const draft = (versionId: string, fields: Partial<IntakeReviewDraft> = {}): IntakeReviewDraft => ({
  id: `draft:${versionId}`,
  proposalId: null,
  recordId: 'record',
  candidateId: 'candidate',
  candidateVersionId: versionId,
  mapping: {},
  resolutions: [],
  disposition: 'pending',
  at: '2026-01-01',
  ...fields,
});
const workflow = (versions = [version('old'), version('new')]): IntakeWorkflow => ({
  format: 'health-intake-workflow-v1',
  candidates: [
    { id: 'candidate', envelopeId: 'envelope', sourceSystem: null, sourceRecordId: null, versions },
  ],
  questions: [],
  plans: [],
  decisions: [],
  reviewDrafts: [],
});

test('legacy unpinned questions require current-version resolution even beyond the displayed page', () => {
  const value = workflow();
  const pending = question({ status: 'resolved', resolvedByDecisionId: 'old-decision' });
  value.questions.push(pending);
  value.decisions.push({
    id: 'old-decision',
    candidateId: 'candidate',
    candidateVersionId: 'old',
    recordId: 'record',
    action: 'accept',
    mapping: {},
    scope: 'record',
    at: '2026-01-01',
  });
  value.reviewDrafts!.push(
    draft('old', { resolutions: [{ issueId: 'question', outcome: 'this_is_me' }] }),
  );
  assert.equal(workflowQuestionNeedsAnswer(legacyWorkflowCountReader(value), pending), true);
  value.reviewDrafts!.push(
    draft('new', { resolutions: [{ issueId: 'question', outcome: 'this_is_me' }] }),
  );
  assert.equal(workflowQuestionNeedsAnswer(legacyWorkflowCountReader(value), pending), false);
  value.reviewDrafts!.push(
    draft('new', { resolutions: [{ issueId: 'question', outcome: 'unknown' }] }),
  );
  assert.equal(workflowQuestionNeedsAnswer(legacyWorkflowCountReader(value), pending), true);
});

test('source context classification respects latest clinical mapping, people-only and kept-original states', () => {
  const value = workflow([
    version('context', { sourceContext: true }),
    version('people', { peopleOnly: true }),
    version('kept', { status: 'kept_original' }),
  ]);
  value.questions.push(question({ candidateVersionId: 'kept' }));
  assert.deepEqual(workflowCounts(legacyWorkflowCountReader(value)), {
    needsReview: false,
    pendingCount: 0,
    unansweredCount: 0,
    pendingWorkCount: 0,
    reviewLaterCount: 0,
  });
  value.reviewDrafts!.push(
    draft('context', { mapping: { kind: 'observation' }, disposition: 'review_later' }),
  );
  assert.deepEqual(workflowCounts(legacyWorkflowCountReader(value)), {
    needsReview: true,
    pendingCount: 1,
    unansweredCount: 0,
    pendingWorkCount: 0,
    reviewLaterCount: 1,
  });
});

test('streamed traversal never confuses one page with complete candidates or questions', () => {
  const base = legacyWorkflowCountReader(workflow([]));
  let read = 0;
  const count = 10_001;
  const result = workflowCounts({
    ...base,
    *candidates() {
      for (let i = 0; i < count; i++) {
        read++;
        yield { id: String(i), envelopeId: String(i), sourceSystem: null, sourceRecordId: null };
      }
    },
    *versions({ id }) {
      yield version(id, { status: id === String(count - 1) ? 'pending' : 'accepted' });
    },
    *questions() {
      yield question({ candidateId: null });
    },
  });
  assert.equal(read, count);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.unansweredCount, 1);
});

const facts = (fields: Partial<WorkflowCountFacts> = {}): WorkflowCountFacts => ({
  pendingCount: 0,
  unansweredCount: 0,
  pendingWorkCount: 0,
  reviewLaterCount: 0,
  pendingPackageFailures: 0,
  ...fields,
});
test('dependency recount stays pending through every bounded closure page and auxiliary churn', () => {
  const descriptor = {
    root: 'closure-root',
    count: 101,
    from: 'previous-roots',
    to: 'changed-role-roots',
  };
  const previous = { binding: 'previous-roots', facts: facts({ pendingWorkCount: 101 }) };
  let job = beginWorkflowRecount(descriptor, previous);
  let calls = 0;
  const reader: WorkflowCountClosureReader = {
    descriptor,
    page(start, limit) {
      calls++;
      assert.ok(limit <= 64);
      return {
        root: descriptor.root,
        start,
        entries: Array.from({ length: Math.min(limit, 101 - start) }, () => ({
          before: facts({ pendingWorkCount: 1 }),
          after: facts({ unansweredCount: 1 }),
        })),
      };
    },
  };
  job = advanceWorkflowRecount(job, reader);
  const pending = workflowRecountSummary(job, descriptor.to);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.counts, null);
  if (pending.state === 'pending') assert.equal(pending.lastVerified?.counts.pendingWorkCount, 101);
  // A receipt/build publication leaves the relevant binding unchanged.
  job = advanceWorkflowRecount(job, reader);
  const complete = workflowRecountSummary(job, descriptor.to);
  assert.equal(complete.state, 'exact');
  assert.equal(complete.counts?.unansweredCount, 101);
  assert.equal(complete.counts?.pendingWorkCount, 0);
  assert.equal(calls, 2);
  assert.equal(workflowRecountSummary(job, 'new-policy-roots').state, 'pending');
  assert.throws(
    () =>
      advanceWorkflowRecount(job, { ...reader, descriptor: { ...descriptor, root: 'different' } }),
    /Stale/,
  );
});

test('recount rejects skipped, oversized, wrong-root and impossible dependency facts', () => {
  const descriptor = { root: 'closure', count: 2, from: null, to: 'roots' };
  const job = beginWorkflowRecount(descriptor, null);
  const reader: WorkflowCountClosureReader = {
    descriptor,
    page: () => ({ root: 'closure', start: 1, entries: [{ before: null, after: facts() }] }),
  };
  assert.throws(() => advanceWorkflowRecount(job, reader), /conflicting/);
  reader.page = () => ({ root: 'wrong', start: 0, entries: [{ before: null, after: facts() }] });
  assert.throws(() => advanceWorkflowRecount(job, reader), /conflicting/);
  reader.page = () => ({
    root: 'closure',
    start: 0,
    entries: [{ before: facts(), after: facts() }],
  });
  assert.throws(() => advanceWorkflowRecount(job, reader), /removal/);
  reader.page = () => ({
    root: 'closure',
    start: 0,
    entries: [{ before: null, after: facts({ pendingCount: -1 }) }],
  });
  assert.throws(() => advanceWorkflowRecount(job, reader), /count fact/);
});
