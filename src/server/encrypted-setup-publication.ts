import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  openSync,
  fsyncSync,
  closeSync,
  fstatSync,
  readSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative } from 'node:path';
import {
  unlockPhysicalDigest,
  unlockPhysicalEntries,
  unlockPhysicalIdentity,
  verifyUnlockPhysicalWitness,
  type UnlockPhysicalWitness,
} from './encrypted-unlock-physical.ts';

function changed(): never {
  throw Error('Encrypted setup publication changed');
}
const inode = (value: string) => value.split(':').slice(0, 2).join(':');
function fdIdentity(fd: number): string {
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n) changed();
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function createOwnedCiphertext(source: string, target: string, expectedSource: string): string {
  const input = openSync(source, 'r');
  let output: number | undefined;
  try {
    if (
      fdIdentity(input) !== expectedSource ||
      unlockPhysicalIdentity(source).value !== expectedSource
    )
      changed();
    const expectedDigest = unlockPhysicalDigest(source);
    // Exclusive creation is the no-replace boundary. Failure or interruption
    // leaves only unselected output; it never certifies a partial overlay row.
    output = openSync(target, 'wx', 0o600);
    const initialOutput = fdIdentity(output),
      bytes = Buffer.alloc(64 * 1024),
      hash = createHash('sha256');
    for (;;) {
      const count = readSync(input, bytes, 0, bytes.length, null);
      if (!count) break;
      hash.update(bytes.subarray(0, count));
      for (let written = 0; written < count;)
        written += writeSync(output, bytes, written, count - written);
    }
    fsyncSync(output);
    const receipt = fdIdentity(output);
    if (
      hash.digest('hex') !== expectedDigest ||
      fdIdentity(input) !== expectedSource ||
      unlockPhysicalIdentity(source).value !== expectedSource ||
      inode(receipt) !== inode(initialOutput) ||
      unlockPhysicalIdentity(target).value !== receipt
    )
      changed();
    return receipt;
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(input);
  }
}
export function sealSetupPhysicalWitness(path: string): UnlockPhysicalWitness {
  const db = new DatabaseSync(path, { readOnly: true });
  let entries = 0,
    metadataBytes = 0;
  try {
    for (const row of db.prepare('SELECT path,kind,identity FROM expected_physical').iterate()) {
      entries++;
      metadataBytes +=
        Buffer.byteLength(String(row.path)) +
        Buffer.byteLength(String(row.kind)) +
        Buffer.byteLength(String(row.identity));
    }
  } finally {
    db.close();
  }
  const identity = unlockPhysicalIdentity(path).value,
    sha256 = unlockPhysicalDigest(path);
  if (unlockPhysicalIdentity(path).value !== identity) changed();
  return { identity, sha256, entries, metadataBytes };
}

/** Keeps immutable input rows; the separate overlay certifies only owned writes. */
export function stageSetupImmutableAdditions(
  root: string,
  candidate: string,
  witnessPath: string,
  original: UnlockPhysicalWitness,
): UnlockPhysicalWitness {
  verifyUnlockPhysicalWitness(root, witnessPath, original);
  const db = new DatabaseSync(witnessPath);
  try {
    db.exec(`CREATE TABLE owned(path TEXT PRIMARY KEY,kind TEXT NOT NULL,identity TEXT NOT NULL);
      CREATE VIEW expected_physical AS SELECT path,kind,identity FROM owned UNION ALL
      SELECT path,kind,identity FROM physical WHERE path NOT IN (SELECT path FROM owned)`);
    const lookup = db.prepare('SELECT kind,identity FROM expected_physical WHERE path=?'),
      record = db.prepare('INSERT OR REPLACE INTO owned VALUES(?,?,?)');
    const check = (path: string) => {
      const old = lookup.get(relative(root, path)),
        current = unlockPhysicalIdentity(path);
      if (!old || old.kind !== current.kind || old.identity !== current.value) changed();
      return current.value;
    };
    const owned = (path: string) => {
      const current = unlockPhysicalIdentity(path);
      record.run(relative(root, path), current.kind, current.value);
    };
    for (const item of unlockPhysicalEntries(candidate)) {
      if (!item.path || item.path === 'manifest.enc') continue;
      const target = resolve(root, item.path),
        source = resolve(candidate, item.path);
      if (lookup.get(item.path)) {
        check(target);
        if (item.kind === 'file' && unlockPhysicalDigest(source) !== unlockPhysicalDigest(target))
          changed();
        check(target);
        continue;
      }
      if (existsSync(target)) changed();
      const parent = dirname(target);
      const parentBefore = check(parent),
        rootBefore = check(root);
      let receipt: string | undefined;
      if (item.kind === 'directory') mkdirSync(target, { mode: 0o700 });
      else receipt = createOwnedCiphertext(source, target, item.identity);
      const fd = openSync(parent, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (
        inode(unlockPhysicalIdentity(parent).value) !== inode(parentBefore) ||
        inode(unlockPhysicalIdentity(root).value) !== inode(rootBefore) ||
        (receipt && unlockPhysicalIdentity(target).value !== receipt)
      )
        changed();
      owned(target);
      owned(parent);
    }
  } finally {
    db.close();
  }
  const sealed = sealSetupPhysicalWitness(witnessPath);
  verifyUnlockPhysicalWitness(root, witnessPath, sealed);
  return sealed;
}

/** Called only after the owned manifest rename; original input rows stay intact. */
export function finishSetupManifestWitness(
  root: string,
  witnessPath: string,
  before: UnlockPhysicalWitness,
  manifestIdentity: string,
  ownedRootIdentity: string,
): UnlockPhysicalWitness {
  if (
    unlockPhysicalIdentity(witnessPath).value !== before.identity ||
    unlockPhysicalDigest(witnessPath) !== before.sha256
  )
    changed();
  if (unlockPhysicalIdentity(resolve(root, 'manifest.enc')).value !== manifestIdentity) changed();
  const currentRoot = unlockPhysicalIdentity(root);
  if (currentRoot.kind !== 'directory' || currentRoot.value !== ownedRootIdentity) changed();
  const db = new DatabaseSync(witnessPath);
  try {
    const record = db.prepare('INSERT OR REPLACE INTO owned VALUES(?,?,?)');
    record.run('manifest.enc', 'file', manifestIdentity);
    record.run('', 'directory', currentRoot.value);
  } finally {
    db.close();
  }
  const sealed = sealSetupPhysicalWitness(witnessPath);
  verifyUnlockPhysicalWitness(root, witnessPath, sealed);
  return sealed;
}
