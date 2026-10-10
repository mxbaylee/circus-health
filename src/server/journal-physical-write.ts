/** Journal writers retain native filesystem semantics while invalidating in-flight physical reads. */
import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { beginManagedPhysicalMutation } from './clinical-review-physical-epoch.ts';

function paths(...operands: unknown[]): readonly string[] | undefined {
  if (!operands.every((operand): operand is string => typeof operand === 'string'))
    return undefined;
  for (const operand of operands) {
    try {
      const stat = fs.statSync(operand);
      if (stat.isFile() && stat.nlink !== 1) return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    }
  }
  return operands;
}

function mutation<T>(operands: readonly string[] | undefined, work: () => T): T {
  const finish = beginManagedPhysicalMutation(operands);
  try {
    return work();
  } finally {
    finish();
  }
}

function exclusivePath(path: string): { path: string; dev: bigint; ino: bigint } | undefined {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  try {
    const stat = fs.lstatSync(parent, { bigint: true });
    return fs.realpathSync.native(parent) === parent && stat.isDirectory()
      ? { path: absolute, dev: stat.dev, ino: stat.ino }
      : undefined;
  } catch {
    return undefined;
  }
}

function exclusiveFileCurrent(
  admitted: { path: string; dev: bigint; ino: bigint },
  opened: fs.BigIntStats,
  links = 1n,
  original?: fs.BigIntStats,
): boolean {
  try {
    const parent = dirname(admitted.path);
    const parentStat = fs.lstatSync(parent, { bigint: true });
    const named = fs.lstatSync(admitted.path, { bigint: true });
    return (
      parentStat.isDirectory() &&
      parentStat.dev === admitted.dev &&
      parentStat.ino === admitted.ino &&
      fs.realpathSync.native(parent) === parent &&
      named.isFile() &&
      named.nlink === links &&
      named.dev === opened.dev &&
      named.ino === opened.ino &&
      named.mode === opened.mode &&
      named.size === opened.size &&
      named.mtimeNs === opened.mtimeNs &&
      (!original || named.ctimeNs === original.ctimeNs) &&
      fs.realpathSync.native(admitted.path) === admitted.path
    );
  } catch {
    return false;
  }
}

declare const exclusiveJournalFileBrand: unique symbol;
export interface ExclusiveJournalFile {
  readonly [exclusiveJournalFileBrand]: true;
}
const exclusiveJournalFiles = new WeakMap<
  ExclusiveJournalFile,
  { admitted: { path: string; dev: bigint; ino: bigint }; opened: fs.BigIntStats }
>();

/** A newly created single-link journal file cannot alias an existing record predecessor. */
export function writeExclusiveJournalFileSync(
  path: string,
  data: string | Buffer,
): ExclusiveJournalFile {
  const admitted = exclusivePath(path);
  const finish = beginManagedPhysicalMutation(admitted ? [admitted.path] : undefined);
  let completed = false;
  let opened: fs.BigIntStats | undefined;
  try {
    const fd = fs.openSync(
      path,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const initial = fs.fstatSync(fd, { bigint: true });
      if (
        !admitted ||
        !initial.isFile() ||
        initial.nlink !== 1n ||
        !exclusiveFileCurrent(admitted, initial)
      )
        throw Error('Journal file is not exclusive');
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      opened = fs.fstatSync(fd, { bigint: true });
      if (!exclusiveFileCurrent(admitted, opened))
        throw Error('Journal file changed during exclusive write');
    } finally {
      fs.closeSync(fd);
    }
    completed = true;
  } finally {
    if (!completed) beginManagedPhysicalMutation()();
    finish();
  }
  const receipt = Object.freeze({}) as ExclusiveJournalFile;
  exclusiveJournalFiles.set(receipt, { admitted: admitted!, opened: opened! });
  return receipt;
}

/** Installs only the exact freshly created file; generic hard-link writes stay unknown. */
export function linkExclusiveJournalFileSync(
  receipt: ExclusiveJournalFile,
  destination: string,
): void {
  const source = exclusiveJournalFiles.get(receipt);
  exclusiveJournalFiles.delete(receipt);
  const target = exclusivePath(destination);
  const finish = beginManagedPhysicalMutation(
    source && target ? [source.admitted.path, target.path] : undefined,
  );
  let completed = false;
  try {
    if (
      !source ||
      !target ||
      !exclusiveFileCurrent(source.admitted, source.opened, 1n, source.opened)
    )
      throw Error('Journal exclusive file changed before installation');
    fs.linkSync(source.admitted.path, target.path);
    if (
      !exclusiveFileCurrent(source.admitted, source.opened, 2n) ||
      !exclusiveFileCurrent(target, source.opened, 2n)
    )
      throw Error('Journal exclusive link changed during installation');
    fs.unlinkSync(source.admitted.path);
    if (!exclusiveFileCurrent(target, source.opened))
      throw Error('Journal exclusive file changed after installation');
    completed = true;
  } finally {
    if (!completed) beginManagedPhysicalMutation()();
    finish();
  }
}

export const mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) =>
  mutation(paths(args[0]), () => Reflect.apply(fs.mkdirSync, fs, args))) as typeof fs.mkdirSync;
export const writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) =>
  mutation(paths(args[0]), () =>
    Reflect.apply(fs.writeFileSync, fs, args),
  )) as typeof fs.writeFileSync;
export const renameSync = ((...args: Parameters<typeof fs.renameSync>) =>
  mutation(paths(args[0], args[1]), () =>
    Reflect.apply(fs.renameSync, fs, args),
  )) as typeof fs.renameSync;
export const linkSync = ((...args: Parameters<typeof fs.linkSync>) =>
  mutation(paths(args[0], args[1]), () =>
    Reflect.apply(fs.linkSync, fs, args),
  )) as typeof fs.linkSync;
export const unlinkSync = ((...args: Parameters<typeof fs.unlinkSync>) =>
  mutation(paths(args[0]), () => Reflect.apply(fs.unlinkSync, fs, args))) as typeof fs.unlinkSync;
export const openSync: typeof fs.openSync = (path, flags, mode) => {
  const writable =
    typeof flags === 'string'
      ? /[wa+]/.test(flags)
      : (flags &
          (fs.constants.O_WRONLY |
            fs.constants.O_RDWR |
            fs.constants.O_CREAT |
            fs.constants.O_TRUNC |
            fs.constants.O_APPEND)) !==
        0;
  return writable
    ? mutation(paths(path), () => fs.openSync(path, flags, mode))
    : fs.openSync(path, flags, mode);
};
