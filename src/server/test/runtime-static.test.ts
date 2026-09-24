import { createTestRuntimeDirectory } from './runtime-fixture.ts';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { startRuntime } from '../runtime.ts';

test('runtime serves module workers as JavaScript without weakening static protections', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'circus-static-test-'));
  const dist = join(root, 'src/dist');
  mkdirSync(dist, { recursive: true });
  mkdirSync(join(root, 'data'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Fictional app</title>');
  const module = 'export const fictional = true;';
  writeFileSync(join(dist, 'pdf.worker.min-test.mjs'), module);
  writeFileSync(join(dist, 'site.webmanifest'), '{"name":"Fictional app"}');
  writeFileSync(join(root, 'outside.txt'), 'must remain private');
  symlinkSync(join(root, 'outside.txt'), join(dist, 'escape.mjs'));
  const runtimeDirectory = createTestRuntimeDirectory();
  const runtime = await startRuntime({
    codeRoot: root,
    dataDirectory: join(root, 'data'),
    runtimeDirectory,
    port: 0,
    host: '127.0.0.1',
  });
  t.after(async () => {
    await runtime.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
  assert.equal((await (await fetch(`${url}/api/runtime`)).json()).encrypted, true);
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(`${url}/pdf.worker.min-test.mjs`, { method });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(module)));
    assert.equal(await response.text(), method === 'GET' ? module : '');
  }
  assert.equal(
    (await fetch(`${url}/site.webmanifest`)).headers.get('content-type'),
    'application/manifest+json',
  );
  assert.equal((await fetch(`${url}/escape.mjs`)).status, 404);
  assert.equal((await fetch(`${url}/pdf.worker.min-test.mjs`, { method: 'POST' })).status, 405);
  assert.equal(
    await new Promise((resolve, reject) => {
      get(`${url}/pdf.worker.min-test.mjs`, { headers: { Host: 'foreign.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    }),
    403,
  );
});
