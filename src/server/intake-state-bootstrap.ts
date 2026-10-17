import { IntakeStateManifest } from './intake-state-manifest.ts';
import {
  assertIntakeCopyTransfer,
  assertIntakeCopyTransferTarget,
  type IntakeCopyTransfer,
  type IntakeCopyTransferTarget,
} from './intake-copy-transfer.ts';
import {
  intakeCopyPieceSource,
  intakeCopySourcePieces,
  isIntakeCopyPieceSource,
  type IntakeCopyPieceSource,
} from './intake-copy-piece-source.ts';
import {
  createIntakeCopyIncrementalReader,
  type IntakeCopyIncrementalWork,
} from './intake-copy-incremental-reader.ts';
import { inspectIntakeCollectionGraphSteps } from './intake-state-graph.ts';
import { INTAKE_TREE_PAGE_BYTES } from './intake-state-tree.ts';
import { createIntakeTree } from './intake-state-tree.ts';
import {
  parseIntakeCollectionDescriptor,
  parseIntakeStoredValue,
} from './intake-state-collections.ts';
import { INTAKE_LEGACY_BRIDGE_CONTROL } from './intake-state-migration.ts';
import { validateIntakeCollectionEnvelopeRepresentationSteps } from './intake-collection-envelope.ts';
import { rebindCopiedPackageInventory } from './intake-package-state.ts';
import {
  currentTransactionToken,
  hasTransactionDurability,
  rejectCurrentTransaction,
  type Database,
} from './database.ts';
import { flushRecordDurability, recordDurabilityStatus } from './record-versions.ts';
import { safeRelative } from './profile-storage.ts';
import { validProfileId } from './profiles.ts';
import { intakeSourcePinKey, parseIntakeSourcePin } from './intake-source-pin.ts';
import {
  prepareIntakeEnvelopeProjectionSteps,
  type IntakeEnvelopeProjectionFormat,
} from './intake-authority.ts';
import { iterateIntakeJsonVerification } from './intake-json-verify.ts';
import {
  intakeCopyEncodedBytes,
  intakeCopyEncodedBytesSteps,
  intakeCopyTextPieces,
} from './intake-copy-json.ts';
import {
  finishIntakeCopySteps,
  finishIntakeCopyStepsAsync,
  intakeCopyNativeSelect,
  captureIntakeCopyReadInterval,
} from './intake-copy-work.ts';
import { toUSVString } from 'node:util';
import { createHash, type Hash } from 'node:crypto';
import { withIntakeWork } from './intake-work-accounting.ts';
import { prepareIntakeLegacyReplaySteps } from './intake-state-legacy-replay.ts';
import {
  COLLECTION_FORMAT,
  LOG_COLLECTION_FORMAT,
  DEFAULT_LIMITS,
  FRAME_BYTES,
  HEAD_BYTES,
  decode,
  exact,
  intakeNamespace,
  integer,
  invalid,
  limits,
  parseIntakeHead,
  validateIntakeIdentity,
} from './intake-state-evidence.ts';

export interface IntakeCopyOriginal {
  id: string;
  kind: string;
  sha256: string;
  path: string;
  detailsJson: string;
  sourcePin: string | null;
  preserved: {
    provider_id: string | null;
    bytes: number;
    mime_type: string;
    coverage_status: string;
    batch_id: string | null;
  };
}
type IntakeCopyOriginalInput = Omit<IntakeCopyOriginal, 'detailsJson'> & {
  detailsJson: string | IntakeCopyPieceSource;
};
type IntakeCopyRowInput = { key: string; value: string | IntakeCopyPieceSource };
export interface IntakeStateCopySnapshot {
  sourceProfileId: string;
  originals: IntakeCopyOriginal[];
  rows: Array<{ key: string; value: string }>;
}
export interface IntakePreparationLimits {
  namespaces: number;
  rows: number;
  bytes: number;
  nodes: number;
  operations: number;
  stringWork: number;
}
const PREPARATION_LIMITS: IntakePreparationLimits = {
  namespaces: 10_000,
  rows: 200_000,
  bytes: DEFAULT_LIMITS.bytes,
  nodes: DEFAULT_LIMITS.nodes,
  operations: DEFAULT_LIMITS.operations,
  stringWork: DEFAULT_LIMITS.stringWork,
};
export interface IntakeCopyCounters {
  namespaces: number;
  sourceRows: number;
  sourceBytes: number;
  sourceReaderWork: IntakeCopyIncrementalWork | null;
  reconstructedStateBytes: number;
  bootstrapCopyBytes: number;
  decodedNodes: number;
  decodedOperations: number;
  decodedStringWork: number;
  preparedRows: number;
  preparedBytes: number;
  preparedFrameBytes: number;
  preparedNodeBytes: number;
  preparedHeadBytes: number;
  preparedReceiptBytes: number;
}
export interface IntakeStateCopyPlan {
  readonly format: 'health-intake-state-copy-v1';
  readonly sourceProfileId: string;
  readonly targetProfileId: string;
  readonly counters: Readonly<IntakeCopyCounters>;
}
/** Trusted target backend dependency, bound by the caller's exclusive profile lease. */
export interface IntakeCopyPublicationReader {
  readonly profileId: string;
  readSelectedHead(): unknown | null;
}
export interface IntakeRecoveryTraversalOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Readonly<{ records: number }>) => void;
}
type Options = IntakeRecoveryTraversalOptions & {
  limits?: Partial<IntakePreparationLimits>;
  production?: boolean;
  sourceReaderWork?: () => IntakeCopyIncrementalWork;
};
interface PlanData {
  sourceProfileId: string;
  manifest: IntakeStateManifest;
  fingerprint: string;
  caps: IntakePreparationLimits;
  transfer?: IntakeCopyTransfer;
}
const plans = new WeakMap<IntakeStateCopyPlan, PlanData>();
const transferPlans = new WeakMap<IntakeCopyTransfer, IntakeStateCopyPlan>();
const activeTransfers = new WeakMap<
  IntakeStateCopyPlan,
  { db: Database; token: object; view: IntakeCopyTransferTarget }
>();
const planCleanup = new FinalizationRegistry<IntakeStateManifest>((manifest) => manifest.close());
export function disposeIntakeStateCopyPlan(plan: IntakeStateCopyPlan): void {
  const data = plans.get(plan);
  if (data) {
    plans.delete(plan);
    planCleanup.unregister(plan);
    if (data.transfer) transferPlans.delete(data.transfer);
    data.manifest.close();
  }
}
function* transferValues(manifest: IntakeStateManifest): Generator<{
  kind: 'originals' | 'source' | 'prepared';
  key: string;
  pieces: () => Iterable<string>;
}> {
  for (const table of ['originals', 'source', 'prepared'] as const) {
    const keyColumn = table === 'originals' ? 'id' : 'key';
    const next = manifest.db.prepare(
      `SELECT ${keyColumn} AS key,value FROM ${table} WHERE ${keyColumn}>? ORDER BY ${keyColumn} LIMIT 1`,
    );
    let cursor = '';
    for (;;) {
      const row = next.get(cursor);
      if (!row) break;
      const key = String(row.key);
      if (key <= cursor) invalid('copy transfer cursor');
      cursor = key;
      const stored = String(row.value);
      yield {
        kind: table,
        key,
        pieces: () =>
          table === 'prepared'
            ? intakeCopyTextPieces(stored)
            : manifest.valuePieces(table, key, stored),
      };
    }
  }
}

function transferPlanData(plan: IntakeStateCopyPlan, transfer: IntakeCopyTransfer): PlanData {
  assertIntakeCopyTransfer(transfer);
  const data = plans.get(plan);
  if (!data || data.transfer || transferPlans.has(transfer)) invalid('copy transfer plan binding');
  if (data.manifest.fingerprint() !== data.fingerprint) invalid('copy manifest bytes/completeness');
  return data;
}

function bindTransfer(
  plan: IntakeStateCopyPlan,
  transfer: IntakeCopyTransfer,
  data: PlanData,
): void {
  if (plans.get(plan) !== data || data.transfer || transferPlans.has(transfer))
    invalid('copy transfer plan changed');
  if (data.manifest.fingerprint() !== data.fingerprint) invalid('copy manifest bytes/completeness');
  data.transfer = transfer;
  transferPlans.set(transfer, plan);
}

/** Build private transport before the caller's unpublished target transaction. */
export async function populateIntakeStateCopyTransfer(
  plan: IntakeStateCopyPlan,
  transfer: IntakeCopyTransfer,
): Promise<void> {
  const data = transferPlanData(plan, transfer);
  for (const row of transferValues(data.manifest)) {
    if (plans.get(plan) !== data) invalid('copy transfer plan changed');
    await transfer.put(row.kind, row.key, row.pieces);
  }
  bindTransfer(plan, transfer, data);
}

/** Synchronous compatibility for encrypted profile opening. */
export function populateIntakeStateCopyTransferSync(
  plan: IntakeStateCopyPlan,
  transfer: IntakeCopyTransfer,
): void {
  const data = transferPlanData(plan, transfer);
  for (const row of transferValues(data.manifest)) transfer.putSync(row.kind, row.key, row.pieces);
  bindTransfer(plan, transfer, data);
}

/** The target view is held privately and can only be entered through its plan-bound transfer. */
export function withIntakeStateCopyTransfer<T>(
  plan: IntakeStateCopyPlan,
  db: Database,
  token: object,
  run: (view: IntakeCopyTransferTarget) => T,
): T {
  const data = plans.get(plan);
  if (!data?.transfer || activeTransfers.has(plan)) invalid('copy transfer target binding');
  const transfer = data.transfer;
  assertIntakeCopyTransfer(transfer);
  return transfer.withTarget(db, token, (view) => {
    assertIntakeCopyTransferTarget(view, transfer, db, token);
    activeTransfers.set(plan, { db, token, view });
    try {
      return run(view);
    } finally {
      activeTransfers.delete(plan);
    }
  });
}
export type IntakeStateCopyRows = {
  sourceProfileId: string;
  originals: Iterable<IntakeCopyOriginalInput>;
  rows: Iterable<IntakeCopyRowInput>;
};

function preparationLimits(options: Options): IntakePreparationLimits {
  const raw = options.limits ?? {};
  if (Object.keys(raw).some((name) => !Object.hasOwn(PREPARATION_LIMITS, name)))
    invalid('preparation limit key');
  const caps = {
    ...PREPARATION_LIMITS,
    namespaces: Number.MAX_SAFE_INTEGER,
    rows: Number.MAX_SAFE_INTEGER,
    bytes: Number.MAX_SAFE_INTEGER,
    ...raw,
  };
  for (const name of Object.keys(caps) as Array<keyof IntakePreparationLimits>) {
    integer(caps[name], 1);
    if (raw[name] !== undefined && caps[name] > PREPARATION_LIMITS[name])
      invalid('raised preparation limit');
  }
  return caps;
}
function profiles(source: unknown, target: unknown): asserts source is string {
  if (!validProfileId(source) || !validProfileId(target) || source === target)
    invalid('copy profile identity');
}
function ownedPath(path: unknown, profileId: string): asserts path is string {
  if (
    !safeRelative(path) ||
    path.includes('\0') ||
    !path.startsWith(`data/profiles/${profileId}/sources/`)
  )
    invalid('copy original path');
}
function* sourceSizeSteps(original: IntakeCopyOriginalInput): Generator<void, number> {
  if (typeof original.detailsJson === 'string') return yield* intakeCopyEncodedBytesSteps(original);
  let bytes = yield* intakeCopyEncodedBytesSteps({ ...original, detailsJson: '' });
  for (const piece of intakeCopySourcePieces(original.detailsJson))
    for (const part of intakeCopyTextPieces(piece)) {
      bytes += Buffer.byteLength(JSON.stringify(part).slice(1, -1));
      yield;
    }
  return bytes;
}
function sourceSize(original: IntakeCopyOriginal): number {
  return intakeCopyEncodedBytes(original);
}
function rowSize(row: { key: string; value: string }): number {
  return Buffer.byteLength(row.key) + Buffer.byteLength(row.value);
}
function assertTotals(rows: number, bytes: number, caps: IntakePreparationLimits): void {
  integer(rows);
  integer(bytes);
  if (rows > caps.rows || bytes > caps.bytes) invalid('aggregate preparation rows/bytes');
}
function* validateOriginalSteps(
  raw: IntakeCopyOriginalInput,
  profileId: string,
): Generator<void, IntakeCopyOriginalInput> {
  exact(raw, ['id', 'kind', 'sha256', 'path', 'detailsJson', 'sourcePin', 'preserved']);
  validateIntakeIdentity({
    profileId,
    intakeId: raw.id as string,
    sourceHash: raw.sha256 as string,
  });
  if (raw.kind !== 'intake_original') invalid('copy original kind');
  ownedPath(raw.path, profileId);
  if (typeof raw.detailsJson !== 'string' && !isIntakeCopyPieceSource(raw.detailsJson))
    invalid('copy original envelope');
  let bytes = 0;
  for (const piece of intakeCopySourcePieces(raw.detailsJson)) {
    bytes += Buffer.byteLength(piece);
    if (bytes > PREPARATION_LIMITS.bytes) invalid('encoded bytes');
    if (toUSVString(piece) !== piece) invalid('UTF-8');
    yield;
  }
  yield* iterateIntakeJsonVerification(intakeCopySourcePieces(raw.detailsJson));
  let object = false;
  for (const piece of intakeCopySourcePieces(raw.detailsJson)) {
    const first = piece.replace(/^[\x20\t\r\n]*/, '');
    if (first) {
      object = first.startsWith('{');
      break;
    }
    yield;
  }
  if (!object) invalid('copy original envelope');
  if (raw.sourcePin !== null && typeof raw.sourcePin !== 'string') invalid('copy source pin');
  parseIntakeSourcePin(raw.sourcePin);
  exact(raw.preserved, ['provider_id', 'bytes', 'mime_type', 'coverage_status', 'batch_id']);
  integer(raw.preserved.bytes);
  for (const name of ['provider_id', 'batch_id'] as const) {
    if (raw.preserved[name] !== null && typeof raw.preserved[name] !== 'string')
      invalid('copy original fields');
  }
  for (const name of ['mime_type', 'coverage_status'] as const) {
    if (typeof raw.preserved[name] !== 'string') invalid('copy original fields');
  }
  return {
    id: raw.id as string,
    kind: raw.kind as string,
    sha256: raw.sha256 as string,
    path: raw.path,
    detailsJson: raw.detailsJson,
    sourcePin: raw.sourcePin,
    preserved: { ...raw.preserved },
  };
}

function savedOriginal(
  row: Record<string, unknown>,
  manifest: IntakeStateManifest,
  materialize = false,
): IntakeCopyOriginalInput {
  const id = row.id as string,
    stored = row.value as string;
  const detailsJson = manifest.hasPieces('originals', id)
    ? materialize
      ? manifest.value('originals', id, stored)
      : intakeCopyPieceSource(() => manifest.valuePieces('originals', id, stored))
    : stored;
  return {
    id,
    kind: row.kind as string,
    sha256: row.sha256 as string,
    path: row.path as string,
    detailsJson,
    sourcePin: row.source_pin as string | null,
    preserved: {
      provider_id: row.provider_id as string | null,
      bytes: row.bytes as number,
      mime_type: row.mime_type as string,
      coverage_status: row.coverage_status as string,
      batch_id: row.batch_id as string | null,
    },
  };
}

/** Detached evidence validation only: this API does not certify selected source publication. */
export function prepareIntakeStateCopySnapshot(
  snapshot: IntakeStateCopySnapshot,
  targetProfileId: string,
  options: Options = {},
): IntakeStateCopyPlan {
  return inspectSnapshot(snapshot, targetProfileId, options)!;
}

/** Validate retained portable evidence without generating a new copy or requiring a backend. */
export function validateIntakeStateCopySnapshot(
  snapshot: IntakeStateCopySnapshot,
  options: Options = {},
): void {
  inspectSnapshot(snapshot, undefined, options);
}
export function validateIntakeStateCopyRows(
  snapshot: IntakeStateCopyRows,
  options: IntakeRecoveryTraversalOptions = {},
): void {
  inspectSnapshot(snapshot, undefined, options);
}
export function prepareProductionIntakeStateCopyRows(
  db: Database,
  sourceProfileId: string,
  targetProfileId: string,
): IntakeStateCopyPlan {
  return inspectSnapshot(capture(db, sourceProfileId), targetProfileId, { production: true })!;
}

export function* prepareProductionIntakeStateCopyRowsSteps(
  db: Database,
  sourceProfileId: string,
  targetProfileId: string,
  options: IntakeRecoveryTraversalOptions = {},
): Generator<void, IntakeStateCopyPlan> {
  return (yield* inspectSnapshotSteps(capture(db, sourceProfileId), targetProfileId, {
    ...options,
    production: true,
  }))!;
}

export async function prepareProductionIntakeStateCopyRowsAsync(
  db: Database,
  sourceProfileId: string,
  targetProfileId: string,
  options: IntakeRecoveryTraversalOptions = {},
): Promise<IntakeStateCopyPlan> {
  const current = captureIntakeCopyReadInterval(db, sourceProfileId);
  const checkpoint = () => {
    options.signal?.throwIfAborted();
    current();
  };
  const reader = await createIntakeCopyIncrementalReader(db, checkpoint);
  let plan: IntakeStateCopyPlan | undefined;
  try {
    plan = await finishIntakeCopyStepsAsync(
      inspectSnapshotSteps(
        capturePieceRows(db, reader, sourceProfileId, checkpoint),
        targetProfileId,
        {
          ...options,
          production: true,
          sourceReaderWork: () => reader.work(),
        },
      ),
      options.signal,
    );
    checkpoint();
    return plan!;
  } catch (error) {
    if (plan) disposeIntakeStateCopyPlan(plan);
    throw error;
  } finally {
    try {
      reader.close();
    } catch (error) {
      if (plan) disposeIntakeStateCopyPlan(plan);
      throw error;
    }
  }
}

function inspectSnapshot(
  snapshot: IntakeStateCopyRows,
  targetProfileId: string | undefined,
  options: Options,
): IntakeStateCopyPlan | undefined {
  return finishIntakeCopySteps(inspectSnapshotSteps(snapshot, targetProfileId, options));
}

function* inspectSnapshotSteps(
  snapshot: IntakeStateCopyRows,
  targetProfileId: string | undefined,
  options: Options,
): Generator<void, IntakeStateCopyPlan | undefined> {
  exact(snapshot, ['sourceProfileId', 'originals', 'rows']);
  if (targetProfileId !== undefined) profiles(snapshot.sourceProfileId, targetProfileId);
  else if (!validProfileId(snapshot.sourceProfileId)) invalid('copy profile identity');
  if (!snapshot.originals?.[Symbol.iterator] || !snapshot.rows?.[Symbol.iterator])
    invalid('copy snapshot');
  const caps = preparationLimits(options);

  const sourceProfileId = snapshot.sourceProfileId;
  const manifest = new IntakeStateManifest();
  let retained = false;
  let records = 0;
  const checkpoint = () => {
    options.signal?.throwIfAborted();
    integer(++records);
    if (records % 256 === 0) options.onProgress?.(Object.freeze({ records }));
  };
  try {
    checkpoint();
    manifest.db.exec(`
      ALTER TABLE originals ADD COLUMN kind TEXT;
      ALTER TABLE originals ADD COLUMN sha256 TEXT;
      ALTER TABLE originals ADD COLUMN path TEXT;
      ALTER TABLE originals ADD COLUMN source_pin TEXT;
      ALTER TABLE originals ADD COLUMN provider_id TEXT;
      ALTER TABLE originals ADD COLUMN bytes INTEGER;
      ALTER TABLE originals ADD COLUMN mime_type TEXT;
      ALTER TABLE originals ADD COLUMN coverage_status TEXT;
      ALTER TABLE originals ADD COLUMN batch_id TEXT;
      ALTER TABLE originals ADD COLUMN projection_format TEXT;
    `);
    const counters: IntakeCopyCounters = {
      namespaces: 0,
      sourceRows: 0,
      sourceBytes: 0,
      sourceReaderWork: null,
      reconstructedStateBytes: 0,
      bootstrapCopyBytes: 0,
      decodedNodes: 0,
      decodedOperations: 0,
      decodedStringWork: 0,
      preparedRows: 0,
      preparedBytes: 0,
      preparedFrameBytes: 0,
      preparedNodeBytes: 0,
      preparedHeadBytes: 0,
      preparedReceiptBytes: 0,
    };
    for (const original of snapshot.originals) {
      checkpoint();
      yield;
      // Charge encoded raw input before parsing or retaining an additional copy.
      counters.sourceRows++;
      counters.sourceBytes += yield* sourceSizeSteps(original);
      assertTotals(counters.sourceRows, counters.sourceBytes, caps);
      const validated = yield* validateOriginalSteps(original, sourceProfileId);
      let projectionFormat: IntakeEnvelopeProjectionFormat | null = null;
      if (options.production) {
        const projection = yield* prepareIntakeEnvelopeProjectionSteps(
          intakeCopySourcePieces(validated.detailsJson),
          { assertRunning: checkpoint },
        );
        projectionFormat = projection.format;
      }
      if (manifest.db.prepare('SELECT 1 FROM originals WHERE id=?').get(validated.id))
        invalid('duplicate copy original');
      manifest.db
        .prepare('INSERT INTO originals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          validated.id,
          typeof validated.detailsJson === 'string' ? validated.detailsJson : '',
          validated.kind,
          validated.sha256,
          validated.path,
          validated.sourcePin,
          validated.preserved.provider_id,
          validated.preserved.bytes,
          validated.preserved.mime_type,
          validated.preserved.coverage_status,
          validated.preserved.batch_id,
          projectionFormat,
        );
      if (typeof validated.detailsJson !== 'string')
        yield* manifest.putPartsSteps(
          'originals',
          validated.id,
          intakeCopySourcePieces(validated.detailsJson),
        );
    }
    for (const raw of snapshot.rows) {
      checkpoint();
      yield;
      exact(raw, ['key', 'value']);
      if (
        typeof raw.key !== 'string' ||
        (typeof raw.value !== 'string' && !isIntakeCopyPieceSource(raw.value))
      )
        invalid('copy inventory row');
      counters.sourceRows++;
      for (const value of [raw.key, raw.value])
        for (const piece of intakeCopySourcePieces(value)) {
          counters.sourceBytes += Buffer.byteLength(piece);
          yield;
        }
      assertTotals(counters.sourceRows, counters.sourceBytes, caps);
      const match =
        /^intake_state_v1:([0-9a-f]{64}):(head|node:[0-9a-f]{64}|(?:frame|operation):[0-9a-f-]{36})$/.exec(
          raw.key,
        );
      if (!match) invalid('unsupported copy namespace');
      const prefix = `intake_state_v1:${match[1]}:`;
      const inserted = manifest.db
        .prepare('INSERT OR IGNORE INTO namespaces VALUES(?)')
        .run(prefix).changes;
      counters.namespaces += Number(inserted);
      if (counters.namespaces > caps.namespaces) invalid('aggregate preparation namespaces');
      if (typeof raw.value === 'string') manifest.put('source', raw.key, raw.value, prefix);
      else yield* manifest.putPartsSteps('source', raw.key, raw.value.pieces(), prefix);
    }

    const chainCaps = limits(),
      nextNamespace = manifest.db.prepare(
        'SELECT prefix FROM namespaces WHERE prefix>? ORDER BY prefix LIMIT 1',
      );
    let afterNamespace = '';
    for (;;) {
      // Graph inspection recreates namespace-local scratch tables. Keep no
      // active SQLite iterator across that DDL; a scalar keyset also bounds
      // memory when a profile contains many retained original namespaces.
      const entry = nextNamespace.get(afterNamespace);
      if (!entry) break;
      checkpoint();
      yield;
      const prefix = String(entry.prefix);
      afterNamespace = prefix;
      const get = (key: string) =>
        manifest.sourceValue(
          key,
          key.includes(':node:')
            ? INTAKE_TREE_PAGE_BYTES
            : key.includes(':frame:')
              ? FRAME_BYTES
              : HEAD_BYTES,
        );
      const rawHead = get(prefix + 'head');
      if (rawHead === undefined) invalid('missing copy head');
      const header = decode(rawHead, HEAD_BYTES);
      if (!header || typeof header !== 'object' || Array.isArray(header)) invalid('copy head');
      const collections = [COLLECTION_FORMAT, LOG_COLLECTION_FORMAT].includes(
        String(Reflect.get(header, 'format')),
      );
      const identity = validateIntakeIdentity(
        collections
          ? Reflect.get(header, 'identity')
          : {
              profileId: Reflect.get(header, 'profileId'),
              intakeId: Reflect.get(header, 'intakeId'),
              sourceHash: Reflect.get(header, 'sourceHash'),
            },
      );
      if (identity.profileId !== sourceProfileId || intakeNamespace(identity) !== prefix)
        invalid('copy namespace identity');
      const originalRow = manifest.db
        .prepare('SELECT * FROM originals WHERE id=?')
        .get(identity.intakeId);
      const original = originalRow ? savedOriginal(originalRow, manifest) : undefined;
      if (!original || original.sha256 !== identity.sourceHash)
        invalid('copy original identity/hash');
      if (collections) {
        yield* inspectIntakeCollectionGraphSteps(
          manifest,
          identity,
          rawHead,
          targetProfileId,
          checkpoint,
          options.production
            ? function* (head, legacyValue) {
                const readNode = (hash: string) => {
                  checkpoint();
                  return get(prefix + 'node:' + hash);
                };
                const tree = createIntakeTree(identity, readNode, new Map());
                const control = parseIntakeCollectionDescriptor(
                  tree.get(head.logical.root, 'envelope.control'),
                );
                if (!control || control.kind !== 'map')
                  invalid('missing production envelope control');
                const encoded = tree.get(control.root, 'representation');
                if (encoded === undefined) invalid('missing production envelope representation');
                const marker = parseIntakeStoredValue(encoded);
                if (marker.kind !== 'inline')
                  invalid('fragmented production envelope representation');
                if (marker.text === INTAKE_LEGACY_BRIDGE_CONTROL) {
                  if (legacyValue === undefined) invalid('missing production legacy envelope');
                  const checked = yield* legacyValue.validateEnvelopeSteps(original.detailsJson);
                  if (checked.domainVersion !== head.logical.domainVersion)
                    invalid('legacy selected domain version disagreement');
                } else {
                  yield* validateIntakeCollectionEnvelopeRepresentationSteps(
                    original.detailsJson,
                    head,
                    readNode,
                    originalRow!.projection_format as IntakeEnvelopeProjectionFormat,
                  );
                }
                const inventories = parseIntakeCollectionDescriptor(
                  tree.get(head.builds, 'package.inventories'),
                );
                if (inventories) {
                  if (inventories.kind !== 'map') invalid('inventory registry collection kind');
                  for (const row of tree.entries(inventories.root)) {
                    yield;
                    const stored = parseIntakeStoredValue(row.value);
                    if (stored.kind !== 'inline') invalid('inventory registry value');
                    rebindCopiedPackageInventory({
                      text: stored.text,
                      key: row.key,
                      sourceBinding: { ...identity, bytes: original.preserved.bytes },
                      targetProfileId: identity.profileId,
                      sourceCollection: (name) =>
                        parseIntakeCollectionDescriptor(tree.get(head.builds, name)) ?? null,
                      rebindDescriptor: (descriptor) => descriptor,
                    });
                  }
                }
              }
            : undefined,
          options.production && targetProfileId
            ? (text, key, sourceCollection, rebindDescriptor) =>
                rebindCopiedPackageInventory({
                  text,
                  key,
                  sourceBinding: { ...identity, bytes: original.preserved.bytes },
                  targetProfileId,
                  sourceCollection,
                  rebindDescriptor,
                })
            : undefined,
        );
        continue;
      }
      const head = parseIntakeHead(rawHead, identity, chainCaps)!;
      const remainingCaps = {
        ...chainCaps,
        nodes:
          options.limits?.nodes === undefined
            ? chainCaps.nodes
            : caps.nodes - counters.decodedNodes,
        operations:
          options.limits?.operations === undefined
            ? chainCaps.operations
            : caps.operations - counters.decodedOperations,
        stringWork:
          options.limits?.stringWork === undefined
            ? chainCaps.stringWork
            : caps.stringWork - counters.decodedStringWork,
      };
      if (
        head.usage.nodes > remainingCaps.nodes ||
        head.usage.operations > remainingCaps.operations ||
        head.usage.stringWork > remainingCaps.stringWork
      )
        invalid('aggregate preparation decoded work');
      // Constrain the actual decoder too: a forged smaller usage claim must not
      // buy a default-sized decode before final usage agreement rejects it.
      const basis = yield* prepareIntakeLegacyReplaySteps(identity, remainingCaps, head, get, {
        checkpoint,
      });
      try {
        for (const key of basis.consumed()) {
          manifest.db.prepare('INSERT OR IGNORE INTO visited VALUES(?)').run(key);
          yield;
        }
        for (const row of manifest.db
          .prepare(
            'SELECT source.key FROM source LEFT JOIN visited ON source.key=visited.key WHERE source.prefix=? AND visited.key IS NULL',
          )
          .iterate(prefix))
          invalid('unselected copy contribution: ' + row.key);
        counters.decodedNodes += head.usage.nodes;
        counters.decodedOperations += head.usage.operations;
        counters.decodedStringWork += head.usage.stringWork;
        if (
          (options.limits?.nodes !== undefined && counters.decodedNodes > caps.nodes) ||
          (options.limits?.operations !== undefined &&
            counters.decodedOperations > caps.operations) ||
          (options.limits?.stringWork !== undefined && counters.decodedStringWork > caps.stringWork)
        )
          invalid('aggregate preparation decoded work');
        if (options.production) yield* basis.validateEnvelopeSteps(original.detailsJson);
        counters.reconstructedStateBytes += basis.semanticBytes;
        if (counters.reconstructedStateBytes > caps.bytes) invalid('aggregate reconstructed bytes');
        if (targetProfileId === undefined) continue;
        const targetIdentity = { ...identity, profileId: targetProfileId };
        counters.bootstrapCopyBytes += basis.semanticBytes;
        const targetPrefix = intakeNamespace(targetIdentity);
        const put = (key: string, value: string) => {
          counters.preparedRows++;
          counters.preparedBytes += rowSize({ key, value });
          assertTotals(
            counters.sourceRows + counters.preparedRows,
            counters.sourceBytes + counters.preparedBytes,
            caps,
          );
          manifest.put('prepared', key, value);
        };
        const rebound = yield* basis.rebindSteps(targetIdentity, put);
        put(targetPrefix + 'head', JSON.stringify(rebound));
      } finally {
        basis.close();
      }
    }
    if (options.production)
      for (const row of manifest.db.prepare('SELECT * FROM originals').iterate()) {
        yield;
        const original = savedOriginal(row, manifest);
        if (
          !manifest.db.prepare('SELECT 1 FROM namespaces WHERE prefix=?').get(
            intakeNamespace({
              profileId: sourceProfileId,
              intakeId: original.id,
              sourceHash: original.sha256,
            }),
          )
        )
          invalid('missing production intake authority');
      }
    if (targetProfileId === undefined) return;
    counters.preparedRows = 0;
    counters.preparedBytes = 0;
    counters.preparedFrameBytes = 0;
    counters.preparedHeadBytes = 0;
    counters.preparedReceiptBytes = 0;
    counters.preparedNodeBytes = 0;
    for (const row of manifest.rows('prepared')) {
      yield;
      counters.preparedRows++;
      counters.preparedBytes += rowSize(row);
      const bytes = Buffer.byteLength(row.value);
      if (row.key.includes(':node:')) counters.preparedNodeBytes += bytes;
      else if (row.key.includes(':frame:')) counters.preparedFrameBytes += bytes;
      else if (row.key.includes(':operation:')) counters.preparedReceiptBytes += bytes;
      else if (row.key.endsWith(':head')) counters.preparedHeadBytes += bytes;
    }
    assertTotals(
      counters.sourceRows + counters.preparedRows,
      counters.sourceBytes + counters.preparedBytes,
      caps,
    );
    if (options.sourceReaderWork)
      counters.sourceReaderWork = Object.freeze(options.sourceReaderWork());
    const plan: IntakeStateCopyPlan = Object.freeze({
      format: 'health-intake-state-copy-v1',
      sourceProfileId,
      targetProfileId,
      counters: Object.freeze(counters),
    });
    const data: PlanData = {
      sourceProfileId,
      manifest,
      caps,
      fingerprint: yield* manifest.fingerprintSteps(),
    };
    plans.set(plan, data);
    planCleanup.register(plan, manifest, plan);
    retained = true;
    return plan;
  } finally {
    if (!retained) manifest.close();
  }
}

function capture(
  db: Database,
  sourceProfileId: string,
): {
  sourceProfileId: string;
  originals: Iterable<IntakeCopyOriginal>;
  rows: Iterable<{ key: string; value: string }>;
} {
  function* originals(): Generator<IntakeCopyOriginal> {
    for (const row of intakeCopyNativeSelect(
      db,
      "SELECT * FROM main.source_files WHERE kind='intake_original' ORDER BY id",
    ).iterate()) {
      const sourcePin = intakeCopyNativeSelect(
        db,
        'SELECT value FROM main.app_meta WHERE key=?',
      ).get(intakeSourcePinKey(String(row.id)))?.value;
      const original: IntakeCopyOriginal = {
        id: row.id as string,
        kind: row.kind as string,
        sha256: row.sha256 as string,
        path: row.path as string,
        detailsJson: row.details_json as string,
        sourcePin: sourcePin === undefined ? null : (sourcePin as string),
        preserved: {
          provider_id: row.provider_id as string | null,
          bytes: row.bytes as number,
          mime_type: row.mime_type as string,
          coverage_status: row.coverage_status as string,
          batch_id: row.batch_id as string | null,
        },
      };
      yield original;
    }
  }
  function* rows(): Generator<{ key: string; value: string }> {
    for (const row of intakeCopyNativeSelect(
      db,
      "SELECT key,value FROM main.app_meta WHERE key GLOB 'intake_state_*' ORDER BY key",
    ).iterate()) {
      if (typeof row.key !== 'string' || typeof row.value !== 'string')
        invalid('copy inventory row');
      const contribution = { key: row.key, value: row.value };
      yield contribution;
    }
  }
  return { sourceProfileId, originals: originals(), rows: rows() };
}

function capturePieceRows(
  db: Database,
  reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>>,
  sourceProfileId: string,
  checkpoint: () => void,
): IntakeStateCopyRows {
  const text = (table: string, column: string, rowid: bigint, nullable = false) => {
    const kind = reader.columnType(table, column, rowid);
    if (nullable && kind === 'null') return null;
    if (kind !== 'text') invalid('copy original field storage class');
    let result = '',
      bytes = 0;
    for (const piece of reader.textPieces(table, column, rowid)) {
      checkpoint();
      bytes += Buffer.byteLength(piece);
      if (bytes > PREPARATION_LIMITS.bytes) invalid('aggregate preparation rows/bytes');
      result += piece;
    }
    return result;
  };
  const sourceColumns = reader.columns('source_files'),
    metaColumns = reader.columns('app_meta');
  const rowidAlias = (columns: readonly string[]) => {
    const alias = ['rowid', '_rowid_', 'oid'].find(
      (name) => !columns.some((column) => column.toLowerCase() === name),
    );
    if (!alias) invalid('copy source rowid alias changed');
    return alias;
  };
  const sourceRowid = rowidAlias(sourceColumns),
    metaRowid = rowidAlias(metaColumns);
  function* originals(): Generator<IntakeCopyOriginalInput> {
    for (const row of intakeCopyNativeSelect(
      db,
      `SELECT CAST(${sourceRowid} AS TEXT) AS rid,bytes FROM main.source_files WHERE kind='intake_original' ORDER BY id`,
      checkpoint,
    ).iterate()) {
      checkpoint();
      const rowid = BigInt(String(row.rid));
      const id = text('source_files', 'id', rowid)!;
      const pin = intakeCopyNativeSelect(
        db,
        `SELECT CAST(${metaRowid} AS TEXT) AS rid FROM main.app_meta WHERE key=?`,
        checkpoint,
      ).get(intakeSourcePinKey(id));
      const sourcePin = pin ? text('app_meta', 'value', BigInt(String(pin.rid))) : null;
      const original: IntakeCopyOriginalInput = {
        id,
        kind: text('source_files', 'kind', rowid)!,
        sha256: text('source_files', 'sha256', rowid)!,
        path: text('source_files', 'path', rowid)!,
        detailsJson: intakeCopyPieceSource(() =>
          reader.textPieces('source_files', 'details_json', rowid),
        ),
        sourcePin,
        preserved: {
          provider_id: text('source_files', 'provider_id', rowid, true),
          bytes: row.bytes as number,
          mime_type: text('source_files', 'mime_type', rowid)!,
          coverage_status: text('source_files', 'coverage_status', rowid)!,
          batch_id: text('source_files', 'batch_id', rowid, true),
        },
      };
      yield original;
    }
  }
  function* rows(): Generator<IntakeCopyRowInput> {
    for (const row of intakeCopyNativeSelect(
      db,
      `SELECT CAST(${metaRowid} AS TEXT) AS rid FROM main.app_meta WHERE key GLOB 'intake_state_*' ORDER BY key`,
      checkpoint,
    ).iterate()) {
      checkpoint();
      const rowid = BigInt(String(row.rid));
      yield {
        key: text('app_meta', 'key', rowid)!,
        value: intakeCopyPieceSource(() => reader.textPieces('app_meta', 'value', rowid)),
      };
    }
  }
  return { sourceProfileId, originals: originals(), rows: rows() };
}

/** Read-only bounded capture; the caller must independently certify selected publication. */
export function captureIntakeStateCopySnapshot(
  db: Database,
  sourceProfileId: string,
  options: Options = {},
): IntakeStateCopySnapshot {
  // Explicit compatibility materialization retains its old aggregate memory guard.
  const caps = {
    ...PREPARATION_LIMITS,
    ...preparationLimits({ ...options, limits: { ...PREPARATION_LIMITS, ...options.limits } }),
  };
  const input = capture(db, sourceProfileId);
  const snapshot: IntakeStateCopySnapshot = { sourceProfileId, originals: [], rows: [] };
  let count = 0,
    bytes = 0;
  for (const original of input.originals) {
    options.signal?.throwIfAborted();
    bytes += sourceSize(original);
    assertTotals(++count, bytes, caps);
    snapshot.originals.push(original);
  }
  for (const row of input.rows) {
    options.signal?.throwIfAborted();
    bytes += rowSize(row);
    assertTotals(++count, bytes, caps);
    snapshot.rows.push(row);
  }
  return snapshot;
}

const productionAuthorityWork = { validations: 0, reuses: 0 };
/** Process-local digests of exact SQL inputs that passed complete production
 * validation. They are never recovery authority and never cross processes; a
 * contributor copy worker thread of this process may hand its own over. */
const validatedProductionInputs: string[] = [];
const VALIDATED_PRODUCTION_INPUTS = 8;
let unmatchedCapturedValues = 0;

const PRODUCTION_INPUT_DIGEST = /^[0-9a-f]{64}$/;
function retainValidatedProductionInput(digest: string): void {
  if (validatedProductionInputs.includes(digest)) return;
  validatedProductionInputs.push(digest);
  if (validatedProductionInputs.length > VALIDATED_PRODUCTION_INPUTS)
    validatedProductionInputs.shift();
}
/** Digests this thread retained from its own complete validations, oldest first. */
export function validatedProductionIntakeInputs(): string[] {
  return [...validatedProductionInputs];
}
/** Retain digests that a contributor copy worker thread of this process
 * produced by complete validation of exactly those inputs. A later call reuses
 * one only when its own digest of the rows it would consume is identical. */
export function acceptValidatedProductionIntakeInputs(digests: unknown): void {
  if (
    !Array.isArray(digests) ||
    digests.length > VALIDATED_PRODUCTION_INPUTS ||
    !digests.every((digest) => typeof digest === 'string' && PRODUCTION_INPUT_DIGEST.test(digest))
  )
    throw Error('Invalid validated production intake input digest');
  for (const digest of digests as string[]) retainValidatedProductionInput(digest);
}

/** Counts complete production intake validations and exact-input reuses. */
export function productionIntakeAuthorityWork(): Readonly<{ validations: number; reuses: number }> {
  return { ...productionAuthorityWork };
}

/** Lossless, unambiguous encoding of one captured value: UTF-16 code units, so
 * distinct strings (including lone surrogates) never share an encoding. */
function hashCapturedValue(hash: Hash, value: unknown): void {
  if (typeof value === 'string') {
    hash.update('s' + value.length + ':');
    hash.update(Buffer.from(value, 'utf16le'));
  } else if (typeof value === 'number')
    hash.update('n' + (Object.is(value, -0) ? '-0' : String(value)) + ';');
  else if (typeof value === 'bigint') hash.update('b' + String(value) + ';');
  else if (value === null) hash.update('z;');
  else if (value === undefined) hash.update('u;');
  // Other storage classes are refused by validation; never treat them as equal.
  else hash.update('x' + ++unmatchedCapturedValues + ';');
}
function hashCapturedOriginal(hash: Hash, original: IntakeCopyOriginal): void {
  hash.update('o');
  for (const value of [
    original.id,
    original.kind,
    original.sha256,
    original.path,
    original.detailsJson,
    original.sourcePin,
    original.preserved.provider_id,
    original.preserved.bytes,
    original.preserved.mime_type,
    original.preserved.coverage_status,
    original.preserved.batch_id,
  ])
    hashCapturedValue(hash, value);
}
function hashCapturedRow(hash: Hash, row: { key: string; value: string }): void {
  hash.update('r');
  hashCapturedValue(hash, row.key);
  hashCapturedValue(hash, row.value);
}
function productionInputHash(owner: string): Hash {
  const hash = createHash('sha256');
  hash.update('circus-health-production-intake-input-v1\0');
  hashCapturedValue(hash, owner);
  return hash;
}
/** Digest of exactly the rows `capture` supplies to production validation. */
function productionInputDigest(db: Database, owner: string): string {
  const hash = productionInputHash(owner),
    input = capture(db, owner);
  for (const original of input.originals) hashCapturedOriginal(hash, original);
  hash.update('|');
  for (const row of input.rows) hashCapturedRow(hash, row);
  return hash.digest('hex');
}

/** Validate selected SQL evidence before runtime attachment/first publication.
 * The caller independently certifies its genuine selected durability backend.
 * Validation is a deterministic function of the captured SQL rows and owner.
 * When the exact captured inputs match ones that already passed complete
 * validation in this process, that result is reused; any changed byte, row,
 * order or storage class runs the complete validation again. Physical checks
 * belong to callers and are never skipped by this reuse. */
export function validateProductionIntakeAuthority(
  db: Database,
  profileId?: string,
  options: IntakeRecoveryTraversalOptions = {},
): void {
  const owner = db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value;
  if (typeof owner !== 'string' || (profileId !== undefined && owner !== profileId))
    invalid('production intake owner');
  options.signal?.throwIfAborted();
  // Progress observers see the complete traversal, so they are never served a reuse.
  const reusable = !options.onProgress;
  if (reusable && validatedProductionInputs.includes(productionInputDigest(db, owner))) {
    productionAuthorityWork.reuses++;
    return;
  }
  const hash = productionInputHash(owner);
  withIntakeWork(db, 'reconstruction', () => {
    const input = capture(db, owner);
    inspectSnapshot(
      {
        sourceProfileId: input.sourceProfileId,
        originals: (function* () {
          for (const original of input.originals) {
            hashCapturedOriginal(hash, original);
            yield original;
          }
          hash.update('|');
        })(),
        rows: (function* () {
          for (const row of input.rows) {
            hashCapturedRow(hash, row);
            yield row;
          }
        })(),
      },
      undefined,
      { ...options, production: true },
    );
  });
  productionAuthorityWork.validations++;
  if (!reusable) return;
  // Retain the digest of exactly the inputs this validation consumed.
  retainValidatedProductionInput(hash.digest('hex'));
}
export function validateProductionIntakeStateCopySnapshot(snapshot: IntakeStateCopySnapshot): void {
  inspectSnapshot(snapshot, undefined, { production: true });
}
export function prepareProductionIntakeStateCopySnapshot(
  snapshot: IntakeStateCopySnapshot,
  targetProfileId: string,
): IntakeStateCopyPlan {
  return inspectSnapshot(snapshot, targetProfileId, { production: true })!;
}
export function prepareProductionIntakeStateCopy(
  db: Database,
  sourceProfileId: string,
  targetProfileId: string,
): IntakeStateCopyPlan {
  return prepareIntakeStateCopy(db, sourceProfileId, targetProfileId, { production: true });
}

/** Capture only a real, current selected source projection, before owner/path rewrites. */
export function prepareIntakeStateCopy(
  db: Database,
  sourceProfileId: string,
  targetProfileId: string,
  options: Options = {},
): IntakeStateCopyPlan {
  profiles(sourceProfileId, targetProfileId);
  if (!db.isOpen || db.isTransaction || currentTransactionToken(db))
    invalid('copy source transaction/closed');
  if (
    intakeCopyNativeSelect(db, "SELECT value FROM main.app_meta WHERE key='owner_profile_id'").get()
      ?.value !== sourceProfileId
  )
    invalid('copy source owner');
  flushRecordDurability(db);
  let plan: IntakeStateCopyPlan | undefined;
  db.exec('BEGIN');
  try {
    plan = withIntakeWork(db, 'reconstruction', () =>
      inspectSnapshot(capture(db, sourceProfileId), targetProfileId, options)!,
    );
    flushRecordDurability(db);
  } catch (error) {
    if (plan) disposeIntakeStateCopyPlan(plan);
    throw error;
  } finally {
    db.exec('ROLLBACK');
  }
  try {
    flushRecordDurability(db);
  } catch (error) {
    disposeIntakeStateCopyPlan(plan);
    throw error;
  }
  return plan;
}

function assertUnpublished(
  db: Database,
  plan: IntakeStateCopyPlan,
  publication: IntakeCopyPublicationReader,
): void {
  if (!currentTransactionToken(db) || !db.isTransaction)
    invalid('copy installation requires application transaction');
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
    plan.targetProfileId
  )
    invalid('copy target owner');
  if (hasTransactionDurability(db) || recordDurabilityStatus(db))
    invalid('copy target durability attached');
  if (
    intakeCopyNativeSelect(
      db,
      "SELECT 1 FROM main.sqlite_schema WHERE name GLOB '__record_*' LIMIT 1",
    ).get()
  )
    invalid('copy target retained accepted history');
  if (
    !publication ||
    publication.profileId !== plan.targetProfileId ||
    typeof publication.readSelectedHead !== 'function' ||
    publication.readSelectedHead() !== null
  )
    invalid('copy target published/backend identity');
}
function assertInventory(
  db: Database,
  manifest: IntakeStateManifest,
  table: 'source' | 'prepared',
): void {
  const expected = manifest.rows(table);
  for (const row of intakeCopyNativeSelect(
    db,
    "SELECT key,value FROM main.app_meta WHERE key GLOB 'intake_state_*' ORDER BY key",
  ).iterate()) {
    const next = expected.next();
    if (next.done || next.value.key !== row.key || next.value.value !== row.value)
      invalid('copy target inventory conflict');
  }
  if (!expected.next().done) invalid('copy target partial inventory');
}
function assertOriginals(
  db: Database,
  data: PlanData,
  targetProfileId: string,
  transferredDetails = false,
): void {
  const expected = data.manifest.db.prepare('SELECT id,value FROM originals ORDER BY id').iterate();
  for (const row of intakeCopyNativeSelect(
    db,
    "SELECT id FROM main.source_files WHERE kind='intake_original' ORDER BY id",
  ).iterate()) {
    const next = expected.next();
    if (next.done || next.value.id !== row.id) invalid('copy target original inventory');
  }
  if (!expected.next().done) invalid('copy target missing original');
  for (const saved of data.manifest.db.prepare('SELECT * FROM originals ORDER BY id').iterate()) {
    const original = savedOriginal(saved, data.manifest, !transferredDetails);
    const row = intakeCopyNativeSelect(
      db,
      transferredDetails
        ? 'SELECT id,kind,sha256,path,provider_id,bytes,mime_type,coverage_status,batch_id FROM main.source_files WHERE id=?'
        : 'SELECT * FROM main.source_files WHERE id=?',
    ).get(original.id);
    const path =
      `data/profiles/${targetProfileId}/` +
      original.path.slice(`data/profiles/${data.sourceProfileId}/`.length);
    if (
      !row ||
      row.kind !== original.kind ||
      row.sha256 !== original.sha256 ||
      row.path !== path ||
      (!transferredDetails && row.details_json !== original.detailsJson)
    )
      invalid('copy target original conflict');
    for (const name of Object.keys(original.preserved)) {
      if (row[name] !== original.preserved[name as keyof IntakeCopyOriginal['preserved']])
        invalid('copy target original fields');
    }
    const pin = db
      .prepare('SELECT value FROM app_meta WHERE key=?')
      .get(intakeSourcePinKey(original.id))?.value;
    if ((pin === undefined ? null : pin) !== original.sourcePin)
      invalid('copy target source pin conflict');
  }
}

/** Stage in the caller transaction before the target's first real accepted publication. */
export function stageIntakeStateCopy(
  db: Database,
  plan: IntakeStateCopyPlan,
  publication: IntakeCopyPublicationReader,
): Readonly<{ namespaces: number; preparedRows: number }> {
  try {
    const data = plans.get(plan);
    if (!data) invalid('unrecognized copy plan');
    assertUnpublished(db, plan, publication);
    if (data.manifest.fingerprint() !== data.fingerprint)
      invalid('copy manifest bytes/completeness');
    if (data.transfer) {
      const active = activeTransfers.get(plan),
        token = currentTransactionToken(db);
      if (!active || !token || active.db !== db || active.token !== token)
        invalid('copy transfer target interval');
      assertIntakeCopyTransferTarget(active.view, data.transfer, db, token);
      assertOriginals(db, data, plan.targetProfileId, true);
      active.view.assertOriginalDetails();
      active.view.assertInventory('source');
      active.view.applyState();
      assertOriginals(db, data, plan.targetProfileId, true);
      active.view.assertOriginalDetails();
      active.view.assertInventory('prepared');
    } else {
      assertOriginals(db, data, plan.targetProfileId);
      assertInventory(db, data.manifest, 'source');
      for (const row of data.manifest.rows('source'))
        db.prepare('DELETE FROM app_meta WHERE key=? AND value=?').run(row.key, row.value);
      for (const row of data.manifest.rows('prepared'))
        db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(row.key, row.value);
      assertOriginals(db, data, plan.targetProfileId);
      assertInventory(db, data.manifest, 'prepared');
    }
    if (data.manifest.fingerprint() !== data.fingerprint)
      invalid('copy manifest bytes/completeness');
    assertUnpublished(db, plan, publication);
    return Object.freeze({
      namespaces: plan.counters.namespaces,
      preparedRows: plan.counters.preparedRows,
    });
  } catch (error) {
    if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
    throw error;
  }
}
