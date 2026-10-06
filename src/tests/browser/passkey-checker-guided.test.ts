import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';

test('guided A/B/C: real IndexedDB resume, downloaded evidence and explicit clear preserve older rounds', async (t) => {
  const vite = await createViteServer({
    configFile: false,
    root: process.cwd(),
    publicDir: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  });
  const server = createHttpServer((req, res) => {
    if (req.url === '/fixture') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Controlled guided checker</title><div id="root"></div>',
      );
    } else
      vite.middlewares(req, res, () => {
        res.statusCode = 404;
        res.end();
      });
  });
  t.after(async () => {
    await vite.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, timeout: 15000 });
  t.after(() => browser.close());
  t.signal.addEventListener('abort', () => void browser.close(), { once: true });
  const page = await browser.newPage({
    viewport: { width: 414, height: 896 },
    acceptDownloads: true,
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture`);
  async function mount() {
    await page.evaluate(async () => {
      type FixtureModule = typeof import('../fixtures/passkey-checker-guided-browser');
      const path = '/src/tests/fixtures/passkey-checker-guided-browser.tsx';
      const { mountGuidedFixture } = (await import(path)) as FixtureModule;
      await mountGuidedFixture();
    });
  }
  async function settled() {
    await page.waitForFunction(() => {
      const fixture = (
        window as unknown as {
          fixture: { controller: { getSnapshot(): { busy: boolean; storage: string } } };
        }
      ).fixture;
      return (
        !fixture.controller.getSnapshot().busy &&
        fixture.controller.getSnapshot().storage === 'saved'
      );
    });
  }
  await mount();
  for (const name of [
    'Create A',
    'Verify A',
    'Create B — same username as A',
    'Verify B',
    'Create C — changed username',
    'Verify C',
  ]) {
    await page.getByRole('button', { name, exact: true }).click();
    await settled();
  }
  const before = await page.evaluate(() =>
    JSON.stringify(
      (
        window as unknown as { fixture: { controller: { exportModel(): unknown } } }
      ).fixture.controller.exportModel(),
    ),
  );
  await page.reload();
  await mount();
  await settled();
  const after = await page.evaluate(() =>
    JSON.stringify(
      (
        window as unknown as { fixture: { controller: { exportModel(): unknown } } }
      ).fixture.controller.exportModel(),
    ),
  );
  assert.equal(after, before, 'reopen preserves all three credential records and evidence');
  for (const name of [
    'Recheck A — final verification',
    'Recheck B — final verification',
    'Recheck C — final verification',
  ]) {
    await page.getByRole('button', { name, exact: true }).click();
    await settled();
  }
  await page.getByText('All three original credentials passed their final checks.').waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download this report', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path);
  const report = readFileSync(path, 'utf8');
  assert.match(report, /Report schema: 4/);
  assert.match(report, /all three final checks verified/);
  assert.match(report, /registration username matches A: false/);
  assert.doesNotMatch(report, /ciphertext":|"salt":|rawId|fictional-guided-run/);
  assert.equal(
    await page.getByRole('button', { name: 'Clear this run', exact: true }).isDisabled(),
    true,
  );
  await page.getByLabel('I have saved this report').check();
  await page.getByRole('button', { name: 'Clear this run', exact: true }).click();
  await settled();
  const cleared = await page.evaluate(async () => {
    type StoreModule = typeof import('../../app/passkey-checker/store.ts');
    const path = '/src/app/passkey-checker/store.ts';
    const { openCheckerStore } = (await import(path)) as StoreModule;
    const current = await openCheckerStore(indexedDB, 'fictional-guided-browser');
    const old = await openCheckerStore(indexedDB, 'fictional-previous-browser');
    const result = {
      current: (await current.load())!.state.attempts.length,
      old: (await old.load())!.state.run.id,
    };
    current.close();
    old.close();
    return result;
  });
  assert.equal(cleared.current, 0);
  assert.equal(cleared.old, 'fictional-guided-run');
  assert.deepEqual(errors, []);
});
