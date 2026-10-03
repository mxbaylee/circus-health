import type { Attempt, CheckerState } from './types.ts';

/** Local evidence only; this editable record is never an authenticator attestation. */
export function isVerifiedReturnToA(state: CheckerState, attempt: Attempt): boolean {
  const startedAt = Date.parse(attempt.startedAt);
  return (
    attempt.alias === 'A' &&
    attempt.step === 'use-after-b' &&
    attempt.status === 'verified' &&
    Number.isFinite(startedAt) &&
    state.credentials.some((credential) => credential.alias === 'B') &&
    state.attempts.some(
      (creation) =>
        creation.alias === 'B' &&
        creation.step === 'create' &&
        creation.status === 'created' &&
        creation.finishedAt !== undefined &&
        Date.parse(creation.finishedAt) <= startedAt,
    )
  );
}
