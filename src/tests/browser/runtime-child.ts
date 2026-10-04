import { startRuntime } from '../../server/runtime.ts';
import type { AddressInfo } from 'node:net';
import type { ProcessRuntimeOptions } from './process-runtime.ts';

// A separate process is essential: in-process close/reopen cannot prove that
// reconciliation survives loss of all server memory. It also keeps synchronous
// encrypted storage work off the browser controller's event loop.
const { unavailableModelAlias, ...options } = JSON.parse(process.argv[2]!) as ProcessRuntimeOptions;
const unavailable = () => ({
  available: false,
  readiness: 'unavailable',
  ...(unavailableModelAlias
    ? {
        backend: 'litellm',
        model: unavailableModelAlias,
        capabilities: { tools: null, images: null },
      }
    : {}),
});
const runtime = await startRuntime({
  ...options,
  assistantOptions: {
    availability: unavailable,
    connectionCheck: async () => unavailable(),
    bridgeFactory: () => {
      throw new Error('No model calls in restart fixture');
    },
  },
});
process.on('message', async (message) => {
  if (message === 'close') {
    await runtime.close();
    process.disconnect();
  } else if (
    message &&
    typeof message === 'object' &&
    'type' in message &&
    message.type === 'capture-diagnostics' &&
    'id' in message &&
    typeof message.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(message.id)
  ) {
    // Parent receipt, rather than an IPC acknowledgment, proves that earlier
    // stderr bytes reached the controller. This test-only marker is stripped there.
    process.stderr.write('\u001ecrs-browser-diagnostics:' + message.id + '\u001f');
  }
});
process.send!({ port: (runtime.server.address() as AddressInfo).port, pid: process.pid });
