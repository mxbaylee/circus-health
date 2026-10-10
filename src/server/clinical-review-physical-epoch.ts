import { realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';

let epoch: object = {};
let activeWriters = 0;
let mutationSequence = 0n;
const scopedWitnesses = new WeakMap<object, { root: string; sequence: bigint }>();
const MAX_SCOPED_EVENTS = 2048;
const MAX_MUTATION_PATHS = 4;
const MAX_MUTATION_PATH_LENGTH = 4096;
const scopedEvents: ({ sequence: bigint; paths?: readonly string[] } | undefined)[] = new Array(
  MAX_SCOPED_EVENTS,
);
let eventCount = 0;
let nextEvent = 0;
let discardedThrough = 0n;

function physicalMutationPath(path: string): string | undefined {
  if (Buffer.byteLength(path) > MAX_MUTATION_PATH_LENGTH) return undefined;
  let current = resolve(path);
  const remaining: string[] = [];
  for (;;) {
    try {
      const physical = resolve(realpathSync.native(current), ...remaining.reverse());
      return Buffer.byteLength(physical) <= MAX_MUTATION_PATH_LENGTH ? physical : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      remaining.push(basename(current));
      current = parent;
    }
  }
}

function recordMutation(paths?: readonly string[]): void {
  mutationSequence++;
  epoch = {};
  const physical =
    paths?.length && paths.length <= MAX_MUTATION_PATHS
      ? paths.map(physicalMutationPath)
      : undefined;
  if (eventCount === MAX_SCOPED_EVENTS) discardedThrough = scopedEvents[nextEvent]!.sequence;
  else eventCount++;
  scopedEvents[nextEvent] = {
    sequence: mutationSequence,
    paths: physical?.every((path): path is string => path !== undefined) ? physical : undefined,
  };
  nextEvent = (nextEvent + 1) % MAX_SCOPED_EVENTS;
}

function intersects(root: string, path: string): boolean {
  if (root === path) return true;
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  const pathPrefix = path.endsWith(sep) ? path : path + sep;
  return root.startsWith(pathPrefix) || path.startsWith(rootPrefix);
}

/** Rotates before and after a managed filesystem mutation, including failures. */
export function beginManagedPhysicalMutation(paths?: readonly string[]): () => void {
  recordMutation(paths);
  activeWriters++;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeWriters--;
    recordMutation(paths);
  };
}

/** Read-only attempt sequence. It is not permission to renew an authority proof. */
export function managedPhysicalMutationSequence(): bigint {
  return mutationSequence;
}

export function captureManagedPhysicalEpoch(): object | undefined {
  return activeWriters === 0 ? epoch : undefined;
}

export function managedPhysicalEpochCurrent(expected: object): boolean {
  return activeWriters === 0 && epoch === expected;
}

/** A path-scoped witness remains original; missing paths and event overflow fail closed. */
export function captureManagedPhysicalScope(root: string): object | undefined {
  if (activeWriters || Buffer.byteLength(root) > MAX_MUTATION_PATH_LENGTH) return undefined;
  try {
    const physicalRoot = realpathSync.native(root);
    if (Buffer.byteLength(physicalRoot) > MAX_MUTATION_PATH_LENGTH) return undefined;
    const witness = Object.freeze({});
    scopedWitnesses.set(witness, { root: physicalRoot, sequence: mutationSequence });
    return witness;
  } catch {
    return undefined;
  }
}

export function managedPhysicalScopeCurrent(expected: object): boolean {
  const witness = scopedWitnesses.get(expected);
  if (!witness || activeWriters || witness.sequence < discardedThrough) return false;
  try {
    if (realpathSync.native(witness.root) !== witness.root) return false;
  } catch {
    return false;
  }
  for (let offset = 0; offset < eventCount; offset++) {
    const event =
      scopedEvents[(nextEvent - eventCount + offset + MAX_SCOPED_EVENTS) % MAX_SCOPED_EVENTS]!;
    if (event.sequence <= witness.sequence) continue;
    if (!event.paths || event.paths.some((path) => intersects(witness.root, path))) return false;
  }
  return true;
}

export function withManagedPhysicalMutation<T>(work: () => T, paths?: readonly string[]): T {
  const finish = beginManagedPhysicalMutation(paths);
  try {
    return work();
  } finally {
    finish();
  }
}
