import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { encryptObject, decryptObject, type VaultKey } from './vault-crypto.ts';

export interface IndexObjectMetadata {
  bytes: number;
  sha256: string;
}
interface IndexReference {
  id: string;
  sequence: number;
  bytes: number;
  sha256: string;
}
interface IndexUsage {
  bytes: number;
  entries: number;
  generations: number;
}
interface IndexHead {
  format: 'circus-health-vault-head-v2';
  profileId: string;
  revision: number;
  indexTip: IndexReference;
  usage: IndexUsage;
  recordsHead: string | null;
}
interface IndexGeneration {
  format: 'circus-health-vault-index-delta-v2';
  profileId: string;
  id: string;
  sequence: number;
  previous: IndexReference | null;
  objects: [string, IndexObjectMetadata][];
  files: [string, string][];
}
export interface VaultIndexLimits {
  generationBytes: number;
  headBytes: number;
  totalBytes: number;
  entries: number;
  generations: number;
}
export const vaultIndexLimits: Readonly<VaultIndexLimits> = Object.freeze({
  generationBytes: 64 * 1024,
  headBytes: 16 * 1024,
  totalBytes: 256 * 1024 * 1024,
  entries: 1_000_000,
  generations: 1_000_000,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  object(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
const integer = (value: unknown, max: number, min = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function fail(): never {
  throw Error('Invalid or unsupported encrypted vault index');
}
export function safeVaultName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > 4096 ||
    value.includes('\\') ||
    value.includes('\0') ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          ['__proto__', 'constructor', 'prototype'].includes(part),
      )
  )
    fail();
  return value;
}
function reference(
  value: unknown,
  limits: Readonly<VaultIndexLimits>,
): asserts value is IndexReference {
  if (
    !exact(value, ['id', 'sequence', 'bytes', 'sha256']) ||
    typeof value.id !== 'string' ||
    !UUID.test(value.id) ||
    !integer(value.sequence, limits.generations, 1) ||
    !integer(value.bytes, limits.generationBytes, 1) ||
    typeof value.sha256 !== 'string' ||
    !HASH.test(value.sha256)
  )
    fail();
}
function metadata(value: unknown): asserts value is IndexObjectMetadata {
  if (
    !exact(value, ['bytes', 'sha256']) ||
    !integer(value.bytes, Number.MAX_SAFE_INTEGER) ||
    typeof value.sha256 !== 'string' ||
    !HASH.test(value.sha256)
  )
    fail();
}
function boundedRead(
  path: string,
  key: VaultKey,
  profileId: string,
  purpose: string,
  bound: number,
): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > bound + 4096)
    fail();
  const chunks: Buffer[] = [];
  let size = 0;
  decryptObject(path, key, profileId, purpose, (chunk) => {
    size += chunk.length;
    if (size > bound) fail();
    chunks.push(chunk);
  });
  return Buffer.concat(chunks);
}
function decode(bytes: Buffer): unknown {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail();
  return JSON.parse(text);
}
function readGeneration(
  directory: string,
  key: VaultKey,
  profileId: string,
  ref: IndexReference,
  limits: Readonly<VaultIndexLimits>,
): IndexGeneration {
  reference(ref, limits);
  const bytes = boundedRead(
    resolve(directory, 'vault/indices', ref.id + '.enc'),
    key,
    profileId,
    `index:${ref.id}`,
    limits.generationBytes,
  );
  if (bytes.length !== ref.bytes || digest(bytes) !== ref.sha256) fail();
  const generation = decode(bytes);
  if (
    !exact(generation, ['format', 'profileId', 'id', 'sequence', 'previous', 'objects', 'files']) ||
    generation.format !== 'circus-health-vault-index-delta-v2' ||
    generation.profileId !== profileId ||
    generation.id !== ref.id ||
    generation.sequence !== ref.sequence ||
    !Array.isArray(generation.objects) ||
    !Array.isArray(generation.files)
  )
    fail();
  if (generation.previous !== null) {
    reference(generation.previous, limits);
    if (generation.previous.sequence !== ref.sequence - 1) fail();
  } else if (ref.sequence !== 1) fail();
  return generation as unknown as IndexGeneration;
}
/** One disposable index writer belongs to the vault's existing single-writer lease. */
export function openVaultIndex(
  directory: string,
  profileId: string,
  key: VaultKey,
  initialize: boolean,
  requestedLimits: Partial<VaultIndexLimits> = {},
) {
  if (
    !object(requestedLimits) ||
    Object.keys(requestedLimits).some((name) => !Object.hasOwn(vaultIndexLimits, name))
  )
    fail();
  const limits: VaultIndexLimits = { ...vaultIndexLimits, ...requestedLimits };
  for (const name of Object.keys(limits) as (keyof VaultIndexLimits)[]) {
    if (!(name in vaultIndexLimits) || !integer(limits[name], vaultIndexLimits[name], 1)) fail();
  }
  if (
    limits.generationBytes < 512 ||
    limits.headBytes < 1024 ||
    limits.totalBytes < limits.generationBytes
  )
    fail();
  const path = resolve(directory, 'vault/manifest.enc');
  let head: IndexHead | undefined;
  const files: Record<string, string> = Object.create(null);
  const objects: Record<string, IndexObjectMetadata> = Object.create(null);
  let knownObjects = new Set<string>();
  if (existsSync(path)) {
    const saved = decode(boundedRead(path, key, profileId, 'manifest', limits.headBytes));
    if (
      !exact(saved, ['format', 'profileId', 'revision', 'indexTip', 'usage', 'recordsHead']) ||
      saved.format !== 'circus-health-vault-head-v2' ||
      saved.profileId !== profileId ||
      !integer(saved.revision, Number.MAX_SAFE_INTEGER, 1) ||
      !(
        saved.recordsHead === null ||
        (typeof saved.recordsHead === 'string' &&
          saved.recordsHead.length <= 8192 &&
          Buffer.from(saved.recordsHead, 'base64').toString('base64') === saved.recordsHead)
      ) ||
      !exact(saved.usage, ['bytes', 'entries', 'generations']) ||
      !integer(saved.usage.bytes, limits.totalBytes) ||
      !integer(saved.usage.entries, limits.entries) ||
      !integer(saved.usage.generations, limits.generations, 1)
    )
      fail();
    reference(saved.indexTip, limits);
    head = saved as unknown as IndexHead;
    let ref: IndexReference | null = head.indexTip;
    const chain: IndexGeneration[] = [];
    const usage: IndexUsage = { bytes: 0, entries: 0, generations: 0 };
    while (ref) {
      usage.bytes += ref.bytes;
      usage.generations++;
      if (usage.bytes > limits.totalBytes || usage.generations > limits.generations) fail();
      const generation = readGeneration(directory, key, profileId, ref, limits);
      usage.entries += generation.objects.length + generation.files.length;
      if (usage.entries > limits.entries) fail();
      chain.push(generation);
      ref = generation.previous;
    }
    if (
      JSON.stringify(usage) !==
      JSON.stringify({
        bytes: head.usage.bytes,
        entries: head.usage.entries,
        generations: head.usage.generations,
      })
    )
      fail();
    for (const generation of chain.reverse()) {
      const names = new Set<string>();
      for (const entry of generation.objects) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          !UUID.test(entry[0]) ||
          knownObjects.has(entry[0])
        )
          fail();
        metadata(entry[1]);
        knownObjects.add(entry[0]);
        objects[entry[0]] = entry[1];
      }
      for (const entry of generation.files) {
        if (!Array.isArray(entry) || entry.length !== 2) fail();
        const name = safeVaultName(entry[0]);
        if (names.has(name) || typeof entry[1] !== 'string' || !knownObjects.has(entry[1])) fail();
        names.add(name);
        files[name] = entry[1];
      }
    }
    for (const id of knownObjects) {
      const content = lstatSync(resolve(directory, 'vault/objects', id + '.enc'));
      if (!content.isFile() || content.isSymbolicLink() || content.nlink !== 1) fail();
    }
  } else {
    if (!initialize) throw Error('Missing authoritative vault manifest');
    for (const part of ['indices', 'objects', 'versions']) {
      const existing = resolve(directory, 'vault', part);
      if (existsSync(existing) && readdirSync(existing).length)
        throw Error('Missing authoritative vault manifest with retained evidence');
    }
  }
  let closed = false;
  return {
    files,
    objects,
    revision: head?.revision ?? 0,
    recordsHead: head?.recordsHead ?? null,
    publish(
      changedFiles: Map<string, string>,
      newObjects: Map<string, IndexObjectMetadata>,
      recordsHead: string | null,
    ): number {
      if (closed) throw Error('Profile is locked');
      if (
        recordsHead !== null &&
        (recordsHead.length > 8192 ||
          Buffer.from(recordsHead, 'base64').toString('base64') !== recordsHead)
      )
        fail();
      for (const [id, value] of newObjects) {
        if (typeof id !== 'string' || !UUID.test(id) || knownObjects.has(id)) fail();
        metadata(value);
      }
      for (const [name, id] of changedFiles) {
        safeVaultName(name);
        if (typeof id !== 'string' || (!knownObjects.has(id) && !newObjects.has(id))) fail();
      }
      const proposed: { generation: IndexGeneration; bytes: Buffer; ref: IndexReference }[] = [];
      let previous = head?.indexTip ?? null;
      const usage: IndexUsage = { ...(head?.usage ?? { bytes: 0, entries: 0, generations: 0 }) };
      let generation: IndexGeneration = {
        format: 'circus-health-vault-index-delta-v2',
        profileId,
        id: randomUUID(),
        sequence: (previous?.sequence ?? 0) + 1,
        previous,
        objects: [],
        files: [],
      };
      const stage = () => {
        const bytes = Buffer.from(JSON.stringify(generation));
        if (bytes.length > limits.generationBytes) fail();
        const ref = {
          id: generation.id,
          sequence: generation.sequence,
          bytes: bytes.length,
          sha256: digest(bytes),
        };
        usage.bytes += bytes.length;
        usage.generations++;
        usage.entries += generation.objects.length + generation.files.length;
        if (
          usage.bytes > limits.totalBytes ||
          usage.generations > limits.generations ||
          usage.entries > limits.entries
        )
          fail();
        proposed.push({ generation, bytes, ref });
        previous = ref;
        generation = {
          ...generation,
          id: randomUUID(),
          sequence: ref.sequence + 1,
          previous: ref,
          objects: [],
          files: [],
        };
      };
      const append = (
        kind: 'objects' | 'files',
        entry: [string, IndexObjectMetadata] | [string, string],
      ) => {
        const list = generation[kind] as (typeof entry)[];
        list.push(entry);
        if (Buffer.byteLength(JSON.stringify(generation)) > limits.generationBytes) {
          list.pop();
          stage();
          (generation[kind] as (typeof entry)[]).push(entry);
        }
      };
      for (const entry of newObjects) append('objects', entry);
      for (const entry of changedFiles) append('files', entry);
      if (generation.objects.length || generation.files.length || !head) stage();
      const candidate: IndexHead = {
        format: 'circus-health-vault-head-v2',
        profileId,
        revision: (head?.revision ?? 0) + 1,
        indexTip: previous!,
        usage,
        recordsHead,
      };
      const bytes = Buffer.from(JSON.stringify(candidate));
      if (bytes.length > limits.headBytes || !Number.isSafeInteger(candidate.revision)) fail();
      try {
        for (const staged of proposed) {
          const target = resolve(directory, 'vault/indices', staged.ref.id + '.enc');
          if (existsSync(target)) fail();
          encryptObject(target, staged.bytes, key, profileId, `index:${staged.ref.id}`);
          // Only the new generation is read; committed ancestors are never replayed here.
          readGeneration(directory, key, profileId, staged.ref, limits);
        }
        encryptObject(path, bytes, key, profileId, 'manifest');
        head = candidate;
        for (const id of newObjects.keys()) knownObjects.add(id);
        return head.revision;
      } catch (error) {
        closed = true;
        throw error;
      }
    },
    close() {
      closed = true;
      head = undefined;
      knownObjects.clear();
      knownObjects = new Set();
    },
  };
}
