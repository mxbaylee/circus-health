/** Cold, complete reverse joins used by changed-occurrence workflow recounts. */
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { schemaKey, schemaOrdinal } from './intake-envelope-schema.ts';
import { collectionWorkflowCountReader } from './intake-workflow-collection-reader.ts';
import { workflowVersionIsSourceContext } from './intake-workflow-reader.ts';

export const WORKFLOW_DEPENDENCY_POLICY = 'health-intake-workflow-dependencies-v2';
export interface WorkflowCandidateDependency {
  address: string;
  id: string;
  ordinal: number;
  factKey: readonly string[];
  pendingVersions: number;
  reviewLaterCount: number;
}
export interface WorkflowVersionDependency {
  address: string;
  candidate: string;
  id: string;
  candidateOrdinal: number;
  ordinal: number;
  pending: boolean;
  reviewLater: boolean;
}
export interface WorkflowQuestionDependency {
  address: string;
  id: string;
  candidateId: string | null;
  versionId: string | null;
  ordinal: number;
  factKey: readonly string[];
}
export type WorkflowDependencyContribution = { key: string; value: string } | { checkpoint: true };
export const workflowDependencyPrefix = (kind: string, id: string) =>
  'd:' + schemaKey(kind, id) + ':';
/** Descending order makes the effective last occurrence a single forward seek. */
export const workflowDependencyOrder = (ordinal: number) => {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw Error('Invalid dependency ordinal');
  return schemaOrdinal(Number.MAX_SAFE_INTEGER - ordinal);
};
export function workflowSubstantiveVersionKey(
  view: IntakeCollectionEnvelopeReader,
  candidateAddress: string,
  version: IntakeEnvelopeRecord,
): string {
  const digest = view.field(version, 'contentDigest', { bytes: 65536 });
  if (
    digest.kind === 'fragmented' ||
    (digest.kind === 'value' && digest.value !== null && typeof digest.value !== 'string')
  )
    throw Error('Invalid substantive version digest');
  const id = view.field(version, 'id', { bytes: 65536 });
  if (id.kind !== 'value' || typeof id.value !== 'string')
    throw Error('Invalid substantive version identity');
  return (
    's:' + candidateAddress + ':' + schemaKey((digest.kind === 'value' && digest.value) || id.value)
  );
}

export function* workflowDependencyContributions(
  view: IntakeCollectionEnvelopeReader,
  options: { isSourceContextVersion(versionId: string): boolean },
): Generator<WorkflowDependencyContribution> {
  const intake = view.child(view.root(), 'intake');
  if (!intake) throw Error('Missing dependency intake');
  const workflow = view.child(intake, 'workflow');
  const reader = collectionWorkflowCountReader(view, options);
  let inspected = 0;
  function* tick(): Generator<WorkflowDependencyContribution> {
    if (++inspected % 64 === 0) yield { checkpoint: true };
  }
  function* children(record: IntakeEnvelopeRecord | undefined, field: string) {
    if (!record) return;
    if (view.has(record, field) && !view.child(record, field))
      throw Error('Dependency scope must be a complete structured collection');
    let after: string | undefined;
    do {
      const page = view.children(record, field, { after, items: 64, bytes: 128 * 1024 });
      yield* page.records;
      if (page.complete) return;
      if (!page.after || page.after === after || !page.records.length)
        throw Error('Dependency scope failed to advance');
      after = page.after;
    } while (true);
  }
  let candidateOrdinal = 0;
  for (const candidate of children(workflow, 'candidates')) {
    const header = reader.candidateHeader(candidate);
    const address = view.address(candidate);
    const state: WorkflowCandidateDependency = {
      address,
      id: header.id,
      ordinal: candidateOrdinal,
      factKey: ['candidate', header.id, String(candidateOrdinal)],
      pendingVersions: 0,
      reviewLaterCount: 0,
    };
    let ordinal = 0;
    for (const version of children(candidate, 'versions')) {
      const header = reader.versionHeader(version);
      const pending =
        header.status === 'pending' &&
        !header.peopleOnly &&
        !workflowVersionIsSourceContext(reader, header);
      const reviewLater = pending && reader.latestDraft(header.id)?.disposition === 'review_later';
      const value: WorkflowVersionDependency = {
        address: view.address(version),
        candidate: address,
        id: header.id,
        candidateOrdinal,
        ordinal,
        pending,
        reviewLater,
      };
      state.pendingVersions += Number(pending);
      state.reviewLaterCount += Number(reviewLater);
      yield { key: 'v:' + value.address, value: JSON.stringify(value) };
      yield { key: workflowSubstantiveVersionKey(view, address, version), value: '1' };
      yield {
        key:
          workflowDependencyPrefix('version', header.id) +
          workflowDependencyOrder(candidateOrdinal) +
          ':' +
          workflowDependencyOrder(ordinal),
        value: value.address,
      };
      ordinal++;
      yield* tick();
    }
    yield { key: 'c:' + address, value: JSON.stringify(state) };
    yield {
      key:
        workflowDependencyPrefix('candidate', header.id) +
        workflowDependencyOrder(candidateOrdinal),
      value: address,
    };
    candidateOrdinal++;
    yield* tick();
  }
  let ordinal = 0;
  for (const item of children(workflow, 'questions')) {
    const question = reader.questionHeader(item);
    const address = view.address(item);
    const value: WorkflowQuestionDependency = {
      address,
      id: question.id,
      candidateId: question.candidateId,
      versionId: question.candidateVersionId,
      ordinal,
      factKey: ['question', question.id, String(ordinal)],
    };
    yield { key: 'q:' + address, value: JSON.stringify(value) };
    if (question.candidateId)
      yield {
        key: workflowDependencyPrefix('question-candidate', question.candidateId) + address,
        value: address,
      };
    if (question.candidateVersionId)
      yield {
        key: workflowDependencyPrefix('question-version', question.candidateVersionId) + address,
        value: address,
      };
    ordinal++;
    yield* tick();
  }
  yield { key: 'candidateCount', value: String(candidateOrdinal) };
  yield { key: 'questionCount', value: String(ordinal) };
  let batchCount = 0,
    planOrdinal = 0,
    previousPlanId: string | undefined;
  for (const plan of children(workflow, 'plans')) {
    batchCount += view.childCount(plan, 'batches');
    if (!Number.isSafeInteger(batchCount)) throw Error('Workflow batch count overflow');
    const read = (name: string) => {
      const value = view.field(plan, name, { bytes: 65536 });
      if (value.kind === 'fragmented') throw Error('Fragmented plan dependency header');
      return value.kind === 'value' ? value.value : undefined;
    };
    if (read('status') === 'superseded') continue;
    const count = ['health-intake-package-plan-v2', 'health-intake-direct-plan-v2'].includes(
      String(read('format')),
    )
      ? read('unitCount')
      : view.childCount(plan, 'units');
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      throw Error('Invalid plan dependency count');
    if (!count) continue;
    const id = read('id');
    if (typeof id !== 'string') throw Error('Invalid plan dependency identity');
    if (previousPlanId !== undefined && previousPlanId !== id) planOrdinal++;
    previousPlanId = id;
    yield {
      key: 'p:' + view.address(plan),
      value: JSON.stringify({ factKey: ['plan', id, String(planOrdinal)] }),
    };
    yield* tick();
  }
  yield { key: 'batchCount', value: String(batchCount) };
  yield { key: 'policy', value: WORKFLOW_DEPENDENCY_POLICY };
  yield { key: 'complete', value: JSON.stringify(view.logical) };
}
