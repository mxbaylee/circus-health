import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { stopFixtureImport } from './manual-import-fixture.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const envelope = (id: string, report: string) => ({
  format: 'health-record-v1',
  id,
  kind: 'record',
  subject: 'self',
  payload: { literal: `${report}\nGlucose 87 mg/dL on 2026-08-10` },
  report: {
    key: id,
    title: report,
    subject: null,
    anchor: { locator: 'Fictional page 1', text: report },
  },
  clinical: {
    kind: 'observation',
    subject: 'self',
    testLabel: 'Glucose',
    valueText: '87',
    unit: 'mg/dL',
    date: '2026-08-10',
  },
  provenance: {
    capturedVia: null,
    sourceSystem: 'Fictional Cedar Clinic',
    sourceRecordId: id,
    evidenceClass: 'provider_export',
    locator: 'Fictional page 1',
  },
  coverage: { status: 'complete_response', notes: [] },
});

test('Import detail keeps a readable record and reachable explicit actions on mobile', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-mobile-review-actions-'));
  mkdirSync(resolve(root, 'data'));
  const runtimeDirectory = createTestRuntimeDirectory();
  const runtime = await startBrowserRuntime(t, {
    dataDirectory: resolve(root, 'data'),
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
    rmSync(root, { recursive: true, force: true });
  });
  const page = await newTestPage(browser, { viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;

  await page.goto(url);
  const profileId = await page.evaluate(async () => {
    const post = async (path: string, body: unknown) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()).data;
    };
    const setup = await post('/api/profile-setups', {
      fullName: 'Fictional mobile review',
      birthDate: '1982-04-17',
      name: 'Fictional mobile review',
      placebo: false,
    });
    const profile = await post(`/api/profile-setups/${setup.setupId}/verify`, {
      acknowledged: true,
      recovery: setup.recoveryKit,
    });
    return profile.id as string;
  });
  const prefix = `/api/profiles/${profileId}`;
  const saved = await page.request.post(url + prefix + '/intakes', {
    headers: {
      Origin: url,
      'Content-Type': 'application/x-ndjson',
      'X-Filename': 'fictional-saved-glucose.jsonl',
    },
    data: Buffer.from(
      `${JSON.stringify(envelope('fictional-saved-glucose', 'Fictional saved report'))}\n`,
    ),
  });
  assert.equal(saved.status(), 201);
  const savedIntake = await stopFixtureImport(page, url, prefix, (await saved.json()).data.id);
  const savedReviewResponse = await page.request.get(
    url + prefix + `/intakes/${encodeURIComponent(savedIntake.id)}/review`,
    { headers: { Origin: url } },
  );
  assert(savedReviewResponse.ok(), await savedReviewResponse.text());
  const savedReview = (await savedReviewResponse.json()).data;
  const savedImport = await page.request.post(
    url + prefix + `/intakes/${encodeURIComponent(savedIntake.id)}/import`,
    {
      headers: { Origin: url },
      data: {
        version: savedReview.version,
        reviewToken: savedReview.reviewToken,
        decisions: [{ recordId: savedReview.records[0].id, action: 'accept', mapping: {} }],
      },
    },
  );
  assert(savedImport.ok(), await savedImport.text());

  const createReview = async (id: string, report: string) => {
    const uploaded = await page.request.post(url + prefix + '/intakes', {
      headers: {
        Origin: url,
        'Content-Type': 'text/plain',
        'X-Filename': `${id}.txt`,
      },
      data: Buffer.from(`${report}\nGlucose 87 mg/dL on 2026-08-10`),
    });
    assert.equal(uploaded.status(), 201);
    const intake = await stopFixtureImport(page, url, prefix, (await uploaded.json()).data.id);
    const proposed = await page.request.post(
      url + prefix + `/intakes/${encodeURIComponent(intake.id)}/proposals`,
      {
        headers: { Origin: url },
        data: {
          version: intake.version,
          summary: `Fictional review for ${report}`,
          jsonlText: JSON.stringify(envelope(id, report)),
        },
      },
    );
    assert(proposed.ok(), await proposed.text());
    return (await proposed.json()).data;
  };
  const selected = await createReview('fictional-cedar-report', 'Fictional Cedar Clinic report');
  await createReview('fictional-maple-report', 'Fictional Maple Clinic report');

  await page.goto(`${url}/#/import?intake=${encodeURIComponent(selected.id)}`);
  await page.reload();
  await page.locator('.import-detail-record-link').first().click();
  await page.getByRole('heading', { name: 'Glucose' }).waitFor();
  const workspace = page.locator('.intake-review-layout');
  assert.equal(
    await workspace
      .locator(':scope > [role="tabpanel"]')
      .first()
      .evaluate((element) =>
        [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join('')
          .trim(),
      ),
    '',
    'empty reading notes do not print a stray zero beside the record',
  );
  const actionFooter = page.getByRole('region', { name: 'Review actions' });
  assert.equal(
    await actionFooter.getByRole('button', { name: 'Confirm and save record' }).count(),
    1,
  );
  assert.equal(
    await workspace.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
    ),
    2,
    'desktop keeps review fields and the retained original side by side',
  );

  const screenshots = process.env.CRS_TEST_SCREENSHOTS;
  if (screenshots) mkdirSync(screenshots, { recursive: true });
  for (const [name, viewport] of [
    ['portrait', { width: 390, height: 844 }],
    ['landscape', { width: 844, height: 390 }],
    ['reflow', { width: 640, height: 800 }],
  ] as const) {
    await page.setViewportSize(viewport);
    assert.equal(
      await workspace.evaluate((element) => {
        // The responsive workspace uses block flow. Its inactive grid declaration
        // can still serialize minmax() values, which are not rendered columns.
        if (getComputedStyle(element).display !== 'block') return false;
        const children = [...element.children]
          .map((child) => child.getBoundingClientRect())
          .filter((box) => box.width > 0 && box.height > 0);
        return children.every((box, index) =>
          index === 0 ? true : box.top >= children[index - 1].bottom - 1,
        );
      }),
      true,
      `${name} stacks the rendered review workspace without overlapping columns`,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
      `${name} has no horizontal page overflow`,
    );
    if (name === 'landscape') {
      const detail = await page.locator('.import-detail').boundingBox();
      assert(detail && detail.width > 560, 'landscape gives the selected report usable width');
      const title = page.getByRole('article', { name: 'Glucose' }).locator('strong').first();
      assert.equal(
        await title.evaluate((element) => {
          const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
          return element.getBoundingClientRect().height <= lineHeight * 1.5;
        }),
        true,
        'the record title remains on one line in phone landscape',
      );
      await page.getByText('Review 1 possible related saved record', { exact: true }).click();
      const comparison = page.getByRole('region', { name: 'Paired evidence review' });
      await comparison.locator('details > summary').first().click();
      assert.equal(
        await comparison
          .locator('.clinical-evidence-pair')
          .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
        1,
        'incoming and saved evidence stack within the phone-landscape content width',
      );
      if (screenshots)
        await comparison.locator('.clinical-evidence-pair').screenshot({
          animations: 'disabled',
          path: resolve(screenshots, 'mobile-review-landscape-evidence-dark.png'),
        });
    }

    await actionFooter.scrollIntoViewIfNeeded();
    const footerBox = await actionFooter.boundingBox();
    assert(
      footerBox && footerBox.y >= 0 && footerBox.y < viewport.height,
      `${name} can scroll the explicit review actions into view: ${JSON.stringify(footerBox)}`,
    );
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
        document.documentElement.style.colorScheme = value;
      }, theme);
      if (screenshots)
        await page.screenshot({
          animations: 'disabled',
          path: resolve(screenshots, `mobile-review-${name}-${theme}.png`),
        });
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const result = page.getByLabel('Result', { exact: true });
  await result.waitFor({ state: 'visible' });
  await result.focus();
  await result.scrollIntoViewIfNeeded();
  const resultBox = await result.boundingBox();
  const focusedFooterBox = await actionFooter.boundingBox();
  assert(
    resultBox &&
      (!focusedFooterBox ||
        focusedFooterBox.y >= 844 ||
        resultBox.y + resultBox.height < focusedFooterBox.y),
    'the sticky actions do not cover a keyboard-focused editor field',
  );
  await page.getByRole('tab', { name: 'Original' }).click();
  await page.getByRole('button', { name: 'Back to report' }).click();
  assert.equal(
    await page
      .getByRole('tab', { name: 'Details' })
      .evaluate((element) => element === document.activeElement),
    true,
    'returning from Original restores focus to Details',
  );
  assert.deepEqual(errors, []);
});
