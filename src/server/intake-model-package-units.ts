import { createHash } from 'node:crypto';
import { HttpError, type Database } from './database.ts';
import { readPackagePlanScope, readPackageUnitPage } from './intake-package-plan.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import { selectedEnvelopeStore } from './intake-collection-envelope.ts';
import type { ModelIntakeSection } from './intake-model-context.ts';
import type {
  ModelCurrentUnitScopeV2,
  ModelIntakeSectionBackend,
} from './intake-model-context-v4.ts';

/**
 * Virtual unit section for an explicitly selected v2 package plan. Its inventory
 * descriptor proves total/order; only the requested ordinal window is derived.
 * Legacy explicit plan arrays use the ordinary schema section backend.
 */
export function openImplicitPackageModelUnits(
  db: Database,
  root: string,
  profileId: string,
  id: string,
) {
  const collections = selectedEnvelopeStore(db, { id }).collections;
  if (
    collections.get(collections.openView(), 'logical', 'package.selection', 'active') === undefined
  )
    return undefined;
  const initial = readPackagePlanScope(db, root, profileId, id);
  if (!initial) return undefined;
  const version = intakeSourceVersion(db, id);
  const scopeRoot = createHash('sha256')
    .update(
      JSON.stringify([
        'health-intake-model-implicit-units-v1',
        version.logicalBinding,
        initial.planId,
        initial.inventory.inventoryId,
        initial.plan.unitRecipe,
        initial.plan.unitCount,
      ]),
    )
    .digest('hex');
  const current = () => {
    const latest = intakeSourceVersion(db, id);
    if (latest.logicalBinding !== version.logicalBinding || latest.version !== version.version)
      throw new HttpError(
        409,
        'MODEL_CONTEXT_CHANGED',
        'This intake changed. Start a fresh model context.',
      );
    const scope = readPackagePlanScope(db, root, profileId, id);
    if (
      !scope ||
      scope.planId !== initial.planId ||
      scope.inventory.inventoryId !== initial.inventory.inventoryId ||
      scope.plan.unitCount !== initial.plan.unitCount
    )
      throw new HttpError(
        409,
        'MODEL_CONTEXT_CHANGED',
        'This package inventory changed. Start a fresh model context.',
      );
    return scope;
  };
  const page = (offset: number, limit: number, bytes: number) => {
    current();
    const result = readPackageUnitPage(db, root, profileId, id, {
      offset,
      limit,
      bytes: Math.min(bytes, 10000),
      inlineBytes: 0,
    });
    if (
      result.planId !== initial.planId ||
      result.version !== initial.version ||
      result.inventoryId !== initial.inventory.inventoryId ||
      result.total !== initial.plan.unitCount
    )
      throw Error('Implicit model unit page changed');
    return result;
  };
  const provider: Pick<ModelIntakeSectionBackend, 'section' | 'sectionPage'> = {
    section(section) {
      if (section !== 'units') throw Error('Wrong implicit model section');
      current();
      return { state: 'complete', root: scopeRoot, count: initial.plan.unitCount };
    },
    sectionPage(section, options) {
      if (section !== 'units') throw Error('Wrong implicit model section');
      if (
        !Number.isSafeInteger(options.items) ||
        options.items < 1 ||
        options.items > 8 ||
        !Number.isSafeInteger(options.bytes) ||
        options.bytes < 2048
      )
        throw Error('Invalid implicit model unit page budget');
      const offset = options.after === undefined ? 0 : Number(options.after);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > initial.plan.unitCount ||
        (options.after !== undefined && String(offset) !== options.after)
      )
        throw Error('Invalid implicit model unit cursor');
      const result = page(offset, options.items, options.bytes);
      return {
        root: scopeRoot,
        entries: result.units.map((unit) => ({ tag: 'implicit_unit', records: [], value: unit })),
        complete: result.pageComplete,
        after: result.nextOffset === null ? null : String(result.nextOffset),
      };
    },
  };
  return {
    sectionProvider(section: ModelIntakeSection) {
      return section === 'units' ? provider : undefined;
    },
    currentUnits(pageNumber?: number): ModelCurrentUnitScopeV2 {
      current();
      // The declared package-member recipe has no PDF page or sourceFileId field.
      // A PDF-page-filtered ZIP-original scope is therefore provably empty.
      if (pageNumber !== undefined) return { state: 'exact', total: 0, items: [] };
      const result = page(0, 8, 8000);
      return { state: 'exact', total: result.total, items: result.units };
    },
  };
}
