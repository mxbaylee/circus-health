export interface IntakeProviderWait {
  requestId: string;
  outcome: 'rejected' | 'unknown';
  classification:
    | 'quota'
    | 'transient'
    | 'authentication'
    | 'context_limit'
    | 'unsupported'
    | 'invalid_request'
    | 'unknown';
  /** Absolute provider/server wait, persisted before scheduling. Retained across coordinator recovery. */
  retryAt: string | null;
}
export interface IntakeModelAttempt {
  requestFit?: {
    policy: 'proxy-byte-envelope-v1';
    qualified: false;
    textCharacters: number;
    mediaBytes: number;
    maxTextCharacters: number;
    maxMediaBytes: number;
    inputTokens: null;
    outputReserveTokens: null;
    maxResponseBytes: number;
  };
  requestId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'dispatched' | 'response' | 'rejected' | 'unknown';
  classification: IntakeProviderWait['classification'] | null;
  status: number | null;
  retryAt: string | null;
  requestDigest: string;
  requestBytes: number;
  model: string;
  usage: Record<string, number | null> | null;
}
export interface IntakeBatchReadingState {
  usableModelResponses?: number;
  providerWait?: IntakeProviderWait | null;
  workUnit?: { id: string; locator: string } | null;
  status: 'running' | 'paused';
  reason: string | null;
  turns: number;
  modelRequests?: number;
  measuredModelTokens?: number;
  modelUsageIncomplete?: boolean;
  readyRecords: number;
  substantiveVersions?: number;
  remainingUnits: number;
  pendingReadWindows: number;
  /** Unique retained read windows, not a claim that every clinical record was extracted. */
  readWindows?: number;
  accountedUnits?: number;
  totalUnits?: number;
  /**
   * Read windows the model actually read, counted once each: a re-read of an
   * already-seen window is not counted again. Contrast `readWindows`, which counts
   * every window marked seen — including children satisfied by inference from a
   * JSON structure read, which are never read individually. The two are equal only
   * for plain paginated sources; one JSON structure read can add many `readWindows`
   * and exactly one `distinctReads`. A package *inventory* read adds exactly one of
   * each — its members are enqueued as pending, not marked seen — so the divergence is
   * the JSON path specifically, including a package member whose content is JSON.
   */
  distinctReads?: number;
  /**
   * Extraction batches submitted across *every* plan of this conversion, summed from
   * each plan's `batches` — replay-proof, since a re-submitted batch with a matching
   * operationId does not add a `plan.batches` entry. Summed over all plans rather
   * than the active one so this counter is conversion-scoped like `distinctReads`,
   * which rides the never-reset checkpoint: a superseded plan's proposals stay
   * counted because the reads they came from stay counted too.
   */
  proposalsProduced?: number;
  phase?: 'waiting_for_model' | 'indexing_source' | 'reading_source' | 'preparing_results';
  /** Host-observed page work; intervals include intervening model/tool work, never an ETA. */
  pageTiming?: {
    turn: number;
    lastCompletedAt: string | null;
    recentIntervalMs: number | null;
    intervalSamples: number;
    lastReadMs: number | null;
  };
  coverage: 'reading_progress_only';
}

export type IntakeBatchStatus = 'running' | 'paused' | 'stopped' | 'complete';
export type IntakeBatchItemStatus =
  'queued' | 'starting' | 'running' | 'review_ready' | 'skipped' | 'paused';

export interface IntakeBatchItem {
  automaticRun?: boolean;
  /** Intent revoked by Stop, restored only by explicit batch Resume. */
  resumeAutomaticRun?: boolean;
  retryAt?: string | null;
  modelRetryAttempts?: number;
  sourceRetryAttempts?: number;
  sourceRetryUnit?: string;
  exceptionEpoch?: number;
  /** Wait for changed configuration or a successful connection check before retrying rejected input. */
  prerequisiteKey?: string;
  stalls?: { unitId: string; locator: string; attempts: number };
  exceptions?: {
    unitId: string;
    locator: string;
    reason: 'processing_stalled' | 'technical_error';
    reasonCode?: string;
  }[];
  intakeId: string;
  sourceHash: string;
  filename: string;
  mimeType: string;
  status: IntakeBatchItemStatus;
  reason: string | null;
  chatId: string | null;
  proposalIds: string[];
  /** Explicit Resume asks for another model pass despite already reviewable work. */
  forceModelResume?: boolean;
  reading: IntakeBatchReadingState | null;
  /** Durable local extraction checkpoint; historical allowance fields remain decodable. */
  sourceExtraction?: {
    progress?: number;
    lastProgressAt?: string;
    stalls?: number;
    unitPage?: number;
    steps: number;
    /** Cumulative capture steps already followed by a completed model pass. */
    stepsAtModelPass?: number;
    spentMs: number;
    allowanceId: string;
    stepsAtAllowance: number;
    spentMsAtAllowance: number;
    operationId: string | null;
    expectedRevisionId: string | null;
    startedAt: string | null;
    initialDone: boolean;
    draining: boolean;
  };
  startedAt: string | null;
  endedAt: string | null;
  /** Diagnostics only. Reset on explicit resume so user pauses are not queue delay. */
  queuedAt?: string | null;
  /** Cumulative work survives automatic slices and explicit budget extensions. */
  readingJob?: {
    /** Legacy saved jobs remain cumulative. New production jobs use progress windows. */
    limitPolicy?: 'cumulative' | 'progress-window';
    limits?: {
      activeMs: number;
      slices: number;
      turns: number;
      requests?: number;
      measuredTokens?: number;
    };
    progressWindows?: number;
    slices: number;
    activeMs: number;
    sliceStartedAt: string | null;
    lastProgressAt: string | null;
    baseline: { records: number; windows: number; accounted: number };
    observed?: { records: number; windows: number; accounted: number };
    budgetAtSlices: number;
    budgetAtActiveMs: number;
    budgetAtTurns: number;
    budgetAtRequests?: number;
    budgetAtResponses?: number;
    budgetAtTokens?: number;
    extensions: number;
  };
  providerWait?: IntakeProviderWait & {
    attempts: number;
    lastWaitAt: string;
    responsesAtWait?: number;
  };
}

export interface IntakeBatch {
  /** Response-only signal for create: this request scheduled new reading work. */
  scheduled?: boolean;
  id: string;
  profileId: string;
  operationId: string;
  status: IntakeBatchStatus;
  reason: string | null;
  currentIndex: number;
  createdAt: string;
  updatedAt: string;
  items: IntakeBatchItem[];
  /** Durable exact selections added after initial creation, for idempotent upload retries. */
  automaticRun?: boolean;
  selectionIntakeIds?: string[];
  appendOperations?: {
    operationId: string;
    intakeIds: string[];
    selectionIntakeIds?: string[];
    at: string;
  }[];
  /** Exact new-operation selections that reopened already owned evidence. */
  reopenOperations?: { operationId: string; intakeIds: string[]; at: string }[];
}

export interface CreateIntakeBatchInput {
  operationId: string;
  intakeIds: string[];
  /** Explicitly queue new originals on this profile's current running batch when one exists. */
  appendToRunning?: boolean;
}

// A proposal can be ready while its source still needs another reading pass.
// Exhausted read windows are not a resumable pause or proof of extraction quality.
export function hasPausedIntakeReading(item: IntakeBatchItem): boolean {
  return (
    item.reason === 'stopped' ||
    item.status === 'paused' ||
    (item.status === 'review_ready' &&
      ((item.reading?.status === 'paused' && item.reading.reason !== 'reading_exhausted') ||
        item.reason === 'model_unavailable'))
  );
}
