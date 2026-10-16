import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

type SocketState = { id: number; requests: number; remotePort?: number };
type RequestState = {
  id: number;
  socketId: number;
  socketRequests: number;
  diagnosticRequest?: number;
  remotePort?: number;
  method: string;
  path: string;
  started: number;
};
type Event = {
  event:
    | 'socket-open'
    | 'socket-close'
    | 'socket-timeout'
    | 'request-start'
    | 'response-finish'
    | 'response-close';
  ageMs: number;
  socketId: number;
  remotePort?: number;
  diagnosticRequest?: number;
  socketRequests?: number;
  requestId?: number;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  hadError?: boolean;
};

const recentLimit = 32;
const activeLimit = 64;
const openLimit = 64;
export function diagnosticRequestNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^(?:[1-9]\d{0,8}|1000000000)$/.test(value)) return undefined;
  const selected = Number(value);
  return Number.isSafeInteger(selected) && selected <= 1_000_000_000 ? selected : undefined;
}
export function diagnosticPort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
    ? value
    : undefined;
}
function boundedValues<T>(values: Iterable<T>): T[] {
  const selected: T[] = [];
  for (const value of values) {
    selected.push(value);
    if (selected.length === 12) break;
  }
  return selected;
}

const method = (value: string | undefined) =>
  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(value || '')
    ? value!
    : 'OTHER';

/** Never retain profile IDs, arbitrary URL segments, queries, headers or bodies. */
export function diagnosticRoute(rawUrl: string | undefined): string {
  let parts: string[];
  try {
    parts = new URL(rawUrl || '/', 'http://localhost').pathname.split('/').filter(Boolean);
  } catch {
    return '/other';
  }
  if (parts[0] === 'api' && parts[1] === 'runtime') return '/api/runtime';
  if (parts[0] !== 'api' || parts[1] !== 'profiles' || parts.length < 4) return '/other';
  if (parts[3] === 'import-diagnostics') return '/api/profiles/:profile/import-diagnostics';
  if (parts[3] !== 'intakes') return '/api/profiles/:profile/:other';
  const action = parts[4];
  if (action === 'import-feed' || action === 'people-apply' || action === 'report-acceptance')
    return `/api/profiles/:profile/intakes/${action}`;
  if (action === 'people') return '/api/profiles/:profile/intakes/people/:id';
  return '/api/profiles/:profile/intakes/:other';
}

export function observeRuntimeConnections(server: Server, now = Date.now) {
  let nextSocketId = 0;
  let nextRequestId = 0;
  let currentOpenSockets = 0;
  let currentActiveRequests = 0;
  let openSocketOverflow = 0;
  let activeRequestOverflow = 0;
  let observationFailures = 0;
  const sockets = new WeakMap<Socket, SocketState>();
  const openSockets = new Map<number, SocketState>();
  const active = new Map<number, RequestState>();
  const recent: Array<Omit<Event, 'ageMs'> & { at: number }> = [];
  const readNow = () => {
    try {
      const value = now();
      if (Number.isFinite(value)) return value;
    } catch {}
    observationFailures = Math.min(observationFailures + 1, 1_000_000_000);
    return 0;
  };
  const record = (event: Omit<Event, 'ageMs'>) => {
    recent.push({ ...event, at: readNow() });
    if (recent.length > recentLimit) recent.shift();
  };
  const onConnection = (socket: Socket) => {
    if (sockets.has(socket)) return sockets.get(socket)!;
    const state = {
      id: ++nextSocketId,
      requests: 0,
      remotePort: diagnosticPort(socket.remotePort),
    };
    sockets.set(socket, state);
    currentOpenSockets++;
    if (openSockets.size < openLimit) openSockets.set(state.id, state);
    else openSocketOverflow = Math.min(openSocketOverflow + 1, 1_000_000_000);
    record({ event: 'socket-open', socketId: state.id, remotePort: state.remotePort });
    socket.on('timeout', () => {
      record({ event: 'socket-timeout', socketId: state.id, remotePort: state.remotePort });
    });
    socket.once('close', (hadError: boolean) => {
      currentOpenSockets--;
      openSockets.delete(state.id);
      record({ event: 'socket-close', socketId: state.id, remotePort: state.remotePort, hadError });
    });
    return state;
  };
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const socket = onConnection(req.socket);
    socket.requests++;
    const state: RequestState = {
      id: ++nextRequestId,
      socketId: socket.id,
      socketRequests: socket.requests,
      remotePort: socket.remotePort,
      diagnosticRequest: diagnosticRequestNumber(req.headers['x-crs-test-request']),
      method: method(req.method),
      path: diagnosticRoute(req.url),
      started: readNow(),
    };
    currentActiveRequests++;
    if (active.size < activeLimit) active.set(state.id, state);
    else activeRequestOverflow = Math.min(activeRequestOverflow + 1, 1_000_000_000);
    record({
      event: 'request-start',
      socketId: state.socketId,
      socketRequests: state.socketRequests,
      remotePort: state.remotePort,
      diagnosticRequest: state.diagnosticRequest,
      requestId: state.id,
      method: state.method,
      path: state.path,
    });
    let finished = false;
    res.once('finish', () => {
      finished = true;
      currentActiveRequests--;
      active.delete(state.id);
      record({
        event: 'response-finish',
        socketId: state.socketId,
        remotePort: state.remotePort,
        diagnosticRequest: state.diagnosticRequest,
        requestId: state.id,
        method: state.method,
        path: state.path,
        status: res.statusCode,
        durationMs: readNow() - state.started,
      });
    });
    res.once('close', () => {
      if (finished) return;
      currentActiveRequests--;
      active.delete(state.id);
      record({
        event: 'response-close',
        socketId: state.socketId,
        remotePort: state.remotePort,
        diagnosticRequest: state.diagnosticRequest,
        requestId: state.id,
        method: state.method,
        path: state.path,
        durationMs: readNow() - state.started,
      });
    });
  };
  // Passive events preserve Node's default timeout and client-error handling.
  server.on('connection', onConnection);
  server.prependListener('request', onRequest);
  return {
    snapshot() {
      const current = readNow();
      return {
        keepAliveTimeoutMs: server.keepAliveTimeout,
        headersTimeoutMs: server.headersTimeout,
        requestTimeoutMs: server.requestTimeout,
        totalSockets: nextSocketId,
        totalRequests: nextRequestId,
        openSocketCount: currentOpenSockets,
        openSocketOverflow,
        openSockets: boundedValues(openSockets.values()).map((socket) => ({ ...socket })),
        activeRequestCount: currentActiveRequests,
        activeRequestOverflow,
        observationFailures,
        activeRequests: boundedValues(active.values()).map((request) => ({
          requestId: request.id,
          socketId: request.socketId,
          socketRequests: request.socketRequests,
          remotePort: request.remotePort,
          diagnosticRequest: request.diagnosticRequest,
          method: request.method,
          path: request.path,
          durationMs: current - request.started,
        })),
        recent: recent.map(({ at, ...event }) => ({ ...event, ageMs: current - at })),
      };
    },
  };
}
