import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { currentTransactionToken, rejectCurrentTransaction } from './database.ts';
import { ensureDuplicateEvidenceFunction } from './duplicate-evidence-index.ts';
import { ensureClinicalSourceFingerprintFunction } from './intake-clinical-source-index.ts';
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
import { recordFieldDigest } from './record-prior-fields.ts';
import { stringifyRecordJson } from './record-version-work.ts';
import {
  MAX_SOURCE_DELTA_ROWS,
  SOURCE_DELTA_PAGE_ROWS,
  takeRecordAcceptedSourceDeltaChain,
  type RecordAcceptedSourceDeltaRow,
} from './record-accepted-source-delta.ts';
import { reviewReadStamp } from './intake-clinical-review-read-cache.ts';
import { identityGroundingGeneration } from './intake-identity-grounding.ts';
import { intakeCollectionCacheGeneration } from './intake-state-collections.ts';
import {
  captureIntakeFrontierAttempts,
  ensureIntakeFrontierObserver,
  readIntakeFrontierActiveUnwritten,
  readIntakeFrontierAttempts,
  readIntakeFrontierAcceptedTransition,
  readIntakeFrontierCommittedChain,
  readIntakeFrontierSourceEquality,
  type IntakeFrontierAttemptSnapshot,
} from './intake-lookup-frontier-observer.ts';
import {
  intakeLookupProjectionGeneration,
  prepareIntakeLookupProjection,
  buildNativeIntakeLookupCatalog,
  retainNativeIntakeLookupCatalog,
  advanceNativeIntakeLookupCatalog,
  appendNativeIntakeLookupCatalogSources,
  nativeIntakeLookupCatalogAllOriginalsNative,
  nativeIntakeLookupCatalogHeadBindingsEqual,
} from './intake-lookup-projection.ts';

export const INTAKE_LOOKUP_INDEX_POLICY = 'health-intake-lookup-index-v1';
export const INTAKE_LOOKUP_INDEX_COLLECTION = 'lookup.indexes';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The discovery revision is one construction for both the full scan and an
 * incremental transition: a lattice multiset hash (LtHash, 1024 16-bit lanes
 * of SHAKE256 output, added modulo 2^16) over one entry per original, bound to
 * the policy and profile. Order is bound by each entry's own source order, so
 * replacing one source's entry needs only its previous and current entries. */
const DISCOVERY_LANES = 1024;
interface DiscoveryState {
  readonly lanes: Uint16Array;
  /** Each member's current entry, shared along the proof chain; pending
   * replacements apply only once their proof is retained. */
  readonly entries: Map<string, string>;
  readonly pending?: ReadonlyMap<string, string>;
}
function discoveryEntry(
  sourceId: string,
  sourceOrder: number | bigint,
  sourceHash: unknown,
  authorityKey: unknown,
  logicalHead: unknown,
) {
  return JSON.stringify([sourceId, String(sourceOrder), sourceHash, authorityKey, logicalHead]);
}
function addDiscoveryLanes(lanes: Uint16Array, entry: string, sign: 1 | -1) {
  const bytes = createHash('shake256', { outputLength: DISCOVERY_LANES * 2 })
    .update('intake-discovery-entry-v2\0')
    .update(entry)
    .digest();
  for (let lane = 0; lane < DISCOVERY_LANES; lane++)
    lanes[lane] = (lanes[lane]! + sign * bytes.readUInt16LE(lane * 2)) & 0xffff;
}
function discoveryDigest(profile: string, lanes: Uint16Array) {
  const bytes = Buffer.alloc(DISCOVERY_LANES * 2);
  for (let lane = 0; lane < DISCOVERY_LANES; lane++) bytes.writeUInt16LE(lanes[lane]!, lane * 2);
  return createHash('sha256')
    .update(JSON.stringify([INTAKE_LOOKUP_INDEX_POLICY, 'intake-discovery-lthash-v2', profile]))
    .update(bytes)
    .digest('hex');
}
function discoveryHash(profile: string) {
  const lanes = new Uint16Array(DISCOVERY_LANES),
    entries = new Map<string, string>();
  return {
    entries,
    lanes,
    digest: () => discoveryDigest(profile, lanes),
  };
}
function addDiscoverySource(
  revision: ReturnType<typeof discoveryHash>,
  db: DatabaseSync,
  source: IntakeEnvelopeSource & { lookup_rowid: number | bigint },
) {
  const binding = intakeEnvelopeAuthorityBinding(db, source);
  const entry = discoveryEntry(
    source.id,
    source.lookup_rowid,
    source.sha256,
    binding.key,
    binding.logicalHead ?? binding.head,
  );
  // A source seen twice moved during the scan; the caller refuses the frontier.
  if (revision.entries.has(source.id)) return false;
  revision.entries.set(source.id, entry);
  addDiscoveryLanes(revision.lanes, entry, 1);
  return true;
}
function addDiscoverySourceOnce(
  revision: ReturnType<typeof discoveryHash>,
  db: DatabaseSync,
  source: IntakeEnvelopeSource & { lookup_rowid: number | bigint },
) {
  if (!addDiscoverySource(revision, db, source))
    throw Error('Intake discovery source frontier changed');
}
/** The full discovery revision builder, for a caller that scans originals in
 * rowid order itself (discovery admission). Same construction as below. */
export function createIntakeDiscoveryRevision(profile: string): {
  /** False when the source was already added: it moved during the scan. */
  add(db: DatabaseSync, source: IntakeEnvelopeSource, sourceOrder: bigint): boolean;
  digest(): string;
} {
  const revision = discoveryHash(profile);
  return {
    add: (db, source, sourceOrder) =>
      addDiscoverySource(revision, db, { ...source, lookup_rowid: sourceOrder }),
    digest: revision.digest,
  };
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
  /** The review stamp's grounding input, which an active transaction cannot read. */
  grounding: object;
  registry: object;
  projection: object;
  profile: string;
  reused: number;
  discoveryRevision: string;
  /** The lane state whose digest is discoveryRevision. */
  discovery?: DiscoveryState;
  frontier?: IntakeFrontierAttemptSnapshot;
  /** Accepted record HEAD read at the same quiescent point as the frontier. */
  recordHead?: { headJson: string; sequence: number };
}
function readRecordHead(db: DatabaseSync): PreparedLookupRead['recordHead'] {
  let row: Record<string, unknown> | undefined;
  try {
    row = db.prepare('SELECT sequence,head_json FROM __record_state WHERE singleton=1').get();
  } catch {
    return undefined;
  }
  return row && typeof row.head_json === 'string' && Number.isSafeInteger(row.sequence)
    ? { headJson: row.head_json, sequence: row.sequence as number }
    : undefined;
}
const preparedLookupReads = new WeakMap<DatabaseSync, PreparedLookupRead>();
function lookupReadCurrent(db: DatabaseSync, proof: PreparedLookupRead): boolean {
  const durability = recordDurabilityStatus(db);
  const profile = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  // Inside an application transaction, only the exact original frontier with
  // no write yet made by that transaction can answer; the first write ends it.
  const active = !!proof.frontier && db.isTransaction;
  const frontier = proof.frontier && !active && readIntakeFrontierAttempts(db, proof.frontier);
  return (
    durability?.configured === true &&
    !durability.dirty &&
    profile === proof.profile &&
    // The frontier read below checks the stamp's literal change/peer/schema
    // inputs against the snapshot captured while this exact stamp was current.
    (active
      ? identityGroundingGeneration(db) === proof.grounding
      : reviewReadStamp(db) === proof.stamp) &&
    intakeCollectionCacheGeneration(db) === proof.registry &&
    intakeLookupProjectionGeneration(db) === proof.projection &&
    (!proof.frontier ||
      (active
        ? readIntakeFrontierActiveUnwritten(db, proof.frontier)
        : !!frontier &&
          frontier.attempts === 0 &&
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
  const rows = db.prepare(
    "SELECT rowid AS lookup_rowid,id,kind,sha256,details_json FROM source_files WHERE kind='intake_original' ORDER BY rowid",
  );
  rows.setReadBigInts(true);
  for (const row of rows.iterate()) {
    const source = row as unknown as IntakeEnvelopeSource & { lookup_rowid: bigint };
    addDiscoverySourceOnce(revision, db, source);
  }
  return revision.digest();
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

/** Publish one source's dedicated lookup indexes with fixed maintenance
 * commits; false when a complete current build already exists. */
async function publishSourceLookupIndices(
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
  options: {
    assertRunning?: () => void;
    onCheckpoint?: (progress: { sourceId: string; visited: number }) => void | Promise<void>;
  },
): Promise<boolean | undefined> {
  if (!hasIntakeCollectionEnvelope(db, source)) return undefined;
  const view = openIntakeCollectionEnvelope(db, source, { fieldSelection: 'first' });
  const { collections } = selectedEnvelopeStore(db, source);
  // Resolve once; address() still checks this reader's selected source and
  // current logical/physical authority on every nested admission guard.
  const root = view.root();
  const current = () => {
    options.assertRunning?.();
    view.address(root);
  };
  const binding = JSON.stringify(view.logical);
  const selected = collections.openView();
  const globalComplete =
    collections.get(selected, 'builds', 'envelope.indexes', 'complete') === binding &&
    collections.get(selected, 'builds', 'envelope.indexes', 'policy') ===
      'health-intake-workflow-index-v6';
  if (
    globalComplete ||
    (collections.get(selected, 'builds', INTAKE_LOOKUP_INDEX_COLLECTION, 'complete') === binding &&
      collections.get(selected, 'builds', INTAKE_LOOKUP_INDEX_COLLECTION, 'policy') ===
        INTAKE_LOOKUP_INDEX_POLICY)
  ) {
    current();
    return false;
  }
  const buildId = randomUUID(),
    collection = 'lookup.' + buildId + '.indexes';
  const changes: IntakeCollectionChange[] = [];
  let visited = 0;
  const commit = async (batch: IntakeCollectionChange[]) => {
    current();
    const operationId = randomUUID();
    collections.commitMaintenance(
      await collections.prepareAsync(
        collections.openView(),
        {
          operationId,
          requestDigest: hash(operationId),
          domainVersion: view.logical.domainVersion,
          changes: batch,
        },
        current,
      ),
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
    await commit(batch);
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
  await commit([
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
  return true;
}

/** A committed interval after the original prepared frontier, closed link by
 * link: every committed writing outcome since that exact snapshot, the
 * accepted record HEAD chain from the snapshot's HEAD to the current HEAD, and
 * each changed source's current SQL fields against its accepted version. The
 * delta candidates only locate rows; the catalog append rereads each one. */
async function appendChangedLookupSources(
  db: DatabaseSync,
  prior: PreparedLookupRead,
  options: {
    assertRunning?: () => void;
    onCheckpoint?: (progress: { sourceId: string; visited: number }) => void | Promise<void>;
  },
) {
  const frontier = prior.frontier!,
    head = prior.recordHead!;
  if (!nativeIntakeLookupCatalogAllOriginalsNative(db, prior)) return;
  // The same fixed per-source index maintenance the cold path performs, only
  // for observed changed originals. These commits join the chain verified below.
  const located = readIntakeFrontierCommittedChain(db, frontier);
  if (!located) return;
  const locatedIds = new Set([
    ...located.headSourceIds,
    ...located.outcomes.flatMap((outcome) => outcome.sourceIds),
  ]);
  if (locatedIds.size > MAX_SOURCE_DELTA_ROWS) return;
  for (const id of locatedIds) {
    const source = db
      .prepare(
        "SELECT id,kind,sha256,details_json FROM main.source_files WHERE id=? AND kind='intake_original'",
      )
      .get(id) as IntakeEnvelopeSource | undefined;
    if (source) await publishSourceLookupIndices(db, source, options);
  }
  if (!nativeIntakeLookupCatalogAllOriginalsNative(db, prior)) return;
  const chain = readIntakeFrontierCommittedChain(db, frontier);
  const now = readRecordHead(db);
  const stamp = reviewReadStamp(db);
  const grounding = identityGroundingGeneration(db);
  const registry = intakeCollectionCacheGeneration(db);
  const projection = intakeLookupProjectionGeneration(db);
  const profile = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  const durability = recordDurabilityStatus(db);
  if (
    !chain ||
    !chain.outcomes.length ||
    !now ||
    now.sequence - head.sequence !== chain.outcomes.length ||
    stamp === undefined ||
    registry !== prior.registry ||
    projection !== prior.projection ||
    profile !== prior.profile ||
    durability?.configured !== true ||
    durability.dirty ||
    durability.conflicted
  )
    return;
  const deltas = takeRecordAcceptedSourceDeltaChain(
    db,
    chain.outcomes.map((outcome) => outcome.token),
    head.headJson,
    head.sequence,
    now.headJson,
  );
  if (!deltas || deltas[deltas.length - 1]!.sequence !== now.sequence) return;
  const observed = new Set(chain.outcomes.flatMap((outcome) => outcome.sourceIds));
  const latest = new Map<string, RecordAcceptedSourceDeltaRow>();
  const created = new Map<string, boolean>();
  for (const delta of deltas)
    for (const row of delta.sources) {
      let key: unknown;
      try {
        key = JSON.parse(row.recordId);
      } catch {
        return;
      }
      const id = Array.isArray(key) && key.length === 1 ? key[0] : undefined;
      if (
        typeof id !== 'string' ||
        stringifyRecordJson([id]) !== row.recordId ||
        row.deleted ||
        !observed.has(id)
      )
        return;
      if (!created.has(id)) created.set(id, row.previousVersion === null);
      latest.set(id, row);
    }
  const ids = new Set([...chain.headSourceIds, ...observed, ...latest.keys()]);
  if (ids.size > MAX_SOURCE_DELTA_ROWS) return;
  const sources: {
    sourceId: string;
    sourceOrder: number;
    sourceHash: string;
    created: boolean;
    unchanged: boolean;
  }[] = [];
  const absent: string[] = [];
  const read = db.prepare(
    'SELECT rowid source_order,id,kind,path,sha256,bytes FROM main.source_files WHERE id=?',
  );
  let verified = 0;
  for (const id of ids) {
    // Page the point reads: yield between pages; the catalog append and its
    // closing current() check still bind every page to the same interval.
    if (++verified % SOURCE_DELTA_PAGE_ROWS === 0) {
      options.assertRunning?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      options.assertRunning?.();
    }
    const row = read.get(id);
    const accepted = latest.get(id);
    if (!row) return;
    if (!accepted) {
      // A head-only change: no source row write was observed or accepted, so
      // only an existing member whose row still equals the catalog's may be
      // completely re-derived; it is never reused.
      if (
        observed.has(id) ||
        row.kind !== 'intake_original' ||
        !Number.isSafeInteger(row.source_order) ||
        typeof row.sha256 !== 'string'
      )
        return;
      sources.push({
        sourceId: id,
        sourceOrder: row.source_order as number,
        sourceHash: row.sha256,
        created: false,
        unchanged: true,
      });
      continue;
    }
    if (accepted.fields.length !== SOURCE_DELTA_FIELDS.length) return;
    for (const name of SOURCE_DELTA_FIELDS) {
      const value = row[name];
      const field = accepted.fields.find((item) => item.name === name);
      if (!field || (name === 'bytes' ? typeof value !== 'number' : typeof value !== 'string'))
        return;
      const digest = recordFieldDigest(JSON.stringify(value));
      if (digest.hash !== field.hash || digest.bytes !== field.bytes) return;
    }
    if (row.kind !== 'intake_original') {
      absent.push(id);
      continue;
    }
    if (!Number.isSafeInteger(row.source_order) || typeof row.sha256 !== 'string') return;
    sources.push({
      sourceId: id,
      sourceOrder: row.source_order as number,
      sourceHash: row.sha256,
      created: created.get(id) === true,
      unchanged: false,
    });
  }
  const tokens = chain.outcomes.map((outcome) => outcome.token);
  const current = () => {
    const again = readIntakeFrontierCommittedChain(db, frontier);
    const head = readRecordHead(db);
    const status = recordDurabilityStatus(db);
    return (
      again?.outcomes.length === tokens.length &&
      again.outcomes.every((outcome, index) => outcome.token === tokens[index]) &&
      again.headSourceIds.length === chain.headSourceIds.length &&
      again.headSourceIds.every((id) => chain.headSourceIds.includes(id)) &&
      head?.sequence === now.sequence &&
      head.headJson === now.headJson &&
      reviewReadStamp(db) === stamp &&
      identityGroundingGeneration(db) === grounding &&
      intakeCollectionCacheGeneration(db) === registry &&
      intakeLookupProjectionGeneration(db) === projection &&
      db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value ===
        profile &&
      status?.configured === true &&
      !status.dirty &&
      !status.conflicted
    );
  };
  const next: PreparedLookupRead = {
    stamp,
    grounding,
    registry,
    projection: projection!,
    profile,
    reused: prior.reused + sources.filter((source) => source.created).length,
    discoveryRevision: prior.discoveryRevision,
  };
  const changed = await appendNativeIntakeLookupCatalogSources(
    db,
    prior,
    next,
    sources,
    absent,
    current,
    options,
  );
  if (!changed || !current()) return;
  const transition = discoveryTransition(prior, changed);
  if (!transition) return;
  Object.assign(next, transition);
  next.frontier = captureIntakeFrontierAttempts(db);
  next.recordHead = readRecordHead(db);
  if (!next.frontier || !lookupReadCurrent(db, next)) return;
  retainPreparedLookupRead(db, next);
  return { prepared: 0, reused: next.reused, discoveryRevision: next.discoveryRevision };
}
const SOURCE_DELTA_FIELDS = ['id', 'kind', 'path', 'sha256', 'bytes'] as const;
/** Replace each changed source's entry in the prior lane state. The result
 * equals intakeDiscoveryRevision over the same rows by construction. */
function discoveryTransition(
  prior: PreparedLookupRead,
  changed: readonly {
    sourceId: string;
    sourceOrder: number;
    sourceHash: string;
    authorityKey: string;
    logicalHead: unknown;
  }[],
): Pick<PreparedLookupRead, 'discoveryRevision' | 'discovery'> | undefined {
  const discovery = prior.discovery;
  if (!discovery || discovery.pending) return undefined;
  if (!changed.length) return { discoveryRevision: prior.discoveryRevision, discovery };
  const lanes = discovery.lanes.slice(),
    pending = new Map<string, string>();
  for (const source of changed) {
    const previous = pending.get(source.sourceId) ?? discovery.entries.get(source.sourceId);
    const entry = discoveryEntry(
      source.sourceId,
      source.sourceOrder,
      source.sourceHash,
      source.authorityKey,
      source.logicalHead,
    );
    if (previous !== undefined) addDiscoveryLanes(lanes, previous, -1);
    addDiscoveryLanes(lanes, entry, 1);
    pending.set(source.sourceId, entry);
  }
  return {
    discoveryRevision: discoveryDigest(prior.profile, lanes),
    discovery: { lanes, entries: discovery.entries, pending },
  };
}
/** Retain a transitioned proof; only then do its entry replacements apply. */
function retainPreparedLookupRead(db: DatabaseSync, proof: PreparedLookupRead) {
  const discovery = proof.discovery;
  if (discovery?.pending) {
    for (const [id, entry] of discovery.pending) discovery.entries.set(id, entry);
    proof.discovery = { lanes: discovery.lanes, entries: discovery.entries };
  }
  preparedLookupReads.set(db, proof);
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
  options.assertRunning?.();
  ensureDuplicateEvidenceFunction(db);
  ensureClinicalSourceFingerprintFunction(db);
  const prior = preparedLookupReads.get(db);
  preparedLookupReads.delete(db);
  options.assertRunning?.();
  if (prior && lookupReadCurrent(db, prior)) {
    preparedLookupReads.set(db, prior);
    return { prepared: 0, reused: prior.reused, discoveryRevision: prior.discoveryRevision };
  }
  if (prior?.frontier) {
    const nativeTransition = nativeIntakeLookupCatalogAllOriginalsNative(db, prior);
    // Fixed maintenance needs no accepted outcome. Only the separate accepted
    // transition may account for one ordinary clinical owner transaction.
    const maintenance = readIntakeFrontierAttempts(db, prior.frontier);
    const readInterval =
      maintenance || !nativeTransition
        ? readIntakeFrontierAttempts
        : readIntakeFrontierAcceptedTransition;
    const interval = maintenance ?? readInterval(db, prior.frontier);
    const stamp = reviewReadStamp(db);
    const grounding = identityGroundingGeneration(db);
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
          identityGroundingGeneration(db) === grounding &&
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
        grounding,
        registry,
        projection: projection!,
        profile,
        reused: prior.reused,
        discoveryRevision: prior.discoveryRevision,
      };
      const unchangedMaintenanceHeads =
        maintenance !== undefined &&
        maintenance.ordinaryTokens.length === 0 &&
        nativeTransition &&
        nativeIntakeLookupCatalogHeadBindingsEqual(db, prior, maintenance.headSourceIds);
      const changed = await advanceNativeIntakeLookupCatalog(
        db,
        prior,
        next,
        unchangedMaintenanceHeads ? [] : interval.headSourceIds,
        interval.ordinaryTokens[0],
        current,
        options,
      );
      const transition = changed && current() ? discoveryTransition(prior, changed) : undefined;
      if (transition) {
        Object.assign(next, transition);
        next.frontier = captureIntakeFrontierAttempts(db);
        next.recordHead = readRecordHead(db);
        if (next.frontier && lookupReadCurrent(db, next)) {
          retainPreparedLookupRead(db, next);
          return { prepared: 0, reused: next.reused, discoveryRevision: next.discoveryRevision };
        }
      }
    }
  }
  if (prior?.frontier && prior.recordHead) {
    const appended = await appendChangedLookupSources(db, prior, options);
    if (appended) return appended;
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
    addDiscoverySourceOnce(initialRevision, db, source);
    initialRows++;
    const published = await publishSourceLookupIndices(db, source, options);
    if (published === true) prepared++;
    else if (published === false) reused++;
  }
  const initialDigest = initialRevision.digest();
  // Awaited checkpoints can allow a previously processed source to change.
  // Check each current header before granting a fully prepared result.
  const completedProjection = prepareIntakeLookupProjection(db);
  ensureIntakeFrontierObserver(db);
  const beforeValidation = reviewReadStamp(db);
  const grounding = identityGroundingGeneration(db);
  const registry = intakeCollectionCacheGeneration(db);
  const profile = db
    .prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'")
    .get()?.value;
  const proof: PreparedLookupRead | undefined =
    beforeValidation !== undefined && typeof profile === 'string'
      ? {
          stamp: beforeValidation,
          grounding,
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
    let discovery: DiscoveryState | undefined;
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
        addDiscoverySourceOnce(revision, db, source);
        scanned++;
      }
      current();
      discoveryRevision = revision.digest();
      discovery = { lanes: revision.lanes, entries: revision.entries };
    }
    if (discoveryRevision !== initialDigest)
      throw Error('Intake discovery source frontier changed during preparation');
    options.assertRunning?.();
    if (proof && catalog && lookupReadCurrent(db, proof)) {
      proof.discoveryRevision = discoveryRevision;
      proof.discovery = discovery;
      if (retainNativeIntakeLookupCatalog(db, catalog, proof)) {
        proof.frontier = captureIntakeFrontierAttempts(db);
        proof.recordHead = readRecordHead(db);
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
