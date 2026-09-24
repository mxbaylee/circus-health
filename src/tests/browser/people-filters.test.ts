import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
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
  'People saved rules preserve applied results and URL history in an encrypted fictional profile',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-people-filters-'));
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
          model: 'fictional-browser-alias',
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    async function api(path: string, method = 'GET', data?: unknown) {
      const response = await page.evaluate(
        async ({ path, method, data }) => {
          const response = await fetch(path, {
            method,
            headers: data ? { 'Content-Type': 'application/json' } : {},
            ...(data ? { body: JSON.stringify(data) } : {}),
          });
          return { status: response.status, body: await response.json() };
        },
        { path, method, data },
      );
      assert(response.status < 300, `${method} ${path}: ${response.status}`);
      return response.body.data;
    }
    async function capture(prefix: string) {
      const visuals = process.env.HEALTH_PEOPLE_VISUAL_DIR;
      if (!visuals) return;
      assert(!resolve(visuals).startsWith(fileURLToPath(new URL('../../../', import.meta.url))));
      mkdirSync(visuals, { recursive: true });
      for (const theme of ['light', 'dark'])
        for (const [size, viewport] of [
          ['desktop', { width: 1280, height: 900 }],
          ['mobile', { width: 390, height: 844 }],
        ] as const) {
          await page.setViewportSize(viewport);
          await page.evaluate((theme) => {
            localStorage.setItem('circus-health-theme', theme);
            window.dispatchEvent(new StorageEvent('storage', { key: 'circus-health-theme' }));
          }, theme);
          await page.waitForFunction(
            (theme) => document.documentElement.dataset.theme === theme,
            theme,
          );
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({
            path: resolve(visuals, `${prefix}-${theme}-${size}.png`),
            animations: 'disabled',
          });
        }
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await page.goto(url);
    assert.equal(
      await page.evaluate(async () => (await (await fetch('/api/runtime')).json()).encrypted),
      true,
    );
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    await page.getByLabel('Display name', { exact: true }).fill('Fictional Shortbread');
    await page.getByRole('button', { name: 'Continue to recovery key' }).click();
    const recovery = await page.getByLabel('Recovery key', { exact: true }).inputValue();
    await page.getByLabel('I have saved my recovery key').check();
    await page.getByRole('button', { name: 'Verify recovery key', exact: true }).click();
    await page.getByLabel('Recovery key').fill(recovery);
    await page.getByRole('button', { name: 'Open profile' }).click();
    await page
      .getByRole('dialog', { name: /^Add passkey for / })
      .getByRole('button', { name: 'Skip', exact: true })
      .click();
    for (const step of ['About you', 'Primary care provider', 'Emergency contact']) {
      await page
        .getByRole('dialog', { name: 'A little about you' })
        .getByRole('heading', { name: step, exact: true })
        .waitFor();
      await page
        .getByRole('dialog', { name: 'A little about you' })
        .getByRole('button', { name: 'Skip for now' })
        .click();
    }
    const profile = (await api('/api/profiles')).find(
      (profile: { id: string; name: string }) => profile.name === 'Fictional Shortbread',
    );
    for (const [title, lifeStatus] of [
      ['Fictional Biscuit', 'alive'],
      ['Fictional Macaron', 'deceased'],
    ])
      await api(`/api/profiles/${profile.id}/notes`, 'POST', {
        kind: 'person',
        title,
        person: { name: title, lifeStatus, tags: ['Family'] },
      });
    await page.goto(`${url}/#/people`);
    const results = page.locator('.notes-results');
    await results.getByText('Fictional Biscuit', { exact: true }).waitFor();
    await results.getByText('Fictional Macaron', { exact: true }).waitFor();
    assert.equal(await results.getByText('Fictional Shortbread', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Edit Active' }).click();
    assert(await page.getByRole('switch', { name: 'Active' }).isChecked());
    assert.equal(await page.getByRole('combobox', { name: 'Filter operator' }).count(), 0);
    await capture('people-active-toggle');
    await page.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await page.getByRole('region', { name: 'Filter conditions' }).count(), 1);
    assert(await page.getByRole('button', { name: 'Add filter' }).isEnabled());
    await page.getByRole('button', { name: 'Filters, 1 active' }).click();
    assert.equal(await page.getByRole('region', { name: 'Filter conditions' }).count(), 0);
    await page.getByRole('button', { name: 'Filters, 1 active' }).click();
    await page.getByRole('button', { name: 'Add filter' }).click();
    await page.getByRole('combobox', { name: 'Filter field' }).selectOption('lifeStatus');
    await page.getByRole('checkbox', { name: 'Alive', exact: true }).check();
    assert.equal(await results.getByText('Fictional Macaron', { exact: true }).count(), 1);
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).has('filters'), false);
    await capture('people-editor');
    await page.getByRole('button', { name: 'Save filter' }).click();
    await page.getByText('Life status includes Alive', { exact: true }).waitFor();
    await results.getByText('Fictional Macaron', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('region', { name: 'Filter conditions' }).count(), 1);
    assert(await page.getByRole('button', { name: 'Add filter' }).isEnabled());
    assert(
      await page
        .getByRole('button', { name: 'Filters, 2 active' })
        .evaluate((el) => el === document.activeElement),
    );
    await capture('people-pills');
    await page.goBack();
    await results.getByText('Fictional Macaron', { exact: true }).waitFor();
    await page.goForward();
    await results.getByText('Fictional Macaron', { exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Edit Life status includes Alive' }).click();
    assert(
      await page
        .getByRole('combobox', { name: 'Filter field' })
        .evaluate((el) => el === document.activeElement),
    );
    assert(await page.getByRole('button', { name: 'Add filter' }).isDisabled());
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('region', { name: 'Filter conditions' }).count(), 1);
    await page.getByRole('button', { name: 'Filters, 2 active' }).click();
    assert.equal(await page.getByRole('region', { name: 'Filter conditions' }).count(), 0);
    assert.deepEqual(errors, []);
  },
);
