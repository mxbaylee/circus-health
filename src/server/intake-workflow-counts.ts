import type { WorkflowCounts } from './intake-workflow-reader.ts';

/** Selected contribution facts; each named scope contributes exactly once. */
export interface WorkflowCountFacts {
  pendingCount: number;
  unansweredCount: number;
  pendingWorkCount: number;
  reviewLaterCount: number;
  pendingPackageFailures: number;
}
const fields = [
  'pendingCount',
  'unansweredCount',
  'pendingWorkCount',
  'reviewLaterCount',
  'pendingPackageFailures',
] as const;
const empty = (): WorkflowCountFacts => ({
  pendingCount: 0,
  unansweredCount: 0,
  pendingWorkCount: 0,
  reviewLaterCount: 0,
  pendingPackageFailures: 0,
});
function checked(value: WorkflowCountFacts): void {
  for (const field of fields)
    if (!Number.isSafeInteger(value[field]) || value[field] < 0)
      throw Error('Invalid intake workflow count fact');
}
function add(
  total: WorkflowCountFacts,
  before: WorkflowCountFacts | null,
  after: WorkflowCountFacts | null,
): WorkflowCountFacts {
  checked(total);
  if (before) checked(before);
  if (after) checked(after);
  const next = empty();
  for (const field of fields)
    next[field] = total[field] - (before?.[field] || 0) + (after?.[field] || 0);
  checked(next);
  return next;
}

export interface VerifiedWorkflowCounts {
  /** Digest of relevant selected roots and source/policy pins; excludes auxiliary roots. */
  binding: string;
  facts: WorkflowCountFacts;
}
export interface WorkflowCountClosureDescriptor {
  root: string;
  count: number;
  from: string | null;
  to: string;
}
/**
 * Implement only over an authenticated complete dependency closure. Its entries
 * contain old/new selected facts, never counts trusted from a disposable index.
 * A cold rebuild has from=null and one insertion per complete domain scope.
 */
export interface WorkflowCountClosureReader {
  descriptor: WorkflowCountClosureDescriptor;
  page(
    start: number,
    limit: number,
  ): {
    root: string;
    start: number;
    entries: ReadonlyArray<{
      before: WorkflowCountFacts | null;
      after: WorkflowCountFacts | null;
    }>;
  };
}
export interface WorkflowRecount {
  format: 'health-intake-workflow-recount-v1';
  closure: WorkflowCountClosureDescriptor;
  next: number;
  accumulated: WorkflowCountFacts;
  lastVerified: VerifiedWorkflowCounts | null;
}
function closureChecked(value: WorkflowCountClosureDescriptor): void {
  if (!value.root || !value.to || !Number.isSafeInteger(value.count) || value.count < 0)
    throw Error('Invalid intake workflow recount closure');
}
export function beginWorkflowRecount(
  closure: WorkflowCountClosureDescriptor,
  previous: VerifiedWorkflowCounts | null,
): WorkflowRecount {
  closureChecked(closure);
  if (closure.from !== null && closure.from !== previous?.binding)
    throw Error('Intake workflow recount base is stale');
  if (previous) checked(previous.facts);
  return {
    format: 'health-intake-workflow-recount-v1',
    closure: { ...closure },
    next: 0,
    accumulated: closure.from === null ? empty() : { ...previous!.facts },
    lastVerified: previous && { binding: previous.binding, facts: { ...previous.facts } },
  };
}

/** One bounded checkpoint; incomplete jobs never claim current exact totals. */
export function advanceWorkflowRecount(
  job: WorkflowRecount,
  reader: WorkflowCountClosureReader,
  limit = 64,
): WorkflowRecount {
  closureChecked(job.closure);
  const expected = job.closure,
    actual = reader.descriptor;
  if (
    job.format !== 'health-intake-workflow-recount-v1' ||
    expected.root !== actual.root ||
    expected.count !== actual.count ||
    expected.from !== actual.from ||
    expected.to !== actual.to ||
    !Number.isSafeInteger(job.next) ||
    job.next < 0 ||
    job.next > expected.count ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw Error('Stale or invalid intake workflow recount');
  checked(job.accumulated);
  if (job.next === expected.count) return job;
  const page = reader.page(job.next, Math.min(limit, expected.count - job.next));
  if (
    page.root !== expected.root ||
    page.start !== job.next ||
    page.entries.length < 1 ||
    page.entries.length > limit ||
    job.next + page.entries.length > expected.count
  )
    throw Error('Incomplete or conflicting intake workflow recount page');
  let accumulated = job.accumulated;
  for (const entry of page.entries) {
    if (expected.from === null && entry.before !== null)
      throw Error('Cold intake workflow recount contains a removal');
    if (entry.before === null && entry.after === null)
      throw Error('Empty intake workflow recount contribution');
    accumulated = add(accumulated, entry.before, entry.after);
  }
  return { ...job, next: job.next + page.entries.length, accumulated };
}

export function workflowCountsFromFacts(facts: WorkflowCountFacts): WorkflowCounts {
  checked(facts);
  return {
    needsReview:
      facts.pendingCount > 0 ||
      facts.unansweredCount > 0 ||
      facts.pendingWorkCount > 0 ||
      facts.pendingPackageFailures > 0,
    pendingCount: facts.pendingCount,
    unansweredCount: facts.unansweredCount,
    pendingWorkCount: facts.pendingWorkCount,
    reviewLaterCount: facts.reviewLaterCount,
  };
}
export function workflowRecountSummary(
  job: WorkflowRecount,
  currentBinding: string,
):
  | { state: 'exact'; binding: string; counts: WorkflowCounts; verified: VerifiedWorkflowCounts }
  | {
      state: 'pending';
      binding: string;
      counts: null;
      lastVerified: { binding: string; counts: WorkflowCounts } | null;
    } {
  closureChecked(job.closure);
  if (
    job.format !== 'health-intake-workflow-recount-v1' ||
    !Number.isSafeInteger(job.next) ||
    job.next < 0 ||
    job.next > job.closure.count
  )
    throw Error('Invalid intake workflow recount checkpoint');
  if (job.closure.to === currentBinding && job.next === job.closure.count) {
    const verified = { binding: currentBinding, facts: { ...job.accumulated } };
    return {
      state: 'exact',
      binding: currentBinding,
      counts: workflowCountsFromFacts(verified.facts),
      verified,
    };
  }
  return {
    state: 'pending',
    binding: currentBinding,
    counts: null,
    lastVerified: job.lastVerified && {
      binding: job.lastVerified.binding,
      counts: workflowCountsFromFacts(job.lastVerified.facts),
    },
  };
}
