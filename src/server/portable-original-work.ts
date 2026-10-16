/** Cooperative transport for selected original files. The selected archive and
 * accepted owner remain the caller's authority; this only checks their bytes. */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants, lstatSync, mkdirSync, realpathSync, type BigIntStats } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { copyProfileFileCooperative } from './profile-copy-file-work.ts';
import { profileOriginal } from './profile-storage.ts';
import { captureRecordHeadPhysical } from './record-head-physical.ts';
import type { PortableOriginalInventory } from './portable-original-inventory.ts';
import { disposableSqlite } from './disposable-sqlite.ts';

const CHUNK = 64 * 1024;
type Original = Readonly<{ path: string; sha256: string; bytes: number }>;

/** Capture each original on selected-row admission, before any raw-range read.
 * The roster is disposable; accepted metadata and hashes remain authoritative. */
export function createPortableOriginalPhysicalRoster(
  root: string,
  profileId: string,
  checkpoint: () => void,
): {
  add(original: Original): void;
  current(expectedCount: number): void;
  terminalCurrent(expectedCount: number): void;
  close(): void;
} {
  const scratch = disposableSqlite('health-portable-original-physical-');
  const key = randomBytes(32);
  let closed = false;
  const sign = (path: string, name: string, stat: BigIntStats) =>
    createHmac('sha256', key)
      .update(
        JSON.stringify([
          path,
          name,
          String(stat.dev),
          String(stat.ino),
          String(stat.mode),
          String(stat.nlink),
          String(stat.size),
          String(stat.mtimeNs),
          String(stat.ctimeNs),
        ]),
      )
      .digest('hex');
  const check = (expectedCount: number, withCheckpoint: boolean): void => {
    if (closed) throw Error('Portable original physical roster closed');
    let count = 0;
    for (const row of scratch.db.prepare('SELECT * FROM roster ORDER BY path').iterate()) {
      if (withCheckpoint) checkpoint();
      const path = String(row.path);
      const name = String(row.name);
      if (profileOriginal(root, path, profileId) !== name)
        throw Error('Portable original physical source changed');
      const stat = lstatSync(name, { bigint: true });
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        String(row.dev) !== String(stat.dev) ||
        String(row.ino) !== String(stat.ino) ||
        String(row.mode) !== String(stat.mode) ||
        String(row.nlink) !== String(stat.nlink) ||
        String(row.size) !== String(stat.size) ||
        String(row.mtime) !== String(stat.mtimeNs) ||
        String(row.ctime) !== String(stat.ctimeNs) ||
        String(row.mac) !== sign(path, name, stat)
      )
        throw Error('Portable original physical source changed');
      count++;
    }
    if (count !== expectedCount) throw Error('Portable original physical roster changed');
    if (withCheckpoint) checkpoint();
  };
  try {
    scratch.db.exec(
      'CREATE TABLE roster(path TEXT PRIMARY KEY,name TEXT,dev TEXT,ino TEXT,mode TEXT,nlink TEXT,size TEXT,mtime TEXT,ctime TEXT,mac TEXT)',
    );
    const insert = scratch.db.prepare('INSERT INTO roster VALUES(?,?,?,?,?,?,?,?,?,?)');
    return {
      add(original) {
        if (closed) throw Error('Portable original physical roster closed');
        checkpoint();
        const name = profileOriginal(root, original.path, profileId);
        const stat = lstatSync(name, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink())
          throw Error('Portable original physical source changed');
        const prior = scratch.db.prepare('SELECT * FROM roster WHERE path=?').get(original.path);
        if (prior) {
          if (
            String(prior.name) !== name ||
            String(prior.dev) !== String(stat.dev) ||
            String(prior.ino) !== String(stat.ino) ||
            String(prior.mode) !== String(stat.mode) ||
            String(prior.nlink) !== String(stat.nlink) ||
            String(prior.size) !== String(stat.size) ||
            String(prior.mtime) !== String(stat.mtimeNs) ||
            String(prior.ctime) !== String(stat.ctimeNs) ||
            String(prior.mac) !== sign(original.path, name, stat)
          )
            throw Error('Portable original physical source changed');
        } else {
          insert.run(
            original.path,
            name,
            String(stat.dev),
            String(stat.ino),
            String(stat.mode),
            String(stat.nlink),
            String(stat.size),
            String(stat.mtimeNs),
            String(stat.ctimeNs),
            sign(original.path, name, stat),
          );
        }
        checkpoint();
      },
      current(expectedCount) {
        check(expectedCount, true);
      },
      terminalCurrent(expectedCount) {
        check(expectedCount, false);
      },
      close() {
        if (closed) return;
        closed = true;
        scratch.close();
      },
    };
  } catch (error) {
    scratch.close();
    throw error;
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function verifyOne(
  root: string,
  profileId: string,
  original: Original,
  checkpoint: () => void,
): Promise<BigIntStats> {
  checkpoint();
  const path = profileOriginal(root, original.path, profileId);
  checkpoint();
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.size !== BigInt(original.bytes))
    throw Error('Portable original bytes differ');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = async () => {
      checkpoint();
      if (
        profileOriginal(root, original.path, profileId) !== path ||
        !sameFile(before, await file.stat({ bigint: true })) ||
        !sameFile(before, await lstat(path, { bigint: true }))
      )
        throw Error('Portable original physical source changed');
    };
    await current();
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(CHUNK);
    let offset = 0;
    while (offset < original.bytes) {
      await current();
      const count = Math.min(CHUNK, original.bytes - offset);
      const read = await file.read(buffer, 0, count, offset);
      await current();
      if (!read.bytesRead) throw Error('Portable original bytes differ');
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    await current();
    if (hash.digest('hex') !== original.sha256) throw Error('Portable original checksum differs');
    return before;
  } finally {
    await file.close();
  }
}

function stageDirectories(stage: string, target: string): string[] {
  const paths: string[] = [];
  for (let path = dirname(target); ; path = dirname(path)) {
    paths.push(path);
    if (path === stage) break;
    if (path === dirname(path)) throw Error('Portable original target escaped stage');
  }
  return paths;
}

function createStageDirectories(stage: string, target: string, checkpoint: () => void): string[] {
  const directories = stageDirectories(stage, target);
  const pinned = new Map<string, BigIntStats>();
  for (const path of [...directories].reverse()) {
    checkpoint();
    const parent = dirname(path);
    if (path !== stage) {
      const expected = pinned.get(parent);
      if (!expected || !sameFile(expected, lstatSync(parent, { bigint: true })))
        throw Error('Portable original target directory changed');
    }
    let stat: BigIntStats;
    try {
      stat = lstatSync(path, { bigint: true });
    } catch (error) {
      if (path === stage || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(path, { mode: 0o700 });
      stat = lstatSync(path, { bigint: true });
      const updatedParent = lstatSync(parent, { bigint: true });
      const expectedParent = pinned.get(parent)!;
      if (
        !updatedParent.isDirectory() ||
        updatedParent.isSymbolicLink() ||
        updatedParent.dev !== expectedParent.dev ||
        updatedParent.ino !== expectedParent.ino ||
        updatedParent.mode !== expectedParent.mode
      )
        throw Error('Portable original target directory changed');
      pinned.set(parent, updatedParent);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error('Portable original target directory changed');
    pinned.set(path, stat);
  }
  for (const [path, stat] of pinned)
    if (!sameFile(stat, lstatSync(path, { bigint: true })))
      throw Error('Portable original target directory changed');
  return directories;
}

/** Repeat after callback-capable staging; the caller still owns its terminal proof. */
export async function verifyPortableOriginalInventory(
  root: string,
  profileId: string,
  inventory: PortableOriginalInventory,
  checkpoint: () => void,
): Promise<void> {
  for (const original of inventory.originals())
    await verifyOne(root, profileId, original, checkpoint);
}

/** Private target transport only; the caller still owns final archive/owner proof. */
export async function copyPortableOriginalInventory(
  root: string,
  stageRoot: string,
  profileId: string,
  inventory: PortableOriginalInventory,
  checkpoint: () => void,
): Promise<void> {
  const stage = realpathSync(stageRoot);
  for (const original of inventory.originals()) {
    checkpoint();
    const source = profileOriginal(root, original.path, profileId);
    const before = await verifyOne(root, profileId, original, checkpoint);
    const target = resolve(stage, original.path);
    if (!target.startsWith(stage + '/')) throw Error('Portable original target escaped stage');
    const directories = createStageDirectories(stage, target, checkpoint);
    const parents = captureRecordHeadPhysical([], directories);
    try {
      const current = () => {
        checkpoint();
        if (!parents.current()) throw Error('Portable original target directory changed');
      };
      current();
      await copyProfileFileCooperative(source, target, current);
      current();
      const after = await verifyOne(root, profileId, original, current);
      if (!sameFile(before, after)) throw Error('Portable original physical source changed');
      await verifyOne(stage, profileId, original, current);
      const terminal = await verifyOne(root, profileId, original, current);
      if (!sameFile(before, terminal)) throw Error('Portable original physical source changed');
    } finally {
      parents.close();
    }
  }
}
