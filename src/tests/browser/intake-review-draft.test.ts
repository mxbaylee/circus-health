import type { IntakeClinicalMapping } from '../../shared/intake.ts';
import {
  fixtureReview,
  fixtureProposalId,
  fixtureReportUrl,
  fixtureSourcePath,
} from './native-intake-fixture.ts';
import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { stopFixtureImport } from './manual-import-fixture.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { Browser } from 'playwright';
import type { AddressInfo } from 'node:net';
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
const envelope = (clinical: boolean) => ({
  format: 'health-record-v1',
  id: clinical ? 'fictional-optical-draft' : 'fictional-document-draft',
  kind: 'document',
  subject: 'unknown',
  payload: {
    text: 'Fictional Avery Lens\n03/08/2017\nRight +1.75 -2.50 007\nLeft -0.50 -1.25 142\nPD 30.5 / 31.0',
  },
  ...(clinical
    ? {
        clinical: {
          kind: 'document',
          subject: 'unknown',
          documentTitle: 'Fictional prescription',
          opticalPrescription: optical,
          assets: [],
          uncertainties: [],
        },
      }
    : {}),
  provenance: {
    capturedVia: null,
    sourceSystem: null,
    sourceRecordId: 'fictional-draft',
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
      id: 'reading',
      kind: 'uncertain_reading',
      field: 'text',
      prompt: 'Check the fictional handwritten reading',
      textAnchor: '30.5 / 31.0',
    },
  ],
});

test(
  'encrypted browser autosaves consecutive review choices with entire server mapping and restores drafts after cache loss',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-browser-review-draft-'));
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
    const page = await newTestPage(browser);
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
        fullName: 'Fictional review draft browser',
        birthDate: '1982-04-17',
        name: 'Fictional review draft browser',
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
    const draftBodies: Array<{
      mapping: { mappingOrigins?: unknown };
      decision: { mapping: unknown };
      answers?: unknown;
    }> = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/review-draft')) draftBodies.push(request.postDataJSON());
    });
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
      await page.goto(url + (await fixtureReportUrl(api, prefix, item.id)));
      await page.reload();
      await page.locator('.import-detail-record-link:not([data-saved-record-id])').first().click();
      // The native report identity remains informational when no printed subject exists.
      await page
        .getByText('Identity is not printed clearly in this report.', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('region', { name: 'Report identity', exact: true }).count(),
        0,
        'missing report identity does not invent a report-level confirmation; the record-level answer remains separate',
      );
      await page.getByRole('button', { name: 'This is me', exact: true }).click();
      await page.getByRole('button', { name: 'Keep unconfirmed', exact: true }).click();
      const choicesSaved = page.waitForResponse(
        (response) =>
          response.url().endsWith('/review-draft') &&
          response.ok() &&
          response.request().postDataJSON().resolutions?.length === 4,
      );
      await page.getByRole('button', { name: 'Leave uncertain', exact: true }).click();
      await choicesSaved;
      const deferred = page.waitForResponse(
        (response) =>
          response.url().endsWith('/review-draft') &&
          response.ok() &&
          response.request().postDataJSON().disposition === 'review_later',
      );
      await page
        .locator('.intake-guided-actions')
        .getByRole('button', { name: 'Review later', exact: true })
        .click();
      await deferred;
      const stored = await fixtureReview(api, reviewPath);
      assert.equal(
        (await api(path)).collections.importHistory.total,
        0,
        'Autosave does not accept the record',
      );
      assert.equal((await api(prefix + '/vision-prescriptions')).length, 0);
      assert.equal(stored.records[0].draft!.disposition, 'review_later');
      assert.equal(stored.records[0].mapping.subject, 'self');
      assert.equal(stored.records[0].mapping.date, '');
      assert.equal(stored.records[0].mapping.documentDate, '');
      assert.deepEqual(
        (stored.records[0].mapping as IntakeClinicalMapping & { mappingOrigins?: unknown })
          .mappingOrigins,
        (originalReview.records[0].mapping as IntakeClinicalMapping & { mappingOrigins?: unknown })
          .mappingOrigins,
      );
      assert.deepEqual(stored.records[0].mapping.assets, originalReview.records[0].mapping.assets);
      assert.deepEqual(
        stored.records[0].mapping.uncertainties,
        originalReview.records[0].mapping.uncertainties,
      );
      assert.equal(stored.records[0].mapping.text, JSON.stringify(value.payload));
      if (clinical) assert.deepEqual(stored.records[0].mapping.opticalPrescription, optical);
      const sent = draftBodies.at(-1)!;
      assert.deepEqual(
        sent.mapping.mappingOrigins,
        (originalReview.records[0].mapping as IntakeClinicalMapping & { mappingOrigins?: unknown })
          .mappingOrigins,
      );
      assert.deepEqual(sent.mapping, sent.decision.mapping);
      assert.equal(sent.answers && typeof sent.answers, 'object');
      await page.reload();
      const reviewActions = page.getByRole('region', { name: 'Review actions' });
      await reviewActions.getByRole('button', { name: 'Return to review', exact: true }).waitFor();
      assert.equal(
        await page.locator('.import-detail').count(),
        1,
        'Reload preserves the exact deferred record without silently accepting it',
      );
      assert.equal(
        await reviewActions
          .getByRole('button', { name: 'Confirm and save record', exact: true })
          .count(),
        0,
        'A deferred deep-linked record cannot be accepted before it is returned to review',
      );
      await api(prefix + '/lock', {});
      rmSync(resolve(root, 'data', 'profiles', setup.profileId, 'cache'), {
        recursive: true,
        force: true,
      });
      await api(prefix + '/unlock', { recovery: setup.recovery });
      const rebuilt = await fixtureReview(api, reviewPath);
      assert.deepEqual(rebuilt.records[0].draft, stored.records[0].draft);
      assert.deepEqual(rebuilt.records[0].mapping, stored.records[0].mapping);
      await page.reload();
      await reviewActions.getByRole('button', { name: 'Return to review', exact: true }).waitFor();
      await reviewActions.getByRole('button', { name: 'Return to review', exact: true }).click();
      const accepted = page.waitForResponse((response) =>
        response.url().endsWith('/intakes/report-acceptance'),
      );
      await reviewActions
        .getByRole('button', { name: 'Confirm and save record', exact: true })
        .click();
      const acceptedResponse = await accepted;
      assert(acceptedResponse.ok(), await acceptedResponse.text());
      assert.equal((await api(path)).state, 'imported');
      if (clinical) {
        const prescriptions = await api(prefix + '/vision-prescriptions');
        assert.equal(prescriptions.length, 1);
        assert.deepEqual(prescriptions[0].opticalPrescription, optical);
      }
      const original = await page.request.get(url + fixtureSourcePath(prefix, item.contentUrl));
      assert.equal(await original.text(), 'Fictional retained original ' + clinical);
      const proposal = await page.request.get(
        url + prefix + '/sources/' + encodeURIComponent(proposalId) + '/content',
      );
      assert.deepEqual(JSON.parse(await proposal.text()), value);
    }
    assert.deepEqual(errors, []);
  },
);
