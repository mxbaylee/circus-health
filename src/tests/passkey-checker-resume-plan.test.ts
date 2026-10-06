import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canResumeConfirmation,
  currentGuidedTask,
  guidedInvocationEvidence,
  guidedSummary,
  verifiedFinal,
  verifiedRetention,
} from '../app/passkey-checker/guided.ts';
import type { Attempt, CheckerState, CredentialAlias, Step } from '../app/passkey-checker/types.ts';

// Independently fictional planner inputs; not a provider/cryptography qualification.
function fixture(): CheckerState {
  return {
    run: { flow: 'abc-v1' },
    attempts: [],
    credentials: [],
    observations: [],
  } as unknown as CheckerState;
}
function add(state: CheckerState, alias: CredentialAlias, step: Step, status: Attempt['status']) {
  const sequence = state.attempts.length + 1;
  const attempt = { id: `fictional-${sequence}`, alias, step, status, sequence } as Attempt;
  state.attempts.push(attempt);
  if (step === 'create' && status === 'created')
    state.credentials.push({ alias, id: `fictional-${alias}`, salt: `fictional-salt-${alias}` });
  if (step === 'confirm' && status === 'verified')
    state.credentials.find((row) => row.alias === alias)!.cipher = {
      iv: `fictional-iv-${alias}`,
      data: `fictional-cipher-${alias}`,
    };
  return attempt;
}
function skippedRun() {
  const state = fixture();
  for (const alias of ['A', 'B', 'C'] as const) {
    add(state, alias, 'create', 'created');
    add(state, alias, 'confirm', 'skipped');
  }
  return state;
}

test('three creation/skip pairs remain resumable after reload, without rewriting history', () => {
  const state = JSON.parse(JSON.stringify(skippedRun())) as CheckerState;
  const before = structuredClone(state);
  assert.equal(currentGuidedTask(state), undefined);
  for (const alias of ['A', 'B', 'C'] as const) assert.equal(canResumeConfirmation(state, alias), true);
  assert.match(guidedSummary(state), /^Verification not attempted/);
  assert.deepEqual(state, before);
});

test('only an existing, skipped and still-unconfirmed guided credential may resume', () => {
  const state = skippedRun();
  assert.equal(canResumeConfirmation(state, 'A'), true);
  add(state, 'A', 'confirm', 'verified');
  assert.equal(canResumeConfirmation(state, 'A'), false);
  state.credentials = state.credentials.filter((row) => row.alias !== 'B');
  assert.equal(canResumeConfirmation(state, 'B'), false);
  add(state, 'C', 'confirm', 'failed');
  assert.equal(canResumeConfirmation(state, 'C'), false);
  const legacy = skippedRun();
  delete legacy.run.flow;
  assert.equal(canResumeConfirmation(legacy, 'A'), false);
});

test('a failed resumed A rechecks previously confirmed B/C by causal order', () => {
  const state = skippedRun();
  add(state, 'B', 'confirm', 'verified');
  add(state, 'C', 'confirm', 'verified');
  const failure = add(state, 'A', 'confirm', 'failed');
  const original = structuredClone(state.credentials);
  for (const alias of ['B', 'C'] as const) {
    const task = currentGuidedTask(state)!;
    assert.equal(task.alias, alias);
    assert.equal(task.step, 'retained');
    assert.equal(task.afterAttemptId, failure.id);
    const check = add(state, alias, 'retained', 'verified');
    check.afterAttemptId = failure.id;
    assert.equal(verifiedRetention(state, check), true);
  }
  assert.equal(currentGuidedTask(state)?.alias, 'A');
  assert.equal(currentGuidedTask(state)?.step, 'confirm');
  assert.deepEqual(state.credentials, original);
});

test('resumption cannot bypass an outstanding exact-failure recovery check', () => {
  const state = fixture();
  add(state, 'A', 'create', 'created');
  add(state, 'A', 'confirm', 'skipped');
  add(state, 'B', 'create', 'created');
  add(state, 'B', 'confirm', 'verified');
  add(state, 'C', 'create', 'failed');
  assert.equal(currentGuidedTask(state)?.step, 'retained');
  assert.equal(canResumeConfirmation(state, 'A'), false);
});

test('a new confirmation invalidates both old verified and skipped final checks', () => {
  for (const status of ['verified', 'skipped'] as const) {
    const state = skippedRun();
    add(state, 'A', 'confirm', 'verified');
    const final = add(state, 'A', 'use-1', status);
    assert.equal(currentGuidedTask(state), undefined);
    add(state, 'B', 'confirm', 'verified');
    assert.equal(verifiedFinal(state, final), false);
    assert.equal(currentGuidedTask(state)?.alias, 'A');
    assert.equal(currentGuidedTask(state)?.step, 'use-1');
  }
});

test('old recovery cannot satisfy another failed resumed verification', () => {
  const state = skippedRun();
  add(state, 'C', 'confirm', 'verified');
  const first = add(state, 'A', 'confirm', 'failed');
  const check = add(state, 'C', 'retained', 'verified');
  check.afterAttemptId = first.id;
  const second = add(state, 'A', 'confirm', 'failed');
  assert.equal(currentGuidedTask(state)?.afterAttemptId, second.id);
  const forged = { ...check, afterAttemptId: second.id };
  assert.equal(verifiedRetention(state, forged), false);
});

test('all resumed confirmations still require separate final native uses', () => {
  const state = skippedRun();
  const skips = structuredClone(state.attempts);
  for (const alias of ['C', 'B', 'A'] as const) add(state, alias, 'confirm', 'verified');
  assert.match(guidedSummary(state), /3\/3 credentials confirmed and 0\/3 fresh/);
  const original = structuredClone(state.credentials);
  for (const alias of ['A', 'B', 'C'] as const) {
    assert.equal(currentGuidedTask(state)?.alias, alias);
    const check = add(state, alias, 'use-1', 'verified');
    assert.equal(verifiedFinal(state, check), true);
  }
  assert.equal(currentGuidedTask(state), undefined);
  assert.deepEqual(state.attempts.slice(0, 6), skips);
  assert.deepEqual(state.credentials, original);
});

test('reports distinguish skips, requested operations and observed native outcomes', () => {
  const state = skippedRun();
  assert.match(guidedInvocationEvidence(state.attempts[1]), /no native operation requested/);
  const pending = add(state, 'A', 'confirm', 'pending');
  assert.match(guidedInvocationEvidence(pending), /Operation requested and accepted/);
  assert.match(guidedInvocationEvidence(pending), /unobserved or unfinished/);
  for (const nativeOutcome of ['returned', 'threw', 'rejected'] as const) {
    pending.diagnostics = { requestMode: 'eval', inputShape: 'array-buffer', nativeOutcome };
    assert.match(guidedInvocationEvidence(pending), new RegExp(`observed \\(${nativeOutcome}\\)`));
  }
});

test('resuming another credential cannot bypass the current failed task', () => {
  const state = skippedRun();
  add(state, 'A', 'confirm', 'failed');
  assert.equal(currentGuidedTask(state)?.alias, 'A');
  assert.equal(canResumeConfirmation(state, 'B'), false);
  add(state, 'A', 'confirm', 'skipped');
  assert.equal(canResumeConfirmation(state, 'B'), true);
});
