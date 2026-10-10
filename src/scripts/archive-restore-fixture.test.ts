import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { assertArchiveInventory, inventoryArchive } from './archive-restore-copy.ts';
import { futureReleaseFixture, releaseArchiveFormats } from './release-update-fixture.ts';
import { LATEST_SCHEMA_VERSION } from '../server/database.ts';
import { createVaultApp } from '../server/vault-app.ts';
import {
  seedArchiveRestoreFixture,
  verifyArchiveRestoreFixture,
  type ArchiveRestoreRequest,
} from './archive-restore-fixture.ts';

test(
  'fictional restore oracle uses public acceptance and preserves review, Stop and exact evidence after cache loss',
  // Two encrypted cache rebuilds and exact evidence checks use real host work, with no model calls.
  { timeout: 120_000 },
  async (t) => {
    const base = mkdtempSync(resolve(tmpdir(), 'fictional-restore-oracle-'));
    const dataDirectory = resolve(base, 'data');
    mkdirSync(dataDirectory, { mode: 0o700 });
    let modelRequests = 0;
    const app = createVaultApp({
      dataDirectory,
      runtimeDirectory: resolve(base, 'runtime'),
      assistantOptions: {
        availability: () => ({ available: false, readiness: 'unavailable' }),
        connectionCheck: async () => ({ available: false, readiness: 'unavailable' }),
        bridgeFactory: () => {
          modelRequests++;
          throw new Error('Fictional restore fixture must not request a model');
        },
      },
    });
    t.after(() => {
      app.close();
      rmSync(base, { recursive: true, force: true });
    });
    await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    let cookie = '';
    const request: ArchiveRestoreRequest = async <T>(path: string, options = {}) => {
      const input: Parameters<ArchiveRestoreRequest>[1] = options;
      const response = await fetch(url + path, {
        method: input?.method || 'GET',
        headers: {
          Origin: 'http://localhost:5173',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(input?.json === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...input?.headers,
        },
        ...(input?.json === undefined ? {} : { body: JSON.stringify(input.json) }),
        ...(input?.bytes ? { body: new Uint8Array(input.bytes) } : {}),
        signal: t.signal,
      });
      if (response.headers.get('set-cookie'))
        cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      if (!response.ok) {
        const error = (await response.json()) as { error?: { code?: string } };
        throw new Error(
          `Fictional fixture API ${input?.method || 'GET'} ${path}: ${response.status} ${error.error?.code || ''}`,
        );
      }
      if (input?.binary) return Buffer.from(await response.arrayBuffer()) as T;
      return ((await response.json()) as { data: T }).data;
    };
    const seeded = await seedArchiveRestoreFixture(request);
    assert.equal(modelRequests, 0);
    await request(`/api/profiles/${seeded.profileId}/lock`, { method: 'POST', json: {} });
    const formats = releaseArchiveFormats(dataDirectory, seeded.recoveryKit);
    assert.deepEqual(formats, {
      registry: 'circus-health-profiles-v1',
      keyring: 'circus-health-keyring-v1',
      manifest: 'circus-health-vault-head-v2',
      index: 'circus-health-vault-index-delta-v2',
      history: 'health-record-versions-v2',
      acceptedHistorySchema: LATEST_SCHEMA_VERSION,
      encryptedFraming: 'CIRCUS01',
      recoveryKit: 'circus-health-recovery-v1',
      disposableCacheSchema: LATEST_SCHEMA_VERSION,
    });
    futureReleaseFixture(dataDirectory, seeded.recoveryKit, 'cache');
    assert.equal(
      releaseArchiveFormats(dataDirectory, seeded.recoveryKit).disposableCacheSchema,
      999999,
    );
    const recreated = await request<{ metrics: { cacheHit: boolean } }>(
      `/api/profiles/${seeded.profileId}/unlock`,
      { method: 'POST', json: { recovery: seeded.recoveryKit } },
    );
    assert.equal(recreated.metrics.cacheHit, false);
    await verifyArchiveRestoreFixture(request, seeded.oracle);
    await request(`/api/profiles/${seeded.profileId}/lock`, { method: 'POST', json: {} });
    assert.deepEqual(releaseArchiveFormats(dataDirectory, seeded.recoveryKit), formats);
    rmSync(resolve(dataDirectory, 'profiles', seeded.profileId, 'cache'), {
      recursive: true,
      force: true,
    });
    const unlocked = await request<{ metrics: { cacheHit: boolean } }>(
      `/api/profiles/${seeded.profileId}/unlock`,
      { method: 'POST', json: { recovery: seeded.recoveryKit } },
    );
    assert.equal(unlocked.metrics.cacheHit, false);
    assert.deepEqual(await verifyArchiveRestoreFixture(request, seeded.oracle), {
      people: 2,
      acceptedObservations: 2,
      originals: 5,
      notes: 1,
      attachments: 1,
      pendingReviews: 1,
      stoppedImports: 1,
    });
    assert.equal(modelRequests, 0);
    const corrupted = structuredClone(seeded.oracle);
    corrupted.originals[0]!.sha256 = '0'.repeat(64);
    await assert.rejects(verifyArchiveRestoreFixture(request, corrupted), {
      message: 'Fictional archive restore: exact original hash after restore',
    });
    await request(`/api/profiles/${seeded.profileId}/lock`, { method: 'POST', json: {} });
    futureReleaseFixture(dataDirectory, seeded.recoveryKit, 'manifest');
    const protectedFuture = await inventoryArchive(dataDirectory);
    await assert.rejects(
      request(`/api/profiles/${seeded.profileId}/unlock`, {
        method: 'POST',
        json: { recovery: seeded.recoveryKit },
      }),
      /ARCHIVE_UNSUPPORTED/,
    );
    await assertArchiveInventory(dataDirectory, protectedFuture);
  },
);
