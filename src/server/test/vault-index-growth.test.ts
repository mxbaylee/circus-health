import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { freshKey } from '../vault-crypto.ts';
import { openVault } from '../vault-store.ts';

function encryptedFiles(directory: string, kind: string) {
  const path = join(directory, 'vault', kind);
  return fs.existsSync(path)
    ? fs
        .readdirSync(path)
        .filter((name) => name.endsWith('.enc'))
        .map((name) => ({ name, bytes: fs.statSync(join(path, name)).size }))
    : [];
}

test('300 changed bindings append bounded encrypted generations without hot history rereads', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'vault-index-growth-'));
  const directory = join(root, 'durable');
  const workspace = join(root, 'workspace');
  fs.mkdirSync(workspace);
  const key = freshKey();
  const profileId = 'fictional-vault-growth';
  const vaults: ReturnType<typeof openVault>[] = [];
  const open = (initialize = false) => {
    const vault = openVault({ directory, profileId, key, initialize });
    vaults.push(vault);
    return vault;
  };
  const originalOpen = fs.openSync;
  t.after(() => {
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
    for (const vault of vaults) vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const vault = open(true);
  for (let i = 0; i < 1000; i++) {
    const name = `originals/fictional-${i}.txt`;
    const content = Buffer.from(`Independently fictional original ${i}.`);
    vault.storeFile(name, content);
  }
  vault.publish();
  const baseline = encryptedFiles(directory, 'indices');
  const baselineNames = new Set(baseline.map((file) => file.name));
  const baselineCiphertexts = new Map(
    baseline.map((file) => [
      file.name,
      fs.readFileSync(join(directory, 'vault/indices', file.name)),
    ]),
  );
  const originalMetadata = vault.fileMetadata('originals/fictional-999.txt');
  assert.ok(originalMetadata);
  let hotReads = 0;
  const generationReads = new Map<string, number>();
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).includes('/vault/indices/') && args[1] === 'r') {
      hotReads++;
      const name = String(args[0]).split('/').at(-1)!;
      assert.equal(
        baselineNames.has(name),
        false,
        'hot writes cannot reread committed baseline generations',
      );
      generationReads.set(name, (generationReads.get(name) ?? 0) + 1);
    }
    return originalOpen(...args);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  const samples: Array<{
    updates: number;
    generations: number;
    ciphertextBytes: number;
    objects: number;
    hotReads: number;
  }> = [];
  let latest = Buffer.alloc(0);
  for (let update = 1; update <= 300; update++) {
    latest = Buffer.from(`Fictional changed binding ${String(update).padStart(3, '0')}.`);
    fs.writeFileSync(join(workspace, 'changing.txt'), latest);
    assert.equal(vault.syncWorkspace(workspace), true);
    if (update % 100 === 0) {
      const generations = encryptedFiles(directory, 'indices').filter(
        (file) => !baselineNames.has(file.name),
      );
      assert.ok(generations.every((file) => file.bytes <= 64 * 1024 + 128));
      assert.equal(
        generations.length,
        update,
        'one small changed publication needs one generation',
      );
      samples.push({
        updates: update,
        generations: generations.length,
        ciphertextBytes: generations.reduce((sum, file) => sum + file.bytes, 0),
        objects: encryptedFiles(directory, 'objects').length,
        hotReads,
      });
    }
  }
  assert.equal(hotReads, 300);
  assert.ok([...generationReads.values()].every((count) => count === 1));
  assert.ok(samples[2]!.ciphertextBytes < samples[0]!.ciphertextBytes * 3.1);
  assert.equal(samples[2]!.objects, 1300);
  const beforeNoop = encryptedFiles(directory, 'indices');
  assert.equal(vault.syncWorkspace(workspace), false);
  vault.publish();
  assert.deepEqual(encryptedFiles(directory, 'indices'), beforeNoop);
  const beforeDedup = encryptedFiles(directory, 'objects').length;
  const duplicate = vault.storeFile('duplicate.txt', latest);
  vault.publish();
  assert.equal(vault.metadata().files['changing.txt'], duplicate);
  assert.equal(encryptedFiles(directory, 'objects').length, beforeDedup);
  assert.equal(hotReads, 301);
  assert.ok([...generationReads.values()].every((count) => count === 1));
  fs.openSync = originalOpen;
  syncBuiltinESMExports();
  for (const [name, content] of baselineCiphertexts)
    assert.deepEqual(fs.readFileSync(join(directory, 'vault/indices', name)), content);
  assert.deepEqual(vault.fileMetadata('originals/fictional-999.txt'), originalMetadata);
  assert.equal(
    vault.readFile('originals/fictional-999.txt')?.toString(),
    'Independently fictional original 999.',
  );

  fs.writeFileSync(join(workspace, 'changing.txt'), 'Fictional staged change.');
  assert.equal(vault.syncWorkspace(workspace, { publishNow: false }), true);
  const beforeCommit = open();
  assert.deepEqual(beforeCommit.readFile('changing.txt'), latest);
  assert.equal(beforeCommit.recordStorage().read('head'), null);
  beforeCommit.close();
  const recordStorage = vault.recordStorage();
  const recordName = 'objects/12345678-1234-4234-8234-123456789abc';
  const recordBytes = Buffer.from('Independently fictional accepted authority');
  recordStorage.writeImmutable(recordName, recordBytes);
  const head = Buffer.from('Fictional coherent record head');
  recordStorage.publishHead(head);
  vault.close();
  assert.throws(() => vault.metadata());
  assert.throws(() => recordStorage.read('head'));
  fs.rmSync(workspace, { recursive: true });
  const recovered = open();
  assert.equal(recovered.readFile('changing.txt')?.toString(), 'Fictional staged change.');
  assert.deepEqual(recovered.recordStorage().read('head'), head);
  assert.deepEqual(recovered.recordStorage().read(recordName), recordBytes);
  recovered.materialize(workspace);
  assert.equal(
    fs.readFileSync(join(workspace, 'originals/fictional-999.txt'), 'utf8'),
    'Independently fictional original 999.',
  );
  assert.equal(
    fs.readFileSync(join(workspace, 'changing.txt'), 'utf8'),
    'Fictional staged change.',
  );
  assert.equal(
    createHash('sha256').update(recovered.readFile('originals/fictional-999.txt')!).digest('hex'),
    originalMetadata.sha256,
  );
  t.diagnostic(
    JSON.stringify({
      baselineBindings: 1000,
      baselineGenerations: baseline.length,
      samples,
      scope:
        'Encrypted index publication only; accepted source-authority and diagnostic limits remain separate.',
    }),
  );
});
