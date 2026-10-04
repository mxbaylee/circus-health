/** Explicit asynchronous preparation shared by command/model entrypoints. */
import type { Database } from './database.ts';
import {
  prepareSelectedSourceContextClassification,
  readSelectedSourceContextClassification,
} from './intake-source-context-state.ts';
import {
  buildVerifiedWorkflowSummary,
  readVerifiedWorkflowFactState,
  readVerifiedWorkflowSummary,
  readVerifiedWorkflowReadingFacts,
} from './intake-workflow-state.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from './intake-collection-envelope.ts';
import { readPackagePlanScope } from './intake-package-plan.ts';
import { prepareDirectPlanAccess, readDirectPlanScope } from './intake-direct-plan.ts';

export async function prepareCollectionWorkflowReadiness(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  options: {
    mappingVersion: string;
    currentMappingVersion?: () => string;
    assertRunning?: () => void;
    onCheckpoint?: () => void | Promise<void>;
  },
) {
  options.assertRunning?.();
  const selectedClassifier = readSelectedSourceContextClassification(db, root, profileId, id);
  const selectedFacts = readVerifiedWorkflowFactState(db, { id }, options);
  const selectedSummary = readVerifiedWorkflowSummary(db, { id }, options);
  const readingFacts = readVerifiedWorkflowReadingFacts(db, { id }, options);
  const view = openIntakeCollectionEnvelope(db, { id }),
    collections = selectedEnvelopeStore(db, { id }).collections;
  const indexesReady =
    collections.get(collections.openView(), 'builds', 'envelope.indexes', 'complete') ===
      JSON.stringify(view.logical) &&
    collections.get(collections.openView(), 'builds', 'envelope.indexes', 'policy') ===
      'health-intake-workflow-index-v6';
  if (
    selectedClassifier.state === 'ready' &&
    selectedFacts.state === 'exact' &&
    selectedSummary.state === 'exact' &&
    readingFacts.state === 'exact' &&
    indexesReady
  ) {
    selectedClassifier.assertCurrent();
    if (options.currentMappingVersion && options.currentMappingVersion() !== options.mappingVersion)
      throw Error('Workflow readiness mapping pins changed');
    return {
      state: 'ready' as const,
      classifier: selectedClassifier,
      facts: selectedFacts,
      counts: selectedSummary.counts,
      reused: true,
    };
  }
  const classifier = await prepareSelectedSourceContextClassification(db, root, profileId, id, {
    assertRunning: options.assertRunning,
  });
  if (classifier.state !== 'ready') return { state: 'pending' as const, reason: classifier.reason };
  const flow = view.child(view.child(view.root(), 'intake')!, 'workflow');
  if (flow) {
    let after: string | undefined;
    do {
      const page = view.children(flow, 'plans', { after, items: 32, bytes: 32768 });
      for (const plan of page.records) {
        const format = view.field(plan, 'format', { bytes: 256 });
        if (format.kind === 'value' && format.value === 'health-intake-direct-plan-v2')
          await prepareDirectPlanAccess(db, profileId, id, {
            recordAddress: view.address(plan),
            assertRunning: options.assertRunning,
          });
      }
      if (page.complete) break;
      if (!page.after || page.after === after) throw Error('Plan preparation failed to advance');
      after = page.after;
    } while (true);
  }
  const built = await buildVerifiedWorkflowSummary(
    db,
    { id },
    {
      ...options,
      isSourceContextVersion: classifier.isSourceContextVersion,
      *implicitUnits(plan, view) {
        const format = view.field(plan, 'format', { bytes: 256 });
        if (format.kind === 'value' && format.value === 'health-intake-direct-plan-v2') {
          const direct = readDirectPlanScope(db, profileId, id, {
            recordAddress: view.address(plan),
          });
          if (!direct) throw Error('Implicit direct unit scope is unavailable');
          for (let ordinal = 0; ordinal < direct.unitCount; ordinal++) {
            options.assertRunning?.();
            classifier.assertCurrent();
            const unit = direct.unitAt(ordinal);
            if (!unit) throw Error('Implicit direct unit proof is unavailable');
            yield {
              planId: direct.planId,
              unitId: unit.id,
              pending: !direct.accountedKind(unit.id),
            };
          }
          return;
        }
        const flow = view.child(view.child(view.root(), 'intake')!, 'workflow');
        const value = view.field(plan, 'id', { bytes: 65536 });
        if (value.kind !== 'value' || typeof value.value !== 'string')
          throw Error('Implicit plan identity is unavailable');
        // Historical plans are counted in their own scope, not the current plan.
        const selected = flow && view.find('plan', flow, value.value);
        if (!selected || view.address(selected) !== view.address(plan))
          throw Error('Implicit plan occurrence requires an unambiguous selected descriptor');
        const scope = readPackagePlanScope(db, root, profileId, id, { planId: value.value });
        if (!scope) throw Error('Implicit package count scope is unavailable');
        for (let offset = 0; offset < scope.plan.unitCount; offset += 100) {
          options.assertRunning?.();
          classifier.assertCurrent();
          for (const member of scope.inventory.range({
            offset,
            limit: Math.min(100, scope.plan.unitCount - offset),
          })) {
            const unit = scope.unit(member.memberId);
            if (!unit) throw Error('Implicit package unit count proof is unavailable');
            yield { planId: scope.planId, unitId: unit.id, pending: !scope.accountedKind(unit.id) };
          }
        }
      },
    },
  );
  classifier.assertCurrent();
  const facts = readVerifiedWorkflowFactState(db, { id }, options);
  if (facts.state !== 'exact')
    return { state: 'pending' as const, reason: 'workflow_changed' as const };
  return { state: 'ready' as const, classifier, facts, counts: built.counts, reused: built.reused };
}
