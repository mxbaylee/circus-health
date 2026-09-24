const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Fresh qualification profiles contain one original. Salted IDs join that import
 * to its exact source scopes within this one export. Plan dispositions, source-wide
 * reads, guessed markers and the extraction oracle are never delivery evidence. */
export function gradeQualificationDelivery(attribution: unknown, expectedPages: number) {
  const report = object(attribution);
  const imports = report?.imports;
  const bounds = object(report?.exportBounds);
  const current = Array.isArray(imports) && imports.length === 1 ? object(imports[0]) : null;
  const allPages = Array.from({ length: expectedPages }, (_, index) => index + 1);
  const reasonCodes: string[] = [];
  if (
    !report ||
    report.schemaVersion !== 1 ||
    report.unavailable === true ||
    !current ||
    typeof current.importId !== 'string' ||
    !Array.isArray(current.pages)
  )
    reasonCodes.push('page_attribution_unavailable');
  if (
    report &&
    (!bounds ||
      bounds.partial !== false ||
      report.omittedImports !== 0 ||
      report.omittedChats !== 0 ||
      report.unavailableChats !== 0)
  )
    reasonCodes.push('attribution_export_incomplete');
  if (
    current &&
    (current.historicalReadsUnknown !== false ||
      current.truncated !== false ||
      current.untrackedReadScopes !== 0 ||
      current.untrackedReadWindows !== 0)
  )
    reasonCodes.push('read_history_incomplete');
  if (reasonCodes.length)
    return {
      passed: false,
      status: 'unknown' as const,
      expectedPages,
      observedPages: null,
      acknowledgedPages: null,
      missingPages: null,
      reasonCodes,
    };
  const pages = current!.pages as unknown[];
  const observed = new Set<number>();
  const acknowledged = new Set<number>();
  for (const raw of pages) {
    const row = object(raw);
    if (
      !row ||
      row.sourceId !== current!.importId ||
      row.memberId !== null ||
      !positive(row.page) ||
      row.page > expectedPages
    )
      continue;
    if (positive(row.hostReads)) observed.add(row.page);
    const exposure = object(row.requestExposure);
    // A local read alone does not prove the provider received it. Both the
    // consumption acknowledgment and a responding physical exposure are needed.
    if (
      positive(row.hostReads) &&
      positive(row.acknowledgedReads) &&
      exposure &&
      positive(exposure.attempts) &&
      positive(exposure.responses)
    )
      acknowledged.add(row.page);
  }
  const missingPages = allPages.filter((page) => !acknowledged.has(page));
  return {
    passed: missingPages.length === 0,
    status: missingPages.length ? ('incomplete' as const) : ('complete' as const),
    expectedPages,
    observedPages: [...observed].sort((a, b) => a - b),
    acknowledgedPages: [...acknowledged].sort((a, b) => a - b),
    missingPages,
    reasonCodes: missingPages.length ? ['exact_page_delivery_unproven'] : [],
  };
}
