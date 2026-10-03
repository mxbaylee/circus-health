import type { IntakeBatch } from '../shared/intake-batch.ts';
import { type ChatChange, type ChatJson } from './chat-journal-codec.ts';
import { countIntakeBatchWork as count } from './intake-batch-work.ts';

const BAD = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_ITEMS = Number.MAX_SAFE_INTEGER;
const handles = new WeakMap<object, BatchMutations>();
const targets = new WeakMap<object, object>();
export interface BatchMutations {
  value: IntakeBatch;
  raw: Record<string, ChatJson>;
  changes: ChatChange[];
  valid: boolean;
}
function invalid(): never {
  throw Error('Invalid tracked intake batch mutation');
}
function key(name: PropertyKey): asserts name is string {
  if (typeof name !== 'string' || BAD.has(name) || name.length > 1000) invalid();
}
/** Copies only supplied evidence; complete DTO copies have separate accounting. */
export function cloneBatchJson(
  value: unknown,
  kind: 'mutation' | 'dto' | 'replay' | 'change',
  depth = 0,
): ChatJson {
  let nodes = MAX_ITEMS;
  const ancestors = new Set<object>();
  function visit(input: unknown, level: number): ChatJson {
    count(
      kind === 'mutation'
        ? 'mutationCloneNodes'
        : kind === 'dto'
          ? 'dtoCloneNodes'
          : kind === 'change'
            ? 'changeCloneNodes'
            : 'replayCloneNodes',
    );
    if (--nodes < 0 || level > 64) invalid();
    if (typeof input === 'string') {
      count(
        kind === 'mutation'
          ? 'mutationStringUnits'
          : kind === 'dto'
            ? 'dtoStringUnits'
            : kind === 'change'
              ? 'changeStringUnits'
              : 'replayStringUnits',
        input.length,
      );
      return input;
    }
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (!input || typeof input !== 'object') invalid();
    input = targets.get(input) ?? input;
    const object = input as object;
    if (ancestors.has(object)) invalid();
    if (!Array.isArray(object) && ![Object.prototype, null].includes(Object.getPrototypeOf(object)))
      invalid();
    ancestors.add(object);
    let output: ChatJson;
    if (Array.isArray(object)) {
      if (object.length > MAX_ITEMS) invalid();
      output = Array.from({ length: object.length }, (_, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, String(i));
        if (descriptor && !Object.hasOwn(descriptor, 'value')) invalid();
        return visit(descriptor?.value ?? null, level + 1);
      });
    } else {
      const names = Object.keys(object);
      if (names.length > MAX_ITEMS) invalid();
      const result: Record<string, ChatJson> = {};
      for (const name of names) {
        key(name);
        const descriptor = Object.getOwnPropertyDescriptor(object, name)!;
        if (!Object.hasOwn(descriptor, 'value')) invalid();
        if (descriptor.value !== undefined) result[name] = visit(descriptor.value, level + 1);
      }
      output = result;
    }
    ancestors.delete(object);
    return output;
  }
  return visit(value, depth);
}
export function cloneIntakeBatch<T>(value: T, purpose: 'dto' | 'mutation' = 'mutation'): T {
  if (purpose === 'dto') count('dtoCloneCalls');
  return cloneBatchJson(value, purpose) as T;
}
export function batchMutations(value: object): BatchMutations | undefined {
  return handles.get(value);
}
export function trackIntakeBatch<T extends IntakeBatch>(value: T): T {
  if (handles.has(value)) return value;
  const raw = cloneBatchJson(value, 'mutation') as Record<string, ChatJson>;
  const tracker: BatchMutations = { value: undefined!, raw, changes: [], valid: true };
  const proxies = new WeakMap<object, Map<string, object>>();
  function record(change: ChatChange): void {
    count('mutationOperations');
    count('mutationPathVisits', change.path.length);
    if (tracker.changes.length >= MAX_ITEMS) invalid();
    tracker.changes.push(change);
  }
  function wrap(target: Record<string, ChatJson> | ChatJson[], path: string[]): any {
    const identity = JSON.stringify(path);
    count('proxyPathSerializationCalls');
    count('proxyPathSerializedUnits', identity.length);
    let known = proxies.get(target);
    if (known?.has(identity)) return known.get(identity)!;
    const proxy = new Proxy(target, {
      get(object, name) {
        count('proxyPropertyReads');
        if (name === '__proto__' || name === 'prototype') invalid();
        const value = Reflect.get(object, name);
        if (
          typeof name === 'string' &&
          Object.hasOwn(object, name) &&
          value &&
          typeof value === 'object'
        )
          return wrap(value, [...path, name]);
        return value;
      },
      ownKeys(object) {
        const keys = Reflect.ownKeys(object);
        count('proxyEnumeratedKeys', keys.length);
        return keys;
      },
      getOwnPropertyDescriptor(object, name) {
        const descriptor = Reflect.getOwnPropertyDescriptor(object, name);
        if (
          descriptor &&
          typeof name === 'string' &&
          descriptor.value &&
          typeof descriptor.value === 'object'
        )
          descriptor.value = wrap(descriptor.value, [...path, name]);
        return descriptor;
      },
      set(object, name, input) {
        if (!tracker.valid) invalid();
        key(name);
        // A detached former subtree cannot publish changes to its old path.
        let attached: any = tracker.raw;
        for (const part of path) attached = attached?.[part];
        if (attached !== object) invalid();
        if (Array.isArray(object) && name === 'length') {
          if (!Number.isSafeInteger(input) || input < 0 || input > object.length) invalid();
          if (input < object.length) {
            record({ op: 'truncate', path, length: input });
            object.length = input;
          }
          return true;
        }
        if (
          Array.isArray(object) &&
          (!/^(0|[1-9]\d*)$/.test(name) ||
            Number(name) > object.length ||
            Number(name) >= MAX_ITEMS)
        )
          invalid();
        const old = Reflect.get(object, name);
        if (
          old === input ||
          (input && typeof input === 'object' && targets.has(input) && old === targets.get(input))
        )
          return true;
        if (input === undefined && !Array.isArray(object)) {
          if (Object.hasOwn(object, name)) {
            record({ op: 'remove', path: [...path, name] });
            Reflect.deleteProperty(object, name);
          }
          return true;
        }
        const next = cloneBatchJson(
          input === undefined ? null : input,
          'mutation',
          path.length + 1,
        );
        record({
          op: 'set',
          path: [...path, name],
          value: cloneBatchJson(next, 'mutation', path.length + 1),
        });
        Reflect.set(object, name, next);
        return true;
      },
      deleteProperty(object, name) {
        if (!tracker.valid) invalid();
        key(name);
        if (Array.isArray(object)) invalid();
        let attached: any = tracker.raw;
        for (const part of path) attached = attached?.[part];
        if (attached !== object) invalid();
        if (Object.hasOwn(object, name)) {
          record({ op: 'remove', path: [...path, name] });
          Reflect.deleteProperty(object, name);
        }
        return true;
      },
      defineProperty() {
        invalid();
      },
      setPrototypeOf() {
        invalid();
      },
      preventExtensions() {
        invalid();
      },
    });
    targets.set(proxy, target);
    if (!known) {
      known = new Map();
      proxies.set(target, known);
    }
    known.set(identity, proxy);
    return proxy;
  }
  tracker.value = wrap(raw, []);
  handles.set(tracker.value, tracker);
  return tracker.value as T;
}
export function pendingIntakeBatchChanges(
  value: IntakeBatch,
): readonly Pick<ChatChange, 'op' | 'path'>[] {
  return (
    batchMutations(value)?.changes.map(({ op, path }) => ({ op, path: [...path] })) ?? [
      { op: 'set', path: [] },
    ]
  );
}
/** Cold failure recovery preserves live manager item references where their containers survive. */
export function reconcileBatchMutations(tracker: BatchMutations, source: IntakeBatch): void {
  const next = cloneBatchJson(source, 'replay') as Record<string, ChatJson>;
  function reconcile(target: any, incoming: any): void {
    const old = new Map(Object.keys(target).map((name) => [name, target[name]]));
    for (const name of Object.keys(target)) delete target[name];
    if (Array.isArray(target)) target.length = 0;
    for (const name of Object.keys(incoming)) {
      const prior = old.get(name),
        value = incoming[name];
      if (
        prior &&
        value &&
        typeof prior === 'object' &&
        typeof value === 'object' &&
        Array.isArray(prior) === Array.isArray(value)
      ) {
        reconcile(prior, value);
        target[name] = prior;
      } else target[name] = value;
    }
  }
  reconcile(tracker.raw, next);
  tracker.changes.length = 0;
  tracker.valid = true;
}
