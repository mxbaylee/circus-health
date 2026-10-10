import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, createIntakePlan, workflowMutation } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareLegacyCheckpointTargets } from '../intake-legacy-checkpoint-targets.ts';
import { readRetainedPlanScope } from '../intake-retained-plan.ts';
import {
  assertConversionCoverage,
  conversionReadDescriptor,
  conversionScopeKey,
  conversionWindowKey,
  type ConversionCheckpoint,
} from '../intake-continuation.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { fictionalModel } from './fictional-model.ts';
import type { IntakeExtractionUnit } from '../../shared/intake.ts';

test('legacy target index agrees with actual old coverage predicates and first duplicate precedence', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-legacy-targets-')),
    profile = 'fictional',
    db = openDatabase(ensureProfileDirectories(root, profile).database, profile);
  attachPersonalDurability(db, { root, profileId: profile });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profile, {
      filename: 'fictional.zip',
      bytes: zipFixture([
        { name: 'one.txt', data: 'Fictional one' },
        { name: 'two.txt', data: 'Fictional two' },
      ]),
    }),
    planned = await createIntakePlan(db, root, profile, source.id, { version: source.version });
  const selected = workflowMutation(
    db,
    root,
    profile,
    source.id,
    { version: planned.version, operationId: 'fixture-units' },
    (workflow) => {
      const plan = workflow.plans[0]!,
        member = plan.units[0]!;
      const unit = (
        id: string,
        kind: IntakeExtractionUnit['kind'],
        extra: Partial<IntakeExtractionUnit> = {},
      ): IntakeExtractionUnit => ({
        id,
        kind,
        locator: 'Fictional',
        status: 'pending',
        attempts: [],
        ...extra,
      });
      plan.units = [
        unit('text-a', 'text', { start: 0, end: 20 }),
        unit('text-b', 'html', { start: 10, end: 100 }),
        unit('pdf', 'pdf', { pages: [2, 1, 2] }),
        unit('image', 'image'),
        member,
        unit('text-a', 'text', { end: 999 }),
      ];
      workflow.plans.push({
        ...structuredClone(plan),
        units: [unit('ignored-duplicate-plan', 'text')],
      });
      workflow.plans.push({
        ...structuredClone(plan),
        id: 'other-active',
        units: [unit('other-text', 'text', { end: 50 })],
      });
    },
  );
  const checkpoint: ConversionCheckpoint = {
    intakeId: source.id,
    profileId: profile,
    sourceHash: source.sha256,
    version: selected.version,
    seen: [],
    pending: [],
    readScopes: [
      conversionScopeKey([source.id, null, null]),
      conversionScopeKey([source.id, null, 1]),
      conversionScopeKey([source.id, null, 2]),
      conversionScopeKey([source.id, selected.workflow!.plans[0]!.units[4]!.memberId, null]),
    ],
    jsonRoots: [],
    completedUnits: [],
    lastWindow: null,
    turns: 0,
  };
  const windows = [
    conversionReadDescriptor('health_intake_read', { id: source.id, offset: 0 }),
    conversionReadDescriptor('health_intake_read', { id: source.id, offset: 25 }),
    conversionReadDescriptor('health_intake_read', { id: source.id, page: 1 }),
    conversionReadDescriptor('health_intake_read', { id: source.id, page: 2 }),
    conversionReadDescriptor('health_intake_plan', {
      id: source.id,
      action: 'read_unit',
      unitId: 'text-a',
    }),
    conversionReadDescriptor('health_intake_package', {
      id: source.id,
      action: 'read_member',
      memberId: selected.workflow!.plans[0]!.units[4]!.memberId,
    }),
    conversionReadDescriptor('health_intake_read', { id: 'unmatched' }),
  ];
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  for (const consumed of [false, true]) {
    checkpoint.seen = consumed ? [conversionWindowKey(windows[4]!)] : [];
    const index = await prepareLegacyCheckpointTargets(db, root, profile, source.id, checkpoint);
    try {
      const plan = readRetainedPlanScope(db, profile, source.id);
      assert.equal(
        plan?.unitByMemberId(selected.workflow!.plans[0]!.units[4]!.memberId!)?.id,
        selected.workflow!.plans[0]!.units[4]!.id,
      );
      assert.equal(plan?.unitByMemberId('fictional-missing-member'), undefined);
      const units = [...index.units()];
      assert.equal(units.length, 6);
      assert.equal(
        units.some((x) => x.unitId === 'ignored-duplicate-plan'),
        false,
      );
      assert.deepEqual(
        [...index.pages()]
          .filter((x) => units.find((u) => u.unitKey === x.unitKey)?.unitId === 'pdf')
          .map((x) => x.page),
        [2, 1],
      );
      for (const window of windows) {
        const actual = new Map([...index.targets(window)].map((x) => [x.unitKey, x.textReadUnit]));
        checkpoint.pending = [window];
        for (const unit of units) {
          let blocked = false;
          try {
            assertConversionCoverage(
              checkpoint,
              { ...selected, workflow: selected.workflow! },
              {
                planId: unit.planId,
                coverage: [{ unitId: unit.unitId, kind: 'extracted', notes: 'Fictional' }],
              },
            );
          } catch {
            blocked = true;
          }
          assert.equal(
            actual.has(unit.unitKey),
            blocked,
            JSON.stringify({ window, unit, consumed }),
          );
          if (actual.get(unit.unitKey))
            assert.ok(['text-a', 'text-b', 'other-text'].includes(unit.unitId));
        }
      }
      assert.equal([...index.targets(windows[6]!)].length, 0);
    } finally {
      index.dispose();
    }
    assert.throws(() => [...index.units()], /closed/);
  }
});
