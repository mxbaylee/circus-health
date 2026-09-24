import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { Note } from '../../shared/api.ts';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startRuntime } from '../../server/runtime.ts';

const unavailableLiteLlm = () => ({
  available: false,
  backend: 'litellm',
  model: 'fictional-browser-alias',
  readiness: 'unavailable',
  capabilities: { tools: null, images: null },
});

test(
  'encrypted profile actions preserve Storage intent, keyboard focus and session isolation across remounts',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-profile-actions-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startRuntime({
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
      assistantOptions: { availability: unavailableLiteLlm },
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
    const visuals = process.env.HEALTH_PROFILE_VISUAL_DIR;
    async function capture(prefix: string) {
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
    async function api(path: string, method = 'GET', data?: unknown) {
      const response = await page.evaluate(
        async ({ path, method, data }) => {
          const reply = await fetch(path, {
            method,
            headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          });
          return { status: reply.status, body: await reply.text() };
        },
        { path, method, data },
      );
      assert(response.status < 300, `${method} ${path}: ${response.status}`);
      return JSON.parse(response.body).data;
    }
    async function arrangeProfile(name: string, pronouns: string) {
      const setup = await api('/api/profile-setups', 'POST', {
        fullName: name,
        birthDate: '1982-04-17',
        name,
        placebo: false,
      });
      const resumed = await api('/api/profile-setups/resume', 'POST', {
        recovery: setup.recoveryKit,
      });
      const profile = await api(`/api/profile-setups/${resumed.setupId}/verify`, 'POST', {
        acknowledged: true,
        recovery: setup.recoveryKit,
      });
      const notes = await api(`/api/profiles/${profile.id}/notes`);
      assert.equal(
        notes.filter((note: Note) => note.title === 'Annual Planning').length,
        1,
        'resuming setup seeds Annual Planning exactly once',
      );
      const self = await api(`/api/profiles/${profile.id}/notes/patient`);
      await api(`/api/profiles/${profile.id}/notes/${encodeURIComponent(self.id)}`, 'PUT', {
        kind: 'person',
        title: name,
        content: '',
        person: { ...self.person, pronouns },
        pinned: false,
        links: [],
        version: self.version,
      });
      return { ...profile, recoveryKit: setup.recoveryKit };
    }
    await page.goto(url);
    assert.equal(
      await page.evaluate(async () => (await (await fetch('/api/runtime')).json()).encrypted),
      true,
    );
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    await page.getByLabel('Display name', { exact: true }).fill('Fictional Apricot');
    await page.getByLabel('Full name on health records').fill('Fictional Apricot');
    await page.getByLabel('Date of birth', { exact: true }).fill('1982-04-17');
    await page.getByRole('button', { name: 'Continue to recovery key' }).click();
    const firstRecovery = await page.getByLabel('Recovery key', { exact: true }).inputValue();
    await page.getByLabel('I have saved my recovery key').check();
    await page.getByRole('button', { name: 'Verify recovery key', exact: true }).click();
    await page.getByLabel('Recovery key').fill(firstRecovery);
    await page.getByRole('button', { name: 'Open profile' }).click();
    const recoveryChoice = page.getByRole('dialog', { name: 'Recovery unlocked', exact: true });
    await recoveryChoice.getByRole('button', { name: 'Add passkey', exact: true }).waitFor();
    await recoveryChoice.getByRole('button', { name: 'Skip', exact: true }).click();
    const onboarding = page.getByRole('dialog', { name: 'A little about you' });
    await onboarding.getByRole('heading', { name: 'About you', exact: true }).waitFor();
    await onboarding.getByLabel('Pronouns', { exact: true }).fill('they/them');
    await onboarding.getByRole('button', { name: 'Save and continue' }).click();
    await onboarding.getByRole('heading', { name: 'Primary care provider', exact: true }).waitFor();
    assert.equal(await onboarding.getByLabel('Scheduling URL').count(), 0);
    const stagedProfile = (await api('/api/profiles'))[0];
    const stagedSelf = await api(`/api/profiles/${stagedProfile.id}/notes/patient`);
    const priorPrimary = 'note:onboarding-primary-11111111-1111-4111-8111-111111111111';
    const priorEmergency = 'note:onboarding-emergency-22222222-2222-4222-8222-222222222222';
    // Reproduce the old UI's exact failing create against the actual encrypted API.
    const rejected = await page.evaluate(
      async ({ id, noteId }) => {
        const response = await fetch(`/api/profiles/${id}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: noteId,
            kind: 'person',
            title: 'Fictional Dr. Cedar',
            content: '',
            person: { name: 'Fictional Dr. Cedar' },
            links: [],
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      { id: stagedProfile.id, noteId: priorPrimary },
    );
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'INVALID_ID');
    await api(
      `/api/profiles/${stagedProfile.id}/notes/${encodeURIComponent(stagedSelf.id)}`,
      'PUT',
      {
        kind: 'person',
        title: stagedSelf.title,
        content: '',
        links: [],
        version: stagedSelf.version,
        person: {
          ...stagedSelf.person,
          onboarding: {
            ...stagedSelf.person.onboarding,
            careTeam: { primaryCareId: priorPrimary, emergencyContactId: priorEmergency },
          },
        },
      },
    );
    await page.reload();
    await page.locator('.profile-current').click();
    await page.getByRole('button', { name: 'Resume setup', exact: true }).click();
    await onboarding
      .getByLabel('Primary care provider', { exact: true })
      .fill('Fictional Dr. Cedar');
    let loseResponse = true;
    await page.route(`**/api/profiles/${stagedProfile.id}/notes`, async (route) => {
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
              message: 'Fictional lost response; resume to retry.',
            },
          }),
        });
      } else await route.continue();
    });
    await onboarding.getByRole('button', { name: 'Save and continue' }).click();
    await onboarding.getByRole('alert').filter({ hasText: 'Fictional lost response' }).waitFor();
    const unfinished = await api(`/api/profiles/${stagedProfile.id}/notes/patient`);
    assert.equal(unfinished.person.onboarding.finished, false);
    assert.equal(
      unfinished.person.onboarding.careTeam.primaryCareId,
      'note:11111111-1111-4111-8111-111111111111',
    );
    const retained = await api(
      `/api/profiles/${stagedProfile.id}/notes/${encodeURIComponent(unfinished.person.onboarding.careTeam.primaryCareId)}`,
    );
    // Existing scheduling/contact metadata is editable in People and must survive setup.
    await api(`/api/profiles/${stagedProfile.id}/notes/${encodeURIComponent(retained.id)}`, 'PUT', {
      kind: 'person',
      title: retained.title,
      content: '',
      links: [],
      version: retained.version,
      person: {
        ...retained.person,
        schedulingUrl: 'https://fictional-care.example.test',
        phone: '555-0101',
      },
    });
    await page.reload();
    await page.locator('.profile-current').click();
    await page.getByRole('button', { name: 'Resume setup', exact: true }).click();
    assert.equal(
      await onboarding.getByLabel('Primary care provider', { exact: true }).inputValue(),
      'Fictional Dr. Cedar',
    );
    await onboarding.getByRole('button', { name: 'Save and continue' }).click();
    await onboarding.getByLabel('Emergency contact', { exact: true }).fill('Fictional Avery');
    await onboarding.getByRole('button', { name: 'Finish setup' }).click();
    await onboarding.waitFor({ state: 'hidden' });
    const completed = await api(`/api/profiles/${stagedProfile.id}/notes/patient`);
    assert.equal(completed.person.onboarding.finished, true);
    const people = (await api(`/api/profiles/${stagedProfile.id}/notes`)).filter(
      (note: Note) => note.kind === 'person' && !note.isSelf,
    );
    assert.equal(people.length, 2, 'uncertain create and resumed retry produce exactly two People');
    const provider = await api(
      `/api/profiles/${stagedProfile.id}/notes/${encodeURIComponent(completed.person.onboarding.careTeam.primaryCareId)}`,
    );
    assert.equal(provider.person.schedulingUrl, 'https://fictional-care.example.test');
    assert.equal(provider.person.phone, '555-0101');
    assert(
      provider.personId && provider.personId !== 'patient',
      'ordinary Person record remains linked to its note',
    );
    await page.reload();
    await page.locator('.profile-current').click();
    await page.getByRole('button', { name: 'Add passkey', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Resume setup', exact: true }).count(), 0);
    assert.equal(
      await page.getByRole('heading', { name: 'Setup incomplete', exact: true }).isVisible(),
      true,
      'finished onboarding without a registered passkey remains incomplete',
    );
    assert.deepEqual(
      (await page.locator('.profile-action-top > .profile-action').allTextContents()).map((label) =>
        label.trim(),
      ),
      ['Add passkey', 'Lock profile'],
      'primary setup actions follow the approved order',
    );
    const completedActionWidths = await page
      .locator('.profile-action-top > .profile-action')
      .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().width));
    assert(
      Math.max(...completedActionWidths) - Math.min(...completedActionWidths) < 1,
      'top profile actions have equal widths',
    );
    assert.equal(
      await page.locator('.profile-danger-zone').getAttribute('open'),
      null,
      'Danger Zone starts collapsed',
    );
    await capture('profile-completed-actions');
    await page.getByRole('button', { name: 'Close dialog' }).click();
    const first = (await api('/api/profiles')).find(
      (profile: { id: string; name: string }) => profile.name === 'Fictional Apricot',
    );
    assert(first);
    const firstSelf = await api(`/api/profiles/${first.id}/notes/patient`);
    await api(`/api/profiles/${first.id}/notes/${encodeURIComponent(firstSelf.id)}`, 'PUT', {
      kind: 'person',
      title: first.name,
      content: '',
      person: { ...firstSelf.person, pronouns: 'they/them' },
      pinned: false,
      links: [],
      version: firstSelf.version,
    });
    const second = await arrangeProfile('Fictional Blueberry', 'she/her');
    await page.reload();
    const displayedName = page.getByPlaceholder('Name shown throughout the app');
    await displayedName.waitFor();
    assert.equal(await displayedName.inputValue(), second.name);
    assert.equal(
      (await api('/api/profiles')).filter((profile: { locked: boolean }) => !profile.locked).length,
      1,
    );
    await page.locator('.profile-current').click();
    const picker = page.getByRole('dialog', { name: 'Profiles', exact: true });
    assert.equal(
      await picker.getByRole('button', { name: `More actions for ${first.name}` }).count(),
      0,
      'locked profiles have no useless menu',
    );
    assert.equal(
      (await picker.locator('.profile-row[aria-current="true"] .profile-storage').textContent()) ===
        'Unknown',
      false,
      'Self metadata must retain active storage size',
    );
    assert.equal(await picker.getByLabel('Selected', { exact: true }).count(), 0);
    await capture('profile-picker');
    await picker.getByRole('button', { name: new RegExp(`^${first.name} Locked`) }).click();
    const unlock = page.getByRole('dialog', { name: `Open ${first.name}`, exact: true });
    await unlock.locator('input[name="password"]:focus').waitFor();
    assert.equal(
      await unlock.getByRole('button', { name: 'Use passkey instead', exact: true }).isEnabled(),
      true,
      'recovery mode retains an explicit manual passkey option',
    );
    assert.equal(await unlock.locator('form').getAttribute('method'), 'post');
    assert.equal(await unlock.locator('input[name="username"]').inputValue(), first.name);
    assert.equal(
      await unlock.locator('input[name="password"]').getAttribute('autocomplete'),
      'current-password',
    );
    await capture('recovery-only-unlock');
    await unlock.getByRole('button', { name: 'Back to profiles', exact: true }).click();
    await picker.getByRole('button', { name: new RegExp(`^${first.name} Locked`) }).click();
    await unlock.getByLabel('Recovery key', { exact: true }).fill(firstRecovery);
    await unlock.getByRole('button', { name: 'Open profile', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Recovery unlocked', exact: true })
      .getByRole('button', { name: 'Skip', exact: true })
      .click();
    await page.waitForFunction(
      (name) =>
        document.querySelector<HTMLInputElement>(
          'input[placeholder="Name shown throughout the app"]',
        )?.value === name,
      first.name,
    );
    assert.equal(await page.getByLabel('Pronouns', { exact: true }).inputValue(), 'they/them');
    assert.equal(
      await page.evaluate(
        async (path) => (await fetch(path)).status,
        `/api/profiles/${second.id}/notes/patient`,
      ),
      423,
    );

    await page.locator('.profile-current').click();
    assert.equal(await picker.getByRole('button', { name: /More actions for/ }).count(), 0);
    assert.equal(await picker.getByRole('group', { name: /Actions for/ }).count(), 1);
    assert.equal(
      await picker.locator('.profile-danger-zone').getAttribute('open'),
      null,
      'management actions stay collapsed until requested',
    );
    await capture('profile-actions');
    const storageResponse = page.waitForResponse(
      (response) => response.url() === `${url}/api/profiles/${first.id}/storage` && response.ok(),
    );
    await picker.getByText('Danger Zone', { exact: true }).click();
    await picker.getByRole('button', { name: 'View storage', exact: true }).click();
    const storage = page.getByRole('dialog', { name: 'Profile storage', exact: true });
    await storage.getByText(/stored for this profile/).waitFor();
    assert((await (await storageResponse).json()).data.storedBytes > 0);
    assert.equal(await displayedName.inputValue(), first.name);
    await capture('profile-storage');
    await storage.getByRole('button', { name: 'Back to profiles', exact: true }).click();
    await picker.waitFor();
    assert.equal(await picker.locator('.profile-danger-zone').getAttribute('open'), null);
    await picker.getByText('Danger Zone', { exact: true }).click();
    await picker.getByRole('button', { name: 'Delete profile', exact: true }).click();
    await picker.getByLabel('Profile name', { exact: true }).fill('wrong name');
    assert.equal(
      await picker.getByRole('button', { name: 'Delete profile', exact: true }).isDisabled(),
      true,
    );
    await picker.getByRole('button', { name: 'Back to profiles', exact: true }).click();
    await picker.getByText('Danger Zone', { exact: true }).click();
    await picker.getByRole('button', { name: 'Copy profile', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Create profile', exact: true })
      .getByRole('button', { name: 'Back to profiles', exact: true })
      .click();
    assert.equal((await api('/api/profiles')).length, 2);
    await page.keyboard.press('Escape');
    await page.locator('.profile-current:focus').waitFor();

    // A failed real editor save must be resolved before any profile lock request.
    let rejectSaves = true,
      lockRequests = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url() === `${url}/api/profiles/${first.id}/lock`)
        lockRequests++;
    });
    await page.route(`**/api/profiles/${first.id}/notes/*`, async (route) => {
      if (rejectSaves && route.request().method() === 'PUT')
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'FICTIONAL_SAVE_FAILURE',
              message: 'Fictional save held for this test.',
            },
          }),
        });
      else await route.continue();
    });
    async function editWithFailedSave(text: string) {
      const failed = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          response.url().includes(`/api/profiles/${first.id}/notes/`) &&
          response.status() === 503,
      );
      await page.getByLabel('Pronouns', { exact: true }).fill(text);
      await failed;
      await page.getByRole('alert').filter({ hasText: 'Fictional save held' }).waitFor();
    }
    async function requestLock() {
      await page.locator('.profile-current').click();
      await picker.getByRole('button', { name: 'Lock profile', exact: true }).click();
    }
    async function recoverFirst() {
      await picker.getByRole('button', { name: new RegExp(`^${first.name} Locked`) }).click();
      await unlock.getByLabel('Recovery key', { exact: true }).fill(firstRecovery);
      await unlock.getByRole('button', { name: 'Open profile', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Recovery unlocked', exact: true })
        .getByRole('button', { name: 'Skip', exact: true })
        .click();
      await displayedName.waitFor();
    }
    const guard = page.getByRole('dialog', {
      name: 'Save changes before continuing?',
      exact: true,
    });
    await editWithFailedSave('Fictional saved choice');
    await requestLock();
    await guard.waitFor();
    await capture('save-or-discard');
    await guard.getByRole('button', { name: 'Back', exact: true }).click();
    assert.equal(lockRequests, 0);
    assert.equal(
      await page.getByLabel('Pronouns', { exact: true }).inputValue(),
      'Fictional saved choice',
    );
    await picker.getByRole('button', { name: 'Lock profile', exact: true }).click();
    await guard.getByRole('button', { name: 'Save and continue', exact: true }).click();
    await guard.getByRole('alert').waitFor();
    assert.equal(lockRequests, 0, 'failed Save and continue cannot send the lock request');
    assert.equal(
      (await api(`/api/profiles/${first.id}/notes/patient`)).person.pronouns,
      'they/them',
    );
    rejectSaves = false;
    await guard.getByRole('button', { name: 'Save and continue', exact: true }).click();
    await page.getByRole('button', { name: 'Choose profile', exact: true }).click();
    await picker.getByRole('button', { name: new RegExp(`^${first.name} Locked`) }).waitFor();
    assert.equal(lockRequests, 1);
    await recoverFirst();
    assert.equal(
      await page.getByLabel('Pronouns', { exact: true }).inputValue(),
      'Fictional saved choice',
    );
    rejectSaves = true;
    await editWithFailedSave('Fictional discarded choice');
    await requestLock();
    await guard.getByRole('button', { name: 'Discard and continue', exact: true }).click();
    await page.getByRole('button', { name: 'Choose profile', exact: true }).click();
    await picker.getByRole('button', { name: new RegExp(`^${first.name} Locked`) }).waitFor();
    assert.equal(lockRequests, 2);
    rejectSaves = false;
    await recoverFirst();
    assert.equal(
      await page.getByLabel('Pronouns', { exact: true }).inputValue(),
      'Fictional saved choice',
      'discard preserves the last accepted version',
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    const navigation = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await navigation.locator('.profile-current').click();
    await picker.getByRole('button', { name: 'Back to navigation', exact: true }).click();
    // Radix restores focus after the child dialog finishes closing.
    await navigation.locator('.profile-current:focus').waitFor();
    assert.equal(
      await navigation.evaluate((element) => element.contains(document.activeElement)),
      true,
    );
    await navigation.getByRole('button', { name: 'Close navigation', exact: true }).click();
    await page.getByRole('radio', { name: 'System', exact: true }).check();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await api(`/api/profiles/${first.id}/lock`, 'POST', {});
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'Choose profile', exact: true }).click();
    await picker.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await picker.getByRole('button', { name: /More actions for/ }).count(), 0);
    await picker.getByRole('button', { name: 'Close dialog', exact: true }).click();
    for (const preference of ['Light', 'Dark', 'System']) {
      await page.getByRole('radio', { name: preference, exact: true }).check();
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        preference === 'Light' ? 'light' : 'dark',
      );
    }
    await capture('homepage');
    await page.getByRole('radio', { name: 'System', exact: true }).check();
    await page.reload();
    await page.getByRole('button', { name: 'Choose profile', exact: true }).click();
    await picker.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.deepEqual(errors, []);
  },
);
