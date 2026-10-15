/** Exact selected activity headers; clinical extraction remains a separate accounting scope. */
import type { DatabaseSync } from 'node:sqlite';
import { getIntakeRead } from './intake.ts';
import { openIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import {
  collectionQueueSourcesAsync,
  type openCollectionReportQueue,
} from './intake-report-group-collection.ts';
import {
  readChatActivityHeader,
  iterateIntakeBatchActivityAsync,
  prepareJournalActivityBinding,
} from './journal-activity-index.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { HttpError } from './database.ts';

export interface CollectionQueueActivity {
  format: 'health-intake-report-activity-v2';
  binding: string;
  runningFiles: number;
  pausedFiles: number;
  queuedFiles: number;
  filesAwaitingConversion: number;
  remainingUnits: { state: 'exact'; value: number } | { state: 'pending'; value: null };
  extractionUnknownFiles: number;
  extractionComplete: boolean;
  allCurrentReportsReviewed: boolean;
  readingAccounting: { state: 'referenced'; scope: 'complete_reading_accounting'; binding: string };
}
export async function readCollectionQueueActivity(
  db: DatabaseSync,
  root: string,
  profileId: string,
  queue: Awaited<ReturnType<typeof openCollectionReportQueue>>,
): Promise<CollectionQueueActivity> {
  await queue.prepareCurrent();
  const initial = await prepareJournalActivityBinding(root, profileId, {
      assertRunning: queue.assertCurrent,
    }),
    binding = initial.binding,
    scratch = disposableSqlite('circus-queue-activity-');
  const assertCurrent = () => {
    queue.assertCurrent();
    initial.assertCurrent();
  };
  scratch.db.exec('CREATE TABLE intakes(id TEXT PRIMARY KEY,seen INTEGER NOT NULL)');
  let runningFiles = 0,
    pausedFiles = 0,
    queuedFiles = 0,
    filesAwaitingConversion = 0,
    remainingUnits = 0,
    countsExact = true,
    sourceCount = 0;
  try {
    for await (const source of collectionQueueSourcesAsync(db, root, profileId, assertCurrent)) {
      sourceCount++;
      const view = openIntakeCollectionEnvelope(db, source),
        intake = view.child(view.root(), 'intake')!,
        field = (name: string) => {
          const value = view.field(intake, name, { bytes: 16384 });
          if (value.kind === 'fragmented')
            throw new HttpError(
              409,
              'INTAKE_ACTIVITY_UNAVAILABLE',
              'Selected activity identity needs preparation',
            );
          return value.kind === 'value' ? value.value : undefined;
        },
        validation = view.child(intake, 'validation'),
        valid = validation && view.field(validation, 'valid', { bytes: 64 }),
        chatId = field('conversionChatId');
      if (
        !(valid?.kind === 'value' && valid.value) &&
        !view.childCount(intake, 'proposals') &&
        field('state') !== 'kept_original'
      )
        filesAwaitingConversion++;
      const summary = getIntakeRead(db, root, profileId, source.id);
      if (!('format' in summary)) throw Error('Native activity requires selected intake summaries');
      if (summary.review.state === 'exact')
        remainingUnits += summary.review.counts.pendingWorkCount;
      else countsExact = false;
      let running = false;
      if (typeof chatId === 'string' && chatId) {
        const chat = readChatActivityHeader(root, profileId, chatId);
        running =
          chat?.status === 'running' &&
          chat.context.intakeId === source.id &&
          chat.conversionCheckpoint.profileId === profileId &&
          chat.conversionCheckpoint.intakeId === source.id &&
          chat.conversionCheckpoint.sourceHash === source.sha256;
      }
      scratch.db.prepare('INSERT INTO intakes VALUES(?,?)').run(source.id, running ? 1 : 0);
      if (running) runningFiles++;
    }
    for await (const item of iterateIntakeBatchActivityAsync(root, profileId, assertCurrent)) {
      const source = scratch.db.prepare('SELECT seen FROM intakes WHERE id=?').get(item.intakeId);
      if (!source || source.seen) continue;
      scratch.db.prepare('UPDATE intakes SET seen=1 WHERE id=?').run(item.intakeId);
      if (
        item.batchStatus === 'running' &&
        (item.status === 'starting' || item.status === 'running')
      )
        runningFiles++;
      else if (item.batchStatus === 'running' && item.status === 'queued') queuedFiles++;
      else if (
        item.reason === 'stopped' ||
        item.status === 'paused' ||
        (item.status === 'review_ready' &&
          ((item.reading?.status === 'paused' && item.reading.reason !== 'reading_exhausted') ||
            item.reason === 'model_unavailable')) ||
        ((item.batchStatus === 'paused' || item.batchStatus === 'stopped') &&
          ['queued', 'starting', 'running'].includes(String(item.status)))
      )
        pausedFiles++;
    }
    const allCurrentReportsReviewed =
      queue.groups('active')[Symbol.iterator]().next().done === true &&
      queue.groups('deferred')[Symbol.iterator]().next().done === true;
    assertCurrent();
    const terminal = await prepareJournalActivityBinding(root, profileId, {
      assertRunning: assertCurrent,
    });
    terminal.assertCurrent();
    if (terminal.binding !== binding)
      throw new HttpError(
        409,
        'REPORT_QUEUE_CURSOR',
        'Reading activity changed; refresh this queue',
      );
    return {
      format: 'health-intake-report-activity-v2',
      binding,
      runningFiles,
      pausedFiles,
      queuedFiles,
      filesAwaitingConversion,
      remainingUnits: countsExact
        ? { state: 'exact', value: remainingUnits }
        : { state: 'pending', value: null },
      extractionUnknownFiles: sourceCount,
      extractionComplete: sourceCount === 0,
      allCurrentReportsReviewed,
      readingAccounting: {
        state: 'referenced',
        scope: 'complete_reading_accounting',
        binding: queue.binding + ':' + binding,
      },
    };
  } finally {
    scratch.close();
  }
}
