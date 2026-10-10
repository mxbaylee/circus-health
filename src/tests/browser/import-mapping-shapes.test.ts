import {
  fixtureReview,
  fixtureProposalId,
  fixtureReportUrl,
  fixtureSourcePath,
  fixtureBrowserResponse,
  fixtureNativeReportReady,
  fixtureNativeRecordReady,
} from './native-intake-fixture.ts';
import { launchBrowser, newTestPage } from './harness.ts';
import { startProcessRuntime } from './process-runtime.ts';
import { stopFixtureImport } from './manual-import-fixture.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { Browser, ConsoleMessage, Request, Response } from 'playwright';
import type { IntakeReportAcceptanceRequest } from '../../shared/intake.ts';
import type { CollectionReportDetail } from '../../shared/intake-clinical-pages.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const optical = {
  type: 'spectacle',
  prescribedDateText: '03/08/2017',
  eyes: [
    {
      side: 'right',
      sph: { valueText: '+1.75' },
      cyl: { valueText: '-2.50' },
      axis: { valueText: '007' },
    },
    {
      side: 'left',
      sph: { valueText: '-0.50' },
      cyl: { valueText: '-1.25' },
      axis: { valueText: '142' },
    },
  ],
  pd: { valueText: '30.5 / 31.0' },
};
const envelope = (proposed: boolean) => ({
  format: 'health-record-v1',
  id: proposed ? 'fictional-proposed-optical' : 'fictional-top-level-optical',
  kind: 'document',
  subject: 'unknown',
  payload: proposed
    ? { text: 'Fictional Avery Lens 03/08/2017 prescription', opticalPrescription: optical }
    : 'Fictional Avery Lens 03/08/2017 prescription',
  ...(proposed
    ? {
        proposedClinicalMapping: {
          kind: 'document',
          subject: 'unknown',
          documentTitle: 'Fictional proposed prescription',
          date: '03/08/2017',
          documentDate: '03/08/2017',
        },
      }
    : { opticalPrescription: optical }),
  provenance: {
    capturedVia: null,
    sourceSystem: null,
    sourceRecordId: proposed ? 'shape-proposed' : 'shape-top',
    evidenceClass: 'transcription',
    locator: 'Fictional original page 1',
  },
  coverage: { status: 'complete_response', notes: ['One fictional page supplied'] },
  reviewIssues: [
    {
      id: 'identity',
      kind: 'identity',
      field: 'subject',
      prompt: 'Does Fictional Avery Lens refer to you?',
    },
    {
      id: 'date',
      kind: 'date',
      field: 'date',
      prompt: 'Confirm the fictional prescription date',
      textAnchor: '03/08/2017',
      choices: [
        { label: 'March 8, 2017', value: '2017-03-08' },
        { label: 'August 3, 2017', value: '2017-08-03' },
      ],
    },
    {
      id: 'document-date',
      kind: 'date',
      field: 'documentDate',
      prompt: 'Confirm the same document date',
      textAnchor: '03/08/2017',
      choices: [
        { label: 'March 8, 2017', value: '2017-03-08' },
        { label: 'August 3, 2017', value: '2017-08-03' },
      ],
    },
  ],
});

const opticalDiagnosticReport = (event: string, snapshot: Record<string, unknown>) =>
  JSON.stringify({ event, ...snapshot });

const opticalFailureCategory = (reason: string | undefined) =>
  reason?.includes('ERR_ABORTED')
    ? 'aborted'
    : reason?.includes('ERR_CONNECTION_RESET')
      ? 'connection-reset'
      : reason?.includes('ERR_TIMED_OUT')
        ? 'timed-out'
        : reason?.includes('ERR_FAILED')
          ? 'failed'
          : 'other';

const opticalTimingAfterAcknowledgement = (requestStartMs: number, acknowledgedAt?: number) =>
  requestStartMs > 0 && acknowledgedAt !== undefined
    ? requestStartMs >= acknowledgedAt
    : ('unknown' as const);

type ReportSample = {
  observedAfterAcknowledgement: boolean | 'unknown';
  timingAfterAcknowledgement: boolean | 'unknown';
  startedMs: number;
  durationMs?: number;
  outcome: 'started' | 'response' | 'finished' | 'failed';
  failureCategory?: ReturnType<typeof opticalFailureCategory>;
};

function createReportSampleTracker() {
  const samples: ReportSample[] = [];
  const tracked = new Map<object, { sample: ReportSample; started: number }>();
  let overflow = 0;
  return {
    samples,
    get overflow() {
      return overflow;
    },
    start(request: object, now: number, phaseStarted: number, acknowledgementObservedAt?: number) {
      if (samples.length >= 4) {
        overflow = Math.min(overflow + 1, 1000);
        return;
      }
      const sample: ReportSample = {
        observedAfterAcknowledgement:
          acknowledgementObservedAt === undefined ? 'unknown' : now >= acknowledgementObservedAt,
        timingAfterAcknowledgement: 'unknown',
        startedMs: now - phaseStarted,
        outcome: 'started',
      };
      samples.push(sample);
      tracked.set(request, { sample, started: now });
    },
    acknowledged(now: number) {
      for (const entry of tracked.values())
        entry.sample.observedAfterAcknowledgement = entry.started >= now;
    },
    update(
      request: object,
      now: number,
      outcome: ReportSample['outcome'],
      requestStartMs: number,
      acknowledgedAt?: number,
      reason?: string,
    ) {
      const entry = tracked.get(request);
      if (!entry) return;
      entry.sample.outcome = outcome;
      entry.sample.timingAfterAcknowledgement = opticalTimingAfterAcknowledgement(
        requestStartMs,
        acknowledgedAt,
      );
      entry.sample.durationMs = Math.max(0, now - entry.started);
      if (outcome === 'failed') entry.sample.failureCategory = opticalFailureCategory(reason);
    },
  };
}

const opticalReportApiEvent = (line: string) => {
  if (!line.startsWith('[Circus import] ')) return null;
  try {
    const event = JSON.parse(line.slice('[Circus import] '.length));
    if (
      event.method !== 'GET' ||
      event.route !== '/profiles/:profile/intakes/report-queue/:item' ||
      !['api.started', 'api.completed', 'api.failed', 'api.cancelled'].includes(event.event)
    )
      return null;
    return {
      event: event.event as 'api.started' | 'api.completed' | 'api.failed' | 'api.cancelled',
      cancellation: ['caller', 'profile_changed', 'transport'].includes(event.cancellation)
        ? (event.cancellation as 'caller' | 'profile_changed' | 'transport')
        : null,
      status:
        Number.isInteger(event.status) && event.status >= 100 && event.status <= 599
          ? (event.status as number)
          : null,
      durationMs:
        Number.isFinite(event.durationMs) && event.durationMs >= 0
          ? Math.min(Math.round(event.durationMs), 600000)
          : null,
    };
  } catch {
    return null;
  }
};

test('optical diagnostic JSON preserves nested phase and request evidence', () => {
  const snapshot = {
    phase: 'top-level original upload',
    currentAwait: 'first acceptance response',
    phaseDurationMs: 12,
    firstAcceptance: {
      acceptanceRequests: 1,
      acceptanceResponses: 0,
      reportRequests: 0,
      firstSaveMatched: false,
      firstSaveFulfilled: false,
      reportReadFulfilled: false,
    },
    apiTransportAttempts: 2,
    apiTransportSettled: 1,
    inFlight: [{ method: 'POST', path: '/api/profiles/:id/intakes', durationMs: 5 }],
    recentBrowserRequests: [{ method: 'GET', path: '/api/intakes/:id/review', status: 200 }],
  };
  const output = opticalDiagnosticReport('phase-complete', snapshot);
  const reported = JSON.parse(output);
  assert.equal(reported.event, 'phase-complete');
  assert.equal(reported.phaseDurationMs, 12);
  assert.equal(reported.currentAwait, 'first acceptance response');
  assert.equal(reported.firstAcceptance.acceptanceRequests, 1);
  assert.equal(reported.firstAcceptance.firstSaveMatched, false);
  assert.equal(reported.firstAcceptance.firstSaveFulfilled, false);
  assert.equal(reported.firstAcceptance.reportReadFulfilled, false);
  assert.equal(reported.apiTransportAttempts, 2);
  assert.equal(reported.inFlight[0].method, 'POST');
  assert.equal(reported.recentBrowserRequests[0].status, 200);
  assert.doesNotMatch(output, /\[Object\]/);
});

test('optical report diagnostics retain exact failures and redact app cancellation', () => {
  const tracker = createReportSampleTracker();
  const target = {};
  tracker.start(target, 110, 100);
  assert.equal(tracker.samples[0]?.observedAfterAcknowledgement, 'unknown');
  const generalRing = new Map<object, number>([[target, 110]]);
  for (let index = 0; index < 17; index++) {
    if (generalRing.size === 16) generalRing.delete(generalRing.keys().next().value!);
    generalRing.set({}, index);
  }
  assert.equal(generalRing.has(target), false);
  tracker.update(target, 20110, 'failed', 0, 100, 'net::ERR_ABORTED');
  assert.equal(tracker.samples[0]?.observedAfterAcknowledgement, 'unknown');
  tracker.acknowledged(120);
  assert.deepEqual(tracker.samples, [
    {
      observedAfterAcknowledgement: false,
      timingAfterAcknowledgement: 'unknown',
      startedMs: 10,
      durationMs: 20000,
      outcome: 'failed',
      failureCategory: 'aborted',
    },
  ]);
  tracker.start({}, 130, 100, 120);
  assert.equal(tracker.samples[1]?.observedAfterAcknowledgement, true);
  for (let index = 0; index < 1004; index++) tracker.start({}, index, 0, 120);
  assert.equal(tracker.samples.length, 4);
  assert.equal(tracker.overflow, 1000);
  assert.equal(opticalFailureCategory('private error text'), 'other');
  assert.equal(opticalTimingAfterAcknowledgement(0, 100), 'unknown');
  assert.equal(opticalTimingAfterAcknowledgement(120, 100), true);
  assert.equal(opticalFailureCategory('net::ERR_CONNECTION_RESET'), 'connection-reset');
  assert.equal(opticalFailureCategory('net::ERR_TIMED_OUT'), 'timed-out');
  assert.equal(opticalFailureCategory('net::ERR_FAILED'), 'failed');
  const safeEvent = opticalReportApiEvent(
    '[Circus import] ' +
      JSON.stringify({
        event: 'api.cancelled',
        method: 'GET',
        route: '/profiles/:profile/intakes/report-queue/:item',
        cancellation: 'caller',
        durationMs: 15,
        requestId: 'private-id',
      }),
  );
  assert.deepEqual(safeEvent, {
    event: 'api.cancelled',
    cancellation: 'caller',
    status: null,
    durationMs: 15,
  });
  assert.doesNotMatch(JSON.stringify(safeEvent), /private-id/);
  assert.equal(
    opticalReportApiEvent(
      '[Circus import] ' +
        JSON.stringify({
          event: 'api.cancelled',
          method: 'GET',
          route: '/profiles/:profile/intakes/report-queue/:item',
          cancellation: 'private-reason',
        }),
    )?.cancellation,
    null,
  );
});

test(
  'encrypted browser accepts both proposed and top-level optical mappings through grouped identity and date review',
  { timeout: 420000 },
  async (t) => {
    const diagnosticsEnabled = process.env.CRS_TEST_DIAGNOSTICS === '1';
    let phase = 'runtime startup';
    let currentAwait = 'runtime startup';
    let phaseStarted = Date.now();
    let completed = false;
    const root = mkdtempSync(resolve(tmpdir(), 'circus-browser-mapping-shapes-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const inFlight = new Map<number, { method: string; path: string; started: number }>();
    const browserInFlight = new Map<Request, { method: string; path: string; started: number }>();
    const recentBrowserRequests: Array<{
      method: string;
      path: string;
      status: number | 'failed';
      durationMs: number;
    }> = [];
    let requestNumber = 0;
    let apiTransportSettled = 0;
    let apiTransportRejected = 0;
    let browserApiStarted = 0;
    let browserApiFinished = 0;
    let browserApiFailed = 0;
    let evictedApiRequests = 0;
    let evictedBrowserRequests = 0;
    let firstAcceptancePaths: { acceptance: string; report: string; intakeId: string } | undefined;
    let firstAcceptanceAcknowledgedAt: number | undefined;
    let firstAcceptanceAcknowledgedObservedAt: number | undefined;
    let firstAcceptanceAcknowledgedMs: number | undefined;
    const firstAcceptanceReport = createReportSampleTracker();
    const reportRouteApiEvents: Array<NonNullable<ReturnType<typeof opticalReportApiEvent>>> = [];
    let reportRouteApiOverflow = 0;
    const firstAcceptance = {
      acceptanceRequests: 0,
      acceptanceResponses: 0,
      acceptanceFinished: 0,
      acceptanceFailed: 0,
      reportRequests: 0,
      reportResponsesAfterAcknowledgement: 0,
      reportFinishedAfterAcknowledgement: 0,
      reportFailed: 0,
      firstSaveMatched: false,
      firstSaveFulfilled: false,
      reportReadFulfilled: false,
    };
    const count = (
      key:
        | 'acceptanceRequests'
        | 'acceptanceResponses'
        | 'acceptanceFinished'
        | 'acceptanceFailed'
        | 'reportRequests'
        | 'reportResponsesAfterAcknowledgement'
        | 'reportFinishedAfterAcknowledgement'
        | 'reportFailed',
    ) => {
      firstAcceptance[key] = Math.min(firstAcceptance[key] + 1, 1000);
    };
    const firstAcceptanceRoute = (request: Request) => {
      if (phase !== 'guided queue first acceptance' || !firstAcceptancePaths) return undefined;
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && path === firstAcceptancePaths.acceptance)
        return 'acceptance';
      if (request.method() === 'GET' && path === firstAcceptancePaths.report) return 'report';
      return undefined;
    };
    const afterFirstAcceptanceAcknowledgement = (request: Request) =>
      firstAcceptanceAcknowledgedAt !== undefined &&
      request.timing().startTime >= firstAcceptanceAcknowledgedAt;
    const routeSegments = new Set([
      'api',
      'profiles',
      'profile-setups',
      'verify',
      'intakes',
      'sources',
      'content',
      'proposals',
      'review',
      'review-record',
      'review-draft',
      'review-record-action',
      'report-queue',
      'report-acceptance',
      'import-feed',
      'vision-prescriptions',
      'intake-batches',
      'stop',
    ]);
    const diagnosticPath = (path: string) =>
      path
        .split('?')[0]!
        .split('/')
        .map((part) => (part && !routeSegments.has(part) ? ':id' : part))
        .join('/');
    const diagnosticSnapshot = () => ({
      phase,
      currentAwait,
      phaseDurationMs: Date.now() - phaseStarted,
      firstAcceptance,
      firstAcceptanceAcknowledgedMs: firstAcceptanceAcknowledgedMs ?? null,
      firstAcceptanceReportSamples: firstAcceptanceReport.samples,
      firstAcceptanceReportOverflow: firstAcceptanceReport.overflow,
      // These app events cover the redacted report route, not one exact query.
      reportRouteApiEvents,
      reportRouteApiOverflow,
      // Cumulative transport counts are not successful clinical operations.
      apiTransportAttempts: requestNumber,
      apiTransportSettled,
      apiTransportRejected,
      browserApiStarted,
      browserApiFinished,
      browserApiFailed,
      inFlight: [...inFlight.values()].map((request) => ({
        method: request.method,
        path: request.path,
        durationMs: Date.now() - request.started,
      })),
      browserInFlight: [...browserInFlight.values()].map((request) => ({
        method: request.method,
        path: request.path,
        durationMs: Date.now() - request.started,
      })),
      evictedApiRequests,
      evictedBrowserRequests,
      recentBrowserRequests,
    });
    const logDiagnostic = (event: string) => {
      if (diagnosticsEnabled)
        console.error(
          'Fictional optical browser diagnostic',
          opticalDiagnosticReport(event, diagnosticSnapshot()),
        );
    };
    const enterPhase = (name: string) => {
      logDiagnostic('phase-complete');
      phase = name;
      currentAwait = name;
      phaseStarted = Date.now();
      logDiagnostic('phase-start');
    };
    const trackRequest = async <T>(method: string, path: string, run: () => Promise<T>) => {
      if (!diagnosticsEnabled) return run();
      const id = ++requestNumber;
      if (inFlight.size === 16) {
        inFlight.delete(inFlight.keys().next().value!);
        evictedApiRequests++;
      }
      inFlight.set(id, { method, path: diagnosticPath(path), started: Date.now() });
      try {
        return await run();
      } catch (error) {
        apiTransportRejected++;
        throw error;
      } finally {
        apiTransportSettled++;
        inFlight.delete(id);
      }
    };
    const onAbort = () => logDiagnostic('interrupted');
    if (diagnosticsEnabled) t.signal.addEventListener('abort', onAbort, { once: true });
    logDiagnostic('phase-start');
    const runtime = await startProcessRuntime(t, {
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
    });
    let removePageListeners = () => {};
    let browser: Browser | undefined;
    t.after(async () => {
      if (!completed) logDiagnostic('final-phase');
      if (diagnosticsEnabled) t.signal.removeEventListener('abort', onAbort);
      removePageListeners();
      await browser?.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    browser = await launchBrowser(t);
    const page = await newTestPage(browser);
    if (diagnosticsEnabled)
      await page.addInitScript(() => {
        try {
          sessionStorage.setItem('circus:import-debug', '1');
        } catch {
          // Session storage may be unavailable on the initial blank page.
        }
      });
    if (diagnosticsEnabled) {
      const onConsole = (message: ConsoleMessage) => {
        if (phase !== 'guided queue first acceptance' || message.type() !== 'debug') return;
        const event = opticalReportApiEvent(message.text());
        if (!event) return;
        if (reportRouteApiEvents.length < 8) reportRouteApiEvents.push(event);
        else reportRouteApiOverflow = Math.min(reportRouteApiOverflow + 1, 1000);
      };
      page.on('console', onConsole);
      const onRequest = (request: Request) => {
        const path = new URL(request.url()).pathname;
        if (!path.startsWith('/api/')) return;
        const target = firstAcceptanceRoute(request);
        if (target === 'acceptance') count('acceptanceRequests');
        if (target === 'report') {
          count('reportRequests');
          if (
            new URL(request.url()).searchParams.get('intakeId') === firstAcceptancePaths?.intakeId
          )
            firstAcceptanceReport.start(
              request,
              Date.now(),
              phaseStarted,
              firstAcceptanceAcknowledgedObservedAt,
            );
        }
        browserApiStarted++;
        if (browserInFlight.size === 16) {
          browserInFlight.delete(browserInFlight.keys().next().value!);
          evictedBrowserRequests++;
        }
        browserInFlight.set(request, {
          method: request.method(),
          path: diagnosticPath(path),
          started: Date.now(),
        });
      };
      const finish = (request: Request, status: number | 'failed') => {
        if (new URL(request.url()).pathname.startsWith('/api/')) {
          if (status === 'failed') browserApiFailed++;
          else browserApiFinished++;
        }
        const started = browserInFlight.get(request);
        if (!started) return;
        browserInFlight.delete(request);
        recentBrowserRequests.push({
          method: started.method,
          path: started.path,
          status,
          durationMs: Date.now() - started.started,
        });
        if (recentBrowserRequests.length > 8) recentBrowserRequests.shift();
      };
      const onRequestFinished = async (request: Request) => {
        const target = firstAcceptanceRoute(request);
        if (target === 'acceptance') count('acceptanceFinished');
        if (target === 'report' && afterFirstAcceptanceAcknowledgement(request))
          count('reportFinishedAfterAcknowledgement');
        if (target === 'report')
          firstAcceptanceReport.update(
            request,
            Date.now(),
            'finished',
            request.timing().startTime,
            firstAcceptanceAcknowledgedAt,
          );
        finish(request, (await request.response().catch(() => null))?.status() ?? 'failed');
      };
      const onRequestFailed = (request: Request) => {
        const target = firstAcceptanceRoute(request);
        if (target === 'acceptance') count('acceptanceFailed');
        if (target === 'report') {
          count('reportFailed');
          firstAcceptanceReport.update(
            request,
            Date.now(),
            'failed',
            request.timing().startTime,
            firstAcceptanceAcknowledgedAt,
            request.failure()?.errorText,
          );
        }
        finish(request, 'failed');
      };
      const onResponse = (response: Response) => {
        const target = firstAcceptanceRoute(response.request());
        if (target === 'acceptance') count('acceptanceResponses');
        if (target === 'report' && afterFirstAcceptanceAcknowledgement(response.request()))
          count('reportResponsesAfterAcknowledgement');
        if (target === 'report')
          firstAcceptanceReport.update(
            response.request(),
            Date.now(),
            'response',
            response.request().timing().startTime,
            firstAcceptanceAcknowledgedAt,
          );
      };
      page.on('request', onRequest);
      page.on('response', onResponse);
      page.on('requestfinished', onRequestFinished);
      page.on('requestfailed', onRequestFailed);
      removePageListeners = () => {
        page.off('console', onConsole);
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('requestfinished', onRequestFinished);
        page.off('requestfailed', onRequestFailed);
      };
    }
    const url = `http://127.0.0.1:${runtime.port}`;
    enterPhase('encrypted profile setup');
    await page.goto(url);
    const setup = await page.evaluate(async () => {
      const api = async (path: string, body?: unknown) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(await response.text());
        return (await response.json()).data;
      };
      const runtime = await (await fetch('/api/runtime')).json();
      if (!runtime.encrypted) throw Error('Encrypted runtime required');
      const setup = await api('/api/profile-setups', {
        fullName: 'Fictional mapping shapes browser',
        birthDate: '1982-04-17',
        name: 'Fictional mapping shapes browser',
      });
      const profile = await api(`/api/profile-setups/${setup.setupId}/verify`, {
        acknowledged: true,
        recovery: setup.recoveryKit,
      });
      return { profileId: profile.id, recovery: setup.recoveryKit };
    });
    const prefix = `/api/profiles/${setup.profileId}`;
    const api = async (path: string, body?: unknown) => {
      const response = await trackRequest(body === undefined ? 'GET' : 'POST', path, () =>
        body === undefined
          ? page.request.get(url + path)
          : page.request.post(url + path, { headers: { Origin: url }, data: body }),
      );
      const json = await response.json();
      assert(response.ok(), JSON.stringify(json));
      return json.data;
    };
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const screenshots =
      process.env.CRS_TEST_SCREENSHOTS || resolve(tmpdir(), 'circus-import-shapes-visual');
    mkdirSync(screenshots, { recursive: true });
    async function capture(stage: string) {
      for (const theme of ['light', 'dark']) {
        for (const mobile of [false, true]) {
          await page.setViewportSize(
            mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          );
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.colorScheme = theme;
          }, theme);
          await page.evaluate(async () => {
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
          });
          assert(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth + 1,
            ),
            `${stage} ${theme} ${mobile ? 'mobile' : 'desktop'} has no horizontal page overflow`,
          );
          await page.screenshot({
            animations: 'disabled',
            path: resolve(
              screenshots,
              stage + '-' + theme + '-' + (mobile ? 'mobile' : 'desktop') + '.png',
            ),
            fullPage: true,
          });
        }
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    for (const clinical of [false, true]) {
      const shape = clinical ? 'proposed' : 'top-level';
      enterPhase(shape + ' original upload');
      const value = envelope(clinical);
      const uploaded = await trackRequest('POST', prefix + '/intakes', () =>
        page.request.post(url + prefix + '/intakes', {
          headers: {
            Origin: url,
            'Content-Type': 'text/plain',
            'X-Filename': 'fictional-review.txt',
          },
          data: Buffer.from('Fictional retained original ' + clinical),
        }),
      );
      assert.equal(uploaded.status(), 201);
      enterPhase(shape + ' proposal publication');
      let item = await stopFixtureImport(page, url, prefix, (await uploaded.json()).data.id);
      item = await api(`${prefix}/intakes/${encodeURIComponent(item.id)}/proposals`, {
        version: item.version,
        summary: 'Fictional draft regression',
        jsonlText: JSON.stringify(value),
      });
      const path = `${prefix}/intakes/${encodeURIComponent(item.id)}`;
      const proposalId = await fixtureProposalId(api, prefix, item.id);
      const reviewPath = path + '/review?proposalId=' + encodeURIComponent(proposalId);
      enterPhase(shape + ' initial review');
      const originalReview = await fixtureReview(api, reviewPath);
      assert.deepEqual(originalReview.records[0].mapping.opticalPrescription, optical);
      assert.equal(
        originalReview.records[0].issues!.find(
          (issue: { kind: string }) => issue.kind === 'identity',
        )?.status,
        'unresolved',
        'The destination mapping does not replace explicit identity review',
      );
      const reportUrl = await fixtureReportUrl(api, prefix, item.id);
      const groupId = new URLSearchParams(reportUrl.split('?')[1]).get('group')!;
      const reportScope = { intakeId: item.id, groupId };
      const recordScope = {
        intakeId: item.id,
        proposalId,
        recordId: originalReview.records[0].id,
        candidateVersionId: originalReview.records[0].candidateVersionId,
      };
      enterPhase(shape + ' browser record review');
      await page.goto('about:blank');
      await fixtureNativeReportReady(page, prefix, reportScope, () => page.goto(url + reportUrl));
      const exactLinks = page.locator('.import-detail-record-link:not([data-saved-record-id])');
      await exactLinks.first().waitFor();
      assert.equal(await exactLinks.count(), 1, 'The report keeps one exact optical record link');
      await fixtureNativeRecordReady(page, prefix, recordScope, () => exactLinks.first().click());
      // The native report identity remains informational when no printed subject exists.
      await page
        .getByText('Identity is not printed clearly in this report.', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('region', { name: 'Report identity', exact: true }).count(),
        0,
        'missing report identity does not invent a report-level confirmation; the record-level answer remains separate',
      );
      await page.getByRole('button', { name: 'This is me', exact: true }).waitFor();
      assert.equal(await page.getByRole('article').count(), 1);
      await capture(clinical ? 'proposed-review' : 'top-level-review');
      enterPhase(shape + ' identity and date choice');
      assert.equal(await page.getByRole('button', { name: 'This is me', exact: true }).count(), 1);
      await page.getByRole('button', { name: 'This is me', exact: true }).click();
      const choice = page.getByRole('button', { name: 'March 8, 2017', exact: true });
      assert.equal(await choice.count(), 1, 'Related date questions share one decision');
      const choiceSince = Date.now();
      const choiceSaved = fixtureBrowserResponse(
        page,
        (response) =>
          new URL(response.url()).pathname === path + '/review-draft' &&
          response.request().method() === 'POST' &&
          response.request().timing().startTime >= choiceSince &&
          response.request().postDataJSON().recordId === recordScope.recordId &&
          response.request().postDataJSON().candidateVersionId === recordScope.candidateVersionId &&
          response.request().postDataJSON().mapping?.documentDate === '2017-03-08',
      );
      const choiceRead = fixtureBrowserResponse(page, async (response) => {
        const selected = new URL(response.url());
        if (
          selected.pathname !== path + '/review-record' ||
          selected.searchParams.get('recordId') !== recordScope.recordId ||
          response.request().method() !== 'GET' ||
          response.request().timing().startTime < choiceSince
        )
          return false;
        if (!response.ok()) return true;
        const read = (await response.json()).data;
        return (
          read.record.kind === 'record' &&
          read.record.record.candidateVersionId === recordScope.candidateVersionId &&
          read.record.record.mapping.documentDate === '2017-03-08'
        );
      });
      await choice.click();
      const choiceResponse = await choiceSaved;
      assert.equal(choiceResponse.status(), 200, await choiceResponse.text());
      assert.equal(await choiceResponse.finished(), null);
      const refreshedChoice = await choiceRead;
      assert.equal(refreshedChoice.status(), 200, await refreshedChoice.text());
      assert.equal(await refreshedChoice.finished(), null);
      if (clinical) {
        enterPhase('proposed relationship review');
        // Both shape fixtures describe independent retained source occurrences.
        // Review their relationship before accepting the second prescription.
        const related = page.locator('details.intake-related-disclosure');
        const summary = related.locator(':scope > summary');
        await summary.waitFor();
        if (!(await related.evaluate((element) => (element as HTMLDetailsElement).open)))
          await summary.click();
        const paired = page.getByRole('region', { name: 'Paired evidence review' });
        assert.equal(await paired.count(), 1);
        await paired.locator('summary').click();
        await paired
          .getByRole('group', { name: 'Relationship with this record', exact: true })
          .getByRole('combobox')
          .selectOption('distinct');
        const reason =
          'Independent fictional source record identifiers; retain both prescriptions.';
        await paired.getByLabel('Reason for this relationship', { exact: true }).fill(reason);
        const relationshipSaved = fixtureBrowserResponse(
          page,
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === path + '/review-record-action',
        );
        await fixtureNativeRecordReady(page, prefix, recordScope, async () => {
          await paired.getByRole('button', { name: 'Save this relationship', exact: true }).click();
          const response = await relationshipSaved;
          assert.equal(response.status(), 200, await response.text());
          assert.equal(await response.finished(), null);
          const command = response.request().postDataJSON();
          assert.equal(command.recordId, recordScope.recordId);
          assert.equal(command.pair.outcome, 'distinct');
          assert.equal(command.pair.reason, reason);
        });
      }
      enterPhase(shape + ' clinical acceptance');
      const accepted = fixtureBrowserResponse(
        page,
        (response) => response.url().endsWith('/intakes/report-acceptance') && response.ok(),
      );
      await page.getByRole('button', { name: 'Confirm and save record', exact: true }).click();
      const acceptedResponse = await accepted;
      const acceptedResult = (await acceptedResponse.json()).data;
      assert.equal(acceptedResult.receipt.acceptedCount, 1);
      await page
        .getByText('This exact record was saved to your profile.', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Confirm and save record', exact: true }).count(),
        0,
      );
      enterPhase(shape + ' saved evidence and navigation');
      const stored = await fixtureReview(api, reviewPath);
      assert.equal(stored.records[0].mapping.subject, 'self');
      assert.equal(stored.records[0].mapping.date, '2017-03-08');
      assert.equal(stored.records[0].mapping.documentDate, '2017-03-08');
      assert.deepEqual(stored.records[0].mapping.opticalPrescription, optical);
      const prescriptions = await api(prefix + '/vision-prescriptions');
      assert.equal(prescriptions.length, clinical ? 2 : 1);
      await capture(clinical ? 'proposed-saved' : 'top-level-saved');
      const visionRecord = acceptedResult.receipt.receipts
        .flatMap((receipt: { records: { entityId: string; kind: string }[] }) => receipt.records)
        .find((record: { kind: string }) => record.kind === 'document');
      assert(visionRecord, 'The exact acceptance receipt includes the Vision document destination');
      const visionLink = page
        .getByRole('region', { name: 'Saved destination' })
        .getByRole('link')
        .filter({ hasText: visionRecord.title });
      assert.equal(
        await visionLink.getAttribute('href'),
        `#/tests?view=vision&document=${encodeURIComponent(visionRecord.entityId)}&visibility=all`,
      );
      await visionLink.click();
      await page.waitForURL(/view=vision.*document=/);
      await page.getByRole('heading', { name: 'Vision prescription history' }).waitFor();
      await page.getByRole('article').waitFor();
      assert.equal(
        await page.getByRole('article').count(),
        1,
        'Direct link shows the exact accepted document',
      );
      await capture(clinical ? 'proposed-vision' : 'top-level-vision');
      await page.reload();
      await page.getByRole('article').waitFor();
      enterPhase(shape + ' original and proposal reread');
      const originalPath = fixtureSourcePath(prefix, item.contentUrl);
      const original = await trackRequest('GET', originalPath, () =>
        page.request.get(url + originalPath),
      );
      assert.equal(await original.text(), 'Fictional retained original ' + clinical);
      const proposalPath = prefix + '/sources/' + encodeURIComponent(proposalId) + '/content';
      const proposal = await trackRequest('GET', proposalPath, () =>
        page.request.get(url + proposalPath),
      );
      assert.deepEqual(JSON.parse(await proposal.text()), value);
      await page.goto('about:blank');
      await fixtureNativeReportReady(page, prefix, reportScope, () =>
        page.goto(url + '/#/import?intake=' + encodeURIComponent(item.id)),
      );
      const overviewDestination = page.getByRole('region', {
        name: 'Saved destinations for this report',
      });
      await overviewDestination.getByRole('link').waitFor();
      assert.equal(await overviewDestination.getByRole('link').count(), 1);
      await fixtureNativeRecordReady(page, prefix, recordScope, () =>
        page.locator('.import-detail-record-link:not([data-saved-record-id])').first().click(),
      );
      await page
        .getByText('This exact record is already saved to your profile.', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Confirm and save record', exact: true }).count(),
        0,
      );
    }
    // A realistic queue exercises the actual encrypted import/draft operations,
    // rather than accepting every record in a mocked batch response.
    const queueRecords = Array.from({ length: 20 }, (_, index) => ({
      format: 'health-record-v1',
      id: `fictional-guided-${index + 1}`,
      kind: 'record',
      subject: 'self',
      payload: { result: '18', unit: 'ng/mL', heading: 'Fictional twenty-result report' },
      report: {
        key: 'fictional-twenty-result-report',
        title: 'Fictional twenty-result report',
        subject: null,
        anchor: { locator: 'Report heading', text: 'Fictional twenty-result report' },
      },
      clinical: {
        kind: 'observation',
        subject: 'self',
        testLabel: `Fictional queue result ${index + 1}`,
        valueText: '18',
        unit: 'ng/mL',
        date: '2026-09-01',
      },
      provenance: {
        capturedVia: null,
        sourceSystem: 'Fictional Clinic',
        sourceRecordId: `guided-${index + 1}`,
        evidenceClass: 'provider_export',
        locator: `Fictional row ${index + 1}`,
      },
      coverage: { status: 'complete_response', notes: [] },
    }));
    const queueBytes = Buffer.from(
      queueRecords.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    enterPhase('guided queue upload');
    const queued = await trackRequest('POST', prefix + '/intakes', () =>
      page.request.post(url + prefix + '/intakes', {
        headers: {
          Origin: url,
          'Content-Type': 'application/x-ndjson',
          'X-Filename':
            'fictional-twenty-record-review-with-a-long-original-delivery-filename-for-mobile-layout-checks.jsonl',
        },
        data: queueBytes,
      }),
    );
    assert.equal(queued.status(), 201);
    const queueItem = await stopFixtureImport(page, url, prefix, (await queued.json()).data.id);
    const queuePath = `${prefix}/intakes/${encodeURIComponent(queueItem.id)}`;
    enterPhase('guided queue initial review');
    const initialQueue = await fixtureReview(api, queuePath + '/review');
    assert.equal(initialQueue.records.length, 20);
    const queueReportUrl = await fixtureReportUrl(api, prefix, queueItem.id);
    const queueGroupId = new URLSearchParams(queueReportUrl.split('?')[1]).get('group')!;
    firstAcceptancePaths = {
      acceptance: prefix + '/intakes/report-acceptance',
      report: prefix + '/intakes/report-queue/' + encodeURIComponent(queueGroupId),
      intakeId: queueItem.id,
    };
    const queueLinkSelector = '.import-detail-record-link:not([data-saved-record-id])';
    function acknowledgementTime(response: Response) {
      const timing = response.request().timing();
      assert.ok(timing.responseStart >= 0);
      return timing.startTime + timing.responseStart;
    }
    async function reportAfterAcknowledgement(acknowledgedAt: () => number | undefined) {
      const response = await fixtureBrowserResponse(page, (response) => {
        const since = acknowledgedAt();
        const selected = new URL(response.url());
        return (
          since !== undefined &&
          response.request().method() === 'GET' &&
          response.request().timing().startTime >= since &&
          selected.pathname ===
            prefix + '/intakes/report-queue/' + encodeURIComponent(queueGroupId) &&
          selected.searchParams.get('intakeId') === queueItem.id
        );
      });
      assert.equal(response.status(), 200);
      assert.equal(await response.finished(), null);
      const detail = (await response.json()).data as CollectionReportDetail;
      assert.equal(detail.format, 'health-intake-report-detail-v2');
      assert.equal(detail.group.intakeId, queueItem.id);
      assert.equal(detail.group.groupId, queueGroupId);
      return detail;
    }
    async function assertQueuePage(detail: CollectionReportDetail) {
      assert.equal(detail.records.totalRecords, 20, 'The complete report still has twenty records');
      const expectedIds = detail.records.records.map((row) =>
        row.kind === 'record' ? row.record.id : row.selection.recordId,
      );
      await page.waitForFunction(
        ({ selector, expected }) => {
          const ids = Array.from(document.querySelectorAll<HTMLAnchorElement>(selector), (link) =>
            new URLSearchParams(new URL(link.href).hash.split('?')[1]).get('record'),
          );
          return JSON.stringify(ids) === JSON.stringify(expected);
        },
        { selector: queueLinkSelector, expected: expectedIds },
        { timeout: 5000 },
      );
      assert.deepEqual(
        await page
          .locator(queueLinkSelector)
          .evaluateAll((links) =>
            links.map((link) =>
              new URLSearchParams(new URL((link as HTMLAnchorElement).href).hash.split('?')[1]).get(
                'record',
              ),
            ),
          ),
        expectedIds,
        'Every displayed link selects the exact record in this bounded report page',
      );
      return expectedIds;
    }
    async function openQueueRecord(index: number, refreshedReport?: CollectionReportDetail) {
      let firstPage: CollectionReportDetail;
      if (refreshedReport) {
        // The record link came from this report. Browser Back changes the feed
        // scope, so await the actual report read after that native feed refresh.
        const current = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
        assert.equal(current.get('intake'), queueItem.id);
        assert.equal(current.get('group'), queueGroupId);
        assert.equal(current.get('record'), initialQueue.records[index - 1].id);
        firstPage = await fixtureNativeReportReady(
          page,
          prefix,
          { intakeId: queueItem.id, groupId: queueGroupId },
          () => page.goBack(),
        );
        await page.waitForURL(url + queueReportUrl);
        assert.equal(firstPage.records.version, refreshedReport.records.version);
      } else {
        // A fresh document sees API-seeded records through one actual browser read.
        await page.goto('about:blank');
        firstPage = await fixtureNativeReportReady(
          page,
          prefix,
          { intakeId: queueItem.id, groupId: queueGroupId },
          () => page.goto(url + queueReportUrl),
        );
      }
      const firstIds = await assertQueuePage(firstPage);
      if (index === 0) {
        // The byte budget can split this report before the record-count limit.
        // Traverse the real page controls to retain the complete twenty-link oracle.
        const allIds = [...firstIds];
        const cursors = new Set<string>();
        let detail = firstPage;
        while (detail.records.nextCursor) {
          assert.ok(!cursors.has(detail.records.nextCursor), 'Report pagination never loops');
          cursors.add(detail.records.nextCursor);
          detail = await fixtureNativeReportReady(
            page,
            prefix,
            { intakeId: queueItem.id, groupId: queueGroupId },
            () => page.getByRole('button', { name: 'Next report records', exact: true }).click(),
          );
          allIds.push(...(await assertQueuePage(detail)));
        }
        assert.equal(new Set(allIds).size, 20, 'All twenty exact record links appear once');
        assert.deepEqual(
          allIds,
          initialQueue.records.map((record) => record.id),
          'Report pages retain every exact record link in order without gaps or duplicates',
        );
        if (cursors.size) {
          await page.getByRole('button', { name: 'First report records', exact: true }).click();
          await assertQueuePage(firstPage);
        }
      }
      const targetId = initialQueue.records[index].id;
      const targetIndex = firstIds.indexOf(targetId);
      assert.ok(targetIndex >= 0, 'The selected review record is on the first bounded page');
      await fixtureNativeRecordReady(
        page,
        prefix,
        {
          intakeId: queueItem.id,
          proposalId: initialQueue.proposalId,
          recordId: initialQueue.records[index].id,
          candidateVersionId: initialQueue.records[index].candidateVersionId,
        },
        () => page.locator(queueLinkSelector).nth(targetIndex).click(),
      );
      await page.getByRole('region', { name: 'Review actions' }).waitFor();
    }
    enterPhase('guided queue first record and pages');
    await openQueueRecord(0);
    assert.equal(await page.getByRole('article').count(), 1);
    await capture('guided-queue-first');
    const imports: IntakeReportAcceptanceRequest[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url().endsWith(prefix + '/intakes/report-acceptance')
      )
        imports.push(request.postDataJSON());
    });
    let saveAcknowledgedAt: number | undefined;
    const firstSave = fixtureBrowserResponse(page, (response) => {
      if (
        !response.url().endsWith(prefix + '/intakes/report-acceptance') ||
        response.request().method() !== 'POST'
      )
        return false;
      const request = response.request().postDataJSON() as IntakeReportAcceptanceRequest;
      if (
        !request.blocks.some(
          (block) =>
            block.intakeId === queueItem.id &&
            block.selections.some((selection) => selection.recordId === initialQueue.records[0].id),
        )
      )
        return false;
      saveAcknowledgedAt = acknowledgementTime(response);
      firstAcceptanceAcknowledgedAt = saveAcknowledgedAt;
      firstAcceptanceAcknowledgedObservedAt = Date.now();
      firstAcceptanceAcknowledgedMs = firstAcceptanceAcknowledgedObservedAt - phaseStarted;
      firstAcceptanceReport.acknowledged(firstAcceptanceAcknowledgedObservedAt);
      firstAcceptance.firstSaveMatched = true;
      return true;
    }).then((response) => {
      firstAcceptance.firstSaveFulfilled = true;
      return response;
    });
    const savedReportRead = reportAfterAcknowledgement(() => saveAcknowledgedAt).then((detail) => {
      firstAcceptance.reportReadFulfilled = true;
      return detail;
    });
    enterPhase('guided queue first acceptance');
    currentAwait = 'click Confirm and save record';
    await page.getByRole('button', { name: 'Confirm and save record', exact: true }).click();
    currentAwait = 'first acceptance response';
    const savedReceipt = await firstSave;
    assert.equal(savedReceipt.status(), 200);
    currentAwait = 'first acceptance response finished';
    assert.equal(await savedReceipt.finished(), null);
    currentAwait = 'first acceptance response body';
    assert.equal((await savedReceipt.json()).data.receipt.acceptedCount, 1);
    currentAwait = 'post-acknowledgement report read';
    const savedReport = await savedReportRead;
    const savedRow = savedReport.records.records.find(
      (row) =>
        (row.kind === 'record' ? row.record.id : row.selection.recordId) ===
        initialQueue.records[0].id,
    );
    assert.equal(savedRow?.queueState, 'accepted');
    enterPhase('guided queue second record');
    await openQueueRecord(1, savedReport);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].blocks.length, 1);
    assert.equal(imports[0].blocks[0].intakeId, queueItem.id);
    assert.deepEqual(
      imports[0].blocks[0].selections.map((selection) => selection.recordId),
      [initialQueue.records[0].id],
    );
    assert.equal(
      (await fixtureReview(api, queuePath + '/review')).records.filter(
        (record: { reviewState?: string }) => record.reviewState === 'accepted',
      ).length,
      1,
    );
    let deferAcknowledgedAt: number | undefined;
    const deferredSave = fixtureBrowserResponse(page, (response) => {
      if (
        !response.url().endsWith(queuePath + '/review-draft') ||
        response.request().method() !== 'POST'
      )
        return false;
      const request = response.request().postDataJSON();
      if (request.recordId !== initialQueue.records[1].id || request.disposition !== 'review_later')
        return false;
      deferAcknowledgedAt = acknowledgementTime(response);
      return true;
    });
    const deferredReportRead = reportAfterAcknowledgement(() => deferAcknowledgedAt);
    enterPhase('guided queue defer second record');
    await page
      .locator('.intake-guided-actions')
      .getByRole('button', { name: 'Review later', exact: true })
      .click();
    const deferReceipt = await deferredSave;
    assert.equal(deferReceipt.status(), 200);
    assert.equal(await deferReceipt.finished(), null);
    const deferredReport = await deferredReportRead;
    const deferredRow = deferredReport.records.records.find(
      (row) =>
        (row.kind === 'record' ? row.record.id : row.selection.recordId) ===
        initialQueue.records[1].id,
    );
    assert.equal(deferredRow?.queueState, 'deferred');
    enterPhase('guided queue third record');
    await openQueueRecord(2, deferredReport);
    assert.equal(await page.getByRole('article').count(), 1);
    let editAcknowledgedAt: number | undefined;
    const edited = fixtureBrowserResponse(page, (response) => {
      if (
        !response.url().endsWith(queuePath + '/review-draft') ||
        response.request().method() !== 'POST' ||
        response.request().postDataJSON().mapping?.valueText !== '18.5'
      )
        return false;
      editAcknowledgedAt = acknowledgementTime(response);
      return true;
    });
    // Qualify a completed save followed by reload. Observe the actual post-edit
    // selected record, report and feed reads before exercising that reload.
    const editReads = Promise.all(
      [
        queuePath + '/review-record',
        prefix + '/intakes/report-queue/' + encodeURIComponent(queueGroupId),
        prefix + '/intakes/import-feed',
      ].map(async (path) => {
        const response = await fixtureBrowserResponse(
          page,
          (response) =>
            editAcknowledgedAt !== undefined &&
            response.request().method() === 'GET' &&
            response.request().timing().startTime >= editAcknowledgedAt &&
            new URL(response.url()).pathname === path,
        );
        assert.equal(response.status(), 200);
        assert.equal(await response.finished(), null);
        return (await response.json()).data;
      }),
    );
    enterPhase('guided queue edit third record');
    await page.getByLabel('Result', { exact: true }).fill('18.5');
    const editReceipt = await edited;
    assert.equal(editReceipt.status(), 200);
    assert.equal(await editReceipt.finished(), null);
    const [editedRecord, editedReport, editedFeed] = await editReads;
    assert.equal(editedRecord.format, 'health-intake-clinical-record-v2');
    assert.equal(
      editedRecord.record.kind === 'record'
        ? editedRecord.record.record.id
        : editedRecord.record.selection.recordId,
      initialQueue.records[2].id,
    );
    if (editedRecord.record.kind === 'record')
      assert.equal(editedRecord.record.record.draft.mapping.valueText, '18.5');
    assert.equal(editedReport.format, 'health-intake-report-detail-v2');
    assert.equal(editedReport.records.version, editedRecord.context.version);
    assert.equal(editedFeed.format, 'health-intake-import-feed-v2');
    await page.getByRole('tab', { name: 'Details', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert(
      await page
        .getByRole('tab', { name: 'Original', exact: true })
        .evaluate((element) => element === document.activeElement),
    );
    assert(await page.getByRole('tabpanel', { name: 'Original', exact: true }).isVisible());
    assert.equal(
      await page.getByRole('article').count(),
      0,
      'The exact Original tab does not duplicate the record editor',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.getByRole('article').count(),
      0,
      'Mobile switches to the original without showing the record editor',
    );
    await capture('guided-queue-original');
    await page.getByRole('tab', { name: 'Details', exact: true }).click();
    assert.equal(await page.getByRole('article').count(), 1, 'Details restores the exact editor');
    assert.equal(await page.getByLabel('Result', { exact: true }).inputValue(), '18.5');
    enterPhase('guided queue reload and retained evidence');
    await fixtureNativeRecordReady(
      page,
      prefix,
      {
        intakeId: queueItem.id,
        proposalId: initialQueue.proposalId,
        recordId: initialQueue.records[2].id,
        candidateVersionId: initialQueue.records[2].candidateVersionId,
      },
      () => page.reload(),
    );
    assert.equal(await page.getByLabel('Result', { exact: true }).inputValue(), '18.5');
    const resumedQueue = await fixtureReview(api, queuePath + '/review');
    assert.equal(resumedQueue.records[0].reviewState, 'accepted');
    assert.equal(resumedQueue.records[1].draft!.disposition, 'review_later');
    assert.equal(resumedQueue.records[2].draft!.mapping.valueText, '18.5');
    assert.equal(imports.length, 1, 'Reload and draft review never accept more records');
    assert.equal(await page.locator('.import-detail').count(), 1);
    await capture('guided-queue-resumed');
    const queueOriginalPath = fixtureSourcePath(prefix, queueItem.contentUrl);
    const queueOriginal = await trackRequest('GET', queueOriginalPath, () =>
      page.request.get(url + queueOriginalPath),
    );
    assert.deepEqual(await queueOriginal.body(), queueBytes);
    assert.deepEqual(errors, []);
    logDiagnostic('journey-complete');
    completed = true;
  },
);
