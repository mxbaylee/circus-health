import { randomUUID } from 'node:crypto';
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
import { intakeEnvelopeMode, validateIntakeEnvelopeRepresentation } from './intake-authority.ts';
import { applyIntakeChanges, serializeIntakeJson } from './intake-state-codec.ts';
import {
  DEFAULT_LIMITS,
  HEAD_BYTES,
  budget,
  decode,
  digest,
  exact,
  frameIntakeChanges,
  intakeNamespace,
  integer,
  invalid,
  limits,
  parseIntakeHead,
  reconstructIntakeEvidence,
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
  reconstructedStateBytes: number;
  bootstrapCopyBytes: number;
  decodedNodes: number;
  decodedOperations: number;
  decodedStringWork: number;
  preparedRows: number;
  preparedBytes: number;
  preparedFrameBytes: number;
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
type Options = { limits?: Partial<IntakePreparationLimits>; production?: boolean };
interface PlanData {
  snapshot: IntakeStateCopySnapshot;
  prepared: Array<{ key: string; value: string }>;
  caps: IntakePreparationLimits;
}
const plans = new WeakMap<IntakeStateCopyPlan, PlanData>();

function preparationLimits(options: Options): IntakePreparationLimits {
  const raw = options.limits ?? {};
  if (Object.keys(raw).some((name) => !Object.hasOwn(PREPARATION_LIMITS, name)))
    invalid('preparation limit key');
  const caps = { ...PREPARATION_LIMITS, ...raw };
  for (const name of Object.keys(caps) as Array<keyof IntakePreparationLimits>) {
    integer(caps[name], 1);
    if (caps[name] > PREPARATION_LIMITS[name]) invalid('raised preparation limit');
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
function sourceSize(original: IntakeCopyOriginal): number {
  return Buffer.byteLength(JSON.stringify(original));
}
function rowSize(row: { key: string; value: string }): number {
  return Buffer.byteLength(row.key) + Buffer.byteLength(row.value);
}
function assertTotals(rows: number, bytes: number, caps: IntakePreparationLimits): void {
  if (rows > caps.rows || bytes > caps.bytes) invalid('aggregate preparation rows/bytes');
}
function validateOriginal(raw: IntakeCopyOriginal, profileId: string): IntakeCopyOriginal {
  exact(raw, ['id', 'kind', 'sha256', 'path', 'detailsJson', 'sourcePin', 'preserved']);
  validateIntakeIdentity({
    profileId,
    intakeId: raw.id as string,
    sourceHash: raw.sha256 as string,
  });
  if (raw.kind !== 'intake_original') invalid('copy original kind');
  ownedPath(raw.path, profileId);
  if (typeof raw.detailsJson !== 'string') invalid('copy original envelope');
  const envelope = decode(raw.detailsJson, PREPARATION_LIMITS.bytes);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
    invalid('copy original envelope');
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

function inspectSnapshot(
  snapshot: IntakeStateCopySnapshot,
  targetProfileId: string | undefined,
  options: Options,
): IntakeStateCopyPlan | undefined {
  exact(snapshot, ['sourceProfileId', 'originals', 'rows']);
  if (targetProfileId !== undefined) profiles(snapshot.sourceProfileId, targetProfileId);
  else if (!validProfileId(snapshot.sourceProfileId)) invalid('copy profile identity');
  if (!Array.isArray(snapshot.originals) || !Array.isArray(snapshot.rows)) invalid('copy snapshot');
  const caps = preparationLimits(options);
  if (snapshot.originals.length + snapshot.rows.length > caps.rows)
    invalid('aggregate preparation rows/bytes');
  const sourceProfileId = snapshot.sourceProfileId;
  const captured: IntakeStateCopySnapshot = { sourceProfileId, originals: [], rows: [] };
  const originals = new Map<string, IntakeCopyOriginal>();
  const buckets = new Map<string, Map<string, string>>();
  const counters: IntakeCopyCounters = {
    namespaces: 0,
    sourceRows: 0,
    sourceBytes: 0,
    reconstructedStateBytes: 0,
    bootstrapCopyBytes: 0,
    decodedNodes: 0,
    decodedOperations: 0,
    decodedStringWork: 0,
    preparedRows: 0,
    preparedBytes: 0,
    preparedFrameBytes: 0,
    preparedHeadBytes: 0,
    preparedReceiptBytes: 0,
  };
  for (const original of snapshot.originals) {
    // Charge encoded raw input before parsing or retaining an additional copy.
    counters.sourceRows++;
    counters.sourceBytes += sourceSize(original);
    assertTotals(counters.sourceRows, counters.sourceBytes, caps);
    const validated = validateOriginal(original, sourceProfileId);
    if (options.production) intakeEnvelopeMode(validated.detailsJson);
    if (originals.has(validated.id)) invalid('duplicate copy original');
    originals.set(validated.id, validated);
    captured.originals.push(validated);
  }
  for (const raw of snapshot.rows) {
    exact(raw, ['key', 'value']);
    if (typeof raw.key !== 'string' || typeof raw.value !== 'string') invalid('copy inventory row');
    counters.sourceRows++;
    counters.sourceBytes += rowSize(raw);
    assertTotals(counters.sourceRows, counters.sourceBytes, caps);
    const match = /^intake_state_v1:([0-9a-f]{64}):(head|(?:frame|operation):[0-9a-f-]{36})$/.exec(
      raw.key,
    );
    if (!match) invalid('unsupported copy namespace');
    const prefix = `intake_state_v1:${match[1]}:`;
    let bucket = buckets.get(prefix);
    if (!bucket) {
      if (buckets.size >= caps.namespaces) invalid('aggregate preparation namespaces');
      bucket = new Map();
      buckets.set(prefix, bucket);
    }
    if (bucket.has(raw.key)) invalid('duplicate copy contribution');
    bucket.set(raw.key, raw.value);
    captured.rows.push({ key: raw.key, value: raw.value });
  }
  counters.namespaces = buckets.size;
  const prepared: Array<{ key: string; value: string }> = [];
  const chainCaps = limits();
  for (const [prefix, bucket] of buckets) {
    const rawHead = bucket.get(`${prefix}head`);
    if (rawHead === undefined) invalid('missing copy head');
    const header = decode(rawHead, HEAD_BYTES);
    if (!header || typeof header !== 'object' || Array.isArray(header)) invalid('copy head');
    const identity = validateIntakeIdentity({
      profileId: sourceProfileId,
      intakeId: Reflect.get(header, 'intakeId'),
      sourceHash: Reflect.get(header, 'sourceHash'),
    });
    if (
      Reflect.get(header, 'profileId') !== sourceProfileId ||
      intakeNamespace(identity) !== prefix
    )
      invalid('copy namespace identity');
    const original = originals.get(identity.intakeId);
    if (!original || original.sha256 !== identity.sourceHash)
      invalid('copy original identity/hash');
    const head = parseIntakeHead(rawHead, identity, chainCaps)!;
    const remainingCaps = {
      ...chainCaps,
      nodes: caps.nodes - counters.decodedNodes,
      operations: caps.operations - counters.decodedOperations,
      stringWork: caps.stringWork - counters.decodedStringWork,
    };
    if (
      head.usage.nodes > remainingCaps.nodes ||
      head.usage.operations > remainingCaps.operations ||
      head.usage.stringWork > remainingCaps.stringWork
    )
      invalid('aggregate preparation decoded work');
    // Constrain the actual decoder too: a forged smaller usage claim must not
    // buy a default-sized decode before final usage agreement rejects it.
    const basis = reconstructIntakeEvidence(identity, remainingCaps, head, (key) =>
      bucket.get(key),
    );
    if (
      basis.consumed.size !== bucket.size ||
      [...bucket.keys()].some((key) => !basis.consumed.has(key))
    )
      invalid('unselected copy contribution');
    counters.decodedNodes += head.usage.nodes;
    counters.decodedOperations += head.usage.operations;
    counters.decodedStringWork += head.usage.stringWork;
    if (
      counters.decodedNodes > caps.nodes ||
      counters.decodedOperations > caps.operations ||
      counters.decodedStringWork > caps.stringWork
    )
      invalid('aggregate preparation decoded work');
    const serialized = serializeIntakeJson(basis.value);
    if (options.production) validateIntakeEnvelopeRepresentation(original.detailsJson, basis.value);
    counters.reconstructedStateBytes += Buffer.byteLength(serialized);
    if (counters.reconstructedStateBytes > caps.bytes) invalid('aggregate reconstructed bytes');
    if (targetProfileId === undefined) continue;
    const targetIdentity = { ...identity, profileId: targetProfileId };
    const changes = [{ op: 'set', path: [], value: basis.value }];
    const remaining = budget(chainCaps, {
      bytes: 0,
      frames: 0,
      nodes: 0,
      operations: 0,
      stringWork: 0,
    });
    const applied = applyIntakeChanges(undefined, changes, remaining);
    counters.bootstrapCopyBytes += Buffer.byteLength(serialized);
    if (serializeIntakeJson(applied) !== serialized) invalid('copy serialization');
    const evidence = frameIntakeChanges(
      targetIdentity,
      changes,
      digest(serialized),
      randomUUID(),
      chainCaps,
      undefined,
      remaining,
    );
    const targetPrefix = intakeNamespace(targetIdentity);
    const receiptKey = `${targetPrefix}operation:${evidence.result.operationId}`;
    const rows = [
      ...evidence.frames.map((frame) => ({ key: frame.key, value: frame.serialized })),
      { key: receiptKey, value: evidence.receipt },
      { key: `${targetPrefix}head`, value: evidence.serializedHead },
    ];
    for (const row of rows) {
      counters.preparedRows++;
      counters.preparedBytes += rowSize(row);
      assertTotals(
        counters.sourceRows + counters.preparedRows,
        counters.sourceBytes + counters.preparedBytes,
        caps,
      );
      prepared.push(row);
    }
    counters.preparedFrameBytes += evidence.frames.reduce(
      (sum, row) => sum + Buffer.byteLength(row.serialized),
      0,
    );
    counters.preparedHeadBytes += Buffer.byteLength(evidence.serializedHead);
    counters.preparedReceiptBytes += Buffer.byteLength(evidence.receipt);
  }
  if (options.production)
    for (const original of originals.values())
      if (
        !buckets.has(
          intakeNamespace({
            profileId: sourceProfileId,
            intakeId: original.id,
            sourceHash: original.sha256,
          }),
        )
      )
        invalid('missing production intake authority');
  if (targetProfileId === undefined) return;
  const plan: IntakeStateCopyPlan = Object.freeze({
    format: 'health-intake-state-copy-v1',
    sourceProfileId,
    targetProfileId,
    counters: Object.freeze(counters),
  });
  plans.set(plan, { snapshot: captured, prepared, caps });
  return plan;
}

function capture(
  db: Database,
  sourceProfileId: string,
  caps: IntakePreparationLimits,
): IntakeStateCopySnapshot {
  const snapshot: IntakeStateCopySnapshot = { sourceProfileId, originals: [], rows: [] };
  let count = 0,
    bytes = 0;
  for (const row of db
    .prepare("SELECT * FROM source_files WHERE kind='intake_original' ORDER BY id")
    .iterate()) {
    const sourcePin = db
      .prepare('SELECT value FROM app_meta WHERE key=?')
      .get(intakeSourcePinKey(String(row.id)))?.value;
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
    bytes += sourceSize(original);
    assertTotals(++count, bytes, caps);
    snapshot.originals.push(original);
  }
  for (const row of db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_*' ORDER BY key")
    .iterate()) {
    if (typeof row.key !== 'string' || typeof row.value !== 'string') invalid('copy inventory row');
    const contribution = { key: row.key, value: row.value };
    bytes += rowSize(contribution);
    assertTotals(++count, bytes, caps);
    snapshot.rows.push(contribution);
  }
  return snapshot;
}

/** Read-only bounded capture; the caller must independently certify selected publication. */
export function captureIntakeStateCopySnapshot(
  db: Database,
  sourceProfileId: string,
  options: Options = {},
): IntakeStateCopySnapshot {
  return capture(db, sourceProfileId, preparationLimits(options));
}

/** Validate selected SQL evidence before runtime attachment/first publication.
 * The caller independently certifies its genuine selected durability backend. */
export function validateProductionIntakeAuthority(db: Database, profileId?: string): void {
  const owner = db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value;
  if (typeof owner !== 'string' || (profileId !== undefined && owner !== profileId))
    invalid('production intake owner');
  validateProductionIntakeStateCopySnapshot(captureIntakeStateCopySnapshot(db, owner));
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
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
    sourceProfileId
  )
    invalid('copy source owner');
  flushRecordDurability(db);
  const caps = preparationLimits(options);
  let snapshot: IntakeStateCopySnapshot;
  db.exec('BEGIN');
  try {
    snapshot = capture(db, sourceProfileId, caps);
    flushRecordDurability(db);
  } finally {
    db.exec('ROLLBACK');
  }
  const plan = prepareIntakeStateCopySnapshot(snapshot, targetProfileId, options);
  flushRecordDurability(db);
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
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name GLOB '__record_*' LIMIT 1").get())
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
  rows: Array<{ key: string; value: string }>,
  caps: IntakePreparationLimits,
): void {
  const expected = new Map(rows.map((row) => [row.key, row.value]));
  let count = 0,
    bytes = 0;
  for (const row of db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_*'")
    .iterate()) {
    if (typeof row.key !== 'string' || typeof row.value !== 'string')
      invalid('copy target contribution');
    bytes += rowSize({ key: row.key, value: row.value });
    assertTotals(++count, bytes, caps);
    if (expected.get(row.key) !== row.value) invalid('copy target inventory conflict');
    expected.delete(row.key);
  }
  if (expected.size || count !== rows.length) invalid('copy target partial inventory');
}
function assertOriginals(db: Database, data: PlanData, targetProfileId: string): void {
  const ids = new Set(data.snapshot.originals.map((original) => original.id));
  let count = 0;
  for (const row of db
    .prepare("SELECT id FROM source_files WHERE kind='intake_original'")
    .iterate()) {
    if (++count > data.caps.rows || typeof row.id !== 'string' || !ids.delete(row.id))
      invalid('copy target original inventory');
  }
  if (ids.size) invalid('copy target missing original');
  for (const original of data.snapshot.originals) {
    const row = db.prepare('SELECT * FROM source_files WHERE id=?').get(original.id);
    const path =
      `data/profiles/${targetProfileId}/` +
      original.path.slice(`data/profiles/${data.snapshot.sourceProfileId}/`.length);
    if (
      !row ||
      row.kind !== original.kind ||
      row.sha256 !== original.sha256 ||
      row.path !== path ||
      row.details_json !== original.detailsJson
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
    assertOriginals(db, data, plan.targetProfileId);
    assertInventory(db, data.snapshot.rows, data.caps);
    for (const row of data.snapshot.rows)
      db.prepare('DELETE FROM app_meta WHERE key=? AND value=?').run(row.key, row.value);
    for (const row of data.prepared)
      db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(row.key, row.value);
    assertOriginals(db, data, plan.targetProfileId);
    assertInventory(db, data.prepared, data.caps);
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
