import {
  fixtureReview,
  fixtureProposalId,
  fixtureDestinations,
  fixtureSourcePath,
} from './native-intake-fixture.ts';
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

const originalBytes = Buffer.from(
  [
    'Fictional Sunrise ferritin: <7.20 ng/mL on 2024-05.',
    'Fictional guided imaging was performed on 2024-06-18.',
    'Fictional retained provider report dated 2024.',
  ].join('\n'),
);

const entries = [
  {
    format: 'health-record-v1',
    id: 'fictional-observation-envelope',
    kind: 'record',
    subject: 'unknown',
    payload: { literal: 'Fictional Sunrise ferritin: <7.20 ng/mL on 2024-05.' },
    clinical: {
      kind: 'observation',
      subject: 'unknown',
      testLabel: 'Fictional Sunrise ferritin',
      valueText: '<7.20',
      unit: 'ng/mL',
      date: '2024-05',
      eventKind: 'performed',
      observationCategory: 'Laboratory',
    },
    provenance: {
      capturedVia: 'Encrypted fictional browser upload',
      sourceSystem: 'Fictional Sunrise Diagnostics',
      sourceRecordId: 'issuer-result-FS-720',
      evidenceClass: 'provider_export',
      locator: 'fictional-clinical-destinations.txt line 1',
    },
    coverage: { status: 'complete_response', notes: ['Exact fictional line supplied'] },
  },
  {
    format: 'health-record-v1',
    id: 'fictional-procedure-envelope',
    kind: 'record',
    subject: 'unknown',
    payload: { literal: 'Fictional guided imaging was performed on 2024-06-18.' },
    clinical: {
      kind: 'procedure',
      subject: 'unknown',
      procedureLabel: 'Fictional Sunrise guided imaging',
      procedureCategory: 'imaging',
      eventKind: 'performed',
      status: 'completed',
      date: '2024-06-18',
    },
    provenance: {
      capturedVia: 'Encrypted fictional browser upload',
      sourceSystem: 'Fictional Sunrise Diagnostics',
      sourceRecordId: 'issuer-procedure-FS-618',
      evidenceClass: 'provider_export',
      locator: 'fictional-clinical-destinations.txt line 2',
    },
    coverage: { status: 'complete_response', notes: ['Exact fictional line supplied'] },
  },
  {
    format: 'health-record-v1',
    id: 'fictional-document-envelope',
    kind: 'document',
    subject: 'unknown',
    payload: { literal: 'Fictional retained provider report dated 2024.' },
    clinical: {
      kind: 'document',
      subject: 'unknown',
      documentTitle: 'Fictional Sunrise retained report',
      documentDate: '2024',
      date: '2024',
      text: 'Fictional retained provider report dated 2024.',
    },
    provenance: {
      capturedVia: 'Encrypted fictional browser upload',
      sourceSystem: 'Fictional Sunrise Diagnostics',
      sourceRecordId: 'issuer-document-FS-2024',
      evidenceClass: 'provider_export',
      locator: 'fictional-clinical-destinations.txt line 3',
    },
    coverage: { status: 'complete_response', notes: ['Exact fictional line supplied'] },
  },
] as const;

test(
  'encrypted acceptance links to exact observation, performed procedure, and retained document DTOs',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-browser-clinical-destinations-'));
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
    const page = await newTestPage(browser, { viewport: { width: 1280, height: 900 } });
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
        fullName: 'Fictional clinical destinations browser',
        birthDate: '1982-04-17',
        name: 'Fictional clinical destinations browser',
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

    const upload = await page.request.post(url + prefix + '/intakes', {
      headers: {
        Origin: url,
        'Content-Type': 'text/plain',
        'X-Filename': 'fictional-clinical-destinations.txt',
      },
      data: originalBytes,
    });
    assert.equal(upload.status(), 201);
    let intake = await stopFixtureImport(page, url, prefix, (await upload.json()).data.id);
    intake = await request(`${prefix}/intakes/${encodeURIComponent(intake.id)}/proposals`, 'POST', {
      version: intake.version,
      summary: 'Three independently fictional destination records for explicit acceptance.',
      jsonlText: entries.map((entry) => JSON.stringify(entry)).join('\n'),
    });
    const intakePath = `${prefix}/intakes/${encodeURIComponent(intake.id)}`;
    const proposalId = await fixtureProposalId(
      (path: string, body?: unknown) => request(path, body === undefined ? 'GET' : 'POST', body),
      prefix,
      intake.id,
    );
    const reviewPath = intakePath + '/review?proposalId=' + encodeURIComponent(proposalId);
    let review = await fixtureReview(
      (path: string, body?: unknown) => request(path, body === undefined ? 'GET' : 'POST', body),
      reviewPath,
    );

    for (const expectedTitle of [
      'Fictional Sunrise ferritin',
      'Fictional Sunrise guided imaging',
      'Fictional Sunrise retained report',
    ]) {
      const record = review.records.find((candidate: { title: string }) =>
        candidate.title.includes(expectedTitle),
      );
      assert(record, `review contains ${expectedTitle}`);
      const identity = record.issues!.find(
        (issue: { kind: string; status: string }) =>
          issue.kind === 'identity' && issue.status === 'unresolved',
      );
      assert(identity, `${expectedTitle} requires explicit Self review`);
      await request(intakePath + '/review-draft', 'POST', {
        version: review.version,
        operationId: `confirm-${record.id}`,
        proposalId,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId,
        resolutions: [
          { issueId: identity.id, outcome: 'this_is_me', mapping: { subject: 'self' } },
        ],
      });
      review = await fixtureReview(
        (path: string, body?: unknown) => request(path, body === undefined ? 'GET' : 'POST', body),
        reviewPath,
      );
    }

    const accepted = await request(intakePath + '/import', 'POST', {
      version: review.version,
      proposalId,
      reviewToken: review.reviewToken,
      decisions: review.records.map((record: { id: string; mapping: unknown }) => ({
        recordId: record.id,
        action: 'accept',
        mapping: record.mapping,
      })),
    });
    assert.equal(accepted.state, 'imported');
    const receiptRecords = await fixtureDestinations(
      (path: string, body?: unknown) => request(path, body === undefined ? 'GET' : 'POST', body),
      prefix,
      intake.id,
    );
    assert.equal(receiptRecords.length, 3);
    const observationReceipt = receiptRecords.find(
      (record: { kind: string }) => record.kind === 'observation',
    );
    const procedureReceipt = receiptRecords.find(
      (record: { kind: string }) => record.kind === 'procedure',
    );
    const documentReceipt = receiptRecords.find(
      (record: { kind: string }) => record.kind === 'document',
    );
    assert(observationReceipt && procedureReceipt && documentReceipt);

    const savedFeed = await request(prefix + '/intakes/import-feed?view=all&state=accepted');
    const savedBlocks = new Map<string, { groupId: string }>();
    for (const receipt of receiptRecords) {
      const block = savedFeed.records.find(
        (candidate: {
          detail: { kind: string; record?: { id: string }; selection?: { recordId: string } };
        }) =>
          (candidate.detail.kind === 'record'
            ? candidate.detail.record?.id
            : candidate.detail.selection?.recordId) === receipt.recordId,
      );
      assert(block, `saved Import feed retains exact ${receipt.kind} report record`);
      savedBlocks.set(receipt.recordId, block);
      await page.goto(
        url +
          '/#/import?intake=' +
          encodeURIComponent(intake.id) +
          '&group=' +
          encodeURIComponent(block.groupId),
      );
      await page.reload();
      const expectedTitle =
        receipt.kind === 'observation'
          ? 'Fictional Sunrise ferritin'
          : receipt.kind === 'procedure'
            ? 'Fictional Sunrise guided imaging'
            : 'Fictional Sunrise retained report';
      const exactLink = page.locator(
        `.import-detail-record-link:not([data-saved-record-id])[href*='record=${encodeURIComponent(receipt.recordId)}']`,
      );
      await exactLink.waitFor();
      assert.match(
        (await exactLink.getAttribute('href')) || '',
        new RegExp('record=' + encodeURIComponent(receipt.recordId)),
      );
      await exactLink.click();
      await page.getByRole('heading', { name: expectedTitle, exact: true }).waitFor();
    }

    await page.goto(
      url +
        '/#/import?intake=' +
        encodeURIComponent(intake.id) +
        '&group=' +
        encodeURIComponent(savedBlocks.get(observationReceipt.recordId)!.groupId),
    );
    const observationLink = page
      .getByRole('region', { name: 'Saved destinations for this report' })
      .getByRole('link')
      .filter({ hasText: 'Fictional Sunrise ferritin' });
    assert.equal(
      await observationLink.getAttribute('href'),
      `#/tests?result=${encodeURIComponent(observationReceipt.entityId)}&visibility=all`,
    );
    await observationLink.click();
    await page.waitForURL(new RegExp(`result=${encodeURIComponent(observationReceipt.entityId)}`));
    await page
      .getByRole('region', { name: 'Selected result' })
      .getByRole('heading', { name: 'Fictional Sunrise ferritin', level: 2, exact: true })
      .waitFor();
    const observation = await request(
      `${prefix}/tests/${encodeURIComponent(observationReceipt.entityId)}`,
    );
    assert.equal(observation.label, 'Fictional Sunrise ferritin');
    assert.equal(observation.valueText, '<7.20');
    assert.equal(observation.comparator, '<');
    assert.equal(observation.value, 7.2);
    assert.equal(observation.unit, 'ng/mL');
    assert.equal(observation.date, '2024-05');
    assert.equal(observation.datePrecision, 'month');
    assert.equal(observation.sourceRecordId, observationReceipt.recordId);
    assert.equal(observation.extra.import.sourceRecordId, 'issuer-result-FS-720');
    assert.equal(observation.extra.import.acceptedMapping.eventKind, 'performed');
    assert.equal(observation.evidence[0].locator.originalSourceFileId, intake.id);

    await page.goto(
      url +
        '/#/import?intake=' +
        encodeURIComponent(intake.id) +
        '&group=' +
        encodeURIComponent(savedBlocks.get(procedureReceipt.recordId)!.groupId),
    );
    const procedureLink = page
      .getByRole('region', { name: 'Saved destinations for this report' })
      .getByRole('link')
      .filter({ hasText: 'Fictional Sunrise guided imaging' });
    assert.equal(
      await procedureLink.getAttribute('href'),
      `#/procedures?id=${encodeURIComponent(procedureReceipt.entityId)}&category=all&visibility=all`,
    );
    await procedureLink.click();
    await page.waitForURL(new RegExp(`id=${encodeURIComponent(procedureReceipt.entityId)}`));
    await page
      .getByRole('heading', {
        name: 'Fictional Sunrise guided imaging',
        exact: true,
        level: 2,
      })
      .waitFor();
    await page.getByText('Performed event', { exact: true }).first().waitFor();
    const procedure = await request(
      `${prefix}/procedures/${encodeURIComponent(procedureReceipt.entityId)}`,
    );
    assert.equal(procedure.label, 'Fictional Sunrise guided imaging');
    assert.equal(procedure.category, 'imaging');
    assert.equal(procedure.date, '2024-06-18');
    assert.equal(procedure.status, 'completed');
    assert.equal(procedure.sourceRecordId, procedureReceipt.recordId);
    assert.equal(procedure.extra.import.sourceRecordId, 'issuer-procedure-FS-618');
    assert.equal(procedure.extra.import.acceptedMapping.eventKind, 'performed');
    assert.equal(procedure.evidence[0].locator.originalSourceFileId, intake.id);

    await page.goto(
      url +
        '/#/import?intake=' +
        encodeURIComponent(intake.id) +
        '&group=' +
        encodeURIComponent(savedBlocks.get(documentReceipt.recordId)!.groupId),
    );
    const documentLink = page
      .getByRole('region', { name: 'Saved destinations for this report' })
      .getByRole('link')
      .filter({ hasText: 'Fictional Sunrise retained report' });
    assert.equal(
      await documentLink.getAttribute('href'),
      `#/sources?document=${encodeURIComponent(documentReceipt.entityId)}`,
    );
    await documentLink.click();
    await page.waitForURL(new RegExp(`document=${encodeURIComponent(documentReceipt.entityId)}`));
    await page
      .getByRole('heading', { name: 'Fictional Sunrise retained report', exact: true })
      .waitFor();
    const document = await request(
      `${prefix}/documents/${encodeURIComponent(documentReceipt.entityId)}`,
    );
    assert.equal(document.title, 'Fictional Sunrise retained report');
    assert.equal(document.date, '2024');
    assert.equal(document.text, 'Fictional retained provider report dated 2024.');
    assert.equal(document.sourceRecordId, documentReceipt.recordId);
    assert.equal(document.extra.import.sourceRecordId, 'issuer-document-FS-2024');
    assert.equal(document.evidence[0].locator.originalSourceFileId, intake.id);

    await page.goto(url + '/#/import');
    await page.reload();
    await page.getByRole('combobox', { name: 'Review status' }).selectOption('saved');
    const savedObservation = page
      .locator('.import-record-destination')
      .getByRole('link')
      .filter({ hasText: 'Fictional Sunrise ferritin' });
    await savedObservation.waitFor();
    assert.equal(
      await savedObservation.getAttribute('href'),
      `#/tests?result=${encodeURIComponent(observationReceipt.entityId)}&visibility=all`,
      'the durable destination remains discoverable from the Saved view after reload',
    );

    const historical = await page.request.get(
      url + `${prefix}/historical-notes/${encodeURIComponent(documentReceipt.entityId)}`,
    );
    assert.equal(
      historical.status(),
      404,
      'a general provider document is not invented as a clinician Historical note',
    );
    const original = await page.request.get(url + fixtureSourcePath(prefix, intake.contentUrl));
    assert.deepEqual(Buffer.from(await original.body()), originalBytes);
  },
);
