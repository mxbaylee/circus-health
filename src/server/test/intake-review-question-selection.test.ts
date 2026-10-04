import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewRecordQuestions, reviewQuestionCount } from '../intake-review-question-selection.ts';
import { reviewIssueCollection } from '../intake-review-issue-state.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import {
  uploadIntake,
  reviewIntake,
  answerIntakeQuestionRead,
  importIntakeRead,
} from '../intake.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import {
  prepareCollectionClinicalReview,
  prepareCollectionClinicalReviewDependencies,
} from '../intake-review-collection-host.ts';
import { readClinicalRecordSection } from '../intake-clinical-record-sections.ts';

// Host-only hang guard: the complete 140-question policy, recovery and acceptance
// oracle took about 351 seconds in the 2026-10-04 controlled run. This is not a
// model-latency target; retain every original policy, token and acceptance check.
test(
  'many retained questions keep complete policy, late blockers, exact tokens and bounded section reads',
  { timeout: 450000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-question-history-review-')),
      profileId = 'fictional-profile';
    const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    try {
      attachPersonalDurability(db, { root, profileId });
      const intake = uploadIntake(db, root, profileId, {
        filename: 'fictional.jsonl',
        newProviderName: 'Fictional clinic',
        bytes: Buffer.from(
          JSON.stringify({
            format: 'health-record-v1',
            id: 'one',
            kind: 'document',
            payload: { text: 'Fictional original' },
            provenance: {
              capturedVia: 'Fictional export',
              sourceSystem: 'Fictional clinic',
              sourceRecordId: 'one',
              evidenceClass: 'provider_export',
              locator: 'page 1',
            },
            coverage: { status: 'complete_response', notes: [] },
            clinical: {
              kind: 'document',
              subject: 'self',
              documentTitle: 'Fictional note',
              date: '2026-01-01',
            },
          }),
        ),
      });
      const first = reviewIntake(db, root, profileId, intake.id),
        record = first.records[0];
      const stored = JSON.parse(readIntakeEnvelopeText(db, { id: intake.id }));
      stored.intake.workflow.questions.push(
        ...Array.from({ length: 140 }, (_, q) => ({
          id: 'question:fictional-review-history-' + q,
          key: 'fictional-review-history-' + q,
          candidateId: record.candidateId,
          candidateVersionId: record.candidateVersionId,
          prompt: 'Confirm the fictional title ' + 'x'.repeat(2000),
          locator: 'page 1',
          field: 'documentTitle',
          status: q === 139 ? 'unanswered' : 'resolved',
          createdAt: '2026-01-01T00:00:00Z',
          answers: Array.from({ length: 1 }, (_, i) => ({
            id: 'answer:fictional-' + i,
            answer: 'Fictional prior explanation',
            mapping: {},
            scope: 'record',
            at: '2026-01-01T00:00:00Z',
          })),
        })),
      );
      writeIntakeFixtureEnvelope(db, intake.id, stored);
      const legacy = reviewIntake(db, root, profileId, intake.id);
      await buildIntakeCollectionEnvelope(db, { id: intake.id });
      await prepareCollectionReviewMembership(db, { id: intake.id });
      await prepareCollectionClinicalReviewDependencies(db, root, profileId, intake.id);

      const result = prepareCollectionClinicalReview(db, root, profileId, intake.id);
      assert.equal(result.status, 'ready');
      if (result.status !== 'ready') throw Error('Expected complete selected policy');
      const session = result.session,
        native = session.review.records[0];
      assert.equal(session.review.reviewToken, legacy.reviewToken);
      assert.equal(native.questions, undefined);
      assert.equal(native.questionsReference!.count, 140);
      assert.equal(native.issues, undefined);
      assert.equal(native.issuesReference!.count, 140);
      assert.equal(reviewQuestionCount(native), 140);
      assert.equal(reviewRecordQuestions(native).at(139)!.status, 'unanswered');
      assert.equal(reviewIssueCollection(native).at(139)!.status, 'unresolved');
      assert.equal(
        session.selectedRecord(record.id, record.candidateVersionId).record.kind,
        'reference',
      );
      const selection = {
        proposalId: null,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId!,
      };
      for (const section of ['questions', 'issues'] as const) {
        const page = await readClinicalRecordSection(db, root, profileId, intake.id, {
          ...selection,
          section,
          limit: 5,
        });
        assert.equal(page.total, 140);
        assert.equal(page.items.length, 5);
        assert.ok(page.nextCursor);
      }
      // Opening other sessions did not replace this held session's late blocker.
      assert.equal(reviewIssueCollection(native).at(139)!.status, 'unresolved');
      await assert.rejects(
        importIntakeRead(db, root, profileId, intake.id, {
          version: session.review.version,
          reviewToken: session.review.reviewToken,
          decisions: [{ recordId: record.id, action: 'accept', mapping: native.mapping }],
        }),
        /question|reading/i,
      );
      const updated = await answerIntakeQuestionRead(db, root, profileId, intake.id, {
        version: session.review.version,
        operationId: 'fictional-last-question-answer',
        questionId: 'question:fictional-review-history-139',
        answer: 'Fictional title confirmed',
      });
      assert.equal(updated.version, session.review.version + 1);
      session.close();
      clearIntakeStateCache(db);
      await prepareCollectionClinicalReviewDependencies(db, root, profileId, intake.id);
      const again = prepareCollectionClinicalReview(db, root, profileId, intake.id);
      assert.equal(again.status, 'ready');
      if (again.status !== 'ready') throw Error('Expected recovered review');
      assert.equal(
        reviewRecordQuestions(again.session.review.records[0]).at(139)!.status,
        'answered',
      );
      assert.ok(intakeWorkCounters(db).warm.reviewIssuePolicyPeakValueBytes < 16384);
      const version = again.session.review.version,
        token = again.session.review.reviewToken,
        mapping = again.session.review.records[0].mapping;
      again.session.close();
      const accepted = await importIntakeRead(db, root, profileId, intake.id, {
        version,
        reviewToken: token,
        decisions: [{ recordId: record.id, action: 'accept', mapping }],
      });
      assert.equal(accepted.version, version + 1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
