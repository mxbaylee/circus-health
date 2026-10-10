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
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

test(
  'encrypted Import confirms identity and selected blank Self fields in one action',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-browser-import-self-'));
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
      const post = async (path: string, body: unknown) => {
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
        fullName: 'Fictional import Self browser',
        birthDate: '1982-04-17',
        name: 'Fictional import Self browser',
      });
      const profile = await post(`/api/profile-setups/${pending.setupId}/verify`, {
        acknowledged: true,
        recovery: pending.recoveryKit,
      });
      return { profileId: profile.id };
    });
    const prefix = `/api/profiles/${setup.profileId}`;
    const request = async (path: string, method = 'GET', body?: unknown) => {
      const response = await page.request.fetch(url + path, {
        method,
        headers: method === 'GET' ? undefined : { Origin: url },
        data: body,
      });
      const json = await response.json();
      assert(response.ok(), JSON.stringify(json));
      return json.data;
    };

    const createdSelf = await request(prefix + '/notes/person-note%3Aself');
    // This journey exercises a legacy blank Self, not the new-profile requirement.
    const initialSelf = await request(prefix + '/notes/person-note%3Aself', 'PUT', {
      ...createdSelf,
      person: { ...createdSelf.person, fullName: '', birthDate: '' },
    });
    assert.equal(initialSelf.person.fullName, '');
    assert.equal(initialSelf.person.birthDate, '');

    const original = Buffer.from(
      'Fictional source evidence. Patient: Fictional Source Rowan; DOB: 1990-03-12.',
    );
    const uploaded = await page.request.post(url + prefix + '/intakes', {
      headers: {
        Origin: url,
        'Content-Type': 'text/plain',
        'X-Filename': 'fictional-self-evidence.txt',
      },
      data: original,
    });
    assert.equal(uploaded.status(), 201);
    let intake = await stopFixtureImport(page, url, prefix, (await uploaded.json()).data.id);
    intake = await request(`${prefix}/intakes/${encodeURIComponent(intake.id)}/proposals`, 'POST', {
      version: intake.version,
      summary: 'One fictional evidence-backed result for explicit review.',
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-self-result',
        kind: 'record',
        subject: 'unknown',
        payload: {
          literal: 'Fictional ferritin 18 ng/mL',
          transcript: 'Patient: Fictional Source Rowan; DOB: 1990-03-12.',
        },
        clinical: {
          kind: 'observation',
          subject: 'unknown',
          testLabel: 'Fictional ferritin',
          valueText: '18',
          unit: 'ng/mL',
          date: '',
        },
        provenance: {
          capturedVia: 'Fictional browser upload',
          sourceSystem: 'Fictional Harbor Clinic',
          sourceRecordId: 'fictional-self-result',
          evidenceClass: 'transcription',
          locator: 'fictional-self-evidence.txt / supplied text',
        },
        report: {
          key: 'fictional-self-report',
          title: 'Fictional identity report',
          anchor: {
            locator: 'fictional-self-evidence.txt',
            text: 'Fictional source evidence.',
          },
          subject: {
            locator: 'fictional-self-evidence.txt',
            text: 'Patient: Fictional Source Rowan; DOB: 1990-03-12.',
          },
        },
        coverage: { status: 'complete_response', notes: ['One supplied fictional passage'] },
        reviewIssues: [
          {
            id: 'fictional-self-identity',
            kind: 'identity',
            field: 'subject',
            prompt: 'Does the printed identity belong to you?',
            textAnchor: 'Patient: Fictional Source Rowan; DOB: 1990-03-12.',
            selfSuggestion: {
              fullName: 'Fictional Source Rowan',
              birthDate: '1990-03-12',
            },
          },
        ],
      }),
    });
    const proposalId = await fixtureProposalId(
      (path: string, body?: unknown) => request(path, body === undefined ? 'GET' : 'POST', body),
      prefix,
      intake.id,
    );
    const review = await fixtureReview(
      (path: string, body?: unknown) => request(path, body === undefined ? 'GET' : 'POST', body),
      `${prefix}/intakes/${encodeURIComponent(intake.id)}/review?proposalId=${encodeURIComponent(proposalId)}`,
    );
    assert.deepEqual(
      review.records[0].issues!.find(
        (issue: { prompt: string }) => issue.prompt === 'Does the printed identity belong to you?',
      )!.selfSuggestion,
      { fullName: 'Fictional Source Rowan', birthDate: '1990-03-12' },
    );

    const reportUrl = await fixtureReportUrl(
      (path: string, body?: unknown) => request(path, body === undefined ? 'GET' : 'POST', body),
      prefix,
      intake.id,
    );
    const identity = page.getByRole('region', { name: 'Report identity', exact: true });
    // Cold native preparation belongs to the overall test hang guard. Assert
    // controls promptly after the browser's actual identity read has completed.
    const readIdentity = async () => {
      const since = Date.now();
      const response = await page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'GET' &&
          candidate.request().timing().startTime >= since &&
          new URL(candidate.url()).pathname ===
            `${prefix}/intakes/${encodeURIComponent(intake.id)}/identity-review`,
        { timeout: 0 },
      );
      assert.equal(response.status(), 200);
      assert.equal(await response.finished(), null);
      return (await response.json()).data;
    };
    const readReport = async () => {
      const since = Date.now();
      const response = await page.waitForResponse(
        (candidate) => {
          const selected = new URL(candidate.url());
          return (
            candidate.request().method() === 'GET' &&
            candidate.request().timing().startTime >= since &&
            selected.pathname.startsWith(`${prefix}/intakes/report-queue/`) &&
            selected.searchParams.get('intakeId') === intake.id
          );
        },
        { timeout: 0 },
      );
      assert.equal(response.status(), 200);
      assert.equal(await response.finished(), null);
    };
    const identityReady = async () => {
      await page
        .getByRole('status')
        .filter({ hasText: 'Checking retained identity evidence…' })
        .waitFor({ state: 'hidden', timeout: 0 });
    };
    const waitForConfirmedIdentity = () =>
      identity.getByText('This report already matches Self.', { exact: true }).waitFor();
    await page.goto(url + reportUrl);
    const initialIdentity = readIdentity();
    await page.reload();
    await initialIdentity;
    await identityReady();
    const confirm = identity.getByRole('button', {
      name: 'This is me and add selected details',
      exact: true,
    });
    await confirm.waitFor();
    let identityPosts = 0;
    page.on('request', (candidate) => {
      if (candidate.method() === 'POST' && candidate.url().endsWith('/identity-scope'))
        identityPosts += 1;
    });
    const identityRequest = page.waitForRequest(
      (candidate) => candidate.url().endsWith('/identity-scope') && candidate.method() === 'POST',
    );
    const updated = page.waitForResponse(
      (response) =>
        response.url().endsWith('/identity-scope') &&
        response.request().method() === 'POST' &&
        response.ok(),
    );
    const refreshedIdentity = readIdentity();
    const refreshedReport = readReport();
    await confirm.click();
    const submitted = (await identityRequest).postDataJSON();
    await updated;
    assert.equal(submitted.selfUpdate.expectedVersion, initialSelf.version);
    assert.deepEqual(submitted.selfUpdate.fields, { birthDate: '1990-03-12' });
    const confirmed = await refreshedIdentity;
    assert.equal(confirmed.status, 'prior_confirmation');
    assert.equal(confirmed.blocking, false);
    assert.equal(confirmed.confirmationCount, 1);
    await refreshedReport;
    await identityReady();
    await waitForConfirmedIdentity();
    const reloadedIdentity = readIdentity();
    await page.reload();
    await reloadedIdentity;
    await identityReady();
    await waitForConfirmedIdentity();
    assert.equal(
      await identity.getByRole('button', { name: /This is me|Self details/ }).count(),
      0,
      'the refreshed report has no second confirmation control after the name was retained and the selected birth date was filled',
    );
    // Text originals download; inspect those exact bytes, then exercise Back
    // from the application's retained-file view rather than an attachment URL.
    const originalUrl = url + fixtureSourcePath(prefix, intake.contentUrl);
    const download = page.waitForEvent('download');
    await assert.rejects(page.goto(originalUrl), /Download is starting/);
    const downloaded = await download;
    const downloadedPath = await downloaded.path();
    assert.ok(downloadedPath);
    assert.deepEqual(readFileSync(downloadedPath), original);
    const sourceId = decodeURIComponent(
      new URL(originalUrl).pathname.split('/sources/')[1]!.replace(/\/content$/, ''),
    );
    await page.goto(url + '/#/sources?file=' + encodeURIComponent(sourceId));
    await page.getByRole('heading', { name: 'fictional-self-evidence.txt', exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole('link', { name: 'Open original file', exact: true })
        .getAttribute('href'),
      new URL(originalUrl).pathname,
    );
    const returnedIdentity = readIdentity();
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await returnedIdentity;
    await identityReady();
    await waitForConfirmedIdentity();
    assert.equal(
      await identity.getByRole('button', { name: /This is me|Self details/ }).count(),
      0,
      'same-tab retained-original Back does not restore a stale confirmation control',
    );
    await identity.getByRole('button', { name: 'Done', exact: true }).click();
    assert.equal(
      identityPosts,
      1,
      'unchanged Done and retained-original Back do not submit another identity confirmation',
    );

    const reloadedSelf = await request(prefix + '/notes/person-note%3Aself');
    assert.equal(
      reloadedSelf.person.fullName,
      '',
      'retaining a report name does not choose a primary name',
    );
    assert.ok(reloadedSelf.person.knownNames.includes('Fictional Source Rowan'));
    assert.ok(
      reloadedSelf.person.sourceKnownNames.some(
        (entry: { name: string }) => entry.name === 'Fictional Source Rowan',
      ),
    );
    await page.goto(url + '/#/');
    await page
      .getByRole('list', { name: 'Names retained from confirmed reports' })
      .getByText('Fictional Source Rowan', { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: 'Remove name Fictional Source Rowan', exact: true })
        .count(),
      0,
    );
    assert.equal(reloadedSelf.person.birthDate, '1990-03-12');
  },
);
