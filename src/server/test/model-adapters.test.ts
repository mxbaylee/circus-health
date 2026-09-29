import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelConfig, publicModelConfig } from '../model-config.ts';
import {
  configuredModelIdentity,
  createModelBridge,
  modelAvailability,
  testModelConnection,
  ensureModelConnection,
} from '../model-bridge.ts';
import { ProxyModelBridge } from '../proxy-model-bridge.ts';
import type { ProxyModelBridgeOptions } from '../proxy-model-bridge.ts';

type BridgeFactory = NonNullable<
  NonNullable<Parameters<typeof testModelConnection>[0]>['bridgeFactory']
>;
type BridgeCallbacks = ProxyModelBridgeOptions & { profileId?: string };
interface AvailabilityReceipt {
  available: boolean;
  readiness: string;
  capabilities: { tools: boolean | null; images: boolean | null };
  connectionTest: { testedAt: string };
}
const receipt = (value: Record<string, unknown>): AvailabilityReceipt =>
  value as unknown as AvailabilityReceipt;

const env = {
  CRS_AI_MODEL: 'fictional-alias',
  CRS_AI_BASE_URL: 'http://litellm:4000',
  CRS_AI_API_KEY: 'fictional-secret',
};
const config = (extra: NodeJS.ProcessEnv = {}) => modelConfig({ ...env, ...extra });
const roundTrip: BridgeFactory = (callbacks) => ({
  start: async () => ({ model: 'fictional-alias' }),
  turn: async (prompt: string) => {
    const match = /challenge ([a-f0-9-]+)/.exec(prompt);
    assert.ok(match);
    assert.ok(callbacks.onTool);
    assert.ok(callbacks.onEvent);
    const value = await callbacks.onTool({
      tool: 'health_connection_test',
      arguments: { challenge: match[1] },
      callId: 'fictional-connection-call',
    });
    const toolResult = value as { response?: string };
    callbacks.onEvent('item/completed', {
      item: { type: 'agentMessage', text: toolResult.response || 'Cannot read image' },
    });
    callbacks.onEvent('turn/completed', { turn: { status: 'completed' } });
  },
  close() {},
});

test('configuration defaults to LiteLLM and rejects every legacy backend', () => {
  assert.equal(config().backend, 'litellm');
  assert.ok(createModelBridge({ config: config() }) instanceof ProxyModelBridge);
  for (const backend of ['codex', 'anthropic', 'ollama', 'agent', 'other']) {
    assert.throws(() => config({ CRS_AI_BACKEND: backend }), /Only LiteLLM Proxy/);
    assert.throws(
      // @ts-expect-error Deliberately exercise runtime rejection of legacy backends.
      () => createModelBridge({ config: { ...config(), backend } }),
      /Only LiteLLM Proxy/,
    );
  }
});

test('credentials stay outside the archive and public configuration redacts them', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'health-model-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = join(dir, 'data');
  mkdirSync(data);
  const file = join(dir, 'key');
  writeFileSync(file, 'mounted-fictional-key\n');
  const c = config({ CRS_DATA_DIR: data, CRS_AI_API_KEY: '', CRS_AI_API_KEY_FILE: file });
  assert.equal(c.apiKey, 'mounted-fictional-key');
  assert.ok(!JSON.stringify(publicModelConfig(c)).includes('mounted-fictional-key'));
  const nested = join(data, 'key');
  writeFileSync(nested, 'fictional');
  assert.throws(
    () => config({ CRS_DATA_DIR: data, CRS_AI_API_KEY: '', CRS_AI_API_KEY_FILE: nested }),
    /outside/,
  );
  assert.throws(() => config({ CRS_AI_API_KEY_FILE: file }), /only one/);
});

test('advertised proxy capabilities do not establish readiness without a fictional round trip', async () => {
  const c = config();
  const initial = receipt(await modelAvailability({ config: c }));
  assert.equal(initial.available, false);
  assert.deepEqual(initial.capabilities, { tools: null, images: null, pdf: null });
  const tested = receipt(await testModelConnection({ config: c, bridgeFactory: roundTrip }));
  assert.equal(tested.available, true);
  assert.deepEqual(tested.capabilities, { tools: true, images: null, pdf: null });
  assert.equal((await modelAvailability({ config: c })).readiness, 'untested');
  for (const change of [
    { model: 'another' },
    { resolvedModel: 'upstream-v2' },
    { apiKey: 'rotated-fictional' },
    { images: true },
  ])
    assert.equal((await modelAvailability({ config: { ...c, ...change } })).available, false);
});

test('declared PDF input is exposed separately from fictional connection proof', async () => {
  const c = config({ CRS_AI_MODEL: 'fictional-pdf-declaration', CRS_AI_PROXY_PDF: 'true' });
  assert.deepEqual(publicModelConfig(c).declaredCapabilities, { pdf: true });
  const initial = await modelAvailability({ config: c });
  assert.equal(initial.available, false);
  assert.deepEqual(initial.declaredCapabilities, { pdf: true });
  const tested = await testModelConnection({ config: c, bridgeFactory: roundTrip });
  assert.deepEqual(tested.declaredCapabilities, { pdf: true });
  assert.deepEqual(tested.capabilities, { tools: true, images: null, pdf: null });
  assert.deepEqual(publicModelConfig(config()).declaredCapabilities, { pdf: false });
});

test('PDF declarations alone cannot establish native readiness', async () => {
  const c = config({
    CRS_AI_MODEL: 'fictional-pdf-only-preflight',
    CRS_AI_PROXY_PDF: 'true',
    CRS_AI_PROXY_IMAGES: 'false',
  });
  const factory: BridgeFactory = (callbacks) => ({
    ...roundTrip(callbacks),
    start: async () => ({ model: c.model, capabilities: { images: false, pdf: true } }),
  });
  await assert.rejects(
    ensureModelConnection({ config: c, pdf: true, bridgeFactory: factory }),
    /does not support images/,
  );
});

test('answers without the tool response revoke readiness; image configuration alone cannot prove vision', async () => {
  const c = config({ CRS_AI_MODEL: 'failure-fixture' });
  await testModelConnection({ config: c, bridgeFactory: roundTrip });
  await assert.rejects(
    testModelConnection({
      config: c,
      bridgeFactory: (callbacks) => ({
        start: async () => ({ model: c.model }),
        turn: async (text) => {
          callbacks.onEvent?.('item/completed', { item: { type: 'agentMessage', text } });
          callbacks.onEvent?.('turn/completed', { turn: { status: 'completed' } });
        },
        close() {},
      }),
    }),
    /did not demonstrate/,
  );
  assert.equal((await modelAvailability({ config: c })).available, false);
  const vision = config({ CRS_AI_MODEL: 'vision-fixture', CRS_AI_PROXY_IMAGES: 'true' });
  await assert.rejects(
    testModelConnection({ config: vision, image: true, bridgeFactory: roundTrip }),
    /image reading/,
  );
  assert.equal((await modelAvailability({ config: vision })).available, false);
});

test('automatic preflight shares fictional probes, reuses proof and rechecks changed configuration', async () => {
  let probes = 0;
  const c = config({ CRS_AI_MODEL: 'automatic-preflight' });
  const factory: BridgeFactory = (callbacks) => {
    probes++;
    return roundTrip(callbacks);
  };
  const [first, second] = await Promise.all([
    ensureModelConnection({ config: c, bridgeFactory: factory }),
    ensureModelConnection({ config: c, bridgeFactory: factory }),
  ]);
  assert.equal(probes, 1);
  assert.equal(receipt(first).connectionTest.testedAt, receipt(second).connectionTest.testedAt);
  await ensureModelConnection({ config: c, bridgeFactory: factory });
  assert.equal(probes, 1);
  await ensureModelConnection({
    config: { ...c, apiKey: 'rotated-fictional' },
    bridgeFactory: factory,
  });
  assert.equal(probes, 2);
  await assert.rejects(
    ensureModelConnection({ config: c, image: true, bridgeFactory: factory }),
    /image reading/,
  );
  assert.equal(probes, 3, 'text proof must not skip image verification');
});

test('connection proof and in-flight probes remain profile scoped', async () => {
  let probes = 0;
  const c = config({ CRS_AI_MODEL: 'profile-scoped-preflight' });
  const factory: BridgeFactory = (callbacks: BridgeCallbacks) => {
    probes++;
    const bridge = roundTrip(callbacks);
    bridge.start = async () => ({ model: `resolved-${callbacks.profileId}` });
    return bridge;
  };
  const [first, second] = await Promise.all([
    ensureModelConnection({ config: c, profileId: 'fictional-a', bridgeFactory: factory }),
    ensureModelConnection({ config: c, profileId: 'fictional-a', bridgeFactory: factory }),
  ]);
  assert.equal(probes, 1);
  assert.equal(receipt(first).connectionTest.testedAt, receipt(second).connectionTest.testedAt);
  assert.equal(configuredModelIdentity('fictional-a', c).model, 'resolved-fictional-a');
  assert.equal((await modelAvailability({ config: c, profileId: 'fictional-b' })).available, false);

  await ensureModelConnection({ config: c, profileId: 'fictional-b', bridgeFactory: factory });
  assert.equal(probes, 2);
  assert.equal(configuredModelIdentity('fictional-b', c).model, 'resolved-fictional-b');
  await ensureModelConnection({ config: c, profileId: 'fictional-a', bridgeFactory: factory });
  assert.equal(probes, 2, 'the same profile should reuse its verified text receipt');
  await assert.rejects(
    ensureModelConnection({
      config: c,
      profileId: 'fictional-a',
      image: true,
      bridgeFactory: factory,
    }),
    /image reading/,
  );
  assert.equal(probes, 3, 'profile-scoped text proof must not establish image support');
});

test('a failed automatic preflight is retryable and never establishes readiness', async () => {
  const c = config({ CRS_AI_MODEL: 'automatic-retry' });
  await assert.rejects(
    ensureModelConnection({
      config: c,
      bridgeFactory: () => ({
        start: async () => {
          throw Error('fictional outage');
        },
        turn: async () => {},
        close() {},
      }),
    }),
    /failed/,
  );
  assert.equal((await modelAvailability({ config: c })).available, false);
  assert.equal(
    receipt(await ensureModelConnection({ config: c, bridgeFactory: roundTrip })).available,
    true,
  );
});
