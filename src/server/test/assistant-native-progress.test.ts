import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, createIntakePlan, workflowMutation } from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { createPagedDirectPlan, readDirectPlanScope } from '../intake-direct-plan.ts';
import { createPagedPackagePlan, readPackagePlanScope } from '../intake-package-plan.ts';
import { prepareCollectionWorkflowReadiness } from '../intake-workflow-readiness.ts';
import { prepareRetainedPlanAccess } from '../intake-retained-plan.ts';
import { setCollectionProcessingException } from '../intake-processing-exceptions.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { activeMappingRules } from '../clinical-import.ts';
import { workflowHash } from '../intake-workflow.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { readNativeAssistantSourceHeader } from '../assistant-intake-header.ts';
import {
  nativeAssistantConversion,
  nativeAssistantScope,
  nativeAssistantResume,
  nativeAssistantUnit,
  nativeAssistantReadingProgress,
} from '../assistant-intake-native.ts';
import { createCollectionCheckpoint } from '../intake-continuation-collection.ts';

for (const kind of ['retained', 'direct', 'package'] as const)
  test(`native ${kind} progress preserves manual resume and first-pending labels with fewer selected reads`, async (t) => {
    fictionalModel(t);
    const root = mkdtempSync(join(tmpdir(), 'fictional-progress-selection-')),
      profileId = 'fictional-progress',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    t.after(() => {
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const source = uploadIntake(db, root, profileId, {
      filename: kind === 'package' ? 'fictional.zip' : 'fictional.txt',
      bytes:
        kind === 'package'
          ? zipFixture([
              { name: 'first.txt', data: 'Independently fictional first source.' },
              { name: 'second.txt', data: 'Independently fictional second source.' },
            ])
          : Buffer.from('Independently fictional progress source. '.repeat(400)),
    });
    let unitIds: string[];
    if (kind === 'retained') {
      const planned = await createIntakePlan(db, root, profileId, source.id, {
        version: source.version,
      });
      const plan = planned.workflow!.plans[0]!;
      unitIds = plan.units.map((unit) => unit.id);
      workflowMutation(
        db,
        root,
        profileId,
        source.id,
        { version: planned.version, operationId: 'fictional-long-locator' },
        (workflow) => {
          workflow.plans[0]!.units[1]!.locator = 'Fictional long locator '.repeat(150);
        },
      );
      await buildIntakeCollectionEnvelope(db, { id: source.id });
    } else {
      await buildIntakeCollectionEnvelope(db, { id: source.id });
      if (kind === 'direct') {
        await createPagedDirectPlan(db, root, profileId, source.id, {
          version: source.version,
          operationId: 'fictional-direct',
        });
        const plan = readDirectPlanScope(db, profileId, source.id)!;
        unitIds = Array.from({ length: plan.unitCount }, (_, ordinal) => plan.unitAt(ordinal)!.id);
      } else {
        await createPagedPackagePlan(db, root, profileId, source.id, {
          version: source.version,
          operationId: 'fictional-package',
        });
        const plan = readPackagePlanScope(db, root, profileId, source.id)!;
        unitIds = Array.from(plan.inventory.range({ offset: 0, limit: 2 })).map(
          (member) => plan.unit(member.memberId)!.id,
        );
      }
    }
    assert.equal(unitIds.length, 2);
    const mappingVersion = workflowHash(activeMappingRules(db, source.providerId));
    await prepareRetainedPlanAccess(db, profileId, source.id);
    await prepareCollectionWorkflowReadiness(db, root, profileId, source.id, { mappingVersion });
    const compare = (resumeUnitId: string) => {
      const header = readNativeAssistantSourceHeader(db, root, profileId, source.id)!;
      const host = nativeAssistantConversion(db, root, profileId, 'fictional-session', header),
        selected = nativeAssistantScope(host, resumeUnitId);
      assert.ok(selected);
      const checkpoint = createCollectionCheckpoint(selected);
      const before = intakeWorkCounters(db).warm;
      const oldResume = nativeAssistantResume(host, checkpoint, mappingVersion),
        oldUnit = nativeAssistantUnit(host),
        oldWorkUnit = oldUnit
          ? { id: oldUnit.id, locator: oldUnit.locator?.slice(0, 2000) || oldUnit.id }
          : null;
      const afterOld = intakeWorkCounters(db).warm;
      const actual = nativeAssistantReadingProgress(host, checkpoint, mappingVersion);
      const after = intakeWorkCounters(db).warm;
      assert.deepEqual(actual.resume, oldResume);
      assert.equal(actual.resume.unit.id, resumeUnitId);
      assert.deepEqual(actual.reading.workUnit, oldWorkUnit);
      const previousReads = afterOld.collectionNodeReads - before.collectionNodeReads,
        selectedReads = after.collectionNodeReads - afterOld.collectionNodeReads;
      if (oldWorkUnit)
        assert.ok(selectedReads < previousReads, 'reuse removes repeated unit/history resolution');
      for (const counter of [
        'sourceDTOHydrations',
        'envelopeHydrations',
        'materializationReads',
      ] as const)
        assert.equal(after[counter], before[counter]);
      t.diagnostic(
        JSON.stringify({ kind, workUnit: oldWorkUnit?.id, previousReads, selectedReads }),
      );
      return actual;
    };
    assert.equal(compare(unitIds[0]!).reading.workUnit?.id, unitIds[0]);
    assert.equal(compare(unitIds[1]!).reading.workUnit?.id, unitIds[0]);
    await setCollectionProcessingException(db, root, profileId, source.id, {
      version: intakeSourceVersion(db, source.id).version,
      operationId: 'fictional-skip-first',
      unitId: unitIds[0]!,
      exception: { reason: 'processing_stalled', at: '2026-10-04T00:00:00Z' },
    });
    const advanced = compare(unitIds[0]!);
    assert.equal(advanced.reading.workUnit?.id, unitIds[1]);
    if (kind === 'retained') assert.equal(advanced.reading.workUnit?.locator, unitIds[1]);
    await setCollectionProcessingException(db, root, profileId, source.id, {
      version: intakeSourceVersion(db, source.id).version,
      operationId: 'fictional-skip-second',
      unitId: unitIds[1]!,
      exception: { reason: 'processing_stalled', at: '2026-10-04T00:00:00Z' },
    });
    assert.equal(compare(unitIds[0]!).reading.workUnit, null);
  });
