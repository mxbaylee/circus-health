import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { Browser } from 'playwright';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startRuntime } from '../../server/runtime.ts';

test(
  'encrypted prescription activation restores prior filters on Done and Skip',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-prescription-filters-'));
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(url);
    const setupResult = await page.evaluate(async () => {
      const status = await (await fetch('/api/runtime')).json();
      if (!status.encrypted) throw Error('This test requires encrypted runtime');
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
        name: 'Fictional prescription filter test',
        placebo: true,
      });
      const profile = await api(`/api/profile-setups/${setup.setupId}/verify`, {
        acknowledged: true,
        recovery: setup.recoveryKit,
      });
      const response = await fetch(`/api/profiles/${profile.id}/medications?status=all&limit=1`);
      if (!response.ok) throw Error('Could not read fictional prescriptions');
      const records = (await response.json()).data;
      return { id: records[0]?.id };
    });
    assert(setupResult.id, 'Placebo profile supplies a fictional selected prescription');
    // API activation bypasses the setup UI; reload the profile registry once.
    await page.reload();
    const writes: unknown[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method()))
        writes.push(request.method() + ' ' + request.url());
    });
    const search = new URLSearchParams({
      status: 'all',
      q: 'fictional search',
      offset: '40',
      id: setupResult.id,
    });
    const prior = '/medications?' + search;
    for (const action of ['Done', 'Skip for now']) {
      await page.goto(url + '/#' + prior);
      await page.getByRole('heading', { name: 'Prescriptions', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Activate prescriptions', exact: true }).click();
      await page.getByRole('button', { name: action, exact: true }).waitFor();
      await page
        .getByRole('list', { name: 'Saved filters' })
        .getByText('Inactive', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('textbox', { name: 'Search prescriptions' }).inputValue(),
        '',
      );
      // Browser history must preserve this entry's return snapshot, including reload.
      if (action === 'Done') {
        await page.goBack();
        await page.waitForURL(url + '/#' + prior);
        await page.goForward();
        await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
        await page.reload();
      }
      // Restoring the selected record checks its owner before revealing the list.
      // Hold that response so both return actions exercise the pending state.
      let releaseOwner!: () => void;
      const ownerGate = new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      await page.route(
        '**/record-owner?**',
        async (route) => {
          await ownerGate;
          await route.continue();
        },
        { times: 1 },
      );
      try {
        await page.getByRole('button', { name: action, exact: true }).click();
        await page.waitForURL(url + '/#' + prior);
        await page.getByText('Opening person’s records…', { exact: true }).waitFor();
      } finally {
        releaseOwner();
      }
      await page.getByRole('button', { name: action, exact: true }).waitFor({ state: 'hidden' });
      const filters = page.getByRole('list', { name: 'Saved filters' });
      // The mandatory person filter remains when status=all clears activity.
      await filters.getByRole('button', { name: /^Edit person:/ }).waitFor();
      assert.equal(await filters.getByRole('button', { name: /^Edit person:/ }).count(), 1);
      assert.equal(await filters.getByText('Inactive', { exact: true }).count(), 0);
      assert.equal(await filters.getByText('Active', { exact: true }).count(), 0);
      assert.equal(
        await page.getByRole('textbox', { name: 'Search prescriptions' }).inputValue(),
        'fictional search',
      );
      assert.equal(
        await page.getByRole('region', { name: 'Activate imported prescriptions' }).count(),
        0,
      );
    }
    const direct = new URLSearchParams({
      status: 'inactive',
      activation: '1',
      q: 'direct search',
      id: setupResult.id,
    });
    await page.goto(url + '/#/medications?' + direct);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    direct.delete('status');
    direct.delete('activation');
    await page.waitForURL(url + '/#/medications?' + direct);
    await page.getByRole('button', { name: 'Done', exact: true }).waitFor({ state: 'hidden' });
    await page
      .getByRole('list', { name: 'Saved filters' })
      .getByText('Active', { exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole('textbox', { name: 'Search prescriptions' }).inputValue(),
      'direct search',
    );
    assert.deepEqual(writes, [], 'activation navigation never writes medication state');
    assert.deepEqual(errors, []);
  },
);
