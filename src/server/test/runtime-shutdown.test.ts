import { createTestRuntimeDirectory } from './runtime-fixture.ts';
import test, { type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { StorageLock } from '../storage-lock.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRuntime } from '../runtime.ts';
import { acquireStorageLock } from '../storage-lock.ts';

async function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-shutdown-')),
    dataDirectory = resolve(root, 'data');
  mkdirSync(dataDirectory);
  let lease!: StorageLock;
  const runtimeDirectory = createTestRuntimeDirectory();
  const runtime = await startRuntime({
    dataDirectory,
    runtimeDirectory,
    port: 0,
    host: '127.0.0.1',
    lockFactory: async (directory) => {
      lease = await acquireStorageLock(directory);
      return lease;
    },
  });
  t.after(async () => {
    await runtime.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { runtime, lease, dataDirectory };
}
test(
  'encrypted runtime exposes lock loss as failure after closing the server and releasing the writer',
  { timeout: 10000 },
  async (t) => {
    const { runtime, lease, dataDirectory } = await fixture(t),
      port = (runtime.server.address() as AddressInfo).port;
    process.kill(lease.pid!, 'SIGKILL');
    const stopped = await runtime.closed;
    assert.deepEqual(stopped, { ready: false, outcome: 'failure', phase: 'writer_lock' });
    assert.equal(runtime.server.listening, false);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/runtime`));
    const next = await acquireStorageLock(dataDirectory);
    await next.release();
  },
);
test(
  'concurrent encrypted runtime close calls share the completed writer release',
  { timeout: 10000 },
  async (t) => {
    const { runtime, dataDirectory } = await fixture(t);
    const first = runtime.close(),
      second = runtime.close();
    assert.equal(first, second);
    await first;
    assert.equal((await runtime.closed).outcome, 'success');
    const next = await acquireStorageLock(dataDirectory);
    await next.release();
  },
);
