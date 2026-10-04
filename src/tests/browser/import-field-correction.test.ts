import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { stopFixtureImport } from './manual-import-fixture.ts';
import {
  fixtureDestinations,
  fixtureAssertNoAccepted,
  fixtureNativeFeedReady,
  fixtureBrowserResponse,
} from './native-intake-fixture.ts';
import type { CollectionImportFeed } from '../../shared/intake-clinical-pages.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Browser, Locator } from 'playwright';
import type { ClinicalImportCorrectionHistoryPage } from '../../shared/clinical-import-corrections.ts';
import type { readReviewDraftHistoryPage } from '../../server/intake-review-draft-state.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';

for (const scenario of ['value', 'partial', 'date-and-value', 'document', 'unclassified'])
  test(
    scenario === 'partial'
      ? 'partial name/value/unit corrections remain unapprovable until all three are resolved'
      : scenario === 'date-and-value'
        ? 'an optional date warning cannot hide a missing result; partial edits retain correction reasons'
        : `record correction and approval while expanded: ${scenario}`,
    // Three durable corrections, reloads and history reads share this host hang guard.
    { timeout: scenario === 'partial' ? 120000 : 60000 },
    async (t) => {
      const partial = scenario === 'partial';
      const wrongKind = scenario === 'document' || scenario === 'unclassified';
      const dateAndValue = scenario === 'date-and-value' || wrongKind;
      const root = mkdtempSync(resolve(tmpdir(), 'circus-focused-correction-'));
      mkdirSync(resolve(root, 'data'));
      const runtimeDirectory = createTestRuntimeDirectory();
      const runtime = await startBrowserRuntime(t, {
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
        rmSync(root, { recursive: true, force: true });
        rmSync(runtimeDirectory, { recursive: true, force: true });
      });
      browser = await launchBrowser(t);
      const page = await newTestPage(browser, { viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
      const pdfPage = await newTestPage(browser);
      await pdfPage.setContent(
        `<style>@page{size:Letter;margin:50px}body{font-family:Arial;color:#183f50}.page{break-after:page}table{width:100%;border-collapse:collapse;margin-top:30px}td,th{padding:18px;text-align:left;border-bottom:1px solid #bbb}th{background:#eaf1f3}</style><section class="page"><h1>Cookie Doe laboratory report</h1><p>Meadowglass Laboratory</p><p>Patient: Cookie Doe</p><p>DOB: 1986-02-14</p><p>Collected: 2032-03-04</p><p>Supplemental results on page 2.</p><p>Synthetic test data</p></section><section><h1>Supplemental results</h1><p>Cookie Doe | 2032-03-04</p><table><tr><th>Test</th><th>Result</th><th>Unit</th></tr><tr><td>Potassium</td><td>4.1</td><td>mmol/L</td></tr></table><p>Synthetic test data</p></section>`,
      );
      const pdf = await pdfPage.pdf({ printBackground: true, preferCSSPageSize: true });
      await pdfPage.close();
      await page.goto(url);
      async function request(path: string, body?: unknown) {
        const r = await page.request.fetch(url + path, {
          method: body ? 'POST' : 'GET',
          headers: { Origin: url, 'Content-Type': 'application/json' },
          ...(body ? { data: body } : {}),
        });
        assert(r.ok(), await r.text());
        return (await r.json()).data;
      }
      const setup = await request('/api/profile-setups', {
        fullName: 'Cookie Doe',
        name: 'Cookie Doe',
        birthDate: '1986-02-14',
      });
      const profile = await request(`/api/profile-setups/${setup.setupId}/verify`, {
        acknowledged: true,
        recovery: setup.recoveryKit,
      });
      const prefix = `/api/profiles/${profile.id}`;
      const upload = await page.request.post(url + prefix + '/intakes', {
        headers: {
          Origin: url,
          'Content-Type': 'application/pdf',
          'X-Filename': 'cookie-doe-lab.pdf',
        },
        data: pdf,
      });
      assert.equal(upload.status(), 201);
      const intake = await stopFixtureImport(page, url, prefix, (await upload.json()).data.id);
      await request(`${prefix}/intakes/${intake.id}/proposals`, {
        version: intake.version,
        summary: 'Fictional controlled correction fixture',
        jsonlText: [
          JSON.stringify({
            format: 'health-record-v1',
            id: 'cookie-context',
            kind: 'context',
            contextId: 'cookie-context',
            payload: {
              contextId: 'cookie-context',
              branding: 'Meadowglass Laboratory',
              text: 'Cookie Doe laboratory report\nCookie Doe\nDOB: 1986-02-14\nMeadowglass Laboratory',
            },
            report: {
              key: 'cookie-report',
              title: 'Cookie Doe laboratory results',
              anchor: { locator: 'page 1', text: 'Cookie Doe laboratory report' },
              subject: { locator: 'page 1', text: 'Cookie Doe' },
            },
            provenance: {
              capturedVia: 'Fictional UI test',
              sourceSystem: null,
              sourceRecordId: null,
              evidenceClass: 'transcription',
              locator: 'page 1',
            },
            coverage: { status: 'partial', notes: [] },
          }),
          JSON.stringify({
            format: 'health-record-v1',
            id: 'cookie-result',
            contextId: 'cookie-context',
            reviewIssues: [
              {
                kind: 'identity',
                field: 'subject',
                prompt: 'Confirm that the displayed report subject is Self before saving records.',
                textAnchor: 'Cookie Doe',
              },
            ],
            kind: 'record',
            subject: 'self',
            payload: 'Cookie Doe. Potassium 4.1 mmol/L. 2032-03-04.',
            clinical: {
              kind: wrongKind
                ? scenario === 'document'
                  ? 'document'
                  : 'unsupported'
                : 'observation',
              documentTitle: 'Potassium',
              subject: 'self',
              testLabel: partial ? '' : 'Potassium',
              valueText: '',
              unit: partial ? '' : 'mmol/L',
              status: 'final',
              date: dateAndValue ? '' : '2032-03-04',
              reviewIssues: [
                ...(partial
                  ? [
                      {
                        id: 'cookie-name',
                        kind: 'uncertain_reading',
                        field: 'testLabel',
                        prompt: 'Verify the test name.',
                      },
                      {
                        id: 'cookie-unit',
                        kind: 'uncertain_reading',
                        field: 'unit',
                        prompt: 'Verify the result unit.',
                      },
                    ]
                  : []),
                ...(dateAndValue
                  ? []
                  : [
                      {
                        id: 'cookie-value',
                        kind: 'uncertain_reading',
                        field: 'valueText',
                        prompt: 'Check the potassium value in the original.',
                      },
                    ]),
              ],
            },
            provenance: {
              capturedVia: 'Fictional UI test',
              sourceSystem: null,
              sourceRecordId: 'cookie-result',
              evidenceClass: 'transcription',
              locator: 'original page 2 supplemental table Potassium result cell',
            },
            report: {
              key: 'cookie-report',
              title: 'Cookie Doe laboratory results',
              anchor: { locator: 'page 1', text: 'Cookie Doe laboratory report' },
              subject: { locator: 'page 1', text: 'Cookie Doe' },
            },
            coverage: {
              status: 'complete_response',
              notes: ['Controlled fictional UI fixture; no extraction accuracy claim.'],
            },
          }),
        ].join('\n'),
      });
      await page.goto(url + '/#/import');
      await fixtureNativeFeedReady(page, prefix, () => page.reload());
      await page.getByRole('button', { name: 'Review', exact: true }).waitFor();
      if (!wrongKind) {
        assert.match(await page.locator('.import-record-row').innerText(), /Value to review/);
        assert(
          await page.getByRole('button', { name: 'Confirm & save', exact: true }).isDisabled(),
        );
      }
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      assert.equal(new URL(page.url()).hash, '#/import');
      const inline = page.locator('.import-record-accordion');
      const updateCorrection = async () => {
        const saved = fixtureBrowserResponse(
          page,
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname ===
              `${prefix}/intakes/${encodeURIComponent(intake.id)}/review-draft`,
        );
        await inline.getByRole('button', { name: 'Update', exact: true }).click();
        const response = await saved;
        assert.equal(response.status(), 200, await response.text());
        assert.equal(await response.finished(), null);
        await inline.waitFor({ state: 'detached' });
      };
      await inline.getByRole('img', { name: 'cookie-doe-lab.pdf, page 2 of 2' }).waitFor();
      if (wrongKind) {
        await inline.getByLabel('Document text', { exact: true }).waitFor();
        await inline.getByLabel('Record type', { exact: true }).selectOption('observation');
      }
      for (const label of ['Test name', 'Result', 'Unit', 'Date'])
        assert.equal(await inline.getByLabel(label, { exact: true }).count(), 1);
      assert.equal(await inline.getByLabel('Date', { exact: true }).getAttribute('type'), 'date');
      assert.equal(await inline.getByText(/Extracted text/).count(), 0);
      assert.equal(
        await inline.getByRole('button', { name: 'Confirm and save record' }).count(),
        0,
      );
      const screenshots = process.env.CRS_SCREENSHOTS_DIR;
      if (screenshots && !partial) {
        mkdirSync(screenshots, { recursive: true });
        await inline.screenshot({ path: resolve(screenshots, 'focused-correction-desktop.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await inline.screenshot({ path: resolve(screenshots, 'focused-correction-mobile.png') });
        await page.setViewportSize({ width: 1280, height: 900 });
      }
      if (partial) {
        await inline.getByRole('textbox', { name: 'Test name', exact: true }).fill('Potassium');
        await updateCorrection();
        await page.reload();
        await page.getByRole('button', { name: 'Review', exact: true }).waitFor();
        assert(
          await page.getByRole('button', { name: 'Confirm & save', exact: true }).isDisabled(),
        );
        await fixtureAssertNoAccepted(request, prefix, intake.id);
        await page.getByRole('button', { name: 'Review', exact: true }).click();
        await inline.getByRole('textbox', { name: 'Result', exact: true }).waitFor();
        for (const label of ['Test name', 'Result', 'Unit', 'Date'])
          assert.equal(await inline.getByLabel(label, { exact: true }).count(), 1);
      }
      if (dateAndValue) {
        await inline.getByLabel('Date', { exact: true }).fill('2032-03-04');
        await inline
          .getByRole('textbox', { name: 'Correction reason' })
          .fill('Date verified against the original');
        await updateCorrection();
        await page.reload();
        assert(
          await page.getByRole('button', { name: 'Confirm & save', exact: true }).isDisabled(),
        );
        await page.getByRole('button', { name: 'Review', exact: true }).click();
        await inline.getByRole('textbox', { name: 'Result', exact: true }).waitFor();
        assert.equal(await inline.getByLabel('Date', { exact: true }).inputValue(), '2032-03-04');
      }
      await inline.getByRole('textbox', { name: 'Result', exact: true }).fill('4.1');
      if (screenshots && dateAndValue)
        await inline.screenshot({ path: resolve(screenshots, 'potassium-correction-reason.png') });
      await updateCorrection();
      if (partial) {
        await page.reload();
        await page.getByRole('button', { name: 'Review', exact: true }).waitFor();
        assert(
          await page.getByRole('button', { name: 'Confirm & save', exact: true }).isDisabled(),
        );
        await fixtureAssertNoAccepted(request, prefix, intake.id);
        await page.getByRole('button', { name: 'Review', exact: true }).click();
        await inline.getByRole('textbox', { name: 'Unit', exact: true }).waitFor();
        for (const label of ['Test name', 'Result', 'Unit', 'Date'])
          assert.equal(await inline.getByLabel(label, { exact: true }).count(), 1);
        await inline.getByRole('textbox', { name: 'Unit', exact: true }).fill('mmol/L');
        await updateCorrection();
      }
      await page.getByText(/^4\.1\s*mmol\/L$/).waitFor();
      await page.reload();
      await page.getByText(/^4\.1\s*mmol\/L$/).waitFor();
      await fixtureAssertNoAccepted(request, prefix, intake.id);
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (button) => button.textContent?.trim() === 'Confirm & save' && !button.disabled,
        ),
      );
      if (!partial) {
        const feed = (await request(prefix + '/intakes/import-feed')) as CollectionImportFeed;
        assert.equal(feed.format, 'health-intake-import-feed-v2');
        const selected = feed.records.find((row) => row.intakeId === intake.id);
        assert.ok(selected);
        const recordId =
          selected.detail.kind === 'record'
            ? selected.detail.record.id
            : selected.detail.selection.recordId;
        const reopeningSince = Date.now();
        const reopenedRead = fixtureBrowserResponse(page, (response) => {
          const selected = new URL(response.url());
          return (
            response.request().method() === 'GET' &&
            response.request().timing().startTime >= reopeningSince &&
            selected.pathname ===
              `${prefix}/intakes/${encodeURIComponent(intake.id)}/review-record` &&
            selected.searchParams.get('recordId') === recordId
          );
        });
        await page.goto(
          url +
            '/#/import?' +
            new URLSearchParams({
              intake: intake.id,
              group: selected.groupId,
              record: recordId,
              proposal: selected.proposalId || 'original',
            }),
        );
        const reopenedResponse = await reopenedRead;
        assert.equal(reopenedResponse.status(), 200, await reopenedResponse.text());
        assert.equal(await reopenedResponse.finished(), null);
        const reopened = (await reopenedResponse.json())
          .data as import('../../shared/intake-clinical-review.ts').IntakeClinicalRecordRead;
        assert.equal(reopened.format, 'health-intake-clinical-record-v2');
        assert.equal(reopened.record.kind, 'record');
        assert.equal(reopened.context.proposalId, selected.proposalId);
        if (reopened.record.kind === 'record') {
          assert.equal(reopened.record.record.id, recordId);
          assert.equal(reopened.record.record.mapping.valueText, '4.1');
          assert.equal(
            reopened.record.record.candidateVersionId,
            selected.detail.kind === 'record'
              ? selected.detail.record.candidateVersionId
              : selected.detail.selection.candidateVersionId,
          );
        }
        await page
          .locator('.import-record-accordion')
          .getByRole('img', { name: 'cookie-doe-lab.pdf, page 2 of 2' })
          .waitFor();
        assert.equal(await page.getByRole('heading', { name: 'REPORT REVIEW' }).count(), 0);
        await page
          .locator('.import-record-accordion')
          .getByRole('button', { name: 'Close review', exact: true })
          .click();
        await page.getByRole('button', { name: /Change person for/ }).click();
        await page.getByRole('dialog').waitFor();
        await page.getByRole('dialog').evaluate(async (dialog) => {
          await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
        });
        if (screenshots)
          await page.screenshot({ path: resolve(screenshots, 'matched-person-sidebar.png') });
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        assert.notEqual(
          await page.locator('body').evaluate((body) => getComputedStyle(body).pointerEvents),
          'none',
        );
      }
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await inline.waitFor();
      const acceptedResponse = fixtureBrowserResponse(
        page,
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === prefix + '/intakes/report-acceptance',
      );
      const savedFeedResponse = fixtureBrowserResponse(page, async (response) => {
        if (
          response.request().method() !== 'GET' ||
          new URL(response.url()).pathname !== prefix + '/intakes/import-feed'
        )
          return false;
        const acknowledgement = await acceptedResponse;
        return (
          response.request().timing().startTime >= acknowledgement.request().timing().startTime
        );
      });
      await page.getByRole('button', { name: 'Confirm & save', exact: true }).click();
      const accepted = await acceptedResponse;
      assert.equal(accepted.status(), 200, await accepted.text());
      assert.equal(await accepted.finished(), null);
      const result = (await accepted.json())
        .data as import('../../shared/intake.ts').IntakeReportAcceptanceResult;
      assert.equal(result.receipt.operationId, accepted.request().postDataJSON().operationId);
      assert.equal(result.receipt.selectedCount, 1);
      assert.equal(result.receipt.acceptedCount, 1);
      assert.equal(result.receipt.receipts.length, 1);
      assert.equal(result.receipt.receipts[0]!.intakeId, intake.id);
      assert.equal(result.receipt.receipts[0]!.records.length, 1);
      const savedFeed = await savedFeedResponse;
      assert.equal(savedFeed.status(), 200, await savedFeed.text());
      assert.equal(await savedFeed.finished(), null);
      assert.equal((await savedFeed.json()).data.format, 'health-intake-import-feed-v2');
      await inline.waitFor({ state: 'detached' });
      await page.locator('.import-record-row').first().waitFor({ state: 'detached' });
      assert.equal(await page.locator('.import-record-row').count(), 0);
      await page
        .getByRole('region', { name: 'Save outcomes' })
        .getByRole('status')
        .getByText('1 saved', { exact: true })
        .waitFor();
      const destinations = await fixtureDestinations(request, prefix, intake.id);
      assert.equal(destinations.length, 1);
      const saved = destinations[0]!;
      const observation = await request(prefix + '/tests/' + encodeURIComponent(saved.entityId));
      assert.deepEqual(observation.extra.import.correctionHistorySource, {
        format: 'health-accepted-contribution-corrections-v1',
      });
      const contributions = (await request(
        prefix +
          '/record-import-corrections?' +
          new URLSearchParams({ kind: 'observation', recordId: saved.entityId, limit: '1' }),
      )) as ClinicalImportCorrectionHistoryPage;
      assert.equal(contributions.format, 'health-clinical-import-corrections-v1');
      assert.equal(contributions.kind, 'observation');
      assert.equal(contributions.recordId, saved.entityId);
      assert.equal(contributions.complete, true);
      assert.equal(contributions.nextCursor, null);
      assert.equal(contributions.entries.length, 1);
      const contribution = contributions.entries[0]!;
      const acceptedRecord = result.receipt.receipts[0]!.records[0]!;
      assert.equal(contribution.intakeId, intake.id);
      assert.equal(contribution.proposalId, result.receipt.receipts[0]!.proposalId);
      assert.equal(contribution.candidateId, acceptedRecord.candidateId);
      assert.equal(contribution.candidateVersionId, acceptedRecord.candidateVersionId);
      assert.equal(contribution.history.format, 'health-intake-review-draft-history-v1');
      assert.equal(contribution.history.intakeId, intake.id);
      const expectedCount = partial ? 3 : dateAndValue ? 2 : 1;
      assert.equal(contribution.history.corrections, expectedCount);
      const history = (await request(
        prefix + '/intakes/' + encodeURIComponent(intake.id) + '/review-history',
        { reference: contribution.history, section: 'corrections', offset: 0, limit: 20 },
      )) as ReturnType<typeof readReviewDraftHistoryPage>;
      assert.equal(history.format, 'health-intake-review-history-page-v1');
      assert.deepEqual(history.reference, contribution.history);
      assert.equal(history.section, 'corrections');
      assert.equal(history.total, expectedCount);
      assert.equal(history.complete, true);
      assert.equal(history.nextOffset, null);
      assert.equal(history.items.length, expectedCount);
      const corrections = history.items.map((item, index) => {
        assert.equal(item.ordinal, index);
        assert.ok('value' in item, 'these small correction entries fit the bounded page');
        assert.ok(!('issueId' in item.value));
        assert.ok(item.value.operationId);
        assert.ok(Number.isFinite(Date.parse(item.value.at)));
        return item.value;
      });
      assert.equal(new Set(corrections.map((change) => change.operationId)).size, expectedCount);
      assert.deepEqual(
        corrections.map((change) => change.reason),
        dateAndValue
          ? ['Date verified against the original', 'Correction of imported data']
          : Array(expectedCount).fill('Correction of imported data'),
      );
      const valueChange = corrections[partial || dateAndValue ? 1 : 0]!;
      assert.ok(valueChange.before.valueText == null || valueChange.before.valueText === '');
      assert.equal(valueChange.after.valueText, '4.1');
      if (dateAndValue) {
        assert.notEqual(corrections[0]!.before.date, '2032-03-04');
        assert.equal(corrections[0]!.after.date, '2032-03-04');
      }
      if (partial) {
        assert.equal(corrections[0]!.after.testLabel, 'Potassium');
        assert.equal(corrections[2]!.after.unit, 'mmol/L');
      }
      const assertImportHistoryUI = async (container: Locator) => {
        await container.waitFor();
        if (!(await container.evaluate((element) => (element as HTMLDetailsElement).open)))
          await container.locator(':scope > summary').click();
        const acceptedHistory = container.getByRole('region', {
          name: 'Accepted source correction histories',
          exact: true,
        });
        await acceptedHistory.waitFor();
        const historyResponse = fixtureBrowserResponse(
          page,
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname ===
              prefix + '/intakes/' + encodeURIComponent(intake.id) + '/review-history' &&
            response.request().postDataJSON().reference.snapshotId ===
              ('snapshotId' in contribution.history ? contribution.history.snapshotId : undefined),
        );
        await acceptedHistory
          .getByRole('button', { name: 'View review history', exact: true })
          .click();
        const displayed = await historyResponse;
        assert.equal(displayed.status(), 200, await displayed.text());
        assert.equal(await displayed.finished(), null);
        assert.deepEqual((await displayed.json()).data, history);
        const pages = acceptedHistory.getByRole('region', {
          name: 'Review history pages',
          exact: true,
        });
        for (const [index, change] of corrections.entries()) {
          const item = pages.getByRole('article').nth(index);
          await item
            .getByRole('heading', { name: 'Mapping correction ' + (index + 1), exact: true })
            .waitFor();
          await item.getByText(change.at + ' · ' + change.reason, { exact: true }).waitFor();
          assert.deepEqual(JSON.parse(await item.locator('pre').nth(0).innerText()), change.before);
          assert.deepEqual(JSON.parse(await item.locator('pre').nth(1).innerText()), change.after);
        }
        assert.equal(await pages.getByRole('article').count(), expectedCount);
      };
      await page.goto(url + '/#/tests?result=' + encodeURIComponent(saved.entityId));
      await assertImportHistoryUI(
        page
          .getByRole('region', { name: 'Selected result', exact: true })
          .locator('.record-correction-history')
          .first(),
      );
      await page.getByText('Modified during import').first().waitFor();
      await page.getByText('Meadowglass Laboratory', { exact: true }).first().waitFor();
      if (scenario === 'value') {
        await page.getByRole('button', { name: 'More entry actions' }).click();
        await page.getByRole('button', { name: 'Correct saved record', exact: true }).click();
        const correction = page.getByRole('dialog', { name: 'Correct saved record' });
        await correction.getByLabel('Result', { exact: true }).fill('4.2');
        await correction
          .getByLabel('Why this saved interpretation is being corrected')
          .fill('Rechecked Cookie Doe printed result');
        await correction.getByRole('button', { name: 'Review before and after' }).click();
        await page.getByRole('button', { name: 'Apply reviewed correction' }).click();
        const savedDialog = page.getByRole('dialog', { name: 'Correction saved' });
        await savedDialog.waitFor();
        await savedDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
        await savedDialog.waitFor({ state: 'hidden' });
        await page.reload();
        const selected = page.getByRole('region', { name: 'Selected result' });
        await selected
          .locator('.note-identity-heading')
          .getByText('Corrections', { exact: true })
          .waitFor();
        const correctionHistory = selected.locator('.record-correction-history').first();
        await correctionHistory
          .getByText('Saved-record correction: Rechecked Cookie Doe printed result', {
            exact: true,
          })
          .waitFor();
        assert.match(await correctionHistory.innerText(), /4\.1\s*→\s*4\.2/);
        await assertImportHistoryUI(correctionHistory);
        const recordedValues = selected
          .locator('details')
          .filter({ has: page.locator('summary').filter({ hasText: /^Recorded values/ }) });
        await recordedValues.locator(':scope > summary').click();
        const recordedHistory = recordedValues.locator('.record-correction-history');
        await recordedHistory.locator('summary').click();
        await recordedHistory
          .getByText('Saved-record correction: Rechecked Cookie Doe printed result', {
            exact: true,
          })
          .waitFor();
        await assertImportHistoryUI(recordedHistory);
      }
      assert.deepEqual(errors, []);
    },
  );
