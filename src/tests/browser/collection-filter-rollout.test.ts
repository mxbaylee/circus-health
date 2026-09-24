import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { Browser } from 'playwright';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startRuntime } from '../../server/runtime.ts';

test(
  'collection pages share the saved-filter editor in an encrypted mobile app',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-collection-filters-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startRuntime({
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
    });
    let browser: Browser | undefined;
    t.after(async () => {
      await browser?.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(url);
    await page.evaluate(async () => {
      async function api(path: string, body?: unknown) {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(`Fictional profile setup failed: ${response.status}`);
        return (await response.json()).data;
      }
      const setup = await api('/api/profile-setups', {
        name: 'Fictional collection filter test',
        placebo: true,
      });
      await api(`/api/profile-setups/${setup.setupId}/verify`, {
        acknowledged: true,
        recovery: setup.recoveryKit,
      });
    });
    await page.reload();

    const pages = [
      ['/notes', 'Search notes'],
      ['/notes?kind=historical', 'Search historical notes'],
      ['/tests', 'Search results'],
      ['/medications', 'Search prescriptions'],
      ['/procedures', 'Search procedures'],
      ['/sources', 'Search source files'],
    ];
    for (const [route, searchLabel] of pages) {
      await page.goto(`${url}/#${route}`);
      await page.getByRole('textbox', { name: searchLabel }).waitFor();
      const pills = page.getByRole('list', { name: 'Saved filters' });
      await pills.getByText('Active', { exact: true }).waitFor();
      await pills.getByRole('button', { name: 'Edit Active' }).click();
      const panel = page.getByRole('region', { name: 'Filter conditions' });
      await panel.waitFor();
      assert.equal(await page.getByRole('button', { name: /^Filters/ }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Save filter' }).isDisabled(), true);
      const bounds = await panel.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await panel.waitFor();
      await page.getByRole('button', { name: /Filters/ }).click();
      await panel.waitFor({ state: 'hidden' });
    }

    const visuals = process.env.HEALTH_COLLECTION_FILTER_VISUAL_DIR;
    if (visuals) {
      assert(!resolve(visuals).startsWith(fileURLToPath(new URL('../../../', import.meta.url))));
      mkdirSync(visuals, { recursive: true });
      for (const [route, searchLabel] of pages) {
        const slug = route
          .replace(/^\//, '')
          .replace('?kind=historical', '-historical')
          .replaceAll('/', '-');
        await page.goto(`${url}/#${route}`);
        await page.getByRole('textbox', { name: searchLabel }).waitFor();
        await page
          .getByRole('list', { name: 'Saved filters' })
          .getByRole('button', { name: 'Edit Active' })
          .click();
        for (const theme of ['light', 'dark']) {
          await page.evaluate((nextTheme) => {
            localStorage.setItem('circus-health-theme', nextTheme);
            window.dispatchEvent(new StorageEvent('storage', { key: 'circus-health-theme' }));
          }, theme);
          await page.waitForFunction(
            (nextTheme) => document.documentElement.dataset.theme === nextTheme,
            theme,
          );
          for (const [size, viewport] of [
            ['desktop', { width: 1280, height: 900 }],
            ['mobile', { width: 390, height: 844 }],
          ] as const) {
            await page.setViewportSize(viewport);
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.screenshot({
              path: resolve(visuals, `${slug}-${theme}-${size}.png`),
              animations: 'disabled',
            });
          }
        }
      }
    }
    assert.deepEqual(errors, []);
  },
);
