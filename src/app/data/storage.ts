/** Decimal stored-file units, shared by picker, breakdown and import guidance. */
export function formatStorageBytes(value?: number | null): string {
  if (value == null || !Number.isFinite(value) || value < 0) return 'Unknown';
  if (value === 0) return '0 MB';
  if (value < 100_000) return '<0.1 MB';
  return value >= 1_000_000_000
    ? `${(value / 1_000_000_000).toFixed(2)} GB`
    : `${(value / 1_000_000).toFixed(1)} MB`;
}
