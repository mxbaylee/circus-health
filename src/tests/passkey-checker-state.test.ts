import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckerController } from '../app/passkey-checker/controller.ts';
import type { ControllerOptions } from '../app/passkey-checker/controller.ts';
import { CheckerStorageError } from '../app/passkey-checker/store.ts';
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
