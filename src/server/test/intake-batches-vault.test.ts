import test from 'node:test';
import { fictionalModel } from './fictional-model.ts';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createAssistant } from '../assistant.ts';
import { writeChat } from '../assistant-journal.ts';
import { writeIntakeBatch } from '../intake-batch-journal.ts';
import { createIntakeBatchManager } from '../intake-batches.ts';
import { uploadIntake } from '../intake.ts';
import { createVaultApp } from '../vault-app.ts';
import { newProfile, vaultFixture } from './helpers/vault-fixture.ts';

function containsLiteral(root: string, literal: string) {
  if (!existsSync(root)) return false;
  const needle = Buffer.from(literal);
  let found = false;
  function visit(path: string) {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(resolve(path, name));
    } else if (stat.isFile() && readFileSync(path).includes(needle)) found = true;
  }
  visit(root);
  return found;
}

type VaultManager = ReturnType<typeof vaultFixture>['manager'];
type OpenedProfile = NonNullable<ReturnType<VaultManager['opened']['get']>>;

function runtime(vault: VaultManager, state: OpenedProfile) {
  const databases = new Map([[state.id, state.db]]);
  const assistant = createAssistant({
    root: state.root,
    databases,
    availability: () => ({ available: true, readiness: 'ready' }),
    connectionCheck: async () => ({
      available: false,
      readiness: 'unavailable',
      message: 'Synthetic model unavailable',
    }),
    journalWriter(root, profileId, chat, reason) {
      writeChat(root, profileId, chat, reason);
      vault.flush(profileId, { duringLock: true });
    },
  });
  const batches = createIntakeBatchManager({
    root: state.root,
    databases,
    assistant,
    pollMs: 5,
    journalWriter(root, profileId, batch, reason) {
      writeIntakeBatch(root, profileId, batch, reason);
      vault.flush(profileId, { duringLock: true });
    },
  });
  return { assistant, batches };
}

test('encrypted profile acknowledges batch journals only after vault publication and restores automatic intent', async (t) => {
  const f = vaultFixture(t);
  const created = await newProfile(f.manager, 'Fictional encrypted batch person');
  const profileId = created.profile.id;
  let state = f.manager.opened.get(profileId);
  assert.ok(state);
  const firstRuntime = runtime(f.manager, state);
  const filename = 'fictional-private-batch-marker.txt';
  const intake = uploadIntake(state.db, state.root, profileId, {
    filename,
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Fictional encrypted batch source'),
  });
  f.manager.flush(profileId);
  const batch = firstRuntime.batches.create(profileId, {
    operationId: 'fictional-encrypted-batch-operation',
    intakeIds: [intake.id],
  });
  const durableProfile = f.manager.pathFor(profileId);
  assert.equal(
    containsLiteral(durableProfile, filename),
    false,
    'durable vault files cannot expose batch filenames in plaintext',
  );
  assert.equal(
    containsLiteral(durableProfile, 'fictional-encrypted-batch-operation'),
    false,
    'durable vault files cannot expose operation IDs in plaintext',
  );

  firstRuntime.batches.close('profile_locked');
  firstRuntime.assistant.close();
  f.manager.lock(profileId);
  state = f.manager.opened.get(profileId);
  assert.equal(state, undefined);

  f.manager.unlock(profileId, created.recoveryKit);
  state = f.manager.opened.get(profileId);
  assert.ok(state);
  const secondRuntime = runtime(f.manager, state);
  t.after(() => {
    secondRuntime.batches.close();
    secondRuntime.assistant.close();
  });
  const restored = secondRuntime.batches.get(profileId, batch.id);
  assert.equal(restored.status, 'running');
  assert.equal(restored.reason, null);
  assert.equal(restored.items[0].sourceHash, intake.sha256);
  assert.equal(restored.items[0].filename, filename);
  secondRuntime.batches.close();
  secondRuntime.assistant.close();
});

test('encrypted HTTP batch route survives profile lock and complete SQLite cache loss', async (t) => {
  fictionalModel(t);
  const base = mkdtempSync(resolve(tmpdir(), 'batch-http-'));
  const dataDirectory = resolve(base, 'data');
  const runtimeDirectory = resolve(base, 'runtime');
  mkdirSync(dataDirectory);
  let releasePreflight!: () => void;
  const blockedPreflight = new Promise<void>((resolve) => {
    releasePreflight = resolve;
  });
  let preflightStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    preflightStarted = resolve;
  });
  const app = createVaultApp({
    dataDirectory,
    runtimeDirectory,
    assistantOptions: {
      availability: () => ({ available: true, readiness: 'ready' }),
      connectionCheck: async () => {
        preflightStarted();
        await blockedPreflight;
        return { available: true, readiness: 'ready' };
      },
    },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    releasePreflight?.();
    app.close();
    rmSync(base, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:5173';
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let cookie = '';
  async function jsonRequest(path: string, method = 'GET', input?: unknown) {
    const response = await fetch(url + path, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0]!;
    return { status: response.status, ...(await response.json()) };
  }
  const setup = (
    await jsonRequest('/api/profile-setups', 'POST', {
      fullName: 'Fictional encrypted HTTP batch person',
      birthDate: '1982-04-17',
      name: 'Fictional encrypted HTTP batch person',
      placebo: false,
    })
  ).data;
  const verified = await jsonRequest(`/api/profile-setups/${setup.setupId}/verify`, 'POST', {
    recovery: setup.recoveryKit,
    acknowledged: true,
  });
  const profileId = verified.data.id;
  const filename = 'fictional-http-encrypted-marker.txt';
  const upload = await fetch(`${url}/api/profiles/${profileId}/intakes`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'text/plain',
      'X-Filename': encodeURIComponent(filename),
      'X-Source-Name': encodeURIComponent('Fictional clinic'),
    },
    body: 'Fictional encrypted browser batch source',
  });
  assert.equal(upload.status, 201);
  const intake = (await upload.json()).data;
  const operationId = 'fictional-encrypted-http-operation';
  const batchResponse = await jsonRequest(`/api/profiles/${profileId}/intake-batches`, 'POST', {
    operationId,
    intakeIds: [intake.id],
  });
  assert.equal(batchResponse.status, 201);
  const batch = batchResponse.data;
  await started;
  assert.equal(containsLiteral(app.manager.pathFor(profileId), filename), false);
  assert.equal(containsLiteral(app.manager.pathFor(profileId), operationId), false);

  assert.equal((await jsonRequest(`/api/profiles/${profileId}/lock`, 'POST', {})).status, 200);
  releasePreflight();
  const cache = resolve(app.manager.pathFor(profileId), 'cache');
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  assert.equal(
    (
      await jsonRequest(`/api/profiles/${profileId}/unlock`, 'POST', {
        recovery: setup.recoveryKit,
      })
    ).status,
    200,
  );
  const restored = await jsonRequest(`/api/profiles/${profileId}/intake-batches/${batch.id}`);
  assert.equal(restored.status, 200);
  assert.equal(restored.data.status, 'running');
  assert.equal(restored.data.reason, null);
  assert.equal(restored.data.items[0].sourceHash, intake.sha256);
  assert.equal(restored.data.items[0].filename, filename);
});
