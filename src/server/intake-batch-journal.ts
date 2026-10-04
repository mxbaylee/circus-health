import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './database.ts';
import {
  clearJournalActivityIndex,
  forgetJournalActivityScope,
  publishedJournalActivity,
} from './journal-activity-index.ts';
import { profilePaths } from './profile-storage.ts';
import { portableWork } from './portable-work.ts';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import type { ChatChange } from './chat-journal-codec.ts';
import { flockExclusiveNonblocking, flockUnlock } from '../shared/flock.ts';
import { countIntakeBatchWork as count } from './intake-batch-work.ts';
import {
  batchMutations,
  cloneBatchJson,
  reconcileBatchMutations,
  trackIntakeBatch,
} from './intake-batch-mutations.ts';
export {
  createIntakeBatchJournalWorkCounters,
  withIntakeBatchJournalWork,
} from './intake-batch-work.ts';
export {
  trackIntakeBatch,
  cloneIntakeBatch,
  pendingIntakeBatchChanges,
} from './intake-batch-mutations.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// UUID names deliberately remain discoverable by older readers, which refuse v3.
const EVENT = /^(\d{12})-([0-9a-f-]{36})\.json$/;
const FORMAT = 'health-intake-batch-delta-v3';
const HEAD = 'health-intake-batch-head-v3';
const BAD = new Set(['__proto__', 'constructor', 'prototype']);
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
interface Reference {
  name: string;
  digest: string;
}
interface Head {
  format: typeof HEAD;
  profileId: string;
  batchId: string;
  tail: Reference | null;
  usage: { eventBytes: number };
  legacy: { count: number; digest: string } | null;
}
interface Basis {
  directory: string;
  scope: string;
  head: Head;
  state: IntakeBatch;
  tailStat: string | null;
  directoryStat: string;
  orphans: string[];
}
const bases = new WeakMap<object, Basis>();
const scopes = new Map<string, Set<WeakRef<object>>>();
// Listeners hold no batch state. An open encrypted vault owns its dirty-path set.
const publications = new Map<string, Set<(names: string[]) => void>>();
export function registerIntakeBatchPublication(
  root: string,
  profileId: string,
  listener: (names: string[]) => void,
): () => void {
  const scope = resolve(profilePaths(root, profileId).root);
  const listeners = publications.get(scope) ?? new Set();
  listeners.add(listener);
  publications.set(scope, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) publications.delete(scope);
  };
}
function notifyPublication(scope: string, id: string, names: string[]): void {
  const relative = names.map((name) => `intake-batches/${id}/events/${name}`);
  for (const listener of publications.get(scope) ?? []) listener(relative);
}

function invalid(): never {
  throw Error('Invalid or unsupported reading batch journal');
}
function conflict(): never {
  throw new HttpError(409, 'INTAKE_BATCH_STALE', 'Reading batch changed; reopen it before saving');
}
function missing(): never {
  throw new HttpError(404, 'INTAKE_BATCH_NOT_FOUND', 'Reading batch not found');
}
function hash(bytes: Uint8Array | string): string {
  count('hashCalls');
  count('hashedBytes', typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength);
  return createHash('sha256').update(bytes).digest('hex');
}
function sequence(name: string): number {
  return Number(name.slice(0, 12));
}
function reference(value: unknown): value is Reference {
  return (
    object(value) &&
    Object.keys(value).length === 2 &&
    typeof value.name === 'string' &&
    EVENT.test(value.name) &&
    UUID.test(value.name.slice(13, -5)) &&
    typeof value.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.digest)
  );
}
function sameReference(a: Reference | null, b: Reference | null): boolean {
  count('headComparisonFields', 3);
  return a === null || b === null ? a === b : a.name === b.name && a.digest === b.digest;
}
function sameHead(a: Head | null, b: Head): boolean {
  count('headComparisonFields', 8);
  return (
    a !== null &&
    a.format === b.format &&
    a.profileId === b.profileId &&
    a.batchId === b.batchId &&
    sameReference(a.tail, b.tail) &&
    a.usage.eventBytes === b.usage.eventBytes &&
    (a.legacy === null || b.legacy === null
      ? a.legacy === b.legacy
      : a.legacy.count === b.legacy.count && a.legacy.digest === b.legacy.digest)
  );
}
function fingerprint(file: string): string {
  count('authorityStats');
  if (realpathSync(file) !== file) invalid();
  const stat = statSync(file, { bigint: true });
  if ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1n)) invalid();
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
}
function directory(root: string, profileId: string, id: string, create = false): string {
  if (!UUID.test(id)) missing();
  const base = realpathSync(profilePaths(root, profileId).root);
  if (base !== join(realpathSync(root), 'data', 'profiles', profileId)) invalid();
  let path = base;
  for (const segment of ['intake-batches', id, 'events']) {
    path = join(path, segment);
    if (!existsSync(path)) {
      if (!create) missing();
      mkdirSync(path, { mode: 0o700 });
      sync(dirname(path));
    }
    if (realpathSync(path) !== path) invalid();
  }
  return path;
}
function pending(directory: string): string {
  const path = join(dirname(directory), 'unpublished');
  const created = !existsSync(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (created) sync(dirname(path));
  if (realpathSync(path) !== path) invalid();
  return path;
}
function sync(directory: string): void {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
    count('directorySyncCalls');
  } finally {
    closeSync(fd);
  }
}
function quarantine(path: string, name: string): void {
  const target = pending(path);
  renameSync(join(path, name), join(target, name + '.' + randomUUID() + '.pending'));
  sync(target);
  sync(path);
}
function readBytes(file: string, head = false, stagedTwin?: string): Buffer {
  if (realpathSync(file) !== file) invalid();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    count('authorityStats');
    if (!info.isFile() || (head && info.size > 4096)) invalid();
    if (info.nlink !== 1) {
      // Only an unselected candidate may retain the exact staging link across a crash.
      if (info.nlink !== 2 || !stagedTwin || realpathSync(stagedTwin) !== stagedTwin) invalid();
      const twin = openSync(stagedTwin, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const other = fstatSync(twin);
        count('authorityStats');
        if (
          !other.isFile() ||
          other.nlink !== 2 ||
          other.dev !== info.dev ||
          other.ino !== info.ino
        )
          invalid();
      } finally {
        closeSync(twin);
      }
    }
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const size = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!size) invalid();
      count(head ? 'headReadBytes' : 'eventReadBytes', size);
      portableWork('journalReadBytes', size);
      offset += size;
    }
    const extra = readSync(fd, Buffer.alloc(1), 0, 1, null);
    if (extra) {
      count(head ? 'headReadBytes' : 'eventReadBytes', extra);
      portableWork('journalReadBytes', extra);
      invalid();
    }
    count(head ? 'headReads' : 'eventReads');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function readHead(path: string, profileId: string, id: string): Head | null {
  const file = join(path, 'current');
  if (!existsSync(file)) return null;
  const value = JSON.parse(readBytes(file, true).toString());
  if (
    !object(value) ||
    value.format !== HEAD ||
    value.profileId !== profileId ||
    value.batchId !== id ||
    Object.keys(value).length !== 6 ||
    (value.tail !== null && !reference(value.tail)) ||
    !object(value.usage) ||
    Object.keys(value.usage).length !== 1 ||
    !Number.isSafeInteger(value.usage.eventBytes) ||
    value.usage.eventBytes < 0
  )
    invalid();
  if (
    value.legacy !== null &&
    (!object(value.legacy) ||
      Object.keys(value.legacy).length !== 2 ||
      !Number.isSafeInteger(value.legacy.count) ||
      value.legacy.count < 1 ||
      typeof value.legacy.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.legacy.digest))
  )
    invalid();
  if (value.tail === null && (value.usage.eventBytes !== 0 || value.legacy !== null)) invalid();
  if (value.legacy && value.tail && value.legacy.count > sequence(value.tail.name)) invalid();
  return value as Head;
}
function names(path: string): string[] {
  const result: string[] = [],
    iterator = opendirSync(path);
  try {
    for (let entry = iterator.readSync(); entry; entry = iterator.readSync()) {
      count('directoryEntries');
      if (EVENT.test(entry.name) && UUID.test(entry.name.slice(13, -5))) result.push(entry.name);
      else if (entry.name !== 'current' && !entry.name.endsWith('.pending')) invalid();
    }
  } finally {
    iterator.closeSync();
  }
  return result.sort();
}
function pathKeys(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((name) => typeof name !== 'string' || name.length > 1000 || BAD.has(name))
  )
    invalid();
}
function getParent(state: any, path: string[]): any {
  let target = state;
  for (const name of path) {
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, name)) invalid();
    if (Array.isArray(target) && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= target.length))
      invalid();
    target = target[name];
  }
  return target;
}
function apply(state: IntakeBatch | undefined, changes: unknown, replay = true): IntakeBatch {
  if (!Array.isArray(changes)) invalid();
  let current: any = state;
  for (const change of changes) {
    if (!object(change)) invalid();
    pathKeys(change.path);
    const path: string[] = change.path;
    if (replay) {
      count('replayedChanges');
      count('replayPathVisits', path.length);
    }
    const fields =
      change.op === 'set'
        ? ['op', 'path', 'value']
        : change.op === 'remove'
          ? ['op', 'path']
          : change.op === 'truncate'
            ? ['length', 'op', 'path']
            : null;
    if (!fields || Object.keys(change).sort().join() !== fields.join()) invalid();
    if (!path.length && change.op === 'set') {
      if (current !== undefined) invalid();
      current = cloneBatchJson(change.value, replay ? 'replay' : 'change');
      continue;
    }
    if (!current) invalid();
    if (change.op === 'truncate') {
      const array = getParent(current, path);
      if (
        !Array.isArray(array) ||
        !Number.isSafeInteger(change.length) ||
        change.length < 0 ||
        change.length >= array.length
      )
        invalid();
      array.length = change.length;
      continue;
    }
    if (!path.length) invalid();
    const target = getParent(current, path.slice(0, -1)),
      name = path.at(-1)!;
    if (!target || typeof target !== 'object') invalid();
    if (Array.isArray(target) && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) > target.length))
      invalid();
    if (change.op === 'set')
      target[name] = cloneBatchJson(change.value, replay ? 'replay' : 'change', path.length);
    else {
      if (Array.isArray(target) || !Object.hasOwn(target, name)) invalid();
      delete target[name];
    }
  }
  if (!object(current)) invalid();
  return current as IntakeBatch;
}
function identity(batch: IntakeBatch, profileId: string, id: string): void {
  if (
    !object(batch) ||
    batch.id !== id ||
    batch.profileId !== profileId ||
    !Array.isArray(batch.items)
  )
    invalid();
}
function envelope(saved: any, name: string, profileId: string, id: string): void {
  if (
    !object(saved) ||
    saved.profileId !== profileId ||
    saved.sequence !== sequence(name) ||
    typeof saved.reason !== 'string' ||
    typeof saved.savedAt !== 'string' ||
    !Number.isFinite(Date.parse(saved.savedAt))
  )
    invalid();
  if (saved.format === FORMAT) {
    if (
      Object.keys(saved).length !== 8 ||
      saved.batchId !== id ||
      (saved.previous !== null && !reference(saved.previous)) ||
      !Array.isArray(saved.changes)
    )
      invalid();
  } else if (saved.format === 'health-intake-batch-v1') {
    if (!object(saved.batch) || saved.batch.id !== id) invalid();
  } else if (saved.format === 'health-intake-batch-delta-v2') {
    if (saved.batchId !== id || !Array.isArray(saved.changes) || !Array.isArray(saved.removed))
      invalid();
  } else invalid();
}
function legacyApply(state: IntakeBatch | undefined, saved: any): IntakeBatch {
  if (saved.format === 'health-intake-batch-v1')
    return cloneBatchJson(saved.batch, 'replay') as unknown as IntakeBatch;
  if (!state) invalid();
  for (const entry of saved.changes) {
    if (!Array.isArray(entry) || entry.length !== 2) invalid();
    const [path, value] = entry;
    pathKeys(path);
    if (!path.length) invalid();
    count('replayedChanges');
    count('replayPathVisits', path.length);
    const target = getParent(state, path.slice(0, -1)),
      name = path.at(-1)!;
    if (!target || typeof target !== 'object') invalid();
    if (Array.isArray(target)) {
      if (name === 'length') {
        if (!Number.isSafeInteger(value) || value < 0 || value > target.length) invalid();
        target.length = value;
        continue;
      }
      if (!/^(0|[1-9]\d*)$/.test(name) || Number(name) > target.length) invalid();
    }
    target[name] = cloneBatchJson(value, 'replay', path.length);
  }
  for (const path of saved.removed) {
    pathKeys(path);
    if (!path.length) invalid();
    count('replayedChanges');
    count('replayPathVisits', path.length);
    const target = getParent(state, path.slice(0, -1)),
      name = path.at(-1)!;
    // Historical v2 writes removals after array truncation; deleted tail slots may already be absent.
    if (
      !target ||
      typeof target !== 'object' ||
      (Array.isArray(target) && !/^(0|[1-9]\d*)$/.test(name))
    )
      invalid();
    delete target[name];
  }
  return state;
}
function cold(
  path: string,
  profileId: string,
  id: string,
  head: Head | null,
  capture?: (name: string, bytes: Buffer) => void,
): Basis | null {
  const inventory = names(path),
    committed: string[] = [],
    orphans: string[] = [];
  for (const name of inventory) {
    if (head && sequence(name) > (head.tail ? sequence(head.tail.name) : 0)) orphans.push(name);
    else committed.push(name);
  }
  let state: IntakeBatch | undefined,
    previous: Reference | null = null,
    eventBytes = 0,
    legacyCount = 0;
  const legacyHash = createHash('sha256');
  for (let index = 0; index < committed.length; index++) {
    const name = committed[index]!;
    if (sequence(name) !== index + 1) invalid();
    const bytes = readBytes(join(path, name));
    const digest = hash(bytes),
      saved = JSON.parse(bytes.toString());
    envelope(saved, name, profileId, id);
    if (saved.format === FORMAT) {
      if (!head || !sameReference(saved.previous, previous)) invalid();
      state = apply(state, saved.changes);
    } else {
      if (index !== legacyCount) invalid();
      legacyCount++;
      // Fixed-width names and digests bind each original file, including its boundary.
      legacyHash.update(name).update(digest);
      count('hashedBytes', Buffer.byteLength(name) + digest.length);
      state = legacyApply(state, saved);
    }
    identity(state, profileId, id);
    previous = { name, digest };
    eventBytes += bytes.length;
    if (!Number.isSafeInteger(eventBytes)) invalid();
    count('replayedEvents');
    capture?.(name, bytes);
  }
  const legacy = legacyCount ? { count: legacyCount, digest: legacyHash.digest('hex') } : null;
  if (legacyCount) count('hashCalls');
  const reconstructed: Head = {
    format: HEAD,
    profileId,
    batchId: id,
    tail: previous,
    usage: { eventBytes },
    legacy,
  };
  if (head && !sameHead(head, reconstructed)) invalid();
  for (const name of orphans) {
    if (sequence(name) !== committed.length + 1) invalid();
    const saved = JSON.parse(
      readBytes(
        join(path, name),
        false,
        join(dirname(path), 'unpublished', name + '.pending'),
      ).toString(),
    );
    envelope(saved, name, profileId, id);
    if (saved.format !== FORMAT || !sameReference(saved.previous, previous)) invalid();
    const candidate = apply(
      state ? (cloneBatchJson(state, 'replay') as unknown as IntakeBatch) : undefined,
      saved.changes,
    );
    identity(candidate, profileId, id);
  }
  if (!state) return null;
  return {
    directory: path,
    scope: dirname(dirname(dirname(path))),
    head: reconstructed,
    state,
    tailStat: previous ? fingerprint(join(path, previous.name)) : null,
    directoryStat: fingerprint(path),
    orphans,
  };
}
function remember(batch: IntakeBatch, basis: Basis): void {
  const prior = bases.get(batch);
  bases.set(batch, basis);
  if (prior?.scope === basis.scope) return;
  const references = scopes.get(basis.scope) ?? new Set<WeakRef<object>>();
  references.add(new WeakRef(batch));
  scopes.set(basis.scope, references);
}
export function forgetIntakeBatchJournal(batch: object): void {
  const prior = bases.get(batch);
  if (prior) forgetJournalActivityScope(prior.scope);
  bases.delete(batch);
  const tracker = batchMutations(batch);
  if (tracker) tracker.valid = false;
}
export function clearIntakeBatchJournalCache(root: string, profileId?: string): void {
  clearJournalActivityIndex(root, profileId);
  const selected = profileId ? resolve(profilePaths(root, profileId).root) : null;
  for (const [scope, references] of scopes) {
    if (selected ? scope !== selected : !scope.startsWith(resolve(root) + '/')) continue;
    for (const reference of references) {
      const batch = reference.deref();
      if (batch) forgetIntakeBatchJournal(batch);
    }
    scopes.delete(scope);
  }
}
export function readIntakeBatch(root: string, profileId: string, id: string): IntakeBatch {
  count('readCalls');
  const path = directory(root, profileId, id),
    basis = cold(path, profileId, id, readHead(path, profileId, id));
  if (!basis) missing();
  const batch = trackIntakeBatch(basis.state);
  remember(batch, basis);
  return batch;
}
export function refreshIntakeBatch(
  root: string,
  profileId: string,
  batch: IntakeBatch,
): IntakeBatch {
  const tracker = batchMutations(batch);
  if (!tracker) invalid();
  forgetIntakeBatchJournal(batch);
  const fresh = readIntakeBatch(root, profileId, batch.id),
    basis = bases.get(fresh)!;
  reconcileBatchMutations(tracker, fresh);
  remember(batch, basis);
  forgetIntakeBatchJournal(fresh);
  return batch;
}
export function listIntakeBatches(root: string, profileId: string): IntakeBatch[] {
  const base = join(profilePaths(root, profileId).root, 'intake-batches');
  if (!existsSync(base)) return [];
  if (realpathSync(base) !== base) invalid();
  const list: IntakeBatch[] = [],
    iterator = opendirSync(base);
  try {
    for (let entry = iterator.readSync(); entry; entry = iterator.readSync()) {
      count('directoryEntries');
      if (!UUID.test(entry.name)) continue;
      try {
        list.push(readIntakeBatch(root, profileId, entry.name));
      } catch (error) {
        if (!(error instanceof HttpError && error.code === 'INTAKE_BATCH_NOT_FOUND')) throw error;
      }
    }
  } finally {
    iterator.closeSync();
  }
  return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function publishHead(path: string, head: Head): void {
  const serialized = JSON.stringify(head);
  count('headSerializationCalls');
  count('headSerializedBytes', Buffer.byteLength(serialized));
  const temporary = join(pending(path), 'current.' + randomUUID() + '.pending');
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, serialized);
    count('headWrites');
    count('headWriteBytes', Buffer.byteLength(serialized));
    fsyncSync(fd);
    count('fileSyncCalls');
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, join(path, 'current'));
  notifyPublication(dirname(dirname(dirname(path))), head.batchId, [
    ...(head.tail ? [head.tail.name] : []),
    'current',
  ]);
  sync(dirname(temporary));
  sync(path);
}
function lease(path: string): number {
  const file = join(dirname(path), 'writer.lock');
  if (existsSync(file) && realpathSync(file) !== file) invalid();
  const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    count('authorityStats');
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 0) invalid();
    if (!flockExclusiveNonblocking(fd)) conflict();
    count('lockAcquisitions');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function validateBasis(path: string, head: Head | null, basis: Basis): void {
  if (basis.directory !== path || !sameHead(head, basis.head)) {
    // A supported legacy basis has not selected its first v3 marker yet.
    if (!(
      head === null &&
      basis.head.legacy &&
      basis.head.legacy.count === sequence(basis.head.tail!.name)
    ))
      conflict();
  }
  if (
    fingerprint(path) !== basis.directoryStat ||
    (basis.head.tail && fingerprint(join(path, basis.head.tail.name)) !== basis.tailStat)
  )
    invalid();
}
/** Bounded freshness check before a manager returns an idempotent cached result. */
export function assertCurrentIntakeBatch(
  root: string,
  profileId: string,
  batch: IntakeBatch,
): void {
  count('currentAssertions');
  identity(batch, profileId, batch.id);
  const basis = bases.get(batch),
    tracker = batchMutations(batch);
  if (!basis || !tracker?.valid) conflict();
  const path = directory(root, profileId, batch.id);
  validateBasis(path, readHead(path, profileId, batch.id), basis);
}
export function writeIntakeBatch(
  root: string,
  profileId: string,
  batch: IntakeBatch,
  reason: string,
): void {
  count('writeCalls');
  identity(batch, profileId, batch.id);
  if (typeof reason !== 'string') invalid();
  const path = directory(root, profileId, batch.id, true),
    lock = lease(path);
  let event: string | undefined, next: Reference | undefined;
  try {
    let head = readHead(path, profileId, batch.id),
      basis = bases.get(batch),
      tracker = batchMutations(batch);
    if (tracker && !tracker.valid) conflict();
    if (basis) {
      validateBasis(path, head, basis);
    } else {
      const existing = cold(path, profileId, batch.id, head);
      if (existing) conflict();
      // An empty selected head may retain an uncommitted first event after a crash.
      for (const orphan of names(path)) quarantine(path, orphan);
      if (!tracker) {
        batch = trackIntakeBatch(batch);
        tracker = batchMutations(batch)!;
      }
    }
    const changes: ChatChange[] = basis
      ? tracker!.changes
      : [{ op: 'set', path: [], value: cloneBatchJson(tracker!.raw, 'mutation') }];
    if (basis && !changes.length) return;
    // Validation and application touch only the newly recorded operations.
    const state = apply(basis?.state, changes, false);
    identity(state, profileId, batch.id);
    if (!head) {
      head = basis?.head ?? {
        format: HEAD,
        profileId,
        batchId: batch.id,
        tail: null,
        usage: { eventBytes: 0 },
        legacy: null,
      };
      publishHead(path, head);
    }
    for (const orphan of basis?.orphans ?? []) quarantine(path, orphan);
    const nextSequence = (head.tail ? sequence(head.tail.name) : 0) + 1;
    if (nextSequence > 999_999_999_999) invalid();
    const serialized = JSON.stringify({
      format: FORMAT,
      profileId,
      batchId: batch.id,
      sequence: nextSequence,
      previous: head.tail,
      reason,
      savedAt: new Date().toISOString(),
      changes,
    });
    count('eventSerializationCalls');
    count('eventSerializedBytes', Buffer.byteLength(serialized));
    count('emittedChanges', changes.filter((change) => change.op !== 'remove').length);
    count('emittedRemovals', changes.filter((change) => change.op === 'remove').length);
    next = {
      name: String(nextSequence).padStart(12, '0') + '-' + randomUUID() + '.json',
      digest: hash(serialized),
    };
    const temporary = join(pending(path), next.name + '.pending');
    event = join(path, next.name);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, serialized);
      count('eventWrites');
      count('eventWriteBytes', Buffer.byteLength(serialized));
      fsyncSync(fd);
      count('fileSyncCalls');
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, event);
    unlinkSync(temporary);
    // Persist removal of the staging link before selecting single-link authority.
    sync(dirname(temporary));
    sync(path);
    const nextHead: Head = {
      ...head,
      tail: next,
      usage: { eventBytes: head.usage.eventBytes + Buffer.byteLength(serialized) },
    };
    if (!Number.isSafeInteger(nextHead.usage.eventBytes)) invalid();
    publishHead(path, nextHead);
    count('publishedEvents');
    tracker!.changes.length = 0;
    remember(batch, {
      directory: path,
      scope: resolve(profilePaths(root, profileId).root),
      head: nextHead,
      state,
      tailStat: fingerprint(event),
      directoryStat: fingerprint(path),
      orphans: [],
    });
    publishedJournalActivity(root, profileId, 'batch', batch.id);
  } catch (error) {
    clearJournalActivityIndex(root, profileId);
    forgetIntakeBatchJournal(batch);
    if (event && existsSync(event)) {
      try {
        const selected = readHead(path, profileId, batch.id)?.tail;
        if (selected?.name === next?.name && selected?.digest === next?.digest) {
          // rename can succeed before its caller receives an acknowledgement.
          notifyPublication(resolve(profilePaths(root, profileId).root), batch.id, [
            next!.name,
            'current',
          ]);
        } else {
          quarantine(path, next!.name);
        }
      } catch {}
    }
    throw error;
  } finally {
    try {
      flockUnlock(lock);
    } finally {
      closeSync(lock);
    }
  }
}
export function copyIntakeBatchJournals(
  root: string,
  profileId: string,
  targetRoot: string,
  { onFile }: { onFile?: (path: string) => void } = {},
): string[] {
  const copied: string[] = [],
    base = join(profilePaths(root, profileId).root, 'intake-batches');
  if (!existsSync(base)) return copied;
  if (realpathSync(base) !== base) invalid();
  const iterator = opendirSync(base);
  try {
    for (let entry = iterator.readSync(); entry; entry = iterator.readSync()) {
      count('directoryEntries');
      if (!UUID.test(entry.name)) continue;
      const id = entry.name;
      let path: string;
      try {
        path = directory(root, profileId, id);
      } catch (error) {
        if (error instanceof HttpError && error.code === 'INTAKE_BATCH_NOT_FOUND') continue;
        throw error;
      }
      const head = readHead(path, profileId, id),
        names: string[] = [];
      const save = (name: string, bytes: Buffer) => {
        const relative = `${profilePaths(root, profileId).relativeRoot}/intake-batches/${id}/events/${name}`;
        const target = resolve(targetRoot, relative);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        if (realpathSync(dirname(target)) !== dirname(target)) invalid();
        portableWork('outputBytes', bytes.length);
        portableWork('maxOutputChunkBytes', bytes.length, true);
        writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
        if (onFile) onFile(relative);
        else copied.push(relative);
        names.push(name);
        if (name !== 'current') {
          count('copiedEvents');
          count('copiedEventBytes', bytes.length);
          count('copyValidationReads');
          count('copyValidationReadBytes', bytes.length);
        }
      };
      // Cold validation reconstructs only this journal and keeps its existing
      // per-journal budget. Never register every batch in the warm cache.
      if (!cold(path, profileId, id, head, save)) continue;
      if (head) save('current', Buffer.from(JSON.stringify(head)));
      notifyPublication(resolve(profilePaths(targetRoot, profileId).root), id, names);
    }
    return copied;
  } finally {
    iterator.closeSync();
  }
}
