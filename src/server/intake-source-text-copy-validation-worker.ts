/** Validate only the immutable private copy-reader snapshot named by the host. */
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';
import { createIntakeCopyIncrementalReaderFromStandalone } from './intake-copy-incremental-reader.ts';
import { validatePortableIntakeSourceTextDatabase } from './intake-source-text.ts';

const input = workerData as { path: string; profileId: string };
// Finish module evaluation before the host can cancel and terminate this worker.
setImmediate(() => {
  let started = false;
  parentPort!.on('message', (message: { start?: true }) => {
    if (started || message.start !== true) {
      parentPort!.postMessage({ failure: {} });
      parentPort!.close();
      return;
    }
    started = true;
    let db: DatabaseSync | undefined;
    let result:
      { complete: true } | { failure: { status?: number; code?: string; message?: string } };
    try {
      parentPort!.postMessage({ progress: true });
      db = new DatabaseSync(input.path, { readOnly: true });
      const reader = createIntakeCopyIncrementalReaderFromStandalone(db, () => {});
      try {
        let steps = 0;
        validatePortableIntakeSourceTextDatabase(reader, input.profileId, () => {
          if (++steps % 16 === 0) parentPort!.postMessage({ progress: true });
        });
      } finally {
        reader.close();
      }
      result = { complete: true };
    } catch (error) {
      result = {
        failure:
          error instanceof HttpError && error.code === 'SOURCE_TEXT_INTEGRITY'
            ? { status: error.status, code: error.code, message: error.message }
            : {},
      };
    } finally {
      try {
        db?.close();
      } catch {
        result = { failure: {} };
      }
      parentPort!.postMessage(result!);
      parentPort!.close();
    }
  });
  parentPort!.postMessage({ ready: true });
});
