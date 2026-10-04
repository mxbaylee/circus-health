import assert from 'node:assert/strict';
import { openDatabase } from '../../database.ts';
import { getIntakeRead } from '../../intake.ts';
import { isIntakeSummary } from '../../../shared/intake-summary.ts';
import { readDirectPlanScope } from '../../intake-direct-plan.ts';
import { readPackagePlanScope } from '../../intake-package-plan.ts';
/** Complete bounded fictional plan selection; never a fabricated Intake DTO. */
export function selectedFixturePlan(
  db: ReturnType<typeof openDatabase>,
  root: string,
  profileId: string,
  id: string,
) {
  const header = getIntakeRead(db, root, profileId, id);
  assert.ok(isIntakeSummary(header), 'automatic dispatch uses native selected authority');
  if (header.activePlan.plan?.format === 'health-intake-package-plan-v2') {
    const scope = readPackagePlanScope(db, root, profileId, id)!;
    assert.ok(scope.plan.unitCount <= 100, 'bounded fictional package');
    return {
      id: scope.planId,
      units: Array.from(scope.inventory.range({ offset: 0, limit: 100 })).map((member) =>
        scope.unit(member.memberId)!,
      ),
    };
  }
  const scope = readDirectPlanScope(db, profileId, id)!;
  assert.ok(scope.unitCount <= 100, 'bounded fictional direct plan');
  return {
    id: scope.planId,
    units: Array.from({ length: scope.unitCount }, (_, i) => scope.unitAt(i)!),
  };
}
