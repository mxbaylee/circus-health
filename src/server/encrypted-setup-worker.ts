import { parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { cpSync, mkdirSync } from 'node:fs';
import { createEncryptedProfiles } from './encrypted-profiles.ts';
import { openVault } from './vault-store.ts';
import { HttpError } from './database.ts';
import { assertUnlockAuthority } from './encrypted-profile-preparation.ts';
import {
  captureUnlockPhysicalWitness,
  verifyUnlockPhysicalWitness,
  unlockPhysicalIdentity,
  unlockPhysicalDigest,
} from './encrypted-unlock-physical.ts';
import {
  stageSetupImmutableAdditions,
  finishSetupManifestWitness,
} from './encrypted-setup-publication.ts';

const key = Buffer.from(workerData.key);
workerData.key.fill(0);
const sourceKey = workerData.setup.sourceKey ? Buffer.from(workerData.setup.sourceKey) : undefined;
workerData.setup.sourceKey?.fill(0);
type State = ReturnType<ReturnType<typeof createEncryptedProfiles>['prepareUnlockWithKey']>;
let source: State | undefined, target: State | undefined;
function close(state: State | undefined) {
  if (!state) return;
  if (state.db.isOpen) state.db.close();
  state.disposeOriginalResolver();
  state.disposeBatchPublication();
  state.vault.close();
  state.key.fill(0);
}
function run() {
  try {
    const directory = resolve(workerData.dataDirectory, 'profiles', workerData.profileId),
      root = resolve(directory, 'vault'),
      witnessPath = resolve(workerData.witnessDirectory, 'physical.sqlite'),
      setup = workerData.setup;
    let result: unknown;
    if (setup.task === 'finish') {
      result = {
        physicalWitness: finishSetupManifestWitness(
          root,
          witnessPath,
          setup.physicalWitness,
          setup.manifestIdentity,
          setup.ownedRootIdentity,
        ),
      };
    } else {
      assertUnlockAuthority(directory, workerData.authority);
      if (setup.task === 'inspect') {
        const physicalWitness = captureUnlockPhysicalWitness(root, witnessPath),
          vault = openVault({ directory, profileId: workerData.profileId, key });
        try {
          const bytes = vault.readFile('setup.json');
          if (!bytes || bytes.length > 4096) throw Error('Invalid setup identity');
          result = {
            details: JSON.parse(bytes.toString('utf8')),
            published: vault.recordStorage().read('head') !== null,
            physicalWitness,
          };
        } finally {
          vault.close();
        }
        verifyUnlockPhysicalWitness(root, witnessPath, physicalWitness);
      } else {
        verifyUnlockPhysicalWitness(root, witnessPath, setup.physicalWitness);
        const candidateDirectory = resolve(setup.stageData, 'profiles', workerData.profileId);
        mkdirSync(resolve(setup.stageData, 'profiles'), { recursive: true, mode: 0o700 });
        mkdirSync(candidateDirectory, { mode: 0o700 });
        cpSync(resolve(directory, 'keyring.json'), resolve(candidateDirectory, 'keyring.json'), {
          errorOnExist: true,
          force: false,
        });
        cpSync(root, resolve(candidateDirectory, 'vault'), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        verifyUnlockPhysicalWitness(root, witnessPath, setup.physicalWitness);
        if (setup.sourceId) {
          const sourceDirectory = resolve(workerData.dataDirectory, 'profiles', setup.sourceId);
          assertUnlockAuthority(sourceDirectory, setup.sourceAuthority);
          const sourcePhysicalWitness = captureUnlockPhysicalWitness(
            resolve(sourceDirectory, 'vault'),
            resolve(workerData.witnessDirectory, 'source.sqlite'),
          );
          const sourceManager = createEncryptedProfiles({
            dataDirectory: workerData.dataDirectory,
            runtimeDirectory: resolve(workerData.witnessDirectory, 'source-runtime'),
            availableRuntimeBytes: () => workerData.availableRuntimeBytes,
          });
          source = sourceManager.prepareUnlockWithKey(setup.sourceId, sourceKey!);
          if (source.recordStorage.read('head')?.toString('utf8') !== setup.sourceHead)
            throw Error('Copy source changed');
          setup.sourcePhysicalWitness = sourcePhysicalWitness;
        }
        const manager = createEncryptedProfiles({
          dataDirectory: setup.stageData,
          runtimeDirectory: resolve(workerData.witnessDirectory, 'target-runtime'),
          availableRuntimeBytes: () => workerData.availableRuntimeBytes,
        });
        target = manager.prepareSetupWithKey(workerData.profileId, key, setup.details, source);
        const selectedHead = target.recordStorage.read('head')!.toString('utf8');
        close(target);
        target = undefined;
        close(source);
        source = undefined;
        const candidate = resolve(candidateDirectory, 'vault'),
          manifestPath = resolve(candidate, 'manifest.enc'),
          manifestIdentity = unlockPhysicalIdentity(manifestPath).value,
          manifestDigest = unlockPhysicalDigest(manifestPath);
        const physicalWitness = stageSetupImmutableAdditions(
          root,
          candidate,
          witnessPath,
          setup.physicalWitness,
        );
        assertUnlockAuthority(directory, workerData.authority);
        if (setup.sourceId) {
          assertUnlockAuthority(
            resolve(workerData.dataDirectory, 'profiles', setup.sourceId),
            setup.sourceAuthority,
          );
          verifyUnlockPhysicalWitness(
            resolve(workerData.dataDirectory, 'profiles', setup.sourceId, 'vault'),
            resolve(workerData.witnessDirectory, 'source.sqlite'),
            setup.sourcePhysicalWitness,
          );
        }
        result = {
          physicalWitness,
          sourcePhysicalWitness: setup.sourcePhysicalWitness,
          manifestPath,
          manifestIdentity,
          manifestDigest,
          originalRootIdentity: unlockPhysicalIdentity(root).value,
          selectedHead,
        };
      }
      assertUnlockAuthority(directory, workerData.authority);
    }
    parentPort!.postMessage({ prepared: result });
  } catch (error) {
    parentPort!.postMessage({
      failure:
        error instanceof HttpError
          ? { status: error.status, code: error.code, message: error.message }
          : {
              status: 409,
              code: 'SETUP_PREPARATION_CHANGED',
              message: 'Profile setup changed. Retry with the saved recovery key.',
            },
    });
  } finally {
    try {
      close(target);
      close(source);
    } finally {
      key.fill(0);
      sourceKey?.fill(0);
      parentPort!.close();
    }
  }
}
setImmediate(() => {
  parentPort!.once('message', (message: { start?: true }) => {
    if (message.start) run();
    else {
      key.fill(0);
      sourceKey?.fill(0);
      parentPort!.close();
    }
  });
  parentPort!.postMessage({ ready: true });
});
