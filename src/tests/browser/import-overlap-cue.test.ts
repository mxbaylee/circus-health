import { fixtureApi, fixtureReview } from './native-intake-fixture.ts';
import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

test(
  'encrypted import shows same-original overlap and opens exact evidence review before acceptance',
  { timeout: 60000 },
  async (t) => {
    const directory = mkdtempSync(resolve(tmpdir(), 'circus-fictional-overlap-'));
    mkdirSync(resolve(directory, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startBrowserRuntime(t, {
      dataDirectory: resolve(directory, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
      assistantOptions: { availability: () => ({ available: false }) },
    });
    const browser = await launchBrowser(t);
    t.after(async () => {
      await browser.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    });
    const page = await newTestPage(browser, { viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const origin = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(origin);
    const seed = await page.evaluate(async () => {
      const request = async (path: string, body?: unknown, raw?: string) => {
        const response = await fetch(path, {
          method: body !== undefined || raw !== undefined ? 'POST' : 'GET',
          headers: {
            'Content-Type': raw !== undefined ? 'application/x-ndjson' : 'application/json',
            ...(raw !== undefined ? { 'X-Filename': 'fictional-two-page-panel.jsonl' } : {}),
          },
          body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        });
        if (!response.ok) throw Error(await response.text());
        return (await response.json()).data;
      };
      const setup = await request('/api/profile-setups', {
        fullName: 'Fictional overlap review',
        birthDate: '1982-04-17',
        name: 'Fictional overlap review',
      });
      const profile = await request(`/api/profile-setups/${setup.setupId}/verify`, {
        acknowledged: true,
        recovery: setup.recoveryKit,
      });
      const prefix = `/api/profiles/${profile.id}`;
      const source = ['Fictional alpha reading', 'Fictional alpha detail']
        .map((label, index) =>
          JSON.stringify({
            format: 'health-record-v1',
            id: `fictional-row-${index}`,
            kind: 'record',
            payload: `Fictional Juniper panel. ${label} 17.50 mg/L on 2026-02-04`,
            provenance: {
              capturedVia: null,
              sourceSystem: 'Fictional Juniper laboratory',
              sourceRecordId: `fictional-row-${index}`,
              evidenceClass: 'provider_export',
              locator: `page ${index + 1} result`,
            },
            coverage: { status: 'partial', notes: [] },
            report: {
              key: 'fictional-panel',
              title: 'Fictional Juniper panel',
              anchor: { locator: 'page 1 heading', text: 'Fictional Juniper panel' },
              subject: null,
            },
            clinical: {
              kind: 'observation',
              subject: 'self',
              testLabel: label,
              valueText: '17.50',
              unit: 'mg/L',
              date: '2026-02-04',
              eventKind: 'performed',
            },
          }),
        )
        .join('\n');
      const uploaded = await request(prefix + '/intakes', undefined, source);
      const path = prefix + '/intakes/' + encodeURIComponent(uploaded.id);
      return { prefix, path };
    });
    const api = fixtureApi(page, origin);
    const reviewPath = seed.path;
    const review = await fixtureReview(api, reviewPath + '/review');
    await api(reviewPath + '/import', {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: [{ recordId: review.records[0].id, action: 'accept', mapping: {} }],
    });
    await page.goto(origin + '/#/import');
    // Await the current browser's bounded metadata/identity preparation, then
    // keep the normal fast assertion for the exact overlap link.
    const readingSince = Date.now();
    const reportReady = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.request().timing().startTime >= readingSince &&
        new URL(response.url()).pathname.startsWith(seed.prefix + '/intakes/report-queue/'),
      { timeout: 0 },
    );
    const identityReady = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.request().timing().startTime >= readingSince &&
        new URL(response.url()).pathname === seed.path + '/identity-review',
      { timeout: 0 },
    );
    await page.reload();
    for (const response of await Promise.all([reportReady, identityReady])) {
      assert.equal(response.status(), 200);
      assert.equal(await response.finished(), null);
    }
    await page
      .getByRole('status')
      .filter({ hasText: 'Checking retained identity evidence…' })
      .waitFor({ state: 'hidden', timeout: 0 });
    const link = page.getByRole('link', { name: 'Check possible overlap', exact: true });
    await link.waitFor();
    assert.equal(await link.count(), 1);
    assert.match(
      await page.locator('body').innerText(),
      /Matching numbers alone do not mean it is the same measurement/,
    );
    const path = process.env.CRS_TEST_SCREENSHOTS;
    if (path) {
      mkdirSync(path, { recursive: true });
      await page.screenshot({ path: resolve(path, 'same-original-overlap.png'), fullPage: true });
    }
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      await link.scrollIntoViewIfNeeded();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (path)
        await page.screenshot({
          path: resolve(path, `same-original-overlap-${viewport.width}.png`),
          fullPage: true,
        });
    }
    await link.click();
    await page.getByText('Review 1 possible related saved record', { exact: true }).click();
    await page.getByRole('region', { name: 'Paired evidence review' }).waitFor();
    const pending = await page.request.get(origin + seed.path + '/review');
    assert(pending.ok());
    const rows = (await fixtureReview(api, seed.path + '/review')).records;
    assert.equal(
      rows.filter((row: { reviewState?: string }) => row.reviewState === 'accepted').length,
      1,
    );
    assert.equal(
      rows.filter((row: { reviewState?: string }) => row.reviewState === 'pending').length,
      1,
    );
    assert.deepEqual(errors, []);
  },
);
