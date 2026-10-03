import { ENVIRONMENT_FIELDS, ERROR_MESSAGES, KNOWN_TRANSPORTS, stepsForAlias } from './types.ts';
import { isPrfDiagnostics } from './diagnostics.ts';
import { fictionalValue } from './core.ts';
import type { Attempt, CheckerState, CredentialRecord, Observation, RunHeader } from './types.ts';

export const CHECKER_DATABASE = 'circus-health-passkey-checker-v1';
const TABLES = ['header', 'credentials', 'attempts', 'observations'] as const;
export type StorageFailure = 'unavailable' | 'incompatible' | 'conflict';
export class CheckerStorageError extends Error {
  readonly reason: StorageFailure;
  constructor(reason: StorageFailure) {
    super(reason);
    this.reason = reason;
  }
}
export interface Revision {
  runId: string;
  revision: number;
}
export interface StoredChecker {
  state: CheckerState;
  token: Revision;
}
export interface Change {
  run?: RunHeader;
  credential?: CredentialRecord;
  attempt?: Attempt;
  observation?: Observation;
}
export interface CheckerStore {
  load(): Promise<StoredChecker | null>;
  commit(expected: Revision | null, change: Change): Promise<Revision>;
  reset(expected: Revision | null, run: RunHeader): Promise<Revision>;
  close(): void;
}

function failure(error: unknown): CheckerStorageError {
  if (error instanceof CheckerStorageError) return error;
  return new CheckerStorageError(
    error instanceof DOMException && error.name === 'VersionError' ? 'incompatible' : 'unavailable',
  );
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(failure(value.error));
  });
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(failure(tx.error));
    tx.onerror = () => {}; // Abort reports the transaction outcome.
  });
}
type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: unknown, required: string[], optional: string[] = []): value is ObjectValue {
  return (
    object(value) &&
    required.every((key) => key in value) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function text(value: unknown, max = 500): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function date(value: unknown): boolean {
  return text(value, 40) && Number.isFinite(Date.parse(value));
}
function build(value: unknown): boolean {
  return (
    keys(value, ['version', 'revision', 'worktree']) && Object.values(value).every((v) => text(v))
  );
}
function environment(value: unknown): boolean {
  return (
    keys(value, [...ENVIRONMENT_FIELDS]) &&
    Object.values(value).every(
      (v) =>
        keys(v, ['value', 'source'], ['reportedValue']) &&
        typeof v.value === 'string' &&
        v.value.length <= 200 &&
        (v.reportedValue === undefined ||
          (typeof v.reportedValue === 'string' && v.reportedValue.length <= 200)) &&
        ['browser-reported', 'operator', 'unknown'].includes(String(v.source)),
    )
  );
}
function alias(value: unknown): value is 'A' | 'B' {
  return value === 'A' || value === 'B';
}
function encoded(value: unknown, minBytes: number, maxBytes = minBytes): boolean {
  if (!text(value, Math.ceil((maxBytes * 4) / 3)) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return (
      binary.length >= minBytes &&
      binary.length <= maxBytes &&
      btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === value
    );
  } catch {
    return false;
  }
}
function validRun(value: unknown): value is RunHeader {
  return (
    keys(value, [
      'schemaVersion',
      'id',
      'origin',
      'secureContext',
      'rpId',
      'userId',
      'createdAt',
      'build',
      'environment',
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.secureContext === 'boolean' &&
    text(value.id) &&
    text(value.origin, 2048) &&
    text(value.rpId) &&
    encoded(value.userId, 32) &&
    date(value.createdAt) &&
    build(value.build) &&
    environment(value.environment)
  );
}
function validCredential(value: unknown): value is CredentialRecord {
  return (
    keys(value, ['alias', 'id', 'salt'], ['cipher', 'transports']) &&
    alias(value.alias) &&
    encoded(value.id, 1, 1024) &&
    encoded(value.salt, 32) &&
    (value.transports === undefined ||
      (Array.isArray(value.transports) &&
        value.transports.length <= KNOWN_TRANSPORTS.length &&
        new Set(value.transports).size === value.transports.length &&
        value.transports.every((transport) => KNOWN_TRANSPORTS.includes(transport)))) &&
    (value.cipher === undefined ||
      (keys(value.cipher, ['iv', 'data']) &&
        encoded(value.cipher.iv, 12) &&
        encoded(value.cipher.data, 17, 4096)))
  );
}
function validAttempt(value: unknown): value is Attempt {
  return (
    keys(
      value,
      ['id', 'alias', 'step', 'status', 'startedAt', 'build', 'environment'],
      ['error', 'finishedAt', 'diagnostics'],
    ) &&
    text(value.id) &&
    alias(value.alias) &&
    stepsForAlias(value.alias).some((step) => step === value.step) &&
    ['pending', 'created', 'verified', 'failed', 'interrupted'].includes(String(value.status)) &&
    (value.error === undefined ||
      (typeof value.error === 'string' && Object.hasOwn(ERROR_MESSAGES, value.error))) &&
    date(value.startedAt) &&
    (value.finishedAt === undefined || date(value.finishedAt)) &&
    (value.diagnostics === undefined || isPrfDiagnostics(value.diagnostics)) &&
    build(value.build) &&
    environment(value.environment) &&
    (value.status !== 'created' || value.step === 'create') &&
    (value.status !== 'verified' || value.step !== 'create')
  );
}
function validObservation(value: unknown): value is Observation {
  return (
    keys(value, ['id', 'alias', 'step', 'outcome', 'note', 'createdAt', 'build', 'environment']) &&
    text(value.id) &&
    alias(value.alias) &&
    (value.step === 'general' || stepsForAlias(value.alias).some((step) => step === value.step)) &&
    ['worked', 'failed', 'could-not-test'].includes(String(value.outcome)) &&
    typeof value.note === 'string' &&
    value.note.length <= 2000 &&
    date(value.createdAt) &&
    build(value.build) &&
    environment(value.environment)
  );
}

/** Separate rows keep each durable action proportional to the changed evidence. */
export async function openCheckerStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  name = CHECKER_DATABASE,
): Promise<CheckerStore> {
  if (!factory) throw new CheckerStorageError('unavailable');
  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(name, 1);
      let rejected = false;
      opening.onupgradeneeded = (event) => {
        if (event.oldVersion !== 0) {
          opening.transaction?.abort();
          return;
        }
        for (const table of TABLES) opening.result.createObjectStore(table);
      };
      opening.onsuccess = () => {
        if (rejected) opening.result.close();
        else resolve(opening.result);
      };
      opening.onerror = () => reject(failure(opening.error));
      opening.onblocked = () => {
        rejected = true;
        reject(new CheckerStorageError('unavailable'));
      };
    });
  } catch (error) {
    throw failure(error);
  }
  db.onversionchange = () => db.close();
  if (
    db.objectStoreNames.length !== TABLES.length ||
    TABLES.some((table) => !db.objectStoreNames.contains(table))
  ) {
    db.close();
    throw new CheckerStorageError('incompatible');
  }

  async function write(
    expected: Revision | null,
    change: Change,
    reset: boolean,
  ): Promise<Revision> {
    if (
      (change.run && !validRun(change.run)) ||
      (change.credential && !validCredential(change.credential)) ||
      (change.attempt && !validAttempt(change.attempt)) ||
      (change.observation && !validObservation(change.observation))
    )
      throw new CheckerStorageError('incompatible');
    const tx = db.transaction([...TABLES], 'readwrite');
    const done = complete(tx);
    // Attach rejection immediately even if a request aborts before it is awaited.
    void done.catch(() => {});
    try {
      const header = tx.objectStore('header');
      const previous = (await request(header.get('current'))) as
        { run: RunHeader; revision: number } | undefined;
      if (
        expected
          ? !previous ||
            previous.run.id !== expected.runId ||
            previous.revision !== expected.revision
          : previous !== undefined
      )
        throw new CheckerStorageError('conflict');
      if (!previous && !change.run) throw new CheckerStorageError('incompatible');
      if (reset) for (const table of TABLES) tx.objectStore(table).clear();
      const run = change.run ?? previous!.run;
      if (
        change.credential?.cipher &&
        !encoded(
          change.credential.cipher.data,
          fictionalValue(run, change.credential).byteLength + 16,
        )
      )
        throw new CheckerStorageError('incompatible');
      const revision = (previous?.revision ?? 0) + 1;
      header.put({ run, revision }, 'current');
      if (change.credential)
        tx.objectStore('credentials').put(change.credential, change.credential.alias);
      if (change.attempt) tx.objectStore('attempts').put(change.attempt, change.attempt.id);
      if (change.observation)
        tx.objectStore('observations').put(change.observation, change.observation.id);
      await done;
      return { runId: run.id, revision };
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already aborted or completed. */
      }
      throw failure(error);
    }
  }
  return {
    async load() {
      try {
        const tx = db.transaction([...TABLES], 'readonly');
        const done = complete(tx);
        void done.catch(() => {});
        if (
          TABLES.some((table) => {
            const rows = tx.objectStore(table);
            return rows.keyPath !== null || rows.autoIncrement || rows.indexNames.length !== 0;
          })
        )
          throw new CheckerStorageError('incompatible');
        const keyRequests = Promise.all(
          TABLES.map((table) => request(tx.objectStore(table).getAllKeys())),
        );
        void keyRequests.catch(() => {});
        const [headers, credentials, attempts, observations] = await Promise.all(
          TABLES.map((table) => request(tx.objectStore(table).getAll()) as Promise<unknown[]>),
        );
        const [headerKeys, credentialKeys, attemptKeys, observationKeys] = await keyRequests;
        await done;
        if (
          headers.length === 0 &&
          credentials.length === 0 &&
          attempts.length === 0 &&
          observations.length === 0
        )
          return null;
        const header = headers[0];
        if (
          headers.length !== 1 ||
          headerKeys[0] !== 'current' ||
          !keys(header, ['run', 'revision']) ||
          !validRun(header.run) ||
          !Number.isSafeInteger(header.revision) ||
          Number(header.revision) < 1 ||
          credentials.length > 2 ||
          !credentials.every(validCredential) ||
          !attempts.every(validAttempt) ||
          !observations.every(validObservation) ||
          credentials.some((value, index) => credentialKeys[index] !== value.alias) ||
          attempts.some((value, index) => attemptKeys[index] !== value.id) ||
          observations.some((value, index) => observationKeys[index] !== value.id) ||
          new Set(credentials.map((v) => v.alias)).size !== credentials.length ||
          new Set(credentials.map((v) => v.id)).size !== credentials.length
        )
          throw new CheckerStorageError('incompatible');
        const run = header.run;
        if (
          credentials.some(
            (credential) =>
              credential.cipher &&
              !encoded(credential.cipher.data, fictionalValue(run, credential).byteLength + 16),
          )
        )
          throw new CheckerStorageError('incompatible');
        return {
          state: {
            run: header.run,
            credentials,
            attempts: attempts.sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
            observations: observations.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
          },
          token: { runId: header.run.id, revision: Number(header.revision) },
        };
      } catch (error) {
        throw failure(error);
      }
    },
    commit: (expected, change) => write(expected, change, false),
    reset: (expected, run) => write(expected, { run }, true),
    close: () => db.close(),
  };
}

/** Only called by a deliberate reset when stored data cannot be interpreted. */
export async function deleteCheckerStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  name = CHECKER_DATABASE,
  onBlocked?: () => void,
): Promise<void> {
  if (!factory) throw new CheckerStorageError('unavailable');
  await new Promise<void>((resolve, reject) => {
    const deletion = factory.deleteDatabase(name);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => reject(failure(deletion.error));
    // IndexedDB deletion cannot be cancelled once queued. Keep the reset pending
    // and disclose that it will complete after other connections close.
    deletion.onblocked = () => onBlocked?.();
  });
}
