/** Typed invocation-local graph work. No source/head/receipt copies or SQL dialect. */
import { createIntakeEncryptedScratch } from './intake-encrypted-scratch.ts';
import { types } from 'node:util';
import { recordIntakeWork } from './intake-work-accounting.ts';
import {
  hash as checkedHash,
  integer,
  invalid,
  type IntakeStateIdentity,
} from './intake-state-evidence.ts';
import {
  INTAKE_TREE_PAGE_BYTES,
  intakeTreeRef,
  type IntakeTreeRef,
  type IntakeTreeRoot,
} from './intake-state-tree.ts';

export type IntakeGraphKind = 'directory' | 'map' | 'sequence' | 'bytes' | 'receipts' | 'history';
export type IntakeGraphCopyKind = IntakeGraphKind | 'inventory' | 'build-directory';
interface Summary {
  ref: IntakeTreeRef;
  bytes: number;
  maxSequence: number;
}
interface Nested {
  ref: IntakeTreeRef;
  kind: IntakeGraphKind;
  bytes: number;
}
interface Copied {
  ref: IntakeTreeRef;
  bytes: number;
}
interface Work {
  ref: IntakeTreeRef;
  kind: IntakeGraphCopyKind;
  context: string;
  builds: IntakeTreeRoot;
}
const ordered = (n: number) => String(n).padStart(16, '0');

export function createIntakeGraphScratch(
  identity: IntakeStateIdentity,
  selectedHead: string,
  assertCurrent: () => void,
  options: { liveSummaryChecks?: boolean } = {},
) {
  const live = options.liveSummaryChecks === true;
  let active = false,
    closed = false,
    poisoned = false;
  const localCurrent = () => {
    if (closed || poisoned) throw Error('Graph scratch authority closed');
  };
  const storage = createIntakeEncryptedScratch({
    identity,
    selectedHead,
    assertCurrent() {
      if (live && active) localCurrent();
      else assertCurrent();
    },
    tables: ['seen', 'nested', 'pending', 'copied', 'stack', 'active'],
  });
  function close() {
    closed = true;
    if (active) poisoned = true;
    storage.close();
  }
  /** Only fixed synchronous summary work may suppress internal cell checks.
   * This interval does not mint authority: its result remains private until
   * the full closing proof succeeds. No callback, iterator or promise escapes. */
  function data<T>(operation: () => T, summary = false): T {
    if (!live) return operation();
    // All data methods participate, including copy methods which retain their
    // normal per-cell schedule outside a live summary operation.
    if (active) {
      poisoned = true;
      throw Error('Graph scratch reentrant operation');
    }
    localCurrent();
    if (!summary) return operation();
    active = true;
    try {
      assertCurrent();
      localCurrent();
      const result = operation();
      assertCurrent();
      localCurrent();
      return result;
    } catch (error) {
      poisoned = true;
      try {
        close();
      } catch {
        // Erased keys/roots cannot expose a result; preserve the first refusal.
      }
      throw error;
    } finally {
      active = false;
    }
  }
  function checkedKind(value: IntakeGraphKind) {
    if (!['directory', 'map', 'sequence', 'bytes', 'receipts', 'history'].includes(value))
      invalid('graph scratch kind');
  }
  function reference(value: IntakeTreeRef): IntakeTreeRef {
    if (!live) return value;
    if (!value || typeof value !== 'object' || types.isProxy(value))
      invalid('graph scratch reference');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid('graph scratch reference');
    const keys = Reflect.ownKeys(value),
      expected = ['hash', 'count', 'height', 'first', 'last'],
      result = Object.create(null) as Record<string, unknown>;
    if (keys.length !== expected.length) invalid('graph scratch reference');
    // Retain insertion order: existing graph equality compares serialized refs.
    for (const key of keys) {
      if (typeof key !== 'string' || !expected.includes(key)) invalid('graph scratch reference');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) invalid('graph scratch reference');
      result[key] = descriptor.value;
    }
    intakeTreeRef(result);
    return result as unknown as IntakeTreeRef;
  }
  const row = <T extends object>(value: T): T =>
    live ? Object.assign(Object.create(null), value) : value;
  let stackDepth = 0;
  const counts = { seenReads: 0, seenWrites: 0, nestedWrites: 0, copyWrites: 0 };
  const key = (hash: string, kind: IntakeGraphCopyKind, context = '') =>
    kind + ':' + hash + ':' + context;
  function read<T>(table: string, key: string): T | undefined {
    const value = storage.map(table).get(key);
    if (value === undefined) return undefined;
    if (typeof value === 'string') return JSON.parse(value) as T;
    if (value.bytes > INTAKE_TREE_PAGE_BYTES) invalid('graph scratch row bytes');
    return JSON.parse(storage.readScalarRange(value, 0, value.bytes).toString('utf8')) as T;
  }
  function write(table: string, key: string, value: unknown) {
    const raw = JSON.stringify(value),
      bytes = Buffer.from(raw);
    if (bytes.length > INTAKE_TREE_PAGE_BYTES) invalid('graph scratch row bytes');
    storage.map(table).set(key, bytes.length <= 8192 ? raw : storage.writeScalar([bytes]));
  }
  return {
    directory: storage.directory,
    seen(hash: string, kind: IntakeGraphKind) {
      return data(() => {
        if (live) {
          checkedHash(hash);
          checkedKind(kind);
        }
        counts.seenReads++;
        recordIntakeWork('graphScratchSeenReads');
        return read<Summary>('seen', key(hash, kind));
      }, true);
    },
    remember(ref: IntakeTreeRef, kind: IntakeGraphKind, bytes: number, maxSequence: number) {
      return data(() => {
        ref = reference(ref);
        if (live) {
          checkedKind(kind);
          integer(bytes);
          integer(maxSequence);
        }
        write('seen', key(ref.hash, kind), row({ ref, bytes, maxSequence }));
        counts.seenWrites++;
        recordIntakeWork('graphScratchSeenWrites');
      }, true);
    },
    nested(hash: string, kind: IntakeGraphKind) {
      return data(() => {
        if (live) {
          checkedHash(hash);
          checkedKind(kind);
        }
        return read<Nested>('nested', key(hash, kind));
      }, true);
    },
    enqueue(ref: IntakeTreeRef, kind: IntakeGraphKind, bytes: number) {
      return data(() => {
        ref = reference(ref);
        if (live) {
          checkedKind(kind);
          integer(bytes);
        }
        const cellKey = key(ref.hash, kind);
        if (read<Nested>('nested', cellKey)) return;
        const work = row({ ref, kind, bytes });
        write('nested', cellKey, work);
        write('pending', cellKey, work);
        counts.nestedWrites++;
        recordIntakeWork('graphScratchNestedWrites');
      }, true);
    },
    nextNested() {
      return data(() => {
        const first = storage.map('pending').scan({ items: 1, scanned: 1 }).entries[0];
        return first ? read<Nested>('pending', first.key) : undefined;
      }, true);
    },
    finishNested(ref: IntakeTreeRef, kind: IntakeGraphKind) {
      return data(() => {
        ref = reference(ref);
        if (live) checkedKind(kind);
        storage.map('pending').delete(key(ref.hash, kind));
      }, true);
    },
    copied(hash: string, kind: IntakeGraphCopyKind, context = '') {
      return data(() => read<Copied>('copied', key(hash, kind, context)));
    },
    rememberCopy(
      hash: string,
      kind: IntakeGraphCopyKind,
      context: string,
      ref: IntakeTreeRef,
      bytes: number,
    ) {
      return data(() => {
        write('copied', key(hash, kind, context), { ref, bytes });
        counts.copyWrites++;
        recordIntakeWork('graphScratchCopyWrites');
      });
    },
    push(
      ref: IntakeTreeRef,
      kind: IntakeGraphCopyKind,
      context: string,
      builds: IntakeTreeRoot = null,
    ) {
      return data(() => {
        const cellKey = key(ref.hash, kind, context);
        if (storage.map('active').get(cellKey) !== undefined)
          invalid('cyclic referenced collection');
        if (!Number.isSafeInteger(stackDepth + 1)) invalid('graph copy stack range');
        write('stack', ordered(++stackDepth), { ref, kind, context, builds });
        storage.map('active').set(cellKey, '1');
      });
    },
    top() {
      return data(() => (stackDepth ? read<Work>('stack', ordered(stackDepth)) : undefined));
    },
    pop() {
      return data(() => {
        const work = read<Work>('stack', ordered(stackDepth));
        if (!work) invalid('missing graph copy work');
        storage.map('active').delete(key(work.ref.hash, work.kind, work.context));
        storage.map('stack').delete(ordered(stackDepth--));
      });
    },
    stats: () => ({ ...counts, ...storage.stats() }),
    close,
  };
}
