import assert from 'node:assert/strict';
import test from 'node:test';
import { createCheckerController } from '../app/passkey-checker/controller.ts';
import type { CheckerController } from '../app/passkey-checker/controller.ts';
import type { Change, CheckerStore, StoredChecker } from '../app/passkey-checker/store.ts';
import { CheckerStorageError } from '../app/passkey-checker/store.ts';
import {
  allGuidedCredentialsVerified,
  isGuidedVerification,
  nextGuidedAction,
} from '../app/passkey-checker/guided.ts';
import { guidedDatabase, roundDatabase, LEGACY_DATABASE } from '../app/passkey-checker/round.ts';
import { reportMarkdown } from '../app/passkey-checker/report.ts';
import { guidedCore, guidedRun } from './fixtures/passkey-checker-guided.ts';

function memoryStore() {
  let retained: StoredChecker | null = null;
  const changes: Change[] = [];
  const store: CheckerStore = {
    load: async () => structuredClone(retained),
    commit: async (_expected, change) => {
      changes.push(structuredClone(change));
      if (!retained)
        retained = {
          state: { run: change.run!, credentials: [], attempts: [], observations: [] },
          token: { runId: change.run!.id, revision: 0 },
        };
      if (change.run) retained.state.run = structuredClone(change.run);
      if (change.credential)
        retained.state.credentials = [
          ...retained.state.credentials.filter((row) => row.alias !== change.credential!.alias),
          structuredClone(change.credential),
        ];
      if (change.attempt)
        retained.state.attempts = [
          ...retained.state.attempts.filter((row) => row.id !== change.attempt!.id),
          structuredClone(change.attempt),
        ];
      if (change.observation) retained.state.observations.push(structuredClone(change.observation));
      retained.token.revision++;
      return { ...retained.token };
    },
    reset: async (_expected, run) => {
      retained = {
        state: { run, credentials: [], attempts: [], observations: [] },
        token: { runId: run.id, revision: 1 },
      };
      return retained.token;
    },
    close() {},
  };
  return { store, changes };
}
async function fixture(mode: 'eval' | 'enable-only' = 'eval') {
  const native = guidedCore();
  const memory = memoryStore();
  const options = {
    build: guidedRun().build,
    environment: guidedRun().environment,
    newRun: () => guidedRun(mode),
    core: native.core,
    openStore: async () => memory.store,
  };
  const controller = await createCheckerController(options);
  return { controller, native, memory, options };
}
async function next(controller: CheckerController, skip = false) {
  const action = nextGuidedAction(controller.exportModel());
  assert.ok(action, 'expected another guided action');
  await (skip
    ? controller.skipStep!(action.alias, action.step)
    : controller.runStep(action.alias, action.step));
  return action;
}
for (const mode of ['eval', 'enable-only'] as const)
  test(`guided ${mode}: exact names, stable identity, synchronous invocation and retained A/B/C`, async () => {
    const { controller, native } = await fixture(mode);
    const pending = controller.runStep('A', 'create');
    assert.equal(native.creations.length, 1, 'native create precedes first await');
    await controller.runStep('A', 'create');
    assert.equal(native.creations.length, 1, 'double click cannot enroll twice');
    await pending;
    await next(controller);
    const originalA = structuredClone(controller.exportModel().credentials[0]);
    for (let i = 0; i < 7; i++) await next(controller);
    const state = controller.exportModel();
    assert.equal(nextGuidedAction(state), undefined);
    assert.equal(allGuidedCredentialsVerified(state), true);
    assert.deepEqual(state.credentials[0], originalA);
    assert.equal(native.creations.length, 3);
    const [a, b, c] = native.creations.map((options) => options.publicKey!);
    assert.equal(a.user.name, b.user.name);
    assert.notEqual(a.user.name, c.user.name);
    assert.equal(a.user.displayName, b.user.displayName);
    assert.equal(a.user.displayName, c.user.displayName);
    assert.deepEqual(a.user.id, b.user.id);
    assert.deepEqual(a.user.id, c.user.id);
    assert.deepEqual(
      [a, b, c].map((value) => value.excludeCredentials?.length),
      [0, 1, 2],
    );
    for (const value of [a, b, c]) {
      assert.equal(value.authenticatorSelection?.userVerification, 'required');
      assert.equal(value.authenticatorSelection?.residentKey, 'required');
      const extensions = value.extensions as { prf: { eval?: unknown } };
      assert.equal(extensions.prf.eval !== undefined, mode === 'eval');
    }
    const report = reportMarkdown(state);
    assert.match(report, /Report schema: 4/);
    assert.match(report, /all three final checks verified/);
    assert.match(report, /registration username matches A: false/);
    assert.doesNotMatch(report, /Fresh use 3: unfinished|Use A after B creation fails: unfinished/);
    for (const credential of state.credentials) {
      assert.ok(!report.includes(credential.id));
      assert.ok(!report.includes(credential.salt));
      assert.ok(!report.includes(credential.cipher!.data));
    }
    const tampered = structuredClone(state);
    tampered.attempts.push({ ...state.attempts[0], id: 'later-native-attempt', sequence: 999 });
    assert.equal(
      isGuidedVerification(tampered, state.attempts.at(-1)!),
      false,
      'older final checks cannot qualify later enrollment',
    );
  });

test('failed B has exact linked A recovery and can continue to C without inventing B', async () => {
  const { controller, native } = await fixture();
  await next(controller);
  await next(controller);
  native.refuseCreate.add('B');
  await next(controller);
  const failure = controller.exportModel().attempts.at(-1)!;
  assert.equal(failure.error, 'unknown-error');
  assert.deepEqual(nextGuidedAction(controller.exportModel()), {
    alias: 'A',
    step: 'recover',
    afterAttemptId: failure.id,
  });
  await next(controller);
  await next(controller); // explicit retry B, a different failure/recovery pair
  assert.equal(controller.exportModel().attempts.at(-1)?.status, 'failed');
  await next(controller);
  await next(controller, true); // continue without B
  assert.deepEqual(nextGuidedAction(controller.exportModel()), { alias: 'C', step: 'create' });
  while (nextGuidedAction(controller.exportModel())) await next(controller);
  const state = controller.exportModel();
  assert.deepEqual(
    state.credentials.map((value) => value.alias),
    ['A', 'C'],
  );
  assert.equal(allGuidedCredentialsVerified(state), false);
  assert.equal(native.creations.length, 4);
  assert.equal(state.attempts.filter((row) => row.step === 'recover').length, 2);
  assert.match(reportMarkdown(state), /Unavailable — no credential was returned for this slot/);
  assert.match(reportMarkdown(state), /skipped by operator/);
  const skipWrites = controller.exportModel().attempts.filter((row) => row.status === 'skipped');
  assert.ok(skipWrites.every((row) => row.diagnostics === undefined));
});

test('wrong-credential and missing-PRF confirmation retry the existing credential with fresh challenges', async () => {
  const { controller, native } = await fixture();
  await next(controller);
  const created = structuredClone(controller.exportModel().credentials[0]);
  native.wrongGet.add('A');
  const reads = native.extensionReads();
  await next(controller);
  assert.equal(
    native.extensionReads(),
    reads,
    'mismatched credential stops before extension access',
  );
  assert.equal(controller.exportModel().attempts.at(-1)?.error, 'wrong-credential');
  native.wrongGet.clear();
  native.noOutput.add('A');
  await next(controller);
  assert.equal(controller.exportModel().attempts.at(-1)?.error, 'prf-absent');
  native.noOutput.clear();
  await next(controller);
  assert.equal(native.creations.length, 1);
  assert.equal(controller.exportModel().credentials[0].id, created.id);
  assert.equal(controller.exportModel().credentials[0].salt, created.salt);
  assert.notDeepEqual(
    native.assertions[0].publicKey!.challenge,
    native.assertions[1].publicKey!.challenge,
  );
});

test('a changed PRF output fails final verification without replacing original ciphertext', async () => {
  const { controller, native } = await fixture();
  for (let i = 0; i < 6; i++) await next(controller);
  const before = structuredClone(controller.exportModel().credentials);
  native.changedOutput.add('A');
  await next(controller);
  assert.equal(controller.exportModel().attempts.at(-1)?.error, 'decrypt-failed');
  assert.deepEqual(controller.exportModel().credentials, before);
  await next(controller, true);
  await next(controller);
  await next(controller);
  assert.equal(nextGuidedAction(controller.exportModel()), undefined);
  assert.equal(allGuidedCredentialsVerified(controller.exportModel()), false);
});

test('interrupted creation stays unknown after reload and recovery is required before retry', async () => {
  const { controller, memory, options } = await fixture();
  await next(controller);
  await next(controller);
  const state = controller.exportModel();
  await memory.store.commit(null, {
    attempt: {
      id: 'fictional-interrupted-B',
      alias: 'B',
      step: 'create',
      status: 'pending',
      sequence: 3,
      startedAt: state.run.createdAt,
      build: state.run.build,
      environment: state.run.environment,
    },
  });
  controller.close();
  const resumed = await createCheckerController(options);
  assert.equal(resumed.exportModel().attempts.at(-1)?.status, 'interrupted');
  assert.equal(nextGuidedAction(resumed.exportModel())?.step, 'recover');
  assert.equal(
    resumed.exportModel().credentials.some((value) => value.alias === 'B'),
    false,
  );
});

test('labels are fixed after starting, modes isolated, and incompatible storage stays explicit', async () => {
  const { controller, options } = await fixture();
  await controller.updateEnvironment({ provider: 'Fictional provider' });
  await next(controller);
  await controller.updateEnvironment({ provider: 'Different provider' });
  assert.equal(controller.exportModel().run.environment.provider.value, 'Fictional provider');
  const names = [
    LEGACY_DATABASE,
    roundDatabase('eval'),
    roundDatabase('enable-only'),
    guidedDatabase('eval'),
    guidedDatabase('enable-only'),
  ];
  assert.equal(new Set(names).size, names.length);
  const failed = await createCheckerController({
    ...options,
    openStore: async () => {
      throw new CheckerStorageError('unavailable');
    },
  });
  assert.equal(failed.getSnapshot().canRun, false);
  failed.continueInMemory();
  assert.equal(failed.getSnapshot().storage, 'ephemeral');
  await next(failed);
  assert.equal(failed.exportModel().attempts[0].status, 'created');
});
