import type { IntakeBatchItem, IntakeBatchReadingState } from '../shared/intake-batch.ts';

export interface IntakeReadingLimits {
  mode?: 'cumulative' | 'progress-window';
  activeMs: number;
  slices: number;
  turns: number;
  requests?: number;
  measuredTokens?: number;
}

export const DEFAULT_INTAKE_READING_LIMITS: Readonly<IntakeReadingLimits> = {
  mode: 'progress-window',
  activeMs: 3 * 60 * 1000,
  slices: 16,
  turns: 256,
  // Allow bounded context/plan setup before a source window is delivered.
  requests: 16,
  measuredTokens: 20_000_000,
};

const progress = (reading: IntakeBatchReadingState | null) => ({
  records: reading?.substantiveVersions ?? reading?.readyRecords ?? 0,
  windows: reading?.readWindows || 0,
  accounted: reading?.accountedUnits || 0,
});

export function beginReadingSlice(
  item: IntakeBatchItem,
  at: string,
  limits?: IntakeReadingLimits,
): void {
  item.readingJob ||= {
    limitPolicy: limits?.mode || 'cumulative',
    ...(limits
      ? {
          limits: {
            activeMs: limits.activeMs,
            slices: limits.slices,
            turns: limits.turns,
            requests: limits.requests,
            measuredTokens: limits.measuredTokens,
          },
        }
      : {}),
    progressWindows: 0,
    slices: 0,
    activeMs: 0,
    sliceStartedAt: null,
    lastProgressAt: null,
    baseline: progress(item.reading),
    budgetAtSlices: 0,
    budgetAtActiveMs: 0,
    budgetAtTurns: item.reading?.turns || 0,
    budgetAtRequests: item.reading?.modelRequests || 0,
    budgetAtResponses: item.reading?.usableModelResponses || 0,
    budgetAtTokens: item.reading?.measuredModelTokens || 0,
    extensions: 0,
  };
  const job = item.readingJob;
  restoreReadingJobBaseline(item);
  if (job.sliceStartedAt) return;
  job.baseline = progress(item.reading);
  job.observed ||= job.baseline;
  job.sliceStartedAt = at;
  job.slices++;
}

export function finishReadingSlice(
  item: IntakeBatchItem,
  reading: IntakeBatchReadingState | null,
  at: string,
): boolean {
  const job = item.readingJob;
  if (!job?.sliceStartedAt) return false;
  job.activeMs += Math.max(0, Date.parse(at) - Date.parse(job.sliceStartedAt));
  job.sliceStartedAt = null;
  const current = progress(reading);
  const changed = (Object.keys(current) as (keyof typeof current)[]).some(
    (key) => current[key] > job.baseline[key],
  );
  if (changed) {
    // A fresh coverage/proposal checkpoint renews only an inactivity window.
    // Cumulative requests, measured tokens, time, slices and unknown usage survive.
    observeReadingProgress({ ...item, reading }, at);
  }
  return changed;
}

export function observeReadingProgress(item: IntakeBatchItem, at: string): boolean {
  const job = item.readingJob;
  if (!job) return false;
  const current = progress(item.reading);
  const before = job.observed || job.baseline;
  const changed = (Object.keys(current) as (keyof typeof current)[]).some(
    (key) => current[key] > before[key],
  );
  if (changed) {
    job.lastProgressAt = at;
    job.observed = current;
    renewProgressWindow(item, item.reading, at);
    if (item.stalls) item.stalls.attempts = 0;
  }
  return changed;
}
function renewProgressWindow(
  item: IntakeBatchItem,
  reading: IntakeBatchReadingState | null,
  at: string,
) {
  const job = item.readingJob!;
  job.budgetAtActiveMs =
    job.activeMs +
    (job.sliceStartedAt ? Math.max(0, Date.parse(at) - Date.parse(job.sliceStartedAt)) : 0);
  job.budgetAtSlices = job.slices;
  job.budgetAtTurns = reading?.turns || 0;
  job.budgetAtRequests = reading?.modelRequests || 0;
  job.budgetAtResponses = reading?.usableModelResponses || 0;
  job.budgetAtTokens = reading?.measuredModelTokens || 0;
  job.progressWindows = (job.progressWindows || 0) + 1;
}

/**
 * A job journaled before the no-progress window counted responses has no
 * response baseline. Treating it as zero would count every earlier response
 * as unproductive and spend a stall attempt before any new request is sent.
 */
export function restoreReadingJobBaseline(item: IntakeBatchItem): void {
  const job = item.readingJob;
  if (job && job.budgetAtResponses === undefined)
    job.budgetAtResponses = item.reading?.usableModelResponses || 0;
}

export function readingBudgetReached(
  item: IntakeBatchItem,
  at: string,
  limits: IntakeReadingLimits = DEFAULT_INTAKE_READING_LIMITS,
): boolean {
  const job = item.readingJob;
  if (!job) return false;
  // Elapsed model time is diagnostic: a slow local route can spend hours on a
  // productive request. Count completed requests without durable progress.
  void at;
  return (
    (item.reading?.usableModelResponses || 0) - (job.budgetAtResponses || 0) >=
    (limits.requests ?? DEFAULT_INTAKE_READING_LIMITS.requests!)
  );
}

/**
 * Checks completed responses without unique progress at the request boundary.
 * The assistant has already reserved the current model turn when this runs, so
 * exclude that reservation while retaining every persisted request/token count.
 */
export function readingModelRequestBudgetReached(
  item: IntakeBatchItem,
  reading: IntakeBatchReadingState,
  at: string,
  limits: IntakeReadingLimits = DEFAULT_INTAKE_READING_LIMITS,
): boolean {
  observeReadingProgress({ ...item, reading }, at);
  return readingBudgetReached(
    {
      ...item,
      reading: {
        ...reading,
        turns: Math.max(0, reading.turns - 1),
      },
    },
    at,
    limits,
  );
}

/** Begin a fresh no-progress attempt without erasing lifetime usage. */
export function extendReadingBudget(item: IntakeBatchItem): void {
  const job = item.readingJob;
  if (!job) return;
  job.budgetAtActiveMs = job.activeMs;
  job.budgetAtSlices = job.slices;
  job.budgetAtTurns = item.reading?.turns || 0;
  job.budgetAtRequests = item.reading?.modelRequests || 0;
  job.budgetAtResponses = item.reading?.usableModelResponses || 0;
  job.budgetAtTokens = item.reading?.measuredModelTokens || 0;
  job.extensions++;
}

export function canContinueReadingSlice(
  reading: IntakeBatchReadingState | null,
  _madeProgress: boolean,
): boolean {
  return (
    !!reading &&
    ['time_limit', 'context_limit', 'job_limit', 'no_progress', 'model_tool_retry'].includes(
      reading.reason || '',
    ) &&
    (reading.pendingReadWindows > 0 || reading.remainingUnits > 0)
  );
}
