import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createVaultApp } from '../vault-app.ts';

interface ApiResult<T = unknown> {
  status: number;
  headers: Headers;
  bytes: Buffer;
  data?: T;
}
type Send = <T = unknown>(
  path: string,
  method?: string,
  input?: unknown,
  extraHeaders?: Record<string, string>,
) => Promise<ApiResult<T>>;

test('one unlocked profile is enforced across HTTP sessions and originals survive encrypted reconstruction', async (t) => {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-vault-isolation-'));
  const dataDirectory = resolve(base, 'data');
  mkdirSync(dataDirectory);
  const app = createVaultApp({
    dataDirectory,
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
  const url = `http://127.0.0.1:${address.port}`;
  function client(): Send {
    let cookie = '';
    return async <T = unknown>(
      path: string,
      method = 'GET',
      input?: unknown,
      extraHeaders: Record<string, string> = {},
    ): Promise<ApiResult<T>> => {
      const response = await fetch(url + path, {
        method,
        headers: {
          Origin: 'http://127.0.0.1:5173',
          Cookie: cookie,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        ...(input === undefined
          ? {}
          : {
              body: Buffer.isBuffer(input) ? (input as unknown as BodyInit) : JSON.stringify(input),
            }),
      });
      if (response.headers.get('set-cookie'))
        cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      const bytes = Buffer.from(await response.arrayBuffer());
      const json = response.headers.get('content-type')?.startsWith('application/json')
        ? JSON.parse(bytes.toString('utf8'))
        : {};
      return { status: response.status, headers: response.headers, bytes, ...json } as ApiResult<T>;
    };
  }
  async function create(send: Send, name: string) {
    const setup = await send<{ setupId: string; recoveryKit: { phrase: string } }>(
      '/api/profile-setups',
      'POST',
      { fullName: name, birthDate: '1982-04-17', name, placebo: false },
    );
    assert.equal(setup.status, 201);
    const verified = await send<{ id: string }>(
      `/api/profile-setups/${setup.data!.setupId}/verify`,
      'POST',
      {
        acknowledged: true,
        recovery: setup.data!.recoveryKit,
      },
    );
    assert.equal(verified.status, 201);
    return { profile: verified.data!, recoveryKit: setup.data!.recoveryKit };
  }
  const a = client(),
    b = client(),
    stranger = client();
  const one = await create(a, 'Synthetic account one');
  const prefix = (id: string) => `/api/profiles/${id}`;
  const bytes = Buffer.from('%PDF-1.4\nSynthetic private original: fault-isolation-only\n%%EOF\n');
  const uploaded = await a<{ id: string }>(prefix(one.profile.id) + '/assets', 'POST', bytes, {
    'Content-Type': 'application/pdf',
    'X-Filename': encodeURIComponent('synthetic-private-original.pdf'),
  });
  assert.equal(uploaded.status, 201);
  const content = '/assets/' + encodeURIComponent(uploaded.data!.id) + '/content';
  const original = await a(prefix(one.profile.id) + content);
  assert.equal(original.status, 200);
  assert.deepEqual(original.bytes, bytes);
  assert.equal(original.headers.get('cache-control'), 'no-store');

  const state = app.manager.opened.get(one.profile.id);
  assert.ok(state);
  const two = await create(b, 'Synthetic account two');
  assert.deepEqual(
    [...app.manager.opened.keys()],
    [two.profile.id],
    'activating a setup locks the previous profile',
  );
  assert(
    state.key.every((byte) => byte === 0),
    'the old data key is cleared',
  );
  assert.equal((await a(prefix(one.profile.id) + content)).status, 423);
  assert.equal((await a(prefix(two.profile.id) + '/notes/patient')).status, 423);
  assert.equal(
    (await b(prefix(two.profile.id) + content)).status,
    404,
    'another owned profile cannot resolve the first profile’s asset ID',
  );
  assert.equal(
    (await a(prefix(one.profile.id) + '/unlock', 'POST', { recovery: two.recoveryKit })).status,
    400,
  );
  assert.equal(
    (await b(prefix(two.profile.id) + '/notes/patient')).status,
    200,
    'invalid recovery proof leaves the current profile usable',
  );
  assert.equal(
    (await a(prefix(one.profile.id) + '/unlock', 'POST', { recovery: one.recoveryKit })).status,
    200,
  );
  assert.deepEqual([...app.manager.opened.keys()], [one.profile.id]);
  assert.equal(
    (await b(prefix(two.profile.id) + '/notes/patient')).status,
    423,
    'successful recovery revokes previous sessions',
  );

  for (const send of [b, stranger]) {
    for (const suffix of ['/notes/patient', '/notes/patient/history', content]) {
      const denied = await send(prefix(one.profile.id) + suffix);
      assert.equal(denied.status, 423, 'globally open does not authorize another HTTP session');
      assert.equal(denied.bytes.includes(bytes), false);
    }
  }
  assert.equal((await a(prefix(two.profile.id) + '/notes/patient')).status, 423);
  assert.equal((await b(prefix(two.profile.id) + content)).status, 423);
  assert.equal(
    (
      await b(prefix(one.profile.id) + '/assets', 'POST', bytes, {
        'Content-Type': 'application/pdf',
      })
    ).status,
    423,
  );

  assert.equal((await a(prefix(one.profile.id) + '/lock', 'POST', {})).status, 200);
  assert.equal((await a(prefix(one.profile.id) + content)).status, 423);
  assert.equal(
    (await b(prefix(two.profile.id) + '/notes/patient')).status,
    423,
    'switching never leaves a second active profile',
  );
  const cards = (await a<Array<{ locked: boolean }>>('/api/profiles')).data!;
  assert(
    cards.every((card) => card.locked),
    'public cards must reflect this session’s authorization',
  );
  assert.equal(
    (await a(prefix(one.profile.id) + '/unlock', 'POST', { recovery: two.recoveryKit })).status,
    400,
  );
  assert.equal((await a(prefix(one.profile.id) + content)).status, 423);

  rmSync(resolve(dataDirectory, 'profiles', one.profile.id, 'cache'), {
    recursive: true,
    force: true,
  });
  assert.equal(
    (await a(prefix(one.profile.id) + '/unlock', 'POST', { recovery: one.recoveryKit })).status,
    200,
  );
  const rebuilt = await a(prefix(one.profile.id) + content);
  assert.equal(rebuilt.status, 200);
  assert.deepEqual(rebuilt.bytes, bytes);
  assert.equal((await b(prefix(one.profile.id) + content)).status, 423);

  function inspect(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) inspect(child);
      else {
        const stored = readFileSync(child);
        assert.equal(
          stored.includes(bytes),
          false,
          'original bytes must not appear in durable storage',
        );
        assert.equal(
          stored.includes(Buffer.from('synthetic-private-original.pdf')),
          false,
          'original names must be encrypted',
        );
        assert.equal(
          stored.includes(Buffer.from(one.recoveryKit.phrase)),
          false,
          'the archive must not retain the recovery secret',
        );
      }
    }
  }
  inspect(dataDirectory);
});
