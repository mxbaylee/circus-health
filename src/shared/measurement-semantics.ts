import type {
  MeasurementInput,
  MeasurementPrecision,
  MeasurementReference,
  MeasurementSemanticBinding,
  MeasurementSemantics,
} from './measurement.ts';
import type { MEASUREMENT_RULE_VERSION } from './measurement-units.ts';
export interface MeasurementSemanticRequest {
  kind: 'observation' | 'procedure';
  recordId: string;
  /** null is an explicit revocation, never a fallback to an older mapping. */
  semantics: MeasurementSemantics | null;
  precision: MeasurementPrecision | null;
  reason: string;
}
export interface MeasurementSemanticPreview {
  request: MeasurementSemanticRequest;
  reference: MeasurementReference;
  source: MeasurementInput['source'];
  subject: string;
  evidence: { sourceRecordId?: string; contentUrl: string; label: string; locator: string }[];
  rulesVersion: typeof MEASUREMENT_RULE_VERSION;
  previousDecisionId: string | null;
  version: number;
  previewToken: string;
}
export interface MeasurementSemanticApplyRequest extends MeasurementSemanticRequest {
  reference: MeasurementReference;
  rulesVersion: typeof MEASUREMENT_RULE_VERSION;
  version: number;
  previewToken: string;
  operationId: string;
}
export interface MeasurementSemanticDecision {
  id: string;
  operationId: string;
  reference: MeasurementReference;
  source: MeasurementInput['source'];
  subject: string;
  rulesVersion: typeof MEASUREMENT_RULE_VERSION;
  semantics: MeasurementSemantics | null;
  precision: MeasurementPrecision | null;
  reason: string;
  previousDecisionId: string | null;
  at: string;
  sequence: number;
}
export interface MeasurementSemanticApplyResult {
  replayed: boolean;
  decision: MeasurementSemanticDecision;
  durability?: { pending: boolean; error: string };
}
export interface AcceptedMeasurement extends MeasurementInput {
  semanticStatus: 'none' | 'current' | 'stale' | 'revoked';
  binding: MeasurementSemanticBinding | null;
  lastDecision: MeasurementSemanticDecision | null;
}
