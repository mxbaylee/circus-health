import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { startRuntime } from '../../server/runtime.ts';

function prepareVisualDirectory(path: string) {
  const requested = resolve(path);
  let ancestor = requested;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    assert.notEqual(parent, ancestor, 'Visual output has no accessible parent directory.');
    ancestor = parent;
  }
  const directory = resolve(realpathSync(ancestor), relative(ancestor, requested));
  const within = relative(realpathSync(tmpdir()), directory);
  assert(
    within && !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`),
    'Visual output must be inside the system temporary directory.',
  );
  mkdirSync(directory, { recursive: true });
  assert.equal(realpathSync(directory), directory, 'Visual output directory changed.');
  return directory;
}

test(
  'connection recovery preserves an unconfirmed editor and update refresh uses explicit save/discard',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-connection-browser-'));
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
          model: 'fictional-unavailable',
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors: string[] = [],
      dialogs: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.type());
      await dialog.dismiss();
    });
    const origin = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(origin);
    await page.getByRole('button', { name: 'Create profile', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Server connection: Connected' }).waitFor();
    assert.equal(await page.getByRole('complementary', { name: 'Application update' }).count(), 0);
    async function api(path: string, method = 'GET', data?: unknown) {
      const result = await page.evaluate(
        async ({ path, method, data }) => {
          const response = await fetch(path, {
            method,
            headers: { 'Content-Type': 'application/json' },
            ...(data ? { body: JSON.stringify(data) } : {}),
          });
          return { status: response.status, body: await response.json() };
        },
        { path, method, data },
      );
      assert(result.status < 300, `${method} ${path}: ${JSON.stringify(result)}`);
      return result.body.data;
    }
    const setup = await api('/api/profile-setups', 'POST', {
      fullName: 'Fictional Connection Person',
      birthDate: '1982-04-17',
      name: 'Fictional Connection Person',
      placebo: false,
    });
    const profile = await api(`/api/profile-setups/${setup.setupId}/verify`, 'POST', {
      acknowledged: true,
      recovery: setup.recoveryKit,
    });
    await page.reload();
    const pronouns = page.getByLabel('Pronouns', { exact: true });
    await pronouns.waitFor();
    let outage = false,
      update = false,
      failWrite = 'lost',
      mutations = 0;
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/runtime' && (outage || update))
        return route.fulfill({
          status: outage ? 503 : 200,
          contentType: 'application/json',
          body: JSON.stringify({ encrypted: true, buildId: 'fictional-next-deployment' }),
        });
      if (request.method() === 'PUT' && path.includes('/notes/')) {
        mutations++;
        if (failWrite === 'lost') {
          failWrite = '';
          const saved = await route.fetch();
          assert.equal(saved.status(), 200);
          return route.abort('connectionfailed');
        }
        if (failWrite === 'reject')
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'FICTIONAL_UNAVAILABLE', message: 'Fictional save unavailable.' },
            }),
          });
      }
      if (outage && request.method() === 'GET' && path.startsWith('/api/profiles'))
        return route.abort('connectionfailed');
      await route.continue();
    });
    await pronouns.fill('Fictional accepted but unconfirmed');
    await page.locator('.note-detail').getByRole('alert').waitFor();
    assert.equal(mutations, 1);
    await pronouns.evaluate((input) => {
      input.dataset.fictionalRetained = 'yes';
    });
    outage = true;
    update = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'Server connection: Server unavailable' }).waitFor();
    await page.getByRole('button', { name: 'Server connection: Server unavailable' }).click();
    assert.match((await page.getByRole('tooltip').textContent())!, /HTTP 503/);
    assert.equal(
      await page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled(),
      true,
    );
    outage = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'Server connection: Connected' }).waitFor();
    assert.equal(await pronouns.getAttribute('data-fictional-retained'), 'yes');
    assert.equal(await pronouns.inputValue(), 'Fictional accepted but unconfirmed');
    assert.equal(mutations, 1, 'reconnecting must not replay the unconfirmed save');
    const visualOutput = process.env.HEALTH_CONNECTION_VISUAL_DIR;
    const visuals = visualOutput ? prepareVisualDirectory(visualOutput) : null;
    if (visuals) {
      for (const theme of ['light', 'dark'])
        for (const [size, viewport] of [
          ['desktop', { width: 1280, height: 900 }],
          ['mobile', { width: 390, height: 844 }],
        ] as const) {
          await page.setViewportSize(viewport);
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          await page.getByRole('button', { name: 'Server connection: Connected' }).click();
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({
            path: resolve(visuals, `connection-${theme}-${size}.png`),
            animations: 'disabled',
          });
        }
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    // Keep the tooltip open in both visual and ordinary runs: it must not block Refresh.
    await page.getByRole('button', { name: 'Server connection: Connected' }).hover();
    await page.getByRole('tooltip').waitFor();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const guard = page.getByRole('dialog', { name: 'Save changes before continuing?' });
    await guard.getByRole('button', { name: 'Back', exact: true }).click();
    assert.equal(await pronouns.getAttribute('data-fictional-retained'), 'yes');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await Promise.all([
      page.waitForEvent('load'),
      guard.getByRole('button', { name: 'Save and continue' }).click(),
    ]);
    await pronouns.waitFor();
    assert.equal(await pronouns.inputValue(), 'Fictional accepted but unconfirmed');
    assert.equal(
      mutations,
      1,
      'explicit Save reconciles the accepted response by reading its stable identity',
    );
    failWrite = 'reject';
    await pronouns.fill('Fictional explicitly discarded draft');
    await page.getByRole('alert').filter({ hasText: 'Fictional save unavailable' }).waitFor();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await Promise.all([
      page.waitForEvent('load'),
      guard.getByRole('button', { name: 'Discard and continue' }).click(),
    ]);
    await pronouns.waitFor();
    assert.equal(await pronouns.inputValue(), 'Fictional accepted but unconfirmed');
    assert.equal(mutations, 2);
    await page.locator('.profile-current').click();
    await page.getByRole('dialog', { name: 'Profiles', exact: true }).waitFor();
    assert(
      await page.locator('.app-update-notice').evaluate((element) => {
        const button = element.querySelector('button')!;
        const box = button.getBoundingClientRect();
        return !document
          .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          ?.closest('.app-update-notice');
      }),
      'profile lifecycle dialogs block the update Refresh control',
    );
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    assert.deepEqual(
      dialogs,
      [],
      'explicit save/discard must not cause a second native confirmation',
    );
    await api(`/api/profiles/${profile.id}/lock`, 'POST', {});
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'Choose profile', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Server connection: Connected' }).waitFor();
    assert.deepEqual(errors, []);
  },
);
