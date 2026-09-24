const isEmptyReferenceValue = (value: unknown): boolean =>
  value == null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

/** Returns a readable literal when one exists, while retaining structured source ranges. */
export function clinicalReferenceText(reference: unknown): string | null {
  if (typeof reference === 'string') return reference.trim() ? reference : null;
  if (!reference || typeof reference !== 'object') return null;

  if (Array.isArray(reference)) return reference.length ? JSON.stringify(reference, null, 2) : null;

  const values = Object.values(reference);
  if (!values.length || values.every(isEmptyReferenceValue)) return null;

  const text = (reference as { text?: unknown }).text;
  if (typeof text === 'string' && text.trim()) return text;

  return JSON.stringify(reference, null, 2);
}
