import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { MODEL_INTAKE_SECTIONS } from './intake-model-context.ts';
import {
  collectionModelIntakePins,
  openCollectionModelIntakeBackend,
  type ModelSectionManifest,
} from './intake-model-collection-backend.ts';
import {
  modelIntakeSectionContributions,
  modelIntakeSectionOrder,
} from './intake-model-section-index.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';

/** Selected auxiliary index construction. It never advances the clinical/domain version. */
export async function buildModelIntakeSectionIndexes(
  db: Database,
  source: IntakeEnvelopeSource,
  options: {
    mappingVersion: string;
    currentMappingVersion?: () => string;
    assertRunning?: () => void;
    onCheckpoint?: () => void | Promise<void>;
    implicitPlanScope?: (plan: IntakeEnvelopeRecord, view: IntakeCollectionEnvelopeReader) => void;
  },
) {
  const view = openIntakeCollectionEnvelope(db, source);
  const { collections } = selectedEnvelopeStore(db, source);
  const pins = collectionModelIntakePins(db, source, options.mappingVersion);
  const sections = MODEL_INTAKE_SECTIONS.filter((section) => section !== 'mapping_rules');
  const complete = collections.get(collections.openView(), 'builds', 'model.sections', '$complete');
  if (typeof complete === 'string') {
    const previous = JSON.parse(complete) as {
      format?: string;
      pins: unknown;
      externalSections?: string[];
    };
    if (
      previous.format === 'health-intake-model-index-v3' &&
      JSON.stringify(previous.pins) === JSON.stringify(pins)
    ) {
      const backend = openCollectionModelIntakeBackend(db, source, options);
      if (
        sections.every(
          (section) =>
            previous.externalSections?.includes(section) ||
            backend.section(section).state === 'complete',
        )
      )
        return { state: 'complete' as const, reused: true, pins };
    }
  }
  const buildId = randomUUID(),
    prefix = 'model.' + buildId;
  const changes: IntakeCollectionChange[] = [];
  let entries = 0,
    implicitPlans = false;
  const assertCurrent = () => {
    options.assertRunning?.();
    view.address(view.root());
    const current = collectionModelIntakePins(db, source, options.mappingVersion);
    if (
      JSON.stringify(current) !== JSON.stringify(pins) ||
      (options.currentMappingVersion && options.currentMappingVersion() !== options.mappingVersion)
    )
      throw Error('Model section build source or mapping pins changed');
  };
  const commit = (batch: IntakeCollectionChange[]) => {
    assertCurrent();
    const operationId = randomUUID();
    const prepared = collections.prepare(collections.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: pins.domainVersion,
      changes: batch,
    });
    collections.commitMaintenance(prepared);
  };
  const flush = async () => {
    if (!changes.length) return;
    const batch = changes.splice(0);
    batch.push({
      area: 'builds',
      collection: 'model.builds',
      op: 'put',
      key: buildId,
      value: JSON.stringify({
        format: 'health-intake-model-index-build-v2',
        state: 'building',
        pins,
        prefix,
        entries,
      }),
    });
    commit(batch);
    await options.onCheckpoint?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  for (const item of modelIntakeSectionContributions(view, {
    implicitPlanScope(plan, active) {
      if (!options.implicitPlanScope)
        throw Error('Implicit model unit section requires the checked inventory provider');
      options.implicitPlanScope(plan, view);
      implicitPlans ||= active;
    },
  })) {
    options.assertRunning?.();
    if ('checkpoint' in item) {
      await flush();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assertCurrent();
      continue;
    }
    changes.push({
      area: 'builds',
      collection: prefix + '.' + item.section,
      op: 'put',
      key: modelIntakeSectionOrder(view, item),
      value: JSON.stringify({ tag: item.tag, records: item.records.map(view.address) }),
    });
    entries++;
    if (changes.length === 15) await flush();
  }
  await flush();
  assertCurrent();
  const final: IntakeCollectionChange[] = [];
  for (const section of sections) {
    if (implicitPlans && ['units', 'missing_assets'].includes(section)) continue;
    const collection = prefix + '.' + section;
    const descriptor = collections.collection(collections.openView(), 'builds', collection);
    const manifest: ModelSectionManifest = {
      format: 'health-intake-model-section-v3',
      section,
      pins,
      collection,
      root: descriptor?.root?.hash || '',
      count: descriptor?.root?.count || 0,
    };
    final.push({
      area: 'builds',
      collection: 'model.sections',
      op: 'put',
      key: section,
      value: JSON.stringify(manifest),
    });
  }
  final.push({
    area: 'builds',
    collection: 'model.sections',
    op: 'put',
    key: '$complete',
    value: JSON.stringify({
      format: 'health-intake-model-index-v3',
      pins,
      externalSections: implicitPlans ? ['units', 'missing_assets'] : [],
    }),
  });
  final.push({
    area: 'builds',
    collection: 'model.builds',
    op: 'put',
    key: buildId,
    value: JSON.stringify({
      format: 'health-intake-model-index-build-v2',
      state: 'complete',
      pins,
      prefix,
      entries,
    }),
  });
  commit(final);
  return { state: 'complete' as const, reused: false, pins, entries, buildId };
}
