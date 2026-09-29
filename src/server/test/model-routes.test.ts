import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createVaultApp } from '../vault-app.ts';

interface ConnectionTestResponse {
  data: { connectionTest: { capabilities: { tools: boolean } } };
}
interface SetupResponse {
  data: { setupId: string; recoveryKit: unknown };
}
interface ProfileResponse {
  data: { id: string };
}

test('setup uses the application proxy and retired agent attachment routes are unavailable', async (t) => {
  const env = {
    CRS_AI_BACKEND: 'litellm',
    CRS_AI_MODEL: 'fictional-route-alias',
    CRS_AI_BASE_URL: 'http://litellm:4000',
    CRS_AI_API_KEY: 'fictional-key',
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const nativeFetch = globalThis.fetch,
    contacted: Array<string | URL | Request> = [];
  t.after(() => {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  globalThis.fetch = async (url, init) => {
    contacted.push(url);
    const requestBody = init?.body;
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body');
    const body = JSON.parse(requestBody) as {
        messages: Array<{ role: string; content: string }>;
      },
      result = body.messages.find((message) => message.role === 'tool');
    const challengeMatch = /challenge ([a-f0-9-]+)/.exec(body.messages[1]?.content ?? '');
    assert.ok(challengeMatch);
    const challenge = challengeMatch[1];
    return new Response(
      JSON.stringify({
        model: env.CRS_AI_MODEL,
        choices: [
          {
            index: 0,
            finish_reason: result ? 'stop' : 'tool_calls',
            message: result
              ? { role: 'assistant', content: JSON.parse(result.content).response }
              : {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'fictional-call',
                      type: 'function',
                      function: {
                        name: 'health_connection_test',
                        arguments: JSON.stringify({ challenge }),
                      },
                    },
                  ],
                },
          },
        ],
      }),
    );
  };
  const base = mkdtempSync(join(tmpdir(), 'health-model-routes-')),
    dataDirectory = join(base, 'data');
  mkdirSync(dataDirectory);
  const app = createVaultApp({ dataDirectory, runtimeDirectory: join(base, 'runtime') });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => {
    app.close();
    rmSync(base, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:5173',
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let cookie = '';
  async function request<T>(path: string, method = 'GET', value?: unknown) {
    const response = await nativeFetch(baseUrl + path, {
      method,
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0] ?? '';
    return { status: response.status, body: (await response.json()) as T };
  }
  const setupTest = await request<ConnectionTestResponse>('/api/ai/test-connection', 'POST', {
    config: {
      backend: 'litellm',
      model: 'attacker-model',
      baseUrl: 'http://unapproved.test',
      apiKey: 'attacker-key',
    },
  });
  assert.equal(setupTest.status, 200);
  assert.equal(setupTest.body.data.connectionTest.capabilities.tools, true);
  assert.deepEqual(contacted, [
    'http://litellm:4000/v1/chat/completions',
    'http://litellm:4000/v1/chat/completions',
  ]);
  const setup = (
    await request<SetupResponse>('/api/profile-setups', 'POST', {
      fullName: 'Fictional route fixture',
      birthDate: '1982-04-17',
      name: 'Fictional route fixture',
    })
  ).body.data;
  const profile = (
    await request<ProfileResponse>(`/api/profile-setups/${setup.setupId}/verify`, 'POST', {
      acknowledged: true,
      recovery: setup.recoveryKit,
    })
  ).body.data;
  for (const [action, method] of [
    ['agent/connections', 'GET'],
    ['agent/connections', 'POST'],
    ['agent/connections', 'DELETE'],
    ['agent/mcp', 'POST'],
  ]) {
    const result = await request<unknown>(
      `/api/profiles/${profile.id}/${action}`,
      method,
      method === 'GET' ? undefined : {},
    );
    assert.equal(result.status, 404);
  }
});
