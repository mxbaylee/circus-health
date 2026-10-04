import type { NativeAssistantSourceHeader } from './assistant-intake-header.ts';
import { openIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
/** Native assistant conversion state contains selected scopes and scalar ledger
 * references. It never represents unloaded workflow arrays as empty. */
import type { Database } from './database.ts';
import { HttpError } from './database.ts';
import type { IntakeSummaryV2 } from '../shared/intake-summary.ts';
import type { IntakeBatchReadingState } from '../shared/intake-batch.ts';
import type { IntakeExtractionCoverage } from '../shared/intake.ts';
import {
  openCollectionConversion,
  createCollectionCheckpoint,
  collectionConversionResumeContext,
  assertCollectionConversionCoverage,
  type CollectionConversionCheckpoint,
  type CollectionConversionScope,
} from './intake-continuation-collection.ts';
import { readPackagePlanScope } from './intake-package-plan.ts';
import { prepareRetainedPlanAccess, readRetainedIntakeUnitScope } from './intake-retained-plan.ts';
import { intakeFilenameDisplay } from '../shared/intake-summary.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import { preparePagedPackagePlanCompatibility } from './intake-package-plan.ts';
import {
  nativeAttributionReference,
  type NativeAttributionReference,
} from './assistant-intake-attribution.ts';

export interface NativeAssistantCheckpoint extends CollectionConversionCheckpoint {
  attribution?: NativeAttributionReference;
  contextTier?: number;
  initialContextFailures?: number;
  /** Presentation timing is fixed-size metadata, independent of retained reads. */
  pageTiming?: {
    turn: number;
    lastCompletedAt: string | null;
    recentIntervalsMs: number[];
    lastReadMs: number | null;
  };
}
export interface NativeAssistantConversion {
  format: 'health-intake-assistant-conversion-v2';
  db: Database;
  root: string;
  profileId: string;
  sessionId: string;
  header: IntakeSummaryV2 | NativeAssistantSourceHeader;
  id: string;
  sha256: string;
  version: number;
  providerId: string;
  candidateCount: number;
  durability: IntakeSummaryV2['durability'];
}
export function isNativeAssistantCheckpoint(value: unknown): value is NativeAssistantCheckpoint {
  return (
    !!value &&
    typeof value === 'object' &&
    'format' in value &&
    value.format === 'health-intake-conversion-checkpoint-v2'
  );
}
export function isNativeAssistantConversion(value: unknown): value is NativeAssistantConversion {
  return (
    !!value &&
    typeof value === 'object' &&
    'format' in value &&
    value.format === 'health-intake-assistant-conversion-v2'
  );
}
export function nativeAssistantConversion(
  db: Database,
  root: string,
  profileId: string,
  sessionId: string,
  header: IntakeSummaryV2 | NativeAssistantSourceHeader,
): NativeAssistantConversion {
  if (
    header.format !== 'health-intake-summary-v2' &&
    header.format !== 'health-intake-assistant-source-v1'
  )
    throw new HttpError(
      409,
      'CONVERSION_SOURCE_UNAVAILABLE',
      'The conversion source is unavailable',
    );
  return {
    format: 'health-intake-assistant-conversion-v2',
    db,
    root,
    profileId,
    sessionId,
    header,
    id: header.id,
    sha256: header.sha256,
    version: header.version,
    providerId: header.providerId,
    candidateCount:
      header.format === 'health-intake-summary-v2'
        ? header.collections.candidates.total
        : header.candidateCount,
    durability: header.durability,
  };
}
export async function prepareNativeAssistantConversion(
  host: NativeAssistantConversion,
  options: {
    mappingVersion: string;
    currentMappingVersion?: () => string;
    assertRunning?: () => void;
  },
) {
  if (
    host.header.activePlan.state === 'exact' &&
    host.header.activePlan.plan?.format === 'health-intake-package-plan-v2'
  )
    await preparePagedPackagePlanCompatibility(host.db, host.root, host.profileId, host.id, {
      assertRunning: options.assertRunning,
    });
  await prepareRetainedPlanAccess(host.db, host.profileId, host.id, {
    assertRunning: options.assertRunning,
  });
  return prepareCollectionWorkflowReadiness(host.db, host.root, host.profileId, host.id, options);
}
/** Bounded unit metadata and addressed page membership; never expands retained page arrays. */
export function nativeAssistantUnit(host: NativeAssistantConversion, unitId?: string) {
  const selectedId = unitId ?? nativeAssistantScope(host)?.unitId;
  if (!selectedId) return undefined;
  const native =
    host.header.activePlan.state === 'exact' &&
    host.header.activePlan.plan?.format === 'health-intake-package-plan-v2'
      ? readPackagePlanScope(host.db, host.root, host.profileId, host.id)?.unitById(selectedId)
      : undefined;
  if (native)
    return {
      ...native,
      pageScope: native.pages
        ? {
            count: native.pages.length,
            first: native.pages[0],
            includes: (n: number) => native.pages!.includes(n),
          }
        : undefined,
    };
  const selected = readRetainedIntakeUnitScope(
    host.db,
    host.root,
    host.profileId,
    host.id,
    selectedId,
  );
  if (selected.format === 'native' || selected.format === 'direct') {
    const unit = selected.unit;
    return {
      ...unit,
      pageScope: unit.pages
        ? {
            count: unit.pages.length,
            first: unit.pages[0],
            includes: (n: number) => unit.pages!.includes(n),
          }
        : undefined,
    };
  }
  const { unit } = selected;
  const field = <T>(name: string): T | undefined => {
    const value = unit.reader.field(unit.record, name, { bytes: 8192 });
    if (value.kind === 'missing') return undefined;
    if (value.kind !== 'value') throw new Error('Unit identity requires bounded selected metadata');
    return value.value as T;
  };
  const locator = unit.reader.field(unit.record, 'locator', { bytes: 2000 });
  return {
    id: unit.id,
    kind: unit.kind,
    status: unit.status,
    attemptCount: unit.attemptCount,
    processingException: unit.processingException,
    sourceFileId: field<string>('sourceFileId'),
    memberId: field<string>('memberId'),
    sourceHash: field<string>('sourceHash'),
    start: field<number>('start'),
    end: field<number>('end'),
    locator:
      locator.kind === 'value' && typeof locator.value === 'string' ? locator.value : unit.id,
    pageScope: unit.pages.count
      ? {
          count: unit.pages.count,
          first: unit.pages.pageAt(0),
          includes: (n: number) => unit.pages.pageOrdinal(n) !== undefined,
        }
      : undefined,
  };
}
export function nativeAssistantScope(
  host: NativeAssistantConversion,
  unitId?: string,
): CollectionConversionScope | undefined {
  return openCollectionConversion(host.db, host.root, host.profileId, host.id, {
    sessionId: host.sessionId,
    unitId,
  });
}
export function nativeAssistantCheckpoint(
  host: NativeAssistantConversion,
  previous?: NativeAssistantCheckpoint,
  options: { nextUnit?: boolean; unitId?: string } = {},
): NativeAssistantCheckpoint | undefined {
  if (
    previous &&
    (previous.profileId !== host.profileId ||
      previous.intakeId !== host.id ||
      previous.sourceHash !== host.sha256 ||
      previous.sessionId !== host.sessionId)
  )
    throw new HttpError(
      409,
      'CONVERSION_CHANGED',
      'The selected conversion checkpoint belongs to different source evidence',
    );
  const scope = nativeAssistantScope(
    host,
    options.unitId ?? (options.nextUnit ? undefined : previous?.activeUnitId),
  );
  if (!scope) return previous;
  if (
    previous &&
    previous.planId === scope.planId &&
    previous.inventoryId === scope.inventoryId &&
    previous.activeUnitId === scope.unitId &&
    previous.ledgerId === scope.ledgerId
  ) {
    previous.version = scope.version;
    return previous;
  }
  const checkpoint: NativeAssistantCheckpoint = {
    ...createCollectionCheckpoint(scope),
    attribution: nativeAttributionReference(host),
  };
  if (previous)
    Object.assign(checkpoint, {
      turns: previous.turns,
      modelRequests: previous.modelRequests,
      measuredModelTokens: previous.measuredModelTokens,
      modelUsageIncomplete: previous.modelUsageIncomplete,
      unmeasuredRequests: previous.unmeasuredRequests,
      usableModelResponses: previous.usableModelResponses,
      contextTier: previous.contextTier,
      initialContextFailures: previous.initialContextFailures,
      pageTiming: previous.pageTiming,
      attribution: previous.attribution ?? nativeAttributionReference(host, previous.turns > 0),
    });
  if (previous) {
    Object.assign(previous, checkpoint);
    return previous;
  }
  return checkpoint;
}
export function nativeAssistantResume(
  host: NativeAssistantConversion,
  checkpoint: NativeAssistantCheckpoint,
  mappingVersion: string,
) {
  const scope = nativeAssistantScope(host, checkpoint.activeUnitId);
  if (!scope)
    throw new HttpError(409, 'CONVERSION_CHANGED', 'The selected conversion unit is unavailable');
  return collectionConversionResumeContext(scope, checkpoint, { mappingVersion });
}
export function nativeAssistantReadingState(
  host: NativeAssistantConversion,
  checkpoint: NativeAssistantCheckpoint,
  mappingVersion: string,
  reason: string | null = null,
): IntakeBatchReadingState {
  return nativeAssistantReadingProgress(host, checkpoint, mappingVersion, reason).reading;
}
/** One synchronous projection supplies the continuation and progress counters.
 * Callers must rebuild it after a write or an asynchronous boundary. */
export function nativeAssistantReadingProgress(
  host: NativeAssistantConversion,
  checkpoint: NativeAssistantCheckpoint,
  mappingVersion: string,
  reason: string | null = null,
) {
  const resume = nativeAssistantResume(host, checkpoint, mappingVersion),
    unit = nativeAssistantUnit(host),
    ready = resume.workflow.state === 'exact' && resume.readingFacts.state === 'exact',
    selectedReason = reason || (ready ? null : 'workflow_preparation_required'),
    timing = checkpoint.pageTiming?.turn === checkpoint.turns ? checkpoint.pageTiming : undefined;
  const reading: IntakeBatchReadingState = {
    workUnit: unit ? { id: unit.id, locator: unit.locator?.slice(0, 2000) || unit.id } : null,
    status: selectedReason ? 'paused' : 'running',
    reason: selectedReason,
    turns: checkpoint.turns,
    modelRequests: checkpoint.modelRequests,
    usableModelResponses: checkpoint.usableModelResponses,
    measuredModelTokens: checkpoint.measuredModelTokens,
    modelUsageIncomplete: checkpoint.modelUsageIncomplete || !!checkpoint.unmeasuredRequests,
    readyRecords: resume.retainedCandidateCount,
    ...(resume.readingFacts.state === 'exact'
      ? {
          substantiveVersions: resume.readingFacts.substantiveVersions,
          proposalsProduced: resume.readingFacts.proposalsProduced,
        }
      : {}),
    remainingUnits: resume.reading.remainingUnits,
    pendingReadWindows: resume.reading.pendingReadWindows,
    readWindows: resume.reading.readWindows,
    accountedUnits: resume.reading.accountedUnits,
    totalUnits: resume.reading.totalUnits,
    distinctReads: resume.reading.distinctReads,
    phase: 'waiting_for_model',
    coverage: 'reading_progress_only',
    pageTiming: {
      turn: checkpoint.turns,
      lastCompletedAt: timing?.lastCompletedAt ?? null,
      lastReadMs: timing?.lastReadMs ?? null,
      recentIntervalMs: timing?.recentIntervalsMs.length
        ? timing.recentIntervalsMs.reduce((a, b) => a + b, 0) / timing.recentIntervalsMs.length
        : null,
      intervalSamples: timing?.recentIntervalsMs.length ?? 0,
    },
  };
  return { resume, reading };
}
export function assertNativeAssistantCoverage(
  host: NativeAssistantConversion,
  checkpoint: NativeAssistantCheckpoint,
  input: { planId: string; coverage: readonly IntakeExtractionCoverage[] },
  automatic: boolean,
) {
  if (input.coverage.length > 50)
    throw new HttpError(
      400,
      'BATCH_COVERAGE',
      'Use at most fifty explicitly selected unit ledgers',
    );
  if (automatic && input.coverage.some((item) => item.unitId !== checkpoint.activeUnitId))
    throw new HttpError(
      409,
      'INTAKE_WORK_UNIT_SCOPE',
      'Publish only the current dispatched source unit',
    );
  const scopes: CollectionConversionScope[] = [];
  for (const item of input.coverage) {
    if (scopes.some((scope) => scope.unitId === item.unitId)) continue;
    const scope = nativeAssistantScope(host, item.unitId);
    if (!scope)
      throw new HttpError(
        409,
        'CONVERSION_COVERAGE_PENDING',
        'The selected unit ledger is unavailable',
      );
    scopes.push(scope);
  }
  assertCollectionConversionCoverage(scopes, input);
}
export const nativeAssistantFilename = (host: NativeAssistantConversion) =>
  intakeFilenameDisplay(host.header);

export function recordNativeAssistantPageTiming(
  checkpoint: NativeAssistantCheckpoint,
  at: string,
  durationMs: number,
) {
  if (!Number.isFinite(Date.parse(at)) || !Number.isFinite(durationMs) || durationMs < 0) return;
  const timing =
    checkpoint.pageTiming?.turn === checkpoint.turns
      ? checkpoint.pageTiming
      : { turn: checkpoint.turns, lastCompletedAt: null, recentIntervalsMs: [], lastReadMs: null };
  if (timing.lastCompletedAt) {
    const interval = Date.parse(at) - Date.parse(timing.lastCompletedAt);
    if (interval >= 0) timing.recentIntervalsMs = [...timing.recentIntervalsMs, interval].slice(-5);
  }
  timing.lastCompletedAt = at;
  timing.lastReadMs = durationMs;
  checkpoint.pageTiming = timing;
}

/** Exact owned append counts plus addressed operation membership. Accepted-status
 * changes, replay and inspected-only receipts do not replenish stale budgets. */
export function nativeAssistantBatchProgress(
  host: NativeAssistantConversion,
  checkpoint: NativeAssistantCheckpoint,
  operationId: unknown,
  mappingVersion: string,
) {
  if (typeof operationId !== 'string') return undefined;
  const resume = nativeAssistantResume(host, checkpoint, mappingVersion);
  if (resume.readingFacts.state !== 'exact') return undefined;
  const view = openIntakeCollectionEnvelope(host.db, { id: host.id }),
    intake = view.child(view.root(), 'intake'),
    flow = intake && view.child(intake, 'workflow');
  return {
    versions: resume.readingFacts.candidateVersionCount,
    accounted: resume.reading.accountedUnits,
    recorded: !!flow && !!view.find('operation', flow, operationId),
  };
}
