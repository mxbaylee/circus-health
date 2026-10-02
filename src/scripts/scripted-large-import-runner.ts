import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ImportDiagnosticArchive } from '../shared/import-performance.ts';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { startRuntime } from '../server/runtime.ts';
import { createImportDiagnostics } from '../server/import-diagnostics.ts';
import type { ImportDiagnosticExport } from '../server/import-diagnostics.ts';
import { ProxyModelBridge } from '../server/proxy-model-bridge.ts';
import type { Intake, IntakeReview, IntakeReportQueue } from '../shared/intake.ts';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import type { IntakeIdentityPerson, IntakeIdentityReview } from '../shared/intake-identity.ts';
import type { ImportRecordingCheck } from '../shared/import-recording-check.ts';
import { isImportRecordingCheck } from '../shared/import-recording-check.ts';
import { writeLargeImportFixture, createLargeImportOracle } from './large-import-fixture.ts';
import {
  gradeLargeImportReview,
  type LargeImportReviewAuthority,
} from './large-import-review-grader.ts';
import {
  ScriptedLargeImportUpstream,
  scriptedModelConfig,
} from './scripted-large-import-upstream.ts';
type ScriptedApiFailure = { route: string; status: number; code: string | null };

export function scriptedOutputParent(path: string): string {
  if (!isAbsolute(path)) throw Error('Output must be an existing absolute directory outside Git.');
  const real = realpathSync(path);
  if (!statSync(real).isDirectory()) throw Error('Output must be a directory.');
  for (let parent = real; ; parent = dirname(parent)) {
    if (existsSync(join(parent, '.git'))) throw Error('Output must be outside Git.');
    if (dirname(parent) === parent) break;
  }
  return real;
}
function privateJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
/** Always creates an owned fresh attempt. No option accepts an existing profile or a model route. */
export async function runScriptedLargeImport(options: {
  outputParent: string;
  maxRequests?: number;
  maxIdlePolls?: number;
  signal?: AbortSignal;
  keepOpen?: boolean;
  /** Bounded fictional tests supply their own writer; the command always uses the unchanged 900-page fixture. */
  fixture?: (pdf: string, oracle: string) => { pages: number; sourceHash: string; bytes: number };
  recordingEnabled?: boolean;
  upstreamHttpFailureAt?: number;
  /** Sparse bounded fictional test only; no command option exposes this. */
  proposalPages?: readonly number[];
}) {
  if (options.proposalPages && !options.fixture)
    throw Error('Sparse proposal scope requires an explicit bounded fictional fixture.');
  const maxRequests = options.maxRequests ?? 4096;
  const maxIdlePolls = options.maxIdlePolls ?? 500;
  if (!Number.isSafeInteger(maxIdlePolls) || maxIdlePolls < 1 || maxIdlePolls > 100_000)
    throw Error('Idle poll bound must be an integer from 1 to 100000.');
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 100_000)
    throw Error('Request bound must be an integer from 1 to 100000.');
  const root = mkdtempSync(
    join(scriptedOutputParent(options.outputParent), 'circus-scripted-large-'),
  );
  chmodSync(root, 0o700);
  const data = join(root, 'data');
  mkdirSync(data, { mode: 0o700 });
  const runtimeDirectory = mkdtempSync(
    join(process.platform === 'linux' ? '/dev/shm' : tmpdir(), 'circus-scripted-runtime-'),
  );
  chmodSync(runtimeDirectory, 0o700);
  const diagnostics = createImportDiagnostics({ enabled: options.recordingEnabled !== false });
  const requestsPath = join(root, 'requests.jsonl');
  const writeRequest = (value: unknown) =>
    appendFileSync(requestsPath, JSON.stringify(value) + '\n', { mode: 0o600 });
  const env = {
    CRS_AI_BACKEND: 'litellm',
    CRS_AI_MODEL: scriptedModelConfig.model,
    CRS_AI_BASE_URL: scriptedModelConfig.baseUrl,
    CRS_AI_API_KEY: scriptedModelConfig.apiKey,
    CRS_AI_API_KEY_FILE: undefined,
    CRS_AI_REASONING_EFFORT: undefined,
    CRS_AI_PROXY_LOCAL_ONLY: 'false',
    CRS_AI_PROXY_RESOLVED_MODEL: undefined,
    CRS_AI_PROXY_IMAGES: 'true',
    CRS_AI_PROXY_PDF: 'true',
    CRS_AI_PROXY_PROMPT_CACHE: 'false',
  };
  const old = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(env);
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  let prefix = '',
    cookie = '',
    base = '';
  let upstream: ScriptedLargeImportUpstream | undefined;
  let publishUploadBinding!: () => void;
  const uploadBinding = new Promise<void>((done) => {
    publishUploadBinding = done;
  });
  async function waitForUploadBinding(signal?: AbortSignal | null) {
    if (signal?.aborted) throw Error('SCRIPTED_USER_CANCELLED');
    await new Promise<void>((done, reject) => {
      const cancel = () => reject(Error('SCRIPTED_USER_CANCELLED'));
      signal?.addEventListener('abort', cancel, { once: true });
      uploadBinding.then(() => {
        signal?.removeEventListener('abort', cancel);
        done();
      });
    });
  }
  let batch: IntakeBatch | null = null;
  let failure: string | null = null;
  let recording: ImportRecordingCheck | null = null;
  let diagnosticExport:
    (ImportDiagnosticExport & { eventArchive: ImportDiagnosticArchive }) | null = null;
  let grade: ReturnType<typeof gradeLargeImportReview> | null = null;
  let uploaded: Intake | null = null;
  let fixture: { pages: number; sourceHash: string; bytes: number } | null = null;
  let originalUnchanged: boolean | null = null;
  const evidenceFailures: string[] = [];
  let uploadAttempted = false;
  let stage = 'fixture_generation';
  let apiFailure: ScriptedApiFailure | null = null;
  let evidenceCapture = false;
  const request = async <T>(path: string, input?: unknown, bytes?: Buffer): Promise<T> => {
    const response = await fetch(base + path, {
      signal: evidenceCapture ? AbortSignal.timeout(10_000) : options.signal,
      method: input !== undefined || bytes ? 'POST' : 'GET',
      headers: {
        Origin: base,
        Cookie: cookie,
        'Content-Type': bytes ? 'application/pdf' : 'application/json',
        ...(bytes ? { 'X-Filename': 'independently-fictional-900-pages.pdf' } : {}),
      },
      ...(bytes
        ? { body: Uint8Array.from(bytes).buffer }
        : input !== undefined
          ? { body: JSON.stringify(input) }
          : {}),
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const result = (await response.json()) as { data: T; error?: { code?: string } };
    if (!response.ok) {
      apiFailure = {
        route: path.replace(/\/api\/profiles\/[^/]+/, '/api/profiles/:profile'),
        status: response.status,
        code: result.error?.code ?? null,
      };
      throw Error('SCRIPTED_HTTP_REFUSAL');
    }
    return result.data;
  };
  const close = async () => {
    try {
      await runtime?.close();
    } finally {
      diagnostics.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      apply(old);
    }
  };
  async function captureEvidence(name: string, action: () => Promise<void>) {
    try {
      await action();
    } catch {
      evidenceFailures.push(name);
      failure ||= 'SCRIPTED_EVIDENCE_UNAVAILABLE';
    }
  }
  async function captureReview() {
    const source = uploaded;
    if (!source) return;
    const retained = await request<Intake>(prefix + `/intakes/${source.id}`);
    privateJson(join(root, 'intake-final.json'), retained);
    const reviews: IntakeReview[] = [];
    for (const proposal of retained.proposals)
      await captureEvidence('review_snapshot', async () => {
        reviews.push(
          await request<IntakeReview>(
            prefix + `/intakes/${source.id}/review?proposalId=${encodeURIComponent(proposal.id)}`,
          ),
        );
      });
    const queue = await request<IntakeReportQueue>(
      prefix + '/intakes/report-queue?view=all&limit=100',
    );
    const authorities: LargeImportReviewAuthority[] = [];
    for (const group of queue.groups.filter((group) => group.intakeId === source.id)) {
      const retainedGroup = retained.workflow?.reportGroups?.find(
        (value) => value.id === group.groupId,
      );
      if (!retainedGroup) throw Error('SCRIPTED_REPORT_AUTHORITY');
      authorities.push({
        retained: retainedGroup,
        queue: group,
        identity: await request<IntakeIdentityReview>(
          prefix +
            `/intakes/${source.id}/identity-review?groupId=${encodeURIComponent(group.groupId)}`,
        ),
      });
    }
    const people = await request<IntakeIdentityPerson[]>(prefix + '/record-ownership/people');
    const cedar = people.find((person) => person.personId === 'patient');
    const willow = people.find((person) => person.fullName === 'Fictional Willow Brook');
    privateJson(join(root, 'review-final.json'), { reviews, authorities, people });
    if (!cedar || !willow) throw Error('SCRIPTED_PERSON_BINDING');
    grade = gradeLargeImportReview({
      oracle: createLargeImportOracle(),
      stage: 'proposal',
      originalId: source.id,
      people: { 'fictional-cedar': cedar, 'fictional-willow': willow },
      reviews,
      authorities,
    });
    privateJson(join(root, 'proposal-grade.json'), grade);
  }
  try {
    fixture = (options.fixture ?? writeLargeImportFixture)(
      join(root, 'original.pdf'),
      join(root, 'oracle.json'),
    );
    upstream = new ScriptedLargeImportUpstream({
      pages: fixture.pages,
      maxRequests,
      onRequest: writeRequest,
      httpFailureAt: options.upstreamHttpFailureAt,
      proposalPages: options.proposalPages,
    });
    upstream.sourceHash = fixture.sourceHash;
    stage = 'runtime_setup';
    runtime = await startRuntime({
      dataDirectory: data,
      runtimeDirectory,
      port: 0,
      host: '127.0.0.1',
      diagnostics,
      assistantOptions: {
        availability: () => ({ available: true, readiness: 'ready' }),
        connectionCheck: async () => ({ available: true, readiness: 'ready' }),
        bridgeFactory: (callbacks) => {
          upstream!.beginSlice();
          return new ProxyModelBridge({
            ...callbacks,
            config: scriptedModelConfig,
            fetchImpl: async (url, init) => {
              // Upload publication can start the normal coordinator before its
              // HTTP response. Wait only for the harness's source binding.
              await waitForUploadBinding(init?.signal);
              return upstream!.fetch(url, init);
            },
            onTool: async (params) => {
              try {
                const result = await callbacks.onTool!(params);
                return await upstream!.acknowledge(params, result);
              } catch (error) {
                // Independently fictional attempt only; raw host diagnostics
                // stay private and never enter the aggregate or request log.
                try {
                  privateJson(join(root, 'tool-error-private.json'), {
                    tool: params.tool,
                    ...(error instanceof Error
                      ? {
                          name: error.name,
                          message: error.message,
                          code: (error as Error & { code?: string }).code ?? null,
                        }
                      : { name: 'UnknownError' }),
                  });
                } catch {}
                upstream!.failure ||= 'SCRIPTED_HOST_TOOL_REJECTED';
                throw error;
              }
            },
          });
        },
      },
    });
    base = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    const setup = await request<{ setupId: string; recoveryKit: unknown }>('/api/profile-setups', {
      name: 'Fictional scripted qualification',
      fullName: 'Fictional Cedar Vale',
      birthDate: '1982-04-17',
    });
    privateJson(join(root, 'recovery-private.json'), setup.recoveryKit);
    const profile = await request<{ id: string }>(`/api/profile-setups/${setup.setupId}/verify`, {
      recovery: setup.recoveryKit,
      acknowledged: true,
    });
    prefix = `/api/profiles/${profile.id}`;
    await request(prefix + '/notes', {
      kind: 'person',
      title: 'Fictional Willow Brook',
      person: { fullName: 'Fictional Willow Brook', birthDate: '1991-09-23' },
    });
    stage = 'recording_check';
    recording = await request<ImportRecordingCheck>(prefix + '/import-diagnostics/check', {});
    privateJson(join(root, 'recording-check.json'), recording);
    if (
      !isImportRecordingCheck(recording) ||
      recording.status !== 'current_origin_readable' ||
      recording.archive.coverageWarnings
    )
      throw Error('SCRIPTED_RECORDING_UNAVAILABLE');
    stage = 'upload';
    uploadAttempted = true;
    uploaded = await request<Intake>(
      prefix + '/intakes',
      undefined,
      readFileSync(join(root, 'original.pdf')),
    );
    upstream.intakeId = uploaded.id;
    publishUploadBinding();
    if (uploaded.sha256 !== fixture.sourceHash) throw Error('SCRIPTED_ORIGINAL_MISMATCH');
    const batches = await request<IntakeBatch[]>(prefix + '/intake-batches');
    const owned = batches.filter((value) =>
      value.items.some((item) => item.intakeId === uploaded!.id),
    );
    if (owned.length !== 1 || !owned[0]!.automaticRun || owned[0]!.items.length !== 1)
      throw Error('SCRIPTED_BATCH_SCOPE');
    batch = owned[0]!;
    stage = 'processing';
    let idlePolls = 0;
    const progress = () =>
      JSON.stringify({
        requests: upstream!.requests,
        items: batch!.items.map((item) => ({
          capturedPages: item.sourceExtraction?.progress ?? 0,
          initialCaptureDone: item.sourceExtraction?.initialDone ?? false,
          readWindows: item.reading?.readWindows ?? 0,
          accountedUnits: item.reading?.accountedUnits ?? 0,
          proposals: item.proposalIds.length,
        })),
      });
    let observedProgress = progress();
    for (;;) {
      if (options.signal?.aborted) {
        failure = 'SCRIPTED_USER_CANCELLED';
        break;
      }
      if (upstream.failure) {
        failure = upstream.failure;
        break;
      }
      batch = await request<IntakeBatch>(prefix + `/intake-batches/${batch.id}`);
      if (batch.status !== 'running') {
        stage = 'processing_terminal';
        if (batch.status !== 'complete' || batch.reason !== null)
          failure ||= 'SCRIPTED_APP_TERMINAL_EXCEPTION';
        break;
      }
      if (batch.items.some((item) => item.reason === 'source_prerequisite')) {
        failure = 'SCRIPTED_APP_SOURCE_PREREQUISITE';
        break;
      }
      const currentProgress = progress();
      if (observedProgress === currentProgress) idlePolls++;
      else idlePolls = 0;
      observedProgress = currentProgress;
      if (idlePolls >= maxIdlePolls) {
        failure = 'SCRIPTED_IDLE_POLL_BOUND';
        break;
      }
      await new Promise<void>((done) => setTimeout(done, 100));
    }
  } catch (error) {
    // This separate private artifact diagnoses runner/fixture setup. It is never
    // part of the metadata download or the safe console aggregate.
    try {
      privateJson(
        join(root, 'runner-error-private.json'),
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: 'UnknownError' },
      );
    } catch {}
    failure ||=
      (options.signal?.aborted ? 'SCRIPTED_USER_CANCELLED' : null) ||
      upstream?.failure ||
      (error instanceof Error && /^SCRIPTED_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'SCRIPTED_RUNNER_FAILURE');
  } finally {
    evidenceCapture = true;
    if (prefix) {
      await captureEvidence('batch_scope', async () => {
        if (!uploaded && uploadAttempted && fixture) {
          const candidates = await request<Intake[]>(prefix + '/intakes?view=all&limit=100');
          uploaded = candidates.find((source) => source.sha256 === fixture!.sourceHash) ?? null;
          if (uploaded && upstream) {
            upstream.intakeId = uploaded.id;
            publishUploadBinding();
          }
        }
        if (uploaded && !batch) {
          const candidates = await request<IntakeBatch[]>(prefix + '/intake-batches');
          batch =
            candidates.find((value) =>
              value.items.some((item) => item.intakeId === uploaded!.id),
            ) ?? null;
        }
        if (failure && batch?.status === 'running') {
          privateJson(join(root, 'batch-before-harness-stop.json'), batch);
          batch = await request<IntakeBatch>(prefix + `/intake-batches/${batch.id}/stop`, {});
        }
      });
      await captureEvidence('review', captureReview);
      await captureEvidence('diagnostics', async () => {
        diagnosticExport = await request<
          ImportDiagnosticExport & { eventArchive: ImportDiagnosticArchive }
        >(prefix + '/import-diagnostics');
        privateJson(join(root, 'diagnostics-final.json'), diagnosticExport);
      });
      await captureEvidence('original_hash', async () => {
        if (uploaded && fixture) {
          const response = await fetch(base + uploaded.contentUrl, {
            headers: { Cookie: cookie },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) throw Error('SCRIPTED_ORIGINAL_UNAVAILABLE');
          originalUnchanged =
            createHash('sha256')
              .update(new Uint8Array(await response.arrayBuffer()))
              .digest('hex') === fixture.sourceHash;
          if (!originalUnchanged) failure ||= 'SCRIPTED_ORIGINAL_MISMATCH';
        }
      });
    }
  }
  const finalDiagnostics = diagnosticExport as
    (ImportDiagnosticExport & { eventArchive: ImportDiagnosticArchive }) | null;
  const omissions =
    finalDiagnostics?.eventArchive?.windowCoverage.reduce(
      (total, window) => total + window.knownPersistedNotExportedEvents,
      0,
    ) ?? null;
  const archive = finalDiagnostics?.eventArchive;
  const diagnosticWarnings =
    !archive ||
    archive.status !== 'available' ||
    archive.outputTruncated ||
    archive.readFailures > 0 ||
    archive.invalidChunks > 0 ||
    archive.invalidEvents > 0 ||
    archive.windowCheckpoints.some(
      (window) =>
        window.droppedEvents > 0 || window.oversizedEvents > 0 || window.writeFailures > 0,
    ) ||
    archive.currentWindow.droppedEvents > 0 ||
    archive.currentWindow.oversizedEvents > 0 ||
    archive.currentWindow.writeFailures > 0 ||
    omissions !== 0;
  const runtimeOpen = !!(
    options.keepOpen &&
    runtime &&
    existsSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)))
  );
  const partialOriginal = fixture
    ? null
    : existsSync(join(root, 'original.pdf'))
      ? {
          bytes: statSync(join(root, 'original.pdf')).size,
          sha256: createHash('sha256')
            .update(readFileSync(join(root, 'original.pdf')))
            .digest('hex'),
        }
      : null;
  const result = {
    format: 'circus-scripted-large-import-run-v1',
    boundary:
      'Contributor encrypted runtime, normal HTTP upload/automatic coordinator and real ProxyModelBridge; only upstream inference scripted. No Compose, release-browser, extraction/OCR-fidelity or accepted-record qualification.',
    outcome: failure
      ? 'incomplete'
      : batch?.status === 'complete'
        ? 'processing_complete'
        : 'incomplete',
    qualification: 'incomplete',
    failure,
    stage,
    uploadAttempted,
    evidenceFailures,
    apiFailure: apiFailure as ScriptedApiFailure | null,
    fixture,
    scriptedProposalScope: options.proposalPages
      ? { kind: 'sparse_test', pages: [...options.proposalPages] }
      : { kind: 'all_fixture_pages' },
    partialOriginal,
    runtimeOpen,
    limits: {
      harnessMaxRequests: maxRequests,
      harnessMaxIdlePolls: maxIdlePolls,
      modelWorkTimeLimit: null,
      appDefaultsChanged: false,
    },
    measurements: {
      physicalRequests: upstream?.requests ?? 0,
      slices: upstream?.slice ?? 0,
      pagesRead: upstream?.readPages.length ?? 0,
      pagesDelivered: upstream?.deliveredPages.size ?? 0,
      providerUsage: null,
      extractionFidelity: 'unqualified',
      bufferedPeakBytes: null,
    },
    batch,
    proposalGrade: grade as ReturnType<typeof gradeLargeImportReview> | null,
    recordingCheck: recording,
    diagnosticCoverage: {
      knownPersistedNotExportedEvents: omissions,
      status: finalDiagnostics?.eventArchive?.status ?? null,
      completeness: 'not_established',
      warningsBlockQualification: diagnosticWarnings,
    },
    acceptedRecords: 0,
    originalUnchanged,
    reviewEntry: {
      url: runtimeOpen ? base + '/import' : null,
      lifecycle: runtimeOpen ? 'available_until_explicit_shutdown' : 'runtime_closed',
      profileId: prefix.split('/').at(-1) || null,
      originalId: uploaded?.id ?? null,
      instructions:
        'Keep-open requires built src/dist assets. Unlock only this fresh fictional profile using recovery-private.json if the browser asks. Recovery material stays private. A closed runtime URL is not a usable review entry; rerun --keep-open creates a new owned attempt.',
    },
  };
  try {
    privateJson(join(root, 'result.json'), result);
    privateJson(join(root, 'batch-final.json'), batch);
  } catch (error) {
    await close();
    throw error;
  }
  if (!runtimeOpen) await close();
  return { root, result, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--run') || process.env.CRS_SCRIPTED_LARGE_IMPORT !== '1')
    throw Error(
      'Explicit opt-in required: CRS_SCRIPTED_LARGE_IMPORT=1 node src/scripts/scripted-large-import-runner.ts --run',
    );
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => controller.abort());
  const attempt = await runScriptedLargeImport({
    outputParent: process.env.CRS_SCRIPTED_OUTPUT_DIR ?? '',
    maxRequests: process.env.CRS_SCRIPTED_MAX_REQUESTS
      ? Number(process.env.CRS_SCRIPTED_MAX_REQUESTS)
      : undefined,
    maxIdlePolls: process.env.CRS_SCRIPTED_MAX_IDLE_POLLS
      ? Number(process.env.CRS_SCRIPTED_MAX_IDLE_POLLS)
      : undefined,
    signal: controller.signal,
    keepOpen: process.argv.includes('--keep-open'),
  });
  console.info(
    JSON.stringify({
      output: attempt.root,
      outcome: attempt.result.outcome,
      failure: attempt.result.failure,
      measurements: attempt.result.measurements,
      reviewEntry: attempt.result.reviewEntry.url,
    }),
  );
  if (attempt.result.runtimeOpen) {
    if (!controller.signal.aborted)
      await new Promise<void>((done) =>
        controller.signal.addEventListener('abort', () => done(), { once: true }),
      );
    await attempt.close();
  }
  if (attempt.result.outcome !== 'processing_complete') process.exitCode = 1;
}
