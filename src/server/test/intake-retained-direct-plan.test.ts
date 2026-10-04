import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake } from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { createPagedDirectPlan, readDirectPlanScope } from '../intake-direct-plan.ts';
import {
  prepareRetainedPlanAccess,
  readRetainedIntakeUnitScope,
  readRetainedPlanScope,
  readRetainedPlanEvidence,
} from '../intake-retained-plan.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { clearPackageSourceSession } from '../intake-package-session.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

test('retained registry preserves direct recipe history and active-first unit precedence', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-retained-direct-')),
    profileId = 'fictional-direct-registry',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearPackageSourceSession(db);
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.html',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(
      '<table>' +
        Array.from({ length: 7 }, (_, n) => `<tr><td>Fictional ${n}</td></tr>`).join('') +
        '</table>',
    ),
  });
  await buildIntakeCollectionEnvelope(db, { id: intake.id, sha256: intake.sha256 });
  const first = await createPagedDirectPlan(db, root, profileId, intake.id, {
    version: intake.version,
    operationId: 'first',
    unitSize: 2,
  });
  assert.ok('plan' in first);
  const oldUnit = readDirectPlanScope(db, profileId, intake.id)!.unitAt(0)!;
  const second = await createPagedDirectPlan(db, root, profileId, intake.id, {
    version: first.version,
    operationId: 'second',
    unitSize: 3,
    replacePlanId: first.plan.id,
  });
  assert.ok('plan' in second);
  const newUnit = readDirectPlanScope(db, profileId, intake.id)!.unitAt(0)!;
  assert.notEqual(oldUnit.id, newUnit.id);
  await prepareRetainedPlanAccess(db, profileId, intake.id);
  assert.equal(readRetainedPlanScope(db, profileId, intake.id), undefined);
  assert.equal(
    readRetainedPlanScope(db, profileId, intake.id, { planId: first.plan.id }),
    undefined,
  );
  assert.equal(readRetainedPlanEvidence(db, profileId, intake.id).packageEvidence, false);
  const work = intakeWorkCounters(db).reconstruction.retainedPlanUnits;
  clearIntakeStateCache(db);
  for (const [unit, planId] of [
    [oldUnit, first.plan.id],
    [newUnit, second.plan.id],
  ] as const) {
    const selected = readRetainedIntakeUnitScope(db, root, profileId, intake.id, unit.id);
    assert.equal(selected.format, 'direct');
    assert.equal(selected.scope.planId, planId);
    assert.equal(selected.unit.id, unit.id);
  }
  await prepareRetainedPlanAccess(db, profileId, intake.id);
  assert.equal(
    intakeWorkCounters(db).reconstruction.retainedPlanUnits,
    work,
    'warm and reopened lookups do not scan recipe units',
  );
});
