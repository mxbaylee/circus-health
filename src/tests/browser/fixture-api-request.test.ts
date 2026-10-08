import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { request } from 'playwright';
import { fetchFixtureApi } from './fixture-api-request.ts';

async function loopback(
  t: TestContext,
  handle: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handle);
  const socketIds = new WeakMap<Socket, number>();
  let nextSocketId = 0;
  server.on('connection', (socket) => socketIds.set(socket, ++nextSocketId));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    socketId: (socket: Socket) => socketIds.get(socket),
  };
}

test('Playwright default fixture fetch reuses a completed connection', async (t) => {
  const sockets: number[] = [];
  const fixture = await loopback(t, (req, res) => {
    sockets.push(fixture.socketId(req.socket)!);
    res.end('fictional');
  });
  const context = await request.newContext();
  t.after(() => context.dispose());

  assert.equal((await context.fetch(fixture.url)).status(), 200);
  assert.equal((await context.fetch(fixture.url)).status(), 200);
  assert.deepEqual(sockets, [1, 1]);
});

test('fixture fetch closes each connection and preserves request and response semantics', async (t) => {
  const seen: {
    socket: number;
    connection: string | undefined;
    method: string | undefined;
    cookie: string | undefined;
    origin: string | undefined;
    body: string;
  }[] = [];
  const fixture = await loopback(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        socket: fixture.socketId(req.socket)!,
        connection: req.headers.connection,
        method: req.method,
        cookie: req.headers.cookie,
        origin: req.headers.origin,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === '/session') {
        res.setHeader('Set-Cookie', 'fictional_session=ready; Path=/');
        res.end('ready');
      } else {
        res.statusCode = 409;
        res.end('fictional conflict');
      }
    });
  });
  const context = await request.newContext();
  t.after(() => context.dispose());

  const first = await fetchFixtureApi(context, `${fixture.url}/session`);
  assert.equal(first.status(), 200);
  const options = {
    method: 'POST',
    headers: { Origin: fixture.url, connection: 'keep-alive' },
    data: 'fictional payload',
    failOnStatusCode: false,
  };
  const second = await fetchFixtureApi(context, `${fixture.url}/conflict`, options);
  assert.equal(second.status(), 409);
  assert.equal(await second.text(), 'fictional conflict');
  assert.deepEqual(
    seen.map(({ socket, connection }) => ({ socket, connection })),
    [
      { socket: 1, connection: 'close' },
      { socket: 2, connection: 'close' },
    ],
  );
  assert.equal(seen[1]?.method, 'POST');
  assert.equal(seen[1]?.cookie, 'fictional_session=ready');
  assert.equal(seen[1]?.origin, fixture.url);
  assert.equal(seen[1]?.body, 'fictional payload');
  assert.equal(options.headers.connection, 'keep-alive');
});

test('fixture fetch propagates an active socket reset without retrying', async (t) => {
  let requests = 0;
  const fixture = await loopback(t, (req) => {
    requests += 1;
    req.socket.destroy();
  });
  const context = await request.newContext();
  t.after(() => context.dispose());

  await assert.rejects(fetchFixtureApi(context, fixture.url), /ECONNRESET|socket hang up/);
  assert.equal(requests, 1);
});

test('disposing the context aborts a held fixture fetch', async (t) => {
  let requests = 0;
  let requestEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    requestEntered = resolve;
  });
  const fixture = await loopback(t, () => {
    requests += 1;
    requestEntered();
  });
  const context = await request.newContext();
  const rejected = assert.rejects(fetchFixtureApi(context, fixture.url));
  await entered;
  await context.dispose();
  await rejected;
  assert.equal(requests, 1);
});
