/** Journal writers retain native filesystem semantics while invalidating in-flight physical reads. */
import * as fs from 'node:fs';
import { beginManagedPhysicalMutation } from './clinical-review-physical-epoch.ts';

function mutation<T>(work: () => T): T {
  const finish = beginManagedPhysicalMutation();
  try {
    return work();
  } finally {
    finish();
  }
}

export const mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) =>
  mutation(() => Reflect.apply(fs.mkdirSync, fs, args))) as typeof fs.mkdirSync;
export const writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) =>
  mutation(() => Reflect.apply(fs.writeFileSync, fs, args))) as typeof fs.writeFileSync;
export const renameSync = ((...args: Parameters<typeof fs.renameSync>) =>
  mutation(() => Reflect.apply(fs.renameSync, fs, args))) as typeof fs.renameSync;
export const linkSync = ((...args: Parameters<typeof fs.linkSync>) =>
  mutation(() => Reflect.apply(fs.linkSync, fs, args))) as typeof fs.linkSync;
export const unlinkSync = ((...args: Parameters<typeof fs.unlinkSync>) =>
  mutation(() => Reflect.apply(fs.unlinkSync, fs, args))) as typeof fs.unlinkSync;
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
  return writable ? mutation(() => fs.openSync(path, flags, mode)) : fs.openSync(path, flags, mode);
};
