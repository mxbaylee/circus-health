import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers-sumo';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setImmediate as yieldHost } from 'node:timers/promises';
import {
  freshKey,
  recoveryPhrase,
  recoveryEntropy,
  wrapKey,
  unwrapKey,
  encryptObject,
  decryptObject,
} from '../vault-crypto.ts';
import { openVault } from '../vault-store.ts';
import { captureManagedPhysicalEpoch } from '../clinical-review-physical-epoch.ts';
import { openDiagnosticChunkStore } from '../diagnostic-chunk-store.ts';
function dir(t: TestContext) {
  const p = mkdtempSync(resolve(tmpdir(), 'circus-vault-test-'));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  return p;
}
test('256-bit standard mnemonic vector and profile-bound key recovery', () => {
  const zero = Buffer.alloc(32),
    phrase = recoveryPhrase(zero);
  assert.equal(phrase, Array(23).fill('abandon').join(' ') + ' art');
  assert.deepEqual(recoveryEntropy(phrase, 'p-one'), zero);
  const key = freshKey(),
    secret = freshKey(),
    wrapped = wrapKey(key, secret, 'p-one');
  assert.deepEqual(unwrapKey(wrapped, secret, 'p-one'), key);
  assert.throws(() => unwrapKey(wrapped, secret, 'p-two'));
  assert.throws(() => unwrapKey(wrapped, freshKey(), 'p-one'));
  assert.throws(() =>
    recoveryEntropy({ format: 'circus-health-recovery-v1', profileId: 'p-two', phrase }, 'p-one'),
  );
  assert.throws(() => recoveryEntropy(Array(24).fill('abandon').join(' '), 'p-one'));
});
test('encrypted streams authenticate multiple frames, owner, purpose and completeness', (t) => {
  const root = dir(t),
    path = resolve(root, 'file.enc'),
    out = resolve(root, 'decoded'),
    key = freshKey(),
    bytes = Buffer.alloc(2 * 1024 * 1024 + 19, 37);
  encryptObject(path, bytes, key, 'p-one', 'source');
  assert.deepEqual(decryptObject(path, key, 'p-one', 'source'), bytes);
  decryptObject(path, key, 'p-one', 'source', out);
  assert.deepEqual(readFileSync(out), bytes);
  const ciphertext = readFileSync(path);
  assert.throws(() => decryptObject(path, key, 'p-two', 'source'));
  assert.throws(() => decryptObject(path, key, 'p-one', 'other'));
  writeFileSync(path, ciphertext.subarray(0, ciphertext.length - 1));
  assert.throws(() => decryptObject(path, key, 'p-one', 'source', resolve(root, 'bad')));
  writeFileSync(path, Buffer.concat([ciphertext, Buffer.from([1])]));
  assert.throws(() => decryptObject(path, key, 'p-one', 'source'));
  ciphertext[100] ^= 1;
  writeFileSync(path, ciphertext);
  assert.throws(() => decryptObject(path, key, 'p-one', 'source'));
});

test('background diagnostics preserve evidence witnesses without exempting authority writes', async (t) => {
  const root = dir(t),
    key = freshKey(),
    vault = openVault({ directory: root, profileId: 'p-fictional', key, initialize: true });
  t.after(() => vault.close());
  const expected = captureManagedPhysicalEpoch();
  assert.ok(expected);
  const summary = Buffer.from('{"fictional":"summary"}');
  await yieldHost();
  vault.writePerformanceSummary(summary);
  assert.equal(captureManagedPhysicalEpoch(), expected);
  assert.deepEqual(vault.readPerformanceSummary(), summary);
  const chunks = vault.diagnosticChunks();
  assert.equal(chunks.append(1, summary), 'appended');
  assert.deepEqual(chunks.read(1), summary);
  assert.equal(captureManagedPhysicalEpoch(), expected);
  const standalone = openDiagnosticChunkStore({
    directory: resolve(root, 'standalone'),
    key,
    profileId: 'p-fictional',
  });
  standalone.append(1, summary);
  assert.notEqual(captureManagedPhysicalEpoch(), expected);
  standalone.close();
  const beforeAuthority = captureManagedPhysicalEpoch();
  encryptObject(resolve(root, 'authority.enc'), summary, key, 'p-fictional', 'source');
  assert.notEqual(captureManagedPhysicalEpoch(), beforeAuthority);
});

for (const replacement of ['symlink', 'directory', 'ancestor', 'ciphertext'] as const)
  test(`warm diagnostic writers refuse ${replacement} redirection`, (t) => {
    const parent = dir(t),
      root = resolve(parent, 'profile'),
      key = freshKey();
    const vault = openVault({ directory: root, profileId: 'p-fictional', key, initialize: true });
    t.after(() => vault.close());
    const summary = Buffer.from('fictional diagnostic');
    vault.writePerformanceSummary(summary);
    const chunks = vault.diagnosticChunks();
    chunks.append(1, summary);
    const outside = resolve(parent, 'unrelated');
    mkdirSync(outside);
    const sentinel = resolve(outside, 'recent-performance.enc');
    writeFileSync(sentinel, 'retained original');
    if (replacement === 'ancestor') {
      renameSync(root, resolve(parent, 'original-profile'));
      mkdirSync(root);
      mkdirSync(resolve(root, 'diagnostics'));
      mkdirSync(resolve(root, 'diagnostics/events'));
    } else if (replacement === 'ciphertext') {
      rmSync(resolve(root, 'diagnostics/recent-performance.enc'));
      symlinkSync(sentinel, resolve(root, 'diagnostics/recent-performance.enc'));
    } else {
      renameSync(resolve(root, 'diagnostics'), resolve(root, 'original-diagnostics'));
      if (replacement === 'symlink') symlinkSync(outside, resolve(root, 'diagnostics'));
      else {
        mkdirSync(resolve(root, 'diagnostics'));
        mkdirSync(resolve(root, 'diagnostics/events'));
      }
    }
    assert.throws(() => vault.writePerformanceSummary(Buffer.from('replacement')));
    if (replacement !== 'ciphertext') assert.throws(() => chunks.append(2, summary));
    assert.equal(readFileSync(sentinel, 'utf8'), 'retained original');
  });

test('a caller cannot counterfeit a vault diagnostic writer', (t) => {
  assert.throws(
    () =>
      openDiagnosticChunkStore({
        directory: dir(t),
        profileId: 'p-fictional',
        key: freshKey(),
        writer() {},
      }),
    /Invalid vault diagnostic writer/,
  );
});
test('vault stores identical originals once with separate references and hides names', (t) => {
  const root = dir(t),
    key = freshKey(),
    workspace = resolve(root, 'runtime'),
    directory = resolve(root, 'durable');
  mkdirSync(workspace);
  writeFileSync(resolve(workspace, 'private-name.pdf'), 'private evidence');
  writeFileSync(resolve(workspace, 'second-name.pdf'), 'private evidence');
  const vault = openVault({ directory, profileId: 'p-one', key, initialize: true });
  vault.syncWorkspace(workspace);
  const meta = vault.metadata();
  assert.equal(Object.keys(meta.objects).length, 1);
  assert.equal(meta.files['private-name.pdf'], meta.files['second-name.pdf']);
  assert(
    !readFileSync(resolve(directory, 'vault/manifest.enc')).includes(Buffer.from('private-name')),
  );
  const store = vault.recordStorage();
  store.writeImmutable('objects/12345678-1234-4234-8234-123456789abc', Buffer.from('record'));
  store.publishHead(Buffer.from('head'));
  vault.close();
  assert.throws(() => store.read('head'));
  const again = openVault({ directory, profileId: 'p-one', key });
  assert.equal(again.recordStorage().read('head')?.toString(), 'head');
  const restored = resolve(root, 'restore');
  again.materialize(restored);
  assert.equal(readFileSync(resolve(restored, 'private-name.pdf'), 'utf8'), 'private evidence');
  assert.throws(() => again.storeFile('../escape', Buffer.from('x')));
});

test('an authenticated unsupported stream tag refuses with scope and recovery action', (t) => {
  const path = resolve(dir(t), 'future-tag.enc');
  const key = freshKey();
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const frame = sodium.crypto_secretstream_xchacha20poly1305_push(
    state,
    Buffer.from('Independently fictional future stream'),
    Buffer.from(JSON.stringify(['circus-health-vault-v1', 'p-fictional', 'source'])),
    sodium.crypto_secretstream_xchacha20poly1305_TAG_PUSH,
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(frame.length);
  const bytes = Buffer.concat([
    Buffer.from('CIRCUS01'),
    Buffer.from(header),
    length,
    Buffer.from(frame),
  ]);
  writeFileSync(path, bytes, { mode: 0o600 });
  assert.throws(() => decryptObject(path, key, 'p-fictional', 'source'), {
    code: 'ARCHIVE_UNSUPPORTED',
    status: 409,
    message: /Profile encrypted frame tag.*Preserve this archive and use a compatible app release/,
  });
  assert.deepEqual(readFileSync(path), bytes);
  key.fill(0);
});
