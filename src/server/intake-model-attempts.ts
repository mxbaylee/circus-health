import { HttpError } from './database.ts';
import type { IntakeModelAttempt, IntakeProviderWait } from '../shared/intake-batch.ts';

export interface IntakeAttemptScope {
  profileId: string;
  intakeId: string;
  sourceHash: string;
  sourceTextRevisionId: string | null;
  intakeVersion: number;
  runId: string;
  backend: string | null;
  instructionVersion: string;
  workUnit?: { id: string; locator: string } | null;
}
export interface RecordedIntakeModelAttempt extends IntakeModelAttempt {
  recovery?: {
    decisionId: string;
    at: string;
    workUnit: string;
    replacementRequestId: string | null;
  };
  lateResponse?: { at: string; usage: IntakeModelAttempt['usage'] };
  scope: IntakeAttemptScope;
  attempt: number;
  /** Host interruption provenance survives any separately authorized reconciliation. */
  interruption?: { at: string; reason: 'unfinished-after-recovery' };
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const stamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const fail = (message: string): never => {
  throw new HttpError(409, 'INTAKE_ATTEMPT_INTEGRITY', message);
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const tokenFields = [
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
] as const;
function usage(value: unknown): IntakeModelAttempt['usage'] {
  if (!object(value)) return null;
  const normalized = Object.fromEntries(
    tokenFields.map((field) => [
      field,
      typeof value[field] === 'number' && Number.isSafeInteger(value[field]) && value[field] >= 0
        ? value[field]
        : null,
    ]),
  ) as Record<string, number | null>;
  if (
    normalized.cachedInputTokens !== null &&
    normalized.inputTokens !== null &&
    normalized.cachedInputTokens > normalized.inputTokens
  )
    normalized.cachedInputTokens = null;
  if (
    normalized.reasoningOutputTokens !== null &&
    normalized.outputTokens !== null &&
    normalized.reasoningOutputTokens > normalized.outputTokens
  )
    normalized.reasoningOutputTokens = null;
  return normalized;
}
function scopeValid(scope: IntakeAttemptScope) {
  if (
    !scope ||
    ![scope.profileId, scope.intakeId, scope.runId, scope.instructionVersion].every(identity) ||
    !/^[a-f0-9]{64}$/.test(scope.sourceHash) ||
    !Number.isSafeInteger(scope.intakeVersion) ||
    scope.intakeVersion < 1 ||
    !(scope.sourceTextRevisionId === null || identity(scope.sourceTextRevisionId)) ||
    !(scope.backend === null || identity(scope.backend))
  )
    fail('Provider attempt requires exact source and route pins');
}
/** The caller MUST durably save the returned array before allowing the network dispatch.
 * No receipts are evicted: display summaries are separate from recovery authority.
 */
export function startIntakeModelAttempt(
  attempts: RecordedIntakeModelAttempt[],
  event: Record<string, unknown>,
  scope: IntakeAttemptScope,
  at: string,
): RecordedIntakeModelAttempt[] {
  scopeValid(scope);
  if (
    !identity(event.requestId) ||
    !identity(event.model) ||
    typeof event.requestDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(event.requestDigest) ||
    !Number.isSafeInteger(event.requestBytes) ||
    Number(event.requestBytes) < 1 ||
    !Number.isSafeInteger(event.attempt) ||
    Number(event.attempt) < 1 ||
    !stamp(at)
  )
    fail('Invalid provider dispatch receipt');
  const fit = event.requestFit;
  if (
    fit !== undefined &&
    (!object(fit) ||
      fit.policy !== 'proxy-byte-envelope-v1' ||
      fit.qualified !== false ||
      fit.inputTokens !== null ||
      fit.outputReserveTokens !== null ||
      ![
        'textCharacters',
        'mediaBytes',
        'maxTextCharacters',
        'maxMediaBytes',
        'maxResponseBytes',
      ].every((k) => Number.isSafeInteger(fit[k]) && Number(fit[k]) >= 0))
  )
    fail('Invalid request-fit receipt');
  const entry: RecordedIntakeModelAttempt = {
    requestId: String(event.requestId),
    startedAt: stamp(event.startedAt) ? event.startedAt : at,
    finishedAt: null,
    outcome: 'dispatched',
    classification: null,
    status: null,
    retryAt: null,
    requestDigest: String(event.requestDigest),
    requestBytes: Number(event.requestBytes),
    model: String(event.model),
    usage: null,
    scope: structuredClone(scope),
    attempt: Number(event.attempt),
    ...(fit !== undefined
      ? { requestFit: structuredClone(fit) as IntakeModelAttempt['requestFit'] }
      : {}),
  };
  const prior = attempts.find((a) => a.requestId === entry.requestId);
  if (prior) {
    const {
      finishedAt: _f,
      outcome: _o,
      classification: _c,
      status: _s,
      retryAt: _r,
      usage: _u,
      interruption: _i,
      recovery: _recovery,
      lateResponse: _late,
      ...basis
    } = prior;
    const {
      finishedAt: _nf,
      outcome: _no,
      classification: _nc,
      status: _ns,
      retryAt: _nr,
      usage: _nu,
      ...nextBasis
    } = entry;
    if (!equal(basis, nextBasis))
      fail('Provider request identity was reused with different dispatch evidence');
    return attempts;
  }
  if (attempts.some((a) => a.outcome === 'dispatched' || (a.outcome === 'unknown' && !a.recovery)))
    throw new HttpError(
      409,
      'INTAKE_ATTEMPT_UNRESOLVED',
      'Reconcile the earlier provider attempt before sending another request',
    );
  return [
    ...attempts.map((a) =>
      a.outcome === 'unknown' && a.recovery && !a.recovery.replacementRequestId
        ? { ...a, recovery: { ...a.recovery, replacementRequestId: entry.requestId } }
        : a,
    ),
    entry,
  ];
}
const classifications = new Set([
  'quota',
  'transient',
  'authentication',
  'context_limit',
  'unsupported',
  'invalid_request',
]);
/** Called for every network terminal path and persisted even when output is unusable.
 * A transport error without a classified rejection remains unknown, never zero-cost.
 */
export function finishIntakeModelAttempt(
  attempts: RecordedIntakeModelAttempt[],
  event: Record<string, unknown>,
  at: string,
): RecordedIntakeModelAttempt[] {
  if (!identity(event.requestId) || !stamp(at)) fail('Invalid provider terminal receipt');
  const index = attempts.findIndex((a) => a.requestId === event.requestId);
  if (index < 0) fail('Provider terminal receipt has no durable dispatch');
  const prior = attempts[index];
  const response = event.failed === false && event.outcome === 'response';
  const status =
    Number.isSafeInteger(event.status) && Number(event.status) >= 100 && Number(event.status) <= 599
      ? Number(event.status)
      : null;
  const rejected =
    event.failed === true &&
    event.outcome === 'rejected' &&
    status !== null &&
    ((status >= 400 && status < 500 && status !== 408) || status === 503) &&
    classifications.has(String(event.classification));
  const outcome = response ? 'response' : rejected ? 'rejected' : 'unknown';
  const classification = response
    ? null
    : rejected
      ? (event.classification as IntakeProviderWait['classification'])
      : 'unknown';
  const terminal = {
    outcome,
    classification,
    status,
    retryAt: rejected && stamp(event.retryAt) ? event.retryAt : null,
    usage: usage(event.usage),
  } as const;
  // A late success is accounting evidence, never permission to publish a superseded result.
  if (prior.outcome === 'unknown' && response) {
    if (prior.lateResponse) {
      if (!equal(prior.lateResponse.usage, usage(event.usage)))
        fail('Conflicting late provider usage');
      return attempts;
    }
    return attempts.map((entry, i) =>
      i === index
        ? { ...entry, lateResponse: { at, usage: usage(event.usage) }, usage: usage(event.usage) }
        : entry,
    );
  }
  if (prior.outcome !== 'dispatched') {
    const {
      outcome: pOutcome,
      classification: pClass,
      status: pStatus,
      retryAt: pRetry,
      usage: pUsage,
    } = prior;
    if (
      !equal(
        {
          outcome: pOutcome,
          classification: pClass,
          status: pStatus,
          retryAt: pRetry,
          usage: pUsage,
        },
        terminal,
      )
    )
      fail('Conflicting terminal response requires explicit provider reconciliation');
    return attempts;
  }
  return attempts.map((entry, i) =>
    i === index
      ? { ...entry, ...terminal, finishedAt: stamp(event.finishedAt) ? event.finishedAt : at }
      : entry,
  );
}
/** A restarted process cannot know whether an interrupted request was processed upstream. */
export function recoverIntakeModelAttempts(
  attempts: RecordedIntakeModelAttempt[],
  at: string,
): RecordedIntakeModelAttempt[] {
  if (!stamp(at)) fail('Invalid recovery time');
  return attempts.map((entry) =>
    entry.outcome === 'dispatched'
      ? {
          ...entry,
          outcome: 'unknown',
          classification: 'unknown',
          finishedAt: at,
          status: null,
          retryAt: null,
          interruption: { at, reason: 'unfinished-after-recovery' },
        }
      : entry,
  );
}
export function intakeAttemptWait(
  attempts: RecordedIntakeModelAttempt[],
): IntakeProviderWait | null {
  const unknown = attempts.find(
    (a) => (a.outcome === 'unknown' && !a.recovery) || a.outcome === 'dispatched',
  );
  if (unknown)
    return {
      requestId: unknown.requestId,
      outcome: 'unknown',
      classification: 'unknown',
      retryAt: null,
    };
  const latest = attempts.at(-1);
  return latest?.outcome === 'rejected'
    ? {
        requestId: latest.requestId,
        outcome: 'rejected',
        classification: latest.classification ?? 'unknown',
        retryAt: latest.retryAt,
      }
    : null;
}
export function intakeAttemptAccounting(attempts: RecordedIntakeModelAttempt[]) {
  const measured = Object.fromEntries(
    tokenFields.map((field) => [
      field,
      attempts.reduce((sum, a) => sum + (a.usage?.[field] ?? 0), 0),
    ]),
  );
  const unknownUsage = attempts.filter(
    (a) =>
      !a.usage ||
      ['totalTokens', 'inputTokens', 'outputTokens'].some(
        (f) => a.usage![f] === null || a.usage![f] === undefined,
      ),
  ).length;
  return {
    requests: attempts.length,
    measured,
    unknownUsage,
    unknownOutcomes: attempts.filter((a) => a.outcome === 'unknown' || a.outcome === 'dispatched')
      .length,
    completeUsage: unknownUsage === 0,
  };
}

/** Persist before another dispatch. Recovery permission never rewrites possibly billed evidence. */
export function authorizeIntakeAttemptRecovery(
  attempts: RecordedIntakeModelAttempt[],
  at: string,
  workUnit: string,
) {
  return attempts.map((a) =>
    a.outcome === 'unknown' && !a.recovery
      ? {
          ...a,
          recovery: {
            decisionId: a.requestId + ':retry',
            at,
            workUnit,
            replacementRequestId: null,
          },
        }
      : a,
  );
}
