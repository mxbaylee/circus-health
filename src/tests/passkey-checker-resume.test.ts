import assert from 'node:assert/strict';
import test from 'node:test';
import type { CheckerController } from '../app/passkey-checker/controller.ts';
import { currentGuidedTask, verifiedFinal } from '../app/passkey-checker/guided.ts';
import { reportMarkdown } from '../app/passkey-checker/report.ts';
import type { CredentialAlias } from '../app/passkey-checker/types.ts';
import { guidedFixture } from './passkey-checker-guided-fixture.ts';

async function next(controller: CheckerController, skip = false) {
  const task = currentGuidedTask(controller.exportModel());
  assert.ok(task);
  await (skip
    ? controller.skipStep!(task.alias, task.step, task.afterAttemptId)
    : controller.runStep(task.alias, task.step, task.afterAttemptId));
}

for (const mode of ['eval', 'enable-only'] as const)
  test(`${mode}: resume all three skipped credentials without recreation or lost history`, async (t) => {
    const { controller, calls, gets } = await guidedFixture({ mode });
    t.after(() => controller.close());
    for (const alias of ['A', 'B', 'C'] as const) {
      await controller.runStep(alias, 'create');
      await controller.skipStep!(alias, 'confirm');
    }
    const original = controller.exportModel();
    assert.equal(gets.length, 0);
    assert.match(reportMarkdown(original), /Verification not attempted/);
    assert.match(reportMarkdown(original), /no native operation requested by this attempt/);
    for (const alias of ['A', 'B', 'C'] as const) {
      const count = gets.length;
      const pending = controller.runStep(alias, 'confirm', undefined, true);
      assert.equal(gets.length, count + 1, 'native invocation precedes the first await');
      await controller.runStep(alias, 'confirm', undefined, true);
      assert.equal(gets.length, count + 1, 'duplicate resume is refused while busy');
      await pending;
      const saved = controller.exportModel().credentials.find((row) => row.alias === alias)!;
      const created = original.credentials.find((row) => row.alias === alias)!;
      assert.equal(saved.id, created.id);
      assert.equal(saved.salt, created.salt);
      assert.ok(saved.cipher);
      await controller.runStep(alias, 'confirm', undefined, true);
      assert.equal(gets.length, count + 1, 'confirmed ciphertext cannot be replaced by resumption');
    }
    assert.equal(calls.length, 3);
    assert.deepEqual(controller.exportModel().attempts.slice(0, 6), original.attempts);
    const ciphertexts = controller.exportModel().credentials;
    for (let index = 0; index < 3; index++) await next(controller);
    const finished = controller.exportModel();
    assert.equal(finished.attempts.filter((row) => verifiedFinal(finished, row)).length, 3);
    assert.deepEqual(finished.credentials, ciphertexts);
    assert.equal(currentGuidedTask(finished), undefined);
    assert.match(reportMarkdown(finished), /Native invocation: observed \(returned\)/);
  });

test('resumed wrong-credential and missing-PRF attempts stay failed and retry the saved credential', async (t) => {
  const wrongCredential = new Set<CredentialAlias>();
  const missingPrf = new Set<CredentialAlias>();
  const fixture = await guidedFixture({ wrongCredential, missingPrf });
  const { controller, calls, gets } = fixture;
  t.after(() => controller.close());
  await next(controller);
  await next(controller, true);
  const created = controller.exportModel().credentials[0];
  const skip = controller.exportModel().attempts[1];
  wrongCredential.add('A');
  const reads = fixture.extensionReads();
  await controller.runStep('A', 'confirm', undefined, true);
  assert.equal(fixture.extensionReads(), reads);
  assert.equal(controller.exportModel().attempts.at(-1)?.error, 'wrong-credential');
  wrongCredential.clear();
  missingPrf.add('A');
  await next(controller);
  assert.equal(controller.exportModel().attempts.at(-1)?.error, 'prf-absent');
  missingPrf.clear();
  await next(controller);
  assert.equal(calls.length, 1);
  assert.equal(controller.exportModel().credentials[0].id, created.id);
  assert.equal(controller.exportModel().credentials[0].salt, created.salt);
  assert.deepEqual(controller.exportModel().attempts[1], skip);
  assert.notDeepEqual(gets[0].publicKey!.challenge, gets[1].publicKey!.challenge);
  assert.notDeepEqual(gets[1].publicKey!.challenge, gets[2].publicKey!.challenge);
});

test('resume flag cannot bypass creation, recovery or the ordinary current-task guard', async (t) => {
  const { controller, calls, gets } = await guidedFixture();
  t.after(() => controller.close());
  await controller.runStep('A', 'create', undefined, true);
  assert.equal(calls.length, 0);
  await next(controller);
  await next(controller, true);
  const count = controller.exportModel().attempts.length;
  await controller.runStep('A', 'confirm');
  await controller.runStep('A', 'confirm', 'fictional-stale-failure', true);
  await controller.skipStep!('A', 'confirm');
  assert.equal(gets.length, 0);
  assert.equal(controller.exportModel().attempts.length, count);
});
