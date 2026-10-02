import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from './database.ts';
import type { StartupProgress, StartupReceipt, RebuildStartupResult } from './startup-rebuild.ts';
import { createReadStream, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createApp, type AppOptions } from './index.ts';
import { openDatabase, REPO_ROOT } from './database.ts';
import { attachPersonalDurability } from './portable.ts';
import { acquireStorageLock } from './storage-lock.ts';
import {
  validateDataDirectory,
  validateRuntimeDirectory,
  recordStartupMetrics,
} from './startup-rebuild.ts';
import { createVaultApp } from './vault-app.ts';
import type { ImportDiagnostics } from './import-diagnostics.ts';
import { readBuildIdentity } from './build-identity.ts';
import { writeChat } from './assistant-journal.ts';

interface RuntimeOptions {
  dataDirectory?: string;
  runtimeDirectory?: string;
  codeRoot?: string;
  port?: number;
  host?: string;
  profileIds?: string[];
  assistantOptions?: AppOptions['assistantOptions'];
  diagnostics?: ImportDiagnostics;
  lockFactory?: typeof acquireStorageLock;
}
interface RuntimeStatus {
  ready: boolean;
  outcome: string;
  phase: string;
  encrypted?: boolean;
  startup?: StartupReceipt | { totalMs: number; profiles: number; rebuildPolicy: string };
}
interface StartupMessage {
  progress?: StartupProgress;
  failure?: string;
  result?: RebuildStartupResult;
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function staticFile(req: IncomingMessage, res: ServerResponse, staticRoot: string) {
  const path = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname);
  let file = resolve(staticRoot, '.' + path);
  const safe = (candidate: string) => {
    const rel = relative(realpathSync(staticRoot), realpathSync(candidate));
    return !rel.startsWith('..') && !isAbsolute(rel);
  };
  if (!existsSync(file) || !statSync(file).isFile()) file = resolve(staticRoot, 'index.html');
  if (!safe(file)) {
    json(res, 404, { error: 'Not found' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': mime[extname(file)] || 'application/octet-stream',
    'Content-Length': statSync(file).size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}
export async function startLegacyRuntime({
  dataDirectory = process.env.CRS_DATA_DIR,
  runtimeDirectory = process.env.CRS_RUNTIME_DIR || '/run/health',
  codeRoot = REPO_ROOT,
  port = Number(process.env.CRS_PORT) || 3001,
  host = '0.0.0.0',
  profileIds,
  assistantOptions,
  lockFactory = acquireStorageLock,
}: RuntimeOptions = {}) {
  const buildIdentity = readBuildIdentity(codeRoot);
  const startupStarted = performance.now();
  const root = validateDataDirectory(dataDirectory, []);
  validateRuntimeDirectory(runtimeDirectory);
  const lease = await lockFactory(dataDirectory!);
  let leaseHealthy = true;
  let app: ReturnType<typeof createApp> | null | undefined,
    worker: Worker | undefined,
    closing = false;
  let status: RuntimeStatus = { ready: false, outcome: 'starting', phase: 'initialize' };
  const server = createServer((req, res) => {
    try {
      if (!/^((127\.0\.0\.1)|(localhost))(:\d+)?$/.test(req.headers.host || '')) {
        json(res, 403, { error: 'Local access only' });
        return;
      }
      const path = new URL(req.url!, 'http://localhost').pathname;
      if (path === '/health/ready' || path === '/api/runtime') {
        json(res, status.ready ? 200 : 503, { ...status, ...buildIdentity });
        return;
      }
      if (!app || !status.ready) {
        json(res, 503, status);
        return;
      }
      if (path.startsWith('/api/')) app.server.emit('request', req, res);
      else if (['GET', 'HEAD'].includes(req.method!))
        staticFile(req, res, resolve(codeRoot, 'src/dist'));
      else json(res, 405, { error: 'Method not allowed' });
    } catch {
      json(res, 500, { error: 'The local service could not complete this request' });
    }
  });
  const close = async () => {
    if (closing) return;
    closing = true;
    status.ready = false;
    if (worker) await worker.terminate();
    await new Promise<void>((done) => server.close(() => done()));
    app?.close();
    await lease.release();
  };
  lease.failure.catch((error) => {
    // Invalidate already-forwarded requests immediately. Waiting for a POST
    // body to drain would let it mutate after another process took the lock.
    leaseHealthy = false;
    status = { ready: false, outcome: 'failure', phase: 'writer_lock' };
    app?.close();
    app = null;
    server.closeAllConnections();
    console.error(error.message);
    void close();
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(port, host, done);
    });
    worker = new Worker(new URL('./startup-worker.ts', import.meta.url), {
      workerData: {
        dataDirectory,
        runtimeDirectory,
        codeRoot,
        ...(profileIds ? { profileIds } : {}),
      },
    });
    const ready = new Promise<RuntimeStatus>((done, reject) => {
      worker!.on('message', (message: StartupMessage) => {
        if (message.progress) {
          status = message.progress;
          console.log(JSON.stringify({ startup: status }));
        }
        if (message.failure) {
          status = { ...status, ready: false, outcome: 'failure' };
          reject(new Error(message.failure));
        }
        if (message.result) {
          const databases = new Map<string, Database>();
          const receipt = message.result.receipt,
            openStarted = performance.now();
          try {
            for (const [profileId, path] of message.result.databases) {
              const db = openDatabase(path, profileId);
              databases.set(profileId, db);
              const durability = attachPersonalDurability(db, {
                root,
                profileId,
                initialize: false,
              });
              if (durability!.dirty || durability!.conflicted)
                throw new Error('Durable startup state could not be attached');
            }
            if (!leaseHealthy || closing) throw new Error('Durable storage lock is no longer held');
            const publicPort =
              Number(process.env.CRS_PUBLIC_PORT) || (server.address() as AddressInfo).port;
            app = createApp({
              root,
              databaseDirectory: resolve(runtimeDirectory, 'managed-profiles'),
              runtimeRoot: runtimeDirectory,
              databases,
              port: publicPort,
              allowedOrigins: [
                `http://127.0.0.1:${publicPort}`,
                `http://localhost:${publicPort}`,
                ...(process.env.CRS_DEV === '1'
                  ? ['http://127.0.0.1:5173', 'http://localhost:5173']
                  : []),
              ],
              assistantOptions: {
                ...assistantOptions,
                journalWriter(...args) {
                  if (!leaseHealthy) throw new Error('Durable storage lock is no longer held');
                  return (assistantOptions?.journalWriter || writeChat)(...args);
                },
              },
            });
            receipt.rebuildMs = receipt.totalMs;
            receipt.openMs = performance.now() - openStarted;
            receipt.totalMs = performance.now() - startupStarted;
            receipt.peakMemoryBytes = Math.max(
              receipt.peakMemoryBytes,
              process.resourceUsage().maxRSS * 1024,
            );
            recordStartupMetrics(root, receipt);
            status = { ready: true, outcome: 'success', phase: 'ready', startup: receipt };
            done(status);
          } catch (error) {
            for (const db of databases.values()) db.close();
            receipt.outcome = 'failure';
            receipt.failedPhase = 'open';
            receipt.failureCode = 'STARTUP_OPEN_FAILED';
            receipt.totalMs = performance.now() - startupStarted;
            try {
              recordStartupMetrics(root, receipt);
            } catch {}
            status = { ready: false, outcome: 'failure', phase: 'open' };
            reject(error);
          }
        }
      });
      worker!.once('error', reject);
      worker!.once('exit', (code) => {
        if (code && !closing) reject(new Error('Startup worker exited before validation'));
      });
    });
    ready.catch(() => {});
    return {
      server,
      ready,
      close,
      get status() {
        return status;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export async function startRuntime({
  dataDirectory = process.env.CRS_DATA_DIR,
  runtimeDirectory = process.env.CRS_RUNTIME_DIR || '/run/health',
  codeRoot = REPO_ROOT,
  port = Number(process.env.CRS_PORT) || 3001,
  host = '0.0.0.0',
  assistantOptions,
  diagnostics,
  lockFactory = acquireStorageLock,
}: RuntimeOptions = {}) {
  const buildIdentity = readBuildIdentity(codeRoot);
  const started = performance.now();
  validateDataDirectory(dataDirectory, []);
  validateRuntimeDirectory(runtimeDirectory);
  const lease = await lockFactory(dataDirectory!);
  const publicOrigin = process.env.CRS_PUBLIC_ORIGIN;
  const origins = [
    `http://127.0.0.1:${Number(process.env.CRS_PUBLIC_PORT) || port}`,
    `http://localhost:${Number(process.env.CRS_PUBLIC_PORT) || port}`,
    ...(process.env.CRS_DEV === '1' ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : []),
    ...(publicOrigin ? [publicOrigin] : []),
  ];
  let app: ReturnType<typeof createVaultApp> | undefined,
    closeTask: Promise<void> | undefined,
    finishClosed!: (status: RuntimeStatus) => void;
  const closed = new Promise<RuntimeStatus>((done) => {
    finishClosed = done;
  });
  let status: RuntimeStatus = { ready: false, outcome: 'starting', phase: 'public_profiles' };
  const server = createServer((req, res) => {
    try {
      const hostHeader = req.headers.host || '';
      if (
        !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(hostHeader) &&
        !origins.some((origin) => new URL(origin).host === hostHeader)
      ) {
        json(res, 403, { error: 'Host not allowed' });
        return;
      }
      const path = new URL(req.url!, 'http://localhost').pathname;
      if (path === '/health/ready' || path === '/api/runtime') {
        json(res, status.ready ? 200 : 503, { ...status, ...buildIdentity });
        return;
      }
      if (!app || !status.ready) {
        json(res, 503, status);
        return;
      }
      if (path.startsWith('/api/')) app.server.emit('request', req, res);
      else if (['GET', 'HEAD'].includes(req.method!))
        staticFile(req, res, resolve(codeRoot, 'src/dist'));
      else json(res, 405, { error: 'Method not allowed' });
    } catch {
      json(res, 500, { error: 'The local service could not complete this request' });
    }
  });
  function close() {
    if (!closeTask) {
      closeTask = (async () => {
        status.ready = false;
        server.closeAllConnections();
        try {
          app?.close();
          await new Promise<void>((done) => server.close(() => done()));
        } finally {
          await lease.release();
        }
      })();
      closeTask.then(
        () => finishClosed(status),
        () => {
          status = {
            ready: false,
            outcome: 'failure',
            phase: status.phase === 'writer_lock' ? 'writer_lock' : 'shutdown',
          };
          finishClosed(status);
        },
      );
    }
    return closeTask;
  }
  lease.failure.catch(() => {
    status = { ready: false, outcome: 'failure', phase: 'writer_lock' };
    void close();
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(port, host, done);
    });
    const actualPort = (server.address() as AddressInfo).port;
    if (port === 0)
      origins.push(`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`);
    app = createVaultApp({
      dataDirectory: dataDirectory!,
      runtimeDirectory,
      port: actualPort,
      allowedOrigins: origins,
      assistantOptions,
      diagnostics,
    });
    status = {
      ready: true,
      outcome: 'success',
      phase: 'ready',
      encrypted: true,
      startup: {
        totalMs: performance.now() - started,
        profiles: app.manager.list().length,
        rebuildPolicy: 'selected-profile-on-unlock',
      },
    };
    return {
      server,
      ready: Promise.resolve(status),
      closed,
      close,
      get status() {
        return status;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime();
    process.once('SIGTERM', () => {
      process.exitCode = 143;
      void runtime!.close();
    });
    process.once('SIGINT', () => {
      process.exitCode = 130;
      void runtime!.close();
    });
    await runtime.ready;
    console.log(
      `Circus Health ready at http://localhost:${(runtime.server.address() as AddressInfo).port}`,
    );
    const stopped = await runtime.closed;
    if (stopped.outcome === 'failure')
      throw Error(
        stopped.phase === 'writer_lock'
          ? 'Durable storage writer lock was lost'
          : 'Runtime shutdown failed',
      );
  } catch (error) {
    console.error('Circus Health startup failed:', (error as Error).message);
    await runtime?.close();
    process.exitCode = 1;
  }
}
