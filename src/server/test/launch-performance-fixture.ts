import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import type { Intake } from '../../shared/intake.ts';
import type { RecentOperationTimeline } from '../../shared/import-performance.ts';
import type { ImportDiagnosticExport } from '../import-diagnostics.ts';

export type ComplaintSnapshot = ImportDiagnosticExport & { enabled: boolean };
export const complaintDelayMs = 1200;

/** Valid, wholly fictional one-page original, with no extraction-accuracy oracle. */
export function complaintPdf() {
  const content =
    'BT /F1 12 Tf 36 740 Td (Fictional Make Juggler. DOB 1982-04-17.) Tj 0 -24 Td (Fictional retained original for latency qualification only.) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export function assertCompactComplaintSnapshot(snapshot: ComplaintSnapshot) {
  assert.equal(snapshot.enabled, false, 'qualification must exercise default compact summaries');
  assert.equal(snapshot.events.length, 0, 'detailed event export remains disabled');
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /Fictional Make Juggler|1982-04-17|Fictional retained original|fictional-provider-key|fictional\.pdf/,
    'diagnostics must omit health content, source names and credentials',
  );
  return snapshot.recentPerformance!.operations;
}

/** HTTP streaming is deliberate: fetch with a prebuilt Buffer would hide chunk pauses. */
export async function uploadWithComplaintDelay(
  base: string,
  path: string,
  cookie: string,
  bytes: Buffer,
) {
  const operationId = randomUUID();
  let request!: ReturnType<typeof httpRequest>;
  const response = new Promise<Intake>((resolve, reject) => {
    request = httpRequest(
      base + path + '/intakes',
      {
        method: 'POST',
        headers: {
          Origin: base,
          Cookie: cookie,
          'Content-Type': 'application/pdf',
          'Content-Length': bytes.length,
          'X-Filename': 'fictional.pdf',
          'X-Source-Name': 'Fictional%20Make%20Clinic',
          'X-Content-SHA256': createHash('sha256').update(bytes).digest('hex'),
          'X-Client-Operation-ID': operationId,
        },
      },
      (reply) => {
        const chunks: Buffer[] = [];
        reply.on('data', (chunk: Buffer) => chunks.push(chunk));
        reply.on('error', reject);
        reply.on('end', () => {
          try {
            assert.equal(reply.statusCode, 201, Buffer.concat(chunks).toString());
            resolve((JSON.parse(Buffer.concat(chunks).toString()) as { data: Intake }).data);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('Fictional upload timed out')));
  });
  // Observe early server rejection while the writer is deliberately paused.
  void response.catch(() => {});
  try {
    request.flushHeaders();
    const size = Math.ceil(bytes.length / 4);
    for (let index = 0; index < 4; index++) {
      if (index) await delay(complaintDelayMs / 3);
      request.write(bytes.subarray(index * size, (index + 1) * size));
    }
    request.end();
    return { intake: await response, operationId };
  } catch (error) {
    request.destroy();
    throw error;
  }
}

export function assertSlowUpload(snapshot: ComplaintSnapshot, operationId: string, bytes: number) {
  const operation = assertCompactComplaintSnapshot(snapshot).find(
    (item) => item.operationId === operationId,
  );
  assert.ok(operation, 'client upload UUID must join the server timeline');
  assert.equal(operation.status, 'completed');
  const stream = operation.spans.find((span) => span.phase === 'upload_stream');
  const publication = operation.spans.find((span) => span.phase === 'upload_publish');
  const fsync = operation.spans.find((span) => span.phase === 'upload_staging_fsync');
  const retention = operation.spans.find(
    (span) =>
      ['upload_original_adopt', 'upload_original_copy'].includes(span.phase) &&
      span.outcome === 'completed',
  );
  assert.ok(stream && publication && fsync && retention);
  assert.equal(stream.fields.receivedBytes, bytes);
  assert.ok(Number(stream.fields.chunkCount) >= 2);
  assert.ok(
    Number(stream.fields.streamWaitMs) >= complaintDelayMs * 0.75,
    'known wire pauses must appear in stream wait',
  );
  assert.ok(Number(stream.fields.hashMs) >= 0 && Number(stream.fields.stagingWriteMs) >= 0);
  assert.ok(publication.durationMs !== null && fsync.durationMs !== null);
  assert.ok(retention.durationMs !== null);
  return {
    operationId,
    streamWaitMs: stream.fields.streamWaitMs,
    hashMs: stream.fields.hashMs,
    stagingWriteMs: stream.fields.stagingWriteMs,
    publishMs: publication.durationMs,
    fsyncMs: fsync.durationMs,
    retentionMethod: retention.phase === 'upload_original_adopt' ? 'adopt' : 'copy',
    retentionMs: retention.durationMs,
  };
}

function providerOperationForUpload(snapshot: ComplaintSnapshot, uploadOperationId: string) {
  const operations = assertCompactComplaintSnapshot(snapshot);
  const upload = operations.find((item) => item.operationId === uploadOperationId);
  assert.ok(
    upload?.relatedImportIds.length,
    'upload must identify its retained original in this export',
  );
  // Import IDs change with each export salt. Join within one export through the
  // stable browser upload UUID instead of comparing anonymized IDs across exports.
  const matches = operations.filter(
    (item) =>
      upload.relatedImportIds.includes(item.context.importId || '') &&
      item.spans.some((span) => span.phase === 'provider_request'),
  );
  assert.equal(matches.length, 1, 'exactly this upload must identify the gated conversion');
  return matches[0]!;
}

export function assertProviderWait(snapshot: ComplaintSnapshot, uploadOperationId: string) {
  const operation = providerOperationForUpload(snapshot, uploadOperationId);
  assert.equal(operation.status, 'active');
  assert.equal(operation.currentStage, 'provider_request');
  assert.ok(operation, 'live conversion must expose its actual provider wait');
  assert.ok(
    operation.spans.some(
      (span) =>
        span.phase === 'provider_request' && span.outcome === 'active' && span.durationMs === null,
    ),
  );
  return operation;
}

export function completedProviderWait(snapshot: ComplaintSnapshot, uploadOperationId: string) {
  const operation = providerOperationForUpload(snapshot, uploadOperationId);
  assert.ok(
    operation.spans.some(
      (span) =>
        span.phase === 'provider_request' && (span.durationMs ?? 0) >= complaintDelayMs * 0.75,
    ),
    'the exact conversion must retain the known synthetic upstream wait',
  );
  assert.equal(operation.status, 'completed');
  assert.equal(operation.currentStage, null);
  assert.equal(
    operation.spans.some((span) => span.outcome === 'active'),
    false,
  );
  return operation;
}

/** Holds a real response after server work completes; no production delay hooks. */
export async function reviewWithComplaintDelay(
  base: string,
  cookie: string,
  profileId: string,
  snapshot: () => Promise<ComplaintSnapshot>,
) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const separator = cookie.indexOf('=');
    assert.ok(separator > 0);
    await context.addCookies([
      {
        name: cookie.slice(0, separator),
        value: cookie.slice(separator + 1),
        url: base,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    await context.addInitScript((id) => localStorage.setItem('health-profile', id), profileId);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let operationId = '',
      requestId = '',
      heldMs = 0,
      serverReturned = false,
      intercepted = false;
    await page.route('**/intakes/import-feed?*', async (route) => {
      if (intercepted) return route.continue();
      intercepted = true;
      const response = await route.fetch();
      assert.ok(response.ok());
      operationId = route.request().headers()['x-client-operation-id'] || '';
      requestId = response.headers()['x-request-id'] || '';
      assert.ok(operationId && requestId, 'actual browser request must carry correlation IDs');
      serverReturned = true;
      const heldAt = performance.now();
      await delay(complaintDelayMs);
      heldMs = performance.now() - heldAt;
      await route.fulfill({ response });
    });
    await page.goto(base + '/#/import');
    let operation: RecentOperationTimeline | undefined;
    for (let attempt = 0; attempt < 150; attempt++) {
      operation = assertCompactComplaintSnapshot(await snapshot()).find(
        (item) => item.operationId === operationId && item.client?.kind === 'review_open',
      );
      if (operation?.client?.outcome === 'completed') break;
      await delay(100);
    }
    assert.ok(
      serverReturned && operation?.client,
      'compiled Import UI must publish its completed review timing',
    );
    assert.equal(operation.client.outcome, 'completed');
    assert.equal(operation.status, 'completed');
    assert.equal(operation.context.requestId, requestId);
    assert.ok(operation.client.requestIds?.includes(requestId));
    const apiWaitMs = operation.client.phases?.find(
      (phase) => phase.phase === 'api_wait',
    )?.durationMs;
    const renderMs = operation.client.phases?.find(
      (phase) => phase.phase === 'render_wait',
    )?.durationMs;
    const serverMs = operation.spans.find((span) => span.phase === 'server_request')?.durationMs;
    assert.ok(
      typeof apiWaitMs === 'number' && typeof renderMs === 'number' && typeof serverMs === 'number',
    );
    assert.ok(apiWaitMs >= heldMs * 0.9, 'browser wait must include held response delivery');
    assert.ok(
      apiWaitMs - serverMs >= heldMs * 0.8,
      'held delivery must remain outside measured server work',
    );
    assert.ok(operation.spans.some((span) => span.phase === 'review_feed_query'));
    assert.ok(['two_frames', 'timeout'].includes(operation.client.renderObservation || ''));
    assert.deepEqual(errors, []);
    const browserBundles = [];
    for (const url of await page
      .locator('script[src]')
      .evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).src))) {
      const asset = new URL(url);
      if (
        asset.origin !== base ||
        !asset.pathname.startsWith('/assets/') ||
        !asset.pathname.endsWith('.js')
      )
        continue;
      const response = await context.request.get(url);
      assert.ok(response.ok());
      browserBundles.push({
        path: asset.pathname,
        sha256: createHash('sha256')
          .update(await response.body())
          .digest('hex'),
      });
    }
    assert.ok(
      browserBundles.length,
      'review must use the compiled app bundle served by the container',
    );
    return {
      operationId,
      requestId,
      heldMs,
      apiWaitMs,
      serverMs,
      renderMs,
      renderObservation: operation.client.renderObservation,
      browserBundles,
    };
  } finally {
    await browser.close();
  }
}
