import {
  fixtureReview,
  fixtureReport,
  fixtureDestinations,
  fixtureSourcePath,
} from './native-intake-fixture.ts';
import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { AppOptions } from '../../server/index.ts';
import type { Browser } from 'playwright';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fictionalModel } from '../../server/test/fictional-model.ts';

const waitFor = async <T>(predicate: () => T, message: string, timeout = 12000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(`Timed out waiting for ${message}`);
};

function proposal(intakeId: string, label: string) {
  return JSON.stringify({
    format: 'health-record-v1',
    id: `fictional-batch-${label}`,
    kind: 'record',
    subject: 'self',
    payload: { literal: `${label} 18 ng/mL` },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: `Fictional ${label} result`,
      valueText: '18',
      unit: 'ng/mL',
      date: '2026-09-01',
    },
    provenance: {
      capturedVia: 'Fictional browser upload',
      sourceSystem: 'Fictional clinic',
      sourceRecordId: intakeId,
      evidenceClass: 'transcription',
      locator: `${label}.txt / bounded supplied text`,
    },
    report: {
      key: `fictional-${label}-report`,
      title: `Fictional ${label} report`,
      anchor: { locator: `${label}.txt heading`, text: `Fictional ${label} result` },
      subject: null,
    },
    coverage: {
      status: 'partial',
      notes: ['This bounded pass does not claim the whole file was clinically extracted.'],
    },
  });
}

test(
  'encrypted browser reads two uploads sequentially and restores Stop, reload, Resume review',
  { timeout: 60000 },
  async (t) => {
    fictionalModel(t);
    const root = mkdtempSync(resolve(tmpdir(), 'circus-browser-intake-batch-'));
    mkdirSync(resolve(root, 'data'));
    type Callbacks = Parameters<
      NonNullable<NonNullable<AppOptions['assistantOptions']>['bridgeFactory']>
    >[0];
    const bridges: Array<{
      callbacks: Callbacks;
      index: number;
      closed: boolean;
      start: () => Promise<{ model: string; backend: string }>;
      turn: () => Promise<void>;
      cancel: () => Promise<void>;
      close: () => void;
    }> = [];
    const active = new Set();
    let maxActive = 0;
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startBrowserRuntime(t, {
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
      assistantOptions: {
        availability: () => ({ available: true, readiness: 'ready' }),
        connectionCheck: async () => ({ available: true, readiness: 'ready' }),
        bridgeFactory(callbacks) {
          const index = bridges.length + 1;
          const bridge = {
            callbacks,
            index,
            closed: false,
            async start() {
              return { model: 'fictional-batch-browser', backend: 'synthetic' };
            },
            async turn() {
              active.add(index);
              maxActive = Math.max(maxActive, active.size);
              callbacks.onEvent!('turn/started', { turn: { id: `turn-${index}` } });
            },
            async cancel() {},
            close() {
              this.closed = true;
              active.delete(index);
            },
          };
          bridges.push(bridge);
          return bridge;
        },
      },
    });
    let browser: Browser | undefined;
    t.after(async () => {
      await browser?.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });

    browser = await launchBrowser(t);
    const page = await newTestPage(browser, { viewport: { width: 1440, height: 1000 } });
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(url);
    const setup = await page.evaluate(async () => {
      const post = async (path: string, body?: unknown) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(await response.text());
        return (await response.json()).data;
      };
      const status = await (await fetch('/api/runtime')).json();
      if (!status.encrypted) throw Error('Encrypted runtime required');
      const pending = await post('/api/profile-setups', {
        fullName: 'Fictional intake batch browser',
        birthDate: '1982-04-17',
        name: 'Fictional intake batch browser',
      });
      const profile = await post(`/api/profile-setups/${pending.setupId}/verify`, {
        acknowledged: true,
        recovery: pending.recoveryKit,
      });
      return { profileId: profile.id };
    });
    const prefix = `/api/profiles/${setup.profileId}`;
    const get = async (path: string) => {
      const response = await page.request.get(url + path);
      const json = await response.json();
      assert(response.ok(), JSON.stringify(json));
      return json.data;
    };
    const screenshots = process.env.CRS_TEST_SCREENSHOTS || resolve(root, 'screenshots');
    mkdirSync(screenshots, { recursive: true });
    async function capture(stage: string) {
      for (const theme of ['light', 'dark']) {
        for (const mobile of [false, true]) {
          await page.setViewportSize(
            mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          );
          await page.evaluate((value) => {
            document.documentElement.dataset.theme = value;
            document.documentElement.style.colorScheme = value;
          }, theme);
          await page.evaluate(
            () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
          );
          assert(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth + 1,
            ),
            `${stage} ${theme} ${mobile ? 'mobile' : 'desktop'} has no page overflow`,
          );
          await page.screenshot({
            animations: 'disabled',
            fullPage: true,
            path: resolve(screenshots, `${stage}-${theme}-${mobile ? 'mobile' : 'desktop'}.png`),
          });
        }
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'light';
        document.documentElement.style.colorScheme = 'light';
      });
    }
    async function openFullReview(label: string) {
      const record = page.locator('.import-record').filter({ hasText: label }).first();
      await record.waitFor();
      await record.getByRole('button', { name: 'Review exact record', exact: true }).click();
      await page.getByRole('region', { name: 'Review actions' }).waitFor();
    }

    const conversionRequests = [];
    const importRequests = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/convert')) conversionRequests.push(request.url());
      if (request.url().endsWith('/import') || request.url().endsWith('/report-acceptance'))
        importRequests.push(request.url());
    });

    await page.goto(url + '/#/import');
    await page.reload();
    await page.waitForFunction(() => {
      const input = document.querySelector('.import-dropzone input[type="file"]');
      return input instanceof HTMLInputElement && !input.disabled;
    });
    const created = page.waitForResponse(
      async (response) =>
        response.request().method() === 'GET' &&
        response.url().endsWith('/intake-batches') &&
        response.ok() &&
        (await response.json()).data.some(
          (batch: { items: unknown[] }) => batch.items.length === 2,
        ),
    );
    await page.locator('.import-dropzone input[type="file"]').setInputFiles([
      {
        name: 'fictional-first-bounded.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Fictional first result 18 ng/mL; unread appendix retained.'),
      },
      {
        name: 'fictional-second-bounded.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Fictional second result 18 ng/mL; unread appendix retained.'),
      },
    ]);
    const initialBatch = (await (await created).json()).data.find(
      (batch: { items: unknown[] }) => batch.items.length === 2,
    );
    assert.equal(initialBatch.items.length, 2);
    assert.equal(conversionRequests.length, 0, 'the UI does not start per-file conversion routes');
    assert.equal(importRequests.length, 0, 'background reading never accepts a record');

    await waitFor(() => bridges.length === 1, 'first model pass');
    const first = await get(
      `${prefix}/intakes/${encodeURIComponent(initialBatch.items[0].intakeId)}`,
    );
    const firstText = (await bridges[0].callbacks.onTool!({
      tool: 'health_intake_source_text',
      arguments: { id: first.id },
      callId: 'fictional-first-source-text',
    })) as { revisionId: string };
    assert.equal(first.format, 'health-intake-summary-v2');
    const firstPlan = first.activePlan.plan;
    assert.equal(firstPlan.status, 'active');
    const firstUnits = (await bridges[0].callbacks.onTool!({
      tool: 'health_intake_plan',
      arguments: { id: first.id, action: 'read', section: 'units', freshStart: true },
      callId: 'fictional-first-units',
    })) as {
      format: string;
      items: { value: { id: string } }[];
      logicalTotal: number;
      complete: boolean;
    };
    assert.equal(firstUnits.format, 'health-intake-model-context-v2');
    assert.equal(firstUnits.logicalTotal, 1);
    assert.equal(firstUnits.complete, true);
    const firstUnitId = firstUnits.items[0]!.value.id;
    await bridges[0].callbacks.onTool!({
      tool: 'health_intake_plan',
      arguments: { id: first.id, action: 'read_unit', unitId: firstUnitId },
      callId: 'fictional-first-read',
    });
    await bridges[0].callbacks.onTool!({
      tool: 'health_intake_batch',
      arguments: {
        id: first.id,
        version: first.version,
        planId: firstPlan.id,
        operationId: 'fictional-first-batch',
        coverage: [
          {
            unitId: firstUnitId,
            kind: 'extracted',
            notes: 'The supplied fictional section was fully read.',
          },
        ],
        sourceTextRevisionId: firstText.revisionId,
        jsonlText: proposal(first.id, 'first'),
        summary: 'One fictional bounded section; unread material remains.',
      },
      callId: 'fictional-first-proposal',
      ...{ threadId: 'fictional-thread-1', turnId: 'turn-1' },
    });
    bridges[0].callbacks.onEvent!('turn/completed', { turn: { status: 'completed' } });

    await waitFor(() => bridges.length === 2, 'second sequential model pass');
    assert.equal(active.size, 1);
    assert.equal(maxActive, 1, 'the profile never runs parallel model jobs');
    await page.locator('.import-reading').getByText('Moxie is reading 1 file').waitFor();
    const firstFeed = await get(`${prefix}/intakes/import-feed?view=all`);
    const firstPointer = firstFeed.groups.find(
      (group: { intakeId: string }) => group.intakeId === first.id,
    );
    assert(firstPointer);
    const firstGroup = (await fixtureReport(get, prefix, firstPointer.groupId, first.id)).group;
    assert.equal(firstGroup.title, 'Fictional first report');
    assert(firstGroup, 'the first retained report is represented in the Import feed');
    const firstBlock = firstFeed.records.find(
      (block: { groupId: string; intakeId: string }) =>
        block.groupId === firstGroup.groupId && block.intakeId === first.id,
    );
    assert(firstBlock?.proposalId, 'the exact first proposal is represented in the Import feed');
    const firstIdentity = await get(
      `${prefix}/intakes/${encodeURIComponent(first.id)}/identity-review?groupId=${encodeURIComponent(firstGroup.groupId)}`,
    );
    assert.equal(firstIdentity.status, 'missing_warning');
    assert.equal(firstIdentity.blocking, false);
    const firstReview = await fixtureReview(
      get,
      `${prefix}/intakes/${encodeURIComponent(first.id)}/review?proposalId=${encodeURIComponent(firstBlock.proposalId)}`,
    );
    assert(
      firstReview.records[0].issues!.some(
        (issue: { kind: string; status: string }) =>
          issue.kind === 'identity' && issue.status === 'unresolved',
      ),
      'missing identity remains visibly unresolved until the person chooses an answer',
    );
    await openFullReview('Fictional first result');
    await page.getByRole('heading', { name: 'Fictional first result', exact: true }).waitFor();
    const firstSaveAction = page.getByRole('button', {
      name: 'Confirm and save record',
      exact: true,
    });
    assert.equal(await firstSaveAction.count(), 1);
    assert.equal(await firstSaveAction.isDisabled(), false);
    await page
      .getByText('Identity is not printed clearly in this report.', { exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole('region', { name: 'Report identity', exact: true }).count(),
      0,
      'missing printed identity does not invent a report-level confirmation',
    );
    assert.equal(await page.getByRole('button', { name: 'This is me', exact: true }).count(), 1);
    assert.equal(importRequests.length, 0, 'the first partial proposal remains review-only');
    await capture('batch-reading-partial-review');

    await page.getByRole('button', { name: 'Back to Import', exact: true }).click();
    await page.getByRole('heading', { name: 'Import', exact: true }).waitFor();
    const stoppedResponse = page.waitForResponse(
      (response) => response.url().endsWith('/stop') && response.ok(),
    );
    await page.getByRole('button', { name: 'Stop imports', exact: true }).click();
    const stopped = (await (await stoppedResponse).json()).data;
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.items[0].status, 'review_ready');
    assert.equal(stopped.items[0].proposalIds.length, 1);
    assert.equal(stopped.items[1].status, 'paused');
    assert.equal(
      (await get(`${prefix}/intakes/${encodeURIComponent(first.id)}`)).collections.importHistory
        .total,
      0,
    );
    const second = await get(
      `${prefix}/intakes/${encodeURIComponent(initialBatch.items[1].intakeId)}`,
    );
    assert.equal(
      second.state,
      'needs_review',
      'source capture remains available before clinical proposals',
    );
    assert.equal(second.collections.proposals.total, 0);
    const secondOriginal = await page.request.get(
      url + fixtureSourcePath(prefix, second.contentUrl),
    );
    assert.equal(
      await secondOriginal.text(),
      'Fictional second result 18 ng/mL; unread appendix retained.',
    );

    await page.reload();
    await page.getByRole('button', { name: 'Resume imports', exact: true }).waitFor();
    assert.equal(importRequests.length, 0, 'reload does not accept retained proposals');
    const resumedResponse = page.waitForResponse(
      (response) => response.url().endsWith('/resume') && response.ok(),
    );
    await page.getByRole('button', { name: 'Resume imports', exact: true }).click();
    await resumedResponse;
    await waitFor(() => bridges.length === 3, 'explicit retry of stopped second pass');
    const resumedSecond = await get(
      `${prefix}/intakes/${encodeURIComponent(initialBatch.items[1].intakeId)}`,
    );
    const secondText = (await bridges[2].callbacks.onTool!({
      tool: 'health_intake_source_text',
      arguments: { id: resumedSecond.id },
      callId: 'fictional-second-source-text',
    })) as { revisionId: string };
    assert.equal(resumedSecond.format, 'health-intake-summary-v2');
    const secondPlan = resumedSecond.activePlan.plan;
    assert.equal(secondPlan.status, 'active');
    const secondUnits = (await bridges[2].callbacks.onTool!({
      tool: 'health_intake_plan',
      arguments: { id: resumedSecond.id, action: 'read', section: 'units', freshStart: true },
      callId: 'fictional-second-units',
    })) as {
      format: string;
      items: { value: { id: string } }[];
      logicalTotal: number;
      complete: boolean;
    };
    assert.equal(secondUnits.format, 'health-intake-model-context-v2');
    assert.equal(secondUnits.logicalTotal, 1);
    assert.equal(secondUnits.complete, true);
    const secondUnitId = secondUnits.items[0]!.value.id;
    await bridges[2].callbacks.onTool!({
      tool: 'health_intake_plan',
      arguments: { id: resumedSecond.id, action: 'read_unit', unitId: secondUnitId },
      callId: 'fictional-second-read',
    });
    await bridges[2].callbacks.onTool!({
      tool: 'health_intake_batch',
      arguments: {
        id: resumedSecond.id,
        version: resumedSecond.version,
        planId: secondPlan.id,
        operationId: 'fictional-second-batch',
        coverage: [
          {
            unitId: secondUnitId,
            kind: 'extracted',
            notes: 'The supplied fictional section was fully read.',
          },
        ],
        sourceTextRevisionId: secondText.revisionId,
        jsonlText: proposal(resumedSecond.id, 'second'),
        summary: 'One fictional bounded section; unread material remains.',
      },
      callId: 'fictional-second-proposal',
      ...{ threadId: 'fictional-thread-2', turnId: 'turn-3' },
    });
    bridges[2].callbacks.onEvent!('turn/completed', { turn: { status: 'completed' } });
    const currentSecond = await get(`${prefix}/intakes/${encodeURIComponent(resumedSecond.id)}`);
    assert.equal(
      currentSecond.collections.proposals.total,
      1,
      JSON.stringify({
        currentSecond,
        batch: await get(`${prefix}/intake-batches/${initialBatch.id}`),
      }),
    );
    const firstReport = page
      .locator('.import-record')
      .filter({ hasText: 'Fictional first result' });
    const secondReport = page
      .locator('.import-record')
      .filter({ hasText: 'Fictional second result' });
    await firstReport.waitFor();
    await secondReport.waitFor();
    await capture('batch-review-queue');
    await openFullReview('Fictional first result');
    await page.getByRole('heading', { name: 'Fictional first result', exact: true }).waitFor();
    assert.equal(maxActive, 1);
    assert.equal(conversionRequests.length, 0);
    assert.equal(importRequests.length, 0);
    assert.equal(
      (await get(`${prefix}/intakes/${encodeURIComponent(first.id)}`)).collections.importHistory
        .total,
      0,
    );
    assert.equal(
      (await get(`${prefix}/intakes/${encodeURIComponent(resumedSecond.id)}`)).collections
        .importHistory.total,
      0,
    );

    const firstImport = page.waitForResponse(
      (response) =>
        (response.url().endsWith('/report-acceptance') || response.url().endsWith('/import')) &&
        response.ok(),
    );
    await page.getByRole('button', { name: 'This is me', exact: true }).click();
    await firstSaveAction.waitFor({ state: 'visible' });
    await firstSaveAction.click();
    const firstAcceptedResponse = await firstImport;
    assert(
      firstAcceptedResponse.url().endsWith('/report-acceptance'),
      'Report save must use counted atomic acceptance: ' + firstAcceptedResponse.url(),
    );
    assert.equal(importRequests.length, 1);
    await page.getByText('This exact record was saved to your profile.', { exact: true }).waitFor();
    assert.equal(
      await firstSaveAction.count(),
      0,
      'a saved exact record has no repeat save action',
    );
    await page.getByRole('button', { name: 'Back to Import', exact: true }).click();
    await page.getByRole('heading', { name: 'Review reports', exact: true }).waitFor();
    await openFullReview('Fictional second result');
    await page.getByRole('heading', { name: 'Fictional second result', exact: true }).waitFor();
    const secondSaveAction = page.getByRole('button', {
      name: 'Confirm and save record',
      exact: true,
    });
    await secondSaveAction.waitFor();
    assert.equal(await secondSaveAction.isDisabled(), false);
    await page
      .getByText('Identity is not printed clearly in this report.', { exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole('region', { name: 'Report identity', exact: true }).count(),
      0,
      'missing printed identity does not invent a report-level confirmation',
    );
    await page.getByRole('button', { name: 'This is me', exact: true }).click();
    assert.notEqual(
      (await get(`${prefix}/intakes/${encodeURIComponent(first.id)}`)).collections.importHistory
        .total,
      0,
    );
    assert.equal(
      (await get(`${prefix}/intakes/${encodeURIComponent(resumedSecond.id)}`)).collections
        .importHistory.total,
      0,
      'moving to the next review does not accept it',
    );
    let lostOperationId = '';
    await page.route('**/intakes/report-acceptance', async (route) => {
      lostOperationId = route.request().postDataJSON().operationId;
      const accepted = await route.fetch();
      assert(accepted.ok(), await accepted.text());
      // The real server committed; the browser receives no acknowledgement.
      await route.abort('failed');
    });
    const recoveredReceipt = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/intakes/report-acceptance/') &&
        response.ok(),
    );
    await secondSaveAction.click();
    const recovered = (await (await recoveredReceipt).json()).data;
    assert.equal(recovered.receipt.operationId, lostOperationId);
    assert.equal(recovered.receipt.acceptedCount, 1);
    await page.getByText('This exact record was saved to your profile.', { exact: true }).waitFor();
    await page.unroute('**/intakes/report-acceptance');
    assert.equal(importRequests.length, 2);
    assert.notEqual(
      (await get(`${prefix}/intakes/${encodeURIComponent(resumedSecond.id)}`)).collections
        .importHistory.total,
      0,
    );
    for (const [intakeId, label] of [
      [first.id, 'first'],
      [resumedSecond.id, 'second'],
    ]) {
      const accepted = await get(`${prefix}/intakes/${encodeURIComponent(intakeId)}`);
      const destinations = await fixtureDestinations(get, prefix, intakeId);
      assert.equal(destinations.length, 1);
      const target = destinations[0]!;
      assert.equal(target.kind, 'observation');
      const result = await get(`${prefix}/tests/${encodeURIComponent(target.entityId)}`);
      assert.equal(result.label, `Fictional ${label} result`);
      assert.equal(result.valueText, '18');
      assert.equal(result.unit, 'ng/mL');
      assert.equal(result.date, '2026-09-01');
      assert(result.evidence.length > 0);
      const original = await page.request.get(url + fixtureSourcePath(prefix, accepted.contentUrl));
      assert.equal(
        await original.text(),
        `Fictional ${label} result 18 ng/mL; unread appendix retained.`,
      );
    }
    await page.reload();
    const receiptAfterReload = await get(`${prefix}/intakes/report-acceptance/${lostOperationId}`);
    assert.deepEqual(receiptAfterReload.receipt, recovered.receipt);
  },
);
