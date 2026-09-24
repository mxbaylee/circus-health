import { measureImportPhase } from './import-diagnostics.ts';
import { HttpError } from './database.ts';
import { getIntake, listIntakes, reviewIntake } from './intake.ts';
import { listIntakeBatches } from './intake-batch-journal.ts';
import { hasPausedIntakeReading } from '../shared/intake-batch.ts';
import { hasUnreviewedPairChoices } from '../shared/clinical-review.ts';
import { intakeReadingAccounting } from './intake-reading-accounting.ts';
import { readChat } from './assistant-journal.ts';
import { clinicalMappingLabel } from './clinical-import.ts';
import { listIntakePeopleForIntake } from './intake-people.ts';
import {
  intakeReportSourceCoverageCounts,
  intakeReportSourceForMember,
  intakeReportSourceReviewScope,
} from './intake-report-source.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { IntakePersonProposal } from '../shared/intake-people.ts';
import type {
  Intake,
  IntakeImportFeed,
  IntakeImportFeedBlock,
  IntakeImportFeedKind,
  IntakeImportFeedRecord,
  IntakeCandidate,
  IntakeCandidateVersion,
  IntakeReportGroup,
  IntakeReportQueue,
  IntakeReportQueueActivity,
  IntakeReportQueueBlock,
  IntakeReportQueueCounts,
  IntakeReportQueueDetail,
  IntakeReportQueueGroup,
  IntakeReportQueueRecord,
  IntakeReportQueueRecordState,
  IntakeReportQueueView,
  IntakeReview,
  IntakeAcceptedRecord,
} from '../shared/intake.ts';

interface QueueMember {
  candidate: IntakeCandidate;
  version: IntakeCandidateVersion;
  state: IntakeReportQueueRecordState;
  occurrence: IntakeCandidateVersion['occurrences'][number];
  index: number;
}
interface QueueGroup {
  profileId: string;
  intake: Intake;
  group: IntakeReportGroup;
  members: QueueMember[];
  people: IntakePersonProposal[];
  acceptedRecords: (IntakeAcceptedRecord & {
    candidateId: string;
    candidateVersionId: string;
    intakeId: string;
  })[];
  order: string;
}
interface QueueOptions {
  view?: string;
  limit?: string | number | null;
  cursor?: string | null;
}
const key = (candidateId: string, versionId: string): string =>
  JSON.stringify([candidateId, versionId]);
const counts = (): IntakeReportQueueCounts => ({
  pending: 0,
  deferred: 0,
  blocked: 0,
  accepted: 0,
  keptOriginal: 0,
  superseded: 0,
  questions: 0,
});
const visible = (state: IntakeReportQueueRecordState, view: IntakeReportQueueView): boolean =>
  view === 'all' || (view === 'active' ? state === 'pending' : state === 'deferred');
const personVisible = (
  state: IntakePersonProposal['state'],
  view: IntakeReportQueueView,
): boolean => view === 'all' || (view === 'active' ? state === 'pending' : state === 'later');
function options(input: QueueOptions, profileId: string, scope: string, defaultLimit: number) {
  const view = input.view || 'active';
  if (!['active', 'deferred', 'all'].includes(view))
    throw new HttpError(400, 'REPORT_QUEUE_WINDOW', 'Choose active, deferred or all reports');
  const rawLimit = input.limit == null ? defaultLimit : input.limit;
  if (
    !/^[1-9]\d*$/.test(String(rawLimit)) ||
    !Number.isSafeInteger(Number(rawLimit)) ||
    Number(rawLimit) > 100
  )
    throw new HttpError(
      400,
      'REPORT_QUEUE_WINDOW',
      'Report queue limit must be an integer from 1 to 100',
    );
  let after: string | null = null;
  if (input.cursor) {
    try {
      if (input.cursor.length > 4000) throw new Error();
      const cursor: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 4 ||
        cursor[0] !== profileId ||
        cursor[1] !== scope ||
        cursor[2] !== view ||
        typeof cursor[3] !== 'string'
      )
        throw new Error();
      after = cursor[3];
    } catch {
      throw new HttpError(400, 'REPORT_QUEUE_CURSOR', 'Reload this report queue window');
    }
  }
  return {
    view: view as IntakeReportQueueView,
    limit: Number(rawLimit),
    after,
    cursor: (last: string) =>
      Buffer.from(JSON.stringify([profileId, scope, view, last])).toString('base64url'),
  };
}
function memberState(
  intake: Intake,
  candidate: IntakeCandidate,
  version: IntakeCandidateVersion,
): QueueMember['state'] {
  if (
    version.status === 'accepted' ||
    intake.workflow!.decisions.some(
      (decision) =>
        decision.candidateId === candidate.id &&
        decision.candidateVersionId === version.id &&
        decision.action === 'accept',
    )
  )
    return 'accepted';
  if (version.status === 'kept_original') return 'kept_original';
  if (version.status === 'superseded' || candidate.versions.at(-1)!.id !== version.id)
    return 'superseded';
  const draft = intake.workflow!.reviewDrafts?.findLast(
    (item) => item.candidateId === candidate.id && item.candidateVersionId === version.id,
  );
  return draft?.disposition === 'review_later' ? 'deferred' : 'pending';
}
function collect(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakes: Intake[],
): QueueGroup[] {
  return measureImportPhase(
    'review_group_assembly',
    () => collectInternal(db, root, profileId, intakes),
    { intakeCount: intakes.length },
    { profileId },
  );
}
function collectInternal(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakes: Intake[],
): QueueGroup[] {
  const result: QueueGroup[] = [];
  const acceptedRecords = intakes.flatMap((intake) =>
    (intake.workflow?.reportAcceptances || []).flatMap(({ receipt }) =>
      receipt.receipts.flatMap((item) =>
        item.records.map((record) => ({ ...record, intakeId: item.intakeId })),
      ),
    ),
  );
  for (const intake of intakes) {
    const workflow = intake.workflow;
    if (!workflow) continue;
    const peopleByGroup = new Map<string, IntakePersonProposal[]>();
    const hasPeople = workflow.candidates.some((candidate) =>
      candidate.versions.some((version) => (version.peopleCount || 0) > 0),
    );
    for (const person of hasPeople
      ? listIntakePeopleForIntake(db, root, profileId, intake.id)
      : []) {
      const people = peopleByGroup.get(person.groupId) || [];
      people.push(person);
      peopleByGroup.set(person.groupId, people);
    }
    const owners = new Map<string, string>();
    const groups = workflow.reportGroups || [];
    // Inventory verification can replace an earlier fallback presentation reference.
    for (const group of [
      ...groups.filter((item) => item.basis === 'candidate_fallback'),
      ...groups.filter((item) => item.basis === 'report_anchor'),
    ])
      for (const version of group.versions)
        for (const member of version.members)
          owners.set(key(member.candidateId, member.candidateVersionId), group.id);
    const candidates = new Map(workflow.candidates.map((candidate) => [candidate.id, candidate]));
    for (const [index, group] of groups.entries()) {
      const members: QueueMember[] = [],
        seen = new Set<string>();
      for (const snapshot of group.versions)
        for (const member of snapshot.members) {
          const identity = key(member.candidateId, member.candidateVersionId);
          if (seen.has(identity) || owners.get(identity) !== group.id) continue;
          seen.add(identity);
          const candidate = candidates.get(member.candidateId),
            version = candidate?.versions.find((item) => item.id === member.candidateVersionId);
          if (!candidate || !version || version.sourceContext || version.peopleOnly) continue;
          const draft = workflow.reviewDrafts?.findLast(
            (item) => item.candidateId === candidate.id && item.candidateVersionId === version.id,
          );
          const occurrence =
            version.occurrences.findLast(
              (item) => item.recordId === draft?.recordId && item.proposalId === draft?.proposalId,
            ) || version.occurrences.at(-1);
          if (!occurrence) continue;
          members.push({
            candidate,
            version,
            occurrence,
            state: memberState(intake, candidate, version),
            index: members.length,
          });
        }
      const people = peopleByGroup.get(group.id) || [];
      if (!members.length && !people.length) continue;
      result.push({
        profileId,
        intake,
        group,
        members,
        people,
        acceptedRecords,
        order:
          group.discoveryOrder === undefined
            ? `0:${group.versions[0]!.createdAt}:${intake.id}:${String(index).padStart(12, '0')}:${group.id}`
            : `1:${String(group.discoveryOrder).padStart(20, '0')}:${group.id}`,
      });
    }
  }
  return result.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
}
function allIntakes(db: DatabaseSync, root: string, profileId: string): Intake[] {
  return measureImportPhase(
    'review_feed_query',
    () => allIntakesInternal(db, root, profileId),
    {},
    { profileId },
  );
}
function allIntakesInternal(db: DatabaseSync, root: string, profileId: string): Intake[] {
  const intakes: Intake[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = listIntakes(db, profileId, { offset, limit: 100 }, root);
    intakes.push(...page.data);
    if (page.complete) return intakes;
  }
}
function reader(db: DatabaseSync, root: string, profileId: string) {
  const cache = new Map<
    string,
    { review: IntakeReview; records: Map<string, IntakeReview['records'][number]> }
  >();
  return (
    entry: QueueGroup,
    member: QueueMember,
  ): { review: IntakeReview; record: IntakeReportQueueRecord } => {
    const cacheKey = JSON.stringify([entry.intake.id, member.occurrence.proposalId]);
    let cached = cache.get(cacheKey);
    if (!cached) {
      const review = measureImportPhase(
        'review_proposal_assembly',
        () => reviewIntake(db, root, profileId, entry.intake.id, member.occurrence.proposalId),
        {},
        { profileId },
      );
      cached = {
        review,
        records: new Map(
          review.records.map((record) => [
            JSON.stringify([record.id, record.candidateId, record.candidateVersionId]),
            record,
          ]),
        ),
      };
      cache.set(cacheKey, cached);
    }
    const { review } = cached;
    const record = cached.records.get(
      JSON.stringify([member.occurrence.recordId, member.candidate.id, member.version.id]),
    );
    if (!record)
      throw new HttpError(
        409,
        'REPORT_REFERENCE_UNAVAILABLE',
        'A report reference no longer matches its retained proposal; inspect the original',
      );
    const blocked =
      hasUnreviewedPairChoices(record) ||
      record.classification === 'unsupported' ||
      record.identityReview?.blocking === true ||
      !!record.issues?.some((issue) => issue.blocking && issue.status !== 'resolved');
    return {
      review,
      record: {
        ...record,
        queueState: member.state,
        selectable: (member.state === 'pending' || member.state === 'deferred') && !blocked,
      },
    };
  };
}
type Reader = ReturnType<typeof reader>;
function summarize(entry: QueueGroup, read: Reader): IntakeReportQueueGroup {
  const tally = counts(),
    dates = new Set<string | null>();
  for (const member of entry.members) {
    const state = member.state;
    if (state === 'kept_original') tally.keptOriginal++;
    else tally[state]++;
    if (state !== 'pending' && state !== 'deferred') continue;
    const { record } = read(entry, member);
    if (!record.selectable) tally.blocked++;
    tally.questions +=
      record.issues?.filter((issue) => issue.kind !== 'information' && issue.status !== 'resolved')
        .length || 0;
    const date = record.mapping.documentDate || record.mapping.date;
    dates.add(
      typeof date === 'string' &&
        /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(date) &&
        !record.issues?.some((issue) => issue.kind === 'date' && issue.status !== 'resolved')
        ? date
        : null,
    );
  }
  const { intake, group } = entry;
  const currentMember = entry.members.find(
    (member) => member.candidate.versions.at(-1)?.id === member.version.id,
  );
  const fallbackTitle =
    group.basis === 'candidate_fallback' && currentMember
      ? clinicalMappingLabel(read(entry, currentMember).record.mapping).trim()
      : '';
  const peopleCounts = { pending: 0, later: 0, excluded: 0, saved: 0 };
  for (const person of entry.people) peopleCounts[person.state]++;
  const member = group.memberId
    ? intake
        .workflow!.plans.flatMap((plan) => plan.index.members || [])
        .find((item) => item.memberId === group.memberId)
    : null;
  const reportContext = group.versions.at(-1)!.context;
  const currentSourceScope = intakeReportSourceReviewScope(
    intake.workflow!,
    entry.profileId,
    intake.id,
    group.id,
    'all',
  );
  const currentResolutions = (currentSourceScope?.entries || []).map((sourceEntry) =>
    intakeReportSourceForMember(
      intake.workflow!.reportSourceConfirmations,
      [
        {
          groupId: sourceEntry.sourceRef.groupId,
          groupVersionId: sourceEntry.sourceRef.groupVersionId,
        },
      ],
      sourceEntry,
      sourceEntry.occurrence,
    ),
  );
  const firstResolution = currentResolutions[0] || null;
  const sourceResolution =
    firstResolution &&
    currentResolutions.every(
      (resolution) =>
        resolution?.confirmation.operationId === firstResolution.confirmation.operationId,
    )
      ? firstResolution
      : null;
  const sourceConfirmation = sourceResolution?.confirmation;
  const currentSources = currentResolutions.map(
    (resolution) => resolution?.confirmation.source || null,
  );
  const groupMemberKeys = new Set(
    entry.members.map((member) => key(member.candidate.id, member.version.id)),
  );
  const savedSources = entry.acceptedRecords
    .filter(
      (record) =>
        record.intakeId === intake.id &&
        groupMemberKeys.has(key(record.candidateId, record.candidateVersionId)),
    )
    .map((record) =>
      record.reviewedSource?.groupId === group.id ? record.reviewedSource.source : null,
    );
  const sourceCoverage = {
    current: intakeReportSourceCoverageCounts(currentSources),
    saved: intakeReportSourceCoverageCounts(savedSources),
  };
  const currentReportSource =
    sourceCoverage.current.status === 'single'
      ? sourceCoverage.current.bySource[0]?.source || null
      : null;
  const savedReportSource =
    sourceCoverage.current.status === 'empty' && sourceCoverage.saved.status === 'single'
      ? sourceCoverage.saved.bySource[0]?.source || null
      : null;
  const effectiveReportSource = currentReportSource || savedReportSource;
  const intakeSource = intake.metadata?.source || null;
  const issuerSource = group.sourceSystem || null;
  return {
    groupId: group.id,
    groupVersionId: group.versions.at(-1)!.id,
    intakeId: intake.id,
    intakeVersion: intake.version,
    discoveryOrder: group.discoveryOrder ?? null,
    title:
      group.basis === 'candidate_fallback'
        ? fallbackTitle || entry.people[0]?.title || intake.filename
        : group.versions.at(-1)!.title,
    source: effectiveReportSource || intakeSource || issuerSource,
    sourceScope: effectiveReportSource
      ? 'report'
      : intakeSource
        ? 'intake'
        : issuerSource
          ? 'issuer'
          : null,
    ...(group.basis === 'report_anchor' &&
    group.report?.anchor &&
    tally.pending + tally.deferred > 0
      ? {
          sourceLabelScope: {
            contextId: group.versions.at(-1)!.id,
            evidence: {
              label: 'Report original',
              locator: group.report.anchor.locator,
              contentUrl: intake.contentUrl,
            },
          },
        }
      : {}),
    ...(sourceConfirmation
      ? {
          sourceConfirmation: {
            operationId: sourceConfirmation.operationId,
            groupVersionId: sourceResolution.coverage.groupVersionId,
            contextId: sourceResolution.coverage.contextId,
            memberCount: sourceCoverage.current.covered,
          },
        }
      : {}),
    ...(!effectiveReportSource && reportContext?.sourceSuggestion
      ? {
          sourceSuggestion: {
            value: reportContext.sourceSuggestion.value,
            contextId: reportContext.contextId,
            evidence: {
              label: 'Shared report context',
              locator: reportContext.sourceSuggestion.locator,
              contentUrl: intake.contentUrl,
            },
          },
        }
      : {}),
    ...(reportContext
      ? {
          reportContext: {
            contextId: reportContext.contextId,
            status: reportContext.status,
            detail: reportContext.detail,
          },
        }
      : {}),
    date: dates.size === 1 ? [...dates][0]! : null,
    basis: group.basis,
    original: {
      filename: intake.filename,
      contentUrl: intake.contentUrl,
      parentSourceFileId: intake.parentSourceFileId || null,
    },
    member: group.memberId
      ? {
          memberId: group.memberId,
          filename: member?.filename || null,
          locator: member?.locator || null,
        }
      : null,
    anchor: group.report?.anchor || null,
    counts: tally,
    peopleCounts,
    sourceCoverage,
  };
}
function activity(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakes: Intake[],
  entries: QueueGroup[],
): IntakeReportQueueActivity {
  const batches = listIntakeBatches(root, profileId),
    visibleIds = new Set(intakes.map((intake) => intake.id)),
    seen = new Set<string>();
  // A user can resume the linked conversion in Assistant after its batch ends.
  // Its current, exact-source run takes precedence over an older paused batch item.
  for (const item of intakes) {
    if (!item.conversionChatId) continue;
    try {
      const chat = readChat(root, profileId, item.conversionChatId) as {
        status?: string;
        context?: { intakeId?: string };
        conversionCheckpoint?: { profileId?: string; intakeId?: string; sourceHash?: string };
      };
      const checkpoint = chat.conversionCheckpoint;
      if (
        chat.status === 'running' &&
        chat.context?.intakeId === item.id &&
        checkpoint?.profileId === profileId &&
        checkpoint.intakeId === item.id &&
        checkpoint.sourceHash === item.sha256
      )
        seen.add(item.id);
    } catch (error) {
      if (!(error instanceof HttpError && error.code === 'CHAT_NOT_FOUND')) throw error;
    }
  }
  let runningFiles = seen.size,
    pausedFiles = 0,
    queuedFiles = 0;
  for (const batch of batches)
    for (const item of batch.items) {
      if (!visibleIds.has(item.intakeId) || seen.has(item.intakeId)) continue;
      seen.add(item.intakeId);
      if (batch.status === 'running' && ['starting', 'running'].includes(item.status))
        runningFiles++;
      else if (batch.status === 'running' && item.status === 'queued') queuedFiles++;
      else if (
        hasPausedIntakeReading(item) ||
        ((batch.status === 'paused' || batch.status === 'stopped') &&
          ['queued', 'starting', 'running'].includes(item.status)) ||
        (item.status === 'review_ready' && item.reason === 'model_unavailable')
      )
        pausedFiles++;
    }
  // A complete-response model claim or fully inspected plan is not complete extraction.
  return {
    readingAccounting: intakeReadingAccounting(db, root, profileId, intakes, batches),
    runningFiles,
    pausedFiles,
    queuedFiles,
    filesAwaitingConversion: intakes.filter(
      (intake) =>
        !intake.validation.valid && !intake.proposals.length && intake.state !== 'kept_original',
    ).length,
    remainingUnits: intakes.reduce((sum, intake) => sum + (intake.pendingWorkCount || 0), 0),
    extractionUnknownFiles: intakes.length,
    extractionComplete: intakes.length === 0,
    allCurrentReportsReviewed: entries.every(
      (entry) =>
        entry.members.every(
          (member) => member.state !== 'pending' && member.state !== 'deferred',
        ) && entry.people.every((person) => person.state !== 'pending' && person.state !== 'later'),
    ),
  };
}
export function listIntakeReportQueue(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: QueueOptions = {},
): IntakeReportQueue {
  const window = options(input, profileId, 'queue', 30),
    intakes = allIntakes(db, root, profileId),
    all = collect(db, root, profileId, intakes);
  const matching = all.filter(
    (entry) =>
      entry.members.some((member) => visible(member.state, window.view)) ||
      entry.people.some((person) => personVisible(person.state, window.view)),
  );
  const remaining = matching.filter((entry) => window.after === null || entry.order > window.after);
  const page = remaining.slice(0, window.limit),
    read = reader(db, root, profileId);
  return {
    view: window.view,
    groups: page.map((entry) => summarize(entry, read)),
    totalGroups: matching.length,
    nextCursor: remaining.length > page.length ? window.cursor(page.at(-1)!.order) : null,
    activity: activity(db, root, profileId, intakes, all),
  };
}
export function getIntakeReportQueueGroup(
  db: DatabaseSync,
  root: string,
  profileId: string,
  groupId: string,
  input: QueueOptions = {},
): IntakeReportQueueDetail {
  const window = options(input, profileId, groupId, 50),
    intakes = allIntakes(db, root, profileId);
  const entry = collect(db, root, profileId, intakes).find((item) => item.group.id === groupId);
  if (!entry) throw new HttpError(404, 'REPORT_GROUP_NOT_FOUND', 'Report group not found');
  // Assert the source is still profile-scoped and visible through the same intake owner boundary.
  getIntake(db, root, profileId, entry.intake.id);
  const read = reader(db, root, profileId),
    matching = entry.members.filter((member) => visible(member.state, window.view));
  const order = (member: QueueMember) =>
    String(member.index).padStart(12, '0') + ':' + key(member.candidate.id, member.version.id);
  const remaining = matching.filter(
      (member) => window.after === null || order(member) > window.after,
    ),
    page = remaining.slice(0, window.limit);
  const blocks = new Map<string | null, IntakeReportQueueBlock>();
  for (const member of page) {
    const { review, record } = read(entry, member);
    let block = blocks.get(review.proposalId);
    if (!block) {
      block = {
        intakeId: entry.intake.id,
        proposalId: review.proposalId,
        intakeVersion: review.version,
        reviewToken: review.reviewToken,
        proposalContentUrl: review.proposalId
          ? entry.intake.proposals.find((proposal) => proposal.id === review.proposalId)!.contentUrl
          : entry.intake.contentUrl,
        records: [],
      };
      blocks.set(review.proposalId, block);
    }
    block.records.push(record);
  }
  return {
    view: window.view,
    group: summarize(entry, read),
    blocks: [...blocks.values()],
    totalRecords: matching.length,
    nextCursor: remaining.length > page.length ? window.cursor(order(page.at(-1)!)) : null,
  };
}

interface FeedOptions extends QueueOptions {
  state?: string | null;
  q?: string | null;
  kind?: string | null;
  edited?: string | null;
  peopleCursor?: string | null;
}
const feedKinds: IntakeImportFeedKind[] = [
  'test',
  'prescription',
  'vision',
  'procedure',
  'history',
  'unsupported',
  'person',
];
function feedKind(record: IntakeReportQueueRecord): IntakeImportFeedRecord['feedKind'] {
  if (record.mapping.opticalPrescription) return 'vision';
  switch (record.kind) {
    case 'observation':
      return 'test';
    case 'medication':
      return 'prescription';
    case 'procedure':
      return 'procedure';
    case 'document':
      return 'history';
    default:
      return 'unsupported';
  }
}
/** One bounded response across reports; mutations still use the exact retained review blocks. */
export function listIntakeImportFeed(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: FeedOptions = {},
): IntakeImportFeed {
  const query = (input.q || '').trim().toLowerCase();
  if (
    query.length > 300 ||
    (input.state &&
      !['pending', 'deferred', 'accepted', 'kept_original', 'superseded'].includes(input.state)) ||
    (input.kind && !feedKinds.includes(input.kind as IntakeImportFeedKind)) ||
    (input.edited != null && !['true', 'false'].includes(input.edited))
  )
    throw new HttpError(
      400,
      'IMPORT_FEED_FILTER',
      'Choose a supported kind, search up to 300 characters and edited=true or false',
    );
  const edited = input.edited === 'true';
  const scope = JSON.stringify([
    'import-feed',
    query,
    input.kind || null,
    edited,
    input.state || null,
  ]);
  const window = options(input, profileId, scope, 50);
  const peopleWindow = options(
    { view: window.view, limit: window.limit, cursor: input.peopleCursor },
    profileId,
    'import-feed-people',
    50,
  );
  const intakes = allIntakes(db, root, profileId);
  const entries = collect(db, root, profileId, intakes);
  const read = reader(db, root, profileId);
  const summaries = new Map(entries.map((entry) => [entry.group.id, summarize(entry, read)]));
  const tally = counts();
  const kindCounts = Object.fromEntries(
    feedKinds.map((kind) => [kind, 0]),
  ) as IntakeImportFeed['kindCounts'];
  const peopleCounts = { pending: 0, later: 0, excluded: 0, saved: 0 };
  const matching: {
    entry: QueueGroup;
    member: QueueMember;
    record: IntakeImportFeedRecord;
    review: IntakeReview;
    order: string;
  }[] = [];
  for (const entry of entries) {
    const summary = summaries.get(entry.group.id)!;
    for (const name of Object.keys(tally) as (keyof typeof tally)[])
      tally[name] += summary.counts[name];
    for (const person of entry.people) {
      peopleCounts[person.state]++;
      if (personVisible(person.state, window.view)) kindCounts.person++;
    }
    for (const member of entry.members) {
      if (!visible(member.state, window.view) || (input.state && member.state !== input.state))
        continue;
      const { review, record: raw } = read(entry, member);
      const order =
        entry.order +
        ':' +
        String(member.index).padStart(12, '0') +
        ':' +
        key(member.candidate.id, member.version.id);
      const record: IntakeImportFeedRecord = {
        ...raw,
        feedKey: JSON.stringify([entry.intake.id, member.candidate.id, member.version.id]),
        feedOrder: order,
        feedKind: feedKind(raw),
        manuallyEdited: raw.manuallyEdited === true,
      };
      if (edited && !record.manuallyEdited) continue;
      const searchable = [
        record.title,
        summary.title,
        summary.source,
        summary.original.filename,
        summary.member?.filename,
        ...Object.values(record.mapping).filter((value) => typeof value === 'string'),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (query && !searchable.includes(query)) continue;
      kindCounts[record.feedKind]++;
      if (input.kind && input.kind !== record.feedKind) continue;
      matching.push({
        entry,
        member,
        record,
        review,
        order,
      });
    }
  }
  const remaining = matching.filter((row) => window.after === null || row.order > window.after);
  const page = remaining.slice(0, window.limit);
  const blocks = new Map<string, IntakeImportFeedBlock>();
  for (const { entry, record, review } of page) {
    const blockKey = JSON.stringify([entry.group.id, entry.intake.id, review.proposalId]);
    let block = blocks.get(blockKey);
    if (!block) {
      block = {
        groupId: entry.group.id,
        intakeId: entry.intake.id,
        proposalId: review.proposalId,
        intakeVersion: review.version,
        reviewToken: review.reviewToken,
        proposalContentUrl: review.proposalId
          ? entry.intake.proposals.find((proposal) => proposal.id === review.proposalId)!.contentUrl
          : entry.intake.contentUrl,
        records: [],
      };
      blocks.set(blockKey, block);
    }
    block.records.push(record);
  }
  const peopleGroups = entries.filter((entry) =>
    entry.people.some((person) => personVisible(person.state, window.view)),
  );
  const peopleRemaining = peopleGroups.filter(
    (entry) => peopleWindow.after === null || entry.order > peopleWindow.after,
  );
  const peoplePage = peopleRemaining.slice(0, peopleWindow.limit);
  return {
    view: window.view,
    groups: [...new Set(page.map((row) => row.entry.group.id))].map((id) => summaries.get(id)!),
    blocks: [...blocks.values()],
    totalRecords: matching.length,
    totalGroups: new Set(matching.map((row) => row.entry.group.id)).size,
    nextCursor: remaining.length > page.length ? window.cursor(page.at(-1)!.order) : null,
    counts: tally,
    kindCounts,
    people: {
      groups: peoplePage.map((entry) => summaries.get(entry.group.id)!),
      totalGroups: peopleGroups.length,
      counts: peopleCounts,
      nextCursor:
        peopleRemaining.length > peoplePage.length
          ? peopleWindow.cursor(peoplePage.at(-1)!.order)
          : null,
    },
    activity: activity(db, root, profileId, intakes, entries),
  };
}
