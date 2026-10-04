import {
  fixtureReview,
  fixtureProposalId,
  fixtureReportUrl,
  fixtureSourcePath,
  fixtureBrowserResponse,
  fixtureNativeReportReady,
  fixtureNativeRecordReady,
} from './native-intake-fixture.ts';
import { launchBrowser, newTestPage } from './harness.ts';
import { startProcessRuntime } from './process-runtime.ts';
import { stopFixtureImport } from './manual-import-fixture.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { Browser, Response } from 'playwright';
import type { IntakeReportAcceptanceRequest } from '../../shared/intake.ts';
import type { CollectionReportDetail } from '../../shared/intake-clinical-pages.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

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
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-browser-mapping-shapes-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startProcessRuntime(t, {
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
    const page = await newTestPage(browser);
    const url = `http://127.0.0.1:${runtime.port}`;
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
      const proposalId = await fixtureProposalId(api, prefix, item.id);
      const reviewPath = path + '/review?proposalId=' + encodeURIComponent(proposalId);
      const originalReview = await fixtureReview(api, reviewPath);
      assert.deepEqual(originalReview.records[0].mapping.opticalPrescription, optical);
      assert.equal(
        originalReview.records[0].issues!.find(
          (issue: { kind: string }) => issue.kind === 'identity',
        )?.status,
        'unresolved',
        'The destination mapping does not replace explicit identity review',
      );
      const reportUrl = await fixtureReportUrl(api, prefix, item.id);
      const groupId = new URLSearchParams(reportUrl.split('?')[1]).get('group')!;
      const reportScope = { intakeId: item.id, groupId };
      const recordScope = {
        intakeId: item.id,
        proposalId,
        recordId: originalReview.records[0].id,
        candidateVersionId: originalReview.records[0].candidateVersionId,
      };
      await page.goto('about:blank');
      await fixtureNativeReportReady(page, prefix, reportScope, () => page.goto(url + reportUrl));
      const exactLinks = page.locator('.import-detail-record-link:not([data-saved-record-id])');
      await exactLinks.first().waitFor();
      assert.equal(await exactLinks.count(), 1, 'The report keeps one exact optical record link');
      await fixtureNativeRecordReady(page, prefix, recordScope, () => exactLinks.first().click());
      // The native report identity remains informational when no printed subject exists.
      await page
        .getByText('Identity is not printed clearly in this report.', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('region', { name: 'Report identity', exact: true }).count(),
        0,
        'missing report identity does not invent a report-level confirmation; the record-level answer remains separate',
      );
      await page.getByRole('button', { name: 'This is me', exact: true }).waitFor();
      assert.equal(await page.getByRole('article').count(), 1);
      await capture(clinical ? 'proposed-review' : 'top-level-review');
      assert.equal(await page.getByRole('button', { name: 'This is me', exact: true }).count(), 1);
      await page.getByRole('button', { name: 'This is me', exact: true }).click();
      const choice = page.getByRole('button', { name: 'March 8, 2017', exact: true });
      assert.equal(await choice.count(), 1, 'Related date questions share one decision');
      const choiceSince = Date.now();
      const choiceSaved = fixtureBrowserResponse(
        page,
        (response) =>
          new URL(response.url()).pathname === path + '/review-draft' &&
          response.request().method() === 'POST' &&
          response.request().timing().startTime >= choiceSince &&
          response.request().postDataJSON().recordId === recordScope.recordId &&
          response.request().postDataJSON().candidateVersionId === recordScope.candidateVersionId &&
          response.request().postDataJSON().mapping?.documentDate === '2017-03-08',
      );
      const choiceRead = fixtureBrowserResponse(page, async (response) => {
        const selected = new URL(response.url());
        if (
          selected.pathname !== path + '/review-record' ||
          selected.searchParams.get('recordId') !== recordScope.recordId ||
          response.request().method() !== 'GET' ||
          response.request().timing().startTime < choiceSince
        )
          return false;
        if (!response.ok()) return true;
        const read = (await response.json()).data;
        return (
          read.record.kind === 'record' &&
          read.record.record.candidateVersionId === recordScope.candidateVersionId &&
          read.record.record.mapping.documentDate === '2017-03-08'
        );
      });
      await choice.click();
      const choiceResponse = await choiceSaved;
      assert.equal(choiceResponse.status(), 200, await choiceResponse.text());
      assert.equal(await choiceResponse.finished(), null);
      const refreshedChoice = await choiceRead;
      assert.equal(refreshedChoice.status(), 200, await refreshedChoice.text());
      assert.equal(await refreshedChoice.finished(), null);
      if (clinical) {
        // Both shape fixtures describe independent retained source occurrences.
        // Review their relationship before accepting the second prescription.
        const related = page.locator('details.intake-related-disclosure');
        const summary = related.locator(':scope > summary');
        await summary.waitFor();
        if (!(await related.evaluate((element) => (element as HTMLDetailsElement).open)))
          await summary.click();
        const paired = page.getByRole('region', { name: 'Paired evidence review' });
        assert.equal(await paired.count(), 1);
        await paired.locator('summary').click();
        await paired
          .getByRole('group', { name: 'Relationship with this record', exact: true })
          .getByRole('combobox')
          .selectOption('distinct');
        const reason =
          'Independent fictional source record identifiers; retain both prescriptions.';
        await paired.getByLabel('Reason for this relationship', { exact: true }).fill(reason);
        const relationshipSaved = fixtureBrowserResponse(
          page,
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === path + '/review-record-action',
        );
        await fixtureNativeRecordReady(page, prefix, recordScope, async () => {
          await paired.getByRole('button', { name: 'Save this relationship', exact: true }).click();
          const response = await relationshipSaved;
          assert.equal(response.status(), 200, await response.text());
          assert.equal(await response.finished(), null);
          const command = response.request().postDataJSON();
          assert.equal(command.recordId, recordScope.recordId);
          assert.equal(command.pair.outcome, 'distinct');
          assert.equal(command.pair.reason, reason);
        });
      }
      const accepted = fixtureBrowserResponse(
        page,
        (response) => response.url().endsWith('/intakes/report-acceptance') && response.ok(),
      );
      await page.getByRole('button', { name: 'Confirm and save record', exact: true }).click();
      const acceptedResponse = await accepted;
      const acceptedResult = (await acceptedResponse.json()).data;
      assert.equal(acceptedResult.receipt.acceptedCount, 1);
      await page
        .getByText('This exact record was saved to your profile.', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Confirm and save record', exact: true }).count(),
        0,
      );
      const stored = await fixtureReview(api, reviewPath);
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
      const original = await page.request.get(url + fixtureSourcePath(prefix, item.contentUrl));
      assert.equal(await original.text(), 'Fictional retained original ' + clinical);
      const proposal = await page.request.get(
        url + prefix + '/sources/' + encodeURIComponent(proposalId) + '/content',
      );
      assert.deepEqual(JSON.parse(await proposal.text()), value);
      await page.goto('about:blank');
      await fixtureNativeReportReady(page, prefix, reportScope, () =>
        page.goto(url + '/#/import?intake=' + encodeURIComponent(item.id)),
      );
      const overviewDestination = page.getByRole('region', {
        name: 'Saved destinations for this report',
      });
      await overviewDestination.getByRole('link').waitFor();
      assert.equal(await overviewDestination.getByRole('link').count(), 1);
      await fixtureNativeRecordReady(page, prefix, recordScope, () =>
        page.locator('.import-detail-record-link:not([data-saved-record-id])').first().click(),
      );
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
    const initialQueue = await fixtureReview(api, queuePath + '/review');
    assert.equal(initialQueue.records.length, 20);
    const queueReportUrl = await fixtureReportUrl(api, prefix, queueItem.id);
    const queueGroupId = new URLSearchParams(queueReportUrl.split('?')[1]).get('group')!;
    const queueLinkSelector = '.import-detail-record-link:not([data-saved-record-id])';
    function acknowledgementTime(response: Response) {
      const timing = response.request().timing();
      assert.ok(timing.responseStart >= 0);
      return timing.startTime + timing.responseStart;
    }
    async function reportAfterAcknowledgement(acknowledgedAt: () => number | undefined) {
      const response = await fixtureBrowserResponse(page, (response) => {
        const since = acknowledgedAt();
        const selected = new URL(response.url());
        return (
          since !== undefined &&
          response.request().method() === 'GET' &&
          response.request().timing().startTime >= since &&
          selected.pathname ===
            prefix + '/intakes/report-queue/' + encodeURIComponent(queueGroupId) &&
          selected.searchParams.get('intakeId') === queueItem.id
        );
      });
      assert.equal(response.status(), 200);
      assert.equal(await response.finished(), null);
      const detail = (await response.json()).data as CollectionReportDetail;
      assert.equal(detail.format, 'health-intake-report-detail-v2');
      assert.equal(detail.group.intakeId, queueItem.id);
      assert.equal(detail.group.groupId, queueGroupId);
      return detail;
    }
    async function assertQueuePage(detail: CollectionReportDetail) {
      assert.equal(detail.records.totalRecords, 20, 'The complete report still has twenty records');
      const expectedIds = detail.records.records.map((row) =>
        row.kind === 'record' ? row.record.id : row.selection.recordId,
      );
      await page.waitForFunction(
        ({ selector, expected }) => {
          const ids = Array.from(document.querySelectorAll<HTMLAnchorElement>(selector), (link) =>
            new URLSearchParams(new URL(link.href).hash.split('?')[1]).get('record'),
          );
          return JSON.stringify(ids) === JSON.stringify(expected);
        },
        { selector: queueLinkSelector, expected: expectedIds },
        { timeout: 5000 },
      );
      assert.deepEqual(
        await page
          .locator(queueLinkSelector)
          .evaluateAll((links) =>
            links.map((link) =>
              new URLSearchParams(new URL((link as HTMLAnchorElement).href).hash.split('?')[1]).get(
                'record',
              ),
            ),
          ),
        expectedIds,
        'Every displayed link selects the exact record in this bounded report page',
      );
      return expectedIds;
    }
    async function openQueueRecord(index: number, refreshedReport?: CollectionReportDetail) {
      let firstPage: CollectionReportDetail;
      if (refreshedReport) {
        // The record link came from this report. Browser Back changes the feed
        // scope, so await the actual report read after that native feed refresh.
        const current = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
        assert.equal(current.get('intake'), queueItem.id);
        assert.equal(current.get('group'), queueGroupId);
        assert.equal(current.get('record'), initialQueue.records[index - 1].id);
        firstPage = await fixtureNativeReportReady(
          page,
          prefix,
          { intakeId: queueItem.id, groupId: queueGroupId },
          () => page.goBack(),
        );
        await page.waitForURL(url + queueReportUrl);
        assert.equal(firstPage.records.version, refreshedReport.records.version);
      } else {
        // A fresh document sees API-seeded records through one actual browser read.
        await page.goto('about:blank');
        firstPage = await fixtureNativeReportReady(
          page,
          prefix,
          { intakeId: queueItem.id, groupId: queueGroupId },
          () => page.goto(url + queueReportUrl),
        );
      }
      const firstIds = await assertQueuePage(firstPage);
      if (index === 0) {
        // The byte budget can split this report before the record-count limit.
        // Traverse the real page controls to retain the complete twenty-link oracle.
        const allIds = [...firstIds];
        const cursors = new Set<string>();
        let detail = firstPage;
        while (detail.records.nextCursor) {
          assert.ok(!cursors.has(detail.records.nextCursor), 'Report pagination never loops');
          cursors.add(detail.records.nextCursor);
          detail = await fixtureNativeReportReady(
            page,
            prefix,
            { intakeId: queueItem.id, groupId: queueGroupId },
            () => page.getByRole('button', { name: 'Next report records', exact: true }).click(),
          );
          allIds.push(...(await assertQueuePage(detail)));
        }
        assert.equal(new Set(allIds).size, 20, 'All twenty exact record links appear once');
        assert.deepEqual(
          allIds,
          initialQueue.records.map((record) => record.id),
          'Report pages retain every exact record link in order without gaps or duplicates',
        );
        if (cursors.size) {
          await page.getByRole('button', { name: 'First report records', exact: true }).click();
          await assertQueuePage(firstPage);
        }
      }
      const targetId = initialQueue.records[index].id;
      const targetIndex = firstIds.indexOf(targetId);
      assert.ok(targetIndex >= 0, 'The selected review record is on the first bounded page');
      await fixtureNativeRecordReady(
        page,
        prefix,
        {
          intakeId: queueItem.id,
          proposalId: initialQueue.proposalId,
          recordId: initialQueue.records[index].id,
          candidateVersionId: initialQueue.records[index].candidateVersionId,
        },
        () => page.locator(queueLinkSelector).nth(targetIndex).click(),
      );
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
    let saveAcknowledgedAt: number | undefined;
    const firstSave = fixtureBrowserResponse(page, (response) => {
      if (
        !response.url().endsWith(prefix + '/intakes/report-acceptance') ||
        response.request().method() !== 'POST'
      )
        return false;
      const request = response.request().postDataJSON() as IntakeReportAcceptanceRequest;
      if (
        !request.blocks.some(
          (block) =>
            block.intakeId === queueItem.id &&
            block.selections.some((selection) => selection.recordId === initialQueue.records[0].id),
        )
      )
        return false;
      saveAcknowledgedAt = acknowledgementTime(response);
      return true;
    });
    const savedReportRead = reportAfterAcknowledgement(() => saveAcknowledgedAt);
    await page.getByRole('button', { name: 'Confirm and save record', exact: true }).click();
    const savedReceipt = await firstSave;
    assert.equal(savedReceipt.status(), 200);
    assert.equal(await savedReceipt.finished(), null);
    assert.equal((await savedReceipt.json()).data.receipt.acceptedCount, 1);
    const savedReport = await savedReportRead;
    const savedRow = savedReport.records.records.find(
      (row) =>
        (row.kind === 'record' ? row.record.id : row.selection.recordId) ===
        initialQueue.records[0].id,
    );
    assert.equal(savedRow?.queueState, 'accepted');
    await openQueueRecord(1, savedReport);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].blocks.length, 1);
    assert.equal(imports[0].blocks[0].intakeId, queueItem.id);
    assert.deepEqual(
      imports[0].blocks[0].selections.map((selection) => selection.recordId),
      [initialQueue.records[0].id],
    );
    assert.equal(
      (await fixtureReview(api, queuePath + '/review')).records.filter(
        (record: { reviewState?: string }) => record.reviewState === 'accepted',
      ).length,
      1,
    );
    let deferAcknowledgedAt: number | undefined;
    const deferredSave = fixtureBrowserResponse(page, (response) => {
      if (
        !response.url().endsWith(queuePath + '/review-draft') ||
        response.request().method() !== 'POST'
      )
        return false;
      const request = response.request().postDataJSON();
      if (request.recordId !== initialQueue.records[1].id || request.disposition !== 'review_later')
        return false;
      deferAcknowledgedAt = acknowledgementTime(response);
      return true;
    });
    const deferredReportRead = reportAfterAcknowledgement(() => deferAcknowledgedAt);
    await page
      .locator('.intake-guided-actions')
      .getByRole('button', { name: 'Review later', exact: true })
      .click();
    const deferReceipt = await deferredSave;
    assert.equal(deferReceipt.status(), 200);
    assert.equal(await deferReceipt.finished(), null);
    const deferredReport = await deferredReportRead;
    const deferredRow = deferredReport.records.records.find(
      (row) =>
        (row.kind === 'record' ? row.record.id : row.selection.recordId) ===
        initialQueue.records[1].id,
    );
    assert.equal(deferredRow?.queueState, 'deferred');
    await openQueueRecord(2, deferredReport);
    assert.equal(await page.getByRole('article').count(), 1);
    let editAcknowledgedAt: number | undefined;
    const edited = fixtureBrowserResponse(page, (response) => {
      if (
        !response.url().endsWith(queuePath + '/review-draft') ||
        response.request().method() !== 'POST' ||
        response.request().postDataJSON().mapping?.valueText !== '18.5'
      )
        return false;
      editAcknowledgedAt = acknowledgementTime(response);
      return true;
    });
    // Qualify a completed save followed by reload. Observe the actual post-edit
    // selected record, report and feed reads before exercising that reload.
    const editReads = Promise.all(
      [
        queuePath + '/review-record',
        prefix + '/intakes/report-queue/' + encodeURIComponent(queueGroupId),
        prefix + '/intakes/import-feed',
      ].map(async (path) => {
        const response = await fixtureBrowserResponse(
          page,
          (response) =>
            editAcknowledgedAt !== undefined &&
            response.request().method() === 'GET' &&
            response.request().timing().startTime >= editAcknowledgedAt &&
            new URL(response.url()).pathname === path,
        );
        assert.equal(response.status(), 200);
        assert.equal(await response.finished(), null);
        return (await response.json()).data;
      }),
    );
    await page.getByLabel('Result', { exact: true }).fill('18.5');
    const editReceipt = await edited;
    assert.equal(editReceipt.status(), 200);
    assert.equal(await editReceipt.finished(), null);
    const [editedRecord, editedReport, editedFeed] = await editReads;
    assert.equal(editedRecord.format, 'health-intake-clinical-record-v2');
    assert.equal(
      editedRecord.record.kind === 'record'
        ? editedRecord.record.record.id
        : editedRecord.record.selection.recordId,
      initialQueue.records[2].id,
    );
    if (editedRecord.record.kind === 'record')
      assert.equal(editedRecord.record.record.draft.mapping.valueText, '18.5');
    assert.equal(editedReport.format, 'health-intake-report-detail-v2');
    assert.equal(editedReport.records.version, editedRecord.context.version);
    assert.equal(editedFeed.format, 'health-intake-import-feed-v2');
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
    await fixtureNativeRecordReady(
      page,
      prefix,
      {
        intakeId: queueItem.id,
        proposalId: initialQueue.proposalId,
        recordId: initialQueue.records[2].id,
        candidateVersionId: initialQueue.records[2].candidateVersionId,
      },
      () => page.reload(),
    );
    assert.equal(await page.getByLabel('Result', { exact: true }).inputValue(), '18.5');
    const resumedQueue = await fixtureReview(api, queuePath + '/review');
    assert.equal(resumedQueue.records[0].reviewState, 'accepted');
    assert.equal(resumedQueue.records[1].draft!.disposition, 'review_later');
    assert.equal(resumedQueue.records[2].draft!.mapping.valueText, '18.5');
    assert.equal(imports.length, 1, 'Reload and draft review never accept more records');
    assert.equal(await page.locator('.import-detail').count(), 1);
    await capture('guided-queue-resumed');
    const queueOriginal = await page.request.get(
      url + fixtureSourcePath(prefix, queueItem.contentUrl),
    );
    assert.deepEqual(await queueOriginal.body(), queueBytes);
    assert.deepEqual(errors, []);
  },
);
