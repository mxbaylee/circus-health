import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

for (const adapter of ['contributor', 'vault'])
  test(`${adapter} verification worker does not load recovery-only modules`, async () => {
    const absent = resolve(tmpdir(), 'fictional-absent-backing-' + randomUUID());
    const checkpointControl = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const entry = new URL(`../${adapter}-record-backing-worker.ts`, import.meta.url).href;
    const input = {
      mode: 'verify',
      directory: absent,
      physical: resolve(absent, 'physical.sqlite'),
      entries: 0,
      key: new Uint8Array(32),
      signatureKey: new Uint8Array(32),
      checkpointControl,
    };
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
        import(${JSON.stringify(entry)}).catch(error => parentPort.postMessage({ dependencyError: error.message }));
      `,
      {
        eval: true,
        workerData: adapter === 'contributor' ? null : input,
      },
    );
    try {
      const messages: unknown[] = [];
      let checkpoints = 0;
      let ready = false;
      await new Promise<void>((complete, reject) => {
        worker.on('message', (message) => {
          if (adapter === 'contributor' && (message as { ready?: unknown })?.ready === true) {
            if (ready || (message as { id?: unknown })?.id !== undefined)
              reject(Error('Contributor worker readiness changed'));
            else {
              ready = true;
              worker.postMessage({ id: 1, input });
            }
            return;
          }
          if ((message as { checkpoint?: unknown })?.checkpoint === true) {
            if (adapter === 'contributor' && (message as { id?: unknown })?.id !== 1) {
              reject(Error('Contributor worker checkpoint job changed'));
              return;
            }
            checkpoints++;
            const control = new Int32Array(checkpointControl);
            Atomics.store(control, 0, 0);
            Atomics.notify(control, 0);
          } else messages.push(message);
        });
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (code) reject(Error(`Verification worker exited with ${code}`));
          else complete();
        });
      });
      // An absent proof must still refuse; this isolates the import boundary.
      assert.deepEqual(messages, [
        adapter === 'contributor' ? { id: 1, refused: true } : { refused: true },
      ]);
      assert.equal(ready, adapter === 'contributor');
      assert.equal(checkpoints, adapter === 'contributor' ? 1 : 0);
    } finally {
      const control = new Int32Array(checkpointControl);
      Atomics.store(control, 0, 0);
      Atomics.notify(control, 0);
      await worker.terminate();
    }
  });
