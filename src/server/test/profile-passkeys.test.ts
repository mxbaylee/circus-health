import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProfilePasskeys, type PasskeyVerification } from '../profile-passkeys.ts';
import { createEncryptedProfiles } from '../encrypted-profiles.ts';
import { wrapKey } from '../vault-crypto.ts';
import { vaultFixture, newProfile, deferred } from './helpers/vault-fixture.ts';

const origin = 'http://localhost:3001';
const session = 'synthetic-session';
const credential = {
  id: Buffer.from('synthetic-credential').toString('base64url'),
  publicKey: new Uint8Array([1, 2, 3]),
  counter: 0,
  transports: ['internal'],
};
const registration = { verified: true, registrationInfo: { credential } };
type Manager = ReturnType<typeof createEncryptedProfiles>;
type Passkeys = ReturnType<typeof createProfilePasskeys>;
type RegistrationResult = Awaited<ReturnType<PasskeyVerification['verifyRegistrationResponse']>>;
type AuthenticationResult = Awaited<
  ReturnType<PasskeyVerification['verifyAuthenticationResponse']>
>;
type Challenge = { challengeId: unknown };
const authentication = (counter: number): AuthenticationResult => ({
  verified: true,
  authenticationInfo: { newCounter: counter },
});
const verified = {
  async verifyRegistrationResponse() {
    return registration;
  },
  async verifyAuthenticationResponse() {
    return authentication(1);
  },
};
const input = (options: Challenge, prf?: string) => ({
  challengeId: String(options.challengeId),
  response: { id: credential.id },
  ...(prf ? { prf } : {}),
});
const diskRing = (manager: Manager, id: string) =>
  readFileSync(resolve(manager.pathFor(id), 'keyring.json'));
function opened(manager: Manager, id: string) {
  const state = manager.opened.get(id);
  assert.ok(state);
  return state;
}
async function stage(passkeys: Passkeys, id: string, requestOrigin = origin, prf?: string) {
  const options = await passkeys.registrationOptions(id, session, requestOrigin);
  const confirmation = await passkeys.register(id, session, input(options, prf));
  return { options, confirmation };
}
async function enroll(passkeys: Passkeys, id: string, prf: string, requestOrigin = origin) {
  const { confirmation } = await stage(passkeys, id, requestOrigin);
  return passkeys.confirm(id, session, input(confirmation, prf));
}

// Only WebAuthn signature verification is controlled. Challenges, lifecycle,
// PRF wrapping/unwrapping, encrypted files and keyring publication are real.
for (const creationPrf of [false, true]) {
  test(`enrollment always confirms authentication, with creation PRF ${creationPrf ? 'present' : 'absent'}`, async (t) => {
    const { manager } = vaultFixture(t),
      { profile } = await newProfile(manager);
    const head = opened(manager, profile.id).recordStorage.read('head'),
      before = diskRing(manager, profile.id);
    let expectedChallenge: string | undefined,
      assertions = 0;
    const passkeys = createProfilePasskeys(manager, {
      async verifyRegistrationResponse(value) {
        assert.equal(value.expectedOrigin, origin);
        assert.equal(value.expectedRPID, 'localhost');
        assert.equal(value.requireUserVerification, true);
        return registration;
      },
      async verifyAuthenticationResponse(value) {
        assertions++;
        assert.equal(value.expectedOrigin, origin);
        assert.equal(value.expectedRPID, 'localhost');
        assert.equal(value.requireUserVerification, true);
        assert.equal(value.expectedChallenge, expectedChallenge);
        assert.equal(value.credential.id, credential.id);
        assert.deepEqual(value.credential.publicKey, Buffer.from(credential.publicKey));
        assert.equal(value.credential.counter, assertions === 1 ? 0 : 7);
        return authentication(assertions === 1 ? 7 : 9);
      },
    });
    const prf = randomBytes(32).toString('base64url');
    const { options, confirmation } = await stage(
      passkeys,
      profile.id,
      origin,
      creationPrf ? randomBytes(32).toString('base64url') : undefined,
    );
    assert.deepEqual(
      diskRing(manager, profile.id),
      before,
      'verified creation never changes the durable keyring',
    );
    assert.equal(
      confirmation.challengeId,
      options.challengeId,
      'cancellation ID remains usable across the transition',
    );
    assert.notEqual(confirmation.options.challenge, options.options.challenge);
    assert.equal(confirmation.options.rpId, 'localhost');
    assert.equal(confirmation.options.userVerification, 'required');
    assert.deepEqual(confirmation.options.allowCredentials, [
      { id: credential.id, transports: credential.transports, type: 'public-key' },
    ]);
    assert.deepEqual(
      confirmation.options.extensions?.prf?.eval,
      options.options.extensions?.prf?.eval,
    );
    expectedChallenge = confirmation.options.challenge;
    assert.deepEqual(await passkeys.confirm(profile.id, session, input(confirmation, prf)), {
      registered: true,
    });
    assert.equal(manager.keyring(profile.id).passkeys[0]?.counter, 7);
    assert.deepEqual(opened(manager, profile.id).recordStorage.read('head'), head);
    const published = diskRing(manager, profile.id);
    await assert.rejects(passkeys.confirm(profile.id, session, input(confirmation, prf)), {
      code: 'PASSKEY_CHALLENGE',
    });
    assert.deepEqual(diskRing(manager, profile.id), published);
    passkeys.invalidate(profile.id);
    manager.lock(profile.id);
    const unlock = await passkeys.authenticationOptions(profile.id, session, origin);
    assert.deepEqual(
      unlock.options.extensions?.prf?.evalByCredential?.[credential.id],
      options.options.extensions?.prf?.eval,
    );
    expectedChallenge = unlock.options.challenge;
    assert.equal(
      (await passkeys.authenticate(profile.id, session, input(unlock, prf))).locked,
      false,
    );
    assert.equal(manager.keyring(profile.id).passkeys[0]?.counter, 9);
    assert.deepEqual(opened(manager, profile.id).recordStorage.read('head'), head);
  });
}

for (const operation of ['register', 'confirm', 'authenticate'] as const) {
  for (const change of ['lock', 'delete']) {
    test(`${operation} cannot publish or unlock after ${change} during verification`, async (t) => {
      const { manager } = vaultFixture(t),
        { profile } = await newProfile(manager),
        id = profile.id;
      const entered = deferred(),
        completion = deferred<RegistrationResult | AuthenticationResult>();
      let pending = false;
      const passkeys = createProfilePasskeys(manager, {
        async verifyRegistrationResponse() {
          if (pending && operation === 'register') {
            entered.resolve(undefined);
            return completion.promise as Promise<RegistrationResult>;
          }
          return registration;
        },
        async verifyAuthenticationResponse() {
          if (pending) {
            entered.resolve(undefined);
            return completion.promise as Promise<AuthenticationResult>;
          }
          return authentication(1);
        },
      });
      const prf = randomBytes(32).toString('base64url');
      if (operation === 'authenticate') await enroll(passkeys, id, prf);
      const before = diskRing(manager, id);
      const options =
        operation === 'register'
          ? await passkeys.registrationOptions(id, session, origin)
          : operation === 'confirm'
            ? (await stage(passkeys, id)).confirmation
            : await passkeys.authenticationOptions(id, session, origin);
      pending = true;
      const result = passkeys[operation](id, session, input(options, prf));
      await entered.promise;
      const directory = manager.pathFor(id);
      passkeys.invalidate(id);
      if (change === 'lock') manager.lock(id);
      else manager.remove(id, { confirmationName: profile.name, version: profile.version });
      completion.resolve(operation === 'register' ? registration : authentication(7));
      await assert.rejects(result, (error) =>
        ['PASSKEY_CANCELLED', 'PROFILE_NOT_FOUND'].includes(
          (error as Error & { code: string }).code,
        ),
      );
      assert.equal(manager.opened.has(id), false);
      if (change === 'lock') {
        assert.equal(manager.card(id).locked, true);
        assert.deepEqual(
          diskRing(manager, id),
          before,
          'no wrapped key or counter may publish after lock',
        );
      } else
        assert.equal(
          existsSync(directory),
          false,
          'stale verification must not recreate the deleted keyring',
        );
    });
  }
}

for (const operation of ['register', 'confirm', 'authenticate'] as const) {
  test(`cancelling an in-flight ${operation} prevents staged credentials and publication`, async (t) => {
    const { manager } = vaultFixture(t),
      { profile } = await newProfile(manager);
    const entered = deferred(),
      completion = deferred<RegistrationResult | AuthenticationResult>();
    let pending = false;
    const passkeys = createProfilePasskeys(manager, {
      async verifyRegistrationResponse() {
        if (pending && operation === 'register') {
          entered.resolve(undefined);
          return completion.promise as Promise<RegistrationResult>;
        }
        return registration;
      },
      async verifyAuthenticationResponse() {
        if (pending) {
          entered.resolve(undefined);
          return completion.promise as Promise<AuthenticationResult>;
        }
        return authentication(1);
      },
    });
    const prf = randomBytes(32).toString('base64url');
    if (operation === 'authenticate') {
      await enroll(passkeys, profile.id, prf);
      manager.lock(profile.id);
    }
    const options =
      operation === 'register'
        ? await passkeys.registrationOptions(profile.id, session, origin)
        : operation === 'confirm'
          ? (await stage(passkeys, profile.id)).confirmation
          : await passkeys.authenticationOptions(profile.id, session, origin);
    const before = diskRing(manager, profile.id);
    pending = true;
    const result = passkeys[operation](profile.id, session, input(options, prf));
    await entered.promise;
    assert.deepEqual(
      passkeys.cancel(profile.id, session, { challengeId: String(options.challengeId) }),
      { cancelled: true },
    );
    assert.deepEqual(
      passkeys.cancel(profile.id, session, { challengeId: String(options.challengeId) }),
      { cancelled: true },
    );
    completion.resolve(operation === 'register' ? registration : authentication(7));
    await assert.rejects(result, { code: 'PASSKEY_CHALLENGE' });
    await assert.rejects(passkeys[operation](profile.id, session, input(options, prf)), {
      code: 'PASSKEY_CHALLENGE',
    });
    assert.deepEqual(diskRing(manager, profile.id), before);
    if (operation === 'authenticate')
      assert.equal(
        manager.opened.has(profile.id),
        false,
        'cancelled authentication must leave the profile locked',
      );
  });
}

test('cancellation is scoped to one session, profile and challenge for enrollment and unlock', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const passkeys = createProfilePasskeys(manager, verified),
    prf = randomBytes(32).toString('base64url');
  const options = await passkeys.registrationOptions(profile.id, session, origin);
  passkeys.cancel(profile.id, 'other-session', options);
  passkeys.cancel('other-profile', session, options);
  await assert.rejects(passkeys.register(profile.id, 'other-session', input(options)), {
    code: 'PASSKEY_CHALLENGE',
  });
  const confirmation = await passkeys.register(profile.id, session, input(options));
  passkeys.cancel(profile.id, 'other-session', { challengeId: String(confirmation.challengeId) });
  passkeys.cancel('other-profile', session, { challengeId: String(confirmation.challengeId) });
  await assert.rejects(passkeys.confirm(profile.id, 'other-session', input(confirmation, prf)), {
    code: 'PASSKEY_CHALLENGE',
  });
  await passkeys.confirm(profile.id, session, input(confirmation, prf));
  const otherEnrollment = await passkeys.registrationOptions(profile.id, session, origin);
  passkeys.cancel(profile.id, session, otherEnrollment);
  await assert.rejects(passkeys.register(profile.id, session, input(otherEnrollment)), {
    code: 'PASSKEY_CHALLENGE',
  });
  const auth = await passkeys.authenticationOptions(profile.id, session, origin);
  passkeys.cancel(profile.id, 'other-session', auth);
  passkeys.cancel('other-profile', session, auth);
  passkeys.cancel(profile.id, session, otherEnrollment);
  assert.equal((await passkeys.authenticate(profile.id, session, input(auth, prf))).locked, false);
  manager.lock(profile.id);
  const cancelled = await passkeys.authenticationOptions(profile.id, session, origin);
  passkeys.cancel(profile.id, session, cancelled);
  await assert.rejects(passkeys.authenticate(profile.id, session, input(cancelled, prf)), {
    code: 'PASSKEY_CHALLENGE',
  });
  assert.equal(manager.opened.has(profile.id), false);
});

test('confirmation rejects missing/malformed PRF and wrong credential without writing a keyring', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  let assertions = 0;
  const passkeys = createProfilePasskeys(manager, {
    ...verified,
    async verifyAuthenticationResponse() {
      assertions++;
      return authentication(7);
    },
  });
  const before = diskRing(manager, profile.id);
  for (const prf of [undefined, '', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + 'B']) {
    const { confirmation } = await stage(passkeys, profile.id);
    await assert.rejects(passkeys.confirm(profile.id, session, input(confirmation, prf)), {
      code: 'PRF_REQUIRED',
    });
    await assert.rejects(
      passkeys.confirm(
        profile.id,
        session,
        input(confirmation, randomBytes(32).toString('base64url')),
      ),
      { code: 'PASSKEY_CHALLENGE' },
    );
    assert.deepEqual(diskRing(manager, profile.id), before);
  }
  const { confirmation } = await stage(passkeys, profile.id);
  await assert.rejects(
    passkeys.confirm(profile.id, session, {
      ...input(confirmation, randomBytes(32).toString('base64url')),
      response: { id: 'other-credential' },
    }),
    { code: 'PASSKEY_UNKNOWN' },
  );
  assert.equal(assertions, 5, 'a different credential never reaches assertion verification');
  assert.deepEqual(diskRing(manager, profile.id), before);
});

test('unverified registration and confirmation cannot stage or publish a keyring', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const before = diskRing(manager, profile.id);
  let registerVerified = false;
  const passkeys = createProfilePasskeys(manager, {
    async verifyRegistrationResponse() {
      return registerVerified ? registration : { verified: false };
    },
    async verifyAuthenticationResponse() {
      return { verified: false, authenticationInfo: { newCounter: 0 } };
    },
  });
  const options = await passkeys.registrationOptions(profile.id, session, origin);
  await assert.rejects(passkeys.register(profile.id, session, input(options)), {
    code: 'PASSKEY_VERIFICATION',
  });
  await assert.rejects(passkeys.confirm(profile.id, session, input(options)), {
    code: 'PASSKEY_CHALLENGE',
  });
  registerVerified = true;
  const { confirmation } = await stage(passkeys, profile.id);
  await assert.rejects(
    passkeys.confirm(
      profile.id,
      session,
      input(confirmation, randomBytes(32).toString('base64url')),
    ),
    { code: 'PASSKEY_VERIFICATION' },
  );
  assert.deepEqual(diskRing(manager, profile.id), before);
});

test('expired enrollment, including expiry during confirmation, cannot publish', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const before = diskRing(manager, profile.id),
    originalNow = Date.now;
  let elapsed = 0,
    expireDuringVerification = false;
  t.mock.method(Date, 'now', () => originalNow() + elapsed);
  const passkeys = createProfilePasskeys(manager, {
    ...verified,
    async verifyAuthenticationResponse() {
      if (expireDuringVerification) elapsed += 6 * 60 * 1000;
      return authentication(7);
    },
  });
  const options = await passkeys.registrationOptions(profile.id, session, origin);
  elapsed += 6 * 60 * 1000;
  await assert.rejects(passkeys.register(profile.id, session, input(options)), {
    code: 'PASSKEY_CHALLENGE',
  });
  const { confirmation } = await stage(passkeys, profile.id);
  expireDuringVerification = true;
  await assert.rejects(
    passkeys.confirm(
      profile.id,
      session,
      input(confirmation, randomBytes(32).toString('base64url')),
    ),
    { code: 'PASSKEY_CHALLENGE' },
  );
  assert.deepEqual(diskRing(manager, profile.id), before);
});

test('lock and recovery re-unlock invalidates an in-flight confirmation generation', async (t) => {
  const { manager } = vaultFixture(t),
    setup = await newProfile(manager),
    id = setup.profile.id;
  const entered = deferred(),
    completion = deferred<AuthenticationResult>();
  const passkeys = createProfilePasskeys(manager, {
    ...verified,
    async verifyAuthenticationResponse() {
      entered.resolve(undefined);
      return completion.promise;
    },
  });
  const { confirmation } = await stage(passkeys, id),
    before = diskRing(manager, id);
  const pending = passkeys.confirm(
    id,
    session,
    input(confirmation, randomBytes(32).toString('base64url')),
  );
  await entered.promise;
  passkeys.invalidate(id);
  manager.lock(id);
  manager.unlock(id, setup.recoveryKit);
  completion.resolve(authentication(7));
  await assert.rejects(pending, { code: 'PASSKEY_CANCELLED' });
  assert.equal(manager.card(id).locked, false);
  assert.deepEqual(diskRing(manager, id), before);
});

test('parallel confirmations of the same credential publish once with the winning assertion counter', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const completions = [deferred<AuthenticationResult>(), deferred<AuthenticationResult>()],
    bothEntered = deferred();
  let calls = 0;
  const passkeys = createProfilePasskeys(manager, {
    ...verified,
    async verifyAuthenticationResponse() {
      const result = completions[calls++]!.promise;
      if (calls === 2) bothEntered.resolve(undefined);
      return result;
    },
  });
  const staged = await Promise.all([stage(passkeys, profile.id), stage(passkeys, profile.id)]),
    prf = randomBytes(32).toString('base64url');
  const pending = staged.map(({ confirmation }) =>
    passkeys.confirm(profile.id, session, input(confirmation, prf)),
  );
  await bothEntered.promise;
  await assert.rejects(passkeys.confirm(profile.id, session, input(staged[0].confirmation, prf)), {
    code: 'PASSKEY_CHALLENGE',
  });
  completions[1].resolve(authentication(9));
  assert.deepEqual(await pending[1], { registered: true });
  const published = diskRing(manager, profile.id);
  completions[0].resolve(authentication(7));
  await assert.rejects(pending[0], { code: 'PASSKEY_EXISTS' });
  assert.equal(manager.keyring(profile.id).passkeys.length, 1);
  assert.equal(manager.keyring(profile.id).passkeys[0].counter, 9);
  assert.deepEqual(diskRing(manager, profile.id), published);
  const options = await passkeys.registrationOptions(profile.id, session, origin);
  await assert.rejects(passkeys.register(profile.id, session, input(options)), {
    code: 'PASSKEY_EXISTS',
  });
});

test('two pending unlock assertions cannot overwrite a newer published authenticator counter', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const completions = [deferred<AuthenticationResult>(), deferred<AuthenticationResult>()],
    bothEntered = deferred();
  let calls = 0,
    pending = false;
  const passkeys = createProfilePasskeys(manager, {
    ...verified,
    async verifyAuthenticationResponse() {
      if (!pending) return authentication(1);
      const result = completions[calls++]!.promise;
      if (calls === 2) bothEntered.resolve(undefined);
      return result;
    },
  });
  const prf = randomBytes(32).toString('base64url');
  await enroll(passkeys, profile.id, prf);
  manager.lock(profile.id);
  pending = true;
  const options = await Promise.all(
    [0, 1].map(() => passkeys.authenticationOptions(profile.id, session, origin)),
  );
  const requests = options.map((value) =>
    passkeys.authenticate(profile.id, session, input(value, prf)),
  );
  await bothEntered.promise;
  completions[1].resolve(authentication(9));
  assert.equal((await requests[1]).locked, false);
  completions[0].resolve(authentication(7));
  await assert.rejects(requests[0], { code: 'PASSKEY_CHANGED' });
  assert.equal(manager.keyring(profile.id).passkeys[0].counter, 9);
});

test('a verified unlock assertion still needs the matching PRF', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const passkeys = createProfilePasskeys(manager, verified),
    prf = randomBytes(32).toString('base64url');
  await enroll(passkeys, profile.id, prf);
  manager.lock(profile.id);
  const before = diskRing(manager, profile.id),
    wrong = await passkeys.authenticationOptions(profile.id, session, origin);
  await assert.rejects(
    passkeys.authenticate(profile.id, session, input(wrong, randomBytes(32).toString('base64url'))),
    { code: 'PASSKEY_UNWRAP' },
  );
  assert.equal(manager.card(profile.id).locked, true);
  assert.deepEqual(diskRing(manager, profile.id), before);
  const correct = await passkeys.authenticationOptions(profile.id, session, origin);
  assert.equal(
    (await passkeys.authenticate(profile.id, session, input(correct, prf))).locked,
    false,
  );
});

test('passkeys retain hostname RP identity across ports and verify the exact request origin', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const registeredOrigin = 'http://localhost:5180',
    nextOrigin = 'http://localhost:5181';
  let confirmed = false;
  const passkeys = createProfilePasskeys(manager, {
    async verifyRegistrationResponse(value) {
      assert.equal(value.expectedOrigin, registeredOrigin);
      assert.equal(value.expectedRPID, 'localhost');
      assert.equal(value.requireUserVerification, true);
      return registration;
    },
    async verifyAuthenticationResponse(value) {
      assert.equal(value.expectedOrigin, confirmed ? nextOrigin : registeredOrigin);
      assert.equal(value.expectedRPID, 'localhost');
      confirmed = true;
      return authentication(1);
    },
  });
  const prf = randomBytes(32).toString('base64url');
  await enroll(passkeys, profile.id, prf, registeredOrigin);
  assert.equal(manager.keyring(profile.id).passkeys[0].rpID, 'localhost');
  manager.lock(profile.id);
  for (const otherOrigin of ['http://127.0.0.1:5180', 'https://health.example'])
    await assert.rejects(passkeys.authenticationOptions(profile.id, session, otherOrigin), {
      code: 'NO_PASSKEY',
    });
  const auth = await passkeys.authenticationOptions(profile.id, session, nextOrigin);
  assert.equal(auth.options.rpId, 'localhost');
  assert.equal((await passkeys.authenticate(profile.id, session, input(auth, prf))).locked, false);
});

test('IP registration gives hostname guidance without creating or changing a saved passkey', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const passkeys = createProfilePasskeys(manager),
    before = diskRing(manager, profile.id);
  for (const address of ['http://127.0.0.1:5180', 'http://[::1]:5180'])
    await assert.rejects(
      passkeys.registrationOptions(profile.id, session, address),
      (error) =>
        (error as Error & { code: string }).code === 'PASSKEY_DOMAIN' &&
        (error as Error).message.includes('http://localhost:5180'),
    );
  await assert.rejects(
    passkeys.registrationOptions(profile.id, session, 'https://127.0.0.1:5180'),
    (error) =>
      (error as Error & { code: string }).code === 'PASSKEY_DOMAIN' &&
      (error as Error).message.includes('configured HTTPS hostname') &&
      !(error as Error).message.includes('https://localhost'),
  );
  assert.deepEqual(diskRing(manager, profile.id), before);
});

test('an existing saved keyring unlocks without migration and survives adding a new RP credential', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const secret = randomBytes(32),
    oldId = Buffer.from('older-saved-passkey').toString('base64url');
  const ring = manager.keyring(profile.id);
  ring.passkeys.push({
    id: oldId,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: 0,
    transports: ['internal'],
    salt: randomBytes(32).toString('base64url'),
    rpID: 'health.example',
    wrapped: wrapKey(opened(manager, profile.id).key, secret, profile.id, `passkey:${oldId}`),
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  manager.writeKeyring(profile.id, ring);
  manager.lock(profile.id);
  const passkeys = createProfilePasskeys(manager, verified);
  const options = await passkeys.authenticationOptions(
    profile.id,
    session,
    'https://health.example',
  );
  assert.equal(
    (
      await passkeys.authenticate(profile.id, session, {
        challengeId: options.challengeId,
        response: { id: oldId },
        prf: secret.toString('base64url'),
      })
    ).locked,
    false,
  );
  secret.fill(0);
  const existing = manager.keyring(profile.id).passkeys[0];
  await enroll(passkeys, profile.id, randomBytes(32).toString('base64url'));
  assert.deepEqual(manager.keyring(profile.id).passkeys[0], existing);
  assert.equal(manager.keyring(profile.id).passkeys[1].rpID, 'localhost');
});

test('private passkey metadata and individual removal preserve other keys and recovery', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const passkeys = createProfilePasskeys(manager, verified);
  const prf = randomBytes(32).toString('base64url');
  await enroll(passkeys, profile.id, prf);
  const ring = manager.keyring(profile.id),
    first = ring.passkeys[0],
    recovery = ring.recovery;
  // A second saved wrapper stands in for an independently confirmed virtual key.
  // Encrypted labels are bound to their credential ID; this legacy fixture is unnamed.
  ring.passkeys.push({
    ...first,
    encryptedLabel: undefined,
    id: 'fictional-second-key',
    rpID: 'other.example.test',
  });
  manager.writeKeyring(profile.id, ring);
  const head = opened(manager, profile.id).recordStorage.read('head');
  assert.deepEqual(Object.keys(passkeys.list(profile.id)[0]).sort(), [
    'createdAt',
    'id',
    'label',
    'lastUsedAt',
    'rpID',
  ]);
  assert.equal(passkeys.list(profile.id)[0].lastUsedAt, null);
  passkeys.recordUse(profile.id, first.id);
  assert(Number.isFinite(Date.parse(passkeys.list(profile.id)[0]?.lastUsedAt ?? '')));
  assert.equal(passkeys.list(profile.id)[1].lastUsedAt, null);
  passkeys.remove(profile.id, { credentialId: first.id });
  assert.equal(passkeys.list(profile.id).length, 1);
  assert.equal(passkeys.list(profile.id)[0].id, 'fictional-second-key');
  assert.deepEqual(manager.keyring(profile.id).recovery, recovery);
  assert.deepEqual(opened(manager, profile.id).recordStorage.read('head'), head);
  passkeys.recordUse(profile.id, first.id);
  assert.equal(passkeys.list(profile.id).length, 1, 'late usage cannot resurrect removed keys');
  assert.throws(() => passkeys.remove(profile.id, { credentialId: first.id }), {
    code: 'PASSKEY_UNKNOWN',
  });
  passkeys.remove(profile.id, { credentialId: 'fictional-second-key' });
  assert.deepEqual(passkeys.list(profile.id), []);
  assert.deepEqual(manager.keyring(profile.id).recovery, recovery);
  manager.lock(profile.id);
  assert.throws(() => passkeys.list(profile.id), { code: 'PROFILE_LOCKED' });
  assert.throws(() => passkeys.remove(profile.id, { credentialId: first.id }), {
    code: 'PROFILE_LOCKED',
  });
});

test('removed credential cannot complete an in-flight unlock assertion', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const passkeys = createProfilePasskeys(manager, verified),
    prf = randomBytes(32).toString('base64url');
  await enroll(passkeys, profile.id, prf);
  const pending = deferred<AuthenticationResult>();
  const delayed = createProfilePasskeys(manager, {
    ...verified,
    verifyAuthenticationResponse: () => pending.promise,
  });
  const options = await delayed.authenticationOptions(profile.id, session, origin);
  const result = delayed.authenticate(profile.id, session, input(options, prf));
  passkeys.remove(profile.id, { credentialId: credential.id });
  pending.resolve(authentication(2));
  await assert.rejects(result, { code: 'PASSKEY_CHANGED' });
  assert.deepEqual(manager.keyring(profile.id).passkeys, []);
});

test('usage recording cannot fail a completed unlock or overwrite newer enrollment', async (t) => {
  const { manager } = vaultFixture(t),
    { profile } = await newProfile(manager);
  const passkeys = createProfilePasskeys(manager, verified),
    prf = randomBytes(32).toString('base64url');
  await enroll(passkeys, profile.id, prf);
  const originalWrite = manager.writeKeyring;
  manager.writeKeyring = () => {
    throw Error('Fictional usage write failure');
  };
  assert.equal(passkeys.recordUse(profile.id, credential.id), false);
  assert(manager.opened.has(profile.id));
  assert.equal(passkeys.list(profile.id)[0].lastUsedAt, null);
  manager.writeKeyring = originalWrite;
  const originalRead = manager.keyring;
  manager.keyring = () => {
    throw Error('Fictional metadata read failure');
  };
  assert.equal(passkeys.recordUse(profile.id, credential.id), false);
  manager.keyring = originalRead;
  const ring = manager.keyring(profile.id);
  ring.passkeys.push({
    ...ring.passkeys[0],
    encryptedLabel: undefined,
    id: 'fictional-concurrent-enrollment',
  });
  manager.writeKeyring(profile.id, ring);
  assert.equal(passkeys.recordUse(profile.id, credential.id), true);
  assert.equal(passkeys.list(profile.id).length, 2);
  manager.lock(profile.id);
  assert.equal(passkeys.recordUse(profile.id, credential.id), false);
});
