import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createVaultApp } from '../vault-app.ts';
interface ApiResult<T = unknown> {
  status: number;
  data?: T;
}
test('HTTP profile gate protects records and originals across lock and recovery', async (t) => {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-vault-api-'));
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
  const origin = 'http://127.0.0.1:5173',
    url = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  async function send<T = unknown>(
    path: string,
    method = 'GET',
    input?: unknown,
    authenticated = true,
  ): Promise<ApiResult<T>> {
    const r = await fetch(url + path, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(authenticated ? { Cookie: cookie } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    if (authenticated && r.headers.get('set-cookie'))
      cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    return { status: r.status, ...((await r.json()) as object) } as ApiResult<T>;
  }
  assert.deepEqual((await send('/api/profiles')).data, []);
  const setup = (
    await send<{ setupId: string; recoveryKit: unknown }>('/api/profile-setups', 'POST', {
      fullName: 'Test Person',
      birthDate: '1982-04-17',
      name: 'Test Person',
      placebo: false,
    })
  ).data!;
  const verified = await send<{ id: string }>(
    `/api/profile-setups/${setup.setupId}/verify`,
    'POST',
    {
      recovery: setup.recoveryKit,
      acknowledged: true,
    },
  );
  assert.equal(verified.status, 201);
  const id = verified.data!.id;
  assert.equal((await send(`/api/profiles/${id}/notes/patient`)).status, 200);
  assert.equal(
    (await send(`/api/profiles/${id}/notes/patient`, 'GET', undefined, false)).status,
    423,
  );
  for (const suffix of ['backups', '%62ackups', 'backups/', '/backups'])
    assert.equal((await send(`/api/profiles/${id}/${suffix}`, 'POST', {})).status, 409);
  assert.equal((await send(`/api/profiles/${id}/lock`, 'POST', {})).status, 200);
  assert.equal((await send(`/api/profiles/${id}/notes/patient`)).status, 423);
  assert.equal(
    (await send(`/api/profiles/${id}/unlock`, 'POST', { recovery: setup.recoveryKit })).status,
    200,
  );
  assert.equal((await send(`/api/profiles/${id}/notes/patient`)).status, 200);
});
