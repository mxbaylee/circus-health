import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { NoteHistoryEntry } from '../../shared/api.ts';
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
  'care contact phone edits and in-flight new-person typing retain one linked Person',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-contact-linking-'));
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
    const browser = await chromium.launch({ headless: true });
    t.after(async () => {
      await browser.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(url);
    async function api(path: string, method = 'GET', data?: unknown) {
      const response = await page.evaluate(
        async ({ path, method, data }) => {
          const reply = await fetch(path, {
            method,
            headers: { 'Content-Type': 'application/json' },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          });
          return { status: reply.status, body: await reply.json() };
        },
        { path, method, data },
      );
      assert(response.status < 300, `${method} ${path}: ${JSON.stringify(response)}`);
      return response.body.data;
    }
    const setup = await api('/api/profile-setups', 'POST', {
      fullName: 'Fictional Contact Linking',
      birthDate: '1982-04-17',
      name: 'Fictional Contact Linking',
      placebo: false,
    });
    const profile = await api(`/api/profile-setups/${setup.setupId}/verify`, 'POST', {
      acknowledged: true,
      recovery: setup.recoveryKit,
    });
    const notesPath = `/api/profiles/${profile.id}/notes`;
    await page.reload();
    await page.locator('.profile-current').click();
    await page.getByRole('button', { name: 'Resume setup', exact: true }).click();
    const onboarding = page.getByRole('dialog', { name: 'Care contacts' });
    await onboarding
      .getByLabel('Primary care provider', { exact: true })
      .fill('Fictional Dr. Juniper');
    // Lose the accepted name-create response so the same contact must be resumed.
    let loseResponse = true;
    await page.route(`**${notesPath}`, async (route) => {
      if (loseResponse && route.request().method() === 'POST') {
        loseResponse = false;
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'FICTIONAL_LOST_RESPONSE',
              message: 'Fictional response lost after saving name.',
            },
          }),
        });
      } else await route.continue();
    });
    await onboarding.getByRole('button', { name: 'Save and continue' }).click();
    await onboarding.getByRole('alert').filter({ hasText: 'Fictional response lost' }).waitFor();
    const self = await api(`${notesPath}/patient`);
    const doctorId = self.person.onboarding.careTeam.primaryCareId;
    const originalDoctor = await api(`${notesPath}/${encodeURIComponent(doctorId)}`);
    await page.reload();
    await page.locator('.profile-current').click();
    await page.getByRole('button', { name: 'Resume setup', exact: true }).click();
    assert.equal(
      await onboarding.getByLabel('Primary care provider', { exact: true }).inputValue(),
      originalDoctor.title,
    );
    await onboarding.getByLabel('Primary care provider phone', { exact: true }).fill('555-0100');
    await onboarding.getByRole('button', { name: 'Save and continue' }).click();
    await onboarding.getByLabel('Emergency contact', { exact: true }).fill('Fictional Avery');
    await onboarding.getByLabel('Emergency contact phone', { exact: true }).fill('555-0199');
    loseResponse = true;
    await onboarding.getByRole('button', { name: 'Finish setup' }).click();
    await onboarding.getByRole('alert').filter({ hasText: 'Fictional response lost' }).waitFor();
    await page.reload();
    await page.locator('.profile-current').click();
    await page.getByRole('button', { name: 'Resume setup', exact: true }).click();
    assert.equal(
      await onboarding.getByLabel('Primary care provider phone', { exact: true }).count(),
      0,
    );
    await onboarding.getByRole('button', { name: 'Back to primary care provider' }).click();
    assert.equal(
      await onboarding.getByLabel('Primary care provider phone', { exact: true }).inputValue(),
      '555-0100',
    );
    await onboarding.getByRole('button', { name: 'Save and continue' }).click();
    assert.equal(
      await onboarding.getByLabel('Emergency contact phone', { exact: true }).inputValue(),
      '555-0199',
    );
    const visualOutput = process.env.CRS_CONTACT_VISUAL_DIR;
    const visuals = visualOutput ? prepareVisualDirectory(visualOutput) : null;
    for (const screen of ['emergency', 'provider']) {
      if (screen === 'provider')
        await onboarding.getByRole('button', { name: 'Back to primary care provider' }).click();
      if (visuals) {
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.colorScheme = theme;
          }, theme);
          for (const [size, viewport] of [
            ['desktop', { width: 1280, height: 900 }],
            ['mobile', { width: 390, height: 844 }],
          ] as const) {
            await page.setViewportSize(viewport);
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.screenshot({
              path: resolve(visuals, `care-${screen}-${theme}-${size}.png`),
              animations: 'disabled',
            });
          }
        }
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    }
    await onboarding.getByRole('button', { name: 'Save and continue' }).click();
    await onboarding.getByRole('button', { name: 'Finish setup' }).click();
    await onboarding.waitFor({ state: 'hidden' });
    const completed = await api(`${notesPath}/patient`);
    const doctorAfterSetup = await api(`${notesPath}/${encodeURIComponent(doctorId)}`);
    assert.equal(doctorAfterSetup.person.phone, '555-0100');
    assert.equal(doctorAfterSetup.personId, originalDoctor.personId);
    const emergency = await api(
      `${notesPath}/${encodeURIComponent(completed.person.onboarding.careTeam.emergencyContactId)}`,
    );
    assert.equal(emergency.title, 'Fictional Avery');
    assert.equal(emergency.person.phone, '555-0199');
    await page.goto(`${url}/#/people?id=${encodeURIComponent(doctorId)}`);
    const phoneSave = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/notes/${encodeURIComponent(doctorId)}`) &&
        response.ok(),
    );
    await page.getByLabel('Phone', { exact: true }).fill('555-0142');
    await phoneSave;
    const updatedDoctor = await api(`${notesPath}/${encodeURIComponent(doctorId)}`);
    assert.equal(updatedDoctor.personId, originalDoctor.personId);
    assert.equal(updatedDoctor.person.phone, '555-0142');
    const history = await api(`${notesPath}/${encodeURIComponent(doctorId)}/history`);
    const phones: NoteHistoryEntry['fields'][number]['previous'][] = history.entries.flatMap(
      (entry: NoteHistoryEntry) =>
        entry.fields
          .filter((field) => field.path === 'person.phone')
          .map((field) => field.previous),
    );
    assert(
      phones.some((phone) => phone.value === '555-0100'),
      'the previous onboarding phone remains in accepted history',
    );
    assert(
      phones.some((phone) => !phone.present),
      'the original name-only record remains in accepted history',
    );
    assert.equal((await api(`${notesPath}?kind=person&excludeSelf=1`)).length, 2);
    assert.equal((await api('/api/profiles')).length, 1);

    await page.goto(`${url}/#/people`);
    await page.getByRole('button', { name: 'New person', exact: true }).first().click();
    let releaseCreate!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let signalCreate!: (response: { data: { id: string; personId: string } }) => void;
    const created = new Promise<{ data: { id: string; personId: string } }>((resolve) => {
      signalCreate = resolve;
    });
    const writes = [];
    await page.unroute(`**${notesPath}`);
    await page.route(`**${notesPath}`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      writes.push(route.request().postDataJSON());
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      signalCreate(await response.json());
      await held;
      await route.fulfill({ response });
    });
    const name = page.getByLabel('Display name or familiar label', { exact: true });
    await name.fill('Fictional Dr. Rowan');
    const firstCreate = (await created).data;
    // Editing continues while the name autosave response is still pending.
    await page.getByLabel('Phone', { exact: true }).fill('555-0186');
    await name.fill('Fictional Dr. Rowan Updated');
    const followupSave = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/notes/${encodeURIComponent(firstCreate.id)}`) &&
        response.request().postDataJSON()?.title === 'Fictional Dr. Rowan Updated' &&
        response.ok(),
    );
    releaseCreate();
    await followupSave;
    await page.waitForFunction(
      (input) => (input as HTMLInputElement).value === 'Fictional Dr. Rowan Updated',
      await name.elementHandle(),
    );
    assert.equal(await name.inputValue(), 'Fictional Dr. Rowan Updated');
    const saved = await api(`${notesPath}/${encodeURIComponent(firstCreate.id)}`);
    assert.equal(saved.personId, firstCreate.personId);
    assert.equal(saved.person.phone, '555-0186');
    assert.equal(saved.title, 'Fictional Dr. Rowan Updated');
    assert.equal(writes.length, 1, 'typing phone during creation must update the accepted Person');
    assert.equal((await api(`${notesPath}?kind=person&excludeSelf=1`)).length, 3);
    await page.reload();
    assert.equal(await name.inputValue(), saved.title);
    assert.equal(await page.getByLabel('Phone', { exact: true }).inputValue(), saved.person.phone);
    assert.deepEqual(errors, []);
  },
);
