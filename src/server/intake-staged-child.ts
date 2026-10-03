import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  rmdirSync,
  type BigIntStats,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { HttpError } from './database.ts';
import { verifyIntakeFileHash } from './intake-files.ts';
import { fsyncIntakeFileSync, recordIntakeFileWork } from './intake-file-work.ts';

function changed(): never {
  throw new HttpError(
    409,
    'SOURCE_CHANGED',
    'The retained source or private extraction stage changed; no child was published',
  );
}
function same(a: BigIntStats, b: BigIntStats) {
  return (
    a.isFile() &&
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

/** Keep verification and the asynchronous consumer bound to one open inode. */
export async function withVerifiedSourceDescriptor<T>(
  source: { path: string; size: number; sourceHash: string },
  assertRunning: () => void,
  writer: (sourceFd: number, assertUnchanged: () => void) => Promise<T>,
): Promise<T> {
  assertRunning();
  const before = lstatSync(source.path, { bigint: true });
  if (!before.isFile() || before.size !== BigInt(source.size)) changed();
  verifyIntakeFileHash(source.path, { bytes: source.size, sha256: source.sourceHash });
  const fd = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const assertUnchanged = () => {
    if (
      !same(before, fstatSync(fd, { bigint: true })) ||
      !same(before, lstatSync(source.path, { bigint: true }))
    )
      changed();
    assertRunning();
  };
  try {
    assertUnchanged();
    const result = await writer(fd, assertUnchanged);
    assertUnchanged();
    return result;
  } finally {
    closeSync(fd);
  }
}

/** Only the trusted publication closure sees a path. The writer gets an FD,
 * never a path receipt it could fabricate or retain as publication authority.
 * It must resolve/reject only after its worker has exited and closed its FDs. */
export async function withPrivateChildStage<T>(
  root: string,
  expected: { bytes: number; sourceHash: string },
  writer: (outputFd: number) => Promise<void>,
  publish: (stage: { path: string; bytes: number; sha256: string; prefix: Buffer }) => T,
): Promise<T> {
  const runtime = realpathSync(root),
    stagingRoot = resolve(root, '.intake-child-staging');
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const directory = lstatSync(stagingRoot);
  if (
    !directory.isDirectory() ||
    (directory.mode & 0o777) !== 0o700 ||
    realpathSync(stagingRoot) !== join(runtime, '.intake-child-staging')
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Invalid private extraction staging directory');
  const attempt = mkdtempSync(join(stagingRoot, 'child-')),
    path = join(attempt, 'original');
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const created = fstatSync(fd, { bigint: true });
    await writer(fd);
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.dev !== created.dev ||
      before.ino !== created.ino ||
      before.size !== BigInt(expected.bytes) ||
      !same(before, lstatSync(path, { bigint: true }))
    )
      changed();
    const hash = createHash('sha256'),
      chunk = Buffer.allocUnsafe(256 * 1024);
    recordIntakeFileWork('inspectionBufferBytes', chunk.length);
    let bytes = 0,
      prefix = Buffer.alloc(0);
    while (true) {
      recordIntakeFileWork('streamReadAttempts');
      const n = readSync(fd, chunk, 0, chunk.length, bytes);
      recordIntakeFileWork('streamReadCalls');
      recordIntakeFileWork('streamReadBytes', n);
      if (!n) break;
      if (!bytes) prefix = Buffer.from(chunk.subarray(0, Math.min(n, 512)));
      bytes += n;
      if (!Number.isSafeInteger(bytes) || bytes > expected.bytes) changed();
      hash.update(chunk.subarray(0, n));
      recordIntakeFileWork('streamHashCalls');
      recordIntakeFileWork('streamHashBytes', n);
    }
    const sha256 = hash.digest('hex');
    if (
      bytes !== expected.bytes ||
      sha256 !== expected.sourceHash ||
      !same(before, fstatSync(fd, { bigint: true })) ||
      !same(before, lstatSync(path, { bigint: true }))
    )
      changed();
    fsyncIntakeFileSync(fd);
    closeSync(fd);
    fd = undefined;
    return publish({ path, bytes, sha256, prefix });
  } finally {
    if (fd !== undefined) closeSync(fd);
    // The publication may have adopted this file. Never remove the published
    // original, even if durable transaction completion is uncertain.
    rmSync(path, { force: true });
    rmdirSync(attempt);
  }
}

const unpublishedErrors = new WeakSet<object>();
/** Host-owned evidence that no durable child-registration attempt began and
 * the parent still verifies. Uncertain publication must recover before writing
 * a separate located failure. */
export function isUnpublishedIntakeChildError(error: unknown): boolean {
  return !!error && typeof error === 'object' && unpublishedErrors.has(error);
}
export function childStorageError(error: unknown, unpublished = false): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT')
    error = new HttpError(
      507,
      'INTAKE_CHILD_STORAGE',
      'Parent original retained. Free runtime or archive storage to retry this member; child publication may require recovery.',
    );
  if (['EIO', 'EACCES', 'EROFS', 'EMFILE', 'ENFILE'].includes(code || ''))
    error = new HttpError(
      503,
      'INTAKE_CHILD_IO',
      'Parent original retained. Extraction storage is unavailable; retry this member after restoring storage access.',
    );
  if (error && typeof error === 'object') {
    unpublishedErrors.delete(error);
    if (unpublished) unpublishedErrors.add(error);
  }
  throw error;
}
