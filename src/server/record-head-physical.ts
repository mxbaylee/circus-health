import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';

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
  const opened: Array<{ path: string; fd: number; identity: string }> = [],
    parents: Array<{ path: string; identity: string }> = [];
  let closed = false;
  const fileKey = (stat: BigIntStats) =>
    [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const parentKey = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode].join(':');
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
  try {
    for (const path of directories) {
      const stat = lstatSync(path, { bigint: true });
      if ((stat.mode & fileTypeMask) !== directory || nativeRealpath(path) !== path)
        throw Error('Record HEAD parent is not physical');
      parents.push({ path, identity: parentKey(stat) });
    }
    for (const path of files) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
        file = { path, fd, identity: '' };
      opened.push(file);
      const stat = fstatSync(fd, { bigint: true });
      file.identity = fileKey(stat);
      if (
        (stat.mode & fileTypeMask) !== regularFile ||
        nativeRealpath(path) !== path ||
        fileKey(lstatSync(path, { bigint: true })) !== fileKey(stat)
      )
        throw Error('Record HEAD file changed during capture');
    }
    return Object.freeze({
      current(): boolean {
        if (closed) return false;
        try {
          for (const parent of parents) {
            const stat = lstatSync(parent.path, { bigint: true });
            if (
              (stat.mode & fileTypeMask) !== directory ||
              parentKey(stat) !== parent.identity ||
              nativeRealpath(parent.path) !== parent.path
            )
              return false;
          }
          for (const file of opened) {
            const fd = fstatSync(file.fd, { bigint: true }),
              path = lstatSync(file.path, { bigint: true });
            if (
              (fd.mode & fileTypeMask) !== regularFile ||
              (path.mode & fileTypeMask) !== regularFile ||
              fileKey(fd) !== file.identity ||
              fileKey(path) !== file.identity ||
              nativeRealpath(file.path) !== file.path
            )
              return false;
          }
          return true;
        } catch {
          return false;
        }
      },
      close,
    });
  } catch (error) {
    try {
      close();
    } catch {
      /* Preserve the original admission error. */
    }
    throw error;
  }
}
