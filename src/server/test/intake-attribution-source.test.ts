import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  memoryRecordAuthority,
  writeIntakeFixtureEnvelope,
} from './helpers/intake-authority-fixture.ts';
import {
  uploadIntake,
  createIntakePlan,
  submitIntakeBatch,
  getIntake,
  getIntakeRead,
} from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareRetainedPlanAccess } from '../intake-retained-plan.ts';
import {
  exportImportAttribution,
  type AttributionDiagnosticSource,
} from '../intake-attribution.ts';
import { prepareIntakeAttributionSources } from '../intake-attribution-source.ts';
import { createPagedPackagePlan } from '../intake-package-plan.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

function fixture(t: TestContext) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-attribution-source-')),
    profileId = 'fictional-attribution';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db };
}
const salt = new Uint8Array([1, 2, 3]);
for (const oversized of [false, true])
  test(`native attribution preserves legacy unit/batch yield oracle${oversized ? ' with explicit oversized-history omissions' : ''}`, async (t) => {
    const { db, root, profileId } = fixture(t);
    const intake = uploadIntake(db, root, profileId, {
      filename: 'fictional-attribution.txt',
      bytes: Buffer.from('Fictional content. '.repeat(1200)),
      newProviderName: 'Fictional clinic',
    });
    const planned = await createIntakePlan(db, root, profileId, intake.id, {
        version: intake.version,
        operationId: 'fictional-plan',
      }),
      plan = planned.workflow!.plans[0];
    submitIntakeBatch(db, root, profileId, intake.id, {
      version: planned.version,
      planId: plan.id,
      operationId: 'fictional-attribution-batch',
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-row',
        kind: 'record',
        payload: { literal: 'Private fictional medical canary' },
        provenance: {
          capturedVia: null,
          sourceSystem: null,
          sourceRecordId: null,
          evidenceClass: 'transcription',
          locator: 'fictional locator',
        },
        coverage: { status: 'partial', notes: [] },
        clinical: {
          kind: 'observation',
          subject: 'self',
          testLabel: 'Fictional example',
          valueText: '12.25',
          unit: 'units',
          date: '2026-08-02',
        },
      }),
      summary: 'Fictional diagnostic fixture',
      coverage: [
        { unitId: plan.units[0].id, kind: 'extracted', notes: 'Fictional extracted source' },
      ],
    });
    if (oversized) {
      const raw = JSON.parse(readIntakeEnvelopeText(db, { id: intake.id }));
      raw.intake.workflow.candidates[0].versions[0].occurrences[0].locator =
        'Private fictional medical canary'.repeat(1000);
      writeIntakeFixtureEnvelope(db, intake.id, raw);
    }
    const expected = exportImportAttribution({
      intakes: [getIntake(db, root, profileId, intake.id)],
      chats: [],
      salt,
    });
    await buildIntakeCollectionEnvelope(db, { id: intake.id });
    await prepareRetainedPlanAccess(db, profileId, intake.id);
    const before = { ...intakeWorkCounters(db).warm };
    const result = exportImportAttribution({
      intakes: prepareIntakeAttributionSources(db, root, profileId, [
        getIntakeRead(db, root, profileId, intake.id),
      ]),
      chats: [],
      salt,
    });
    if (!oversized) assert.deepEqual(result, expected);
    else {
      assert.equal(result.exportBounds.partial, true);
      assert.equal(result.imports[0].truncated, true);
      assert.ok(result.exportBounds.omittedMetadataItems > 0);
      assert.ok(result.imports[0].pages.every((page) => page.yieldPageUnknown));
    }
    assert.doesNotMatch(
      JSON.stringify(result),
      /Private fictional medical canary|fictional locator|fictional-attribution/,
    );
    assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.envelopeHydrations);
    assert.equal(intakeWorkCounters(db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
  });

test('native implicit package units produce observed pending coverage without full workflow materialization', async (t) => {
  const { db, root, profileId } = fixture(t);
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.zip',
    newProviderName: 'Fictional clinic',
    bytes: zipFixture(
      Array.from({ length: 80 }, (_, i) => ({
        name: `fictional-${i}.txt`,
        data: 'Private fictional package canary',
      })),
    ),
  });
  await createPagedPackagePlan(db, root, profileId, intake.id, {
    version: intake.version,
    operationId: 'fictional-native-package',
  });
  const before = { ...intakeWorkCounters(db).warm };
  const report = exportImportAttribution({
    intakes: prepareIntakeAttributionSources(db, root, profileId, [
      getIntakeRead(db, root, profileId, intake.id),
    ]),
    chats: [],
    salt,
  });
  assert.equal(report.imports[0].truncated, false);
  assert.equal(report.imports[0].pages.length, 80);
  assert.equal(
    report.imports[0].pages.reduce((sum, page) => sum + page.activeUnits, 0),
    80,
  );
  assert.ok(report.imports[0].pages.every((page) => page.activeCoverage.pending === 1));
  assert.doesNotMatch(JSON.stringify(report), /Private fictional package canary|fictional-/);
  assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
  const { createApp } = await import('../index.ts');
  const app = createApp({
    root,
    databases: new Map([[profileId, db]]),
    intakeBatchOptions: { authorized: () => false },
  });
  try {
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/profiles/${profileId}/import-diagnostics`,
    );
    assert.equal(response.status, 200);
    const exported = await response.json();
    assert.equal(exported.data.attribution.unavailable, undefined);
    assert.equal(exported.data.attribution.imports[0].pages.length, 80);
    assert.equal(exported.data.attribution.imports[0].truncated, false);
    assert.equal(intakeWorkCounters(db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
  } finally {
    app.close();
  }
});

test('diagnostic lazy metadata never traverses beyond the shared work budget', () => {
  let visited = 0;
  const source: AttributionDiagnosticSource = {
    format: 'health-intake-attribution-source-v1',
    id: 'fictional',
    sha256: 'hash',
    parentSourceFileId: null,
    history: [],
    decisions: [],
    reportAcceptances: [],
    plans: [],
    candidates: [],
    proposals: {
      length: 1_000_000,
      *[Symbol.iterator]() {
        for (let i = 0; i < 1_000_000; i++) {
          visited++;
          yield { id: `p-${i}` };
        }
      },
    },
  };
  const report = exportImportAttribution({ intakes: [source], chats: [], salt });
  assert.ok(visited <= 50_000);
  assert.equal(report.exportBounds.metadataWork, 50_000);
  assert.ok(report.exportBounds.omittedMetadataItems > 900_000);
  assert.equal(report.imports[0].truncated, true);
});
