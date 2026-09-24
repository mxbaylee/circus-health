import type {
  IntakeReportQueueBlock,
  IntakeReportQueueDetail,
  IntakeReportQueueGroup,
  IntakeReportSourceResult,
  IntakeReportSourceReview,
  IntakeReportSourceUpdate,
} from '../../shared/intake';

type DisplayedReportSource = {
  group: IntakeReportQueueGroup;
  blocks: IntakeReportQueueBlock[];
};

export type ReportSourceSaveOutcome =
  | { status: 'saved'; result: IntakeReportSourceResult; refreshed: boolean }
  | { status: 'scope_changed'; message: string; fresh: IntakeReportQueueDetail }
  | { status: 'profile_changed'; message: string };

type ReportSourceSaveOptions = {
  displayed: DisplayedReportSource;
  request: IntakeReportSourceUpdate;
  send: (request: IntakeReportSourceUpdate) => Promise<IntakeReportSourceResult>;
  loadFresh: () => Promise<IntakeReportQueueDetail>;
  isProfileCurrent: () => boolean;
  retainRequest: (request: IntakeReportSourceUpdate | null) => void;
};

type ApiFailure = { status?: unknown; code?: unknown };

const versionConflict = (cause: unknown): boolean => {
  const failure = cause as ApiFailure | null;
  return failure?.status === 409 && failure.code === 'VERSION_CONFLICT';
};

const canonical = (value: unknown): string => JSON.stringify(value);

/** Intake version and token may advance without changing anything the user reviewed. */
export function sameDisplayedSourceReview(
  displayed: IntakeReportSourceReview,
  fresh: IntakeReportSourceReview,
): boolean {
  const semanticScope = (review: IntakeReportSourceReview) => ({
    profileId: review.profileId,
    intakeId: review.intakeId,
    groupId: review.groupId,
    groupVersionId: review.groupVersionId,
    view: review.view,
    targets: review.targets,
    coverage: review.coverage,
    sourceEvidence: review.sourceEvidence,
    warning: review.warning ?? null,
  });
  return canonical(semanticScope(displayed)) === canonical(semanticScope(fresh));
}

function sourceBoundary(group: IntakeReportQueueGroup) {
  return {
    groupId: group.groupId,
    groupVersionId: group.groupVersionId,
    intakeId: group.intakeId,
    basis: group.basis,
    original: group.original,
    member: group.member,
    anchor: group.anchor,
    source: group.source,
    sourceScope: group.sourceScope ?? null,
    sourceSuggestion: group.sourceSuggestion ?? null,
    sourceLabelScope: group.sourceLabelScope ?? null,
    sourceConfirmation: group.sourceConfirmation ?? null,
    reportContext: group.reportContext ?? null,
    counts: {
      pending: group.counts.pending,
      deferred: group.counts.deferred,
      accepted: group.counts.accepted,
      keptOriginal: group.counts.keptOriginal,
      superseded: group.counts.superseded,
    },
    peopleCounts: group.peopleCounts ?? null,
  };
}

function displayedMembership(blocks: IntakeReportQueueBlock[]) {
  return blocks
    .map((block) => ({
      intakeId: block.intakeId,
      proposalId: block.proposalId,
      records: block.records
        .map((record) => ({
          recordId: record.id,
          candidateId: record.candidateId ?? null,
          candidateVersionId: record.candidateVersionId ?? null,
          queueState: record.queueState,
        }))
        .sort((left, right) => canonical(left).localeCompare(canonical(right))),
    }))
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

/**
 * The report group version is the server's immutable membership boundary. The
 * visible candidate versions are compared too so a retry never upgrades any
 * evidence the user actually saw to a newer semantic scope. Review tokens are
 * intentionally excluded: they include the global revision and intake version,
 * while report-source does not use them as an authorization boundary.
 */
export function sameDisplayedReportSource(
  displayed: DisplayedReportSource,
  fresh: IntakeReportQueueDetail,
): boolean {
  if (canonical(sourceBoundary(displayed.group)) !== canonical(sourceBoundary(fresh.group)))
    return false;
  const shown = displayedMembership(displayed.blocks);
  if (!shown.length) return true;
  const current = displayedMembership(fresh.blocks);
  return shown.every((block) => {
    const candidate = current.find(
      (item) => item.intakeId === block.intakeId && item.proposalId === block.proposalId,
    );
    return (
      !!candidate &&
      block.records.every((record) =>
        candidate.records.some((item) => canonical(item) === canonical(record)),
      )
    );
  });
}

/**
 * Retry only a definite intake-version conflict, after one fresh exact-scope
 * comparison. Ambiguous failures are left with their operation request retained.
 */
export async function saveReportSourceWithFreshness({
  displayed,
  request,
  send,
  loadFresh,
  isProfileCurrent,
  retainRequest,
}: ReportSourceSaveOptions): Promise<ReportSourceSaveOutcome> {
  retainRequest(request);
  try {
    const result = await send(request);
    retainRequest(null);
    return { status: 'saved', result, refreshed: false };
  } catch (cause) {
    if (!versionConflict(cause)) {
      // A definite client rejection can be deliberately resubmitted with a new
      // action. An uncertain transport/server response retains the exact request.
      const failure = cause as ApiFailure | null;
      if (typeof failure?.status === 'number' && failure.status >= 400 && failure.status < 500)
        retainRequest(null);
      throw cause;
    }
  }

  retainRequest(null);
  if (!isProfileCurrent())
    return {
      status: 'profile_changed',
      message: 'Profile changed before the source scope could be refreshed. No retry was sent.',
    };

  const fresh = await loadFresh();
  if (!isProfileCurrent())
    return {
      status: 'profile_changed',
      message: 'Profile changed before the source scope could be compared. No retry was sent.',
    };
  if (!sameDisplayedReportSource(displayed, fresh))
    return {
      status: 'scope_changed',
      message:
        'This report gained or changed source evidence, people, or records while you were labeling it. Your label is still entered; review the updated scope, then use it again.',
      fresh,
    };

  const retry = { ...request, version: fresh.group.intakeVersion };
  retainRequest(retry);
  try {
    const result = await send(retry);
    retainRequest(null);
    return { status: 'saved', result, refreshed: true };
  } catch (cause) {
    const failure = cause as ApiFailure | null;
    if (typeof failure?.status === 'number' && failure.status >= 400 && failure.status < 500)
      retainRequest(null);
    throw cause;
  }
}
