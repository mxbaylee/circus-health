import test from 'node:test';
import assert from 'node:assert/strict';
import { testModelConnection } from '../model-bridge.ts';

interface ConnectionReceipt {
  available: boolean;
  connectionTest: { fictional: boolean };
  capabilities: { tools: boolean; images: boolean | null };
}

// Explicit opt-in may incur provider usage. Only generated fictional content is
// sent. Supply one connection/model through the documented environment settings.
test(
  'selected real provider completes a fictional scoped tool round trip',
  { skip: process.env.CRS_AI_LIVE_TEST !== '1', timeout: 90000 },
  async () => {
    const receipt = (await testModelConnection({
      image: process.env.CRS_AI_LIVE_IMAGE_TEST === '1',
    })) as unknown as ConnectionReceipt;
    assert.equal(receipt.available, true);
    assert.equal(receipt.connectionTest.fictional, true);
    assert.equal(receipt.capabilities.tools, true);
    if (process.env.CRS_AI_LIVE_IMAGE_TEST === '1') assert.equal(receipt.capabilities.images, true);
  },
);
