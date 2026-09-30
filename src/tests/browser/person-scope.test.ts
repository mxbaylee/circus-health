import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { Browser } from 'playwright';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

test(
  'person picker, direct ownership, notes, save feedback and responsive header work in an encrypted app',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-person-scope-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startBrowserRuntime(t, {
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
    browser = await launchBrowser(t);
    const page = await newTestPage(browser, { viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const base = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(base);
    const fixture = await page.evaluate(async () => {
      async function api(path: string, body?: unknown) {
        const response = await fetch(path, {
          method: body ? 'POST' : 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await response.json();
        if (!response.ok) throw Error(JSON.stringify(data));
        return data.data;
      }
      const setup = await api('/api/profile-setups', { name: 'Fictional Self', placebo: true });
      await api(`/api/profile-setups/${setup.setupId}/verify`, {
        acknowledged: true,
        recovery: setup.recoveryKit,
      });
      const profiles = await api('/api/profiles');
      const profile = profiles.find((p: { name: string }) => p.name === 'Fictional Self');
      const path = `/api/profiles/${profile.id}/notes`;
      const person = await api(path, {
        kind: 'person',
        title: 'Cookie Doe',
        person: { birthDate: '1986-02-14' },
      });
      await api(path, { kind: 'note', title: 'Self planning', content: 'Only for Self' });
      const note = await api(path, {
        kind: 'note',
        title: 'Cookie planning',
        content: 'Only for Cookie',
        ownerPersonId: person.personId,
      });
      return { personId: person.personId, noteId: note.id, profileId: profile.id };
    });
    await page.reload();
    await page.goto(`${base}/#/notes`);
    await page.getByRole('button', { name: 'Edit person: Self' }).waitFor();
    await page.getByText('Self planning', { exact: true }).waitFor();
    assert.equal(await page.getByText('Cookie planning', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Edit person: Self' }).click();
    await page.getByLabel('Show records for').selectOption(fixture.personId);
    await page.getByRole('button', { name: 'Save filter', exact: true }).click();
    await page.getByText('Viewing Cookie Doe’s records', { exact: true }).waitFor();
    await page.getByText('Cookie planning', { exact: true }).waitFor();
    assert.equal(await page.getByText('Self planning', { exact: true }).count(), 0);
    await page.getByRole('link', { name: 'Test results', exact: true }).click();
    await page.getByRole('button', { name: 'Edit person: Self' }).waitFor();
    assert.equal(
      new URL(page.url().split('#')[1], 'https://test.invalid').searchParams.get('personId'),
      null,
    );
    await page.getByRole('link', { name: 'Notes', exact: true }).first().click();
    await page.getByRole('button', { name: 'Edit person: Self' }).click();
    await page.getByLabel('Show records for').selectOption(fixture.personId);
    await page.getByRole('button', { name: 'Save filter', exact: true }).click();
    await page.getByText('Cookie planning', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'New note', exact: true }).first().click();
    await page.getByText('Not saved yet', { exact: true }).waitFor();
    const title = page.getByRole('textbox', { name: 'Title', exact: true });
    await title.fill('Cookie follow-up');
    await page.getByText(/Autosaved just now/).waitFor();
    const saved = await page.evaluate(async ({ profileId, personId }) => {
      const response = await fetch(
        `/api/profiles/${profileId}/notes?kind=note&personId=${encodeURIComponent(personId)}`,
      );
      return (await response.json()).data;
    }, fixture);
    assert.equal(
      saved.find((n: { title: string }) => n.title === 'Cookie follow-up')?.ownerPersonId,
      fixture.personId,
    );
    await page.goto(`${base}/#/notes?id=${encodeURIComponent(fixture.noteId)}&personId=patient`);
    await page.getByText('All changes saved', { exact: true }).waitFor();
    await page.getByText('Viewing Cookie Doe’s records', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('textbox', { name: 'Title', exact: true }).inputValue(),
      'Cookie planning',
    );
    const visuals = process.env.CRS_PERSON_SCOPE_VISUAL_DIR;
    if (visuals) mkdirSync(visuals, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((next) => {
        localStorage.setItem('circus-health-theme', next);
        window.dispatchEvent(new StorageEvent('storage', { key: 'circus-health-theme' }));
      }, theme);
      await page.waitForFunction((next) => document.documentElement.dataset.theme === next, theme);
      for (const [size, viewport] of [
        ['desktop', { width: 1280, height: 900 }],
        ['mobile', { width: 390, height: 844 }],
      ] as const) {
        await page.setViewportSize(viewport);
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          'No horizontal overflow',
        );
        const indicator = await page.locator('.person-context-indicator').boundingBox();
        const assistant = await page.getByRole('button', { name: 'Open assistant' }).boundingBox();
        assert(indicator && assistant);
        if (size === 'mobile')
          assert(indicator.y >= assistant.y + assistant.height, 'Indicator below toolbar');
        else assert(indicator.x + indicator.width <= assistant.x, 'Indicator before assistant');
        if (visuals)
          await page.screenshot({
            path: resolve(visuals, `person-notes-${theme}-${size}.png`),
            animations: 'disabled',
          });
      }
    }
    await page.getByRole('button', { name: 'Back to notes', exact: true }).click();
    await page.getByRole('button', { name: 'Edit person: Cookie Doe' }).click();
    await page.getByLabel('Show records for').selectOption('patient');
    await page.getByRole('button', { name: 'Save filter', exact: true }).click();
    await page.getByText('Self planning', { exact: true }).waitFor();
    assert.equal(await page.locator('.person-context-indicator').count(), 0);
    await page.goto(
      `${base}/#/sources?view=documents&personId=${encodeURIComponent(fixture.personId)}`,
    );
    await page.getByRole('button', { name: 'Edit person: Cookie Doe' }).waitFor();
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    await page.locator('.person-context-indicator').waitFor({ state: 'detached' });
    await page.goto(`${base}/#/people?id=${encodeURIComponent(fixture.personId)}`);
    const health = page.getByRole('region', { name: 'Health records' });
    await health.getByRole('link', { name: 'Notes · 2', exact: true }).waitFor();
    await health.getByRole('link', { name: 'Notes · 2', exact: true }).click();
    await page.getByRole('button', { name: 'Edit person: Cookie Doe' }).waitFor();
    await page.getByRole('link', { name: 'Historical notes', exact: true }).click();
    await page.getByRole('button', { name: 'New historical draft', exact: true }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Cookie appointment');
    await page.getByText('Autosaved just now', { exact: true }).waitFor();
    const historical = await page.evaluate(async ({ profileId, personId }) => {
      const response = await fetch(
        `/api/profiles/${profileId}/historical-notes?personId=${encodeURIComponent(personId)}`,
      );
      return (await response.json()).data;
    }, fixture);
    assert.equal(
      historical.some(
        (n: { title: string; personId: string }) =>
          n.title === 'Cookie appointment' && n.personId === fixture.personId,
      ),
      true,
    );
    let releaseOwner!: () => void;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    await page.route('**/record-owner?*', async (route) => {
      await ownerGate;
      await route.continue();
    });
    const writes: Array<{ ownerPersonId?: string }> = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/notes'))
        writes.push(request.postDataJSON());
    });
    await page.goto(
      `${base}/#/notes?new=1&targetType=note&targetId=${encodeURIComponent(fixture.noteId)}&personId=patient`,
    );
    await page.getByText('Checking record owner…', { exact: true }).waitFor();
    // Hold the read beyond the normal 650 ms autosave debounce.
    await page.waitForTimeout(900);
    assert.equal(writes.length, 0, 'No note can autosave before its owner is known');
    assert.equal(await page.getByRole('textbox', { name: 'Title', exact: true }).count(), 0);
    releaseOwner();
    await page.getByText('Autosaved just now', { exact: true }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].ownerPersonId, fixture.personId);
    assert.deepEqual(errors, []);
  },
);
