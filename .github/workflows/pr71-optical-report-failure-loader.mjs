import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';

const path = resolve('src/tests/browser/import-mapping-shapes.test.ts');
const expected = '734837c015a0421e0726fbc25d95683ad214dcf12a68c56ba60e6f5741255e89';
const hash = (value) => createHash('sha256').update(value).digest('hex');
if (hash(readFileSync(path)) !== expected) throw Error('Optical diagnostic source pin changed');
const one = (source, before, after, label) => {
  if (source.split(before).length !== 2) throw Error(`Optical diagnostic anchor changed: ${label}`);
  return source.replace(before, after);
};

export function transformOpticalReportFailure(source) {
  source = one(source,
    'const opticalDiagnosticReport = (event: string, snapshot: Record<string, unknown>) =>',
    `const opticalReportFailureCategory = (reason: string | undefined) =>
  reason?.includes('ERR_ABORTED')
    ? 'aborted'
    : reason?.includes('ERR_CONNECTION_RESET')
      ? 'connection-reset'
      : reason?.includes('ERR_TIMED_OUT')
        ? 'timed-out'
        : reason?.includes('ERR_FAILED')
          ? 'failed'
          : 'other';

const opticalDiagnosticReport = (event: string, snapshot: Record<string, unknown>) =>`,
    'fixed failure categories');
  source = one(source,
    "  assert.doesNotMatch(output, /\\[Object\\]/);\n});",
    `  assert.doesNotMatch(output, /\\[Object\\]/);
  const target = opticalDiagnosticReport('interrupted', {
    firstAcceptanceReportSamples: [
      {
        queryMatches: true,
        afterAcknowledgement: true,
        startedMs: 10,
        durationMs: 20000,
        outcome: 'failed',
        failureCategory: 'aborted',
      },
    ],
    firstAcceptanceReportOverflow: 0,
  });
  const captured = JSON.parse(target);
  assert.equal(captured.firstAcceptanceReportSamples[0].failureCategory, 'aborted');
  assert.equal(captured.firstAcceptanceReportSamples[0].durationMs, 20000);
  assert.doesNotMatch(target, /private text|intakeId|https?:/);
  assert.equal(opticalReportFailureCategory('net::ERR_ABORTED'), 'aborted');
  assert.equal(opticalReportFailureCategory('net::ERR_CONNECTION_RESET'), 'connection-reset');
  assert.equal(opticalReportFailureCategory('net::ERR_TIMED_OUT'), 'timed-out');
  assert.equal(opticalReportFailureCategory('net::ERR_FAILED'), 'failed');
  assert.equal(opticalReportFailureCategory('private text'), 'other');
});`,
    'pure category assertions');
  source = one(source,
    '    let firstAcceptancePaths: { acceptance: string; report: string } | undefined;',
    '    let firstAcceptancePaths: { acceptance: string; report: string; intakeId: string } | undefined;',
    'exact query owner');
  source = one(source,
    "    const count = (\n",
    `    type ReportSample = {
      queryMatches: boolean;
      afterAcknowledgement: boolean;
      startedMs: number;
      durationMs?: number;
      outcome: 'started' | 'response' | 'finished' | 'failed';
      failureCategory?: string;
    };
    const firstAcceptanceReportSamples: ReportSample[] = [];
    const firstAcceptanceReportTracked = new Map<Request, ReportSample>();
    const firstAcceptanceReportStarted = new Map<Request, number>();
    let firstAcceptanceReportOverflow = 0;
    const reportSample = (request: Request) => firstAcceptanceReportTracked.get(request);
    const updateReportSample = (request: Request, outcome: ReportSample['outcome']) => {
      const sample = reportSample(request);
      if (!sample) return;
      sample.outcome = outcome;
      sample.afterAcknowledgement = afterFirstAcceptanceAcknowledgement(request);
      const started = firstAcceptanceReportStarted.get(request);
      if (started !== undefined) sample.durationMs = Date.now() - started;
    };
    const count = (
`,
    'bounded target request samples');
  source = one(source,
    '      firstAcceptance,\n      // Cumulative transport counts',
    '      firstAcceptance,\n      firstAcceptanceReportSamples,\n      firstAcceptanceReportOverflow,\n      // Cumulative transport counts',
    'snapshot target samples');
  source = one(source,
    "        if (target === 'report') count('reportRequests');\n        browserApiStarted++;",
    `        if (target === 'report') {
          count('reportRequests');
          const queryMatches =
            new URL(request.url()).searchParams.get('intakeId') === firstAcceptancePaths?.intakeId;
          if (queryMatches && firstAcceptanceReportSamples.length < 4) {
            const sample: ReportSample = {
              queryMatches,
              afterAcknowledgement: afterFirstAcceptanceAcknowledgement(request),
              startedMs: Date.now() - phaseStarted,
              outcome: 'started',
            };
            firstAcceptanceReportSamples.push(sample);
            firstAcceptanceReportTracked.set(request, sample);
            firstAcceptanceReportStarted.set(request, Date.now());
          } else if (queryMatches)
            firstAcceptanceReportOverflow = Math.min(firstAcceptanceReportOverflow + 1, 1000);
        }
        browserApiStarted++;`,
    'target request start');
  source = one(source,
    "        if (target === 'report' && afterFirstAcceptanceAcknowledgement(request))\n          count('reportFinishedAfterAcknowledgement');\n        finish(request,",
    "        if (target === 'report' && afterFirstAcceptanceAcknowledgement(request))\n          count('reportFinishedAfterAcknowledgement');\n        if (target === 'report') updateReportSample(request, 'finished');\n        finish(request,",
    'target request completion');
  source = one(source,
    "        if (target === 'report') count('reportFailed');\n        finish(request, 'failed');",
    `        if (target === 'report') {
          count('reportFailed');
          updateReportSample(request, 'failed');
          const sample = reportSample(request);
          if (sample)
            sample.failureCategory = opticalReportFailureCategory(request.failure()?.errorText);
        }
        finish(request, 'failed');`,
    'target request failure');
  source = one(source,
    "        if (target === 'report' && afterFirstAcceptanceAcknowledgement(response.request()))\n          count('reportResponsesAfterAcknowledgement');",
    `        if (target === 'report' && afterFirstAcceptanceAcknowledgement(response.request()))
          count('reportResponsesAfterAcknowledgement');
        if (target === 'report') updateReportSample(response.request(), 'response');`,
    'target response');
  source = one(source,
    "      report: prefix + '/intakes/report-queue/' + encodeURIComponent(queueGroupId),\n    };",
    "      report: prefix + '/intakes/report-queue/' + encodeURIComponent(queueGroupId),\n      intakeId: queueItem.id,\n    };",
    'exact query binding');
  return source;
}

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== 'file://' + path) return loaded;
    const source = String(loaded.source);
    if (hash(source) !== expected) throw Error('Loaded optical source pin changed');
    return { ...loaded, source: transformOpticalReportFailure(source) };
  },
});
