import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { regularFileIdentity } from './regular-file-identity.ts';
import type { ClinicalPhysicalItem } from './clinical-review-physical-worker.ts';

function absent(path: string): boolean {
  if (realpathSync(dirname(path)) !== dirname(path)) return false;
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function marker(item: Extract<ClinicalPhysicalItem, { kind: 'marker' }>): boolean {
  if (item.expected === 'absent') return absent(item.path);
  if (realpathSync(item.path) !== item.path) return false;
  const fd = openSync(item.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 4096 ||
      (item.expected.bytes !== undefined && stat.size !== item.expected.bytes)
    )
      return false;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) return false;
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) return false;
    return createHash('sha256').update(bytes).digest('hex') === item.expected.sha256;
  } finally {
    closeSync(fd);
  }
}

function directory(item: Extract<ClinicalPhysicalItem, { kind: 'directory' }>): boolean {
  if (item.expectedIdentity === 'absent') return absent(item.path);
  if (realpathSync(item.path) !== item.path) return false;
  const stat = statSync(item.path, { bigint: true });
  return (
    stat.isDirectory() &&
    [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(':') === item.expectedIdentity
  );
}

function verify(item: ClinicalPhysicalItem): boolean {
  if (item.kind === 'identity') return regularFileIdentity(item.path) === item.expectedIdentity;
  if (item.kind === 'marker') return marker(item);
  return directory(item);
}

let nextId = 1;
parentPort!.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return parentPort!.postMessage({ failure: true });
  const command = message as { type?: string; id?: number; items?: ClinicalPhysicalItem[] };
  if (command.type === 'close' && command.id === nextId) {
    parentPort!.postMessage({ id: nextId++, closed: true });
    parentPort!.close();
    return;
  }
  if (
    command.type !== 'page' ||
    command.id !== nextId ||
    !Array.isArray(command.items) ||
    command.items.length < 1 ||
    command.items.length > 64
  )
    return parentPort!.postMessage({ failure: true });
  try {
    for (const item of command.items) if (!verify(item)) throw Error('physical mismatch');
  } catch {
    return parentPort!.postMessage({ id: nextId++, sourceChanged: true });
  }
  parentPort!.postMessage({ id: nextId++, count: command.items.length });
});
// Cancellation may terminate the worker only after its module graph has finished loading.
setImmediate(() => parentPort!.postMessage({ ready: true }));
