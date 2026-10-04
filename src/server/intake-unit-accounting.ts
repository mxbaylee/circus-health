import type { IntakeExtractionPlan, IntakeExtractionUnit } from '../shared/intake.ts';

/** A retained, explicitly scoped disposition. It never certifies clinical completeness. */
export function accountedUnitKind(
  plan: IntakeExtractionPlan,
  unit: IntakeExtractionUnit,
): 'extracted' | 'context' | 'unreadable' | null {
  return accountedUnitKindInScope(unit, (coverage) =>
    plan.batches.some(
      (batch) =>
        unit.attempts.includes(batch.id) &&
        batch.coverage.some(
          (item) =>
            item.unitId === unit.id && item.kind === coverage.kind && item.notes === coverage.notes,
        ),
    ),
  );
}

/** The lookup checks the complete selected attempt/batch scope for this exact unit. */
export function accountedUnitKindInScope(
  unit: Pick<IntakeExtractionUnit, 'id' | 'coverage'>,
  hasAttemptReceipt: (coverage: NonNullable<IntakeExtractionUnit['coverage']>) => boolean,
): 'extracted' | 'context' | 'unreadable' | null {
  const coverage = unit.coverage;
  if (!coverage || coverage.unitId !== unit.id || coverage.kind === 'inspected') return null;
  if (!['extracted', 'context', 'unreadable'].includes(coverage.kind)) return null;
  return hasAttemptReceipt(coverage) ? coverage.kind : null;
}

/** Both the coordinator's stall streak and the assistant's context use this unit. */
export function nextPendingReadingUnit(
  plan: IntakeExtractionPlan,
): IntakeExtractionUnit | undefined {
  return plan.units.find((unit) => !accountedUnitKind(plan, unit) && !unit.processingException);
}
