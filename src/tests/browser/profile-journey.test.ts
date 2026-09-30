import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { NoteHistoryEntry } from '../../shared/api.ts';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const unavailableLiteLlm = () => ({
  available: false,
  backend: 'litellm',
  model: 'fictional-browser-alias',
  readiness: 'unavailable',
  capabilities: { tools: null, images: null },
});

test(
  'real browser creates, edits, imports originals, locks and recovers encrypted profiles',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-browser-'));
    const visuals = process.env.CRS_TEST_SCREENSHOTS || resolve(root, 'screenshots');
    mkdirSync(visuals, { recursive: true });
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startBrowserRuntime(t, {
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
      assistantOptions: { availability: unavailableLiteLlm },
    });
    const browser = await launchBrowser(t);
    t.after(async () => {
      await browser.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    const page = await newTestPage(browser, { viewport: { width: 1280, height: 900 } }),
      errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    async function chooseFiles(file: { name: string; mimeType: string; buffer: Buffer }) {
      await page.locator('input[type=file]').waitFor();
      await page.waitForFunction(() => {
        const input = document.querySelector('input[type=file]');
        return input && !(input as HTMLInputElement).disabled;
      });
      const uploaded = page.waitForResponse(
        (response) => response.request().method() === 'POST' && response.url().endsWith('/intakes'),
      );
      await page.locator('input[type=file]').setInputFiles(file);
      const response = await uploaded;
      assert(response.ok(), await response.text());
    }

    await page.goto(url);
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('Display name', { exact: true })
      .fill('Fictional Browser Person');
    const profileCreation = page.getByRole('dialog', { name: 'Create profile', exact: true });
    await profileCreation.getByLabel('Your name').fill('Fictional Browser Person');
    await profileCreation.getByLabel('Date of birth', { exact: true }).fill('1982-04-17');
    await page.getByRole('button', { name: 'Continue to recovery key' }).click();
    const recovery = await page.getByLabel('Recovery key', { exact: true }).inputValue();
    assert.equal(recovery.split(' ').length, 24);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
      document.documentElement.style.colorScheme = 'light';
    });
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({
      animations: 'disabled',
      path: resolve(visuals, 'profile-setup-light-desktop.png'),
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
      document.documentElement.style.colorScheme = 'dark';
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({
      animations: 'disabled',
      path: resolve(visuals, 'profile-setup-dark-mobile.png'),
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
      document.documentElement.style.colorScheme = 'light';
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByLabel('I have saved my recovery key').check();
    await page.getByRole('button', { name: 'Verify recovery key', exact: true }).click();
    await page.getByLabel('Recovery key').fill(recovery);
    await page.getByRole('button', { name: 'Open profile' }).click();
    const recoveryChoice = page.getByRole('dialog', { name: 'Recovery unlocked', exact: true });
    await recoveryChoice.getByRole('button', { name: 'Add passkey', exact: true }).waitFor();
    await recoveryChoice.getByRole('button', { name: 'Skip', exact: true }).click();
    {
      const setupDialog = page.getByRole('dialog', { name: 'Care contacts' });
      for (const step of ['Primary care provider', 'Emergency contact']) {
        await setupDialog.getByRole('heading', { name: step, exact: true }).waitFor();
        await setupDialog.getByRole('button', { name: 'Skip for now' }).click();
      }
      await setupDialog.waitFor({ state: 'hidden' });
    }
    await page.getByRole('button', { name: 'Open assistant' }).click();
    const assistant = page.getByRole('dialog', { name: 'Moxie the Assistant' });
    const connection = assistant.getByRole('button', { name: 'Connection: unavailable' });
    await connection.waitFor();
    await connection.click();
    const diagnostics = page.getByRole('dialog', { name: 'Moxie connection' });
    await diagnostics.getByText('fictional-browser-alias').waitFor();
    assert.match((await diagnostics.textContent())!, /LiteLLM.*Unavailable/s);
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      assert.equal(
        await diagnostics.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const topmost = document.elementFromPoint(rect.x + rect.width / 2, rect.y + 40);
          return element.contains(topmost);
        }),
        true,
        'nested diagnostics must remain above the assistant and its overlay',
      );
    }
    assert.equal(await assistant.getByText('Connect your agent', { exact: true }).count(), 0);
    await diagnostics.getByRole('button', { name: 'Back to chat' }).click();
    await page.waitForFunction(() =>
      document.activeElement?.classList.contains('assistant-connection-trigger'),
    );
    assert.equal(await connection.evaluate((element) => element === document.activeElement), true);
    await assistant.getByRole('button', { name: 'Close assistant' }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url + '/#/notes');
    await page.getByText('Annual Planning', { exact: true }).waitFor();
    assert.equal(await page.getByText('Annual Planning', { exact: true }).count(), 1);
    await page.goto(url);
    await page.getByPlaceholder('Name shown throughout the app').waitFor();
    const saveNow = page.getByRole('button', { name: 'Save now', exact: true });
    assert.equal(await saveNow.isDisabled(), true, 'unchanged Self has nothing to save');
    for (const theme of ['light', 'dark'])
      for (const [size, viewport] of [
        ['desktop', { width: 1280, height: 900 }],
        ['mobile', { width: 390, height: 844 }],
      ] as const) {
        await page.setViewportSize(viewport);
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.colorScheme = theme;
        }, theme);
        await saveNow.scrollIntoViewIfNeeded();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.evaluate(async () => {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        await page.screenshot({
          path: resolve(visuals, `save-disabled-${theme}-${size}.png`),
          animations: 'disabled',
        });
      }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
      document.documentElement.style.colorScheme = 'light';
    });
    await page.getByLabel('Pronouns', { exact: true }).fill('they/them');
    assert.equal(await saveNow.isEnabled(), true, 'a pending edit enables Save now');
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && r.url().includes('/notes/') && r.ok(),
    );
    await saveNow.click();
    await saved;
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent.trim() === 'Save now',
        )?.disabled,
    );
    await page.reload();
    await page.getByLabel('Pronouns', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Pronouns', { exact: true }).inputValue(), 'they/them');

    // Restoration uses the actual history disclosure and publishes a new version.
    await page.getByLabel('Pronouns', { exact: true }).fill('she/her');
    const edited = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && r.url().includes('/notes/') && r.ok(),
    );
    await page.getByRole('button', { name: 'Save now', exact: true }).click();
    await edited;
    await page.getByRole('button', { name: 'More entry actions' }).click();
    const historyResponse = page.waitForResponse((r) => r.url().includes('/history') && r.ok());
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const history = (await (await historyResponse).json()).data;
    const prior = history.entries.find((entry: NoteHistoryEntry) =>
      entry.fields.some(
        (field) => field.path === 'person.pronouns' && field.previous.value === 'they/them',
      ),
    );
    assert(prior, 'The earlier saved pronouns remain in history');
    const dialog = page.getByRole('dialog', { name: 'Saved history' });
    await dialog.getByLabel('Saved state').selectOption(prior.generationId);
    await dialog.getByRole('checkbox', { name: 'Pronouns', exact: true }).check();
    await dialog.getByRole('button', { name: 'Preview restoration' }).click();
    await dialog.getByRole('region', { name: 'Restoration preview' }).waitFor();
    const restoration = page.waitForResponse(
      (r) => r.url().endsWith('/restore') && r.request().method() === 'POST' && r.ok(),
    );
    await dialog.getByRole('button', { name: 'Restore selected changes' }).click();
    const restored = (await (await restoration).json()).data;
    assert.equal(restored.note.person.pronouns, 'they/them');
    assert(restored.note.version > history.currentVersion);
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByLabel('Pronouns', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Pronouns', { exact: true }).inputValue(), 'they/them');

    await page.goto(url + '/#/import');
    const envelope = {
      format: 'health-record-v1',
      id: 'browser-result',
      kind: 'record',
      payload: { literal: '7.5' },
      provenance: {
        capturedVia: 'Fictional delivery',
        sourceSystem: 'Fictional clinic',
        sourceRecordId: 'browser-result',
        evidenceClass: 'provider_export',
        locator: 'row 1',
      },
      coverage: { status: 'complete_response', notes: [] },
      clinical: {
        kind: 'observation',
        subject: 'self',
        testLabel: 'Fictional Example',
        valueText: '7.5',
        unit: 'mg/L',
        date: '2026-09-01',
      },
    };
    const original = Buffer.from(JSON.stringify(envelope) + '\n');
    const receipt = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/intakes'),
    );
    await chooseFiles({
      name: 'fictional-results.jsonl',
      mimeType: 'application/x-ndjson',
      buffer: original,
    });
    const uploadResponse = await receipt;
    assert(uploadResponse.ok(), await uploadResponse.text());
    assert.equal((await uploadResponse.json()).data.state, 'ready');
    await page.getByRole('button', { name: 'Confirm & save', exact: true }).click();
    await page
      .getByRole('region', { name: 'Save outcomes' })
      .getByRole('status')
      .getByText('1 saved', { exact: true })
      .waitFor();
    const profile = (await (await page.request.get(url + '/api/profiles')).json()).data[0];
    const deliveries = (
      await (await page.request.get(`${url}/api/profiles/${profile.id}/intakes`)).json()
    ).data;
    const downloaded = await page.request.get(url + deliveries[0].contentUrl);
    assert(downloaded.ok());
    assert.deepEqual(await downloaded.body(), original);

    // Newly accepted prescriptions are inactive until this profile owner enables
    // one. A repeated import must keep that personal selection.
    await page.goto(url + '/#/import');
    const prescriptionEnvelope = {
      format: 'health-record-v1',
      id: 'browser-prescription',
      kind: 'record',
      payload: { literal: 'Fictional prescription' },
      provenance: {
        capturedVia: 'Fictional delivery',
        sourceSystem: 'Fictional clinic',
        sourceRecordId: 'browser-prescription',
        evidenceClass: 'provider_export',
        locator: 'row 1',
      },
      coverage: { status: 'complete_response', notes: [] },
      clinical: {
        kind: 'medication',
        subject: 'self',
        medicationName: 'Fictional Browser Medicine',
        date: '2026-09-01',
        doseText: '10 mg',
        medicationKind: 'order',
      },
    };
    const prescriptionOriginal = Buffer.from(JSON.stringify(prescriptionEnvelope) + '\n');
    await chooseFiles({
      name: 'fictional-prescriptions.jsonl',
      mimeType: 'application/x-ndjson',
      buffer: prescriptionOriginal,
    });
    await page.getByRole('button', { name: 'Confirm & save', exact: true }).click();
    await page
      .getByRole('region', { name: 'Save outcomes' })
      .getByRole('status')
      .getByText('1 saved', { exact: true })
      .waitFor();
    await page.goto(url + '/#/medications');
    await page.getByRole('button', { name: 'Activate prescriptions', exact: true }).click();
    await page.getByRole('region', { name: 'Activate imported prescriptions' }).waitFor();
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
      document.documentElement.style.colorScheme = 'light';
    });
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({
      animations: 'disabled',
      path: resolve(visuals, 'prescription-activation-light-desktop.png'),
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
      document.documentElement.style.colorScheme = 'dark';
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({
      animations: 'disabled',
      path: resolve(visuals, 'prescription-activation-dark-mobile.png'),
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
      document.documentElement.style.colorScheme = 'light';
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: /Fictional Browser Medicine/ }).click();
    const active = page.getByRole('switch', { name: 'Active' });
    assert.equal(await active.isChecked(), false);
    const activated = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().includes('/current-status') && r.ok(),
    );
    await active.click();
    await activated;
    await page.reload();
    // Active selection stays pinned even after it leaves the Inactive list.
    assert.equal(await page.getByRole('switch', { name: 'Active' }).isChecked(), true);
    await page.goto(url + '/#/import');
    await chooseFiles({
      name: 'fictional-prescriptions-retry.jsonl',
      mimeType: 'application/x-ndjson',
      buffer: prescriptionOriginal,
    });
    // A different filename retains a new source occurrence; linking its matching
    // clinical record still requires explicit acceptance.
    await page.getByRole('button', { name: 'Confirm & save', exact: true }).click();
    await page
      .getByRole('region', { name: 'Save outcomes' })
      .getByRole('status')
      .getByText('1 saved', { exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: 'Confirm & save', exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(
      await page.getByRole('button', { name: 'Confirm & save', exact: true }).count(),
      0,
    );
    await page.goto(url + '/#/medications?status=all');
    await page.getByRole('button', { name: /Fictional Browser Medicine/ }).click();
    await page.getByRole('button', { name: 'More entry actions', exact: true }).click();
    assert.equal(await page.getByRole('switch', { name: 'Active' }).isChecked(), true);

    // Similar dates/labels only offer paired evidence; the explicit decision
    // retains both conflicting assertions and both original downloads.
    await page.goto(url + '/#/import');
    const secondEnvelope = {
      ...envelope,
      id: 'browser-second-result',
      provenance: { ...envelope.provenance, sourceRecordId: 'browser-second-result' },
      clinical: { ...envelope.clinical, valueText: '9.25' },
    };
    const secondOriginal = Buffer.from(JSON.stringify(secondEnvelope) + '\n');
    await chooseFiles({
      name: 'fictional-second-results.jsonl',
      mimeType: 'application/x-ndjson',
      buffer: secondOriginal,
    });
    // Open this exact retained record; the old report-row/inbox subview was removed.
    await page
      .getByRole('button', { name: 'More actions for Fictional Example', exact: true })
      .click();
    await page.getByRole('link', { name: 'Open full review' }).click();
    await page.getByRole('region', { name: 'Review actions' }).waitFor();
    const related = page.locator('details.intake-related-disclosure');
    const relatedSummary = related.locator(':scope > summary');
    await relatedSummary.waitFor();
    if (!(await related.evaluate((element) => (element as HTMLDetailsElement).open)))
      await relatedSummary.click();
    const paired = page.getByRole('region', { name: 'Paired evidence review' });
    await paired.locator('summary').click();
    await paired.getByLabel('Relationship to Fictional Example').selectOption('distinct');
    await paired
      .getByLabel('What the originals establish')
      .fill('Two separate source record identifiers; retain both literal values.');
    const links = await paired
      .getByRole('link', { name: 'Open original' })
      .evaluateAll((elements) => elements.map((element) => (element as HTMLAnchorElement).href));
    assert.equal(links.length, 2);
    const originals = await Promise.all(
      links.map(async (link) =>
        Buffer.from(await (await page.request.get(link)).body()).toString(),
      ),
    );
    assert(originals.includes(original.toString()));
    assert(originals.includes(secondOriginal.toString()));
    await page.getByRole('button', { name: 'Confirm and save record', exact: true }).click();
    await page.getByText('This exact record was saved to your profile.', { exact: true }).waitFor();
    await page.reload();
    await page
      .getByText('This exact record is already saved to your profile.', { exact: true })
      .waitFor();
    const retained = (
      await (await page.request.get(`${url}/api/profiles/${profile.id}/intakes`)).json()
    ).data.find((item: { filename: string }) => item.filename === 'fictional-second-results.jsonl');
    const savedReview = (
      await (
        await page.request.get(
          `${url}/api/profiles/${profile.id}/intakes/${encodeURIComponent(retained.id)}/review`,
        )
      ).json()
    ).data;
    assert.equal(savedReview.records[0].comparisons[0].previousDecision.outcome, 'distinct');
    await page.goto(url);
    await page.getByLabel('Pronouns', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Fictional Browser Person', exact: true }).click();
    await page.getByRole('button', { name: 'Lock profile', exact: true }).click();
    await page.getByRole('button', { name: 'Choose profile', exact: true }).click();
    await page.getByRole('button', { name: /Fictional Browser Person.*Locked/ }).click();
    await page.getByLabel('Recovery key', { exact: true }).fill(recovery);
    await page.getByRole('button', { name: 'Open profile', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Recovery unlocked', exact: true })
      .getByRole('button', { name: 'Add passkey', exact: true })
      .waitFor();
    await page
      .getByRole('dialog', { name: 'Recovery unlocked', exact: true })
      .getByRole('button', { name: 'Skip', exact: true })
      .click();
    await page.getByLabel('Pronouns', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Pronouns', { exact: true }).inputValue(), 'they/them');

    // A second profile must never inherit the first profile's clinical records.
    await page.getByRole('button', { name: 'Fictional Browser Person', exact: true }).click();
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('Display name', { exact: true })
      .fill('Second Fictional Person');
    await profileCreation.getByLabel('Your name').fill('Second Fictional Person');
    await profileCreation.getByLabel('Date of birth', { exact: true }).fill('1982-04-17');
    await page.getByRole('button', { name: 'Continue to recovery key' }).click();
    const secondRecovery = await page.getByLabel('Recovery key', { exact: true }).inputValue();
    assert.notEqual(secondRecovery, recovery);
    await page.getByLabel('I have saved my recovery key').check();
    await page.getByRole('button', { name: 'Verify recovery key', exact: true }).click();
    await page.getByLabel('Recovery key').fill(secondRecovery);
    await page.getByRole('button', { name: 'Open profile' }).click();
    await recoveryChoice.getByRole('button', { name: 'Add passkey', exact: true }).waitFor();
    await recoveryChoice.getByRole('button', { name: 'Skip', exact: true }).click();
    {
      const setupDialog = page.getByRole('dialog', { name: 'Care contacts' });
      for (const step of ['Primary care provider', 'Emergency contact']) {
        await setupDialog.getByRole('heading', { name: step, exact: true }).waitFor();
        await setupDialog.getByRole('button', { name: 'Skip for now' }).click();
      }
      await setupDialog.waitFor({ state: 'hidden' });
    }
    await page.goto(url + '/#/notes');
    await page.getByText('Annual Planning', { exact: true }).waitFor();
    assert.equal(await page.getByText('Annual Planning', { exact: true }).count(), 1);
    await page.goto(url + '/#/');
    await page.getByPlaceholder('Name shown throughout the app').waitFor();
    await page.goto(url + '/#/sources');
    await page.getByRole('heading', { name: 'Sources', exact: true }).waitFor();
    assert.equal(await page.getByText('fictional-results.jsonl', { exact: true }).count(), 0);
    const allProfiles = (await (await page.request.get(url + '/api/profiles')).json()).data;
    const second = allProfiles.find(
      (p: { id: string; name: string }) => p.name === 'Second Fictional Person',
    );
    assert.equal(
      (await (await page.request.get(`${url}/api/profiles/${second.id}/intakes`)).json()).data
        .length,
      0,
    );
    assert.deepEqual(errors, []);
  },
);
