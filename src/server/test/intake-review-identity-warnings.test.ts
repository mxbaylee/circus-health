import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDatabase } from '../database.ts';
import { reviewIssueFactory } from '../intake-review-issue-state.ts';
import {
  bindReviewIdentityWarnings,
  reviewRecordIdentityWarnings,
} from '../intake-review-identity-warnings.ts';
import {
  modelBirthDateWarningCandidates,
  modelBirthDateWarnings,
} from '../intake-identity-policy.ts';
import { canonicalReviewValueChunks } from '../intake-review-question-state.ts';
import { canonicalLiteral } from '../intake-format.ts';
import type { IntakeReviewRecord } from '../../shared/intake.ts';

const makeRecord = (): IntakeReviewRecord => ({
  id: 'fictional-warning-record',
  candidateVersionId: 'fictional-version',
  classification: 'addition',
  kind: 'document',
  title: 'Fictional warning report',
  date: null,
  provider: 'Invented Clinic',
  confidence: null,
  uncertainties: [],
  evidence: [],
  mapping: { kind: 'document', subject: 'self', documentTitle: 'Fictional report' },
  supportedFields: [],
  identityReview: {
    status: 'evidenced_match',
    blocking: false,
    message: 'Fictional reviewed owner',
    evidencedIdentity: { fullName: 'Fictional Iris Meadow' },
    conflicts: [],
  },
});
const hash = (pieces: Iterable<string>) => {
  const digest = createHash('sha256');
  for (const piece of pieces) digest.update(piece);
  return digest.digest('hex');
};
test('complete warning policy preserves late facts, exact legacy tokens and session cleanup beyond inline limits', () => {
  const db = openDatabase(':memory:', 'fictional-warnings');
  const factory = reviewIssueFactory(db, {
    sourceId: 'fictional-source',
    generation: 'fictional-generation',
    assertCurrent() {},
  });
  try {
    const issues = Array.from({ length: 1100 }, (_, n) => ({
      selfSuggestion: {
        birthDate: `${1960 + Math.floor(n / 336)}-${String(1 + Math.floor((n % 336) / 28)).padStart(2, '0')}-${String(1 + (n % 28)).padStart(2, '0')}`,
      },
    }));
    const input = {
      issues: [...issues, issues[0]!],
      unreadableBirthDate: false,
      person: { fullName: 'Fictional Iris Meadow', birthDate: '1990-03-08' },
    };
    const legacy = makeRecord(),
      selected = makeRecord();
    legacy.identityReview!.warnings = modelBirthDateWarnings(input);
    bindReviewIdentityWarnings(factory, selected, modelBirthDateWarningCandidates(input));
    assert.equal(selected.identityReview!.warnings, undefined);
    assert.equal(selected.identityReview!.warningsReference!.count, 1100);
    assert.equal(reviewRecordIdentityWarnings(selected).length, 1100);
    assert.deepEqual(
      reviewRecordIdentityWarnings(selected).at(1099),
      legacy.identityReview!.warnings.at(1099),
    );
    assert.equal(hash(canonicalReviewValueChunks(selected)), hash([canonicalLiteral(legacy)]));
    const priorToken = selected.identityReview!.warningsReference!.token;
    const later = makeRecord();
    bindReviewIdentityWarnings(
      factory,
      later,
      modelBirthDateWarningCandidates({
        ...input,
        issues: [...input.issues, { selfSuggestion: { birthDate: '1901-01-01' } }],
      }),
    );
    assert.equal(later.identityReview!.warningsReference!.count, 1101);
    assert.notEqual(later.identityReview!.warningsReference!.token, priorToken);
    assert.equal(reviewRecordIdentityWarnings(later).at(1100)!.modelBirthDate, '1901-01-01');
    factory.dispose();
    assert.equal(
      Number(db.prepare('SELECT count(*) n FROM intake_review_issue_policy_v2').get()!.n),
      0,
    );
    assert.equal(
      Number(db.prepare('SELECT count(*) n FROM intake_review_issue_scope').get()!.n),
      0,
    );
    assert.throws(() => reviewRecordIdentityWarnings(selected).length, /Closed issue policy scope/);
  } finally {
    factory.dispose();
    db.close();
  }
});
