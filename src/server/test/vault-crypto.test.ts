import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers-sumo';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
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
