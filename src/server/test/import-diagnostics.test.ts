import { attachPersonalDurability } from '../portable.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { createImportDiagnostics, structuralSummary } from '../import-diagnostics.ts';
import type { ImportDiagnosticEvent } from '../import-diagnostics.ts';
import { ProxyModelBridge, proxyConfig, proxyRequest } from '../proxy-model-bridge.ts';
import type { HealthTool } from '../proxy-model-bridge.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { openDatabase } from '../database.ts';
import { createApp } from '../index.ts';
import { diagnosticRoute, isDiagnosticRoute } from '../../shared/import-diagnostic-route.ts';
import { receiveIntakeUpload, type UploadRequest } from '../intake-upload.ts';
import * as intake from '../intake.ts';

function uploadRequest(
  chunks: Parameters<typeof Readable.from>[0],
  headers: Record<string, string> = {},
): UploadRequest {
  const req = Readable.from(chunks);
  return Object.assign(req, { headers }) as unknown as UploadRequest;
}

const fictionalSecret = 'Fictional patient narrative that must not enter diagnostics';

test('diagnostic routes preserve fixed action names but reject raw private paths', () => {
  for (const [path, expected] of [
    [
      '/api/profiles/fictional-person/intakes/private-report.pdf/report-source?label=secret',
      '/profiles/:profile/intakes/:item/report-source',
    ],
    [
      '/api/profiles/fictional-person/intakes/report-queue/private-group',
      '/profiles/:profile/intakes/report-queue/:item',
    ],
    [
      '/intakes/private-report.pdf/identity-review#private-anchor',
      '/profiles/:profile/intakes/:item/identity-review',
    ],
    ['/vision-prescriptions/private-record', '/profiles/:profile/vision-prescriptions/:item'],
  ]) {
    assert.equal(diagnosticRoute(path!), expected);
    assert.equal(isDiagnosticRoute(expected!), true);
    assert.equal(isDiagnosticRoute(path!), false);
  }
  const diagnostics = createImportDiagnostics({ enabled: true });
  diagnostics.record(
    'http.request.started',
    { route: '/api/profiles/private-person/intakes/private.pdf' },
    { profileId: 'fictional' },
  );
  assert.ok(!('route' in diagnostics.snapshot('fictional')[0]!.fields));
  diagnostics.close();
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'health-import-diagnostics-'));
  const profileId = 'fictional-profile';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId: profileId });
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db };
}

test('bounded profile diagnostics correlate async work and export salted identifiers', async () => {
  let tick = Date.parse('2026-01-01T00:00:00Z');
  const diagnostics = createImportDiagnostics({
    enabled: true,
    capacity: 10,
    now: () => new Date(tick++),
  });
  await diagnostics.run(
    {
      profileId: 'fictional-profile',
      requestId: 'request-stable-id',
      importId: 'import-stable-id',
    },
    async () => {
      await Promise.resolve();
      for (let index = 0; index < 12; index++)
        diagnostics.record('import.progress', {
          accountedUnits: index,
          // Arbitrary string fields cannot turn the recorder into a second content archive.
          unsafeText: fictionalSecret,
        });
    },
  );
  const events = diagnostics.snapshot('fictional-profile');
  assert.equal(events.length, 10);
  assert.equal(events[0]?.fields.accountedUnits, 2);
  assert.equal(events[0]?.context.requestId, 'request-stable-id');
  assert.equal(events[0]?.context.importId, 'import-stable-id');
  assert.ok(events.every((event) => !Object.hasOwn(event.fields, 'unsafeText')));
  assert.deepEqual(diagnostics.snapshot('another-profile'), []);

  const exported = diagnostics.exportSnapshot('fictional-profile');
  assert.equal(exported.events.length, 10);
  assert.equal(exported.droppedEvents, 2);
  assert.deepEqual(exported.eventWindow, {
    windowId: exported.eventWindow.windowId,
    recording: 'enabled',
    storage: 'memory_only',
    capacity: 10,
    observedEvents: 12,
    observedSince: '2026-01-01T00:00:00.000Z',
    notRetainedWhileDisabled: 0,
    omittedBeforeWindow: null,
    completeness: 'not_established',
  });
  assert.match(exported.eventWindow.windowId!, /^[0-9a-f-]{36}$/);
  // The first observation can predate every retained event after overflow.
  assert.ok(exported.eventWindow.observedSince! < exported.events[0]!.timestamp);
  assert.equal(diagnostics.exportSnapshot('another-profile').eventWindow.observedEvents, 0);
  assert.notEqual(exported.events[0]?.context.requestId, 'request-stable-id');
  assert.equal(
    exported.events[0]?.context.requestId,
    exported.events[1]?.context.requestId,
    'one export retains internal correlation',
  );
  assert.doesNotMatch(JSON.stringify(exported), /stable-id|patient narrative/);
  diagnostics.close();
});

test('disabled detailed windows count only current profile observations and reset with lifecycle', () => {
  const diagnostics = createImportDiagnostics({ enabled: false });
  for (const profileId of ['fictional-alpha', 'fictional-alpha', 'fictional-beta'])
    diagnostics.record('import.progress', {}, { profileId });
  const exported = diagnostics.exportSnapshot('fictional-alpha');
  assert.equal(exported.eventWindow.recording, 'disabled');
  assert.equal(exported.eventWindow.observedEvents, 2);
  assert.equal(exported.eventWindow.notRetainedWhileDisabled, 2);
  assert.equal(exported.eventWindow.omittedBeforeWindow, null);
  assert.deepEqual(exported.events, []);
  assert.equal(exported.droppedEvents, 0);
  diagnostics.clear('fictional-alpha');
  diagnostics.record('import.progress', {}, { profileId: 'fictional-alpha' });
  assert.equal(diagnostics.exportSnapshot('fictional-alpha').eventWindow.observedSince, null);
  assert.equal(diagnostics.exportSnapshot('fictional-beta').eventWindow.observedEvents, 1);
  diagnostics.detachSummaryStore('fictional-beta');
  assert.equal(diagnostics.exportSnapshot('fictional-beta').eventWindow.observedEvents, 0);
  diagnostics.attachSummaryStore('fictional-alpha', { read: () => null, write: () => {} });
  diagnostics.record('import.progress', {}, { profileId: 'fictional-alpha' });
  assert.equal(diagnostics.exportSnapshot('fictional-alpha').eventWindow.observedEvents, 1);
  diagnostics.close();
  assert.equal(diagnostics.exportSnapshot('fictional-alpha').eventWindow.observedEvents, 0);
});

test('exports preserve random browser HTTP correlation but salt source and arbitrary identifiers', () => {
  const diagnostics = createImportDiagnostics({ enabled: true });
  const requestId = '12345678-1234-4234-8234-123456789abc';
  diagnostics.record(
    'http.request.started',
    {},
    {
      profileId: 'fictional',
      requestId,
      clientRequestId: requestId,
      importId: 'private-filename.pdf',
    },
  );
  const exported = diagnostics.exportSnapshot('fictional');
  assert.equal(exported.events[0]?.context.requestId, requestId);
  assert.equal(exported.events[0]?.context.clientRequestId, requestId);
  assert.doesNotMatch(JSON.stringify(exported), /private-filename/);
  diagnostics.close();
});

test('diagnostic output failures cannot affect clinical work', () => {
  const diagnostics = createImportDiagnostics({
    enabled: true,
    onEvent: () => {
      throw new Error('Fictional log sink unavailable');
    },
  });
  assert.doesNotThrow(() =>
    diagnostics.record('import.progress', { readyRecords: 2 }, { profileId: 'fictional' }),
  );
  assert.equal(diagnostics.snapshot('fictional').length, 1);
  diagnostics.close();
});

test('console events carry one stable opaque profile scope without changing snapshots', () => {
  const output: Array<{ event: ImportDiagnosticEvent; consoleScopeId: string }> = [];
  const diagnostics = createImportDiagnostics({
    enabled: true,
    onEvent: (event, consoleScopeId) => output.push({ event, consoleScopeId }),
  });
  diagnostics.record('import.progress', {}, { profileId: 'fictional-alpha' });
  diagnostics.record('import.progress', {}, { profileId: 'fictional-alpha' });
  diagnostics.record('import.progress', {}, { profileId: 'fictional-beta' });

  const scopes = output.map(({ consoleScopeId }) => consoleScopeId);
  assert.match(scopes[0] || '', /^[0-9a-f]{20}$/);
  assert.equal(scopes[0], scopes[1]);
  assert.notEqual(scopes[0], scopes[2]);
  assert.equal(diagnostics.exportSnapshot('fictional-alpha').consoleScopeId, scopes[0]);
  assert.equal(
    Object.hasOwn(diagnostics.snapshot('fictional-alpha')[0]?.context || {}, 'profileScopeId'),
    false,
  );
  assert.doesNotMatch(JSON.stringify(output), /fictional-alpha|fictional-beta/);
  diagnostics.close();
});

test('structural summaries count payload shape and size without retaining values or keys', () => {
  const summary = structuralSummary({
    privateNarrative: fictionalSecret,
    pages: [{ text: 'Another fictional private passage', values: [1, 2, true, null] }],
  });
  assert.equal(summary.kind, 'object');
  assert.equal(summary.objectProperties, 4);
  assert.equal(summary.arrayItems, 5);
  assert.equal(summary.strings, 2);
  assert.ok(summary.stringBytes > 0);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /privateNarrative|patient narrative|private passage/,
  );
});

test('process resource sampling exists only while an import scope is active', async () => {
  const diagnostics = createImportDiagnostics({ enabled: true, resourceIntervalMs: 250 });
  await new Promise((resolve) => setTimeout(resolve, 275));
  assert.deepEqual(diagnostics.snapshot('fictional-profile'), []);
  const active = diagnostics.startActive('fictional-profile', { runId: 'fictional-run' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  active.finish({ outcome: 'completed' });
  const events = diagnostics.snapshot('fictional-profile');
  assert.equal(events[0]?.event, 'import.active.started');
  assert.ok(
    events.some(
      (event) =>
        event.event === 'process.resource.sample' && event.context.runId === 'fictional-run',
    ),
  );
  assert.equal(events.at(-1)?.event, 'import.active.completed');
  const sample = events.find((event) => event.event === 'process.resource.sample');
  assert.equal(sample?.fields.pdfWorkerSeparateProcess, true);
  assert.equal(sample?.fields.pdfWorkerMemoryIsLive, false);
  assert.equal(sample?.fields.pdfWorkerActive, false);
  assert.equal(sample?.fields.pdfWorkerRssSampleBytes, null);
  const count = events.length;
  await new Promise((resolve) => setTimeout(resolve, 275));
  assert.equal(diagnostics.snapshot('fictional-profile').length, count);
  diagnostics.close();
});

test('HTTP lifecycle records status, bounded sizes and timing without URLs or profile IDs', async (t) => {
  const f = fixture(t);
  const diagnostics = createImportDiagnostics({ enabled: true });
  const app = createApp({
    root: f.root,
    databases: new Map([[f.profileId, f.db]]),
    diagnostics,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => app.server.close(() => resolve())));
  t.after(() => diagnostics.close());
  const address = app.server.address() as AddressInfo;
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/profiles/${f.profileId}/notes?private=${encodeURIComponent(fictionalSecret)}`,
    { headers: { 'X-Client-Request-ID': '12345678-1234-4234-8234-123456789abc' } },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/);
  await response.arrayBuffer();
  const events = diagnostics.snapshot(f.profileId);
  assert.deepEqual(
    events.map((event) => event.event),
    ['http.request.started', 'http.request.completed'],
  );
  assert.equal(events[1]?.fields.status, 200);
  assert.equal(events[0]?.fields.route, '/profiles/:profile/notes');
  assert.equal(events[1]?.fields.route, '/profiles/:profile/notes');
  assert.equal(events[1]?.context.clientRequestId, '12345678-1234-4234-8234-123456789abc');
  assert.equal(typeof events[1]?.fields.responseBytes, 'number');
  assert.equal(typeof events[1]?.fields.durationMs, 'number');
  assert.doesNotMatch(JSON.stringify(events), /fictional-profile|patient narrative|private=/);
});

test('HTTP diagnostic export stays profile scoped and signals recording coverage', async (t) => {
  const f = fixture(t);
  const diagnostics = createImportDiagnostics({ enabled: true });
  const app = createApp({ root: f.root, databases: new Map([[f.profileId, f.db]]), diagnostics });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => app.server.close(() => resolve())));
  t.after(() => diagnostics.close());
  diagnostics.record(
    'import.progress',
    { readyRecords: 19 },
    { profileId: f.profileId, importId: 'fictional-source' },
  );
  diagnostics.record('import.progress', { readyRecords: 77 }, { profileId: 'another-profile' });
  const address = app.server.address() as AddressInfo;
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/profiles/${f.profileId}/import-diagnostics`,
  );
  const payload = (await response.json()) as {
    data: {
      enabled: boolean;
      consoleScopeId: string;
      events: { fields: Record<string, unknown> }[];
      coverage: string;
    };
  };
  assert.equal(response.status, 200);
  assert.equal(payload.data.enabled, true);
  assert.match(payload.data.consoleScopeId, /^[0-9a-f]{20}$/);
  assert.equal(payload.data.coverage, 'bounded_metadata_only');
  assert.ok(payload.data.events.some((event) => event.fields.readyRecords === 19));
  assert.ok(!payload.data.events.some((event) => event.fields.readyRecords === 77));
  assert.doesNotMatch(JSON.stringify(payload.data), /fictional-source|another-profile/);
  assert.equal(
    (await fetch(`http://127.0.0.1:${address.port}/api/profiles/missing/import-diagnostics`))
      .status,
    404,
  );
});

test('HTTP disconnect records one aborted terminal event', async (t) => {
  const f = fixture(t);
  const diagnostics = createImportDiagnostics({ enabled: true });
  const app = createApp({
    root: f.root,
    databases: new Map([[f.profileId, f.db]]),
    diagnostics,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => app.server.close(() => resolve())));
  t.after(() => diagnostics.close());
  const address = app.server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      path: `/api/profiles/${f.profileId}/intakes`,
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/pdf',
        'content-length': '1000000',
        'x-filename': 'fictional.pdf',
        'x-source-name': 'Fictional%20Clinic',
      },
    });
    req.on('error', () => resolve());
    req.write(Buffer.alloc(1_024));
    setTimeout(() => req.destroy(), 20);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const events = diagnostics.snapshot(f.profileId);
  assert.deepEqual(
    events.map((event) => event.event),
    ['http.request.started', 'http.request.aborted'],
  );
  assert.equal(events[1]?.fields.requestBytes, 1_000_000);
});

test('model transport failure records only safe bounded metadata', async () => {
  const diagnostics = createImportDiagnostics({ enabled: true });
  const config = proxyConfig({
    CRS_AI_MODEL: 'fictional-model',
    CRS_AI_BASE_URL: 'http://proxy.invalid',
    CRS_AI_API_KEY: 'fictional-credential',
  });
  await assert.rejects(
    diagnostics.run({ profileId: 'fictional-profile', runId: 'fictional-run' }, () =>
      proxyRequest(
        config,
        { messages: [{ role: 'user', content: fictionalSecret }] },
        {
          diagnostics,
          onDiagnostic: () => {},
          fetchImpl: async () => {
            throw new Error(fictionalSecret);
          },
        },
      ),
    ),
    /connection failed/,
  );
  const events = diagnostics.snapshot('fictional-profile');
  assert.deepEqual(
    events.map((event) => event.event),
    ['model.request.started', 'model.request.failed'],
  );
  assert.equal(events[1]?.fields.classification, 'transport');
  assert.doesNotMatch(JSON.stringify(events), /patient narrative|credential|proxy\.invalid/);
  diagnostics.close();
});

test('model and tool tracing retains usage and structural sizes but no request or result text', async () => {
  const diagnostics = createImportDiagnostics({ enabled: true });
  const replies = [
    {
      model: 'fictional-model',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                type: 'function',
                id: 'fictional-call',
                function: {
                  name: 'health_read',
                  arguments: JSON.stringify({ query: fictionalSecret }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    },
    {
      model: 'fictional-model',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Private fictional answer' },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    },
  ];
  const healthTool = {
    type: 'function',
    name: 'health_read',
    description: 'Read fictional scoped evidence',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  } satisfies HealthTool;
  const bridge = new ProxyModelBridge({
    config: proxyConfig({
      CRS_AI_MODEL: 'fictional-model',
      CRS_AI_BASE_URL: 'http://proxy.invalid',
      CRS_AI_API_KEY: 'fictional-credential',
    }),
    diagnostics,
    fetchImpl: async () =>
      new Response(JSON.stringify(replies.shift()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    onTool: async () => ({ result: fictionalSecret }),
  });
  await diagnostics.run(
    { profileId: 'fictional-profile', importId: 'fictional-import' },
    async () => {
      await bridge.start('Private fictional instructions', [healthTool]);
      await bridge.turn('Private fictional request');
      await bridge.completion;
    },
  );
  const events = diagnostics.snapshot('fictional-profile');
  assert.equal(events.filter((event) => event.event === 'model.request.started').length, 2);
  assert.equal(events.filter((event) => event.event === 'model.request.completed').length, 2);
  assert.equal(events.filter((event) => event.event === 'model.response.shape').length, 2);
  assert.deepEqual(
    events
      .filter((event) => event.event === 'model.tool.started')
      .map((event) => event.fields.toolName),
    ['health_read'],
  );
  assert.deepEqual(
    events
      .filter((event) => event.event === 'model.request.completed')
      .map((event) => event.fields.totalTokens),
    [15, 25],
  );
  assert.ok(events.every((event) => event.context.turnId));
  assert.ok(events.every((event) => event.context.importId === 'fictional-import'));
  assert.doesNotMatch(
    JSON.stringify(events),
    /patient narrative|Private fictional|fictional-credential|proxy\.invalid/,
  );
  diagnostics.close();
});

test('tool completion records host sub-timings and page shape but no page content', () => {
  const diagnostics = createImportDiagnostics({ enabled: true });
  diagnostics.run({ profileId: 'fictional', importId: 'intake-1' }, () => {
    diagnostics.record('model.tool.completed', {
      toolName: 'health_intake_read',
      toolIndex: 0,
      durationMs: 1200,
      page: 7,
      queueWaitMs: 30,
      verifyMs: 5,
      textMs: 40,
      renderMs: 700,
      encodeMs: 260,
      annotationMs: 12,
      renderPasses: 1,
      base64Ms: 55,
      textLayerCharacters: 1840,
      imageBytes: 921_600,
    });
  });

  const [event] = diagnostics.snapshot('fictional');
  assert.equal(event!.fields.page, 7);
  assert.equal(event!.fields.renderMs, 700);
  assert.equal(event!.fields.textLayerCharacters, 1840);
  // The sub-timings must account for the phases, not exceed the whole.
  const parts = ['queueWaitMs', 'verifyMs', 'textMs', 'renderMs', 'annotationMs'] as const;
  const summed = parts.reduce((total, key) => total + (event!.fields[key] as number), 0);
  assert.ok(summed <= (event!.fields.durationMs as number));
  // No health content of any kind.
  assert.doesNotMatch(JSON.stringify(event), /Iris Meadow|Rowan Alder|transcript|narrative/);
});

test('a repeated page read is distinguishable from a first read in diagnostics', () => {
  const diagnostics = createImportDiagnostics({ enabled: true });
  diagnostics.run({ profileId: 'fictional', importId: 'intake-1' }, () => {
    diagnostics.record('model.tool.completed', {
      toolName: 'health_intake_read',
      toolIndex: 0,
      durationMs: 900,
      page: 12,
      textLayerCharacters: 8,
      reReadCount: 0,
      firstRead: true,
    });
    diagnostics.record('model.tool.completed', {
      toolName: 'health_intake_read',
      toolIndex: 1,
      durationMs: 870,
      page: 12,
      textLayerCharacters: 8,
      reReadCount: 1,
      firstRead: false,
    });
  });

  const events = diagnostics.snapshot('fictional');
  assert.equal(events[0]!.fields.firstRead, true);
  assert.equal(events[1]!.fields.reReadCount, 1);
  // A near-empty text layer is what distinguishes a blank verso from a failed
  // extraction; it must survive into the export as a number.
  assert.equal(events[1]!.fields.textLayerCharacters, 8);
});

test('a real upload receipt emits bounded upload_receive phase events with no filename or content', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'health-diag-upload-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const diagnostics = createImportDiagnostics({ enabled: true });
  t.after(() => diagnostics.close());
  const original = Buffer.from('Fictional original bytes for Iris Meadow, fictional-chart.pdf');
  const req = uploadRequest([original], { 'content-length': String(original.length) });

  const published = await diagnostics.run({ profileId: 'fictional-upload' }, () =>
    receiveIntakeUpload(req, () => 'published', { tempRoot, diagnostics }),
  );

  assert.equal(published, 'published');
  const events = diagnostics.snapshot('fictional-upload');
  const started = events.find((event) => event.event === 'import.phase.started');
  const completed = events.find(
    (event) => event.event === 'import.phase.completed' && event.fields.phase === 'upload_receive',
  );
  assert.equal(started?.fields.phase, 'upload_receive');
  assert.equal(completed?.fields.phase, 'upload_receive');
  assert.equal(completed?.fields.receivedBytes, original.length);
  assert.equal(typeof completed?.fields.durationMs, 'number');
  assert.equal(typeof completed?.fields.publishMs, 'number');
  assert.doesNotMatch(JSON.stringify(events), /Iris Meadow|fictional-chart|\.pdf/);
});

test('real fictional receive and curation publication link retained import to original-publish sibling', async (t) => {
  const f = fixture(t);
  const diagnostics = createImportDiagnostics({ enabled: true });
  t.after(() => diagnostics.close());
  const bytes = Buffer.from('Independently fictional upload for diagnostics topology');
  const clientRequestId = '00000000-0000-4000-8000-000000000003';
  const retained = await diagnostics.run(
    { profileId: f.profileId, requestId: '00000000-0000-4000-8000-000000000004', clientRequestId },
    () =>
      receiveIntakeUpload(
        uploadRequest([bytes], { 'content-length': String(bytes.length) }),
        () =>
          intake.uploadIntake(f.db, f.root, f.profileId, {
            filename: 'fictional.txt',
            newProviderName: 'Fictional Clinic',
            mimeType: 'text/plain',
            bytes,
          }),
        { tempRoot: f.root, diagnostics },
      ),
  );
  const exported = diagnostics.exportSnapshot(f.profileId);
  const events = exported.events;
  const phase = (name: string) =>
    events.find((event) => event.event === 'import.phase.completed' && event.fields.phase === name);
  const receive = phase('upload_receive');
  const curation = phase('upload_curation_publish');
  const original = phase('upload_original_publish');
  const progress = events.find(
    (event) => event.event === 'import.progress' && event.fields.phase === 'upload_retained',
  );
  assert.ok(
    receive && curation && original && progress,
    JSON.stringify({
      receive: !!receive,
      curation: !!curation,
      original: !!original,
      progress: !!progress,
    }),
  );
  assert.equal(receive.context.clientRequestId, clientRequestId);
  assert.equal(curation.context.spanId, original.context.parentSpanId);
  assert.equal(curation.context.spanId, progress.context.parentSpanId);
  assert.equal(progress.context.importId === retained.id, false, 'source IDs are salted in export');
  assert.ok(progress.context.importId);
  assert.ok(
    [curation, original, progress].every(
      (event) => event.context.requestId === receive.context.requestId,
    ),
  );
  assert.ok(original.sequence < progress.sequence);
  assert.ok(progress.sequence < curation.sequence);
  assert.ok(curation.sequence < receive.sequence);
  assert.doesNotMatch(JSON.stringify(exported), /Independently fictional upload|fictional\.txt/);
});

test('upload_receive separates the publish half from the receive it is bundled with', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'health-diag-upload-publish-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const diagnostics = createImportDiagnostics({ enabled: true });
  t.after(() => diagnostics.close());
  const original = Buffer.from('Fictional original bytes for a fictional publish measurement');
  const req = uploadRequest([original], { 'content-length': String(original.length) });
  // Production's `publish` is `publishIntake`: a copy, a second full-file SHA-256 and a
  // database insert, all inside the same span as the receive. Standing in for it with a
  // deliberate, controlled delay is what makes the split observable — without a separate
  // `publishMs` there is no way to tell this cost apart from the transfer, and pairing
  // `durationMs` with `receivedBytes` reads as a byte rate that is badly wrong.
  const publishDelayMs = 60;
  const published = await diagnostics.run({ profileId: 'fictional-upload-publish' }, () =>
    receiveIntakeUpload(
      req,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, publishDelayMs));
        return 'published';
      },
      { tempRoot, diagnostics },
    ),
  );

  assert.equal(published, 'published');
  const completed = diagnostics
    .snapshot('fictional-upload-publish')
    .find(
      (event) =>
        event.event === 'import.phase.completed' && event.fields.phase === 'upload_receive',
    );
  const publishMs = completed?.fields.publishMs as number;
  const durationMs = completed?.fields.durationMs as number;
  assert.equal(typeof publishMs, 'number', 'the publish half is reported as its own number');
  assert.ok(
    publishMs >= publishDelayMs - 5,
    `publishMs ${publishMs} must cover the whole publish call, not a fraction of it`,
  );
  assert.ok(
    publishMs <= durationMs,
    `publishMs ${publishMs} is a part of durationMs ${durationMs}, not a separate span`,
  );
  // And the receive itself — the part a byte rate would legitimately apply to — is the
  // remainder, which for these few bytes is far smaller than the publish.
  assert.ok(
    durationMs - publishMs < publishMs,
    `the receive remainder ${durationMs - publishMs} is dwarfed by the publish ${publishMs}`,
  );
});

test('a failed upload receipt emits a bounded upload_receive phase.failed event with a reasonCode but no error text', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'health-diag-upload-fail-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const diagnostics = createImportDiagnostics({ enabled: true });
  t.after(() => diagnostics.close());
  // Declares more bytes than are actually sent, which fails with UPLOAD_LENGTH.
  const req = uploadRequest([Buffer.alloc(3)], { 'content-length': '4' });

  await assert.rejects(
    diagnostics.run({ profileId: 'fictional-upload-fail' }, () =>
      receiveIntakeUpload(req, () => assert.fail('must not publish'), { tempRoot, diagnostics }),
    ),
  );

  const events = diagnostics.snapshot('fictional-upload-fail');
  assert.equal(
    events.some(
      (event) =>
        event.event === 'import.phase.completed' && event.fields.phase === 'upload_receive',
    ),
    false,
  );
  const failed = events.find(
    (event) => event.event === 'import.phase.failed' && event.fields.phase === 'upload_receive',
  );
  assert.equal(failed?.fields.phase, 'upload_receive');
  assert.equal(failed?.fields.reasonCode, 'upload_length');
  assert.equal(typeof failed?.fields.durationMs, 'number');
  assert.doesNotMatch(
    JSON.stringify(events),
    /incomplete|no original was published|Invalid Content-Length/i,
  );
});

test('a staging directory that cannot be created still closes the upload_receive phase as failed', async (t) => {
  const diagnostics = createImportDiagnostics({ enabled: true });
  t.after(() => diagnostics.close());
  // Nothing beneath a nonexistent parent directory can be mkdtemp'd; this
  // reproduces ENOSPC/EACCES/ENOENT-style failures that happen after
  // import.phase.started is recorded but before the try block used to begin.
  const missingTempRoot = join(
    tmpdir(),
    'health-diag-upload-missing-parent-' + Math.random().toString(36).slice(2),
    'nested',
    'still-missing',
  );
  const req = uploadRequest([Buffer.from('irrelevant bytes')]);

  await assert.rejects(
    diagnostics.run({ profileId: 'fictional-upload-mkdtemp-fail' }, () =>
      receiveIntakeUpload(req, () => assert.fail('must not publish'), {
        tempRoot: missingTempRoot,
        diagnostics,
      }),
    ),
  );

  const events = diagnostics.snapshot('fictional-upload-mkdtemp-fail');
  assert.equal(
    events.some((event) => event.event === 'import.phase.started'),
    true,
    'the phase must have opened',
  );
  assert.equal(
    events.some(
      (event) =>
        event.event === 'import.phase.completed' && event.fields.phase === 'upload_receive',
    ),
    false,
  );
  const failed = events.find(
    (event) => event.event === 'import.phase.failed' && event.fields.phase === 'upload_receive',
  );
  assert.equal(
    failed?.fields.phase,
    'upload_receive',
    'a failure before the try block must still close the phase',
  );
  assert.equal(typeof failed?.fields.durationMs, 'number');
  assert.doesNotMatch(JSON.stringify(events), /missing-parent|nested|still-missing/);
});
