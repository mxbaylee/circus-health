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
  activeMs: 2 * 60 * 60 * 1000,
  slices: 16,
  turns: 256,
  requests: 2048,
  measuredTokens: 20_000_000,
};

const progress = (reading: IntakeBatchReadingState | null) => ({
  records: reading?.readyRecords || 0,
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
    budgetAtTokens: item.reading?.measuredModelTokens || 0,
    extensions: 0,
  };
  const job = item.readingJob;
  if (job.sliceStartedAt) return;
  job.baseline = progress(item.reading);
  job.observed = job.baseline;
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
    if (job.limitPolicy === 'progress-window') observeReadingProgress({ ...item, reading }, at);
    else job.lastProgressAt = at;
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
    if (job.limitPolicy === 'progress-window') renewProgressWindow(item, item.reading, at);
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
  job.budgetAtTokens = reading?.measuredModelTokens || 0;
  job.progressWindows = (job.progressWindows || 0) + 1;
}

export function readingBudgetReached(
  item: IntakeBatchItem,
  at: string,
  limits: IntakeReadingLimits = DEFAULT_INTAKE_READING_LIMITS,
): boolean {
  const job = item.readingJob;
  if (!job) return false;
  limits = job.limits || limits;
  const currentMs = job.sliceStartedAt
    ? Math.max(0, Date.parse(at) - Date.parse(job.sliceStartedAt))
    : 0;
  return (
    job.activeMs + currentMs - job.budgetAtActiveMs >= limits.activeMs ||
    (!job.sliceStartedAt && job.slices - job.budgetAtSlices >= limits.slices) ||
    (item.reading?.turns || 0) - job.budgetAtTurns >= limits.turns ||
    (item.reading?.modelRequests || 0) - (job.budgetAtRequests || 0) >=
      (limits.requests ?? DEFAULT_INTAKE_READING_LIMITS.requests!) ||
    (item.reading?.measuredModelTokens || 0) - (job.budgetAtTokens || 0) >=
      (limits.measuredTokens ?? DEFAULT_INTAKE_READING_LIMITS.measuredTokens!)
  );
}

/**
 * Checks the cumulative job budget at the synchronous provider-request boundary.
 * The assistant has already reserved the current model turn when this runs, so
 * exclude that reservation while retaining every persisted request/token count.
 */
export function readingModelRequestBudgetReached(
  item: IntakeBatchItem,
  reading: IntakeBatchReadingState,
  at: string,
  limits: IntakeReadingLimits = DEFAULT_INTAKE_READING_LIMITS,
): boolean {
  if (item.readingJob?.limitPolicy === 'progress-window')
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

/** Only an explicit Resume after the displayed job limit grants another budget. */
export function extendReadingBudget(item: IntakeBatchItem): void {
  const job = item.readingJob;
  if (!job) return;
  job.budgetAtActiveMs = job.activeMs;
  job.budgetAtSlices = job.slices;
  job.budgetAtTurns = item.reading?.turns || 0;
  job.budgetAtRequests = item.reading?.modelRequests || 0;
  job.budgetAtTokens = item.reading?.measuredModelTokens || 0;
  job.extensions++;
}

export function canContinueReadingSlice(
  reading: IntakeBatchReadingState | null,
  madeProgress: boolean,
): boolean {
  return (
    madeProgress &&
    !!reading &&
    ['time_limit', 'context_limit'].includes(reading.reason || '') &&
    (reading.pendingReadWindows > 0 || reading.remainingUnits > 0)
  );
}
