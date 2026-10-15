import sodium from 'libsodium-wrappers-sumo';
import { randomBytes, hkdfSync } from 'node:crypto';
import { archiveRefusal } from './archive-refusal.ts';
import {
  openSync,
  closeSync,
  readSync,
  writeSync,
  fsyncSync,
  renameSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { beginManagedPhysicalMutation } from './clinical-review-physical-epoch.ts';
import { dirname } from 'node:path';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
await sodium.ready;
const MAGIC = Buffer.from('CIRCUS01');
const CHUNK = 1024 * 1024;
const HEADER = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
const OVERHEAD = sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
export interface WrappedKey {
  algorithm: 'xchacha20poly1305-ietf';
  nonce: string;
  ciphertext: string;
}

export interface RecoveryKit {
  format: 'circus-health-recovery-v1';
  profileId: string;
  phrase: string;
}

export type RecoveryInput = string | RecoveryKit;
export type VaultKey = Buffer;
export type EncryptedObjectSink = string | ((chunk: Buffer) => void);
type CurrentPositionRead = (
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
) => number;
type CurrentPositionWrite = CurrentPositionRead;

const context = (profileId: string, purpose: string): Buffer =>
  Buffer.from(JSON.stringify(['circus-health-vault-v1', profileId, purpose]));
export const freshKey = (): VaultKey => randomBytes(32);
export function recoveryPhrase(secret: Uint8Array): string {
  if (secret.length !== 32) throw Error('Recovery entropy must be 256 bits');
  return entropyToMnemonic(secret, wordlist);
}
export function recoveryEntropy(input: unknown, profileId: string): Buffer {
  if (typeof input === 'object' && input) {
    if (
      (input as Partial<RecoveryKit>).format !== 'circus-health-recovery-v1' ||
      (input as Partial<RecoveryKit>).profileId !== profileId
    )
      throw Error('Recovery file belongs to another profile or is unsupported');
    input = (input as Partial<RecoveryKit>).phrase;
  }
  if (typeof input !== 'string' || input.length > 512)
    throw Error('Enter the complete 24-word recovery key');
  const value = Buffer.from(
    mnemonicToEntropy(input.trim().toLowerCase().replace(/\s+/g, ' '), wordlist),
  );
  if (value.length !== 32) throw Error('Enter the complete 24-word recovery key');
  return value;
}
function wrappingKey(secret: Uint8Array, profileId: string, method: string): Buffer {
  if (secret.length !== 32) throw Error('Invalid unlock material');
  return Buffer.from(
    hkdfSync('sha256', secret, Buffer.from(profileId), context(profileId, `wrap:${method}`), 32),
  );
}
export function wrapKey(
  key: Uint8Array,
  secret: Uint8Array,
  profileId: string,
  method = 'recovery',
): WrappedKey {
  const derived = wrappingKey(secret, profileId, method),
    nonce = randomBytes(24);
  try {
    return {
      algorithm: 'xchacha20poly1305-ietf',
      nonce: nonce.toString('base64url'),
      ciphertext: Buffer.from(
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          key,
          context(profileId, method),
          null,
          nonce,
          derived,
        ),
      ).toString('base64url'),
    };
  } finally {
    derived.fill(0);
  }
}
export function unwrapKey(
  wrapped: unknown,
  secret: Uint8Array,
  profileId: string,
  method = 'recovery',
): VaultKey {
  if ((wrapped as Partial<WrappedKey> | null)?.algorithm !== 'xchacha20poly1305-ietf')
    throw Error('Unsupported key format');
  const nonce = Buffer.from((wrapped as Partial<WrappedKey>).nonce!, 'base64url'),
    bytes = Buffer.from((wrapped as Partial<WrappedKey>).ciphertext!, 'base64url'),
    derived = wrappingKey(secret, profileId, method);
  try {
    if (nonce.length !== 24 || bytes.length !== 48) throw Error('Invalid wrapped key');
    const key = Buffer.from(
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        bytes,
        context(profileId, method),
        nonce,
        derived,
      ),
    );
    if (key.length !== 32) throw Error('Invalid wrapped key');
    return key;
  } finally {
    derived.fill(0);
  }
}
function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length)
    offset += (writeSync as unknown as CurrentPositionWrite)(
      fd,
      bytes,
      offset,
      bytes.length - offset,
    );
}
function readExact(fd: number, length: number): Buffer;
function readExact(fd: number, length: number, allowEnd: true): Buffer | null;
function readExact(fd: number, length: number, allowEnd = false): Buffer | null {
  const out = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const n = (readSync as unknown as CurrentPositionRead)(fd, out, offset, length - offset);
    if (!n) {
      if (!offset && allowEnd) return null;
      throw Error('Truncated encrypted object');
    }
    offset += n;
  }
  return out;
}
function atomicOutput(path: string, fn: (fd: number) => void): void {
  const finishMutation = beginManagedPhysicalMutation();
  try {
    atomicOutputOwned(path, fn);
  } finally {
    finishMutation();
  }
}
function atomicOutputOwned(path: string, fn: (fd: number) => void): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const pending = `${path}.pending-${randomBytes(12).toString('hex')}`;
  let fd: number | undefined;
  try {
    fd = openSync(pending, 'wx', 0o600);
    fn(fd);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(pending, path);
    const dir = openSync(dirname(path), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    rmSync(pending, { force: true });
    throw e;
  }
}
/** Streaming authenticated encryption; only the framing is application-owned. */
export function encryptObject(
  path: string,
  input: Uint8Array | string,
  key: Uint8Array,
  profileId: string,
  purpose: string,
): void {
  atomicOutput(path, (fd) => encryptObjectToFileDescriptor(fd, input, key, profileId, purpose));
}

/** The caller owns the already-open descriptor, publication and mutation tracking. */
export function encryptObjectToFileDescriptor(
  fd: number,
  input: Uint8Array | string,
  key: Uint8Array,
  profileId: string,
  purpose: string,
): void {
  const isBytes = input instanceof Uint8Array;
  let source: number | undefined;
  if (!isBytes) source = openSync(input, 'r');
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const aad = context(profileId, purpose);
  try {
    writeAll(fd, MAGIC);
    writeAll(fd, header);
    let pos = 0;
    for (;;) {
      let plain: Uint8Array;
      if (isBytes) {
        plain = input.subarray(pos, pos + CHUNK);
        pos += plain.length;
      } else {
        const chunk = Buffer.alloc(CHUNK);
        const n = (readSync as unknown as CurrentPositionRead)(source!, chunk, 0, CHUNK);
        plain = chunk.subarray(0, n);
      }
      const last = plain.length === 0;
      const cipher = sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        plain,
        aad,
        last
          ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
          : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
      );
      const length = Buffer.alloc(4);
      length.writeUInt32BE(cipher.length);
      writeAll(fd, length);
      writeAll(fd, cipher);
      if (last) break;
    }
  } finally {
    if (source !== undefined) closeSync(source);
  }
}
export function decryptObject(
  path: string,
  key: Uint8Array,
  profileId: string,
  purpose: string,
  outputPath?: undefined,
  maxBytes?: number,
): Buffer;
export function decryptObject(
  path: string,
  key: Uint8Array,
  profileId: string,
  purpose: string,
  outputPath: EncryptedObjectSink,
  maxBytes?: number,
): { bytes: number };
export function decryptObject(
  path: string,
  key: Uint8Array,
  profileId: string,
  purpose: string,
  outputPath?: EncryptedObjectSink,
  maxBytes = 64 * 1024 * 1024,
): Buffer | { bytes: number } {
  const source = openSync(path, 'r'),
    aad = context(profileId, purpose),
    chunks: Buffer[] = [];
  let size = 0;
  function decode(fd?: number | ((chunk: Buffer) => void)): void {
    if (!readExact(source, MAGIC.length).equals(MAGIC))
      throw archiveRefusal(
        'Profile encrypted object format',
        'This profile’s records and history are unavailable.',
      );
    const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
      readExact(source, HEADER),
      key,
    );
    for (;;) {
      const len = readExact(source, 4).readUInt32BE();
      if (len < OVERHEAD || len > CHUNK + OVERHEAD) throw Error('Invalid encrypted frame');
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
        state,
        readExact(source, len),
        aad,
      );
      if (!result) throw Error('Encrypted object authentication failed');
      size += result.message.length;
      if (!outputPath && size > maxBytes) throw Error('Encrypted object exceeds memory read limit');
      if (typeof fd === 'function') fd(Buffer.from(result.message));
      else if (fd !== undefined) writeAll(fd, result.message);
      else chunks.push(Buffer.from(result.message));
      if (result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
        if (readExact(source, 1, true)) throw Error('Unexpected bytes after encrypted object');
        break;
      }
      if (result.tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE)
        throw archiveRefusal(
          'Profile encrypted frame tag',
          'This profile’s records and history are unavailable.',
        );
    }
  }
  try {
    if (typeof outputPath === 'function') decode(outputPath);
    else if (outputPath) atomicOutput(outputPath, decode);
    else decode();
    return outputPath ? { bytes: size } : Buffer.concat(chunks);
  } finally {
    closeSync(source);
  }
}
