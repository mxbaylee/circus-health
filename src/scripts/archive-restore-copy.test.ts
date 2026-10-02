import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertArchiveInventory,
  copyArchiveForDrill,
  inventoryArchive,
} from './archive-restore-copy.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'fictional-restore-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, 'originals'), { recursive: true });
  await mkdir(join(source, 'empty'));
  await writeFile(join(source, 'key-envelope'), Buffer.from([3, 1, 4, 1]));
  await writeFile(join(source, 'originals', 'fictional.bin'), Buffer.from([5, 9, 2, 6, 5]));
  return { root, source, destination: join(root, 'independent') };
}

test('inventory is deterministic, content-free, and includes empty directories', async (t) => {
  const { source } = await fixture(t);
  const receipt = await inventoryArchive(source);
  assert.deepEqual(receipt, await inventoryArchive(source));
  assert.equal(receipt.files, 2);
  assert.equal(receipt.bytes, 9);
  assert.deepEqual(
    receipt.entries.map((entry) => entry.path),
    ['empty', 'key-envelope', 'originals', 'originals/fictional.bin'],
  );
  assert.equal(
    receipt.treeHash,
    createHash('sha256').update(JSON.stringify(receipt.entries)).digest('hex'),
  );
  assert.deepEqual(await assertArchiveInventory(source, receipt), {
    files: 2,
    bytes: 9,
    treeHash: receipt.treeHash,
  });
});

test('copy is exact, independent and owner-only; tampering and missing components fail without changing source', async (t) => {
  const { source, destination } = await fixture(t);
  const before = await inventoryArchive(source);
  const sourceStat = await lstat(join(source, 'key-envelope'));
  assert.deepEqual(await copyArchiveForDrill(source, destination), before);
  for (const entry of before.entries) {
    const target = join(destination, entry.path);
    assert.equal((await lstat(target)).mode & 0o777, entry.kind === 'directory' ? 0o700 : 0o600);
    if (entry.kind === 'file')
      assert.deepEqual(await readFile(target), await readFile(join(source, entry.path)));
  }
  assert.equal((await lstat(destination)).mode & 0o777, 0o700);
  assert.notEqual((await lstat(join(destination, 'key-envelope'))).ino, sourceStat.ino);
  await writeFile(join(destination, 'key-envelope'), Buffer.from([3, 1, 4, 2]));
  await assert.rejects(assertArchiveInventory(destination, before), /qualification failed/);
  await assertArchiveInventory(source, before);
  assert.equal((await lstat(join(source, 'key-envelope'))).mtimeMs, sourceStat.mtimeMs);
  await writeFile(join(destination, 'key-envelope'), await readFile(join(source, 'key-envelope')));
  await rm(join(destination, 'originals', 'fictional.bin'));
  await assert.rejects(assertArchiveInventory(destination, before), /qualification failed/);
  await assertArchiveInventory(source, before);
  assert.ok((await lstat(destination)).isDirectory());
});

test('refuses existing destinations, overlapping paths, missing or invalid roots', async (t) => {
  const { root, source, destination } = await fixture(t);
  const before = await inventoryArchive(source);
  await mkdir(destination);
  for (const target of [destination, source, join(source, 'nested'), root]) {
    await assert.rejects(copyArchiveForDrill(source, target), /qualification failed/);
  }
  await writeFile(join(root, 'existing-file'), 'fictional');
  await assert.rejects(
    copyArchiveForDrill(source, join(root, 'existing-file')),
    /qualification failed/,
  );
  await assert.rejects(
    copyArchiveForDrill(join(root, 'missing'), join(root, 'fresh')),
    /qualification failed/,
  );
  await assert.rejects(inventoryArchive(''), /qualification failed/);
  await assert.rejects(inventoryArchive('/'), /qualification failed/);
  await assert.rejects(inventoryArchive(join(root, 'existing-file')), /qualification failed/);
  await assert.rejects(lstat(join(source, 'nested')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(root, 'fresh')), { code: 'ENOENT' });
  await assertArchiveInventory(source, before);
});

test('concurrent attempts exclusively reserve one destination without overwriting the winner', async (t) => {
  const { source, destination } = await fixture(t);
  const expected = await inventoryArchive(source);
  const attempts = await Promise.allSettled([
    copyArchiveForDrill(source, destination),
    copyArchiveForDrill(source, destination),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  await assertArchiveInventory(destination, expected);
  await assertArchiveInventory(source, expected);
});

test('rejects links in source, roots and destination ancestry, with safe errors', async (t) => {
  const { root, source, destination } = await fixture(t);
  const linkedRoot = join(root, 'linked-root');
  await symlink(source, linkedRoot);
  await assert.rejects(inventoryArchive(linkedRoot), {
    message: 'Encrypted archive qualification failed.',
  });
  await assert.rejects(
    copyArchiveForDrill(source, join(linkedRoot, 'new')),
    /qualification failed/,
  );
  await symlink(join(source, 'key-envelope'), join(source, 'link'));
  await assert.rejects(copyArchiveForDrill(source, destination), {
    message: 'Encrypted archive qualification failed.',
  });
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
  await rm(join(source, 'link'));
  await symlink(join(root, 'absent'), destination);
  await assert.rejects(copyArchiveForDrill(source, destination), /qualification failed/);
  assert.ok((await lstat(destination)).isSymbolicLink());
});

test('rejects special entries and receipt path escapes without reading their targets', async (t) => {
  const { source } = await fixture(t);
  const receipt = await inventoryArchive(source);
  const malicious = { ...receipt, entries: [{ path: '../outside', kind: 'directory' as const }] };
  await assert.rejects(assertArchiveInventory(source, malicious), /qualification failed/);
  // A local socket is a real special entry; opening it would be incorrect.
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(join(source, 'socket'), resolve);
  });
  try {
    await assert.rejects(inventoryArchive(source), /qualification failed/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
