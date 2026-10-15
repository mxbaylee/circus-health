const LABELS = [
  'move.enter',
  'move.before-review-start',
  'move.before-review-done',
  'move.before-review-refused',
  'move.action-start',
  'move.action-done',
  'before-review.enter',
  'before-review.pending-draft',
  'before-review.close-start',
  'before-review.close-done',
  'perform.enter',
  'perform.refused',
  'perform.admitted',
  'perform.busy.true',
  'perform.busy.false',
  'perform.acceptance-busy.true',
  'perform.acceptance-busy.false',
  'perform.recovering.true',
  'perform.recovering.false',
  'perform.receipt-pending.true',
  'perform.receipt-pending.false',
  'people.fresh.start',
  'people.fresh.api-returned',
  'people.fresh.found',
  'people.fresh.next-page',
  'people.fresh.missing',
  'people.apply.start',
  'people.read.fetch-start',
  'people.read.headers',
  'people.read.body',
  'people.read.response',
  'people.read.subscriber',
  'people.read.clone-start',
  'people.read.clone-done',
  'people.read.clone-throw',
  'people.read.failed',
  'people.api.decode-start',
  'people.api.decode-done',
  'collection.people.refused',
  'collection.people.unlisted',
  'bulk.people.queued-refused',
  'bulk.people.running-refused',
  'bulk.people.enter',
  'bulk.people.preflight-await',
  'bulk.people.preflight-done',
  'bulk.people.scope-mismatch',
  'bulk.people.command-ready',
  'bulk.people.post-start',
  'bulk.people.failed-before-write',
  'bulk.people.failed-unconfirmed',
  'bulk.people.failed-definite',
  'bulk.people.finally',
  'read.capacity-refused',
  'telemetry.fetch-start',
  'telemetry.headers',
  'telemetry.abort',
  'telemetry.failed',
  'telemetry.settled',
  'browser.unhandled-rejection',
] as const;

/** Every label the client may emit; the fixture accepts exactly this list. */
export const HOLDOUT_STAGES: readonly string[] = LABELS;
export type HoldoutStage = (typeof LABELS)[number];
export interface HoldoutPeopleGate {
  busy: boolean;
  saving: boolean;
  acceptanceBusy: boolean;
  acceptanceRecovering: boolean;
  acceptanceReceiptPending: boolean;
  bulkBusy: boolean;
  bulkPending: boolean;
  repairPending: boolean;
  sourcePending: boolean;
  pendingSources: boolean;
  lastBeforeCloseAllowed: boolean | null;
  pageLoading: boolean;
  pageRefreshing: boolean;
  pageError: boolean;
  firstPageRefreshing: boolean;
  firstPageError: boolean;
  initialPageChanged: boolean;
  peopleLoading: boolean;
  peopleRefreshing: boolean;
  peopleError: boolean;
}
export const HOLDOUT_TRACE_LIMIT = 96;
const allowed = new Set<string>(LABELS);

/** The fictional browser fixture alone installs this sink; labels carry no request data. */
export function holdoutTrace(stage: HoldoutStage): void {
  const sink = (
    globalThis as typeof globalThis & {
      __CRS_HOLDOUT_TRACE__?: { enabled: boolean; stages: string[] };
    }
  ).__CRS_HOLDOUT_TRACE__;
  if (!sink?.enabled || !Array.isArray(sink.stages) || !allowed.has(stage)) return;
  sink.stages.push(stage);
  if (sink.stages.length > HOLDOUT_TRACE_LIMIT)
    sink.stages.splice(0, sink.stages.length - HOLDOUT_TRACE_LIMIT);
}

/** Fixed booleans only; the fictional holdout fixture owns the optional sink. */
export function holdoutPeopleGate(gate: HoldoutPeopleGate): void {
  const sink = (
    globalThis as typeof globalThis & {
      __CRS_HOLDOUT_TRACE__?: {
        enabled: boolean;
        peopleGate?: HoldoutPeopleGate;
      };
    }
  ).__CRS_HOLDOUT_TRACE__;
  if (sink?.enabled) {
    sink.peopleGate = fixedHoldoutPeopleGate(gate);
    const bridge = (
      globalThis as typeof globalThis & {
        __CRS_HOLDOUT_GATE_BRIDGE__?: (gate: HoldoutPeopleGate) => Promise<void>;
      }
    ).__CRS_HOLDOUT_GATE_BRIDGE__;
    if (bridge) {
      try {
        void bridge(sink.peopleGate).catch(() => {});
      } catch {
        // Diagnostic teardown must not affect the import action.
      }
    }
  }
}

export function fixedHoldoutPeopleGate(gate: HoldoutPeopleGate): HoldoutPeopleGate {
  return {
    busy: gate.busy === true,
    saving: gate.saving === true,
    acceptanceBusy: gate.acceptanceBusy === true,
    acceptanceRecovering: gate.acceptanceRecovering === true,
    acceptanceReceiptPending: gate.acceptanceReceiptPending === true,
    bulkBusy: gate.bulkBusy === true,
    bulkPending: gate.bulkPending === true,
    repairPending: gate.repairPending === true,
    sourcePending: gate.sourcePending === true,
    pendingSources: gate.pendingSources === true,
    lastBeforeCloseAllowed:
      gate.lastBeforeCloseAllowed === null ? null : gate.lastBeforeCloseAllowed === true,
    pageLoading: gate.pageLoading === true,
    pageRefreshing: gate.pageRefreshing === true,
    pageError: gate.pageError === true,
    firstPageRefreshing: gate.firstPageRefreshing === true,
    firstPageError: gate.firstPageError === true,
    initialPageChanged: gate.initialPageChanged === true,
    peopleLoading: gate.peopleLoading === true,
    peopleRefreshing: gate.peopleRefreshing === true,
    peopleError: gate.peopleError === true,
  };
}
