/** Host entrypoints for checked native model sections. Reads never build indexes. */
import type { Database } from './database.ts';
import { assertIntakeOwner } from './intake.ts';
import { openCollectionModelIntakeBackend } from './intake-model-collection-backend.ts';
import { buildModelIntakeSectionIndexes } from './intake-model-section-build.ts';
import { openImplicitPackageModelUnits } from './intake-model-package-units.ts';
import { openImplicitDirectModelUnits } from './intake-model-direct-units.ts';
import { readDirectPlanScope } from './intake-direct-plan.ts';
import { readPackagePlanScope } from './intake-package-plan.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import { readVerifiedWorkflowSummary } from './intake-workflow-state.ts';
import {
  modelIntakeContextV2,
  type ModelIntakeContextRequestV2,
  type ModelIntakeSectionBackend,
} from './intake-model-context-v4.ts';

type Options = {
  mappingVersion: string;
  currentMappingVersion?: () => string;
  assertRunning?: () => void;
  onCheckpoint?: () => void | Promise<void>;
  /** The mapping authority supplies its own exact mapping-version-bound section. */
  mappingSection?: Pick<ModelIntakeSectionBackend, 'section' | 'sectionPage' | 'externalFragment'>;
};

export function readCollectionModelContext(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  request: ModelIntakeContextRequestV2,
  options: Options,
) {
  assertIntakeOwner(db, profileId);
  options.assertRunning?.();
  if (options.currentMappingVersion && options.currentMappingVersion() !== options.mappingVersion)
    throw Error('Model context mapping pins changed');
  const units =
    openImplicitPackageModelUnits(db, root, profileId, id) ??
    openImplicitDirectModelUnits(db, profileId, id);
  const backend = openCollectionModelIntakeBackend(
    db,
    { id },
    {
      mappingVersion: options.mappingVersion,
      summary: readVerifiedWorkflowSummary(db, { id }, options),
      sectionProvider(section) {
        return section === 'mapping_rules'
          ? options.mappingSection
          : units?.sectionProvider(section);
      },
    },
  );
  return modelIntakeContextV2(backend, request);
}

/** Explicit preparation may cold-build once; unchanged proofs and warm command
 * participants reuse their selected roots without walking retained histories. */
export async function prepareCollectionModelContext(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  request: ModelIntakeContextRequestV2,
  options: Options,
) {
  assertIntakeOwner(db, profileId);
  await prepareCollectionWorkflowReadiness(db, root, profileId, id, options);
  await buildModelIntakeSectionIndexes(
    db,
    { id },
    {
      ...options,
      implicitPlanScope(plan, view) {
        const format = view.field(plan, 'format', { bytes: 256 });
        if (format.kind === 'value' && format.value === 'health-intake-direct-plan-v2') {
          if (!readDirectPlanScope(db, profileId, id, { recordAddress: view.address(plan) }))
            throw Error('Implicit direct model scope is unavailable');
          return;
        }
        const value = view.field(plan, 'id', { bytes: 65536 });
        if (value.kind !== 'value' || typeof value.value !== 'string')
          throw Error('Implicit model plan identity is unavailable');
        const scope = readPackagePlanScope(db, root, profileId, id, { planId: value.value });
        const workflow = view.child(view.child(view.root(), 'intake')!, 'workflow');
        const selected = workflow && view.find('plan', workflow, value.value);
        if (!scope || !selected || view.address(selected) !== view.address(plan))
          throw Error('Implicit model plan occurrence is not selected');
      },
    },
  );
  return readCollectionModelContext(db, root, profileId, id, request, options);
}
