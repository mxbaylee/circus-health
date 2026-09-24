import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  archiveStorageTotals,
  importStorageEstimate,
  assertImportCapacity,
} from '../archive-storage.ts';
import { createVaultApp } from '../vault-app.ts';

function fixture(t: TestContext) {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-archive-accounting-')),
    data = resolve(base, 'data'),
    runtime = resolve(base, 'runtime');
  mkdirSync(data);
  mkdirSync(runtime);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  function file(path: string, bytes: number) {
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes));
  }
  return { base, data, runtime, file };
}
test('archive accounting separates registered profiles, retained backups, orphaned legacy directories and runtime', (t) => {
  const { data, runtime, file } = fixture(t);
  file(resolve(data, 'profiles/fictional-a/vault.enc'), 17);
  file(resolve(data, 'profiles/fictional-b/vault.enc'), 19);
  file(resolve(data, 'profiles/old-profile/legacy'), 23);
  file(resolve(data, 'backups/deleted-profile/package'), 31);
  file(resolve(data, 'profiles.json'), 7);
  file(resolve(runtime, 'working.sqlite'), 211);
  const totals = archiveStorageTotals(data, ['fictional-a', 'fictional-b'], runtime);
  assert.equal(totals.status, 'measured');
  assert.equal(totals.profileBytes, 36);
  assert.equal(totals.otherArchiveBytes, 61);
  assert.equal(totals.storedBytes, 97);
  assert.equal(totals.runtimeBytes, 211);
  assert.equal(totals.profileBytes + totals.otherArchiveBytes, totals.storedBytes);
  const publicText = JSON.stringify(totals);
  for (const privateName of ['fictional-a', 'fictional-b', 'deleted-profile', 'working.sqlite'])
    assert(!publicText.includes(privateName));
});
test('external links are never followed and partial totals are not claimed complete', (t) => {
  const { base, data, runtime, file } = fixture(t);
  file(resolve(data, 'original.enc'), 13);
  file(resolve(base, 'external/private'), 99);
  symlinkSync(resolve(base, 'external'), resolve(data, 'backup-link'));
  const totals = archiveStorageTotals(data, [], runtime);
  assert.equal(totals.status, 'partial');
  assert.equal(totals.storedBytes, 13);
});
test('import estimates distinguish originals, staging and unknown quota; malformed sizes rejected', (t) => {
  const { data, runtime } = fixture(t),
    estimate = importStorageEstimate('1000000', data, runtime);
  assert(estimate.originalStorageEstimateBytes > 1000000);
  assert(estimate.runtimePlanningBytes >= 2000000 + 100 * 1024 * 1024);
  assert.equal(estimate.archive.quotaStatus, 'unknown');
  assert.equal(estimate.runtime.quotaStatus, 'unknown');
  const unknown = importStorageEstimate('0', '/nonexistent-circus-fixture', runtime);
  assert.equal(unknown.archive.reportedAvailableBytes, null);
  assert.equal(unknown.runtimePlanningBytes, 0);
  for (const invalid of [null, '-1', '1.2', 'Infinity', '9007199254740992', '1e9'])
    assert.throws(
      () => importStorageEstimate(invalid, data, runtime),
      (error) => (error as Error & { code?: string }).code === 'IMPORT_SIZE',
    );
});
test('upload admission refuses known insufficient capacity and preserves unknown-capacity semantics', (t) => {
  const { data, runtime } = fixture(t);
  const estimate = importStorageEstimate('1048576', data, runtime);
  const enough = {
    ...estimate,
    runtime: { ...estimate.runtime, reportedAvailableBytes: estimate.runtimePlanningBytes },
    // Even zero archive space is not proof that a duplicate needs a new object.
    archive: { ...estimate.archive, reportedAvailableBytes: 0 },
  };
  assert.doesNotThrow(() => assertImportCapacity(enough));
  for (const available of [
    0,
    estimate.originalBytes - 1,
    estimate.originalBytes,
    estimate.runtimePlanningBytes - 1,
  ]) {
    const refused = {
      ...enough,
      runtime: { ...enough.runtime, reportedAvailableBytes: available },
    };
    assert.throws(
      () => assertImportCapacity(refused),
      (error: unknown) =>
        error instanceof Error &&
        'status' in error &&
        error.status === 507 &&
        'code' in error &&
        error.code === 'IMPORT_CAPACITY' &&
        error.message.includes('runtime') &&
        error.message.includes('No original was retained'),
    );
  }
  assert.doesNotThrow(() =>
    assertImportCapacity({
      ...enough,
      runtime: { ...enough.runtime, reportedAvailableBytes: null },
      archive: { ...enough.archive, reportedAvailableBytes: null },
    }),
  );
  assert.throws(
    () =>
      assertImportCapacity(importStorageEstimate(String(1024 * 1024 * 1024 + 1), data, runtime)),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'FILE_SIZE' &&
      /MiB upload limit/.test(error.message),
  );
});
test('locked clients see aggregate storage but cannot query profile import capacity or content categories', async (t) => {
  const { data, runtime } = fixture(t),
    app = createVaultApp({ dataDirectory: data, runtimeDirectory: runtime });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(() => app.close());
  const setup = app.manager.begin({
      name: 'Fictional Accounting Person',
      fullName: 'Fictional Accounting Person',
      birthDate: '1982-04-17',
    }),
    profile = await app.manager.verify(setup.setupId, {
      acknowledged: true,
      recovery: setup.recoveryKit,
    });
  app.manager.lock(profile.id);
  const address = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const response = await fetch(url + '/api/storage/archive');
  assert.equal(response.status, 200);
  const totals = ((await response.json()) as { data: { profileBytes: number } }).data;
  assert(totals.profileBytes > 0);
  assert(!JSON.stringify(totals).includes('Fictional Accounting Person'));
  for (const suffix of ['storage', 'storage/import-estimate?bytes=100'])
    assert.equal((await fetch(`${url}/api/profiles/${profile.id}/${suffix}`)).status, 423);
});

test('encrypted upload admission rejects an oversized advertised length before any body bytes', async (t) => {
  const baseDirectory = mkdtempSync(resolve(tmpdir(), 'circus-upload-admission-'));
  const data = resolve(baseDirectory, 'data'),
    runtime = resolve(baseDirectory, 'runtime');
  mkdirSync(data);
  mkdirSync(runtime);
  const app = createVaultApp({ dataDirectory: data, runtimeDirectory: runtime });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(() => {
    app.close();
    rmSync(baseDirectory, { recursive: true, force: true });
  });
  const setup = app.manager.begin({
    name: 'Fictional Capacity Profile',
    fullName: 'Fictional Capacity Person',
    birthDate: '1982-04-17',
  });
  const profile = await app.manager.verify(setup.setupId, {
    acknowledged: true,
    recovery: setup.recoveryKit,
  });
  app.manager.lock(profile.id);
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const unlocked = await fetch(`${base}/api/profiles/${profile.id}/unlock`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
    body: JSON.stringify({ recovery: setup.recoveryKit }),
  });
  assert.equal(unlocked.status, 200);
  await unlocked.arrayBuffer();
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      `${base}/api/profiles/${profile.id}/intakes`,
      {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:5173',
          Cookie: unlocked.headers.get('set-cookie')!.split(';')[0]!,
          'Content-Type': 'application/pdf',
          'Content-Length': String(1024 * 1024 * 1024 + 1),
          'X-Filename': 'fictional-too-large.pdf',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() });
          req.destroy();
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(Error('Upload admission waited for body bytes')));
    // Deliberately never send a body: admission must be possible from headers.
    req.flushHeaders();
  });
  assert.equal(result.status, 413);
  assert.equal(JSON.parse(result.body).error.code, 'FILE_SIZE');
  assert.match(JSON.parse(result.body).error.message, /MiB upload limit/);
  assert.equal(
    app.manager.opened.get(profile.id)!.db.prepare('SELECT count(*) n FROM source_files').get()!.n,
    0,
  );
});
