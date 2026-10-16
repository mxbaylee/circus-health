import { parentPort, workerData } from 'node:worker_threads';
import { rebuildStartupBounded } from './startup-rebuild.ts';
setImmediate(() => {
  void rebuildStartupBounded({
    ...workerData,
    progress: (value) => parentPort!.postMessage({ progress: value }),
  })
    .then((result) => parentPort!.postMessage({ result }))
    .catch((error: unknown) => {
      // Keep detailed failures in server logs; operational metrics remain payload-free.
      parentPort!.postMessage({ failure: (error as Error).message });
    });
});
