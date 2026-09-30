import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startIntakeModelAttempt,
  finishIntakeModelAttempt,
  recoverIntakeModelAttempts,
  intakeAttemptWait,
  authorizeIntakeAttemptRecovery,
  intakeAttemptAccounting,
  type IntakeAttemptScope,
  type RecordedIntakeModelAttempt,
} from '../intake-model-attempts.ts';
const at = '2026-09-26T12:00:00.000Z',
  end = '2026-09-26T12:00:03.000Z';
const scope: IntakeAttemptScope = {
  profileId: 'fictional-profile',
  intakeId: 'intake:fictional',
  sourceHash: 'a'.repeat(64),
  sourceTextRevisionId: 'fictional-revision',
  intakeVersion: 3,
  runId: 'fictional-run',
  backend: 'fictional-proxy',
  instructionVersion: 'fictional-v1',
};
const start = (id = 'request-one', attempt = 1) => ({
  requestId: id,
  requestDigest: 'b'.repeat(64),
  requestBytes: 456,
  model: 'fictional-model',
  attempt,
  startedAt: at,
});
const measured = { inputTokens: 100, cachedInputTokens: 30, outputTokens: 10, totalTokens: 110 };
const finished = (id = 'request-one') => ({
  requestId: id,
  failed: false,
  outcome: 'response',
  usage: measured,
  finishedAt: end,
  status: null,
  classification: null,
  retryAt: null,
});

test('durable dispatch pins source/route without retaining prompt text and exact replay does not double count', () => {
  const entries = startIntakeModelAttempt([], start(), scope, at);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outcome, 'dispatched');
  assert.deepEqual(entries[0].scope, scope);
  assert.equal('body' in entries[0], false);
  assert.equal(startIntakeModelAttempt(entries, start(), scope, end), entries);
  assert.throws(
    () =>
      startIntakeModelAttempt(entries, { ...start(), requestDigest: 'c'.repeat(64) }, scope, at),
    /different dispatch/,
  );
  assert.throws(() => startIntakeModelAttempt(entries, start('duplicate'), scope, at), /Reconcile/);
});

test('measured completion retains cached input as a subset and cannot silently change usage on replay', () => {
  const dispatched = startIntakeModelAttempt([], start(), scope, at),
    entries = finishIntakeModelAttempt(dispatched, finished(), end);
  const accounting = intakeAttemptAccounting(entries);
  assert.equal(accounting.measured.inputTokens, 100);
  assert.equal(accounting.measured.cachedInputTokens, 30);
  assert.equal(accounting.measured.totalTokens, 110);
  assert.equal(accounting.completeUsage, true);
  assert.equal(intakeAttemptWait(entries), null);
  assert.equal(finishIntakeModelAttempt(entries, finished(), end), entries);
  assert.throws(
    () =>
      finishIntakeModelAttempt(
        entries,
        { ...finished(), usage: { ...measured, outputTokens: 20 } },
        end,
      ),
    /Conflicting/,
  );
});

test('known rejection retains retry timing and unknown billing while every retry has a new dispatch', () => {
  let entries = startIntakeModelAttempt([], start(), scope, at);
  entries = finishIntakeModelAttempt(
    entries,
    {
      requestId: 'request-one',
      failed: true,
      outcome: 'rejected',
      status: 429,
      classification: 'quota',
      retryAt: '2026-09-26T12:10:00Z',
      usage: null,
    },
    end,
  );
  assert.deepEqual(intakeAttemptWait(entries), {
    requestId: 'request-one',
    outcome: 'rejected',
    classification: 'quota',
    retryAt: '2026-09-26T12:10:00Z',
  });
  entries = startIntakeModelAttempt(entries, start('request-two', 2), scope, at);
  entries = finishIntakeModelAttempt(entries, finished('request-two'), end);
  assert.equal(entries.length, 2);
  assert.equal(intakeAttemptWait(entries), null);
  assert.equal(intakeAttemptAccounting(entries).unknownUsage, 1);
  assert.equal(intakeAttemptAccounting(entries).completeUsage, false);
});

test('transport timeout and ambiguous server failures never become retry permission or zero-cost success', () => {
  for (const event of [
    { requestId: 'request-one', failed: true, usage: null },
    {
      requestId: 'request-one',
      failed: true,
      outcome: 'rejected',
      status: 500,
      classification: 'transient',
      retryAt: end,
    },
    {
      requestId: 'request-one',
      failed: true,
      outcome: 'rejected',
      status: 408,
      classification: 'transient',
      retryAt: end,
    },
  ]) {
    const entries = finishIntakeModelAttempt(
      startIntakeModelAttempt([], start(), scope, at),
      event,
      end,
    );
    assert.equal(entries[0].outcome, 'unknown');
    assert.equal(entries[0].retryAt, null);
    assert.equal(intakeAttemptAccounting(entries).unknownOutcomes, 1);
    assert.throws(
      () => startIntakeModelAttempt(entries, start('request-two'), scope, end),
      /Reconcile/,
    );
  }
});

test('restart keeps unknown accounting and records late success without publication authority', () => {
  const initial = startIntakeModelAttempt([], start(), scope, at),
    entries = recoverIntakeModelAttempts(initial, end);
  assert.equal(entries[0].outcome, 'unknown');
  assert.deepEqual(entries[0].interruption, { at: end, reason: 'unfinished-after-recovery' });
  assert.equal(initial[0].outcome, 'dispatched', 'caller can persist new state atomically');
  assert.deepEqual(recoverIntakeModelAttempts(entries, '2026-09-27T00:00:00Z'), entries);
  const late = finishIntakeModelAttempt(entries, finished(), end);
  assert.equal(late[0].outcome, 'unknown');
  assert.equal(late[0].lateResponse?.at, end);
  assert.equal(intakeAttemptAccounting(late).unknownOutcomes, 1);
});

test('any unresolved old request remains visible even after a separate later success', () => {
  const unknown = recoverIntakeModelAttempts(startIntakeModelAttempt([], start(), scope, at), end);
  const other = finishIntakeModelAttempt(
    startIntakeModelAttempt([], start('other'), scope, at),
    finished('other'),
    end,
  );
  const mixed = [...unknown, ...other];
  assert.equal(intakeAttemptWait(mixed)?.requestId, 'request-one');
  assert.equal(intakeAttemptAccounting(mixed).unknownUsage, 1);
  assert.equal(intakeAttemptAccounting(mixed).measured.totalTokens, 110);
});

test('ledger retains every receipt rather than evicting early unknowns or cumulative costs', () => {
  let entries: RecordedIntakeModelAttempt[] = [];
  for (let i = 0; i < 300; i++) {
    entries = startIntakeModelAttempt(entries, start(`request-${i}`), scope, at);
    entries = finishIntakeModelAttempt(entries, finished(`request-${i}`), end);
  }
  assert.equal(entries.length, 300);
  assert.equal(entries[0].requestId, 'request-0');
  assert.equal(intakeAttemptAccounting(entries).measured.inputTokens, 30000);
});

test('invalid usage remains explicitly unknown; terminal receipt without dispatch fails closed', () => {
  assert.throws(() => finishIntakeModelAttempt([], finished(), end), /no durable dispatch/);
  const entries = finishIntakeModelAttempt(
    startIntakeModelAttempt([], start(), scope, at),
    {
      ...finished(),
      usage: { inputTokens: 10, cachedInputTokens: 20, outputTokens: -1, totalTokens: 10 },
    },
    end,
  );
  assert.equal(entries[0].usage?.cachedInputTokens, null);
  assert.equal(entries[0].usage?.outputTokens, null);
  assert.equal(intakeAttemptAccounting(entries).completeUsage, false);
});

test('request-fit receipts retain byte policy without claiming token qualification', () => {
  const requestFit = {
    policy: 'proxy-byte-envelope-v1',
    qualified: false,
    textCharacters: 1000,
    mediaBytes: 4000,
    maxTextCharacters: 10000,
    maxMediaBytes: 100000,
    inputTokens: null,
    outputReserveTokens: null,
    maxResponseBytes: 8388608,
  };
  const entries = startIntakeModelAttempt([], { ...start(), requestFit }, scope, at);
  assert.deepEqual(entries[0].requestFit, requestFit);
  assert.throws(
    () =>
      startIntakeModelAttempt(
        [],
        { ...start(), requestFit: { ...requestFit, qualified: true } },
        scope,
        at,
      ),
    /Invalid request-fit/,
  );
});

test('repeated recovery reuses one replacement decision while unknown costs remain', () => {
  const original = recoverIntakeModelAttempts(startIntakeModelAttempt([], start(), scope, at), end);
  const allowed = authorizeIntakeAttemptRecovery(original, end, 'fictional-unit-1');
  assert.deepEqual(authorizeIntakeAttemptRecovery(allowed, at, 'fictional-unit-1'), allowed);
  // A crash after the decision but before dispatch must reuse the same decision.
  const restoredDecision = JSON.parse(JSON.stringify(allowed));
  assert.deepEqual(
    authorizeIntakeAttemptRecovery(restoredDecision, end, 'fictional-unit-1'),
    allowed,
  );
  const next = startIntakeModelAttempt(
    restoredDecision,
    start('replacement'),
    { ...scope, runId: 'recovery-run' },
    end,
  );
  assert.equal(next[0].recovery?.replacementRequestId, 'replacement');
  assert.throws(() => startIntakeModelAttempt(next, start('concurrent'), scope, end), {
    code: 'INTAKE_ATTEMPT_UNRESOLVED',
  });
  const dispatchedAgain = startIntakeModelAttempt(
    JSON.parse(JSON.stringify(next)),
    start('replacement'),
    { ...scope, runId: 'recovery-run' },
    end,
  );
  assert.deepEqual(
    dispatchedAgain,
    next,
    'replayed durable replacement dispatch is not another request',
  );
  const success = finishIntakeModelAttempt(dispatchedAgain, finished('replacement'), end);
  assert.equal(intakeAttemptWait(success), null);
  assert.equal(intakeAttemptAccounting(success).unknownOutcomes, 1);
  assert.equal(intakeAttemptAccounting(success).unknownUsage, 1);
});
