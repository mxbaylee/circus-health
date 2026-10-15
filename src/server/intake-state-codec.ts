import {
  applyChatChanges,
  chatDecodeBudget,
  ChatDecodeLimitError,
  cloneChatJson,
  type ChatChange,
  type ChatDecodeBudget,
  type ChatJson,
} from './chat-journal-codec.ts';

import { recordIntakeWork, recordIntakeSerialization } from './intake-work-accounting.ts';
import { intakeStringChanges } from './intake-string-changes.ts';

export type IntakeJson = { [key: string]: ChatJson };
export type IntakeChange =
  | ChatChange
  | { op: 'move-key'; path: string[]; key: string; before: string | null }
  | { op: 'array-splice'; path: string[]; offset: number; remove: number; values: ChatJson[] }
  | { op: 'array-move'; path: string[]; from: number; to: number };

const MAX_ITEMS = 1_000_000;
const MAX_DEPTH = 64;
const BAD = new Set(['__proto__', 'prototype', 'constructor']);
const immutableValues = new WeakMap<object, { nodes: number; depth: number }>();

/** Internal ownership boundary: only pass normalized input or checked decoder output.
 * Newly owned branches freeze once; retained immutable branches are not traversed. */
export function freezeValidatedIntakeJson(value: IntakeJson): IntakeJson {
  const steps = freezeValidatedIntakeJsonSteps(value);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

export function* freezeValidatedIntakeJsonSteps(value: IntakeJson): Generator<void, IntakeJson> {
  let visits = 0;
  // Post-order traversal preserves the same retained-branch accounting while
  // allowing cold reconstruction to yield between independently owned nodes.
  const children = function* (child: object): Generator<ChatJson> {
    if (Array.isArray(child)) {
      for (const nested of child) yield nested;
    } else {
      for (const name in child) if (Object.hasOwn(child, name)) yield (child as IntakeJson)[name]!;
    }
  };
  const stack: Array<{
    child: object;
    nested: Generator<ChatJson>;
    size: { nodes: number; depth: number };
  }> = [];
  const enter = (child: ChatJson): { nodes: number; depth: number } | undefined => {
    if (!child || typeof child !== 'object') return { nodes: 1, depth: 0 };
    const retained = immutableValues.get(child);
    if (retained) {
      recordIntakeWork('immutableNodesReused');
      return retained;
    }
    stack.push({ child, nested: children(child), size: { nodes: 1, depth: 0 } });
    return undefined;
  };
  enter(value);
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    const next = frame.nested.next();
    if (!next.done) {
      const descendant = enter(next.value);
      if (descendant) {
        frame.size.nodes += descendant.nodes;
        frame.size.depth = Math.max(frame.size.depth, descendant.depth + 1);
      }
    } else {
      Object.freeze(frame.child);
      immutableValues.set(frame.child, frame.size);
      recordIntakeWork('immutableNodesFrozen');
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.size.nodes += frame.size.nodes;
        parent.size.depth = Math.max(parent.size.depth, frame.size.depth + 1);
      }
    }
    if (++visits === 64) {
      visits = 0;
      yield;
    }
  }
  return value;
}

/** Detached mutable view of a privately validated immutable root. */
export function cloneValidatedIntakeJson(value: IntakeJson): IntakeJson {
  if (!immutableValues.has(value)) fail();
  recordIntakeWork('trustedCloneCalls');
  const copy = (child: ChatJson): ChatJson => {
    recordIntakeWork('trustedCloneNodes');
    if (!child || typeof child !== 'object') return child;
    if (Array.isArray(child)) return child.map(copy);
    const result: IntakeJson = {};
    for (const name of Object.keys(child)) result[name] = copy(child[name]!);
    return result;
  };
  return copy(value) as IntakeJson;
}
function fail(): never {
  throw new Error('Invalid intake delta');
}
function object(value: unknown): value is IntakeJson {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
function key(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 1000 || BAD.has(value)) fail();
}
function indexKey(value: string): boolean {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number < 0xffffffff && String(number) === value;
}

/** Plain JSON object domain; object undefined is absent, array undefined/holes are null. */
export function normalizeIntakeJson(
  value: unknown,
  budget = chatDecodeBudget(),
  reuseOwned = false,
): IntakeJson {
  recordIntakeWork('normalizeCalls');
  if (!object(value)) fail();
  // Check data descriptors before the shared cloner reads values. Accessors and
  // proxies are outside this plain-data domain; no getter is part of decoding.
  let nodes = budget.nodes;
  const ancestors = new Set<object>();
  const validate = (input: unknown, depth: number): void => {
    recordIntakeWork('normalizeValidationNodes');
    if (typeof input === 'string') recordIntakeWork('normalizeValidatedStringUnits', input.length);
    if (--nodes < 0) throw new ChatDecodeLimitError('Intake decoded work limit exceeded');
    if (depth > MAX_DEPTH) fail();
    if (!input || typeof input !== 'object') return;
    const retained = reuseOwned ? immutableValues.get(input) : undefined;
    if (retained) {
      recordIntakeWork('normalizeValidationReusedNodes', retained.nodes);
      nodes -= retained.nodes - 1;
      if (nodes < 0) throw new ChatDecodeLimitError('Intake decoded work limit exceeded');
      if (depth + retained.depth > MAX_DEPTH) fail();
      return;
    }
    if (!Array.isArray(input) && !object(input)) fail();
    if (ancestors.has(input)) fail();
    ancestors.add(input);
    if (Array.isArray(input)) {
      if (input.length > MAX_ITEMS) fail();
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor && !Object.hasOwn(descriptor, 'value')) fail();
        validate(descriptor?.value ?? null, depth + 1);
      }
    } else {
      const names = Object.keys(input);
      if (names.length > MAX_ITEMS) fail();
      for (const name of names) {
        key(name);
        const descriptor = Object.getOwnPropertyDescriptor(input, name)!;
        if (!Object.hasOwn(descriptor, 'value')) fail();
        if (descriptor.value !== undefined) validate(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(input);
  };
  validate(value, 0);
  if (reuseOwned) {
    let clonedNodes = 0;
    const copy = (input: unknown, depth: number): ChatJson => {
      if (!input || typeof input !== 'object') {
        clonedNodes++;
        return cloneChatJson(input, depth, budget);
      }
      const retained = immutableValues.get(input);
      if (retained) {
        budget.nodes -= retained.nodes;
        if (budget.nodes < 0) throw new ChatDecodeLimitError('Intake decoded work limit exceeded');
        recordIntakeWork('normalizeReusedNodes', retained.nodes);
        return input as ChatJson;
      }
      if (--budget.nodes < 0) throw new ChatDecodeLimitError('Intake decoded work limit exceeded');
      clonedNodes++;
      if (Array.isArray(input))
        return Array.from({ length: input.length }, (_, index) =>
          copy(input[index] === undefined ? null : input[index], depth + 1),
        );
      const result: IntakeJson = {};
      for (const name of Object.keys(input)) {
        const child = (input as Record<string, unknown>)[name];
        if (child !== undefined) result[name] = copy(child, depth + 1);
      }
      return result;
    };
    try {
      return copy(value, 0) as IntakeJson;
    } finally {
      recordIntakeWork('normalizeCloneNodes', clonedNodes);
    }
  }
  const priorNodes = budget.nodes;
  const cloned = cloneChatJson(value, 0, budget) as IntakeJson;
  recordIntakeWork('normalizeCloneNodes', priorNodes - budget.nodes);
  return cloned;
}

/** Exact JSON.stringify bytes of the normalized domain, including nested insertion order. */
export function serializeIntakeJson(value: IntakeJson): string {
  const text = JSON.stringify(value);
  recordIntakeSerialization(text);
  return text;
}

/** Exact JSON.stringify pieces for already validated intake JSON. String work is
 * split before encoding so a single large scalar cannot monopolize a turn. */
export function* iterateSerializedIntakeJson(value: IntakeJson): Generator<string> {
  const active = new Set<object>();
  const encoded = function* (input: ChatJson): Generator<string> {
    if (typeof input === 'string') {
      yield '"';
      for (let at = 0; at < input.length;) {
        let end = Math.min(input.length, at + 4096);
        if (end < input.length && /[\uD800-\uDBFF]/.test(input[end - 1]!)) end--;
        yield JSON.stringify(input.slice(at, end)).slice(1, -1);
        at = end;
      }
      yield '"';
      return;
    }
    if (!input || typeof input !== 'object') {
      yield JSON.stringify(input);
      return;
    }
    if (active.has(input)) throw Error('Cyclic intake JSON');
    active.add(input);
    try {
      if (Array.isArray(input)) {
        yield '[';
        for (let index = 0; index < input.length; index++) {
          if (index) yield ',';
          yield* encoded(input[index] ?? null);
        }
        yield ']';
      } else {
        yield '{';
        let first = true;
        for (const name of Object.keys(input)) {
          if (!first) yield ',';
          first = false;
          yield JSON.stringify(name);
          yield ':';
          yield* encoded(input[name]!);
        }
        yield '}';
      }
    } finally {
      active.delete(input);
    }
  };
  yield* encoded(value);
}

function targetAt(state: IntakeJson, path: string[]): ChatJson {
  let current: ChatJson = state;
  for (const name of path) {
    key(name);
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, name)) fail();
    if (Array.isArray(current)) {
      if (
        !/^(0|[1-9]\d*)$/.test(name) ||
        Number(name) >= current.length ||
        Number(name) >= MAX_ITEMS
      )
        fail();
      current = current[Number(name)]!;
    } else current = current[name]!;
  }
  return current;
}

function move(state: IntakeJson, raw: Record<string, unknown>, budget: ChatDecodeBudget): void {
  if (
    Object.keys(raw).sort().join('\0') !== ['before', 'key', 'op', 'path'].join('\0') ||
    !Array.isArray(raw.path) ||
    raw.path.length > MAX_DEPTH
  )
    fail();
  const path: string[] = raw.path;
  path.forEach(key);
  key(raw.key);
  if (indexKey(raw.key)) fail();
  if (raw.before !== null) {
    key(raw.before);
    if (indexKey(raw.before) || raw.before === raw.key) fail();
  }
  const target = targetAt(state, path);
  if (
    !object(target) ||
    !Object.hasOwn(target, raw.key) ||
    (raw.before !== null && !Object.hasOwn(target, raw.before))
  )
    fail();
  const names = Object.keys(target);
  if (names.length > MAX_ITEMS) fail();
  budget.operations -= 1 + path.length + names.length;
  if (budget.operations < 0) throw new ChatDecodeLimitError('Intake decoded work limit exceeded');
  // Rebuild only the shallow member sequence, retaining every child value/reference.
  const reordered: IntakeJson = {};
  for (const name of names) {
    if (name === raw.key) continue;
    if (name === raw.before) reordered[raw.key] = target[raw.key]!;
    reordered[name] = target[name]!;
  }
  if (raw.before === null) reordered[raw.key] = target[raw.key]!;
  for (const name of names) delete target[name];
  for (const name of Object.keys(reordered)) target[name] = reordered[name]!;
}

function arrayChange(
  state: IntakeJson,
  raw: Record<string, unknown>,
  budget: ChatDecodeBudget,
): void {
  const fields =
    raw.op === 'array-splice'
      ? ['offset', 'op', 'path', 'remove', 'values']
      : ['from', 'op', 'path', 'to'];
  if (
    Object.keys(raw).sort().join('\0') !== fields.join('\0') ||
    !Array.isArray(raw.path) ||
    raw.path.length > MAX_DEPTH
  )
    fail();
  const path: string[] = raw.path;
  path.forEach(key);
  const target = targetAt(state, path);
  if (!Array.isArray(target) || target.length > MAX_ITEMS) fail();
  const natural = (value: unknown): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0;
  if (raw.op === 'array-move') {
    if (
      !natural(raw.from) ||
      !natural(raw.to) ||
      raw.from >= target.length ||
      raw.to >= target.length ||
      raw.from === raw.to
    )
      fail();
    budget.operations -= 1 + path.length + 2 * target.length;
    if (budget.operations < 0) throw new ChatDecodeLimitError('Intake decoded work limit exceeded');
    const value = target.splice(raw.from, 1)[0]!;
    target.splice(raw.to, 0, value);
  } else {
    if (
      !natural(raw.offset) ||
      !natural(raw.remove) ||
      raw.offset + raw.remove > target.length ||
      !Array.isArray(raw.values) ||
      raw.values.length > MAX_ITEMS ||
      target.length - raw.remove + raw.values.length > MAX_ITEMS ||
      (!raw.remove && !raw.values.length)
    )
      fail();
    budget.operations -= 1 + path.length + target.length + raw.values.length;
    if (budget.operations < 0) throw new ChatDecodeLimitError('Intake decoded work limit exceeded');
    // Clone before mutation, sharing the cumulative decoder budget and real depth.
    const values = raw.values.map((value) => cloneChatJson(value, path.length + 1, budget));
    const tail = target.slice(raw.offset + raw.remove);
    target.length = raw.offset;
    for (const value of values) target.push(value);
    for (const value of tail) target.push(value);
  }
}

export function applyIntakeChanges(
  initial: IntakeJson | undefined,
  raw: unknown,
  budget = chatDecodeBudget(),
): IntakeJson {
  const steps = applyIntakeChangesSteps(initial, raw, budget);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** The same decoder with a work boundary between changes. */
export function* applyIntakeChangesSteps(
  initial: IntakeJson | undefined,
  raw: unknown,
  budget = chatDecodeBudget(),
): Generator<void, IntakeJson> {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS || (initial !== undefined && !object(initial)))
    fail();
  let state = initial;
  let applied = 0;
  for (const change of raw) {
    if (
      change &&
      typeof change === 'object' &&
      !Array.isArray(change) &&
      ['move-key', 'array-splice', 'array-move'].includes(change.op)
    ) {
      if (!state) fail();
      if (change.op === 'move-key') move(state, change, budget);
      else arrayChange(state, change, budget);
    } else {
      const next = applyChatChanges(state, [change], budget);
      if (!object(next)) fail();
      state = next;
    }
    if (++applied % 64 === 0) yield;
  }
  if (!state) fail();
  return state;
}

/** Replay into private changed branches using exactly the ordinary decoder budget.
 * Host shallow copies are counted separately; they do not change v3 usage charges. */
export function applyIntakeChangesIsolated(
  initial: IntakeJson | undefined,
  changes: IntakeChange[],
  budget = chatDecodeBudget(),
): IntakeJson {
  let state = initial;
  const owned = new WeakSet<object>();
  const copy = (value: ChatJson): ChatJson => {
    if (!value || typeof value !== 'object') fail();
    if (owned.has(value)) return value;
    const result = Array.isArray(value) ? [...value] : { ...value };
    owned.add(result);
    recordIntakeWork('candidatePathCopies');
    recordIntakeWork('candidateCopiedMembers', Object.keys(value).length);
    return result;
  };
  for (const change of changes) {
    if (state !== undefined) {
      state = copy(state) as IntakeJson;
      // Container operations mutate the target itself. Other operations only
      // replace/delete a property on its parent; strings are immutable values.
      const targetPath = ['move-key', 'array-splice', 'array-move', 'truncate'].includes(change.op)
        ? change.path
        : change.path.slice(0, -1);
      let parent: ChatJson = state;
      for (const name of targetPath) {
        key(name);
        if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, name)) fail();
        const container = parent as Record<string, ChatJson>;
        container[name] = copy(container[name]!);
        parent = container[name]!;
      }
    }
    state = applyIntakeChanges(state, [change], budget);
  }
  if (!state) fail();
  return state;
}

/** Find a longest increasing subsequence of current positions in target order. */
function retainedKeys(current: string[], desired: string[]): Set<string> {
  const positions = new Map(current.map((name, index) => [name, index]));
  const tails: number[] = [];
  const predecessors: number[] = [];
  for (let index = 0; index < desired.length; index++) {
    const position = positions.get(desired[index]!)!;
    let low = 0,
      high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions.get(desired[tails[middle]!]!)! < position) low = middle + 1;
      else high = middle;
    }
    predecessors[index] = low ? tails[low - 1]! : -1;
    tails[low] = index;
  }
  const retained = new Set<string>();
  for (let index = tails.at(-1) ?? -1; index >= 0; index = predecessors[index]!)
    retained.add(desired[index]!);
  return retained;
}

/** Inputs must already be normalized. Host matching traverses the complete view. */
export function intakeChanges(before: IntakeJson, after: IntakeJson): IntakeChange[] {
  recordIntakeWork('diffCalls');
  if (!object(before) || !object(after)) fail();
  const changes: IntakeChange[] = [];
  const diff = (current: ChatJson | undefined, target: ChatJson, path: string[]): void => {
    recordIntakeWork('diffNodeVisits');
    if (path.length > MAX_DEPTH || changes.length > MAX_ITEMS) fail();
    if (current === target) return;
    if (typeof current === 'string' && typeof target === 'string') {
      for (const change of intakeStringChanges(current, target, path)) changes.push(change);
    } else if (Array.isArray(current) && Array.isArray(target)) {
      if (target.length > MAX_ITEMS) fail();
      // Exact ordered serialization identities, with FIFO occurrence queues for
      // duplicates. These indexes are transient and never become durable evidence.
      const positions = new Map<string, { indices: number[]; cursor: number }>();
      for (let index = 0; index < current.length; index++) {
        const text = JSON.stringify(current[index]);
        recordIntakeWork('arrayMatchSerializedBytes', Buffer.byteLength(text));
        recordIntakeWork('arrayMatchItems');
        let entry = positions.get(text);
        if (!entry) {
          entry = { indices: [], cursor: 0 };
          positions.set(text, entry);
        }
        entry.indices.push(index);
      }
      const used = new Set<number>();
      const wanted = target.map((value) => {
        const text = JSON.stringify(value);
        recordIntakeWork('arrayMatchSerializedBytes', Buffer.byteLength(text));
        recordIntakeWork('arrayMatchItems');
        const entry = positions.get(text);
        const index = entry?.indices[entry.cursor++];
        if (index !== undefined) used.add(index);
        return index;
      });
      // Match changed/moved objects using unique unchanged leaf evidence. A
      // large retained member outweighs incidental small metadata matches. This
      // is transient matching only: no IDs or schema fields are privileged.
      const members = (
        value: ChatJson,
        consume: (text: string) => boolean,
        sliding = false,
      ): void => {
        const add = (names: string[], child: ChatJson, window: boolean) => {
          const text = JSON.stringify([names, window, child]);
          recordIntakeWork('arrayMatchSerializedBytes', Buffer.byteLength(text));
          recordIntakeWork('arrayMatchItems');
          return consume(text);
        };
        const visit = (child: ChatJson, names: string[]) => {
          if (child && typeof child === 'object') {
            for (const name of Object.keys(child))
              visit((child as Record<string, ChatJson>)[name]!, [...names, name]);
          } else {
            const exact = add(names, child, false);
            // A moved string (or nested string leaf) can itself contain small
            // edits. Exact fixed windows retain its correspondence without
            // resending the rest of that string after an index shift.
            if (!exact && typeof child === 'string' && child.length >= 128)
              for (let offset = 0; offset + 32 <= child.length; offset += sliding ? 1 : 32)
                add(names, child.slice(offset, offset + 32), true);
          }
        };
        visit(value, []);
      };
      const anchors = new Map<string, number | null>();
      for (let index = 0; index < current.length; index++) {
        if (used.has(index)) continue;
        members(current[index]!, (member) => {
          const previous = anchors.get(member);
          anchors.set(member, previous === undefined || previous === index ? index : null);
          return false;
        });
      }
      const candidates: { old: number; next: number; weight: number }[] = [];
      for (let index = 0; index < target.length; index++) {
        if (wanted[index] !== undefined) continue;
        const weights = new Map<number, number>();
        members(
          target[index]!,
          (member) => {
            const old = anchors.get(member);
            if (old !== null && old !== undefined) {
              weights.set(old, (weights.get(old) ?? 0) + member.length);
              return true;
            }
            return false;
          },
          true,
        );
        for (const [old, weight] of weights) candidates.push({ old, next: index, weight });
      }
      candidates.sort((a, b) => b.weight - a.weight || a.next - b.next || a.old - b.old);
      for (const candidate of candidates) {
        if (used.has(candidate.old) || wanted[candidate.next] !== undefined) continue;
        wanted[candidate.next] = candidate.old;
        used.add(candidate.old);
      }
      // Pair residual changed slots after reserving exact and anchored occurrences.
      const remaining = current.map((_, index) => index).filter((index) => !used.has(index));
      let cursor = 0;
      for (let index = 0; index < wanted.length; index++) {
        if (wanted[index] !== undefined) continue;
        const old = remaining[cursor++];
        if (old !== undefined) {
          wanted[index] = old;
          used.add(old);
        }
      }
      const live = current.map((_, index) => index);
      for (let index = live.length - 1; index >= 0;) {
        if (used.has(live[index]!)) {
          index--;
          continue;
        }
        const end = index + 1;
        while (index >= 0 && !used.has(live[index]!)) index--;
        changes.push({
          op: 'array-splice',
          path,
          offset: index + 1,
          remove: end - index - 1,
          values: [],
        });
        live.splice(index + 1, end - index - 1);
      }
      let fresh = current.length;
      const added: ChatJson[] = [];
      const appendAt = live.length;
      for (let index = 0; index < wanted.length; index++) {
        if (wanted[index] !== undefined) continue;
        wanted[index] = fresh++;
        added.push(target[index]!);
        live.push(wanted[index]!);
      }
      if (added.length)
        changes.push({ op: 'array-splice', path, offset: appendAt, remove: 0, values: added });
      const desired = wanted as number[];
      const retained = retainedKeys(live.map(String), desired.map(String));
      for (let index = desired.length - 1; index >= 0; index--) {
        const identity = desired[index]!;
        if (retained.has(String(identity))) continue;
        const from = live.indexOf(identity);
        live.splice(from, 1);
        const to = index + 1 === desired.length ? live.length : live.indexOf(desired[index + 1]!);
        live.splice(to, 0, identity);
        if (from !== to) changes.push({ op: 'array-move', path, from, to });
      }
      for (let index = 0; index < target.length; index++) {
        const old = desired[index]!;
        if (old < current.length) diff(current[old], target[index]!, [...path, String(index)]);
      }
    } else if (object(current) && object(target)) {
      for (const name of Object.keys(current))
        if (!Object.hasOwn(target, name)) changes.push({ op: 'remove', path: [...path, name] });
      for (const name of Object.keys(target)) diff(current[name], target[name]!, [...path, name]);
      const names = Object.keys(current).filter(
        (name) => Object.hasOwn(target, name) && !indexKey(name),
      );
      const wanted = Object.keys(target).filter((name) => !indexKey(name));
      for (const name of wanted) if (!Object.hasOwn(current, name)) names.push(name);
      const retained = retainedKeys(names, wanted);
      for (let index = wanted.length - 1; index >= 0; index--) {
        const name = wanted[index]!;
        if (!retained.has(name))
          changes.push({ op: 'move-key', path, key: name, before: wanted[index + 1] ?? null });
      }
    } else changes.push({ op: 'set', path, value: cloneChatJson(target, path.length) });
    if (changes.length > MAX_ITEMS) fail();
  };
  diff(before, after, []);
  return changes;
}
