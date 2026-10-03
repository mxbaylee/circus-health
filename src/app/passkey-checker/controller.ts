import * as operations from './core.ts';
import { createRun, inspectEnvironment } from './environment.ts';
import { ENVIRONMENT_FIELDS } from './types.ts';
import type {
  Attempt,
  BuildInfo,
  CheckerState,
  CredentialAlias,
  Environment,
  Observation,
  Step,
} from './types.ts';
import { CheckerStorageError, deleteCheckerStore, openCheckerStore } from './store.ts';
import type { Change, CheckerStore, Revision, StorageFailure } from './store.ts';

export type StorageStatus = 'saved' | 'saving' | StorageFailure | 'ephemeral';
export interface CheckerSnapshot {
  state: CheckerState;
  currentBuild: BuildInfo;
  busy: boolean;
  storage: StorageStatus;
  warning?: string;
  canRun: boolean;
}
export interface CheckerController {
  getSnapshot(): CheckerSnapshot;
  subscribe(listener: () => void): () => void;
  canRunStep(alias: CredentialAlias, step: Step): boolean;
  updateEnvironment(patch: Partial<Record<keyof Environment, string>>): Promise<void>;
  runStep(alias: CredentialAlias, step: Step): Promise<void>;
  addObservation(input: Pick<Observation, 'alias' | 'step' | 'outcome' | 'note'>): Promise<void>;
  exportModel(): CheckerState;
  reset(): Promise<void>;
  continueInMemory(): void;
  close(): void;
}
export interface ControllerOptions {
  build: BuildInfo;
  environment?: Environment;
  /** Development fixtures only; the shipped UI always uses the native core. */
  core?: Pick<typeof operations, 'createCredential' | 'confirmCredential' | 'verifyCredential'>;
  openStore?: () => Promise<CheckerStore>;
  deleteStore?: (onBlocked?: () => void) => Promise<void>;
  newRun?: typeof createRun;
}
const warnings: Record<StorageFailure | 'ephemeral', string> = {
  unavailable:
    'Local progress could not be saved or read (storage may be blocked, full, or unavailable). Current visible results can still be exported. Choose unsaved testing explicitly to continue.',
  incompatible:
    'Existing local progress is incompatible or damaged. It has not been discarded. Export available results, or deliberately reset local progress; you may also choose unsaved testing.',
  conflict:
    'Another tab changed this run. This tab has stopped saving and testing to avoid overwriting it. Export this tab’s available results, then reload to resume the stored run.',
  ephemeral:
    'Unsaved testing: these visible results exist only in this tab. Export before leaving; reload will not restore unsaved progress.',
};
function identifier(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function createCheckerController(
  options: ControllerOptions,
): Promise<CheckerController> {
  const core = options.core ?? operations;
  const newRun = options.newRun ?? createRun;
  const open = options.openStore ?? openCheckerStore;
  const remove =
    options.deleteStore ?? ((onBlocked) => deleteCheckerStore(undefined, undefined, onBlocked));
  const fresh = (): CheckerState => ({
    run: newRun(options.build, options.environment ?? inspectEnvironment()),
    credentials: [],
    attempts: [],
    observations: [],
  });
  let state = fresh();
  let store: CheckerStore | undefined;
  let token: Revision | null = null;
  let storage: StorageStatus = 'saving';
  let warning: string | undefined;
  let busy = false;
  let closed = false;
  let writes = 0;
  let queue = Promise.resolve();
  const listeners = new Set<() => void>();
  let snapshot: CheckerSnapshot;
  function available(): boolean {
    return !closed && !busy && ['saved', 'saving', 'ephemeral'].includes(storage);
  }
  function publish() {
    snapshot = {
      state: structuredClone(state),
      currentBuild: structuredClone(options.build),
      busy,
      storage,
      warning,
      canRun: available(),
    };
    for (const listener of listeners) listener();
  }
  function failed(error: unknown) {
    storage = error instanceof CheckerStorageError ? error.reason : 'unavailable';
    warning = warnings[storage];
    publish();
  }
  function save(change: Change): Promise<void> {
    if (storage === 'ephemeral' || !store || !['saved', 'saving'].includes(storage))
      return Promise.resolve();
    // Freeze this mutation now: later metadata edits must not relabel earlier attempts.
    const mutation = structuredClone(change);
    writes += 1;
    storage = 'saving';
    publish();
    const task = queue
      .then(async () => {
        if (!store || !['saved', 'saving'].includes(storage)) return;
        try {
          token = await store.commit(token, mutation);
        } catch (error) {
          failed(error);
        }
      })
      .finally(() => {
        writes -= 1;
        if (writes === 0 && storage === 'saving') storage = 'saved';
        publish();
      });
    queue = task;
    return task;
  }
  try {
    store = await open();
    const retained = await store.load();
    let refreshed = false;
    if (retained) {
      if (
        retained.state.run.origin !== state.run.origin ||
        retained.state.run.rpId !== state.run.rpId
      )
        throw new CheckerStorageError('incompatible');
      const currentHints = state.run.environment;
      state = retained.state;
      token = retained.token;
      for (const key of ['browser', 'browserVersion', 'os', 'osVersion'] as const) {
        const previous = state.run.environment[key];
        const hint = currentHints[key];
        const updated =
          previous.source === 'operator' || previous.reportedValue !== undefined
            ? {
                ...previous,
                ...(hint.source === 'browser-reported' ? { reportedValue: hint.value } : {}),
              }
            : structuredClone(hint);
        if (JSON.stringify(previous) !== JSON.stringify(updated)) {
          state.run.environment[key] = updated;
          refreshed = true;
        }
      }
    } else token = await store.commit(null, { run: state.run });
    storage = 'saved';
    if (refreshed) await save({ run: state.run });
    // A pending native operation cannot be resumed or assumed successful after reload.
    for (const attempt of state.attempts)
      if (attempt.status === 'pending') {
        attempt.status = 'interrupted';
        attempt.finishedAt = new Date().toISOString();
        await save({ attempt });
      }
  } catch (error) {
    failed(error);
  }
  publish();

  function canRunStep(alias: CredentialAlias, step: Step): boolean {
    if (!available() || !['A', 'B'].includes(alias)) return false;
    const credential = state.credentials.find((item) => item.alias === alias);
    if (step === 'create') return !credential;
    if (step === 'confirm') return !!credential && !credential.cipher;
    if (!credential?.cipher || !['use-1', 'use-2', 'use-3'].includes(step)) return false;
    if (
      state.attempts.some(
        (item) => item.alias === alias && item.step === step && item.status === 'verified',
      )
    )
      return false;
    const previous = step === 'use-2' ? 'use-1' : step === 'use-3' ? 'use-2' : 'confirm';
    return state.attempts.some(
      (item) => item.alias === alias && item.step === previous && item.status === 'verified',
    );
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    canRunStep,
    async updateEnvironment(patch) {
      if (!available()) return;
      for (const key of ENVIRONMENT_FIELDS)
        if (patch[key] !== undefined) {
          const previous = state.run.environment[key];
          const value = patch[key]!.slice(0, 200);
          const reportedValue =
            previous.reportedValue ??
            (previous.source === 'browser-reported' ? previous.value : undefined);
          state.run.environment[key] = {
            value,
            source: value.trim() ? 'operator' : 'unknown',
            ...(reportedValue ? { reportedValue } : {}),
          };
        }
      publish();
      await save({ run: state.run });
    },
    async runStep(alias, step) {
      if (!canRunStep(alias, step)) return;
      busy = true;
      const attempt: Attempt = {
        id: identifier(),
        alias,
        step,
        status: 'pending',
        startedAt: new Date().toISOString(),
        build: structuredClone(options.build),
        environment: structuredClone(state.run.environment),
      };
      state.attempts.push(attempt);
      publish();
      const pendingSave = save({ attempt });
      // No await (including IndexedDB) may precede this native prompt invocation.
      // Safari requires the original button gesture for credential operations.
      try {
        const credential = state.credentials.find((item) => item.alias === alias);
        const result =
          step === 'create'
            ? await core.createCredential(state.run, alias, state.credentials)
            : step === 'confirm'
              ? await core.confirmCredential(state.run, credential!)
              : await core.verifyCredential(state.run, credential!);
        if (result) {
          const publicCredential = {
            alias: result.alias,
            id: result.id,
            salt: result.salt,
            ...(result.transports ? { transports: [...result.transports] } : {}),
            ...(result.cipher
              ? { cipher: { iv: result.cipher.iv, data: result.cipher.data } }
              : {}),
          };
          state.credentials = [
            ...state.credentials.filter((item) => item.alias !== alias),
            publicCredential,
          ];
        }
        attempt.status = step === 'create' ? 'created' : 'verified';
      } catch (error) {
        attempt.status = 'failed';
        attempt.error = operations.sanitizeError(error);
      }
      attempt.finishedAt = new Date().toISOString();
      publish();
      await pendingSave;
      await save({
        attempt,
        ...(step === 'create' || step === 'confirm'
          ? { credential: state.credentials.find((item) => item.alias === alias) }
          : {}),
      });
      busy = false;
      publish();
    },
    async addObservation(input) {
      if (!available()) return;
      if (
        !['A', 'B'].includes(input.alias) ||
        !['create', 'confirm', 'use-1', 'use-2', 'use-3', 'general'].includes(input.step) ||
        !['worked', 'failed', 'could-not-test'].includes(input.outcome)
      )
        return;
      const observation: Observation = {
        id: identifier(),
        alias: input.alias,
        step: input.step,
        outcome: input.outcome,
        note: input.note.slice(0, 2000),
        createdAt: new Date().toISOString(),
        build: structuredClone(options.build),
        environment: structuredClone(state.run.environment),
      };
      state.observations.push(observation);
      publish();
      await save({ observation });
    },
    exportModel: () => structuredClone(state),
    async reset() {
      if (busy || closed || storage === 'conflict') return;
      busy = true;
      publish();
      await queue;
      const replacement = fresh();
      try {
        if (storage === 'ephemeral') {
          // Unsaved mode must not erase an unreadable or concurrently changed stored run.
          state = replacement;
        } else if (storage === 'incompatible') {
          store?.close();
          await remove(() => {
            warning =
              'Reset is waiting for another checker tab to close its storage connection. Export remains available. The reset will complete when that connection closes.';
            publish();
          });
          store = await open();
          token = await store.commit(null, { run: replacement.run });
          state = replacement;
          storage = 'saved';
          warning = undefined;
        } else {
          if (!store) store = await open();
          token = await store.reset(token, replacement.run);
          state = replacement;
          storage = 'saved';
          warning = undefined;
        }
      } catch (error) {
        failed(error);
      }
      busy = false;
      publish();
    },
    continueInMemory() {
      if (busy || closed || !['unavailable', 'incompatible'].includes(storage)) return;
      storage = 'ephemeral';
      warning = warnings.ephemeral;
      publish();
    },
    close() {
      closed = true;
      store?.close();
      listeners.clear();
      publish();
    },
  };
}
