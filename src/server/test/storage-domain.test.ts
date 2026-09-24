import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireStorageLock } from '../storage-lock.ts';
function directory(t: TestContext) {
  const p = mkdtempSync(resolve(tmpdir(), 'health-domain-'));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  return p;
}
test('persistent domains exclude a different OS even after its independent kernel lease is released', async (t) => {
  const path = directory(t),
    linux = await acquireStorageLock(path, { domain: 'linux' });
  await linux.release();
  await assert.rejects(acquireStorageLock(path, { domain: 'darwin' }), /reserved for linux/);
  const restarted = await acquireStorageLock(path, { domain: 'linux' });
  await restarted.release();
  assert.equal(readFileSync(resolve(path, '.health-writer-domain'), 'utf8'), 'linux\n');
});
test('a malformed domain blocks startup without rewriting its evidence', async (t) => {
  const path = directory(t);
  writeFileSync(resolve(path, '.health-writer-domain'), 'unrecognized\n');
  await assert.rejects(acquireStorageLock(path), /Invalid storage writer domain/);
  assert.equal(readFileSync(resolve(path, '.health-writer-domain'), 'utf8'), 'unrecognized\n');
});
test(
  'Darwin-to-Docker handoff requires an idle host lease and stays Linux-owned afterwards',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const path = directory(t),
      host = await acquireStorageLock(path);
    await assert.rejects(
      acquireStorageLock(path, { domain: 'linux', allowSwitchFrom: 'darwin' }),
      /active writer/,
    );
    assert.equal(readFileSync(resolve(path, '.health-writer-domain'), 'utf8'), 'darwin\n');
    await host.release();
    const launcher = await acquireStorageLock(path, { domain: 'linux', allowSwitchFrom: 'darwin' });
    await launcher.release();
    await assert.rejects(acquireStorageLock(path), /reserved for linux/);
  },
);
