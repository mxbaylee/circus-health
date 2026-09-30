import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
import type {
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceResult,
} from '../../shared/intake.ts';

test(
  'encrypted narrow browser retains an unsaved selection and reconciles a lost partial-save reply once',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'fictional-partial-review-'));
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
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    browser = await launchBrowser(t);
    const page = await newTestPage(browser, { viewport: { width: 390, height: 844 } });
    const origin = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(origin);
    const profileId = await page.evaluate(async () => {
      async function post(path: string, body: unknown) {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(await response.text());
        return (await response.json()).data;
      }
      const setup = await post('/api/profile-setups', {
        fullName: 'Fictional Review Person',
        birthDate: '1980-01-01',
        name: 'Fictional Review Person',
      });
      const profile = await post(`/api/profile-setups/${setup.setupId}/verify`, {
        acknowledged: true,
        recovery: setup.recoveryKit,
      });
      return profile.id as string;
    });
    const prefix = `/api/profiles/${profileId}`;
    const values = ['Alpha marker', 'Beta marker'].map((label, index) => ({
      format: 'health-record-v1',
      id: `fictional-${index}`,
      kind: 'record',
      payload: { text: label + ' 14' },
      provenance: {
        capturedVia: 'Fictional export',
        sourceSystem: 'Fictional Clinic',
        sourceRecordId: `fictional-${index}`,
        evidenceClass: 'provider_export',
        locator: 'row ' + index,
      },
      coverage: { status: 'complete_response', notes: [] },
      clinical: {
        kind: 'observation',
        subject: 'self',
        testLabel: label,
        valueText: '14',
        unit: 'mg',
        date: '2026-09-01',
      },
    }));
    const upload = await page.request.post(origin + prefix + '/intakes', {
      headers: {
        Origin: origin,
        'Content-Type': 'application/x-ndjson',
        'X-Filename': 'fictional-partial.jsonl',
      },
      data: values.map((value) => JSON.stringify(value)).join('\n'),
    });
    assert.equal(upload.status(), 201, await upload.text());
    let originalOperation = '';
    let intercepted = 0;
    await page.route('**/intakes/report-acceptance', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      intercepted++;
      const request = route.request().postDataJSON() as IntakeReportAcceptanceRequest;
      assert.equal(request.mode, 'partial-v1');
      originalOperation = request.operationId;
      request.blocks[0]!.selections[1]!.selectionReviewToken = 'fictional-stale-authority';
      const response = await route.fetch({ postData: JSON.stringify(request) });
      assert.equal(response.status(), 200);
      const result = (await response.json()).data as IntakeReportAcceptanceResult;
      assert.equal(result.receipt.acceptedCount, 1);
      // Lost reply: the original operation, not a new approval, recovers the outcome.
      // See docs/import/review-reliability.md.
      await route.abort('failed');
    });
    await page.goto(origin + '/#/import');
    await page.reload();
    await page.getByRole('checkbox', { name: 'Select all shown', exact: true }).check();
    await page.getByRole('button', { name: 'Save 2 records', exact: true }).click();
    const outcomes = page.getByRole('region', { name: 'Save outcomes' });
    await outcomes.getByText('1 saved, 1 needs review', { exact: true }).waitFor();
    assert.equal(intercepted, 1);
    assert.equal(await page.getByRole('checkbox', { name: /Beta marker/ }).isChecked(), true);
    const status = await page.request.get(
      origin + prefix + '/intakes/report-acceptance/' + originalOperation,
    );
    const receipt = (await status.json()).data as IntakeReportAcceptanceResult;
    assert.equal(receipt.receipt.acceptedCount, 1);
    await outcomes.getByRole('link', { name: /Alpha marker/ }).click();
    await page.waitForURL(/result=/);
    const records = await page.request.get(origin + prefix + '/tests?personId=patient');
    assert.equal(records.status(), 200);
    assert.equal((await records.json()).meta.total, 1);
  },
);
