import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createVaultApp } from '../vault-app.ts';
import type { ProfilePasskey } from '../encrypted-profiles.ts';

interface ApiResult<T = unknown> {
  status: number;
  data?: T;
  error?: { code: string };
}

test('HTTP labels require the owning unlocked session and stay out of public cards', async (t) => {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-passkey-label-http-'));
  mkdirSync(resolve(base, 'data'));
  const app = createVaultApp({
    dataDirectory: resolve(base, 'data'),
    runtimeDirectory: resolve(base, 'runtime'),
    assistantOptions: { availability: async () => ({ available: false }) },
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(() => {
    app.close();
    rmSync(base, { recursive: true, force: true });
  });
  const address = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  async function post<T = unknown>(
    path: string,
    input: unknown = {},
    owned = true,
    origin = 'http://localhost:5173',
  ): Promise<ApiResult<T>> {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: {
        Origin: origin,
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
    await post<{ setupId: string; recoveryKit: unknown }>('/api/profile-setups', {
      fullName: 'Fictional named key profile',
      birthDate: '1982-04-17',
      name: 'Fictional named key profile',
    })
  ).data!;
  const profile = (
    await post<{ id: string }>(`/api/profile-setups/${setup.setupId}/verify`, {
      acknowledged: true,
      recovery: setup.recoveryKit,
    })
  ).data!;
  const ring = app.manager.keyring(profile.id);
  ring.passkeys.push({
    id: 'fictional-key',
    rpID: 'localhost',
    createdAt: '2026-09-12T00:00:00.000Z',
  } as unknown as ProfilePasskey);
  app.manager.writeKeyring(profile.id, ring);
  const path = `/api/profiles/${profile.id}`,
    input = { credentialId: 'fictional-key', label: '1Password' };
  assert.equal((await post(path + '/passkeys/rename', input, false)).status, 423);
  assert.equal(
    (await post(path + '/passkeys/rename', input, true, 'https://other.example')).status,
    403,
  );
  assert.equal((await post(path + '/passkeys/rename', { ...input, label: '' })).status, 400);
  assert.deepEqual((await post(path + '/passkeys/rename', input)).data, {
    renamed: true,
    label: '1Password',
  });
  const listed = await fetch(url + path + '/passkeys', { headers: { Cookie: cookie } });
  assert.equal(
    ((await listed.json()) as { data: Array<{ label?: string }> }).data[0]?.label,
    '1Password',
  );
  const publicProfiles = JSON.stringify(await (await fetch(url + '/api/profiles')).json());
  assert(!publicProfiles.includes('1Password'));
  assert(!publicProfiles.includes('encryptedLabel'));
  await post(path + '/passkeys/remove', { credentialId: 'fictional-key' });
  assert.equal((await post(path + '/passkeys/rename', input)).status, 404);
  await post(path + '/lock');
  assert.equal((await post(path + '/passkeys/rename', input)).status, 423);
});
