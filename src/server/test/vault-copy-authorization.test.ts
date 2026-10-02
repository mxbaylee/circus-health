import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createVaultApp } from '../vault-app.ts';

interface Setup {
  setupId: string;
  profileId: string;
  recoveryKit: { phrase: string; profileId: string };
}
interface Result<T> {
  status: number;
  data?: T;
  error?: { code?: string };
}
type Send = <T = unknown>(path: string, method?: string, input?: unknown) => Promise<Result<T>>;

async function fixture(t: TestContext) {
  const base = mkdtempSync(resolve(tmpdir(), 'fictional-vault-copy-authorization-'));
  const dataDirectory = resolve(base, 'data');
  mkdirSync(dataDirectory);
  const app = createVaultApp({
    dataDirectory,
    runtimeDirectory: resolve(base, 'runtime'),
    assistantOptions: { availability: async () => ({ available: false }) },
  });
  t.after(() => {
    try {
      app.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const client = (): Send => {
    let cookie = '';
    return async <T>(path: string, method = 'GET', input?: unknown): Promise<Result<T>> => {
      const response = await fetch(url + path, {
        method,
        headers: {
          Origin: 'http://127.0.0.1:5173',
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      if (response.headers.has('set-cookie'))
        cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      return { status: response.status, ...(await response.json()) };
    };
  };
  const a = client(),
    b = client();
  const sourceSetup = await a<Setup>('/api/profile-setups', 'POST', {
    name: 'Fictional authorized source',
    fullName: 'Fictional authorized source',
    birthDate: '1982-04-17',
  });
  assert.equal(sourceSetup.status, 201);
  const source = sourceSetup.data!;
  assert.equal(
    (
      await a(`/api/profile-setups/${source.setupId}/verify`, 'POST', {
        acknowledged: true,
        recovery: source.recoveryKit,
      })
    ).status,
    201,
  );
  const begin = async () => {
    const response = await a<Setup>('/api/profile-setups', 'POST', {
      name: 'Fictional authorized destination',
      copyFrom: source.profileId,
    });
    assert.equal(response.status, 201);
    return response.data!;
  };
  const verify = (send: Send, copy: Setup, extras: Record<string, unknown> = {}) =>
    send<{ id: string }>(`/api/profile-setups/${copy.setupId}/verify`, 'POST', {
      acknowledged: true,
      recovery: copy.recoveryKit,
      ...extras,
    });
  return { app, dataDirectory, a, b, source, begin, verify };
}

test('resuming a copy kit in another HTTP session cannot borrow the globally unlocked source', async (t) => {
  const { app, a, b, source, begin, verify } = await fixture(t);
  const copy = await begin();
  const resumed = await b<{ setupId: string; active: boolean }>(
    '/api/profile-setups/resume',
    'POST',
    { recovery: copy.recoveryKit },
  );
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data!.active, false);
  assert.equal(app.manager.opened.has(source.profileId), true);
  assert.equal((await b(`/api/profiles/${source.profileId}/notes/patient`)).status, 423);
  const denied = await verify(
    b,
    { ...copy, setupId: resumed.data!.setupId },
    {
      authorizeCopySource: true,
      sourceAuthorized: true,
      unlocked: true,
      copyFrom: source.profileId,
    },
  );
  assert.equal(denied.status, 423);
  assert.equal(denied.error?.code, 'PROFILE_LOCKED');
  assert.equal(app.manager.opened.has(copy.profileId), false);
  assert.equal(app.manager.keyring(copy.profileId).active, false);
  assert.equal(
    app.manager.list().some((profile) => profile.id === copy.profileId),
    false,
  );
  assert.equal((await a(`/api/profiles/${source.profileId}/notes/patient`)).status, 200);
  const accepted = await verify(a, copy);
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data!.id, copy.profileId);
  assert.equal((await a(`/api/profiles/${copy.profileId}/notes/patient`)).status, 200);
  assert.equal((await b(`/api/profiles/${copy.profileId}/notes/patient`)).status, 423);
});

test('source lock and later session revocation between begin and verify both require fresh authorization', async (t) => {
  const { app, a, b, source, begin, verify } = await fixture(t);
  const copy = await begin();
  assert.equal((await a(`/api/profiles/${source.profileId}/lock`, 'POST', {})).status, 200);
  assert.equal((await verify(a, copy)).status, 423);
  assert.equal(app.manager.keyring(copy.profileId).active, false);
  assert.equal(
    (
      await a(`/api/profiles/${source.profileId}/unlock`, 'POST', {
        recovery: source.recoveryKit,
      })
    ).status,
    200,
  );
  assert.equal((await a(`/api/profiles/${source.profileId}/notes/patient`)).status, 200);
  const other = await b<Setup>('/api/profile-setups', 'POST', {
    name: 'Fictional session revocation',
    fullName: 'Fictional session revocation',
    birthDate: '1982-04-17',
  });
  assert.equal(other.status, 201);
  assert.equal((await verify(b, other.data!)).status, 201);
  assert.equal(
    app.manager.opened.has(source.profileId),
    false,
    'A profile switch revokes the source session',
  );
  assert.equal(
    (await b(`/api/profiles/${source.profileId}/unlock`, 'POST', { recovery: source.recoveryKit }))
      .status,
    200,
  );
  assert.equal(app.manager.opened.has(source.profileId), true);
  assert.equal((await a(`/api/profiles/${source.profileId}/notes/patient`)).status, 423);
  assert.equal((await verify(a, copy, { sourceAuthorized: true })).status, 423);
  assert.equal(app.manager.opened.has(copy.profileId), false);
  assert.equal(
    (await verify(b, copy)).status,
    201,
    'A session with current source access can complete the retained setup',
  );
  assert.equal((await b(`/api/profiles/${copy.profileId}/notes/patient`)).status, 200);
});

test('a published copy interrupted before activation recovers in another session from its own kit', async (t) => {
  const { app, dataDirectory, a, b, source, begin, verify } = await fixture(t);
  const copy = await begin();
  const registryPath = resolve(dataDirectory, 'profiles.json');
  const rename = fs.renameSync;
  let injectedFailures = 0;
  const injected = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
    if (
      String(args[1]) === registryPath &&
      (
        JSON.parse(readFileSync(args[0], 'utf8')) as { profiles: Array<{ id: string }> }
      ).profiles.some((profile) => profile.id === copy.profileId)
    ) {
      injectedFailures++;
      throw new Error('Fictional copy activation registry fault');
    }
    return rename(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await verify(a, copy)).status, 500);
  } finally {
    injected.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(injectedFailures, 1, 'The fault must hit post-publication activation');
  assert.equal(app.manager.opened.has(copy.profileId), false);
  assert.equal(app.manager.keyring(copy.profileId).active, true);
  assert.equal(
    app.manager.list().some((profile) => profile.id === copy.profileId),
    false,
  );
  assert.equal((await a(`/api/profiles/${source.profileId}/lock`, 'POST', {})).status, 200);
  assert.equal(app.manager.opened.has(source.profileId), false);
  const resumed = await b<{ setupId: string; active: boolean }>(
    '/api/profile-setups/resume',
    'POST',
    { recovery: copy.recoveryKit },
  );
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data!.active, false);
  const restored = await verify(b, { ...copy, setupId: resumed.data!.setupId });
  assert.equal(
    restored.status,
    201,
    'Selected target authority must not require a source unlock or source session',
  );
  assert.equal(restored.data!.id, copy.profileId);
  assert.equal((await b(`/api/profiles/${copy.profileId}/notes/patient`)).status, 200);
  assert.equal((await a(`/api/profiles/${copy.profileId}/notes/patient`)).status, 423);
});
