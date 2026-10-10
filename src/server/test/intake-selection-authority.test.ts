import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { selectionAuthority, durableSelectionInputs } from '../intake-selection-authority.ts';
import { canonicalReviewValueChunks } from '../intake-review-question-state.ts';
import { registerReviewCanonicalValue } from '../intake-review-question-state.ts';
import { registerReviewRecordField } from '../intake-review-selected-record.ts';
import { canonicalSelectionChunks } from '../intake-selection-canonical.ts';
import { canonicalLiteral } from '../intake-format.ts';
const hash = (chunks: Iterable<string>) => {
  const digest = createHash('sha256');
  for (const chunk of chunks) digest.update(chunk);
  return digest.digest('hex');
};
test('streamed selection filtering preserves inline recipes, holes, giant keys, strings and raw numbers', () => {
  const pair = {
    format: 'intake-pair-scope-v2',
    intakeVersion: 4,
    requestRevision: 9,
    token: 'ephemeral',
    logical: 'retained',
  };
  const inline = {
    record: {
      questions: [
        {
          answers: [
            undefined,
            {
              answer: 'Fictional "answer" 🌿',
              unknown: { draftScopeStatus: 'pending', raw: '12.00' },
            },
          ],
          selectionReviewToken: 'ignored',
        },
      ],
      comparisons: [pair],
    },
    nested: pair,
    undefinedValue: undefined,
    holes: [undefined, undefined, 3, undefined],
  };
  assert.equal(
    selectionAuthority(inline),
    hash(canonicalReviewValueChunks(durableSelectionInputs(inline))),
  );
  const unavailable = {};
  registerReviewCanonicalValue(unavailable, function* () {
    throw Error('comparisons must not be read');
  });
  const record = {
    comparisons: unavailable,
    questionsReference: { format: 'fictional', count: 1 },
  };
  registerReviewRecordField(record, 'questions', 'questionsReference', () => ['[]']);
  assert.equal(
    selectionAuthority({ record }, { recordComparisonsUndefined: true }),
    selectionAuthority({ record: { comparisons: undefined, questions: [] } }),
  );
  assert.equal(
    selectionAuthority(inline, { recordComparisonsUndefined: true }),
    selectionAuthority({ ...inline, record: { ...inline.record, comparisons: undefined } }),
  );
  const giant = {
    ['field'.repeat(3000)]: 'literal \"🌿'.repeat(10000),
    raw: JSON.rawJSON('12.00'),
    format: 'fictional-' + 'x'.repeat(30000),
  };
  assert.equal(selectionAuthority(giant), hash([canonicalLiteral(giant)]));
  for (const chunk of canonicalSelectionChunks(canonicalReviewValueChunks(giant)))
    assert.ok(Buffer.byteLength(chunk) <= 32768);
  const formatLast = {
    token: 'old',
    requestRevision: 2,
    intakeVersion: 1,
    logical: 'kept',
    format: 'intake-pair-scope-v2',
  };
  assert.equal(
    selectionAuthority(formatLast),
    selectionAuthority({ format: formatLast.format, logical: formatLast.logical }),
  );
  const escaped =
    '{"format":"\\u0069ntake-pair-scope-v2","intakeVersion":4,"logical":12.00,"requestRevision":9,"token":"old"}';
  assert.equal(
    [
      ...canonicalSelectionChunks(
        (function* () {
          for (let n = 0; n < escaped.length; n++) yield escaped[n];
        })(),
      ),
    ].join(''),
    '{"format":"\\u0069ntake-pair-scope-v2","logical":12.00}',
  );
});
test('selection authority commits complete same-count referenced questions, answers, resolutions and warnings', () => {
  const fields = ['questions', 'issues', 'warnings', 'resolutions'];
  for (const field of fields) {
    const values = Array.from({ length: 1100 }, (_, n) => ({
      id: 'fictional-' + n,
      answer: 'before',
      outcome: n === 1099 ? 'this_is_me' : 'unknown',
      unknown: JSON.rawJSON('12.00'),
    }));
    const record: Record<string, unknown> = {
      [field + 'Reference']: { format: 'fictional-complete-' + field, count: 1100 },
      selectionReviewToken: 'presentation',
    };
    registerReviewRecordField(record, field, field + 'Reference', function* () {
      yield '[';
      let first = true;
      for (const value of values) {
        if (!first) yield ',';
        first = false;
        yield* canonicalReviewValueChunks(value);
      }
      yield ']';
    });
    const before = selectionAuthority({ record });
    assert.equal(
      before,
      selectionAuthority({ record: { [field]: values, selectionReviewToken: 'ignored' } }),
    );
    values[1099].answer = 'after';
    const after = selectionAuthority({ record });
    assert.notEqual(before, after);
    assert.equal(after, selectionAuthority({ record: { [field]: values } }));
    values[1099].outcome = 'unknown';
    assert.notEqual(after, selectionAuthority({ record }));
  }
});
