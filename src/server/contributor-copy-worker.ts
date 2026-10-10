import { parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { openDatabase } from './database.ts';
import { rebuildContributorDatabase } from './contributor-durability.ts';
import { validatePortableIntakeSourceTextRows } from './intake-source-text.ts';
import {
  captureUnlockPhysicalWitness,
  verifyUnlockPhysicalWitness,
} from './encrypted-unlock-physical.ts';
import { profilePaths } from './profile-storage.ts';
import { withRecordReplayCheckpoints } from './record-version-work.ts';

// Node must finish this module graph before host cancellation can terminate it.
setImmediate(() => {
  parentPort!.once('message', (message: { start?: true }) => {
    if (!message.start) {
      parentPort!.close();
      return;
    }
    try {
      const paths = profilePaths(workerData.root, workerData.profileId);
      const physical =
        workerData.physical ??
        ['records', 'sources', 'attachments'].map((kind) => ({
          root: paths[kind as 'records' | 'sources' | 'attachments'],
          path: resolve(workerData.directory, kind + '-physical.sqlite'),
          witness: captureUnlockPhysicalWitness(
            paths[kind as 'records' | 'sources' | 'attachments'],
            resolve(workerData.directory, kind + '-physical.sqlite'),
          ),
        }));
      for (const item of physical) verifyUnlockPhysicalWitness(item.root, item.path, item.witness);
      if (!workerData.physical) {
        let checkpoints = 0;
        withRecordReplayCheckpoints(
          () => {
            if (++checkpoints % 64 === 0) parentPort!.postMessage({ progress: true });
          },
          () => rebuildContributorDatabase(workerData.path, workerData.root, workerData.profileId),
        );
        const db = openDatabase(workerData.path, workerData.profileId);
        try {
          validatePortableIntakeSourceTextRows(
            {
              rows: (table) =>
                db.prepare('SELECT * FROM "' + table.replaceAll('"', '""') + '"').iterate(),
            },
            workerData.profileId,
          );
        } finally {
          db.close();
        }
      }
      for (const item of physical) verifyUnlockPhysicalWitness(item.root, item.path, item.witness);
      parentPort!.postMessage({ prepared: { physical } });
    } catch (error) {
      parentPort!.postMessage({
        failure: error instanceof Error ? error.message : 'Contributor copy certification failed',
      });
    } finally {
      parentPort!.close();
    }
  });
  parentPort!.postMessage({ ready: true });
});
