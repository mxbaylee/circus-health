import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";

const server = resolve("src/server/intake-queue-native.ts");
const child = resolve("src/tests/browser/runtime-child.ts");
const test = resolve("src/tests/browser/import-mapping-shapes.test.ts");
const pins = new Map([
  [server, "ffdaf46dd5440d7397ff1dce93c58cedba1ea6f63e3386670c0fbaa11a7888b1"],
  [child, "b3fa8071311084696e4ae1d80719467f29ebbdb44866df08c1d3ca0c5d6b04d7"],
  [test, "734837c015a0421e0726fbc25d95683ad214dcf12a68c56ba60e6f5741255e89"],
]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
for (const [path, pin] of pins)
  if (hash(readFileSync(path)) !== pin)
    throw Error(`Report phase source pin changed: ${path}`);
const one = (source, before, after, label) => {
  if (source.split(before).length !== 2)
    throw Error(`Report phase anchor changed: ${label}`);
  return source.replace(before, after);
};

export function transformServer(source) {
  const before = `export async function getIntakeReportQueueGroupRead(
  db: DatabaseSync,
  root: string,
  profileId: string,
  groupId: string,
  input: QueueInput = {},
) {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      if (!hasNativeIntakeQueue(db, profileId))
        return getIntakeReportQueueGroup(db, root, profileId, groupId, input);
      await prepareCollectionQueueRead(db, root, profileId);
      return readCollectionReportGroupDetail(db, root, profileId, groupId, nativeWindow(input));
    },
    { operation: currentClinicalOperation(db) },
  );
}`;
  const after = `type OpticalReportPhase = {
  stage: 'requested' | 'admitted' | 'prepared' | 'completed' | 'failed';
  started: number;
  admitted?: number;
  prepared?: number;
  detailDone?: number;
  ended?: number;
  native?: boolean;
};
const opticalReportPhases: OpticalReportPhase[] = [];
let opticalReportCalls = 0;
let opticalReportCompleted = 0;
let opticalReportFailed = 0;
if (process.env.CRS_OPTICAL_REPORT_PHASE_DIAGNOSTIC === '1')
  Reflect.set(globalThis, Symbol.for('crs.opticalReportPhaseSnapshot'), () => ({
    calls: Math.min(opticalReportCalls, 1000),
    completed: Math.min(opticalReportCompleted, 1000),
    failed: Math.min(opticalReportFailed, 1000),
    recent: opticalReportPhases.map((phase) => ({
      stage: phase.stage,
      native: phase.native ?? null,
      laneWaitMs: phase.admitted === undefined ? null : Math.round(phase.admitted - phase.started),
      queuePrepareMs: phase.prepared === undefined || phase.admitted === undefined
        ? null : Math.round(phase.prepared - phase.admitted),
      detailReadMs: phase.detailDone === undefined || phase.prepared === undefined
        ? null : Math.round(phase.detailDone - phase.prepared),
      elapsedMs: Math.round((phase.ended ?? performance.now()) - phase.started),
    })),
  }));
export async function getIntakeReportQueueGroupRead(
  db: DatabaseSync,
  root: string,
  profileId: string,
  groupId: string,
  input: QueueInput = {},
) {
  const enabled = process.env.CRS_OPTICAL_REPORT_PHASE_DIAGNOSTIC === '1';
  const phase: OpticalReportPhase = { stage: 'requested', started: performance.now() };
  if (enabled) {
    opticalReportCalls++;
    opticalReportPhases.push(phase);
    if (opticalReportPhases.length > 4) opticalReportPhases.shift();
  }
  try {
    const result = await runExclusiveClinicalOperation(
      db,
      async () => {
        if (enabled) {
          phase.stage = 'admitted';
          phase.admitted = performance.now();
        }
        const native = hasNativeIntakeQueue(db, profileId);
        if (enabled) phase.native = native;
        if (!native) {
          if (enabled) {
            phase.stage = 'prepared';
            phase.prepared = performance.now();
          }
          const detail = await getIntakeReportQueueGroup(db, root, profileId, groupId, input);
          if (enabled) phase.detailDone = performance.now();
          return detail;
        }
        await prepareCollectionQueueRead(db, root, profileId);
        if (enabled) {
          phase.stage = 'prepared';
          phase.prepared = performance.now();
        }
        const detail = await readCollectionReportGroupDetail(
          db, root, profileId, groupId, nativeWindow(input),
        );
        if (enabled) phase.detailDone = performance.now();
        return detail;
      },
      { operation: currentClinicalOperation(db) },
    );
    if (enabled) {
      phase.stage = 'completed';
      phase.ended = performance.now();
      opticalReportCompleted++;
    }
    return result;
  } catch (error) {
    if (enabled) {
      phase.stage = 'failed';
      phase.ended = performance.now();
      opticalReportFailed++;
    }
    throw error;
  }
}`;
  return one(source, before, after, "group report read");
}

export function transformChild(source) {
  return one(
    source,
    `    process.stderr.write('\\u001ecrs-browser-diagnostics:' + message.id + '\\u001f');`,
    `    const reportSnapshot = Reflect.get(globalThis, Symbol.for('crs.opticalReportPhaseSnapshot'));
    if (typeof reportSnapshot === 'function')
      process.stderr.write('Fictional report-read phase: ' + JSON.stringify(reportSnapshot()) + '\\n');
    process.stderr.write('\\u001ecrs-browser-diagnostics:' + message.id + '\\u001f');`,
    "diagnostic IPC snapshot",
  );
}

export function transformTest(source) {
  source = one(
    source,
    `const opticalDiagnosticReport = (event: string, snapshot: Record<string, unknown>) =>`,
    `const captureOpticalReportPhase = async (
  checkpointFactory: () => () => Promise<{ status: string; diagnostics: string; truncated: boolean }>,
  emit: (...parts: string[]) => void,
) => {
  try {
    const checkpoint = checkpointFactory();
    const capture = await checkpoint();
    const line = capture.diagnostics.split('\\n').filter((entry) =>
      entry.startsWith('Fictional report-read phase: '),
    ).at(-1);
    emit('Fictional report-read phase capture', capture.status,
      capture.truncated ? 'truncated' : 'complete');
    if (line) emit(line);
  } catch {
    emit('Fictional report-read phase capture', 'failed');
  }
};

const opticalReportApiEvent = (line: string) => {
  if (!line.startsWith('[Circus import] ')) return null;
  try {
    const event = JSON.parse(line.slice('[Circus import] '.length));
    if (event.method !== 'GET' ||
      event.route !== '/profiles/:profile/intakes/report-queue/:item' ||
      !['api.started', 'api.completed', 'api.failed', 'api.cancelled'].includes(event.event))
      return null;
    return {
      event: event.event as 'api.started' | 'api.completed' | 'api.failed' | 'api.cancelled',
      cancellation: ['caller', 'profile_changed', 'transport'].includes(event.cancellation)
        ? event.cancellation as 'caller' | 'profile_changed' | 'transport' : null,
      status: Number.isInteger(event.status) && event.status >= 100 && event.status <= 599
        ? event.status as number : null,
      durationMs: Number.isFinite(event.durationMs) && event.durationMs >= 0
        ? Math.min(Math.round(event.durationMs), 600000) : null,
    };
  } catch {
    return null;
  }
};

const opticalDiagnosticReport = (event: string, snapshot: Record<string, unknown>) =>`,
    "checkpoint capture helper",
  );
  source = one(
    source,
    `test(
  'encrypted browser accepts both proposed and top-level optical mappings through grouped identity and date review',`,
    `test('optical report phase capture uses the child checkpoint', async () => {
  const emitted: string[][] = [];
  await captureOpticalReportPhase(
    () => async () => ({ status: 'captured', truncated: false,
      diagnostics: 'Fictional report-read phase: {"calls":0}\\nFictional report-read phase: {"calls":1}\\n' }),
    (...parts) => emitted.push(parts),
  );
  assert.deepEqual(emitted, [
    ['Fictional report-read phase capture', 'captured', 'complete'],
    ['Fictional report-read phase: {"calls":1}'],
  ]);
  const safeApi = opticalReportApiEvent('[Circus import] ' + JSON.stringify({
    event: 'api.cancelled', method: 'GET',
    route: '/profiles/:profile/intakes/report-queue/:item',
    cancellation: 'caller', requestId: 'private-id', durationMs: 15,
  }));
  assert.deepEqual(safeApi, {
    event: 'api.cancelled', cancellation: 'caller', status: null, durationMs: 15,
  });
  assert.doesNotMatch(JSON.stringify(safeApi), /private-id/);
});

test(
  'encrypted browser accepts both proposed and top-level optical mappings through grouped identity and date review',`,
    "two-stage checkpoint pure case",
  );
  source = one(
    source,
    `    let requestNumber = 0;`,
    `    const reportRouteApiEvents: Array<NonNullable<ReturnType<typeof opticalReportApiEvent>>> = [];
    let reportRouteApiOverflow = 0;
    let requestNumber = 0;`,
    "bounded app API diagnostic events",
  );
  source = one(
    source,
    `      firstAcceptanceReportOverflow,
      // Cumulative transport counts`,
    `      firstAcceptanceReportOverflow,
      reportRouteApiEvents,
      reportRouteApiOverflow,
      // Cumulative transport counts`,
    "app API diagnostic snapshot",
  );
  source = one(
    source,
    `      logDiagnostic('phase-complete');
      phase = name;`,
    `      logDiagnostic('phase-complete');
      if (phase === 'guided queue first acceptance') captureReportPhase();
      phase = name;`,
    "successful first acceptance phase",
  );
  source = one(
    source,
    `    browser = await launchBrowser(t);
    const page = await newTestPage(browser);`,
    `    browser = await launchBrowser(t);
    const page = await newTestPage(browser);
    if (diagnosticsEnabled)
      await page.addInitScript(() => {
        try { sessionStorage.setItem('circus:import-debug', '1'); } catch { /* unavailable */ }
      });`,
    "test-only app diagnostic opt-in",
  );
  source = one(
    source,
    `    if (diagnosticsEnabled) {
      const onRequest = (request: Request) => {`,
    `    if (diagnosticsEnabled) {
      const onConsole = (message: import('playwright').ConsoleMessage) => {
        if (phase !== 'guided queue first acceptance' || message.type() !== 'debug') return;
        const event = opticalReportApiEvent(message.text());
        if (!event) return;
        if (reportRouteApiEvents.length < 8) reportRouteApiEvents.push(event);
        else reportRouteApiOverflow = Math.min(reportRouteApiOverflow + 1, 1000);
      };
      page.on('console', onConsole);
      const onRequest = (request: Request) => {`,
    "redacted report route console observer",
  );
  source = one(
    source,
    `      removePageListeners = () => {
        page.off('request', onRequest);`,
    `      removePageListeners = () => {
        page.off('console', onConsole);
        page.off('request', onRequest);`,
    "console observer cleanup",
  );
  source = one(
    source,
    `    const onAbort = () => logDiagnostic('interrupted');`,
    `    let reportPhaseCaptures = 0;
    const captureReportPhase = () => {
      if (++reportPhaseCaptures > 4) return;
      void captureOpticalReportPhase(() => runtime.captureDiagnostics(), (...parts) =>
        console.error(...parts),
      );
    };
    const onAbort = () => logDiagnostic('interrupted');`,
    "passive capture",
  );
  return one(
    source,
    `          if (sample)
            sample.failureCategory = opticalReportFailureCategory(request.failure()?.errorText);`,
    `          if (sample) {
            sample.failureCategory = opticalReportFailureCategory(request.failure()?.errorText);
            if (sample.queryMatches) captureReportPhase();
          }`,
    "exact target failure capture",
  );
}

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const path = url.startsWith("file://") ? new URL(url).pathname : undefined;
    if (!path || !pins.has(path)) return loaded;
    const source = String(loaded.source);
    if (path !== test && hash(source) !== pins.get(path))
      throw Error(`Loaded report phase source pin changed: ${path}`);
    return {
      ...loaded,
      source:
        path === server
          ? transformServer(source)
          : path === child
            ? transformChild(source)
            : transformTest(source),
    };
  },
});
