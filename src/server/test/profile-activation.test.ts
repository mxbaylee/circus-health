import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createVaultApp } from '../vault-app.ts';

interface ApiResult<T = unknown> {
  status: number;
  data?: T;
  error?: { code: string };
}
interface Setup {
  setupId: string;
  profileId: string;
  recoveryKit: unknown;
}
interface ProfileCard {
  id: string;
  locked: boolean;
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-profile-activation-'));
  mkdirSync(resolve(root, 'data'));
  const app = createVaultApp({
    dataDirectory: resolve(root, 'data'),
    runtimeDirectory: resolve(root, 'runtime'),
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(() => {
    try {
      app.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const address = app.server.address() as AddressInfo;
  let cookie = '';
  async function send<T = unknown>(path: string, input?: unknown): Promise<ApiResult<T>> {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    if (response.headers.get('set-cookie'))
      cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { status: response.status, ...((await response.json()) as object) } as ApiResult<T>;
  }
  const verify = (setup: Setup) =>
    send<ProfileCard>(`/api/profile-setups/${setup.setupId}/verify`, {
      acknowledged: true,
      recovery: setup.recoveryKit,
    });
  async function create(name: string, copyFrom?: string) {
    const setup = (
      await send<Setup>('/api/profile-setups', {
        fullName: name,
        birthDate: '1982-04-17',
        name,
        ...(copyFrom ? { copyFrom } : {}),
      })
    ).data!;
    const result = await verify(setup);
    assert.equal(result.status, 201);
    return { ...setup, profile: result.data! };
  }
  return { app, root, send, create, verify };
}
const path = (id: string) => `/api/profiles/${id}`;

test('copy activation closes its source only after recovery verification, preserving original history', async (t) => {
  const { app, send, create, verify } = await fixture(t);
  const first = await create('Fictional Original');
  const state = app.manager.opened.get(first.profileId);
  assert.ok(state);
  const head = state.recordStorage.read('head');
  const challenge = (
    await send<{ challengeId: string }>(path(first.profileId) + '/passkeys/options', {})
  ).data!;
  const copy = (
    await send('/api/profile-setups', { name: 'Fictional Copy', copyFrom: first.profileId })
  ).data as Setup;
  assert.equal(
    (
      await send(`/api/profile-setups/${copy.setupId}/verify`, {
        acknowledged: true,
        recovery: 'wrong',
      })
    ).status,
    400,
  );
  assert.equal((await send(path(first.profileId) + '/notes/patient')).status, 200);
  assert.equal((await verify(copy)).status, 201);
  assert.deepEqual([...app.manager.opened.keys()], [copy.profileId]);
  assert(state.key.every((byte) => byte === 0));
  assert.equal(existsSync(state.root), false);
  assert.equal((await send(path(first.profileId) + '/notes/patient')).status, 423);
  assert.equal(
    (await send<{ title: string }>(path(copy.profileId) + '/notes/patient')).data?.title,
    'Fictional Copy',
  );
  assert.equal(
    (await send(path(first.profileId) + '/unlock', { recovery: first.recoveryKit })).status,
    200,
  );
  assert.deepEqual(
    app.manager.opened.get(first.profileId)?.recordStorage.read('head'),
    head,
    'switching does not append clinical edits',
  );
  assert.equal(
    (
      await send(path(first.profileId) + '/passkeys/verify', {
        challengeId: challenge.challengeId,
        response: {},
      })
    ).error?.code,
    'PASSKEY_CHALLENGE',
    'switching invalidates pending ceremonies',
  );
  assert.equal((await send(path(copy.profileId) + '/notes/patient')).status, 423);
});

test('a failure saving the previous cache closes both profiles without granting new access', async (t) => {
  const { app, send, create } = await fixture(t);
  const first = await create('Fictional First'),
    second = await create('Fictional Second');
  const state = app.manager.opened.get(second.profileId);
  assert.ok(state);
  state.vault.writeCache = () => {
    throw Error('Fictional cache write failure');
  };
  const failed = await send(path(first.profileId) + '/unlock', { recovery: first.recoveryKit });
  assert.equal(failed.status, 503);
  assert.equal(failed.error?.code, 'PROFILE_SWITCH_FAILED');
  assert.equal(app.manager.opened.size, 0);
  assert(state.key.every((byte) => byte === 0));
  assert((await send<ProfileCard[]>('/api/profiles')).data?.every((profile) => profile.locked));
  assert.equal((await send(path(first.profileId) + '/notes/patient')).status, 423);
  assert.equal((await send(path(second.profileId) + '/notes/patient')).status, 423);
  assert.equal(
    (await send(path(first.profileId) + '/unlock', { recovery: first.recoveryKit })).status,
    200,
    'a failed switch must not poison the activation queue',
  );
  assert.equal(
    (await send(path(second.profileId) + '/unlock', { recovery: second.recoveryKit })).status,
    200,
    'the disposable cache failure does not lose durable data',
  );
});

test('concurrent recovery requests finish with one unlocked profile and revoke earlier grants', async (t) => {
  const { app, send, create } = await fixture(t);
  const first = await create('Fictional One'),
    second = await create('Fictional Two');
  const results = await Promise.all(
    [first, second, first, second].map((profile) =>
      send(path(profile.profileId) + '/unlock', { recovery: profile.recoveryKit }),
    ),
  );
  assert(results.every((result) => result.status === 200));
  assert.equal(app.manager.opened.size, 1);
  const cards = (await send<ProfileCard[]>('/api/profiles')).data!;
  assert.equal(cards.filter((profile) => !profile.locked).length, 1);
  for (const card of cards)
    assert.equal((await send(path(card.id) + '/notes/patient')).status, card.locked ? 423 : 200);
});
