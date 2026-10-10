import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

for (const adapter of ['contributor', 'vault'])
  test(`${adapter} verification worker does not load recovery-only modules`, async () => {
    const absent = resolve(tmpdir(), 'fictional-absent-backing-' + randomUUID());
    const worker = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads');
        const { registerHooks } = require('node:module');
        registerHooks({
          load(url, context, nextLoad) {
            if (['vault-store.ts', 'contributor-record-storage.ts', 'database.ts', 'record-versions.ts'].includes(url.split('/').at(-1)))
              throw Error('Verification loaded recovery module: ' + url);
            return nextLoad(url, context);
          },
        });
        import(workerData.entry).catch(error => parentPort.postMessage({ dependencyError: error.message }));
      `,
      {
        eval: true,
        workerData: {
          entry: new URL(`../${adapter}-record-backing-worker.ts`, import.meta.url).href,
          mode: 'verify',
          directory: absent,
          physical: resolve(absent, 'physical.sqlite'),
          entries: 0,
          key: new Uint8Array(32),
          signatureKey: new Uint8Array(32),
          checkpointControl: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
        },
      },
    );
    try {
      const messages: unknown[] = [];
      await new Promise<void>((complete, reject) => {
        worker.on('message', (message) => messages.push(message));
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (code) reject(Error(`Verification worker exited with ${code}`));
          else complete();
        });
      });
      // An absent proof must still refuse; this isolates the import boundary.
      assert.deepEqual(messages, [{ refused: true }]);
    } finally {
      await worker.terminate();
    }
  });
