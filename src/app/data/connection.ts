import { useSyncExternalStore } from 'react';

export type ConnectionState = {
  status: 'checking' | 'connected' | 'reconnecting' | 'unavailable';
  reason: 'network' | 'http' | 'invalid' | null;
  httpStatus: number | null;
  buildId: string | null;
  checks: number;
  recoveries: number;
};
let state: ConnectionState = {
  status: 'checking',
  reason: null,
  httpStatus: null,
  buildId: null,
  checks: 0,
  recoveries: 0,
};
const listeners = new Set<() => void>();
export const connectionSnapshot = () => state;
export function subscribeConnection(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const useConnection = () =>
  useSyncExternalStore(subscribeConnection, connectionSnapshot, connectionSnapshot);
let users = 0,
  failures = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | null = null;
export const connectionMonitorActive = () => users > 0;
function publish(next: Partial<ConnectionState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}
function schedule() {
  if (!users) return;
  const delay =
    document.visibilityState === 'hidden'
      ? 60000
      : failures
        ? Math.min(30000, 2000 * 2 ** Math.min(failures - 1, 4))
        : 15000;
  timer = setTimeout(() => {
    void checkConnection();
  }, delay);
}
/** This probe deliberately bypasses profile API requests and their read recovery. */
export async function checkConnection() {
  if (!users || request) return;
  clearTimeout(timer);
  const controller = new AbortController();
  request = controller;
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/api/runtime', { cache: 'no-store', signal: controller.signal });
    const runtime = await response.json().catch(() => null);
    if (request !== controller || !users) return;
    const buildId =
      typeof runtime?.buildId === 'string' && runtime.buildId ? runtime.buildId : null;
    if (!response.ok || typeof runtime?.encrypted !== 'boolean') {
      failures++;
      publish({
        status: 'unavailable',
        reason: response.ok ? 'invalid' : 'http',
        httpStatus: response.status,
        ...(buildId ? { buildId } : {}),
        checks: state.checks + 1,
      });
    } else {
      const recovered = state.status === 'reconnecting' || state.status === 'unavailable';
      failures = 0;
      publish({
        status: 'connected',
        reason: null,
        httpStatus: null,
        buildId,
        checks: state.checks + 1,
        recoveries: state.recoveries + Number(recovered),
      });
    }
  } catch {
    if (request !== controller || !users) return;
    failures++;
    publish({
      status: 'reconnecting',
      reason: 'network',
      httpStatus: null,
      checks: state.checks + 1,
    });
  } finally {
    clearTimeout(timeout);
    if (request === controller) {
      request = null;
      schedule();
    }
  }
}
export function startConnectionMonitor() {
  users++;
  if (users === 1) {
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    window.addEventListener('offline', wake);
    document.addEventListener('visibilitychange', visible);
    void checkConnection();
  }
  return () => {
    if (--users) return;
    clearTimeout(timer);
    const pending = request;
    request = null;
    pending?.abort();
    window.removeEventListener('focus', wake);
    window.removeEventListener('online', wake);
    window.removeEventListener('offline', wake);
    document.removeEventListener('visibilitychange', visible);
  };
}
function wake() {
  void checkConnection();
}
function visible() {
  if (document.visibilityState !== 'hidden') wake();
}

/** A bounded read can wait for the next successful independent server probe. */
export function waitForConnection(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const after = state.checks;
    const finish = (error?: unknown) => {
      unsubscribe();
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new DOMException('Read cancelled.', 'AbortError'));
    const unsubscribe = subscribeConnection(() => {
      if (state.status === 'connected' && state.checks > after) finish();
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else void checkConnection();
  });
}
