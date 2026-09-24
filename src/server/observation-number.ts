import { exactUnitMeasurementValue } from '../shared/measurement-value.ts';

export interface ObservationNumberProjection {
  numeric: number | null;
  comparator: string | null;
}

const ungroupedDecimal = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?`;
const groupedDecimal = String.raw`[-+]?\d{1,3}(?:,\d{3})+(?:\.\d*)?`;
const observationNumber = new RegExp(
  String.raw`^\s*([<>]=?|=|~)?\s*(${ungroupedDecimal}|${groupedDecimal})\s*$`,
  'i',
);

/**
 * Builds the lossy SQLite query projection without changing the retained literal.
 * Grouping is limited to ordinary fixed decimals with three digits after every comma.
 */
export function projectObservationNumber(
  valueText: string,
  unit?: string | null,
): ObservationNumberProjection | null {
  if (typeof valueText !== 'string' || valueText.length > 256) return null;
  const match = observationNumber.exec(
    exactUnitMeasurementValue(valueText, unit)?.numberText || valueText,
  );
  if (!match) return null;
  const numeric = Number(match[2]!.replaceAll(',', ''));
  return {
    numeric: Number.isFinite(numeric) ? numeric : null,
    comparator: match[1] || null,
  };
}
