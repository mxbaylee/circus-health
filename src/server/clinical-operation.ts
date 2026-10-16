import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { observeDatabaseClose } from './database.ts';
import { assertAuthorizationSignalRunning } from './authorization-signal.ts';
import {
  assertOwnershipReadOwner,
  assertOwnershipReadInterval,
  closeOwnershipReadInterval,
  ownershipReadOwnerOperation,
  ownershipReadIntervalSealed,
  type OwnershipReadOwner,
  type OwnershipReadInterval,
} from './ownership-read-owner.ts';

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
  callerAssertions: boolean;
  callerAssertion?: () => void;
  publicationAssertions?: readonly (() => void)[];
  signal?: AbortSignal;
  child?: Promise<unknown>;
  parent?: Frame;
  readResult?: ReadResult;
  work: (operation: ClinicalOperation) => Promise<unknown>;
};
interface ReadResult {
  readonly owner: OwnershipReadOwner;
  readonly interval: OwnershipReadInterval;
  readonly value: unknown;
  readonly frames: Set<Frame>;
}
type Pending = { start: () => void; reject: (reason: unknown) => void; dispose: () => void };
type Lane = { active: boolean; closed: boolean; pending: Pending[]; controller?: AbortController };
const context = new AsyncLocalStorage<Frame>();
const frames = new WeakMap<ClinicalOperation, Frame>();
const lanes = new WeakMap<DatabaseSync, Lane>();
const unavailable = () => new Error('Clinical operation is no longer active');

function check(frame: Frame, assertions = true) {
  if (!frame.active || !frame.db.isOpen) throw unavailable();
  assertAuthorizationSignalRunning(frame.controller.signal);
  if (frame.signal) assertAuthorizationSignalRunning(frame.signal);
  if (assertions) {
    frame.assertRunning?.();
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
/** Current frame provenance only. Callers still need genuine readonly issuers
 * for every assertion before narrowing to callback-free publication. */
export function currentClinicalOperationReadonly(db: DatabaseSync): ClinicalOperation | undefined {
  const frame = context.getStore();
  if (!frame) return undefined;
  if (frame.db !== db) throw Error('Nested clinical operations require the same database');
  for (let value: Frame | undefined = frame; value; value = value.parent) check(value, false);
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
/** Read-only provenance, not authorization. Derived parent checks are not
 * caller assertions; every original caller assertion remains visible. */
export function clinicalOperationHasCallerAssertions(
  db: DatabaseSync,
  operation: ClinicalOperation,
): boolean {
  assertClinicalOperation(db, operation);
  const owner = frames.get(operation)!;
  for (let value: Frame | undefined = owner; value; value = value.parent)
    if (value.callerAssertions) return true;
  return false;
}
/** Exact original assertions only. This exposes provenance, never approval. */
export function clinicalOperationCallerAssertions(
  db: DatabaseSync,
  operation: ClinicalOperation,
): readonly (() => void)[] {
  assertClinicalOperation(db, operation);
  const assertions: Array<() => void> = [];
  for (let value: Frame | undefined = frames.get(operation); value; value = value.parent) {
    if (value.callerAssertion) assertions.push(value.callerAssertion);
    if (value.publicationAssertions) assertions.push(...value.publicationAssertions);
  }
  return Object.freeze(assertions);
}
/** Exact work identity for private, source-owned read continuations. */
export function clinicalOperationReadContinuations(db: DatabaseSync, operation: ClinicalOperation) {
  assertClinicalOperation(db, operation);
  const work: Frame['work'][] = [];
  for (let frame: Frame | undefined = frames.get(operation); frame; frame = frame.parent)
    work.push(frame.work);
  return Object.freeze(work);
}
/** Frame provenance only: a temporary child adds no conditions that would be
 * lost when later preparation resumes under its still-active parent. */
export function clinicalOperationImmediateUnassertedContinuation(
  db: DatabaseSync,
  parent: ClinicalOperation,
  child: ClinicalOperation,
): boolean {
  const frame = context.getStore(),
    original = frames.get(parent);
  if (
    !frame ||
    !original ||
    frame.token !== child ||
    frame.parent !== original ||
    frame.controller !== original.controller ||
    frame.signal ||
    frame.callerAssertions ||
    frame.callerAssertion ||
    frame.publicationAssertions?.length
  )
    return false;
  try {
    assertClinicalOperation(db, parent);
    return true;
  } catch {
    return false;
  }
}
/** Exact genuine read-owner handoff, not a caller-selected assertion override. */
export function sealClinicalReadResult<T>(
  db: DatabaseSync,
  operation: ClinicalOperation,
  owner: OwnershipReadOwner,
  interval: OwnershipReadInterval,
  value: T,
): T {
  assertClinicalOperation(db, operation);
  if (
    context.getStore()?.token !== operation ||
    ownershipReadOwnerOperation(owner) !== operation ||
    !ownershipReadIntervalSealed(interval)
  )
    throw unavailable();
  assertOwnershipReadOwner(db, owner);
  assertOwnershipReadInterval(db, interval);
  const receipt: ReadResult = { owner, interval, value, frames: new Set() };
  for (let frame: Frame | undefined = context.getStore(); frame; frame = frame.parent) {
    if (frame.readResult) throw Error('Clinical read result already awaits its owner handoff');
    receipt.frames.add(frame);
  }
  for (const frame of receipt.frames) frame.readResult = receipt;
  return value;
}
function releaseReadResult(frame: Frame): void {
  const receipt = frame.readResult;
  frame.readResult = undefined;
  if (!receipt) return;
  receipt.frames.delete(frame);
  if (!receipt.frames.size) closeOwnershipReadInterval(receipt.interval);
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
        const receipt = frame.readResult;
        if (receipt && Object.is(receipt.value, value)) {
          check(frame, false);
          assertOwnershipReadOwner(frame.db, receipt.owner);
          assertOwnershipReadInterval(frame.db, receipt.interval);
        } else check(frame);
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
    releaseReadResult(frame);
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
    publicationAssertions?: readonly (() => void)[];
    onDiscardResult?: (value: T) => void;
  } = {},
): Promise<T> {
  if (!db.isOpen) throw unavailable();
  if (db.isTransaction) throw Error('Clinical operation cannot wait inside a transaction');
  if (options.signal) assertAuthorizationSignalRunning(options.signal);
  options.assertRunning?.();
  const parent = context.getStore();
  if (options.operation) {
    assertClinicalOperation(db, options.operation);
    if (parent?.token !== options.operation)
      throw Error('Nested clinical operation requires its immediate owner');
    if (parent!.child) throw Error('Parallel nested clinical operations are not supported');
    // A subsequent operation performs normal admission again; an earlier read
    // receipt cannot exempt later work or a different result from caller checks.
    for (let frame: Frame | undefined = parent; frame; frame = frame.parent)
      releaseReadResult(frame);
    const child: Frame = {
      db,
      work,
      token: {} as ClinicalOperation,
      controller: parent!.controller,
      active: true,
      parent,
      signal: options.signal,
      callerAssertions:
        options.assertRunning !== undefined || !!options.publicationAssertions?.length,
      callerAssertion: options.assertRunning,
      publicationAssertions: Object.freeze([...(options.publicationAssertions ?? [])]),
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
      // Queue completion runs in the previous request's async context. Retain
      // this caller's session authorization and other request-local owners.
      start: AsyncLocalStorage.bind(() => {
        const controller = new AbortController();
        selected.controller = controller;
        const frame: Frame = {
          db,
          work,
          token: {} as ClinicalOperation,
          controller,
          active: true,
          signal: options.signal,
          assertRunning: options.assertRunning,
          callerAssertions:
            options.assertRunning !== undefined || !!options.publicationAssertions?.length,
          callerAssertion: options.assertRunning,
          publicationAssertions: Object.freeze([...(options.publicationAssertions ?? [])]),
        };
        void runFrame(frame, work, options.onDiscardResult)
          .then(resolve, reject)
          .finally(() => {
            selected.controller = undefined;
            selected.active = false;
            pump(selected);
          });
      }),
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    selected.pending.push(pending);
    if (options.signal?.aborted) abort();
    else pump(selected);
  });
}
