/** Bounded V5 carry-forest codec. Not selected-head, source, session or publication authority.
 * A complete suffix proof is mathematical codec evidence only. The owning integration must
 * authenticate its V4 base, external logical/build graphs, current storage and publication.
 * Storage admission, acceptance and recovery remain owned by their existing modules. */
import { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Database } from './database.ts';
import type { RecordIntakeLogPublication } from './record-versions.ts';
import { setImmediate } from 'node:timers/promises';
import {
  decode,
  digest as repoDigest,
  exact,
  hash,
  integer,
  invalid,
  uuid,
  validateIntakeIdentity,
  parseIntakeCollectionHeadV4,
  intakeNamespace,
  type IntakeStateIdentity,
  type IntakeCollectionHeadV4,
} from './intake-state-evidence.ts';
import { intakeTreeRef, type IntakeTreeRoot } from './intake-state-tree.ts';

export const hashWork = { calls: 0, bytes: 0 };
function digest(raw: string): string {
  hashWork.calls++;
  hashWork.bytes += Buffer.byteLength(raw);
  return repoDigest(raw);
}
export const FORMAT = 'health-intake-state-v5';
export const NODE_FORMAT = 'health-intake-state-log-node-v1';
const nodeBudget = 1_000_000;
const operationBudget = 1_000_000;
const indexBytesPerRow = 36 + 64 + 8; // logical UUID, leaf hash and safe sequence, not allocated RAM
// A prefix retains exactly 3N-popcount(N) immutable log rows. An anchor adds
// another row. This is the largest suffix that can fit the unchanged node cap.
let lowerRows = 0,
  upperRows = nodeBudget;
while (lowerRows < upperRows) {
  const candidate = Math.ceil((lowerRows + upperRows) / 2);
  const peaks = candidate.toString(2).replaceAll('0', '').length;
  if (3 * candidate - peaks <= nodeBudget) lowerRows = candidate;
  else upperRows = candidate - 1;
}
const indexRowBudget = lowerRows;
const indexKeyBudget = indexRowBudget * indexBytesPerRow;
// Round three times the logical key budget to a power-of-two page ceiling.
// The measured ordered/permuted layouts fit; this is an allocation bound,
// not a proof that every SQLite layout fits. Native SQLITE_FULL stays fatal
// to the derivative and cannot discard a genuinely accepted receipt.
const indexPageBudget = 2 ** Math.ceil(Math.log2((3 * indexKeyBudget) / 4096));
export const CAPS = Object.freeze({
  nodeBytes: 32768,
  eventBytes: 8192,
  headBytes: 4096,
  nodes: nodeBudget,
  events: operationBudget,
  bytes: 256 * 1024 * 1024,
  preparationBytes: 8 * 1024 * 1024,
  indexRows: indexRowBudget,
  indexKeyBytes: indexKeyBudget,
  indexPages: indexPageBudget,
});
export type Limits = { [K in keyof typeof CAPS]: number };
export type Ref = { hash: string; first: number; count: number };
export type Head = {
  format: typeof FORMAT;
  identity: IntakeStateIdentity;
  base: string | null;
  baseSequence: number;
  storageSequence: number;
  count: number;
  logical: Logical;
  builds: IntakeTreeRoot;
  peaks: string | null;
};
export type Logical = IntakeCollectionHeadV4['logical'];
export type Event = {
  receipt: {
    format: 'health-intake-state-receipt-v4';
    requestDigest: string;
    result: {
      format: 'health-intake-state-result-v4';
      intakeId: string;
      operationId: string;
      storageSequence: number;
      logical: Logical;
      changed: boolean;
    };
  };
  transition: {
    format: 'health-intake-state-log-transition-v1';
    operationId: string;
    previous: Head;
    logical: Logical;
    builds: IntakeTreeRoot;
  };
};
type Envelope = { format: typeof NODE_FORMAT; identity: IntakeStateIdentity };
type Body =
  | { kind: 'anchor'; v4Head: string }
  | { kind: 'leaf'; event: Event }
  | { kind: 'merge'; left: Ref; right: Ref }
  | { kind: 'peak'; tree: Ref; older: string | null };
type Node = Envelope & Body;
export type Get = (hash: string) => unknown;
export type Write = { hash: string; raw: string };
export type Preparation = { head: string; writes: Write[]; bytes: number; payloadBytes: number };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function caps(options: Partial<Limits> = {}): Limits {
  exact({ ...CAPS, ...options }, Object.keys(CAPS));
  const result = { ...CAPS, ...options };
  for (const key of Object.keys(CAPS) as (keyof Limits)[]) {
    integer(result[key], 1);
    if (result[key] > CAPS[key]) invalid('raised log limit');
  }
  return result;
}
function checkedAdd(a: number, b: number): number {
  const sum = a + b;
  integer(sum);
  return sum;
}
function nullableHash(value: unknown): asserts value is string | null {
  if (value !== null) hash(value);
}
function canonical(raw: unknown, max: number): Record<string, unknown> {
  const value = decode(raw, max);
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value) !== raw)
    invalid('canonical JSON');
  return value as Record<string, unknown>;
}
function scope(
  value: Record<string, unknown>,
  identity: IntakeStateIdentity,
  format: string = FORMAT,
) {
  if (
    value.format !== format ||
    !same(validateIntakeIdentity(value.identity as IntakeStateIdentity), identity)
  )
    invalid('log identity');
}
function logical(value: unknown): asserts value is Logical {
  exact(value, ['root', 'domainVersion']);
  intakeTreeRef(value.root);
  integer(value.domainVersion);
}
function reference(value: unknown): asserts value is Ref {
  exact(value, ['hash', 'first', 'count']);
  hash(value.hash);
  integer(value.first, 1);
  integer(value.count, 1);
  if (
    (BigInt(Number(value.count)) & (BigInt(Number(value.count)) - 1n)) !== 0n ||
    Number(value.count) > 2 ** 52
  )
    invalid('perfect-tree size');
  checkedAdd(Number(value.first), Number(value.count) - 1);
}
export function parseHead(
  raw: unknown,
  identity: IntakeStateIdentity,
  options: Partial<Limits> = {},
): Head {
  const limit = caps(options),
    value = canonical(raw, limit.headBytes);
  exact(value, [
    'format',
    'identity',
    'base',
    'baseSequence',
    'storageSequence',
    'count',
    'logical',
    'builds',
    'peaks',
  ]);
  scope(value, validateIntakeIdentity(identity));
  logical(value.logical);
  intakeTreeRef(value.builds);
  nullableHash(value.base);
  nullableHash(value.peaks);
  integer(value.baseSequence);
  integer(value.count);
  if (
    (value.base === null && value.baseSequence !== 0) ||
    (value.count === 0) !== (value.peaks === null) ||
    Number(value.count) > limit.events
  )
    invalid('log head counts');
  if (checkedAdd(Number(value.baseSequence), Number(value.count)) !== value.storageSequence)
    invalid('log storage sequence');
  return value as unknown as Head;
}
function checkEvent(
  raw: unknown,
  identity: IntakeStateIdentity,
  limit: Limits,
): asserts raw is Event {
  exact(raw, ['receipt', 'transition']);
  if (Buffer.byteLength(JSON.stringify(raw)) > limit.eventBytes) invalid('event bytes');
  const receipt = raw.receipt;
  exact(receipt, ['format', 'requestDigest', 'result']);
  hash(receipt.requestDigest);
  if (receipt.format !== 'health-intake-state-receipt-v4') invalid('receipt format');
  const result = receipt.result;
  exact(result, ['format', 'intakeId', 'operationId', 'storageSequence', 'logical', 'changed']);
  if (
    result.format !== 'health-intake-state-result-v4' ||
    result.intakeId !== identity.intakeId ||
    typeof result.changed !== 'boolean'
  )
    invalid('receipt result');
  uuid(result.operationId);
  integer(result.storageSequence, 1);
  logical(result.logical);
  const transition = raw.transition;
  exact(transition, ['format', 'operationId', 'previous', 'logical', 'builds']);
  if (
    transition.format !== 'health-intake-state-log-transition-v1' ||
    transition.operationId !== result.operationId ||
    !same(transition.logical, result.logical)
  )
    invalid('receipt transition agreement');
  parseHead(JSON.stringify(transition.previous), identity, limit);
  logical(transition.logical);
  intakeTreeRef(transition.builds);
}
function decodeNode(raw: unknown, key: string, identity: IntakeStateIdentity, limit: Limits): Node {
  hash(key);
  const value = canonical(raw, limit.nodeBytes);
  scope(value, identity, NODE_FORMAT);
  if (digest(raw as string) !== key) invalid('node hash');
  if (value.kind === 'anchor') {
    exact(value, ['format', 'identity', 'kind', 'v4Head']);
    if (!parseIntakeCollectionHeadV4(value.v4Head, identity)) invalid('anchor head');
  } else if (value.kind === 'leaf') {
    exact(value, ['format', 'identity', 'kind', 'event']);
    checkEvent(value.event, identity, limit);
  } else if (value.kind === 'merge') {
    exact(value, ['format', 'identity', 'kind', 'left', 'right']);
    reference(value.left);
    reference(value.right);
    if (
      value.left.count !== value.right.count ||
      checkedAdd(Number(value.left.first), Number(value.left.count)) !== value.right.first
    )
      invalid('merge contiguity');
    checkedAdd(Number(value.left.count), Number(value.right.count));
  } else if (value.kind === 'peak') {
    exact(value, ['format', 'identity', 'kind', 'tree', 'older']);
    reference(value.tree);
    nullableHash(value.older);
  } else invalid('node kind');
  return value as unknown as Node;
}
const emptyHead = (
  identity: IntakeStateIdentity,
  base: string | null = null,
  baseSequence = 0,
): Head => ({
  format: FORMAT,
  identity: validateIntakeIdentity(identity),
  base,
  baseSequence,
  storageSequence: baseSequence,
  count: 0,
  logical: { root: null, domainVersion: 0 },
  builds: null,
  peaks: null,
});
function serializeHead(head: Head, limit: Limits): string {
  const raw = JSON.stringify(head);
  parseHead(raw, head.identity, limit);
  return raw;
}
function writer(identity: IntakeStateIdentity, limit: Limits) {
  const writes: Write[] = [];
  let bytes = 0,
    payloadBytes = 0;
  function put(body: Body): string {
    const node = { format: NODE_FORMAT, identity, ...body },
      raw = JSON.stringify(node),
      key = digest(raw);
    decodeNode(raw, key, identity, limit);
    bytes = checkedAdd(bytes, Buffer.byteLength(raw));
    if (bytes > limit.bytes) invalid('preparation selected bytes');
    if (bytes > limit.preparationBytes) invalid('preparation bytes');
    if (writes.length + 1 > limit.nodes) invalid('preparation nodes');
    if (body.kind === 'leaf') payloadBytes += Buffer.byteLength(JSON.stringify(body.event));
    writes.push({ hash: key, raw });
    return key;
  }
  return {
    put,
    result: (head: string): Preparation => {
      if (checkedAdd(bytes, Buffer.byteLength(head)) > limit.preparationBytes)
        invalid('whole preparation bytes');
      return freeze({ head, writes, bytes, payloadBytes });
    },
  };
}
/** A V4 anchor is opaque evidence. Its referenced V4 graph is deliberately NOT validated here. */
export function initializeIntakeLog(
  identity: IntakeStateIdentity,
  v4Head?: string,
  options: Partial<Limits> = {},
): Preparation {
  identity = validateIntakeIdentity(identity);
  const limit = caps(options),
    out = writer(identity, limit);
  if (v4Head === undefined) return out.result(serializeHead(emptyHead(identity), limit));
  const base = parseIntakeCollectionHeadV4(v4Head, identity);
  if (!base) invalid('missing V4 base');
  const key = out.put({ kind: 'anchor', v4Head } as Body);
  return out.result(
    serializeHead(
      {
        ...emptyHead(identity, key, base.storageSequence),
        logical: base.logical,
        builds: base.builds,
      },
      limit,
    ),
  );
}
type Peak = { key: string; tree: Ref; older: string | null };
function carry(
  eventRef: Ref,
  old: Peak[],
  put: ReturnType<typeof writer>['put'],
): { peak: string; frontier: Peak[] } {
  let tree = eventRef,
    cursor = 0;
  while (cursor < old.length && old[cursor]!.tree.count === tree.count) {
    const left = old[cursor]!.tree;
    const key = put({ kind: 'merge', left, right: tree } as Body);
    tree = { hash: key, first: left.first, count: checkedAdd(left.count, tree.count) };
    cursor++;
  }
  const older = old[cursor]?.key ?? null;
  const key = put({ kind: 'peak', tree, older } as Body);
  return { peak: key, frontier: [{ key, tree, older }, ...old.slice(cursor)] };
}

/** A caller-owned admission interval. This callback is NOT a codec-issued proof.
 * The integration must check physical accepted HEAD/source-pair, selected row
 * continuity, session and profile. A SQL HEAD equality check is insufficient. */
export interface Admission {
  assertCurrent(): void;
}
export type BaseLookup =
  | { kind: 'absent' }
  | { kind: 'receipt'; receipt: Event['receipt']; identity: IntakeStateIdentity };
export interface LogAdmission extends Admission {
  /** Required with an anchor, including cold duplicate checks. The caller must
   * authenticate both absence and receipt membership in this exact V4 base. */
  lookupBaseOperation?: (base: Readonly<IntakeCollectionHeadV4>, operationId: string) => BaseLookup;
}
function sync(run: () => unknown) {
  const result = run();
  if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result)
    invalid('log synchronous admission required');
}
function checkAdmission(admission: Admission) {
  if (!admission || typeof admission.assertCurrent !== 'function')
    invalid('log admission required');
  sync(() => admission.assertCurrent());
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function baseReceipt(
  base: IntakeCollectionHeadV4 | undefined,
  identity: IntakeStateIdentity,
  operationId: string,
  admission: LogAdmission,
): Event['receipt'] | undefined {
  if (!base) return undefined;
  if (!admission.lookupBaseOperation) invalid('authenticated V4 operation lookup required');
  checkAdmission(admission);
  const found = admission.lookupBaseOperation(freeze(structuredClone(base)), operationId);
  if (found && typeof found === 'object' && 'then' in found)
    invalid('log synchronous V4 lookup required');
  checkAdmission(admission);
  if (found?.kind === 'absent') {
    exact(found, ['kind']);
    return undefined;
  }
  exact(found, ['kind', 'receipt', 'identity']);
  if (found.kind !== 'receipt' || !same(validateIntakeIdentity(found.identity), identity))
    invalid('V4 lookup identity');
  const value = found.receipt;
  exact(value, ['format', 'requestDigest', 'result']);
  hash(value.requestDigest);
  const result = value.result;
  exact(result, ['format', 'intakeId', 'operationId', 'storageSequence', 'logical', 'changed']);
  logical(result.logical);
  integer(result.storageSequence, 1);
  if (
    value.format !== 'health-intake-state-receipt-v4' ||
    result.format !== 'health-intake-state-result-v4' ||
    result.intakeId !== identity.intakeId ||
    result.operationId !== operationId ||
    typeof result.changed !== 'boolean' ||
    result.storageSequence > base.storageSequence
  )
    invalid('V4 lookup receipt');
  return freeze(structuredClone(value));
}
const nativePrepare = DatabaseSync.prototype.prepare,
  nativeExec = DatabaseSync.prototype.exec,
  nativeClose = DatabaseSync.prototype.close,
  nativeGet = StatementSync.prototype.get,
  nativeRun = StatementSync.prototype.run;
// SQLite page residency of this disposable derivative, not total process RAM.
// Cached indices can retire; active operations have a separate explicit ceiling.
const residencyLimits = Object.freeze({
  activePages: 65536,
  cachedPages: 32768,
  activeIndices: 128,
  cachedIndices: 64,
  activeAdmissions: 1024,
});
export class IntakeLogResourceExhausted extends Error {
  readonly code = 'INTAKE_LOG_RESOURCE_EXHAUSTED';
  readonly retryable = true;
  constructor(resource: string, options?: ErrorOptions) {
    super(
      `Intake log ${resource} capacity exhausted; release active derivatives and retry`,
      options,
    );
  }
}
type ResidencyLimits = { [K in keyof typeof residencyLimits]: number };
declare const residencyBrand: unique symbol;
/** Optional lower resource budget, always also charged to the process ceiling.
 * This is derivative resource accounting, never storage or read authority. */
export interface IntakeLogResidency {
  readonly [residencyBrand]: true;
}
type Resident = {
  pages: number;
  state: 'active' | 'cached' | 'closed';
  held: boolean;
  retire: () => void;
};
type Residency = {
  limits: ResidencyLimits;
  members: Set<Resident>;
  retirements: number;
  admissions: number;
};
const processResidency: Residency = {
  limits: residencyLimits,
  members: new Set(),
  retirements: 0,
  admissions: 0,
};
const residencies = new WeakMap<IntakeLogResidency, Residency>();
export function createIntakeLogResidency(
  options: Partial<ResidencyLimits> = {},
): IntakeLogResidency {
  exact({ ...residencyLimits, ...options }, Object.keys(residencyLimits));
  const limits = { ...residencyLimits, ...options };
  for (const name of Object.keys(limits) as (keyof ResidencyLimits)[]) {
    integer(limits[name], 1);
    if (limits[name] > residencyLimits[name]) invalid('raised log residency limit');
  }
  const cap = Object.freeze({}) as IntakeLogResidency;
  residencies.set(cap, { limits, members: new Set(), retirements: 0, admissions: 0 });
  return cap;
}
function residency(cap?: IntakeLogResidency): Residency {
  if (!cap) return processResidency;
  const found = residencies.get(cap);
  if (!found) invalid('foreign log residency');
  return found;
}
function residencyStats(group: Residency) {
  let activePages = 0,
    cachedPages = 0,
    activeIndices = 0,
    cachedIndices = 0;
  for (const member of group.members) {
    if (member.state === 'active') {
      activePages += member.pages;
      activeIndices++;
    } else if (member.state === 'cached') {
      cachedPages += member.pages;
      cachedIndices++;
    }
  }
  return {
    activePages,
    cachedPages,
    activeIndices,
    cachedIndices,
    retirements: group.retirements,
    activeAdmissions: group.admissions,
  };
}
export function intakeLogResidencyStats(cap?: IntakeLogResidency) {
  return Object.freeze(residencyStats(residency(cap)));
}
function resident(cap?: IntakeLogResidency) {
  const local = residency(cap),
    groups = local === processResidency ? [local] : [processResidency, local];
  // This exact schema needs three pages. Reserve them before opening SQLite;
  // native max_page_count bounds every subsequent allocation, including a
  // failed insertion. Forks share this one reservation.
  const member: Resident = { pages: 3, state: 'closed', held: false, retire: () => {} };
  const allowance = () => {
    let pages = CAPS.indexPages;
    for (const group of groups) {
      const stats = residencyStats(group);
      if (stats.activeIndices + (member.state === 'active' ? 0 : 1) > group.limits.activeIndices)
        throw new IntakeLogResourceExhausted('active RAM');
      pages = Math.min(
        pages,
        group.limits.activePages -
          stats.activePages +
          (member.state === 'active' ? member.pages : 0),
      );
    }
    if (pages < member.pages) throw new IntakeLogResourceExhausted('active RAM');
    return pages;
  };
  allowance();
  member.state = 'active';
  for (const group of groups) group.members.add(member);
  const release = () => {
    member.state = 'closed';
    for (const group of groups) group.members.delete(member);
  };
  const trim = (group: Residency) => {
    for (;;) {
      const stats = residencyStats(group);
      if (
        stats.cachedPages <= group.limits.cachedPages &&
        stats.cachedIndices <= group.limits.cachedIndices
      )
        return;
      const victim = [...group.members].find((entry) => entry.state === 'cached' && !entry.held);
      if (!victim) throw new IntakeLogResourceExhausted('cached RAM');
      victim.retire();
    }
  };
  return {
    allowance,
    activate() {
      if (member.state === 'closed') invalid('log index retired');
      allowance();
      member.state = 'active';
    },
    hold() {
      member.held = true;
    },
    admission() {
      for (const group of groups)
        if (group.admissions >= group.limits.activeAdmissions)
          throw new IntakeLogResourceExhausted('active admission');
      for (const group of groups) group.admissions++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const group of groups) group.admissions--;
      };
    },
    resize(pages: number) {
      integer(pages);
      if (pages > allowance()) throw new IntakeLogResourceExhausted('active RAM');
      member.pages = pages;
    },
    cache() {
      if (member.state === 'closed') return;
      member.state = 'cached';
      for (const group of groups) {
        group.members.delete(member);
        group.members.add(member); // least recently released first
      }
      for (const group of groups) trim(group);
    },
    onRetire(action: () => void) {
      member.retire = () => {
        action();
        for (const group of groups) group.retirements++;
      };
    },
    release,
  };
}
/** Encapsulated RAM only. Never opened from a path, spilled, or reopened as evidence.
 * Completeness relies on initial verified coverage plus an unbroken private write
 * interval, not row signatures (which cannot authenticate a missing row). */
function index(limit: Limits, pool?: IntakeLogResidency) {
  const allocation = resident(pool);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(':memory:');
  } catch (error) {
    allocation.release();
    throw error;
  }
  let closed = false,
    retired = false,
    expected = 0n,
    rows = 0,
    keyBytes = 0;
  try {
    Reflect.apply(nativeExec, db, [
      `PRAGMA page_size=4096; PRAGMA temp_store=MEMORY; PRAGMA journal_mode=MEMORY; PRAGMA max_page_count=${Math.min(limit.indexPages, allocation.allowance())};
       CREATE TABLE operations(id TEXT PRIMARY KEY,sequence INTEGER NOT NULL UNIQUE,leaf TEXT NOT NULL) WITHOUT ROWID;`,
    ]);
    const prepare = (sql: string) => Reflect.apply(nativePrepare, db, [sql]) as StatementSync;
    const stamp = prepare('SELECT total_changes() n'),
      schema = prepare('PRAGMA schema_version'),
      temp = prepare('PRAGMA temp.schema_version'),
      peer = prepare('PRAGMA data_version'),
      pages = prepare('PRAGMA page_count'),
      memory = prepare('PRAGMA temp_store'),
      read = prepare('SELECT sequence,leaf FROM operations WHERE id=?'),
      insert = prepare('INSERT INTO operations VALUES(?,?,?)');
    stamp.setReadBigInts(true);
    const get = (s: StatementSync, ...args: (number | string)[]) =>
      Reflect.apply(nativeGet, s, args) as Record<string, unknown>;
    const originalSchema = get(schema).schema_version,
      originalTemp = get(temp).schema_version,
      originalPeer = get(peer).data_version;
    allocation.resize(Number(get(pages).page_count));
    const current = () => {
      if (retired) invalid('log index retired; asynchronous rebuild required');
      if (
        closed ||
        !db.isOpen ||
        db.isTransaction ||
        DatabaseSync.prototype.prepare !== nativePrepare ||
        DatabaseSync.prototype.exec !== nativeExec ||
        DatabaseSync.prototype.close !== nativeClose ||
        StatementSync.prototype.get !== nativeGet ||
        StatementSync.prototype.run !== nativeRun ||
        get(stamp).n !== expected ||
        get(schema).schema_version !== originalSchema ||
        get(temp).schema_version !== originalTemp ||
        get(peer).data_version !== originalPeer ||
        get(memory).temp_store !== 2 ||
        Number(get(pages).page_count) > limit.indexPages
      )
        invalid('log index changed or disposed');
    };
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        if (db.isOpen) Reflect.apply(nativeClose, db, []);
      } finally {
        // A failed native close must remain charged if it still owns pages.
        if (!db.isOpen) allocation.release();
      }
    };
    allocation.onRetire(() => {
      try {
        current();
      } catch (error) {
        close();
        throw error;
      }
      close();
      retired = true; // only an intact, deliberately retired interval detaches evidence
    });
    return {
      current,
      close,
      retired: () => retired,
      resident: () => !closed,
      activate() {
        current();
        allocation.activate();
      },
      admission() {
        current();
        return allocation.admission();
      },
      activateForConfirmation(): unknown {
        current();
        try {
          allocation.activate();
          return undefined;
        } catch (error) {
          // Only accounting ran above. Pin the already charged cached pages
          // until the synchronous owner seal; cleanup must follow acceptance.
          allocation.hold();
          return error;
        }
      },
      cache() {
        current();
        allocation.cache();
      },
      retire() {
        if (!closed) {
          current();
          close();
          retired = true;
        }
      },
      lookup(id: string) {
        current();
        const row = get(read, id) as { sequence: number; leaf: string } | undefined;
        current();
        return row;
      },
      insert(id: string, sequence: number, leaf: string) {
        current();
        allocation.activate();
        uuid(id);
        hash(leaf);
        integer(sequence, 1);
        if (
          rows + 1 > limit.indexRows ||
          checkedAdd(keyBytes, indexBytesPerRow) > limit.indexKeyBytes
        )
          invalid('log index capacity');
        const pageLimit = Math.min(limit.indexPages, allocation.allowance());
        Reflect.apply(nativeExec, db, [`PRAGMA max_page_count=${pageLimit}`]);
        let result;
        try {
          result = Reflect.apply(nativeRun, insert, [id, sequence, leaf]);
        } catch (error) {
          if (
            pageLimit < limit.indexPages &&
            error &&
            typeof error === 'object' &&
            'errcode' in error &&
            error.errcode === 13
          )
            throw new IntakeLogResourceExhausted('active RAM', { cause: error });
          throw error;
        } finally {
          allocation.resize(Number(get(pages).page_count));
        }
        if (result.changes !== 1) invalid('log index insert');
        expected++;
        rows++;
        keyBytes += indexBytesPerRow;
        current();
      },
      stats() {
        current();
        return {
          rows,
          keyBytes,
          pages: Number(get(pages).page_count),
          pageBytes: Number(get(pages).page_count) * 4096,
        };
      },
    };
  } catch (error) {
    try {
      if (db.isOpen) Reflect.apply(nativeClose, db, []);
    } finally {
      if (!db.isOpen) allocation.release();
    }
    throw error;
  }
}
type Index = ReturnType<typeof index>;
declare const snapshotBrand: unique symbol;
/** Immutable completeness of the appended suffix only, never admission authority. */
export interface IntakeLogSnapshot {
  readonly [snapshotBrand]: true;
}
declare const appendBrand: unique symbol;
export interface IntakeLogAppend {
  readonly [appendBrand]: true;
}
interface SnapshotData {
  raw: string;
  head: Head;
  identity: IntakeStateIdentity;
  limit: Limits;
  get: Get;
  frontier: Peak[];
  nodes: number;
  bytes: number;
  base?: IntakeCollectionHeadV4;
  index: Index;
  state: 'ready' | 'busy' | 'pending' | 'consumed' | 'closed';
  pending?: IntakeLogAppend;
  fork?: boolean;
  lease?: { epoch: object; members: Set<SnapshotData> };
  epoch?: object;
}
interface AppendData {
  before: SnapshotData;
  prepared: Readonly<Preparation>;
  event: Event;
  next: Head;
  frontier: Peak[];
  leaf: string;
  state: 'prepared' | 'confirming' | 'closed';
}
const snapshots = new WeakMap<IntakeLogSnapshot, SnapshotData>();
const appends = new WeakMap<IntakeLogAppend, AppendData>();
function closeMember(data: SnapshotData) {
  const pending = data.pending && appends.get(data.pending);
  if (pending) pending.state = 'closed';
  data.pending = undefined;
  data.state = 'closed';
}
function dispose(data: SnapshotData) {
  for (const member of data.lease?.members ?? [data]) closeMember(member);
  data.lease?.members.clear();
  data.index.close();
}
function releaseFork(data: SnapshotData) {
  closeMember(data);
  data.lease?.members.delete(data);
  if (!data.lease?.members.size) data.index.close();
}
function advanceLease(before: SnapshotData, next: SnapshotData) {
  const lease = before.lease!;
  for (const member of lease.members) if (member !== next) closeMember(member);
  lease.members.clear();
  lease.members.add(next);
  lease.epoch = {};
  next.epoch = lease.epoch;
  next.fork = false;
}
/** A refused pending integrity interval is terminal even if its mutable native
 * methods are restored later. Reentrant calls during confirmation only refuse;
 * they do not revoke the valid publication already owned by that confirmation. */
function pendingAppend(cap: IntakeLogAppend): AppendData {
  const data = appends.get(cap);
  if (
    !data ||
    data.state !== 'prepared' ||
    data.before.state !== 'pending' ||
    data.before.pending !== cap ||
    data.before.epoch !== data.before.lease?.epoch
  )
    invalid('log append unavailable');
  try {
    if (!data.before.index.retired()) data.before.index.current();
  } catch (error) {
    data.state = 'closed';
    try {
      dispose(data.before);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Log pending integrity and cleanup failed');
    }
    throw error;
  }
  return data;
}
function active(snapshot: IntakeLogSnapshot): SnapshotData {
  const data = snapshots.get(snapshot);
  if (!data || data.state !== 'ready' || data.epoch !== data.lease?.epoch)
    invalid('log snapshot unavailable');
  try {
    if (data.index.retired()) invalid('log snapshot retired; asynchronous rebuild required');
    data.index.activate();
  } catch (error) {
    if (!data.index.retired()) dispose(data);
    throw error;
  }
  return data;
}
function snapshot(data: SnapshotData): IntakeLogSnapshot {
  const cap = Object.freeze({}) as IntakeLogSnapshot;
  data.lease ??= { epoch: {}, members: new Set() };
  data.epoch = data.lease.epoch;
  data.lease.members.add(data);
  snapshots.set(cap, data);
  return cap;
}
export function disposeIntakeLogSnapshot(cap: IntakeLogSnapshot): void {
  const data = snapshots.get(cap);
  if (data && data.state !== 'consumed') {
    if (data.epoch !== data.lease?.epoch) {
      closeMember(data);
      return;
    }
    if (data.fork) releaseFork(data);
    else dispose(data);
  }
}
/** Released admissions may retain only a bounded LRU derivative. Deliberate
 * retirement keeps pending immutable preparation bytes, never replay authority. */
export function cacheIntakeLogSnapshot(cap: IntakeLogSnapshot): void {
  const data = snapshots.get(cap);
  if (!data || data.epoch !== data.lease?.epoch || !data.index.resident()) return;
  for (const member of data.lease!.members) {
    if (
      member.state === 'busy' ||
      (member.pending && appends.get(member.pending)?.state === 'confirming')
    )
      invalid('log residency operation in progress');
  }
  data.index.cache();
}
/** Mathematical residency only. It performs no storage/session admission. */
export function isIntakeLogSnapshotResident(cap: IntakeLogSnapshot): boolean {
  const data = snapshots.get(cap);
  return (
    !!data && data.state !== 'closed' && data.epoch === data.lease?.epoch && data.index.resident()
  );
}
/** Pin a mathematically complete derivative for a separately admitted operation.
 * No source/head/session authorization is created by this resource operation. */
export function activateIntakeLogSnapshot(cap: IntakeLogSnapshot): void {
  active(cap);
}
/** Bounded resource token only. Closing/replacing an index cannot release a
 * caller's token: old and new entries share the same process admission budget. */
export function holdIntakeLogSnapshot(cap: IntakeLogSnapshot): () => void {
  return active(cap).index.admission();
}
export function retireIntakeLogSnapshot(cap: IntakeLogSnapshot): void {
  const data = snapshots.get(cap);
  if (!data || data.epoch !== data.lease?.epoch || !data.index.resident()) return;
  for (const member of data.lease!.members) {
    if (
      member.state === 'busy' ||
      (member.pending && appends.get(member.pending)?.state === 'confirming')
    )
      invalid('log residency operation in progress');
  }
  data.index.retire();
}
/** Bounded alternative preparation reservations share a read-only index. The
 * first accepted promotion revokes all other branches without copying rows. */
export function forkIntakeLogSnapshot(
  cap: IntakeLogSnapshot,
  admission: Admission,
): IntakeLogSnapshot {
  const data = active(cap);
  data.state = 'busy';
  try {
    checkAdmission(admission);
    data.index.current();
    if (data.state !== 'busy' || data.lease!.members.size >= 9)
      invalid('log preparation branch capacity');
    return snapshot({ ...data, state: 'ready', pending: undefined, fork: true });
  } catch (error) {
    dispose(data);
    throw error;
  } finally {
    if (data.state === 'busy') data.state = 'ready';
  }
}
export function inspectIntakeLogSnapshot(cap: IntakeLogSnapshot, admission: Admission) {
  const data = active(cap);
  data.state = 'busy';
  try {
    checkAdmission(admission);
    const result = {
      head: data.raw,
      nodes: data.nodes,
      bytes: data.bytes,
      index: data.index.stats(),
    };
    checkAdmission(admission);
    if (data.state !== 'busy') invalid('log inspection disposed');
    data.index.current();
    return freeze(result);
  } catch (error) {
    dispose(data);
    throw error;
  } finally {
    if (data.state === 'busy') data.state = 'ready';
  }
}

function transition(event: Event, previous: Head) {
  const result = event.receipt.result;
  if (
    result.storageSequence !== checkedAdd(previous.storageSequence, 1) ||
    !same(event.transition.previous, previous)
  )
    invalid('log previous commitment');
  if (
    result.logical.domainVersion < previous.logical.domainVersion ||
    result.changed !== !same(result.logical.root, previous.logical.root) ||
    (!result.changed && result.logical.domainVersion !== previous.logical.domainVersion)
  )
    invalid('log transition semantics');
}
export interface RebuildOptions extends LogAdmission {
  limits?: Partial<Limits>;
  residency?: IntakeLogResidency;
  signal?: AbortSignal;
  /** Called after a bounded step, never with unbounded event or node arrays. */
  onEventSteps?: (event: Readonly<Event>) => Generator<void>;
  onProgress?: (
    work: Readonly<{ nodes: number; bytes: number; events: number }>,
  ) => void | Promise<void>;
}
/** Cold verification walks oldest-first with bounded recursion/frontier. Each
 * leaf/merge is counted once; each historical peak cell is checked/counts once
 * during prefix reconstruction. No complete events array or selected hash Set.
 * V4 whole-graph and external logical/build verification remain caller duties. */
export function* rebuildIntakeLogSnapshotSteps(
  rawHead: string,
  identity: IntakeStateIdentity,
  get: Get,
  options: RebuildOptions,
): Generator<Readonly<{ nodes: number; bytes: number; events: number }>, IntakeLogSnapshot> {
  identity = freeze(validateIntakeIdentity(identity));
  const limit = caps(options.limits),
    head = parseHead(rawHead, identity, limit),
    ids = index(limit, options.residency);
  let nodes = 0,
    bytes = 0,
    events = 0,
    closed = false;
  const guard = () => {
    options.signal?.throwIfAborted();
    checkAdmission(options);
    ids.current();
  };
  const read = (key: string, count = true) => {
    guard();
    const raw = get(key);
    if (typeof raw !== 'string') invalid('missing selected log node');
    if (count) {
      nodes = checkedAdd(nodes, 1);
      bytes = checkedAdd(bytes, Buffer.byteLength(raw));
      if (nodes > limit.nodes || bytes > limit.bytes) invalid('selected log limits');
    }
    return decodeNode(raw, key, identity, limit);
  };
  let base: IntakeCollectionHeadV4 | undefined;
  const frontier: Peak[] = [];
  function* steps(): Generator<Event | undefined, Head> {
    if (head.base) {
      const anchor = read(head.base);
      if (anchor.kind !== 'anchor') invalid('log anchor kind');
      base = parseIntakeCollectionHeadV4(anchor.v4Head, identity)!;
      if (base.storageSequence !== head.baseSequence || !options.lookupBaseOperation)
        invalid('log V4 anchor lookup/sequence');
      yield;
    }
    let cursor = head.peaks,
      end = head.storageSequence,
      size = 0,
      total = 0;
    while (cursor) {
      const key = cursor,
        cell = read(key, false);
      if (
        cell.kind !== 'peak' ||
        cell.tree.count <= size ||
        checkedAdd(cell.tree.first, cell.tree.count - 1) !== end
      )
        invalid('log peak shape');
      frontier.push({ key, tree: cell.tree, older: cell.older });
      if (frontier.length > 53) invalid('log peak depth');
      size = cell.tree.count;
      total = checkedAdd(total, size);
      end = cell.tree.first - 1;
      cursor = cell.older;
      yield;
    }
    if (total !== head.count || end !== head.baseSequence) invalid('log peak coverage');
    let prefix = {
      ...emptyHead(identity, head.base, head.baseSequence),
      logical: base?.logical ?? { root: null, domainVersion: 0 },
      builds: base?.builds ?? null,
    };
    let prefixFrontier: Peak[] = [];
    function* walk(ref: Ref, depth = 0): Generator<Event | undefined, void> {
      if (depth > 52) invalid('log tree depth');
      const node = read(ref.hash);
      yield;
      if (node.kind === 'merge') {
        if (
          ref.first !== node.left.first ||
          ref.count !== checkedAdd(node.left.count, node.right.count)
        )
          invalid('log merge reference');
        yield* walk(node.left, depth + 1);
        yield* walk(node.right, depth + 1);
      } else if (node.kind === 'leaf') {
        const event = node.event;
        if (ref.count !== 1 || event.receipt.result.storageSequence !== ref.first)
          invalid('log leaf reference');
        transition(event, prefix);
        ids.insert(event.receipt.result.operationId, ref.first, ref.hash);
        yield event; // driver checks authenticated base absence before proceeding
        const reconstruct = (body: Body) => {
          const raw = JSON.stringify({ format: NODE_FORMAT, identity, ...body }),
            key = digest(raw);
          if (body.kind === 'peak') {
            const historical = read(key);
            if (!same(historical, JSON.parse(raw))) invalid('log historical peak');
          }
          return key;
        };
        const next = carry(ref, prefixFrontier, reconstruct);
        prefixFrontier = next.frontier;
        prefix = {
          ...prefix,
          count: prefix.count + 1,
          storageSequence: ref.first,
          logical: event.receipt.result.logical,
          builds: event.transition.builds,
          peaks: next.peak,
        };
        events++;
        yield;
      } else invalid('log tree kind');
    }
    for (const peak of [...frontier].reverse()) yield* walk(peak.tree);
    if (!same(prefix, head)) invalid('log selected prefix agreement');
    return head;
  }
  const generator = steps();
  try {
    guard();
    let quantum = 0;
    for (;;) {
      guard();
      const step = generator.next();
      guard();
      if (step.done) break;
      if (step.value && baseReceipt(base, identity, step.value.receipt.result.operationId, options))
        invalid('log duplicate V4 operation');
      if (step.value && options.onEventSteps) {
        for (const _ of options.onEventSteps(freeze(structuredClone(step.value)))) {
          void _;
          guard();
          yield freeze({ nodes, bytes, events });
          guard();
        }
      }
      guard();
      if (++quantum === 16) {
        quantum = 0;
        yield freeze({ nodes, bytes, events });
        guard();
      }
    }
    guard();
    const result = snapshot({
      raw: rawHead,
      head,
      identity,
      limit,
      get,
      frontier,
      nodes,
      bytes,
      base,
      index: ids,
      state: 'ready',
    });
    closed = true;
    return result;
  } finally {
    generator.return(head);
    if (!closed) ids.close();
  }
}
/** Async admission driver; all synchronous callers must obtain this cold proof first. */
export async function rebuildIntakeLogSnapshot(
  rawHead: string,
  identity: IntakeStateIdentity,
  get: Get,
  options: RebuildOptions,
): Promise<IntakeLogSnapshot> {
  const steps = rebuildIntakeLogSnapshotSteps(rawHead, identity, get, options);
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      checkAdmission(options);
      const next = steps.next();
      if (next.done) return next.value;
      await options.onProgress?.(next.value);
      checkAdmission(options);
      await setImmediate();
      checkAdmission(options);
    }
  } finally {
    steps.return(undefined as never);
  }
}
/** The anchor's exact V4 selection; validation of its complete graph is owning work. */
export function intakeLogBaseHead(
  head: Head,
  identity: IntakeStateIdentity,
  get: Get,
): IntakeCollectionHeadV4 | undefined {
  if (!head.base) return undefined;
  const node = decodeNode(get(head.base), head.base, identity, caps());
  if (node.kind !== 'anchor') invalid('log anchor kind');
  const base = parseIntakeCollectionHeadV4(node.v4Head, identity)!;
  if (base.storageSequence !== head.baseSequence) invalid('log anchor sequence');
  return base;
}
/** Authenticate the selected commitment roots on ordinary projection reads.
 * Descendant admission still requires the complete cooperative verifier. */
export function authenticateIntakeLogHeadRoots(
  head: Head,
  identity: IntakeStateIdentity,
  get: Get,
): void {
  const limit = caps();
  if (head.base) {
    const node = decodeNode(get(head.base), head.base, identity, limit);
    if (node.kind !== 'anchor') invalid('log anchor root');
  }
  if (head.peaks) {
    const node = decodeNode(get(head.peaks), head.peaks, identity, limit);
    if (node.kind !== 'peak') invalid('log peak root');
  }
}
/** Bounded codec-only candidate extension check. This authenticates the carry
 * transition and exact new codec rows; it does not prove accepted publication. */
export function verifyIntakeLogExtension(
  beforeRaw: string | undefined,
  afterRaw: string,
  identity: IntakeStateIdentity,
  get: Get,
): Readonly<{ event: Event; writes: readonly Write[] }> {
  const limit = caps(),
    after = parseHead(afterRaw, identity),
    initial =
      beforeRaw === undefined ||
      Reflect.get(decode(beforeRaw, limit.headBytes) as object, 'format') !== FORMAT
        ? initializeIntakeLog(identity, beforeRaw)
        : undefined;
  const previous = parseHead(initial?.head ?? beforeRaw!, identity),
    frontier: Peak[] = [];
  let cursor = previous.peaks,
    size = 0,
    end = previous.storageSequence;
  while (cursor) {
    const cell = decodeNode(get(cursor), cursor, identity, limit);
    if (
      cell.kind !== 'peak' ||
      cell.tree.count <= size ||
      cell.tree.first + cell.tree.count - 1 !== end ||
      frontier.length >= 53
    )
      invalid('extension previous frontier');
    frontier.push({ key: cursor, tree: cell.tree, older: cell.older });
    size = cell.tree.count;
    end = cell.tree.first - 1;
    cursor = cell.older;
  }
  if (end !== previous.baseSequence) invalid('extension previous coverage');
  const event = readIntakeLogSequence(afterRaw, identity, get, after.storageSequence, {
    assertCurrent: () => {},
  });
  transition(event, previous);
  const out = writer(identity, limit),
    leaf = out.put({ kind: 'leaf', event }),
    carried = carry(
      { hash: leaf, first: event.receipt.result.storageSequence, count: 1 },
      frontier,
      out.put,
    );
  const expected = {
    ...previous,
    count: previous.count + 1,
    storageSequence: event.receipt.result.storageSequence,
    logical: event.receipt.result.logical,
    builds: event.transition.builds,
    peaks: carried.peak,
  };
  if (!same(expected, after)) invalid('extension selected head');
  const prepared = out.result(serializeHead(expected, limit)),
    writes = [...(initial?.writes ?? []), ...prepared.writes];
  for (const row of writes)
    if (get(row.hash) !== row.raw) invalid('extension missing/substituted node');
  return freeze({ event, writes });
}
/** Faithful streaming copy: the caller authenticates/rebinds every external graph and
 * the complete V4 anchor. Codec-owned commitments and full previous heads are rebuilt. */
export function* rebindIntakeLogSteps(
  rawHead: string,
  identity: IntakeStateIdentity,
  get: Get,
  target: IntakeStateIdentity,
  options: RebuildOptions & {
    rebindBaseSteps(base: Readonly<IntakeCollectionHeadV4>): Generator<void, string>;
    rebindEventSteps(
      event: Readonly<Event>,
    ): Generator<void, { logical: Logical; builds: IntakeTreeRoot }>;
    write(hash: string, raw: string): void;
  },
): Generator<Readonly<{ nodes: number; bytes: number; events: number }>, string> {
  const source = parseHead(rawHead, identity, options.limits),
    limit = caps(options.limits);
  const base = intakeLogBaseHead(source, identity, get);
  let reboundBase: string | undefined;
  const work = { nodes: 0, bytes: 0, events: 0 };
  if (base) {
    const steps = options.rebindBaseSteps(freeze(structuredClone(base)));
    for (;;) {
      checkAdmission(options);
      const next = steps.next();
      if (next.done) {
        reboundBase = next.value;
        break;
      }
      yield freeze({ ...work });
    }
    const checked = parseIntakeCollectionHeadV4(reboundBase, target);
    if (
      !checked ||
      checked.storageSequence !== base.storageSequence ||
      checked.logical.domainVersion !== base.logical.domainVersion
    )
      invalid('rebound V4 anchor semantics');
  }
  const initial = initializeIntakeLog(target, reboundBase, options.limits);
  for (const row of initial.writes) options.write(row.hash, row.raw);
  let head = parseHead(initial.head, target, options.limits),
    frontier: Peak[] = [];
  const steps = rebuildIntakeLogSnapshotSteps(rawHead, identity, get, {
    ...options,
    *onEventSteps(event) {
      yield* options.onEventSteps?.(event) ?? [];
      const rebound = yield* options.rebindEventSteps(event);
      logical(rebound.logical);
      intakeTreeRef(rebound.builds);
      if (
        rebound.logical.domainVersion !== event.receipt.result.logical.domainVersion ||
        (rebound.logical.root === null) !== (event.receipt.result.logical.root === null)
      )
        invalid('rebound log logical semantics');
      const next: Event = {
        receipt: {
          ...event.receipt,
          result: { ...event.receipt.result, intakeId: target.intakeId, logical: rebound.logical },
        },
        transition: {
          ...event.transition,
          previous: head,
          logical: rebound.logical,
          builds: rebound.builds,
        },
      };
      checkEvent(next, target, limit);
      transition(next, head);
      const out = writer(target, limit),
        leaf = out.put({ kind: 'leaf', event: next });
      const carried = carry(
        { hash: leaf, first: next.receipt.result.storageSequence, count: 1 },
        frontier,
        out.put,
      );
      frontier = carried.frontier;
      head = {
        ...head,
        count: head.count + 1,
        storageSequence: next.receipt.result.storageSequence,
        logical: rebound.logical,
        builds: rebound.builds,
        peaks: carried.peak,
      };
      const prepared = out.result(serializeHead(head, limit));
      for (const row of prepared.writes) options.write(row.hash, row.raw);
      yield;
    },
  });
  let proof: IntakeLogSnapshot | undefined;
  try {
    for (;;) {
      const next = steps.next();
      if (next.done) {
        proof = next.value;
        break;
      }
      Object.assign(work, next.value);
      yield next.value;
    }
    checkAdmission(options);
    if (head.storageSequence !== source.storageSequence || head.count !== source.count)
      invalid('rebound log coverage');
    return serializeHead(head, limit);
  } finally {
    steps.return(undefined as never);
    if (proof) disposeIntakeLogSnapshot(proof);
  }
}
export function replayIntakeLog(
  cap: IntakeLogSnapshot,
  operationId: string,
  requestDigest: string,
  admission: LogAdmission,
): Event['receipt'] | undefined {
  const data = active(cap);
  data.state = 'busy';
  try {
    uuid(operationId);
    hash(requestDigest);
    checkAdmission(admission);
    const row = data.index.lookup(operationId);
    let receipt: Event['receipt'] | undefined;
    if (row) {
      const event = readIntakeLogSequence(
        data.raw,
        data.identity,
        data.get,
        row.sequence,
        admission,
      );
      const raw = JSON.stringify({
        format: NODE_FORMAT,
        identity: data.identity,
        kind: 'leaf',
        event,
      });
      if (digest(raw) !== row.leaf || event.receipt.result.operationId !== operationId)
        invalid('log index membership');
      receipt = event.receipt;
    } else receipt = baseReceipt(data.base, data.identity, operationId, admission);
    if (data.state !== 'busy') invalid('log replay disposed');
    data.index.current();
    checkAdmission(admission);
    if (data.state !== 'busy') invalid('log replay disposed');
    data.index.current();
    if (receipt && receipt.requestDigest !== requestDigest)
      invalid('log operation replay conflict');
    return receipt && freeze(structuredClone(receipt));
  } catch (error) {
    dispose(data);
    throw error;
  } finally {
    if (data.state === 'busy') data.state = 'ready';
  }
}
/** Side-effect-free preparation: only an opaque reservation changes; no durable
 * rows or index rows are inserted. One outstanding preparation per suffix proof. */
export function prepareIntakeLogAppend(
  cap: IntakeLogSnapshot,
  event: Event,
  admission: LogAdmission,
): IntakeLogAppend {
  const data = active(cap);
  data.state = 'busy';
  try {
    checkAdmission(admission);
    const detached = JSON.parse(JSON.stringify(event)) as Event;
    checkEvent(detached, data.identity, data.limit);
    transition(detached, data.head);
    if (
      data.head.count >= data.limit.events ||
      data.index.lookup(detached.receipt.result.operationId) ||
      baseReceipt(data.base, data.identity, detached.receipt.result.operationId, admission)
    )
      invalid('log operation duplicate or event limit');
    if (data.state !== 'busy') invalid('log preparation disposed');
    data.index.current();
    checkAdmission(admission);
    const out = writer(data.identity, data.limit),
      leaf = out.put({ kind: 'leaf', event: detached }),
      next = carry(
        { hash: leaf, first: detached.receipt.result.storageSequence, count: 1 },
        data.frontier,
        out.put,
      ),
      head = {
        ...data.head,
        count: data.head.count + 1,
        storageSequence: detached.receipt.result.storageSequence,
        logical: detached.receipt.result.logical,
        builds: detached.transition.builds,
        peaks: next.peak,
      },
      prepared = freeze(out.result(serializeHead(head, data.limit)));
    if (
      checkedAdd(data.nodes, prepared.writes.length) > data.limit.nodes ||
      checkedAdd(data.bytes, prepared.bytes) > data.limit.bytes
    )
      invalid('log append cumulative limits');
    const stats = data.index.stats();
    if (
      stats.rows + 1 > data.limit.indexRows ||
      stats.keyBytes + indexBytesPerRow > data.limit.indexKeyBytes
    )
      invalid('log index capacity');
    const result = Object.freeze({}) as IntakeLogAppend;
    appends.set(result, {
      before: data,
      prepared,
      event: freeze(detached),
      next: head,
      frontier: next.frontier,
      leaf,
      state: 'prepared',
    });
    data.pending = result;
    data.state = 'pending';
    return result;
  } catch (error) {
    dispose(data);
    throw error;
  }
}
export function inspectIntakeLogAppend(cap: IntakeLogAppend): Readonly<Preparation> {
  return pendingAppend(cap).prepared;
}
/** Only use before any publication attempt. Unknown outcomes require disposal. */
export function discardIntakeLogAppend(cap: IntakeLogAppend): void {
  const data = pendingAppend(cap);
  data.state = 'closed';
  data.before.pending = undefined;
  data.before.state = 'ready';
}
export interface PublicationBinding {
  readonly beforeHead: string;
  readonly afterHead: string;
  readonly writes: readonly Readonly<Write>[];
  readonly receipt: Readonly<Event['receipt']>;
}
export type LogPublicationResult =
  | { published: true; snapshot: IntakeLogSnapshot; receipt: Readonly<Event['receipt']> }
  | {
      published: true;
      snapshot: null;
      receipt: Readonly<Event['receipt']>;
      derivativeError: unknown;
    };
/** The owning integration must prove actual accepted publication and selected
 * new-row persistence, returning its NEW admission interval. This protocol does
 * not issue that authority. No caller operation may use the proof across await.
 * A resolved callback means accepted evidence survives even if index promotion
 * fails; that case returns snapshot:null, never requests evidence rollback. */
export async function confirmIntakeLogPublication(
  cap: IntakeLogAppend,
  assertPublished: (binding: Readonly<PublicationBinding>) => Admission | Promise<Admission>,
): Promise<LogPublicationResult> {
  const data = pendingAppend(cap);
  if (!data.before.index.retired()) data.before.index.activate();
  data.state = 'confirming';
  let published = false;
  try {
    const admission = await assertPublished(
      freeze({
        beforeHead: data.before.raw,
        afterHead: data.prepared.head,
        writes: data.prepared.writes,
        receipt: data.event.receipt,
      }),
    );
    published = true;
    if (
      data.state !== 'confirming' ||
      data.before.state !== 'pending' ||
      data.before.pending !== cap
    )
      invalid('log confirmation disposed');
    checkAdmission(admission);
    data.before.index.current();
    data.before.index.insert(
      data.event.receipt.result.operationId,
      data.next.storageSequence,
      data.leaf,
    );
    checkAdmission(admission);
    if (data.before.state !== 'pending') invalid('log confirmation disposed');
    data.before.index.current();
    const next = snapshot({
      ...data.before,
      raw: data.prepared.head,
      head: data.next,
      frontier: data.frontier,
      nodes: data.before.nodes + data.prepared.writes.length,
      bytes: data.before.bytes + data.prepared.bytes,
      state: 'ready',
      pending: undefined,
    });
    advanceLease(data.before, snapshots.get(next)!);
    data.before.state = 'consumed';
    data.state = 'closed';
    return { published: true, snapshot: next, receipt: data.event.receipt };
  } catch (error) {
    data.state = 'closed';
    let derivativeError = error;
    try {
      dispose(data.before);
    } catch (cleanupError) {
      derivativeError = new AggregateError(
        [error, cleanupError],
        'Log derivative promotion and cleanup failed',
      );
    }
    if (published)
      return {
        published: true,
        snapshot: null,
        receipt: data.event.receipt,
        derivativeError,
      };
    throw derivativeError;
  }
}

/** Production promotion bridge: the only synchronous advance consumes the
 * genuine record owner's single-use acceptance closure. Fresh physical/source
 * admission must run before this call; no caller callback runs after consumption.
 * Refused derivatives never change the already accepted operation receipt. */
export async function confirmOwnedIntakeLogPublication(
  db: Database,
  cap: IntakeLogAppend,
  publication: RecordIntakeLogPublication,
  actualBeforeHead: string | undefined,
  admission: Admission,
): Promise<LogPublicationResult | undefined> {
  const { consumeAcceptedRecordIntakeLogPublication } = await import('./record-versions.ts');
  const data = pendingAppend(cap);
  data.state = 'confirming';
  let accepted = false;
  try {
    const promotionFailure = data.before.index.retired()
      ? undefined
      : data.before.index.activateForConfirmation();
    checkAdmission(admission);
    if (actualBeforeHead !== data.before.raw) {
      if (data.before.head.count !== 0) invalid('owned log previous head');
      const initial = initializeIntakeLog(
        data.before.identity,
        actualBeforeHead,
        data.before.limit,
      );
      if (initial.head !== data.before.raw) invalid('owned log anchor previous head');
    }
    if (!data.before.index.retired()) data.before.index.current();
    accepted = consumeAcceptedRecordIntakeLogPublication(db, publication, {
      identity: data.before.identity,
      beforeHead: actualBeforeHead,
      afterHead: data.prepared.head,
      receipt: data.event.receipt,
      writes: data.prepared.writes.map((row) => ({
        key: intakeNamespace(data.before.identity) + 'node:' + row.hash,
        value: row.raw,
      })),
    });
    if (!accepted) {
      dispose(data.before);
      return undefined;
    }
    if (promotionFailure) throw promotionFailure;
    data.before.index.current();
    data.before.index.insert(
      data.event.receipt.result.operationId,
      data.next.storageSequence,
      data.leaf,
    );
    data.before.index.current();
    const next = snapshot({
      ...data.before,
      raw: data.prepared.head,
      head: data.next,
      frontier: data.frontier,
      nodes: data.before.nodes + data.prepared.writes.length,
      bytes: data.before.bytes + data.prepared.bytes,
      state: 'ready',
      pending: undefined,
    });
    advanceLease(data.before, snapshots.get(next)!);
    data.before.state = 'consumed';
    data.state = 'closed';
    return { published: true, snapshot: next, receipt: data.event.receipt };
  } catch (error) {
    data.state = 'closed';
    let derivativeError = error;
    try {
      dispose(data.before);
    } catch (cleanupError) {
      derivativeError = new AggregateError(
        [error, cleanupError],
        'Owned log derivative cleanup failed',
      );
    }
    if (accepted)
      return { published: true, snapshot: null, receipt: data.event.receipt, derivativeError };
    throw derivativeError;
  }
}
/** Positive sequence membership, authenticated from the selected head. No operation-absence claim. */
export function readIntakeLogSequence(
  rawHead: string,
  identity: IntakeStateIdentity,
  get: Get,
  sequence: number,
  admission: Admission,
): Event {
  checkAdmission(admission);
  const limit = caps(),
    head = parseHead(rawHead, identity),
    seen = new Set<string>();
  integer(sequence, 1);
  if (sequence <= head.baseSequence || sequence > checkedAdd(head.baseSequence, head.count))
    invalid('sequence outside appended range');
  const read = (key: string) => {
    if (seen.has(key) || seen.size >= 106) invalid('membership traversal');
    seen.add(key);
    return decodeNode(get(key), key, identity, limit);
  };
  let cursor = head.peaks,
    nextSequence = head.baseSequence + head.count,
    priorSize = 0;
  while (cursor) {
    const cell = read(cursor);
    if (
      cell.kind !== 'peak' ||
      cell.tree.count <= priorSize ||
      cell.tree.first + cell.tree.count - 1 !== nextSequence
    )
      invalid('membership peak range');
    priorSize = cell.tree.count;
    nextSequence = cell.tree.first - 1;
    if (sequence >= cell.tree.first) {
      let ref = cell.tree;
      for (;;) {
        const node = read(ref.hash);
        if (node.kind === 'leaf') {
          if (
            ref.count !== 1 ||
            ref.first !== sequence ||
            node.event.receipt.result.storageSequence !== sequence
          )
            invalid('membership leaf');
          checkAdmission(admission);
          return node.event;
        }
        if (
          node.kind !== 'merge' ||
          ref.first !== node.left.first ||
          ref.count !== node.left.count + node.right.count
        )
          invalid('membership merge');
        ref = sequence < node.right.first ? node.left : node.right;
      }
    }
    cursor = cell.older;
  }
  invalid('missing sequence');
}
