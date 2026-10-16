/** Exact plan-addressed reading state catalog. Nested references preserve every
 * changed plan map through one atomic logical catalog selection. */
import { randomUUID, createHash } from 'node:crypto';
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { selectedEnvelopeStore } from './intake-collection-envelope.ts';
import type { IntakeCollectionChange, IntakeCollectionValue } from './intake-state-storage.ts';

type Collections = ReturnType<typeof selectedEnvelopeStore>['collections'];
export type IntakeDecisionIndex =
  | { area: 'logical' | 'builds'; collection: string; reference?: never }
  | { reference: IntakeCollectionValue; area?: never; collection?: never };
export const READING_STATE_CATALOG = 'package.readingStates';

export function decisionIndexGet(
  collections: Collections,
  index: IntakeDecisionIndex,
  key: string,
) {
  return index.reference
    ? collections.getReferenced(index.reference, key)
    : collections.get(collections.openView(), index.area, index.collection, key);
}
export function decisionIndexRank(
  collections: Collections,
  index: IntakeDecisionIndex,
  key: string,
) {
  return index.reference
    ? collections.rankReferenced(index.reference, key)
    : collections.rank(collections.openView(), index.area, index.collection, key);
}
export function decisionIndexCount(collections: Collections, index: IntakeDecisionIndex) {
  if (index.reference) {
    collections.getReferenced(index.reference, '');
    return index.reference.count;
  }
  return (
    collections.collection(collections.openView(), index.area, index.collection)?.root?.count ?? 0
  );
}
export function decisionIndexAdoption(
  collections: Collections,
  index: IntakeDecisionIndex,
  collection: string,
): IntakeCollectionChange[] {
  if (index.reference)
    return [{ area: 'builds', collection, op: 'adoptReferenced', value: index.reference }];
  if (collections.collection(collections.openView(), index.area, index.collection))
    return [
      {
        area: 'builds',
        collection,
        op: 'adoptCollection',
        fromArea: index.area,
        fromCollection: index.collection,
      },
    ];
  return [
    { area: 'builds', collection, op: 'put', key: '$initialize', value: '' },
    { area: 'builds', collection, op: 'delete', key: '$initialize' },
  ];
}
/** Missing plan entry permits legacy fallback. An explicitly empty reference
 * suppresses fallback, so cleared exceptions cannot reappear after recovery. */
export function selectedReadingStateIndex(
  collections: Collections,
  planAddress: string,
  kind: 'readingSkipped' | 'exceptions',
): IntakeDecisionIndex | undefined {
  if (!/^[a-f0-9]{64}$/.test(planAddress)) throw Error('Invalid reading plan address');
  const parent = collections.getCollectionReference(
    collections.openView(),
    'logical',
    READING_STATE_CATALOG,
    planAddress,
  );
  if (!parent) return undefined;
  const reference = collections.referenceFrom(parent, kind);
  if (!reference || reference.collectionKind !== 'map')
    throw Error('Incomplete selected reading state');
  return { reference };
}

export function prepareReadingStateCatalog(
  db: Database,
  source: IntakeEnvelopeSource,
  options: { assertRunning?: () => void; onCheckpoint?: () => void | Promise<void> } = {},
) {
  const { collections } = selectedEnvelopeStore(db, source),
    before = JSON.stringify(collections.binding(collections.openView())?.logical);
  const catalog = 'reading.catalog.' + randomUUID();
  let initialized = false;
  const assertCurrent = () => {
    options.assertRunning?.();
    selectedEnvelopeStore(db, source);
    if (JSON.stringify(collections.binding(collections.openView())?.logical) !== before)
      throw Error('Reading state source changed');
  };
  const checkpoint = async (changes: readonly IntakeCollectionChange[]) => {
    assertCurrent();
    if (changes.length > 16) throw Error('Reading checkpoint exceeds its bounded budget');
    if (changes.length) {
      const id = randomUUID();
      collections.commitMaintenance(
        collections.prepare(collections.openView(), {
          operationId: id,
          requestDigest: createHash('sha256').update(id).digest('hex'),
          domainVersion: collections.binding(collections.openView())!.logical.domainVersion,
          changes,
        }),
      );
    }
    await options.onCheckpoint?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assertCurrent();
  };
  const init = async () => {
    if (initialized) return;
    await checkpoint(
      decisionIndexAdoption(
        collections,
        { area: 'logical', collection: READING_STATE_CATALOG },
        catalog,
      ),
    );
    initialized = true;
  };
  return {
    collections,
    assertCurrent,
    checkpoint,
    async fork(index: IntakeDecisionIndex) {
      const collection = 'reading.state.' + randomUUID();
      await checkpoint(decisionIndexAdoption(collections, index, collection));
      return collection;
    },
    async select(planAddress: string, maps: { readingSkipped: string; exceptions: string }) {
      if (!/^[a-f0-9]{64}$/.test(planAddress)) throw Error('Invalid reading plan address');
      const scope = 'reading.plan.' + randomUUID();
      await checkpoint(
        (['readingSkipped', 'exceptions'] as const).map((key) => ({
          area: 'builds',
          collection: scope,
          op: 'putCollection',
          key,
          fromArea: 'builds',
          fromCollection: maps[key],
        })),
      );
      await init();
      await checkpoint([
        {
          area: 'builds',
          collection: catalog,
          op: 'putCollection',
          key: planAddress,
          fromArea: 'builds',
          fromCollection: scope,
        },
      ]);
    },
    finalChanges(): IntakeCollectionChange[] {
      assertCurrent();
      return initialized
        ? [
            {
              area: 'logical',
              collection: READING_STATE_CATALOG,
              op: 'adoptCollection',
              fromArea: 'builds',
              fromCollection: catalog,
            },
          ]
        : [];
    },
  };
}
