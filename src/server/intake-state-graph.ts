/** Cold, bounded-memory validation/rebinding for selected collection graphs. */
import { randomUUID } from 'node:crypto';
import {
  createIntakeGraphScratch,
  type IntakeGraphKind as Kind,
  type IntakeGraphCopyKind as CopyKind,
} from './intake-state-graph-scratch.ts';
import { IntakeStateManifest } from './intake-state-manifest.ts';
import { validateIntakeLegacyBridgeControl } from './intake-state-migration.ts';
import {
  prepareIntakeLegacyReplaySteps,
  type PreparedIntakeLegacyReplay,
} from './intake-state-legacy-replay.ts';
import {
  COLLECTION_FORMAT,
  LOG_COLLECTION_FORMAT,
  FRAME_BYTES,
  HEAD_BYTES,
  limits,
  parseIntakeHead,
  type Head,
  digest,
  integer,
  invalid,
  intakeNamespace,
  parseIntakeCollectionHead,
  parseIntakeCollectionHeadV4,
  uuid,
  type IntakeCollectionHead,
  type IntakeCollectionHeadV4,
  type IntakeStateIdentity,
} from './intake-state-evidence.ts';
import { INTAKE_TREE_PAGE_BYTES } from './intake-state-tree.ts';
import {
  parseIntakeCollectionReceipt,
  parseIntakeCollectionHistory,
  parseIntakeCollectionDescriptor,
  parseIntakeStoredValue,
  type IntakeCollectionDescriptor,
} from './intake-state-collections.ts';
import {
  createIntakeTree,
  decodeIntakeTreeNode,
  type IntakeTreeRoot,
  type IntakeTreeRef,
} from './intake-state-tree.ts';
import { finishIntakeCopySteps } from './intake-copy-work.ts';
import {
  CAPS as LOG_CAPS,
  intakeLogBaseHead,
  rebuildIntakeLogSnapshotSteps,
  disposeIntakeLogSnapshot,
  rebindIntakeLogSteps,
} from './intake-state-log.ts';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ordered = (n: number) => String(n).padStart(16, '0');
type GraphManifest = Pick<IntakeStateManifest, 'sourceValue' | 'put'> &
  Partial<Pick<IntakeStateManifest, 'db'>>;

/** Live cold admission uses invocation-local authenticated encrypted graph work.
 * Copy/recovery also validate exact namespace membership through their manifest.
 */
export function* validateIntakeCollectionGraphSteps(
  identity: IntakeStateIdentity,
  rawHead: string,
  read: (key: string, maxBytes: number) => string | undefined,
  checkpoint: () => void,
): Generator<void, void> {
  const manifest: GraphManifest = {
    sourceValue(key, maxBytes) {
      checkpoint();
      const raw = read(key, maxBytes);
      checkpoint();
      if (raw !== undefined && Buffer.byteLength(raw) > maxBytes)
        invalid('selected graph value bytes');
      return raw;
    },
    put() {
      invalid('live graph validation cannot prepare copy evidence');
    },
  };
  yield* inspectGraphSteps(true, manifest, identity, rawHead, undefined, checkpoint);
  checkpoint();
}

export function inspectIntakeCollectionGraph(
  manifest: GraphManifest,
  identity: IntakeStateIdentity,
  rawHead: string,
  targetProfileId?: string,
  checkpoint: () => void = () => {},
  validateRepresentation?: (
    head: IntakeCollectionHead,
    legacy: PreparedIntakeLegacyReplay | undefined,
  ) => void,
  copyInventory?: Parameters<typeof inspectIntakeCollectionGraphSteps>[6],
): void {
  finishIntakeCopySteps(
    inspectIntakeCollectionGraphSteps(
      manifest,
      identity,
      rawHead,
      targetProfileId,
      checkpoint,
      validateRepresentation
        ? function* (head, legacy) {
            validateRepresentation(head, legacy);
          }
        : undefined,
      copyInventory,
    ),
  );
}

export function* inspectIntakeCollectionGraphSteps(
  manifest: GraphManifest,
  identity: IntakeStateIdentity,
  rawHead: string,
  targetProfileId?: string,
  checkpoint: () => void = () => {},
  validateRepresentation?: (
    head: IntakeCollectionHead,
    legacyValue: PreparedIntakeLegacyReplay | undefined,
  ) => Generator<void, void>,
  copyInventory?: (
    text: string,
    key: string,
    sourceCollection: (name: string) => IntakeCollectionDescriptor | null,
    rebindDescriptor: (descriptor: IntakeCollectionDescriptor) => IntakeCollectionDescriptor,
  ) => string,
): Generator<void, void> {
  yield* inspectGraphSteps(
    false,
    manifest,
    identity,
    rawHead,
    targetProfileId,
    checkpoint,
    validateRepresentation,
    copyInventory,
  );
}

/** Only live admission coalesces private fixed summary work. Generic inspect
 * and copy retain their original per-cell cancellation/progress schedule. */
function* inspectGraphSteps(
  liveSummaryChecks: boolean,
  ...args: Parameters<typeof inspectIntakeCollectionGraphSteps>
): Generator<void, void> {
  const [
    manifest,
    identity,
    rawHead,
    targetProfileId,
    checkpoint = () => {},
    validateRepresentation,
    copyInventory,
  ] = args;
  const db = manifest.db,
    prefix = intakeNamespace(identity);
  let legacyReplay: PreparedIntakeLegacyReplay | undefined;
  const scratch = createIntakeGraphScratch(identity, rawHead, checkpoint, { liveSummaryChecks });
  let failed = false;
  try {
    const markStatement = db?.prepare('INSERT OR IGNORE INTO visited VALUES(?)');
    const markVisited = (key: string) => markStatement?.run(key);
    const source = (sha: string) =>
      manifest.sourceValue(prefix + 'node:' + sha, INTAKE_TREE_PAGE_BYTES);
    const selected = parseIntakeCollectionHead(rawHead, identity)!;
    const logSource = (sha: string) => {
      const key = prefix + 'node:' + sha;
      markVisited(key);
      return manifest.sourceValue(key, LOG_CAPS.nodeBytes);
    };
    const base =
      selected.format === LOG_COLLECTION_FORMAT
        ? intakeLogBaseHead(selected, identity, logSource)
        : selected;
    // The immutable anchor already authenticates the complete canonical indexes.
    // Look up historical agreement/absence there instead of retaining duplicate
    // heads, receipts and transition inventories in disposable storage.
    const canonical = createIntakeTree(identity, source, new Map());
    const canonicalHistory = (sequence: number) =>
      base ? canonical.get(base.history, ordered(sequence)) : undefined;
    const canonicalReceipt = (operationId: string) =>
      base ? canonical.get(base.receipts, operationId) : undefined;
    function headAt(sequence: number): IntakeCollectionHeadV4 {
      if (!base || sequence < 1 || sequence > base.storageSequence)
        invalid('historical head sequence');
      if (sequence === base.storageSequence) return base;
      const next = canonicalHistory(sequence + 1);
      if (!next) invalid('missing historical transition');
      const previous = parseIntakeCollectionHistory(next, identity).previous;
      const head = parseIntakeCollectionHeadV4(JSON.stringify(previous), identity)!;
      if (head.storageSequence !== sequence) invalid('conflicting historical selection');
      return head;
    }
    let legacyHead: Head | undefined;
    let legacyDomainVersion: number | undefined;
    function legacyPrevious(previous: unknown): Head | undefined {
      if (
        !previous ||
        typeof previous !== 'object' ||
        Reflect.get(previous, 'format') !== 'health-intake-legacy-v3'
      )
        return undefined;
      return parseIntakeHead(JSON.stringify(Reflect.get(previous, 'head')), identity, limits());
    }
    function* validateLegacy(head: Head): Generator<void, void> {
      if (legacyHead) {
        if (!same(legacyHead, head)) invalid('conflicting legacy bridge');
        return;
      }
      legacyReplay = yield* prepareIntakeLegacyReplaySteps(
        identity,
        limits(),
        head,
        (key) => manifest.sourceValue(key, key.includes(':frame:') ? FRAME_BYTES : HEAD_BYTES),
        {
          // Live replay's encrypted owner already supplies this exact full
          // policy at every state/per-cell boundary. Generic copy keeps its
          // separate checkpoint/progress schedule unchanged.
          checkpoint: liveSummaryChecks ? undefined : checkpoint,
          // The legacy ancestor is evidence beneath this exact outer V4/V5
          // selection. All transitive replay/canonical scratch shares its seal.
          encryptedScratch: { selectedHead: rawHead, assertCurrent: checkpoint },
          liveCanonicalPointChecks: liveSummaryChecks,
        },
      );
      for (const key of legacyReplay.consumed()) {
        markVisited(key);
        yield;
      }
      legacyDomainVersion = yield* legacyReplay.domainVersionSteps();
      legacyHead = head;
    }
    let depth = 0;
    function* walk(ref: IntakeTreeRoot, kind: Kind): Generator<void, number> {
      checkpoint();
      yield;
      if (!ref) return 0;
      // Directory, value and attached-byte AVL frontiers each have height at most 64.
      if (++depth > 192) invalid('collection graph traversal depth');
      try {
        // Always decode each incoming reference, even when the subtree was already visited.
        const node = decodeIntakeTreeNode(source(ref.hash), ref, identity);
        const seen = scratch.seen(ref.hash, kind);
        if (seen) {
          if (!same(seen.ref, ref)) invalid('historical reference disagreement');
          return Number(seen.bytes);
        }
        markVisited(prefix + 'node:' + ref.hash);
        let ownBytes = Buffer.byteLength(node.value);
        let maxSequence = 0;
        if (kind === 'directory') {
          if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(node.key)) invalid('collection name');
          const descriptor = parseIntakeCollectionDescriptor(node.value)!;
          const bytes = yield* walk(descriptor.root, descriptor.kind);
          if (bytes !== descriptor.bytes) invalid('collection byte summary');
          if (
            descriptor.kind !== 'map' &&
            descriptor.root &&
            (descriptor.root.first !== ordered(0) ||
              descriptor.root.last !== ordered(descriptor.root.count - 1))
          )
            invalid('collection sequence coverage');
        } else if (kind === 'map' || kind === 'sequence') {
          const value = parseIntakeStoredValue(node.value);
          ownBytes =
            value.kind === 'inline'
              ? Buffer.byteLength(value.text)
              : value.kind === 'collection'
                ? Buffer.byteLength(JSON.stringify(value.descriptor))
                : yield* walk(value.root, 'bytes');
          if (value.kind === 'collection') {
            const descriptor = value.descriptor;
            if (!descriptor.root) {
              if (descriptor.bytes !== 0) invalid('empty referenced collection bytes');
            } else {
              const prior = scratch.nested(descriptor.root.hash, descriptor.kind);
              if (prior && (!same(prior.ref, descriptor.root) || prior.bytes !== descriptor.bytes))
                invalid('referenced collection disagreement');
              scratch.enqueue(descriptor.root, descriptor.kind, descriptor.bytes);
            }
          }
          if (value.kind === 'bytes') {
            if (ownBytes !== value.bytes) invalid('attached byte summary');
            if (
              value.root &&
              (value.root.first !== ordered(0) || value.root.last !== ordered(value.root.count - 1))
            )
              invalid('attached byte sequence coverage');
          }
        } else if (kind === 'bytes') {
          const bytes = Buffer.from(node.value, 'base64');
          if (!bytes.length || bytes.length > 4096 || bytes.toString('base64') !== node.value)
            invalid('byte chunk encoding');
          ownBytes = bytes.length;
        } else if (kind === 'receipts') {
          uuid(node.key);
          const value = parseIntakeCollectionReceipt(node.value, identity, node.key);
          const result = value.result;
          maxSequence = result.storageSequence;
          if (result.storageSequence > selected.storageSequence)
            invalid('future collection receipt');
          yield* walk(result.logical.root, 'directory');
          if (canonicalReceipt(node.key) !== node.value) invalid('conflicting historical receipt');
        } else {
          const value = parseIntakeCollectionHistory(node.value, identity);
          const sequence = Number(node.key);
          maxSequence = sequence;
          integer(sequence, 1);
          if (node.key !== ordered(sequence) || sequence > selected.storageSequence)
            invalid('history sequence');
          const legacy = legacyPrevious(value.previous);
          const previous = !legacy ? (value.previous as IntakeCollectionHeadV4 | null) : null;
          if (legacy) {
            if (sequence !== 1) invalid('legacy bridge sequence');
            yield* validateLegacy(legacy);
            if (value.logical.domainVersion !== legacyDomainVersion || value.builds !== null)
              invalid('legacy bridge domain agreement');
          }
          if ((previous?.storageSequence ?? 0) !== sequence - 1)
            invalid('history previous sequence');
          if (previous && !same(previous, headAt(sequence - 1)))
            invalid('conflicting historical selection');
          if (Number(value.logical.domainVersion) < (previous?.logical.domainVersion ?? 0))
            invalid('history domain version');
          yield* walk(value.logical.root as IntakeTreeRoot, 'directory');
          yield* walk(value.builds as IntakeTreeRoot, 'directory');
          if (canonicalHistory(sequence) !== node.value)
            invalid('conflicting historical transition');
        }
        if (kind === 'bytes' || kind === 'sequence') {
          const index = Number(node.key);
          integer(index);
          if (node.key !== ordered(index)) invalid('sequence key');
        }
        const bytes = (yield* walk(node.left, kind)) + ownBytes + (yield* walk(node.right, kind));
        integer(bytes);
        for (const child of [node.left, node.right])
          if (child)
            maxSequence = Math.max(maxSequence, scratch.seen(child.hash, kind)!.maxSequence);
        scratch.remember(ref, kind, bytes, maxSequence);
        return bytes;
      } finally {
        depth--;
      }
    }
    for (let sequence = base?.storageSequence ?? 0; sequence >= 1; sequence--) {
      const head = headAt(sequence);
      yield* walk(head.logical.root, 'directory');
      yield* walk(head.builds, 'directory');
      yield* walk(head.receipts, 'receipts');
      yield* walk(head.history, 'history');
      if (head.storageSequence === 1 && legacyHead)
        validateIntakeLegacyBridgeControl(identity, head, source);
      for (const [ref, kind] of [
        [head.receipts, 'receipts'],
        [head.history, 'history'],
      ] as const) {
        if (!ref || scratch.seen(ref.hash, kind)!.maxSequence > head.storageSequence)
          invalid('historical future evidence');
      }
      if (head.history?.first !== ordered(1) || head.history.last !== ordered(head.storageSequence))
        invalid('historical sequence coverage');
      const eventRow = canonicalHistory(head.storageSequence);
      if (!eventRow) invalid('missing historical transition');
      const event = JSON.parse(eventRow);
      if (!same(event.logical, head.logical) || !same(event.builds, head.builds))
        invalid('historical selection agreement');
    }
    if (selected.format === LOG_COLLECTION_FORMAT) {
      const verification = rebuildIntakeLogSnapshotSteps(rawHead, identity, logSource, {
        assertCurrent: checkpoint,
        lookupBaseOperation(head, operationId) {
          if (!base || !same(head, base)) invalid('log base selection disagreement');
          const receipt = createIntakeTree(identity, source, new Map()).get(
            base.receipts,
            operationId,
          );
          return receipt === undefined
            ? { kind: 'absent' }
            : {
                kind: 'receipt',
                identity,
                receipt: parseIntakeCollectionReceipt(receipt, identity, operationId),
              };
        },
        *onEventSteps(event) {
          // The codec authenticates each full previous head and transition. The
          // collection owner authenticates all referenced graphs, including roots
          // that no longer occur in the selected logical/build view.
          yield* walk(event.transition.previous.logical.root, 'directory');
          yield* walk(event.transition.previous.builds, 'directory');
          yield* walk(event.receipt.result.logical.root, 'directory');
          yield* walk(event.transition.builds, 'directory');
        },
      });
      try {
        for (;;) {
          const next = verification.next();
          if (next.done) {
            disposeIntakeLogSnapshot(next.value);
            break;
          }
          yield;
        }
      } finally {
        verification.return(undefined as never);
      }
    }
    for (;;) {
      const next = scratch.nextNested();
      if (!next) break;
      const { ref, kind } = next;
      if ((yield* walk(ref, kind)) !== next.bytes) invalid('referenced collection byte summary');
      if (kind !== 'map' && (ref.first !== ordered(0) || ref.last !== ordered(ref.count - 1)))
        invalid('referenced collection sequence coverage');
      scratch.finishNested(ref, kind);
    }
    // Root counts are checked by the V4 head parser. Every history key is in
    // 1..sequence, and each receipt below must bind that distinct sequence;
    // together these prove exact canonical history/receipt membership.
    for (let sequence = 1; sequence <= (base?.storageSequence ?? 0); sequence++) {
      yield;
      const rawEvent = canonicalHistory(sequence);
      if (!rawEvent) invalid('historical evidence coverage');
      const event = JSON.parse(rawEvent);
      const rawReceipt = canonicalReceipt(event.operationId);
      if (!rawReceipt) invalid('missing historical receipt');
      const result = JSON.parse(rawReceipt).result;
      if (
        result.storageSequence !== sequence ||
        !same(result.logical, event.logical) ||
        result.changed !==
          (legacyPrevious(event.previous)
            ? false
            : !same(event.logical.root, event.previous?.logical.root ?? null))
      )
        invalid('receipt history agreement');
    }
    markVisited(prefix + 'head');
    if (
      db
        ?.prepare(
          'SELECT 1 FROM source LEFT JOIN visited ON source.key=visited.key WHERE source.prefix=? AND visited.key IS NULL LIMIT 1',
        )
        .get(prefix)
    )
      invalid('unselected copy contribution');
    if (validateRepresentation) {
      yield* validateRepresentation(selected, legacyReplay);
      // External representation work can yield or revoke its source scope.
      // Seal that boundary before validation succeeds or copying starts.
      checkpoint();
    }
    if (!targetProfileId) return;
    if (!db) invalid('copy graph requires a manifest');
    const preparedValue = db.prepare('SELECT value FROM prepared WHERE key=?');
    const target = { ...identity, profileId: targetProfileId },
      targetPrefix = intakeNamespace(target);
    const context = (kind: CopyKind, builds: IntakeTreeRoot) =>
      kind === 'inventory' || kind === 'build-directory' ? (builds?.hash ?? 'empty') : '';
    const copiedBytes = (
      ref: IntakeTreeRoot,
      kind: CopyKind,
      builds: IntakeTreeRoot = selected.builds,
    ) => (ref ? scratch.copied(ref.hash, kind, context(kind, builds))!.bytes : 0);
    function rebindDescriptor(descriptor: IntakeCollectionDescriptor): IntakeCollectionDescriptor {
      const copied = descriptor.root
        ? scratch.copied(descriptor.root.hash, descriptor.kind)
        : undefined;
      if (descriptor.root && !copied) throw new CopyDependency(descriptor.root, descriptor.kind);
      return {
        ...descriptor,
        root: copied?.ref ?? null,
        bytes: copiedBytes(descriptor.root, descriptor.kind),
      };
    }
    const sourceCollection = (builds: IntakeTreeRoot, name: string) =>
      parseIntakeCollectionDescriptor(
        createIntakeTree(identity, source, new Map()).get(builds, name),
      ) ?? null;
    class CopyDependency extends Error {
      readonly ref: IntakeTreeRef;
      readonly kind: CopyKind;
      readonly builds: IntakeTreeRoot;
      constructor(ref: IntakeTreeRef, kind: CopyKind, builds: IntakeTreeRoot = selected.builds) {
        super('referenced collection copy dependency');
        this.ref = ref;
        this.kind = kind;
        this.builds = builds;
      }
    }
    let reboundLegacyHead: Head | undefined;
    function copiedRoot(
      ref: IntakeTreeRoot,
      kind: CopyKind,
      builds = selected.builds,
    ): IntakeTreeRoot {
      if (!ref) return null;
      const row = scratch.copied(ref.hash, kind, context(kind, builds));
      if (!row) throw new CopyDependency(ref, kind, builds);
      return row.ref;
    }
    function copiedHead(head: IntakeCollectionHeadV4): IntakeCollectionHeadV4 {
      return {
        ...head,
        identity: target,
        logical: { ...head.logical, root: copiedRoot(head.logical.root, 'directory') },
        builds: copiedRoot(head.builds, 'build-directory', head.builds),
        receipts: copiedRoot(head.receipts, 'receipts'),
        history: copiedRoot(head.history, 'history'),
      };
    }
    function* rebindSelected(
      ref: IntakeTreeRoot,
      kind: CopyKind,
      builds = selected.builds,
    ): Generator<void, IntakeTreeRoot> {
      if (!ref) return null;
      scratch.push(ref, kind, context(kind, builds), builds);
      let result: IntakeTreeRoot = null;
      for (;;) {
        const next = scratch.top();
        if (!next) return result;
        try {
          result = yield* rebind(next.ref, next.kind, next.builds);
          scratch.pop();
        } catch (error) {
          if (!(error instanceof CopyDependency)) throw error;
          scratch.push(error.ref, error.kind, context(error.kind, error.builds), error.builds);
        }
      }
    }
    function* rebind(
      ref: IntakeTreeRoot,
      kind: CopyKind,
      builds: IntakeTreeRoot,
    ): Generator<void, IntakeTreeRoot> {
      checkpoint();
      yield;
      if (!ref) return null;
      const old = scratch.copied(ref.hash, kind, context(kind, builds));
      if (old) return old.ref;
      const node = decodeIntakeTreeNode(source(ref.hash), ref, identity);
      const left = yield* rebind(node.left, kind, builds),
        right = yield* rebind(node.right, kind, builds);
      let value = node.value;
      if (kind === 'directory' || kind === 'build-directory') {
        const descriptor = parseIntakeCollectionDescriptor(value)!;
        const childKind =
          kind === 'build-directory' && node.key === 'package.inventories' && copyInventory
            ? 'inventory'
            : descriptor.kind;
        if (childKind === 'inventory' && descriptor.kind !== 'map')
          invalid('inventory registry collection kind');
        value = JSON.stringify({
          ...descriptor,
          root: yield* rebind(descriptor.root, childKind, builds),
          bytes: copiedBytes(descriptor.root, childKind, builds),
        });
      } else if (kind === 'map' || kind === 'sequence' || kind === 'inventory') {
        const stored = parseIntakeStoredValue(value);
        if (kind === 'inventory') {
          if (stored.kind !== 'inline') invalid('inventory registry value');
          value = JSON.stringify({
            kind: 'inline',
            text: copyInventory!(
              stored.text,
              node.key,
              (name) => sourceCollection(builds, name),
              (descriptor) => {
                try {
                  return rebindDescriptor(descriptor);
                } catch (error) {
                  if (error instanceof CopyDependency)
                    throw new CopyDependency(error.ref, error.kind, builds);
                  throw error;
                }
              },
            ),
          });
        }
        if (stored.kind === 'bytes')
          value = JSON.stringify({ ...stored, root: yield* rebind(stored.root, 'bytes', builds) });
        else if (stored.kind === 'collection') {
          const descriptor = stored.descriptor;
          if (descriptor.root && !scratch.copied(descriptor.root.hash, descriptor.kind))
            throw new CopyDependency(descriptor.root, descriptor.kind, builds);
          value = JSON.stringify({ ...stored, descriptor: rebindDescriptor(descriptor) });
        }
      } else if (kind === 'receipts') {
        const receipt = parseIntakeCollectionReceipt(value, identity, node.key);
        value = JSON.stringify({
          ...receipt,
          result: {
            ...receipt.result,
            logical: {
              ...receipt.result.logical,
              root: yield* rebind(receipt.result.logical.root, 'directory', builds),
            },
          },
        });
      } else if (kind === 'history') {
        const event = parseIntakeCollectionHistory(value, identity),
          legacy = legacyPrevious(event.previous);
        if (legacy && !reboundLegacyHead) invalid('missing rebound legacy bridge');
        value = JSON.stringify({
          ...event,
          previous: legacy
            ? { format: 'health-intake-legacy-v3', head: reboundLegacyHead }
            : event.previous
              ? copiedHead(event.previous as IntakeCollectionHeadV4)
              : null,
          logical: {
            ...event.logical,
            root: yield* rebind(event.logical.root, 'directory', builds),
          },
          builds: yield* rebind(event.builds, 'build-directory', event.builds),
        });
      }
      const raw = JSON.stringify({ ...node, identity: target, value, left, right });
      const result = { ...ref, hash: digest(raw) };
      decodeIntakeTreeNode(raw, result, target);
      // Shared subtrees may be referenced by more than one collection.
      const key = targetPrefix + 'node:' + result.hash;
      const existing = preparedValue.get(key);
      if (existing && existing.value !== raw) invalid('copy graph conflict');
      if (!existing) manifest.put('prepared', key, raw);
      let ownBytes = Buffer.byteLength(value);
      if (kind === 'map' || kind === 'sequence' || kind === 'inventory') {
        const stored = parseIntakeStoredValue(value);
        ownBytes =
          stored.kind === 'inline'
            ? Buffer.byteLength(stored.text)
            : stored.kind === 'collection'
              ? Buffer.byteLength(JSON.stringify(stored.descriptor))
              : stored.bytes;
      } else if (kind === 'bytes') ownBytes = Buffer.from(value, 'base64').length;
      scratch.rememberCopy(
        ref.hash,
        kind,
        context(kind, builds),
        result,
        ownBytes + copiedBytes(node.left, kind, builds) + copiedBytes(node.right, kind, builds),
      );
      return result;
    }
    if (selected.format === LOG_COLLECTION_FORMAT) {
      if (legacyHead) {
        if (!legacyReplay) invalid('missing copy legacy value');
        reboundLegacyHead = yield* legacyReplay.rebindSteps(target, (key, value) =>
          manifest.put('prepared', key, value),
        );
      }
      const rebinding = rebindIntakeLogSteps(rawHead, identity, logSource, target, {
        assertCurrent: checkpoint,
        lookupBaseOperation(head, operationId) {
          if (!base || !same(head, base)) invalid('log base selection disagreement');
          const receipt = createIntakeTree(identity, source, new Map()).get(
            base.receipts,
            operationId,
          );
          return receipt === undefined
            ? { kind: 'absent' }
            : {
                kind: 'receipt',
                identity,
                receipt: parseIntakeCollectionReceipt(receipt, identity, operationId),
              };
        },
        *rebindBaseSteps() {
          // Earlier V4 selections must be rebound first: transition values retain
          // their complete previous head, including its receipt/history roots.
          for (let sequence = 1; sequence <= base!.storageSequence; sequence++) {
            const head = headAt(sequence);
            yield* rebindSelected(head.logical.root, 'directory', head.builds);
            yield* rebindSelected(head.builds, 'build-directory', head.builds);
            yield* rebindSelected(head.receipts, 'receipts', head.builds);
            yield* rebindSelected(head.history, 'history', head.builds);
          }
          return JSON.stringify(copiedHead(base!));
        },
        *rebindEventSteps(event) {
          return {
            logical: {
              ...event.receipt.result.logical,
              root: yield* rebindSelected(
                event.receipt.result.logical.root,
                'directory',
                event.transition.builds,
              ),
            },
            builds: yield* rebindSelected(
              event.transition.builds,
              'build-directory',
              event.transition.builds,
            ),
          };
        },
        write(hash, raw) {
          const key = targetPrefix + 'node:' + hash,
            existing = preparedValue.get(key);
          if (existing && existing.value !== raw) invalid('copy log conflict');
          if (!existing) manifest.put('prepared', key, raw);
        },
      });
      try {
        for (;;) {
          const next = rebinding.next();
          if (next.done) {
            manifest.put('prepared', targetPrefix + 'head', next.value);
            break;
          }
          yield;
        }
      } finally {
        rebinding.return(undefined as never);
      }
      return;
    }
    const logical = {
      ...selected.logical,
      root: yield* rebindSelected(selected.logical.root, 'directory'),
    };
    const builds = yield* rebindSelected(selected.builds, 'build-directory');
    let previous: IntakeCollectionHead | { format: 'health-intake-legacy-v3'; head: Head } | null =
      null;
    let receiptRoot: IntakeTreeRoot = null,
      historyRoot: IntakeTreeRoot = null,
      sequence = 1;
    const pages = createIntakeTree(
      target,
      (hash) => preparedValue.get(targetPrefix + 'node:' + hash)?.value,
      new Map(),
    );
    if (legacyHead) {
      if (!legacyReplay) invalid('missing copy legacy value');
      const rebound = yield* legacyReplay.rebindSteps(target, (key, value) =>
        manifest.put('prepared', key, value),
      );
      previous = { format: 'health-intake-legacy-v3', head: rebound };
      const first = headAt(1);
      const bridgeLogical = {
        ...first.logical,
        root: yield* rebindSelected(first.logical.root, 'directory'),
      };
      const bridgeOperation = randomUUID();
      const bridgeResult = {
        format: 'health-intake-state-result-v4',
        intakeId: target.intakeId,
        operationId: bridgeOperation,
        storageSequence: 1,
        logical: bridgeLogical,
        changed: false,
      };
      receiptRoot = pages.put(
        null,
        bridgeOperation,
        JSON.stringify({
          format: 'health-intake-state-receipt-v4',
          requestDigest: digest('bridge:' + rawHead),
          result: bridgeResult,
        }),
      );
      historyRoot = pages.put(
        null,
        ordered(1),
        JSON.stringify({
          format: 'health-intake-state-history-v4',
          operationId: bridgeOperation,
          previous,
          logical: bridgeLogical,
          builds: null,
        }),
      );
      previous = {
        format: COLLECTION_FORMAT,
        identity: target,
        storageSequence: 1,
        logical: bridgeLogical,
        receipts: receiptRoot,
        history: historyRoot,
        builds: null,
      };
      sequence = 2;
    }
    const operationId = randomUUID();
    const result = {
      format: 'health-intake-state-result-v4',
      intakeId: target.intakeId,
      operationId,
      storageSequence: sequence,
      logical,
      changed: !same(
        logical.root,
        previous && 'logical' in previous ? previous.logical.root : null,
      ),
    };
    const receipts = pages.put(
      receiptRoot,
      operationId,
      JSON.stringify({
        format: 'health-intake-state-receipt-v4',
        requestDigest: digest(rawHead),
        result,
      }),
    );
    const history = pages.put(
      historyRoot,
      ordered(sequence),
      JSON.stringify({
        format: 'health-intake-state-history-v4',
        operationId,
        previous,
        logical,
        builds,
      }),
    );
    for (const node of pages.writes([receipts, history, receiptRoot, historyRoot])) {
      manifest.put('prepared', targetPrefix + 'node:' + node.hash, node.raw);
      yield;
    }
    const head = JSON.stringify({
      format: COLLECTION_FORMAT,
      identity: target,
      storageSequence: sequence,
      logical,
      receipts,
      history,
      builds,
    });
    parseIntakeCollectionHead(head, target);
    manifest.put('prepared', targetPrefix + 'head', head);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    let cleanupFailed = false,
      cleanupError: unknown;
    try {
      legacyReplay?.close();
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
    try {
      scratch.close();
    } catch (error) {
      if (!cleanupFailed) {
        cleanupFailed = true;
        cleanupError = error;
      }
    }
    if (!failed && cleanupFailed) throw cleanupError;
  }
}
