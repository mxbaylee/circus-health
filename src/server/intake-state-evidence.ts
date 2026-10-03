import { createHash, randomUUID } from 'node:crypto';
import { applyIntakeChanges, serializeIntakeJson, type IntakeJson } from './intake-state-codec.ts';
import type { ChatDecodeBudget } from './chat-journal-codec.ts';
import { recordIntakeSerialization, recordIntakeWork } from './intake-work-accounting.ts';
export const FORMAT = 'health-intake-state-v3';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
export const FRAME_BYTES = 64 * 1024;
export const CHUNK_BYTES = 32 * 1024;
export const HEAD_BYTES = 4096;
export const DEFAULT_LIMITS = {
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
export type Limits = typeof DEFAULT_LIMITS;
export type Usage = Limits;
export interface Reference {
  id: string;
  sequence: number;
  sha256: string;
}
export interface Head extends IntakeStateIdentity {
  format: typeof FORMAT;
  version: number;
  tip: Reference;
  usage: Usage;
}
export interface Frame extends IntakeStateIdentity {
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
export interface Basis {
  head: Head;
  value: IntakeJson;
  semanticBytes: number;
}
export function invalid(message: string): never {
  throw Error(`Invalid intake state: ${message}`);
}
export const digest = (bytes: string | Buffer) => {
  recordIntakeWork('hashCalls');
  recordIntakeWork(
    'hashedBytes',
    typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length,
  );
  return createHash('sha256').update(bytes).digest('hex');
};
function copied(bytes: Buffer): Buffer {
  recordIntakeWork('evidenceBufferCopiedBytes', bytes.length);
  return bytes;
}
export function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== keys.sort().join('\0')
  )
    invalid('schema');
}
export function integer(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid('integer');
}
export function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid('operation/frame identity');
}
export function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid('hash');
}
function reference(value: unknown): asserts value is Reference {
  exact(value, ['id', 'sequence', 'sha256']);
  uuid(value.id);
  integer(value.sequence, 1);
  hash(value.sha256);
}
function same(a: unknown, b: unknown): boolean {
  return (
    recordIntakeSerialization(JSON.stringify(a)) === recordIntakeSerialization(JSON.stringify(b))
  );
}
export function decode(value: unknown, max: number): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) invalid('encoded bytes');
  const bytes = copied(Buffer.from(value));
  recordIntakeWork('evidenceDecodeCopyBytes', bytes.length);
  if (bytes.toString('utf8') !== value) invalid('UTF-8');
  try {
    recordIntakeWork('jsonParseCalls');
    recordIntakeWork('jsonParseBytes', bytes.length);
    return JSON.parse(value) as unknown;
  } catch {
    invalid('JSON');
  }
}
function scope(value: Record<string, unknown>, identity: IntakeStateIdentity) {
  if (value.format !== FORMAT) invalid('unsupported authority format');
  if (
    value.profileId !== identity.profileId ||
    value.intakeId !== identity.intakeId ||
    value.sourceHash !== identity.sourceHash
  )
    invalid('scope');
}
export function limits(options: Partial<Limits> = {}): Limits {
  if (Object.keys(options).some((k) => !Object.hasOwn(DEFAULT_LIMITS, k))) invalid('limit key');
  const result = { ...DEFAULT_LIMITS, ...options };
  for (const name of Object.keys(DEFAULT_LIMITS) as Array<keyof Limits>) {
    integer(result[name], 1);
    if (result[name] > DEFAULT_LIMITS[name]) invalid('raised limit');
  }
  return result;
}
export function usage(raw: unknown, caps: Limits): asserts raw is Usage {
  exact(raw, Object.keys(DEFAULT_LIMITS));
  for (const name of Object.keys(caps) as Array<keyof Limits>) {
    integer(raw[name]);
    if (Number(raw[name]) > caps[name]) invalid('cumulative limit');
  }
}
export function budget(caps: Limits, used: Usage): ChatDecodeBudget {
  return {
    nodes: caps.nodes - used.nodes,
    operations: caps.operations - used.operations,
    stringWork: caps.stringWork - used.stringWork,
  };
}
export function addDecoded(used: Usage, caps: Limits, remaining: ChatDecodeBudget): Usage {
  return {
    ...used,
    nodes: caps.nodes - remaining.nodes,
    operations: caps.operations - remaining.operations,
    stringWork: caps.stringWork - remaining.stringWork,
  };
}
export function validateIntakeIdentity(identity: IntakeStateIdentity): IntakeStateIdentity {
  exact(identity, ['profileId', 'intakeId', 'sourceHash']);
  for (const name of ['profileId', 'intakeId'] as const)
    if (
      typeof identity[name] !== 'string' ||
      !identity[name] ||
      Buffer.byteLength(identity[name]) > 256
    )
      invalid('identity');
  hash(identity.sourceHash);
  return {
    profileId: identity.profileId,
    intakeId: identity.intakeId,
    sourceHash: identity.sourceHash,
  };
}
export function intakeNamespace(identity: IntakeStateIdentity): string {
  return `intake_state_v1:${digest(recordIntakeSerialization(JSON.stringify(validateIntakeIdentity(identity))))}:`;
}
export function parseIntakeHead(
  raw: unknown,
  identity: IntakeStateIdentity,
  caps: Limits,
): Head | undefined {
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
export function checkIntakeResult(
  identity: IntakeStateIdentity,
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
export function reconstructIntakeEvidence(
  identity: IntakeStateIdentity,
  caps: Limits,
  head: Head,
  get: (key: string) => unknown,
  onFrameRead?: () => void,
): Basis & { consumed: Set<string> } {
  const prefix = intakeNamespace(identity);
  const consumed = new Set([`${prefix}head`]);
  const frames: Frame[] = [];
  let ref: Reference | null = head.tip;
  let physicalBytes = 0;
  const seen = new Set<string>();
  while (ref) {
    if (seen.has(ref.id) || frames.length >= caps.frames) invalid('duplicate/frames limit');
    seen.add(ref.id);
    const raw = get(`${prefix}frame:${ref.id}`);
    recordIntakeWork('evidenceFrameReads');
    if (typeof raw === 'string') recordIntakeWork('evidenceFrameReadBytes', Buffer.byteLength(raw));
    onFrameRead?.();
    consumed.add(`${prefix}frame:${ref.id}`);
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
    const decoded = copied(Buffer.from(frame.data, 'base64'));
    if (decoded.length > CHUNK_BYTES || decoded.toString('base64') !== frame.data)
      invalid('base64');
    frames.push(frame as unknown as Frame);
    ref = frame.previous as Reference | null;
  }
  frames.reverse();
  let value: IntakeJson | undefined;
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
      chunks.push(copied(Buffer.from(frame.data, 'base64')));
    }
    const payload = copied(Buffer.concat(chunks));
    if (
      digest(payload) !== first.payloadHash ||
      !copied(Buffer.from(payload.toString('utf8'))).equals(payload)
    )
      invalid('payload hash/UTF-8');
    const remaining = budget(caps, used);
    const changes = decode(payload.toString('utf8'), caps.bytes);
    recordIntakeWork('evidenceReplayVersions');
    if (Array.isArray(changes)) recordIntakeWork('evidenceReplayOperations', changes.length);
    value = applyIntakeChanges(value, changes, remaining);
    used = addDecoded(used, caps, remaining);
    const serializedValue = serializeIntakeJson(value);
    semanticBytes = Buffer.byteLength(serializedValue);
    if (digest(serializedValue) !== first.fingerprint) invalid('result fingerprint');
    const receiptRaw = get(`${prefix}operation:${first.operationId}`);
    recordIntakeWork('evidenceReceiptReads');
    if (typeof receiptRaw === 'string')
      recordIntakeWork('evidenceReceiptReadBytes', Buffer.byteLength(receiptRaw));
    const receipt = decode(receiptRaw, HEAD_BYTES);
    exact(receipt, ['fingerprint', 'result']);
    hash(receipt.fingerprint);
    if (receipt.fingerprint !== first.fingerprint) invalid('operation receipt');
    checkIntakeResult(identity, receipt.result, first.operationId, version);
    consumed.add(`${prefix}operation:${first.operationId}`);
    const changed = (changes as unknown[]).length > 0;
    if (receipt.result.changed !== changed) invalid('receipt changed');
    // Receipts are bounded and accounted alongside contribution bytes.
    used.bytes += Buffer.byteLength(receiptRaw as string);
    usage(used, caps);
    offset += first.chunks;
  }
  if (!value) invalid('missing value');
  if (version !== head.version || !same(used, head.usage)) invalid('usage agreement');
  usage(used, caps);
  return { head, value, semanticBytes, consumed };
}
export function frameIntakeChanges(
  identity: IntakeStateIdentity,
  changes: unknown[],
  fingerprint: string,
  operationId: string,
  caps: Limits,
  previous: Head | undefined,
  remaining: ChatDecodeBudget,
) {
  validateIntakeIdentity(identity);
  hash(fingerprint);
  uuid(operationId);
  const prefix = intakeNamespace(identity);
  const oldUsage = previous?.usage ?? {
    bytes: 0,
    frames: 0,
    nodes: 0,
    operations: 0,
    stringWork: 0,
  };
  const payload = copied(Buffer.from(recordIntakeSerialization(JSON.stringify(changes))));
  if (payload.length > caps.bytes) invalid('operation bytes');
  const chunks = Math.max(1, Math.ceil(payload.length / CHUNK_BYTES));
  const version = (previous?.version ?? 0) + 1;
  const result: IntakeStateResult = {
    format: 'health-intake-state-result-v1',
    intakeId: identity.intakeId,
    version,
    operationId,
    changed: changes.length > 0,
  };
  const receipt = recordIntakeSerialization(JSON.stringify({ fingerprint, result }));
  const staged: Array<{ key: string; serialized: string }> = [];
  let tip: Reference | null = previous?.tip ?? null;
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
    const serialized = recordIntakeSerialization(JSON.stringify(frame));
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
  const serializedHead = recordIntakeSerialization(JSON.stringify(head));
  if (Buffer.byteLength(serializedHead) > HEAD_BYTES || Buffer.byteLength(receipt) > HEAD_BYTES)
    invalid('head/receipt bound');
  return { head, serializedHead, frames: staged, receipt, result };
}
