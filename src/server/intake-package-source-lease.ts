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
  // BigInt nanosecond stats are the actual verification cache identity.
  const statIdentity = (fd: number, path: string) => {
    const opened = fstatSync(fd, { bigint: true }),
      named = lstatSync(path, { bigint: true });
    const key = (s: typeof opened) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
    if (!opened.isFile() || !named.isFile() || key(opened) !== key(named)) changed();
    return key(opened);
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
      source: PackageSourceBinding & { path: string },
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
        parent = realpathSync(dirname(path)),
        location = relative(managedRoot, parent);
      if (location === '..' || location.startsWith('../') || location.startsWith('/'))
        throw new HttpError(403, 'PROFILE_BOUNDARY', 'Source escaped its managed root');
      const before = lstatSync(path, { bigint: true });
      if (!before.isFile() || before.size !== BigInt(source.bytes)) changed();
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const epoch = generation;
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
            realpathSync(dirname(path)) !== parent ||
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
            realpathSync(dirname(path)) !== parent ||
            statIdentity(fd, path) !== expectedIdentity
          ) {
            verified.delete(cacheKey);
            changed();
          }
        };
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
        closeSync(fd);
      }
    },
  };
}
