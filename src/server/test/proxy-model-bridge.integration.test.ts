import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ProxyModelBridge } from '../proxy-model-bridge.ts';

interface UpstreamRequest {
  model: string;
  messages: Array<{ role: string }>;
}
const docker = (...args: string[]) =>
  execFileSync(process.env.CRS_DOCKER || 'docker', args, {
    encoding: 'utf8',
    timeout: 30000,
  }).trim();
const image =
  'docker.io/litellm/litellm:1.99.1@sha256:a53a7d3ffebede1925bd3ee8a21e4a7b9b63e2e68ec883af136edcccb6eeb82c';

test(
  'pinned LiteLLM Proxy completes the OpenAI tool loop against a synthetic upstream',
  { skip: process.env.CRS_LITELLM_INTEGRATION_TEST !== '1', timeout: 150000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'health-litellm-proxy-'));
    const name = `circus-litellm-${randomUUID().slice(0, 8)}`;
    let server: Server | undefined,
      port: number,
      container = false;
    t.after(() => {
      if (container)
        spawnSync(process.env.CRS_DOCKER || 'docker', ['rm', '-f', name], {
          encoding: 'utf8',
          timeout: 10000,
        });
      server?.close();
      rmSync(root, { recursive: true, force: true });
    });
    const upstreamRequests: UpstreamRequest[] = [];
    server = createServer(async (request, response) => {
      let raw = '';
      for await (const part of request) raw += part;
      const body = JSON.parse(raw) as UpstreamRequest;
      upstreamRequests.push(body);
      const toolCall = !body.messages.some((message) => message.role === 'tool');
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          toolCall
            ? {
                id: 'chatcmpl-fictional',
                object: 'chat.completion',
                model: 'fictional-alias',
                choices: [
                  {
                    index: 0,
                    finish_reason: 'tool_calls',
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'call-1',
                          type: 'function',
                          function: {
                            name: 'health_connection_test',
                            arguments: '{"challenge":"fictional"}',
                          },
                        },
                      ],
                    },
                  },
                ],
                usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
              }
            : {
                id: 'chatcmpl-fictional',
                object: 'chat.completion',
                model: 'fictional-alias',
                choices: [
                  {
                    index: 0,
                    finish_reason: 'stop',
                    message: { role: 'assistant', content: 'Fictional answer.' },
                  },
                ],
                usage: { prompt_tokens: 16, completion_tokens: 4, total_tokens: 20 },
              },
        ),
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, '0.0.0.0', () => resolve()));
    port = (server.address() as AddressInfo).port;
    const config = join(root, 'config.yaml');
    writeFileSync(
      config,
      `model_list:\n  - model_name: fictional-alias\n    litellm_params:\n      model: openai/fictional-upstream\n      api_base: http://host.docker.internal:${port}/v1\n      api_key: os.environ/SYNTHETIC_PROVIDER_KEY\ngeneral_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\nlitellm_settings:\n  set_verbose: false\n  num_retries: 0\n`,
    );
    docker(
      'run',
      '--detach',
      '--rm',
      '--init',
      '--name',
      name,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev',
      '--add-host',
      'host.docker.internal:host-gateway',
      '--mount',
      `type=bind,source=${config},target=/app/config.yaml,readonly`,
      '--env',
      'LITELLM_MASTER_KEY=fictional-proxy-key',
      '--env',
      'SYNTHETIC_PROVIDER_KEY=fictional-provider-key',
      '--publish',
      '127.0.0.1::4000',
      image,
      '--config',
      '/app/config.yaml',
    );
    container = true;
    const proxyPort = docker('port', name, '4000/tcp').split(':').at(-1);
    const baseUrl = `http://127.0.0.1:${proxyPort}`;
    for (let attempt = 0; attempt < 240; attempt++) {
      try {
        if ((await fetch(`${baseUrl}/health/liveliness`)).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (attempt === 239) assert.fail(`LiteLLM did not become ready: ${docker('logs', name)}`);
    }
    const events: Array<{ method: string; params: Record<string, unknown> }> = [],
      calls: Array<{ tool: string; arguments: Record<string, unknown>; callId: string }> = [],
      errors: string[] = [];
    const bridge = new ProxyModelBridge({
      config: {
        backend: 'litellm',
        model: 'fictional-alias',
        baseUrl,
        apiKey: 'fictional-proxy-key',
        reasoning: null,
        images: false,
        pdf: false,
        promptCache: false,
        localOnly: false,
        resolvedModel: null,
        timeoutSeconds: 60,
      },
      onTool: async (call) => {
        calls.push(call);
        return { response: 'fictional only' };
      },
      onEvent: (method, params) => events.push({ method, params }),
      onExit: (error) => errors.push(error.message),
    });
    await bridge.start('Synthetic system instruction', [
      {
        type: 'function',
        name: 'health_connection_test',
        description: 'Synthetic only',
        inputSchema: {
          type: 'object',
          properties: { challenge: { type: 'string' } },
          required: ['challenge'],
          additionalProperties: false,
        },
      },
    ]);
    await bridge.turn('Use the fictional tool.');
    await bridge.completion;
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, [
      { tool: 'health_connection_test', arguments: { challenge: 'fictional' }, callId: 'call-1' },
    ]);
    assert.equal(upstreamRequests.length, 2);
    assert.equal(upstreamRequests[0].model, 'fictional-upstream');
    assert.equal(
      upstreamRequests[1].messages.some((message) => message.role === 'tool'),
      true,
    );
    assert.ok(events.some((event) => event.method === 'turn/completed'));
  },
);
