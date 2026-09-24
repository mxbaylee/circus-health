import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProfilePasskeys } from '../profile-passkeys.ts';
import { createEncryptedProfiles } from '../encrypted-profiles.ts';
import { wrapKey } from '../vault-crypto.ts';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';

type Manager = ReturnType<typeof createEncryptedProfiles>;
function opened(manager: Manager, id: string) {
  const state = manager.opened.get(id);
  assert.ok(state);
  return state;
}
function addKey(manager: Manager, id: string, credentialId = 'fictional-credential') {
  const ring = manager.keyring(id);
  ring.passkeys.push({
    id: credentialId,
    rpID: 'localhost',
    publicKey: 'fictional-public-key',
    counter: 7,
    transports: ['internal'],
    salt: randomBytes(32).toString('base64url'),
    wrapped: wrapKey(opened(manager, id).key, randomBytes(32), id, `passkey:${credentialId}`),
    createdAt: '2026-09-12T00:00:00.000Z',
    lastUsedAt: '2026-09-12T01:00:00.000Z',
  });
  manager.writeKeyring(id, ring);
  return credentialId;
}
test('private labels encrypt at rest, survive restart, and preserve all unlock and clinical state', async (t) => {
  const { manager, dataDirectory, runtimeDirectory } = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(manager);
  const credentialId = addKey(manager, profile.id),
    passkeys = createProfilePasskeys(manager);
  addKey(manager, profile.id, 'fictional-other-key');
  const before = manager.keyring(profile.id),
    head = opened(manager, profile.id).recordStorage.read('head');
  assert.equal(
    passkeys.list(profile.id)[0].label,
    undefined,
    'legacy unnamed key needs no migration',
  );
  assert.deepEqual(passkeys.rename(profile.id, { credentialId, label: '  1Password  ' }), {
    renamed: true,
    label: '1Password',
  });
  assert.equal(passkeys.list(profile.id)[0].label, '1Password');
  const after = manager.keyring(profile.id),
    { encryptedLabel, ...key } = after.passkeys[0];
  assert.ok(encryptedLabel);
  assert.equal(encryptedLabel.algorithm, 'xchacha20poly1305-ietf');
  assert.deepEqual(key, before.passkeys[0]);
  assert.deepEqual({ ...after, passkeys: before.passkeys }, before);
  assert.deepEqual(after.passkeys[1], before.passkeys[1]);
  assert.deepEqual(opened(manager, profile.id).recordStorage.read('head'), head);
  assert(
    !readFileSync(resolve(manager.pathFor(profile.id), 'keyring.json'), 'utf8').includes(
      '1Password',
    ),
  );
  assert(!JSON.stringify(manager.list()).includes('1Password'));
  manager.close();
  const restarted = createEncryptedProfiles({ dataDirectory, runtimeDirectory });
  try {
    await restarted.unlock(profile.id, recoveryKit);
    assert.equal(createProfilePasskeys(restarted).list(profile.id)[0].label, '1Password');
    assert.deepEqual(restarted.keyring(profile.id).recovery, before.recovery);
  } finally {
    restarted.close();
  }
});
test('label validation rejects empty, controls, wrong types and oversized names without writing', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const credentialId = addKey(manager, profile.id),
    passkeys = createProfilePasskeys(manager),
    before = manager.keyring(profile.id);
  for (const label of [
    '',
    '   ',
    'a'.repeat(81),
    'Hardware\nkey',
    '\u0000name',
    'a\u0085b',
    null,
    5,
    {},
  ])
    assert.throws(() => passkeys.rename(profile.id, { credentialId, label }), {
      code: 'PASSKEY_LABEL',
    });
  assert.throws(() => passkeys.rename(profile.id, { label: 'Hardware key' }), {
    code: 'PASSKEY_ID',
  });
  assert.deepEqual(manager.keyring(profile.id), before);
  passkeys.rename(profile.id, { credentialId, label: '鍵 🔑 Hardware key' });
  assert.equal(passkeys.list(profile.id)[0].label, '鍵 🔑 Hardware key');
  passkeys.rename(profile.id, { credentialId, label: 'a'.repeat(80) });
  assert.equal(passkeys.list(profile.id)[0]?.label?.length, 80);
});
test('labels cannot be moved between credentials or profiles, and corruption does not change unlock metadata', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const credentialId = addKey(manager, profile.id),
    passkeys = createProfilePasskeys(manager);
  passkeys.rename(profile.id, { credentialId, label: 'Hardware key' });
  const ring = manager.keyring(profile.id),
    ciphertext = ring.passkeys[0].encryptedLabel;
  ring.passkeys[0].id = 'different-credential';
  manager.writeKeyring(profile.id, ring);
  assert.throws(() => passkeys.list(profile.id), { code: 'PASSKEY_LABEL_UNAVAILABLE' });
  const { profile: other } = await newProfile(manager);
  addKey(manager, other.id, credentialId);
  const otherRing = manager.keyring(other.id);
  otherRing.passkeys[0]!.encryptedLabel = ciphertext;
  manager.writeKeyring(other.id, otherRing);
  assert.throws(() => passkeys.list(other.id), { code: 'PASSKEY_LABEL_UNAVAILABLE' });
});
test('rename reads current metadata, cannot resurrect removed credentials, and requires unlock', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const credentialId = addKey(manager, profile.id),
    passkeys = createProfilePasskeys(manager);
  passkeys.recordUse(profile.id, credentialId);
  const used = manager.keyring(profile.id).passkeys[0].lastUsedAt;
  addKey(manager, profile.id, 'newer-key');
  passkeys.rename(profile.id, { credentialId, label: '1Password' });
  assert.equal(passkeys.list(profile.id)[0].lastUsedAt, used);
  assert.equal(passkeys.list(profile.id).length, 2);
  passkeys.remove(profile.id, { credentialId });
  assert.throws(() => passkeys.rename(profile.id, { credentialId, label: 'Late rename' }), {
    code: 'PASSKEY_UNKNOWN',
  });
  assert.deepEqual(
    passkeys.list(profile.id).map((key) => key.id),
    ['newer-key'],
  );
  manager.lock(profile.id);
  assert.throws(
    () => passkeys.rename(profile.id, { credentialId: 'newer-key', label: 'Locked rename' }),
    { code: 'PROFILE_LOCKED' },
  );
});
