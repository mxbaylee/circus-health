import { createHash, randomBytes } from 'node:crypto';
import type { Intake } from '../shared/intake.ts';

/** Diagnostic-only source metadata. These independently bounded iterables are
 * never a clinical workflow or acceptance capability. */
export interface AttributionMetadataItems<T> extends Iterable<T> {
  readonly length: number;
}
type Items<T> = AttributionMetadataItems<T>;
export interface AttributionMetadataUnit {
  id: string;
  sourceFileId?: string;
  memberId?: string;
  pages?: Items<number>;
  status: string;
  coverage?: { kind: string };
}
export interface AttributionDiagnosticSource {
  format: 'health-intake-attribution-source-v1';
  id: string;
  sha256: string;
  parentSourceFileId: string | null;
  incomplete?(): boolean;
  proposals: Items<{ id: string }>;
  history: Items<{
    acceptedProposalId?: string | null;
    clinical?: { records?: Items<{ recordId: string }> };
  }>;
  decisions: Items<{
    action: string;
    candidateId: string;
    candidateVersionId: string;
    recordId: string;
  }>;
  reportAcceptances: Items<{
    receipt: {
      receipts: Items<{
        intakeId: string;
        proposalId: string | null;
        records: Items<{ candidateId: string; candidateVersionId: string; recordId: string }>;
      }>;
    };
  }>;
  plans: Items<{
    id: string;
    status: string;
    units: Items<AttributionMetadataUnit>;
    batches: Items<{ id: string; coverage: Items<{ unitId: string }> }>;
  }>;
  candidates: Items<{
    id: string;
    versions: Items<{
      id: string;
      status: string;
      occurrences: Items<{
        proposalId: string | null;
        recordId: string;
        batchId?: string | null;
        locator?: string;
      }>;
    }>;
  }>;
}
function legacyDiagnosticSource(intake: Intake): AttributionDiagnosticSource {
  return {
    format: 'health-intake-attribution-source-v1',
    id: intake.id,
    sha256: intake.sha256,
    parentSourceFileId: intake.parentSourceFileId || null,
    proposals: intake.proposals,
    history: intake.importHistory?.length
      ? intake.importHistory
      : intake.imported
        ? [{ acceptedProposalId: intake.acceptedProposalId, clinical: intake.imported.clinical }]
        : [],
    decisions: intake.workflow?.decisions || [],
    reportAcceptances: intake.workflow?.reportAcceptances || [],
    plans: intake.workflow?.plans || [],
    candidates: intake.workflow?.candidates || [],
  };
}

const MAX_SCOPES = 2048;
const MAX_WINDOWS = 4096;
const MAX_IMPORTS = 100;
const MAX_EXPORT_SCOPES = 4096;
const MAX_METADATA_WORK = 50_000;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
}
interface Counters {
  attempts: number;
  responses: number;
  failedAttempts: number;
  unknownUsageAttempts: number;
  unknownCacheAttempts: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}
const counters = (): Counters => ({
  attempts: 0,
  responses: 0,
  failedAttempts: 0,
  unknownUsageAttempts: 0,
  unknownCacheAttempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
});
export interface AttributionScope {
  sourceFileId: string;
  memberId: string | null;
  page: number | null;
}
interface ScopeCounters extends AttributionScope, Counters {
  hostReads: number;
  acknowledgedReads: number;
  /** Exact page text-layer count, not OCR or evidence that a page is empty. */
  textLayerCharacters?: number;
  textLayerCountConflict?: boolean;
  timedHostReads?: number;
  hostReadTotalMs?: number;
  hostReadMaxMs?: number;
}
export interface IntakeAttribution {
  version: 1;
  historicalReadsUnknown: boolean;
  truncated: boolean;
  untrackedReadScopes: number;
  untrackedReadWindows: number;
  totals: Counters;
  unallocated: Counters;
  scopes: Record<string, ScopeCounters>;
  windows: Record<string, number>;
}
interface Checkpoint {
  intakeId: string;
  sourceHash: string;
  profileId: string;
  turns: number;
  attribution?: IntakeAttribution;
  pageTiming?: {
    turn: number;
    lastCompletedAt: string | null;
    recentIntervalsMs: number[];
    lastReadMs: number | null;
  };
}
export function ensureIntakeAttribution(checkpoint: Checkpoint): IntakeAttribution {
  return (checkpoint.attribution ||= {
    version: 1,
    historicalReadsUnknown: checkpoint.turns > 0,
    truncated: false,
    untrackedReadScopes: 0,
    untrackedReadWindows: 0,
    totals: counters(),
    unallocated: counters(),
    scopes: {},
    windows: {},
  });
}

/** Metadata only. A plan/context/inventory response is never a source-page read. */
export function attributionReadScope(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): AttributionScope | null {
  if (
    !(
      tool === 'health_intake_read' ||
      (tool === 'health_intake_package' && args.action === 'read_member') ||
      (tool === 'health_intake_plan' && args.action === 'read_unit')
    ) ||
    !object(result)
  )
    return null;
  const value = object(result.metadata) ? result.metadata : result;
  const original = object(value.original) ? value.original : value;
  if (!(
    typeof original.text === 'string' ||
    typeof original.literal === 'string' ||
    object(value.structure) ||
    result.pdfContent ||
    result.imageContent
  ))
    return null;
  const sourceFileId = typeof value.sourceFileId === 'string' ? value.sourceFileId : args.id;
  if (typeof sourceFileId !== 'string' || sourceFileId.length > 200) return null;
  return {
    sourceFileId,
    memberId: typeof args.memberId === 'string' ? args.memberId : null,
    page: count(original.page) && original.page > 0 ? original.page : null,
  };
}

export function recordAttributionRead(
  checkpoint: Checkpoint,
  windowKey: string,
  scope: AttributionScope | null,
  textLayerCharacters?: unknown,
  hostReadDurationMs?: number,
): { priorReads: number | null; scopeKey: string | null } {
  const value = ensureIntakeAttribution(checkpoint);
  let priorReads: number | null = value.windows[windowKey] || 0;
  if (priorReads || Object.keys(value.windows).length < MAX_WINDOWS)
    value.windows[windowKey] = priorReads + 1;
  else {
    value.truncated = true;
    value.untrackedReadWindows = (value.untrackedReadWindows || 0) + 1;
    priorReads = null;
  }
  if (!scope) return { priorReads, scopeKey: null };
  const scopeKey = key(scope);
  if (!value.scopes[scopeKey]) {
    if (Object.keys(value.scopes).length >= MAX_SCOPES) {
      value.truncated = true;
      value.untrackedReadScopes = (value.untrackedReadScopes || 0) + 1;
      return { priorReads, scopeKey: null };
    }
    value.scopes[scopeKey] = { ...scope, ...counters(), hostReads: 0, acknowledgedReads: 0 };
  }
  const target = value.scopes[scopeKey];
  target.hostReads++;
  if (
    scope.page !== null &&
    typeof hostReadDurationMs === 'number' &&
    Number.isFinite(hostReadDurationMs) &&
    hostReadDurationMs >= 0
  ) {
    target.timedHostReads = (target.timedHostReads || 0) + 1;
    target.hostReadTotalMs = (target.hostReadTotalMs || 0) + hostReadDurationMs;
    target.hostReadMaxMs = Math.max(target.hostReadMaxMs || 0, hostReadDurationMs);
  }
  if (scope.page !== null && count(textLayerCharacters)) {
    if (
      target.textLayerCharacters !== undefined &&
      target.textLayerCharacters !== textLayerCharacters
    )
      target.textLayerCountConflict = true;
    else target.textLayerCharacters = textLayerCharacters;
  }
  return { priorReads, scopeKey };
}

export function acknowledgeAttributionRead(checkpoint: Checkpoint, scopeKey: string): void {
  const scope = checkpoint.attribution?.scopes[scopeKey];
  if (scope) scope.acknowledgedReads++;
}

/** Request totals are exact once. Tokens on scopes are equal shares, never page costs. */
export function startAttributionRequest(checkpoint: Checkpoint, scopeKeys: string[]): string[] {
  const value = ensureIntakeAttribution(checkpoint);
  const scopes = [...new Set(scopeKeys)].filter((id) => !!value.scopes[id]);
  const targets = [
    value.totals,
    ...(scopes.length ? scopes.map((id) => value.scopes[id]) : [value.unallocated]),
  ];
  for (const target of targets) {
    target.attempts++;
    target.unknownUsageAttempts++;
    target.unknownCacheAttempts++;
  }
  return scopes;
}

export function finishAttributionRequest(
  checkpoint: Checkpoint,
  scopes: string[],
  response: { failed: boolean; usage?: unknown },
): void {
  const value = ensureIntakeAttribution(checkpoint);
  const raw = response.usage;
  const usage: Usage | null =
    object(raw) && count(raw.inputTokens) && count(raw.outputTokens)
      ? {
          inputTokens: raw.inputTokens,
          outputTokens: raw.outputTokens,
          cachedInputTokens:
            count(raw.cachedInputTokens) && raw.cachedInputTokens <= raw.inputTokens
              ? raw.cachedInputTokens
              : null,
        }
      : null;
  const apply = (target: Counters, share: number) => {
    if (response.failed) target.failedAttempts++;
    else target.responses++;
    if (!usage) return;
    target.unknownUsageAttempts = Math.max(0, target.unknownUsageAttempts - 1);
    target.inputTokens += usage.inputTokens * share;
    target.outputTokens += usage.outputTokens * share;
    if (usage.cachedInputTokens !== null) {
      target.unknownCacheAttempts = Math.max(0, target.unknownCacheAttempts - 1);
      target.cachedInputTokens += usage.cachedInputTokens * share;
    }
  };
  apply(value.totals, 1);
  if (!scopes.length) apply(value.unallocated, 1);
  else for (const id of scopes) if (value.scopes[id]) apply(value.scopes[id], 1 / scopes.length);
}

interface YieldScope extends AttributionScope {
  activeUnits: Set<string>;
  supersededUnits: Set<string>;
  coverage: Map<string, Set<string>>;
  proposals: Set<string>;
  pendingVersions: Set<string>;
  supersededVersions: Set<string>;
  proposedOccurrences: Set<string>;
  acceptedVersions: Set<string>;
  acceptedRecords: Set<string>;
  sharedProposedOccurrences: Set<string>;
  sharedAcceptedRecords: Set<string>;
}
function unitScopes(
  intake: AttributionDiagnosticSource,
  unit: AttributionMetadataUnit,
  bounded: <T>(items: Items<T>) => T[],
): AttributionScope[] {
  const source = { sourceFileId: unit.sourceFileId || intake.id, memberId: unit.memberId || null };
  const pages = [...new Set(bounded(unit.pages || []).filter((page) => count(page) && page > 0))];
  return pages.length ? pages.map((page) => ({ ...source, page })) : [{ ...source, page: null }];
}

/**
 * Uses durable metadata, never parses arbitrary clinical locators as verified page
 * numbers. A record linked to a multi-page batch remains a shared unit association.
 * Historical plans and versions remain separate from current coverage and yield.
 */
export function exportImportAttribution({
  intakes: inputIntakes,
  chats,
  salt = randomBytes(32),
  selectionIncomplete = false,
  historyIncomplete = false,
}: {
  intakes: (Intake | AttributionDiagnosticSource)[];
  chats: unknown[];
  salt?: Uint8Array;
  selectionIncomplete?: boolean;
  historyIncomplete?: boolean;
}) {
  const omittedSources = Math.max(0, inputIntakes.length - 1000);
  const omittedChats = Math.max(0, chats.length - 100);
  const intakes = inputIntakes
    .slice(0, 1000)
    .map((source) =>
      'format' in source && source.format === 'health-intake-attribution-source-v1'
        ? source
        : legacyDiagnosticSource(source as Intake),
    );
  chats = chats.slice(0, 100);
  let metadataWork = 0,
    omittedMetadataItems = 0,
    exportScopes = 0;
  const bounded = <T>(items: Items<T>): T[] => {
    const admitted = Math.min(items.length, MAX_METADATA_WORK - metadataWork);
    metadataWork += admitted;
    omittedMetadataItems += items.length - admitted;
    if (Array.isArray(items)) return admitted === items.length ? items : items.slice(0, admitted);
    const result: T[] = [],
      iterator = items[Symbol.iterator]();
    try {
      for (let i = 0; i < admitted; i++) {
        const next = iterator.next();
        if (next.done) {
          omittedMetadataItems += admitted - i;
          break;
        }
        result.push(next.value);
      }
    } finally {
      iterator.return?.();
    }
    return result;
  };
  const pseudonym = (value: string) =>
    createHash('sha256').update(salt).update(value).digest('hex').slice(0, 20);
  const byIntake = new Map(intakes.map((intake) => [intake.id, intake]));
  const publicCounters = (value: Counters, estimated = false, historyIncomplete = false) => ({
    attempts: value.attempts,
    responses: value.responses,
    failedAttempts: value.failedAttempts,
    unknownUsageAttempts: value.unknownUsageAttempts,
    unknownCacheAttempts: value.unknownCacheAttempts,
    usageComplete: !historyIncomplete && value.unknownUsageAttempts === 0,
    cacheUsageComplete: !historyIncomplete && value.unknownCacheAttempts === 0,
    trackedUsageComplete: value.unknownUsageAttempts === 0,
    trackedCacheUsageComplete: value.unknownCacheAttempts === 0,
    ...(estimated
      ? {
          equalShareInputTokenEstimate: value.inputTokens,
          equalShareOutputTokenEstimate: value.outputTokens,
          equalShareCachedInputTokenEstimate: value.cachedInputTokens,
        }
      : {
          measuredInputTokens: value.inputTokens,
          measuredOutputTokens: value.outputTokens,
          measuredCachedInputTokens: value.cachedInputTokens,
        }),
  });
  const rootId = (id: string) => {
    const seen = new Set<string>();
    let current = byIntake.get(id);
    while (
      current?.parentSourceFileId &&
      byIntake.has(current.parentSourceFileId) &&
      !seen.has(current.id)
    ) {
      seen.add(current.id);
      current = byIntake.get(current.parentSourceFileId);
    }
    return current?.id || id;
  };
  const imports = new Map<string, Checkpoint[]>();
  let omittedImports = 0;
  for (const chat of chats) {
    if (!object(chat) || !object(chat.conversionCheckpoint)) continue;
    const checkpoint = chat.conversionCheckpoint as unknown as Checkpoint;
    if (typeof checkpoint.intakeId !== 'string' || !byIntake.has(checkpoint.intakeId)) continue;
    const id = rootId(checkpoint.intakeId);
    if (!imports.has(id)) {
      if (imports.size >= MAX_IMPORTS) {
        omittedImports++;
        continue;
      }
      imports.set(id, []);
    }
    imports.get(id)!.push(checkpoint);
  }
  // Imports without a conversion chat still have independently useful durable yield.
  for (const intake of intakes)
    if (rootId(intake.id) === intake.id && !imports.has(intake.id)) {
      if (imports.size >= MAX_IMPORTS) {
        omittedImports++;
        continue;
      }
      imports.set(intake.id, []);
    }
  const report = {
    schemaVersion: 1 as const,
    tokenAttribution: 'equal_share_of_entire_request_including_shared_context' as const,
    pageExposure:
      'read_payload_present_on_request; acknowledgment_requires_valid_response' as const,
    yieldAttribution: 'durable_batch_unit_association; shared_counts_are_nonadditive' as const,
    unknowns:
      'Historical reads, missing provider usage, unscoped records, missing page text-layer counts and truncated scopes are unknown, never zero estimates. A measured zero text-layer count does not mean an empty or administrative page.',
    omittedImports,
    imports: [...imports].map(([id, checkpoints]) => {
      const belongs = (intake: AttributionDiagnosticSource): boolean => {
        const seen = new Set<string>();
        let current: AttributionDiagnosticSource | undefined = intake;
        while (current && !seen.has(current.id)) {
          if (current.id === id) return true;
          seen.add(current.id);
          current = current.parentSourceFileId
            ? byIntake.get(current.parentSourceFileId)
            : undefined;
        }
        return false;
      };
      const sources = intakes.filter(belongs);
      const sourceIds = new Set(sources.map((source) => source.id));
      const memberSources = new Map<string, Set<string>>();
      for (const checkpoint of bounded(checkpoints)) {
        if (checkpoint.sourceHash !== byIntake.get(checkpoint.intakeId)?.sha256) continue;
        for (const scope of bounded(Object.values(checkpoint.attribution?.scopes || {}))) {
          const parent = byIntake.get(scope.sourceFileId)?.parentSourceFileId;
          if (!parent || !scope.memberId) continue;
          const memberKey = key([parent, scope.memberId]);
          if (!memberSources.has(memberKey)) memberSources.set(memberKey, new Set());
          memberSources.get(memberKey)!.add(scope.sourceFileId);
        }
      }
      // A retained child can reuse bytes for multiple ZIP occurrences. Preserve
      // every member identity; a direct child read cannot choose a member for us.
      const normalizeScope = (scope: AttributionScope): AttributionScope => {
        const members = scope.memberId
          ? memberSources.get(key([scope.sourceFileId, scope.memberId]))
          : null;
        const sourceFileId = members?.size === 1 ? [...members][0] : scope.sourceFileId;
        return {
          sourceFileId,
          memberId: scope.memberId,
          page: scope.page,
        };
      };
      const pages = new Map<string, YieldScope>();
      let truncated = false;
      let omittedScopeAssociations = 0;
      const page = (scope: AttributionScope) => {
        scope = normalizeScope(scope);
        const scopeKey = key({
          sourceFileId: scope.sourceFileId,
          memberId: scope.memberId,
          page: scope.page,
        });
        let value = pages.get(scopeKey);
        if (!value) {
          if (pages.size >= MAX_SCOPES || exportScopes >= MAX_EXPORT_SCOPES) {
            truncated = true;
            omittedScopeAssociations++;
            return null;
          }
          value = {
            ...scope,
            activeUnits: new Set(),
            supersededUnits: new Set(),
            coverage: new Map(),
            proposals: new Set(),
            pendingVersions: new Set(),
            supersededVersions: new Set(),
            proposedOccurrences: new Set(),
            acceptedVersions: new Set(),
            acceptedRecords: new Set(),
            sharedProposedOccurrences: new Set(),
            sharedAcceptedRecords: new Set(),
          };
          pages.set(scopeKey, value);
          exportScopes++;
        }
        return value;
      };
      const proposals = new Set<string>(),
        occurrences = new Set<string>(),
        accepted = new Set<string>();
      const unscopedProposed = new Set<string>(),
        unscopedAccepted = new Set<string>();
      const acceptedVersionKeys = new Set<string>();
      const acceptedVersionRecords = new Set<string>();
      const acceptedRecordKey = (
        source: string,
        proposal: string | null | undefined,
        record: string,
      ) => key([source, proposal, record]);
      // A coordinator receipt may live on another source. Match its target intake,
      // then deduplicate by target/candidate/version/record, not coordinator storage.
      for (const intake of bounded(intakes))
        for (const acceptance of bounded(intake.reportAcceptances))
          for (const receipt of bounded(acceptance.receipt.receipts)) {
            if (!sourceIds.has(receipt.intakeId)) continue;
            for (const record of bounded(receipt.records)) {
              acceptedVersionKeys.add(
                key([receipt.intakeId, record.candidateId, record.candidateVersionId]),
              );
              const recordKey = acceptedRecordKey(
                receipt.intakeId,
                receipt.proposalId,
                record.recordId,
              );
              acceptedVersionRecords.add(
                key([receipt.intakeId, record.candidateId, record.candidateVersionId, recordKey]),
              );
              accepted.add(recordKey);
              unscopedAccepted.add(recordKey);
            }
          }
      for (const intake of bounded(sources)) {
        const history = intake.history;
        for (const receipt of bounded(history))
          for (const record of bounded(receipt.clinical?.records || [])) {
            const recordKey = acceptedRecordKey(
              intake.id,
              receipt.acceptedProposalId,
              record.recordId,
            );
            accepted.add(recordKey);
            unscopedAccepted.add(recordKey);
          }
        for (const proposal of bounded(intake.proposals))
          proposals.add(key([intake.id, proposal.id]));
        const decisions = new Set(
          bounded(intake.decisions)
            .filter((decision) => decision.action === 'accept')
            .map((decision) =>
              key([decision.candidateId, decision.candidateVersionId, decision.recordId]),
            ),
        );
        const batches = new Map<string, AttributionScope[]>();
        for (const plan of bounded(intake.plans)) {
          const units = bounded(plan.units);
          const byUnit = new Map(units.map((unit) => [unit.id, unit]));
          for (const unit of units)
            for (const scope of bounded(unitScopes(intake, unit, bounded))) {
              const row = page(scope);
              if (!row) continue;
              const unitKey = key([intake.id, plan.id, unit.id]);
              (plan.status === 'active' ? row.activeUnits : row.supersededUnits).add(unitKey);
              if (plan.status === 'active') {
                const coverageKind =
                  unit.coverage?.kind || (unit.status === 'pending' ? 'pending' : 'unknown');
                if (!row.coverage.has(coverageKind)) row.coverage.set(coverageKind, new Set());
                row.coverage.get(coverageKind)!.add(unitKey);
              }
            }
          for (const batch of bounded(plan.batches)) {
            const scopes = new Map<string, AttributionScope>();
            for (const coverage of bounded(batch.coverage)) {
              const unit = byUnit.get(coverage.unitId);
              if (!unit) continue;
              for (const scope of bounded(unitScopes(intake, unit, bounded))) {
                const normalized = normalizeScope(scope);
                scopes.set(key(normalized), normalized);
              }
            }
            batches.set(batch.id, [...scopes.values()]);
          }
        }
        for (const candidate of bounded(intake.candidates))
          for (const version of bounded(candidate.versions)) {
            const versionKey = key([intake.id, candidate.id, version.id]);
            for (const occurrence of bounded(version.occurrences)) {
              const occurrenceKey = key([
                intake.id,
                candidate.id,
                version.id,
                occurrence.proposalId,
                occurrence.recordId,
                occurrence.batchId,
                occurrence.locator,
              ]);
              const recordKey = acceptedRecordKey(
                intake.id,
                occurrence.proposalId,
                occurrence.recordId,
              );
              const isAccepted =
                acceptedVersionRecords.has(key([intake.id, candidate.id, version.id, recordKey])) ||
                (version.status === 'accepted' && accepted.has(recordKey)) ||
                decisions.has(key([candidate.id, version.id, occurrence.recordId]));
              occurrences.add(occurrenceKey);
              if (isAccepted) accepted.add(recordKey);
              const batch = occurrence.batchId ? batches.get(occurrence.batchId) : undefined;
              const scopes = bounded(batch || []);
              if (!scopes.length) {
                unscopedProposed.add(occurrenceKey);
                if (isAccepted) unscopedAccepted.add(recordKey);
              } else if (isAccepted) unscopedAccepted.delete(recordKey);
              for (const scope of scopes) {
                const row = page(scope);
                if (!row) continue;
                if (occurrence.proposalId)
                  row.proposals.add(key([intake.id, occurrence.proposalId]));
                if (version.status === 'pending') row.pendingVersions.add(versionKey);
                if (version.status === 'superseded') row.supersededVersions.add(versionKey);
                row.proposedOccurrences.add(occurrenceKey);
                if (scopes.length > 1) row.sharedProposedOccurrences.add(occurrenceKey);
                if (isAccepted) {
                  if (acceptedVersionKeys.has(versionKey) || isAccepted)
                    row.acceptedVersions.add(versionKey);
                  row.acceptedRecords.add(recordKey);
                  if (scopes.length > 1) row.sharedAcceptedRecords.add(recordKey);
                }
              }
            }
          }
      }
      const totals = counters(),
        unallocated = counters();
      const metrics = new Map<string, ScopeCounters>();
      let historicalReadsUnknown = historyIncomplete || checkpoints.length === 0;
      const add = (target: Counters, source: Counters) => {
        for (const field of Object.keys(counters()) as (keyof Counters)[])
          target[field] += source[field] || 0;
      };
      for (const checkpoint of checkpoints) {
        if (
          checkpoint.sourceHash !== byIntake.get(checkpoint.intakeId)?.sha256 ||
          checkpoint.attribution?.version !== 1
        ) {
          historicalReadsUnknown = true;
          continue;
        }
        const value = checkpoint.attribution;
        historicalReadsUnknown ||= value.historicalReadsUnknown;
        truncated ||= value.truncated;
        add(totals, value.totals);
        add(unallocated, value.unallocated);
        for (const scope of bounded(Object.values(value.scopes))) {
          if (!page(scope)) continue;
          const scopeKey = key(normalizeScope(scope));
          if (!metrics.has(scopeKey))
            metrics.set(scopeKey, {
              ...scope,
              ...counters(),
              hostReads: 0,
              acknowledgedReads: 0,
              timedHostReads: 0,
              hostReadTotalMs: 0,
              hostReadMaxMs: 0,
            });
          const target = metrics.get(scopeKey)!;
          add(target, scope);
          target.hostReads += scope.hostReads;
          target.acknowledgedReads += scope.acknowledgedReads;
          target.timedHostReads = (target.timedHostReads || 0) + (scope.timedHostReads || 0);
          target.hostReadTotalMs = (target.hostReadTotalMs || 0) + (scope.hostReadTotalMs || 0);
          target.hostReadMaxMs = Math.max(target.hostReadMaxMs || 0, scope.hostReadMaxMs || 0);
          if (scope.textLayerCountConflict) target.textLayerCountConflict = true;
          if (scope.page !== null && count(scope.textLayerCharacters)) {
            if (
              target.textLayerCharacters !== undefined &&
              target.textLayerCharacters !== scope.textLayerCharacters
            )
              target.textLayerCountConflict = true;
            else target.textLayerCharacters = scope.textLayerCharacters;
          }
        }
      }
      truncated ||=
        sources.some((source) => source.incomplete?.()) ||
        selectionIncomplete ||
        historyIncomplete ||
        omittedMetadataItems > 0 ||
        omittedSources > 0 ||
        omittedChats > 0;
      const sourceMembers = new Map<string, Set<string | null>>();
      for (const row of pages.values()) {
        if (!sourceMembers.has(row.sourceFileId)) sourceMembers.set(row.sourceFileId, new Set());
        sourceMembers.get(row.sourceFileId)!.add(row.memberId);
      }
      return {
        importId: pseudonym(id),
        historicalReadsUnknown,
        recentPageTimings: checkpoints.flatMap((checkpoint) => {
          const timing = checkpoint.pageTiming;
          return timing &&
            checkpoint.sourceHash === byIntake.get(checkpoint.intakeId)?.sha256 &&
            count(timing.turn) &&
            timing.turn === checkpoint.turns &&
            Array.isArray(timing.recentIntervalsMs) &&
            timing.recentIntervalsMs.every(
              (ms) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0,
            ) &&
            (timing.lastReadMs === null ||
              (typeof timing.lastReadMs === 'number' &&
                Number.isFinite(timing.lastReadMs) &&
                timing.lastReadMs >= 0)) &&
            (timing.lastCompletedAt === null ||
              (typeof timing.lastCompletedAt === 'string' &&
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timing.lastCompletedAt)))
            ? [
                {
                  sourceId: pseudonym(checkpoint.intakeId),
                  turn: timing.turn,
                  lastCompletedAt: timing.lastCompletedAt,
                  recentIntervalsMs: timing.recentIntervalsMs.slice(-5),
                  lastHostReadMs: timing.lastReadMs,
                  intervalMeaning:
                    'within_turn_page_completion_intervals_including_model_and_tool_work' as const,
                },
              ]
            : [];
        }),
        truncated,
        omittedScopeAssociations,
        untrackedReadScopes: checkpoints.reduce(
          (sum, checkpoint) => sum + (checkpoint.attribution?.untrackedReadScopes || 0),
          0,
        ),
        untrackedReadWindows: checkpoints.reduce(
          (sum, checkpoint) => sum + (checkpoint.attribution?.untrackedReadWindows || 0),
          0,
        ),
        requestTotals: publicCounters(totals, false, historicalReadsUnknown || truncated),
        unallocatedRequestTotals: publicCounters(
          unallocated,
          false,
          historicalReadsUnknown || truncated,
        ),
        uniqueProposals: proposals.size,
        proposedOccurrences: occurrences.size,
        acceptedRecords: accepted.size,
        unscopedProposedOccurrences: unscopedProposed.size,
        unscopedAcceptedRecords: unscopedAccepted.size,
        pages: [...pages.entries()].map(([scopeKey, row]) => {
          const measured = metrics.get(scopeKey);
          const sourceWide =
            row.page === null
              ? null
              : pages.get(
                  key({ sourceFileId: row.sourceFileId, memberId: row.memberId, page: null }),
                );
          return {
            sourceId: pseudonym(row.sourceFileId),
            memberId: row.memberId ? pseudonym(row.memberId) : null,
            page: row.page,
            hostReads: measured?.hostReads ?? 0,
            acknowledgedReads: measured?.acknowledgedReads ?? 0,
            timedHostReads: measured?.timedHostReads ?? 0,
            hostReadTotalMs: measured?.timedHostReads ? (measured.hostReadTotalMs ?? null) : null,
            hostReadMaxMs: measured?.timedHostReads ? (measured.hostReadMaxMs ?? null) : null,
            hostReadTimingComplete:
              !historicalReadsUnknown &&
              !truncated &&
              !!measured?.hostReads &&
              measured.timedHostReads === measured.hostReads,
            textLayerCharacters: measured?.textLayerCountConflict
              ? null
              : (measured?.textLayerCharacters ?? null),
            textLayerCountStatus: measured?.textLayerCountConflict
              ? ('conflicting' as const)
              : measured?.textLayerCharacters === undefined
                ? ('unknown' as const)
                : ('observed' as const),
            requestExposure: publicCounters(
              measured || counters(),
              true,
              historicalReadsUnknown || truncated,
            ),
            activeUnits: row.activeUnits.size,
            supersededUnits: row.supersededUnits.size,
            activeCoverage: Object.fromEntries(
              [...row.coverage].map(([kind, units]) => [kind, units.size]),
            ),
            proposals: row.proposals.size,
            pendingVersions: row.pendingVersions.size,
            supersededVersions: row.supersededVersions.size,
            proposedOccurrences: row.proposedOccurrences.size,
            acceptedVersions: row.acceptedVersions.size,
            acceptedRecords: row.acceptedRecords.size,
            sharedProposedOccurrences: row.sharedProposedOccurrences.size,
            sharedAcceptedRecords: row.sharedAcceptedRecords.size,
            sourceWideCoverage: sourceWide
              ? Object.fromEntries(
                  [...sourceWide.coverage].map(([kind, units]) => [kind, units.size]),
                )
              : {},
            sourceWideProposedOccurrences: sourceWide?.proposedOccurrences.size || 0,
            sourceWideAcceptedRecords: sourceWide?.acceptedRecords.size || 0,
            yieldPageUnknown:
              row.page === null ||
              truncated ||
              (sourceMembers.get(row.sourceFileId)?.size || 0) > 1 ||
              unscopedProposed.size > 0 ||
              unscopedAccepted.size > 0 ||
              (!row.proposedOccurrences.size && !!sourceWide?.proposedOccurrences.size),
          };
        }),
      };
    }),
  };
  return {
    ...report,
    exportBounds: {
      maxScopes: MAX_EXPORT_SCOPES,
      retainedScopes: exportScopes,
      maxMetadataWork: MAX_METADATA_WORK,
      metadataWork,
      omittedMetadataItems,
      omittedSources,
      omittedChats,
      partial:
        selectionIncomplete ||
        historyIncomplete ||
        omittedMetadataItems > 0 ||
        omittedSources > 0 ||
        omittedChats > 0 ||
        report.imports.some((item) => item.truncated),
    },
  };
}
