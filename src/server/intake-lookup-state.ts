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
  captureIntakeFrontierAttempts,
  ensureIntakeFrontierObserver,
  readIntakeFrontierAttempts,
  readIntakeFrontierAcceptedTransition,
  readIntakeFrontierSourceEquality,
  type IntakeFrontierAttemptSnapshot,
} from './intake-lookup-frontier-observer.ts';
import {
  intakeLookupProjectionGeneration,
  prepareIntakeLookupProjection,
  buildNativeIntakeLookupCatalog,
  retainNativeIntakeLookupCatalog,
  advanceNativeIntakeLookupCatalog,
  nativeIntakeLookupCatalogAllOriginalsNative,
  nativeIntakeLookupCatalogHeadBindingsEqual,
} from './intake-lookup-projection.ts';

export const INTAKE_LOOKUP_INDEX_POLICY = 'health-intake-lookup-index-v1';
export const INTAKE_LOOKUP_INDEX_COLLECTION = 'lookup.indexes';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function discoveryHash(profile: string) {
  const revision = createHash('sha256');
  revision.update(JSON.stringify([INTAKE_LOOKUP_INDEX_POLICY, profile]));
  return revision;
}
function addDiscoverySource(
  revision: ReturnType<typeof createHash>,
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
) {
  const binding = intakeEnvelopeAuthorityBinding(db, source);
  revision.update(
    JSON.stringify([source.id, source.sha256, binding.key, binding.logicalHead ?? binding.head]),
  );
}
/** Each GET is complete before the caller may yield; rowid never becomes a JS number. */
function originalSourceCursor(db: DatabaseSync) {
  const first = db.prepare(
    "SELECT rowid AS lookup_rowid,id,kind,sha256,details_json FROM source_files WHERE kind='intake_original' ORDER BY rowid LIMIT 1",
  );
  const next = db.prepare(
    "SELECT rowid AS lookup_rowid,id,kind,sha256,details_json FROM source_files WHERE kind='intake_original' AND rowid>? ORDER BY rowid LIMIT 1",
  );
  first.setReadBigInts(true);
  next.setReadBigInts(true);
  return (cursor?: bigint) => {
    const row = (cursor === undefined ? first.get() : next.get(cursor)) as
      (IntakeEnvelopeSource & { lookup_rowid: bigint }) | undefined;
    if (row && typeof row.lookup_rowid !== 'bigint')
      throw Error('Intake discovery source order is unavailable');
    return row;
  };
}

interface PreparedLookupRead {
  stamp: string;
  registry: object;
  projection: object;
  profile: string;
  reused: number;
  discoveryRevision: string;
  frontier?: IntakeFrontierAttemptSnapshot;
}
const preparedLookupReads = new WeakMap<DatabaseSync, PreparedLookupRead>();
function lookupReadCurrent(db: DatabaseSync, proof: PreparedLookupRead): boolean {
  const durability = recordDurabilityStatus(db);
  const profile = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  const frontier = proof.frontier && readIntakeFrontierAttempts(db, proof.frontier);
  return (
    durability?.configured === true &&
    !durability.dirty &&
    profile === proof.profile &&
    reviewReadStamp(db) === proof.stamp &&
    intakeCollectionCacheGeneration(db) === proof.registry &&
    intakeLookupProjectionGeneration(db) === proof.projection &&
    (!proof.frontier ||
      (frontier?.attempts === 0 &&
        frontier.ownedWrites === 0 &&
        frontier.headSourceIds.length === 0 &&
        frontier.ordinaryTokens.length === 0))
  );
}
/** Only the exact fully prepared frontier may authorize the private address catalog. */
export function preparedIntakeLookupReadToken(db: DatabaseSync): object | undefined {
  const proof = preparedLookupReads.get(db);
  return proof && lookupReadCurrent(db, proof) ? proof : undefined;
}
export function preparedIntakeDiscoveryRevision(db: DatabaseSync): string | undefined {
  const proof = preparedLookupReads.get(db);
  if (!proof) return undefined;
  if (lookupReadCurrent(db, proof)) return proof.discoveryRevision;
  const durability = recordDurabilityStatus(db);
  const profile = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  if (
    !proof.frontier ||
    durability?.configured !== true ||
    durability.dirty ||
    durability.conflicted ||
    profile !== proof.profile
  )
    return undefined;
  const before = readIntakeFrontierSourceEquality(db, proof.frontier);
  if (!before || !nativeIntakeLookupCatalogHeadBindingsEqual(db, proof, before.headSourceIds))
    return undefined;
  const finalDurability = recordDurabilityStatus(db);
  const after = readIntakeFrontierSourceEquality(db, proof.frontier);
  return after &&
    after.attempts === before.attempts &&
    after.ownedWrites === before.ownedWrites &&
    after.headSourceIds.length === before.headSourceIds.length &&
    after.headSourceIds.every((id) => before.headSourceIds.includes(id)) &&
    finalDurability?.configured === true &&
    !finalDurability.dirty &&
    !finalDurability.conflicted
    ? proof.discoveryRevision
    : undefined;
}

/** Compact selected source frontier; native auxiliary churn does not alter it. */
export function intakeDiscoveryRevision(db: DatabaseSync): string {
  const profile = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  if (typeof profile !== 'string' || !profile)
    throw Error('Intake lookup profile binding is unavailable');
  const revision = discoveryHash(profile);
  for (const row of db
    .prepare(
      "SELECT id,kind,sha256,details_json FROM source_files WHERE kind='intake_original' ORDER BY rowid",
    )
    .iterate()) {
    const source = row as unknown as IntakeEnvelopeSource;
    addDiscoverySource(revision, db, source);
  }
  return revision.digest('hex');
}
export function assertIntakeDiscoveryRevision(db: DatabaseSync, expected: string): void {
  try {
    if (
      preparedIntakeDiscoveryRevision(db) !== expected &&
      intakeDiscoveryRevision(db) !== expected
    )
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
  if (prior?.frontier) {
    const nativeTransition = nativeIntakeLookupCatalogAllOriginalsNative(db, prior);
    const readInterval = nativeTransition
      ? readIntakeFrontierAcceptedTransition
      : readIntakeFrontierAttempts;
    const interval = readInterval(db, prior.frontier);
    const stamp = reviewReadStamp(db);
    const registry = intakeCollectionCacheGeneration(db);
    const projection = intakeLookupProjectionGeneration(db);
    const profile = db
      .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
      .get()?.value;
    if (
      interval &&
      interval.attempts === interval.ownedWrites &&
      (interval.ordinaryTokens.length === 0 || nativeTransition) &&
      interval.ordinaryTokens.length <= 1 &&
      stamp !== undefined &&
      registry === prior.registry &&
      projection === prior.projection &&
      profile === prior.profile &&
      recordDurabilityStatus(db)?.configured === true &&
      !recordDurabilityStatus(db)?.dirty
    ) {
      const current = () => {
        const now = readInterval(db, prior.frontier!);
        return (
          now?.attempts === interval.attempts &&
          now.ownedWrites === interval.ownedWrites &&
          now.headSourceIds.length === interval.headSourceIds.length &&
          now.headSourceIds.every((id) => interval.headSourceIds.includes(id)) &&
          now.ordinaryTokens.length === interval.ordinaryTokens.length &&
          now.ordinaryTokens.every((token) => interval.ordinaryTokens.includes(token)) &&
          reviewReadStamp(db) === stamp &&
          intakeCollectionCacheGeneration(db) === registry &&
          intakeLookupProjectionGeneration(db) === projection &&
          db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value ===
            profile &&
          recordDurabilityStatus(db)?.configured === true &&
          !recordDurabilityStatus(db)?.dirty
        );
      };
      const next: PreparedLookupRead = {
        stamp,
        registry,
        projection: projection!,
        profile,
        reused: prior.reused,
        discoveryRevision: prior.discoveryRevision,
      };
      const changed = await advanceNativeIntakeLookupCatalog(
        db,
        prior,
        next,
        interval.headSourceIds,
        interval.ordinaryTokens[0],
        current,
        options,
      );
      if (changed && current()) {
        if (changed.length) {
          const revision = createHash('sha256');
          revision.update(
            JSON.stringify(['intake-discovery-transition-v1', prior.discoveryRevision]),
          );
          for (const source of changed)
            revision.update(
              JSON.stringify([
                source.sourceId,
                source.sourceOrder,
                source.sourceHash,
                source.authorityKey,
                source.logicalHead,
              ]),
            );
          next.discoveryRevision = revision.digest('hex');
        }
        next.frontier = captureIntakeFrontierAttempts(db);
        if (next.frontier && lookupReadCurrent(db, next)) {
          preparedLookupReads.set(db, next);
          return { prepared: 0, reused: next.reused, discoveryRevision: next.discoveryRevision };
        }
      }
    }
  }
  let prepared = 0,
    reused = 0;
  const initialProfile = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  if (typeof initialProfile !== 'string' || !initialProfile)
    throw Error('Intake lookup profile binding is unavailable');
  const initialRevision = discoveryHash(initialProfile);
  const readInitial = originalSourceCursor(db);
  let initialCursor: bigint | undefined;
  let initialRows = 0;
  for (;;) {
    if (initialRows > 0 && initialRows % 64 === 0) {
      options.assertRunning?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      options.assertRunning?.();
    }
    const source = readInitial(initialCursor);
    if (!source) break;
    initialCursor = source.lookup_rowid;
    addDiscoverySource(initialRevision, db, source);
    initialRows++;
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
  const initialDigest = initialRevision.digest('hex');
  // Awaited checkpoints can allow a previously processed source to change.
  // Check each current header before granting a fully prepared result.
  const completedProjection = prepareIntakeLookupProjection(db);
  ensureIntakeFrontierObserver(db);
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
    let discoveryRevision: string;
    if (!proof) {
      // No read certificate may be minted on this legacy fallback path.
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
      discoveryRevision = intakeDiscoveryRevision(db);
    } else {
      const current = () => {
        options.assertRunning?.();
        if (!lookupReadCurrent(db, proof)) throw Error('Intake discovery source frontier changed');
      };
      current();
      const revision = discoveryHash(proof.profile);
      const readFinal = originalSourceCursor(db);
      let cursor: bigint | undefined;
      let scanned = 0;
      for (;;) {
        if (scanned > 0 && scanned % 64 === 0) {
          current();
          await new Promise<void>((resolve) => setImmediate(resolve));
          current();
        }
        const source = readFinal(cursor);
        if (!source) break;
        cursor = source.lookup_rowid;
        options.assertRunning?.();
        if (hasIntakeCollectionEnvelope(db, source)) {
          const view = openIntakeCollectionEnvelope(db, source, { fieldSelection: 'first' });
          readNativeIntakeLookupTarget(db, source, view, 'lookup-discovery-maximum', []);
        }
        addDiscoverySource(revision, db, source);
        scanned++;
      }
      current();
      discoveryRevision = revision.digest('hex');
    }
    if (discoveryRevision !== initialDigest)
      throw Error('Intake discovery source frontier changed during preparation');
    options.assertRunning?.();
    if (proof && catalog && lookupReadCurrent(db, proof)) {
      proof.discoveryRevision = discoveryRevision;
      if (retainNativeIntakeLookupCatalog(db, catalog, proof)) {
        proof.frontier = captureIntakeFrontierAttempts(db);
        if (proof.frontier && lookupReadCurrent(db, proof)) preparedLookupReads.set(db, proof);
      }
    } else {
      catalog?.scratch.close();
    }
    return { prepared, reused, discoveryRevision };
  } catch (error) {
    catalog?.scratch.close();
    throw error;
  }
}
