import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createImportDiagnostics } from '../import-diagnostics.ts';
import { assertProviderWait, completedProviderWait } from './launch-performance-fixture.ts';

test('complaint qualification joins the gated import through each export salt, excluding older slow requests', () => {
  const diagnostics = createImportDiagnostics();
  try {
    const profileId = 'fictional',
      uploadOperationId = randomUUID();
    const providerIds = new Map(
      ['earlier-import', 'selected-import'].map((id) => [id, randomUUID()]),
    );
    diagnostics.record(
      'import.progress',
      {},
      { profileId, operationId: uploadOperationId, importId: 'selected-import' },
    );
    for (const importId of ['earlier-import', 'selected-import'])
      diagnostics.record(
        'model.request.started',
        {},
        { profileId, importId, providerRequestId: providerIds.get(importId) },
      );
    // A completed earlier chat/import must never stand in for the chosen one.
    diagnostics.record(
      'model.request.completed',
      { durationMs: 5000 },
      {
        profileId,
        importId: 'earlier-import',
        providerRequestId: providerIds.get('earlier-import'),
      },
    );
    const snapshot = () => ({ enabled: false, ...diagnostics.exportSnapshot(profileId) });
    const first = assertProviderWait(snapshot(), uploadOperationId);
    const second = assertProviderWait(snapshot(), uploadOperationId);
    assert.notEqual(
      first.operationId,
      second.operationId,
      'salted import IDs are not cross-export join keys',
    );
    assert.throws(() => completedProviderWait(snapshot(), uploadOperationId), /exact conversion/);
    diagnostics.record(
      'model.request.completed',
      { durationMs: 1250 },
      {
        profileId,
        importId: 'selected-import',
        providerRequestId: providerIds.get('selected-import'),
      },
    );
    const completed = completedProviderWait(snapshot(), uploadOperationId);
    assert.equal(
      completed.spans.find((span) => span.durationMs === 5000),
      undefined,
    );
    assert.ok(completed.spans.some((span) => span.durationMs === 1250));
  } finally {
    diagnostics.close();
  }
});
