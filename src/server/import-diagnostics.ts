import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { HttpError } from './database.ts';
import { ModelToolValidationError } from './model-tool-validation.ts';
import {
  diagnosticContext,
  diagnosticValidation,
  diagnosticValidationPath,
  safeDiagnosticValidationCode,
} from './import-diagnostic-error.ts';
import { pdfEvidenceSessionDiagnostics } from './intake-pdf-session.ts';
import { createRecentPerformance, type PerformanceSummaryStore } from './import-performance.ts';
import { isDiagnosticRoute } from '../shared/import-diagnostic-route.ts';
import type { ImportDiagnosticEventWindow } from '../shared/import-performance.ts';
import {
  createPrivateImportTrace,
  type PrivateImportTrace,
  type PrivateTraceEvent,
  type PrivateTraceOmissionReason,
  type PrivateTraceStatus,
} from './import-private-trace.ts';

export interface ImportDiagnosticContext {
  profileId?: string;
  operationId?: string;
  spanId?: string;
  parentSpanId?: string;
  requestId?: string;
  clientRequestId?: string;
  importId?: string;
  batchId?: string;
  runId?: string;
  sliceId?: string;
  turnId?: string;
  providerRequestId?: string;
}

export type ImportDiagnosticEventName =
  | 'http.request.started'
  | 'http.request.completed'
  | 'http.request.aborted'
  | 'model.request.started'
  | 'model.request.completed'
  | 'model.request.failed'
  | 'model.response.shape'
  | 'model.tool.started'
  | 'model.tool.completed'
  | 'model.tool.failed'
  | 'import.active.started'
  | 'import.active.completed'
  | 'import.phase.started'
  | 'import.phase.completed'
  | 'import.phase.failed'
  | 'import.phase.cancelled'
  | 'import.progress'
  | 'process.resource.sample';

export type ImportDiagnosticFieldValue = string | number | boolean | null;
export type ImportDiagnosticFields = Readonly<Record<string, ImportDiagnosticFieldValue>>;

export interface ImportDiagnosticEvent {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  monotonicMs: number;
  event: ImportDiagnosticEventName;
  context: Omit<ImportDiagnosticContext, 'profileId'>;
  fields: ImportDiagnosticFields;
}

export interface ImportDiagnosticExport {
  schemaVersion: 1;
  generatedAt: string;
  exportId: string;
  consoleScopeId: string;
  events: ImportDiagnosticEvent[];
  retainedEvents: number;
  droppedEvents: number;
  eventWindow: ImportDiagnosticEventWindow;
  coverage: 'bounded_metadata_only';
  privateTrace?: PrivateTraceStatus;
  recentPerformance?: ReturnType<ReturnType<typeof createRecentPerformance>['snapshot']>;
}

export interface ImportDiagnosticActiveScope {
  record: (
    event: ImportDiagnosticEventName,
    fields?: ImportDiagnosticFields,
    context?: ImportDiagnosticContext,
  ) => void;
  finish: (fields?: ImportDiagnosticFields) => void;
}

export interface ImportDiagnosticSink {
  readonly enabled: boolean;
  run<T>(context: ImportDiagnosticContext, operation: () => T): T;
  record(
    event: ImportDiagnosticEventName,
    fields?: ImportDiagnosticFields,
    context?: ImportDiagnosticContext,
  ): void;
  startActive(profileId: string, context?: ImportDiagnosticContext): ImportDiagnosticActiveScope;
  capturePayload?(
    event: PrivateTraceEvent,
    payload: unknown,
    context?: ImportDiagnosticContext,
    secrets?: readonly string[],
    options?: { truncated?: boolean },
  ): void;
  omitPayload?(
    event: PrivateTraceEvent,
    reason: PrivateTraceOmissionReason,
    context?: ImportDiagnosticContext,
  ): void;
}

export interface ImportDiagnostics extends ImportDiagnosticSink {
  snapshot(profileId: string): ImportDiagnosticEvent[];
  exportSnapshot(profileId: string, salt?: Buffer): ImportDiagnosticExport;
  clear(profileId: string): void;
  close(): void;
  recordClientOperation(profileId: string, input: unknown): boolean;
  attachSummaryStore(profileId: string, store: PerformanceSummaryStore): void;
  detachSummaryStore(profileId: string): void;
  flushSummaries(profileId: string): void;
}

export interface ImportDiagnosticsOptions {
  enabled?: boolean;
  capacity?: number;
  resourceIntervalMs?: number;
  /** Capacity is supporting evidence, sampled asynchronously and less often than CPU/RSS. */
  filesystemIntervalMs?: number;
  filesystemAvailableBytes?: (path: string) => Promise<number | null>;
  now?: () => Date;
  monotonicNow?: () => number;
  createId?: () => string;
  onEvent?: (event: ImportDiagnosticEvent, consoleScopeId: string) => void;
  privateTrace?: PrivateImportTrace;
}

export interface StructuralSummary {
  kind: string;
  jsonBytes: number;
  nodes: number;
  objectProperties: number;
  arrayItems: number;
  strings: number;
  stringBytes: number;
  numbers: number;
  booleans: number;
  nulls: number;
  maxDepth: number;
  truncated: boolean;
}

const contextStorage = new AsyncLocalStorage<ImportDiagnosticContext>();
const sinkStorage = new AsyncLocalStorage<ImportDiagnosticSink>();
const idKeys = [
  'operationId',
  'spanId',
  'parentSpanId',
  'requestId',
  'clientRequestId',
  'importId',
  'batchId',
  'runId',
  'sliceId',
  'turnId',
  'providerRequestId',
] as const;
const contextKeys = new Set<string>(['profileId', ...idKeys]);
const maxStructuralNodes = 10_000;
const maxStructuralDepth = 32;
const maxStructuralBytes = 16 * 1024 * 1024;
const MiB = 1024 * 1024;
const diagnosticCodePattern = /^[a-z][a-z0-9_.:-]{0,79}$/;

function safeStringField(key: string, value: string): boolean {
  if (key === 'lastChangeCategory')
    return [
      'identity_confirmation',
      'proposal',
      'acceptance',
      'source_text',
      'review',
      'question',
      'plan',
      'workflow_update',
      'unknown',
    ].includes(value);
  if (key === 'recoveryAction')
    return [
      'refresh_context',
      'pause',
      'context_read',
      'batch_progress',
      'source_read',
      'reconcile_coverage',
    ].includes(value);
  if (key === 'contextSection')
    return [
      'plan',
      'units',
      'candidates',
      'occurrences',
      'report_scopes',
      'questions',
      'question_answers',
      'proposals',
      'decisions',
      'batches',
      'operations',
      'acceptances',
      'mapping_rules',
      'missing_assets',
      'unknown',
    ].includes(value);
  if (key === 'method') return /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(value);
  if (key === 'route') return isDiagnosticRoute(value);
  if (key === 'scope') return value === 'process';
  if (key === 'toolName') return /^health_[a-z][a-z0-9_]{0,79}$/.test(value);
  if (key === 'model') return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value);
  if (key === 'errorCode') return value === 'tool_rejected_after_close';
  if (key === 'validationPath') return diagnosticValidationPath(value) === value;
  if (key === 'validationCode') return safeDiagnosticValidationCode(value);
  if (key === 'errorType')
    return [
      'http_error',
      'model_tool_validation',
      'type_error',
      'syntax_error',
      'range_error',
      'error',
      'non_error',
    ].includes(value);
  if (key === 'errorCategory') return ['validation', 'http', 'unexpected'].includes(value);
  if (key.endsWith('Kind'))
    return /^(array|bigint|boolean|bytes|function|null|number|object|string|symbol|undefined)$/.test(
      value,
    );
  return ['classification', 'outcome', 'phase', 'reasonCode'].includes(key)
    ? diagnosticCodePattern.test(value)
    : false;
}

/**
 * The one `reasonCode` derivation for an `import.phase.failed` event, shared by
 * every phase so the coercion cannot be right at one call site and wrong at another.
 *
 * Host HttpError and wrapped ModelToolValidationError codes are retained.
 * `HttpError.code` is *typed* `string` but is never coerced, and a PDF worker error
 * can carry a number: pdf.js sets `PasswordException.code` to the numeric
 * `PasswordResponses.NEED_PASSWORD` on a password-protected PDF, the worker's
 * `errorResponse` forwards it because `1` is truthy, and `publicWorkerError` passes
 * it verbatim into `new HttpError(422, code, …)`. Calling `.toLowerCase()` on that
 * throws a TypeError from inside the catch block, losing both the event and the
 * clean 422. A code that survives coercion but fails `diagnosticCodePattern` is
 * just as bad in the other direction: `safeFields()` drops it silently and the
 * event ships with no reason at all. Both cases resolve to 'unexpected_error'.
 */
export function diagnosticReasonCode(error: unknown): string {
  if (
    !(error instanceof HttpError || error instanceof ModelToolValidationError) ||
    typeof error.code !== 'string'
  )
    return 'unexpected_error';
  const code = error.code.toLowerCase();
  return diagnosticCodePattern.test(code) ? code : 'unexpected_error';
}

export function diagnosticFailureFields(error: unknown): ImportDiagnosticFields {
  const validation = diagnosticValidation(error);
  return {
    ...diagnosticContext(error),
    reasonCode: diagnosticReasonCode(error),
    errorType:
      error instanceof ModelToolValidationError
        ? 'model_tool_validation'
        : error instanceof HttpError
          ? 'http_error'
          : error instanceof TypeError
            ? 'type_error'
            : error instanceof SyntaxError
              ? 'syntax_error'
              : error instanceof RangeError
                ? 'range_error'
                : error instanceof Error
                  ? 'error'
                  : 'non_error',
    errorCategory:
      validation || error instanceof ModelToolValidationError
        ? 'validation'
        : error instanceof HttpError
          ? 'http'
          : 'unexpected',
    ...(error instanceof HttpError &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
      ? { status: error.status }
      : {}),
    ...(validation
      ? {
          validationCode: validation.code,
          validationPath: validation.path,
          ...(validation.line !== undefined ? { validationLine: validation.line } : {}),
        }
      : {}),
  };
}

function boundedInteger(value: number, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function safeFields(
  fields: ImportDiagnosticFields,
  traceEventId: string | null = null,
): ImportDiagnosticFields {
  const entries: Array<[string, ImportDiagnosticFieldValue]> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(key)) continue;
    if (key === 'traceEventId') continue;
    if (typeof value === 'string') {
      if (value.length <= 160 && !/[\r\n\x00-\x1f\x7f]/.test(value) && safeStringField(key, value))
        entries.push([key, value]);
    } else if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      entries.push([key, value]);
    }
    if (entries.length === (traceEventId ? 47 : 48)) break;
  }
  if (traceEventId) entries.push(['traceEventId', traceEventId]);
  return Object.freeze(Object.fromEntries(entries));
}

function mergedContext(
  inherited: ImportDiagnosticContext | undefined,
  supplied: ImportDiagnosticContext | undefined,
): ImportDiagnosticContext {
  const merged = { ...inherited, ...supplied };
  return Object.fromEntries(
    Object.entries(merged).filter(
      ([key, value]) =>
        // Keep explicit clears inside the private context. A phase or active scope
        // can be emitted later under its initiating HTTP AsyncLocalStorage context;
        // dropping undefined here would revive that browser operation on the next merge.
        (value === undefined && contextKeys.has(key)) ||
        (typeof value === 'string' &&
          value.length > 0 &&
          value.length <= 200 &&
          !/[\r\n\x00-\x1f\x7f]/.test(value)),
    ),
  );
}

function capturedContext(
  inherited: ImportDiagnosticContext | undefined,
  supplied: ImportDiagnosticContext,
): ImportDiagnosticContext {
  const context = mergedContext(inherited, supplied);
  // A scope can finish inside a later request/turn. Capture absent IDs as clears
  // too, so record() cannot give its terminal a different span identity.
  for (const key of ['profileId', ...idKeys] as const) context[key] ??= undefined;
  return context;
}

function publicContext(
  context: ImportDiagnosticContext,
): Omit<ImportDiagnosticContext, 'profileId'> {
  return Object.fromEntries(idKeys.flatMap((key) => (context[key] ? [[key, context[key]]] : [])));
}

function valueKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Uint8Array) return 'bytes';
  return typeof value;
}

export function structuralSummary(value: unknown): StructuralSummary {
  const summary: StructuralSummary = {
    kind: valueKind(value),
    jsonBytes: 0,
    nodes: 0,
    objectProperties: 0,
    arrayItems: 0,
    strings: 0,
    stringBytes: 0,
    numbers: 0,
    booleans: 0,
    nulls: 0,
    maxDepth: 0,
    truncated: false,
  };
  const seen = new Set<object>();
  const addBytes = (bytes: number): void => {
    const remaining = maxStructuralBytes - summary.jsonBytes;
    if (bytes > remaining) {
      summary.jsonBytes = maxStructuralBytes;
      summary.truncated = true;
    } else summary.jsonBytes += bytes;
  };
  const addJsonStringBytes = (text: string): void => {
    let escapedExtra = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 0x22 || code === 0x5c) escapedExtra += 1;
      else if (code <= 0x1f) escapedExtra += 5;
    }
    addBytes(2 + Buffer.byteLength(text) + escapedExtra);
  };
  const visit = (current: unknown, depth: number): void => {
    if (summary.nodes >= maxStructuralNodes || depth > maxStructuralDepth) {
      summary.truncated = true;
      return;
    }
    summary.nodes += 1;
    summary.maxDepth = Math.max(summary.maxDepth, depth);
    if (current === null) {
      summary.nulls += 1;
      addBytes(4);
    } else if (typeof current === 'string') {
      summary.strings += 1;
      summary.stringBytes += Buffer.byteLength(current);
      addJsonStringBytes(current);
    } else if (typeof current === 'number') {
      summary.numbers += 1;
      addBytes(Buffer.byteLength(Number.isFinite(current) ? String(current) : 'null'));
    } else if (typeof current === 'boolean') {
      summary.booleans += 1;
      addBytes(current ? 4 : 5);
    } else if (current instanceof Uint8Array) {
      summary.stringBytes += current.byteLength;
      addBytes(current.byteLength);
    } else if (typeof current === 'object') {
      if (seen.has(current)) {
        summary.truncated = true;
        return;
      }
      seen.add(current);
      if (Array.isArray(current)) {
        addBytes(2);
        for (const [index, item] of current.entries()) {
          if (summary.nodes >= maxStructuralNodes) {
            summary.truncated = true;
            break;
          }
          summary.arrayItems += 1;
          if (index) addBytes(1);
          visit(item, depth + 1);
        }
      } else {
        addBytes(2);
        let index = 0;
        for (const key in current) {
          if (!Object.hasOwn(current, key)) continue;
          if (summary.nodes >= maxStructuralNodes) {
            summary.truncated = true;
            break;
          }
          summary.objectProperties += 1;
          if (index++) addBytes(1);
          addJsonStringBytes(key);
          addBytes(1);
          visit((current as Record<string, unknown>)[key], depth + 1);
        }
      }
    }
  };
  visit(value, 0);
  return summary;
}

export function structuralFields(prefix: string, value: unknown): ImportDiagnosticFields {
  const summary = structuralSummary(value);
  const title = prefix[0].toUpperCase() + prefix.slice(1);
  return {
    [`${prefix}Kind`]: summary.kind,
    [`${prefix}JsonBytes`]: summary.jsonBytes,
    [`${prefix}Nodes`]: summary.nodes,
    [`${prefix}ObjectProperties`]: summary.objectProperties,
    [`${prefix}ArrayItems`]: summary.arrayItems,
    [`${prefix}Strings`]: summary.strings,
    [`${prefix}StringBytes`]: summary.stringBytes,
    [`${prefix}MaxDepth`]: summary.maxDepth,
    [`${prefix}Truncated`]: summary.truncated,
    [`has${title}`]: value !== undefined,
  };
}

function anonymizeEvent(event: ImportDiagnosticEvent, salt: Buffer): ImportDiagnosticEvent {
  const context = Object.fromEntries(
    Object.entries(event.context).map(([key, value]) => [
      key,
      ['requestId', 'clientRequestId', 'operationId'].includes(key) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
        ? value
        : createHash('sha256').update(salt).update(value).digest('hex').slice(0, 20),
    ]),
  );
  return { ...event, context };
}

export function createImportDiagnostics({
  enabled = false,
  capacity = 10_000,
  resourceIntervalMs = 5_000,
  filesystemIntervalMs = 30_000,
  filesystemAvailableBytes = async (path) => {
    const value = await statfs(path);
    return Math.max(0, value.bavail * value.bsize);
  },
  now = () => new Date(),
  monotonicNow = () => performance.now(),
  createId = randomUUID,
  onEvent,
  privateTrace,
}: ImportDiagnosticsOptions = {}): ImportDiagnostics {
  const recent = createRecentPerformance(now, (value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      value.schemaVersion !== 1 ||
      typeof value.event !== 'string' ||
      !/^(http\.request|model\.(request|response|tool)|import\.(active|phase|progress)|process\.resource)(\.[a-z]+)?$/.test(
        value.event,
      ) ||
      !Number.isFinite(Date.parse(value.timestamp)) ||
      !value.context ||
      !value.fields
    )
      return null;
    return {
      schemaVersion: 1,
      sequence: Number.isSafeInteger(value.sequence) ? value.sequence : 0,
      timestamp: value.timestamp,
      monotonicMs: Number.isFinite(value.monotonicMs) ? value.monotonicMs : 0,
      event: value.event,
      context: publicContext(mergedContext(undefined, value.context)),
      fields: safeFields(value.fields),
    };
  });
  const boundedCapacity = boundedInteger(capacity, 10_000, 10, 10_000);
  const boundedResourceInterval = boundedInteger(resourceIntervalMs, 5_000, 250, 60_000);
  const boundedFilesystemInterval = boundedInteger(filesystemIntervalMs, 30_000, 250, 300_000);
  const buffers = new Map<string, ImportDiagnosticEvent[]>();
  const detachedProfiles = new Set<string>();
  let closed = false;
  const dropped = new Map<string, number>();
  const windows = new Map<string, { observedSince: string; observedEvents: number }>();
  const pendingTraceIds = new Map<string, { profileId: string; traceEventId: string }>();
  const consoleSalt = randomBytes(32);
  const activeScopes = new Map<number, ImportDiagnosticContext>();
  let sequence = 0;
  let activeSequence = 0;
  let resourceTimer: NodeJS.Timeout | undefined;
  let previousCpu = process.cpuUsage();
  let previousSampleAt = monotonicNow();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  const consoleScopeId = (profileId: string): string =>
    createHash('sha256')
      .update(consoleSalt)
      .update('profile-scope:')
      .update(profileId)
      .digest('hex')
      .slice(0, 20);

  const traceKey = (event: PrivateTraceEvent, context: ImportDiagnosticContext): string =>
    JSON.stringify([
      event,
      context.profileId || null,
      ...idKeys.map((key) => context[key] || null),
    ]);
  const traceForMetadata = (event: ImportDiagnosticEventName): PrivateTraceEvent | null => {
    if (event === 'model.request.started') return 'model.request';
    if (event === 'model.request.completed' || event === 'model.request.failed')
      return 'model.response';
    if (event === 'model.tool.started') return 'tool.request';
    if (event === 'model.tool.completed' || event === 'model.tool.failed') return 'tool.response';
    return null;
  };
  const takeTraceId = (
    event: ImportDiagnosticEventName,
    context: ImportDiagnosticContext,
  ): string | null => {
    const privateEvent = traceForMetadata(event);
    if (!privateEvent) return null;
    const key = traceKey(privateEvent, context);
    const pending = pendingTraceIds.get(key);
    pendingTraceIds.delete(key);
    return pending?.traceEventId || null;
  };

  const record: ImportDiagnostics['record'] = (event, fields = {}, suppliedContext) => {
    const context = mergedContext(contextStorage.getStore(), suppliedContext);
    if (!suppliedContext?.spanId && context.spanId) {
      context.parentSpanId = context.spanId;
      delete context.spanId;
    }
    if (!context.profileId || closed || detachedProfiles.has(context.profileId)) return;
    const traceEventId = takeTraceId(event, context);
    const buffer = buffers.get(context.profileId) || [];
    const entry: ImportDiagnosticEvent = {
      schemaVersion: 1,
      sequence: ++sequence,
      timestamp: now().toISOString(),
      monotonicMs: Math.max(0, Math.round(monotonicNow() * 1000) / 1000),
      event,
      context: publicContext(context),
      fields: safeFields(fields, traceEventId),
    };
    const window = windows.get(context.profileId) || {
      observedSince: entry.timestamp,
      observedEvents: 0,
    };
    window.observedEvents++;
    windows.set(context.profileId, window);
    try {
      recent.record(context.profileId, entry);
    } catch {
      /* Optional diagnostics. */
    }
    if (!enabled) return;
    buffer.push(entry);
    if (buffer.length > boundedCapacity) {
      dropped.set(
        context.profileId,
        (dropped.get(context.profileId) || 0) + buffer.length - boundedCapacity,
      );
      buffer.splice(0, buffer.length - boundedCapacity);
    }
    buffers.set(context.profileId, buffer);
    try {
      onEvent?.(anonymizeEvent(entry, consoleSalt), consoleScopeId(context.profileId));
    } catch {
      /* Diagnostics cannot fail the import. */
    }
  };

  let capacityPending = false;
  let capacityRequestedAt: number | null = null;
  let capacitySampledAt: number | null = null;
  let filesystemCapacity: {
    runtimeAvailableBytes: number | null;
    tempAvailableBytes: number | null;
  } = {
    runtimeAvailableBytes: null,
    tempAvailableBytes: null,
  };
  const refreshCapacity = () => {
    const at = monotonicNow();
    if (
      closed ||
      !activeScopes.size ||
      capacityPending ||
      (capacityRequestedAt !== null && at - capacityRequestedAt < boundedFilesystemInterval)
    )
      return;
    capacityPending = true;
    capacityRequestedAt = at;
    const read = async (path: string) => {
      try {
        const value = await filesystemAvailableBytes(path);
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
      } catch {
        return null;
      }
    };
    void Promise.all([read(process.env.CRS_RUNTIME_DIR || '/run/health'), read(tmpdir())])
      .then(([runtimeAvailableBytes, tempAvailableBytes]) => {
        if (!closed) {
          filesystemCapacity = { runtimeAvailableBytes, tempAvailableBytes };
          capacitySampledAt = monotonicNow();
        }
      })
      .finally(() => {
        capacityPending = false;
      });
  };

  const sampleResources = (): void => {
    if (!activeScopes.size) return;
    const sampledAt = monotonicNow();
    const cpu = process.cpuUsage(previousCpu);
    const elapsedMicros = Math.max(1, (sampledAt - previousSampleAt) * 1_000);
    previousCpu = process.cpuUsage();
    previousSampleAt = sampledAt;
    const memory = process.memoryUsage();
    const pdf = pdfEvidenceSessionDiagnostics();
    const pdfMemory = pdf.activeSessions ? pdf.lastWorkerMemory : null;
    const activeProfiles = new Set(
      [...activeScopes.values()].map((context) => context.profileId).filter(Boolean),
    ).size;
    refreshCapacity();
    const fields = {
      ...filesystemCapacity,
      filesystemSampleAgeMs:
        capacitySampledAt === null ? null : Math.max(0, sampledAt - capacitySampledAt),
      filesystemSamplePending: capacityPending,
      scope: 'process',
      activeProfiles,
      activeScopes: activeScopes.size,
      cpuPercent: ((cpu.user + cpu.system) / elapsedMicros) * 100,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      pdfWorkerSeparateProcess: true,
      pdfWorkerActive: pdf.activeSessions > 0,
      pdfWorkerRssSampleBytes: pdfMemory?.rss ?? null,
      pdfWorkerMemoryIsLive: false,
      pdfWorkerSampleAgeMs:
        pdfMemory && pdf.lastWorkerSampleAt
          ? Math.max(0, Date.now() - Date.parse(pdf.lastWorkerSampleAt))
          : null,
      eventLoopMeanMs: Number.isFinite(eventLoop.mean) ? eventLoop.mean / 1e6 : 0,
      eventLoopMaxMs: Number.isFinite(eventLoop.max) ? eventLoop.max / 1e6 : 0,
    };
    for (const context of activeScopes.values()) record('process.resource.sample', fields, context);
    eventLoop.reset();
  };

  const startSampling = (): void => {
    if (resourceTimer) return;
    previousCpu = process.cpuUsage();
    previousSampleAt = monotonicNow();
    refreshCapacity();
    eventLoop.enable();
    resourceTimer = setInterval(
      () => contextStorage.exit(sampleResources),
      boundedResourceInterval,
    );
    resourceTimer.unref();
  };
  const stopSampling = (): void => {
    if (!resourceTimer || activeScopes.size) return;
    clearInterval(resourceTimer);
    resourceTimer = undefined;
    eventLoop.disable();
  };

  return {
    enabled,
    run<T>(context: ImportDiagnosticContext, operation: () => T): T {
      return sinkStorage.run(this, () =>
        contextStorage.run(mergedContext(contextStorage.getStore(), context), operation),
      );
    },
    record,
    capturePayload(event, payload, suppliedContext, secrets, options) {
      const context = mergedContext(contextStorage.getStore(), suppliedContext);
      if (!suppliedContext?.spanId && context.spanId) {
        context.parentSpanId = context.spanId;
        delete context.spanId;
      }
      if (
        !context.profileId ||
        !context.importId ||
        closed ||
        detachedProfiles.has(context.profileId)
      )
        return;
      const key = traceKey(event, context);
      pendingTraceIds.delete(key);
      try {
        const traceEventId = privateTrace?.capture(
          context.profileId,
          event,
          publicContext(context) as Record<string, string>,
          payload,
          secrets,
          options,
        );
        if (traceEventId)
          pendingTraceIds.set(key, {
            profileId: context.profileId,
            traceEventId,
          });
      } catch {
        /* Optional diagnostic I/O cannot stop medical record processing. */
      }
    },
    omitPayload(event, omissionReason, suppliedContext) {
      const context = mergedContext(contextStorage.getStore(), suppliedContext);
      if (!suppliedContext?.spanId && context.spanId) {
        context.parentSpanId = context.spanId;
        delete context.spanId;
      }
      if (
        !context.profileId ||
        !context.importId ||
        closed ||
        detachedProfiles.has(context.profileId)
      )
        return;
      pendingTraceIds.delete(traceKey(event, context));
      try {
        privateTrace?.omit(
          context.profileId,
          event,
          publicContext(context) as Record<string, string>,
          omissionReason,
        );
      } catch {
        /* Optional diagnostic I/O cannot stop medical record processing. */
      }
    },
    startActive(profileId, context = {}) {
      const eventContext = mergedContext(contextStorage.getStore(), { ...context, profileId });
      const activeContext = capturedContext(undefined, eventContext);
      const activeId = ++activeSequence;
      let finished = false;
      if (!closed && !detachedProfiles.has(profileId)) {
        activeScopes.set(activeId, activeContext);
        startSampling();
        record('import.active.started', {}, activeContext);
      }
      return {
        record(event, fields = {}, suppliedContext) {
          // Progress may intentionally inherit its current provider turn. Only
          // lifecycle/resource events freeze the scope's complete start context.
          const context =
            contextStorage.getStore()?.profileId === profileId ? eventContext : activeContext;
          record(event, fields, mergedContext(context, suppliedContext));
        },
        finish(fields = {}) {
          if (finished) return;
          finished = true;
          record('import.active.completed', fields, activeContext);
          activeScopes.delete(activeId);
          stopSampling();
        },
      };
    },
    snapshot(profileId) {
      return (buffers.get(profileId) || []).map((event) => ({
        ...event,
        context: { ...event.context },
        fields: { ...event.fields },
      }));
    },
    exportSnapshot(profileId, salt = randomBytes(32)) {
      return {
        schemaVersion: 1,
        generatedAt: now().toISOString(),
        exportId: createId(),
        consoleScopeId: consoleScopeId(profileId),
        events: (buffers.get(profileId) || []).map((event) => anonymizeEvent(event, salt)),
        retainedEvents: buffers.get(profileId)?.length || 0,
        droppedEvents: dropped.get(profileId) || 0,
        eventWindow: {
          recording: enabled ? 'enabled' : 'disabled',
          storage: 'memory_only',
          capacity: boundedCapacity,
          observedEvents: windows.get(profileId)?.observedEvents || 0,
          observedSince: windows.get(profileId)?.observedSince || null,
          notRetainedWhileDisabled: enabled ? 0 : windows.get(profileId)?.observedEvents || 0,
          omittedBeforeWindow: null,
          completeness: 'not_established',
        },
        coverage: 'bounded_metadata_only',
        recentPerformance: (() => {
          const summary = recent.snapshot(profileId);
          const anonymizeId = (value: string, key = 'spanId') =>
            anonymizeEvent(
              {
                schemaVersion: 1,
                sequence: 0,
                timestamp: '',
                monotonicMs: 0,
                event: 'import.progress',
                context: { [key]: value },
                fields: {},
              },
              salt,
            ).context[key as keyof ImportDiagnosticEvent['context']]!;
          return {
            ...summary,
            operations: summary.operations.map((op) => ({
              ...op,
              operationId: anonymizeId(op.operationId, 'operationId'),
              relatedImportIds: op.relatedImportIds.map((id) => anonymizeId(id, 'importId')),
              context: Object.fromEntries(
                Object.entries(op.context).map(([key, value]) => [key, anonymizeId(value, key)]),
              ),
              spans: op.spans.map((span) => ({
                ...span,
                spanId: span.spanId ? anonymizeId(span.spanId) : undefined,
                parentSpanId: span.parentSpanId ? anonymizeId(span.parentSpanId) : undefined,
              })),
            })),
          };
        })(),
        ...(privateTrace ? { privateTrace: privateTrace.status(profileId) } : {}),
      };
    },
    recordClientOperation(profileId, input) {
      if (closed || detachedProfiles.has(profileId)) return false;
      try {
        return recent.client(profileId, input);
      } catch {
        return false;
      }
    },
    attachSummaryStore(profileId, store) {
      detachedProfiles.delete(profileId);
      try {
        recent.attach(profileId, store);
      } catch {}
    },
    detachSummaryStore(profileId) {
      detachedProfiles.add(profileId);
      buffers.delete(profileId);
      dropped.delete(profileId);
      windows.delete(profileId);
      for (const [id, pending] of pendingTraceIds)
        if (pending.profileId === profileId) pendingTraceIds.delete(id);
      for (const [id, context] of activeScopes)
        if (context.profileId === profileId) activeScopes.delete(id);
      stopSampling();
      try {
        recent.detach(profileId);
      } catch {}
    },
    flushSummaries(profileId) {
      try {
        recent.flush(profileId);
      } catch {}
    },
    clear(profileId) {
      detachedProfiles.add(profileId);
      for (const [id, context] of activeScopes)
        if (context.profileId === profileId) activeScopes.delete(id);
      stopSampling();
      try {
        recent.detach(profileId);
      } catch {}
      buffers.delete(profileId);
      dropped.delete(profileId);
      windows.delete(profileId);
      for (const [key, pending] of pendingTraceIds)
        if (pending.profileId === profileId) pendingTraceIds.delete(key);
    },
    close() {
      closed = true;
      try {
        recent.close();
      } catch {}
      if (resourceTimer) clearInterval(resourceTimer);
      resourceTimer = undefined;
      activeScopes.clear();
      eventLoop.disable();
      buffers.clear();
      dropped.clear();
      windows.clear();
      pendingTraceIds.clear();
    },
  };
}

export function recordImportProgress(
  fields: ImportDiagnosticFields = {},
  context: ImportDiagnosticContext = {},
  diagnostics: ImportDiagnosticSink = sinkStorage.getStore() || importDiagnostics,
): void {
  try {
    diagnostics.record('import.progress', fields, context);
  } catch {
    /* Optional diagnostics. */
  }
}

/** Small spans preserve sync application APIs and cannot change operation outcomes. */
export function beginImportPhase(
  phase: string,
  fields: ImportDiagnosticFields = {},
  suppliedContext: ImportDiagnosticContext = {},
  diagnostics: ImportDiagnosticSink = sinkStorage.getStore() || importDiagnostics,
) {
  const inherited = contextStorage.getStore(),
    id = randomUUID();
  const context = capturedContext(inherited, {
    ...suppliedContext,
    parentSpanId: Object.hasOwn(suppliedContext, 'parentSpanId')
      ? suppliedContext.parentSpanId
      : inherited?.spanId,
    spanId: id,
  });
  const started = performance.now();
  let ended = false;
  const emit = (event: ImportDiagnosticEventName, additions: ImportDiagnosticFields = {}) => {
    try {
      diagnostics.record(event, { ...fields, ...additions, phase }, context);
    } catch {
      /* Optional diagnostic sinks must not change outcomes. */
    }
  };
  emit('import.phase.started');
  const end = (event: ImportDiagnosticEventName, additions: ImportDiagnosticFields) => {
    if (ended) return;
    ended = true;
    emit(event, { ...additions, durationMs: Math.max(0, performance.now() - started) });
  };
  return {
    id,
    context,
    run<T>(operation: () => T): T {
      return contextStorage.run(context, operation);
    },
    finish(additions: ImportDiagnosticFields = {}) {
      end('import.phase.completed', additions);
    },
    fail(error: unknown, additions: ImportDiagnosticFields = {}) {
      end('import.phase.failed', { ...additions, ...diagnosticFailureFields(error) });
    },
    cancel(additions: ImportDiagnosticFields = {}) {
      end('import.phase.cancelled', { ...additions, outcome: 'cancelled' });
    },
  };
}
export function measureImportPhase<T>(
  phase: string,
  operation: () => T,
  fields: ImportDiagnosticFields = {},
  context: ImportDiagnosticContext = {},
  diagnostics: ImportDiagnosticSink = sinkStorage.getStore() || importDiagnostics,
): T {
  const span = beginImportPhase(phase, fields, context, diagnostics);
  try {
    const result = span.run(operation);
    if (result instanceof Promise)
      return result.then(
        (value) => {
          span.finish();
          return value;
        },
        (error) => {
          span.fail(error);
          throw error;
        },
      ) as T;
    span.finish();
    return result;
  } catch (error) {
    span.fail(error);
    throw error;
  }
}

export interface PrivateTraceEnvironmentOptions {
  maxTotalBytes?: number;
  maxEntryBytes?: number;
  maxEntries?: number;
  configurationError?: 'invalid_limits';
}

function environmentLimit(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  maximum: number,
): number | null {
  const supplied = env[key];
  if (supplied === undefined) return fallback;
  if (!/^\d+$/.test(supplied)) return null;
  const value = Number(supplied);
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : null;
}

/** Invalid operator caps disable private tracing instead of silently expanding or resetting it. */
export function privateTraceEnvironmentOptions(
  env: NodeJS.ProcessEnv = process.env,
): PrivateTraceEnvironmentOptions {
  const totalMiB = environmentLimit(env, 'CRS_IMPORT_PRIVATE_TRACE_MAX_TOTAL_MIB', 512, 2048);
  const entryMiB = environmentLimit(env, 'CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRY_MIB', 24, 32);
  const entries = environmentLimit(env, 'CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRIES', 8192, 16384);
  if (totalMiB === null || entryMiB === null || entries === null)
    return { configurationError: 'invalid_limits' };
  return {
    maxTotalBytes: totalMiB * MiB,
    maxEntryBytes: entryMiB * MiB,
    maxEntries: entries,
  };
}

function diagnosticsEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.CRS_IMPORT_DIAGNOSTICS === 'true';
}

export const importDiagnostics = createImportDiagnostics({
  enabled: diagnosticsEnabled(process.env),
  onEvent:
    process.env.CRS_IMPORT_DIAGNOSTICS_CONSOLE === 'true'
      ? (event, consoleScopeId) =>
          console.info('[Circus import]', JSON.stringify({ consoleScopeId, event }))
      : undefined,
  privateTrace: createPrivateImportTrace({
    directory: process.env.CRS_IMPORT_PRIVATE_TRACE_DIR,
    grantFile: process.env.CRS_IMPORT_PRIVATE_TRACE_GRANT_FILE,
    acknowledged:
      diagnosticsEnabled(process.env) &&
      process.env.CRS_IMPORT_PRIVATE_TRACE === 'contains-health-data',
    ...privateTraceEnvironmentOptions(process.env),
  }),
});
