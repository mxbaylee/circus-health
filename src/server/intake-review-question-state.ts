/** Immutable answer canonical values separate review policy from audit history.
 * SHA-256 review-token compatibility still streams the complete old history. */
import { randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import { HttpError } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  collectionCellReader,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type { IntakeEnvelopeDerivedPreparation } from './intake-envelope-mutation.ts';
import { createEnvelopeBuildWriter } from './intake-envelope-build.ts';
import {
  prepareIntakeJsonCanonical,
  intakeJsonCanonicalWorkObserver,
} from './intake-json-canonical.ts';
import { canonicalLiteral, parseLiteralJSON } from './intake-format.ts';
import { workflowHash } from './intake-workflow.ts';
import {
  intakeReviewChildren,
  readIntakeReviewValue,
  IntakeReviewFragmentRequired,
} from './intake-review-collection.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import type { IntakeQuestion, IntakeQuestionAnswer } from '../shared/intake.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';

const POLICY = 'health-intake-review-question-state-v2';
const name = (logical: unknown) => 'review.questions.' + workflowHash(logical);
const pending = () =>
  new HttpError(409, 'QUESTION_HISTORY_PENDING', 'Prepare current question history before review');
const proof = Symbol('selected-question-policy');
export interface ReviewCanonicalOptions {
  fieldValue?: (object: object, key: string) => { value: unknown } | undefined;
}
const canonicalValues = new WeakMap<
  object,
  (options?: ReviewCanonicalOptions) => Iterable<string>
>();
/** Host-only complete selected values can retain the exact legacy token recipe. */
export function registerReviewCanonicalValue(
  value: object,
  chunks: (options?: ReviewCanonicalOptions) => Iterable<string>,
) {
  canonicalValues.set(value, chunks);
}
interface QuestionPolicy {
  header: Record<string, unknown>;
  answers: () => Iterable<string>;
  selectedAnswer: IntakeQuestionAnswer;
}
type SelectedQuestion = IntakeQuestion & { [proof]?: QuestionPolicy };

async function appendCanonicalAnswers(
  db: Database,
  view: IntakeCollectionEnvelopeReader,
  question: IntakeEnvelopeRecord,
  from: number,
  writer: ReturnType<typeof createEnvelopeBuildWriter>,
  assertRunning: () => void,
  phase: 'warm' | 'reconstruction',
) {
  for (
    let ordinal = from, count = view.childCount(question, 'answers');
    ordinal < count;
    ordinal++
  ) {
    assertRunning();
    const answer = view.childAt(question, 'answers', ordinal)!,
      canonical = await prepareIntakeJsonCanonical(view.recordChunks(answer), {
        preserveNumbers: true,
        assertRunning,
        onWork: intakeJsonCanonicalWorkObserver(db, phase),
      });
    try {
      await writer.cellPieces('answer:' + view.address(answer), canonical.chunks());
    } finally {
      canonical.close();
    }
  }
}
export async function prepareReviewQuestionState(
  db: Database,
  source: IntakeEnvelopeSource,
  options: { assertRunning?: () => void } = {},
) {
  const view = openIntakeCollectionEnvelope(db, source),
    collections = selectedEnvelopeStore(db, source).collections,
    collection = name(view.logical);
  if (collections.get(collections.openView(), 'builds', collection, 'complete') === POLICY) return;
  const assertCurrent = () => {
    options.assertRunning?.();
    view.address(view.root());
  };
  const writer = createEnvelopeBuildWriter(db, source, collection, view.logical.domainVersion, {
    assertRunning: assertCurrent,
  });
  const intake = view.child(view.root(), 'intake')!,
    workflow = view.child(intake, 'workflow');
  for (const question of intakeReviewChildren(view, workflow, 'questions'))
    await appendCanonicalAnswers(db, view, question, 0, writer, assertCurrent, 'reconstruction');
  await writer.put('complete', POLICY);
  await writer.flush();
  assertCurrent();
}
export async function prepareReviewQuestionDerived(
  db: Database,
  source: IntakeEnvelopeSource,
  input: IntakeEnvelopeDerivedPreparation & {
    questionAddresses: readonly string[];
    assertRunning?: () => void;
  },
): Promise<readonly IntakeCollectionChange[]> {
  const before = openIntakeCollectionEnvelope(db, source),
    collections = selectedEnvelopeStore(db, source).collections,
    oldName = name(before.logical);
  if (collections.get(collections.openView(), 'builds', oldName, 'complete') !== POLICY) return [];
  const collection = name(input.logical),
    build = 'review.questions.build.' + randomUUID();
  const assertCurrent = () => {
    input.assertRunning?.();
    before.address(before.root());
  };
  if (!input.questionAddresses.length)
    return [
      {
        area: 'builds',
        collection,
        op: 'adoptCollection',
        fromArea: 'builds',
        fromCollection: oldName,
      },
    ];
  const operationId = randomUUID();
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId,
      requestDigest: workflowHash(operationId),
      domainVersion: before.logical.domainVersion,
      changes: [
        {
          area: 'builds',
          collection: build,
          op: 'adoptCollection',
          fromArea: 'builds',
          fromCollection: oldName,
        },
      ],
    }),
  );
  const writer = createEnvelopeBuildWriter(db, source, build, before.logical.domainVersion, {
    assertRunning: assertCurrent,
  });
  const { store: previousData } = collectionCellReader(db, source, 'logical', 'envelope.data');
  for (const address of new Set(input.questionAddresses)) {
    const question = input.reader.resolve(address);
    if (question.kind !== 'question') throw Error('Foreign question history effect');
    const oldCount =
      previousData.get('r:' + address) === undefined
        ? 0
        : before.childCount(before.resolve(address), 'answers');
    if (input.reader.childCount(question, 'answers') < oldCount)
      throw Error('Question answer history cannot shrink');
    await appendCanonicalAnswers(
      db,
      input.reader,
      question,
      oldCount,
      writer,
      assertCurrent,
      'warm',
    );
  }
  await writer.flush();
  assertCurrent();
  return [
    {
      area: 'builds',
      collection,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: build,
    },
  ];
}
export function openReviewQuestionState(
  db: Database,
  source: IntakeEnvelopeSource,
  view: IntakeCollectionEnvelopeReader,
) {
  const { store } = collectionCellReader(db, source, 'builds', name(view.logical));
  const current = () => {
    store.check();
    if (store.get('complete') !== POLICY) throw pending();
  };
  function* answerChunks(answer: IntakeEnvelopeRecord): Generator<string> {
    current();
    const value = store.get('answer:' + view.address(answer));
    if (value === undefined) throw pending();
    if (typeof value === 'string') {
      yield value;
      return;
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let after: string | undefined;
    do {
      const page = store.chunks(value, after, 8192);
      for (const piece of page.chunks) {
        const text = decoder.decode(piece, { stream: true });
        if (text) yield text;
      }
      if (page.complete) break;
      if (!page.after || page.after === after)
        throw Error('Question history cursor did not advance');
      after = page.after;
    } while (true);
    const tail = decoder.decode();
    if (tail) yield tail;
  }
  return {
    question(question: IntakeEnvelopeRecord, bytes: number): IntakeQuestion {
      const count = view.childCount(question, 'answers');
      if (count <= 1) return readIntakeReviewValue<IntakeQuestion>(view, question, bytes);
      current();
      const header: string[] = ['{'];
      let size = 2,
        first = true,
        after: string | undefined;
      const add = (text: string) => {
        size += Buffer.byteLength(text);
        if (size > bytes)
          throw new IntakeReviewFragmentRequired({
            format: 'health-intake-review-fragment-v1',
            logical: view.logical,
            address: view.address(question),
          });
        header.push(text);
      };
      do {
        const page = view.fields(question, { after, items: 32, bytes: Math.max(1024, bytes) });
        for (const field of page.fields) {
          if (field.name === 'answers') continue;
          add((first ? '' : ',') + JSON.stringify(field.name) + ':');
          first = false;
          const child = view.child(question, field.name);
          for (const piece of child
            ? view.recordChunks(child)
            : view.fieldChunks(question, field.name))
            add(piece);
        }
        if (page.complete) break;
        if (!page.after || page.after === after)
          throw Error('Question header cursor did not advance');
        after = page.after;
      } while (true);
      header.push('}');
      const original = parseLiteralJSON(header.join('')) as Record<string, unknown>,
        latest = readIntakeReviewValue<IntakeQuestionAnswer>(
          view,
          view.childAt(question, 'answers', count - 1)!,
          Math.max(0, bytes - size),
        );
      const selected = {
        ...original,
        answers: [latest],
        answerScope: 'latest',
        answerHistory: {
          count,
          reference: {
            format: 'health-intake-review-fragment-v1',
            logical: view.logical,
            address: view.address(question),
            field: 'answers',
          },
        },
      } as IntakeQuestion;
      (selected as SelectedQuestion)[proof] = {
        header: original,
        selectedAnswer: latest,
        answers: function* () {
          current();
          yield '[';
          for (let n = 0; n < count; n++) {
            if (n) yield ',';
            yield* answerChunks(view.childAt(question, 'answers', n)!);
          }
          yield ']';
          current();
        },
      };
      return selected;
    },
    *canonicalRecords(value: unknown): Generator<string> {
      for (const piece of canonicalReviewValueChunks(value)) {
        withIntakeWork(db, 'warm', () =>
          recordIntakeWork('reviewQuestionTokenBytes', Buffer.byteLength(piece)),
        );
        yield piece;
      }
    },
  };
}

export function* canonicalReviewValueChunks(
  value: unknown,
  options: ReviewCanonicalOptions = {},
): Generator<string> {
  const selectedChunks =
    value && typeof value === 'object' ? canonicalValues.get(value) : undefined;
  if (selectedChunks) {
    yield* selectedChunks(options);
    return;
  }
  if (JSON.isRawJSON(value) || !value || typeof value !== 'object') {
    yield canonicalLiteral(value) ?? 'undefined';
    return;
  }
  if (Array.isArray(value)) {
    yield '[';
    for (let n = 0; n < value.length; n++) {
      if (n) yield ',';
      if (value[n] !== undefined) yield* canonicalReviewValueChunks(value[n], options);
    }
    yield ']';
    return;
  }
  const question = value as SelectedQuestion,
    selected = question[proof];
  if (selected) {
    const header = { ...selected.header };
    for (const key of ['status', 'resolvedAt', 'resolvedByDecisionId'] as const)
      if (Object.hasOwn(question, key)) header[key] = question[key];
    yield '{';
    let first = true;
    for (const key of [...new Set([...Object.keys(header), 'answers'])].sort()) {
      if (!first) yield ',';
      first = false;
      yield JSON.stringify(key) + ':';
      if (
        key === 'answers' &&
        question.answers.length &&
        question.answers.at(-1) === selected.selectedAnswer
      )
        yield* selected.answers();
      else
        yield* canonicalReviewValueChunks(
          key === 'answers' ? question.answers : header[key],
          options,
        );
    }
    yield '}';
    return;
  }
  yield '{';
  let first = true;
  for (const key of Object.keys(value).sort()) {
    if (!first) yield ',';
    first = false;
    yield JSON.stringify(key) + ':';
    const override = options.fieldValue?.(value, key);
    yield* canonicalReviewValueChunks(
      override ? override.value : (value as Record<string, unknown>)[key],
      options,
    );
  }
  yield '}';
}

export function hasReviewCanonicalValue(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (canonicalValues.has(value) || !!(value as SelectedQuestion)[proof])
  );
}
