import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setImmediate as yieldHost } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import type { AddressInfo } from 'node:net';
import {
  createEncryptedProfiles,
  type CreateEncryptedProfilesOptions,
} from '../encrypted-profiles.ts';
import { createNote, getNote } from '../notes.ts';
import { prepareEncryptedUnlock } from '../encrypted-profile-preparation.ts';
import { freshKey } from '../vault-crypto.ts';
import { createVaultApp } from '../vault-app.ts';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createImportDiagnostics, type ImportDiagnostics } from '../import-diagnostics.ts';

async function fixture(
  t: TestContext,
  checkpoint?: CreateEncryptedProfilesOptions['unlockCheckpoint'],
  diagnostics?: ImportDiagnostics,
) {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-unlock-cooperation-'));
  const dataDirectory = resolve(base, 'data'),
    runtimeDirectory = resolve(base, 'runtime');
  mkdirSync(dataDirectory);
  const manager = createEncryptedProfiles({
    dataDirectory,
    runtimeDirectory,
    unlockCheckpoint: checkpoint,
    diagnostics,
  });
  t.after(() => {
    manager.close();
    rmSync(base, { recursive: true, force: true });
  });
  const target = manager.begin({
    name: 'Fictional Recovery Target',
    fullName: 'Fictional Recovery Target',
    birthDate: '1982-04-17',
  });
  await manager.verify(target.setupId, { acknowledged: true, recovery: target.recoveryKit });
  const state = manager.opened.get(target.profileId)!;
  const unlockKey = Buffer.from(state.key);
  t.after(() => unlockKey.fill(0));
  const note = createNote(state.db, {
    kind: 'note',
    title: 'Fictional accepted evidence',
    content: 'Independently fictional recovery content',
  });
  for (let ordinal = 0; ordinal < 130; ordinal++)
    state.vault.storeFile(
      `sources/fictional-${ordinal}.txt`,
      Buffer.from(`Fictional original ${ordinal}`),
    );
  state.vault.publish();
  const originalObject = state.vault.metadata().files['sources/fictional-0.txt']!;
  manager.lock(target.profileId);
  const active = manager.begin({
    name: 'Fictional Current Profile',
    fullName: 'Fictional Current Profile',
    birthDate: '1984-06-12',
  });
  await manager.verify(active.setupId, { acknowledged: true, recovery: active.recoveryKit });
  return {
    manager,
    target,
    active,
    note,
    base,
    dataDirectory,
    runtimeDirectory,
    archive: resolve(dataDirectory, 'profiles', target.profileId),
    originalObject,
    unlockKey,
  };
}

function assertWitnessCleanup(runtime: string): void {
  assert.deepEqual(
    readdirSync(runtime).filter((name) => name.startsWith('.unlock-physical-')),
    [],
  );
}

test('runtime unlock cooperates through cache reuse and exact cache-loss recovery while another profile remains usable', async (t) => {
  let vaultTurns = 0;
  let turnPhysicalWork = 0,
    countPhysicalWork = false,
    maxPhysicalWork = 0;
  const f = await fixture(t, (phase) => {
    if (phase === 'vault') {
      vaultTurns++;
      maxPhysicalWork = Math.max(maxPhysicalWork, turnPhysicalWork);
      assert.ok(
        turnPhysicalWork <= 64,
        `Unbounded vault turn: ${turnPhysicalWork} physical entries`,
      );
      turnPhysicalWork = 0;
    }
  });
  const rawStat = fs.lstatSync;
  const mocked = t.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof rawStat>) => {
    const path = String(args[0]);
    if (countPhysicalWork && (path.includes('/vault/objects/') || path.includes('/vault/indices/')))
      turnPhysicalWork++;
    return rawStat(...args);
  }) as typeof rawStat);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  for (const cold of [false, true]) {
    if (cold) rmSync(resolve(f.archive, 'cache'), { recursive: true, force: true });
    const originalHead = readFileSync(resolve(f.archive, 'vault/manifest.enc'));
    let finished = false,
      hostTurns = 0;
    countPhysicalWork = true;
    const pending = f.manager.unlockAsync(f.target.profileId, f.target.recoveryKit).finally(() => {
      finished = true;
    });
    while (!finished) {
      assert.equal(
        getNote(f.manager.opened.get(f.active.profileId)!.db, 'patient').person.name,
        'Fictional Current Profile',
      );
      hostTurns++;
      await yieldHost();
    }
    const result = await pending;
    assertWitnessCleanup(f.runtimeDirectory);
    countPhysicalWork = false;
    assert.equal(result.metrics?.cacheHit, !cold);
    assert.ok(hostTurns > 1);
    assert.ok(vaultTurns > 1);
    assert.ok(maxPhysicalWork > 0 && maxPhysicalWork <= 64);
    const recoveryWork = f.manager.opened.get(f.target.profileId)!.recoveryWork!;
    assert.ok(recoveryWork.physicalWitnessEntries > 130);
    assert.equal(recoveryWork.physicalCheckedEntries, recoveryWork.physicalWitnessEntries);
    assert.ok(recoveryWork.physicalWitnessMetadataBytes > 0);
    assert.ok(recoveryWork.mainVaultCheckpoints > 1);
    assert.equal(recoveryWork.records.reconstruction.versionValidations > 0, cold);
    assert.deepEqual(readFileSync(resolve(f.archive, 'vault/manifest.enc')), originalHead);
    assert.equal(
      getNote(f.manager.opened.get(f.target.profileId)!.db, f.note.id).content,
      f.note.content,
    );
    assert.ok(f.manager.opened.has(f.active.profileId));
    f.manager.lock(f.target.profileId);
  }
});

test('worker cancellation drains before removing its workspace and preserves the current profile', async (t) => {
  const controller = new AbortController();
  let preparationTurns = 0;
  const f = await fixture(t, (phase) => {
    if (phase === 'preparation' && ++preparationTurns === 3)
      controller.abort(Error('Fictional cancellation'));
  });
  await assert.rejects(
    f.manager.unlockWithKeyAsync(f.target.profileId, f.unlockKey, { signal: controller.signal }),
    /Fictional cancellation/,
  );
  assert.equal(existsSync(resolve(f.runtimeDirectory, f.target.profileId)), false);
  await yieldHost();
  assert.equal(existsSync(resolve(f.runtimeDirectory, f.target.profileId)), false);
  assert.equal(f.manager.opened.has(f.target.profileId), false);
  assert.deepEqual(f.unlockKey, Buffer.alloc(32));
  assertWitnessCleanup(f.runtimeDirectory);
  assert.ok(f.manager.opened.has(f.active.profileId));
  await f.manager.unlockAsync(f.target.profileId, f.target.recoveryKit);
});

test('active worker cancellation drains and wipes the caller key before cleanup', async (t) => {
  const controller = new AbortController();
  let preparationTurns = 0;
  const f = await fixture(t, (phase) => {
    if (phase === 'preparation' && ++preparationTurns === 4)
      controller.abort(Error('Fictional active-work cancellation'));
  });
  await assert.rejects(
    f.manager.unlockWithKeyAsync(f.target.profileId, f.unlockKey, { signal: controller.signal }),
    /Fictional active-work cancellation/,
  );
  assert.deepEqual(f.unlockKey, Buffer.alloc(32));
  assertWitnessCleanup(f.runtimeDirectory);
  assert.equal(f.manager.opened.has(f.target.profileId), false);
  assert.equal(existsSync(resolve(f.runtimeDirectory, f.target.profileId)), false);
  assertWitnessCleanup(f.runtimeDirectory);
  assert.ok(f.manager.opened.has(f.active.profileId));
});

test('terminal physical seal refuses a consumed encrypted original replaced after validation with unchanged manifest', async (t) => {
  let objectPath = '',
    original: Buffer | undefined;
  const f = await fixture(t, (phase) => {
    if (phase === 'publication' && original) writeFileSync(objectPath, original);
  });
  objectPath = resolve(f.archive, 'vault/objects', f.originalObject + '.enc');
  original = readFileSync(objectPath);
  const manifest = readFileSync(resolve(f.archive, 'vault/manifest.enc'));
  await assert.rejects(
    f.manager.unlockAsync(f.target.profileId, f.target.recoveryKit),
    /physical evidence changed/,
  );
  assert.deepEqual(readFileSync(resolve(f.archive, 'vault/manifest.enc')), manifest);
  assert.equal(f.manager.opened.has(f.target.profileId), false);
  assert.equal(existsSync(resolve(f.runtimeDirectory, f.target.profileId)), false);
  assert.ok(f.manager.opened.has(f.active.profileId));
});

test('cache reuse still authenticates every deferred retained original in the worker', async (t) => {
  const f = await fixture(t);
  const object = resolve(f.archive, 'vault/objects', f.originalObject + '.enc');
  const original = readFileSync(object);
  const corrupt = Buffer.from(original);
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  writeFileSync(object, corrupt);
  await assert.rejects(f.manager.unlockAsync(f.target.profileId, f.target.recoveryKit));
  assert.equal(f.manager.opened.has(f.target.profileId), false);
  assert.equal(existsSync(resolve(f.runtimeDirectory, f.target.profileId)), false);
  assert.ok(f.manager.opened.has(f.active.profileId));
  writeFileSync(object, original);
  await f.manager.unlockAsync(f.target.profileId, f.target.recoveryKit);
});

test('diagnostic installation cancellation refuses admission before exposing the prepared target', async (t) => {
  const diagnostics = createImportDiagnostics({ enabled: false }),
    controller = new AbortController();
  const f = await fixture(t, undefined, diagnostics);
  t.after(() => diagnostics.close());
  let fired = false,
    eventAttachment = false,
    detached = false;
  const summary = diagnostics.attachSummaryStore.bind(diagnostics),
    events = diagnostics.attachEventStore.bind(diagnostics),
    detach = diagnostics.detachSummaryStore.bind(diagnostics);
  diagnostics.attachSummaryStore = (id, store) => {
    summary(id, store);
    if (id === f.target.profileId) {
      assert.equal(f.manager.opened.has(id), false);
      fired = true;
      controller.abort(Error('Fictional diagnostic installation cancellation'));
    }
  };
  diagnostics.attachEventStore = (id, store) => {
    if (id === f.target.profileId) eventAttachment = true;
    events(id, store);
  };
  diagnostics.detachSummaryStore = (id) => {
    if (id === f.target.profileId) detached = true;
    detach(id);
  };
  await assert.rejects(
    f.manager.unlockWithKeyAsync(f.target.profileId, f.unlockKey, { signal: controller.signal }),
    /Fictional diagnostic installation cancellation/,
  );
  assert.equal(fired, true);
  assert.equal(eventAttachment, false);
  assert.equal(detached, true);
  assert.equal(f.manager.opened.has(f.target.profileId), false);
  assert.deepEqual(f.unlockKey, Buffer.alloc(32));
  assert.equal(existsSync(resolve(f.runtimeDirectory, f.target.profileId)), false);
  assert.ok(f.manager.opened.has(f.active.profileId));
  assertWitnessCleanup(f.runtimeDirectory);
});

test('diagnostic installation cannot renew a consumed original replaced after worker validation', async (t) => {
  const diagnostics = createImportDiagnostics({ enabled: false }),
    f = await fixture(t, undefined, diagnostics);
  t.after(() => diagnostics.close());
  const objectPath = resolve(f.archive, 'vault/objects', f.originalObject + '.enc'),
    bytes = readFileSync(objectPath),
    summary = diagnostics.attachSummaryStore.bind(diagnostics);
  let fired = false;
  diagnostics.attachSummaryStore = (id, store) => {
    summary(id, store);
    if (id === f.target.profileId) {
      assert.equal(f.manager.opened.has(id), false);
      fired = true;
      writeFileSync(objectPath, bytes);
    }
  };
  await assert.rejects(
    f.manager.unlockAsync(f.target.profileId, f.target.recoveryKit),
    /physical evidence changed/,
  );
  assert.equal(fired, true);
  assert.equal(f.manager.opened.has(f.target.profileId), false);
  assert.ok(f.manager.opened.has(f.active.profileId));
  assertWitnessCleanup(f.runtimeDirectory);
});

test('fresh accepted setup remains inactive when preparatory diagnostic installation cancels activation', async (t) => {
  const diagnostics = createImportDiagnostics({ enabled: false }),
    f = await fixture(t, undefined, diagnostics),
    controller = new AbortController();
  t.after(() => diagnostics.close());
  const target = f.manager.begin({
      name: 'Fictional Diagnostic Cancelled Setup',
      fullName: 'Fictional Diagnostic Cancelled Setup',
      birthDate: '1990-06-03',
    }),
    summary = diagnostics.attachSummaryStore.bind(diagnostics);
  let cancel = true;
  diagnostics.attachSummaryStore = (id, store) => {
    summary(id, store);
    if (id === target.profileId && cancel) {
      assert.equal(f.manager.opened.has(id), false);
      controller.abort(Error('Fictional setup installation cancellation'));
    }
  };
  await assert.rejects(
    f.manager.verifyAsync(
      target.setupId,
      { acknowledged: true, recovery: target.recoveryKit },
      { signal: controller.signal },
    ),
    /Fictional setup installation cancellation/,
  );
  assert.equal(f.manager.keyring(target.profileId).active, false);
  assert.equal(f.manager.opened.has(target.profileId), false);
  assert.equal(
    f.manager.list().some((profile) => profile.id === target.profileId),
    false,
  );
  assertWitnessCleanup(f.runtimeDirectory);
  cancel = false;
  await f.manager.verifyAsync(target.setupId, { acknowledged: true, recovery: target.recoveryKit });
  assert.equal(f.manager.keyring(target.profileId).active, true);
  assert.ok(f.manager.opened.has(target.profileId));
});

test('publication refuses replacement of the prepared SQLite path after attachment', async (t) => {
  let dbPath = '',
    replaced = false;
  const f = await fixture(t, (phase) => {
    if (phase === 'publication' && !replaced) {
      replaced = true;
      renameSync(dbPath, dbPath + '.replaced');
      writeFileSync(dbPath, 'Fictional replacement');
    }
  });
  dbPath = resolve(f.runtimeDirectory, f.target.profileId, 'db/database.sqlite');
  await assert.rejects(
    f.manager.unlockAsync(f.target.profileId, f.target.recoveryKit),
    /preparation changed/,
  );
  assert.equal(replaced, true);
  assert.equal(f.manager.opened.has(f.target.profileId), false);
  assert.equal(existsSync(resolve(f.runtimeDirectory, f.target.profileId)), false);
  assert.ok(f.manager.opened.has(f.active.profileId));
});

test('publication refuses changed original encrypted authority rather than rebasing its proof', async (t) => {
  let manifestPath = '',
    original: Buffer | undefined;
  const f = await fixture(t, (phase) => {
    if (phase === 'publication' && original) {
      writeFileSync(manifestPath, original);
      original = undefined;
    }
  });
  manifestPath = resolve(f.archive, 'vault/manifest.enc');
  original = readFileSync(manifestPath);
  await assert.rejects(
    f.manager.unlockAsync(f.target.profileId, f.target.recoveryKit),
    /preparation changed/,
  );
  assert.equal(f.manager.opened.has(f.target.profileId), false);
  assert.ok(f.manager.opened.has(f.active.profileId));
});

test('a worker result followed by an unclean exit cannot authorize handoff', async () => {
  const key = freshKey();
  try {
    await assert.rejects(
      prepareEncryptedUnlock(
        {
          dataDirectory: '/fictional',
          runtimeDirectory: '/fictional-runtime',
          profileId: 'fictional',
          key,
          authority: { directory: 'fictional', manifest: 'fictional', keyring: 'fictional' },
          signal: new AbortController().signal,
          availableRuntimeBytes: null,
        },
        (workerData, transferList) =>
          new Worker(
            `
      const { parentPort, workerData } = require('node:worker_threads');
      workerData.key.fill(0);
      parentPort.once('message', () => {
      parentPort.postMessage({ prepared: { metrics: { cacheHit: false, loadMs: 0 }, storageBytes: 0,
        rootIdentity: 'fictional', databaseIdentity: 'fictional', selectedHead: 'fictional' } });
      process.exitCode = 1;
      parentPort.close();
      });
      parentPort.postMessage({ ready: true });
    `,
            { eval: true, workerData, transferList },
          ),
      ),
      /preparation failed/,
    );
  } finally {
    key.fill(0);
  }
});

test('HTTP activation serves the authorized current profile before the new unlock completes', async (t) => {
  const f = await fixture(t);
  f.manager.close();
  let url = '',
    cookie = '',
    activeId = '',
    unrelated: Promise<Response> | undefined;
  const app = createVaultApp({
    dataDirectory: f.dataDirectory,
    runtimeDirectory: f.runtimeDirectory,
    assistantOptions: { availability: async () => ({ available: false }) },
    unlockCheckpoint(phase) {
      if (phase === 'preparation' && activeId && !unrelated)
        unrelated = fetch(`${url}/api/profiles/${activeId}/notes/patient`, {
          headers: { Cookie: cookie },
        });
    },
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const unlock = (id: string, recovery: unknown) =>
    fetch(`${url}/api/profiles/${id}/unlock`, {
      method: 'POST',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ recovery }),
    });
  try {
    const opened = await unlock(f.active.profileId, f.active.recoveryKit);
    assert.equal(opened.status, 200);
    cookie = opened.headers.get('set-cookie')!.split(';')[0]!;
    activeId = f.active.profileId;
    let completed = false;
    const pending = unlock(f.target.profileId, f.target.recoveryKit).then((response) => {
      completed = true;
      return response;
    });
    while (!unrelated) await yieldHost();
    const current = await unrelated;
    assert.equal(current.status, 200);
    assert.equal(completed, false);
    assert.equal((await pending).status, 200);
  } finally {
    app.close();
  }
});
