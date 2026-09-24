import { parentPort, workerData } from 'node:worker_threads';
import { rebuildStartup } from './startup-rebuild.ts';
try {
  const result = rebuildStartup({
    ...workerData,
    progress: (value) => parentPort!.postMessage({ progress: value }),
  });
  parentPort!.postMessage({ result });
} catch (error) {
  // Keep detailed failures in server logs; operational metrics remain payload-free.
  parentPort!.postMessage({ failure: (error as Error).message });
}
