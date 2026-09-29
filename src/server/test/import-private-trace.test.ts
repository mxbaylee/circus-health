import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createPrivateImportTrace } from '../import-private-trace.ts';
import { createImportDiagnostics, privateTraceEnvironmentOptions } from '../import-diagnostics.ts';
import { markModelToolTerminalError } from '../model-tool-validation.ts';
import {
  ProxyModelBridge,
  proxyRequest,
  type HealthTool,
  type ProxyConfig,
} from '../proxy-model-bridge.ts';

const secret = 'Independently fictional sensitive health content';
const proxyConfig: ProxyConfig = {
  backend: 'litellm',
  model: 'fictional-model',
  baseUrl: 'http://proxy.test',
  apiKey: 'fictional-connection-key',
  reasoning: null,
  images: false,
  pdf: false,
  promptCache: false,
  localOnly: false,
  resolvedModel: null,
  timeoutSeconds: 30,
};
function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'circus-private-trace-')));
  const root = join(base, 'trace');
  const grantFile = join(base, 'grant.json');
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root, grantFile };
}

function grant(
  grantFile: string,
  profileId = 'fictional',
  expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(),
) {
  writeFileSync(grantFile, JSON.stringify({ profileId, expiresAt }), { mode: 0o600 });
  chmodSync(grantFile, 0o600);
}

function traceOptions(root: string, grantFile: string) {
  return { directory: root, grantFile, acknowledged: true };
}

function traceFiles(root: string) {
  const output = readdirSync(root).find((name) => name.startsWith('private-import-'))!;
  return readdirSync(join(root, output))
    .sort()
    .map((name) => join(root, output, name));
}

function traceEntries(root: string) {
  return traceFiles(root).map((file) => JSON.parse(gunzipSync(readFileSync(file)).toString()));
}

const healthTool = {
  type: 'function',
  name: 'health_read',
  description: 'Read independently fictional scoped evidence',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
} satisfies HealthTool;

const modelAnswer = {
  model: 'fictional-model',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Independently fictional answer' },
    },
  ],
};

function toolReply(ids: string[]) {
  return {
    model: 'fictional-model',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: ids.map((id) => ({
            id,
            type: 'function',
            function: { name: 'health_read', arguments: JSON.stringify({ id }) },
          })),
        },
      },
    ],
  };
}

const privateEventForMetadata = (event: string) => {
  if (event === 'model.request.started') return 'model.request';
  if (event === 'model.request.completed' || event === 'model.request.failed')
    return 'model.response';
  if (event === 'model.tool.started') return 'tool.request';
  if (event === 'model.tool.completed' || event === 'model.tool.failed') return 'tool.response';
  return null;
};

test('private payload tracing requires explicit acknowledgment and an owner-only non-repository directory', (t) => {
  const { root, grantFile } = fixture(t);
  grant(grantFile);
  const off = createPrivateImportTrace({ directory: root, grantFile });
  off.capture('fictional', 'model.request', {}, { text: secret });
  assert.deepEqual(readdirSync(root), []);
  assert.equal(off.status('fictional').enabled, false);
  assert.equal(
    createPrivateImportTrace({ directory: root, acknowledged: true }).status('fictional').reason,
    'grant_file_required',
  );
  chmodSync(root, 0o755);
  assert.equal(
    createPrivateImportTrace(traceOptions(root, grantFile)).status('fictional').enabled,
    false,
  );
  chmodSync(root, 0o700);
  const linked = join(root, 'link');
  symlinkSync(root, linked);
  assert.equal(
    createPrivateImportTrace(traceOptions(linked, grantFile)).status('fictional').enabled,
    false,
  );
  mkdirSync(join(root, '.git'));
  assert.equal(
    createPrivateImportTrace(traceOptions(root, grantFile)).status('fictional').enabled,
    false,
  );
});

test('operator trace caps keep defaults, accept bounded overrides and fail closed when invalid', (t) => {
  assert.deepEqual(privateTraceEnvironmentOptions({}), {
    maxTotalBytes: 512 * 1024 * 1024,
    maxEntryBytes: 24 * 1024 * 1024,
    maxEntries: 8192,
  });
  assert.deepEqual(
    privateTraceEnvironmentOptions({
      CRS_IMPORT_PRIVATE_TRACE_MAX_TOTAL_MIB: '2048',
      CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRY_MIB: '32',
      CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRIES: '16384',
    }),
    {
      maxTotalBytes: 2048 * 1024 * 1024,
      maxEntryBytes: 32 * 1024 * 1024,
      maxEntries: 16384,
    },
  );
  for (const env of [
    { CRS_IMPORT_PRIVATE_TRACE_MAX_TOTAL_MIB: '2049' },
    { CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRY_MIB: '0' },
    { CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRIES: 'many' },
  ])
    assert.deepEqual(privateTraceEnvironmentOptions(env), {
      configurationError: 'invalid_limits',
    });

  const { root, grantFile } = fixture(t);
  grant(grantFile);
  const trace = createPrivateImportTrace({
    ...traceOptions(root, grantFile),
    ...privateTraceEnvironmentOptions({ CRS_IMPORT_PRIVATE_TRACE_MAX_ENTRIES: '16385' }),
  });
  assert.equal(trace.status('fictional').enabled, false);
  assert.equal(trace.status('fictional').reason, 'invalid_limits');
  assert.deepEqual(readdirSync(root), []);
});

test('private payloads stay compressed and permission-restricted outside metadata exports', (t) => {
  const { root, grantFile } = fixture(t);
  grant(grantFile, 'fictional-profile');
  const privateTrace = createPrivateImportTrace(traceOptions(root, grantFile));
  const diagnostics = createImportDiagnostics({ enabled: true, privateTrace });
  t.after(() => diagnostics.close());
  diagnostics.run({ profileId: 'fictional-profile', importId: 'fictional-original' }, () => {
    diagnostics.capturePayload?.('model.request', { messages: [{ content: secret }] });
    diagnostics.record('import.progress', { readyRecords: 2 });
  });
  diagnostics.capturePayload?.('model.request', {
    messages: [{ content: 'No scoped import, no trace' }],
  });
  const status = privateTrace.status('fictional-profile');
  assert.equal(status.recordedEvents, 1);
  const folder = join(root, readdirSync(root)[0]!);
  const file = join(folder, readdirSync(folder)[0]!);
  assert.equal(statSync(folder).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(gunzipSync(readFileSync(file)).toString(), /fictional sensitive health/);
  const exported = JSON.stringify(diagnostics.exportSnapshot('fictional-profile'));
  assert.doesNotMatch(exported, /fictional sensitive health|fictional-profile|fictional-original/);
  assert.equal(privateTrace.status('another-profile').recordedEvents, 0);
});

test('captured payloads share an opaque trace event id with sanitized metadata', (t) => {
  const { root, grantFile } = fixture(t);
  grant(grantFile, 'fictional-profile');
  const traceIds = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'];
  const privateTrace = createPrivateImportTrace({
    ...traceOptions(root, grantFile),
    createId: () => traceIds.shift()!,
  });
  const diagnostics = createImportDiagnostics({ enabled: true, privateTrace });
  t.after(() => diagnostics.close());
  diagnostics.run(
    {
      profileId: 'fictional-profile',
      importId: 'private-filename.pdf',
      runId: 'private-run',
      turnId: 'private-turn',
      providerRequestId: 'private-provider-request',
    },
    () => {
      diagnostics.capturePayload?.('model.request', { text: secret });
      diagnostics.record('model.request.started', { requestBytes: 12 });
      diagnostics.capturePayload?.('model.response', { text: secret });
      diagnostics.record('model.request.completed', { responseBytes: 34 });
      diagnostics.record('import.progress', {
        // A caller cannot manufacture a private-trace link.
        traceEventId: '10000000-0000-4000-8000-000000000099',
      });
      diagnostics.record('import.progress', { traceEventId: 99 });
      diagnostics.record('import.progress', { traceEventId: true });
    },
  );

  const exported = diagnostics.exportSnapshot('fictional-profile');
  const correlated = exported.events.map((event) => event.fields.traceEventId).filter(Boolean);
  assert.deepEqual(correlated, [
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
  ]);
  assert.doesNotMatch(
    JSON.stringify(exported),
    /private-filename|private-run|private-turn|private-provider-request|000000000099/,
  );
  const privateIds = traceFiles(root).map(
    (file) => JSON.parse(gunzipSync(readFileSync(file)).toString()).traceEventId,
  );
  assert.deepEqual(privateIds, correlated);
  assert.deepEqual(exported.privateTrace?.limits, {
    maxTotalBytes: 512 * 1024 * 1024,
    maxEntryBytes: 24 * 1024 * 1024,
    maxEntries: 8192,
  });
  assert.ok(exported.events.slice(-3).every((event) => !('traceEventId' in event.fields)));
});

test('new captures replace unmatched links while omission and clear invalidate pending links', (t) => {
  const { root, grantFile } = fixture(t);
  grant(grantFile);
  const traceIds = [
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000004',
  ];
  const privateTrace = createPrivateImportTrace({
    ...traceOptions(root, grantFile),
    createId: () => traceIds.shift()!,
  });
  const diagnostics = createImportDiagnostics({ enabled: true, privateTrace });
  t.after(() => diagnostics.close());
  const context = { profileId: 'fictional', importId: 'fictional-import' };

  diagnostics.capturePayload?.('model.response', { response: 1 }, context);
  diagnostics.capturePayload?.('model.response', { response: 2 }, context);
  diagnostics.record('model.request.completed', {}, context);
  assert.equal(
    diagnostics.snapshot('fictional')[0]?.fields.traceEventId,
    '20000000-0000-4000-8000-000000000002',
  );

  diagnostics.capturePayload?.('model.request', { request: 1 }, context);
  diagnostics.clear('fictional');
  diagnostics.record('model.request.started', {}, context);
  assert.equal(diagnostics.snapshot('fictional')[0]?.fields.traceEventId, undefined);

  diagnostics.capturePayload?.('model.request', { request: 2 }, context);
  diagnostics.omitPayload?.('model.request', 'response_size', context);
  diagnostics.record('model.request.started', {}, context);
  assert.equal(diagnostics.snapshot('fictional')[1]?.fields.traceEventId, undefined);
});

test('a failed capture invalidates an unmatched link before the next metadata event', (t) => {
  const { root, grantFile } = fixture(t);
  grant(grantFile);
  const privateTrace = createPrivateImportTrace(traceOptions(root, grantFile));
  const diagnostics = createImportDiagnostics({ enabled: true, privateTrace });
  t.after(() => diagnostics.close());
  const context = { profileId: 'fictional', importId: 'fictional-import' };

  diagnostics.capturePayload?.('model.response', { response: 'retained' }, context);
  grant(grantFile, 'another-profile');
  diagnostics.capturePayload?.('model.response', { response: 'denied' }, context);
  diagnostics.record('model.request.failed', {}, context);

  assert.equal(privateTrace.status('fictional').recordedEvents, 1);
  assert.equal(diagnostics.snapshot('fictional')[0]?.fields.traceEventId, undefined);
});

test('actual proxy and tool success/failure ordering preserves exact FIFO correlation', async (t) => {
  const { root, grantFile } = fixture(t);
  grant(grantFile);
  const privateTrace = createPrivateImportTrace(traceOptions(root, grantFile));
  const diagnostics = createImportDiagnostics({ enabled: true, privateTrace });
  t.after(() => diagnostics.close());
  const replies = [toolReply(['call-success', 'call-failure']), modelAnswer];
  const errors: string[] = [];
  const calls: string[] = [];
  const bridge = new ProxyModelBridge({
    config: proxyConfig,
    diagnostics,
    diagnosticContext: {
      profileId: 'fictional',
      importId: 'fictional-import',
      runId: 'fictional-run',
    },
    fetchImpl: async () => new Response(JSON.stringify(replies.shift())),
    onTool: async ({ callId }) => {
      calls.push(callId);
      if (callId === 'call-failure') throw new Error('Independently fictional tool failure');
      return { result: 'Independently fictional success' };
    },
    onExit: (error) => errors.push(error.message),
  });
  await bridge.start('Independently fictional instructions', [healthTool]);
  await bridge.turn('Independently fictional request');
  await bridge.completion;

  assert.deepEqual(calls, ['call-success', 'call-failure']);
  assert.deepEqual(errors, []);
  const privateEntries = traceEntries(root);
  const correlated = diagnostics
    .snapshot('fictional')
    .filter((event) => typeof event.fields.traceEventId === 'string');
  assert.deepEqual(
    correlated.map((event) => event.fields.traceEventId),
    privateEntries.map((entry) => entry.traceEventId),
  );
  assert.deepEqual(
    correlated.map((event) => privateEventForMetadata(event.event)),
    privateEntries.map((entry) => entry.event),
  );
  assert.deepEqual(
    correlated.filter((event) => event.event.startsWith('model.tool.')).map((event) => event.event),
    ['model.tool.started', 'model.tool.completed', 'model.tool.started', 'model.tool.failed'],
  );
});

for (const detached of [false, true])
  test(`host terminal capture after bridge close retains the exact tool failure join (detached=${detached})`, async (t) => {
    const { root, grantFile } = fixture(t);
    grant(grantFile);
    const privateTrace = createPrivateImportTrace(traceOptions(root, grantFile));
    const diagnostics = createImportDiagnostics({ enabled: true, privateTrace });
    t.after(() => diagnostics.close());
    const diagnosticContext = {
      profileId: 'fictional',
      importId: 'fictional-import',
      runId: 'fictional-run',
      ...(detached
        ? {
            operationId: undefined,
            requestId: undefined,
            spanId: undefined,
            parentSpanId: undefined,
          }
        : {}),
    };
    let calls = 0;
    let bridge: ProxyModelBridge;
    bridge = new ProxyModelBridge({
      config: proxyConfig,
      diagnostics,
      diagnosticContext,
      fetchImpl: async () =>
        new Response(JSON.stringify(toolReply(['terminal-call', 'must-not-run']))),
      onTool: async () => {
        calls++;
        diagnostics.capturePayload?.(
          'tool.response',
          { failed: true, result: 'Independently fictional private host failure' },
          diagnosticContext,
        );
        const error = new Error('Independently fictional terminal error');
        markModelToolTerminalError(error);
        bridge.close();
        throw error;
      },
    });
    await bridge.start('Independently fictional instructions', [healthTool]);
    await bridge.turn('Independently fictional request');
    await bridge.completion;

    assert.equal(calls, 1);
    const metadata = diagnostics.snapshot('fictional');
    const failure = metadata.find((event) => event.event === 'model.tool.failed');
    const privateEntries = traceEntries(root);
    const privateFailure = privateEntries.find((entry) => entry.event === 'tool.response');
    assert.equal(failure?.fields.errorCode, 'tool_rejected_after_close');
    assert.equal(failure?.fields.traceEventId, privateFailure?.traceEventId);
    assert.equal(failure?.context.turnId, privateFailure?.context.turnId);
    assert.deepEqual(failure?.context, privateFailure?.context);
    assert.deepEqual(
      metadata
        .filter((event) => typeof event.fields.traceEventId === 'string')
        .map((event) => event.fields.traceEventId),
      privateEntries.map((entry) => entry.traceEventId),
    );
  });

test('trace bounds omit whole entries honestly without altering payloads or breaking imports', (t) => {
  const { root, grantFile } = fixture(t);
  grant(grantFile);
  const trace = createPrivateImportTrace({
    ...traceOptions(root, grantFile),
    maxEntries: 1,
    maxEntryBytes: 300,
  });
  trace.capture('fictional', 'tool.response', {}, { value: '2.000', unit: 'mg' });
  trace.capture('fictional', 'tool.response', {}, { value: '3.000' });
  trace.capture('fictional', 'tool.response', {}, { text: 'x'.repeat(1000) });
  const status = trace.status('fictional');
  assert.equal(status.recordedEvents, 1);
  assert.equal(status.omittedEvents, 2);
  assert.equal(status.reason, 'entry_limit');
  const folder = join(root, readdirSync(root)[0]!);
  assert.equal(readdirSync(folder).length, 1);
  chmodSync(root, 0o755);
  assert.doesNotThrow(() => trace.capture('fictional', 'model.response', {}, { text: secret }));
  assert.equal(trace.status('fictional').enabled, false);
  assert.equal(trace.status('fictional').reason, 'unsafe_or_unwritable_directory');
});

test('known connection credentials are removed from private string payloads without corrupting JSON numbers', (t) => {
  const { root, grantFile } = fixture(t);
  grant(grantFile);
  const trace = createPrivateImportTrace(traceOptions(root, grantFile));
  trace.capture('fictional', 'model.response', {}, { text: 'Bearer 12345', value: 12345 }, [
    '12345',
  ]);
  const folder = join(root, readdirSync(root)[0]!);
  const payload = JSON.parse(
    gunzipSync(readFileSync(join(folder, readdirSync(folder)[0]!))).toString(),
  ).payload;
  assert.equal(payload.text, 'Bearer [redacted connection credential]');
  assert.equal(payload.value, 12345);
});

test('reloadable grants authorize one exact profile for at most 24 hours', (t) => {
  const { base, root, grantFile } = fixture(t);
  const clock = new Date('2026-09-14T10:00:00.000Z');
  grant(grantFile, 'fictional-a', '2026-09-14T11:00:00.000Z');
  const trace = createPrivateImportTrace({
    ...traceOptions(root, grantFile),
    now: () => clock,
  });
  trace.capture('fictional-a', 'model.request', {}, { text: 'authorized-a' });
  trace.capture('fictional-b', 'model.request', {}, { text: 'not-authorized-b' });
  assert.equal(trace.status('fictional-a').recordedEvents, 1);
  assert.equal(trace.status('fictional-b').recordedEvents, 0);
  assert.equal(trace.status('fictional-b').reason, 'profile_not_authorized');

  const replacement = join(base, 'grant.next');
  grant(replacement, 'fictional-b', '2026-09-14T11:00:00.000Z');
  renameSync(replacement, grantFile);
  trace.capture('fictional-a', 'model.request', {}, { text: 'no-longer-authorized-a' });
  trace.capture('fictional-b', 'model.request', {}, { text: 'authorized-b' });
  assert.equal(trace.status('fictional-a').recordedEvents, 1);
  assert.equal(trace.status('fictional-a').reason, 'profile_not_authorized');
  assert.equal(trace.status('fictional-b').recordedEvents, 1);

  grant(grantFile, 'fictional-b', '2026-09-14T10:00:00.000Z');
  assert.equal(trace.status('fictional-b').reason, 'grant_expired');
  grant(grantFile, 'fictional-b', '2026-09-15T10:00:00.001Z');
  assert.equal(trace.status('fictional-b').reason, 'grant_too_distant');
  writeFileSync(
    grantFile,
    JSON.stringify({ profileId: 'fictional-b', expiresAt: 'bad', extra: true }),
  );
  assert.equal(trace.status('fictional-b').reason, 'invalid_grant');
  writeFileSync(grantFile, 'x'.repeat(4 * 1024 + 1));
  assert.equal(trace.status('fictional-b').reason, 'unsafe_grant_file');
});

test('grant and trace paths fail closed when permissions, symlinks or Git ancestry change', (t) => {
  const { base, root, grantFile } = fixture(t);
  grant(grantFile);
  const trace = createPrivateImportTrace(traceOptions(root, grantFile));
  chmodSync(grantFile, 0o644);
  trace.capture('fictional', 'model.request', {}, { text: secret });
  assert.equal(trace.status('fictional').reason, 'unsafe_grant_file');
  assert.equal(traceFiles(root).length, 0);

  grant(grantFile);
  mkdirSync(join(root, '.git'));
  trace.capture('fictional', 'model.request', {}, { text: secret });
  assert.equal(trace.status('fictional').enabled, false);
  assert.equal(trace.status('fictional').reason, 'unsafe_or_unwritable_directory');
  assert.equal(trace.status('fictional').omittedEvents, 1);

  const separateRoot = join(base, 'separate-trace');
  mkdirSync(separateRoot, { mode: 0o700 });
  const realGrant = join(base, 'real-grant.json');
  const linkedGrant = join(base, 'linked-grant.json');
  grant(realGrant);
  symlinkSync(realGrant, linkedGrant);
  const linked = createPrivateImportTrace(traceOptions(separateRoot, linkedGrant));
  assert.equal(linked.status('fictional').enabled, false);
  assert.equal(linked.status('fictional').reason, 'unsafe_grant_file');
});

test('complete malformed model bodies are privately captured while oversized bodies are explicitly omitted', async (t) => {
  const { root, grantFile } = fixture(t);
  grant(grantFile);
  const privateTrace = createPrivateImportTrace(traceOptions(root, grantFile));
  const diagnostics = createImportDiagnostics({ enabled: true, privateTrace });
  t.after(() => diagnostics.close());
  await assert.rejects(
    diagnostics.run({ profileId: 'fictional', importId: 'fictional-import' }, () =>
      proxyRequest(
        proxyConfig,
        { prompt: 'Independently fictional request' },
        {
          diagnostics,
          fetchImpl: async () =>
            new Response('malformed fictional-connection-key response', { status: 200 }),
        },
      ),
    ),
    /malformed JSON/,
  );
  assert.equal(privateTrace.status('fictional').recordedEvents, 2);
  assert.equal(privateTrace.status('fictional').omittedEvents, 0);
  const firstPrivateEntries = traceEntries(root);
  const firstMetadata = diagnostics
    .snapshot('fictional')
    .filter((event) => typeof event.fields.traceEventId === 'string');
  assert.deepEqual(
    firstMetadata.map((event) => event.fields.traceEventId),
    firstPrivateEntries.map((entry) => entry.traceEventId),
  );
  assert.deepEqual(
    firstMetadata.map((event) => privateEventForMetadata(event.event)),
    firstPrivateEntries.map((entry) => entry.event),
  );
  const responseTrace = traceFiles(root)
    .map((file) => gunzipSync(readFileSync(file)).toString())
    .find((content) => content.includes('model.response'))!;
  assert.match(responseTrace, /malformed \[redacted connection credential\] response/);
  assert.doesNotMatch(responseTrace, /fictional-connection-key/);
  assert.match(responseTrace, /"truncated":false/);

  const largeBody = new Uint8Array(8 * 1024 * 1024 + 1);
  await assert.rejects(
    diagnostics.run({ profileId: 'fictional', importId: 'fictional-import' }, () =>
      proxyRequest(
        proxyConfig,
        { prompt: 'Second fictional request' },
        {
          diagnostics,
          fetchImpl: async () => new Response(largeBody, { status: 200 }),
        },
      ),
    ),
    /exceeded the supported size/,
  );
  assert.equal(privateTrace.status('fictional').recordedEvents, 3);
  assert.equal(privateTrace.status('fictional').omittedEvents, 1);
  assert.equal(privateTrace.status('fictional').reason, 'response_size');
  const allMetadata = diagnostics.snapshot('fictional');
  assert.deepEqual(
    allMetadata
      .filter((event) => typeof event.fields.traceEventId === 'string')
      .map((event) => event.fields.traceEventId),
    traceEntries(root).map((entry) => entry.traceEventId),
  );
  assert.equal(
    allMetadata.filter((event) => event.event === 'model.request.failed').at(-1)?.fields
      .traceEventId,
    undefined,
  );
});

test('bounded upstream error traces report truncation and redact the connection key', async (t) => {
  const { root, grantFile } = fixture(t);
  grant(grantFile);
  const privateTrace = createPrivateImportTrace(traceOptions(root, grantFile));
  const diagnostics = createImportDiagnostics({ enabled: true, privateTrace });
  t.after(() => diagnostics.close());
  await assert.rejects(
    diagnostics.run({ profileId: 'fictional', importId: 'fictional-import' }, () =>
      proxyRequest(
        proxyConfig,
        { prompt: 'Fictional request' },
        {
          diagnostics,
          onDiagnostic: () => {},
          fetchImpl: async () =>
            new Response('fictional-connection-key' + 'x'.repeat(17 * 1024), { status: 500 }),
        },
      ),
    ),
    /HTTP 500/,
  );
  const status = privateTrace.status('fictional');
  assert.equal(status.recordedEvents, 2);
  assert.equal(status.truncatedEvents, 1);
  assert.equal(status.omittedEvents, 0);
  const responseTrace = traceFiles(root)
    .map((file) => gunzipSync(readFileSync(file)).toString())
    .find((content) => content.includes('model.response'))!;
  assert.match(responseTrace, /"truncated":true/);
  assert.doesNotMatch(responseTrace, /fictional-connection-key/);
});
