import test from 'node:test';
import assert from 'node:assert/strict';
import { guidedFixture } from './passkey-checker-guided-fixture.ts';
import { createCheckerController } from '../app/passkey-checker/controller.ts';
import {
  guidedPlan,
  currentGuidedTask,
  verifiedFinal,
  verifiedRetention,
} from '../app/passkey-checker/guided.ts';
import { messageEvidence, validNativeMessage } from '../app/passkey-checker/message.ts';
import { reportMarkdown } from '../app/passkey-checker/report.ts';
import type { CheckerController } from '../app/passkey-checker/controller.ts';
import type { Attempt, CredentialAlias } from '../app/passkey-checker/types.ts';

async function advance(controller: CheckerController, skip = false) {
  const step = currentGuidedTask(controller.exportModel());
  assert.ok(step);
  if (skip) await controller.skipStep!(step.alias, step.step, step.afterAttemptId);
  else await controller.runStep(step.alias, step.step, step.afterAttemptId);
  return step;
}

for (const mode of ['eval', 'enable-only'] as const)
  test(`${mode}: A/B share username, C changes only username; original A/B/C decrypt at the end`, async () => {
    const { controller, calls, gets } = await guidedFixture({ mode });
    const runId = controller.exportModel().run.userId;
    const pending = controller.runStep('A', 'create');
    assert.equal(calls.length, 1, 'native invocation precedes the first await');
    await pending;
    for (let index = 0; index < 5; index++) await advance(controller);
    const before = structuredClone(controller.exportModel().credentials);
    for (let index = 0; index < 3; index++) await advance(controller);
    const state = controller.exportModel();
    assert.equal(currentGuidedTask(state), undefined);
    assert.equal(state.attempts.length, 9);
    assert.ok(state.attempts.slice(-3).every((row) => verifiedFinal(state, row)));
    assert.deepEqual(state.credentials, before, 'final checks never replace original ciphertext');
    assert.equal(calls[0].options.publicKey!.user.name, calls[1].options.publicKey!.user.name);
    assert.notEqual(calls[0].options.publicKey!.user.name, calls[2].options.publicKey!.user.name);
    for (const [index, call] of calls.entries()) {
      const request = call.options.publicKey!;
      assert.deepEqual(request.user.id, calls[0].options.publicKey!.user.id);
      assert.equal(request.user.displayName, calls[0].options.publicKey!.user.displayName);
      assert.equal(request.excludeCredentials!.length, index);
      assert.equal(request.authenticatorSelection!.userVerification, 'required');
      assert.equal(request.authenticatorSelection!.residentKey, 'required');
      assert.equal(!!request.extensions!.prf!.eval, mode === 'eval');
      for (let prior = 0; prior < index; prior++)
        assert.deepEqual(
          new Uint8Array(request.excludeCredentials![prior].id as ArrayBuffer),
          new Uint8Array(32).fill(prior + 1),
        );
    }
    assert.equal(gets.length, 6);
    assert.equal(state.run.userId, runId);
    const report = reportMarkdown(state);
    assert.match(report, /Report schema: 4/);
    assert.match(report, /Creation mode: (?:eval|enable\\-only)/);
    assert.match(report, /Final recheck of original credential/);
    assert.doesNotMatch(report, /Use A after B creation fails: unfinished/);
    for (const item of state.credentials)
      assert.ok(!report.includes(item.id) && !report.includes(item.salt));
    controller.close();
  });

for (const synchronousFailure of [true, false])
  test(`${synchronousFailure ? 'throw' : 'rejection'}: B failure captures message, checks A, and allows C without a false B pass`, async () => {
    const { controller } = await guidedFixture({ failCreate: new Set(['B']), synchronousFailure });
    await advance(controller);
    await advance(controller);
    await advance(controller);
    const failure = controller.exportModel().attempts.at(-1)!;
    assert.equal(failure.diagnostics?.nativeOutcome, synchronousFailure ? 'threw' : 'rejected');
    assert.equal(failure.nativeMessage?.text, 'Fictional native refusal for this attempt.');
    assert.equal(currentGuidedTask(controller.exportModel())?.step, 'retained');
    const original = structuredClone(controller.exportModel().credentials[0]);
    await advance(controller);
    const recovery = controller.exportModel().attempts.at(-1)!;
    assert.equal(recovery.afterAttemptId, failure.id);
    assert.ok(verifiedRetention(controller.exportModel(), recovery));
    await advance(controller, true);
    assert.equal(currentGuidedTask(controller.exportModel())?.alias, 'C');
    await advance(controller);
    await advance(controller);
    await advance(controller);
    await advance(controller);
    const state = controller.exportModel();
    assert.equal(currentGuidedTask(state), undefined);
    assert.deepEqual(
      state.credentials.find((row) => row.alias === 'A'),
      original,
    );
    assert.match(reportMarkdown(state), /Verify B: not applicable/);
    assert.match(reportMarkdown(state), /Fictional native refusal for this attempt/);
    assert.match(reportMarkdown(state), /skipped by operator; no automatic pass/);
    assert.ok(state.attempts.includes(state.attempts.find((row) => row.id === failure.id)!));
    controller.close();
  });

test('each new C failure needs fresh A and B recovery, never stale recovery from a prior failure', async () => {
  const { controller } = await guidedFixture({ failCreate: new Set(['C']) });
  for (let index = 0; index < 5; index++) await advance(controller);
  const first = controller.exportModel().attempts.at(-1)!;
  for (const alias of ['A', 'B']) {
    assert.equal(currentGuidedTask(controller.exportModel())?.alias, alias);
    await advance(controller);
  }
  await advance(controller);
  const second = controller.exportModel().attempts.at(-1)!;
  assert.notEqual(first.id, second.id);
  assert.equal(currentGuidedTask(controller.exportModel())?.afterAttemptId, second.id);
  assert.equal(currentGuidedTask(controller.exportModel())?.alias, 'A');
  await advance(controller, true);
  await advance(controller, true);
  await advance(controller, true);
  await advance(controller);
  await advance(controller);
  assert.equal(currentGuidedTask(controller.exportModel()), undefined);
  controller.close();
});

test('wrong selected credential is refused before PRF extraction and retains previously confirmed A', async () => {
  const wrongCredential = new Set<CredentialAlias>(['B']);
  const fixture = await guidedFixture({ wrongCredential });
  const c = fixture.controller;
  await advance(c);
  await advance(c);
  await advance(c);
  const reads = fixture.extensionReads();
  await advance(c);
  assert.equal(c.exportModel().attempts.at(-1)!.error, 'wrong-credential');
  assert.equal(fixture.extensionReads(), reads);
  assert.equal(currentGuidedTask(c.exportModel())?.alias, 'A');
  await advance(c);
  await advance(c, true);
  assert.equal(currentGuidedTask(c.exportModel())?.alias, 'C');
  assert.equal(c.exportModel().credentials.find((row) => row.alias === 'B')!.cipher, undefined);
  c.close();
});

test('a capability flag and a 31-byte result do not turn confirmation into a pass', async () => {
  const { controller } = await guidedFixture({ badPrfLength: 31 });
  await advance(controller);
  await advance(controller);
  const state = controller.exportModel();
  assert.equal(state.attempts.at(-1)!.status, 'failed');
  assert.equal(state.attempts.at(-1)!.error, 'prf-invalid');
  assert.equal(state.credentials[0].cipher, undefined);
  controller.close();
});

test('the controller refuses out-of-order operations, and skips do not invoke native code', async () => {
  const { controller, calls, gets } = await guidedFixture();
  await controller.runStep('C', 'create');
  await controller.runStep('A', 'use-1');
  assert.equal(calls.length + gets.length, 0);
  await advance(controller, true);
  assert.equal(calls.length, 0);
  assert.equal(currentGuidedTask(controller.exportModel())?.alias, 'B');
  assert.equal(
    guidedPlan(controller.exportModel()).find((row) => row.alias === 'A' && row.step === 'confirm')
      ?.result,
    'not applicable · credential not created',
  );
  controller.close();
});

test('resumed pending operations are interrupted, never invented successes or automatic retries', async () => {
  const fixture = await guidedFixture();
  const state = fixture.controller.exportModel();
  const attempt: Attempt = {
    id: 'fictional-interrupted',
    alias: 'A',
    step: 'create',
    status: 'pending',
    sequence: 1,
    startedAt: state.run.createdAt,
    build: state.run.build,
    environment: state.run.environment,
  };
  state.attempts.push(attempt);
  let writes = 0;
  const controller = await createCheckerController({
    ...fixture.options,
    openStore: async () => ({
      load: async () => ({
        state: structuredClone(state),
        token: { runId: state.run.id, revision: 1 },
      }),
      commit: async () => {
        writes++;
        return { runId: state.run.id, revision: 2 };
      },
      reset: async () => {
        throw new Error('not called');
      },
      close() {},
    }),
  });
  assert.equal(controller.exportModel().attempts[0].status, 'interrupted');
  assert.equal(writes, 1);
  assert.equal(fixture.calls.length, 0);
  assert.match(reportMarkdown(controller.exportModel()), /interrupted; unfinished/);
  controller.close();
  fixture.controller.close();
});

test('native message capture handles hostile properties and labels every transformation', () => {
  assert.deepEqual(
    messageEvidence({
      get message() {
        throw Error('do not leak');
      },
    }),
    { state: 'unavailable' },
  );
  assert.deepEqual(messageEvidence({ message: 42 }), { state: 'non-text' });
  assert.deepEqual(messageEvidence({}), { state: 'absent' });
  assert.equal(messageEvidence('').length, 0);
  const secret = '0123456789abcdef0123456789abcdef';
  const captured = messageEvidence(
    new Error(`Fictional ${secret} https://example.test/secret [1,2,3]`),
    [secret],
  );
  assert.equal(captured.redacted, true);
  assert.ok(!captured.text!.includes(secret));
  assert.equal(messageEvidence('X '.repeat(1024)).truncated, true);
  assert.equal(validNativeMessage(captured), true);
  assert.equal(validNativeMessage({ ...captured, payload: secret }), false);
  assert.equal(validNativeMessage({ ...captured, text: 'x'.repeat(1025) }), false);
  assert.equal(validNativeMessage({ state: 'absent', text: 'untrusted' }), false);
});
