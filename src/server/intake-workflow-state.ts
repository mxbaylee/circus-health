import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeEnvelopeRecord,
  type IntakeCollectionEnvelopeReader,
} from './intake-collection-envelope.ts';
import { schemaKey } from './intake-envelope-schema.ts';
import { collectionModelIntakePins } from './intake-model-collection-backend.ts';
import type { ModelIntakePinsV2 } from './intake-model-context-v4.ts';
import { collectionWorkflowCountReader } from './intake-workflow-collection-reader.ts';
import {
  workflowIndexContributions,
  workflowUnitIndexContributions,
} from './intake-workflow-index.ts';
import { intakeLookupContributions } from './intake-lookup-contributions.ts';
import { navigationIndexContributions } from './intake-navigation-index.ts';
import {
  workflowQuestionNeedsAnswer,
  workflowVersionIsSourceContext,
  type WorkflowCounts,
} from './intake-workflow-reader.ts';
import { workflowCountsFromFacts, type WorkflowCountFacts } from './intake-workflow-counts.ts';
import { legacyDraftPolicyContributions } from './intake-draft-policy-index.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import {
  workflowDependencyContributions,
  WORKFLOW_DEPENDENCY_POLICY,
} from './intake-workflow-dependencies.ts';

const empty = (): WorkflowCountFacts => ({
  pendingCount: 0,
  reviewLaterCount: 0,
  unansweredCount: 0,
  pendingWorkCount: 0,
  pendingPackageFailures: 0,
});
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const WORKFLOW_COUNT_POLICY = 'health-intake-workflow-counts-v1';
const policy = WORKFLOW_COUNT_POLICY;
export interface WorkflowSummaryManifest {
  format: typeof policy;
  binding: string;
  pins: ModelIntakePinsV2;
  facts: WorkflowCountFacts;
  collection: string;
  root: string;
  count: number;
}
export type SelectedWorkflowSummary =
  | { state: 'exact'; binding: string; counts: WorkflowCounts }
  | { state: 'pending'; binding: string; counts: null };

/** Checked selected facts only. Never starts a cold scan from an interactive read. */
export function readVerifiedWorkflowSummary(
  db: Database,
  source: IntakeEnvelopeSource,
  options: { mappingVersion: string },
): SelectedWorkflowSummary {
  const pins = collectionModelIntakePins(db, source, options.mappingVersion);
  const binding = hash([policy, pins]);
  const { collections } = selectedEnvelopeStore(db, source);
  const view = collections.openView();
  const value = collections.get(view, 'builds', 'workflow.summary', 'current');
  if (value === undefined) return { state: 'pending', binding, counts: null };
  if (typeof value !== 'string') throw Error('Invalid workflow summary manifest');
  const manifest = JSON.parse(value) as WorkflowSummaryManifest;
  if (manifest.format !== policy) throw Error('Invalid workflow summary format');
  if (manifest.binding !== binding || JSON.stringify(manifest.pins) !== JSON.stringify(pins))
    return { state: 'pending', binding, counts: null };
  const descriptor = collections.collection(view, 'builds', manifest.collection);
  if (
    !descriptor ||
    descriptor.kind !== 'map' ||
    descriptor.root?.hash !== manifest.root ||
    descriptor.root?.count !== manifest.count
  )
    throw Error('Workflow summary fact root is unavailable');
  return { state: 'exact', binding, counts: workflowCountsFromFacts(manifest.facts) };
}

/** Domain command reducer input, including the otherwise hidden failure-set fact. */
export function readVerifiedWorkflowFactState(
  db: Database,
  source: IntakeEnvelopeSource,
  options: { mappingVersion: string },
) {
  const summary = readVerifiedWorkflowSummary(db, source, options);
  if (summary.state !== 'exact') return { state: 'pending' as const, binding: summary.binding };
  const { collections } = selectedEnvelopeStore(db, source);
  const raw = collections.get(collections.openView(), 'builds', 'workflow.summary', 'current');
  if (typeof raw !== 'string') throw Error('Selected workflow facts are unavailable');
  const manifest = JSON.parse(raw) as WorkflowSummaryManifest;
  if (manifest.binding !== summary.binding) throw Error('Selected workflow facts changed');
  return { state: 'exact' as const, binding: summary.binding, facts: { ...manifest.facts } };
}

/** Exact selected reading totals; unavailable dependency generations remain explicit. */
export function readVerifiedWorkflowReadingFacts(
  db: Database,
  source: IntakeEnvelopeSource,
  options: { mappingVersion: string },
) {
  const summary = readVerifiedWorkflowSummary(db, source, options);
  if (summary.state !== 'exact') return { state: 'pending' as const };
  const view = openIntakeCollectionEnvelope(db, source);
  const { collections } = selectedEnvelopeStore(db, source);
  const selected = collections.openView();
  const get = (key: string) => collections.get(selected, 'builds', 'workflow.dependencies', key);
  if (
    get('policy') !== WORKFLOW_DEPENDENCY_POLICY ||
    get('complete') !== JSON.stringify(view.logical) ||
    get('binding') !== summary.binding
  )
    return { state: 'pending' as const };
  const candidateCount = Number(get('candidateCount')),
    proposalsProduced = Number(get('batchCount'));
  if (![candidateCount, proposalsProduced].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw Error('Invalid selected reading facts');
  const substantiveVersions =
    collections.rank(selected, 'builds', 'workflow.dependencies', 's;') -
    collections.rank(selected, 'builds', 'workflow.dependencies', 's:');
  const candidateVersionCount =
    collections.rank(selected, 'builds', 'workflow.dependencies', 'v;') -
    collections.rank(selected, 'builds', 'workflow.dependencies', 'v:');
  return {
    state: 'exact' as const,
    candidateCount,
    candidateVersionCount,
    substantiveVersions,
    proposalsProduced,
  };
}

/**
 * Explicit cold maintenance. Each candidate/question and plan contributes once;
 * implicit inventory units are streamed into a plan aggregate, never N derived rows.
 * Interrupted builds remain unselected, and a domain/policy change reads pending.
 */
export async function buildVerifiedWorkflowSummary(
  db: Database,
  source: IntakeEnvelopeSource,
  options: {
    mappingVersion: string;
    currentMappingVersion?: () => string;
    isSourceContextVersion(versionId: string): boolean;
    implicitUnits?: (
      plan: IntakeEnvelopeRecord,
      view: IntakeCollectionEnvelopeReader,
    ) => Iterable<{ planId: string; unitId: string; pending: boolean }>;
    assertRunning?: () => void;
    onCheckpoint?: () => void | Promise<void>;
  },
) {
  const previous = readVerifiedWorkflowSummary(db, source, options);
  const view = openIntakeCollectionEnvelope(db, source);
  const { collections } = selectedEnvelopeStore(db, source);
  if (
    previous.state === 'exact' &&
    collections.get(collections.openView(), 'builds', 'workflow.dependencies', 'complete') ===
      JSON.stringify(view.logical) &&
    collections.get(collections.openView(), 'builds', 'workflow.dependencies', 'binding') ===
      previous.binding &&
    collections.get(collections.openView(), 'builds', 'workflow.dependencies', 'policy') ===
      WORKFLOW_DEPENDENCY_POLICY &&
    collections.get(collections.openView(), 'builds', 'envelope.indexes', 'complete') ===
      JSON.stringify(view.logical) &&
    collections.get(collections.openView(), 'builds', 'envelope.indexes', 'policy') ===
      'health-intake-workflow-index-v6'
  )
    return { ...previous, reused: true };
  const pins = collectionModelIntakePins(db, source, options.mappingVersion);
  const binding = hash([policy, pins]);
  const buildId = randomUUID(),
    indexCollection = 'workflow.' + buildId + '.indexes',
    factCollection = 'workflow.' + buildId + '.facts',
    dependencyCollection = 'workflow.' + buildId + '.dependencies';
  const changes: IntakeCollectionChange[] = [];
  let inspected = 0,
    factCount = 0,
    phase: 'indexes' | 'counts' = 'indexes';
  const total = empty();
  const current = () => {
    options.assertRunning?.();
    view.address(view.root());
    if (
      JSON.stringify(collectionModelIntakePins(db, source, options.mappingVersion)) !==
        JSON.stringify(pins) ||
      (options.currentMappingVersion && options.currentMappingVersion() !== options.mappingVersion)
    )
      throw Error('Workflow summary source or policy pins changed');
  };
  const commit = (batch: IntakeCollectionChange[]) => {
    current();
    const operationId = randomUUID();
    collections.commitMaintenance(
      collections.prepare(collections.openView(), {
        operationId,
        requestDigest: hash(operationId),
        domainVersion: pins.domainVersion,
        changes: batch,
      }),
    );
  };
  const checkpoint = async () => {
    const batch = changes.splice(0);
    batch.push({
      area: 'builds',
      collection: 'workflow.builds',
      op: 'put',
      key: buildId,
      value: JSON.stringify({
        format: policy,
        state: 'building',
        binding,
        pins,
        phase,
        inspected,
        factCount,
        indexCollection,
        factCollection,
      }),
    });
    commit(batch);
    await options.onCheckpoint?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    current();
  };
  const semanticComplete = collections.get(
    collections.openView(),
    'builds',
    'envelope.indexes',
    'complete',
  );
  if (
    semanticComplete !== JSON.stringify(view.logical) ||
    collections.get(collections.openView(), 'builds', 'envelope.indexes', 'policy') !==
      'health-intake-workflow-index-v6'
  ) {
    const firstView = openIntakeCollectionEnvelope(db, source, { fieldSelection: 'first' });
    for (const contribution of legacyDraftPolicyContributions(view)) {
      if ('checkpoint' in contribution) {
        await checkpoint();
        continue;
      }
      changes.push({
        area: 'builds',
        collection: indexCollection,
        op: 'put',
        key: contribution.key,
        value: contribution.value,
      });
      if (changes.length >= 15) await checkpoint();
    }
    for (const [reader, contributions] of [
      [view, workflowIndexContributions(view)],
      [view, navigationIndexContributions(view)],
      [firstView, intakeLookupContributions(db, firstView)],
    ] as const)
      for (const contribution of contributions) {
        if ('checkpoint' in contribution) {
          await checkpoint();
          continue;
        }
        const key = schemaKey(contribution.index, ...contribution.key);
        changes.push(
          contribution.target
            ? {
                area: 'builds',
                collection: indexCollection,
                op: 'put',
                key,
                value: reader.address(contribution.target),
              }
            : { area: 'builds', collection: indexCollection, op: 'delete', key },
        );
        if (contribution.rank)
          changes.push({
            area: 'builds',
            collection: indexCollection,
            op: 'put',
            key: 'rank:' + key,
            value: JSON.stringify(contribution.rank),
          });
        inspected++;
        if (changes.length >= 15) await checkpoint();
      }
    await checkpoint();
    for (const contribution of workflowUnitIndexContributions(view, (index, key) => {
      const target = collections.get(
        collections.openView(),
        'builds',
        indexCollection,
        schemaKey(index, ...key),
      );
      if (target === undefined) return undefined;
      if (typeof target !== 'string') throw Error('Invalid staged workflow index target');
      return view.resolve(target);
    })) {
      if ('checkpoint' in contribution) {
        await checkpoint();
        continue;
      }
      if (!contribution.target) throw Error('Unexpected empty unit index target');
      changes.push({
        area: 'builds',
        collection: indexCollection,
        op: 'put',
        key: schemaKey(contribution.index, ...contribution.key),
        value: view.address(contribution.target),
      });
      inspected++;
      if (changes.length >= 15) await checkpoint();
    }
    await checkpoint();
    commit([
      {
        area: 'builds',
        collection: indexCollection,
        op: 'put',
        key: 'policy',
        value: 'health-intake-workflow-index-v6',
      },
      {
        area: 'builds',
        collection: indexCollection,
        op: 'put',
        key: 'complete',
        value: JSON.stringify(view.logical),
      },
      {
        area: 'builds',
        collection: 'envelope.indexes',
        op: 'adoptCollection',
        fromArea: 'builds',
        fromCollection: indexCollection,
      },
    ]);
  }
  phase = 'counts';
  const reader = collectionWorkflowCountReader(view, options);
  const add = async (key: readonly string[], patch: Partial<WorkflowCountFacts>) => {
    const facts = { ...empty(), ...patch };
    workflowCountsFromFacts(facts);
    for (const name of Object.keys(total) as (keyof WorkflowCountFacts)[])
      total[name] += facts[name];
    workflowCountsFromFacts(total);
    changes.push({
      area: 'builds',
      collection: factCollection,
      op: 'put',
      key: schemaKey(...key),
      value: JSON.stringify({ key, facts }),
    });
    factCount++;
    if (changes.length >= 15) await checkpoint();
  };
  const tick = async () => {
    if (++inspected % 64 === 0) await checkpoint();
  };
  let ordinal = 0;
  for (const candidate of reader.candidates()) {
    let pendingCount = 0,
      reviewLaterCount = 0;
    for (const version of reader.versions(candidate)) {
      if (
        version.status === 'pending' &&
        !version.peopleOnly &&
        !workflowVersionIsSourceContext(reader, version)
      ) {
        pendingCount = 1;
        if (reader.latestDraft(version.id)?.disposition === 'review_later') reviewLaterCount++;
      }
      await tick();
    }
    await add(['candidate', candidate.id, String(ordinal++)], { pendingCount, reviewLaterCount });
    await tick();
  }
  ordinal = 0;
  for (const question of reader.questions()) {
    await add(['question', question.id, String(ordinal++)], {
      unansweredCount: workflowQuestionNeedsAnswer(reader, question) ? 1 : 0,
    });
    await tick();
  }
  let planId: string | undefined,
    pendingWorkCount = 0,
    planOrdinal = 0;
  for (const unit of reader.units()) {
    if (planId !== undefined && planId !== unit.planId) {
      await add(['plan', planId, String(planOrdinal++)], { pendingWorkCount });
      pendingWorkCount = 0;
    }
    planId = unit.planId;
    if (unit.pending) pendingWorkCount++;
    await tick();
  }
  if (planId !== undefined) await add(['plan', planId, String(planOrdinal)], { pendingWorkCount });
  await add(['package-failure-set'], {
    pendingPackageFailures: reader.hasPendingPackageFailure() ? 1 : 0,
  });
  for (const contribution of workflowDependencyContributions(view, options)) {
    if ('checkpoint' in contribution) await checkpoint();
    else {
      changes.push({
        area: 'builds',
        collection: dependencyCollection,
        op: 'put',
        ...contribution,
      });
      if (changes.length >= 15) await checkpoint();
    }
  }
  changes.push({
    area: 'builds',
    collection: dependencyCollection,
    op: 'put',
    key: 'binding',
    value: binding,
  });
  await checkpoint();
  const descriptor = collections.collection(collections.openView(), 'builds', factCollection);
  if (!descriptor?.root || descriptor.root.count !== factCount)
    throw Error('Incomplete workflow summary facts');
  const manifest: WorkflowSummaryManifest = {
    format: policy,
    binding,
    pins,
    facts: total,
    collection: factCollection,
    root: descriptor.root.hash,
    count: factCount,
  };
  commit([
    {
      area: 'builds',
      collection: 'workflow.dependencies',
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: dependencyCollection,
    },
    {
      area: 'builds',
      collection: 'workflow.summary',
      op: 'put',
      key: 'current',
      value: JSON.stringify(manifest),
    },
    {
      area: 'builds',
      collection: 'workflow.builds',
      op: 'put',
      key: buildId,
      value: JSON.stringify({
        format: policy,
        state: 'complete',
        binding,
        pins,
        factCollection,
        factCount,
      }),
    },
  ]);
  return {
    state: 'exact' as const,
    binding,
    counts: workflowCountsFromFacts(total),
    reused: false,
  };
}

/** At most two checked point joins; pending semantic indexes throw, never look empty. */
export function openSelectedAcceptedDestinations(db: Database, source: IntakeEnvelopeSource) {
  const view = openIntakeCollectionEnvelope(db, source);
  const { collections } = selectedEnvelopeStore(db, source);
  const select = (
    proposalId: string | null,
    groupId: string,
    recordId: string,
  ): IntakeEnvelopeRecord | undefined => {
    const lookup = (group: string) => {
      const key = [JSON.stringify(proposalId), recordId, group];
      const target = view.lookup('accepted-destination', key);
      if (!target) return undefined;
      const value = collections.get(
        collections.openView(),
        'builds',
        'envelope.indexes',
        'rank:' + schemaKey('accepted-destination', ...key),
      );
      if (typeof value !== 'string') throw Error('Accepted destination rank is unavailable');
      const rank = JSON.parse(value) as [number, number];
      if (!Array.isArray(rank) || rank.length !== 2 || !rank.every(Number.isSafeInteger))
        throw Error('Invalid accepted destination rank');
      return { target, rank };
    };
    const unscoped = lookup(''),
      scoped = groupId ? lookup(groupId) : undefined;
    if (!scoped) return unscoped?.target;
    if (!unscoped) return scoped.target;
    return scoped.rank[0] > unscoped.rank[0] ||
      (scoped.rank[0] === unscoped.rank[0] && scoped.rank[1] > unscoped.rank[1])
      ? scoped.target
      : unscoped.target;
  };
  return { view, select };
}
