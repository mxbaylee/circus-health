import { createHash, randomUUID } from 'node:crypto';
import {
  currentTransactionToken,
  observeTransactionOutcome,
  rejectCurrentTransaction,
  transaction,
  type Database,
} from './database.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import {
  applyChatChanges,
  chatChanges,
  cloneChatJson,
  type ChatDecodeBudget,
  type ChatJson,
} from './chat-journal-codec.ts';

const FORMAT = 'health-intake-state-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const FRAME_BYTES = 64 * 1024;
const CHUNK_BYTES = 32 * 1024;
const HEAD_BYTES = 4096;
const DEFAULT_LIMITS = {
  bytes: 256 * 1024 * 1024,
  frames: 100_000,
  nodes: 1_000_000,
  operations: 1_000_000,
  stringWork: 100_000_000,
};
export interface IntakeStateIdentity {
  profileId: string;
  intakeId: string;
  sourceHash: string;
}
export interface IntakeStateResult {
  format: 'health-intake-state-result-v1';
  intakeId: string;
  version: number;
  operationId: string;
  changed: boolean;
}
type Limits = typeof DEFAULT_LIMITS;
type Usage = Limits;
interface Reference {
  id: string;
  sequence: number;
  sha256: string;
}
interface Head extends IntakeStateIdentity {
  format: typeof FORMAT;
  version: number;
  tip: Reference;
  usage: Usage;
}
interface Frame extends IntakeStateIdentity {
  format: typeof FORMAT;
  id: string;
  sequence: number;
  previous: Reference | null;
  version: number;
  operationId: string;
  fingerprint: string;
  chunk: number;
  chunks: number;
  payloadHash: string;
  data: string;
}
interface Basis {
  head: Head;
  value: ChatJson;
  semanticBytes: number;
}
interface Cache {
  committed: Map<string, Basis>;
  candidates: Map<string, Basis>;
  token?: object;
  dispose: () => void;
}
const caches = new WeakMap<Database, Cache>();
function invalid(message: string): never {
  throw Error(`Invalid intake state: ${message}`);
}
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== keys.sort().join('\0')
  )
    invalid('schema');
}
function integer(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid('integer');
}
function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid('operation/frame identity');
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid('hash');
}
function reference(value: unknown): asserts value is Reference {
  exact(value, ['id', 'sequence', 'sha256']);
  uuid(value.id);
  integer(value.sequence, 1);
  hash(value.sha256);
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function stable(value: ChatJson): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k]!)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function decode(value: unknown, max: number): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) invalid('encoded bytes');
  const bytes = Buffer.from(value);
  if (bytes.toString('utf8') !== value) invalid('UTF-8');
  try {
    return JSON.parse(value) as unknown;
  } catch {
    invalid('JSON');
  }
}
function scope(value: Record<string, unknown>, identity: IntakeStateIdentity) {
  if (
    value.format !== FORMAT ||
    value.profileId !== identity.profileId ||
    value.intakeId !== identity.intakeId ||
    value.sourceHash !== identity.sourceHash
  )
    invalid('scope/format');
}
function limits(options: Partial<Limits> = {}): Limits {
  if (Object.keys(options).some((k) => !Object.hasOwn(DEFAULT_LIMITS, k))) invalid('limit key');
  const result = { ...DEFAULT_LIMITS, ...options };
  for (const name of Object.keys(DEFAULT_LIMITS) as Array<keyof Limits>) {
    integer(result[name], 1);
    if (result[name] > DEFAULT_LIMITS[name]) invalid('raised limit');
  }
  return result;
}
function usage(raw: unknown, caps: Limits): asserts raw is Usage {
  exact(raw, Object.keys(DEFAULT_LIMITS));
  for (const name of Object.keys(caps) as Array<keyof Limits>) {
    integer(raw[name]);
    if (Number(raw[name]) > caps[name]) invalid('cumulative limit');
  }
}
function budget(caps: Limits, used: Usage): ChatDecodeBudget {
  return {
    nodes: caps.nodes - used.nodes,
    operations: caps.operations - used.operations,
    stringWork: caps.stringWork - used.stringWork,
  };
}
function addDecoded(used: Usage, caps: Limits, remaining: ChatDecodeBudget): Usage {
  return {
    ...used,
    nodes: caps.nodes - remaining.nodes,
    operations: caps.operations - remaining.operations,
    stringWork: caps.stringWork - remaining.stringWork,
  };
}
export function clearIntakeStateCache(db: Database): void {
  const cache = caches.get(db);
  if (!cache) return;
  cache.committed.clear();
  cache.candidates.clear();
  cache.dispose();
  caches.delete(db);
}
function cacheFor(db: Database): Cache {
  let cache = caches.get(db);
  if (!cache) {
    cache = { committed: new Map(), candidates: new Map(), dispose: () => {} };
    const owned = cache;
    owned.dispose = observeTransactionOutcome(db, (outcome) => {
      try {
        if (outcome.token !== owned.token) return;
        if (outcome.succeeded) {
          for (const [key, candidate] of owned.candidates) owned.committed.set(key, candidate);
          owned.candidates.clear();
          owned.token = undefined;
        } else clearIntakeStateCache(db);
      } catch {
        clearIntakeStateCache(db);
      }
    });
    caches.set(db, owned);
  }
  return cache;
}

/** Internal primitive only; production intake readers/writers have not cut over. */
export function createIntakeStateStorage(
  db: Database,
  identity: IntakeStateIdentity,
  options: { limits?: Partial<Limits> } = {},
) {
  exact(identity, ['profileId', 'intakeId', 'sourceHash']);
  for (const name of ['profileId', 'intakeId'] as const)
    if (
      typeof identity[name] !== 'string' ||
      !identity[name] ||
      Buffer.byteLength(identity[name]) > 256
    )
      invalid('identity');
  hash(identity.sourceHash);
  identity = {
    profileId: identity.profileId,
    intakeId: identity.intakeId,
    sourceHash: identity.sourceHash,
  };
  const caps = limits(options.limits);
  const prefix = `intake_state_v1:${digest(JSON.stringify(identity))}:`;
  const headKey = `${prefix}head`;
  let closed = false;
  const counters = {
    coldReconstructions: 0,
    ancestorReads: 0,
    candidateCopies: 0,
    patchOperations: 0,
    normalizedStateBytes: 0,
    candidateCopyBytes: 0,
    framesWritten: 0,
    frameBytesWritten: 0,
  };
  const get = (key: string) => db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
  function ready() {
    if (closed || !db.isOpen) {
      clearIntakeStateCache(db);
      invalid('closed');
    }
    if (get('owner_profile_id') !== identity.profileId) invalid('database owner');
    const source = db
      .prepare('SELECT sha256,kind FROM source_files WHERE id=?')
      .get(identity.intakeId);
    if (!source || source.sha256 !== identity.sourceHash || source.kind !== 'intake_original')
      invalid('original source');
    const durability = recordDurabilityStatus(db);
    if (!durability?.configured || durability.dirty) {
      clearIntakeStateCache(db);
      invalid('accepted authority requires configured current projection');
    }
  }
  function parseHead(raw: unknown): Head | undefined {
    if (raw === undefined) return undefined;
    const value = decode(raw, HEAD_BYTES);
    exact(value, ['format', 'profileId', 'intakeId', 'sourceHash', 'version', 'tip', 'usage']);
    scope(value, identity);
    integer(value.version, 1);
    reference(value.tip);
    usage(value.usage, caps);
    if (value.tip.sequence !== value.usage.frames || Number(value.version) > value.tip.sequence)
      invalid('head counters');
    return value as unknown as Head;
  }
  function immutable(key: string, serialized: string) {
    const old = get(key);
    if (old !== undefined) {
      if (old !== serialized) invalid('immutable collision');
      return;
    }
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(key, serialized);
  }
  function load(): Basis | undefined {
    ready();
    const head = parseHead(get(headKey));
    const cache = cacheFor(db);
    const token = currentTransactionToken(db);
    const candidate = token === cache.token ? cache.candidates.get(prefix) : undefined;
    const remembered = candidate ?? cache.committed.get(prefix);
    if (!head) {
      if (db.prepare('SELECT 1 FROM app_meta WHERE key GLOB ? LIMIT 1').get(`${prefix}*`))
        invalid('missing head with retained evidence');
      return undefined;
    }
    if (remembered && same(remembered.head, head)) return remembered;
    counters.coldReconstructions++;
    const frames: Frame[] = [];
    let ref: Reference | null = head.tip;
    let physicalBytes = 0;
    const seen = new Set<string>();
    while (ref) {
      if (seen.has(ref.id) || frames.length >= caps.frames) invalid('duplicate/frames limit');
      seen.add(ref.id);
      const raw = get(`${prefix}frame:${ref.id}`);
      counters.ancestorReads++;
      if (typeof raw !== 'string') invalid('missing contribution');
      physicalBytes += Buffer.byteLength(raw);
      if (physicalBytes > caps.bytes || digest(raw) !== ref.sha256) invalid('bytes/hash');
      const frame = decode(raw, FRAME_BYTES);
      exact(frame, [
        'format',
        'profileId',
        'intakeId',
        'sourceHash',
        'id',
        'sequence',
        'previous',
        'version',
        'operationId',
        'fingerprint',
        'chunk',
        'chunks',
        'payloadHash',
        'data',
      ]);
      scope(frame, identity);
      uuid(frame.id);
      uuid(frame.operationId);
      hash(frame.fingerprint);
      hash(frame.payloadHash);
      integer(frame.sequence, 1);
      integer(frame.version, 1);
      integer(frame.chunk);
      integer(frame.chunks, 1);
      if (
        frame.id !== ref.id ||
        frame.sequence !== ref.sequence ||
        Number(frame.chunk) >= Number(frame.chunks)
      )
        invalid('frame coordinates');
      if (frame.previous !== null) reference(frame.previous);
      if (
        (frame.previous === null ? 0 : (frame.previous as Reference).sequence) !==
        Number(frame.sequence) - 1
      )
        invalid('predecessor');
      if (typeof frame.data !== 'string' || frame.data.length > (CHUNK_BYTES * 4) / 3 + 4)
        invalid('chunk bytes');
      const decoded = Buffer.from(frame.data, 'base64');
      if (decoded.length > CHUNK_BYTES || decoded.toString('base64') !== frame.data)
        invalid('base64');
      frames.push(frame as unknown as Frame);
      ref = frame.previous as Reference | null;
    }
    frames.reverse();
    let value: ChatJson | undefined;
    let version = 0;
    let semanticBytes = 0;
    let used: Usage = {
      bytes: physicalBytes,
      frames: frames.length,
      nodes: 0,
      operations: 0,
      stringWork: 0,
    };
    let offset = 0;
    while (offset < frames.length) {
      const first = frames[offset]!;
      if (first.version !== ++version || first.chunk !== 0 || first.chunks > frames.length - offset)
        invalid('logical sequence');
      const chunks: Buffer[] = [];
      for (let i = 0; i < first.chunks; i++) {
        const frame = frames[offset + i]!;
        if (
          frame.version !== version ||
          frame.chunk !== i ||
          frame.chunks !== first.chunks ||
          frame.operationId !== first.operationId ||
          frame.fingerprint !== first.fingerprint ||
          frame.payloadHash !== first.payloadHash
        )
          invalid('chunk group');
        chunks.push(Buffer.from(frame.data, 'base64'));
      }
      const payload = Buffer.concat(chunks);
      if (
        digest(payload) !== first.payloadHash ||
        !Buffer.from(payload.toString('utf8')).equals(payload)
      )
        invalid('payload hash/UTF-8');
      const remaining = budget(caps, used);
      const changes = decode(payload.toString('utf8'), caps.bytes);
      value = applyChatChanges(value, changes, remaining);
      used = addDecoded(used, caps, remaining);
      const serializedValue = stable(value);
      semanticBytes = Buffer.byteLength(serializedValue);
      if (digest(serializedValue) !== first.fingerprint) invalid('result fingerprint');
      const receiptRaw = get(`${prefix}operation:${first.operationId}`);
      const receipt = decode(receiptRaw, HEAD_BYTES);
      exact(receipt, ['fingerprint', 'result']);
      hash(receipt.fingerprint);
      if (receipt.fingerprint !== first.fingerprint) invalid('operation receipt');
      checkResult(receipt.result, first.operationId, version);
      const changed = (changes as unknown[]).length > 0;
      if (receipt.result.changed !== changed) invalid('receipt changed');
      // Receipts are bounded and accounted alongside contribution bytes.
      used.bytes += Buffer.byteLength(receiptRaw as string);
      usage(used, caps);
      offset += first.chunks;
    }
    if (!value && value !== null && value !== false && value !== 0 && value !== '')
      invalid('missing value');
    if (version !== head.version || !same(used, head.usage)) invalid('usage agreement');
    usage(used, caps);
    const result = { head, value: value as ChatJson, semanticBytes };
    if (token) {
      cache.token = token;
      cache.candidates.set(prefix, result);
    } else cache.committed.set(prefix, result);
    return result;
  }
  function checkResult(
    raw: unknown,
    id: string,
    version?: number,
  ): asserts raw is IntakeStateResult {
    exact(raw, ['format', 'intakeId', 'version', 'operationId', 'changed']);
    if (
      raw.format !== 'health-intake-state-result-v1' ||
      raw.intakeId !== identity.intakeId ||
      raw.operationId !== id ||
      typeof raw.changed !== 'boolean'
    )
      invalid('result');
    integer(raw.version, 1);
    if (version !== undefined && raw.version !== version) invalid('receipt version');
  }
  function normalized(next: unknown): { value: ChatJson; fingerprint: string } {
    const value = cloneChatJson(next);
    const serialized = stable(value);
    counters.normalizedStateBytes += Buffer.byteLength(serialized);
    return { value, fingerprint: digest(serialized) };
  }
  function stageNormalized(
    value: ChatJson,
    fingerprint: string,
    operationId: string,
  ): IntakeStateResult {
    ready();
    uuid(operationId);
    const token = currentTransactionToken(db);
    if (!token || !db.isTransaction) invalid('stage requires application transaction');
    const receiptKey = `${prefix}operation:${operationId}`;
    const prior = get(receiptKey);
    if (prior !== undefined) {
      const receipt = decode(prior, HEAD_BYTES);
      exact(receipt, ['fingerprint', 'result']);
      if (receipt.fingerprint !== fingerprint) invalid('operation replay conflict');
      checkResult(receipt.result, operationId);
      load();
      return { ...receipt.result };
    }
    const before = load();
    const changes = before ? chatChanges(before.value, value) : [{ op: 'set', path: [], value }];
    counters.patchOperations += changes.length;
    const candidate = before ? cloneChatJson(before.value) : undefined;
    if (before) {
      counters.candidateCopies++;
      counters.candidateCopyBytes += before.semanticBytes;
    }
    const oldUsage = before?.head.usage ?? {
      bytes: 0,
      frames: 0,
      nodes: 0,
      operations: 0,
      stringWork: 0,
    };
    const remaining = budget(caps, oldUsage);
    const applied = applyChatChanges(candidate, changes, remaining);
    const serializedValue = stable(applied);
    const semanticBytes = Buffer.byteLength(serializedValue);
    if (digest(serializedValue) !== fingerprint) invalid('candidate mismatch');
    const payload = Buffer.from(JSON.stringify(changes));
    if (payload.length > caps.bytes) invalid('operation bytes');
    const chunks = Math.max(1, Math.ceil(payload.length / CHUNK_BYTES));
    const version = (before?.head.version ?? 0) + 1;
    const result: IntakeStateResult = {
      format: 'health-intake-state-result-v1',
      intakeId: identity.intakeId,
      version,
      operationId,
      changed: changes.length > 0,
    };
    const receipt = JSON.stringify({ fingerprint, result });
    const staged: Array<{ key: string; serialized: string }> = [];
    let tip: Reference | null = before?.head.tip ?? null;
    let used = addDecoded(oldUsage, caps, remaining);
    used.bytes += Buffer.byteLength(receipt);
    for (let chunk = 0; chunk < chunks; chunk++) {
      const id = randomUUID();
      const frame: Frame = {
        ...identity,
        format: FORMAT,
        id,
        sequence: used.frames + 1,
        previous: tip,
        version,
        operationId,
        fingerprint,
        chunk,
        chunks,
        payloadHash: digest(payload),
        data: payload.subarray(chunk * CHUNK_BYTES, (chunk + 1) * CHUNK_BYTES).toString('base64'),
      };
      const serialized = JSON.stringify(frame);
      if (Buffer.byteLength(serialized) > FRAME_BYTES) invalid('frame bound');
      used = {
        ...used,
        bytes: used.bytes + Buffer.byteLength(serialized),
        frames: used.frames + 1,
      };
      usage(used, caps);
      tip = { id, sequence: frame.sequence, sha256: digest(serialized) };
      staged.push({ key: `${prefix}frame:${id}`, serialized });
    }
    const head: Head = { ...identity, format: FORMAT, version, tip: tip!, usage: used };
    const serializedHead = JSON.stringify(head);
    if (Buffer.byteLength(serializedHead) > HEAD_BYTES || Buffer.byteLength(receipt) > HEAD_BYTES)
      invalid('head/receipt bound');
    // Validate everything before the first SQL write. The outer transaction publishes all rows together.
    for (const entry of staged) {
      immutable(entry.key, entry.serialized);
      if (get(entry.key) !== entry.serialized) invalid('staged readback');
      counters.framesWritten++;
      counters.frameBytesWritten += Buffer.byteLength(entry.serialized);
    }
    immutable(receiptKey, receipt);
    db.prepare(
      'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(headKey, serializedHead);
    const cache = cacheFor(db);
    cache.token = token;
    cache.candidates.set(prefix, { head, value: applied, semanticBytes });
    return result;
  }
  return {
    counters,
    read(): ChatJson | undefined {
      const basis = load();
      return basis ? cloneChatJson(basis.value) : undefined;
    },
    stage(next: unknown, operationId: string): IntakeStateResult {
      try {
        const { value, fingerprint } = normalized(next);
        return stageNormalized(value, fingerprint, operationId);
      } catch (error) {
        if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
        clearIntakeStateCache(db);
        throw error;
      }
    },
    mutate(next: unknown, operationId: string): IntakeStateResult {
      if (currentTransactionToken(db) || db.isTransaction) invalid('mutate owns outer transaction');
      const { value, fingerprint } = normalized(next);
      uuid(operationId);
      ready();
      try {
        return transaction(db, () => stageNormalized(value, fingerprint, operationId), {
          operationId,
          fingerprint: `${prefix}${fingerprint}`,
          actor: 'intake-state',
        });
      } catch (error) {
        clearIntakeStateCache(db);
        throw error;
      }
    },
    close() {
      closed = true;
      clearIntakeStateCache(db);
    },
  };
}
