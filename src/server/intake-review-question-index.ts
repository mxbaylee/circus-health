import type { DatabaseSync } from 'node:sqlite';
import {
  intakeReviewChildren,
  readIntakeReviewValue,
  IntakeReviewFragmentRequired,
} from './intake-review-collection.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  collectionCellReader,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import {
  WORKFLOW_DEPENDENCY_POLICY,
  workflowDependencyPrefix,
  type WorkflowQuestionDependency,
} from './intake-workflow-dependencies.ts';

/** Reuse complete reverse dependencies; restore original ordinal order in session-owned scratch. */
export function indexedReviewQuestions(
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
  view: IntakeCollectionEnvelopeReader,
  scratch: DatabaseSync,
  metadataBytes = 256 * 1024,
) {
  const { store } = collectionCellReader(db, source, 'builds', 'workflow.dependencies');
  const logical = JSON.stringify(view.logical),
    binding = JSON.stringify([source.id, view.logical]);
  let fallbackComplete = false;
  scratch.exec(`CREATE TABLE IF NOT EXISTS review_question_selection (
    source TEXT, candidate TEXT, version TEXT, ordinal INTEGER, address TEXT,
    PRIMARY KEY(source,candidate,version,ordinal)
  ); CREATE TABLE IF NOT EXISTS review_question_selections (source TEXT,candidate TEXT,PRIMARY KEY(source,candidate));`);
  const ready = scratch.prepare(
    'SELECT 1 FROM review_question_selections WHERE source=? AND candidate=?',
  );
  const insert = scratch.prepare(
    'INSERT OR REPLACE INTO review_question_selection VALUES(?,?,?,?,?)',
  );
  const complete = scratch.prepare('INSERT INTO review_question_selections VALUES(?,?)');
  const read =
    scratch.prepare(`SELECT ordinal,address FROM review_question_selection WHERE source=? AND candidate=? AND version=''
    UNION ALL SELECT ordinal,address FROM review_question_selection WHERE source=? AND candidate=? AND version=? AND ?<>'' ORDER BY ordinal`);
  const current = () => {
    store.check();
    view.address(view.root());
  };
  const scalar = (question: IntakeEnvelopeRecord, name: string): unknown => {
    const child = view.child(question, name);
    if (child) return readIntakeReviewValue(view, child, metadataBytes);
    const field = view.field(question, name, { bytes: metadataBytes });
    if (field.kind === 'fragmented')
      throw new IntakeReviewFragmentRequired({
        format: 'health-intake-review-fragment-v1',
        logical: view.logical,
        address: view.address(question),
        field: name,
      });
    return field.kind === 'value' ? field.value : undefined;
  };
  function* prepareFallback(): Generator<void, void, void> {
    if (fallbackComplete) return;
    const intake = view.child(view.root(), 'intake'),
      workflow = intake && view.child(intake, 'workflow');
    let ordinal = 0;
    for (const question of intakeReviewChildren(view, workflow, 'questions')) {
      current();
      const candidate = scalar(question, 'candidateId'),
        selectedVersion = scalar(question, 'candidateVersionId');
      const version = !selectedVersion
        ? ''
        : typeof selectedVersion === 'string'
          ? selectedVersion
          : undefined;
      if (typeof candidate === 'string' && version !== undefined)
        insert.run(binding, candidate, version, ordinal, view.address(question));
      ordinal++;
      yield;
    }
    fallbackComplete = true;
  }
  return {
    *prepare(candidateId: string): Generator<void, void, void> {
      current();
      if (fallbackComplete || ready.get(binding, candidateId)) return;
      if (store.get('complete') !== logical || store.get('policy') !== WORKFLOW_DEPENDENCY_POLICY) {
        yield* prepareFallback();
        return;
      }
      const prefix = workflowDependencyPrefix('question-candidate', candidateId);
      let after = prefix,
        done = false;
      while (!done) {
        current();
        const page = store.range(after, 64, 128 * 1024);
        for (const item of page.items) {
          if (!item.key.startsWith(prefix)) {
            done = true;
            break;
          }
          if (typeof item.value !== 'string') throw Error('Invalid selected question dependency');
          const metadata = store.get('q:' + item.value);
          if (typeof metadata !== 'string') throw Error('Missing selected question ordinal');
          const question = JSON.parse(metadata) as WorkflowQuestionDependency;
          if (
            question.address !== item.value ||
            question.candidateId !== candidateId ||
            !Number.isSafeInteger(question.ordinal) ||
            question.ordinal < 0
          )
            throw Error('Invalid selected question ordinal');
          insert.run(
            binding,
            candidateId,
            question.versionId || '',
            question.ordinal,
            question.address,
          );
          yield;
        }
        if (done || page.complete) break;
        const next = page.items.at(-1)?.key;
        if (!next || next === after) throw Error('Selected question dependencies did not advance');
        after = next;
      }
      complete.run(binding, candidateId);
    },
    *records(candidateId: string, versionId: string): Generator<IntakeEnvelopeRecord> {
      current();
      if (!fallbackComplete && !ready.get(binding, candidateId))
        throw Error('Selected questions are not prepared');
      for (const item of read.iterate(
        binding,
        candidateId,
        binding,
        candidateId,
        versionId,
        versionId,
      )) {
        store.check();
        yield view.resolve(String(item.address));
      }
    },
  };
}
