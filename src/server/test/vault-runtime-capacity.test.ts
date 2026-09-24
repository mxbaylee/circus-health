import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createEncryptedProfiles } from '../encrypted-profiles.ts';
import { newProfile } from './helpers/vault-fixture.ts';
import { uploadIntake, getIntakeOriginal } from '../intake.ts';
import { profileOriginal, ensureProfileOriginal } from '../profile-storage.ts';
import { importStorageEstimate } from '../archive-storage.ts';
import { intakeLimits } from '../intake-files.ts';

function fixture(t: TestContext) {
  const base = mkdtempSync(resolve(tmpdir(), 'fictional-vault-capacity-'));
  const dataDirectory = resolve(base, 'archive'),
    runtimeDirectory = resolve(base, 'runtime');
  mkdirSync(dataDirectory);
  let available: number | null = 2 * 1024 ** 3;
  const manager = createEncryptedProfiles({
    dataDirectory,
    runtimeDirectory,
    availableRuntimeBytes: () => available,
  });
  t.after(() => {
    manager.close();
    rmSync(base, { recursive: true, force: true });
  });
  return {
    manager,
    dataDirectory,
    runtimeDirectory,
    setAvailable(value: number | null) {
      available = value;
    },
  };
}

test('existing archive unlock and cache-loss rebuild defer original plaintext until scoped access', async (t) => {
  const f = fixture(t),
    created = await newProfile(f.manager, 'Fictional Lazy Archive');
  const id = created.profile.id;
  let state = f.manager.opened.get(id)!;
  const one = uploadIntake(state.db, state.root, id, {
    filename: 'fictional-one.txt',
    bytes: Buffer.alloc(2 * 1024 ** 2, 'a'),
  });
  const two = uploadIntake(state.db, state.root, id, {
    filename: 'fictional-two.txt',
    bytes: Buffer.alloc(2 * 1024 ** 2, 'b'),
  });
  const paths = [one, two].map((item) =>
    String(state.db.prepare('SELECT path FROM source_files WHERE id=?').get(item.id)!.path),
  );
  const before = state.vault.workspaceEstimate(
    (name) => name.startsWith('sources/') || name.startsWith('attachments/'),
  );
  assert.ok(before.deferredBytes >= 4 * 1024 ** 2);
  f.manager.lock(id);
  rmSync(resolve(f.manager.pathFor(id), 'cache'), { recursive: true, force: true });
  f.manager.unlock(id, created.recoveryKit);
  state = f.manager.opened.get(id)!;
  assert.equal(state.metrics.cacheHit, false);
  for (const path of paths)
    assert.equal(
      existsSync(resolve(state.root, path)),
      false,
      'Unlock/rebuild must not materialize every original',
    );
  assert.deepEqual(
    getIntakeOriginal(state.db, state.root, id, one.id).bytes,
    Buffer.alloc(2 * 1024 ** 2, 'a'),
  );
  assert.equal(existsSync(resolve(state.root, paths[0]!)), true);
  assert.equal(existsSync(resolve(state.root, paths[1]!)), false);
  assert.throws(() =>
    profileOriginal(state.root, paths[1]!, 'p-00000000-0000-4000-8000-000000000000'),
  );
  const retained = state.vault.metadata().files;
  uploadIntake(state.db, state.root, id, {
    filename: 'fictional-new-after-unlock.txt',
    bytes: Buffer.from('new fictional evidence after a partial materialization'),
  });
  const root = state.root;
  f.manager.lock(id);
  ensureProfileOriginal(root, paths[0]!, id);
  assert.equal(existsSync(root), false, 'Lock unregisters the resolver and removes plaintext');
  rmSync(resolve(f.manager.pathFor(id), 'cache'), { recursive: true, force: true });
  f.manager.unlock(id, created.recoveryKit);
  state = f.manager.opened.get(id)!;
  for (const [name, objectId] of Object.entries(retained))
    assert.equal(
      state.vault.metadata().files[name],
      objectId,
      'Absent lazy files are never deletions',
    );
  assert.deepEqual(
    getIntakeOriginal(state.db, state.root, id, two.id).bytes,
    Buffer.alloc(2 * 1024 ** 2, 'b'),
  );
  assert.equal(state.db.prepare('SELECT count(*) AS n FROM source_files').get()!.n, 3);
});

test('unlock capacity refusal precedes materialization and leaves encrypted authority unchanged', async (t) => {
  const f = fixture(t),
    created = await newProfile(f.manager, 'Fictional Capacity Gate');
  const id = created.profile.id;
  const state = f.manager.opened.get(id)!;
  const key = Buffer.from(state.key);
  const plan = state.vault.workspaceEstimate(
    (name) => name.startsWith('sources/') || name.startsWith('attachments/'),
  );
  const upload = importStorageEstimate(
    intakeLimits().uploadBytes,
    f.dataDirectory,
    f.runtimeDirectory,
  ).runtimePlanningBytes;
  f.manager.lock(id);
  const manifest = resolve(f.manager.pathFor(id), 'vault/manifest.enc');
  const ciphertext = readFileSync(manifest);
  f.setAvailable(plan.eagerBytes + plan.databasePlanningBytes + upload - 1);
  assert.throws(() => f.manager.unlockWithKey(id, key), {
    code: 'PROFILE_RUNTIME_CAPACITY',
    status: 507,
  });
  assert.equal(
    key.every((byte) => byte === 0),
    true,
  );
  assert.equal(f.manager.opened.has(id), false);
  assert.equal(existsSync(resolve(f.runtimeDirectory, id)), false);
  assert.deepEqual(readFileSync(manifest), ciphertext);
  f.setAvailable(null);
  f.manager.unlock(id, created.recoveryKit);
  assert.equal(f.manager.opened.has(id), true, 'Unknown quota is not represented as zero capacity');
});

test('on-demand original capacity refusal leaves no partial file and a later retry succeeds', async (t) => {
  const f = fixture(t),
    created = await newProfile(f.manager, 'Fictional Read Capacity');
  const id = created.profile.id;
  let state = f.manager.opened.get(id)!;
  const bytes = Buffer.alloc(1024 * 1024, 'x');
  const item = uploadIntake(state.db, state.root, id, { filename: 'fictional.txt', bytes });
  const path = String(
    state.db.prepare('SELECT path FROM source_files WHERE id=?').get(item.id)!.path,
  );
  f.manager.lock(id);
  f.manager.unlock(id, created.recoveryKit);
  state = f.manager.opened.get(id)!;
  f.setAvailable(bytes.length - 1);
  assert.throws(() => getIntakeOriginal(state.db, state.root, id, item.id), {
    code: 'ORIGINAL_RUNTIME_CAPACITY',
    status: 507,
  });
  assert.equal(existsSync(resolve(state.root, path)), false);
  f.setAvailable(bytes.length);
  assert.deepEqual(getIntakeOriginal(state.db, state.root, id, item.id).bytes, bytes);
});

for (const loseCache of [false, true])
  test(`tampered deferred ciphertext refuses ${loseCache ? 'cache-loss' : 'cached'} unlock and cleans runtime keys`, async (t) => {
    const f = fixture(t),
      created = await newProfile(f.manager, 'Fictional Integrity Gate');
    const id = created.profile.id,
      state = f.manager.opened.get(id)!;
    const item = uploadIntake(state.db, state.root, id, {
      filename: 'fictional.txt',
      bytes: Buffer.from('fictional retained evidence'),
    });
    const path = String(
      state.db.prepare('SELECT path FROM source_files WHERE id=?').get(item.id)!.path,
    ).slice(`data/profiles/${id}/`.length);
    const objectId = state.vault.metadata().files[path]!;
    f.manager.lock(id);
    const object = resolve(f.manager.pathFor(id), 'vault/objects', `${objectId}.enc`);
    const corrupt = readFileSync(object);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    writeFileSync(object, corrupt);
    if (loseCache)
      rmSync(resolve(f.manager.pathFor(id), 'cache'), { recursive: true, force: true });
    assert.throws(() => f.manager.unlock(id, created.recoveryKit), /authentication|encrypted/i);
    assert.equal(f.manager.opened.has(id), false);
    assert.equal(existsSync(resolve(f.runtimeDirectory, id)), false);
  });

test('copying a locked-then-unlocked archive copies deferred originals under the new key', async (t) => {
  const f = fixture(t),
    created = await newProfile(f.manager, 'Fictional Copy Source');
  const id = created.profile.id;
  let state = f.manager.opened.get(id)!;
  const bytes = Buffer.alloc(1024 * 1024, 'c');
  const item = uploadIntake(state.db, state.root, id, { filename: 'fictional-copy.txt', bytes });
  f.manager.lock(id);
  f.manager.unlock(id, created.recoveryKit);
  state = f.manager.opened.get(id)!;
  const setup = f.manager.begin({ name: 'Fictional Copy Destination', copyFrom: id });
  const copied = await f.manager.verify(setup.setupId, {
    acknowledged: true,
    recovery: setup.recoveryKit,
  });
  let destination = f.manager.opened.get(copied.id)!;
  assert.notDeepEqual(destination.key, state.key);
  assert.deepEqual(
    getIntakeOriginal(destination.db, destination.root, copied.id, item.id).bytes,
    bytes,
  );
  assert.equal(existsSync(resolve(destination.root, 'copy-original')), false);
  f.manager.lock(copied.id);
  rmSync(resolve(f.manager.pathFor(copied.id), 'cache'), { recursive: true, force: true });
  f.manager.unlock(copied.id, setup.recoveryKit);
  destination = f.manager.opened.get(copied.id)!;
  assert.equal(destination.metrics.cacheHit, false);
  assert.deepEqual(
    getIntakeOriginal(destination.db, destination.root, copied.id, item.id).bytes,
    bytes,
  );
});
