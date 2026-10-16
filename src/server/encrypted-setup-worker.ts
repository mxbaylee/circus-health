import { parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { constants, mkdirSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type { createEncryptedProfiles } from './encrypted-profiles.ts';
import {
  captureUnlockPhysicalWitness,
  verifyUnlockPhysicalWitness,
  unlockPhysicalIdentity,
  unlockPhysicalDigest,
  unlockPhysicalFileDescriptorIdentity,
} from './encrypted-unlock-physical.ts';
import {
  stageSetupImmutableAdditions,
  finishSetupManifestWitness,
} from './encrypted-setup-publication.ts';

// Finish only closes the existing physical witness. Complete the application
// imports for other tasks before ready so startup cancellation still drains.
const task = workerData.setup.task,
  preparation = task === 'finish' ? undefined : await import('./encrypted-profile-preparation.ts'),
  database = task === 'finish' ? undefined : await import('./database.ts'),
  vaultStore = task === 'inspect' ? await import('./vault-store.ts') : undefined,
  profiles =
    task === 'finish' || task === 'inspect' ? undefined : await import('./encrypted-profiles.ts'),
  copyFiles = task === 'prepare' ? await import('./profile-copy-file-work.ts') : undefined;
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
async function run() {
  let manifestHandle: FileHandle | undefined;
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
      preparation!.assertUnlockAuthority(directory, workerData.authority);
      if (setup.task === 'inspect') {
        const physicalWitness = captureUnlockPhysicalWitness(root, witnessPath),
          vault = vaultStore!.openVault({ directory, profileId: workerData.profileId, key });
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
        // Reuse exclusive, no-follow, chunked copy I/O. Node's native recursive
        // cp fast path can fail on UID-mapped bind mounts before copying bytes.
        const checkCopy = () => preparation!.assertUnlockAuthority(directory, workerData.authority);
        await copyFiles!.copyProfileFileCooperative(
          resolve(directory, 'keyring.json'),
          resolve(candidateDirectory, 'keyring.json'),
          checkCopy,
        );
        await copyFiles!.copyProfileTreeCooperative(
          root,
          resolve(candidateDirectory, 'vault'),
          checkCopy,
        );
        verifyUnlockPhysicalWitness(root, witnessPath, setup.physicalWitness);
        if (setup.sourceId) {
          const sourceDirectory = resolve(workerData.dataDirectory, 'profiles', setup.sourceId);
          preparation!.assertUnlockAuthority(sourceDirectory, setup.sourceAuthority);
          const sourcePhysicalWitness = captureUnlockPhysicalWitness(
            resolve(sourceDirectory, 'vault'),
            resolve(workerData.witnessDirectory, 'source.sqlite'),
          );
          const sourceManager = profiles!.createEncryptedProfiles({
            dataDirectory: workerData.dataDirectory,
            runtimeDirectory: resolve(workerData.witnessDirectory, 'source-runtime'),
            availableRuntimeBytes: () => workerData.availableRuntimeBytes,
          });
          source = sourceManager.prepareUnlockWithKey(setup.sourceId, sourceKey!);
          if (source.recordStorage.read('head')?.toString('utf8') !== setup.sourceHead)
            throw Error('Copy source changed');
          setup.sourcePhysicalWitness = sourcePhysicalWitness;
        }
        const manager = profiles!.createEncryptedProfiles({
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
          manifestPath = resolve(candidate, 'manifest.enc');
        // Keep the exact owned file alive through transfer and publication.
        // UID-mapped filesystems may remap an unheld inode after replacement.
        manifestHandle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const manifestIdentity = unlockPhysicalFileDescriptorIdentity(manifestHandle.fd),
          manifestDigest = unlockPhysicalDigest(manifestPath);
        if (unlockPhysicalIdentity(manifestPath).value !== manifestIdentity)
          throw Error('Setup manifest changed');
        const physicalWitness = stageSetupImmutableAdditions(
          root,
          candidate,
          witnessPath,
          setup.physicalWitness,
        );
        preparation!.assertUnlockAuthority(directory, workerData.authority);
        if (setup.sourceId) {
          preparation!.assertUnlockAuthority(
            resolve(workerData.dataDirectory, 'profiles', setup.sourceId),
            setup.sourceAuthority,
          );
          verifyUnlockPhysicalWitness(
            resolve(workerData.dataDirectory, 'profiles', setup.sourceId, 'vault'),
            resolve(workerData.witnessDirectory, 'source.sqlite'),
            setup.sourcePhysicalWitness,
          );
        }
        if (
          unlockPhysicalFileDescriptorIdentity(manifestHandle.fd) !== manifestIdentity ||
          unlockPhysicalIdentity(manifestPath).value !== manifestIdentity ||
          unlockPhysicalDigest(manifestPath) !== manifestDigest
        )
          throw Error('Setup manifest changed');
        result = {
          physicalWitness,
          sourcePhysicalWitness: setup.sourcePhysicalWitness,
          manifestPath,
          manifestIdentity,
          manifestDigest,
          originalRootIdentity: unlockPhysicalIdentity(root).value,
          selectedHead,
          manifestHandle,
        };
      }
      preparation!.assertUnlockAuthority(directory, workerData.authority);
    }
    parentPort!.postMessage({ prepared: result }, manifestHandle ? [manifestHandle] : []);
    manifestHandle = undefined;
  } catch (error) {
    parentPort!.postMessage({
      failure:
        database && error instanceof database.HttpError
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
      try {
        await manifestHandle?.close();
      } finally {
        key.fill(0);
        sourceKey?.fill(0);
        parentPort!.close();
      }
    }
  }
}
setImmediate(() => {
  parentPort!.once('message', (message: { start?: true }) => {
    if (message.start) void run();
    else {
      key.fill(0);
      sourceKey?.fill(0);
      parentPort!.close();
    }
  });
  parentPort!.postMessage({ ready: true });
});
