import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  renameSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as yieldHost } from 'node:timers/promises';
import {
  createEncryptedProfiles,
  type CreateEncryptedProfilesOptions,
} from '../encrypted-profiles.ts';
import { createNote, getNote } from '../notes.ts';
import { createVaultApp } from '../vault-app.ts';
import type { AddressInfo } from 'node:net';

async function fixture(
  t: TestContext,
  checkpoint?: CreateEncryptedProfilesOptions['unlockCheckpoint'],
) {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-setup-cooperation-')),
    dataDirectory = resolve(base, 'data'),
    runtimeDirectory = resolve(base, 'runtime');
  mkdirSync(dataDirectory);
  const manager = createEncryptedProfiles({
    dataDirectory,
    runtimeDirectory,
    unlockCheckpoint: checkpoint,
  });
  t.after(() => {
    manager.close();
    rmSync(base, { recursive: true, force: true });
  });
  const active = manager.begin({
    name: 'Fictional Source',
    fullName: 'Fictional Source',
    birthDate: '1980-05-14',
  });
  await manager.verify(active.setupId, { acknowledged: true, recovery: active.recoveryKit });
  const source = manager.opened.get(active.profileId)!;
  const note = createNote(source.db, {
    kind: 'note',
    title: 'Fictional copy evidence',
    content: 'Independently fictional accepted content.',
  });
  for (let n = 0; n < 130; n++)
    source.vault.storeFile(
      `sources/fictional-${n}.txt`,
      Buffer.from(`Fictional encrypted source ${n}`),
    );
  source.vault.publish();
  const originalObject = source.vault.metadata().files['sources/fictional-0.txt']!;
  return { manager, active, source, note, originalObject, dataDirectory, runtimeDirectory };
}
function clean(f: Awaited<ReturnType<typeof fixture>>, target: string) {
  assert.deepEqual(
    readdirSync(f.runtimeDirectory).filter((name) => name.startsWith('.unlock-physical-')),
    [],
  );
  assert.deepEqual(
    readdirSync(resolve(f.dataDirectory, 'profiles', target)).filter((name) =>
      name.startsWith('.setup-stage-'),
    ),
    [],
  );
}
async function whileUsable(f: Awaited<ReturnType<typeof fixture>>, operation: Promise<unknown>) {
  let finished = false,
    turns = 0;
  operation.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  while (!finished) {
    assert.equal(getNote(f.source.db, f.note.id).content, f.note.content);
    turns++;
    await yieldHost();
  }
  await operation;
  assert.ok(turns > 1);
}

function ciphertextFiles(root: string) {
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((path) => lstatSync(resolve(root, path)).isFile())
    .sort()
    .map((path) => ({
      path,
      mode: lstatSync(resolve(root, path)).mode & 0o777,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, path)))
        .digest('hex'),
    }));
}

test('fresh setup and private copy prepare offhost while the current accepted source remains usable', async (t) => {
  const f = await fixture(t);
  for (const copy of [false, true]) {
    const target = f.manager.begin(
      copy
        ? { name: 'Fictional Private Copy', copyFrom: f.active.profileId }
        : {
            name: 'Fictional New Profile',
            fullName: 'Fictional New Profile',
            birthDate: '1991-07-18',
          },
    );
    const sourceRoot = resolve(f.manager.pathFor(f.active.profileId), 'vault'),
      targetRoot = resolve(f.manager.pathFor(target.profileId), 'vault'),
      sourceFiles = ciphertextFiles(sourceRoot),
      targetIndices = ciphertextFiles(targetRoot).filter((file) =>
        file.path.startsWith('indices/'),
      );
    assert.ok(
      targetIndices.length > 0,
      'the actual recursive setup copy contains retained indices',
    );
    await whileUsable(
      f,
      f.manager.verifyAsync(
        target.setupId,
        { acknowledged: true, recovery: target.recoveryKit },
        {
          authorizeCopySource(id) {
            assert.equal(id, f.active.profileId);
          },
        },
      ),
    );
    const opened = f.manager.opened.get(target.profileId)!;
    assert.equal(
      getNote(opened.db, 'patient').person.name,
      copy ? 'Fictional Private Copy' : 'Fictional New Profile',
    );
    if (copy) {
      assert.equal(getNote(opened.db, f.note.id).content, f.note.content);
      assert.equal(
        Object.keys(opened.vault.metadata().files).filter((name) => name.startsWith('sources/'))
          .length,
        130,
      );
    }
    assert.deepEqual(ciphertextFiles(sourceRoot), sourceFiles);
    const retained = new Map(ciphertextFiles(targetRoot).map((file) => [file.path, file]));
    for (const file of targetIndices) assert.deepEqual(retained.get(file.path), file);
    assert.ok(opened.recoveryWork!.physicalCheckedEntries > 0);
    clean(f, target.profileId);
    f.manager.lock(target.profileId);
    await f.manager.unlockAsync(target.profileId, target.recoveryKit);
    assert.equal(
      getNote(f.manager.opened.get(target.profileId)!.db, 'patient').person.name,
      copy ? 'Fictional Private Copy' : 'Fictional New Profile',
    );
    clean(f, target.profileId);
    f.manager.lock(target.profileId);
  }
});

test('first-head refusal leaves original setup selected and retries unreferenced owned additions safely', async (t) => {
  let refuse = true;
  const f = await fixture(t, (phase) => {
    if (phase === 'publication' && refuse) throw Error('Fictional pre-head interruption');
  });
  const target = f.manager.begin({ name: 'Fictional Retry Copy', copyFrom: f.active.profileId }),
    path = resolve(f.manager.pathFor(target.profileId), 'vault/manifest.enc'),
    original = readFileSync(path);
  await assert.rejects(
    f.manager.verifyAsync(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
    /Fictional pre-head interruption/,
  );
  assert.deepEqual(readFileSync(path), original);
  assert.equal(f.manager.keyring(target.profileId).active, false);
  assert.equal(f.manager.opened.has(target.profileId), false);
  clean(f, target.profileId);
  refuse = false;
  await f.manager.verifyAsync(target.setupId, { acknowledged: true, recovery: target.recoveryKit });
  assert.equal(
    getNote(f.manager.opened.get(target.profileId)!.db, f.note.id).content,
    f.note.content,
  );
  clean(f, target.profileId);
});

test('held setup manifest refuses a same-byte replacement before publication and can retry', async (t) => {
  let targetId = '',
    replaced = false;
  const f = await fixture(t, (phase) => {
    if (phase !== 'publication' || replaced || !targetId) return;
    const profile = f.manager.pathFor(targetId),
      stage = readdirSync(profile).find((name) => name.startsWith('.setup-stage-'))!,
      manifest = resolve(profile, stage, 'profiles', targetId, 'vault/manifest.enc'),
      bytes = readFileSync(manifest);
    renameSync(manifest, manifest + '.replaced');
    writeFileSync(manifest, bytes, { mode: 0o600 });
    replaced = true;
  });
  const sourceRoot = resolve(f.manager.pathFor(f.active.profileId), 'vault'),
    before = ciphertextFiles(sourceRoot),
    target = f.manager.begin({
      name: 'Fictional held manifest',
      fullName: 'Fictional held manifest',
      birthDate: '1991-07-18',
    });
  targetId = target.profileId;
  await assert.rejects(
    f.manager.verifyAsync(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
    /Setup physical evidence changed/,
  );
  assert.equal(replaced, true);
  assert.equal(f.manager.opened.has(targetId), false);
  assert.equal(f.manager.keyring(targetId).active, false);
  assert.deepEqual(ciphertextFiles(sourceRoot), before);
  clean(f, targetId);
  await f.manager.verifyAsync(target.setupId, { acknowledged: true, recovery: target.recoveryKit });
  f.manager.lock(targetId);
  await f.manager.unlockAsync(targetId, target.recoveryKit);
  clean(f, targetId);
});

for (const retry of ['same-session', 'resumed-session'] as const)
  test(`accepted first head survives activation failure and ${retry} recovery does not recopy a later source head`, async (t) => {
    let publications = 0,
      refuse = true;
    const f = await fixture(t, (phase) => {
      if (phase === 'publication' && ++publications === 2 && refuse)
        throw Error('Fictional activation interruption');
    });
    const target = f.manager.begin({ name: 'Fictional Resume Copy', copyFrom: f.active.profileId }),
      path = resolve(f.manager.pathFor(target.profileId), 'vault/manifest.enc'),
      original = readFileSync(path);
    await assert.rejects(
      f.manager.verifyAsync(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
      /Fictional activation interruption/,
    );
    assert.notDeepEqual(readFileSync(path), original);
    assert.equal(f.manager.keyring(target.profileId).active, false);
    const later = createNote(f.source.db, {
      kind: 'note',
      title: 'Fictional later source',
      content: 'Must not enter the previously accepted copy.',
    });
    refuse = false;
    f.manager.lock(f.active.profileId);
    const resumed =
      retry === 'resumed-session' ? await f.manager.resumeAsync(target.recoveryKit) : target;
    assert.ok('setupId' in resumed);
    await f.manager.verifyAsync(resumed.setupId!, {
      acknowledged: true,
      recovery: target.recoveryKit,
    });
    const copied = f.manager.opened.get(target.profileId)!;
    assert.equal(getNote(copied.db, f.note.id).content, f.note.content);
    assert.throws(() => getNote(copied.db, later.id));
    clean(f, target.profileId);
  });

test('copy refuses equal-byte consumed source replacement before the first target head', async (t) => {
  let objectPath = '',
    bytes: Buffer | undefined;
  const f = await fixture(t, (phase) => {
    if (phase === 'publication' && bytes) writeFileSync(objectPath, bytes);
  });
  objectPath = resolve(
    f.manager.pathFor(f.active.profileId),
    'vault/objects',
    f.originalObject + '.enc',
  );
  bytes = readFileSync(objectPath);
  const target = f.manager.begin({
      name: 'Fictional Physical Refusal Copy',
      copyFrom: f.active.profileId,
    }),
    path = resolve(f.manager.pathFor(target.profileId), 'vault/manifest.enc'),
    original = readFileSync(path);
  await assert.rejects(
    f.manager.verifyAsync(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
    /physical evidence changed/,
  );
  assert.deepEqual(readFileSync(path), original);
  assert.equal(f.manager.opened.has(target.profileId), false);
  clean(f, target.profileId);
});

test('source lock cancels and drains private copy preparation without installing the target', async (t) => {
  const f = await fixture(t),
    target = f.manager.begin({ name: 'Fictional Cancelled Copy', copyFrom: f.active.profileId });
  let checks = 0;
  await assert.rejects(
    f.manager.verifyAsync(
      target.setupId,
      { acknowledged: true, recovery: target.recoveryKit },
      {
        authorizeCopySource() {
          if (++checks === 3) f.manager.lock(f.active.profileId);
        },
      },
    ),
    /Copy source|copy source|access changed/,
  );
  assert.equal(f.manager.opened.has(target.profileId), false);
  assert.equal(f.manager.keyring(target.profileId).active, false);
  clean(f, target.profileId);
});

test('copy retains the original source head and refuses a later accepted write before first publication', async (t) => {
  let mutate: (() => void) | undefined;
  const f = await fixture(t, (phase) => {
    if (phase === 'publication') mutate?.();
  });
  const target = f.manager.begin({
      name: 'Fictional Head Refusal Copy',
      copyFrom: f.active.profileId,
    }),
    path = resolve(f.manager.pathFor(target.profileId), 'vault/manifest.enc'),
    original = readFileSync(path);
  mutate = () => {
    mutate = undefined;
    createNote(f.source.db, {
      kind: 'note',
      title: 'Fictional concurrent accepted source write',
      content: 'Source remains serviceable; this new head cannot renew the copy proof.',
    });
  };
  await assert.rejects(
    f.manager.verifyAsync(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
    /Copy source changed/,
  );
  assert.deepEqual(readFileSync(path), original);
  assert.equal(f.manager.opened.has(target.profileId), false);
  assert.ok(f.manager.opened.has(f.active.profileId));
  clean(f, target.profileId);
});

test('HTTP private-copy activation serves the original session and refuses another session copy authority', async (t) => {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-setup-http-'));
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
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let cookie = '';
  async function request<T>(path: string, input?: unknown, originalSession = true) {
    const response = await fetch(url + path, {
      method: input ? 'POST' : 'GET',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Content-Type': 'application/json',
        ...(originalSession ? { Cookie: cookie } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    if (originalSession && response.headers.get('set-cookie'))
      cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { status: response.status, ...((await response.json()) as { data?: T }) };
  }
  await request('/api/profiles');
  const sourceSetup = (
    await request<{ setupId: string; recoveryKit: unknown }>('/api/profile-setups', {
      name: 'Fictional HTTP Source',
      fullName: 'Fictional HTTP Source',
      birthDate: '1986-02-09',
    })
  ).data!;
  const sourceResult = await request<{ id: string }>(
    `/api/profile-setups/${sourceSetup.setupId}/verify`,
    { acknowledged: true, recovery: sourceSetup.recoveryKit },
  );
  assert.equal(sourceResult.status, 201);
  const sourceId = sourceResult.data!.id,
    source = app.manager.opened.get(sourceId)!;
  const note = createNote(source.db, {
    kind: 'note',
    title: 'Fictional HTTP accepted copy evidence',
    content: 'Fictional copy content.',
  });
  for (let n = 0; n < 130; n++)
    source.vault.storeFile(
      `sources/fictional-http-${n}.txt`,
      Buffer.from(`Fictional HTTP original ${n}`),
    );
  source.vault.publish();
  const target = (
    await request<{ setupId: string; profileId: string; recoveryKit: unknown }>(
      '/api/profile-setups',
      { name: 'Fictional HTTP Copy', copyFrom: sourceId },
    )
  ).data!;
  const verification = { acknowledged: true, recovery: target.recoveryKit };
  assert.equal(
    (await request(`/api/profile-setups/${target.setupId}/verify`, verification, false)).status,
    423,
  );
  let finished = false;
  const pending = request<{ id: string }>(
    `/api/profile-setups/${target.setupId}/verify`,
    verification,
  ).finally(() => {
    finished = true;
  });
  await yieldHost();
  assert.equal((await request(`/api/profiles/${sourceId}/notes/${note.id}`)).status, 200);
  assert.equal(finished, false);
  const verified = await pending;
  assert.equal(verified.status, 201);
  assert.equal((await request(`/api/profiles/${sourceId}/notes/${note.id}`)).status, 423);
  const copied = await request<{ content: string }>(
    `/api/profiles/${verified.data!.id}/notes/${note.id}`,
  );
  assert.equal(copied.status, 200);
  assert.equal(copied.data!.content, note.content);
});

test('setup admitted before expiry finishes after its original window without renewing it', async (t) => {
  const f = await fixture(t);
  const now = Date.now;
  let elapsed = 0,
    checks = 0;
  t.mock.method(Date, 'now', () => now() + elapsed);
  const target = f.manager.begin({ name: 'Fictional admitted copy', copyFrom: f.active.profileId });
  const result = await f.manager.verifyAsync(
    target.setupId,
    { acknowledged: true, recovery: target.recoveryKit },
    {
      assertAuthorized() {
        checks++;
        elapsed = 31 * 60 * 1000;
      },
    },
  );
  assert.equal(result.id, target.profileId);
  assert.ok(checks > 1);
  clean(f, target.profileId);
  await assert.rejects(
    f.manager.verifyAsync(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
    { code: 'SETUP_EXPIRED' },
  );
});

test('first target manifest publication refuses an unrelated keyring replacement without deleting its committed head', async (t) => {
  const f = await fixture(t);
  const target = f.manager.begin({
    name: 'Fictional publication keyring refusal',
    copyFrom: f.active.profileId,
  });
  const manifest = resolve(f.manager.pathFor(target.profileId), 'vault/manifest.enc'),
    keyring = resolve(f.manager.pathFor(target.profileId), 'keyring.json'),
    originalManifest = readFileSync(manifest),
    originalKeyring = readFileSync(keyring);
  const rename = fs.renameSync;
  let changed = false;
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
    rename(...args);
    if (!changed && String(args[1]) === manifest && String(args[0]).includes('.setup-stage-')) {
      changed = true;
      writeFileSync(keyring, originalKeyring);
    }
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    f.manager.verifyAsync(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
    /Setup publication changed|preparation changed/,
  );
  assert.equal(changed, true);
  assert.notDeepEqual(
    readFileSync(manifest),
    originalManifest,
    'the already committed first head remains recovery authority',
  );
  assert.equal(f.manager.opened.has(target.profileId), false);
  assert.equal(f.manager.keyring(target.profileId).active, false);
  clean(f, target.profileId);
});
