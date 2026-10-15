import test from 'node:test';
import assert from 'node:assert/strict';
import type { IntakeQuestion } from '../../shared/intake.ts';
import {
  selectedReportGroupAt,
  selectedReportGroupLinks,
} from '../intake-selected-report-groups.ts';
import {
  mapReviewRecordQuestions,
  reviewQuestionAt,
  reviewQuestionById,
  selectedReviewQuestions,
} from '../intake-review-question-selection.ts';
import type { IntakeReviewRecord } from '../../shared/intake.ts';

test('late report-link selection uses a guarded point read without replaying earlier links', () => {
  let visits = 0,
    points = 0,
    current = true;
  const at = (ordinal: number) => ({
    groupId: `group:${ordinal}`,
    groupVersionId: `version:${ordinal}`,
  });
  const links = selectedReportGroupLinks(
    function* () {
      for (let ordinal = 0; ordinal < 1000; ordinal++) {
        visits++;
        yield at(ordinal);
      }
    },
    {
      candidateId: 'candidate',
      candidateVersionId: 'version',
      recordId: 'record',
      proposalId: null,
    },
    0,
    (ordinal) => {
      if (!current) throw Error('Selection changed');
      points++;
      return at(ordinal);
    },
  );
  assert.equal(Array.isArray(links), false);
  visits = 0;
  assert.deepEqual(selectedReportGroupAt(links, 999), at(999));
  assert.deepEqual(selectedReportGroupAt(links, 500), at(500));
  assert.equal(visits, 0);
  assert.equal(points, 2);
  assert.equal(selectedReportGroupAt(links, 1000), undefined);
  current = false;
  assert.throws(() => selectedReportGroupAt(links, 999), /Selection changed/);
});

test('referenced question point and identity reads preserve mapping and source guards', () => {
  let visits = 0,
    points = 0,
    identities = 0,
    current = true;
  const question = (ordinal: number) =>
    ({ id: `question:${ordinal}`, prompt: `Prompt ${ordinal}` }) as IntakeQuestion;
  const guard = () => {
    if (!current) throw Error('Selection changed');
  };
  const reference = selectedReviewQuestions(
    {
      format: 'health-intake-review-questions-v1',
      count: 1000,
      candidateId: 'candidate',
      candidateVersionId: 'version',
      reference: {
        format: 'health-intake-review-fragment-v1',
        logical: { root: null, domainVersion: 1 },
        address: 'workflow',
        field: 'questions',
      },
    },
    function* () {
      for (let ordinal = 0; ordinal < 1000; ordinal++) {
        visits++;
        yield question(ordinal);
      }
    },
    (ordinal) => {
      guard();
      points++;
      return question(ordinal);
    },
    (id) => {
      guard();
      identities++;
      return id === 'question:999' ? question(999) : undefined;
    },
  );
  const record = { questionsReference: reference } as IntakeReviewRecord;
  mapReviewRecordQuestions(record, (value) => ({ ...value, prompt: value.prompt + ' mapped' }));
  assert.equal(reviewQuestionAt(record, 999)?.prompt, 'Prompt 999 mapped');
  assert.equal(reviewQuestionById(record, 'question:999')?.prompt, 'Prompt 999 mapped');
  assert.equal(reviewQuestionById(record, 'missing'), undefined);
  assert.equal(reviewQuestionAt(record, 1000), undefined);
  assert.deepEqual({ visits, points, identities }, { visits: 0, points: 1, identities: 2 });
  current = false;
  assert.throws(() => reviewQuestionAt(record, 999), /Selection changed/);
  assert.throws(() => reviewQuestionById(record, 'question:999'), /Selection changed/);
});
