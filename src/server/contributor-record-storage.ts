import {
  constants,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  renameSync,
  linkSync,
  unlinkSync,
  lstatSync,
  realpathSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { flockExclusiveNonblocking, flockUnlock } from '../shared/flock.ts';
import { profilePaths, profileOriginal } from './profile-storage.ts';
import type {
  RecordStorage,
  DurableRecordVersion,
  RecordObjectReference,
} from './record-versions.ts';
import { hashFile } from './vault-store.ts';
import { captureRecordHeadPhysical } from './record-head-physical.ts';
import { unlockPhysicalIdentity } from './encrypted-unlock-physical.ts';
import {
  captureManagedPhysicalScope,
  managedPhysicalScopeCurrent,
} from './clinical-review-physical-epoch.ts';

const FORMAT = 'health-contributor-record-authority-v1';
const canonicalPath = realpathSync.native;
function fail(message: string): never {
  throw Error('Contributor authority: ' + message);
}
// Keep each physical-path proof fresh; the native resolver avoids repeating
// Node's JavaScript component walk without caching or skipping symlink checks.
function directory(path: string): void {
  if (
    (lstatSync(path).mode & constants.S_IFMT) !== constants.S_IFDIR ||
    canonicalPath(path) !== resolve(path)
  )
    fail('directory must be physical and profile scoped');
}
function sync(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function readFile(path: string): Buffer | null {
  if (!existsSync(path)) {
    // existsSync follows links, including broken ones.
    try {
      lstatSync(path);
      fail('nonregular authority file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return null;
  }
  if (
    (lstatSync(path).mode & constants.S_IFMT) !== constants.S_IFREG ||
    canonicalPath(path) !== path
  )
    fail('authority must be a regular physical file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function contributorAuthorityPath(root: string, profileId: string): string {
  return profilePaths(root, profileId).records;
}
export function contributorAuthorityMarker(root: string, profileId: string): string {
  return resolve(profilePaths(root, profileId).root, 'record-authority.json');
}
export function hasContributorAuthority(root: string, profileId: string): boolean {
  // Presence selects this backend even if its marker/head is damaged or missing.
  for (const path of [
    contributorAuthorityMarker(root, profileId),
    contributorAuthorityPath(root, profileId),
  ]) {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return false;
}
export interface ContributorRecordStorage extends RecordStorage {
  close(): void;
}
interface ContributorReadOwner {
  storage: ContributorRecordStorage;
  read: ContributorRecordStorage['read'];
  write: ContributorRecordStorage['writeImmutable'];
  publish: ContributorRecordStorage['publishHead'];
  close: ContributorRecordStorage['close'];
  base: string;
  marker: string;
  profileRoot: string;
  root: string;
  profileId: string;
  live(): boolean;
  writable(): boolean;
  selection(): object;
  install(bytes: Uint8Array): void;
  stage(name: string, bytes: Uint8Array): void;
  immutableSequence(): bigint;
}
const readOwnerFactories = new WeakMap<object, ContributorReadOwner>();
const ownDescriptor = Object.getOwnPropertyDescriptor;
declare const readOwnerBrand: unique symbol;
export interface ContributorRecordReadOwner {
  readonly [readOwnerBrand]: true;
}
const readOwners = new WeakMap<
  ContributorRecordReadOwner,
  {
    owner: ContributorReadOwner;
    selection: object;
    physical: ReturnType<typeof captureRecordHeadPhysical>;
  }
>();
const retainedDisposals = new WeakMap<object, Set<() => void>>();
/** Disposal only. This registration grants no read, publication, or terminal
 * callback eligibility and expires when the genuine factory closes. */
export function registerContributorRecordStagingDisposal(
  storage: object,
  original: ContributorRecordReadOwner,
  dispose: () => void,
): () => void {
  if (!contributorRecordReadOwnerCurrent(storage, original))
    fail('retained disposal owner changed');
  let disposals = retainedDisposals.get(storage);
  if (!disposals) retainedDisposals.set(storage, (disposals = new Set()));
  disposals.add(dispose);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    disposals.delete(dispose);
  };
}
declare const writeWitnessBrand: unique symbol;
export interface ContributorRecordWriteWitness {
  readonly [writeWitnessBrand]: true;
}
interface ContributorWriteData {
  owner: ContributorReadOwner;
  selection: object;
  sequence: bigint;
}
const writeWitnesses = new WeakMap<ContributorRecordWriteWitness, ContributorWriteData>();
/** Only a genuine open writer can issue this attempt-scoped immutable roster. */
export function captureContributorRecordWriteWitness(
  storage: object,
): ContributorRecordWriteWitness | undefined {
  const owner = readOwnerFactories.get(storage);
  if (!owner) return undefined;
  if (!readOwnerMethodsCurrent(owner) || !owner.writable()) fail('record writer unavailable');
  const witness = Object.freeze({}) as ContributorRecordWriteWitness;
  writeWitnesses.set(witness, {
    owner,
    selection: owner.selection(),
    sequence: owner.immutableSequence(),
  });
  return witness;
}
export function contributorRecordWriteWitnessCurrent(
  storage: object,
  witness: ContributorRecordWriteWitness,
): boolean {
  const data = writeWitnesses.get(witness);
  return (
    !!data &&
    data.owner.storage === storage &&
    data.owner.selection() === data.selection &&
    data.owner.writable() &&
    data.owner.immutableSequence() >= data.sequence &&
    readOwnerMethodsCurrent(data.owner)
  );
}
export function contributorRecordWriteWitnessSequence(
  storage: object,
  witness: ContributorRecordWriteWitness,
): bigint {
  if (!contributorRecordWriteWitnessCurrent(storage, witness))
    fail('record writer witness changed');
  const data = writeWitnesses.get(witness)!;
  return data.owner.immutableSequence() - data.sequence;
}
export function stageContributorRecordFactoryObject(
  storage: object,
  witness: ContributorRecordWriteWitness,
  reference: RecordObjectReference,
  input: Uint8Array,
): { identity: string; sha256: string; bytes: number } {
  if (!contributorRecordWriteWitnessCurrent(storage, witness))
    fail('record object staging writer changed');
  const owner = writeWitnesses.get(witness)!.owner,
    bytes = Buffer.from(input);
  if (
    !/^objects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      reference.name,
    ) ||
    bytes.length !== reference.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== reference.sha256 ||
    existsSync(resolve(owner.base, reference.name))
  )
    fail('record object staging reference changed');
  owner.stage(reference.name, bytes);
  const physical = unlockPhysicalIdentity(resolve(owner.base, reference.name));
  if (physical.kind !== 'file' || Number(physical.value.split(':')[2]) !== reference.bytes)
    fail('record object staging writer did not add exact immutable object');
  const sha256 = hashFile(resolve(owner.base, reference.name));
  if (sha256 !== reference.sha256) fail('record object staging readback differs');
  return { identity: physical.value, sha256, bytes: reference.bytes };
}
export function closeContributorRecordWriteWitness(witness: ContributorRecordWriteWitness): void {
  writeWitnesses.delete(witness);
}
/** Location is released only for an exact live read owner from this factory. */
export function contributorRecordBackingLocation(
  storage: object,
  original: ContributorRecordReadOwner,
): { root: string; profileId: string; base: string; marker: string } | undefined {
  const data = readOwners.get(original),
    owner = readOwnerFactories.get(storage);
  if (
    !owner ||
    !data ||
    data.owner !== owner ||
    !contributorRecordReadOwnerCurrent(storage, original)
  )
    return undefined;
  return { root: owner.root, profileId: owner.profileId, base: owner.base, marker: owner.marker };
}
function readOwnerMethodsCurrent(owner: ContributorReadOwner): boolean {
  for (const [name, expected] of [
    ['read', owner.read],
    ['writeImmutable', owner.write],
    ['publishHead', owner.publish],
    ['close', owner.close],
  ] as const) {
    const descriptor = ownDescriptor(owner.storage, name);
    if (!descriptor || !('value' in descriptor) || descriptor.value !== expected) return false;
  }
  return owner.live();
}
/** Factory provenance and original physical HEAD only, not consumed originals. */
export function contributorRecordReadOwnerSupported(storage: object): boolean {
  return readOwnerFactories.has(storage);
}
export function captureContributorRecordReadOwner(
  storage: object,
): ContributorRecordReadOwner | undefined {
  const owner = readOwnerFactories.get(storage);
  if (!owner) return undefined;
  if (!readOwnerMethodsCurrent(owner)) fail('record read owner unavailable');
  const physical = captureRecordHeadPhysical(
      [resolve(owner.base, 'head'), owner.marker],
      [owner.profileRoot, owner.base],
    ),
    capability = Object.freeze({}) as ContributorRecordReadOwner;
  readOwners.set(capability, { owner, physical, selection: owner.selection() });
  if (!contributorRecordReadOwnerCurrent(storage, capability)) {
    closeContributorRecordReadOwner(capability);
    fail('record read owner changed during capture');
  }
  return capability;
}
export function contributorRecordReadOwnerCurrent(
  storage: object,
  capability: ContributorRecordReadOwner,
): boolean {
  const data = readOwners.get(capability);
  return (
    !!data &&
    data.owner.storage === storage &&
    readOwnerMethodsCurrent(data.owner) &&
    data.owner.selection() === data.selection &&
    data.physical.current()
  );
}
/** Compare only genuine factory owners and their exact selected incarnation. */
export function contributorRecordReadOwnersSameSelection(
  storage: object,
  left: ContributorRecordReadOwner,
  right: ContributorRecordReadOwner,
): boolean {
  const a = readOwners.get(left),
    b = readOwners.get(right);
  return (
    !!a &&
    !!b &&
    a.owner === b.owner &&
    a.selection === b.selection &&
    contributorRecordReadOwnerCurrent(storage, left) &&
    contributorRecordReadOwnerCurrent(storage, right)
  );
}
export function closeContributorRecordReadOwner(capability: ContributorRecordReadOwner): void {
  const data = readOwners.get(capability);
  readOwners.delete(capability);
  data?.physical.close();
}

declare const legacyBridgeScopeBrand: unique symbol;
export interface ContributorLegacyBridgeBackingScope {
  readonly [legacyBridgeScopeBrand]: true;
}
const legacyBridgeScopes = new WeakMap<
  ContributorLegacyBridgeBackingScope,
  {
    owner: ContributorReadOwner;
    original?: ContributorRecordReadOwner;
    scope: object;
    sequence: bigint;
  }
>();
/** Capture before any bridge callback can run; the original scope is never renewed. */
export function captureContributorLegacyBridgeBackingScopeForStorage(
  storage: object,
): ContributorLegacyBridgeBackingScope | undefined {
  const owner = readOwnerFactories.get(storage);
  if (!owner) return undefined;
  const sequence = owner.immutableSequence(),
    scope = captureManagedPhysicalScope(owner.base);
  if (!scope || owner.immutableSequence() !== sequence) return undefined;
  const witness = Object.freeze({}) as ContributorLegacyBridgeBackingScope;
  legacyBridgeScopes.set(witness, { owner, scope, sequence });
  return readOwnerMethodsCurrent(owner) &&
    managedPhysicalScopeCurrent(scope) &&
    owner.immutableSequence() === sequence
    ? witness
    : undefined;
}
export function bindContributorLegacyBridgeBackingScope(
  storage: object,
  original: ContributorRecordReadOwner,
  witness: ContributorLegacyBridgeBackingScope,
): boolean {
  const data = legacyBridgeScopes.get(witness),
    read = readOwners.get(original);
  if (
    !data ||
    data.original ||
    data.owner.storage !== storage ||
    !read ||
    read.owner !== data.owner ||
    data.owner.immutableSequence() !== data.sequence ||
    !contributorRecordReadOwnerCurrent(storage, original) ||
    !managedPhysicalScopeCurrent(data.scope)
  )
    return false;
  data.original = original;
  return true;
}
export function contributorLegacyBridgeBackingScopeCurrent(
  storage: object,
  original: ContributorRecordReadOwner,
  witness: ContributorLegacyBridgeBackingScope,
): boolean {
  const data = legacyBridgeScopes.get(witness);
  return (
    !!data &&
    data.owner.storage === storage &&
    data.original === original &&
    data.owner.immutableSequence() === data.sequence &&
    contributorRecordReadOwnerCurrent(storage, original) &&
    managedPhysicalScopeCurrent(data.scope)
  );
}

declare const headPublicationBrand: unique symbol;
export interface ContributorRecordHeadPublication {
  readonly [headPublicationBrand]: true;
}
const headPublications = new WeakMap<
  ContributorRecordHeadPublication,
  {
    owner: ContributorReadOwner;
    original: ContributorRecordReadOwner;
    bytes: Buffer;
    consumed: boolean;
    installedSelection?: object;
    installedOwner?: ContributorRecordReadOwner;
  }
>();
/** Installation transport only. The record owner must retain this exact handle
 * privately and separately prove its transaction, indexed rows and originals. */
export function prepareContributorRecordHeadPublication(
  storage: object,
  reference: RecordObjectReference,
): ContributorRecordHeadPublication | undefined {
  const owner = readOwnerFactories.get(storage);
  if (!owner) return undefined;
  if (!readOwnerMethodsCurrent(owner)) fail('head publication owner unavailable');
  const { name, sha256, bytes } = reference;
  if (
    !/^objects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name) ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0
  )
    fail('head publication reference is invalid');
  const original = captureContributorRecordReadOwner(storage)!;
  try {
    const commit = readFile(resolve(owner.base, name));
    if (
      !commit ||
      commit.length !== bytes ||
      createHash('sha256').update(commit).digest('hex') !== sha256 ||
      !contributorRecordReadOwnerCurrent(storage, original)
    )
      fail('head publication immutable object differs');
    const capability = Object.freeze({}) as ContributorRecordHeadPublication;
    headPublications.set(capability, {
      owner,
      original,
      bytes: Buffer.from(JSON.stringify({ name, sha256, bytes }) + '\n'),
      consumed: false,
    });
    return capability;
  } catch (error) {
    closeContributorRecordReadOwner(original);
    throw error;
  }
}
export function contributorRecordHeadPublicationCurrent(
  storage: object,
  capability: ContributorRecordHeadPublication,
): boolean {
  const proof = headPublications.get(capability);
  return (
    !!proof &&
    !proof.consumed &&
    proof.owner.storage === storage &&
    contributorRecordReadOwnerCurrent(storage, proof.original)
  );
}
/** No public adapter property/callback is read or invoked at installation. */
export function installContributorRecordHeadPublication(
  storage: object,
  capability: ContributorRecordHeadPublication,
): void {
  if (!contributorRecordHeadPublicationCurrent(storage, capability))
    fail('head publication changed or expired');
  const proof = headPublications.get(capability)!;
  proof.consumed = true;
  proof.owner.install(proof.bytes);
  proof.installedSelection = proof.owner.selection();
  proof.installedOwner =
    captureContributorRecordReadOwner(storage) ?? fail('installed HEAD owner unavailable');
}
/** Successor resource capture only for this factory's exact lexical install.
 * The caller still needs the record core's one-use indexed publication receipt. */
export function captureContributorRecordInstalledReadOwner(
  storage: object,
  capability: ContributorRecordHeadPublication,
): ContributorRecordReadOwner {
  const proof = headPublications.get(capability);
  if (
    !proof ||
    !proof.consumed ||
    !proof.installedSelection ||
    !proof.installedOwner ||
    proof.owner.storage !== storage ||
    proof.owner.selection() !== proof.installedSelection ||
    !readOwnerMethodsCurrent(proof.owner)
  )
    fail('installed HEAD incarnation changed');
  const installed = proof.installedOwner!;
  if (!contributorRecordReadOwnerCurrent(storage, installed))
    fail('installed HEAD incarnation changed');
  proof.installedOwner = undefined;
  return installed;
}
export function closeContributorRecordHeadPublication(
  capability: ContributorRecordHeadPublication,
): void {
  const proof = headPublications.get(capability);
  headPublications.delete(capability);
  if (proof) closeContributorRecordReadOwner(proof.original);
  if (proof?.installedOwner) closeContributorRecordReadOwner(proof.installedOwner);
}
/** Caller holds this lease for the complete attached database lifetime. Read-only
 * recovery uses a pinned head under that writer's lease and never publishes. */
export function openContributorRecordStorage(
  root: string,
  profileId: string,
  { initialize = false, readOnly = false }: { initialize?: boolean; readOnly?: boolean } = {},
): ContributorRecordStorage {
  const profile = profilePaths(root, profileId),
    base = contributorAuthorityPath(root, profileId);
  directory(profile.root);
  const fresh = !hasContributorAuthority(root, profileId);
  if (fresh) {
    if (!initialize || readOnly) fail('selected record authority is missing');
    for (const kind of ['personal', 'curation'] as const)
      if (existsSync(profile[kind]) && readdirSync(profile[kind]).length)
        fail('portable archive requires explicit recovery; automatic conversion is unsupported');
    mkdirSync(base, { mode: 0o700 });
    sync(profile.root);
  }
  directory(base);
  let lease: number | undefined;
  let closed = false;
  let selection = Object.freeze({});
  let immutableSequence = 0n;
  const check = () => {
    if (closed) fail('closed backend');
    directory(profile.root);
    directory(base);
  };
  const write = (name: string, bytes: Uint8Array, immutable: boolean): boolean => {
    check();
    if (readOnly) fail('read-only backend');
    const target =
        name === 'record-authority.json'
          ? contributorAuthorityMarker(root, profileId)
          : resolve(base, name),
      parent = dirname(target);
    directory(parent);
    const old = readFile(target);
    if (immutable && old) {
      if (!old.equals(Buffer.from(bytes))) fail('immutable collision');
      return false;
    }
    const pending = resolve(parent, '.pending-' + randomUUID());
    const fd = openSync(
      pending,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      if (immutable) {
        linkSync(pending, target);
        unlinkSync(pending);
      } else renameSync(pending, target);
      sync(parent);
      if (!readFile(target)?.equals(Buffer.from(bytes))) fail('write verification failed');
      return true;
    } finally {
      if (existsSync(pending)) unlinkSync(pending);
    }
  };
  try {
    if (!readOnly) {
      const lock = resolve(base, 'writer.lock');
      if (existsSync(lock)) readFile(lock);
      lease = openSync(lock, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      if (!flockExclusiveNonblocking(lease)) fail('profile is owned by another writer');
    }
    const marker = contributorAuthorityMarker(root, profileId);
    if (fresh) {
      mkdirSync(resolve(base, 'objects'), { mode: 0o700 });
      sync(base);
      write(
        'record-authority.json',
        Buffer.from(JSON.stringify({ format: FORMAT, profileId }) + '\n'),
        true,
      );
    }
    const selected = readFile(marker);
    if (!selected || selected.toString() !== JSON.stringify({ format: FORMAT, profileId }) + '\n')
      fail('missing, unsupported or wrong-profile selection marker');
    directory(resolve(base, 'objects'));
    if (!fresh && !readFile(resolve(base, 'head'))) fail('selected head is missing');
    const name = (value: string): string => {
      if (
        value !== 'head' &&
        !/^objects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
      )
        fail('invalid object name');
      check();
      directory(dirname(resolve(base, value)));
      return resolve(base, value);
    };
    const storage: ContributorRecordStorage = {
      read(value) {
        return readFile(name(value));
      },
      writeImmutable(value, bytes) {
        name(value);
        if (value === 'head') fail('head is not immutable');
        immutableSequence++;
        write(value, bytes, true);
      },
      publishHead(bytes) {
        name('head');
        write('head', bytes, false);
        selection = Object.freeze({});
      },
      close() {
        if (closed) return;
        closed = true;
        const disposals = retainedDisposals.get(storage);
        retainedDisposals.delete(storage);
        let failed: unknown;
        for (const dispose of disposals ?? []) {
          try {
            dispose();
          } catch (error) {
            failed ??= error;
          }
        }
        if (lease !== undefined) {
          try {
            flockUnlock(lease);
          } finally {
            closeSync(lease);
          }
        }
        if (failed) throw failed;
      },
    };
    readOwnerFactories.set(storage, {
      storage,
      read: storage.read,
      write: storage.writeImmutable,
      publish: storage.publishHead,
      close: storage.close,
      base,
      marker,
      profileRoot: profile.root,
      root,
      profileId,
      live: () => !closed,
      writable: () => !readOnly,
      selection: () => selection,
      immutableSequence: () => immutableSequence,
      install: (bytes) => {
        name('head');
        write('head', bytes, false);
        selection = Object.freeze({});
      },
      stage: (value, bytes) => {
        name(value);
        immutableSequence++;
        if (!write(value, bytes, true)) fail('staged object was not newly created');
      },
    });
    return storage;
  } catch (error) {
    if (lease !== undefined) closeSync(lease);
    throw error;
  }
}
export function contributorOriginalVerifier(root: string, profileId: string) {
  return (versions: DurableRecordVersion[]): void => {
    for (const version of versions) {
      if (version.deleted) continue;
      const row = version.contents;
      const path =
        version.entity === 'source_files'
          ? row.path
          : version.entity === 'assets'
            ? row.stored_path
            : null;
      if (!path) continue;
      const physical = profileOriginal(root, path, profileId);
      if (physical !== resolve(root, String(path))) fail('original must not traverse a link');
      if (lstatSync(physical).size !== row.bytes || hashFile(physical) !== row.sha256)
        fail('original evidence is missing or changed');
      sync(physical);
      const boundary = profilePaths(root, profileId).root;
      for (let path = dirname(physical); ; path = dirname(path)) {
        sync(path);
        if (path === boundary) break;
      }
    }
  };
}
