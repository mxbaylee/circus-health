/** A batch selects an exact active plan; historical expanded plans keep their
 * retained units instead of being substituted with a new package recipe. */
import { HttpError, type Database } from './database.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import { workflowHash } from './intake-workflow.ts';
import { readPackagePlanScope } from './intake-package-plan.ts';
import { prepareRetainedPlanAccess, readRetainedPlanScope } from './intake-retained-plan.ts';
import { openIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import { prepareDirectPlanAccess, readDirectPlanScope } from './intake-direct-plan.ts';

export async function prepareExtractionBatchScope(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  planId: string,
  options: { assertRunning?: () => void } = {},
) {
  await prepareRetainedPlanAccess(db, profileId, id, options);
  await prepareDirectPlanAccess(db, profileId, id, { ...options, planId });
  return readExtractionBatchScope(db, root, profileId, id, planId);
}

export function readExtractionBatchScope(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  planId: string,
) {
  const retained = readRetainedPlanScope(db, profileId, id, { planId, activeOnly: true });
  if (retained) {
    if (!retained.pinsHash || !retained.pinsRecord) throw Error('Retained plan pins are missing');
    const pinsRecord = retained.pinsRecord;
    return {
      format: 'retained' as const,
      planId,
      version: retained.version,
      reader: retained.reader,
      record: retained.record,
      pinsHash: retained.pinsHash,
      unitCount: retained.unitCount,
      pin(name: string): unknown {
        const value = retained.reader.field(pinsRecord, name, { bytes: 8192 });
        if (value.kind === 'missing') return null;
        if (value.kind !== 'value') throw Error('Selected model identity needs bounded fields');
        return value.value;
      },
      unitById: retained.unitById,
      accountedKind: retained.accountedKind,
      decisionIndex: retained.decisionIndex,
      decisionCollection: retained.decisionCollection,
      compatibilityChanges: retained.compatibilityChanges,
    };
  }
  const direct = readDirectPlanScope(db, profileId, id, { planId });
  if (direct) {
    if (direct.plan.status !== 'active')
      throw new HttpError(409, 'PLAN_CHANGED', 'Active extraction plan not found');
    return direct;
  }
  const native = readPackagePlanScope(db, root, profileId, id, { planId });
  if (!native || native.plan.status !== 'active')
    throw new HttpError(409, 'PLAN_CHANGED', 'Active extraction plan not found');
  const source = db
      .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
      .get(id),
    reader = openIntakeCollectionEnvelope(db, source as never),
    intake = reader.child(reader.root(), 'intake'),
    flow = intake && reader.child(intake, 'workflow'),
    record = flow && reader.find('plan', flow, planId);
  if (!record) throw Error('Selected package plan is missing');
  return {
    format: 'native' as const,
    planId,
    version: intakeSourceVersion(db, id).version,
    reader,
    record,
    pinsHash: workflowHash(native.plan.pins),
    unitCount: native.plan.unitCount,
    pin(name: string): unknown {
      return native.plan.pins[name as keyof typeof native.plan.pins];
    },
    unitById(unitId: string) {
      const member = native.inventory.byUnit(unitId),
        unit = member && native.unit(member.memberId);
      return unit && member ? { ...unit, ordinal: member.ordinal, record: undefined } : undefined;
    },
    accountedKind: native.accountedKind,
    decisionIndex: native.decisionIndex,
    decisionCollection: (kind: string) => 'package.' + kind + '.' + workflowHash(planId),
    compatibilityChanges: native.compatibilityChanges,
  };
}
