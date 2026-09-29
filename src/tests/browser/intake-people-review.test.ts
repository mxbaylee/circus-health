import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startRuntime } from '../../server/runtime.ts';

const envelope = {
  format: 'health-record-v1',
  id: 'fictional-browser-people-only',
  kind: 'record',
  payload: [
    'Fictional care team',
    'Dr. Rowan Finch can be reached at 555-0104.',
    'Aunt Juniper Vale mentioned a fictional family history detail.',
  ].join('\n'),
  provenance: {
    capturedVia: 'Fictional browser upload',
    sourceSystem: 'Fictional archive',
    sourceRecordId: 'fictional-browser-people-only',
    evidenceClass: 'provider_export',
    locator: 'page 1',
  },
  coverage: { status: 'complete_response', notes: [] },
  report: {
    key: 'fictional-browser-care-team',
    title: 'Fictional care team',
    anchor: { locator: 'page 1 heading', text: 'Fictional care team' },
    subject: null,
  },
  people: [
    {
      id: 'fictional-rowan-finch',
      fullName: 'Rowan Finch',
      role: 'clinician',
      title: 'Dr. Rowan Finch',
      phone: '555-0104',
      evidence: [
        {
          textAnchor: 'Dr. Rowan Finch can be reached at 555-0104.',
          supports: ['fullName', 'title', 'phone'],
          locator: 'page 1, care team',
          page: 1,
        },
      ],
    },
    {
      id: 'fictional-juniper-vale',
      fullName: 'Juniper Vale',
      role: 'relative',
      relationship: 'Aunt',
      medicalHistory: 'a fictional family history detail',
      evidence: [
        {
          textAnchor: 'Aunt Juniper Vale mentioned a fictional family history detail.',
          supports: ['fullName', 'relationship', 'medicalHistory'],
          locator: 'page 1, family history',
          page: 1,
        },
      ],
    },
  ],
};

test('People-only report stays separate, opens original evidence, and saves by explicit choice', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'circus-browser-intake-people-'));
  mkdirSync(resolve(root, 'data'));
  const runtimeDirectory = createTestRuntimeDirectory();
  const runtime = await startRuntime({
    dataDirectory: resolve(root, 'data'),
    runtimeDirectory,
    port: 0,
    host: '127.0.0.1',
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await runtime.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
  await page.goto(url);
  const setup = await page.evaluate(async () => {
    const post = async (path: string, body: unknown) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()).data;
    };
    const pending = await post('/api/profile-setups', {
      fullName: 'Fictional People Browser',
      birthDate: '1982-04-17',
      name: 'Fictional People Browser',
    });
    return post(`/api/profile-setups/${pending.setupId}/verify`, {
      acknowledged: true,
      recovery: pending.recoveryKit,
    });
  });
  const prefix = `/api/profiles/${setup.id}`;
  const upload = await page.request.post(url + prefix + '/intakes', {
    headers: {
      Origin: url,
      'Content-Type': 'application/x-ndjson',
      'X-Filename': 'fictional-care-team.jsonl',
    },
    data: `${JSON.stringify(envelope)}\n`,
  });
  assert(upload.ok(), await upload.text());
  const intake = (await upload.json()).data;
  const review = await page.request.get(url + prefix + `/intakes/${intake.id}/review`);
  assert(review.ok(), await review.text());
  const reportQueueResponse = await page.request.get(url + prefix + '/intakes/report-queue');
  assert(reportQueueResponse.ok(), await reportQueueResponse.text());
  const reportQueue = (await reportQueueResponse.json()).data;
  assert.equal(reportQueue.groups[0].peopleCounts.pending, 2);
  assert.equal(reportQueue.groups[0].counts.pending, 0);
  const groupId = reportQueue.groups[0].groupId;

  await page.goto(
    `${url}/#/import?intake=${encodeURIComponent(intake.id)}&group=${encodeURIComponent(groupId)}`,
  );
  await page.reload();
  const people = page.getByRole('region', { name: 'People from this report' });
  await people.getByRole('tab', { name: /To review\s+2/ }).waitFor();
  assert.equal(
    await page.locator('.import-detail-record-link').count(),
    0,
    'A People-only report does not invent clinical record links',
  );
  assert.equal(await page.getByRole('button', { name: 'Back to Import', exact: true }).count(), 1);

  await people.getByRole('button', { name: /Rowan Finch/ }).click();
  await page.getByText('Dr. Rowan Finch can be reached at 555-0104.', { exact: true }).waitFor();
  const original = page
    .getByRole('region', { name: 'Original evidence' })
    .getByRole('link', { name: 'Open original' });
  assert.match((await original.getAttribute('href')) || '', /\/sources\/.+\/content/);
  assert.equal(await page.getByRole('button', { name: 'Add as new person' }).count(), 1);

  const screenshots = process.env.CRS_TEST_SCREENSHOTS || resolve(root, 'screenshots');
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({
    animations: 'disabled',
    fullPage: true,
    path: resolve(screenshots, 'people-review-light-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.style.colorScheme = 'dark';
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({
    animations: 'disabled',
    fullPage: true,
    path: resolve(screenshots, 'people-review-dark-mobile.png'),
  });

  const applied = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/intakes/people-apply') &&
      response.ok(),
  );
  await page.getByRole('button', { name: 'Add as new person' }).click();
  const appliedResponse = await applied;
  const saved = (await appliedResponse.json()).data;
  assert.equal(saved.status, 'saved');
  assert.equal(saved.action, 'add');
  const savedPersonLink = page.getByRole('link', { name: 'Open saved person', exact: true });
  await savedPersonLink.waitFor();
  await savedPersonLink.click();
  await page.getByRole('button', { name: 'Remove name Rowan Finch', exact: true }).waitFor();
});
