import { stopFixtureImport } from './manual-import-fixture.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { Browser } from 'playwright';
import type { IntakeReportAcceptanceRequest } from '../../shared/intake.ts';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startRuntime } from '../../server/runtime.ts';

const optical = {
  type: 'spectacle',
  prescribedDateText: '03/08/2017',
  eyes: [
    {
      side: 'right',
      sph: { valueText: '+1.75' },
      cyl: { valueText: '-2.50' },
      axis: { valueText: '007' },
    },
    {
      side: 'left',
      sph: { valueText: '-0.50' },
      cyl: { valueText: '-1.25' },
      axis: { valueText: '142' },
    },
  ],
  pd: { valueText: '30.5 / 31.0' },
};
const envelope = (proposed: boolean) => ({
  format: 'health-record-v1',
  id: proposed ? 'fictional-proposed-optical' : 'fictional-top-level-optical',
  kind: 'document',
  subject: 'unknown',
  payload: proposed
    ? { text: 'Fictional Avery Lens 03/08/2017 prescription', opticalPrescription: optical }
    : 'Fictional Avery Lens 03/08/2017 prescription',
  ...(proposed
    ? {
        proposedClinicalMapping: {
          kind: 'document',
          subject: 'unknown',
          documentTitle: 'Fictional proposed prescription',
          date: '03/08/2017',
          documentDate: '03/08/2017',
        },
      }
    : { opticalPrescription: optical }),
  provenance: {
    capturedVia: null,
    sourceSystem: null,
    sourceRecordId: proposed ? 'shape-proposed' : 'shape-top',
    evidenceClass: 'transcription',
    locator: 'Fictional original page 1',
  },
  coverage: { status: 'complete_response', notes: ['One fictional page supplied'] },
  reviewIssues: [
    {
      id: 'identity',
      kind: 'identity',
      field: 'subject',
      prompt: 'Does Fictional Avery Lens refer to you?',
    },
    {
      id: 'date',
      kind: 'date',
      field: 'date',
      prompt: 'Confirm the fictional prescription date',
      textAnchor: '03/08/2017',
      choices: [
        { label: 'March 8, 2017', value: '2017-03-08' },
        { label: 'August 3, 2017', value: '2017-08-03' },
      ],
    },
    {
      id: 'document-date',
      kind: 'date',
      field: 'documentDate',
      prompt: 'Confirm the same document date',
      textAnchor: '03/08/2017',
      choices: [
        { label: 'March 8, 2017', value: '2017-03-08' },
        { label: 'August 3, 2017', value: '2017-08-03' },
      ],
    },
  ],
});

test(
  'encrypted browser accepts both proposed and top-level optical mappings through grouped identity and date review',
  { timeout: 90000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-browser-mapping-shapes-'));
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
    const page = await browser.newPage();
    page.setDefaultTimeout(12000);
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(url);
    const setup = await page.evaluate(async () => {
      const api = async (path: string, body?: unknown) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(await response.text());
        return (await response.json()).data;
      };
      const runtime = await (await fetch('/api/runtime')).json();
      if (!runtime.encrypted) throw Error('Encrypted runtime required');
      const setup = await api('/api/profile-setups', {
        fullName: 'Fictional mapping shapes browser',
        birthDate: '1982-04-17',
        name: 'Fictional mapping shapes browser',
      });
      const profile = await api(`/api/profile-setups/${setup.setupId}/verify`, {
        acknowledged: true,
        recovery: setup.recoveryKit,
      });
      return { profileId: profile.id, recovery: setup.recoveryKit };
    });
    const prefix = `/api/profiles/${setup.profileId}`;
    const api = async (path: string, body?: unknown) => {
      const response =
        body === undefined
          ? await page.request.get(url + path)
          : await page.request.post(url + path, { headers: { Origin: url }, data: body });
      const json = await response.json();
      assert(response.ok(), JSON.stringify(json));
      return json.data;
    };
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const screenshots =
      process.env.CRS_TEST_SCREENSHOTS || resolve(tmpdir(), 'circus-import-shapes-visual');
    mkdirSync(screenshots, { recursive: true });
    async function capture(stage: string) {
      for (const theme of ['light', 'dark']) {
        for (const mobile of [false, true]) {
          await page.setViewportSize(
            mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          );
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.colorScheme = theme;
          }, theme);
          await page.evaluate(async () => {
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
          });
          assert(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth + 1,
            ),
            `${stage} ${theme} ${mobile ? 'mobile' : 'desktop'} has no horizontal page overflow`,
          );
          await page.screenshot({
            animations: 'disabled',
            path: resolve(
              screenshots,
              stage + '-' + theme + '-' + (mobile ? 'mobile' : 'desktop') + '.png',
            ),
            fullPage: true,
          });
        }
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    for (const clinical of [false, true]) {
      const value = envelope(clinical);
      const uploaded = await page.request.post(url + prefix + '/intakes', {
        headers: {
          Origin: url,
          'Content-Type': 'text/plain',
          'X-Filename': 'fictional-review.txt',
        },
        data: Buffer.from('Fictional retained original ' + clinical),
      });
      assert.equal(uploaded.status(), 201);
      let item = await stopFixtureImport(page, url, prefix, (await uploaded.json()).data.id);
      item = await api(`${prefix}/intakes/${encodeURIComponent(item.id)}/proposals`, {
        version: item.version,
        summary: 'Fictional draft regression',
        jsonlText: JSON.stringify(value),
      });
      const path = `${prefix}/intakes/${encodeURIComponent(item.id)}`;
      const reviewPath = path + '/review?proposalId=' + encodeURIComponent(item.proposals[0].id);
      const originalReview = await api(reviewPath);
      assert.deepEqual(originalReview.records[0].mapping.opticalPrescription, optical);
      assert.equal(
        originalReview.records[0].issues.find(
          (issue: { kind: string }) => issue.kind === 'identity',
        )?.status,
        'unresolved',
        'The destination mapping does not replace explicit identity review',
      );
      await page.goto(url + '/#/import?intake=' + encodeURIComponent(item.id));
      await page.reload();
      const exactLinks = page.locator('.import-detail-record-link:not([data-saved-record-id])');
      await exactLinks.first().waitFor();
      assert.equal(await exactLinks.count(), 1, 'The report keeps one exact optical record link');
      await exactLinks.first().click();
      // No shared printed subject exists in this fixture. Its header review is
      // informational; the explicit record-level identity answer stays separate.
      await page
        .getByRole('button', { name: 'Review person for this report', exact: true })
        .click();
      const personSidebar = page.getByRole('dialog', { name: 'Who is this report for?' });
      await personSidebar
        .getByText('Identity is not printed clearly in this report.', { exact: true })
        .waitFor();
      assert.equal(
        await personSidebar.getByRole('button', { name: 'This is me', exact: true }).count(),
        0,
      );
      await personSidebar.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('button', { name: 'This is me', exact: true }).waitFor();
      assert.equal(await page.getByRole('article').count(), 1);
      await capture(clinical ? 'proposed-review' : 'top-level-review');
      assert.equal(await page.getByRole('button', { name: 'This is me', exact: true }).count(), 1);
      await page.getByRole('button', { name: 'This is me', exact: true }).click();
      const choice = page.getByRole('button', { name: 'March 8, 2017', exact: true });
      assert.equal(await choice.count(), 1, 'Related date questions share one decision');
      await choice.click();
      const accepted = page.waitForResponse(
        (response) => response.url().endsWith('/intakes/report-acceptance') && response.ok(),
      );
      await page.getByRole('button', { name: 'Confirm and save record', exact: true }).click();
      const acceptedResponse = await accepted;
      const acceptedResult = (await acceptedResponse.json()).data;
      await page
        .getByText('This exact record was saved to your profile.', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Confirm and save record', exact: true }).count(),
        0,
      );
      const stored = await api(reviewPath);
      assert.equal(stored.records[0].mapping.subject, 'self');
      assert.equal(stored.records[0].mapping.date, '2017-03-08');
      assert.equal(stored.records[0].mapping.documentDate, '2017-03-08');
      assert.deepEqual(stored.records[0].mapping.opticalPrescription, optical);
      const prescriptions = await api(prefix + '/vision-prescriptions');
      assert.equal(prescriptions.length, clinical ? 2 : 1);
      await capture(clinical ? 'proposed-saved' : 'top-level-saved');
      const visionRecord = acceptedResult.receipt.receipts
        .flatMap((receipt: { records: { entityId: string; kind: string }[] }) => receipt.records)
        .find((record: { kind: string }) => record.kind === 'document');
      assert(visionRecord, 'The exact acceptance receipt includes the Vision document destination');
      const visionLink = page
        .getByRole('region', { name: 'Saved destination' })
        .getByRole('link')
        .filter({ hasText: visionRecord.title });
      assert.equal(
        await visionLink.getAttribute('href'),
        `#/tests?view=vision&document=${encodeURIComponent(visionRecord.entityId)}&visibility=all`,
      );
      await visionLink.click();
      await page.waitForURL(/view=vision.*document=/);
      await page.getByRole('heading', { name: 'Vision prescription history' }).waitFor();
      await page.getByRole('article').waitFor();
      assert.equal(
        await page.getByRole('article').count(),
        1,
        'Direct link shows the exact accepted document',
      );
      await capture(clinical ? 'proposed-vision' : 'top-level-vision');
      await page.reload();
      await page.getByRole('article').waitFor();
      const original = await page.request.get(url + item.contentUrl);
      assert.equal(await original.text(), 'Fictional retained original ' + clinical);
      const proposal = await page.request.get(url + item.proposals[0].contentUrl);
      assert.deepEqual(JSON.parse(await proposal.text()), value);
      await page.goto(url + '/#/import?intake=' + encodeURIComponent(item.id));
      await page.reload();
      const overviewDestination = page.getByRole('region', {
        name: 'Saved destinations for this report',
      });
      await overviewDestination.getByRole('link').waitFor();
      assert.equal(await overviewDestination.getByRole('link').count(), 1);
      await page.locator('.import-detail-record-link:not([data-saved-record-id])').first().click();
      await page
        .getByText('This exact record is already saved to your profile.', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Confirm and save record', exact: true }).count(),
        0,
      );
    }
    // A realistic queue exercises the actual encrypted import/draft operations,
    // rather than accepting every record in a mocked batch response.
    const queueRecords = Array.from({ length: 20 }, (_, index) => ({
      format: 'health-record-v1',
      id: `fictional-guided-${index + 1}`,
      kind: 'record',
      subject: 'self',
      payload: { result: '18', unit: 'ng/mL', heading: 'Fictional twenty-result report' },
      report: {
        key: 'fictional-twenty-result-report',
        title: 'Fictional twenty-result report',
        subject: null,
        anchor: { locator: 'Report heading', text: 'Fictional twenty-result report' },
      },
      clinical: {
        kind: 'observation',
        subject: 'self',
        testLabel: `Fictional queue result ${index + 1}`,
        valueText: '18',
        unit: 'ng/mL',
        date: '2026-09-01',
      },
      provenance: {
        capturedVia: null,
        sourceSystem: 'Fictional Clinic',
        sourceRecordId: `guided-${index + 1}`,
        evidenceClass: 'provider_export',
        locator: `Fictional row ${index + 1}`,
      },
      coverage: { status: 'complete_response', notes: [] },
    }));
    const queueBytes = Buffer.from(
      queueRecords.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    const queued = await page.request.post(url + prefix + '/intakes', {
      headers: {
        Origin: url,
        'Content-Type': 'application/x-ndjson',
        'X-Filename':
          'fictional-twenty-record-review-with-a-long-original-delivery-filename-for-mobile-layout-checks.jsonl',
      },
      data: queueBytes,
    });
    assert.equal(queued.status(), 201);
    const queueItem = await stopFixtureImport(page, url, prefix, (await queued.json()).data.id);
    const queuePath = `${prefix}/intakes/${encodeURIComponent(queueItem.id)}`;
    const initialQueue = await api(queuePath + '/review');
    assert.equal(initialQueue.records.length, 20);
    async function openQueueRecord(index: number) {
      await page.goto(url + '/#/import?intake=' + encodeURIComponent(queueItem.id));
      // API seeding bypasses the uploader's queue reload; reopen as a user would.
      await page.reload();
      const links = page.locator('.import-detail-record-link:not([data-saved-record-id])');
      await links.first().waitFor();
      assert.equal(await links.count(), 20, 'The report keeps all twenty exact record links');
      await links.nth(index).click();
      await page.getByRole('region', { name: 'Review actions' }).waitFor();
    }
    await openQueueRecord(0);
    assert.equal(await page.getByRole('article').count(), 1);
    await capture('guided-queue-first');
    const imports: IntakeReportAcceptanceRequest[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url().endsWith(prefix + '/intakes/report-acceptance')
      )
        imports.push(request.postDataJSON());
    });
    const firstSave = page.waitForResponse(
      (response) => response.url().endsWith(prefix + '/intakes/report-acceptance') && response.ok(),
    );
    await page.getByRole('button', { name: 'Confirm and save record', exact: true }).click();
    await firstSave;
    await openQueueRecord(1);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].blocks.length, 1);
    assert.equal(imports[0].blocks[0].intakeId, queueItem.id);
    assert.deepEqual(
      imports[0].blocks[0].selections.map((selection) => selection.recordId),
      [initialQueue.records[0].id],
    );
    assert.equal(
      (await api(queuePath + '/review')).records.filter(
        (record: { reviewState: string }) => record.reviewState === 'accepted',
      ).length,
      1,
    );
    const deferredSave = page.waitForResponse(
      async (response) =>
        response.url().endsWith(queuePath + '/review-draft') &&
        response.ok() &&
        (await response.json()).data.workflow.reviewDrafts.at(-1).disposition === 'review_later',
    );
    await page
      .locator('.intake-guided-actions')
      .getByRole('button', { name: 'Review later', exact: true })
      .click();
    await deferredSave;
    await openQueueRecord(2);
    assert.equal(await page.getByRole('article').count(), 1);
    const edited = page.waitForResponse(
      async (response) =>
        response.url().endsWith(queuePath + '/review-draft') &&
        response.ok() &&
        (await response.json()).data.workflow.reviewDrafts.at(-1).mapping.valueText === '18.5',
    );
    await page.getByLabel('Result', { exact: true }).fill('18.5');
    await edited;
    await page.getByRole('tab', { name: 'Details', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert(
      await page
        .getByRole('tab', { name: 'Original', exact: true })
        .evaluate((element) => element === document.activeElement),
    );
    assert(await page.getByRole('tabpanel', { name: 'Original', exact: true }).isVisible());
    assert.equal(
      await page.getByRole('article').count(),
      0,
      'The exact Original tab does not duplicate the record editor',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.getByRole('article').count(),
      0,
      'Mobile switches to the original without showing the record editor',
    );
    await capture('guided-queue-original');
    await page.getByRole('tab', { name: 'Details', exact: true }).click();
    assert.equal(await page.getByRole('article').count(), 1, 'Details restores the exact editor');
    assert.equal(await page.getByLabel('Result', { exact: true }).inputValue(), '18.5');
    await page.reload();
    assert.equal(await page.getByLabel('Result', { exact: true }).inputValue(), '18.5');
    const resumedQueue = await api(queuePath + '/review');
    assert.equal(resumedQueue.records[0].reviewState, 'accepted');
    assert.equal(resumedQueue.records[1].draft.disposition, 'review_later');
    assert.equal(resumedQueue.records[2].draft.mapping.valueText, '18.5');
    assert.equal(imports.length, 1, 'Reload and draft review never accept more records');
    assert.equal(await page.locator('.import-detail').count(), 1);
    await capture('guided-queue-resumed');
    const queueOriginal = await page.request.get(url + queueItem.contentUrl);
    assert.deepEqual(await queueOriginal.body(), queueBytes);
    assert.deepEqual(errors, []);
  },
);
