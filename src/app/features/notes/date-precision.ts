export type DatePrecision = 'unknown' | 'year' | 'month' | 'day';

export function datePrecision(value: string): DatePrecision {
  if (!value) return 'unknown';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'day';
  if (/^\d{4}-\d{2}$/.test(value)) return 'month';
  return 'year';
}

/** Choosing greater precision never fills in missing date components. */
export function dateAtPrecision(value: string, precision: DatePrecision): string {
  if (precision === 'unknown') return '';
  if (precision === 'year' && /^\d{4}/.test(value)) return value.slice(0, 4);
  if (precision === 'month' && /^\d{4}-\d{2}/.test(value)) return value.slice(0, 7);
  return value;
}

/** Native controls receive only a value valid for their displayed precision. */
export function pickerValue(value: string, precision: DatePrecision): string {
  if (precision === 'unknown') return '';
  if (precision === 'day') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
  if (precision === 'month') return /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : '';
  return value;
}

/** A remembered value can supply detail only for this unchanged date prefix. */
export function compatibleDateDetail(remembered: string, value: string): string {
  return value && (remembered === value || remembered.startsWith(`${value}-`)) ? remembered : '';
}

/** Keep detail removed by this editing session, never infer new date parts. */
export function changeDatePrecision(
  value: string,
  precision: DatePrecision,
  remembered = '',
): { value: string; remembered: string } {
  // Unknown intentionally clears the date and any local remembered detail.
  if (precision === 'unknown') return { value: '', remembered: '' };
  const compatible = compatibleDateDetail(remembered, value);
  const detail = compatible.length > value.length ? compatible : value;
  const next = dateAtPrecision(detail, precision);
  return { value: next, remembered: detail.length > next.length ? detail : '' };
}
