import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake } from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { createPagedPackagePlan, readPackageUnitMetadataFragment } from '../intake-package-plan.ts';
import { openImplicitPackageModelUnits } from '../intake-model-package-units.ts';
import { openCollectionModelIntakeBackend } from '../intake-model-collection-backend.ts';
import { modelIntakeContextV2, modelIntakeEvidenceContextV2 } from '../intake-model-context-v4.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { clearPackageSourceSession } from '../intake-package-session.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import type { IntakePackageUnitReference } from '../../shared/intake-package-plan.ts';

test('virtual model units derive bounded ordinal pages and exact inventory totals without a per-unit section index', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-model-units-')),
    profileId = 'fictional';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearPackageSourceSession(db);
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.zip',
    newProviderName: 'Fictional clinic',
    bytes: zipFixture(
      Array.from({ length: 9 }, (_, i) => ({ name: 'fictional-' + i + '.txt', data: 'fictional' })),
    ),
  });
  const result = await createPagedPackagePlan(db, root, profileId, intake.id, {
    version: intake.version,
    operationId: 'model-unit-plan',
  });
  const source = db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(intake.id) as { id: string; kind: string; sha256: string; details_json: string };
  const units = openImplicitPackageModelUnits(db, root, profileId, intake.id)!;
  const backend = openCollectionModelIntakeBackend(db, source, {
    mappingVersion: result.plan.pins.mappingVersion,
    sectionProvider: units.sectionProvider,
  });
  const before = intakeWorkCounters(db).warm.materializationReads;
  const first = modelIntakeContextV2(backend, {
    format: 'health-intake-model-context-request-v2',
    section: 'units',
    freshStart: true,
  }) as Record<string, unknown>;
  assert.equal(first.logicalTotal, 9);
  assert.equal(first.complete, false);
  const values = (first.items as { value: IntakePackageUnitReference }[]).map((item) => item.value);
  assert.equal(values.length, 8);
  assert.ok(values.every((unit) => unit.format === 'health-intake-package-unit-reference-v1'));
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 40000);
  const { collections } = selectedEnvelopeStore(db, source),
    operationId = randomUUID();
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: result.version,
      changes: [
        {
          area: 'builds',
          collection: 'fictional.progress',
          op: 'put',
          key: operationId,
          value: 'checkpoint',
        },
      ],
    }),
  );
  const second = modelIntakeContextV2(backend, {
    format: 'health-intake-model-context-request-v2',
    section: 'units',
    cursor: first.nextCursor as string,
    version: result.version,
    mappingVersion: result.plan.pins.mappingVersion,
  }) as Record<string, unknown>;
  assert.equal((second.items as unknown[]).length, 1);
  assert.equal(second.complete, true);
  assert.equal(intakeWorkCounters(db).warm.materializationReads, before);
  const metadata = readPackageUnitMetadataFragment(
    db,
    root,
    profileId,
    intake.id,
    values[0]!.metadata,
  );
  assert.equal(metadata.complete, true);
  assert.equal(JSON.parse(metadata.text).id, values[0]!.id);
  assert.equal(units.currentUnits().total, 9);
  assert.deepEqual(units.currentUnits(1), { state: 'exact', total: 0, items: [] });
  assert.ok(
    Buffer.byteLength(
      JSON.stringify(modelIntakeEvidenceContextV2(backend, units.currentUnits())),
    ) <=
      16 * 1024,
  );
  assert.equal(units.sectionProvider('batches'), undefined);
});
