import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request } from 'node:http';
import { createVaultApp } from '../vault-app.ts';
import { createProfilePasskeys } from '../profile-passkeys.ts';
import { newProfile } from './helpers/vault-fixture.ts';

interface ApiResult<T = unknown> {
  status: number;
  data?: T;
  error?: { code: string };
}
interface PublicCard {
  id: string;
  locked: boolean;
  hasPasskey: boolean;
}

test('HTTP confirmation requires profile access and cancellation remains idempotent after lock', async (t) => {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-passkey-http-'));
  mkdirSync(resolve(base, 'data'));
  const app = createVaultApp({
    dataDirectory: resolve(base, 'data'),
    runtimeDirectory: resolve(base, 'runtime'),
    assistantOptions: { availability: async () => ({ available: false }) },
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(() => {
    try {
      app.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  const address = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`,
    origin = 'http://localhost:5173';
  let cookie = '';
  async function post<T = unknown>(
    path: string,
    input: unknown = {},
    owned = true,
    requestOrigin = origin,
  ): Promise<ApiResult<T>> {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: {
        Origin: requestOrigin,
        'Content-Type': 'application/json',
        ...(owned ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(input),
    });
    if (owned && response.headers.get('set-cookie'))
      cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { status: response.status, ...((await response.json()) as object) } as ApiResult<T>;
  }
  const setup = (
    await post('/api/profile-setups', {
      fullName: 'Synthetic passkey test',
      birthDate: '1982-04-17',
      name: 'Synthetic passkey test',
      placebo: false,
    })
  ).data as { setupId: string; recoveryKit: unknown };
  const profile = (
    await post(`/api/profile-setups/${setup.setupId}/verify`, {
      recovery: setup.recoveryKit,
      acknowledged: true,
    })
  ).data as { id: string };
  const path = `/api/profiles/${profile.id}`,
    before = readFileSync(resolve(app.manager.pathFor(profile.id), 'keyring.json'));
  assert.equal(
    (await fetch(url + path + '/passkeys')).status,
    423,
    'another session cannot read private key metadata',
  );
  const listed = await fetch(url + path + '/passkeys', { headers: { Cookie: cookie } });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).data, []);
  assert.equal(
    (await post(`${path}/passkeys/remove`, { credentialId: 'fictional-key' }, false)).status,
    423,
  );
  const options = (await post<{ challengeId: string }>(`${path}/passkeys/options`)).data!;
  assert.equal(
    (await post(`${path}/passkeys/confirm`, { challengeId: options.challengeId }, false)).status,
    423,
  );
  assert.equal(
    (
      await post(
        `${path}/passkeys/cancel`,
        { challengeId: options.challengeId },
        true,
        'https://other.example',
      )
    ).status,
    403,
  );
  assert.equal(
    (await post(`${path}/passkeys/cancel`, { challengeId: options.challengeId }, false)).status,
    200,
  );
  // A foreign session cannot cancel; the registration challenge is still present
  // and cannot be submitted to the confirmation route before verification.
  assert.equal(
    (await post(`${path}/passkeys/confirm`, { challengeId: options.challengeId })).error?.code,
    'PASSKEY_CHALLENGE',
  );
  assert.deepEqual(
    (await post(`${path}/passkeys/cancel`, { challengeId: options.challengeId })).data,
    { cancelled: true },
  );
  assert.equal(
    (await post(`${path}/passkeys/verify`, { challengeId: options.challengeId, response: {} }))
      .error?.code,
    'PASSKEY_CHALLENGE',
  );
  assert.equal((await post(`${path}/lock`)).status, 200);
  assert.deepEqual(
    (await post(`${path}/passkeys/cancel`, { challengeId: options.challengeId })).data,
    { cancelled: true },
  );
  assert.equal(
    (await post(`${path}/passkeys/confirm`, { challengeId: options.challengeId })).status,
    423,
  );
  assert.deepEqual(readFileSync(resolve(app.manager.pathFor(profile.id), 'keyring.json')), before);
});

test('locked public cards expose only confirmed, profile-specific passkey availability for the request hostname', async (t) => {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-passkey-availability-'));
  mkdirSync(resolve(base, 'data'));
  const app = createVaultApp({
    dataDirectory: resolve(base, 'data'),
    runtimeDirectory: resolve(base, 'runtime'),
    allowedOrigins: ['http://localhost:5180', 'https://health.example'],
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(() => {
    try {
      app.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  const address = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const { profile } = await newProfile(app.manager, 'Fictional enrolled Robin');
  const { profile: other } = await newProfile(app.manager, 'Fictional recovery Wren');
  const credential = {
    id: Buffer.from('fictional-card-credential').toString('base64url'),
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
  };
  // Control signatures only; confirmation and durable wrapping are real. The
  // browser journey separately covers real WebAuthn signatures in Docker.
  const passkeys = createProfilePasskeys(app.manager, {
    async verifyRegistrationResponse() {
      return { verified: true, registrationInfo: { credential } };
    },
    async verifyAuthenticationResponse() {
      return { verified: true, authenticationInfo: { newCounter: 1 } };
    },
  });
  async function cards(headers: Record<string, string> = {}): Promise<PublicCard[]> {
    // Use HTTP directly because fetch may replace an explicitly supplied Host.
    return new Promise<PublicCard[]>((resolveCards, reject) => {
      request(url + '/api/profiles', { headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          try {
            assert.equal(response.statusCode, 200);
            assert.equal(response.headers['cache-control'], 'no-store');
            resolveCards(
              (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data: PublicCard[] }).data,
            );
          } catch (error) {
            reject(error);
          }
        });
      })
        .on('error', reject)
        .end();
    });
  }
  const initial = await cards({ Host: 'localhost:5180' });
  assert(
    initial.every((card) => card.locked && card.hasPasskey === false),
    'another session cannot see an unlocked card',
  );
  const options = await passkeys.registrationOptions(
    profile.id,
    'fictional-session',
    'http://localhost:5180',
  );
  const confirm = await passkeys.register(profile.id, 'fictional-session', {
    challengeId: options.challengeId,
    response: { id: credential.id },
  });
  assert(
    (await cards({ Host: 'localhost:5180' })).every((card) => card.hasPasskey === false),
    'staged enrollment is not a usable passkey',
  );
  await passkeys.confirm(profile.id, 'fictional-session', {
    challengeId: confirm.challengeId,
    response: { id: credential.id },
    prf: Buffer.alloc(32, 27).toString('base64url'),
  });
  app.manager.lock(profile.id);
  app.manager.lock(other.id);
  const before = readFileSync(resolve(app.manager.pathFor(profile.id), 'keyring.json'));
  for (const headers of [
    { Host: 'localhost:5180' },
    { Host: 'localhost:9911' },
    { Origin: 'http://localhost:5180' },
  ] as Array<Record<string, string>>) {
    const result = await cards(headers);
    assert.equal(result.find((card) => card.id === profile.id)?.hasPasskey, true);
    assert.equal(result.find((card) => card.id === other.id)?.hasPasskey, false);
    assert(result.every((card) => card.locked));
    for (const card of result)
      assert.deepEqual(
        Object.keys(card).sort(),
        [...Object.keys(app.manager.card(card.id)), 'hasPasskey'].sort(),
        'only the boolean is added to public metadata',
      );
  }
  for (const headers of [
    {},
    { Host: '127.0.0.1:5180' },
    { Host: 'health.example' },
    { Origin: 'https://health.example' },
  ] as Array<Record<string, string>>) {
    assert((await cards(headers)).every((card) => card.hasPasskey === false));
  }
  assert.equal(
    (await fetch(url + '/api/profiles', { headers: { Origin: 'https://foreign.example' } })).status,
    403,
  );
  assert.equal(app.manager.opened.size, 0, 'availability must not open private databases');
  assert.deepEqual(
    readFileSync(resolve(app.manager.pathFor(profile.id), 'keyring.json')),
    before,
    'listing does not change key metadata',
  );
});
