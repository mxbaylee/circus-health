import { startRuntime } from '../../server/runtime.ts';
import type { AddressInfo } from 'node:net';

// A separate process is essential: in-process close/reopen cannot prove that
// reconciliation survives loss of all server memory.
const options = JSON.parse(process.argv[2]!);
const unavailable = () => ({ available: false, readiness: 'unavailable' });
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
  }
});
process.send!({ port: (runtime.server.address() as AddressInfo).port, pid: process.pid });
