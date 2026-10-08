import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

type SocketState = { id: number; requests: number };
type RequestState = {
  id: number;
  socketId: number;
  socketRequests: number;
  method: string;
  path: string;
  started: number;
};
type Event = {
  event: 'socket-open' | 'socket-close' | 'request-start' | 'response-finish' | 'response-close';
  ageMs: number;
  socketId: number;
  socketRequests?: number;
  requestId?: number;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  hadError?: boolean;
};

const recentLimit = 32;
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
  const sockets = new WeakMap<Socket, SocketState>();
  const openSockets = new Map<number, SocketState>();
  const active = new Map<number, RequestState>();
  const recent: Array<Omit<Event, 'ageMs'> & { at: number }> = [];
  const record = (event: Omit<Event, 'ageMs'>) => {
    recent.push({ ...event, at: now() });
    if (recent.length > recentLimit) recent.shift();
  };
  const onConnection = (socket: Socket) => {
    if (sockets.has(socket)) return sockets.get(socket)!;
    const state = { id: ++nextSocketId, requests: 0 };
    sockets.set(socket, state);
    openSockets.set(state.id, state);
    record({ event: 'socket-open', socketId: state.id });
    socket.once('close', (hadError: boolean) => {
      openSockets.delete(state.id);
      record({ event: 'socket-close', socketId: state.id, hadError });
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
      method: method(req.method),
      path: diagnosticRoute(req.url),
      started: now(),
    };
    active.set(state.id, state);
    record({
      event: 'request-start',
      socketId: state.socketId,
      socketRequests: state.socketRequests,
      requestId: state.id,
      method: state.method,
      path: state.path,
    });
    let finished = false;
    res.once('finish', () => {
      finished = true;
      active.delete(state.id);
      record({
        event: 'response-finish',
        socketId: state.socketId,
        requestId: state.id,
        method: state.method,
        path: state.path,
        status: res.statusCode,
        durationMs: now() - state.started,
      });
    });
    res.once('close', () => {
      if (finished) return;
      active.delete(state.id);
      record({
        event: 'response-close',
        socketId: state.socketId,
        requestId: state.id,
        method: state.method,
        path: state.path,
        durationMs: now() - state.started,
      });
    });
  };
  // Passive events preserve Node's default timeout and client-error handling.
  server.on('connection', onConnection);
  server.prependListener('request', onRequest);
  return {
    snapshot() {
      const current = now();
      return {
        keepAliveTimeoutMs: server.keepAliveTimeout,
        headersTimeoutMs: server.headersTimeout,
        requestTimeoutMs: server.requestTimeout,
        totalSockets: nextSocketId,
        totalRequests: nextRequestId,
        openSocketCount: openSockets.size,
        openSockets: boundedValues(openSockets.values()).map((socket) => ({ ...socket })),
        activeRequestCount: active.size,
        activeRequests: boundedValues(active.values()).map((request) => ({
          requestId: request.id,
          socketId: request.socketId,
          socketRequests: request.socketRequests,
          method: request.method,
          path: request.path,
          durationMs: current - request.started,
        })),
        recent: recent.map(({ at, ...event }) => ({ ...event, ageMs: current - at })),
      };
    },
  };
}
