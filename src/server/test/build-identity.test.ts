import { createTestRuntimeDirectory } from './runtime-fixture.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createBuildIdentity, buildIdentityPlugin } from '../../scripts/build-identity.ts';
import { readBuildId } from '../build-identity.ts';
import { startRuntime } from '../runtime.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-build-identity-'));
  const runtimeDirectory = createTestRuntimeDirectory();
  mkdirSync(resolve(root, 'data'));
  t.after(() => {
    rmSync(runtimeDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    options: {
      codeRoot: root,
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
    },
  };
}
async function heartbeat(runtime: Awaited<ReturnType<typeof startRuntime>>, path = '/api/runtime') {
  const address = runtime.server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return (await response.json()) as { buildId: string | null; encrypted: boolean };
}
test('one generated artifact identity reaches bundled JS and survives server restart', async (t) => {
  const { root, options } = fixture(t),
    identity = createBuildIdentity();
  assert.notEqual(
    createBuildIdentity().buildId,
    identity.buildId,
    'a new build receives a new identity',
  );
  await build({
    configFile: false,
    logLevel: 'silent',
    define: { __CIRCUS_BUILD_ID__: JSON.stringify(identity.buildId) },
    plugins: [buildIdentityPlugin(identity)],
    build: {
      outDir: resolve(root, 'src/dist'),
      lib: {
        entry: fileURLToPath(new URL('../../app/data/build.ts', import.meta.url)),
        formats: ['es'],
        fileName: () => 'client.mjs',
      },
    },
  });
  const client = await import(pathToFileURL(resolve(root, 'src/dist/client.mjs')).href);
  assert.equal(client.CLIENT_BUILD_ID, identity.buildId);
  assert.equal(readBuildId(root), client.CLIENT_BUILD_ID);
  for (let start = 0; start < 2; start++) {
    const runtime = await startRuntime(options);
    try {
      for (const path of ['/api/runtime', '/health/ready']) {
        const status = await heartbeat(runtime, path);
        assert.equal(status.buildId, client.CLIENT_BUILD_ID);
        assert.equal(status.encrypted, true);
      }
    } finally {
      await runtime.close();
    }
  }
  const runtime = await startRuntime(options),
    next = createBuildIdentity();
  try {
    writeFileSync(resolve(root, 'src/dist/build-info.json'), JSON.stringify(next));
    assert.equal(
      (await heartbeat(runtime)).buildId,
      identity.buildId,
      'a running server retains its boot artifact identity',
    );
  } finally {
    await runtime.close();
  }
  const restarted = await startRuntime(options);
  try {
    assert.equal((await heartbeat(restarted)).buildId, next.buildId);
  } finally {
    await restarted.close();
  }
});
test('unbuilt or invalid manifests are explicitly unknown, never a freshly generated identity', async (t) => {
  const { root, options } = fixture(t);
  assert.equal(readBuildId(root), null);
  const runtime = await startRuntime(options);
  try {
    assert.equal((await heartbeat(runtime)).buildId, null);
  } finally {
    await runtime.close();
  }
  mkdirSync(resolve(root, 'src/dist'), { recursive: true });
  for (const contents of [
    '{broken',
    '{}',
    '{"buildId":""}',
    '{"buildId":"untrusted non-identity text"}',
  ]) {
    writeFileSync(resolve(root, 'src/dist/build-info.json'), contents);
    assert.equal(readBuildId(root), null);
  }
});
