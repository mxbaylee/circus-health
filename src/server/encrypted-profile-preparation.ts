import { Worker } from 'node:worker_threads';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { VaultKey } from './vault-crypto.ts';
import { HttpError } from './database.ts';
import type { UnlockPhysicalWitness } from './encrypted-unlock-physical.ts';
import type { createRecordVersionWorkCounters } from './record-version-work.ts';
import type { IntakeWorkCounters } from './intake-work-accounting.ts';

export interface UnlockAuthorityWitness {
  directory: string;
  manifest: string;
  keyring: string;
}
export interface PreparedUnlock {
  metrics: { cacheHit: boolean; loadMs: number };
  storageBytes: number;
  rootIdentity: string;
  databaseIdentity: string;
  selectedHead: string;
  physicalWitness: UnlockPhysicalWitness;
  work: {
    records: ReturnType<typeof createRecordVersionWorkCounters>;
    intake: IntakeWorkCounters;
  };
}
export function unlockPathIdentity(path: string, directory = false): string {
  const stat = lstatSync(path, { bigint: true });
  if (
    realpathSync(path) !== path ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
  )
    throw Error('Encrypted profile preparation changed');
  return directory
    ? `${stat.dev}:${stat.ino}`
    : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
export function unlockAuthorityWitness(directory: string): UnlockAuthorityWitness {
  const manifest = resolve(directory, 'vault/manifest.enc');
  const identity = unlockPathIdentity(manifest);
  if (lstatSync(manifest).size > 20 * 1024) throw Error('Invalid encrypted vault head');
  const sha256 = createHash('sha256').update(readFileSync(manifest)).digest('hex');
  if (unlockPathIdentity(manifest) !== identity)
    throw Error('Encrypted profile preparation changed');
  return {
    directory: unlockPathIdentity(directory, true),
    manifest: `${identity}:${sha256}`,
    keyring: unlockPathIdentity(resolve(directory, 'keyring.json')),
  };
}
export function assertUnlockAuthority(directory: string, expected: UnlockAuthorityWitness): void {
  const current = unlockAuthorityWitness(directory);
  if (
    current.directory !== expected.directory ||
    current.manifest !== expected.manifest ||
    current.keyring !== expected.keyring
  )
    throw Error('Encrypted profile preparation changed');
}

export async function prepareEncryptedUnlock<Result = PreparedUnlock>(
  options: {
    dataDirectory: string;
    runtimeDirectory: string;
    profileId: string;
    key: VaultKey;
    authority: UnlockAuthorityWitness;
    signal: AbortSignal;
    availableRuntimeBytes: number | null;
    checkpoint?: () => void;
    witnessDirectory?: string;
    physicalWitness?: UnlockPhysicalWitness;
  },
  createWorker: (workerData: unknown, transferList: ArrayBuffer[]) => Worker = (
    workerData,
    transferList,
  ) =>
    new Worker(new URL('./encrypted-profile-preparation-worker.ts', import.meta.url), {
      workerData,
      transferList,
    }),
): Promise<Result> {
  options.signal.throwIfAborted();
  // Transfer an independently owned copy; never detach the caller's active key.
  const keyCopy = new Uint8Array(32);
  keyCopy.set(options.key);
  let worker: Worker;
  try {
    worker = createWorker({ ...options, signal: undefined, checkpoint: undefined, key: keyCopy }, [
      keyCopy.buffer,
    ]);
  } catch (error) {
    keyCopy.fill(0);
    throw error;
  }
  let exited = false;
  let ready = false;
  let started = false;
  let bootResolve!: () => void;
  const boot = new Promise<void>((resolve) => {
    bootResolve = resolve;
  });
  let failed = false;
  let failure: unknown;
  let exitResolve!: () => void;
  const exit = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });
  let resultResolve!: (value: Result) => void;
  let resultReject!: (error: unknown) => void;
  let received = false;
  const result = new Promise<Result>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  const fail = (error: unknown) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
    resultReject(error);
    if (!exited && ready) {
      if (started) void worker.terminate();
      else worker.postMessage({ cancel: true });
    }
  };
  const abort = () => fail(options.signal.reason);
  options.signal.addEventListener('abort', abort, { once: true });
  worker.on('error', () => {
    bootResolve();
    fail(Error('Encrypted profile preparation failed'));
  });
  worker.on(
    'message',
    (message: {
      prepared?: Result;
      failure?: { status: number; code: string; message: string };
      progress?: true;
      ready?: true;
    }) => {
      try {
        if (message.ready) {
          if (ready) throw Error('Encrypted profile preparation failed');
          ready = true;
          bootResolve();
          if (failed) {
            worker.postMessage({ cancel: true });
            return;
          }
          options.signal.throwIfAborted();
          options.checkpoint?.();
          options.signal.throwIfAborted();
          started = true;
          worker.postMessage({ start: true });
          return;
        }
        if (!ready || !started) throw Error('Encrypted profile preparation failed');
        options.signal.throwIfAborted();
        options.checkpoint?.();
        if (message.progress) return;
        if (message.failure)
          throw new HttpError(
            message.failure.status,
            message.failure.code,
            message.failure.message,
          );
        if (!message.prepared || received) throw Error('Encrypted profile preparation failed');
        received = true;
        resultResolve(message.prepared);
      } catch (error) {
        fail(error);
      }
    },
  );
  worker.on('exit', (code) => {
    exited = true;
    bootResolve();
    exitResolve();
    if (code !== 0 || !received) fail(Error('Encrypted profile preparation failed'));
  });
  try {
    const prepared = await result;
    await exit;
    if (failed) throw failure;
    options.signal.throwIfAborted();
    return prepared;
  } finally {
    await boot;
    if (!exited && started) await worker.terminate();
    else if (!exited && ready) worker.postMessage({ cancel: true });
    await exit;
    options.signal.removeEventListener('abort', abort);
  }
}
