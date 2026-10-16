import { launchBrowser, newTestPage } from './harness.ts';
import { startProcessRuntime } from './process-runtime.ts';
import { fixtureBrowserResponse, fixtureNativeFeedReady } from './native-intake-fixture.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import type {
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceResult,
} from '../../shared/intake.ts';

test(
  'encrypted narrow browser requires fresh approval and replays a lost partial save across a real process restart',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'fictional-partial-review-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtimeOptions = {
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
    };
    let runtime = await startProcessRuntime(t, runtimeOptions);
    let browser: Browser | undefined;
    t.after(async () => {
      await browser?.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    browser = await launchBrowser(t);
    const page = await newTestPage(browser, { viewport: { width: 390, height: 844 } });
    const origin = `http://127.0.0.1:${runtime.port}`;
    await page.goto(origin);
    const setup = await page.evaluate(async () => {
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
      return { profileId: profile.id as string, recovery: setup.recoveryKit };
    });
    const prefix = `/api/profiles/${setup.profileId}`;
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
    let originalRequest: IntakeReportAcceptanceRequest | undefined;
    await page.route('**/intakes/report-acceptance', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      intercepted++;
      const request = route.request().postDataJSON() as IntakeReportAcceptanceRequest;
      assert.equal(request.mode, 'partial-v1');
      originalOperation = request.operationId;
      request.blocks[0]!.selections[1]!.selectionReviewToken = 'fictional-stale-authority';
      originalRequest = structuredClone(request);
      const response = await route.fetch({ postData: JSON.stringify(request) });
      assert.equal(response.status(), 200);
      const result = (await response.json()).data as IntakeReportAcceptanceResult;
      assert.equal(result.receipt.acceptedCount, 1);
      // Lost reply: the original operation, not a new approval, recovers the outcome.
      // See docs/import/review-reliability.md.
      await route.abort('failed');
    });
    await page.goto(origin + '/#/import');
    const initialFeed = await fixtureNativeFeedReady(page, prefix, () => page.reload());
    assert.equal(initialFeed.totalRecords, 2);
    assert.equal(
      initialFeed.records.filter(
        (row) => row.detail.kind === 'record' && row.detail.record.selectable,
      ).length,
      2,
      'both exact pending records are selectable after the native window is ready',
    );
    await page.getByRole('checkbox', { name: 'Select all shown', exact: true }).check();
    assert.equal(await page.getByRole('checkbox', { name: /Alpha marker/ }).isChecked(), true);
    assert.equal(await page.getByRole('checkbox', { name: /Beta marker/ }).isChecked(), true);
    const recoveredReply = fixtureBrowserResponse(
      page,
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname ===
          prefix + '/intakes/report-acceptance/' + originalOperation,
    );
    await page.getByRole('button', { name: 'Save 2 records', exact: true }).click();
    const recoveredResponse = await recoveredReply;
    assert.equal(recoveredResponse.status(), 200, await recoveredResponse.text());
    assert.equal(await recoveredResponse.finished(), null);
    const recovered = (await recoveredResponse.json()).data as IntakeReportAcceptanceResult;
    assert.equal(recovered.receipt.selectedCount, 2);
    assert.equal(recovered.receipt.acceptedCount, 1);
    const outcomes = page.getByRole('region', { name: 'Save outcomes' });
    await outcomes.getByText('1 saved, 1 needs review', { exact: true }).waitFor();
    assert.equal(intercepted, 1);
    assert.equal(await page.getByRole('checkbox', { name: /Beta marker/ }).isChecked(), false);
    await page.getByText('Review again, then approve.', { exact: false }).first().waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
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

    const priorPid = runtime.pid;
    const port = runtime.port;
    // Quiesce the old document before its server session disappears. The
    // unchanged browser context retains the exact pending operation and cookies.
    await page.goto('about:blank');
    await runtime.close();
    runtime = await startProcessRuntime(t, { ...runtimeOptions, port });
    assert.notEqual(runtime.pid, priorPid, 'all server memory belongs to a new process');
    const unlocked = await page.request.post(origin + prefix + '/unlock', {
      headers: { Origin: origin },
      data: { recovery: setup.recovery },
    });
    assert.equal(unlocked.status(), 200, await unlocked.text());
    assert.equal((await unlocked.json()).data.id, setup.profileId);
    const replay = await page.request.post(origin + prefix + '/intakes/report-acceptance', {
      headers: { Origin: origin },
      data: originalRequest,
    });
    assert.equal(replay.status(), 200, await replay.text());
    const replayed = (await replay.json()).data as IntakeReportAcceptanceResult;
    assert.equal(replayed.receipt.acceptedCount, 1);
    assert.equal(replayed.replayed, true);
    const afterRestart = await page.request.get(origin + prefix + '/tests?personId=patient');
    assert.equal(
      (await afterRestart.json()).meta.total,
      1,
      'original operation never duplicates a save',
    );
    await page.unroute('**/intakes/report-acceptance');
    await page.goto(origin + '/#/import');
    const resumedFeed = await fixtureNativeFeedReady(page, prefix, () => page.reload());
    assert.equal(resumedFeed.totalRecords, 1);
    assert.equal(resumedFeed.records[0]?.detail.kind, 'record');
    const beta = page.getByRole('checkbox', { name: /Beta marker/ });
    await beta.focus();
    await page.keyboard.press('Space');
    assert.equal(await beta.isChecked(), true);
    const freshReply = fixtureBrowserResponse(
      page,
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === prefix + '/intakes/report-acceptance',
    );
    await page.getByRole('button', { name: 'Save 1 record', exact: true }).click();
    const freshResponse = await freshReply;
    assert.equal(freshResponse.status(), 200, await freshResponse.text());
    assert.equal(await freshResponse.finished(), null);
    const fresh = (await freshResponse.json()).data as IntakeReportAcceptanceResult;
    assert.equal(fresh.receipt.acceptedCount, 1);
    await page
      .getByRole('region', { name: 'Save outcomes' })
      .getByText('1 saved', { exact: true })
      .waitFor();
    const finalRecords = await page.request.get(origin + prefix + '/tests?personId=patient');
    assert.equal(
      (await finalRecords.json()).meta.total,
      2,
      'fresh approval saves the previously rejected item',
    );
  },
);
