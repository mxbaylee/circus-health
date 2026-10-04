import type { IntakeClinicalReviewContext } from '../../../shared/intake-clinical-review';
import type { IntakePairScope } from '../../../shared/clinical-review';
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
      prior.requestRevision + 1 !== commit.revision ||
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
