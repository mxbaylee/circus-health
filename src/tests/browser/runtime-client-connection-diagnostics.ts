import { channel } from 'node:diagnostics_channel';
import type { ClientRequest } from 'node:http';
import { Socket } from 'node:net';
import { diagnosticPort, diagnosticRequestNumber } from './runtime-connection-diagnostics.ts';

type ClientEvent = {
  event: 'request-start' | 'socket-assigned' | 'request-error' | 'request-close';
  diagnosticRequest: number;
  localPort?: number;
  reusedSocket?: boolean;
  error?: 'ECONNRESET' | 'OTHER';
  at: number;
};
type ActiveRequest = {
  diagnosticRequest: number;
  localPort?: number;
  reusedSocket?: boolean;
  cleanup: () => void;
};

const activeLimit = 16;
const recentLimit = 32;

/** Test-only observation; the channel callback never changes a request or its socket. */
export function observeFixtureClientConnections(port: number, now = Date.now) {
  if (diagnosticPort(port) !== port) throw Error('invalid diagnostic runtime port');
  const observed = channel('http.client.request.start');
  const errors = channel('http.client.request.error');
  const active = new Map<number, ActiveRequest>();
  const requestTags = new WeakMap<ClientRequest, number>();
  const recent: ClientEvent[] = [];
  let closed = false;
  let overCapacity = 0;
  let observationFailures = 0;
  const record = (event: Omit<ClientEvent, 'at'>) => {
    recent.push({ ...event, at: now() });
    if (recent.length > recentLimit) recent.shift();
  };
  const onStart = (message: unknown) => {
    let pendingCleanup: (() => void) | undefined;
    try {
      if (closed || !message || typeof message !== 'object' || !('request' in message)) return;
      const request = message.request as ClientRequest;
      if (
        !request ||
        typeof request.getHeader !== 'function' ||
        request.protocol !== 'http:' ||
        request.host !== '127.0.0.1' ||
        request.getHeader('host') !== `127.0.0.1:${port}`
      )
        return;
      const diagnosticRequest = diagnosticRequestNumber(request.getHeader('x-crs-test-request'));
      if (diagnosticRequest === undefined) return;
      if (active.size >= activeLimit || active.has(diagnosticRequest)) {
        overCapacity = Math.min(overCapacity + 1, 1_000_000_000);
        return;
      }
      let socket: Socket | undefined;
      let assigned = false;
      const state: ActiveRequest = { diagnosticRequest, cleanup };
      const onConnect = () => {
        try {
          if (!socket) return;
          state.localPort = diagnosticPort(socket.localPort);
          record({
            event: 'socket-assigned',
            diagnosticRequest,
            localPort: state.localPort,
            reusedSocket: state.reusedSocket,
          });
        } catch {
          observationFailures = Math.min(observationFailures + 1, 1_000_000_000);
        }
      };
      const onSocket = (candidate: unknown) => {
        try {
          if (assigned || !(candidate instanceof Socket)) return;
          assigned = true;
          socket = candidate;
          state.reusedSocket = request.reusedSocket === true;
          if (socket.connecting) socket.once('connect', onConnect);
          else onConnect();
        } catch {
          observationFailures = Math.min(observationFailures + 1, 1_000_000_000);
        }
      };
      const onClose = () => {
        try {
          record({
            event: 'request-close',
            diagnosticRequest,
            localPort: state.localPort,
            reusedSocket: state.reusedSocket,
          });
        } catch {
          observationFailures = Math.min(observationFailures + 1, 1_000_000_000);
        } finally {
          try {
            cleanup();
          } catch {
            observationFailures = Math.min(observationFailures + 1, 1_000_000_000);
          }
        }
      };
      function cleanup() {
        request.off('socket', onSocket);
        request.off('close', onClose);
        socket?.off('connect', onConnect);
        requestTags.delete(request);
        active.delete(diagnosticRequest!);
      }
      pendingCleanup = cleanup;
      active.set(diagnosticRequest, state);
      requestTags.set(request, diagnosticRequest);
      record({ event: 'request-start', diagnosticRequest });
      request.on('socket', onSocket);
      request.on('close', onClose);
      if (request.socket) onSocket(request.socket);
    } catch {
      try {
        pendingCleanup?.();
      } catch {}
      observationFailures = Math.min(observationFailures + 1, 1_000_000_000);
    }
  };
  const onError = (message: unknown) => {
    try {
      if (closed || !message || typeof message !== 'object' || !('request' in message)) return;
      const diagnosticRequest = requestTags.get(message.request as ClientRequest);
      if (diagnosticRequest === undefined) return;
      const state = active.get(diagnosticRequest);
      if (!state) return;
      const error = 'error' in message ? message.error : undefined;
      record({
        event: 'request-error',
        diagnosticRequest,
        localPort: state.localPort,
        reusedSocket: state.reusedSocket,
        error:
          error && typeof error === 'object' && 'code' in error && error.code === 'ECONNRESET'
            ? 'ECONNRESET'
            : 'OTHER',
      });
    } catch {
      observationFailures = Math.min(observationFailures + 1, 1_000_000_000);
    }
  };
  observed.subscribe(onStart);
  errors.subscribe(onError);
  return {
    snapshot(diagnosticRequest?: number) {
      const current = now();
      const selected =
        diagnosticRequest === undefined
          ? recent
          : recent.filter((event) => event.diagnosticRequest === diagnosticRequest);
      return {
        matched: selected.length > 0,
        activeCount: active.size,
        overCapacity,
        observationFailures,
        recent: selected.map(({ at, ...event }) => ({ ...event, ageMs: current - at })),
      };
    },
    close() {
      if (closed) return;
      closed = true;
      observed.unsubscribe(onStart);
      errors.unsubscribe(onError);
      for (const state of active.values()) state.cleanup();
      active.clear();
    },
  };
}
