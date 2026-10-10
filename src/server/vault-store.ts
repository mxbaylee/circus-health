import { randomUUID, createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync as rawMkdirSync,
  readdirSync,
  lstatSync,
  statSync,
  rmSync as rawRmSync,
  openSync,
  closeSync,
  readSync,
  opendirSync,
  realpathSync,
  fstatSync,
  fsyncSync,
  linkSync,
  unlinkSync,
  constants as fsConstants,
  renameSync,
  type Dir,
} from 'node:fs';
import {
  withManagedPhysicalMutation,
  beginManagedPhysicalMutation,
  captureManagedPhysicalEpoch,
  managedPhysicalEpochCurrent,
  managedPhysicalMutationSequence,
} from './clinical-review-physical-epoch.ts';
import type { DatabaseSync } from 'node:sqlite';
import { currentTransactionToken } from './database.ts';
import {
  currentClinicalOperation,
  assertClinicalOperation,
  type ClinicalOperation,
} from './clinical-operation.ts';
import {
  prepareVaultRecordBackingTransport,
  type VaultRecordBackingBinding,
} from './vault-record-backing.ts';

const mkdirSync: typeof rawMkdirSync = (...args) =>
  withManagedPhysicalMutation(() => rawMkdirSync(...args));
const rmSync: typeof rawRmSync = (...args) => withManagedPhysicalMutation(() => rawRmSync(...args));
import { resolve, relative, dirname } from 'node:path';
import { measureImportPhase } from './import-diagnostics.ts';
import { recentPerformanceLimits } from './import-performance.ts';
import {
  encryptObject,
  encryptObjectToFileDescriptor,
  decryptObject,
  type VaultKey,
} from './vault-crypto.ts';
import { openVaultIndexSteps, safeVaultName, type VaultIndexLimits } from './vault-index.ts';
import { setImmediate as yieldHost } from 'node:timers/promises';
import { openDiagnosticChunkStore, type DiagnosticChunkStore } from './diagnostic-chunk-store.ts';

export type VaultDiagnosticWriter = (sequence: number, bytes: Uint8Array) => void;
const diagnosticWriters = new WeakMap<
  VaultDiagnosticWriter,
  { directory: string; profileId: string }
>();

/** Only openVault can mint a writer, and its destination is fixed in its closure. */
export function isVaultDiagnosticWriter(
  writer: VaultDiagnosticWriter,
  directory: string,
  profileId: string,
): boolean {
  const bound = diagnosticWriters.get(writer);
  return bound?.directory === resolve(directory) && bound.profileId === profileId;
}

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

declare const stagingWitnessBrand: unique symbol;
export interface VaultRecordStagingWitness {
  readonly [stagingWitnessBrand]: true;
}
interface RecordParent {
  path: string;
  dev: bigint;
  ino: bigint;
  mode: bigint;
}
interface RecordStagingOwner {
  storage: VaultRecordStorage;
  read: VaultRecordStorage['read'];
  write: VaultRecordStorage['writeImmutable'];
  publish: VaultRecordStorage['publishHead'];
  directory: string;
  profileId: string;
  key: VaultKey;
  guard(): void;
  live(): boolean;
  prepareHead(): void;
  installHead(bytes: Uint8Array): void;
  workspace?: string;
  workspaceEpoch(): object;
  workspaceNames(): readonly string[];
  compactReady(): boolean;
}
interface RecordStagingData {
  owner: RecordStagingOwner;
  db: DatabaseSync;
  originalEpoch: object;
  approvedEpoch: object;
  sequence: bigint;
  parents: RecordParent[];
  transaction?: object;
  revoked: boolean;
  headPrepared?: boolean;
  preparation?: ClinicalOperation;
  preparationComplete?: boolean;
  backing?: Awaited<ReturnType<typeof prepareVaultRecordBackingTransport>>;
  workspaceEpoch: object;
}
const recordStagingOwners = new WeakMap<object, RecordStagingOwner>();
const recordStagingWitnesses = new WeakMap<VaultRecordStagingWitness, RecordStagingData>();

function recordParent(path: string): RecordParent {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw Error('Immutable record parent changed');
  return { path, dev: stat.dev, ino: stat.ino, mode: stat.mode };
}
function recordParentsCurrent(parents: RecordParent[]): boolean {
  return parents.every((parent) => {
    const current = recordParent(parent.path);
    return current.dev === parent.dev && current.ino === parent.ino && current.mode === parent.mode;
  });
}
function recordStagingMethodsCurrent(owner: RecordStagingOwner): boolean {
  return (
    owner.live() &&
    owner.storage.read === owner.read &&
    owner.storage.writeImmutable === owner.write &&
    owner.storage.publishHead === owner.publish
  );
}
/** Only the actual vault factory has a registered lexical owner. No caller path
 * or post-write physical baseline can produce this continuation. */
export function captureVaultRecordStaging(
  db: DatabaseSync,
  storage: object,
  originalEpoch: object,
): VaultRecordStagingWitness | undefined {
  const owner = recordStagingOwners.get(storage);
  if (!owner) return undefined;
  if (!recordStagingMethodsCurrent(owner) || !managedPhysicalEpochCurrent(originalEpoch))
    throw Error('Immutable record staging owner changed');
  owner.guard();
  const parents = [
    owner.directory,
    resolve(owner.directory, 'vault'),
    resolve(owner.directory, 'vault/versions'),
  ].map(recordParent);
  if (!recordStagingMethodsCurrent(owner) || !managedPhysicalEpochCurrent(originalEpoch))
    throw Error('Immutable record staging interval changed');
  const witness = Object.freeze({}) as VaultRecordStagingWitness;
  recordStagingWitnesses.set(witness, {
    owner,
    db,
    originalEpoch,
    approvedEpoch: originalEpoch,
    sequence: managedPhysicalMutationSequence(),
    parents,
    revoked: false,
    workspaceEpoch: owner.workspaceEpoch(),
  });
  return witness;
}
/** Closing check only; no filesystem, SQL, storage or authorization callback. */
export function vaultRecordStagingCurrent(witness: VaultRecordStagingWitness): boolean {
  const data = recordStagingWitnesses.get(witness);
  if (data?.preparation) {
    try {
      assertClinicalOperation(data.db, data.preparation);
    } catch {
      return false;
    }
  }
  return (
    !!data &&
    !data.revoked &&
    data.db.isOpen &&
    recordStagingMethodsCurrent(data.owner) &&
    data.owner.workspaceEpoch() === data.workspaceEpoch &&
    managedPhysicalEpochCurrent(data.approvedEpoch) &&
    managedPhysicalMutationSequence() === data.sequence &&
    (!data.transaction ||
      (data.db.isTransaction && currentTransactionToken(data.db) === data.transaction))
  );
}
export function discardVaultRecordStaging(witness: VaultRecordStagingWitness): void {
  const data = recordStagingWitnesses.get(witness);
  if (data) data.revoked = true;
  data?.backing?.close();
  recordStagingWitnesses.delete(witness);
}
/** Adapter-owned accepted evidence preparation, never a caller path/epoch proof. */
export async function prepareVaultRecordStagingBacking(
  witness: VaultRecordStagingWitness,
  selectedHead: string,
  binding: VaultRecordBackingBinding,
  assertCurrent: () => void,
): Promise<void> {
  const data = recordStagingWitnesses.get(witness),
    operation = data && currentClinicalOperation(data.db);
  if (
    !data ||
    !operation ||
    data.db.isTransaction ||
    data.backing ||
    data.preparation ||
    !vaultRecordStagingCurrent(witness)
  )
    throw Error('Vault compact backing preparation unavailable');
  data.preparation = operation;
  const check = () => {
    assertCurrent();
    if (!vaultRecordStagingCurrent(witness)) throw Error('Vault compact backing owner changed');
  };
  try {
    check();
    // Configured profile workspaces have their accepted manifest/physical
    // comparison in the worker. Other actual adapters retain their callback.
    if (!data.owner.compactReady())
      throw Error('Vault compact preparation has unpublished changes');
    if (!data.owner.workspace) data.owner.prepareHead();
    check();
    data.backing = await prepareVaultRecordBackingTransport(
      data.owner.directory,
      data.owner.profileId,
      data.owner.key,
      selectedHead,
      binding,
      check,
      data.owner.workspace,
      data.owner.workspaceNames(),
    );
    check();
  } catch (error) {
    data.revoked = true;
    data.backing?.close();
    throw error;
  }
}
export async function finishVaultRecordStagingPreparation(
  witness: VaultRecordStagingWitness,
): Promise<void> {
  const data = recordStagingWitnesses.get(witness);
  if (!data?.backing || data.preparationComplete || !vaultRecordStagingCurrent(witness))
    throw Error('Vault compact backing completion expired');
  await data.backing.verify();
  if (!vaultRecordStagingCurrent(witness)) throw Error('Vault compact backing seal changed');
  data.preparationComplete = true;
}
export async function assertVaultRecordMetadataPrior(
  witness: VaultRecordStagingWitness,
  key: string,
  value: string | undefined,
  previous: { versionId: string; contents: string; deleted: number } | undefined,
): Promise<void> {
  const data = recordStagingWitnesses.get(witness);
  if (!data?.backing || !vaultRecordStagingCurrent(witness))
    throw Error('Vault accepted metadata proof unavailable');
  await data.backing.assertMetadataPrior(key, value, previous);
  if (!vaultRecordStagingCurrent(witness)) throw Error('Vault accepted metadata seal changed');
}
export function bindVaultRecordStagingTransaction(witness: VaultRecordStagingWitness): void {
  const data = recordStagingWitnesses.get(witness),
    token = data && currentTransactionToken(data.db);
  if (
    !data?.preparationComplete ||
    !token ||
    !data.db.isTransaction ||
    data.transaction ||
    !vaultRecordStagingCurrent(witness)
  )
    throw Error('Vault compact staging transaction expired');
  data.transaction = token;
}
/** The callback completes before the private compact consumer's last seal. */
export function prepareVaultRecordHead(witness: VaultRecordStagingWitness): void {
  const data = recordStagingWitnesses.get(witness);
  if (!data || data.headPrepared || !data.transaction || !vaultRecordStagingCurrent(witness))
    throw Error('Immutable record head preparation expired');
  try {
    if (!data.preparationComplete) data.owner.prepareHead();
    if (!vaultRecordStagingCurrent(witness) || !recordParentsCurrent(data.parents))
      throw Error('Immutable record head preparation changed authority');
    data.headPrepared = true;
  } catch (error) {
    data.revoked = true;
    throw error;
  }
}
/** Only the lexical factory installs HEAD; no storage/user callback follows
 * the caller's final SQL/physical seal. New-object receipts never admit HEAD. */
export function installVaultRecordHead(
  witness: VaultRecordStagingWitness,
  bytes: Uint8Array,
): void {
  const data = recordStagingWitnesses.get(witness);
  if (!data || !data.headPrepared || !vaultRecordStagingCurrent(witness))
    throw Error('Immutable record head publication expired');
  data.revoked = true;
  data.owner.installHead(Buffer.from(bytes));
}
function hashRecordCiphertext(fd: number): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  for (let offset = 0; ;) {
    const count = readSync(fd, buffer, 0, buffer.length, offset);
    if (!count) return hash.digest('hex');
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
}
/** Create-only changed-object staging. Its private continuation remains rooted
 * in the original authority interval; HEAD and existing objects are excluded. */
export function stageVaultRecordObject(
  witness: VaultRecordStagingWitness,
  ref: { name: string; sha256: string; bytes: number },
  input: Uint8Array,
): void {
  const data = recordStagingWitnesses.get(witness);
  if (
    !data ||
    !vaultRecordStagingCurrent(witness) ||
    data.preparationComplete ||
    (!data.db.isTransaction && !data.preparation)
  )
    throw Error('Immutable record staging continuation expired');
  const token = currentTransactionToken(data.db);
  if (
    (data.db.isTransaction && !token) ||
    (data.transaction && data.transaction !== token) ||
    (data.preparation && data.db.isTransaction)
  )
    throw Error('Immutable record staging transaction changed');
  if (token) data.transaction = token;
  // Copy before any authorization/readback callback can mutate caller bytes.
  const bytes = Buffer.from(input),
    reference = { ...ref };
  if (
    !/^objects\/[0-9a-f-]{36}$/.test(reference.name) ||
    bytes.length !== reference.bytes ||
    digest(bytes) !== reference.sha256
  ) {
    data.revoked = true;
    throw Error('Immutable record staging reference changed');
  }
  const owner = data.owner;
  try {
    owner.guard();
    if (!recordParentsCurrent(data.parents) || !vaultRecordStagingCurrent(witness))
      throw Error('Immutable record staging parent or interval changed');
  } catch (error) {
    data.revoked = true;
    throw error;
  }
  const path = resolve(owner.directory, 'vault/versions', reference.name.slice(8) + '.enc');
  try {
    data.backing?.beforeNewRecord(path);
  } catch (error) {
    data.revoked = true;
    throw error;
  }
  const pending = path + '.pending-' + randomUUID();
  const predecessor = data.approvedEpoch,
    sequence = data.sequence;
  let fd: number | undefined,
    installed = false,
    created: { dev: bigint; ino: bigint } | undefined,
    verified: { mtime: bigint; ctime: bigint } | undefined;
  const finish = beginManagedPhysicalMutation();
  try {
    fd = openSync(pending, 'wx+', 0o600);
    const initial = fstatSync(fd, { bigint: true });
    created = { dev: initial.dev, ino: initial.ino };
    encryptObjectToFileDescriptor(
      fd,
      bytes,
      owner.key,
      owner.profileId,
      `record:${reference.name}`,
    );
    fsyncSync(fd);
    const staged = fstatSync(fd, { bigint: true }),
      cipherHash = hashRecordCiphertext(fd);
    closeSync(fd);
    fd = undefined;
    // link refuses an already present target, unlike overwrite rename.
    linkSync(pending, path);
    installed = true;
    unlinkSync(pending);
    const directory = openSync(
      data.parents[2]!.path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const parent = fstatSync(directory, { bigint: true });
      if (parent.dev !== data.parents[2]!.dev || parent.ino !== data.parents[2]!.ino)
        throw Error('Immutable record staging parent replaced');
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    const readback = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const actual = fstatSync(readback, { bigint: true });
      if (
        actual.dev !== staged.dev ||
        actual.ino !== staged.ino ||
        actual.size !== staged.size ||
        actual.nlink !== 1n ||
        hashRecordCiphertext(readback) !== cipherHash
      )
        throw Error('Immutable record staging ciphertext changed');
      verified = { mtime: actual.mtimeNs, ctime: actual.ctimeNs };
    } finally {
      closeSync(readback);
    }
    if (
      !decryptObject(path, owner.key, owner.profileId, `record:${reference.name}`).equals(bytes) ||
      !recordParentsCurrent(data.parents) ||
      !recordStagingMethodsCurrent(owner)
    )
      throw Error('Immutable record staging readback or owner changed');
    const final = lstatSync(path, { bigint: true });
    if (
      final.dev !== staged.dev ||
      final.ino !== staged.ino ||
      final.size !== staged.size ||
      final.nlink !== 1n ||
      final.mtimeNs !== verified!.mtime ||
      final.ctimeNs !== verified!.ctime
    )
      throw Error('Immutable record staging target replaced');
  } catch (error) {
    data.revoked = true;
    if (fd !== undefined) closeSync(fd);
    // Installed objects stay unselected. Never delete a competing target.
    if (!installed && created && recordParentsCurrent(data.parents) && existsSync(pending)) {
      const leftover = lstatSync(pending, { bigint: true });
      if (leftover.dev === created.dev && leftover.ino === created.ino) unlinkSync(pending);
    }
    throw error;
  } finally {
    finish();
  }
  const successor = captureManagedPhysicalEpoch();
  if (
    !successor ||
    data.approvedEpoch !== predecessor ||
    managedPhysicalMutationSequence() !== sequence + 2n
  ) {
    data.revoked = true;
    throw Error('Immutable record staging has an unknown mutation');
  }
  // Only this successful lexical leaf may advance its private continuation.
  data.approvedEpoch = successor;
  data.sequence = sequence + 2n;
  try {
    data.backing?.afterNewRecord(path);
  } catch (error) {
    data.revoked = true;
    throw error;
  }
}

export interface Vault {
  put(input: Uint8Array | string): string;
  storeFile(name: string, input: Uint8Array | string): string;
  publish(): void;
  /** Exact selected files supplied by an authority writer, retained until publication. */
  trackWorkspaceFiles(workspace: string, names: readonly string[]): void;
  syncWorkspace(
    workspace: string,
    options?: {
      exclude?: (name: string) => boolean;
      excludeDirectory?: (name: string) => boolean;
      publishNow?: boolean;
    },
  ): boolean;
  materialize(workspace: string, options?: { exclude?: (name: string) => boolean }): void;
  materializeFile(name: string, workspace: string): boolean;
  verifyFile(name: string, bytes: number, sha256: string): boolean;
  workspaceEstimate(exclude?: (name: string) => boolean): {
    eagerBytes: number;
    deferredBytes: number;
    databasePlanningBytes: number;
  };
  recordStorage(beforeHead?: () => void, compactWorkspace?: string): VaultRecordStorage;
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
function checkPlainTree(root: string, excludeDirectory = (_name: string) => false): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  function visit(path: string): void {
    for (const name of readdirSync(path)) {
      const p = resolve(path, name);
      // A selected authority supplies its changed names separately. Do not even
      // inventory its retained history during an unrelated workspace flush.
      if (excludeDirectory(relative(root, p))) continue;
      const s = lstatSync(p);
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
function* verifyTreeSteps(root: string): Generator<void, void, void> {
  const stack: { directory: Dir; path: string }[] = [];
  if (!existsSync(root)) return;
  stack.push({ directory: opendirSync(root), path: root });
  try {
    while (stack.length) {
      const current = stack[stack.length - 1]!;
      const entry = current.directory.readSync();
      if (!entry) {
        current.directory.closeSync();
        stack.pop();
      } else {
        const path = resolve(current.path, entry.name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw Error('Vault workspace cannot contain symbolic links');
        if (stat.isDirectory()) stack.push({ directory: opendirSync(path), path });
        else if (!stat.isFile()) throw Error('Unsupported workspace object');
      }
      yield;
    }
  } finally {
    for (const current of stack) current.directory.closeSync();
  }
}
function* openVaultSteps({
  directory,
  profileId,
  key,
  initialize = false,
  indexLimits,
}: OpenVaultOptions): Generator<void, Vault, void> {
  yield* verifyTreeSteps(directory);
  if (initialize && !existsSync(directory))
    withManagedPhysicalMutation(() => mkdirSync(directory, { recursive: true, mode: 0o700 }));
  // Resolve a configured path alias once, before the lexical storage owner and
  // index retain their paths. Publication never adopts a later alias target.
  directory = realpathSync(directory);
  const manifestPath = resolve(directory, 'vault', 'manifest.enc');
  let closed = false;
  const pendingFiles = new Map<string, string>();
  const pendingObjects = new Map<string, VaultObjectMetadata>();
  const selectedWorkspaceFiles = new Map<string, Set<string>>();
  let workspaceEpoch: object = Object.freeze({});
  const stagedWorkspaceFiles = new Map<string, Set<string>>();
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
  let index = yield* openVaultIndexSteps(directory, profileId, key, initialize, indexLimits);
  // Establish the non-authoritative namespace before any retained proof can escape.
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonicalRoot = realpathSync(directory);
  const diagnosticDirectory = resolve(canonicalRoot, 'diagnostics');
  const eventDirectory = resolve(diagnosticDirectory, 'events');
  const containers: { path: string; identity: string }[] = [];
  const directoryIdentity = (path: string): string => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || realpathSync(path) !== path)
      throw Error('Diagnostic namespace changed');
    return `${stat.dev}:${stat.ino}`;
  };
  try {
    for (let path = canonicalRoot; ; path = dirname(path)) {
      containers.push({ path, identity: directoryIdentity(path) });
      if (dirname(path) === path) break;
    }
    for (const path of [diagnosticDirectory, eventDirectory]) {
      if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
      containers.push({ path, identity: directoryIdentity(path) });
    }
  } catch (error) {
    index.close();
    throw error;
  }
  const guardDiagnostics = () => {
    guard();
    if (realpathSync(directory) !== canonicalRoot) throw Error('Diagnostic namespace changed');
    for (const container of containers)
      if (directoryIdentity(container.path) !== container.identity)
        throw Error('Diagnostic namespace changed');
  };
  const writeDiagnostic = (path: string, bytes: Uint8Array, purpose: string) => {
    const input = Buffer.from(bytes);
    guardDiagnostics();
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1) throw Error('Invalid diagnostic ciphertext');
    }
    const pending = `${path}.pending-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    let fd: number | undefined;
    try {
      fd = openSync(pending, 'wx', 0o600);
      const opened = fstatSync(fd);
      guardDiagnostics();
      if (!opened.isFile() || opened.nlink !== 1) throw Error('Invalid diagnostic ciphertext');
      encryptObjectToFileDescriptor(fd, input, key, profileId, purpose);
      fsyncSync(fd);
      const sealed = fstatSync(fd, { bigint: true });
      closeSync(fd);
      fd = undefined;
      guardDiagnostics();
      const staged = lstatSync(pending, { bigint: true });
      if (
        !staged.isFile() ||
        staged.nlink !== 1n ||
        staged.dev !== sealed.dev ||
        staged.ino !== sealed.ino ||
        staged.size !== sealed.size ||
        staged.mtimeNs !== sealed.mtimeNs ||
        staged.ctimeNs !== sealed.ctimeNs
      )
        throw Error('Diagnostic ciphertext changed');
      renameSync(pending, path);
      const parent = openSync(dirname(path), 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
      guardDiagnostics();
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      // Do not follow a replaced namespace even for temporary-file cleanup.
      guardDiagnostics();
      rawRmSync(pending, { force: true });
      throw error;
    }
  };
  const writeDiagnosticChunk: VaultDiagnosticWriter = (sequence, bytes) => {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER)
      throw Error('Invalid diagnostic chunk sequence');
    writeDiagnostic(
      resolve(eventDirectory, String(sequence).padStart(16, '0') + '.enc'),
      bytes,
      `diagnostic-events-v1:${sequence}`,
    );
  };
  diagnosticWriters.set(writeDiagnosticChunk, {
    directory: resolve(directory, 'diagnostics/events'),
    profileId,
  });
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
  let indexed = false;
  try {
    for (const id in manifest.objects) {
      rememberDigest(id, manifest.objects[id]!);
      yield;
    }
    indexed = true;
  } finally {
    if (!indexed) index.close();
  }
  function discard(): void {
    if (closed) return;
    closed = true;
    diagnosticChunks?.close();
    diagnosticChunks = undefined;
    fingerprints.clear();
    pendingFiles.clear();
    pendingObjects.clear();
    selectedWorkspaceFiles.clear();
    stagedWorkspaceFiles.clear();
    digests.clear();
    index.close();
    index = null!;
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
      for (const [workspace, names] of stagedWorkspaceFiles) {
        const selected = selectedWorkspaceFiles.get(workspace);
        for (const name of names) selected?.delete(name);
        if (!selected?.size) selectedWorkspaceFiles.delete(workspace);
      }
      stagedWorkspaceFiles.clear();
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
      excludeDirectory = () => false,
      publishNow = true,
    }: {
      exclude?: (name: string) => boolean;
      excludeDirectory?: (name: string) => boolean;
      publishNow?: boolean;
    } = {},
  ): boolean {
    guard();
    let changed = false;
    workspace = resolve(workspace);
    const selected = selectedWorkspaceFiles.get(workspace);
    for (const name of selected ?? []) {
      // Bypassing inventory must not bypass path safety. Check every ancestor
      // and the selected leaf without touching any retained sibling.
      let path = workspace;
      const root = lstatSync(path);
      if (!root.isDirectory() || root.isSymbolicLink())
        throw Error('Vault workspace cannot contain symbolic links');
      const segments = name.split('/');
      for (let i = 0; i < segments.length; i++) {
        path = resolve(path, segments[i]);
        const stat = lstatSync(path);
        if (
          stat.isSymbolicLink() ||
          (i < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())
        )
          throw Error('Unsupported selected workspace object');
      }
    }
    const names = new Set([...checkPlainTree(workspace, excludeDirectory), ...(selected ?? [])]);
    for (const name of names) {
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
    if (selected?.size) {
      const staged = stagedWorkspaceFiles.get(workspace) ?? new Set<string>();
      for (const name of selected) if (!exclude(name)) staged.add(name);
      stagedWorkspaceFiles.set(workspace, staged);
    }
    // Removal is explicit in records; retained artifacts are never physically deleted here.
    // A previous accepted-record stage can already own every fingerprint while
    // its bindings are still pending. They must reach the manifest on flush.
    if (publishNow && (pendingFiles.size || pendingObjects.size)) publish();
    else if (publishNow && stagedWorkspaceFiles.size) {
      for (const [path, staged] of stagedWorkspaceFiles) {
        const files = selectedWorkspaceFiles.get(path);
        for (const name of staged) files?.delete(name);
        if (!files?.size) selectedWorkspaceFiles.delete(path);
      }
      stagedWorkspaceFiles.clear();
    }
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
  function recordStorage(beforeHead?: () => void, compactWorkspace?: string): VaultRecordStorage {
    const recordPath = (name: string): string => {
      if (!/^objects\/[0-9a-f-]{36}$/.test(name)) throw Error('Invalid record storage name');
      return resolve(directory, 'vault/versions', name.slice(8) + '.enc');
    };
    const storage: VaultRecordStorage = {
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
    recordStagingOwners.set(storage, {
      storage,
      read: storage.read,
      write: storage.writeImmutable,
      publish: storage.publishHead,
      directory: resolve(directory),
      profileId,
      key,
      workspace: compactWorkspace === undefined ? undefined : resolve(compactWorkspace),
      workspaceEpoch: () => workspaceEpoch,
      workspaceNames: () =>
        compactWorkspace === undefined
          ? []
          : [...(selectedWorkspaceFiles.get(resolve(compactWorkspace)) ?? [])],
      compactReady: () => pendingFiles.size === 0 && pendingObjects.size === 0,
      guard,
      live: () => !closed,
      prepareHead() {
        guard();
        beforeHead?.();
      },
      installHead(bytes) {
        guard();
        try {
          manifest.recordsHead = Buffer.from(bytes).toString('base64');
          publishInternal();
        } catch (error) {
          discard();
          throw error;
        }
      },
    });
    return storage;
  }
  if (initialize && !existsSync(manifestPath)) publish();
  return {
    put,
    storeFile,
    publish,
    trackWorkspaceFiles(workspace, names) {
      guard();
      workspaceEpoch = Object.freeze({});
      workspace = resolve(workspace);
      const selected = selectedWorkspaceFiles.get(workspace) ?? new Set<string>();
      for (const name of names) {
        selected.add(safeName(name));
        stagedWorkspaceFiles.get(workspace)?.delete(name);
      }
      selectedWorkspaceFiles.set(workspace, selected);
    },
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
      guardDiagnostics();
      const path = resolve(directory, 'diagnostics/recent-performance.enc');
      if (!existsSync(path)) return null;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > recentPerformanceLimits.maxBytes + 4096)
        throw Error('Invalid diagnostic summary size');
      return decryptObject(path, key, profileId, 'recent-performance-v1');
    },
    diagnosticChunks() {
      guardDiagnostics();
      return (diagnosticChunks ??= openDiagnosticChunkStore({
        directory: resolve(directory, 'diagnostics/events'),
        profileId,
        key,
        guard: guardDiagnostics,
        writer: writeDiagnosticChunk,
      }));
    },
    writePerformanceSummary(bytes) {
      guard();
      if (bytes.byteLength > recentPerformanceLimits.maxBytes)
        throw Error('Diagnostic summary limit');
      writeDiagnostic(
        resolve(diagnosticDirectory, 'recent-performance.enc'),
        bytes,
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

export function openVault(options: OpenVaultOptions): Vault {
  const steps = openVaultSteps(options);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** Cooperate while opening; the caller retains its original authority witness. */
export async function openVaultAsync(
  options: OpenVaultOptions,
  checkpoint: () => void,
): Promise<Vault> {
  const steps = openVaultSteps(options);
  try {
    for (;;) {
      checkpoint();
      for (let work = 0; work < 64; work++) {
        const next = steps.next();
        if (next.done) {
          try {
            checkpoint();
          } catch (error) {
            next.value.close();
            throw error;
          }
          return next.value;
        }
      }
      await yieldHost();
    }
  } catch (error) {
    steps.return(undefined as never);
    throw error;
  }
}
