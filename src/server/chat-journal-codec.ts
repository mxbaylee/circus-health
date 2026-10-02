/** Generic JSON decoding only: recovery never reruns assistant business logic. */
export type ChatJson = null | boolean | number | string | ChatJson[] | { [key: string]: ChatJson };
export type ChatChange =
  | { op: 'set'; path: string[]; value: ChatJson }
  | { op: 'remove'; path: string[] }
  | { op: 'truncate'; path: string[]; length: number }
  | { op: 'splice'; path: string[]; offset: number; remove: number; text: string };
const MAX_DEPTH = 64;
const MAX_ITEMS = 1_000_000;
const BAD = new Set(['__proto__', 'prototype', 'constructor']);
export interface ChatDecodeBudget {
  nodes: number;
  operations: number;
  stringWork: number;
}
export function chatDecodeBudget(): ChatDecodeBudget {
  return { nodes: 1_000_000, operations: 1_000_000, stringWork: 100_000_000 };
}
export class ChatDecodeLimitError extends Error {}
function charge(budget: ChatDecodeBudget, kind: keyof ChatDecodeBudget, amount = 1) {
  budget[kind] -= amount;
  if (budget[kind] < 0) throw new ChatDecodeLimitError('Conversation decoded work limit exceeded');
}
const own = (value: object, key: string) => Object.hasOwn(value, key);
function fail(): never {
  throw Error('Invalid conversation delta');
}
function key(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 1000 || BAD.has(value)) fail();
}
export function cloneChatJson(value: unknown, depth = 0, budget = chatDecodeBudget()): ChatJson {
  charge(budget, 'nodes');
  if (depth > MAX_DEPTH) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') fail();
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) fail();
    return Array.from({ length: value.length }, (_, i) =>
      cloneChatJson(value[i] === undefined ? null : value[i], depth + 1, budget),
    );
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const result: { [key: string]: ChatJson } = {};
  const keys = Object.keys(value);
  if (keys.length > MAX_ITEMS) fail();
  for (const name of keys) {
    key(name);
    const child = (value as Record<string, unknown>)[name];
    if (child !== undefined) result[name] = cloneChatJson(child, depth + 1, budget);
  }
  return result;
}
export function chatChanges(before: ChatJson, after: unknown): ChatChange[] {
  const changes: ChatChange[] = [];
  const diff = (a: ChatJson | undefined, b: unknown, path: string[]): void => {
    if (path.length > MAX_DEPTH) fail();
    if (a === b) return;
    if (typeof a === 'string' && typeof b === 'string') {
      let first = 0,
        last = 0;
      while (first < a.length && first < b.length && a[first] === b[first]) first++;
      while (
        last < a.length - first &&
        last < b.length - first &&
        a[a.length - 1 - last] === b[b.length - 1 - last]
      )
        last++;
      changes.push({
        op: 'splice',
        path,
        offset: first,
        remove: a.length - first - last,
        text: b.slice(first, b.length - last),
      });
    } else if (Array.isArray(a) && Array.isArray(b)) {
      if (b.length > MAX_ITEMS) fail();
      for (let i = 0; i < b.length; i++)
        diff(a[i], b[i] === undefined ? null : b[i], [...path, String(i)]);
      if (b.length < a.length) changes.push({ op: 'truncate', path, length: b.length });
    } else if (
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(b))) fail();
      const target = b as Record<string, unknown>;
      const keys = Object.keys(target);
      if (keys.length > MAX_ITEMS) fail();
      for (const name of Object.keys(a))
        if (!own(target, name) || target[name] === undefined)
          changes.push({ op: 'remove', path: [...path, name] });
      for (const name of keys) {
        key(name);
        if (target[name] !== undefined) diff(a[name], target[name], [...path, name]);
      }
    } else changes.push({ op: 'set', path, value: cloneChatJson(b, path.length) });
    if (changes.length > MAX_ITEMS) fail();
  };
  diff(before, after, []);
  return changes;
}
function arrayIndex(key: string): number {
  if (!/^(0|[1-9]\d*)$/.test(key)) fail();
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index >= MAX_ITEMS) fail();
  return index;
}
export function applyChatChanges(
  initial: ChatJson | undefined,
  raw: unknown,
  budget = chatDecodeBudget(),
): ChatJson {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) fail();
  let state = initial;
  for (const change of raw) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) fail();
    const item = change as Record<string, unknown>;
    if (!Array.isArray(item.path) || item.path.length > MAX_DEPTH) fail();
    const path: string[] = item.path;
    charge(budget, 'operations', 1 + path.length);
    path.forEach(key);
    const fields: Record<string, string[]> = {
      set: ['op', 'path', 'value'],
      remove: ['op', 'path'],
      truncate: ['op', 'path', 'length'],
      splice: ['op', 'path', 'offset', 'remove', 'text'],
    };
    if (
      typeof item.op !== 'string' ||
      !own(fields, item.op) ||
      Object.keys(item).sort().join() !== fields[item.op]!.sort().join()
    )
      fail();
    if (!path.length && item.op === 'set') {
      if (state !== undefined) fail();
      state = cloneChatJson(item.value, 0, budget);
      continue;
    }
    if (state === undefined) fail();
    let parent: ChatJson = state;
    for (const name of path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object') fail();
      if (Array.isArray(parent)) {
        const index = arrayIndex(name);
        if (index >= parent.length) fail();
        parent = parent[index]!;
      } else {
        if (!own(parent, name)) fail();
        parent = parent[name]!;
      }
    }
    const name = path.at(-1);
    const get = (): ChatJson => {
      if (name === undefined) return state!;
      if (!parent || typeof parent !== 'object' || !own(parent, name)) fail();
      if (Array.isArray(parent)) arrayIndex(name);
      return (parent as Record<string, ChatJson>)[name]!;
    };
    const set = (value: ChatJson) => {
      if (name === undefined || !parent || typeof parent !== 'object') fail();
      if (Array.isArray(parent)) {
        const index = arrayIndex(name);
        if (index > parent.length) fail();
        parent[index] = value;
      } else parent[name] = value;
    };
    if (item.op === 'set') set(cloneChatJson(item.value, path.length, budget));
    else if (item.op === 'remove') {
      if (
        name === undefined ||
        !parent ||
        typeof parent !== 'object' ||
        Array.isArray(parent) ||
        !own(parent, name)
      )
        fail();
      delete parent[name];
    } else if (item.op === 'truncate') {
      const target = get();
      if (
        !Array.isArray(target) ||
        !Number.isSafeInteger(item.length) ||
        Number(item.length) < 0 ||
        Number(item.length) >= target.length
      )
        fail();
      target.length = Number(item.length);
    } else {
      const target = get();
      if (
        typeof target !== 'string' ||
        typeof item.text !== 'string' ||
        !Number.isSafeInteger(item.offset) ||
        !Number.isSafeInteger(item.remove) ||
        Number(item.offset) < 0 ||
        Number(item.remove) < 0 ||
        Number(item.offset) + Number(item.remove) > target.length
      )
        fail();
      charge(budget, 'stringWork', target.length + item.text.length);
      set(
        target.slice(0, Number(item.offset)) +
          item.text +
          target.slice(Number(item.offset) + Number(item.remove)),
      );
    }
  }
  if (state === undefined) fail();
  return state;
}
