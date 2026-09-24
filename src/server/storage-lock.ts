import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

// Docker Desktop's VM does not share host macOS advisory locks. Persist the
// permitted writer domain as well; kernel locks still exclude same-domain peers.
// A crash must not silently hand a Linux-owned archive back to host development.
export type StorageWriterDomain = 'darwin' | 'linux';

export interface StorageLock {
  failure: Promise<never>;
  pid: number | undefined;
  release(): Promise<void>;
}

export interface StorageLockOptions {
  domain?: NodeJS.Platform;
  allowSwitchFrom?: StorageWriterDomain;
}

const isStorageWriterDomain = (value: unknown): value is StorageWriterDomain =>
  value === 'darwin' || value === 'linux';

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

function reserveDomain(
  directory: string,
  domain: StorageWriterDomain,
  allowSwitchFrom?: StorageWriterDomain,
): void {
  const path = resolve(directory, '.health-writer-domain');
  const read = () => readFileSync(path, 'utf8').trim();
  const publish = (replace: boolean) => {
    const temporary = path + '.' + randomUUID();
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, domain + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      if (replace) renameSync(temporary, path);
      else {
        try {
          linkSync(temporary, path);
        } catch (error) {
          if (!isErrnoException(error) || error.code !== 'EEXIST') throw error;
        }
      }
      const parent = openSync(directory, 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  };
  if (!existsSync(path)) publish(false);
  const owner = read();
  if (!['darwin', 'linux'].includes(owner))
    throw new Error(
      'Invalid storage writer domain; inspect the operational marker before starting',
    );
  if (owner === domain) return;
  // Only the host launcher may transfer a stopped Darwin archive to Docker,
  // while holding the Darwin kernel lease. No implicit reverse handoff exists.
  if (owner === 'darwin' && domain === 'linux' && allowSwitchFrom === 'darwin') {
    publish(true);
    return;
  }
  throw new Error(
    `Durable data directory is reserved for ${owner} writers; this ${domain} process cannot use it. Stop the other runtime and perform a reviewed storage handoff, or use a separate data copy.`,
  );
}

// A kernel advisory lock survives neither a killed process nor a lost
// container. The inode is retained: removing a lock file would allow two
// writers to lock different inodes. All operators must honor this lock.
export function acquireStorageLock(
  dataDirectory: string,
  { domain = process.platform, allowSwitchFrom }: StorageLockOptions = {},
): Promise<StorageLock> {
  if (
    !isStorageWriterDomain(domain) ||
    (allowSwitchFrom &&
      !(process.platform === 'darwin' && domain === 'linux' && allowSwitchFrom === 'darwin'))
  )
    return Promise.reject(new Error('Unsupported storage writer domain handoff'));
  return new Promise((resolveLock, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./storage-lock-holder.ts', import.meta.url)),
        resolve(dataDirectory, '.health-writer.lock'),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let settled = false,
      released = false;
    const failure = new Promise<never>((_, rejectLost) => {
      child.once('exit', (code) => {
        if (!settled) {
          settled = true;
          reject(
            new Error(
              code === 73
                ? 'Durable data directory already has an active writer'
                : 'Could not acquire durable storage lock',
            ),
          );
        } else if (!released) rejectLost(new Error('Durable storage lock was lost'));
      });
    });
    // Attach immediately; the runtime also listens and stops on lost locking.
    failure.catch(() => {});
    child.once('error', () => {
      if (!settled) {
        settled = true;
        reject(new Error('Could not start the durable storage lock holder'));
      }
    });
    child.stdout.once('data', (bytes) => {
      if (bytes.toString().trim() !== 'locked' || settled) return;
      try {
        reserveDomain(dataDirectory, domain, allowSwitchFrom);
      } catch (error) {
        settled = true;
        released = true;
        child.stdin.end();
        reject(error);
        return;
      }
      settled = true;
      resolveLock({
        failure,
        pid: child.pid,
        release() {
          released = true;
          return new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              done();
              return;
            }
            child.once('exit', done);
            child.stdin.end();
          });
        },
      });
    });
  });
}
