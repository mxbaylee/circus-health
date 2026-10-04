import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckerController } from '../app/passkey-checker/controller.ts';
import type { ControllerOptions } from '../app/passkey-checker/controller.ts';
import { CheckerStorageError } from '../app/passkey-checker/store.ts';
import { CheckerError } from '../app/passkey-checker/core.ts';
import { isVerifiedAAfterFailedB, isVerifiedReturnToA } from '../app/passkey-checker/progress.ts';
import type {
  Change,
  CheckerStore,
  Revision,
  StoredChecker,
} from '../app/passkey-checker/store.ts';
import type {
  BuildInfo,
  CheckerState,
  CredentialRecord,
  Environment,
} from '../app/passkey-checker/types.ts';

const build: BuildInfo = { version: 'fixture', revision: 'fictional', worktree: 'clean' };
const environment: Environment = {
  browser: { value: 'Fixture browser', source: 'browser-reported' },
  browserVersion: { value: '1', source: 'browser-reported' },
  os: { value: '', source: 'unknown' },
  osVersion: { value: '', source: 'unknown' },
  provider: { value: '', source: 'unknown' },
  providerVersion: { value: '', source: 'unknown' },
};
function run(info = build, labels = environment) {
  return {
    schemaVersion: 1 as const,
    id: crypto.randomUUID(),
    origin: 'https://fictional.invalid',
    secureContext: true,
    rpId: 'fictional.invalid',
    userId: 'ZmljdGlvbmFs',
    createdAt: new Date().toISOString(),
    build: structuredClone(info),
    environment: structuredClone(labels),
  };
}
/** Controlled state-machine fixtures; these are never physical qualification. */
function fixture() {
  let retained: StoredChecker | null = null;
  const changes: Change[] = [];
  let fail = false;
  const store: CheckerStore = {
    load: async () => structuredClone(retained),
    async commit(expected, change) {
      if (fail) throw new CheckerStorageError('unavailable');
      if (
        expected?.runId !== retained?.token.runId ||
        expected?.revision !== retained?.token.revision
      )
        throw new CheckerStorageError('conflict');
      changes.push(structuredClone(change));
      const state: CheckerState = retained?.state ?? {
        run: change.run!,
        credentials: [],
        attempts: [],
        observations: [],
      };
      if (change.run) state.run = structuredClone(change.run);
      if (change.credential)
        state.credentials = [
          ...state.credentials.filter((v) => v.alias !== change.credential!.alias),
          structuredClone(change.credential),
        ];
      if (change.attempt)
        state.attempts = [
          ...state.attempts.filter((v) => v.id !== change.attempt!.id),
          structuredClone(change.attempt),
        ];
      if (change.observation) state.observations.push(structuredClone(change.observation));
      const token = { runId: state.run.id, revision: (retained?.token.revision ?? 0) + 1 };
      retained = { state, token };
      return token;
    },
    async reset(expected: Revision | null, header) {
      if (
        expected?.runId !== retained?.token.runId ||
        expected?.revision !== retained?.token.revision
      )
        throw new CheckerStorageError('conflict');
      retained = null;
      return store.commit(null, { run: header });
    },
    close() {},
  };
  const core: NonNullable<ControllerOptions['core']> = {
    async createCredential(_run, alias) {
      return { alias, id: `fictional-${alias}`, salt: 'salt' };
    },
    async confirmCredential(_run, credential) {
      return { ...credential, cipher: { iv: 'iv', data: 'fictional' } };
    },
    async verifyCredential() {},
  };
  const options: ControllerOptions = {
    build,
    environment,
    core,
    newRun: run,
    openStore: async () => store,
  };
  return {
    options,
    changes,
    get retained() {
      return retained;
    },
    fail() {
      fail = true;
    },
  };
}

test('native operation starts synchronously before pending persistence and duplicate gestures are blocked', async () => {
  const f = fixture();
  let called = false;
  let finish!: (record: CredentialRecord) => void;
  f.options.core!.createCredential = () => {
    called = true;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const controller = await createCheckerController(f.options);
  const pending = controller.runStep('A', 'create');
  assert.equal(called, true);
  assert.equal(f.changes.length, 1, 'native prompt preceded the queued pending write');
  assert.equal(controller.canRunStep('A', 'create'), false);
  await controller.runStep('A', 'create');
  finish({ alias: 'A', id: 'fictional-A', salt: 'salt' });
  await pending;
  assert.deepEqual(f.changes.map((v) => v.attempt?.status).filter(Boolean), ['pending', 'created']);
  assert.deepEqual(f.changes.map((v) => v.attempt?.sequence).filter(Boolean), [1, 1]);
  assert.equal(controller.exportModel().attempts.length, 1);
});

test('failed retries remain evidence; metadata/build snapshots and independent B survive reload', async () => {
  const f = fixture();
  const controller = await createCheckerController(f.options);
  await controller.runStep('A', 'create');
  assert.equal(controller.canRunStep('A', 'use-1'), false);
  f.options.core!.confirmCredential = async () => {
    throw new DOMException('sensitive fixture detail', 'NotAllowedError');
  };
  await controller.runStep('A', 'confirm');
  assert.equal(controller.canRunStep('B', 'create'), true);
  await controller.updateEnvironment({ browser: 'Corrected', provider: 'Fictional provider' });
  f.options.core!.confirmCredential = async (_run, credential) => ({
    ...credential,
    cipher: { iv: 'iv', data: 'fictional' },
  });
  await controller.runStep('A', 'confirm');
  assert.equal(controller.canRunStep('A', 'confirm'), false);
  assert.equal(controller.canRunStep('A', 'use-2'), false);
  for (const step of ['use-1', 'use-2', 'use-3'] as const) await controller.runStep('A', step);
  const restored = await createCheckerController({
    ...f.options,
    build: { ...build, revision: 'new-build' },
    environment: { ...environment, browserVersion: { value: '2', source: 'browser-reported' } },
  });
  const state = restored.exportModel();
  assert.equal(state.attempts[1].status, 'failed');
  assert.equal(state.attempts[1].error, 'not-allowed');
  assert.equal(state.attempts[1].environment.browser.value, 'Fixture browser');
  assert.equal(state.attempts[2].environment.browser.reportedValue, 'Fixture browser');
  assert.equal(state.attempts[2].environment.browser.value, 'Corrected');
  assert.equal(state.attempts[2].build.revision, 'fictional');
  assert.equal(state.run.environment.browserVersion.value, '2');
  assert.equal(state.attempts[2].environment.browserVersion.value, '1');
  assert.equal(restored.getSnapshot().currentBuild.revision, 'new-build');
  await restored.runStep('B', 'create');
  const newest = restored.exportModel().attempts.at(-1)!;
  assert.equal(newest.build.revision, 'new-build');
  assert.equal(newest.environment.browserVersion.value, '2');
  assert.ok(
    f.changes.every((change) => !('attempts' in change)),
    'writes never contain accumulated history',
  );
});

test('only public credential fields are persisted from the operation result', async () => {
  const f = fixture();
  f.options.core!.createCredential = async (_run, alias) => ({
    alias,
    id: 'fictional-A',
    salt: 'salt',
    rawPrf: 'must-not-persist',
    key: 'must-not-persist',
  });
  const controller = await createCheckerController(f.options);
  await controller.runStep('A', 'create');
  assert.deepEqual(controller.exportModel().credentials[0], {
    alias: 'A',
    id: 'fictional-A',
    salt: 'salt',
  });
  assert.equal(JSON.stringify(f.changes).includes('must-not-persist'), false);
});

test('return to A requires B creation, uses retained ciphertext despite B failure and preserves retries', async () => {
  const f = fixture();
  const controller = await createCheckerController(f.options);
  assert.equal(controller.canRunStep('B', 'create'), false);
  assert.equal(controller.canRunStep('A', 'use-after-b'), false);
  await controller.runStep('A', 'create');
  await controller.runStep('A', 'confirm');
  for (const step of ['use-1', 'use-2', 'use-3'] as const) await controller.runStep('A', step);
  const originalA = structuredClone(controller.exportModel().credentials[0]);
  assert.equal(controller.canRunStep('A', 'use-after-b'), false);
  await controller.runStep('B', 'create');
  f.options.core!.confirmCredential = async () => {
    throw new CheckerError('prf-absent');
  };
  await controller.runStep('B', 'confirm');
  assert.equal(controller.canRunStep('A', 'use-after-b'), true);
  assert.equal(controller.canRunStep('B', 'use-after-b'), false);
  let calls = 0;
  f.options.core!.verifyCredential = async (_run, credential) => {
    assert.deepEqual(credential, originalA);
    if (++calls === 1) throw new CheckerError('wrong-credential');
  };
  await controller.runStep('A', 'use-after-b');
  assert.equal(controller.canRunStep('A', 'use-after-b'), true);
  controller.close();
  const resumed = await createCheckerController({
    ...f.options,
    build: { ...build, revision: 'return-check-build' },
  });
  await resumed.runStep('A', 'use-after-b');
  assert.equal(calls, 2);
  assert.equal(resumed.canRunStep('A', 'use-after-b'), false);
  const state = resumed.exportModel();
  assert.deepEqual(
    state.credentials.find((v) => v.alias === 'A'),
    originalA,
  );
  assert.equal(state.credentials.find((v) => v.alias === 'B')?.cipher, undefined);
  assert.deepEqual(
    state.attempts.filter((v) => v.step === 'use-after-b').map((v) => [v.status, v.error]),
    [
      ['failed', 'wrong-credential'],
      ['verified', undefined],
    ],
  );
  assert.equal(state.attempts.at(-1)?.build.revision, 'return-check-build');
  assert.equal(state.attempts.filter((v) => v.alias === 'A' && v.status === 'verified').length, 5);
  const count = state.observations.length;
  await resumed.addObservation({ alias: 'B', step: 'use-after-b', outcome: 'worked', note: '' });
  assert.equal(resumed.exportModel().observations.length, count);
  resumed.close();
  // A clock change or damaged chronology must not leave the report unfinished
  // while preventing the operator from obtaining a fresh, ordered observation.
  f.retained!.state.attempts.at(-1)!.startedAt = '1970-01-01T00:00:00.000Z';
  delete f.retained!.state.attempts.at(-1)!.sequence;
  const unordered = await createCheckerController(f.options);
  assert.equal(unordered.canRunStep('A', 'use-after-b'), true);
  await unordered.runStep('A', 'use-after-b');
  assert.equal(calls, 3);
  assert.equal(unordered.canRunStep('A', 'use-after-b'), false);
});

test('fresh A recovery after failed B creation preserves history, original ciphertext and exact failure association', async () => {
  const f = fixture();
  const controller = await createCheckerController(f.options);
  await controller.runStep('A', 'create');
  assert.equal(controller.canRunStep('A', 'use-after-b-failed'), false);
  await controller.runStep('A', 'confirm');
  for (const step of ['use-1', 'use-2', 'use-3'] as const) await controller.runStep('A', step);
  const earlier = structuredClone(controller.exportModel().attempts);
  const originalA = structuredClone(controller.exportModel().credentials[0]);
  const create = f.options.core!.createCredential;
  f.options.core!.createCredential = async () => {
    throw new DOMException('private native detail', 'InvalidStateError');
  };
  await controller.runStep('B', 'create');
  const bFailure = structuredClone(controller.exportModel().attempts.at(-1)!);
  assert.equal(controller.canRunStep('A', 'use-after-b-failed'), true);
  assert.equal(controller.canRunStep('B', 'use-after-b-failed'), false);
  assert.equal(controller.canRunStep('A', 'use-after-b'), false);
  let calls = 0;
  f.options.core!.verifyCredential = async (_run, credential) => {
    assert.deepEqual(credential, originalA);
    if (++calls === 1) throw new CheckerError('decrypt-failed');
  };
  await controller.runStep('A', 'use-after-b-failed');
  const failed = controller.exportModel().attempts.at(-1)!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'decrypt-failed');
  assert.equal(failed.afterAttemptId, bFailure.id);
  assert.equal(isVerifiedAAfterFailedB(controller.exportModel(), failed), false);
  assert.equal(controller.canRunStep('A', 'use-after-b-failed'), true);
  controller.close();
  const restored = await createCheckerController({
    ...f.options,
    build: { ...build, revision: 'recovery-build' },
  });
  await restored.runStep('A', 'use-after-b-failed');
  const state = restored.exportModel();
  const recovery = state.attempts.at(-1)!;
  assert.equal(recovery.build.revision, 'recovery-build');
  assert.equal(isVerifiedAAfterFailedB(state, recovery), true);
  assert.equal(isVerifiedReturnToA(state, recovery), false);
  assert.equal(restored.canRunStep('A', 'use-after-b-failed'), false);
  assert.deepEqual(state.credentials, [originalA]);
  assert.deepEqual(state.attempts.slice(0, earlier.length), earlier);
  assert.deepEqual(
    state.attempts.find((attempt) => attempt.id === bFailure.id),
    bFailure,
  );
  for (const afterAttemptId of [undefined, recovery.id, 'orphan', earlier[0].id, earlier[1].id])
    assert.equal(isVerifiedAAfterFailedB(state, { ...recovery, afterAttemptId }), false);
  assert.equal(
    isVerifiedAAfterFailedB(state, {
      ...recovery,
      startedAt: '1970-01-01T00:00:00.000Z',
      sequence: undefined,
    }),
    false,
  );
  assert.equal(
    isVerifiedAAfterFailedB(state, { ...recovery, startedAt: '1970-01-01T00:00:00.000Z' }),
    true,
    'causal sequences survive a backward wall clock',
  );
  assert.equal(isVerifiedAAfterFailedB(state, { ...recovery, sequence: bFailure.sequence }), false);
  // A later failed B retry needs a new check; the old success remains true only for its own failure.
  await restored.runStep('B', 'create');
  const laterFailure = restored.exportModel().attempts.at(-1)!;
  assert.notEqual(laterFailure.id, bFailure.id);
  assert.equal(restored.canRunStep('A', 'use-after-b-failed'), true);
  assert.equal(isVerifiedAAfterFailedB(restored.exportModel(), recovery), true);
  await restored.runStep('A', 'use-after-b-failed');
  assert.equal(restored.exportModel().attempts.at(-1)!.afterAttemptId, laterFailure.id);
  f.options.core!.createCredential = create;
  await restored.runStep('B', 'create');
  assert.equal(restored.canRunStep('A', 'use-after-b-failed'), false);
  assert.equal(restored.canRunStep('A', 'use-after-b'), true);
  assert.equal(isVerifiedAAfterFailedB(restored.exportModel(), recovery), true);
  assert.ok(f.changes.every((change) => !('attempts' in change)));
  const count = restored.exportModel().observations.length;
  await restored.addObservation({
    alias: 'B',
    step: 'use-after-b-failed',
    outcome: 'worked',
    note: '',
  });
  assert.equal(restored.exportModel().observations.length, count);
  restored.close();
});

test('sequenced A return after created B survives a backward clock; overflow never invokes native operations', async () => {
  const f = fixture();
  const controller = await createCheckerController(f.options);
  await controller.runStep('A', 'create');
  await controller.runStep('A', 'confirm');
  await controller.runStep('B', 'create');
  await controller.runStep('A', 'use-after-b');
  const state = controller.exportModel();
  const returned = state.attempts.at(-1)!;
  assert.equal(
    isVerifiedReturnToA(state, { ...returned, startedAt: '1970-01-01T00:00:00.000Z' }),
    true,
  );
  assert.equal(
    isVerifiedReturnToA(state, {
      ...returned,
      startedAt: '1970-01-01T00:00:00.000Z',
      sequence: undefined,
    }),
    false,
  );
  controller.close();
  f.retained!.state.attempts.at(-1)!.sequence = Number.MAX_SAFE_INTEGER;
  let nativeCalls = 0;
  f.options.core!.confirmCredential = async (_run, credential) => {
    nativeCalls++;
    return credential;
  };
  const overflow = await createCheckerController(f.options);
  const count = overflow.exportModel().attempts.length;
  await overflow.runStep('B', 'confirm');
  assert.equal(nativeCalls, 0);
  assert.equal(overflow.exportModel().attempts.length, count);
  assert.equal(overflow.getSnapshot().storage, 'incompatible');
  overflow.close();
});

test('captured safe core classification stays failed without rereading a hostile native error', async () => {
  const f = fixture();
  const controller = await createCheckerController(f.options);
  await controller.runStep('A', 'create');
  let nameReads = 0;
  f.options.core!.confirmCredential = async (_run, _credential, _port, observe) => {
    observe?.({
      requestMode: 'eval',
      inputShape: 'array-buffer',
      stage: 'native-get',
      applicationError: 'invalid-state',
      nativeErrorName: 'InvalidStateError',
    });
    throw Object.defineProperty({}, 'name', {
      get() {
        nameReads++;
        throw Error('private fixture');
      },
    });
  };
  await controller.runStep('A', 'confirm');
  assert.equal(controller.exportModel().attempts.at(-1)!.status, 'failed');
  assert.equal(controller.exportModel().attempts.at(-1)!.error, 'invalid-state');
  assert.equal(nameReads, 0);
  assert.equal(controller.getSnapshot().busy, false);
  controller.close();
});

test('safe diagnostics persist on failed attempts without relabeling legacy errors or retaining native material', async () => {
  const f = fixture();
  const controller = await createCheckerController(f.options);
  await controller.runStep('A', 'create');
  f.options.core!.confirmCredential = async () => {
    throw new CheckerError('missing-prf');
  };
  await controller.runStep('A', 'confirm');
  const legacy = structuredClone(controller.exportModel().attempts.at(-1)!);
  const raw = {
    requestMode: 'eval' as const,
    inputShape: 'array-buffer' as const,
    inputLength: 32,
    extensionPresent: true,
    resultsPresent: true,
    outputShape: 'string' as const,
    outputLength: 7,
    credentialMatched: true,
    rawPrf: 'must-not-persist',
    rawId: 'must-not-persist',
  };
  f.options.core!.confirmCredential = async (_run, _credential, _port, observe) => {
    observe?.(raw);
    // A retained callback input must not alias durable evidence.
    raw.outputLength = 99;
    throw new CheckerError('prf-invalid');
  };
  await controller.runStep('A', 'confirm');
  const latest = controller.exportModel().attempts.at(-1)!;
  assert.equal(latest.error, 'prf-invalid');
  assert.equal(latest.diagnostics?.outputLength, 7);
  assert.equal('rawPrf' in latest.diagnostics!, false);
  assert.equal(JSON.stringify(f.changes).includes('must-not-persist'), false);
  controller.close();
  const resumed = await createCheckerController(f.options);
  assert.deepEqual(resumed.exportModel().attempts[1], legacy);
  assert.equal(resumed.exportModel().attempts[1].diagnostics, undefined);
  assert.deepEqual(resumed.exportModel().attempts.at(-1), latest);
});

test('reload interrupts pending evidence and stale tab conflicts preserve its export', async () => {
  const f = fixture();
  let finish!: (record: CredentialRecord) => void;
  f.options.core!.createCredential = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = await createCheckerController(f.options);
  const pending = first.runStep('A', 'create');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = await createCheckerController(f.options);
  assert.equal(second.exportModel().attempts[0].status, 'interrupted');
  finish({ alias: 'A', id: 'fictional-A', salt: 'salt' });
  await pending;
  assert.equal(first.getSnapshot().storage, 'conflict');
  assert.equal(first.exportModel().attempts[0].status, 'created');
  assert.equal(f.retained!.state.attempts[0].status, 'interrupted');
  first.continueInMemory();
  assert.equal(first.getSnapshot().canRun, false);
});

test('write failure keeps actual result visibly unsaved and explicit fallback never repairs storage silently', async () => {
  const f = fixture();
  const controller = await createCheckerController(f.options);
  f.fail();
  await controller.runStep('A', 'create');
  assert.equal(controller.exportModel().attempts[0].status, 'created');
  assert.equal(controller.getSnapshot().storage, 'unavailable');
  assert.equal(controller.getSnapshot().canRun, false);
  assert.equal(f.retained!.state.attempts.length, 0);
  controller.continueInMemory();
  await controller.addObservation({
    alias: 'A',
    step: 'general',
    outcome: 'could-not-test',
    note: 'Fictional observation',
  });
  assert.equal(controller.getSnapshot().storage, 'ephemeral');
  assert.equal(controller.exportModel().observations.length, 1);
  assert.equal(f.retained!.state.observations.length, 0);
});

test('incompatible storage remains intact until deliberate reset; manual metadata is available in fallback', async () => {
  const f = fixture();
  let resets = 0;
  const controller = await createCheckerController({
    ...f.options,
    openStore: async () => {
      if (!resets) throw new CheckerStorageError('incompatible');
      return f.options.openStore!();
    },
    deleteStore: async () => {
      resets++;
    },
  });
  assert.equal(controller.getSnapshot().storage, 'incompatible');
  assert.equal(resets, 0);
  await controller.reset();
  assert.equal(resets, 1);
  assert.equal(controller.getSnapshot().storage, 'saved');
  await controller.updateEnvironment({ osVersion: 'Fictional OS 2' });
  await controller.addObservation({
    alias: 'B',
    step: 'general',
    outcome: 'could-not-test',
    note: '',
  });
  assert.equal(controller.exportModel().observations.length, 1);
});
