import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { stopFixtureImport } from './manual-import-fixture.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { Browser } from 'playwright';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

    const uploaded = await page.request.post(url + prefix + '/intakes', {
      headers: {
        Origin: url,
        'Content-Type': 'text/plain',
        'X-Filename': 'fictional-self-evidence.txt',
      },
      data: Buffer.from(
        'Fictional source evidence. Patient: Fictional Source Rowan; DOB: 1990-03-12.',
      ),
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
    const proposalId = intake.proposals.at(-1)!.id;
    const review = await request(
      `${prefix}/intakes/${encodeURIComponent(intake.id)}/review?proposalId=${encodeURIComponent(proposalId)}`,
    );
    assert.deepEqual(
      review.records[0].issues.find(
        (issue: { prompt: string }) => issue.prompt === 'Does the printed identity belong to you?',
      ).selfSuggestion,
      { fullName: 'Fictional Source Rowan', birthDate: '1990-03-12' },
    );

    await page.goto(
      url +
        '/#/import?intake=' +
        encodeURIComponent(intake.id) +
        '&proposal=' +
        encodeURIComponent(proposalId),
    );
    await page.reload();
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
    await page.getByRole('button', { name: 'Review person for this report', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Who is this report for?' })
      .getByRole('button', { name: 'This is me and add selected details', exact: true })
      .click();
    const submitted = (await identityRequest).postDataJSON();
    await updated;
    assert.equal(submitted.selfUpdate.expectedVersion, initialSelf.version);
    assert.deepEqual(submitted.selfUpdate.fields, {
      birthDate: '1990-03-12',
    });
    await page.getByRole('heading', { name: 'Review reports', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('dialog').count(),
      0,
      'successful person review closes the sidebar and returns to Import',
    );
    await page.goto(
      url +
        '/#/import?intake=' +
        encodeURIComponent(intake.id) +
        '&proposal=' +
        encodeURIComponent(proposalId),
    );
    await page.getByRole('button', { name: 'Change person for this report', exact: true }).click();
    await page.getByText('This report already matches Self.', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: /This is me|Self details/ }).count(),
      0,
      'the refreshed detail has no second confirmation control after the name was retained and the selected birth date was filled',
    );

    const originalUrl =
      url + prefix + intake.contentUrl.slice(intake.contentUrl.startsWith('/api/') ? 4 : 0);
    await page.goto(originalUrl);
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Change person for this report', exact: true }).click();
    await page.getByText('This report already matches Self.', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: /This is me|Self details/ }).count(),
      0,
      'same-tab retained-original Back does not restore a stale confirmation control',
    );
    await page
      .getByRole('dialog', { name: 'Who is this report for?' })
      .getByRole('button', { name: 'Done', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Review reports', exact: true }).waitFor();
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
