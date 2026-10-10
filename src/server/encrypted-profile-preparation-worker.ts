import { parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { createEncryptedProfiles } from './encrypted-profiles.ts';
import { createImportDiagnostics } from './import-diagnostics.ts';
import { HttpError } from './database.ts';
import { assertUnlockAuthority, unlockPathIdentity } from './encrypted-profile-preparation.ts';
import {
  captureUnlockPhysicalWitness,
  verifyUnlockPhysicalWitness,
} from './encrypted-unlock-physical.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from './record-version-work.ts';
import { intakeWorkCounters } from './intake-work-accounting.ts';

const key = Buffer.from(workerData.key);
workerData.key.fill(0);
const diagnostics = createImportDiagnostics({
  enabled: true,
  onEvent(event) {
    if (event.event === 'import.phase.started') parentPort!.postMessage({ progress: true });
  },
});
let state:
  ReturnType<ReturnType<typeof createEncryptedProfiles>['prepareUnlockWithKey']> | undefined;
function prepare(): void {
  try {
    const directory = resolve(workerData.dataDirectory, 'profiles', workerData.profileId);
    assertUnlockAuthority(directory, workerData.authority);
    const physicalWitness =
      workerData.physicalWitness ??
      captureUnlockPhysicalWitness(
        resolve(directory, 'vault'),
        resolve(workerData.witnessDirectory, 'physical.sqlite'),
      );
    if (workerData.physicalWitness)
      verifyUnlockPhysicalWitness(
        resolve(directory, 'vault'),
        resolve(workerData.witnessDirectory, 'physical.sqlite'),
        physicalWitness,
      );
    const manager = createEncryptedProfiles({
      dataDirectory: workerData.dataDirectory,
      runtimeDirectory: workerData.runtimeDirectory,
      availableRuntimeBytes: () => workerData.availableRuntimeBytes,
      diagnostics,
    });
    const records = createRecordVersionWorkCounters();
    state = withRecordVersionWork(records, () =>
      manager.prepareUnlockWithKey(workerData.profileId, key),
    );
    const intake = intakeWorkCounters(state.db);
    const selectedHead = state.recordStorage.read('head')!.toString('utf8');
    const storageBytes = manager.preparationStorageBytes(workerData.profileId);
    state.db.close();
    state.vault.close();
    state.disposeOriginalResolver();
    state.disposeBatchPublication();
    assertUnlockAuthority(directory, workerData.authority);
    parentPort!.postMessage({
      prepared: {
        metrics: state.metrics,
        storageBytes,
        rootIdentity: unlockPathIdentity(state.root, true),
        databaseIdentity: unlockPathIdentity(resolve(state.root, 'db/database.sqlite')),
        selectedHead,
        physicalWitness,
        work: { records, intake },
      },
    });
  } catch (error) {
    parentPort!.postMessage({
      failure:
        error instanceof HttpError
          ? { status: error.status, code: error.code, message: error.message }
          : {
              status: 500,
              code: 'PROFILE_PREPARATION_FAILED',
              message: 'The encrypted profile operation could not complete.',
            },
    });
  } finally {
    try {
      if (state) {
        if (state.db.isOpen) state.db.close();
        state.vault.close();
        state.disposeOriginalResolver();
        state.disposeBatchPublication();
      }
    } finally {
      key.fill(0);
      diagnostics.close();
      parentPort!.close();
    }
  }
}

// Complete the async module graph before allowing host cancellation to terminate
// this thread. Node's module-startup disposal must finish before worker shutdown.
setImmediate(() => {
  parentPort!.once('message', (message: { start?: true; cancel?: true }) => {
    if (message.start) prepare();
    else {
      key.fill(0);
      diagnostics.close();
      parentPort!.close();
    }
  });
  parentPort!.postMessage({ ready: true });
});
