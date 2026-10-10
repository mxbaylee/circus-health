import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { WorkflowScopeUnavailable } from './intake-workflow-collection-reader.ts';
import { readSelectedManualSourceReceipt } from './intake-manual-receipt.ts';

export const WORKFLOW_SEMANTIC_INDEXES = [
  'workflow-version-last',
  'candidate-version-last',
  'version-occurrence-last',
  'draft-version-last',
  'draft-candidate-version-last',
  'draft-record-version-last',
  'manual-source-operation-first',
  'acceptance-version-last',
  'resolution-last',
  'person-assignment-receipt',
  'person-assignment-target',
  'unit-accounted-coverage',
  'batch-unit-coverage',
  'pending-package-failure',
  'accepted-destination',
  'lookup-discovery-maximum',
  'lookup-acceptance-operation-first',
  'lookup-identity-order',
  'active-plan-first',
  'accepted-candidate-version',
  'active-inventory-plan-first',
  'inventory-name-first',
  'navigation-reference-first',
  'navigation-reference-owner',
  'navigation-reference-source',
  'navigation-anchor-first',
  'navigation-anchor-last',
] as const;
export type WorkflowSemanticIndex = (typeof WORKFLOW_SEMANTIC_INDEXES)[number];
export interface WorkflowIndexContribution {
  index: WorkflowSemanticIndex;
  key: readonly string[];
  /** Null removes a prior latest value (e.g. a later empty candidate). */
  target: IntakeEnvelopeRecord | null;
  /** Receipt order, then inverse record ordinal; larger ranks have precedence. */
  rank?: readonly [number, number];
}
export interface WorkflowIndexProgress {
  checkpoint: true;
}

/**
 * Cold index derivation over checked complete scopes. Staging owns checkpoints
 * and publishes the completeness manifest only after this iterator finishes.
 * Contributions are applied in retained order, with last-write semantics.
 * Indexes live in auxiliary collections bound to the input logical root.
 */
export function* workflowIndexContributions(
  view: IntakeCollectionEnvelopeReader,
): Generator<WorkflowIndexContribution | WorkflowIndexProgress> {
  let visited = 0;
  function* tick(): Generator<WorkflowIndexProgress> {
    if (++visited % 64 === 0) yield { checkpoint: true };
  }
  const intake = view.child(view.root(), 'intake');
  if (!intake) throw Error('Selected intake envelope has no intake record');
  const workflow = view.child(intake, 'workflow');
  const read = (record: IntakeEnvelopeRecord, name: string): unknown => {
    const field = view.field(record, name, { bytes: 64 * 1024 });
    if (field.kind === 'fragmented') throw new WorkflowScopeUnavailable(record.kind, name);
    return field.kind === 'missing' ? undefined : field.value;
  };
  const text = (record: IntakeEnvelopeRecord, name: string): string => {
    const value = read(record, name);
    if (typeof value !== 'string') throw new WorkflowScopeUnavailable(record.kind, name);
    return value;
  };
  function* children(
    record: IntakeEnvelopeRecord | undefined,
    name?: string,
  ): Generator<IntakeEnvelopeRecord> {
    if (!record) return;
    if (name !== undefined && view.has(record, name) && !view.child(record, name))
      throw Error(`Intake workflow index ${name} requires a selected structured collection`);
    let after: string | undefined;
    do {
      const options = { after, items: 64, bytes: 128 * 1024 };
      const page =
        name === undefined
          ? view.propertyRecords(record, options)
          : view.children(record, name, options);
      for (const item of page.records) yield item;
      if (page.complete) return;
      if (!page.records.length || !page.after || page.after === after)
        throw Error('Intake workflow index traversal failed to advance');
      after = page.after;
    } while (true);
  }
  // Reverse occurrence order preserves the legacy Array.find first receipt.
  for (let ordinal = view.childCount(intake, 'proposals') - 1; ordinal >= 0; ordinal--) {
    yield* tick();
    const proposal = view.childAt(intake, 'proposals', ordinal)!;
    const receipt = readSelectedManualSourceReceipt(view, proposal);
    if (receipt?.operationId)
      yield {
        index: 'manual-source-operation-first',
        key: [receipt.operationId],
        target: proposal,
      };
  }
  for (const candidate of children(workflow, 'candidates')) {
    yield* tick();
    const candidateId = text(candidate, 'id');
    yield { index: 'candidate-version-last', key: [candidateId], target: null };
    for (const version of children(candidate, 'versions')) {
      yield* tick();
      yield { index: 'workflow-version-last', key: [text(version, 'id')], target: version };
      yield { index: 'candidate-version-last', key: [candidateId], target: version };
      for (const occurrence of children(version, 'occurrences')) {
        yield* tick();
        const proposalId = read(occurrence, 'proposalId');
        if (proposalId !== undefined && proposalId !== null && typeof proposalId !== 'string')
          throw new WorkflowScopeUnavailable(occurrence.kind, 'proposalId');
        yield {
          index: 'version-occurrence-last',
          key: [
            view.address(version),
            JSON.stringify(proposalId ?? null),
            text(occurrence, 'recordId'),
          ],
          target: occurrence,
        };
      }
    }
  }
  for (const draft of children(workflow, 'reviewDrafts')) {
    yield* tick();
    const versionId = text(draft, 'candidateVersionId');
    const candidateId = read(draft, 'candidateId');
    if (candidateId !== null && typeof candidateId !== 'string')
      throw new WorkflowScopeUnavailable(draft.kind, 'candidateId');
    yield { index: 'draft-version-last', key: [versionId], target: draft };
    yield {
      index: 'draft-candidate-version-last',
      key: [JSON.stringify(candidateId), versionId],
      target: draft,
    };
    const proposalId = read(draft, 'proposalId');
    if (proposalId !== undefined && proposalId !== null && typeof proposalId !== 'string')
      throw new WorkflowScopeUnavailable(draft.kind, 'proposalId');
    const recordId = read(draft, 'recordId');
    if (typeof recordId === 'string')
      yield {
        index: 'draft-record-version-last',
        key: [(proposalId || '') as string, recordId, versionId],
        target: draft,
      };
    for (const resolution of children(draft, 'resolutions')) {
      yield* tick();
      yield {
        index: 'resolution-last',
        key: [JSON.stringify(candidateId), versionId, text(resolution, 'issueId')],
        target: resolution,
      };
    }
  }
  for (const decision of children(workflow, 'decisions')) {
    yield* tick();
    if (text(decision, 'action') === 'accept') {
      yield {
        index: 'acceptance-version-last',
        key: [text(decision, 'candidateVersionId')],
        target: decision,
      };
      yield {
        index: 'accepted-candidate-version',
        key: [JSON.stringify(read(decision, 'candidateId')), text(decision, 'candidateVersionId')],
        target: decision,
      };
    }
  }
  for (const receipt of children(workflow, 'identityConfirmations')) {
    yield* tick();
    if (text(receipt, 'outcome') !== 'this_is_person' || !view.child(receipt, 'assignedPerson'))
      continue;
    const operationId = text(receipt, 'operationId');
    const scope = view.child(receipt, 'scope');
    if (!scope) throw Error('Identity receipt has no selected scope');
    const targetField =
      view.child(scope, 'assignmentTargets') || read(scope, 'assignmentTargets')
        ? 'assignmentTargets'
        : 'targets';
    for (const target of children(scope, targetField)) {
      yield* tick();
      const candidateId = read(target, 'candidateId');
      if (candidateId !== null && typeof candidateId !== 'string')
        throw new WorkflowScopeUnavailable(target.kind, 'candidateId');
      const prefix = [operationId, JSON.stringify(candidateId), text(target, 'candidateVersionId')];
      function* issues(): Generator<string> {
        if (!view.child(target, 'issueIds') && !read(target, 'issueIds')) {
          yield text(target, 'issueId');
          return;
        }
        for (const item of children(target, 'issueIds')) yield text(item, 'value');
      }
      for (const issueId of issues()) {
        yield* tick();
        const key = [...prefix, issueId];
        yield { index: 'person-assignment-receipt', key, target: receipt };
        yield { index: 'person-assignment-target', key, target };
      }
    }
  }
  let activePlanSelected = false,
    activeInventorySelected = false;
  for (const plan of children(workflow, 'plans')) {
    yield* tick();
    if (!activePlanSelected && read(plan, 'status') === 'active') {
      yield { index: 'active-plan-first', key: [], target: plan };
      activePlanSelected = true;
    }
    const index = view.child(plan, 'index');
    if (index && read(index, 'inventoryVersion') === 1) {
      if (!activeInventorySelected && read(plan, 'status') === 'active') {
        yield { index: 'active-inventory-plan-first', key: [], target: plan };
        activeInventorySelected = true;
      }
      if (view.has(index, 'members') && !view.child(index, 'members'))
        throw Error('Inventory name index requires a complete structured member collection');
      for (let ordinal = view.childCount(index, 'members') - 1; ordinal >= 0; ordinal--) {
        yield* tick();
        const member = view.childAt(index, 'members', ordinal);
        if (!member) throw Error('Inventory name index member is unavailable');
        yield {
          index: 'inventory-name-first',
          key: [view.address(index), text(member, 'filename')],
          target: member,
        };
      }
    }
    for (const batch of children(plan, 'batches')) {
      yield* tick();
      const batchId = text(batch, 'id');
      for (const coverage of children(batch, 'coverage')) {
        yield* tick();
        const unitId = text(coverage, 'unitId');
        yield {
          index: 'batch-unit-coverage',
          key: [
            view.address(plan),
            batchId,
            unitId,
            text(coverage, 'kind'),
            text(coverage, 'notes'),
          ],
          target: coverage,
        };
      }
    }
  }
  const failures = view.child(intake, 'packageFailures');
  for (const failure of children(failures)) {
    yield* tick();
    if (text(failure, 'status') === 'pending') {
      yield { index: 'pending-package-failure', key: [], target: failure };
      break;
    }
  }
  function* destinations(receipt: IntakeEnvelopeRecord, proposalId: unknown, order: number) {
    if (proposalId !== null && typeof proposalId !== 'string')
      throw Error('Invalid accepted destination proposal ID');
    const clinical = view.child(receipt, 'clinical');
    if (!clinical) return;
    for (let i = view.childCount(clinical, 'records') - 1; i >= 0; i--) {
      yield* tick();
      const item = view.childAt(clinical, 'records', i);
      if (!item) throw Error('Accepted destination record is unavailable');
      const attribution = view.child(item, 'identityAttribution');
      const group = attribution ? read(attribution, 'groupId') : undefined;
      if (group !== undefined && group !== null && typeof group !== 'string')
        throw Error('Invalid accepted destination group ID');
      yield {
        index: 'accepted-destination' as const,
        key: [JSON.stringify(proposalId), text(item, 'recordId'), (group || '') as string],
        target: item,
        rank: [order, -i] as const,
      };
    }
  }
  let receiptOrdinal = 0;
  for (const receipt of children(intake, 'importHistory')) {
    yield* tick();
    yield* destinations(receipt, read(receipt, 'acceptedProposalId'), receiptOrdinal++);
  }
  const imported = view.child(intake, 'imported');
  if (imported) yield* destinations(imported, read(intake, 'acceptedProposalId'), receiptOrdinal);
}

/** Second index pass joins each exact retained unit occurrence to its own attempts. */
export function* workflowUnitIndexContributions(
  view: IntakeCollectionEnvelopeReader,
  lookup: (index: string, key: readonly string[]) => IntakeEnvelopeRecord | undefined,
): Generator<WorkflowIndexContribution | WorkflowIndexProgress> {
  const intake = view.child(view.root(), 'intake'),
    workflow = intake && view.child(intake, 'workflow');
  if (!workflow) return;
  let visited = 0;
  const text = (record: IntakeEnvelopeRecord, name: string) => {
    const field = view.field(record, name, { bytes: 64 * 1024 });
    if (field.kind !== 'value' || typeof field.value !== 'string')
      throw new WorkflowScopeUnavailable(record.kind, name);
    return field.value;
  };
  function* children(record: IntakeEnvelopeRecord, name: string) {
    if (view.has(record, name) && !view.child(record, name))
      throw Error('Unit index requires a complete structured collection');
    for (let i = 0, count = view.childCount(record, name); i < count; i++) {
      const item = view.childAt(record, name, i);
      if (!item) throw Error('Unit index occurrence is unavailable');
      yield item;
    }
  }
  for (const plan of children(workflow, 'plans')) {
    if (++visited % 64 === 0) yield { checkpoint: true };
    for (const unit of children(plan, 'units')) {
      if (++visited % 64 === 0) yield { checkpoint: true };
      const coverage = view.child(unit, 'coverage');
      if (!coverage) continue;
      const unitId = text(unit, 'id'),
        kind = text(coverage, 'kind'),
        notes = text(coverage, 'notes');
      if (text(coverage, 'unitId') !== unitId) continue;
      for (const attempt of children(unit, 'attempts')) {
        if (++visited % 64 === 0) yield { checkpoint: true };
        const target = lookup('batch-unit-coverage', [
          view.address(plan),
          text(attempt, 'value'),
          unitId,
          kind,
          notes,
        ]);
        if (!target) continue;
        yield {
          index: 'unit-accounted-coverage',
          key: [view.address(plan), view.address(unit), kind, notes],
          target,
        };
        break;
      }
    }
  }
}
