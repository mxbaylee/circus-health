import type { IntakeClinicalReviewContext } from '../../../shared/intake-clinical-review';
import type { IntakePairScope } from '../../../shared/clinical-review';
import type { IntakeReviewDraftTransition } from '../../../shared/intake-review-draft-transition';
import type {
  IntakeReviewDecision,
  IntakeReviewDraftUpdate,
  IntakeReviewRecord,
} from '../../../shared/intake';

/** Memory-only proof of one successful write by this mounted draft editor. */
export interface ReviewDraftPairCommit {
  profileId: string;
  intakeId: string;
  candidateId: string;
  request: IntakeReviewDraftUpdate;
  version: number;
  revision: number;
  transition?: IntakeReviewDraftTransition;
}

export function ownRevisionTransition(commit: ReviewDraftPairCommit, priorRevision: number) {
  const transition = commit.transition;
  if (transition === undefined) return priorRevision + 1 === commit.revision;
  return (
    transition !== null &&
    transition.format === 'health-intake-own-draft-transition-v1' &&
    transition.profileId === commit.profileId &&
    transition.intakeId === commit.intakeId &&
    transition.proposalId === commit.request.proposalId &&
    transition.recordId === commit.request.recordId &&
    transition.candidateId === commit.candidateId &&
    transition.candidateVersionId === commit.request.candidateVersionId &&
    transition.operationId === commit.request.operationId &&
    transition.fromVersion === commit.request.version &&
    transition.toVersion === commit.version &&
    Number.isSafeInteger(transition.fromRevision) &&
    transition.fromRevision >= 0 &&
    Number.isSafeInteger(transition.toRevision) &&
    transition.toRevision > transition.fromRevision &&
    transition.fromRevision === priorRevision &&
    transition.toRevision === commit.revision
  );
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sorted(item)]),
  );
}
const same = (left: unknown, right: unknown) =>
  JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));

function unchangedPair(before: IntakePairScope | undefined, after: IntakePairScope | undefined) {
  if (before?.format !== 'intake-pair-scope-v2' || after?.format !== 'intake-pair-scope-v2')
    return false;
  const keys = [
    'format',
    'profileId',
    'requestRevision',
    'intakeVersion',
    'contextHash',
    'incoming',
    'saved',
    'activeAttachment',
    'token',
  ];
  if ([before, after].some((scope) => Object.keys(scope).some((key) => !keys.includes(key))))
    return false;
  const semantic = (scope: typeof before) => {
    const { requestRevision: _revision, intakeVersion: _version, token: _token, ...pins } = scope;
    return pins;
  };
  return same(semantic(before), semantic(after));
}

/**
 * Refresh only the transport pins advanced by our own successful draft write.
 * A general refresh, a remount, or any intervening mutation grants no such proof.
 * The server still validates the complete refreshed scope at clinical acceptance.
 */
export function refreshPairScopesAfterOwnDraft(
  profileId: string,
  review: IntakeClinicalReviewContext,
  record: IntakeReviewRecord,
  decision: IntakeReviewDecision,
  commit?: ReviewDraftPairCommit,
): IntakeReviewDecision {
  if (!decision.comparisons?.length || !commit) return decision;
  const request = commit.request;
  const stored = record.draft;
  // The draft API persists only editable fields; full review mappings also carry
  // immutable envelope/provenance metadata. Restore that baseline, then compare
  // every effective field instead of ignoring keys absent from the sparse DTO.
  const storedDecision = stored?.decision && {
    ...stored.decision,
    mapping: { ...record.mapping, ...stored.decision.mapping },
  };
  if (
    commit.profileId !== profileId ||
    commit.intakeId !== review.intakeId ||
    request.proposalId !== review.proposalId ||
    request.recordId !== record.id ||
    commit.candidateId !== record.candidateId ||
    request.candidateVersionId !== record.candidateVersionId ||
    commit.version !== request.version + 1 ||
    review.version !== commit.version ||
    !Number.isSafeInteger(commit.revision) ||
    stored?.id !== request.operationId ||
    stored.candidateId !== commit.candidateId ||
    stored.candidateVersionId !== request.candidateVersionId ||
    stored.proposalId !== request.proposalId ||
    stored.recordId !== request.recordId ||
    stored.disposition !== 'pending' ||
    request.disposition !== 'pending' ||
    !same(storedDecision, request.decision) ||
    !same(decision, request.decision) ||
    !same({ ...record.mapping, ...stored.mapping }, request.mapping) ||
    !same(record.mapping, decision.mapping) ||
    !same(stored.resolutions, request.resolutions) ||
    !same(stored.answers || {}, request.answers || {})
  )
    return decision;
  const refreshed = [];
  for (const choice of decision.comparisons) {
    const fresh = record.comparisons?.find((item) => item.id === choice.otherRecordId)?.scope;
    if (same(choice.scope, fresh) && fresh) {
      refreshed.push(choice);
      continue;
    }
    const prior = choice.scope;
    if (
      !unchangedPair(prior, fresh) ||
      prior?.format !== 'intake-pair-scope-v2' ||
      fresh?.format !== 'intake-pair-scope-v2' ||
      prior.profileId !== profileId ||
      prior.intakeVersion !== request.version ||
      fresh.intakeVersion !== commit.version ||
      !ownRevisionTransition(commit, prior.requestRevision) ||
      fresh.requestRevision !== commit.revision ||
      !prior.token ||
      !fresh.token ||
      fresh.saved.recordId !== choice.otherRecordId
    )
      return decision;
    refreshed.push({ ...choice, scope: fresh });
  }
  return { ...decision, comparisons: refreshed };
}
