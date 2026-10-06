import type { Attempt, CheckerState, CredentialAlias, Step } from './types.ts';

export const GUIDED_ALIASES = ['A', 'B', 'C'] as const;
export interface GuidedTask {
  key: string;
  alias: CredentialAlias;
  step: Step;
  title: string;
  afterAttemptId?: string;
  attempt?: Attempt;
  result: string;
  active: boolean;
}

const follows = (later: Attempt, earlier: Attempt) =>
  later.sequence !== undefined &&
  earlier.sequence !== undefined &&
  earlier.sequence > 0 &&
  later.sequence > earlier.sequence;
const failed = (attempt?: Attempt) =>
  attempt?.status === 'failed' || attempt?.status === 'interrupted';

export function verifiedRetention(state: CheckerState, attempt: Attempt): boolean {
  const failure = state.attempts.find((row) => row.id === attempt.afterAttemptId);
  return (
    attempt.step === 'retained' &&
    attempt.status === 'verified' &&
    !!failure &&
    failed(failure) &&
    ['create', 'confirm'].includes(failure.step) &&
    attempt.alias !== failure.alias &&
    follows(attempt, failure) &&
    state.credentials.some((item) => item.alias === attempt.alias && item.cipher) &&
    state.attempts.some(
      (row) =>
        row.alias === attempt.alias &&
        row.step === 'confirm' &&
        row.status === 'verified' &&
        follows(failure, row),
    )
  );
}

const afterEnrollment = (state: CheckerState, attempt: Attempt) =>
  state.attempts
    .filter((row) => row.step === 'create' || row.step === 'confirm')
    .every((row) => follows(attempt, row));

export function verifiedFinal(state: CheckerState, attempt: Attempt): boolean {
  return (
    attempt.step === 'use-1' &&
    attempt.status === 'verified' &&
    state.credentials.some((item) => item.alias === attempt.alias && item.cipher) &&
    state.attempts.some(
      (row) =>
        row.alias === attempt.alias &&
        row.step === 'confirm' &&
        row.status === 'verified' &&
        follows(attempt, row),
    ) &&
    afterEnrollment(state, attempt)
  );
}

/** One ordered UI/controller/report contract; skip is an operator decision, never a pass. */
export function guidedPlan(state: CheckerState): GuidedTask[] {
  const rows: GuidedTask[] = [];
  let waiting = false;
  const latest = (alias: CredentialAlias, step: Step, afterAttemptId?: string) =>
    state.attempts
      .filter(
        (row) => row.alias === alias && row.step === step && row.afterAttemptId === afterAttemptId,
      )
      .at(-1);
  const add = (
    alias: CredentialAlias,
    step: Step,
    title: string,
    afterAttemptId?: string,
  ): GuidedTask => {
    const attempt = latest(alias, step, afterAttemptId);
    const row: GuidedTask = {
      key: `${alias}-${step}-${afterAttemptId ?? ''}`,
      alias,
      step,
      title,
      ...(afterAttemptId ? { afterAttemptId } : {}),
      attempt,
      result: attempt?.status ?? 'not attempted',
      active: false,
    };
    rows.push(row);
    return row;
  };
  const steps = [
    ...GUIDED_ALIASES.flatMap((alias) => [
      {
        alias,
        step: 'create' as const,
        title: `Create ${alias}${alias === 'B' ? ' · same username as A' : alias === 'C' ? ' · changed username' : ''}`,
      },
      { alias, step: 'confirm' as const, title: `Verify ${alias}` },
    ]),
    ...GUIDED_ALIASES.map((alias) => ({
      alias,
      step: 'use-1' as const,
      title: `Recheck ${alias}`,
    })),
  ];
  for (const { alias, step, title } of steps) {
    const row = add(alias, step, title);
    if (waiting) {
      row.result = 'waiting for earlier steps';
      continue;
    }
    const credential = state.credentials.find((item) => item.alias === alias);
    if (step !== 'create' && (!credential || (step === 'use-1' && !credential.cipher))) {
      row.result = credential
        ? 'not applicable · credential not confirmed'
        : 'not applicable · credential not created';
      continue;
    }
    const attempt = row.attempt;
    const complete =
      step === 'create'
        ? attempt?.status === 'created' && !!credential
        : step === 'confirm'
          ? attempt?.status === 'verified' && !!credential?.cipher
          : !!attempt && verifiedFinal(state, attempt);
    // Resuming a skipped confirmation invalidates old final checks, including skips.
    if (
      complete ||
      (attempt?.status === 'skipped' && (step !== 'use-1' || afterEnrollment(state, attempt)))
    )
      continue;
    if (attempt?.status === 'verified' || attempt?.status === 'skipped')
      row.result = 'not verified · a fresh post-enrollment check is required';
    if (failed(attempt) && step !== 'use-1') {
      // Keep the failed row in place; recovery and then Retry/Continue appear below it.
      // A resumed A may follow a confirmed B/C: causal order, not alias order, owns recovery.
      for (const earlier of GUIDED_ALIASES.filter((item) => item !== alias)) {
        if (
          !state.credentials.some((item) => item.alias === earlier && item.cipher) ||
          !state.attempts.some(
            (item) =>
              item.alias === earlier &&
              item.step === 'confirm' &&
              item.status === 'verified' &&
              follows(attempt!, item),
          )
        )
          continue;
        const recovery = add(
          earlier,
          'retained',
          `Check ${earlier} after ${alias} failed`,
          attempt!.id,
        );
        if (waiting) {
          recovery.result = 'waiting for earlier steps';
          continue;
        }
        if (
          recovery.attempt?.status === 'skipped' ||
          (recovery.attempt && verifiedRetention(state, recovery.attempt))
        )
          continue;
        if (recovery.attempt?.status === 'verified')
          recovery.result = 'not verified · recovery linkage is invalid';
        recovery.active = true;
        waiting = true;
      }
      const retry = {
        ...row,
        key: `${row.key}-retry`,
        title: `Continue with ${title.toLowerCase()}`,
      };
      rows.push(retry);
      if (waiting) {
        retry.result = 'waiting for retained-access checks';
        continue;
      }
      retry.active = true;
    } else row.active = true;
    waiting = true;
  }
  return rows;
}

export const currentGuidedTask = (state: CheckerState) =>
  guidedPlan(state).find((row) => row.active);

/** A separate explicit action resumes only a skipped, still-unconfirmed saved credential. */
export function canResumeConfirmation(state: CheckerState, alias: CredentialAlias): boolean {
  const current = currentGuidedTask(state);
  if (state.run.flow !== 'abc-v1' || current?.step === 'retained' || failed(current?.attempt))
    return false;
  const credential = state.credentials.find((item) => item.alias === alias);
  return (
    !!credential &&
    !credential.cipher &&
    state.attempts.filter((row) => row.alias === alias && row.step === 'confirm').at(-1)?.status ===
      'skipped'
  );
}

/** A terminal sequence is not necessarily a completed verification. */
export function guidedSummary(state: CheckerState): string {
  const requests = state.attempts.filter(
    (row) => row.step === 'confirm' && row.status !== 'skipped',
  );
  if (!requests.length)
    return 'Verification not attempted. Created passkeys and skipped steps are not a compatibility pass or a provider validation failure.';
  const confirmed = GUIDED_ALIASES.filter((alias) =>
    state.credentials.some((item) => item.alias === alias && item.cipher),
  ).length;
  const rechecked = GUIDED_ALIASES.filter((alias) =>
    state.attempts.some((row) => row.alias === alias && verifiedFinal(state, row)),
  ).length;
  return `Verification requested; ${confirmed}/3 credentials confirmed and ${rechecked}/3 fresh final rechecks verified. Inspect failed, skipped and unavailable steps separately.`;
}

/** Report existing attempt/invocation evidence without inventing UI intent or legacy facts. */
export function guidedInvocationEvidence(attempt: Attempt): string {
  if (attempt.status === 'skipped')
    return 'Skip recorded; no native operation requested by this attempt. This record alone does not establish human intent.';
  const outcome = attempt.diagnostics?.nativeOutcome;
  const invocation =
    outcome === 'returned' || outcome === 'threw' || outcome === 'rejected'
      ? `observed (${outcome})`
      : 'unobserved or unfinished; absence is not proof that no call occurred';
  return `Operation requested and accepted by the controller. Native invocation: ${invocation}.`;
}
