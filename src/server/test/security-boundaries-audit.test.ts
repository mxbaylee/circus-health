import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createVaultApp } from '../vault-app.ts';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';
import { createNote, getNote, saveNote } from '../notes.ts';

interface ApiResult<T = unknown> {
  status: number;
  cookie?: string;
  data?: T;
}
interface ModelRequest {
  tools: Array<{ function: { name: string } }>;
}

// These assertions describe reviewed security boundaries, including known gaps;
// they are not approval to expose the service to untrusted clients.
test('anonymous allowed-origin connection tests reach the configured model, but private routes do not', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-security-boundary-'));
  mkdirSync(resolve(root, 'data'));
  const app = createVaultApp({
    dataDirectory: resolve(root, 'data'),
    runtimeDirectory: resolve(root, 'runtime'),
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const realFetch = globalThis.fetch;
  const settings = {
    CRS_AI_BACKEND: 'litellm',
    CRS_AI_MODEL: 'fictional-security-test',
    CRS_AI_BASE_URL: 'http://fictional-model.invalid',
    CRS_AI_API_KEY: 'fictional-key-only',
    CRS_AI_API_KEY_FILE: undefined,
    CRS_AI_PROXY_LOCAL_ONLY: 'false',
    CRS_AI_REASONING_EFFORT: undefined,
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const outbound: ModelRequest[] = [];
  globalThis.fetch = async (input, options) => {
    assert(
      String(input).startsWith('http://fictional-model.invalid/'),
      'no unplanned outbound destination',
    );
    outbound.push(JSON.parse(String(options?.body)) as ModelRequest);
    throw Error('Fictional transport intentionally blocked before network access');
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const address = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const request = async <T = unknown>(
    path: string,
    method = 'GET',
    body?: unknown,
    cookie = '',
    origin = 'http://localhost:5173',
  ): Promise<ApiResult<T>> => {
    const response = await realFetch(url + path, {
      method,
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      cookie: response.headers.get('set-cookie')?.split(';')[0],
      ...((await response.json()) as object),
    } as ApiResult<T>;
  };
  const setup = await request<{ setupId: string; recoveryKit: unknown }>(
    '/api/profile-setups',
    'POST',
    {
      fullName: 'Fictional security profile',
      birthDate: '1982-04-17',
      name: 'Fictional security profile',
    },
  );
  const ownerCookie = setup.cookie;
  const verified = await request(
    `/api/profile-setups/${setup.data!.setupId}/verify`,
    'POST',
    { acknowledged: true, recovery: setup.data!.recoveryKit },
    ownerCookie,
  );
  const prefix = `/api/profiles/${(verified.data as { id: string }).id}`;
  const note = await request<{ id: string }>(
    prefix + '/notes',
    'POST',
    { title: 'Fictional private marker', content: 'fictional-private-content-5831' },
    ownerCookie,
  );
  assert.equal(note.status, 201);
  for (const [path, method, body] of [
    ['/notes/patient', 'GET'],
    ['/record-history', 'GET'],
    ['/assistant/status', 'GET'],
    ['/assistant/chats', 'GET'],
    ['/assistant/chats', 'POST', { message: 'Read private data' }],
    ['/assistant/chats/fake/messages', 'POST', { message: 'Read private data' }],
    ['/assistant/chats/fake/apply', 'POST', { proposalId: 'fake' }],
    ['/note-exports/options', 'POST', { type: 'note', id: note.data!.id }],
    ['/assets/fake/content', 'GET'],
    ['/sources/fake/content', 'GET'],
    ['/assets', 'POST', {}],
    ['/intakes', 'POST', {}],
  ] as Array<[string, string, unknown?]>)
    assert.equal((await request(prefix + path, method, body)).status, 423, path);
  assert.equal(outbound.length, 0, 'private assistant routes stop before model invocation');
  assert.equal(
    (await request('/api/ai/test-connection', 'POST', {}, '', 'https://untrusted.example')).status,
    403,
  );
  assert.equal(outbound.length, 0);
  const result = await request('/api/ai/test-connection', 'POST', {});
  assert.equal(result.status, 500, 'fictional intercepted transport fails after route entry');
  assert.equal(
    outbound.length,
    1,
    'no profile grant is required to invoke the public connection test',
  );
  assert(outbound[0]?.tools.every((tool) => tool.function.name === 'health_connection_test'));
  assert(!JSON.stringify(outbound).includes('fictional-private-content-5831'));
  // A separate client can also provision its own profile, revoking the owner's
  // access to the first profile without learning the first recovery secret.
  const second = await request('/api/profile-setups', 'POST', {
    fullName: 'Other fictional security profile',
    birthDate: '1982-04-17',
    name: 'Other fictional security profile',
  });
  await request(
    `/api/profile-setups/${(second.data as { setupId: string }).setupId}/verify`,
    'POST',
    { acknowledged: true, recovery: (second.data as { recoveryKit: unknown }).recoveryKit },
    second.cookie,
  );
  assert.equal(
    (await request(prefix + '/notes/patient', 'GET', undefined, ownerCookie)).status,
    423,
  );
});

test('an older authentic vault head can roll back accepted records after disposable cache removal', async (t) => {
  const { manager } = vaultFixture(t),
    { profile, recoveryKit } = await newProfile(manager);
  const state = manager.opened.get(profile.id);
  assert.ok(state);
  const note = createNote(state.db, {
    title: 'Fictional rollback test',
    content: 'Before accepted edit',
  });
  const headPath = resolve(manager.pathFor(profile.id), 'vault/manifest.enc');
  const olderAuthenticatedHead = readFileSync(headPath);
  saveNote(state.db, note.id, { ...note, content: 'After accepted edit', version: note.version });
  assert.equal(getNote(state.db, note.id).content, 'After accepted edit');
  manager.lock(profile.id);
  writeFileSync(headPath, olderAuthenticatedHead);
  rmSync(resolve(manager.pathFor(profile.id), 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, recoveryKit);
  assert.equal(
    getNote(manager.opened.get(profile.id)!.db, note.id).content,
    'Before accepted edit',
  );
});
