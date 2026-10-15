import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type { WorkflowIndexContribution, WorkflowIndexProgress } from './intake-workflow-index.ts';

/** Cold ordered indexes for exact retained reference ownership and anchor ambiguity. */
export function* navigationIndexContributions(
  view: IntakeCollectionEnvelopeReader,
): Generator<WorkflowIndexContribution | WorkflowIndexProgress> {
  const intake = view.child(view.root(), 'intake'),
    workflow = intake && view.child(intake, 'workflow');
  if (!workflow) return;
  const scalar = (record: IntakeEnvelopeRecord, field: string) => {
    const result = view.field(record, field, { bytes: 65536 });
    if (result.kind === 'fragmented')
      throw Error('Navigation index field requires addressed consumption');
    return result.kind === 'missing' ? undefined : result.value;
  };
  const text = (record: IntakeEnvelopeRecord, field: string) => {
    const value = scalar(record, field);
    if (typeof value !== 'string') throw Error('Invalid navigation index identity');
    return value;
  };
  function* records(record: IntakeEnvelopeRecord, field: string, reverse = false) {
    if (view.has(record, field) && !view.child(record, field))
      throw Error('Navigation index requires a complete structured child scope');
    const count = view.childCount(record, field);
    for (let i = 0; i < count; i++) {
      const selected = view.childAt(record, field, reverse ? count - i - 1 : i);
      if (!selected) throw Error('Missing navigation index occurrence');
      yield selected;
    }
  }
  let visited = 0;
  function* sources(plan: IntakeEnvelopeRecord, index: IntakeEnvelopeRecord) {
    if (scalar(index, 'kind') !== 'zip') {
      yield { source: plan, index };
      return;
    }
    for (const member of records(index, 'members', true)) {
      yield {
        source: member,
        index: scalar(member, 'sourceFileId') ? view.child(member, 'index') : undefined,
      };
    }
  }
  for (const plan of records(workflow, 'plans')) {
    const root = view.child(plan, 'index');
    if (++visited % 64 === 0) yield { checkpoint: true };
    if (!root) continue;
    for (const source of sources(plan, root)) {
      if (++visited % 64 === 0) yield { checkpoint: true };
      if (!source.index) continue;
      for (const reference of records(source.index, 'references', true)) {
        const key = [view.address(root), text(reference, 'id')];
        yield { index: 'navigation-reference-first', key, target: reference };
        yield { index: 'navigation-reference-owner', key, target: source.index };
        yield { index: 'navigation-reference-source', key, target: source.source };
      }
      for (const anchor of records(source.index, 'anchors')) {
        yield {
          index: 'navigation-anchor-last',
          key: [view.address(source.index), text(anchor, 'name')],
          target: anchor,
        };
      }
      for (const anchor of records(source.index, 'anchors', true)) {
        yield {
          index: 'navigation-anchor-first',
          key: [view.address(source.index), text(anchor, 'name')],
          target: anchor,
        };
      }
    }
  }
}
