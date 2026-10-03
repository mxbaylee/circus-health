import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer as createPortReservation, type AddressInfo } from 'node:net';
import { closeSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, BrowserContext } from 'playwright';
import { sanitizeBuildIdentity } from '../shared/build-identity.ts';
import type { ArchiveSummary } from './archive-restore-copy.ts';
import type { ArchiveRestoreOracle, ArchiveRestoreRequest } from './archive-restore-fixture.ts';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const summary = ({ files, bytes, treeHash }: ArchiveSummary): ArchiveSummary => ({
  files,
  bytes,
  treeHash,
});
type RequestOptions = NonNullable<Parameters<ArchiveRestoreRequest>[1]>;
interface RuntimeIdentity {
  ready: boolean;
  encrypted: boolean;
  buildId: string | null;
  revision: string | null;
  worktree: string;
}

/** Never inherit another installation's data, authentication or live model selection. */
export function restoreDrillEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/(?:^|_)(?:API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET_KEY)$/.test(key) &&
        !['MODEL_NAME', 'CONFIG_FILE', 'PROVIDER_API_KEY'].includes(key) &&
        !/^(CRS_|HEALTH_|CIRCUS_|CODEX_|LITELLM_|OLLAMA_|CHATGPT_|OPENAI_|ANTHROPIC_|GOOGLE_API_KEY$|GEMINI_API_KEY$|DATA_DIR$|AI$|MODEL$|AI_URL$|KEY_FILE$|AUTH_DIR$|ENV_FILE$|STACK$|RUNTIME$|PORT$|IMAGE$|NODE$|STATE_DIR$|RESPONSE_MODEL$|IMAGES$|PDF$|PROMPT_CACHE$)/.test(
          key,
        ),
    ),
  );
}

export async function unusedPort(): Promise<number> {
  const server = createPortReservation();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return port;
}

export class Installation {
  readonly project: string;
  readonly base: string;
  process: ChildProcess | undefined;
  closed: Promise<void> | undefined;
  runtime: RuntimeIdentity | undefined;
  readonly data: string;
  readonly state: string;
  readonly port: number;
  readonly config: string;
  readonly providerEnv: string;
  readonly docker: string;
  readonly image: string;
  readonly output: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly sourceRepository: string;
  constructor(
    data: string,
    state: string,
    port: number,
    config: string,
    providerEnv: string,
    docker: string,
    image: string,
    output: string,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
    sourceRepository: string = repository,
  ) {
    this.data = data;
    this.state = state;
    this.port = port;
    this.config = config;
    this.providerEnv = providerEnv;
    this.docker = docker;
    this.image = image;
    this.output = output;
    this.environment = environment;
    this.signal = signal;
    this.sourceRepository = sourceRepository;
    this.project = 'circus-health-' + digest(realpathSync(data)).slice(0, 12);
    this.base = `http://127.0.0.1:${port}`;
  }
  dockerRun(args: string[]): string {
    return execFileSync(this.docker, args, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: this.environment,
    }).trim();
  }
  assertStopped(): void {
    const filter = `label=com.docker.compose.project=${this.project}`;
    assert.equal(this.dockerRun(['ps', '--all', '--quiet', '--filter', filter]), '');
    assert.equal(this.dockerRun(['network', 'ls', '--quiet', '--filter', filter]), '');
  }
  async start(expectRefusal: boolean | string = false): Promise<void> {
    assert(!this.process, 'A drill installation is already running');
    this.assertStopped();
    const log = openSync(this.output, 'a', 0o600);
    try {
      this.process = spawn('npm', ['run', 'start'], {
        cwd: this.sourceRepository,
        detached: true,
        stdio: ['ignore', log, log],
        env: {
          ...this.environment,
          CRS_DOCKER: this.docker,
          CRS_DATA_DIR: this.data,
          CRS_STATE_DIR: this.state,
          CRS_LITELLM_CONFIG: this.config,
          CRS_LITELLM_ENV_FILE: this.providerEnv,
          CRS_MODEL: 'fictional-restore',
          CRS_RESPONSE_MODEL: 'fictional-restore-upstream',
          CRS_IMAGES: 'false',
          CRS_PDF: 'false',
          CRS_PROMPT_CACHE: 'false',
          CRS_PORT: String(this.port),
          CRS_IMAGE: this.image,
        },
      });
    } finally {
      closeSync(log);
    }
    const child = this.process;
    this.closed = new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.once('close', () => done());
    });
    // Host/build startup hang guard, not a model-performance requirement.
    for (let attempt = 0; attempt < 6000; attempt++) {
      this.signal.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null) {
        await this.closed;
        this.process = undefined;
        this.assertStopped();
        if (expectRefusal) {
          assert.notEqual(child.exitCode, 0, 'Incomplete authority must fail explicitly');
          assert(
            readFileSync(this.output, 'utf8').includes(
              typeof expectRefusal === 'string'
                ? expectRefusal
                : 'Circus Health startup failed: Archive registry is missing while retained profile data exists. Preserve the archive and restore a complete backup; private records and history are unavailable.',
            ),
            'Startup must report the expected scoped refusal and operator action',
          );
          return;
        }
        throw new Error('Compose startup failed; inspect the protected qualification log.');
      }
      let response: Response | undefined;
      try {
        response = await fetch(this.base + '/api/runtime', { signal: AbortSignal.timeout(500) });
      } catch {
        // The launcher may still be building or waiting for the proxy.
      }
      if (response?.ok) {
        assert(!expectRefusal, 'An incomplete archive became ready');
        const runtime = (await response.json()) as RuntimeIdentity;
        this.runtime = {
          ready: runtime.ready,
          encrypted: runtime.encrypted,
          ...sanitizeBuildIdentity(runtime),
        };
        assert.equal(this.runtime.ready, true);
        assert.equal(this.runtime.encrypted, true);
        assert(this.runtime.buildId && this.runtime.revision, 'Build identity is required');
        return;
      }
      await delay(100);
    }
    throw new Error('Compose startup did not complete within its host hang guard.');
  }
  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    assert(child.pid);
    try {
      process.kill(-child.pid, 'SIGINT');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
    }
    await Promise.race([
      this.closed,
      delay(120000, undefined, { ref: false }).then(() => {
        throw new Error('Compose did not stop cleanly; keep the archive and inspect its log.');
      }),
    ]);
    this.process = undefined;
    this.assertStopped();
    assert(
      (child.exitCode === 130 && child.signalCode === null) ||
        (child.exitCode === null && child.signalCode === 'SIGINT'),
      'Launcher must complete its handled stop',
    );
    assert.doesNotMatch(
      readFileSync(this.output, 'utf8'),
      /Circus Health startup failed:|Compose cleanup did not complete successfully|Docker child process group did not exit|required forced shutdown/,
      'Writer shutdown must complete without failure',
    );
  }
}

export function requestAdapter(context: BrowserContext, base: string): ArchiveRestoreRequest {
  return async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
    const response = await context.request.fetch(base + path, {
      method: options.method ?? 'GET',
      headers: {
        Origin: base,
        'Content-Type': options.bytes ? 'application/octet-stream' : 'application/json',
        ...options.headers,
      },
      data:
        options.bytes ?? (options.json === undefined ? undefined : JSON.stringify(options.json)),
      timeout: 30000,
    });
    if (!response.ok()) {
      await response.dispose();
      throw new Error(
        `Fictional restore API request failed (${response.status()}); no payload logged.`,
      );
    }
    const value = options.binary
      ? await response.body()
      : ((await response.json()) as { data: T }).data;
    await response.dispose();
    return value as T;
  };
}

export async function newSession(
  browser: Browser,
  installation: Installation,
): Promise<BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(installation.base, { waitUntil: 'networkidle', timeout: 30000 });
  assert.match(await page.title(), /Circus Health/);
  return context;
}

export async function assertLocked(
  context: BrowserContext,
  base: string,
  oracle: ArchiveRestoreOracle,
) {
  for (const path of [
    `/api/profiles/${oracle.profileId}/tests`,
    `/api/profiles/${oracle.profileId}/record-history?kind=observation&recordId=${oracle.observations[0].id}`,
    oracle.originals[0].contentUrl,
  ]) {
    const response = await context.request.get(base + path, { headers: { Origin: base } });
    assert.equal(response.status(), 423, 'Locked private scope must refuse access');
    await response.dispose();
  }
}

export async function lockedKitFailure(
  context: BrowserContext,
  installation: Installation,
  oracle: ArchiveRestoreOracle,
) {
  const response = await context.request.post(
    `${installation.base}/api/profiles/${oracle.profileId}/unlock`,
    {
      headers: { Origin: installation.base },
      data: {
        recovery: {
          format: 'circus-health-recovery-v1',
          profileId: oracle.profileId,
          phrase: 'unusable independently fictional recovery material',
        },
      },
    },
  );
  assert.equal(response.status(), 400);
  const body = (await response.json()) as { error?: { code?: string }; code?: string };
  assert.equal(body.error?.code ?? body.code, 'RECOVERY_INVALID');
  await response.dispose();
  await assertLocked(context, installation.base, oracle);
}
