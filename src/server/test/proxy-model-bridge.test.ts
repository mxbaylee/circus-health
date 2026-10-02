import { markModelToolTerminalError, ModelToolValidationError } from '../model-tool-validation.ts';
import { ModelContextLimitError, ModelError } from '../model-config.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProxyModelBridge,
  localProxyTransport,
  proxyCapabilities,
  proxyConfig,
  proxyRequest,
  proxyRetryAfterMs,
} from '../proxy-model-bridge.ts';
import type { HealthTool, ProxyConfig, ProxyModelBridgeOptions } from '../proxy-model-bridge.ts';
import { createImportDiagnostics, measureImportPhase } from '../import-diagnostics.ts';
import { requestInputComposition } from '../request-input-composition.ts';
import {
  compactConsumedProxyHistory,
  compactIntakeReadResult,
  proxyTranscriptLimit,
  proxyTranscriptSize,
} from '../proxy-transcript.ts';

type JsonRecord = Record<string, unknown>;
type ToolRequest = Parameters<NonNullable<ProxyModelBridgeOptions['onTool']>>[0];
type Reply =
  unknown | ((url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>);
interface HarnessOptions {
  config?: ProxyConfig;
  beforeRequest?: ProxyModelBridgeOptions['beforeRequest'];
  retryDelay?: ProxyModelBridgeOptions['retryDelay'];
  onTool?: (request: ToolRequest) => unknown | Promise<unknown>;
  resolveHost?: ProxyModelBridgeOptions['resolveHost'];
  diagnostics?: ProxyModelBridgeOptions['diagnostics'];
  diagnosticContext?: ProxyModelBridgeOptions['diagnosticContext'];
}
interface ContentPart {
  type?: string;
  text?: string;
  cache_control?: { type: string };
  image_url?: { url: string };
  file?: { filename: string; file_data: string };
}
interface WireMessage extends JsonRecord {
  role: string;
  content: string | ContentPart[] | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}
const textContent = (message: WireMessage | undefined): string =>
  typeof message?.content === 'string' ? message.content : '';
interface WireRequest extends JsonRecord {
  model: string;
  messages: WireMessage[];
  tools: Array<{ function: { name: string } }>;
}
type CapturedRequestInit = RequestInit & {
  body: string;
  headers: Record<string, string>;
};
interface BridgeHarness {
  bridge: ProxyModelBridge;
  requests: Array<{
    url: string | URL | Request;
    init: CapturedRequestInit;
    body: WireRequest;
  }>;
  events: Array<{ method: string; params: JsonRecord }>;
  calls: ToolRequest[];
  errors: string[];
  diagnostics: JsonRecord[];
}
const errorText = (error: unknown): string => (error instanceof Error ? error.message : '');

const tool = {
  type: 'function',
  name: 'health_read',
  description: 'Read scoped fictional evidence',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', maxLength: 30 } },
    required: ['id'],
    additionalProperties: false,
  },
} satisfies HealthTool;
const intakeBatchTool = {
  type: 'function',
  name: 'health_intake_batch',
  description: 'Submit a fictional durable intake batch.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      version: { type: 'integer' },
      planId: { type: 'string' },
      operationId: { type: 'string' },
      jsonlText: { type: 'string', maxLength: 1000000 },
      summary: { type: 'string' },
      coverage: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            unitId: { type: 'string' },
            kind: { type: 'string' },
            notes: { type: 'string' },
          },
          required: ['unitId', 'kind', 'notes'],
          additionalProperties: false,
        },
      },
    },
    required: ['id', 'version', 'planId', 'operationId', 'jsonlText', 'summary', 'coverage'],
    additionalProperties: false,
  },
} satisfies HealthTool;
const intakeReadTool = {
  type: 'function',
  name: 'health_intake_read',
  description: 'Read a bounded page of fictional retained evidence.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, page: { type: 'integer' } },
    required: ['id', 'page'],
    additionalProperties: false,
  },
} satisfies HealthTool;
// Stands in for INTAKE_SCHEMA_INSTRUCTIONS, which every read result repeats.
// Independently fictional; the sentinel is what proves the block is really gone.
const fictionalSchemaInstructions =
  'FICTIONAL_SCHEMA_SENTINEL one fictional JSON object per nonempty line. ' +
  'Fictional schema clause. '.repeat(1200);
const fictionalReadResult = (page: number) => ({
  instructions: fictionalSchemaInstructions,
  mappingRules: { count: 0, version: 'fictional-rules-version', section: 'mapping_rules' },
  intake: { id: 'intake:fictional', page },
  original: {
    page,
    totalPages: 9,
    nextPage: page + 1,
    text:
      `FICTIONAL_PAGE_TEXT_SENTINEL page ${page}. ` +
      `Fictional printed line on page ${page}. `.repeat(500),
    offset: 0,
    nextOffset: null,
    complete: false,
  },
});
const intakeReadReplies = (pages: number[]) =>
  pages.map((page) => ({
    model: 'fictional-proxy-alias',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `read-call-${page}`,
              type: 'function',
              function: {
                name: 'health_intake_read',
                arguments: JSON.stringify({ id: 'intake:fictional', page }),
              },
            },
          ],
        },
      },
    ],
  }));
const config = (extra: NodeJS.ProcessEnv = {}) =>
  proxyConfig({
    CRS_AI_MODEL: 'fictional-proxy-alias',
    CRS_AI_BASE_URL: 'http://proxy.test:4000',
    CRS_AI_API_KEY: 'fictional-proxy-key',
    ...extra,
  });
const json = (value: unknown) => new Response(JSON.stringify(value));
const toolCall = {
  model: 'fictional-proxy-alias',
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
            function: { name: 'health_read', arguments: '{"id":"fictional"}' },
          },
        ],
      },
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 3 },
  },
};
const answer = {
  model: 'fictional-proxy-alias',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Fictional answer.' },
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
};

test('proxy inference deadline defaults to five minutes and accepts slow local routes', () => {
  assert.equal(config().timeoutSeconds, 300);
  for (const seconds of ['30', '600', '3600'])
    assert.equal(config({ CRS_AI_PROXY_TIMEOUT_SECONDS: seconds }).timeoutSeconds, Number(seconds));
  for (const seconds of ['', '29', '2147484', '300.5', 'Infinity', '-1', '3e2', ' 300 '])
    assert.throws(
      () => config({ CRS_AI_PROXY_TIMEOUT_SECONDS: seconds }),
      /integer from 30 to 2147483/,
    );
});

test('proxy request uses inference override only for cancellable work, keeping setup checks short', async () => {
  const durations: number[] = [];
  const options = {
    fetchImpl: async () => json({}),
    createTimeoutSignal: (milliseconds: number) => {
      durations.push(milliseconds);
      return new AbortController().signal;
    },
  };
  await proxyRequest(config(), {}, { ...options, signal: new AbortController().signal });
  await proxyRequest(
    config({ CRS_AI_PROXY_TIMEOUT_SECONDS: '600' }),
    {},
    { ...options, signal: new AbortController().signal },
  );
  await proxyRequest(config({ CRS_AI_PROXY_TIMEOUT_SECONDS: '600' }), {}, options);
  assert.deepEqual(durations, [300000, 600000, 15000]);
});

test('proxy deadline classifies both header and response-body timeouts without leaking payloads', async (t) => {
  for (const stage of ['headers', 'body'])
    await t.test(stage, async () => {
      const timeout = new AbortController();
      const diagnostics: JsonRecord[] = [];
      let clock = 0;
      let requests = 0;
      await assert.rejects(
        proxyRequest(
          config(),
          { messages: ['fictional-sensitive-payload'] },
          {
            signal: new AbortController().signal,
            createTimeoutSignal: () => timeout.signal,
            now: () => clock,
            createCorrelationId: () => 'fictional-timeout-reference',
            onDiagnostic: (value) => diagnostics.push(JSON.parse(value)),
            fetchImpl: async () => {
              requests++;
              if (stage === 'headers') {
                clock = 300000;
                timeout.abort();
                throw new Error('fictional-provider-secret');
              }
              return new Response(
                new ReadableStream({
                  pull(controller) {
                    clock = 300000;
                    timeout.abort();
                    controller.error(new Error('fictional-provider-secret'));
                  },
                }),
              );
            },
          },
        ),
        (error: unknown) => {
          assert.match(errorText(error), /timed out after 300 seconds/);
          assert.match(errorText(error), /Reference: fictional-timeout-reference/);
          assert.ok(!errorText(error).includes('secret'));
          return true;
        },
      );
      assert.equal(requests, 1);
      assert.deepEqual(diagnostics, [
        {
          event: 'litellm_proxy_request_failed',
          correlationId: 'fictional-timeout-reference',
          status: null,
          durationMs: 300000,
          classification: 'timeout',
        },
      ]);
    });
});

test('caller cancellation dominates an expired deadline and prevents requests already stopped', async () => {
  const caller = new AbortController();
  const deadline = new AbortController();
  const diagnostics: JsonRecord[] = [];
  let requests = 0;
  caller.abort(new Error('fictional-private-reason'));
  deadline.abort();
  await assert.rejects(
    proxyRequest(
      config(),
      {},
      {
        signal: caller.signal,
        createTimeoutSignal: () => deadline.signal,
        fetchImpl: async () => {
          requests++;
          return json({});
        },
        onDiagnostic: (value) => diagnostics.push(JSON.parse(value)),
      },
    ),
    /AI request cancelled/,
  );
  assert.equal(requests, 0);
  assert.equal(diagnostics[0].classification, 'cancelled');
  assert.ok(!JSON.stringify(diagnostics).includes('private'));
});

test('network failure diagnostics use safe metadata and never retry', async () => {
  const diagnostics: JsonRecord[] = [];
  let requests = 0;
  await assert.rejects(
    proxyRequest(
      config(),
      {},
      {
        signal: new AbortController().signal,
        fetchImpl: async () => {
          requests++;
          throw new Error('credential@private-host secret-payload');
        },
        createCorrelationId: () => 'fictional-transport-reference',
        now: () => 100,
        onDiagnostic: (value) => diagnostics.push(JSON.parse(value)),
      },
    ),
    (error: unknown) => {
      assert.match(errorText(error), /connection failed/);
      assert.ok(!errorText(error).includes('credential'));
      return true;
    },
  );
  assert.equal(requests, 1);
  assert.deepEqual(diagnostics, [
    {
      event: 'litellm_proxy_request_failed',
      correlationId: 'fictional-transport-reference',
      status: null,
      durationMs: 0,
      classification: 'transport',
    },
  ]);
});

test('Stop interrupts an in-flight request before its inference deadline', async () => {
  const caller = new AbortController();
  const diagnostics: JsonRecord[] = [];
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const request = proxyRequest(
    config(),
    {},
    {
      signal: caller.signal,
      createTimeoutSignal: () => new AbortController().signal,
      onDiagnostic: (value) => diagnostics.push(JSON.parse(value)),
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          assert.ok(signal);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          started();
        }),
    },
  );
  await ready;
  caller.abort();
  await assert.rejects(request, /AI request cancelled/);
  assert.equal(diagnostics[0].classification, 'cancelled');
});

test('response-reader failures terminate provider diagnostics inside failed processing', async (t) => {
  const cases: Array<{
    status: number;
    locked: boolean;
    streamError?: boolean;
    classification: string;
    message: RegExp;
  }> = [
    { status: 204, locked: false, classification: 'empty_response', message: /empty response/ },
    { status: 200, locked: false, classification: 'empty_response', message: /empty response/ },
    { status: 200, locked: true, classification: 'transport', message: /connection failed/ },
    {
      status: 401,
      locked: true,
      classification: 'authentication',
      message: /authentication failed/,
    },
    { status: 503, locked: true, classification: 'transient_availability', message: /HTTP 503/ },
    {
      status: 200,
      locked: false,
      streamError: true,
      classification: 'transport',
      message: /connection failed/,
    },
  ];
  for (const enabled of [false, true])
    for (const scenario of cases)
      await t.test(
        `${enabled ? 'detailed' : 'compact'} ${scenario.status} ${scenario.streamError ? 'model-error stream' : scenario.locked ? 'locked' : 'bodyless'}`,
        async () => {
          const diagnostics = createImportDiagnostics({ enabled });
          t.after(() => diagnostics.close());
          const context = {
            profileId: 'fictional',
            importId: 'fictional-import',
            runId: 'fictional-run',
          };
          const response = new Response(
            scenario.streamError
              ? new ReadableStream({
                  start(controller) {
                    controller.error(new ModelError('fictional-private-stream-error'));
                  },
                })
              : scenario.locked
                ? '{}'
                : null,
            { status: scenario.status },
          );
          const heldReader = scenario.locked ? response.body!.getReader() : undefined;
          t.after(() => heldReader?.releaseLock());
          let requests = 0;
          await assert.rejects(
            diagnostics.run(context, async () => {
              const active = diagnostics.startActive(context.profileId);
              try {
                return await measureImportPhase('processing_slice', () =>
                  proxyRequest(
                    config(),
                    { messages: ['fictional-private-payload'] },
                    {
                      diagnostics,
                      onDiagnostic: () => {},
                      fetchImpl: async () => {
                        requests++;
                        return response;
                      },
                    },
                  ),
                );
              } finally {
                active.finish({ outcome: 'failed' });
              }
            }),
            scenario.message,
          );
          assert.equal(requests, 1);
          const snapshot = diagnostics.exportSnapshot(context.profileId);
          const operations = snapshot.recentPerformance!.operations;
          assert.equal(operations.length, 1);
          assert.equal(operations[0]!.status, 'failed');
          assert.equal(operations[0]!.currentStage, null);
          assert.equal(
            operations[0]!.spans.some((span) => span.outcome === 'active'),
            false,
          );
          const providerSpans = operations[0]!.spans.filter(
            (span) => span.phase === 'provider_request',
          );
          assert.equal(providerSpans.length, 1);
          assert.equal(providerSpans[0]!.outcome, 'failed');
          assert.equal(providerSpans[0]!.fields.classification, scenario.classification);
          assert.ok(providerSpans[0]!.durationMs !== null);
          assert.equal(JSON.stringify(snapshot).includes('fictional-private-payload'), false);
          if (enabled) {
            assert.equal(
              snapshot.events.filter((event) => event.event === 'model.request.started').length,
              1,
            );
            const terminal = snapshot.events.filter((event) =>
              ['model.request.failed', 'model.request.completed'].includes(event.event),
            );
            assert.equal(terminal.length, 1);
            assert.equal(terminal[0]!.event, 'model.request.failed');
          }
        },
      );
});
function harness(replies: Reply[], options: HarnessOptions = {}): BridgeHarness {
  const requests: BridgeHarness['requests'] = [],
    events: BridgeHarness['events'] = [],
    calls: BridgeHarness['calls'] = [],
    errors: string[] = [],
    diagnostics: JsonRecord[] = [];
  const bridge = new ProxyModelBridge({
    config: options.config || config(),
    beforeRequest: options.beforeRequest,
    fetchImpl: async (url, init) => {
      const requestBody = init?.body;
      if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body');
      requests.push({
        url,
        init: init as CapturedRequestInit,
        body: JSON.parse(requestBody) as WireRequest,
      });
      const next = replies.shift();
      return typeof next === 'function' ? next(url, init) : json(next);
    },
    onTool: async (value) => {
      calls.push(value);
      return options.onTool ? options.onTool(value) : { record: 'fictional only' };
    },
    onEvent: (method, params) => events.push({ method, params }),
    onExit: (error) => errors.push(error.message),
    onDiagnostic: (diagnostic) => diagnostics.push(JSON.parse(diagnostic)),
    resolveHost: options.resolveHost,
    diagnostics: options.diagnostics,
    diagnosticContext: options.diagnosticContext,
    retryDelay: options.retryDelay,
  });
  return { bridge, requests, events, calls, errors, diagnostics };
}

test('default compact diagnostics retain provider/tool waits and host timing without detailed shapes', async () => {
  const diagnostics = createImportDiagnostics({ enabled: false });
  let releaseProvider!: () => void, releaseTool!: () => void;
  let providerStarted!: () => void, toolStarted!: () => void;
  const providerReady = new Promise<void>((resolve) => {
    providerStarted = resolve;
  });
  const toolReady = new Promise<void>((resolve) => {
    toolStarted = resolve;
  });
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const toolGate = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  const f = harness(
    [
      async () => {
        providerStarted();
        await providerGate;
        return json(toolCall);
      },
      answer,
    ],
    {
      diagnostics,
      diagnosticContext: {
        profileId: 'fictional',
        importId: 'fictional-import',
        operationId: 'fictional-operation',
      },
      onTool: async () => {
        toolStarted();
        await toolGate;
        return { hostTimings: { extractionMs: 12, page: 3 }, fictional: 'private-sentinel' };
      },
    },
  );
  const pending = run(f);
  try {
    await providerReady;
    assert.ok(
      diagnostics
        .exportSnapshot('fictional')
        .recentPerformance!.operations.some(
          (operation) =>
            operation.currentStage?.includes('provider') ||
            operation.currentStage?.includes('model'),
        ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseProvider();
    await toolReady;
    assert.ok(
      diagnostics
        .exportSnapshot('fictional')
        .recentPerformance!.operations.some((operation) =>
          operation.currentStage?.includes('tool'),
        ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseTool();
    await pending;
    const report = diagnostics.exportSnapshot('fictional');
    assert.equal(report.events.length, 0);
    const spans = report.recentPerformance!.operations.flatMap((operation) => operation.spans);
    assert.ok(
      spans.some((span) => span.phase === 'provider_request' && (span.durationMs || 0) > 0),
    );
    assert.ok(spans.some((span) => span.phase === 'model_tool' && (span.durationMs || 0) > 0));
    assert.ok(spans.some((span) => span.fields.extractionMs === 12));
    assert.ok(spans.some((span) => span.fields.requestBytes === null));
    assert.ok(!JSON.stringify(report).includes('private-sentinel'));
    assert.ok(!JSON.stringify(report).includes('requestNodes'));
  } finally {
    releaseProvider();
    releaseTool();
    await pending;
    diagnostics.close();
  }
});

test('a host request boundary preserves an in-flight tool result and blocks the next provider call', async () => {
  let deadlineReached = false,
    boundaryChecks = 0;
  const delayedToolCall = async () => {
    deadlineReached = true;
    return json({
      ...toolCall,
      choices: [
        {
          ...toolCall.choices[0],
          message: {
            ...toolCall.choices[0].message,
            tool_calls: [
              toolCall.choices[0].message.tool_calls[0],
              {
                id: 'call-2',
                type: 'function',
                function: { name: 'health_read', arguments: '{"id":"fictional-sibling"}' },
              },
            ],
          },
        },
      ],
    });
  };
  const f = harness([delayedToolCall, answer], {
    beforeRequest: () => {
      boundaryChecks++;
      if (deadlineReached)
        throw new ModelContextLimitError('Fictional host reading deadline reached', 'slice');
    },
  });

  await run(f);

  assert.equal(f.requests.length, 1, 'the next provider request never starts after the deadline');
  assert.deepEqual(
    f.calls.map((call) => call.callId),
    ['call-1', 'call-2'],
    'the response already in flight still executes its full guarded sibling tool set once',
  );
  assert.equal(boundaryChecks, 2, 'the host boundary is checked before every proposed request');
  assert.equal(
    f.events.filter(({ method }) => method === 'model/requestStarted').length,
    1,
    'the blocked request creates no phantom request accounting',
  );
  assert.deepEqual(f.errors, ['Fictional host reading deadline reached']);
  assert.equal(
    f.requests[0]?.init.signal?.aborted,
    false,
    'the deadline did not abort in-flight work',
  );
});

test('a host request boundary can reject the first provider request without transport activity', async () => {
  const f = harness([answer], {
    beforeRequest: () => {
      throw new ModelContextLimitError('Fictional pre-request reading deadline', 'slice');
    },
  });

  await run(f);

  assert.equal(f.requests.length, 0);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.errors, ['Fictional pre-request reading deadline']);
});
async function run(fixture: BridgeHarness, tools: HealthTool[] = [tool]) {
  await fixture.bridge.start('Fictional system instructions', tools);
  await fixture.bridge.turn('Fictional request');
  await fixture.bridge.completion;
}

test('the 64th request consumes prior tool results without dispatching an orphan read or write', async () => {
  const mutationTool: HealthTool = { ...tool, name: 'health_fictional_write' };
  const response = (index: number) => ({
    ...toolCall,
    choices: [
      {
        ...toolCall.choices[0],
        message: {
          ...toolCall.choices[0].message,
          tool_calls: (index === 63 ? ['health_read', mutationTool.name] : ['health_read']).map(
            (name, sibling) => ({
              id: `fictional-round-${index}-${sibling}`,
              type: 'function',
              function: { name, arguments: JSON.stringify({ id: `fictional-${index}` }) },
            }),
          ),
        },
      },
    ],
  });
  let writes = 0;
  const f = harness(
    Array.from({ length: 64 }, (_, index) => response(index)),
    {
      onTool: ({ tool, arguments: args }) => {
        if (tool === mutationTool.name) writes++;
        return { acknowledged: args.id };
      },
    },
  );
  await run(f, [tool, mutationTool]);
  assert.equal(f.requests.length, 64);
  assert.equal(f.calls.length, 63);
  assert.equal(writes, 0, 'a terminal-round mutation was never executed or eligible for replay');
  const delivered = f.requests.at(-1)!.body.messages.filter((message) => message.role === 'tool');
  assert.equal(delivered.length, 63);
  assert.deepEqual(JSON.parse(textContent(delivered.at(-1))), { acknowledged: 'fictional-62' });
  assert.match(f.errors[0] || '', /bounded tool-call limit before dispatching/);
});

test('HTTP 503 retries the exact provider request with bounded physical-attempt accounting', async (t) => {
  const importDiagnostics = createImportDiagnostics({ enabled: true });
  t.after(() => importDiagnostics.close());
  const delays: number[] = [];
  const f = harness(
    [
      () => new Response('fictional temporary outage one', { status: 503 }),
      () => new Response('fictional temporary outage two', { status: 503 }),
      answer,
    ],
    {
      diagnostics: importDiagnostics,
      diagnosticContext: { profileId: 'fictional-retry-profile', runId: 'fictional-run' },
      retryDelay: async (milliseconds, signal) => {
        assert.equal(signal.aborted, false);
        delays.push(milliseconds);
      },
    },
  );

  await run(f);

  assert.equal(f.requests.length, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.ok(f.requests.every(({ url }) => String(url) === String(f.requests[0]?.url)));
  assert.ok(
    f.requests.every(({ init }) => init.body === f.requests[0]?.init.body),
    'every retry sends the exact same logical request body',
  );
  assert.deepEqual(
    f.events
      .filter(({ method }) => method === 'model/requestStarted')
      .map(({ params }) => params.attempt),
    [1, 2, 3],
  );
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(
    f.diagnostics.map(({ status, classification }) => ({ status, classification })),
    [
      { status: 503, classification: 'transient_availability' },
      { status: 503, classification: 'transient_availability' },
    ],
  );
  const events = importDiagnostics.snapshot('fictional-retry-profile');
  const physicalStarts = events.filter(({ event }) => event === 'model.request.started');
  assert.equal(new Set(physicalStarts.map(({ context }) => context.providerRequestId)).size, 3);
  for (const [index, start] of physicalStarts.entries()) {
    const composition = requestInputComposition(JSON.parse(String(f.requests[index]!.init.body)));
    for (const [name, value] of Object.entries(composition))
      assert.equal(start.fields[name], value);
    assert.ok(
      events.some(
        (event) =>
          event.event !== 'model.request.started' &&
          event.context.providerRequestId === start.context.providerRequestId,
      ),
    );
  }
  assert.equal(events.filter(({ event }) => event === 'model.request.started').length, 3);
  assert.equal(events.filter(({ event }) => event === 'model.request.failed').length, 2);
  assert.equal(events.filter(({ event }) => event === 'model.request.completed').length, 1);
  assert.ok(
    events
      .filter(({ event }) => event === 'model.request.failed')
      .every(({ fields }) => fields.classification === 'transient_availability'),
  );
});

test('HTTP 503 exhausts two retries then returns the existing terminal provider failure', async () => {
  const delays: number[] = [];
  const f = harness(
    [
      () => new Response('fictional unavailable one', { status: 503 }),
      () => new Response('fictional unavailable two', { status: 503 }),
      () => new Response('fictional unavailable three', { status: 503 }),
    ],
    { retryDelay: async (milliseconds) => void delays.push(milliseconds) },
  );

  await run(f);

  assert.equal(f.requests.length, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0]!, /HTTP 503/);
  assert.equal(f.diagnostics.length, 3);
  assert.ok(
    f.diagnostics.every(({ classification }) => classification === 'transient_availability'),
  );
});

test('a 503 continuation retry does not replay an already completed host write', async () => {
  const writeCall = structuredClone(toolCall);
  writeCall.choices[0].message.tool_calls[0].function.name = 'health_intake_batch';
  writeCall.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({
    id: 'fictional-intake',
    version: 1,
    planId: 'fictional-plan',
    operationId: 'fictional-stable-operation',
    jsonlText: '{}',
    summary: 'Fictional reviewable proposal',
    coverage: [],
  });
  const f = harness(
    [writeCall, () => new Response('fictional continuation outage', { status: 503 }), answer],
    { retryDelay: async () => {} },
  );

  await run(f, [intakeBatchTool]);

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.arguments.operationId, 'fictional-stable-operation');
  assert.equal(f.requests.length, 3);
  assert.equal(
    f.requests[1]?.init.body,
    f.requests[2]?.init.body,
    'only the exact post-tool provider request is retried',
  );
  assert.deepEqual(
    f.events
      .filter(({ method }) => method === 'model/requestStarted')
      .map(({ params }) => params.attempt),
    [1, 1, 2],
  );
  assert.deepEqual(f.errors, []);
});

test('Stop during HTTP 503 backoff cancels the delay and prevents another request', async () => {
  const f = harness([() => new Response('fictional temporary outage', { status: 503 }), answer]);

  await f.bridge.start('Fictional system instructions', [tool]);
  await f.bridge.turn('Fictional request');
  while (!f.diagnostics.length) await new Promise<void>((resolve) => setImmediate(resolve));
  await f.bridge.cancel();
  await f.bridge.completion;

  assert.equal(f.requests.length, 1);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.errors, []);
});

test('the host deadline gate blocks a 503 retry before request accounting or transport', async () => {
  let boundaryChecks = 0;
  const f = harness([() => new Response('fictional temporary outage', { status: 503 })], {
    beforeRequest: () => {
      boundaryChecks++;
      if (boundaryChecks === 2)
        throw new ModelContextLimitError('Fictional host deadline before provider retry', 'slice');
    },
    retryDelay: async () => {},
  });

  await run(f);

  assert.equal(boundaryChecks, 2);
  assert.equal(f.requests.length, 1);
  assert.equal(f.events.filter(({ method }) => method === 'model/requestStarted').length, 1);
  assert.deepEqual(f.errors, ['Fictional host deadline before provider retry']);
});

test('LiteLLM proxy parser requires exact endpoint, model and external virtual key', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'health-proxy-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = join(directory, 'key');
  writeFileSync(key, 'fictional-file-key\n');
  assert.equal(
    proxyConfig({
      CRS_AI_MODEL: 'alias',
      CRS_AI_BASE_URL: 'https://proxy.test',
      CRS_AI_API_KEY_FILE: key,
    }).apiKey,
    'fictional-file-key',
  );
  for (const env of [
    { CRS_AI_MODEL: 'alias' },
    { CRS_AI_BASE_URL: 'http://proxy.test', CRS_AI_API_KEY: 'key' },
    {
      CRS_AI_MODEL: 'alias',
      CRS_AI_BASE_URL: 'http://credential@proxy.test',
      CRS_AI_API_KEY: 'key',
    },
    {
      CRS_AI_MODEL: 'alias',
      CRS_AI_BASE_URL: 'http://proxy.test',
      CRS_AI_API_KEY: 'key',
      CRS_AI_PROXY_LOCAL_ONLY: 'true',
    },
    {
      CRS_AI_MODEL: 'alias',
      CRS_AI_BASE_URL: 'http://proxy.test',
      CRS_AI_API_KEY: 'key',
      CRS_AI_PROXY_IMAGES: 'probably',
    },
    {
      CRS_AI_MODEL: 'alias',
      CRS_AI_BASE_URL: 'http://proxy.test',
      CRS_AI_API_KEY: 'key',
      CRS_AI_PROXY_PROMPT_CACHE: 'probably',
    },
  ])
    assert.throws(
      () => proxyConfig(env),
      (error: unknown) => !errorText(error).includes('credential@'),
    );
  const local = config({
    CRS_AI_PROXY_LOCAL_ONLY: 'true',
    CRS_AI_PROXY_RESOLVED_MODEL: 'llama3.1:8b',
  });
  assert.equal(local.localOnly, true);
  assert.equal(local.resolvedModel, 'llama3.1:8b');
  assert.throws(
    () =>
      config({
        CRS_AI_PROXY_LOCAL_ONLY: 'true',
        CRS_AI_PROXY_RESOLVED_MODEL: 'openai/gpt-fake',
      }),
    /local Ollama/,
  );
});

test('local-only LiteLLM Proxy pins a verified private endpoint before a request', async () => {
  const local = config({
    CRS_AI_PROXY_LOCAL_ONLY: 'true',
    CRS_AI_PROXY_RESOLVED_MODEL: 'llama3.1:8b',
  });
  const privateDns = async () => [{ address: '10.7.0.8' }];
  assert.deepEqual(await localProxyTransport(local, privateDns), {
    requestOrigin: 'http://10.7.0.8:4000',
    hostHeader: 'proxy.test:4000',
  });
  await assert.rejects(
    proxyCapabilities(local, { resolveHost: async () => [{ address: '8.8.8.8' }] }),
    /private-network/,
  );
  await assert.rejects(
    proxyRequest(local, {}, { fetchImpl: async () => json({}) }),
    /not verified/,
  );
  const f = harness([answer], { config: local, resolveHost: privateDns });
  await run(f);
  assert.equal(f.requests[0].url, 'http://10.7.0.8:4000/v1/chat/completions');
  assert.equal(f.requests[0].init.headers.host, 'proxy.test:4000');
});

test('only structured provider context-limit codes become resumable context boundaries', async () => {
  const diagnostics: string[] = [];
  await assert.rejects(
    proxyRequest(
      config(),
      {},
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: { code: 'context_length_exceeded', message: 'Fictional private payload' },
            }),
            { status: 400 },
          ),
        onDiagnostic: (value) => diagnostics.push(value),
      },
    ),
    ModelContextLimitError,
  );
  assert.doesNotMatch(diagnostics.join(''), /Fictional private payload/);
  assert.match(diagnostics.join(''), /context_limit/);
  await assert.rejects(
    proxyRequest(
      config(),
      {},
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: 'context_length_exceeded' } }), {
            status: 400,
          }),
        onDiagnostic: () => {},
      },
    ),
    (error: unknown) => error instanceof Error && !(error instanceof ModelContextLimitError),
  );
});

test('LiteLLM proxy tool round trip pins alias, disables fallbacks and reports usage', async () => {
  const f = harness([toolCall, answer]);
  await run(f);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(
    f.calls.map(({ attributionCallId: _id, ...call }) => call),
    [
      {
        tool: 'health_read',
        arguments: { id: 'fictional' },
        callId: 'call-1',
        pdf: false,
        deferReadConsumption: true,
      },
    ],
  );
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(({ init }) => !init.body.includes('deferReadConsumption')));
  assert.ok(f.requests.every(({ init }) => !init.body.includes('attributionCallId')));
  assert.equal(typeof f.calls[0].attributionCallId, 'string');
  assert.deepEqual(
    f.events
      .filter(({ method }) => method === 'model/toolResultsConsumed')
      .map(({ params }) => params.callIds),
    [['call-1']],
  );
  assert.equal(f.events.filter((event) => event.method === 'model/requestStarted').length, 2);
  assert.equal(
    f.events.filter(
      (event) => event.method === 'model/requestUsage' && event.params.measured === true,
    ).length,
    2,
  );
  assert.equal(f.requests[0].url, 'http://proxy.test:4000/v1/chat/completions');
  assert.equal(f.requests[0].init.headers.authorization, 'Bearer fictional-proxy-key');
  assert.equal(f.requests[0].body.disable_fallbacks, true);
  assert.equal(
    f.requests[1]?.body.messages.find((message) => message.role === 'tool')?.tool_call_id,
    'call-1',
  );
  assert.ok(f.events.some((event) => event.method === 'turn/completed'));
  const usageEvent = f.events
    .filter((event) => event.method === 'thread/tokenUsage/updated')
    .at(-1);
  const usage = (usageEvent?.params.tokenUsage as { total: JsonRecord }).total;
  assert.deepEqual(usage, {
    inputTokens: 32,
    outputTokens: 10,
    totalTokens: 42,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
  });
});

test('cached input usage accumulates across tool rounds and remains unknown after any missing count', async (t) => {
  for (const [name, firstCache, lastCache, expected] of [
    ['known counts', 3, 7, 10],
    ['known zeros', 0, 0, 0],
    ['missing first count', undefined, 7, null],
    ['missing last count', 3, undefined, null],
    ['negative count', -1, 7, null],
    ['cache larger than input', 13, 7, null],
  ] as const) {
    await t.test(name, async () => {
      const f = harness([
        {
          ...toolCall,
          usage: { ...toolCall.usage, prompt_tokens_details: { cached_tokens: firstCache } },
        },
        {
          ...answer,
          usage: { ...answer.usage, prompt_tokens_details: { cached_tokens: lastCache } },
        },
      ]);
      await run(f);
      assert.deepEqual(f.errors, []);
      const events = f.events.filter((event) => event.method === 'thread/tokenUsage/updated');
      assert.equal(events.length, 2);
      assert.deepEqual((events.at(-1)?.params.tokenUsage as { total: JsonRecord }).total, {
        inputTokens: 32,
        outputTokens: 10,
        totalTokens: 42,
        cachedInputTokens: expected,
        cacheWriteInputTokens: null,
      });
    });
  }
  await t.test(
    'missing entire request usage cannot be repaired by later known cache usage',
    async () => {
      const f = harness([
        { ...toolCall, usage: undefined },
        { ...answer, usage: { ...answer.usage, prompt_tokens_details: { cached_tokens: 7 } } },
      ]);
      await run(f);
      assert.deepEqual(f.errors, []);
      assert.ok(
        f.events.some(
          (event) => event.method === 'model/requestUsage' && event.params.measured === false,
        ),
      );
      const last = f.events.filter((event) => event.method === 'thread/tokenUsage/updated').at(-1);
      assert.equal(
        (last?.params.tokenUsage as { total: JsonRecord }).total.cachedInputTokens,
        null,
      );
    },
  );
});

test('consumed durable intake batches use bounded history after the model sees each true result', async (t) => {
  const diagnostics = createImportDiagnostics({ enabled: true });
  t.after(() => diagnostics.close());
  const batchCount = 21;
  const argumentsByCall = new Map<string, string>();
  const replies: Reply[] = Array.from({ length: batchCount }, (_, index) => {
    const number = index + 1;
    const args = JSON.stringify({
      id: 'intake:fictional-package',
      version: number,
      planId: 'plan:fictional-package',
      operationId: `operation-${number}`,
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: `fictional-medication-${number}`,
        kind: 'medication',
        payload: { literal: 'x'.repeat(20000) },
      }),
      summary: `Fictional medication batch ${number}`,
      coverage: [
        { unitId: `unit-${number}`, kind: 'extracted', notes: `Fictional unit ${number}` },
      ],
    });
    const callId = `call-${number}`;
    argumentsByCall.set(callId, args);
    return {
      model: 'fictional-proxy-alias',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: callId,
                type: 'function',
                function: { name: 'health_intake_batch', arguments: args },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  });
  replies.push(answer);
  const f = harness(replies, {
    diagnostics,
    diagnosticContext: { profileId: 'fictional-compacted-profile' },
    onTool: async ({ callId, arguments: args }) => ({
      intakeId: args.id,
      version: Number(args.version) + 1,
      planId: args.planId,
      latestProposal: { id: `proposal-${callId}`, contentUrl: `/fictional/${callId}` },
      pendingWorkCount: batchCount - Number(args.version),
    }),
  });
  await run(f, [intakeBatchTool]);

  assert.equal(f.requests.length, batchCount + 1);
  for (let index = 0; index < batchCount; index++) {
    const callId = `call-${index + 1}`;
    const request = f.requests[index + 1];
    assert.ok(request);
    const nextRequest = request.body.messages;
    const call = nextRequest
      .flatMap((message) => message.tool_calls || [])
      .find((item) => item.id === callId);
    assert.equal(
      call?.function.arguments,
      argumentsByCall.get(callId),
      `the true arguments for ${callId} reach the model with its tool result`,
    );
    const toolResult = nextRequest.find(
      (message) => message.role === 'tool' && message.tool_call_id === callId,
    );
    assert.equal(JSON.parse(textContent(toolResult)).latestProposal.id, `proposal-${callId}`);
  }

  const finalRequest = f.requests.at(-1);
  assert.ok(finalRequest);
  const finalCalls = finalRequest.body.messages.flatMap((message) => message.tool_calls || []);
  assert.equal(finalCalls.length, batchCount);
  for (let index = 0; index < batchCount - 2; index++) {
    const callId = `call-${index + 1}`;
    const finalCall = finalCalls[index];
    assert.ok(finalCall);
    const compacted = JSON.parse(finalCall.function.arguments);
    const original = JSON.parse(argumentsByCall.get(callId) ?? '');
    assert.equal(compacted.operationId, original.operationId);
    assert.deepEqual(compacted.coverage, original.coverage);
    assert.match(compacted.jsonlText, /^\[HOST_TRANSCRIPT_RECEIPT:/);
    assert.match(compacted.jsonlText, /payloadSha256=[a-f0-9]{64}/);
  }
  for (const index of [batchCount - 2, batchCount - 1]) {
    const callId = `call-${index + 1}`;
    assert.equal(finalCalls[index]?.function.arguments, argumentsByCall.get(callId));
  }
  const finalCharacters = finalRequest.init.body.length;
  const physicalStarts = diagnostics
    .snapshot('fictional-compacted-profile')
    .filter(({ event }) => event === 'model.request.started');
  assert.equal(physicalStarts.length, f.requests.length);
  const finalComposition = requestInputComposition(finalRequest.body);
  for (const [name, value] of Object.entries(finalComposition))
    assert.equal(physicalStarts.at(-1)!.fields[name], value, name);
  assert.equal(
    finalComposition.inputArgumentCharacters,
    finalCalls.reduce((count, call) => count + call.function.arguments.length, 0),
  );
  assert.ok(
    Number(finalComposition.inputArgumentCharacters) <
      [...argumentsByCall.values()].reduce(
        (count, argumentsText) => count + argumentsText.length,
        0,
      ),
    'measurement reflects compacted outbound arguments rather than retained full arguments',
  );
  const totalCharacters = f.requests.reduce((sum, request) => sum + request.init.body.length, 0);
  assert.ok(finalCharacters < 100000, `final request stayed bounded at ${finalCharacters} chars`);
  assert.ok(totalCharacters < 1500000, `aggregate requests stayed bounded at ${totalCharacters}`);
  assert.equal(f.calls.length, batchCount);
  for (const [callId, args] of argumentsByCall)
    assert.equal(
      f.calls.find((call) => call.callId === callId)?.arguments.jsonlText,
      JSON.parse(args).jsonlText,
      'compaction never mutates executed arguments',
    );
});

test('failed intake calls stay exact while older successful calls retain idempotent receipts', async () => {
  const calls = ['success-one', 'success-two', 'failed-three', 'success-four'].map(
    (operationId, index) => {
      const args = JSON.stringify({
        id: 'intake:fictional',
        version: index + 1,
        planId: 'plan:fictional',
        operationId,
        jsonlText: JSON.stringify({
          format: 'health-record-v1',
          id: operationId,
          literal: 'y'.repeat(5000),
        }),
        summary: operationId,
        coverage: [{ unitId: `unit-${index + 1}`, kind: 'inspected', notes: 'Partial' }],
      });
      return {
        id: `call-${index + 1}`,
        args,
        reply: {
          model: 'fictional-proxy-alias',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `call-${index + 1}`,
                    type: 'function',
                    function: { name: 'health_intake_batch', arguments: args },
                  },
                ],
              },
            },
          ],
        },
      };
    },
  );
  const f = harness([...calls.map((call) => call.reply), answer], {
    onTool: async ({ callId }) => {
      if (callId === 'call-3')
        throw Object.assign(new Error('Fictional durable rejection'), {
          code: 'CONVERSION_COVERAGE_PENDING',
        });
      return { version: Number(callId.slice(5)) + 1, proposalId: `proposal-${callId}` };
    },
  });
  await run(f, [intakeBatchTool]);

  const lastRequest = f.requests.at(-1);
  assert.ok(lastRequest);
  const finalMessages = lastRequest.body.messages;
  const finalCalls = finalMessages.flatMap((message) => message.tool_calls || []);
  assert.match(
    JSON.parse(finalCalls[0]?.function.arguments ?? '').jsonlText,
    /HOST_TRANSCRIPT_RECEIPT/,
  );
  assert.equal(JSON.parse(finalCalls[0]?.function.arguments ?? '').operationId, 'success-one');
  assert.equal(finalCalls[2]?.function.arguments, calls[2]?.args);
  assert.equal(JSON.parse(finalCalls[2]?.function.arguments ?? '').operationId, 'failed-three');
  const failedResult = finalMessages.find(
    (message) => message.role === 'tool' && message.tool_call_id === 'call-3',
  );
  assert.equal(failedResult?.name, 'health_intake_batch');
  assert.deepEqual(JSON.parse(textContent(failedResult)), {
    code: 'CONVERSION_COVERAGE_PENDING',
    error:
      'The scoped tool rejected this request. Refresh the record and review the required arguments before trying again.',
  });
  assert.deepEqual(
    f.calls.map((call) => call.callId),
    calls.map((call) => call.id),
    'each operation executes once',
  );
});

test('tool errors expose no unapproved application error code or message', async () => {
  const f = harness([toolCall, answer], {
    onTool: async () =>
      Promise.reject(
        Object.assign(new Error('Fictional private rejection detail'), {
          code: 'SOURCE_CHANGED',
        }),
      ),
  });

  await run(f);

  const result = f.requests[1].body.messages.find((message) => message.role === 'tool');
  assert.deepEqual(JSON.parse(textContent(result)), {
    error:
      'The scoped tool rejected this request. Refresh the record and review the required arguments before trying again.',
  });
  assert.doesNotMatch(textContent(result), /SOURCE_CHANGED|private rejection/);
});

test('terminal tool rejection records safe metadata after close without dispatching later actions', async (t) => {
  const diagnosticStore = createImportDiagnostics({ enabled: true });
  t.after(() => diagnosticStore.close());
  const twoCalls = structuredClone(toolCall);
  twoCalls.choices[0].message.tool_calls.push({
    id: 'call-after-terminal',
    type: 'function',
    function: { name: 'health_read', arguments: '{"id":"must-not-run"}' },
  });
  let f: BridgeHarness;
  f = harness([twoCalls], {
    diagnostics: diagnosticStore,
    diagnosticContext: {
      profileId: 'fictional-profile',
      importId: 'fictional-import',
      runId: 'fictional-run',
    },
    onTool: async () => {
      const error = Object.assign(new Error('private health failure detail'), {
        code: 'OPERATION_CONFLICT',
        status: 409,
      });
      markModelToolTerminalError(error);
      f.bridge.close();
      throw error;
    },
  });

  await run(f);

  assert.equal(f.requests.length, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.errors, []);
  assert.equal(
    f.events.some((event) => event.method === 'turn/completed'),
    false,
  );
  const failures = diagnosticStore
    .snapshot('fictional-profile')
    .filter((event) => event.event === 'model.tool.failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.fields.toolName, 'health_read');
  assert.equal(failures[0]?.fields.errorCode, 'tool_rejected_after_close');
  assert.equal(failures[0]?.fields.resultKind, 'object');
  assert.doesNotMatch(JSON.stringify(failures), /private health|OPERATION_CONFLICT/);
  assert.ok(!('status' in failures[0]!.fields));
  assert.ok(!('statusCode' in failures[0]!.fields));
});

test('tool completion attaches rounded host sub-timings and the page number from hostTimings', async (t) => {
  const diagnosticStore = createImportDiagnostics({ enabled: true });
  t.after(() => diagnosticStore.close());
  const f = harness([toolCall, answer], {
    diagnostics: diagnosticStore,
    diagnosticContext: { profileId: 'fictional-timings-profile', importId: 'fictional-import' },
    onTool: async () => ({
      metadata: { fictional: true },
      hostTimings: {
        page: 3,
        queueWaitMs: 12.4,
        sessionSetupMs: 340.6,
        base64Ms: 4.6,
        textLayerCharacters: 512,
        imageBytes: 65536,
        verifyMs: 1.2,
        textMs: 2.9,
        renderMs: 700.7,
        encodeMs: 3.3,
        annotationMs: 0.6,
        renderPasses: 1,
      },
    }),
  });

  await run(f);

  const completed = diagnosticStore
    .snapshot('fictional-timings-profile')
    .filter((event) => event.event === 'model.tool.completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.fields.page, 3);
  assert.equal(
    completed[0]?.fields.renderMs,
    701,
    'fractional worker milliseconds round to the nearest integer',
  );
  assert.equal(completed[0]?.fields.queueWaitMs, 12);
  assert.equal(
    completed[0]?.fields.sessionSetupMs,
    341,
    'session setup ships as its own rounded duration, not folded into the queue wait',
  );
  assert.equal(completed[0]?.fields.base64Ms, 5);
  assert.equal(
    completed[0]?.fields.textLayerCharacters,
    512,
    'counts are copied through unrounded, only durations are rounded',
  );
  assert.equal(completed[0]?.fields.imageBytes, 65536);
  assert.equal(completed[0]?.fields.renderPasses, 1);
});

test('tool completion without hostTimings leaves the sub-timing fields absent, not null or NaN', async (t) => {
  const diagnosticStore = createImportDiagnostics({ enabled: true });
  t.after(() => diagnosticStore.close());
  const f = harness([toolCall, answer], {
    diagnostics: diagnosticStore,
    diagnosticContext: { profileId: 'fictional-no-timings-profile', importId: 'fictional-import' },
    onTool: async () => ({ record: 'fictional only' }),
  });

  await run(f);

  const completed = diagnosticStore
    .snapshot('fictional-no-timings-profile')
    .filter((event) => event.event === 'model.tool.completed');
  assert.equal(completed.length, 1);
  for (const key of [
    'page',
    'queueWaitMs',
    'sessionSetupMs',
    'verifyMs',
    'textMs',
    'renderMs',
    'encodeMs',
    'annotationMs',
    'renderPasses',
    'base64Ms',
    'textLayerCharacters',
    'imageBytes',
  ])
    assert.equal(
      Object.hasOwn(completed[0]!.fields, key),
      false,
      `${key} must be absent when the tool result carries no hostTimings, not null/NaN`,
    );
});

test('tool completion carries the re-read count and first-read flag through hostTimings', async (t) => {
  const diagnosticStore = createImportDiagnostics({ enabled: true });
  t.after(() => diagnosticStore.close());
  let call = 0;
  const f = harness([toolCall, toolCall, answer], {
    diagnostics: diagnosticStore,
    diagnosticContext: { profileId: 'fictional-reread-profile', importId: 'fictional-import' },
    onTool: async () => {
      call += 1;
      return {
        metadata: { fictional: true },
        hostTimings: {
          page: 12,
          textLayerCharacters: 8,
          reReadCount: call - 1,
          firstRead: call === 1,
        },
      };
    },
  });

  await run(f);

  const completed = diagnosticStore
    .snapshot('fictional-reread-profile')
    .filter((event) => event.event === 'model.tool.completed');
  assert.equal(completed.length, 2);
  assert.equal(completed[0]?.fields.firstRead, true);
  assert.equal(completed[0]?.fields.reReadCount, 0);
  assert.equal(completed[1]?.fields.firstRead, false);
  assert.equal(
    completed[1]?.fields.reReadCount,
    1,
    'a boolean sibling in hostTimings must not suppress the numeric fields beside it',
  );
  assert.equal(
    completed[1]?.fields.textLayerCharacters,
    8,
    'the text-layer count survives alongside the new boolean field',
  );
});

test('ordinary scoped tool history is unchanged across several rounds', async () => {
  const replies = ['one', 'two', 'three'].map((id, index) => ({
    ...structuredClone(toolCall),
    choices: [
      {
        ...structuredClone(toolCall.choices[0]),
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `read-${index + 1}`,
              type: 'function',
              function: { name: 'health_read', arguments: JSON.stringify({ id }) },
            },
          ],
        },
      },
    ],
  }));
  const f = harness([...replies, answer]);
  await run(f);
  assert.deepEqual(
    f.requests.at(-1)?.body.messages.flatMap((message) => message.tool_calls || []),
    replies.map((reply) => reply.choices[0]?.message.tool_calls[0]),
  );
});

test('LiteLLM proxy preserves assistant text attached to a normalized tool-call reply', async () => {
  const mixed = structuredClone(toolCall);
  const mixedReply = mixed as unknown as {
    choices: Array<{ message: { content: string | null } }>;
  };
  if (mixedReply.choices[0])
    mixedReply.choices[0].message.content = 'I will check the fictional record.';
  const f = harness([mixed, answer]);
  await run(f);
  assert.deepEqual(f.errors, []);
  assert.equal(f.calls.length, 1);
  assert.ok(
    f.events.some(
      (event) =>
        event.method === 'item/completed' &&
        (event.params.item as { text?: string }).text === 'I will check the fictional record.',
    ),
  );
  assert.equal(
    f.requests[1]?.body.messages.find((message) => message.role === 'assistant')?.content,
    'I will check the fictional record.',
  );
});

test('LiteLLM proxy rejects genuine alternative choices instead of combining them', async () => {
  const alternatives = structuredClone(answer);
  alternatives.choices.push({
    index: 1,
    finish_reason: 'stop',
    message: { role: 'assistant', content: 'Different fictional alternative.' },
  });
  const f = harness([alternatives]);
  await run(f);
  assert.equal(
    f.events.some((event) => event.method === 'item/completed'),
    false,
  );
  assert.match(f.errors[0], /unsupported message/);
});

test('LiteLLM proxy validates every tool before calling the application', async () => {
  const malformed = structuredClone(toolCall);
  malformed.choices[0].message.tool_calls[0].function.arguments = '{bad json';
  const unregistered = structuredClone(toolCall);
  unregistered.choices[0].message.tool_calls[0].function.name = 'exec_command';
  for (const reply of [malformed, unregistered]) {
    const f = harness([reply]);
    await run(f);
    assert.equal(f.calls.length, 0);
    assert.equal(f.errors.length, 1);
    assert.ok(!f.events.some((event) => event.method === 'turn/completed'));
  }
});

test('tool calls require distinct nonempty IDs and the function protocol type', async () => {
  const emptyId = structuredClone(toolCall);
  emptyId.choices[0].message.tool_calls[0].id = '   ';
  const duplicateId = structuredClone(toolCall);
  duplicateId.choices[0].message.tool_calls.push(
    structuredClone(duplicateId.choices[0].message.tool_calls[0]),
  );
  const nonFunction = structuredClone(toolCall);
  nonFunction.choices[0].message.tool_calls[0].type = 'custom';

  for (const reply of [emptyId, duplicateId, nonFunction]) {
    const f = harness([reply]);
    await run(f);
    assert.equal(f.requests.length, 1);
    assert.equal(f.calls.length, 0);
    assert.match(f.errors[0], /unsupported tool request/);
  }
});

test('registered tool argument errors return bounded structural guidance before a corrected retry', async () => {
  const invalid = structuredClone(toolCall);
  invalid.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({
    id: 'fictional',
    unexpectedField: 'fictional-sensitive-value-must-not-be-reflected',
  });
  const corrected = structuredClone(toolCall);
  corrected.choices[0].message.tool_calls[0].id = 'call-2';
  const f = harness([invalid, corrected, answer]);

  await run(f);

  assert.deepEqual(f.errors, []);
  assert.deepEqual(
    f.calls.map(({ attributionCallId: _id, ...call }) => call),
    [
      {
        tool: 'health_read',
        arguments: { id: 'fictional' },
        callId: 'call-2',
        pdf: false,
        deferReadConsumption: true,
      },
    ],
  );
  const retryResult = f.requests[1].body.messages.find(
    (message) => message.role === 'tool' && message.tool_call_id === 'call-1',
  );
  assert.equal(
    f.requests[1]?.body.messages.find((message) => message.role === 'assistant')?.tool_calls?.[0]
      ?.function.arguments,
    invalid.choices[0].message.tool_calls[0].function.arguments,
  );
  const detail = JSON.parse(textContent(retryResult)).error;
  assert.deepEqual(detail, {
    code: 'invalid_tool_arguments',
    message:
      'This registered tool call failed schema validation. Correct the indicated field and retry the complete tool-call batch.',
    tool: 'health_read',
    field: 'arguments[unknown]',
    problem: 'unknown_field',
    allowedKeys: ['id'],
  });
  assert.doesNotMatch(textContent(retryResult), /fictional-sensitive-value/);
  assert.deepEqual(f.diagnostics[0].errors, [
    {
      tool: 'health_read',
      field: 'arguments[unknown]',
      problem: 'unknown_field',
    },
  ]);
  assert.ok(f.events.some((event) => event.method === 'turn/completed'));
});

test('unknown argument names never enter bounded validation diagnostics', async () => {
  const sensitiveUnknownKey = `fictional-sensitive-key-${'x'.repeat(64 * 1024)}`;
  const invalid = structuredClone(toolCall);
  invalid.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({
    id: 'fictional',
    [sensitiveUnknownKey]: 'fictional-value',
  });
  const corrected = structuredClone(toolCall);
  corrected.choices[0].message.tool_calls[0].id = 'corrected-after-sensitive-key';
  const f = harness([invalid, corrected, answer]);

  await run(f);

  assert.equal(f.calls.length, 1);
  const retryResult = f.requests[1].body.messages.find(
    (message) => message.role === 'tool' && message.tool_call_id === 'call-1',
  );
  assert.equal(JSON.parse(textContent(retryResult)).error.field, 'arguments[unknown]');
  assert.ok(textContent(retryResult).length < 600);
  assert.doesNotMatch(textContent(retryResult), /fictional-sensitive-key/);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /fictional-sensitive-key/);
});

test('one invalid registered tool rejects all sibling calls atomically until the complete batch is retried', async () => {
  const invalidBatch = structuredClone(toolCall);
  invalidBatch.choices[0].message.tool_calls = [
    {
      id: 'valid-sibling',
      type: 'function',
      function: { name: 'health_read', arguments: '{"id":"first-fictional"}' },
    },
    {
      id: 'invalid-sibling',
      type: 'function',
      function: {
        name: 'health_read',
        arguments: '{"id":"second-fictional","unknown":"not-reflected"}',
      },
    },
  ];
  const correctedBatch = structuredClone(toolCall);
  correctedBatch.choices[0].message.tool_calls = [
    {
      id: 'corrected-first',
      type: 'function',
      function: { name: 'health_read', arguments: '{"id":"first-fictional"}' },
    },
    {
      id: 'corrected-second',
      type: 'function',
      function: { name: 'health_read', arguments: '{"id":"second-fictional"}' },
    },
  ];
  let fixture: BridgeHarness;
  fixture = harness([
    invalidBatch,
    () => {
      assert.equal(fixture.calls.length, 0);
      return json(correctedBatch);
    },
    answer,
  ]);

  await run(fixture);

  assert.deepEqual(
    fixture.calls.map(({ callId }) => callId),
    ['corrected-first', 'corrected-second'],
  );
  const rejected = fixture.requests[1].body.messages
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(textContent(message)).error as { code: string; message: string });
  assert.deepEqual(
    rejected.map(({ code }) => code),
    ['tool_batch_rejected', 'invalid_tool_arguments'],
  );
  assert.ok(rejected.every((error) => error.message.includes('complete tool-call batch')));
});

test('repeated invalid registered arguments pause after three responses without dispatching a tool', async () => {
  const invalidReplies = Array.from({ length: 3 }, (_, index) => {
    const reply = structuredClone(toolCall);
    reply.choices[0].message.tool_calls[0].id = `invalid-${index + 1}`;
    reply.choices[0].message.tool_calls[0].function.arguments = '{"id":42}';
    return reply;
  });
  const f = harness(invalidReplies);

  await run(f);

  assert.equal(f.requests.length, 3);
  assert.equal(f.calls.length, 0);
  assert.equal(f.diagnostics.length, 3);
  assert.deepEqual(
    f.diagnostics.map(({ attempt }) => attempt),
    [1, 2, 3],
  );
  assert.match(f.errors[0], /health_read at arguments\.id/);
  assert.match(f.errors[0], /continue explicitly to retry/);
  assert.ok(!f.events.some((event) => event.method === 'turn\/completed'));
});

test('LiteLLM proxy rejects substituted models, errors and late tool calls after cancellation', async () => {
  const changed = structuredClone(toolCall);
  changed.model = 'unconfigured-fallback';
  const substitution = harness([changed]);
  await run(substitution);
  assert.match(substitution.errors[0], /different model/);
  assert.equal(substitution.calls.length, 0);
  for (const status of [400, 401, 403, 404, 429, 500, 502, 504]) {
    const f = harness([
      () => new Response('fictional-proxy-key https://credential@proxy.test', { status }),
    ]);
    await run(f);
    assert.equal(f.errors.length, 1);
    assert.equal(f.requests.length, 1, `HTTP ${status} remains terminal without retry`);
    assert.ok(!f.errors[0].includes('fictional-proxy-key'));
  }
  let resolveRequest: (response: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    resolveRequest = resolve;
  });
  const cancellation = harness([
    (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.signal?.aborted, false);
      return pending;
    },
  ]);
  await cancellation.bridge.start('Synthetic', [tool]);
  await cancellation.bridge.turn('Synthetic');
  await new Promise<void>((resolve) => setImmediate(resolve));
  await cancellation.bridge.cancel();
  resolveRequest(json(toolCall));
  await cancellation.bridge.completion;
  assert.equal(cancellation.calls.length, 0);
  assert.deepEqual(cancellation.errors, []);
});

test('the cache breakpoint follows the static instructions so it includes tools and system', async () => {
  const fixture = harness([answer], {
    config: config({ CRS_AI_PROXY_PROMPT_CACHE: 'true' }),
  });

  await run(fixture);

  const request = fixture.requests[0]!.body;
  assert.deepEqual(
    request.messages[0]!.content,
    [{ type: 'text', text: 'Fictional system instructions', cache_control: { type: 'ephemeral' } }],
    'provider prompt order is tools, system, messages; a tool-only breakpoint misses instructions',
  );
  assert.doesNotMatch(JSON.stringify(request.tools), /cache_control/);
  assert.doesNotMatch(JSON.stringify(request.messages.slice(1)), /cache_control/);
  assert.deepEqual(fixture.errors, []);
});

test('no cache breakpoint is sent when the proxy does not declare support', async () => {
  const fixture = harness([json({ choices: [{ message: { content: 'done' } }] })], {
    config: config({ CRS_AI_PROXY_PROMPT_CACHE: 'false' }),
  });

  await run(fixture);

  assert.doesNotMatch(JSON.stringify(fixture.requests[0]!.body), /cache_control/);
});

test('prompt caching keeps the system message byte-identical across rounds, off-path bytes unchanged', async () => {
  const cached = harness([toolCall, answer], {
    config: config({ CRS_AI_PROXY_PROMPT_CACHE: 'true' }),
  });
  await run(cached);
  assert.equal(cached.requests.length, 2);
  assert.deepEqual(cached.requests[0]!.body.messages[0]!.content, [
    { type: 'text', text: 'Fictional system instructions', cache_control: { type: 'ephemeral' } },
  ]);
  assert.equal(
    JSON.stringify(cached.requests[1]!.body.messages[0]),
    JSON.stringify(cached.requests[0]!.body.messages[0]),
  );
  assert.equal(cached.requests[1]!.body.messages[1]!.role, 'system');
  assert.match(textContent(cached.requests[1]!.body.messages[1]), /continues the same response/);

  const uncached = harness([toolCall, answer], {
    config: config({ CRS_AI_PROXY_PROMPT_CACHE: 'false' }),
  });
  await run(uncached);
  assert.equal(uncached.requests.length, 2);
  assert.equal(uncached.requests[0]!.body.messages[0]!.content, 'Fictional system instructions');
  assert.equal(
    uncached.requests[1]!.body.messages[0]!.content,
    'Fictional system instructions' +
      '\n\nThis request continues the same response after scoped tools. The opening response has already been attempted. Do not greet or introduce yourself again, even if the original conversation context says firstAssistantResponse. Continue from the retained assistant text and tool results without repeating it. Keep substantive findings in response text; if health_assistant_progress is registered, use it only for transient working status.',
    'off (the default), the exact byte sequence sent today is unchanged',
  );
  assert.equal(
    cached.requests[1]!.body.messages.length,
    uncached.requests[1]!.body.messages.length + 1,
    'the only structural difference is the continuation notice becoming its own message',
  );
});

test('an opaque proxy rejection naming cache_control gets an actionable message, not a silent retry', async () => {
  const diagnostics: string[] = [];
  await assert.rejects(
    proxyRequest(
      config({ CRS_AI_PROXY_PROMPT_CACHE: 'true' }),
      {},
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: {
                message:
                  'litellm.BadRequestError: Unrecognized request argument supplied: cache_control',
              },
            }),
            { status: 400 },
          ),
        onDiagnostic: (value) => diagnostics.push(value),
        createCorrelationId: () => '00000000-0000-4000-8000-000000000002',
      },
    ),
    (error: unknown) => {
      assert.match(errorText(error), /CRS_AI_PROXY_PROMPT_CACHE=false/);
      assert.match(errorText(error), /Reference: 00000000-0000-4000-8000-000000000002/);
      return true;
    },
  );
  assert.match(diagnostics.join(''), /prompt_cache_unsupported/);
});

test('LiteLLM proxy image evidence uses standard chat image parts only when explicit alias capability permits it', async () => {
  const imageConfig = config({ CRS_AI_PROXY_IMAGES: 'true' });
  const f = harness([toolCall, answer], {
    config: imageConfig,
    onTool: async () => ({
      metadata: { source: 'fictional' },
      imageContent: 'data:image/png;base64,aGVsbG8=',
    }),
  });
  await run(f);
  const imageMessage = f.requests[1].body.messages.at(-1);
  assert.equal(imageMessage?.role, 'user');
  assert.equal(Array.isArray(imageMessage?.content) && imageMessage.content[1]?.type, 'image_url');
  const blocked = harness([toolCall], {
    onTool: async () => ({ imageContent: 'data:image/png;base64,aGVsbG8=', metadata: {} }),
  });
  await run(blocked);
  assert.match(blocked.errors[0], /not configured for image/);
});

const fictionalPdf =
  'data:application/pdf;base64,' +
  Buffer.from('%PDF-1.7\nfictional page\n%%EOF').toString('base64');
const fictionalPng = 'data:image/png;base64,aGVsbG8=';

test('native PDF evidence uses inline file parts and keeps host callbacks off the wire', async () => {
  assert.equal(config().pdf, false);
  assert.throws(() => config({ CRS_AI_PROXY_PDF: 'maybe' }), /must be true or false/);
  const f = harness([toolCall, answer], {
    config: config({ CRS_AI_PROXY_PDF: 'true' }),
    onTool: async ({ pdf }) => {
      assert.equal(pdf, true);
      return {
        pdfContent: fictionalPdf,
        metadata: { original: { page: 12 } },
        pdfFallback: async () => {
          throw new Error('Native PDF should not render.');
        },
      };
    },
  });
  await run(f);
  assert.deepEqual(f.errors, []);
  const request = f.requests[1].body;
  const content = request.messages.at(-1)?.content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[1], {
    type: 'file',
    file: {
      filename: 'scoped-page.pdf',
      file_data: fictionalPdf,
    },
  });
  assert.deepEqual(JSON.parse(textContent(request.messages.find((m) => m.role === 'tool'))), {
    original: { page: 12 },
  });
  assert.equal(JSON.stringify(request).includes('pdfFallback'), false);
  assert.equal(proxyTranscriptSize(request).mediaBytes, Buffer.byteLength(fictionalPdf));

  for (const pdfContent of [
    fictionalPdf,
    'https://example.test/source.pdf',
    'data:application/pdf;base64,aGVsbG8=',
  ]) {
    const blocked = harness([toolCall], {
      config: config({ CRS_AI_PROXY_PDF: pdfContent === fictionalPdf ? 'false' : 'true' }),
      onTool: async () => ({ pdfContent, metadata: {} }),
    });
    await run(blocked);
    assert.equal(blocked.requests.length, 1);
    assert.match(blocked.errors[0], /not configured for PDF|unsupported PDF/);
  }
});

test('explicit PDF rejection retries scoped images on the same route without replaying tools', async () => {
  const replies = intakeReadReplies([1, 2, 3]);
  const rendered: number[] = [];
  const f = harness(
    [
      replies[0],
      replies[1],
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'unsupported_file_type',
              message: 'This model does not support PDF input.',
            },
          }),
          { status: 400 },
        ),
      replies[2],
      answer,
    ],
    {
      config: config({ CRS_AI_PROXY_PDF: 'true', CRS_AI_PROXY_IMAGES: 'true' }),
      onTool: async ({ arguments: args, pdf }) => {
        const page = Number(args.page);
        const metadata = { original: { page } };
        return pdf
          ? {
              pdfContent: fictionalPdf,
              metadata,
              pdfFallback: async () => {
                rendered.push(page);
                return { imageContent: fictionalPng, metadata };
              },
            }
          : { imageContent: fictionalPng, metadata };
      },
    },
  );
  await run(f, [intakeReadTool]);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(
    f.calls.map((c) => [c.arguments.page, c.pdf]),
    [
      [1, true],
      [2, true],
      [3, false],
    ],
  );
  assert.deepEqual(rendered, [1, 2]);
  assert.equal(f.requests.length, 5);
  assert.equal(
    f.requests.every((r) => r.body.model === config().model && r.body.disable_fallbacks === true),
    true,
  );
  assert.equal(JSON.stringify(f.requests[2].body).includes(fictionalPdf), true);
  assert.equal(JSON.stringify(f.requests[3].body).includes(fictionalPdf), false);
  const resultPages = f.requests[3].body.messages
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.parse(textContent(m)).original.page);
  assert.deepEqual(resultPages, [1, 2]);
  assert.equal(f.events.filter((e) => e.method === 'model/evidenceFallback').length, 1);
  const fallbackEvent = f.events.find((e) => e.method === 'model/evidenceFallback')!;
  assert.equal(fallbackEvent.params.pageCount, 2);
  assert.ok(
    typeof fallbackEvent.params.durationMs === 'number' && fallbackEvent.params.durationMs >= 0,
  );
});

test('PDF fallback never retries generic failures or routes without image support', async () => {
  for (const [status, message, images] of [
    [400, 'Invalid PDF data', true],
    [401, 'PDF unsupported', true],
    [413, 'PDF unsupported', true],
    [429, 'PDF unsupported', true],
    [500, 'PDF unsupported', true],
    [422, 'PDF unsupported', false],
  ] as const) {
    const f = harness(
      [toolCall, () => new Response(JSON.stringify({ error: { message } }), { status })],
      {
        config: config({ CRS_AI_PROXY_PDF: 'true', CRS_AI_PROXY_IMAGES: String(images) }),
        onTool: async () => ({
          pdfContent: fictionalPdf,
          metadata: {},
          pdfFallback: async () => {
            assert.fail('This failure must not trigger raster fallback.');
          },
        }),
      },
    );
    await run(f);
    assert.equal(f.requests.length, 2);
    assert.equal(f.errors.length, 1);
  }
});

test('consumed native PDFs compact into receipts while recent pages retain native bytes', async () => {
  const f = harness([...intakeReadReplies([1, 2, 3]), answer], {
    config: config({ CRS_AI_PROXY_PDF: 'true' }),
    onTool: async ({ arguments: args }) => ({
      pdfContent: fictionalPdf,
      metadata: fictionalReadResult(Number(args.page)),
    }),
  });
  await run(f, [intakeReadTool]);
  assert.deepEqual(f.errors, []);
  const request = f.requests.at(-1)!.body;
  const evidence = request.messages.filter((m) => m.role === 'user' && Array.isArray(m.content));
  assert.equal(evidence.length, 3);
  assert.match(JSON.stringify(evidence[0]), /pdf1Sha256=[a-f0-9]{64}/);
  assert.equal(JSON.stringify(evidence[0]).includes(fictionalPdf), false);
  assert.equal(proxyTranscriptSize(request).mediaBytes, 2 * Buffer.byteLength(fictionalPdf));
  const exposure = f.events.filter((event) => event.method === 'model/requestStarted').at(-1)!;
  assert.equal(exposure.params.pdfParts, 2);
  assert.equal(exposure.params.imageParts, 0);
  assert.deepEqual(
    exposure.params.exposedCallIds,
    f.calls.slice(1).map((call) => call.attributionCallId),
  );
  assert.deepEqual(
    f.events
      .filter((event) => event.method === 'model/evidenceAcknowledged')
      .flatMap((event) => event.params.attributionCallIds),
    f.calls.map((call) => call.attributionCallId),
  );
  assert.equal(
    proxyTranscriptLimit(request, { textCharacters: 100000, mediaBytes: 1 })?.kind,
    'media',
  );
});

test('consumed image wires compact while two recent evidence messages remain intact', async () => {
  const imageConfig = config({ CRS_AI_PROXY_IMAGES: 'true' });
  const replies = ['image-one', 'image-two', 'image-three'].map((id, index) => ({
    ...structuredClone(toolCall),
    choices: [
      {
        ...structuredClone(toolCall.choices[0]),
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `image-call-${index + 1}`,
              type: 'function',
              function: { name: 'health_read', arguments: JSON.stringify({ id }) },
            },
          ],
        },
      },
    ],
  }));
  const f = harness([...replies, answer], {
    config: imageConfig,
    onTool: async ({ callId, arguments: args }) => ({
      metadata: { id: args.id, locator: { page: Number(callId.at(-1)), offset: 0 } },
      imageContent: `data:image/png;base64,${callId.at(-1)?.repeat(12000)}`,
    }),
  });
  await run(f);

  const finalRequest = f.requests.at(-1);
  assert.ok(finalRequest);
  const finalMessages = finalRequest.body.messages;
  const imageMessages = finalMessages.filter(
    (message) =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) => part.type === 'image_url' || part.text?.includes('HOST_TRANSCRIPT_RECEIPT'),
      ),
  );
  assert.equal(imageMessages.length, 3);
  assert.deepEqual(
    f.events.filter((event) => event.method === 'model/requestStarted').at(-1)!.params
      .exposedCallIds,
    f.calls.slice(1).map((call) => call.attributionCallId),
    'evicted pixels and retained locator metadata do not count as source exposure',
  );
  assert.equal(
    Array.isArray(imageMessages[0]?.content) &&
      imageMessages[0].content.some((part) => part.type === 'image_url'),
    false,
  );
  const firstImageContent = imageMessages[0]?.content;
  assert.ok(Array.isArray(firstImageContent));
  assert.match(firstImageContent[0]?.text ?? '', /image1Sha256=[a-f0-9]{64}/);
  for (const message of imageMessages.slice(1))
    assert.equal(
      Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'),
      true,
    );
  const metadata = finalMessages
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(textContent(message)) as { locator: unknown });
  assert.deepEqual(
    metadata.map((item) => item.locator),
    [
      { page: 1, offset: 0 },
      { page: 2, offset: 0 },
      { page: 3, offset: 0 },
    ],
  );
});

test('consumed intake read results are replaced by a receipt that states what was removed', async () => {
  const f = harness([...intakeReadReplies([1, 2, 3]), answer], {
    onTool: async ({ arguments: args }) => fictionalReadResult(Number(args.page)),
  });

  await run(f, [intakeReadTool]);

  assert.equal(f.requests.length, 4);
  const finalResults = f.requests
    .at(-1)!
    .body.messages.filter((message) => message.role === 'tool');
  assert.equal(finalResults.length, 3);

  const olderContent = textContent(finalResults[0]);
  const older = JSON.parse(olderContent) as {
    instructions: string;
    mappingRules: unknown;
    original: { page: number; totalPages: number; text: string };
  };
  assert.match(older.instructions, /^\[HOST_TRANSCRIPT_RECEIPT:/);
  assert.doesNotMatch(
    olderContent,
    /FICTIONAL_SCHEMA_SENTINEL/,
    'the repeated schema block is gone from the consumed read',
  );
  assert.doesNotMatch(
    olderContent,
    /FICTIONAL_PAGE_TEXT_SENTINEL/,
    'the consumed page text is gone from the consumed read',
  );
  assert.match(
    older.instructions,
    new RegExp(`instructionCharacters=${fictionalSchemaInstructions.length};`),
  );
  assert.match(older.instructions, /pageTextCharacters=\d+; pageTextSha256=[a-f0-9]{64}\./);
  assert.match(older.instructions, /Re-read the retained original with those arguments/);
  assert.match(older.instructions, /makes no extraction or confidence claim/);
  assert.equal(
    older.original.text,
    older.instructions,
    'both evicted fields state the removal, so absence is never read as emptiness',
  );
  assert.equal(
    (older.instructions.match(/HOST_TRANSCRIPT_RECEIPT/g) ?? []).length,
    1,
    'the receipt is not itself wrapped in another receipt',
  );
  assert.equal(older.original.page, 1, 'the locator metadata the receipt promises is unchanged');
  assert.equal(older.original.totalPages, 9);
  assert.deepEqual(older.mappingRules, {
    count: 0,
    version: 'fictional-rules-version',
    section: 'mapping_rules',
  });
  assert.ok(
    olderContent.length * 10 < textContent(finalResults[1]).length,
    `the consumed read shrank from ${textContent(finalResults[1]).length} to ${olderContent.length} characters`,
  );

  for (const message of finalResults.slice(1)) {
    assert.match(
      textContent(message),
      /FICTIONAL_SCHEMA_SENTINEL/,
      'the most recent read keeps its schema block in full',
    );
    assert.match(textContent(message), /FICTIONAL_PAGE_TEXT_SENTINEL/);
  }
  assert.deepEqual(
    f.calls.map((call) => call.arguments.page),
    [1, 2, 3],
    'compaction never changes the arguments a read was executed with',
  );
});

test('a second compaction pass leaves an already compacted intake read byte-identical', async () => {
  const f = harness([...intakeReadReplies([1, 2, 3, 4]), answer], {
    onTool: async ({ arguments: args }) => fictionalReadResult(Number(args.page)),
  });

  await run(f, [intakeReadTool]);

  assert.equal(f.requests.length, 5);
  const resultAt = (request: number, callId: string) =>
    textContent(
      f.requests[request]!.body.messages.find(
        (message) => message.role === 'tool' && message.tool_call_id === callId,
      ),
    );
  const firstPass = resultAt(3, 'read-call-1');
  assert.match(firstPass, /HOST_TRANSCRIPT_RECEIPT/);
  assert.equal(
    resultAt(4, 'read-call-1'),
    firstPass,
    'the later pass never re-wraps or re-counts an already compacted read',
  );
  assert.equal(
    (firstPass.match(/HOST_TRANSCRIPT_RECEIPT/g) ?? []).length,
    2,
    'exactly one receipt per evicted field, never nested',
  );
  assert.match(resultAt(4, 'read-call-2'), /HOST_TRANSCRIPT_RECEIPT/);
  assert.match(resultAt(4, 'read-call-3'), /FICTIONAL_SCHEMA_SENTINEL/);
  assert.match(resultAt(4, 'read-call-4'), /FICTIONAL_SCHEMA_SENTINEL/);
});

const packageReadTool = {
  type: 'function',
  name: 'health_intake_package',
  description: 'Read a fictional package member.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      action: { type: 'string', enum: ['read_member', 'inventory', 'plan_roles'] },
      memberId: { type: 'string' },
      page: { type: 'integer' },
    },
    required: ['id', 'action', 'memberId', 'page'],
    additionalProperties: false,
  },
} satisfies HealthTool;
const packageReadReplies = () =>
  intakeReadReplies([1, 2, 3, 4]).map((reply) => {
    const call = reply.choices[0]!.message.tool_calls[0]!;
    const args = JSON.parse(call.function.arguments);
    call.function.name = 'health_intake_package';
    call.function.arguments = JSON.stringify({
      ...args,
      action: 'read_member',
      memberId: 'fictional-member',
    });
    return reply;
  });
const packageReadResult = (page: number) => ({
  member: { memberId: 'fictional-member', locator: 'fictional-member.pdf', ordinal: 2 },
  sourceFileId: 'fictional-retained-child',
  contentUrl: '/fictional/original',
  reusedBytes: false,
  coverage: 'read_only',
  complete: false,
  original: {
    ...fictionalReadResult(page).original,
    assets: [{ id: 'fictional-retained-child', locator: `page ${page}`, derivative: false }],
  },
});
for (const representation of ['text', 'image', 'pdf'] as const)
  test(`consumed package-member ${representation} text is evicted without losing member/page metadata or inventing schema removal`, async () => {
    const f = harness([...packageReadReplies(), answer], {
      config: config({ CRS_AI_PROXY_IMAGES: 'true', CRS_AI_PROXY_PDF: 'true' }),
      onTool: async ({ arguments: args }) => {
        const metadata = packageReadResult(Number(args.page));
        return representation === 'text'
          ? metadata
          : representation === 'pdf'
            ? { pdfContent: fictionalPdf, metadata }
            : { imageContent: fictionalPng, metadata };
      },
    });
    await run(f, [packageReadTool]);
    assert.deepEqual(f.errors, []);
    const results = (request: number) =>
      f.requests[request]!.body.messages.filter((message) => message.role === 'tool').map(
        (message) => JSON.parse(textContent(message)),
      );
    const older = results(3)[0];
    assert.match(older.original.text, /^\[HOST_TRANSCRIPT_RECEIPT: the page text /);
    assert.doesNotMatch(older.original.text, /schema instructions|FICTIONAL_PAGE_TEXT_SENTINEL/);
    assert.match(
      older.original.text,
      /instructionCharacters=0; pageTextCharacters=\d+; pageTextSha256=[a-f0-9]{64}/,
    );
    assert.equal('instructions' in older, false);
    const expected = packageReadResult(1);
    assert.deepEqual(
      { ...older, original: { ...older.original, text: expected.original.text } },
      expected,
    );
    assert.deepEqual(results(4)[0], older, 'later compaction must not rewrap the receipt');
    assert.match(results(4)[2].original.text, /FICTIONAL_PAGE_TEXT_SENTINEL/);
    assert.match(results(4)[3].original.text, /FICTIONAL_PAGE_TEXT_SENTINEL/);
    assert.equal(
      f.calls.every(
        (call) =>
          call.arguments.action === 'read_member' && call.arguments.memberId === 'fictional-member',
      ),
      true,
    );
  });

test('package eviction excludes inventory, role plans, structures and unconsumed reads', () => {
  for (const args of [
    undefined,
    { action: 'inventory' },
    { action: 'plan_roles' },
    { action: 'read' },
    { action: 'structure' },
  ])
    assert.equal(
      compactIntakeReadResult('health_intake_package', packageReadResult(1), args),
      null,
    );
  assert.equal(
    compactIntakeReadResult(
      'health_intake_package',
      { structure: { literal: 'fictional'.repeat(1000) } },
      { action: 'read_member' },
    ),
    null,
  );
  const value = packageReadResult(1);
  const wire = { content: JSON.stringify(value) };
  const compactContent = compactIntakeReadResult('health_intake_package', value, {
    action: 'read_member',
  });
  assert.ok(compactContent);
  compactConsumedProxyHistory(
    [
      {
        consumed: false,
        calls: [],
        results: [{ compactContent, compacted: false, wire }],
        imageMessage: null,
        imageCompacted: false,
      },
    ],
    { retainConsumedReadResults: 0 },
  );
  assert.equal(wire.content, JSON.stringify(value));
});

test('package PDF compatibility fallback preserves read qualification for later text eviction', async () => {
  const replies = packageReadReplies();
  const f = harness(
    [
      replies[0],
      replies[1],
      () => new Response(JSON.stringify({ error: { code: 'unsupported_pdf' } }), { status: 400 }),
      replies[2],
      replies[3],
      answer,
    ],
    {
      config: config({ CRS_AI_PROXY_IMAGES: 'true', CRS_AI_PROXY_PDF: 'true' }),
      onTool: async ({ arguments: args, pdf }) => {
        const metadata = packageReadResult(Number(args.page));
        return pdf
          ? {
              pdfContent: fictionalPdf,
              metadata,
              pdfFallback: async () => ({ imageContent: fictionalPng, metadata }),
            }
          : { imageContent: fictionalPng, metadata };
      },
    },
  );
  await run(f, [packageReadTool]);
  assert.deepEqual(f.errors, []);
  const results = f.requests
    .at(-1)!
    .body.messages.filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(textContent(message)));
  for (const result of results.slice(0, 2)) {
    assert.match(result.original.text, /HOST_TRANSCRIPT_RECEIPT: the page text/);
    assert.equal(result.member.memberId, 'fictional-member');
    assert.equal('instructions' in result, false);
  }
  assert.equal(f.calls.length, 4, 'fallback must not replay successful reads');
});

test('repeated compaction passes neither re-wrap a compacted read nor evict the retained one', () => {
  const consumedReadGroup = (page: number) => {
    const value = fictionalReadResult(page);
    return {
      consumed: true,
      calls: [],
      results: [
        {
          compactContent: compactIntakeReadResult('health_intake_read', value),
          compacted: false,
          wire: { role: 'tool', tool_call_id: `read-call-${page}`, content: JSON.stringify(value) },
        },
      ],
      imageMessage: null,
      imageCompacted: false,
    };
  };
  const history = [consumedReadGroup(1), consumedReadGroup(2)];

  compactConsumedProxyHistory(history);

  assert.match(String(history[0]!.results[0]!.wire.content), /HOST_TRANSCRIPT_RECEIPT/);
  assert.equal(history[0]!.results[0]!.compacted, true);
  assert.match(String(history[1]!.results[0]!.wire.content), /FICTIONAL_SCHEMA_SENTINEL/);
  assert.equal(history[1]!.results[0]!.compacted, false);

  const afterFirstPass = JSON.stringify(history);
  for (let pass = 0; pass < 3; pass++) compactConsumedProxyHistory(history);
  assert.equal(
    JSON.stringify(history),
    afterFirstPass,
    'the retain window never walks forward and the receipt is never re-measured',
  );
});

test('compaction never rewrites the cached static prefix', async () => {
  const f = harness([...intakeReadReplies([1, 2, 3]), answer], {
    config: config({ CRS_AI_PROXY_PROMPT_CACHE: 'true' }),
    onTool: async ({ arguments: args }) => fictionalReadResult(Number(args.page)),
  });

  await run(f, [intakeReadTool]);

  const prefix = JSON.stringify(f.requests[0]!.body.messages[0]);
  const tools = JSON.stringify(f.requests[0]!.body.tools);
  assert.match(prefix, /cache_control/, 'the breakpoint under test is actually being sent');
  assert.equal(
    prefix,
    JSON.stringify({
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'Fictional system instructions',
          cache_control: { type: 'ephemeral' },
        },
      ],
    }),
  );
  for (const [round, request] of f.requests.entries()) {
    assert.equal(
      JSON.stringify(request.body.messages[0]),
      prefix,
      `compaction left messages[0] byte-identical in round ${round}`,
    );
    assert.equal(
      JSON.stringify(request.body.tools),
      tools,
      `compaction left the tools array byte-identical in round ${round}`,
    );
  }
  const compacted = f.requests
    .at(-1)!
    .body.messages.filter(
      (message) => message.role === 'tool' && textContent(message).includes('RECEIPT'),
    );
  assert.equal(compacted.length, 1, 'the guard is not vacuous: compaction really ran');
});

test('text and media envelopes are counted separately and stop without truncation', () => {
  const recentImage = 'data:image/png;base64,' + 'A'.repeat(20000);
  const body = {
    messages: [
      { role: 'system', content: 'Exact system instructions' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: recentImage } }] },
    ],
  };
  assert.deepEqual(proxyTranscriptSize(body), {
    textCharacters: JSON.stringify({
      messages: [
        { role: 'system', content: 'Exact system instructions' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: '' } }] },
      ],
    }).length,
    mediaBytes: Buffer.byteLength(recentImage),
  });
  const textLimit = proxyTranscriptLimit(body, {
    textCharacters: 10,
    mediaBytes: Buffer.byteLength(recentImage) + 1,
  });
  assert.ok(textLimit);
  assert.equal(textLimit.kind, 'text');
  assert.match(textLimit.message, /Partial work is retained/);
  const mediaLimit = proxyTranscriptLimit(body, {
    textCharacters: 1000,
    mediaBytes: Buffer.byteLength(recentImage) - 1,
  });
  assert.ok(mediaLimit);
  assert.equal(mediaLimit.kind, 'media');
  assert.equal(body.messages[0].content, 'Exact system instructions');
  const mediaContent = body.messages[1]?.content;
  assert.ok(Array.isArray(mediaContent));
  assert.equal(mediaContent[0]?.image_url.url, recentImage);

  const fullPageImage = 'data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024);
  assert.equal(
    proxyTranscriptLimit({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fullPageImage } },
            { type: 'image_url', image_url: { url: fullPageImage } },
          ],
        },
      ],
    }),
    null,
    'two recent rendered pages fit the separate media byte envelope',
  );
});

test('an oversized noncompactable transcript pauses before transport without trimming instructions', async () => {
  const instructions = 'Exact fictional user instruction. ' + 'z'.repeat(3 * 1024 * 1024);
  const f = harness([]);
  await f.bridge.start(instructions, [tool]);
  await f.bridge.turn('Latest exact fictional user instruction');
  await f.bridge.completion;

  assert.equal(f.requests.length, 0);
  assert.equal(f.calls.length, 0);
  assert.match(f.errors[0], /paused before another model request/);
  assert.match(f.errors[0], /Continue explicitly/);
  assert.equal(f.bridge.instructions, instructions);
});

test('LiteLLM proxy request redacts malformed bodies and prevents redirects', async () => {
  await assert.rejects(
    proxyRequest(
      config(),
      { model: 'fictional' },
      { fetchImpl: async () => new Response('fictional-proxy-key') },
    ),
    /malformed JSON/,
  );
  await assert.rejects(
    proxyRequest(
      config(),
      {},
      {
        fetchImpl: async (_url, init) => {
          assert.equal(init?.redirect, 'error');
          throw new Error('https://credential@proxy.test');
        },
      },
    ),
    /No fallback/,
  );
});

test('LiteLLM proxy safely identifies the Responses-to-chat transform failure', async () => {
  const secret = 'private-health-payload bearer-provider-secret';
  const diagnostics: JsonRecord[] = [];
  let clock = 200;
  await assert.rejects(
    proxyRequest(
      config(),
      { messages: [{ role: 'user', content: secret }] },
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: {
                message: `litellm.APIConnectionError: ChatgptException - Unknown items in responses API response: [] ${secret}`,
              },
            }),
            { status: 500 },
          ),
        onDiagnostic: (diagnostic) => diagnostics.push(JSON.parse(diagnostic)),
        createCorrelationId: () => '00000000-0000-4000-8000-000000000001',
        now: () => {
          clock += 25;
          return clock;
        },
      },
    ),
    (error: unknown) => {
      assert.match(errorText(error), /could not translate.*Responses API/);
      assert.match(errorText(error), /Reference: 00000000-0000-4000-8000-000000000001/);
      assert.ok(!errorText(error).includes(secret));
      return true;
    },
  );
  assert.deepEqual(diagnostics, [
    {
      event: 'litellm_proxy_request_failed',
      correlationId: '00000000-0000-4000-8000-000000000001',
      status: 500,
      durationMs: 25,
      classification: 'responses-to-chat-transform',
    },
  ]);
  assert.ok(!JSON.stringify(diagnostics).includes(secret));
});

test('LiteLLM proxy bounds untrusted error bodies and never reports their contents', async () => {
  const secret = 'private-record-and-provider-credential';
  const diagnostics: JsonRecord[] = [];
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(17 * 1024) + secret));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    proxyRequest(
      config(),
      {},
      {
        fetchImpl: async () => new Response(body, { status: 502 }),
        onDiagnostic: (diagnostic) => diagnostics.push(JSON.parse(diagnostic)),
        createCorrelationId: () => '00000000-0000-4000-8000-000000000002',
      },
    ),
    (error: unknown) => {
      assert.match(errorText(error), /HTTP 502/);
      assert.ok(!errorText(error).includes(secret));
      return true;
    },
  );
  assert.equal(cancelled, true);
  assert.equal(diagnostics[0].classification, 'unclassified');
  assert.ok(!JSON.stringify(diagnostics).includes(secret));
});

test('explicit upstream response identity is allowed while other model substitutions remain blocked', async () => {
  const mapped = config({ CRS_AI_PROXY_RESOLVED_MODEL: 'claude-fictional-20260101' });
  const f = harness(
    [
      { ...toolCall, model: mapped.resolvedModel },
      { ...answer, model: mapped.resolvedModel },
    ],
    { config: mapped },
  );
  await run(f);
  assert.deepEqual(f.errors, []);
  assert.equal(f.calls.length, 1);
  assert.ok(
    f.requests.every(
      (request) => request.body.model === mapped.model && request.body.disable_fallbacks,
    ),
  );
  const blocked = harness([{ ...toolCall, model: 'claude-unconfigured' }], { config: mapped });
  await run(blocked);
  assert.match(blocked.errors[0], /different model/);
  assert.equal(blocked.calls.length, 0);
});

test('a malformed later tool in a batch prevents all application calls', async () => {
  const batch = structuredClone(toolCall);
  batch.choices[0].message.tool_calls.push({
    id: 'call-2',
    type: 'function',
    function: { name: 'health_read', arguments: '{"id":42}' },
  });
  const f = harness([batch]);
  await run(f);
  assert.equal(f.calls.length, 0);
  assert.equal(f.errors.length, 1);
});

test('tool continuations retain substantive text and override stale first-response greeting context', async () => {
  const first = structuredClone(toolCall);
  const firstText = 'Hello. The first source lists 12. I need the second source before comparing.';
  const secondText = 'The second source lists 13. This discrepancy is unresolved.';
  const firstReply = {
    ...first,
    choices: [
      { ...first.choices[0], message: { ...first.choices[0].message, content: firstText } },
    ],
  };
  const secondReply = {
    ...first,
    choices: [
      { ...first.choices[0], message: { ...first.choices[0].message, content: secondText } },
    ],
  };
  const fixture = harness([firstReply, secondReply, answer]);
  await run(fixture);
  assert.deepEqual(fixture.errors, []);
  const textItems = fixture.events
    .filter((event) => event.method === 'item/completed')
    .map((event) => (event.params.item as JsonRecord).text);
  assert.deepEqual(textItems, [firstText, secondText, 'Fictional answer.']);
  assert.equal(fixture.requests[0].body.messages[0].content, 'Fictional system instructions');
  for (const request of fixture.requests.slice(1)) {
    assert.match(textContent(request.body.messages[0]), /continues the same response/);
    assert.match(textContent(request.body.messages[0]), /Do not greet or introduce yourself again/);
    assert.match(textContent(request.body.messages[0]), /firstAssistantResponse/);
    assert.equal(request.body.messages.filter((message) => message.role === 'system').length, 1);
    assert.equal(
      request.body.messages.find((message) => message.role === 'assistant')?.content,
      firstText,
    );
  }
  assert.equal(
    fixture.requests[2].body.messages.filter((message) => message.role === 'assistant')[1].content,
    secondText,
  );
});

test('partial text remains emitted when a following tool request is malformed', async () => {
  const fixture = harness([
    {
      ...toolCall,
      choices: [
        {
          ...toolCall.choices[0],
          message: {
            ...toolCall.choices[0].message,
            content: 'The observed value is retained, but this response is incomplete.',
            tool_calls: [{ id: 'broken' }],
          },
        },
      ],
    },
  ]);
  await run(fixture);
  assert.equal(fixture.calls.length, 0);
  assert.match(fixture.errors[0], /unsupported tool request/);
  const textItems = fixture.events.filter((event) => event.method === 'item/completed');
  assert.equal(
    (textItems[0].params.item as JsonRecord).text,
    'The observed value is retained, but this response is incomplete.',
  );
  assert.equal(
    fixture.events.some((event) => event.method === 'turn/completed'),
    false,
  );
});

test('only host-approved proposal validation returns bounded actionable feedback to the model', async () => {
  const f = harness([toolCall, answer], {
    onTool: async () => {
      throw new ModelToolValidationError(
        'INVALID_JSONL',
        'line 1: Named People proposals require a report-scoped record envelope',
      );
    },
  });
  await run(f);
  const result = f.requests[1].body.messages.find((message) => message.role === 'tool');
  const feedback = JSON.parse(textContent(result));
  assert.equal(feedback.code, 'INVALID_JSONL');
  assert.match(feedback.error, /report-scoped record envelope/);
  assert.match(feedback.error, /Preserve every original literal/);
  assert.ok(
    new ModelToolValidationError('INVALID_JSONL', 'x'.repeat(10000)).message.length <= 4000,
  );
  const unapproved = harness([toolCall, answer], {
    onTool: async () => {
      throw Object.assign(new Error('private exception details'), {
        code: 'INVALID_JSONL',
        status: 400,
      });
    },
  });
  await run(unapproved);
  assert.doesNotMatch(
    JSON.stringify(unapproved.requests[1].body.messages),
    /private exception details|INVALID_JSONL/,
  );
});

test('host-approved version conflict feedback requires state refresh without generic structure replay advice', async () => {
  const message =
    'Read the current plan and revalidate its candidates, accepted history, evidence, and exact operation receipt before retrying.';
  const f = harness([toolCall, answer], {
    onTool: async () => {
      throw new ModelToolValidationError('VERSION_CONFLICT', message);
    },
  });

  await run(f);

  const result = f.requests[1].body.messages.find((entry) => entry.role === 'tool');
  assert.deepEqual(JSON.parse(textContent(result)), {
    code: 'VERSION_CONFLICT',
    error: message,
  });
  assert.doesNotMatch(textContent(result), /proposal structure|silently replay/);
});

test('plan-create version feedback stays exact without unrelated proposal advice', async () => {
  const message =
    'health_intake_plan action "create" requires the exact current conversion.version as a positive safe integer. Use the current returned version; do not guess or reuse a stale version.';
  const f = harness([toolCall, answer], {
    onTool: async () => {
      throw new ModelToolValidationError('INTAKE_PLAN_CREATE_VERSION', message);
    },
  });

  await run(f);

  const result = f.requests[1].body.messages.find((entry) => entry.role === 'tool');
  assert.deepEqual(JSON.parse(textContent(result)), {
    code: 'INTAKE_PLAN_CREATE_VERSION',
    error: message,
  });
  assert.doesNotMatch(textContent(result), /proposal structure|records were accepted/);
});

test('physical provider receipts distinguish known rejections from unknown outcomes and preserve request-fit uncertainty', async () => {
  for (const [status, outcome, classification] of [
    [429, 'rejected', 'quota'],
    [401, 'rejected', 'authentication'],
    [408, 'unknown', 'unknown'],
    [500, 'unknown', 'unknown'],
    [503, 'rejected', 'transient'],
  ] as const) {
    const f = harness([
      () => new Response('fictional response', { status, headers: { 'retry-after': '120' } }),
    ]);
    await run(f);
    assert.equal(f.requests.length, 1);
    const start = f.events.find((e) => e.method === 'model/requestStarted')!.params;
    assert.match(String(start.requestDigest), /^[a-f0-9]{64}$/);
    assert.ok(Number(start.requestBytes) > 0);
    assert.equal((start.requestFit as JsonRecord).qualified, false);
    assert.equal((start.requestFit as JsonRecord).inputTokens, null);
    const finish = f.events.find((e) => e.method === 'model/requestFinished')!.params;
    assert.equal(finish.outcome, outcome);
    assert.equal(finish.classification, classification);
    assert.equal(finish.status, status);
    assert.equal(finish.usage, null);
    if (status === 429 || status === 503)
      assert.ok(Date.parse(String(finish.retryAt)) > Date.now() + 110_000);
    else assert.equal(finish.retryAt, null);
  }
  const f = harness([
    () => {
      throw Error('fictional disconnected transport');
    },
  ]);
  await run(f);
  assert.equal(f.requests.length, 1);
  assert.equal(
    f.events.find((e) => e.method === 'model/requestFinished')!.params.outcome,
    'unknown',
  );
  assert.equal(proxyRetryAfterMs('120', 0), 120_000);
  assert.equal(proxyRetryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT', 0), 120_000);
  assert.equal(proxyRetryAfterMs('invalid', 0), undefined);
});

test('provider context rejection distinguishes initial admission from a productive tool continuation', async () => {
  for (const productive of [false, true]) {
    let requests = 0;
    let ended!: (error: Error) => void;
    const terminal = new Promise<Error>((resolve) => {
      ended = resolve;
    });
    const bridge = new ProxyModelBridge({
      config: config(),
      fetchImpl: async () => {
        if (productive && requests++ === 0) return json(toolCall);
        return new Response(
          JSON.stringify({
            error: { code: 'context_length_exceeded', message: 'Fictional request too large' },
          }),
          { status: 400 },
        );
      },
      onTool: async () => ({ record: 'Fictional unique tool result' }),
      onEvent() {},
      onExit: ended,
    });
    try {
      await bridge.start('Fictional scoped test', [tool]);
      await bridge.turn('Read the fictional unit.');
      const error = await terminal;
      assert.ok(error instanceof ModelContextLimitError);
      assert.equal(error.origin, productive ? 'slice' : 'initial');
    } finally {
      bridge.close();
    }
  }
});
