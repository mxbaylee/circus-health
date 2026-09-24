import type {
  ClientOperationSummary,
  PerformanceOutcome,
} from '../../shared/import-performance.ts';
import { currentProfile, subscribeProfileIdentity } from './profile.ts';

type Phase = NonNullable<ClientOperationSummary['phases']>[number]['phase'];
type Counts = NonNullable<ClientOperationSummary['counts']>;
type Active = {
  profileId: string;
  start: number;
  summary: ClientOperationSummary;
  visibility: string;
};
const active = new Map<string, Active>();
const completed: ClientOperationSummary[] = [];
const deliveries = new Set<AbortController>();
const visibility = () => (typeof document === 'undefined' ? 'hidden' : document.visibilityState);
subscribeProfileIdentity(() => {
  active.clear();
  completed.length = 0;
  for (const controller of deliveries) controller.abort();
  deliveries.clear();
});
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    for (const op of active.values())
      if (op.visibility !== visibility()) op.summary.visibility = 'mixed';
  });

/** Bounded metadata only. Each operation is explicit so concurrent requests cannot steal its context. */
export function beginClientOperation(kind: ClientOperationSummary['kind'], counts: Counts = {}) {
  const operationId = crypto.randomUUID();
  const start = performance.now();
  const profileId = currentProfile()?.id;
  if (profileId) {
    if (active.size >= 32) active.delete(active.keys().next().value!);
    active.set(operationId, {
      profileId,
      start,
      visibility: visibility(),
      summary: {
        operationId,
        kind,
        outcome: 'completed',
        durationMs: 0,
        requestIds: [],
        phases: [],
        counts,
        visibility: visibility() === 'hidden' ? 'hidden' : 'visible',
      },
    });
  }
  return {
    operationId,
    counts: (counts: Counts) => {
      const op = active.get(operationId);
      if (op) Object.assign(op.summary.counts!, counts);
    },
    phase: (name: Phase, from: number, until = performance.now()) =>
      recordClientPhase(operationId, name, from, until),
    finish: (outcome: PerformanceOutcome = 'completed') => finish(operationId, outcome),
    /** Called after a state update. Includes React commit and waiting for a paint opportunity, not pure render CPU. */
    afterRender: (outcome: PerformanceOutcome = 'completed') =>
      finishAfterRender(operationId, outcome),
  };
}
export function recordClientRequest(operationId: string | undefined, requestId: string) {
  const op = operationId && active.get(operationId);
  if (!op || op.summary.requestIds!.includes(requestId)) return;
  if (op.summary.requestIds!.length < 32) op.summary.requestIds!.push(requestId);
  else op.summary.truncated = true;
}
export function recordClientPhase(
  operationId: string | undefined,
  phase: Phase,
  from: number,
  until = performance.now(),
) {
  const op = operationId && active.get(operationId);
  if (!op) return;
  if (op.summary.phases!.length >= 64) {
    op.summary.truncated = true;
    return;
  }
  op.summary.phases!.push({
    phase,
    startMs: Math.max(0, from - op.start),
    durationMs: Math.max(0, until - from),
  });
}
function finish(operationId: string, outcome: PerformanceOutcome) {
  const op = active.get(operationId);
  if (!op) return;
  active.delete(operationId);
  if (op.profileId !== currentProfile()?.id) return;
  op.summary.durationMs = Math.max(0, performance.now() - op.start);
  op.summary.outcome = outcome;
  completed.push(op.summary);
  if (completed.length > 64) completed.shift();
  // Reporting neither blocks the user action nor invokes api()/its request instrumentation recursively.
  const controller = new AbortController();
  deliveries.add(controller);
  const timeout = setTimeout(() => controller.abort(), 5000);
  void Promise.resolve()
    .then(() => {
      if (controller.signal.aborted || op.profileId !== currentProfile()?.id) return;
      return fetch(`/api/profiles/${encodeURIComponent(op.profileId)}/import-diagnostics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(op.summary),
        signal: controller.signal,
      });
    })
    .catch(() => {})
    .finally(() => {
      clearTimeout(timeout);
      deliveries.delete(controller);
    });
}
function finishAfterRender(operationId: string, outcome: PerformanceOutcome) {
  const start = performance.now();
  let done = false;
  let first = 0,
    second = 0;
  const settle = (observation: 'two_frames' | 'timeout') => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    }
    const op = active.get(operationId);
    if (op) op.summary.renderObservation = observation;
    recordClientPhase(operationId, 'render_wait', start);
    finish(operationId, outcome);
  };
  // Hidden tabs throttle animation frames. Retain visibility and bound this observation; do not claim a paint happened.
  const timeout = setTimeout(() => settle('timeout'), 250);
  if (typeof requestAnimationFrame === 'function')
    first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => settle('two_frames'));
    });
}
export function browserImportPerformance(): ClientOperationSummary[] {
  return structuredClone(completed);
}
