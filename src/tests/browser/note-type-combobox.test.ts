import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { Profile } from '../../shared/api.ts';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startRuntime } from '../../server/runtime.ts';

test(
  'Note types and People labels share explicit selection in an encrypted profile',
  { timeout: 90000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-note-type-'));
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
    async function capture(prefix: string, menuLabel = 'Note types') {
      const visuals = process.env.CRS_NOTE_TYPE_VISUAL_DIR;
      if (!visuals) return;
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
          const menu = page.getByRole('listbox', { name: menuLabel });
          if (await menu.isVisible()) {
            const bounds = await menu.boundingBox();
            assert(
              bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height,
              'type choices and Create stay within the viewport',
            );
          }
          await page.screenshot({
            path: resolve(visuals, `${prefix}-${theme}-${size}.png`),
            animations: 'disabled',
          });
        }
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    await page.goto(url);
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    await page.getByLabel('Display name', { exact: true }).fill('Fictional Notebook');
    await page.getByLabel('Your name').fill('Fictional Notebook');
    await page.getByLabel('Date of birth', { exact: true }).fill('1982-04-17');
    await page.getByRole('button', { name: 'Continue to recovery key' }).click();
    const recovery = await page.getByLabel('Recovery key', { exact: true }).inputValue();
    await page.getByLabel('I have saved my recovery key').check();
    await page.getByRole('button', { name: 'Verify recovery key', exact: true }).click();
    await page.getByLabel('Recovery key').fill(recovery);
    await page.getByRole('button', { name: 'Open profile' }).click();
    await page
      .getByRole('dialog', { name: 'Recovery unlocked', exact: true })
      .getByRole('button', { name: 'Skip', exact: true })
      .click();
    const setup = page.getByRole('dialog', { name: 'Care contacts' });
    for (const step of ['Primary care provider', 'Emergency contact']) {
      await setup.getByRole('heading', { name: step, exact: true }).waitFor();
      await setup.getByRole('button', { name: 'Skip for now' }).click();
    }
    await setup.waitFor({ state: 'hidden' });

    const profile = (await api('/api/profiles')).find(
      (candidate: Profile) => candidate.name === 'Fictional Notebook',
    );
    await api(`/api/profiles/${profile.id}/notes`, 'POST', {
      id: `note:${randomUUID()}`,
      kind: 'historical',
      title: 'Fictional counseling history',
      typeLabel: 'Therapist',
    });
    const draft = await api(`/api/profiles/${profile.id}/notes`, 'POST', {
      id: `note:${randomUUID()}`,
      kind: 'historical',
      title: 'Fictional visit draft',
    });
    await page.goto(`${url}/#/notes?kind=historical&id=${encodeURIComponent(draft.id)}`);
    const input = page.getByRole('combobox', { name: 'Type' });
    await input.fill('ther');
    await page.getByRole('option', { name: 'Therapy', exact: true }).waitFor();
    await page.getByRole('option', { name: 'Therapist', exact: true }).waitFor();
    await page.getByRole('option', { name: /Add “ther” as a new type/ }).waitFor();
    await capture('note-type-choices');

    await input.fill('therapy');
    assert.equal(await page.getByRole('option', { name: /Add .* as a new type/ }).count(), 0);
    const canonicalSaved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/notes/${encodeURIComponent(draft.id)}`) &&
        response.ok(),
    );
    await input.press('Enter');
    await canonicalSaved;
    await page.getByRole('button', { name: 'Edit type Therapy' }).waitFor();

    await page.getByRole('button', { name: 'Edit type Therapy' }).click();
    await input.fill('Care planning');
    assert.equal(
      (await api(`/api/profiles/${profile.id}/notes/${encodeURIComponent(draft.id)}`)).typeLabel,
      'Therapy',
      'typing a new type keeps the last explicitly selected type',
    );
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/notes/${encodeURIComponent(draft.id)}`) &&
        response.ok(),
    );
    await input.press('Enter');
    await saved;
    await page.getByRole('button', { name: 'Edit type Care planning' }).waitFor();
    assert.equal(
      (await api(`/api/profiles/${profile.id}/notes/${encodeURIComponent(draft.id)}`)).typeLabel,
      'Care planning',
    );
    await capture('note-type-selected');

    await api(`/api/profiles/${profile.id}/notes`, 'POST', {
      kind: 'person',
      title: 'Fictional Clementine',
      person: {
        name: 'Fictional Clementine',
        relationship: 'Care coordinator',
        tags: ['Care team'],
      },
    });
    const contact = await api(`/api/profiles/${profile.id}/notes`, 'POST', {
      kind: 'person',
      title: 'Fictional Saffron',
      person: { name: 'Fictional Saffron', relationship: 'Friend', tags: ['Family'] },
    });
    const contactPath = `/api/profiles/${profile.id}/notes/${encodeURIComponent(contact.id)}`;
    await page.goto(`${url}/#/people?id=${encodeURIComponent(contact.id)}`);
    const tags = page.getByRole('combobox', { name: 'Add a tag' });
    await tags.fill('care');
    await page.getByRole('option', { name: 'care team', exact: true }).waitFor();
    await capture('people-tag-choices', 'Person tags');
    await tags.fill('CARE TEAM');
    assert.equal(await page.getByRole('option', { name: /Add .* as a new tag/ }).count(), 0);
    assert.deepEqual((await api(contactPath)).person.tags, ['Family']);
    const tagsSaved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(contactPath) &&
        response.ok(),
    );
    await tags.press('Enter');
    await tagsSaved;
    await page.getByRole('button', { name: 'Remove tag care team' }).waitFor();
    assert.deepEqual((await api(contactPath)).person.tags, ['care team', 'Family']);

    await page.getByRole('button', { name: 'Edit relationship Friend' }).click();
    const relationship = page.getByRole('combobox', { name: 'Relationship / context' });
    await relationship.fill('care coordinator');
    assert.equal(
      await page.getByRole('option', { name: /Add .* as a new relationship/ }).count(),
      0,
    );
    assert.equal((await api(contactPath)).person.relationship, 'Friend');
    const relationshipSaved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(contactPath) &&
        response.ok(),
    );
    await relationship.press('Enter');
    await relationshipSaved;
    await page.getByRole('button', { name: 'Edit relationship Care coordinator' }).waitFor();
    assert.equal((await api(contactPath)).person.relationship, 'Care coordinator');
    await capture('people-selected-labels', 'Person tags');
    assert.deepEqual(errors, []);
  },
);
