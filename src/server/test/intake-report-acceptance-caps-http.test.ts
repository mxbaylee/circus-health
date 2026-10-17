import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { createApp } from '../index.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { fictionalModel } from './fictional-model.ts';
import type { IntakeReportAcceptanceBlock } from '../../shared/intake.ts';

function block(index: number, count: number): IntakeReportAcceptanceBlock {
  return {
    intakeId: `fictional-cap-source-${index}`,
    proposalId: null,
    intakeVersion: 1,
    reviewToken: 'fictional-explicit-review',
    selections: Array.from({ length: count }, (_, ordinal) => ({
      recordId: `fictional-record-${ordinal}`,
      candidateId: `fictional-candidate-${ordinal}`,
      candidateVersionId: `fictional-version-${ordinal}`,
      selectionReviewToken: `fictional-selection-${ordinal}`,
      mapping: {},
    })),
  };
}

test('HTTP direct acceptance explains both caps before source lookup or publication', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-acceptance-caps-'));
  const profileId = 'fictional-acceptance-caps';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const authority = memoryRecordAuthority(db);
  const app = createApp({
    root,
    databases: new Map([[profileId, db]]),
    intakeBatchOptions: { authorized: () => false },
  });
  t.after(() => {
    app.close();
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}/api/profiles/${profileId}/intakes/report-acceptance`;
  const changes = () => Number(db.prepare('SELECT total_changes() AS n').get()!.n);
  const before = changes();
  const objects = new Map([...authority.objects].map(([key, value]) => [key, Buffer.from(value)]));

  // These sources deliberately do not exist: oversize requests must report the
  // actionable cap first, without starting a partial operation or creating rows.
  for (const [blocks, message] of [
    [[block(0, 1001)], /at most 1000.*sequential operations/],
    [Array.from({ length: 101 }, (_, index) => block(index, 1)), /1–100.*proposal blocks/],
  ] as const) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ mode: 'partial-v1', operationId: randomUUID(), blocks }),
    });
    const result = await response.json();
    assert.equal(response.status, 400, JSON.stringify(result));
    assert.equal(result.error.code, 'REPORT_ACCEPTANCE_INPUT');
    assert.match(result.error.message, message);
    assert.equal(changes(), before, 'cap refusal must not write any SQLite rows');
    assert.deepEqual(authority.objects, objects, 'cap refusal must not publish durable evidence');
  }
});
