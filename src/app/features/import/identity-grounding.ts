import type { IntakeIdentityReview } from '../../../shared/intake-identity';

/** A host check may refresh eligibility; it never accepts a clinical record. */
export function hostGroundedIdentity(review: IntakeIdentityReview): boolean {
  return ['prior_confirmation', 'evidenced_match'].includes(review.status) && !review.blocking;
}

export function identityGroundingRefreshKey(
  signature: string,
  review: IntakeIdentityReview,
  reviewTokens: readonly string[],
): string {
  return JSON.stringify([
    signature,
    (review.scopeReference || review.scope)?.scopeToken,
    reviewTokens,
  ]);
}
