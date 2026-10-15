import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedDraftHandoff } from '../intake-review-draft-handoff.ts';
import {
  bindReviewDraftResolutions,
  reviewDraftResolutions,
} from '../intake-review-draft-selection.ts';
import { canonicalReviewValueChunks } from '../intake-review-question-state.ts';
import { parseLiteralJSON } from '../intake-format.ts';
import type { IntakeIssueResolution, IntakeReviewDraft } from '../../shared/intake.ts';

const draft = (index: number): IntakeReviewDraft => ({
  id: 'fictional-draft-' + index,
  proposalId: null,
  recordId: 'fictional-source:line:' + index,
  candidateId: 'fictional-candidate-' + index,
  candidateVersionId: 'fictional-version-' + index,
  mapping: { documentTitle: 'Reviewed fictional title ' + index },
  resolutions: [],
  disposition: 'pending',
  at: '2026-01-01',
});

test('selected draft handoff preserves complete registered policy and raw literals beyond 32 records', () => {
  const epoch = {},
    handoff = selectedDraftHandoff(() => ({ state: 'fictional-exact-source', epoch }));
  let reads = 0;
  const retained = Array.from({ length: 70 }, (_, index) => {
    const value = draft(index);
    const resolutions = Array.from(
      { length: 70 },
      (_, n) =>
        parseLiteralJSON(
          `{"issueId":"fictional-issue-${n}","outcome":"${n === 69 ? 'this_is_me' : 'unknown'}","unknown":12.00}`,
        ) as IntakeIssueResolution,
    );
    bindReviewDraftResolutions(
      value,
      {
        values: () => resolutions,
        latest: (id) => resolutions.findLast((item) => item.issueId === id),
        known: (id) =>
          resolutions.findLast((item) => item.issueId === id && item.outcome !== 'unknown'),
        self: () => resolutions.at(-1),
      },
      1,
    );
    const record = { id: value.recordId };
    const original = Array.from(canonicalReviewValueChunks(value)).join('');
    const read = handoff.read(null, record.id, value.candidateVersionId, () => {
      reads++;
      return value;
    });
    handoff.bind(record, read);
    return { record, value, original };
  });
  for (const { record, value, original } of retained) {
    const selected = handoff.consume(null, record, value.candidateVersionId);
    assert.equal(selected, value, 'provider registration stays on the original full draft');
    assert.equal(reviewDraftResolutions(selected).length, 70);
    assert.equal(reviewDraftResolutions(selected).at(69)?.outcome, 'this_is_me');
    assert.equal(Array.from(canonicalReviewValueChunks(selected)).join(''), original);
    assert.match(original, /12\.00/);
    assert.equal(handoff.consume(null, record, value.candidateVersionId), undefined, 'one use');
  }
  assert.equal(reads, 70);
});

test('selected draft handoff drops mismatched, failed, undefined and changed construction proofs', () => {
  let state: string | undefined = 'fictional-state',
    epoch = {};
  const handoff = selectedDraftHandoff(() => (state === undefined ? undefined : { state, epoch }));
  const value = draft(1),
    record = { id: value.recordId };
  const read = () => handoff.read(null, record.id, value.candidateVersionId, () => value);
  const consume = () => handoff.consume(null, record, value.candidateVersionId);
  handoff.bind(record, read());
  assert.equal(handoff.consume(null, { ...record }, value.candidateVersionId), undefined);
  assert.equal(handoff.consume('another-proposal', record, value.candidateVersionId), undefined);
  assert.equal(consume(), undefined);
  handoff.bind(record, read());
  state = undefined;
  assert.equal(consume(), undefined);
  state = 'fictional-state';
  assert.equal(consume(), undefined, 'restored proof cannot revive consumed entry');
  handoff.bind(record, read());
  epoch = {};
  assert.equal(consume(), undefined);
  handoff.bind(
    record,
    handoff.read(null, record.id, value.candidateVersionId, () => {
      state = 'peer-changed-during-read';
      return value;
    }),
  );
  assert.equal(consume(), undefined, 'fresh final stamp cannot certify earlier read');
  read();
  assert.throws(
    () =>
      handoff.read(null, record.id, value.candidateVersionId, () => {
        throw Error('Fictional corrupted draft');
      }),
    /corrupted draft/,
  );
  handoff.bind(record, value);
  assert.equal(consume(), undefined, 'failure cleared pending association');
  handoff.bind(record, read());
  handoff.clear();
  assert.equal(consume(), undefined);
});

test('cooperative draft handoff preserves its original proof and cannot revive cleared or aborted reads', () => {
  let state = 'fictional-state';
  const epoch = {},
    handoff = selectedDraftHandoff(() => ({ state, epoch }));
  const value = draft(1),
    record = { id: value.recordId };
  const read = () =>
    handoff.readWork(null, record.id, value.candidateVersionId, function* () {
      yield;
      return value;
    });
  for (const mode of ['current', 'changed', 'cleared', 'aborted'] as const) {
    const work = read();
    assert.equal(work.next().done, false);
    if (mode === 'changed') state = 'different-fictional-state';
    if (mode === 'cleared') handoff.clear();
    if (mode === 'aborted') work.return(null);
    else assert.equal(work.next().value, value);
    handoff.bind(record, value);
    assert.equal(
      handoff.consume(null, record, value.candidateVersionId),
      mode === 'current' ? value : undefined,
    );
  }
});
