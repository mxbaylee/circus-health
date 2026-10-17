/** Bounded legacy delta projection. This does not select or authenticate evidence. */
import {
  prepareIntakeJsonTreeSteps,
  type PreparedIntakeJsonTree,
  type PreparedIntakeJsonCanonical,
  type IntakeJsonCanonicalHandle,
  type IntakeJsonCanonicalKind,
  type IntakeJsonCanonicalWork,
  type IntakeJsonCanonicalScratch,
} from './intake-json-canonical.ts';

export const LEGACY_NATIVE_DELTA_BYTES = 131072;
const MAX_NODES = 8192,
  MAX_DEPTH = 96,
  INPUT_UNITS = 2048;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The original iterator is consumed once, including on a streaming fallback. */
export function* prepareIntakeLegacyDeltaTreeSteps(
  pieces: Iterable<string>,
  checkpoint: () => void,
  selected: (native: boolean) => void,
  options: { scratch?: IntakeJsonCanonicalScratch } = {},
): Generator<void, PreparedIntakeJsonTree> {
  const iterator = pieces[Symbol.iterator](),
    prefix: string[] = [];
  let bytes = 0,
    trailingHigh = false,
    remainder = '',
    ended = false,
    returned = false,
    yields = 0;
  const close = () => {
    if (returned) return;
    returned = true;
    iterator.return?.();
  };
  try {
    while (!ended && !remainder) {
      checkpoint();
      const next = iterator.next();
      checkpoint();
      ended = !!next.done;
      if (ended) break;
      const piece = next.value;
      for (let at = 0; at < piece.length; at += INPUT_UNITS) {
        const part = piece.slice(at, at + INPUT_UNITS),
          first = part.charCodeAt(0),
          // Buffer.byteLength counts a separated surrogate as three bytes. A
          // following low unit completes the prior pair's four bytes instead.
          size =
            Buffer.byteLength(part) - (trailingHigh && first >= 0xdc00 && first <= 0xdfff ? 2 : 0);
        if (bytes + size > LEGACY_NATIVE_DELTA_BYTES) {
          remainder = piece.slice(at);
          break;
        }
        prefix.push(part);
        bytes += size;
        const last = part.charCodeAt(part.length - 1);
        trailingHigh = last >= 0xd800 && last <= 0xdbff;
        checkpoint();
        yields++;
        yield;
        checkpoint();
      }
    }
    if (ended) {
      const text = prefix.join('');
      let value: Json | undefined;
      try {
        value = JSON.parse(text) as Json;
      } catch (error) {
        value = undefined;
        if (!(error instanceof SyntaxError || error instanceof RangeError)) throw error;
      }
      checkpoint();
      if (value !== undefined) {
        const pending = [{ value, depth: 0 }];
        let nodes = 0,
          bounded = true;
        while (pending.length) {
          const item = pending.pop()!;
          if (++nodes > MAX_NODES || item.depth > MAX_DEPTH) {
            bounded = false;
            break;
          }
          if (item.value !== null && typeof item.value === 'object') {
            Object.freeze(item.value);
            const children = Array.isArray(item.value) ? item.value : Object.values(item.value);
            if (nodes + pending.length + children.length > MAX_NODES) {
              bounded = false;
              break;
            }
            for (const child of children) {
              pending.push({ value: child, depth: item.depth + 1 });
              if (pending.length % 64 === 0) {
                checkpoint();
                yields++;
                yield;
                checkpoint();
              }
            }
          }
          if (nodes % 64 === 0) {
            checkpoint();
            yields++;
            yield;
            checkpoint();
          }
        }
        let exact = false;
        if (bounded) {
          checkpoint();
          try {
            exact = JSON.stringify(value) === text;
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
          }
          checkpoint();
        }
        if (exact) {
          checkpoint();
          const tree = nativeTree(value, text, checkpoint, yields);
          selected(true);
          checkpoint();
          return tree;
        }
      }
    }
    selected(false);
    const fallback = (function* () {
      try {
        yield* prefix;
        if (remainder) yield remainder;
        while (!ended) {
          checkpoint();
          const next = iterator.next();
          checkpoint();
          ended = !!next.done;
          if (!ended) yield next.value;
        }
      } finally {
        close();
      }
    })();
    return yield* prepareIntakeJsonTreeSteps(fallback, {
      preserveNumbers: true,
      scratch: options.scratch,
    });
  } finally {
    close();
  }
}

function nativeTree(
  value: Json,
  text: string,
  checkpoint: () => void,
  yields: number,
): PreparedIntakeJsonCanonical {
  let values = new WeakMap<IntakeJsonCanonicalHandle, Json>();
  const work: IntakeJsonCanonicalWork = {
    inputCodeUnits: text.length,
    sqliteCalls: 0,
    scratchWrittenBytes: 0,
    scratchReadBytes: 0,
    scratchReadBufferAllocations: 0,
    scratchReadBufferReuses: 0,
    outputBytes: Buffer.byteLength(text),
    maxChunkBytes: 0,
    // No disk-parser scratch buffers or retained decimal digit prefix. The
    // native tree's separate limits are bytes/nodes/depth, not an RSS claim.
    maxBufferBytes: 0,
    maxNumberDigits: 0,
    yields,
    keyIndexRows: 0,
  };
  let closed = false;
  const check = () => {
    if (closed) throw Error('JSON canonical preparation is closed');
    checkpoint();
  };
  const handle = (value: Json) => {
    const handle = Object.freeze({}) as IntakeJsonCanonicalHandle;
    values.set(handle, value);
    return handle;
  };
  const read = (handle: IntakeJsonCanonicalHandle) => {
    check();
    if (!values.has(handle)) throw Error('Foreign JSON canonical handle');
    return values.get(handle)!;
  };
  const kind = (value: Json): IntakeJsonCanonicalKind =>
    value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : (typeof value as IntakeJsonCanonicalKind);
  const object = (handle: IntakeJsonCanonicalHandle, message = 'JSON field requires object') => {
    const value = read(handle);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error(message);
    return value;
  };
  const chunks = function* (text: string) {
    check();
    for (let at = 0; at < text.length;) {
      let end = Math.min(at + INPUT_UNITS, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      const piece = text.slice(at, end);
      work.maxChunkBytes = Math.max(work.maxChunkBytes, Buffer.byteLength(piece));
      check();
      yield piece;
      check();
      at = end;
    }
  };
  const serialize = (value: Json) => {
    check();
    const text = JSON.stringify(value);
    check();
    return text;
  };
  const root = handle(value);
  return {
    root,
    bytes: work.outputBytes,
    work,
    kind(handle) {
      return kind(read(handle));
    },
    field(handleValue, name) {
      const value = object(handleValue);
      return Object.hasOwn(value, name) ? handle(value[name]!) : undefined;
    },
    pieces(handle) {
      return chunks(serialize(read(handle)));
    },
    chunks() {
      check();
      return chunks(text);
    },
    *arrayItems(handleValue) {
      const value = read(handleValue);
      if (!Array.isArray(value)) throw Error('JSON array iteration requires array');
      for (const child of value) {
        check();
        yield handle(child);
        check();
      }
    },
    *objectFields(handleValue) {
      const value = object(handleValue, 'JSON field iteration requires object');
      for (const name of Object.keys(value)) {
        check();
        yield {
          value: handle(value[name]!),
          name: () => chunks(serialize(name)),
          matches(candidate: string) {
            check();
            return name === candidate;
          },
        };
        check();
      }
    },
    splitObjectField(handleValue, name) {
      const value = object(handleValue);
      if (!Object.hasOwn(value, name)) return undefined;
      let before = '{',
        after = '',
        found = false,
        first = true;
      for (const key of Object.keys(value)) {
        check();
        const prefix = (first ? '' : ',') + serialize(key) + ':';
        first = false;
        if (key === name) {
          before += prefix;
          found = true;
        } else if (found) after += prefix + serialize(value[key]!);
        else before += prefix + serialize(value[key]!);
      }
      after += '}';
      return {
        value: handle(value[name]!),
        before: () => chunks(before),
        after: () => chunks(after),
      };
    },
    close() {
      closed = true;
      values = new WeakMap();
      text = '';
      value = null;
    },
  };
}
