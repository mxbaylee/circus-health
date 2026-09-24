import {
  beginClientOperation,
  recordClientPhase,
  recordClientRequest,
} from './import-performance.ts';
import { uploadWithProgress } from './upload-transport.ts';
import { recordDurability } from './durability.ts';
import {
  clearBrowserImportDiagnostics,
  diagnosticRoute,
  recordBrowserImportDiagnostic,
} from './import-diagnostics.ts';
import { readWithRecovery, separateReadGeneration } from './read-recovery.ts';
import { connectionSnapshot, subscribeConnection } from './connection.ts';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  currentProfile,
  currentProfiles,
  recordProfile,
  replaceProfiles,
  subscribeProfileIdentity,
  useProfile,
} from './profile.ts';

export type ApiResponse<T> = { data: T; meta?: Record<string, unknown> };
subscribeProfileIdentity(clearBrowserImportDiagnostics);
let writes = 0;
const writeListeners = new Set<() => void>();
export const pendingApiWrites = () => writes;
export const usePendingApiWrites = () =>
  useSyncExternalStore(
    (listener) => {
      writeListeners.add(listener);
      return () => {
        writeListeners.delete(listener);
      };
    },
    pendingApiWrites,
    pendingApiWrites,
  );
function recordWrite(change: number) {
  writes += change;
  writeListeners.forEach((listener) => listener());
}
export class ApiError extends Error {
  public code: string;
  public status: number;

  constructor(message: string, code = 'REQUEST_FAILED', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function apiUrl(path: string): string {
  if (path === '/profiles' || path === '/api/profiles') return '/api/profiles';
  const profile = currentProfile();
  if (!profile) throw new ApiError('Choose a local profile first.', 'NO_PROFILE');
  const prefix = `/api/profiles/${encodeURIComponent(profile.id)}`;
  if (path.startsWith('/api/profiles/')) {
    if (!path.startsWith(`${prefix}/`))
      throw new ApiError('This resource belongs to a different profile.', 'PROFILE_MISMATCH');
    return path;
  }
  return `${prefix}${path.startsWith('/api/') ? path.slice(4) : path.startsWith('/') ? path : `/${path}`}`;
}

export interface ApiOptions extends RequestInit {
  operationId?: string;
  onUploadProgress?: (sent: number, total: number | null) => void;
}
export async function api<T>(path: string, options: ApiOptions = {}): Promise<ApiResponse<T>> {
  const { operationId, onUploadProgress, ...requestOptions } = options;
  const profileId = currentProfile()?.id;
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');
  const controller = new AbortController();
  const cancellation = { reason: 'transport' as 'caller' | 'profile_changed' | 'transport' };
  const abort = () => {
    cancellation.reason = 'caller';
    controller.abort();
  };
  const profileAbort = () => {
    cancellation.reason = 'profile_changed';
    controller.abort();
  };
  const unsubscribe =
    path === '/profiles' || path === '/api/profiles'
      ? () => {}
      : subscribeProfileIdentity(profileAbort);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const requestId = crypto.randomUUID();
  const route = diagnosticRoute(path);
  const method = (options.method || 'GET').toUpperCase();
  const started = performance.now();
  let serverRequestId: string | undefined;
  headers.set('X-Client-Request-ID', requestId);
  if (operationId) headers.set('X-Client-Operation-ID', operationId);
  recordClientRequest(operationId, requestId);
  let headersAt: number | undefined;
  recordBrowserImportDiagnostic({
    at: new Date().toISOString(),
    event: 'api.started',
    requestId,
    route,
    method,
  });
  const read = (!options.method || options.method.toUpperCase() === 'GET') && !options.body;
  if (!read) {
    separateReadGeneration();
    recordWrite(1);
  }
  try {
    const transportOptions = { ...requestOptions, headers, signal: controller.signal };
    const response =
      onUploadProgress && typeof XMLHttpRequest !== 'undefined'
        ? await uploadWithProgress(apiUrl(path), transportOptions, onUploadProgress, () =>
            recordClientPhase(operationId, 'upload_transfer', started),
          )
        : await (read ? readWithRecovery : fetch)(apiUrl(path), transportOptions);
    headersAt = performance.now();
    recordClientPhase(operationId, 'api_wait', started, headersAt);
    const receivedId = response.headers.get('X-Request-ID');
    if (receivedId && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(receivedId)) {
      serverRequestId = receivedId;
      recordClientRequest(operationId, receivedId);
    }
    const payload = await response.json().catch(() => null);
    recordClientPhase(operationId, 'response_decode', headersAt);
    if (path !== '/profiles' && path !== '/api/profiles' && profileId !== currentProfile()?.id)
      throw new ApiError('Profile changed before this request completed.', 'PROFILE_CHANGED');
    if (!response.ok) {
      if (
        response.status === 423 &&
        payload?.error?.code === 'PROFILE_LOCKED' &&
        profileId &&
        currentProfile()?.id === profileId
      ) {
        replaceProfiles(
          currentProfiles().map((profile) =>
            profile.id === profileId ? { ...profile, locked: true } : profile,
          ),
        );
      }
      throw new ApiError(
        payload?.error?.message ?? `Request failed (${response.status}).`,
        payload?.error?.code,
        response.status,
      );
    }
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'data'))
      throw new ApiError(
        'The server returned an unexpected response.',
        'INVALID_RESPONSE',
        response.status,
      );
    recordDurability(profileId, payload.meta?.durability);
    recordProfile(profileId, payload.meta?.profile);
    recordBrowserImportDiagnostic({
      at: new Date().toISOString(),
      event: 'api.completed',
      requestId,
      serverRequestId,
      route,
      method,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
    });
    return payload as ApiResponse<T>;
  } catch (cause) {
    if (headersAt === undefined) recordClientPhase(operationId, 'api_wait', started);
    const cancelled =
      // A confirmed server rejection can itself revoke this profile and abort
      // other requests. Keep its actionable status/code instead of replacing it
      // with a generic cancellation caused by that same local revocation.
      !(cause instanceof ApiError && cause.status > 0) &&
      (controller.signal.aborted || (cause instanceof Error && cause.name === 'AbortError'));
    const code =
      cause instanceof ApiError && /^[A-Z][A-Z0-9_]{0,60}$/.test(cause.code)
        ? cause.code
        : cancelled
          ? 'REQUEST_CANCELLED'
          : 'REQUEST_FAILED';
    recordBrowserImportDiagnostic({
      at: new Date().toISOString(),
      event: cancelled ? 'api.cancelled' : 'api.failed',
      requestId,
      serverRequestId,
      route,
      method,
      code,
      durationMs: Math.round(performance.now() - started),
      ...(cause instanceof ApiError ? { status: cause.status } : {}),
      ...(cancelled ? { cancellation: cancellation.reason } : {}),
    });
    if (cancelled) {
      const error = new ApiError(
        cancellation.reason === 'profile_changed'
          ? 'Profile changed or locked before this request completed. Completed work is kept.'
          : 'This request was interrupted before its result was confirmed. Check the saved state before retrying.',
        cancellation.reason === 'profile_changed' ? 'PROFILE_CHANGED' : 'REQUEST_CANCELLED',
      );
      error.name = 'AbortError';
      throw error;
    }
    throw cause;
  } finally {
    if (!read) {
      separateReadGeneration();
      recordWrite(-1);
    }
    unsubscribe();
    options.signal?.removeEventListener('abort', abort);
  }
}

export type Resource<T> = {
  data: T | null;
  meta: Record<string, unknown> | undefined;
  loading: boolean;
  refreshing?: boolean;
  error: ApiError | null;
  reload: () => void;
};
export function useResource<T>(path: string | null, performanceKind?: 'review_open'): Resource<T> {
  const profile = useProfile();
  const key = `${profile?.id ?? ''}:${path ?? ''}`;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<Omit<Resource<T>, 'reload'> & { key: string }>({
    data: null,
    meta: undefined,
    loading: !!path,
    error: null,
    key,
  });
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let recovery = connectionSnapshot().recoveries;
    return subscribeConnection(() => {
      const next = connectionSnapshot().recoveries;
      if (next !== recovery) {
        recovery = next;
        if (path) reload();
      }
    });
  }, [path, reload]);
  useEffect(() => {
    if (!path) {
      setState({ data: null, meta: undefined, loading: false, error: null, key });
      return;
    }
    const controller = new AbortController();
    const operation = performanceKind ? beginClientOperation(performanceKind) : undefined;
    setState((previous) =>
      previous.key === key
        ? {
            ...previous,
            loading: previous.data === null,
            refreshing: previous.data !== null,
            error: null,
          }
        : { data: null, meta: undefined, loading: true, error: null, key },
    );
    api<T>(path, { signal: controller.signal, operationId: operation?.operationId })
      .then((response) => {
        const data = response.data as unknown;
        if (operation && data && typeof data === 'object') {
          const blocks = (data as { blocks?: Array<{ records?: unknown[] }> }).blocks;
          const rows = Array.isArray(data)
            ? data.length
            : Array.isArray(blocks)
              ? blocks.reduce(
                  (sum, block) => sum + (Array.isArray(block.records) ? block.records.length : 0),
                  0,
                )
              : undefined;
          if (rows !== undefined) operation.counts({ rows });
        }
        if (!controller.signal.aborted)
          setState({
            ...response,
            meta: response.meta,
            loading: false,
            refreshing: false,
            error: null,
            key,
          });
        operation?.afterRender(controller.signal.aborted ? 'cancelled' : 'completed');
      })
      .catch((error) => {
        operation?.afterRender(controller.signal.aborted ? 'cancelled' : 'failed');
        if (!controller.signal.aborted)
          setState((previous) => ({
            data: previous.key === key ? previous.data : null,
            meta: previous.key === key ? previous.meta : undefined,
            loading: false,
            refreshing: false,
            error:
              error instanceof ApiError ? error : new ApiError('Unable to reach the local server.'),
            key,
          }));
      });
    return () => {
      controller.abort();
      operation?.finish('cancelled');
    };
  }, [path, key, revision, performanceKind]);
  // Never expose the preceding resource while the next URL is loading.
  return state.key === key
    ? { ...state, reload }
    : { data: null, meta: undefined, loading: !!path, error: null, reload };
}

export function queryString(values: Record<string, string | number | boolean | null | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  return query.toString();
}
