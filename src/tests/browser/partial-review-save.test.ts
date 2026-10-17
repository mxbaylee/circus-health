import { launchBrowser, newTestPage } from './harness.ts';
import { startProcessRuntime } from './process-runtime.ts';
import {
  fixtureApi,
  fixtureReview,
  fixtureBrowserResponse,
  fixtureNativeFeedReady,
} from './native-intake-fixture.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import type { CollectionImportFeed } from '../../shared/intake-clinical-pages.ts';
import type { IntakeIdentityScopeReference } from '../../shared/intake-identity.ts';
import type {
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceResult,
} from '../../shared/intake.ts';

test(
  'encrypted narrow browser requires fresh approval and replays a lost partial save across a real process restart',
  // Host hang guard for two exact person assignments, stale approval, lost
  // reply, process restart and fresh approval. Counted work is qualified in
  // intake-partial-acceptance-work.test.ts; elapsed time is not its oracle.
  { timeout: 120000 },
  async (t) => {
    const started = performance.now();
    const checkpoint = (message: string) =>
      t.diagnostic(`${message} (${Math.round(performance.now() - started)} ms observed)`);
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
      const people = [];
      for (const [birthDate, relationship] of [
        ['1980-01-01', 'Sibling'],
        ['1950-01-01', 'Parent'],
      ]) {
        people.push(
          await post(`/api/profiles/${profile.id}/notes`, {
            kind: 'person',
            title: 'Fictional Rowan Meadow',
            person: { fullName: 'Fictional Rowan Meadow', birthDate, relationship },
          }),
        );
      }
      return {
        profileId: profile.id as string,
        recovery: setup.recoveryKit,
        people: people as Array<{ id: string; personId: string; version: number }>,
      };
    });
    const prefix = `/api/profiles/${setup.profileId}`;
    checkpoint('Encrypted profile and two alike-named people are ready.');
    const values = ['Alpha marker', 'Beta marker'].map((label, index) => ({
      format: 'health-record-v1',
      id: `fictional-${index}`,
      kind: 'record',
      report: {
        key: 'fictional-report-' + index,
        anchor: { locator: 'row ' + index, text: label + ' report' },
        title: label + ' report',
        subject: { locator: 'row ' + index + ' patient', text: 'Fictional Rowan Meadow' },
      },
      payload: { text: 'Fictional Rowan Meadow: ' + label + ' 14' },
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
        subject: 'unknown',
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
    const uploaded = (await upload.json()).data as { id: string };
    checkpoint('The fictional two-record source is uploaded.');
    const api = fixtureApi(page, origin);
    const feed = (await api(
      prefix + '/intakes/import-feed?view=all&intakeId=' + encodeURIComponent(uploaded.id),
    )) as CollectionImportFeed;
    for (const [index, label] of ['Alpha marker', 'Beta marker'].entries()) {
      const row = feed.records.find(
        (entry) => entry.detail.kind === 'record' && entry.detail.record.title.includes(label),
      );
      assert(row, 'exact fictional report is available for person assignment');
      const scope = (await api(
        prefix +
          '/intakes/' +
          encodeURIComponent(uploaded.id) +
          '/identity-scope?groupId=' +
          encodeURIComponent(row.groupId),
      )) as IntakeIdentityScopeReference;
      const person = setup.people[index]!;
      await api(prefix + '/intakes/' + encodeURIComponent(uploaded.id) + '/identity-scope', {
        version: scope.intakeVersion,
        operationId: crypto.randomUUID(),
        scope,
        outcome: 'this_is_person',
        attestation: 'confirmed_displayed_identity_questions',
        personSelection: { noteId: person.id, expectedVersion: person.version },
      });
    }
    let originalOperation = '';
    checkpoint('Both reports have their exact person assignments.');
    let intercepted = 0;
    let originalRequest: IntakeReportAcceptanceRequest | undefined;
    let staleDraftPublished = false;
    await page.route('**/intakes/report-acceptance-plan', async (route) => {
      if (staleDraftPublished) return route.continue();
      staleDraftPublished = true;
      const request = route.request().postDataJSON() as {
        blocks: IntakeReportAcceptanceRequest['blocks'];
      };
      const block = request.blocks.at(-1)!;
      const selected = block.selections.at(-1)!;
      const fresh = await fixtureReview(
        api,
        prefix + '/intakes/' + encodeURIComponent(block.intakeId) + '/review',
      );
      await api(prefix + '/intakes/' + encodeURIComponent(block.intakeId) + '/review-draft', {
        version: fresh.version,
        operationId: crypto.randomUUID(),
        proposalId: block.proposalId,
        recordId: selected.recordId,
        candidateVersionId: selected.candidateVersionId,
        mapping: { valueText: '15' },
      });
      await route.continue();
    });
    await page.route('**/intakes/report-acceptance', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      intercepted++;
      const request = route.request().postDataJSON() as IntakeReportAcceptanceRequest;
      assert.equal(request.mode, 'partial-v1');
      originalOperation = request.operationId;
      originalRequest = structuredClone(request);
      const response = await route.fetch({ postData: JSON.stringify(request) });
      assert.equal(response.status(), 200);
      const result = (await response.json()).data as IntakeReportAcceptanceResult;
      checkpoint('The mixed partial-save response reached the browser interceptor.');
      assert.equal(
        result.receipt.acceptedCount,
        1,
        'mixed fictional save must retain its valid record: ' +
          JSON.stringify(result.receipt.atomic ? result.receipt : result.receipt.items),
      );
      // Lost reply: the original operation, not a new approval, recovers the outcome.
      // See docs/import/review-reliability.md.
      await route.abort('failed');
    });
    // Observe one fresh browser navigation; an immediate reload would abandon
    // a second set of otherwise identical native preparation requests.
    await page.goto('about:blank');
    const initialFeed = await fixtureNativeFeedReady(page, prefix, () =>
      page.goto(origin + '/#/import'),
    );
    assert.equal(initialFeed.totalRecords, 2);
    checkpoint('The native review feed is ready.');
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
    checkpoint('The browser reconciled the lost save reply.');
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
    const savedLink = outcomes.getByRole('link', {
      name: /Alpha marker.*Fictional Rowan Meadow.*1980-01-01.*Sibling/,
    });
    await savedLink.waitFor();
    assert(
      (await savedLink.getAttribute('href'))?.includes(
        'personId=' + encodeURIComponent(setup.people[0]!.personId),
      ),
    );
    await outcomes
      .getByRole('link', {
        name: /Beta marker.*Fictional Rowan Meadow.*1950-01-01.*Parent.*needs review/,
      })
      .waitFor();
    await savedLink.click();
    checkpoint('Both outcome labels identify the correct person.');
    await page.waitForURL(/result=/);
    const records = await page.request.get(
      origin + prefix + '/tests?personId=' + encodeURIComponent(setup.people[0]!.personId),
    );
    assert.equal(records.status(), 200);
    assert.equal((await records.json()).meta.total, 1);

    const priorPid = runtime.pid;
    const port = runtime.port;
    // Quiesce the old document before its server session disappears. The
    // unchanged browser context retains the exact pending operation and cookies.
    await page.goto('about:blank');
    await runtime.close();
    runtime = await startProcessRuntime(t, { ...runtimeOptions, port });
    checkpoint('The encrypted server restarted into a new process.');
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
    checkpoint('The original operation replayed after restart.');
    const afterRestart = await page.request.get(
      origin + prefix + '/tests?personId=' + encodeURIComponent(setup.people[0]!.personId),
    );
    assert.equal(
      (await afterRestart.json()).meta.total,
      1,
      'original operation never duplicates a save',
    );
    await page.unroute('**/intakes/report-acceptance');
    const resumedFeed = await fixtureNativeFeedReady(page, prefix, () =>
      page.goto(origin + '/#/import'),
    );
    checkpoint('The remaining record is ready after restart.');
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
    checkpoint('Fresh approval for the remaining record returned.');
    assert.equal(freshResponse.status(), 200, await freshResponse.text());
    assert.equal(await freshResponse.finished(), null);
    const fresh = (await freshResponse.json()).data as IntakeReportAcceptanceResult;
    assert.equal(fresh.receipt.acceptedCount, 1);
    await page
      .getByRole('region', { name: 'Save outcomes' })
      .getByText('1 saved', { exact: true })
      .waitFor();
    const finalRecords = await page.request.get(
      origin + prefix + '/tests?personId=' + encodeURIComponent(setup.people[1]!.personId),
    );
    assert.equal(
      (await finalRecords.json()).meta.total,
      1,
      'fresh approval saves the previously rejected item for its exact other person',
    );
    const selfRecords = await page.request.get(origin + prefix + '/tests?personId=patient');
    assert.equal((await selfRecords.json()).meta.total, 0, 'family records never leak into Self');
  },
);
