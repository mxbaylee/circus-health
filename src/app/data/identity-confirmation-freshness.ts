import type { Intake } from '../../shared/intake';
import type {
  IntakeIdentityConfirmation,
  IntakeIdentityReview,
  IntakeIdentityScope,
  IntakeIdentityScopeReference,
} from '../../shared/intake-identity';

export type IdentityConfirmationFreshnessOutcome =
  | { status: 'confirmed'; result: Intake; refreshed: boolean }
  | { status: 'scope_changed'; fresh: IntakeIdentityReview; message: string }
  | { status: 'context_changed' };

type IdentityConfirmationFreshnessOptions = {
  displayed: IntakeIdentityReview;
  request: IntakeIdentityConfirmation;
  send: (request: IntakeIdentityConfirmation) => Promise<Intake>;
  loadFresh: () => Promise<IntakeIdentityReview>;
  isContextCurrent: () => boolean;
  retainRequest: (request: IntakeIdentityConfirmation | null) => void;
};

type ApiFailure = { status?: unknown; code?: unknown };

const definiteClientFailure = (cause: unknown): boolean => {
  const status = (cause as ApiFailure | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
};

const versionConflict = (cause: unknown): boolean => {
  const failure = cause as ApiFailure | null;
  return failure?.status === 409 && failure.code === 'VERSION_CONFLICT';
};

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortedJsonValue(item)]),
  );
}

const canonical = (value: unknown): string => JSON.stringify(sortedJsonValue(value));

function withoutGlobalVersion(scope: IntakeIdentityScope | IntakeIdentityScopeReference) {
  const { intakeVersion: _intakeVersion, scopeToken: _scopeToken, ...boundary } = scope;
  return boundary;
}

const sha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function certifiedNativeReview(review: IntakeIdentityReview): boolean {
  const scope = review.scopeReference,
    proof = review.evidenceCommitment;
  if (
    review.scope !== null ||
    !scope ||
    scope.format !== 'health-intake-identity-scope-v2' ||
    !scope.collection ||
    typeof scope.collection !== 'object' ||
    Array.isArray(scope.collection) ||
    !sha256(scope.scopeToken) ||
    scope.collection.snapshotId !== 'identity:' + scope.scopeToken ||
    !proof ||
    typeof proof !== 'object' ||
    Array.isArray(proof) ||
    Object.keys(proof).sort().join(',') !== 'format,sha256' ||
    proof.format !== 'health-intake-identity-evidence-v1' ||
    !sha256(proof.sha256)
  )
    return false;
  const warnings = review.warningsReference;
  return (
    !warnings ||
    (warnings.format === 'health-intake-identity-warnings-v2' &&
      sha256(warnings.sha256) &&
      warnings.scopeToken === scope.scopeToken &&
      warnings.snapshotId === 'identity-warnings:' + scope.scopeToken + ':' + warnings.sha256 &&
      Number.isSafeInteger(warnings.count) &&
      warnings.count >= 0)
  );
}

function withoutNativeVersion(review: IntakeIdentityReview) {
  const scope = review.scopeReference!;
  return {
    ...review,
    scope: {
      ...withoutGlobalVersion(scope),
      collection: { ...scope.collection, snapshotId: undefined },
    },
    scopeReference: undefined,
    ...(review.warningsReference
      ? {
          warningsReference: {
            ...review.warningsReference,
            scopeToken: undefined,
            snapshotId: undefined,
          },
        }
      : {}),
  };
}

/**
 * Compare the whole displayed review. Native scopes require the host's complete
 * evidence proof before excluding version-derived snapshot bindings; inline
 * scopes compare every complete collection directly. Future fields fail closed.
 */
export function sameDisplayedIdentityReview(
  displayed: IntakeIdentityReview,
  fresh: IntakeIdentityReview,
): boolean {
  if (displayed.scopeFragmentReference || fresh.scopeFragmentReference) return false;
  if (displayed.scopeReference || fresh.scopeReference) {
    if (!certifiedNativeReview(displayed) || !certifiedNativeReview(fresh)) return false;
    return canonical(withoutNativeVersion(displayed)) === canonical(withoutNativeVersion(fresh));
  }
  if (!displayed.scope || !fresh.scope) return false;
  return (
    canonical({ ...displayed, scope: withoutGlobalVersion(displayed.scope) }) ===
    canonical({ ...fresh, scope: withoutGlobalVersion(fresh.scope) })
  );
}

function selectedFieldsRemainOffered(
  request: IntakeIdentityConfirmation,
  fresh: IntakeIdentityReview,
): boolean {
  if (!request.selfUpdate) return true;
  return (
    Object.entries(request.selfUpdate.fields) as [keyof typeof request.selfUpdate.fields, string][]
  ).every(([field, value]) => fresh.offeredSelfFields[field] === value);
}

/**
 * A definite stale intake version is write-free. Rebind the one explicit user
 * action only after one fresh, exact identity comparison, then retry once.
 * Uncertain outcomes retain the exact request and are never replayed here.
 */
export async function confirmIdentityWithFreshness({
  displayed,
  request,
  send,
  loadFresh,
  isContextCurrent,
  retainRequest,
}: IdentityConfirmationFreshnessOptions): Promise<IdentityConfirmationFreshnessOutcome> {
  if (!isContextCurrent()) return { status: 'context_changed' };
  const original = structuredClone(request);
  retainRequest(original);
  if (!isContextCurrent()) return { status: 'context_changed' };

  try {
    const result = await send(original);
    if (!isContextCurrent()) return { status: 'context_changed' };
    retainRequest(null);
    return { status: 'confirmed', result, refreshed: false };
  } catch (cause) {
    if (!isContextCurrent()) return { status: 'context_changed' };
    if (!versionConflict(cause)) {
      if (definiteClientFailure(cause)) retainRequest(null);
      throw cause;
    }
  }

  // VERSION_CONFLICT is a definite pre-write rejection for this endpoint.
  retainRequest(null);
  if (!isContextCurrent()) return { status: 'context_changed' };
  const fresh = await loadFresh();
  if (!isContextCurrent()) return { status: 'context_changed' };
  if (
    !sameDisplayedIdentityReview(displayed, fresh) ||
    !selectedFieldsRemainOffered(original, fresh)
  )
    return {
      status: 'scope_changed',
      fresh,
      message:
        'The report, identity evidence, or Self profile changed. Review the refreshed identity details before confirming.',
    };

  const retry = structuredClone({
    ...original,
    version: (fresh.scopeReference || fresh.scope)!.intakeVersion,
    scope: (fresh.scopeReference || fresh.scope)!,
  });
  if (!isContextCurrent()) return { status: 'context_changed' };
  retainRequest(retry);
  if (!isContextCurrent()) return { status: 'context_changed' };
  try {
    const result = await send(retry);
    if (!isContextCurrent()) return { status: 'context_changed' };
    retainRequest(null);
    return { status: 'confirmed', result, refreshed: true };
  } catch (cause) {
    if (!isContextCurrent()) return { status: 'context_changed' };
    if (definiteClientFailure(cause)) retainRequest(null);
    throw cause;
  }
}
