import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { observeDatabaseClose } from './database.ts';
import { assertAuthorizationSignalRunning } from './authorization-signal.ts';

/** Private, active ownership; never a transported or retained review authority. */
export interface ClinicalOperation {
  readonly clinicalOperation: unique symbol;
}
type Frame = {
  db: DatabaseSync;
  token: ClinicalOperation;
  controller: AbortController;
  active: boolean;
  assertRunning?: () => void;
  signal?: AbortSignal;
  child?: Promise<unknown>;
  parent?: Frame;
};
type Pending = { start: () => void; reject: (reason: unknown) => void; dispose: () => void };
type Lane = { active: boolean; closed: boolean; pending: Pending[]; controller?: AbortController };
const context = new AsyncLocalStorage<Frame>();
const frames = new WeakMap<ClinicalOperation, Frame>();
const lanes = new WeakMap<DatabaseSync, Lane>();
const unavailable = () => new Error('Clinical operation is no longer active');

function check(frame: Frame, assertions = true) {
  if (!frame.active || !frame.db.isOpen) throw unavailable();
  if (assertions) {
    frame.controller.signal.throwIfAborted();
    frame.signal?.throwIfAborted();
    frame.assertRunning?.();
  } else {
    assertAuthorizationSignalRunning(frame.controller.signal);
    if (frame.signal) assertAuthorizationSignalRunning(frame.signal);
  }
}
/** Trusted nested entry points explicitly pass this token to the coordinator. */
export function currentClinicalOperation(db: DatabaseSync): ClinicalOperation | undefined {
  const frame = context.getStore();
  if (!frame) return undefined;
  check(frame);
  if (frame.db !== db) throw Error('Nested clinical operations require the same database');
  return frame.token;
}
export function assertClinicalOperation(db: DatabaseSync, operation?: ClinicalOperation): void {
  const frame = context.getStore();
  const selected = operation ?? frame?.token;
  const owner = selected && frames.get(selected);
  let current = frame;
  while (current && current !== owner) current = current.parent;
  if (!frame || !owner || !current || frame.db !== db || owner.db !== db) throw unavailable();
  // Caller assertions may themselves assert ownership. Liveness checks here
  // must not recursively invoke those caller callbacks.
  for (let value: Frame | undefined = frame; value; value = value.parent) check(value, false);
}
function pump(lane: Lane) {
  if (lane.active || lane.closed) return;
  const pending = lane.pending.shift();
  if (!pending) return;
  pending.dispose();
  lane.active = true;
  pending.start();
}
async function runFrame<T>(
  frame: Frame,
  work: (operation: ClinicalOperation) => Promise<T>,
  onDiscardResult?: (value: T) => void,
) {
  frames.set(frame.token, frame);
  try {
    return await context.run(frame, async () => {
      check(frame);
      if (frame.db.isTransaction)
        throw Error('Clinical operation cannot enter inside a transaction');
      const value = await work(frame.token);
      try {
        if (frame.child) throw Error('A nested clinical operation was not awaited');
        check(frame);
        return value;
      } catch (error) {
        onDiscardResult?.(value);
        throw error;
      }
    });
  } finally {
    // A detached child must stop and finish cleanup before the next owner enters.
    if (frame.child) {
      frame.controller.abort(unavailable());
      await frame.child.catch(() => undefined);
    }
    frame.active = false;
    frames.delete(frame.token);
  }
}

/** Admission only: existing source, SQL, physical and approval proofs still apply. */
export async function runExclusiveClinicalOperation<T>(
  db: DatabaseSync,
  work: (operation: ClinicalOperation) => Promise<T>,
  options: {
    operation?: ClinicalOperation;
    signal?: AbortSignal;
    assertRunning?: () => void;
    onDiscardResult?: (value: T) => void;
  } = {},
): Promise<T> {
  if (!db.isOpen) throw unavailable();
  if (db.isTransaction) throw Error('Clinical operation cannot wait inside a transaction');
  options.signal?.throwIfAborted();
  options.assertRunning?.();
  const parent = context.getStore();
  if (options.operation) {
    assertClinicalOperation(db, options.operation);
    if (parent?.token !== options.operation)
      throw Error('Nested clinical operation requires its immediate owner');
    if (parent!.child) throw Error('Parallel nested clinical operations are not supported');
    const child: Frame = {
      db,
      token: {} as ClinicalOperation,
      controller: parent!.controller,
      active: true,
      parent,
      signal: options.signal,
      assertRunning: () => {
        check(parent!);
        options.assertRunning?.();
      },
    };
    const result = runFrame(child, work, options.onDiscardResult);
    parent!.child = result;
    try {
      return await result;
    } finally {
      if (parent!.child === result) parent!.child = undefined;
    }
  }
  if (parent) throw Error('Nested clinical operation requires its current owner');
  let lane = lanes.get(db);
  if (!lane) {
    lane = { active: false, closed: false, pending: [] };
    lanes.set(db, lane);
    const owned = lane;
    observeDatabaseClose(db, () => {
      owned.closed = true;
      owned.controller?.abort(unavailable());
      for (const pending of owned.pending.splice(0)) {
        pending.dispose();
        pending.reject(unavailable());
      }
      lanes.delete(db);
    });
  }
  const selected = lane;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      const index = selected.pending.indexOf(pending);
      if (index < 0) return;
      selected.pending.splice(index, 1);
      pending.dispose();
      reject(options.signal!.reason);
      pump(selected);
    };
    const pending: Pending = {
      reject,
      dispose: () => options.signal?.removeEventListener('abort', abort),
      start: () => {
        const controller = new AbortController();
        selected.controller = controller;
        const frame: Frame = {
          db,
          token: {} as ClinicalOperation,
          controller,
          active: true,
          signal: options.signal,
          assertRunning: options.assertRunning,
        };
        void runFrame(frame, work, options.onDiscardResult)
          .then(resolve, reject)
          .finally(() => {
            selected.controller = undefined;
            selected.active = false;
            pump(selected);
          });
      },
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    selected.pending.push(pending);
    if (options.signal?.aborted) abort();
    else pump(selected);
  });
}
