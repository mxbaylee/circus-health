import { createTestRuntimeDirectory } from './runtime-fixture.ts';
import test, { type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { createEncryptedProfiles } from '../encrypted-profiles.ts';
import type { createProfilePasskeys } from '../profile-passkeys.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { startRuntime } from '../runtime.ts';

async function fixture(t: TestContext, publicOrigin = 'http://localhost:5180') {
  const names = ['CRS_PUBLIC_PORT', 'CRS_PUBLIC_ORIGIN', 'CRS_DEV'];
  const before = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    CRS_PUBLIC_PORT: '5180',
    CRS_PUBLIC_ORIGIN: publicOrigin,
    CRS_DEV: '0',
  });
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const base = mkdtempSync(join(tmpdir(), 'circus-origin-test-')),
    dataDirectory = join(base, 'data');
  mkdirSync(dataDirectory);
  const runtimeDirectory = createTestRuntimeDirectory();
  const runtime = await startRuntime({
    dataDirectory,
    runtimeDirectory,
    port: 0,
    host: '127.0.0.1',
  });
  t.after(async () => {
    await runtime.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });
  let cookie = '';
  async function request<T = unknown>(
    path: string,
    {
      origin = publicOrigin,
      host = new URL(publicOrigin).host,
      body = {},
      method = 'POST',
    }: { origin?: string | null; host?: string; body?: unknown; method?: string } = {},
  ) {
    return new Promise<{
      status: number | undefined;
      body: { data: T; error: { code: string; message: string } };
    }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: (runtime.server.address() as AddressInfo).port,
          path,
          method,
          headers: {
            Host: host,
            Cookie: cookie,
            'Content-Type': 'application/json',
            ...(origin === null ? {} : { Origin: origin }),
          },
        },
        (response) => {
          if (response.headers['set-cookie'])
            cookie = response.headers['set-cookie'][0].split(';')[0];
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            text += chunk;
          });
          response.on('end', () => {
            try {
              resolve({ status: response.statusCode, body: JSON.parse(text) });
            } catch (error) {
              reject(error);
            }
          });
          response.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(method === 'GET' ? undefined : JSON.stringify(body));
    });
  }
  return { request };
}

test('published local aliases pass origin checks while unrelated origins remain blocked', async (t) => {
  const { request } = await fixture(t);
  for (const origin of ['http://localhost:5180', 'http://127.0.0.1:5180']) {
    assert.equal(
      (await request('/api/profiles', { method: 'GET', origin, host: new URL(origin).host }))
        .status,
      200,
    );
  }
  for (const origin of ['http://foreign.example', 'http://localhost:5181', null]) {
    const result = await request('/api/profile-setups', {
      origin,
      body: {
        fullName: 'Fictional rejected origin',
        birthDate: '1982-04-17',
        name: 'Fictional rejected origin',
      },
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, origin === null ? 'ORIGIN_REQUIRED' : 'ORIGIN_REJECTED');
  }
  assert.equal(
    (await request('/api/profiles', { method: 'GET', host: 'foreign.example' })).status,
    403,
  );
  const setup = await request<ReturnType<ReturnType<typeof createEncryptedProfiles>['begin']>>(
    '/api/profile-setups',
    {
      body: {
        fullName: 'Fictional localhost passkey test',
        birthDate: '1982-04-17',
        name: 'Fictional localhost passkey test',
      },
    },
  );
  assert.equal(setup.status, 201);
  const verified = await request<
    Awaited<ReturnType<ReturnType<typeof createEncryptedProfiles>['verify']>>
  >(`/api/profile-setups/${setup.body.data.setupId}/verify`, {
    body: { acknowledged: true, recovery: setup.body.data.recoveryKit },
  });
  assert.equal(verified.status, 201);
  const path = `/api/profiles/${verified.body.data.id}/passkeys/options`;
  const options =
    await request<
      Awaited<ReturnType<ReturnType<typeof createProfilePasskeys>['registrationOptions']>>
    >(path);
  assert.equal(options.status, 200);
  assert.equal(options.body.data.options.rp.id, 'localhost');
  const ip = await request(path, { origin: 'http://127.0.0.1:5180', host: '127.0.0.1:5180' });
  assert.equal(ip.status, 400);
  assert.equal(ip.body.error.code, 'PASSKEY_DOMAIN');
  assert.match(ip.body.error.message, /http:\/\/localhost:5180/);
});

test('explicit HTTPS public origin retains its hostname for passkey options', async (t) => {
  // The local HTTP transport models a TLS-terminating reverse proxy's headers.
  const { request } = await fixture(t, 'https://health.example');
  const setup = await request<ReturnType<ReturnType<typeof createEncryptedProfiles>['begin']>>(
    '/api/profile-setups',
    {
      body: {
        fullName: 'Fictional HTTPS origin test',
        birthDate: '1982-04-17',
        name: 'Fictional HTTPS origin test',
      },
    },
  );
  assert.equal(setup.status, 201);
  const verified = await request<
    Awaited<ReturnType<ReturnType<typeof createEncryptedProfiles>['verify']>>
  >(`/api/profile-setups/${setup.body.data.setupId}/verify`, {
    body: { acknowledged: true, recovery: setup.body.data.recoveryKit },
  });
  assert.equal(verified.status, 201);
  const options = await request<
    Awaited<ReturnType<ReturnType<typeof createProfilePasskeys>['registrationOptions']>>
  >(`/api/profiles/${verified.body.data.id}/passkeys/options`);
  assert.equal(options.status, 200);
  assert.equal(options.body.data.options.rp.id, 'health.example');
});
