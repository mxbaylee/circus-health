import koffi from 'koffi';

// Supported deployment/contributor platforms use these POSIX flock constants.
// Koffi supplies prebuilt native bindings, so host tooling needs no Python or
// compiler. Never replace this with a stale lockfile/PID heuristic: crashes
// must release the actual kernel lease without unlinking its retained inode.
if (process.platform !== 'darwin' && process.platform !== 'linux')
  throw new Error('Kernel storage locking requires macOS or Linux');
const library = koffi.load(
  process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
);
const flock = library.func('int flock(int fd, int operation)');

export function flockExclusiveNonblocking(descriptor: number): boolean {
  if (flock(descriptor, 2 | 4) === 0) return true;
  const error = koffi.errno();
  if (error === koffi.os.errno.EAGAIN || error === koffi.os.errno.EWOULDBLOCK) return false;
  throw new Error(`Could not acquire kernel storage lock (errno ${error})`);
}

export function flockUnlock(descriptor: number): void {
  if (flock(descriptor, 8) !== 0)
    throw new Error(`Could not release kernel storage lock (errno ${koffi.errno()})`);
}
