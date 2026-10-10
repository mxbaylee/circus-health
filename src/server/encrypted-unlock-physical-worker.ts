import { parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { verifyUnlockPhysicalWitness } from './encrypted-unlock-physical.ts';

setImmediate(() => {
  parentPort!.once('message', (message: { start?: true }) => {
    try {
      if (!message.start) return;
      const checked = verifyUnlockPhysicalWitness(
        resolve(workerData.dataDirectory, 'profiles', workerData.profileId, 'vault'),
        resolve(workerData.witnessDirectory, workerData.witnessName ?? 'physical.sqlite'),
        workerData.physicalWitness,
      );
      parentPort!.postMessage({ prepared: { checked } });
    } catch {
      parentPort!.postMessage({
        failure: {
          status: 409,
          code: 'PROFILE_PREPARATION_CHANGED',
          message: 'Encrypted profile physical evidence changed; try unlocking again.',
        },
      });
    } finally {
      workerData.key.fill(0);
      parentPort!.close();
    }
  });
  parentPort!.postMessage({ ready: true });
});
