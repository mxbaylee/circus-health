import { createHash } from 'node:crypto';
import { HttpError } from './database.ts';
import { accountedUnitKind } from './intake-unit-accounting.ts';
import type { Intake, IntakeExtractionCoverage } from '../shared/intake.ts';
import type { IntakeBatchReadingState } from '../shared/intake-batch.ts';
import { ensureIntakeAttribution, type IntakeAttribution } from './intake-attribution.ts';

export type IntakeWithWorkflow = Intake & { workflow: NonNullable<Intake['workflow']> };

const MODEL_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

interface ReadArgs extends Record<string, unknown> {
  id?: string;
  action?: string;
  unitId?: string;
  memberId?: string;
  jsonPointer?: string;
  jsonOffset?: number;
  offset?: number;
  page?: number;
  section?: string;
  version?: number;
  mappingVersion?: string;
}

interface ReadWindow {
  tool: string;
  args: ReadArgs;
}

export interface ConversionCheckpoint {
  attribution?: IntakeAttribution;
  pageTiming?: {
    turn: number;
    lastCompletedAt: string | null;
    recentIntervalsMs: number[];
    lastReadMs: number | null;
  };
  intakeId: string;
  sourceHash: string;
  profileId: string;
  version: number;
  seen: string[];
  pending: ReadWindow[];
  readScopes: string[];
  jsonRoots: string[];
  completedUnits: string[];
  /** Includes explicit context/unreadable dispositions, never a clinical completeness claim. */
  accountedUnits?: string[];
  lastWindow: ReadWindow | null;
  turns: number;
  modelRequests?: number;
  measuredModelTokens?: number;
  modelUsageIncomplete?: boolean;
  unmeasuredRequests?: number;
  /**
   * Read windows the model actually read, counted once each. Distinct from
   * `seen.length` (projected as `readWindows`): `markRead` is also reached from the
   * JSON-structure branch, which pushes inferred child windows into `seen` without
   * incrementing this.
   */
  distinctReads?: number;
  /**
   * Legacy name for `distinctReads`, retained only so a checkpoint persisted before
   * the rename keeps the reads it already counted. Read through `distinctReadsOf`;
   * never written.
   */
  pagesProcessed?: number;
  suppliedJSON?: ReadWindow[];
}

/**
 * `distinctReads` as of now, migrating a pre-rename checkpoint's `pagesProcessed`
 * rather than silently restarting its count from zero.
 */
function distinctReadsOf(checkpoint: ConversionCheckpoint): number {
  return checkpoint.distinctReads ?? checkpoint.pagesProcessed ?? 0;
}

export function isFreshTopLevelImageConversion(
  checkpoint: ConversionCheckpoint,
  intake: IntakeWithWorkflow,
): boolean {
  return (
    checkpoint.intakeId === intake.id &&
    checkpoint.sourceHash === intake.sha256 &&
    checkpoint.version === intake.version &&
    checkpoint.seen.length === 0 &&
    checkpoint.readScopes.length === 0 &&
    checkpoint.pending.length === 0 &&
    intake.parentSourceFileId === null &&
    MODEL_IMAGE_MIME_TYPES.has(intake.mimeType) &&
    intake.proposals.length === 0 &&
    intake.acceptedProposalId === null &&
    intake.imported === null &&
    (intake.importHistory?.length || 0) === 0 &&
    intake.workflow.candidates.length === 0 &&
    intake.workflow.questions.length === 0 &&
    intake.workflow.plans.every((plan) => plan.batches.length === 0)
  );
}

interface ConversionChat {
  conversionCheckpoint?: ConversionCheckpoint;
}

interface StructureChild {
  jsonPointer: string | null;
  literalComplete?: boolean;
  nextOffset?: number | null;
  type?: string;
}

interface ReadStructure {
  jsonPointer: string;
  jsonOffset: number;
  literalComplete?: boolean;
  nextOffset: number | null;
  nextJSONOffset: number | null;
  children?: StructureChild[];
}

interface ReadOriginal {
  coverage?: string;
  members?: { memberId: string }[];
  text?: string;
  literal?: string;
  page?: number;
  offset?: number;
  nextOffset?: number | null;
  nextPage?: number | null;
  assets?: { id: string; derivative?: boolean }[];
}

interface ReadResult {
  metadata?: ReadResult;
  original?: ReadOriginal;
  structure?: ReadStructure;
  imageContent?: unknown;
  pdfContent?: unknown;
  sourceFileId?: string;
}

interface CoverageInput {
  planId: string;
  coverage?: IntakeExtractionCoverage[];
}

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_WINDOWS = 10000;
const descriptor = (tool: string, args: ReadArgs): ReadWindow => ({
  tool,
  args: Object.fromEntries(
    [
      'id',
      'action',
      'unitId',
      'memberId',
      'jsonPointer',
      'jsonOffset',
      'offset',
      'page',
      'section',
      'version',
      'mappingVersion',
    ]
      .filter(
        (key) =>
          args[key] !== undefined &&
          !(key === 'page' && args[key] === 1) &&
          !(key === 'jsonPointer' && args[key] === '') &&
          !(['offset', 'jsonOffset'].includes(key) && args[key] === 0),
      )
      .map((key) => [key, args[key]]),
  ),
});
const keyOf = (value: ReadWindow): string => hash(value);
export function conversionReadKey(tool: string, args: ReadArgs): string | null {
  if (
    tool !== 'health_intake_read' &&
    !(tool === 'health_intake_plan' && ['read', 'read_unit'].includes(String(args.action))) &&
    !(tool === 'health_intake_package' && args.action === 'read_member')
  )
    return null;
  return keyOf(descriptor(tool, args));
}
const jsonScope = (window: ReadWindow): string =>
  hash({
    tool: window.tool,
    args: Object.fromEntries(
      Object.entries(window.args).filter(
        ([key]) => !['jsonPointer', 'jsonOffset', 'offset'].includes(key),
      ),
    ),
  });
const withinJSON = (window: ReadWindow, supplied: ReadWindow): boolean => {
  const pointer = window.args.jsonPointer || '';
  const ancestor = supplied.args.jsonPointer || '';
  return (
    jsonScope(window) === jsonScope(supplied) &&
    (pointer === ancestor || pointer.startsWith(ancestor + '/'))
  );
};

export function conversionCheckpoint(
  chat: ConversionChat,
  intake: IntakeWithWorkflow,
  profileId: string,
): ConversionCheckpoint {
  const prior = chat.conversionCheckpoint;
  if (prior && prior.modelRequests === undefined && prior.turns > 0)
    prior.modelUsageIncomplete = true;
  if (
    prior &&
    (prior.intakeId !== intake.id ||
      prior.sourceHash !== intake.sha256 ||
      prior.profileId !== profileId)
  )
    throw new HttpError(
      409,
      'CONVERSION_CHANGED',
      'Conversion checkpoint belongs to different retained evidence',
    );
  const checkpoint = (chat.conversionCheckpoint ||= {
    intakeId: intake.id,
    sourceHash: intake.sha256,
    profileId,
    version: intake.version,
    seen: [],
    pending: [],
    readScopes: [],
    jsonRoots: [],
    completedUnits: intake.workflow.plans
      .flatMap((plan) => plan.units)
      .filter((unit) => unit.status === 'completed')
      .map((unit) => unit.id),
    lastWindow: null,
    turns: 0,
    modelRequests: 0,
    measuredModelTokens: 0,
    modelUsageIncomplete: false,
    unmeasuredRequests: 0,
    distinctReads: 0,
  });
  // Old receipts cannot prove historical reads or provider usage. New counters
  // continue across every slice/restart, without resetting or backfilling them.
  ensureIntakeAttribution(checkpoint);
  return checkpoint;
}

function conversionReadDetails(tool: string, args: ReadArgs, result: unknown) {
  if (!['health_intake_read', 'health_intake_package', 'health_intake_plan'].includes(tool))
    return null;
  const readResult = result as ReadResult | null | undefined;
  const value = readResult?.metadata || readResult || {};
  const original = value.original || (value as ReadOriginal);
  const structure = value.structure;
  const inventory = original?.coverage === 'inventory_only' && Array.isArray(original.members);
  const readable =
    structure ||
    typeof original?.text === 'string' ||
    typeof original?.literal === 'string' ||
    readResult?.imageContent ||
    readResult?.pdfContent;
  if (!readable && !inventory) return null;
  const current = descriptor(tool, {
    ...args,
    ...(structure ? { jsonPointer: structure.jsonPointer } : {}),
    ...(original.page ? { page: original.page } : {}),
  });
  return { readResult, value, original, structure, inventory, readable, current };
}

/** Queue a host-read scope until a later valid provider response acknowledges it.
 * Retain only cursor/shape metadata, never evidence text or encoded media. */
export function deferConversionRead(
  checkpoint: ConversionCheckpoint,
  tool: string,
  args: ReadArgs,
  result: unknown,
) {
  const details = conversionReadDetails(tool, args, result);
  if (!details) return null;
  const { readResult, value, original, structure, current } = details;
  const key = keyOf(current);
  if (checkpoint.seen.includes(key)) return null;
  if (structure && checkpoint.suppliedJSON?.some((item) => withinJSON(current, item))) return null;
  if (!checkpoint.pending.some((item) => keyOf(item) === key)) {
    if (checkpoint.pending.length >= MAX_WINDOWS)
      throw new HttpError(
        413,
        'CONVERSION_CHECKPOINT_LIMIT',
        'Reading paused at the bounded checkpoint limit; retained proposals remain reviewable',
      );
    checkpoint.pending.unshift(current);
  }
  const receipt: ReadResult = {
    ...(readResult?.imageContent ? { imageContent: true } : {}),
    ...(readResult?.pdfContent ? { pdfContent: true } : {}),
    metadata: {
      sourceFileId: value.sourceFileId,
      original: {
        coverage: original.coverage,
        members: original.members?.map(({ memberId }) => ({ memberId })),
        ...(typeof original.text === 'string' ? { text: '' } : {}),
        ...(typeof original.literal === 'string' ? { literal: '' } : {}),
        page: original.page,
        offset: original.offset,
        nextOffset: original.nextOffset,
        nextPage: original.nextPage,
        assets: original.assets?.map(({ id, derivative }) => ({ id, derivative })),
      },
      ...(structure
        ? {
            structure: {
              jsonPointer: structure.jsonPointer,
              jsonOffset: structure.jsonOffset,
              literalComplete: structure.literalComplete,
              nextOffset: structure.nextOffset,
              nextJSONOffset: structure.nextJSONOffset,
              children: structure.children?.map(
                ({ jsonPointer, literalComplete, nextOffset, type }) => ({
                  jsonPointer,
                  literalComplete,
                  nextOffset,
                  type,
                }),
              ),
            },
          }
        : {}),
    },
  };
  return { tool, args: current.args, result: receipt };
}

// Cursors record consumed source windows, never extraction or clinical coverage.
// Store metadata only; literal text and visual/PDF bytes stay in retained sources.
export function recordConversionRead(
  checkpoint: ConversionCheckpoint,
  tool: string,
  args: ReadArgs,
  result: unknown,
): boolean {
  const details = conversionReadDetails(tool, args, result);
  if (!details) return false;
  const { value, original, structure, inventory, readable, current } = details;
  let suppliedWindows = (checkpoint.suppliedJSON ||= []);
  // A complete literal already supplies every descendant value. Re-reading
  // its structural children must not manufacture new continuation progress.
  if (structure && suppliedWindows.some((item) => withinJSON(current, item))) return false;
  const key = keyOf(current);
  const fresh = !checkpoint.seen.includes(key);
  const markRead = (window: ReadWindow): void => {
    const windowKey = keyOf(window);
    if (checkpoint.seen.includes(windowKey)) return;

    if (checkpoint.seen.length >= MAX_WINDOWS)
      throw new HttpError(
        413,
        'CONVERSION_CHECKPOINT_LIMIT',
        'Reading paused at the bounded checkpoint limit; retained proposals remain reviewable',
      );
    checkpoint.seen.push(windowKey);
  };
  markRead(current);
  checkpoint.pending = checkpoint.pending.filter((item) => keyOf(item) !== key);
  const enqueue = (nextTool: string, nextArgs: ReadArgs): void => {
    const next = descriptor(nextTool, nextArgs),
      nextKey = keyOf(next);
    if (
      checkpoint.seen.includes(nextKey) ||
      suppliedWindows.some((item) => withinJSON(next, item)) ||
      checkpoint.pending.some((item) => keyOf(item) === nextKey)
    )
      return;
    if (checkpoint.pending.length >= MAX_WINDOWS)
      throw new HttpError(
        413,
        'CONVERSION_CHECKPOINT_LIMIT',
        'Reading paused at the bounded checkpoint limit; retained proposals remain reviewable',
      );
    checkpoint.pending.push(next);
  };
  const suppliedJSON = (window: ReadWindow): void => {
    markRead(window);
    suppliedWindows = checkpoint.suppliedJSON = suppliedWindows.filter(
      (item) => !withinJSON(item, window),
    );
    suppliedWindows.push(window);
    checkpoint.pending = checkpoint.pending.filter((item) => !withinJSON(item, window));
  };
  const scope = hash([args.id, args.memberId || null, original.page || null]);
  checkpoint.readScopes ||= [];
  checkpoint.jsonRoots ||= [];
  if (readable && !checkpoint.readScopes.includes(scope)) checkpoint.readScopes.push(scope);
  if (readable && args.memberId) {
    // A package member can be read through page windows. Keep its occurrence
    // scope as well as the page scope; pending pages/text still gate coverage.
    const memberScope = hash([args.id, args.memberId, null]);
    if (!checkpoint.readScopes.includes(memberScope)) checkpoint.readScopes.push(memberScope);
  }
  if (inventory) {
    for (const member of original.members!)
      enqueue('health_intake_package', {
        id: args.id,
        action: 'read_member',
        memberId: member.memberId,
      });
    if (original.nextOffset !== null && original.nextOffset !== undefined)
      enqueue('health_intake_package', {
        id: args.id,
        action: 'inventory',
        offset: original.nextOffset,
      });
  } else if (structure) {
    const sourceScope = hash([args.id, args.memberId || null, null]);
    if (
      !structure.jsonPointer &&
      structure.jsonOffset === 0 &&
      !checkpoint.jsonRoots.includes(sourceScope)
    )
      checkpoint.jsonRoots.push(sourceScope);
    if (!checkpoint.jsonRoots.includes(sourceScope))
      enqueue(tool, { ...args, jsonPointer: '', jsonOffset: 0, offset: 0 });
    if (structure.jsonOffset > 0)
      enqueue(tool, { ...args, jsonPointer: structure.jsonPointer, jsonOffset: 0, offset: 0 });
    if (structure.literalComplete === true) {
      suppliedJSON(
        descriptor(tool, { ...args, jsonPointer: structure.jsonPointer, jsonOffset: 0, offset: 0 }),
      );
    } else {
      for (const child of structure.children || []) {
        if (child.jsonPointer === null) {
          // Overlong keys cannot be addressed with a bounded JSON pointer.
          // Finish the parent's literal windows instead of dropping the value.
          if (child.literalComplete !== true && structure.nextOffset !== null)
            enqueue(tool, {
              ...args,
              jsonPointer: structure.jsonPointer,
              offset: structure.nextOffset,
            });
          continue;
        }
        const childArgs = { ...args, jsonPointer: child.jsonPointer, jsonOffset: 0, offset: 0 };
        if (child.literalComplete === true) suppliedJSON(descriptor(tool, childArgs));
        else if (child.literalComplete === false && Number.isSafeInteger(child.nextOffset))
          enqueue(tool, { ...childArgs, offset: child.nextOffset! });
        else if (['array', 'object'].includes(child.type || '') || structure.nextOffset !== null)
          enqueue(tool, childArgs);
      }
      if (structure.nextJSONOffset !== null)
        enqueue(tool, {
          ...args,
          jsonPointer: structure.jsonPointer,
          jsonOffset: structure.nextJSONOffset,
          offset: 0,
        });
      if (!structure.children?.length && structure.nextOffset !== null)
        enqueue(tool, {
          ...args,
          jsonPointer: structure.jsonPointer,
          offset: structure.nextOffset,
        });
    }
  } else {
    if ((original.page || 0) > 1) enqueue(tool, { ...args, page: 1, offset: 0 });
    if ((original.offset || 0) > 0) enqueue(tool, { ...args, offset: 0 });
    if (original.nextOffset !== null && original.nextOffset !== undefined)
      enqueue(tool, { ...args, offset: original.nextOffset });
    if (original.nextPage !== null && original.nextPage !== undefined)
      enqueue(tool, { ...args, page: original.nextPage, offset: 0 });
    for (const asset of original.assets || [])
      if (asset.id !== args.id && asset.id !== value.sourceFileId && !asset.derivative)
        enqueue('health_intake_read', { id: asset.id });
  }
  if (readable) {
    checkpoint.lastWindow = current;
    // Keep unfinished children of the current member/window ahead of other
    // inventory members. This is traversal order, never clinical authority.
    const local = (item: ReadWindow): boolean =>
      item.args.id === args.id && item.args.memberId === args.memberId;
    checkpoint.pending.sort((left, right) => Number(local(right)) - Number(local(left)));
  }
  // A re-read of an already-seen window is not a newly read window.
  if (fresh) checkpoint.distinctReads = distinctReadsOf(checkpoint) + 1;
  return fresh;
}

// Bounded host evidence guard: read/structure exhaustion is necessary, never
// sufficient, for the model's claim that a whole page/member was extracted.
export function assertConversionCoverage(
  checkpoint: ConversionCheckpoint,
  intake: IntakeWithWorkflow,
  input: CoverageInput,
): void {
  const plan = intake.workflow.plans.find(
    (item) => item.id === input.planId && item.status === 'active',
  );
  for (const coverage of input.coverage || []) {
    if (coverage.kind !== 'extracted') continue;
    const unit = plan?.units.find((item) => item.id === coverage.unitId);
    if (!unit)
      throw new HttpError(
        409,
        'CONVERSION_COVERAGE_PENDING',
        'Choose an active extraction unit belonging to this delivery before claiming extracted coverage',
      );
    const id = unit.sourceFileId || intake.id;
    const scopeRead = (page: number | null = null): boolean =>
      checkpoint.readScopes.includes(hash([id, unit.memberId || null, page]));
    const pending = checkpoint.pending.some(
      (item) =>
        item.args.id === id &&
        (unit.memberId
          ? item.args.memberId === unit.memberId
          : unit.pages
            ? unit.pages.includes(item.args.page || 1)
            : ['text', 'html'].includes(unit.kind) && !item.args.unitId
              ? !item.args.page &&
                (unit.end === undefined || (item.args.offset || 0) < unit.end) &&
                !checkpoint.seen.includes(
                  keyOf(
                    descriptor('health_intake_plan', {
                      id,
                      action: 'read_unit',
                      unitId: unit.id,
                    }),
                  ),
                )
              : item.args.unitId === unit.id),
    );
    if (
      (unit.kind === 'package_member' && !scopeRead()) ||
      (unit.kind === 'image' && !scopeRead()) ||
      (unit.kind === 'pdf' && !(unit.pages || []).every(scopeRead)) ||
      pending
    )
      throw new HttpError(
        409,
        'CONVERSION_COVERAGE_PENDING',
        'Read and account for every remaining window in this page/member before claiming extracted coverage; use inspected/partial coverage for a saved subset',
      );
  }
}

export function conversionResumeContext(
  checkpoint: ConversionCheckpoint,
  intake: IntakeWithWorkflow,
) {
  const plan = intake.workflow.plans.find((item) => item.status === 'active');
  const pendingUnits = plan?.units.filter((unit) => !accountedUnitKind(plan, unit)) || [];
  const pending = checkpoint.pending.filter((window) => {
    const matching =
      plan?.units.filter((unit) => {
        if ((unit.sourceFileId || intake.id) !== window.args.id) return false;
        if (unit.memberId) return unit.memberId === window.args.memberId;
        if (window.args.memberId) return false;
        if (window.args.unitId) return window.args.unitId === unit.id;
        // A whole-source text cursor may span several overlapping units.
        // Only suppress it when every relevant text unit is explicitly disposed.
        if (!window.args.page && ['text', 'html'].includes(unit.kind)) return true;
        return unit.pages?.includes(window.args.page || 1) || false;
      }) || [];
    // Do not erase raw windows. Explicit context/unreadable dispositions pause
    // automatic traversal only in their exact scope; a later inspected batch reopens it.
    return (
      !matching.length ||
      matching.some(
        (unit) => !['context', 'unreadable'].includes(accountedUnitKind(plan!, unit) || ''),
      )
    );
  });
  return {
    intakeId: intake.id,
    sourceHash: checkpoint.sourceHash,
    version: intake.version,
    mappingVersion: plan?.pins.mappingVersion || null,
    planId: plan?.id || null,
    pendingUnits: pendingUnits.length,
    pendingReadWindows: pending.length,
    currentWindow: checkpoint.lastWindow,
    nextReadWindows: pending.slice(0, 12),
    remainingUnits:
      pendingUnits.slice(0, 8).map(({ id, kind, memberId, pages, locator }) => ({
        id,
        kind,
        memberId,
        pages,
        locator,
      })) || [],
    retainedCandidates: intake.workflow.candidates
      .slice(-50)
      .map(({ id, envelopeId, sourceRecordId }) => ({ id, envelopeId, sourceRecordId })),
    retainedCandidateCount: intake.workflow.candidates.length,
    ...(intake.workflow.plans.length === 0 && isFreshTopLevelImageConversion(checkpoint, intake)
      ? {
          freshTopLevelImageBootstrap: {
            eligible: true,
            instructions:
              'Begin with health_intake_read for this exact intake. The host will prepare the deterministic whole-image plan together with the required pixel read. Do not call health_intake_plan create first. Use the returned preparedExtraction plan and unit metadata for the subsequent batch and any necessary question.',
          },
        }
      : {}),
    proposalIds: intake.proposals.slice(-10).map((proposal) => proposal.id),
    instructions:
      'Resume this conversion without a greeting or introduction. Read cursors describe reading only, never extraction completion. When the latest user message explicitly prioritizes a different supplied section, inspect that section first and keep unfinished windows pending. Otherwise finish and publish all unproposed records from the current window before moving on; preserve stable source IDs and locators and do not repeat the first record. Inspect the remaining child pointers/pages, including every record in a large JSON array. Use one bounded proposal for multiple fully read records when practical, rather than one proposal per small record. Publish bounded batches and honest partial coverage; one proposal or a fully read window does not prove all entities were extracted. Do not accept/import. If progress is blocked, explain the blocker briefly.',
  };
}

/** Observed completion intervals reset with the actual model context, not a percentage estimate. */
export function recordConversionPageTiming(
  checkpoint: ConversionCheckpoint,
  at: string,
  durationMs: number,
): void {
  if (!Number.isFinite(Date.parse(at)) || !Number.isFinite(durationMs) || durationMs < 0) return;
  const timing =
    checkpoint.pageTiming?.turn === checkpoint.turns
      ? checkpoint.pageTiming
      : {
          turn: checkpoint.turns,
          lastCompletedAt: null,
          recentIntervalsMs: [],
          lastReadMs: null,
        };
  if (timing.lastCompletedAt) {
    const interval = Date.parse(at) - Date.parse(timing.lastCompletedAt);
    if (interval >= 0) timing.recentIntervalsMs = [...timing.recentIntervalsMs, interval].slice(-5);
  }
  timing.lastCompletedAt = at;
  timing.lastReadMs = durationMs;
  checkpoint.pageTiming = timing;
}

export function conversionReadingState(
  checkpoint: ConversionCheckpoint,
  intake: IntakeWithWorkflow,
  reason: string | null = null,
): IntakeBatchReadingState {
  const resume = conversionResumeContext(checkpoint, intake);
  const plan = intake.workflow.plans.find((item) => item.status === 'active');
  return {
    status: reason ? 'paused' : 'running',
    reason,
    turns: checkpoint.turns,
    modelRequests: checkpoint.modelRequests || 0,
    measuredModelTokens: checkpoint.measuredModelTokens || 0,
    modelUsageIncomplete: !!checkpoint.modelUsageIncomplete || !!checkpoint.unmeasuredRequests,
    readyRecords: resume.retainedCandidateCount,
    remainingUnits: resume.pendingUnits,
    pendingReadWindows: resume.pendingReadWindows,
    // `readWindows` counts every window marked seen, including children satisfied by
    // inference from a JSON structure read; `distinctReads` counts only the windows
    // the model actually read. Equal for plain paginated sources, not in general.
    readWindows: checkpoint.seen.length,
    totalUnits: plan?.units.length || 0,
    accountedUnits: (plan?.units.length || 0) - resume.pendingUnits,
    distinctReads: distinctReadsOf(checkpoint),
    // Derived from every plan's batches, so a replayed submitIntakeBatch — which
    // returns the existing intake without adding a batch entry — never double-counts,
    // and a superseded plan's proposals stay counted because the reading total they
    // came from is never reset.
    proposalsProduced: intake.workflow.plans.reduce(
      (total, item) => total + item.batches.length,
      0,
    ),
    phase: 'waiting_for_model',
    pageTiming: {
      turn: checkpoint.turns,
      lastCompletedAt:
        checkpoint.pageTiming?.turn === checkpoint.turns
          ? checkpoint.pageTiming.lastCompletedAt
          : null,
      recentIntervalMs:
        checkpoint.pageTiming?.turn === checkpoint.turns &&
        checkpoint.pageTiming.recentIntervalsMs.length
          ? checkpoint.pageTiming.recentIntervalsMs.reduce((sum, value) => sum + value, 0) /
            checkpoint.pageTiming.recentIntervalsMs.length
          : null,
      intervalSamples:
        checkpoint.pageTiming?.turn === checkpoint.turns
          ? checkpoint.pageTiming.recentIntervalsMs.length
          : 0,
      lastReadMs:
        checkpoint.pageTiming?.turn === checkpoint.turns ? checkpoint.pageTiming.lastReadMs : null,
    },
    coverage: 'reading_progress_only',
  };
}
