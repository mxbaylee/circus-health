import type { IntakeExtractionPlan } from './intake.ts';

/** Direct originals share one immutable source index. Pending units are recipes. */
export interface IntakeDirectPlanV2 {
  format: 'health-intake-direct-plan-v2';
  id: string;
  createdAt: string;
  status: 'active' | 'superseded';
  pins: IntakeExtractionPlan['pins'] & { connectionIdentity?: string };
  sourceIndex: { id: string; kind: 'pdf' | 'image' | 'html' | 'text'; sourceHash: string };
  unitRecipe: 'health-intake-direct-unit-v1';
  unitSize: number;
  overlap: number;
  unitCount: number;
}

export interface IntakeDirectUnitReference {
  format: 'health-intake-direct-unit-reference-v1';
  intakeId: string;
  planId: string;
  sourceIndexId: string;
  ordinal: number;
  version: number;
}
