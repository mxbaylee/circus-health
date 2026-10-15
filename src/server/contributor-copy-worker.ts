import { parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { openDatabase } from './database.ts';
import { rebuildContributorDatabase } from './contributor-durability.ts';
import { createIntakeCopyIncrementalReader } from './intake-copy-incremental-reader.ts';
import { captureIntakeCopyReadInterval } from './intake-copy-work.ts';
import { validatePortableIntakeSourceTextDatabase } from './intake-source-text.ts';
import {
  captureUnlockPhysicalWitness,
  verifyUnlockPhysicalWitness,
  type UnlockPhysicalWitness,
} from './encrypted-unlock-physical.ts';
import { profilePaths } from './profile-storage.ts';
import { withRecordReplayCheckpoints } from './record-version-work.ts';
import {
  acceptValidatedProductionIntakeInputs,
  productionIntakeAuthorityWork,
  validatedProductionIntakeInputs,
} from './intake-state-bootstrap.ts';

interface PhysicalItem {
  root: string;
  path: string;
  witness: UnlockPhysicalWitness;
}
const input = workerData as {
  root: string;
  profileId: string;
  directory: string;
  path: string;
  validatedIntakeInputs: string[];
};
// Digests the host thread of this process retained from its own complete
// validations; a rebuilt database reuses one only for byte-identical rows.
acceptValidatedProductionIntakeInputs(input.validatedIntakeInputs);
let physical: PhysicalItem[] | undefined;
let completed = 0;

function scan(id: number): void {
  for (const item of physical!) verifyUnlockPhysicalWitness(item.root, item.path, item.witness);
  parentPort!.postMessage({ id, scanComplete: true });
}

// Node must finish this module graph before host cancellation can terminate it.
setImmediate(() => {
  parentPort!.on(
    'message',
    async (message: { id?: number; kind?: 'prepare' | 'verify' | 'close' }) => {
      if (message.kind === 'close') {
        parentPort!.close();
        return;
      }
      const id = message.id;
      try {
        if (!Number.isSafeInteger(id) || id !== completed + 1)
          throw Error('Contributor copy worker protocol');
        if (message.kind === 'prepare') {
          if (physical) throw Error('Contributor copy worker protocol');
          const paths = profilePaths(input.root, input.profileId);
          physical = (['records', 'sources', 'attachments'] as const).map((kind) => ({
            root: paths[kind],
            path: resolve(input.directory, kind + '-physical.sqlite'),
            witness: captureUnlockPhysicalWitness(
              paths[kind],
              resolve(input.directory, kind + '-physical.sqlite'),
            ),
          }));
        } else if (message.kind !== 'verify' || !physical) {
          throw Error('Contributor copy worker protocol');
        }
        scan(id!);
        const validatedBefore = new Set(validatedProductionIntakeInputs()),
          workBefore = productionIntakeAuthorityWork();
        if (message.kind === 'prepare') {
          let checkpoints = 0;
          withRecordReplayCheckpoints(
            () => {
              if (++checkpoints % 64 === 0) parentPort!.postMessage({ id, progress: true });
            },
            () => rebuildContributorDatabase(input.path, input.root, input.profileId),
          );
          const db = openDatabase(input.path, input.profileId);
          try {
            const current = captureIntakeCopyReadInterval(db, input.profileId);
            // Only the private rebuilt database is consumed here. The original
            // complete physical witness is closed by scan() before certification.
            const reader = await createIntakeCopyIncrementalReader(db, () => {
              current();
              if (++checkpoints % 64 === 0) parentPort!.postMessage({ id, progress: true });
            });
            try {
              validatePortableIntakeSourceTextDatabase(reader, input.profileId, () =>
                parentPort!.postMessage({ id, progress: true }),
              );
              current();
            } finally {
              reader.close();
            }
          } finally {
            db.close();
          }
        }
        scan(id!);
        completed = id!;
        // Only digests of inputs this message completely validated, sent after
        // every check above passed. The host reuses one only for identical rows.
        const work = productionIntakeAuthorityWork();
        parentPort!.postMessage({
          id,
          prepared: {
            validatedIntakeInputs: validatedProductionIntakeInputs().filter(
              (digest) => !validatedBefore.has(digest),
            ),
            intakeValidations: work.validations - workBefore.validations,
          },
        });
      } catch (error) {
        parentPort!.postMessage({
          id,
          failure: error instanceof Error ? error.message : 'Contributor copy certification failed',
        });
        parentPort!.close();
      }
    },
  );
  parentPort!.postMessage({ ready: true });
});
