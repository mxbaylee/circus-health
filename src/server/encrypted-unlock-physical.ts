import { createHash } from 'node:crypto';
import { opendirSync, lstatSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, relative } from 'node:path';

export interface UnlockPhysicalWitness {
  identity: string;
  sha256: string;
  entries: number;
  metadataBytes: number;
}
function refuse(): never {
  throw Error('Encrypted profile physical evidence changed');
}
export function unlockPhysicalIdentity(path: string): {
  kind: 'file' | 'directory';
  value: string;
} {
  const stat = lstatSync(path, { bigint: true });
  if (realpathSync(path) !== path || stat.isSymbolicLink()) refuse();
  if (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)) refuse();
  return {
    kind: stat.isDirectory() ? 'directory' : 'file',
    value: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
  };
}
export function unlockPhysicalDigest(path: string): string {
  const fd = openSync(path, 'r'),
    hash = createHash('sha256'),
    bytes = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const count = readSync(fd, bytes, 0, bytes.length, null);
      if (!count) break;
      hash.update(bytes.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}
export function* unlockPhysicalEntries(
  root: string,
): Generator<{ path: string; kind: 'file' | 'directory'; identity: string }> {
  const initial = unlockPhysicalIdentity(root);
  if (initial.kind !== 'directory') refuse();
  yield { path: '', kind: initial.kind, identity: initial.value };
  const stack = [{ path: root, directory: opendirSync(root) }];
  try {
    while (stack.length) {
      const current = stack[stack.length - 1]!;
      const entry = current.directory.readSync();
      if (!entry) {
        current.directory.closeSync();
        stack.pop();
        continue;
      }
      const path = resolve(current.path, entry.name),
        physical = unlockPhysicalIdentity(path);
      yield { path: relative(root, path), kind: physical.kind, identity: physical.value };
      if (physical.kind === 'directory') stack.push({ path, directory: opendirSync(path) });
    }
  } finally {
    for (const current of stack) current.directory.closeSync();
  }
}

/** Private attempt evidence, never an archive/cache recovery authority. */
export function captureUnlockPhysicalWitness(root: string, path: string): UnlockPhysicalWitness {
  const db = new DatabaseSync(path);
  let count = 0,
    metadataBytes = 0;
  try {
    db.exec(
      'CREATE TABLE physical(path TEXT PRIMARY KEY, kind TEXT NOT NULL, identity TEXT NOT NULL); BEGIN',
    );
    const insert = db.prepare('INSERT INTO physical VALUES(?,?,?)');
    for (const item of unlockPhysicalEntries(root)) {
      insert.run(item.path, item.kind, item.identity);
      count++;
      metadataBytes +=
        Buffer.byteLength(item.path) +
        Buffer.byteLength(item.kind) +
        Buffer.byteLength(item.identity);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  const physical = unlockPhysicalIdentity(path).value;
  const sha256 = unlockPhysicalDigest(path);
  if (unlockPhysicalIdentity(path).value !== physical) refuse();
  return { identity: physical, sha256, entries: count, metadataBytes };
}

/** A complete synchronous worker sweep against the original attempt's identities. */
export function verifyUnlockPhysicalWitness(
  root: string,
  path: string,
  expected: UnlockPhysicalWitness,
): number {
  if (
    unlockPhysicalIdentity(path).value !== expected.identity ||
    unlockPhysicalDigest(path) !== expected.sha256
  )
    refuse();
  const db = new DatabaseSync(path, { readOnly: true });
  let count = 0;
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name='expected_physical'").get()
      ? 'expected_physical'
      : 'physical';
    const lookup = db.prepare(`SELECT kind,identity FROM ${table} WHERE path=?`);
    for (const item of unlockPhysicalEntries(root)) {
      const original = lookup.get(item.path);
      if (!original || original.kind !== item.kind || original.identity !== item.identity) refuse();
      count++;
    }
    if (
      count !== expected.entries ||
      db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count !== count
    )
      refuse();
  } finally {
    db.close();
  }
  if (
    unlockPhysicalIdentity(path).value !== expected.identity ||
    unlockPhysicalDigest(path) !== expected.sha256
  )
    refuse();
  return count;
}
