/** Internal authenticated pages for the existing selected intake owner. No SQL,
 * authority selection or public mutation capability lives in this codec. */
import {
  decode,
  digest,
  exact,
  hash,
  integer,
  invalid,
  type IntakeStateIdentity,
} from './intake-state-evidence.ts';
import { recordIntakePeak, recordIntakeWork } from './intake-work-accounting.ts';

export const INTAKE_TREE_PAGE_BYTES = 32 * 1024;
export const INTAKE_TREE_VALUE_BYTES = 8 * 1024;
export const INTAKE_TREE_KEY_BYTES = 1024;
export interface IntakeTreeRef {
  hash: string;
  count: number;
  height: number;
  first: string;
  last: string;
}
export type IntakeTreeRoot = IntakeTreeRef | null;
export interface IntakeTreeNode {
  format: 'health-intake-node-v4';
  identity: IntakeStateIdentity;
  key: string;
  value: string;
  left: IntakeTreeRoot;
  right: IntakeTreeRoot;
}
export function intakeTreeKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || Buffer.byteLength(key) > INTAKE_TREE_KEY_BYTES)
    invalid('collection key');
}
export function intakeTreeRef(raw: unknown): asserts raw is IntakeTreeRoot {
  if (raw === null) return;
  exact(raw, ['hash', 'count', 'height', 'first', 'last']);
  hash(raw.hash);
  integer(raw.count, 1);
  integer(raw.height, 1);
  if (Number(raw.height) > 64 || Number(raw.height) > Number(raw.count)) invalid('tree height');
  intakeTreeKey(raw.first);
  intakeTreeKey(raw.last);
  if (raw.first > raw.last) invalid('tree range');
}
const count = (ref: IntakeTreeRoot) => ref?.count ?? 0;
const height = (ref: IntakeTreeRoot) => ref?.height ?? 0;
function reference(node: IntakeTreeNode, sha: string): IntakeTreeRef {
  const size = count(node.left) + count(node.right) + 1;
  integer(size, 1);
  if (node.left && node.left.last >= node.key) invalid('left tree order');
  if (node.right && node.right.first <= node.key) invalid('right tree order');
  if (Math.abs(height(node.left) - height(node.right)) > 1) invalid('tree balance');
  const ref = {
    hash: sha,
    count: size,
    height: Math.max(height(node.left), height(node.right)) + 1,
    first: node.left?.first ?? node.key,
    last: node.right?.last ?? node.key,
  };
  intakeTreeRef(ref);
  return ref;
}
export function decodeIntakeTreeNode(
  raw: unknown,
  ref: IntakeTreeRef,
  identity: IntakeStateIdentity,
): IntakeTreeNode {
  intakeTreeRef(ref);
  const node = decode(raw, INTAKE_TREE_PAGE_BYTES);
  exact(node, ['format', 'identity', 'key', 'value', 'left', 'right']);
  if (
    node.format !== 'health-intake-node-v4' ||
    JSON.stringify(node.identity) !== JSON.stringify(identity)
  )
    invalid('tree source binding');
  intakeTreeKey(node.key);
  if (typeof node.value !== 'string' || Buffer.byteLength(node.value) > INTAKE_TREE_VALUE_BYTES)
    invalid('tree value bytes');
  intakeTreeRef(node.left);
  intakeTreeRef(node.right);
  const result = node as unknown as IntakeTreeNode;
  const actual = reference(result, digest(raw as string));
  if (JSON.stringify(actual) !== JSON.stringify(ref)) invalid('tree reference agreement');
  return result;
}
/** A private synchronous read invocation owns provisional pages. Only its
 * successful final authority check can seal them for another invocation. */
export interface IntakeTreeReadCertificate {
  readonly witness: string;
  readonly registry: object;
  readonly epoch: object;
  state: 'active' | 'sealed' | 'expired';
}
export interface IntakeTreeCachedNode {
  raw: string;
  node: IntakeTreeNode;
  certificate?: IntakeTreeReadCertificate;
}
export function createIntakeTree(
  identity: IntakeStateIdentity,
  read: (hash: string) => unknown,
  cache: Map<string, IntakeTreeCachedNode>,
  readProof?: {
    certificate: IntakeTreeReadCertificate;
    check: () => void;
  },
) {
  const pending = new Map<string, { raw: string; node: IntakeTreeNode }>();
  let preparedBytes = 0;
  const load = (ref: IntakeTreeRef): IntakeTreeNode => {
    const staged = pending.get(ref.hash);
    if (staged) return staged.node;
    readProof?.check();
    const cached = cache.get(ref.hash);
    const certificate = readProof?.certificate;
    const reusable =
      certificate &&
      cached?.certificate &&
      (cached.certificate === certificate ||
        (cached.certificate.state === 'sealed' &&
          cached.certificate.witness === certificate.witness &&
          cached.certificate.registry === certificate.registry &&
          cached.certificate.epoch === certificate.epoch));
    const raw = reusable ? cached.raw : read(ref.hash);
    if (reusable) recordIntakeWork('collectionNodeCacheHits');
    else {
      recordIntakeWork('collectionNodeReads');
      if (typeof raw === 'string') recordIntakeWork('collectionReadBytes', Buffer.byteLength(raw));
    }
    readProof?.check();
    if (cached && cached.raw === raw) {
      if (JSON.stringify(cached.node.identity) !== JSON.stringify(identity))
        invalid('cached tree source binding');
      // Every hit still checks all authenticated summaries and source binding.
      if (JSON.stringify(reference(cached.node, ref.hash)) !== JSON.stringify(ref))
        invalid('cached tree reference');
      cache.delete(ref.hash);
      // Never mutate another invocation's token or promote a transaction read.
      cache.set(ref.hash, { raw: cached.raw, node: cached.node, certificate });
      return cached.node;
    }
    const node = decodeIntakeTreeNode(raw, ref, identity);
    cache.set(ref.hash, { raw: raw as string, node, certificate });
    if (cache.size > 128) cache.delete(cache.keys().next().value!);
    return node;
  };
  const make = (
    key: string,
    value: string,
    left: IntakeTreeRoot,
    right: IntakeTreeRoot,
  ): IntakeTreeRef => {
    intakeTreeKey(key);
    if (typeof value !== 'string' || Buffer.byteLength(value) > INTAKE_TREE_VALUE_BYTES)
      invalid('collection value bytes');
    const node: IntakeTreeNode = {
      format: 'health-intake-node-v4',
      identity,
      key,
      value,
      left,
      right,
    };
    const raw = JSON.stringify(node);
    if (Buffer.byteLength(raw) > INTAKE_TREE_PAGE_BYTES) invalid('collection page bytes');
    const ref = reference(node, digest(raw));
    if (!pending.has(ref.hash)) {
      preparedBytes += Buffer.byteLength(raw);
      if (preparedBytes > 8 * 1024 * 1024) invalid('collection preparation bytes');
      pending.set(ref.hash, { raw, node });
      recordIntakeWork('collectionPreparedBytes', Buffer.byteLength(raw));
      recordIntakePeak('collectionPeakPreparedBytes', preparedBytes);
    }
    return ref;
  };
  const balance = (
    key: string,
    value: string,
    left: IntakeTreeRoot,
    right: IntakeTreeRoot,
  ): IntakeTreeRef => {
    if (height(left) > height(right) + 1) {
      const l = load(left!);
      if (height(l.left) >= height(l.right))
        return make(l.key, l.value, l.left, make(key, value, l.right, right));
      const middle = load(l.right!);
      return make(
        middle.key,
        middle.value,
        make(l.key, l.value, l.left, middle.left),
        make(key, value, middle.right, right),
      );
    }
    if (height(right) > height(left) + 1) {
      const r = load(right!);
      if (height(r.right) >= height(r.left))
        return make(r.key, r.value, make(key, value, left, r.left), r.right);
      const middle = load(r.left!);
      return make(
        middle.key,
        middle.value,
        make(key, value, left, middle.left),
        make(r.key, r.value, middle.right, r.right),
      );
    }
    return make(key, value, left, right);
  };
  const get = (root: IntakeTreeRoot, key: string): string | undefined => {
    intakeTreeKey(key);
    for (let ref = root; ref;) {
      const node = load(ref);
      if (key === node.key) return node.value;
      ref = key < node.key ? node.left : node.right;
    }
    return undefined;
  };
  /** Count exact keys strictly below a boundary using authenticated subtree
   * summaries. At most one root-to-leaf path is read; no value list is built. */
  const rank = (root: IntakeTreeRoot, key: string): number => {
    intakeTreeKey(key);
    let result = 0;
    for (let ref = root; ref;) {
      const node = load(ref);
      if (key <= node.key) ref = node.left;
      else {
        result += count(node.left) + 1;
        ref = node.right;
      }
    }
    return result;
  };
  const preceding = (
    root: IntakeTreeRoot,
    key: string,
  ): { key: string; value: string } | undefined => {
    intakeTreeKey(key);
    let found: { key: string; value: string } | undefined;
    for (let ref = root; ref;) {
      const node = load(ref);
      if (node.key >= key) ref = node.left;
      else {
        found = { key: node.key, value: node.value };
        ref = node.right;
      }
    }
    return found;
  };
  const put = (root: IntakeTreeRoot, key: string, value: string | null): IntakeTreeRoot => {
    intakeTreeKey(key);
    if (!root) return value === null ? null : make(key, value, null, null);
    const node = load(root);
    if (key === node.key) {
      if (value === node.value) return root;
      if (value !== null) return make(key, value, node.left, node.right);
      if (!node.left) return node.right;
      if (!node.right) return node.left;
      let next = load(node.right);
      while (next.left) next = load(next.left);
      return balance(next.key, next.value, node.left, put(node.right, next.key, null));
    }
    const left = key < node.key ? put(node.left, key, value) : node.left;
    const right = key > node.key ? put(node.right, key, value) : node.right;
    if (left === node.left && right === node.right) return root;
    return balance(node.key, node.value, left, right);
  };
  function* entries(
    root: IntakeTreeRoot,
    after?: string,
  ): Generator<{ key: string; value: string }> {
    if (after !== undefined) intakeTreeKey(after);
    const stack: IntakeTreeNode[] = [];
    let ref = root;
    while (ref || stack.length) {
      while (ref) {
        const node = load(ref);
        if (after !== undefined && node.key <= after) ref = node.right;
        else {
          stack.push(node);
          ref = node.left;
        }
      }
      const node = stack.pop();
      if (!node) break;
      yield { key: node.key, value: node.value };
      ref = node.right;
    }
  }
  function* writes(
    roots: IntakeTreeRoot[],
    embedded: (value: string) => IntakeTreeRoot[] = () => [],
  ): Generator<{ hash: string; raw: string; ref: IntakeTreeRef }> {
    const visited = new Set<string>(); // bounded by this preparation's byte budget
    const walk = function* (
      ref: IntakeTreeRoot,
    ): Generator<{ hash: string; raw: string; ref: IntakeTreeRef }> {
      if (!ref || visited.has(ref.hash)) return;
      const node = pending.get(ref.hash);
      if (!node) return;
      visited.add(ref.hash);
      yield* walk(node.node.left);
      yield* walk(node.node.right);
      for (const child of embedded(node.node.value)) yield* walk(child);
      yield { hash: ref.hash, raw: node.raw, ref };
    };
    for (const root of roots) yield* walk(root);
  }
  return { get, rank, preceding, put, entries, writes, load };
}
