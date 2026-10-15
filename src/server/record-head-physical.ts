import {
  constants,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  lstatSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';
import { dirname, isAbsolute, normalize } from 'node:path';

const nativeRealpath = realpathSync.native,
  fileTypeMask = BigInt(constants.S_IFMT),
  regularFile = BigInt(constants.S_IFREG),
  directory = BigInt(constants.S_IFDIR);

/** Fixed-path transport for genuine storage factories, not an authority issuer.
 * Files retain their original open FD and full identity; directory proofs bind
 * structure only, not sibling membership (the original artifact roster does). */
export function captureRecordHeadPhysical(
  files: readonly string[],
  directories: readonly string[],
) {
  const opened: Array<{ path: string; fd: number; identity: string; size: bigint }> = [],
    parents: Array<{ path: string; identity: string }> = [];
  let closed = false;
  const fileKey = (stat: BigIntStats) =>
    [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const parentKey = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode].join(':');
  const parentsCurrent = () => {
    for (const parent of parents) {
      const stat = lstatSync(parent.path, { bigint: true });
      if ((stat.mode & fileTypeMask) !== directory || parentKey(stat) !== parent.identity)
        return false;
    }
    return true;
  };
  const current = (): boolean => {
    if (closed) return false;
    try {
      if (!parentsCurrent()) return false;
      for (const file of opened) {
        const fd = fstatSync(file.fd, { bigint: true }),
          path = lstatSync(file.path, { bigint: true });
        if (
          (fd.mode & fileTypeMask) !== regularFile ||
          (path.mode & fileTypeMask) !== regularFile ||
          fileKey(fd) !== file.identity ||
          fileKey(path) !== file.identity
        )
          return false;
      }
      // A lasting ancestor substitution during the endpoint checks must also
      // refuse. Like realpath, these separate syscalls are not an atomic seal.
      return parentsCurrent();
    } catch {
      return false;
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    let failure: unknown;
    for (const file of opened) {
      try {
        closeSync(file.fd);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
  const read = (path: string): Buffer => {
    const file = opened.find((entry) => entry.path === path);
    if (!file || !current()) throw Error('Record HEAD changed before retained read');
    const size = file.size;
    if (size > BigInt(bufferConstants.MAX_LENGTH))
      throw Error('Record HEAD retained read exceeds buffer limit');
    const bytes = Buffer.allocUnsafe(Number(size));
    let at = 0;
    while (at < bytes.length) {
      const count = readSync(file.fd, bytes, at, bytes.length - at, at);
      if (!count) throw Error('Record HEAD retained read truncated');
      at += count;
    }
    if (!current()) throw Error('Record HEAD changed after retained read');
    return bytes;
  };
  try {
    const ancestors = new Set<string>();
    for (const path of [...directories, ...files])
      if (!isAbsolute(path) || normalize(path) !== path)
        throw Error('Record HEAD path is not canonical');
    for (let path of [...directories, ...files.map(dirname)]) {
      for (;;) {
        ancestors.add(path);
        const parent = dirname(path);
        if (parent === path) break;
        path = parent;
      }
    }
    // Pin every lexical ancestor, including those above explicit storage
    // parents, once. Shared prefixes need no repeated realpath on hot checks.
    for (const path of ancestors) {
      const stat = lstatSync(path, { bigint: true });
      if ((stat.mode & fileTypeMask) !== directory)
        throw Error('Record HEAD parent is not physical');
      parents.push({ path, identity: parentKey(stat) });
    }
    for (const path of directories)
      if (nativeRealpath(path) !== path) throw Error('Record HEAD parent is not physical');
    for (const path of files) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
        file = { path, fd, identity: '', size: 0n };
      opened.push(file);
      const stat = fstatSync(fd, { bigint: true });
      file.identity = fileKey(stat);
      file.size = stat.size;
      if (
        (stat.mode & fileTypeMask) !== regularFile ||
        nativeRealpath(path) !== path ||
        fileKey(lstatSync(path, { bigint: true })) !== fileKey(stat)
      )
        throw Error('Record HEAD file changed during capture');
    }
    if (!current()) throw Error('Record HEAD changed during capture');
    return Object.freeze({ current, read, close });
  } catch (error) {
    try {
      close();
    } catch {
      /* Preserve the original admission error. */
    }
    throw error;
  }
}

/** Storage stat-identity hook result: `key` changes whenever the HEAD bytes may
 * have changed; `settled` says a write after this observation must change `key`. */
export interface RecordHeadStatIdentity {
  readonly key: string;
  readonly settled: boolean;
}
// Coarse kernel clocks stamp files up to one tick (at most 10 ms at HZ=100)
// behind wall time; filesystems with coarser stamps are detected below.
const minimumSettleNs = 50_000_000n,
  secondNs = 1_000_000_000n;
function timestampGranularity(...values: bigint[]): bigint {
  let unit = 1n;
  while (unit < secondNs && values.every((value) => value % (unit * 10n) === 0n)) unit *= 10n;
  if (unit === secondNs && values.every((value) => value % (2n * secondNs) === 0n))
    unit = 2n * secondNs;
  return unit;
}
/** Physical stat identity of one fixed HEAD file under physical parent
 * directories, or null when unknown (any failure, non-physical path, missing
 * inode). It never reads file bytes. Settlement follows the racy-timestamp
 * rule: a same-inode same-size rewrite in the stamp's own clock tick keeps
 * dev/ino/size/mtime/ctime, so only identities whose latest change is older
 * than twice the stamp granularity (at least 50 ms) before this observation may
 * stand in for a content read. A wall clock moved backwards only withholds
 * settlement; one moved forwards past real time is not detected. */
export function recordHeadStatIdentity(
  file: string,
  directories: readonly string[],
): RecordHeadStatIdentity | null {
  try {
    const now = BigInt(Date.now()) * 1_000_000n,
      parts: string[] = [],
      canonical = new Set(directories);
    // A canonical descendant also proves each of its lexical ancestors has
    // no symlink component. Unrelated directory roots remain independent.
    for (const directoryPath of directories) {
      if (!isAbsolute(directoryPath) || normalize(directoryPath) !== directoryPath) return null;
      let path = directoryPath;
      for (;;) {
        const parent = dirname(path);
        if (parent === path) break;
        canonical.delete(parent);
        path = parent;
      }
    }
    for (const path of directories) {
      const stat = lstatSync(path, { bigint: true });
      if ((stat.mode & fileTypeMask) !== directory) return null;
      if (stat.ino === 0n) return null;
      parts.push(`${stat.dev}:${stat.ino}:${stat.mode}`);
    }
    for (const path of canonical) if (nativeRealpath(path) !== path) return null;
    const stat = lstatSync(file, { bigint: true });
    if ((stat.mode & fileTypeMask) !== regularFile || stat.ino === 0n) return null;
    const changed = stat.ctimeNs > stat.mtimeNs ? stat.ctimeNs : stat.mtimeNs,
      granularity = timestampGranularity(stat.ctimeNs, stat.mtimeNs),
      settle = granularity * 2n > minimumSettleNs ? granularity * 2n : minimumSettleNs;
    parts.push(
      [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'),
    );
    return Object.freeze({ key: parts.join('/'), settled: now - changed > settle });
  } catch {
    return null;
  }
}
