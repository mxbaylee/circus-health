/** Opt-in natural-expiry OAuth qualification on the supported pinned LiteLLM route. */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireOAuthStateLock,
  dataDirectory,
  Docker,
  external,
  PROXY_IMAGE,
  ROOT,
} from '../../deploy/run.ts';
import { readBuildSource } from './build-source.ts';

type Phase = 'probe' | 'refresh' | 'reuse';
type PhaseStatus = 'ready_expired' | 'pending_natural_expiry' | 'refreshed' | 'reused';
type PhaseResult = {
  status: PhaseStatus;
  refreshObserved: boolean;
  persistenceObserved: boolean;
};

export function safeOAuthFailureCode(error: unknown) {
  if (!(error instanceof Error)) return 'phase_or_docker_error';
  if (error.message === 'OWNED_CONTAINER_CLEANUP_FAILED') return 'owned_container_cleanup_failed';
  if (error.message.includes('active launcher, login or qualification writer'))
    return 'credential_writer_busy';
  if (error.message === 'Stop containers using this OAuth state before live refresh qualification.')
    return 'active_auth_container';
  if (error.message === 'Could not inspect active credential writers.')
    return 'credential_writer_inspection_failed';
  return 'phase_or_docker_error';
}

export function parsePhaseResult(phase: Phase, output: string): PhaseResult {
  // Never echo untrusted provider/container output; accept exactly one small JSON line.
  const lines = output.trim().split(/\r?\n/u);
  if (lines.length !== 1 || lines[0]!.length > 300)
    throw new Error('OAuth qualification returned an unexpected response.');
  let value: unknown;
  try {
    value = JSON.parse(lines[0]!);
  } catch {
    throw new Error('OAuth qualification returned an invalid response.');
  }
  if (!value || typeof value !== 'object')
    throw new Error('OAuth qualification response is invalid.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(',') !== 'persistenceObserved,refreshObserved,status')
    throw new Error('OAuth qualification returned unexpected metadata fields.');
  const validStatus: PhaseStatus[] =
    phase === 'probe'
      ? ['ready_expired', 'pending_natural_expiry']
      : phase === 'refresh'
        ? ['refreshed', 'pending_natural_expiry']
        : ['reused'];
  if (
    !validStatus.includes(result.status as PhaseStatus) ||
    typeof result.refreshObserved !== 'boolean' ||
    typeof result.persistenceObserved !== 'boolean' ||
    (result.status === 'refreshed' && (!result.refreshObserved || !result.persistenceObserved)) ||
    (result.status === 'reused' && (result.refreshObserved || !result.persistenceObserved)) ||
    ((result.status === 'ready_expired' || result.status === 'pending_natural_expiry') &&
      (result.refreshObserved || result.persistenceObserved))
  )
    throw new Error('OAuth qualification response has inconsistent evidence.');
  return result as PhaseResult;
}

export function authMountOverlaps(auth: string, mounts: unknown): boolean {
  if (!Array.isArray(mounts)) throw new Error('Could not inspect active credential writers.');
  return mounts.some((mount: unknown) => {
    if (!mount || typeof mount !== 'object') throw new Error('Invalid container mount metadata.');
    const entry = mount as Record<string, unknown>;
    if (typeof entry.Type !== 'string' || typeof entry.Source !== 'string')
      throw new Error('Invalid container mount metadata.');
    if (entry.Type !== 'bind') return false;
    const source = resolve(entry.Source);
    return source === auth || source.startsWith(auth + sep) || auth.startsWith(source + sep);
  });
}

async function refuseActiveAuthContainers(auth: string) {
  const docker = new Docker();
  const timer = setTimeout(() => docker.stop('SIGTERM'), 45_000);
  try {
    const output = (await docker.run(['ps', '-q', '--no-trunc'], { capture: true })).trim();
    const ids = output ? output.split(/\s+/u) : [];
    if (ids.some((id) => !/^[a-f0-9]{64}$/u.test(id)))
      throw new Error('Could not inspect active credential writers.');
    for (const id of ids) {
      const mounts: unknown = JSON.parse(
        await docker.run(['inspect', '--format', '{{json .Mounts}}', id], { capture: true }),
      );
      if (authMountOverlaps(auth, mounts))
        throw new Error(
          'Stop containers using this OAuth state before live refresh qualification.',
        );
    }
  } finally {
    clearTimeout(timer);
    docker.dispose();
  }
}

export async function containerPhase(
  phase: Phase,
  paths: { auth: string; config: string; providerEnv?: string; model: string },
  createDocker = () => new Docker(),
): Promise<PhaseResult> {
  const docker = createDocker();
  const name = 'circus-oauth-qualification-' + randomUUID();
  const timer = setTimeout(() => docker.stop('SIGTERM'), phase === 'refresh' ? 120_000 : 45_000);
  try {
    const args = [
      'run',
      '--name',
      name,
      '--read-only',
      '--security-opt',
      'no-new-privileges:true',
      '--cap-drop',
      'ALL',
      '--ulimit',
      'core=0:0',
      '--pids-limit',
      '256',
      '--cpus',
      '1',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,mode=1777,size=128m',
      ...(phase === 'refresh' ? [] : ['--network', 'none']),
      ...(paths.providerEnv ? ['--env-file', paths.providerEnv] : []),
      '-e',
      'LITELLM_LOCAL_MODEL_COST_MAP=True',
      '-e',
      'CHATGPT_TOKEN_DIR=/var/lib/litellm/chatgpt',
      '-e',
      'CHATGPT_AUTH_FILE=auth.json',
      '-e',
      `CRS_MODEL=${paths.model}`,
      '--mount',
      `type=bind,source=${paths.auth},target=/var/lib/litellm/chatgpt${phase === 'probe' || phase === 'reuse' ? ',readonly' : ''}`,
      '--mount',
      `type=bind,source=${paths.config},target=/app/config.yaml,readonly`,
      '--mount',
      `type=bind,source=${ROOT}/deploy/litellm/qualify_chatgpt_oauth.py,target=/opt/circus/qualify_chatgpt_oauth.py,readonly`,
      '--entrypoint',
      'python',
      PROXY_IMAGE,
      '-u',
      '/opt/circus/qualify_chatgpt_oauth.py',
      phase,
    ];
    return parsePhaseResult(phase, await docker.run(args, { capture: true }));
  } finally {
    clearTimeout(timer);
    try {
      // Remove only this owned container, including after Docker CLI cancellation.
      // Failure propagates and prevents a passing receipt.
      try {
        await docker.run(['rm', '--force', name], { cleanup: true });
      } catch {
        throw new Error('OWNED_CONTAINER_CLEANUP_FAILED');
      }
    } finally {
      docker.dispose();
    }
  }
}

export async function qualifyOAuthRefresh(env: NodeJS.ProcessEnv = process.env) {
  if (env.CRS_OAUTH_QUALIFICATION !== '1')
    throw new Error('Set CRS_OAUTH_QUALIFICATION=1 to authorize a live OAuth qualification.');
  const data = env.CRS_DATA_DIR ? dataDirectory(env) : undefined;
  const outputDir = external(env.CRS_OAUTH_OUTPUT_DIR, 'CRS_OAUTH_OUTPUT_DIR', {
    directory: true,
    create: true,
    data,
  });
  const state = external(env.CRS_STATE_DIR, 'CRS_STATE_DIR', { directory: true, data });
  const auth = external(join(state, 'chatgpt'), 'ChatGPT authentication', {
    directory: true,
    data,
  });
  const config = external(env.CRS_LITELLM_CONFIG, 'CRS_LITELLM_CONFIG', { data });
  const providerEnv = env.CRS_LITELLM_ENV_FILE
    ? external(env.CRS_LITELLM_ENV_FILE, 'CRS_LITELLM_ENV_FILE', { data })
    : undefined;
  if (outputDir === state || outputDir.startsWith(state + '/'))
    throw new Error('Qualification receipts must be outside the proxy state directory.');
  const model = env.CRS_MODEL || '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model))
    throw new Error('CRS_MODEL must be one exact selected alias.');
  const source = readBuildSource(ROOT);
  const receipt = {
    schema: 'circus-oauth-qualification-v1',
    recordedAt: new Date().toISOString(),
    routeAlias: model,
    proxyImage: PROXY_IMAGE,
    sourceRevision: source.revision || 'unknown',
    sourceWorktree: source.worktree,
    outcome: 'failed',
    failureStage: null as null | 'probe' | 'writer_check' | 'refresh' | 'reuse',
    failureCode: null as null | ReturnType<typeof safeOAuthFailureCode>,
    phases: [] as Array<{ phase: Phase; result: PhaseResult }>,
  };
  let stage: 'probe' | 'writer_check' | 'refresh' | 'reuse' = 'probe';
  try {
    const paths = { auth, config, providerEnv, model };
    const probe = await containerPhase('probe', paths);
    receipt.phases.push({ phase: 'probe', result: probe });
    if (probe.status === 'pending_natural_expiry') receipt.outcome = 'pending_natural_expiry';
    else {
      stage = 'writer_check';
      const lock = acquireOAuthStateLock(auth);
      try {
        await refuseActiveAuthContainers(auth);
        stage = 'refresh';
        const refresh = await containerPhase('refresh', paths);
        receipt.phases.push({ phase: 'refresh', result: refresh });
        if (refresh.status === 'pending_natural_expiry') receipt.outcome = 'pending_natural_expiry';
        else {
          stage = 'reuse';
          const reuse = await containerPhase('reuse', paths);
          receipt.phases.push({ phase: 'reuse', result: reuse });
          receipt.outcome = 'passed';
        }
      } finally {
        lock.release();
      }
    }
  } catch (error) {
    // Docker and provider error bodies never enter receipts or terminal output.
    receipt.outcome = 'failed';
    receipt.failureStage = stage;
    receipt.failureCode = safeOAuthFailureCode(error);
  }
  const name = `oauth-qualification-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.json`;
  const path = join(outputDir, name);
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  console.log(`OAuth qualification: ${receipt.outcome}. Receipt: ${path}`);
  if (receipt.outcome === 'failed') process.exitCode = 1;
  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  qualifyOAuthRefresh().catch(() => {
    console.error('OAuth qualification could not start. Check opt-in and external path settings.');
    process.exitCode = 1;
  });
