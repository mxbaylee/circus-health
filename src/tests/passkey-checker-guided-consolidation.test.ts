import assert from 'node:assert/strict';
import test from 'node:test';
import { createCheckerController } from '../app/passkey-checker/controller.ts';
import type { CheckerController } from '../app/passkey-checker/controller.ts';
import {
  currentGuidedTask,
  verifiedFinal,
  verifiedRetention,
} from '../app/passkey-checker/guided.ts';
import { reportMarkdown } from '../app/passkey-checker/report.ts';
import type { CredentialAlias } from '../app/passkey-checker/types.ts';
import { guidedFixture } from './passkey-checker-guided-fixture.ts';

// Port the complementary #80 regressions to #81's single guided controller/crypto contract.
async function next(controller: CheckerController, skip = false) {
  const action = currentGuidedTask(controller.exportModel());
  assert.ok(action);
  await (skip
    ? controller.skipStep!(action.alias, action.step, action.afterAttemptId)
    : controller.runStep(action.alias, action.step, action.afterAttemptId));
}
for (const mode of ['eval', 'enable-only'] as const)
  test(`${mode}: duplicate clicks cannot enroll twice and labels lock after the first step`, async (t) => {
    const { controller, calls } = await guidedFixture({ mode });
    t.after(() => controller.close());
    await controller.updateEnvironment({ provider: 'Fictional provider' });
    const pending = controller.runStep('A', 'create');
    assert.equal(calls.length, 1, 'native create precedes the first await');
    await controller.runStep('A', 'create');
    assert.equal(calls.length, 1, 'a second click cannot start another native operation');
    await pending;
    await controller.updateEnvironment({ provider: 'Different fictional provider' });
    assert.equal(controller.exportModel().run.environment.provider.value, 'Fictional provider');
    assert.equal(controller.exportModel().attempts.length, 1);
  });

test('wrong-ID and missing-PRF confirmation retries retain the credential and use fresh challenges', async (t) => {
  const wrongCredential = new Set<CredentialAlias>();
  const missingPrf = new Set<CredentialAlias>();
  const fixture = await guidedFixture({ wrongCredential, missingPrf });
  const { controller, calls, gets } = fixture;
  t.after(() => controller.close());
  await next(controller);
  const created = structuredClone(controller.exportModel().credentials[0]);
  wrongCredential.add('A');
  const reads = fixture.extensionReads();
  await next(controller);
  assert.equal(fixture.extensionReads(), reads, 'wrong ID is rejected before reading extensions');
  assert.equal(controller.exportModel().attempts.at(-1)?.error, 'wrong-credential');
  wrongCredential.clear();
  missingPrf.add('A');
  await next(controller);
  assert.equal(controller.exportModel().attempts.at(-1)?.error, 'prf-absent');
  missingPrf.clear();
  await next(controller);
  const confirmed = controller.exportModel().credentials[0];
  assert.equal(calls.length, 1, 'confirmation retries never create another credential');
  assert.equal(confirmed.id, created.id);
  assert.equal(confirmed.salt, created.salt);
  assert.ok(confirmed.cipher);
  assert.equal(controller.exportModel().attempts.at(-1)?.status, 'verified');
  assert.notDeepEqual(gets[0].publicKey!.challenge, gets[1].publicKey!.challenge);
  assert.notDeepEqual(gets[1].publicKey!.challenge, gets[2].publicKey!.challenge);
});

test('changed PRF output fails final decryption without replacing original ciphertext', async (t) => {
  const changedPrf = new Set<CredentialAlias>();
  const { controller } = await guidedFixture({ changedPrf });
  t.after(() => controller.close());
  for (let index = 0; index < 6; index++) await next(controller);
  const before = structuredClone(controller.exportModel().credentials);
  changedPrf.add('A');
  await next(controller);
  assert.equal(controller.exportModel().attempts.at(-1)?.error, 'decrypt-failed');
  assert.deepEqual(controller.exportModel().credentials, before);
  await next(controller, true);
  await next(controller);
  await next(controller);
  const state = controller.exportModel();
  assert.equal(currentGuidedTask(state), undefined);
  assert.equal(state.attempts.filter((row) => verifiedFinal(state, row)).length, 2);
  assert.match(reportMarkdown(state), /skipped by operator; no automatic pass/);
  assert.deepEqual(state.credentials, before);
});

test('final verification cannot qualify a later enrollment attempt', async (t) => {
  const { controller } = await guidedFixture();
  t.after(() => controller.close());
  for (let index = 0; index < 9; index++) await next(controller);
  const state = controller.exportModel();
  const final = state.attempts.at(-1)!;
  assert.equal(verifiedFinal(state, final), true);
  state.attempts.push({ ...state.attempts[0], id: 'fictional-later-enrollment', sequence: 999 });
  assert.equal(verifiedFinal(state, final), false);
});

test('repeated B failures need separate recovery and refuse a stale recovery action', async (t) => {
  const { controller } = await guidedFixture({ failCreate: new Set(['B']) });
  t.after(() => controller.close());
  for (let index = 0; index < 3; index++) await next(controller);
  const first = controller.exportModel().attempts.at(-1)!;
  await next(controller);
  await next(controller);
  const second = controller.exportModel().attempts.at(-1)!;
  assert.notEqual(first.id, second.id);
  assert.equal(currentGuidedTask(controller.exportModel())?.afterAttemptId, second.id);
  const count = controller.exportModel().attempts.length;
  await controller.runStep('A', 'retained', first.id);
  assert.equal(controller.exportModel().attempts.length, count, 'stale button must do nothing');
  await next(controller);
  await next(controller, true);
  assert.equal(currentGuidedTask(controller.exportModel())?.alias, 'C');
  const state = controller.exportModel();
  assert.equal(state.attempts.filter((row) => verifiedRetention(state, row)).length, 2);
  assert.equal(
    state.credentials.some((row) => row.alias === 'B'),
    false,
  );
  assert.ok(
    state.attempts.filter((row) => row.status === 'skipped').every((row) => !row.diagnostics),
  );
});

test('interrupted B creation reload requires recovery without inventing a B credential', async (t) => {
  const fixture = await guidedFixture();
  t.after(() => fixture.controller.close());
  await next(fixture.controller);
  await next(fixture.controller);
  const state = fixture.controller.exportModel();
  state.attempts.push({
    id: 'fictional-interrupted-B',
    alias: 'B',
    step: 'create',
    status: 'pending',
    sequence: 3,
    startedAt: state.run.createdAt,
    build: state.run.build,
    environment: state.run.environment,
  });
  let revision = 1;
  const resumed = await createCheckerController({
    ...fixture.options,
    openStore: async () => ({
      load: async () => ({
        state: structuredClone(state),
        token: { runId: state.run.id, revision },
      }),
      commit: async () => ({ runId: state.run.id, revision: ++revision }),
      reset: async () => {
        throw Error('Unexpected reset');
      },
      close() {},
    }),
  });
  t.after(() => resumed.close());
  const restored = resumed.exportModel();
  assert.equal(restored.attempts.at(-1)?.status, 'interrupted');
  assert.equal(currentGuidedTask(restored)?.step, 'retained');
  assert.equal(currentGuidedTask(restored)?.afterAttemptId, 'fictional-interrupted-B');
  assert.equal(
    restored.credentials.some((row) => row.alias === 'B'),
    false,
  );
  assert.equal(fixture.calls.length, 1, 'reload must not invoke a new creation');
});
