const ungroupedDecimal = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?`;
const groupedDecimal = String.raw`[-+]?\d{1,3}(?:,\d{3})+(?:\.\d*)?`;
const measurementNumber = new RegExp(
  String.raw`^\s*(?:<=|>=|<|>|≤|≥|=|~|≈)?\s*(?:${ungroupedDecimal}|${groupedDecimal})\s*$`,
  'i',
);

export interface ExactUnitMeasurementValue {
  numberText: string;
  unitInline: boolean;
}

const numericLiteral = (value: string) => measurementNumber.test(value);

/** The source already visibly ends in this exact structured unit token. */
export function exactMeasurementUnitSuffix(valueText: string, unit?: string | null): string | null {
  if (
    typeof valueText !== 'string' ||
    typeof unit !== 'string' ||
    !unit ||
    unit.length > 256 ||
    unit !== unit.trim() ||
    /^e(?:[-+]?\d*)?$/i.test(unit) ||
    numericLiteral(valueText)
  )
    return null;
  const retained = valueText.trimEnd();
  if (!retained.endsWith(unit)) return null;
  const beforeUnit = retained.slice(0, -unit.length);
  if (!beforeUnit || (!/\s$/u.test(beforeUnit) && !/[\d.)\]]$/u.test(beforeUnit))) return null;
  return beforeUnit.trimEnd();
}

/**
 * Separates an exact structured unit only when the retained literal ends with that
 * same unit and the remaining token is a strict number/comparator. The exact
 * structured unit corroborates either spaced or attached source notation. Neither
 * input is normalized, and exponent syntax is never reinterpreted as a unit.
 */
export function exactUnitMeasurementValue(
  valueText: string,
  unit?: string | null,
): ExactUnitMeasurementValue | null {
  if (typeof valueText !== 'string' || valueText.length > 256) return null;
  if (numericLiteral(valueText)) return { numberText: valueText, unitInline: false };
  const numberText = exactMeasurementUnitSuffix(valueText, unit);
  return numberText && numericLiteral(numberText) ? { numberText, unitInline: true } : null;
}

export function measurementValueDisplay(
  valueText: string,
  unit?: string | null,
): { valueText: string; appendedUnit: string | null } {
  return {
    valueText,
    appendedUnit: exactMeasurementUnitSuffix(valueText, unit) !== null ? null : unit || null,
  };
}

export function formatMeasurementValue(valueText: string, unit?: string | null): string {
  const display = measurementValueDisplay(valueText, unit);
  return display.valueText + (display.appendedUnit ? ` ${display.appendedUnit}` : '');
}
