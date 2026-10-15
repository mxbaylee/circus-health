import { setImmediate as yieldToHost } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { HttpError } from './database.ts';
import type { PackageSourceBinding } from './intake-package-protocol.ts';
import { recordIntakeFileWork } from './intake-file-work.ts';

export const emptyPackageSourceVerificationWork = () => ({
  coldReadBytes: 0,
  coldHashBytes: 0,
  verificationCacheHits: 0,
  peakVerificationBufferBytes: 0,
  verificationYields: 0,
});
export type PackageSourceVerificationWork = ReturnType<typeof emptyPackageSourceVerificationWork>;

export interface PackageSourceLease {
  readonly sourceFd: number;
  readonly binding: PackageSourceBinding;
  readonly verificationWork: Readonly<PackageSourceVerificationWork>;
  assertCurrent(): void;
  /** Fixed own-publication liveness; full source authority still guards bytes and handoff. */
  assertPublicationCurrent(): void;
}
const leaseAssertions = new WeakMap<() => void, () => boolean>();
export interface PackageSourceOriginalPhysical {
  readonly sourceFd: number;
  readonly path: string;
  readonly acceptedPath: string;
  readonly parentRealpath: string;
  readonly parentKind: 'directory' | 'symlink';
  readonly parentIdentity: string;
  readonly statIdentity: string;
  readonly binding: Readonly<PackageSourceBinding>;
}
const leaseOriginals = new WeakMap<() => void, PackageSourceOriginalPhysical>();

/** Read-only lexical liveness for an assertion issued by this lease owner. */
export function packageSourceLeaseAssertionCurrent(assertion: () => void): boolean {
  return leaseAssertions.get(assertion)?.() ?? false;
}
/** Original open-time identity; the terminal worker must reverify it. */
export function packageSourceLeaseOriginalPhysical(
  assertion: () => void,
): PackageSourceOriginalPhysical | undefined {
  return packageSourceLeaseAssertionCurrent(assertion) ? leaseOriginals.get(assertion) : undefined;
}
export function createPackageSourceLeaseOwner({
  profileId,
  root,
  assertAuthorized,
  assertPublicationAuthorized,
  cacheEntries = 64,
}: {
  profileId: string;
  root: string;
  assertAuthorized: () => void;
  assertPublicationAuthorized?: () => void;
  cacheEntries?: number;
}) {
  if (!Number.isInteger(cacheEntries) || cacheEntries < 1 || cacheEntries > 4096)
    throw Error('Invalid source lease budget');
  const managedRoot = realpathSync(root);
  const verified = new Map<string, string>();
  let closed = false,
    generation = 0;
  const work = emptyPackageSourceVerificationWork();
  const current = () => {
    if (closed) throw new HttpError(409, 'PROFILE_LOCKED', 'The source session is closed');
    assertAuthorized();
  };
  const changed = (): never => {
    throw new HttpError(409, 'SOURCE_CHANGED', 'The retained original changed');
  };
  const statKey = (s: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  }) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
  const parentState = (path: string) => {
    const parent = lstatSync(path, { bigint: true });
    const kind = parent.isDirectory() ? 'directory' : parent.isSymbolicLink() ? 'symlink' : null;
    if (!kind) return changed();
    return { kind, identity: [parent.dev, parent.ino, parent.mode].join(':') } as const;
  };
  // BigInt nanosecond stats are the actual verification cache identity.
  const statIdentity = (fd: number, path: string) => {
    const opened = fstatSync(fd, { bigint: true }),
      named = lstatSync(path, { bigint: true });
    if (!opened.isFile() || !named.isFile() || statKey(opened) !== statKey(named)) changed();
    return statKey(opened);
  };
  return {
    work,
    close() {
      closed = true;
      generation++;
      verified.clear();
    },
    invalidate() {
      generation++;
      verified.clear();
    },
    async withSource<T>(
      source: PackageSourceBinding & { path: string; acceptedPath?: string },
      consume: (lease: PackageSourceLease) => Promise<T>,
      assertRunning?: () => void,
      assertPublicationRunning?: () => void,
    ): Promise<T> {
      current();
      assertRunning?.();
      const operationWork = emptyPackageSourceVerificationWork();
      if (
        source.profileId !== profileId ||
        !source.intakeId ||
        !/^[a-f0-9]{64}$/.test(source.sourceHash) ||
        !Number.isSafeInteger(source.bytes) ||
        source.bytes < 0
      )
        throw new HttpError(403, 'PROFILE_BOUNDARY', 'Invalid retained source binding');
      const path = resolve(source.path),
        parentPath = dirname(path),
        parent = realpathSync(parentPath),
        parentProof = parentState(parentPath),
        location = relative(managedRoot, parent);
      const parentCurrent = () => {
        const value = parentState(parentPath);
        return value.kind === parentProof.kind && value.identity === parentProof.identity;
      };
      if (location === '..' || location.startsWith('../') || location.startsWith('/'))
        throw new HttpError(403, 'PROFILE_BOUNDARY', 'Source escaped its managed root');
      const before = lstatSync(path, { bigint: true });
      if (!before.isFile() || before.size !== BigInt(source.bytes)) changed();
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const epoch = generation;
      let active = true;
      const cacheKey = JSON.stringify([
        profileId,
        source.intakeId,
        source.sourceHash,
        source.bytes,
        path,
      ]);
      try {
        const expectedIdentity = statIdentity(fd, path);
        const assertCurrent = () => {
          current();
          assertRunning?.();
          if (
            epoch !== generation ||
            realpathSync(parentPath) !== parent ||
            !parentCurrent() ||
            statIdentity(fd, path) !== expectedIdentity
          ) {
            verified.delete(cacheKey);
            changed();
          }
        };
        const assertPublicationCurrent = () => {
          if (closed) throw new HttpError(409, 'PROFILE_LOCKED', 'The source session is closed');
          (assertPublicationAuthorized ?? assertAuthorized)();
          (assertPublicationRunning ?? assertRunning)?.();
          if (
            epoch !== generation ||
            realpathSync(parentPath) !== parent ||
            !parentCurrent() ||
            statIdentity(fd, path) !== expectedIdentity
          ) {
            verified.delete(cacheKey);
            changed();
          }
        };
        const leaseCurrent = () => active && !closed && epoch === generation;
        const originalPhysical = Object.freeze({
          sourceFd: fd,
          path,
          acceptedPath: source.acceptedPath ?? source.path,
          parentRealpath: parent,
          parentKind: parentProof.kind,
          parentIdentity: parentProof.identity,
          statIdentity: expectedIdentity,
          binding: Object.freeze({
            profileId,
            intakeId: source.intakeId,
            sourceHash: source.sourceHash,
            bytes: source.bytes,
          }),
        });
        leaseAssertions.set(assertCurrent, leaseCurrent);
        leaseAssertions.set(assertPublicationCurrent, leaseCurrent);
        leaseOriginals.set(assertCurrent, originalPhysical);
        leaseOriginals.set(assertPublicationCurrent, originalPhysical);
        assertCurrent();
        if (verified.get(cacheKey) === expectedIdentity) {
          verified.delete(cacheKey);
          verified.set(cacheKey, expectedIdentity);
          work.verificationCacheHits++;
          operationWork.verificationCacheHits++;
          recordIntakeFileWork('verificationCacheHits');
        } else {
          verified.delete(cacheKey);
          const hash = createHash('sha256'),
            chunk = Buffer.allocUnsafe(256 * 1024);
          work.peakVerificationBufferBytes = Math.max(
            work.peakVerificationBufferBytes,
            chunk.length,
          );
          operationWork.peakVerificationBufferBytes = chunk.length;
          recordIntakeFileWork('inspectionBufferBytes', chunk.length);
          let offset = 0,
            chunks = 0;
          while (true) {
            assertCurrent();
            recordIntakeFileWork('streamReadAttempts');
            const n = readSync(fd, chunk, 0, chunk.length, offset);
            recordIntakeFileWork('streamReadCalls');
            recordIntakeFileWork('streamReadBytes', n);
            if (!n) break;
            offset += n;
            work.coldReadBytes += n;
            work.coldHashBytes += n;
            operationWork.coldReadBytes += n;
            operationWork.coldHashBytes += n;
            hash.update(chunk.subarray(0, n));
            recordIntakeFileWork('streamHashCalls');
            recordIntakeFileWork('streamHashBytes', n);
            if (++chunks % 4 === 0) {
              work.verificationYields++;
              operationWork.verificationYields++;
              await yieldToHost();
            }
          }
          assertCurrent();
          if (offset !== source.bytes || hash.digest('hex') !== source.sourceHash) changed();
          if (verified.size >= cacheEntries) verified.delete(verified.keys().next().value!);
          verified.set(cacheKey, expectedIdentity);
        }
        const result = await consume({
          sourceFd: fd,
          binding: {
            profileId,
            intakeId: source.intakeId,
            sourceHash: source.sourceHash,
            bytes: source.bytes,
          },
          assertCurrent,
          assertPublicationCurrent,
          verificationWork: Object.freeze({ ...operationWork }),
        });
        assertCurrent();
        return result;
      } catch (error) {
        verified.delete(cacheKey);
        throw error;
      } finally {
        active = false;
        closeSync(fd);
      }
    },
  };
}
