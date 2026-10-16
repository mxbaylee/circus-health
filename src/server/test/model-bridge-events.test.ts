import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelBridge } from '../model-bridge.ts';
import { modelConfig } from '../model-config.ts';

const config = modelConfig({
  CRS_AI_MODEL: 'fictional-model',
  CRS_AI_BASE_URL: 'http://127.0.0.1:4000',
  CRS_AI_API_KEY: 'fictional-test-key',
});

test('model bridge factory preserves asynchronous event acknowledgment barriers', async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const bridge = createModelBridge({
    config,
    onEvent(method) {
      calls.push(method);
      return barrier;
    },
  });
  const result = bridge.onEvent('model/toolResultsConsumed', { callIds: ['fictional-read'] });
  assert.equal(result, barrier);
  let acknowledged = false;
  const completion = Promise.resolve(result).then(() => {
    acknowledged = true;
  });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  release();
  await completion;
  assert.equal(acknowledged, true);
  assert.deepEqual(calls, ['model/toolResultsConsumed']);
});

test('model bridge factory preserves event refusal and synchronous return values', async () => {
  const refusal = Error('Fictional evidence acknowledgment refused');
  const refused = Promise.reject(refusal);
  void refused.catch(() => {});
  const bridge = createModelBridge({
    config,
    onEvent(method) {
      if (method === 'model/requestStarted') return refused;
      if (method === 'model/evidenceFallback') return 'fictional-synchronous-result';
      throw refusal;
    },
  });
  await assert.rejects(
    Promise.resolve(bridge.onEvent('model/requestStarted', {})),
    (error) => error === refusal,
  );
  assert.equal(
    bridge.onEvent('model/evidenceFallback', { reason: 'pdf_unsupported' }),
    'fictional-synchronous-result',
  );
  assert.throws(
    () => bridge.onEvent('fictional/event', {}),
    (error) => error === refusal,
  );
});
