/** Opt-in natural-expiry OAuth qualification on the supported pinned LiteLLM route. */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory, Docker, external, PROXY_IMAGE, ROOT } from '../../deploy/run.ts';
import { readBuildSource } from './build-source.ts';

type Phase = 'probe' | 'refresh' | 'reuse';
type PhaseStatus = 'ready_expired' | 'pending_natural_expiry' | 'refreshed' | 'reused';
type PhaseResult = {
  status: PhaseStatus;
  refreshObserved: boolean;
  persistenceObserved: boolean;
};

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

async function containerPhase(
  phase: Phase,
  paths: { auth: string; config: string; providerEnv?: string; model: string },
): Promise<PhaseResult> {
  const docker = new Docker();
  const timer = setTimeout(() => docker.stop('SIGTERM'), phase === 'refresh' ? 120_000 : 45_000);
  try {
    const args = [
      'run',
      '--rm',
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
    docker.dispose();
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
    phases: [] as Array<{ phase: Phase; result: PhaseResult }>,
  };
  try {
    const paths = { auth, config, providerEnv, model };
    const probe = await containerPhase('probe', paths);
    receipt.phases.push({ phase: 'probe', result: probe });
    if (probe.status === 'pending_natural_expiry') receipt.outcome = 'pending_natural_expiry';
    else {
      const refresh = await containerPhase('refresh', paths);
      receipt.phases.push({ phase: 'refresh', result: refresh });
      if (refresh.status === 'pending_natural_expiry') receipt.outcome = 'pending_natural_expiry';
      else {
        const reuse = await containerPhase('reuse', paths);
        receipt.phases.push({ phase: 'reuse', result: reuse });
        receipt.outcome = 'passed';
      }
    }
  } catch {
    // Docker and provider error bodies never enter receipts or terminal output.
    receipt.outcome = 'failed';
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
