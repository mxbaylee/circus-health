import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startRuntime } from '../../server/runtime.ts';

const envelope = {
  format: 'health-record-v1',
  id: 'fictional-named-people-browser',
  kind: 'record',
  payload: [
    'Fictional care relationships',
    'Dr Mira Finch direct phone +14155550127.',
    'Aunt Juniper Vale has migraines; onset unknown.',
    'An unnamed maternal uncle had hypertension.',
  ].join('\n'),
  provenance: {
    capturedVia: 'Prepared fictional browser fixture',
    sourceSystem: 'Fictional household archive',
    sourceRecordId: 'fictional-named-people-browser',
    evidenceClass: 'provider_export',
    locator: 'prepared JSONL line 1',
  },
  coverage: { status: 'complete_response', notes: ['One prepared fictional JSONL record.'] },
  report: {
    key: 'fictional-relationships-report',
    title: 'Fictional relationships report',
    anchor: {
      locator: 'prepared JSONL heading',
      text: 'Fictional care relationships',
    },
    subject: null,
  },
  people: [
    {
      id: 'mira-finch',
      fullName: 'Mira Finch',
      role: 'clinician',
      title: 'Dr Mira Finch',
      phone: '+14155550127',
      evidence: [
        {
          textAnchor: 'Dr Mira Finch direct phone +14155550127.',
          supports: ['fullName', 'title', 'phone'],
          locator: 'prepared JSONL, clinician line',
        },
      ],
    },
    {
      id: 'juniper-vale',
      fullName: 'Juniper Vale',
      role: 'relative',
      relationship: 'Aunt',
      medicalHistory: 'migraines; onset unknown',
      evidence: [
        {
          textAnchor: 'Aunt Juniper Vale has migraines; onset unknown.',
          supports: ['fullName', 'relationship', 'medicalHistory'],
          locator: 'prepared JSONL, family history line',
        },
      ],
      uncertainties: ['Migraine onset is unknown.'],
    },
  ],
};

async function api<T>(page: Page, url: string, path: string, method = 'GET', body?: unknown) {
  const response = await page.request.fetch(url + path, {
    method,
    headers: method === 'GET' ? undefined : { Origin: url },
    data: body,
  });
  const payload = await response.json();
  assert(response.ok(), JSON.stringify(payload));
  return payload.data as T;
}

test(
  'encrypted browser explicitly updates, defers, and adds named People without clinical writes',
  { timeout: 90000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-browser-import-people-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startRuntime({
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

    browser = await chromium.launch({ headless: true });
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
      const status = await (await fetch('/api/runtime')).json();
      if (!status.encrypted) throw new Error('Encrypted runtime required');
      const pending = await post('/api/profile-setups', {
        fullName: 'Fictional People Journey',
        birthDate: '1982-04-17',
        name: 'Fictional People Journey',
      });
      const profile = await post(`/api/profile-setups/${pending.setupId}/verify`, {
        acknowledged: true,
        recovery: pending.recoveryKit,
      });
      return { profileId: profile.id };
    });
    const prefix = `/api/profiles/${setup.profileId}`;
    const existing = await api<{
      id: string;
      version: number;
      content: string;
      person: Record<string, unknown>;
    }>(page, url, prefix + '/notes', 'POST', {
      kind: 'person',
      title: 'Mira Finch',
      content: 'An unrelated note retained by the user.',
      person: {
        fullName: 'Mira Finch',
        email: 'mira@fictional.example',
        tags: ['Professional'],
      },
    });
    const selfBefore = await api<unknown>(page, url, prefix + '/notes/person-note%3Aself');
    const original = Buffer.from(`${JSON.stringify(envelope)}\n`);
    const upload = await page.request.post(url + prefix + '/intakes', {
      headers: {
        Origin: url,
        'Content-Type': 'application/x-ndjson',
        'X-Filename': 'fictional-named-people.jsonl',
      },
      data: original,
    });
    assert(upload.ok(), await upload.text());
    const intake = (await upload.json()).data;
    const reportQueue = await api<{
      groups: Array<{
        groupId: string;
        counts: { pending: number };
        peopleCounts: { pending: number };
      }>;
    }>(page, url, prefix + '/intakes/report-queue');
    assert.equal(reportQueue.groups[0]?.counts.pending, 0);
    assert.equal(reportQueue.groups[0]?.peopleCounts.pending, 2);
    const groupId = reportQueue.groups[0]!.groupId;

    const clinical = async () =>
      Promise.all(
        ['/tests?limit=20', '/medications?limit=20', '/procedures?limit=20'].map((path) =>
          api<unknown[]>(page, url, prefix + path),
        ),
      );
    assert.deepEqual(
      (await clinical()).map((rows) => rows.length),
      [0, 0, 0],
    );

    await page.goto(
      `${url}/#/import?intake=${encodeURIComponent(intake.id)}&group=${encodeURIComponent(groupId)}`,
    );
    await page.reload();
    const people = page.getByRole('region', { name: 'People from this report' });
    await people.getByRole('tab', { name: /To review\s+2/ }).waitFor();
    await people.getByRole('button', { name: /Mira Finch/ }).click();
    const miraReview = page.getByRole('region', { name: 'Review Mira Finch' });
    await miraReview.getByText('Dr Mira Finch direct phone +14155550127.').waitFor();
    const originalLink = miraReview.getByRole('link', { name: 'Open original' });
    const originalHref = await originalLink.getAttribute('href');
    assert(originalHref, 'the evidence link addresses the retained original');
    const downloaded = await page.request.get(url + originalHref);
    assert(downloaded.ok());
    assert.deepEqual(await downloaded.body(), original);

    let exactApplyBody: string | null = null;
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url().endsWith('/intakes/people-apply') &&
        exactApplyBody === null
      )
        exactApplyBody = request.postData();
    });
    const updatedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/intakes/people-apply') &&
        response.ok(),
    );
    await miraReview.getByRole('button', { name: 'Update Mira Finch', exact: true }).click();
    const updated = (await (await updatedResponse).json()).data;
    assert.equal(updated.action, 'update');
    assert.equal(updated.noteId, existing.id);
    assert.equal(updated.replayed, false);
    assert(exactApplyBody, 'the accepted UI request is available for an exact replay');
    const replay = await page.request.fetch(url + prefix + '/intakes/people-apply', {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      data: exactApplyBody,
    });
    assert(replay.ok(), await replay.text());
    const replayed = (await replay.json()).data;
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.noteId, existing.id);
    assert.equal(replayed.version, updated.version);

    const mira = await api<{
      id: string;
      version: number;
      content: string;
      person: Record<string, unknown>;
    }>(page, url, prefix + `/notes/${encodeURIComponent(existing.id)}`);
    assert.equal(mira.id, existing.id);
    assert.equal(mira.person.phone, '+14155550127');
    assert.equal(mira.person.email, 'mira@fictional.example');
    assert.equal(
      mira.content,
      'An unrelated note retained by the user.\n\nDr Mira Finch direct phone +14155550127.',
    );
    const afterMira = await api<Array<{ id: string; kind: string; isSelf?: boolean }>>(
      page,
      url,
      prefix + '/notes?kind=person&excludeSelf=1',
    );
    assert.deepEqual(
      afterMira.filter((note) => note.kind === 'person' && !note.isSelf).map((note) => note.id),
      [existing.id],
    );

    await miraReview.getByRole('button', { name: 'Back to People', exact: true }).click();
    const juniperRow = people.getByRole('article').filter({ hasText: 'Juniper Vale' });
    await juniperRow.getByRole('button', { name: 'Review later', exact: true }).click();
    await people.getByRole('tab', { name: /Review later\s+1/ }).waitFor();
    await page.reload();
    const deferredPeople = page.getByRole('region', { name: 'People from this report' });
    await deferredPeople.getByRole('tab', { name: /Review later\s+1/ }).click();
    await deferredPeople.getByRole('button', { name: /Juniper Vale/ }).click();
    const juniperReview = page.getByRole('region', { name: 'Review Juniper Vale' });
    await juniperReview.getByText('migraines; onset unknown', { exact: true }).waitFor();
    await juniperReview.getByRole('button', { name: 'Return to review', exact: true }).click();
    await juniperReview.getByRole('button', { name: 'Add as new person', exact: true }).waitFor();
    const addedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/intakes/people-apply') &&
        response.ok(),
    );
    await juniperReview.getByRole('button', { name: 'Add as new person', exact: true }).click();
    const added = (await (await addedResponse).json()).data;
    assert.equal(added.action, 'add');
    assert.notEqual(added.noteId, existing.id);
    await juniperReview.getByRole('link', { name: 'Open saved person', exact: true }).click();
    await page.getByRole('combobox', { name: 'Names', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Remove name Juniper Vale', exact: true }).waitFor();
    assert.match(page.url(), new RegExp(`[#/]people\\?id=${encodeURIComponent(added.noteId)}`));
    const importedEvidence = page.getByRole('region', { name: 'Imported source evidence' });
    await importedEvidence.getByText('No saved health entry cites this exact source.').waitFor();
    const evidencePath = `/notes/${encodeURIComponent(added.noteId)}/source-evidence`;
    const sourceRows = await api<Array<{ sourceRecordId: string; entries: unknown[] }>>(
      page,
      url,
      prefix + evidencePath,
    );
    assert.equal(sourceRows.length, 1);
    assert.deepEqual(sourceRows[0]!.entries, [], 'People evidence does not invent clinical links');
    const sourceHref = `#/sources?record=${encodeURIComponent(sourceRows[0]!.sourceRecordId)}`;
    assert.equal(
      await importedEvidence
        .getByRole('link', { name: 'View original source', exact: true })
        .getAttribute('href'),
      sourceHref,
    );
    await importedEvidence.getByRole('link', { name: 'View original source', exact: true }).click();
    await page.waitForURL((current) => current.hash === sourceHref);
    await page.goBack();
    await importedEvidence.waitFor();
    const anonymousRead = await fetch(url + prefix + evidencePath);
    assert.equal(anonymousRead.status, 423, 'even an open profile requires this browser session');
    assert.equal((await anonymousRead.json()).error.code, 'PROFILE_LOCKED');
    const refusedWrite = await page.request.post(url + prefix + evidencePath, {
      headers: { Origin: url },
      data: {},
    });
    assert.equal(refusedWrite.status(), 405, 'imported evidence is a read-only projection');
    assert.equal((await refusedWrite.json()).error.code, 'READ_ONLY_RESOURCE');
    const evidenceLink = page.getByRole('link', { name: 'View original source attribution' });
    const evidenceHref = await evidenceLink.getAttribute('href');
    assert.match(evidenceHref || '', /^#\/sources\?record=/);
    await evidenceLink.click();
    await page.waitForURL(/#\/sources\?record=/);

    const savedNotes = await api<
      Array<{
        id: string;
        kind: string;
        isSelf?: boolean;
        title: string;
        person: Record<string, unknown>;
      }>
    >(page, url, prefix + '/notes?kind=person&excludeSelf=1');
    const savedPeople = savedNotes.filter((note) => note.kind === 'person' && !note.isSelf);
    assert.equal(savedPeople.length, 2);
    const juniper = savedPeople.find((note) => note.id === added.noteId);
    assert(juniper);
    assert.equal(juniper.person.fullName, 'Juniper Vale');
    assert.equal(juniper.person.relationship, 'Aunt');
    assert.equal(juniper.person.medicalHistory, 'migraines; onset unknown');
    assert.equal(
      savedPeople.some((note) =>
        /maternal uncle/i.test(String(note.person.fullName || note.title)),
      ),
      false,
    );
    assert.deepEqual(
      await api<unknown>(page, url, prefix + '/notes/person-note%3Aself'),
      selfBefore,
    );
    assert.deepEqual(
      (await clinical()).map((rows) => rows.length),
      [0, 0, 0],
    );
  },
);
