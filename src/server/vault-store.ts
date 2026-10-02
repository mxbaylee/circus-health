import { randomUUID, createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  statSync,
  rmSync,
  openSync,
  closeSync,
  readSync,
} from 'node:fs';
import { resolve, relative } from 'node:path';
import { measureImportPhase } from './import-diagnostics.ts';
import { recentPerformanceLimits } from './import-performance.ts';
import { encryptObject, decryptObject, type VaultKey } from './vault-crypto.ts';
import { openVaultIndex, safeVaultName, type VaultIndexLimits } from './vault-index.ts';
import { openDiagnosticChunkStore, type DiagnosticChunkStore } from './diagnostic-chunk-store.ts';

interface VaultObjectMetadata {
  bytes: number;
  sha256: string;
}

export interface VaultMetadata {
  format: 'circus-health-vault-index-v1';
  profileId: string;
  revision: number;
  files: Record<string, string>;
  objects: Record<string, VaultObjectMetadata>;
  recordsHead: string | null;
}

export interface VaultRecordStorage {
  read(name: string): Buffer | null;
  writeImmutable(name: string, bytes: Uint8Array): void;
  publishHead(bytes: Uint8Array): void;
}

export interface Vault {
  put(input: Uint8Array | string): string;
  storeFile(name: string, input: Uint8Array | string): string;
  publish(): void;
  syncWorkspace(
    workspace: string,
    options?: { exclude?: (name: string) => boolean; publishNow?: boolean },
  ): boolean;
  materialize(workspace: string, options?: { exclude?: (name: string) => boolean }): void;
  materializeFile(name: string, workspace: string): boolean;
  verifyFile(name: string, bytes: number, sha256: string): boolean;
  workspaceEstimate(exclude?: (name: string) => boolean): {
    eagerBytes: number;
    deferredBytes: number;
    databasePlanningBytes: number;
  };
  recordStorage(beforeHead?: () => void): VaultRecordStorage;
  readFile(name: string): Buffer | null;
  fileMetadata(name: string): VaultObjectMetadata | null;
  writeCache(path: string, metadata: unknown): void;
  readCache(path: string): unknown;
  metadata(): VaultMetadata;
  readPerformanceSummary(): Uint8Array | null;
  writePerformanceSummary(bytes: Uint8Array): void;
  diagnosticChunks(): DiagnosticChunkStore;
  close(): void;
}

export interface OpenVaultOptions {
  directory: string;
  profileId: string;
  key: VaultKey;
  initialize?: boolean;
  /** Optional stricter contributor/test bounds; defaults cannot be raised. */
  indexLimits?: Partial<VaultIndexLimits>;
}

type CurrentPositionRead = (
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
) => number;

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export function hashFile(path: string): string {
  const fd = openSync(path, 'r'),
    h = createHash('sha256'),
    b = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const n = (readSync as unknown as CurrentPositionRead)(fd, b, 0, b.length);
      if (!n) break;
      h.update(b.subarray(0, n));
    }
    return h.digest('hex');
  } finally {
    closeSync(fd);
  }
}
const safeName = safeVaultName;
function checkPlainTree(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  function visit(path: string): void {
    for (const name of readdirSync(path)) {
      const p = resolve(path, name),
        s = lstatSync(p);
      if (s.isSymbolicLink()) throw Error('Vault workspace cannot contain symbolic links');
      if (s.isDirectory()) visit(p);
      else if (s.isFile()) result.push(relative(root, p));
      else throw Error('Unsupported workspace object');
    }
  }
  visit(root);
  return result;
}
/** One instance belongs to one unlocked profile. Metadata/digest indexes are encrypted. */
export function openVault({
  directory,
  profileId,
  key,
  initialize = false,
  indexLimits,
}: OpenVaultOptions): Vault {
  checkPlainTree(directory);
  const manifestPath = resolve(directory, 'vault', 'manifest.enc');
  let closed = false;
  const pendingFiles = new Map<string, string>();
  const pendingObjects = new Map<string, VaultObjectMetadata>();
  const digests = new Map<string, string[]>();
  let diagnosticChunks: DiagnosticChunkStore | undefined;
  const fingerprints = new Map<string, string>();
  const fingerprint = (path: string): string => {
    const s = statSync(path, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  };
  const guard = (): void => {
    if (closed) throw Error('Profile is locked');
  };
  const index = openVaultIndex(directory, profileId, key, initialize, indexLimits);
  let manifest: VaultMetadata = {
    format: 'circus-health-vault-index-v1',
    profileId,
    revision: index.revision,
    files: index.files,
    objects: index.objects,
    recordsHead: index.recordsHead,
  };
  const rememberDigest = (id: string, meta: VaultObjectMetadata) => {
    const hash = meta.bytes + ':' + meta.sha256;
    const ids = digests.get(hash) ?? [];
    ids.push(id);
    digests.set(hash, ids);
  };
  for (const [id, meta] of Object.entries(manifest.objects)) rememberDigest(id, meta);
  function discard(): void {
    if (closed) return;
    closed = true;
    diagnosticChunks?.close();
    diagnosticChunks = undefined;
    fingerprints.clear();
    pendingFiles.clear();
    pendingObjects.clear();
    digests.clear();
    index.close();
    for (const name of Object.keys(manifest.files)) delete manifest.files[name];
    for (const id of Object.keys(manifest.objects)) delete manifest.objects[id];
    manifest = null!;
  }
  const objectPath = (id: string): string => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw Error('Invalid vault object ID');
    return resolve(directory, 'vault', 'objects', id + '.enc');
  };
  const readObject = (id: string): Buffer => {
    guard();
    const bytes = decryptObject(objectPath(id), key, profileId, `object:${id}`);
    const meta = manifest.objects[id];
    if (!meta || bytes.length !== meta.bytes || digest(bytes) !== meta.sha256)
      throw Error('Original evidence is missing or changed');
    return bytes;
  };
  function put(input: Uint8Array | string): string {
    guard();
    const isBytes = input instanceof Uint8Array,
      size = isBytes ? input.length : statSync(input).size,
      hash = measureImportPhase(
        'vault_hash',
        () => (isBytes ? digest(input) : hashFile(input)),
        { bytes: size },
        { profileId },
      );
    for (const id of digests.get(size + ':' + hash) ?? []) {
      // Establish byte identity, not just equal digests, before reusing ciphertext.
      let fd: number | undefined,
        offset = 0,
        equal = true;
      if (!isBytes) fd = openSync(input, 'r');
      try {
        decryptObject(objectPath(id), key, profileId, `object:${id}`, (chunk) => {
          let actual: Buffer;
          if (isBytes) actual = Buffer.from(input.subarray(offset, offset + chunk.length));
          else {
            actual = Buffer.alloc(chunk.length);
            let pos = 0;
            while (pos < actual.length) {
              const n = (readSync as unknown as CurrentPositionRead)(
                fd!,
                actual,
                pos,
                actual.length - pos,
              );
              if (!n) break;
              pos += n;
            }
            if (pos !== chunk.length) equal = false;
          }
          if (!chunk.equals(actual)) equal = false;
          offset += chunk.length;
        });
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      if (equal && offset === size) return id;
    }
    const id = randomUUID();
    measureImportPhase(
      'vault_encrypt_object',
      () => encryptObject(objectPath(id), input, key, profileId, `object:${id}`),
      { bytes: size },
      { profileId },
    );
    manifest.objects[id] = { bytes: size, sha256: hash };
    pendingObjects.set(id, manifest.objects[id]);
    rememberDigest(id, manifest.objects[id]);
    return id;
  }
  function publish(): void {
    return measureImportPhase('vault_publish_manifest', () => publishInternal(), {}, { profileId });
  }
  function publishInternal(): void {
    guard();
    try {
      // Verify only newly staged objects and changed binding targets, never old index history.
      const ids = new Set([...pendingObjects.keys(), ...pendingFiles.values()]);
      for (const id of ids) {
        const meta = manifest.objects[id];
        const hash = createHash('sha256');
        let bytes = 0;
        decryptObject(objectPath(id), key, profileId, `object:${id}`, (chunk) => {
          bytes += chunk.length;
          hash.update(chunk);
        });
        if (!meta || bytes !== meta.bytes || hash.digest('hex') !== meta.sha256)
          throw Error('Original evidence is missing or changed');
      }
      manifest.revision = index.publish(pendingFiles, pendingObjects, manifest.recordsHead);
      pendingFiles.clear();
      pendingObjects.clear();
    } catch (error) {
      discard();
      throw error;
    }
  }
  function storeFile(name: string, input: Uint8Array | string): string {
    safeName(name);
    const id = put(input);
    if (manifest.files[name] !== id) pendingFiles.set(name, id);
    manifest.files[name] = id;
    return id;
  }
  function syncWorkspace(
    workspace: string,
    {
      exclude = () => false,
      publishNow = true,
    }: { exclude?: (name: string) => boolean; publishNow?: boolean } = {},
  ): boolean {
    guard();
    let changed = false;
    for (const name of checkPlainTree(workspace)) {
      if (exclude(name)) continue;
      const source = resolve(workspace, name),
        previous = manifest.files[name],
        meta = manifest.objects[previous],
        stamp = fingerprint(source);
      if (meta && fingerprints.get(source) === stamp) continue;
      if (meta && meta.bytes === statSync(source).size && meta.sha256 === hashFile(source)) {
        fingerprints.set(source, stamp);
        continue;
      }
      storeFile(name, source);
      fingerprints.set(source, stamp);
      changed = true;
    }
    // Removal is explicit in records; retained artifacts are never physically deleted here.
    if (changed && publishNow) publish();
    return changed;
  }
  function materializeFile(name: string, workspace: string): boolean {
    guard();
    safeName(name);
    const id = manifest.files[name];
    if (!id) return false;
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    if (lstatSync(workspace).isSymbolicLink() || !lstatSync(workspace).isDirectory())
      throw Error('Vault workspace cannot contain symbolic links');
    let parent = resolve(workspace);
    for (const segment of name.split('/').slice(0, -1)) {
      parent = resolve(parent, segment);
      if (
        existsSync(parent) &&
        (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())
      )
        throw Error('Vault workspace cannot contain symbolic links');
    }
    const target = resolve(workspace, name);
    if (existsSync(target) && lstatSync(target).isSymbolicLink())
      throw Error('Vault workspace cannot contain symbolic links');
    decryptObject(objectPath(id), key, profileId, `object:${id}`, target);
    const meta = manifest.objects[id];
    if (!meta || statSync(target).size !== meta.bytes || hashFile(target) !== meta.sha256) {
      rmSync(target, { force: true });
      throw Error('Original evidence is missing or changed');
    }
    fingerprints.set(target, fingerprint(target));
    return true;
  }
  function materialize(
    workspace: string,
    { exclude = () => false }: { exclude?: (name: string) => boolean } = {},
  ): void {
    guard();
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    for (const name of Object.keys(manifest.files))
      if (!exclude(name)) materializeFile(name, workspace);
  }
  function recordStorage(beforeHead?: () => void): VaultRecordStorage {
    const recordPath = (name: string): string => {
      if (!/^objects\/[0-9a-f-]{36}$/.test(name)) throw Error('Invalid record storage name');
      return resolve(directory, 'vault/versions', name.slice(8) + '.enc');
    };
    return {
      read(name: string): Buffer | null {
        guard();
        if (name === 'head')
          return manifest.recordsHead ? Buffer.from(manifest.recordsHead, 'base64') : null;
        const path = recordPath(name);
        return existsSync(path) ? decryptObject(path, key, profileId, `record:${name}`) : null;
      },
      writeImmutable(name: string, bytes: Uint8Array): void {
        guard();
        const path = recordPath(name);
        if (existsSync(path)) {
          if (!decryptObject(path, key, profileId, `record:${name}`).equals(bytes))
            throw Error('Immutable record object changed');
          return;
        }
        encryptObject(path, bytes, key, profileId, `record:${name}`);
      },
      publishHead(bytes: Uint8Array): void {
        guard();
        try {
          beforeHead?.();
          manifest.recordsHead = Buffer.from(bytes).toString('base64');
          publish();
        } catch (error) {
          discard();
          throw error;
        }
      },
    };
  }
  if (initialize && !existsSync(manifestPath)) publish();
  return {
    put,
    storeFile,
    publish,
    syncWorkspace,
    materialize,
    materializeFile,
    verifyFile(name: string, bytes: number, sha256: string): boolean {
      guard();
      safeName(name);
      const id = manifest.files[name],
        meta = manifest.objects[id];
      if (!id || !meta || meta.bytes !== bytes || meta.sha256 !== sha256) return false;
      const hash = createHash('sha256');
      let actual = 0;
      decryptObject(objectPath(id), key, profileId, `object:${id}`, (chunk) => {
        actual += chunk.length;
        hash.update(chunk);
      });
      return actual === bytes && hash.digest('hex') === sha256;
    },
    workspaceEstimate(exclude = () => false) {
      guard();
      let eagerBytes = 0,
        deferredBytes = 0;
      for (const [name, id] of Object.entries(manifest.files)) {
        safeName(name);
        const bytes = manifest.objects[id]?.bytes;
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('Invalid vault object size');
        if (exclude(name)) deferredBytes += bytes;
        else eagerBytes += bytes;
      }
      const cache = resolve(directory, 'cache/sqlite.enc');
      const databasePlanningBytes = Math.max(
        64 * 1024 * 1024,
        existsSync(cache) ? statSync(cache).size * 2 : 0,
      );
      if (![eagerBytes, deferredBytes, databasePlanningBytes].every(Number.isSafeInteger))
        throw Error('Invalid vault workspace size');
      return { eagerBytes, deferredBytes, databasePlanningBytes };
    },
    recordStorage,
    readFile(name: string): Buffer | null {
      guard();
      safeName(name);
      const id = manifest.files[name];
      return id ? readObject(id) : null;
    },
    fileMetadata(name) {
      guard();
      safeName(name);
      const value = manifest.objects[manifest.files[name]];
      return value ? { ...value } : null;
    },
    writeCache(path: string, metadata: unknown): void {
      guard();
      encryptObject(resolve(directory, 'cache/sqlite.enc'), path, key, profileId, 'sqlite-cache');
      encryptObject(
        resolve(directory, 'cache/metadata.enc'),
        Buffer.from(JSON.stringify(metadata)),
        key,
        profileId,
        'sqlite-cache-meta',
      );
    },
    readCache(path: string): unknown {
      guard();
      try {
        const metadata = JSON.parse(
          decryptObject(
            resolve(directory, 'cache/metadata.enc'),
            key,
            profileId,
            'sqlite-cache-meta',
          ) as unknown as string,
        ) as unknown;
        decryptObject(resolve(directory, 'cache/sqlite.enc'), key, profileId, 'sqlite-cache', path);
        return metadata;
      } catch {
        rmSync(path, { force: true });
        return null;
      }
    },
    readPerformanceSummary() {
      guard();
      const path = resolve(directory, 'diagnostics/recent-performance.enc');
      if (!existsSync(path)) return null;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > recentPerformanceLimits.maxBytes + 4096)
        throw Error('Invalid diagnostic summary size');
      return decryptObject(path, key, profileId, 'recent-performance-v1');
    },
    diagnosticChunks() {
      guard();
      return (diagnosticChunks ??= openDiagnosticChunkStore({
        directory: resolve(directory, 'diagnostics/events'),
        profileId,
        key,
        guard,
      }));
    },
    writePerformanceSummary(bytes) {
      guard();
      if (bytes.byteLength > recentPerformanceLimits.maxBytes)
        throw Error('Diagnostic summary limit');
      encryptObject(
        resolve(directory, 'diagnostics/recent-performance.enc'),
        bytes,
        key,
        profileId,
        'recent-performance-v1',
      );
    },
    metadata(): VaultMetadata {
      guard();
      return structuredClone(manifest);
    },
    close(): void {
      if (!closed) discard();
    },
  };
}
