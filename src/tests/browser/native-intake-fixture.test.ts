import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Page, Response } from 'playwright';
import { fixtureNativeFeedWindowReady } from './native-intake-fixture.ts';

const prefix = '/api/profiles/fictional';
function fixture() {
  const events = new EventEmitter();
  const frame = {};
  const page = Object.assign(events, {
    mainFrame: () => frame,
    waitForResponse: () => {
      throw Error('Expected an already observed current response');
    },
  }) as unknown as Page;
  const response = (
    startTime: number,
    totalRecords: number,
    options: { method?: string; end?: number; navigation?: boolean } = {},
  ) => {
    const request = {
      method: () => options.method ?? 'GET',
      url: () => 'http://fictional.test' + prefix + '/intakes/import-feed',
      timing: () => ({ startTime, responseEnd: options.end ?? 1 }),
      isNavigationRequest: () => options.navigation === true,
    };
    return {
      request: () => request,
      url: request.url,
      status: () => 200,
      finished: async () => null,
      json: async () => ({ data: { format: 'health-intake-import-feed-v2', totalRecords } }),
    } as unknown as Response;
  };
  const observe = (selected: Response) => {
    events.emit('request', selected.request());
    events.emit('response', selected);
  };
  const closed = () => {
    for (const name of ['request', 'response', 'framenavigated'])
      assert.equal(events.listenerCount(name), 0);
  };
  return { events, frame, page, response, observe, closed };
}

test('feed readiness excludes reads begun before the completed mutation response', async () => {
  const f = fixture(),
    start = Date.now() + 100;
  const selected = await fixtureNativeFeedWindowReady(f.page, prefix, async () => {
    f.observe(f.response(start + 10, 1));
    f.observe(f.response(start + 101, 2));
    return f.response(start, 0, { method: 'POST', end: 100 });
  });
  assert.equal(selected.totalRecords, 2);
  f.closed();
});

test('feed readiness excludes a prior document even when its request began later', async () => {
  const f = fixture(),
    start = Date.now() + 100;
  const selected = await fixtureNativeFeedWindowReady(f.page, prefix, async () => {
    f.observe(f.response(start + 20, 1));
    f.events.emit('framenavigated', f.frame);
    f.observe(f.response(start + 10, 2));
    return f.response(start, 0, { navigation: true });
  });
  assert.equal(selected.totalRecords, 2);
  f.closed();
});

test('feed readiness refuses unavailable mutation timing and removes its observers', async () => {
  const f = fixture();
  await assert.rejects(
    fixtureNativeFeedWindowReady(f.page, prefix, async () =>
      f.response(Date.now(), 0, { method: 'POST', end: -1 }),
    ),
    /mutation response completed/,
  );
  f.closed();
});
