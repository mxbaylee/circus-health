/** Preserve the precision printed in a clinical source; null means malformed. */
export function clinicalDatePrecision(
  date: string,
): 'unknown' | 'year' | 'month' | 'day' | 'datetime' | null {
  if (!date) return 'unknown';
  if (/^\d{4}$/.test(date)) return 'year';
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(date)) return 'month';
  if (/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(date) && Number.isFinite(Date.parse(date))) {
    const day = date.slice(0, 10);
    if (new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day)
      return date.includes('T') ? 'datetime' : 'day';
  }
  return null;
}
