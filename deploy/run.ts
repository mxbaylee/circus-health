import { readBuildSource } from '../src/scripts/build-source.ts';
/** Docker Compose operator launcher. Secrets are never evaluated as shell input. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { homedir, constants } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { flockExclusiveNonblocking } from '../src/shared/flock.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROXY_IMAGE =
  'docker.io/litellm/litellm:1.99.1@sha256:a53a7d3ffebede1925bd3ee8a21e4a7b9b63e2e68ec883af136edcccb6eeb82c';
export const HELP = `Circus Health runs in Docker with LiteLLM.

CRS_DATA_DIR=/absolute/path/data CRS_MODEL=health-primary CRS_LITELLM_CONFIG=/absolute/path/litellm.yaml npm start

Optional: CRS_LITELLM_ENV_FILE=/absolute/path/provider.env (secrets passed only to LiteLLM)
          CRS_STATE_DIR=/absolute/path/state (default: ~/.local/state/circus-health)
          CRS_PORT=3001, CRS_RESPONSE_MODEL=exact-returned-model, CRS_IMAGES=true|false
          CRS_PDF=auto|true|false (default: auto; fictional connection check before private use)
          CRS_PROMPT_CACHE=true|false (opt-in; requires provider prompt-cache support)
          CRS_IMAGE=repository:tag (default: separate tag for each archive)
          CRS_IMPORT_DIAGNOSTICS=true (show metadata diagnostics; default: false)
CRS_STATE_DIR=/absolute/path/state npm run login:chatgpt
CRS_OAUTH_QUALIFICATION=1 CRS_OAUTH_OUTPUT_DIR=/absolute/path/receipts CRS_STATE_DIR=/absolute/path/state CRS_LITELLM_CONFIG=/absolute/path/litellm.yaml CRS_MODEL=health-primary npm run qualify:oauth
npm run image:build
CRS_DATA_DIR=/absolute/path/data npm run check:data
npm run icons

Prerequisites: Node 24, npm, Docker with Compose v2.30 or newer.
Source your external shell env file before launch; .env files are not loaded automatically.
Model/provider settings belong in your LiteLLM configuration. See docs/setup/installation.md and docs/setup/environment.md.
Ctrl-C stops both containers. Health data and proxy authentication survive recreation.
`;
type Environment = NodeJS.ProcessEnv;
const errno = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code;
const inside = (path: string, parent: string) => path === parent || path.startsWith(parent + sep);

/** Resolve symlinked ancestors even when the final directory does not exist yet. */
export function canonicalPath(path: string): string {
  const tail: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    if (lstatSafe(current)?.isSymbolicLink()) throw new Error('Path contains a dangling symlink.');
    tail.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) throw new Error('Could not resolve path.');
    current = parent;
  }
  return join(realpathSync(current), ...tail);
}
function lstatSafe(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errno(error, 'ENOENT')) return undefined;
    throw error;
  }
}
export function outsideGit(path: string): void {
  if (inside(path, ROOT))
    throw new Error(
      'Data, credentials and operator configuration must be outside Git repositories.',
    );
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(join(current, '.git')))
      throw new Error(
        'Data, credentials and operator configuration must be outside Git repositories.',
      );
    if (dirname(current) === current) break;
  }
}
export function external(
  value: string | undefined,
  label: string,
  {
    directory = false,
    data,
    create = false,
  }: { directory?: boolean; data?: string; create?: boolean } = {},
): string {
  if (!value || !isAbsolute(value))
    throw new Error(`${label} must be an absolute path outside Git.`);
  const path = canonicalPath(value);
  outsideGit(path);
  if (data && (inside(path, data) || (directory && inside(data, path))))
    throw new Error(`${label} must be separate from CRS_DATA_DIR.`);
  if (/[,\n\r]/u.test(path)) throw new Error(`${label} cannot contain commas or newlines.`);
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!existsSync(path) || !(directory ? statSync(path).isDirectory() : statSync(path).isFile()))
    throw new Error(`${label} must be an existing ${directory ? 'directory' : 'file'}.`);
  return path;
}
export function dataDirectory(env: Environment): string {
  const path = external(env.CRS_DATA_DIR, 'CRS_DATA_DIR', { directory: true });
  if (basename(path) !== 'data' || basename(env.CRS_DATA_DIR!) !== 'data')
    throw new Error('CRS_DATA_DIR and its resolved target must end in /data.');
  return path;
}
export function publicOrigin(env: Environment, port: string): string {
  const origin = env.CRS_PUBLIC_ORIGIN || `http://localhost:${port}`;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('CRS_PUBLIC_ORIGIN must be an exact HTTP(S) origin.');
  }
  // Exact syntax is required: URL normalization must not silently repair input.
  const match = /^(https?):\/\/([^/?#]+)$/u.exec(origin);
  if (
    !match ||
    url.username ||
    url.password ||
    match[2] !== match[2]!.toLowerCase() ||
    !url.hostname ||
    /[\s\\]/u.test(origin) ||
    url.port === '0'
  )
    throw new Error(
      'CRS_PUBLIC_ORIGIN must be an exact HTTP(S) origin without credentials, path, query or fragment.',
    );
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Non-local CRS_PUBLIC_ORIGIN must use HTTPS.');
  return origin;
}
export function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function durableCreate(path: string, contents: string | Buffer): void {
  const temporary = path + '.' + randomBytes(8).toString('hex');
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (!errno(error, 'EEXIST')) throw error;
    }
    syncDirectory(dirname(path));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export class Cancelled extends Error {
  signal: NodeJS.Signals;
  constructor(signal: NodeJS.Signals) {
    super('Stopped by user');
    this.signal = signal;
  }
}
export class Docker {
  binary: string;
  child: ChildProcess | undefined;
  signal: NodeJS.Signals | undefined;
  stoppedAt: number | undefined;
  cleaning = false;
  stopGraceMs = 20_000;
  terminateGraceMs = 5_000;
  killGraceMs = 5_000;
  cleanupTimeoutMs = 60_000;
  private listeners: Array<[NodeJS.Signals, () => void]> = [];
  constructor(binary = process.env.CRS_DOCKER || 'docker', listen = true) {
    this.binary = binary;
    if (listen)
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        const listener = () => this.stop(signal);
        process.on(signal, listener);
        this.listeners.push([signal, listener]);
      }
  }
  dispose(): void {
    for (const [signal, listener] of this.listeners) process.off(signal, listener);
  }
  forward(signal: NodeJS.Signals): void {
    if (!this.child?.pid) return;
    try {
      process.kill(-this.child.pid, signal);
    } catch (error) {
      if (!errno(error, 'ESRCH')) throw error;
    }
  }
  groupAlive(): boolean {
    if (!this.child?.pid) return false;
    try {
      process.kill(-this.child.pid, 0);
      return true;
    } catch (error) {
      if (errno(error, 'ESRCH')) return false;
      throw error;
    }
  }
  stop(signal: NodeJS.Signals): void {
    if (this.signal) return;
    this.signal = signal;
    this.stoppedAt = performance.now();
    if (!this.cleaning) this.forward(signal);
  }
  async run(
    args: string[],
    {
      env,
      capture = false,
      cleanup = false,
    }: { env?: Environment; capture?: boolean; cleanup?: boolean } = {},
  ): Promise<string> {
    if (this.signal && !cleanup) throw new Cancelled(this.signal);
    this.cleaning = cleanup;
    let deadline = cleanup ? performance.now() + this.cleanupTimeoutMs : undefined;
    let escalation = 0;
    let timedOut = false;
    let stdout = '';
    let done = false;
    let code: number | null = null;
    let spawnError: Error | undefined;
    try {
      this.child = spawn(this.binary, args, {
        cwd: ROOT,
        env,
        detached: true,
        stdio: cleanup ? 'ignore' : capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      });
      this.child.once('error', (error) => {
        spawnError = error;
        done = true;
      });
      this.child.once('exit', (exitCode) => {
        code = exitCode;
        done = true;
      });
      this.child.stdout?.on('data', (bytes) => {
        stdout += String(bytes);
      });
      // Drain stderr without echoing configuration or credentials in captured diagnostics.
      this.child.stderr?.resume();
      if (this.signal && !cleanup) this.forward(this.signal);
      while (true) {
        await delay(20);
        if (spawnError)
          throw new Error('Could not start Docker. Check its installation and executable path.');
        if (done && !this.groupAlive()) break;
        if (deadline === undefined) {
          if (this.stoppedAt !== undefined) deadline = this.stoppedAt + this.stopGraceMs;
          else if (done) deadline = performance.now() + this.stopGraceMs;
        }
        if (deadline === undefined || performance.now() < deadline) continue;
        timedOut = true;
        if (escalation === 0) {
          this.forward('SIGTERM');
          deadline = performance.now() + this.terminateGraceMs;
        } else if (escalation === 1) {
          this.forward('SIGKILL');
          deadline = performance.now() + this.killGraceMs;
        } else
          throw new Error(
            'Docker child process group did not exit after SIGKILL; inspect the owned Compose project.',
          );
        escalation++;
      }
      if (cleanup && (timedOut || code !== 0))
        throw new Error(
          'Compose cleanup did not complete successfully; containers may still be running. Inspect this archive’s Compose project before restarting.',
        );
      if (this.signal && !cleanup) throw new Cancelled(this.signal);
      if (timedOut)
        throw new Error(
          'Docker child processes required forced shutdown; inspect the owned Compose project.',
        );
      if (code !== 0)
        throw new Error(
          `Docker ${args[0]} failed (exit ${code}). Check Docker is running and the supplied configuration is valid.`,
        );
      return stdout;
    } finally {
      this.child = undefined;
      this.cleaning = false;
    }
  }
}
export function applicationImage(env: Environment, suffix: string): string {
  const image = env.CRS_IMAGE || 'circus-health:' + suffix;
  if (!/^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/u.test(image))
    throw new Error('CRS_IMAGE must be a local image repository and optional tag.');
  return image;
}

function kernelLock(path: string, busyMessage: string): { release(): void } {
  const fd = openSync(path, 'a+', 0o600);
  try {
    if (!flockExclusiveNonblocking(fd)) throw new Error(busyMessage);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let released = false;
  return {
    release() {
      if (!released) {
        released = true;
        closeSync(fd);
      }
    },
  };
}
export function acquireLauncherLock(data: string): { release(): void } {
  return kernelLock(
    join(data, '.health-launcher.lock'),
    'This data directory already has an active Docker launcher.',
  );
}
export function acquireOAuthStateLock(auth: string): { release(): void } {
  return kernelLock(
    join(auth, '.oauth-writer.lock'),
    'This OAuth state already has an active launcher, login or qualification writer.',
  );
}
export function lease(
  data: string,
  platform: NodeJS.Platform = process.platform,
): { release(): void } | undefined {
  if (!['darwin', 'linux'].includes(platform))
    throw new Error('Unsupported storage writer domain.');
  const lock = kernelLock(
    join(data, '.health-writer.lock'),
    'Durable data directory already has an active writer.',
  );
  try {
    const marker = join(data, '.health-writer-domain');
    durableCreate(marker, 'linux\n');
    const owner = readFileSync(marker, 'utf8').trim();
    if (owner === 'darwin' && platform === 'darwin') {
      const temporary = marker + '.' + randomBytes(8).toString('hex');
      try {
        durableCreate(temporary, 'linux\n');
        renameSync(temporary, marker);
        syncDirectory(data);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    } else if (owner !== 'linux')
      throw new Error(
        'Archive has an incompatible writer reservation; a reviewed storage handoff is required.',
      );
    // Docker Desktop's VM has a separate lock domain; hold the host lease on macOS.
    if (platform === 'linux') {
      lock.release();
      return undefined;
    }
    return lock;
  } catch (error) {
    lock.release();
    throw error;
  }
}

export async function main(
  action = process.argv[2] || 'help',
  env: Environment = { ...process.env },
  createDocker = () => new Docker(env.CRS_DOCKER || 'docker'),
): Promise<void> {
  if (action === 'help') {
    console.log(HELP);
    return;
  }
  if (!['run', 'build', 'check-data', 'login-chatgpt'].includes(action))
    throw new Error('Unknown command; use npm run help.');
  // Never silently fall back to a different archive/auth directory during migration.
  const oldLauncherKeys = new Set([
    'DATA_DIR',
    'STATE_DIR',
    'MODEL',
    'PORT',
    'LITELLM_CONFIG',
    'LITELLM_ENV_FILE',
    'RESPONSE_MODEL',
    'IMAGES',
    'PDF',
    'PROMPT_CACHE',
    'DOCKER',
    'LITELLM_CPUS',
    'LITELLM_PIDS_LIMIT',
  ]);
  for (const key of Object.keys(env)) {
    const replacement = /^(HEALTH_|CIRCUS_)/.test(key)
      ? key.replace(/^(HEALTH_|CIRCUS_)/, 'CRS_')
      : oldLauncherKeys.has(key)
        ? 'CRS_' + key
        : null;
    if (replacement && env[key] !== undefined && env[replacement] === undefined)
      throw new Error(
        `Rename ${key} to ${replacement}; legacy environment settings are no longer read.`,
      );
  }
  const obsolete = ['RUNTIME', 'AI', 'AI_URL', 'KEY_FILE', 'AUTH_DIR', 'ENV_FILE', 'STACK'].filter(
    (key) => env[key],
  );
  if (obsolete.length)
    throw new Error(
      `Retired options: ${obsolete.join(', ')}. Use CRS_MODEL and CRS_LITELLM_CONFIG; Circus Health only runs in Docker through LiteLLM.`,
    );
  if (action === 'check-data') {
    console.log(`Archive mount location valid: ${dataDirectory(env)}`);
    return;
  }
  const docker = createDocker();
  let oauthLock: { release(): void } | undefined;
  try {
    if (action === 'build') {
      const source = readBuildSource(ROOT);
      await docker.run([
        'build',
        '--build-arg',
        `CRS_BUILD_REVISION=${source.revision || 'unknown'}`,
        '--build-arg',
        `CRS_BUILD_WORKTREE=${source.worktree}`,
        '-t',
        applicationImage(env, 'build'),
        '.',
      ]);
      return;
    }
    if (action === 'login-chatgpt') {
      const data = env.CRS_DATA_DIR ? dataDirectory(env) : undefined;
      const state = external(
        env.CRS_STATE_DIR || join(homedir(), '.local/state/circus-health'),
        'CRS_STATE_DIR',
        { directory: true, data, create: true },
      );
      if (lstatSafe(join(state, 'chatgpt'))?.isSymbolicLink())
        throw new Error('CRS_STATE_DIR/chatgpt must be a directory, not a symlink.');
      const auth = external(join(state, 'chatgpt'), 'ChatGPT authentication', {
        directory: true,
        data,
        create: true,
      });
      chmodSync(state, 0o700);
      chmodSync(auth, 0o700);
      oauthLock = acquireOAuthStateLock(auth);
      console.log(
        'ChatGPT login: follow the device instructions in this terminal. Never share the code or token file.',
      );
      await docker.run([
        'run',
        '--rm',
        '--read-only',
        '--entrypoint',
        'python',
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
        '-e',
        'LITELLM_LOCAL_MODEL_COST_MAP=True',
        '-e',
        'CHATGPT_TOKEN_DIR=/var/lib/litellm/chatgpt',
        '-e',
        'CHATGPT_AUTH_FILE=auth.json',
        '--mount',
        `type=bind,source=${auth},target=/var/lib/litellm/chatgpt`,
        '--mount',
        `type=bind,source=${ROOT}/deploy/litellm/login.py,target=/opt/circus/login.py,readonly`,
        PROXY_IMAGE,
        '-u',
        '/opt/circus/login.py',
      ]);
      return;
    }
    const data = dataDirectory(env);
    const config = external(env.CRS_LITELLM_CONFIG, 'CRS_LITELLM_CONFIG', { data });
    const model = env.CRS_MODEL || '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model))
      throw new Error('CRS_MODEL must be an exact model_name alias from CRS_LITELLM_CONFIG.');
    const port = env.CRS_PORT || '3001';
    if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535)
      throw new Error('CRS_PORT must be an integer from 1 to 65535.');
    const origin = publicOrigin(env, port);
    // Never transfer a writer domain before Docker's daemon is available.
    await docker.run(['info', '--format', '{{.ServerVersion}}'], { capture: true });
    const state = external(
      env.CRS_STATE_DIR || join(homedir(), '.local/state/circus-health'),
      'CRS_STATE_DIR',
      { directory: true, data, create: true },
    );
    const auth = external(join(state, 'chatgpt'), 'ChatGPT authentication', {
      directory: true,
      data,
      create: true,
    });
    const key = join(state, 'proxy-key');
    oauthLock = acquireOAuthStateLock(auth);
    durableCreate(key, 'sk-' + randomBytes(32).toString('hex') + '\n');
    external(key, 'Proxy key', { data });
    if (lstatSync(key).isSymbolicLink() || !/^sk-[0-9a-f]{64}\n?$/u.test(readFileSync(key, 'utf8')))
      throw new Error(
        'CRS_STATE_DIR/proxy-key is invalid; preserve existing credentials and inspect the state directory.',
      );
    const emptyEnv = join(state, 'empty.env');
    durableCreate(emptyEnv, '');
    if (
      lstatSync(emptyEnv).isSymbolicLink() ||
      !statSync(emptyEnv).isFile() ||
      statSync(emptyEnv).size
    )
      throw new Error('CRS_STATE_DIR/empty.env must be an empty regular file.');
    const providerEnv = external(env.CRS_LITELLM_ENV_FILE || emptyEnv, 'CRS_LITELLM_ENV_FILE', {
      data,
    });
    const preflight = await docker.run(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--entrypoint',
        'python',
        '--env-file',
        providerEnv,
        '-e',
        'CRS_MODEL',
        '--mount',
        `type=bind,source=${config},target=/app/config.yaml,readonly`,
        '--mount',
        `type=bind,source=${ROOT}/deploy/litellm/configure.py,target=/opt/circus/configure.py,readonly`,
        PROXY_IMAGE,
        '/opt/circus/configure.py',
        'check',
      ],
      { env: { ...env, CRS_MODEL: model }, capture: true },
    );
    let settings: {
      error?: string;
      response_model?: string;
      images?: boolean;
      promptCache?: boolean;
    };
    try {
      settings = JSON.parse(preflight);
    } catch {
      throw new Error('Could not read LiteLLM preflight settings.');
    }
    if (!settings || typeof settings !== 'object')
      throw new Error('Could not read LiteLLM preflight settings.');
    if (settings.error) throw new Error(settings.error);
    const responseModel = env.CRS_RESPONSE_MODEL || settings.response_model || '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(responseModel))
      throw new Error('CRS_RESPONSE_MODEL must be an exact returned model identifier.');
    const images = env.CRS_IMAGES || String(settings.images);
    if (!['true', 'false'].includes(images)) throw new Error('CRS_IMAGES must be true or false.');
    const pdf = env.CRS_PDF || 'auto';
    if (!['auto', 'true', 'false'].includes(pdf))
      throw new Error('CRS_PDF must be true or false, or auto.');
    const promptCache = env.CRS_PROMPT_CACHE || String(settings.promptCache);
    if (!['true', 'false'].includes(promptCache))
      throw new Error('CRS_PROMPT_CACHE must be true or false.');
    const suffix = createHash('sha256').update(data).digest('hex').slice(0, 12);
    const source = readBuildSource(ROOT);
    const composeEnv = {
      ...env,
      CRS_DATA_DIR: data,
      CRS_STATE_DIR: state,
      CRS_BUILD_REVISION: source.revision || 'unknown',
      CRS_BUILD_WORKTREE: source.worktree,
      CRS_AUTH_DIR: auth,
      CRS_LITELLM_CONFIG: config,
      CRS_LITELLM_ENV_FILE: providerEnv,
      CRS_PROXY_KEY: key,
      CRS_MODEL: model,
      CRS_PORT: port,
      CRS_PUBLIC_ORIGIN: origin,
      CRS_RESPONSE_MODEL: responseModel,
      CRS_IMAGES: images,
      CRS_PDF: pdf,
      CRS_PROMPT_CACHE: promptCache,
      COMPOSE_PROJECT_NAME: 'circus-health-' + suffix,
      CRS_IMAGE: applicationImage(env, suffix),
    };
    const compose = ['compose', '--env-file', emptyEnv, '-f', join(ROOT, 'compose.yaml')];
    const launcherLock = acquireLauncherLock(data);
    let writerLock: { release(): void } | undefined;
    try {
      writerLock = lease(data);
      console.log(
        `Circus Health: ${origin} | LiteLLM model: ${model}\nProxy authentication state: ${state}`,
      );
      try {
        await docker.run([...compose, 'build', 'health'], { env: composeEnv });
        await docker.run(
          [
            ...compose,
            'run',
            '--rm',
            '--no-deps',
            '--entrypoint',
            'node',
            'health',
            '--input-type=module',
            '-e',
            "import {validateRuntimeDirectory} from './src/server/startup-rebuild.ts'; try { validateRuntimeDirectory(process.env.CRS_RUNTIME_DIR); } catch { console.error('Circus Health runtime filesystem preflight failed: CRS_RUNTIME_DIR must be an existing absolute directory on tmpfs. Check the Compose runtime mount.'); process.exit(1); }",
          ],
          { env: composeEnv },
        );
        await docker.run(
          [...compose, 'up', '--build', '--abort-on-container-exit', '--remove-orphans'],
          { env: composeEnv },
        );
      } finally {
        await docker.run([...compose, 'down', '--remove-orphans'], {
          env: composeEnv,
          cleanup: true,
        });
      }
    } finally {
      writerLock?.release();
      launcherLock.release();
    }
  } finally {
    oauthLock?.release();
    docker.dispose();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    if (error instanceof Cancelled) process.exitCode = 128 + constants.signals[error.signal];
    else {
      console.error(`Circus Health: ${error instanceof Error ? error.message : 'launch failed'}`);
      process.exitCode = 1;
    }
  });
