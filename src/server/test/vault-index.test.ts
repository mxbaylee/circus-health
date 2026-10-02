import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, cpSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { freshKey, encryptObject, decryptObject } from '../vault-crypto.ts';
import { openVault } from '../vault-store.ts';
import { vaultIndexLimits } from '../vault-index.ts';
interface Ref {
  id: string;
  sequence: number;
  bytes: number;
  sha256: string;
}
interface Head {
  format: string;
  profileId: string;
  revision: number;
  indexTip: Ref;
  usage: { bytes: number; entries: number; generations: number };
  recordsHead: string | null;
}
interface Generation {
  format: string;
  profileId: string;
  id: string;
  sequence: number;
  previous: Ref | null;
  objects: [unknown, unknown][];
  files: [unknown, unknown][];
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(resolve(tmpdir(), 'circus-index-fictional-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = freshKey(),
    profileId = 'fictional-profile';
  const open = (initialize = false) => openVault({ directory, key, profileId, initialize });
  const vault = open(true);
  vault.storeFile('original.txt', Buffer.from('Fictional original'));
  vault.recordStorage().publishHead(Buffer.from('fictional-old-head'));
  const headPath = resolve(directory, 'vault/manifest.enc');
  const head = (): Head =>
    JSON.parse(decryptObject(headPath, key, profileId, 'manifest').toString());
  const genPath = (id: string) => resolve(directory, 'vault/indices', id + '.enc');
  const generation = (): Generation => {
    const h = head();
    return JSON.parse(
      decryptObject(genPath(h.indexTip.id), key, profileId, `index:${h.indexTip.id}`).toString(),
    );
  };
  function alter(mutator: (g: Generation, h: Head) => void) {
    const h = head(),
      g = generation();
    mutator(g, h);
    const bytes = Buffer.from(JSON.stringify(g));
    const oldBytes = h.indexTip.bytes;
    h.indexTip.bytes = bytes.length;
    h.indexTip.sha256 = createHash('sha256').update(bytes).digest('hex');
    h.usage.bytes += bytes.length - oldBytes;
    encryptObject(genPath(h.indexTip.id), bytes, key, profileId, `index:${h.indexTip.id}`);
    encryptObject(headPath, Buffer.from(JSON.stringify(h)), key, profileId, 'manifest');
  }
  return { directory, key, profileId, open, vault, headPath, head, genPath, generation, alter };
}

test('encrypted index rejects unsupported heads, corrupt links, counters and unsafe/coerced entries', (t) => {
  for (const fault of [
    'old',
    'profile',
    'sequence',
    'previous',
    'counter',
    'dangling',
    'duplicate-object',
    'duplicate-file',
    'coerced-id',
    'coerced-hash',
    'proto',
    'revision',
    'oversized',
  ] as const) {
    const f = fixture(t);
    f.vault.close();
    f.alter((g, h) => {
      if (fault === 'old') h.format = 'circus-health-vault-head-v1';
      if (fault === 'profile') g.profileId = 'other-profile';
      if (fault === 'sequence') g.sequence++;
      if (fault === 'previous') g.previous!.sequence++;
      if (fault === 'counter') h.usage.entries++;
      if (fault === 'dangling') g.files[0][1] = '11111111-1111-4111-8111-111111111111';
      if (fault === 'duplicate-object') {
        g.objects.push(g.objects[0]);
        h.usage.entries++;
      }
      if (fault === 'duplicate-file') {
        g.files.push(g.files[0]);
        h.usage.entries++;
      }
      if (fault === 'coerced-id') g.objects[0][0] = [g.objects[0][0]];
      if (fault === 'coerced-hash')
        (g.objects[0][1] as { sha256: unknown }).sha256 = [
          (g.objects[0][1] as { sha256: string }).sha256,
        ];
      if (fault === 'proto') g.files[0][0] = '__proto__';
      if (fault === 'revision') h.revision = 1.5;
      if (fault === 'oversized') g.files[0][0] = 'x'.repeat(vaultIndexLimits.generationBytes);
    });
    assert.throws(() => f.open(), /vault index/);
  }
});

test('missing, truncated, wrong-key and linked generations/content are unavailable', (t) => {
  for (const fault of [
    'missing-generation',
    'truncated',
    'wrong-key',
    'missing-content',
    'linked',
  ] as const) {
    const f = fixture(t),
      h = f.head(),
      path = f.genPath(h.indexTip.id);
    f.vault.close();
    if (fault === 'missing-generation') rmSync(path);
    if (fault === 'truncated') writeFileSync(path, readFileSync(path).subarray(0, 31));
    if (fault === 'wrong-key') {
      assert.throws(() =>
        openVault({ directory: f.directory, key: freshKey(), profileId: f.profileId }),
      );
      continue;
    }
    if (fault === 'missing-content')
      rmSync(
        resolve(
          f.directory,
          'vault/objects',
          readdirSync(resolve(f.directory, 'vault/objects'))[0],
        ),
      );
    if (fault === 'linked') fs.linkSync(path, path + '.extra');
    assert.throws(() => f.open());
  }
});

test('staging and ambiguous head failures retain only the actual committed index and clear the writer', (t) => {
  for (const fault of [
    'object',
    'generation',
    'head-before',
    'head-after',
    'damaged-generation',
  ] as const) {
    const f = fixture(t),
      old = readFileSync(f.headPath);
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      const target = String(to);
      if (
        (fault === 'object' && target.includes('/vault/objects/')) ||
        (fault === 'generation' && target.includes('/vault/indices/')) ||
        (fault === 'head-before' && target === f.headPath)
      )
        throw Error('Fictional publication fault');
      rename(from, to);
      if (fault === 'damaged-generation' && target.includes('/vault/indices/'))
        writeFileSync(target, Buffer.from('damaged'));
      if (fault === 'head-after' && target === f.headPath)
        throw Error('Fictional ambiguous publication');
    });
    syncBuiltinESMExports();
    try {
      if (fault === 'object')
        assert.throws(
          () => f.vault.storeFile('new.txt', Buffer.from('Fictional new')),
          /Fictional/,
        );
      else {
        f.vault.storeFile('new.txt', Buffer.from('Fictional new'));
        assert.throws(() => f.vault.recordStorage().publishHead(Buffer.from('fictional-new-head')));
        assert.throws(() => f.vault.metadata(), /locked/);
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      f.vault.close();
    }
    const opened = f.open();
    assert.equal(opened.readFile('original.txt')?.toString(), 'Fictional original');
    if (fault === 'head-after') {
      assert.equal(opened.readFile('new.txt')?.toString(), 'Fictional new');
      assert.equal(opened.recordStorage().read('head')?.toString(), 'fictional-new-head');
    } else {
      assert.deepEqual(readFileSync(f.headPath), old);
      assert.equal(opened.readFile('new.txt'), null);
      assert.equal(opened.recordStorage().read('head')?.toString(), 'fictional-old-head');
    }
    opened.storeFile('retry.txt', Buffer.from('Fictional retry'));
    opened.publish();
    opened.close();
    const retried = f.open();
    assert.equal(retried.readFile('retry.txt')?.toString(), 'Fictional retry');
    retried.close();
  }
});

test('a captured encrypted manifest selects its exact chain and record head amid later backup content', (t) => {
  const f = fixture(t),
    captured = readFileSync(f.headPath),
    expected = f.vault.metadata();
  f.vault.storeFile('new.txt', Buffer.from('Fictional new'));
  f.vault.recordStorage().publishHead(Buffer.from('fictional-new-head'));
  const backup = mkdtempSync(resolve(tmpdir(), 'circus-index-backup-'));
  t.after(() => rmSync(backup, { recursive: true, force: true }));
  cpSync(f.directory, backup, { recursive: true });
  writeFileSync(resolve(backup, 'vault/manifest.enc'), captured);
  const restored = openVault({ directory: backup, key: f.key, profileId: f.profileId });
  assert.deepEqual(restored.metadata(), expected);
  assert.equal(restored.readFile('new.txt'), null);
  assert.equal(restored.readFile('original.txt')?.toString(), 'Fictional original');
  assert.equal(restored.recordStorage().read('head')?.toString(), 'fictional-old-head');
  restored.close();
  f.vault.close();
});

test('hot writer enforces cumulative cold budgets before publishing an unreadable generation', (t) => {
  for (const kind of ['generations', 'entries', 'bytes'] as const) {
    const directory = mkdtempSync(resolve(tmpdir(), 'circus-index-budget-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const key = freshKey(),
      profileId = 'fictional-budget';
    const indexLimits =
      kind === 'generations'
        ? { generations: 4 }
        : kind === 'entries'
          ? { entries: 6 }
          : { generationBytes: 1024, totalBytes: 1600 };
    const open = (initialize = false) =>
      openVault({ directory, key, profileId, initialize, indexLimits });
    const vault = open(true),
      path = resolve(directory, 'vault/manifest.enc');
    let accepted = 0,
      previous = readFileSync(path),
      generations = readdirSync(resolve(directory, 'vault/indices')).length;
    for (let attempt = 1; attempt < 20; attempt++) {
      vault.storeFile('changing.txt', Buffer.from('Fictional bounded value ' + attempt));
      try {
        vault.publish();
        accepted++;
        previous = readFileSync(path);
        generations = readdirSync(resolve(directory, 'vault/indices')).length;
      } catch {
        break;
      }
    }
    assert.ok(accepted > 0 && accepted < 19);
    assert.throws(() => vault.metadata(), /locked/);
    assert.deepEqual(readFileSync(path), previous);
    assert.equal(
      readdirSync(resolve(directory, 'vault/indices')).length,
      generations,
      'budget rejects before generation staging',
    );
    const restored = open();
    assert.equal(
      restored.readFile('changing.txt')?.toString(),
      'Fictional bounded value ' + accepted,
    );
    restored.close();
    for (const invalid of [
      { entries: 0 },
      { generations: 1.5 },
      { totalBytes: Number.NaN },
      { generationBytes: 511 },
      { headBytes: 1023 },
      { entries: vaultIndexLimits.entries + 1 },
    ])
      assert.throws(
        () => openVault({ directory, key, profileId, indexLimits: invalid }),
        /vault index/,
      );
  }
});

test('authenticated invalid UTF-8 cannot fabricate a decoded file binding', (t) => {
  const f = fixture(t),
    head = f.head(),
    path = f.genPath(head.indexTip.id);
  f.vault.close();
  const bytes = decryptObject(path, f.key, f.profileId, `index:${head.indexTip.id}`);
  const position = bytes.indexOf(Buffer.from('original.txt'));
  assert.ok(position >= 0);
  bytes[position] = 0xff;
  head.indexTip.sha256 = createHash('sha256').update(bytes).digest('hex');
  encryptObject(path, bytes, f.key, f.profileId, `index:${head.indexTip.id}`);
  encryptObject(f.headPath, Buffer.from(JSON.stringify(head)), f.key, f.profileId, 'manifest');
  assert.throws(() => f.open(), /vault index/);
});

test('missing manifest with retained evidence refuses initialization without adopting or deleting it', (t) => {
  const f = fixture(t);
  f.vault
    .recordStorage()
    .writeImmutable(
      'objects/12345678-1234-4234-8234-123456789abc',
      Buffer.from('Fictional accepted record'),
    );
  f.vault.close();
  rmSync(f.headPath);
  const retained = new Map<string, Buffer>();
  for (const part of ['indices', 'objects', 'versions'])
    for (const name of readdirSync(resolve(f.directory, 'vault', part))) {
      const path = resolve(f.directory, 'vault', part, name);
      retained.set(path, readFileSync(path));
    }
  assert.throws(() => f.open(true), /Missing authoritative vault manifest with retained evidence/);
  assert.throws(() => f.open(), /Missing authoritative vault manifest/);
  assert.equal(fs.existsSync(f.headPath), false);
  for (const [path, bytes] of retained) assert.deepEqual(readFileSync(path), bytes);
});
