import type { IntakeExtractionPlan, IntakeExtractionUnit } from '../shared/intake.ts';

/** A retained, explicitly scoped disposition. It never certifies clinical completeness. */
export function accountedUnitKind(
  plan: IntakeExtractionPlan,
  unit: IntakeExtractionUnit,
): 'extracted' | 'context' | 'unreadable' | null {
  const coverage = unit.coverage;
  if (!coverage || coverage.unitId !== unit.id || coverage.kind === 'inspected') return null;
  if (!['extracted', 'context', 'unreadable'].includes(coverage.kind)) return null;
  const receipt = plan.batches.findLast(
    (batch) =>
      unit.attempts.includes(batch.id) &&
      batch.coverage.some(
        (item) =>
          item.unitId === unit.id && item.kind === coverage.kind && item.notes === coverage.notes,
      ),
  );
  return receipt ? coverage.kind : null;
}
