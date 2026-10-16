import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_CERTIFICATE_DELTA_CHUNK_BYTES = 256 * 1024;
export const MAX_CERTIFICATE_DELTA_CHUNK_COUNT = 64;

export interface ContributorCertificateDelta {
  entity: string;
  recordId: string;
  versionId: string;
  deleted: number;
  preimage: { hash: string; bytes: number };
  fields: { name: string; hash: string; bytes: number }[];
  previousAccepted: string | null;
}

export interface ContributorCertificateDeltaChunk {
  ordinal: number;
  certificates: ContributorCertificateDelta[];
  signature: string;
}

const hexDigest = /^[0-9a-f]{64}$/;
// Only enumerable data fields enter the signed JSON transport.
const plainKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    return false;
  let count = 0;
  for (const key in value) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!keys.includes(key) || !descriptor || !('value' in descriptor) || ++count > keys.length)
      return false;
  }
  return count === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const boundedString = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_CERTIFICATE_DELTA_CHUNK_BYTES;
const sign = (key: Uint8Array, values: unknown[]) =>
  createHmac('sha256', key).update(JSON.stringify(values)).digest('hex');
const equalDigest = (actual: unknown, expected: string) =>
  typeof actual === 'string' &&
  hexDigest.test(actual) &&
  timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));

export function certificateDeltaHead(selectedHead: string, ownHeads?: readonly string[]): string {
  return ownHeads?.at(-1) ?? selectedHead;
}

export function signCertificateDeltaChunk(
  key: Uint8Array,
  nonce: string,
  head: string,
  ordinal: number,
  certificates: readonly ContributorCertificateDelta[],
): string {
  return sign(key, [nonce, head, 'certificate-chunk', ordinal, certificates]);
}

export function signCertificateDeltaTerminal(
  key: Uint8Array,
  nonce: string,
  head: string,
  chunks: number,
  count: number,
  digest: string,
): string {
  return sign(key, [nonce, head, 'certificate-terminal', chunks, count, digest]);
}

export function certificateDeltaMinimumBytes(value: unknown): number {
  if (
    !plainKeys(value, [
      'entity',
      'recordId',
      'versionId',
      'deleted',
      'preimage',
      'fields',
      'previousAccepted',
    ]) ||
    !boundedString(value.entity) ||
    !boundedString(value.recordId) ||
    !boundedString(value.versionId) ||
    (value.deleted !== 0 && value.deleted !== 1) ||
    !plainKeys(value.preimage, ['hash', 'bytes']) ||
    typeof value.preimage.hash !== 'string' ||
    !hexDigest.test(value.preimage.hash) ||
    !Number.isSafeInteger(value.preimage.bytes) ||
    (value.preimage.bytes as number) < 0 ||
    !Array.isArray(value.fields) ||
    value.fields.length > MAX_CERTIFICATE_DELTA_CHUNK_COUNT ||
    (value.previousAccepted !== null && !boundedString(value.previousAccepted))
  )
    throw Error('Contributor certificate delta value invalid');
  let bytes =
    Buffer.byteLength(value.entity) +
    Buffer.byteLength(value.recordId) +
    Buffer.byteLength(value.versionId) +
    (value.previousAccepted === null ? 0 : Buffer.byteLength(value.previousAccepted as string));
  for (const field of value.fields) {
    if (
      !plainKeys(field, ['name', 'hash', 'bytes']) ||
      !boundedString(field.name) ||
      typeof field.hash !== 'string' ||
      !hexDigest.test(field.hash) ||
      !Number.isSafeInteger(field.bytes) ||
      (field.bytes as number) < 0
    )
      throw Error('Contributor certificate delta field invalid');
    bytes += Buffer.byteLength(field.name);
    if (bytes > MAX_CERTIFICATE_DELTA_CHUNK_BYTES)
      throw Error('Contributor certificate delta chunk too large');
  }
  return bytes;
}

export function checkedCertificateDeltaChunk(
  key: Uint8Array,
  nonce: string,
  head: string,
  value: unknown,
): { chunk: ContributorCertificateDeltaChunk; encoded: Buffer } {
  const chunk = value as Partial<ContributorCertificateDeltaChunk> | null;
  if (
    !plainKeys(chunk, ['ordinal', 'certificates', 'signature']) ||
    !Number.isSafeInteger(chunk.ordinal) ||
    chunk.ordinal! < 0 ||
    !Array.isArray(chunk.certificates) ||
    chunk.certificates.length < 1 ||
    chunk.certificates.length > MAX_CERTIFICATE_DELTA_CHUNK_COUNT ||
    typeof chunk.signature !== 'string' ||
    !hexDigest.test(chunk.signature)
  )
    throw Error('Contributor certificate delta chunk invalid');
  let minimumBytes = 0;
  for (const certificate of chunk.certificates) {
    minimumBytes += certificateDeltaMinimumBytes(certificate);
    if (minimumBytes > MAX_CERTIFICATE_DELTA_CHUNK_BYTES)
      throw Error('Contributor certificate delta chunk too large');
  }
  if (
    !equalDigest(
      chunk.signature,
      signCertificateDeltaChunk(key, nonce, head, chunk.ordinal!, chunk.certificates),
    )
  )
    throw Error('Contributor certificate delta signature changed');
  const encoded = Buffer.from(JSON.stringify(chunk));
  if (encoded.length > MAX_CERTIFICATE_DELTA_CHUNK_BYTES)
    throw Error('Contributor certificate delta chunk too large');
  return { chunk: chunk as ContributorCertificateDeltaChunk, encoded };
}

export function checkedCertificateDeltaTerminal(
  key: Uint8Array,
  nonce: string,
  head: string,
  value: unknown,
  chunks: number,
  count: number,
  digest: string,
): void {
  const terminal = value as {
    certificateChunks?: unknown;
    certificateCount?: unknown;
    certificateDigest?: unknown;
    certificateSignature?: unknown;
  } | null;
  if (
    !terminal ||
    terminal.certificateChunks !== chunks ||
    terminal.certificateCount !== count ||
    terminal.certificateDigest !== digest ||
    !equalDigest(
      terminal.certificateSignature,
      signCertificateDeltaTerminal(key, nonce, head, chunks, count, digest),
    )
  )
    throw Error('Contributor certificate delta terminal changed');
}
