import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestInputComposition } from '../request-input-composition.ts';
import { createImportDiagnostics } from '../import-diagnostics.ts';
import { createPrivateImportTrace } from '../import-private-trace.ts';
import { proxyConfig, proxyRequest } from '../proxy-model-bridge.ts';
import { freshKey } from '../vault-crypto.ts';
import { openDiagnosticChunkStore } from '../diagnostic-chunk-store.ts';

const canary = 'Fictional private é🦕';
const pdf = 'data:application/pdf;base64,JVBERi0x';
const image = 'data:image/png;base64,aW1hZ2U=';
const remote = 'https://fictional.invalid/private-é.png';
function fixture() {
  return {
    model: 'fictional-model',
    messages: [
      { role: 'system', content: canary },
      { role: 'developer', content: 'é' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '🦕' },
          { type: 'file', file: { file_data: pdf } },
          { type: 'image_url', image_url: { url: image } },
          { type: 'image_url', image_url: { url: remote } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { type: 'function', function: { name: 'private_name', arguments: '{"é":"🦕"}' } },
        ],
      },
      { role: 'tool', content: canary },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'private_name',
          description: canary,
          parameters: { type: 'object' },
        },
      },
    ],
  };
}

test('composition separates exact Unicode text, arguments, definitions and media transport', () => {
  const body = fixture();
  const original = JSON.stringify(body);
  const fields = requestInputComposition(body);
  const expected: Record<string, number | boolean | null> = {
    inputMessageCount: 5,
    inputArgumentCharacters: 10,
    inputArgumentBytes: 13,
    inputToolDefinitionCharacters: JSON.stringify(body.tools).length,
    inputToolDefinitionBytes: Buffer.byteLength(JSON.stringify(body.tools)),
    inputMediaTransportBytes: Buffer.byteLength(pdf + image + remote),
    inputUnsupportedShapes: 0,
    inputCompositionComplete: true,
  };
  for (const [role, value, messages] of [
    ['System', canary, 1],
    ['Developer', 'é', 1],
    ['User', '🦕', 1],
    ['Assistant', '', 1],
    ['Tool', canary, 1],
    ['Other', '', 0],
  ] as const) {
    expected[`input${role}Messages`] = messages;
    expected[`input${role}Characters`] = value.length;
    expected[`input${role}Bytes`] = Buffer.byteLength(value);
  }
  assert.deepEqual(fields, expected);
  assert.equal(Object.keys(fields).length, 26);
  assert.equal(JSON.stringify(body), original);
  assert.equal(JSON.stringify(fields).includes(canary), false);
});

test('unsupported shapes preserve measured subsets and explicitly flag incomplete composition', () => {
  const fields = requestInputComposition({
    messages: [
      null,
      { role: 'fictional-private-role', content: 'é' },
      {
        role: 'user',
        content: [
          { type: 'audio', data: canary },
          { type: 'text', text: 'x' },
        ],
      },
      { role: 'tool', content: { private: canary } },
      { role: 'assistant', content: null, tool_calls: [{ type: 'unknown' }] },
    ],
    tools: { private: canary },
  });
  assert.equal(fields.inputCompositionComplete, false);
  assert.equal(fields.inputUnsupportedShapes, 6);
  assert.equal(fields.inputMessageCount, 5);
  assert.equal(fields.inputOtherMessages, 2);
  assert.equal(fields.inputOtherCharacters, 1);
  assert.equal(fields.inputOtherBytes, 2);
  assert.equal(fields.inputUserCharacters, 1);
  assert.equal(JSON.stringify(fields).includes('private'), false);
  assert.equal(requestInputComposition(null).inputUnsupportedShapes, 1);
  assert.equal(requestInputComposition({ messages: 1 }).inputCompositionComplete, false);
});

test('measurement failures make counters unknown without throwing', () => {
  const fields = requestInputComposition({
    get messages() {
      throw Error(canary);
    },
  });
  assert.equal(fields.inputCompositionComplete, false);
  assert.ok(
    Object.entries(fields).every(
      ([key, value]) => key === 'inputCompositionComplete' || value === null,
    ),
  );
});

test('real request recorder preserves all counters and trace linkage in encrypted recovered export', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-composition-'));
  const key = freshKey();
  const profileId = 'fictional-profile';
  const open = () => openDiagnosticChunkStore({ directory, key, profileId });
  const traceId = randomUUID();
  const diagnostics = createImportDiagnostics({
    enabled: true,
    privateTrace: {
      ...createPrivateImportTrace(),
      capture: () => traceId,
    },
  });
  t.after(() => {
    diagnostics.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  });
  diagnostics.attachEventStore(profileId, open());
  const body = fixture();
  let transmitted = '';
  await proxyRequest(
    proxyConfig({
      CRS_AI_MODEL: 'fictional-model',
      CRS_AI_BASE_URL: 'http://proxy.invalid',
      CRS_AI_API_KEY: 'fictional-credential',
    }),
    body,
    {
      diagnostics,
      diagnosticContext: { profileId, importId: 'fictional-source', runId: randomUUID() },
      fetchImpl: async (_url, init) => {
        transmitted = String(init?.body);
        return new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        );
      },
    },
  );
  assert.equal(transmitted, JSON.stringify(body));
  const event = diagnostics
    .snapshot(profileId)
    .find((event) => event.event === 'model.request.started')!;
  assert.equal(event.fields.traceEventId, traceId);
  assert.ok(Object.keys(event.fields).length <= 48);
  for (const [name, value] of Object.entries(requestInputComposition(body)))
    assert.equal(event.fields[name], value, name);
  assert.equal(event.fields.requestBytes, Buffer.byteLength(transmitted));
  assert.equal(event.fields.pdfParts, 1);
  assert.equal(event.fields.imageParts, 2);
  diagnostics.close();
  const recovered = createImportDiagnostics();
  t.after(() => recovered.close());
  recovered.attachEventStore(profileId, open());
  const salt = Buffer.alloc(32, 1);
  const archive = await recovered.exportArchive(profileId, salt);
  const restored = archive.events.find(
    ({ event }) => event.event === 'model.request.started',
  )!.event;
  assert.deepEqual(restored.fields, event.fields);
  assert.equal(
    restored.context.providerRequestId,
    createHash('sha256')
      .update(salt)
      .update(event.context.providerRequestId!)
      .digest('hex')
      .slice(0, 20),
  );
  assert.equal(
    archive.events.find(({ event }) => event.event === 'model.request.completed')!.event.context
      .providerRequestId,
    restored.context.providerRequestId,
  );
  for (const secret of [canary, remote, 'private_name', 'fictional-credential', 'fictional-source'])
    assert.equal(JSON.stringify(archive).includes(secret), false, secret);
});

test('disabled ordinary diagnostics never inspect tool definitions for composition', async (t) => {
  const diagnostics = createImportDiagnostics();
  t.after(() => diagnostics.close());
  let toolsReads = 0;
  const body = {
    messages: [{ role: 'user', content: canary }],
    get tools() {
      toolsReads++;
      return [];
    },
  };
  await proxyRequest(
    proxyConfig({
      CRS_AI_MODEL: 'fictional-model',
      CRS_AI_BASE_URL: 'http://proxy.invalid',
      CRS_AI_API_KEY: 'fictional-key',
    }),
    body,
    {
      diagnostics,
      diagnosticContext: { profileId: 'fictional-profile' },
      fetchImpl: async (_url, init) => {
        assert.equal(JSON.parse(String(init?.body)).messages[0].content, canary);
        return new Response('{}');
      },
    },
  );
  assert.equal(toolsReads, 1, 'only transport serialization accesses definitions');
  assert.deepEqual(diagnostics.snapshot('fictional-profile'), []);
});
