import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { availablePasskeyName, passkeyProviderName } from '../passkey-names.ts';
import { createProfilePasskeys } from '../profile-passkeys.ts';
import { createEncryptedProfiles } from '../encrypted-profiles.ts';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';

const onePassword = 'bada5566-a7aa-401f-bd96-45619a55120d';

test('provider lookup handles known, unknown, missing and zero AAGUIDs locally', () => {
  assert.equal(passkeyProviderName(onePassword.toUpperCase()), '1Password');
  for (const value of [
    undefined,
    null,
    '',
    'unknown',
    'constructor',
    '00000000-0000-0000-0000-000000000000',
  ])
    assert.equal(passkeyProviderName(value), 'Passkey');
  assert.equal(availablePasskeyName('1Password', []), '1Password');
  assert.equal(availablePasskeyName('1Password', ['1password', '1Password 2']), '1Password 3');
  assert.equal(availablePasskeyName('1Password', ['1Password', '1Password 3']), '1Password 2');
  assert.equal(availablePasskeyName('Passkey', [undefined, 'passkey 2']), 'Passkey 3');
});

test('confirmed registrations allocate encrypted names against fresh profile state', async (t) => {
  const { manager, dataDirectory, runtimeDirectory } = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(manager);
  const passkeys = createProfilePasskeys(manager, {
    async verifyRegistrationResponse({ response }) {
      return {
        verified: true,
        registrationInfo: {
          aaguid: response.id.startsWith('known') ? onePassword : undefined,
          credential: { id: response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
        },
      };
    },
    async verifyAuthenticationResponse() {
      return { verified: true, authenticationInfo: { newCounter: 1 } };
    },
  });
  async function stage(id: string) {
    const options = await passkeys.registrationOptions(
      profile.id,
      'fictional',
      'http://localhost:3001',
    );
    const confirmation = await passkeys.register(profile.id, 'fictional', {
      challengeId: options.challengeId,
      response: { id },
    });
    return () =>
      passkeys.confirm(profile.id, 'fictional', {
        challengeId: confirmation.challengeId,
        response: { id },
        prf: randomBytes(32).toString('base64url'),
      });
  }
  const first = await stage('known-first');
  const second = await stage('known-second');
  assert.equal(passkeys.list(profile.id).length, 0, 'registration alone publishes no name');
  await Promise.all([first(), second()]);
  assert.deepEqual(
    passkeys.list(profile.id).map((key) => key.label),
    ['1Password', '1Password 2'],
  );
  passkeys.rename(profile.id, { credentialId: 'known-first', label: '1password 3' });
  await (
    await stage('known-third')
  )();
  await (
    await stage('unknown-first')
  )();
  await (
    await stage('unknown-second')
  )();
  const expected = ['1password 3', '1Password 2', '1Password', 'Passkey', 'Passkey 2'];
  assert.deepEqual(
    passkeys.list(profile.id).map((key) => key.label),
    expected,
  );
  const serialized = readFileSync(resolve(manager.pathFor(profile.id), 'keyring.json'), 'utf8');
  assert(!serialized.includes('1Password'));
  assert(!serialized.includes(onePassword));
  assert(!JSON.stringify(manager.list()).includes('1Password'));
  passkeys.remove(profile.id, { credentialId: 'unknown-first' });
  expected.splice(3, 1);
  assert.equal(passkeys.list(profile.id).at(-1)?.label, 'Passkey 2', 'removal never renumbers');
  manager.close();
  const restarted = createEncryptedProfiles({ dataDirectory, runtimeDirectory });
  try {
    await restarted.unlock(profile.id, recoveryKit);
    assert.deepEqual(
      createProfilePasskeys(restarted)
        .list(profile.id)
        .map((key) => key.label),
      expected,
    );
  } finally {
    restarted.close();
  }
});
