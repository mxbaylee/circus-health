import {
  clientOperationKinds,
  clientPerformancePhases,
  type ClientOperationSummary,
  type RecentOperationTimeline,
} from '../shared/import-performance.ts';
import type { ImportDiagnosticContext, ImportDiagnosticEvent } from './import-diagnostics.ts';

export const recentPerformanceLimits = Object.freeze({
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxOperations: 64,
  maxEventsPerOperation: 256,
  maxRelatedImportsPerOperation: 128,
  maxOpenSpansPerOperation: 128,
  maxBytes: 512 * 1024,
  flushIntervalMs: 5_000,
});
export interface PerformanceSummaryStore {
  read(): Uint8Array | null;
  write(bytes: Uint8Array): void;
}
interface Lifecycle {
  sequence: number;
  open: Array<{ key: string; phase: string; sequence: number }>;
  status: RecentOperationTimeline['status'];
  interruptedThrough: number;
  interruptedStarts: number[];
  interruptedStage: string | null;
  incomplete: boolean;
}
interface Operation {
  id: string;
  events: ImportDiagnosticEvent[];
  client?: ClientOperationSummary;
  updatedAt: string;
  dropped: number;
  interrupted?: boolean;
  lifecycle?: Lifecycle;
  relatedImportIds?: string[];
  relatedImportIdsTruncated?: boolean;
  resourcePeak: RecentOperationTimeline['resourcePeak'];
  resourceSampleCount?: number | null;
  pdfWorkerSampleCount?: number | null;
  phaseTotals?: Record<string, Omit<RecentOperationTimeline['phaseTotals'][number], 'phase'>>;
  phaseTotalsTruncated?: boolean;
}
interface State {
  operations: Operation[];
  droppedOperations: number;
  writeFailures: number;
  readFailures: number;
  lastPersistMs: number | null;
  dirty: boolean;
  estimatedBytes: number;
  store?: PerformanceSummaryStore;
  timer?: NodeJS.Timeout;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bounded = (value: unknown, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const maxDurationMs = 7 * 24 * 60 * 60 * 1000;
export function validateClientOperation(value: unknown): ClientOperationSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.operationId !== 'string' ||
    !uuid.test(v.operationId) ||
    !clientOperationKinds.includes(v.kind as ClientOperationSummary['kind']) ||
    !['completed', 'failed', 'cancelled'].includes(v.outcome as string) ||
    !bounded(v.durationMs, maxDurationMs)
  )
    return null;
  const result: ClientOperationSummary = {
    operationId: v.operationId,
    kind: v.kind as ClientOperationSummary['kind'],
    outcome: v.outcome as ClientOperationSummary['outcome'],
    durationMs: v.durationMs as number,
  };
  if (v.requestIds !== undefined) {
    if (
      !Array.isArray(v.requestIds) ||
      v.requestIds.length > 32 ||
      v.requestIds.some((x) => typeof x !== 'string' || !uuid.test(x))
    )
      return null;
    result.requestIds = [...new Set(v.requestIds)] as string[];
  }
  if (v.phases !== undefined) {
    if (!Array.isArray(v.phases) || v.phases.length > 64) return null;
    result.phases = [];
    for (const item of v.phases) {
      if (
        !item ||
        typeof item !== 'object' ||
        !clientPerformancePhases.includes(item.phase) ||
        !bounded(item.startMs, maxDurationMs) ||
        !bounded(item.durationMs, maxDurationMs) ||
        item.startMs + item.durationMs > (v.durationMs as number) + 1
      )
        return null;
      result.phases.push({ phase: item.phase, startMs: item.startMs, durationMs: item.durationMs });
    }
  }
  if (v.counts !== undefined) {
    if (!v.counts || typeof v.counts !== 'object' || Array.isArray(v.counts)) return null;
    result.counts = {};
    for (const name of ['files', 'bytes', 'rows', 'selected', 'actions', 'retries'] as const) {
      const n = (v.counts as Record<string, unknown>)[name];
      if (n !== undefined) {
        if (!bounded(n, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(n)) return null;
        result.counts[name] = n as number;
      }
    }
  }
  if (v.visibility !== undefined) {
    if (!['visible', 'hidden', 'mixed'].includes(v.visibility as string)) return null;
    result.visibility = v.visibility as ClientOperationSummary['visibility'];
  }
  if (v.renderObservation !== undefined) {
    if (!['two_frames', 'timeout'].includes(v.renderObservation as string)) return null;
    result.renderObservation = v.renderObservation as 'two_frames' | 'timeout';
  }
  if (v.truncated !== undefined) {
    if (typeof v.truncated !== 'boolean') return null;
    result.truncated = v.truncated;
  }
  return result;
}
const empty = (): State => ({
  operations: [],
  droppedOperations: 0,
  writeFailures: 0,
  readFailures: 0,
  lastPersistMs: null,
  dirty: false,
  estimatedBytes: 512,
});
const peak = (): Operation['resourcePeak'] => ({
  rssBytes: 0,
  cpuPercent: 0,
  eventLoopMaxMs: 0,
  activeScopes: 0,
  pdfWorkerRssSampleBytes: 0,
  runtimeAvailableBytes: null,
  tempAvailableBytes: null,
});
function key(context: ImportDiagnosticContext): string | undefined {
  return context.operationId || context.importId || context.runId;
}
function intervalUnion(intervals: Array<[number, number]>): number {
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0,
    start = 0,
    end = 0;
  for (const [a, b] of intervals) {
    if (a > end) {
      total += end - start;
      start = a;
      end = b;
    } else end = Math.max(end, b);
  }
  return total + end - start;
}
function eventPhase(e: ImportDiagnosticEvent): string | null {
  return typeof e.fields.phase === 'string'
    ? e.fields.phase
    : e.event.startsWith('http.')
      ? 'server_request'
      : e.event.startsWith('model.request.')
        ? 'provider_request'
        : e.event.startsWith('model.tool.')
          ? 'tool_execution'
          : e.event.startsWith('import.active.')
            ? e.context.operationId
              ? 'operation_active'
              : 'processing_active'
            : null;
}
function eventSpanKey(e: ImportDiagnosticEvent, phase: string): string {
  return JSON.stringify([
    e.event.replace(/\.[^.]+$/, ''),
    phase,
    e.context.spanId || '',
    e.context.requestId || '',
    e.context.runId || '',
    e.context.sliceId || '',
    e.context.turnId || '',
    e.context.providerRequestId || '',
  ]);
}
function terminalOutcome(e: ImportDiagnosticEvent): RecentOperationTimeline['status'] {
  if (
    e.event.endsWith('.failed') ||
    e.fields.outcome === 'failed' ||
    (typeof e.fields.status === 'number' && e.fields.status >= 400)
  )
    return 'failed';
  if (
    e.event.endsWith('.aborted') ||
    e.event.endsWith('.cancelled') ||
    e.fields.outcome === 'cancelled'
  )
    return 'cancelled';
  return e.fields.outcome === 'interrupted' ? 'interrupted' : 'completed';
}
function observeLifecycle(lifecycle: Lifecycle, e: ImportDiagnosticEvent): number {
  lifecycle.sequence = Math.max(lifecycle.sequence, e.sequence);
  const phase = eventPhase(e);
  if (!phase) return 0;
  const key = eventSpanKey(e, phase),
    index = lifecycle.open.findIndex((span) => span.key === key);
  let delta = 0;
  if (e.event.endsWith('.started')) {
    if (index >= 0) {
      const [removed] = lifecycle.open.splice(index, 1);
      delta -= Buffer.byteLength(JSON.stringify(removed));
      lifecycle.incomplete = true;
    }
    const span = { key, phase, sequence: e.sequence };
    lifecycle.open.push(span);
    delta += Buffer.byteLength(JSON.stringify(span));
    if (lifecycle.open.length > recentPerformanceLimits.maxOpenSpansPerOperation) {
      const removed = lifecycle.open.shift();
      delta -= Buffer.byteLength(JSON.stringify(removed));
      lifecycle.incomplete = true;
    }
    lifecycle.status = 'active';
  } else if (/\.(completed|failed|aborted|cancelled)$/.test(e.event)) {
    if (index >= 0) {
      const [removed] = lifecycle.open.splice(index, 1);
      delta -= Buffer.byteLength(JSON.stringify(removed));
    }
    lifecycle.status = lifecycle.open.length ? 'active' : terminalOutcome(e);
  }
  return delta;
}
function lifecycleFor(op: Operation): Lifecycle {
  if (!op.lifecycle) {
    op.lifecycle = {
      sequence: 0,
      open: [],
      status: 'active',
      interruptedThrough: 0,
      interruptedStarts: [],
      interruptedStage: null,
      incomplete: op.dropped > 0,
    };
    for (const event of op.events) observeLifecycle(op.lifecycle, event);
  }
  return op.lifecycle;
}
function interruptLifecycle(op: Operation): void {
  const lifecycle = lifecycleFor(op);
  if (lifecycle.open.length) {
    lifecycle.interruptedStage = lifecycle.open.at(-1)!.phase;
    lifecycle.interruptedStarts.push(...lifecycle.open.map((span) => span.sequence));
    if (lifecycle.interruptedStarts.length > recentPerformanceLimits.maxOpenSpansPerOperation) {
      lifecycle.interruptedStarts = lifecycle.interruptedStarts.slice(
        -recentPerformanceLimits.maxOpenSpansPerOperation,
      );
      lifecycle.incomplete = true;
    }
    lifecycle.open = [];
    lifecycle.status = 'interrupted';
  }
  lifecycle.interruptedThrough = lifecycle.sequence;
  op.interrupted = lifecycle.status === 'interrupted';
}
function restoredLifecycle(raw: unknown, op: Operation): Lifecycle {
  if (raw && typeof raw === 'object') {
    const value = raw as Partial<Lifecycle>;
    if (
      Number.isSafeInteger(value.sequence) &&
      bounded(value.sequence, Number.MAX_SAFE_INTEGER) &&
      Array.isArray(value.open) &&
      ['active', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.status || '')
    ) {
      const sequence = value.sequence!;
      return {
        sequence,
        open: value.open
          .slice(0, recentPerformanceLimits.maxOpenSpansPerOperation)
          .filter(
            (span) =>
              span &&
              typeof span.key === 'string' &&
              span.key.length <= 2048 &&
              !/[\r\n\x00-\x1f\x7f]/.test(span.key) &&
              typeof span.phase === 'string' &&
              /^[a-z][a-z0-9_.:-]{0,79}$/.test(span.phase) &&
              Number.isSafeInteger(span.sequence) &&
              bounded(span.sequence, sequence),
          )
          .map((span) => ({ key: span.key, phase: span.phase, sequence: span.sequence })),
        status: value.status!,
        interruptedStarts: Array.isArray(value.interruptedStarts)
          ? value.interruptedStarts
              .filter((n) => Number.isSafeInteger(n) && bounded(n, sequence))
              .slice(-recentPerformanceLimits.maxOpenSpansPerOperation)
          : [],
        interruptedThrough:
          Number.isSafeInteger(value.interruptedThrough) &&
          bounded(value.interruptedThrough, sequence)
            ? value.interruptedThrough!
            : 0,
        interruptedStage:
          typeof value.interruptedStage === 'string' &&
          /^[a-z][a-z0-9_.:-]{0,79}$/.test(value.interruptedStage)
            ? value.interruptedStage
            : null,
        incomplete:
          value.incomplete === true ||
          value.open.length > recentPerformanceLimits.maxOpenSpansPerOperation,
      };
    }
  }
  const lifecycle = lifecycleFor(op);
  lifecycle.incomplete = true;
  return lifecycle;
}
function timeline(op: Operation, now: number): RecentOperationTimeline {
  const first = op.events[0],
    base = first ? Date.parse(first.timestamp) : Date.parse(op.updatedAt);
  const lifecycle = lifecycleFor(op);
  const spans: RecentOperationTimeline['spans'] = [];
  const open = new Map<string, number>();
  const starts = new Map<number, { key: string; sequence: number }>();
  const intervals: Array<[number, number]> = [];
  let status: RecentOperationTimeline['status'] = 'active';
  for (const e of op.events) {
    const phase = eventPhase(e);
    if (!phase) continue;
    const spanKey = eventSpanKey(e, phase);
    const offset = Math.max(0, Date.parse(e.timestamp) - base);
    if (e.event.endsWith('.started')) {
      open.set(spanKey, spans.length);
      starts.set(spans.length, { key: spanKey, sequence: e.sequence });
      spans.push({
        phase,
        spanId: e.context.spanId,
        parentSpanId: e.context.parentSpanId,
        startMs: offset,
        durationMs: null,
        outcome: 'active',
        fields: { ...e.fields },
      });
      status = 'active';
    } else if (/\.(completed|failed|aborted|cancelled)$/.test(e.event)) {
      const outcome =
        e.event.endsWith('.failed') ||
        (typeof e.fields.status === 'number' && e.fields.status >= 400)
          ? 'failed'
          : e.event.endsWith('.aborted') || e.event.endsWith('.cancelled')
            ? 'cancelled'
            : typeof e.fields.outcome === 'string'
              ? e.fields.outcome
              : 'completed';
      const index = open.get(spanKey),
        existing =
          index === undefined ||
          lifecycle.interruptedStarts.includes(starts.get(index)?.sequence || -1)
            ? undefined
            : spans[index];
      const duration =
        typeof e.fields.durationMs === 'number'
          ? Math.max(0, e.fields.durationMs)
          : existing
            ? Math.max(0, offset - existing.startMs)
            : null;
      const span = existing || {
        phase,
        spanId: e.context.spanId,
        parentSpanId: e.context.parentSpanId,
        startMs: Math.max(0, offset - (duration ?? 0)),
        durationMs: null,
        outcome: 'active',
        fields: {},
      };
      span.durationMs = duration;
      span.outcome = outcome;
      span.fields = { ...span.fields, ...e.fields };
      if (!existing) spans.push(span);
      open.delete(spanKey);
      if (
        duration !== null &&
        !['server_request', 'processing_active', 'operation_active'].includes(phase)
      )
        intervals.push([span.startMs, span.startMs + duration]);
      if (outcome === 'failed' || outcome === 'cancelled') status = outcome;
      else if (!open.size) status = 'completed';
      if (
        !open.size &&
        (e.event === 'http.request.completed' ||
          e.event === 'http.request.aborted' ||
          e.event === 'import.active.completed')
      ) {
        status =
          outcome === 'failed'
            ? 'failed'
            : outcome === 'cancelled'
              ? 'cancelled'
              : outcome === 'interrupted'
                ? 'interrupted'
                : 'completed';
      }
    }
  }
  for (const [index, start] of starts) {
    const span = spans[index]!;
    if (
      span.durationMs === null &&
      !lifecycle.open.some((live) => live.key === start.key && live.sequence === start.sequence)
    )
      span.outcome = lifecycle.interruptedStarts.includes(start.sequence)
        ? 'interrupted'
        : 'terminal_detail_unavailable';
  }
  status = lifecycle.open.length ? 'active' : lifecycle.status;
  if (op.client) status = op.client.outcome;
  const end = Date.parse(op.updatedAt),
    elapsed = Math.max(0, (status === 'active' ? now : end) - base);
  const measured = intervalUnion(intervals);
  return {
    operationId: op.id,
    context: Object.assign({}, ...op.events.map((event) => event.context)),
    relatedImportIds: [...(op.relatedImportIds || [])],
    relatedImportIdsTruncated: op.relatedImportIdsTruncated === true,
    startedAt: new Date(base).toISOString(),
    lastProgressAt: op.updatedAt,
    elapsedWallMs: elapsed,
    progressAgeMs: Math.max(0, now - end),
    status,
    currentStage:
      lifecycle.open.at(-1)?.phase ||
      (status === 'interrupted' ? lifecycle.interruptedStage : null),
    lifecycleIncomplete: lifecycle.incomplete,
    spans,
    client: op.client,
    measuredServerMs: measured,
    unattributedServerMs: Math.max(0, elapsed - measured),
    droppedEvents: op.dropped,
    phaseTotals: Object.entries(op.phaseTotals || {}).map(([phase, totals]) => ({
      phase,
      ...totals,
    })),
    phaseTotalsTruncated: op.phaseTotalsTruncated === true,
    resourcePeak: { ...op.resourcePeak },
    resourceSampleCount: op.resourceSampleCount ?? null,
    pdfWorkerSampleCount: op.pdfWorkerSampleCount ?? null,
  };
}
export function createRecentPerformance(
  now: () => Date,
  sanitize: (event: ImportDiagnosticEvent) => ImportDiagnosticEvent | null,
) {
  const profiles = new Map<string, State>();
  const state = (profileId: string) => {
    let s = profiles.get(profileId);
    if (!s) {
      s = empty();
      profiles.set(profileId, s);
    }
    return s;
  };
  const serialize = (s: State) =>
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        operations: s.operations,
        droppedOperations: s.droppedOperations,
        writeFailures: s.writeFailures,
      }),
    );
  // Event payloads are immutable and sized once. Updating one operation never
  // serializes another operation or walks the retained event payloads.
  const eventBytes = new WeakMap<ImportDiagnosticEvent, number>();
  const operationEventBytes = new WeakMap<Operation, number>();
  const operationBytes = new WeakMap<Operation, number>();
  const sizeEvent = (event: ImportDiagnosticEvent) => {
    let bytes = eventBytes.get(event);
    if (bytes === undefined) {
      bytes = Buffer.byteLength(JSON.stringify(event));
      eventBytes.set(event, bytes);
    }
    return bytes;
  };
  const refreshSize = (s: State, op: Operation) => {
    let events = operationEventBytes.get(op);
    if (events === undefined) {
      events = op.events.reduce((total, event) => total + sizeEvent(event), 0);
      operationEventBytes.set(op, events);
    }
    // Serialize only bounded mutable metadata, never the event array. The 512
    // state allowance covers the JSON envelope, counters and operation commas.
    const bytes =
      Buffer.byteLength(JSON.stringify({ ...op, events: [] })) +
      events +
      Math.max(0, op.events.length - 1);
    s.estimatedBytes += bytes - (operationBytes.get(op) || 0);
    operationBytes.set(op, bytes);
  };
  const trim = (s: State) => {
    const threshold = now().getTime() - recentPerformanceLimits.maxAgeMs;
    const remove = (op: Operation) => {
      s.estimatedBytes -= operationBytes.get(op) || 0;
      s.droppedOperations++;
    };
    s.operations = s.operations.filter((op) => {
      if (Date.parse(op.updatedAt) >= threshold) return true;
      remove(op);
      return false;
    });
    while (
      s.operations.length &&
      (s.operations.length > recentPerformanceLimits.maxOperations ||
        s.estimatedBytes > recentPerformanceLimits.maxBytes)
    )
      remove(s.operations.shift()!);
  };
  const flush = (s: State) => {
    if (!s.store || !s.dirty) return;
    trim(s);
    const start = performance.now();
    try {
      // One serialization per persistence attempt; trim uses cached byte sizes.
      s.store.write(serialize(s));
      s.dirty = false;
    } catch {
      s.writeFailures++;
    } finally {
      s.lastPersistMs = performance.now() - start;
    }
  };
  const schedule = (s: State) => {
    s.dirty = true;
    if (!s.store || s.timer) return;
    s.timer = setTimeout(() => {
      s.timer = undefined;
      flush(s);
    }, recentPerformanceLimits.flushIntervalMs);
    s.timer.unref();
  };
  const operation = (s: State, id: string, timestamp: string) => {
    let op = s.operations.find((o) => o.id === id);
    if (!op) {
      op = {
        id,
        events: [],
        updatedAt: timestamp,
        dropped: 0,
        resourcePeak: peak(),
        resourceSampleCount: 0,
        pdfWorkerSampleCount: 0,
      };
      lifecycleFor(op);
      s.operations.push(op);
    } else {
      s.operations.splice(s.operations.indexOf(op), 1);
      s.operations.push(op);
    }
    return op;
  };
  return {
    record(profileId: string, event: ImportDiagnosticEvent) {
      const id = key(event.context);
      if (!id) return;
      const s = state(profileId),
        op = operation(s, id, event.timestamp);
      const importId = event.context.importId;
      if (importId) {
        const related = (op.relatedImportIds ||= []);
        if (!related.includes(importId)) {
          if (related.length < recentPerformanceLimits.maxRelatedImportsPerOperation) {
            related.push(importId);
          } else op.relatedImportIdsTruncated = true;
        }
      }
      if (event.event === 'process.resource.sample') {
        if (typeof op.resourceSampleCount === 'number')
          op.resourceSampleCount = Math.min(Number.MAX_SAFE_INTEGER, op.resourceSampleCount + 1);
        if (
          typeof op.pdfWorkerSampleCount === 'number' &&
          bounded(event.fields.pdfWorkerRssSampleBytes, Number.MAX_SAFE_INTEGER)
        )
          op.pdfWorkerSampleCount = Math.min(Number.MAX_SAFE_INTEGER, op.pdfWorkerSampleCount + 1);
        for (const k of [
          'rssBytes',
          'cpuPercent',
          'eventLoopMaxMs',
          'activeScopes',
          'pdfWorkerRssSampleBytes',
        ] as const) {
          const v = event.fields[k];
          if (typeof v === 'number') op.resourcePeak[k] = Math.max(op.resourcePeak[k], v);
        }
        for (const k of ['runtimeAvailableBytes', 'tempAvailableBytes'] as const) {
          const v = event.fields[k];
          if (typeof v === 'number') op.resourcePeak[k] = Math.min(op.resourcePeak[k] ?? v, v);
        }
      } else {
        op.updatedAt = event.timestamp;
        const lifecycle = lifecycleFor(op);
        event = { ...event, sequence: lifecycle.sequence + 1 };
        observeLifecycle(lifecycle, event);
        op.interrupted = lifecycle.status === 'interrupted';
        if (
          /\.(completed|failed|aborted|cancelled)$/.test(event.event) &&
          typeof event.fields.durationMs === 'number' &&
          event.fields.durationMs >= 0
        ) {
          const phase =
            typeof event.fields.phase === 'string'
              ? event.fields.phase
              : event.event.startsWith('model.request.')
                ? 'provider_request'
                : event.event.startsWith('model.tool.')
                  ? 'tool_execution'
                  : event.event.startsWith('http.')
                    ? 'server_request'
                    : null;
          if (phase) {
            const totals = (op.phaseTotals ||= {});
            if (!totals[phase] && Object.keys(totals).length < 64) {
              totals[phase] = { count: 0, totalMs: 0, maxMs: 0, failed: 0, cancelled: 0 };
            }
            const aggregate = totals[phase];
            if (aggregate) {
              aggregate.count++;
              aggregate.totalMs += event.fields.durationMs;
              aggregate.maxMs = Math.max(aggregate.maxMs, event.fields.durationMs);
              if (
                event.event.endsWith('.failed') ||
                event.fields.outcome === 'failed' ||
                (typeof event.fields.status === 'number' && event.fields.status >= 400)
              )
                aggregate.failed++;
              else if (
                event.event.endsWith('.aborted') ||
                event.event.endsWith('.cancelled') ||
                event.fields.outcome === 'cancelled'
              )
                aggregate.cancelled++;
            } else op.phaseTotalsTruncated = true;
          }
        }
        const priorEventBytes =
          operationEventBytes.get(op) ??
          op.events.reduce((total, retained) => total + sizeEvent(retained), 0);
        op.events.push(event);
        operationEventBytes.set(op, priorEventBytes + sizeEvent(event));
        if (op.events.length > recentPerformanceLimits.maxEventsPerOperation) {
          const removed = op.events.splice(1, 1);
          operationEventBytes.set(op, operationEventBytes.get(op)! - sizeEvent(removed[0]));
          op.dropped++;
        }
      }
      refreshSize(s, op);
      trim(s);
      schedule(s);
    },
    client(profileId: string, input: unknown): boolean {
      const client = validateClientOperation(input);
      if (!client) return false;
      const s = state(profileId),
        op = operation(s, client.operationId, now().toISOString());
      op.client = client;
      op.updatedAt = now().toISOString();
      refreshSize(s, op);
      trim(s);
      schedule(s);
      return true;
    },
    attach(profileId: string, store: PerformanceSummaryStore) {
      const s = state(profileId);
      s.store = store;
      try {
        const bytes = store.read();
        if (bytes && bytes.byteLength <= recentPerformanceLimits.maxBytes) {
          const data = JSON.parse(Buffer.from(bytes).toString()) as {
            schemaVersion?: unknown;
            operations?: unknown;
            droppedOperations?: unknown;
            writeFailures?: unknown;
          };
          if (data.schemaVersion !== 1 || !Array.isArray(data.operations))
            throw Error('Invalid diagnostics summary');
          const loaded: Operation[] = [];
          for (const raw of data.operations.slice(-recentPerformanceLimits.maxOperations)) {
            if (
              !raw ||
              typeof raw.id !== 'string' ||
              raw.id.length > 200 ||
              !Array.isArray(raw.events) ||
              !Number.isFinite(Date.parse(raw.updatedAt))
            )
              continue;
            const events = raw.events
              .slice(-recentPerformanceLimits.maxEventsPerOperation)
              .map(sanitize)
              .filter((x: ImportDiagnosticEvent | null): x is ImportDiagnosticEvent => x !== null);
            const resourcePeak = peak();
            for (const k of [
              'rssBytes',
              'cpuPercent',
              'eventLoopMaxMs',
              'activeScopes',
              'pdfWorkerRssSampleBytes',
            ] as const)
              if (bounded(raw.resourcePeak?.[k], Number.MAX_SAFE_INTEGER))
                resourcePeak[k] = raw.resourcePeak[k];
            for (const k of ['runtimeAvailableBytes', 'tempAvailableBytes'] as const)
              if (bounded(raw.resourcePeak?.[k], Number.MAX_SAFE_INTEGER))
                resourcePeak[k] = raw.resourcePeak[k];
            const phaseTotals: NonNullable<Operation['phaseTotals']> = {};
            if (
              raw.phaseTotals &&
              typeof raw.phaseTotals === 'object' &&
              !Array.isArray(raw.phaseTotals)
            )
              for (const [phase, unknown] of Object.entries(raw.phaseTotals).slice(0, 64)) {
                if (
                  !/^[a-z][a-z0-9_.:-]{0,79}$/.test(phase) ||
                  !unknown ||
                  typeof unknown !== 'object'
                )
                  continue;
                const totals = unknown as Record<string, unknown>;
                if (
                  ['count', 'totalMs', 'maxMs', 'failed', 'cancelled'].every((k) =>
                    bounded(totals[k], Number.MAX_SAFE_INTEGER),
                  )
                )
                  phaseTotals[phase] = {
                    count: totals.count as number,
                    totalMs: totals.totalMs as number,
                    maxMs: totals.maxMs as number,
                    failed: totals.failed as number,
                    cancelled: totals.cancelled as number,
                  };
              }
            const rawRelated = Array.isArray(raw.relatedImportIds)
              ? raw.relatedImportIds
              : events.map((event: ImportDiagnosticEvent) => event.context.importId);
            const allRelatedImportIds = [
              ...new Set(
                rawRelated.filter(
                  (id: unknown): id is string =>
                    typeof id === 'string' &&
                    id.length > 0 &&
                    id.length <= 200 &&
                    !/[\r\n\x00-\x1f\x7f]/.test(id),
                ),
              ),
            ] as string[];
            const relatedImportIds = allRelatedImportIds.slice(
              0,
              recentPerformanceLimits.maxRelatedImportsPerOperation,
            );
            loaded.push({
              id: raw.id,
              relatedImportIds,
              relatedImportIdsTruncated:
                raw.relatedImportIdsTruncated === true ||
                allRelatedImportIds.length > recentPerformanceLimits.maxRelatedImportsPerOperation,
              phaseTotals,
              phaseTotalsTruncated: raw.phaseTotalsTruncated === true,
              events,
              updatedAt: raw.updatedAt,
              dropped: bounded(raw.dropped, Number.MAX_SAFE_INTEGER) ? raw.dropped : 0,
              client: validateClientOperation(raw.client) || undefined,
              interrupted:
                raw.interrupted === true ||
                (!raw.client &&
                  timeline(
                    { id: raw.id, events, updatedAt: raw.updatedAt, dropped: 0, resourcePeak },
                    now().getTime(),
                  ).status === 'active'),
              resourcePeak,
              resourceSampleCount:
                Number.isSafeInteger(raw.resourceSampleCount) &&
                bounded(raw.resourceSampleCount, Number.MAX_SAFE_INTEGER)
                  ? raw.resourceSampleCount
                  : null,
              pdfWorkerSampleCount:
                Number.isSafeInteger(raw.pdfWorkerSampleCount) &&
                bounded(raw.pdfWorkerSampleCount, Number.MAX_SAFE_INTEGER)
                  ? raw.pdfWorkerSampleCount
                  : null,
            });
            const restored = loaded.at(-1)!;
            restored.lifecycle = restoredLifecycle(raw.lifecycle, restored);
            interruptLifecycle(restored);
          }
          const currentIds = new Set(s.operations.map((o) => o.id));
          s.operations = [...loaded.filter((o) => !currentIds.has(o.id)), ...s.operations];
          if (bounded(data.droppedOperations, Number.MAX_SAFE_INTEGER))
            s.droppedOperations += data.droppedOperations as number;
          if (bounded(data.writeFailures, Number.MAX_SAFE_INTEGER))
            s.writeFailures += data.writeFailures as number;
        } else if (bytes) throw Error('Oversized diagnostics summary');
      } catch {
        s.readFailures++;
      }
      s.estimatedBytes = 512;
      for (const op of s.operations) {
        operationBytes.delete(op);
        refreshSize(s, op);
      }
      trim(s);
      schedule(s);
    },
    detach(profileId: string) {
      const s = profiles.get(profileId);
      if (!s) return;
      if (s.timer) clearTimeout(s.timer);
      for (const op of s.operations) {
        interruptLifecycle(op);
        refreshSize(s, op);
      }
      s.dirty = true;
      flush(s);
      profiles.delete(profileId);
    },
    snapshot(profileId: string) {
      const s = state(profileId);
      trim(s);
      return {
        enabled: true,
        coverage: 'bounded_metadata_only' as const,
        limits: recentPerformanceLimits,
        operations: s.operations.map((o) => timeline(o, now().getTime())),
        droppedOperations: s.droppedOperations,
        writeFailures: s.writeFailures,
        readFailures: s.readFailures,
        lastPersistMs: s.lastPersistMs,
        persistence: s.store ? ('encrypted_local' as const) : ('memory_only' as const),
        pendingPersistence: s.dirty,
        resourceScope: 'process_shared_supporting_evidence' as const,
        runtime: {
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          buildId: null,
        },
      };
    },
    flush(profileId: string) {
      const s = profiles.get(profileId);
      if (s) flush(s);
    },
    close() {
      for (const profileId of [...profiles.keys()]) this.detach(profileId);
    },
  };
}
