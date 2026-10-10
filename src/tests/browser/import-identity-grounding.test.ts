import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { stopFixtureImport } from './manual-import-fixture.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import type {
  CollectionImportFeed,
  CollectionReportDetail,
} from '../../shared/intake-clinical-pages.ts';
import { fixtureApi, fixtureReportUrl, fixtureBrowserResponse } from './native-intake-fixture.ts';
import type { IntakeIdentityReview } from '../../shared/intake-identity.ts';

function feedRecords(feed: CollectionImportFeed) {
  assert.equal(feed.format, 'health-intake-import-feed-v2');
  assert.equal(feed.nextCursor, null, 'all small fixture rows are selected');
  assert.equal(feed.records.length, feed.totalRecords);
  return feed.records.map((row) => {
    assert.equal(row.detail.kind, 'record');
    assert.ok(row.detail.kind === 'record');
    return row.detail.record;
  });
}
function detailRecords(detail: CollectionReportDetail) {
  assert.equal(detail.format, 'health-intake-report-detail-v2');
  assert.equal(detail.records.nextCursor, null);
  assert.equal(detail.records.records.length, detail.records.totalRecords);
  return detail.records.records.map((row) => {
    assert.equal(row.kind, 'record');
    assert.ok(row.kind === 'record');
    return row.record;
  });
}

test(
  'Import refreshes blocked records after the host checks a matching original',
  // Covers initial original grounding, a real process restart and encrypted
  // profile reopen, then cold grounding and acceptance. UI waits stay unchanged.
  { timeout: 120000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-identity-grounding-browser-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtimeOptions = {
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
      assistantOptions: { availability: () => ({ available: false }) },
    };
    let runtime = await startBrowserRuntime(t, runtimeOptions);
    let browser: Browser | undefined;
    t.after(async () => {
      await browser?.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });

    browser = await launchBrowser(t);
    const page = await newTestPage(browser);
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(url);
    const setup = await page.evaluate(async () => {
      const post = async (path: string, body: unknown) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(await response.text());
        return (await response.json()).data;
      };
      const setup = await post('/api/profile-setups', {
        fullName: 'Fictional Iris Meadow',
        birthDate: '1982-04-17',
        name: 'Fictional Iris Meadow',
      });
      const profile = await post(`/api/profile-setups/${setup.setupId}/verify`, {
        acknowledged: true,
        recovery: setup.recoveryKit,
      });
      return { profileId: profile.id as string, recovery: setup.recoveryKit };
    });
    const profileId = setup.profileId;
    const prefix = `/api/profiles/${profileId}`;
    const original = [
      'Fictional Iris laboratory report',
      'Patient: Fictional Iris Meadow',
      'DOB: 1982-04-17',
      'Fictional copper 12.00 mg',
    ].join('\n');
    const uploaded = await page.request.post(url + prefix + '/intakes', {
      headers: { Origin: url, 'Content-Type': 'text/plain', 'X-Filename': 'fictional-iris.txt' },
      data: Buffer.from(original),
    });
    assert.equal(uploaded.status(), 201, await uploaded.text());
    const intake = await stopFixtureImport(page, url, prefix, (await uploaded.json()).data.id);
    const entry = {
      format: 'health-record-v1',
      id: 'fictional-iris-copper',
      kind: 'record',
      payload: { text: original },
      provenance: {
        capturedVia: 'Fictional browser test',
        sourceSystem: 'Fictional clinic',
        sourceRecordId: 'fictional-iris-copper',
        evidenceClass: 'provider_export',
        locator: 'page 1 count',
      },
      coverage: { status: 'complete_response', notes: [] },
      clinical: {
        kind: 'observation',
        subject: 'unknown',
        testLabel: 'Fictional copper',
        valueText: '12.00',
        unit: 'mg',
        date: '2026-03-02',
      },
      report: {
        key: 'fictional-iris-report',
        title: 'Fictional Iris laboratory report',
        anchor: { locator: 'page 1 heading', text: 'Fictional Iris laboratory report' },
        subject: { locator: 'page 1 patient', text: 'Patient: Fictional Iris Meadow' },
      },
    };
    const proposal = await page.request.post(url + prefix + `/intakes/${intake.id}/proposals`, {
      headers: { Origin: url },
      data: {
        version: intake.version,
        summary: 'One fictional result from the retained original.',
        jsonlText: JSON.stringify(entry),
      },
    });
    assert.equal(proposal.status(), 200, await proposal.text());

    const readFeed = async () => {
      const response = await page.request.get(url + prefix + '/intakes/import-feed?view=all');
      assert.equal(response.status(), 200, await response.text());
      return (await response.json()).data as CollectionImportFeed;
    };
    const before = await readFeed();
    const blocked = feedRecords(before);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]?.identityReview?.blocking, true);
    assert.equal(blocked[0]?.selectable, false);

    const seenFeeds: CollectionImportFeed[] = [];
    const seenIdentityReviews: unknown[] = [];
    page.on('response', async (response) => {
      if (!response.ok()) return;
      try {
        if (response.url().includes('/intakes/import-feed?'))
          seenFeeds.push((await response.json()).data as CollectionImportFeed);
        if (response.url().includes('/identity-review?'))
          seenIdentityReviews.push((await response.json()).data);
      } catch {
        // Navigation can dispose an otherwise completed response body.
      }
    });
    // Batch initialization and identity grounding each have a legitimate refresh.
    // Order them explicitly so this assertion measures the identity check alone.
    let releaseBatch!: () => void;
    let releaseIdentity!: () => void;
    const heldBatch = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const heldIdentity = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    const batchHistoryRoute = '**' + prefix + '/intake-batches';
    const initialIdentityRoute = '**/identity-review?**';
    const initializationRequests: Promise<void>[] = [];
    await page.route(batchHistoryRoute, (route) => {
      const pending = heldBatch.then(() => route.continue());
      initializationRequests.push(pending);
      return pending;
    });
    await page.route(initialIdentityRoute, (route) => {
      const pending = heldIdentity.then(() => route.continue());
      initializationRequests.push(pending);
      return pending;
    });
    const waitForFeeds = async (count: number) => {
      const deadline = Date.now() + 15000;
      while (seenFeeds.length < count && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(seenFeeds.length, count);
    };
    try {
      await page.goto('about:blank');
      await page.goto(url + '/#/import');
      const save = page.getByRole('button', { name: 'Confirm & save', exact: true });
      await save.waitFor();
      await waitForFeeds(1);
      assert.equal(await save.isEnabled(), false, 'identity is still ungrounded');
      releaseBatch();
      await waitForFeeds(2);
      assert.equal(seenIdentityReviews.length, 0, 'identity result is still held');
      const initialFeedCount = seenFeeds.length;
      releaseIdentity();
      await waitForFeeds(initialFeedCount + 1);
      await save.and(page.locator(':enabled')).waitFor();
      assert.equal(await save.isEnabled(), true, 'browser enables acceptance after host check');
      assert.ok(seenIdentityReviews.length >= 1, 'browser requested the host identity check');
      const refreshed = seenFeeds.at(-1)!;
      const ready = feedRecords(refreshed);
      assert.equal(ready[0]?.identityReview?.blocking, false);
      assert.equal(ready[0]?.selectable, true);
      assert.notEqual(refreshed.records[0]?.reviewToken, before.records[0]?.reviewToken);
      assert.equal(
        seenFeeds.length - initialFeedCount,
        1,
        'one successful check causes one feed reload',
      );
    } finally {
      releaseBatch();
      releaseIdentity();
      await Promise.all(initializationRequests);
      await page.unroute(batchHistoryRoute);
      await page.unroute(initialIdentityRoute);
    }

    const directUpload = await page.request.post(url + prefix + '/intakes', {
      headers: {
        Origin: url,
        'Content-Type': 'text/plain',
        'X-Filename': 'fictional-iris-direct-detail.txt',
      },
      data: Buffer.from(original),
    });
    assert.equal(directUpload.status(), 201, await directUpload.text());
    const directIntake = await stopFixtureImport(
      page,
      url,
      prefix,
      (await directUpload.json()).data.id,
    );
    const directProposal = await page.request.post(
      url + prefix + `/intakes/${directIntake.id}/proposals`,
      {
        headers: { Origin: url },
        data: {
          version: directIntake.version,
          summary: 'A second fictional result for direct detail review.',
          jsonlText: JSON.stringify({
            ...entry,
            id: 'fictional-iris-direct-copper',
            provenance: { ...entry.provenance, sourceRecordId: 'fictional-iris-direct-copper' },
            report: { ...entry.report, key: 'fictional-iris-direct-report' },
          }),
        },
      },
    );
    assert.equal(directProposal.status(), 200, await directProposal.text());
    const directReportUrl = await fixtureReportUrl(fixtureApi(page, url), prefix, directIntake.id);
    const directGroupId = new URLSearchParams(directReportUrl.split('?')[1]).get('group');
    assert.ok(directGroupId);
    const detailPath = `/intakes/report-queue/${encodeURIComponent(directGroupId)}?view=all&intakeId=${encodeURIComponent(directIntake.id)}`;
    const coldDetailResponse = await page.request.get(url + prefix + detailPath);
    assert.equal(coldDetailResponse.status(), 200, await coldDetailResponse.text());
    const coldDetail = (await coldDetailResponse.json()).data as CollectionReportDetail;
    assert.equal(detailRecords(coldDetail)[0]?.identityReview?.blocking, true);
    const seenDetails: CollectionReportDetail[] = [];
    let releaseIdentityChecks: () => void = () => {};
    const coldDetailLoaded = new Promise<void>((resolve) => {
      releaseIdentityChecks = resolve;
    });
    page.on('response', async (response) => {
      if (
        response.ok() &&
        new URL(response.url()).pathname.endsWith(
          '/intakes/report-queue/' + encodeURIComponent(directGroupId),
        )
      ) {
        try {
          seenDetails.push((await response.json()).data as CollectionReportDetail);
          releaseIdentityChecks();
        } catch {
          // Navigation can dispose an otherwise completed response body.
        }
      }
    });
    await page.route('**/identity-review?**', async (route) => {
      await coldDetailLoaded;
      await route.continue();
    });
    const directIdentityResponse = fixtureBrowserResponse(page, (response) => {
      const requestUrl = new URL(response.url());
      return (
        response.request().method() === 'GET' &&
        requestUrl.pathname ===
          prefix + '/intakes/' + encodeURIComponent(directIntake.id) + '/identity-review' &&
        requestUrl.searchParams.get('groupId') === directGroupId
      );
    });
    await page.goto(
      url +
        '/#/import?group=' +
        encodeURIComponent(directGroupId) +
        '&intake=' +
        encodeURIComponent(directIntake.id),
    );
    const directIdentity = await directIdentityResponse;
    assert.equal(directIdentity.status(), 200, await directIdentity.text());
    assert.equal(await directIdentity.finished(), null);
    const checkedIdentity = (await directIdentity.json()).data as IntakeIdentityReview;
    assert.equal(checkedIdentity.status, 'evidenced_match');
    assert.equal(checkedIdentity.blocking, false);
    const checkedScope = checkedIdentity.scopeReference || checkedIdentity.scope;
    assert.equal(checkedScope?.intakeId, directIntake.id);
    assert.equal(checkedScope?.groupId, directGroupId);
    const detailDeadline = Date.now() + 15000;
    while (
      (seenDetails.length < 2 || !detailRecords(seenDetails.at(-1)!)[0]?.selectable) &&
      Date.now() < detailDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      seenDetails[0] && detailRecords(seenDetails[0])[0]?.identityReview?.blocking,
      true,
    );
    assert.ok(seenDetails.length >= 2, 'direct detail reloaded after host identity check');
    assert.equal(detailRecords(seenDetails.at(-1)!)[0]?.selectable, true);
    assert.notEqual(
      seenDetails.at(-1)?.records.records[0]?.reviewToken,
      coldDetail.records.records[0]?.reviewToken,
      'direct detail obtained the current review token',
    );
    assert.equal(seenDetails.length, 2, 'direct detail avoids refresh loops');

    // Stop the old document rechecking an original before the cold-cache assertion.
    await page.goto('about:blank');
    await runtime.close();
    runtime = await startBrowserRuntime(t, {
      ...runtimeOptions,
      port: new URL(url).port ? Number(new URL(url).port) : 0,
    });
    const unlocked = await page.request.post(url + prefix + '/unlock', {
      headers: { Origin: url },
      data: { recovery: setup.recovery },
    });
    assert.equal(unlocked.status(), 200, await unlocked.text());
    const coldRestart = await readFeed();
    assert.equal(
      feedRecords(coldRestart).filter((record) => record.identityReview?.blocking).length,
      2,
      'restart loses only the in-memory grounding proof',
    );
    const restartFeedOffset = seenFeeds.length;
    // Start one cold document so a hash navigation and reload cannot race feed requests.
    await page.goto(url + '/#/import');
    const restartDeadline = Date.now() + 15000;
    while (Date.now() < restartDeadline) {
      const last = seenFeeds.at(-1);
      if (
        seenFeeds.length > restartFeedOffset + 1 &&
        last &&
        feedRecords(last).every((record) => record.selectable)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const restartReady = seenFeeds.at(-1)!;
    assert.equal(
      feedRecords(restartReady).filter((record) => record.selectable).length,
      2,
      'browser restores acceptance readiness after restart grounding',
    );
    const oldTokens = new Map(coldRestart.records.map((row) => [row.groupId, row.reviewToken]));
    for (const row of restartReady.records)
      assert.notEqual(row.reviewToken, oldTokens.get(row.groupId));
    const saveButtons = page.getByRole('button', { name: 'Confirm & save', exact: true });
    assert.equal(await saveButtons.count(), 2);
    for (const button of await saveButtons.all()) assert.equal(await button.isEnabled(), true);
    const accepted = fixtureBrowserResponse(
      page,
      (response) =>
        response.url().endsWith('/intakes/report-acceptance') &&
        response.request().method() === 'POST',
    );
    await saveButtons.first().click();
    const acceptance = await accepted;
    assert.equal(acceptance.status(), 200, await acceptance.text());
    assert.equal((await acceptance.json()).data.receipt.acceptedCount, 1);
  },
);
