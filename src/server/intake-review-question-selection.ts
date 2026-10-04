import { registerReviewRecordField } from './intake-review-selected-record.ts';
import type { IntakeQuestion, IntakeReviewRecord } from '../shared/intake.ts';
import type { IntakeReviewQuestionsReference } from '../shared/intake-review-questions.ts';
import { selectedSequence } from './intake-selected-sequence.ts';
import { canonicalReviewValueChunks } from './intake-review-question-state.ts';

export type ReviewQuestionSelection = IntakeQuestion[] | IntakeReviewQuestionsReference;
const sources = new WeakMap<IntakeReviewQuestionsReference, () => Iterable<IntakeQuestion>>();
export function selectedReviewQuestions(
  reference: IntakeReviewQuestionsReference,
  source: () => Iterable<IntakeQuestion>,
): IntakeReviewQuestionsReference {
  sources.set(reference, source);
  return reference;
}
function source(reference: IntakeReviewQuestionsReference) {
  const result = sources.get(reference);
  if (!result) throw Error('Unprepared selected question policy');
  return result;
}
export function reviewRecordQuestions(
  record: Pick<IntakeReviewRecord, 'questions' | 'questionsReference'>,
) {
  return selectedSequence(
    record.questionsReference ? source(record.questionsReference) : record.questions,
  );
}
export function reviewQuestionCount(
  record: Pick<IntakeReviewRecord, 'questions' | 'questionsReference'>,
) {
  return record.questionsReference?.count ?? record.questions?.length ?? 0;
}
export function reviewQuestionAt(
  record: Pick<IntakeReviewRecord, 'questions' | 'questionsReference'>,
  ordinal: number,
) {
  if (!record.questionsReference) return record.questions?.at(ordinal);
  let n = 0;
  for (const question of reviewRecordQuestions(record)) if (n++ === ordinal) return question;
  return undefined;
}
export function bindReviewRecordQuestions(
  record: IntakeReviewRecord,
  selected: ReviewQuestionSelection,
) {
  if (Array.isArray(selected)) {
    record.questions = selected;
    delete record.questionsReference;
    return;
  }
  delete record.questions;
  record.questionsReference = selected;
  registerReviewRecordField(record, 'questions', 'questionsReference', function* () {
    yield '[';
    let first = true;
    for (const question of reviewRecordQuestions(record)) {
      if (!first) yield ',';
      first = false;
      yield* canonicalReviewValueChunks(question);
    }
    yield ']';
  });
}
export function mapReviewRecordQuestions(
  record: IntakeReviewRecord,
  map: (question: IntakeQuestion) => IntakeQuestion,
) {
  if (!record.questionsReference) {
    record.questions = (record.questions || []).map(map);
    return;
  }
  const before = source(record.questionsReference);
  bindReviewRecordQuestions(
    record,
    selectedReviewQuestions({ ...record.questionsReference }, function* () {
      for (const question of before()) yield map(question);
    }),
  );
}
