import { CREDENTIAL_ALIASES } from './types.ts';
import type { Attempt, CheckerState, CredentialAlias, RunHeader, Step } from './types.ts';

export interface GuidedAction {
  alias: CredentialAlias;
  step: 'create' | 'confirm' | 'recover' | 'recheck';
  afterAttemptId?: string;
}
export function actionKey(action: GuidedAction): string {
  return `${action.alias}-${action.step}-${action.afterAttemptId ?? ''}`;
}
export function registrationNames(run: RunHeader, alias: CredentialAlias) {
  if (run.flow !== 'abc-username-v1')
    return {
      name: `fictional-${run.id}-passkey-${alias}`,
      displayName: `Fictional compatibility test — passkey ${alias}`,
    };
  return {
    name: `fictional-${run.id}${alias === 'C' ? '-renamed' : ''}`,
    displayName: 'Fictional compatibility test',
  };
}
export function latestFor(state: CheckerState, action: GuidedAction): Attempt | undefined {
  return state.attempts
    .filter(
      (attempt) =>
        attempt.alias === action.alias &&
        attempt.step === action.step &&
        attempt.afterAttemptId === action.afterAttemptId,
    )
    .at(-1);
}
function follows(attempt: Attempt, earlier: Attempt): boolean {
  return (
    Number.isSafeInteger(attempt.sequence) &&
    Number.isSafeInteger(earlier.sequence) &&
    earlier.sequence! > 0 &&
    attempt.sequence! > earlier.sequence!
  );
}
function confirmedBefore(state: CheckerState, alias: CredentialAlias, failure: Attempt): boolean {
  return (
    state.credentials.some((credential) => credential.alias === alias && credential.cipher) &&
    state.attempts.some(
      (attempt) =>
        attempt.alias === alias &&
        attempt.step === 'confirm' &&
        attempt.status === 'verified' &&
        follows(failure, attempt),
    )
  );
}
export function recoveryActions(state: CheckerState, failure: Attempt): GuidedAction[] {
  if (failure.step !== 'create' || !['failed', 'interrupted'].includes(failure.status)) return [];
  return CREDENTIAL_ALIASES.filter((alias) => confirmedBefore(state, alias, failure)).map(
    (alias) => ({ alias, step: 'recover', afterAttemptId: failure.id }),
  );
}
export function isGuidedVerification(state: CheckerState, attempt: Attempt): boolean {
  if (attempt.status !== 'verified' || !attempt.finishedAt) return false;
  if (
    !state.credentials.some((credential) => credential.alias === attempt.alias && credential.cipher)
  )
    return false;
  if (attempt.step === 'recover') {
    const failure = state.attempts.find((row) => row.id === attempt.afterAttemptId);
    return (
      !!failure &&
      recoveryActions(state, failure).some((action) => action.alias === attempt.alias) &&
      follows(attempt, failure)
    );
  }
  if (attempt.step === 'recheck') {
    const enrollment = state.attempts.filter((row) => ['create', 'confirm'].includes(row.step));
    return enrollment.length > 0 && enrollment.every((row) => follows(attempt, row));
  }
  return attempt.step === 'confirm';
}
/** Derive the cursor from the existing changed-row journal, including explicit operator skips. */
export function nextGuidedAction(state: CheckerState): GuidedAction | undefined {
  for (const alias of CREDENTIAL_ALIASES) {
    const create: GuidedAction = { alias, step: 'create' };
    const creation = latestFor(state, create);
    if (!creation) return create;
    // Every failed or interrupted native creation has its own retained-access checks.
    // A later retry must not borrow an older recovery pass.
    for (const failure of state.attempts.filter(
      (row) => row.alias === alias && row.step === 'create',
    )) {
      for (const recovery of recoveryActions(state, failure)) {
        const result = latestFor(state, recovery);
        if (!result || (result.status !== 'skipped' && !isGuidedVerification(state, result)))
          return recovery;
      }
    }
    if (creation.status === 'skipped') continue;
    if (creation.status !== 'created') return create;
    const confirm: GuidedAction = { alias, step: 'confirm' };
    const confirmation = latestFor(state, confirm);
    if (!confirmation || !['verified', 'skipped'].includes(confirmation.status)) return confirm;
  }
  for (const alias of CREDENTIAL_ALIASES) {
    if (!state.credentials.some((credential) => credential.alias === alias && credential.cipher))
      continue;
    const recheck: GuidedAction = { alias, step: 'recheck' };
    const result = latestFor(state, recheck);
    if (!result || (result.status !== 'skipped' && !isGuidedVerification(state, result)))
      return recheck;
  }
  return undefined;
}
export function allGuidedCredentialsVerified(state: CheckerState): boolean {
  return CREDENTIAL_ALIASES.every((alias) => {
    const result = latestFor(state, { alias, step: 'recheck' });
    return !!result && isGuidedVerification(state, result);
  });
}
export function guidedStepUnavailable(
  state: CheckerState,
  alias: CredentialAlias,
  step: Step,
): string | undefined {
  if (step === 'confirm' && latestFor(state, { alias, step: 'create' })?.status === 'skipped')
    return 'Unavailable — no credential was returned for this slot.';
  if (step === 'recheck') {
    if (!state.credentials.some((credential) => credential.alias === alias))
      return 'Unavailable — this credential was not created.';
    if (!state.credentials.some((credential) => credential.alias === alias && credential.cipher))
      return 'Unavailable — this credential was not confirmed; no original ciphertext exists.';
  }
  return undefined;
}
export function guidedRows(state: CheckerState): GuidedAction[] {
  const rows: GuidedAction[] = [];
  for (const alias of CREDENTIAL_ALIASES) {
    rows.push({ alias, step: 'create' });
    for (const attempt of state.attempts.filter(
      (row) => row.alias === alias && row.step === 'create',
    ))
      rows.push(...recoveryActions(state, attempt));
    rows.push({ alias, step: 'confirm' });
  }
  return [...rows, ...CREDENTIAL_ALIASES.map((alias) => ({ alias, step: 'recheck' as const }))];
}
