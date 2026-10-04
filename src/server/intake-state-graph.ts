/** Cold, bounded-memory validation/rebinding for the existing v4 selected graph. */
import { randomUUID } from 'node:crypto';
import { applyIntakeChanges, serializeIntakeJson, type IntakeJson } from './intake-state-codec.ts';
import { IntakeStateManifest } from './intake-state-manifest.ts';
import {
  legacyIntakeEnvelopeDomainVersion,
  validateIntakeLegacyBridgeControl,
} from './intake-state-migration.ts';
import {
  COLLECTION_FORMAT,
  limits,
  budget,
  frameIntakeChanges,
  parseIntakeHead,
  reconstructIntakeEvidence,
  type Head,
  digest,
  integer,
  invalid,
  intakeNamespace,
  parseIntakeCollectionHead,
  uuid,
  type IntakeCollectionHead,
  type IntakeStateIdentity,
} from './intake-state-evidence.ts';
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

type Kind = 'directory' | 'map' | 'sequence' | 'bytes' | 'receipts' | 'history';
type CopyKind = Kind | 'inventory' | 'build-directory';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ordered = (n: number) => String(n).padStart(16, '0');

export function inspectIntakeCollectionGraph(
  manifest: IntakeStateManifest,
  identity: IntakeStateIdentity,
  rawHead: string,
  targetProfileId?: string,
  checkpoint: () => void = () => {},
  validateRepresentation?: (
    head: IntakeCollectionHead,
    legacyValue: IntakeJson | undefined,
  ) => void,
  copyInventory?: (
    text: string,
    key: string,
    sourceCollection: (name: string) => IntakeCollectionDescriptor | null,
    rebindDescriptor: (descriptor: IntakeCollectionDescriptor) => IntakeCollectionDescriptor,
  ) => string,
): void {
  const db = manifest.db,
    prefix = intakeNamespace(identity);
  db.exec(`DROP TABLE IF EXISTS graph_seen; DROP TABLE IF EXISTS graph_heads;
    DROP TABLE IF EXISTS graph_receipts; DROP TABLE IF EXISTS graph_history;
    DROP TABLE IF EXISTS graph_copy;
    DROP TABLE IF EXISTS graph_nested; DROP TABLE IF EXISTS graph_copy_stack;
    CREATE TABLE graph_seen(hash TEXT,kind TEXT,ref TEXT,bytes INTEGER,max_sequence INTEGER,PRIMARY KEY(hash,kind));
    CREATE TABLE graph_heads(sequence INTEGER PRIMARY KEY,raw TEXT NOT NULL,done INTEGER DEFAULT 0);
    CREATE INDEX graph_heads_pending ON graph_heads(done,sequence);
    CREATE TABLE graph_receipts(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE graph_history(sequence INTEGER PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE graph_copy(hash TEXT,kind TEXT,ref TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(hash,kind));`);
  db.exec(`CREATE TABLE graph_nested(hash TEXT,kind TEXT,ref TEXT NOT NULL,bytes INTEGER NOT NULL,done INTEGER DEFAULT 0,PRIMARY KEY(hash,kind));
    CREATE INDEX graph_nested_pending ON graph_nested(done);
    CREATE TABLE graph_copy_stack(position INTEGER PRIMARY KEY,hash TEXT,kind TEXT,ref TEXT NOT NULL,UNIQUE(hash,kind));`);
  const source = (sha: string) =>
    db.prepare('SELECT value FROM source WHERE key=?').get(prefix + 'node:' + sha)?.value;
  const selected = parseIntakeCollectionHead(rawHead, identity)!;
  function enqueue(head: IntakeCollectionHead): void {
    const raw = JSON.stringify(head);
    const previous = db
      .prepare('SELECT raw FROM graph_heads WHERE sequence=?')
      .get(head.storageSequence);
    if (previous && previous.raw !== raw) invalid('conflicting historical selection');
    db.prepare('INSERT OR IGNORE INTO graph_heads(sequence,raw) VALUES(?,?)').run(
      head.storageSequence,
      raw,
    );
  }
  let legacyHead: Head | undefined;
  let legacyValue: IntakeJson | undefined;
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
  function validateLegacy(head: Head): void {
    if (legacyHead) {
      if (!same(legacyHead, head)) invalid('conflicting legacy bridge');
      return;
    }
    const basis = reconstructIntakeEvidence(
      identity,
      limits(),
      head,
      (key) => db.prepare('SELECT value FROM source WHERE key=?').get(key)?.value,
      checkpoint,
    );
    for (const key of basis.consumed)
      db.prepare('INSERT OR IGNORE INTO visited VALUES(?)').run(key);
    legacyDomainVersion = legacyIntakeEnvelopeDomainVersion(basis.value);
    legacyHead = head;
    if (targetProfileId || validateRepresentation) legacyValue = basis.value;
  }
  let depth = 0;
  function walk(ref: IntakeTreeRoot, kind: Kind): number {
    checkpoint();
    if (!ref) return 0;
    // Directory, value and attached-byte AVL frontiers each have height at most 64.
    if (++depth > 192) invalid('collection graph traversal depth');
    try {
      // Always decode each incoming reference, even when the subtree was already visited.
      const node = decodeIntakeTreeNode(source(ref.hash), ref, identity);
      const seen = db
        .prepare('SELECT ref,bytes FROM graph_seen WHERE hash=? AND kind=?')
        .get(ref.hash, kind);
      if (seen) {
        if (seen.ref !== JSON.stringify(ref)) invalid('historical reference disagreement');
        return Number(seen.bytes);
      }
      db.prepare('INSERT OR IGNORE INTO visited VALUES(?)').run(prefix + 'node:' + ref.hash);
      let ownBytes = Buffer.byteLength(node.value);
      let maxSequence = 0;
      if (kind === 'directory') {
        if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(node.key)) invalid('collection name');
        const descriptor = parseIntakeCollectionDescriptor(node.value)!;
        const bytes = walk(descriptor.root, descriptor.kind);
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
              : walk(value.root, 'bytes');
        if (value.kind === 'collection') {
          const descriptor = value.descriptor;
          if (!descriptor.root) {
            if (descriptor.bytes !== 0) invalid('empty referenced collection bytes');
          } else {
            const prior = db
              .prepare('SELECT ref,bytes FROM graph_nested WHERE hash=? AND kind=?')
              .get(descriptor.root.hash, descriptor.kind);
            if (
              prior &&
              (prior.ref !== JSON.stringify(descriptor.root) || prior.bytes !== descriptor.bytes)
            )
              invalid('referenced collection disagreement');
            db.prepare(
              'INSERT INTO graph_nested(hash,kind,ref,bytes) VALUES(?,?,?,?) ON CONFLICT(hash,kind) DO NOTHING',
            ).run(
              descriptor.root.hash,
              descriptor.kind,
              JSON.stringify(descriptor.root),
              descriptor.bytes,
            );
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
        if (result.storageSequence > selected.storageSequence) invalid('future collection receipt');
        walk(result.logical.root, 'directory');
        const prior = db.prepare('SELECT value FROM graph_receipts WHERE id=?').get(node.key);
        if (prior && prior.value !== node.value) invalid('conflicting historical receipt');
        db.prepare('INSERT OR IGNORE INTO graph_receipts VALUES(?,?)').run(node.key, node.value);
      } else {
        const value = parseIntakeCollectionHistory(node.value, identity);
        const sequence = Number(node.key);
        maxSequence = sequence;
        integer(sequence, 1);
        if (node.key !== ordered(sequence) || sequence > selected.storageSequence)
          invalid('history sequence');
        const legacy = legacyPrevious(value.previous);
        const previous = !legacy ? (value.previous as IntakeCollectionHead | null) : null;
        if (legacy) {
          if (sequence !== 1) invalid('legacy bridge sequence');
          validateLegacy(legacy);
          if (value.logical.domainVersion !== legacyDomainVersion || value.builds !== null)
            invalid('legacy bridge domain agreement');
        }
        if ((previous?.storageSequence ?? 0) !== sequence - 1) invalid('history previous sequence');
        if (previous) enqueue(previous);
        if (Number(value.logical.domainVersion) < (previous?.logical.domainVersion ?? 0))
          invalid('history domain version');
        walk(value.logical.root as IntakeTreeRoot, 'directory');
        walk(value.builds as IntakeTreeRoot, 'directory');
        const prior = db.prepare('SELECT value FROM graph_history WHERE sequence=?').get(sequence);
        if (prior && prior.value !== node.value) invalid('conflicting historical transition');
        db.prepare('INSERT OR IGNORE INTO graph_history VALUES(?,?)').run(sequence, node.value);
      }
      if (kind === 'bytes' || kind === 'sequence') {
        const index = Number(node.key);
        integer(index);
        if (node.key !== ordered(index)) invalid('sequence key');
      }
      const bytes = walk(node.left, kind) + ownBytes + walk(node.right, kind);
      integer(bytes);
      for (const child of [node.left, node.right])
        if (child)
          maxSequence = Math.max(
            maxSequence,
            Number(
              db
                .prepare('SELECT max_sequence FROM graph_seen WHERE hash=? AND kind=?')
                .get(child.hash, kind)!.max_sequence,
            ),
          );
      db.prepare('INSERT INTO graph_seen VALUES(?,?,?,?,?)').run(
        ref.hash,
        kind,
        JSON.stringify(ref),
        bytes,
        maxSequence,
      );
      return bytes;
    } finally {
      depth--;
    }
  }
  enqueue(selected);
  for (;;) {
    const next = db
      .prepare('SELECT sequence,raw FROM graph_heads WHERE done=0 ORDER BY sequence DESC LIMIT 1')
      .get();
    if (!next) break;
    const head = parseIntakeCollectionHead(next.raw, identity)!;
    walk(head.logical.root, 'directory');
    walk(head.builds, 'directory');
    walk(head.receipts, 'receipts');
    walk(head.history, 'history');
    if (head.storageSequence === 1 && legacyHead)
      validateIntakeLegacyBridgeControl(identity, head, source);
    for (const [ref, kind] of [
      [head.receipts, 'receipts'],
      [head.history, 'history'],
    ] as const) {
      if (
        !ref ||
        Number(
          db
            .prepare('SELECT max_sequence FROM graph_seen WHERE hash=? AND kind=?')
            .get(ref.hash, kind)!.max_sequence,
        ) > head.storageSequence
      )
        invalid('historical future evidence');
    }
    if (head.history?.first !== ordered(1) || head.history.last !== ordered(head.storageSequence))
      invalid('historical sequence coverage');
    const eventRow = db
      .prepare('SELECT value FROM graph_history WHERE sequence=?')
      .get(head.storageSequence);
    if (!eventRow) invalid('missing historical transition');
    const event = JSON.parse(String(eventRow.value));
    if (!same(event.logical, head.logical) || !same(event.builds, head.builds))
      invalid('historical selection agreement');
    db.prepare('UPDATE graph_heads SET done=1 WHERE sequence=?').run(head.storageSequence);
  }
  for (;;) {
    const next = db
      .prepare('SELECT hash,kind,ref,bytes FROM graph_nested WHERE done=0 LIMIT 1')
      .get();
    if (!next) break;
    const ref = JSON.parse(String(next.ref)) as IntakeTreeRef,
      kind = String(next.kind) as Kind;
    if (walk(ref, kind) !== next.bytes) invalid('referenced collection byte summary');
    if (kind !== 'map' && (ref.first !== ordered(0) || ref.last !== ordered(ref.count - 1)))
      invalid('referenced collection sequence coverage');
    db.prepare('UPDATE graph_nested SET done=1 WHERE hash=? AND kind=?').run(next.hash, next.kind);
  }
  if (
    Number(db.prepare('SELECT count(*) n FROM graph_history').get()!.n) !==
      selected.storageSequence ||
    Number(db.prepare('SELECT count(*) n FROM graph_receipts').get()!.n) !==
      selected.storageSequence
  )
    invalid('historical evidence coverage');
  for (const row of db.prepare('SELECT sequence,value FROM graph_history').iterate()) {
    const event = JSON.parse(String(row.value));
    const receipt = db
      .prepare('SELECT value FROM graph_receipts WHERE id=?')
      .get(event.operationId);
    if (!receipt) invalid('missing historical receipt');
    const result = JSON.parse(String(receipt.value)).result;
    if (
      result.storageSequence !== row.sequence ||
      !same(result.logical, event.logical) ||
      result.changed !==
        (legacyPrevious(event.previous)
          ? false
          : !same(event.logical.root, event.previous?.logical.root ?? null))
    )
      invalid('receipt history agreement');
  }
  db.prepare('INSERT OR IGNORE INTO visited VALUES(?)').run(prefix + 'head');
  if (
    db
      .prepare(
        'SELECT 1 FROM source LEFT JOIN visited ON source.key=visited.key WHERE source.prefix=? AND visited.key IS NULL LIMIT 1',
      )
      .get(prefix)
  )
    invalid('unselected copy contribution');
  validateRepresentation?.(selected, legacyValue);
  if (!targetProfileId) return;
  const target = { ...identity, profileId: targetProfileId },
    targetPrefix = intakeNamespace(target);
  const copiedBytes = (ref: IntakeTreeRoot, kind: CopyKind) =>
    ref
      ? Number(
          db.prepare('SELECT bytes FROM graph_copy WHERE hash=? AND kind=?').get(ref.hash, kind)!
            .bytes,
        )
      : 0;
  function rebindDescriptor(descriptor: IntakeCollectionDescriptor): IntakeCollectionDescriptor {
    return {
      ...descriptor,
      root: rebind(descriptor.root, descriptor.kind),
      bytes: copiedBytes(descriptor.root, descriptor.kind),
    };
  }
  const sourceCollection = (name: string) =>
    parseIntakeCollectionDescriptor(
      createIntakeTree(identity, source, new Map()).get(selected.builds, name),
    ) ?? null;
  class CopyDependency extends Error {
    readonly ref: IntakeTreeRef;
    readonly kind: Kind;
    constructor(ref: IntakeTreeRef, kind: Kind) {
      super('referenced collection copy dependency');
      this.ref = ref;
      this.kind = kind;
    }
  }
  function rebindSelected(ref: IntakeTreeRoot, kind: CopyKind): IntakeTreeRoot {
    if (!ref) return null;
    db.prepare('INSERT INTO graph_copy_stack(hash,kind,ref) VALUES(?,?,?)').run(
      ref.hash,
      kind,
      JSON.stringify(ref),
    );
    let result: IntakeTreeRoot = null;
    for (;;) {
      const next = db
        .prepare('SELECT position,ref,kind FROM graph_copy_stack ORDER BY position DESC LIMIT 1')
        .get();
      if (!next) return result;
      try {
        result = rebind(
          JSON.parse(String(next.ref)) as IntakeTreeRef,
          String(next.kind) as CopyKind,
        );
        db.prepare('DELETE FROM graph_copy_stack WHERE position=?').run(next.position);
      } catch (error) {
        if (!(error instanceof CopyDependency)) throw error;
        if (
          db
            .prepare('SELECT 1 FROM graph_copy_stack WHERE hash=? AND kind=?')
            .get(error.ref.hash, error.kind)
        )
          invalid('cyclic referenced collection');
        db.prepare('INSERT INTO graph_copy_stack(hash,kind,ref) VALUES(?,?,?)').run(
          error.ref.hash,
          error.kind,
          JSON.stringify(error.ref),
        );
      }
    }
  }
  function rebind(ref: IntakeTreeRoot, kind: CopyKind): IntakeTreeRoot {
    checkpoint();
    if (!ref) return null;
    const old = db
      .prepare('SELECT ref FROM graph_copy WHERE hash=? AND kind=?')
      .get(ref.hash, kind);
    if (old) return JSON.parse(String(old.ref)) as IntakeTreeRef;
    const node = decodeIntakeTreeNode(source(ref.hash), ref, identity);
    const left = rebind(node.left, kind),
      right = rebind(node.right, kind);
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
        root: rebind(descriptor.root, childKind),
        bytes: copiedBytes(descriptor.root, childKind),
      });
    } else if (kind === 'map' || kind === 'sequence' || kind === 'inventory') {
      const stored = parseIntakeStoredValue(value);
      if (kind === 'inventory') {
        if (stored.kind !== 'inline') invalid('inventory registry value');
        value = JSON.stringify({
          kind: 'inline',
          text: copyInventory!(stored.text, node.key, sourceCollection, rebindDescriptor),
        });
      }
      if (stored.kind === 'bytes')
        value = JSON.stringify({ ...stored, root: rebind(stored.root, 'bytes') });
      else if (stored.kind === 'collection') {
        const descriptor = stored.descriptor;
        if (
          descriptor.root &&
          !db
            .prepare('SELECT 1 FROM graph_copy WHERE hash=? AND kind=?')
            .get(descriptor.root.hash, descriptor.kind)
        )
          throw new CopyDependency(descriptor.root, descriptor.kind);
        value = JSON.stringify({ ...stored, descriptor: rebindDescriptor(descriptor) });
      }
    }
    const raw = JSON.stringify({ ...node, identity: target, value, left, right });
    const result = { ...ref, hash: digest(raw) };
    decodeIntakeTreeNode(raw, result, target);
    // Shared subtrees may be referenced by more than one collection.
    const key = targetPrefix + 'node:' + result.hash;
    const existing = db.prepare('SELECT value FROM prepared WHERE key=?').get(key);
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
    db.prepare('INSERT INTO graph_copy VALUES(?,?,?,?)').run(
      ref.hash,
      kind,
      JSON.stringify(result),
      ownBytes + copiedBytes(node.left, kind) + copiedBytes(node.right, kind),
    );
    return result;
  }
  const logical = { ...selected.logical, root: rebindSelected(selected.logical.root, 'directory') };
  const builds = rebindSelected(selected.builds, 'build-directory');
  let previous: IntakeCollectionHead | { format: 'health-intake-legacy-v3'; head: Head } | null =
    null;
  let receiptRoot: IntakeTreeRoot = null,
    historyRoot: IntakeTreeRoot = null,
    sequence = 1;
  const pages = createIntakeTree(
    target,
    (hash) =>
      db.prepare('SELECT value FROM prepared WHERE key=?').get(targetPrefix + 'node:' + hash)
        ?.value,
    new Map(),
  );
  if (legacyHead) {
    if (legacyValue === undefined) invalid('missing copy legacy value');
    const caps = limits(),
      remaining = budget(caps, { bytes: 0, frames: 0, nodes: 0, operations: 0, stringWork: 0 });
    const changes = [{ op: 'set', path: [], value: legacyValue }];
    applyIntakeChanges(undefined, changes, remaining);
    const evidence = frameIntakeChanges(
      target,
      changes,
      digest(serializeIntakeJson(legacyValue)),
      randomUUID(),
      caps,
      undefined,
      remaining,
    );
    for (const frame of evidence.frames) manifest.put('prepared', frame.key, frame.serialized);
    manifest.put(
      'prepared',
      targetPrefix + 'operation:' + evidence.result.operationId,
      evidence.receipt,
    );
    previous = { format: 'health-intake-legacy-v3', head: evidence.head };
    const first = parseIntakeCollectionHead(
      db.prepare('SELECT raw FROM graph_heads WHERE sequence=1').get()!.raw,
      identity,
    )!;
    const bridgeLogical = {
      ...first.logical,
      root: rebindSelected(first.logical.root, 'directory'),
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
    changed: !same(logical.root, previous && 'logical' in previous ? previous.logical.root : null),
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
  for (const node of pages.writes([receipts, history, receiptRoot, historyRoot]))
    manifest.put('prepared', targetPrefix + 'node:' + node.hash, node.raw);
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
}
