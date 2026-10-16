export const CONTROLLED_PDF_COMPLETION_MS = 18 * 60 * 1000;
export const CONTROLLED_PDF_OUTER_MS = 19 * 60 * 1000;
export const CONTROLLED_PDF_STALL_MS = 2 * 60 * 1000;

export function controlledCoverageSpanKey(unitId: string, pages: readonly number[]): string {
  if (
    typeof unitId !== 'string' ||
    !unitId ||
    !Array.isArray(pages) ||
    !pages.length ||
    pages.length > 100 ||
    Array.from(pages).some((page) => !Number.isSafeInteger(page) || page < 1 || page > 100)
  )
    throw Error('Invalid controlled PDF coverage span');
  return JSON.stringify([unitId, [...new Set(pages)].sort((a, b) => a - b)]);
}

/** Test-only immediate fictional upstream: activity is not useful progress. */
export function createControlledProgressWatchdog({
  now = () => performance.now(),
  completionMs = CONTROLLED_PDF_COMPLETION_MS,
  stallMs = CONTROLLED_PDF_STALL_MS,
}: {
  now?: () => number;
  completionMs?: number;
  stallMs?: number;
} = {}) {
  if (![completionMs, stallMs].every((value) => Number.isSafeInteger(value) && value > 0))
    throw Error('Invalid controlled PDF watchdog duration');
  let lastClock = now();
  if (!Number.isFinite(lastClock) || lastClock < 0)
    throw Error('Invalid controlled PDF watchdog clock');
  const started = lastClock;
  let advanced = started,
    pages = 0,
    batches = 0;
  const check = () => {
    const current = now();
    if (!Number.isFinite(current) || current < lastClock)
      throw Error('Controlled PDF watchdog clock moved backwards or is invalid');
    lastClock = current;
    if (current - started >= completionMs)
      throw Error('Controlled PDF run exceeded its finite completion deadline');
    if (current - advanced >= stallMs)
      throw Error('Controlled PDF run stalled without a new original page or durable batch');
    return current;
  };
  return {
    check,
    observe(progress: { pages: number; batches: number }) {
      // A late result cannot revive either deadline, including final completion.
      const current = check();
      if (
        ![progress.pages, progress.batches].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        progress.pages < pages ||
        progress.batches < batches
      )
        throw Error('Controlled PDF progress counters are invalid or moved backwards');
      if (progress.pages > pages || progress.batches > batches) advanced = current;
      pages = progress.pages;
      batches = progress.batches;
    },
  };
}
