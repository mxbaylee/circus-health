import { randomUUID } from 'node:crypto';
import { createVaultApp } from '../../vault-app.ts';
import type { AddressInfo } from 'node:net';

const app = createVaultApp({
  dataDirectory: process.argv[2],
  runtimeDirectory: process.argv[3],
  assistantOptions: {
    availability: () => ({ available: true, readiness: 'ready' }),
    connectionCheck: async () => ({ available: true, readiness: 'ready' }),
    bridgeFactory(callbacks) {
      return {
        async start() {
          return { model: 'fictional-restart', backend: 'synthetic' };
        },
        async turn(prompt) {
          callbacks.beforeRequest?.();
          callbacks.onEvent?.('model/requestStarted', {
            requestId: randomUUID(),
            attempt: 1,
            model: 'fictional-restart',
            requestBytes: 1,
            requestDigest: 'f'.repeat(64),
          });
          process.send?.({ kind: 'dispatch', intakeId: prompt.match(/"intakeId":"([^"]+)"/)?.[1] });
        },
        async cancel() {},
        close() {},
      };
    },
  },
});
app.server.listen(0, '127.0.0.1', () =>
  process.send?.({ kind: 'ready', port: (app.server.address() as AddressInfo).port }),
);
