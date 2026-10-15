import test from 'node:test';
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter, once } from 'node:events';
import { Agent, createServer, get, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request as playwrightRequest } from 'playwright';
import {
  diagnosticPort,
  diagnosticRequestNumber,
  observeRuntimeConnections,
} from './runtime-connection-diagnostics.ts';
import { observeFixtureClientConnections } from './runtime-client-connection-diagnostics.ts';

test('diagnostic correlation accepts only bounded integer tags and ports', () => {
  for (const value of ['', '0', '01', '-1', '1.1', '1000000001', 'private', ['1'], 1])
    assert.equal(diagnosticRequestNumber(value), undefined);
  assert.equal(diagnosticRequestNumber('100000000'), 100000000);
  assert.equal(diagnosticRequestNumber('1000000000'), 1000000000);
  for (const value of [0, -1, 65536, 1.5, '1234', Number.NaN])
    assert.equal(diagnosticPort(value), undefined);
  assert.equal(diagnosticPort(65535), 65535);
});

test('client channel observation is bounded and removes listeners on cancellation', () => {
  const observer = observeFixtureClientConnections(4242);
  const requests = Array.from({ length: 20 }, (_, index) => {
    const request = new EventEmitter() as ClientRequest;
    Object.assign(request, {
      protocol: 'http:',
      host: '127.0.0.1',
      path: '/private-query?secret-value',
      headers: { cookie: 'secret-cookie' },
      getHeader: (name: string) => (name === 'host' ? '127.0.0.1:4242' : String(index + 1)),
    });
    channel('http.client.request.start').publish({ request });
    return request;
  });
  const snapshot = observer.snapshot();
  assert.equal(snapshot.activeCount, 16);
  assert.equal(snapshot.overCapacity, 4);
  assert.equal(snapshot.recent.length, 16);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-query|secret-value|secret-cookie/);
  observer.close();
  assert.equal(observer.snapshot().activeCount, 0);
  assert.ok(requests.every((request) => request.listenerCount('socket') === 0));
  assert.ok(requests.every((request) => request.listenerCount('close') === 0));
});

test('real loopback requests correlate numeric ports without owning server timeouts', async (t) => {
  const server = createServer((req, res) => {
    if (req.headers['x-crs-test-request'] === '4') req.socket.destroy();
    else res.end('fictional');
  });
  server.keepAliveTimeout = 2500;
  server.keepAliveTimeoutBuffer = 0;
  const serverObserver = observeRuntimeConnections(server);
  assert.equal(server.listenerCount('timeout'), 0);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const clientObserver = observeFixtureClientConnections(port);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => {
    clientObserver.close();
    agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const request = (tag: number) =>
    new Promise<void>((resolve, reject) => {
      let ended = false;
      let closed = false;
      const complete = () => {
        if (ended && closed) resolve();
      };
      const outgoing = get(
        { host: '127.0.0.1', port, agent, headers: { 'X-CRS-Test-Request': String(tag) } },
        (response) => {
          response.resume();
          response.once('end', () => {
            ended = true;
            complete();
          });
        },
      );
      outgoing.once('error', reject);
      outgoing.once('close', () => {
        closed = true;
        complete();
      });
    });
  const firstFree = once(agent, 'free');
  await request(1);
  await firstFree;
  const secondFree = once(agent, 'free');
  await request(2);
  await secondFree;
  const client = clientObserver.snapshot();
  const serverEvents = serverObserver.snapshot().recent;
  const first = client.recent.find(
    (event) => event.event === 'socket-assigned' && event.diagnosticRequest === 1,
  );
  const second = client.recent.find(
    (event) => event.event === 'socket-assigned' && event.diagnosticRequest === 2,
  );
  assert.ok(first?.localPort);
  assert.equal(second?.localPort, first.localPort);
  assert.equal(second?.reusedSocket, true);
  assert.ok(
    serverEvents.some(
      (event) =>
        event.event === 'request-start' &&
        event.diagnosticRequest === 2 &&
        event.remotePort === second.localPort,
    ),
  );
  const context = await playwrightRequest.newContext();
  try {
    const response = await context.fetch(`http://127.0.0.1:${port}`, {
      headers: { 'X-CRS-Test-Request': '3' },
    });
    assert.equal(response.status(), 200);
    assert.equal(
      clientObserver.snapshot(3).matched,
      true,
      'Playwright uses the observed Node HTTP channel',
    );
    assert.ok(
      serverObserver
        .snapshot()
        .recent.some((event) => event.event === 'request-start' && event.diagnosticRequest === 3),
    );
  } finally {
    await context.dispose();
  }
  const resetCode = await new Promise<string | undefined>((resolve) => {
    let code: string | undefined;
    const outgoing = get({
      host: '127.0.0.1',
      port,
      agent,
      headers: { 'X-CRS-Test-Request': '4' },
    });
    outgoing.once('error', (error: NodeJS.ErrnoException) => {
      code = error.code;
    });
    outgoing.once('close', () => resolve(code));
  });
  assert.equal(resetCode, 'ECONNRESET');
  const reset = clientObserver.snapshot(4);
  assert.equal(reset.activeCount, 0);
  assert.ok(
    reset.recent.some(
      (event) =>
        event.event === 'socket-assigned' &&
        event.localPort === first.localPort &&
        event.reusedSocket === true,
    ),
  );
  assert.ok(
    reset.recent.some((event) => event.event === 'request-error' && event.error === 'ECONNRESET'),
  );
  assert.ok(
    serverObserver
      .snapshot()
      .recent.some(
        (event) =>
          event.event === 'request-start' &&
          event.diagnosticRequest === 4 &&
          event.remotePort === first.localPort,
      ),
  );
  const fifthFree = once(agent, 'free');
  await request(5);
  await fifthFree;
  const socket = agent.freeSockets[`127.0.0.1:${port}:`]?.[0];
  assert.ok(socket);
  await once(socket, 'close');
  assert.equal(server.listenerCount('timeout'), 0);
  assert.ok(serverObserver.snapshot().recent.some((event) => event.event === 'socket-timeout'));
});
