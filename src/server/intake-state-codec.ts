import {
  applyChatChanges,
  chatChanges,
  chatDecodeBudget,
  ChatDecodeLimitError,
  cloneChatJson,
  type ChatChange,
  type ChatDecodeBudget,
  type ChatJson,
} from './chat-journal-codec.ts';

export type IntakeJson = { [key: string]: ChatJson };
export type IntakeChange =
  ChatChange | { op: 'move-key'; path: string[]; key: string; before: string | null };

const MAX_ITEMS = 1_000_000;
const MAX_DEPTH = 64;
const BAD = new Set(['__proto__', 'prototype', 'constructor']);
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
export function normalizeIntakeJson(value: unknown, budget = chatDecodeBudget()): IntakeJson {
  if (!object(value)) fail();
  // Check data descriptors before the shared cloner reads values. Accessors and
  // proxies are outside this plain-data domain; no getter is part of decoding.
  let nodes = budget.nodes;
  const ancestors = new Set<object>();
  const validate = (input: unknown, depth: number): void => {
    if (--nodes < 0) throw new ChatDecodeLimitError('Intake decoded work limit exceeded');
    if (depth > MAX_DEPTH) fail();
    if (!input || typeof input !== 'object') return;
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
  return cloneChatJson(value, 0, budget) as IntakeJson;
}

/** Exact JSON.stringify bytes of the normalized domain, including nested insertion order. */
export function serializeIntakeJson(value: IntakeJson): string {
  return JSON.stringify(value);
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

export function applyIntakeChanges(
  initial: IntakeJson | undefined,
  raw: unknown,
  budget = chatDecodeBudget(),
): IntakeJson {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS || (initial !== undefined && !object(initial)))
    fail();
  let state = initial;
  for (const change of raw) {
    if (
      change &&
      typeof change === 'object' &&
      !Array.isArray(change) &&
      change.op === 'move-key'
    ) {
      if (!state) fail();
      move(state, change, budget);
    } else {
      const next = applyChatChanges(state, [change], budget);
      if (!object(next)) fail();
      state = next;
    }
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

/** Inputs must already be normalized. Diffing traverses them without copying their values. */
export function intakeChanges(before: IntakeJson, after: IntakeJson): IntakeChange[] {
  if (!object(before) || !object(after)) fail();
  const changes: IntakeChange[] = chatChanges(before, after);
  const order = (current: ChatJson | undefined, target: ChatJson, path: string[]): void => {
    if (Array.isArray(current) && Array.isArray(target)) {
      target.forEach((value, index) => order(current[index]!, value, [...path, String(index)]));
    } else if (object(current) && object(target)) {
      // Chat removes missing members then appends new ones in target order.
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
      for (const name of Object.keys(target)) order(current[name]!, target[name]!, [...path, name]);
    }
    if (changes.length > MAX_ITEMS || path.length > MAX_DEPTH) fail();
  };
  order(before, after, []);
  return changes;
}
