import type { Attempt, CheckerState } from './types.ts';

function follows(attempt: Attempt, earlier: Attempt): boolean {
  if (attempt.sequence !== undefined && earlier.sequence !== undefined)
    return (
      Number.isSafeInteger(attempt.sequence) &&
      Number.isSafeInteger(earlier.sequence) &&
      earlier.sequence > 0 &&
      earlier.sequence < attempt.sequence
    );
  const startedAt = Date.parse(attempt.startedAt);
  return (
    earlier.finishedAt !== undefined &&
    Number.isFinite(startedAt) &&
    Date.parse(earlier.finishedAt) <= startedAt
  );
}

export function latestBCreation(state: CheckerState): Attempt | undefined {
  return state.attempts
    .filter((attempt) => attempt.alias === 'B' && attempt.step === 'create')
    .at(-1);
}

/** A recovery check refers to one failed creation, never to a successful enrollment. */
export function isVerifiedAAfterFailedB(state: CheckerState, attempt: Attempt): boolean {
  const failure = state.attempts.find((item) => item.id === attempt.afterAttemptId);
  return (
    attempt.alias === 'A' &&
    attempt.step === 'use-after-b-failed' &&
    attempt.status === 'verified' &&
    failure?.alias === 'B' &&
    failure.step === 'create' &&
    failure.status === 'failed' &&
    failure.finishedAt !== undefined &&
    follows(attempt, failure)
  );
}

/** Local evidence only; this editable record is never an authenticator attestation. */
export function isVerifiedReturnToA(state: CheckerState, attempt: Attempt): boolean {
  return (
    attempt.alias === 'A' &&
    attempt.step === 'use-after-b' &&
    attempt.status === 'verified' &&
    state.credentials.some((credential) => credential.alias === 'B') &&
    state.attempts.some(
      (creation) =>
        creation.alias === 'B' &&
        creation.step === 'create' &&
        creation.status === 'created' &&
        creation.finishedAt !== undefined &&
        follows(attempt, creation),
    )
  );
}
