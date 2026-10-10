import type { DatabaseSync } from 'node:sqlite';
import type { Intake, IntakeExtractionPlan } from '../shared/intake.ts';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import type { IntakeReadingAccounting } from '../shared/intake-reading-accounting.ts';
import { readChat } from './assistant-journal.ts';
import { HttpError } from './database.ts';
import { accountedUnitKind } from './intake-unit-accounting.ts';
import type { ConversionCheckpoint } from './intake-continuation.ts';
import { conversionResumeContext } from './intake-continuation.ts';
import type { EvidenceIndex } from './intake-plan.ts';

/** Exact host inventory scope, separate from the model's extraction/disposition claims. */
function completeIndex(plan: IntakeExtractionPlan): boolean {
  const index = plan.index as EvidenceIndex;
  if (index.kind === 'zip') {
    const members = index.members || [];
    if (
      index.inventoryVersion !== 1 ||
      members.length !== index.totalMembers ||
      new Set(members.map((member) => member.memberId)).size !== members.length
    )
      return false;
    return members.every((member) =>
      plan.units.some(
        (unit) => unit.memberId === member.memberId && unit.sourceHash === member.sourceHash,
      ),
    );
  }
  if (!plan.units.length) return false;
  if (index.kind === 'image') return plan.units.length === 1 && plan.units[0]!.kind === 'image';
  if (index.kind === 'pdf' && Number.isSafeInteger(index.pages) && index.pages! > 0) {
    const pages = new Set(plan.units.flatMap((unit) => unit.pages || []));
    return (
      pages.size === index.pages &&
      Array.from({ length: index.pages! }, (_, i) => i + 1).every((page) => pages.has(page))
    );
  }
  return ['text', 'html'].includes(index.kind);
}
interface LinkedCheckpoint {
  conversionCheckpoint?: ConversionCheckpoint;
  reading?: { reason?: string | null };
}

export function intakeReadingAccounting(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakes: Intake[],
  batches: IntakeBatch[],
): IntakeReadingAccounting {
  const result: IntakeReadingAccounting = {
    state: intakes.length ? 'unknown' : 'empty',
    sourceCount: intakes.length,
    accountedSources: 0,
    pendingSources: 0,
    unknownSources: 0,
    parentAccountedChildren: 0,
    allSourceOccurrencesAccounted: intakes.length === 0,
    clinicalExtraction: intakes.length ? 'unknown' : 'no_sources',
    units: { total: 0, pending: 0, extractedClaims: 0, contextOnly: 0, unreadable: 0 },
    packageOccurrences: { total: 0, accounted: 0, pending: 0, unknownRoles: 0, duplicateBytes: 0 },
    dependencies: { missing: 0, uninspected: 0, ambiguous: 0 },
    hostReading: {
      checkpoints: 0,
      unknownSources: 0,
      pendingWindows: 0,
      dispositionedWindows: 0,
      exhaustedSources: 0,
    },
    pauseReasons: [],
  };
  const sourceStates = new Map<string, 'accounted' | 'pending' | 'unknown'>();
  const plans = new Map<string, IntakeExtractionPlan>();
  const latestItems = new Map<string, IntakeBatch['items'][number]>();
  for (const batch of batches)
    for (const item of batch.items)
      if (!latestItems.has(item.intakeId)) latestItems.set(item.intakeId, item);
  const pauses = new Map<string, number>();
  for (const intake of intakes) {
    const active = intake.workflow?.plans.filter((plan) => plan.status === 'active') || [];
    const plan =
      active.length === 1 && active[0]!.pins.sourceHash === intake.sha256 ? active[0] : undefined;
    if (plan) plans.set(intake.id, plan);
    let state: 'accounted' | 'pending' | 'unknown' = 'unknown';
    if (plan) {
      const complete = completeIndex(plan);
      state = complete ? 'accounted' : 'unknown';
      for (const unit of plan.units) {
        result.units.total++;
        const disposition = accountedUnitKind(plan, unit);
        if (!disposition) {
          result.units.pending++;
          if (complete) state = 'pending';
        } else if (disposition === 'extracted') result.units.extractedClaims++;
        else if (disposition === 'context') result.units.contextOnly++;
        else result.units.unreadable++;
      }
      for (const member of plan.index.members || []) {
        result.packageOccurrences.total++;
        if (member.duplicateOf) result.packageOccurrences.duplicateBytes++;
        const role = plan.packageRoles?.find((item) => item.memberId === member.memberId);
        if (!role || role.role === 'unknown') result.packageOccurrences.unknownRoles++;
        const units = plan.units.filter(
          (unit) => unit.memberId === member.memberId && unit.sourceHash === member.sourceHash,
        );
        if (units.length && units.every((unit) => accountedUnitKind(plan, unit)))
          result.packageOccurrences.accounted++;
        else result.packageOccurrences.pending++;
      }
      // References remain evidence gaps even when every source occurrence has a disposition.
      const references = [
        ...(plan.index.missingAssets || []),
        ...(plan.packageRoles || []).flatMap((role) => role.references),
      ];
      const seen = new Set<string>();
      for (const reference of references) {
        const key = JSON.stringify(reference);
        if (seen.has(key)) continue;
        seen.add(key);
        if (reference.status === 'ambiguous') result.dependencies.ambiguous++;
        else if (reference.status === 'supplied_uninspected') result.dependencies.uninspected++;
        else result.dependencies.missing++;
      }
    }
    sourceStates.set(intake.id, state);
    let checkpoint: ConversionCheckpoint | undefined;
    let reason: string | null | undefined;
    if (intake.conversionChatId) {
      try {
        const chat = readChat(root, profileId, intake.conversionChatId) as LinkedCheckpoint;
        const candidate = chat.conversionCheckpoint;
        if (
          candidate?.intakeId === intake.id &&
          candidate.sourceHash === intake.sha256 &&
          candidate.profileId === profileId &&
          Array.isArray(candidate.pending) &&
          Array.isArray(candidate.seen)
        ) {
          checkpoint = candidate;
          reason = chat.reading?.reason;
        }
      } catch (error) {
        if (!(error instanceof HttpError && error.code === 'CHAT_NOT_FOUND')) throw error;
      }
    }
    const batchItem = latestItems.get(intake.id);
    if (!checkpoint && batchItem?.sourceHash === intake.sha256)
      reason ||=
        batchItem.reading?.reason || (batchItem.status === 'paused' ? batchItem.reason : null);
    if (checkpoint) {
      result.hostReading.checkpoints++;
      const pending = intake.workflow
        ? conversionResumeContext(checkpoint, { ...intake, workflow: intake.workflow })
            .pendingReadWindows
        : checkpoint.pending.length;
      result.hostReading.pendingWindows += pending;
      result.hostReading.dispositionedWindows += checkpoint.pending.length - pending;
      if (checkpoint.seen.length && !pending && reason === 'reading_exhausted')
        result.hostReading.exhaustedSources++;
    } else result.hostReading.unknownSources++;
    if (reason) pauses.set(reason, (pauses.get(reason) || 0) + 1);
  }
  // A retained child already disposed in its parent's exact inventory is the same
  // source occurrence. Byte equality alone and an unrelated child cannot inherit it.
  for (const intake of intakes) {
    if (
      sourceStates.get(intake.id) !== 'unknown' ||
      intake.workflow?.plans.some((plan) => plan.status === 'active') ||
      !intake.parentSourceFileId
    )
      continue;
    const parent = plans.get(intake.parentSourceFileId);
    if (!parent || !completeIndex(parent)) continue;
    const stored = db
      .prepare(
        "SELECT json_extract(details_json,'$.intake.locator') locator FROM source_files WHERE id=? AND sha256=? AND json_extract(details_json,'$.intake.parentSourceFileId')=?",
      )
      .get(intake.id, intake.sha256, intake.parentSourceFileId) as { locator?: string } | undefined;
    const matchesLocator = stored ? intakeFirstLocatorMatcher(db, intake.id) : () => false;
    const member = parent.index.members?.find(
      (member) => member.sourceHash === intake.sha256 && matchesLocator(member.locator),
    );
    const units =
      member &&
      parent.units.filter(
        (unit) => unit.memberId === member.memberId && unit.sourceHash === member.sourceHash,
      );
    if (units?.length && units.every((unit) => accountedUnitKind(parent, unit))) {
      sourceStates.set(intake.id, 'accounted');
      result.parentAccountedChildren++;
    }
  }
  for (const state of sourceStates.values()) {
    if (state === 'accounted') result.accountedSources++;
    else if (state === 'pending') result.pendingSources++;
    else result.unknownSources++;
  }
  result.allSourceOccurrencesAccounted = result.accountedSources === result.sourceCount;
  result.pauseReasons = [...pauses]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, files]) => ({ reason, files }));
  const gaps =
    result.units.contextOnly +
    result.units.unreadable +
    result.packageOccurrences.unknownRoles +
    Object.values(result.dependencies).reduce((sum, count) => sum + count, 0) +
    result.hostReading.pendingWindows;
  result.state = !intakes.length
    ? 'empty'
    : result.allSourceOccurrencesAccounted
      ? gaps
        ? 'accounted_with_gaps'
        : 'accounted'
      : result.pendingSources
        ? 'pending'
        : 'unknown';
  return result;
}
import { intakeFirstLocatorMatcher } from './intake-state-access.ts';
