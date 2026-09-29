import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { openDatabase } from '../database.ts';
import { createApp } from '../index.ts';
import { createImportDiagnostics } from '../import-diagnostics.ts';

test('profile API ingests strict browser summaries without diagnostic feedback and joins explicit operations', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'circus-performance-http-'));
  const profileId = 'fictional';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const diagnostics = createImportDiagnostics({ enabled: false });
  const app = createApp({ root, databases: new Map([[profileId, db]]), diagnostics });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    diagnostics.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/${profileId}`;
  const status = await (await fetch(`${url}/import-diagnostics/status`)).json();
  assert.deepEqual(status, { data: { enabled: false } });
  assert.equal(
    (await fetch(url.replace('/fictional', '/missing') + '/import-diagnostics/status')).status,
    404,
  );
  const operationId = randomUUID(),
    requestId = randomUUID();
  const request = await fetch(`${url}/notes`, {
    headers: { 'X-Client-Operation-ID': operationId, 'X-Client-Request-ID': requestId },
  });
  assert.equal(request.status, 200);
  await request.arrayBuffer();
  const posted = await fetch(`${url}/import-diagnostics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
    body: JSON.stringify({
      operationId,
      kind: 'review_open',
      outcome: 'completed',
      durationMs: 25,
      requestIds: [requestId],
      counts: { rows: 3 },
      clinicalText: 'Fictional forbidden content',
    }),
  });
  assert.equal(posted.status, 200);
  await posted.arrayBuffer();
  const snapshot = async () => {
    const envelope = await (await fetch(`${url}/import-diagnostics`)).json();
    assert.equal(envelope.meta, undefined);
    assert.doesNotMatch(JSON.stringify(envelope), /fictional|forbidden content/);
    return envelope.data;
  };
  const result = await snapshot();
  assert.equal(result.enabled, false);
  const op = result.recentPerformance.operations.find(
    (entry: { operationId: string }) => entry.operationId === operationId,
  );
  assert.ok(op);
  assert.equal(op.client.counts.rows, 3);
  assert.ok(op.spans.some((s: { phase: string }) => s.phase === 'server_request'));
  assert.doesNotMatch(JSON.stringify(result), /forbidden content|clinicalText/);
  assert.equal(
    (await snapshot()).recentPerformance.operations.length,
    result.recentPerformance.operations.length,
  );
  assert.ok(result.attribution && !result.attribution.unavailable);
  const invalid = await fetch(`${url}/import-diagnostics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
    body: JSON.stringify({
      operationId,
      kind: 'private name',
      outcome: 'completed',
      durationMs: 25,
    }),
  });
  assert.equal(invalid.status, 400);
  await invalid.arrayBuffer();
  const oversized = await fetch(`${url}/import-diagnostics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
    body: JSON.stringify({ padding: 'x'.repeat(33000) }),
  });
  assert.equal(oversized.status, 413);
  await oversized.arrayBuffer();
  assert.equal(
    (await fetch(url.replace('/fictional', '/missing') + '/import-diagnostics')).status,
    404,
  );
});
