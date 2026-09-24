/** Reset only after a different primary test resolves, not during result loading. */
export function resetTestComparisons(
  previousPrimary: string | undefined,
  primary: string | undefined,
  params: URLSearchParams,
): URLSearchParams | null {
  if (
    !previousPrimary ||
    !primary ||
    previousPrimary === primary ||
    (!params.has('compare') && !params.has('compareUnit'))
  )
    return null;
  const next = new URLSearchParams(params);
  next.delete('compare');
  next.delete('compareUnit');
  return next;
}
