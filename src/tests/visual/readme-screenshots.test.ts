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

const screenshotDirectory = fileURLToPath(new URL('../../../docs/images/', import.meta.url));

test('generate README screenshots from a fresh encrypted fictional profile', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-readme-'));
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
        model: 'fictional-readme-model',
        readiness: 'unavailable',
        capabilities: { tools: null, images: null },
      }),
    },
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await runtime.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  mkdirSync(screenshotDirectory, { recursive: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1024 },
    colorScheme: 'light',
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;

  await page.goto(url);
  await page.evaluate(async () => {
    const post = async (path: string, body: unknown) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Fictional profile setup failed: ${response.status}`);
      return (await response.json()).data;
    };
    const setup = await post('/api/profile-setups', {
      name: 'Fictional Rowan',
      placebo: true,
    });
    await post(`/api/profile-setups/${setup.setupId}/verify`, {
      acknowledged: true,
      recovery: setup.recoveryKit,
    });
  });
  await page.reload();
  await page.getByRole('link', { name: 'Test results', exact: true }).click();
  await page.getByRole('heading', { name: 'Test results', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'By test', exact: true }).click();
  await page
    .getByRole('region', { name: 'Test types' })
    .getByRole('button', { name: /Ferritin/ })
    .click();
  const detail = page.getByRole('region', { name: 'Selected result' });
  await detail.getByRole('heading', { name: 'Ferritin', exact: true, level: 2 }).waitFor();
  await detail.getByRole('button', { name: 'View source' }).waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await detail.locator('.detail-chart').screenshot({
    path: resolve(screenshotDirectory, 'readme-test-history.png'),
    animations: 'disabled',
  });

  await detail.getByRole('button', { name: 'View source' }).click();
  const source = page.getByRole('dialog', { name: 'Source evidence' });
  await source.getByText('The original evidence remains canonical.').waitFor();
  await source.getByText(/Ferritin/).waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({
    path: resolve(screenshotDirectory, 'readme-source-evidence.png'),
    animations: 'disabled',
  });

  assert.deepEqual(errors, []);
});
