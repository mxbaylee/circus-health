import { stopFixtureImport } from './manual-import-fixture.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Browser, Locator } from 'playwright';
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRuntime } from '../../server/runtime.ts';

// A standalone one-pixel PNG, not derived from any personal record or screenshot.
const original = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGioAAAAASUVORK5CYII=',
  'base64',
);

test(
  'Import original links open the exact retained image in a separate browser tab',
  { timeout: 90000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-original-links-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startRuntime({
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
      assistantOptions: { availability: () => ({ available: false }) },
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
    page.setDefaultTimeout(12000);
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(url);
    const request = async (path: string, body?: unknown) => {
      const response = await page.request.fetch(url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { Origin: url },
        data: body,
      });
      assert(response.ok(), await response.text());
      return (await response.json()).data;
    };
    const setup = await request('/api/profile-setups', {
      fullName: 'Fictional original links',
      birthDate: '1982-04-17',
      name: 'Fictional original links',
    });
    const profile = await request(`/api/profile-setups/${setup.setupId}/verify`, {
      acknowledged: true,
      recovery: setup.recoveryKit,
    });
    const prefix = `/api/profiles/${profile.id}`;
    const upload = await page.request.post(url + prefix + '/intakes', {
      headers: { Origin: url, 'Content-Type': 'image/png', 'X-Filename': 'fictional-pixel.png' },
      data: original,
    });
    assert.equal(upload.status(), 201);
    const intake = await stopFixtureImport(page, url, prefix, (await upload.json()).data.id);
    await request(`${prefix}/intakes/${encodeURIComponent(intake.id)}/proposals`, {
      version: intake.version,
      summary: 'Independently fictional link navigation fixture.',
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-pixel-result',
        kind: 'record',
        subject: 'self',
        payload: 'Invented link-test measurement, not extracted from the one-pixel original.',
        clinical: {
          kind: 'observation',
          subject: 'self',
          testLabel: 'Fictional link measure',
          valueText: '8',
          unit: 'mm',
          date: '2032-03-04',
          reviewIssues: [
            {
              id: 'value-check',
              kind: 'uncertain_reading',
              field: 'valueText',
              prompt: 'Verify the fictional measurement value.',
            },
          ],
        },
        provenance: {
          capturedVia: 'Prepared fictional link test',
          sourceSystem: null,
          sourceRecordId: 'fictional-pixel-result',
          evidenceClass: 'transcription',
          locator: 'whole fictional image',
        },
        report: {
          key: 'fictional-pixel-report',
          title: 'Fictional link report',
          anchor: { locator: 'whole fictional image', text: 'Prepared link fixture' },
          subject: null,
        },
        coverage: {
          status: 'complete_response',
          notes: ['A synthetic navigation fixture, not extraction accuracy evidence.'],
        },
      }),
    });
    await page.goto(url + '/#/import');
    await page.reload();
    await page.getByText('Fictional link measure', { exact: true }).waitFor();
    const openAndCheck = async (link: Locator) => {
      const openerUrl = page.url();
      const href = await link.getAttribute('href');
      assert(href);
      assert.equal(await link.getAttribute('target'), '_blank');
      const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
      try {
        await popup.waitForLoadState('domcontentloaded');
        assert.equal(popup.url(), new URL(href, url).href);
        const response = await popup.request.get(popup.url());
        assert(response.ok());
        assert.match(response.headers()['content-type'] || '', /image\/png/);
        assert.deepEqual(await response.body(), original);
        assert.equal(await popup.locator('img').count(), 1);
      } finally {
        await popup.close();
      }
      assert.equal(page.url(), openerUrl);
    };
    await page
      .locator('.import-report-header')
      .getByRole('button', {
        name: /^(Add source|Change source: |Change source for )/,
      })
      .click();
    const sourceReview = page.getByRole('dialog');
    await openAndCheck(sourceReview.getByRole('link', { name: /Review .*original/i }));
    await sourceReview.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Original', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Original report' });
    await openAndCheck(dialog.getByRole('link', { name: 'Open retained original' }));
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await page.getByText('Fictional link measure', { exact: true }).count(), 1);

    // The same durable editor is reachable in the record row without navigating away.
    const reviewUrl = page.url();
    await page.locator('button[aria-controls^="record-review-"]').click();
    const inline = page.locator('.import-record-accordion');
    await inline.getByRole('textbox', { name: 'Result', exact: true }).waitFor();
    assert.equal(page.url(), reviewUrl);
    assert.equal(await inline.locator('.import-correction-evidence').isVisible(), true);
    await inline.getByRole('textbox', { name: 'Result', exact: true }).fill('9');
    await inline.getByRole('button', { name: 'Update', exact: true }).click();
    await inline.waitFor({ state: 'detached' });
    await page.reload();
    await page.locator('button[aria-controls^="record-review-"]').click();
    await inline.getByRole('textbox', { name: 'Result', exact: true }).waitFor();
    assert.equal(
      await inline.getByRole('textbox', { name: 'Result', exact: true }).inputValue(),
      '9',
    );
    const screenshots = process.env.CRS_SCREENSHOTS_DIR;
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true });
      await page.screenshot({
        path: resolve(screenshots, 'inline-record-desktop.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: resolve(screenshots, 'inline-record-mobile.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await inline.getByRole('button', { name: 'Close review', exact: true }).click();
    await inline.waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'Confirm & save', exact: true }).click();
    await page.getByRole('status').getByText('Imported 1 record', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Review status' }).selectOption('saved');
    const destination = page.getByRole('link').filter({ hasText: 'Fictional link measure' });
    await destination.click();
    await page.waitForURL(/#\/tests\?result=/);
    const selected = page.getByRole('region', { name: 'Selected result' });
    await selected
      .getByRole('heading', { name: 'Fictional link measure', level: 2, exact: true })
      .waitFor();
    await selected.getByRole('button', { name: 'View source', exact: true }).click();
    const source = page.getByRole('dialog', { name: 'Source evidence' });
    await openAndCheck(source.getByRole('link', { name: /Open original file/ }));
  },
);
