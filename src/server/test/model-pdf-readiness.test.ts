import test from 'node:test';
import assert from 'node:assert/strict';
import { modelConfig } from '../model-config.ts';
import {
  createModelBridge,
  ensureModelConnection,
  modelAvailability,
  testModelConnection,
} from '../model-bridge.ts';
import type { ProxyConfig } from '../proxy-model-bridge.ts';

type Message = {
  role: string;
  content:
    | string
    | null
    | Array<{
        type: string;
        text?: string;
        file?: { file_data: string };
        image_url?: { url: string };
      }>;
};
const config = (name: string, extra: NodeJS.ProcessEnv = {}) =>
  modelConfig({
    HEALTH_AI_MODEL: name,
    HEALTH_AI_BASE_URL: 'http://fictional-proxy:4000',
    HEALTH_AI_API_KEY: 'fictional-key',
    ...extra,
  });

function upstream(
  c: ProxyConfig,
  { rejectPdf = false, rejectImage = false, wrongPdf = false, status = 400, images = false } = {},
) {
  const requests: { model: string; messages: Message[] }[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const messages: Message[] = body.messages;
    const result = messages.findLast((message) => message.role === 'tool');
    let reply;
    if (!result) {
      const prompt = messages.findLast((message) => message.role === 'user')?.content;
      assert.equal(typeof prompt, 'string');
      const challenge = /challenge ([a-f0-9-]+)/.exec(String(prompt))?.[1];
      assert.ok(challenge);
      reply = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'fictional-probe-tool',
            type: 'function',
            function: { name: 'health_connection_test', arguments: JSON.stringify({ challenge }) },
          },
        ],
      };
    } else {
      const parts = messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      );
      const pdf = parts.find((part) => part.type === 'file');
      if (pdf && rejectPdf)
        return new Response(
          JSON.stringify({
            error: {
              code: 'unsupported_pdf',
              message: 'This fictional route does not support PDF input.',
            },
          }),
          { status },
        );
      let answer: string;
      if (pdf) {
        const bytes = Buffer.from(pdf.file!.file_data.split(',')[1]!, 'base64');
        const code = /\((\d{4})\) Tj/.exec(bytes.toString())?.[1];
        assert.ok(code, 'the challenge must actually be inside the PDF');
        const textual = messages
          .map((message) =>
            typeof message.content === 'string'
              ? message.content
              : Array.isArray(message.content)
                ? message.content
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join(' ')
                : '',
          )
          .join(' ');
        assert.ok(!textual.includes(code), 'metadata and instructions must not leak the answer');
        answer = wrongPdf ? 'unable to read this file' : code;
      } else if (parts.some((part) => part.type === 'image_url')) {
        if (rejectImage)
          return new Response(
            JSON.stringify({
              error: {
                code: 'unsupported_image',
                message: 'Image input is not supported by this fictional model.',
              },
            }),
            { status },
          );
        answer = images ? '5500' : 'unable to read this image';
      } else answer = JSON.parse(String(result.content)).response;
      reply = { role: 'assistant', content: answer };
    }
    return new Response(
      JSON.stringify({
        model: c.model,
        choices: [
          { index: 0, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop', message: reply },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, requests };
}

test('automatic connection checks discover PDF support without a static declaration and reuse exact-route proof', async () => {
  const c = config('fictional-auto-native');
  assert.equal(c.pdf, false, 'metadata is not support proof');
  const f = upstream(c);
  const [first, concurrent] = await Promise.all([
    ensureModelConnection({ config: c, profileId: 'fictional-one', fetchImpl: f.fetchImpl }),
    ensureModelConnection({ config: c, profileId: 'fictional-one', fetchImpl: f.fetchImpl }),
  ]);
  assert.deepEqual(first.capabilities, { tools: true, images: null, pdf: true });
  assert.deepEqual(first.connectionTest, concurrent.connectionTest);
  assert.equal(f.requests.length, 2, 'one fictional tool/PDF round trip is shared');
  await ensureModelConnection({
    config: c,
    profileId: 'fictional-one',
    pdf: true,
    fetchImpl: f.fetchImpl,
  });
  assert.equal(f.requests.length, 2);
  const verified = createModelBridge({
    config: c,
    profileId: 'fictional-one',
    fetchImpl: f.fetchImpl,
  });
  assert.equal(verified.config.pdf, true);
  assert.equal(createModelBridge({ config: c, profileId: 'fictional-other' }).config.pdf, false);
  assert.equal(
    createModelBridge({ config: { ...c, apiKey: 'rotated-fictional' }, profileId: 'fictional-one' })
      .config.pdf,
    false,
  );
  verified.close();
});

test('declared support never bypasses a fictional PDF reading proof', async () => {
  const c = config('fictional-declared-unverified', { HEALTH_AI_PROXY_PDF: 'true' });
  assert.equal(createModelBridge({ config: c }).config.pdf, false);
  const f = upstream(c, { wrongPdf: true });
  await assert.rejects(
    ensureModelConnection({ config: c, pdf: true, fetchImpl: f.fetchImpl }),
    /does not support images|not configured for image/,
  );
  assert.equal(createModelBridge({ config: c }).config.pdf, false);
});

test('explicit PDF rejection verifies PNG fallback once and retains the negative PDF result', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const c = config('fictional-native-rejected', { HEALTH_AI_PROXY_IMAGES: 'true' });
  const f = upstream(c, { rejectPdf: true, images: true });
  const ready = await ensureModelConnection({ config: c, pdf: true, fetchImpl: f.fetchImpl });
  assert.deepEqual(ready.capabilities, { tools: true, images: true, pdf: false });
  assert.equal(f.requests.length, 4);
  const bridge = createModelBridge({ config: c });
  assert.equal(bridge.config.pdf, false);
  assert.equal(bridge.config.images, true);
  await ensureModelConnection({ config: c, pdf: true, fetchImpl: f.fetchImpl });
  assert.equal(f.requests.length, 4, 'later imports do not repeat a known unsupported PDF request');
  assert.ok(f.requests.every((request) => request.model === c.model));
  bridge.close();
});

test('authentication and transient failures do not become negative PDF capability proof', async () => {
  for (const status of [401, 429, 500]) {
    const c = config(`fictional-native-error-${status}`, { HEALTH_AI_PROXY_IMAGES: 'true' });
    const f = upstream(c, { rejectPdf: true, status });
    await assert.rejects(ensureModelConnection({ config: c, pdf: true, fetchImpl: f.fetchImpl }));
    assert.equal(f.requests.length, 2);
    assert.equal((await modelAvailability({ config: c })).available, false);
    assert.equal(createModelBridge({ config: c }).config.pdf, false);
  }
});

test('operator PDF opt-out uses only a verified image and sends no PDF probe', async (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const c = config('fictional-pdf-disabled', {
    HEALTH_AI_PROXY_PDF: 'false',
    HEALTH_AI_PROXY_IMAGES: 'true',
  });
  const f = upstream(c, { images: true });
  const ready = await ensureModelConnection({ config: c, pdf: true, fetchImpl: f.fetchImpl });
  assert.deepEqual(ready.capabilities, { tools: true, images: true, pdf: null });
  assert.equal(f.requests.length, 2);
  assert.ok(!JSON.stringify(f.requests).includes('application/pdf'));
});

test('runtime PDF rejection downgrades later turns for the same verified route only', async () => {
  const c = config('fictional-pdf-revoked');
  const f = upstream(c);
  await ensureModelConnection({ config: c, fetchImpl: f.fetchImpl });
  const bridge = createModelBridge({ config: c });
  assert.equal(bridge.config.pdf, true);
  bridge.onEvent('model/evidenceFallback', { format: 'png', reason: 'pdf_unsupported' });
  assert.equal(createModelBridge({ config: c }).config.pdf, false);
  bridge.close();
});

test('runtime PDF rejection downgrades a replacement receipt for the same route and profile', async () => {
  const c = config('fictional-pdf-replaced-receipt');
  const f = upstream(c);
  await ensureModelConnection({ config: c, profileId: 'fictional-one', fetchImpl: f.fetchImpl });
  await ensureModelConnection({ config: c, profileId: 'fictional-other', fetchImpl: f.fetchImpl });
  const bridge = createModelBridge({ config: c, profileId: 'fictional-one' });
  await testModelConnection({ config: c, profileId: 'fictional-one', fetchImpl: f.fetchImpl });
  bridge.onEvent('model/evidenceFallback', { format: 'png', reason: 'pdf_unsupported' });
  assert.equal(createModelBridge({ config: c, profileId: 'fictional-one' }).config.pdf, false);
  assert.equal(createModelBridge({ config: c, profileId: 'fictional-other' }).config.pdf, true);
  bridge.close();
});

test('a manual tools-only result leaves automatic evidence readiness pending', async () => {
  const c = config('fictional-partial-manual-result');
  const f = upstream(c);
  await testModelConnection({ config: c, fetchImpl: f.fetchImpl });
  const partial = await modelAvailability({ config: c });
  assert.equal(partial.available, false);
  assert.equal(partial.readiness, 'untested');
  assert.deepEqual(partial.capabilities, { tools: true, images: null, pdf: null });
  await ensureModelConnection({ config: c, fetchImpl: f.fetchImpl });
  assert.equal((await modelAvailability({ config: c })).readiness, 'tested');
  assert.equal(createModelBridge({ config: c }).config.pdf, true);

  const text = config('fictional-operator-text-only', { HEALTH_AI_PROXY_PDF: 'false' });
  await testModelConnection({ config: text, fetchImpl: upstream(text).fetchImpl });
  assert.equal((await modelAvailability({ config: text })).available, true);
  assert.equal((await modelAvailability({ config: text })).readiness, 'tested');
});

test('verified PDF reading remains ready when configured image reading proves unavailable', async () => {
  const c = config('fictional-pdf-without-image-reading', { HEALTH_AI_PROXY_IMAGES: 'true' });
  const f = upstream(c);
  const ready = await ensureModelConnection({ config: c, pdf: true, fetchImpl: f.fetchImpl });
  assert.deepEqual(ready.capabilities, { tools: true, images: false, pdf: true });
  assert.equal((await modelAvailability({ config: c })).available, true);
  const bridge = createModelBridge({ config: c });
  assert.equal(bridge.config.pdf, true);
  assert.equal(bridge.config.images, false);
  await assert.rejects(
    ensureModelConnection({ config: c, image: true, fetchImpl: f.fetchImpl }),
    /did not demonstrate fictional image/,
  );
  assert.equal((await modelAvailability({ config: c })).available, true);
  bridge.close();
});

for (const status of [400, 422])
  test(`explicit image input rejection ${status} settles inability without revoking native PDF`, async () => {
    const c = config(`fictional-pdf-image-http-rejection-${status}`, {
      HEALTH_AI_PROXY_IMAGES: 'true',
    });
    const f = upstream(c, { rejectImage: true, status });
    const ready = await ensureModelConnection({ config: c, pdf: true, fetchImpl: f.fetchImpl });
    assert.deepEqual(ready.capabilities, { tools: true, images: false, pdf: true });
    assert.equal((await modelAvailability({ config: c })).available, true);
    assert.equal(createModelBridge({ config: c }).config.pdf, true);
    await assert.rejects(
      ensureModelConnection({ config: c, image: true, fetchImpl: f.fetchImpl }),
      /did not demonstrate fictional image/,
    );
  });

test('image authentication, size, rate and server failures still revoke native PDF readiness', async () => {
  for (const status of [401, 403, 413, 429, 500, 503]) {
    const c = config(`fictional-pdf-image-error-${status}`, { HEALTH_AI_PROXY_IMAGES: 'true' });
    const f = upstream(c, { rejectImage: true, status });
    await assert.rejects(
      ensureModelConnection({
        config: c,
        pdf: true,
        fetchImpl: f.fetchImpl,
        retryDelay: async () => {},
      }),
    );
    assert.equal((await modelAvailability({ config: c })).available, false);
    assert.equal(createModelBridge({ config: c }).config.pdf, false);
  }
});

test('a timed-out PDF probe aborts its request and clears in-flight readiness for a retry', async () => {
  const c = config('fictional-pdf-timeout');
  let aborted = false;
  const stalled: typeof fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new Error('Fictional request aborted'));
        },
        { once: true },
      );
    });
  await assert.rejects(
    ensureModelConnection({ config: c, fetchImpl: stalled, timeoutMs: 10 }),
    /timed out/,
  );
  assert.equal(aborted, true);
  assert.equal((await modelAvailability({ config: c })).available, false);
  assert.equal(createModelBridge({ config: c }).config.pdf, false);
  const f = upstream(c);
  await ensureModelConnection({ config: c, fetchImpl: f.fetchImpl });
  assert.equal(f.requests.length, 2);
  assert.equal(createModelBridge({ config: c }).config.pdf, true);
});
