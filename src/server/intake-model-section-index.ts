import {
  intakeEnvelopeRecordOrder,
  intakeEnvelopePropertyOrder,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { schemaOrdinal } from './intake-envelope-schema.ts';
import type { ModelIntakeSection } from './intake-model-context.ts';

export interface ModelIntakeSectionContribution {
  section: Exclude<ModelIntakeSection, 'mapping_rules'>;
  tag: string;
  /** Parent references preserve exact public identity without copying growing nested state. */
  records: readonly IntakeEnvelopeRecord[];
}
export interface ModelIntakeSectionProgress {
  checkpoint: true;
  visitedContainers: number;
}
/** Map order supports an insertion in an earlier parent without shifting N entries. */
export function modelIntakeSectionOrder(
  view: IntakeCollectionEnvelopeReader,
  contribution: ModelIntakeSectionContribution,
): string {
  const record = contribution.records.at(-1);
  if (!record) throw Error('Model section contribution has no addressed record');
  const priority =
    contribution.tag === 'review_draft' || contribution.tag === 'import_history' ? 1 : 0;
  const path =
    contribution.section === 'package_failures'
      ? intakeEnvelopePropertyOrder(view, record)
      : intakeEnvelopeRecordOrder(view, record);
  const key = priority + ':' + path.map(schemaOrdinal).join(':');
  if (Buffer.byteLength(key) > 1024)
    throw Error('Model section occurrence exceeds the ordered-key budget');
  return key;
}

/**
 * Cold, bounded-memory flattened section inventory. The host stages ordered
 * auxiliary sequences and publishes exact totals only after all contributions
 * are selected under the same input logical/source pins. Mapping rules have
 * their own authoritative mapping-version bound reader.
 */
export function* modelIntakeSectionContributions(
  view: IntakeCollectionEnvelopeReader,
  options: {
    /** Register virtual unit/batch/dependency scopes under the selected package plan. */
    implicitPlanScope?: (plan: IntakeEnvelopeRecord, active: boolean) => void;
  } = {},
): Generator<ModelIntakeSectionContribution | ModelIntakeSectionProgress> {
  const intake = view.child(view.root(), 'intake');
  if (!intake) throw Error('Selected intake envelope has no intake record');
  const workflow = view.child(intake, 'workflow');
  function* children(
    record: IntakeEnvelopeRecord | undefined,
    name?: string,
  ): Generator<IntakeEnvelopeRecord> {
    if (!record) return;
    if (name !== undefined && view.has(record, name) && !view.child(record, name))
      throw Error(`Intake model section ${name} requires a selected structured collection`);
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
        throw Error('Intake model section inventory failed to advance');
      after = page.after;
    } while (true);
  }
  let activeSeen = false;
  for (const plan of children(workflow, 'plans')) {
    yield { section: 'plan', tag: 'plan', records: [plan] };
    const status = view.field(plan, 'status', { bytes: 256 });
    if (status.kind !== 'value' || typeof status.value !== 'string')
      throw Error('Intake model plan status is unavailable');
    const format = view.field(plan, 'format', { bytes: 256 });
    const implicit =
      format.kind === 'value' &&
      ['health-intake-package-plan-v2', 'health-intake-direct-plan-v2'].includes(
        String(format.value),
      );
    if (implicit) {
      if (!options.implicitPlanScope)
        throw Error('Implicit package model sections require their checked scope provider');
      options.implicitPlanScope(plan, !activeSeen && status.value === 'active');
    }
    if (!activeSeen && status.value === 'active') {
      activeSeen = true;
      if (!implicit) {
        for (const unit of children(plan, 'units'))
          yield { section: 'units', tag: 'unit', records: [plan, unit] };
        for (const asset of children(view.child(plan, 'index'), 'missingAssets'))
          yield { section: 'missing_assets', tag: 'missing_asset', records: [plan, asset] };
      }
    }
    for (const batch of children(plan, 'batches'))
      yield { section: 'batches', tag: 'batch', records: [plan, batch] };
  }
  let visitedContainers = 0;
  for (const candidate of children(workflow, 'candidates')) {
    for (const version of children(candidate, 'versions')) {
      yield { section: 'candidates', tag: 'candidate_version', records: [candidate, version] };
      for (const occurrence of children(version, 'occurrences'))
        yield {
          section: 'occurrences',
          tag: 'candidate_occurrence',
          records: [candidate, version, occurrence],
        };
    }
    if (++visitedContainers % 64 === 0) yield { checkpoint: true, visitedContainers };
  }
  for (const group of children(workflow, 'reportGroups')) {
    for (const version of children(group, 'versions'))
      yield { section: 'report_scopes', tag: 'report_group_version', records: [group, version] };
    if (++visitedContainers % 64 === 0) yield { checkpoint: true, visitedContainers };
  }
  for (const question of children(workflow, 'questions')) {
    yield { section: 'questions', tag: 'question', records: [question] };
    for (const answer of children(question, 'answers'))
      yield { section: 'question_answers', tag: 'question_answer', records: [question, answer] };
  }
  for (const proposal of children(intake, 'proposals'))
    yield { section: 'proposals', tag: 'proposal', records: [proposal] };
  for (const decision of children(workflow, 'decisions'))
    yield { section: 'decisions', tag: 'accepted_decision', records: [decision] };
  for (const draft of children(workflow, 'reviewDrafts'))
    yield { section: 'decisions', tag: 'review_draft', records: [draft] };
  for (const operation of children(workflow, 'operations'))
    yield { section: 'operations', tag: 'operation', records: [operation] };
  const accepted = view.field(intake, 'acceptedProposalId', { bytes: 64 * 1024 });
  if (accepted.kind === 'fragmented')
    throw Error('Intake accepted proposal identity is unavailable');
  if ((accepted.kind === 'value' && accepted.value) || view.child(intake, 'imported'))
    yield { section: 'acceptances', tag: 'current_acceptance', records: [intake] };
  for (const historical of children(intake, 'importHistory'))
    yield { section: 'acceptances', tag: 'import_history', records: [historical] };
  for (const failure of children(view.child(intake, 'packageFailures')))
    yield { section: 'package_failures', tag: 'package_failure', records: [failure] };
}
