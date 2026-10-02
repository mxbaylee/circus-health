import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createPortReservation } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { outsideGit } from '../../deploy/run.ts';
import { LATEST_SCHEMA_VERSION } from '../server/database.ts';
import { readBuildSource } from './build-source.ts';
import { sanitizeBuildIdentity } from '../shared/build-identity.ts';
import {
  assertArchiveInventory,
  copyArchiveForDrill,
  inventoryArchive,
  type ArchiveInventory,
  type ArchiveSummary,
} from './archive-restore-copy.ts';
import {
  seedArchiveRestoreFixture,
  verifyArchiveRestoreFixture,
  type ArchiveRestoreOracle,
  type ArchiveRestoreRequest,
} from './archive-restore-fixture.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const summary = ({ files, bytes, treeHash }: ArchiveSummary): ArchiveSummary => ({
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

async function unusedPort(): Promise<number> {
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

class Installation {
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
  async start(expectRefusal = false): Promise<void> {
    assert(!this.process, 'A drill installation is already running');
    this.assertStopped();
    const log = openSync(this.output, 'a', 0o600);
    try {
      this.process = spawn('npm', ['run', 'start'], {
        cwd: repository,
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
              'Circus Health startup failed: Archive registry is missing while retained profile data exists. Preserve the archive and restore a complete backup; private records and history are unavailable.',
            ),
            'Missing registry must trigger the specific integrity refusal',
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

function requestAdapter(context: BrowserContext, base: string): ArchiveRestoreRequest {
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

async function newSession(browser: Browser, installation: Installation): Promise<BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(installation.base, { waitUntil: 'networkidle', timeout: 30000 });
  assert.match(await page.title(), /Circus Health/);
  return context;
}

async function assertLocked(context: BrowserContext, base: string, oracle: ArchiveRestoreOracle) {
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

async function lockedKitFailure(
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

export async function qualifyArchiveRestore(env: NodeJS.ProcessEnv = process.env) {
  if (env.CRS_ARCHIVE_RESTORE_TEST !== '1')
    throw new Error('Set CRS_ARCHIVE_RESTORE_TEST=1 to authorize the fictional Compose drill.');
  const requested = env.CRS_RESTORE_OUTPUT_DIR;
  if (!requested || !isAbsolute(requested))
    throw new Error('CRS_RESTORE_OUTPUT_DIR must be a fresh absolute external directory.');
  outsideGit(requested);
  assert.equal(existsSync(requested), false, 'Qualification never overwrites an existing output');
  // Resolve the existing parent before exclusive creation; the path guard rejects symlinks.
  assert.equal(realpathSync(dirname(requested)), dirname(resolve(requested)));
  mkdirSync(requested, { mode: 0o700 });
  const root = realpathSync(requested);
  const environment = restoreDrillEnvironment(env);
  const docker = env.CRS_DOCKER || 'docker';
  const image = 'circus-health:restore-' + digest(root).slice(0, 12);
  const sourceIdentity = readBuildSource(repository);
  assert(sourceIdentity.revision, 'Qualification needs a repository commit identity');
  const sourceData = join(root, 'source/data');
  const backupData = join(root, 'backup/data');
  const restoredData = join(root, 'restored/data');
  const damagedData = join(root, 'missing-component/data');
  for (const directory of [
    'source/data',
    'backup',
    'restored',
    'missing-component',
    'kits',
    'receipts',
  ])
    mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
  const config = join(root, 'fictional-proxy.yaml');
  const providerEnv = join(root, 'fictional-provider.env');
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume without storing content. This endpoint never generates model output.
    }
    upstreamRequests++;
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Fictional unavailable upstream' } }));
  });
  let upstreamRequests = 0;
  await new Promise<void>((done) => upstream.listen(0, '0.0.0.0', done));
  writeFileSync(
    config,
    `model_list:\n  - model_name: fictional-restore\n    litellm_params:\n      model: openai/fictional-restore-upstream\n      api_base: http://host.docker.internal:${(upstream.address() as AddressInfo).port}/v1\n      api_key: os.environ/FICTIONAL_PROVIDER_KEY\n    model_info:\n      supports_vision: false\n      supports_pdf_input: false\n`,
    { mode: 0o600, flag: 'wx' },
  );
  writeFileSync(providerEnv, 'FICTIONAL_PROVIDER_KEY=fictional-restore-provider-key\n', {
    mode: 0o600,
    flag: 'wx',
  });
  const installations: Installation[] = [];
  const interrupted = new AbortController();
  const installation = async (name: string, data: string) => {
    const result = new Installation(
      data,
      join(root, name + '-proxy-state'),
      await unusedPort(),
      config,
      providerEnv,
      docker,
      image,
      join(root, 'receipts', name + '-launcher.log'),
      environment,
      interrupted.signal,
    );
    installations.push(result);
    return result;
  };
  let browser: Browser | undefined;
  const interrupt = () => {
    interrupted.abort(new Error('Archive restore qualification interrupted.'));
    for (const instance of installations) {
      if (!instance.process?.pid) continue;
      try {
        process.kill(-instance.process.pid, 'SIGINT');
      } catch {
        // Final cleanup checks the project and reports any remaining resources.
      }
    }
    void browser?.close().catch(() => {});
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const receipt: Record<string, unknown> = {
    format: 'circus-health-archive-restore-qualification-v1',
    startedAt: new Date().toISOString(),
    outcome: 'incomplete',
    sourceIdentity,
    dockerCommandOverride: docker !== 'docker',
    inference: 'local unavailable fictional upstream only',
  };
  const saveReceipt = () =>
    writeFileSync(
      join(root, 'receipts', 'qualification.json'),
      JSON.stringify(receipt, null, 2) + '\n',
      {
        mode: 0o600,
      },
    );
  saveReceipt();
  try {
    browser = await chromium.launch({ headless: true });
    const source = await installation('source', sourceData);
    receipt.phase = 'create-fictional-source';
    await source.start();
    assert.equal(source.runtime?.revision, sourceIdentity.revision);
    assert.equal(source.runtime?.worktree, sourceIdentity.worktree);
    const context = await newSession(browser, source);
    const seeded = await seedArchiveRestoreFixture(requestAdapter(context, source.base));
    const sourceCookies = await context.cookies();
    const kitPath = join(root, 'kits', 'fictional-recovery.json');
    writeFileSync(kitPath, JSON.stringify(seeded.recoveryKit), { mode: 0o600, flag: 'wx' });
    const oracle = seeded.oracle;
    writeFileSync(join(root, 'receipts', 'fictional-oracle.json'), JSON.stringify(oracle), {
      mode: 0o600,
      flag: 'wx',
    });
    await requestAdapter(context, source.base)(`/api/profiles/${oracle.profileId}/lock`, {
      method: 'POST',
      json: {},
    });
    await assertLocked(context, source.base, oracle);
    await context.close();
    await source.stop();
    source.assertStopped();
    const sourceInventory = await inventoryArchive(sourceData);
    const sourceVault = await inventoryArchive(
      join(sourceData, 'profiles', oracle.profileId, 'vault'),
    );
    const backupInventory = await copyArchiveForDrill(sourceData, backupData);
    assert.deepEqual(summary(backupInventory), summary(sourceInventory));
    writeFileSync(
      join(root, 'receipts', 'backup-inventory.json'),
      JSON.stringify(backupInventory),
      {
        mode: 0o600,
        flag: 'wx',
      },
    );
    await copyArchiveForDrill(backupData, restoredData);
    const restored = await installation('restored', restoredData);
    assert.notEqual(restored.project, source.project);
    assert.notEqual(restored.state, source.state);
    const registry = JSON.parse(readFileSync(join(backupData, 'profiles.json'), 'utf8')) as {
      format: string;
    };
    const keyring = JSON.parse(
      readFileSync(join(backupData, 'profiles', oracle.profileId, 'keyring.json'), 'utf8'),
    ) as { format: string };
    receipt.build = source.runtime;
    receipt.imageId = source.dockerRun(['image', 'inspect', image, '--format', '{{.Id}}']);
    receipt.formats = {
      registry: registry.format,
      keyring: keyring.format,
      recoveryKit: seeded.recoveryKit.format,
      disposableCacheSchema: LATEST_SCHEMA_VERSION,
    };
    receipt.backup = summary(backupInventory);
    receipt.phase = 'unusable-kit';
    const requestsBeforeRestore = upstreamRequests;
    await restored.start();
    assert.deepEqual(
      restored.runtime,
      source.runtime,
      'Every stage must use the same built artifact',
    );
    let restoredContext = await newSession(browser, restored);
    await assertLocked(restoredContext, restored.base, oracle);
    await lockedKitFailure(restoredContext, restored, oracle);
    const foreignContext = await browser.newContext();
    await foreignContext.addCookies(sourceCookies);
    await assertLocked(foreignContext, restored.base, oracle);
    await foreignContext.close();
    await restoredContext.close();
    await restored.stop();
    await assertArchiveInventory(restoredData, backupInventory);
    receipt.unusableKit = { refused: true, privateScopeUnavailable: true, archiveUnchanged: true };

    receipt.phase = 'independent-restore';
    await restored.start();
    assert.deepEqual(
      restored.runtime,
      source.runtime,
      'Every stage must use the same built artifact',
    );
    restoredContext = await newSession(browser, restored);
    let request = requestAdapter(restoredContext, restored.base);
    await assertLocked(restoredContext, restored.base, oracle);
    await request(`/api/profiles/${oracle.profileId}/unlock`, {
      method: 'POST',
      json: { recovery: JSON.parse(readFileSync(kitPath, 'utf8')) },
    });
    const staleSourceSession = await browser.newContext();
    await staleSourceSession.addCookies(sourceCookies);
    await assertLocked(staleSourceSession, restored.base, oracle);
    await staleSourceSession.close();
    const counts = await verifyArchiveRestoreFixture(request, oracle);
    await request(`/api/profiles/${oracle.profileId}/lock`, { method: 'POST', json: {} });
    await assertLocked(restoredContext, restored.base, oracle);
    await restoredContext.close();
    await restored.stop();
    await assertArchiveInventory(
      join(restoredData, 'profiles', oracle.profileId, 'vault'),
      sourceVault,
    );
    receipt.phase = 'cache-loss-recreation';
    const cache = join(restoredData, 'profiles', oracle.profileId, 'cache');
    assert(existsSync(cache), 'The drill must actually remove an existing disposable cache');
    rmSync(cache, { recursive: true });
    await restored.start();
    restoredContext = await newSession(browser, restored);
    assert.deepEqual(
      restored.runtime,
      source.runtime,
      'Cache reconstruction must use the same built artifact',
    );
    request = requestAdapter(restoredContext, restored.base);
    await assertLocked(restoredContext, restored.base, oracle);
    await request(`/api/profiles/${oracle.profileId}/unlock`, {
      method: 'POST',
      json: { recovery: JSON.parse(readFileSync(kitPath, 'utf8')) },
    });
    assert.deepEqual(await verifyArchiveRestoreFixture(request, oracle), counts);
    await request(`/api/profiles/${oracle.profileId}/lock`, { method: 'POST', json: {} });
    await assertLocked(restoredContext, restored.base, oracle);
    await restoredContext.close();
    await restored.stop();
    await assertArchiveInventory(
      join(restoredData, 'profiles', oracle.profileId, 'vault'),
      sourceVault,
    );
    assert.equal(
      upstreamRequests,
      requestsBeforeRestore,
      'Restore/cache rebuild must not invoke inference',
    );

    receipt.phase = 'missing-registry';
    await copyArchiveForDrill(backupData, damagedData);
    rmSync(join(damagedData, 'profiles.json'));
    await assert.rejects(assertArchiveInventory(damagedData, backupInventory));
    const missingInventory: ArchiveInventory = await inventoryArchive(damagedData);
    const damaged = await installation('missing-component', damagedData);
    await damaged.start(true);
    await assertArchiveInventory(damagedData, missingInventory);
    source.assertStopped();
    await assertArchiveInventory(sourceData, sourceInventory);
    await assertArchiveInventory(backupData, backupInventory);
    assert.equal(upstreamRequests, requestsBeforeRestore);
    Object.assign(receipt, {
      phase: 'complete',
      outcome: 'passed',
      completedAt: new Date().toISOString(),
      counts,
      missingComponent: {
        refused: true,
        privateScopeUnavailable: true,
        remainingAuthorityUnchanged: true,
      },
      sourceAndBackupUnchanged: true,
      restoredVaultUnchanged: true,
      sourceSessionRejectedByRestore: true,
      restoreAndRebuildInferenceRequests: 0,
      restoredState: 'clinical and key state retained by this independent backup',
      rollbackPrevention: false,
      scope:
        'one small fictional current-format Compose installation; not filesystem/power-loss/provider/device qualification',
    });
    saveReceipt();
    return receipt;
  } catch (error) {
    receipt.outcome = 'failed';
    receipt.completedAt = new Date().toISOString();
    writeFileSync(
      join(root, 'receipts', 'failure.log'),
      error instanceof Error ? (error.stack ?? error.message) : 'Qualification failed',
      { mode: 0o600 },
    );
    saveReceipt();
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      browser?.close(),
      ...installations.map((instance) => instance.stop()),
      new Promise<void>((done) => {
        upstream.closeAllConnections();
        upstream.close(() => done());
      }),
    ]);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    const failures = cleanup.filter((result) => result.status === 'rejected');
    if (failures.length) {
      receipt.outcome = 'failed';
      receipt.cleanupFailed = true;
      saveReceipt();
      throw new Error(
        'Qualification cleanup failed; preserve artifacts and inspect project resources.',
      );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Counts and identities only; kits, file inventories and logs remain external.
  qualifyArchiveRestore()
    .then((receipt) => console.log(JSON.stringify(receipt, null, 2)))
    .catch(() => {
      console.error(
        'Archive restore qualification failed. Preserve its external artifacts and inspect the protected phase receipt/logs.',
      );
      process.exitCode = 1;
    });
}
