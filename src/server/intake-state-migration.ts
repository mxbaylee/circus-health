/** Explicit supported-v3 bridge proof. This is one-time compatibility work,
 * never a V4 point-read path or a license to reset retained evidence. */
import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { Database } from './database.ts';
import {
  HEAD_BYTES,
  intakeNamespace,
  limits,
  parseIntakeHead,
  parseIntakeCollectionHead,
  reconstructIntakeEvidence,
  integer,
  invalid,
  type IntakeStateIdentity,
  type IntakeCollectionHead,
} from './intake-state-evidence.ts';
import { createIntakeTree } from './intake-state-tree.ts';
import {
  parseIntakeCollectionDescriptor,
  parseIntakeStoredValue,
  parseIntakeCollectionHistory,
  parseIntakeCollectionReceipt,
} from './intake-state-collections.ts';
import {
  validateIntakeEnvelopeRepresentation,
  readIntakeEnvelopeMaterialized,
} from './intake-authority.ts';
import {
  createIntakeEnvelopeGraphReader,
  iterateSchemaEnvelopeText,
  validateIntakeCollectionEnvelopeRepresentationSteps,
} from './intake-collection-envelope.ts';
import { intakeSourcePinKey } from './intake-source-pin.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';

declare const proofBrand: unique symbol;
export interface IntakeLegacyBridgeProof {
  readonly [proofBrand]: true;
}
export interface IntakeLegacyBridgeBinding {
  identity: IntakeStateIdentity;
  beforeHead: string;
  afterHead: string;
  sourcePin: string | undefined;
  detailsJson: string;
  writes: readonly { key: string; value: string }[];
}
interface ProofData {
  db: Database;
  binding: string;
}
const proofs = new WeakMap<IntakeLegacyBridgeProof, ProofData>();
const retained = new WeakMap<Database, Set<IntakeLegacyBridgeProof>>();
export const INTAKE_LEGACY_BRIDGE_CONTROL = JSON.stringify({
  format: 'health-intake-collection-envelope-v1',
  mode: 'legacy',
});
export function legacyIntakeEnvelopeDomainVersion(value: unknown): number {
  let envelope = value;
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).join(',') === 'raw'
  ) {
    const raw = Reflect.get(value, 'raw');
    if (typeof raw !== 'string') invalid('legacy envelope raw text');
    try {
      envelope = JSON.parse(raw);
    } catch {
      invalid('legacy envelope raw JSON');
    }
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
    invalid('legacy envelope');
  const intake: unknown = Reflect.get(envelope, 'intake');
  if (!intake || typeof intake !== 'object' || Array.isArray(intake)) invalid('legacy intake');
  const version: unknown = Reflect.get(intake, 'version');
  integer(version);
  return version;
}
export function validateLegacyIntakeEnvelope(detailsJson: string, value: unknown) {
  const validated = validateIntakeEnvelopeRepresentation(detailsJson, value);
  return { ...validated, domainVersion: legacyIntakeEnvelopeDomainVersion(validated.value) };
}
/** Shared with cold graph/copy validation after the node graph is authenticated. */
export function validateIntakeLegacyBridgeControl(
  identity: IntakeStateIdentity,
  head: IntakeCollectionHead,
  readNode: (hash: string) => unknown,
): void {
  if (head.logical.root?.count !== 1) invalid('legacy bridge logical directory');
  const tree = createIntakeTree(identity, readNode, new Map());
  const entry = tree.load(head.logical.root);
  if (entry.key !== 'envelope.control') invalid('legacy bridge control directory');
  const descriptor = parseIntakeCollectionDescriptor(entry.value);
  if (
    !descriptor ||
    descriptor.kind !== 'map' ||
    descriptor.root?.count !== 1 ||
    descriptor.bytes !== Buffer.byteLength(INTAKE_LEGACY_BRIDGE_CONTROL)
  )
    invalid('legacy bridge control collection');
  const control = tree.load(descriptor.root);
  if (control.key !== 'representation') invalid('legacy bridge control key');
  const value = parseIntakeStoredValue(control.value);
  if (value.kind !== 'inline' || value.text !== INTAKE_LEGACY_BRIDGE_CONTROL)
    invalid('legacy bridge control representation');
}
function certificate(binding: IntakeLegacyBridgeBinding): string {
  const digest = createHash('sha256');
  digest.update(
    JSON.stringify([
      binding.identity,
      binding.beforeHead,
      binding.afterHead,
      binding.sourcePin ?? null,
      binding.detailsJson,
    ]),
  );
  const writes = [...binding.writes].sort((a, b) => a.key.localeCompare(b.key));
  for (const row of writes) digest.update(JSON.stringify([row.key, row.value]));
  return digest.digest('hex');
}
export function clearIntakeLegacyBridgeProofs(db: Database): void {
  for (const proof of retained.get(db) ?? []) proofs.delete(proof);
  retained.delete(db);
}
export function prepareIntakeLegacyBridgeProof(
  db: Database,
  candidate: Pick<IntakeLegacyBridgeBinding, 'identity' | 'beforeHead' | 'afterHead' | 'writes'>,
): IntakeLegacyBridgeProof {
  return withIntakeWork(db, 'reconstruction', () => {
    const { identity, beforeHead, afterHead, writes } = candidate;
    const prefix = intakeNamespace(identity),
      headKey = prefix + 'head';
    const get = (key: string) =>
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
    if (
      !db.isOpen ||
      db.isTransaction ||
      get('owner_profile_id') !== identity.profileId ||
      get(headKey) !== beforeHead
    )
      invalid('legacy bridge current owner/head');
    const durability = recordDurabilityStatus(db);
    if (!durability?.configured || durability.dirty) invalid('legacy bridge accepted authority');
    const source = db
      .prepare('SELECT kind,sha256,details_json FROM source_files WHERE id=?')
      .get(identity.intakeId);
    if (
      !source ||
      source.kind !== 'intake_original' ||
      source.sha256 !== identity.sourceHash ||
      typeof source.details_json !== 'string'
    )
      invalid('legacy bridge source');
    const legacyHead = parseIntakeHead(beforeHead, identity, limits());
    if (!legacyHead) invalid('legacy bridge missing v3 head');
    const legacy = reconstructIntakeEvidence(identity, limits(), legacyHead, get);
    for (const row of db.prepare('SELECT key FROM app_meta WHERE key GLOB ?').iterate(prefix + '*'))
      if (typeof row.key !== 'string' || !legacy.consumed.has(row.key))
        invalid('legacy bridge unselected v3 evidence');
    const envelope = validateLegacyIntakeEnvelope(source.details_json, legacy.value);
    const head = parseIntakeCollectionHead(afterHead, identity);
    if (
      !head ||
      head.storageSequence !== 1 ||
      head.logical.domainVersion !== envelope.domainVersion ||
      head.builds !== null
    )
      invalid('legacy bridge initial selection');
    if (writes.length > 4096) invalid('legacy bridge write count');
    const rows = new Map<string, string>();
    let bytes = 0;
    for (const row of writes) {
      bytes += Buffer.byteLength(row.key) + Buffer.byteLength(row.value);
      if (
        rows.has(row.key) ||
        bytes > 8 * 1024 * 1024 ||
        Buffer.byteLength(row.value) > (row.key === headKey ? HEAD_BYTES : 32 * 1024)
      )
        invalid('legacy bridge write budget');
      if (
        row.key !== headKey &&
        (!row.key.startsWith(prefix + 'node:') ||
          !/^[a-f0-9]{64}$/.test(row.key.slice((prefix + 'node:').length)))
      )
        invalid('legacy bridge write key');
      rows.set(row.key, row.value);
    }
    if (rows.get(headKey) !== afterHead) invalid('legacy bridge selected write');
    const consumed = new Set<string>([headKey]);
    const readNode = (hash: string) => {
      const key = prefix + 'node:' + hash;
      consumed.add(key);
      return rows.get(key);
    };
    validateIntakeLegacyBridgeControl(identity, head, readNode);
    const tree = createIntakeTree(identity, readNode, new Map());
    const historyRoot = tree.load(head.history!);
    if (historyRoot.key !== '0000000000000001') invalid('legacy bridge history sequence');
    const history = parseIntakeCollectionHistory(historyRoot.value, identity);
    if (
      !history.previous ||
      history.previous.format !== 'health-intake-legacy-v3' ||
      JSON.stringify(history.previous.head) !== beforeHead ||
      JSON.stringify(history.logical) !== JSON.stringify(head.logical) ||
      history.builds !== null
    )
      invalid('legacy bridge history edge');
    const receiptRoot = tree.load(head.receipts!);
    if (receiptRoot.key !== history.operationId) invalid('legacy bridge receipt operation');
    const receipt = parseIntakeCollectionReceipt(receiptRoot.value, identity, history.operationId);
    if (
      receipt.result.changed ||
      receipt.result.storageSequence !== 1 ||
      JSON.stringify(receipt.result.logical) !== JSON.stringify(head.logical)
    )
      invalid('legacy bridge result');
    if (consumed.size !== rows.size || [...rows.keys()].some((key) => !consumed.has(key)))
      invalid('legacy bridge disconnected candidate evidence');
    const pin = get(intakeSourcePinKey(identity.intakeId));
    if (pin !== undefined && typeof pin !== 'string') invalid('legacy bridge source pin');
    const binding = certificate({
      ...candidate,
      detailsJson: source.details_json,
      sourcePin: pin as string | undefined,
    });
    const proof = Object.freeze({}) as IntakeLegacyBridgeProof;
    let entries = retained.get(db);
    if (!entries) {
      entries = new Set();
      retained.set(db, entries);
    }
    while (entries.size >= 8) {
      const old = entries.values().next().value!;
      entries.delete(old);
      proofs.delete(old);
    }
    entries.add(proof);
    proofs.set(proof, { db, binding });
    return proof;
  });
}
/** Consumed in the maintenance factory. The transaction separately rechecks all
 * current source/head bindings and exact captured writes before acknowledgement. */
export function verifyIntakeLegacyBridgeProof(
  proof: IntakeLegacyBridgeProof,
  db: Database,
  binding: IntakeLegacyBridgeBinding,
): void {
  const retainedProof = proofs.get(proof);
  proofs.delete(proof);
  retained.get(db)?.delete(proof);
  if (!retainedProof || retainedProof.db !== db || retainedProof.binding !== certificate(binding))
    invalid('foreign, expired or conflicting legacy bridge proof');
}

/** Final format-only adoption. The caller supplies a private prepared candidate;
 * equivalence is recomputed from authenticated graph nodes, never a caller hash. */
export function prepareIntakeSchemaAdoptionProof(
  db: Database,
  candidate: Omit<IntakeLegacyBridgeBinding, 'sourcePin' | 'detailsJson'>,
): IntakeLegacyBridgeProof {
  const steps = prepareIntakeSchemaAdoptionProofSteps(db, candidate);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
export async function prepareIntakeSchemaAdoptionProofAsync(
  db: Database,
  candidate: Omit<IntakeLegacyBridgeBinding, 'sourcePin' | 'detailsJson'>,
  options: { assertRunning?: () => void } = {},
): Promise<IntakeLegacyBridgeProof> {
  const steps = prepareIntakeSchemaAdoptionProofSteps(db, candidate),
    key = intakeNamespace(candidate.identity) + 'head';
  try {
    for (;;) {
      options.assertRunning?.();
      if (
        db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value !==
        candidate.beforeHead
      )
        invalid('schema adoption changed during verification');
      const next = withIntakeWork(db, 'reconstruction', () => steps.next());
      if (next.done) return next.value;
      withIntakeWork(db, 'reconstruction', () => recordIntakeWork('schemaCertificationYields'));
      await setImmediate();
    }
  } finally {
    steps.return(undefined as never);
  }
}
function* prepareIntakeSchemaAdoptionProofSteps(
  db: Database,
  candidate: Omit<IntakeLegacyBridgeBinding, 'sourcePin' | 'detailsJson'>,
): Generator<void, IntakeLegacyBridgeProof> {
  let work = 0;
  const { identity, beforeHead, afterHead, writes } = candidate,
    prefix = intakeNamespace(identity),
    headKey = prefix + 'head',
    readMeta = db.prepare('SELECT value FROM app_meta WHERE key=?');
  const get = (key: string) => readMeta.get(key)?.value;
  if (
    db.isTransaction ||
    get(headKey) !== beforeHead ||
    get('owner_profile_id') !== identity.profileId
  )
    invalid('schema adoption current owner/head');
  const initialPin = get(intakeSourcePinKey(identity.intakeId));
  const status = recordDurabilityStatus(db);
  if (!status?.configured || status.dirty) invalid('schema adoption accepted authority');
  const source = db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(identity.intakeId);
  if (
    !source ||
    source.kind !== 'intake_original' ||
    source.sha256 !== identity.sourceHash ||
    typeof source.details_json !== 'string'
  )
    invalid('schema adoption source');
  const before = parseIntakeCollectionHead(beforeHead, identity),
    after = parseIntakeCollectionHead(afterHead, identity);
  if (
    !before ||
    !after ||
    after.storageSequence !== before.storageSequence + 1 ||
    after.logical.domainVersion !== before.logical.domainVersion ||
    JSON.stringify(after.builds) !== JSON.stringify(before.builds)
  )
    invalid('schema adoption selection');
  const beforeRead = (hash: string) => get(prefix + 'node:' + hash),
    beforeTree = createIntakeTree(identity, beforeRead, new Map()),
    schemaBefore = beforeTree.get(before.logical.root, 'envelope.data') !== undefined;
  const priorHash = createHash('sha256');
  let priorBytes = 0,
    priorMode: 'raw' | 'normalized';
  if (schemaBefore) {
    const prior = createIntakeEnvelopeGraphReader(identity, before, beforeRead);
    priorMode = prior.control.mode;
    for (const piece of iterateSchemaEnvelopeText(prior.store, prior.control)) {
      recordIntakeWork('schemaCertificationChunks');
      if (++work % 64 === 0) yield;
      priorHash.update(piece);
      priorBytes += Buffer.byteLength(piece);
      recordIntakeWork('schemaCertificationHashedBytes', Buffer.byteLength(piece));
    }
  } else {
    const prior = readIntakeEnvelopeMaterialized(
      db,
      source as unknown as import('./intake-authority.ts').IntakeEnvelopeSource,
    );
    priorMode = prior.mode;
    priorBytes = Buffer.byteLength(prior.text);
    priorHash.update(prior.text);
    recordIntakeWork('schemaCertificationHashedBytes', priorBytes);
  }
  const rows = new Map<string, string>();
  let bytes = 0;
  if (writes.length > 4096) invalid('schema adoption write count');
  for (const row of writes) {
    bytes += Buffer.byteLength(row.key) + Buffer.byteLength(row.value);
    if (
      rows.has(row.key) ||
      bytes > 8 * 1024 * 1024 ||
      Buffer.byteLength(row.value) > (row.key === headKey ? 4096 : 32768) ||
      (row.key !== headKey &&
        (!row.key.startsWith(prefix + 'node:') ||
          !/^[a-f0-9]{64}$/.test(row.key.slice((prefix + 'node:').length))))
    )
      invalid('schema adoption candidate rows');
    rows.set(row.key, row.value);
  }
  if (rows.get(headKey) !== afterHead) invalid('schema adoption selected row');
  const read = (hash: string) => rows.get(prefix + 'node:' + hash) ?? get(prefix + 'node:' + hash),
    tree = createIntakeTree(identity, read, new Map());
  if (schemaBefore) {
    if (after.logical.root?.count !== before.logical.root?.count)
      invalid('schema upgrade logical directory count');
    for (const entry of beforeTree.entries(before.logical.root)) {
      if (++work % 64 === 0) yield;
      if (entry.key !== 'envelope.data' && tree.get(after.logical.root, entry.key) !== entry.value)
        invalid('schema upgrade changed another logical collection');
    }
  } else if (after.logical.root?.count !== 2) invalid('schema adoption logical directory');
  const data = parseIntakeCollectionDescriptor(tree.get(after.logical.root, 'envelope.data'));
  if (!data || data.kind !== 'map') invalid('schema adoption data');
  // Data must be a complete already selected auxiliary map, not a fabricated
  // reference introduced by the final acknowledgement.
  let adopted = false;
  for (const entry of tree.entries(before.builds)) {
    if (++work % 64 === 0) yield;
    const descriptor = parseIntakeCollectionDescriptor(entry.value);
    if (JSON.stringify(descriptor) === JSON.stringify(data)) {
      adopted = true;
      break;
    }
  }
  if (!adopted) invalid('schema adoption unselected build');
  const graph = createIntakeEnvelopeGraphReader(identity, after, read),
    hash = createHash('sha256');
  let total = 0;
  for (const chunk of iterateSchemaEnvelopeText(graph.store, graph.control)) {
    recordIntakeWork('schemaCertificationChunks');
    if (++work % 64 === 0) yield;
    hash.update(chunk);
    total += Buffer.byteLength(chunk);
    recordIntakeWork('schemaCertificationHashedBytes', Buffer.byteLength(chunk));
  }
  if (
    graph.control.mode !== priorMode ||
    total !== priorBytes ||
    hash.digest('hex') !== priorHash.digest('hex')
  )
    invalid('schema adoption export equivalence');
  yield* validateIntakeCollectionEnvelopeRepresentationSteps(source.details_json, after, read);
  const historyRaw = tree.get(after.history, String(after.storageSequence).padStart(16, '0'));
  if (historyRaw === undefined) invalid('schema adoption history');
  const event = parseIntakeCollectionHistory(historyRaw, identity);
  if (
    JSON.stringify(event.previous) !== beforeHead ||
    JSON.stringify(event.logical) !== JSON.stringify(after.logical) ||
    JSON.stringify(event.builds) !== JSON.stringify(after.builds)
  )
    invalid('schema adoption history edge');
  const receiptRaw = tree.get(after.receipts, event.operationId);
  if (receiptRaw === undefined) invalid('schema adoption receipt');
  const receipt = parseIntakeCollectionReceipt(receiptRaw, identity, event.operationId);
  if (
    receipt.result.storageSequence !== after.storageSequence ||
    JSON.stringify(receipt.result.logical) !== JSON.stringify(after.logical)
  )
    invalid('schema adoption receipt result');
  // Only final path nodes may be new. Traverse candidate-only edges using the
  // strict node grammar; existing accepted subtrees need no history-wide scan.
  const consumed = new Set<string>([headKey]);
  const visit = (
    root: import('./intake-state-tree.ts').IntakeTreeRoot,
    kind: 'directory' | 'values' | 'history' | 'receipts',
  ) => {
    if (!root) return;
    const key = prefix + 'node:' + root.hash;
    if (!rows.has(key) || consumed.has(key)) return;
    consumed.add(key);
    const node = tree.load(root);
    visit(node.left, kind);
    visit(node.right, kind);
    if (kind === 'directory') {
      const descriptor = parseIntakeCollectionDescriptor(node.value);
      if (descriptor) visit(descriptor.root, 'values');
    } else if (kind === 'values') {
      const value = parseIntakeStoredValue(node.value);
      if (value.kind === 'bytes') visit(value.root, 'values');
    } else if (kind === 'receipts') {
      const item = parseIntakeCollectionReceipt(node.value, identity, node.key);
      visit(item.result.logical.root, 'directory');
    } else {
      const item = parseIntakeCollectionHistory(node.value, identity);
      visit(item.logical.root, 'directory');
      visit(item.builds, 'directory');
    }
  };
  visit(after.logical.root, 'directory');
  visit(after.builds, 'directory');
  visit(after.receipts, 'receipts');
  visit(after.history, 'history');
  if (consumed.size !== rows.size) invalid('schema adoption disconnected writes');
  const finalSource = db
    .prepare('SELECT kind,sha256,details_json FROM source_files WHERE id=?')
    .get(identity.intakeId);
  if (
    get(headKey) !== beforeHead ||
    get('owner_profile_id') !== identity.profileId ||
    finalSource?.kind !== source.kind ||
    finalSource?.sha256 !== source.sha256 ||
    finalSource?.details_json !== source.details_json ||
    get(intakeSourcePinKey(identity.intakeId)) !== initialPin
  )
    invalid('schema adoption source/head changed during verification');
  const pin = get(intakeSourcePinKey(identity.intakeId));
  if (pin !== undefined && typeof pin !== 'string') invalid('schema adoption source pin');
  const binding = certificate({
      ...candidate,
      detailsJson: source.details_json,
      sourcePin: pin as string | undefined,
    }),
    proof = Object.freeze({}) as IntakeLegacyBridgeProof;
  let entries = retained.get(db);
  if (!entries) {
    entries = new Set();
    retained.set(db, entries);
  }
  while (entries.size >= 8) {
    const old = entries.values().next().value!;
    entries.delete(old);
    proofs.delete(old);
  }
  entries.add(proof);
  proofs.set(proof, { db, binding });
  return proof;
}
