import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createEncryptedProfiles } from '../encrypted-profiles.ts';
import { readProfileRegistry } from '../profile-registry.ts';
import { createApp } from '../index.ts';

test('Placebo classification stays canonical through encrypted creation, scoped API, copy and cache-loss rebuild', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-brand-profile-')),
    dataDirectory = resolve(root, 'data'),
    runtimeDirectory = resolve(root, 'runtime');
  mkdirSync(dataDirectory);
  const manager = createEncryptedProfiles({ dataDirectory, runtimeDirectory });
  t.after(() => {
    manager.close();
    rmSync(root, { recursive: true, force: true });
  });
  const setup = manager.begin({ name: 'Fictional Acorn', placebo: true }),
    profile = await manager.verify(setup.setupId, {
      acknowledged: true,
      recovery: setup.recoveryKit,
    });
  assert.equal(profile.placebo, true);
  const state = manager.opened.get(profile.id);
  assert.ok(state);
  assert.deepEqual(readProfileRegistry(state.root).profiles, [{ id: profile.id, placebo: true }]);
  const source = state.db
    .prepare("SELECT path FROM source_files WHERE id='synthetic-placebo-source'")
    .get();
  assert.ok(source);
  assert(
    readFileSync(resolve(state.root, String(source.path)), 'utf8')
      .trim()
      .split('\n')
      .every((line) => JSON.parse(line).fictional === true),
  );
  assert.equal(
    JSON.parse(
      state.db
        .prepare("SELECT coverage_json FROM manual_batches WHERE id='synthetic-placebo-v1'")
        .get()?.coverage_json as string,
    ).generator,
    'circus-health-synthetic-placebo-v1',
  );
  const app = createApp({ root: state.root, databases: new Map([[profile.id, state.db]]) });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const address = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/api/profiles`;
  try {
    const response = (await (await fetch(base + `/${profile.id}/notes/patient`)).json()) as {
      meta: { profile: { placebo: boolean } & Record<string, unknown> };
    };
    assert.equal(response.meta.profile.placebo, true);
    assert.deepEqual(Object.keys(response.meta.profile).sort(), [
      'icon',
      'id',
      'name',
      'nameVersion',
      'placebo',
      'version',
    ]);
  } finally {
    await new Promise<void>((done) => app.server.close(() => done()));
  }
  const copied = manager.begin({ name: 'Private copy', copyFrom: profile.id }),
    copy = await manager.verify(copied.setupId, {
      acknowledged: true,
      recovery: copied.recoveryKit,
    });
  assert.equal(copy.placebo, false);
  assert.deepEqual(readProfileRegistry(manager.opened.get(copy.id)!.root).profiles, [
    { id: copy.id, placebo: false },
  ]);
  manager.lock(profile.id);
  rmSync(resolve(dataDirectory, 'profiles', profile.id, 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, setup.recoveryKit);
  assert.equal(manager.card(profile.id).placebo, true);
  assert.deepEqual(readProfileRegistry(manager.opened.get(profile.id)!.root).profiles, [
    { id: profile.id, placebo: true },
  ]);
  assert(
    Number(
      manager.opened.get(profile.id)!.db.prepare('SELECT count(*) n FROM observations').get()?.n,
    ) > 10,
  );
});
