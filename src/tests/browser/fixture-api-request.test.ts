import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { request, type Page } from 'playwright';
import { fetchFixtureApi } from './fixture-api-request.ts';
import { fixtureApi } from './native-intake-fixture.ts';
import { stopFixtureImport } from './manual-import-fixture.ts';

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

test('fixture close cannot prevent reuse of a socket pooled by an earlier default fetch', async (t) => {
  const seen: { socket: number; connection: string | undefined }[] = [];
  const fixture = await loopback(t, (req, res) => {
    seen.push({ socket: fixture.socketId(req.socket)!, connection: req.headers.connection });
    res.end('fictional');
  });
  const context = await request.newContext();
  t.after(() => context.dispose());

  assert.equal((await context.fetch(fixture.url)).status(), 200);
  assert.equal((await fetchFixtureApi(context, fixture.url)).status(), 200);
  assert.equal((await fetchFixtureApi(context, fixture.url)).status(), 200);
  assert.deepEqual(seen, [
    { socket: 1, connection: 'keep-alive' },
    { socket: 1, connection: 'close' },
    { socket: 2, connection: 'close' },
  ]);
});

test('manual import fixture stops matching batches in order on separate closing connections', async (t) => {
  const id = 'fictional / intake?';
  const prefix = '/api/profiles/fictional-profile';
  const intake = { id, version: 7, state: 'review_required' };
  const seen: {
    socket: number;
    connection: string | undefined;
    method: string | undefined;
    path: string | undefined;
    origin: string | undefined;
    cookie: string | undefined;
    body: string;
  }[] = [];
  const fixture = await loopback(t, (req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      seen.push({
        socket: fixture.socketId(req.socket)!,
        connection: req.headers.connection,
        method: req.method,
        path: req.url,
        origin: req.headers.origin,
        cookie: req.headers.cookie,
        body: Buffer.concat(parts).toString('utf8'),
      });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === prefix + '/intake-batches') {
        res.setHeader('Set-Cookie', 'fictional_session=ready; Path=/');
        res.end(
          JSON.stringify({
            data: [
              { id: 'fictional-unrelated', items: [{ intakeId: 'fictional-other' }] },
              { id: 'fictional-first', items: [{ intakeId: id }, { intakeId: 'fictional-other' }] },
              { id: 'fictional-second', items: [{ intakeId: id }] },
            ],
          }),
        );
      } else if (req.url === prefix + '/intakes/' + encodeURIComponent(id)) {
        res.end(JSON.stringify({ data: intake }));
      } else {
        res.end(JSON.stringify({ data: { stopped: true } }));
      }
    });
  });
  const context = await request.newContext();
  t.after(() => context.dispose());

  assert.deepEqual(
    await stopFixtureImport({ request: context } as Page, fixture.url, prefix, id),
    intake,
  );
  assert.deepEqual(seen, [
    {
      socket: 1,
      connection: 'close',
      method: 'GET',
      path: prefix + '/intake-batches',
      origin: undefined,
      cookie: undefined,
      body: '',
    },
    {
      socket: 2,
      connection: 'close',
      method: 'POST',
      path: prefix + '/intake-batches/fictional-first/stop',
      origin: fixture.url,
      cookie: 'fictional_session=ready',
      body: '{}',
    },
    {
      socket: 3,
      connection: 'close',
      method: 'POST',
      path: prefix + '/intake-batches/fictional-second/stop',
      origin: fixture.url,
      cookie: 'fictional_session=ready',
      body: '{}',
    },
    {
      socket: 4,
      connection: 'close',
      method: 'GET',
      path: prefix + '/intakes/' + encodeURIComponent(id),
      origin: undefined,
      cookie: 'fictional_session=ready',
      body: '',
    },
  ]);
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

test('native intake fixture API uses fresh connections without changing its data envelope', async (t) => {
  const seen: {
    socket: number;
    connection: string | undefined;
    method: string | undefined;
    origin: string | undefined;
    body: string;
  }[] = [];
  const fixture = await loopback(t, (req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      seen.push({
        socket: fixture.socketId(req.socket)!,
        connection: req.headers.connection,
        method: req.method,
        origin: req.headers.origin,
        body: Buffer.concat(parts).toString('utf8'),
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { fictional: true } }));
    });
  });
  const context = await request.newContext();
  t.after(() => context.dispose());
  const api = fixtureApi({ request: context } as Page, fixture.url);
  assert.deepEqual(await api('/fictional'), { fictional: true });
  assert.deepEqual(await api('/fictional', { value: 'fictional' }), { fictional: true });
  assert.deepEqual(seen, [
    { socket: 1, connection: 'close', method: 'GET', origin: undefined, body: '' },
    {
      socket: 2,
      connection: 'close',
      method: 'POST',
      origin: fixture.url,
      body: JSON.stringify({ value: 'fictional' }),
    },
  ]);
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
