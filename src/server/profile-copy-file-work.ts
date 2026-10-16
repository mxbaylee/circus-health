/** Cooperative private profile copy I/O. These bytes are preparation, never accepted authority. */
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './database.ts';

const CHUNK = 64 * 1024;
type Identity = BigIntStats;

function sameFile(left: Identity, right: Identity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function rejectLink(stat: Identity): void {
  if (stat.isSymbolicLink())
    throw new HttpError(409, 'PROFILE_SOURCE_LINK', 'A private copy cannot include symbolic links');
}

async function regularFile(path: string, destination: string, check: () => void): Promise<void> {
  check();
  const before = await lstat(path, { bigint: true });
  rejectLink(before);
  if (!before.isFile()) throw Error('Private copy source is not a regular file');
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameFile(before, await source.stat({ bigint: true })))
      throw Error('Private copy source file changed');
    const target = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const targetInitial = await target.stat({ bigint: true });
      if (
        !targetInitial.isFile() ||
        !sameFile(targetInitial, await lstat(destination, { bigint: true }))
      )
        throw Error('Private copy target path changed');
      const buffer = Buffer.allocUnsafe(CHUNK);
      let offset = 0;
      for (;;) {
        check();
        const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        for (let written = 0; written < bytesRead;) {
          check();
          const result = await target.write(buffer, written, bytesRead - written, offset + written);
          if (!result.bytesWritten) throw Error('Private copy target write stalled');
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
      check();
      if (BigInt(offset) !== before.size || !sameFile(before, await source.stat({ bigint: true })))
        throw Error('Private copy source file changed');
      if (!sameFile(before, await lstat(path, { bigint: true })))
        throw Error('Private copy source path changed');
      const targetFinal = await target.stat({ bigint: true });
      const namedTarget = await lstat(destination, { bigint: true });
      if (
        !targetFinal.isFile() ||
        targetFinal.dev !== targetInitial.dev ||
        targetFinal.ino !== targetInitial.ino ||
        targetFinal.size !== BigInt(offset) ||
        !sameFile(targetFinal, namedTarget)
      )
        throw Error('Private copy target path changed');
      await target.chmod(Number(before.mode) & 0o777);
      await target.sync();
      check();
      if (
        !sameFile(await target.stat({ bigint: true }), await lstat(destination, { bigint: true }))
      )
        throw Error('Private copy target path changed');
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

async function directory(
  path: string,
  destination: string,
  check: () => void,
  root = false,
): Promise<void> {
  check();
  const before = await lstat(path, { bigint: true });
  rejectLink(before);
  if (!before.isDirectory()) throw Error('Private copy source is not a directory');
  const held = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!sameFile(before, await held.stat({ bigint: true })))
      throw Error('Private copy source directory changed');
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const targetDirectory = await open(
      destination,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const targetIdentity = await targetDirectory.stat({ bigint: true });
      const checkTarget = async () => {
        const heldTarget = await targetDirectory.stat({ bigint: true }),
          namedTarget = await lstat(destination, { bigint: true });
        if (
          !heldTarget.isDirectory() ||
          !namedTarget.isDirectory() ||
          heldTarget.dev !== targetIdentity.dev ||
          heldTarget.ino !== targetIdentity.ino ||
          namedTarget.dev !== targetIdentity.dev ||
          namedTarget.ino !== targetIdentity.ino
        )
          throw Error('Private copy target directory changed');
      };
      await checkTarget();
      const entries = await opendir(path);
      try {
        if (!sameFile(before, await lstat(path, { bigint: true })))
          throw Error('Private copy source directory changed');
        for await (const entry of entries) {
          check();
          if (!sameFile(before, await held.stat({ bigint: true })))
            throw Error('Private copy source directory changed');
          await checkTarget();
          if (!sameFile(before, await lstat(path, { bigint: true })))
            throw Error('Private copy source directory changed');
          const child = join(path, entry.name),
            target = join(destination, entry.name),
            stat = await lstat(child, { bigint: true });
          rejectLink(stat);
          if (stat.isDirectory()) await directory(child, target, check);
          else if (stat.isFile()) await regularFile(child, target, check);
          else throw Error('Private copy source contains a nonregular entry');
          if (!sameFile(before, await held.stat({ bigint: true })))
            throw Error('Private copy source directory changed');
          await checkTarget();
        }
      } finally {
        await entries.close().catch(() => {});
      }
      check();
      if (!sameFile(before, await held.stat({ bigint: true })))
        throw Error('Private copy source directory changed');
      await checkTarget();
      if (!root) await targetDirectory.chmod(Number(before.mode) & 0o777);
      await checkTarget();
    } finally {
      await targetDirectory.close();
    }
    check();
    if (
      !sameFile(before, await held.stat({ bigint: true })) ||
      !sameFile(before, await lstat(path, { bigint: true }))
    )
      throw Error('Private copy source directory changed');
  } finally {
    await held.close();
  }
}

export async function copyProfileTreeCooperative(
  source: string,
  destination: string,
  check: () => void,
): Promise<void> {
  check();
  try {
    await lstat(source, { bigint: true });
  } catch (error) {
    // Only initial absence is optional. Loss during traversal must refuse.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await directory(source, destination, check, true);
}

export async function copyProfileFileCooperative(
  source: string,
  destination: string,
  check: () => void,
): Promise<void> {
  await regularFile(source, destination, check);
}

export async function syncProfileTreeCooperative(path: string, check: () => void): Promise<void> {
  check();
  const before = await lstat(path, { bigint: true });
  rejectLink(before);
  if (before.isDirectory()) {
    const entries = await opendir(path);
    try {
      for await (const entry of entries) {
        check();
        await syncProfileTreeCooperative(join(path, entry.name), check);
      }
    } finally {
      await entries.close().catch(() => {});
    }
  } else if (!before.isFile()) throw Error('Private copy stage contains a nonregular entry');
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (before.isDirectory() ? constants.O_DIRECTORY : 0),
  );
  try {
    if (!sameFile(before, await handle.stat({ bigint: true })))
      throw Error('Private copy stage changed before sync');
    await handle.sync();
    check();
    if (!sameFile(before, await lstat(path, { bigint: true })))
      throw Error('Private copy stage changed during sync');
  } finally {
    await handle.close();
  }
}
