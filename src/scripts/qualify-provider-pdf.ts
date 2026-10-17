import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { inventoryArchive, type ArchiveInventory } from './archive-restore-copy.ts';
import { outsideGit } from '../../deploy/run.ts';
import { qualifyDrive } from '../../deploy/qualify-drive.ts';
import { sanitizeBuildIdentity } from '../shared/build-identity.ts';
import type { ImportDiagnosticExport } from '../server/import-diagnostics.ts';
import { isIntakeSummary, type IntakeRead } from '../shared/intake-summary.ts';
import {
  collectQualificationFeed,
  readQualificationReading,
  type QualificationFeedPage,
} from './qualification-intake-read.ts';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import type { SourceTextIssueList } from '../shared/intake-source-text.ts';
import {
  runQualificationBatch,
  summarizeQualificationBatch,
} from './provider-qualification-batch.ts';
import { gradeQualificationDelivery } from './provider-qualification-delivery.ts';
import { performQualificationAcceptance } from './provider-qualification-acceptance.ts';
import { gradeDiagnosticLifecycle } from './provider-diagnostics-qualification.ts';
import {
  createContinuingApprovalQualifier,
  type ContinuingApprovalResult,
} from './provider-qualification-continuing-approval.ts';
import {
  observeQualificationRequestBudget,
  prepareQualificationRequestBudget,
  readQualificationRequestBudget,
  retainQualificationRequestBudget,
  qualificationRequestLimit,
  type QualificationRequestBudget,
} from './provider-qualification-request-budget.ts';
import {
  gradeProviderQualification,
  qualificationPerson,
  qualificationBirthDate,
  writeProviderQualificationPdf,
} from './provider-qualification-fixture.ts';
import {
  finalizeQualificationPrivateTraceReport,
  prepareQualificationPrivateTrace,
  prepareQualificationTraceProfile,
  qualificationPrivateTraceReport,
  qualificationPrivateTraceRequested,
  retainQualificationPrivateTraceStatus,
  revokeQualificationPrivateTraceForReport,
} from './provider-qualification-private-trace.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
/** A continuing-approval run is one scoped experiment, never a comparison matrix. */
export function assertContinuingApprovalMode(args: readonly string[], env: NodeJS.ProcessEnv) {
  if (!args.includes('--continuing-approval')) return false;
  check(
    !args.includes('--deployment'),
    'Choose either continuing approval or deployment qualification.',
  );
  for (const [name, expected] of [
    ['CRS_QUALIFICATION_SCENARIO', 'continuing'],
    ['CRS_QUALIFICATION_REPEAT', '1'],
    ['CRS_QUALIFICATION_FORMAT', 'auto'],
    ['CRS_QUALIFICATION_CACHE', 'configured'],
  ])
    check(
      !env[name!] || env[name!] === expected,
      `Continuing approval requires ${name}=${expected}.`,
    );
  check(
    !env.CRS_QUALIFICATION_ACCEPT && !env.CRS_QUALIFICATION_DIAGNOSTICS,
    'Continuing approval has its own scoped saves; full acceptance and diagnostics qualification must be separate.',
  );
  return true;
}
/** Retain the deliberately unfinished two-unit fixture without certifying full reading. */
export async function captureContinuingReading(
  request: <T>(path: string) => Promise<T>,
  path: string,
  intake: IntakeRead,
  sourceHash: string,
  retain: (page: SourceTextIssueList) => void,
) {
  check(isIntakeSummary(intake), 'Continuing qualification requires a bounded intake summary.');
  const plan = intake.activePlan.state === 'exact' ? intake.activePlan.plan : null;
  check(
    intake.sha256 === sourceHash && plan?.pins.sourceHash === sourceHash && plan.unitCount === 2,
    'Continuing qualification source or two-unit plan changed.',
  );
  const page = await request<SourceTextIssueList>(
    path +
      '/source-issues?' +
      new URLSearchParams({
        readerVersion: String(intake.version),
        readerOffset: '0',
        readerLimit: '50',
      }),
  );
  retain(page);
  check(
    page.sourceHash === sourceHash &&
      page.readerCoverage?.intakeVersion === intake.version &&
      page.readerCoverage.offset === 0 &&
      page.readerCoverage.nextOffset === null &&
      page.readerCoverage.summary.units === 2 &&
      page.readerCoverage.entries.length <= 2,
    'Continuing qualification reading evidence is stale or incomplete.',
  );
  return {
    passed: false as const,
    scope: 'partial_continuing_reading_observation' as const,
    intakeVersion: intake.version,
    sourceHash,
    planId: plan.id,
    unitCount: plan.unitCount,
    responsePages: 1,
    summary: page.readerCoverage.summary,
  };
}
/** Capability checks await inference; only host work gets a harness hang guard. */
export function qualificationRequestSignal(
  operator: AbortSignal,
  modelAwait: boolean,
  hostGuard: () => AbortSignal = () => AbortSignal.timeout(90_000),
) {
  return modelAwait ? operator : AbortSignal.any([operator, hostGuard()]);
}
/** Called only with paths inside the validated external, owner-only attempt. */
export function writeQualificationPrivateJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}
/** All read-only captures share one short deadline, independent of cancellation
 * of the main run. Synchronous artifact failures count like request failures. */
export async function captureQualificationEvidence(
  captures: readonly ((signal: AbortSignal) => Promise<boolean>)[],
  timeoutMs = 10_000,
  signal = AbortSignal.timeout(timeoutMs),
) {
  const outcomes = captures.map(() => false);
  if (signal.aborted) return outcomes;
  let finished = false;
  let onAbort: () => void = () => {};
  const deadline = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const pending = Promise.allSettled(
    captures.map(async (capture, index) => {
      const result = await capture(signal);
      if (!finished && !signal.aborted) outcomes[index] = result === true;
    }),
  );
  try {
    // An uncooperative capture must not keep an exhausted runtime alive.
    await Promise.race([pending, deadline]);
  } finally {
    finished = true;
    signal.removeEventListener('abort', onAbort);
  }
  return outcomes;
}

/** Share only an active capture and its accounting. Completed captures must not
 * hide fresh state from a later run or a later capture in the same run. */
export function shareQualificationEvidence(
  captures: readonly ((signal: AbortSignal) => Promise<boolean>)[],
  retain: (outcomes: readonly boolean[]) => void,
) {
  let pending: Promise<void> | undefined;
  return {
    capture(signal?: AbortSignal): Promise<void> {
      if (pending) return pending;
      // Sharing the entire promise also shares its deadline. An observer that
      // arrives during normal capture cannot start a second evidence window.
      const epoch = captureQualificationEvidence(captures, 10_000, signal)
        .then(retain)
        .finally(() => {
          if (pending === epoch) pending = undefined;
        });
      pending = epoch;
      return epoch;
    },
  };
}

/** Only a verified exhausted admission gate can leave the HTTP server alive for
 * read-only evidence. Other failure reasons do not prove remaining slots closed. */
export async function finishQualificationBudgetFailure(
  snapshot: QualificationRequestBudget | null,
  actions: {
    abort(): void;
    capture(signal?: AbortSignal): Promise<void>;
    stop(): Promise<void>;
  },
  deadline?: AbortSignal,
) {
  actions.abort();
  try {
    if (
      snapshot?.stopReason === 'completion_request_cap_reached' &&
      snapshot.runtimeClaimed &&
      snapshot.limit === qualificationRequestLimit &&
      snapshot.admitted === snapshot.limit
    ) {
      await actions.capture(deadline);
    }
  } finally {
    await actions.stop();
  }
}

export function recordQualificationCleanupFailure(report: {
  passed: boolean;
  failure: string | null;
  cleanupFailure: string | null;
}) {
  report.passed = false;
  report.cleanupFailure = 'Qualification cleanup failed; inspect the isolated Compose project.';
  report.failure ??= report.cleanupFailure;
}

/** A transport may ignore cancellation while returning headers or body bytes.
 * Recheck before publishing cookies, diagnostics, or data to its caller. */
export async function readQualificationResponse<T>(
  response: Response,
  signal: AbortSignal,
  effects: {
    cookie(value: string): void;
    failure?: (status: number, body: string) => void;
  },
): Promise<T> {
  signal.throwIfAborted();
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) effects.cookie(setCookie.split(';')[0] ?? '');
  if (!response.ok && effects.failure) {
    const body = await response.text();
    signal.throwIfAborted();
    effects.failure(response.status, body.slice(0, 32_768));
  }
  check(response.ok, `Qualification HTTP request failed with status ${response.status}.`);
  const result = (await response.json()) as { data: T };
  signal.throwIfAborted();
  return result.data;
}
function externalDirectory(path: string | undefined, label: string) {
  check(path && isAbsolute(path), `${label} must be an existing absolute directory outside Git.`);
  const real = realpathSync(path);
  check(statSync(real).isDirectory(), `${label} must be a directory.`);
  for (let parent = real; ; parent = dirname(parent)) {
    check(!existsSync(join(parent, '.git')), `${label} must be outside Git.`);
    if (dirname(parent) === parent) break;
  }
  return real;
}
interface Connection {
  available: boolean;
  backend: string;
  model: string;
  capabilities: {
    tools: boolean;
    images: boolean | null;
    pdf: boolean | null;
  };
}
interface QualificationRun {
  mode: 'pdf' | 'png';
  repetition: number;
  cache: 'on' | 'off';
  configurationPosition: number;
  withinConfigurationPosition: number;
  cacheTemperature: 'unknown';
  elapsedMs: number;
  connection: Connection;
  grade: ReturnType<typeof gradeProviderQualification>;
  delivery: ReturnType<typeof gradeQualificationDelivery>;
  acceptedObservations: number;
  acceptedClinicalRecords: number;
  acceptedWrites: boolean;
  proposals: number;
  supersededReviewVersions: number;
  extractionComplete: boolean;
  readingAccounting: QualificationFeedPage['activity']['readingAccounting'] | null;
  reading:
    | Awaited<ReturnType<typeof readQualificationReading>>
    | Awaited<ReturnType<typeof captureContinuingReading>>;
  remainingUnits: number | null;
  coordinator: ReturnType<typeof summarizeQualificationBatch>;
  reviewEvidenceFile: string;
  diagnostics: ReturnType<typeof summarizeQualificationDiagnostics>;
  diagnosticQualification: ReturnType<typeof gradeDiagnosticLifecycle> | null;
  acceptance: null | {
    passed: boolean;
    selectedRecords: number;
    receiptReplayed: boolean;
    recoveredWithoutCache: boolean;
    originalUnchanged: boolean;
    acceptedGrade: ReturnType<typeof gradeProviderQualification>;
  };
}

/** Fixed counterbalanced settings, with cold/warm state explicitly unknown.
 * Fresh profiles do not evict a provider's shared cache. */
export function qualificationSchedule(
  paired: boolean,
  configuredCache: 'on' | 'off',
  format: 'both' | 'auto' | 'pdf' | 'png' = 'both',
) {
  const modes: readonly ('pdf' | 'png')[] =
    format === 'both' ? ['pdf', 'png'] : [format === 'auto' ? 'pdf' : format];
  return modes.flatMap((mode) =>
    (paired ? (['off', 'on', 'on', 'off'] as const) : [configuredCache]).map((cache, index) => ({
      mode,
      cache,
      configurationPosition: index + 1,
    })),
  );
}

export function summarizeQualificationCache(
  runs: readonly Pick<QualificationRun, 'mode' | 'cache' | 'elapsedMs' | 'grade' | 'diagnostics'>[],
) {
  return (['pdf', 'png'] as const).map((mode) => ({
    mode,
    causalSavingsEstablished: false,
    conditions: (['off', 'on'] as const).map((cache) => {
      const selected = runs.filter((run) => run.mode === mode && run.cache === cache);
      const values = selected.map((run) => run.elapsedMs).sort((a, b) => a - b);
      const median = values.length
        ? (values[Math.floor((values.length - 1) / 2)] +
            values[Math.ceil((values.length - 1) / 2)]) /
          2
        : null;
      return {
        cache,
        runs: selected.length,
        allOraclePassed: selected.length > 0 && selected.every((run) => run.grade.passed),
        medianElapsedMs: median,
        reportedCachedInputTokens:
          selected.length && selected.every((run) => run.diagnostics.cachedInputTokens !== null)
            ? selected.reduce((sum, run) => sum + run.diagnostics.cachedInputTokens!, 0)
            : null,
      };
    }),
  }));
}

/** The application intentionally tests media separately. Only its retained
 * negative PDF receipt establishes unsupported input; a generic failure cannot.
 */
export async function verifyQualificationConnection(
  mode: 'pdf' | 'png',
  probe: (options: { image: boolean; pdf: boolean }) => Promise<Connection>,
  status: () => Promise<Connection>,
): Promise<Connection> {
  const image = await probe({ image: true, pdf: false });
  check(
    image.available && image.capabilities.tools && image.capabilities.images === true,
    'The selected route did not verify tools and image input.',
  );
  if (mode === 'png') return image;
  try {
    return await probe({ image: false, pdf: true });
  } catch (error) {
    const receipt = await status();
    if (
      receipt.available &&
      receipt.capabilities?.pdf === false &&
      receipt.capabilities.images === true
    )
      return receipt;
    throw error;
  }
}

/** Missing provider usage remains null, and incomplete recorder retention must
 * never be presented as a full-run total or a zero-token result. */
export function summarizeQualificationDiagnostics(
  snapshot: ImportDiagnosticExport,
  afterSequence = 0,
) {
  const events = snapshot.events.filter((event) => event.sequence > afterSequence);
  const completed = events.filter((event) => event.event === 'model.request.completed');
  const failed = events.filter((event) => event.event === 'model.request.failed');
  const started = events.filter((event) => event.event === 'model.request.started');
  const sum = (field: string) =>
    snapshot.droppedEvents === 0 &&
    failed.length === 0 &&
    started.length === completed.length &&
    completed.length > 0 &&
    completed.every((event) => typeof event.fields[field] === 'number')
      ? completed.reduce((total, event) => total + Number(event.fields[field]), 0)
      : null;
  const parts = (field: string) =>
    snapshot.droppedEvents === 0 &&
    started.length > 0 &&
    started.every((event) => typeof event.fields[field] === 'number')
      ? started.reduce((total, event) => total + Number(event.fields[field]), 0)
      : null;
  const reads = events.filter(
    (event) =>
      event.event === 'model.tool.completed' && event.fields.toolName === 'health_intake_read',
  );
  return {
    retainedEvents: events.length,
    droppedEvents: snapshot.droppedEvents,
    startedRequests: started.length,
    completedRequests: completed.length,
    failedRequests: failed.length,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    totalTokens: sum('totalTokens'),
    cachedInputTokens: sum('cachedInputTokens'),
    providerReportedCacheOnly: true,
    providerDurationMs: sum('durationMs'),
    wirePdfParts: parts('pdfParts'),
    wireImageParts: parts('imageParts'),
    generatedPdfPages: [
      ...new Set(
        reads
          .filter((event) => Number(event.fields.pdfBytes) > 0)
          .map((event) => Number(event.fields.page)),
      ),
    ].sort(),
    generatedImagePages: [
      ...new Set(
        reads
          .filter((event) => Number(event.fields.imageBytes) > 0)
          .map((event) => Number(event.fields.page)),
      ),
    ].sort(),
  };
}

async function main() {
  const deployment = process.argv.includes('--deployment');
  const continuing = assertContinuingApprovalMode(process.argv, process.env);
  const privateTraceRequested = qualificationPrivateTraceRequested(continuing, process.env);
  check(
    process.argv.includes('--run') &&
      (deployment
        ? process.env.CRS_DEPLOYMENT_QUALIFICATION === '1'
        : process.env.CRS_PROVIDER_QUALIFICATION === '1'),
    deployment
      ? 'Explicit opt-in required: CRS_DEPLOYMENT_QUALIFICATION=1 npm run qualify:deployment. This uses the configured real provider.'
      : 'Explicit opt-in required: CRS_PROVIDER_QUALIFICATION=1 node src/scripts/qualify-provider-pdf.ts --run. This uses the configured real provider.',
  );
  const outputParent = externalDirectory(
    process.env.CRS_QUALIFICATION_OUTPUT_DIR,
    'CRS_QUALIFICATION_OUTPUT_DIR',
  );
  const state = externalDirectory(process.env.CRS_STATE_DIR, 'CRS_STATE_DIR');
  check(
    process.env.CRS_MODEL &&
      process.env.CRS_LITELLM_CONFIG &&
      isAbsolute(process.env.CRS_LITELLM_CONFIG),
    'Supply CRS_MODEL and absolute CRS_LITELLM_CONFIG for one operator-owned route.',
  );
  check(existsSync(process.env.CRS_LITELLM_CONFIG), 'CRS_LITELLM_CONFIG must exist.');
  const repetitions = !deployment && process.env.CRS_QUALIFICATION_REPEAT === '2' ? 2 : 1;
  check(
    !process.env.CRS_QUALIFICATION_REPEAT ||
      ['1', '2'].includes(process.env.CRS_QUALIFICATION_REPEAT),
    'CRS_QUALIFICATION_REPEAT must be 1 or 2.',
  );
  const scenario = continuing
    ? 'continuing'
    : deployment
      ? 'tiny'
      : (process.env.CRS_QUALIFICATION_SCENARIO ?? 'quick');
  check(
    scenario === 'tiny' ||
      scenario === 'quick' ||
      scenario === 'long' ||
      (continuing && scenario === 'continuing'),
    'CRS_QUALIFICATION_SCENARIO must be tiny, quick or long; continuing requires --continuing-approval.',
  );
  const cacheMode = deployment
    ? 'configured'
    : (process.env.CRS_QUALIFICATION_CACHE ?? 'configured');
  check(
    cacheMode === 'configured' || cacheMode === 'paired',
    'CRS_QUALIFICATION_CACHE must be configured or paired.',
  );
  check(
    !process.env.CRS_PROMPT_CACHE || ['true', 'false'].includes(process.env.CRS_PROMPT_CACHE),
    'CRS_PROMPT_CACHE must be true or false.',
  );
  check(
    !process.env.CRS_QUALIFICATION_ACCEPT || process.env.CRS_QUALIFICATION_ACCEPT === '1',
    'CRS_QUALIFICATION_ACCEPT must be 1 when enabled.',
  );
  const accept = deployment || process.env.CRS_QUALIFICATION_ACCEPT === '1';
  const diagnosticRequested = process.env.CRS_QUALIFICATION_DIAGNOSTICS === '1';
  check(
    !process.env.CRS_QUALIFICATION_DIAGNOSTICS || diagnosticRequested,
    'CRS_QUALIFICATION_DIAGNOSTICS must be 1 when enabled.',
  );
  const format =
    deployment || continuing ? 'auto' : (process.env.CRS_QUALIFICATION_FORMAT ?? 'both');
  if (diagnosticRequested)
    check(
      scenario === 'tiny' &&
        accept &&
        repetitions === 1 &&
        format === 'auto' &&
        cacheMode === 'configured',
      'Diagnostics qualification requires tiny, accept=1, repeat=1, format=auto and configured cache.',
    );
  check(
    format === 'both' || format === 'auto' || format === 'pdf' || format === 'png',
    'CRS_QUALIFICATION_FORMAT must be both, auto, pdf or png.',
  );
  const schedule = qualificationSchedule(
    cacheMode === 'paired',
    process.env.CRS_PROMPT_CACHE === 'true' ? 'on' : 'off',
    format,
  );
  const root = mkdtempSync(join(outputParent, 'provider-qualification-'));
  chmodSync(root, 0o700);
  const data = join(root, 'data');
  outsideGit(data);
  check(
    !state.startsWith(root + '/') && !root.startsWith(state + '/') && root !== state,
    'Qualification output and provider state must be separate.',
  );
  mkdirSync(data, { mode: 0o700 });
  const fixtureFilename = `fictional-${scenario}-qualification.pdf`;
  const fixturePath = join(root, fixtureFilename);
  const fixture = writeProviderQualificationPdf(fixturePath, scenario);
  const privateTrace = privateTraceRequested ? prepareQualificationPrivateTrace(root) : null;
  const requestBudget = continuing
    ? prepareQualificationRequestBudget(root, privateTrace ?? undefined)
    : null;
  const reportPath = join(root, 'qualification.json');
  const project = 'circus-health-' + createHash('sha256').update(data).digest('hex').slice(0, 12);
  const socket = createServer();
  await new Promise<void>((done, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', done);
  });
  const address = socket.address();
  check(address && typeof address === 'object', 'Could not allocate a loopback port.');
  const port = address.port;
  await new Promise<void>((done) => socket.close(() => done()));
  const base = `http://127.0.0.1:${port}`;
  const runs: QualificationRun[] = [];
  const report = {
    schemaVersion: 3,
    independentlyFictional: true,
    route: 'npm start -> Docker Compose -> LiteLLM -> operator-selected real provider',
    fixture,
    runs,
    unavailableFormats: [] as string[],
    applicationImages: {} as Record<string, string>,
    diagnosticFiles: [] as string[],
    diagnosticCaptureFailures: 0,
    cleanupFailure: null as string | null,
    recoveryFiles: [] as string[],
    reviewEvidenceFiles: [] as string[],
    reviewCaptureFailures: 0,
    coordinator: null as ReturnType<typeof summarizeQualificationBatch> | null,
    schedule,
    formatPolicy: format,
    repetitions,
    acceptanceRequested: accept,
    continuingApprovalRequested: continuing,
    continuingApproval: null as ContinuingApprovalResult | null,
    privateTrace: qualificationPrivateTraceReport(privateTraceRequested),
    requestBudget: requestBudget
      ? readQualificationRequestBudget(requestBudget.receipts)
      : (null as QualificationRequestBudget | null),
    deploymentQualificationRequested: deployment,
    deployment: {
      stages: [] as unknown[],
      drive: null as Awaited<ReturnType<typeof qualifyDrive>> | null,
      masterKeyRetained: false,
      providerAuthenticationRetained: false,
      authorityUnchanged: false,
    },
    diagnosticQualificationRequested: diagnosticRequested,
    // Status GETs also flush the encrypted workspace. Leave room in the bounded
    // event log for provider and extraction work throughout a long import.
    statusPollIntervalMs: 5_000,
    conversionDeadlineMs:
      deployment || continuing ? undefined : (scenario === 'long' ? 125 : 16) * 60_000,
    conversionDeadlineInterpretation:
      deployment || continuing
        ? 'No harness model-time deadline. Follow the application coordinator and its progress/terminal outcome; operator cancellation remains available.'
        : 'The long harness wall bound allows the normal two-hour active-work budget plus five minutes for already-admitted work; it does not extend the application budget. Quick mode remains bounded at 16 minutes.',
    manualResumeRequests: 0,
    completionCriterion: continuing
      ? 'Observed approval during real continuing reading, stable approval after unrelated source clarification, exact save and replay, and refusal of the original approval after relevant clarification. Stop remaining reading once this scoped evidence is secured; this is not full-import qualification.'
      : 'One normal Import intake-batches create request, no harness convert or resume requests; the coordinator must finish without paused items or budget extensions and every extraction/delivery oracle must pass.',
    cacheComparison: [] as ReturnType<typeof summarizeQualificationCache>,
    passed: false,
    stage: 'starting',
    stageStartedAt: new Date().toISOString(),
    failure: null as string | null,
    cacheInterpretation:
      'Paired mode uses off/on/on/off per format. Position and repeated-profile number are explicit, but actual cache temperature is unknown: capability probes, earlier formats, cross-profile provider cache, load, routing and time may confound results. No cache eviction is claimed. Provider-reported values stay null when missing; no causal savings claim.',
    scope: continuing
      ? 'One three-page, four-observation fictional original, one profile and route, two source clarifications and two selected saves. No automatic reruns or format/cache matrix; no automatic capture-after-approval claim.'
      : scenario === 'long'
        ? 'One 100-page mixed laboratory, medication-order and performed-imaging fixture; 400 records, alternating text/scanned pages. Autonomous continuation only; not exhaustive chart or clinical quality qualification.'
        : scenario === 'tiny'
          ? 'One page and four independently fictional observations for bounded diagnostics qualification; not representative clinical extraction.'
          : 'One 4-page, 64-row laboratory fixture; this is a quick gate, not representative long-chart qualification.',
  };
  const save = () => {
    if (requestBudget)
      retainQualificationRequestBudget(
        report,
        readQualificationRequestBudget(requestBudget.receipts),
      );
    writeQualificationPrivateJson(reportPath, report);
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let launcher: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let budgetFailure: string | null = null;
  let budgetCleanup: Promise<void> | undefined;
  let stopBudgetObserver: (() => void) | undefined;
  let cookie = '';
  let activeDiagnostics: { prefix: string; filename: string } | null = null;
  let activeReview: {
    prefix: string;
    stem: string;
    originalId: string | null;
    batch: IntakeBatch | null;
    captures: number;
  } | null = null;
  const ownedProfiles = new Set<string>();
  async function stopInstallation() {
    if (!launcher) return;
    if (launcher.pid && launcher.exitCode === null && launcher.signalCode === null) {
      try {
        process.kill(-launcher.pid, 'SIGINT');
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'))
          throw error;
      }
    }
    await Promise.race([
      closed,
      delay(120_000, undefined, { ref: false }).then(() => {
        throw Error('The qualification launcher process did not stop in 120 seconds.');
      }),
    ]);
    launcher = undefined;
    check(
      execFileSync(
        'docker',
        ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
        { encoding: 'utf8' },
      ).trim() === '',
      'The qualification Compose project was not fully removed.',
    );
  }
  function stop() {
    return (stopping ??= (async () => {
      try {
        if (privateTrace && !report.privateTrace.grantRevoked) {
          revokeQualificationPrivateTraceForReport(privateTrace, report.privateTrace);
        }
      } finally {
        await stopInstallation();
      }
    })());
  }
  async function request<T>(
    path: string,
    input?: unknown,
    bytes?: Buffer,
    signal: AbortSignal = controller.signal,
    clientRequestId?: string,
    modelAwait = false,
  ): Promise<T> {
    const requestSignal = qualificationRequestSignal(
      signal,
      (deployment || continuing) && modelAwait,
    );
    requestSignal.throwIfAborted();
    const response = await fetch(base + path, {
      method: input !== undefined || bytes ? 'POST' : 'GET',
      headers: {
        Origin: base,
        Cookie: cookie,
        'Content-Type': bytes ? 'application/pdf' : 'application/json',
        ...(clientRequestId ? { 'X-Client-Request-ID': clientRequestId } : {}),
        ...(bytes
          ? {
              'X-Filename': fixtureFilename,
              'X-Source-Name': 'Fictional Qualification Laboratory',
            }
          : {}),
      },
      ...(bytes
        ? { body: Uint8Array.from(bytes).buffer }
        : input !== undefined
          ? { body: JSON.stringify(input) }
          : {}),
      signal: requestSignal,
    });
    return readQualificationResponse<T>(response, requestSignal, {
      cookie: (value) => {
        cookie = value;
      },
      // Keep local diagnostics only in the protected fictional attempt.
      ...(deployment
        ? {
            failure: (status: number, body: string) => {
              writeQualificationPrivateJson(
                join(root, 'deployment-http-failure-' + randomUUID() + '.json'),
                { path, status, body },
              );
            },
          }
        : {}),
    });
  }
  const reviewFeedClientRequestIds = new Set<string>();
  async function collectFeed(
    prefix: string,
    signal = controller.signal,
    onPage?: (pages: QualificationFeedPage[]) => void,
  ) {
    return collectQualificationFeed(
      async <T>(path: string): Promise<T> => {
        const clientRequestId = diagnosticRequested ? randomUUID() : undefined;
        if (clientRequestId) reviewFeedClientRequestIds.add(clientRequestId);
        return request<T>(path, undefined, undefined, signal, clientRequestId);
      },
      prefix,
      onPage,
    );
  }
  async function retainDiagnostics(signal = AbortSignal.timeout(10_000)) {
    const active = activeDiagnostics;
    if (!active) return true;
    try {
      const snapshot = await request<ImportDiagnosticExport>(
        active.prefix + '/import-diagnostics',
        undefined,
        undefined,
        // After harness cancellation, allow one short read-only diagnostic
        // capture before stack teardown stops any remaining server work.
        signal,
      );
      signal.throwIfAborted();
      retainQualificationPrivateTraceStatus(report.privateTrace, snapshot.privateTrace);
      writeQualificationPrivateJson(join(root, active.filename), snapshot);
      if (!report.diagnosticFiles.includes(active.filename))
        report.diagnosticFiles.push(active.filename);
      return true;
    } catch {
      if (!signal.aborted) retainQualificationPrivateTraceStatus(report.privateTrace, undefined);
      return false;
    }
  }
  function retainReviewFile(filename: string, value: unknown) {
    writeQualificationPrivateJson(join(root, filename), value);
    if (!report.reviewEvidenceFiles.includes(filename)) report.reviewEvidenceFiles.push(filename);
  }
  async function retainReview(signal: AbortSignal) {
    signal.throwIfAborted();
    const active = activeReview;
    if (!active?.originalId) return true;
    const captureStem = `${active.stem}-capture-${++active.captures}`;
    const filename = captureStem + '.json';
    const receipt = {
      capturedAt: new Date().toISOString(),
      partial: true,
      batch: active.batch,
      intake: null as IntakeRead | null,
      pages: [] as QualificationFeedPage[],
      proposalContent: [] as {
        proposalId: string;
        filename: string;
        bytes: number;
        sha256: string;
      }[],
      proposalContentComplete: false,
      proposalContentLimitBytes: 32 * 1024 * 1024,
      failure: null as string | null,
    };
    // The initial/progress receipts already say partial. Do not publish a late
    // result after the shared evidence window has ended and teardown can start.
    const persist = () => {
      if (!signal.aborted) retainReviewFile(filename, receipt);
    };
    persist();
    try {
      if (active.batch) {
        receipt.batch = await request<IntakeBatch>(
          active.prefix + `/intake-batches/${encodeURIComponent(active.batch.id)}`,
          undefined,
          undefined,
          signal,
        );
        signal.throwIfAborted();
        report.coordinator = summarizeQualificationBatch(receipt.batch);
        persist();
      }
      receipt.intake = await request<IntakeRead>(
        active.prefix + `/intakes/${encodeURIComponent(active.originalId)}`,
        undefined,
        undefined,
        signal,
      );
      signal.throwIfAborted();
      persist();
      const collected = await collectFeed(active.prefix, signal, (pages) => {
        signal.throwIfAborted();
        receipt.pages = pages;
        persist();
      });
      signal.throwIfAborted();
      // Preserve returned proposal bytes, not reconstructed expected answers.
      // Reads stay inside this freshly created profile and the shared capture
      // deadline; an interrupted capture is explicitly marked partial.
      let totalBytes = 0;
      const proposalIds = isIntakeSummary(receipt.intake)
        ? [
            ...new Set(
              collected.blocks.map((block) => block.proposalId).filter((id): id is string => !!id),
            ),
          ]
        : receipt.intake.proposals.map((proposal) => proposal.fileId);
      const expectedProposals = isIntakeSummary(receipt.intake)
        ? receipt.intake.collections.proposals.total
        : receipt.intake.proposals.length;
      // Feed membership locates current proposals, not unloaded historical proposal evidence.
      // Preserve the partial flag when the public summary reports additional history.
      check(
        proposalIds.length === expectedProposals,
        'Retained proposal history requires separate inspection.',
      );
      for (const [index, proposalId] of proposalIds.entries()) {
        const response = await fetch(
          base + active.prefix + `/sources/${encodeURIComponent(proposalId)}/content`,
          { headers: { Origin: base, Cookie: cookie }, signal },
        );
        signal.throwIfAborted();
        check(response.ok && response.body, 'Proposal evidence was unavailable.');
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const next = await reader.read();
            signal.throwIfAborted();
            if (next.done) break;
            bytes += next.value.byteLength;
            totalBytes += next.value.byteLength;
            check(
              bytes <= 8 * 1024 * 1024 && totalBytes <= receipt.proposalContentLimitBytes,
              'Proposal evidence exceeded its capture bound.',
            );
            chunks.push(Buffer.from(next.value));
          }
        } finally {
          // A transport ignoring cancellation must not hold teardown open.
          void reader.cancel().catch(() => {});
        }
        const content = Buffer.concat(chunks);
        const proposalFilename = `${captureStem}-proposal-${index + 1}.ndjson`;
        signal.throwIfAborted();
        writeFileSync(join(root, proposalFilename), content, { mode: 0o600 });
        receipt.proposalContent.push({
          proposalId,
          filename: proposalFilename,
          bytes,
          sha256: createHash('sha256').update(content).digest('hex'),
        });
        persist();
      }
      signal.throwIfAborted();
      receipt.proposalContentComplete = true;
      receipt.partial = false;
    } catch {
      receipt.failure =
        'Read-only review capture was incomplete; retained pages and proposal files are partial evidence.';
    } finally {
      persist();
    }
    return !receipt.partial;
  }
  // The observer can fire while normal final evidence is already being read.
  // Both paths share these exact requests and retain their outcomes only once.
  // Each later capture acquires a fresh epoch after the previous one completes.
  const finalEvidence = shareQualificationEvidence(
    [retainDiagnostics, retainReview],
    ([diagnostics, review]) => {
      if (!diagnostics) {
        report.diagnosticCaptureFailures++;
        retainQualificationPrivateTraceStatus(report.privateTrace, undefined);
      }
      if (!review) report.reviewCaptureFailures++;
    },
  );
  async function retainPartialEvidence() {
    // One shared deadline, including after SIGINT/SIGTERM. This is read-only and
    // never resumes work or upgrades a failed qualification verdict. On failure
    // the caller immediately tears down any still-active provider work.
    await finalEvidence.capture();
  }
  async function originalHash(prefix: string, originalId: string) {
    const response = await fetch(
      base + prefix + `/sources/${encodeURIComponent(originalId)}/content`,
      {
        headers: { Origin: base, Cookie: cookie },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
      },
    );
    check(response.ok, 'Qualification could not verify retained original.');
    return createHash('sha256')
      .update(Buffer.from(await response.arrayBuffer()))
      .digest('hex');
  }
  async function runtimeIdentity() {
    const response = await fetch(base + '/api/runtime', {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    check(response.ok, 'Running build identity is unavailable.');
    const runtime = (await response.json()) as { ready: boolean; encrypted: boolean };
    const identity = sanitizeBuildIdentity(runtime);
    check(
      runtime.ready && runtime.encrypted && identity.buildId && identity.revision,
      'Running deployment must expose an encrypted ready build identity.',
    );
    return identity;
  }
  try {
    for (const { mode, cache, configurationPosition } of schedule) {
      const startInstallation = async () => {
        report.stage = `starting_${mode}_${cache}_${configurationPosition}`;
        save();
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !/^(CRS_|HEALTH_|CIRCUS_|CODEX_|LITELLM_|OLLAMA_|DATA_DIR$|AI$|MODEL$|AI_URL$|KEY_FILE$|AUTH_DIR$|ENV_FILE$|STACK$|RUNTIME$|PORT$|IMAGE$|NODE$|STATE_DIR$|RESPONSE_MODEL$|IMAGES$|PDF$|PROMPT_CACHE$)/.test(
                key,
              ),
          ),
        );
        for (const key of [
          'CRS_MODEL',
          'CRS_LITELLM_CONFIG',
          'CRS_LITELLM_ENV_FILE',
          'CRS_RESPONSE_MODEL',
        ])
          if (process.env[key]) env[key] = process.env[key];
        Object.assign(env, {
          CRS_DATA_DIR: data,
          CRS_STATE_DIR: state,
          CRS_PORT: String(port),
          CRS_PUBLIC_ORIGIN: base,
          CRS_PDF: mode === 'pdf' ? 'auto' : 'false',
          CRS_PROMPT_CACHE: cache === 'on' ? 'true' : 'false',
          CRS_IMAGES: 'true',
          CRS_IMPORT_DIAGNOSTICS: 'true',
          ...(requestBudget ? { CRS_QUALIFICATION_REQUEST_OVERRIDE: requestBudget.override } : {}),
        });
        const log = deployment
          ? openSync(join(root, 'deployment-launcher.log'), 'a', 0o600)
          : undefined;
        try {
          launcher = spawn(
            process.execPath,
            [
              ...(requestBudget
                ? ['src/scripts/provider-qualification-launcher.ts']
                : ['deploy/run.ts', 'run']),
            ],
            {
              cwd: repository,
              env,
              detached: true,
              stdio: log === undefined ? 'ignore' : ['ignore', log, log],
            },
          );
        } finally {
          if (log !== undefined) closeSync(log);
        }
        closed = new Promise<void>((done, reject) => {
          launcher!.once('close', () => done());
          launcher!.once('error', reject);
        });
        stopping = undefined;
        if (requestBudget)
          stopBudgetObserver = observeQualificationRequestBudget(
            requestBudget.receipts,
            (snapshot) => {
              budgetFailure = snapshot?.stopReason
                ? `Qualification inconclusive: ${snapshot.stopReason}; the request budget cannot refill or rerun automatically.`
                : 'Qualification inconclusive: request budget receipts could not be read.';
              report.failure = budgetFailure;
              report.passed = false;
              // Admission remains fixed at sixteen. Only a verified cap denial
              // permits one bounded read-only capture before runtime teardown.
              budgetCleanup = finishQualificationBudgetFailure(snapshot, {
                abort: () => controller.abort(),
                capture: finalEvidence.capture,
                stop,
              });
              void budgetCleanup.catch(() => {
                /* The final block awaits this same promise and records cleanup failure. */
              });
            },
          );
        // Build readiness is bounded separately from provider and conversion deadlines.
        const startupDeadline = Date.now() + 15 * 60_000;
        let ready = false;
        while (Date.now() < startupDeadline) {
          controller.signal.throwIfAborted();
          check(
            launcher.exitCode === null && launcher.signalCode === null,
            'Launcher exited before readiness. Inspect the operator configuration locally; output is withheld to avoid exposing provider secrets.',
          );
          try {
            ready = (await fetch(base + '/health/ready', { signal: AbortSignal.timeout(500) })).ok;
          } catch {
            /* Startup still in progress. */
          }
          if (ready) break;
          await delay(500, undefined, { signal: controller.signal });
        }
        check(ready, 'Launcher did not become ready within 15 minutes.');
        if (requestBudget) {
          const snapshot = readQualificationRequestBudget(requestBudget.receipts);
          check(
            snapshot.runtimeClaimed && !snapshot.stopReason,
            'Qualification runtime did not claim its request budget; no model probe may start.',
          );
        }
        const container = execFileSync(
          'docker',
          [
            'ps',
            '-q',
            '--filter',
            `label=com.docker.compose.project=${project}`,
            '--filter',
            'label=com.docker.compose.service=health',
          ],
          { encoding: 'utf8' },
        ).trim();
        check(
          /^[a-f0-9]+$/.test(container),
          'Expected exactly one qualification application container.',
        );
        report.applicationImages[`${mode}_${cache}_${configurationPosition}`] = execFileSync(
          'docker',
          ['inspect', '--format', '{{.Image}}', container],
          { encoding: 'utf8' },
        ).trim();
      };
      await startInstallation();
      const initialImage = report.applicationImages[`${mode}_${cache}_${configurationPosition}`];
      const initialRuntime = deployment ? await runtimeIdentity() : null;
      const masterHash = () =>
        createHash('sha256')
          .update(readFileSync(join(state, 'proxy-key')))
          .digest('hex');
      const initialMasterHash = deployment ? masterHash() : null;
      const configHash = () =>
        createHash('sha256').update(readFileSync(process.env.CRS_LITELLM_CONFIG!)).digest('hex');
      const providerEnvHash = () =>
        process.env.CRS_LITELLM_ENV_FILE
          ? createHash('sha256')
              .update(readFileSync(process.env.CRS_LITELLM_ENV_FILE))
              .digest('hex')
          : null;
      const initialConfigHash = deployment ? configHash() : null;
      const initialProviderEnvHash = deployment ? providerEnvHash() : null;
      if (deployment) {
        const receipts = join(root, 'drive-receipts');
        mkdirSync(receipts, { mode: 0o700 });
        report.deployment.drive = await qualifyDrive({
          CRS_DRIVE_QUALIFICATION: '1',
          CRS_DATA_DIR: data,
          CRS_QUALIFICATION_OUTPUT_DIR: receipts,
          CRS_IMAGE: initialImage,
        });
        save();
      }
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        const stage = (name: string) => {
          report.stage = `${mode}_${cache}_${configurationPosition}_run_${repetition}_${name}`;
          report.stageStartedAt = new Date().toISOString();
          save();
        };
        stage('creating_profile');
        cookie = '';
        const setup = await request<{ setupId: string; recoveryKit: unknown }>(
          '/api/profile-setups',
          {
            name: 'Qualification',
            fullName: qualificationPerson,
            birthDate: qualificationBirthDate,
            placebo: false,
          },
        );
        const recoveryFilename = `recovery-${mode}-${cache}-${configurationPosition}-${repetition}.json`;
        const recovery = {
          independentlyFictional: true,
          setupId: setup.setupId,
          profileId: null as string | null,
          recoveryKit: setup.recoveryKit,
        };
        // Recovery authority is retained only in the protected external attempt,
        // never in stdout, diagnostics, checked-in fixtures or the public report.
        writeQualificationPrivateJson(join(root, recoveryFilename), recovery);
        report.recoveryFiles.push(recoveryFilename);
        stage('verifying_profile');
        const profile = await request<{ id: string }>(
          `/api/profile-setups/${setup.setupId}/verify`,
          { recovery: setup.recoveryKit, acknowledged: true },
        );
        check(
          /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(profile.id),
          'Invalid qualification profile ID.',
        );
        recovery.profileId = profile.id;
        writeQualificationPrivateJson(join(root, recoveryFilename), recovery);
        ownedProfiles.add(profile.id);
        const prefix = `/api/profiles/${profile.id}`;
        activeDiagnostics = {
          prefix,
          filename: `diagnostics-${mode}-${cache}-${configurationPosition}-${repetition}.json`,
        };
        activeReview = {
          prefix,
          stem: `review-${mode}-${cache}-${configurationPosition}-${repetition}`,
          originalId: null,
          batch: null,
          captures: 0,
        };
        report.coordinator = null;
        if (privateTrace) {
          stage('checking_private_trace');
          const readiness = await prepareQualificationTraceProfile(
            privateTrace,
            profile.id,
            ownedProfiles,
            {
              diagnostics: () => request<ImportDiagnosticExport>(prefix + '/import-diagnostics'),
              requestBudget: () => readQualificationRequestBudget(requestBudget!.receipts),
            },
          );
          report.privateTrace.readiness = readiness;
          retainQualificationPrivateTraceStatus(report.privateTrace, readiness.status);
          writeQualificationPrivateJson(join(root, 'private-trace-readiness.json'), readiness);
          save();
        }
        const connection = await verifyQualificationConnection(
          mode,
          (options) => {
            stage(options.pdf ? 'probing_pdf' : 'probing_tools_and_image');
            return request<Connection>(
              prefix + '/assistant/test-connection',
              options,
              undefined,
              controller.signal,
              undefined,
              true,
            );
          },
          () => {
            stage('checking_pdf_receipt');
            return request<Connection>(prefix + '/assistant/status');
          },
        );
        check(
          connection.available &&
            connection.backend === 'litellm' &&
            connection.capabilities.tools &&
            connection.capabilities.images,
          'The selected route did not verify tools and image input.',
        );
        if (mode === 'pdf' && connection.capabilities.pdf !== true) {
          if (!report.unavailableFormats.includes('pdf')) report.unavailableFormats.push('pdf');
          save();
          // Auto qualifies one import with the same verified PNG fallback as
          // normal use. Explicit PDF comparison still requires native support.
          if (format !== 'auto') break;
        }
        stage('reading_initial_diagnostics');
        const before = await request<ImportDiagnosticExport>(prefix + '/import-diagnostics');
        const sequence = Math.max(0, ...before.events.map((event) => event.sequence));
        reviewFeedClientRequestIds.clear();
        const uploadClientRequestId = diagnosticRequested ? randomUUID() : undefined;
        const started = performance.now();
        stage('uploading');
        const uploaded = await request<IntakeRead>(
          prefix + '/intakes',
          undefined,
          readFileSync(fixturePath),
          controller.signal,
          uploadClientRequestId,
        );
        activeReview.originalId = uploaded.id;
        const continuingApproval = continuing
          ? createContinuingApprovalQualifier({
              prefix,
              profileId: profile.id,
              originalId: uploaded.id,
              expectedSha256: fixture.sha256,
              ownedProfiles,
              signal: controller.signal,
              request,
              collectFeed: (value) => collectFeed(value, controller.signal),
              originalHash,
              retain: (name, value) => retainReviewFile(activeReview!.stem + '-' + name, value),
            })
          : null;
        let continuingStopRequested = false;
        stage('starting_batch');
        const coordinator = await runQualificationBatch({
          prefix,
          profileId: profile.id,
          intakeId: uploaded.id,
          timeoutMs: report.conversionDeadlineMs,
          signal: controller.signal,
          request: (path, input, signal) => request(path, input, undefined, signal),
          onSnapshot: async (batch) => {
            activeReview!.batch = batch;
            report.coordinator = summarizeQualificationBatch(batch);
            if (report.stage.endsWith('_starting_batch')) stage('converting_batch');
            else save();
            if (continuingApproval) {
              try {
                await continuingApproval.onSnapshot(batch);
              } finally {
                report.continuingApproval = continuingApproval.result();
                save();
              }
              if (
                !continuingStopRequested &&
                batch.status === 'running' &&
                ['passed', 'failed'].includes(report.continuingApproval.status)
              ) {
                continuingStopRequested = true;
                await request(prefix + `/intake-batches/${encodeURIComponent(batch.id)}/stop`, {});
              }
            }
          },
        });
        if (continuingApproval) report.continuingApproval = continuingApproval.result();
        stage('grading');
        const reviewEvidenceFile = activeReview.stem + '-extracted.json';
        const extracted = {
          capturedAt: new Date().toISOString(),
          purpose: 'Exact review pages used by the extraction oracle before any acceptance.',
          partial: true,
          intake: null as IntakeRead | null,
          pages: [] as QualificationFeedPage[],
          supersededReviewVersions: null as number | null,
          batch: activeReview.batch,
        };
        const collected = await collectFeed(prefix, controller.signal, (pages) => {
          extracted.pages = pages;
          retainReviewFile(reviewEvidenceFile, extracted);
        });
        const records = collected.blocks.flatMap((block) => block.records);
        const feed = collected.feed;
        const detail = await request<IntakeRead>(prefix + `/intakes/${uploaded.id}`);
        extracted.intake = detail;
        retainReviewFile(reviewEvidenceFile, extracted);
        const reading = continuing
          ? await captureContinuingReading(
              request,
              prefix + `/intakes/${uploaded.id}`,
              detail,
              fixture.sha256,
              (page) => retainReviewFile(activeReview!.stem + '-reading-page-1.json', page),
            )
          : await readQualificationReading(
              request,
              prefix + `/intakes/${uploaded.id}`,
              detail,
              fixture.sha256,
              scenario === 'tiny' ? 1 : undefined,
              (page, ordinal) =>
                retainReviewFile(
                  activeReview!.stem + '-reading-page-' + (ordinal + 1) + '.json',
                  page,
                ),
            );
        retainReviewFile(activeReview.stem + '-reading.json', reading);
        extracted.intake = detail;
        extracted.supersededReviewVersions = collected.supersededReviewVersions;
        extracted.partial = false;
        retainReviewFile(reviewEvidenceFile, extracted);
        const overview = await request<{
          counts: { observations: number; medications: number; procedures: number };
        }>(prefix + '/overview');
        const diagnostics = await request<ImportDiagnosticExport & { attribution?: unknown }>(
          prefix + '/import-diagnostics',
        );
        const run: QualificationRun = {
          mode: mode === 'pdf' && connection.capabilities.pdf !== true ? 'png' : mode,
          repetition,
          cache,
          configurationPosition,
          withinConfigurationPosition: repetition,
          cacheTemperature: 'unknown',
          elapsedMs: Math.round(performance.now() - started),
          connection: {
            available: connection.available,
            backend: connection.backend,
            model: connection.model,
            capabilities: connection.capabilities,
          },
          grade: gradeProviderQualification(records, uploaded.id, scenario, 'extracted'),
          delivery: gradeQualificationDelivery(diagnostics.attribution, fixture.pages),
          acceptedObservations: overview.counts.observations,
          acceptedClinicalRecords:
            overview.counts.observations + overview.counts.medications + overview.counts.procedures,
          acceptedWrites: isIntakeSummary(detail)
            ? detail.collections.importHistory.total !== 0
            : detail.imported !== null || detail.acceptedProposalId !== null,
          proposals: isIntakeSummary(detail)
            ? detail.collections.proposals.total
            : detail.proposals.length,
          supersededReviewVersions: collected.supersededReviewVersions,
          extractionComplete: feed.activity.extractionComplete,
          readingAccounting: feed.activity.readingAccounting ?? null,
          reading,
          remainingUnits:
            typeof feed.activity.remainingUnits === 'number'
              ? feed.activity.remainingUnits
              : feed.activity.remainingUnits.value,
          coordinator,
          reviewEvidenceFile,
          diagnostics: summarizeQualificationDiagnostics(diagnostics, sequence),
          diagnosticQualification: null,
          acceptance: null,
        };
        runs.push(run);
        await retainPartialEvidence();
        save();
        if (!continuing)
          check(
            run.acceptedClinicalRecords === 0 && !run.acceptedWrites,
            'Conversion unexpectedly accepted clinical records.',
          );
        if (
          accept &&
          run.coordinator.passed &&
          report.diagnosticCaptureFailures === 0 &&
          report.reviewCaptureFailures === 0 &&
          run.grade.passed &&
          run.delivery.passed &&
          run.reading.passed &&
          run.remainingUnits === 0
        ) {
          let authority: ArchiveInventory | undefined;
          const identityFiles = new WeakMap<object, string>();
          let identitySequence = 0;
          run.acceptance = await performQualificationAcceptance({
            prefix,
            profileId: profile.id,
            recovery: setup.recoveryKit,
            originalId: uploaded.id,
            scenario,
            ownedProfiles,
            dataDirectory: data,
            expectedRecords: fixture.expectedRecords,
            expectedSha256: fixture.sha256,
            request,
            collectFeed,
            originalHash,
            retainIdentityEvidence: (evidence, review) => {
              let filename = identityFiles.get(review);
              if (!filename) {
                filename = activeReview!.stem + '-identity-' + ++identitySequence;
                identityFiles.set(review, filename);
              }
              retainReviewFile(
                filename +
                  '-' +
                  evidence.kind +
                  (evidence.kind === 'page' ? '-' + evidence.ordinal : '') +
                  '.json',
                evidence,
              );
            },
            ...(deployment
              ? {
                  recreate: async (phase: 'accepted' | 'cache_removed') => {
                    stage('recreating_' + phase);
                    await stop();
                    const currentAuthority = await inventoryArchive(
                      join(data, 'profiles', profile.id, 'vault'),
                    );
                    if (authority)
                      check(
                        JSON.stringify(currentAuthority) === JSON.stringify(authority),
                        'Accepted authority changed before cache-loss reconstruction.',
                      );
                    else {
                      check(
                        currentAuthority.files > 0,
                        'Retained accepted authority must be nonempty.',
                      );
                      authority = currentAuthority;
                      writeQualificationPrivateJson(
                        join(root, 'accepted-authority-inventory.json'),
                        authority,
                      );
                    }
                    check(
                      masterHash() === initialMasterHash,
                      'Proxy master key changed before recreation.',
                    );
                    cookie = '';
                    await startInstallation();
                    check(
                      report.applicationImages[`${mode}_${cache}_${configurationPosition}`] ===
                        initialImage,
                      'Recreation used a different application image.',
                    );
                    check(
                      JSON.stringify(await runtimeIdentity()) === JSON.stringify(initialRuntime),
                      'Recreation used a different build identity.',
                    );
                    check(
                      masterHash() === initialMasterHash,
                      'Proxy master key changed during recreation.',
                    );
                    check(
                      configHash() === initialConfigHash &&
                        providerEnvHash() === initialProviderEnvHash,
                      'Adopted provider configuration changed during qualification.',
                    );
                    await request(prefix + '/unlock', { recovery: setup.recoveryKit });
                    const freshConnection = await request<Connection>(
                      prefix + '/assistant/test-connection',
                      { image: false, pdf: false },
                      undefined,
                      controller.signal,
                      undefined,
                      true,
                    );
                    check(
                      freshConnection.available &&
                        freshConnection.backend === connection.backend &&
                        freshConnection.model === connection.model &&
                        freshConnection.capabilities.tools,
                      'Fresh containers could not authenticate the adopted provider tool route.',
                    );
                    const afterAuthority = await inventoryArchive(
                      join(data, 'profiles', profile.id, 'vault'),
                    );
                    check(
                      JSON.stringify(afterAuthority) === JSON.stringify(authority),
                      'Recreation or cache reconstruction changed accepted authority.',
                    );
                    await request(prefix + '/lock', {});
                    report.deployment.stages.push({
                      phase,
                      image: initialImage,
                      build: initialRuntime,
                      masterKeyRetained: true,
                      authenticatedToolRequest: true,
                      connection: {
                        backend: freshConnection.backend,
                        model: freshConnection.model,
                      },
                      providerConfigurationUnchanged: true,
                      acceptedAuthorityUnchanged: true,
                      authority: {
                        files: authority.files,
                        bytes: authority.bytes,
                        treeHash: authority.treeHash,
                      },
                    });
                    save();
                  },
                }
              : {}),
            ...(diagnosticRequested
              ? {
                  afterAcceptedBeforeRecovery: async () => {
                    const afterAcceptance = await request<ImportDiagnosticExport>(
                      prefix + '/import-diagnostics',
                    );
                    const filename = `diagnostics-before-recovery-${mode}-${cache}-${configurationPosition}-${repetition}.json`;
                    writeQualificationPrivateJson(join(root, filename), afterAcceptance);
                    report.diagnosticFiles.push(filename);
                    run.diagnosticQualification = gradeDiagnosticLifecycle(
                      afterAcceptance,
                      sequence,
                      fixture.pages,
                      {
                        uploadClientRequestId: uploadClientRequestId!,
                        reviewFeedClientRequestIds: [...reviewFeedClientRequestIds],
                      },
                    );
                    save();
                  },
                }
              : {}),
          });
          if (deployment) {
            check(
              report.deployment.stages.length === 2,
              'Both recreation and cache-loss stages are required.',
            );
            Object.assign(report.deployment, {
              masterKeyRetained: true,
              providerAuthenticationRetained: true,
              authorityUnchanged: true,
            });
          }
          if (!(await retainDiagnostics())) report.diagnosticCaptureFailures++;
          save();
        }
        process.stdout.write(
          `Qualification ${mode} ${cache} position ${configurationPosition} repetition ${repetition}: ${run.grade.exactRecords}/${run.grade.expectedRecords} exact rows; report written.\n`,
        );
        activeDiagnostics = null;
        activeReview = null;
      }
      await stop();
    }
    report.passed =
      report.diagnosticCaptureFailures === 0 &&
      report.reviewCaptureFailures === 0 &&
      runs.length === repetitions * schedule.length &&
      runs.every(
        (run) =>
          (continuing
            ? report.continuingApproval?.passed === true
            : run.coordinator.passed &&
              run.grade.passed &&
              run.delivery.passed &&
              (!accept || run.acceptance?.passed === true) &&
              run.acceptedClinicalRecords === 0 &&
              !run.acceptedWrites &&
              run.reading.passed &&
              run.remainingUnits === 0) &&
          run.diagnostics.droppedEvents === 0 &&
          (!diagnosticRequested || run.diagnosticQualification?.passed === true) &&
          (run.mode === 'pdf'
            ? (run.diagnostics.wirePdfParts ?? 0) > 0
            : run.diagnostics.wirePdfParts === 0 && (run.diagnostics.wireImageParts ?? 0) > 0),
      );
    report.cacheComparison = summarizeQualificationCache(runs);
    report.stage = 'complete';
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    report.failure =
      budgetFailure ??
      (controller.signal.aborted
        ? 'Qualification cancelled.'
        : error instanceof Error
          ? error.message
          : 'Qualification failed.');
    process.exitCode = 1;
    save();
  } finally {
    // Keep the same run's timeline and page attribution even when extraction
    // pauses or fails; never rerun a chart merely to recover its measurements.
    try {
      try {
        if (!budgetCleanup) await retainPartialEvidence();
      } finally {
        // Recheck after capture: the observer may have taken ownership while
        // that shared capture was pending.
        if (budgetCleanup) await budgetCleanup;
        else await stop();
      }
    } catch {
      recordQualificationCleanupFailure(report);
      process.exitCode = 1;
    }
    stopBudgetObserver?.();
    if (requestBudget) {
      const snapshot = readQualificationRequestBudget(requestBudget.receipts);
      retainQualificationRequestBudget(report, snapshot);
      if (snapshot.stopReason) {
        process.exitCode = 1;
      }
    }
    finalizeQualificationPrivateTraceReport(report.privateTrace);
    if (report.privateTrace.failure) {
      report.passed = false;
      report.failure ??=
        'Qualification inconclusive: protected private trace evidence is unavailable or partial.';
      process.exitCode = 1;
    }
    save();
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    process.stdout.write(`Qualification report: ${reportPath}\n`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => {
    process.stderr.write(
      'Qualification did not finish. Supply explicit opt-in, an existing external output directory, CRS_MODEL, CRS_LITELLM_CONFIG, and CRS_STATE_DIR; inspect any external qualification report for progress.\n',
    );
    process.exitCode = 1;
  });
}
