import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { currentTransactionToken, rejectCurrentTransaction } from './database.ts';
import { intakeEnvelopeAuthorityBinding, type IntakeEnvelopeSource } from './intake-authority.ts';
import {
  hasIntakeCollectionEnvelope,
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { intakeLookupContributions } from './intake-lookup-contributions.ts';
import { schemaKey } from './intake-envelope-schema.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import { reviewReadStamp } from './intake-clinical-review-read-cache.ts';
import { intakeCollectionCacheGeneration } from './intake-state-collections.ts';
import {
  intakeLookupProjectionGeneration,
  prepareIntakeLookupProjection,
  buildNativeIntakeLookupCatalog,
  retainNativeIntakeLookupCatalog,
} from './intake-lookup-projection.ts';

export const INTAKE_LOOKUP_INDEX_POLICY = 'health-intake-lookup-index-v1';
export const INTAKE_LOOKUP_INDEX_COLLECTION = 'lookup.indexes';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface PreparedLookupRead {
  stamp: string;
  registry: object;
  projection: object;
  profile: string;
  reused: number;
  discoveryRevision: string;
}
const preparedLookupReads = new WeakMap<DatabaseSync, PreparedLookupRead>();
function lookupReadCurrent(db: DatabaseSync, proof: PreparedLookupRead): boolean {
  const durability = recordDurabilityStatus(db);
  const profile = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  return (
    durability?.configured === true &&
    !durability.dirty &&
    profile === proof.profile &&
    reviewReadStamp(db) === proof.stamp &&
    intakeCollectionCacheGeneration(db) === proof.registry &&
    intakeLookupProjectionGeneration(db) === proof.projection
  );
}
/** Only the exact fully prepared frontier may authorize the private address catalog. */
export function preparedIntakeLookupReadToken(db: DatabaseSync): object | undefined {
  const proof = preparedLookupReads.get(db);
  return proof && lookupReadCurrent(db, proof) ? proof : undefined;
}

/** Compact selected source frontier; native auxiliary churn does not alter it. */
export function intakeDiscoveryRevision(db: DatabaseSync): string {
  const revision = createHash('sha256');
  const profile = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  if (typeof profile !== 'string' || !profile)
    throw Error('Intake lookup profile binding is unavailable');
  revision.update(JSON.stringify([INTAKE_LOOKUP_INDEX_POLICY, profile]));
  for (const row of db
    .prepare(
      "SELECT id,kind,sha256,details_json FROM source_files WHERE kind='intake_original' ORDER BY rowid",
    )
    .iterate()) {
    const source = row as unknown as IntakeEnvelopeSource;
    const binding = intakeEnvelopeAuthorityBinding(db, source);
    revision.update(
      JSON.stringify([source.id, source.sha256, binding.key, binding.logicalHead ?? binding.head]),
    );
  }
  return revision.digest('hex');
}
export function assertIntakeDiscoveryRevision(db: DatabaseSync, expected: string): void {
  try {
    if (intakeDiscoveryRevision(db) !== expected)
      throw Error('Intake discovery source frontier changed');
  } catch (error) {
    if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
    throw error;
  }
}

/** Dedicated completeness can be published independently of model/count work. */
export function readNativeIntakeLookupTarget(
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
  view: IntakeCollectionEnvelopeReader,
  index: string,
  key: readonly string[],
): IntakeEnvelopeRecord | undefined {
  view.address(view.root());
  const { collections } = selectedEnvelopeStore(db, source);
  const selected = collections.openView();
  const complete = collections.get(selected, 'builds', INTAKE_LOOKUP_INDEX_COLLECTION, 'complete');
  if (complete !== undefined && typeof complete !== 'string')
    throw Error('Intake lookup completeness is unavailable');
  if (complete === JSON.stringify(view.logical)) {
    if (
      collections.get(selected, 'builds', INTAKE_LOOKUP_INDEX_COLLECTION, 'policy') !==
      INTAKE_LOOKUP_INDEX_POLICY
    )
      throw Error('Intake lookup index policy is unsupported');
    const target = collections.get(
      selected,
      'builds',
      INTAKE_LOOKUP_INDEX_COLLECTION,
      schemaKey(index, ...key),
    );
    if (target === undefined) return undefined;
    if (typeof target !== 'string') throw Error('Intake lookup index target is unavailable');
    return view.resolve(target);
  }
  // The workflow builder derives the same exact first-selected contributions.
  // A complete newer workflow build can supersede pending dedicated lookup state.
  return view.lookup(index, key);
}

/** Explicit awaited maintenance boundary; warm callers reuse complete source-bound indexes. */
export async function prepareIntakeLookupIndices(
  db: DatabaseSync,
  options: {
    assertRunning?: () => void;
    onCheckpoint?: (progress: { sourceId: string; visited: number }) => void | Promise<void>;
  } = {},
) {
  if (db.isTransaction)
    throw Error('Intake lookup preparation requires an outside-transaction maintenance phase');
  const prior = preparedLookupReads.get(db);
  preparedLookupReads.delete(db);
  options.assertRunning?.();
  if (prior && lookupReadCurrent(db, prior)) {
    preparedLookupReads.set(db, prior);
    return { prepared: 0, reused: prior.reused, discoveryRevision: prior.discoveryRevision };
  }
  let prepared = 0,
    reused = 0;
  for (const row of db
    .prepare(
      "SELECT id,kind,sha256,details_json FROM source_files WHERE kind='intake_original' ORDER BY rowid",
    )
    .iterate()) {
    const source = row as unknown as IntakeEnvelopeSource;
    if (!hasIntakeCollectionEnvelope(db, source)) continue;
    const view = openIntakeCollectionEnvelope(db, source, { fieldSelection: 'first' });
    const { collections } = selectedEnvelopeStore(db, source);
    const current = () => {
      options.assertRunning?.();
      view.address(view.root());
    };
    const binding = JSON.stringify(view.logical);
    const selected = collections.openView();
    const globalComplete =
      collections.get(selected, 'builds', 'envelope.indexes', 'complete') === binding &&
      collections.get(selected, 'builds', 'envelope.indexes', 'policy') ===
        'health-intake-workflow-index-v6';
    if (
      globalComplete ||
      (collections.get(selected, 'builds', INTAKE_LOOKUP_INDEX_COLLECTION, 'complete') ===
        binding &&
        collections.get(selected, 'builds', INTAKE_LOOKUP_INDEX_COLLECTION, 'policy') ===
          INTAKE_LOOKUP_INDEX_POLICY)
    ) {
      current();
      reused++;
      continue;
    }
    const buildId = randomUUID(),
      collection = 'lookup.' + buildId + '.indexes';
    const changes: IntakeCollectionChange[] = [];
    let visited = 0;
    const commit = (batch: IntakeCollectionChange[]) => {
      current();
      const operationId = randomUUID();
      collections.commitMaintenance(
        collections.prepare(collections.openView(), {
          operationId,
          requestDigest: hash(operationId),
          domainVersion: view.logical.domainVersion,
          changes: batch,
        }),
      );
    };
    const checkpoint = async () => {
      const batch = changes.splice(0);
      batch.push({
        area: 'builds',
        collection: 'lookup.builds',
        op: 'put',
        key: buildId,
        value: JSON.stringify({
          format: INTAKE_LOOKUP_INDEX_POLICY,
          state: 'building',
          binding,
          collection,
          visited,
        }),
      });
      commit(batch);
      await options.onCheckpoint?.({ sourceId: source.id, visited });
      await new Promise<void>((resolve) => setImmediate(resolve));
      current();
    };
    for (const contribution of intakeLookupContributions(db, view)) {
      current();
      if ('checkpoint' in contribution) {
        await checkpoint();
        continue;
      }
      changes.push(
        contribution.target
          ? {
              area: 'builds',
              collection,
              op: 'put',
              key: schemaKey(contribution.index, ...contribution.key),
              value: view.address(contribution.target),
            }
          : {
              area: 'builds',
              collection,
              op: 'delete',
              key: schemaKey(contribution.index, ...contribution.key),
            },
      );
      visited++;
      if (changes.length >= 15) await checkpoint();
    }
    if (changes.length) await checkpoint();
    commit([
      { area: 'builds', collection, op: 'put', key: 'complete', value: binding },
      { area: 'builds', collection, op: 'put', key: 'policy', value: INTAKE_LOOKUP_INDEX_POLICY },
      {
        area: 'builds',
        collection: INTAKE_LOOKUP_INDEX_COLLECTION,
        op: 'adoptCollection',
        fromArea: 'builds',
        fromCollection: collection,
      },
      {
        area: 'builds',
        collection: 'lookup.builds',
        op: 'put',
        key: buildId,
        value: JSON.stringify({
          format: INTAKE_LOOKUP_INDEX_POLICY,
          state: 'complete',
          binding,
          collection,
          visited,
        }),
      },
    ]);
    prepared++;
  }
  // Awaited checkpoints can allow a previously processed source to change.
  // Check each current header before granting a fully prepared result.
  const completedProjection = prepareIntakeLookupProjection(db);
  const beforeValidation = reviewReadStamp(db);
  const registry = intakeCollectionCacheGeneration(db);
  const profile = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  const proof: PreparedLookupRead | undefined =
    beforeValidation !== undefined && typeof profile === 'string'
      ? {
          stamp: beforeValidation,
          registry,
          projection: completedProjection,
          profile,
          reused: prepared + reused,
          discoveryRevision: '',
        }
      : undefined;
  const catalog = proof
    ? await buildNativeIntakeLookupCatalog(db, () => lookupReadCurrent(db, proof), options)
    : undefined;
  try {
    for (const row of db
      .prepare(
        "SELECT id,kind,sha256,details_json FROM source_files WHERE kind='intake_original' ORDER BY rowid",
      )
      .iterate()) {
      options.assertRunning?.();
      const source = row as unknown as IntakeEnvelopeSource;
      if (!hasIntakeCollectionEnvelope(db, source)) continue;
      const view = openIntakeCollectionEnvelope(db, source, { fieldSelection: 'first' });
      readNativeIntakeLookupTarget(db, source, view, 'lookup-discovery-maximum', []);
    }
    const discoveryRevision = intakeDiscoveryRevision(db);
    options.assertRunning?.();
    if (proof && catalog && lookupReadCurrent(db, proof)) {
      proof.discoveryRevision = discoveryRevision;
      if (retainNativeIntakeLookupCatalog(db, catalog, proof)) preparedLookupReads.set(db, proof);
    } else {
      catalog?.scratch.close();
    }
    return { prepared, reused, discoveryRevision };
  } catch (error) {
    catalog?.scratch.close();
    throw error;
  }
}
