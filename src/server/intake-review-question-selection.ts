import { registerReviewRecordField } from './intake-review-selected-record.ts';
import type { IntakeQuestion, IntakeReviewRecord } from '../shared/intake.ts';
import type { IntakeReviewQuestionsReference } from '../shared/intake-review-questions.ts';
import { selectedSequence } from './intake-selected-sequence.ts';
import { canonicalReviewValueChunks } from './intake-review-question-state.ts';

export type ReviewQuestionSelection = IntakeQuestion[] | IntakeReviewQuestionsReference;
const sources = new WeakMap<
  IntakeReviewQuestionsReference,
  {
    read: () => Iterable<IntakeQuestion>;
    at?: (ordinal: number) => IntakeQuestion | undefined;
    find?: (id: string) => IntakeQuestion | undefined;
  }
>();
export function selectedReviewQuestions(
  reference: IntakeReviewQuestionsReference,
  source: () => Iterable<IntakeQuestion>,
  at?: (ordinal: number) => IntakeQuestion | undefined,
  find?: (id: string) => IntakeQuestion | undefined,
): IntakeReviewQuestionsReference {
  sources.set(reference, { read: source, at, find });
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
    record.questionsReference ? source(record.questionsReference).read : record.questions,
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
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) return undefined;
  if (!record.questionsReference) return record.questions?.[ordinal];
  const selected = source(record.questionsReference);
  if (!selected.at) throw Error('Unprepared selected question point read');
  return ordinal < record.questionsReference.count ? selected.at(ordinal) : undefined;
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
export function reviewQuestionById(
  record: Pick<IntakeReviewRecord, 'questions' | 'questionsReference'>,
  id: string,
) {
  if (!record.questionsReference) return record.questions?.find((question) => question.id === id);
  const selected = source(record.questionsReference);
  if (!selected.find) throw Error('Unprepared selected question identity read');
  return selected.find(id);
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
    selectedReviewQuestions(
      { ...record.questionsReference },
      function* () {
        for (const question of before.read()) yield map(question);
      },
      before.at
        ? (ordinal) => {
            const question = before.at!(ordinal);
            return question && map(question);
          }
        : undefined,
      before.find
        ? (id) => {
            const question = before.find!(id);
            return question && map(question);
          }
        : undefined,
    ),
  );
}
