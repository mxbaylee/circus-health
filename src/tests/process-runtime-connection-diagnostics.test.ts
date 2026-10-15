import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Agent, request } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import test from 'node:test';
import {
  diagnosticRoute,
  observeRuntimeConnections,
} from './browser/runtime-connection-diagnostics.ts';

test('runtime connection receipt distinguishes a reused socket from its close without retaining identifiers', async (t) => {
  const server = createServer((_req, res) => res.end('ok'));
  const diagnostics = observeRuntimeConnections(server);
  let acceptedSocket: Socket | undefined;
  server.on('connection', (socket) => {
    acceptedSocket = socket;
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    agent.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  const path = '/api/profiles/p-secret-person/intakes/import-feed?token=private-query';
  const send = () =>
    new Promise<void>((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port, path, agent }, (response) => {
        response.resume();
        response.once('end', resolve);
      });
      outgoing.once('error', reject);
      outgoing.end();
    });
  await send();
  const firstSnapshot = diagnostics.snapshot();
  const firstSerialized = JSON.stringify(firstSnapshot);
  await send();
  assert.equal(JSON.stringify(firstSnapshot), firstSerialized);
  assert.equal(firstSnapshot.openSockets[0]!.requests, 1);
  const beforeClose = diagnostics.snapshot();
  const started = beforeClose.recent.filter((event) => event.event === 'request-start');
  assert.equal(started.length, 2);
  assert.equal(started[0]!.socketId, started[1]!.socketId);
  assert.deepEqual(
    started.map((event) => event.socketRequests),
    [1, 2],
  );
  assert.equal(beforeClose.activeRequestCount, 0);
  assert.equal(beforeClose.recent.filter((event) => event.event === 'response-finish').length, 2);
  assert.ok(beforeClose.keepAliveTimeoutMs > 0);
  assert.doesNotMatch(JSON.stringify(beforeClose), /secret-person|private-query|token/);

  assert.ok(acceptedSocket);
  const closed = once(acceptedSocket, 'close');
  agent.destroy();
  await closed;
  assert.equal(
    diagnostics.snapshot().recent.filter((event) => event.event === 'socket-close').length,
    1,
  );
});

test('runtime routes collapse unknown paths and opaque ids', () => {
  assert.equal(
    diagnosticRoute('/api/profiles/p-private/intakes/people/person%3Ahidden?name=private'),
    '/api/profiles/:profile/intakes/people/:id',
  );
  assert.equal(
    diagnosticRoute('/api/profiles/p-private/intakes/very-private-document'),
    '/api/profiles/:profile/intakes/:other',
  );
  assert.equal(diagnosticRoute('/private-file/secret'), '/other');
});

test('runtime connection receipt keeps an unfinished response distinct from a finished one', async (t) => {
  let answer!: (response: import('node:http').ServerResponse) => void;
  const accepted = new Promise<import('node:http').ServerResponse>((resolve) => {
    answer = resolve;
  });
  const server = createServer((_req, response) => answer(response));
  const diagnostics = observeRuntimeConnections(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  const outgoing = request({
    host: '127.0.0.1',
    port,
    path: '/api/profiles/p-private/intakes/people/person%3Aprivate',
  });
  outgoing.on('error', () => {});
  outgoing.end();
  const response = await accepted;
  assert.equal(diagnostics.snapshot().activeRequestCount, 1);
  const closed = once(response, 'close');
  outgoing.destroy();
  await closed;
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.activeRequestCount, 0);
  assert.equal(snapshot.recent.filter((event) => event.event === 'response-close').length, 1);
  assert.equal(snapshot.recent.filter((event) => event.event === 'response-finish').length, 0);
});
