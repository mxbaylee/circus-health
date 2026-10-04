import test from 'node:test';
import assert from 'node:assert/strict';
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
import {
  writeIntakeFixtureEnvelope,
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import {
  prepareCollectionClinicalReview,
  prepareCollectionClinicalReviewDependencies,
} from '../intake-review-collection-host.ts';
import { openSelectedClinicalRecord } from '../intake-clinical-record-sections.ts';
import {
  readIntakeCollectionEvidenceFragment,
  clearIntakeCollectionEvidenceFragments,
} from '../intake-evidence-fragment.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { canonicalLiteral, parseLiteralJSON } from '../intake-format.ts';
import { selectionAuthority } from '../intake-selection-authority.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import {
  openReviewQuestionState,
  prepareReviewQuestionState,
} from '../intake-review-question-state.ts';

test('selected question witnesses and streamed history preserve raw numeric spelling', async () => {
  const db = openDatabase(':memory:', 'fictional-profile');
  memoryRecordAuthority(db);
  try {
    const question = {
      id: 'fictional-question',
      key: 'fictional',
      candidateId: null,
      candidateVersionId: null,
      prompt: 'Confirm the fictional value',
      locator: 'line 1',
      field: 'documentTitle',
      status: 'answered',
      createdAt: '2026-01-01',
      unknownNumber: JSON.rawJSON('12.00'),
      answers: [
        {
          id: 'first',
          answer: 'Fictional first',
          mapping: {},
          scope: 'record',
          at: '2026-01-01',
          unknownNumber: JSON.rawJSON('12.00'),
        },
        {
          id: 'last',
          answer: 'Fictional last',
          mapping: {},
          scope: 'record',
          at: '2026-01-01',
          unknownNumber: JSON.rawJSON('13.00'),
        },
      ],
    };
    const id = 'fictional-raw-history';
    registerRawIntakeFixture(
      db,
      id,
      JSON.stringify({
        intake: {
          version: 1,
          originalName: 'fictional.txt',
          workflow: {
            format: 'health-intake-workflow-v1',
            questions: [question],
            candidates: [],
            plans: [],
            decisions: [],
            reviewDrafts: [],
            operations: [],
          },
        },
      }),
    );
    await buildIntakeCollectionEnvelope(db, { id });
    await prepareReviewQuestionState(db, { id });
    const view = openIntakeCollectionEnvelope(db, { id }),
      flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
      state = openReviewQuestionState(db, { id }, view);
    const selected = state.question(view.find('question', flow, question.id)!, 8192);
    assert.equal(selected.answers.length, 1);
    assert.match(canonicalLiteral(selected.answers), /13\.00/);
    assert.equal([...state.canonicalRecords(selected)].join(''), canonicalLiteral(question));
    assert.equal(selectionAuthority({ question: selected }), selectionAuthority({ question }));
    assert.notEqual(
      selectionAuthority({ question: selected }),
      selectionAuthority({
        question: {
          ...question,
          answers: question.answers.map((answer, n) =>
            n ? answer : { ...answer, answer: 'Fictional changed historical answer' },
          ),
        },
      }),
    );
  } finally {
    clearIntakeStateCache(db);
    db.close();
  }
});

// Question append, actual acceptance and cache-loss reconstruction preserve complete audit and exact legacy token parity.
// This is a host-integration hang guard; correctness remains count/evidence based.
test(
  'native question policy retains exact legacy tokens and complete audit through append, acceptance and cache loss',
  { timeout: 300000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-question-history-')),
      profileId = 'fictional-profile',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    t.after(() => {
      clearIntakeCollectionEvidenceFragments(db);
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
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
    const record = reviewIntake(db, root, profileId, intake.id).records[0]!,
      stored = JSON.parse(readIntakeEnvelopeText(db, { id: intake.id }));
    const question = {
      id: 'question:fictional-history',
      key: 'fictional-history',
      candidateId: record.candidateId,
      candidateVersionId: record.candidateVersionId,
      prompt: 'Confirm the fictional title',
      locator: 'page 1',
      field: 'documentTitle',
      status: 'resolved',
      createdAt: '2026-01-01T00:00:00Z',
      unknownHeader: { retained: 'Fictional unknown header' },
      answers: Array.from({ length: 140 }, (_, i) => ({
        id: 'answer:fictional-' + i,
        answer: 'Fictional prior explanation ' + 'x'.repeat(2000),
        mapping: {},
        scope: 'record',
        at: '2026-01-01T00:00:00Z',
        unknownAnswer: { ordinal: i, text: 'Fictional unknown audit' },
      })),
    };
    stored.intake.workflow.questions.push(question);
    writeIntakeFixtureEnvelope(db, intake.id, stored);
    const legacy = reviewIntake(db, root, profileId, intake.id);
    assert.ok(Buffer.byteLength(JSON.stringify(question)) > 256 * 1024);
    await buildIntakeCollectionEnvelope(db, { id: intake.id });
    async function open() {
      await prepareCollectionClinicalReviewDependencies(db, root, profileId, intake.id);
      const result = prepareCollectionClinicalReview(db, root, profileId, intake.id);
      assert.equal(result.status, 'ready');
      if (result.status !== 'ready') throw Error('Expected selected question policy');
      return result.session;
    }
    const first = await open(),
      selected = first.review.records[0]!.questions![0]!;
    assert.equal(first.review.reviewToken, legacy.reviewToken);
    assert.equal(selected.answerScope, 'latest');
    assert.equal(selected.answerHistory!.count, 140);
    assert.equal(canonicalLiteral(selected.answers), canonicalLiteral(question.answers.slice(-1)));
    assert.deepEqual(first.review.records[0]!.issues, legacy.records[0]!.issues);
    await openSelectedClinicalRecord(db, root, profileId, intake.id, {
      proposalId: null,
      recordId: record.id,
      candidateVersionId: record.candidateVersionId!,
    });
    const reference = selected.answerHistory!.reference;
    async function audit(ref: typeof reference) {
      const parts: Buffer[] = [];
      let offset = 0;
      do {
        const part = await readIntakeCollectionEvidenceFragment(db, root, profileId, intake.id, {
          reference: ref,
          offset,
          bytes: 16384,
        });
        parts.push(Buffer.from(part.data, 'base64'));
        if (part.complete) break;
        offset = part.nextOffset!;
      } while (true);
      return parseLiteralJSON(Buffer.concat(parts).toString('utf8')) as unknown[];
    }
    assert.equal(canonicalLiteral(await audit(reference)), canonicalLiteral(question.answers));
    await assert.rejects(
      readIntakeCollectionEvidenceFragment(db, root, 'foreign-profile', intake.id, { reference }),
      /profile|owner/i,
    );
    clearIntakeStateCache(db);
    assert.equal((await open()).review.reviewToken, legacy.reviewToken);

    // Policy invalidation empties answers; it must hash exactly like the legacy spread, including undefined own fields.
    const view = openIntakeCollectionEnvelope(db, { id: intake.id }),
      state = openReviewQuestionState(db, { id: intake.id }, view),
      flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
      projected = state.question(view.find('question', flow, question.id)!, 128 * 1024),
      reset = {
        ...projected,
        status: 'unanswered',
        answers: [],
        resolvedAt: undefined,
        resolvedByDecisionId: undefined,
      };
    assert.equal(
      [...state.canonicalRecords(reset)].join(''),
      canonicalLiteral({
        ...question,
        status: 'unanswered',
        answers: [],
        resolvedAt: undefined,
        resolvedByDecisionId: undefined,
      }),
    );

    const before = intakeWorkCounters(db).warm;
    const updated = await answerIntakeQuestionRead(db, root, profileId, intake.id, {
      version: first.review.version,
      operationId: 'fictional-answer-append',
      questionId: question.id,
      answer: 'Fictional confirmed title',
      mapping: { documentTitle: 'Fictional confirmed note' },
    });
    assert.equal(updated.version, first.review.version + 1);
    assert.ok(
      intakeWorkCounters(db).warm.jsonCanonicalInputCodeUnits - before.jsonCanonicalInputCodeUnits <
        32 * 1024,
      'answer append must not recanonicalize historical answers',
    );
    const second = await open(),
      current = second.review.records[0]!.questions![0]!;
    assert.equal(current.answerHistory!.count, 141);
    assert.equal(current.answers[0]!.answer, 'Fictional confirmed title');
    assert.deepEqual(second.review.records[0]!.suggestedMapping, {
      documentTitle: 'Fictional confirmed note',
    });
    const full = await audit(current.answerHistory!.reference);
    assert.equal(canonicalLiteral(full.slice(0, 140)), canonicalLiteral(question.answers));
    await assert.rejects(
      readIntakeCollectionEvidenceFragment(db, root, profileId, intake.id, { reference }),
      /Refresh/,
    );
    assert.ok(
      intakeWorkCounters(db).warm.reviewQuestionTokenBytes > 256 * 1024,
      'legacy hash streams full history with explicit work accounting',
    );
    const accepted = await importIntakeRead(db, root, profileId, intake.id, {
      version: second.review.version,
      reviewToken: second.review.reviewToken,
      decisions: [
        {
          recordId: record.id,
          action: 'accept',
          mapping: {
            ...second.review.records[0]!.mapping,
            documentTitle: 'Fictional confirmed note',
          },
        },
      ],
    });
    assert.equal(accepted.version, second.review.version + 1);
    clearIntakeStateCache(db);
    const recovered = await open();
    assert.equal(recovered.review.records[0]!.questions![0]!.answerHistory!.count, 141);
    assert.equal(
      canonicalLiteral(
        (await audit(recovered.review.records[0]!.questions![0]!.answerHistory!.reference)).slice(
          0,
          140,
        ),
      ),
      canonicalLiteral(question.answers),
    );
  },
);
