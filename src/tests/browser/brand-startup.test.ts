import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startRuntime } from '../../server/runtime.ts';

test('startup branding follows saved appearance across cold load and keyboard entry', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-brand-startup-'));
  mkdirSync(resolve(root, 'data'));
  const runtimeDirectory = createTestRuntimeDirectory();
  const runtime = await startRuntime({
    dataDirectory: resolve(root, 'data'),
    runtimeDirectory,
    port: 0,
    host: '127.0.0.1',
    assistantOptions: {
      availability: () => ({
        available: false,
        backend: 'litellm',
        model: 'fictional-brand-test',
        readiness: 'unavailable',
        capabilities: { tools: null, images: null },
      }),
    },
  });
  t.after(async () => {
    await runtime.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1280, height: 850 },
    colorScheme: 'light',
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
  const visuals = process.env.HEALTH_BRAND_VISUAL_DIR;
  if (visuals) {
    assert(!resolve(visuals).startsWith(fileURLToPath(new URL('../../../', import.meta.url))));
    mkdirSync(visuals, { recursive: true });
  }

  await page.goto(url);
  assert.equal(
    await page.evaluate(async () => (await (await fetch('/api/runtime')).json()).encrypted),
    true,
    'the isolated browser fixture uses the encrypted native runtime',
  );
  await page.getByRole('heading', { name: 'Circus Health' }).waitFor();
  assert.equal(await page.getByText('Your circus, your monkeys, all under one tent.').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Create profile', exact: true }).count(), 1);
  assert((await page.locator('.profile-startup-logo').boundingBox())!.width >= 124);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.match(
    (await page.locator('#app-favicon').getAttribute('href'))!,
    /^\/favicon-light\.svg\?v=/,
  );
  assert.match(
    (await page.locator('#fallback-favicon').getAttribute('href'))!,
    /^\/favicon\.ico\?v=/,
  );
  assert.match(
    (await page.locator('#apple-touch-icon').getAttribute('href'))!,
    /^\/apple-touch-icon\.png\?v=/,
  );
  assert.match(
    (await page.locator('#app-manifest').getAttribute('href'))!,
    /^\/site\.webmanifest\?v=/,
  );

  if (visuals)
    await page.screenshot({
      path: resolve(visuals, 'startup-light-desktop.png'),
      animations: 'disabled',
    });

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.match(
    (await page.locator('#app-favicon').getAttribute('href'))!,
    /^\/favicon-dark\.svg\?v=/,
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');

  const create = page.getByRole('button', { name: 'Create profile', exact: true });
  await create.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Create profile', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Dark' }).check();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.match(
    (await page.locator('#app-favicon').getAttribute('href'))!,
    /^\/favicon-dark\.svg\?v=/,
  );
  if (visuals)
    await page.screenshot({
      path: resolve(visuals, 'startup-dark-desktop.png'),
      animations: 'disabled',
    });

  await page.reload();
  await page.getByRole('heading', { name: 'Circus Health' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.match(
    (await page.locator('#app-favicon').getAttribute('href'))!,
    /^\/favicon-dark\.svg\?v=/,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('radio', { name: 'Light' }).check();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (visuals)
    await page.screenshot({
      path: resolve(visuals, 'startup-light-mobile.png'),
      animations: 'disabled',
    });
  await page.getByRole('radio', { name: 'Dark' }).check();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (visuals)
    await page.screenshot({
      path: resolve(visuals, 'startup-dark-mobile.png'),
      animations: 'disabled',
    });

  const manifest = await page.evaluate(async () => {
    const response = await fetch('/site.webmanifest');
    return { contentType: response.headers.get('content-type'), body: await response.json() };
  });
  assert.equal(manifest.contentType, 'application/manifest+json');
  assert.deepEqual(
    manifest.body.icons.map((icon: { sizes: string; purpose: string }) => [
      icon.sizes,
      icon.purpose,
    ]),
    [
      ['192x192', 'any'],
      ['512x512', 'any'],
    ],
  );
  assert.deepEqual(errors, []);
});
