import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { launchBrowser, newTestPage, startBrowserRuntime } from './harness.ts';
import { stopFixtureImport } from './manual-import-fixture.ts';
import { fixtureApi, fixtureDestinations, fixtureSourcePath } from './native-intake-fixture.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { CollectionImportFeed } from '../../shared/intake-clinical-pages.ts';
import type {
  IntakeClinicalRecordRead,
  IntakeClinicalReviewFragment,
} from '../../shared/intake-clinical-review.ts';
import type {
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceResult,
  IntakeReviewRecord,
} from '../../shared/intake.ts';

test(
  'native referenced record opens every exact evidence window before saving its retained draft',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-referenced-record-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startBrowserRuntime(t, {
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
      assistantOptions: { availability: () => ({ available: false }) },
    });
    const browser = await launchBrowser(t);
    t.after(async () => {
      await browser.close();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    });
    const page = await newTestPage(browser);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const origin = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(origin);
    const api = fixtureApi(page, origin);
    const setup = (await api('/api/profile-setups', {
      fullName: 'Fictional Reference Reader',
      name: 'Fictional Reference Reader',
      birthDate: '1982-04-17',
    })) as { setupId: string; recoveryKit: unknown };
    const profile = (await api(`/api/profile-setups/${setup.setupId}/verify`, {
      acknowledged: true,
      recovery: setup.recoveryKit,
    })) as { id: string };
    const prefix = `/api/profiles/${profile.id}`;
    // One independently fictional document forces an opaque record reference,
    // without introducing an unrelated large record population.
    const documentText =
      'Fictional first document passage.\n' +
      'Independently fictional retained wording. '.repeat(2400) +
      '\nFictional final document passage.';
    const original = Buffer.from(
      JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-reference-document',
        kind: 'record',
        subject: 'self',
        payload: { literal: 'Fictional retained reference document.' },
        clinical: {
          kind: 'document',
          subject: 'self',
          documentTitle: 'Fictional reference document',
          documentDate: '2032-03-04',
          text: documentText,
        },
        report: {
          key: 'fictional-reference-report',
          title: 'Fictional reference report',
          anchor: { locator: 'whole fictional document', text: 'Fictional reference document' },
          subject: null,
        },
        provenance: {
          capturedVia: 'Fictional reference test',
          sourceSystem: 'Fictional Redwood Clinic',
          sourceRecordId: 'fictional-reference-document',
          evidenceClass: 'provider_export',
          locator: 'whole fictional document',
        },
        coverage: { status: 'complete_response', notes: [] },
      }) + '\n',
    );
    const upload = await page.request.post(origin + prefix + '/intakes', {
      headers: {
        Origin: origin,
        'Content-Type': 'application/x-ndjson',
        'X-Filename': 'fictional-reference-document.jsonl',
      },
      data: original,
    });
    assert.equal(upload.status(), 201, await upload.text());
    const intake = await stopFixtureImport(page, origin, prefix, (await upload.json()).data.id);
    const feed = (await api(
      prefix + '/intakes/import-feed?view=all&intakeId=' + encodeURIComponent(intake.id),
    )) as CollectionImportFeed;
    assert.equal(feed.format, 'health-intake-import-feed-v2');
    assert.equal(feed.totalRecords, 1);
    assert.equal(feed.records.length, 1);
    assert.equal(feed.nextCursor, null);
    const row = feed.records[0]!;
    assert.ok(row.detail.kind === 'reference');
    const recordId = row.detail.selection.recordId;
    const params = new URLSearchParams({
      intake: intake.id,
      group: row.groupId,
      proposal: row.proposalId || 'original',
      record: recordId,
      review: 'full',
    });
    const initialResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/review-record') &&
        new URL(response.url()).searchParams.get('recordId') === recordId &&
        response.ok(),
    );
    await page.goto(origin + '/#/import?' + params);
    const initial = (await (await initialResponse).json()).data as IntakeClinicalRecordRead;
    assert.equal(initial.format, 'health-intake-clinical-record-v2');
    assert.ok(initial.record.kind === 'reference');
    const selected = initial.record;
    assert.equal(selected.selection.recordId, recordId);
    assert.equal(selected.policy.canAcceptUnchanged, true);
    assert.ok(selected.reference.bytes > 65536);
    assert.ok(selected.selection.candidateVersionId);
    assert.ok(selected.selection.selectionReviewToken);
    const review = page.getByRole('region', { name: 'Review referenced record', exact: true });
    const save = review.getByRole('button', { name: 'Save reviewed clinical record', exact: true });
    await save.waitFor();
    assert.equal(await save.isDisabled(), true);
    const chunks: Buffer[] = [];
    let offset: number | null = 0;
    do {
      const nextResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith('/review-fragment') &&
          response.ok() &&
          response.request().postDataJSON().offset === offset,
      );
      await review
        .getByRole('button', {
          name: offset === 0 ? 'Open evidence' : 'Next evidence page',
          exact: true,
        })
        .click();
      const response = await nextResponse;
      const request = response.request().postDataJSON();
      assert.deepEqual(request.reference, selected.reference);
      assert.equal(request.proposalId, initial.context.proposalId);
      assert.equal(request.bytes, 32768);
      const fragment = (await response.json()).data as IntakeClinicalReviewFragment;
      const chunk = Buffer.from(fragment.data, 'base64');
      assert.ok(chunk.length > 0 && chunk.length <= 32768);
      chunks.push(chunk);
      offset = fragment.nextOffset;
      assert.equal(fragment.complete, offset === null);
      if (offset !== null) {
        assert.equal(
          offset,
          chunks.reduce((total, bytes) => total + bytes.length, 0),
        );
        await review.getByRole('button', { name: 'Next evidence page', exact: true }).waitFor();
        assert.equal(await save.isDisabled(), true, 'an unfinished reference cannot save');
      } else
        await review
          .getByText('All pages of this exact item have been opened.', { exact: true })
          .waitFor();
      assert.equal(await review.locator('pre').count(), 1, 'only one evidence window is mounted');
      assert.ok(Buffer.byteLength(await review.locator('pre').innerText()) <= 32768);
    } while (offset !== null);
    const complete = Buffer.concat(chunks);
    assert.equal(complete.length, selected.reference.bytes);
    const retainedDraft = JSON.parse(complete.toString('utf8')) as IntakeReviewRecord;
    assert.equal(retainedDraft.id, recordId);
    assert.equal(retainedDraft.candidateVersionId, selected.selection.candidateVersionId);
    assert.equal(retainedDraft.mapping.text, documentText);
    await save.and(page.locator(':enabled')).waitFor();
    const freshResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname.endsWith('/review-record') && response.ok(),
    );
    const acceptedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/intakes/report-acceptance') &&
        response.request().method() === 'POST',
    );
    await save.click();
    const fresh = (await (await freshResponse).json()).data as IntakeClinicalRecordRead;
    assert.ok(fresh.record.kind === 'reference');
    assert.deepEqual(fresh.record.selection, selected.selection);
    assert.equal(fresh.context.reviewToken, initial.context.reviewToken);
    const accepted = await acceptedResponse;
    assert.equal(accepted.status(), 200, await accepted.text());
    const command = accepted.request().postDataJSON() as IntakeReportAcceptanceRequest;
    assert.equal(command.mode, 'partial-v1');
    assert.equal(command.blocks.length, 1);
    assert.equal(command.blocks[0]!.intakeVersion, fresh.context.version);
    assert.equal(command.blocks[0]!.reviewToken, fresh.context.reviewToken);
    assert.deepEqual(command.blocks[0]!.selections, [
      {
        recordId,
        candidateId: selected.selection.candidateId,
        candidateVersionId: selected.selection.candidateVersionId,
        selectionReviewToken: selected.selection.selectionReviewToken,
        mapping: {},
        useRetainedDecision: true,
      },
    ]);
    const result = (await accepted.json()).data as IntakeReportAcceptanceResult;
    assert.equal(result.receipt.operationId, command.operationId);
    assert.equal(result.receipt.acceptedCount, 1);
    assert.equal(result.receipt.selectedCount, 1);
    const persistedReceipt = (await api(
      prefix + '/intakes/report-acceptance/' + encodeURIComponent(command.operationId),
    )) as IntakeReportAcceptanceResult;
    assert.deepEqual(persistedReceipt.receipt, result.receipt);
    const destinations = await fixtureDestinations(api, prefix, intake.id);
    assert.equal(destinations.length, 1);
    assert.equal(destinations[0]!.recordId, recordId);
    assert.equal(destinations[0]!.kind, 'document');
    assert.equal(result.receipt.receipts.length, 1);
    const receipt = result.receipt.receipts[0]!;
    assert.equal(receipt.intakeId, intake.id);
    assert.equal(receipt.proposalId, initial.context.proposalId);
    assert.equal(receipt.intakeVersionBefore, fresh.context.version);
    assert.equal(receipt.reviewToken, fresh.context.reviewToken);
    assert.equal(receipt.records.length, 1);
    const { candidateId, candidateVersionId, ...destination } = receipt.records[0]!;
    assert.equal(candidateId, selected.selection.candidateId);
    assert.equal(candidateVersionId, selected.selection.candidateVersionId);
    assert.deepEqual(destination, destinations[0]);
    const document = (await api(
      prefix + '/documents/' + encodeURIComponent(destinations[0]!.entityId),
    )) as { text: string };
    assert.equal(document.text, documentText);
    const originalResponse = await page.request.get(
      origin + fixtureSourcePath(prefix, intake.contentUrl),
    );
    assert.equal(originalResponse.status(), 200);
    assert.deepEqual(await originalResponse.body(), original);
    assert.deepEqual(errors, []);
  },
);
