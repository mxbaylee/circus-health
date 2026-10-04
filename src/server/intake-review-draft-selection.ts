/** Complete host policy witnesses; transport arrays remain bounded. */
import { finishClinicalReviewWork } from './clinical-review-work.ts';
import type { IntakeIssueResolution, IntakeReviewDraft } from '../shared/intake.ts';
import { selectedSequence, type SelectedSequence } from './intake-selected-sequence.ts';
import { registerReviewRecordField } from './intake-review-selected-record.ts';
import { canonicalReviewValueChunks } from './intake-review-question-state.ts';

export interface ReviewDraftResolutionPolicy {
  values(): Iterable<IntakeIssueResolution>;
  valuesWork?(): Generator<void | IntakeIssueResolution, void, void>;
  latest(issueId: string): IntakeIssueResolution | undefined;
  known(issueId: string): IntakeIssueResolution | undefined;
  self(): IntakeIssueResolution | undefined;
}
const policies = new WeakMap<IntakeReviewDraft, ReviewDraftResolutionPolicy>();

export function bindReviewDraftResolutions(
  ...input: Parameters<typeof bindReviewDraftResolutionsWork>
) {
  return finishClinicalReviewWork(bindReviewDraftResolutionsWork(...input));
}
export function* bindReviewDraftResolutionsWork(
  draft: IntakeReviewDraft,
  policy: ReviewDraftResolutionPolicy,
  bytes: number,
) {
  let count = 0,
    used = 2,
    referenced = false;
  const inline: IntakeIssueResolution[] = [];
  for (const resolution of policy.valuesWork?.() ?? policy.values()) {
    yield;
    if (resolution === undefined) continue;
    count++;
    if (referenced) continue;
    used += Buffer.byteLength(JSON.stringify(resolution)) + 1;
    if (used > bytes) {
      referenced = true;
      inline.length = 0;
    } else inline.push(resolution);
  }
  draft.resolutions = inline;
  policies.set(draft, policy);
  if (referenced) {
    draft.resolutionsReference = { format: 'health-intake-review-draft-resolutions-v1', count };
    registerReviewRecordField(draft, 'resolutions', 'resolutionsReference', function* () {
      yield '[';
      let first = true;
      for (const resolution of policy.valuesWork?.() ?? policy.values()) {
        // Empty chunks expose index preparation without changing canonical bytes.
        if (resolution === undefined) {
          yield '';
          continue;
        }
        if (!first) yield ',';
        first = false;
        yield* canonicalReviewValueChunks(resolution);
      }
      yield ']';
    });
  }
  return draft;
}
export function reviewDraftResolutions(
  draft: IntakeReviewDraft | null | undefined,
): SelectedSequence<IntakeIssueResolution> {
  if (!draft) return selectedSequence([]);
  const policy = policies.get(draft);
  if (policy) return selectedSequence(() => policy.values());
  if (draft.resolutionsReference) throw Error('Complete review draft resolutions are unavailable');
  return selectedSequence(draft.resolutions);
}
export function latestReviewDraftResolution(
  draft: IntakeReviewDraft | null | undefined,
  issueId: string,
) {
  const policy = draft && policies.get(draft);
  return policy
    ? policy.latest(issueId)
    : reviewDraftResolutions(draft).findLast((item) => item.issueId === issueId);
}
export function knownReviewDraftResolution(
  draft: IntakeReviewDraft | null | undefined,
  issueId: string,
) {
  const policy = draft && policies.get(draft);
  return policy
    ? policy.known(issueId)
    : reviewDraftResolutions(draft).findLast(
        (item) => item.issueId === issueId && item.outcome !== 'unknown',
      );
}
export function latestSelfReviewDraftResolution(draft: IntakeReviewDraft | null | undefined) {
  const policy = draft && policies.get(draft);
  return policy
    ? policy.self()
    : reviewDraftResolutions(draft).findLast((item) => item.outcome === 'this_is_me');
}
