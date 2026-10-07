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
import { randomUUID } from 'node:crypto';
import { flockExclusiveNonblocking, flockUnlock } from '../shared/flock.ts';
import { profilePaths, profileOriginal } from './profile-storage.ts';
import type { RecordStorage, DurableRecordVersion } from './record-versions.ts';
import { hashFile } from './vault-store.ts';

const FORMAT = 'health-contributor-record-authority-v1';
function fail(message: string): never {
  throw Error('Contributor authority: ' + message);
}
// Keep each physical-path proof fresh; the native resolver avoids repeating
// Node's JavaScript component walk without caching or skipping symlink checks.
function directory(path: string): void {
  if (!lstatSync(path).isDirectory() || realpathSync.native(path) !== resolve(path))
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
  if (!lstatSync(path).isFile() || realpathSync.native(path) !== path)
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
  const check = () => {
    if (closed) fail('closed backend');
    directory(profile.root);
    directory(base);
  };
  const write = (name: string, bytes: Uint8Array, immutable: boolean) => {
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
      return;
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
    return {
      read(value) {
        return readFile(name(value));
      },
      writeImmutable(value, bytes) {
        name(value);
        if (value === 'head') fail('head is not immutable');
        write(value, bytes, true);
      },
      publishHead(bytes) {
        name('head');
        write('head', bytes, false);
      },
      close() {
        if (closed) return;
        closed = true;
        if (lease !== undefined) {
          try {
            flockUnlock(lease);
          } finally {
            closeSync(lease);
          }
        }
      },
    };
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
