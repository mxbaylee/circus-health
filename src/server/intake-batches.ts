import { randomUUID } from 'node:crypto';
import {
  importDiagnostics,
  beginImportPhase,
  measureImportPhase,
  type ImportDiagnosticSink,
} from './import-diagnostics.ts';
import { HttpError, required } from './database.ts';
import { getIntake, linkIntakeConversion } from './intake.ts';
import { listIntakeBatches, readIntakeBatch, writeIntakeBatch } from './intake-batch-journal.ts';
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
}

interface BatchManagerOptions {
  diagnostics?: ImportDiagnosticSink;
  root: string;
  databases: Map<string, DatabaseSync>;
  assistant: BatchAssistant;
  journalWriter?: (root: string, profileId: string, batch: IntakeBatch, reason: string) => void;
  clock?: () => Date;
  pollMs?: number;
  continuationDelayMs?: number;
  readingLimits?: IntakeReadingLimits;
}

export interface IntakeBatchManager {
  create(profileId: string, input: Partial<CreateIntakeBatchInput> | null): IntakeBatch;
  list(profileId: string): IntakeBatch[];
  get(profileId: string, id: string): IntakeBatch;
  stop(profileId: string, batchId: string): IntakeBatch;
  resume(profileId: string, batchId: string): IntakeBatch;
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
  return (
    value.code === 'MODEL_UNAVAILABLE' ||
    /\b(model|provider|proxy|connection|authentication|credential|oauth|unauthorized|forbidden|timeout|timed out|rate limit|overloaded)\b/i.test(
      typeof value.message === 'string' ? value.message : '',
    )
  );
}

function publicBatch(batch: IntakeBatch): IntakeBatch {
  return structuredClone(batch);
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
  diagnostics = importDiagnostics,
}: BatchManagerOptions): IntakeBatchManager {
  const batches = new Map<string, IntakeBatch>();
  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; batchId: string }>();
  const generations = new Map<string, number>();
  const retryItems = new Set<string>();
  const progressSavedAt = new Map<string, number>();
  const dirtyProgress = new Set<string>();
  const queueSpans = new Map<string, ReturnType<typeof beginImportPhase>>();
  let closed = false;
  const key = (profileId: string, batchId: string): string => `${profileId}/${batchId}`;
  const now = (): string => clock().toISOString();
  const dbFor = (profileId: string): DatabaseSync =>
    required(databases.get(profileId), 'Profile not found');
  const generation = (profileId: string): number => generations.get(profileId) || 0;
  const live = (profileId: string, value: number): boolean =>
    !closed && generation(profileId) === value;

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
  function observeQueues(profileId: string, batch: IntakeBatch) {
    for (const item of batch.items) {
      const id = key(profileId, `${batch.id}/${item.intakeId}`);
      if (batch.status !== 'running' || item.status !== 'queued') {
        if (queueSpans.has(id)) finishQueue(profileId, batch, item, batch.status !== 'running');
        continue;
      }
      if (!queueSpans.has(id))
        queueSpans.set(
          id,
          beginImportPhase(
            item.reason === 'continuing' ? 'continuation_wait' : 'processing_queue',
            {
              queueDepth: batch.items.filter((candidate) => candidate.status === 'queued').length,
              queueWaitKnown: !!item.queuedAt,
            },
            backgroundContext(profileId, batch, item),
            diagnostics,
          ),
        );
    }
  }

  function save(profileId: string, batch: IntakeBatch, reason: string): void {
    batch.updatedAt = now();
    if (batch.status === 'running')
      for (const item of batch.items) {
        if (item.status === 'queued' && !item.queuedAt) item.queuedAt = now();
      }
    journalWriter(root, profileId, batch, reason);
    observeQueues(profileId, batch);
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
      const batch = structuredClone(saved);
      const activeItem = batch.items.find((item) => ['starting', 'running'].includes(item.status));
      if (batch.status === 'running' || activeItem) {
        batch.status = 'paused';
        batch.reason = 'interrupted';
        if (activeItem) {
          // Only account through the last durable observation, never process downtime.
          finishReadingSlice(activeItem, activeItem.reading, batch.updatedAt);
          activeItem.status = 'paused';
          activeItem.reason = 'interrupted';
          activeItem.endedAt ||= now();
        }
        save(profileId, batch, 'interrupted-after-restart');
      } else batches.set(key(profileId, batch.id), batch);
    }
  }

  function get(profileId: string, batchId: string): IntakeBatch {
    dbFor(profileId);
    loadProfile(profileId);
    const stored = batches.get(key(profileId, batchId));
    return stored || readIntakeBatch(root, profileId, batchId);
  }

  function clear(profileId: string, batchId: string | null = null): boolean {
    const scheduled = timers.get(profileId);
    if (!scheduled || (batchId && scheduled.batchId !== batchId)) return false;
    clearTimeout(scheduled.timer);
    timers.delete(profileId);
    return true;
  }

  function schedule(profileId: string, batchId: string, delay = 0): void {
    if (closed || timers.has(profileId)) return;
    const expected = generation(profileId);
    const timer = setTimeout(() => {
      timers.delete(profileId);
      if (!live(profileId, expected)) return;
      void pump(profileId, batchId, expected).catch((error: unknown) => {
        if (!live(profileId, expected)) return;
        const batch = batches.get(key(profileId, batchId));
        if (!batch || batch.status !== 'running') return;
        generations.set(profileId, generation(profileId) + 1);
        const item = batch.items[batch.currentIndex];
        if (item?.chatId && ['starting', 'running'].includes(item.status))
          try {
            assistant.cancel(profileId, item.chatId);
          } catch {
            // Persist the paused generation even if the linked chat is already gone.
          }
        if (item && ['starting', 'running'].includes(item.status)) {
          item.status = 'paused';
          item.reason = 'runner_error';
          item.endedAt = now();
        }
        batch.status = 'paused';
        batch.reason = modelFailure(error) ? 'model_unavailable' : 'runner_error';
        try {
          save(profileId, batch, 'runner-paused');
        } catch {
          // The journal failure is already the authoritative reason work cannot continue.
        }
      });
    }, delay);
    timer.unref?.();
    timers.set(profileId, { timer, batchId });
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
    item.status = status;
    item.reason = reason;
    item.endedAt = now();
    item.proposalIds = intake?.proposals?.map((proposal) => proposal.id) || item.proposalIds;
    item.reading = chat?.reading ? structuredClone(chat.reading) : item.reading;
    batch.currentIndex = Math.min(batch.items.length, batch.currentIndex + 1);
    save(profileId, batch, `item-${status}`);
  }

  function completeIfDone(profileId: string, batch: IntakeBatch): boolean {
    const next = batch.items.findIndex(
      (item, index) => index >= batch.currentIndex && item.status === 'queued',
    );
    if (next >= 0) {
      batch.currentIndex = next;
      return false;
    }
    batch.status = 'complete';
    batch.reason = batch.items.some(hasPausedIntakeReading) ? 'items_paused' : null;
    batch.currentIndex = batch.items.length;
    save(profileId, batch, 'batch-complete');
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
        item.status = 'paused';
        item.reason = 'model_unavailable';
        item.endedAt = now();
        batch.status = 'paused';
        batch.reason = 'model_unavailable';
        save(profileId, batch, 'model-unavailable');
        return false;
      }
      throw error;
    }
    return live(profileId, expected) && batch.status === 'running';
  }

  function startMessage(intake: Intake): string {
    return `Convert the selected delivery ${intake.filename} (${intake.id}) from ${intake.provider} into a reviewable health-record-v1 proposal. Read all its pages or members using host tools, including selected-page PDFs or rendered page images and extracted embedded files where present. Use the original page references in metadata; each supplied PDF contains only its selected original page. Preserve originals, exact values, subject identity, locators and uncertainty. Propose separate clinical mappings for observed labs, medications, procedures and documents. Do not accept/import. Report any unreviewed pages/assets as coverage gaps.`;
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
    item.reading = linkedChat?.reading ? structuredClone(linkedChat.reading) : item.reading;

    // A linked authorized conversion owns the profile's single model slot until
    // it reaches a terminal pass, even if that pass has already retained an
    // early proposal. Observe it instead of declaring the file finished.
    if (linkedChat?.status === 'running') {
      beginReadingSlice(item, now());
      const attached = assistant.attachIntakeReadingRequestGuard(
        profileId,
        linkedChat.id,
        (reading) => readingModelRequestBudgetReached(item, reading, now(), readingLimits),
      );
      if (!attached) {
        finishReadingSlice(item, item.reading, now());
        const current = assistant.get(profileId, linkedChat.id);
        if (current.status !== 'running') {
          item.status = 'queued';
          item.reason = null;
          save(profileId, batch, 'linked-conversion-finished-during-attachment');
          schedule(profileId, batch.id);
          return;
        }
        item.status = 'paused';
        item.reason = 'existing_conversion_paused';
        item.endedAt = now();
        batch.status = 'paused';
        batch.reason = 'existing_conversion_paused';
        save(profileId, batch, 'linked-conversion-guard-unavailable');
        return;
      }
      item.status = 'running';
      item.reason = null;
      item.startedAt ||= now();
      save(profileId, batch, 'attached-running-conversion');
      schedule(profileId, batch.id, pollMs);
      return;
    }
    const retry = retryItems.delete(key(profileId, `${batch.id}/${item.intakeId}`));
    if (intake.state === 'ready' && intake.validation?.valid) {
      finishItem(profileId, batch, item, 'review_ready', 'prepared_jsonl', intake, linkedChat);
      schedule(profileId, batch.id);
      return;
    }
    if (
      !retry &&
      (intake.proposals.length || ['conversion_proposed', 'needs_review'].includes(intake.state))
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
    if (linkedChat && !retry) {
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
      item.status = 'paused';
      item.reason = 'assistant_busy';
      batch.status = 'paused';
      batch.reason = 'assistant_busy';
      save(profileId, batch, 'assistant-busy');
      return;
    }
    intake = getIntake(db, root, profileId, item.intakeId);
    if (intake.sha256 !== item.sourceHash) {
      finishItem(profileId, batch, item, 'paused', 'source_changed', intake, linkedChat);
      schedule(profileId, batch.id);
      return;
    }

    beginReadingSlice(item, now());
    save(profileId, batch, 'reading-slice-started');
    const runOptions: BatchAssistantRunOptions = {
      beforeModelRequest: (reading) =>
        readingModelRequestBudgetReached(item, reading, now(), readingLimits),
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
        item.status = 'paused';
        item.reason = 'model_unavailable';
        batch.status = 'paused';
        batch.reason = 'model_unavailable';
        save(profileId, batch, 'model-unavailable-after-start');
        return;
      }
      if (error instanceof HttpError && error.code === 'ASSISTANT_BUSY') {
        finishReadingSlice(item, item.reading, now());
        item.status = 'paused';
        item.reason = 'assistant_busy';
        batch.status = 'paused';
        batch.reason = 'assistant_busy';
        save(profileId, batch, 'assistant-busy-after-start');
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
      item.reading = chat.reading ? structuredClone(chat.reading) : item.reading;
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
      // Whole-job limits govern the next physical provider request. Do not
      // cancel a request or guarded tool result already admitted by that gate.
      schedule(profileId, batch.id, pollMs);
      return;
    }
    if (!live(profileId, expected)) return;
    const intake = getIntake(dbFor(profileId), root, profileId, item.intakeId) as Intake;
    const madeProgress = finishReadingSlice(item, chat.reading || item.reading, now());
    item.reading = chat.reading ? structuredClone(chat.reading) : item.reading;
    if (intake.sha256 !== item.sourceHash) {
      finishItem(profileId, batch, item, 'paused', 'source_changed', intake, chat);
      schedule(profileId, batch.id);
      return;
    }
    if (chat.status === 'idle' && item.reading?.reason === 'job_limit') {
      finishItem(profileId, batch, item, 'paused', 'job_limit', intake, chat);
      schedule(profileId, batch.id);
      return;
    }
    if (chat.status === 'idle' && canContinueReadingSlice(item.reading, madeProgress)) {
      if (readingBudgetReached(item, now(), readingLimits)) {
        const reading = { ...item.reading!, status: 'paused' as const, reason: 'job_limit' };
        finishItem(profileId, batch, item, 'paused', 'job_limit', intake, { ...chat, reading });
        schedule(profileId, batch.id);
        return;
      }
      item.status = 'queued';
      item.reason = 'continuing';
      item.proposalIds = intake.proposals.map((proposal) => proposal.id);
      retryItems.add(key(profileId, `${batch.id}/${item.intakeId}`));
      save(profileId, batch, 'productive-slice-continued');
      schedule(profileId, batch.id, continuationDelayMs);
      return;
    }
    if (chat.status === 'failed' && modelFailure({ message: chat.error })) {
      item.status = intake.proposals.length ? 'review_ready' : 'paused';
      item.reason = 'model_unavailable';
      item.endedAt = now();
      item.proposalIds = intake.proposals.map((proposal) => proposal.id);
      item.reading = chat.reading ? structuredClone(chat.reading) : item.reading;
      if (item.status === 'review_ready') batch.currentIndex++;
      batch.status = 'paused';
      batch.reason = 'model_unavailable';
      save(profileId, batch, 'model-unavailable-during-conversion');
      return;
    }
    if (intake.proposals.length) {
      finishItem(profileId, batch, item, 'review_ready', 'bounded_pass_ready', intake, chat);
      schedule(profileId, batch.id);
      return;
    }
    finishItem(
      profileId,
      batch,
      item,
      'paused',
      chat.reading?.reason || (chat.status === 'cancelled' ? 'stopped' : 'no_proposal'),
      intake,
      chat,
    );
    schedule(profileId, batch.id);
  }

  async function pump(profileId: string, batchId: string, expected: number): Promise<void> {
    if (!live(profileId, expected)) return;
    const batch = get(profileId, batchId);
    if (batch.status !== 'running') return;
    const item = batch.items[batch.currentIndex];
    if (!item) {
      completeIfDone(profileId, batch);
      return;
    }
    if (item.status === 'running') {
      await inspectRunning(profileId, batch, item, expected);
      return;
    }
    if (item.status !== 'queued') {
      batch.currentIndex++;
      if (!completeIfDone(profileId, batch)) schedule(profileId, batch.id);
      return;
    }
    await beginItem(profileId, batch, item, expected);
  }

  function create(profileId: string, input: Partial<CreateIntakeBatchInput> | null): IntakeBatch {
    dbFor(profileId);
    loadProfile(profileId);
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
          batch.appendOperations?.some((operation) => operation.operationId === operationId)),
    );
    if (existing) {
      const appended = existing.appendOperations || [];
      const originalCount =
        existing.items.length -
        appended.reduce((sum, operation) => sum + operation.intakeIds.length, 0);
      const selection =
        existing.operationId === operationId
          ? existing.items.slice(0, originalCount).map((item) => item.intakeId)
          : appended.find((operation) => operation.operationId === operationId)!.intakeIds;
      if (
        selection.length !== intakeIds.length ||
        selection.some((id, index) => id !== intakeIds[index])
      )
        throw new HttpError(
          409,
          'INTAKE_BATCH_OPERATION',
          'This operation ID already belongs to a different selection',
        );
      return publicBatch(existing);
    }
    const running = [...batches.values()].find(
      (batch) => batch.profileId === profileId && batch.status === 'running',
    );
    if (running && input.appendToRunning !== true)
      throw new HttpError(409, 'INTAKE_BATCH_BUSY', 'A reading batch is already running');
    if (
      running &&
      (running.items.length + intakeIds.length > 100 ||
        intakeIds.some((id) => running.items.some((item) => item.intakeId === id)))
    )
      throw new HttpError(
        400,
        'INTAKE_BATCH_SELECTION',
        'Keep at most 100 distinct originals in one reading batch; an original already queued cannot be added twice',
      );
    const db = dbFor(profileId);
    const items: IntakeBatchItem[] = intakeIds.map((intakeId) => {
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
      const snapshot: IntakeBatch = {
        ...structuredClone(running),
        updatedAt: at,
        items: [...structuredClone(running.items), ...items],
        appendOperations: [
          ...(running.appendOperations || []),
          { operationId, intakeIds: [...intakeIds], at },
        ],
      };
      const applyAppend = () => {
        // The asynchronous runner may hold this batch and its current item across
        // await. Preserve those object identities so its next save includes the append.
        running.items.push(...items);
        running.appendOperations = snapshot.appendOperations;
        running.updatedAt = at;
        observeQueues(profileId, running);
      };
      try {
        journalWriter(root, profileId, snapshot, 'originals-appended');
      } catch (error) {
        // A publication may have completed before acknowledgement failed. Keep the
        // receipt in the live batch so its active runner cannot overwrite durable additions.
        // The caller still receives the failure and must retry the same operation.
        try {
          const retained = readIntakeBatch(root, profileId, running.id);
          const receipt = retained.appendOperations?.find(
            (entry) => entry.operationId === operationId,
          );
          if (receipt && JSON.stringify(receipt.intakeIds) === JSON.stringify(intakeIds))
            applyAppend();
        } catch {
          // No confirmed journal head: new work remains unqueued in memory.
        }
        throw error;
      }
      applyAppend();
      return publicBatch(running);
    }
    const batch: IntakeBatch = {
      id: randomUUID(),
      profileId,
      operationId,
      status: 'running',
      reason: null,
      currentIndex: 0,
      createdAt: at,
      updatedAt: at,
      items,
    };
    save(profileId, batch, 'created');
    schedule(profileId, batch.id);
    return publicBatch(batch);
  }

  function list(profileId: string): IntakeBatch[] {
    dbFor(profileId);
    loadProfile(profileId);
    return [...batches.values()]
      .filter((batch) => batch.profileId === profileId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(publicBatch);
  }

  function stop(profileId: string, batchId: string): IntakeBatch {
    const batch = get(profileId, batchId);
    if (batch.status !== 'running') {
      if (batch.status !== 'stopped') {
        const item = batch.items[batch.currentIndex];
        if (item && ['queued', 'starting', 'paused'].includes(item.status)) {
          finishReadingSlice(item, item.reading, now());
          item.status = 'paused';
          item.reason = 'stopped';
          item.endedAt ||= now();
        }
        batch.status = 'stopped';
        batch.reason = 'stopped';
        save(profileId, batch, 'stopped');
      }
      return publicBatch(batch);
    }
    clear(profileId, batch.id);
    generations.set(profileId, generation(profileId) + 1);
    const item = batch.items[batch.currentIndex];
    if (item?.chatId && item.status === 'running') assistant.cancel(profileId, item.chatId);
    if (item && ['queued', 'starting', 'running'].includes(item.status)) {
      finishReadingSlice(item, item.reading, now());
      item.status = 'paused';
      item.reason = 'stopped';
      item.endedAt = now();
    }
    batch.status = 'stopped';
    batch.reason = 'stopped';
    save(profileId, batch, 'stopped');
    return publicBatch(batch);
  }

  function resume(profileId: string, batchId: string): IntakeBatch {
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
      (item, itemIndex) =>
        itemIndex >= Math.min(batch.currentIndex, batch.items.length - 1) &&
        (hasPausedIntakeReading(item) || item.status === 'queued'),
    );
    if (index < 0) index = batch.items.findIndex(hasPausedIntakeReading);
    if (index < 0)
      throw new HttpError(409, 'INTAKE_BATCH_RESUME', 'No paused delivery needs another pass');
    const item = batch.items[index];
    if (hasPausedIntakeReading(item)) {
      if (item.reason === 'job_limit' || item.reading?.reason === 'job_limit')
        extendReadingBudget(item);
      item.status = 'queued';
      item.reason = null;
      item.endedAt = null;
      if (item.chatId) retryItems.add(key(profileId, `${batch.id}/${item.intakeId}`));
    }
    batch.currentIndex = index;
    batch.status = 'running';
    batch.reason = null;
    for (const queued of batch.items) if (queued.status === 'queued') queued.queuedAt = now();
    generations.set(profileId, generation(profileId) + 1);
    save(profileId, batch, 'resumed');
    schedule(profileId, batch.id);
    return publicBatch(batch);
  }

  function close(reason = 'interrupted'): void {
    if (closed) return;
    closed = true;
    for (const profileId of databases.keys()) {
      clear(profileId);
      generations.set(profileId, generation(profileId) + 1);
      loadProfile(profileId);
      for (const batch of batches.values()) {
        if (batch.profileId !== profileId || batch.status !== 'running') continue;
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
    }
  }

  // Recreated applications never leave a durable "running" claim behind and
  // never start model work until the user explicitly resumes the paused batch.
  for (const profileId of databases.keys()) loadProfile(profileId);

  return {
    create,
    list,
    get: (profileId: string, id: string) => publicBatch(get(profileId, id)),
    stop,
    resume,
    close,
    isBusy(profileId: string): boolean {
      loadProfile(profileId);
      return [...batches.values()].some(
        (batch) => batch.profileId === profileId && batch.status === 'running',
      );
    },
  };
}
