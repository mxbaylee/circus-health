import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireStorageLock } from '../src/server/storage-lock.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function syncFile(path: string, bytes: Buffer) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Operates only in a fresh, caller-owned fictional scratch directory. */
export async function probeDrive(directory: string, nonce: string) {
  assert.match(nonce, /^[a-f0-9-]{36}$/u);
  mkdirSync(directory, { mode: 0o700 });
  const bytes = Buffer.from('Independently fictional drive qualification: ' + nonce);
  const staging = join(directory, 'staging');
  const published = join(directory, 'published');
  const linked = join(directory, 'linked');
  syncFile(staging, bytes);
  assert.throws(() => openSync(staging, 'wx', 0o600), { code: 'EEXIST' });
  linkSync(staging, linked);
  assert.equal(statSync(linked).ino, statSync(staging).ino);
  assert.throws(() => linkSync(staging, linked), { code: 'EEXIST' });
  renameSync(staging, published);
  syncDirectory(directory);
  assert.equal(hash(readFileSync(published)), hash(bytes));
  assert.equal(hash(readFileSync(linked)), hash(bytes));

  const first = await acquireStorageLock(directory);
  const inode = statSync(join(directory, '.health-writer.lock')).ino;
  try {
    await assert.rejects(acquireStorageLock(directory), /already has an active writer/u);
  } finally {
    await first.release();
  }
  const afterRelease = await acquireStorageLock(directory);
  assert.equal(statSync(join(directory, '.health-writer.lock')).ino, inode);
  process.kill(afterRelease.pid!, 'SIGKILL');
  await assert.rejects(afterRelease.failure, /storage lock was lost/u);
  await afterRelease.release();
  const afterKill = await acquireStorageLock(directory);
  try {
    assert.equal(statSync(join(directory, '.health-writer.lock')).ino, inode);
  } finally {
    await afterKill.release();
  }
  return {
    exclusiveCreate: true,
    hardLinks: true,
    publicationRename: true,
    fileSync: true,
    directorySync: true,
    concurrentWriterRejected: true,
    retainedLockInode: true,
    releaseReacquired: true,
    killedWriterReacquired: true,
    filesystemType: statfsSync(directory).type,
  } as const;
}

/** A second process/container must read the first container's exact publication. */
export async function verifyDrivePublication(directory: string, nonce: string) {
  assert.match(nonce, /^[a-f0-9-]{36}$/u);
  const expected = Buffer.from('Independently fictional drive qualification: ' + nonce);
  assert.equal(hash(readFileSync(join(directory, 'published'))), hash(expected));
  assert.equal(hash(readFileSync(join(directory, 'linked'))), hash(expected));
  const lease = await acquireStorageLock(directory);
  await lease.release();
  return { publicationRetained: true, writerReacquired: true } as const;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, directory, nonce] = process.argv.slice(2);
    assert.ok(directory && nonce && ['write', 'verify'].includes(mode));
    console.log(
      JSON.stringify(
        await (mode === 'write'
          ? probeDrive(directory, nonce)
          : verifyDrivePublication(directory, nonce)),
      ),
    );
  } catch {
    console.error('Drive probe failed. No archive records or credentials were inspected.');
    process.exitCode = 1;
  }
}
