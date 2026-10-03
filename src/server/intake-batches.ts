import { randomUUID } from 'node:crypto';
import { modelRecoveryKey } from './model-bridge.ts';
import { INTAKE_PDF_BOUNDS } from './intake-files.ts';
import {
  importDiagnostics,
  beginImportPhase,
  measureImportPhase,
  type ImportDiagnosticSink,
} from './import-diagnostics.ts';
import { HttpError, required } from './database.ts';
import {
  getIntake,
  linkIntakeConversion,
  currentIntakeInterpretations,
  createIntakePlan,
  workflowMutation,
} from './intake.ts';
import { isRetainOnlyIntake } from './intake-source-policy.ts';
import { nextPendingReadingUnit } from './intake-unit-accounting.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import { runIntakeSourceExtractionOperation } from './intake-source-extraction-operation.ts';
import { getIntakeSourceText } from './intake-source-text.ts';
import {
  sourceTextExtractionPending,
  locateSourceExtractionProgress,
  extractIntakeSourceText,
  retainSourceStall,
  retrySourceExceptions,
} from './intake-source-extraction.ts';
import {
  listIntakeBatches,
  readIntakeBatch,
  writeIntakeBatch,
  trackIntakeBatch,
  cloneIntakeBatch,
  pendingIntakeBatchChanges,
  refreshIntakeBatch,
  forgetIntakeBatchJournal,
  clearIntakeBatchJournalCache,
  assertCurrentIntakeBatch,
} from './intake-batch-journal.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { Intake } from '../shared/intake.ts';
import { hasPausedIntakeReading } from '../shared/intake-batch.ts';
import {
  beginReadingSlice,
  canContinueReadingSlice,
  DEFAULT_INTAKE_READING_LIMITS,
  extendReadingBudget,
  finishReadingSlice,
  observeReadingProgress,
  readingBudgetReached,
  readingModelRequestBudgetReached,
  restoreReadingJobBaseline,
  type IntakeReadingLimits,
} from './intake-reading-budget.ts';
import type {
  CreateIntakeBatchInput,
  IntakeBatch,
  IntakeBatchItem,
  IntakeBatchItemStatus,
  IntakeBatchReadingState,
} from '../shared/intake-batch.ts';

interface AssistantChat {
  id: string;
  status: 'idle' | 'running' | 'failed' | 'cancelled' | string;
  context?: { intakeId?: string };
  reading?: IntakeBatchReadingState | null;
  error?: string | null;
}

interface BatchAssistant {
  ensureConnection?: (
    capability: { image: boolean; pdf: boolean },
    profileId: string,
  ) => Promise<unknown>;
  cancel(profileId: string, chatId: string): unknown;
  get(profileId: string, chatId: string): AssistantChat;
  isBusy(profileId: string): boolean;
  create(
    profileId: string,
    input: { title: string; context: { route: string; intakeId: string } },
  ): AssistantChat;
  send(
    profileId: string,
    chatId: string,
    input: { message: string; context: { route: string; intakeId: string } },
    options?: BatchAssistantRunOptions,
  ): AssistantChat;
  retry(profileId: string, chatId: string, options?: BatchAssistantRunOptions): AssistantChat;
  attachIntakeReadingRequestGuard(
    profileId: string,
    chatId: string,
    beforeModelRequest: NonNullable<BatchAssistantRunOptions['beforeModelRequest']>,
  ): boolean;
}

interface BatchAssistantRunOptions {
  beforeModelRequest?: (reading: IntakeBatchReadingState) => boolean;
  assertAuthorized?: (operation: 'dispatch' | 'publish') => void;
}

export const SOURCE_STALL_MS = Math.max(180_000, 2 * INTAKE_PDF_BOUNDS.indexTimeoutMs);
interface BatchManagerOptions {
  /** Deprecated fixture input; automatic capture has no cumulative allowance. */
  sourceCaptureLimits?: { steps: number; elapsedMs: number }; // Legacy test input, no longer a document allowance.
  sourceStallMs?: number;
  extract?: typeof extractIntakeSourceText;
  random?: () => number;
  authorized?: (profileId: string, intakeId: string, operation: 'dispatch' | 'publish') => boolean;
  diagnostics?: ImportDiagnosticSink;
  root: string;
  databases: Map<string, DatabaseSync>;
  assistant: BatchAssistant;
  journalWriter?: (root: string, profileId: string, batch: IntakeBatch, reason: string) => void;
  clock?: () => Date;
  pollMs?: number;
  continuationDelayMs?: number;
  readingLimits?: IntakeReadingLimits;
  /** Injectable for deterministic coordinator tests; production persists absolute deadlines. */
  providerRetryBaseMs?: number;
  providerPrerequisiteKey?: (profileId: string) => string;
}

export interface IntakeBatchManager {
  wake(profileId: string): void;
  create(profileId: string, input: Partial<CreateIntakeBatchInput> | null): IntakeBatch;
  list(profileId: string): IntakeBatch[];
  get(profileId: string, id: string): IntakeBatch;
  stop(profileId: string, batchId: string): IntakeBatch;
  resume(profileId: string, batchId: string): IntakeBatch;
  retryExceptions(profileId: string, batchId: string): IntakeBatch;
  close(reason?: string): void;
  isBusy(profileId: string): boolean;
}

const op = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 200 ||
    /[\x00-\x1f]/.test(value)
  )
    throw new HttpError(
      400,
      'INTAKE_BATCH_OPERATION',
      'Provide a stable operation ID of 1–200 characters',
    );
  return value.trim();
};

function modelFailure(error: unknown): boolean {
  const value =
    error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  return value.code === 'MODEL_UNAVAILABLE';
}

// Read back newly assigned containers: tracked assignments take ownership by
// copying input, so a caller must mutate the retained proxy, not its input array.
function itemExceptions(item: IntakeBatchItem) {
  item.exceptions ||= [];
  return item.exceptions;
}
function reopenOperations(batch: IntakeBatch) {
  batch.reopenOperations ||= [];
  return batch.reopenOperations;
}

function publicBatch(batch: IntakeBatch, scheduled?: boolean): IntakeBatch {
  return { ...cloneIntakeBatch(batch, 'dto'), ...(scheduled === undefined ? {} : { scheduled }) };
}

export function createIntakeBatchManager({
  root,
  databases,
  assistant,
  journalWriter = writeIntakeBatch,
  clock = () => new Date(),
  pollMs = 100,
  continuationDelayMs = 250,
  readingLimits = DEFAULT_INTAKE_READING_LIMITS,
  sourceStallMs = SOURCE_STALL_MS,
  extract = extractIntakeSourceText,
  random = Math.random,
  authorized = (profileId) => databases.has(profileId),
  providerRetryBaseMs = 5_000,
  providerPrerequisiteKey = modelRecoveryKey,
  diagnostics = importDiagnostics,
}: BatchManagerOptions): IntakeBatchManager {
  const batches = new Map<string, IntakeBatch>();
  const timers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; batchId: string; at: number }
  >();
  const pumping = new Set<string>();
  const pumpBatches = new Map<string, string>();
  const pendingWake = new Map<string, string>();
  const generations = new Map<string, number>();
  const retryItems = new Set<string>();
  const progressSavedAt = new Map<string, number>();
  const dirtyProgress = new Set<string>();
  const queueState = new WeakMap<
    IntakeBatch,
    { queued: Set<number>; status: IntakeBatch['status'] }
  >();
  // A local journal publication is not an encrypted-vault acknowledgement. Keep
  // this barrier until the entire injected writer succeeds, including its flush.
  const failedPublications = new Map<string, { batch: IntakeBatch; reason: string }>();
  const queueSpans = new Map<string, ReturnType<typeof beginImportPhase>>();
  let closed = false;
  let closeIncomplete = false;
  const key = (profileId: string, batchId: string): string => `${profileId}/${batchId}`;
  const now = (): string => clock().toISOString();
  const dbFor = (profileId: string): DatabaseSync =>
    required(databases.get(profileId), 'Profile not found');
  const generation = (profileId: string): number => generations.get(profileId) || 0;
  const modelRetryAt = (item: IntakeBatchItem): string => {
    const attempts = (item.modelRetryAttempts || 0) + 1;
    item.modelRetryAttempts = attempts;
    const base = Math.min(
      300_000,
      Math.max(1, providerRetryBaseMs) * 2 ** Math.min(attempts - 1, 6),
    );
    return new Date(
      clock().getTime() + Math.round(base * (0.5 + Math.max(0, Math.min(1, random())) / 2)),
    ).toISOString();
  };
  const live = (profileId: string, value: number): boolean =>
    !closed &&
    databases.has(profileId) &&
    !hasFailedPublication(profileId) &&
    generation(profileId) === value;

  const backgroundContext = (profileId: string, batch: IntakeBatch, item: IntakeBatchItem) => ({
    profileId,
    batchId: batch.id,
    importId: item.intakeId,
    operationId: undefined,
    requestId: undefined,
    clientRequestId: undefined,
    spanId: undefined,
    parentSpanId: undefined,
  });
  function finishQueue(
    profileId: string,
    batch: IntakeBatch,
    item: IntakeBatchItem,
    cancelled = false,
  ) {
    const id = key(profileId, `${batch.id}/${item.intakeId}`);
    const span = queueSpans.get(id);
    const queued = item.queuedAt ? Date.parse(item.queuedAt) : NaN;
    const fields = {
      queuedWallMs: Number.isFinite(queued) ? Math.max(0, clock().getTime() - queued) : null,
      queueWaitKnown: Number.isFinite(queued),
    };
    if (span) {
      if (cancelled) span.cancel(fields);
      else span.finish(fields);
      queueSpans.delete(id);
    }
    item.queuedAt = null;
  }
  function hasFailedPublication(profileId: string): boolean {
    return [...failedPublications.values()].some(
      (pending) => pending.batch.profileId === profileId,
    );
  }

  function retryPublication(profileId: string): void {
    for (const [id, pending] of failedPublications) {
      if (pending.batch.profileId !== profileId) continue;
      // Refresh again: a failed retry may itself have published before throwing.
      refreshIntakeBatch(root, profileId, pending.batch);
      journalWriter(root, profileId, pending.batch, pending.reason);
      failedPublications.delete(id);
      queueState.delete(pending.batch);
      if (!closed && pending.batch.status === 'running') schedule(profileId, pending.batch.id);
    }
  }

  function changedQueueItems(batch: IntakeBatch): { indexes: Set<number>; queued: Set<number> } {
    let state = queueState.get(batch);
    const indexes = new Set<number>();
    if (!state) {
      state = { queued: new Set(), status: batch.status };
      for (let index = 0; index < batch.items.length; index++) {
        indexes.add(index);
        if (batch.items[index]!.status === 'queued') state.queued.add(index);
      }
      queueState.set(batch, state);
    } else {
      for (const change of pendingIntakeBatchChanges(batch)) {
        if (!change.path.length || (change.path[0] === 'items' && change.path.length === 1)) {
          for (let index = 0; index < batch.items.length; index++) indexes.add(index);
        } else if (change.path[0] === 'items' && /^\d+$/.test(change.path[1] || '')) {
          indexes.add(Number(change.path[1]));
        }
      }
      if (state.status !== batch.status) for (const index of state.queued) indexes.add(index);
    }
    for (const index of indexes) {
      const item = batch.items[index];
      if (item?.status === 'queued') state.queued.add(index);
      else state.queued.delete(index);
      if (!item) continue;
      if (batch.status === 'running' && item.status === 'queued') item.queuedAt ||= now();
      else if (
        item.queuedAt ||
        queueSpans.has(key(batch.profileId, `${batch.id}/${item.intakeId}`))
      )
        finishQueue(batch.profileId, batch, item, batch.status !== 'running');
    }
    state.status = batch.status;
    return { indexes, queued: state.queued };
  }

  function observeQueues(
    profileId: string,
    batch: IntakeBatch,
    indexes: Set<number>,
    queued: Set<number>,
  ) {
    for (const index of indexes) {
      const item = batch.items[index];
      if (!item || batch.status !== 'running' || item.status !== 'queued') continue;
      const id = key(profileId, `${batch.id}/${item.intakeId}`);
      if (!queueSpans.has(id))
        queueSpans.set(
          id,
          beginImportPhase(
            item.reason === 'continuing' ? 'continuation_wait' : 'processing_queue',
            { queueDepth: queued.size, queueWaitKnown: !!item.queuedAt },
            backgroundContext(profileId, batch, item),
            diagnostics,
          ),
        );
    }
  }

  function publicationFailed(
    profileId: string,
    batch: IntakeBatch,
    reason: string,
    error: unknown,
  ): never {
    clear(profileId);
    if (error instanceof HttpError && error.code === 'INTAKE_BATCH_STALE')
      generations.set(profileId, generation(profileId) + 1);
    failedPublications.set(key(profileId, batch.id), { batch, reason });
    forgetIntakeBatchJournal(batch);
    queueState.delete(batch);
    try {
      refreshIntakeBatch(root, profileId, batch);
      batches.set(key(profileId, batch.id), batch);
    } catch (refreshError) {
      // A never-published creation has no authority to recover. Other recovery
      // failures retain the barrier so corrupt/unreadable authority fails closed.
      if (refreshError instanceof HttpError && refreshError.code === 'INTAKE_BATCH_NOT_FOUND') {
        failedPublications.delete(key(profileId, batch.id));
        batches.delete(key(profileId, batch.id));
      }
    }
    throw error;
  }

  function assertCurrent(profileId: string, batch: IntakeBatch): IntakeBatch {
    try {
      assertCurrentIntakeBatch(root, profileId, batch);
    } catch (error) {
      // Validation failures have no uncertain local publication to preserve.
      // Fence old continuations even if a later repair makes authority readable.
      if (!(error instanceof HttpError && error.code === 'INTAKE_BATCH_STALE'))
        generations.set(profileId, generation(profileId) + 1);
      publicationFailed(profileId, batch, 'head-reconciled', error);
    }
    return batch;
  }

  function assertProfileCurrent(profileId: string): void {
    for (const batch of batches.values())
      if (batch.profileId === profileId) assertCurrent(profileId, batch);
  }

  function save(profileId: string, batch: IntakeBatch, reason: string): void {
    batch.updatedAt = now();
    const { indexes, queued } = changedQueueItems(batch);
    try {
      journalWriter(root, profileId, batch, reason);
    } catch (error) {
      publicationFailed(profileId, batch, reason, error);
    }
    observeQueues(profileId, batch, indexes, queued);
    const item = batch.items[batch.currentIndex];
    diagnostics.record(
      'import.progress',
      {
        phase: 'batch',
        reasonCode: reason,
        outcome: batch.status,
        currentIndex: batch.currentIndex,
        files: batch.items.length,
        slices: item?.readingJob?.slices || 0,
        activeMs: item?.readingJob?.activeMs || 0,
        readyRecords: item?.reading?.readyRecords || 0,
      },
      {
        profileId,
        batchId: batch.id,
        importId: item?.intakeId,
        operationId: undefined,
        requestId: undefined,
        clientRequestId: undefined,
        spanId: undefined,
        parentSpanId: undefined,
      },
    );
    batches.set(key(profileId, batch.id), batch);
  }

  function loadProfile(profileId: string): void {
    const prefix = profileId + '/';
    if ([...batches.keys()].some((item) => item.startsWith(prefix))) return;
    for (const saved of listIntakeBatches(root, profileId)) {
      const batch = saved;
      const recoverable = new Set([
        'interrupted',
        'profile_locked',
        'waiting_for_provider',
        'provider_outcome_unknown',
        'provider_retry_limit',
        'assistant_busy',
        'job_limit',
        'time_limit',
        'context_limit',
        'continuing',
      ]);
      batch.automaticRun ??=
        batch.status === 'running' ||
        (batch.status !== 'stopped' && recoverable.has(batch.reason || ''));
      // Old Stop cleared automaticRun but only changed the cursor item's status.
      // Queued entries and an explicit stopped reason preserve automatic intent;
      // a human-review pause or a completed proposal must stay untouched.
      if (batch.status === 'stopped')
        for (const item of batch.items)
          if (
            item.resumeAutomaticRun === undefined &&
            (item.status === 'queued' || item.reason === 'stopped')
          ) {
            item.resumeAutomaticRun = true;
            item.automaticRun = false;
            item.status = 'paused';
            item.reason = 'stopped';
          }
      for (const item of batch.items) {
        restoreReadingJobBaseline(item);
        if (item.status === 'review_ready' && item.sourceExtraction)
          item.sourceExtraction.stepsAtModelPass ??= item.sourceExtraction.steps;
        item.automaticRun ??=
          batch.automaticRun &&
          (['queued', 'starting', 'running'].includes(item.status) ||
            recoverable.has(item.reason || '') ||
            recoverable.has(item.reading?.reason || ''));
        if (item.automaticRun) {
          finishReadingSlice(item, item.reading, batch.updatedAt);
          item.status = 'queued';
          if (!item.providerWait?.retryAt) item.reason = 'continuing';
          if (item.chatId) retryItems.add(key(profileId, batch.id + '/' + item.intakeId));
          if (item.readingJob && item.readingJob.limitPolicy !== 'progress-window') {
            item.readingJob.limitPolicy = 'progress-window';
            extendReadingBudget(item);
          }
        }
      }
      if (batch.automaticRun && batch.items.some((i) => i.automaticRun)) {
        batch.status = 'running';
        batch.reason = null;
        batch.currentIndex = Math.max(
          0,
          batch.items.findIndex((i) => i.automaticRun),
        );
        save(profileId, batch, 'automatic-recovery');
        schedule(profileId, batch.id);
      } else batches.set(key(profileId, batch.id), batch);
    }
  }

  function get(profileId: string, batchId: string): IntakeBatch {
    dbFor(profileId);
    retryPublication(profileId);
    loadProfile(profileId);
    const stored = batches.get(key(profileId, batchId));
    return stored ? assertCurrent(profileId, stored) : readIntakeBatch(root, profileId, batchId);
  }

  function clear(profileId: string, batchId: string | null = null): boolean {
    const scheduled = timers.get(profileId);
    if (!scheduled || (batchId && scheduled.batchId !== batchId)) return false;
    clearTimeout(scheduled.timer);
    timers.delete(profileId);
    return true;
  }

  function schedule(profileId: string, batchId: string, delay = 0): void {
    if (closed) return;
    const at = clock().getTime() + Math.max(0, delay);
    const previous = timers.get(profileId);
    if (previous && previous.at <= at && previous.at > clock().getTime()) return;
    if (previous) clear(profileId);
    const expected = generation(profileId);
    const timer = setTimeout(
      () => {
        timers.delete(profileId);
        if (!live(profileId, expected)) return;
        if (pumping.has(profileId)) {
          pendingWake.set(profileId, batchId);
          return;
        }
        pumping.add(profileId);
        void pump(profileId, batchId, expected)
          .catch((error: unknown) => {
            if (!live(profileId, expected)) return;
            const batch = batches.get(key(profileId, pumpBatches.get(profileId) || batchId));
            if (!batch || batch.status !== 'running') return;
            const current = batch.items[batch.currentIndex];
            if (
              error instanceof HttpError &&
              current &&
              [
                'SOURCE_EXTRACTION_BUSY',
                'SOURCE_TEXT_EXTRACTION_ACTIVE',
                'SOURCE_TEXT_CHANGED',
              ].includes(error.code)
            ) {
              const sourceText = getIntakeSourceText(
                dbFor(profileId),
                root,
                profileId,
                current.intakeId,
              );
              const progress = locateSourceExtractionProgress(sourceText);
              if (error.code === 'SOURCE_TEXT_CHANGED' && current.sourceExtraction) {
                current.sourceExtraction.operationId = null;
                current.sourceExtraction.expectedRevisionId = sourceText.revision?.id || null;
              }
              const unit = progress.page
                ? `source:${current.intakeId}:page:${progress.page}`
                : `source:${current.intakeId}`;
              const attempts =
                error.code === 'SOURCE_EXTRACTION_BUSY'
                  ? 0
                  : (current.sourceRetryUnit === unit ? current.sourceRetryAttempts || 0 : 0) + 1;
              current.sourceRetryUnit = unit;
              current.sourceRetryAttempts = attempts;
              if (attempts >= 3) {
                if (progress.page)
                  retainSourceStall(
                    dbFor(profileId),
                    root,
                    profileId,
                    current.intakeId,
                    progress.page,
                  );
                else
                  itemExceptions(current).push({
                    unitId: unit,
                    locator: 'Retained file (source inventory unavailable)',
                    reason: 'processing_stalled',
                  });
                current.sourceRetryAttempts = 0;
                current.status = progress.page ? 'queued' : 'review_ready';
                current.reason = 'processing_stalled';
                current.retryAt = null;
              } else {
                current.status = 'queued';
                current.reason =
                  error.code === 'SOURCE_EXTRACTION_BUSY'
                    ? 'waiting_for_local_capacity'
                    : 'retrying_extraction';
                current.retryAt = new Date(
                  clock().getTime() +
                    Math.min(
                      300_000,
                      Math.max(1, providerRetryBaseMs) * 2 ** Math.min(attempts, 6),
                    ),
                ).toISOString();
              }
              try {
                save(profileId, batch, 'source-extraction-capacity-wait');
                batch.currentIndex = (batch.currentIndex + 1) % batch.items.length;
                schedule(profileId, batch.id);
                return;
              } catch (journalError) {
                // Never dispatch again unless the waiting checkpoint is durable.
                // Fall through to the guarded pause path if its write failed.
                error = journalError;
              }
            }
            if (
              error instanceof HttpError &&
              current &&
              error.code.startsWith('SOURCE_TEXT_') &&
              error.code !== 'SOURCE_TEXT_DURABILITY'
            ) {
              const review = error.code === 'SOURCE_TEXT_REVIEW_CONFLICT';
              let locator = 'Retained original';
              try {
                const page = locateSourceExtractionProgress(
                  getIntakeSourceText(dbFor(profileId), root, profileId, current.intakeId),
                ).page;
                if (page) locator = `Page ${page}`;
              } catch {
                /* The exact page is unavailable; the original remains located. */
              }
              if (!review)
                itemExceptions(current).push({
                  unitId: `source:${current.intakeId}`,
                  locator,
                  reason: 'technical_error',
                  reasonCode: error.code,
                });
              current.status = 'paused';
              current.reason = review ? 'source_review_required' : 'source_technical_error';
              current.automaticRun = false;
              current.endedAt = now();
              try {
                save(
                  profileId,
                  batch,
                  review ? 'source-review-conflict' : 'source-technical-exception',
                );
                batch.currentIndex = (batch.currentIndex + 1) % batch.items.length;
                schedule(profileId, batch.id);
                return;
              } catch (journalError) {
                error = journalError;
              }
            }
            clear(profileId);
            generations.set(profileId, generation(profileId) + 1);
            const item = batch.items[batch.currentIndex];
            if (item?.chatId && ['starting', 'running'].includes(item.status))
              try {
                assistant.cancel(profileId, item.chatId);
              } catch {
                // Persist the paused generation even if the linked chat is already gone.
              }
            if (item && ['queued', 'starting', 'running'].includes(item.status)) {
              item.status = 'paused';
              item.reason =
                error instanceof HttpError && error.code === 'SOURCE_CHANGED'
                  ? 'source_changed'
                  : error instanceof HttpError && error.code === 'SOURCE_TEXT_REVIEW_CONFLICT'
                    ? 'source_review_required'
                    : error instanceof HttpError && error.code === 'SOURCE_TEXT_DURABILITY'
                      ? recordDurabilityStatus(dbFor(profileId))?.conflicted
                        ? 'durability_conflict'
                        : 'profile_locked'
                      : 'runner_error';
              item.endedAt = now();
            }
            batch.status = 'paused';
            batch.reason = modelFailure(error)
              ? 'model_unavailable'
              : item?.reason || 'runner_error';
            try {
              save(profileId, batch, 'runner-paused');
              rescheduleOtherBatches(profileId, batch.id);
            } catch {
              // The journal failure is already the authoritative reason work cannot continue.
            }
          })
          .finally(() => {
            pumping.delete(profileId);
            pumpBatches.delete(profileId);
            const pending = pendingWake.get(profileId);
            pendingWake.delete(profileId);
            if (pending && !closed && databases.has(profileId)) {
              const target = batches.get(key(profileId, pending));
              if (target?.automaticRun && target.status === 'running') schedule(profileId, pending);
            }
          });
      },
      Math.max(0, delay),
    );
    timer.unref?.();
    timers.set(profileId, { timer, batchId, at });
  }

  function finishItem(
    profileId: string,
    batch: IntakeBatch,
    item: IntakeBatchItem,
    status: IntakeBatchItemStatus,
    reason: string | null,
    intake: Intake | null,
    chat: AssistantChat | null,
  ): void {
    finishReadingSlice(item, chat?.reading || item.reading, now());
    item.automaticRun = false;
    if (recordDurabilityStatus(dbFor(profileId))) {
      const source = getIntakeSourceText(dbFor(profileId), root, profileId, item.intakeId);
      if (source.status === 'available')
        for (const issue of source.revision.issues.filter(
          (i) =>
            ['open', 'later'].includes(i.status) &&
            /-(failed|processing-stalled|ocr-unavailable)$/.test(i.id),
        )) {
          if (!(item.exceptions || []).some((e) => e.unitId === issue.id))
            itemExceptions(item).push({
              unitId: issue.id,
              locator: 'Page ' + issue.region.page,
              reason: 'processing_stalled',
            });
        }
    }
    item.status = status;
    item.reason = reason;
    item.endedAt = now();
    item.proposalIds = intake?.proposals?.map((proposal) => proposal.id) || item.proposalIds;
    item.reading = chat?.reading ? cloneIntakeBatch(chat.reading) : item.reading;
    batch.currentIndex = Math.min(batch.items.length, batch.currentIndex + 1);
    save(profileId, batch, `item-${status}`);
  }

  function prerequisiteRevision(profileId: string): string {
    try {
      return providerPrerequisiteKey(profileId);
    } catch {
      return 'unavailable';
    }
  }

  function retainProviderWait(
    profileId: string,
    batch: IntakeBatch,
    item: IntakeBatchItem,
    chat: AssistantChat,
  ): boolean {
    const wait = chat.reading?.providerWait;
    if (!wait) return false;
    const attempts =
      (item.providerWait?.attempts || 0) +
      (item.providerWait?.requestId === wait.requestId ? 0 : 1);
    const safeRetry =
      wait.outcome === 'unknown' ||
      ['quota', 'transient', 'context_limit'].includes(wait.classification);
    const minimumDelay = Math.min(
      300_000,
      Math.max(1, providerRetryBaseMs) * 2 ** Math.min(attempts - 1, 6),
    );
    const providerTime = wait.retryAt ? Date.parse(wait.retryAt) : 0;
    const retryAt = safeRetry
      ? new Date(
          Math.max(
            clock().getTime() +
              Math.round(minimumDelay * (0.5 + Math.max(0, Math.min(1, random())) / 2)),
            Number.isFinite(providerTime) ? providerTime : 0,
          ),
        ).toISOString()
      : null;
    item.providerWait = {
      ...wait,
      retryAt,
      attempts,
      lastWaitAt: now(),
      responsesAtWait: chat.reading?.usableModelResponses || 0,
    };
    item.reading = chat.reading ? cloneIntakeBatch(chat.reading) : item.reading;
    if (safeRetry) {
      item.status = 'queued';
      item.reason = 'waiting_for_provider';
      item.endedAt = null;
      retryItems.add(key(profileId, `${batch.id}/${item.intakeId}`));
      save(profileId, batch, 'provider-wait-recorded');
      batch.currentIndex = (batch.currentIndex + 1) % batch.items.length;
      schedule(profileId, batch.id);
    } else {
      item.status = 'paused';
      item.endedAt = now();
      item.reason =
        wait.outcome === 'unknown'
          ? 'provider_outcome_unknown'
          : wait.classification === 'authentication'
            ? 'provider_authentication'
            : 'provider_rejected';
      item.retryAt = new Date(clock().getTime() + 30000).toISOString();
      item.automaticRun = true;
      item.prerequisiteKey = prerequisiteRevision(profileId);
      save(profileId, batch, 'provider-intervention-required');
      batch.currentIndex = (batch.currentIndex + 1) % batch.items.length;
      schedule(profileId, batch.id);
    }
    return true;
  }

  function scheduleNextProfile(profileId: string): void {
    const time = clock().getTime();
    const candidates = [...batches.values()]
      .filter((batch) => batch.profileId === profileId && batch.status === 'running')
      .map((batch) => {
        const runnable = batch.items.filter(
          (item) =>
            item.automaticRun !== false &&
            (['queued', 'running', 'starting'].includes(item.status) ||
              (item.status === 'paused' && !!item.retryAt)),
        );
        const at = runnable.length
          ? Math.min(
              ...runnable.map((item) =>
                item.status === 'running'
                  ? time + pollMs
                  : Date.parse(item.retryAt || item.providerWait?.retryAt || '') || time,
              ),
            )
          : time;
        return { batch, at };
      })
      .sort((a, b) => a.at - b.at);
    const next = candidates[0];
    if (next)
      schedule(profileId, next.batch.id, Math.min(2_147_483_647, Math.max(0, next.at - time)));
  }

  function completeIfDone(profileId: string, batch: IntakeBatch): boolean {
    const eligible = batch.items
      .map((_, offset) => {
        const index = (batch.currentIndex + offset) % batch.items.length;
        return { item: batch.items[index], index };
      })
      .filter(
        ({ item }) =>
          item.automaticRun !== false &&
          (item.status === 'queued' || (item.status === 'paused' && !!item.retryAt)),
      );
    const next = eligible.find(
      ({ item }) =>
        Date.parse(item.retryAt || item.providerWait?.retryAt || '') <= clock().getTime() ||
        !(item.retryAt || item.providerWait?.retryAt),
    );
    if (next) {
      batch.currentIndex = next.index;
      next.item.status = 'queued';
      return false;
    }
    if (eligible.length) {
      scheduleNextProfile(profileId);
      return true;
    }
    const action = batch.items.some((i) => i.status === 'paused');
    batch.status = action ? 'paused' : 'complete';
    batch.reason = action
      ? 'needs_user_action'
      : batch.items.some((i) => i.exceptions?.length || i.reason === 'retain_only')
        ? 'exceptions'
        : null;
    batch.automaticRun = action && batch.items.some((i) => i.automaticRun);
    batch.currentIndex = batch.items.length;
    save(profileId, batch, action ? 'batch-needs-action' : 'batch-complete');
    scheduleNextProfile(profileId);
    return true;
  }

  async function ensureReady(
    profileId: string,
    batch: IntakeBatch,
    item: IntakeBatchItem,
    intake: Intake,
    expected: number,
  ): Promise<boolean> {
    try {
      await measureImportPhase(
        'model_preflight',
        () =>
          assistant.ensureConnection?.(
            {
              image: intake.mimeType.startsWith('image/'),
              pdf: intake.mimeType === 'application/pdf',
            },
            profileId,
          ),
        {},
        backgroundContext(profileId, batch, item),
        diagnostics,
      );
    } catch (error) {
      if (!live(profileId, expected)) return false;
      if (modelFailure(error)) {
        item.status = 'queued';
        item.reason = 'model_unavailable';
        item.retryAt = modelRetryAt(item);
        save(profileId, batch, 'model-unavailable');
        batch.currentIndex = (batch.currentIndex + 1) % batch.items.length;
        schedule(profileId, batch.id);
        return false;
      }
      throw error;
    }
    return live(profileId, expected) && batch.status === 'running';
  }

  function startMessage(intake: Intake): string {
    return `Convert the selected delivery ${intake.filename} (${intake.id}) from ${intake.provider} into a reviewable health-record-v1 proposal. Read all its pages or members using host tools, including selected-page PDFs or rendered page images and extracted embedded files where present. Use the original page references in metadata; each supplied PDF contains only its selected original page. Preserve originals, exact values, subject identity, locators and uncertainty. Propose separate clinical mappings for observed labs, medications, procedures and documents. Do not accept/import. Report any unreviewed pages/assets as coverage gaps.`;
  }

  async function captureSourceStep(
    profileId: string,
    batch: IntakeBatch,
    item: IntakeBatchItem,
    expected: number,
  ): Promise<'complete' | 'pending' | 'blocked'> {
    const db = dbFor(profileId);
    if (!recordDurabilityStatus(db)) return 'complete';
    const before = getIntakeSourceText(db, root, profileId, item.intakeId);
    if (!sourceTextExtractionPending(before)) return 'complete';
    item.sourceExtraction ||= {
      steps: 0,
      spentMs: 0,
      allowanceId: randomUUID(),
      stepsAtAllowance: 0,
      spentMsAtAllowance: 0,
      operationId: null,
      expectedRevisionId: null,
      startedAt: null,
      initialDone: false,
      draining: false,
    };
    const state = item.sourceExtraction;
    item.reason = 'extracting_source_text';
    item.startedAt ||= now();
    if (!state.operationId) {
      state.operationId = randomUUID();
      state.expectedRevisionId = before.revision?.id || null;
      state.startedAt = now();
      state.steps++;
    }
    save(profileId, batch, 'source-extraction-started');
    const checkpoint = locateSourceExtractionProgress(before);
    let expired = false;
    let expire!: (error: Error) => void;
    const deadline = new Promise<never>((_, reject) => {
      expire = reject;
    });
    const watchdog = setTimeout(() => {
      expired = true;
      expire(Error('SOURCE_EXTRACTION_STALLED'));
    }, sourceStallMs);
    let result: Awaited<ReturnType<typeof runIntakeSourceExtractionOperation>>;
    try {
      result = await runIntakeSourceExtractionOperation({
        db,
        root,
        profileId,
        id: item.intakeId,
        operationId: state.operationId,
        expectedRevisionId: state.expectedRevisionId,
        extract: (context) =>
          Promise.race([
            extract({
              ...context,
              maxPages: 1,
              assertRunning: () => {
                context.assertRunning?.();
                if (expired) throw Error('SOURCE_EXTRACTION_STALLED');
              },
            }),
            deadline,
          ]),
        assertRunning: () => {
          if (
            !live(profileId, expected) ||
            batch.status !== 'running' ||
            !authorized(profileId, item.intakeId, 'publish')
          )
            throw Error('SOURCE_EXTRACTION_CANCELLED');
        },
      });
    } finally {
      clearTimeout(watchdog);
    }
    if (!live(profileId, expected) || batch.status !== 'running') return 'blocked';
    state.spentMs += Math.max(0, clock().getTime() - Date.parse(state.startedAt || now()));
    state.operationId = null;
    state.startedAt = null;
    state.initialDone = false;
    const after = getIntakeSourceText(db, root, profileId, item.intakeId);
    item.reason = null;
    save(profileId, batch, 'source-extraction-accounted');
    const next = locateSourceExtractionProgress(after);
    if (result.operation.reasonCode === 'SOURCE_TEXT_REVIEW_CONFLICT') {
      item.reason = 'source_review_required';
      save(profileId, batch, 'source-review-conflict');
      return 'blocked';
    }
    if (
      ['SOURCE_TEXT_CHANGED', 'SOURCE_TEXT_EXTRACTION_ACTIVE'].includes(
        result.operation.reasonCode || '',
      )
    ) {
      const unit = next.page
        ? `source:${item.intakeId}:page:${next.page}`
        : `source:${item.intakeId}`;
      item.sourceRetryAttempts =
        item.sourceRetryUnit === unit ? (item.sourceRetryAttempts || 0) + 1 : 1;
      item.sourceRetryUnit = unit;
      if (item.sourceRetryAttempts >= 3) {
        if (next.page) retainSourceStall(db, root, profileId, item.intakeId, next.page);
        else {
          itemExceptions(item).push({
            unitId: unit,
            locator: 'Retained file (source inventory unavailable)',
            reason: 'processing_stalled',
          });
          item.reason = 'processing_stalled';
          save(profileId, batch, 'source-inventory-stalled');
          return 'blocked';
        }
        item.sourceRetryAttempts = 0;
      }
      state.operationId = null;
      state.expectedRevisionId = after.revision?.id || null;
      item.reason = 'retrying_extraction';
      item.retryAt = new Date(
        clock().getTime() +
          Math.min(
            300_000,
            Math.max(1, providerRetryBaseMs) * 2 ** Math.min(item.sourceRetryAttempts, 6),
          ),
      ).toISOString();
      save(profileId, batch, 'source-revision-backoff');
      return 'pending';
    }
    if (
      [
        'SOURCE_OCR_PREREQUISITE',
        'SOURCE_EXTRACTION_BUSY',
        'SOURCE_TEXT_EXTRACTION_ACTIVE',
      ].includes(result.operation.reasonCode || '')
    ) {
      const prerequisite = result.operation.reasonCode === 'SOURCE_OCR_PREREQUISITE';
      item.reason = prerequisite ? 'source_prerequisite' : 'waiting_for_local_capacity';
      item.retryAt = new Date(clock().getTime() + (prerequisite ? 30000 : 1000)).toISOString();
      save(profileId, batch, 'source-prerequisite');
      return 'pending';
    }
    if (after.status === 'unavailable') {
      state.stalls = (state.stalls || 0) + 1;
      if (state.stalls >= 3) {
        itemExceptions(item).push({
          unitId: 'source:' + item.intakeId,
          locator: 'Retained file (page inventory unavailable)',
          reason: 'processing_stalled',
        });
        return 'blocked';
      }
      item.reason = 'retrying_extraction';
      item.retryAt = new Date(clock().getTime() + providerRetryBaseMs).toISOString();
      save(profileId, batch, 'source-inventory-retry');
      return 'pending';
    }
    if (next.done > checkpoint.done) {
      state.progress = next.done;
      state.lastProgressAt = now();
      state.stalls = 0;
      item.sourceRetryAttempts = 0;
      delete item.sourceRetryUnit;
    } else if (result.operation.status === 'interrupted' || next.page === checkpoint.page) {
      state.stalls = state.unitPage === next.page ? (state.stalls || 0) + 1 : 1;
      state.unitPage = next.page;
      if (state.stalls >= 3 && next.page) {
        retainSourceStall(db, root, profileId, item.intakeId, next.page);
        state.stalls = 0;
      } else {
        item.reason = 'retrying_extraction';
        item.retryAt = new Date(clock().getTime() + providerRetryBaseMs).toISOString();
      }
    }
    save(profileId, batch, 'source-checkpoint');
    state.initialDone = !sourceTextExtractionPending(
      getIntakeSourceText(db, root, profileId, item.intakeId),
    );
    return state.initialDone ? 'complete' : 'pending';
  }

  async function drainRecordlessSource(
    profileId: string,
    batch: IntakeBatch,
    item: IntakeBatchItem,
    expected: number,
    chat: AssistantChat | null,
  ): Promise<void> {
    if (item.sourceExtraction) item.sourceExtraction.draining = true;
    const outcome = await captureSourceStep(profileId, batch, item, expected);
    if (!live(profileId, expected) || batch.status !== 'running') return;
    if (item.sourceExtraction) item.sourceExtraction.draining = outcome !== 'complete';
    if (outcome === 'pending') {
      item.status = 'queued';
      save(profileId, batch, 'source-extraction-progress');
    } else
      finishItem(
        profileId,
        batch,
        item,
        outcome === 'complete' ? 'review_ready' : 'paused',
        outcome === 'blocked'
          ? item.reason || 'source_review_required'
          : chat?.reading?.reason || 'no_proposal',
        getIntake(dbFor(profileId), root, profileId, item.intakeId),
        chat,
      );
    schedule(profileId, batch.id);
  }

  async function beginItem(
    profileId: string,
    batch: IntakeBatch,
    item: IntakeBatchItem,
    expected: number,
  ): Promise<void> {
    finishQueue(profileId, batch, item);
    const db = dbFor(profileId);
    let intake: Intake;
    try {
      intake = getIntake(db, root, profileId, item.intakeId);
      if (intake.sha256 !== item.sourceHash)
        throw new HttpError(409, 'SOURCE_CHANGED', 'The pinned original changed');
    } catch (error) {
      if (!live(profileId, expected)) return;
      finishItem(profileId, batch, item, 'paused', 'source_error', null, null);
      schedule(profileId, batch.id);
      return;
    }

    let linkedChat: AssistantChat | null = null;
    if (intake.conversionChatId) {
      try {
        linkedChat = assistant.get(profileId, intake.conversionChatId);
      } catch (error: unknown) {
        if (!(error instanceof HttpError) || error.code !== 'CHAT_NOT_FOUND') throw error;
      }
    }
    if (linkedChat && linkedChat.context?.intakeId !== intake.id) {
      finishItem(profileId, batch, item, 'paused', 'conversion_scope_mismatch', intake, null);
      schedule(profileId, batch.id);
      return;
    }
    item.chatId = linkedChat?.id || item.chatId;
    item.reading = linkedChat?.reading ? cloneIntakeBatch(linkedChat.reading) : item.reading;
    if (
      linkedChat?.status === 'failed' &&
      linkedChat.reading?.providerWait &&
      item.providerWait?.requestId !== linkedChat.reading.providerWait.requestId
    ) {
      retainProviderWait(profileId, batch, item, linkedChat);
      return;
    }

    // A linked authorized conversion owns the profile's single model slot until
    // it reaches a terminal pass, even if that pass has already retained an
    // early proposal. Observe it instead of declaring the file finished.
    if (linkedChat?.status === 'running') {
      assistant.cancel(profileId, linkedChat.id);
      item.status = 'queued';
      item.reason = 'continuing';
      retryItems.add(key(profileId, batch.id + '/' + item.intakeId));
      save(profileId, batch, 'linked-conversion-adopted');
      schedule(profileId, batch.id);
      return;
    }
    if (isRetainOnlyIntake(intake)) {
      await captureSourceStep(profileId, batch, item, expected);
      if (!live(profileId, expected) || batch.status !== 'running') return;
      intake = getIntake(db, root, profileId, item.intakeId);
      finishItem(profileId, batch, item, 'skipped', 'retain_only', intake, linkedChat);
      schedule(profileId, batch.id);
      return;
    }
    const interpretations = currentIntakeInterpretations(db, profileId, item.intakeId);
    const staleInterpretation =
      !interpretations.proposalIds.length &&
      ((!interpretations.original && !!intake.validation?.valid) || intake.proposals.length > 0);
    const retry =
      retryItems.delete(key(profileId, `${batch.id}/${item.intakeId}`)) ||
      (item.automaticRun === true && !!item.chatId) ||
      staleInterpretation;
    // Capture every remaining source section even when an early proposal is reviewable.
    // Page-scoped dependencies keep unrelated later pages from staling it.
    if (item.sourceExtraction?.draining) {
      await drainRecordlessSource(profileId, batch, item, expected, linkedChat);
      return;
    }
    if (!item.sourceExtraction?.initialDone) {
      const outcome = await captureSourceStep(profileId, batch, item, expected);
      if (!live(profileId, expected) || batch.status !== 'running') return;
      intake = getIntake(db, root, profileId, item.intakeId);
      if (outcome === 'pending') {
        item.status = 'queued';
        item.reason ||= 'extracting_source_text';
        save(profileId, batch, 'source-extraction-progress');
        batch.currentIndex = (batch.currentIndex + 1) % batch.items.length;
        schedule(profileId, batch.id);
        return;
      }
      if (outcome === 'blocked') {
        finishItem(
          profileId,
          batch,
          item,
          item.exceptions?.some((exception) => exception.unitId === 'source:' + item.intakeId)
            ? 'review_ready'
            : 'paused',
          item.reason || 'source_review_required',
          intake,
          linkedChat,
        );
        schedule(profileId, batch.id);
        return;
      }
    }
    const current = currentIntakeInterpretations(db, profileId, item.intakeId);
    if (
      recordDurabilityStatus(db) &&
      sourceTextExtractionPending(getIntakeSourceText(db, root, profileId, item.intakeId))
    ) {
      await drainRecordlessSource(profileId, batch, item, expected, linkedChat);
      return;
    }
    if (intake.state === 'ready' && intake.validation?.valid && current.original) {
      finishItem(profileId, batch, item, 'review_ready', 'prepared_jsonl', intake, linkedChat);
      schedule(profileId, batch.id);
      return;
    }
    const capturedThisBatch =
      (item.sourceExtraction?.steps || 0) > (item.sourceExtraction?.stepsAtModelPass || 0);
    const completedProposalPass =
      linkedChat?.status === 'idle' &&
      !linkedChat.reading?.remainingUnits &&
      !linkedChat.reading?.pendingReadWindows;
    if (
      !item.forceModelResume &&
      !capturedThisBatch &&
      current.proposalIds.length &&
      (!retry || completedProposalPass)
    ) {
      finishItem(profileId, batch, item, 'review_ready', 'already_reviewable', intake, linkedChat);
      schedule(profileId, batch.id);
      return;
    }
    if (!retry && ['imported', 'kept_original'].includes(intake.state)) {
      finishItem(profileId, batch, item, 'skipped', 'already_reviewed', intake, linkedChat);
      schedule(profileId, batch.id);
      return;
    }
    if (linkedChat && !retry && !capturedThisBatch) {
      if (
        linkedChat.status !== 'cancelled' &&
        recordDurabilityStatus(db) &&
        sourceTextExtractionPending(getIntakeSourceText(db, root, profileId, item.intakeId))
      ) {
        await drainRecordlessSource(profileId, batch, item, expected, linkedChat);
        return;
      }
      finishItem(
        profileId,
        batch,
        item,
        'paused',
        linkedChat.reading?.reason || 'existing_conversion_paused',
        intake,
        linkedChat,
      );
      schedule(profileId, batch.id);
      return;
    }

    item.status = 'starting';
    item.reason = null;
    item.startedAt ||= now();
    save(profileId, batch, 'item-starting');
    if (!(await ensureReady(profileId, batch, item, intake, expected))) return;
    if (assistant.isBusy(profileId)) {
      item.status = 'queued';
      item.reason = 'waiting_for_local_capacity';
      item.retryAt = new Date(clock().getTime() + 1000).toISOString();
      save(profileId, batch, 'assistant-busy');
      schedule(profileId, batch.id, 1000);
      return;
    }
    intake = getIntake(db, root, profileId, item.intakeId);
    if (intake.sha256 !== item.sourceHash) {
      finishItem(profileId, batch, item, 'paused', 'source_changed', intake, linkedChat);
      schedule(profileId, batch.id);
      return;
    }

    if (recordDurabilityStatus(db) && !intake.workflow?.plans.some((p) => p.status === 'active')) {
      intake = await createIntakePlan(db, root, profileId, intake.id, {
        version: intake.version,
        assertRunning: () => {
          if (!live(profileId, expected) || !authorized(profileId, item.intakeId, 'publish'))
            throw Error('SOURCE_EXTRACTION_CANCELLED');
        },
      });
    }
    const plan = intake.workflow?.plans.find((p) => p.status === 'active');
    const unit = plan ? nextPendingReadingUnit(plan) : undefined;
    if (unit && item.stalls?.unitId !== unit.id)
      item.stalls = { unitId: unit.id, locator: unit.locator || unit.id, attempts: 0 };
    beginReadingSlice(item, now(), readingLimits);
    save(profileId, batch, 'reading-slice-started');
    const runOptions: BatchAssistantRunOptions = {
      assertAuthorized: (operation) => {
        if (
          !live(profileId, expected) ||
          !item.automaticRun ||
          batch.status !== 'running' ||
          !authorized(profileId, item.intakeId, operation)
        )
          throw Error('Import processing authorization ended');
      },
      beforeModelRequest: (reading) => {
        if (
          !live(profileId, expected) ||
          batch.status !== 'running' ||
          !item.automaticRun ||
          !authorized(profileId, item.intakeId, 'dispatch')
        )
          throw Error('Import processing authorization ended');
        if (reading.workUnit && item.stalls?.unitId !== reading.workUnit.id)
          item.stalls = {
            unitId: reading.workUnit.id,
            locator: reading.workUnit.locator,
            attempts: 0,
          };
        const reached = readingModelRequestBudgetReached(item, reading, now(), readingLimits);
        save(profileId, batch, 'reading-request-checkpoint');
        return reached;
      },
    };
    let chat: AssistantChat | null = linkedChat;
    try {
      if (!chat) {
        chat = assistant.create(profileId, {
          title: `Convert ${intake.filename}`,
          context: {
            route: `/import?intake=${encodeURIComponent(intake.id)}`,
            intakeId: intake.id,
          },
        });
        linkIntakeConversion(db, root, profileId, intake.id, chat.id);
        item.chatId = chat.id;
        save(profileId, batch, 'conversion-linked');
        chat = assistant.send(
          profileId,
          chat.id,
          {
            message: startMessage(intake),
            context: {
              route: `/import?intake=${encodeURIComponent(intake.id)}`,
              intakeId: intake.id,
            },
          },
          runOptions,
        );
      } else if (chat.status === 'idle') {
        chat = assistant.send(
          profileId,
          chat.id,
          {
            message:
              'Resume the linked delivery conversion from its retained checkpoint. Keep coverage partial unless every relevant source window was actually read. Do not accept or import.',
            context: {
              route: `/import?intake=${encodeURIComponent(intake.id)}`,
              intakeId: intake.id,
            },
          },
          runOptions,
        );
      } else chat = assistant.retry(profileId, chat.id, runOptions);
    } catch (error) {
      if (!live(profileId, expected)) return;
      if (modelFailure(error)) {
        finishReadingSlice(item, item.reading, now());
        item.status = 'queued';
        item.reason = 'model_unavailable';
        item.retryAt = modelRetryAt(item);
        save(profileId, batch, 'model-unavailable-after-start');
        batch.currentIndex = (batch.currentIndex + 1) % batch.items.length;
        schedule(profileId, batch.id);
        return;
      }
      if (error instanceof HttpError && error.code === 'ASSISTANT_BUSY') {
        finishReadingSlice(item, item.reading, now());
        item.status = 'queued';
        item.reason = 'waiting_for_local_capacity';
        item.retryAt = new Date(clock().getTime() + providerRetryBaseMs).toISOString();
        save(profileId, batch, 'assistant-busy-after-start');
        batch.currentIndex = (batch.currentIndex + 1) % batch.items.length;
        schedule(profileId, batch.id);
        return;
      }
      finishItem(profileId, batch, item, 'paused', 'conversion_start_error', intake, chat);
      schedule(profileId, batch.id);
      return;
    }
    if (!live(profileId, expected)) {
      assistant.cancel(profileId, chat!.id);
      return;
    }
    item.chatId = chat!.id;
    delete item.forceModelResume;
    item.status = 'running';
    save(profileId, batch, 'conversion-running');
    schedule(profileId, batch.id, pollMs);
  }

  async function inspectRunning(
    profileId: string,
    batch: IntakeBatch,
    item: IntakeBatchItem,
    expected: number,
  ): Promise<void> {
    let chat: AssistantChat;
    try {
      chat = assistant.get(profileId, item.chatId!);
    } catch {
      if (!live(profileId, expected)) return;
      finishItem(profileId, batch, item, 'paused', 'conversion_missing', null, null);
      schedule(profileId, batch.id);
      return;
    }
    if (chat.status === 'running') {
      item.reading = chat.reading ? cloneIntakeBatch(chat.reading) : item.reading;
      const progressKey = key(profileId, `${batch.id}/${item.intakeId}`);
      if (observeReadingProgress(item, now())) dirtyProgress.add(progressKey);
      if (
        dirtyProgress.has(progressKey) &&
        clock().getTime() - (progressSavedAt.get(progressKey) || 0) >= 5000
      ) {
        save(profileId, batch, 'reading-progress');
        dirtyProgress.delete(progressKey);
        progressSavedAt.set(progressKey, clock().getTime());
      }
      // The active no-progress window governs the next physical provider request. Do not
      // cancel a request or guarded tool result already admitted by that gate.
      schedule(profileId, batch.id, pollMs);
      return;
    }
    if (!live(profileId, expected)) return;
    const intake = getIntake(dbFor(profileId), root, profileId, item.intakeId) as Intake;
    const responsesBefore = item.reading?.usableModelResponses || 0;
    const madeProgress = finishReadingSlice(item, chat.reading || item.reading, now());
    item.reading = chat.reading ? cloneIntakeBatch(chat.reading) : item.reading;
    if ((item.reading?.usableModelResponses || 0) > responsesBefore) item.modelRetryAttempts = 0;
    if (intake.sha256 !== item.sourceHash) {
      finishItem(profileId, batch, item, 'paused', 'source_changed', intake, chat);
      schedule(profileId, batch.id);
      return;
    }
    if (
      madeProgress ||
      chat.status === 'idle' ||
      (chat.reading?.usableModelResponses || 0) > (item.providerWait?.responsesAtWait || 0)
    )
      delete item.providerWait;
    if (chat.reading?.reason === 'source_prerequisite') {
      // A missing shared service is not evidence that this source unit is stuck.
      // The wait is outside the active slice; completed unproductive requests
      // in this slice still count toward the source-unit stall threshold.
      item.status = 'queued';
      item.reason = 'source_prerequisite';
      item.retryAt = new Date(clock().getTime() + 30000).toISOString();
      save(profileId, batch, 'model-source-prerequisite');
      scheduleNextProfile(profileId);
      return;
    }
    if (chat.reading?.reason === 'unsupported_context') {
      item.status = 'paused';
      item.reason = 'provider_rejected';
      item.automaticRun = true;
      item.prerequisiteKey = prerequisiteRevision(profileId);
      item.retryAt = new Date(clock().getTime() + 30000).toISOString();
      save(profileId, batch, 'context-prerequisite-required');
      scheduleNextProfile(profileId);
      return;
    }
    if (
      chat.reading?.providerWait?.classification === 'context_limit' ||
      (chat.reading?.reason === 'context_limit' &&
        chat.reading?.providerWait?.classification === 'unsupported')
    ) {
      if (retainProviderWait(profileId, batch, item, chat)) return;
    }
    if (
      chat.status === 'idle' &&
      (canContinueReadingSlice(item.reading, madeProgress) || item.reading?.reason === 'job_limit')
    ) {
      if (readingBudgetReached(item, now(), readingLimits)) {
        const scope =
          item.stalls ||
          (item.reading?.workUnit
            ? {
                unitId: item.reading.workUnit.id,
                locator: item.reading.workUnit.locator,
                attempts: 0,
              }
            : null);
        if (!scope) {
          finishItem(profileId, batch, item, 'paused', 'source_scope_unavailable', intake, chat);
          schedule(profileId, batch.id);
          return;
        }
        scope.attempts++;
        item.stalls = scope;
        extendReadingBudget(item);
        if (scope.attempts >= 3) {
          const exception = {
            unitId: scope.unitId,
            locator: scope.locator,
            reason: 'processing_stalled' as const,
          };
          itemExceptions(item).push(exception);
          workflowMutation(
            dbFor(profileId),
            root,
            profileId,
            intake.id,
            {
              version: intake.version,
              operationId:
                'stall:' + batch.id + ':' + scope.unitId + ':' + (item.exceptionEpoch || 0),
            },
            (workflow) => {
              const unit = workflow.plans
                .find((p) => p.status === 'active')
                ?.units.find((u) => u.id === scope.unitId);
              if (unit) unit.processingException = { reason: 'processing_stalled', at: now() };
            },
          );
          const remaining = getIntake(dbFor(profileId), root, profileId, intake.id)
            .workflow?.plans.find((p) => p.status === 'active')
            ?.units.some((u) => !u.processingException && u.status !== 'completed');
          if (!remaining) {
            finishItem(profileId, batch, item, 'review_ready', 'processing_stalled', intake, chat);
            schedule(profileId, batch.id);
            return;
          }
        }
      }
      item.status = 'queued';
      item.reason = 'continuing';
      item.proposalIds = intake.proposals.map((proposal) => proposal.id);
      item.retryAt = new Date(clock().getTime() + continuationDelayMs).toISOString();
      retryItems.add(key(profileId, batch.id + '/' + item.intakeId));
      save(profileId, batch, 'productive-slice-continued');
      batch.currentIndex = (batch.currentIndex + 1) % batch.items.length;
      schedule(profileId, batch.id);
      return;
    }
    item.proposalIds = intake.proposals.map((proposal) => proposal.id);
    // A retained cumulative step count is not evidence of new source capture on
    // the next process run. Record that this completed pass covered those steps.
    if (chat.status === 'idle' && item.sourceExtraction)
      item.sourceExtraction.stepsAtModelPass = item.sourceExtraction.steps;
    if (chat.status === 'failed' && chat.reading?.providerWait) {
      // Provider unavailability is not local stuckness, even when a request timed out.
      // Do not forgive preceding unproductive model requests in this slice.
      if (retainProviderWait(profileId, batch, item, chat)) return;
    }
    if (
      currentIntakeInterpretations(dbFor(profileId), profileId, item.intakeId).proposalIds.length
    ) {
      finishItem(
        profileId,
        batch,
        item,
        intake.workflow?.plans.length &&
          (item.reading?.remainingUnits || item.reading?.pendingReadWindows)
          ? 'paused'
          : 'review_ready',
        'bounded_pass_ready',
        intake,
        chat,
      );
      schedule(profileId, batch.id);
      return;
    }
    if (
      chat.status !== 'cancelled' &&
      recordDurabilityStatus(dbFor(profileId)) &&
      sourceTextExtractionPending(
        getIntakeSourceText(dbFor(profileId), root, profileId, item.intakeId),
      )
    ) {
      await drainRecordlessSource(profileId, batch, item, expected, chat);
      return;
    }
    finishItem(
      profileId,
      batch,
      item,
      chat.reading?.reason === 'reading_exhausted' ? 'review_ready' : 'paused',
      chat.reading?.reason || (chat.status === 'cancelled' ? 'stopped' : 'no_proposal'),
      intake,
      chat,
    );
    schedule(profileId, batch.id);
  }

  async function pump(profileId: string, batchId: string, expected: number): Promise<void> {
    if (!live(profileId, expected)) return;
    let batch = get(profileId, batchId);
    const active = [...batches.values()].filter(
      (b) => b.profileId === profileId && b.status === 'running',
    );
    const running = active.find((b) => b.items.some((i) => i.status === 'running'));
    const ready = active.find((b) =>
      b.items.some(
        (i) =>
          i.automaticRun !== false &&
          (i.status === 'queued' || (i.status === 'paused' && i.retryAt)) &&
          (!(i.retryAt || i.providerWait?.retryAt) ||
            Date.parse(i.retryAt || i.providerWait?.retryAt || '') <= clock().getTime()),
      ),
    );
    batch =
      running ||
      (batch.status === 'running' &&
      batch.items.some((i) => i.status === 'queued' && !(i.retryAt || i.providerWait?.retryAt))
        ? batch
        : ready || batch);
    pumpBatches.set(profileId, batch.id);
    if (batch.status !== 'running') {
      scheduleNextProfile(profileId);
      return;
    }
    let prerequisiteRestored = false;
    for (const waiting of batch.items) {
      if (
        waiting.status === 'paused' &&
        waiting.prerequisiteKey &&
        waiting.prerequisiteKey !== prerequisiteRevision(profileId)
      ) {
        waiting.retryAt = null;
        waiting.status = 'queued';
        prerequisiteRestored = true;
      }
    }
    if (prerequisiteRestored) save(profileId, batch, 'provider-prerequisite-restored');
    let item = batch.items[batch.currentIndex];
    if (item?.status === 'running') {
      await inspectRunning(profileId, batch, item, expected);
      return;
    }
    if (completeIfDone(profileId, batch)) return;
    item = batch.items[batch.currentIndex];
    if (!authorized(profileId, item.intakeId, 'dispatch')) return;
    if (item.prerequisiteKey && item.prerequisiteKey === prerequisiteRevision(profileId)) {
      item.status = 'paused';
      item.retryAt = new Date(clock().getTime() + 30000).toISOString();
      save(profileId, batch, 'provider-prerequisite-wait');
      scheduleNextProfile(profileId);
      return;
    }
    delete item.prerequisiteKey;
    item.retryAt = null;

    await beginItem(profileId, batch, item, expected);
  }

  function create(profileId: string, input: Partial<CreateIntakeBatchInput> | null): IntakeBatch {
    dbFor(profileId);
    retryPublication(profileId);
    loadProfile(profileId);
    assertProfileCurrent(profileId);
    const operationId = op(input?.operationId);
    if (
      !Array.isArray(input?.intakeIds) ||
      !input.intakeIds.length ||
      input.intakeIds.length > 100 ||
      input.intakeIds.some((id) => typeof id !== 'string' || !id)
    )
      throw new HttpError(400, 'INTAKE_BATCH_SELECTION', 'Choose 1–100 uploaded root originals');
    const intakeIds = input.intakeIds;
    if (new Set(intakeIds).size !== intakeIds.length)
      throw new HttpError(400, 'INTAKE_BATCH_SELECTION', 'Choose each original only once');
    if (input.appendToRunning !== undefined && typeof input.appendToRunning !== 'boolean')
      throw new HttpError(400, 'INTAKE_BATCH_SELECTION', 'appendToRunning must be a boolean');
    const existing = [...batches.values()].find(
      (batch) =>
        batch.profileId === profileId &&
        (batch.operationId === operationId ||
          batch.appendOperations?.some((operation) => operation.operationId === operationId) ||
          batch.reopenOperations?.some((operation) => operation.operationId === operationId)),
    );
    if (existing) {
      const appended = existing.appendOperations || [];
      const originalCount =
        existing.items.length -
        appended.reduce((sum, operation) => sum + operation.intakeIds.length, 0);
      const selection =
        existing.operationId === operationId
          ? existing.selectionIntakeIds ||
            existing.items.slice(0, originalCount).map((item) => item.intakeId)
          : (() => {
              const appendedOperation = appended.find(
                (operation) => operation.operationId === operationId,
              );
              if (appendedOperation)
                return appendedOperation.selectionIntakeIds || appendedOperation.intakeIds;
              return (
                existing.reopenOperations?.find(
                  (operation) => operation.operationId === operationId,
                )?.intakeIds || []
              );
            })();
      if (
        selection.length !== intakeIds.length ||
        selection.some((id, index) => id !== intakeIds[index])
      )
        throw new HttpError(
          409,
          'INTAKE_BATCH_OPERATION',
          'This operation ID already belongs to a different selection',
        );
      return publicBatch(existing, false);
    }
    const owned = [...batches.values()].filter((batch) => batch.profileId === profileId);
    const newIntakeIds = intakeIds.filter(
      (id) => !owned.some((batch) => batch.items.some((item) => item.intakeId === id)),
    );
    if (newIntakeIds.length && newIntakeIds.length !== intakeIds.length) {
      const db = dbFor(profileId);
      const affectedOwned = owned.some((batch) =>
        batch.items.some((item) => {
          if (!intakeIds.includes(item.intakeId)) return false;
          if (item.status !== 'review_ready') return batch.status === 'stopped';
          const interpretation = currentIntakeInterpretations(db, profileId, item.intakeId);
          return (
            (!interpretation.original && !interpretation.proposalIds.length) ||
            sourceTextExtractionPending(getIntakeSourceText(db, root, profileId, item.intakeId))
          );
        }),
      );
      if (affectedOwned)
        throw new HttpError(
          409,
          'INTAKE_BATCH_SELECTION',
          'Enqueue new originals and reprocess corrected originals in separate operations',
        );
    }
    if (!newIntakeIds.length) {
      const selectedOwners = owned.filter((batch) =>
        batch.items.some((item) => intakeIds.includes(item.intakeId)),
      );
      if (selectedOwners.length > 1)
        throw new HttpError(
          409,
          'INTAKE_BATCH_SELECTION',
          'Reprocess corrected originals from one retained batch at a time',
        );
      const retained = owned.find((batch) =>
        batch.items.some((item) => intakeIds.includes(item.intakeId)),
      )!;
      // A new operation may revisit completed work after source correction. The
      // original operation above remains an exact replay, and explicit Stop is
      // never overridden by a later enqueue.
      if (retained.status !== 'stopped') {
        const db = dbFor(profileId);
        const affected = retained.items.filter((item) => {
          if (!intakeIds.includes(item.intakeId) || item.status !== 'review_ready') return false;
          const interpretation = currentIntakeInterpretations(db, profileId, item.intakeId);
          const text = getIntakeSourceText(db, root, profileId, item.intakeId);
          return (
            (!interpretation.original && !interpretation.proposalIds.length) ||
            sourceTextExtractionPending(text)
          );
        });
        if (affected.length) {
          if (retained.status === 'running')
            throw new HttpError(
              409,
              'INTAKE_BATCH_BUSY',
              'Finish or stop this reading batch before reprocessing a completed file',
            );
          const competing = owned.find(
            (batch) => batch.id !== retained.id && batch.status === 'running',
          );
          if (competing)
            throw new HttpError(
              409,
              'INTAKE_BATCH_BUSY',
              'Another reading batch is already running for this profile',
            );
          if (!authorized(profileId, affected[0]!.intakeId, 'publish'))
            throw new HttpError(403, 'PROFILE_SCOPE', 'Unlock this profile before reading');
          for (const item of affected) {
            item.status = 'queued';
            item.reason = null;
            item.endedAt = null;
            item.automaticRun = true;
            item.retryAt = null;
            if (item.sourceExtraction) item.sourceExtraction.initialDone = false;
            if (item.chatId) retryItems.add(key(profileId, `${retained.id}/${item.intakeId}`));
          }
          retained.currentIndex = retained.items.indexOf(affected[0]!);
          retained.status = 'running';
          retained.reason = null;
          retained.automaticRun = true;
          reopenOperations(retained).push({
            operationId,
            intakeIds: [...intakeIds],
            at: now(),
          });
          generations.set(profileId, generation(profileId) + 1);
          save(profileId, retained, 'source-evidence-reopened');
          schedule(profileId, retained.id);
          return publicBatch(retained, true);
        }
      } else {
        // Reprocess is a fresh intent for exactly the selected corrected file.
        // Every other stopped item keeps its Stop state.
        if (owned.some((batch) => batch.id !== retained.id && batch.status === 'running'))
          throw new HttpError(
            409,
            'INTAKE_BATCH_BUSY',
            'Another reading batch is already running for this profile',
          );
        for (const item of retained.items) {
          if (!intakeIds.includes(item.intakeId) || item.status !== 'review_ready') continue;
          const interpretation = currentIntakeInterpretations(
            dbFor(profileId),
            profileId,
            item.intakeId,
          );
          const pending = sourceTextExtractionPending(
            getIntakeSourceText(dbFor(profileId), root, profileId, item.intakeId),
          );
          if ((interpretation.proposalIds.length || interpretation.original) && !pending) continue;
          item.status = 'paused';
          item.reason = 'stopped';
          item.resumeAutomaticRun = true;
          if (item.sourceExtraction) item.sourceExtraction.initialDone = false;
        }
      }
      if (
        retained.status === 'stopped' &&
        retained.items.some(
          (item) =>
            intakeIds.includes(item.intakeId) &&
            (item.resumeAutomaticRun || item.reason === 'stopped'),
        )
      )
        return publicBatch(resume(profileId, retained.id, new Set(intakeIds), operationId), true);
      return publicBatch(retained, false);
    }
    const running = [...batches.values()].find(
      (batch) => batch.profileId === profileId && batch.status === 'running',
    );
    if (running && input.appendToRunning !== true)
      throw new HttpError(409, 'INTAKE_BATCH_BUSY', 'A reading batch is already running');
    const db = dbFor(profileId);
    const items: IntakeBatchItem[] = newIntakeIds.map((intakeId) => {
      const intake = getIntake(db, root, profileId, intakeId);
      if (intake.parentSourceFileId)
        throw new HttpError(
          400,
          'INTAKE_BATCH_SELECTION',
          'Choose uploaded root originals; retained children stay inside their parent delivery',
        );
      return {
        intakeId: intake.id,
        sourceHash: intake.sha256,
        filename: intake.filename,
        mimeType: intake.mimeType,
        automaticRun: true,
        status: 'queued',
        reason: null,
        chatId: null,
        proposalIds: [],
        reading: null,
        startedAt: null,
        endedAt: null,
        queuedAt: now(),
      };
    });
    const at = now();
    if (running) {
      // Append through the tracked containers. Retained runner/item references
      // remain valid across awaits and failure recovery.
      running.items.push(...items);
      running.appendOperations ||= [];
      running.appendOperations.push({
        operationId,
        intakeIds: [...newIntakeIds],
        selectionIntakeIds: [...intakeIds],
        at,
      });
      save(profileId, running, 'originals-appended');
      schedule(profileId, running.id);
      return publicBatch(running, true);
    }
    const batch = trackIntakeBatch({
      id: randomUUID(),
      profileId,
      operationId,
      selectionIntakeIds: [...intakeIds],
      automaticRun: true,
      status: 'running',
      reason: null,
      currentIndex: 0,
      createdAt: at,
      updatedAt: at,
      items,
    } as IntakeBatch);
    save(profileId, batch, 'created');
    schedule(profileId, batch.id);
    return publicBatch(batch, true);
  }

  function list(profileId: string): IntakeBatch[] {
    dbFor(profileId);
    retryPublication(profileId);
    loadProfile(profileId);
    assertProfileCurrent(profileId);
    return [...batches.values()]
      .filter((batch) => batch.profileId === profileId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((batch) => publicBatch(batch));
  }

  function rescheduleOtherBatches(profileId: string, excludedId: string): void {
    for (const other of batches.values()) {
      if (other.profileId !== profileId || other.id === excludedId || other.status !== 'running')
        continue;
      for (const item of other.items) {
        if (!['starting', 'running'].includes(item.status)) continue;
        if (item.chatId) assistant.cancel(profileId, item.chatId);
        finishReadingSlice(item, item.reading, now());
        item.status = 'queued';
        item.reason = 'continuing';
      }
      save(profileId, other, 'coordinator-generation-restored');
      schedule(profileId, other.id);
    }
  }

  function stop(profileId: string, batchId: string): IntakeBatch {
    const batch = get(profileId, batchId);
    const wasRunning = batch.status === 'running';
    batch.automaticRun = false;
    for (const entry of batch.items) {
      if (batch.status !== 'stopped') entry.resumeAutomaticRun = entry.automaticRun === true;
      entry.automaticRun = false;
    }
    if (batch.status === 'stopped') return publicBatch(batch);
    if (wasRunning) {
      clear(profileId);
      generations.set(profileId, generation(profileId) + 1);
    }
    for (const item of batch.items) {
      if (
        !item.resumeAutomaticRun ||
        !['queued', 'starting', 'running', 'paused'].includes(item.status)
      )
        continue;
      if (item.chatId && ['starting', 'running'].includes(item.status))
        assistant.cancel(profileId, item.chatId);
      finishReadingSlice(item, item.reading, now());
      item.status = 'paused';
      item.reason = 'stopped';
      item.retryAt = null;
      item.endedAt = now();
    }
    batch.status = 'stopped';
    batch.reason = 'stopped';
    save(profileId, batch, 'stopped');
    if (wasRunning) rescheduleOtherBatches(profileId, batch.id);
    return publicBatch(batch);
  }

  function resume(
    profileId: string,
    batchId: string,
    selectedIntakeIds?: Set<string>,
    reopenOperationId?: string,
  ): IntakeBatch {
    const batch = get(profileId, batchId);
    const competing = [...batches.values()].find(
      (candidate) =>
        candidate.profileId === profileId &&
        candidate.id !== batch.id &&
        candidate.status === 'running',
    );
    if (competing)
      throw new HttpError(
        409,
        'INTAKE_BATCH_BUSY',
        'Another reading batch is already running for this profile',
      );
    if (batch.status === 'running') return publicBatch(batch);
    if (!['paused', 'stopped', 'complete'].includes(batch.status))
      throw new HttpError(409, 'INTAKE_BATCH_RESUME', 'This reading batch cannot be resumed');
    let index = batch.items.findIndex(
      (item) =>
        (!selectedIntakeIds || selectedIntakeIds.has(item.intakeId)) &&
        item.resumeAutomaticRun &&
        (hasPausedIntakeReading(item) || item.status === 'queued'),
    );
    if (index < 0 && batch.status === 'stopped')
      index = batch.items.findIndex(
        (item) =>
          (!selectedIntakeIds || selectedIntakeIds.has(item.intakeId)) &&
          (item.reason === 'stopped' || item.status === 'queued'),
      );
    if (index < 0)
      index = batch.items.findIndex(
        (item) =>
          (!selectedIntakeIds || selectedIntakeIds.has(item.intakeId)) &&
          hasPausedIntakeReading(item),
      );
    if (index < 0)
      throw new HttpError(409, 'INTAKE_BATCH_RESUME', 'No paused delivery needs another pass');
    for (const item of batch.items) {
      if (selectedIntakeIds && !selectedIntakeIds.has(item.intakeId)) continue;
      if (!item.resumeAutomaticRun && item.reason !== 'stopped' && item !== batch.items[index])
        continue;
      if (!hasPausedIntakeReading(item) && item.status !== 'queued') continue;
      item.forceModelResume = true;
      if (item.sourceExtraction?.draining) {
        item.sourceExtraction.allowanceId = randomUUID();
        item.sourceExtraction.stepsAtAllowance = item.sourceExtraction.steps;
        item.sourceExtraction.spentMsAtAllowance = item.sourceExtraction.spentMs;
      }
      if (item.reason === 'job_limit' || item.reading?.reason === 'job_limit')
        extendReadingBudget(item);
      item.status = 'queued';
      item.reason = null;
      item.endedAt = null;
      if (item.chatId && !item.sourceExtraction?.draining)
        retryItems.add(key(profileId, `${batch.id}/${item.intakeId}`));
      item.automaticRun = true;
      delete item.resumeAutomaticRun;
    }
    batch.automaticRun = true;
    batch.currentIndex = index;
    batch.status = 'running';
    batch.reason = null;
    if (reopenOperationId && selectedIntakeIds)
      reopenOperations(batch).push({
        operationId: reopenOperationId,
        intakeIds: [...selectedIntakeIds],
        at: now(),
      });
    for (const queued of batch.items) if (queued.status === 'queued') queued.queuedAt = now();
    generations.set(profileId, generation(profileId) + 1);
    save(profileId, batch, 'resumed');
    schedule(profileId, batch.id);
    return publicBatch(batch);
  }

  function retryExceptions(profileId: string, batchId: string): IntakeBatch {
    const batch = get(profileId, batchId);
    const db = dbFor(profileId);
    for (const item of batch.items) {
      if (!item.exceptions?.length) continue;
      if (!authorized(profileId, item.intakeId, 'publish'))
        throw new HttpError(403, 'PROFILE_SCOPE', 'Unlock this profile before retrying imports');
      retrySourceExceptions(db, root, profileId, item.intakeId);
      const intake = getIntake(db, root, profileId, item.intakeId);
      workflowMutation(
        db,
        root,
        profileId,
        item.intakeId,
        { version: intake.version, operationId: randomUUID() },
        (workflow) => {
          for (const plan of workflow.plans.filter((plan) => plan.status === 'active'))
            for (const unit of plan.units) delete unit.processingException;
        },
      );
      item.exceptionEpoch = (item.exceptionEpoch || 0) + 1;
      item.exceptions = [];
      item.stalls = undefined;
      item.sourceExtraction = undefined;
      item.automaticRun = true;
      item.status = 'queued';
      item.reason = 'continuing';
      item.retryAt = null;
      extendReadingBudget(item);
      retryItems.add(key(profileId, batch.id + '/' + item.intakeId));
    }
    batch.currentIndex = 0;
    batch.status = 'running';
    batch.automaticRun = true;
    batch.reason = null;
    save(profileId, batch, 'exceptions-retried');
    schedule(profileId, batch.id);
    return publicBatch(batch);
  }

  function close(reason = 'interrupted'): void {
    if (closed && !closeIncomplete) return;
    const retrying = closed;
    closed = true;
    closeIncomplete = true;
    const failures: unknown[] = [];
    for (const profileId of databases.keys()) {
      clear(profileId);
      generations.set(profileId, generation(profileId) + 1);
      try {
        retryPublication(profileId);
        loadProfile(profileId);
        for (const batch of batches.values()) {
          if (batch.profileId !== profileId) continue;
          // A prior failed close revoked every handle, including batches whose
          // publication had not yet been attempted. Reconstruct before retrying.
          if (retrying) refreshIntakeBatch(root, profileId, batch);
          if (batch.status !== 'running') continue;
          const item = batch.items[batch.currentIndex];
          if (item?.chatId && item.status === 'running') assistant.cancel(profileId, item.chatId);
          if (item && ['queued', 'starting', 'running'].includes(item.status)) {
            finishReadingSlice(item, item.reading, now());
            item.status = 'paused';
            item.reason = reason;
            item.endedAt = now();
          }
          batch.status = 'paused';
          batch.reason = reason;
          save(profileId, batch, 'runner-closed');
        }
      } catch (error) {
        failures.push(error);
      } finally {
        clearIntakeBatchJournalCache(root, profileId);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Reading batch close failed');
    closeIncomplete = false;
  }

  function wake(profileId: string) {
    if (closed || !databases.has(profileId)) return;
    retryPublication(profileId);
    loadProfile(profileId);
    const owned = new Set(
      [...batches.values()]
        .filter((b) => b.profileId === profileId)
        .flatMap((b) => b.items.map((i) => i.intakeId)),
    );
    const pending = dbFor(profileId)
      .prepare("SELECT value FROM app_meta WHERE key LIKE 'intake_enqueue:v1:%'")
      .all()
      .map((row) => JSON.parse(String(row.value)) as { intakeId: string; operationId: string })
      .filter((intent) => !owned.has(intent.intakeId));
    for (const intent of pending) {
      if (!authorized(profileId, intent.intakeId, 'dispatch')) continue;
      create(profileId, {
        operationId: intent.operationId,
        intakeIds: [intent.intakeId],
        appendToRunning: true,
      });
    }
    for (const batch of batches.values())
      if (batch.profileId === profileId && batch.automaticRun && batch.status === 'running')
        schedule(profileId, batch.id);
  }
  // Instantiation follows authorized runtime restoration, never a browser GET.
  for (const profileId of databases.keys()) wake(profileId);

  return {
    wake,
    create,
    list,
    get: (profileId: string, id: string) => publicBatch(get(profileId, id)),
    stop,
    resume,
    retryExceptions,
    close,
    isBusy(profileId: string): boolean {
      retryPublication(profileId);
      loadProfile(profileId);
      assertProfileCurrent(profileId);
      return [...batches.values()].some(
        (batch) => batch.profileId === profileId && batch.status === 'running',
      );
    },
  };
}
