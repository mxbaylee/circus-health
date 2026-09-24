import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ImportDiagnosticExport } from '../server/import-diagnostics.ts';
import type { Intake, IntakeImportFeed } from '../shared/intake.ts';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import {
  runQualificationBatch,
  summarizeQualificationBatch,
} from './provider-qualification-batch.ts';
import { gradeQualificationDelivery } from './provider-qualification-delivery.ts';
import { performQualificationAcceptance } from './provider-qualification-acceptance.ts';
import {
  gradeProviderQualification,
  qualificationPerson,
  qualificationBirthDate,
  writeProviderQualificationPdf,
} from './provider-qualification-fixture.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
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
) {
  const signal = AbortSignal.timeout(timeoutMs);
  const results = await Promise.allSettled(
    captures.map((capture) => Promise.resolve().then(() => capture(signal))),
  );
  return results.map((result) => result.status === 'fulfilled' && result.value);
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
  remainingUnits: number;
  coordinator: ReturnType<typeof summarizeQualificationBatch>;
  reviewEvidenceFile: string;
  diagnostics: ReturnType<typeof summarizeQualificationDiagnostics>;
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
  check(
    process.argv.includes('--run') && process.env.HEALTH_PROVIDER_QUALIFICATION === '1',
    'Explicit opt-in required: HEALTH_PROVIDER_QUALIFICATION=1 node scripts/qualify-provider-pdf.ts --run. This uses the configured real provider.',
  );
  const outputParent = externalDirectory(
    process.env.HEALTH_QUALIFICATION_OUTPUT_DIR,
    'HEALTH_QUALIFICATION_OUTPUT_DIR',
  );
  const state = externalDirectory(process.env.STATE_DIR, 'STATE_DIR');
  check(
    process.env.MODEL && process.env.LITELLM_CONFIG && isAbsolute(process.env.LITELLM_CONFIG),
    'Supply MODEL and absolute LITELLM_CONFIG for one operator-owned route.',
  );
  check(existsSync(process.env.LITELLM_CONFIG), 'LITELLM_CONFIG must exist.');
  const repetitions = process.env.HEALTH_QUALIFICATION_REPEAT === '2' ? 2 : 1;
  check(
    !process.env.HEALTH_QUALIFICATION_REPEAT ||
      ['1', '2'].includes(process.env.HEALTH_QUALIFICATION_REPEAT),
    'HEALTH_QUALIFICATION_REPEAT must be 1 or 2.',
  );
  const scenario = process.env.HEALTH_QUALIFICATION_SCENARIO ?? 'quick';
  check(
    scenario === 'quick' || scenario === 'long',
    'HEALTH_QUALIFICATION_SCENARIO must be quick or long.',
  );
  const cacheMode = process.env.HEALTH_QUALIFICATION_CACHE ?? 'configured';
  check(
    cacheMode === 'configured' || cacheMode === 'paired',
    'HEALTH_QUALIFICATION_CACHE must be configured or paired.',
  );
  check(
    !process.env.PROMPT_CACHE || ['true', 'false'].includes(process.env.PROMPT_CACHE),
    'PROMPT_CACHE must be true or false.',
  );
  check(
    !process.env.HEALTH_QUALIFICATION_ACCEPT || process.env.HEALTH_QUALIFICATION_ACCEPT === '1',
    'HEALTH_QUALIFICATION_ACCEPT must be 1 when enabled.',
  );
  const accept = process.env.HEALTH_QUALIFICATION_ACCEPT === '1';
  const format = process.env.HEALTH_QUALIFICATION_FORMAT ?? 'both';
  check(
    format === 'both' || format === 'auto' || format === 'pdf' || format === 'png',
    'HEALTH_QUALIFICATION_FORMAT must be both, auto, pdf or png.',
  );
  const schedule = qualificationSchedule(
    cacheMode === 'paired',
    process.env.PROMPT_CACHE === 'true' ? 'on' : 'off',
    format,
  );
  const root = mkdtempSync(join(outputParent, 'provider-qualification-'));
  chmodSync(root, 0o700);
  const data = join(root, 'data');
  mkdirSync(data, { mode: 0o700 });
  const fixtureFilename = `fictional-${scenario}-qualification.pdf`;
  const fixturePath = join(root, fixtureFilename);
  const fixture = writeProviderQualificationPdf(fixturePath, scenario);
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
    recoveryFiles: [] as string[],
    reviewEvidenceFiles: [] as string[],
    reviewCaptureFailures: 0,
    coordinator: null as ReturnType<typeof summarizeQualificationBatch> | null,
    schedule,
    formatPolicy: format,
    repetitions,
    acceptanceRequested: accept,
    // Status GETs also flush the encrypted workspace. Leave room in the bounded
    // event log for provider and extraction work throughout a long import.
    statusPollIntervalMs: 5_000,
    conversionDeadlineMs: (scenario === 'long' ? 125 : 16) * 60_000,
    conversionDeadlineInterpretation:
      'The long harness wall bound allows the normal two-hour active-work budget plus five minutes for already-admitted work; it does not extend the application budget. Quick mode remains bounded at 16 minutes.',
    manualResumeRequests: 0,
    completionCriterion:
      'One normal Import intake-batches create request, no harness convert or resume requests; the coordinator must finish without paused items or budget extensions and every extraction/delivery oracle must pass.',
    cacheComparison: [] as ReturnType<typeof summarizeQualificationCache>,
    passed: false,
    stage: 'starting',
    stageStartedAt: new Date().toISOString(),
    failure: null as string | null,
    cacheInterpretation:
      'Paired mode uses off/on/on/off per format. Position and repeated-profile number are explicit, but actual cache temperature is unknown: capability probes, earlier formats, cross-profile provider cache, load, routing and time may confound results. No cache eviction is claimed. Provider-reported values stay null when missing; no causal savings claim.',
    scope:
      scenario === 'long'
        ? 'One 100-page mixed laboratory, medication-order and performed-imaging fixture; 400 records, alternating text/scanned pages. Autonomous continuation only; not exhaustive chart or clinical quality qualification.'
        : 'One 4-page, 64-row laboratory fixture; this is a quick gate, not representative long-chart qualification.',
  };
  const save = () => writeQualificationPrivateJson(reportPath, report);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let launcher: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
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
  async function stop() {
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
  async function request<T>(
    path: string,
    input?: unknown,
    bytes?: Buffer,
    signal: AbortSignal = controller.signal,
  ): Promise<T> {
    const response = await fetch(base + path, {
      method: input !== undefined || bytes ? 'POST' : 'GET',
      headers: {
        Origin: base,
        Cookie: cookie,
        'Content-Type': bytes ? 'application/pdf' : 'application/json',
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
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0] ?? '';
    // Never include error bodies, model content or credentials in command output.
    check(response.ok, `Qualification HTTP request failed with status ${response.status}.`);
    return ((await response.json()) as { data: T }).data;
  }
  async function collectFeed(
    prefix: string,
    signal = controller.signal,
    onPage?: (pages: IntakeImportFeed[]) => void,
  ) {
    const blocks: IntakeImportFeed['blocks'] = [];
    const pages: IntakeImportFeed[] = [];
    let feed: IntakeImportFeed;
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      feed = await request<IntakeImportFeed>(
        prefix +
          '/intakes/import-feed?view=all&limit=100' +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
        undefined,
        undefined,
        signal,
      );
      blocks.push(...feed.blocks);
      pages.push(feed);
      onPage?.(pages);
      cursor = feed.nextCursor;
      check(
        blocks.reduce((sum, block) => sum + block.records.length, 0) <= 1000,
        'Review exceeded the qualification bound.',
      );
      if (cursor) {
        check(!seen.has(cursor), 'Qualification pagination did not advance.');
        seen.add(cursor);
      }
    } while (cursor);
    return {
      blocks: blocks.map((block) => ({
        ...block,
        records: block.records.filter((record) => record.queueState !== 'superseded'),
      })),
      supersededReviewVersions: blocks.reduce(
        (sum, block) =>
          sum + block.records.filter((record) => record.queueState === 'superseded').length,
        0,
      ),
      feed,
      pages,
    };
  }
  async function retainDiagnostics(signal = AbortSignal.timeout(10_000)) {
    if (!activeDiagnostics) return true;
    try {
      const snapshot = await request<ImportDiagnosticExport>(
        activeDiagnostics.prefix + '/import-diagnostics',
        undefined,
        undefined,
        // After harness cancellation, allow one short read-only diagnostic
        // capture before stack teardown stops any remaining server work.
        signal,
      );
      writeQualificationPrivateJson(join(root, activeDiagnostics.filename), snapshot);
      if (!report.diagnosticFiles.includes(activeDiagnostics.filename))
        report.diagnosticFiles.push(activeDiagnostics.filename);
      return true;
    } catch {
      return false;
    }
  }
  function retainReviewFile(filename: string, value: unknown) {
    writeQualificationPrivateJson(join(root, filename), value);
    if (!report.reviewEvidenceFiles.includes(filename)) report.reviewEvidenceFiles.push(filename);
  }
  async function retainReview(signal: AbortSignal) {
    const active = activeReview;
    if (!active?.originalId) return true;
    const captureStem = `${active.stem}-capture-${++active.captures}`;
    const filename = captureStem + '.json';
    const receipt = {
      capturedAt: new Date().toISOString(),
      partial: true,
      batch: active.batch,
      intake: null as Intake | null,
      pages: [] as IntakeImportFeed[],
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
    const persist = () => retainReviewFile(filename, receipt);
    persist();
    try {
      if (active.batch) {
        receipt.batch = await request<IntakeBatch>(
          active.prefix + `/intake-batches/${encodeURIComponent(active.batch.id)}`,
          undefined,
          undefined,
          signal,
        );
        report.coordinator = summarizeQualificationBatch(receipt.batch);
        persist();
      }
      receipt.intake = await request<Intake>(
        active.prefix + `/intakes/${encodeURIComponent(active.originalId)}`,
        undefined,
        undefined,
        signal,
      );
      persist();
      await collectFeed(active.prefix, signal, (pages) => {
        receipt.pages = pages;
        persist();
      });
      // Preserve returned proposal bytes, not reconstructed expected answers.
      // Reads stay inside this freshly created profile and the shared capture
      // deadline; an interrupted capture is explicitly marked partial.
      let totalBytes = 0;
      for (const [index, proposal] of receipt.intake.proposals.entries()) {
        const response = await fetch(
          base + active.prefix + `/sources/${encodeURIComponent(proposal.fileId)}/content`,
          { headers: { Origin: base, Cookie: cookie }, signal },
        );
        check(response.ok && response.body, 'Proposal evidence was unavailable.');
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const next = await reader.read();
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
          await reader.cancel().catch(() => {});
        }
        const content = Buffer.concat(chunks);
        const proposalFilename = `${captureStem}-proposal-${index + 1}.ndjson`;
        writeFileSync(join(root, proposalFilename), content, { mode: 0o600 });
        receipt.proposalContent.push({
          proposalId: proposal.id,
          filename: proposalFilename,
          bytes,
          sha256: createHash('sha256').update(content).digest('hex'),
        });
        persist();
      }
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
  async function retainPartialEvidence() {
    // One shared deadline, including after SIGINT/SIGTERM. This is read-only and
    // never resumes work or upgrades a failed qualification verdict. On failure
    // the caller immediately tears down any still-active provider work.
    const [diagnostics, review] = await captureQualificationEvidence([
      retainDiagnostics,
      retainReview,
    ]);
    if (!diagnostics) report.diagnosticCaptureFailures++;
    if (!review) report.reviewCaptureFailures++;
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
  try {
    for (const { mode, cache, configurationPosition } of schedule) {
      report.stage = `starting_${mode}_${cache}_${configurationPosition}`;
      save();
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !/^(HEALTH_|CODEX_|LITELLM_|OLLAMA_|DATA_DIR$|AI$|MODEL$|AI_URL$|KEY_FILE$|AUTH_DIR$|ENV_FILE$|STACK$|RUNTIME$|PORT$|IMAGE$|NODE$|STATE_DIR$|RESPONSE_MODEL$|IMAGES$|PDF$|PROMPT_CACHE$)/.test(
              key,
            ),
        ),
      );
      for (const key of ['MODEL', 'LITELLM_CONFIG', 'LITELLM_ENV_FILE', 'RESPONSE_MODEL'])
        if (process.env[key]) env[key] = process.env[key];
      Object.assign(env, {
        DATA_DIR: data,
        STATE_DIR: state,
        PORT: String(port),
        HEALTH_PUBLIC_ORIGIN: base,
        PDF: mode === 'pdf' ? 'auto' : 'false',
        PROMPT_CACHE: cache === 'on' ? 'true' : 'false',
        IMAGES: 'true',
        HEALTH_IMPORT_DIAGNOSTICS: 'true',
      });
      launcher = spawn(process.execPath, ['deploy/run.ts', 'run'], {
        cwd: repository,
        env,
        detached: true,
        stdio: 'ignore',
      });
      closed = new Promise<void>((done, reject) => {
        launcher!.once('close', () => done());
        launcher!.once('error', reject);
      });
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
        const connection = await verifyQualificationConnection(
          mode,
          (options) => {
            stage(options.pdf ? 'probing_pdf' : 'probing_tools_and_image');
            return request<Connection>(prefix + '/assistant/test-connection', options);
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
        const started = performance.now();
        stage('uploading');
        const uploaded = await request<Intake>(
          prefix + '/intakes',
          undefined,
          readFileSync(fixturePath),
        );
        activeReview.originalId = uploaded.id;
        stage('starting_batch');
        const coordinator = await runQualificationBatch({
          prefix,
          profileId: profile.id,
          intakeId: uploaded.id,
          timeoutMs: report.conversionDeadlineMs,
          signal: controller.signal,
          request: (path, input, signal) => request(path, input, undefined, signal),
          onSnapshot: (batch) => {
            activeReview!.batch = batch;
            report.coordinator = summarizeQualificationBatch(batch);
            if (report.stage.endsWith('_starting_batch')) stage('converting_batch');
            else save();
          },
        });
        stage('grading');
        const reviewEvidenceFile = activeReview.stem + '-extracted.json';
        const extracted = {
          capturedAt: new Date().toISOString(),
          purpose: 'Exact review pages used by the extraction oracle before any acceptance.',
          partial: true,
          intake: null as Intake | null,
          pages: [] as IntakeImportFeed[],
          supersededReviewVersions: null as number | null,
          batch: activeReview.batch,
        };
        const collected = await collectFeed(prefix, controller.signal, (pages) => {
          extracted.pages = pages;
          retainReviewFile(reviewEvidenceFile, extracted);
        });
        const records = collected.blocks.flatMap((block) => block.records);
        const feed = collected.feed;
        const detail = await request<Intake>(prefix + `/intakes/${uploaded.id}`);
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
          acceptedWrites: detail.imported !== null || detail.acceptedProposalId !== null,
          proposals: detail.proposals.length,
          supersededReviewVersions: collected.supersededReviewVersions,
          extractionComplete: feed.activity.extractionComplete,
          remainingUnits: feed.activity.remainingUnits,
          coordinator,
          reviewEvidenceFile,
          diagnostics: summarizeQualificationDiagnostics(diagnostics, sequence),
          acceptance: null,
        };
        runs.push(run);
        await retainPartialEvidence();
        save();
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
          run.extractionComplete &&
          run.remainingUnits === 0
        ) {
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
          });
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
          run.coordinator.passed &&
          run.grade.passed &&
          run.delivery.passed &&
          (!accept || run.acceptance?.passed === true) &&
          run.acceptedClinicalRecords === 0 &&
          !run.acceptedWrites &&
          run.extractionComplete &&
          run.remainingUnits === 0 &&
          run.diagnostics.droppedEvents === 0 &&
          (run.mode === 'pdf'
            ? (run.diagnostics.wirePdfParts ?? 0) > 0
            : run.diagnostics.wirePdfParts === 0 && (run.diagnostics.wireImageParts ?? 0) > 0),
      );
    report.cacheComparison = summarizeQualificationCache(runs);
    report.stage = 'complete';
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    report.failure = controller.signal.aborted
      ? 'Qualification cancelled.'
      : error instanceof Error
        ? error.message
        : 'Qualification failed.';
    process.exitCode = 1;
    save();
  } finally {
    // Keep the same run's timeline and page attribution even when extraction
    // pauses or fails; never rerun a chart merely to recover its measurements.
    await retainPartialEvidence();
    try {
      await stop();
    } catch {
      report.failure = 'Qualification cleanup failed; inspect the isolated Compose project.';
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
      'Qualification did not finish. Supply explicit opt-in, an existing external output directory, MODEL, LITELLM_CONFIG, and STATE_DIR; inspect any external qualification report for progress.\n',
    );
    process.exitCode = 1;
  });
}
