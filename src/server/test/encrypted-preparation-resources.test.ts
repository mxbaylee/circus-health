import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { prepareEncryptedUnlock } from '../encrypted-profile-preparation.ts';

interface PreparedResource {
  handle: FileHandle;
}
function fixture(t: TestContext, mode: 'success' | 'wait' | 'failure' | 'unclean' | 'duplicate') {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'fictional-prepared-resource-'))),
    path = resolve(root, 'fictional-ciphertext');
  writeFileSync(path, 'Independently fictional encrypted preparation bytes', { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController(),
    received: PreparedResource[] = [],
    discarded: PreparedResource[] = [];
  let onMessage: (() => void) | undefined;
  let checkpoint: (() => void) | undefined;
  let cleanupFailure = false;
  const run = () =>
    prepareEncryptedUnlock<PreparedResource>(
      {
        dataDirectory: '/fictional',
        runtimeDirectory: '/fictional-runtime',
        profileId: 'fictional',
        key: Buffer.alloc(32, 0x24),
        authority: { directory: 'fictional', manifest: 'fictional', keyring: 'fictional' },
        signal: controller.signal,
        availableRuntimeBytes: null,
        checkpoint: () => checkpoint?.(),
        async discardPrepared(prepared) {
          await prepared.handle.close();
          discarded.push(prepared);
          if (cleanupFailure) throw Error('Fictional resource cleanup error');
        },
      },
      (workerData, transferList) => {
        assert.equal((workerData as { discardPrepared?: unknown }).discardPrepared, undefined);
        const worker = new Worker(
          `
        const { parentPort, workerData } = require('node:worker_threads');
        const { open } = require('node:fs/promises');
        workerData.key.fill(0);
        parentPort.once('message', async () => {
          const handle = await open(workerData.path, 'r');
          parentPort.postMessage({ prepared: { handle } }, [handle]);
          if (workerData.mode === 'duplicate') {
            const second = await open(workerData.path, 'r');
            parentPort.postMessage({ prepared: { handle: second } }, [second]);
          }
          if (workerData.mode === 'failure') throw Error('Fictional worker failure');
          if (workerData.mode === 'wait') { parentPort.on('message', () => {}); return; }
          if (workerData.mode === 'unclean') process.exitCode = 1;
          parentPort.close();
        });
        parentPort.postMessage({ ready: true });
      `,
          { eval: true, workerData: { ...(workerData as object), path, mode }, transferList },
        );
        worker.on('message', (message: { prepared?: PreparedResource }) => {
          if (message.prepared) {
            received.push(message.prepared);
            onMessage?.();
          }
        });
        t.after(() => worker.terminate());
        return worker;
      },
    );
  return {
    run,
    controller,
    received,
    discarded,
    onMessage: (callback: () => void) => {
      onMessage = callback;
    },
    checkpoint: (callback: () => void) => {
      checkpoint = callback;
    },
    failCleanup: () => {
      cleanupFailure = true;
    },
  };
}
async function assertClosed(handles: PreparedResource[], expected: number) {
  assert.equal(handles.length, expected);
  for (const { handle } of handles) {
    assert.equal(handle.fd, -1);
    await assert.rejects(handle.stat(), /closed|bad file descriptor/i);
  }
}

test('clean worker exit transfers the held resource to its caller', async (t) => {
  const f = fixture(t, 'success');
  const result = await f.run();
  try {
    assert.equal(result, f.received[0]);
    assert.equal(f.discarded.length, 0);
    assert.ok((await result.handle.stat()).isFile());
  } finally {
    await result.handle.close();
  }
  await assertClosed(f.received, 1);
});

test('prepared resource is closed when cancellation occurs before worker exit', async (t) => {
  const f = fixture(t, 'wait');
  f.onMessage(() =>
    queueMicrotask(() => f.controller.abort(Error('Fictional operator cancellation'))),
  );
  await assert.rejects(f.run(), /Fictional operator cancellation/);
  await assertClosed(f.received, 1);
  assert.equal(f.discarded.length, 1);
});

test('already-transferred resource is captured before a canceled message is refused', async (t) => {
  const f = fixture(t, 'success');
  f.onMessage(() => f.controller.abort(Error('Fictional canceled reply')));
  await assert.rejects(f.run(), /Fictional canceled reply/);
  await assertClosed(f.received, 1);
});

test('prepared resource followed by a worker error or unclean exit is closed', async (t) => {
  for (const mode of ['failure', 'unclean'] as const) {
    const f = fixture(t, mode);
    await assert.rejects(f.run(), /preparation failed/);
    await assertClosed(f.received, 1);
  }
});

test('duplicate prepared resources are both disposed before refusal returns', async (t) => {
  const f = fixture(t, 'duplicate');
  await assert.rejects(f.run(), /preparation failed/);
  await assertClosed(f.received, 2);
  assert.equal(f.discarded.length, 2);
});

test('a refusing checkpoint still disposes the already-transferred resource', async (t) => {
  const f = fixture(t, 'success');
  let checkpoints = 0;
  f.checkpoint(() => {
    if (++checkpoints === 2) throw Error('Fictional checkpoint refusal');
  });
  await assert.rejects(f.run(), /Fictional checkpoint refusal/);
  await assertClosed(f.received, 1);
});

test('all resource cleanup failures are awaited and reported together', async (t) => {
  const f = fixture(t, 'duplicate');
  f.failCleanup();
  await assert.rejects(
    f.run(),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
  );
  await assertClosed(f.received, 2);
  assert.equal(f.discarded.length, 2);
});
