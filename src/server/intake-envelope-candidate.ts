/** Disposable nonresumable construction. Only its creating collection owner can
 * enroll the sealed node roster in a real publication. */
import { createHash, createHmac, createSecretKey, randomBytes, type KeyObject } from 'node:crypto';
import { setImmediate as yieldHost } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { disposableSqlite } from './disposable-sqlite.ts';
import {
  createIntakeTree,
  decodeIntakeTreeNode,
  intakeTreeKey,
  INTAKE_TREE_VALUE_BYTES,
  type IntakeTreeCachedNode,
  type IntakeTreeRef,
  type IntakeTreeRoot,
} from './intake-state-tree.ts';
import { integer, invalid, type IntakeStateIdentity } from './intake-state-evidence.ts';
import {
  parseIntakeCollectionDescriptor,
  parseIntakeStoredValue,
  type IntakeByteValue,
  type IntakeCollectionChange,
  type IntakeCollectionDescriptor,
} from './intake-state-collections.ts';
import type { EnvelopeCellReader } from './intake-collection-envelope.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';

export interface PrivateEnvelopeNodeRoster {
  readonly count: number;
  readonly bytes: number;
  readonly digest: string;
  readonly effects: string;
  readonly descriptor: IntakeCollectionDescriptor;
  readonly nodePrefix: string;
  check(): void;
  rows(): Generator<{ hash: string; raw: string; ref: IntakeTreeRef }>;
  parts(): Generator<ReadonlyArray<{ hash: string; raw: string }>>;
}

const ordered = (value: number) => {
  integer(value);
  return String(value).padStart(16, '0');
};
const embedded = (raw: string): IntakeTreeRoot[] => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!value || typeof value !== 'object') return [];
  const kind = Reflect.get(value, 'kind');
  if (kind === 'map' || kind === 'sequence' || kind === 'bytes') {
    const descriptor = parseIntakeCollectionDescriptor(raw);
    return descriptor?.root ? [descriptor.root] : [];
  }
  if (kind === 'collection')
    return [
      (parseIntakeStoredValue(raw) as { descriptor: IntakeCollectionDescriptor }).descriptor.root,
    ];
  // An inline scalar's text is never interpreted as a graph edge.
  return [];
};
const valueBytes = (raw: string | undefined) => {
  if (raw === undefined) return 0;
  const value = parseIntakeStoredValue(raw);
  if (value.kind === 'inline') return Buffer.byteLength(value.text);
  if (value.kind === 'bytes') return value.bytes;
  return Buffer.byteLength(JSON.stringify(value.descriptor));
};

export type PrivateReaderCoverageRow =
  | { kind: 'transition'; sourceId: string; before: string; after: string }
  | {
      kind: 'effect';
      sourceId: string;
      after: string;
      effectKind: string;
      key: string;
      value: string;
    };

export function createPrivateEnvelopeCandidate(input: {
  db: DatabaseSync;
  nodePrefix: string;
  identity: IntakeStateIdentity;
  collection: string;
  descriptor: IntakeCollectionDescriptor;
  originalBuilds?: IntakeTreeRoot | null;
  readOriginal: (hash: string) => unknown;
  readOriginalDescriptor?: (area: 'logical' | 'builds', name: string) => string | undefined;
  assertOriginal: () => void;
}) {
  if (input.descriptor.kind !== 'map') invalid('private envelope requires map');
  const identity = { ...input.identity },
    nodePrefix = input.nodePrefix,
    initial = structuredClone(input.descriptor),
    scratch = disposableSqlite('circus-private-envelope-'),
    key = randomBytes(32),
    effects = createHash('sha256'),
    cache = new Map<string, IntakeTreeCachedNode>(),
    verifiedScratch = new Map<string, { raw: string; ref: string; signature: string }>(),
    byteValues = new WeakMap<IntakeByteValue, IntakeCollectionDescriptor>();
  let signingKey: KeyObject | undefined;
  let closed = false,
    sealed = false,
    sealing = false,
    finalizing = false,
    sealedSelection: string | undefined,
    finalized = false,
    retainedPass = 1,
    finalBuilds: IntakeTreeRoot | null = input.originalBuilds ?? null,
    expectedTotal = 0n,
    roster: PrivateEnvelopeNodeRoster | undefined;
  try {
    signingKey = createSecretKey(key);
    scratch.db.exec(
      'CREATE TABLE nodes(hash TEXT PRIMARY KEY,raw TEXT NOT NULL,ref TEXT NOT NULL,signature TEXT NOT NULL);' +
        'CREATE TABLE descriptors(name TEXT PRIMARY KEY,value TEXT NOT NULL);' +
        'CREATE TABLE retained_names(name TEXT PRIMARY KEY,pass INTEGER NOT NULL);' +
        'CREATE TABLE selected_names(name TEXT PRIMARY KEY);' +
        'CREATE TABLE reader_transitions(source TEXT,after TEXT,before TEXT,pass INTEGER,signature TEXT,PRIMARY KEY(source,after,pass));' +
        'CREATE TABLE reader_effects(source TEXT,after TEXT,kind TEXT,key TEXT,value TEXT,pass INTEGER,signature TEXT,PRIMARY KEY(source,after,kind,key,pass));' +
        'CREATE TABLE queue(hash TEXT PRIMARY KEY,ref TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0);' +
        'CREATE INDEX queue_pending ON queue(done,hash);' +
        'CREATE TABLE roster(hash TEXT PRIMARY KEY);',
    );
    scratch.db.exec('BEGIN');
    const total = scratch.db.prepare('SELECT total_changes() AS n'),
      peer = scratch.db.prepare('PRAGMA data_version'),
      schema = scratch.db.prepare('PRAGMA schema_version'),
      readNode = scratch.db.prepare('SELECT raw,ref,signature FROM nodes WHERE hash=?'),
      insertNode = scratch.db.prepare('INSERT OR IGNORE INTO nodes VALUES(?,?,?,?)'),
      readDescriptor = scratch.db.prepare('SELECT value FROM descriptors WHERE name=?'),
      writeDescriptor = scratch.db.prepare(
        'INSERT INTO descriptors VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value',
      ),
      retainName = scratch.db.prepare(
        'INSERT INTO retained_names VALUES(?,?) ON CONFLICT(name) DO UPDATE SET pass=excluded.pass',
      ),
      hasRetainedName = scratch.db.prepare('SELECT 1 FROM retained_names WHERE pass=? LIMIT 1'),
      streamRetainedNames = scratch.db.prepare(
        'SELECT name FROM retained_names WHERE pass=? ORDER BY name',
      ),
      selectName = scratch.db.prepare('INSERT OR IGNORE INTO selected_names VALUES(?)'),
      selectedNames = scratch.db.prepare('SELECT name FROM selected_names ORDER BY name'),
      writeReaderTransition = scratch.db.prepare(
        'INSERT OR IGNORE INTO reader_transitions VALUES(?,?,?,?,?)',
      ),
      readReaderTransition = scratch.db.prepare(
        'SELECT before FROM reader_transitions WHERE source=? AND after=? AND pass=?',
      ),
      readerTransitions = scratch.db.prepare(
        'SELECT source,after,before,signature FROM reader_transitions WHERE pass=? ORDER BY source,after',
      ),
      writeReaderEffect = scratch.db.prepare(
        'INSERT OR IGNORE INTO reader_effects VALUES(?,?,?,?,?,?,?)',
      ),
      readReaderEffect = scratch.db.prepare(
        'SELECT value FROM reader_effects WHERE source=? AND after=? AND kind=? AND key=? AND pass=?',
      ),
      readerEffects = scratch.db.prepare(
        'SELECT source,after,kind,key,value,signature FROM reader_effects WHERE pass=? ORDER BY source,after,kind,key',
      ),
      enqueue = scratch.db.prepare('INSERT OR IGNORE INTO queue(hash,ref) VALUES(?,?)'),
      queueReference = scratch.db.prepare('SELECT ref FROM queue WHERE hash=?'),
      queued = scratch.db.prepare('SELECT hash,ref FROM queue WHERE done=0 ORDER BY hash LIMIT 1'),
      done = scratch.db.prepare('UPDATE queue SET done=1 WHERE hash=?'),
      retain = scratch.db.prepare('INSERT INTO roster VALUES(?)'),
      retained = scratch.db.prepare(
        'SELECT nodes.hash,nodes.raw,nodes.ref,nodes.signature FROM roster JOIN nodes USING(hash) ORDER BY hash',
      );
    total.setReadBigInts(true);
    const originalPeer = peer.get()!.data_version,
      originalSchema = schema.get()!.schema_version;
    const advance = () => {
      expectedTotal = total.get()!.n as bigint;
    };
    advance();
    const checkScratch = () => {
      if (
        closed ||
        !scratch.db.isOpen ||
        !scratch.db.isTransaction ||
        total.get()!.n !== expectedTotal ||
        peer.get()!.data_version !== originalPeer ||
        schema.get()!.schema_version !== originalSchema
      )
        invalid('private envelope workspace changed');
    };
    const check = () => {
      checkScratch();
      input.assertOriginal();
      checkScratch();
    };
    const activeSigningKey = () => {
      if (closed || !signingKey) invalid('private envelope workspace changed');
      return signingKey;
    };
    const sign = (hash: string, raw: string, ref: string) =>
      createHmac('sha256', activeSigningKey()).update(hash).update(ref).update(raw).digest('hex');
    const signReader = (row: readonly unknown[]) =>
      createHmac('sha256', activeSigningKey()).update(JSON.stringify(row)).digest('hex');
    const queue = (ref: IntakeTreeRef) => {
      const raw = JSON.stringify(ref),
        prior = queueReference.get(ref.hash)?.ref;
      if (prior !== undefined && prior !== raw) invalid('private conflicting descendant');
      enqueue.run(ref.hash, raw);
    };
    const own = (hash: string) => {
      const row = readNode.get(hash);
      if (!row) return undefined;
      const prior = verifiedScratch.get(hash);
      if (
        prior &&
        prior.raw === row.raw &&
        prior.ref === row.ref &&
        prior.signature === row.signature
      ) {
        verifiedScratch.delete(hash);
        verifiedScratch.set(hash, prior);
        return prior.raw;
      }
      if (
        typeof row.raw !== 'string' ||
        typeof row.ref !== 'string' ||
        row.signature !== sign(hash, row.raw, row.ref)
      )
        invalid('private envelope node signature');
      decodeIntakeTreeNode(row.raw, JSON.parse(row.ref) as IntakeTreeRef, identity);
      verifiedScratch.delete(hash);
      verifiedScratch.set(hash, { raw: row.raw, ref: row.ref, signature: row.signature });
      if (verifiedScratch.size > 128) verifiedScratch.delete(verifiedScratch.keys().next().value!);
      return row.raw;
    };
    const read = (hash: string): unknown => own(hash) ?? input.readOriginal(hash);
    const tree = () => createIntakeTree(identity, read, cache, undefined, 'private-envelope');
    const descriptor = (name: string) =>
      parseIntakeCollectionDescriptor(
        (readDescriptor.get(name)?.value as string | undefined) ??
          input.readOriginalDescriptor?.('builds', name),
      );
    writeDescriptor.run(input.collection, JSON.stringify(initial));
    advance();
    const exposed = (raw: string): string | IntakeByteValue => {
      const value = parseIntakeStoredValue(raw);
      if (value.kind === 'inline') return value.text;
      if (value.kind !== 'bytes') invalid('private envelope cell kind');
      const handle = Object.freeze({
        kind: 'bytes',
        bytes: value.bytes,
        chunks: value.root?.count ?? 0,
      }) as IntakeByteValue;
      byteValues.set(handle, { kind: 'bytes', root: value.root, bytes: value.bytes });
      return handle;
    };
    const bytesFor = (value: IntakeByteValue) => {
      const selected = byteValues.get(value);
      if (!selected) invalid('foreign private byte value');
      return selected;
    };
    const store: EnvelopeCellReader = Object.freeze({
      check,
      get(name: string) {
        check();
        const raw = tree().get(descriptor(input.collection)!.root, name);
        check();
        return raw === undefined ? undefined : exposed(raw);
      },
      range(after: string, items: number, bytes: number, prefix?: string) {
        check();
        integer(items, 1);
        integer(bytes, 1);
        if (items > 100 || bytes > 256 * 1024) invalid('private envelope range budget');
        const result: Array<{ key: string; value: string | IntakeByteValue }> = [];
        let used = 0,
          complete = true;
        for (const row of tree().entries(descriptor(input.collection)!.root, after)) {
          if (prefix && !row.key.startsWith(prefix)) {
            if (row.key > prefix) break;
            continue;
          }
          const size = Buffer.byteLength(row.key) + Buffer.byteLength(row.value);
          if (result.length === items || used + size > bytes) {
            complete = false;
            break;
          }
          used += size;
          result.push({ key: row.key, value: exposed(row.value) });
        }
        if (!complete && !result.length) invalid('private range item budget');
        check();
        return { items: result, complete };
      },
      chunks(value: IntakeByteValue, after?: string, bytes = 4096) {
        check();
        integer(bytes, 1);
        if (bytes > 256 * 1024) invalid('private byte range budget');
        const chunks: Buffer[] = [];
        let used = 0,
          complete = true,
          last = after;
        for (const row of tree().entries(bytesFor(value).root, after)) {
          const chunk = Buffer.from(row.value, 'base64');
          if (!chunk.length || chunk.length > 4096 || chunk.toString('base64') !== row.value)
            invalid('private byte representation');
          if (chunks.length === 64 || used + chunk.length > bytes) {
            complete = false;
            break;
          }
          used += chunk.length;
          chunks.push(chunk);
          last = row.key;
        }
        if (!complete && !chunks.length) invalid('private byte item budget');
        check();
        return { chunks, complete, after: complete ? null : (last ?? null) };
      },
      byteBinding(value: IntakeByteValue) {
        check();
        return JSON.stringify(bytesFor(value));
      },
    });
    return Object.freeze({
      store,
      check,
      readNode: read,
      descriptor() {
        check();
        return structuredClone(descriptor(input.collection)!);
      },
      collection(name: string) {
        check();
        return structuredClone(descriptor(name));
      },
      get(name: string, key: string) {
        check();
        const selected = descriptor(name);
        if (!selected) return undefined;
        if (selected.kind !== 'map') invalid('private collection map kind');
        const raw = tree().get(selected.root, key);
        check();
        return raw === undefined ? undefined : exposed(raw);
      },
      range(name: string, options: { after?: string; items: number; bytes: number }) {
        check();
        integer(options.items, 1);
        integer(options.bytes, 1);
        if (options.items > 100 || options.bytes > 256 * 1024)
          invalid('private collection range budget');
        const selected = descriptor(name);
        if (selected && selected.kind !== 'map') invalid('private collection range kind');
        const items: Array<{ key: string; value: string | IntakeByteValue }> = [];
        let used = 0,
          complete = true,
          after: string | null = null;
        for (const row of tree().entries(selected?.root ?? null, options.after)) {
          const size = Buffer.byteLength(row.key) + Buffer.byteLength(row.value);
          if (items.length === options.items || used + size > options.bytes) {
            complete = false;
            break;
          }
          used += size;
          items.push({ key: row.key, value: exposed(row.value) });
          after = row.key;
        }
        if (!complete && !items.length) invalid('private range item budget');
        check();
        return { items, complete, after: complete ? null : after };
      },
      adoptEmbeddedCollection(from: string, key: string, target: string) {
        check();
        if (sealed || sealing || finalizing || finalized) invalid('private envelope change budget');
        const source = descriptor(from);
        if (!source || source.kind !== 'map') invalid('private reference map');
        const raw = tree().get(source.root, key);
        if (raw === undefined) invalid('private missing collection reference');
        const value = parseIntakeStoredValue(raw);
        if (value.kind !== 'collection') invalid('private collection reference kind');
        writeDescriptor.run(target, JSON.stringify(value.descriptor));
        effects.update(JSON.stringify(['adoptEmbeddedCollection', from, key, target, raw]));
        advance();
        check();
      },
      retainCollection(name: string) {
        check();
        if (sealed || sealing || finalizing || finalized) invalid('private envelope change budget');
        if (!descriptor(name)) invalid('private missing retained collection');
        retainName.run(name, retainedPass);
        advance();
        check();
      },
      recordReaderCoverageTransition(
        sourceId: string,
        before: string,
        after: string,
        coverageEffects: Iterable<{ kind: string; key: string; value: string }>,
      ) {
        check();
        if (sealed || sealing || finalizing || finalized || sourceId !== identity.intakeId)
          invalid('private reader transition scope');
        if (typeof before !== 'string' || typeof after !== 'string')
          invalid('private reader transition identity');
        const transition = [sourceId, after, before, retainedPass] as const;
        writeReaderTransition.run(...transition, signReader(transition));
        const existing = readReaderTransition.get(sourceId, after, retainedPass);
        if (existing?.before !== before) invalid('private reader transition ancestry');
        effects.update(JSON.stringify(['reader-transition', ...transition]));
        let inspected = 0;
        for (const effect of coverageEffects) {
          if (
            !effect ||
            !['plan', 'unit', 'proposal'].includes(effect.kind) ||
            typeof effect.key !== 'string' ||
            typeof effect.value !== 'string' ||
            Buffer.byteLength(JSON.stringify(effect)) > 8 * 1024 * 1024
          )
            invalid('private reader transition effect');
          const row = [
            sourceId,
            after,
            effect.kind,
            effect.key,
            effect.value,
            retainedPass,
          ] as const;
          writeReaderEffect.run(...row, signReader(row));
          if (
            readReaderEffect.get(sourceId, after, effect.kind, effect.key, retainedPass)?.value !==
            effect.value
          )
            invalid('private reader transition effect conflict');
          effects.update(JSON.stringify(['reader-effect', ...row]));
          if (++inspected % 64 === 0) {
            advance();
            check();
          }
        }
        advance();
        check();
      },
      *readerCoverageRows(): Generator<PrivateReaderCoverageRow> {
        checkScratch();
        for (const row of readerTransitions.iterate(retainedPass)) {
          const selected = [row.source, row.after, row.before, retainedPass];
          if (
            typeof row.source !== 'string' ||
            typeof row.after !== 'string' ||
            typeof row.before !== 'string' ||
            row.signature !== signReader(selected)
          )
            invalid('private reader transition signature');
          yield { kind: 'transition', sourceId: row.source, before: row.before, after: row.after };
          checkScratch();
        }
        for (const row of readerEffects.iterate(retainedPass)) {
          const selected = [row.source, row.after, row.kind, row.key, row.value, retainedPass];
          if (
            typeof row.source !== 'string' ||
            typeof row.after !== 'string' ||
            typeof row.kind !== 'string' ||
            typeof row.key !== 'string' ||
            typeof row.value !== 'string' ||
            row.signature !== signReader(selected)
          )
            invalid('private reader effect signature');
          yield {
            kind: 'effect',
            sourceId: row.source,
            after: row.after,
            effectKind: row.kind,
            key: row.key,
            value: row.value,
          };
          checkScratch();
        }
      },
      resetRetainedCollections() {
        check();
        if (sealed || sealing || finalizing || finalized) invalid('private envelope change budget');
        retainedPass++;
        integer(retainedPass, 1);
      },
      needsBuildsFinalization() {
        check();
        return !!hasRetainedName.get(retainedPass);
      },
      async finalizeBuilds(names: readonly string[], assertRunning?: () => void) {
        check();
        if (sealed || sealing || finalizing || finalized) invalid('private envelope change budget');
        finalizing = true;
        try {
          let selectedCount = 0;
          for (const row of streamRetainedNames.iterate(retainedPass)) {
            if (typeof row.name !== 'string') invalid('private retained name');
            selectName.run(row.name);
            advance();
            if (++selectedCount % 16 === 0) {
              await yieldHost();
              assertRunning?.();
              check();
            }
          }
          for (const name of names) selectName.run(name);
          advance();
          let root = finalBuilds,
            inspected = 0;
          for (const row of selectedNames.iterate()) {
            const name = row.name as string;
            const selected = descriptor(name);
            if (!selected) invalid('private missing final collection');
            const pages = tree();
            root = pages.put(root, name, JSON.stringify(selected));
            for (const row of pages.writes([root], embedded)) {
              const ref = JSON.stringify(row.ref),
                signature = sign(row.hash, row.raw, ref);
              if (insertNode.run(row.hash, row.raw, ref, signature).changes === 1) {
                recordIntakeWork('privateEnvelopeSpooledNodes');
                recordIntakeWork('privateEnvelopeSpooledBytes', Buffer.byteLength(row.raw));
              }
              if (own(row.hash) !== row.raw) invalid('private immutable collision');
            }
            advance();
            if (++inspected % 16 === 0) {
              await yieldHost();
              assertRunning?.();
            }
            check();
          }
          assertRunning?.();
          check();
          finalBuilds = root;
          finalized = true;
          return finalBuilds;
        } catch (error) {
          closed = true;
          verifiedScratch.clear();
          signingKey = undefined;
          key.fill(0);
          try {
            scratch.close();
          } catch {
            // Preserve the original finalization refusal.
          }
          throw error;
        } finally {
          finalizing = false;
        }
      },
      finalBuildsRoot() {
        check();
        if (!finalized) invalid('private builds are unfinished');
        return finalBuilds;
      },
      hasFinalBuilds() {
        check();
        return finalized;
      },
      apply(changes: readonly IntakeCollectionChange[]) {
        return withIntakeWork(input.db, 'warm', () => {
          check();
          if (
            sealed ||
            sealing ||
            finalizing ||
            finalized ||
            !Array.isArray(changes) ||
            changes.length > 64
          )
            invalid('private envelope change budget');
          const pages = tree(),
            changed = new Map<string, IntakeCollectionDescriptor>();
          const selected = (name: string) => changed.get(name) ?? descriptor(name);
          for (let index = 0; index < changes.length; index++) {
            const change = changes[index]!;
            if (change.area !== 'builds' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(change.collection))
              invalid('private envelope change scope');
            let current = selected(change.collection) ?? {
              kind: 'map' as const,
              root: null,
              bytes: 0,
            };
            if (change.op === 'put') {
              if (current.kind !== 'map') invalid('private map kind');
              const entries: Array<{ key: string; value: string }> = [];
              const encode = (key: string, text: string) => {
                intakeTreeKey(key);
                if (typeof text !== 'string') invalid('private inline text');
                const raw = JSON.stringify({ kind: 'inline', text });
                if (Buffer.byteLength(raw) > INTAKE_TREE_VALUE_BYTES)
                  invalid('private inline budget');
                entries.push({ key, value: raw });
              };
              encode(change.key, change.value);
              while (index + 1 < changes.length) {
                const next = changes[index + 1]!;
                if (
                  next.op !== 'put' ||
                  next.collection !== change.collection ||
                  next.area !== 'builds'
                )
                  break;
                encode(next.key, next.value);
                index++;
              }
              const batch = pages.putMany(current.root, entries);
              let size = current.bytes;
              for (const [name, raw] of new Map(entries.map((row) => [row.key, row.value])))
                size += valueBytes(raw) - valueBytes(batch.previous.get(name));
              current = { kind: 'map', root: batch.root, bytes: size };
            } else if (
              change.op === 'delete' ||
              change.op === 'putBytes' ||
              change.op === 'putCollection'
            ) {
              if (current.kind !== 'map') invalid('private map kind');
              const prior = pages.get(current.root, change.key);
              let raw: string | null = null;
              if (change.op === 'putBytes' || change.op === 'putCollection') {
                if (change.fromArea !== 'builds' && change.fromArea !== 'logical')
                  invalid('private reference source area');
                const source =
                  change.fromArea === 'builds'
                    ? selected(change.fromCollection)
                    : parseIntakeCollectionDescriptor(
                        input.readOriginalDescriptor?.('logical', change.fromCollection),
                      );
                if (!source || (change.op === 'putBytes' && source.kind !== 'bytes'))
                  invalid('private reference source');
                raw =
                  change.op === 'putBytes'
                    ? JSON.stringify({ kind: 'bytes', root: source.root, bytes: source.bytes })
                    : JSON.stringify({ kind: 'collection', descriptor: source });
              }
              current = {
                kind: 'map',
                root: pages.put(current.root, change.key, raw),
                bytes: current.bytes + valueBytes(raw ?? undefined) - valueBytes(prior),
              };
            } else if (change.op === 'appendBytes') {
              if (
                (selected(change.collection) && current.kind !== 'bytes') ||
                !(change.bytes instanceof Uint8Array) ||
                !change.bytes.length ||
                change.bytes.length > 4096
              )
                invalid('private byte append');
              const chunk = Buffer.from(change.bytes);
              current = {
                kind: 'bytes',
                root: pages.put(
                  current.root,
                  ordered(current.root?.count ?? 0),
                  chunk.toString('base64'),
                ),
                bytes: current.bytes + chunk.length,
              };
            } else if (change.op === 'adoptCollection') {
              if (change.fromArea !== 'builds' && change.fromArea !== 'logical')
                invalid('private adoption area');
              const source =
                change.fromArea === 'builds'
                  ? selected(change.fromCollection)
                  : parseIntakeCollectionDescriptor(
                      input.readOriginalDescriptor?.('logical', change.fromCollection),
                    );
              if (!source) invalid('private missing adopted collection');
              current = source;
            } else invalid('private envelope operation');
            integer(current.bytes);
            changed.set(change.collection, current);
          }
          for (const row of pages.writes(
            [...changed.values()].map((value) => value.root),
            embedded,
          )) {
            const ref = JSON.stringify(row.ref),
              signature = sign(row.hash, row.raw, ref);
            if (insertNode.run(row.hash, row.raw, ref, signature).changes === 1) {
              recordIntakeWork('privateEnvelopeSpooledNodes');
              recordIntakeWork('privateEnvelopeSpooledBytes', Buffer.byteLength(row.raw));
            }
            if (own(row.hash) !== row.raw) invalid('private immutable collision');
          }
          for (const [name, value] of changed) writeDescriptor.run(name, JSON.stringify(value));
          for (const change of changes)
            effects.update(
              JSON.stringify(change, (_name, value: unknown) =>
                value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value,
              ),
            );
          advance();
          check();
        });
      },
      async seal(assertRunning?: () => void): Promise<PrivateEnvelopeNodeRoster> {
        return withIntakeWork(input.db, 'warm', async () => {
          check();
          if (sealing || finalizing) invalid('private envelope sealing already started');
          sealing = true;
          try {
            const checkpoint = () => {
              const result: unknown = assertRunning?.();
              if (
                result &&
                (typeof result === 'object' || typeof result === 'function') &&
                'then' in result
              )
                invalid('private envelope guard must finish synchronously');
              check();
            };
            checkpoint();
            const final = descriptor(input.collection)!;
            const selection = JSON.stringify([final, finalized ? finalBuilds : null]);
            if (sealed) {
              if (selection !== sealedSelection) invalid('private sealed selection changed');
              return roster!;
            }
            if (finalized && finalBuilds) queue(finalBuilds);
            if (final.root) queue(final.root);
            advance();
            let count = 0,
              bytes = 0,
              work = 0,
              workBytes = 0;
            for (;;) {
              check();
              const row = queued.get();
              if (!row) break;
              const ref = JSON.parse(row.ref as string) as IntakeTreeRef,
                original = input.readOriginal(ref.hash),
                raw = own(ref.hash);
              if (original !== undefined) {
                decodeIntakeTreeNode(original, ref, identity);
                if (raw !== undefined && original !== raw) invalid('private original collision');
              } else {
                if (raw === undefined) invalid('private missing descendant');
                const node = decodeIntakeTreeNode(raw, ref, identity);
                for (const child of [node.left, node.right, ...embedded(node.value)])
                  if (child) queue(child);
                retain.run(ref.hash);
                count++;
                bytes += Buffer.byteLength(raw);
                integer(count);
                integer(bytes);
                workBytes += Buffer.byteLength(raw);
              }
              done.run(ref.hash);
              advance();
              if (++work === 64 || workBytes >= 64 * 1024) {
                await yieldHost();
                checkpoint();
                work = 0;
                workBytes = 0;
              }
            }
            const rows = function* () {
              check();
              let seen = 0,
                size = 0;
              for (const row of retained.iterate()) {
                check();
                const raw = row.raw as string,
                  ref = JSON.parse(row.ref as string) as IntakeTreeRef;
                if (row.signature !== sign(row.hash as string, raw, row.ref as string))
                  invalid('private roster signature');
                decodeIntakeTreeNode(raw, ref, identity);
                seen++;
                size += Buffer.byteLength(raw);
                yield { hash: row.hash as string, raw, ref };
              }
              if (seen !== count || size !== bytes) invalid('private roster count');
              check();
            };
            const digest = createHash('sha256');
            work = 0;
            workBytes = 0;
            for (const row of rows()) {
              digest.update(row.hash).update(row.raw);
              workBytes += Buffer.byteLength(row.raw);
              if (++work === 64 || workBytes >= 64 * 1024) {
                await yieldHost();
                checkpoint();
                work = 0;
                workBytes = 0;
              }
            }
            checkpoint();
            sealed = true;
            sealedSelection = selection;
            withIntakeWork(input.db, 'warm', () => {
              recordIntakeWork('privateEnvelopeReachableNodes', count);
              recordIntakeWork('privateEnvelopeReachableBytes', bytes);
            });
            roster = Object.freeze({
              count,
              bytes,
              digest: digest.digest('hex'),
              effects: effects.digest('hex'),
              descriptor: Object.freeze({
                ...final,
                root: final.root ? Object.freeze({ ...final.root }) : null,
              }),
              nodePrefix,
              check,
              rows,
              *parts() {
                let part: Array<{ hash: string; raw: string }> = [],
                  partBytes = 0;
                for (const row of rows()) {
                  const size =
                    Buffer.byteLength(nodePrefix + row.hash) + Buffer.byteLength(row.raw);
                  if (part.length && (part.length === 4096 || partBytes + size > 8 * 1024 * 1024)) {
                    yield part;
                    part = [];
                    partBytes = 0;
                  }
                  part.push({ hash: row.hash, raw: row.raw });
                  partBytes += size;
                }
                if (part.length) yield part;
              },
            });
            return roster;
          } catch (error) {
            closed = true;
            verifiedScratch.clear();
            signingKey = undefined;
            key.fill(0);
            try {
              scratch.close();
            } catch {
              // Keep the original seal failure after revocation.
            }
            throw error;
          } finally {
            sealing = false;
          }
        });
      },
      close() {
        if (closed) return;
        closed = true;
        cache.clear();
        verifiedScratch.clear();
        signingKey = undefined;
        key.fill(0);
        scratch.close();
      },
    });
  } catch (error) {
    closed = true;
    verifiedScratch.clear();
    signingKey = undefined;
    key.fill(0);
    try {
      scratch.close();
    } catch {
      // Keep the original construction failure after revocation.
    }
    throw error;
  }
}

export type PrivateEnvelopeCandidate = ReturnType<typeof createPrivateEnvelopeCandidate>;
