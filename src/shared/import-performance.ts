/** Content-free, bounded browser timings. These are observations, never acceptance authority. */
export const clientOperationKinds = [
  'upload',
  'review_open',
  'review_save',
  'review_action',
] as const;
export const clientPerformancePhases = [
  'api_wait',
  'response_decode',
  'upload_transfer',
  'render_wait',
  'action_work',
] as const;
export type PerformanceOutcome = 'completed' | 'failed' | 'cancelled';
export interface ClientOperationSummary {
  operationId: string;
  kind: (typeof clientOperationKinds)[number];
  outcome: PerformanceOutcome;
  durationMs: number;
  requestIds?: string[];
  phases?: Array<{
    phase: (typeof clientPerformancePhases)[number];
    startMs: number;
    durationMs: number;
  }>;
  counts?: {
    files?: number;
    bytes?: number;
    rows?: number;
    selected?: number;
    actions?: number;
    retries?: number;
  };
  visibility?: 'visible' | 'hidden' | 'mixed';
  /** Two animation frames are a paint opportunity, not proof of pixels on screen. */
  renderObservation?: 'two_frames' | 'timeout';
  truncated?: boolean;
}
export interface RecentOperationTimeline {
  operationId: string;
  context: Record<string, string>;
  relatedImportIds: string[];
  relatedImportIdsTruncated: boolean;
  startedAt: string;
  lastProgressAt: string;
  elapsedWallMs: number;
  progressAgeMs: number;
  status: 'active' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  currentStage: string | null;
  /** Independent open-span tracking was unavailable in an older summary or exceeded its bound. */
  lifecycleIncomplete: boolean;
  spans: Array<{
    phase: string;
    spanId?: string;
    parentSpanId?: string;
    startMs: number;
    durationMs: number | null;
    outcome: string;
    fields: Record<string, string | number | boolean | null>;
  }>;
  client?: ClientOperationSummary;
  /** Union of complete server span intervals; nested/overlapping durations are not added. */
  measuredServerMs: number;
  /** Includes scheduling, omitted detail and other unknown time; never labelled as network/model time. */
  unattributedServerMs: number;
  droppedEvents: number;
  /** Inclusive observed spans; totals may overlap and must never be summed as elapsed time. */
  phaseTotals: Array<{
    phase: string;
    count: number;
    totalMs: number;
    maxMs: number;
    failed: number;
    cancelled: number;
  }>;
  phaseTotalsTruncated: boolean;
  /** Zero means unsampled; null means legacy sampling history is unknown. */
  resourceSampleCount: number | null;
  /** Observations of a post-read worker RSS sample, not distinct reads or a true worker peak. */
  pdfWorkerSampleCount: number | null;
  resourcePeak: {
    rssBytes: number;
    cpuPercent: number;
    eventLoopMaxMs: number;
    activeScopes: number;
    pdfWorkerRssSampleBytes: number;
    runtimeAvailableBytes: number | null;
    tempAvailableBytes: number | null;
  };
}
