import type { ClinicalPairReference } from './clinical-review.ts';
import {
  parseDecimal,
  multiply,
  divide,
  add,
  subtract,
  compare,
  rational,
  terminatingDecimal,
  displayDecimal,
  type ExactRational,
  type DecimalLiteral,
} from './exact-decimal.ts';
import {
  MEASUREMENT_RULE_VERSION,
  resolveMeasurementUnit,
  measurementConversion,
  type MeasurementDimension,
} from './measurement-units.ts';
import { exactUnitMeasurementValue } from './measurement-value.ts';

export interface MeasurementReference extends ClinicalPairReference {
  profileId: string;
  recordId: string;
}
/** Opaque reviewed semantic identifiers, never inferred from labels or unit dimensions. */
export interface MeasurementSemantics {
  quantity: string;
  dimension: MeasurementDimension;
  region: string;
  specimen: string;
  method: string;
  meaning: string;
}
export interface MeasurementPrecision {
  /** Explicit known nearest-rounding increment in the source unit. Not biological uncertainty. */
  increment: string;
  basis: 'source_statement' | 'explicit_review';
  evidence: string;
}
export interface MeasurementSemanticBinding {
  decisionId: string;
  rulesVersion: typeof MEASUREMENT_RULE_VERSION;
  reference: MeasurementReference;
  subject: string;
  semantics: MeasurementSemantics;
  precision: MeasurementPrecision | null;
}
export interface MeasurementInput {
  reference: MeasurementReference;
  source: {
    valueText: string;
    unit: string | null;
    comparator?: string | null;
    date?: string | null;
  };
  /** Must be resolved from the accepted host journal for this exact reference. */
  binding: MeasurementSemanticBinding | null;
}
export type MeasurementComparator = '=' | '<' | '<=' | '>' | '>=' | '~';
export interface ParsedMeasurement {
  comparator: MeasurementComparator;
  decimal: DecimalLiteral;
  /** The written digits imply a reporting step, not an uncertainty or rounding interval. */
  literalQuantum: ExactRational;
}
export interface DerivedMeasurement {
  rulesVersion: typeof MEASUREMENT_RULE_VERSION;
  reference: MeasurementReference;
  source: MeasurementInput['source'];
  status:
    | 'converted'
    | 'invalid_literal'
    | 'missing_unit'
    | 'ambiguous_unit'
    | 'unsupported_unit'
    | 'incompatible_dimension'
    | 'semantic_review_required'
    | 'stale_semantics'
    | 'invalid_precision';
  parsed: ParsedMeasurement | null;
  semantics: MeasurementSemantics | null;
  decisionId: string | null;
  conversion: {
    from: string;
    to: string;
    usedAlias: boolean;
    factor: ExactRational;
    value: ExactRational;
    exactDecimal: string | null;
    comparator: MeasurementComparator;
    valueRole: 'point' | 'bound' | 'approximation';
    display: ReturnType<typeof displayDecimal>;
    /** Source reported quantum after exact conversion; never used as uncertainty by default. */
    literalQuantum: ExactRational;
    roundingIncrement: ExactRational | null;
  } | null;
}
const comparatorAliases: Record<string, MeasurementComparator> = {
  '=': '=',
  '<': '<',
  '<=': '<=',
  '≤': '<=',
  '>': '>',
  '>=': '>=',
  '≥': '>=',
  '~': '~',
  '≈': '~',
};
export function parseMeasurementLiteral(
  valueText: string,
  comparator?: string | null,
  unit?: string | null,
): ParsedMeasurement | null {
  if (
    typeof valueText !== 'string' ||
    valueText.length > 256 ||
    (comparator != null && typeof comparator !== 'string')
  )
    return null;
  const text = (exactUnitMeasurementValue(valueText, unit)?.numberText || valueText).trim(),
    prefix = /^(<=|>=|<|>|≤|≥|=|~|≈)\s*/.exec(text);
  const inline = prefix ? comparatorAliases[prefix[1]!] : null;
  const explicit =
    comparator == null || !comparator.trim()
      ? null
      : Object.hasOwn(comparatorAliases, comparator.trim())
        ? comparatorAliases[comparator.trim()]
        : undefined;
  if ((comparator?.trim() && !explicit) || (inline && explicit && inline !== explicit)) return null;
  const decimal = parseDecimal(prefix ? text.slice(prefix[0].length) : text);
  return decimal
    ? { comparator: inline || explicit || '=', decimal, literalQuantum: decimal.quantum }
    : null;
}
const referenceFields = [
  'profileId',
  'recordId',
  'kind',
  'sourceRecordId',
  'identity',
  'version',
  'stateHash',
  'evidenceHash',
] as const;
export const sameMeasurementReference = (
  a: MeasurementReference,
  b: MeasurementReference,
): boolean => referenceFields.every((field) => a[field] === b[field]);
const semanticFields = [
  'quantity',
  'dimension',
  'region',
  'specimen',
  'method',
  'meaning',
] as const;
export function validMeasurementSemantics(value: unknown): value is MeasurementSemantics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).length === semanticFields.length &&
    semanticFields.every(
      (field) =>
        typeof item[field] === 'string' &&
        item[field].length <= 200 &&
        !!item[field].trim() &&
        item[field] === item[field].trim() &&
        !['unknown', 'unspecified', '?'].includes(item[field].toLowerCase()),
    ) &&
    ['mass', 'length', 'volume', 'mass_concentration', 'amount_concentration'].includes(
      String(item.dimension),
    )
  );
}
export function validMeasurementPrecision(value: unknown): value is MeasurementPrecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const parsed = typeof item.increment === 'string' ? parseDecimal(item.increment) : null;
  return (
    Object.keys(item).length === 3 &&
    !!parsed &&
    compare(parsed.value, rational(0n)) > 0 &&
    ['source_statement', 'explicit_review'].includes(String(item.basis)) &&
    typeof item.evidence === 'string' &&
    !!item.evidence.trim() &&
    item.evidence.length <= 2000
  );
}
/** A pure rebuildable projection. It writes nothing and carries every input occurrence separately. */
export function deriveMeasurement(
  input: MeasurementInput,
  targetUnit: string,
  decimalPlaces = 12,
): DerivedMeasurement {
  const parsed = parseMeasurementLiteral(
    input.source.valueText,
    input.source.comparator,
    input.source.unit,
  );
  const result: DerivedMeasurement = {
    rulesVersion: MEASUREMENT_RULE_VERSION,
    reference: structuredClone(input.reference),
    source: structuredClone(input.source),
    status: 'invalid_literal',
    parsed,
    semantics: null,
    decisionId: null,
    conversion: null,
  };
  if (!parsed) return result;
  const from = resolveMeasurementUnit(input.source.unit),
    to = resolveMeasurementUnit(targetUnit);
  if (from.status !== 'supported') return { ...result, status: `${from.status}_unit` };
  if (to.status !== 'supported') return { ...result, status: `${to.status}_unit` };
  const factor = measurementConversion(from.unit, to.unit);
  if (!factor) return { ...result, status: 'incompatible_dimension' };
  const binding = input.binding;
  if (!binding || !validMeasurementSemantics(binding.semantics) || !binding.subject?.trim())
    return { ...result, status: 'semantic_review_required' };
  if (
    binding.rulesVersion !== MEASUREMENT_RULE_VERSION ||
    !sameMeasurementReference(input.reference, binding.reference)
  )
    return { ...result, status: 'stale_semantics' };
  if (binding.semantics.dimension !== from.unit.dimension)
    return { ...result, status: 'incompatible_dimension' };
  let roundingIncrement: ExactRational | null = null;
  if (binding.precision) {
    if (!validMeasurementPrecision(binding.precision))
      return { ...result, status: 'invalid_precision' };
    const increment = parseDecimal(binding.precision.increment)!.value;
    // A reported rounded point must lie on the explicitly asserted decimal grid.
    if (divide(parsed.decimal.value, increment).denominator !== '1')
      return { ...result, status: 'invalid_precision' };
    roundingIncrement = multiply(increment, factor);
  }
  const value = multiply(parsed.decimal.value, factor);
  return {
    ...result,
    status: 'converted',
    semantics: structuredClone(binding.semantics),
    decisionId: binding.decisionId,
    conversion: {
      from: from.unit.code,
      to: to.unit.code,
      usedAlias: from.alias || to.alias,
      factor,
      value,
      exactDecimal: terminatingDecimal(value),
      comparator: parsed.comparator,
      valueRole:
        parsed.comparator === '=' ? 'point' : parsed.comparator === '~' ? 'approximation' : 'bound',
      display: displayDecimal(value, decimalPlaces),
      literalQuantum: multiply(parsed.literalQuantum, factor),
      roundingIncrement,
    },
  };
}
export interface MeasurementComparison {
  rulesVersion: typeof MEASUREMENT_RULE_VERSION;
  left: DerivedMeasurement;
  right: DerivedMeasurement;
  status:
    'exact' | 'consistent_with_rounding' | 'different' | 'bounded' | 'approximate' | 'unavailable';
  reason: string;
  delta: ExactRational | null;
  clinicalEquivalence: 'not_determined';
  mergeAuthorized: false;
  warningSuppressionAuthorized: false;
}
export function compareMeasurements(
  left: MeasurementInput,
  right: MeasurementInput,
  targetUnit: string,
  decimalPlaces = 12,
): MeasurementComparison {
  const a = deriveMeasurement(left, targetUnit, decimalPlaces),
    b = deriveMeasurement(right, targetUnit, decimalPlaces);
  const result: MeasurementComparison = {
    rulesVersion: MEASUREMENT_RULE_VERSION,
    left: a,
    right: b,
    status: 'unavailable',
    reason: 'Both measurements need supported units and current reviewed semantics.',
    delta: null,
    clinicalEquivalence: 'not_determined',
    mergeAuthorized: false,
    warningSuppressionAuthorized: false,
  };
  if (a.status !== 'converted' || b.status !== 'converted' || !a.conversion || !b.conversion)
    return result;
  if (
    left.reference.profileId !== right.reference.profileId ||
    left.binding!.subject !== right.binding!.subject
  )
    return {
      ...result,
      reason: 'The measurements do not have the same reviewed profile and subject.',
    };
  if (!semanticFields.every((field) => a.semantics![field] === b.semantics![field]))
    return {
      ...result,
      reason: 'Quantity, region, specimen, method and meaning must all match reviewed semantics.',
    };
  const av = a.conversion,
    bv = b.conversion;
  if (av.comparator === '~' || bv.comparator === '~')
    return {
      ...result,
      status: 'approximate',
      reason: 'An approximate assertion has no specified uncertainty interval.',
    };
  if (av.comparator !== '=' || bv.comparator !== '=')
    return {
      ...result,
      status: 'bounded',
      reason: 'Bounds are retained thresholds; they are not observed point values.',
    };
  const delta = subtract(av.value, bv.value);
  if (compare(av.value, bv.value) === 0)
    return {
      ...result,
      delta,
      status: 'exact',
      reason:
        'The reported numerical values are exactly equal after unit conversion; event identity is not established.',
    };
  const half = rational(1n, 2n);
  const ah = av.roundingIncrement ? multiply(av.roundingIncrement, half) : rational(0n);
  const bh = bv.roundingIncrement ? multiply(bv.roundingIncrement, half) : rational(0n);
  // Strict overlap excludes tie-only contact when the source tie convention is unknown.
  const hasPrecision = !!av.roundingIncrement || !!bv.roundingIncrement;
  const overlap =
    compare(subtract(av.value, ah), add(bv.value, bh)) < 0 &&
    compare(subtract(bv.value, bh), add(av.value, ah)) < 0;
  return hasPrecision && overlap
    ? {
        ...result,
        delta,
        status: 'consistent_with_rounding',
        reason:
          'The reported values are numerically consistent with the explicitly known nearest-rounding increments; this is not biological uncertainty or evidence of one event.',
      }
    : {
        ...result,
        delta,
        status: 'different',
        reason:
          'The converted reported values differ; no clinical conflict or event identity is inferred.',
      };
}
