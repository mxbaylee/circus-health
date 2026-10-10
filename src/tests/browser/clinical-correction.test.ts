import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fictionalModel } from '../../server/test/fictional-model.ts';
import type { IntakeReviewRecord, IntakeEvidenceComparison } from '../../shared/intake.ts';
import type { ClinicalRecordSectionPage } from '../../shared/intake-clinical-record-sections.ts';
import {
  fixtureApi,
  fixtureReview,
  fixtureReportUrl,
  fixtureSourcePath,
  fixtureAssertNoAccepted,
} from './native-intake-fixture.ts';

test(
  'encrypted browser corrects a saved result from comparison and returns to the unchanged incoming review',
  { timeout: 60000 },
  async (t) => {
    fictionalModel(t);
    const root = mkdtempSync(resolve(tmpdir(), 'circus-correction-browser-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startBrowserRuntime(t, {
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
      assistantOptions: { availability: () => ({ available: false, readiness: 'unavailable' }) },
    });
    const browser = await launchBrowser(t);
    t.after(async () => {
      if (!completed && !page.isClosed()) {
        const path = process.env.CRS_TEST_SCREENSHOTS || resolve(root, 'screenshots');
        mkdirSync(path, { recursive: true });
        writeFileSync(resolve(path, 'failure.txt'), await page.locator('body').innerText());
        await page.screenshot({ path: resolve(path, 'failure.png'), fullPage: false });
      }
      await browser.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    const page = await newTestPage(browser, { viewport: { width: 1280, height: 900 } });
    let completed = false;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(url);
    const seed = await page.evaluate(async () => {
      const request = async (path: string, body?: unknown, raw?: string) => {
        const response = await fetch(path, {
          method: body !== undefined || raw !== undefined ? 'POST' : 'GET',
          headers: {
            'Content-Type': raw !== undefined ? 'application/x-ndjson' : 'application/json',
            ...(raw !== undefined ? { 'X-Filename': 'fictional-mass-report.jsonl' } : {}),
          },
          body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        });
        if (!response.ok) throw new Error(await response.text());
        return (await response.json()).data;
      };
      const setup = await request('/api/profile-setups', {
        fullName: 'Fictional Iris',
        birthDate: '1982-04-17',
        name: 'Fictional Iris',
      });
      const profile = await request(`/api/profile-setups/${setup.setupId}/verify`, {
        acknowledged: true,
        recovery: setup.recoveryKit,
      });
      const prefix = `/api/profiles/${profile.id}`;
      const original = (id: string) =>
        JSON.stringify({
          format: 'health-record-v1',
          id,
          kind: 'record',
          payload: { literal: 'Fictional sample mass 14.00 mg' },
          provenance: {
            sourceSystem: 'Fictional Brook Lab',
            capturedVia: 'Fictional courier',
            sourceRecordId: id,
            evidenceClass: 'provider_export',
            locator: 'fictional sample ' + id,
          },
          coverage: { status: 'complete_response', notes: [] },
          clinical: {
            kind: 'observation',
            subject: 'self',
            testLabel: 'Fictional sample mass',
            date: '2026-02-10',
            valueText: '12.00',
            unit: 'mg',
          },
        });
      const savedOriginal = original('fictional-saved');
      const first = await request(prefix + '/intakes', undefined, savedOriginal);
      const firstPath = prefix + '/intakes/' + encodeURIComponent(first.id);
      return {
        prefix,
        firstPath,
        incomingOriginal: original('fictional-incoming'),
        originalUrl: first.contentUrl,
        savedOriginal,
      };
    });
    const api = fixtureApi(page, url);
    const savedReview = await fixtureReview(api, seed.firstPath + '/review');
    assert.equal(savedReview.records.length, 1);
    await api(seed.firstPath + '/import', {
      version: savedReview.version,
      reviewToken: savedReview.reviewToken,
      decisions: [{ recordId: savedReview.records[0]!.id, action: 'accept', mapping: {} }],
    });
    const incomingUpload = await page.request.post(url + seed.prefix + '/intakes', {
      headers: {
        Origin: url,
        'Content-Type': 'application/x-ndjson',
        'X-Filename': 'fictional-mass-report.jsonl',
      },
      data: seed.incomingOriginal,
    });
    assert.equal(incomingUpload.status(), 201, await incomingUpload.text());
    const incomingId = (await incomingUpload.json()).data.id as string;
    const incomingPath = seed.prefix + '/intakes/' + encodeURIComponent(incomingId);
    const incomingReview = await fixtureReview(api, incomingPath + '/review');
    assert.equal(incomingReview.records.length, 1);
    const incomingRecord = incomingReview.records[0]!;
    const readComparison = async (record: IntakeReviewRecord) => {
      const page = (await api(incomingPath + '/related-records', {
        proposalId: incomingReview.proposalId,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId,
      })) as ClinicalRecordSectionPage;
      assert.equal(page.format, 'health-clinical-record-section-page-v1');
      assert.equal(page.section, 'comparisons');
      assert.equal(page.total, 1);
      assert.equal(page.items.length, 1);
      assert.equal(page.nextCursor, null);
      const item = page.items[0]!;
      assert.ok(item.control.kind === 'pair');
      assert.equal(item.control.targetAvailable, true);
      let value: unknown;
      if (item.detail.kind === 'value') value = item.detail.value;
      else {
        const chunks: Buffer[] = [];
        let offset: number | null = 0;
        do {
          const fragment = (await api(incomingPath + '/review-record-section-fragment', {
            reference: item.detail.reference,
            offset,
            bytes: 32768,
          })) as { data: string; totalBytes: number; complete: boolean; nextOffset: number | null };
          chunks.push(Buffer.from(fragment.data, 'base64'));
          offset = fragment.nextOffset;
          assert.equal(fragment.complete, offset === null);
        } while (offset !== null);
        const bytes = Buffer.concat(chunks);
        assert.equal(bytes.length, item.detail.reference.bytes);
        value = JSON.parse(bytes.toString('utf8'));
      }
      const pair = value as { comparison: IntakeEvidenceComparison | null };
      assert.ok(pair.comparison);
      assert.equal(pair.comparison.id, item.control.otherRecordId);
      return pair.comparison;
    };
    const savedId = (await readComparison(incomingRecord)).id;
    await page.goto(url + (await fixtureReportUrl(api, seed.prefix, incomingId)));
    await page.reload();
    await page.locator('.import-detail-record-link').first().click();
    const related = page.locator('.intake-related-disclosure');
    await related.waitFor();
    if (!(await related.evaluate((element) => element.hasAttribute('open'))))
      await page.getByText('Review 1 possible related saved record', { exact: true }).click();
    const comparison = page.getByRole('region', { name: 'Paired evidence review' });
    await comparison.locator('details > summary').first().click();
    await comparison.getByRole('button', { name: 'Correct this saved record' }).click();
    const dialog = page.getByRole('dialog', { name: 'Correct saved record' });
    await dialog.getByLabel('Result', { exact: true }).fill('14.00');
    await dialog
      .getByLabel('Why this saved interpretation is being corrected')
      .fill('The fictional original prints 14.00 mg.');
    await dialog.getByRole('button', { name: 'Review before and after' }).click();
    await page.getByRole('dialog', { name: 'Review correction' }).waitFor();
    const visuals = process.env.CRS_TEST_SCREENSHOTS || resolve(root, 'screenshots');
    mkdirSync(visuals, { recursive: true });
    for (const theme of ['light', 'dark']) {
      for (const mobile of [false, true]) {
        await page.setViewportSize(
          mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        );
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
          document.documentElement.style.colorScheme = value;
        }, theme);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({
          path: resolve(visuals, `correction-${theme}-${mobile ? 'mobile' : 'desktop'}.png`),
          fullPage: false,
          animations: 'disabled',
        });
      }
    }
    await page.getByRole('button', { name: 'Apply reviewed correction' }).click();
    await page.getByRole('dialog', { name: 'Correction saved' }).waitFor();
    await page.getByRole('button', { name: 'Return to import review' }).click();
    assert.equal(new URL(page.url()).hash.includes(encodeURIComponent(incomingId)), true);
    const get = async (path: string) => {
      const response = await page.request.get(url + path);
      assert.equal(response.status(), 200);
      return (await response.json()).data;
    };
    const result = await get(seed.prefix + '/tests/' + encodeURIComponent(savedId));
    assert.equal(result.valueText, '14.00');
    assert.equal(result.unit, 'mg');
    const retained = await page.request.get(url + fixtureSourcePath(seed.prefix, seed.originalUrl));
    assert.equal(retained.status(), 200);
    assert.equal(await retained.text(), seed.savedOriginal);
    await fixtureAssertNoAccepted(api, seed.prefix, incomingId);
    const pending = await fixtureReview(api, incomingPath + '/review');
    assert.equal(pending.records[0].candidateVersionId, incomingRecord.candidateVersionId);
    assert.deepEqual(pending.records[0].draft, incomingRecord.draft);
    assert.equal((await readComparison(pending.records[0]!)).mapping.valueText, '14.00');
    await page.goto(url + '/#/tests?result=' + encodeURIComponent(savedId) + '&detail=1');
    await page.getByRole('button', { name: 'More entry actions' }).click();
    await page.getByRole('button', { name: 'Correct saved record', exact: true }).click();
    const savedDialog = page.getByRole('dialog', { name: 'Correct saved record' });
    assert.equal(await savedDialog.getByLabel('Result', { exact: true }).inputValue(), '14.00');
    assert.equal(
      await savedDialog.getByRole('button', { name: 'Review before and after' }).isDisabled(),
      true,
    );
    await page.keyboard.press('Escape');
    await savedDialog.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'Comparison settings', exact: true }).click();
    const settings = page.getByRole('dialog');
    await settings.getByLabel('Unit family').selectOption('mass');
    for (const [label, value] of Object.entries({
      'Quantity being measured': 'specimen_mass',
      'Body region': 'not_applicable',
      Specimen: 'fictional_sample',
      'Measurement method': 'gravimetry',
      'Result meaning': 'sample_mass',
    }))
      await settings.getByLabel(label, { exact: true }).fill(value);
    await settings
      .getByLabel('Reason for this review')
      .fill('Reviewed the fictional sample mass and source method.');
    await settings.getByRole('button', { name: 'Preview settings', exact: true }).click();
    await page.getByRole('button', { name: 'Apply reviewed settings', exact: true }).click();
    await settings.waitFor({ state: 'hidden' });
    await page.getByRole('combobox', { name: 'Chart display units' }).selectOption('g');
    await page.getByText('Recorded values (1)', { exact: true }).click();
    await page.getByText('0.014 g', { exact: true }).waitFor();
    const converted = await get(
      seed.prefix + '/trends?ids=' + encodeURIComponent(result.testTypeId) + '&unit=g',
    );
    assert.equal(converted[0].points[0].valueText, '14.00');
    assert.equal(converted[0].points[0].unit, 'mg');
    assert.equal(converted[0].points[0].measurement.conversion.exactDecimal, '0.014');
    await page.reload();
    await page.getByRole('combobox', { name: 'Chart display units' }).waitFor();
    assert.equal(
      await page.getByRole('combobox', { name: 'Chart display units' }).inputValue(),
      'g',
    );
    // Arrange the second accepted assertion only after proving correction did not accept it.
    const review = await fixtureReview(api, incomingPath + '/review');
    await api(incomingPath + '/import', {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: [{ recordId: review.records[0].id, action: 'accept', mapping: {} }],
    });
    await page.reload();
    await page.getByRole('button', { name: 'Review another accepted record' }).click();
    const picker = page.getByRole('dialog', { name: 'Choose another measurement' });
    await picker.getByRole('button', { name: /Fictional sample mass/ }).click();
    const pairDialog = page.getByRole('dialog', { name: 'Review record relationship' });
    await pairDialog.getByRole('button', { name: 'Back to records' }).click();
    await picker.getByRole('button', { name: /Fictional sample mass/ }).click();
    await pairDialog.getByLabel('Display decision').selectOption('prefer_left');
    await pairDialog
      .getByLabel('Review reason', { exact: true })
      .fill('The fictional reports refer to the same sample; prefer its corrected extraction.');
    await pairDialog.getByRole('checkbox', { name: /I reviewed both retained originals/ }).check();
    await pairDialog.getByRole('button', { name: 'Review decision', exact: true }).click();
    await page.getByRole('button', { name: 'Apply reviewed decision' }).click();
    const savedPair = page.getByRole('dialog', { name: 'Relationship saved' });
    await savedPair.getByRole('button', { name: 'Close', exact: true }).last().click();
    await page.getByText(/2 recorded results · 1 plotted · 1 reviewed event/).waitFor();
    const both = await get(seed.prefix + '/trends?ids=' + encodeURIComponent(result.testTypeId));
    assert.equal(both[0].points.length, 2);
    assert.equal(
      both[0].points.filter(
        (point: { relationship: { display: { visibleByDefault: boolean } } }) =>
          point.relationship.display.visibleByDefault,
      ).length,
      1,
    );
    await page.getByRole('button', { name: 'Review display decision' }).click();
    await page.getByLabel('Display decision').selectOption('withdraw');
    await page
      .getByLabel('Review reason', { exact: true })
      .fill('Return both source assertions to the chart.');
    await page.getByRole('button', { name: 'Review decision', exact: true }).click();
    await page.getByRole('button', { name: 'Apply reviewed decision' }).click();
    await savedPair.getByRole('button', { name: 'Close', exact: true }).last().click();
    await page.getByText(/2 recorded results · 2 plotted/).waitFor();
    assert.deepEqual(errors, []);
    completed = true;
  },
);
